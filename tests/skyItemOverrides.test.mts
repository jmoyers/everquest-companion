// ============================================================================
// JOS-186 — the hand-stated count, and the fourth count source it shares an idea with.
// ============================================================================
//
// The owner's 2026-08-14 ruling lifted this ticket's testing gate with two asks, and they are one
// idea at two scales: a count somebody vouched for at an INSTANT, plus the log trusted FORWARD from
// there. An override is that at item scale (`shared/itemOverrides.ts`); `rebaseline` is that at dump
// scale (`renderer/features/inventory/reconcile.ts`). So they are pinned in one file, because a
// change to the windowing rule has to break both or neither.
//
// WHAT THIS PINS, and why each claim is here rather than assumed:
//
//   1. THE PURE MODEL. One statement per key, later replaces earlier, a hand-edited store cannot
//      take the record down with it, and an epoch instant survives the sanitizer (the bug a shared
//      "whole non-negative, capped" helper would have introduced: a timestamp is not a bag count).
//   2. THE TWO REPORTS, AS TRACES. 01M0089H6NCBES55RTYHXDT05R destroyed a quest item and the Ready
//      tab nagged forever; 01KZZ51GNHKFNFC082CVGQQ9N8 asked for the export as a baseline with the
//      log counted only forward. Both run through the REAL `reconcile` and the REAL `readyQuests`.
//   3. THE FORWARD RULE, IN BOTH DIRECTIONS. Loot after a baseline adds; loot before it is
//      discarded; a turn-in recorded after it subtracts; one recorded before it does not (the
//      double-subtraction reconcile.ts exists to stop).
//   4. REVERSIBILITY AS DEEP EQUALITY, not as prose. Clearing a statement returns the WHOLE
//      reconcile result — every row, every field, the row order, the `net` map — to what it was
//      before the statement was made. That is the ticket's "never contaminate the log-derived
//      record" written as an assertion.
//   5. ADDITIVITY. Passing the JOS-186 inputs empty is byte-identical to omitting them, which is
//      what makes the fourth source and the overrides an addition rather than a rewrite. (The
//      three-source arithmetic itself is pinned next door, tests/countSourceDefault.test.mts,
//      whose generated deep-equality space still passes untouched.)
//
// Only `computeQuestProgress`'s per-item clamp is mirrored, the division every Sky test here makes
// — the bare runner cannot load the React-heavy useProgress module.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_ITEM_OVERRIDES,
  MAX_OVERRIDE_COUNT,
  applyItemOverride,
  clearItemOverride,
  itemOverrideInstants,
  itemOverridesByKey,
  sanitizeItemOverride,
  sanitizeItemOverrides
} from '../src/shared/itemOverrides'
import { reconcile, type ReconcileInput } from '../src/renderer/src/features/inventory/reconcile'
import { rebaselineInstant } from '../src/renderer/src/features/inventory/countSource'
import {
  computeDestroyedAfter,
  computeDestroyedAfterPerKey,
  computeHeldCounts,
  computeHeldCountsAfter,
  computeHeldCountsAfterPerKey
} from '../src/renderer/src/features/posky/heldCounts'
import { readyQuests } from '../src/renderer/src/features/posky/questCompletion'
import type { QuestProgress } from '../src/renderer/src/features/posky/useProgress'
import { questKey } from '../src/renderer/src/features/posky/keys'
import { itemCountKey } from '../src/renderer/src/lib/itemName'
import type { CountSource, ItemCountOverride, LootEvent, PoskyQuest } from '../src/shared/types'

// A hand-built two-item quest, for the reason tests/questTurnIns.test.mts states: the claim is
// arithmetic over required counts, and a synthetic quest states it far more clearly than a real one
// whose item list can be re-scraped underneath the assertion.
const CLAW: PoskyQuest = {
  className: 'Beastlord',
  name: 'Test of Claw',
  giver: 'Gorgalosk',
  items: [
    { name: 'Sphinx Claw', count: 1, who: [], where: 'Island 4' },
    { name: 'Ivory Sky Diamond', count: 1, who: [], where: 'Island 3' }
  ]
}
const QUESTS = [CLAW]
const CLAW_KEY = questKey(CLAW)
const claw = itemCountKey('Sphinx Claw')
const diamond = itemCountKey('Ivory Sky Diamond')

