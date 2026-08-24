// THE CLIENT SPELL TABLE'S FIELD MAP, PINNED (JOS-382).
//
// `spells_us.txt` is Daybreak's file and is never committed here, so the rows below are authored —
// but every one of them is a VERBATIM transcription of the fields this parser reads out of the
// owner's real install, taken on 2026-08-16 and named beside each row. That is the only honest way
// to pin a field map against a file the repo may not carry: a test that requires the client
// install would skip on CI and pin nothing.
//
// AND IT PINS ONE CORRECTION TO THE BRIEF. An effect slot is
// `slot | effectId | base | limit | CALC | MAX`, not `… | max | calc`. Tashani's slot 2 reads
// `2|50|-10|0|101|23`; Torven's table documents Tashani at -23 magic resist and calc 101 is
// "base plus level/2, capped at max". Read the other way round, the formula code would be 23
// (which is not a formula) and the cap would be 101 (a number Tashani has never produced).
// Malaisement confirms it at -40 on all four axes, and Mesmerization puts its documented
// "up to level 55" in the same position.
//
// JOS-396 ADDS TWO MORE FIELDS AND THE SAME RULE APPLIES TO THEM. Fields 11 and 12 are the buff
// duration formula and its cap, and Odium's row (id 4093, transcribed below) is the measurement:
// `11 = 7`, `12 = 5`, five ticks, thirty seconds — the duration the wiki's own Odium page states
// and the duration the game's spell window prints. What the parser does with them is nothing:
// it records the two numbers and the effect-0 slots beside them, and every evaluation happens at
// a READER'S level in shared/spellMetrics.ts.
//
// JOS-444 ADDS FIELD 10, THE RE-USE TIMER, AND ITS DECOY SITS RIGHT BESIDE IT. Field 9 is the
// RECOVERY time and reads 1500 on 18,008 of the owner's 33,952 playable rows, so a spell whose
// recast happens to be 1.5s — Garrison's Mighty Mana Shock, below — cannot tell the two columns
// apart on its own. Odium can: field 9 is 1500 and field 10 is 6000, and the wiki's own
// `recast_time` for Odium is six seconds. Complete Heal closes it from the other side (field 9 =
// 1500, field 10 = 0), and all three rows are transcribed below.

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSpellsUs } from '../src/main/resist/spellsUsParse'

/**
 * Build one caret row. Only the fields this parser reads are filled; the rest are the padding the
 * real file carries. 173 fields, exactly as the client writes them.
 */
function row(spec: {
  id: number
  name: string
  castMs?: number
  /**
   * Field 9 — the RECOVERY time, the column next door that is NOT the recast (JOS-444). It is
   * settable here for exactly one reason: to prove the parser does not read it.
   */
  recovery?: number
  /** Field 10 — the spell's own re-use timer, ms. 0 means it has none. */
  recastMs?: number
  /** Field 11 — the buff duration formula. 0 (the default) is an instant spell. */
  durationFormula?: number
  /** Field 12 — the cap the formula clamps to. */
  duration?: number
  /** Field 14 — the mana cost (JOS-451). 0 means the spell is free. */
  mana?: number
  resistType?: number
  targetType?: number
  resistAdj?: number
  classes?: Record<number, number>
  slots?: string
}): string {
  // The omitted fields default here rather than at each use, which keeps this builder well under
  // the lint config's complexity ceiling as the field map grows (JOS-444 added two).
  const s = {
    castMs: 0,
    recovery: 0,
    recastMs: 0,
    durationFormula: 0,
    duration: 0,
    mana: 0,
    resistType: 0,
    targetType: 0,
    resistAdj: 0,
    classes: {} as Record<number, number>,
    slots: '',
    ...spec
  }
  const f = new Array<string>(173).fill('0')
  f[0] = String(s.id)
  f[1] = s.name
  f[8] = String(s.castMs)
  f[9] = String(s.recovery)
  f[10] = String(s.recastMs)
  f[11] = String(s.durationFormula)
  f[12] = String(s.duration)
  f[14] = String(s.mana)
  f[29] = String(s.resistType)
  f[30] = String(s.targetType)
  for (let i = 0; i < 16; i++) f[36 + i] = '255'
  for (const [idx, lvl] of Object.entries(s.classes)) f[36 + Number(idx)] = String(lvl)
  f[78] = String(s.resistAdj)
  f[172] = s.slots
  return f.join('^')
}

