import { expect, test, tier } from 'claude-code/testing'

tier('user')

import { compressPytest, planPytest, DEFAULT_PYTEST_CAPS } from '../hooks/pytest.ts'

// ------------------------------------------------------------- planner

test('pytest and its invocation shapes plan a pytest trim', () => {
  for (const cmd of [
    'pytest',
    'pytest tests/',
    'py.test tests/test_math.py',
    'python -m pytest',
    'python3 -m pytest tests/ -x -q',
    '/usr/local/bin/pytest tests/',
  ]) {
    const p = planPytest(cmd)
    expect(p).not.toBeNull()
    expect(p!.kind).toBe('pytest')
    // Compression-only: the command is handed back untouched.
    expect(p!.command).toBe(cmd.trim())
  }
})

test('live-output and machine-format flags bail out', () => {
  for (const cmd of [
    'pytest -s',
    'pytest --capture=no',
    'pytest --capture no',
    'pytest --pdb',
    'pytest -vs',
    'pytest --trace',
    'pytest --json report.json',
    'pytest --json-report',
    'pytest --junit-xml out.xml',
    'pytest --help',
    'pytest -h',
    'pytest --version',
  ]) {
    expect(planPytest(cmd)).toBeNull()
  }
})

test('flags that only look like -s do not bail', () => {
  // `-rs` is `-r s` (report skips), not capture-off; `--capture=fd` is the
  // pytest default, so there is nothing live to protect.
  for (const cmd of ['pytest -rs', 'pytest -q --capture=fd', 'pytest -k "not slow"', 'pytest -x -q tests/']) {
    expect(planPytest(cmd)).not.toBeNull()
  }
})

test('shell control syntax bails out', () => {
  for (const cmd of [
    'pytest | tee out.log',
    'pytest && echo done',
    'pytest || true',
    'pytest; rm -rf build',
    'pytest > results.txt',
    'pytest $(find . -name test_*)',
    'pytest ${TESTDIR}',
    'pytest `echo tests/`',
    'pytest tests/ # tk:raw',
    'pytest tests/\npytest other/',
    "pytest 'unbalanced",
  ]) {
    expect(planPytest(cmd)).toBeNull()
  }
})

test('non-pytest commands are not planned', () => {
  expect(planPytest('git status')).toBeNull()
  expect(planPytest('python -m unittest')).toBeNull()
  expect(planPytest('pytester run')).toBeNull()
  expect(planPytest('')).toBeNull()
})

// ---------------------------------------------------------- compressor

// Realistic pytest 8 output: session banner, dot progress with percent
// column, a FAILURES block, short test summary, final counts banner.
const PYTEST_FAIL_RUN = [
  '============================= test session starts ==============================',
  'platform linux -- Python 3.12.1, pytest-8.2.0, pluggy-1.5.0',
  'rootdir: /app',
  'plugins: anyio-4.2.0, cov-4.1.0',
  'collected 7 items',
  '',
  'tests/test_math.py ....F..                                             [ 85%]',
  'tests/test_str.py .                                                    [100%]',
  '',
  '=================================== FAILURES ===================================',
  '______________________________ test_division_fail ______________________________',
  '',
  '    def test_division_fail():',
  '>       assert 1 / 0 == 1',
  'E       ZeroDivisionError: division by zero',
  '',
  'tests/test_math.py:12: ZeroDivisionError',
  '=========================== short test summary info ============================',
  'FAILED tests/test_math.py::test_division_fail - ZeroDivisionError: division ...',
  '========================= 1 failed, 6 passed in 0.12s ==========================',
  '',
].join('\n')

test('happy path: keeps failure block, summary line, compact counts; drops decoration', () => {
  const out = compressPytest(PYTEST_FAIL_RUN)
  expect(out).toContain('test_division_fail')
  expect(out).toContain('ZeroDivisionError: division by zero')
  expect(out).toContain('FAILED tests/test_math.py::test_division_fail')
  expect(out).toContain('6 passed, 1 failed')
  // banner decoration, plugin metadata and dot noise are gone
  expect(out).not.toContain('====')
  expect(out).not.toContain('[ 85%]')
  expect(out).not.toContain('test session starts')
  expect(out).not.toContain('plugins:')
  expect(out).not.toContain('platform linux')
  // the one metadata line worth keeping survives
  expect(out).toContain('collected 7 items')
  // traceback indentation is preserved, not squashed
  expect(out).toContain('E       ZeroDivisionError: division by zero')
  expect(out.length).toBeLessThan(PYTEST_FAIL_RUN.length)
})

