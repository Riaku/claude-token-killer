import { describe, expect, test } from 'claude-code/testing'

import { planGitGrep, planRg } from '../hooks/grepalias.ts'

describe('planRg', () => {
  test('plans line-numbered searches', () => {
    expect(planRg('rg -n compressTable hooks/')?.kind).toBe('grep')
    expect(planRg('rg --line-number plan .')).not.toBeNull()
    // Bundled short flags: -in is --ignore-case + --line-number.
    expect(planRg('rg -in token hooks/')).not.toBeNull()
  })

  test('needs line numbers, because the output shape is file:line:text', () => {
    expect(planRg('rg compressTable hooks/')).toBeNull()
    expect(planRg('rg -i compressTable')).toBeNull()
  })

  test('bails on modes with a different shape', () => {
    for (const cmd of [
      'rg -l plan hooks/',
      'rg --files',
      'rg -c plan',
      'rg -o "pl[a-z]+"',
      'rg --json plan',
      'rg -C 3 plan hooks/',
      'rg -n plan hooks/ | head',
      'rg -n plan hooks/ > out.txt',
    ]) {
      expect(planRg(cmd)).toBeNull()
    }
  })
})

describe('planGitGrep', () => {
  test('plans line-numbered git grep', () => {
    expect(planGitGrep('git grep -n compressTable')?.kind).toBe('grep')
    expect(planGitGrep('git grep --line-number -e plan -- hooks')).not.toBeNull()
  })

  test('needs line numbers and bails on other modes', () => {
    expect(planGitGrep('git grep compressTable')).toBeNull()
    expect(planGitGrep('git grep -l plan')).toBeNull()
    expect(planGitGrep('git grep -c plan')).toBeNull()
    expect(planGitGrep('git grep -n plan | head')).toBeNull()
    expect(planGitGrep('git status')).toBeNull()
  })
})
