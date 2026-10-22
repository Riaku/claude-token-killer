// pytest output: compression-only support.
//
// The planner recognizes `pytest`, `py.test`, `python -m pytest` and
// `python3 -m pytest` but never rewrites the command - pytest's flag
// surface (custom plugins, ini files) makes rewriting risky, and the token
// win is entirely in the stdout: progress dot-lines, `===...===` banner
// decoration, and multi-hundred-line traceback blocks. The compressor
// keeps what matters: the FAILED/ERROR short-summary lines, capped failure
// detail blocks, the warnings summary (capped), and a compact final counts
// line.
//
// Safety mirrors the rest of the mod: the planner bails on shell control
// syntax (reusing tokenize() from ./plan.ts) and on any flag where the
// user explicitly wants live or full output (-s, --capture=no, --pdb,
// --trace) or a machine-readable format (--json). The compressor returns
// the input unchanged when the text has no test-run shape, and never
// inflates.

import { tokenize } from './plan.ts'
import { stripAnsi } from './ansi.ts'
import { UNSAFE, basename } from './shell.ts'

export type PytestPlan = { kind: 'pytest'; command: string }

export type PytestCaps = {
  /** kept failure/error detail blocks before the rest are elided. */
  maxFailures: number
  /** kept lines inside each failure block (the `___ name ___` header is always kept). */
  maxLinesPerBlock: number
  /** kept lines of the `=== warnings summary ===` section. */
  maxWarningLines: number
}

export const DEFAULT_PYTEST_CAPS: PytestCaps = {
  maxFailures: 10,
  maxLinesPerBlock: 30,
  maxWarningLines: 15,
}

/** Re-run command quoted in elision markers; the planner hands it to us. */
export const PYTEST_RERUN = 'pytest'

// Short flags that swallow the rest of the bundle as their value: everything
// after one of these is an argument, not another flag (`-rs` is `-r s`, not
// `-r -s`).
const TAKES_ARGUMENT = new Set(['k', 'm', 'p', 'o', 'c', 'W', 'r', 'n', 'l', 'a'])

/** Decide whether a raw command is a compressible pytest run. */
export function planPytest(command: string): PytestPlan | null {
  const cmd = command.trim()
  if (!cmd) return null
  if (UNSAFE.test(cmd)) return null
  const tokens = tokenize(cmd)
  if (!tokens || tokens.length === 0) return null

  const head = basename(tokens[0])
  let flagStart = -1
  if (head === 'pytest' || head === 'py.test') {
    flagStart = 1
  } else if ((head === 'python' || head === 'python3') && tokens[1] === '-m' && tokens[2] === 'pytest') {
    flagStart = 3
  }
  if (flagStart === -1) return null

  for (let i = flagStart; i < tokens.length; i += 1) {
    const t = tokens[i]
    const name = t.split('=')[0]
    // Live/full-output flags: the user asked to see everything.
    if (t === '--capture=no') return null
    if (t === '--capture' && tokens[i + 1] === 'no') return null
    if (t === '--pdb' || t === '--pdbcls' || t === '--trace') return null
    if (/^-[A-Za-z]+$/.test(t)) {
      for (const ch of t.slice(1)) {
        if (ch === 's') return null // -s, -vs, -qs: capture off
        if (TAKES_ARGUMENT.has(ch)) break // the rest is this flag's value
      }
    }
    // Machine-readable formats our compressor would mangle.
    if (name === '--json' || name === '--json-report' || name === '--junit-xml') return null
    // Listing modes: the output is the list, so a summary keeps nothing useful.
    if (t === '--co' || t === '--collect-only' || t === '--fixtures' || t === '--markers') return null
    if (t === '--setup-plan' || t === '--setup-show') return null
    if (t === '--help' || t === '-h' || t === '--version') return null
  }
  return { kind: 'pytest', command: cmd }
}

/** `====== short test summary info ======` style banner -> its title. */
function bannerTitle(line: string): string | null {
  const m = /^(=+)\s*(\S.*?)\s*(=+)$/.exec(line)
  if (m && m[2]) return m[2]
  return null
}

/** Pull `N passed, M failed, ...` out of a banner or a quiet-mode tail line. */
function renderCounts(title: string): string | null {
  const grab = (word: string): number => {
    const m = new RegExp(`(\\d+) ${word}`).exec(title)
    return m ? Number(m[1]) : 0
  }
  const parts: string[] = []
  const passed = grab('passed')
  const failed = grab('failed')
  const errors = grab('error')
  const skipped = grab('skipped')
  const xfailed = grab('xfailed')
  const xpassed = grab('xpassed')
  if (passed) parts.push(`${passed} passed`)
  if (failed) parts.push(`${failed} failed`)
  if (errors) parts.push(`${errors} errors`)
  if (skipped) parts.push(`${skipped} skipped`)
  if (xfailed) parts.push(`${xfailed} xfailed`)
  if (xpassed) parts.push(`${xpassed} xpassed`)
  if (parts.length === 0) {
    if (/no tests ran/.test(title)) return 'no tests ran'
    return null
  }
  return parts.join(', ')
}