/** WAR CLR PAL RNG SHD DRU MNK BRD ROG SHM NEC WIZ MAG ENC BST BER. */
const ENC = 13
const BRD = 7
const PAL = 2
const SHM = 9
const NEC = 10
const WIZ = 11

// Verbatim from the owner's install, 2026-08-16.
const TASHANI = row({ id: 677, name: 'Tashani', castMs: 1000, resistType: 0, targetType: 5, classes: { [ENC]: 20 }, slots: '1|36|1|0|100|0$2|50|-10|0|101|23' })
const MALAISEMENT = row({ id: 111, name: 'Malaisement', castMs: 4000, resistType: 1, targetType: 5, resistAdj: -5, classes: { [ENC]: 39 }, slots: '1|10|0|0|100|0$2|47|-20|0|101|40$3|50|-20|0|101|40$4|48|-20|0|101|40$5|46|-20|0|101|40' })
const MESMERIZATION = row({ id: 307, name: 'Mesmerization', castMs: 3000, resistType: 1, targetType: 8, classes: { [ENC]: 16 }, slots: '1|31|2|0|100|55' })
const CHAOS_FLUX = row({ id: 350, name: 'Chaos Flux', castMs: 3000, resistType: 1, targetType: 5, classes: { [ENC]: 21 }, slots: '1|0|-110|0|103|175$2|21|1000|500|100|55' })
const CHAOS_FLUX_NPC = row({ id: 6850, name: 'Chaos Flux', castMs: 0, resistType: 1, targetType: 5, slots: '1|0|-95|0|103|150$2|21|1000|500|100|0' })
const SMITING_STRIKE = row({ id: 74037, name: 'Smiting Strike', castMs: 0, resistType: 1, targetType: 5, resistAdj: -250, slots: '1|535|20|-3500|100|1' })
const SCORCHING_ARROW = row({ id: 74042, name: 'Scorching Arrow', castMs: 500, resistType: 2, targetType: 5, slots: '1|79|-210|0|100|210$2|0|-105|0|100|105' })
const SCORCHING_ARROW_IV = row({ id: 74045, name: 'Scorching Arrow IV', castMs: 500, resistType: 2, targetType: 5, slots: '1|79|-420|0|100|420$2|0|-210|0|100|210' })
const CHORDS = row({ id: 703, name: 'Chords of Dissonance', castMs: 3000, resistType: 1, targetType: 5, resistAdj: -100, classes: { [BRD]: 2 }, slots: '1|334|-2|0|109|0' })
const SMITE = row({ id: 1234, name: 'Divine Might Strike', castMs: 0, resistType: 1, targetType: 5, resistAdj: -150, classes: { [PAL]: 30 }, slots: '1|0|-40|0|100|40' })
// JOS-396, verbatim from the owner's install 2026-08-16. THE TICKET'S CASE: the wiki's slot table
// for Odium lists `Increase Curse Counter by 8` and no hitpoint line at all; the client carries
// both, and slot 2 is the damage the shaman actually does.
const ODIUM = row({ id: 4093, name: 'Odium', castMs: 3000, recovery: 1500, recastMs: 6000, durationFormula: 7, duration: 5, mana: 409, resistType: 1, targetType: 5, classes: { [SHM]: 43 }, slots: '1|116|8|0|100|0$2|0|-217|0|103|325' })
// A PERMANENT duration (formula 50) over a per-tick drain — the necromancer's Lich. The client
// states a RATE and no length, which is a total nobody can compute; the fold refuses it, and the
// parse's job is only to record the 50 faithfully so the fold can.
const LICH = row({ id: 1735, name: 'Lich', castMs: 6000, durationFormula: 50, duration: 0, resistType: 0, targetType: 6, classes: { [NEC]: 49 }, slots: '1|0|-22|0|100|0$2|15|10|0|100|0' })
// THREE effect-0 slots on one row (id 14234, cleric 77). 523 rows in the owner's file carry more
// than one, which is why `hp` is a list and `hpSlot` — the estimator's single-slot reader — could
// never have been widened in place.
const DIVINE_CENSURE = row({ id: 14234, name: 'Divine Censure', castMs: 3000, resistType: 1, targetType: 5, classes: { [PAL]: 77 }, slots: '1|0|-2164|635|100|2164$2|0|-2878|603|100|2878$3|0|-2575|118|100|2575' })
// JOS-444, verbatim from the owner's install 2026-08-22. THE TICKET'S PIN: a 3.0s cast with a 1.5s
// re-use timer in field 10, which is the number the wiki's `recast_time` states for the same spell.
// Field 9 reads 1500 as well, and that coincidence is exactly why the column had to be picked by
// cross-checking a spell where the two DISAGREE (Odium below, 6000).
const GARRISON = row({ id: 2552, name: "Garrison's Mighty Mana Shock", castMs: 3000, recovery: 1500, recastMs: 1500, resistType: 1, targetType: 5, classes: { [WIZ]: 18 }, slots: '1|0|-200|0|105|333' })
// The other half of the discrimination: field 9 says 1500 and field 10 says 0. Complete Heal has
// NO re-use timer, and a parser reading field 9 would give it one.
const COMPLETE_HEAL = row({ id: 1292, name: 'Complete Heal', castMs: 1000, recovery: 1500, recastMs: 0, durationFormula: 3, duration: 75, mana: 350, resistType: 0, targetType: 5, slots: '1|101|1|0|100|1' })
// JOS-451, verbatim from the owner's install 2026-08-23. THE TICKET'S CASE: the wiki's page for
// this spell states `Increase Hitpoints by 10 per tick` and the client states a level curve whose
// BASE is that 10 — plus two a level, capped at 100, four ticks. And the slot is EFFECT 100, the
// heal-over-time spelling, which the effect-0-only reader could never see at all.
const ETHEREAL_CLEANSING = row({ id: 3683, name: 'Ethereal Cleansing', castMs: 1500, recovery: 1500, recastMs: 30000, durationFormula: 3, duration: 4, mana: 150, resistType: 0, targetType: 51, classes: { [PAL]: 44 }, slots: '1|100|10|0|103|100' })

