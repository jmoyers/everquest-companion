// THE GEAR PLAN BOARD'S ARITHMETIC — the spelling table, the uplift per cell, and the diff against
// the real equipped rows.
//
// A SEPARATE FILE FROM `gearPlan.test.mts`, which owns the document's shape and edits: the two
// halves fail for different reasons (a wrong fold there, a wrong number here), and this repo splits
// at the measured 400-code-line ceiling rather than after it.
//
// MOST OF WHAT IS ASSERTED HERE WAS ASSERTED BEFORE, in `tests/gearSet.test.mts`, which JOS-325
// deleted with the surface it spoke for. The module under test is `gearSetTotals.ts` revived under
// a document with no name and no switcher, so its claims come back with it — and the spelling-table
// guard is the one that MUST, because without it a key added to `GEAR_STAT_KEYS` with no spelling
// silently drops a stat out of every total rather than turning anything red.
//
// EVERY EXPECTED NUMBER IS COMPUTED, NEVER TYPED. The uplift comes from phase 0 (`scalePrimary` /
// `scaleFlat`), asked here rather than copied, so a change to the wiki's own calculator moves the
// test and the code together instead of leaving a frozen constant behind to rot.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import itemsJson from '../src/main/data/items.json'
import { parseInventoryDump } from '../src/main/outputs/inventoryParse'
import { buildPlannerIndex } from '../src/main/planner/effectIndex'
import { itemKey, type ItemDbFile } from '../src/main/itemsDb'
import {
  normalizeStatKey,
  scaleFlat,
  scalePrimary,
  type ItemUpgradeState
} from '../src/shared/itemUpgrade'
import { GEAR_STAT_KEYS, type GearRow } from '../src/shared/planner/gear'
import { equippedHosts } from '../src/shared/planner/inventorySlots'
import {
  assignToCell,
  cellAt,
  cellForItem,
  filledCells,
  withCellState,
  withSocket,
  EMPTY_GEAR_PLAN,
  type GearPlan
} from '../src/shared/planner/gearPlan'
import {
  GEAR_STAT_SPELLING,
  cellBlock,
  cellStatLine,
  equippedRead,
  gearPlanDiff,
  gearPlanTotals,
  statBlockFromVector
} from '../src/shared/planner/gearPlanTotals'
import { PLAN_SLOTS, SOCKET_TYPES, type SocketType } from '../src/shared/planner/types'

// =================================================================================
// FIXTURES
// =================================================================================

function row(over: Partial<GearRow> & Pick<GearRow, 'key' | 'name'>): GearRow {
  return {
    searchKey: over.name.toLowerCase(),
    slots: [],
    classes: [],
    races: ['ALL'],
    flags: [],
    quest: false,
    playerCrafted: false,
    stats: {},
    effects: [],
    ...over
  }
}

/** Thelvorn's base vector, as `tests/gearIndex.test.mts` asserts the corpus states it. */
const THELVORN = row({
  key: 'thelvorn, blade of light',
  name: 'Thelvorn, Blade of Light',
  slots: ['PRIMARY'],
  stats: { WIS: 15, DMG: 20, DELAY: 26, WEIGHT: 3 }
})

/** A ring, so the paired-cell rule has something to fill both fingers with. */
const RING = row({
  key: 'ring of pureblood',
  name: 'Ring of Pureblood',
  slots: ['FINGER'],
  stats: { AC: 5, STR: 4, HP: 20 }
})

const RING2 = row({
  key: 'ring of the shissar',
  name: 'Ring of the Shissar',
  slots: ['FINGER'],
  stats: { AC: 3, STA: 12 }
})

/**
 * The two haste items whose stacking no source states — the refusal's fixture. HANDS before WAIST
 * is the board order (`PLAN_SLOTS`), which is the order the unsummed list states them in.
 */
const HASTE_A = row({
  key: 'haste gloves',
  name: 'Haste Gloves',
  slots: ['HANDS'],
  stats: { HASTE: 36, AC: 8 }
})
const HASTE_B = row({ key: 'haste belt', name: 'Haste Belt', slots: ['WAIST'], stats: { HASTE: 21 } })