/** Instants far enough apart that "before" and "after" are never a rounding question. */
const T0 = 1_700_000_000_000
const HOUR = 3_600_000

// =============================================================================
// 1. The pure model
// =============================================================================

test('a statement survives the sanitizer with its EPOCH instant intact', () => {
  const o = sanitizeItemOverride({ key: claw, name: 'Sphinx Claw', count: 0, setAt: T0 })
  assert.deepEqual(o, { key: claw, name: 'Sphinx Claw', count: 0, setAt: T0 })
  // The regression this line exists for: `setAt` and `count` share a "whole non-negative" helper,
  // and capping BOTH at MAX_OVERRIDE_COUNT would silently rewrite every timestamp to 1970.
  assert.ok((o?.setAt ?? 0) > MAX_OVERRIDE_COUNT)
})

test('junk is dropped, never thrown over — a hand-edited store still opens', () => {
  assert.equal(sanitizeItemOverride(null), null)
  assert.equal(sanitizeItemOverride({ key: '  ', count: 1, setAt: T0 }), null, 'no key, no statement')
  assert.equal(sanitizeItemOverride({ key: claw, count: -1, setAt: T0 }), null, 'a bag holds no -1')
  assert.equal(sanitizeItemOverride({ key: claw, count: 1e9, setAt: T0 }), null, 'past the guard')
  assert.equal(sanitizeItemOverride({ key: claw, count: 'two', setAt: T0 }), null)
  // A missing name falls back to the key rather than rejecting: the count is the statement.
  assert.equal(sanitizeItemOverride({ key: claw, count: 2, setAt: T0 })?.name, claw)
  // An unreadable instant becomes 0 — every loot line then counts forward, which is the safe
  // direction for a statement whose date we lost.
  assert.equal(sanitizeItemOverride({ key: claw, count: 2, setAt: 'yesterday' })?.setAt, 0)
  assert.deepEqual(sanitizeItemOverrides('not a list'), [])
})

test('two statements about one item are ONE statement, the later one', () => {
  const first: ItemCountOverride = { key: claw, name: 'Sphinx Claw', count: 3, setAt: T0 }
  const second: ItemCountOverride = { key: claw, name: 'Sphinx Claw', count: 0, setAt: T0 + HOUR }
  const list = applyItemOverride(applyItemOverride([], first), second)
  assert.equal(list.length, 1)
  assert.equal(list[0].count, 0)
  assert.equal(list[0].setAt, T0 + HOUR, 'and it carries the LATER instant, so the window moves too')
  assert.deepEqual(clearItemOverride(list, claw), [], 'and the take-back leaves nothing behind')
  assert.deepEqual(clearItemOverride(list, diamond), list, 'clearing another key touches nothing')
})

test('the list is deduped by key, ordered oldest first, and capped', () => {
  const many = Array.from({ length: MAX_ITEM_OVERRIDES + 20 }, (_v, i) => ({
    key: `item-${String(i)}`,
    name: `Item ${String(i)}`,
    count: 1,
    setAt: T0 + i
  }))
  const clean = sanitizeItemOverrides([...many, ...many])
  assert.equal(clean.length, MAX_ITEM_OVERRIDES)
  assert.ok(clean.every((o, i) => i === 0 || clean[i - 1].setAt <= o.setAt))
  assert.deepEqual(itemOverridesByKey(clean.slice(0, 1)), { 'item-0': clean[0] })
  assert.deepEqual(itemOverrideInstants(clean.slice(0, 1)), { 'item-0': T0 })
})

// =============================================================================
// 2. The windowed loot folds
// =============================================================================

/** One loot line, the shape `LootModule` appends. */
const drop = (ts: number, item: string, count = 1): LootEvent => ({ ts, item, count })

test('the windowed folds are the SAME fold over fewer rows', () => {
  const history = [drop(T0 - HOUR, 'Sphinx Claw'), drop(T0 + HOUR, 'Sphinx Claw', 2), drop(T0 + HOUR, 'Bone Chips')]
  assert.deepEqual(computeHeldCounts(history), { [claw]: 3, 'bone chips': 1 })
  assert.deepEqual(computeHeldCountsAfter(history, T0), { [claw]: 2, 'bone chips': 1 })
  // STRICTLY after: a dump's generation instant is floored to the second, so a drop stamped in the
  // same second is as likely to be inside the file as outside it.
  assert.deepEqual(computeHeldCountsAfter(history, T0 + HOUR), {})
  // Per key, an absent entry means "no baseline here" — that key contributes nothing at all.
  assert.deepEqual(computeHeldCountsAfterPerKey(history, { [claw]: T0 }), { [claw]: 2 })
  assert.deepEqual(computeHeldCountsAfterPerKey(history, {}), {})
})

