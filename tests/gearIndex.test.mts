// GEAR PLANNER — the candidate index, asserted against the REAL committed corpus
// (src/main/data/items.json, the 2026-08-13T20:39 scrape: 11,288 records / 11,375 keys / 11,213
// pages the builder walks). JOS-283, phase 2. Nothing skips, nothing is mocked, no Electron:
// `gearIndex.ts` is Electron-free on purpose (the effectIndex precedent) and this runs the SHIPPED
// builder over the SHIPPED bytes, because "the gear table is empty" and "every weapon lost its
// ratio" are failures of this function that no hand-written fixture could see.
//
// WHAT THE 2026-08-13 (JOS-328 rescrape) BUILD MEASURED (printed on every run — a wave that halves
// it should be able to watch itself do that):
//
//     6,814 rows from 11,213 pages — 4,329 placed in no slot, 70 pages collapsed into another
//     page's item key, 162 `|itemname` alias keys skipped
//     1,709 weapons · 1,229 effect-bearing rows · 3,268 rows that gain the synthetic SV VOID
//     16,321 integer stat values · 64 percents (HASTE, and only HASTE) · 30 range triples kept
//     as text · 6 stat values no parse could read · 0 unknown slot tokens
//
// The COUNTS are floors and identities (AGENTS.md "frozen numbers rot" — the wiki gains item pages
// and a rescrape must be able to grow this file without turning it red). The CENSUSES are
// equalities on purpose, exactly like `unknownSlotTokens` in the donor test: a rescrape that
// spells a stat key a new way, or teaches a second key to state a percent, is a COLUMN silently
// leaving the gear table, and it should stop the suite instead.
//
// THE LOAD-BEARING TEST IS `scaling a row is a pure map` BELOW. The whole feature rests on being
// able to answer "what does this item read at +N" for 6,814 rows without rebuilding anything, so
// that test re-derives the answer the SLOW way — `scaleStatBlock` over the item's own parsed stat
// block, phase 0's own API — for every equippable item in the corpus at four states, and demands
// the vector agree on every key it carries. It is the reason the row shape is allowed to exist.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import itemsJson from '../src/main/data/items.json'
import type { ItemDbEntry, ItemDbFile } from '../src/main/itemsDb'
import { ITEMS_RESEARCH, knowledgeWithResearch } from '../src/main/itemsResearch'
import { buildGearIndex, gearStatNumber, gearWeightNumber, readGearStats } from '../src/main/planner/gearIndex'
import { buildPlannerIndex } from '../src/main/planner/effectIndex'
import {
  GEAR_INDEX_VERSION,
  GEAR_PERCENT_STAT_KEYS,
  GEAR_STAT_KEYS,
  isGearStatKey,
  type GearRow
} from '../src/shared/planner/gear'
import { gearRatio, scaleGearRow, scaleGearStats } from '../src/shared/planner/gearScale'
import {
  WEAPON_TYPES,
  weaponPicksMatch,
  weaponTypeOf,
  type WeaponPick,
  type WeaponType
} from '../src/shared/planner/weaponType'
import {
  normalizeStatKey,
  scaleStatBlock,
  synthesizesVoidSave,
  type ItemUpgradeState
} from '../src/shared/itemUpgrade'
import { EQUIP_SLOTS } from '../src/shared/planner/types'
import { isClassAbbr } from '../src/shared/classCombo'
import type { ItemStatBlock } from '../src/shared/itemStats'
// The SHIPPED era join, reached the way the Gear tab reaches it — `gearData` calls exactly these
// two, so the test below asks the screen's own question instead of re-deriving a verdict.
import { eraChip, eraHides } from '../src/renderer/src/features/planner/plannerData'
import { eraBadge } from '../src/shared/planner/era'

const file = itemsJson as unknown as ItemDbFile
const index = buildGearIndex(file)
const rows = index.rows
const byKey = new Map(rows.map((r) => [r.key, r]))

