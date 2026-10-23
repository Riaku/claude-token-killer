// `Get-WinEvent`: the Windows event log as a table of timestamped rows whose
// `Message` column wraps onto however many lines the event needs - so a twenty
// event query is a hundred lines, and the useful part of each is its first line.
//
// The shape it parses:
//
//   TimeCreated                     Id LevelDisplayName Message
//   -----------                    --- ---------------- -------
//   23/10/2026 10:00:00            12 Information      The operating system started...
//                                                       and this is the wrapped rest.
//
// A row starts at the left margin; a wrapped line is indented. Rows survive at
// one line each, wrapped lines are counted and dropped, and the count is what
// tells the agent that the message was longer than what it sees.
//
// Compression-only, and never inflating. A log whose first column carries no
// recognisable timestamp is left alone.

import { stripAnsi } from './ansi.ts'
import { UNSAFE } from './shell.ts'

export type EventPlan = { kind: 'ps-event'; command: string }
export type EventCaps = { maxRows: number }

// Machine formats and selections this parser does not model: `-List`, `-Format`?
// Only the two that would make the parser wrong are refused - `-Xml` (an XML
// document) and `-List` (a property list, not a table).
const BAIL_FLAGS = ['-xml']

/** Plan a single `Get-WinEvent` invocation. Compression-only. */
export function planEvent(command: string): EventPlan | null {
  const raw = command.trim()
  if (!raw || UNSAFE.test(raw)) return null
  const head = raw.split(/\s+/)[0].toLowerCase().replace(/^&/, '').replace(/^.*\\/, '').replace(/\.exe$/, '')
  if (head !== 'get-winevent') return null
  if (BAIL_FLAGS.some((flag) => raw.toLowerCase().includes(flag))) return null
  return { kind: 'ps-event', command: raw }
}

// A row opens with a date: `23/10/2026 10:00:00`, `10/23/2026 10:00:00 AM`,
// `2026-10-23 10:00:00`. Locale decides the order and separator, so the pattern
// accepts the common ones and nothing narrower.
const STARTS_WITH_DATE = /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}[\s,]+\d{1,2}:\d{2}/
const INDENTED = /^\s/
const RULE = /^\s*-+\s/

/**
 * Compact a `Get-WinEvent` table: one line per event (timestamp, id, level and
 * the start of the message), wrapped message lines dropped and counted, rows
 * capped. Returns the input unchanged when it is not such a table or the
 * result is not shorter.
 */
export function compressEvents(raw: string, caps: EventCaps, command = ''): string {
  const clean = stripAnsi(raw)
  const lines = clean.split('\n').map((l) => l.replace(/\s+$/, ''))
  const ruleAt = lines.findIndex((line) => RULE.test(line) && line.includes('-'))
  if (ruleAt < 0) return raw

  const out: string[] = lines.slice(0, ruleAt).filter((l) => l.trim() !== '')
  const body = lines.slice(ruleAt + 1)
  const cap = Math.max(0, caps.maxRows)
  let wrapped = 0
  let shown = 0
  let skipped = 0

  body.forEach((line) => {
    if (line.trim() === '') return
    if (!STARTS_WITH_DATE.test(line.trim())) {
      if (INDENTED.test(line)) wrapped += 1
      return
    }
    if (shown >= cap) {
      skipped += 1
      return
    }
    out.push(line.trim().replace(/ {2,}/g, ' '))
    shown += 1
  })

  if (shown === 0) return raw
  const hint = command ? ` - raw: ${command} # tk:raw` : ' - raw: re-run with # tk:raw'
  if (skipped > 0) out.push(`... +${skipped} more events${hint}`)
  if (wrapped > 0) out.push(`... ${wrapped} wrapped message lines elided${hint}`)

  const result = out.join('\n')
  return result.length < raw.length ? result : raw
}
