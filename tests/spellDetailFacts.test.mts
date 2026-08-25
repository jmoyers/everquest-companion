// THE RICH SPELL CARD STATES ONLY WHAT A SOURCE STATES (JOS-293) — the fact selection behind
// src/renderer/src/lib/SpellCard.tsx, and the rank lineage behind its "replaces" line.
//
// TWO CLAIMS, and both are about ABSENCE as much as presence:
//
//   1. `spellStatRows` draws a row if and only if the committed DB stated the field behind it. A
//      wiki page that omits mana yields no mana row - not a `0`, not a `-`. The counter-case is
//      just as load-bearing: `mana: 0` is a STATED zero (every bard song states it) and must draw
//      one, which is why the selection tests `!== undefined` and not truthiness.
//   2. `buildSpellDetail`'s lineage names a rank only when a source NAMES it. The committed DB
//      carries rank siblings for 72 of its ~1,800 lines; the log names every rank you have cast.
//      There is deliberately no "rank 3 of 5" anywhere in this file, because no source in this
//      repo states how many ranks a line has and a denominator would be invented.
//
// It runs against the REAL committed DB (`loadSpellDb`), not a fixture literal, so a re-scrape
// that drops a field this card leans on fails here rather than in front of a user. The three
// spells it pins by name are chosen for what they are missing as much as for what they state.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSpellDb } from '../src/main/data/spellDb'
import { buildSpellDetail } from '../src/main/data/spellDetail'
import { spellMetricsAt } from '../src/shared/spellMetrics'
import {
  spellClassLine,
  spellEffectClassLabels,
  spellFactsAreForLine,
  spellFocusLines,
  spellLineageLine,
  spellLineageMembers,
  spellStatRows,
  type SpellDetail
} from '../src/shared/spellDetail'
import { parseWornFocus, type WornFocus } from '../src/shared/wornFocus'

const db = loadSpellDb()

/** A record with nothing stated at all - the shape every "absent" assertion is written against. */
function bare(over: Partial<SpellDetail> = {}): SpellDetail {
  return {
    queried: 'Nothing',
    found: true,
    nature: 'unknown',
    illusion: false,
    classLevels: [],
    effectClasses: [],
    lineage: null,
    ...over
  }
}

const idsOf = (d: SpellDetail): string[] => spellStatRows(d).map((r) => r.id)

// ─────────────────────────── 1. states only what is stated ───────────────────────────────────

test('D1 a record that states nothing draws no stat rows at all', () => {
  assert.deepEqual(spellStatRows(bare()), [])
  assert.equal(spellClassLine(bare()), null)
  assert.deepEqual(spellEffectClassLabels(bare()), [])
  assert.equal(spellLineageLine(bare()), null)
  assert.deepEqual(spellLineageMembers(bare()), [])
})

test('D2 each stat row appears exactly when its own field is stated', () => {
  assert.deepEqual(idsOf(bare({ spellType: 'Beneficial' })), ['type'])
  assert.deepEqual(idsOf(bare({ targetType: 'Single Hostile' })), ['target'])
  assert.deepEqual(idsOf(bare({ castTimeMs: 4000 })), ['cast'])
  assert.deepEqual(idsOf(bare({ recastMs: 6000 })), ['recast'])
  assert.deepEqual(idsOf(bare({ mana: 75 })), ['mana'])
  assert.deepEqual(idsOf(bare({ durationText: '24 Sec' })), ['duration'])
  assert.deepEqual(idsOf(bare({ instrumentEnhanced: 'Required' })), ['instrument'])
})

test('D3 a STATED ZERO is a fact and draws its row (mana 0, cast 0 - every bard song)', () => {
  const song = bare({ mana: 0, castTimeMs: 0, recastMs: 0 })
  assert.deepEqual(idsOf(song), ['cast', 'recast', 'mana'])
  const rows = spellStatRows(song)
  assert.equal(rows.find((r) => r.id === 'mana')?.value, '0')
  assert.equal(rows.find((r) => r.id === 'cast')?.value, '0.0s')
  // JOS-444: 432 catalog rows state `recast_time = 0`, which is the page saying there is no re-use
  // timer. The card prints it for the same reason it prints a stated mana of 0 - somebody said so.
  assert.equal(rows.find((r) => r.id === 'recast')?.value, '0.0s')
})

