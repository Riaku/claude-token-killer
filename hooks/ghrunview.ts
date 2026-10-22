// `gh run view --log` / `--log-failed` compression.
//
// The shape is one line per log line, tab-separated:
//
//   <job> \t <step> \t 2026-01-02T03:04:05.1234567Z <message>
//
// with a BOM on the very first line. Most of a CI log is not information: an
// RFC3339 timestamp on every line, the runner preamble ("##[group]Initializing
// the repository", the image provisioner banner), and checkout chatter. A
// 593-line job is 64 KB of output for a few KB of signal.
//
// So the compressor keeps the structure the model actually needs - which job,
// which step, and what each step printed - and drops the rest:
//
//   1. timestamps, BOM, and `##[group]` / `##[endgroup]` section markers go;
//   2. identical consecutive messages collapse to `msg  xN` (retry loops);
//   3. past a per-step cap the middle is elided, keeping the head, the tail and
//      every error/warning line.
//
// Anything that is not tab-separated (a plain `gh run view` summary, --json
// output, an error message) is returned unchanged: a half-understood log is
// worse than a verbose one.

import { tokenize } from './plan.ts'
import { stripAnsi } from './ansi.ts'
import { UNSAFE } from './shell.ts'

export type GhRunViewPlan = { kind: 'gh-run-view'; command: string }

// --json/--template/--jq produce a machine format, --web opens a browser,
// --comments pulls in the PR body of a run, -h/--help prints usage.
const BAIL_FLAGS = new Set(['--json', '--web', '--help', '-h', '--template', '--jq', '--comments'])

function base(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1)
}

/**
 * Plan a `gh run view` call. Compression-only: the command is never rewritten.
 */
export function planGhRunView(command: string): GhRunViewPlan | null {
  const raw = command.trim()
  if (!raw || UNSAFE.test(raw)) return null
  const tokens = tokenize(raw)
  if (!tokens || tokens.length < 3) return null
  if (base(tokens[0]) !== 'gh' || tokens[1] !== 'run' || tokens[2] !== 'view') return null

  for (const t of tokens.slice(3)) {
    if (!t.startsWith('-')) continue
    if (BAIL_FLAGS.has(t.split('=')[0])) return null
    // These flags do not change the shape, with or without a value; an unknown
    // flag might.
    if (/^--(?:log|log-failed|attempt|job|verbose)(?:=|$)/.test(t)) continue
    return null
  }
  return { kind: 'gh-run-view', command: raw }
}

export type GhRunViewCaps = {
  /** log lines kept per step before the middle is elided. */
  maxLinesPerStep: number
  /** steps kept in full before later steps are summarised. */
  maxSteps: number
  /** error/warn lines rescued from the elided middle of a step. */
  maxProtected: number
}

export const DEFAULT_GH_RUN_VIEW_CAPS: GhRunViewCaps = {
  maxLinesPerStep: 30,
  maxSteps: 40,
  maxProtected: 8,
}

// Leading timestamp (and the BOM that rides on the first line of the log).
const STAMP = /^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/

// Runner section markers: pure structure, no content.
const NOISE = /^##\[(?:group|endgroup|command|debug|section)\]/

const PROTECTED =
  /\b(?:error|err|warn|warning|panic|fatal|critical|exception|traceback|failed|failure|refused|denied|timeout|oom|exit code)\b|##\[(?:error|warning)\]/i

type Entry = { job: string; step: string; msg: string }

/**
 * Compress a `gh run view --log` dump into one block per job/step.
 *
 * Returns the input unchanged when the text is not tab-structured, when there
 * is nothing to gain, or when the result would not be smaller.
 */
export function compressGhRunView(
  text: string,
  caps: GhRunViewCaps = DEFAULT_GH_RUN_VIEW_CAPS,
  rerun: string = 'gh run view',
): string {
  const clean = stripAnsi(text)
  const lines = clean.split(/\r\n|\r|\n/)

  const entries: Entry[] = []
  let tabbed = 0
  let total = 0
  for (const line of lines) {
    if (line.trim() === '') continue
    total += 1
    const f = line.split('\t')
    if (f.length < 3) continue
    tabbed += 1
    const [job, step, ...rest] = f
    const msg = rest.join('\t').replace(STAMP, '')
    if (msg.trim() === '' || NOISE.test(msg)) continue
    entries.push({ job: job.trim(), step: step.trim(), msg })
  }

  // Not a log dump: a summary view, JSON, or an error.
  if (entries.length === 0 || tabbed < 3 || tabbed * 10 < total * 9) return text

  // Group consecutive lines by job/step.
  const groups: { job: string; step: string; runs: { text: string; count: number }[] }[] = []
  for (const e of entries) {
    const last = groups.length > 0 ? groups[groups.length - 1] : null
    if (last === null || last.job !== e.job || last.step !== e.step) {
      groups.push({ job: e.job, step: e.step, runs: [{ text: e.msg, count: 1 }] })
      continue
    }
    const run = last.runs[last.runs.length - 1]
    if (run.text === e.msg) run.count += 1
    else last.runs.push({ text: e.msg, count: 1 })
  }

  const jobs = new Set(groups.map((g) => g.job)).size
  const render = (r: { text: string; count: number }): string => (r.count > 1 ? `${r.text}  x${r.count}` : r.text)

  const out: string[] = [
    `# gh run view: ${entries.length} log lines, ${jobs} job${jobs === 1 ? '' : 's'}, ${groups.length} step${groups.length === 1 ? '' : 's'}`,
  ]

  const maxSteps = Math.max(0, caps.maxSteps)
  const shownGroups = groups.slice(0, maxSteps)
  for (const g of shownGroups) {
    const totalLines = g.runs.reduce((n, r) => n + r.count, 0)
    out.push('', `${g.job} > ${g.step} (${totalLines})`)

    const maxLines = Math.max(0, caps.maxLinesPerStep)
    if (totalLines <= maxLines) {
      for (const r of g.runs) out.push(render(r))
      continue
    }

    const head = g.runs.slice(0, maxLines)
    const rest = g.runs.slice(maxLines)
    for (const r of head) out.push(render(r))
    const protectedRuns = rest.filter((r) => PROTECTED.test(r.text)).slice(0, Math.max(0, caps.maxProtected))
    const hidden = rest.reduce((n, r) => n + r.count, 0) - protectedRuns.reduce((n, r) => n + r.count, 0)
    for (const r of protectedRuns) out.push(render(r))
    out.push(`... +${hidden} lines elided - raw: ${rerun} # tk:raw`)
  }

  if (groups.length > shownGroups.length) {
    out.push('', `... +${groups.length - shownGroups.length} steps elided - raw: ${rerun} # tk:raw`)
  }

  const result = out.join('\n')
  return result.length < text.length ? result : text
}
