// `Get-Help -Full`: the whole help topic, as one long document per cmdlet -
// NAME, SYNOPSIS, SYNTAX, a DESCRIPTION essay, every parameter with its
// six-line boilerplate block, EXAMPLES and NOTES. A single topic runs to 8-15 KB
// and an agent almost always asked for one thing.
//
// What survives: the one-line sections whole, DESCRIPTION cut to its first
// lines, EXAMPLES cut to the first few commands, and PARAMETERS reduced to the
// `-Name <Type>` lines that say a parameter exists. What goes: the
// `Required? false / Position? 1 / Default value / Accept pipeline input?`
// block that is identical in shape on every parameter, RELATED LINKS, and the
// reprinted full text at the end.
//
// Compression-only, and never inflating: a topic without the section vocabulary
// is returned unchanged.

import { stripAnsi } from './ansi.ts'
import { UNSAFE } from './shell.ts'

export type HelpPlan = { kind: 'ps-help'; command: string }
export type HelpCaps = { maxHelpLines: number }

const SECTION_LINE = /^(NAME|SYNOPSIS|SYNTAX|DESCRIPTION|PARAMETERS|INPUTS|OUTPUTS|NOTES|EXAMPLES|RELATED LINKS|REMARKS)\s*$/

// A parameter's boilerplate: `Required?`, `Position?`, `Default value`,
// `Accept pipeline input?`, `Accept wildcard characters?`, `Aliases`.
const BOILERPLATE = /^\s*(Required\?|Position\?|Default value|Accept pipeline input\?|Accept wildcard characters\?|Aliases|Parameter sets|Dynamically populated|CommonParameters)/

/** Plan a single `Get-Help`/`help` invocation that prints a topic. */
export function planHelp(command: string): HelpPlan | null {
  const raw = command.trim()
  if (!raw || UNSAFE.test(raw)) return null
  const head = raw.split(/\s+/)[0].toLowerCase().replace(/^&/, '').replace(/^.*\\/, '').replace(/\.exe$/, '')
  if (head !== 'get-help' && head !== 'help') return null
  // `Get-Help -Name X -Online` opens a browser and prints nothing to parse;
  // `-Examples` is already short, and `-Full`/`-Detailed` is the target.
  const lower = raw.toLowerCase()
  if (lower.includes('-online') || lower.includes('-examples') || lower.includes('-showwindow')) return null
  return { kind: 'ps-help', command: raw }
}

type Block = { title: string; lines: string[] }

/** Split a help topic into its section blocks, in document order. */
function blocks(lines: string[]): Block[] {
  return lines.reduce<Block[]>((acc, line) => {
    if (SECTION_LINE.test(line)) {
      acc.push({ title: line.trim(), lines: [] })
      return acc
    }
    if (acc.length === 0) return acc
    acc[acc.length - 1].lines.push(line)
    return acc
  }, [])
}

/** First `n` non-blank lines of a block, with an elision count when cut. */
function head(block: Block, n: number): string[] {
  const body = block.lines.filter((line) => line.trim() !== '')
  if (body.length <= n) return body
  return [...body.slice(0, n), `... +${body.length - n} lines`]
}

/**
 * Compact a `Get-Help -Full` topic: section titles kept, prose cut to its
 * opening lines, parameter boilerplate dropped, the parameter list reduced to
 * names and types. Returns the input unchanged when no section is recognised or
 * the result is not shorter.
 */
export function compressHelp(raw: string, caps: HelpCaps, command = ''): string {
  const clean = stripAnsi(raw)
  const found = blocks(clean.split('\n').map((l) => l.replace(/\s+$/, '')))
  if (found.length < 2) return raw

  const budget = Math.max(0, caps.maxHelpLines)
  const out = found.flatMap((block) => {
    if (block.title === 'RELATED LINKS') return []
    if (block.title === 'PARAMETERS') {
      const params = block.lines.filter((line) => /^\s+-[A-Za-z]/.test(line) && !BOILERPLATE.test(line))
      return [block.title, ...params.slice(0, budget), ...(params.length > budget ? [`... +${params.length - budget} parameters`] : [])]
    }
    return [block.title, ...head(block, budget)]
  })

  const body = out.join('\n').replace(/\n{3,}/g, '\n\n')
  // The hint costs a line, so a topic that shrank by less than that is returned
  // unchanged: this compressor never hands back more than it was given.
  const hint = command ? `# raw: ${command} # tk:raw` : '# raw: re-run with # tk:raw'
  const result = `${body}\n${hint}`
  return result.length < raw.length ? result : raw
}
