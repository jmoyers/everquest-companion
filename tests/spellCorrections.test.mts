// JOS-150 — OUR CORRECTIONS OVERLAY THE WIKI, AND THE WIKI STAYS PRISTINE.
//
// `src/main/data/spells.json` is a SCRAPE and `scripts/scrape-spells.ts` rewrites it wholesale, so
// a hand-edit into it is lost on the next re-scrape. `src/main/data/spellCorrections.ts` is the
// other half: what we know that the wiki does not, applied to the ENTRIES at load, before any
// lookup table is derived. Read that file's header for the evidence bar; this suite is the guard
// that keeps the overlay from rotting into a fiction.
//
// FOUR THINGS ARE PINNED HERE, and the first is the one that matters most:
//
//   1. THE ANTI-ROT GUARD. Every correction must still DESCRIBE something. A correction whose
//      `from` is no longer in the DB and whose `to` is not there either is STALE: the wiki moved
//      under it, and it now looks like coverage while providing none. `applySpellCorrections`
//      reports those and this suite fails on a non-empty list, with the spell and the text it
//      really found — which is exactly the report needed to re-derive the correction.
//   2. IDEMPOTENCE. Applying the overlay to an already-corrected list changes nothing and reports
//      every entry `satisfied`. That is what makes a re-scrape safe in BOTH directions: if the
//      wiki fixes a message upstream, the correction quietly becomes a no-op instead of fighting.
//   3. NON-MUTATION. The spell list comes from an ES-imported JSON module, one shared object for
//      the whole process. The overlay must copy rather than write through it.
//   4. THE ACCEPTANCE: the reported defect, end to end. A Drifting Death cast plus the landing
//      sentence the LIVE GAME prints yields a HOLD under the unified model. It could not before,
//      by one preposition.
//   5. THE ABSENT FIELD (JOS-159). A correction may state `from: null` for a field the DB leaves
//      EMPTY, which is how `Allure` joined the `Someone has been charmed.` family and how the
//      owner's charm countdown started firing at all. It gets the same anti-rot treatment as
//      every other entry, which is what tests 1 and 2 above are re-run for here: it applies only
//      while the field is genuinely absent, a re-scrape that supplies the same text makes it
//      satisfied, and one that supplies a DIFFERENT text makes it stale.
//
// THE SHAPES BELOW ARE REAL. `<target> is engulfed by a swarm.` is in the owner's own log (12
// occurrences whole-log, against 0 of the wiki's `in a swarm` form), so no reporter-slice bytes
// enter the tree — the AGENTS.md rule. `You begin casting <Spell>.` is the shape every combat
// fixture carries; `You begin casting Allure VI.` and `<mob> has been charmed.` are the owner's
// own (227 ranked Allure casts, 423 charm broadcasts), and the charm sentence is committed in
// `tests/fixtures/w13-charm-break-recharm.log` besides.
//
// Run: `npm test`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser.ts'
import { installSpellDb } from '../src/main/log/rulesets.ts'
import { loadSpellDb, spellCorrectionsReport, matchCastOnOtherSuffix } from '../src/main/data/spellDb.ts'
import { applySpellCorrections, SPELL_CORRECTIONS } from '../src/main/data/spellCorrections.ts'
import { classesForSpell } from '../src/main/data/spellClasses.ts'
import { buildLevelUnlocks } from '../src/main/data/levelUnlocks.ts'
import { BuffsModule } from '../src/main/modules/buffs.ts'
import { BuffTimersModule } from '../src/main/modules/buffTimers.ts'
import { buildTimerRows, rowsForSurface } from '../src/shared/buffTimers.ts'
import type { SpellDbFile } from '../src/shared/types.ts'
import spellsJson from '../src/main/data/spells.json' with { type: 'json' }

const RAW = (spellsJson as SpellDbFile).spells

// ---------------------------------------------------------------------------------------------
// 1 — THE ANTI-ROT GUARD
// ---------------------------------------------------------------------------------------------

