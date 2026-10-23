// token-killer: the mod's tool.call hooks. Rewrite a token-hungry command into
// a compact form before it runs, then compress its stdout on the way back, in
// the Claude Code process, with no external binary and no spawn.
//
// This module owns the planner chain, the platform gate, and the fail-open
// boundary. Per-command knowledge lives in the per-command modules; the file map
// in README.md is the index.
//
// Fail-open by design: the handler catches and calls `next`, so the original
// output reaches the model. Unlike a redactor, the worst case here is wasted
// tokens, never lost safety.

import type { EngineInterface, Register } from 'claude-code'
import { CAP_CHOICES, DEFAULT_CAPS, compressGitDiff, compressGitStatus, compressGrep, type Caps } from './compress.ts'
import { planRewrite, splitStderrMerge, withStderrMerge } from './plan.ts'
import { installStatus, recordSaved, utf8Length, type StatusEngine } from './status.ts'
import { compressPsDir, planPowerShell } from './powershell.ts'
import { compressCmdlet } from './pwshcmdlets.ts'
import { compressEvents } from './pwshevents.ts'
import { compressHelp } from './pwshhelp.ts'
import { compressDotnet, planDotnet } from './dotnet.ts'
import { compressCargoTest, planCargoTest } from './cargotest.ts'
import { compressFind, planFind } from './find.ts'
import { compressFluxGet, planFluxGet } from './flux.ts'
import { compressGh, planGh } from './gh.ts'
import { compressGhPrChecks, compressGhPrView, planGhPr } from './ghpr.ts'
import { compressGhRunView, planGhRunView } from './ghrunview.ts'
import { planGitGrep, planRg } from './grepalias.ts'
import { planKubectlExec } from './kubectlexec.ts'
import { compressRows, planRows } from './sysinfo.ts'
import { compressGitLog, planGitLog } from './gitlog.ts'
import { compressGitShow, planGitShow } from './gitshow.ts'
import { compressGoBuild, planGoBuild } from './gobuild.ts'
import { compressGoTest, planGoTest } from './gotest.ts'
import { compressKubectlLogs, planKubectlLogs } from './kubectllogs.ts'
import { compressLs, planLs } from './ls.ts'
import { compressNpmInstall, planNpmInstall } from './npm.ts'
import { compressPlaywright, planPlaywright } from './playwright.ts'
import { compressPytest, planPytest } from './pytest.ts'
import { compressTable, planDocker, planKubectlGet } from './tables.ts'
import { compressVitest, planVitest } from './vitest.ts'

// The manifest declares each cap as a string pick-list (`options`), because
// Claude Code's `/plugin configure` dialog only prefills choices and booleans -
// a `number` field opens blank, so a fresh install would ask for seven numbers
// instead of showing the defaults. The values arrive as strings here, and an
// older config may still hold plain numbers, so both are accepted - but only
// the rungs in CAP_CHOICES, so an out-of-list value cannot quietly become a cap.
type Options = Partial<Record<keyof Caps, number | string>> & { notify?: boolean }

/** `finish` toasts and counts, so it needs both of the UI calls. */
type FinishEngine = StatusEngine & Pick<EngineInterface, 'ui'>

/** One cap: a picker string or a number on its ladder, else the default. */
function capValue(value: unknown, key: keyof Caps): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isInteger(n) && CAP_CHOICES[key].includes(n) ? n : DEFAULT_CAPS[key]
}

/** The caps register() runs with: every option, defaulted and coerced. */
export function readCaps(opts: Readonly<Record<string, unknown>>): Caps {
  return {
    maxStatusFiles: capValue(opts.maxStatusFiles, 'maxStatusFiles'),
    maxDiffLinesPerFile: capValue(opts.maxDiffLinesPerFile, 'maxDiffLinesPerFile'),
    maxDiffTotalLines: capValue(opts.maxDiffTotalLines, 'maxDiffTotalLines'),
    maxGrepPerFile: capValue(opts.maxGrepPerFile, 'maxGrepPerFile'),
    maxGrepTotal: capValue(opts.maxGrepTotal, 'maxGrepTotal'),
    maxLineLen: capValue(opts.maxLineLen, 'maxLineLen'),
    maxDirEntries: capValue(opts.maxDirEntries, 'maxDirEntries'),
    maxCmdletRows: capValue(opts.maxCmdletRows, 'maxCmdletRows'),
    maxDiagLines: capValue(opts.maxDiagLines, 'maxDiagLines'),
  }
}

