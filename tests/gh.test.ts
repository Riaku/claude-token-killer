import { expect, test, tier } from 'claude-code/testing'

tier('user')

import { compressGh, planGh } from '../hooks/gh.ts'

// ------------------------------------------------------------- fixtures
//
// Captured from the real `gh` CLI against cli/cli, in both shapes it prints:
//   - TTY     : `script -qec 'gh pr list --repo cli/cli --limit 5' /dev/null`
//               (banner + padded header + ANSI colour codes)
//   - non-TTY : `gh pr list --repo cli/cli --limit 5 > out.txt`
//               (tab-separated, no header, no padding) - this is the shape a
//               hook actually sees, since hooks run without a terminal.

const PR_TTY = [
  "\r",
  "Showing 5 of 59 open pull requests in cli/cli\r",
  "\r",
  "\x1b[0;2;4;37mID    \x1b[0m  \x1b[0;2;4;37mTITLE                       \x1b[0m  \x1b[0;2;4;37mBRANCH                \x1b[0m  \x1b[0;2;4;37mCREATED AT        \x1b[0m\r",
  "\x1b[0;32m#14784\x1b[0m  Avoid repeating the skill...  \x1b[0;36mtommaso-moro-skill-...\x1b[0m  \x1b[0;90mabout 9 hours ago\x1b[0m\r",
  "\x1b[0;90m#14783\x1b[0m  release download: add --v...  \x1b[0;36mmrecachinas:release...\x1b[0m  \x1b[0;90mabout 9 hours ago\x1b[0m\r",
  "\x1b[0;90m#14781\x1b[0m  Add global feature flag i...  \x1b[0;36mwilliammartin-globa...\x1b[0m  \x1b[0;90mabout 16 hours ago\x1b[0m\r",
  "\x1b[0;32m#14727\x1b[0m  fix(issue create): resolv...  \x1b[0;36mumairnaeem0309:fix/...\x1b[0m  \x1b[0;90mabout 4 days ago\x1b[0m\r",
  "\x1b[0;32m#14716\x1b[0m  chore(deps): bump actions...  \x1b[0;36mdependabot/github_a...\x1b[0m  \x1b[0;90mabout 5 days ago\x1b[0m\r",
].join('\n')

const PR_TSV = [
  "14784\tAvoid repeating the skill installation safety warning\ttommaso-moro-skill-install-warnings\tOPEN\t2026-10-21T17:32:10Z",
  "14783\trelease download: add --verify to check immutability and build provenance before downloading\tmrecachinas:release-download-verify\tDRAFT\t2026-10-21T17:05:55Z",
  "14781\tAdd global feature flag infrastructure\twilliammartin-global-feature-flags\tDRAFT\t2026-10-21T10:05:39Z",
  "14727\tfix(issue create): resolve --type before creating the issue\tumairnaeem0309:fix/issue-create-resolve-type-before-create\tOPEN\t2026-10-17T15:21:58Z",
  "14716\tchore(deps): bump actions/create-github-app-token from 3.2.0 to 3.3.0\tdependabot/github_actions/actions/create-github-app-token-3.3.0\tOPEN\t2026-10-16T14:05:44Z",
].join('\n')

const ISSUE_TSV = [
  "14755\tOPEN\tSupport persistent command defaults without requiring custom aliases\tenhancement, gh-pr\t2026-10-19T22:07:47Z",
  "14754\tOPEN\tgh auth login --with-token accepts a token without the advertised workflow scope\tbug, priority-3, gh-auth\t2026-10-20T09:58:00Z",
  "14733\tOPEN\tgh skill search: opt-in discovery of supported hidden skill directories\tenhancement, gh-skill\t2026-10-20T12:16:21Z",
  "14704\tOPEN\t`gh run list` show cancelled jobs icon\tenhancement, gh-run\t2026-10-19T07:46:01Z",
  "14703\tOPEN\t`gh issue create --type` creates the issue, then exits 1 with `type \"X\" not found` without printing its URL (causes duplicates on retry)\tbug, priority-2, gh-issue\t2026-10-17T22:37:25Z",
].join('\n')

