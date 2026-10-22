// `gh pr list` / `gh issue list` / `gh run list` output compression.
//
// Compression-only: `gh` runs exactly as the model wrote it. These three
// commands are pure listing commands, and their default output is a padded
// table: gh's tabwriter pads every column to the widest cell and, on a TTY,
// wraps each field in ANSI colour codes. A single row costs ~120 bytes, of
// which the agent needs maybe 40.
//
// Two shapes reach us and both are handled:
//   - TTY      : a `Showing N of M ...` line, a header row, aligned columns
//   - non-TTY  : tab-separated fields, no header, no padding
//     (`gh` in a hook sees no TTY, so this is the shape that actually arrives)
//
// Recovery convention, same as compress.ts: elisions name the re-run tagged
// `# tk:raw`, and the planner bails on `#`, so the tagged re-run reaches the
// shell untouched.

import { tokenize } from './plan.ts'

export type GhPlan = { kind: 'gh'; command: string }

export type GhCaps = {
  /** list items kept before an elision line. */
  maxItems?: number
  // Optional + index signature: the shared `Caps` from ./compress.ts is an
  // acceptable argument even though it carries the git/grep caps instead.
  [key: string]: unknown
}

export const GH_DEFAULTS = { maxItems: 50 }

// Same bail set as the Bash planner.
const UNSAFE = /[|;&<>]|\$\(|\$\{|`|\r|\n|#/

// --json and --template/--jq produce machine or user-defined formats: trimming
// them would corrupt output someone is parsing. --web opens a browser (no
// table), -h/--help prints usage.
const BAIL_FLAGS = new Set(['--json', '--web', '--help', '-h', '--template', '--jq'])

const SUBCOMMANDS = new Map<string, GhListKind>([
  ['pr', 'pr'],
  ['issue', 'issue'],
  ['run', 'run'],
])

type GhListKind = 'pr' | 'issue' | 'run'

const RERUN: Record<GhListKind, string> = {
  pr: 'gh pr list',
  issue: 'gh issue list',
  run: 'gh run list',
}

function base(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1)
}

/**
 * Decide whether a raw command is a single `gh <pr|issue|run> list`.
 * Returns the plan or null (bail = command runs untouched).
 *
 * Compression-only: `command` is the original string, unchanged.
 */
export function planGh(command: string): GhPlan | null {
  const raw = command.trim()
  if (!raw) return null
  if (UNSAFE.test(raw)) return null

  const tokens = tokenize(raw)
  if (!tokens || tokens.length < 3) return null
  if (base(tokens[0]) !== 'gh') return null

  const kind = SUBCOMMANDS.get(tokens[1])
  if (!kind) return null
  if (tokens[2] !== 'list' && tokens[2] !== 'ls') return null

  for (const t of tokens.slice(3)) {
    if (!t.startsWith('-')) continue
    if (BAIL_FLAGS.has(t.split('=')[0])) return null
  }
  return { kind: 'gh', command }
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
// gh's spinner (braille frames) and cursor-control leftovers.
const SPINNER = /^[\u2800-\u28FF\s]*$/

// Terminal states gh prints in the STATE column of `pr list` / `issue list`.
const STATES = new Set(['OPEN', 'CLOSED', 'MERGED', 'DRAFT'])

// TTY run rows use a glyph rather than a word; a text agent reads words better.
const RUN_ICON: Record<string, string> = {
  '✓': 'success',
  '✗': 'failure',
  'X': 'failure',
  '-': 'cancelled',
  '*': 'in_progress',
  '!': 'skipped',
}

type GhItem = {
  id: string
  title: string
  branch: string
  state: string
  labels: string
  workflow: string
  status: string
}

function norm(label: string): string {
  return label.toLowerCase().replace(/[^a-z]/g, '')
}

/** Normalize a table cell: collapse runs of whitespace, trim. */
function cell(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Compact the default listing output of `gh pr list`, `gh issue list` and
 * `gh run list`: one line per item, padding and colour stripped, items capped.
 *
 * The shape is inferred from the text (header labels for a TTY table, field
 * layout for tab-separated output). Anything that does not parse cleanly is
 * returned unchanged - a half-understood table is worse than a verbose one.
 */
export function compressGh(text: string, caps: GhCaps = {}): string {
  const maxItems = caps.maxItems ?? GH_DEFAULTS.maxItems

  const clean = text.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = clean
    .split('\n')
    .filter((l) => l.trim() !== '' && !SPINNER.test(l))
  if (lines.length === 0) return text

  let heading: string | null = null
  let kind: GhListKind | null = null
  const items: GhItem[] = []

  // Locate a TTY header row. Its labels drive the column mapping, so a gh
  // release that reorders or adds a column still parses.
  const headerIdx = lines.findIndex((l) => {
    const cells = l.trim().split(/\s{2,}/)
    if (cells.length < 3) return false
    return cells.every((c) => /^[A-Z][A-Z0-9 #]*$/.test(c.trim()))
  })

  if (headerIdx >= 0) {
    const header = lines[headerIdx].trim().split(/\s{2,}/).map((c) => norm(c))
    const col = (name: string): number => header.indexOf(name)
    const iTitle = col('title')
    if (col('status') >= 0 || col('workflow') >= 0) kind = 'run'
    else if (col('labels') >= 0) kind = 'issue'
    else if (col('branch') >= 0) kind = 'pr'
    else return text
    if (iTitle < 0) return text

    const before = lines.slice(0, headerIdx)
    // The only preamble gh prints is the `Showing N of M ...` banner (and a
    // blank line). Anything else means we are not looking at a list table.
    for (const l of before) {
      if (l.trim() === '') continue
      if (!heading && /^Showing \d+ of \d+ /.test(l.trim())) {
        heading = l.trim()
        continue
      }
      return text
    }

    for (const line of lines.slice(headerIdx + 1)) {
      const cells = line.trim().split(/\s{2,}/)
      if (cells.length !== header.length) return text
      const get = (name: string): string => {
        const idx = col(name)
        return idx >= 0 ? cell(cells[idx]) : ''
      }
      if (kind === 'run') {
        items.push({
          id: get('id'),
          title: get('title'),
          branch: get('branch'),
          state: '',
          labels: '',
          workflow: get('workflow'),
          status: get('status'),
        })
      } else {
        items.push({
          id: get('id').replace(/^#/, ''),
          title: get('title'),
          branch: get('branch'),
          state: get('state'),
          labels: get('labels'),
          workflow: '',
          status: '',
        })
      }
    }
  } else {
    // Tab-separated shape (what a non-TTY gh prints).
    //   pr    : number  title  branch     state  createdAt
    //   issue : number  state  title      labels updatedAt
    //   run   : status  conclusion title  workflow branch event id elapsed createdAt
    for (const line of lines) {
      if (!line.includes('\t')) {
        heading = heading ?? (/^Showing \d+ of \d+ /.test(line.trim()) ? line.trim() : null)
        if (heading === null) return text
        continue
      }
      const f = line.split('\t')
      if (kind === null) {
        if (f.length >= 8 && /^\d+$/.test(f[6].trim())) kind = 'run'
        else if (f.length === 5 && STATES.has(f[1].trim())) kind = 'issue'
        else if (f.length === 5 && STATES.has(f[3].trim())) kind = 'pr'
        else return text
      }
      if (kind === 'run') {
        if (f.length < 8) return text
        items.push({
          id: cell(f[6]),
          title: cell(f[2]),
          branch: cell(f[4]),
          state: '',
          labels: '',
          workflow: cell(f[3]),
          status: cell(f[1]) || cell(f[0]),
        })
      } else if (kind === 'issue') {
        if (f.length < 4) return text
        items.push({
          id: cell(f[0]).replace(/^#/, ''),
          title: cell(f[2]),
          branch: '',
          state: cell(f[1]),
          labels: cell(f[3]),
          workflow: '',
          status: '',
        })
      } else {
        if (f.length < 4) return text
        items.push({
          id: cell(f[0]).replace(/^#/, ''),
          title: cell(f[1]),
          branch: cell(f[2]),
          state: cell(f[3]),
          labels: '',
          workflow: '',
          status: '',
        })
      }
    }
  }

  if (!kind || items.length === 0) return text

  const out: string[] = []
  if (heading) out.push(heading)

  for (const it of items.slice(0, maxItems)) {
    if (kind === 'run') {
      const status = RUN_ICON[it.status] ?? it.status
      out.push([status, it.workflow, it.branch, it.id].filter((s) => s !== '').join('  '))
    } else if (kind === 'issue') {
      const labels = it.labels ? ` {${it.labels}}` : ''
      const state = it.state ? ` [${it.state}]` : ''
      out.push(`#${it.id} ${it.title}${labels}${state}`)
    } else {
      const branch = it.branch ? ` (${it.branch})` : ''
      const state = it.state ? ` [${it.state}]` : ''
      out.push(`#${it.id} ${it.title}${branch}${state}`)
    }
  }

  if (items.length > maxItems) {
    out.push(
      `... +${items.length - maxItems} more items elided - raw: ${RERUN[kind]} --limit ${items.length} # tk:raw`,
    )
  }

  const result = out.join('\n')
  return result.length < text.length ? result : text
}