/** "Tier 2   3 / 4" — the owner screenshot phase 0 is verified against. */
const CHECKPOINT: ItemUpgradeState = { full: 2, fraction: 3 }
const STATES: ItemUpgradeState[] = [
  { full: 0, fraction: 0 },
  CHECKPOINT,
  { full: 5, fraction: 17 },
  { full: 10, fraction: 0 }
]

// =================================================================================
// THE CORPUS → ROWS
// =================================================================================

test('every equippable item becomes exactly one row (floors + the page identity)', () => {
  console.log('gear index', {
    rows: rows.length,
    payloadMB: Number((JSON.stringify(index).length / 1024 / 1024).toFixed(2)),
    ...index.stats,
    unindexedStatKeys: index.stats.unindexedStatKeys,
    unreadableStatKeys: index.stats.unreadableStatKeys
  })

  // Floors, under the measured build so a growing corpus stays green.
  assert.ok(rows.length >= 6700, `only ${rows.length} gear rows — expected >= 6700`)
  assert.ok(index.stats.weaponRows >= 1650, `only ${index.stats.weaponRows} weapons`)
  assert.ok(index.stats.effectRows >= 1150, `only ${index.stats.effectRows} effect-bearing rows`)
  assert.ok(index.stats.pages >= 11000, `only ${index.stats.pages} pages walked`)

  // THE IDENTITY: every page walked is accounted for — it became a row, it was placed in no slot,
  // or another page already described the same item. Nothing is dropped silently.
  assert.equal(
    index.stats.pages,
    rows.length + index.stats.slotless + index.stats.duplicatePages,
    'a page must become a row, a slotless skip, or a duplicate — never vanish'
  )
  // Alias keys are skipped by PAGE identity, the same way the donor index skips them.
  assert.equal(index.stats.aliasKeys, buildPlannerIndex(file).stats.aliasKeys)
  assert.ok(index.stats.aliasKeys > 0, 'the corpus is expected to carry |itemname alias keys')
})

test('the row key is a ROW IDENTITY, and it joins the exaltation indices', () => {
  const seen = new Set<string>()
  const dupes: string[] = []
  for (const r of rows) {
    if (seen.has(r.key)) dupes.push(r.key)
    seen.add(r.key)
  }
  // 70 item keys are written up on more than one page (deity and material variants of one
  // in-game item: the 24 Imbued Dwarven Chain / Ogre War pages, the bow-string variants, the four
  // Holgresh Mojo Sticks, apostrophe spellings). `itemKey` is the app's join key everywhere —
  // loot lines, ownership, donors — so one key is one row, the item's own page preferred.
  assert.deepEqual(dupes, [], `duplicate gear rows: ${dupes.slice(0, 5).join(', ')}`)

  // Same corpus, same key function: every gear row must exist in the host-picker index too.
  const hosts = new Set(buildPlannerIndex(file).items.map((i) => i.key))
  const missing = rows.filter((r) => !hosts.has(r.key)).map((r) => r.key)
  assert.deepEqual(missing.slice(0, 5), [], `${missing.length} gear rows unknown to the item index`)
})

test('slots, classes and the search key are normalized at the boundary', () => {
  assert.deepEqual(index.stats.unknownSlotTokens, [], 'an unrecognized slot token drops items')
  for (const r of rows) {
    assert.ok(r.slots.length > 0, `${r.name} is a row with no slot`)
    for (const s of r.slots) assert.ok(EQUIP_SLOTS.includes(s), `${r.name}: bad slot ${s}`)
    for (const c of r.classes) assert.ok(isClassAbbr(c), `${r.name}: bad class ${c}`)
    assert.equal(r.searchKey, r.name.toLowerCase(), `${r.name}: stale search key`)
    assert.equal(r.key, r.name.replace(/ \+\d+$/, '').trim().toLowerCase())
  }
})

// =================================================================================
// THE NUMERIC VECTOR — the two items phase 0 is pinned on
// =================================================================================

const thelvorn = byKey.get('thelvorn, blade of light')
const crown = byKey.get('crown of king tranix')

