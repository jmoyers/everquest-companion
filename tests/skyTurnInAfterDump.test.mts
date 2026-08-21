// ============================================================================
// JOS-403 — the dump owes the turn-ins made AFTER it, and only those.
// ============================================================================
//
// The report (v1.4.0, feedback 01M081TPHPGB173YCC4YH7AMZB): "items I turned in are not deleted from
// the tracker even though they are gone from my inventory", and — the same bug seen from the other
// tab — "when I do the cleanup and delete the extra items with destroy, it is still showing them".
// Its own attachments give the whole trace, and it is reproduced below as arithmetic: a dump at
// 10:15:47 listing three Efreeti War Bows and seven Wind Rune Heda, a Ranger turn-in at 10:17:56
// eating one of each, two destroys at 10:19:2x. Truth is 0 bows and 6 runes; the app read 1 bow and
// 7 runes, because JOS-401's destroy discount came off the dump witness and the turn-in did not.
//
// WHY IT IS ITS OWN FILE rather than a sixth section of tests/skyItemOverrides.test.mts, where the
// other two windowed discounts are pinned: that file is at the measured `max-lines` ceiling, and
// this is one subject with a report behind it. The rule it pins is the same shape as its
// neighbours' — a witness owes what the log recorded after the witness spoke — applied to the pair
// (dump, turn-in) that JOS-141 left out.
//
// WHAT THIS PINS:
//
//   1. THE REPORT, AS ARITHMETIC. Dump 3, one turned in after it, two destroyed after it → 0, under
//      `both` (the default) and `inventory` alike; seven runes less one post-dump turn-in → 6.
//   2. THE ROW STAYS HONEST. `net === base - consumed`, the destroy discount in the base and the
//      turn-in in the net, and `consumedBy` naming the quest — including on a DUMP-ONLY row, which
//      is the row the reporter was looking at.
//   3. THE HALF JOS-141 GOT RIGHT IS UNTOUCHED. A turn-in recorded BEFORE the dump is never
//      subtracted, and neither is an undated one against an undatable dump.
//   4. THE REFARM AND MONOTONICITY. Looting one more raises the count by exactly one, and no source
//      can be made to fall when the player farms.
//
// The Cleanup tab's half of the same report is pinned next door, in tests/skyCleanup.test.mts —
// that tab's only holdings input is `ItemProgress.held`, which IS the `net` computed here.
//
// READ tests/skyCurrencyRuneWitness.test.mts BESIDE THIS FILE (JOS-409). The window pinned here was
// only HALF a window: the dump witness paid the post-dump turn-ins and destroys and earned nothing
// in the same period, which under-counts whenever the two witnesses are not looking at the same
// physical copies — the Plane of Sky currency rune, by construction. `both`'s dump reading is now
// `max(0, D + looted_after - destroyed_after - turnedIn_after)`, and every case below still holds
// unchanged because none of them loots anything after the dump (`lootSinceRebaseline` is absent
// throughout, which IS that state). The bow case in particular is a JOS-409 golden and is re-pinned
// there. `inventory` is untouched by that ticket and stays literal.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcile, type ReconcileInput } from '../src/renderer/src/features/inventory/reconcile'
import { questKey } from '../src/renderer/src/features/posky/keys'
import { itemCountKey } from '../src/renderer/src/lib/itemName'
import type { ItemCountOverride, PoskyQuest } from '../src/shared/types'

// A SYNTHETIC quest with the reporter's item names, for the reason tests/questTurnIns.test.mts
// states: the claim is arithmetic over required counts, and a re-scrape of posky.json must not be
// able to move it under the assertion.
const RANGER: PoskyQuest = {
  className: 'Ranger',
  name: 'Test of Ranged Attack',
  giver: 'Ranger Spirit',
  items: [
    { name: 'Shimmering Pearl', count: 1, who: [], where: 'Island 3' },
    { name: 'Efreeti War Bow', count: 1, who: [], where: 'Island 4' },
    { name: 'Wind Rune Heda', count: 1, who: [], where: 'Island 2' }
  ]
}
const RANGER_KEY = questKey(RANGER)
const bow = itemCountKey('Efreeti War Bow')
const heda = itemCountKey('Wind Rune Heda')
const pearl = itemCountKey('Shimmering Pearl')

