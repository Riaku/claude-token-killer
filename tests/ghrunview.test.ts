import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_GH_RUN_VIEW_CAPS, compressGhRunView, planGhRunView } from '../hooks/ghrunview.ts'

// The real shape: <job>\t<step>\t<RFC3339 stamp> <message>, BOM on line one.
const L = (job: string, step: string, msg: string): string =>
  `${job}\t${step}\t\uFEFF2026-10-22T04:46:13.6419785Z ${msg}`

const LOG = [
  L('test', 'Run mod tests', '##[group]Run npx tsc'),
  L('test', 'Run mod tests', 'npx tsc --noEmit'),
  L('test', 'Run mod tests', 'ok 313 tests'),
  L('test', 'Run mod tests', 'ok 313 tests'),
  L('test', 'Typecheck', '##[endgroup]'),
  L('test', 'Typecheck', 'error TS2322: bad type'),
].join('\n')

describe('planGhRunView', () => {
  test('plans the log modes', () => {
    expect(planGhRunView('gh run view 123 --log')?.kind).toBe('gh-run-view')
    expect(planGhRunView('gh run view 123 --log-failed')).not.toBeNull()
    expect(planGhRunView('gh run view --job 456 --log')).not.toBeNull()
    expect(planGhRunView('gh run view 123')?.kind).toBe('gh-run-view')
  })

  test('bails on machine formats, other subcommands and shell composition', () => {
    for (const cmd of [
      'gh run view 123 --json',
      'gh run view 123 --log --json',
      'gh run view 123 --web',
      'gh run list',
      'gh run watch 123',
      'gh run view 123 --log | head -50',
      'gh run view 123 --unknown-flag',
    ]) {
      expect(planGhRunView(cmd)).toBeNull()
    }
  })
})

describe('compressGhRunView', () => {
  test('drops timestamps and runner section markers, keeps job and step', () => {
    const out = compressGhRunView(LOG, undefined, 'gh run view 123 --log')
    expect(out).toContain('# gh run view: 4 log lines, 1 job, 2 steps')
    expect(out).toContain('test > Run mod tests (3)')
    expect(out).toContain('test > Typecheck (1)')
    expect(out).not.toContain('2026-10-22T')
    expect(out).not.toContain('##[group]')
    expect(out).not.toContain('##[endgroup]')
    expect(out).not.toContain('\uFEFF')
  })

  test('collapses repeated lines and keeps error lines', () => {
    const out = compressGhRunView(LOG)
    expect(out).toContain('ok 313 tests  x2')
    expect(out).toContain('error TS2322: bad type')
  })

  test('caps a long step and rescues an error from the elided middle', () => {
    const lines = [L('test', 'Run mod tests', 'line 0')]
    for (let i = 1; i < 60; i += 1) lines.push(L('test', 'Run mod tests', `line ${i}`))
    lines.push(L('test', 'Run mod tests', 'Error: chunk failed'))
    for (let i = 61; i < 70; i += 1) lines.push(L('test', 'Run mod tests', `line ${i}`))
    const out = compressGhRunView(lines.join('\n'), { ...DEFAULT_GH_RUN_VIEW_CAPS, maxLinesPerStep: 10 }, 'gh run view 1 --log')

    expect(out).toContain('lines elided - raw: gh run view 1 --log # tk:raw')
    expect(out).toContain('Error: chunk failed')
    expect(out.length).toBeLessThan(lines.join('\n').length)
  })

  test('leaves a non-tab-separated view alone', () => {
    const summary = 'X CI completed success 18s\n  https://github.com/o/r/actions/runs/1'
    expect(compressGhRunView(summary)).toBe(summary)
  })

  test('leaves a two-line log alone: no structure worth rewriting', () => {
    const tiny = [L('test', 'Run', 'one'), L('test', 'Run', 'two')].join('\n')
    expect(compressGhRunView(tiny)).toBe(tiny)
  })
})
