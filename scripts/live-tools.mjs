// Live toolchain checks: run the real binaries, feed their real output through
// the planner + compressor pair the hook would use, and assert the invariants
// that fixtures cannot prove - no throw on a new version's output, never
// longer than the input, and every must-keep marker still present.
//
// Each tool is optional: a missing binary prints SKIP and does not fail the
// run, so the script is useful locally too. CI installs them all.
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const H = new URL('../hooks/', import.meta.url).href
const { planRewrite } = await import(H + 'plan.ts')
const { planGitLog } = await import(H + 'gitlog.ts')
const { planGitShow } = await import(H + 'gitshow.ts')
const { compressGitStatus, compressGitDiff, compressGrep } = await import(H + 'compress.ts')
const { compressGitLog } = await import(H + 'gitlog.ts')
const { compressGitShow } = await import(H + 'gitshow.ts')
const { planPytest, compressPytest } = await import(H + 'pytest.ts')
const { planGoTest, compressGoTest } = await import(H + 'gotest.ts')
const { planGoBuild, compressGoBuild } = await import(H + 'gobuild.ts')
const { planCargoTest, compressCargoTest } = await import(H + 'cargotest.ts')
const { planLs, compressLs } = await import(H + 'ls.ts')
const { planFind, compressFind } = await import(H + 'find.ts')

const root = mkdtempSync(join(tmpdir(), 'tk-live-'))
let failed = 0
let checked = 0
let skipped = 0

function has(cmd) {
  // `go version` and `go --version` differ: try both spellings before
  // declaring a toolchain missing.
  for (const suffix of ['--version', 'version']) {
    try {
      execSync(`${cmd} ${suffix}`, { stdio: 'ignore', timeout: 60000 })
      return true
    } catch {
      // next spelling
    }
  }
  return false
}

function run(cmd, cwd = root) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 })
  } catch (e) {
    // A failing command is the interesting case: its stdout/stderr is what the
    // model sees.
    return String(e.stdout ?? '') + String(e.stderr ?? '')
  }
}

function check(name, raw, compress, mustKeep) {
  checked += 1
  let once
  let twice
  try {
    once = compress(raw)
    twice = compress(raw)
  } catch (e) {
    failed += 1
    console.log(`FAIL ${name}: compressor threw on real output: ${String(e).slice(0, 120)}`)
    return
  }
  const problems = []
  if (once.length > raw.length) problems.push(`inflated ${raw.length} -> ${once.length}B`)
  if (once !== twice) problems.push('not deterministic')
  const missing = mustKeep.filter((k) => raw.includes(k) && !once.includes(k))
  if (missing.length) problems.push(`lost: ${missing.map((m) => JSON.stringify(m.slice(0, 60))).join(', ')}`)
  if (problems.length) {
    failed += 1
    console.log(`FAIL ${name}: ${problems.join('; ')}`)
    return
  }
  const pct = raw.length ? Math.round((1 - once.length / raw.length) * 100) : 0
  console.log(`ok   ${name}: ${raw.length} -> ${once.length}B (${pct}%)`)
}

function skip(name, why) {
  skipped += 1
  console.log(`SKIP ${name}: ${why} not available`)
}

// ---------------------------------------------------------------- git
const repo = join(root, 'repo')
mkdirSync(repo)
run('git init -q .', repo)
run('git config user.email ci@example.com && git config user.name ci', repo)
writeFileSync(join(repo, 'a.txt'), 'one\n')
run('git add -A && git commit -qm "first commit with a body\n\nbody line one\nbody line two"', repo)
for (let i = 0; i < 12; i += 1) {
  writeFileSync(join(repo, `f${i}.txt`), `${i}\n`)
  run(`git add -A && git commit -qm "commit ${i}: add f${i}"`, repo)
}
writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
writeFileSync(join(repo, 'untracked.txt'), 'u\n')
mkdirSync(join(repo, 'dir with space'))

const statusPlan = planRewrite('git status')
check('git status', run(statusPlan.command, repo), (t) => compressGitStatus(t), ['a.txt', 'untracked.txt'])

const diffPlan = planRewrite('git diff')
check('git diff', run(diffPlan.command, repo), (t) => compressGitDiff(t), ['a.txt', '+two'])

// A pathspec must survive the rewrite: this is the `--` regression.
const pathPlan = planRewrite('git status -- a.txt')
if (!pathPlan || pathPlan.command.indexOf('--porcelain') > pathPlan.command.indexOf('-- a.txt')) {
  failed += 1
  console.log(`FAIL git pathspec rewrite: ${pathPlan ? pathPlan.command : 'bailed'}`)
} else {
  checked += 1
  const out = run(pathPlan.command, repo)
  const okPath = out.includes('a.txt')
  console.log(`${okPath ? 'ok  ' : 'FAIL'} git pathspec rewrite: ${pathPlan.command}${okPath ? '' : ' lost the pathspec'}`)
  if (!okPath) failed += 1
}

