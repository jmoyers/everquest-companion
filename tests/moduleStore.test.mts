// moduleStore — the served-data plumbing, run for real (JOS-510 item 1).
//
// WHAT THIS SUITE IS FOR. The store is where every behaviour that used to live in thirty-three
// copies of `useModule` now lives, so it is where the claims have to be proved. It is a plain
// module over an injected bridge and an injected scheduler — no React, no DOM, no preload — which
// is exactly why `createModuleStore` takes both rather than reaching for `window.eq` itself.
//
// THE BRIDGE IS SPIED AND THE CLOCK IS HELD. `spyBridge` records every `getModuleSnapshot` call
// and hands back a promise the TEST resolves, so "one fetch per push" and "a cursor that raced a
// fetch" are observations rather than timing bets; `schedule` collects the flush and `runFrame()`
// is the animation frame. Nothing here waits on a real clock except the two scheduler tests, which
// are about real timers on purpose.
//
// The hook itself is four lines and is exercised at the end through `hookHost.mts`. What that can
// honestly prove is stated where it is claimed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountHook } from './hookHost.mjs'
import { createModuleStore, scheduleFrame, type ModuleBridge } from '../src/renderer/src/lib/moduleStore'
import type { ModuleChanged, ModuleSnapshot } from '../src/shared/types'
import { MODULE_WORLD_CHANGED } from '../src/shared/types'

type Resolve = (v: ModuleSnapshot<unknown> | null) => void
type Store = ReturnType<typeof createModuleStore>

interface Spy {
  readonly bridge: ModuleBridge
  /** Every `getModuleSnapshot` call, in order, by module id. */
  readonly fetches: string[]
  /** How many `getModuleSnapshot` calls named this module. */
  fetchesOf(moduleId: string): number
  /** Answer the OLDEST unanswered fetch for this module with a snapshot. */
  reply(moduleId: string, state: unknown, seq: number): Promise<void>
  /** Answer the oldest unanswered fetch with NO snapshot — the engine-absent reply. */
  replyNone(moduleId: string): Promise<void>
  /** A `module:changed` frame from main. */
  push(moduleId: string, seq: number): void
  /** Main finished rebuilding the world under a new character. */
  switchCharacter(): void
  /** How many bridge listeners are currently installed, across both channels. */
  listeners(): number
  /** The store's scheduler, and the animation frame that runs whatever it collected. */
  schedule(run: () => void): void
  runFrame(): void
  frames(): number
}

function spyBridge(): Spy {
  const fetches: string[] = []
  const waiting = new Map<string, Resolve[]>()
  let cursorCbs: ((c: ModuleChanged) => void)[] = []
  let charCbs: (() => void)[] = []
  let armed: (() => void)[] = []

  const answer = async (moduleId: string, v: ModuleSnapshot<unknown> | null): Promise<void> => {
    const queue = waiting.get(moduleId) ?? []
    const next = queue.shift()
    assert.ok(next, `nothing was waiting on a ${moduleId} snapshot`)
    next(v)
    // Two turns: one for the `.then` inside the store, one for anything it chained.
    await Promise.resolve()
    await Promise.resolve()
  }

  const bridge = {
    getModuleSnapshot: (moduleId: string) => {
      fetches.push(moduleId)
      return new Promise<ModuleSnapshot<unknown> | null>((resolve) => {
        waiting.set(moduleId, [...(waiting.get(moduleId) ?? []), resolve])
      })
    },
    onModuleChanged: (cb: (c: ModuleChanged) => void) => {
      cursorCbs = [...cursorCbs, cb]
      return (): void => {
        cursorCbs = cursorCbs.filter((x) => x !== cb)
      }
    },
    onCharacter: (cb: () => void) => {
      charCbs = [...charCbs, cb]
      return (): void => {
        charCbs = charCbs.filter((x) => x !== cb)
      }
    }
  } as unknown as ModuleBridge

  return {
    bridge,
    fetches,
    fetchesOf: (moduleId) => fetches.filter((f) => f === moduleId).length,
    reply: (moduleId, state, seq) => answer(moduleId, { seq, state }),
    replyNone: (moduleId) => answer(moduleId, null),
    push: (moduleId, seq) => {
      for (const cb of cursorCbs) cb({ moduleId, seq })
    },
    switchCharacter: () => {
      for (const cb of charCbs) cb()
    },
    listeners: () => cursorCbs.length + charCbs.length,
    schedule: (run) => {
      armed = [...armed, run]
    },
    runFrame: () => {
      const due = armed
      armed = []
      for (const run of due) run()
    },
    frames: () => armed.length
  }
}

