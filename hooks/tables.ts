// Generic column-table compaction, plus the two planners that use it
// (`docker ps`, `kubectl get <resource>`).
//
// Both tools print a padded, header-first table. The padding is pure token
// waste: every row carries a run of spaces per column. Rewriting a row as
// `header=value` pairs keeps every value and drops the padding:
//
//   NAME                 READY   STATUS    RESTARTS   AGE
//   nginx-6799fc88d-2x   1/1     Running   0          3d
//   ->
//   name=nginx-6799fc88d-2x ready=1/1 status=Running restarts=0 age=3d
//
// Parsing is column-offset based, taken from the header row, which is what
// makes values containing single spaces (kubectl's `0/1`, docker's COMMAND)
// survive intact. A row whose value overflows its column shifts the rest of
// that row right, exactly like the tabwriter that produced it, so overflow
// is recovered rather than misread.
//
// Compression-only: both planners return the command as written. Any table
// this parser is not certain about is returned unchanged, and a result that
// is not shorter is discarded.

import { tokenize } from './plan.ts'

/**
 * How rows are rendered.
 *
 * `pairs`  - `name=nginx ready=1/1 status=Running` (one header=value list per
 *            row). Fully self-describing, but every row repeats the header
 *            names, which on real tabwriter output costs more than the
 *            padding it removes (`kubectl get pods` grows ~20%).
 * `legend` - the header names are printed once as a `# cols:` line and each
 *            row is values only (~35% smaller on the same output).
 * `auto`   - whichever of the two is shorter for this table.
 */
export type TableMode = 'pairs' | 'legend' | 'auto'

export const DEFAULT_TABLE_CAPS: { maxRows: number; mode: TableMode } = {
  /** Data rows listed before an elision line. */
  maxRows: 200,
  mode: 'auto',
}

export type TableCaps = typeof DEFAULT_TABLE_CAPS

