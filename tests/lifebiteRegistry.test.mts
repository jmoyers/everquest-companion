// JOS-439 — THE SPELL A GAME PATCH ADDED, AND THE FOUR SURFACES THAT HAD TO LEARN IT.
//
// THE REPORT (owner, 2026-08-21): `Lifebite` — an instant lifetap his necromancer had been casting
// for days — did not exist as far as the app was concerned. Combat attribution was fine the whole
// time (the meter, the resist tracker and the heal tallies read spell names off the LINES, so a
// spell the registry has never heard of still shows up in a fight), but spell search said
// not-found, the JOS-337 level-unlock cards omitted it at Necromancer 8 and Shadow Knight 10, and
// the two lifetap ladders had a hole where it belongs.
//
// THE MECHANISM WAS THE CALENDAR, NOT A BUG. The wiki page (pageid 60016) has ONE revision,
// 2026-08-18T15:42Z — created by the game patch of that day, five days after the last spell scrape.
// The revision-keyed cache did exactly what it is built to do and never fetched a page the
// enumeration did not yet contain. So the whole fix is `npm run scrape:spells`, and the interesting
// part of the ticket is the OTHER 77 rows that came with it (the alchemy shelf getting its
// Spellpages, one page rename, six changed rows) and the pinned censuses each of those moved. Those
// movements are recorded where they are asserted — `tests/classTables.test.mts`,
// `tests/spellEffectClass.test.mts`, `tests/spellCorrectionsSubjects.test.mts`,
// `tests/spellEra.test.mts` — one explained row at a time, the JOS-435 posture.
//
// NOTHING WAS OVERLAID. The ticket carried an owner ruling to research and correct the row if the
// scrape brought it in incomplete; it did not. The row below came off the wiki whole and
// sibling-consistent, and this file is where that claim is CHECKED rather than asserted in a commit
// message — the corrections registry stays empty of Lifebite, which is the outcome worth pinning.
//
// THE ONE THING THE WIKI MAY BE WRONG ABOUT, recorded and NOT acted on (owner's call): the page
// states a flat 42 damage, while the owner's own log runs 42-50 on his casts, which is the ordinary
// level-scaled shape the siblings all show in their effect text (`Decrease Hitpoints by 39 (L12) to
// 45 (L18)`). Any surface that renders `effects` verbatim will therefore understate this spell
// slightly. No correction is minted for it: a magnitude the wiki states and the log contradicts is
// a report to file, not a number to invent.
//
// No Electron, no network, no log: the committed JSON in the tree is what ships.
//
// Run: `npm test`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadSpellDb } from '../src/main/data/spellDb'
import { buildSpellDetail } from '../src/main/data/spellDetail'
import { buildLevelUnlocks } from '../src/main/data/levelUnlocks'
import { unlocksAtLevel, type ComboClasses } from '../src/shared/levelUnlocks'
import { replacedBy } from '../src/main/data/spellLineLookup'
import type { ClassAbbr } from '../src/shared/classCombo'
import type { SpellDbFile } from '../src/shared/types'
import spellsJson from '../src/main/data/spells.json' with { type: 'json' }

const RAW = (spellsJson as SpellDbFile).spells
const row = (name: string): (typeof RAW)[number] | undefined => RAW.find((s) => s.name === name)
const combo = (...resolved: ClassAbbr[]): ComboClasses => ({ resolved, candidates: [], ambiguous: false })

