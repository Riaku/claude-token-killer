// `gh pr checks` and `gh pr view` compression.
//
// `gh pr checks` prints one line per check, tab-separated:
//
//   test \t pass \t 18s \t https://github.com/o/r/actions/runs/123/job/456 \t
//
// The URL is ~90 bytes of the ~120-byte row and the only actionable part of it
// is the job id, which is what `gh run view --job <id> --log` wants. So the URL
// becomes `job:<id>` and everything else stays. A row that does not look like a
// check row is left alone.
//
// `gh pr view` is not a table: it prints a block of `key:\tvalue` lines, a `--`
// separator, then the body. The body is the only part that grows, so it is
// capped with an elision line; the metadata block and the first lines of the
// body always survive, because that is what the model asked for.

import { tokenize } from './plan.ts'
import { stripAnsi } from './ansi.ts'

export type GhPrPlan = { kind: 'gh-pr-checks' | 'gh-pr-view'; command: string }

// Same bail set as the other planners: one command, no shell composition.
const UNSAFE = /[|;&<>]|\$\(|\$\{|`|\r|\n|#/

// --json/--template/--jq produce a machine format; --web opens a browser.
const BAIL_FLAGS = new Set(['--json', '--web', '--help', '-h', '--template', '--jq'])

function base(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1)
}

/**
 * Plan `gh pr checks` or `gh pr view`. Compression-only.
 *
 * `gh pr checks --watch` and `--interval` bail: watching is a stream, and
 * anything else in that family is a mode we have not modelled.
 */
export function planGhPr(command: string): GhPrPlan | null {
  const raw = command.trim()
  if (!raw || UNSAFE.test(raw)) return null
  const tokens = tokenize(raw)
  if (!tokens || tokens.length < 3) return null
  if (base(tokens[0]) !== 'gh' || tokens[1] !== 'pr') return null

  const sub = tokens[2]
  if (sub !== 'checks' && sub !== 'view') return null

  for (const t of tokens.slice(3)) {
    if (!t.startsWith('-')) continue
    const flag = t.split('=')[0]
    if (BAIL_FLAGS.has(flag)) return null
    if (sub === 'checks' && (flag === '--watch' || flag === '--interval')) return null
  }
  return { kind: sub === 'checks' ? 'gh-pr-checks' : 'gh-pr-view', command: raw }
}

const JOB_URL = /\/job\/(\d+)/

/**
 * Compact `gh pr checks`: drop the URL to a job id, cap the row count.
 *
 * Rows that are not tab-separated (gh's TTY table, a "no checks" notice) are
 * kept verbatim, so an unrecognised shape costs nothing.
 */
export function compressGhPrChecks(text: string, caps: { maxItems?: number } = {}, command = 'gh pr checks'): string {
  const maxItems = caps.maxItems ?? 50
  const clean = stripAnsi(text).replace(/\r\n/g, '\n')
  const lines = clean.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return text

  const out: string[] = []
  let converted = 0
  for (const line of lines) {
    const f = line.split('\t')
    if (f.length < 4) {
      out.push(line.trimEnd())
      continue
    }
    // Trailing tab leaves an empty field; drop empties at the end.
    const cells = f.map((c) => c.trim())
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
    const url = cells[cells.length - 1] ?? ''
    const m = JOB_URL.exec(url)
    if (m) {
      cells[cells.length - 1] = `job:${m[1]}`
      converted += 1
    }
    out.push(cells.join('  '))
  }

  // Nothing was rewritten and nothing is over the cap: no gain, so hand back
  // the original bytes rather than a whitespace-normalised copy.
  if (converted === 0 && out.length <= maxItems) return text

  const kept = out.slice(0, maxItems)
  if (out.length > maxItems) {
    kept.push(`... +${out.length - maxItems} checks elided - raw: ${command} # tk:raw`)
  }
  const result = kept.join('\n')
  return result.length < text.length ? result : text
}

/**
 * Compact `gh pr view`: collapse blank runs and cap a long body.
 *
 * The metadata block and the first `maxBody` body lines survive verbatim; the
 * elision line names the re-run tagged `# tk:raw`.
 */
export function compressGhPrView(text: string, caps: { maxBody?: number } = {}, command = 'gh pr view'): string {
  const maxBody = caps.maxBody ?? 25
  const clean = stripAnsi(text).replace(/\r\n/g, '\n')
  const lines = clean.split('\n')

  // Collapse runs of 3+ blank lines to a single blank line.
  const collapsed: string[] = []
  let blanks = 0
  for (const line of lines) {
    if (line.trim() === '') {
      blanks += 1
      if (blanks > 1) continue
    } else {
      blanks = 0
    }
    collapsed.push(line)
  }

  const sep = collapsed.findIndex((l) => l.trim() === '--')
  if (sep < 0) {
    // No body separator: not the shape we model. Keep the blank-line collapse
    // only when it actually helped.
    const result = collapsed.join('\n').replace(/\n+$/, '')
    return result.length < text.length ? result : text
  }

  const head = collapsed.slice(0, sep + 1)
  const body = collapsed.slice(sep + 1).filter((l, i, a) => !(l.trim() === '' && i === a.length - 1))
  const out = body.length > maxBody
    ? [...head, ...body.slice(0, maxBody), `... +${body.length - maxBody} body lines elided - raw: ${command} # tk:raw`]
    : [...head, ...body]

  const result = out.join('\n')
  return result.length < text.length ? result : text
}
