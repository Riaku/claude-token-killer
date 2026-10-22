// The planner: decides whether a raw Bash command may be rewritten, and to
// what. Safety first - anything the planner is not sure about returns null and
// the command runs exactly as the model wrote it.
//
// Rewritten only when ALL of:
//   - the command is a single simple invocation (no pipes, &&, ;, redirects,
//     command substitution, backgrounding, unbalanced quotes)
//   - it is one of this planner's shapes: `git status`, `git diff`, or
//     recursive `grep` (git show and git log have their own planners)
//   - it carries no flag that would make our compressor wrong (-z, --json,
//     --stat, --count, --name-only, -o json)

import { UNSAFE, basename, sq } from './shell.ts'

export type PlanKind = 'git-status' | 'git-diff' | 'grep'

export type Plan = {
  kind: PlanKind
  command: string
}

/**
 * Split a trailing `2>&1` off a command.
 *
 * Only the final position is handled. There `2>&1` means "merge this command's
 * stderr into its stdout", which is exactly the stream we compress. Anywhere
 * else it changes what a pipe or a later command receives, so those commands
 * keep bailing on UNSAFE.
 *
 * The redirect is stripped before planning because the tokenizer would treat
 * `>` as an operator and the rebuild would re-quote `2>&1` as a literal
 * argument - silently changing what the command does.
 */
export function splitStderrMerge(raw: string): { body: string; merged: boolean } {
  const m = /^([\s\S]*?)\s+2>&1\s*$/.exec(raw)
  if (!m) return { body: raw, merged: false }
  return { body: m[1], merged: true }
}

/** Put a split-off `2>&1` back, last and verbatim, after any added flags. */
export function withStderrMerge(command: string, merged: boolean): string {
  return merged ? `${command} 2>&1` : command
}

/**
 * Split a command line into tokens, honoring single quotes, double quotes and
 * backslash escapes. Returns null on unbalanced quoting so the caller passes
 * the command through untouched.
 */
export function tokenize(raw: string): string[] | null {
  const tokens: string[] = []
  let cur = ''
  let has = false
  let inSingle = false
  let inDouble = false

  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i]
    if (inSingle) {
      if (c === "'") inSingle = false
      else cur += c
      continue
    }
    if (inDouble) {
      if (c === '"') {
        inDouble = false
        has = true
      } else if (c === '\\' && i + 1 < raw.length && /["\\$`]/.test(raw[i + 1])) {
        cur += raw[(i += 1)]
      } else {
        cur += c
      }
      continue
    }
    if (c === "'") {
      inSingle = true
      has = true
      continue
    }
    if (c === '"') {
      inDouble = true
      has = true
      continue
    }
    if (c === '\\' && i + 1 < raw.length) {
      cur += raw[(i += 1)]
      has = true
      continue
    }
    if (/\s/.test(c)) {
      if (has) {
        tokens.push(cur)
        cur = ''
        has = false
      }
      continue
    }
    cur += c
    has = true
  }
  if (inSingle || inDouble) return null
  if (has) tokens.push(cur)
  return tokens
}

function planGit(tokens: string[]): Plan | null {
  let i = 1
  const global: string[] = []

  // Global git options before the subcommand: only pass through the ones we
  // understand; anything else, we bail.
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const t = tokens[i]
    if (t === '-C' || t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') {
      if (i + 1 >= tokens.length) return null
      global.push(t, tokens[i + 1])
      i += 2
    } else if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=') || t === '--no-pager') {
      global.push(t)
      i += 1
    } else {
      return null
    }
  }

  const sub = tokens[i]
  const rest = tokens.slice(i + 1)
  const rebuild = (extra: string[]): string => {
    // Anything after a bare `--` is a pathspec, so `git status -- src
    // --porcelain=v1 -b` asks git about a file literally named `--porcelain=v1`
    // and the rewrite has no effect. Keep the added flags before the separator.
    const sep = rest.indexOf('--')
    const argv =
      sep === -1
        ? ['git', ...global, sub, ...rest, ...extra]
        : ['git', ...global, sub, ...rest.slice(0, sep), ...extra, ...rest.slice(sep)]
    return argv.map(sq).join(' ')
  }

  if (sub === 'status') {
    if (rest.some((t) => t === '-z' || t === '--json' || t.startsWith('--porcelain=2'))) return null
    // Already porcelain/short output: compress only, no rewrite.
    const alreadyCompact = rest.some((t) => t.startsWith('--porcelain') || t === '-s' || t === '--short' || (/^-[a-zA-Z]+$/.test(t) && t.includes('s')))
    if (alreadyCompact) return { kind: 'git-status', command: rebuild([]) }
    // No -uall. Git already collapses an untracked directory into one entry,
    // and expanding it turns twenty generated files into twenty lines - on a
    // tree with a fresh build directory that made the rewrite *bigger* than
    // plain `git status` (measured: 1133 B vs 629 B). A user who wants the
    // per-file list can still pass -u.
    return { kind: 'git-status', command: rebuild(['--porcelain=v1', '-b']) }
  }

  if (sub === 'diff') {
    const skip = ['--stat', '--numstat', '--shortstat', '--raw', '--name-only', '--name-status', '--json', '-z', '--no-index']
    if (rest.some((t) => skip.includes(t.split('=')[0]))) return null
    const hasNoColor = rest.some((t) => t === '--no-color' || t === '--color=never')
    return { kind: 'git-diff', command: hasNoColor ? rebuild([]) : rebuild(['--no-color']) }
  }

  return null
}

function planGrep(tokens: string[]): Plan | null {
  const opts = tokens.slice(1)
  let recursive = false
  let lineNumbers = false

  for (const t of opts) {
    if (t.startsWith('--')) {
      const name = t.split('=')[0]
      if (['--count', '--files-with-matches', '--files-without-match', '--quiet', '--null', '--null-data', '--include-zero'].includes(name)) return null
      if (name === '--recursive') recursive = true
      if (name === '--line-number') lineNumbers = true
    } else if (/^-[A-Za-z]+$/.test(t)) {
      const letters = t.slice(1)
      if (/[clLqZz]/.test(letters)) return null
      if (/[rR]/.test(letters)) recursive = true
      if (letters.includes('n')) lineNumbers = true
    }
  }

  if (!recursive) return null
  // -n takes no value, so inserting it up front cannot shift anything.
  return { kind: 'grep', command: ['grep', ...(lineNumbers ? [] : ['-n']), ...opts].map(sq).join(' ') }
}

/** Decide the rewrite for a raw command, or null to pass it through. */
export function planRewrite(raw: string): Plan | null {
  if (UNSAFE.test(raw)) return null
  const tokens = tokenize(raw)
  if (!tokens || tokens.length === 0) return null

  const head = basename(tokens[0])
  if (head === 'git') return planGit(tokens)
  if (head === 'grep') return planGrep(tokens)
  return null
}
