import { expect, test, tier } from 'claude-code/testing'

tier('user')

import { GO_TEST_DEFAULTS, compressGoTest, planGoTest } from '../hooks/gotest.ts'

// ------------------------------------------------------------- fixtures
//
// Hand-written from the real shape of `go test -v` / `go test ./...` output
// (go is not installed in this sandbox). Note what the two modes share: the
// package result line is tabwriter-padded in both, and a failure always
// arrives as `--- FAIL: Name (0.00s)` followed by indented output from the
// assertion itself - that indented body is the part that must never be lost.

const GO_VERBOSE = [
  '=== RUN   TestFoo',
  '=== PAUSE TestFoo',
  '=== CONT  TestFoo',
  '--- FAIL: TestFoo (0.00s)',
  '    foo_test.go:12: want 1, got 2',
  '    --- FAIL: TestFoo/sub (0.00s)',
  '        foo_test.go:20: nested want a, got b',
  '=== RUN   TestBar',
  '--- PASS: TestBar (0.00s)',
  '=== RUN   TestBaz',
  '--- PASS: TestBaz (0.00s)',
  'FAIL',
  'exit status 1',
  'FAIL\texample.com/pkg\t0.312s',
  '=== RUN   TestQux',
  '--- PASS: TestQux (0.00s)',
  'PASS',
  'ok  \texample.com/good\t0.111s',
  'ok  \texample.com/cached\t(cached)',
  '?   \texample.com/notests\t[no test files]',
  'FAIL\texample.com/broken [build failed]',
  '',
].join('\n')

// The same run with go's colour codes around the result lines.
const GO_COLOURED = [
  '\x1b[32m=== RUN   TestFoo\x1b[0m',
  '\x1b[31m--- FAIL: TestFoo (0.00s)\x1b[0m',
  '    foo_test.go:12: want 1, got 2',
  '\x1b[32mok  \x1b[0m\x1b[1mexample.com/good\x1b[0m\t0.111s',
  '\x1b[31mFAIL\x1b[0m\texample.com/pkg\t0.312s',
  '',
].join('\n')

// A package that never compiled: no test ever ran.
const GO_BUILD_FAILED = [
  '# example.com/broken',
  './broken.go:5:2: undefined: nope',
  'FAIL\texample.com/broken [build failed]',
  'FAIL',
  '',
].join('\n')

// ------------------------------------------------------------- planner

test('go test variants plan a go-test trim', () => {
  for (const cmd of [
    'go test',
    'go test ./...',
    'go test -v',
    'go test -v -run TestFoo ./pkg',
    'go test -race -count=1 ./...',
    '/usr/local/go/bin/go test ./internal/...',
  ]) {
    const p = planGoTest(cmd)
    expect(p).not.toBeNull()
    expect(p!.kind).toBe('go-test')
  }
})

test('the planned command is the original string, unchanged', () => {
  const cmd = 'go   test  -v   ./...'
  expect(planGoTest(cmd)!.command).toBe(cmd)
})

test('-json (machine format) and help bail out', () => {
  for (const cmd of [
    'go test -json ./...',
    'go test -json=1 ./...',
    'go test --json ./...',
    'go test -h',
    'go test --help',
    'go test -help',
    'go test -version',
  ]) {
    expect(planGoTest(cmd)).toBeNull()
  }
})

test('other go subcommands are not planned', () => {
  expect(planGoTest('go build ./...')).toBeNull()
  expect(planGoTest('go run .')).toBeNull()
  expect(planGoTest('go vet ./...')).toBeNull()
  expect(planGoTest('go')).toBeNull()
  expect(planGoTest('')).toBeNull()
  expect(planGoTest('gofmt -l .')).toBeNull()
})

test('pipes, separators, redirects, substitution and comments bail out', () => {
  for (const cmd of [
    'go test ./... | grep FAIL',
    'go test ./... && git add .',
    'go test ./... || true',
    'go test ./...; echo done',
    'go test ./... > out.txt',
    'go test ./... 2>&1',
    'go test $(go list ./...)',
    'go test ${PKGS}',
    'go test `go list ./...`',
    'go test ./... # tk:raw',
    'go test ./...\ngo build .',
  ]) {
    expect(planGoTest(cmd)).toBeNull()
  }
})

// ------------------------------------------------------------- compressor

