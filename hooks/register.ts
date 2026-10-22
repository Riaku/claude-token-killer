// token-killer: tool.call hooks that rewrite token-hungry commands into
// compact forms on the way out, and compress their stdout on the way back
// in - inside the Claude Code process, no external binary. The Bash handler
// runs everywhere except Windows (non-Windows is treated as Linux); the
// PowerShell handler (Get-ChildItem) is Windows-only. Everything else is a
// no-op.
//
// Coverage: git status / diff / show / log, recursive grep (plus rg and
// git grep), ls, find, docker ps, kubectl get (+ -o wide), kubectl logs,
// kubectl exec -- ls -l, flux get, pytest, vitest, playwright test,
// npm|pnpm install, cargo test, go test, go build|vet, gh pr|issue|run list,
// gh run view --log, gh pr checks/view, and the ps|df|free|kubectl top|
// docker images listings.
//
// A trailing `2>&1` is understood: it is split off the command tail, planned
// without it, and re-appended verbatim after any added flags.
//
// Fail-open by design: a compressor that throws simply lets the original
// output through (the engine skips a throwing hook). Unlike a redactor, the
// worst case here is wasted tokens, never lost safety.

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

// The `command` is handed to compressors that quote a re-run hint (`# tk:raw`)
// so the elision line names the command the model actually ran.
const COMPRESSORS: Record<string, (text: string, caps: Caps, command: string) => string> = {
  'git-status': (t, c) => compressGitStatus(t, c),
  'git-diff': (t, c) => compressGitDiff(t, c),
  'git-show': (t) => compressGitShow(t),
  'git-log': (t, _c, cmd) => compressGitLog(t, { maxEntries: 50, rerun: cmd }),
  grep: (t, c) => compressGrep(t, c),
  ls: (t, c, cmd) => compressLs(t, { maxEntries: c.maxDirEntries }, cmd),
  find: (t, c, cmd) => compressFind(t, { maxEntries: c.maxDirEntries }, cmd),
  'docker-ps': (t, _c, cmd) => compressTable(t, undefined, cmd),
  'kubectl-get': (t, _c, cmd) => compressTable(t, undefined, cmd),
  'kubectl-logs': (t, _c, cmd) => compressKubectlLogs(t, undefined, cmd),
  'flux-get': (t, _c, cmd) => compressFluxGet(t, undefined, cmd),
  'gh-run-view': (t, _c, cmd) => compressGhRunView(t, undefined, cmd),
  'gh-pr-checks': (t, _c) => compressGhPrChecks(t),
  'gh-pr-view': (t, _c) => compressGhPrView(t),
  rows: (t, _c, cmd) => compressRows(t, undefined, cmd),
  pytest: (t, _c, cmd) => compressPytest(t, undefined, cmd),
  vitest: (t, _c, cmd) => compressVitest(t, undefined, cmd),
  playwright: (t, _c, cmd) => compressPlaywright(t, undefined, cmd),
  'npm-install': (t, _c, cmd) => compressNpmInstall(t, undefined, cmd),
  'cargo-test': (t) => compressCargoTest(t),
  'go-test': (t) => compressGoTest(t),
  'go-build': (t, _c, cmd) => compressGoBuild(t, undefined, cmd),
  gh: (t) => compressGh(t),
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

  // Platform detection, zero-spawn everywhere:
  //
  // Windows answers `OS=Windows_NT` in every NT-family process env
  // (native cmd/PowerShell, Git Bash/MSYS, Cygwin all pass it through;
  // Linux/macOS leave it unset). That single in-process env read is the
  // whole gate: NOT Windows is treated as Linux. This is safe because the
  // compressors are format-driven with a never-inflate guard, and git
  // porcelain / grep output is platform-identical - an unexpected
  // platform's output simply fails to match and passes through unchanged.
  // No `uname`, no `cmd.exe`, no spawn on any path.
  //
  // The sandbox forbids passing `$` to helpers, so each gate is inlined
  // at its call site over these memoized answers.
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

    // A refusal, a failed command, or an interrupted one: the model needs
    // the real output, not a compressed one.
    if (r.deny !== undefined || r.isError) return r
    const maybeInterrupted = r.result as { interrupted?: unknown } | undefined
    if (maybeInterrupted && typeof maybeInterrupted === 'object' && maybeInterrupted.interrupted === true) return r

    // The Bash result is { stdout, stderr, interrupted, ... }; a test harness
    // below us may answer with a plain string. Handle both shapes.
    const res = r.result as { stdout?: unknown } | string | undefined
    const original =
      typeof res === 'string' ? res : res && typeof res.stdout === 'string' ? res.stdout : null
    if (original === null || original === '') return r

    const compress = COMPRESSORS[plan.kind]
    if (!compress) return r
    const compressed = compress(original, caps, plan.command)

    // Never trade a smaller answer for a wrong one: only replace when the
    // compressor actually shrank the text.
    if (compressed === original || compressed.length >= original.length) return r

    const saved = original.length - compressed.length
    const pct = Math.round((saved / original.length) * 100)
    if (notify && saved >= 200) {
      try {
        $.ui.toast(`token-killer: ${plan.kind} -${saved} bytes (${pct}%)`)
      } catch {
        // no UI: the compression still stands
      }
    }

    if (typeof res === 'string') return { result: compressed }
    return { result: { ...(res as object), stdout: compressed } }
  })
    // Fail-open: if this hook throws or overruns its budget, replay the
    // dispatch unchanged (next(e) replays the run if it already happened,
    // or runs the original command if not). Worst case is wasted tokens.
    .catch(($, e, next) => next(e))

  // PoC: PowerShell tool, Get-ChildItem only. Windows only, by explicit
  // choice: PowerShell running on Linux (opt-in flag) is out of scope and
  // passes through untouched. Same safety rules as the Bash side: refusal
  // / error / interrupted pass through, and compression is only applied
  // when it actually shrinks the output.
  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const command = (e as { command?: unknown }).command
    if (typeof command !== 'string') return next(e)

    const plan = planPowerShell(command)
    if (!plan) return next(e)

    // Windows-only, decided by an env read: this path never spawns anything.
    if (windows === null) windows = (await $.env.get('OS')) === 'Windows_NT'
    if (!windows) return next(e)

    const r = await next(e)

    if (r.deny !== undefined || r.isError) return r
    const maybeInterrupted = r.result as { interrupted?: unknown } | undefined
    if (maybeInterrupted && typeof maybeInterrupted === 'object' && maybeInterrupted.interrupted === true) return r

    const res = r.result as { stdout?: unknown } | string | undefined
    const original =
      typeof res === 'string' ? res : res && typeof res.stdout === 'string' ? res.stdout : null
    if (original === null || original === '') return r

    const compressed = compressPsDir(original, caps.maxDirEntries)
    if (compressed === original || compressed.length >= original.length) return r

    const saved = original.length - compressed.length
    const pct = Math.round((saved / original.length) * 100)
    if (notify && saved >= 200) {
      try {
        $.ui.toast(`token-killer: ps-dir -${saved} bytes (${pct}%)`)
      } catch {
        // no UI: the compression still stands
      }
    }

    if (typeof res === 'string') return { result: compressed }
    return { result: { ...(res as object), stdout: compressed } }
  })
    .catch(($, e, next) => next(e))
}
