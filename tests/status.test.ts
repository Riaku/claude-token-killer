import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import {
  installStatus,
  pruneSessions,
  recordSaved,
  resetStatus,
  savedText,
  utf8Length,
  type StatusEngine,
} from '../hooks/status.ts'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000
const entry = (bytes: number, at = NOW) => ({ bytes, at })

// The plugin test harness implements neither `$.session.id` nor `$.ui.status`,
// so these tests hand the counter that slice themselves. Everything below is the
// real module against a real map, not a stubbed-out counter.
let sessions = 0
const fake = () => {
  const store = new Map<string, unknown>()
  const lines: string[] = []
  let sid = `session-${++sessions}`
  const $: StatusEngine = {
    ui: { status: (text: string | undefined) => void lines.push(String(text)) },
    session: { id: async () => sid },
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      keys: async () => [...store.keys()],
      delete: async (key: string) => void store.delete(key),
    },
    clock: { now: async () => NOW },
  }
  return {
    $,
    store,
    lines,
    sid: () => sid,
    setSession: (next: string) => {
      sid = next
    },
  }
}

describe('utf8Length', () => {
  test('counts bytes, not UTF-16 units', () => {
    expect(utf8Length('abc')).toBe(3)
    expect(utf8Length('é')).toBe(2)
    expect(utf8Length('→')).toBe(3)
    expect(utf8Length('🙂')).toBe(4)
    // Four emoji are eight UTF-16 units and sixteen bytes: the `length` count
    // this replaced called that 8 and under-reported every non-ASCII saving.
    expect(utf8Length('🙂🙂🙂🙂')).toBe(16)
    expect(utf8Length('')).toBe(0)
  })
})

describe('savedText', () => {
  test('bytes stay bytes - no KiB rewriting', () => {
    expect(savedText(999)).toBe('999 B saved this session')
    expect(savedText(1_048_576)).toBe('1048576 B saved this session')
  })

  test('a negative or fractional count cannot print a nonsense figure', () => {
    expect(savedText(-40)).toBe('0 B saved this session')
    expect(savedText(12.6)).toBe('13 B saved this session')
  })
})

describe('recordSaved', () => {
  test('adds up across calls and pins the running total', async () => {
    resetStatus()
    const { $, lines, store, sid } = fake()
    await recordSaved($, 725)
    await recordSaved($, 275)
    expect(store.get(`saved:${sid()}`)).toEqual(entry(1000))
    expect(lines.at(-1)).toBe('1000 B saved this session')
  })

  test('re-entering a session reads its total back from the store', async () => {
    resetStatus()
    const { $, lines, setSession, sid } = fake()
    const original = sid()
    await recordSaved($, 700)
    // `--resume` in a new process looks like this: bind to another id, then back.
    setSession('somewhere-else')
    await recordSaved($, 1)
    expect(lines.at(-1)).toBe('1 B saved this session')
    setSession(original)
    await recordSaved($, 2)
    expect(lines.at(-1)).toBe('702 B saved this session')
  })

  test('two calls in flight keep both increments', async () => {
    resetStatus()
    const { $, store, sid } = fake()
    // Both call bind before either published; without the one-bind guard each
    // starts from the same base and the 500 is lost.
    await Promise.all([recordSaved($, 500), recordSaved($, 800)])
    expect(store.get(`saved:${sid()}`)).toEqual(entry(1300))
  })

  test('a saved-0 call writes nothing and paints nothing', async () => {
    resetStatus()
    const { $, lines, store } = fake()
    await recordSaved($, 0)
    expect(store.size).toBe(0)
    expect(lines).toHaveLength(0)
  })

  test('junk in the store reads as zero, never NaN', async () => {
    resetStatus()
    const { $, lines, store, sid } = fake()
    store.set(`saved:${sid()}`, { bytes: 'lots', at: 'yesterday' })
    await recordSaved($, 40)
    expect(lines.at(-1)).toBe('40 B saved this session')
  })

  test('a store that rejects on read costs the count, not the caller', async () => {
    resetStatus()
    const store = new Map<string, unknown>()
    const $: StatusEngine = {
      ui: { status: () => undefined },
      session: { id: async () => 'rejecting' },
      store: {
        get: async () => {
          throw new Error('nope')
        },
        set: async (key: string, value: unknown) => void store.set(key, value),
        keys: async () => [],
        delete: async () => undefined,
      },
      clock: { now: async () => NOW },
    }
    await recordSaved($, 250)
    expect(store.get('saved:rejecting')).toEqual(entry(250))
  })

  test('an engine with no status surface still counts', async () => {
    resetStatus()
    const { $, store, sid } = fake()
    // What the test harness itself looks like: `ui.status` is not a function.
    await recordSaved({ ...$, ui: {} } as StatusEngine, 90)
    expect(store.get(`saved:${sid()}`)).toEqual(entry(90))
  })
})