test('D4 the values are the source’s own words, never a re-spelling of them', () => {
  const rows = spellStatRows(
    bare({ durationText: 'Permanent', targetType: 'Single Friendly (or Self)', spellType: 'Resist Buff' })
  )
  assert.equal(rows.find((r) => r.id === 'duration')?.value, 'Permanent')
  assert.equal(rows.find((r) => r.id === 'target')?.value, 'Single Friendly (or Self)')
  assert.equal(rows.find((r) => r.id === 'type')?.value, 'Resist Buff')
})

test('D5 the row order is the spell window’s, whichever subset is present', () => {
  const full = bare({
    spellType: 'Beneficial',
    targetType: 'Group',
    castTimeMs: 3000,
    recastMs: 1500,
    mana: 0,
    durationText: '3 ticks',
    instrumentEnhanced: 'Yes'
  })
  // Recast sits beside cast: the casting cycle is the two of them read as one sentence (JOS-444).
  assert.deepEqual(idsOf(full), ['type', 'target', 'cast', 'recast', 'mana', 'duration', 'instrument'])
})

// ─────────────────────────── 2. the real DB, read end to end ─────────────────────────────────

test('D6 Celestial Remedy reads out of the committed DB with every field it states', () => {
  const d = buildSpellDetail(db, 'Celestial Remedy')
  assert.equal(d.found, true)
  assert.equal(d.name, 'Celestial Remedy')
  assert.equal(d.nature, 'beneficial')
  // Verbatim from src/main/data/spells.json.
  assert.equal(d.durationText, '24 Sec')
  assert.equal(d.castTimeMs, 4000)
  assert.equal(d.recastMs, 1500, 'schema 3 carries recast_time, and the card states it (JOS-444)')
  assert.equal(d.mana, 75)
  assert.equal(d.targetType, 'Single Friendly (or Self)')
  assert.deepEqual(d.effects, ['Increase Hitpoints by 35 per tick'])
  assert.deepEqual(d.classLevels, [{ cls: 'CLR', level: 19 }])
  assert.equal(spellClassLine(d), 'CLR 19')
  assert.deepEqual(idsOf(d), ['type', 'target', 'cast', 'recast', 'mana', 'duration'])
  // The page carries no bard instrument row, so no instrument row is drawn.
  assert.equal(d.instrumentEnhanced, undefined)
})

test('D7 a name no page carries answers found:false and states nothing else', () => {
  const d = buildSpellDetail(db, 'Vorpal Sword of Nothing')
  assert.equal(d.found, false)
  assert.equal(d.name, undefined)
  assert.deepEqual(spellStatRows(d), [])
  assert.equal(d.lineage, null)
  assert.equal(spellFactsAreForLine(d), false)
})

test('D8 the derived effect classes come off the effect list, not off the name', () => {
  // `Charm` reads its own effect line; the JOS-251 law is that a name stem would have matched
  // items and near-misses instead.
  const charm = buildSpellDetail(db, 'Charm')
  assert.ok(charm.effectClasses.includes('charm'), `Charm effect classes: ${charm.effectClasses.join(',')}`)
  assert.ok(spellEffectClassLabels(charm).includes('charm'))
  // A pure DIRECT heal derives no roster at all - and an empty list draws no line. `Kragg's Salve`
  // states `Increase Hitpoints by 688` and nothing else, which is the shape this assertion is about.
  // (It used to be `Celestial Remedy`, which JOS-318 revealed is not a direct heal at all: its one
  // effect line is `Increase Hitpoints by 35 per tick`, so it is a heal over time and now says so.)
  const salve = buildSpellDetail(db, "Kragg's Salve")
  assert.deepEqual(salve.effectClasses, [])
  // …and the class the same read DOES derive, on the spell that moved.
  const remedy = buildSpellDetail(db, 'Celestial Remedy')
  assert.deepEqual(remedy.effectClasses, ['healOverTime'])
  assert.deepEqual(spellEffectClassLabels(remedy), ['heals over time'])
})