const CORPUS = [THELVORN, RING, RING2, HASTE_A, HASTE_B]
const lookup = (key: string): GearRow | undefined => CORPUS.find((r) => r.key === key)

function add(gearPlan: GearPlan, item: GearRow, state?: ItemUpgradeState): GearPlan {
  return assignToCell(gearPlan, cellForItem(gearPlan, item.slots), cellAt(item, state)).gearPlan
}

// =================================================================================
// THE SPELLING TABLE (the inverse of phase 0's alias table)
// =================================================================================

test('every spelled key folds BACK to its own key through phase 0`s normalizeStatKey', () => {
  for (const [key, spelling] of Object.entries(GEAR_STAT_SPELLING)) {
    assert.equal(normalizeStatKey(spelling), key, `${spelling} must fold to ${key}`)
  }
})

test('every summable vector key HAS a spelling — a new stat cannot vanish out of the totals', () => {
  const structural = new Set(['AC', 'DMG', 'DELAY', 'DMG_BONUS', 'BACKSTAB', 'RANGE', 'WEIGHT'])
  for (const key of GEAR_STAT_KEYS) {
    if (structural.has(key)) continue
    assert.ok(GEAR_STAT_SPELLING[key] !== undefined, `${key} has no spelling and would be dropped`)
  }
})

test('the block splits saves from stats and keeps the structural numbers out of both', () => {
  const block = statBlockFromVector({ AC: 10, STR: 5, SV_FIRE: 7, DMG: 20, DELAY: 26, WEIGHT: 3 })
  assert.equal(block.ac, 10)
  assert.deepEqual(block.stats, [{ key: 'STR', value: '+5' }])
  assert.deepEqual(block.saves, [{ key: 'SV FIRE', value: '+7' }])
  assert.equal(block.dmg, 20)
  assert.equal(block.atkDelay, 26)
  assert.equal(block.weight, '3.0')
})

// =================================================================================
// THE TOTALS — the uplift, per cell
// =================================================================================

test('the totals apply the uplift PER CELL, at each item`s own plus-state', () => {
  // Two rings, two different states. Neither number is typed here: both come from phase 0.
  const board = add(add(EMPTY_GEAR_PLAN, RING, { full: 5, fraction: 0 }), RING2, { full: 0, fraction: 0 })
  const totals = gearPlanTotals(board, lookup)

  const at5: ItemUpgradeState = { full: 5, fraction: 0 }
  const wantAc = scalePrimary(5, at5) + 3
  const wantStr = scalePrimary(4, at5)
  const wantHp = scalePrimary(20, at5)

  assert.equal(totals.ac, wantAc, 'AC sums the SCALED ring and the base one')
  assert.equal(totals.stats.find((s) => s.label === 'Strength')?.total, wantStr)
  assert.equal(totals.stats.find((s) => s.label === 'HP')?.total, wantHp)
  assert.equal(totals.stats.find((s) => s.label === 'Stamina')?.total, 12, 'the base ring is unmoved')
  assert.equal(totals.counted, 2)
  assert.equal(totals.unknown, 0)

  // …and moving ONE cell's slider moves only that cell's contribution.
  const moved = gearPlanTotals(withCellState(board, 'FINGER2', at5), lookup)
  assert.equal(moved.stats.find((s) => s.label === 'Stamina')?.total, scalePrimary(12, at5))
  assert.equal(moved.stats.find((s) => s.label === 'Strength')?.total, wantStr, 'the other ring did not move')
})

test('an upgraded item can contribute the SYNTHETIC SV VOID save (phase 0`s voidSynth)', () => {
  const synth = row({
    key: 'two triggers',
    name: 'Two Triggers',
    slots: ['HEAD'],
    stats: { STR: 12, STA: 9 },
    voidSynth: true
  })
  const only = (k: string): GearRow | undefined => (k === synth.key ? synth : undefined)
  const board = assignToCell(EMPTY_GEAR_PLAN, 'HEAD', cellAt(synth, { full: 4, fraction: 0 })).gearPlan
  assert.equal(gearPlanTotals(board, only).saves.find((s) => s.label === 'SV Void')?.total, 4)
  // …and at base there is nothing to synthesize.
  assert.equal(gearPlanTotals(add(EMPTY_GEAR_PLAN, synth), only).saves.length, 0)
})

