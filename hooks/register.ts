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

import type { Register } from 'claude-code'
import { DEFAULT_CAPS, compressGitDiff, compressGitStatus, compressGrep, type Caps } from './compress.ts'
import { planRewrite, splitStderrMerge, withStderrMerge } from './plan.ts'
import { compressPsDir, planPowerShell } from './powershell.ts'
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

type Options = Partial<Caps> & { notify?: boolean }

/** Bytes saved before the toast is worth showing. */
const TOAST_MIN_BYTES = 200

type Finishable = { deny?: unknown; isError?: boolean; result?: unknown }

/**
 * The tail both handlers share once a command has run: pass through a refusal,
 * an error or an interrupt; take the text out of either result shape (a harness
 * may answer with a plain string); keep the compressed text only when it is
 * smaller, because a smaller wrong answer is worse than a larger right one;
 * then report the saving. Returns null when the original result must stand.
 */
function finish<T extends Finishable>(
  $: { ui: { toast: (message: string) => void } },
  r: T,
  kind: string,
  notify: boolean,
  compress: (text: string) => string,
): T | { result: string } | { result: { stdout: string } } | null {
  if (r.deny !== undefined || r.isError) return null
  const maybeInterrupted = r.result as { interrupted?: unknown } | undefined
  if (maybeInterrupted && typeof maybeInterrupted === 'object' && maybeInterrupted.interrupted === true) return null

  const res = r.result as { stdout?: unknown } | string | undefined
  const original = typeof res === 'string' ? res : res && typeof res.stdout === 'string' ? res.stdout : null
  if (original === null || original === '') return null

  const compressed = compress(original)
  if (compressed === original || compressed.length >= original.length) return null

  const saved = original.length - compressed.length
  const pct = Math.round((saved / original.length) * 100)
  if (notify && saved >= TOAST_MIN_BYTES) {
    try {
      $.ui.toast(`token-killer: ${kind} -${saved} bytes (${pct}%)`)
    } catch {
      // no UI: the compression still stands
    }
  }

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

// Every compressor is `(text, caps, command)`: the second argument is the
// family's own caps object (never a bare number, never a re-run string buried in
// it), and the third is the command that ran, so an elision line can name the
// command to re-run tagged `# tk:raw`. `go-build` is the one exception: it
// elides nothing, so it takes text alone.
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
}

export const register: Register = (on, options) => {
  const opts = (options ?? {}) as Options
  const notify = opts.notify !== false
  const caps: Caps = {
    maxStatusFiles: opts.maxStatusFiles ?? DEFAULT_CAPS.maxStatusFiles,
    maxDiffLinesPerFile: opts.maxDiffLinesPerFile ?? DEFAULT_CAPS.maxDiffLinesPerFile,
    maxDiffTotalLines: opts.maxDiffTotalLines ?? DEFAULT_CAPS.maxDiffTotalLines,
    maxGrepPerFile: opts.maxGrepPerFile ?? DEFAULT_CAPS.maxGrepPerFile,
    maxGrepTotal: opts.maxGrepTotal ?? DEFAULT_CAPS.maxGrepTotal,
    maxLineLen: opts.maxLineLen ?? DEFAULT_CAPS.maxLineLen,
    maxDirEntries: opts.maxDirEntries ?? DEFAULT_CAPS.maxDirEntries,
  }

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
    return finish($, r, plan.kind, notify, (text) => compress(text, caps, plan.command)) ?? r
  })
    .catch((_, e, next) => next(e))

  // PowerShell tool: Get-ChildItem only, on Windows only. A PowerShell tool
  // running on Linux is out of scope and passes through untouched. Same safety
  // rules as the Bash side: refusal, error and interrupt pass through, and
  // compression applies only when it shrinks the output.
  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const command = (e as { command?: unknown }).command
    if (typeof command !== 'string') return next(e)

    const plan = planPowerShell(command)
    if (!plan) return next(e)

    // Windows-only, decided by an env read: this path never spawns anything.
    if (windows === null) windows = (await $.env.get('OS')) === 'Windows_NT'
    if (!windows) return next(e)

    const r = await next(e)

    return finish($, r, 'ps-dir', notify, (text) => compressPsDir(text, { maxEntries: caps.maxDirEntries }, plan.command)) ?? r
  })
    .catch((_, e, next) => next(e))
}