describe('pruneSessions', () => {
  test('keeps the newest KEEP sessions and drops the rest', async () => {
    resetStatus()
    const { $, store } = fake()
    ;[...Array(105).keys()].forEach((i) => store.set(`saved:old-${i}`, entry(1, NOW - (200 - i) * 1000)))
    await pruneSessions($)
    expect(store.size).toBe(100)
    expect(store.has('saved:old-104')).toBe(true)
    expect(store.has('saved:old-0')).toBe(false)
  })

  test('drops anything past the TTL, however few keys there are', async () => {
    resetStatus()
    const { $, store } = fake()
    store.set('saved:stale', entry(1, NOW - 15 * DAY))
    store.set('saved:fresh', entry(1, NOW - 13 * DAY))
    await pruneSessions($)
    expect(store.has('saved:stale')).toBe(false)
    expect(store.has('saved:fresh')).toBe(true)
  })

  test('never drops the session it is bound to', async () => {
    resetStatus()
    const { $, store, sid } = fake()
    await recordSaved($, 5)
    store.set(`saved:${sid()}`, entry(5, 1))
    await pruneSessions($)
    expect(store.has(`saved:${sid()}`)).toBe(true)
  })

  test('drops timestamp-less entries and leaves other keys alone', async () => {
    resetStatus()
    const { $, store } = fake()
    store.set('saved:bare', 12)
    store.set('other:key', entry(1, 1))
    await pruneSessions($)
    expect(store.has('saved:bare')).toBe(false)
    expect(store.has('other:key')).toBe(true)
  })
})

type SessionStart = (engine: StatusEngine, event: unknown, next: (e: unknown) => Promise<unknown>) => Promise<unknown>

describe('installStatus', () => {
  // `on` is the engine's union of per-event subscribers; only session.start runs.
  const capture = () => {
    let handler: SessionStart | undefined
    const on = ((_event: string, hook: SessionStart) => {
      handler = hook
      return { catch: () => undefined }
    }) as unknown as On
    return { on, run: () => handler! }
  }

  test('paints the restored total at startup, then continues the chain', async () => {
    resetStatus()
    const { $, store, lines, sid } = fake()
    store.set(`saved:${sid()}`, entry(42))
    const { on, run } = capture()
    installStatus(on)
    let chained = false
    await run()($, { isInteractive: true }, async () => {
      chained = true
      return 'done'
    })
    expect(chained).toBe(true)
    expect(lines.at(-1)).toBe('42 B saved this session')
  })

  test('off the terminal it does not paint, and still stores', async () => {
    resetStatus()
    const { $, store, lines, sid } = fake()
    const { on, run } = capture()
    installStatus(on)
    await run()($, { isInteractive: false }, async () => 'done')
    await recordSaved($, 120)
    expect(lines).toHaveLength(0)
    expect(store.get(`saved:${sid()}`)).toEqual(entry(120))
  })

  test('a failing engine still continues the chain', async () => {
    resetStatus()
    const { on, run } = capture()
    installStatus(on)
    let chained = false
    await run()({} as StatusEngine, {}, async () => {
      chained = true
      return 'done'
    })
    expect(chained).toBe(true)
  })
})
