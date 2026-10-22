// kubectl logs: compression-only support.
//
// A pod log is the highest-variance output an agent reads, so the compressor
// does two things and only two things:
//
//   1. identical consecutive lines collapse to `line  xN` (retry loops,
//      health-check spam, and stack-trace repeats are where the tokens go);
//   2. past a line cap, the middle is elided while keeping the head, the
//      tail, and every line that mentions an error or a warning.
//
// Everything else is preserved verbatim: timestamps, JSON payloads, and
// indentation are context the model may be reading for. `-f/--follow` bails
// because a stream has no finite output to compress, and an unknown flag
// bails rather than guess at what it does to the format.

import { tokenize } from './plan.ts'
import { stripAnsi } from './ansi.ts'
import { UNSAFE, basename } from './shell.ts'

export type KubectlLogsPlan = { kind: 'kubectl-logs'; command: string }

/** Flags that consume the following token as their value. */
const VALUE_FLAGS = new Set([
  '-n',
  '--namespace',
  '-c',
  '--container',
  '--tail',
  '--since',
  '--since-time',
  '--limit-bytes',
  '--max-log-requests',
  '-l',
  '--selector',
  '--context',
  '--kubeconfig',
  '--pod-running-timeout',
])

/** Boolean flags that do not change the shape of the output. */
const BOOL_FLAGS = new Set([
  '-p',
  '--previous',
  '--timestamps',
  '--all-containers',
  '--all-pods',
  '--ignore-errors',
  '--prefix',
])

/**
 * Plan a `kubectl logs` call. Compression-only: the command is never rewritten.
 *
 * `-f`/`--follow`/`--watch` bail (endless stream), as do `-h`/`--help` and any
 * flag this module does not recognize.
 */
export function planKubectlLogs(command: string): KubectlLogsPlan | null {
  const cmd = command.trim()
  if (!cmd) return null
  if (UNSAFE.test(cmd)) return null
  const tokens = tokenize(cmd)
  if (!tokens || tokens.length < 3) return null
  if (basename(tokens[0]) !== 'kubectl' || tokens[1] !== 'logs') return null

  let target = false
  for (let i = 2; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (t === '-f' || t === '--follow' || t === '--watch') return null
    if (t === '-h' || t === '--help' || t === '--version') return null
    if (VALUE_FLAGS.has(t)) {
      // A selector alone is a valid target: kubectl logs will pick the pods.
      if (t === '-l' || t === '--selector') target = true
      i += 1
      continue
    }
    // `--tail=100` style: the value rides on the flag.
    if (t.includes('=') && VALUE_FLAGS.has(t.split('=')[0])) continue
    if (t.startsWith('-')) {
      if (BOOL_FLAGS.has(t)) continue
      return null
    }
    target = true
  }
  if (!target) return null
  return { kind: 'kubectl-logs', command: cmd }
}

export type KubectlLogsCaps = {
  /** lines kept (after de-duplication) before the middle is elided. */
  maxLines: number
  /** lines kept from the start when eliding. */
  headLines: number
  /** lines kept from the end when eliding. */
  tailLines: number
  /** error/warn lines rescued from the elided middle. */
  maxProtected: number
}

export const DEFAULT_KUBECTL_LOGS_CAPS: KubectlLogsCaps = {
  maxLines: 200,
  headLines: 120,
  tailLines: 60,
  maxProtected: 40,
}

/**
 * Lines that are never silently dropped: if one sits in the elided middle it
 * is lifted out above the tail. Deliberately generous - a false positive only
 * costs a line, a false negative loses the reason the pod is broken.
 */
const PROTECTED =
  /\b(?:error|err|warn|warning|panic|fatal|critical|exception|traceback|failed|failure|refused|timeout|denied|oom)\b/i

/**
 * Compress container logs: collapse runs of identical lines, and past the cap
 * elide the middle while keeping the head, the tail, and any error/warn line.
 *
 * Returns the input unchanged when there is nothing to gain (already short, or
 * no repeated lines and no cap hit), and never inflates.
 */
export function compressKubectlLogs(
  text: string,
  caps: KubectlLogsCaps = DEFAULT_KUBECTL_LOGS_CAPS,
  rerun: string = 'kubectl logs',
): string {
  const stripped = stripAnsi(text)
  const rawLines = stripped.split(/\r\n|\r|\n/)

  // Collapse consecutive identical lines. Anything that differs at all (a
  // timestamp, a pid) stays its own line, so this cannot merge two events.
  const runs: { text: string; count: number }[] = []
  for (const line of rawLines) {
    if (line.trim() === '') continue
    const last = runs.length > 0 ? runs[runs.length - 1] : null
    if (last !== null && last.text === line) {
      last.count += 1
      continue
    }
    runs.push({ text: line, count: 1 })
  }
  if (runs.length === 0) return text

  const render = (r: { text: string; count: number }): string => (r.count > 1 ? `${r.text}  x${r.count}` : r.text)
  const hid = (rs: { count: number }[]): number => rs.reduce((n, r) => n + r.count, 0)

  const maxLines = Math.max(0, caps.maxLines)
  const anyRepeat = runs.some((r) => r.count > 1)
  if (runs.length <= maxLines) {
    // Nothing repeated and no cap hit: there is nothing to gain, so return the
    // input byte-for-byte rather than stripping a trailing newline.
    if (!anyRepeat && stripped === text) return text
    const joined = runs.map(render).join('\n')
    return joined.length >= text.length ? text : joined
  }

  const headLines = Math.max(0, Math.min(caps.headLines, maxLines))
  const tailLines = Math.max(0, Math.min(caps.tailLines, maxLines - headLines))
  const end = Math.max(headLines, runs.length - tailLines)
  const head = runs.slice(0, headLines)
  const middle = runs.slice(headLines, end)
  const tail = runs.slice(end)

  const maxProtected = Math.max(0, caps.maxProtected)
  const protectedRuns = middle.filter((r) => PROTECTED.test(r.text)).slice(0, maxProtected)
  const hiddenLines = hid(middle) - hid(protectedRuns)

  const marker =
    protectedRuns.length > 0
      ? `... +${hiddenLines} lines elided, ${protectedRuns.length} error/warn kept below - raw: ${rerun} # tk:raw`
      : `... +${hiddenLines} lines elided - raw: ${rerun} # tk:raw`

  const out = [...head.map(render), marker, ...protectedRuns.map(render), ...tail.map(render)].join('\n')
  return out.length >= text.length ? text : out
}