const RUN_TTY = [
  "\x1b[?25l\r\x1b[K\r\x1b[36m\u28fe\x1b[0m\r\x1b[K\r\x1b[36m\u28fd\x1b[0m\r\x1b[K\r\x1b[36m\u28fb\x1b[0m\r\x1b[K\r\x1b[36m\u28bf\x1b[0m\r\x1b[K\r\x1b[36m\u287f\x1b[0m\r\x1b[K\r\x1b[36m\u28df\x1b[0m\r\x1b[K\r\x1b[36m\u28ef\x1b[0m\x1b[?25h\r\x1b[K\x1b[0;2;4;37mSTATUS\x1b[0m  \x1b[0;2;4;37mTITLE       \x1b[0m  \x1b[0;2;4;37mWORKFLOW \x1b[0m  \x1b[0;2;4;37mBRANCH\x1b[0m  \x1b[0;2;4;37mEVENT   \x1b[0m  \x1b[0;2;4;37mID       \x1b[0m  \x1b[0;2;4;37mELAPSED\x1b[0m  \x1b[0;2;4;37mAGE      \x1b[0m\r",
  "\x1b[0;32m\u2713     \x1b[0m  \x1b[0;1;39mDependabo...\x1b[0m  Depend...  \x1b[0;1;39mtrunk \x1b[0m  schedule  \x1b[0;36m397137...\x1b[0m  10s      \x1b[0;90mabout ...\x1b[0m\r",
  "\x1b[0;32m\u2713     \x1b[0m  \x1b[0;1;39mDependabo...\x1b[0m  Depend...  \x1b[0;1;39mtrunk \x1b[0m  schedule  \x1b[0;36m397120...\x1b[0m  16s      \x1b[0;90mabout ...\x1b[0m\r",
  "\x1b[0;32m\u2713     \x1b[0m  \x1b[0;1;39mTriage Sc...\x1b[0m  Triage...  \x1b[0;1;39mtrunk \x1b[0m  schedule  \x1b[0;36m397118...\x1b[0m  11s      \x1b[0;90mabout ...\x1b[0m\r",
  "\x1b[0;32m\u2713     \x1b[0m  \x1b[0;1;39mDependabo...\x1b[0m  Depend...  \x1b[0;1;39mtrunk \x1b[0m  schedule  \x1b[0;36m397083...\x1b[0m  12s      \x1b[0;90mabout ...\x1b[0m\r",
  "\x1b[0;32m\u2713     \x1b[0m  \x1b[0;1;39mDependabo...\x1b[0m  Depend...  \x1b[0;1;39mtrunk \x1b[0m  schedule  \x1b[0;36m397061...\x1b[0m  11s      \x1b[0;90mabout ...\x1b[0m\r",
].join('\n')

const RUN_TSV = [
  "completed\tsuccess\tDependabot PR Triage Scheduler\tDependabot PR Triage Scheduler\ttrunk\tschedule\t39713758938\t10s\t2026-10-22T02:52:33Z",
  "completed\tsuccess\tDependabot PR Triage Scheduler\tDependabot PR Triage Scheduler\ttrunk\tschedule\t39712027528\t16s\t2026-10-22T02:33:23Z",
  "completed\tsuccess\tTriage Scheduled Tasks\tTriage Scheduled Tasks\ttrunk\tschedule\t39711834677\t11s\t2026-10-22T02:31:19Z",
  "completed\tsuccess\tDependabot PR Triage Scheduler\tDependabot PR Triage Scheduler\ttrunk\tschedule\t39708356532\t12s\t2026-10-22T01:54:19Z",
  "completed\tsuccess\tDependabot PR Triage Scheduler\tDependabot PR Triage Scheduler\ttrunk\tschedule\t39706103979\t11s\t2026-10-22T01:30:44Z",
].join('\n')


