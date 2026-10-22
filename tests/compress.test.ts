import { describe, expect, test } from 'claude-code/testing'
import { DEFAULT_CAPS, compressGitDiff, compressGitStatus, compressGrep } from '../hooks/compress.ts'

describe('compressGitDiff', () => {
  test('a warning above the first block survives', () => {
    // `git diff` run through the hook has stderr merged in, so its warnings are
    // on this stream. Dropping them made a broken invocation look complete.
    const raw = [
      'warning: LF will be replaced by CRLF in a.txt.',
      'The file will have its original line endings in your working directory',
      'diff --git a/a.txt b/a.txt',
      'index 1111111..2222222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n')
    const out = compressGitDiff(raw)
    expect(out.startsWith('warning: LF will be replaced by CRLF in a.txt.')).toBe(true)
    expect(out).toContain('1 file changed, +1 -1')
    expect(out.length).toBeLessThan(raw.length)
  })

  test('a hunk kept in full does not end in an elision marker', () => {
    // The trailing newline leaves an empty element in the block; it used to be
    // counted as dropped context, so every complete hunk ended in `...`.
    const raw = [
      'diff --git a/a.txt b/a.txt',
      'index 1111111..2222222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      ' ctx',
      '-old',
      '+new',
      '',
    ].join('\n')
    expect(compressGitDiff(raw).trimEnd().endsWith('...')).toBe(false)
  })
})

describe('compressGitStatus', () => {
  // `-b` prints the branch header on every run, so no lines means the command
  // produced nothing. Inventing a sentence would exceed the input and the
  // caller's length check would discard it.
  test('empty porcelain is passed through untouched', () => {
    expect(compressGitStatus('')).toBe('')
    expect(compressGitStatus('\n\n')).toBe('\n\n')
  })

  test('branch header becomes * branch', () => {
    const out = compressGitStatus('## main...origin/main [ahead 2, behind 1]\n M a.txt\n')
    expect(out).toContain('* main...origin/main [ahead 2, behind 1]')
    expect(out).toContain(' M a.txt')
    expect(out).not.toContain('## ')
  })

  test('untracked files are capped with an elision line', () => {
    const many = Array.from({ length: 250 }, (_, i) => `?? f${i}.txt`).join('\n')
    const out = compressGitStatus(`## main\n${many}\n`, DEFAULT_CAPS)
    expect(out).toContain('f0.txt')
    expect(out).toContain('... +50 more untracked')
    expect(out).not.toContain('f249.txt')
  })

  test('staged, renamed and ignored lines pass through', () => {
    const out = compressGitStatus('## main\nM  staged.txt\nR  old.txt -> new.txt\n!! ignored.log\n')
    expect(out).toContain('M  staged.txt')
    expect(out).toContain('R  old.txt -> new.txt')
    expect(out).toContain('!! ignored.log')
  })
})

describe('compressGitDiff', () => {
  const DIFF = [
    'diff --git a/a.txt b/a.txt',
    'index 1111111..2222222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,7 +1,7 @@',
    ' c1',
    ' c2',
    ' c3',
    '-old',
    '+new',
    ' c4',
    ' c5',
    ' c6',
    'diff --git a/b.txt b/b.txt',
    'index 3333333..4444444 100644',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1 +1,2 @@',
    ' only',
    '+added',
  ].join('\n')

  test('non-diff input passes through', () => {
    expect(compressGitDiff('hello world')).toBe('hello world')
  })

  test('header counts every changed line across files', () => {
    const out = compressGitDiff(DIFF)
    expect(out.startsWith('2 files changed, +2 -1')).toBe(true)
  })

  test('per-file summary replaces the index/---/+++ metadata', () => {
    const out = compressGitDiff(DIFF)
    expect(out).toContain('a.txt  +1 -1')
    expect(out).toContain('b.txt  +1 -0')
    expect(out).not.toContain('index 1111111')
    expect(out).not.toContain('+++ a/a.txt')
  })

  test('long context runs collapse to one marker', () => {
    const out = compressGitDiff(DIFF)
    // c1,c2,c3 before the change collapse to one line + marker
    expect(out).toContain('...')
    const aBlock = out.split('b.txt')[0]
    expect(aBlock.split('\n').filter((l) => l.startsWith(' c')).length).toBeLessThanOrEqual(2)
  })

  test('hunk headers survive so line ranges stay readable', () => {
    const out = compressGitDiff(DIFF)
    expect(out).toContain('@@ -1,7 +1,7 @@')
  })

  test('renames show old -> new', () => {
    const out = compressGitDiff('diff --git a/old.txt b/new.txt\nnew file mode 100644\n@@ -0,0 +1 @@\n+hi\n')
    expect(out).toContain('old.txt -> new.txt')
  })

  test('hunk headers always survive context collapse', () => {
    // A long context-only run far from any change must not eat the @@ anchor.
    const long = [
      '@@ -1,200 +1,200 @@',
      ...Array.from({ length: 100 }, (_, i) => ` ctx ${i}`),
      '-gone',
      '+here',
    ].join('\n')
    const out = compressGitDiff(`diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n${long}`, DEFAULT_CAPS)
    expect(out).toContain('@@ -1,200 +1,200 @@')
    expect(out).toContain('-gone')
    expect(out).toContain('+here')
  })

  test('binary files get a one-line note', () => {
    const out = compressGitDiff('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n')
    expect(out).toContain('x.png  (binary)')
  })

  test('per-file cap elides with a recovery command', () => {
    const hunk = Array.from({ length: 200 }, (_, i) => (i % 20 === 0 ? `+changed${i}` : ` context${i}`)).join('\n')
    const big = `diff --git a/big.txt b/big.txt\n@@ -1,200 +1,200 @@\n${hunk}\n`
    const out = compressGitDiff(big, { ...DEFAULT_CAPS, maxDiffLinesPerFile: 10 })
    expect(out).toContain('lines elided - raw: git diff -- big.txt # tk:raw')
  })

  test('total cap summarizes the remaining files', () => {
    const one = (n: number): string =>
      `diff --git a/f${n}.txt b/f${n}.txt\n@@ -1 +1 @@\n-old${n}\n+new${n}\n`
    const big = [one(1), one(2), one(3)].join('')
    const out = compressGitDiff(big, { ...DEFAULT_CAPS, maxDiffTotalLines: 4 })
    expect(out).toContain('more file')
    expect(out).toContain('elided (+')
  })
})

