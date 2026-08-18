// ============================================================================
// JOS-294 — the export counts by default, and the flip is a no-op without one.
// ============================================================================
//
// FOUR REPORTS ACROSS THREE RELEASES, ONE ROOT CAUSE. GitHub #27 (Mast73, new install), in-app
// 01KZWDKMXYRERD96CF8AYQFA7P (a deleted log, and their friend), Reddit (ThomasTriesHard, multiple
// PCs) and the original JOS-253 report all end at the same line: the count source defaulted to
// `log`, and `log` reads the `/outputfile inventory` dump for NOTHING (reconcile.ts's `baseCounts`
// and `netCount`). The app went and loaded the file by itself (JOS-253), said how fresh it was
// (JOS-268), and counted not one item out of it. A dump holding every required item read 0/2.
//
// THIS FILE PINS THE THREE CLAIMS THE FIX RESTS ON.
//
//   1. THE DEFAULT IS `both`, and an EXPLICIT stored choice is returned untouched. The flip reaches
//      an absent (or unreadable) key and nothing else, which is exactly the population that has
//      never opened the dropdown — every reporter above.
//
//   2. IT IS A PROVABLE NO-OP FOR AN INSTALL WITH NO DUMP. Not "we think nothing changes": with
//      `inv = {}` the two sources reduce to the SAME arithmetic, so this asserts deep equality of
//      the whole `ReconcileResult` — every row, every field, the row ORDER, and the `net` map the
//      quest counting reads — over a generated space of logs and turn-in counts. The reduction is
//      argued in features/inventory/countSource.ts; the two steps that carry it are `max(l, 0) === l`
//      and `max(0, fromLog) === fromLog`, both of which need only that counts are non-negative, and
//      held counts are a sum of `e.count ?? 1` with nothing anywhere subtracting.
//
//   3. THE TWO ACCEPTANCE TRACES. The fresh-install one (a dump with every required item goes 0/2
//      under `log` and 2/2 under the new default) and the deleted-log one (the log is empty, the
//      dump alone puts the quest on the Ready tab). Both run through the REAL `reconcile` and the
//      REAL `readyQuests`; only `computeQuestProgress`'s per-item clamp is mirrored, the same
//      division tests/questTurnIns.test.mts and tests/skyKeyringHeld.test.mts already make (the
//      bare runner cannot load the React-heavy useProgress module).
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COUNT_SOURCE_OPTIONS,
  DEFAULT_COUNT_SOURCE,
  countSourcePhrase,
  countsFromInventory,
  resolveCountSource
} from '../src/renderer/src/features/inventory/countSource'
import { reconcile } from '../src/renderer/src/features/inventory/reconcile'
import { readyQuests } from '../src/renderer/src/features/posky/questCompletion'
import type { QuestProgress } from '../src/renderer/src/features/posky/useProgress'
import { questKey } from '../src/renderer/src/features/posky/keys'
import { itemCountKey } from '../src/renderer/src/lib/itemName'
import type { CountSource, PoskyQuest } from '../src/shared/types'

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

/** Instants far enough apart that "before" and "after" are never a rounding question. */
const T0 = 1_700_000_000_000
const HOUR = 3_600_000

// =============================================================================
// 1. The default, and what it leaves alone
// =============================================================================

test('an install that has never chosen a count source counts the export', () => {
  assert.equal(DEFAULT_COUNT_SOURCE, 'both')
  assert.equal(resolveCountSource(null), 'both', 'absent key = the new default')
  assert.equal(resolveCountSource(''), 'both', 'unreadable = stated nothing')
  assert.equal(resolveCountSource('inventory-ish'), 'both', 'junk = stated nothing')
})

test('an EXPLICIT choice is returned verbatim — the flip reaches only an absent key', () => {
  for (const s of ['log', 'inventory', 'both', 'rebaseline'] as const) {
    assert.equal(resolveCountSource(s), s, `a stored ${s} survives the default change`)
  }
})