test('every correction still describes a spell and a message the DB really has', () => {
  const { report } = applySpellCorrections(RAW)
  assert.deepEqual(report.unknownSpells, [], 'a correction naming a spell the DB does not have is a typo or a rename')
  assert.deepEqual(
    report.stale,
    [],
    'STALE: the scrape moved a message out from under a correction. Re-derive it from the log, or delete it.'
  )
  assert.ok(report.applied > 0, 'the overlay is supposed to change something')
})

test('no two corrections claim the same spell and field', () => {
  // Two entries may share a `from` (the mystic-symbol sentence is corrected differently for
  // Transal and for Pinzarn). Two entries claiming the same SPELL and FIELD would be a
  // contradiction whose winner is decided by array order, which is not a decision anyone made.
  const seen = new Set<string>()
  for (const c of SPELL_CORRECTIONS) {
    for (const s of c.spells) {
      const key = `${s}\u0000${c.field}`
      assert.ok(!seen.has(key), `two corrections claim ${s}.${c.field}`)
      seen.add(key)
    }
  }
})

test('an ABSENT field is filled, and only while it is absent', () => {
  // JOS-159. `Allure` is the only enchanter detrimental in the scrape with no cast-on-other
  // message, so the charm broadcast named seven spells and not the one the owner casts.
  const before = RAW.find((s) => s.name === 'Allure')
  assert.ok(before, 'the DB must still carry the enchanter charm at 46')
  assert.equal(before.msgCastOnOther, undefined, 'and the committed scrape still states nothing')

  const { spells, report } = applySpellCorrections(RAW)
  assert.equal(
    spells.find((s) => s.name === 'Allure')?.msgCastOnOther,
    'Someone has been charmed.',
    'the overlay supplies what the wiki left empty'
  )
  assert.deepEqual(report.stale, [], 'an absent field is a MATCH for `from: null`, never a stale correction')

  // Both re-scrape directions, on the absent-field entry specifically.
  const filledSame = RAW.map((s) => (s.name === 'Allure' ? { ...s, msgCastOnOther: 'Someone has been charmed.' } : s))
  const same = applySpellCorrections(filledSame).report
  assert.deepEqual(same.stale, [], 'a wiki that fills the field with our text is not a conflict')

  const filledOther = RAW.map((s) => (s.name === 'Allure' ? { ...s, msgCastOnOther: 'Someone looks smitten.' } : s))
  const other = applySpellCorrections(filledOther).report
  const hit = other.stale.find((x) => x.spell === 'Allure')
  assert.ok(hit, 'a wiki that fills it with something ELSE must fail this suite, not be overwritten')
  assert.equal(hit.found, 'Someone looks smitten.')
})

test('every correction states evidence and an attribution route', () => {
  for (const c of SPELL_CORRECTIONS) {
    assert.ok(c.spells.length > 0, 'a correction with no spells corrects nothing')
    assert.notEqual(c.from, c.to, `${c.spells[0]}.${c.field}: a correction that changes nothing is noise`)
    assert.ok(c.evidence.length > 20, `${c.spells[0]}.${c.field}: state what was measured`)
    assert.ok(['cast', 'db', 'sole'].includes(c.attribution))
    // A NAME correction has to name the row it renames: `from: null` means "the DB states nothing
    // for this field", and a spell always has a name, so there is nothing for it to describe.
    if (c.field === 'name') {
      assert.notEqual(c.from, null, `${c.spells[0]}: a name correction states the name it replaces`)
      assert.deepEqual(c.spells, [c.from], 'and it renames exactly the row it names')
    }
  }
})