/** A store over a fresh spy. Returned together because every test needs both. */
function harness(): { spy: Spy; store: Store } {
  const spy = spyBridge()
  return { spy, store: createModuleStore({ bridge: spy.bridge, schedule: spy.schedule }) }
}

// ---- the headline: N readers are not N round trips -------------------------------------------

test('THREE READERS OF ONE MODULE COST ONE FETCH, AND ARE HANDED THE SAME OBJECT', async () => {
  // The defect this pins is the whole ticket: `character` has 7 call sites and `progression` 6, so
  // the old per-hook hook turned one engine push into seven round trips and seven distinct state
  // objects describing one fact — which also made reference equality useless downstream.
  const { spy, store } = harness()
  const seen = [0, 0, 0]
  const offs = seen.map((_, i) =>
    store.subscribe('character', () => {
      seen[i] += 1
    })
  )

  assert.deepEqual(spy.fetches, ['character'], 'three readers opened three round trips')
  const state = { zone: 'Plane of Sky' }
  await spy.reply('character', state, 7)

  assert.deepEqual(seen, [1, 1, 1], 'every reader was told exactly once')
  assert.equal(store.getSnapshot('character'), state, 'the reply is handed through, not copied')
  assert.equal(
    store.getSnapshot('character'),
    store.getSnapshot('character'),
    'two reads of one module returned different objects — reference equality is the guarantee'
  )
  for (const off of offs) off()
})

test('a push costs ONE fetch however many readers there are', async () => {
  const { spy, store } = harness()
  const offs = [0, 1, 2, 3].map(() => store.subscribe('progression', () => undefined))
  await spy.reply('progression', { xp: 1 }, 1)
  assert.equal(spy.fetchesOf('progression'), 1)

  spy.push('progression', 2)
  spy.runFrame()
  assert.equal(spy.fetchesOf('progression'), 2, 'one push, one fetch — not one per reader')
  for (const off of offs) off()
})

// ---- the frame flush -------------------------------------------------------------------------

test('THREE PUSHES INSIDE ONE FRAME ARE ONE FETCH AND ONE NOTIFICATION PER SUBSCRIBER', async () => {
  // A single module's cursor can move several times inside one animation frame under a live log.
  // Fetching per push would be three round trips and three re-renders describing one end state.
  const { spy, store } = harness()
  let told = 0
  const off = store.subscribe('loot', () => {
    told += 1
  })
  await spy.reply('loot', [], 1)
  told = 0

  spy.push('loot', 2)
  spy.push('loot', 3)
  spy.push('loot', 4)
  assert.equal(spy.fetchesOf('loot'), 1, 'a push fetched on its own instead of arming the frame')
  assert.equal(spy.frames(), 1, 'three pushes armed three frames')

  spy.runFrame()
  assert.equal(spy.fetchesOf('loot'), 2, 'the frame issued more than one fetch for one module')
  await spy.reply('loot', [{ item: 'Cloak of Flames' }], 4)
  assert.equal(told, 1, 'three pushes re-rendered the subscriber three times')
  off()
})

test('several modules announcing in one engine beat are ONE frame and one fetch each', async () => {
  const { spy, store } = harness()
  const ids = ['loot', 'kills', 'turnins']
  const offs = ids.map((id) => store.subscribe(id, () => undefined))
  for (const id of ids) await spy.reply(id, {}, 1)
  const before = spy.fetches.length

  for (const id of ids) spy.push(id, 2)
  assert.equal(spy.frames(), 1, 'three modules armed three separate flushes')

  spy.runFrame()
  assert.equal(spy.fetches.length - before, 3, 'the batch did not fetch each dirty module once')
  for (const off of offs) off()
})

