import { expect, test, tier } from 'claude-code/testing'
import { compressGoBuild, planGoBuild } from '../hooks/gobuild.ts'

tier('user')

test('go build and go vet plan as compression-only', () => {
  for (const cmd of [
    'go build ./...',
    'go vet ./...',
    'go build',
    'go vet',
    'go build -o bin/app ./cmd/app',
    '/usr/local/go/bin/go vet ./pkg/...',
  ]) {
    const plan = planGoBuild(cmd)
    expect(plan).not.toBeNull()
    expect(plan!.kind).toBe('go-build')
    expect(plan!.command).toBe(cmd)
  }
})

test('other go subcommands, verbose flags, pipes and redirects bail', () => {
  for (const cmd of [
    'go test ./...',
    'go run ./cmd/app',
    'go build -x ./...',
    'go build -n ./...',
    'go vet -json ./...',
    'go build -v ./...',
    'go build ./... | tee out.txt',
    'go build ./... && echo done',
    'go build ./... > out.txt',
    '',
  ]) {
    expect(planGoBuild(cmd)).toBeNull()
  }
})

test('silent success stays silent', () => {
  expect(compressGoBuild('')).toBe('')
  expect(compressGoBuild('\n')).toBe('\n')
})

test('module-fetch chatter is dropped, diagnostics are kept', () => {
  const raw = [
    'go: downloading github.com/x/y v1.2.3',
    'go: downloading github.com/x/z v0.1.0',
    'go: finding module for package github.com/x/w',
    '# example.com/pkg',
    './foo.go:12:5: undefined: bar',
    '',
  ].join('\n')
  const out = compressGoBuild(raw)
  expect(out).not.toContain('go: downloading')
  expect(out).not.toContain('go: finding')
  expect(out).toContain('# example.com/pkg')
  expect(out).toContain('./foo.go:12:5: undefined: bar')
  expect(out.length).toBeLessThan(raw.length)
})

test('repeated identical diagnostics collapse to a count', () => {
  const raw = Array.from({ length: 5 }, () => './foo.go:12:5: undefined: bar').join('\n')
  const out = compressGoBuild(raw)
  expect(out).toBe('./foo.go:12:5: undefined: bar  x5')
})

test('lines that merely look alike are not merged', () => {
  const raw = [
    './a.go:1:1: undefined: x',
    './b.go:1:1: undefined: x',
  ].join('\n')
  const out = compressGoBuild(raw)
  expect(out).toContain('./a.go:1:1: undefined: x')
  expect(out).toContain('./b.go:1:1: undefined: x')
})

test('vet findings survive verbatim', () => {
  const raw = [
    '# example.com/pkg',
    './main.go:9:2: fmt.Printf call has arguments but no formatting directives',
    '',
  ].join('\n')
  const out = compressGoBuild(raw)
  expect(out).toContain('fmt.Printf call has arguments but no formatting directives')
})

test('never inflates on a single error line', () => {
  const raw = './foo.go:1:1: undefined: bar'
  const out = compressGoBuild(raw)
  expect(out.length).toBeLessThanOrEqual(raw.length)
})
