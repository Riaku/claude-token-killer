import { expect, test, tier } from 'claude-code/testing'

tier('user')

import { CARGO_TEST_DEFAULTS, compressCargoTest, planCargoTest } from '../hooks/cargotest.ts'

// ------------------------------------------------------------- fixtures
//
// Hand-written from the real shape of `cargo test` output (cargo is not
// installed in this sandbox): cargo colourises `Compiling`/`Finished`/`Running`
// even when piped, prints one `test x ... ok` line per passing test, and
// repeats failing names twice - once as a `---- name stdout ----` block, once
// in the `failures:` list.

const CARGO_TEST_OUT = [
  '\x1b[0m\x1b[1m\x1b[32m   Compiling\x1b[0m proc-macro2 v1.0.86',
  '\x1b[0m\x1b[1m\x1b[32m   Compiling\x1b[0m serde v1.0.203',
  '\x1b[0m\x1b[1m\x1b[32m    Finished\x1b[0m `test` profile [unoptimized + debuginfo] target(s) in 2.31s',
  '\x1b[0m\x1b[1m\x1b[32m     Running\x1b[0m unittests src/lib.rs (target/debug/deps/mylib-1a2b3c)',
  'running 10 tests',
  'test tests::test_alpha ... ok',
  'test tests::test_beta ... ok',
  'test tests::test_gamma ... ok',
  'test tests::test_delta ... ok',
  'test tests::test_epsilon ... ok',
  'test tests::test_zeta ... ok',
  'test tests::test_eta ... ok',
  'test tests::test_theta ... ok',
  'test tests::test_iota ... ok',
  'test tests::test_x ... FAILED',
  '',
  'failures:',
  '',
  '---- tests::test_x stdout ----',
  "thread 'tests::test_x' panicked at src/lib.rs:42:5:",
  'assertion `left == right` failed',
  '  left: 1',
  ' right: 2',
  'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
  '',
  'failures:',
  '    tests::test_x',
  '',
  'test result: FAILED. 9 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s',
  '',
  '\x1b[0m\x1b[1m\x1b[31merror\x1b[0m: test failed, to rerun pass `--lib`',
  '',
].join('\n')

// A build that never got as far as running a test.
const CARGO_COMPILE_ERROR = [
  '   Compiling mylib v0.1.0 (/home/dev/mylib)',
  'error[E0308]: mismatched types',
  ' --> src/main.rs:2:5',
  '  |',
  '2 |     let x: u32 = "s";',
  '  |            ---   ^^^ expected `u32`, found `&str`',
  '  |            |',
  '  |            expected due to this',
  '  |',
  '',
  'error: could not compile `mylib` (bin "mylib") due to 1 previous error',
  '',
].join('\n')

// ------------------------------------------------------------- planner

test('cargo test and the cargo t alias plan a cargo-test trim', () => {
  for (const cmd of [
    'cargo test',
    'cargo t',
    'cargo test --lib',
    'cargo test --all-features --workspace',
    'cargo test -v -- --test-threads=1',
    'cargo +nightly test',
    '/usr/local/bin/cargo test',
    'cargo test -- --exact tests::test_x',
  ]) {
    const p = planCargoTest(cmd)
    expect(p).not.toBeNull()
    expect(p!.kind).toBe('cargo-test')
  }
})

test('the planned command is the original string, unchanged', () => {
  const cmd = 'cargo  test   --lib --all-features'
  expect(planCargoTest(cmd)!.command).toBe(cmd)
})

test('--nocapture is the deliberate bypass', () => {
  // a user who asks for live test output must not get it trimmed
  for (const cmd of [
    'cargo test --nocapture',
    'cargo t --nocapture',
    'cargo test -- --nocapture',
    'cargo test --lib -- --nocapture --test-threads=1',
    'cargo test --nocapture=1',
  ]) {
    expect(planCargoTest(cmd)).toBeNull()
  }
})

test('machine formats and help bail out', () => {
  for (const cmd of [
    'cargo test --json',
    'cargo test --message-format=json',
    'cargo test --message-format json',
    'cargo test --help',
    'cargo test -h',
    'cargo test --version',
    'cargo test -V',
  ]) {
    expect(planCargoTest(cmd)).toBeNull()
  }
})

test('other cargo subcommands are not planned', () => {
  expect(planCargoTest('cargo build')).toBeNull()
  expect(planCargoTest('cargo bench')).toBeNull()
  expect(planCargoTest('cargo nextest run')).toBeNull()
  expect(planCargoTest('cargo')).toBeNull()
  expect(planCargoTest('')).toBeNull()
  expect(planCargoTest('rustup test')).toBeNull()
})

test('pipes, separators, redirects, substitution and comments bail out', () => {
  for (const cmd of [
    'cargo test | tail -20',
    'cargo test && git add .',
    'cargo test || true',
    'cargo test; echo done',
    'cargo test > out.txt',
    'cargo test 2>&1',
    'cargo test < /dev/null',
    'echo $(cargo test)',
    'cargo test ${ARGS}',
    'cargo test `date`',
    'cargo test # tk:raw',
    'cargo test\ncargo build',
  ]) {
    expect(planCargoTest(cmd)).toBeNull()
  }
})

// ------------------------------------------------------------- compressor

