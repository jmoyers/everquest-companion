// CHARACTER SHEET (JOS-45) — the armory grid and the gear sum, pinned against the real dump.
//
// Two independent things are under test and they fail for different reasons:
//
//   THE GRID is a hand-authored table (law 12) over the CLIENT's own Location tokens, and its
//   only rule for the four paired slots (`Ear`, `Wrist`, `Fingers`, `Any Slot`) is OCCURRENCE
//   ORDER — the file states no side. So the grid is pinned three ways: it is total over the
//   client's closed token set, its cells are unique, and it places the real 295-line dump's
//   twenty-four equipment rows with nothing left over and nothing invented.
//
//   THE SUM must never assert arithmetic nobody measured. The two things it refuses are pinned
//   directly: a percentage never enters a total (two worn items carry Haste), and an item the
//   committed DB does not know is COUNTED as unknown rather than silently treated as zero.
//   That second one is not hypothetical — the dev character's `Djarn's Amethyst Ring` is titled
//   `Djarns Amethyst Ring` on the wiki, a genuine cross-source name difference law 12 forbids
//   closing with a matcher.
//
//   AND SINCE JOS-416 THE SUM READS EACH ITEM AT ITS ` +N`, through the one upgrade algorithm.
//   The owner's ruling reversed JOS-327's base-computed totals and did so GENERALLY, so the pins
//   below are general too: the reported case (`Cloak of Flames +5`, whose Haste read `+36%` on
//   this tab and `+41%` everywhere else) is asserted stat by stat rather than on haste alone, an
//   un-suffixed item is asserted BYTE-IDENTICAL to what it summed before, and the corpus-wide
//   identity says the totals equal `scaleStatBlock` applied item by item — which is what makes a
//   second, forked spelling of the arithmetic fail here instead of shipping.
//
// The DB half re-does main's join here (`buildItemDbIndex` + `itemKey`, both Electron-free) so
// this stays a node test: `src/main/ipc/characterSheet.ts` imports electron and cannot be
// driven from the runner. It is the SAME two functions the handler calls.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EQUIP_LOCATIONS } from '../src/shared/outputs/inventory'
import { parseInventoryDump } from '../src/main/outputs/inventoryParse'
import {
  SHEET_SLOTS,
  sheetCells,
  statInteger,
  sumGear,
  wornBlock,
  type WornItemBlock
} from '../src/shared/characterSheet'
import { scaleStatBlock, upgradeStateForTier } from '../src/shared/itemUpgrade'
import type { ItemStatBlock } from '../src/shared/itemStats'
import { buildItemDbIndex, itemKey, type ItemDbFile } from '../src/main/itemsDb'

const REAL_DUMP = readFileSync(
  join(import.meta.dirname, 'fixtures', 'Primitive_freeport-Inventory.txt'),
  'utf8'
)
const dump = parseInventoryDump(REAL_DUMP)
const { cells, unplaced } = sheetCells(dump)
const cell = (id: string): (typeof cells)[number] => {
  const found = cells.find((c) => c.id === id)
  assert.ok(found, `no cell ${id}`)
  return found
}

// ---- the grid ------------------------------------------------------------------------

test('the grid is TOTAL over the client tokens, and every cell id is unique', () => {
  const ids = new Set(SHEET_SLOTS.map((s) => s.id))
  assert.equal(ids.size, SHEET_SLOTS.length, 'two cells share an id')
  for (const token of EQUIP_LOCATIONS) {
    assert.ok(
      SHEET_SLOTS.some((s) => s.token === token),
      `no cell reads the client token ${token} — it would vanish off the sheet`
    )
  }
  // Every (token, nth) pair is claimed by exactly one cell, or two cells would fight over a row.
  const pairs = new Set(SHEET_SLOTS.map((s) => `${s.token}#${String(s.nth)}`))
  assert.equal(pairs.size, SHEET_SLOTS.length)
})

test('both cells of a pair carry the SAME label — the file never says which is left', () => {
  for (const token of ['Ear', 'Wrist', 'Fingers', 'Any Slot'] as const) {
    const pair = SHEET_SLOTS.filter((s) => s.token === token)
    assert.equal(pair.length, 2, `${token} occurs twice at top level in the real dump`)
    assert.equal(pair[0].label, pair[1].label, `${token} cells must not claim an order`)
    assert.ok(!/\d/.test(pair[0].label), `${token} label must not number the slots`)
  }
})

