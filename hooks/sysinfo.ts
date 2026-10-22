// Host-info listings: ps, df, free, `kubectl top`, `docker images`.
//
// These look like tables, which is why the first instinct was to route them
// through compressTable. They are not: ps and df pad columns to fixed widths
// with right-justified numbers, so slicing a row at the header's column offsets
// clips the digits out of `PID` and `Size`, and compressTable's `2+ spaces`
// split gets a different field count on nearly every row. Measured on this
// host: all six declined, byte for byte.
//
// Two things are worth doing instead.
//
// 1. Squeeze the padding between columns. tabwriter/ps/df align every column,
//    so `kubectl top pods` is 2 KB of which a third is spaces. The number of
//    columns is known per command, so the first N-1 fields are re-joined with
//    single spaces and the *last* field is kept verbatim: that is what holds
//    `ps aux`'s COMMAND together when a process name contains two spaces
//    (`/opt/My  App`). Measured: df 49%, kubectl top nodes 38%, top pods 35%,
//    free 21%, docker images 17%, ps aux 14%.
//
// 2. Cap the row count. `ps aux` on a busy node is hundreds of lines and the
//    model usually wants "what is the top memory consumer", not every row. Past
//    maxRows the header and first rows stay, error lines are rescued, and the
//    tail is elided with a `# tk:raw` hint - the same policy as git log's
//    maxEntries and gh list's maxItems.
//
// Padding is formatting; the trailing field is data. That split is the whole
// design, and it is why this module is not just `compressTable` with new
// planners.

import { tokenize } from './plan.ts'

export type RowsPlan = { kind: 'rows'; command: string }

// Same bail set as the other planners: one command, no shell composition.
const UNSAFE = /[|;&<>]|\$\(|\$\{|`|\r|\n|#/

function base(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1)
}

type Shape = { columns: number }

/**
 * Column count for the listings this module knows, or null.
 *
 * `ps -eo <list>` takes its column count from the list itself, which is why
 * that form is allowed at all rather than bailing on a custom format.
 */
function shapeOf(tokens: string[]): Shape | null {
  if (tokens.length < 2) return null
  const prog = base(tokens[0])

  if (prog === 'ps') {
    // A custom output format changes the column set, whatever the mode says.
    // `--sort` and friends do not, so they are left alone.
    if (tokens.some((t) => t === '-o' || t === '-O' || t === '--format' || t.startsWith('--format='))) {
      if (tokens[1] !== '-eo') return null
    }
    const mode = tokens[1]
    if (mode === 'aux' || mode === '-aux') return { columns: 11 } // USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
    if (mode === 'ax' || mode === '-ax') return { columns: 5 } // PID TTY STAT TIME COMMAND
    if (mode === '-ef') return { columns: 8 } // UID PID PPID C STIME TTY TIME CMD
    if (mode === '-eo') {
      const list = tokens[2]
      if (!list || list.startsWith('-')) return null
      const fields = list.split(',').filter((f) => f !== '')
      return fields.length >= 2 ? { columns: fields.length } : null
    }
    return null
  }

  if (prog === 'df') {
    const flag = tokens[1]
    if (flag !== undefined && !/^(-[hHkmi]|--human-readable|--si|--block-size)$/.test(flag)) return null
    if (tokens.some((t) => t === '-i' || t === '--inodes' || t.startsWith('--output'))) return null
    return { columns: 6 } // Filesystem Size Used Avail Use% Mounted on
  }

  if (prog === 'free') {
    const flag = tokens[1]
    if (flag !== undefined && !/^(-[bkmgh]|--human|--mega|--giga|--kilo|--bytes)$/.test(flag)) return null
    return { columns: 7 } // (label) total used free shared buff/cache available
  }

  if (prog === 'docker' && tokens[1] === 'images') {
    if (tokens.some((t) => t === '--format' || t === '-q' || t === '--quiet')) return null
    // REPOSITORY TAG IMAGE ID, then `CREATED SIZE` verbatim - CREATED is
    // "2 weeks ago" and must not be re-split.
    return { columns: 4 }
  }

  if (prog === 'kubectl' && tokens[1] === 'top') {
    const what = tokens[2]
    if (what === 'pods' || what === 'pod') {
      if (tokens.some((t) => t === '-o' || t.startsWith('--output') || t === '--containers')) return null
      return { columns: 3 } // NAME CPU MEMORY
    }
    if (what === 'nodes' || what === 'node') {
      if (tokens.some((t) => t === '-o' || t.startsWith('--output'))) return null
      return { columns: 5 } // NAME CPU CPU% MEMORY MEMORY%
    }
    return null
  }

  return null
}

/**
 * Plan a host-info listing. Compression-only: the command is never rewritten.
 */
export function planRows(command: string): RowsPlan | null {
  const raw = command.trim()
  if (!raw || UNSAFE.test(raw)) return null
  const tokens = tokenize(raw)
  if (!tokens) return null
  if (shapeOf(tokens) === null) return null
  return { kind: 'rows', command: raw }
}

export type RowsCaps = {
  /** rows kept before the tail is elided. */
  maxRows: number
  /** rows kept from the top before eliding (must be <= maxRows). */
  headRows: number
  /** error-ish rows rescued from the elided tail. */
  maxProtected: number
}

export const DEFAULT_ROWS_CAPS: RowsCaps = { maxRows: 40, headRows: 30, maxProtected: 8 }

const PROTECTED = /\b(?:error|err|failed|failure|denied|not found|no space|panic|fatal)\b/i

/**
 * Re-join the first `columns - 1` fields with single spaces, keep the tail as
 * it appears on the line.
 *
 * A line with fewer fields than expected (a header whose first column has no
 * label, for instance) is re-joined whole; there is no tail to protect there.
 */
function squeezeLine(line: string, columns: number): string {
  const fields = [...line.matchAll(/\S+/g)]
  if (fields.length === 0) return line
  if (fields.length < columns) return fields.map((m) => m[0]).join(' ')

  const head = fields.slice(0, columns - 1).map((m) => m[0]).join(' ')
  const tailStart = fields[columns - 1].index ?? line.length
  return `${head} ${line.slice(tailStart)}`
}

/**
 * Keep the header and the first rows, with column padding squeezed.
 *
 * Returns the input unchanged when there is nothing to gain, and never
 * inflates.
 */
export function compressRows(text: string, caps: RowsCaps = DEFAULT_ROWS_CAPS, rerun: string = ''): string {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length < 2) return text

  const tokens = rerun ? tokenize(rerun) : null
  const shape = tokens ? shapeOf(tokens) : null
  const squeezed = shape ? lines.map((l) => squeezeLine(l, shape.columns)).join('\n') : normalized
  const working = squeezed.length < text.length ? squeezed : text

  const workLines = working.split('\n')
  const header = workLines[0]
  const body = workLines.slice(1).filter((l) => l.trim() !== '')

  const maxRows = Math.max(0, caps.maxRows)
  if (body.length <= maxRows) return working.length < text.length ? working : text

  const headRows = Math.min(Math.max(0, caps.headRows), maxRows)
  const head = body.slice(0, headRows)
  const rest = body.slice(headRows)
  const rescued = rest.filter((l) => PROTECTED.test(l)).slice(0, Math.max(0, caps.maxProtected))
  const hidden = rest.length - rescued.length

  const hint = rerun ? ` - raw: ${rerun} # tk:raw` : ''
  const result = [header, ...head, ...rescued, `... +${hidden} rows elided${hint}`].join('\n')
  return result.length < text.length ? result : text
}