// ---- the cursor arithmetic, moved rather than redesigned --------------------------------------

test('IN-FLIGHT DEDUPE: a cursor that races a fetch starts no second one, and is not lost', async () => {
  const { spy, store } = harness()
  const off = store.subscribe('buffs', () => undefined)
  assert.equal(spy.fetchesOf('buffs'), 1)

  // The cursor moves while the first round trip is still out.
  spy.push('buffs', 5)
  assert.equal(spy.fetchesOf('buffs'), 1, 'a cursor during a fetch started a second fetch')
  assert.equal(spy.frames(), 0, 'a cursor during a fetch armed a frame it should have buffered')

  // …and the reply, when it lands, is from BEFORE that cursor. No later frame restates a cursor
  // already reported, so dropping it would leave the store permanently behind.
  await spy.reply('buffs', { v: 'old' }, 3)
  assert.equal(spy.frames(), 1, 'a reply landing behind the cursor did not re-ask')
  spy.runFrame()
  assert.equal(spy.fetchesOf('buffs'), 2)

  // And it terminates: a reply at or past the provoking cursor asks nothing further.
  await spy.reply('buffs', { v: 'new' }, 5)
  assert.equal(spy.frames(), 0, 'the re-ask did not settle')
  assert.deepEqual(store.getSnapshot('buffs'), { v: 'new' })
  off()
})

test('SUBSCRIBE BEFORE HYDRATE: the listener is installed before the first fetch starts', async () => {
  // Proved from the inside: this bridge emits a cursor from WITHIN `getModuleSnapshot`, i.e. at the
  // one instant a store that hydrated before subscribing would be deaf. If it were missed, the
  // reply below (behind that cursor) would be accepted as current and nothing would re-ask.
  const spy = spyBridge()
  const talkative = {
    ...spy.bridge,
    getModuleSnapshot: (moduleId: string) => {
      const reply = spy.bridge.getModuleSnapshot(moduleId)
      spy.push(moduleId, 9)
      return reply
    }
  } as unknown as ModuleBridge
  const store = createModuleStore({ bridge: talkative, schedule: spy.schedule })

  const off = store.subscribe('respawn', () => undefined)
  await spy.reply('respawn', { at: 1 }, 4)
  assert.equal(spy.frames(), 1, 'the cursor that landed during the first fetch was lost')
  spy.runFrame()
  assert.equal(spy.fetchesOf('respawn'), 2)
  off()
})

test('a cursor at or behind what is held is ignored', async () => {
  const { spy, store } = harness()
  const off = store.subscribe('alerts', () => undefined)
  await spy.reply('alerts', { n: 1 }, 5)

  spy.push('alerts', 5)
  spy.push('alerts', 4)
  assert.equal(spy.frames(), 0, 'a cursor already held provoked a fetch')
  off()
})

// ---- null is loading, and it survives the move -------------------------------------------------

test('NO SNAPSHOT IS AN ANSWER: a null reply is held as null, never smoothed into empty', async () => {
  const { spy, store } = harness()
  let told = 0
  const off = store.subscribe('combo', () => {
    told += 1
  })
  assert.equal(store.getSnapshot('combo'), null, 'nothing is held before the first reply')

  await spy.replyNone('combo')
  assert.equal(store.getSnapshot('combo'), null, 'an engine-absent reply invented a value')
  assert.equal(told, 1, 'the reader was not told that the answer is nothing')
  off()
})

// ---- the character switch ----------------------------------------------------------------------

test('A CHARACTER SWITCH CLEARS THE STORE, TELLS EVERY READER, AND ASKS AGAIN AT ONCE', async () => {
  const { spy, store } = harness()
  let told = 0
  const off = store.subscribe('kills', () => {
    told += 1
  })
  await spy.reply('kills', { mobs: { Naggy: 3 } }, 11)
  told = 0

  spy.switchCharacter()
  assert.equal(store.getSnapshot('kills'), null, 'the old character-s kills survived the switch')
  assert.equal(told, 1, 'readers were not told the world was rebuilt')
  assert.equal(spy.fetchesOf('kills'), 2, 'the new world was not asked')
  assert.equal(spy.frames(), 0, 'a character switch waited for an animation frame')

  await spy.reply('kills', { mobs: {} }, 1)
  assert.deepEqual(store.getSnapshot('kills'), { mobs: {} })
  off()
})