const TABLE = parseSpellsUs(
  [TASHANI, MALAISEMENT, MESMERIZATION, CHAOS_FLUX, CHAOS_FLUX_NPC, SMITING_STRIKE, SCORCHING_ARROW, SCORCHING_ARROW_IV, CHORDS, SMITE, ODIUM, LICH, DIVINE_CENSURE, GARRISON, COMPLETE_HEAL, ETHEREAL_CLEANSING].join('\n') + '\n'
)

test('the axis comes from field 29, and the four unmodellable kinds come back null', () => {
  assert.equal(TABLE['chaos flux'].axis, 'magic')
  assert.equal(TABLE['scorching arrow'].axis, 'fire')
  // Tashani is resist type 0: the game never resists it, so it is evidence about no axis at all.
  assert.equal(TABLE.tashani.axis, null)
})

test('the resist adjust is field 78, and it is what makes a proc land', () => {
  assert.equal(TABLE['smiting strike'].resistAdj, -250)
  assert.equal(TABLE['divine might strike'].resistAdj, -150)
  assert.equal(TABLE['chaos flux'].resistAdj, 0)
})

test('cast time and target type ride along', () => {
  assert.equal(TABLE.mesmerization.castMs, 3000)
  assert.equal(TABLE.mesmerization.targetType, 8)
  assert.equal(TABLE['smiting strike'].castMs, 0)
})

test('JOS-444: the re-use timer is FIELD 10, and field 9 is the cooldown that looks like it', () => {
  // Odium is the row that picks the column: field 10 reads 6000 and the wiki's own `recast_time`
  // for Odium is 6 seconds. Field 9 reads 1500 on the same row, which is what makes it a decoy.
  assert.equal(TABLE.odium.recastMs, 6000)
  assert.equal(TABLE["garrison's mighty mana shock"].recastMs, 1500)
  // A row whose field 10 is 0 states that it has NO re-use timer, and the absence is how the
  // reader hears that — a stored 0 would be half the table saying nothing.
  assert.equal(TABLE['complete heal'].recastMs, undefined)
  // …and a parser that had reached one field to the left would have given it 1500.
  assert.equal(TABLE['complete heal'].castMs, 1000)
  // Every row authored before this ticket leaves both fields at 0 and is unchanged.
  assert.equal(TABLE.tashani.recastMs, undefined)
})

