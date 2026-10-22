// PowerShell tool support for `Get-ChildItem` (and its aliases gci/ls/dir).
//
// The PowerShell tool only registers on Windows, so this handler is inert
// elsewhere - no gate needed; a tool that never fires never triggers.
// Compression-only: the command runs exactly as the model wrote it, and the
// Format-Table stdout is compacted on the way back. That keeps the rewrite
// risk at zero (PowerShell parameter semantics are a minefield) while still
// eating the biggest per-call token cost the cmdlet has: the six-column table.
//
// Recovery follows the Bash side's convention: every elision line names the
// re-run tagged `# tk:raw`, and the planner bails on `#` (a comment in
// PowerShell too), so the tagged re-run reaches the shell untouched.

import { stripAnsi } from './ansi.ts'
export type PsPlan = { kind: 'ps-dir'; command: string }

// Same bail set as the Bash planner: pipes, statement separators,
// redirections, subexpressions, backticks, newlines, comments.
const PS_UNSAFE = /[|;&<>]|\$\(|\$\{|`|\r|\n|#/

// Get-ChildItem and its built-in aliases. In PowerShell `ls` and `dir` ARE
// Get-ChildItem, so the same table comes back and the same trim applies.
const GCI_ALIASES = new Set(['get-childitem', 'gci', 'ls', 'dir'])

export function planPowerShell(command: string): PsPlan | null {
  const cmd = command.trim()
  if (!cmd) return null
  if (PS_UNSAFE.test(cmd)) return null
  const first = cmd.split(/\s+/)[0].toLowerCase()
  if (!GCI_ALIASES.has(first)) return null
  return { kind: 'ps-dir', command: cmd }
}


function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['K', 'M', 'G', 'T']
  let v = bytes
  let i = -1
  do {
    v /= 1024
    i++
  } while (v >= 1024 && i < units.length - 1)
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)}${units[i]}`
}

// A table row opens with a mode string: Windows `d----` / `-a---` / `l----`,
// Linux pwsh `drwxr-sr-x` / `-rwxr--r--`, with attribute flags laHs@.
const MODE = /^[dlarwxLAHs@-]{4,10}$/

/**
 * Compact a Get-ChildItem Format-Table dump.
 *
 * Windows columns: Mode LastWriteTime Length Name
 * Linux  columns:  UnixMode User Group LastWriteTime Size Name
 *
 * Column counts differ, so - like ptk's gci filter - read from the BACK:
 * last token is the name, the token before it is the size when numeric.
 * Returns the input unchanged when the text is not a recognizable table,
 * letting the caller's never-inflate comparison discard the attempt.
 */
type PsRow = { name: string; dir: boolean; size: number | null }

export function compressPsDir(raw: string, maxEntries: number, command: string = ''): string {
  const clean = stripAnsi(raw)
  const sections: Array<{ dir: string | null; rows: PsRow[] }> = []
  let cur: { dir: string | null; rows: PsRow[] } = { dir: null, rows: [] }
  let sawTable = false

  for (const line of clean.split('\n')) {
    const t = line.trim()
    if (!t) continue

    // Multi-path calls print one "Directory: <path>" header per path.
    if (t.startsWith('Directory: ')) {
      sawTable = true
      if (cur.rows.length > 0 || cur.dir !== null) sections.push(cur)
      cur = { dir: t.slice('Directory: '.length).trim(), rows: [] }
      continue
    }

    // Column headers ("UnixMode ... Name" / "Mode ... Name") and the
    // separator rule of dashes underneath them.
    if (/^(UnixMode|Mode)(\s|$)/.test(t)) continue
    if (/^[-\s]+$/.test(t)) continue

    const parts = t.split(/\s+/)
    const last = cur.rows[cur.rows.length - 1]
    if (parts.length < 2 || !MODE.test(parts[0])) {
      // pwsh wraps a name that does not fit its console width onto the next
      // physical line, and that continuation carries none of the columns. Glue
      // it back on rather than bailing - at the default 80 columns a listing of
      // real project names wraps constantly, which is why this path used to
      // compress nothing at all on this host.
      if (last !== undefined && parts.length === 1) {
        last.name += parts[0]
        continue
      }
      // Not a table row: bail whole, never half-compress something unknown.
      return raw
    }
    sawTable = true

    const name = parts[parts.length - 1]
    if (name === '.' || name === '..') continue
    const before = parts[parts.length - 2]
    cur.rows.push({
      name,
      dir: parts[0][0] === 'd',
      size: /^\d+$/.test(before) ? Number(before) : null,
    })
  }
  if (cur.rows.length > 0 || cur.dir !== null) sections.push(cur)

  if (!sawTable) return raw

  const out: string[] = []
  for (const s of sections) {
    const header = `${s.dir ?? '.'} (${s.rows.length} ${s.rows.length === 1 ? 'entry' : 'entries'}):`
    if (s.rows.length === 0) {
      out.push(`${header} (empty)`)
      continue
    }
    const render = (r: PsRow) =>
      r.dir ? `${r.name}/` : r.size === null ? r.name : `${r.name} (${formatSize(r.size)})`
    const shown = s.rows.slice(0, maxEntries).map((r) => `  ${render(r)}`)
    out.push(header, ...shown)
    if (s.rows.length > maxEntries) {
      const hint = command ? ` - raw: ${command} # tk:raw` : ' - raw: re-run with # tk:raw'
      out.push(`  ... +${s.rows.length - maxEntries} more${hint}`)
    }
  }
  return out.join('\n')
}