test('a windowed fold keeps the disposition rule it inherited', () => {
  const history: LootEvent[] = [
    { ts: T0 + HOUR, item: 'Sphinx Claw', disposition: 'sold' },
    { ts: T0 + HOUR, item: 'Sphinx Claw', disposition: 'hoard' }
  ]
  assert.deepEqual(computeHeldCountsAfter(history, T0), { [claw]: 1 }, 'sold is gone, hoarded is held')
})

test('THE WINDOWED LOOT FOLDS COUNT DROPS, GROSS - the destroys are their own window (JOS-401)', () => {
  const history: LootEvent[] = [
    drop(T0 - HOUR, 'Sphinx Claw'),
    { ts: T0 + HOUR, item: 'Sphinx Claw', disposition: 'destroyed', count: 2 },
    drop(T0 + 2 * HOUR, 'Sphinx Claw', 3)
  ]
  // The all-time fold nets: 1 looted, 2 destroyed (floors at 0), 3 looted = 3.
  assert.deepEqual(computeHeldCounts(history), { [claw]: 3 })
  // The WINDOW counts what dropped since, and nothing else: netting here as well as discounting
  // the witness in `reconcile` would subtract every destroy twice.
  assert.deepEqual(computeHeldCountsAfter(history, T0), { [claw]: 3 })
  assert.deepEqual(computeHeldCountsAfterPerKey(history, { [claw]: T0 }), { [claw]: 3 })
  // …and the discount is the other map, on the same instants and the same strictly-after rule.
  assert.deepEqual(computeDestroyedAfter(history, T0), { [claw]: 2 })
  assert.deepEqual(computeDestroyedAfter(history, T0 + HOUR), {}, 'strictly after, like every window here')
  assert.deepEqual(computeDestroyedAfterPerKey(history, { [claw]: T0 }), { [claw]: 2 })
  assert.deepEqual(computeDestroyedAfterPerKey(history, {}), {}, 'a key nobody spoke about is absent')
})

// =============================================================================
// 3. Reconcile: the statement
// =============================================================================

/** The whole reconcile input with everything defaulted, so a case states only what it varies. */
function run(over: Partial<ReconcileInput> = {}): ReturnType<typeof reconcile> {
  return reconcile({
    log: {},
    inv: {},
    lootNames: { [claw]: 'Sphinx Claw' },
    countSource: 'both',
    turnIns: {},
    quests: QUESTS,
    ...over
  })
}

/** Mirror of `computeQuestProgress`'s per-item clamp plus the two fields the Ready rule reads. */
function progressOf(net: Record<string, number>, turnIns = 0): QuestProgress {
  const items = CLAW.items.map((it) => {
    const need = it.count > 0 ? it.count : 1
    return { name: it.name, need, have: Math.min(need, net[itemCountKey(it.name)] ?? 0) }
  })
  const needCount = items.reduce((s, i) => s + i.need, 0)
  const haveCount = items.reduce((s, i) => s + i.have, 0)
  return {
    key: CLAW_KEY,
    className: CLAW.className,
    name: CLAW.name,
    items: [],
    haveCount,
    needCount,
    ratio: needCount === 0 ? 0 : haveCount / needCount,
    missing: items.filter((i) => i.have < i.need).map((i) => i.name),
    turnIns,
    logTurnIns: 0,
    completed: turnIns >= 1
  }
}

/** A statement of `count`, made at `setAt`. */
const stated = (key: string, count: number, setAt = T0): Record<string, ItemCountOverride> => ({
  [key]: { key, name: key, count, setAt }
})

