import { expect, test, tier } from 'claude-code/testing'

tier('user')

import { compressNpmInstall, planNpmInstall, DEFAULT_NPM_CAPS } from '../hooks/npm.ts'

// ------------------------------------------------------------- planner

test('npm, pnpm and yarn installs plan a compressible install', () => {
  for (const cmd of [
    'npm install',
    'npm i',
    'npm ci',
    'npm install lodash',
    'npm i -D typescript',
    'npm ci --no-audit --no-fund',
    'pnpm install',
    'pnpm i',
    'pnpm add lodash',
    'yarn install',
    'yarn add lodash',
    '/usr/local/bin/npm install',
  ]) {
    const p = planNpmInstall(cmd)
    expect(p).not.toBeNull()
    expect(p!.kind).toBe('npm-install')
    // Compression-only: the command is handed back untouched.
    expect(p!.command).toBe(cmd.trim())
  }
})

test('debug-logging installs bail out: the user asked for the firehose', () => {
  for (const cmd of ['npm install --loglevel=silly', 'npm install --loglevel silly', 'npm i --verbose', 'npm ci -dd']) {
    expect(planNpmInstall(cmd)).toBeNull()
  }
  // a quiet CI log level is still an ordinary install
  expect(planNpmInstall('npm ci --loglevel=error')).not.toBeNull()
})

test('machine formats and help flags bail out', () => {
  for (const cmd of ['npm install --json', 'npm ci --json=true', 'npm install --help', 'npm i -h', 'npm install --version', 'pnpm install --json']) {
    expect(planNpmInstall(cmd)).toBeNull()
  }
})

test('shell control syntax bails out', () => {
  for (const cmd of [
    'npm install | tee out.log',
    'npm install && npm run build',
    'npm install || exit 1',
    'npm ci; echo done',
    'npm install > out.log',
    'npm install $(cat deps)',
    'npm install ${PKG}',
    'npm install `cat pkg`',
    'npm install # tk:raw',
    'npm install\nnpm test',
    "npm install 'unbalanced",
  ]) {
    expect(planNpmInstall(cmd)).toBeNull()
  }
})

test('non-install commands are not planned', () => {
  expect(planNpmInstall('npm run build')).toBeNull()
  expect(planNpmInstall('npm test')).toBeNull()
  expect(planNpmInstall('npm uninstall lodash')).toBeNull()
  expect(planNpmInstall('pnpm run dev')).toBeNull()
  expect(planNpmInstall('yarn build')).toBeNull()
  expect(planNpmInstall('npm')).toBeNull()
  expect(planNpmInstall('pip install requests')).toBeNull()
  expect(planNpmInstall('')).toBeNull()
})

// ---------------------------------------------------------- compressor

// Captured from a real `npm ci --offline --no-audit --no-fund` (npm 12),
// plus the TTY progress frames npm writes before it.
const NPM_CI = [
  'npm info using npm@12.0.2',
  'npm info using node@v26.7.0',
  '⸨##################⸩ ⠸ reify:lodash: timing reifyNode:node_modules/lodash Completed in 12ms',
  'npm http cache lodash@https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz 0ms (cache hit)',
  'npm http cache chalk@https://registry.npmjs.org/chalk/-/chalk-4.1.2.tgz 0ms (cache hit)',
  '[##################] | reify:chalk: http fetch GET 200 74ms',
  'reify:ansi-styles: timing reifyNode:node_modules/chalk Completed in 3ms',
  'npm notice New minor version of npm available! 12.0.2 -> 12.1.0',
  '',
  'added 7 packages in 232ms',
  'npm info ok',
  '',
].join('\n')

test('happy path: summary survives, progress and lifecycle noise does not', () => {
  const out = compressNpmInstall(NPM_CI)
  expect(out).toContain('added 7 packages in 232ms')
  expect(out).not.toContain('npm info using')
  expect(out).not.toContain('npm http cache')
  expect(out).not.toContain('reify:')
  expect(out).not.toContain('npm notice')
  expect(out).not.toContain('⸨')
  expect(out).not.toContain('[##################]')
  expect(out.length).toBeLessThan(NPM_CI.length)
})

test('pure-TTY output with bare CR frames keeps the summary', () => {
  const raw = '⠸ reify:lodash\r⠼ reify:chalk\r⠴ reify:typescript\radded 7 packages in 232ms\r\n'
  const out = compressNpmInstall(raw)
  expect(out).toBe('added 7 packages in 232ms')
})

test('ANSI colour codes are stripped', () => {
  const raw = ['\x1b[32madded 3 packages\x1b[39m in 1.2s', '\x1b[31mnpm error code ERESOLVE\x1b[39m'].join('\n')
  const out = compressNpmInstall(raw)
  expect(out).toContain('added 3 packages')
  expect(out).toContain('npm error code ERESOLVE')
  expect(out).not.toContain('\x1b[')
})

