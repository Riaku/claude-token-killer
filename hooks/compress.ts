// Token compressors: pure string -> string transforms, the same idea as rtk and
// ptk's output filters, reimplemented in-process. No I/O, no engine types: every
// function here is testable in isolation and never inflates its input (callers
// compare lengths).

import { stripRetry } from './ansi.ts'

export type Caps = {
  /** git status: cap on listed entries, changed and untracked, before an elision line. */
  maxStatusFiles: number
  /** git diff: kept hunk lines per file before an elision line. */
  maxDiffLinesPerFile: number
  /** git diff: kept lines across all files before remaining files are summarized. */
  maxDiffTotalLines: number
  /** grep: kept match lines per file before an elision line. */
  maxGrepPerFile: number
  /** grep: kept match lines across all files. */
  maxGrepTotal: number
  /** grep: truncate any single match line longer than this. */
  maxLineLen: number
  /** ls, find and Get-ChildItem: kept entries before an elision line. The ls
   * and find compressors spend one budget across every directory; the
   * PowerShell handler applies it to each directory section. */
  maxDirEntries: number
}

export const DEFAULT_CAPS: Caps = {
  maxStatusFiles: 200,
  maxDiffLinesPerFile: 60,
  maxDiffTotalLines: 400,
  maxGrepPerFile: 8,
  maxGrepTotal: 150,
  maxLineLen: 200,
  maxDirEntries: 200,
}

/**
 * The rungs each cap can take: the manifest's pick-lists, in code.
 *
 * Claude Code only prefills a pick-list row in `/plugin configure`, so every
 * cap has to be one. A stored value outside its list is a knob the plugin does
 * not have, and the shipped default applies - which is what register() does
 * with anything that does not parse to one of these.
 */
export const CAP_CHOICES: Record<keyof Caps, readonly number[]> = {
  maxStatusFiles: [50, 100, 200, 500, 1000],
  maxDiffLinesPerFile: [20, 40, 60, 100, 200],
  maxDiffTotalLines: [150, 400, 800, 1500, 3000],
  maxGrepPerFile: [3, 5, 8, 15, 30],
  maxGrepTotal: [50, 100, 150, 300, 600],
  maxLineLen: [80, 120, 200, 300, 500],
  maxDirEntries: [50, 100, 200, 500, 1000],
}

// ---------------------------------------------------------------- git status

/**
 * Compress `git status --porcelain=v1 -b` output: the `##` branch header
 * becomes `* branch [ahead N, behind M]`, and XY lines pass through (they are
 * already one line per file) until the entry budget runs out.
 *
 * `-b` puts the branch header on every run, so the only way to get no lines is
 * for the command to produce no output at all. That is passed through: writing
 * `clean - nothing to commit` would make the result longer than the input, and
 * the caller's length check would throw it away.
 */
export function compressGitStatus(porcelain: string, caps: Caps = DEFAULT_CAPS, command?: string): string {
  return stripRetry(porcelain, (text) => compressGitStatusInner(text, caps, command))
}

function compressGitStatusInner(porcelain: string, caps: Caps = DEFAULT_CAPS, command?: string): string {
  const lines = porcelain.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return porcelain

  const out: string[] = []
  // One budget for the whole listing. A tree with 300 modified files is the same
  // flood as one with 300 untracked files, and the cap is named for the listing,
  // not for one of its sections.
  let shown = 0
  let changedHidden = 0
  let untrackedHidden = 0

  for (const line of lines) {
    if (line.startsWith('## ')) {
      out.push('* ' + line.slice(3))
      continue
    }
    const untracked = line.startsWith('?? ')
    if (shown < caps.maxStatusFiles) {
      out.push(line)
      shown += 1
    } else if (untracked) {
      untrackedHidden += 1
    } else {
      changedHidden += 1
    }
  }

  const hidden = changedHidden + untrackedHidden
  if (hidden > 0) {
    const parts: string[] = []
    if (changedHidden > 0) parts.push(`${changedHidden} changed`)
    if (untrackedHidden > 0) parts.push(`${untrackedHidden} untracked`)
    const hint = command ? `${command} # tk:raw` : 're-run with # tk:raw'
    out.push(`... +${hidden} more (${parts.join(', ')}) - raw: ${hint}`)
  }
  return out.join('\n')
}

