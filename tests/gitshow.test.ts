import { expect, test, tier } from 'claude-code/testing'

tier('user')

import { DEFAULT_SHOW_CAPS, compressGitShow, planGitShow } from '../hooks/gitshow.ts'

// ------------------------------------------------------------- planner

test('git show plans a --no-color rewrite with kind git-show', () => {
  const p = planGitShow('git show HEAD')
  expect(p).not.toBeNull()
  expect(p!.kind).toBe('git-show')
  // Same rewrite plan.ts applies to `git diff`: force plain text so the
  // compressor never has to guess at escape codes.
  expect(p!.command).toBe('git show HEAD --no-color')
  expect(planGitShow('git show')!.command).toBe('git show --no-color')
})

test('an existing color flag is never doubled', () => {
  expect(planGitShow('git show --no-color HEAD')!.command).toBe('git show --no-color HEAD')
  expect(planGitShow('git show --color=never HEAD')!.command).toBe('git show --color=never HEAD')
})

test('global git options before the subcommand are preserved', () => {
  expect(planGitShow('git -C /repo show HEAD')!.command).toBe('git -C /repo show HEAD --no-color')
  expect(planGitShow('git --no-pager show 8be64fa')!.command).toBe('git --no-pager show 8be64fa --no-color')
  expect(planGitShow('git --git-dir=/repo/.git show HEAD')!.command).toBe(
    'git --git-dir=/repo/.git show HEAD --no-color',
  )
})

test('user-chosen formats and shape-changing flags bail out', () => {
  for (const cmd of [
    'git show --pretty=fuller HEAD',
    'git show --pretty HEAD',
    'git show --format=%H HEAD',
    'git show --format HEAD',
    'git show --stat HEAD',
    'git show --numstat HEAD',
    'git show --shortstat HEAD',
    'git show --name-only HEAD',
    'git show --name-status HEAD',
    'git show --oneline HEAD',
    'git show --raw HEAD',
    'git show --summary HEAD',
    'git show --cc HEAD',
    'git show --notes HEAD',
    'git show --help',
    'git show -h',
    'git show --version',
  ]) {
    expect(planGitShow(cmd)).toBeNull()
  }
})

test('compound commands, redirects, substitutions and comments bail out', () => {
  for (const cmd of [
    'git show HEAD | head -50',
    'git show HEAD && echo ok',
    'git show HEAD || true',
    'git show HEAD; echo ok',
    'git show HEAD > out.txt',
    'git show HEAD < in.txt',
    'git show $(git rev-parse HEAD)',
    'git show ${REV}',
    'git show `git rev-parse HEAD`',
    'git show HEAD\n git status',
    'git show HEAD # tk:raw',
    "git show 'HEAD",
  ]) {
    expect(planGitShow(cmd)).toBeNull()
  }
})

test('non-show commands are not planned', () => {
  expect(planGitShow('git status')).toBeNull()
  expect(planGitShow('git log')).toBeNull()
  expect(planGitShow('git showx HEAD')).toBeNull()
  expect(planGitShow('gitshow HEAD')).toBeNull()
  expect(planGitShow('')).toBeNull()
})

// ---------------------------------------------------------- compressor

// Real `git show` from /opt/data/cache/scratch/tk-git-fixtures (5 commits,
// 60-line new file, one empty commit) and /opt/data/cache/scratch/tk-merge-fixture
// (a real --no-ff merge), captured verbatim with GIT_PAGER=cat.
// The lengths are asserted so a mis-transcribed fixture fails loudly.

// 892 chars: a 60-line new file - the long diff the compressor must earn on.
const SHOW_BIG = [
  'commit ed4f4b0c36c258755793c43ead958b641e07b777',
  'Author: Ada Lovelace <ada@example.com>',
  'Date:   Wed Mar 4 16:45:00 2026 +0000',
  '',
  '    Add big.txt fixture',
  '    ',
  '    A sixty-line file so the diff body is long enough that compression actually wins.',
  '',
  'diff --git a/big.txt b/big.txt',
  'new file mode 100644',
  'index 0000000..8b2034d',
  '--- /dev/null',
  '+++ b/big.txt',
  '@@ -0,0 +1,60 @@',
  '+line 1',
  '+line 2',
  '+line 3',
  '+line 4',
  '+line 5',
  '+line 6',
  '+line 7',
  '+line 8',
  '+line 9',
  '+line 10',
  '+line 11',
  '+line 12',
  '+line 13',
  '+line 14',
  '+line 15',
  '+line 16',
  '+line 17',
  '+line 18',
  '+line 19',
  '+line 20',
  '+line 21',
  '+line 22',
  '+line 23',
  '+line 24',
  '+line 25',
  '+line 26',
  '+line 27',
  '+line 28',
  '+line 29',
  '+line 30',
  '+line 31',
  '+line 32',
  '+line 33',
  '+line 34',
  '+line 35',
  '+line 36',
  '+line 37',
  '+line 38',
  '+line 39',
  '+line 40',
  '+line 41',
  '+line 42',
  '+line 43',
  '+line 44',
  '+line 45',
  '+line 46',
  '+line 47',
  '+line 48',
  '+line 49',
  '+line 50',
  '+line 51',
  '+line 52',
  '+line 53',
  '+line 54',
  '+line 55',
  '+line 56',
  '+line 57',
  '+line 58',
  '+line 59',
  '+line 60',
].join('\n')