test('THE DESTROYED-ITEM TRACE: the Ready tab lets go the moment the count is corrected', () => {
  // The reporter's state: the log saw both items drop, so the quest is ready and stays ready — and
  // then they destroyed the claw, which no log line and no dump can ever tell us.
  const log = { [claw]: 1, [diamond]: 1 }
  assert.deepEqual(
    readyQuests([progressOf(run({ log }).net)]).map((q) => q.name),
    ['Test of Claw'],
    'the nag, exactly as reported'
  )
  const corrected = run({ log, overrides: stated(claw, 0) })
  assert.equal(corrected.net[claw], 0, 'the statement answers for the item')
  assert.equal(corrected.net[diamond], 1, 'and for nothing else')
  assert.deepEqual(readyQuests([progressOf(corrected.net)]), [], 'the row is gone from Ready')
})

test('the statement is drawn as a row, and says it is the user`s', () => {
  const row = run({ log: { [claw]: 3 }, overrides: stated(claw, 0) }).rows.find((r) => r.key === claw)
  assert.ok(row)
  assert.equal(row.net, 0)
  assert.equal(row.log, 3, 'the log witness is REPORTED, not edited — the evidence is untouched')
  assert.equal(row.override?.count, 0, 'and the row carries the provenance the chip draws')
})

test('an item NO witness knows about still gets a row and a net (the key set)', () => {
  // Under the old key set (`log` ∪ `dump` ∪ `consumed`) this statement would never have been
  // iterated at all, so the count it states would silently not exist.
  const res = run({ overrides: stated(diamond, 2) })
  assert.equal(res.net[diamond], 2)
  assert.ok(res.rows.some((r) => r.key === diamond))
})

test('THE FORWARD RULE: loot after a statement adds, loot before it is already counted in', () => {
  const overrides = stated(claw, 1, T0)
  // `lootSinceOverride` is the caller's fold of exactly the drops after each statement.
  assert.equal(run({ log: { [claw]: 9 }, overrides }).net[claw], 1, 'no drops since: the statement')
  assert.equal(
    run({ log: { [claw]: 9 }, overrides, lootSinceOverride: { [claw]: 2 } }).net[claw],
    3,
    'two dropped since: the statement plus those two, and the nine the log remembers stay ignored'
  )
})

test('a turn-in AFTER the statement subtracts; one BEFORE it does not', () => {
  const overrides = stated(claw, 2, T0)
  const before = run({
    overrides,
    turnIns: { [CLAW_KEY]: 1 },
    turnInInstants: { [CLAW_KEY]: [T0 - HOUR] }
  })
  assert.equal(before.net[claw], 2, 'the user counted their bag AFTER handing it in — no double dip')
  const after = run({
    overrides,
    turnIns: { [CLAW_KEY]: 1 },
    turnInInstants: { [CLAW_KEY]: [T0 + HOUR] }
  })
  assert.equal(after.net[claw], 1, 'a turn-in recorded since the statement really did eat one')
  const twice = run({
    overrides,
    turnIns: { [CLAW_KEY]: 2 },
    turnInInstants: { [CLAW_KEY]: [T0 + HOUR, T0 + 2 * HOUR] }
  })
  assert.equal(twice.net[claw], 0, 'and it never goes below zero')
  assert.equal(
    twice.rows.find((r) => r.key === claw)?.consumedBy.length,
    1,
    'the blame names the quest that ate it, from the WINDOWED pass rather than the all-time one'
  )
})

// ---- JOS-401: the destroy discounts every witness, in the witness's own window ---------------

test('A DESTROY AFTER THE DUMP LOWERS THE COUNT; ONE BEFORE IT DOES NOT', () => {
  const inv = { 'sphinx claw': 3 }
  // The dump vouched for three. The log then says two were destroyed. Under every source that
  // reads the file, the file is stale by exactly that much.
  for (const s of ['inventory', 'both'] as const) {
    assert.equal(run({ countSource: s, inv }).net[claw], 3, `${s}: the dump, unchallenged`)
    assert.equal(
      run({ countSource: s, inv, destroyedSinceDump: { [claw]: 2 } }).net[claw],
      1,
      `${s}: less what the log says you destroyed since it was written`
    )
  }
  // A destroy BEFORE the dump is already reflected in it — and it never reaches this map, because
  // `computeDestroyedAfter` is windowed strictly after the generation instant. The empty map IS
  // that case, and it must leave the dump exactly as written.
  assert.equal(run({ countSource: 'inventory', inv, destroyedSinceDump: {} }).net[claw], 3)
  // Floored: destroying more than the file ever saw (a bank window that was shut) reads 0.
  assert.equal(run({ countSource: 'inventory', inv, destroyedSinceDump: { [claw]: 9 } }).net[claw], 0)
})