test('percent-valued stats are STATED, never added — sumGear`s refusal, reached unchanged', () => {
  const board = add(add(EMPTY_GEAR_PLAN, HASTE_A), HASTE_B)
  const totals = gearPlanTotals(board, lookup)
  assert.equal(totals.stats.find((s) => s.label === 'Haste'), undefined, 'haste may never be a total')
  const haste = totals.unsummed.find((u) => u.label === 'Haste')
  assert.deepEqual(haste?.values, ['+36%', '+21%'], 'the individual values, in board order')
  // The rest of the item still sums normally — the refusal is per VALUE, not per item.
  assert.equal(totals.ac, 8)

  // …and the flat rule still applies to haste per item, which is why the values move with the
  // slider even though nothing adds them up.
  const merged = gearPlanTotals(withCellState(board, 'HANDS', { full: 3, fraction: 0 }), lookup)
  assert.deepEqual(merged.unsummed.find((u) => u.label === 'Haste')?.values, [
    `+${String(scaleFlat(36, { full: 3, fraction: 0 }))}%`,
    '+21%'
  ])
})

test('a cell the corpus cannot resolve is UNKNOWN and contributes to nothing', () => {
  const board = assignToCell(
    add(EMPTY_GEAR_PLAN, RING),
    'HEAD',
    cellAt({ key: 'djarns amethyst ring', name: 'Djarn`s Amethyst Ring' })
  ).gearPlan
  const totals = gearPlanTotals(board, lookup)
  assert.equal(totals.counted, 1)
  assert.equal(totals.unknown, 1)
  assert.equal(totals.ac, 5, 'the unknown item added nothing')
})

test('a planned EXALTATION moves an effect, so it reaches no total at all', () => {
  const bare = add(EMPTY_GEAR_PLAN, RING, { full: 2, fraction: 0 })
  const socketed = withSocket(bare, 'FINGER', 'focus', {
    effect: 'Improved Healing III',
    donorKey: 'robe of the lost circle',
    donorName: 'Robe of the Lost Circle'
  })
  // The whole totals object is identical: sumGear sums ac/stats/saves and an effect is none of them.
  assert.deepEqual(gearPlanTotals(socketed, lookup), gearPlanTotals(bare, lookup))
})

test('a cell states its own contribution in the totals row`s words', () => {
  const stats = cellStatLine(cellBlock(THELVORN, { full: 2, fraction: 3 }))
  // WIS 15 at the owner's checkpoint is phase 0's answer, asked here rather than typed.
  assert.deepEqual(stats, [
    { label: 'Wisdom', value: `+${String(scalePrimary(15, { full: 2, fraction: 3 }))}` }
  ])
})

// =================================================================================
// THE DIFF — against the REAL equipped rows
// =================================================================================

const REAL_DUMP = readFileSync(
  join(import.meta.dirname, 'fixtures', 'Primitive_freeport-Inventory.txt'),
  'utf8'
)
const WORN = equippedHosts(parseInventoryDump(REAL_DUMP)).map((h) => ({
  ...h,
  key: h.name.toLowerCase()
}))