test('Thelvorn and the Crown arrive as the numbers tests/itemUpgrade pins', () => {
  assert.ok(thelvorn && crown, 'both verification items must be in the corpus')
  // Thelvorn, Blade of Light — DMG 20, Atk Delay 26, WIS +15, WT 3.0 (itemUpgrade.test.mts).
  assert.deepEqual(thelvorn.stats, { WIS: 15, DMG: 20, DELAY: 26, WEIGHT: 3 })
  assert.deepEqual(thelvorn.slots, ['PRIMARY'])
  assert.deepEqual(thelvorn.classes, ['PAL'])
  assert.equal(thelvorn.skill, '1H Slashing')
  assert.equal(thelvorn.voidSynth, undefined, 'ONE scaling attribute — no SV VOID (phase 0)')
  assert.equal(gearRatio(thelvorn.stats)?.toFixed(2), '0.77')
  // The wiki spells a proc `Combat Effect:` (D2) — the gear row folds it exactly as a donor does.
  assert.equal(thelvorn.effects[0].name, 'Dismiss Summoned')
  assert.equal(thelvorn.effects[0].socket, 'proc')
  assert.equal(thelvorn.effects[0].tierRequired, 4)

  // Crown of King Tranix — AC 13, CHA +15, SV MAGIC +20, WT 1.0; two trigger fields, so it IS
  // the SV VOID case.
  assert.deepEqual(crown.stats, { AC: 13, CHA: 15, SV_MAGIC: 20, WEIGHT: 1 })
  assert.equal(crown.voidSynth, true)
  assert.deepEqual(crown.slots, ['HEAD'])
  assert.equal(crown.classes.length, 16, 'Class: ALL is all sixteen')
  assert.equal(crown.effects[0].socket, 'worn')
})

test('the owner screenshot reproduces THROUGH THE ROW, not just through the block', () => {
  assert.ok(thelvorn && crown)
  const s = scaleGearRow(thelvorn, CHECKPOINT).stats
  assert.equal(s.DMG, 25)
  assert.equal(s.WIS, 19) // floor(15 + round(4.125)), NOT 20
  assert.equal(s.WEIGHT, 2.3) // ceil-to-one-decimal of 2.2420…
  assert.equal(s.DELAY, 26) // delay never scales — which is why the ratio moves
  assert.equal(gearRatio(s)?.toFixed(2), '0.96')

  // The synthetic save is the one fact the vector cannot re-derive, so the row caches the answer.
  const c = scaleGearRow(crown, CHECKPOINT).stats
  assert.equal(c.SV_VOID, 2)
  assert.equal(c.AC, 17) // floor(13 + round(3.575))
  assert.equal(scaleGearRow(crown, { full: 0, fraction: 0 }).stats.SV_VOID, undefined)
})

// =================================================================================
// THE LOAD-BEARING ONE: scaling is a PURE MAP over the rows
// =================================================================================

/**
 * EVERY distinct page's stat block — the slow path's input, and the fast path's too.
 *
 * Deliberately keyed by PAGE and not joined back to a row: 70 item keys are written up on more
 * than one page (see the row-identity test), so pairing a row with "a" page would compare one
 * page's vector against another page's block. The equivalence under test is arithmetic — a vector
 * read out of a block scales the way the block does — and it holds per BLOCK, which is the
 * stronger statement and covers the 4,300 slotless pages as well.
 */
const blocks: { name: string; block: ItemStatBlock }[] = []
{
  const seenPages = new Set<string>()
  for (const entry of Object.values(file.items ?? {}) as ItemDbEntry[]) {
    if (seenPages.has(entry.page)) continue
    seenPages.add(entry.page)
    const k = knowledgeWithResearch(entry, ITEMS_RESEARCH)
    if (k.stats) blocks.push({ name: entry.page, block: k.stats })
  }
}

/** The same reading the builder does, applied to a SCALED block. */
const vectorOf = (block: ItemStatBlock): Record<string, number> =>
  readGearStats(block).stats as Record<string, number>

