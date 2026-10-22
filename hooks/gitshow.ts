// `git show` support, in the same two halves as the rest of the mod:
//
//   planGitShow   - decides whether the command may be touched at all, and at
//                   most appends `--no-color` (nothing else: every other flag
//                   changes what git prints, and we would rather not guess).
//   compressGitShow - turns the commit header block into one line and hands
//                   the diff body to compressGitDiff, so `git show` pays
//                   exactly the same per-hunk price `git diff` already does.
//
// Recovery follows the Bash side's convention: elisions name a re-run tagged
// `# tk:raw`, and the planner bails on `#` so that tagged re-run reaches the
// shell untouched.
//
// Self-contained on purpose: it imports only compress.ts and plan.ts, defines
// its own caps, and never mutates a shared table.

import { DEFAULT_CAPS, compressGitDiff } from './compress.ts'
import { tokenize } from './plan.ts'
import { stripAnsi } from './ansi.ts'
import { UNSAFE, basename, sq } from './shell.ts'

export type ShowPlan = { kind: 'git-show'; command: string }

export type ShowCaps = {
  /** diff body: kept hunk lines per file before an elision line. */
  maxDiffLinesPerFile: number
  /** diff body: kept lines across all files. */
  maxDiffTotalLines: number
}

// Inherit the diff budget the rest of the mod already uses, so a `git show`
// body costs the same as the equivalent `git diff` body.
export const DEFAULT_SHOW_CAPS: ShowCaps = {
  maxDiffLinesPerFile: DEFAULT_CAPS.maxDiffLinesPerFile,
  maxDiffTotalLines: DEFAULT_CAPS.maxDiffTotalLines,
}

// Flags whose output is not the standard header+patch shape. Compressing any
// of them would mean guessing at a different grammar, so they pass through.
const BAIL_FLAGS = new Set([
  '--help',
  '-h',
  '--version',
  '--pretty',
  '--format',
  '--oneline',
  '--stat',
  '--numstat',
  '--shortstat',
  '--raw',
  '--dirstat',
  '--summary',
  '--name-only',
  '--name-status',
  '--json',
  '--binary',
  '--patch-with-stat',
  '--cc',
  '--combined',
  '--notes',
  '--show-notes',
  '-s',
  '--quiet',
  '-z',
  '--no-index',
])

/** Split a flag token into its name, dropping any `=value` part. */
function flagName(token: string): string {
  return token.startsWith('-') ? token.split('=')[0] : token
}

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
}

// `Tue Mar 3 09:15:00 2026 +0000` (git's default `Date:` format). The date is
// taken in the commit's own offset, the way git printed it - no Date object,
// so the result cannot drift with the machine's timezone.
const RFC2822 = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) (\d{1,2}) \d{2}:\d{2}:\d{2} (\d{4})/
// `2026-03-03 09:15:00 +0000` (--date=iso / iso-local) and friends.
const ISO = /^(\d{4})-(\d{2})-(\d{2})/

/** `YYYY-MM-DD` from either of git's two common `Date:` spellings, else null. */
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

const COMMIT_LINE = /^commit ([0-9a-f]{7,64})/
const COMMIT_HEADER = /^commit ([0-9a-f]{7,64})$/

/**
 * Decide the rewrite for `git show`, or null when the command is not one we
 * are willing to touch.
 *
 * Compression-only flags (`--stat`, `--pretty`, ...) bail rather than run
 * uncompressed: the rewrite would be pointless and the output would still not
 * match what compressGitShow expects.
 */