test('the equipped read fills cells from the REAL dump, and says what it had to assume', () => {
  const read = equippedRead(WORN)
  assert.ok(filledCells(read.gearPlan).length >= 20, 'the committed dump wears twenty-plus things')
  // Every filled cell is a `PLAN_SLOTS` cell — `equippedHosts` already answers in that vocabulary.
  for (const { cell } of filledCells(read.gearPlan)) assert.ok(PLAN_SLOTS.includes(cell))
  // A ` +N` in the name becomes a whole-tier state; a name without one is read at BASE and counted.
  const stated = WORN.filter((h) => h.tier !== undefined)
  assert.ok(stated.length > 0, 'the owner has merged things')
  const first = stated[0]
  assert.deepEqual(read.gearPlan.cells[first.slot]?.state, { full: first.tier ?? 0, fraction: 0 })
  assert.equal(read.unstated, WORN.length - stated.length)
  // NO RESOLVER, NO SOCKETS. These hosts carry the dump's donor NAMES but no `exaltationKeys` and
  // this call passes no `offers`, so the read fills nothing — the caller that wants worn sockets
  // has to hand over the corpus, which is the next test.
  for (const { planned } of filledCells(read.gearPlan)) assert.deepEqual(planned.sockets, {})
})

// ---- and the sockets, against the REAL corpus ------------------------------------------------
//
// THE END OF THE CHAIN, in one test: the client's own file → `equippedHosts` (donor NAMES off the
// `-Slot<n>` children) → `itemKey` → the shipped effect database → a socket that names an effect.
// Every link is the real one; nothing here is a stub. It is worth the corpus parse because the
// claim is a JOIN ACROSS TWO SOURCES, which is precisely what no unit fixture can vouch for: the
// names the game writes have to be the keys the wiki scrape produced, or the whole feature reads
// as "you have nothing socketed" on a character wearing five things.

const DONORS = buildPlannerIndex(itemsJson as unknown as ItemDbFile).donors
const OFFERS = ((): ((key: string) => readonly { effect: string; socket: SocketType }[]) => {
  const byKey = new Map<string, { effect: string; socket: SocketType }[]>()
  for (const d of DONORS) {
    const list = byKey.get(d.key)
    if (list) list.push({ effect: d.effect, socket: d.socket })
    else byKey.set(d.key, [{ effect: d.effect, socket: d.socket }])
  }
  return (key) => byKey.get(key) ?? []
})()

const KEYED = equippedHosts(parseInventoryDump(REAL_DUMP)).map((h) => ({
  ...h,
  key: itemKey(h.name),
  exaltationKeys: h.exaltations.map(itemKey)
}))

test('the dump`s donor names resolve through the SHIPPED corpus into named sockets', () => {
  const named = KEYED.reduce((n, h) => n + h.exaltations.length, 0)
  assert.ok(named > 0, 'the committed character wears socketed exaltations')

  const read = equippedRead(KEYED, 0, OFFERS)
  const filled = filledCells(read.gearPlan).flatMap(({ cell, planned }) =>
    SOCKET_TYPES.filter((s) => planned.sockets[s] !== undefined).map((s) => ({ cell, socket: s }))
  )
  // A FLOOR, not the measured number: the corpus grows, and a rescrape that resolves MORE of them
  // must not turn this red. What must stay true is that the join works at all and loses nothing.
  assert.ok(filled.length > 0, 'the two sources still key to each other')
  assert.equal(filled.length + read.unresolved, named, 'every donor is either placed or counted')

  for (const { cell, socket } of filled) {
    const planned = read.gearPlan.cells[cell]?.sockets[socket]
    assert.ok(planned !== undefined)
    assert.ok(planned.effect.length > 0, 'a filled socket names an EFFECT, never the donor item')
    assert.ok(planned.donorName.length > 0, 'and still says which item it came out of')
    assert.equal(itemKey(planned.donorName), planned.donorKey, 'name and key are the same row')
    // The pair the corpus was asked for is the pair that came back — no socket was inferred.
    assert.ok(
      OFFERS(planned.donorKey).some((o) => o.effect === planned.effect && o.socket === socket),
      `${planned.effect} in ${socket} is not something ${planned.donorKey} offers`
    )
  }
})

