// `cargo test` output compression - compression-only, like the PowerShell
// handler: the command the model wrote is what runs, and the stdout is
// compacted on the way back, so no rewrite can be wrong.
//
// What actually burns tokens in a cargo run is not the result: it is the wall
// of `Compiling`/`Finished` progress lines and one `test x ... ok` line per
// passing test. Both go. What must survive is what the agent needs to fix a
// build: compile errors (`error[E0308]: ...` and their surrounding code) and
// the failure report (`---- name stdout ----` plus its panic message).
//
// Recovery convention, same as compress.ts: every elision line names the
// re-run tagged `# tk:raw`, and the planner bails on `#`, so the tagged
// re-run reaches the shell untouched.

import { tokenize } from './plan.ts'
import { stripAnsi } from './ansi.ts'

export type CargoTestPlan = { kind: 'cargo-test'; command: string }

export type CargoTestCaps = {
  /** failure detail blocks kept before the rest are summarized. */
  maxFailures?: number
  /** lines kept per failure block before an elision marker. */
  maxLinesPerFailure?: number
  // An index signature so a caller can hand in the shared `Caps` object from
  // ./compress.ts (which carries the git/grep caps, not these) without a type
  // error: every field here is optional and unknown keys are ignored.
  [key: string]: unknown
}

export const CARGO_TEST_DEFAULTS = { maxFailures: 10, maxLinesPerFailure: 30 }

// Same bail set as the Bash planner: pipes, statement separators,
// redirections, substitution, backticks, newlines, comments.
const UNSAFE = /[|;&<>]|\$\(|\$\{|`|\r|\n|#/

// Flags that change the output into something this compressor would mangle,
// or that mean the user explicitly asked for the untrimmed firehose.
// --nocapture is the deliberate bypass: `--nocapture` says "I want the test
// output as it happens", so trimming it would fight the user's own request.
const BAIL_FLAGS = new Set([
  '--nocapture',
  '--json',
  '--help',
  '-h',
  '--version',
  '-V',
  '--message-format',
])

function base(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1)
}

/** Shell-quote a token only when it is not already shell-safe. */
function sq(token: string): string {
  if (/^[A-Za-z0-9_@%+=:,.\\/-]+$/.test(token)) return token
  return "'" + token.replace(/'/g, `'\\''`) + "'"
}

/**
 * Decide whether a raw command is a single plain `cargo test` invocation.
 * Returns the plan or null (bail = command runs untouched).
 *
 * Compression-only: `command` is the original string, unchanged.
 */
export function planCargoTest(command: string): CargoTestPlan | null {
  const raw = command.trim()
  if (!raw) return null
  if (UNSAFE.test(raw)) return null

  const tokens = tokenize(raw)
  if (!tokens || tokens.length < 2) return null
  if (base(tokens[0]) !== 'cargo') return null

  // `cargo +nightly test` - the toolchain override sits before the subcommand.
  let i = 1
  while (i < tokens.length && tokens[i].startsWith('+')) i += 1
  const sub = tokens[i]
  if (sub !== 'test' && sub !== 't') return null

  for (const t of tokens.slice(i + 1)) {
    if (!t.startsWith('-')) continue
    if (BAIL_FLAGS.has(t.split('=')[0])) return null
  }
  return { kind: 'cargo-test', command }
}


// Build progress: pure noise once the run is over. Kept deliberately narrow -
// anything not in this list (Doc-tests, Running, error:) passes through.
const PROGRESS = /^\s*(Compiling|Checking|Downloading|Downloaded|Updating|Locking|Finished)\b/

// `test tests::thing ... ok` - one line per passing test, dropped and counted.
const PASSING = /^test .+ \.\.\. ok$/

// Test binary header; the trailing `(target/debug/deps/crate-<hash>)` is noise.
const RUNNING = /^\s*Running (.+?)(?:\s+\([^()]*\))?\s*$/

// A failure detail block opens here and runs until the next block header,
// the `failures:` summary, or the next `test result:` line.
const BLOCK_OPEN = /^---- (.*) stdout ----$/
const BLOCK_END = /^(---- .* stdout ----|failures:|test result:)/

/**
 * Compact `cargo test` / `cargo t` stdout.
 *
 * Kept: failure blocks (`---- name stdout ----` + panic body, capped),
 * the `failures:` name list, `test result: ...` lines, and any line
 * mentioning `error` (a compile error must never be swallowed by the
 * progress filter).
 *
 * Returns the input unchanged when it does not look like cargo test output,
 * and never returns something longer than the input.
 */
export function compressCargoTest(
  text: string,
  caps: CargoTestCaps = {},
  rerun: string = 'cargo test',
): string {
  const maxFailures = caps.maxFailures ?? CARGO_TEST_DEFAULTS.maxFailures
  const maxLines = caps.maxLinesPerFailure ?? CARGO_TEST_DEFAULTS.maxLinesPerFailure

  const clean = stripAnsi(text)
  const looksLikeCargoTest =
    /^test result: (ok|FAILED)\./m.test(clean) ||
    /^running \d+ tests?$/m.test(clean) ||
    /^---- .* stdout ----$/m.test(clean) ||
    /^\s+(Compiling|Finished) /m.test(clean)
  if (!looksLikeCargoTest) return text

  const lines = clean.split('\n')
  const out: string[] = []
  let passingElided = 0
  let progressDropped = 0
  let blocks = 0
  let blocksElided = 0

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue

    const open = BLOCK_OPEN.exec(line)
    if (open) {
      const body: string[] = []
      let j = i + 1
      while (j < lines.length && !BLOCK_END.test(lines[j])) {
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
      out.push(line)
      if (body.length > maxLines) {
        out.push(...body.slice(0, maxLines))
        out.push(
          // Narrower than ${rerun} on purpose: one test, exact, unfiltered.
          `... +${body.length - maxLines} lines elided - raw: cargo test ${sq(open[1])} -- --exact # tk:raw`,
        )
      } else {
        out.push(...body)
      }
      continue
    }

    // Errors first, before any filter can eat the line.
    if (/error/i.test(line)) {
      out.push(line.replace(/\s+$/, ''))
      continue
    }
    // `     Running unittests src/lib.rs (target/debug/deps/mylib-1a2b3c)`:
    // the target matters, the artifact hash does not.
    const running = RUNNING.exec(line)
    if (running) {
      out.push(`Running ${running[1]}`)
      continue
    }
    if (PROGRESS.test(line)) {
      progressDropped += 1
      continue
    }
    if (PASSING.test(line)) {
      passingElided += 1
      continue
    }
    out.push(line.replace(/\s+$/, ''))
  }

  if (passingElided > 0) {
    out.push(`... +${passingElided} passing test${passingElided === 1 ? '' : 's'} elided - raw: ${rerun} # tk:raw`)
  }
  if (blocksElided > 0) {
    out.push(`... +${blocksElided} more failing test${blocksElided === 1 ? '' : 's'} elided - raw: ${rerun} # tk:raw`)
  }
  if (progressDropped > 0 && out.length === 0) {
    // Everything was progress: say so rather than returning nothing.
    out.push('cargo test: build succeeded, no test output')
  }

  const result = out.join('\n')
  return result.length < text.length ? result : text
}
