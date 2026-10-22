import { describe, expect, test } from 'claude-code/testing'

import { compressGhPrChecks, compressGhPrView, planGhPr } from '../hooks/ghpr.ts'

describe('planGhPr', () => {
  test('plans checks and view', () => {
    expect(planGhPr('gh pr checks')?.kind).toBe('gh-pr-checks')
    expect(planGhPr('gh pr checks 3')?.kind).toBe('gh-pr-checks')
    expect(planGhPr('gh pr view 3')?.kind).toBe('gh-pr-view')
    expect(planGhPr('gh pr view --comments 3')).not.toBeNull()
  })

  test('bails on machine formats, watching and other subcommands', () => {
    for (const cmd of [
      'gh pr checks 3 --json',
      'gh pr view 3 --json',
      'gh pr checks --watch',
      'gh pr checks --interval 10',
      'gh pr list',
      'gh pr checks 3 | grep fail',
    ]) {
      expect(planGhPr(cmd)).toBeNull()
    }
  })
})

describe('compressGhPrChecks', () => {
  const ROWS = [
    'test\tpass\t18s\thttps://github.com/o/r/actions/runs/1/job/456\t',
    'lint\tpass\t3s\thttps://github.com/o/r/actions/runs/1/job/789\t',
  ].join('\n')

  test('collapses the job URL to the id gh run view wants', () => {
    const out = compressGhPrChecks(ROWS)
    expect(out).toBe('test  pass  18s  job:456\nlint  pass  3s  job:789')
    expect(out).not.toContain('https://')
    expect(out.length).toBeLessThan(ROWS.length)
  })

  test('keeps rows it does not understand verbatim', () => {
    const notice = 'no checks reported on the main branch'
    expect(compressGhPrChecks(notice)).toBe(notice)
  })

  test('caps a long check list with a recovery hint', () => {
    const many = Array.from({ length: 60 }, (_, i) => `check-${i}\tpass\t1s\thttps://github.com/o/r/actions/runs/1/job/${i}\t`).join('\n')
    const out = compressGhPrChecks(many, { maxItems: 10 })
    expect(out).toContain('... +50 checks elided - raw: gh pr checks -v # tk:raw')
    expect(out.length).toBeLessThan(many.length)
  })
})

describe('compressGhPrView', () => {
  const bodyLines = Array.from({ length: 40 }, (_, i) => `body line ${i} ${'x'.repeat(60)}`)
  const VIEW = ['title:\tfix: strip ANSI', 'state:\tOPEN', 'number:\t3', '--', ...bodyLines].join('\n')

  test('keeps the metadata block and caps the body', () => {
    const out = compressGhPrView(VIEW, { maxBody: 5 })
    expect(out).toContain('title:\tfix: strip ANSI')
    expect(out).toContain('state:\tOPEN')
    expect(out).toContain('body line 4')
    expect(out).not.toContain('body line 39')
    expect(out).toContain('body lines elided - raw: gh pr view --comments # tk:raw')
    expect(out.length).toBeLessThan(VIEW.length)
  })

  test('never inflates a short body', () => {
    const small = ['title:\tfix', 'state:\tOPEN', '--', 'one', 'two'].join('\n')
    expect(compressGhPrView(small, { maxBody: 2 })).toBe(small)
  })

  test('collapses repeated blank lines when there is no body separator', () => {
    const text = 'a\n\n\n\nb'
    expect(compressGhPrView(text)).toBe('a\n\nb')
  })
})
