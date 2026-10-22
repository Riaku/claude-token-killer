import { expect, mock, test, tier } from 'claude-code/testing'

tier('user')

// The mod under test sits above these stubs: a `$.tool.call` crosses our
// tool.call hook first, then lands on the fake Bash below, which records the
// command it actually received and answers with canned stdout. The platform
// gate is a pure env read (`OS`), so no process.run stub is needed - the
// Darwin/Windows tests assert none happens.

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

  expect(seen[0]).toBe('git status --porcelain=v1 -b')
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

test('recovery: a `# tk:raw` re-run reaches the shell untouched and uncompressed', async ($, on) => {
  const bigDiff = [
    'diff --git a/big.txt b/big.txt',
    '@@ -1,200 +1,200 @@',
    ...Array.from({ length: 200 }, (_, i) => (i % 10 === 0 ? `+changed${i}` : ` context${i}`)),
  ].join('\n')
  const seen: string[] = []
  fakeBash(on, bigDiff, seen)
  await boot($)

  // First: normal call gets rewritten and compressed.
  const r1 = await call($, 'git diff')
  expect(seen[0]).toBe('git diff --no-color')
  expect(r1.result.stdout).toContain('elided')
  expect(r1.result.stdout.length).toBeLessThan(bigDiff.length)

  // Recovery: the exact command from the elision hint runs raw.
  const r2 = await call($, 'git diff -- big.txt # tk:raw')
  expect(seen[1]).toBe('git diff -- big.txt # tk:raw')
  expect(r2.result.stdout).toBe(bigDiff)
})

test('an interrupted command passes through with its partial output', async ($, on) => {
  mock.env(on, {})
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'Linux\n', stderr: '' } }))
  on('tool.call', () => ({ result: { stdout: '## main\n partial before ctrl-c', stderr: '', interrupted: true } }))
  await boot($)

  const r = await call($, 'git status')
  expect(r.result.interrupted).toBe(true)
  expect(r.result.stdout).toBe('## main\n partial before ctrl-c')
})

test('non-Windows is treated as Linux: a Darwin host gets trimmed too, with no spawn', async ($, on) => {
  mock.env(on, {})
  const seen: string[] = []
  let spawns = 0
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('process.run', () => {
    spawns++
    return { value: { exitCode: 0, stdout: 'Darwin\n', stderr: '' } }
  })
  on('tool.call', (_$: any, e: any) => {
    seen.push(String((e as { command?: unknown }).command))
    return { result: { stdout: '## main\n M a.txt\n', stderr: '', interrupted: false } }
  })
  await boot($)

  const r = await call($, 'git status')
  expect(seen[0]).toBe('git status --porcelain=v1 -b')
  expect(r.result.stdout).toContain('* main')
  expect(spawns).toBe(0)
})

test('Bash on Windows is untouched: OS=Windows_NT gates the rewrite off', async ($, on) => {
  mock.env(on, { OS: 'Windows_NT' })
  const seen: string[] = []
  let spawns = 0
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('process.run', () => {
    spawns++
    return { value: { exitCode: 0, stdout: 'Linux\n', stderr: '' } }
  })
  on('tool.call', (_$: any, e: any) => {
    seen.push(String((e as { command?: unknown }).command))
    return { result: { stdout: '## main\n M a.txt\n', stderr: '', interrupted: false } }
  })
  await boot($)

  const r = await call($, 'git status')
  expect(seen[0]).toBe('git status')
  expect(r.result.stdout).toContain('## main')
  expect(spawns).toBe(0)
})

// ------------------------------------------------- dispatch through tool.call
// The module tests exercise the compressors directly; these prove the planner
// chain + COMPRESSORS map actually wire them into the Bash handler.

test('ls -la is compacted through the handler', async ($, on) => {
  const seen: string[] = []
  const raw = [
    'total 28',
    'drwxr-xr-x  4 hermes hermes 4096 Oct 22 02:27 .',
    'drwxrwxrwt  1 root   root   4096 Oct 22 02:27 ..',
    '-rw-r--r--  1 hermes hermes    6 Oct 22 02:27 a.txt',
    'drwxr-xr-x  2 hermes hermes 4096 Oct 22 02:27 projects',
    'lrwxrwxrwx  1 hermes hermes    5 Oct 22 02:27 link.txt -> a.txt',
    '',
  ].join('\n')
  fakeBash(on, raw, seen)
  await boot($)

  const r = await call($, 'ls -la')
  expect(seen[0]).toBe('ls -la')
  expect(r.result.stdout).toContain('a.txt')
  expect(r.result.stdout).toContain('projects/')
  expect(r.result.stdout.length).toBeLessThan(raw.length)
  expect(r.result.stdout).not.toContain('Oct 22 02:27')
})

