import { expect, test, tier } from 'claude-code/testing'

tier('user')

import { compressCmdlet, planCmdlet } from '../hooks/pwshcmdlets.ts'

// Real output captured from pwsh 7 on Linux (this machine), verbatim, trimmed
// to the rows a test needs. Windows column names differ by unit - `WS(K)` vs
// `WS(M)` - and the drop list is matched without the unit, so both parse.
const PROCESS = [
  '',
  ' NPM(K)    PM(M)      WS(M)     CPU(s)      Id  SI ProcessName',
  ' ------    -----      -----     ------      --  -- -----------',
  '      0     0.00       3.37       0.00  135703 …03 bash',
  '      0     0.00     196.89     841.01     210 210 hermes',
  '      0     0.00     630.15   4,482.86     228 228 hermes',
  '      0     0.00      95.00       0.31  135705 …03 pwsh',
  '',
].join('\n')

const COMMAND = [
  '',
  'CommandType     Name                                               Version    Source',
  '-----------     ----                                               -------    ------',
  'Alias           Add-AssertionOperator ->                           6.2.0      Pester',
  'Function        Add-ShouldOperator                                 6.2.0      Pester',
  'Cmdlet          Add-Content                                        7.0.0.0    Microsoft.PowerShell.Management',
  '',
].join('\n')

const MODULES = [
  '',
  '    Directory: /usr/local/share/powershell/Modules',
  '',
  'ModuleType Version    PreRelease Name                                PSEdition ExportedCommands',
  '---------- -------    ---------- ----                                --------- ----------------',
  'Script     6.2.0                 Pester                              Desk      {Invoke-Pester, Describe, Context, It…}',
  '',
  '    Directory: /opt/microsoft/powershell/7/Modules',
  '',
  'ModuleType Version    PreRelease Name                                PSEdition ExportedCommands',
  '---------- -------    ---------- ----                                --------- ----------------',
  'Manifest   1.2.5                 Microsoft.PowerShell.Archive        Desk      {Compress-Archive, Expand-Archive}',
  '',
].join('\n')

// Shaped after the Windows `Format-Table` layout these cmdlets print; the real
// thing is exercised by scripts/live-windows.mjs in CI, which fails on an
// inflated or unrecognised result.
const SERVICES = [
  'Status   Name               DisplayName',
  '------   ----               -----------',
  'Running  AeLookupSvc        Application Experience',
  'Stopped  ALG                Application Layer Gateway Service',
  'Stopped  AppIDSvc           Application Identity',
].join('\n')

const TCP = [
  'LocalAddress   LocalPort RemoteAddress  RemotePort State   AppliedSetting OwningProcess',
  '------------   --------- -------------  ---------- -----   --------------- -------------',
  '0.0.0.0        135       0.0.0.0        0          Listen  Datagram        4',
  '127.0.0.1      5432      0.0.0.0        0          Listen  Stream          2100',
  '::             135       ::             0          Listen  Datagram        4',
].join('\n')

// The same table with the destination address column empty on every row, which
// is what an unconnected socket prints.
const TCP_EMPTY = [
  'LocalAddress   LocalPort RemoteAddress  RemotePort State   AppliedSetting OwningProcess',
  '------------   --------- -------------  ---------- -----   -------------- -------------',
  '0.0.0.0        135       0.0.0.0        0          Listen                 4',
  '127.0.0.1      5432      0.0.0.0        0          Listen                 2100',
].join('\n')

const CAPS = { maxRows: 200 }

// ---------------------------------------------------------------- planner

test('every table cmdlet and its unambiguous aliases plan a kind', () => {
  expect(planCmdlet('Get-Process')!.kind).toBe('ps-process')
  expect(planCmdlet('ps')!.kind).toBe('ps-process')
  expect(planCmdlet('Get-Service')!.kind).toBe('ps-service')
  expect(planCmdlet('gsv')!.kind).toBe('ps-service')
  expect(planCmdlet('Get-NetTCPConnection')!.kind).toBe('ps-net')
  expect(planCmdlet('Get-Command')!.kind).toBe('ps-command')
  expect(planCmdlet('gcm')!.kind).toBe('ps-command')
  expect(planCmdlet('Get-CimInstance Win32_Process')!.kind).toBe('ps-cim')
  expect(planCmdlet('Get-Module -ListAvailable')!.kind).toBe('ps-module')
})

