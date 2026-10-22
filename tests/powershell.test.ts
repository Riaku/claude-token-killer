import { expect, mock, test, tier } from 'claude-code/testing'

tier('user')

import { compressPsDir, planPowerShell } from '../hooks/powershell.ts'

// ------------------------------------------------------------- planner

test('Get-ChildItem and its aliases plan a ps-dir trim', () => {
  for (const cmd of ['Get-ChildItem', 'get-childitem', 'gci', 'ls', 'dir']) {
    const p = planPowerShell(cmd)
    expect(p).not.toBeNull()
    expect(p!.kind).toBe('ps-dir')
  }
})

test('parameters are fine as long as the command stays a single pipeline', () => {
  expect(planPowerShell('gci -Force -Recurse *.ts')).not.toBeNull()
  expect(planPowerShell('Get-ChildItem C:\\src -Directory')).not.toBeNull()
})

test('pipes, separators, subexpressions and comments bail out', () => {
  for (const cmd of [
    'gci | more',
    'gci; Remove-Item x',
    'ls -la | wc -l',
    'gci $(Get-Random)',
    'gci ${env:TEMP}',
    'gci `n ls',
    'gci # tk:raw',
    'gci > out.txt',
  ]) {
    expect(planPowerShell(cmd)).toBeNull()
  }
})

test('non-Get-ChildItem commands are not planned', () => {
  expect(planPowerShell('git status')).toBeNull()
  expect(planPowerShell('Get-Process')).toBeNull()
  expect(planPowerShell('')).toBeNull()
})

// ---------------------------------------------------------- compressor

// Real output captured from pwsh 7 on Linux (this machine), verbatim.
const LINUX_TABLE = [
  '    Directory: /opt/data/cache/scratch/psfix',
  '',
  'UnixMode  User Group     LastWriteTime         Size Name',
  '--------  ---- ----     -------------         ---- ----',
  'drwxr-sr-x     hermes hermes     10/21/2026 23:09         4096 sub1',
  'drwxr-sr-x     hermes hermes     10/21/2026 23:09         4096 sub2',
  '-rw-r--r--     hermes hermes     01/15/2026 09:30            6 a.txt',
  '-rw-r--r--     hermes hermes     10/21/2026 23:09         5000 b.bin',
  '',
].join('\n')

// Windows column layout: Mode LastWriteTime Length Name (no user/group).
const WINDOWS_TABLE = [
  '    Directory: C:\\src',
  '',
  'Mode                 LastWriteTime         Length Name',
  '----                 -------------         ------ ----',
  'd----          2026-04-26  1:23 PM                node_modules',
  '-a---          2026-09-16  8:49 PM           2512 Cargo.toml',
  '-a---          2026-10-01 11:00 AM        1048576 big.dll',
  'l----          2026-10-02 10:00 AM                link.txt',
  '',
].join('\n')

test('Linux pwsh table compresses to names with sizes, no user/group noise', () => {
  const out = compressPsDir(LINUX_TABLE, 200)
  expect(out).toContain('psfix (4 entries):')
  expect(out).toContain('sub1/')
  expect(out).toContain('sub2/')
  expect(out).toContain('a.txt (6 B)')
  expect(out).toContain('b.bin (4.9K)')
  expect(out).not.toContain('UnixMode')
  expect(out).not.toContain('hermes')
  expect(out.length).toBeLessThan(LINUX_TABLE.length)
})

test('Windows table layout parses from the back too', () => {
  const out = compressPsDir(WINDOWS_TABLE, 200)
  expect(out).toContain('node_modules/')
  expect(out).toContain('Cargo.toml (2.5K)')
  expect(out).toContain('big.dll (1.0M)')
  expect(out).toContain('link.txt')
  expect(out).not.toContain('LastWriteTime')
})

test('ANSI color codes are stripped before parsing', () => {
  const colored = LINUX_TABLE.replace('sub1', '\x1b[44;1msub1\x1b[0m').replace(
    'a.txt',
    '\x1b[32;1ma.txt\x1b[0m',
  )
  const out = compressPsDir(colored, 200)
  expect(out).toContain('sub1/')
  expect(out).toContain('a.txt (6 B)')
  expect(out).not.toContain('\x1b[')
})

// pwsh wraps a name that does not fit its console width onto the next line,
// and the continuation has no columns of its own. At the default 80 columns
// that is the common case, not the edge case.
const WRAPPED_TABLE = [
  '    Directory: /opt/data/workspace',
  '',
  'UnixMode  User Group     LastWriteTime         Size Name',
  '--------  ---- ----     -------------         ---- ----',
  'drwxr-sr-x     hermes hermes     10/22/2026 05:32         4096 claude-token-kil',
  '                                                               ler',
  '-rw-r--r--     hermes hermes     10/22/2026 05:32         2841 a-rather-long-file-',
  '                                                               name.md',
  '',
].join('\n')