test('WARN and ERR lines are never dropped', () => {
  const raw = [
    'npm warn deprecated inflight@1.0.6: This module is not supported',
    'npm error code ETARGET',
    'npm error notarget No matching version found for lodash@999.0.0.',
    'npm error A complete log of this run can be found in: /home/u/.npm/_logs/x.log',
    'added 2 packages in 900ms',
    'audited 3 packages in 400ms',
    '2 vulnerabilities (1 moderate, 1 high)',
  ].join('\n')
  const out = compressNpmInstall(raw)
  expect(out).toContain('npm warn deprecated inflight@1.0.6')
  expect(out).toContain('npm error code ETARGET')
  expect(out).toContain('npm error notarget No matching version found')
  expect(out).toContain('added 2 packages')
  expect(out).toContain('audited 3 packages')
  expect(out).toContain('2 vulnerabilities (1 moderate, 1 high)')
})

test('WARN/ERR lines are capped with a tk:raw marker', () => {
  const warns = Array.from({ length: 60 }, (_, i) => `npm warn deprecated pkg${i}@1.0.0: use something else`)
  const raw = [...warns, 'added 1 package in 10ms'].join('\n')
  const out = compressNpmInstall(raw, { ...DEFAULT_NPM_CAPS, maxWarnLines: 5 })
  expect(out).toContain('pkg0@1.0.0')
  expect(out).toContain('pkg4@1.0.0')
  expect(out).not.toContain('pkg5@1.0.0')
  expect(out).toContain('... +55 warning/error lines elided - raw: npm install # tk:raw')
  expect(out).toContain('added 1 package in 10ms')
})

test('the rerun command can name the exact invocation in markers', () => {
  const warns = Array.from({ length: 6 }, (_, i) => `npm warn deprecated pkg${i}@1.0.0: nope`)
  const raw = [...warns, 'added 1 package in 10ms'].join('\n')
  const out = compressNpmInstall(raw, { ...DEFAULT_NPM_CAPS, maxWarnLines: 1 }, 'pnpm add lodash')
  expect(out).toContain('- raw: pnpm add lodash # tk:raw')
})

test('pnpm output: Packages/Progress noise out, summary and deps kept', () => {
  const raw = [
    'Lockfile is up to date, resolution step is skipped',
    'Packages: +7',
    '+++++++++',
    'Progress: resolved 7, reused 7, downloaded 0, added 7, done',
    '',
    'dependencies:',
    '+ chalk 4.1.2',
    '+ lodash 4.17.21',
    '',
    'Done in 412ms',
  ].join('\n')
  const out = compressNpmInstall(raw)
  expect(out).toContain('Packages: +7')
  expect(out).toContain('+ lodash 4.17.21')
  expect(out).toContain('Done in 412ms')
  expect(out).not.toContain('Progress:')
  expect(out).not.toContain('+++++++++')
})

test('yarn v1 output: step banners and header out, success kept', () => {
  const raw = [
    'yarn install v1.22.19',
    '[1/4] Resolving packages...',
    '[2/4] Fetching packages...',
    'warning fsevents@2.3.2: The engine "node" is incompatible with this module.',
    '[3/4] Linking dependencies...',
    '[4/4] Building fresh packages...',
    'success Saved lockfile.',
    'Done in 1.23s.',
  ].join('\n')
  const out = compressNpmInstall(raw)
  expect(out).toContain('success Saved lockfile.')
  expect(out).toContain('Done in 1.23s.')
  expect(out).toContain('warning fsevents@2.3.2')
  expect(out).not.toContain('[1/4]')
  expect(out).not.toContain('yarn install v1.22.19')
})

test('unrecognized-but-real lines are kept, not swallowed', () => {
  const raw = ['npm install', 'gyp ERR! build error', 'gyp ERR! stack Error: `make` failed with exit code: 2'].join('\n')
  const out = compressNpmInstall(raw)
  expect(out).toContain('gyp ERR! build error')
  expect(out).toContain('gyp ERR! stack Error')
})

test('never inflates: output the size of the input is returned untouched', () => {
  const raw = 'added 7 packages in 232ms\n'
  const out = compressNpmInstall(raw)
  expect(out.length).toBeLessThanOrEqual(raw.length)
  expect(out).toContain('added 7 packages in 232ms')
})

test('noise-only output is returned unchanged rather than emptied', () => {
  const raw = '⠋ reify:lodash\n⠙ reify:chalk\n'
  expect(compressNpmInstall(raw)).toBe(raw)
})

test('unrecognized output is returned unchanged', () => {
  const raw = 'bash: npm: command not found\n'
  expect(compressNpmInstall(raw)).toBe(raw)
  const prose = 'just some random text that is not an install at all\n'
  expect(compressNpmInstall(prose)).toBe(prose)
})
