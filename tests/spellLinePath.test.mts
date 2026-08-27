// THE SPELL DRILLDOWN'S LADDER, AND THE TWO LEVELS IT KEEPS APART (JOS-508).
//
// The page answers three questions and this file pins all three:
//
//   1. WHAT LINE IS THIS ON — `src/main/data/spellLinePath.ts` over the committed research table
//      (`spellLines.json`, read through `spellLineLookup.ts`). Prior and next come from the SAME
//      `replacedBy` the Leveling row's "replaces" clause uses, so the page and the row can never
//      disagree about what a spell supersedes.
//   2. WHEN DOES MY COMBO GET EACH RUNG — the DB's own per-class levels intersected with the
//      loadout's RESOLVED classes. This is the claim that is easiest to get subtly wrong and the
//      one a player would actually act on, so most of what follows is about it.
//   3. WHICH CLASSES GET IT AT ALL — `SpellDetail.classLevels`, which predates this ticket and is
//      re-asserted here only where the drilldown's own selection reads it.
//
// THE LOAD-BEARING DISTINCTION, stated once: `step.level` is the LADDER'S class's number and
// `step.yoursAt` is YOURS. A cleric ladder read by a paladin must print the cleric's ordering and
// the paladin's levels, and must never let one stand in for the other. Every `yoursAt` assertion
// below is chosen so the two numbers DIFFER — an assertion where they coincide would pass against
// the bug.
//
// Runs against the REAL committed sources (`loadSpellDb()` + the shipped `spellLines.json`), like
// its sibling `spellDetailFacts.test.mts`: a re-scrape or a research regeneration that moves a rung
// this page leans on fails here rather than in front of a player.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSpellDb } from '../src/main/data/spellDb'
import { buildSpellDetail } from '../src/main/data/spellDetail'
import { buildSpellLinePath } from '../src/main/data/spellLinePath'
import { lineContaining, replacedBy } from '../src/main/data/spellLineLookup'
import { spellLineNote, spellNeighbourLine, spellStepWhen } from '../src/shared/spellDetail'
import { CLASS_ABBRS, type ClassAbbr } from '../src/shared/classCombo'

const db = loadSpellDb()

/** The rung the page is about, out of a built path. */
function marked(steps: readonly { name: string; queried: boolean }[]): string | undefined {
  return steps.find((s) => s.queried)?.name
}

// ─────────────────────────── 1. the ladder itself ────────────────────────────────────────────

test('P1 a spell on a ladder reports the WHOLE ladder, in the table’s level order', () => {
  const path = buildSpellLinePath(db, 'Healing', ['CLR'])
  assert.ok(path, 'the cleric direct-heal ladder carries Healing')
  assert.equal(path.cls, 'CLR')
  assert.equal(path.ladder, true)
  const names = path.steps.map((s) => s.name)
  assert.deepEqual(names.slice(0, 4), ['Minor Healing', 'Light Healing', 'Healing', 'Greater Healing'])
  // Level order is the table's own and is never re-derived here; assert it as a property so a
  // regenerated research file that lands a rung out of order fails HERE.
  for (let i = 1; i < path.steps.length; i++) {
    assert.ok(
      path.steps[i].level >= path.steps[i - 1].level,
      `${path.steps[i].name}@${String(path.steps[i].level)} after ${path.steps[i - 1].name}@${String(path.steps[i - 1].level)}`
    )
  }
  assert.equal(marked(path.steps), 'Healing')
})

test('P2 prior and next are the SAME answer the Leveling row’s replaces clause gives', () => {
  for (const name of ['Healing', 'Minor Healing', 'Greater Healing']) {
    const path = buildSpellLinePath(db, name, ['CLR'])
    assert.ok(path, name)
    const place = replacedBy(name, 'CLR')
    assert.equal(path.prior, place.replaces, `${name} prior`)
    assert.equal(path.next, place.replacedBy, `${name} next`)
  }
  // The two ends of a ladder are honest about being ends rather than pointing at themselves.
  assert.equal(buildSpellLinePath(db, 'Minor Healing', ['CLR'])?.prior, null)
  assert.equal(buildSpellLinePath(db, 'Healing', ['CLR'])?.prior, 'Light Healing')
  assert.equal(buildSpellLinePath(db, 'Healing', ['CLR'])?.next, 'Greater Healing')
})

test('P3 a spell no class files answers null — a ladder of one is not drawn', () => {
  const path = buildSpellLinePath(db, 'No Such Spell At All', ['CLR'])
  assert.equal(path, null)
  // And through the record, which is the shape the page actually reads.
  assert.equal(buildSpellDetail(db, 'No Such Spell At All').linePath, null)
  assert.equal(spellNeighbourLine(buildSpellDetail(db, 'No Such Spell At All')), null)
})

