// One definition of "escape sequence" for the whole mod.
//
// Every compressor used to carry its own `const ANSI = ...` and call
// `.replace(ANSI, '')` on its input. Six modules had the CSI-only pattern and
// eight had CSI plus OSC, so the same output could be cleaned differently
// depending on which command produced it. One helper, one pattern, and a
// single place to fix a miss.
//
// Why strip at all when the output is piped and not a terminal: most tools
// suppress colour themselves, but not all - `--color=always`, FORCE_COLOR, a
// wrapper script, or an app that writes its own escapes all defeat that. And
// crucially a coloured table or diff does not merely waste bytes: the escape
// codes sit in front of the header cells and the `+`/`-` prefixes, so the
// parser stops recognising the shape and declines to compress at all.
//
// What is deliberately NOT done here: dropping `\r`, collapsing control
// characters, or touching anything that is not an escape sequence. Carriage
// returns carry progress-bar redraws, which the modules that model progress
// output collapse on their own; a blanket control-character filter would also
// eat data a `cat`/`jq`/`xxd` round-trip is meant to show verbatim.

/** CSI (`ESC [ ... final`) and OSC (`ESC ] ... BEL|ST`). */
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g

/** Cheap pre-check: clean output is the common case and costs one scan. */
export function hasAnsi(text: string): boolean {
  return text.includes('\x1b')
}

export function stripAnsi(text: string): string {
  if (!text.includes('\x1b')) return text
  return text.replace(ANSI, '')
}

/**
 * Parse `raw`; if escape bytes are in the way, retry the parse on a stripped
 * copy.
 *
 * Telling "the parse understood this" apart from "the parse echoed it back" is
 * the whole game here, and byte inequality alone is not enough: a compressor
 * that does not recognise a coloured table still returns the input, usually
 * minus a trailing newline. So:
 *
 *   - a result with no escape bytes means the parse is done - either the input
 *     was clean or the compressor strips escapes itself;
 *   - a structural change means the parse understood the input, and any escapes
 *     left in the result are content (a diff line that prints an escape byte),
 *     so that result is kept as-is;
 *   - a whitespace-only difference means it did not understand the input, so
 *     retry on the stripped copy;
 *   - if the stripped copy does not parse either, hand back `raw` untouched.
 */
export function stripRetry(raw: string, parse: (text: string) => string): string {
  const out = parse(raw)
  if (!hasAnsi(raw) || !hasAnsi(out)) return out
  const clean = stripAnsi(raw)
  if (clean === raw) return out
  const retried = parse(clean)
  if (retried === clean) return raw
  return sameButForTrailingSpace(out, raw) ? retried : out
}

/** True when two results differ only in trailing whitespace/blank lines. */
function sameButForTrailingSpace(a: string, b: string): boolean {
  const trim = (s: string) => s.replace(/[ \t\r\n]+$/, '')
  return trim(a) === trim(b)
}
