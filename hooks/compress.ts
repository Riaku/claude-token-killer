// Token compressors: pure string -> string transforms, ported in spirit from
// rtk / ptk's output filters. No I/O, no engine types: every function here is
// testable in isolation and never inflates its input (callers compare lengths).

export type Caps = {
  /** git status: cap on listed untracked files before an elision line. */
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
  /** PowerShell Get-ChildItem: kept entries per directory section. */
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

// ---------------------------------------------------------------- git status

/**
 * Compress `git status --porcelain=v1 -b` output: the `##` branch header
 * becomes `* branch [ahead N, behind M]`, XY lines pass through (they are
 * already one line per file), and untracked listings are capped.
 *
 * An empty porcelain means a clean tree; say so in one line rather than
 * returning nothing (an agent reading empty stdout cannot tell "clean" from
 * "the command produced nothing").
 */
export function compressGitStatus(porcelain: string, caps: Caps = DEFAULT_CAPS): string {
  const lines = porcelain.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return 'clean - nothing to commit'

  const out: string[] = []
  let untrackedShown = 0
  let untrackedTotal = 0

  for (const line of lines) {
    if (line.startsWith('## ')) {
      out.push('* ' + line.slice(3))
    } else if (line.startsWith('?? ')) {
      untrackedTotal += 1
      if (untrackedShown < caps.maxStatusFiles) {
        out.push(line)
        untrackedShown += 1
      }
    } else {
      out.push(line)
    }
  }

  if (untrackedTotal > untrackedShown) {
    out.push(`... +${untrackedTotal - untrackedShown} more untracked (raw: re-run with # tk:raw)`)
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
export function compressGitDiff(text: string, caps: Caps = DEFAULT_CAPS): string {
  if (!text.includes('diff --git ')) return text
  const files = splitDiffBlocks(text)
  if (files.length === 0) return text

  const totalAdded = files.reduce((n, f) => n + f.added, 0)
  const totalRemoved = files.reduce((n, f) => n + f.removed, 0)
  const out: string[] = [`${files.length} file${files.length === 1 ? '' : 's'} changed, +${totalAdded} -${totalRemoved}`]

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
    budget -= 1

    const kept = collapseContext(f.hunkLines, 1)
    if (kept.length > caps.maxDiffLinesPerFile) {
      const shown = kept.slice(0, caps.maxDiffLinesPerFile)
      const hidden = kept.length - shown.length
      out.push(...shown)
      out.push(`... +${hidden} lines elided - raw: git diff -- ${f.path} # tk:raw`)
      budget -= shown.length + 1
    } else {
      out.push(...kept)
      budget -= kept.length
    }
  }

  if (elidedFiles > 0) {
    out.push('')
    out.push(`... +${elidedFiles} more file${elidedFiles === 1 ? '' : 's'} elided (+${elidedAdded} -${elidedRemoved}) - raw: git diff # tk:raw`)
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
export function compressGrep(text: string, caps: Caps = DEFAULT_CAPS): string {
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

  const out: string[] = [`${total} match${total === 1 ? '' : 'es'} in ${byFile.size} file${byFile.size === 1 ? '' : 's'}`]
  let budget = caps.maxGrepTotal

  for (const [file, matches] of byFile) {
    if (budget <= 0) break
    const shown = matches.slice(0, Math.min(caps.maxGrepPerFile, budget))
    out.push('')
    out.push(`${file} (${matches.length}):`)
    for (const m of shown) out.push(truncate(m))
    if (matches.length > shown.length) out.push(`... +${matches.length - shown.length} more in ${file} (raw: re-run with # tk:raw)`)
    budget -= shown.length
  }

  const shownTotal = caps.maxGrepTotal - Math.max(budget, 0)
  if (total > shownTotal) out.push(`... +${total - shownTotal} matches elided (raw: re-run with # tk:raw)`)

  if (notes.length > 0) out.push('', ...notes)
  return out.join('\n')
}