/** Bytes saved before the toast is worth showing. */
const TOAST_MIN_BYTES = 200

type Finishable = { deny?: unknown; isError?: boolean; result?: unknown }

/**
 * The tail both handlers share once a command has run: pass through a refusal,
 * an error or an interrupt; take the text out of either result shape (a harness
 * may answer with a plain string); keep the compressed text only when it is
 * smaller, because a smaller wrong answer is worse than a larger right one;
 * then report the saving, to the toast and to the session counter behind the
 * status line. Returns null when the original result must stand.
 */
async function finish<T extends Finishable>(
  $: FinishEngine,
  r: T,
  kind: string,
  notify: boolean,
  compress: (text: string) => string,
): Promise<T | { result: string } | { result: { stdout: string } } | null> {
  if (r.deny !== undefined || r.isError) return null
  const maybeInterrupted = r.result as { interrupted?: unknown } | undefined
  if (maybeInterrupted && typeof maybeInterrupted === 'object' && maybeInterrupted.interrupted === true) return null

  const res = r.result as { stdout?: unknown } | string | undefined
  const original = typeof res === 'string' ? res : res && typeof res.stdout === 'string' ? res.stdout : null
  if (original === null || original === '') return null

  const compressed = compress(original)
  if (compressed === original || compressed.length >= original.length) return null

  // Bytes, not string length: a line of CJK or emoji costs the model three or
  // four bytes per character, and the counter says what it saved.
  const before = utf8Length(original)
  const saved = before - utf8Length(compressed)
  const pct = Math.round((saved / before) * 100)
  if (notify && saved >= TOAST_MIN_BYTES) {
    try {
      $.ui.toast(`token-killer: ${kind} -${saved} bytes (${pct}%)`)
    } catch {
      // no UI: the compression still stands
    }
  }

  // Awaited on purpose: the write is one small JSON file, and awaiting it means
  // a hot reload cannot drop the last saving. record never throws.
  await recordSaved($, saved)

  if (typeof res === 'string') return { result: compressed }
  return { result: { ...(res as object), stdout: compressed } }
}


type Plan = { kind: string; command: string }

// Every planner is a pure function of the command string. First match wins;
// a null from all of them means "leave this command alone".
const PLANNERS: ReadonlyArray<(command: string) => Plan | null> = [
  planRewrite,
  planGitShow,
  planGitLog,
  planLs,
  planFind,
  planDocker,
  planKubectlExec,
  planKubectlGet,
  planKubectlLogs,
  planFluxGet,
  planPytest,
  planVitest,
  planPlaywright,
  planNpmInstall,
  planCargoTest,
  planGoTest,
  planGoBuild,
  planGh,
  planGhRunView,
  planGhPr,
  planRg,
  planGitGrep,
  planRows,
  planDotnet,
]

function planAny(command: string): Plan | null {
  // A trailing `2>&1` is stripped before planning and re-appended verbatim
  // after whatever flags a planner adds. Left in place it would bail (the
  // tokenizer reads `>` as an operator) or, worse, get re-quoted into a
  // literal argument.
  const { body, merged } = splitStderrMerge(command)
  for (const planner of PLANNERS) {
    const plan = planner(body)
    if (plan) return { kind: plan.kind, command: withStderrMerge(plan.command, merged) }
  }
  return null
}