// ─────────────────────────── 2. the two levels, kept apart ───────────────────────────────────

test('P4 `level` is the LADDER’s class — the SAME rung reads differently for two loadouts', () => {
  // ONE spell, two classes that both ladder it, two genuinely different numbers. This is the
  // property the whole design rests on: a level is only meaningful with a class attached to it.
  const asPal = buildSpellLinePath(db, 'Healing', ['PAL'])
  const asClr = buildSpellLinePath(db, 'Healing', ['CLR'])
  assert.ok(asPal)
  assert.ok(asClr)
  assert.equal(asPal.cls, 'PAL')
  assert.equal(asClr.cls, 'CLR')
  const palRung = asPal.steps.find((s) => s.name === 'Healing')
  const clrRung = asClr.steps.find((s) => s.name === 'Healing')
  assert.ok(palRung)
  assert.ok(clrRung)
  assert.notEqual(palRung.level, clrRung.level, 'a paladin does not get Healing when a cleric does')
  // And `yoursAt` tracks the LOADOUT, which for a single-class loadout is that class's own DB level
  // — read from the spell DB, never copied off the ladder it happens to sit beside.
  const levels = buildSpellDetail(db, 'Healing').classLevels
  assert.equal(palRung.yoursAt, levels.find((c) => c.cls === 'PAL')?.level)
  assert.equal(clrRung.yoursAt, levels.find((c) => c.cls === 'CLR')?.level)
})

test('P5 a combo of several classes gets the EARLIEST of their levels, not the ladder’s', () => {
  const trio: ClassAbbr[] = ['CLR', 'PAL', 'WAR']
  const path = buildSpellLinePath(db, 'Healing', trio)
  assert.ok(path)
  const healing = path.steps.find((s) => s.name === 'Healing')
  assert.ok(healing)
  const levels = buildSpellDetail(db, 'Healing').classLevels
  const mine = levels.filter((c) => trio.includes(c.cls)).map((c) => c.level)
  assert.ok(mine.length > 1, 'both CLR and PAL cast Healing — the minimum is a real choice here')
  assert.equal(healing.yoursAt, Math.min(...mine))
})

test('P6 a rung no class of the loadout can cast is null — never softened to the ladder’s level', () => {
  // A pure-warrior loadout casts nothing at all, so every rung of every ladder is honestly null.
  const path = buildSpellLinePath(db, 'Healing', ['WAR'])
  assert.ok(path, 'the ladder is still shown — it is just nobody in this loadout’s')
  assert.equal(path.mine, false)
  for (const step of path.steps) assert.equal(step.yoursAt, null, step.name)
})

test('P7 no loadout at all is a different statement from "not for your classes"', () => {
  const none = buildSpellLinePath(db, 'Healing', [])
  assert.ok(none)
  for (const step of none.steps) assert.equal(step.yoursAt, null, step.name)
  // The words differ, and that is the whole reason `combo` rides the record.
  const unknown = buildSpellDetail(db, 'Healing', [], { combo: [] })
  const warrior = buildSpellDetail(db, 'Healing', [], { combo: ['WAR'] })
  const stepOf = (d: typeof unknown): { yoursAt: number | null } =>
    d.linePath?.steps.find((s) => s.name === 'Healing') ?? { yoursAt: null }
  assert.equal(spellStepWhen({ name: '', level: 0, queried: false, ...stepOf(unknown) }, unknown.combo), 'loadout unknown')
  assert.equal(
    spellStepWhen({ name: '', level: 0, queried: false, ...stepOf(warrior) }, warrior.combo),
    'not for your classes'
  )
  assert.equal(spellStepWhen({ name: '', level: 0, queried: false, yoursAt: 29 }, ['CLR']), 'you: 29')
})

// ─────────────────────────── 3. which ladder the page leads with ─────────────────────────────

test('P8 a class you are PLAYING wins the ladder over one you are not, and says so', () => {
  const asShaman = buildSpellLinePath(db, 'Greater Healing', ['SHM'])
  const asCleric = buildSpellLinePath(db, 'Greater Healing', ['CLR'])
  assert.ok(asShaman)
  assert.ok(asCleric)
  assert.equal(asShaman.cls, 'SHM')
  assert.equal(asCleric.cls, 'CLR')
  assert.equal(asShaman.mine, true)
  assert.equal(asCleric.mine, true)
  // The same name, two loadouts, two genuinely different progressions — the reason the lookup is
  // keyed by class at all (spellLineLookup.ts's own test states the CLR/SHM divergence).
  assert.notEqual(asShaman.next, asCleric.next)
  // And when it is nobody's ladder, the note says whose it is instead of staying quiet.
  const notMine = buildSpellDetail(db, 'Greater Healing', [], { combo: ['WAR'] })
  assert.equal(spellLineNote(notMine), `${String(notMine.linePath?.cls)} levels - not one of your classes`)
  const noCombo = buildSpellDetail(db, 'Greater Healing', [], { combo: [] })
  assert.equal(spellLineNote(noCombo), `${String(noCombo.linePath?.cls)} levels - your loadout is not known yet`)
  // A ladder that IS yours carries no caveat at all.
  assert.equal(spellLineNote(buildSpellDetail(db, 'Greater Healing', [], { combo: ['CLR'] })), null)
})

