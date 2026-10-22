// vitest output: compression-only support.
//
// The planner recognizes vitest launched bare or through npx/pnpm/yarn/
// bunx, and never rewrites the command - like pytest, the win is in the
// stdout: progress bars, spinners, the RUN banner, and long failure
// tracebacks. The compressor keeps the per-file result lines (already
// one compact line each), capped failure blocks, `stdout |`/`stderr |`
// capture blocks, and the final `Test Files ... Tests ...` block rendered
// down to one line.
//
// Safety mirrors the rest of the mod: bail on shell control syntax
// (tokenize from ./plan.ts) and on flags where the user chose their own
// output (--reporter, --ui) or wants help. Unrecognized text passes
// through unchanged; the compressor never inflates.

import { tokenize } from './plan.ts'
import { stripAnsi } from './ansi.ts'

export type VitestPlan = { kind: 'vitest'; command: string }

const UNSAFE = /[|;&<>]|\$\(|\$\{|`|\r|\n|#/

// CSI colour/cursor sequences plus the OSC form.

// Braille spinner glyphs (ora/cli-cursor) and block-drawing progress bars.
const SPINNER = /[\u2800-\u28FF]/
const PROGRESS = /[\u2588\u2584\u2585\u2586\u2587\u2581\u2582\u2583\u258D\u258E\u258F]/

// `❯` is vitest's "this file has failures" marker, `↓` skipped, `↺` retried.
const RESULT_LINE = /^[✓√✗×❯↓↺]\s+\S/
const FILE_RESULT = /^[✓√✗×❯↓]\s+\S.*\(\d+ tests?(?: \| \d+ (?:failed|skipped|todo))?\)/
const FAIL_START = /^(?:FAIL|✗|×|❯)\s+\S/
const RUN_BANNER = /^(?:RUN|START)\s+v?\d[\w.]*/
const FAILURES_BANNER = /^[⎯─═|]{3,}.*(?:Failed Tests|Unhandled Errors|Failed Suites|Failed Files)/
// Pure separator rows (`⎯⎯⎯`, `___`); intentionally excludes `-`/`.`/`|`
// so a `---` or `...` line inside a diff excerpt is not eaten.
const DECORATION = /^[⎯─═_]{3,}$/

export type VitestCaps = {
  /** kept failure blocks before the rest are elided. */
  maxFailures: number
  /** kept lines inside each block (the `FAIL ...` header is always kept). */
  maxLinesPerBlock: number
}

export const DEFAULT_VITEST_CAPS: VitestCaps = {
  maxFailures: 10,
  maxLinesPerBlock: 30,
}

/** Re-run command quoted in elision markers; the planner hands it to us. */
export const VITEST_RERUN = 'vitest run'

function basename(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1)
}

const RUNNERS = new Set(['npx', 'pnpm', 'yarn', 'bun', 'bunx'])

/** Decide whether a raw command is a compressible vitest run. */
export function planVitest(command: string): VitestPlan | null {
  const cmd = command.trim()
  if (!cmd) return null
  if (UNSAFE.test(cmd)) return null
  const tokens = tokenize(cmd)
  if (!tokens || tokens.length === 0) return null

  const head = basename(tokens[0])
  let argStart = -1
  if (head === 'vitest') {
    argStart = 1
  } else if (RUNNERS.has(head) && tokens[1] === 'vitest') {
    argStart = 2
  }
  if (argStart === -1) return null

  for (const t of tokens.slice(argStart)) {
    const name = t.split('=')[0]
    // The user picked their own output format or UI: do not fight it.
    if (name === '--reporter' || name === '--reporters' || name === '--ui') return null
    if (t === '--help' || t === '-h' || t === '--version') return null
  }
  return { kind: 'vitest', command: cmd }
}

type Block = { header: string; body: string[]; failure: boolean }
type Seg = string | Block

function elision(hidden: number, what: string, rerun: string): string {
  return `... +${hidden} ${what}${hidden === 1 ? '' : 's'} elided - raw: ${rerun} # tk:raw`
}

/**
 * Compress vitest stdout: strip the RUN banner, progress bars, spinners and
 * blank decoration; keep per-file result lines, capped failure blocks,
 * captured stdout/stderr, and a one-line final summary.
 *
 * Text with no vitest shape is returned unchanged. `rerun` only changes the
 * command quoted in elision markers.
 */
export function compressVitest(text: string, caps: VitestCaps = DEFAULT_VITEST_CAPS, rerun: string = VITEST_RERUN): string {
  const lines = stripAnsi(text).split(/\r\n|\r|\n/)

  const segs: Seg[] = []
  const summaryParts: string[] = []
  let open: Block | null = null
  let inFailures = false
  let sawShape = false

  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    if (SPINNER.test(t) || PROGRESS.test(t)) continue
    if (RUN_BANNER.test(t)) {
      sawShape = true
      open = null
      continue
    }
    if (FAILURES_BANNER.test(t)) {
      sawShape = true
      inFailures = true
      open = null
      continue
    }

    if (/^(?:Test Files|Tests|Duration)\s{1,}\d/.test(t)) {
      summaryParts.push(t.replace(/\s{2,}/g, ' ').replace(/\s*\(transform.*$/, '').trim())
      sawShape = true
      open = null
      continue
    }
    if (/^Start at\s/.test(t)) continue

    // `stdout | tests/a.test.ts > name` (or stderr) plus the lines it
    // captured: user output, so it is kept - capped, never dropped.
    if (/^(?:stdout|stderr) \|/.test(t)) {
      const block: Block = { header: t, body: [], failure: false }
      segs.push(block)
      open = block
      continue
    }

    if (inFailures) {
      if (DECORATION.test(t)) continue // `⎯⎯⎯` separator between blocks
      if (FAIL_START.test(t)) {
        const block: Block = { header: t, body: [], failure: true }
        segs.push(block)
        open = block
      } else {
        const block: Block = open !== null && open.failure ? open : { header: '', body: [], failure: true }
        if (block !== open) segs.push(block)
        open = block
        // Keep the indentation of stack frames and code excerpts.
        block.body.push(line.replace(/\s+$/, ''))
      }
      continue
    }

    if (RESULT_LINE.test(t)) {
      segs.push(t)
      sawShape = true
      open = null
      continue
    }
    if (DECORATION.test(t)) continue

    // Unknown line outside the failure section (a vite startup error, an
    // unexpected warning): keep it rather than lose a real message.
    segs.push(t)
    open = null
  }

  if (!sawShape) return text

  const out: string[] = []
  const failureCap = Math.max(0, caps.maxFailures)
  let failureShown = 0
  let failureTotal = 0
  const kept: Seg[] = []
  for (const seg of segs) {
    if (typeof seg === 'string') {
      kept.push(seg)
      continue
    }
    if (seg.failure) failureTotal += 1
    if (seg.failure && failureShown >= failureCap) continue
    if (seg.failure) failureShown += 1
    kept.push(seg)
  }
  if (failureTotal > failureShown) {
    // The summary still names the counts, so nothing is lost blind.
    kept.push(elision(failureTotal - failureShown, 'failure block', rerun))
  }

  for (const seg of kept) {
    if (typeof seg === 'string') {
      out.push(seg)
      continue
    }
    if (seg.header) out.push(seg.header)
    const limit = Math.max(0, caps.maxLinesPerBlock)
    if (seg.body.length > limit) {
      out.push(...seg.body.slice(0, limit))
      out.push(elision(seg.body.length - limit, 'line', rerun))
    } else {
      out.push(...seg.body)
    }
  }
  if (summaryParts.length > 0) out.push(summaryParts.join(' · '))

  if (out.length === 0) return text
  const compressed = out.join('\n')
  if (compressed.length >= text.length) return text
  return compressed
}