export function planGitShow(command: string): ShowPlan | null {
  if (UNSAFE.test(command)) return null
  const tokens = tokenize(command)
  if (!tokens || tokens.length === 0) return null
  if (basename(tokens[0]) !== 'git') return null

  let i = 1
  const global: string[] = []

  // Global git options before the subcommand: only the ones we understand.
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const t = tokens[i]
    if (t === '-C' || t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') {
      if (i + 1 >= tokens.length) return null
      global.push(t, tokens[i + 1])
      i += 2
    } else if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=') || t === '--no-pager') {
      global.push(t)
      i += 1
    } else {
      return null
    }
  }

  if (tokens[i] !== 'show') return null
  const rest = tokens.slice(i + 1)

  for (const t of rest) {
    if (t.startsWith('-') && BAIL_FLAGS.has(flagName(t))) return null
  }

  const hasNoColor = rest.some((t) => t === '--no-color' || t === '--color=never')
  const extra = hasNoColor ? [] : ['--no-color']
  // `--no-color` after a bare `--` is a pathspec, not an option.
  const sep = rest.indexOf('--')
  const argv =
    sep === -1
      ? ['git', ...global, 'show', ...rest, ...extra]
      : ['git', ...global, 'show', ...rest.slice(0, sep), ...extra, ...rest.slice(sep)]
  const rewritten = argv.map(sq).join(' ')
  return { kind: 'git-show', command: rewritten }
}

/**
 * Compress `git show` output.
 *
 * The commit header block - `commit <sha>`, `Author:`, `Date:`, blank, the
 * indented message, blank - collapses to one line
 * `abc1234 subject (author, YYYY-MM-DD)`. The diff body that follows is handed
 * to compressGitDiff, so hunks get the same context trim and elision hints as
 * `git diff`. A commit with no diff body (empty commit, merge without `-m`)
 * yields the header line alone.
 *
 * Returns the input unchanged when it does not look like `git show` output,
 * when the header does not parse, when more than one commit is present, or
 * when the result would not be shorter.
 */
export function compressGitShow(raw: string, caps: ShowCaps = DEFAULT_SHOW_CAPS): string {
  const text = stripAnsi(raw)
  const lines = text.split('\n')
  const first = lines[0] ?? ''
  const m = COMMIT_HEADER.exec(first)
  if (!m) return raw

  const sha = m[1]
  let author: string | null = null
  let date: string | null = null
  let i = 1

  // Header: `Author:` / `Date:`, plus `Merge:` on a merge commit. Any other
  // line means this is not the format we know - bail whole, never half.
  while (i < lines.length && lines[i] !== '') {
    const l = lines[i]
    if (l.startsWith('Author: ')) author = authorName(l.slice('Author: '.length))
    else if (l.startsWith('Date: ')) date = l.slice('Date: '.length).trim()
    else if (l.startsWith('Merge: ')) {
      // merge parentage: fine, carries no diff of its own without -m
    } else return raw
    i += 1
  }
  if (!author || !date || i >= lines.length) return raw
  const when = isoDate(date)
  if (!when) return raw

  i += 1 // the blank line that closes the header

  // Message: git indents every message line (blank ones included) by four
  // spaces. The first line that is not indented ends it.
  const message: string[] = []
  while (i < lines.length && lines[i].startsWith('    ')) {
    message.push(lines[i].slice(4))
    i += 1
  }
  if (message.length === 0) return raw
  const subject = message[0].trim()
  if (subject === '') return raw

  while (i < lines.length && lines[i] === '') i += 1
  const body = lines.slice(i).join('\n')

  // `git show A B` prints one header block per commit; collapsing only the
  // first one and diffing the rest would silently drop the other headers.
  if (body.split('\n').some((l) => COMMIT_LINE.test(l))) return raw

  const headerLine = `${sha.slice(0, 7)} ${subject} (${author}, ${when})`
  if (body.trim() === '') {
    return headerLine.length < raw.length ? headerLine : raw
  }

  // compressGitDiff ignores everything before the first `diff --git`, so give
  // it the body only - the header is already accounted for above.
  const diff = compressGitDiff(body, { ...DEFAULT_CAPS, ...caps })
  const out = diff === body ? `${headerLine}\n\n${body}` : `${headerLine}\n${diff}`
  return out.length < raw.length ? out : raw
}
