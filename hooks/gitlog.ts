// `git log` support - COMPRESSION-ONLY.
//
// The command runs exactly as the model wrote it: `git log` has too many
// subcommand-specific flag/value pairs (`-n 5`, `--since=...`, revision
// ranges, path specs) for a rewriter to be worth the risk, and the only
// rewrite we would want - forcing `--pretty` - is precisely the flag that
// changes the grammar under us. So the planner only decides *whether* the
// output is worth compacting; the command string is never altered.
//
// Recursion guard: `--pretty` / `--format` / `--graph` bail at the planner,
// and the compressor independently returns its input unchanged unless every
// line fits the standard `commit <sha>` / Author / Date / message block. A
// `--stat`, `-p` or `--oneline` log therefore passes through untouched even if
// someone hands it to the compressor directly.
//
// Recovery follows the Bash side's convention: the elision line names the
// re-run tagged `# tk:raw`, and the planner bails on `#` so that tagged re-run
// reaches the shell untouched.

import { tokenize } from './plan.ts'

export type LogPlan = { kind: 'git-log'; command: string }

export type LogCaps = {
  /** commits kept before one elision line. */
  maxEntries: number
  /** command the elision line names for the full output; defaults to `git log`. */
  rerun?: string
}

export const DEFAULT_LOG_CAPS: Required<LogCaps> = { maxEntries: 50, rerun: 'git log' }

// Same bail set as plan.ts: pipes, chains, redirects, command substitution,
// `${}`, backticks, newlines, comments. `$VAR` alone stays allowed.
const UNSAFE = /[|;&<>]|\$\(|\$\{|\x60|\r|\n|#/

// Structural or user-chosen output shapes: compacting them would need a
// different parser, so not even the compression half should be attempted.
const BAIL_FLAGS = new Set([
  '--help',
  '-h',
  '--version',
  '--pretty',
  '--format',
  '--graph',
])

function basename(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1)
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
}

// `Tue Mar 3 09:15:00 2026 +0000` (git's default `Date:` format), read in the
// commit's own offset: no Date object, so the machine's timezone cannot move
// the result.
const RFC2822 = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) (\d{1,2}) \d{2}:\d{2}:\d{2} (\d{4})/
// `2026-03-03 09:15:00 +0000` (--date=iso / iso-local) and friends.
const ISO = /^(\d{4})-(\d{2})-(\d{2})/

function isoDate(raw: string): string | null {
  const rfc = RFC2822.exec(raw)
  if (rfc) {
    const month = MONTHS[rfc[1]]
    if (!month) return null
    return `${rfc[3]}-${month}-${rfc[2].padStart(2, '0')}`
  }
  const iso = ISO.exec(raw)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  return null
}

/** `Ada Lovelace <ada@example.com>` -> `Ada Lovelace`. */
function authorName(raw: string): string {
  return raw.replace(/\s*<[^>]*>\s*$/, '').trim()
}

const COMMIT_LINE = /^commit ([0-9a-f]{7,64})$/

/**
 * Decide whether a `git log` invocation is one we are willing to compact.
 *
 * The returned command is always the caller's own string: this module never
 * rewrites, it only classifies. `--oneline` is deliberately NOT bailed: that
 * output is already one line per commit, so compressing it would gain nothing
 * and the compressor's never-inflate guard passes it straight through.
 */
export function planGitLog(command: string): LogPlan | null {
  if (UNSAFE.test(command)) return null
  const tokens = tokenize(command)
  if (!tokens || tokens.length === 0) return null
  if (basename(tokens[0]) !== 'git') return null

  let i = 1
  // Global git options before the subcommand: only the ones we understand.
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const t = tokens[i]
    if (t === '-C' || t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') {
      if (i + 1 >= tokens.length) return null
      i += 2
    } else if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=') || t === '--no-pager') {
      i += 1
    } else {
      return null
    }
  }

  if (tokens[i] !== 'log') return null

  for (const t of tokens.slice(i + 1)) {
    if (t.startsWith('-') && BAIL_FLAGS.has(t.split('=')[0])) return null
  }

  return { kind: 'git-log', command: command.trim() }
}

type LogEntry = { sha: string; author: string; date: string; subject: string; bodyLines: number }

/**
 * Compress `git log` output: every commit becomes one line
 * `abc1234 subject (author, YYYY-MM-DD)`, with `+N lines` when the commit had
 * a message body. Bodies are dropped; the sha and date are what a follow-up
 * `git show` needs.
 *
 * Returns the input unchanged when the text is not the standard multi-line
 * format (--oneline, --stat, -p, an aliased pretty format, a pager banner) or
 * when the result would not be shorter.
 */
export function compressGitLog(raw: string, caps: LogCaps = DEFAULT_LOG_CAPS): string {
  const text = raw.replace(ANSI, '')
  const lines = text.split('\n')
  const entries: LogEntry[] = []

  let i = 0
  while (i < lines.length) {
    if (lines[i] === '') {
      i += 1
      continue
    }
    const m = COMMIT_LINE.exec(lines[i])
    if (!m) return raw // trailing content we do not understand: bail whole
    const sha = m[1]
    i += 1

    let author: string | null = null
    let date: string | null = null
    while (i < lines.length && lines[i] !== '') {
      const l = lines[i]
      if (l.startsWith('Author: ')) author = authorName(l.slice('Author: '.length))
      else if (l.startsWith('Date: ')) date = l.slice('Date: '.length).trim()
      else if (l.startsWith('Merge: ')) {
        // merge parentage: no effect on the one-line form
      } else return raw
      i += 1
    }
    if (!author || !date) return raw
    const when = isoDate(date)
    if (!when) return raw
    if (i >= lines.length) return raw // header with no message block
    i += 1 // the blank line that closes the header

    // Message: git indents every message line (blank ones included) by four
    // spaces; the first unindented line ends the block.
    const message: string[] = []
    while (i < lines.length && lines[i].startsWith('    ')) {
      message.push(lines[i].slice(4))
      i += 1
    }
    if (message.length === 0) return raw
    const subject = message[0].trim()
    if (subject === '') return raw
    const bodyLines = message.slice(1).filter((l) => l.trim() !== '').length

    entries.push({ sha, author, date: when, subject, bodyLines })
  }

  if (entries.length === 0) return raw

  const shown = entries.slice(0, Math.max(caps.maxEntries, 0))
  const out = shown.map((e) => {
    const body = e.bodyLines > 0 ? ` +${e.bodyLines} line${e.bodyLines === 1 ? '' : 's'}` : ''
    return `${e.sha.slice(0, 7)} ${e.subject} (${e.author}, ${e.date})${body}`
  })
  const hidden = entries.length - shown.length
  if (hidden > 0) {
    const rerun = caps.rerun ?? DEFAULT_LOG_CAPS.rerun
    out.push(`... +${hidden} more commit${hidden === 1 ? '' : 's'} elided - raw: ${rerun} # tk:raw`)
  }

  const result = out.join('\n')
  return result.length < raw.length ? result : raw
}