// Same bail set as the Bash planner.
const UNSAFE = /[|;&<>]|\$\(|\$\{|`|\r|\n|#/

/**
 * Column starts of a header row. Fields are separated by runs of two or more
 * spaces, so a header name that itself contains a single space
 * (`CONTAINER ID`) stays one column.
 */
function columnStarts(header: string): number[] {
  const starts: number[] = []
  let i = 0
  while (i < header.length) {
    if (header[i] === ' ') {
      i += 1
      continue
    }
    starts.push(i)
    while (i < header.length) {
      // Consume one space at a time; a run of two or more ends the field.
      if (header[i] === ' ' && (header[i + 1] === ' ' || i + 1 >= header.length)) break
      i += 1
    }
    while (header[i] === ' ') i += 1
  }
  return starts
}

/** The header names, one per column start. */
function headerNames(header: string, starts: number[]): string[] {
  return starts.map((s, i) => header.slice(s, i + 1 < starts.length ? starts[i + 1] : header.length).trim())
}

/**
 * Split one data row at the header's column offsets.
 *
 * Values padded to their column keep the offset. When a value is longer than
 * its header, the run of spaces that follows it is still the separator, so
 * the remainder of the row is shifted by that much for the columns after it.
 */
function parseRow(line: string, starts: number[], col: number, keep: boolean[]): string[] {
  const vals: string[] = new Array(starts.length).fill('')
  let shift = 0
  for (let i = col; i < starts.length; i += 1) {
    if (!keep[i]) continue
    const start = starts[i] + shift
    if (start >= line.length) continue
    const next = i + 1 < starts.length ? starts[i + 1] + shift : -1
    if (next < 0) {
      vals[i] = line.slice(start).trim()
      continue
    }
    if (next <= line.length && line[next - 1] === ' ') {
      vals[i] = line.slice(start, next).trim()
      continue
    }
    // Overflow: read up to the next run of two or more spaces (a value may
    // contain single spaces, so a single space is not a separator).
    const rest = line.slice(start)
    const m = / {2,}/.exec(rest)
    const stop = m ? m.index : rest.length
    vals[i] = rest.slice(0, stop).trim()
    shift = Math.max(0, start + stop + (m ? m[0].length : 0) - (i + 1 < starts.length ? starts[i + 1] : 0))
  }
  return vals
}

/** Normalize a header cell for `header=value` output: `CONTAINER ID` -> `container_id`. */
function fieldName(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, '_')
}

/** `header=value` pairs for one row; empty cells are dropped. */
function renderPairs(names: string[], keep: boolean[], vals: string[]): string {
  const pairs: string[] = []
  vals.forEach((v, i) => {
    if (v === '' || !keep[i]) return
    pairs.push(`${names[i]}=${v}`)
  })
  return pairs.join(' ')
}

/**
 * Values only, for the `# cols:` legend form. An empty cell holds its
 * position as `-`; a value containing a space is quoted so the row stays
 * unambiguous.
 */
function renderLegendRow(vals: string[]): string {
  return vals.map((v) => (v === '' ? '-' : quoteIfSpaced(v))).join(' ')
}

/** Quote a value that contains spaces, unless it is already quoted. */
function quoteIfSpaced(v: string): string {
  if (!/ /.test(v)) return v
  if (/^".*"$/.test(v)) return v
  return `"${v}"`
}

// A header cell is an uppercase word (possibly several, single-spaced) and
// may carry the decorations kubectl uses: `PORT(S)`, `RESTARTS`, `READY`.
const HEADER_CELL = /^[A-Z][A-Z0-9_()/.+-]*$/

/** Does this line look like a table header? Needs two or more uppercase cells. */
function isHeader(line: string): boolean {
  const cells = line.includes('\t')
    ? line
        .split('\t')
        .map((c) => c.trim())
        .filter((c) => c !== '')
    : (() => {
        const starts = columnStarts(line)
        return starts.length < 2 ? [] : headerNames(line, starts).filter((c) => c !== '')
      })()
  if (cells.length < 2) return false
  return cells.every((c) => c.split(' ').every((w) => HEADER_CELL.test(w)))
}

/**
 * Compact a header-first, space-padded table into one `header=value` line per
 * row. Empty cells are dropped (they carry no information and cost tokens).
 *
 * Returns the input unchanged when it is not such a table - a message, a
 * `-o json` blob, a `find -ls` listing - or when the result would not be
 * shorter.
 */
export function compressTable(raw: string, caps: Partial<TableCaps> = DEFAULT_TABLE_CAPS, command?: string): string {
  const lines = raw.split('\n')
  const headerAt = lines.findIndex((l) => l.trim() !== '' && isHeader(l))
  if (headerAt < 0) return raw

  const rawHeader = lines[headerAt]
  const tabbed = rawHeader.includes('\t')
  const header = rawHeader.replace(/\s+$/, '')
  const prefix = lines.slice(0, headerAt).filter((l) => l.trim() !== '')

  let names: string[]
  let keep: boolean[]
  const rows: string[][] = []

  if (tabbed) {
    // Tab-separated tables (`flux get ...`): columns are positional, so a row
    // must carry exactly the header's field count. A tab inside a value would
    // shift the row and mis-map every later column, so that bails instead.
    const fields = (l: string): string[] => {
      const f = l.split('\t').map((x) => x.trim())
      while (f.length > 0 && f[f.length - 1] === '') f.pop()
      return f
    }
    names = fields(header).map(fieldName)
    keep = names.map((n) => n !== '')
    if (names.length < 2) return raw
    for (const line of lines.slice(headerAt + 1)) {
      if (line.trim() === '') continue
      const vals = fields(line)
      if (vals.length !== names.length) return raw
      rows.push(vals)
    }
  } else {
    const starts = columnStarts(header)
    names = headerNames(header, starts).map(fieldName)
    keep = names.map((n) => n !== '')
    if (starts.length < 2) return raw

    for (const line of lines.slice(headerAt + 1)) {
      if (line.trim() === '') continue
      // A data row is flush with the header; anything indented is not a row.
      if (/^\s/.test(line)) return raw
      const vals = parseRow(line.replace(/\s+$/, ''), starts, 0, keep)
      if (vals.filter((v) => v !== '').length < 2) return raw
      rows.push(vals)
    }
  }
  if (rows.length === 0) return raw

  const hint = command ? `${command} # tk:raw` : 're-run with # tk:raw'
  const maxRows = Math.max(0, caps.maxRows ?? DEFAULT_TABLE_CAPS.maxRows)
  const mode = caps.mode ?? DEFAULT_TABLE_CAPS.mode
  const shown = Math.min(rows.length, maxRows)
  const elision =
    rows.length > shown
      ? `... +${rows.length - shown} more ${rows.length - shown === 1 ? 'row' : 'rows'} (raw: ${hint})`
      : null

  const build = (head: string[], render: (vals: string[]) => string): string => {
    const out = [...prefix, ...head, ...rows.slice(0, shown).map(render)]
    if (elision) out.push(elision)
    return out.join('\n')
  }

  const pairsOut = build([], (vals) => renderPairs(names, keep, vals))
  // The legend form needs every column to have a name, otherwise the values
  // line cannot be mapped back onto the header.
  const legendable = keep.every(Boolean)
  const legendOut = legendable ? build([`# cols: ${names.join(' ')}`], renderLegendRow) : null

  let out = pairsOut
  if (mode === 'legend' && legendOut !== null) out = legendOut
  else if (mode === 'auto' && legendOut !== null && legendOut.length < pairsOut.length) out = legendOut

  return out.length >= raw.length ? raw : out
}

// ------------------------------------------------------------------ docker

export type DockerPlan = { kind: 'docker-ps'; command: string }

// `docker ps` flags that only select rows or widen an existing column;
// anything unknown bails, and `-q` / `--format` bail outright: `-q` is already
// minimal and `--format` is the model's own layout, not ours to rewrite.
const DOCKER_PS_FLAGS = new Set(['-a', '--all', '-l', '--latest', '--no-trunc', '-s', '--size'])

/** Plan a `docker ps` listing. Compression-only: the command is unchanged. */
export function planDocker(command: string): DockerPlan | null {
  if (UNSAFE.test(command)) return null
  const tokens = tokenize(command)
  if (!tokens || tokens.length === 0) return null

  const head = tokens[0].slice(tokens[0].lastIndexOf('/') + 1)
  if (head !== 'docker') return null

  let rest: string[]
  if (tokens[1] === 'ps') rest = tokens.slice(2)
  else if (tokens[1] === 'container' && (tokens[2] === 'ls' || tokens[2] === 'ps')) rest = tokens.slice(3)
  else return null

  for (const t of rest) {
    if (t === '-q' || t === '--quiet' || t === '--format' || t.startsWith('--format=')) return null
    if (t === '--help' || t === '-h' || t === '--version') return null
    if (t.startsWith('-')) {
      if (!DOCKER_PS_FLAGS.has(t)) return null
    }
  }
  return { kind: 'docker-ps', command }
}

// ----------------------------------------------------------------- kubectl

export type KubectlPlan = { kind: 'kubectl-get'; command: string }

// `kubectl get` flags that take a separate value token, so the resource name
// can still be located when they come first (`kubectl get -n kube-system pods`).
const KUBECTL_VALUE_FLAGS = new Set([
  '-n',
  '--namespace',
  '-l',
  '--selector',
  '--field-selector',
  '-L',
  '--context',
  '--kubeconfig',
  '--sort-by',
  '--request-timeout',
  '--chunk-size',
])

/**
 * Plan a `kubectl get <resource>` listing. Compression-only.
 *
 * Machine formats are refused: `-o/--output` (json, yaml, jsonpath, go-
 * template...), `--watch`/`-w` (a stream, not a table), `--raw`, `--template`.
 * `-h`/`--help` bail too, per the module-wide safety rule.
 */
export function planKubectlGet(command: string): KubectlPlan | null {
  if (UNSAFE.test(command)) return null
  const tokens = tokenize(command)
  if (!tokens || tokens.length === 0) return null

  const head = tokens[0].slice(tokens[0].lastIndexOf('/') + 1)
  if (head !== 'kubectl') return null
  if (tokens[1] !== 'get') return null

  let resource: string | null = null
  for (let i = 2; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (t === '--help' || t === '-h' || t === '--version') return null
    if (t === '--watch' || t === '-w' || t === '--raw' || t === '--template') return null
    // `-o wide` is still a padded table and compresses fine. Every other
    // output mode (json, yaml, name, jsonpath, custom-columns, go-template)
    // is a machine format this parser must not touch.
    if (t === '--output' || t === '-o') {
      if (tokens[i + 1] === 'wide') {
        i += 1
        continue
      }
      return null
    }
    if (t.startsWith('--output=')) {
      if (t.slice('--output='.length) !== 'wide') return null
      continue
    }
    if (t.startsWith('-o') && t.length > 2) {
      if (t.slice(2) !== 'wide') return null
      continue
    }
    if (t.startsWith('-')) {
      if (KUBECTL_VALUE_FLAGS.has(t)) i += 1 // skip the flag's value
      continue
    }
    if (resource === null) {
      resource = t
      continue
    }
    // More than one bare word: `kubectl get pods deploy` is a valid
    // multi-resource call but the output is a merged, re-headered table -
    // leave it raw.
    return null
  }
  if (resource === null) return null
  return { kind: 'kubectl-get', command }
}