// ------------------------------------------------------------- planner

test('gh pr/issue/run list plan a gh trim', () => {
  for (const cmd of [
    'gh pr list',
    'gh pr list --limit 5',
    'gh issue list --state open --limit 20',
    'gh run list -L 5',
    'gh pr ls',
    '/usr/bin/gh pr list --author @me',
  ]) {
    const p = planGh(cmd)
    expect(p).not.toBeNull()
    expect(p!.kind).toBe('gh')
  }
})

test('the planned command is the original string, unchanged', () => {
  const cmd = 'gh  pr   list   --limit 5'
  expect(planGh(cmd)!.command).toBe(cmd)
})

test('machine formats, --web and help bail out', () => {
  for (const cmd of [
    'gh pr list --json number,title',
    'gh pr list --json=number',
    'gh issue list --web',
    'gh run list --help',
    'gh pr list -h',
    'gh pr list --template {{.number}}',
    'gh pr list --jq .[].number',
  ]) {
    expect(planGh(cmd)).toBeNull()
  }
})

test('only * list subcommands are planned', () => {
  expect(planGh('gh pr view 12')).toBeNull()
  expect(planGh('gh pr diff 12')).toBeNull()
  expect(planGh('gh api repos/cli/cli/pulls')).toBeNull()
  expect(planGh('gh')).toBeNull()
  expect(planGh('')).toBeNull()
  expect(planGh('git pr list')).toBeNull()
})

test('pipes, separators, redirects, substitution and comments bail out', () => {
  for (const cmd of [
    'gh pr list | head -5',
    'gh pr list && git pull',
    'gh pr list; echo done',
    'gh pr list || true',
    'gh pr list > out.txt',
    'gh pr list 2>&1',
    'gh pr list $(date)',
    'gh run list ${LIMIT}',
    'gh pr list `date`',
    'gh pr list # tk:raw',
    'gh pr list\ngh run list',
  ]) {
    expect(planGh(cmd)).toBeNull()
  }
})

// ------------------------------------------------------------- TTY table

test('pr TTY table: padding and colour gone, one line per pull request', () => {
  const out = compressGh(PR_TTY)
  expect(out).not.toContain('\x1b')
  expect(out).not.toContain('\r')
  expect(out).toContain('Showing 5 of 59 open pull requests in cli/cli')
  expect(out).toContain('#14784 Avoid repeating the skill... (tommaso-moro-skill-...)')
  expect(out).toContain('#14716 chore(deps): bump actions... (dependabot/github_a...)')
  // one banner line + five items
  expect(out.split('\n')).toHaveLength(6)
  // the column padding is what we came for
  expect(out).not.toMatch(/ {3,}/)
})

test('issue TTY-style table keeps the label set', () => {
  const out = compressGh(PR_TTY.replace('BRANCH', 'LABELS'))
  expect(out).not.toContain('\x1b')
  expect(out.split('\n')).toHaveLength(6)
})

test('run TTY table maps the status glyph to a word and keeps the run id', () => {
  const out = compressGh(RUN_TTY)
  expect(out).not.toContain('\x1b')
  // the braille spinner frame is not a row
  expect(out).not.toMatch(/[\u2800-\u28FF]/)
  expect(out.split('\n')).toHaveLength(5)
  expect(out).toContain('success  Depend...  trunk  397137...')
  expect(out).toMatch(/^success {2}\S+ {2}trunk {2}/)
})

// ------------------------------------------------------------- TSV table

test('pr TSV output (what a hook actually sees) becomes #id title (branch) [state]', () => {
  const out = compressGh(PR_TSV)
  expect(out).toContain(
    '#14784 Avoid repeating the skill installation safety warning (tommaso-moro-skill-install-warnings) [OPEN]',
  )
  expect(out).toContain('#14783 release download: add --verify to check immutability')
  expect(out).toContain('(mrecachinas:release-download-verify) [DRAFT]')
  expect(out).not.toContain('\t')
  expect(out.split('\n')).toHaveLength(5)
  // no createdAt column survives; it is the noisiest field and never needed
  expect(out).not.toContain('2026-10-21T17:32:10Z')
})