test('AN EFFECT SLOT IS slot|effect|base|limit|CALC|MAX, and Tashani proves it', () => {
  const slots = TABLE.tashani.debuffSlots
  assert.ok(slots)
  assert.equal(slots.length, 1)
  assert.deepEqual(slots[0], { axis: 'magic', base: -10, calc: 101, max: 23 })
  // Torven documents Tashani at -23 magic resist. 23 is the CAP and 101 is the formula; the other
  // reading gives a formula code of 23 and a cap of 101, neither of which exists.
})

test('a malo moves every axis at once, through effect 111 or through four slots', () => {
  const slots = TABLE.malaisement.debuffSlots
  assert.ok(slots)
  assert.deepEqual(
    slots.map((s) => s.axis).sort(),
    ['cold', 'fire', 'magic', 'poison']
  )
  for (const s of slots) assert.equal(s.max, 40)
})

test('a one-point resist rider is not a resist debuff', () => {
  // A charm that shaves a point off magic resistance is a charm. Opening an eleven-minute debuff
  // window for it would file every later observation under a condition that never mattered.
  const rider = parseSpellsUs(row({ id: 750, name: "Solon's Bewitching Bravura", resistType: 1, slots: '1|22|1|0|100|51$2|50|-1|0|119|0' }))
  assert.equal(rider["solon's bewitching bravura"].debuffSlots, undefined)
})

test('a HARD LEVEL CAP comes only from the primary slot', () => {
  // Mesmerization: `1|31|2|0|100|55` — effect 31 is mez, and 55 is the level it stops working at.
  assert.equal(TABLE.mesmerization.levelCap, 55)
  // Chaos Flux carries a STUN rider capped at 55 on slot 2. Being above it costs the stun, not
  // the nuke, so the whole spell must not become "always resisted" (world-model law 6).
  assert.equal(TABLE['chaos flux'].levelCap, undefined)
})

test('the hitpoint slot is what tells a nuke from a proc', () => {
  assert.deepEqual(TABLE['chaos flux'].hpSlot, { base: -110, max: 175, calc: 103 })
  // Smiting Strike has no effect-0 slot at all: its damage is a skill effect and varies, so there
  // is no "full damage" for the estimator to read partials against.
  assert.equal(TABLE['smiting strike'].hpSlot, undefined)
  // Scorching Arrow's effect-0 slot is not slot 1; every slot is scanned.
  assert.deepEqual(TABLE['scorching arrow'].hpSlot, { base: -105, max: 105, calc: 100 })
})

test('THE BARD IS THE ONLY STATEMENT THAT A SPELL IS A SONG', () => {
  assert.equal(TABLE['chords of dissonance'].song, true)
  assert.equal(TABLE['chaos flux'].song, undefined)
  assert.equal(TABLE['divine might strike'].song, undefined)
})

test('ranks fold onto the base row, and a mob copy loses to a spell a player can learn', () => {
  // `Scorching Arrow IV` and `Scorching Arrow` are one spell to this model — the rank is stripped
  // by spellCanonKey and the first row in the file wins.
  assert.equal(TABLE['scorching arrow iv'], undefined)
  assert.deepEqual(TABLE['scorching arrow'].hpSlot, { base: -105, max: 105, calc: 100 })
  // Chaos Flux 6850 is an NPC's copy with no class able to cast it; the enchanter's row wins even
  // though it comes first, because "no class can learn this" is what a mob copy looks like.
  assert.deepEqual(TABLE['chaos flux'].hpSlot, { base: -110, max: 175, calc: 103 })
})

test('JOS-396: Odium carries its hitpoint slot AND the client duration the wiki page omits', () => {
  // The whole ticket in four numbers: -217 base, cap 325, formula code 103, five ticks.
  assert.deepEqual(TABLE.odium.hp, [{ base: -217, max: 325, calc: 103, perTick: true }])
  assert.deepEqual(TABLE.odium.hpDuration, { formula: 7, value: 5 })
  // `hpSlot` is UNCHANGED — the resist estimator's reader keeps the shape it has always had, and
  // `hp[0]` is the same slot said the other way.
  assert.deepEqual(TABLE.odium.hpSlot, { base: -217, max: 325, calc: 103 })
})

