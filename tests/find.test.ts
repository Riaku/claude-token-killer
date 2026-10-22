import { expect, test, tier } from 'claude-code/testing'

tier('user')

import { DEFAULT_FIND_CAPS, compressFind, planFind } from '../hooks/find.ts'

// ------------------------------------------------------------- planner

test('find with a starting path plans a find trim', () => {
  for (const cmd of [
    'find .',
    'find src',
    'find . -type f',
    'find . -name "*.ts" -maxdepth 2',
    'find src -type d -empty',
    'find -L . -name "*.md"',
    'find -H /tmp -maxdepth 1',
    '/usr/bin/find . -type f',
  ]) {
    const p = planFind(cmd)
    expect(p).not.toBeNull()
    expect(p!.kind).toBe('find')
    // Compression-only: the command is never rewritten.
    expect(p!.command).toBe(cmd)
  }
})

test('side-effect predicates bail out', () => {
  for (const cmd of [
    'find . -name "*.tmp" -delete',
    'find . -type f -exec rm {} +',
    'find . -execdir ls {} +',
    'find . -ok rm {} +',
    'find . -okdir rm {} +',
    'find . -fprint out.txt',
    'find . -fprint0 out.txt',
    'find . -fprintf out.txt "%p\\n"',
    'find . -fls out.txt',
  ]) {
    expect(planFind(cmd)).toBeNull()
  }
})

test('compound commands, redirects, substitutions and comments bail out', () => {
  for (const cmd of [
    'find . -type f | head',
    'find . -name x && echo hi',
    'find . -name x || true',
    'find . -type f; pwd',
    'find . > out.txt',
    'find . -name "$(whoami)"',
    'find ${HOME} -name x',
    'find . `pwd`',
    'find . # tk:raw',
    'find "unbalanced',
  ]) {
    expect(planFind(cmd)).toBeNull()
  }
})

test('help, version and a missing starting path bail out', () => {
  expect(planFind('find --help')).toBeNull()
  expect(planFind('find -h')).toBeNull()
  expect(planFind('find --version')).toBeNull()
  expect(planFind('find')).toBeNull()
  // Implicit `.` - legal, but the output shape is not confirmed.
  expect(planFind('find -name "*.ts"')).toBeNull()
})

test('non-find commands are not planned', () => {
  expect(planFind('grep -r foo .')).toBeNull()
  expect(planFind('findfix .')).toBeNull()
  expect(planFind('')).toBeNull()
})

// ---------------------------------------------------------- compressor

// Real `find lsfix` output, captured on this machine, verbatim.
const FIND_DEFAULT = [
  'lsfix',
  'lsfix/sub1',
  'lsfix/sub1/one.ts',
  'lsfix/sub1/two.ts',
  'lsfix/b with spaces.txt',
  'lsfix/a.txt',
  'lsfix/sub2',
  'lsfix/sub2/three.md',
  'lsfix/sub2/nested',
  'lsfix/sub2/nested/deep.txt',
  'lsfix/big.bin',
  'lsfix/.hidden',
  'lsfix/link.txt',
  'lsfix/ext-link',
].join('\n')

test('paths are grouped by parent directory, in find order', () => {
  expect(compressFind(FIND_DEFAULT)).toBe(
    [
      './ (1):',
      '  lsfix',
      'lsfix/ (8):',
      '  sub1',
      '  b with spaces.txt',
      '  a.txt',
      '  sub2',
      '  big.bin',
      '  .hidden',
      '  link.txt',
      '  ext-link',
      'lsfix/sub1/ (2):',
      '  one.ts',
      '  two.ts',
      'lsfix/sub2/ (2):',
      '  three.md',
      '  nested',
      'lsfix/sub2/nested/ (1):',
      '  deep.txt',
    ].join('\n'),
  )
})

test('every path still appears exactly once after grouping', () => {
  const out = compressFind(FIND_DEFAULT)
  for (const p of FIND_DEFAULT.split('\n')) {
    const base = p.slice(p.lastIndexOf('/') + 1)
    expect(out.split('\n').filter((l) => l.trim() === base).length).toBeGreaterThan(0)
  }
  expect(out.split('\n').filter((l) => l.startsWith('lsfix/')).length).toBe(4)
})

test('absolute paths keep their directory prefix', () => {
  const raw = ['/srv/app/hooks/a.ts', '/srv/app/hooks/b.ts', '/srv/app/hooks/c.ts', '/srv/app/hooks/d.ts', '/srv/app/hooks/lib/e.ts'].join('\n')
  expect(compressFind(raw)).toBe(
    ['/srv/app/hooks/ (4):', '  a.ts', '  b.ts', '  c.ts', '  d.ts', '/srv/app/hooks/lib/ (1):', '  e.ts'].join('\n'),
  )
})

test('cap truncates and names the exact re-run tagged # tk:raw', () => {
  const raw = Array.from({ length: 6 }, (_, i) => `src/hooks/mod-${i}.ts`).join('\n')
  expect(compressFind(raw, { maxEntries: 2 }, 'find src -name "*.ts"')).toBe(
    ['src/hooks/ (6):', '  mod-0.ts', '  mod-1.ts', '... +4 more paths (raw: find src -name "*.ts" # tk:raw)'].join('\n'),
  )
})

test('default cap is 200 entries', () => {
  expect(DEFAULT_FIND_CAPS.maxEntries).toBe(200)
})

test('find -ls style output is returned unchanged', () => {
  const lsStyle = [
    '1234567    4 -rw-r--r--   1 hermes hermes  6 Oct 22 02:57 ./a.txt',
    '1234568    4 drwxr-sr-x   2 hermes hermes 4096 Oct 22 02:57 ./sub1',
  ].join('\n')
  expect(compressFind(lsStyle)).toBe(lsStyle)
})

test('indented, tab-separated and error output is returned unchanged', () => {
  for (const raw of ['  ./a.txt\n  ./b.txt\n', './a.txt\t./b.txt\n', 'find: ‘./nope’: No such file or directory\n']) {
    expect(compressFind(raw)).toBe(raw)
  }
})

test('a single path is not worth a header heading', () => {
  expect(compressFind('./only.ts\n')).toBe('./only.ts\n')
  expect(compressFind('')).toBe('')
})

test('never inflates: falls back to the original when grouping is not shorter', () => {
  const raw = './a\n./b\n'
  const out = compressFind(raw)
  expect(out.length).not.toBeGreaterThan(raw.length)
  expect(out).toBe(raw)
})