/**
 * ONE item at ONE state, both ways: the vector a row carries scaled by `scaleGearStats`, against
 * `scaleStatBlock` over the item's own block re-read into a vector. Returns the keys only the slow
 * path could produce, and counts the agreements.
 */
function compareOneBlock(
  name: string,
  block: ItemStatBlock,
  state: ItemUpgradeState,
  extraKeys: Set<string>
): number {
  const base = readGearStats(block).stats
  const fast = scaleGearStats(base, state, synthesizesVoidSave(block, { full: 1, fraction: 0 }))
  const slow = vectorOf(scaleStatBlock(block, state))
  let compared = 0
  for (const [key, value] of Object.entries(fast)) {
    assert.equal(value, slow[key], `${name} ${key} at +${state.full}.${state.fraction}`)
    compared++
  }
  // The slow path can read a key the fast one cannot: a value the BASE parse refused
  // ("15 and faction at Kindly") becomes a plain number once phase 0 re-renders it.
  for (const key of Object.keys(slow)) if (fast[key] === undefined) extraKeys.add(key)
  return compared
}

test('scaling a row is a PURE MAP that agrees with scaleStatBlock, corpus-wide', () => {
  assert.ok(blocks.length >= 11000, `only ${blocks.length} blocks re-derived`)
  const extraKeys = new Set<string>()
  let compared = 0
  for (const state of STATES) {
    for (const { name, block } of blocks) compared += compareOneBlock(name, block, state, extraKeys)
  }
  console.log('scaled-key comparisons', compared, 'slow-path-only keys', [...extraKeys])
  // Six keys across the whole corpus, every one of them a value the BASE parse refused — five on
  // equippable pages (the build's own `unreadableStatKeys` census) and CHA on a slotless one
  // ("CHA: 15 and faction at Kindly"). A key that appears here WITHOUT having been refused at
  // base would mean the two paths genuinely disagree about what an item states.
  const refusedAtBase = new Set<string>()
  for (const { block } of blocks) for (const k of Object.keys(readGearStats(block).unreadable)) refusedAtBase.add(k)
  for (const key of extraKeys) {
    assert.ok(refusedAtBase.has(key), `${key} appears only after scaling and was never refused at base`)
  }
  for (const key of Object.keys(index.stats.unreadableStatKeys)) assert.ok(refusedAtBase.has(key))
})

test('scaling all rows at one state is fast enough to move a slider', () => {
  // Warm, then measure — this is the cost of the global `+N` selector (JOS-284) and of every
  // re-sort under it. PRINTED because it is the number the design rests on; the assertion is a
  // loose ceiling so a loaded machine reports rather than flakes.
  scaleGearRow(rows[0], CHECKPOINT)
  const t0 = performance.now()
  const scaled = rows.map((r) => scaleGearRow(r, CHECKPOINT))
  const ms = performance.now() - t0
  console.log(`scaled ${scaled.length} rows in ${ms.toFixed(1)} ms`)
  assert.equal(scaled.length, rows.length)
  assert.ok(ms < 500, `scaling every row took ${ms.toFixed(1)} ms — the index is being rebuilt`)
  // A pure map: the base rows are untouched, so the next state starts from the same numbers.
  assert.deepEqual(thelvorn?.stats, { WIS: 15, DMG: 20, DELAY: 26, WEIGHT: 3 })
})

// =================================================================================
// THE CENSUSES — law 1 lives here rather than on the rows
// =================================================================================

test('the unindexed stat keys are exactly the five the corpus states', () => {
  // CHARGES / COOLDOWN / CAST TIME / REQUIRED LEVEL are per-item facts, not gear comparisons
  // (shared/planner/gear.ts says why they are out of the vector). A key here that is NOT one of
  // those is a stat the gear table would silently not have a column for.
  //
  // `REQ_LEVEL` is the fifth, and it arrived with the 2026-08-13 refresh: 8 pages now abbreviate
  // the required level that 5 others still spell out. It is the SAME per-item fact under a second
  // spelling, so nothing on screen changes — both are outside the vector either way — and the
  // census is updated rather than the alias table, because splitting one fact across two keys is
  // the wiki's editing, not ours to canonicalize (law 2 canonicalizes at boundaries we own).
  // This assertion is an EQUALITY on purpose: the sixth spelling should stop the suite too.
  assert.deepEqual(Object.keys(index.stats.unindexedStatKeys).sort(), [
    'CAST_TIME',
    'CHARGES',
    'COOLDOWN',
    'REQUIRED_LEVEL',
    'REQ_LEVEL'
  ])
})

