// THE WORN FOCUS IN THE READOUT (JOS-452) — pinned twice, the way tests/bestSpellsAoe.test.mts is:
//   1. the RULES over hand-built data — which side a focus lifts, which tab's marker says so, and
//      the two compatibility properties (no focus set, and a focus nothing qualifies for);
//   2. the OWNER'S ACCEPTANCE over the REAL committed corpus — his own Improved Damage II, his own
//      wizard nuke, and a spell above the focus's level cap reading lower in the same table.
//
// The focus arithmetic itself is `tests/wornFocus.test.mts`'s, including the log measurement behind
// it. What this file pins is the SEAM: that a resolved percentage reaches the figures, reaches them
// on the right side, and is stated on the tab it was used in.
//
// No Electron, no network, no live log — this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ClassAbbr, ComboInterval, ComboSlot } from '../src/shared/classCombo'
import { bestSpellsAt, defaultSorts, type BestSpellRow, type BestSpellsView } from '../src/shared/bestSpells'
import { comboClassesOf, type LevelUnlockData } from '../src/shared/levelUnlocks'
import { buildLevelUnlocks } from '../src/main/data/levelUnlocks'
import { parseWornFocus, type WornFocus } from '../src/shared/wornFocus'

// ---- fixtures ---------------------------------------------------------------------------

const slot = (candidates: ClassAbbr[]): ComboSlot => ({
  candidates,
  confidence: 1,
  provenance: 'inferred',
  because: []
})

function interval(slots: ComboSlot[]): ComboInterval {
  return {
    id: 'ci0',
    startTs: 0,
    endTs: null,
    startLo: 0,
    startHi: 0,
    endLo: null,
    endHi: null,
    startReason: 'logStart',
    expectedSlots: slots.length,
    slots,
    levelLo: null,
    levelHi: null,
    evidenceCount: slots.length,
    userLocked: false
  }
}

const comboOf = (classes: ClassAbbr[]): ReturnType<typeof comboClassesOf> =>
  comboClassesOf(interval(classes.map((c) => slot([c]))))

/** The two focus records this file drives, spelled the way the committed spell pages spell them. */
function focus(effect: string, item: string, lines: string[]): WornFocus {
  const parsed = parseWornFocus(effect, item, lines)
  assert.ok(parsed, effect)
  return parsed
}

const IMPROVED_DAMAGE_II = focus('Improved Damage II', 'Polished Mithril Mask (Exaltation)', [
  'Increase Spell Damage by 1% to 20%',
  'Limit Max Level: 44 (lose 5% per level after)',
  'Limit Effect: Current HP',
  'Limit Max Duration: 0s',
  'Limit Type: Detrimental',
  'Limit Target: Exclude Target AE'
])

const IMPROVED_HEALING_III = focus('Improved Healing III', 'Idol of the Underking', [
  'Increase Healing by 1% to 20%',
  'Limit Max Level: 60 (lose 5% per level after)',
  'Limit Max Duration: 0s',
  'Limit Type: Beneficial'
])

/**
 * Three spells, one per question: a nuke the damage focus lifts, a heal the healing focus lifts,
 * and a DoT that neither can touch (`Limit Max Duration: 0s`).
 *
 * Round magnitudes and timings so the arithmetic reads off the page: 1,000 damage at 100 mana in a
 * 1s cast means a base row of `dmg 1000 · dps 1000 · 10 dmg/mana`, and 10.5% of it is 1105.
 */
const DATA: LevelUnlockData = {
  spells: [
    {
      name: 'Test Nuke',
      at: [{ cls: 'WIZ', level: 20 }],
      mana: 100,
      castTimeMs: 1000,
      recastMs: 0,
      targetType: 'Single',
      spellType: 'Detrimental',
      hpLines: ['Decrease Hitpoints by 1000']
    },
    {
      name: 'Test Heal',
      at: [{ cls: 'WIZ', level: 20 }],
      mana: 100,
      castTimeMs: 1000,
      recastMs: 0,
      targetType: 'Single',
      spellType: 'Beneficial',
      hpLines: ['Increase Hitpoints by 1000']
    },
    {
      name: 'Test DoT',
      at: [{ cls: 'WIZ', level: 20 }],
      mana: 100,
      castTimeMs: 1000,
      recastMs: 0,
      targetType: 'Single',
      spellType: 'Detrimental',
      durationMs: 60_000,
      hpLines: ['Decrease Hitpoints by 100 per tick']
    }
  ],
  skills: [],
  discs: [],
  innates: []
}

const WIZ = comboOf(['WIZ'])
const view = (worn: readonly WornFocus[]): BestSpellsView => ({ sorts: defaultSorts(), focus: worn })

const rowOf = (rows: readonly BestSpellRow[], name: string): BestSpellRow => {
  const row = rows.find((r) => r.name === name)
  assert.ok(row, `${name} is not in this table`)
  return row
}

