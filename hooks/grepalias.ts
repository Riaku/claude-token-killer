// `rg` and `git grep` reuse the grep compressor.
//
// Both print the same `file:line:text` shape `grep -rn` does, so the grouping
// and capping in compressGrep apply unchanged. There is no rewrite here: grep
// gets `-n` added by the planner in plan.ts, but `rg` and `git grep` have their
// own flag vocabularies and silently changing what a user asked for is not
// worth the few bytes.
//
// `-n` (or `--line-number`) is required, because without it the output is
// `file:text` and compressGrep would read the text as a line number. Context
// and count modes print something else entirely, so they bail.

import { tokenize } from './plan.ts'
import { UNSAFE } from './shell.ts'

export type GrepAliasPlan = { kind: 'grep'; command: string }

/** Modes whose output is not one `file:line:text` entry per match. */
const BAIL_FLAGS = new Set([
  '-l',
  '--files-with-matches',
  '--files-without-match',
  '--files',
  '-c',
  '--count',
  '--count-matches',
  '-o',
  '--only-matching',
  '--json',
  '-A',
  '-B',
  '-C',
  '--after-context',
  '--before-context',
  '--context',
  '-r',
  '--replace',
  '--name-only',
  '--name-status',
  '-L',
  '-p',
  '--show-function',
  '-W',
  '--function-context',
  '--passthru',
  '--stats',
  '--type-list',
  '-h',
  '--help',
])

function base(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1)
}

function hasLineNumbers(tokens: string[]): boolean {
  return tokens.some((t) => {
    const flag = t.split('=')[0]
    // `rg -n`, `rg --line-number`, and bundled short flags like `-in` / `-ni`.
    if (flag === '--line-number') return true
    if (flag.startsWith('--')) return false
    return /^-[A-Za-z]*n[A-Za-z]*$/.test(flag)
  })
}

/**
 * Plan `rg <pattern> [paths]`. Compression-only; requires line numbers.
 */
export function planRg(command: string): GrepAliasPlan | null {
  const raw = command.trim()
  if (!raw || UNSAFE.test(raw)) return null
  const tokens = tokenize(raw)
  if (!tokens || tokens.length < 2) return null
  if (base(tokens[0]) !== 'rg') return null

  for (const t of tokens.slice(1)) {
    if (!t.startsWith('-')) continue
    if (BAIL_FLAGS.has(t.split('=')[0])) return null
  }
  if (!hasLineNumbers(tokens)) return null
  return { kind: 'grep', command: raw }
}

/**
 * Plan `git grep -n <pattern>`. Compression-only; requires line numbers.
 */
export function planGitGrep(command: string): GrepAliasPlan | null {
  const raw = command.trim()
  if (!raw || UNSAFE.test(raw)) return null
  const tokens = tokenize(raw)
  if (!tokens || tokens.length < 3) return null
  if (base(tokens[0]) !== 'git' || tokens[1] !== 'grep') return null

  for (const t of tokens.slice(2)) {
    if (!t.startsWith('-')) continue
    if (BAIL_FLAGS.has(t.split('=')[0])) return null
  }
  if (!hasLineNumbers(tokens)) return null
  return { kind: 'grep', command: raw }
}