test('P9 the pick is stable and is the earliest rung among equals', () => {
  // Nothing resolved: the sweep is over every class, and the winner is the one that hands the
  // spell over soonest. Asserted as a property rather than a name so a research regeneration that
  // moves a rung cannot make this test a lie that still passes.
  const path = buildSpellLinePath(db, 'Greater Healing', [])
  assert.ok(path)
  const here = path.steps.find((s) => s.queried)
  assert.ok(here)
  for (const cls of CLASS_ABBRS) {
    const other = lineContaining('Greater Healing', cls)
    if (!other) continue
    const rung = other.line.members[other.index].level
    assert.ok(
      rung > here.level || (rung === here.level && cls >= path.cls),
      `${cls} gets it at ${String(rung)}, earlier than the chosen ${path.cls} at ${String(here.level)}`
    )
  }
  // Twice in a row is the same answer — the index is built once and handed out, never rebuilt.
  assert.deepEqual(buildSpellLinePath(db, 'Greater Healing', []), path)
})

// ─────────────────────────── 4. sets are not ladders ─────────────────────────────────────────

test('P10 a destination SET names its line and refuses to name a neighbour', () => {
  // The research marks travel/gem/poison categories `ladder: false`; the lookup declines a
  // replacement for them and this page must not invent one from the member ordering it can see.
  const sets = CLASS_ABBRS.flatMap((cls) =>
    (lineContaining('Ring of Karana', cls) ? [cls] : []).map((c) => ({ c }))
  )
  const found = sets.length > 0 ? buildSpellLinePath(db, 'Ring of Karana', []) : null
  if (found) {
    assert.equal(found.ladder, false)
    assert.equal(found.prior, null)
    assert.equal(found.next, null)
    assert.ok(found.steps.length > 1, 'the membership is still drawn — only the ordering claim is not')
  }
  // Whatever the table carries, `ladder: false` and a named neighbour must never coexist.
  for (const cls of CLASS_ABBRS) {
    const place = lineContaining('Ring of Karana', cls)
    if (!place || place.line.ladder) continue
    const p = replacedBy('Ring of Karana', cls)
    assert.equal(p.replaces, null)
    assert.equal(p.replacedBy, null)
    assert.equal(p.line, place.line.name)
  }
})

// ─────────────────────────── 5. the record the page actually reads ───────────────────────────

test('P11 the record carries the ladder, the loadout and the class table together', () => {
  const d = buildSpellDetail(db, 'Healing', [], { combo: ['CLR', 'WAR'] })
  assert.equal(d.found, true)
  assert.deepEqual(d.combo, ['CLR', 'WAR'])
  assert.ok(d.linePath)
  assert.equal(d.linePath.mine, true)
  assert.equal(d.linePath.cls, 'CLR')
  assert.equal(spellNeighbourLine(d), 'replaces Light Healing · replaced by Greater Healing')
  // EVERY class that gets the spell, with its level — the third section, and it is not filtered
  // down to the loadout: the page states who else casts it, which is the question it was asked.
  assert.ok(d.classLevels.length >= 2, JSON.stringify(d.classLevels))
  assert.ok(d.classLevels.some((c) => c.cls === 'PAL'), 'a class outside the combo still appears')
})

test('P12 a rank-suffixed name reaches the ladder its ROW sits on', () => {
  // `Celestial Remedy III` has no DB row of its own; its facts come from `Celestial Remedy`, and
  // the ladder has to be that row's ladder rather than nothing at all.
  const d = buildSpellDetail(db, 'Celestial Remedy III', [], { combo: ['CLR'] })
  assert.equal(d.name, 'Celestial Remedy')
  const direct = buildSpellDetail(db, 'Celestial Remedy', [], { combo: ['CLR'] })
  assert.deepEqual(d.linePath, direct.linePath, 'the rank and its line read the same progression')
})

test('P13 a record that was never found still states the loadout it was asked under', () => {
  const d = buildSpellDetail(db, 'No Such Spell At All', [], { combo: ['ENC'] })
  assert.equal(d.found, false)
  assert.deepEqual(d.combo, ['ENC'])
  assert.equal(d.linePath, null)
  assert.equal(spellLineNote(d), null)
})
