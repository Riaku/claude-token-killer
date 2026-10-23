import { describe, expect, test } from 'claude-code/testing'
import { installStatus, pruneSessions, recordSaved, resetStatus, savedText, utf8Length, type StatusEngine } from '../hooks/status.ts'

/** A store, a session id and a status sink, in the shapes the engine hands a hook. */
let sessions = 0
function fake(name?: string) {
  let id = name ?? `session-${++sessions}`
  const store = new Map<string, unknown>()
  const lines: (string | undefined)[] = []
  const gate: { hold: Promise<void> | null; open: () => void } = { hold: null, open: () => undefined }
  const $ = {
    ui: { status: (text: string | undefined) => lines.push(text) },
    session: { id: async () => id },
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        if (gate.hold) await gate.hold
        store.set(key, value)
      },
      delete: async (key: string) => void store.delete(key),
      keys: async () => [...store.keys()],
    },
    clock: { now: async () => 1_700_000_000_000, sleep: async () => undefined },
  } as unknown as StatusEngine
  return {
    $,
    store,
    lines,
    sid: id,
    /** Holds every store.set until `release()`, to keep a write mid-flight. */
    holdWrites() {
      gate.hold = new Promise<void>((resolve) => (gate.open = resolve))
    },
    release: () => gate.open(),
    setSession: (next: string) => (id = next),
  }
}

describe('utf8Length', () => {
  test('counts bytes, not UTF-16 units', () => {
    expect(utf8Length('abc')).toBe(3)
    expect(utf8Length('é')).toBe(2)
    expect(utf8Length('→')).toBe(3)
    expect(utf8Length('🙂')).toBe(4)
    // The case that made a `text.length` count wrong: four emoji are eight
    // UTF-16 units but sixteen bytes.
    expect(utf8Length('🙂🙂🙂🙂')).toBe(16)
    expect(utf8Length('')).toBe(0)
  })
})

describe('savedText', () => {
  test('bytes stay bytes - no KiB rewriting', () => {
    // The count is bytes because bytes are what the hook measured; showing
    // "1.4 KiB" would be a second number nobody can check against the toast.
    expect(savedText(999)).toBe('999 B saved this session')
    expect(savedText(1482)).toBe('1482 B saved this session')
    expect(savedText(1_048_576)).toBe('1048576 B saved this session')
  })

  test('a fractional or negative count cannot print a nonsense figure', () => {
    expect(savedText(0)).toBe('0 B saved this session')
    expect(savedText(-40)).toBe('0 B saved this session')
    expect(savedText(12.6)).toBe('13 B saved this session')
  })
})

describe('counter', () => {
  test('accumulates across calls and pins the running total', async () => {
    resetStatus()
    const { $, lines } = fake()
    await recordSaved($, 725)
    await recordSaved($, 275)
    expect(lines.at(-1)).toBe('1000 B saved this session')
  })

  test('re-entering a session reads its total back from the store', async () => {
    resetStatus()
    const { $, setSession, lines, sid } = fake()
    await recordSaved($, 700)
    // `--resume` in a new process looks like this: the counter binds to a
    // different id, then back to the old one, which re-reads the stored total.
    setSession('somewhere-else')
    await recordSaved($, 1)
    expect(lines.at(-1)).toBe('1 B saved this session')
    setSession(sid)
    await recordSaved($, 2)
    expect(lines.at(-1)).toBe('702 B saved this session')
  })

  test('sessions do not share a total', async () => {
    resetStatus()
    const { $, setSession, lines, store, sid } = fake()
    await recordSaved($, 100)
    setSession('session-b')
    await recordSaved($, 5)
    expect(lines.at(-1)).toBe('5 B saved this session')
    expect(store.get(`saved:${sid}`)).toMatchObject({ bytes: 100 })
    expect(store.get('saved:session-b')).toMatchObject({ bytes: 5 })
  })

  test('two calls in flight keep both increments', async () => {
    resetStatus()
    const { $, store, sid } = fake()
    // Both records call bind before either publishes; neither may start from the
    // other's half-written base, and neither increment may be dropped.
    await Promise.all([recordSaved($, 500), recordSaved($, 800)])
    expect(store.get(`saved:${sid}`)).toMatchObject({ bytes: 1300 })
  })

  test('a session switch during a write still stores the new total', async () => {
    resetStatus()
    const { $, store, setSession } = fake()
    await recordSaved($, 300)
    setSession('after-switch')
    await recordSaved($, 40)
    expect(store.get('saved:after-switch')).toMatchObject({ bytes: 40 })
  })

  test('a saved-0 tool call neither writes nor paints', async () => {
    resetStatus()
    const { $, store, lines } = fake()
    await recordSaved($, 0)
    expect(store.size).toBe(0)
    expect(lines).toHaveLength(0)
  })

  test('junk in the store reads as zero instead of NaN', async () => {
    resetStatus()
    const { $, store, lines, setSession } = fake()
    const junk = ['abc', Number.NaN, -5, { bytes: 'x' }, { bytes: -1 }, null, []]
    for (const [i, value] of junk.entries()) {
      const sid = `junk-${i}`
      store.set(`saved:${sid}`, value)
      setSession(sid)
      await recordSaved($, 10)
      expect(lines.at(-1)).toBe('10 B saved this session')
    }
  })

  test('a broken engine costs the count, never the caller', async () => {
    resetStatus()
    const lines: (string | undefined)[] = []
    // No session at all: the id read throws, so nothing is painted or written.
    await recordSaved({ ui: { status: (t: string | undefined) => lines.push(t) } } as unknown as StatusEngine, 500)
    expect(lines).toHaveLength(0)

    // A store that rejects on read: the total starts from zero, the call survives.
    const store = new Map<string, unknown>()
    const rejecting = {
      ui: { status: (t: string | undefined) => lines.push(t) },
      session: { id: async () => 'rejecting' },
      store: {
        get: async () => {
          throw new Error('nope')
        },
        set: async (k: string, v: unknown) => void store.set(k, v),
        delete: async () => undefined,
        keys: async () => [],
      },
      clock: { now: async () => 1, sleep: async () => undefined },
    } as unknown as StatusEngine
    await recordSaved(rejecting, 250)
    expect(lines.at(-1)).toBe('250 B saved this session')
    expect(store.get('saved:rejecting')).toMatchObject({ bytes: 250 })
  })

  test('a write that never resolves does not wedge the counter', async () => {
    resetStatus()
    const { $, store, holdWrites, release, sid } = fake()
    holdWrites()
    const stuck = recordSaved($, 100) // stuck inside store.set
    await recordSaved($, 50) // returns: the first write is in flight, this coalesces
    release()
    await stuck
    await recordSaved($, 25)
    expect(store.get(`saved:${sid}`)).toMatchObject({ bytes: 175 })
  })
})

