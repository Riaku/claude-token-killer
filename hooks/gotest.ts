// `go test` output compression - compression-only: `go test` runs exactly as
// the model wrote it, and the stdout is compacted on the way back.
//
// In verbose mode go prints three noise lines per test (`=== RUN`, `--- PASS`,
// and the tab-padded package result), so a 200-test package is ~600 lines of
// which the agent needs almost none. Those go. What survives is the shape of
// the run: one compact line per package, plus each `--- FAIL:` block with its
// indented assertion output (`foo_test.go:12: want 1, got 2`) - that is the
// part that costs real money to lose.
//
// Recovery convention, same as compress.ts: every elision line names the
// re-run tagged `# tk:raw`, and the planner bails on `#`, so the tagged
// re-run reaches the shell untouched.

import { tokenize } from './plan.ts'

export type GoTestPlan = { kind: 'go-test'; command: string }

export type GoTestCaps = {
  /** failing test blocks kept before the rest are summarized. */
  maxFailures?: number
  /** lines kept per failure block before an elision marker. */
  maxLinesPerFailure?: number
  // Optional + index signature: the shared `Caps` from ./compress.ts is an
  // acceptable argument even though it carries the git/grep caps instead.
  [key: string]: unknown
}

export const GO_TEST_DEFAULTS = { maxFailures: 20, maxLinesPerFailure: 20 }

// Same bail set as the Bash planner.
const UNSAFE = /[|;&<>]|\$\(|\$\{|`|\r|\n|#/

// -json is a machine format (`{"Action":"output",...}` per line): trimming it
// would corrupt anything parsing it. -h/--help speak for themselves.
const BAIL_FLAGS = new Set(['-json', '--json', '-h', '-help', '--help', '-version', '-V'])

function base(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1)
}

/** Escape a test name for use as a `-run` regex. */
function runPattern(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Decide whether a raw command is a single plain `go test` invocation.
 * Returns the plan or null (bail = command runs untouched).
 *
 * Compression-only: `command` is the original string, unchanged.
 */
export function planGoTest(command: string): GoTestPlan | null {
  const raw = command.trim()
  if (!raw) return null
  if (UNSAFE.test(raw)) return null

  const tokens = tokenize(raw)
  if (!tokens || tokens.length < 2) return null
  if (base(tokens[0]) !== 'go') return null
  if (tokens[1] !== 'test') return null

  for (const t of tokens.slice(2)) {
    if (!t.startsWith('-')) continue
    if (BAIL_FLAGS.has(t.split('=')[0])) return null
  }
  return { kind: 'go-test', command }
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

// Per-test lifecycle noise (go 1.24 adds === NAME).
const LIFECYCLE = /^=== (RUN|PAUSE|CONT|NAME)\b/
// Verbose-mode pass line: one per test, dropped and counted.
const PASSING = /^--- PASS: /
// Failure block opener. Subtests are indented, so only column 0 opens a block.
const BLOCK_OPEN = /^--- FAIL: (\S+)/
// Package result lines, tab- or space-padded:
//   ok  	example.com/pkg	0.312s
//   ok  	example.com/pkg	(cached)
//   FAIL	example.com/pkg	0.002s
//   FAIL	example.com/pkg [build failed]
//   ?   	example.com/pkg	[no test files]
const PKG_RESULT = /^(ok|FAIL|\?)(\s+)(\S+)(.*)$/

/**
 * Compact `go test` / `go test -v` stdout.
 *
 * Kept: one compact line per package (`ok pkg 0.3s`, `FAIL pkg [build failed]`),
 * each `--- FAIL:` block with its indented output (capped), `--- SKIP:` lines
 * and any other unrecognized line (panics, build errors) verbatim.
 *
 * Returns the input unchanged when it does not look like go test output, and
 * never returns something longer than the input.
 */
export function compressGoTest(text: string, caps: GoTestCaps = {}): string {
  const maxFailures = caps.maxFailures ?? GO_TEST_DEFAULTS.maxFailures
  const maxLines = caps.maxLinesPerFailure ?? GO_TEST_DEFAULTS.maxLinesPerFailure

  const clean = text.replace(ANSI, '')
  const lines = clean.split('\n')
  const looksLikeGoTest =
    /^(ok|FAIL|\?)\s+\S/m.test(clean) || /^--- FAIL: /m.test(clean) || /^=== RUN /m.test(clean)
  if (!looksLikeGoTest) return text

  const out: string[] = []
  let passingElided = 0
  let lifecycleDropped = 0
  let blocks = 0
  let blocksElided = 0

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue

    const open = BLOCK_OPEN.exec(line)
    if (open) {
      // The block's output is always indented (`    foo_test.go:12: ...`), so
      // the first non-indented line closes it.
      const body: string[] = []
      let j = i + 1
      while (j < lines.length && (lines[j].trim() === '' || /^\s/.test(lines[j]))) {
        body.push(lines[j].replace(/\s+$/, ''))
        j += 1
      }
      while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
      i = j - 1

      blocks += 1
      if (blocks > maxFailures) {
        blocksElided += 1
        continue
      }
      out.push(line.replace(/\s+$/, ''))
      if (body.length > maxLines) {
        out.push(...body.slice(0, maxLines))
        out.push(
          `... +${body.length - maxLines} lines elided - raw: go test -run '^${runPattern(open[1])}$' -v # tk:raw`,
        )
      } else {
        out.push(...body)
      }
      continue
    }

    if (LIFECYCLE.test(line)) {
      lifecycleDropped += 1
      continue
    }
    if (PASSING.test(line)) {
      passingElided += 1
      continue
    }

    const res = PKG_RESULT.exec(line)
    if (res) {
      // Collapse the tabwriter padding: `ok  \tpkg\t0.312s` -> `ok pkg 0.312s`.
      const tail = res[4].trim()
      out.push(`${res[1]} ${res[3]}${tail === '' ? '' : ' ' + tail}`)
      continue
    }
    out.push(line.replace(/\s+$/, ''))
  }

  if (passingElided > 0) {
    out.push(`... +${passingElided} passing test${passingElided === 1 ? '' : 's'} elided - raw: go test -v # tk:raw`)
  }
  if (blocksElided > 0) {
    out.push(`... +${blocksElided} more failing test${blocksElided === 1 ? '' : 's'} elided - raw: go test # tk:raw`)
  }
  if (lifecycleDropped > 0 && out.length === 0) {
    out.push('go test: passed, no package results printed')
  }

  const result = out.join('\n')
  return result.length < text.length ? result : text
}