// ------------------------------------------------------------------ git diff

type DiffFile = {
  path: string
  added: number
  removed: number
  binary: boolean
  hunkLines: string[] // everything after the file header, hunk headers included
}

function diffPathFromHeader(header: string): string {
  // `diff --git a/old b/new` - show the rename when there is one.
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(header)
  if (!m) return '(unknown file)'
  return m[1] === m[2] ? m[2] : `${m[1]} -> ${m[2]}`
}

function splitDiffBlocks(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let inHunk = false

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { path: diffPathFromHeader(line), added: 0, removed: 0, binary: false, hunkLines: [] }
      files.push(current)
      inHunk = false
      continue
    }
    if (!current) continue // preamble before the first block: drop it

    if (line.startsWith('Binary files ')) {
      current.binary = true
      continue
    }
    if (!inHunk && (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') ||
        line.startsWith('new file mode') || line.startsWith('deleted file mode') ||
        line.startsWith('old mode') || line.startsWith('new mode') ||
        line.startsWith('similarity index') || line.startsWith('rename from') ||
        line.startsWith('rename to'))) {
      continue // file metadata: the per-file summary line replaces it
    }
    if (line.startsWith('@@')) inHunk = true
    if (!inHunk) continue

    if (line.startsWith('+')) current.added += 1
    else if (line.startsWith('-')) current.removed += 1
    current.hunkLines.push(line)
  }
  return files
}

/** Collapse runs of context longer than `ctx` lines to a single `...` marker. */
function collapseContext(body: string[], ctx: number): string[] {
  const keep = new Array<boolean>(body.length).fill(false)
  body.forEach((line, i) => {
    // Hunk headers are anchors: dropping them makes the kept lines
    // unlocatable, so they always survive regardless of ctx.
    if (line.startsWith('@@')) {
      keep[i] = true
      return
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      for (let j = Math.max(0, i - ctx); j <= Math.min(body.length - 1, i + ctx); j += 1) keep[j] = true
    }
  })
  const out: string[] = []
  let dropped = 0
  for (let i = 0; i < body.length; i += 1) {
    if (keep[i]) {
      if (dropped > 0) {
        out.push('...')
        dropped = 0
      }
      out.push(body[i])
    } else {
      dropped += 1
    }
  }
  if (dropped > 0) out.push('...')
  return out
}

/**
 * Compress a unified diff: a `N files changed, +A -R` header, then per file a
 * one-line summary and context-trimmed hunks, capped per file and in total.
 * Elisions name the command that still shows the full thing.
 *
 * Returns the input unchanged when it does not look like a unified diff at all
 * (so a caller's length check passes it through).
 */
export function compressGitDiff(text: string, caps: Caps = DEFAULT_CAPS, command?: string): string {
  return stripRetry(text, (t) => compressGitDiffInner(t, caps, command))
}