test('an unresolvable donor leaves its socket EMPTY and is counted, never guessed', () => {
  // `Djarn's Amethyst Ring` is this repo's standing example of an item the wiki scrape has no row
  // for — `characterSheet.ts` names it for the same reason. The character wears one as a donor, so
  // the real dump exercises the miss path without a fabricated fixture.
  const read = equippedRead(KEYED, 0, OFFERS)
  assert.ok(read.unresolved > 0, 'the committed dump is expected to carry at least one miss')
  // The count is the ONLY trace. Nothing was written into a socket to stand in for it.
  const invented = filledCells(read.gearPlan).flatMap(({ planned }) =>
    SOCKET_TYPES.filter((s) => {
      const v = planned.sockets[s]
      return v !== undefined && OFFERS(v.donorKey).length === 0
    })
  )
  assert.deepEqual(invented, [], 'no socket names an effect no corpus row offers')
})

test('the diff states a difference, and an empty cell is not a proposal to strip you', () => {
  const worn = equippedRead(WORN)
  // A board holding ONE thing the character is not wearing: every number it states is a gain.
  const mine = add(EMPTY_GEAR_PLAN, RING, { full: 5, fraction: 0 })
  const totals = { plan: gearPlanTotals(mine, lookup), equipped: gearPlanTotals(worn.gearPlan, lookup) }
  const diff = gearPlanDiff(totals, { plan: mine, equipped: worn.gearPlan })

  assert.equal(diff.cellsChanged, 1, 'only the cell the plan names can change')
  assert.equal(diff.ac.plan, scalePrimary(5, { full: 5, fraction: 0 }))
  assert.equal(diff.ac.delta, diff.ac.plan - diff.ac.equipped)
  assert.ok(diff.changed > 0, 'a plan the character is not wearing must state a difference')
  const str = diff.stats.find((r) => r.label === 'Strength')
  assert.equal(str?.delta, (str?.plan ?? 0) - (str?.equipped ?? 0))
})

test('planning the SAME item at a HIGHER tier is a change — that is what a merge plan is', () => {
  const worn = equippedRead(WORN)
  const cell = filledCells(worn.gearPlan)[0]
  const same = assignToCell(EMPTY_GEAR_PLAN, cell.cell, cell.planned).gearPlan
  const higher = withCellState(same, cell.cell, { full: cell.planned.state.full + 1, fraction: 0 })

  const at = (plan: GearPlan): ReturnType<typeof gearPlanDiff> =>
    gearPlanDiff(
      { plan: gearPlanTotals(plan, lookup), equipped: gearPlanTotals(worn.gearPlan, lookup) },
      { plan, equipped: worn.gearPlan }
    )
  assert.equal(at(same).cellsChanged, 0, 'the same item at the same tier changes nothing')
  assert.equal(at(higher).cellsChanged, 1)
})

test('a planned socket is not a cell change — the worn side cannot state one to disagree with', () => {
  const worn = equippedRead(WORN)
  const cell = filledCells(worn.gearPlan)[0]
  const same = assignToCell(EMPTY_GEAR_PLAN, cell.cell, cell.planned).gearPlan
  const socketed = withSocket(same, cell.cell, 'focus', {
    effect: 'Improved Healing III',
    donorKey: 'robe of the lost circle',
    donorName: 'Robe of the Lost Circle'
  })
  const diff = gearPlanDiff(
    { plan: gearPlanTotals(socketed, lookup), equipped: gearPlanTotals(worn.gearPlan, lookup) },
    { plan: socketed, equipped: worn.gearPlan }
  )
  assert.equal(diff.cellsChanged, 0, 'counting it would report every plan as a change forever')
})

test('the diff never touches the unsummed list — you cannot subtract what you cannot add', () => {
  const mine = add(EMPTY_GEAR_PLAN, HASTE_A)
  const worn = equippedRead(WORN)
  const totals = { plan: gearPlanTotals(mine, lookup), equipped: gearPlanTotals(worn.gearPlan, lookup) }
  const diff = gearPlanDiff(totals, { plan: mine, equipped: worn.gearPlan })
  const labels = [diff.ac, ...diff.stats, ...diff.saves].map((r) => r.label)
  assert.equal(labels.includes('Haste'), false)
  // …and both sides still SAY what they carry.
  assert.deepEqual(totals.plan.unsummed.find((u) => u.label === 'Haste')?.values, ['+36%'])
})
