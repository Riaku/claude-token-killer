// token-killer: one tool.call hook on Bash. Rewrites git status / git diff /
// recursive grep into compact forms on the way out, and compresses their
// stdout on the way back in - inside the Claude Code process, no external
// binary. Linux only for the PoC; every other platform is a no-op.
//
// Fail-open by design: a compressor that throws simply lets the original
// output through (the engine skips a throwing hook). Unlike a redactor, the
// worst case here is wasted tokens, never lost safety.

import type { Register } from 'claude-code'
import { DEFAULT_CAPS, compressGitDiff, compressGitStatus, compressGrep, type Caps } from './compress.ts'
import { planRewrite } from './plan.ts'

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
  }

  // The mod sandbox has no Node `process`, so the Linux gate is asked of the
  // engine itself at session start. Until `uname` answers Linux, every hook
  // is a pass-through - other platforms are untouched.
  let linux = false

  on('session.start', async ($, e, next) => {
    try {
      const probe = await $.process.run(['uname', '-s'])
      linux = probe.exitCode === 0 && probe.stdout.trim() === 'Linux'
    } catch {
      linux = false
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!linux) return next(e)

    const command = (e as { command?: unknown }).command
    if (typeof command !== 'string') return next(e)

    const plan = planRewrite(command)
    if (!plan) return next(e)

    const r = await next(plan.command === command ? e : { ...e, command: plan.command })

    // A refusal or a failed command: the model needs the real error, not a
    // compressed one.
    if (r.deny !== undefined || r.isError) return r

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
}