// ---- 1: the rules ------------------------------------------------------------------------

test('NO FOCUS SET IS THE BASE READING, figure for figure', () => {
  const bare = bestSpellsAt(DATA, WIZ, 30, { sorts: defaultSorts() })
  const empty = bestSpellsAt(DATA, WIZ, 30, view([]))
  assert.deepEqual(empty.tabs.dd.shown, bare.tabs.dd.shown)
  assert.equal(bare.tabs.dd.wornFocus, null, 'and no tab says anything about gear')
  assert.equal(rowOf(bare.tabs.dd.shown, 'Test Nuke').metrics.damage, 1000)
  assert.equal(rowOf(bare.tabs.dd.shown, 'Test Nuke').focus, undefined)
})

test('a damage focus lifts the DD figures and names the item that did it', () => {
  const best = bestSpellsAt(DATA, WIZ, 30, view([IMPROVED_DAMAGE_II]))
  const nuke = rowOf(best.tabs.dd.shown, 'Test Nuke')
  // 10.5% is the middle of the 1..20 band; the focus rolls, and wornFocus.ts's header says why the
  // middle rather than the top is what a comparison readout prints.
  assert.equal(nuke.metrics.damage, 1105)
  assert.equal(nuke.metrics.dps, 1105, 'the per-second figure moves with the total')
  assert.equal(nuke.metrics.damagePerMana, 11.1, 'and so does the per-mana ratio')
  assert.deepEqual(nuke.focus, [
    { side: 'damage', pct: 10.5, effect: 'Improved Damage II', item: 'Polished Mithril Mask (Exaltation)' }
  ])
})

test('THE MARKER IS PER TAB, and a tab whose rows were not focused says nothing', () => {
  const best = bestSpellsAt(DATA, WIZ, 30, view([IMPROVED_DAMAGE_II]))
  assert.equal(best.tabs.dd.wornFocus, 'worn +11%')
  // The DoT tab holds `Test DoT`, which `Limit Max Duration: 0s` refuses - so its figures are base
  // and its caption must not borrow the DD tab's number.
  assert.equal(rowOf(best.tabs.dot.shown, 'Test DoT').metrics.damage, 1000)
  assert.equal(best.tabs.dot.wornFocus, null)
  // And the healing tab is untouched by a DAMAGE focus, both in figures and in words.
  assert.equal(rowOf(best.tabs.heal.shown, 'Test Heal').metrics.heal, 1000)
  assert.equal(best.tabs.heal.wornFocus, null)
})

test('the two sides are resolved separately, and one spell can wear both', () => {
  const best = bestSpellsAt(DATA, WIZ, 30, view([IMPROVED_DAMAGE_II, IMPROVED_HEALING_III]))
  assert.equal(rowOf(best.tabs.dd.shown, 'Test Nuke').metrics.damage, 1105)
  assert.equal(rowOf(best.tabs.heal.shown, 'Test Heal').metrics.heal, 1105)
  assert.equal(best.tabs.dd.wornFocus, 'worn +11%')
  assert.equal(best.tabs.heal.wornFocus, 'worn +11%')
})

test('THE LEVEL RANGE IS THE SPELL`S GAIN LEVEL, not the level being viewed', () => {
  // The nuke is gained at 20 and the cap is 44, so the focus is at full strength however high the
  // reader steps the panel. A cap that moved with the VIEWED level would fade this row at 65.
  for (const level of [20, 44, 50, 65]) {
    const best = bestSpellsAt(DATA, WIZ, level, view([IMPROVED_DAMAGE_II]))
    assert.equal(rowOf(best.tabs.dd.shown, 'Test Nuke').metrics.damage, 1105, `viewed at ${String(level)}`)
  }
  // A spell GAINED above the cap is the case that decays: same corpus, one spell moved to 54.
  const late: LevelUnlockData = {
    ...DATA,
    spells: DATA.spells.map((s) => (s.name === 'Test Nuke' ? { ...s, at: [{ cls: 'WIZ' as const, level: 54 }] } : s))
  }
  const best = bestSpellsAt(late, WIZ, 60, view([IMPROVED_DAMAGE_II]))
  // Ten levels over the cap keeps half of 10.5%, which is 5.25%.
  assert.equal(rowOf(best.tabs.dd.shown, 'Test Nuke').metrics.damage, 1052.5)
  assert.equal(best.tabs.dd.wornFocus, 'worn +5%')
})

test('a mixed table is captioned with the RANGE it really used', () => {
  const mixed: LevelUnlockData = {
    ...DATA,
    spells: [
      ...DATA.spells,
      {
        ...DATA.spells[0],
        name: 'Test Late Nuke',
        at: [{ cls: 'WIZ', level: 54 }]
      }
    ]
  }
  const best = bestSpellsAt(mixed, WIZ, 60, view([IMPROVED_DAMAGE_II]))
  assert.equal(best.tabs.dd.wornFocus, 'worn +5% to +11%')
})