test('git show is rewritten with --no-color and its header collapsed', async ($, on) => {
  const seen: string[] = []
  const raw = [
    'commit 75a02562d02fe0a41448b8f873e53359d54c1f57',
    'Author: Ada Lovelace <ada@example.com>',
    'Date:   Wed Mar 4 16:45:00 2026 +0000',
    '',
    '    Add c.txt',
    '',
    '    A longer body that the model does not need verbatim.',
    '',
    'diff --git a/c.txt b/c.txt',
    'new file mode 100644',
    'index 0000000..587be6b',
    '--- /dev/null',
    '+++ b/c.txt',
    '@@ -0,0 +1,3 @@',
    '+x',
    '+y',
    '+z',
    '',
  ].join('\n')
  fakeBash(on, raw, seen)
  await boot($)

  const r = await call($, 'git show HEAD')
  expect(seen[0]).toBe('git show HEAD --no-color')
  expect(r.result.stdout).toContain('75a0256')
  expect(r.result.stdout).toContain('Add c.txt')
  expect(r.result.stdout).not.toContain('Author:')
  expect(r.result.stdout.length).toBeLessThan(raw.length)
})

test('git log commits collapse to one line each', async ($, on) => {
  const seen: string[] = []
  // Real git log indents every message line by four spaces, blank message
  // lines included (`cat -A` shows `    $`). Keep that shape exactly.
  const block = (sha: string, subject: string) =>
    [
      `commit ${sha}`,
      'Author: Ada Lovelace <ada@example.com>',
      'Date:   Wed Mar 4 16:45:00 2026 +0000',
      '',
      `    ${subject}`,
      '    ',
      '    Body line that costs tokens and carries nothing actionable.',
      '',
    ].join('\n')
  const raw = block('75a02562d02fe0a41448b8f873e53359d54c1f57', 'Add c.txt') +
    block('86553b0a1d2e3f405162738495a6b7c8d9e0f112', 'Extend a.txt with delta')
  fakeBash(on, raw, seen)
  await boot($)

  const r = await call($, 'git log -n 2')
  expect(seen[0]).toBe('git log -n 2') // compression-only: never rewritten
  expect(r.result.stdout).toContain('Add c.txt')
  expect(r.result.stdout).toContain('Extend a.txt with delta')
  expect(r.result.stdout).not.toContain('Author:')
  expect(r.result.stdout.length).toBeLessThan(raw.length)
})

test('pytest failures survive, progress noise does not', async ($, on) => {
  const seen: string[] = []
  const raw = [
    '=== test session starts ===',
    'platform linux -- Python 3.12.0, pytest-8.0.0',
    'collected 7 items',
    '',
    'tests/test_a.py ....F..                                              [100%]',
    '',
    '=== FAILURES ===',
    '___ test_y ___',
    '',
    '    assert 1 == 2',
    'E   assert 1 == 2',
    '',
    '=== short test summary info ===',
    'FAILED tests/test_a.py::test_y - AssertionError',
    '=== 1 failed, 6 passed in 0.12s ===',
    '',
  ].join('\n')
  fakeBash(on, raw, seen)
  await boot($)

  const r = await call($, 'pytest')
  expect(seen[0]).toBe('pytest')
  expect(r.result.stdout).toContain('FAILED tests/test_a.py::test_y')
  expect(r.result.stdout).toContain('6 passed')
  expect(r.result.stdout.length).toBeLessThan(raw.length)
})

test('kubectl get pods is compacted to value rows', async ($, on) => {
  const seen: string[] = []
  const raw = [
    'NAME                           READY   STATUS    RESTARTS   AGE',
    'hermes-7d9f8c6b5-abcde         1/1     Running   0          2d',
    'postgres-0                     1/1     Running   1          5d',
    'longhorn-manager-x2k4p         1/1     Running   3          12d',
    '',
  ].join('\n')
  fakeBash(on, raw, seen)
  await boot($)

  const r = await call($, 'kubectl get pods')
  expect(seen[0]).toBe('kubectl get pods')
  expect(r.result.stdout).toContain('hermes-7d9f8c6b5-abcde')
  expect(r.result.stdout.length).toBeLessThan(raw.length)
})

test('a look-alike command the planner does not model stays untouched', async ($, on) => {
  const seen: string[] = []
  const raw = 'NAME   MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS\nsda      8:0    0  500G  0 disk /\n'
  fakeBash(on, raw, seen)
  await boot($)

  const r = await call($, 'lsblk')
  expect(seen[0]).toBe('lsblk')
  expect(r.result.stdout).toBe(raw)
})

test('a trailing 2>&1 is preserved and the table still compresses', async ($, on) => {
  const seen: string[] = []
  const raw = [
    'NAME                   READY   STATUS    RESTARTS   AGE',
    'drop-7d9f8c6b5-abcde   1/1     Running   0          2d',
    'drop-7d9f8c6b5-fghij   1/1     Running   0          2d',
    '',
  ].join('\n')
  fakeBash(on, raw, seen)
  await boot($)

  const r = await call($, 'kubectl get pods -n apps -l app=drop 2>&1')
  // The redirect reached the shell, last, exactly as written.
  expect(seen[0]).toBe('kubectl get pods -n apps -l app=drop 2>&1')
  expect(r.result.stdout).toContain('drop-7d9f8c6b5-abcde')
  expect(r.result.stdout.length).toBeLessThan(raw.length)
})

