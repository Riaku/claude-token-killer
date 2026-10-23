// PowerShell cmdlet tables: Get-Process, Get-Service, Get-NetTCPConnection,
// Get-Command, Get-CimInstance and Get-Module -ListAvailable.
//
// Every one of them prints the same `Format-Table` shape with a dash rule under
// the header, so one parser reads them all and only the column policy differs.
// Two reductions, in order of payoff:
//
//   - drop the columns a cmdlet never earns: Get-Process's Handles/NPM/PM/VM/SI
//     are six right-aligned numbers per process that nobody reads, and
//     Get-Service's DisplayName is its Name with spaces;
//   - a column whose value is identical in every row is printed once, on the
//     `# cols:` line, instead of on every row (`SI=0`, `State=Established`).
//
// Compression-only: the command runs exactly as the model wrote it. A table the
// parser is not certain about is returned unchanged, and a result that is not
// shorter is discarded by the caller's length check.

import { stripAnsi } from './ansi.ts'
import { UNSAFE } from './shell.ts'

export type CmdletKind =
  | 'ps-process'
  | 'ps-service'
  | 'ps-net'
  | 'ps-command'
  | 'ps-cim'
  | 'ps-module'

export type CmdletPlan = { kind: CmdletKind; command: string }

/** Rows listed before an elision line. */
export type CmdletCaps = { maxRows: number }

// The cmdlets and the aliases that are unambiguous in every PowerShell: `gm`
// is Get-Member and `gh` is Get-History in 5.1, so neither is here.
const CMDLETS: ReadonlyArray<{ kind: CmdletKind; names: readonly string[] }> = [
  { kind: 'ps-process', names: ['get-process', 'ps', 'gps'] },
  { kind: 'ps-service', names: ['get-service', 'gsv'] },
  { kind: 'ps-net', names: ['get-nettcpconnection'] },
  { kind: 'ps-command', names: ['get-command', 'gcm'] },
  { kind: 'ps-cim', names: ['get-ciminstance', 'gcim'] },
  { kind: 'ps-module', names: ['get-module', 'gmo'] },
]

// Columns dropped for their name alone - values that are constant-ish noise
// rather than data. Names are compared without the unit suffix, so Get-Process
// matches on Windows (`WS(K)`) and on Linux pwsh (`WS(M)`) alike.
const DROP: Record<CmdletKind, readonly string[]> = {
  'ps-process': ['handles', 'npm', 'pm', 'vm', 'si'],
  'ps-service': ['displayname'],
  'ps-net': [],
  'ps-command': ['version'],
  'ps-cim': [],
  'ps-module': ['prerelease', 'psedition'],
}

// Parameters that change the output shape into something this parser does not
// model: a column subset of the model's choosing, a machine format, a file.
const SHAPE_FLAGS = ['-property', '-asjob', '-outfile', '-xml', '-json', '-expand', '-filter', '-inputobject', '-format']

/** Column name without its unit: `WS(K)` -> `ws`, `CPU(s)` -> `cpu`. */
function plainName(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, '_').replace(/\((k|m|g|s|kb|mb)\)$/i, '')
}

/** The cmdlet this command invokes, if any: strips `&`, a module prefix and `.exe`. */
function cmdletName(command: string): string {
  return command
    .trim()
    .replace(/^&\s*/, '')
    .split(/\s+/)[0]
    .toLowerCase()
    .replace(/.*\\/, '')
    .replace(/\.exe$/, '')
}

/**
 * Plan a single PowerShell cmdlet invocation that prints a table.
 * Compression-only: `command` is the original string. Anything with a pipeline,
 * a redirect, a variable or a shape-changing parameter bails.
 */
export function planCmdlet(command: string): CmdletPlan | null {
  const raw = command.trim()
  if (!raw || UNSAFE.test(raw)) return null
  const tokens = raw.split(/\s+/)
  if (tokens.length > 40) return null

  const name = cmdletName(raw)
  const family = CMDLETS.find((c) => c.names.includes(name))
  if (!family) return null
  if (tokens.slice(1).some((t) => SHAPE_FLAGS.some((flag) => t.toLowerCase().startsWith(flag)))) return null
  return { kind: family.kind, command: raw }
}

type Split = (line: string) => string[]
type Table = { prefix: string[]; header: string; width: number; rows: string[] }

// The dash rule pwsh prints under a table header. It is the marker that makes
// a header trustworthy: `Format-Table` emits it for every cmdlet table and for
// nothing else in this output, so no guessing about "looks like a header".
const RULE = /^\s*-+(\s+-+)+\s*$/
const SECTION = /^\s*Directory: /

// The two ways pwsh separates columns, and the reason this parser needs both.
// Wide columns are padded, so a run of two or more spaces is a boundary; two
// narrow adjacent columns - `Get-Process`'s `SI ProcessName`, both two wide -
// are separated by a single space, and a padded split merges them. The dash rule
// under the header says how many columns there are, so the split that reproduces
// that count for the header AND every row is the right one.
const SPLITS: readonly Split[] = [
  (line) => line.trim().split(/ {2,}/).filter((c) => c !== ''),
  (line) => line.trim().split(/ {1,}/).filter((c) => c !== ''),
]

/**
 * Read one `Format-Table` dump: a header, the dash rule under it, then rows.
 *
 * The rule is found first and the header is the line above it, so a listing
 * whose first column is right-aligned (`Get-Process` indents its header by one
 * space) still parses. No split reproduces the column count when a value
 * contains a space of its own (`Get-CimInstance`'s CommandLine), and the caller
 * then keeps those rows whole rather than splicing them into the wrong columns.
 *
 * The split itself is chosen once for the whole command, because two sections of
 * one listing can disagree: `Get-Module -ListAvailable` prints one row per
 * module, and the shorter rows split differently from the longer ones.
 *
 * Returns null when there is no header-plus-rule shape or no rows at all.
 */
