// ============================================================================
// JOS-409 — a witness that PAYS in a window must EARN in the same window.
// ============================================================================
//
// THE REPORTS (three, all v1.5.0): Plane of Sky rune counts read ZERO while the player was holding
// the runes. "I have every rune possible but shows 0" (01M0ATTCXBX3PB8NRSHM8E4EMY, with a log
// slice). "I've tried all the different choices of count items from dropdown. I tried re-exporting
// my inventory file. It doesn't work" (01M0CVBWRBXZ3DVDY7CMXQ7SXE). And the one that named the
// mechanism: "all my runes are in currency storage and aren't being reported during an inventory
// dump" (01M0DADXKXPN5KJWFSAZNQ3VAA).
//
// THE MECHANISM is a partial JOS-403 regression, and neither witness was wrong on its own:
//
//   the log witness   pays ALL-TIME consumption           max(0, log - consumed)
//   the dump witness  pays POST-DUMP consumption only     max(0, dump - destroyed - turnedIn since)
//   `both`            max of the two
//
// One physical turn-in is charged against BOTH of them. That is harmless while they are looking at
// the same physical copies — the max papers over it — and it under-counts exactly when they are
// not. A Wind Rune is the case where they never are: it is looted into the CURRENCY TAB, and
// `/outputfile inventory` never lists currency-tab items (shared/outputs/kinds.ts states the game
// fact as the last of the command's steps). So the dump's reading of a rune is permanently 0, the
// log is the only witness there is, and its single loot is eaten by consumption the dump was also
// charged for. The player holds the rune; the app says 0; re-exporting cannot help, which is
// precisely what the second reporter found.
//
// WHY THE INPUT HERE IS THE COMMITTED W14 FIXTURE AND NOT THE REPORTER'S SLICE. The repo's law is
// that a reporter's slice never becomes a fixture, and the injection carve-out beside it is for a
// sentence the OWNER'S log has never printed. This is not that case: `tests/fixtures/
// w14-sky-currency-loot.log` already carries six real currency-rune loots in exactly the shape the
// slice shows (four distinct runes at one apiece, plus a Heda twice), extracted through the shared
// scrub from the owner's own log. So the acceptance trace is built on committed bytes, replayed
// through the REAL parser, the REAL LootModule and the REAL held-count folds, and no slice content
// enters the repo at all.
//
// WHAT THIS PINS:
//
//   1. THE ACCEPTANCE TRACE. Six real currency-rune loots, a dump written BEFORE them, and one
//      prior turn-in per rune quest. v1.5.0's arithmetic reads 0 for every rune; the fixed
//      arithmetic reads what was actually looted.
//   2. THE ARITHMETIC, stated over a synthetic quest so a posky re-scrape cannot move it.
//   3. PART 2 — only log-DETECTED instants window the dump. A hand-recorded turn-in is stamped at
//      the CLICK, so it may not be compared against a file's generation stamp.
//   4. THE GOLDENS THE FIX MAY NOT MOVE. The JOS-403 bow case stays 0, every source stays monotone
//      in the player's own loot, JOS-141's banked-item ruling is intact, and `inventory` stays
//      literal ("as dumped", which is what its own label promises).
//   5. PART 3 — the caveat copy, and the predicate that decides which rows carry it.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { LootModule } from '../src/main/modules/loot'
import { reconcile, type ReconcileInput } from '../src/renderer/src/features/inventory/reconcile'
import {
  computeHeldCounts,
  computeHeldCountsAfter
} from '../src/renderer/src/features/posky/heldCounts'
import { questKey } from '../src/renderer/src/features/posky/keys'
import {
  DUMP_BLIND_ITEM_NOTE,
  DUMP_BLIND_READY_NOTE,
  isDumpBlindItem
} from '../src/renderer/src/features/posky/dumpBlindItems'
import { itemCountKey } from '../src/renderer/src/lib/itemName'
import poskyRaw from '../src/renderer/src/data/eqlegends/posky.json' with { type: 'json' }
import type { LootEvent, PoskyQuest } from '../src/shared/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const QUESTS = (poskyRaw as { quests: PoskyQuest[] }).quests

