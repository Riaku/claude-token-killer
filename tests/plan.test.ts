import { describe, expect, test } from 'claude-code/testing'
import { planRewrite, tokenize } from '../hooks/plan.ts'

describe('tokenize', () => {
  test('plain words split', () => {
    expect(tokenize('git status -s')).toEqual(['git', 'status', '-s'])
  })

  test('quotes keep spaces', () => {
    expect(tokenize("grep -r 'two words' .")).toEqual(['grep', '-r', 'two words', '.'])
    expect(tokenize('grep -r "two words" .')).toEqual(['grep', '-r', 'two words', '.'])
  })

  test('unbalanced quotes return null', () => {
    expect(tokenize("grep -r 'oops .")).toBeNull()
  })

  test('empty returns empty list', () => {
    expect(tokenize('   ')).toEqual([])
  })
})

describe('planRewrite: git status', () => {
  test('bare git status rewrites to porcelain with branch', () => {
    const p = planRewrite('git status')
    expect(p?.kind).toBe('git-status')
    expect(p?.command).toBe('git status --porcelain=v1 -b -uall')
  })

  test('user flags are preserved and compact flags appended', () => {
    const p = planRewrite('git status --ignored')
    expect(p?.command).toContain('--ignored')
    expect(p?.command).toContain('--porcelain=v1')
  })

  test('a user -u flag is respected (no -uall forced)', () => {
    const p = planRewrite('git status -uno')
    expect(p?.command).not.toContain('-uall')
    expect(p?.command).toContain('--porcelain=v1')
  })

  test('already-compact status is compress-only (command unchanged)', () => {
    const p = planRewrite('git status -s')
    expect(p?.kind).toBe('git-status')
    expect(p?.command).toBe('git status -s')
    const p2 = planRewrite('git status --porcelain=v1 -b')
    expect(p2?.command).toBe('git status --porcelain=v1 -b')
  })

  test('machine formats we cannot parse are passed through', () => {
    expect(planRewrite('git status -z')).toBeNull()
    expect(planRewrite('git status --porcelain=2')).toBeNull()
    expect(planRewrite('git status --json')).toBeNull()
  })

  test('global options pass through', () => {
    const p = planRewrite('git -C /tmp/repo status')
    expect(p?.command).toContain('-C /tmp/repo')
    expect(p?.command).toContain('--porcelain=v1')
  })

  test('unknown global options bail', () => {
    expect(planRewrite('git --weird-flag status')).toBeNull()
  })
})

describe('planRewrite: git diff', () => {
  test('bare git diff gets --no-color', () => {
    const p = planRewrite('git diff')
    expect(p?.kind).toBe('git-diff')
    expect(p?.command).toBe('git diff --no-color')
  })

  test('staged/cached diffs still rewrite', () => {
    const p = planRewrite('git diff --staged')
    expect(p?.command).toContain('--staged')
    expect(p?.command).toContain('--no-color')
  })

  test('already-colorless diff is not re-flagged', () => {
    const p = planRewrite('git diff --no-color')
    expect(p?.command).toBe('git diff --no-color')
  })

  test('compact diff shapes pass through', () => {
    for (const cmd of ['git diff --stat', 'git diff --numstat', 'git diff --name-only', 'git diff --raw', 'git diff -z']) {
      expect(planRewrite(cmd)).toBeNull()
    }
  })
})

describe('planRewrite: grep', () => {
  test('recursive grep gains line numbers', () => {
    const p = planRewrite('grep -r TODO src/')
    expect(p?.kind).toBe('grep')
    expect(p?.command).toBe('grep -n -r TODO src/')
  })

  test('bundled short flags are read', () => {
    const p = planRewrite('grep -ri TODO src/')
    expect(p?.command).toBe('grep -n -ri TODO src/')
    const withN = planRewrite('grep -rn TODO src/')
    expect(withN?.command).toBe('grep -rn TODO src/')
  })

  test('non-recursive grep passes through', () => {
    expect(planRewrite('grep TODO file.txt')).toBeNull()
  })

  test('count/list-only shapes pass through', () => {
    for (const cmd of ['grep -rc TODO src/', 'grep -rl TODO src/', 'grep -rq TODO src/', 'grep -r --count TODO src/']) {
      expect(planRewrite(cmd)).toBeNull()
    }
  })

  test('quoted patterns with spaces survive the rewrite', () => {
    const p = planRewrite("grep -r 'two words' src/")
    expect(p?.command).toBe("grep -n -r 'two words' src/")
  })
})

describe('planRewrite: safety', () => {
  test('compound commands are never rewritten', () => {
    for (const cmd of [
      'git status | head',
      'git status && git diff',
      'git status; rm -rf /',
      'echo hi > git status',
      'git status `whoami`',
      'git status $(whoami)',
      'git status ${X}',
      'grep -r foo . &',
    ]) {
      expect(planRewrite(cmd)).toBeNull()
    }
  })

  test('other commands pass through', () => {
    expect(planRewrite('ls -la')).toBeNull()
    expect(planRewrite('cargo build')).toBeNull()
    expect(planRewrite('rg TODO src/')).toBeNull()
  })

  test('absolute paths to the binaries still match', () => {
    expect(planRewrite('/usr/bin/git status')?.kind).toBe('git-status')
    expect(planRewrite('/bin/grep -r x .')?.kind).toBe('grep')
  })

  test('the tk:raw bail marker disables the rewrite (recovery path)', () => {
    // Elision hints tell the model to re-run with `# tk:raw`; the planner
    // bails on any comment, so the re-run reaches the shell untouched and
    // its output is never compressed.
    expect(planRewrite('git diff -- big.txt # tk:raw')).toBeNull()
    expect(planRewrite('git status # tk:raw')).toBeNull()
    expect(planRewrite('grep -r TODO src/ # tk:raw')).toBeNull()
  })
})
