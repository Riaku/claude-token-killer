// token-killer: the bytes this session has saved, pinned under the prompt.
//
// The count is UTF-8 bytes and stays bytes: compression measures text, and a
// bytes-per-token ratio would be a number the plugin cannot back up. On a
// non-ASCII output `String.length` counts UTF-16 units, so it would claim a
// saving the model never got.
//
// The engine keeps no per-session state for a plugin: `$.store` is one JSON file
// shared by every session, so keys carry the session id and old ones are pruned
// at session start. The total is cached in module scope and re-bound whenever the
// session id changes, which is what makes `/clear` and `--resume` honest - and is
// why a tool call does not read the store back.
//
// State is module scope and every entry point is a plain function: the hook
// compiler rewrites `$.noun.verb(...)` per module and refuses to load a file that
// hands `$` to a method of an object.

import type { EngineInterface, On } from 'claude-code'

/** Only what the counter touches, so a test can satisfy it with a plain object. */
export type StatusEngine = {
  ui: Pick<EngineInterface['ui'], 'status'>
  session: Pick<EngineInterface['session'], 'id'>
  store: Pick<EngineInterface['store'], 'get' | 'set' | 'keys' | 'delete'>
  clock: Pick<EngineInterface['clock'], 'now'>
}

/** Sessions kept in the store; the oldest beyond this go first, at session start. */
const KEEP = 100
const TTL_MS = 14 * 24 * 60 * 60 * 1000

const storeKey = (id: string) => `saved:${id}`

/** UTF-8 length: 1 byte under 0x80, up to 4 above it. */
export const utf8Length = (text: string): number =>
  [...text].reduce((bytes, ch) => {
    const cp = ch.codePointAt(0) ?? 0
    return bytes + (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4)
  }, 0)

/** 1482 -> "1482 B". Bytes only, by request: no KiB/MiB rewriting. */
export const savedText = (bytes: number): string => `${Math.max(0, Math.round(bytes))} B saved this session`

/** The one place a stored value's shape is decided; anything unusable reads as 0. */
const readEntry = (value: unknown) => {
  const entry = (typeof value === 'number' ? { bytes: value } : (value ?? {})) as { bytes?: unknown; at?: unknown }
  const bytes = Number(entry.bytes)
  const at = Number(entry.at)
  return { bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0, at: Number.isFinite(at) ? at : 0 }
}

let id: string | null = null
let total = 0
let binding: Promise<string> | null = null
// `undefined` until a session.start says otherwise.
let interactive: boolean | undefined

/** Forgets everything: a test needs a cold start, and so does a hot reload. */
export function resetStatus(): void {
  id = null
  total = 0
  binding = null
  interactive = undefined
}

/**
 * Pins the running total; a total of 0 clears the line rather than showing noise.
 * A function declaration, not an arrow: the hook compiler only follows `$` past an
 * import into `function name(...)`.
 */
function paint($: StatusEngine): void {
  if (interactive === false || total === 0) return
  $.ui.status(savedText(total))
}

/**
 * Binds to the running session, loading its total the first time. One bind at a
 * time: two calls that both read the store before either published would each
 * start from the same base, and one increment would vanish.
 */
async function bind($: StatusEngine): Promise<string> {
  binding ??= (async () => {
    const current = await $.session.id()
    if (current === id) return current
    // Read before publishing: with `id` set first, a parallel call sees the new
    // id next to the old total.
    total = readEntry(await $.store.get(storeKey(current)).catch(() => undefined)).bytes
    id = current
    return current
  })().finally(() => {
    binding = null
  })
  return binding
}

/**
 * Adds one tool call's saving, stores the new total, repaints. Never throws, so a
 * caller may await it without risking the command's output.
 */
export async function recordSaved($: StatusEngine, saved: number): Promise<void> {
  if (!(saved > 0)) return
  try {
    const current = await bind($)
    total += Math.round(saved)
    await $.store.set(storeKey(current), { bytes: total, at: await $.clock.now() })
    paint($)
  } catch {
    // fail-open: the compression itself already happened
  }
}

/**
 * Drops the sessions the store no longer needs: everything past the newest
 * `KEEP`, and anything untouched for `TTL_MS`. The session just bound is never
 * dropped, however old it looks - that is the one being resumed.
 */
export async function pruneSessions($: StatusEngine): Promise<void> {
  const current = id === null ? null : storeKey(id)
  const keys = (await $.store.keys()).filter((k) => k.startsWith('saved:') && k !== current)
  const now = await $.clock.now()
  const entries = await Promise.all(keys.map(async (k) => ({ k, at: readEntry(await $.store.get(k)).at })))
  const keep = new Set(
    entries
      .filter((e) => e.at > 0 && now - e.at <= TTL_MS)
      .sort((a, b) => b.at - a.at)
      .slice(0, KEEP)
      .map((e) => e.k),
  )
  await Promise.all(entries.map((e) => (keep.has(e.k) ? undefined : $.store.delete(e.k))))
}

/**
 * Pins the restored total before the first tool call of a session, and prunes.
 * Registered before the tool hooks so a resumed session shows its number at
 * startup; the first `session.start` dispatch is awaited by the engine.
 */
export function installStatus(on: On): void {
  on('session.start', async ($, e, next) => {
    const surface = e as { isInteractive?: unknown }
    if (typeof surface.isInteractive === 'boolean') interactive = surface.isInteractive
    await bind($)
      .then(() => paint($))
      .then(() => pruneSessions($))
      .catch(() => undefined)
    return next(e)
  })
}
