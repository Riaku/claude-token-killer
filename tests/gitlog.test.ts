import { expect, test, tier } from 'claude-code/testing'

tier('user')

import { DEFAULT_LOG_CAPS, compressGitLog, planGitLog } from '../hooks/gitlog.ts'

// ------------------------------------------------------------- planner

test('git log plans kind git-log and never rewrites the command', () => {
  const p = planGitLog('git log')
  expect(p).not.toBeNull()
  expect(p!.kind).toBe('git-log')
  expect(p!.command).toBe('git log')
})

test('flags, counts, ranges and pathspecs still plan - and stay verbatim', () => {
  for (const cmd of [
    'git log',
    'git log -5',
    'git log -n 5',
    'git log --oneline',
    'git log --oneline -5',
    'git log --author=Ada',
    'git log --since=2026-01-01',
    'git log HEAD~3..HEAD -- a.txt',
    'git log -p',
    'git log --stat',
    'git -C /repo log --oneline',
    'git --no-pager log',
  ]) {
    const p = planGitLog(cmd)
    expect(p).not.toBeNull()
    expect(p!.command).toBe(cmd)
  }
})

test('--graph bails: the output is a structure, not a list of commits', () => {
  expect(planGitLog('git log --graph')).toBeNull()
  expect(planGitLog('git log --graph --oneline --all')).toBeNull()
})

test('user-chosen formats bail', () => {
  for (const cmd of [
    'git log --pretty',
    'git log --pretty=oneline',
    'git log --pretty=format:%h %s',
    'git log --format=%H',
    'git log --format',
    'git log --help',
    'git log -h',
    'git log --version',
  ]) {
    expect(planGitLog(cmd)).toBeNull()
  }
})

test('compound commands, redirects, substitutions and comments bail out', () => {
  for (const cmd of [
    'git log | head -20',
    'git log && echo done',
    'git log || true',
    'git log; echo done',
    'git log > log.txt',
    'git log 2>&1',
    'git log $(git rev-parse --show-toplevel)',
    'git log ${REV}',
    'git log `git rev-parse HEAD`',
    'git log\n git status',
    'git log # tk:raw',
    "git log 'HEAD",
  ]) {
    expect(planGitLog(cmd)).toBeNull()
  }
})

test('non-log commands are not planned', () => {
  expect(planGitLog('git show HEAD')).toBeNull()
  expect(planGitLog('git status')).toBeNull()
  expect(planGitLog('git logx')).toBeNull()
  expect(planGitLog('')).toBeNull()
})

// ---------------------------------------------------------- compressor

// Real `git log` from a fixture repository (5 commits, 2 with bodies, 1 empty),
// captured verbatim with GIT_PAGER=cat. Lengths are asserted below so a
// mis-transcribed fixture fails loudly instead of testing a fiction.

// 1280 chars: the 5-commit log.
const LOG_ALL = [
  'commit 051aa82333261bfa499c7090d5b1e99d71e0f622',
  'Author: Ada Lovelace <ada@example.com>',
  'Date:   Thu Mar 5 08:00:00 2026 +0000',
  '',
  '    Empty commit',
  '    ',
  '    Recorded with --allow-empty to exercise the header-only path.',
  '',
  'commit ed4f4b0c36c258755793c43ead958b641e07b777',
  'Author: Ada Lovelace <ada@example.com>',
  'Date:   Wed Mar 4 16:45:00 2026 +0000',
  '',
  '    Add big.txt fixture',
  '    ',
  '    A sixty-line file so the diff body is long enough that compression actually wins.',
  '',
  'commit c87664a4fca219bf40cb7c992e33369194f1d660',
  'Author: Ada Lovelace <ada@example.com>',
  'Date:   Tue Mar 3 09:15:00 2026 +0000',
  '',
  '    Extend a.txt with delta',
  '',
  'commit 782352026b9515b6fc6c7d4c60a7b209171f65e5',
  'Author: Ada Lovelace <ada@example.com>',
  'Date:   Mon Mar 2 11:30:00 2026 +0000',
  '',
  '    Add gamma line and b.txt',
  '    ',
  '    Long body line one for the second commit which is intentionally verbose to demonstrate compression savings in the fixture.',
  '    Long body line two for the second commit which is intentionally verbose to demonstrate compression savings in the fixture.',
  '',
  'commit 8be64fa49a23d6e6fe613acc8bab31559f148bc0',
  'Author: Ada Lovelace <ada@example.com>',
  'Date:   Sun Mar 1 10:00:00 2026 +0000',
  '',
  '    Initial import of a.txt',
  '    ',
  '    This is the body of the first commit.',
  '    It has multiple lines of prose that cost tokens.',
].join('\n')