test('JOS-396: a slot is per-tick when the ROW has a duration formula, and only then', () => {
  // Chaos Flux is an instant nuke (formula 0): its effect-0 slot lands once, and there is no
  // duration to record beside it.
  assert.deepEqual(TABLE['chaos flux'].hp, [{ base: -110, max: 175, calc: 103, perTick: false }])
  assert.equal(TABLE['chaos flux'].hpDuration, undefined)
  // Lich is formula 50 — PERMANENT. The slot is per-tick and the duration says so; what to do
  // with "a rate and no length" is the fold's problem, not the parse's.
  assert.deepEqual(TABLE.lich.hp, [{ base: -22, max: 0, calc: 100, perTick: true }])
  assert.deepEqual(TABLE.lich.hpDuration, { formula: 50, value: 0 })
})

test('JOS-396: every effect-0 slot comes through, in file order', () => {
  assert.deepEqual(TABLE['divine censure'].hp, [
    { base: -2164, max: 2164, calc: 100, perTick: false },
    { base: -2878, max: 2878, calc: 100, perTick: false },
    { base: -2575, max: 2575, calc: 100, perTick: false }
  ])
  // …and the single-slot reader still answers with the FIRST of them, unchanged.
  assert.deepEqual(TABLE['divine censure'].hpSlot, { base: -2164, max: 2164, calc: 100 })
})

test('JOS-396: a row with no hitpoint slot carries neither field', () => {
  // Smiting Strike's damage is a skill effect; Tashani moves a resist and nothing else. Writing an
  // empty list or a duration beside nothing would put a megabyte of JSON in every install's cache.
  assert.equal(TABLE['smiting strike'].hp, undefined)
  assert.equal(TABLE['smiting strike'].hpDuration, undefined)
  assert.equal(TABLE.tashani.hp, undefined)
  assert.equal(TABLE.tashani.hpDuration, undefined)
})

test('JOS-451: the mana cost is FIELD 14, and a zero there is an absence', () => {
  // Verified against the committed catalog rather than a struct listing: over the 1,873 catalog
  // spells that join a client row, field 14 agrees exactly on 1,787 of them.
  assert.equal(TABLE['complete heal'].mana, 350)
  assert.equal(TABLE.odium.mana, 409)
  assert.equal(TABLE['ethereal cleansing'].mana, 150)
  // A bard song is free, and the file says so with a 0. Storing it would put a field on half the
  // table to state what its absence states — the same rule field 10 and field 143 follow.
  assert.equal(TABLE['chords of dissonance'].mana, undefined)
  assert.equal(TABLE.tashani.mana, undefined)
})

test('JOS-451: a HITPOINT SLOT is effect 0, 100 or 334 — and `hpSlot` is still effect 0 alone', () => {
  // Effect 100 is the heal-over-time spelling and effect 0 is not used for one. Ethereal Cleansing
  // has NO effect-0 slot, so before this ticket the whole spell carried no client facts at all.
  assert.deepEqual(TABLE['ethereal cleansing'].hp, [{ base: 10, max: 100, calc: 103, perTick: true }])
  assert.deepEqual(TABLE['ethereal cleansing'].hpDuration, { formula: 3, value: 4 })
  // Effect 334 is the bard's pulsing hitpoint effect: five wiki pages name a 334 slot's magnitude
  // as a hitpoint change, and Chords of Dissonance is one of them (`Decrease Hitpoints by 2 per
  // tick`, client `1|334|-2|0|109|0`).
  assert.deepEqual(TABLE['chords of dissonance'].hp, [{ base: -2, max: 0, calc: 109, perTick: false }])
  // AND THE RESIST ESTIMATOR'S READER IS UNTOUCHED. `hpSlot` answers one question — is this
  // spell's damage a fixed number — and neither a HoT nor a bard pulse is a spell it fits from.
  assert.equal(TABLE['ethereal cleansing'].hpSlot, undefined)
  assert.equal(TABLE['chords of dissonance'].hpSlot, undefined)
  assert.deepEqual(TABLE.odium.hpSlot, { base: -217, max: 325, calc: 103 })
})

test('a malformed row is skipped rather than half-read', () => {
  const table = parseSpellsUs(['not^a^row', '', TASHANI].join('\n'))
  assert.deepEqual(Object.keys(table), ['tashani'])
})