test('a reply already in flight for the OLD character is dropped on arrival', async () => {
  const { spy, store } = harness()
  const off = store.subscribe('character', () => undefined)
  // The first fetch is still out when the world is rebuilt under a new character.
  spy.switchCharacter()
  assert.equal(spy.fetchesOf('character'), 2, 'the switch did not ask the new world')

  await spy.reply('character', { name: 'Old' }, 4)
  assert.equal(store.getSnapshot('character'), null, 'a stale world-s reply was accepted')

  await spy.reply('character', { name: 'New' }, 1)
  assert.deepEqual(store.getSnapshot('character'), { name: 'New' })
  off()
})

test('a world change re-asks every watched module without clearing what is held', async () => {
  const { spy, store } = harness()
  const off = store.subscribe('leveling', () => undefined)
  const held = { levels: [{ level: 60, ts: 1 }] }
  await spy.reply('leveling', held, 2)

  spy.push(MODULE_WORLD_CHANGED, -1)
  assert.equal(store.getSnapshot('leveling'), held, 'a world change discarded rather than re-asked')
  spy.runFrame()
  assert.equal(spy.fetchesOf('leveling'), 2)
  off()
})

// ---- unsubscribing ------------------------------------------------------------------------------

test('UNSUBSCRIBE CLEANUP: the last reader takes the bridge listeners with it', async () => {
  const { spy, store } = harness()
  const a = store.subscribe('loot', () => undefined)
  const b = store.subscribe('kills', () => undefined)
  assert.equal(spy.listeners(), 2, 'the store installs ONE listener per channel, not one per hook')

  await spy.reply('loot', [], 1)
  a()
  assert.equal(spy.listeners(), 2, 'the listeners came off while a reader was still watching')
  b()
  assert.equal(spy.listeners(), 0, 'the last unsubscribe left the bridge listeners installed')

  // …and nothing cached survives that gap, because nothing could have recorded it going stale.
  const c = store.subscribe('loot', () => undefined)
  assert.equal(store.getSnapshot('loot'), null, 'a cache was served across a closed invalidation channel')
  assert.equal(spy.fetchesOf('loot'), 2, 'the fresh reader did not hydrate')
  c()
})

test('unsubscribing twice is a no-op, and a dead reader is never called', async () => {
  const { spy, store } = harness()
  let told = 0
  const off = store.subscribe('mobs', () => {
    told += 1
  })
  const other = store.subscribe('mobs', () => undefined)
  off()
  off()
  await spy.reply('mobs', { a: 1 }, 1)
  assert.equal(told, 0, 'an unsubscribed reader was still notified')
  assert.equal(spy.listeners(), 2, 'a second unsubscribe tore down a live subscription')
  other()
})

test('an unwatched module costs no IPC, and its cache is refreshed for the next reader', async () => {
  const { spy, store } = harness()
  // A second module keeps the store alive, so this is the per-module case rather than the
  // whole-store one above.
  const keep = store.subscribe('character', () => undefined)
  const off = store.subscribe('timers', () => undefined)
  const first = { rows: 1 }
  await spy.reply('timers', first, 3)
  off()

  spy.push('timers', 4)
  assert.equal(spy.frames(), 0, 'a module nobody is reading cost a fetch')
  assert.equal(spy.fetchesOf('timers'), 1)

  // The next reader gets the cached snapshot for its first paint AND a fresh fetch — which is
  // strictly better than the flash of `null` a per-hook remount used to produce.
  const again = store.subscribe('timers', () => undefined)
  assert.equal(store.getSnapshot('timers'), first, 'the cached snapshot was thrown away')
  assert.equal(spy.fetchesOf('timers'), 2, 'the stale cache was served without refreshing it')
  again()
  keep()
})