/** Replay raw lines through the real parser + LootModule; return the loot snapshot rows. */
function replayLoot(name: string): LootEvent[] {
  const lines = readFileSync(join(HERE, 'fixtures', name), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
  const mod = new LootModule()
  mod.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  return mod.snapshot().state
}

// =============================================================================
// 1. The acceptance trace, over the committed currency window
// =============================================================================

/** The runes the W14 window loots, and how many of each. Hand-read from the fixture. */
const LOOTED_RUNES: Record<string, number> = {
  'Wind Rune Caza': 1,
  'Wind Rune Neza': 1,
  'Wind Rune Dena': 1,
  'Wind Rune Jaka': 1,
  'Wind Rune Heda': 2
}

/** ONE quest per rune — the first in the data that requires it. A rune quest run once ate one
 *  rune, which is the reporters' state: they had handed the class Test in before and refarmed. */
function questFor(rune: string): PoskyQuest {
  const q = QUESTS.find((x) => x.items.some((i) => itemCountKey(i.name) === itemCountKey(rune)))
  assert.ok(q, `${rune} is a known Plane of Sky quest item`)
  return q
}

test('THE ACCEPTANCE TRACE: four currency runes looted after a dump, one prior turn-in each', () => {
  const rows = replayLoot('w14-sky-currency-loot.log')
  const log = computeHeldCounts(rows)
  // The dump was written BEFORE the window — the reporters' shape exactly: play, dump, hand in,
  // farm again. One second before the first rune line is enough; the fold is strictly-after.
  const first = Math.min(...rows.map((r) => r.ts))
  const DUMP_AT = first - 1000
  const lootSinceRebaseline = computeHeldCountsAfter(rows, DUMP_AT)

  const runeQuests = Object.keys(LOOTED_RUNES).map(questFor)
  const turnIns: Record<string, number> = {}
  const instants: Record<string, number[]> = {}
  for (const q of runeQuests) {
    // The prior run, an hour before the dump. The game took the rune out of the file itself, so
    // this turn-in is the file's business and never the log-forward window's.
    turnIns[questKey(q)] = 1
    instants[questKey(q)] = [DUMP_AT - 3_600_000]
  }

  const shared: ReconcileInput = {
    log,
    // A rune is NEVER in the dump. That is the whole reason the log is the only witness here, and
    // it is a game fact rather than a test convenience (shared/outputs/kinds.ts).
    inv: {},
    lootNames: {},
    countSource: 'both',
    turnIns,
    turnInInstants: instants,
    detectedTurnInInstants: instants,
    quests: QUESTS,
    rebaselineAt: DUMP_AT
  }

  // v1.5.0, as shipped: the dump witness paid the post-dump window and earned nothing in it. With
  // the loot credit withheld the reports reproduce exactly — every rune reads 0.
  const shipped = reconcile(shared)
  // …and the fix is that one input.
  const fixed = reconcile({ ...shared, lootSinceRebaseline })

  for (const [rune, count] of Object.entries(LOOTED_RUNES)) {
    const k = itemCountKey(rune)
    assert.equal(log[k], count, `${rune}: the log saw ${String(count)} drop`)
    // v1.5.0: the only witness left is the log, and it pays the prior turn-in all over again — so
    // the count is short by exactly ONE per prior run. The four runes looted once each read 0,
    // which is the reporters' "shows 0"; Heda, looted twice in this window, reads 1 of its 2.
    assert.equal(
      shipped.net[k],
      count - 1,
      `${rune}: v1.5.0 charged the pre-dump turn-in to the only witness that could see the refarm`
    )
    assert.equal(fixed.net[k], count, `${rune}: the dump earns in the window it pays in`)
  }
  // Said once more without the arithmetic, because THIS is the sentence in the reports: every rune
  // the player looted once since handing its quest in read zero.
  const once = Object.keys(LOOTED_RUNES).filter((r) => LOOTED_RUNES[r] === 1)
  assert.equal(once.length, 4, 'four currency runes looted once apiece')
  for (const rune of once) {
    assert.equal(shipped.net[itemCountKey(rune)], 0, `${rune} showed 0`)
    assert.equal(fixed.net[itemCountKey(rune)], 1, `${rune} now counts`)
  }
})

test('…and the same trace under `rebaseline` and `log`, which were never the broken pair', () => {
  const rows = replayLoot('w14-sky-currency-loot.log')
  const DUMP_AT = Math.min(...rows.map((r) => r.ts)) - 1000
  const caza = itemCountKey('Wind Rune Caza')
  const quest = questFor('Wind Rune Caza')
  const instants = { [questKey(quest)]: [DUMP_AT - 3_600_000] }
  const shared: ReconcileInput = {
    log: computeHeldCounts(rows),
    inv: {},
    lootNames: {},
    countSource: 'rebaseline',
    turnIns: { [questKey(quest)]: 1 },
    turnInInstants: instants,
    detectedTurnInInstants: instants,
    quests: QUESTS,
    rebaselineAt: DUMP_AT,
    lootSinceRebaseline: computeHeldCountsAfter(rows, DUMP_AT)
  }
  // `rebaseline` already read the rune correctly — it has had this arithmetic since JOS-186, which
  // is what made the fix a one-term change rather than a new rule.
  assert.equal(reconcile(shared).net[caza], 1, 'the fourth source was never wrong here')
  // `log` still owes the all-time turn-in, and that is CORRECT for a witness with no window: it
  // cannot tell the refarmed copy from the one it watched get handed over. This is why `both`
  // maxing a properly-windowed dump witness against it is the fix and not a patch on the log side.
  assert.equal(reconcile({ ...shared, countSource: 'log' }).net[caza], 0)
})

// =============================================================================
// 2. The arithmetic, over a synthetic quest
// =============================================================================

const RUNE_TEST: PoskyQuest = {
  className: 'Bard',
  name: 'Test of Pitch (synthetic)',
  giver: 'Bard Spirit',
  items: [
    { name: 'Wind Rune Caza', count: 1, who: [], where: 'Plane of Sky' },
    { name: 'Sphinx Claw', count: 2, who: [], where: 'Island 3' }
  ]
}
const TEST_KEY = questKey(RUNE_TEST)
const claw = itemCountKey('Sphinx Claw')

const DUMP_AT = 1_700_000_000_000
const HOUR = 3_600_000

function run(over: Partial<ReconcileInput> = {}): ReturnType<typeof reconcile> {
  return reconcile({
    log: {},
    inv: {},
    lootNames: {},
    countSource: 'both',
    turnIns: {},
    quests: [RUNE_TEST],
    ...over
  })
}

test('THE RULE: under `both` the dump earns the post-dump loot before paying the post-dump bill', () => {
  // dump 5 claws, 3 looted since, 1 destroyed since, one quest run since (which eats 2). The log
  // has only ever seen 4 of them — two of the dumped five were banked before this log begins — so
  // the DUMP witness wins both maxima and the row reports its arithmetic rather than the log's.
  const res = run({
    countSource: 'both',
    log: { [claw]: 4 },
    inv: { 'sphinx claw': 5 },
    rebaselineAt: DUMP_AT,
    lootSinceRebaseline: { [claw]: 3 },
    destroyedSinceDump: { [claw]: 1 },
    turnIns: { [TEST_KEY]: 1 },
    turnInInstants: { [TEST_KEY]: [DUMP_AT + HOUR] }
  })
  const row = res.rows.find((r) => r.key === claw)
  assert.ok(row)
  // base = 5 + 3 - 1 = 7 (the destroy is the WITNESS's debt, so it sits in the base);
  // net  = 7 - 2 = 5 (the turn-in is the LEDGER's, so it sits in `consumed` and names the quest).
  assert.deepEqual([row.base, row.consumed, row.net], [7, 2, 5])
  assert.deepEqual(row.consumedBy, ['Test of Pitch (synthetic)'])
  // Withhold the credit and the same state reads 4: the dump falls to 5 - 1 - 2 = 2, the log's
  // 4 - 2 = 2 wins the max at 2 for the net, and three claws the player is holding are gone.
  assert.equal(
    run({
      countSource: 'both',
      log: { [claw]: 4 },
      inv: { 'sphinx claw': 5 },
      rebaselineAt: DUMP_AT,
      destroyedSinceDump: { [claw]: 1 },
      turnIns: { [TEST_KEY]: 1 },
      turnInInstants: { [TEST_KEY]: [DUMP_AT + HOUR] }
    }).net[claw],
    2
  )
})

test('`inventory` stays literal: "as dumped" earns nothing, which is what its label promises', () => {
  const args = {
    inv: { 'sphinx claw': 5 },
    rebaselineAt: DUMP_AT,
    lootSinceRebaseline: { [claw]: 3 }
  }
  assert.equal(run({ ...args, countSource: 'inventory' }).net[claw], 5, 'the file, as written')
  assert.equal(run({ ...args, countSource: 'both' }).net[claw], 8, 'and the file plus what came after')
})

test('an UNDATABLE dump credits nothing either — no instant is not a window', () => {
  assert.equal(
    run({
      countSource: 'both',
      inv: { 'sphinx claw': 5 },
      rebaselineAt: null,
      lootSinceRebaseline: { [claw]: 3 }
    }).net[claw],
    5,
    'the same degradation the two discounts make, and for the same reason'
  )
})

// =============================================================================
// 3. Part 2 — only log-DETECTED instants may window the dump
// =============================================================================

test('A HAND-RECORDED TURN-IN NEVER DISCOUNTS THE DUMP: its instant is a CLICK, not an event', () => {
  // The player handed the quest in on Tuesday, dumped on Wednesday, and used the hand counter on
  // Friday. The ledger's only record of Tuesday is a Friday stamp, so windowing it against the dump
  // subtracts a turn-in the file already reflects — JOS-141's double-subtraction, arriving through
  // the door JOS-403 opened.
  const late = { [TEST_KEY]: [DUMP_AT + HOUR] }
  const shared: Partial<ReconcileInput> = {
    countSource: 'both',
    inv: { 'wind rune caza': 1, 'sphinx claw': 4 },
    rebaselineAt: DUMP_AT,
    turnIns: { [TEST_KEY]: 1 },
    turnInInstants: late
  }
  assert.equal(
    run({ ...shared, detectedTurnInInstants: {} }).net[claw],
    4,
    'nothing the LOG saw happened after the dump, so the dump owes nothing'
  )
  assert.equal(
    run({ ...shared, detectedTurnInInstants: late }).net[claw],
    2,
    'the same instant, off a line the game printed, still discounts it (JOS-403 intact)'
  )
  // Absent = "no provenance stated" = the pre-JOS-409 contract, so an untaught caller is unchanged.
  assert.equal(run(shared).net[claw], 2, 'omitting the field reads exactly as it always did')
})

test('the provenance gate reaches `rebaseline` too — same instant, same argument', () => {
  const late = { [TEST_KEY]: [DUMP_AT + HOUR] }
  const shared: Partial<ReconcileInput> = {
    countSource: 'rebaseline',
    inv: { 'sphinx claw': 4 },
    rebaselineAt: DUMP_AT,
    turnIns: { [TEST_KEY]: 1 },
    turnInInstants: late
  }
  assert.equal(run({ ...shared, detectedTurnInInstants: {} }).net[claw], 4)
  assert.equal(run({ ...shared, detectedTurnInInstants: late }).net[claw], 2)
})

test('a hand STATEMENT still windows against the whole ledger — two click times compare fine', () => {
  // The provenance split is about comparing a click time against a FILE's generation stamp. A hand
  // statement's `setAt` is a click time as well, so the ordering between two clicks is real and the
  // per-statement window keeps reading every instant.
  const res = run({
    countSource: 'both',
    overrides: { [claw]: { key: claw, name: 'Sphinx Claw', count: 3, setAt: DUMP_AT } },
    turnIns: { [TEST_KEY]: 1 },
    turnInInstants: { [TEST_KEY]: [DUMP_AT + HOUR] },
    detectedTurnInInstants: {}
  })
  assert.equal(res.net[claw], 1, 'you said three, and then recorded a hand-in that ate two')
})

// =============================================================================
// 4. The goldens the fix may not move
// =============================================================================

test('JOS-403 IS INTACT: the bow the dump saw and the player handed in still reads 0', () => {
  // The v1.4.0 report, unchanged: dump 3, one turned in after it, two destroyed after it. Nothing
  // was looted after that dump, so JOS-409's credit is 0 and the whole expression is untouched.
  const bowQuest: PoskyQuest = {
    className: 'Ranger',
    name: 'Test of Ranged Attack (synthetic)',
    giver: 'Ranger Spirit',
    items: [{ name: 'Efreeti War Bow', count: 1, who: [], where: 'Island 4' }]
  }
  const bow = itemCountKey('Efreeti War Bow')
  const key = questKey(bowQuest)
  for (const countSource of ['both', 'inventory'] as const) {
    const res = reconcile({
      log: { [bow]: 1 },
      inv: { 'efreeti war bow': 2, 'efreeti war bow +1': 1 },
      lootNames: {},
      countSource,
      quests: [bowQuest],
      turnIns: { [key]: 1 },
      turnInInstants: { [key]: [DUMP_AT + 120_000] },
      detectedTurnInInstants: { [key]: [DUMP_AT + 120_000] },
      rebaselineAt: DUMP_AT,
      destroyedSinceDump: { [bow]: 2 },
      lootSinceRebaseline: {}
    })
    assert.equal(res.net[bow], 0, `${countSource}: 3 dumped - 2 destroyed - 1 turned in`)
  }
})

test('JOS-141 IS INTACT: a turn-in the dump already reflects is still never subtracted', () => {
  const res = run({
    countSource: 'both',
    inv: { 'sphinx claw': 4 },
    rebaselineAt: DUMP_AT,
    lootSinceRebaseline: { [claw]: 1 },
    turnIns: { [TEST_KEY]: 1 },
    turnInInstants: { [TEST_KEY]: [DUMP_AT - HOUR] },
    detectedTurnInInstants: { [TEST_KEY]: [DUMP_AT - HOUR] }
  })
  assert.equal(res.net[claw], 5, 'the file already had that run taken out of it; the refarm adds')
})

test('…and a BANKED item the dump never saw is still answered by the log witness under `both`', () => {
  // The cost `rebaseline` accepts and `both` refuses (JOS-141's field-testing): an item looted long
  // before the dump, sitting in a bank window that was shut when the file was written.
  const shared: Partial<ReconcileInput> = {
    log: { [claw]: 6 },
    inv: {},
    rebaselineAt: DUMP_AT,
    lootSinceRebaseline: {}
  }
  assert.equal(run({ ...shared, countSource: 'both' }).net[claw], 6, '`both` still believes the log')
  assert.equal(run({ ...shared, countSource: 'rebaseline' }).net[claw], 0, 'the mode`s stated cost')
})

test('MONOTONICITY: no source can be made to fall by looting one more', () => {
  for (const countSource of ['log', 'inventory', 'both', 'rebaseline'] as const) {
    let previous = -1
    for (const since of [0, 1, 2, 5, 9]) {
      const n =
        run({
          countSource,
          log: { [claw]: 2 + since },
          inv: { 'sphinx claw': 3 },
          rebaselineAt: DUMP_AT,
          lootSinceRebaseline: { [claw]: since },
          destroyedSinceDump: { [claw]: 1 },
          turnIns: { [TEST_KEY]: 1 },
          turnInInstants: { [TEST_KEY]: [DUMP_AT + HOUR] },
          detectedTurnInInstants: { [TEST_KEY]: [DUMP_AT + HOUR] }
        }).net[claw] ?? 0
      assert.ok(n >= previous, `${countSource}: looting one more dropped the count to ${String(n)}`)
      previous = n
    }
  }
})

test('THE FIX ONLY EVER RAISES A COUNT — the credit is added, so no shown number can fall', () => {
  // The direction the 2026-08-09 ruling cares about, said as a property rather than as a case: for
  // every shape below, `both` with the loot credit is >= `both` without it.
  const shapes: Partial<ReconcileInput>[] = []
  for (const dumped of [0, 1, 4]) {
    for (const since of [0, 2, 7]) {
      for (const times of [0, 1, 3]) {
        shapes.push({
          log: { [claw]: 3 },
          inv: dumped ? { 'sphinx claw': dumped } : {},
          rebaselineAt: DUMP_AT,
          lootSinceRebaseline: { [claw]: since },
          turnIns: times ? { [TEST_KEY]: times } : {},
          turnInInstants: times ? { [TEST_KEY]: [DUMP_AT + HOUR] } : {}
        })
      }
    }
  }
  for (const s of shapes) {
    const withCredit = run({ ...s, countSource: 'both' }).net[claw] ?? 0
    const without = run({ ...s, countSource: 'both', lootSinceRebaseline: {} }).net[claw] ?? 0
    assert.ok(withCredit >= without, `credit lowered a count: ${JSON.stringify(s)}`)
  }
  assert.equal(shapes.length, 27, 'the space actually ran')
})

// =============================================================================
// 5. Part 3 — the caveat that makes a zero explain itself
// =============================================================================

test('the dump-blind predicate names the runes and nothing else', () => {
  for (const name of Object.keys(LOOTED_RUNES)) assert.ok(isDumpBlindItem(name), name)
  for (const name of ['Sphinx Claw', 'Ivory Sky Diamond', 'Efreeti War Bow', 'Azarack Skin']) {
    assert.ok(!isDumpBlindItem(name), `${name} is an ordinary item the dump can report`)
  }
  // Every rune in the shipped quest data is covered — a scrape that adds a sixteenth must not
  // silently fall outside the caveat.
  const runes = QUESTS.flatMap((q) => q.items.map((i) => i.name)).filter((n) =>
    n.toLowerCase().startsWith('wind rune')
  )
  assert.ok(runes.length > 0 && runes.every(isDumpBlindItem), 'every quest rune is dump-blind')
})

test('the caveat copy states the game fact, points at the remedy, and carries no em dash', () => {
  for (const note of [DUMP_BLIND_ITEM_NOTE, DUMP_BLIND_READY_NOTE]) {
    assert.match(note, /\/outputfile inventory/, 'it names the command it is about')
    assert.match(note, /currency/i, 'and the storage that is the reason')
    assert.ok(!/[–—]/.test(note), 'user-facing copy uses a plain dash (JOS-106)')
  }
  // The row note ends on the control that fixes it (JOS-186's pencil); the Ready note says how to
  // reach that control from a tab where the quest is not even drawn.
  assert.match(DUMP_BLIND_ITEM_NOTE, /pencil/)
  assert.match(DUMP_BLIND_READY_NOTE, /expand it and state the rune count by hand/)
  // The second reporter's exact dead end has to be answered in words, not just in arithmetic.
  assert.match(DUMP_BLIND_ITEM_NOTE, /re-exporting cannot help/)
})