describe('prune', () => {
  test('keeps the newest KEEP sessions and drops the rest', async () => {
    resetStatus()
    const { $, store } = fake()
    const now = 1_700_000_000_000
    for (let i = 0; i < 105; i++) store.set(`saved:old-${i}`, { bytes: 1, at: now - (200 - i) * 1000 })
    await pruneSessions($)
    expect(store.size).toBe(100)
    expect(store.has('saved:old-104')).toBe(true) // newest kept
    expect(store.has('saved:old-0')).toBe(false) // oldest dropped
  })

  test('drops anything past the TTL, however few keys there are', async () => {
    resetStatus()
    const { $, store } = fake()
    store.set('saved:stale', { bytes: 1, at: 1_600_000_000_000 })
    store.set('saved:fresh', { bytes: 1, at: 1_700_000_000_000 })
    await pruneSessions($)
    expect(store.has('saved:stale')).toBe(false)
    expect(store.has('saved:fresh')).toBe(true)
  })

  test('never drops the session it is bound to', async () => {
    resetStatus()
    const { $, store, sid } = fake()
    await recordSaved($, 5) // binds to sid
    store.set(`saved:${sid}`, { bytes: 5, at: 1 }) // ancient, and still the one in use
    await pruneSessions($)
    expect(store.has(`saved:${sid}`)).toBe(true)
  })

  test('entries without a timestamp are junk and go, other keys stay', async () => {
    resetStatus()
    const { $, store } = fake()
    store.set('saved:bare', 12)
    store.set('other:key', { bytes: 1, at: 1 })
    await pruneSessions($)
    expect(store.has('saved:bare')).toBe(false)
    expect(store.has('other:key')).toBe(true) // not this plugin's key
  })
})

describe('installStatus', () => {
  function capture() {
    let handler:
      | ((engine: StatusEngine, event: unknown, next: (e: unknown) => Promise<unknown>) => Promise<unknown>)
      | undefined
    const on = ((_pattern: string, h: typeof handler) => {
      handler = h
      return { catch: () => undefined }
    }) as unknown as Parameters<typeof installStatus>[0]
    return { on, handler: () => handler! }
  }

  test('binds, paints the restored total and continues the chain', async () => {
    resetStatus()
    const { $, store, sid, lines } = fake()
    store.set(`saved:${sid}`, { bytes: 42, at: 1_700_000_000_000 })
    const { on, handler } = capture()
    installStatus(on)

    let chained = false
    await handler()($, { isInteractive: true }, async () => {
      chained = true
      return 'done'
    })
    expect(chained).toBe(true)
    expect(lines.at(-1)).toBe('42 B saved this session')
  })

  test('does not paint off the terminal, and still accumulates', async () => {
    resetStatus()
    const { $, store, lines, sid } = fake()
    const { on, handler } = capture()
    installStatus(on)
    await handler()($, { isInteractive: false }, async () => 'done')
    await recordSaved($, 120)
    expect(lines).toHaveLength(0)
    expect(store.get(`saved:${sid}`)).toMatchObject({ bytes: 120 })
  })

  test('a failing engine still continues the chain', async () => {
    resetStatus()
    const { on, handler } = capture()
    installStatus(on)
    let chained = false
    await handler()({} as StatusEngine, {}, async () => {
      chained = true
      return 'done'
    })
    expect(chained).toBe(true)
  })
})