test('progress lines and passing tests go, failures stay', () => {
  const out = compressCargoTest(CARGO_TEST_OUT)

  // colour is stripped before any parsing
  expect(out).not.toContain('\x1b')

  // build progress: noise
  expect(out).not.toContain('Compiling proc-macro2')
  expect(out).not.toContain('Finished `test` profile')

  // the artifact hash in the Running header is noise, the target is not
  expect(out).toContain('Running unittests src/lib.rs')
  expect(out).not.toContain('target/debug/deps')

  // one line per passing test: gone, but accounted for
  expect(out).not.toContain('test tests::test_alpha ... ok')
  expect(out).toContain('... +9 passing tests elided - raw: cargo test # tk:raw')

  // the failure report survives whole
  expect(out).toContain('test tests::test_x ... FAILED')
  expect(out).toContain('---- tests::test_x stdout ----')
  expect(out).toContain("thread 'tests::test_x' panicked at src/lib.rs:42:5:")
  expect(out).toContain('assertion `left == right` failed')
  expect(out).toContain('  left: 1')
  expect(out).toContain(' right: 2')
  expect(out).toContain('failures:\n    tests::test_x')

  // per-binary result and the tail error survive
  expect(out).toContain('test result: FAILED. 9 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out')
  expect(out).toContain('error: test failed, to rerun pass `--lib`')
})

test('compile errors are never swallowed by the progress filter', () => {
  const out = compressCargoTest(CARGO_COMPILE_ERROR)
  expect(out).toContain('error[E0308]: mismatched types')
  expect(out).toContain('--> src/main.rs:2:5')
  expect(out).toContain('2 |     let x: u32 = "s";')
  expect(out).toContain('error: could not compile `mylib`')
  expect(out).not.toContain('   Compiling mylib')
})

test('a passing run still reports its result lines', () => {
  const ok = [
    '   Compiling mylib v0.1.0',
    '    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.42s',
    '     Running unittests src/lib.rs (target/debug/deps/mylib-3333333)',
    'running 3 tests',
    'test tests::a ... ok',
    'test tests::b ... ok',
    'test tests::c ... ok',
    '',
    'test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
    '',
  ].join('\n')
  const out = compressCargoTest(ok)
  expect(out).toContain('test result: ok. 3 passed; 0 failed')
  expect(out).toContain('... +3 passing tests elided')
  expect(out).not.toContain('test tests::a ... ok')
})

test('a failure block longer than the cap is elided with an exact re-run', () => {
  const block = [
    'running 1 test',
    'test tests::big ... FAILED',
    '',
    '---- tests::big stdout ----',
    ...Array.from({ length: 45 }, (_, i) => `  frame ${i}: value ${i}`),
    '',
    'failures:',
    '    tests::big',
    '',
    'test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  ].join('\n')

  const out = compressCargoTest(block)
  expect(out).toContain('  frame 0: value 0')
  expect(out).toContain('  frame 29: value 29')
  expect(out).not.toContain('  frame 30: value 30')
  expect(out).toContain(
    '... +15 lines elided - raw: cargo test tests::big -- --exact # tk:raw',
  )
  // the failure name list is kept even when the detail block is trimmed
  expect(out).toContain('failures:\n    tests::big')
})

test('caps are configurable', () => {
  const block = [
    '---- tests::big stdout ----',
    ...Array.from(
      { length: 12 },
      (_, i) => `  frame ${i}: assertion failed, left ${i}000000 right 0`,
    ),
  ].join('\n')
  const out = compressCargoTest(block, { maxLinesPerFailure: 2 })
  expect(out).toContain('  frame 0: assertion failed')
  expect(out).toContain('  frame 1: assertion failed')
  expect(out).not.toContain('  frame 2:')
  expect(out).toContain('... +10 lines elided')
})

test('failing tests past maxFailures are summarized', () => {
  const body = Array.from(
    { length: 12 },
    (_, i) => `---- tests::t${i} stdout ----\nboom ${i}`,
  ).join('\n')
  const text = [
    'running 12 tests',
    ...body.split('\n'),
    'failures:',
    '    tests::t0',
    'test result: FAILED. 0 passed; 12 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s',
  ].join('\n')

  const out = compressCargoTest(text)
  expect(out).toContain('---- tests::t0 stdout ----')
  expect(out).toContain('---- tests::t9 stdout ----')
  expect(out).not.toContain('---- tests::t10 stdout ----')
  expect(out).toContain('... +2 more failing tests elided - raw: cargo test # tk:raw')
})

test('the default caps are the documented ones', () => {
  expect(CARGO_TEST_DEFAULTS.maxFailures).toBe(10)
  expect(CARGO_TEST_DEFAULTS.maxLinesPerFailure).toBe(30)
})

test('non-cargo output passes through untouched', () => {
  for (const text of [
    '',
    'hello world',
    '## main\n M a.txt\n?? b.txt',
    'error: could not find `Cargo.toml` in `/tmp` or any parent directory',
  ]) {
    expect(compressCargoTest(text)).toBe(text)
  }
})

test('compression never inflates', () => {
  for (const text of [
    CARGO_TEST_OUT,
    CARGO_COMPILE_ERROR,
    'running 1 test\ntest a ... ok\n',
    'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
    'x',
  ]) {
    expect(compressCargoTest(text).length).toBeLessThanOrEqual(text.length)
  }
})

test('a tiny run with nothing to save is returned as-is', () => {
  const tiny = 'running 1 test\ntest a ... ok\n'
  expect(compressCargoTest(tiny)).toBe(tiny)
})