/** Instants far enough apart that "before" and "after" are never a rounding question. */
const DUMP_AT = 1_700_000_000_000
const MINUTE = 60_000
const HOUR = 3_600_000

/** The whole reconcile input with everything defaulted, so a case states only what it varies. */
function run(over: Partial<ReconcileInput> = {}): ReturnType<typeof reconcile> {
  return reconcile({
    log: {},
    inv: {},
    lootNames: {},
    countSource: 'both',
    turnIns: {},
    quests: [RANGER],
    ...over
  })
}

/** A statement of `count`, made at `setAt` — the one witness that outranks every source. */
const stated = (key: string, count: number, setAt: number): Record<string, ItemCountOverride> => ({
  [key]: { key, name: key, count, setAt }
})

/**
 * The reporter's state, as reconcile inputs. `log` arrives NET of the destroys
 * (`computeHeldCounts` folds them — three bows looted less two destroyed is one),
 * `destroyedSinceDump` is the separate window the dump witness owes (JOS-401), and the turn-in is a
 * single instant two minutes after the dump was generated.
 */
const REPORT: Partial<ReconcileInput> = {
  log: { [bow]: 1, [heda]: 7 },
  inv: { 'efreeti war bow': 2, 'efreeti war bow +1': 1, 'wind rune heda': 7 },
  destroyedSinceDump: { [bow]: 2 },
  rebaselineAt: DUMP_AT,
  turnIns: { [RANGER_KEY]: 1 },
  turnInInstants: { [RANGER_KEY]: [DUMP_AT + 2 * MINUTE] }
}

test('THE REPORT: dump 3, one turned in after it, two destroyed after it — the bow reads 0', () => {
  for (const countSource of ['both', 'inventory'] as const) {
    const res = run({ ...REPORT, countSource })
    assert.equal(res.net[bow], 0, `${countSource}: 3 dumped - 2 destroyed - 1 turned in`)
    // The `+1` variant pools into the same counting key, which is why the dump reads three and not
    // two — the reporter's file had two base bows in General 5 and one +1 in Bank 14.
    assert.equal(res.rows.find((r) => r.key === bow)?.inv, 3, 'the +1 pools with the base name')
    assert.equal(res.net[heda], 6, `${countSource}: seven dumped, one handed in since`)
  }
})

test('…and the row stays arithmetically honest: net === base - consumed, and the quest is named', () => {
  const row = run({ ...REPORT, countSource: 'both' }).rows.find((r) => r.key === bow)
  assert.ok(row)
  // The destroy comes off the BASE (the witness owes it — the number the file printed was already
  // wrong); the turn-in comes off the NET, so `consumed` is still the ledger's own answer.
  assert.deepEqual([row.base, row.consumed, row.net], [1, 1, 0])
  assert.deepEqual(row.consumedBy, ['Test of Ranged Attack'], 'the quest that ate the copy')
  // The pearl is a DUMP-ONLY row — the log has never seen one drop — and it is exactly the row the
  // reporter was looking at, so the blame has to work there too.
  const p = run({ ...REPORT, countSource: 'inventory', inv: { 'shimmering pearl': 1 } }).rows.find(
    (r) => r.key === pearl
  )
  assert.ok(p)
  assert.deepEqual([p.log, p.base, p.consumed, p.net], [0, 1, 1, 0])
  assert.deepEqual(p.consumedBy, ['Test of Ranged Attack'])
})

