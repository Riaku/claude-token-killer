import { expect, test, tier } from 'claude-code/testing'
import { planGitLog } from '../hooks/gitlog.ts'
import { planRewrite, splitStderrMerge, withStderrMerge } from '../hooks/plan.ts'
import { planKubectlGet } from '../hooks/tables.ts'

tier('user')

// A trailing `2>&1` means "merge stderr into the stream we compress". It is
// split off before planning and re-appended verbatim, because the tokenizer
// would treat `>` as an operator and the rebuild would re-quote the redirect
// into a literal argument - silently changing what the command does.

test('a trailing 2>&1 is split off and restored verbatim', () => {
  expect(splitStderrMerge('kubectl get pods 2>&1')).toEqual({ body: 'kubectl get pods', merged: true })
  expect(withStderrMerge('kubectl get pods', true)).toBe('kubectl get pods 2>&1')
  expect(withStderrMerge('kubectl get pods', false)).toBe('kubectl get pods')
})

test('the redirect survives planning of the body', () => {
  const { body, merged } = splitStderrMerge('kubectl get pods -n apps -l app=drop 2>&1')
  const plan = planKubectlGet(body)
  expect(plan).not.toBeNull()
  expect(withStderrMerge(plan!.command, merged)).toBe('kubectl get pods -n apps -l app=drop 2>&1')
})

test('added flags come before the redirect, never after it', () => {
  const { body, merged } = splitStderrMerge('git diff 2>&1')
  const plan = planRewrite(body)
  expect(plan).not.toBeNull()
  expect(withStderrMerge(plan!.command, merged)).toBe('git diff --no-color 2>&1')
})

test('a rewritten command keeps the redirect last', () => {
  const { body, merged } = splitStderrMerge('git status 2>&1')
  const plan = planRewrite(body)
  expect(plan).not.toBeNull()
  const out = withStderrMerge(plan!.command, merged)
  expect(out).toBe('git status --porcelain=v1 -b 2>&1')
})

test('2>&1 anywhere but the tail is not touched', () => {
  for (const cmd of [
    'kubectl get pods 2>&1 | head -20',
    'kubectl get pods 2>&1 && echo done',
    'kubectl get pods 2>&1; echo done',
    'kubectl get pods 2>&1 > out.txt',
    'bash -lc "kubectl get pods 2>&1"',
    'kubectl get pods 2>&1x',
    'kubectl get pods 2>/dev/null',
    'kubectl get pods 1>&2',
  ]) {
    expect(splitStderrMerge(cmd).merged).toBe(false)
  }
})

test('a doubled redirect is stripped once and then bails in the planner', () => {
  const { body, merged } = splitStderrMerge('kubectl get pods 2>&1 2>&1')
  expect(merged).toBe(true)
  // What is left still holds a redirect, so no planner will touch it.
  expect(body).toBe('kubectl get pods 2>&1')
  expect(planKubectlGet(body)).toBeNull()
})

test('a quoted 2>&1 argument is not a redirect', () => {
  for (const cmd of ["echo '2>&1'", 'echo "merge 2>&1"']) {
    expect(splitStderrMerge(cmd).merged).toBe(false)
  }
})

test('a command that is nothing but the redirect stays unplanned', () => {
  expect(splitStderrMerge('2>&1')).toEqual({ body: '2>&1', merged: false })
  expect(planRewrite(splitStderrMerge('2>&1').body)).toBeNull()
})