// ─────────────────────────── 3. the rank lineage, and its boundary ───────────────────────────

test('D9 a rank the DB itself carries names what it replaces, from the DB alone', () => {
  const d = buildSpellDetail(db, 'Rune III')
  assert.equal(d.found, true)
  assert.equal(d.lineage?.rank, 3)
  assert.equal(d.lineage?.suffixed, true)
  assert.equal(d.lineage?.replaces, 'Rune II')
  assert.equal(spellLineageLine(d), 'Rank III · replaces Rune II')
  // Every member is the DB's, so none of them wears the "your log" tag.
  const members = spellLineageMembers(d)
  assert.ok(members.includes('Rune II'), members.join(' | '))
  assert.ok(!members.some((m) => m.includes('your log')), members.join(' | '))
  // And the DB has a row per rank here, so the numbers on the card are rank III's own.
  assert.equal(d.name, 'Rune III')
  assert.equal(spellFactsAreForLine(d), false)
})

test('D10 a rank ONLY your log names is named, and is labelled as your log’s', () => {
  // The DB holds ONE `Celestial Remedy` row and no rank siblings - the case the owner named.
  // Without the log there is nothing to say beyond the numeral in the name.
  const alone = buildSpellDetail(db, 'Celestial Remedy III')
  assert.equal(spellLineageLine(alone), 'Rank III')
  assert.equal(alone.lineage?.replaces, undefined)
  // With the ranks the log has actually seen cast, the lower rank can be named - and the card
  // says which source named it, because it is not the one every other fact came from.
  const observed = ['Celestial Remedy II', 'Celestial Remedy III']
  const d = buildSpellDetail(db, 'Celestial Remedy III', observed)
  assert.equal(d.lineage?.replaces, 'Celestial Remedy II')
  assert.equal(spellLineageLine(d), 'Rank III · replaces Celestial Remedy II')
  const members = spellLineageMembers(d)
  assert.ok(members.includes('Celestial Remedy II (your log)'), members.join(' | '))
  // The base row is the DB's and stays untagged; the ranks are the log's and are tagged.
  assert.ok(members.includes('Celestial Remedy'), members.join(' | '))
})

test('D11 the facts for a rank the DB has no row for are the LINE’s, and the card says so', () => {
  const d = buildSpellDetail(db, 'Celestial Remedy III')
  assert.equal(d.name, 'Celestial Remedy')
  assert.equal(spellFactsAreForLine(d), true)
  // The line's numbers are still the line's numbers - nothing is scaled or guessed per rank.
  assert.equal(d.mana, 75)
})

test('D12 "replaces" is the highest rank BELOW this one that a source names, never "rank minus one"', () => {
  // A source that names I and III and nothing between: asked about III, the honest answer is I.
  const d = buildSpellDetail(db, 'Cannibalize IV')
  assert.equal(d.lineage?.rank, 4)
  const below = d.lineage?.members.filter((m) => m.rank < 4).map((m) => m.name) ?? []
  assert.ok(below.length > 0, 'the DB carries Cannibalize rank siblings')
  assert.equal(d.lineage?.replaces, below[below.length - 1])
  // Measured on the committed DB: the line is Cannibalize, Cannibalize III, Cannibalize IV -
  // there is no rank II row, and the card must not invent one.
  assert.ok(!below.includes('Cannibalize II'), below.join(' | '))
})

test('D13 a single-rank line with an unsuffixed name has NO lineage block', () => {
  const d = buildSpellDetail(db, 'Celestial Remedy')
  assert.equal(d.lineage, null)
  assert.equal(spellLineageLine(d), null)
  assert.deepEqual(spellLineageMembers(d), [])
})

test('D14 an unsuffixed name whose line HAS siblings lists them, without claiming a rank', () => {
  const d = buildSpellDetail(db, 'Rune')
  assert.equal(d.lineage?.suffixed, false)
  // No "Rank I" sentence: the name states no numeral, so the card states none.
  assert.equal(spellLineageLine(d), null)
  assert.ok((spellLineageMembers(d).length ?? 0) > 1, spellLineageMembers(d).join(' | '))
})