test('every source is offered, labelled, and says which witness it ignores', () => {
  assert.deepEqual(
    COUNT_SOURCE_OPTIONS.map((o) => o.value),
    // The first three are the order a player WIDENS (one witness, the other, both); `rebaseline`
    // (JOS-186) is last because it is the only one that throws evidence away rather than adding a
    // witness, and it is the only one that can make a count go down.
    ['log', 'inventory', 'both', 'rebaseline'],
    'the dropdown offers all four'
  )
  // SCOPE D, as a property rather than as three frozen strings: the two labels this ticket fixed
  // described JOS-128's reset semantics ("Export, plus loot since" / "Export if any, else log"),
  // which JOS-141 reverted. `inventory` is the dump EXACTLY and `both` is a per-item maximum, so
  // neither may claim the other's witness as an addition or a fallback.
  const inventory = COUNT_SOURCE_OPTIONS.find((o) => o.value === 'inventory')
  assert.ok(inventory)
  assert.match(inventory.label, /only/i, 'the export source counts the export and nothing else')
  assert.doesNotMatch(
    `${inventory.label} ${inventory.phrase}`,
    /plus loot|since|then the log|else/i,
    'reverted JOS-128 wording: `inventory` never consults the log (reconcile.ts:115,222)'
  )
  const both = COUNT_SOURCE_OPTIONS.find((o) => o.value === 'both')
  assert.ok(both)
  assert.doesNotMatch(
    `${both.label} ${both.phrase}`,
    /if any|else|fall(s)? back/i,
    '`both` is max(log, dump) per item, never a fallback to one of them'
  )
  // The counting-from line and the dropdown cannot drift: one table feeds both surfaces.
  for (const o of COUNT_SOURCE_OPTIONS) assert.equal(countSourcePhrase(o.value), o.phrase)
})

test('the caption gate is the source, not the file: only `log` ignores the dump', () => {
  assert.equal(countsFromInventory('log'), false)
  assert.equal(countsFromInventory('inventory'), true)
  assert.equal(countsFromInventory('both'), true)
  // JOS-186: `rebaseline` is the most dump-dependent source of the four — the file IS its baseline
  // — so the freshness line has to be on for it. A gate written as `=== 'inventory' || === 'both'`
  // would have silently excluded it.
  assert.equal(countsFromInventory('rebaseline'), true)
})

// =============================================================================
// 2. THE NO-OP PROOF: with no dump, `both` IS `log`
// =============================================================================

/** The whole reconcile input, minus the source — so the two runs differ in exactly one field. */
function run(
  log: Record<string, number>,
  inv: Record<string, number>,
  turnIns: Record<string, number>,
  countSource: CountSource
): ReturnType<typeof reconcile> {
  return reconcile({
    log,
    inv,
    lootNames: { 'sphinx claw': 'Sphinx Claw' },
    countSource,
    turnIns,
    quests: QUESTS
  })
}

test('WITHOUT A DUMP, `both` reduces to `log` byte-identically — rows, order and net', () => {
  const claw = itemCountKey('Sphinx Claw')
  const diamond = itemCountKey('Ivory Sky Diamond')
  const other = itemCountKey('Rune of Al`Kabor')
  // The generated space covers every shape the reduction has to survive: nothing looted, a partial
  // hold, exactly enough, a surplus, an item no quest wants, and turn-ins that eat more than the
  // log ever saw (the `Math.max(0, …)` clamp — the only place a negative could appear). Built as a
  // flat product rather than as four nested loops, which the repo's `max-depth 3` measures.
  const space: { log: Record<string, number>; turnIns: Record<string, number> }[] = []
  for (const c of [0, 1, 2, 5]) {
    for (const d of [0, 1, 3]) {
      for (const [o, times] of [[0, 0], [0, 1], [4, 2], [4, 7]] as const) {
        space.push({
          log: { ...(c ? { [claw]: c } : {}), ...(d ? { [diamond]: d } : {}), ...(o ? { [other]: o } : {}) },
          turnIns: times ? { [CLAW_KEY]: times } : {}
        })
      }
    }
  }
  for (const s of space) {
    assert.deepEqual(
      run(s.log, {}, s.turnIns, 'both'),
      run(s.log, {}, s.turnIns, 'log'),
      `log=${JSON.stringify(s.log)} turnIns=${JSON.stringify(s.turnIns)}`
    )
  }
  assert.equal(space.length, 48, 'the space actually ran')
})