test('JOS-439 A: the scrape brought Lifebite in whole, and its fields agree with its siblings', () => {
  const lifebite = row('Lifebite')
  assert.ok(lifebite, 'Lifebite is in the committed catalog')
  // The four nearest members of the ladder it joins. Each of these is a field a lifetap surface
  // reads, and a row that disagreed with the family on any of them would be the kind of half-scraped
  // entry the corrections overlay exists to patch.
  for (const sibling of ['Lifetap', 'Lifespike', 'Siphon Life']) {
    const s = row(sibling)
    assert.ok(s, sibling)
    assert.equal(lifebite.targetType, s.targetType, `targetType vs ${sibling}`)
    assert.equal(lifebite.spellType, s.spellType, `spellType vs ${sibling}`)
    assert.equal(lifebite.durationMs, s.durationMs, `durationMs vs ${sibling}`)
    assert.equal(lifebite.msgCastOnYou, s.msgCastOnYou, `msgCastOnYou vs ${sibling}`)
    assert.equal(lifebite.msgCastOnOther, s.msgCastOnOther, `msgCastOnOther vs ${sibling}`)
  }
  // …and the fields that are its OWN. An instant has no wear-off sentence, which is why no bar and
  // no `buffExpired` is the correct behaviour here rather than a missing feature.
  assert.equal(lifebite.targetType, 'Lifetap')
  assert.equal(lifebite.durationMs, null)
  assert.equal(lifebite.msgWearsOff, undefined, 'an instant prints no wear-off line')
  assert.equal(lifebite.castTimeMs, 1750)
  assert.equal(lifebite.mana, 35)
  assert.equal(lifebite.illusion, false)
  assert.deepEqual(lifebite.effects, [
    'Decrease Hitpoints by 42 to 42',
    'Increase Hitpoints by 42 to 42 (Self)'
  ])
  assert.equal(
    lifebite.classes,
    '* Necromancer - Level 8 (Autogranted) * Shadow Knight - Level 10 (Autogranted)'
  )
})

test('JOS-439 B: spell search and the spell card resolve it', () => {
  const detail = buildSpellDetail(loadSpellDb(), 'Lifebite')
  assert.equal(detail.found, true, 'the report was that this said not-found')
  assert.equal(detail.name, 'Lifebite')
  assert.deepEqual(detail.classLevels, [
    { cls: 'NEC', level: 8 },
    { cls: 'SHD', level: 10 }
  ])
  // The lookup runs through the CORRECTED catalog, and a name is the only join key it has — so a
  // card that resolves is also the proof the name the game prints is the name the registry carries.
  assert.equal(detail.targetType, 'Lifetap')
  // Not folded behind the out-of-era disclosure: the era sidecar answers `false` for this page.
  assert.equal('outOfEra' in detail, false)
})

test('JOS-439 C: the unlock cards offer it at Necromancer 8 and Shadow Knight 10', () => {
  const data = buildLevelUnlocks()
  for (const [cls, level] of [['NEC', 8], ['SHD', 10]] as [ClassAbbr, number][]) {
    const at = unlocksAtLevel(data, combo(cls), level)
    assert.equal(at.spells.some((r) => r.name === 'Lifebite'), true, `${cls} ${String(level)} omits it`)
    assert.equal(at.outOfEraSpells.some((r) => r.name === 'Lifebite'), false, `${cls} folded it`)
  }
  // …and NOT at the other class's level, which is the whole reason the card reads a per-class level
  // rather than a single number off the row.
  assert.equal(
    unlocksAtLevel(data, combo('NEC'), 10).spells.some((r) => r.name === 'Lifebite'),
    false,
    'a necromancer gains it at 8, so 10 is not its unlock level for him'
  )
})

test('JOS-439 D: both lifetap ladders place it between Lifespike and Lifedraw', () => {
  // Owner ruling 2026-08-21: yes, insert. The ladders are RESEARCH
  // (docs/research/spell-lines/) compiled by `npm run gen:spell-lines`, so this asserts the
  // generated file agrees with the two hand-amended inputs.
  assert.deepEqual(replacedBy('Lifebite', 'NEC'), {
    replaces: 'Lifespike',
    replacedBy: 'Lifedraw',
    line: 'Lifetap (instant drain)'
  })
  assert.deepEqual(replacedBy('Lifebite', 'SHD'), {
    replaces: 'Lifespike',
    replacedBy: 'Lifedraw',
    line: 'Direct Lifetap line'
  })
  // The neighbours' own answers moved with it — the insertion is in the LIST, not a special case
  // hung off one lookup.
  assert.equal(replacedBy('Lifespike', 'NEC').replacedBy, 'Lifebite')
  assert.equal(replacedBy('Lifedraw', 'SHD').replaces, 'Lifebite')
})