// ---- the scheduler, on real timers ---------------------------------------------------------------

test('THE FLUSH STILL RUNS IN A WINDOW THAT NEVER COMPOSITES', async () => {
  // rAF can be throttled to nothing in a window that is never composited (AGENTS.md records the
  // measurement for `nextFrames`), and a minimized window or one closed to the tray is the same
  // case. A store that only woke on rAF would simply stop delivering data to those windows.
  const frames = globalThis as { requestAnimationFrame?: (cb: () => void) => number }
  const had = frames.requestAnimationFrame
  delete frames.requestAnimationFrame
  try {
    let ran = 0
    scheduleFrame(() => {
      ran += 1
    })
    assert.equal(ran, 0, 'the flush ran synchronously')
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(ran, 1, 'a window with no animation frames never flushed')
  } finally {
    if (had !== undefined) frames.requestAnimationFrame = had
  }
})

test('a composited window flushes on its frame, and the floor timer does not fire a second one', async () => {
  const g = globalThis as {
    requestAnimationFrame?: (cb: () => void) => number
    cancelAnimationFrame?: (h: number) => void
  }
  const hadRaf = g.requestAnimationFrame
  const hadCancel = g.cancelAnimationFrame
  let pending: (() => void) | null = null
  g.requestAnimationFrame = (cb) => {
    pending = cb
    return 1
  }
  g.cancelAnimationFrame = () => undefined
  try {
    let ran = 0
    scheduleFrame(() => {
      ran += 1
    })
    const frame = pending as (() => void) | null
    assert.ok(frame, 'no animation frame was requested')
    frame()
    assert.equal(ran, 1, 'the frame did not run the flush')
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(ran, 1, 'the floor timer flushed a second time behind the frame')
  } finally {
    g.requestAnimationFrame = hadRaf
    g.cancelAnimationFrame = hadCancel
  }
})

// ---- the hook over the store ---------------------------------------------------------------------
//
// WHAT THIS LAST TEST CAN HONESTLY PROVE, and it is deliberately narrow. `hookHost` runs a hook
// with a minimal dispatcher and no DOM, so a "render" here is "the hook body ran again" — a render
// COUNT, not a DOM mutation count, and it cannot see React's batching or a real memo boundary.
// What it DOES see is the thing this ticket moved, and it runs the REAL `useModule` unmodified:
// two live instances over one module open ONE round trip, are handed ONE object, and take their
// listeners off the bridge when the last of them unmounts.
//
// The store singleton binds `window.eq` on first use, so the bridge is installed here before any
// hook runs. It is rebuilt implicitly between tests by the store's own rule — the last unsubscribe
// empties it — which is why the hook tests unmount what they mount.

const hookSpy = spyBridge()
;(globalThis as { window?: unknown }).window = { eq: hookSpy.bridge }
const { useModule } = await import('../src/renderer/src/lib/useModule')

test('THE REAL HOOK: two instances share one fetch, one object, and one bridge listener pair', async () => {
  let rendersA = 0
  let rendersB = 0
  const a = mountHook(() => {
    rendersA += 1
    return useModule<{ item: string }[]>('loot')
  })
  const b = mountHook(() => {
    rendersB += 1
    return useModule<{ item: string }[]>('loot')
  })

  assert.equal(a.value, null, 'a hook with nothing held must report null, the loading state')
  assert.equal(hookSpy.fetchesOf('loot'), 1, 'two hook instances opened two round trips')
  assert.equal(hookSpy.listeners(), 2, 'each hook installed its own bridge listeners')

  const rows = [{ item: 'Cloak of Flames' }]
  await hookSpy.reply('loot', rows, 1)
  assert.equal(a.render(), rows)
  assert.equal(b.render(), rows, 'the two instances hold different objects for one module')
  assert.ok(rendersA > 0 && rendersB > 0, 'neither hook ever ran')

  a.unmount()
  assert.equal(hookSpy.listeners(), 2, 'one unmount took the whole window-s listeners off')
  b.unmount()
  assert.equal(hookSpy.listeners(), 0, 'unmounting the last hook left the bridge listeners installed')
})