// ---- the weapon skill vocabulary (JOS-302) ----------------------------------------------------
//
// THE FILTER RESTS ON A FIELD NOBODY HAD HAD TO COMPARE BEFORE. `GearRow.skill` has carried the
// wiki's `Skill:` line verbatim since phase 2, but nothing read it until the owner asked to search
// by weapon type — and a verbatim field is only a filter once something folds its spellings
// together (`shared/planner/weaponType.ts`). These two tests are the honesty half of that fold:
// what the corpus states, measured here where the bytes are, rather than remembered in the module.

test('every weapon skill the corpus states folds to a type - and the exceptions are named', () => {
  const spellings = new Map<string, number>()
  for (const r of rows) {
    if (r.skill === undefined) continue
    spellings.set(r.skill, (spellings.get(r.skill) ?? 0) + 1)
  }
  const unmapped = [...spellings].filter(([s]) => weaponTypeOf(s) === null).map(([s, n]) => `${s} (${String(n)})`)
  console.log('weapon skills', Object.fromEntries([...spellings].sort((a, b) => b[1] - a[1])))

  // AN EQUALITY, exactly like `unindexedStatKeys` above and for exactly the same reason: a rescrape
  // that spells a skill a new way is a whole class of weapon quietly leaving the type filter, and
  // it should stop the suite instead. `SHIELD` names no weapon skill at all — two pages state it
  // (Crushbone Fetish, and since the 2026-08-22 rescrape Efreeti War Shield in Title Case), both
  // SECONDARY with no DMG and no delay — they are not weapons, and the fold answers `null` rather
  // than inventing a tenth type for them.
  assert.deepEqual(unmapped, ['SHIELD (1)', 'Shield (1)'])
})

test('the weapon type census is deep enough for the filter to be worth having', () => {
  const byType = new Map<WeaponType, number>()
  for (const r of rows) {
    const type = weaponTypeOf(r.skill)
    if (type !== null) byType.set(type, (byType.get(type) ?? 0) + 1)
  }
  console.log('weapon types', Object.fromEntries([...byType].sort((a, b) => b[1] - a[1])))

  // FLOORS, under the 2026-08-13 build (1HS 415 · 1HP 324 · 1HB 321 · 2HS 223 · 2HB 195 ·
  // ARCHERY 63 · THROWING 37 · 2HP 24 · H2H 11), so a growing corpus stays green. Every one of the
  // nine is asserted PRESENT: a type with no rows behind it is an option in the picker that can
  // only ever empty the table.
  for (const type of WEAPON_TYPES) {
    assert.ok((byType.get(type) ?? 0) > 0, `no row in the corpus folds to ${type}`)
  }
  assert.ok((byType.get('1HS') ?? 0) >= 400, `only ${String(byType.get('1HS'))} 1H slashers`)
  assert.ok((byType.get('1HP') ?? 0) >= 300, `only ${String(byType.get('1HP'))} piercers`)
  assert.ok((byType.get('2HS') ?? 0) >= 200, `only ${String(byType.get('2HS'))} 2H slashers`)

  // THE CATEGORIES ARE UNIONS, over the REAL rows and not just over the vocabulary: picking
  // "one-handed" must select exactly the rows its four member types select, and the three
  // categories together must select every weapon row and nothing else.
  const matched = (picks: WeaponPick[]): number => rows.filter((r) => weaponPicksMatch(r.skill, picks)).length
  assert.equal(matched(['ONE_HAND']), matched(['1HS', '1HB', '1HP', 'H2H']))
  assert.equal(matched(['TWO_HAND']), matched(['2HS', '2HB', '2HP']))
  assert.equal(matched(['RANGED']), matched(['ARCHERY', 'THROWING']))
  assert.equal(
    matched(['ONE_HAND', 'TWO_HAND', 'RANGED']),
    rows.filter((r) => weaponTypeOf(r.skill) !== null).length,
    'the three categories cover every weapon the fold recognizes'
  )
  // …and a pick list is a NARROWING: nothing that is not a weapon survives one.
  assert.ok(rows.some((r) => r.skill === undefined), 'the corpus is mostly armour')
  assert.ok(matched([]) > matched(['ONE_HAND', 'TWO_HAND', 'RANGED']), 'no pick is not a filter')
})

