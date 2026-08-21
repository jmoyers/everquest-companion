// JOS-413 — A LULL IS A DEBUFF, AND A RE-SCRAPE CANNOT TAKE THAT BACK.
//
// Report 6BM6Y5 (v1.5.0): "Pacify and Reoccurring Amnesia are listed as positive buffs in the Buffs
// section, rather than debuffs. Probably because the wiki lists them as 'beneficial' ... you already
// have Pacify showing up on the debuffs overlay, as expected, so that's inconsistent. Reoccurring
// Amnesia, unfortunately, does not show up on debuffs overlay." The owner ruled on 2026-08-19 that
// they are DEBUFFS, and `src/main/data/spellCorrectionsPolarity.ts` is that ruling as a durable
// registry overlay. Read its header first — the family, the two refusals and the measured blast
// radius are all stated there.
//
// WHAT THIS SUITE HOLDS, and the first two are the whole reason the ruling is not a hand-edit:
//
//   1. THE CENSUS. The family is DERIVED from the wiki's own effect lines every run
//      (`spellEffectClass.ts suppressesAggro`) and must be EXACTLY the eighteen names the table
//      rules on. A re-scrape that adds a rank of the lull line, or gives an existing spell a new
//      effect, fails HERE with the spell's name in the message — instead of shipping a lull that is
//      still a buff, which is the shape of the reported defect.
//   2. THE POLARITY ITSELF, read at the seam every consumer reads. `Beneficial` in the raw scrape,
//      `Detrimental` in the effective registry, on EVERY row of every duplicated name.
//   3. THE ACCEPTANCE, through the real parser and the real unified model: a Pacify cast plus its
//      live landing, and a Reoccurring Amnesia cast plus its live landing, each yielding a row the
//      DEBUFFS window carries and an instance whose `cls` says debuff.
//   4. THE REFUSALS, so neither of them can be quietly widened later: the enchanter FACTION ladder
//      stays beneficial, the mez family is untouched, and the three rungs the game prints no landing
//      for still carry no landing message.
//   5. THE CHIP THAT HAD TO SURVIVE. `fade` fires on `Your <X> spell has worn off of <mob>.` — a
//      sentence printed to the CASTER — so the flip must not take it, and for three spells it is the
//      only template they have and therefore their whole presence in the suggestion catalog.
//
// THE SHAPES BELOW ARE THE OWNER'S OWN BYTES. `<mob> looks less aggressive.` occurs 210 times in
// `eqlog_Primitive_freeport.txt` and `<mob> blinks a few times.` 6 times, four of them following one
// of his own four Memory Blur casts; `You begin casting <Spell>.` is the shape every combat fixture
// carries. Nothing here is invented and no reporter-slice bytes enter the tree.
//
// Run: `npm test`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser.ts'
import { installSpellDb } from '../src/main/log/rulesets.ts'
import { buildSpellCatalog, loadSpellDb, spellCorrectionsReport, spellNature } from '../src/main/data/spellDb.ts'
import { applySpellCorrections, type SpellCorrection } from '../src/main/data/spellCorrections.ts'
import {
  POLARITY_CORRECTIONS,
  POLARITY_NO_LANDING,
  POLARITY_RULINGS,
  RULED_POLARITY,
  WIKI_POLARITY
} from '../src/main/data/spellCorrectionsPolarity.ts'
import { spellEffectClasses, suppressesAggro } from '../src/main/data/spellEffectClass.ts'
import { BuffsModule } from '../src/main/modules/buffs.ts'
import { BuffTimersModule } from '../src/main/modules/buffTimers.ts'
import { buildTimerRows, rowsForSurface } from '../src/shared/buffTimers.ts'
import type { SpellDbFile, SpellEntry } from '../src/shared/types.ts'
import spellsJson from '../src/main/data/spells.json' with { type: 'json' }

/** THE RAW SCRAPE. No corrections, no derived durations, no overlay of any kind. */
const RAW: SpellEntry[] = (spellsJson as SpellDbFile).spells

/** Every spell the ruling names, flattened and sorted — the table's own claim about the family. */
const RULED: string[] = [...new Set(POLARITY_RULINGS.flatMap((r) => r.spells))].sort()

// ---------------------------------------------------------------------------------------------
// 1 — THE CENSUS: the family is derived, and the table is its answer
// ---------------------------------------------------------------------------------------------

