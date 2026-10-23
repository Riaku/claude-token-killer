// `dotnet build` and `dotnet test`.
//
// Both are the same problem as `go build` and `cargo test`: the compiler's
// diagnostics are the answer, and the restore chatter, the per-project
// `-> bin/Debug/...` lines and the copyright banner are the noise between them.
// `dotnet test` adds one more: a `Passed X [1 ms]` line per test, so a suite of
// two hundred is two hundred lines that say "passed".
//
// What survives: every compiler diagnostic (deduplicated - MSBuild repeats one
// warning per referencing project), the failed test's name with its error
// message and first stack frames, the per-project build outputs, and the summary
// lines (`Build succeeded`, `Failed! - Failed: 1, Passed: 11`). What goes:
// restore chatter, the banner, the individual passes, and the rest of a stack
// trace.
//
// Compression-only, never inflating.

import { stripAnsi } from './ansi.ts'
import { UNSAFE } from './shell.ts'

export type DotnetKind = 'dotnet-build' | 'dotnet-test'
export type DotnetPlan = { kind: DotnetKind; command: string }
export type DotnetCaps = { maxDiagLines: number }

const KINDS: ReadonlyArray<{ kind: DotnetKind; verb: string }> = [
  { kind: 'dotnet-build', verb: 'build' },
  { kind: 'dotnet-test', verb: 'test' },
]

// Restore chatter, the test runner banner, and the runner's own timing lines.
const NOISE = /^\s*(Determining projects to restore|All projects are up-to-date|Restored |Starting test execution|A total of \d+ test (file|files)|Microsoft \(R\) Test|Copyright \(c\)|Test run for |VSTest|Duration:|Test Run Successful|Test Run Failed)/

// A compiler diagnostic: `path(3,9): warning CS0168: ...` or `path: error CA1`.
const DIAG = /:\s*(error|warning)\s+[A-Z]+[0-9]+/

// A single passing test. The count is kept; the lines are not.
const PASSED = /^\s+Passed\s+\S+/

const KEEP = [
  /^Build (succeeded|FAILED)/,
  /^\s*\d+ (Warning|Error)\(s\)/,
  /^Time Elapsed/,
  /^PASSED!|^FAILED!/i,
  /-> /,
  /^\s+Failed\s+\S+/,
  /^\s+(Error Message|Stack Trace):/,
  /^\s+at /,
  /Exception/,
  /:\s*(error|warning)\s+[A-Z]+[0-9]+/,
]

// A test failure's message block: the lines after `Error Message:` are the
// assertion, and `Expected:`/`Actual:` are the only part that says why.
const DETAIL = /^\s+(Error Message|Stack Trace):/
const FRAMES = /^\s+Stack Trace:/
const AT_FRAME = /^\s+at /

/** Plan a single `dotnet build` or `dotnet test` invocation. */
export function planDotnet(command: string): DotnetPlan | null {
  const raw = command.trim()
  if (!raw || UNSAFE.test(raw)) return null
  const tokens = raw.split(/\s+/).map((t) => t.toLowerCase())
  if (tokens[0].replace(/^&/, '').replace(/\.exe$/, '') !== 'dotnet') return null
  const family = KINDS.find((k) => tokens[1] === k.verb)
  if (!family) return null
  return { kind: family.kind, command: raw }
}

/**
 * The diagnostic without its trailing `[project]` suffix.
 *
 * MSBuild prints one diagnostic once per project that compiles the file, so the
 * project suffix is the only part that differs. The file and line stay in the
 * key: two different files that produce the same message are two findings.
 */
function diagKey(line: string): string {
  return line.replace(/\s*\[[^\]]*\]\s*$/, '').trim()
}

/**
 * Compact a `dotnet build` / `dotnet test` transcript: diagnostics deduplicated
 * and capped, passing tests counted instead of listed, the failed test's error
 * and first stack frames kept, summary lines kept. Returns the input unchanged
 * when there is nothing to remove or the result is not shorter.
 */
export function compressDotnet(raw: string, caps: DotnetCaps, command = ''): string {
  const clean = stripAnsi(raw)
  const lines = clean.split('\n').map((l) => l.replace(/\s+$/, ''))

  // Which lines survive. Three ways in: a recognised summary or diagnostic
  // line, a line the assertion message needs (`Expected: 4`), and the first
  // frames of a stack trace - which are only meaningful right after the block
  // that opened them, so they are counted from there.
  const marks = lines.reduce<{ keep: number[]; detail: number; frames: number }>((acc, line, at) => {
    if (line.trim() === '' || NOISE.test(line)) return acc
    if (KEEP.some((re) => re.test(line))) {
      acc.keep.push(at)
      if (DETAIL.test(line)) acc.detail = 4
      if (FRAMES.test(line)) acc.frames = 4
      return acc
    }
    if (acc.frames > 0 && AT_FRAME.test(line)) {
      acc.keep.push(at)
      acc.frames -= 1
      return acc
    }
    if (acc.detail > 0) {
      acc.keep.push(at)
      acc.detail -= 1
    }
    return acc
  }, { keep: [], detail: 0, frames: 0 })

  if (marks.keep.length === 0) return raw

  const cap = Math.max(0, caps.maxDiagLines)
  const seen: string[] = []
  const collapse = { repeated: 0 }
  const out = marks.keep.map((at) => lines[at]).reduce<string[]>((acc, line) => {
    if (!DIAG.test(line)) {
      acc.push(line.trimEnd())
      return acc
    }
    const key = diagKey(line)
    if (seen.includes(key)) {
      collapse.repeated += 1
      return acc
    }
    seen.push(key)
    if (seen.length > cap) return acc
    acc.push(line.trimEnd())
    return acc
  }, [])

  if (seen.length > cap) out.push(`... +${seen.length - cap} more diagnostics`)
  if (collapse.repeated > 0) out.push(`... ${collapse.repeated} repeated per-project diagnostics collapsed`)
  const passes = lines.filter((line) => PASSED.test(line)).length
  if (passes > 0) out.unshift(`(${passes} test${passes === 1 ? '' : 's'} passed)`)

  const hint = command ? `# raw: ${command} # tk:raw` : '# raw: re-run with # tk:raw'
  const result = [...out, hint].join('\n')
  return result.length < raw.length ? result : raw
}
