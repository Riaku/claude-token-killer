import { expect, mock, test, tier } from 'claude-code/testing'

tier('user')

// The mod under test sits above these stubs: a `$.tool.call` crosses our
// tool.call hook first, then lands on the fake Bash below, which records the
// command it actually received and answers with canned stdout. The Linux
// gate is probed with `uname -s` at session start, so the stubs answer it.

type BashRes = { stdout: string; stderr: string; interrupted: boolean }

const SESSION = { cwd: '/work', surface: null, isInteractive: false } as const

function fakeBash(on: any, stdout: string, seen: string[]) {
  mock.env(on, {})
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'Linux\n', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', (_$: any, e: any) => {
    seen.push(String((e as { command?: unknown }).command))
    return { result: { stdout, stderr: '', interrupted: false } satisfies BashRes }
  })
}

const boot = async ($: any): Promise<void> => {
  await $.session.start(SESSION)
}

const call = async ($: any, command: string): Promise<any> => await $.tool.call({ tool: 'Bash', command })

test('git status is rewritten to porcelain and its output compressed', async ($, on) => {
  const seen: string[] = []
  fakeBash(on, '## main...origin/main [ahead 2]\n M a.txt\n?? u.txt\n', seen)
  await boot($)

  const r = await call($, 'git status')

  expect(seen[0]).toBe('git status --porcelain=v1 -b -uall')
  expect(r.result.stdout).toContain('* main...origin/main [ahead 2]')
  expect(r.result.stdout).toContain(' M a.txt')
  expect(r.result.stdout).not.toContain('## ')
})

test('git diff output is compressed to a summary with trimmed hunks', async ($, on) => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    'index 1111111..2222222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,9 +1,9 @@',
    ' c1',
    ' c2',
    ' c3',
    ' c4',
    '-old',
    '+new',
    ' c5',
    ' c6',
    ' c7',
  ].join('\n')
  const seen: string[] = []
  fakeBash(on, diff, seen)
  await boot($)

  const r = await call($, 'git diff')

  expect(seen[0]).toBe('git diff --no-color')
  expect(r.result.stdout).toContain('1 file changed, +1 -1')
  expect(r.result.stdout).toContain('a.txt  +1 -1')
  expect(r.result.stdout).toContain('@@ -1,9 +1,9 @@')
  expect(r.result.stdout.length).toBeLessThan(diff.length)
})

test('recursive grep is given -n and its matches are grouped', async ($, on) => {
  const files = ['src/a.ts', 'src/b.ts', 'src/c.ts']
  const hits = files
    .flatMap((f, fi) =>
      Array.from({ length: 6 }, (_, i) => `${f}:${fi * 10 + i}:TODO item ${fi}-${i} ${'x'.repeat(40)}`),
    )
    .join('\n')
  const seen: string[] = []
  fakeBash(on, hits, seen)
  await boot($)

  const r = await call($, 'grep -r TODO src/')

  expect(seen[0]).toBe('grep -n -r TODO src/')
  expect(r.result.stdout).toContain('18 matches in 3 files')
  expect(r.result.stdout).toContain('src/a.ts (6):')
  expect(r.result.stdout.length).toBeLessThan(hits.length)
})

test('a refused call passes the refusal through untouched', async ($, on) => {
  mock.env(on, {})
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'Linux\n', stderr: '' } }))
  on('tool.call', () => ({ deny: 'not allowed' }))
  await boot($)

  const r = await call($, 'git status')
  expect(r.deny).toBe('not allowed')
})

test('a failed command keeps its real error output', async ($, on) => {
  mock.env(on, {})
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'Linux\n', stderr: '' } }))
  on('tool.call', () => ({ result: { stdout: '', stderr: 'fatal: not a git repository', interrupted: false }, isError: true }))
  await boot($)

  const r = await call($, 'git status')
  expect(r.isError).toBe(true)
  expect(r.result.stderr).toBe('fatal: not a git repository')
})

test('commands outside the three shapes run exactly as written', async ($, on) => {
  const seen: string[] = []
  fakeBash(on, 'whatever output here that is long enough to matter for the guards to skip it', seen)
  await boot($)

  const r = await call($, 'ls -la')
  expect(seen[0]).toBe('ls -la')
  expect(r.result.stdout).toContain('whatever output')
})

test('a compound command is never rewritten', async ($, on) => {
  const seen: string[] = []
  fakeBash(on, '## main\n M a.txt\n', seen)
  await boot($)

  await call($, 'git status | head')
  expect(seen[0]).toBe('git status | head')
})

test('a string-shaped result (plain harness) is compressed too', async ($, on) => {
  mock.env(on, {})
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'Linux\n', stderr: '' } }))
  on('tool.call', () => ({ result: '## main\n M a.txt\n' }))
  await boot($)

  const r = await call($, 'git status')
  expect(String(r.result)).toContain('* main')
})

test('a non-Linux host is untouched: uname says Darwin, no rewrite happens', async ($, on) => {
  mock.env(on, {})
  const seen: string[] = []
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'Darwin\n', stderr: '' } }))
  on('tool.call', (_$: any, e: any) => {
    seen.push(String((e as { command?: unknown }).command))
    return { result: { stdout: '## main\n M a.txt\n', stderr: '', interrupted: false } }
  })
  await boot($)

  const r = await call($, 'git status')
  expect(seen[0]).toBe('git status')
  expect(r.result.stdout).toContain('## main')
})