test('HASTE is the only key that ever states a percent', () => {
  const percentKeys = new Set<string>()
  for (const { block } of blocks) {
    for (const s of [...block.stats, ...block.saves]) {
      const key = normalizeStatKey(s.key)
      if (isGearStatKey(key) && gearStatNumber(s.value) !== null && !/^[+-]?\d+$/.test(s.value.trim())) {
        percentKeys.add(key)
      }
    }
  }
  assert.deepEqual([...percentKeys], [...GEAR_PERCENT_STAT_KEYS])
  assert.ok(index.stats.percentValues >= 60, `only ${index.stats.percentValues} percent values`)
})

test('the number parsers refuse what they should and take what they must', () => {
  assert.equal(gearStatNumber('+9'), 9)
  assert.equal(gearStatNumber('10'), 10)
  assert.equal(gearStatNumber('-5'), -5)
  assert.equal(gearStatNumber('+41%'), 41) // the one widening: a whole-value percent (HASTE)
  assert.equal(gearStatNumber('15 and faction at Kindly'), null) // never a partial read
  assert.equal(gearStatNumber('Unlimited'), null)
  // WT is the exception, and deliberately so: phase 0's own `scaleWeightText` reads the LEADING
  // number of "0.1 Weight Reduction: 20%", so this must too or the scaler and the vector disagree.
  assert.equal(gearWeightNumber('2.5'), 2.5)
  assert.equal(gearWeightNumber('0.1 Weight Reduction: 20%'), 0.1)
  assert.equal(gearWeightNumber('?'), null)
})

