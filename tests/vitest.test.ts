import { expect, test, tier } from 'claude-code/testing'

tier('user')

import { compressVitest, planVitest, DEFAULT_VITEST_CAPS } from '../hooks/vitest.ts'

// ------------------------------------------------------------- planner

test('vitest and its runner wrappers plan a vitest trim', () => {
  for (const cmd of [
    'vitest',
    'vitest run',
    'vitest run tests/a.test.ts',
    'npx vitest run',
    'npx vitest',
    'pnpm vitest run --coverage',
    'yarn vitest run',
    'bunx vitest run',
    '/app/node_modules/.bin/vitest run',
  ]) {
    const p = planVitest(cmd)
    expect(p).not.toBeNull()
    expect(p!.kind).toBe('vitest')
    expect(p!.command).toBe(cmd.trim())
  }
})

test('user-chosen output formats and help flags bail out', () => {
  for (const cmd of [
    'vitest run --reporter=json',
    'vitest run --reporter json',
    'vitest run --reporters=verbose',
    'vitest --ui',
    'npx vitest --ui --coverage',
    'vitest --help',
    'vitest -h',
    'vitest --version',
  ]) {
    expect(planVitest(cmd)).toBeNull()
  }
})

test('shell control syntax bails out', () => {
  for (const cmd of [
    'vitest run | tail -20',
    'vitest run && echo ok',
    'vitest run || true',
    'vitest run; echo done',
    'vitest run > out.log',
    'vitest run $(ls tests)',
    'vitest run ${ARGS}',
    'vitest run `echo x`',
    'vitest run # tk:raw',
    'vitest run\necho hi',
    "vitest run 'unbalanced",
  ]) {
    expect(planVitest(cmd)).toBeNull()
  }
})

test('non-vitest commands are not planned', () => {
  expect(planVitest('jest')).toBeNull()
  expect(planVitest('npm test')).toBeNull()
  expect(planVitest('vite build')).toBeNull()
  expect(planVitest('npx jest')).toBeNull()
  expect(planVitest('vitestx run')).toBeNull()
  expect(planVitest('')).toBeNull()
})

// ---------------------------------------------------------- compressor

// Realistic vitest 1.6 passing run, colourised: ANSI codes everywhere.
const VITEST_PASS = [
  '\x1b[1m\x1b[36m RUN \x1b[39m\x1b[22m \x1b[90mv1.6.0\x1b[39m /app',
  '',
  ' \x1b[32m✓\x1b[39m tests/math.test.ts (3 tests) \x1b[90m12ms\x1b[39m',
  ' \x1b[32m✓\x1b[39m tests/str.test.ts (2 tests) \x1b[90m4ms\x1b[39m',
  '',
  ' \x1b[2mTest Files \x1b[22m \x1b[1m\x1b[32m2 passed\x1b[39m\x1b[22m (2)',
  ' \x1b[2m     Tests \x1b[22m \x1b[1m\x1b[32m5 passed\x1b[39m\x1b[22m (5)',
  ' \x1b[2m  Start at \x1b[22m 10:00:00',
  ' \x1b[2m  Duration \x1b[22m 1.02s \x1b[2m(transform 120ms, setup 0ms, collect 200ms, tests 30ms)\x1b[22m',
  '',
].join('\n')

// Realistic vitest 1.6 failing run: one failing file, per-test marker,
// Failed Tests banner, assertion diff, stack frame, final summary block.
const VITEST_FAIL = [
  ' RUN  v1.6.0 /app',
  '',
  ' ❯ tests/math.test.ts (3 tests | 1 failed) 15ms',
  '   × add > adds numbers 5ms',
  ' ✓ tests/str.test.ts (2 tests) 4ms',
  ' ↓ tests/slow.test.ts (2 tests | 2 skipped)',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  tests/math.test.ts > add > adds numbers',
  'AssertionError: expected 2 to be 3 // Object.is equality',
  '',
  '- Expected',
  '+ Received',
  '',
  '- 3',
  '+ 2',
  '',
  ' ❯ tests/math.test.ts:12:18',
  '     10|   const add = (a, b) => a + b',
  '     11|',
  '     12|   expect(add(1, 1)).toBe(3)',
  '       |                  ^',
  '     13| })',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' Test Files  1 failed | 1 passed (2)',
  '      Tests  1 failed | 4 passed (5)',
  '   Start at  10:00:00',
  '   Duration  1.10s (transform 100ms, setup 0ms, collect 150ms, tests 40ms)',
  '',
].join('\n')

