// Playwright test output: compression-only support.
//
// Same shape of problem as vitest: the list reporter prints one line per test,
// a progress line per worker tick, and a failure block per failure. The useful
// information is which tests failed, why, and the final counts.
//
// So: keep result lines, keep failure blocks (capped), fold the summary counts
// onto one line, and drop the per-worker progress noise. Anything unrecognized
// is preserved, and `--reporter`/`--ui`/`--debug` bail because they change the
// format out from under the parser.

import { tokenize } from './plan.ts'

export type PlaywrightPlan = { kind: 'playwright'; command: string }

const UNSAFE = /[|;&<>]|\$\(|\$\{|`|\r|\n|#/

const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g

/** Runners that can prefix `playwright test`. */
const RUNNERS = new Set(['npx', 'pnpm', 'yarn', 'bun', 'bunx'])

function basename(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1)
}

/**
 * Plan a Playwright run: `playwright test`, `npx playwright test`,
 * `pnpm exec playwright test`, and friends. Compression-only.
 */
export function planPlaywright(command: string): PlaywrightPlan | null {
  const cmd = command.trim()
  if (!cmd) return null
  if (UNSAFE.test(cmd)) return null
  const tokens = tokenize(cmd)
  if (!tokens || tokens.length < 2) return null

  const head = basename(tokens[0])
  let at: number
  if (head === 'playwright') {
    if (tokens[1] !== 'test') return null
    at = 2
  } else if (RUNNERS.has(head)) {
    // `pnpm exec playwright test` / `yarn playwright test`
    let i = 1
    if (tokens[i] === 'exec' || tokens[i] === 'dlx' || tokens[i] === 'run') i += 1
    if (tokens[i] !== 'playwright' || tokens[i + 1] !== 'test') return null
    at = i + 2
  } else {
    return null
  }

  for (let i = at; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (t === '-h' || t === '--help' || t === '--version') return null
    // These replace the reporter or open an interactive loop.
    if (t === '--reporter' || t === '--reporter=' || t.startsWith('--reporter=')) return null
    if (t === '--ui' || t === '--debug' || t === '--headed' || t === '--trace') return null
  }
  return { kind: 'playwright', command: cmd }
}

export type PlaywrightCaps = {
  /** failure blocks kept before the rest are elided. */
  maxFailures: number
  /** lines kept from each failure block. */
  maxLinesPerFailure: number
  /** separate lines of the summary before they are folded. */
  maxSummaryLines: number
}

export const DEFAULT_PLAYWRIGHT_CAPS: PlaywrightCaps = {
  maxFailures: 10,
  maxLinesPerFailure: 30,
  maxSummaryLines: 4,
}

/** `12 passed (3.4s)`, `1 failed`, `2 skipped`, `1 flaky`. */
const SUMMARY = /^(\d+)\s+(passed|failed|skipped|flaky|did not run|interrupted)\b/

/** `✓  1 [chromium] › tests/a.spec.ts:3:1 › does a thing (12ms)` */
const RESULT = /^\s*([\u2713\u2714\u2717\u2718\u00d7\u00b7-])\s+\d+\s+\[/

/** `  1) [chromium] › tests/a.spec.ts:5:1 › does a thing ─────` */
const FAILURE_START = /^\s*\d+\)\s+\S/

const NOISE =
  /^(?:Running \d+ tests? using \d+ workers?|Using config|Slow test(?: file)?|\[[\d/]+\]|\u2500{3,}|-{3,}|\.{3,})/

export function compressPlaywright(
  text: string,
  caps: PlaywrightCaps = DEFAULT_PLAYWRIGHT_CAPS,
  rerun: string = 'npx playwright test',
): string {
  const lines = text.replace(ANSI, '').split(/\r\n|\r|\n/)
  const out: string[] = []
  const summary: string[] = []
  let failuresKept = 0
  let inFailure = false
  let failureLines = 0
  let elidedFailures = 0
  let sawShape = false

  const closeFailure = (): void => {
    inFailure = false
    failureLines = 0
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (trimmed === '') {
      // Blank lines inside a failure block are part of the block; elsewhere
      // they are decoration.
      if (!inFailure) continue
      if (failureLines < caps.maxLinesPerFailure) {
        failureLines += 1
        out.push('')
      }
      continue
    }

    const sum = SUMMARY.exec(trimmed)
    if (sum !== null) {
      sawShape = true
      closeFailure()
      const part = `${sum[1]} ${sum[2]}`
      if (!summary.includes(part)) summary.push(part)
      continue
    }

    if (RESULT.test(trimmed)) {
      sawShape = true
      closeFailure()
      out.push(trimmed)
      continue
    }

    if (FAILURE_START.test(trimmed)) {
      sawShape = true
      closeFailure()
      if (failuresKept >= caps.maxFailures) {
        elidedFailures += 1
        inFailure = true // swallow the body of the block we are not keeping
        continue
      }
      failuresKept += 1
      inFailure = true
      failureLines = 1
      out.push(trimmed)
      continue
    }

    // Runner chatter ends a failure block and is never worth keeping.
    if (NOISE.test(trimmed)) {
      closeFailure()
      continue
    }

    if (inFailure) {
      if (failureLines >= caps.maxLinesPerFailure) continue
      failureLines += 1
      out.push(line)
      continue
    }

    out.push(line)
  }

  if (!sawShape) return text

  if (elidedFailures > 0) {
    out.push(`... +${elidedFailures} more failures - raw: ${rerun} # tk:raw`)
  }
  if (summary.length > 0) {
    const parts = summary.slice(0, caps.maxSummaryLines)
    const dropped = summary.slice(caps.maxSummaryLines)
    out.push(dropped.length > 0 ? `${parts.join(' · ')} · ${dropped.join(' · ')}` : parts.join(' · '))
  }

  const joined = out.join('\n')
  return joined.length >= text.length ? text : joined
}
