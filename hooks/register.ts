// token-killer: tool.call hooks that rewrite git status / git diff /
// recursive grep into compact forms on the way out, and compress their
// stdout on the way back in - inside the Claude Code process, no external
// binary. The Bash handler is Linux-only; the PowerShell handler
// (Get-ChildItem) is Windows-only. Everything else is a no-op.
//
// Fail-open by design: a compressor that throws simply lets the original
// output through (the engine skips a throwing hook). Unlike a redactor, the
// worst case here is wasted tokens, never lost safety.

import type { Register } from 'claude-code'
import { DEFAULT_CAPS, compressGitDiff, compressGitStatus, compressGrep, type Caps } from './compress.ts'
import { planRewrite } from './plan.ts'
import { compressPsDir, planPowerShell } from './powershell.ts'

type Options = Partial<Caps> & { notify?: boolean }

const COMPRESSORS: Record<string, (text: string, caps: Caps) => string> = {
  'git-status': compressGitStatus,
  'git-diff': compressGitDiff,
  grep: compressGrep,
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

  // Platform detection, zero-cost at session start (no probe hooks at all):
  //
  // - Windows answers `OS=Windows_NT` in every NT-family process env
  //   (native cmd/PowerShell, Git Bash/MSYS, Cygwin all pass it through;
  //   Linux/macOS leave it unset). An in-process env read - no spawn.
  // - Linux has no reliable env marker, so it needs `uname -s` - but the
  //   probe is lazy: paid at most once per session, and only when a
  //   rewrite candidate actually fires. Windows short-circuits on the
  //   env check and never spawns; non-candidate commands never probe.
  //
  // The sandbox forbids passing `$` to helpers, so each gate is inlined
  // at its call site over these memoized answers.
  let windows: boolean | null = null
  let linux: boolean | null = null

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = (e as { command?: unknown }).command
    if (typeof command !== 'string') return next(e)

    const plan = planRewrite(command)
    if (!plan) return next(e)

    // Gate after the plan: commands that are not rewrite candidates never
    // pay for platform detection, and Windows never reaches the spawn.
    if (linux === null) {
      if ((await $.env.get('OS')) === 'Windows_NT') {
        linux = false
      } else {
        try {
          const probe = await $.process.run(['uname', '-s'])
          linux = probe.exitCode === 0 && probe.stdout.trim() === 'Linux'
        } catch {
          linux = false
        }
      }
    }
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

    const compressed = COMPRESSORS[plan.kind](original, caps)

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