test('verbose progress lines and the warnings summary are handled', () => {
  const raw = [
    '============================= test session starts ==============================',
    'collected 3 items',
    '',
    'tests/test_a.py::test_one PASSED                                      [ 33%]',
    'tests/test_a.py::test_two PASSED                                      [ 66%]',
    'tests/test_a.py::test_three PASSED                                    [100%]',
    '',
    '=============================== warnings summary ===============================',
    'tests/test_a.py:3: DeprecationWarning: datetime.utcnow() is deprecated',
    '  datetime.utcnow()',
    '',
    '============================== 3 passed in 0.05s ===============================',
  ].join('\n')
  const out = compressPytest(raw)
  expect(out).not.toContain('PASSED')
  expect(out).toContain('DeprecationWarning: datetime.utcnow() is deprecated')
  expect(out).toContain('3 passed')
})

test('ANSI color codes are stripped before parsing', () => {
  const colored = PYTEST_FAIL_RUN.replace(
    'FAILED tests',
    '\x1b[31;1mFAILED tests',
  ).replace('0.12s', '\x1b[0m0.12s')
  const out = compressPytest(colored)
  expect(out).toContain('FAILED tests/test_math.py::test_division_fail')
  expect(out).toContain('6 passed, 1 failed')
  expect(out).not.toContain('\x1b[')
})

test('failure blocks are capped per block with a tk:raw marker', () => {
  const longBody = Array.from({ length: 40 }, (_, i) => `      frame line ${i}`).join('\n')
  const raw = [
    '============================= test session starts ==============================',
    'collected 1 items',
    'F',
    '=================================== FAILURES ===================================',
    '_______________________________ test_long_trace ________________________________',
    longBody,
    '========================= 1 failed, 0 passed in 0.05s ==========================',
  ].join('\n')
  const out = compressPytest(raw, { ...DEFAULT_PYTEST_CAPS, maxLinesPerBlock: 10 })
  expect(out).toContain('frame line 0')
  expect(out).toContain('frame line 9')
  expect(out).not.toContain('frame line 10')
  expect(out).not.toContain('frame line 39')
  // the block header survives even though the body was truncated
  expect(out).toMatch(/_{3,} test_long_trace _{3,}/)
  expect(out).toContain('... +30 lines elided - raw: pytest # tk:raw')
  expect(out).toContain('1 failed')
})

test('more failures than maxFailures elide whole blocks with a tk:raw marker', () => {
  const blocks = [0, 1, 2].flatMap((i) => [
    `_______________________________ test_fail_${i} _______________________________`,
    `    assert ${i} == 99`,
  ])
  const raw = [
    '============================= test session starts ==============================',
    'collected 3 items',
    'FFF',
    '=================================== FAILURES ===================================',
    ...blocks,
    '=========================== short test summary info ============================',
    'FAILED tests/x.py::test_fail_0 - assert 0 == 99',
    'FAILED tests/x.py::test_fail_1 - assert 1 == 99',
    'FAILED tests/x.py::test_fail_2 - assert 2 == 99',
    '========================= 3 failed, 0 passed in 0.10s ==========================',
  ].join('\n')
  const out = compressPytest(raw, { ...DEFAULT_PYTEST_CAPS, maxFailures: 2 })
  expect(out).toMatch(/_{3,} test_fail_0 _{3,}/)
  expect(out).toMatch(/_{3,} test_fail_1 _{3,}/)
  expect(out).not.toMatch(/_{3,} test_fail_2 _{3,}/)
  expect(out).toContain('... +1 failure block elided - raw: pytest # tk:raw')
  // The short summary still names every failure, so nothing is lost blind.
  expect(out).toContain('FAILED tests/x.py::test_fail_2')
})