/**
 * Whether a shared planner's rewrite can run unchanged in PowerShell.
 *
 * A rewrite that only appends flags - `git status --porcelain=v1 -b` - is the
 * same argument string in both shells. A rewrite that quotes is not: `'x'` is a
 * literal in PowerShell and a shell-quoted word in bash, a backtick escapes the
 * next character rather than running a substitution, `$name` is a variable, and
 * `[`/`?`/`*` are wildcards the planner never saw. Those are skipped, and the
 * command runs as written with no compression.
 */
export function psSafeRewrite(original: string, planned: string): boolean {
  if (planned === original.trim()) return true
  if (/['"`$(){}*?[\]]/.test(planned)) return false
  return planned.split(/\s+/)[0] === original.trim().split(/\s+/)[0]
}

// Every compressor is `(text, caps, command)`: the second argument is the
// family's own caps object, or `undefined` for the family defaults - never a
// bare number, never a re-run string buried in it - and the third is the command
// that ran, so an elision line can name the command to re-run tagged `# tk:raw`.
// `go-build` is the one exception: it elides nothing, so it takes text alone.
const COMPRESSORS: Record<string, (text: string, caps: Caps, command: string) => string> = {
  'git-status': (t, c, cmd) => compressGitStatus(t, c, cmd),
  'git-diff': (t, c, cmd) => compressGitDiff(t, c, cmd),
  'git-show': (t, _c, cmd) => compressGitShow(t, undefined, cmd),
  'git-log': (t, _c, cmd) => compressGitLog(t, undefined, cmd),
  grep: (t, c, cmd) => compressGrep(t, c, cmd),
  ls: (t, c, cmd) => compressLs(t, { maxEntries: c.maxDirEntries }, cmd),
  find: (t, c, cmd) => compressFind(t, { maxEntries: c.maxDirEntries }, cmd),
  'docker-ps': (t, _c, cmd) => compressTable(t, undefined, cmd),
  'kubectl-get': (t, _c, cmd) => compressTable(t, undefined, cmd),
  'kubectl-logs': (t, _c, cmd) => compressKubectlLogs(t, undefined, cmd),
  'flux-get': (t, _c, cmd) => compressFluxGet(t, undefined, cmd),
  'gh-run-view': (t, _c, cmd) => compressGhRunView(t, undefined, cmd),
  'gh-pr-checks': (t, _c, cmd) => compressGhPrChecks(t, {}, cmd),
  'gh-pr-view': (t, _c, cmd) => compressGhPrView(t, {}, cmd),
  rows: (t, _c, cmd) => compressRows(t, undefined, cmd),
  pytest: (t, _c, cmd) => compressPytest(t, undefined, cmd),
  vitest: (t, _c, cmd) => compressVitest(t, undefined, cmd),
  playwright: (t, _c, cmd) => compressPlaywright(t, undefined, cmd),
  'npm-install': (t, _c, cmd) => compressNpmInstall(t, undefined, cmd),
  // Both take the executed command so the elision hint re-runs the same
  // package selection instead of a generic `go test -v`.
  'cargo-test': (t, _c, cmd) => compressCargoTest(t, undefined, cmd),
  'go-test': (t, _c, cmd) => compressGoTest(t, undefined, cmd),
  'go-build': (t) => compressGoBuild(t),
  gh: (t, _c, cmd) => compressGh(t, {}, cmd),
  'dotnet-build': (t, c, cmd) => compressDotnet(t, { maxDiagLines: c.maxDiagLines }, cmd),
  'dotnet-test': (t, c, cmd) => compressDotnet(t, { maxDiagLines: c.maxDiagLines }, cmd),
  'ps-dir': (t, c, cmd) => compressPsDir(t, { maxEntries: c.maxDirEntries }, cmd),
  'ps-process': (t, c, cmd) => compressCmdlet(t, 'ps-process', { maxRows: c.maxCmdletRows }, cmd),
  'ps-service': (t, c, cmd) => compressCmdlet(t, 'ps-service', { maxRows: c.maxCmdletRows }, cmd),
  'ps-net': (t, c, cmd) => compressCmdlet(t, 'ps-net', { maxRows: c.maxCmdletRows }, cmd),
  'ps-command': (t, c, cmd) => compressCmdlet(t, 'ps-command', { maxRows: c.maxCmdletRows }, cmd),
  'ps-cim': (t, c, cmd) => compressCmdlet(t, 'ps-cim', { maxRows: c.maxCmdletRows }, cmd),
  'ps-module': (t, c, cmd) => compressCmdlet(t, 'ps-module', { maxRows: c.maxCmdletRows }, cmd),
  'ps-event': (t, c, cmd) => compressEvents(t, { maxRows: c.maxCmdletRows }, cmd),
  'ps-help': (t, c, cmd) => compressHelp(t, { maxHelpLines: c.maxCmdletRows }, cmd),
}

export const register: Register = (on, options) => {
  const opts = (options ?? {}) as Options
  const notify = opts.notify !== false
  const caps: Caps = readCaps(opts as unknown as Record<string, unknown>)

  // First, so a resumed session paints its saved total before any tool call.
  installStatus(on)

  // Platform gate: one memoized in-process env read, no spawn. `OS=Windows_NT`
  // is set in every NT-family process (native cmd, PowerShell, Git Bash, Cygwin)
  // and unset on Linux and macOS, so "not Windows" is treated as Linux. That is
  // safe because the compressors are format-driven with a never-inflate guard:
  // an unexpected platform's output fails to match and passes through unchanged.
  //
  // The sandbox forbids passing `$` to helpers, so each gate is inlined at its
  // call site over these memoized answers.
  let windows: boolean | null = null
  let linux: boolean | null = null

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = (e as { command?: unknown }).command
    if (typeof command !== 'string') return next(e)

    const plan = planAny(command)
    if (!plan) return next(e)

    // Gate after the plan: non-candidate commands never even read the env.
    if (linux === null) linux = (await $.env.get('OS')) !== 'Windows_NT'
    if (!linux) return next(e)

    const r = await next(plan.command === command ? e : { ...e, command: plan.command })

    const compress = COMPRESSORS[plan.kind]
    if (!compress) return r
    return (await finish($, r, plan.kind, notify, (text) => compress(text, caps, plan.command))) ?? r
  })
    .catch((_, e, next) => next(e))

  // PowerShell tool. `Get-ChildItem`, the cmdlet tables, `Get-WinEvent`,
  // `Get-Help` - and, when none of those match, the shell-agnostic compressors
  // below: `git status`, `git diff`, `kubectl logs` and `gh pr view` print the
  // same text whichever shell launched them, so a PowerShell session was
  // otherwise leaving the plugin's largest savings on the table.
  //
  // Only a plan whose rewrite means the same thing in PowerShell is taken from
  // the shared planners: no quotes, no backtick, no `$`, no glob characters.
  // `git status --porcelain=v1 -b` is one string in both shells; a planner that
  // re-quoted an argument is bash syntax and is skipped. Same safety rules as
  // the Bash side: refusal, error and interrupt pass through, and compression
  // applies only when it shrinks the output.
  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const command = (e as { command?: unknown }).command
    if (typeof command !== 'string') return next(e)

    const own = planPowerShell(command)
    const shared = own === null ? planAny(command) : null
    const plan = own ?? (shared !== null && psSafeRewrite(command, shared.command) ? shared : null)
    if (!plan) return next(e)

    // The ps-* parsers are written against cmdlet output as Windows prints it:
    // `Get-Service` and `Get-NetTCPConnection` do not exist elsewhere and
    // `Get-WinEvent` is an event-log cmdlet. A PowerShell tool on another
    // platform passes those through; the shell-agnostic kinds need no gate.
    if (plan.kind.startsWith('ps-')) {
      if (windows === null) windows = (await $.env.get('OS')) === 'Windows_NT'
      if (!windows) return next(e)
    }

    const r = await next(plan.command === command ? e : { ...e, command: plan.command })

    const compress = COMPRESSORS[plan.kind]
    if (!compress) return r
    return (await finish($, r, plan.kind, notify, (text) => compress(text, caps, plan.command))) ?? r
  })
    .catch((_, e, next) => next(e))
}