test('the AOE reading gets no damage focus, because the focus page excludes area spells', () => {
  const area: LevelUnlockData = {
    ...DATA,
    spells: [{ ...DATA.spells[0], name: 'Test AE', targetType: 'Targeted AE' }]
  }
  const best = bestSpellsAt(area, WIZ, 30, view([IMPROVED_DAMAGE_II]))
  // Present in both tabs, focused in neither: `Limit Target: Exclude Target AE`.
  assert.equal(rowOf(best.tabs.dd.shown, 'Test AE').metrics.damage, 1000)
  assert.equal(rowOf(best.tabs.aoe.shown, 'Test AE').metrics.damage, 4000, 'four targets, no focus')
  assert.equal(best.tabs.aoe.wornFocus, null)
})

// ---- 2: the owner's acceptance over the real corpus ---------------------------------------

const REAL = buildLevelUnlocks(null)

test('acceptance: the owner`s wizard nuke wears his Improved Damage II, and the tab says so', () => {
  // `Garrison's Mighty Mana Shock` is his own L18 nuke, read at 35 where its ramp has capped at 333.
  const bare = bestSpellsAt(REAL, WIZ, 35, { sorts: defaultSorts() })
  const worn = bestSpellsAt(REAL, WIZ, 35, view([IMPROVED_DAMAGE_II]))
  const before = rowOf(bare.tabs.dd.shown, "Garrison's Mighty Mana Shock")
  const after = rowOf(worn.tabs.dd.shown, "Garrison's Mighty Mana Shock")
  assert.equal(before.metrics.damage, 333, 'the base figure this app has always printed')
  assert.equal(after.metrics.damage, 368, '333 with the middle of a 1..20 band on it')
  assert.equal(after.focus?.[0].item, 'Polished Mithril Mask (Exaltation)', 'and the card can name it')
  assert.ok(worn.tabs.dd.wornFocus?.startsWith('worn +'), worn.tabs.dd.wornFocus ?? 'no marker')
})

test('acceptance: one table, three states - full focus, a faded one, and none at all', () => {
  // A TIER-I focus is what makes the third state reachable over the real corpus: `Improved Damage
  // II` caps at 44 and the highest level any wizard spell here is gained at is 60, which is inside
  // its twenty-level decay window. `Improved Damage I` caps at 20, so everything from 40 up is past
  // it - and that is exactly the reader this feature is for, somebody levelling with early gear.
  const tierOne = focus('Improved Damage I', 'a tier one item', [
    'Increase Spell Damage by 1% to 20%',
    'Limit Max Level: 20 (lose 5% per level after)',
    'Limit Effect: Current HP',
    'Limit Max Duration: 0s',
    'Limit Type: Detrimental',
    'Limit Target: Exclude Target AE'
  ])
  const bare = bestSpellsAt(REAL, WIZ, 60, { sorts: defaultSorts() })
  const worn = bestSpellsAt(REAL, WIZ, 60, view([tierOne]))
  //
  // A row with NO focus is not automatically a decayed one - the DD tab also holds rains, which
  // `Limit Target: Exclude Target AE` refuses at every level (Lava Storm at 32 is the worked
  // example). So the level rule is asserted where it is decidable: EVERY focused row must carry
  // exactly the percentage the decay predicts, NO row past the window may carry one at all, and an
  // unfocused row in between is left alone because this table cannot say which limit refused it.
  let full = 0
  let faded = 0
  let none = 0
  for (const row of worn.tabs.dd.shown) {
    const base = rowOf(bare.tabs.dd.shown, row.name).metrics.damage ?? 0
    const pct = row.focus?.[0].pct
    if (pct === undefined) {
      assert.equal(row.metrics.damage, base, `${row.name} was not focused and must read its base`)
      if (row.gainedAt >= 40) none++
      continue
    }
    assert.ok(row.gainedAt < 40, `${row.name} at L${String(row.gainedAt)} is past the decay window`)
    const expected = 10.5 * (row.gainedAt <= 20 ? 1 : (100 - 5 * (row.gainedAt - 20)) / 100)
    assert.equal(pct, expected, `${row.name} at L${String(row.gainedAt)}`)
    assert.ok(row.metrics.damage! > base, `${row.name} was focused and must read above its base`)
    if (row.gainedAt <= 20) full++
    else faded++
  }
  assert.ok(full > 0 && faded > 0 && none > 0, `full ${String(full)} faded ${String(faded)} none ${String(none)}`)
  // The marker states the RANGE the table really spans, low end first.
  assert.match(worn.tabs.dd.wornFocus ?? '', /^worn \+\d+% to \+11%$/)
})