function readTable(lines: string[]): Table | null {
  const ruleAt = lines.findIndex((line) => RULE.test(line))
  if (ruleAt < 1) return null

  const width = (lines[ruleAt].match(/-+/g) ?? []).length
  if (width < 2) return null
  const rows = lines.slice(ruleAt + 1).filter((line) => line.trim() !== '' && !RULE.test(line))
  if (rows.length === 0) return null

  return {
    prefix: lines.slice(0, ruleAt - 1).filter((l) => l.trim() !== ''),
    header: lines[ruleAt - 1].trim(),
    width,
    rows,
  }
}

/** `# cols:` line plus any value every row shares, which is printed once. */
function legend(names: string[], constants: string[]): string {
  const head = `# cols: ${names.join(' ')}`
  return constants.length === 0 ? head : `${head} | ${constants.join(' ')}`
}

/** Quote a value that contains a space, so a row stays unambiguous. */
function cell(v: string): string {
  if (v === '') return '-'
  return / /.test(v) && !/^".*"$/.test(v) ? `"${v}"` : v
}

/**
 * Compact a cmdlet table.
 *
 * Two shapes, chosen by whether every row splits into the header's column
 * count:
 *
 *   - columns: the padding goes, the columns a cmdlet never earns are dropped,
 *     and a value every row shares moves onto the legend line once. This is
 *     what `Get-Command`, `Get-Service` and `Get-Module` produce.
 *   - collapsed: a value wider than its column shifts a row's columns right
 *     (`Get-Process` with a six-digit Id), so the cells cannot be mapped back
 *     onto their headers. The row survives whole, with its run-of-spaces
 *     padding squeezed to one space; only the dash rule and trailing blanks go.
 *
 * Both keep the row count, cap the rows, and name the re-run tagged `# tk:raw`.
 * Returns the input unchanged when the shape is not recognised or the result is
 * not shorter.
 */
export function compressCmdlet(
  raw: string,
  kind: CmdletKind,
  caps: CmdletCaps,
  command = '',
): string {
  const clean = stripAnsi(raw)
  const lines = clean.split('\n').map((l) => l.replace(/\s+$/, ''))

  // A module listing prints one `Directory:` block per install root, each with
  // its own header and the same columns.
  const sections = lines.reduce<Array<{ dir: string | null; lines: string[] }>>((acc, line) => {
    if (SECTION.test(line)) {
      acc.push({ dir: line.trim().slice('Directory: '.length).trim(), lines: [] })
      return acc
    }
    if (acc.length === 0) acc.push({ dir: null, lines: [] })
    acc[acc.length - 1].lines.push(line)
    return acc
  }, [])

  const tables = sections.flatMap((s) => {
    const table = readTable(s.lines)
    return table === null ? [] : [{ dir: s.dir, table }]
  })
  if (tables.length === 0) return raw
  if (tables.some((t) => t.table.width !== tables[0].table.width)) return raw

  const rows = tables.map((t) => ({ dir: t.dir, rows: t.table.rows }))
  const all = rows.flatMap((t) => t.rows)
  const width = tables[0].table.width
  const split = SPLITS.find((s) => s(tables[0].table.header).length === width && all.every((row) => s(row).length === width))
  const names = split === undefined ? [] : split(tables[0].table.header)
  const values = split === undefined ? [] : all.map((row) => split(row))
  const splittable = split !== undefined
  const cap = Math.max(0, caps.maxRows)
  const hint = command ? ` - raw: ${command} # tk:raw` : ' - raw: re-run with # tk:raw'

  // Columns dropped for their name alone, then columns with no value at all,
  // then columns whose every value is the same one - that last group costs one
  // legend entry instead of a cell per row.
  const policy = DROP[kind]
  const kept = names.map((_, i) => i).filter((i) => names[i] !== '' && !policy.includes(plainName(names[i])))
  const filled = kept.filter((i) => values.some((row) => (row[i] ?? '') !== ''))
  const shared = filled.filter((i) => values.every((row) => row[i] === values[0][i]))
  const varying = filled.filter((i) => !shared.includes(i))

  const out: string[] = [
    ...tables[0].table.prefix,
    `(${all.length} ${all.length === 1 ? 'row' : 'rows'})`,
    // A table whose cells cannot be mapped back onto its headers keeps its rows
    // whole and names the header verbatim; a mapped table lists the columns it
    // rendered.
    splittable
      ? legend(
          varying.map((i) => plainName(names[i])),
          shared.map((i) => `${plainName(names[i])}=${cell(values[0][i] ?? '')}`),
        )
      : `# header: ${tables[0].table.header.replace(/ {2,}/g, ' ')}`,
  ]

  // Sections keep their own heading so a module listing still says which
  // install root each module came from; the row budget is spent across all of
  // them, because a second directory is the same flood as the first.
  let shown = 0
  tables.forEach((t, at) => {
    if (shown >= cap) return
    const take = Math.min(t.table.rows.length, cap - shown)
    if (take === 0) return
    if (t.dir !== null) out.push(`${t.dir} (${t.table.rows.length}):`)
    const start = rows.slice(0, at).reduce((n, r) => n + r.rows.length, 0)
    const slice = t.table.rows.slice(0, take)
    out.push(
      ...slice.map((row, offset) =>
        splittable
          ? varying.map((i) => cell(values[start + offset][i] ?? '')).join(' ')
          : row.trim().replace(/ {2,}/g, ' '),
      ),
    )
    shown += take
  })
  if (all.length > shown) out.push(`... +${all.length - shown} more${hint}`)
  const result = out.filter((l) => l !== '').join('\n')
  return result.length < raw.length ? result : raw
}
