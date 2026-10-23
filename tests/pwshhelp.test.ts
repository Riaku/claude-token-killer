import { expect, test, tier } from 'claude-code/testing'

tier('user')

import { compressHelp, planHelp } from '../hooks/pwshhelp.ts'

// Real output captured from pwsh 7 on Linux: `Get-Help Get-ChildItem -Full`,
// trimmed to one parameter block and the tail sections. The boilerplate block
// (`Required? false / Position? Named / ...`) is verbatim and is what the
// compressor exists to drop.
const HELP = [
  'NAME',
  '    Get-ChildItem',
  '    ',
  'SYNTAX',
  '    Get-ChildItem [[-Path] <string[]>] [[-Filter] <string>] [-Recurse] [-Force] [<CommonParameters>]',
  '    ',
  '    Get-ChildItem [[-Filter] <string>] -LiteralPath <string[]> [-Recurse] [-Force] [<CommonParameters>]',
  '    ',
  '    ',
  'PARAMETERS',
  '    -Attributes <FlagsExpression[FileAttributes]>',
  '        ',
  '        Required?                    false',
  '        Position?                    Named',
  '        Accept pipeline input?       false',
  '        Parameter set name           (All)',
  '        Aliases                      None',
  '        Dynamic?                     true',
  '        Accept wildcard characters?  false',
  '        ',
  '    -Depth <uint>',
  '        ',
  '        Required?                    false',
  '        Position?                    Named',
  '        Accept pipeline input?       false',
  '        Parameter set name           (All)',
  '        Aliases                      None',
  '        Dynamic?                     false',
  '        Accept wildcard characters?  false',
  '        ',
  '    -Path <string[]>',
  '        ',
  '        Required?                    false',
  '        Position?                    0',
  '        Accept pipeline input?       true (ByValue, ByPropertyName)',
  '        Parameter set name           (All)',
  '        Aliases                      None',
  '        Accept wildcard characters?  true',
  '        ',
  'INPUTS',
  '    System.String[]',
  '    ',
  '    ',
  'OUTPUTS',
  '    System.IO.FileInfo',
  '    System.IO.DirectoryInfo',
  '    ',
  '    ',
  'ALIASES',
  '    gci',
  '    dir',
  '    ',
  'REMARKS',
  '    Get-Help cannot find the Help files for this cmdlet on this computer.',
  '    ',
  'RELATED LINKS',
  '',
].join('\n')

test('Get-Help is planned for a full topic, not for the flags that print nothing', () => {
  expect(planHelp('Get-Help Get-ChildItem -Full')!.kind).toBe('ps-help')
  expect(planHelp('help Get-ChildItem')!.kind).toBe('ps-help')
  expect(planHelp('Get-Help about_Parsing')!.kind).toBe('ps-help')
  expect(planHelp('Get-Help Get-ChildItem -Online')).toBeNull()
  expect(planHelp('Get-Help Get-ChildItem -Examples')).toBeNull()
  expect(planHelp('Get-Help Get-ChildItem | Out-String')).toBeNull()
  expect(planHelp('Get-Command Get-Help')).toBeNull()
})

test('parameter boilerplate goes, the parameter list stays', () => {
  const out = compressHelp(HELP, { maxHelpLines: 200 }, 'Get-Help Get-ChildItem -Full')
  expect(out).toContain('-Path <string[]>')
  expect(out).toContain('-Depth <uint>')
  expect(out).toContain('-Attributes <FlagsExpression[FileAttributes]>')
  expect(out).not.toContain('Required?')
  expect(out).not.toContain('Accept pipeline input?')
  expect(out).not.toContain('Parameter set name')
  expect(out.length).toBeLessThan(HELP.length)
})

test('the one-line sections and the syntax survive whole', () => {
  const out = compressHelp(HELP, { maxHelpLines: 200 })
  expect(out).toContain('NAME')
  expect(out).toContain('Get-ChildItem')
  expect(out).toContain('[-Recurse] [-Force] [<CommonParameters>]')
  expect(out).toContain('System.IO.FileInfo')
})

test('RELATED LINKS is dropped and the recovery hint is appended', () => {
  const out = compressHelp(HELP, { maxHelpLines: 200 }, 'Get-Help Get-ChildItem -Full')
  expect(out).not.toContain('RELATED LINKS')
  expect(out).toContain('# raw: Get-Help Get-ChildItem -Full # tk:raw')
})

test('a long description is cut to its opening lines with a count', () => {
  const long = ['NAME', '    x', 'DESCRIPTION', ...Array.from({ length: 30 }, (_, i) => `    line ${i}`)]
  const out = compressHelp(long.join('\n'), { maxHelpLines: 3 }, 'Get-Help x -Full')
  expect(out).toContain('line 0')
  expect(out).not.toContain('line 9')
  expect(out).toContain('... +27 lines')
})

test('a document without the section vocabulary is returned unchanged', () => {
  const plain = 'just some text\nand more\n'
  expect(compressHelp(plain, { maxHelpLines: 200 })).toBe(plain)
})

test('never inflates: a two-section topic is left as it is', () => {
  const tiny = 'NAME\n    x\nSYNOPSIS\n    y\n'
  const out = compressHelp(tiny, { maxHelpLines: 200 })
  expect(out.length).toBeLessThanOrEqual(tiny.length)
})
