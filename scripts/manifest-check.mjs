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
const { DEFAULT_CAPS } = await import(new URL('hooks/compress.ts', root).href)

const problems = []

// 1. Every numeric cap in code is configurable, with the same default.
for (const [key, value] of Object.entries(DEFAULT_CAPS)) {
  const opt = userConfig[key]
  if (!opt) {
    problems.push(`${key}: in DEFAULT_CAPS but missing from userConfig`)
    continue
  }
  if (opt.default !== value) problems.push(`${key}: userConfig default ${opt.default} != DEFAULT_CAPS ${value}`)
  if (opt.type !== 'number') problems.push(`${key}: userConfig type is ${opt.type}, expected number`)
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
  const want = String(userConfig[row.key].default)
  if (row.def !== want) problems.push(`${row.key}: README says ${row.def}, manifest says ${want}`)
}

if (problems.length) {
  console.log(`FAIL manifest/code/README drift:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
const keys = Object.keys(userConfig)
console.log(`ok   ${keys.length} options agree across manifest, code and README: ${keys.join(', ')}`)
