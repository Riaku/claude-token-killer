import { expect, test, tier } from 'claude-code/testing'
import { DEFAULT_PLAYWRIGHT_CAPS, compressPlaywright, planPlaywright } from '../hooks/playwright.ts'

tier('user')

const FIXTURE = [
  'Running 4 tests using 2 workers',
  '',
  '  ✓  1 [chromium] › tests/a.spec.ts:3:1 › loads home (120ms)',
  '  ✘  2 [chromium] › tests/a.spec.ts:9:1 › submits form (240ms)',
  '',
  '  1) [chromium] › tests/a.spec.ts:9:1 › submits form ─────────',
  '',
  '    Error: expect(received).toBe(expected)',
  '',
  '    Expected: "ok"',
  '    Received: "oops"',
  '',
  '      8 |   await page.fill("#q", "x")',
  '    > 9 |   expect(out).toBe("ok")',
  '',
  '  ✓  3 [chromium] › tests/b.spec.ts:2:1 › lists items (60ms)',
  '  ✓  4 [chromium] › tests/b.spec.ts:8:1 › filters (70ms)',
  '',
  '  1 failed',
  '  3 passed (1.2s)',
  '',
  '[1/4] [chromium] › tests/a.spec.ts:3:1 › loads home',
].join('\n')

test('npx playwright test plans as compression-only', () => {
  const plan = planPlaywright('npx playwright test 2>&1')
  // `2>&1` is stripped by the handler before planning, so plan the body.
  expect(planPlaywright('npx playwright test')).not.toBeNull()
  expect(plan).toBeNull() // the redirect is the handler's job, not the planner's
})

test('every documented runner form plans', () => {
  for (const cmd of [
    'playwright test',
    'npx playwright test',
    'npx playwright test tests/a.spec.ts',
    'pnpm exec playwright test --project=chromium',
    'yarn playwright test',
    'bunx playwright test',
    '/opt/x/node_modules/.bin/playwright test',
  ]) {
    expect(planPlaywright(cmd)).not.toBeNull()
  }
})

test('reporter swaps, interactive modes and non-test subcommands bail', () => {
  for (const cmd of [
    'npx playwright test --reporter=json',
    'npx playwright test --reporter=list',
    'npx playwright test --ui',
    'npx playwright test --debug',
    'npx playwright test --headed',
    'playwright install',
    'playwright --version',
    'npx playwright test | tee out.txt',
    'npx playwright test && echo done',
    '',
  ]) {
    expect(planPlaywright(cmd)).toBeNull()
  }
})

test('result lines survive, worker progress does not', () => {
  const out = compressPlaywright(FIXTURE)
  expect(out).toContain('✓  1 [chromium] › tests/a.spec.ts:3:1 › loads home')
  expect(out).toContain('✘  2 [chromium] › tests/a.spec.ts:9:1 › submits form')
  expect(out).not.toContain('Running 4 tests using 2 workers')
  expect(out).not.toContain('[1/4] [chromium]')
})

test('the failure block is kept, including the error and the code frame pointer', () => {
  const out = compressPlaywright(FIXTURE)
  expect(out).toContain('Error: expect(received).toBe(expected)')
  expect(out).toContain('Expected: "ok"')
  expect(out).toContain('> 9 |   expect(out).toBe("ok")')
})

test('summary counts are folded onto one line', () => {
  const out = compressPlaywright(FIXTURE)
  expect(out).toContain('1 failed · 3 passed')
})

test('more failures than the cap elide whole blocks with a tk:raw marker', () => {
  const lines: string[] = []
  for (let i = 0; i < 25; i += 1) {
    lines.push(`  ${i + 1}) [chromium] › tests/f${i}.spec.ts:1:1 › case ${i} ─────`)
    lines.push('    Error: boom')
  }
  lines.push('25 failed')
  const out = compressPlaywright(lines.join('\n'), { ...DEFAULT_PLAYWRIGHT_CAPS, maxFailures: 5 })
  expect(out).toContain('... +20 more failures')
  expect(out).toContain('# tk:raw')
})

test('a very long failure block is truncated at the per-block cap', () => {
  const lines = ['  1) [chromium] › tests/a.spec.ts:1:1 › case ─────']
  for (let i = 0; i < 200; i += 1) lines.push(`    frame ${i}`)
  lines.push('1 failed')
  const out = compressPlaywright(lines.join('\n'), { ...DEFAULT_PLAYWRIGHT_CAPS, maxLinesPerFailure: 10 })
  expect(out).toContain('frame 1')
  expect(out).not.toContain('frame 199')
  expect(out.length).toBeLessThan(lines.join('\n').length)
})

test('unrecognized output is returned unchanged', () => {
  const raw = 'something else entirely\nno test results here\n'
  expect(compressPlaywright(raw)).toBe(raw)
})

test('never inflates', () => {
  const out = compressPlaywright(FIXTURE)
  expect(out.length).toBeLessThan(FIXTURE.length)
})
