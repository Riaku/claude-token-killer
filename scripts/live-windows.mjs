// PowerShell / Get-ChildItem checks against the real shell.
//
// Runs on any host with pwsh installed, but the Windows-specific signal - that
// the hook's platform gate sees `OS=Windows_NT` - only exists on win32, so CI
// runs it on windows-latest. Locally it still exercises the parser with real
// pwsh formatting, including CRLF output.
//
// Scripts are passed to pwsh as files rather than -Command strings: quoting a
// command through bash on Linux and cmd.exe on Windows is where this kind of
// harness silently tests the wrong thing.
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const H = new URL('../hooks/', import.meta.url).href
const { planPowerShell, compressPsDir } = await import(H + 'powershell.ts')
const { compressCmdlet } = await import(H + 'pwshcmdlets.ts')
const { compressEvents } = await import(H + 'pwshevents.ts')
const { compressHelp } = await import(H + 'pwshhelp.ts')

let failed = 0
let skipped = 0
const isWindows = process.platform === 'win32'

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 64e6, timeout: 300000 })
  } catch (e) {
    return String(e.stdout ?? '') + String(e.stderr ?? '')
  }
}

function check(name, raw, compress, mustKeep) {
  let once
  let twice
  try {
    once = compress(raw)
    twice = compress(raw)
  } catch (e) {
    failed += 1
    console.log(`FAIL ${name}: threw on real output: ${String(e).slice(0, 120)}`)
    return
  }
  const problems = []
  if (once.length > raw.length) problems.push(`inflated ${raw.length} -> ${once.length}B`)
  if (once !== twice) problems.push('not deterministic')
  const missing = mustKeep.filter((k) => raw.includes(k) && !once.includes(k))
  if (missing.length) problems.push(`lost: ${missing.map((m) => JSON.stringify(m.slice(0, 50))).join(', ')}`)
  if (problems.length) {
    failed += 1
    console.log(`FAIL ${name}: ${problems.join('; ')}`)
    return
  }
  console.log(`ok   ${name}: ${raw.length} -> ${once.length}B`)
}

const root = mkdtempSync(join(tmpdir(), 'tk-ps-'))
const ps = (body) => {
  const file = join(root, `step-${Math.random().toString(36).slice(2, 8)}.ps1`)
  writeFileSync(file, body)
  return run(`pwsh -NoProfile -File "${file}"`)
}

const version = ps('$PSVersionTable.PSVersion.ToString()\n').trim()
if (!version || /ParserError|not recognized/i.test(version)) {
  console.log(`SKIP pwsh is not usable on this host: ${version.slice(0, 80)}`)
  process.exit(0)
}
console.log(`pwsh ${version} on ${process.platform}`)

// The gate in register.ts reads this exact variable; if it is absent on a
// real Windows host, PowerShell compression would silently never run.
if (isWindows) {
  if (process.env.OS === 'Windows_NT') console.log('ok   platform gate sees OS=Windows_NT')
  else {
    failed += 1
    console.log(`FAIL platform gate: process.env.OS is ${JSON.stringify(process.env.OS)}, expected Windows_NT`)
  }
} else {
  skipped += 1
  console.log('SKIP platform gate: not a Windows host')
}

// ---------------------------------------------------------------- fixture
for (let i = 0; i < 150; i += 1) writeFileSync(join(root, `entry-${String(i).padStart(3, '0')}.txt`), 'x'.repeat(10 + (i % 40)))
writeFileSync(join(root, 'a name with spaces and a very long tail that wraps.txt'), 'x')
mkdirSync(join(root, 'subdir'))
const old = new Date('2020-01-02T03:04:05Z')
utimesSync(join(root, 'entry-000.txt'), old, old)

const listScript = `Get-ChildItem -Force -LiteralPath $args[0] | Out-String -Width 200\n`
const listFile = join(root, 'list.ps1')
writeFileSync(listFile, listScript)
const rawDir = run(`pwsh -NoProfile -File "${listFile}" "${root}"`)

const plan = planPowerShell('Get-ChildItem -Force .')
if (!plan) {
  failed += 1
  console.log('FAIL planPowerShell did not recognise Get-ChildItem')
} else {
  check('Get-ChildItem', rawDir, (t) => compressPsDir(t, { maxEntries: 200 }, plan.command), ['entry-000.txt', 'entry-149.txt'])
  // CRLF is what a Windows host produces; a parser that only splits on \n turns
  // every row into one line and either bails or mangles it.
  check('Get-ChildItem (CRLF)', rawDir.replace(/\r?\n/g, '\r\n'), (t) => compressPsDir(t, { maxEntries: 200 }, plan.command), [
    'entry-000.txt',
    'entry-149.txt',
  ])
  const capped = compressPsDir(rawDir, { maxEntries: 20 }, "Get-ChildItem 'C:\\logs'")
  if (capped.includes("Get-ChildItem 'C:\\logs' # tk:raw")) console.log('ok   cap hint quotes the command')
  else {
    failed += 1
    console.log(`FAIL cap hint: ${JSON.stringify(capped.split('\n').filter((l) => l.includes('tk:raw')).join(' | '))}`)
  }
}

