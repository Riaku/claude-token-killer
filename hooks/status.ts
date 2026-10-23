// token-killer: the bytes this session has saved, pinned under the prompt.
//
// The count is bytes, not tokens: compression happens on text, and a
// bytes-per-token guess would be an invented number. Bytes are counted as UTF-8,
// so a non-ASCII line is what it really costs rather than how many UTF-16 units
// the string happens to have. `$.ui.status` is the only surface a plugin can put
// text on, and the engine prefixes it with the plugin's display name, so the text
// must not repeat the name. Outside the terminal (`-p`, the SDK) the engine would
// still record the call, so nothing is painted there; the count accumulates all
// the same.
//
// The engine keeps no per-session state for a plugin: `$.store` is one JSON file
// shared by every session, so keys are namespaced by `$.session.id()` and old
// ones are pruned at session start. The module caches the total so a tool call
// does not read the store, and re-binds whenever the session id changes, which is
// what keeps `/clear` and `--resume` honest.
//
// `$` may only be handed to a plain imported function, never to a method of an
// object: the engine's hook compiler rewrites `$.noun.verb(...)` at the call site
// and rejects a module that passes `$` through a member call. That is why the
// state below is module scope and every entry point is a function.

import type { EngineInterface, On } from 'claude-code'

/** The slice of `$` this module touches. */
export type StatusEngine = Pick<EngineInterface, 'ui' | 'session' | 'store' | 'clock'>

/** Sessions kept in the store; the oldest beyond this go first, at session start. */
const KEEP = 100
const TTL_MS = 14 * 24 * 60 * 60 * 1000

/** A store call that never resolves must not wedge the counter for the session. */
const WRITE_TIMEOUT_MS = 5000

type Entry = { bytes: number; at: number }

const KEY = (id: string) => `saved:${id}`

/**
 * UTF-8 length of `text`, without Buffer or TextEncoder: the hook runs in the
 * engine's own runtime, and this is the one number the counter is named after.
 */
export function utf8Length(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return bytes
}

/** A store value from an older build may be a bare number; read both shapes. */
function readEntry(value: unknown): Entry {
  if (typeof value === 'number') return { bytes: Number.isFinite(value) && value > 0 ? value : 0, at: 0 }
  if (value && typeof value === 'object') {
    const v = value as Partial<Entry>
    const bytes = Number(v.bytes)
    const at = Number(v.at)
    return { bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0, at: Number.isFinite(at) ? at : 0 }
  }
  return { bytes: 0, at: 0 }
}

/** 1482 -> "1482 B". Bytes only, by request: no KiB/MiB rewriting. */
export function savedText(bytes: number): string {
  return `${Math.max(0, Math.round(bytes))} B saved this session`
}

let id: string | null = null
let total = 0
let writing: Promise<void> | null = null
let binding: Promise<void> | null = null
let dirty = false
// `undefined` until a session.start says otherwise: a hook that runs before one
// keeps the terminal behaviour rather than silently dropping the line.
let interactive: boolean | undefined

/** Forgets everything: a test needs a cold start, and so does a hot reload. */
export function resetStatus(): void {
  id = null
  total = 0
  writing = null
  binding = null
  dirty = false
  interactive = undefined
}

/** Pins the running total; a total of 0 clears the line rather than showing noise. */
function paint($: StatusEngine): void {
  if (interactive === false) return
  try {
    $.ui.status(total > 0 ? savedText(total) : undefined)
  } catch {
    // no surface for it: the count still accumulates
  }
}

/** Binds to the running session, reloading its total when the id changed. */
async function bind($: StatusEngine): Promise<void> {
  // One bind at a time: two parallel calls that both read the store before either
  // published would each start from the same base.
  if (binding) return binding
  const current = await $.session.id()
  if (current === id) return
  binding = (async () => {
    try {
      // Read before publishing: with `id` set first, a parallel call sees the new
      // id with the old total and flushes that total over the new base.
      const stored = readEntry(await $.store.get(KEY(current)).catch(() => undefined)).bytes
      total = stored
      id = current
      // A write in flight carries the previous session's key and bytes; ask the
      // loop for one more pass so the new session's total is not left unwritten.
      if (writing) dirty = true
      paint($)
    } finally {
      binding = null
    }
  })()
  return binding
}

/** Awaits `work`, but not forever: a hung store would otherwise stop every later write. */
async function bounded<T>($: StatusEngine, work: Promise<T>): Promise<T | undefined> {
  try {
    return await Promise.race([work, $.clock.sleep(WRITE_TIMEOUT_MS).then(() => undefined)])
  } catch {
    return undefined
  }
}

/** Writes the cached total; a call made during a write coalesces into one more. */
async function flush($: StatusEngine): Promise<void> {
  if (id === null) return
  if (writing) {
    dirty = true
    return writing
  }
  writing = (async () => {
    try {
      do {
        dirty = false
        const key = id
        const bytes = total
        if (key === null) return
        const at = await bounded($, $.clock.now())
        if (at === undefined) throw new Error('clock did not answer')
        await bounded($, $.store.set(KEY(key), { bytes, at } satisfies Entry))
      } while (dirty)
    } catch {
      // A failed or timed-out write keeps the total and asks the next call to
      // retry: `dirty` stays set, so the next record writes it again.
      dirty = true
    } finally {
      writing = null
    }
  })()
  return writing
}

/**
 * Adds one tool call's saving and repaints. Never throws, so a caller may await
 * it without risking the command's output.
 */
export async function recordSaved($: StatusEngine, saved: number): Promise<void> {
  if (!(saved > 0)) return
  try {
    await bind($)
    total += Math.round(saved)
    paint($)
    await flush($)
  } catch {
    // fail-open: the compression itself already happened
  }
}

/** Binds to the session and prunes the store; called from session.start. */
export async function bindSession($: StatusEngine, surface: boolean | undefined): Promise<void> {
  if (typeof surface === 'boolean') interactive = surface
  try {
    await bind($)
    void pruneSessions($)
  } catch {
    // the counter is optional; the compressor is not
  }
}

/**
 * Drops the sessions the store no longer needs: everything past the newest
 * `KEEP`, and anything untouched for `TTL_MS`. The session just bound is never
 * dropped, however old it looks - that is the one being resumed.
 */
export async function pruneSessions($: StatusEngine): Promise<void> {
  try {
    const current = id === null ? null : KEY(id)
    const keys = (await $.store.keys()).filter((k) => k.startsWith('saved:') && k !== current)
    if (keys.length === 0) return
    const now = await $.clock.now()
    const entries: { key: string; at: number }[] = []
    for (const key of keys) entries.push({ key, at: readEntry(await $.store.get(key)).at })
    entries.sort((a, b) => b.at - a.at)
    for (const [i, { key, at }] of entries.entries()) {
      if (at === 0 || now - at > TTL_MS || i >= KEEP) await $.store.delete(key)
    }
  } catch {
    // pruning is housekeeping
  }
}

/**
 * Pins the restored total before the first tool call of a session, and prunes.
 * Registered before the tool hooks so a resumed session shows its number at
 * startup; the first `session.start` dispatch is awaited by the engine.
 */
export function installStatus(on: On): void {
  on('session.start', async ($, e, next) => {
    const surface = e as { isInteractive?: unknown }
    await bindSession($, typeof surface.isInteractive === 'boolean' ? surface.isInteractive : undefined)
    return next(e)
  })
}