describe('compressGrep', () => {
  test('non match-shaped input passes through', () => {
    expect(compressGrep('grep: foo: Is a directory')).toBe('grep: foo: Is a directory')
  })

  test('matches group by file with counts', () => {
    // Paths repeat on every raw line, so grouping pays off once a file has a
    // few hits - which is what a real recursive grep looks like.
    const hits = (file: string) =>
      Array.from({ length: 6 }, (_, i) => `${file}:${i + 1}:const valueNumber${i} = computeSomething(input${i})`).join('\n')
    const out = compressGrep(`${hits('hooks/ghrunview.ts')}\n${hits('hooks/kubectllogs.ts')}\n`)
    expect(out).toContain('12 matches in 2 files')
    expect(out).toContain('hooks/ghrunview.ts (6):')
    expect(out).toContain('1: const valueNumber0 = computeSomething(input0)')
    expect(out).toContain('hooks/kubectllogs.ts (6):')
  })

  test('a result that would grow is left alone', () => {
    // Two short hits cost more as a grouped listing than as raw grep output.
    const raw = 'a.ts:1:foo\na.ts:2:bar\n'
    expect(compressGrep(raw, undefined, 'grep -rn foo .')).toBe(raw)
  })

  test('elision hints quote the command that ran', () => {
    const many = Array.from({ length: 40 }, (_, i) => `x.ts:${i}:hit ${i}`).join('\n')
    const out = compressGrep(many, { ...DEFAULT_CAPS, maxGrepPerFile: 3 }, 'rg -n foo hooks/')
    expect(out).toContain('(raw: rg -n foo hooks/ # tk:raw)')
  })

  test('per-file cap elides extra matches', () => {
    const many = Array.from({ length: 20 }, (_, i) => `x.ts:${i}:hit ${i}`).join('\n')
    const out = compressGrep(many, { ...DEFAULT_CAPS, maxGrepPerFile: 3 })
    expect(out).toContain('x.ts (20):')
    expect(out).toContain('... +17 more in x.ts')
  })

  test('long lines truncate with a marker', () => {
    const long = 'y.ts:1:' + 'z'.repeat(500)
    const out = compressGrep(long, { ...DEFAULT_CAPS, maxLineLen: 50 })
    const line = out.split('\n').find((l) => l.startsWith('1: '))
    expect(line !== undefined && line.length <= 54).toBe(true)
  })

  test('grep warnings are kept verbatim at the end', () => {
    const out = compressGrep('a.ts:1:hit\ngrep: nope: Permission denied\n')
    expect(out).toContain('grep: nope: Permission denied')
  })

  test('a per-file elision is reported once, not again in the total', () => {
    // Long hits, so the grouped form is the shorter of the two and the markers
    // are actually in the returned text.
    const many = Array.from({ length: 5 }, (_, i) => `a.ts:${i}:${'x'.repeat(80)}`).join('\n')
    const out = compressGrep(many, { ...DEFAULT_CAPS, maxGrepTotal: 10, maxGrepPerFile: 2 })
    expect(out).toContain('+3 more in a.ts')
    expect(out).not.toContain('matches elided')
  })

  test('total cap reports elided matches', () => {
    const many = Array.from({ length: 50 }, (_, i) => `f${i % 10}.ts:${i}:hit`).join('\n')
    const out = compressGrep(many, { ...DEFAULT_CAPS, maxGrepTotal: 5, maxGrepPerFile: 1 })
    expect(out).toContain('50 matches in 10 files')
    expect(out).toContain('matches elided')
  })
})
