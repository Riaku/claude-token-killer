// `go build` / `go vet`: compression-only support.
//
// Both are silent on success, so the only thing worth stripping is build
// chatter (`go: downloading ...`, `go: finding ...`) and repeated identical
// diagnostic lines. Every other line is kept verbatim: compiler diagnostics are
// the whole point of running these, and a summarizer that paraphrased them
// would be inventing output.
//
// `-x`/`-n` bail (they print the commands Go runs, which is the output the
// model asked for), as does `-json` (machine format).

import { tokenize } from './plan.ts'
import { stripAnsi } from './ansi.ts'

export type GoBuildPlan = { kind: 'go-build'; command: string }

const UNSAFE = /[|;&<>]|\$\(|\$\{|`|\r|\n|#/


const SUBCOMMANDS = new Set(['build', 'vet'])

/** Verbose/machine flags whose output must not be touched. */
const BAIL_FLAGS = new Set(['-x', '-n', '-json', '-work', '-v', '-h', '--help', '--version'])

function basename(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1)
}

export function planGoBuild(command: string): GoBuildPlan | null {
  const cmd = command.trim()
  if (!cmd) return null
  if (UNSAFE.test(cmd)) return null
  const tokens = tokenize(cmd)
  if (!tokens || tokens.length < 2) return null
  if (basename(tokens[0]) !== 'go' || !SUBCOMMANDS.has(tokens[1])) return null
  for (let i = 2; i < tokens.length; i += 1) {
    if (BAIL_FLAGS.has(tokens[i])) return null
  }
  return { kind: 'go-build', command: cmd }
}

export type GoBuildCaps = {
  /** cap on repeated identical lines before they collapse. */
  maxRepeats: number
}

export const DEFAULT_GO_BUILD_CAPS: GoBuildCaps = { maxRepeats: 200 }

const CHATTER = /^go: (?:downloading|finding|extracting)\b/

/**
 * Compress `go build`/`go vet` output: drop module-fetch chatter, collapse
 * consecutive identical lines. Diagnostics pass through untouched.
 */
export function compressGoBuild(
  text: string,
  caps: GoBuildCaps = DEFAULT_GO_BUILD_CAPS,
  _rerun: string = 'go build ./...',
): string {
  const lines = stripAnsi(text).split(/\r\n|\r|\n/)
  const out: string[] = []
  let last = ''
  let repeat = 0

  const flush = (): void => {
    if (repeat > 1) out.push(`${last}  x${repeat}`)
    else if (repeat === 1) out.push(last)
    repeat = 0
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') continue
    if (CHATTER.test(line.trim())) continue
    if (line === last) {
      if (repeat < caps.maxRepeats) repeat += 1
      continue
    }
    flush()
    last = line
    repeat = 1
  }
  flush()

  if (out.length === 0) return text
  const joined = out.join('\n')
  return joined.length >= text.length ? text : joined
}