test('THE CENSUS: the aggro-suppression family is exactly the spells the ruling names', () => {
  // Derived over the RAW scrape on purpose: `suppressesAggro` reads effect lines and never the type
  // column, so it gives the same answer before and after the overlay — and asking it BEFORE proves
  // the roster is not an echo of what we just wrote.
  const derived = [...new Set(RAW.filter(suppressesAggro).map((s) => s.name))].sort()
  assert.deepEqual(
    derived,
    [
      'Atone',
      'Blanket of Forgetfulness',
      'Calm',
      'Calm Animal',
      'Harmony',
      'Harmony of Nature',
      "Kelin's Lugubrious Lament",
      'Lull',
      'Lull Animal',
      'Memory Blur',
      'Memory Flux',
      'Mind Wipe',
      'Numb the Dead',
      'Pacify',
      'Reoccurring Amnesia',
      'Rest the Dead',
      'Soothe',
      'Wake of Tranquility'
    ],
    'the lull/memory-wipe family moved — read src/main/data/spellCorrectionsPolarity.ts before ruling on the new member'
  )
  assert.deepEqual(RULED, derived, 'every derived member must be ruled on, and nothing else may be')
})

test('…and the derivation agrees with the effective registry, which is the list that ships', () => {
  const db = loadSpellDb()
  assert.deepEqual([...new Set(db.spells.filter(suppressesAggro).map((s) => s.name))].sort(), RULED)
})

test('every ruled spell is a pure aggro suppression — no member also STOPS the mob', () => {
  // The `every` in `suppressesAggro` is what keeps the mez family out (all eleven state
  // `Memblur(1%)` beside their mez line and are already Detrimental). This says the same thing from
  // the other side: no ruled row carries an effect class outside the two.
  for (const name of RULED) {
    const entry = RAW.find((s) => s.name === name)
    assert.ok(entry, `${name} is no longer in the scrape — the ruling would be describing nothing`)
    const classes = spellEffectClasses(entry)
    assert.ok(classes.length > 0, `${name}: no effect classes at all`)
    for (const k of classes) {
      assert.ok(k === 'pacify' || k === 'memblur', `${name}: unexpected effect class ${k}`)
    }
  }
})

// ---------------------------------------------------------------------------------------------
// 2 — THE POLARITY, at the seam every consumer reads
// ---------------------------------------------------------------------------------------------

test('THE REPORT: the wiki says Beneficial and the effective registry says Detrimental', () => {
  const db = loadSpellDb()
  for (const name of RULED) {
    for (const raw of RAW.filter((s) => s.name === name)) {
      assert.equal(raw.spellType, WIKI_POLARITY, `${name}: the wiki no longer says Beneficial — re-read the ruling`)
    }
    // EVERY row, not just the first: a polarity correction is a `rowsFor` all-rows field, because
    // era/rank duplicates cannot disagree about whether a spell is a good thing or a bad thing.
    for (const row of db.spells.filter((s) => s.name === name)) {
      assert.equal(row.spellType, RULED_POLARITY, `${name}: a registry row is still Beneficial`)
    }
    assert.equal(spellNature(db.byKey.get(name.toLowerCase())?.spellType), 'detrimental', name)
  }
})

test('the overlay reports the ruling clean — nothing stale, no spell it cannot find', () => {
  const report = spellCorrectionsReport()
  assert.ok(report, 'loadSpellDb must have run')
  assert.deepEqual(report.stale, [])
  assert.deepEqual(report.unknownSpells, [])
})

test('a polarity correction writes EVERY row of a duplicated name, and only that field', () => {
  // The scrape carries era/rank duplicates. None of the eighteen has one today, so the rule is
  // proven against a two-row list built here rather than left as an untested branch — the same
  // shape `tests/spellCorrections.test.mts` uses for the NAME field.
  const spells: SpellEntry[] = [
    { name: 'Pacify', spellType: 'Beneficial', msgCastOnOther: 'Someone looks less aggressive.' },
    { name: 'Pacify', spellType: 'Beneficial', msgCastOnOther: 'Someone looks quite unbothered.' },
    { name: 'Clarity', spellType: 'Beneficial' }
  ]
  const one: SpellCorrection = {
    spells: ['Pacify'],
    field: 'spellType',
    from: 'Beneficial',
    to: 'Detrimental',
    attribution: 'db',
    evidence: 'test'
  }
  const { spells: out, report } = applySpellCorrections(spells, [one])
  assert.equal(report.applied, 2, 'both rows of the name are written')
  assert.deepEqual(
    out.map((s) => s.spellType),
    ['Detrimental', 'Detrimental', 'Beneficial']
  )
  assert.deepEqual(
    out.map((s) => s.msgCastOnOther),
    ['Someone looks less aggressive.', 'Someone looks quite unbothered.', undefined],
    'the two rows keep the different sentences they legitimately carry'
  )
})