test('JOS-161: a NAME correction renames EVERY row of that name, and is idempotent', () => {
  // The scrape carries the level-39 bard song twice (18 s, and the April-2000 1 Min revision).
  // Renaming one and not the other would put a phantom line in the catalog: `byKey` and
  // `buildSpellCatalog` fold by name, so the un-renamed twin becomes its own entry.
  const before = RAW.filter((s) => s.name === "Solon's Bravura")
  assert.equal(before.length, 2, 'the committed scrape still carries both level-39 rows')
  assert.equal(RAW.filter((s) => s.name === "Solon's Bewitching Bravura").length, 0)

  const { spells, report } = applySpellCorrections(RAW)
  assert.equal(spells.filter((s) => s.name === "Solon's Bewitching Bravura").length, 2, 'both rows')
  assert.equal(spells.filter((s) => s.name === "Solon's Bravura").length, 0, 'and no half-rename')
  assert.deepEqual(report.unknownSpells, [])

  // Everything BUT the name is untouched — a rename is not a licence to restate the entry.
  const renamed = spells.filter((s) => s.name === "Solon's Bewitching Bravura")
  assert.deepEqual(
    renamed.map((s) => [s.durationMs, s.castTimeMs, s.spellType, s.msgWearsOff]),
    before.map((s) => [s.durationMs, s.castTimeMs, s.spellType, s.msgWearsOff])
  )

  // THE RE-SCRAPE, BOTH WAYS. A name correction cannot report `stale` — a renamed row is no
  // longer findable by the name the correction states — so the two directions land on the two
  // other lists, and the audit test above fails on either being non-empty.
  const upstream = applySpellCorrections(spells).report
  assert.equal(upstream.applied, 0, 'a wiki that adopts the game`s name leaves nothing to do')
  assert.deepEqual(upstream.unknownSpells, [], 'and it is satisfied, not unknown')

  const third = RAW.map((s) => (s.name === "Solon's Bravura" ? { ...s, name: "Solon's Panache" } : s))
  assert.deepEqual(
    applySpellCorrections(third).report.unknownSpells,
    ["Solon's Bravura"],
    'a wiki that renames it to something ELSE must fail this suite rather than be overwritten'
  )
})

test('JOS-415: a CLASSES correction writes every row, and the already-right twin is satisfied', () => {
  // The seventh drift class. The scrape files two rows under the name `Leach` because two wiki
  // pages set `spellname = Leach`: pageid 46874 (titled `Leech`, `* Necromancer - Level 9`) and
  // pageid 50162 (titled `Leach`, `* Necromancer - Level 12 Recourse Effect`). The wiki's own
  // Necromancer spell list places the spell once, at level 9.
  const before = RAW.filter((s) => s.name === 'Leach')
  assert.equal(before.length, 2, 'the committed scrape still carries both rows')
  assert.deepEqual(
    before.map((s) => s.classes).sort(),
    ['* Necromancer - Level 12 Recourse Effect', '* Necromancer - Level 9'],
    'and they still disagree — otherwise a re-scrape has fixed it and the entry should go'
  )

  const { spells, report } = applySpellCorrections(RAW)
  const after = spells.filter((s) => s.name === 'Leach')
  assert.deepEqual(
    after.map((s) => s.classes),
    ['* Necromancer - Level 9', '* Necromancer - Level 9'],
    'EVERY row: half of this leaves the phantom level-12 unlock card exactly where it was'
  )
  assert.deepEqual(report.stale, [])
  assert.deepEqual(report.unknownSpells, [])

  // Everything BUT the classes line is untouched — a level correction restates nothing else.
  assert.deepEqual(
    after.map((s) => [s.durationText, s.mana, s.castTimeMs, s.msgCastOnYou]),
    before.map((s) => [s.durationText, s.mana, s.castTimeMs, s.msgCastOnYou])
  )

  // Idempotent, and the twin that was already right is `satisfied` rather than `stale` — the same
  // answer a re-scrape adopting level 9 upstream would produce.
  const again = applySpellCorrections(spells).report
  assert.equal(again.applied, 0)
  assert.deepEqual(again.stale, [])

  // And a wiki that moves the line to some THIRD level must fail this suite, not be overwritten.
  const third = RAW.map((s) =>
    s.name === 'Leach' && s.classes === '* Necromancer - Level 12 Recourse Effect'
      ? { ...s, classes: '* Necromancer - Level 14' }
      : s
  )
  assert.ok(
    applySpellCorrections(third).report.stale.some((e) => e.spell === 'Leach' && e.field === 'classes'),
    'a moved classes line must report stale'
  )
})