test('under `both` the discounted dump and the log-derived count still take the MAX', () => {
  // The log witness arrives already net of every destroy (`computeHeldCounts`), so `both` is a max
  // of two independently-discounted witnesses — the monotone shape reconcile.ts argues for.
  const args = { inv: { 'sphinx claw': 3 }, log: { [claw]: 4 }, destroyedSinceDump: { [claw]: 2 } }
  assert.equal(run({ countSource: 'both', ...args }).net[claw], 4, 'the log can still vouch for more')
  assert.equal(run({ countSource: 'log', ...args }).net[claw], 4, '`log` never consults the dump at all')
})

test('a rebaseline is discounted too: dump, plus what dropped since, less what was destroyed since', () => {
  const base = {
    countSource: 'rebaseline' as const,
    inv: { 'sphinx claw': 3 },
    rebaselineAt: T0,
    lootSinceRebaseline: { [claw]: 4 }
  }
  assert.equal(run(base).net[claw], 7, 'three in the file and four dropped since')
  assert.equal(run({ ...base, destroyedSinceDump: { [claw]: 2 } }).net[claw], 5, 'less two destroyed')
  assert.equal(run({ ...base, destroyedSinceDump: { [claw]: 99 } }).net[claw], 0, 'and floored')
})

test('a hand statement is discounted by the destroys made after it, and never below zero', () => {
  const overrides = stated(claw, 3, T0)
  assert.equal(run({ overrides }).net[claw], 3, 'the statement, unchallenged')
  assert.equal(
    run({ overrides, destroyedSinceOverride: { [claw]: 2 } }).net[claw],
    1,
    'you said three and the log then watched two of them go'
  )
  assert.equal(run({ overrides, destroyedSinceOverride: { [claw]: 5 } }).net[claw], 0, 'floored')
  // The forward rules compose: loot after the statement adds, destroys after it subtract, and a
  // turn-in after it eats one more.
  const both = run({
    overrides,
    lootSinceOverride: { [claw]: 4 },
    destroyedSinceOverride: { [claw]: 2 },
    turnIns: { [CLAW_KEY]: 1 },
    turnInInstants: { [CLAW_KEY]: [T0 + HOUR] }
  })
  assert.equal(both.net[claw], 4, '3 stated + 4 looted - 2 destroyed - 1 turned in')
})

test('the statement WINS over every source, including a dump that disagrees', () => {
  const inv = { 'sphinx claw': 5 }
  for (const s of ['log', 'inventory', 'both', 'rebaseline'] as const) {
    assert.equal(
      run({ countSource: s, log: { [claw]: 4 }, inv, overrides: stated(claw, 0) }).net[claw],
      0,
      `${s}: a hand statement sits at the top of the provenance ladder`
    )
  }
})

test('REVERSIBILITY IS DEEP EQUALITY: clearing restores the whole result, byte for byte', () => {
  const base: Partial<ReconcileInput> = {
    log: { [claw]: 4, [diamond]: 2 },
    inv: { 'sphinx claw': 1 },
    turnIns: { [CLAW_KEY]: 1 },
    turnInInstants: { [CLAW_KEY]: [T0 + HOUR] }
  }
  const before = run(base)
  const during = run({ ...base, overrides: stated(claw, 0), lootSinceOverride: { [claw]: 0 } })
  assert.notDeepEqual(during, before, 'the statement did something while it was in force')
  // The take-back is `clearItemOverride`, which leaves the map empty — the exact state the caller
  // then passes back in.
  assert.deepEqual(
    run({ ...base, overrides: itemOverridesByKey(clearItemOverride([{ key: claw, name: claw, count: 0, setAt: T0 }], claw)) }),
    before,
    'nothing about the log-derived record was contaminated'
  )
})

// =============================================================================
// 4. Reconcile: the fourth source
// =============================================================================

test('THE REBASELINE TRACE: the export is the start, and the older log is discarded', () => {
  // The reporter's exact ask: load the export, then only pay attention to log changes going
  // FORWARD. Their log remembers four claws; three of them are spent, destroyed or given away, and
  // the dump they just wrote says one.
  const shared = { log: { [claw]: 4 }, inv: { 'sphinx claw': 1 }, rebaselineAt: T0 }
  assert.equal(run({ ...shared, countSource: 'both' }).net[claw], 4, '`both` believes the log')
  assert.equal(run({ ...shared, countSource: 'rebaseline' }).net[claw], 1, 'the dump is the truth')
  assert.equal(
    run({ ...shared, countSource: 'rebaseline', lootSinceRebaseline: { [claw]: 2 } }).net[claw],
    3,
    'and two farmed since the dump count on top of it'
  )
})