test('IDEMPOTENCE, both directions: a wiki that adopts the ruling reports satisfied, a third word stale', () => {
  const spells: SpellEntry[] = [{ name: 'Pacify', spellType: 'Beneficial' }]
  const one: SpellCorrection = {
    spells: ['Pacify'],
    field: 'spellType',
    from: 'Beneficial',
    to: 'Detrimental',
    attribution: 'db',
    evidence: 'test'
  }
  const once = applySpellCorrections(spells, [one])
  const twice = applySpellCorrections(once.spells, [one])
  assert.equal(twice.report.applied, 0)
  assert.equal(twice.report.satisfied, 1, 'applying the ruling to a ruled list is a no-op')

  const moved = applySpellCorrections([{ name: 'Pacify', spellType: 'Utility Beneficial' }], [one])
  assert.deepEqual(moved.report.stale, [{ spell: 'Pacify', field: 'spellType', found: 'Utility Beneficial' }])
})

test('every polarity entry states the two texts and takes the `db` route', () => {
  for (const c of POLARITY_CORRECTIONS) {
    assert.equal(c.field, 'spellType')
    assert.equal(c.from, WIKI_POLARITY)
    assert.equal(c.to, RULED_POLARITY)
    assert.equal(c.attribution, 'db', 'the wiki`s own effect list is the witness against its type column')
    assert.ok(c.evidence.length > 60, `${c.spells.join('/')}: the evidence line must say what the spell does`)
    assert.ok(c.spells.length > 0)
  }
})

// ---------------------------------------------------------------------------------------------
// 3 — THE ACCEPTANCE: both reported spells, through the real parser and the real model
// ---------------------------------------------------------------------------------------------

/** An EQ-stamped line at `sec` seconds past 20:31:00 — the real `[Day Mon DD HH:MM:SS YYYY] ` shape. */
function at(sec: number, text: string): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  const m = 31 + Math.floor(sec / 60)
  return `[Wed Aug 05 20:${two(m)}:${two(sec % 60)} 2026] ${text}`
}

/** The `tests/spellCorrections.test.mts` harness: both modules, wired the way wiring.ts wires them. */
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
  return { rows: buildTimerRows(b, timers.snapshot().state), active: b.active }
}

test('THE REPORTED DEFECT: a Pacify cast plus its live landing is a DEBUFF on the debuffs window', () => {
  const r = replay(
    [
      [0, 'You begin casting Pacify IV.'],
      [3, 'a fire giant warrior looks less aggressive.']
    ],
    20
  )
  const row = r.rows.find((x) => x.name === 'Pacify')
  assert.ok(row, `no Pacify row: ${r.rows.map((x) => x.name).join(', ') || '(none)'}`)
  assert.equal(row.target, 'a fire giant warrior')
  assert.equal(row.kind, 'debuff', 'the owner ruled a lull is a debuff')
  assert.equal(row.mode, 'countdown')
  assert.equal(row.durationMs, 42_000, "the DB's stated Pacify duration — the ruling moves no number")
  assert.ok(rowsForSurface(r.rows, 'debuffs').includes(row), 'the DEBUFFS window carries it')
  assert.deepEqual(rowsForSurface(r.rows, 'buffs'), [], 'and the buffs window carries nothing')
  // The Buffs SECTION reads the instance, which is the half of the report the JOS-213 routing fact
  // could not reach: `cls` is what that surface groups on.
  assert.equal(
    r.active.find((a) => a.spell === 'Pacify')?.cls,
    'debuff',
    'the Buffs section groups on `cls`, and it must file this under Debuffs'
  )
})

test('THE SECOND REPORTED SPELL: Reoccurring Amnesia reaches the debuff overlay too', () => {
  // It never could before, and not because of the routing: `calmsTarget` derives from the calm
  // line's three landing SENTENCES and `Someone blinks a few times.` is not one of them. Polarity
  // reaches it where the routing fact cannot — which is the report's own "Reoccurring Amnesia,
  // unfortunately, does not show up on debuffs overlay."
  const r = replay(
    [
      [0, 'You begin casting Reoccurring Amnesia.'],
      [2, 'a fire giant warrior blinks a few times.']
    ],
    12
  )
  const row = r.rows.find((x) => x.name === 'Reoccurring Amnesia')
  assert.ok(row, `no Reoccurring Amnesia row: ${r.rows.map((x) => x.name).join(', ') || '(none)'}`)
  assert.equal(row.target, 'a fire giant warrior')
  assert.equal(row.kind, 'debuff')
  assert.equal(row.durationMs, 24_000, 'the DB states 24 s and the ruling moves no number')
  assert.equal(row.calmsTarget, undefined, 'it is NOT a calm-line row — the polarity is what routes it')
  assert.ok(rowsForSurface(r.rows, 'debuffs').includes(row))
  assert.deepEqual(rowsForSurface(r.rows, 'buffs'), [])
  assert.equal(r.active.find((a) => a.spell === 'Reoccurring Amnesia')?.cls, 'debuff')
})

// ---------------------------------------------------------------------------------------------
// 4 — THE REFUSALS
// ---------------------------------------------------------------------------------------------