test('the real dump fills every cell it should, and leaves nothing unplaced', () => {
  assert.equal(cells.length, 24, 'the dump has twenty-four top-level equipment rows')
  assert.deepEqual(unplaced, [], 'the real dump has no equipped row the grid cannot place')

  // Paired slots take occurrences in FILE ORDER — the only signal the file gives.
  assert.equal(cell('ear1').item?.name, 'Drop of Crystallized Flame +7')
  assert.equal(cell('ear2').item?.name, 'Earring of Disease Reflection +4')
  assert.equal(cell('wrist1').item?.name, 'Valorium Bracers +2')
  assert.equal(cell('wrist2').item?.name, 'Lustrous Russet Bracer +1')
  assert.equal(cell('any1').item?.name, 'Brigandine Tunic +1')
  assert.equal(cell('any2').item?.name, 'Midnight Clad Straps +2')

  // `Empty` is a slot that exists and holds nothing — never a missing cell.
  assert.equal(cell('ammo').item, null)
  assert.equal(cell('held').item, null)

  // The ` +N` item level is split off the name but the name keeps it (the game prints it).
  assert.equal(cell('primary').item?.tier, 5)
  assert.equal(cell('primary').item?.baseName, 'Thelvorn, Blade of Light')
})

test('socket rows are NOT items — they are exaltations of the row above them', () => {
  // Every `-Slot<n>` child is either bag contents or a socket; none of them is a worn item.
  for (const c of cells) assert.ok(!c.location.includes('-Slot'), `${c.id} read a socket row`)

  assert.deepEqual(cell('face').item?.exaltations, ['Polished Mithril Mask'])
  assert.deepEqual(cell('range').item?.exaltations, ['Idol of the Underking'])
  assert.deepEqual(cell('primary').item?.exaltations, ['Thelvorn, Blade of Light'])
  // A socket may hold a DIFFERENT item than its host — the second ring's does.
  assert.deepEqual(cell('finger2').item?.exaltations, ['Moonstone Ring'])
  assert.deepEqual(cell('chest').item?.exaltations, [], 'empty sockets are not exaltations')
})

// ---- the sum -------------------------------------------------------------------------

test('statInteger takes an integer and REFUSES a percentage', () => {
  assert.equal(statInteger('+9'), 9)
  assert.equal(statInteger('-5'), -5)
  assert.equal(statInteger('10'), 10, 'the real dump has a bare Endurance value')
  assert.equal(statInteger('+36%'), null, 'a percentage in an integer total is the lie to prevent')
  assert.equal(statInteger('21%'), null)
  assert.equal(statInteger(''), null)
  assert.equal(statInteger('a lot'), null)
})

const block = (over: Partial<ItemStatBlock>): ItemStatBlock => ({
  flags: [],
  stats: [],
  saves: [],
  effects: [],
  exaltationSlots: [],
  extras: [],
  ...over
})

/** A worn item at no ` +N` at all — the base state, and the shape every pre-JOS-416 case used. */
const worn0 = (over: Partial<ItemStatBlock>): { block: ItemStatBlock } => ({ block: block(over) })

test('percentages are STATED side by side, never added', () => {
  const totals = sumGear([
    worn0({ stats: [{ key: 'HASTE', value: '+36%' }] }),
    worn0({ stats: [{ key: 'HASTE', value: '+21%' }] })
  ])
  assert.deepEqual(totals.stats, [], 'no percentage may reach a summed row')
  assert.deepEqual(totals.unsummed, [{ label: 'Haste', values: ['+36%', '+21%'] }])
})

