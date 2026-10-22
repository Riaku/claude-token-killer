import { expect, test, tier } from 'claude-code/testing'

tier('user')

import { DEFAULT_LS_CAPS, compressLs, planLs } from '../hooks/ls.ts'

// ------------------------------------------------------------- planner

test('ls and its common flag bundles plan an ls trim', () => {
  for (const cmd of [
    'ls',
    'ls -l',
    'ls -la',
    'ls -al',
    'ls -lh',
    'ls -alh src',
    'ls -l src/hooks',
    'ls -R .',
    'ls --all --human-readable',
    'ls -l src tests',
    '/bin/ls -l',
  ]) {
    const p = planLs(cmd)
    expect(p).not.toBeNull()
    expect(p!.kind).toBe('ls')
    // Compression-only: the command is never rewritten.
    expect(p!.command).toBe(cmd)
  }
})

test('compound commands, redirects, substitutions and comments bail out', () => {
  for (const cmd of [
    'ls -l | wc -l',
    'ls -l && rm -rf src',
    'ls -l || true',
    'ls -l; pwd',
    'ls -l > out.txt',
    'ls -l 2> err.txt',
    'ls -l $(pwd)',
    'ls -l ${HOME}',
    'ls -l `pwd`',
    'ls -l # tk:raw',
    'ls "unbalanced',
    'ls -l\nls -a',
  ]) {
    expect(planLs(cmd)).toBeNull()
  }
})

test('help and version bail out', () => {
  expect(planLs('ls --help')).toBeNull()
  expect(planLs('ls -h')).toBeNull()
  expect(planLs('ls --version')).toBeNull()
})

test('flags that change the column layout bail out', () => {
  // -g/-o drop the owner/group column, --full-time and --time-style change
  // the date columns, -w takes a width: none of them is parsed safely.
  for (const cmd of ['ls -g', 'ls -o', 'ls -lw 40', 'ls --full-time', 'ls --time-style=long-iso', 'ls -ln']) {
    expect(planLs(cmd)).toBeNull()
  }
})

test('non-ls commands are not planned', () => {
  expect(planLs('grep -r foo .')).toBeNull()
  expect(planLs('lsfix')).toBeNull()
  expect(planLs('')).toBeNull()
  expect(planLs('   ')).toBeNull()
})

// ---------------------------------------------------------- compressor

// Real `ls -l` output, captured on this machine (fixed mtimes, user hermes).
const LS_LONG = [
  'total 24',
  '-rw-r--r-- 1 hermes hermes    6 Oct 22 02:57 a.txt',
  '-rw-r--r-- 1 hermes hermes   11 Oct 22 02:57 b with spaces.txt',
  '-rw-r--r-- 1 hermes hermes 5000 Oct 22 02:57 big.bin',
  'lrwxrwxrwx 1 hermes hermes   28 Oct 22 02:57 ext-link -> /usr/local/share/some/target',
  'lrwxrwxrwx 1 hermes hermes    5 Oct 22 02:57 link.txt -> a.txt',
  'drwxr-sr-x 2 hermes hermes 4096 Oct 22 02:57 sub1',
  'drwxr-sr-x 3 hermes hermes 4096 Oct 22 02:57 sub2',
  '',
].join('\n')

test('long listing becomes name, name (size), name/ and name -> target', () => {
  expect(compressLs(LS_LONG)).toBe(
    [
      'a.txt (6)',
      'b with spaces.txt (11)',
      'big.bin (5000)',
      'ext-link -> /usr/local/share/some/target',
      'link.txt -> a.txt',
      'sub1/',
      'sub2/',
    ].join('\n'),
  )
})

test('a name containing spaces survives (the name is everything after field 8)', () => {
  expect(compressLs(LS_LONG)).toContain('b with spaces.txt (11)')
})

test('total line is dropped and -la dot entries are skipped', () => {
  const raw = [
    'total 36',
    'drwxr-sr-x  4 hermes hermes 4096 Oct 22 02:57 .',
    'drwxr-sr-x 10 hermes hermes 4096 Oct 22 02:57 ..',
    '-rw-r--r--  1 hermes hermes    2 Oct 22 02:57 .hidden',
    'drwxr-sr-x  2 hermes hermes 4096 Oct 22 02:57 sub1',
    '',
  ].join('\n')
  expect(compressLs(raw)).toBe('.hidden (2)\nsub1/')
})