test('a turn-in BEFORE the dump is still never subtracted (JOS-141 is untouched)', () => {
  // The whole reason JOS-141 threw the window away: the file was written after that turn-in, so the
  // copies it ate are already missing from it. Subtracting again deletes the copy you refarmed.
  const before = run({
    ...REPORT,
    countSource: 'both',
    turnInInstants: { [RANGER_KEY]: [DUMP_AT - HOUR] }
  })
  assert.equal(before.net[bow], 1, 'the dump, less the two destroys, and nothing else')
  assert.equal(before.net[heda], 7, 'seven in the file and no post-dump turn-in to owe')
  assert.deepEqual(
    before.rows.find((r) => r.key === heda)?.consumedBy,
    [],
    'nothing was taken off the row, so nothing is blamed for it'
  )
})

test('an UNDATABLE dump discounts nothing — never a guessed instant', () => {
  // The same degradation the destroy window already makes: no instant is not a window. A dump this
  // app cannot date is exactly the state every install was in before JOS-186.
  const undated = run({ ...REPORT, countSource: 'both', rebaselineAt: null })
  assert.equal(undated.net[heda], 7, 'the file as written; the turn-in could have predated it')
  assert.equal(
    run({ ...REPORT, countSource: 'both', turnInInstants: {} }).net[heda],
    7,
    'and an UNDATED turn-in contributes to no window either — it predates any statement made now'
  )
})

test('ONE quest run twice, once before the dump and once after, owes the dump exactly one', () => {
  const twice = run({
    ...REPORT,
    countSource: 'inventory',
    turnIns: { [RANGER_KEY]: 2 },
    turnInInstants: { [RANGER_KEY]: [DUMP_AT - HOUR, DUMP_AT + 2 * MINUTE] }
  })
  assert.equal(twice.net[heda], 6, 'seven dumped, and only the post-dump run is the file`s problem')
  assert.deepEqual(
    twice.rows.find((r) => r.key === heda)?.consumedBy,
    ['Test of Ranged Attack'],
    'the caption counts the runs THIS row paid for — the all-time pass would have said x2'
  )
})

test('THE REFARM: one more looted after the turn-in raises the count by exactly one', () => {
  // The Sky refarm story, over the new subtraction: hand it in, go kill the mob again, and the
  // number moves up by one rather than staying stuck or double-counting.
  const held = (looted: number): number =>
    run({ ...REPORT, countSource: 'both', log: { [bow]: 1, [heda]: 7 + looted } }).net[heda] ?? 0
  assert.deepEqual([held(0), held(1), held(2)], [6, 7, 8])
})

test('the new window keeps every witness MONOTONE in your own loot', () => {
  // The property the whole discount-then-max argument rests on, re-checked with the turn-in window
  // switched on for the dump witness: a post-dump turn-in is a constant in the player's farming.
  for (const countSource of ['log', 'inventory', 'both', 'rebaseline'] as const) {
    let previous = -1
    for (const looted of [0, 1, 2, 5]) {
      const n =
        run({
          ...REPORT,
          countSource,
          log: { [bow]: 1, [heda]: 7 + looted },
          lootSinceRebaseline: { [heda]: looted }
        }).net[heda] ?? 0
      assert.ok(n >= previous, `${countSource}: looting one more dropped the count to ${String(n)}`)
      previous = n
    }
  }
})

test('the discount reaches ONLY the dump-reading sources', () => {
  // `log` consults the file for nothing at all, so the post-dump window must not touch it: its
  // count is the all-time one it always was (one bow left after the destroys, less the turn-in).
  assert.equal(run({ ...REPORT, countSource: 'log' }).net[bow], 0)
  assert.equal(run({ ...REPORT, countSource: 'log' }).net[heda], 6, 'log - consumed, all time')
  // A hand statement still wins over the lot, window and all (the provenance ladder).
  assert.equal(
    run({ ...REPORT, countSource: 'both', overrides: stated(bow, 4, DUMP_AT + HOUR) }).net[bow],
    4,
    'the user is the only witness that is a person'
  )
})