type Block = { header: string; body: string[] }

function elision(hidden: number, what: string, command: string): string {
  return `... +${hidden} ${what}${hidden === 1 ? '' : 's'} elided - raw: ${command} # tk:raw`
}

/**
 * Compress pytest stdout: drop the dot-line progress, banner decoration and
 * per-run metadata; keep failure detail blocks (capped), the FAILED/ERROR
 * short-summary lines, warnings (capped) and a compact counts line.
 *
 * Unrecognized text (no session-start banner, no counts, no summary) is
 * returned unchanged so the caller's never-inflate check passes it by.
 * `command` only changes the command quoted in elision markers.
 */
export function compressPytest(
  text: string,
  caps: PytestCaps = DEFAULT_PYTEST_CAPS,
  command: string = PYTEST_RERUN,
): string {
  const lines = stripAnsi(text).split(/\r\n|\r|\n/)

  let sawShape = false
  let section: 'start' | 'progress' | 'fail' | 'summary' | 'warn' | 'other' = 'start'
  const blocks: Block[] = []
  let cur: Block | null = null
  const summary: string[] = []
  const warnings: string[] = []
  let counts: string | null = null
  let collected: string | null = null

  for (const line of lines) {
    const t = line.trim()
    const banner = bannerTitle(t)
    if (banner !== null) {
      const lower = banner.toLowerCase()
      if (lower === 'test session starts') {
        sawShape = true
        section = 'progress'
      } else if (lower === 'failures' || lower === 'errors') {
        sawShape = true
        section = 'fail'
        cur = null
      } else if (lower === 'short test summary info' || lower === 'short test summary') {
        sawShape = true
        section = 'summary'
      } else if (lower === 'warnings summary' || lower === 'warnings') {
        sawShape = true
        section = 'warn'
      } else {
        const c = renderCounts(lower)
        if (c) {
          counts = c
          sawShape = true
          section = 'other'
        } else {
          section = 'other'
        }
      }
      continue
    }
    if (!t) continue

    if (section === 'fail') {
      // `___ test_name ___` / `___ ERROR at setup of test_x ___` open a block.
      if (/^_+ .* _+$/.test(t)) {
        cur = { header: t, body: [] }
        blocks.push(cur)
      } else {
        if (!cur) {
          cur = { header: '', body: [] }
          blocks.push(cur)
        }
        // Keep indentation: a traceback without it is unreadable.
        cur.body.push(line.replace(/\s+$/, ''))
      }
      continue
    }
    if (section === 'summary') {
      if (/^(FAILED|ERROR)\s/.test(t)) {
        summary.push(t)
        continue
      }
      // pytest 9 ends the run with a bare `2 failed, 43 passed in 0.02s`
      // after the short-summary section instead of a `===` banner. Dropping
      // that line drops the totals, which is the one line a failing run is
      // read for.
      const bare = renderCounts(t)
      if (bare) counts = bare
      continue
    }
    if (section === 'warn') {
      warnings.push(t)
      continue
    }
    // start / progress: drop the progress echo (`....F..`, verbose
    // `test_x PASSED [ 14%]`, `tests/x.py ....F..  [ 85%]`) and the
    // per-run metadata. `collected N items` is the one line worth keeping.
    if (/\[\s*\d+%\]$/.test(t)) continue
    if (/^[.FsxX]+$/.test(t)) continue
    if (/^collected \d+ items?/.test(t)) {
      collected = t
      continue
    }
    // Quiet mode has no banners: `1 failed, 6 passed in 0.12s` is the shape.
    if (/\bin\b.*s\b/.test(t)) {
      const c = renderCounts(t)
      if (c) {
        counts = c
        sawShape = true
      }
    }
  }

  if (!sawShape) return text

  const out: string[] = []
  if (collected) out.push(collected)

  const failureCap = Math.max(0, caps.maxFailures)
  const shown = blocks.slice(0, failureCap)
  for (const block of shown) {
    if (block.header) out.push(block.header)
    const keep = Math.max(0, caps.maxLinesPerBlock)
    if (block.body.length > keep) {
      out.push(...block.body.slice(0, keep))
      out.push(elision(block.body.length - keep, 'line', command))
    } else {
      out.push(...block.body)
    }
  }
  if (blocks.length > shown.length) out.push(elision(blocks.length - shown.length, 'failure block', command))

  if (warnings.length > 0) {
    const keep = Math.max(0, caps.maxWarningLines)
    out.push(...warnings.slice(0, keep))
    if (warnings.length > keep) out.push(elision(warnings.length - keep, 'warning line', command))
  }
  if (summary.length > 0) out.push(...summary)
  if (counts) out.push(counts)

  if (out.length === 0) return text
  const compressed = out.join('\n')
  if (compressed.length >= text.length) return text
  return compressed
}
