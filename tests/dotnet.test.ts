import { expect, test, tier } from 'claude-code/testing'

tier('user')

import { compressDotnet, planDotnet } from '../hooks/dotnet.ts'

// `dotnet build` with a repeated warning: MSBuild prints the same diagnostic
// once per project that compiles the file, which is most of the noise in a
// solution build.
const BUILD = [
  '  Determining projects to restore...',
  '  Restored /src/App/App.csproj (in 120 ms).',
  '  Restored /src/Tests/Tests.csproj (in 90 ms).',
  '/src/App/Program.cs(3,9): warning CS0168: The variable \'x\' is declared but never used [/src/App/App.csproj]',
  '/src/Tests/Program.cs(3,9): warning CS0168: The variable \'x\' is declared but never used [/src/Tests/Tests.csproj]',
  '/src/App/Program.cs(20,9): error CS0103: The name \'foo\' does not exist [/src/App/App.csproj]',
  '  App -> /src/App/bin/Debug/net8.0/App.dll',
  '  Tests -> /src/Tests/bin/Debug/net8.0/Tests.dll',
  '',
  'Build FAILED.',
  '',
  '    1 Warning(s)',
  '    1 Error(s)',
  '',
  'Time Elapsed 00:00:02.14',
  '',
].join('\n')

// `dotnet test` on a two-test class where one fails.
const TEST = [
  '  Determining projects to restore...',
  '  All projects are up-to-date for restore.',
  '  App -> /src/App/bin/Debug/net8.0/App.dll',
  'Test run for /src/Tests/bin/Debug/net8.0/Tests.dll (.NETCoreApp,Version=v8.0)',
  'Microsoft (R) Test Execution Command Line Tool Version 17.11.0 (x64)',
  'Copyright (c) Microsoft Corporation.  All rights reserved.',
  '',
  'Starting test execution, please wait...',
  'A total of 1 test files matched the specified pattern.',
  '  Passed Test1 [1 ms]',
  '  Failed Test2 [2 ms]',
  '  Error Message:',
  '   Assert.Equal() Failure: Values differ',
  'Expected: 4',
  'Actual:   5',
  '  Stack Trace:',
  '     at Tests.UnitTest1.Test2() in /src/Tests/UnitTest1.cs:line 12',
  '     at System.RuntimeMethodHandle.InvokeMethod(Object target, Void[] args, SignatureStruct& signature)',
  '',
  'Failed!  - Failed:     1, Passed:     1, Skipped:     0, Total:     2, Duration: 45 ms - Tests.dll',
].join('\n')

const CAPS = { maxDiagLines: 40 }

test('dotnet build and dotnet test plan; other verbs do not', () => {
  expect(planDotnet('dotnet build')!.kind).toBe('dotnet-build')
  expect(planDotnet('dotnet test')!.kind).toBe('dotnet-test')
  expect(planDotnet('DOTNET BUILD -c Release')!.kind).toBe('dotnet-build')
  expect(planDotnet('dotnet test Tests/Tests.csproj --filter Unit')).not.toBeNull()
  expect(planDotnet('dotnet run')).toBeNull()
  expect(planDotnet('dotnet format --verify-no-changes')).toBeNull()
  expect(planDotnet('dotnet build && dotnet test')).toBeNull()
})

test('restore chatter and the banner go, the diagnostics and summary stay', () => {
  const out = compressDotnet(BUILD, CAPS, 'dotnet build')
  expect(out).toContain("error CS0103: The name 'foo' does not exist")
  expect(out).toContain('warning CS0168')
  expect(out).toContain('Build FAILED.')
  expect(out).toContain('1 Warning(s)')
  expect(out).toContain('App -> /src/App/bin/Debug/net8.0/App.dll')
  expect(out).not.toContain('Determining projects to restore')
  expect(out).not.toContain('Restored /src')
  expect(out.length).toBeLessThan(BUILD.length)
})

test('one warning printed per project is collapsed to one line', () => {
  const out = compressDotnet(BUILD, CAPS, 'dotnet build')
  expect(out.split('\n').filter((l) => l.includes('CS0168')).length).toBe(1)
})

test('passing tests are counted, the failure keeps its message and stack frame', () => {
  const out = compressDotnet(TEST, CAPS, 'dotnet test')
  expect(out).toContain('(1 test passed)')
  expect(out).not.toContain('Passed Test1')
  expect(out).toContain('Failed Test2')
  expect(out).toContain('Assert.Equal() Failure: Values differ')
  expect(out).toContain('at Tests.UnitTest1.Test2()')
  expect(out).toContain('Failed!  - Failed:     1, Passed:     1')
  expect(out).not.toContain('Microsoft (R) Test Execution Command Line Tool')
  expect(out).not.toContain('Starting test execution')
})

test('the diagnostic cap elides with a count', () => {
  const many = Array.from({ length: 30 }, (_, i) => `/src/A.cs(${i},1): warning CS0219: unused variable ${i} [/src/A.csproj]`)
  const out = compressDotnet(many.join('\n'), { maxDiagLines: 5 }, 'dotnet build')
  expect(out).toContain('CS0219')
  expect(out).toContain('+25 more diagnostics')
})

test('a successful build with nothing to report is left as it is', () => {
  const clean = ['Build succeeded.', '    0 Warning(s)', '    0 Error(s)', 'Time Elapsed 00:00:01.10', ''].join('\n')
  expect(compressDotnet(clean, CAPS)).toBe(clean)
})

test('never inflates: a two-line output is returned unchanged', () => {
  const tiny = 'Build succeeded.\nTime Elapsed 00:00:00.10\n'
  const out = compressDotnet(tiny, CAPS, 'dotnet build')
  expect(out.length).toBeLessThanOrEqual(tiny.length)
})
