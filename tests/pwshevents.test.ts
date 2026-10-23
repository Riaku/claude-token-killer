import { expect, test, tier } from 'claude-code/testing'

tier('user')

import { compressEvents, planEvent } from '../hooks/pwshevents.ts'

// The default `Format-Table` shape `Get-WinEvent` prints. Shaped after the
// documented layout; scripts/live-windows.mjs runs the real cmdlet in CI and
// fails if this parser inflates or mis-recognises it.
const EVENTS = [
  '   TimeCreated                     Id LevelDisplayName Message',
  '   -----------                    --- ---------------- -------',
  '   23/10/2026 10:00:00            12 Information      The operating system started at 10:00:00 on 2026-10-23.',
  '                                                       This is the wrapped continuation of the message, which',
  '                                                       can run for another eight lines on a real event.',
  '   23/10/2026 10:00:04            13 Error            The application failed to start.',
  '   23/10/2026 10:00:09          1000 Warning          A service took longer than expected to stop.',
  '   23/10/2026 10:00:12            12 Information      Another quiet event.',
].join('\n')

const CAPS = { maxRows: 200 }

test('Get-WinEvent is planned, and nothing else is', () => {
  expect(planEvent('Get-WinEvent -LogName System -MaxEvents 20')!.kind).toBe('ps-event')
  expect(planEvent('get-winevent -LogName Application')!.kind).toBe('ps-event')
  expect(planEvent('Microsoft.PowerShell.Diagnostics\\Get-WinEvent')).not.toBeNull()
  expect(planEvent('Get-WinEvent -ListLog System*')).not.toBeNull()
  expect(planEvent('Get-WinEvent -LogName System -Xml')).toBeNull()
  expect(planEvent('Get-WinEvent -LogName System | Select-Object -First 2')).toBeNull()
  expect(planEvent('Get-EventLog -LogName System')).toBeNull()
})

test('one line per event, wrapped message lines counted and dropped', () => {
  const out = compressEvents(EVENTS, CAPS, 'Get-WinEvent -LogName System')
  expect(out).toContain('The operating system started at 10:00:00')
  expect(out).toContain('The application failed to start.')
  expect(out).not.toContain('wrapped continuation')
  expect(out).toContain('2 wrapped message lines elided')
  expect(out.split('\n').filter((l) => l.startsWith('23/10/2026')).length).toBe(4)
  expect(out.length).toBeLessThan(EVENTS.length)
})

test('the level and the event id survive on each row', () => {
  const out = compressEvents(EVENTS, CAPS)
  expect(out).toContain('13 Error')
  expect(out).toContain('1000 Warning')
})

test('the row cap elides with a count and the tk:raw hint', () => {
  const out = compressEvents(EVENTS, { maxRows: 2 }, 'Get-WinEvent -LogName System')
  expect(out).toContain('The operating system started')
  expect(out).not.toContain('Another quiet event')
  expect(out).toContain('+2 more events - raw: Get-WinEvent -LogName System # tk:raw')
})

test('a log whose first column is not a timestamp is left alone', () => {
  const other = [
    'Severity  Message',
    '--------  -------',
    'Info      started',
    'Error     stopped',
  ].join('\n')
  expect(compressEvents(other, CAPS)).toBe(other)
})

test('never inflates: a one-event table is returned as it is', () => {
  const tiny = 'TimeCreated       Id Message\n-----------       -- -------\n23/10/2026 10:00   1 hi\n'
  const out = compressEvents(tiny, CAPS)
  expect(out.length).toBeLessThanOrEqual(tiny.length)
})
