import { describe, expect, test } from 'claude-code/testing'

import { planKubectlExec } from '../hooks/kubectlexec.ts'
import { compressLs } from '../hooks/ls.ts'

const CMD = 'kubectl exec -n apps hermes-5f5 -c gateway -- ls -la /opt/data/workspace'

const LS = [
  'total 68',
  'drwxrwsr-x 10 hermes hermes  4096 Oct 21 22:53 .',
  'drwxrws--- 45 hermes hermes 12288 Oct 22 05:23 ..',
  '-rw-r--r--  1 hermes hermes  1790 Oct 21 22:54 README.md',
  'drwxrwsr-x  3 hermes hermes  4096 Oct 21 23:01 hooks',
].join('\n')

describe('planKubectlExec', () => {
  test('plans an inner long-format ls', () => {
    const plan = planKubectlExec(CMD)
    expect(plan?.kind).toBe('ls')
    // The original command is carried through so an elision hint is runnable.
    expect(plan?.command).toBe(CMD)
    expect(planKubectlExec('kubectl exec pod -- ls -l /tmp')?.kind).toBe('ls')
  })

  test('bails when the inner command is anything else', () => {
    for (const cmd of [
      'kubectl exec pod -- cat /var/log/app.log',
      'kubectl exec pod -- sh -c "ls -l"',
      'kubectl exec pod -- ls /tmp', // no long format
      'kubectl exec pod -- ls -R -l', // recursive listing spans directories
      'kubectl exec pod ls -la', // no -- separator
      'kubectl exec -it pod -- ls -la', // interactive
      'kubectl exec pod -- ls -la | head',
      'kubectl get pods',
    ]) {
      expect(planKubectlExec(cmd)).toBeNull()
    }
  })

  test('the ls compactor consumes the result', () => {
    const out = compressLs(LS, undefined, CMD)
    expect(out.length).toBeLessThan(LS.length)
    expect(out).toContain('README.md')
  })
})
