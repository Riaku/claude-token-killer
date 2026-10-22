import { expect, test, tier } from 'claude-code/testing'
import { compressFluxGet, planFluxGet } from '../hooks/flux.ts'

tier('user')

// Captured from the real cluster: `flux get` uses a tabwriter, so the columns
// are TAB separated, not space padded. The generic table compactor has a tab
// path for exactly this.
const FLUX = [
  'NAMESPACE  \tNAME                  \tREVISION          \tSUSPENDED\tREADY\tMESSAGE                              ',
  'flux-system\tcert-manager-core     \tmain@sha1:fdf564c3\tFalse    \tTrue \tApplied revision: main@sha1:fdf564c3\t',
  'flux-system\tcert-manager-resources\tmain@sha1:fdf564c3\tFalse    \tTrue \tApplied revision: main@sha1:fdf564c3\t',
  'flux-system\tflux-system           \tmain@sha1:fdf564c3\tFalse    \tTrue \tApplied revision: main@sha1:fdf564c3\t',
].join('\n')

test('flux get plans as compression-only', () => {
  const plan = planFluxGet('flux get kustomizations -A')
  expect(plan).not.toBeNull()
  expect(plan!.kind).toBe('flux-get')
  expect(plan!.command).toBe('flux get kustomizations -A')
})

test('the usual flux get forms plan', () => {
  for (const cmd of [
    'flux get kustomizations -A',
    'flux get helmreleases -A',
    'flux get sources git -A',
    'flux get images all -n flux-system',
    '/usr/local/bin/flux get kustomizations',
  ]) {
    expect(planFluxGet(cmd)).not.toBeNull()
  }
})

test('output formatters, watches and non-get subcommands bail', () => {
  for (const cmd of [
    'flux get kustomizations -A -o yaml',
    'flux get kustomizations -o wide',
    'flux get kustomizations --output=json',
    'flux get kustomizations --watch',
    'flux reconcile kustomization flux-system --with-source',
    'flux get',
    'flux get kustomizations | head -5',
    'flux get kustomizations > out.txt',
    '',
  ]) {
    expect(planFluxGet(cmd)).toBeNull()
  }
})

test('the tab-separated table compresses', () => {
  const out = compressFluxGet(FLUX, undefined, 'flux get kustomizations -A')
  expect(out.length).toBeLessThan(FLUX.length)
  expect(out).toContain('# cols: namespace name revision suspended ready message')
  expect(out).toContain('flux-system cert-manager-core main@sha1:fdf564c3 False True')
  // A value with a space stays quoted so the columns remain readable.
  expect(out).toContain('"Applied revision: main@sha1:fdf564c3"')
})

test('a tab inside a value shifts the row, so the whole table bails', () => {
  const broken = [
    'NAMESPACE\tNAME\tMESSAGE',
    'flux-system\tflux-system\tApplied\trevision: x',
  ].join('\n')
  expect(compressFluxGet(broken)).toBe(broken)
})

test('a table with no rows is returned unchanged', () => {
  const headerOnly = 'NAMESPACE\tNAME\tREADY\n'
  expect(compressFluxGet(headerOnly)).toBe(headerOnly)
})

test('error output is never turned into a table', () => {
  const err = 'Error: unknown command "kustomisation" for "flux get"\n'
  expect(compressFluxGet(err)).toBe(err)
})