// 145 chars: `git log --oneline` - already one line per commit.
const LOG_ONELINE = [
  '051aa82 Empty commit',
  'ed4f4b0 Add big.txt fixture',
  'c87664a Extend a.txt with delta',
  '7823520 Add gamma line and b.txt',
  '8be64fa Initial import of a.txt',
].join('\n')

// 263 chars: `git log -p --max-count=1 HEAD~1` from the merge
// fixture repo - real patch output, which must never be mangled.
const LOG_PATCH = [
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
].join('\n')

// 607 chars: `git log` across a real merge, so the `Merge:` header line is real
// output, not a hand-written sample.
const LOG_MERGE = [
  'commit a0302c1a9c0a6f50bf462b76b1f7049455937e8f',
  'Merge: 37ea0c0 25bdab1',
  'Author: Grace Hopper <grace@example.com>',
  'Date:   Sat Apr 4 12:00:00 2026 +0000',
  '',
  '    Merge topic into main',
  '',
  'commit 37ea0c035847cab63f12de594838e20cfb13e48f',
  'Author: Grace Hopper <grace@example.com>',
  'Date:   Thu Oct 22 02:59:09 2026 +0000',
  '',
  '    Main change',
  '',
  'commit 25bdab1d763e0c7fefe355596d7154cdd3756506',
  'Author: Grace Hopper <grace@example.com>',
  'Date:   Thu Oct 22 02:59:09 2026 +0000',
  '',
  '    Topic change',
  '',
  'commit ef790a8fa37fe08eaf4df994f58ffbb762c34f74',
  'Author: Grace Hopper <grace@example.com>',
  'Date:   Wed Apr 1 10:00:00 2026 +0000',
  '',
  '    base',
].join('\n')

// 589 chars: the same repo with `--date=iso`.
const LOG_ISO = [
  'commit a0302c1a9c0a6f50bf462b76b1f7049455937e8f',
  'Merge: 37ea0c0 25bdab1',
  'Author: Grace Hopper <grace@example.com>',
  'Date:   2026-04-04 12:00:00 +0000',
  '',
  '    Merge topic into main',
  '',
  'commit 37ea0c035847cab63f12de594838e20cfb13e48f',
  'Author: Grace Hopper <grace@example.com>',
  'Date:   2026-10-22 02:59:09 +0000',
  '',
  '    Main change',
  '',
  'commit 25bdab1d763e0c7fefe355596d7154cdd3756506',
  'Author: Grace Hopper <grace@example.com>',
  'Date:   2026-10-22 02:59:09 +0000',
  '',
  '    Topic change',
  '',
  'commit ef790a8fa37fe08eaf4df994f58ffbb762c34f74',
  'Author: Grace Hopper <grace@example.com>',
  'Date:   2026-04-01 10:00:00 +0000',
  '',
  '    base',
].join('\n')

test('fixtures are byte-faithful to the captured git output', () => {
  expect(LOG_ALL.length).toBe(1280)
  expect(LOG_ONELINE.length).toBe(145)
  expect(LOG_PATCH.length).toBe(263)
  expect(LOG_MERGE.length).toBe(607)
  expect(LOG_ISO.length).toBe(589)
})

const EXPECTED_ALL = [
  '051aa82 Empty commit (Ada Lovelace, 2026-03-05) +1 line',
  'ed4f4b0 Add big.txt fixture (Ada Lovelace, 2026-03-04) +1 line',
  'c87664a Extend a.txt with delta (Ada Lovelace, 2026-03-03)',
  '7823520 Add gamma line and b.txt (Ada Lovelace, 2026-03-02) +2 lines',
  '8be64fa Initial import of a.txt (Ada Lovelace, 2026-03-01) +2 lines',
].join('\n')

test('each commit becomes one line: short sha, subject, author, ISO date', () => {
  const out = compressGitLog(LOG_ALL)
  expect(out).toBe(EXPECTED_ALL)
  expect(out.length).toBeLessThan(LOG_ALL.length)
  expect(out).not.toContain('Author:')
  expect(out).not.toContain('ada@example.com')
})

test('message bodies are dropped and counted, subjects are not', () => {
  const out = compressGitLog(LOG_ALL)
  // The two verbose fixture bodies cost ~200 chars each in the original.
  expect(out).not.toContain('intentionally verbose')
  expect(out).not.toContain('multiple lines of prose')
  // A commit with no body gets no suffix at all.
  expect(out.split('\n').find((l) => l.startsWith('c87664a'))).toBe(
    'c87664a Extend a.txt with delta (Ada Lovelace, 2026-03-03)',
  )
})