test('human-readable sizes are echoed as-is', () => {
  const raw = [
    'total 24K',
    '-rw-r--r-- 1 hermes hermes 4.9K Oct 22 02:57 big.bin',
    'drwxr-sr-x 2 hermes hermes 4.0K Oct 22 02:57 sub1',
    '',
  ].join('\n')
  expect(compressLs(raw)).toBe('big.bin (4.9K)\nsub1/')
})

test('multi-path ls keeps its per-directory grouping and counts', () => {
  const raw = [
    'lsfix/sub1:',
    'total 8',
    '-rw-r--r-- 1 hermes hermes 4 Oct 22 02:57 one.ts',
    '-rw-r--r-- 1 hermes hermes 4 Oct 22 02:57 two.ts',
    '',
    'lsfix/sub2:',
    'total 8',
    'drwxr-sr-x 2 hermes hermes 4096 Oct 22 02:57 nested',
    '-rw-r--r-- 1 hermes hermes    6 Oct 22 02:57 three.md',
    '',
  ].join('\n')
  expect(compressLs(raw)).toBe(
    [
      'lsfix/sub1 (2 entries):',
      '  one.ts (4)',
      '  two.ts (4)',
      'lsfix/sub2 (2 entries):',
      '  nested/',
      '  three.md (6)',
    ].join('\n'),
  )
})

test('cap truncates and names the exact re-run tagged # tk:raw', () => {
  const rows = ['total 40']
  for (let i = 0; i < 9; i += 1) rows.push(`-rw-r--r-- 1 u g ${100 + i} Oct 22 02:57 file-${i}.log`)
  const out = compressLs(rows.join('\n') + '\n', { maxEntries: 3 }, 'ls -l logs')
  const lines = out.split('\n')
  expect(lines.length).toBe(4)
  expect(lines[3]).toBe('... +6 more entries (raw: ls -l logs # tk:raw)')
})

test('cap without a command still emits a # tk:raw hint', () => {
  const rows = ['total 40']
  for (let i = 0; i < 5; i += 1) rows.push(`-rw-r--r-- 1 u g ${100 + i} Oct 22 02:57 f-${i}.log`)
  const out = compressLs(rows.join('\n') + '\n', { maxEntries: 1 })
  expect(out).toContain('... +4 more entries (raw: re-run with # tk:raw)')
})

test('default cap is 200 entries', () => {
  expect(DEFAULT_LS_CAPS.maxEntries).toBe(200)
})

test('bare column-format ls output is returned unchanged', () => {
  const bare = 'a.txt  b with spaces.txt  big.bin  link.txt  sub1  sub2\n'
  expect(compressLs(bare)).toBe(bare)
  const onePerLine = 'a.txt\nb with spaces.txt\nsub1\n'
  expect(compressLs(onePerLine)).toBe(onePerLine)
})

test('unparseable long formats are returned unchanged whole (no half-compression)', () => {
  // --time-style=long-iso: the date columns are not the month/day/time shape.
  const iso = ['-rw-r--r-- 1 hermes hermes 6 2026-10-22 02:57 a.txt', '-rw-r--r-- 1 hermes hermes 6 2026-10-22 02:57 b.txt'].join(
    '\n',
  )
  expect(compressLs(iso)).toBe(iso)
  // Device nodes put "8," where a size is expected.
  const dev = ['crw-rw-rw- 1 root root 1, 3 Oct 22 02:57 null', '-rw-r--r-- 1 root root 6 Oct 22 02:57 a.txt'].join('\n')
  expect(compressLs(dev)).toBe(dev)
})

test('never inflates: long output is shorter, small or empty input is left alone', () => {
  expect(compressLs(LS_LONG).length).toBeLessThan(LS_LONG.length)
  for (const raw of ['', '   ', 'just a header\n']) {
    expect(compressLs(raw)).toBe(raw)
  }
  // A one-row listing cannot be made longer than it is: no header, no elision.
  const one = '-rw-r--r-- 1 u g 6 Oct 22 02:57 a\n'
  expect(compressLs(one)).toBe('a (6)')
})