test('the plan keeps the command exactly as written', () => {
  expect(planCmdlet('  Get-Process -Name bash  ')!.command).toBe('Get-Process -Name bash')
  expect(planCmdlet('Microsoft.PowerShell.Management\\Get-Process')!.kind).toBe('ps-process')
  expect(planCmdlet('Get-Process -Name bash')!.command).toBe('Get-Process -Name bash')
})

test('a pipeline, a redirect or a comment bails: only a bare cmdlet is parsed', () => {
  expect(planCmdlet('Get-Process | Select-Object -First 5')).toBeNull()
  // `&` is the call operator to PowerShell but a command separator to the
  // operator test every planner shares, so this stays conservative.
  expect(planCmdlet('& Get-Process')).toBeNull()
  expect(planCmdlet('Get-Service; Get-Process')).toBeNull()
  expect(planCmdlet('Get-Process > out.txt')).toBeNull()
  expect(planCmdlet('Get-Process # tk:raw')).toBeNull()
  expect(planCmdlet('Get-Process $(Get-Random)')).toBeNull()
})

test('a parameter that changes the output shape bails', () => {
  expect(planCmdlet('Get-CimInstance Win32_Process -Property Name,ProcessId')).toBeNull()
  expect(planCmdlet('Get-Process -OutFile proc.txt')).toBeNull()
  expect(planCmdlet('Get-Process -AsJob')).toBeNull()
  expect(planCmdlet('Get-CimInstance Win32_Process -Filter "Name = \'x\'"')).toBeNull()
})

test('other commands are not planned here', () => {
  expect(planCmdlet('Get-Content log.txt')).toBeNull()
  expect(planCmdlet('Get-Help Get-Process')).toBeNull()
  expect(planCmdlet('Write-Host hi')).toBeNull()
  expect(planCmdlet('')).toBeNull()
})

// -------------------------------------------------------------- compressor

// Shaped after the Windows `Get-Process` layout, where `Id` is wide enough for
// its own values: aligned, so it takes the column-dropping path.
const WINDOWS_PROCESS = [
  ' NPM(K)    PM(K)      WS(K)     CPU(s)     Id  SI ProcessName',
  ' ------    -----      -----     ------     --  -- -----------',
  '    220       30      25000      80.25   4100   0 chrome',
  '    180       12      12000       1.25   2200   1 bash',
].join('\n')

test('a process table keeps name, id and memory and drops the six columns nobody reads', () => {
  const out = compressCmdlet(WINDOWS_PROCESS, 'ps-process', CAPS, 'Get-Process')
  expect(out).toContain('(2 rows)')
  expect(out).toContain('# cols:')
  expect(out).toContain('chrome')
  expect(out).toContain('4100')
  expect(out).not.toContain('NPM(K)')
  expect(out).not.toContain('------')
  expect(out.length).toBeLessThan(PROCESS.length)
})

test('a six-digit Id still lands in its own column: pwsh separates narrow columns with one space', () => {
  // `Id` is a two-character column in pwsh's layout and a Linux process Id is
  // six digits, so the value overflows the header width. The row is still
  // single-space separated, which is the split that reproduces the rule's
  // column count - the values stay with their own headers.
  const out = compressCmdlet(PROCESS, 'ps-process', CAPS, 'Get-Process')
  expect(out).toContain('# cols: ws cpu id processname')
  expect(out).toContain('3.37 0.00 135703 bash')
  expect(out).not.toContain('------')
})