test('D15 an observed rank of a DIFFERENT line never joins this one', () => {
  const d = buildSpellDetail(db, 'Rune III', ['Clarity III', 'Mesmerization III'])
  const members = d.lineage?.members.map((m) => m.name) ?? []
  assert.ok(members.every((m) => m.toLowerCase().startsWith('rune')), members.join(' | '))
})

test('D16 a name the DB and the log BOTH carry is not listed twice', () => {
  const d = buildSpellDetail(db, 'Rune III', ['Rune III', 'Rune II'])
  const names = d.lineage?.members.map((m) => m.name) ?? []
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, names.join(' | '))
  assert.equal(d.lineage?.members.find((m) => m.name === 'Rune III')?.source, 'both')
  // A rank both sources name is NOT tagged - the tag means "only your log states this".
  assert.ok(spellLineageMembers(d).includes('Rune III'))
})

test('D17 an empty / whitespace name is answered, never thrown on', () => {
  assert.equal(buildSpellDetail(db, '').found, false)
  assert.equal(buildSpellDetail(db, '   ').found, false)
})

// ─────────────────────────── 3. what it is worth (JOS-392) ───────────────────────────────────
//
// The owner asked for the unlock row's figures ON THE CARD. The claim these pin is not that the
// numbers are right (tests/spellMetrics.test.mts owns that) — it is that they are THE SAME
// NUMBERS: one reader, in main, at one evaluation level, so a card and the row it hangs off can
// never state two different answers for the same spell.

test('D18 the record carries the row’s own figures, read at the level the spell becomes yours', () => {
  // Superior Healing is a cleric 30 heal the DB places for four classes — so it exercises the rule
  // as well as the arithmetic: the LOWEST of those four is where the numbers are read.
  const d = buildSpellDetail(db, 'Superior Healing')
  assert.equal(d.metricsLevel, 30, 'the lowest level any class gains the line — the unlock rule')
  assert.ok(d.metrics?.heal !== undefined && d.metrics.healPerMana !== undefined)
  const entry = db.spells.find((s) => s.name === 'Superior Healing')
  assert.ok(entry)
  assert.deepEqual(d.metrics, spellMetricsAt(entry, 30), 'the card reads what the row reads, from one function')

  // A nuke reads out of the same seam with the damage half of the same shape.
  const nuke = buildSpellDetail(db, 'Ice Comet')
  assert.equal(nuke.metricsLevel, 49)
  assert.ok((nuke.metrics?.damage ?? 0) > 0, 'a nuke states damage')
})

test('D20 (JOS-447) the card states BOTH readings when a rank is observed, and one when it is not', () => {
  // The card has the room the table does not, so it prints the spell as the catalog describes it
  // AND the spell as you own it. Garrison's is read at the level a wizard gains it (18), where the
  // wiki's ramp states 272; at the VIII the owner's log has watched, six percent a rank floored
  // gives 272 + floor(272 * 48 / 100) = 402.
  const base = buildSpellDetail(db, "Garrison's Mighty Mana Shock")
  assert.equal(base.metricsLevel, 18)
  assert.equal(base.metrics?.damage, 272)
  assert.equal(base.metricsAtRank, undefined, 'no rank observed, so no second line to draw')
  assert.equal(base.metricsRank, undefined)

  const at = buildSpellDetail(db, "Garrison's Mighty Mana Shock", [], { rank: 8 })
  assert.equal(at.metrics?.damage, 272, 'the first line is still the catalog`s own number')
  assert.equal(at.metricsRank, 8)
  assert.equal(at.metricsAtRank?.damage, 402)
  // Both readings divide by the same casting cycle, so the pair is comparable on its face.
  assert.equal(at.metrics?.recastMs, at.metricsAtRank?.recastMs)

  // AND RANK 1 IS BASE, the same reading `scaleSpellDamage` takes and the same one the `yours:`
  // pill takes - a card must not grow a second line that restates the first.
  const one = buildSpellDetail(db, "Garrison's Mighty Mana Shock", [], { rank: 1 })
  assert.equal(one.metricsAtRank, undefined)
  assert.equal(one.metricsRank, undefined)

  // A spell with no figures at all gains no rank line either, whatever rank is handed in.
  const none = buildSpellDetail(db, 'Clarity', [], { rank: 5 })
  assert.equal(none.metrics, undefined)
  assert.equal(none.metricsAtRank, undefined)
})

