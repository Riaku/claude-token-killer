// `kubectl exec … -- ls -l` reuses the ls compactor.
//
// The dominant form is `kubectl exec <pod> -c <container> -- ls -la <dir>`, and
// its output is byte-identical to a local `ls -la`, just remote. So the inner
// command is routed to compressLs and nothing else is touched.
//
// Deliberately narrow:
//   - only `ls` as the inner command (a shell, cat, or anything else is a
//     different output shape and bails);
//   - only with a long-format flag, since plain `ls` prints bare names that the
//     ls compactor has nothing to do with;
//   - `-R` bails, because a recursive listing spans directories and the
//     compactor models one directory;
//   - `-i` / `-t` / `--stdin` / `--tty` bail: an interactive session is not a
//     finite result to compress.
//
// The plan carries the original command so any elision hint names something the
// model can actually re-run.

import { tokenize } from './plan.ts'

export type KubectlExecPlan = { kind: 'ls'; command: string }

// Same bail set as the other planners: one command, no shell composition.
const UNSAFE = /[|;&<>]|\$\(|\$\{|`|\r|\n|#/

const INTERACTIVE = new Set(['-i', '--stdin', '-t', '--tty', '-it', '-ti'])

function base(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1)
}

/**
 * Plan `kubectl exec <target> [flags] -- ls -l…`. Compression-only.
 */
export function planKubectlExec(command: string): KubectlExecPlan | null {
  const raw = command.trim()
  if (!raw || UNSAFE.test(raw)) return null
  const tokens = tokenize(raw)
  if (!tokens || tokens.length < 5) return null
  if (base(tokens[0]) !== 'kubectl' || tokens[1] !== 'exec') return null

  const sep = tokens.indexOf('--')
  if (sep < 3 || sep === tokens.length - 1) return null

  // The exec side: target plus its own flags. Interactive modes bail.
  for (const t of tokens.slice(2, sep)) {
    if (INTERACTIVE.has(t)) return null
  }

  const inner = tokens.slice(sep + 1)
  if (base(inner[0]) !== 'ls') return null
  if (inner.some((t) => t === '-R' || t === '--recursive')) return null

  // Long format only: that is the shape compressLs models.
  const long = inner.slice(1).some((t) => t.startsWith('-') && !t.startsWith('--') && /l/.test(t.slice(1)))
  if (!long) return null

  return { kind: 'ls', command: raw }
}