test('integers sum, saves stay split out, and END folds onto ENDURANCE', () => {
  const totals = sumGear([
    worn0({ ac: 21, stats: [{ key: 'STR', value: '+20' }, { key: 'END', value: '10' }], saves: [{ key: 'SV FIRE', value: '+10' }] }),
    worn0({ ac: 10, stats: [{ key: 'STR', value: '+5' }, { key: 'ENDURANCE', value: '+5' }], saves: [{ key: 'SV FIRE', value: '+15' }] })
  ])
  assert.equal(totals.ac, 31)
  assert.deepEqual(
    totals.stats,
    [
      { label: 'Strength', total: 25, from: 2 },
      { label: 'Endurance', total: 15, from: 2 }
    ],
    'attributes come before HP/Mana/Endurance in the canonical order'
  )
  assert.deepEqual(totals.saves, [{ label: 'SV Fire', total: 25, from: 2 }])
  assert.equal(totals.counted, 2)
  assert.equal(totals.unknown, 0)
})

test('an item the DB does not know is COUNTED, never treated as zeroes', () => {
  // An unknown item still states a tier — and still contributes nothing. A `+7` with no block
  // must not become a block, which is the failure mode a scaler bolted on carelessly would have.
  const totals = sumGear([worn0({ ac: 21 }), {}, { tier: 7 }])
  assert.equal(totals.counted, 1)
  assert.equal(totals.unknown, 2)
  assert.equal(totals.ac, 21, 'an unknown item contributes nothing at all')
})

// ---- the join, over the committed corpus ----------------------------------------------

const itemsDb = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'src', 'main', 'data', 'items.json'), 'utf8')
) as ItemDbFile
const dbIndex = buildItemDbIndex(itemsDb)
const worn = cells.filter((c) => c.item !== null)
/** The handler's own read of a cell: the DB block, and the ` +N` the dump's name stated. */
const wornOf = (c: (typeof worn)[number]): WornItemBlock => ({
  tier: c.item?.tier,
  block: dbIndex.get(itemKey(c.item?.baseName ?? ''))?.stats
})
const totals = sumGear(worn.map(wornOf))

test('the sum covers exactly the worn items, and says how many it could not read', () => {
  assert.equal(worn.length, 22, 'twenty-two of the twenty-four cells hold something')
  assert.equal(
    totals.counted + totals.unknown,
    worn.length,
    'every worn item is either summed or counted as unknown — none may fall between'
  )
  // An IDENTITY, not a frozen number: the corpus is re-scrapable, so this re-derives the total
  // rather than asserting today's number.
  const acs = worn.map((c) => wornBlock(wornOf(c))?.ac ?? 0)
  assert.equal(totals.ac, acs.reduce((a, b) => a + b, 0))
  assert.ok(totals.ac > 0, 'the dev character is wearing armour')
  assert.ok(totals.stats.some((s) => s.label === 'Strength'), 'and it has stats on it')
})

// ---- the ` +N` uplift IS applied (JOS-416) ---------------------------------------------

test('the totals are SCALED by the worn ` +N`, through the one algorithm (owner, JOS-416)', () => {
  // The owner's 2026-08-19 ruling reversed JOS-327's base-computed totals. Asserted as an IDENTITY
  // over the corpus rather than against today's numbers: the sum equals what `scaleStatBlock` says
  // item by item — so a second, forked spelling of the arithmetic in the sum fails here — and it is
  // STRICTLY different from the old base-only answer, which is the defect the ticket reported.
  const tiered = worn.filter((c) => c.item?.tier !== undefined)
  assert.ok(tiered.length > 0, 'the dev character wears upgraded gear, or this test proves nothing')

  const byHand = sumGear(
    worn.map((c) => {
      const b = dbIndex.get(itemKey(c.item?.baseName ?? ''))?.stats
      return { block: b ? scaleStatBlock(b, upgradeStateForTier(c.item?.tier)) : undefined }
    })
  )
  assert.deepEqual(totals, byHand, 'the sum must be scaleStatBlock item by item, and nothing else')

  const base = sumGear(worn.map((c) => ({ block: dbIndex.get(itemKey(c.item?.baseName ?? ''))?.stats })))
  assert.notDeepEqual(totals, base, 'upgraded gear must not still read as its base blocks')
  assert.ok(totals.ac > base.ac, 'AC scales, and eleven worn items state a ` +N`')

  // The tier is applied AND still spelled where the dump spelled it — the slot grid and the
  // carry-all ledger both print the item's own name.
  assert.ok(tiered.every((c) => / \+\d+$/.test(c.item?.name ?? '')))
})