test('JOS-161: a MESSAGE correction still writes only the first row of a duplicated name', () => {
  // The other half of the rule, and the reason the two kinds differ. `Shock of Frost` is two rows
  // saying two DIFFERENT things (`Your feel your skin freeze.` and `Your skin goes numb.`), so the
  // typo correction on the first must not reach the second — writing it across both would turn a
  // real difference into a stale report and break the anti-rot guard.
  const { spells, report } = applySpellCorrections(RAW)
  const frost = spells.filter((s) => s.name === 'Shock of Frost')
  assert.equal(frost.length, 2)
  assert.equal(frost[0].msgCastOnYou, 'You feel your skin freeze.', 'the typo row is corrected')
  assert.equal(frost[1].msgCastOnYou, 'Your skin goes numb.', 'its sibling says something else entirely')
  assert.deepEqual(report.stale, [])
})

// ---------------------------------------------------------------------------------------------
// 2 / 3 — IDEMPOTENCE AND NON-MUTATION
// ---------------------------------------------------------------------------------------------

test('applying the overlay twice is applying it once', () => {
  const first = applySpellCorrections(RAW)
  const second = applySpellCorrections(first.spells)
  assert.deepEqual(second.spells, first.spells, 'the second pass must be a no-op on the entries')
  assert.equal(second.report.applied, 0, 'nothing left to apply')
  assert.equal(second.report.stale.length, 0, 'and an already-corrected entry is not stale, it is satisfied')
  assert.equal(second.report.satisfied, first.report.applied + first.report.satisfied)
})

test('a message the wiki fixes upstream reports satisfied, not stale', () => {
  // The re-scrape case, simulated: pretend the wiki now prints what the game prints.
  const fixed = RAW.map((s) =>
    s.name === 'Drifting Death' ? { ...s, msgCastOnOther: 'Someone is engulfed by a swarm.' } : s
  )
  const { report } = applySpellCorrections(fixed)
  assert.deepEqual(report.stale, [])
  assert.ok(report.satisfied >= 1, 'the entry becomes a no-op rather than a conflict')
})

test('a message the wiki moves somewhere ELSE reports stale, naming what it found', () => {
  const moved = RAW.map((s) => (s.name === 'Drifting Death' ? { ...s, msgCastOnOther: 'Someone buzzes.' } : s))
  const { report } = applySpellCorrections(moved)
  const hit = report.stale.find((x) => x.spell === 'Drifting Death')
  assert.ok(hit, 'silence here is the failure mode this whole field exists to prevent')
  assert.equal(hit.found, 'Someone buzzes.')
})

test('the overlay never writes through the imported JSON module', () => {
  const before = RAW.find((s) => s.name === 'Drifting Death')?.msgCastOnOther
  applySpellCorrections(RAW)
  assert.equal(
    RAW.find((s) => s.name === 'Drifting Death')?.msgCastOnOther,
    before,
    'spells.json is one shared object for the process; mutating it would leak into every importer'
  )
  assert.equal(before, 'Someone is engulfed in a swarm.', 'and the committed scrape still says what the wiki says')
})

// ---------------------------------------------------------------------------------------------
// THE LOAD SEAM — corrections reach every DERIVED structure, not just one table
// ---------------------------------------------------------------------------------------------

test('loadSpellDb builds its tables from the CORRECTED entries', () => {
  const db = loadSpellDb()
  const report = spellCorrectionsReport()
  assert.ok(report && report.applied > 0, 'the load path reports what it applied')

  // The suffix table AND its hot-path index, which is what the parser actually reads.
  const hit = matchCastOnOtherSuffix('a rock golem is engulfed by a swarm.', db)
  assert.ok(hit, 'the live sentence must resolve at all')
  assert.equal(hit.target, 'a rock golem')
  assert.ok(
    hit.entry.cands.some((c) => c.name === 'Drifting Death'),
    `Drifting Death must be a candidate: ${hit.entry.cands.map((c) => c.name).join(', ')}`
  )
  assert.equal(db.castOnOtherSuffix.get('is engulfed in a swarm.'), undefined, 'and the wiki form is gone')

  // A cast-on-you correction and a wears-off correction, one of each, through the same load.
  assert.ok(
    db.castOnYou.get('The symbol of Transal flashes before your eyes.')?.some((s) => s.name === 'Symbol of Transal'),
    'the symbol names itself, and the generic wiki sentence no longer stands in for it'
  )
  assert.equal(db.castOnYou.get('A mystic symbol flashes before your eyes.')?.length, 3, 'the three unevidenced symbols keep it')
  assert.ok(db.wearsOff.get('Your skin stops tingling.'), 'the clean sentence is a fade message')
  assert.equal(db.wearsOff.get('Your skin stops tingling. <!--'), undefined, 'the scrape artifact is not a message')
})