// 278 chars: a four-line hunk.
const SHOW_SMALL = [
  'commit c87664a4fca219bf40cb7c992e33369194f1d660',
  'Author: Ada Lovelace <ada@example.com>',
  'Date:   Tue Mar 3 09:15:00 2026 +0000',
  '',
  '    Extend a.txt with delta',
  '',
  'diff --git a/a.txt b/a.txt',
  'index 85c3040..7a28df3 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,4 @@',
  ' alpha',
  ' beta',
  ' gamma',
  '+delta',
].join('\n')

// 213 chars: `--allow-empty` commit, no diff body at all.
const SHOW_EMPTY = [
  'commit 051aa82333261bfa499c7090d5b1e99d71e0f622',
  'Author: Ada Lovelace <ada@example.com>',
  'Date:   Thu Mar 5 08:00:00 2026 +0000',
  '',
  '    Empty commit',
  '    ',
  '    Recorded with --allow-empty to exercise the header-only path.',
].join('\n')

// 177 chars: a merge commit shown without -m - header and no patch.
const SHOW_MERGE = [
  'commit a0302c1a9c0a6f50bf462b76b1f7049455937e8f',
  'Merge: 37ea0c0 25bdab1',
  'Author: Grace Hopper <grace@example.com>',
  'Date:   Sat Apr 4 12:00:00 2026 +0000',
  '',
  '    Merge topic into main',
  '',
].join('\n')

// 695 chars: `git show HEAD~2..HEAD` - three commits in one output.
const SHOW_RANGE = [
  'commit a0302c1a9c0a6f50bf462b76b1f7049455937e8f',
  'Merge: 37ea0c0 25bdab1',
  'Author: Grace Hopper <grace@example.com>',
  'Date:   Sat Apr 4 12:00:00 2026 +0000',
  '',
  '    Merge topic into main',
  '',
  '',
  'commit 37ea0c035847cab63f12de594838e20cfb13e48f',
  'Author: Grace Hopper <grace@example.com>',
  'Date:   Thu Oct 22 02:59:09 2026 +0000',
  '',
  '    Main change',
  '',
  'diff --git a/g.txt b/g.txt',
  'new file mode 100644',
  'index 0000000..2bdf67a',
  '--- /dev/null',
  '+++ b/g.txt',
  '@@ -0,0 +1 @@',
  '+three',
  '',
  'commit 25bdab1d763e0c7fefe355596d7154cdd3756506',
  'Author: Grace Hopper <grace@example.com>',
  'Date:   Thu Oct 22 02:59:09 2026 +0000',
  '',
  '    Topic change',
  '',
  'diff --git a/f.txt b/f.txt',
  'index 5626abf..814f4a4 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1 +1,2 @@',
  ' one',
  '+two',
].join('\n')

test('fixtures are byte-faithful to the captured git output', () => {
  expect(SHOW_BIG.length).toBe(892)
  expect(SHOW_SMALL.length).toBe(278)
  expect(SHOW_EMPTY.length).toBe(213)
  expect(SHOW_MERGE.length).toBe(177)
  expect(SHOW_RANGE.length).toBe(695)
})

test('the header block collapses to one line and the body is dropped', () => {
  const out = compressGitShow(SHOW_SMALL)
  expect(out.split('\n')[0]).toBe('c87664a Extend a.txt with delta (Ada Lovelace, 2026-03-03)')
  expect(out).not.toContain('Author:')
  expect(out).not.toContain('ada@example.com')
  expect(out).not.toContain('Date:')
  expect(out.length).toBeLessThan(SHOW_SMALL.length)
})