test('THE FACTION LADDER IS NOT IN IT: a lasting benefit to the mob is not a debuff', () => {
  // They print `Someone looks friendly.`, so JOS-213's landing-sentence roster claims them and a
  // reader will look for them in the ruling. Their effect list is `Increase Faction by N` and
  // nothing else. The two rosters disagreeing here is correct: one asks what sentence the spell
  // prints, the other what the spell DOES.
  const db = loadSpellDb()
  for (const name of ['Alliance', 'Benevolence', 'Collaboration']) {
    const entry = db.byKey.get(name.toLowerCase())
    assert.ok(entry, `${name} is no longer in the DB — the refusal would be vacuous`)
    assert.equal(entry.spellType, 'Beneficial', `${name} must keep the wiki's word`)
    assert.equal(suppressesAggro(entry), false, `${name} raises faction; it suppresses nothing`)
    assert.ok(!RULED.includes(name))
  }
})

test('THE MEZ FAMILY IS NOT IN IT: a Memblur beside a Mesmerize is a hold, and already Detrimental', () => {
  const db = loadSpellDb()
  for (const name of ['Mesmerize', 'Dazzle', 'Enthrall', 'Entrance', 'Rapture']) {
    const entry = db.byKey.get(name.toLowerCase())
    assert.ok(entry, `${name} is no longer in the DB — the refusal would be vacuous`)
    assert.ok(spellEffectClasses(entry).includes('memblur'), `${name} must still carry the Memblur line`)
    assert.equal(suppressesAggro(entry), false, `${name} also STOPS the mob — the strict every() must refuse it`)
    assert.equal(entry.spellType, 'Detrimental', `${name} was already right and must be untouched`)
  }
})

test('THE THREE RUNGS THE GAME PRINTS NO LANDING FOR still print none', () => {
  // MEASURED (spellCorrectionsPolarity.ts, THE DRUID HALF): 212 owner casts of `Harmony of Nature`,
  // ZERO family landing sentences within 12 s of any of them, and 200 `Your Harmony of Nature spell
  // has worn off of <mob>.` — the spell lands and says nothing when it does. So the wiki's empty
  // field is TRUE and restoring a sentence would be inventing one. This pins the refusal: a
  // re-scrape that supplies a landing turns a standing limitation into a failing test.
  const db = loadSpellDb()
  assert.deepEqual(
    POLARITY_NO_LANDING.map((r) => r.spell).sort(),
    ['Harmony', 'Harmony of Nature', 'Lull Animal'],
    'the refusal list moved — re-read THE DRUID HALF before adding or dropping a row'
  )
  for (const { spell } of POLARITY_NO_LANDING) {
    const entry = db.byKey.get(spell.toLowerCase())
    assert.ok(entry, `${spell} is no longer in the DB`)
    assert.equal(entry.msgCastOnOther, undefined, `${spell}: the wiki now states a landing — read the measurement`)
    assert.ok(RULED.includes(spell), `${spell} is still a lull and still gets the polarity ruling`)
  }
  // …and the rung that DOES work is the one a druid report should be pointed at.
  assert.equal(
    db.byKey.get('calm animal')?.msgCastOnOther,
    'Someone looks less aggressive.',
    'Calm Animal (Druid 15 / Ranger 31) is the druid rung that has always been routed'
  )
})

// ---------------------------------------------------------------------------------------------
// 5 — THE CHIPS: what the eighteen trade, and the one that had to survive
// ---------------------------------------------------------------------------------------------

test('the ruling GAINS the landing chip and never costs a spell its place in the catalog', () => {
  const catalog = buildSpellCatalog(loadSpellDb(), new Map())
  const byName = new Map(catalog.entries.map((e) => [e.name, e]))
  for (const name of RULED) {
    const entry = byName.get(name)
    assert.ok(entry, `${name} fell out of the suggestion catalog — that is JOS-103's reported defect`)
    // `fade` fires on `Your <X> spell has worn off of <mob>.`, printed to the CASTER, so the flip
    // must not take it — and for the three message-less rungs it is the only template they have.
    assert.equal(entry.templates.fade, true, `${name} must keep the chip its wear-off line can fire`)
    // The beneficial-side chips that CANNOT fire are gone: a spell you cast at a mob prints its
    // cast-on-you and wears-off sentences to the MOB (spellCorrectionsList.ts names this family).
    assert.equal(entry.templates.landsOnYou, false, `${name}: that sentence prints to the mob`)
    assert.equal(entry.templates.wearsOff, false, `${name}: that sentence prints to the mob`)
  }
  // …and the landing chip a player casting Pacify actually wants, which no member could be offered.
  for (const name of ['Pacify', 'Soothe', 'Calm', 'Lull', 'Reoccurring Amnesia', 'Memory Blur']) {
    assert.equal(byName.get(name)?.templates.lands, true, `${name} must offer "when it lands on a target"`)
  }
})