// ---------------------------------------------------------------------------------------------
// 4 — THE ACCEPTANCE: the reported defect, through the real parser and the real unified model
// ---------------------------------------------------------------------------------------------

/** An EQ-stamped line at `sec` seconds past 22:58:00 — the real `[Day Mon DD HH:MM:SS YYYY] ` shape. */
function at(sec: number, text: string): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  const h = 22 + Math.floor((58 * 60 + sec) / 3600)
  const m = Math.floor(((58 * 60 + sec) % 3600) / 60)
  return `[Sat Aug 09 ${two(h)}:${two(m)}:${two(sec % 60)} 2026] ${text}`
}

/** The `tests/buffUnifiedModel.test.mts` harness: both modules, wired the way wiring.ts wires them. */
function replay(lines: [number, string][], observeSec: number) {
  const db = loadSpellDb()
  installSpellDb(db)
  const buffs = new BuffsModule(db)
  buffs.reset()
  const timers = new BuffTimersModule(buffs.castAnchors(), buffs.spellStats())
  timers.reset()
  let seq = 0
  for (const [sec, text] of lines) {
    const ev = parseEvent(at(sec, text), seq++)
    if (!ev) continue
    buffs.onEvent(ev)
    timers.onEvent(ev)
  }
  const tick = parseEvent(at(observeSec, 'x'), seq)?.ts ?? 0
  buffs.onTick(tick)
  timers.onTick(tick)
  const b = buffs.snapshot().state
  const t = timers.snapshot().state
  // `active` is the BUFFS half (self and named-target landings); `holds` is the CC half (mez,
  // root, charm — the detrimental holds on somebody else). A row can come from either, so both
  // are returned and each acceptance below asserts against the one its defect lives in.
  return { rows: buildTimerRows(b, t), active: b.active, holds: t.holds }
}

test('THE REPORTED DEFECT: a Drifting Death cast plus the live landing yields a HOLD', () => {
  const r = replay(
    [
      [0, 'You begin casting Drifting Death.'],
      [3, 'a rock golem is engulfed by a swarm.']
    ],
    30
  )
  const row = r.rows.find((x) => x.name === 'Drifting Death')
  assert.ok(row, `no Drifting Death row: ${r.rows.map((x) => x.name).join(', ') || '(none)'}`)
  assert.equal(row.target, 'a rock golem')
  assert.equal(row.kind, 'debuff')
  assert.equal(row.mode, 'countdown')
  assert.equal(row.durationMs, 60_000, 'the committed DB states 1 minute for the line')
  assert.ok(rowsForSurface(r.rows, 'debuffs').includes(row), 'and it belongs to the DEBUFFS window')
  // The HOLD itself, one level under the row: a (spell, entity) instance the unified model is
  // carrying. Before the correction the landing line parsed to nothing at all, so there was no
  // instance to render and the row above could not exist however the projection was written.
  assert.ok(
    r.active.some((a) => a.spell === 'Drifting Death' && a.target === 'a rock golem'),
    `no held instance: ${r.active.map((a) => `${a.spell}@${a.target ?? 'self'}`).join(', ') || '(none)'}`
  )
})

test('…and the sentence the WIKI writes still yields nothing, which is the defect stated', () => {
  const r = replay(
    [
      [0, 'You begin casting Drifting Death.'],
      [3, 'a rock golem is engulfed in a swarm.']
    ],
    30
  )
  assert.equal(
    r.rows.find((x) => x.name === 'Drifting Death'),
    undefined,
    'the game does not print this sentence, so nothing in the tree should recognize it'
  )
})