function compressGitDiffInner(text: string, caps: Caps = DEFAULT_CAPS, command?: string): string {
  const firstBlock = text.indexOf('diff --git ')
  if (firstBlock < 0) return text
  const files = splitDiffBlocks(text)
  if (files.length === 0) return text

  const totalAdded = files.reduce((n, f) => n + f.added, 0)
  const totalRemoved = files.reduce((n, f) => n + f.removed, 0)
  // Anything above the first block is cursor state plus whatever stderr said:
  // `warning: LF will be replaced by CRLF`, `warning: unable to access ...`,
  // `git: 'foo' is not a git command`. The hook re-applies `2>&1`, so those
  // lines arrive on this stream, and they are the only sign of a broken
  // invocation - dropping them left output that looked complete.
  const preamble = text.slice(0, firstBlock).split('\n').filter((line) => line.trim() !== '')
  const out: string[] = [
    ...preamble,
    `${files.length} file${files.length === 1 ? '' : 's'} changed, +${totalAdded} -${totalRemoved}`,
  ]

  let budget = caps.maxDiffTotalLines
  let elidedFiles = 0
  let elidedAdded = 0
  let elidedRemoved = 0

  for (const f of files) {
    if (budget <= 0) {
      elidedFiles += 1
      elidedAdded += f.added
      elidedRemoved += f.removed
      continue
    }
    out.push('')
    if (f.binary) {
      out.push(`${f.path}  (binary)`)
      budget -= 2
      continue
    }
    out.push(`${f.path}  +${f.added} -${f.removed}`)
    budget -= 2 // the blank separator and this summary line both cost a line

    // The block ends with the empty element created by the trailing newline;
    // collapseContext would mark that element as dropped and print `...` for a
    // hunk it kept in full.
    let end = f.hunkLines.length
    while (end > 0 && f.hunkLines[end - 1] === '') end -= 1
    const kept = collapseContext(f.hunkLines.slice(0, end), 1)
    if (kept.length > caps.maxDiffLinesPerFile) {
      const shown = kept.slice(0, caps.maxDiffLinesPerFile)
      const hidden = kept.length - shown.length
      out.push(...shown)
      out.push(`... +${hidden} lines elided - raw: ${command ?? 'git diff'} -- ${f.path} # tk:raw`)
      budget -= shown.length + 1
    } else {
      out.push(...kept)
      budget -= kept.length
    }
  }

  if (elidedFiles > 0) {
    out.push('')
    out.push(`... +${elidedFiles} more file${elidedFiles === 1 ? '' : 's'} elided (+${elidedAdded} -${elidedRemoved}) - raw: ${command ?? 'git diff'} # tk:raw`)
  }
  return out.join('\n')
}

// -------------------------------------------------------------------- grep

/**
 * Compress `grep -rn` style output (`file:line:content`): a
 * `K matches in F files` header, then matches grouped by file, capped per file
 * and in total, with long lines truncated.
 *
 * Lines that do not match the `file:line:` shape (grep's own warnings,
 * "Binary file X matches") are kept verbatim at the end. If nothing matches the
 * shape, the input is returned unchanged.
 */
export function compressGrep(text: string, caps: Caps = DEFAULT_CAPS, command?: string): string {
  return stripRetry(text, (t) => compressGrepInner(t, caps, command))
}

function compressGrepInner(text: string, caps: Caps = DEFAULT_CAPS, command?: string): string {
  const byFile = new Map<string, string[]>()
  const notes: string[] = []
  let total = 0

  for (const line of text.split('\n')) {
    if (line === '') continue
    const m = /^(.+?):(\d+):(.*)$/.exec(line)
    if (m) {
      const entry = byFile.get(m[1]) ?? []
      entry.push(`${m[2]}: ${m[3]}`)
      byFile.set(m[1], entry)
      total += 1
    } else {
      notes.push(line)
    }
  }
  if (byFile.size === 0) return text

  const truncate = (s: string): string => (s.length > caps.maxLineLen ? s.slice(0, caps.maxLineLen) + '...' : s)

  const hint = command ? `${command} # tk:raw` : 're-run with # tk:raw'
  const out: string[] = [`${total} match${total === 1 ? '' : 'es'} in ${byFile.size} file${byFile.size === 1 ? '' : 's'}`]
  let budget = caps.maxGrepTotal
  let hiddenByFile = 0

  for (const [file, matches] of byFile) {
    if (budget <= 0) break
    const shown = matches.slice(0, Math.min(caps.maxGrepPerFile, budget))
    out.push('')
    out.push(`${file} (${matches.length}):`)
    for (const m of shown) out.push(truncate(m))
    if (matches.length > shown.length) {
      const hidden = matches.length - shown.length
      hiddenByFile += hidden
      out.push(`... +${hidden} more in ${file} (raw: ${hint})`)
    }
    budget -= shown.length
  }

  // Two separate reasons hide a match: the per-file cap, already reported under
  // its file, and the total budget. Report the budget on its own so no match is
  // counted twice.
  const shownTotal = caps.maxGrepTotal - Math.max(budget, 0)
  const hiddenByBudget = total - shownTotal - hiddenByFile
  if (hiddenByBudget > 0) out.push(`... +${hiddenByBudget} matches elided by the total cap (raw: ${hint})`)

  if (notes.length > 0) out.push('', ...notes)
  // Two matches in one file cost more as a grouped listing than as raw grep
  // output, so keep whichever is shorter.
  const joined = out.join('\n')
  return joined.length < text.length ? joined : text
}