test('the diff body is compressed by compressGitDiff, not pasted through', () => {
  const out = compressGitShow(SHOW_BIG)
  expect(out.split('\n')[0]).toBe('ed4f4b0 Add big.txt fixture (Ada Lovelace, 2026-03-04)')
  // compressGitDiff's summary header and per-file tally.
  expect(out).toContain('1 file changed, +60 -0')
  expect(out).toContain('big.txt  +60 -0')
  // Its noise lines are gone: index/---/+++ plus the message body.
  expect(out).not.toContain('index 0000000')
  expect(out).not.toContain('+++ b/big.txt')
  expect(out).not.toContain('new file mode')
  expect(out).not.toContain('A sixty-line file')
  // And the hunk itself survives, with an elision hint for what was cut.
  expect(out).toContain('+line 1')
  expect(out).toContain('# tk:raw')
  expect(out.length).toBeLessThan(SHOW_BIG.length)
})

test('a tighter diff budget elides sooner, sharing compressGitDiff caps', () => {
  const out = compressGitShow(SHOW_BIG, { maxDiffLinesPerFile: 3, maxDiffTotalLines: 10 })
  expect(out.split('\n')[0]).toBe('ed4f4b0 Add big.txt fixture (Ada Lovelace, 2026-03-04)')
  expect(out).toContain('# tk:raw')
  expect(out).not.toContain('+line 40')
  expect(out.split('\n').length).toBeLessThan(compressGitShow(SHOW_BIG).split('\n').length)
})

test('a commit with no diff body emits the header line alone', () => {
  expect(compressGitShow(SHOW_EMPTY)).toBe('051aa82 Empty commit (Ada Lovelace, 2026-03-05)')
})

test('a merge commit (Merge: line, no patch without -m) emits the header line alone', () => {
  expect(compressGitShow(SHOW_MERGE)).toBe('a0302c1 Merge topic into main (Grace Hopper, 2026-04-04)')
})

test('multi-commit output is left alone: one header per commit cannot be collapsed safely', () => {
  expect(compressGitShow(SHOW_RANGE)).toBe(SHOW_RANGE)
})

test('unrecognized output is returned unchanged', () => {
  const oneline = 'e7a03db Empty commit'
  expect(compressGitShow(oneline)).toBe(oneline)
  const junk = 'fatal: bad revision \'nope\''
  expect(compressGitShow(junk)).toBe(junk)
  // A bare diff is `git show` without a commit header - not ours to touch.
  const bare = 'diff --git a/a b/a\nindex 111..222 100644\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b'
  expect(compressGitShow(bare)).toBe(bare)
  expect(compressGitShow('')).toBe('')
})

test('--date=iso output parses to the same YYYY-MM-DD date', () => {
  const iso = SHOW_SMALL.replace(
    'Date:   Tue Mar 3 09:15:00 2026 +0000',
    'Date:   2026-03-03 09:15:00 +0000',
  )
  expect(compressGitShow(iso).split('\n')[0]).toBe(
    'c87664a Extend a.txt with delta (Ada Lovelace, 2026-03-03)',
  )
})

test('an unparseable Date line bails rather than inventing a date', () => {
  const odd = SHOW_SMALL.replace('Date:   Tue Mar 3 09:15:00 2026 +0000', 'Date:   last Tuesday')
  expect(compressGitShow(odd)).toBe(odd)
})

test('ANSI color codes are stripped before parsing', () => {
  const colored = SHOW_BIG.replace('commit ed4f4b0', 'commit \x1b[33med4f4b0\x1b[m').replace(
    '+++ b/big.txt',
    '\x1b[32m+++ b/big.txt\x1b[m',
  )
  const out = compressGitShow(colored)
  expect(out).not.toContain('\x1b[')
  expect(out.split('\n')[0]).toBe('ed4f4b0 Add big.txt fixture (Ada Lovelace, 2026-03-04)')
})

test('compression never lengthens the text', () => {
  for (const sample of [SHOW_BIG, SHOW_SMALL, SHOW_EMPTY, SHOW_MERGE, SHOW_RANGE, 'commit deadbeef']) {
    expect(compressGitShow(sample).length).toBeLessThanOrEqual(sample.length)
  }
})

test('the default diff caps match the mod-wide ones', () => {
  expect(DEFAULT_SHOW_CAPS.maxDiffLinesPerFile).toBeGreaterThan(0)
  expect(DEFAULT_SHOW_CAPS.maxDiffTotalLines).toBeGreaterThan(DEFAULT_SHOW_CAPS.maxDiffLinesPerFile)
})