test('JOS-189: the OTHER two darkness ranks land, on the doubt JOS-150 could not close', () => {
  // THE REPORT: an SK/necro on 0.18.0 said the debuff tracker does not track Dooming Darkness.
  // JOS-150 corrected only Engulfing Darkness — the one rank whose own cast-on-YOU message already
  // said `by`, so the wiki contradicted itself inside a single entry — and left the other two,
  // because a zero count for their sentence might only have meant nobody in the log cast them.
  // The log has since answered: 159 Dooming casts and 36 Cascading, and still zero lines of
  // `<T> is engulfed in darkness.` The sentence below is the owner's own (124 lines whole-log).
  const r = replay(
    [
      [0, 'You begin casting Dooming Darkness.'],
      [3, 'a fire giant warrior is engulfed by darkness.']
    ],
    30
  )
  const row = r.rows.find((x) => x.name === 'Dooming Darkness')
  assert.ok(row, `no Dooming Darkness row: ${r.rows.map((x) => x.name).join(', ') || '(none)'}`)
  assert.equal(row.target, 'a fire giant warrior')
  assert.equal(row.kind, 'debuff')
  assert.equal(row.mode, 'countdown')
  assert.equal(row.durationMs, 90_000, 'the committed DB states 1 Min 30 Sec for the line')
  assert.ok(rowsForSurface(r.rows, 'debuffs').includes(row), 'and it belongs to the DEBUFFS window')
})

test('…and all three ranks are now candidates for the one sentence the game prints', () => {
  // The correction is ADDITIVE at the table: the suffix already existed (Engulfing has owned it
  // since JOS-150), so this adds two candidates to a sentence the cast anchor already resolves
  // rather than minting a tail that could compete with anything.
  const db = loadSpellDb()
  const hit = matchCastOnOtherSuffix('a fire giant warrior is engulfed by darkness.', db)
  assert.ok(hit, 'the live sentence must resolve at all')
  assert.deepEqual(
    hit.entry.cands.map((c) => c.name).sort(),
    ['Cascading Darkness', 'Dooming Darkness', 'Engulfing Darkness'],
    'the whole ladder that shares it — and NOT Devouring Darkness, which writes a different sentence'
  )
  assert.equal(db.castOnOtherSuffix.get('is engulfed in darkness.'), undefined, 'the wiki form owns nothing')
})

test('the root line lands too: `<mob> adheres to the ground.` is 493 lines the DB owned nowhere', () => {
  // Immobilize 14/14 casts, Root 1/1, whole-log. The cast-on-YOU half was always right; only the
  // third-person sentence was the wiki's invention.
  const r = replay(
    [
      [0, 'You begin casting Immobilize.'],
      [2, 'a fire giant warrior adheres to the ground.']
    ],
    30
  )
  const row = r.rows.find((x) => x.name === 'Immobilize')
  assert.ok(row, `no Immobilize row: ${r.rows.map((x) => x.name).join(', ') || '(none)'}`)
  assert.equal(row.target, 'a fire giant warrior')
  assert.equal(row.kind, 'debuff')
})

test('JOS-159: an Allure cast plus the charm broadcast opens a charm hold with a countdown', () => {
  // The owner is an enchanter who charms all day, and the countdown JOS-140 built never fired for
  // him: the DB's candidate list for this sentence held seven spells and none of them was his.
  // The cast line is RANKED and the DB entry is not, which `spellCanonKey` folds — the anchor and
  // the candidate meet at `allure`, and the row prints the rank the cast line carried.
  const r = replay(
    [
      [0, 'You begin casting Allure VI.'],
      [4, 'Bzzazzt has been charmed.']
    ],
    30
  )
  const row = r.rows.find((x) => x.target === 'Bzzazzt')
  assert.ok(row, `no charm row: ${r.rows.map((x) => `${x.name}@${x.target ?? 'self'}`).join(', ') || '(none)'}`)
  assert.equal(row.name, 'Allure VI', 'the ranked cast line names the row')
  assert.equal(row.kind, 'cc', 'a charm is a HOLD, in the same shape as a mez')
  assert.ok(rowsForSurface(r.rows, 'debuffs').includes(row), 'and it belongs to the DEBUFFS window')
  assert.equal(row.mode, 'countdown', 'charm-break timing is the whole point')
  assert.equal(row.durationMs, 960_000, 'the DB states 16 minutes for the Allure line')
  // The HOLD itself, one level under the row: before the correction the broadcast resolved to a
  // candidate list with no anchored member in it, so there was no instance to render at all.
  assert.equal(r.holds.length, 1, 'one cast, one charmed mob, one hold')
  assert.equal(r.holds[0].target, 'Bzzazzt')
})

