// The manifest, the code, and the README have to agree about the knobs.
//
// `userConfig` in plugin.json is what makes `claude plugin configure` offer a
// setting and what fills `options` in register(); a cap that exists in code but
// not in the manifest can never be changed, and a row in the README that is not
// in the manifest documents a knob that does nothing. This check fails on any
// of those drifts, so they cannot come back quietly.
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')

const manifest = JSON.parse(read('.claude-plugin/plugin.json'))
const userConfig = manifest.userConfig ?? {}
const { CAP_CHOICES, DEFAULT_CAPS } = await import(new URL('hooks/compress.ts', root).href)

const problems = []

// 1. Every numeric cap in code is configurable, as a pick-list with the same
//    default. The type is `string` with `options` on purpose: Claude Code's
//    `/plugin configure` dialog prefills choices and booleans only, and leaves
//    `number` rows blank, so a numbers-typed cap would greet a fresh install
//    with seven empty fields instead of its defaults.
for (const [key, value] of Object.entries(DEFAULT_CAPS)) {
  const opt = userConfig[key]
  if (!opt) {
    problems.push(`${key}: in DEFAULT_CAPS but missing from userConfig`)
    continue
  }
  if (Number(opt.default) !== value) problems.push(`${key}: userConfig default ${opt.default} != DEFAULT_CAPS ${value}`)
  if (opt.type !== 'string') problems.push(`${key}: userConfig type is ${opt.type}, expected string (pickers prefill, numbers do not)`)
  if (!Array.isArray(opt.options) || opt.options.length === 0) {
    problems.push(`${key}: userConfig needs an options pick-list, or the field renders blank`)
  } else {
    if (!opt.options.includes(String(opt.default))) problems.push(`${key}: default ${opt.default} is not one of its options`)
    for (const o of opt.options) {
      if (!Number.isInteger(Number(o)) || Number(o) < 1) problems.push(`${key}: option ${o} is not a positive integer`)
    }
    // 1b. The pick-list is also the hook's contract: register() only accepts a
    //     value that is on it, so a rung added to the manifest but not to
    //     CAP_CHOICES would be a choice the user can pick and the hook discards.
    const wanted = (CAP_CHOICES[key] ?? []).map(String).join(',')
    if (wanted !== opt.options.join(',')) {
      problems.push(`${key}: options [${opt.options.join(',')}] != CAP_CHOICES [${wanted}]`)
    }
    if (!(CAP_CHOICES[key] ?? []).includes(value)) problems.push(`${key}: DEFAULT_CAPS ${value} is not in CAP_CHOICES`)
  }
}

// 2. Every non-cap option the code reads exists too.
if (!('notify' in userConfig)) problems.push('notify: read by register() but missing from userConfig')
else if (userConfig.notify.default !== true) problems.push(`notify: default ${userConfig.notify.default}, expected true`)

// 3. Every option carries the fields the schema requires.
for (const [key, opt] of Object.entries(userConfig)) {
  for (const field of ['type', 'title', 'description']) {
    if (!opt[field]) problems.push(`${key}: userConfig entry is missing ${field}`)
  }
}

// 4. The README table lists exactly these keys, with the same defaults.
const readme = read('README.md')
const rows = [...readme.matchAll(/^\|\s*`([A-Za-z_]+)`\s*\|\s*`?([^`|]+?)`?\s*\|/gm)].map((m) => ({
  key: m[1],
  def: m[2].trim(),
}))
const documented = rows.filter((r) => r.key in userConfig || r.key === 'notify')
const documentedKeys = new Set(documented.map((r) => r.key))

for (const key of Object.keys(userConfig)) {
  if (!documentedKeys.has(key)) problems.push(`${key}: in userConfig but not documented in the README table`)
}
for (const row of documented) {
  const raw = userConfig[row.key].default
  // Caps are pickers now, so the manifest holds "200" where the README says
  // 200; the boolean option has to stay as it is.
  const want = typeof raw === 'boolean' ? String(raw) : String(Number(raw))
  if (row.def !== want) problems.push(`${row.key}: README says ${row.def}, manifest says ${want}`)
}

if (problems.length) {
  console.log(`FAIL manifest/code/README drift:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
const keys = Object.keys(userConfig)
console.log(`ok   ${keys.length} options agree across manifest, code and README: ${keys.join(', ')}`)