test('with nothing to anchor it, `rebaseline` IS `both` — never a baseline of zero', () => {
  const shared: Partial<ReconcileInput> = {
    log: { [claw]: 4, [diamond]: 1 },
    inv: { 'sphinx claw': 2 },
    turnIns: { [CLAW_KEY]: 1 },
    turnInInstants: { [CLAW_KEY]: [T0] }
  }
  // Every row, every field, the row ORDER and the `net` map — not just the counts.
  assert.deepEqual(
    run({ ...shared, countSource: 'rebaseline', rebaselineAt: null }),
    run({ ...shared, countSource: 'both' }),
    'no dump, or a dump this app could not date: the mode falls back rather than erasing the log'
  )
  assert.equal(rebaselineInstant(undefined), null, 'a store that has never loaded one says so')
  assert.equal(rebaselineInstant({ path: 'x', loadedAt: 'x', readAt: 5 }), 5, 'readAt is the fallback')
  assert.equal(
    rebaselineInstant({ path: 'x', loadedAt: 'x', readAt: 5, generatedAt: 3 }),
    3,
    'but the GENERATION instant wins — it is the moment the file describes'
  )
})

test('a rebaseline owes only the turn-ins recorded since the dump', () => {
  const shared: Partial<ReconcileInput> = {
    countSource: 'rebaseline',
    inv: { 'sphinx claw': 2 },
    rebaselineAt: T0,
    turnIns: { [CLAW_KEY]: 1 }
  }
  assert.equal(
    run({ ...shared, turnInInstants: { [CLAW_KEY]: [T0 - HOUR] } }).net[claw],
    2,
    'the dump was written after that turn-in, so it already has it taken out'
  )
  assert.equal(
    run({ ...shared, turnInInstants: { [CLAW_KEY]: [T0 + HOUR] } }).net[claw],
    1,
    'a turn-in since the dump is a subtraction the file cannot know about'
  )
})

test('every witness stays MONOTONE in your own loot — a count cannot fall when you farm', () => {
  // The property reconcile.ts's discount-then-max argument rests on, re-checked over the fourth
  // source: nothing a player DOES to gather more of an item may lower the number on screen.
  const sources: CountSource[] = ['log', 'inventory', 'both', 'rebaseline']
  for (const countSource of sources) {
    let previous = -1
    for (const since of [0, 1, 2, 5]) {
      const n =
        run({
          countSource,
          log: { [claw]: 3 + since },
          inv: { 'sphinx claw': 2 },
          rebaselineAt: T0,
          lootSinceRebaseline: { [claw]: since },
          turnIns: { [CLAW_KEY]: 1 },
          turnInInstants: { [CLAW_KEY]: [T0 + HOUR] }
        }).net[claw] ?? 0
      assert.ok(n >= previous, `${countSource}: looting one more dropped the count to ${String(n)}`)
      previous = n
    }
  }
})

// =============================================================================
// 5. Additivity — the JOS-186 inputs are an addition, not a rewrite
// =============================================================================

test('passing the new inputs EMPTY is byte-identical to omitting them', () => {
  const base: Partial<ReconcileInput> = {
    log: { [claw]: 3, [diamond]: 1 },
    inv: { 'sphinx claw': 2 },
    turnIns: { [CLAW_KEY]: 2 }
  }
  for (const countSource of ['log', 'inventory', 'both'] as const) {
    assert.deepEqual(
      run({
        ...base,
        countSource,
        overrides: {},
        lootSinceOverride: {},
        turnInInstants: {},
        rebaselineAt: null,
        lootSinceRebaseline: {},
        // JOS-401 joins the same contract: a caller that hands over no destroy windows - an
        // install with no dump to date them against, or a log with no destroy line in it - gets
        // the arithmetic that shipped before, key for key and row order included.
        destroyedSinceDump: {},
        destroyedSinceOverride: {}
      }),
      run({ ...base, countSource }),
      `${countSource}: the three shipped sources are untouched by the machinery around them`
    )
  }
})
