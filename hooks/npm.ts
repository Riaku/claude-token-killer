// npm / pnpm / yarn install output: compression-only support.
//
// The planner recognizes `npm install|i|ci`, `pnpm install|i|add` and
// `yarn install|add`, and never rewrites the command - lockfile semantics
// differ per package manager and a wrong rewrite is far worse than wasted
// tokens. The win is stdout hygiene: TTY progress bars, braille spinners,
// npm's reify/timing chatter, pnpm's Progress lines and yarn's step
// banners are pure noise. What survives: the summary lines (`added N
// packages`, `audited N packages`, `N vulnerabilities`, pnpm's
// `Packages:`/`Done in`, yarn's `success`), every WARN/ERR line, and
// anything unrecognized (kept - dropping unknown text is how mods lose
// real errors).
//
// Safety mirrors the rest of the mod: bail on shell control syntax
// (tokenize from ./plan.ts), on --json (machine format) and on explicit
// debug logging (--loglevel=silly|verbose, --verbose, -dd/-ddd) - there
// the noise IS the output the user asked for. --dry-run is deliberately
// NOT a bail: its output is the same shape and compresses the same way.
// Unrecognized text passes through unchanged; never inflate.

import { tokenize } from './plan.ts'
import { stripAnsi } from './ansi.ts'
import { UNSAFE, basename } from './shell.ts'

export type NpmPlan = { kind: 'npm-install'; command: string }

// Braille spinners (cli-spinners: ⠋⠙⠹...) and block-drawing progress bars.
const SPINNER = /[\u2800-\u28FF]/
const PROGRESS = /[\u2588\u2584\u2585\u2586\u2587\u2581\u2582\u2583\u258D\u258E\u258F]/

export type NpmCaps = {
  /** kept WARN/ERR lines before the rest are elided with a tk:raw marker. */
  maxWarnLines: number
}

export const DEFAULT_NPM_CAPS: NpmCaps = {
  maxWarnLines: 50,
}

/** Re-run command quoted in elision markers; the planner hands it to us. */
export const NPM_RERUN = 'npm install'

const SUBCOMMANDS: Record<string, Set<string>> = {
  npm: new Set(['install', 'i', 'ci']),
  pnpm: new Set(['install', 'i', 'add']),
  yarn: new Set(['install', 'add']),
}

/** Decide whether a raw command is a compressible package install. */
export function planNpmInstall(command: string): NpmPlan | null {
  const cmd = command.trim()
  if (!cmd) return null
  if (UNSAFE.test(cmd)) return null
  const tokens = tokenize(cmd)
  if (!tokens || tokens.length < 2) return null

  const head = basename(tokens[0])
  const subs = SUBCOMMANDS[head]
  if (!subs || !subs.has(tokens[1])) return null

  for (let i = 2; i < tokens.length; i += 1) {
    const t = tokens[i]
    const name = t.split('=')[0]
    if (name === '--json') return null // machine format: the user owns it
    if (t === '--help' || t === '-h' || t === '--version') return null
    // Debug logging: the user asked for the firehose, so keep every line.
    if (t === '--verbose' || t === '-dd' || t === '-ddd') return null
    if (name === '--loglevel') {
      const value = t.includes('=') ? t.slice(t.indexOf('=') + 1) : tokens[i + 1]
      if (value === 'silly' || value === 'verbose') return null
    }
  }
  return { kind: 'npm-install', command: cmd }
}

// Noise: TTY progress, spinners, and the per-package lifecycle/timing
// chatter npm/pnpm/yarn print while working.
const NOISE = [
  /^[|/\\-]+\s*$/, // `|/-` spinner row
  /^\[[=\s>-]*\d+%\]/, // `[====>    ] 45%`
  /^\[[.#\-oxO\s=]{3,}\]/, // `[#######---]` style bars
  /^\[\s*\d+%\]/, // `[ 45%]`
  /^npm (timing|http|verb|silly|verbose|info|notice)\b/, // npm debug/timing chatter
  /^reify:/, // `reify:foo@1.0.0 timing reifyNode...`
  /^Progress: /, // pnpm `Progress: resolved 120, reused 100...`
  /^\[[0-9]+\/[0-9]+\]\s/, // yarn `[1/4] Resolving packages...`
  /^yarn (?:install|add) v\d/, // yarn v1 header
  /^>\s+\S+@\S+/, // lifecycle header `> esbuild@0.19.5 postinstall`
  /^\+{3,}$/, // pnpm `+++++++++` under `Packages: +7`
]

// Summary shapes every package manager prints on success.
const SUMMARY = [
  /\b(?:added|removed|changed|reused) \d+ packages?/, // npm
  /^up to date\b/, // npm
  /\baudited \d+ packages?/, // npm
  /\d+ vulnerabilities?\b/, // npm audit tail
  /^Packages: [+-]/, // pnpm
  /^(?:Done|Done in) \S/, // pnpm / yarn v1
  /(?:^|\s)Done in \d/, // yarn berry `➤ YN0000: Done in 0s 123ms`
  /^success\b/, // yarn
  /looking for funding/, // npm funding note
]

const WARN_ERR = /^(?:npm (?:warn|error)|ERR!|warning\b|ERROR\b)/i

function elision(hidden: number, rerun: string): string {
  return `... +${hidden} warning/error line${hidden === 1 ? '' : 's'} elided - raw: ${rerun} # tk:raw`
}

/**
 * Compress npm/pnpm/yarn install stdout: strip progress bars, spinners and
 * lifecycle/timing noise; keep summaries, WARN/ERR lines (capped) and
 * anything unrecognized. Text with no recognizable install shape is
 * returned unchanged. `rerun` only changes the command quoted in elision
 * markers.
 */
export function compressNpmInstall(text: string, caps: NpmCaps = DEFAULT_NPM_CAPS, rerun: string = NPM_RERUN): string {
  const clean = stripAnsi(text)
  const out: string[] = []
  let sawShape = false
  let warnShown = 0
  let warnTotal = 0

  // TTY output uses bare `\r` between progress frames; split on every form.
  for (const raw of clean.split(/\r\n|\r|\n/)) {
    const t = raw.trim()
    if (!t) continue
    if (SPINNER.test(t) || PROGRESS.test(t)) {
      sawShape = true
      continue
    }
    if (NOISE.some((re) => re.test(t))) {
      sawShape = true
      continue
    }
    if (WARN_ERR.test(t)) {
      sawShape = true
      warnTotal += 1
      if (warnShown < caps.maxWarnLines) {
        out.push(t)
        warnShown += 1
      }
      continue
    }
    if (SUMMARY.some((re) => re.test(t))) {
      sawShape = true
      out.push(t)
      continue
    }
    // Unknown text: keep it. Losing an unexpected error line is worse
    // than keeping an unexpected decoration.
    out.push(t)
  }

  if (!sawShape) return text
  if (warnTotal > warnShown) out.push(elision(warnTotal - warnShown, rerun))
  if (out.length === 0) return text
  const compressed = out.join('\n')
  if (compressed.length >= text.length) return text
  return compressed
}
