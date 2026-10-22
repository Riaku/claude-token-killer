import { expect, test, tier } from 'claude-code/testing'
import { DEFAULT_KUBECTL_LOGS_CAPS, compressKubectlLogs, planKubectlLogs } from '../hooks/kubectllogs.ts'

tier('user')

test('kubectl logs plans as a compression-only command', () => {
  const plan = planKubectlLogs('kubectl logs -n apps deployment/drop --tail=100')
  expect(plan).not.toBeNull()
  expect(plan!.kind).toBe('kubectl-logs')
  // Never rewritten: the command the model wrote is the command that runs.
  expect(plan!.command).toBe('kubectl logs -n apps deployment/drop --tail=100')
})

test('pod, deployment and selector targets all plan', () => {
  for (const cmd of [
    'kubectl logs hermes-7d9f8c6b5-abcde',
    'kubectl logs -n apps deploy/drop',
    'kubectl logs -n monitoring -l app=prometheus --tail=50',
    'kubectl logs -c gateway -p pod/x',
    'kubectl logs --tail 200 --since=1h pod/x',
    '/usr/bin/kubectl logs pod/x',
  ]) {
    expect(planKubectlLogs(cmd)).not.toBeNull()
  }
})

test('streams, help and unknown flags bail', () => {
  for (const cmd of [
    'kubectl logs -f pod/x',
    'kubectl logs --follow pod/x',
    'kubectl logs --watch pod/x',
    'kubectl logs -h',
    'kubectl logs --help',
    'kubectl logs --version',
    // Unknown flag: rather than guess what it does to the format, bail.
    'kubectl logs --whatever pod/x',
    // Redirection, pipes, chaining and substitutions stay untouched.
    'kubectl logs pod/x > out.txt',
    'kubectl logs pod/x | grep error',
    'kubectl logs pod/x && echo done',
    'kubectl logs $(kubectl get pods -o name)',
    'kubectl describe pod/x',
    'kubectl get pods',
    'kubectl logs',
    '',
  ]) {
    expect(planKubectlLogs(cmd)).toBeNull()
  }
})

const noisy = (): string => {
  const lines: string[] = []
  for (let i = 0; i < 300; i += 1) {
    lines.push(`2026-10-22T10:00:00Z GET /health 200 1ms`)
  }
  return lines.join('\n')
}

test('identical consecutive lines collapse into a run count', () => {
  const raw = noisy()
  const out = compressKubectlLogs(raw)
  expect(out).toContain('x300')
  expect(out.length).toBeLessThan(raw.length / 10)
})

test('distinct lines are never merged, even when they look alike', () => {
  const raw = [
    '2026-10-22T10:00:00Z GET /health 200 1ms',
    '2026-10-22T10:00:01Z GET /health 200 1ms',
    '2026-10-22T10:01:00Z GET /health 200 2ms',
  ].join('\n')
  // Nothing repeats exactly, so the input is returned unchanged.
  expect(compressKubectlLogs(raw)).toBe(raw)
})

test('past the cap the middle is elided with a tk:raw marker', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`)
  const out = compressKubectlLogs(lines.join('\n'), { ...DEFAULT_KUBECTL_LOGS_CAPS, maxLines: 20, headLines: 8, tailLines: 8 })
  expect(out).toContain('... +384 lines elided')
  expect(out).toContain('line 0')
  expect(out).toContain('line 399')
  expect(out).not.toContain('line 200')
  expect(out).toContain('# tk:raw')
})

test('an error in the elided middle is kept, not swallowed', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`)
  lines[200] = 'ERROR dns lookup failed for postgres'
  lines[300] = 'WARN pool exhausted, waiting'
  lines[350] = 'panic: runtime error: invalid memory address'
  const out = compressKubectlLogs(lines.join('\n'), { ...DEFAULT_KUBECTL_LOGS_CAPS, maxLines: 20, headLines: 8, tailLines: 8 })
  expect(out).toContain('dns lookup failed for postgres')
  expect(out).toContain('pool exhausted, waiting')
  expect(out).toContain('panic: runtime error')
  expect(out).toContain('3 error/warn kept below')
})

test('the elision marker names the exact command to re-run', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`)
  const out = compressKubectlLogs(
    lines.join('\n'),
    { ...DEFAULT_KUBECTL_LOGS_CAPS, maxLines: 20, headLines: 8, tailLines: 8 },
    'kubectl logs -n apps deployment/drop --tail=100',
  )
  expect(out).toContain('raw: kubectl logs -n apps deployment/drop --tail=100 # tk:raw')
})

test('ANSI escapes are stripped', () => {
  const raw = '\u001b[31mERROR\u001b[0m boom\n\u001b[32mok\u001b[0m\n'
  const out = compressKubectlLogs(raw)
  expect(out).not.toContain('\u001b')
  expect(out).toContain('ERROR boom')
})

test('short clean logs are returned unchanged', () => {
  const raw = 'starting\nlistening on :8080\nready\n'
  expect(compressKubectlLogs(raw)).toBe(raw)
})

test('empty input is returned unchanged', () => {
  expect(compressKubectlLogs('')).toBe('')
})