test('a range the corpus states as a triple is kept as TEXT, never as its first third', () => {
  const triples = rows.filter((r) => r.rangeText !== undefined)
  assert.ok(triples.length >= 25, `only ${triples.length} range texts`)
  for (const r of triples) {
    assert.match(r.rangeText ?? '', /\//)
    assert.equal(r.stats.RANGE, undefined, `${r.name} states a range triple AND a number`)
  }
  // …and the single-number ranges DID make it into the vector.
  assert.ok(rows.some((r) => r.stats.RANGE !== undefined), 'no row carries a numeric range')
})

// =================================================================================
// EFFECTS — the same reading the donor index makes
// =================================================================================

/**
 * The item keys more than one equippable PAGE claims — where a row is one page's answer and the
 * donor index is every page's. Derived here rather than assumed, so the divergence documented in
 * the test below stays measured.
 */
const collidedKeys = ((): Set<string> => {
  const pagesPerKey = new Map<string, number>()
  const seen = new Set<string>()
  for (const entry of Object.values(file.items ?? {}) as ItemDbEntry[]) {
    if (seen.has(entry.page)) continue
    seen.add(entry.page)
    const k = knowledgeWithResearch(entry, ITEMS_RESEARCH)
    const key = k.name.replace(/ \+\d+$/, '').trim().toLowerCase()
    if (!byKey.has(key)) continue
    pagesPerKey.set(key, (pagesPerKey.get(key) ?? 0) + 1)
  }
  return new Set([...pagesPerKey].filter(([, n]) => n > 1).map(([k]) => k))
})()

test('every donor row is reproduced on its gear row, socket and tier included', () => {
  const donors = buildPlannerIndex(file).donors.filter((d) => d.slots.length > 0)
  assert.ok(donors.length > 1000, `only ${donors.length} slotted donors to check against`)
  let checked = 0
  for (const d of donors) {
    const row = byKey.get(d.key)
    // Summoned/GM items are the donor index's business, not the gear index's; a collided key is
    // the case the next test owns.
    if (!row || collidedKeys.has(d.key)) continue
    const hit = row.effects.find((e) => e.name === d.effect && e.socket === d.socket)
    assert.ok(hit, `${d.name}: gear row does not carry donor effect ${d.effect} (${d.socket})`)
    assert.equal(hit.tierRequired, d.tierRequired)
    assert.equal(hit.hasteLocked ?? false, d.hasteLocked)
    assert.equal(hit.family, d.family)
    assert.equal(hit.spellDuration, d.spellDuration)
    checked++
  }
  console.log('donor effects re-checked on gear rows', checked)
  assert.ok(checked > 1000)
})

test('a key two pages claim is ONE row — the item as the game names it', () => {
  // 70 keys, 95 extra pages: deity variants (Imbued Dwarven Chain (Brell Serilis) beside
  // (Bristlebane)), bow-string materials (Linen/Hemp/Silk), the four elemental Holgresh Mojo
  // Sticks, apostrophe spellings. The game prints ONE name for each, `itemKey` is what every
  // other index joins on (loot, ownership, donors), and two rows a user cannot tell apart would
  // break the phase-4 ownership join — so the item's own page wins and the variants collapse.
  //
  // THE PRICED COST, stated rather than hidden: a variant's EFFECTS are not on the row. The
  // donor index denormalizes by (key, effect, socket) and so lists all four Holgresh clicks under
  // one key; the gear row carries the canonical page's. Stats could never be merged (the
  // variants disagree), and half-merging would be a row claiming a combination no item has.
  //
  // THE FLOOR MOVED DOWN with the 2026-08-13 refresh, 70 keys -> 49, and DOWN is the good
  // direction: the wiki spent the week disambiguating page titles the fold used to collapse (the
  // Teir`Dal Adamantite set dropped its `(Imbued)` suffix; the Imbued Ogre War pages stopped
  // claiming the unsuffixed key through `|itemname`). Fewer collisions is fewer items whose
  // effects the row cannot carry. The floor sits under the new measurement, so the wiki finishing
  // the job does not turn this red — the two named keys below are what actually holds the shape.
  assert.ok(collidedKeys.size >= 40, `only ${collidedKeys.size} collided keys`)
  assert.ok(collidedKeys.has('holgresh mojo stick'))
  assert.ok(collidedKeys.has('imbued dwarven chain boots'))
  for (const key of collidedKeys) assert.ok(byKey.has(key), `${key} collapsed into nothing`)
})

test('a socketless `Effect:` line is KEPT on a gear row (the donor index drops it)', () => {
  const socketless = rows.flatMap((r) => r.effects.filter((e) => e.socket === undefined))
  assert.equal(socketless.length, index.stats.socketless)
  assert.ok(socketless.length > 0, 'the corpus states bare `Effect:` lines — they are not dropped')
  for (const e of socketless) assert.equal(e.tierRequired, undefined)
})

// =================================================================================
// THE PAYLOAD
// =================================================================================

// ---- the era filter, over the shipped rows and the shipped verdict (JOS-298) --------------------
//
// THE OWNER REPORT this test exists for, verbatim in JOS-298: "Breastplate of the Righteous tops
// the breastplate AC list as in-era while its wiki page carries out-of-era markers all over."
// Sorting CHEST by AC is the first thing anyone does in this tab, and the top of that list was
// four rows of armour from a revamp this server has not run. So the assertion is the screen: the
// rows the Gear tab actually surfaces, in the order it surfaces them, through the renderer's own
// `eraHides` rather than a re-derivation of it.
//
// `eraHides` reaches the mob catalog and React; both import fine under the node runner (the
// `plannerFarm` precedent), and nothing here mounts anything.

test('CHEST by AC surfaces no wiki-badged out-of-era row (the JOS-298 report, as a list)', () => {
  const ac = (r: GearRow): number => r.stats.AC ?? 0
  const chest = rows.filter((r) => r.slots.includes('CHEST') && ac(r) > 0).sort((a, b) => ac(b) - ac(a))
  assert.ok(chest.length >= 200, `only ${String(chest.length)} AC-bearing chest rows`)

  const visible = chest.filter((r) => !eraHides(r, true))
  assert.ok(visible.length >= 50, `only ${String(visible.length)} chest rows survive the era filter`)

  // THE PROPERTY, over the whole visible list and not just its head: nothing the wiki badges
  // `Out of Era` may be on screen while the filter is on. One assertion, and it names the row.
  for (const row of visible) {
    assert.notEqual(
      row.eraTag === undefined ? 'in' : eraBadge(row.eraTag),
      'out',
      `${row.name} (AC ${String(ac(row))}) is badged ${String(row.eraTag)} and still visible`
    )
  }

  // AND THE REPORTED ROWS ARE GONE FROM IT BY NAME. Before this wave these were, in order, #1, #2,
  // #4 and #7 of the visible list; the two below them were untagged rows that stayed.
  for (const name of [
    'Breastplate of the Righteous',
    'Breastplate of the Untamed',
    'Legionnaire Scale Breastplate',
    'Greenmist Breastplate'
  ]) {
    const row = chest.find((r) => r.name === name)
    assert.ok(row, `${name} left the gear index`)
    assert.equal(row.eraTag, 'FearHateRevamp', name)
    assert.equal(eraHides(row, true), true, `${name} is still visible with the era filter on`)
    // …and it is still THERE with the filter off, chip and all. Hiding is a filter, not a delete.
    assert.equal(eraHides(row, false), false, `${name} vanished with the era filter OFF`)
  }

  // The filter still leaves a usable table: the best chest a classic-era player can actually farm
  // is a real row with real AC, not an empty list (the JOS-67 law — an empty table is a bug too).
  assert.ok(ac(visible[0]) >= 25, `top visible chest is only AC ${String(ac(visible[0]))}`)
})

test('the era chip names the BANNER when the banner is what decided (never the drop zone)', () => {
  // The chip is the other half of the fix: a row hidden by its badge must not, with the filter
  // off, wear a chip reading "Classic" because its drop zone happened to be one. That was the
  // loudest possible restatement of the bug.
  const bp = byKey.get('breastplate of the righteous')
  assert.ok(bp, 'Breastplate of the Righteous left the gear index')
  const chip = eraChip(bp)
  assert.ok(chip, 'an out-of-era row must carry a chip')
  assert.equal(chip.unknown, false)
  assert.equal(chip.label, 'out of era', 'FearHateRevamp names no expansion, so the chip must not name one')
  assert.match(chip.tooltip, /FearHateRevamp/, 'the tooltip must quote the banner token')
  assert.doesNotMatch(chip.tooltip, /sources are in/, 'the zone did not decide and must not be cited')

  // An ordinary Velious row still reads as Velious — the chip only loses its expansion name when
  // the token genuinely has none.
  const velious = rows.find((r) => r.eraTag === 'Velious' && eraHides(r, true))
  assert.ok(velious, 'no Velious-bannered row is hidden — the corpus changed shape')
  assert.equal(eraChip(velious)?.label, 'Velious')
})

test('the payload states its version and the corpus it was built from', () => {
  assert.equal(index.version, GEAR_INDEX_VERSION)
  assert.equal(index.scrapedAt, file.scrapedAt)
  // Survives the IPC hop: structured clone drops nothing a JSON round trip would.
  const wire = JSON.parse(JSON.stringify(index)) as typeof index
  assert.equal(wire.rows.length, rows.length)
  assert.deepEqual(wire.rows[0], rows[0])
  // The vocabulary is closed, and a scaled vector may only ever speak it.
  const keys = new Set<string>(GEAR_STAT_KEYS)
  for (const r of rows) for (const k of Object.keys(r.stats)) assert.ok(keys.has(k), `stray key ${k}`)
})