test('…and it still reduces with the DUMP WINDOWS switched on (JOS-401/JOS-403)', () => {
  // The reduction has to survive the two discounts the dump witness owes, because they are computed
  // under `both` (which reads the file) and skipped under `log` (which does not) — so the two
  // sources now take genuinely different paths through `reconcile` for an install with no dump.
  // They still land on the same answer, and for the same reason as before: with `inv = {}` the dump
  // witness is 0, so `max(0, 0 - destroyed - consumed)` is 0 and `max(0, fromLog)` is `fromLog`.
  const claw = itemCountKey('Sphinx Claw')
  const windows = {
    turnInInstants: { [CLAW_KEY]: [T0 - HOUR, T0 + HOUR] },
    rebaselineAt: T0,
    destroyedSinceDump: { [claw]: 2 }
  }
  for (const turnIns of [{}, { [CLAW_KEY]: 1 }, { [CLAW_KEY]: 2 }]) {
    const input = { log: { [claw]: 4 }, inv: {}, lootNames: {}, turnIns, quests: QUESTS, ...windows }
    assert.deepEqual(
      reconcile({ ...input, countSource: 'both' }),
      reconcile({ ...input, countSource: 'log' }),
      `turnIns=${JSON.stringify(turnIns)}: no dump, no discount, no difference`
    )
  }
})

test('…and the reduction is the count source ALONE: one dumped item and they diverge', () => {
  const claw = itemCountKey('Sphinx Claw')
  const log = { [claw]: 1 }
  assert.deepEqual(run(log, {}, {}, 'both'), run(log, {}, {}, 'log'), 'empty dump: identical')
  assert.notDeepEqual(
    run(log, { 'ivory sky diamond': 1 }, {}, 'both'),
    run(log, { 'ivory sky diamond': 1 }, {}, 'log'),
    'a single dumped item is the whole difference the default change buys'
  )
})

// =============================================================================
// 3. The two acceptance traces
// =============================================================================

/**
 * Mirror of `computeQuestProgress`'s per-item clamp (`have = min(need, net[countKey])`) plus the
 * two fields the Ready rule reads. Kept off the React-heavy useProgress module the bare runner
 * cannot load — the same division tests/questTurnIns.test.mts makes. `reconcile` and `readyQuests`
 * are the REAL ones.
 */
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

/** THE DUMP the reports describe: it holds every item the quest asks for. */
const DUMP = { 'sphinx claw': 1, 'ivory sky diamond': 1 }

test('THE FRESH-INSTALL TRACE: a dump holding every required item goes 0/2 → 2/2', () => {
  // The reporter's machine: a brand new install, so no loot has been folded from the log yet, and
  // the one thing they DID do was type `/outputfile inventory`.
  const underLog = progressOf(run({}, DUMP, {}, 'log').net)
  assert.equal(underLog.haveCount, 0)
  assert.equal(underLog.needCount, 2, '0/2 — every item is in the file and none of them counts')

  const underDefault = progressOf(run({}, DUMP, {}, DEFAULT_COUNT_SOURCE).net)
  assert.equal(underDefault.haveCount, 2)
  assert.equal(underDefault.needCount, 2, '2/2 — the same file, under the source they never chose')
  assert.deepEqual(underDefault.missing, [])
})

test('THE DELETED-LOG TRACE: the Ready tab populates from a dump alone', () => {
  // `LootModule` is an in-memory replay of the log file, so a deleted (or brand new, or
  // another-PC) log means ZERO held items from the log — permanently, because the lines are gone.
  const noLog = {}
  assert.deepEqual(
    readyQuests([progressOf(run(noLog, DUMP, {}, 'log').net)]),
    [],
    'under `log` the tab is empty while the player holds every item — the report, exactly'
  )
  assert.deepEqual(
    readyQuests([progressOf(run(noLog, DUMP, {}, DEFAULT_COUNT_SOURCE).net)]).map((q) => q.name),
    ['Test of Claw'],
    'under the default the dump alone is enough to hand it in'
  )
})

test('…and the dump still never SUBTRACTS: a turn-in cannot push the log witness below zero', () => {
  // JOS-141's rule, re-checked under the new default because the default is what makes `both` the
  // live path for everybody: each witness is discounted on its own terms and then maxed, so a
  // dump-answered row survives a turn-in that ate more than the log ever saw.
  const net = run({ 'sphinx claw': 1 }, DUMP, { [CLAW_KEY]: 3 }, 'both').net
  assert.equal(net[itemCountKey('Sphinx Claw')], 1, 'the dump floor holds the row up')
  assert.ok((net[itemCountKey('Ivory Sky Diamond')] ?? 0) >= 0)
})