test('a rewritten command keeps 2>&1 after the flags it adds', async ($, on) => {
  const seen: string[] = []
  fakeBash(on, '## main...origin/main\n M a.txt\n', seen)
  await boot($)

  await call($, 'git status 2>&1')
  expect(seen[0]).toBe('git status --porcelain=v1 -b 2>&1')
})

test('a mid-pipeline 2>&1 still passes straight through', async ($, on) => {
  const seen: string[] = []
  const cmd = 'kubectl get pods 2>&1 | head -3'
  fakeBash(on, 'NAME READY\n', seen)
  await boot($)

  const r = await call($, cmd)
  expect(seen[0]).toBe(cmd)
  expect(r.result.stdout).toBe('NAME READY\n')
})

test('kubectl logs is planned, compressed, and never rewritten', async ($, on) => {
  const seen: string[] = []
  const lines = Array.from({ length: 40 }, () => 'GET /health 200 1ms')
  lines.push('ERROR db refused')
  const raw = lines.join('\n')
  fakeBash(on, raw, seen)
  await boot($)

  const cmd = 'kubectl logs -n apps deployment/drop --tail=100'
  const r = await call($, cmd)
  expect(seen[0]).toBe(cmd)
  expect(r.result.stdout).toContain('x40')
  expect(r.result.stdout).toContain('ERROR db refused')
  expect(r.result.stdout.length).toBeLessThan(raw.length)
})


test('gh run view --log is compressed without being rewritten', async ($, on) => {
  const seen: string[] = []
  const L = (job: string, step: string, msg: string) => `${job}\t${step}\t2026-10-22T04:46:13.6419785Z ${msg}`
  const raw = [
    L('test', 'Run tests', '##[group]Run npm test'),
    L('test', 'Run tests', 'ok 313 tests'),
    L('test', 'Run tests', 'ok 313 tests'),
    L('test', 'Run tests', 'Error: one failure'),
  ].join('\n')
  fakeBash(on, raw, seen)
  await boot($)

  const cmd = 'gh run view 123 --log-failed'
  const r = await call($, cmd)
  expect(seen[0]).toBe(cmd)
  expect(r.result.stdout).toContain('test > Run tests (3)')
  expect(r.result.stdout).toContain('ok 313 tests  x2')
  expect(r.result.stdout).toContain('Error: one failure')
  expect(r.result.stdout).not.toContain('2026-10-22T')
})

test('gh pr checks drops the job URL to an id', async ($, on) => {
  const seen: string[] = []
  const raw = 'test\tpass\t18s\thttps://github.com/o/r/actions/runs/1/job/456\t\n'
  fakeBash(on, raw, seen)
  await boot($)

  const r = await call($, 'gh pr checks 3')
  expect(seen[0]).toBe('gh pr checks 3')
  expect(r.result.stdout).toBe('test  pass  18s  job:456')
})

test('rg and git grep reuse the grep compressor without being rewritten', async ($, on) => {
  const seen: string[] = []
  const raw = Array.from({ length: 12 }, (_, i) => `hooks/ls.ts:${i + 10}:match${i}`).join('\n')
  fakeBash(on, raw, seen)
  await boot($)

  for (const cmd of ['rg -n match hooks/', 'git grep -n match -- hooks']) {
    seen.length = 0
    const r = await call($, cmd)
    expect(seen[0]).toBe(cmd)
    expect(r.result.stdout).toContain('12 matches in 1 file')
    expect(r.result.stdout.length).toBeLessThan(raw.length)
  }
})

test('kubectl exec -- ls -l routes to the ls compactor', async ($, on) => {
  const seen: string[] = []
  const rows = Array.from({ length: 30 }, (_, i) => `-rw-r--r--  1 hermes hermes  179${i} Oct 21 22:54 file-${i}.txt`)
  const raw = ['total 68', ...rows].join('\n')
  fakeBash(on, raw, seen)
  await boot($)

  const cmd = 'kubectl exec -n apps pod-1 -c gateway -- ls -la /opt/data/workspace'
  const r = await call($, cmd)
  expect(seen[0]).toBe(cmd)
  expect(r.result.stdout.length).toBeLessThan(raw.length)
  expect(r.result.stdout).toContain('file-0.txt')
})

test('ps and df squeeze their column padding and are not rewritten', async ($, on) => {
  const seen: string[] = []
  const df = 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        98G   40G   58G  41% /\n'
  fakeBash(on, df, seen)
  await boot($)

  const r = await call($, 'df -h')
  expect(seen[0]).toBe('df -h')
  expect(r.result.stdout).toBe('Filesystem Size Used Avail Use% Mounted on\n/dev/sda1 98G 40G 58G 41% /\n')
})

test('the new families pass through untouched when a planner bails', async ($, on) => {
  const seen: string[] = []
  fakeBash(on, 'x\n', seen)
  await boot($)

  for (const cmd of ['ps -p 1', 'rg -l plan', 'kubectl exec pod -- cat /etc/hosts', 'gh run view 1 --json']) {
    seen.length = 0
    const r = await call($, cmd)
    expect(seen[0]).toBe(cmd)
    expect(r.result.stdout).toBe('x\n')
  }
})