// The reported case (report VJTH7D, 1.5.0: "Cloak of flames +5 showing the wrong amount of haste in
// Character tab"). The reporter's own dump is not reproduced here and never becomes a fixture — the
// ONE fact taken from it is the item and its item level, and the stat block below is the COMMITTED
// corpus's own record for the wiki page `Cloak of Flames`, which the assertion under it re-checks.
const COF_BASE: ItemStatBlock = block({
  flags: ['Magic Item'],
  ac: 10,
  stats: [
    { key: 'DEX', value: '+9' },
    { key: 'AGI', value: '+9' },
    { key: 'HP', value: '+50' },
    { key: 'HASTE', value: '+36%' }
  ],
  saves: [{ key: 'SV FIRE', value: '+15' }],
  weight: '0.1',
  slot: 'BACK'
})

test('the acceptance case: a `Cloak of Flames +5` reads at +5 in EVERY stat it states', () => {
  assert.deepEqual(
    dbIndex.get(itemKey('Cloak of Flames'))?.stats?.stats,
    COF_BASE.stats,
    'the committed corpus no longer states the block this case was written against — re-read it'
  )

  const totals5 = sumGear([{ tier: 5, block: COF_BASE }])

  // HASTE is the stat the report named: flat, so `36 + 5`. It stays UNSUMMED (a percentage never
  // enters a total, law 6) — what changed is the value that is stated, not the refusal to add it.
  assert.deepEqual(totals5.unsummed, [{ label: 'Haste', values: ['+41%'] }])

  // …and it is NOT haste-specific, which is the whole ruling. Every other stat the cloak states
  // scales by the same algorithm: a primary at or below 10 takes `+full`, one above 10 takes
  // `floor(base + round(base * effective / 10))`.
  assert.equal(totals5.ac, 15, 'AC 10 is a primary at the small-value rule: 10 + 5')
  assert.deepEqual(totals5.stats, [
    { label: 'Agility', total: 14, from: 1 },
    { label: 'Dexterity', total: 14, from: 1 },
    { label: 'HP', total: 75, from: 1 }
  ])
  assert.deepEqual(totals5.saves, [
    { label: 'SV Fire', total: 23, from: 1 },
    { label: 'SV Void', total: 5, from: 1 }
  ], 'an upgraded item carrying two trigger stats gains the synthetic SV VOID line')

  assert.equal(totals5.counted, 1)
  assert.equal(totals5.unknown, 0)
})

test('a `+0` item — a name with no ` +N` at all — is BYTE-IDENTICAL to the old base sum', () => {
  // The half of the change that must not move: an un-upgraded character's panel prints exactly the
  // numbers it printed before JOS-416. `wornBlock` still routes through the scaler at the base
  // state (no fork), and `scaleStatBlock` answers with an equal block.
  const noSuffix = sumGear([{ block: COF_BASE }])
  assert.equal(noSuffix.ac, 10)
  assert.deepEqual(noSuffix.stats, [
    { label: 'Agility', total: 9, from: 1 },
    { label: 'Dexterity', total: 9, from: 1 },
    { label: 'HP', total: 50, from: 1 }
  ])
  assert.deepEqual(noSuffix.saves, [{ label: 'SV Fire', total: 15, from: 1 }], 'no SV VOID at base')
  assert.deepEqual(noSuffix.unsummed, [{ label: 'Haste', values: ['+36%'] }])

  // An explicit `tier: 0` is the same reading, so the two spellings can never disagree.
  assert.deepEqual(sumGear([{ tier: 0, block: COF_BASE }]), noSuffix)
})

test('the known cross-source name gap is SURFACED, not smoothed over (law 12)', () => {
  // The client writes `Djarn's Amethyst Ring`; the wiki page is `Djarns Amethyst Ring`. A
  // matcher would close that by luck and close others by the same luck, so the sheet reports it.
  // Asserted as a CEILING: a future scrape that adds the page legitimately drives this to 0.
  assert.ok(totals.unknown <= 1, `${String(totals.unknown)} worn items are missing from the corpus`)
})