test('…and with the wiki`s empty field the same sequence still opens nothing', () => {
  // The defect stated. `applySpellCorrections` is the only thing standing between these two tests.
  const bare = applySpellCorrections(RAW, SPELL_CORRECTIONS.filter((c) => !c.spells.includes('Allure')))
  assert.equal(bare.spells.find((s) => s.name === 'Allure')?.msgCastOnOther, undefined)
  const cands = bare.spells.filter((s) => s.msgCastOnOther === 'Someone has been charmed.').map((s) => s.name)
  assert.equal(cands.length, 7, `the seven the ticket counted: ${cands.join(', ')}`)
  assert.ok(!cands.includes('Allure'), 'and the owner`s own charm was not one of them')
})

// ---------------------------------------------------------------------------------------------
// JOS-161 — THE TWO BARD SONGS, THE SAME TREATMENT
//
// THE REPORT: a bard on 0.14.0 could not get an alert to fire for `Sionachie's Dreams` or
// `Solon's Bewitching Bravura` with any trigger type, buff-expire included.
//
// THE LINES BELOW ARE THE OWNER'S OWN, from eqlog_Primitive_freeport.txt (lines 512748 and 512774,
// Thu Jul 30 18:32:40-43): `<mob>'s eyes glaze over.` is a BARD's sentence and the owner is not a
// bard, so the witness is a bard standing beside him — Enzee, whose `<Name> begins singing <Song>.`
// lines the parser reads as `otherCastBegin`. Restamped through `at()` like every window in this
// file, and cast in the FIRST person so the anchor is the ordinary own-cast one rather than the
// externals allowlist (which is empty by default and is not what this ticket is about).
// ---------------------------------------------------------------------------------------------

test("JOS-161: Sionachie's Dreams is a candidate for its own landing sentence", () => {
  // The defect, at the layer it lives in. `Target's eyes glaze over.` yields no castOnOtherSuffix
  // at all, so the song was in NO table — while its three ladder siblings owned the sentence the
  // game actually prints. Every alert naming the song was therefore comparing itself to a
  // candidate list the song was not in.
  const db = loadSpellDb()
  const hit = matchCastOnOtherSuffix("a revenant's eyes glaze over.", db)
  assert.ok(hit, 'the live sentence must resolve at all')
  assert.equal(hit.target, 'a revenant')
  assert.deepEqual(
    hit.entry.cands.map((c) => c.name).sort(),
    [
      "Crission's Pixie Strike",
      "Sionachie's Dreams",
      "Solon's Bewitching Bravura",
      "Solon's Song of the Sirens"
    ],
    'the whole bard mez ladder that shares this sentence, under the names the log prints'
  )
  assert.equal(db.castOnOtherSuffix.get("Target's eyes glaze over."), undefined, 'the wiki form is gone')
})

test("JOS-161: the level-39 song answers to the name the log prints", () => {
  // `byKey` is what a cast line folds to, so this miss is why `You begin singing Solon's Bewitching
  // Bravura IX.` anchored nothing and the hold below could not exist.
  const db = loadSpellDb()
  assert.equal(db.byKey.get("solon's bravura"), undefined, 'the wiki`s short form names no spell')
  assert.equal(db.byKey.get("solon's bewitching bravura")?.durationMs, 18_000, 'and the game`s does')
})