test('names wrapped by the console width are glued back together', () => {
  const out = compressPsDir(WRAPPED_TABLE, 200)
  expect(out).toContain('claude-token-killer/')
  expect(out).toContain('a-rather-long-file-name.md (2.8K)')
  expect(out).not.toContain('kil\n')
  expect(out.length).toBeLessThan(WRAPPED_TABLE.length)
})

test('unrecognized output is returned unchanged', () => {
  const raw = 'Get-ChildItem : Cannot find path /nope\nAt line:1 char:1'
  expect(compressPsDir(raw, 200)).toBe(raw)
})

test('empty directory reports empty', () => {
  const raw = '    Directory: /empty\n'
  const out = compressPsDir(raw, 200)
  expect(out).toContain('(empty)')
})

test('entry cap elides with the tk:raw recovery hint', () => {
  const rows = Array.from(
    { length: 5 },
    (_, i) => `-rw-r--r--     hermes hermes     10/21/2026 23:09            ${i} f${i}.txt`,
  )
  const raw = ['    Directory: /x', 'UnixMode User Group LastWriteTime Size Name', '---- ---- ---- ---- ---- ----', ...rows].join('\n')
  const out = compressPsDir(raw, 2)
  expect(out).toContain('f0.txt')
  expect(out).toContain('f1.txt')
  expect(out).not.toContain('f4.txt')
  expect(out).toContain('+3 more (raw: re-run with # tk:raw)')
})

// ------------------------------------------------------------- e2e hook

type PsRes = { stdout: string; stderr: string; interrupted: boolean }

const SESSION = { cwd: '/work', surface: null, isInteractive: false } as const

// The platform gate reads `OS` from the env - no process spawn on the PS
// path. `spawns` records any process.run the handler makes; tests assert it
// stays empty.
function fakePowerShell(on: any, stdout: string, seen: string[], os: 'windows' | 'linux', spawns: number[] = []) {
  mock.env(on, os === 'windows' ? { OS: 'Windows_NT' } : {})
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('process.run', () => {
    spawns.push(1)
    return { value: { exitCode: 0, stdout: 'Linux\n', stderr: '' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', (_$: any, e: any) => {
    seen.push(String((e as { command?: unknown }).command))
    return { result: { stdout, stderr: '', interrupted: false } satisfies PsRes }
  })
}

test('PowerShell gci round-trips through the hook compressed on Windows', async ($, on) => {
  const seen: string[] = []
  const spawns: number[] = []
  fakePowerShell(on, WINDOWS_TABLE, seen, 'windows', spawns)
  await $.session.start(SESSION)

  const r: any = await $.tool.call({ tool: 'PowerShell', command: 'gci' })
  expect(seen[0]).toBe('gci')
  expect(r.result.stdout).toContain('node_modules/')
  expect(r.result.stdout).not.toContain('LastWriteTime')
  expect(r.result.stdout.length).toBeLessThan(WINDOWS_TABLE.length)
  expect(spawns.length).toBe(0)
})

test('PowerShell on Linux is NOT trimmed: the handler stays inert', async ($, on) => {
  const seen: string[] = []
  const spawns: number[] = []
  fakePowerShell(on, LINUX_TABLE, seen, 'linux', spawns)
  await $.session.start(SESSION)

  const r: any = await $.tool.call({ tool: 'PowerShell', command: 'gci' })
  expect(r.result.stdout).toBe(LINUX_TABLE)
  expect(spawns.length).toBe(0)
})

test('non-gci PowerShell commands pass through untouched', async ($, on) => {
  const seen: string[] = []
  const proc = 'Handles  NPM(K)  ProcessName\n-------  -------  -----------\n1200     50       chrome'
  fakePowerShell(on, proc, seen, 'windows')
  await $.session.start(SESSION)

  const r: any = await $.tool.call({ tool: 'PowerShell', command: 'Get-Process' })
  expect(r.result.stdout).toBe(proc)
})

test('error results pass through uncompressed', async ($, on) => {
  mock.env(on, { OS: 'Windows_NT' })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({
    isError: true,
    result: { stdout: '', stderr: 'term not recognized', interrupted: false },
  }))
  await $.session.start(SESSION)

  const r: any = await $.tool.call({ tool: 'PowerShell', command: 'gci' })
  expect(r.isError).toBe(true)
  expect(r.result.stderr).toBe('term not recognized')
})