test('warnings are capped with a tk:raw marker', () => {
  const warnLines = Array.from({ length: 20 }, (_, i) => `tests/test_a.py:${i}: DeprecationWarning: w${i}`)
  const raw = [
    '============================= test session starts ==============================',
    'collected 1 items',
    '.',
    '=============================== warnings summary ===============================',
    ...warnLines,
    '============================== 1 passed in 0.05s ===============================',
  ].join('\n')
  const out = compressPytest(raw, { ...DEFAULT_PYTEST_CAPS, maxWarningLines: 3 })
  expect(out).toContain('w0')
  expect(out).not.toContain('w5')
  expect(out).toContain('... +17 warning lines elided - raw: pytest # tk:raw')
  expect(out).toContain('1 passed')
})

test('the rerun command can name the exact invocation in markers', () => {
  const longBody = Array.from({ length: 40 }, (_, i) => `frame ${i}`).join('\n')
  const raw = [
    '=== test session starts ===',
    '=== FAILURES ===',
    '___ test_x ___',
    longBody,
    '=== 1 failed in 0.1s ===',
  ].join('\n')
  const out = compressPytest(raw, { ...DEFAULT_PYTEST_CAPS, maxLinesPerBlock: 5 }, 'python -m pytest')
  expect(out).toContain('- raw: python -m pytest # tk:raw')
})

test('quiet-mode run without banners still compresses to the counts line', () => {
  const raw = '....F.\n1 failed, 5 passed in 0.34s\n'
  const out = compressPytest(raw)
  expect(out).toBe('5 passed, 1 failed')
})

test('an errors-only run keeps its errors counts', () => {
  const raw = [
    '============================= test session starts ==============================',
    'collected 2 items',
    'EE',
    '==================================== ERRORS ====================================',
    '__________________ ERROR at setup of test_needs_db __________________',
    'E   RuntimeError: database unavailable',
    '=========================== short test summary info ============================',
    'ERROR tests/test_db.py::test_needs_db - RuntimeError: database unavailable',
    '=============================== 2 errors in 0.20s ==============================',
  ].join('\n')
  const out = compressPytest(raw)
  expect(out).toContain('RuntimeError: database unavailable')
  expect(out).toContain('ERROR tests/test_db.py::test_needs_db')
  expect(out).toContain('2 errors')
})

test('never inflates: a minimal run stays as short or shorter', () => {
  const raw = '========================= 6 passed in 0.01s =========================='
  const out = compressPytest(raw)
  expect(out).toBe('6 passed')
  expect(out.length).toBeLessThanOrEqual(raw.length)
})

test('unrecognized output is returned unchanged', () => {
  const raw = 'bash: pytest: command not found\n'
  expect(compressPytest(raw)).toBe(raw)
  const prose = 'just some random text that is not a test run at all\n'
  expect(compressPytest(prose)).toBe(prose)
})

// pytest 9 drops the `====` banner on the run's last line: the totals arrive
// bare, right after the short-summary section. Using them is the difference
// between the model knowing "2 failed, 43 passed" and knowing only that two
// tests failed.
test('bare totals after the short-summary section are still kept', () => {
  const raw = [
    '============================= test session starts ==============================',
    'collected 45 items',
    '',
    '=================================== FAILURES ===================================',
    '_________________________________ test_fail_1 __________________________________',
    '    def test_fail_1():',
    '>       assert 1 == 2',
    'E       assert 1 == 2',
    '',
    't/test_demo.py:11: AssertionError',
    '=========================== short test summary info ============================',
    'FAILED t/test_demo.py::test_fail_1 - assert 1 == 2',
    '2 failed, 43 passed in 0.02s',
  ].join('\n')
  const out = compressPytest(raw, undefined, 'pytest')
  expect(out).toContain('43 passed')
  expect(out).toContain('2 failed')
  expect(out).toContain('FAILED t/test_demo.py::test_fail_1')
  expect(out.length).toBeLessThan(raw.length)
})

// Listing modes put the payload in the body: the test IDs, the fixtures, the
// markers. A summary of those runs keeps the one line that does not answer the
// question.
test('listing modes are left alone', () => {
  for (const cmd of ['pytest --co', 'pytest --collect-only -q', 'pytest --fixtures', 'pytest --markers', 'pytest --setup-plan', 'pytest --setup-show']) {
    expect(planPytest(cmd)).toBeNull()
  }
})