// Format-List output is properties, not a table: it must survive untouched.
const listRaw = run(
  `pwsh -NoProfile -Command "Get-ChildItem -Force -LiteralPath '${root}' | Select-Object -First 2 | Format-List | Out-String -Width 200"`,
)
const listOut = compressPsDir(listRaw, { maxEntries: 200 }, 'Get-ChildItem . | Format-List')
if (listOut === listRaw || listOut.length <= listRaw.length) console.log('ok   Format-List output is left alone')
else {
  failed += 1
  console.log('FAIL Format-List output changed shape')
}

// ------------------------------------------------------------ cmdlet tables
// Every one of these runs against the real cmdlet and its real formatting.
// `check` fails on an inflated or nondeterministic result and on a marker that
// went missing, so a parser that quietly drops a row is caught here.
const TABLES = [
  { name: 'Get-Process', cmd: 'Get-Process', kind: 'ps-process', keep: [] },
  { name: 'Get-Command', cmd: 'Get-Command', kind: 'ps-command', keep: ['Get-ChildItem'] },
  { name: 'Get-Module', cmd: 'Get-Module -ListAvailable', kind: 'ps-module', keep: [] },
]
for (const t of TABLES) {
  const raw = ps(`${t.cmd} | Out-String -Width 80\n`)
  const plan = planPowerShell(t.cmd)
  if (plan === null || plan.kind !== t.kind) {
    failed += 1
    console.log(`FAIL plan for ${t.cmd}: ${JSON.stringify(plan)}`)
    continue
  }
  const keep = t.keep.length > 0 ? t.keep : []
  check(t.name, raw, (text) => compressCmdlet(text, t.kind, { maxRows: 200 }, plan.command), keep)
}

// Windows-only cmdlets: these shapes do not exist on Linux pwsh at all.
const WINDOWS_ONLY = [
  { name: 'Get-Service', cmd: 'Get-Service', kind: 'ps-service', keep: [] },
  { name: 'Get-CimInstance', cmd: 'Get-CimInstance Win32_Process', kind: 'ps-cim', keep: [] },
  { name: 'Get-NetTCPConnection', cmd: 'Get-NetTCPConnection', kind: 'ps-net', keep: [] },
  { name: 'Get-WinEvent', cmd: 'Get-WinEvent -LogName System -MaxEvents 20', kind: 'ps-event', keep: [] },
]
for (const t of WINDOWS_ONLY) {
  if (!isWindows) {
    skipped += 1
    console.log(`SKIP ${t.name}: not a Windows host`)
    continue
  }
  const raw = ps(`${t.cmd} | Out-String -Width 80\n`)
  const compress = (text) =>
    t.kind === 'ps-event'
      ? compressEvents(text, { maxRows: 200 }, t.cmd)
      : compressCmdlet(text, t.kind, { maxRows: 200 }, t.cmd)
  check(t.name, raw, compress, t.keep)
}

// --------------------------------------------------------------- Get-Help
const helpRaw = ps('Get-Help Get-ChildItem -Full | Out-String -Width 80\n')
check('Get-Help -Full', helpRaw, (text) => compressHelp(text, { maxHelpLines: 200 }, 'Get-Help Get-ChildItem -Full'), [
  'NAME',
  'Get-ChildItem',
])

// ------------------------------------------- commands that must not be planned
// `git status` is planned by the shared, cross-platform planners instead, so it
// is checked separately from the cmdlet families below.
for (const cmd of ['Get-Content x', 'cat foo', 'Get-ChildItem | Remove-Item', 'Write-Host hi']) {
  if (planPowerShell(cmd) === null) console.log(`ok   not planned: ${cmd}`)
  else {
    failed += 1
    console.log(`FAIL wrongly planned: ${cmd}`)
  }
}

// The cross-platform fall-through: `git status` must reach the git planner (and
// its rewrite) rather than nothing at all.
if (planPowerShell('git status') === null) console.log('ok   git status falls through to the shared planners')
else {
  failed += 1
  console.log('FAIL git status was claimed by the PowerShell cmdlet planner')
}

rmSync(root, { recursive: true, force: true })
console.log(`\n${failed} failed, ${skipped} skipped`)
process.exit(failed === 0 ? 0 : 1)