test('a command table drops Version, keeps type, name and source', () => {
  const out = compressCmdlet(COMMAND, 'ps-command', CAPS, 'Get-Command')
  expect(out).toContain('# cols: commandtype name source')
  expect(out).toContain('Add-ShouldOperator')
  expect(out).toContain('Microsoft.PowerShell.Management')
  expect(out).not.toContain('6.2.0')
})

test('a service table drops DisplayName, which is its Name with spaces', () => {
  const out = compressCmdlet(SERVICES, 'ps-service', CAPS, 'Get-Service')
  expect(out).toContain('# cols: status name')
  expect(out).toContain('AeLookupSvc')
  expect(out).not.toContain('Application Experience')
})

test('a column that is the same in every row is printed once on the legend', () => {
  const out = compressCmdlet(TCP, 'ps-net', CAPS, 'Get-NetTCPConnection')
  // RemotePort is 0 on every row, so it costs one legend entry instead of three
  // cells; LocalAddress varies and stays a column.
  expect(out).toContain('remoteport=0')
  expect(out).toContain('localaddress')
  expect(out).toContain('5432')
})

test('a table with an empty column is left whole rather than spliced into the wrong column', () => {
  // Two adjacent columns merge into one run of spaces when the left one is
  // empty, so the cells cannot be mapped back onto their headers. The rows are
  // kept whole and only the padding and the dash rule go.
  const out = compressCmdlet(TCP_EMPTY, 'ps-net', CAPS, 'Get-NetTCPConnection')
  expect(out).toContain('# header: ')
  expect(out).toContain('0.0.0.0 135 0.0.0.0 0 Listen 4')
  expect(out).not.toContain('------')
})

test('rows wider than their column are collapsed, never spliced into the wrong cell', () => {
  // A six-digit Id overflows `Get-Process`'s two-character Id column and shifts
  // the rest of the row right, so cells cannot be mapped back onto headers.
  const out = compressCmdlet(PROCESS, 'ps-process', CAPS, 'Get-Process')
  expect(out).toContain('135703')
  expect(out).toContain('bash')
  expect(out).not.toContain('  ') // padding runs are squeezed
})

test('a module listing keeps one heading per install root', () => {
  const out = compressCmdlet(MODULES, 'ps-module', CAPS, 'Get-Module -ListAvailable')
  expect(out).toContain('/usr/local/share/powershell/Modules (1):')
  expect(out).toContain('/opt/microsoft/powershell/7/Modules (1):')
  expect(out).toContain('Pester')
  expect(out).toContain('Microsoft.PowerShell.Archive')
})

test('the row cap elides with a count and the tk:raw recovery hint', () => {
  const out = compressCmdlet(SERVICES, 'ps-service', { maxRows: 1 }, 'Get-Service')
  expect(out).toContain('AeLookupSvc')
  expect(out).not.toContain('AppIDSvc')
  expect(out).toContain('+2 more - raw: Get-Service # tk:raw')
})

test('non-table output is returned unchanged', () => {
  const plain = 'Get-Process: no process found\n'
  expect(compressCmdlet(plain, 'ps-process', CAPS, 'Get-Process')).toBe(plain)
})

test('a table with no dash rule is left alone rather than half-parsed', () => {
  const noRule = 'Status Name\nRunning Spooler\nStopped ALG\n'
  expect(compressCmdlet(noRule, 'ps-service', CAPS, 'Get-Service')).toBe(noRule)
})

test('never inflates: a two-row narrow table is left as it is', () => {
  const tiny = 'Status Name\n------ ----\nRunning x\n'
  const out = compressCmdlet(tiny, 'ps-service', CAPS, 'Get-Service')
  expect(out.length).toBeLessThanOrEqual(tiny.length)
})

test('CRLF output compresses like LF output', () => {
  const crlf = SERVICES.replace(/\n/g, '\r\n')
  const out = compressCmdlet(crlf, 'ps-service', CAPS, 'Get-Service')
  expect(out).toContain('AeLookupSvc')
  expect(out).not.toContain('\r')
})