test('happy path: per-file lines and the compact summary survive, decoration does not', () => {
  const out = compressVitest(VITEST_PASS)
  expect(out).toContain('✓ tests/math.test.ts (3 tests) 12ms')
  expect(out).toContain('✓ tests/str.test.ts (2 tests) 4ms')
  expect(out).toContain('Test Files 2 passed (2)')
  expect(out).toContain('Tests 5 passed (5)')
  expect(out).toContain('Duration 1.02s')
  // ANSI, the RUN banner, `Start at` and the timing breakdown are gone
  expect(out).not.toContain('\x1b[')
  expect(out).not.toContain('RUN')
  expect(out).not.toContain('Start at')
  expect(out).not.toContain('transform')
  // the summary is one line, not four
  expect(out.split('\n').filter((l) => l.includes('Test Files'))).toHaveLength(1)
  expect(out.length).toBeLessThan(VITEST_PASS.length)
})

test('failing run: failure block, stack frame and summary counts are kept', () => {
  const out = compressVitest(VITEST_FAIL)
  expect(out).toContain('FAIL  tests/math.test.ts > add > adds numbers')
  expect(out).toContain('AssertionError: expected 2 to be 3')
  expect(out).toContain('expect(add(1, 1)).toBe(3)')
  expect(out).toContain('❯ tests/math.test.ts (3 tests | 1 failed) 15ms')
  expect(out).toContain('× add > adds numbers 5ms')
  expect(out).toContain('↓ tests/slow.test.ts (2 tests | 2 skipped)')
  expect(out).toContain('Test Files 1 failed | 1 passed (2)')
  expect(out).toContain('Tests 1 failed | 4 passed (5)')
  // banner + separator decoration is gone
  expect(out).not.toContain('Failed Tests 1')
  expect(out).not.toContain('⎯⎯')
  expect(out.length).toBeLessThan(VITEST_FAIL.length)
})

test('lines inside a failure block keep their indentation', () => {
  const out = compressVitest(VITEST_FAIL)
  expect(out).toContain('     12|   expect(add(1, 1)).toBe(3)')
})

test('failure blocks are capped per block with a tk:raw marker', () => {
  const body = Array.from({ length: 40 }, (_, i) => `frame line ${i}`)
  const raw = [
    ' RUN  v1.6.0 /app',
    ' ❯ tests/a.test.ts (1 test | 1 failed) 9ms',
    '',
    '⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯',
    ' FAIL  tests/a.test.ts > boom',
    ...body,
    '',
    ' Test Files  1 failed (1)',
    '      Tests  1 failed (1)',
  ].join('\n')
  const out = compressVitest(raw, { ...DEFAULT_VITEST_CAPS, maxLinesPerBlock: 10 })
  expect(out).toContain('frame line 0')
  expect(out).toContain('frame line 9')
  expect(out).not.toContain('frame line 10')
  expect(out).not.toContain('frame line 39')
  expect(out).toContain('FAIL  tests/a.test.ts > boom')
  expect(out).toContain('... +30 lines elided - raw: vitest run # tk:raw')
  expect(out).toContain('Tests 1 failed (1)')
})