test('lifecycle noise and passing tests go, failures keep their output', () => {
  const out = compressGoTest(GO_VERBOSE)

  expect(out).not.toContain('=== RUN')
  expect(out).not.toContain('=== PAUSE')
  expect(out).not.toContain('=== CONT')
  expect(out).not.toContain('--- PASS:')

  // the failure block, nested subtest included, survives with its assertions
  expect(out).toContain('--- FAIL: TestFoo (0.00s)')
  expect(out).toContain('    foo_test.go:12: want 1, got 2')
  expect(out).toContain('    --- FAIL: TestFoo/sub (0.00s)')
  expect(out).toContain('        foo_test.go:20: nested want a, got b')

  // package results compacted onto one line each
  expect(out).toContain('FAIL example.com/pkg 0.312s')
  expect(out).toContain('ok example.com/good 0.111s')
  expect(out).toContain('ok example.com/cached (cached)')
  expect(out).toContain('? example.com/notests [no test files]')
  expect(out).toContain('example.com/broken [build failed]')
  expect(out).not.toContain('\t')

  // and the passes are accounted for
  expect(out).toContain('... +3 passing tests elided - raw: go test -v # tk:raw')
})

test('ANSI colour codes are stripped before parsing', () => {
  const out = compressGoTest(GO_COLOURED)
  expect(out).not.toContain('\x1b')
  expect(out).toContain('--- FAIL: TestFoo (0.00s)')
  expect(out).toContain('    foo_test.go:12: want 1, got 2')
  expect(out).toContain('ok example.com/good 0.111s')
  expect(out).toContain('FAIL example.com/pkg 0.312s')
})

test('a build failure keeps the compiler complaint', () => {
  const out = compressGoTest(GO_BUILD_FAILED)
  expect(out).toContain('./broken.go:5:2: undefined: nope')
  expect(out).toContain('example.com/broken [build failed]')
})

test('a failure block longer than the cap is elided with a re-run of that test', () => {
  const text = [
    '--- FAIL: TestBig (0.01s)',
    ...Array.from({ length: 30 }, (_, i) => `    big_test.go:${i}: mismatch ${i}`),
    'FAIL\texample.com/big\t0.5s',
  ].join('\n')

  const out = compressGoTest(text)
  expect(out).toContain('    big_test.go:0: mismatch 0')
  expect(out).toContain('    big_test.go:19: mismatch 19')
  expect(out).not.toContain('    big_test.go:20: mismatch 20')
  expect(out).toContain("... +10 lines elided - raw: go test -run '^TestBig$' -v # tk:raw")
  // the elision does not eat the package result
  expect(out).toContain('FAIL example.com/big 0.5s')
})

test('caps are configurable', () => {
  const text = [
    '--- FAIL: TestBig (0.01s)',
    ...Array.from({ length: 12 }, (_, i) => `    big_test.go:${i}: mismatch got ${i} want ${i}000000`),
    'FAIL\texample.com/big\t0.5s',
  ].join('\n')
  const out = compressGoTest(text, { maxLinesPerFailure: 1 })
  expect(out).toContain('    big_test.go:0: mismatch')
  expect(out).not.toContain('    big_test.go:1:')
  expect(out).toContain('... +11 lines elided')
  expect(out).toContain('FAIL example.com/big 0.5s')
})

test('failing tests past maxFailures are summarized', () => {
  const body = Array.from(
    { length: 25 },
    (_, i) => `--- FAIL: TestF${i} (0.00s)\n    f_test.go:1: bad ${i}`,
  ).join('\n')
  const out = compressGoTest(body + '\nFAIL\texample.com/m\t0.9s', {}, 'go test ./... -count=1')

  expect(out).toContain('--- FAIL: TestF0 (0.00s)')
  expect(out).toContain('--- FAIL: TestF19 (0.00s)')
  expect(out).not.toContain('--- FAIL: TestF20')
  // The hint has to name the command that ran, not a generic one: `go test -v`
  // would run every package in the module, not the ones the caller picked.
  expect(out).toContain('... +5 more failing tests elided - raw: go test ./... -count=1 # tk:raw')
})

test('the default caps are the documented ones', () => {
  expect(GO_TEST_DEFAULTS.maxFailures).toBe(20)
  expect(GO_TEST_DEFAULTS.maxLinesPerFailure).toBe(20)
})

test('non-go-test output passes through untouched', () => {
  for (const text of [
    '',
    'hello world',
    '## main\n M a.txt',
    'go: cannot find main module, but found .git/config in /home/dev',
    '{"Time":"2026-01-01T00:00:00Z","Action":"run","Package":"p","Test":"TestX"}',
  ]) {
    expect(compressGoTest(text)).toBe(text)
  }
})

test('compression never inflates', () => {
  for (const text of [
    GO_VERBOSE,
    GO_COLOURED,
    GO_BUILD_FAILED,
    '=== RUN   TestA\n--- PASS: TestA (0.00s)\nok  \tpkg\t0.1s\n',
    'x',
  ]) {
    expect(compressGoTest(text).length).toBeLessThanOrEqual(text.length)
  }
})

test('a tiny verbose run with nothing to save is returned as-is', () => {
  const tiny = '=== RUN   TestA\n--- PASS: TestA (0.00s)\nok  \tpkg\t0.1s\n'
  expect(compressGoTest(tiny)).toBe(tiny)
})