test('JOS-161: …and so does every OTHER index keyed by spell name', () => {
  // A name is a join key wherever it is used, not only in `SpellDb`. The class index is read with
  // the name a `castBegin` carries, so before the rename a bard's own signature song contributed
  // nothing to class inference; the level-unlock cards displayed a name no player has ever seen.
  assert.deepEqual(classesForSpell("Solon's Bewitching Bravura IX"), ['BRD'], 'rank folds to the line')
  assert.deepEqual(classesForSpell("Solon's Bravura"), [], 'and the wiki`s short form places nobody')
  assert.deepEqual(classesForSpell("Sionachie's Dreams IV"), ['BRD'], 'unchanged — its name was right')

  const bard = buildLevelUnlocks().spells.filter((s) => s.name.includes('Bravura'))
  assert.deepEqual(
    [...new Set(bard.map((s) => s.name))],
    ["Solon's Bewitching Bravura"],
    'the unlock cards name the song the way the player`s spellbook does'
  )
})

test("JOS-161: a Sionachie's Dreams cast plus its landing yields a countdown row", () => {
  const r = replay(
    [
      [0, "You begin singing Sionachie's Dreams IV."],
      [3, "a revenant's eyes glaze over."]
    ],
    10
  )
  const row = r.rows.find((x) => x.target === 'a revenant')
  assert.ok(row, `no row: ${r.rows.map((x) => `${x.name}@${x.target ?? 'self'}`).join(', ') || '(none)'}`)
  assert.equal(row.name, "Sionachie's Dreams", 'the DB name is the row identity (JOS-238)')
  assert.equal(row.castName, "Sionachie's Dreams IV", 'and the rank the cast line spelled rides beside it')
  assert.equal(row.mode, 'countdown')
  assert.equal(row.durationMs, 18_000, 'the DB states 3 ticks for the line')
  assert.ok(
    r.active.some((a) => a.spell === "Sionachie's Dreams" && a.target === 'a revenant'),
    `no held instance: ${r.active.map((a) => `${a.spell}@${a.target ?? 'self'}`).join(', ') || '(none)'}`
  )
})

test('JOS-161: a Bewitching Bravura cast plus its landing yields a countdown row', () => {
  const r = replay(
    [
      [0, "You begin singing Solon's Bewitching Bravura IX."],
      [2, "a fire giant warrior's eyes glaze over."]
    ],
    10
  )
  const row = r.rows.find((x) => x.target === 'a fire giant warrior')
  assert.ok(row, `no row: ${r.rows.map((x) => `${x.name}@${x.target ?? 'self'}`).join(', ') || '(none)'}`)
  assert.equal(row.name, "Solon's Bewitching Bravura")
  assert.equal(row.castName, "Solon's Bewitching Bravura IX", 'the rank the cast line spelled (JOS-238)')
  assert.equal(row.mode, 'countdown')
  assert.equal(row.durationMs, 18_000)
})

test('…and with the wiki`s own two rows neither song opens anything', () => {
  // The defect stated, the way the Allure pair above states it: the corrections are the only thing
  // standing between this test and the two above. Sionachie's landing resolves to a candidate list
  // it is not in, so no anchor matches it; Bravura's cast folds to a key `byKey` does not have.
  const bare = applySpellCorrections(
    RAW,
    SPELL_CORRECTIONS.filter((c) => c.spells[0] !== "Sionachie's Dreams" && c.spells[0] !== "Solon's Bravura")
  ).spells
  const byMessage = [
    ...new Set(bare.filter((s) => s.msgCastOnOther === "Someone 's eyes glaze over.").map((s) => s.name))
  ].sort()
  assert.deepEqual(byMessage, ["Crission's Pixie Strike", "Solon's Bravura", "Solon's Song of the Sirens"])
  assert.ok(!byMessage.includes("Sionachie's Dreams"), 'the song could not be its own landing`s candidate')
  assert.equal(
    bare.find((s) => s.name === "Sionachie's Dreams")?.msgCastOnOther,
    "Target's eyes glaze over.",
    'because the scrape wrote a subject placeholder the suffix table cannot key'
  )
  assert.equal(bare.filter((s) => s.name === "Solon's Bewitching Bravura").length, 0, 'and the log`s name named nothing')
})