test('more failures than maxFailures elide whole blocks with a tk:raw marker', () => {
  const blocks = [0, 1, 2].flatMap((i) => [` FAIL  tests/a.test.ts > boom_${i}`, `Error: boom ${i}`])
  const raw = [
    ' RUN  v1.6.0 /app',
    '',
    '⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯',
    ...blocks,
    '',
    ' Test Files  1 failed (1)',
    '      Tests  3 failed (3)',
  ].join('\n')
  const out = compressVitest(raw, { ...DEFAULT_VITEST_CAPS, maxFailures: 2 })
  expect(out).toContain('boom_0')
  expect(out).toContain('boom_1')
  expect(out).not.toContain('boom_2')
  expect(out).toContain('... +1 failure block elided - raw: vitest run # tk:raw')
  // counts still tell the whole story
  expect(out).toContain('Tests 3 failed (3)')
})

test('captured stdout/stderr blocks are kept, not dropped', () => {
  const raw = [
    ' RUN  v1.6.0 /app',
    '',
    'stdout | tests/log.test.ts > logs',
    'hello from the test',
    '',
    ' ✓ tests/log.test.ts (1 test) 5ms',
    '',
    ' Test Files  1 passed (1)',
    '      Tests  1 passed (1)',
  ].join('\n')
  const out = compressVitest(raw)
  expect(out).toContain('stdout | tests/log.test.ts > logs')
  expect(out).toContain('hello from the test')
  expect(out).toContain('Tests 1 passed (1)')
})

test('a startup error under the RUN banner is never swallowed', () => {
  const raw = [
    ' RUN  v1.6.0 /app',
    '',
    "Error: Cannot find module '/app/vitest.config.ts'",
    '    at Module._resolveFilename (node:internal/modules/cjs/loader:1215:15)',
    '',
  ].join('\n')
  const out = compressVitest(raw)
  expect(out).toContain("Error: Cannot find module '/app/vitest.config.ts'")
  expect(out).not.toContain('RUN')
})

test('progress bars and spinners are stripped', () => {
  const raw = [
    ' RUN  v1.6.0 /app',
    '',
    '⠙ tests/math.test.ts',
    '⠹ tests/str.test.ts',
    '████████░░░░░░░░ 52%',
    ' ✓ tests/math.test.ts (3 tests) 12ms',
    '',
    ' Test Files  1 passed (1)',
    '      Tests  3 passed (3)',
  ].join('\n')
  const out = compressVitest(raw)
  expect(out).not.toContain('⠙')
  expect(out).not.toContain('█')
  expect(out).toContain('✓ tests/math.test.ts (3 tests) 12ms')
})

test('the rerun command can name the exact invocation in markers', () => {
  const body = Array.from({ length: 12 }, (_, i) => `frame ${i}`)
  const raw = [
    ' RUN  v1.6.0 /app',
    '⎯⎯⎯ Failed Tests 1 ⎯⎯⎯',
    ' FAIL  tests/a.test.ts > boom',
    ...body,
    ' Test Files  1 failed (1)',
  ].join('\n')
  const out = compressVitest(raw, { ...DEFAULT_VITEST_CAPS, maxLinesPerBlock: 2 }, 'npx vitest run')
  expect(out).toContain('- raw: npx vitest run # tk:raw')
})

test('never inflates: compressed output is shorter than the input', () => {
  const raw = [
    ' RUN  v1.6.0 /app',
    '',
    ' ✓ tests/a.test.ts (1 test) 3ms',
    '',
    ' Test Files  1 passed (1)',
    '      Tests  1 passed (1)',
    '   Start at  10:00:00',
    '   Duration  0.50s',
    '',
  ].join('\n')
  const out = compressVitest(raw)
  expect(out.length).toBeLessThanOrEqual(raw.length)
  expect(out).toContain('✓ tests/a.test.ts (1 test) 3ms')
})

test('unrecognized output is returned unchanged', () => {
  const raw = 'No test files found, exiting with code 1\n'
  expect(compressVitest(raw)).toBe(raw)
  const prose = 'just some random text that is not a vitest run at all\n'
  expect(compressVitest(prose)).toBe(prose)
})