// ---- D21: THE CARD NAMES THE ITEM THAT DID IT (JOS-452) --------------------------------------
//
// The readout's marker says `worn +11%` and the card is where a reader finds out WHICH piece of
// gear is producing it. Three claims: a third figures line exists when a worn focus qualifies, it
// names the effect AND the item, and it is entirely absent for anybody wearing nothing.

const MASK = ((): WornFocus => {
  const parsed = parseWornFocus('Improved Damage II', 'Polished Mithril Mask (Exaltation)', [
    'Increase Spell Damage by 1% to 20%',
    'Limit Max Level: 44 (lose 5% per level after)',
    'Limit Effect: Current HP',
    'Limit Max Duration: 0s',
    'Limit Type: Detrimental',
    'Limit Target: Exclude Target AE'
  ])
  assert.ok(parsed)
  return parsed
})()

test('D21 the card carries a THIRD reading with the player`s gear on, and names the item', () => {
  const plain = buildSpellDetail(db, "Garrison's Mighty Mana Shock")
  const worn = buildSpellDetail(db, "Garrison's Mighty Mana Shock", [], { focus: [MASK] })
  // The first two lines are untouched: the catalog's own figures do not move because of gear.
  assert.deepEqual(worn.metrics, plain.metrics)
  // The third is the same spell as you CAST it: its L18 gain-level figure plus the middle of the
  // 1..20 band the page states.
  assert.equal(worn.metricsWithFocus?.damage, Number(((plain.metrics?.damage ?? 0) * 1.105).toFixed(1)))
  assert.deepEqual(worn.focusSources, [
    { side: 'damage', effect: 'Improved Damage II', item: 'Polished Mithril Mask (Exaltation)', pct: 10.5 }
  ])
  assert.deepEqual(spellFocusLines(worn), [
    'worn +11% damage · Improved Damage II · Polished Mithril Mask (Exaltation)'
  ])
  // No em dashes anywhere near a player (AGENTS.md).
  assert.doesNotMatch(spellFocusLines(worn)[0], /[–—]/)
})

test('D21 a card with no gear, or gear this spell does not qualify for, says nothing at all', () => {
  const none = buildSpellDetail(db, "Garrison's Mighty Mana Shock")
  assert.equal(none.metricsWithFocus, undefined)
  assert.equal(none.focusSources, undefined)
  assert.deepEqual(spellFocusLines(none), [])
  // A damage focus over a HEAL: the qualification test refuses it and the card draws no gear block.
  const heal = buildSpellDetail(db, 'Superior Healing', [], { focus: [MASK] })
  assert.ok(heal.metrics?.heal, 'the spell this refusal is about really is a heal')
  assert.equal(heal.metricsWithFocus, undefined)
  assert.equal(heal.focusSources, undefined)
})

test('D21 the gear reading rides the RANK, so the card`s last line is its most complete', () => {
  const both = buildSpellDetail(db, "Garrison's Mighty Mana Shock", [], { rank: 8, focus: [MASK] })
  assert.equal(both.metricsAtRank?.damage, 402, 'the rank line is unchanged by gear')
  // The same 10.5% over the rank figure, which is what a player holding a VIII and wearing the mask
  // is really casting.
  assert.equal(both.metricsWithFocus?.damage, 444.2)
})

test('D19 a spell with no hitpoint line states no figures at all — never a zero', () => {
  const d = buildSpellDetail(db, 'Clarity')
  assert.equal(d.metrics, undefined)
  assert.equal(d.metricsLevel, undefined)
  // The whole shipped DB, as a property: metrics and their level travel together or not at all.
  for (const s of db.spells.slice(0, 400)) {
    const rec = buildSpellDetail(db, s.name)
    assert.equal(
      rec.metrics === undefined,
      rec.metricsLevel === undefined,
      `${s.name}: figures and the level they were read at are one statement`
    )
  }
})
