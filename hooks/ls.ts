// `ls -l` support: the long-format listing is the single biggest token cost
// in a directory listing - mode, link count, user, group, size, date, then
// the name. All the model usually needs is the name, whether it is a
// directory, and (roughly) how big it is.
//
// Compression-only: planLs never rewrites the command, it only marks it as a
// candidate. The stdout is compacted on the way back, and anything the parser
// does not fully recognize is returned unchanged, so a half-understood
// listing can never reach the model mangled.
//
// Recovery follows the Bash side's convention: every elision line names the
// re-run tagged `# tk:raw`, and the planner bails on `#` (a comment to the
// shell), so the tagged re-run reaches the shell untouched.

import { tokenize } from './plan.ts'
import { stripAnsi } from './ansi.ts'

export type LsPlan = { kind: 'ls'; command: string }

export const DEFAULT_LS_CAPS = {
  /** Total entries listed across all sections before an elision line. */
  maxEntries: 200,
}

export type LsCaps = typeof DEFAULT_LS_CAPS

// Same bail set as the Bash planner: pipes, statement separators,
// redirections, substitutions, backticks, newlines, comments.
const UNSAFE = /[|;&<>]|\$\(|\$\{|`|\r|\n|#/

// Only flags whose output this parser actually understands. Anything else -
// `-g`, `-o`, `-w`, `--full-time`, `--time-style` - changes the column
// layout, so the command is left alone entirely.
const SHORT_FLAGS = new Set([
  'l', 'a', 'A', 'h', 'r', 't', 'S', 'R', '1', 'F', 'p', 'q', 'i', 's', 'd', 'c', 'u', 'x',
])

const LONG_FLAGS = new Set([
  '--all',
  '--almost-all',
  '--human-readable',
  '--reverse',
  '--recursive',
  '--classify',
  '--directory',
  '--inode',
  '--block-size',
  '--color',
  '--no-color',
  '--group-directories-first',
  '--sort',
])

/**
 * Decide whether a raw command is an `ls` we understand. Compression-only:
 * the returned command is the command as written.
 */
export function planLs(command: string): LsPlan | null {
  if (UNSAFE.test(command)) return null
  const tokens = tokenize(command)
  if (!tokens || tokens.length === 0) return null

  const head = tokens[0].slice(tokens[0].lastIndexOf('/') + 1)
  if (head !== 'ls') return null

  let sawEndOfOpts = false
  for (const t of tokens.slice(1)) {
    if (sawEndOfOpts) continue // everything after `--` is a path
    if (t === '--') {
      sawEndOfOpts = true
      continue
    }
    // `-h` alone is help (the same flag bundles as `-lh` when combined, which
    // is why only the exact token bails).
    if (t === '--help' || t === '-h' || t === '--version') return null
    if (t.startsWith('--')) {
      if (!LONG_FLAGS.has(t.split('=')[0])) return null
    } else if (t.startsWith('-') && t.length > 1) {
      for (const ch of t.slice(1)) if (!SHORT_FLAGS.has(ch)) return null
    }
  }
  return { kind: 'ls', command }
}


// Unix mode string: type char, nine permission chars, optional ACL marker.
const MODE = /^[-dlbcps][rwxsStT-]{9}[.@+]?$/

const MONTHS = new Set(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])

// The eight fields before the name, with the size column allowed to be a
// human-readable value (`4.9K`) - it is echoed as-is, never re-formatted.
const LONG_PREFIX = /^(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}:\d{2}(?::\d{2})?|\d{4})\s+(.+)$/

type ParsedEntry = { kind: 'dir' | 'link' | 'file' | 'other'; text: string; name: string }

/**
 * Parse one `ls -l` row. The name is everything after the eighth field, so
 * names with spaces survive; a symlink's trailing ` -> target` is kept.
 * Returns null when the row is not the exact long format (device files,
 * custom --time-style, ACL/attr columns, ...).
 */
function parseLongRow(line: string): ParsedEntry | null {
  const t = line.trimEnd()
  if (!MODE.test(t.split(/\s+/, 1)[0] ?? '')) return null
  const m = LONG_PREFIX.exec(t)
  if (!m) return null
  if (!MONTHS.has(m[6])) return null

  const mode = m[1]
  const size = m[5]
  const rawName = m[9].trim()
  if (!rawName) return null
  if (rawName === '.' || rawName === '..') return { kind: 'other', text: '', name: rawName }

  if (mode.startsWith('d')) {
    const name = rawName.replace(/\/+$/, '')
    return { kind: 'dir', text: `${name}/`, name }
  }
  if (mode.startsWith('l')) {
    // `link.txt -> a.txt`: keep both ends, drop the size (it is the target
    // length, not the file's).
    const at = rawName.indexOf(' -> ')
    if (at < 0) return { kind: 'link', text: rawName, name: rawName }
    const name = rawName.slice(0, at)
    return { kind: 'link', text: `${name} -> ${rawName.slice(at + 4).trim()}`, name }
  }
  if (mode.startsWith('-')) return { kind: 'file', text: `${rawName} (${size})`, name: rawName }
  // Sockets, fifos, devices: name only, size column is not a size.
  return { kind: 'other', text: rawName, name: rawName }
}

type Section = { dir: string | null; entries: string[] }

/**
 * Compact a long-format `ls -l` dump.
 *
 * Flat listings (one directory, no `path:` header) become one line per entry:
 * `name/` for directories, `name (size)` for files, `name -> target` for
 * symlinks. Multi-path / recursive listings keep their `path:` grouping as a
 * `path (N entries):` header with indented entries.
 *
 * Bare column output (`ls`, `ls -1`, `ls -a`) has no long rows at all and is
 * returned unchanged, as is any text containing a row this parser cannot
 * read - a listing is only ever compressed whole.
 */
export function compressLs(raw: string, caps: LsCaps = DEFAULT_LS_CAPS, command?: string): string {
  const clean = stripAnsi(raw)
  const sections: Section[] = []
  let cur: Section = { dir: null, entries: [] }

  for (const line of clean.split('\n')) {
    const t = line.trim()
    if (!t) continue
    // `total 24` / `total 24K` is an allocation summary with no per-file
    // meaning (and `-h` makes it a size, not a count).
    if (/^total\s+\S+$/.test(t)) continue

    // A multi-path or recursive `ls` prints `<path>:` before each block.
    if (/^[^:]+:$/.test(t) && !MODE.test(t.split(/\s+/, 1)[0] ?? '')) {
      if (cur.entries.length > 0 || cur.dir !== null) sections.push(cur)
      cur = { dir: t.slice(0, -1), entries: [] }
      continue
    }

    const entry = parseLongRow(t)
    if (!entry) return raw // not a long listing: bail whole
    if (entry.name === '.' || entry.name === '..') continue
    cur.entries.push(entry.text)
  }
  if (cur.entries.length > 0 || cur.dir !== null) sections.push(cur)

  const rows = sections.reduce((n, s) => n + s.entries.length, 0)
  if (rows === 0) return raw

  const grouped = sections.some((s) => s.dir !== null)
  const hint = command ? `${command} # tk:raw` : 're-run with # tk:raw'
  const out: string[] = []
  let budget = Math.max(0, caps.maxEntries)
  let elided = 0

  for (const s of sections) {
    const shown = Math.min(s.entries.length, budget)
    elided += s.entries.length - shown
    budget -= shown

    if (grouped) {
      // A section that is entirely elided still gets a count, so the model
      // knows the directory exists and has N more entries.
      const header = `${s.dir ?? '.'} (${s.entries.length} ${s.entries.length === 1 ? 'entry' : 'entries'}):`
      out.push(header)
      for (const e of s.entries.slice(0, shown)) out.push(`  ${e}`)
    } else {
      for (const e of s.entries.slice(0, shown)) out.push(e)
    }
  }

  if (elided > 0) out.push(`... +${elided} more ${elided === 1 ? 'entry' : 'entries'} (raw: ${hint})`)

  const compressed = out.join('\n')
  // Never trade a smaller answer for a longer one.
  return compressed.length >= raw.length ? raw : compressed
}
