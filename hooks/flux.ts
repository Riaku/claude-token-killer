// Flux CLI: compression-only support for the `flux get` table commands.
//
// `flux get kustomizations -A` and friends print a tab-separated table whose
// REVISION/MESSAGE columns are mostly repetition. The generic table compactor
// already knows how to fold that (`tables.ts`, which handles both the padded
// space form and the tab form flux actually emits), so this module only owns
// the command guard.

import { compressTable, DEFAULT_TABLE_CAPS, type TableCaps } from './tables.ts'
import { tokenize } from './plan.ts'
import { UNSAFE, basename } from './shell.ts'

export type FluxPlan = { kind: 'flux-get'; command: string }

/**
 * Plan a `flux get <kind>` call. Compression-only.
 *
 * Bails on `-o/--output` (json/yaml/wide is still a formatter we do not own),
 * `--watch` (endless), and help/version.
 */
export function planFluxGet(command: string): FluxPlan | null {
  const cmd = command.trim()
  if (!cmd) return null
  if (UNSAFE.test(cmd)) return null
  const tokens = tokenize(cmd)
  if (!tokens || tokens.length < 3) return null
  if (basename(tokens[0]) !== 'flux' || tokens[1] !== 'get') return null

  let kind = false
  for (let i = 2; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (t === '-h' || t === '--help' || t === '--version') return null
    if (t === '--watch' || t === '-w') return null
    if (t === '-o' || t === '--output' || t.startsWith('--output=') || (t.startsWith('-o') && t.length > 2)) return null
    if (!t.startsWith('-')) kind = true
  }
  return kind ? { kind: 'flux-get', command: cmd } : null
}

export function compressFluxGet(
  text: string,
  caps: Partial<TableCaps> = DEFAULT_TABLE_CAPS,
  command: string = 'flux get kustomizations -A',
): string {
  return compressTable(text, caps, command)
}