test('a merge commit keeps its subject and drops the Merge: line', () => {
  const out = compressGitLog(LOG_MERGE)
  expect(out.split('\n')).toEqual([
    'a0302c1 Merge topic into main (Grace Hopper, 2026-04-04)',
    '37ea0c0 Main change (Grace Hopper, 2026-10-22)',
    '25bdab1 Topic change (Grace Hopper, 2026-10-22)',
    'ef790a8 base (Grace Hopper, 2026-04-01)',
  ])
  expect(out).not.toContain('Merge:')
})

test('--date=iso output parses to the same YYYY-MM-DD dates', () => {
  expect(compressGitLog(LOG_ISO)).toBe(
    [
      'a0302c1 Merge topic into main (Grace Hopper, 2026-04-04)',
      '37ea0c0 Main change (Grace Hopper, 2026-10-22)',
      '25bdab1 Topic change (Grace Hopper, 2026-10-22)',
      'ef790a8 base (Grace Hopper, 2026-04-01)',
    ].join('\n'),
  )
})

test('the entry cap elides with a tk:raw re-run hint', () => {
  const out = compressGitLog(LOG_ALL, { maxEntries: 2, rerun: 'git log' })
  expect(out.split('\n')).toEqual([
    '051aa82 Empty commit (Ada Lovelace, 2026-03-05) +1 line',
    'ed4f4b0 Add big.txt fixture (Ada Lovelace, 2026-03-04) +1 line',
    '... +3 more commits elided - raw: git log # tk:raw',
  ])
  expect(out).not.toContain('8be64fa')
})

test('the elision names the exact re-run the caller supplied', () => {
  const out = compressGitLog(LOG_ALL, { maxEntries: 1, rerun: 'git log --author=Ada --oneline' })
  expect(out).toContain('... +4 more commits elided - raw: git log --author=Ada --oneline # tk:raw')
})

test('caps can be passed without a re-run command: git log is the default', () => {
  const out = compressGitLog(LOG_ALL, { maxEntries: 2 })
  expect(out).toContain('... +3 more commits elided - raw: git log # tk:raw')
})

test('the default cap is 50 commits', () => {
  expect(DEFAULT_LOG_CAPS.maxEntries).toBe(50)
  expect(DEFAULT_LOG_CAPS.rerun).toBe('git log')
  // Five commits are under the cap: no elision line.
  expect(compressGitLog(LOG_ALL)).not.toContain('elided')
})

test('already-compact and non-standard formats pass through untouched', () => {
  // --oneline: nothing to gain, and the never-inflate guard keeps it as-is.
  expect(compressGitLog(LOG_ONELINE)).toBe(LOG_ONELINE)
  // -p: a diff body is not a commit block, so the whole text bails.
  expect(compressGitLog(LOG_PATCH)).toBe(LOG_PATCH)
  // Unrelated output.
  const junk = 'fatal: not a git repository (or any of the parent directories): .git'
  expect(compressGitLog(junk)).toBe(junk)
  expect(compressGitLog('')).toBe('')
})

test('a truncated or malformed block bails instead of half-compressing', () => {
  const noDate = 'commit 8be64fa49a23d6e6fe613acc8bab31559f148bc0\nAuthor: Ada Lovelace <ada@example.com>\n\n    Initial import'
  expect(compressGitLog(noDate)).toBe(noDate)
  const badDate = LOG_ALL.replace('Sun Mar 1 10:00:00 2026 +0000', 'sometime last spring')
  expect(compressGitLog(badDate)).toBe(badDate)
  // A stat block after the message is not a commit block.
  const withStat = LOG_MERGE.replace(
    '    base',
    '    base\n\n f.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)',
  )
  expect(compressGitLog(withStat)).toBe(withStat)
})

test('ANSI color codes are stripped before parsing', () => {
  const colored = LOG_MERGE.replace('commit a0302c1', 'commit \x1b[33ma0302c1\x1b[m').replace(
    '    base',
    '    \x1b[1mbase\x1b[m',
  )
  const out = compressGitLog(colored)
  expect(out).not.toContain('\x1b[')
  expect(out.split('\n')[0]).toBe('a0302c1 Merge topic into main (Grace Hopper, 2026-04-04)')
  expect(out.split('\n')[3]).toBe('ef790a8 base (Grace Hopper, 2026-04-01)')
})

test('compression never lengthens the text', () => {
  for (const sample of [LOG_ALL, LOG_MERGE, LOG_ISO, LOG_ONELINE, LOG_PATCH, 'commit deadbeef']) {
    expect(compressGitLog(sample).length).toBeLessThanOrEqual(sample.length)
  }
})