test('issue TSV output becomes #id title {labels} [state]', () => {
  const out = compressGh(ISSUE_TSV)
  expect(out).toContain(
    '#14755 Support persistent command defaults without requiring custom aliases {enhancement, gh-pr} [OPEN]',
  )
  expect(out).toContain('#14754 gh auth login --with-token')
  expect(out).not.toContain('\t')
  expect(out.split('\n')).toHaveLength(5)
})

test('run TSV output becomes status  workflow  branch  run-id', () => {
  const out = compressGh(RUN_TSV)
  expect(out).toContain('success  Dependabot PR Triage Scheduler  trunk  39713758938')
  expect(out).toContain('success  Triage Scheduled Tasks  trunk  39711834677')
  expect(out).not.toContain('\t')
  expect(out.split('\n')).toHaveLength(5)
})

test('the compressed listing is much smaller than the padded one', () => {
  expect(compressGh(PR_TTY).length).toBeLessThan(PR_TTY.length / 1.5)
  expect(compressGh(RUN_TTY).length).toBeLessThan(RUN_TTY.length / 3)
})

// ------------------------------------------------------------- capping

test('items past maxItems are elided with a tk:raw re-run', () => {
  const rows = Array.from(
    { length: 60 },
    (_, i) => `${1000 + i}\tTitle number ${i}\tbranch-${i}\tOPEN\t2026-01-01T00:00:00Z`,
  ).join('\n')
  const out = compressGh(rows, { maxItems: 50 })
  expect(out).toContain('#1049 Title number 49 (branch-49) [OPEN]')
  expect(out).not.toContain('Title number 50 ')
  expect(out).toContain('... +10 more items elided - raw: gh pr list --limit 60 # tk:raw')
})

test('maxItems is honoured when set low', () => {
  const rows = Array.from(
    { length: 8 },
    (_, i) => `${i + 1}\tTitle ${i}\tbranch-${i}\tOPEN\t2026-01-01T00:00:00Z`,
  ).join('\n')
  const out = compressGh(rows, { maxItems: 3 })
  expect(out.split('\n')).toHaveLength(4)
  expect(out).toContain('... +5 more items elided')
})

// ------------------------------------------------------------- passthrough

test('non-table input passes through untouched', () => {
  for (const text of [
    'no pull requests match your search in cli/cli',
    'no open issues match your search in cli/cli',
    '',
    'hello world',
    'Welcome to GitHub CLI!\n\nTo get started with GitHub CLI, please run: gh auth login',
    '{"number":14784,"title":"Avoid repeating the skill installation safety warning"}',
    'gh: Not Found (HTTP 404)\nTry gh repo view',
  ]) {
    expect(compressGh(text)).toBe(text)
  }
})

test('a broken table is not half-compressed', () => {
  // header says four columns, the row has three
  const mangled = 'ID  TITLE  BRANCH  CREATED AT\n#1  only two cells'
  expect(compressGh(mangled)).toBe(mangled)
})

test('a single field table with no room to shrink is left alone', () => {
  const tiny = '1\tx\t\tOPEN\tz'
  expect(compressGh(tiny)).toBe(tiny)
})

test('compression never inflates', () => {
  for (const text of [PR_TTY, RUN_TTY, PR_TSV, ISSUE_TSV, RUN_TSV, '1\tx\t\tOPEN\tz', 'x']) {
    expect(compressGh(text).length).toBeLessThanOrEqual(text.length)
  }
})

test('output is idempotent enough to be safe to re-run', () => {
  const once = compressGh(PR_TSV)
  expect(compressGh(once)).toBe(once)
})
