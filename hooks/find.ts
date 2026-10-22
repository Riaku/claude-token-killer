// `find` support. A plain `find <path> ...` prints one absolute-ish path per
// line, almost all of which repeat the same parent directory prefix. Grouping
// by parent drops that repetition without losing a single entry:
//
//   src/hooks/a.ts        src/hooks/ (2):
//   src/hooks/b.ts   ->     a.ts
//                          b.ts
//
// Compression-only, and deliberately conservative on the command side: `find`
// has predicates that WRITE (-delete, -exec, -fprint...). Rewriting such a
// command - even to an equivalent one - is not a risk this module is willing
// to take, so any of them makes the planner bail and the command runs raw.
//
// Recovery: elisions name the re-run tagged `# tk:raw`; the planner bails on
// `#`, so the tagged re-run reaches the shell untouched.

import { tokenize } from './plan.ts'
import { stripAnsi } from './ansi.ts'
import { UNSAFE } from './shell.ts'

export type FindPlan = { kind: 'find'; command: string }

export const DEFAULT_FIND_CAPS = {
  /** Total paths listed before an elision line. */
  maxEntries: 200,
}

export type FindCaps = typeof DEFAULT_FIND_CAPS

// Predicates with side effects. Even though this module never rewrites the
// command, a bail keeps us out of the way of anything state-changing: the
// model gets raw output and no elision hint that could look like an
// invitation to re-run a destructive find.
const SIDE_EFFECT_FLAGS = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
])

// `find -L .` / `-H` / `-P` come before the starting path.
const TRAVERSAL = new Set(['-H', '-L', '-P'])

/**
 * Decide whether a raw command is a `find` we are willing to compress.
 * Compression-only: the returned command is the command as written.
 */
export function planFind(command: string): FindPlan | null {
  if (UNSAFE.test(command)) return null
  const tokens = tokenize(command)
  if (!tokens || tokens.length === 0) return null

  const head = tokens[0].slice(tokens[0].lastIndexOf('/') + 1)
  if (head !== 'find') return null

  for (const t of tokens.slice(1)) {
    if (t === '--help' || t === '-h' || t === '--version') return null
    if (SIDE_EFFECT_FLAGS.has(t)) return null
  }

  // A starting path is required: `find -name x` (implicit `.`) is legal but
  // its output shape is the one case we cannot confirm, so it passes through.
  let i = 1
  while (i < tokens.length && TRAVERSAL.has(tokens[i])) i += 1
  const start = tokens[i]
  if (start === undefined || start.startsWith('-')) return null

  return { kind: 'find', command }
}

/**
 * True when every line looks like one path from `find`'s default action.
 * `find -ls`, `find -printf`, warnings and anything column-aligned fail here,
 * which is what keeps the compressor from mangling an unexpected format.
 */
function isPathListing(lines: string[]): boolean {
  for (const line of lines) {
    if (/^\s/.test(line)) return false // indented: table or continuation
    if (line.includes('\t')) return false
    if (/ {2,}/.test(line)) return false // padded columns (`find -ls`)
    if (/^(find|inode):/.test(line)) return false
    if (/^\d+\s+\d+\s+/.test(line)) return false
  }
  return true
}

function splitPath(p: string): { dir: string; base: string } {
  const i = p.lastIndexOf('/')
  if (i < 0) return { dir: '.', base: p }
  if (i === 0) return { dir: '/', base: p.slice(1) }
  return { dir: p.slice(0, i), base: p.slice(i + 1) }
}

/**
 * Compact a plain-path `find` listing into per-directory groups.
 *
 * Returns the input unchanged when it does not look like a bare path listing
 * (or when the grouping would not actually be shorter). Entries are kept in
 * the order `find` emitted them; the first-seen order of directories is
 * preserved too, so the model can still read the traversal top-down.
 */
export function compressFind(raw: string, caps: FindCaps = DEFAULT_FIND_CAPS, command?: string): string {
  const clean = stripAnsi(raw)
  const paths = clean.split('\n').filter((l) => l !== '')
  if (paths.length === 0) return raw
  if (!isPathListing(paths)) return raw

  const groups = new Map<string, string[]>()
  for (const p of paths) {
    const { dir, base } = splitPath(p)
    const entry = groups.get(dir)
    if (entry) entry.push(base)
    else groups.set(dir, [base])
  }
  // One flat file in one directory is not compressible - do not emit a
  // header for a single line.
  // One path in one directory: the grouped form adds a header and a count for
  // no saving, so keep the raw output.
  if (groups.size === 1 && paths.length === 1) return raw

  const hint = command ? `${command} # tk:raw` : 're-run with # tk:raw'
  const out: string[] = []
  let budget = Math.max(0, caps.maxEntries)
  let elided = 0

  for (const [dir, bases] of groups) {
    const shown = Math.min(bases.length, budget)
    elided += bases.length - shown
    budget -= shown
    if (shown === 0) continue // fully elided: counted below, header omitted
    const label = dir === '/' ? '/' : `${dir}/`
    out.push(`${label} (${bases.length}):`)
    for (const b of bases.slice(0, shown)) out.push(`  ${b}`)
  }

  if (elided > 0) out.push(`... +${elided} more ${elided === 1 ? 'path' : 'paths'} (raw: ${hint})`)

  const compressed = out.join('\n')
  return compressed.length >= raw.length ? raw : compressed
}