const logPlan = planGitLog('git log')
const logRaw = run(logPlan.command, repo)
const subjects = [...logRaw.matchAll(/^\s+commit [0-9a-f]{7,40}|^commit ([0-9a-f]{7,40})/gm)].length
check('git log', logRaw, (t) => compressGitLog(t, { maxEntries: 50, rerun: logPlan.command }), [
  'commit 11: add f11',
  'commit 0: add f0',
  'first commit',
])
if (subjects === 0) {
  failed += 1
  console.log('FAIL git log: the fixture repo produced no commits')
}

const showPlan = planGitShow('git show HEAD')
check('git show', run(showPlan.command, repo), (t) => compressGitShow(t), ['f11.txt', '+1'])

check('grep -rn', run('grep -rn two .', repo), (t) => compressGrep(t), ['a.txt'])

// ---------------------------------------------------------------- pytest
// `python3` on Linux and macOS runners, `python` when that is the only name.
let PY = ''
for (const cand of ['python3', 'python']) {
  if (has(`${cand} -m pytest`)) {
    PY = cand
    break
  }
}
if (PY) {
  const py = join(root, 'py')
  mkdirSync(py)
  const lines = ['import pytest', '']
  for (let i = 0; i < 30; i += 1) lines.push(`def test_pass_${i}():`, `    assert ${i} == ${i}`, '')
  lines.push('def test_fail():', '    assert 1 == 2', '')
  writeFileSync(join(py, 'test_live.py'), lines.join('\n'))
  for (const cmd of [`${PY} -m pytest -q`, `${PY} -m pytest`]) {
    const plan = planPytest(cmd)
    if (!plan) {
      failed += 1
      console.log(`FAIL pytest: ${cmd} did not plan`)
      continue
    }
    check(
      `pytest (${cmd.replace(`${PY} -m `, '')})`,
      run(cmd, py),
      (t) => compressPytest(t, undefined, plan.command),
      ['test_fail', 'assert 1 == 2', 'passed', 'failed'],
    )
  }
} else skip('pytest', 'pytest')

// ---------------------------------------------------------------- go
if (has('go')) {
  const go = join(root, 'go')
  mkdirSync(join(go, 'good'), { recursive: true })
  mkdirSync(join(go, 'broken'), { recursive: true })
  writeFileSync(join(go, 'go.mod'), 'module example.com/live\n\ngo 1.21\n')
  writeFileSync(
    join(go, 'good', 'good_test.go'),
    'package good\n\nimport "testing"\n\nfunc TestPass(t *testing.T) {}\n\nfunc TestFail(t *testing.T) { t.Fatalf("want 1, got 2") }\n',
  )
  writeFileSync(join(go, 'broken', 'broken.go'), 'package broken\n\nfunc F() int { return "not an int" }\n')

  const testPlan = planGoTest('go test -v ./...')
  const testRaw = run('go test -v ./...', go)
  check('go test -v ./...', testRaw, (t) => compressGoTest(t, undefined, testPlan.command), [
    '--- FAIL: TestFail',
    'want 1, got 2',
    '[build failed]',
  ])

  const buildPlan = planGoBuild('go build ./...')
  const buildRaw = run('go build ./...', go)
  check('go build ./...', buildRaw, (t) => compressGoBuild(t, undefined, buildPlan.command), [
    'broken/broken.go',
    'cannot use',
  ])
} else skip('go', 'go')

// ---------------------------------------------------------------- cargo
if (has('cargo')) {
  const rs = join(root, 'rs')
  mkdirSync(join(rs, 'src'), { recursive: true })
  writeFileSync(join(rs, 'Cargo.toml'), '[package]\nname = "live"\nversion = "0.1.0"\nedition = "2021"\n')
  writeFileSync(
    join(rs, 'src', 'lib.rs'),
    '#[cfg(test)]\nmod tests {\n  #[test]\n  fn passes() {}\n\n  #[test]\n  fn fails() { assert_eq!(1, 2); }\n}\n',
  )
  const plan = planCargoTest('cargo test')
  const raw = run('cargo test', rs)
  check('cargo test', raw, (t) => compressCargoTest(t, undefined, plan.command), ['fails', 'test result: FAILED'])
} else skip('cargo', 'cargo')

// ---------------------------------------------------------------- listings
const many = join(root, 'many')
mkdirSync(many)
for (let i = 0; i < 120; i += 1) writeFileSync(join(many, `entry-${String(i).padStart(3, '0')}.txt`), '')
const lsPlan = planLs('ls -la')
check('ls -la', run(`ls -la ${many}`), (t) => compressLs(t, undefined, lsPlan.command), ['entry-000.txt', 'entry-119.txt'])
const findPlan = planFind(`find ${many} -name "*.txt"`)
check(`find -name`, run(`find ${many} -name "*.txt"`), (t) => compressFind(t, undefined, findPlan.command), [
  'entry-000.txt',
  'entry-119.txt',
])

rmSync(root, { recursive: true, force: true })
console.log(`\n${checked} checked, ${skipped} skipped, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
