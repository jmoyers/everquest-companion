// THE HASTE YOU WEAR (fork ruling, kaltinril 2026-08-25: haste should only be EQUIPPED items).
//
// `equippedHaste` (src/renderer/src/features/gear/gearOwnership.ts) is what feeds the Gear tab's
// worn-haste ceiling: the best haste stated by a row whose dump place is EQUIPPED, read at that
// copy's ` +N`. Bank and bag copies count for nothing, a worn item stating no haste counts for
// nothing, and a name the corpus does not know counts for nothing (law 1: the wiki did not say).
//
// This suite used to live in tests/gearOwnership.test.mts, which main retired with the TypeScript
// fold (JOS-499); the ownership join itself survived, so its haste read keeps its pin here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { OwnershipEntry, OwnershipRow } from '../src/shared/planner/ownership'
import type { GearRow } from '../src/shared/planner/gear'
import { equippedHaste } from '../src/renderer/src/features/gear/gearOwnership'
import { scaleGearStat } from '../src/shared/planner/gearScale'
import { upgradeStateForTier } from '../src/shared/itemUpgrade'

/** One ownership row, with only the fields the join reads spelled out. */
function row(over: Partial<OwnershipRow> & Pick<OwnershipRow, 'key' | 'place'>): OwnershipRow {
  return {
    name: over.key,
    rawName: over.key,
    location: '',
    count: 1,
    section: 'Location',
    exaltation: false,
    containment: 'top',
    itemId: 0,
    line: 1,
    ...over
  }
}

/** A gear candidate row — only `key` and `name` matter to a join keyed on `key`. */
function gear(key: string): GearRow {
  return {
    key,
    name: key,
    searchKey: key,
    slots: [],
    classes: [],
    races: ['ALL'],
    flags: [],
    quest: false,
    playerCrafted: false,
    stats: {},
    effects: []
  }
}

const CLOAK = 'cloak of flames'

test('equippedHaste is the best haste on an EQUIPPED row, scaled to its +N - bank and bag haste count for nothing', () => {
  const SWORD = 'swiftblade'
  const GLOVE = 'quick gloves'
  const byKey = new Map<string, GearRow>([
    [SWORD, { ...gear(SWORD), stats: { HASTE: 36 } }],
    [GLOVE, { ...gear(GLOVE), stats: { HASTE: 21 } }],
    [CLOAK, { ...gear(CLOAK), stats: { AC: 10 } }]
  ])
  const entries = (rows: OwnershipRow[]): OwnershipEntry[] => {
    const out = new Map<string, OwnershipRow[]>()
    for (const r of rows) out.set(r.key, [...(out.get(r.key) ?? []), r])
    return [...out]
  }
  // Nothing worn - a 36% sword in the BANK is worn by nobody.
  assert.equal(equippedHaste([], byKey), 0)
  assert.equal(equippedHaste(entries([row({ key: SWORD, place: 'bank' })]), byKey), 0, 'bank haste is not worn')
  assert.equal(equippedHaste(entries([row({ key: SWORD, place: 'inventory' })]), byKey), 0, 'bag haste is not worn')
  // Worn: the stated number, and the BEST of several.
  assert.equal(equippedHaste(entries([row({ key: GLOVE, place: 'equipped' })]), byKey), 21)
  assert.equal(
    equippedHaste(entries([row({ key: GLOVE, place: 'equipped' }), row({ key: SWORD, place: 'equipped' })]), byKey),
    36,
    'two worn haste items: the best one is the one that applies (worn haste does not stack)'
  )
  // A worn ` +N` reads at its tier (the flat rule, the compare card's own floor), never at base.
  const plussed = equippedHaste(entries([row({ key: SWORD, place: 'equipped', tier: 3 })]), byKey)
  assert.equal(plussed, scaleGearStat('HASTE', 36, upgradeStateForTier(3)))
  assert.ok(plussed > 36)
  // A worn item stating no haste, or one the corpus does not know, contributes nothing (law 1).
  assert.equal(equippedHaste(entries([row({ key: CLOAK, place: 'equipped' })]), byKey), 0)
  assert.equal(equippedHaste(entries([row({ key: 'unknown thing', place: 'equipped' })]), byKey), 0)
})
