// "WHAT'S NEW AT THIS LEVEL" — the join behind the panel and the toast subtitle
// (docs/plans/levelup-whats-new.md §2, wave O2).
//
// TWO HALVES, BOTH PINNED HERE:
//   1. the PURE arithmetic (shared/levelUnlocks.ts) against hand-built fixtures — the combo
//      join's three states (resolved / narrowed / unknown), the level fold, the subtitle;
//   2. the REAL committed dataset (src/main/data/levelUnlocks.ts over spells.json +
//      classes.json), asserted with FLOORS and identities, never today's counts.
//
// No Electron, no network, no live log — this suite NEVER skips. It is the test that catches a
// toast claiming "5 new spells" for a loadout it does not have, and a panel that would silently
// drop the thirteen disputed discipline rows instead of labeling them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLASS_ABBRS, type ClassAbbr, type ComboInterval, type ComboSlot } from '../src/shared/classCombo'
import {
  comboClassSet,
  comboClassesAt,
  comboClassesOf,
  levelUpSubtitle,
  ownershipPhrase,
  replacesEntries,
  replacesPhrase,
  unlockCounts,
  unlockLevels,
  unlocksAtLevel,
  type LevelUnlockData,
  type LevelUnlocks,
  type UnlockRow,
  type UnlockSpell
} from '../src/shared/levelUnlocks'
import { spellMetricsParts } from '../src/shared/spellMetrics'
import { buildLevelUnlocks } from '../src/main/data/levelUnlocks'

// ---- fixtures ---------------------------------------------------------------------------

const slot = (candidates: ClassAbbr[]): ComboSlot => ({
  candidates,
  confidence: candidates.length === 1 ? 1 : 0.4,
  provenance: 'inferred',
  because: []
})

function interval(startTs: number, endTs: number | null, slots: ComboSlot[]): ComboInterval {
  return {
    id: `ci${String(startTs)}`,
    startTs,
    endTs,
    startLo: startTs,
    startHi: startTs,
    endLo: endTs,
    endHi: endTs,
    startReason: 'logStart',
    expectedSlots: slots.length === 3 ? 3 : 2,
    slots,
    levelLo: null,
    levelHi: null,
    evidenceCount: slots.length,
    userLocked: false
  }
}

/** A tiny hand-built dataset: two spells, two classes' skills, one disputed discipline. */
const DATA: LevelUnlockData = {
  spells: [
    { name: 'Cure Blindness', at: [{ cls: 'CLR', level: 12 }, { cls: 'PAL', level: 22 }], mana: 20 },
    { name: 'Word of Health', at: [{ cls: 'CLR', level: 12 }], castTimeMs: 2500, durationMs: 0 },
    { name: 'Shield of Words', at: [{ cls: 'CLR', level: 30 }] }
  ],
  skills: {
    CLR: [
      { name: 'Bind Wound', level: 12, kind: 'skill' },
      { name: 'Meditate', level: 12, kind: 'skill' }
    ],
    PAL: [
      { name: 'Bind Wound', level: 12, kind: 'skill' },
      { name: 'Lay on Hands', level: 1, kind: 'innate' }
    ],
    MNK: [{ name: 'Whirlwind', level: 12, kind: 'disc', dispute: "the Disciplines page strikes MNK through" }]
  }
}

/** The named spell row, which MUST be there — so the assertions read about the row, not the null. */
function spellRow(u: LevelUnlocks, name: string): UnlockRow {
  const row = u.spells.find((r) => r.name === name)
  assert.ok(row, `no ${name} row at level ${String(u.level)}`)
  return row
}

// ---- the combo join (law 10) -------------------------------------------------------------

test('a fully resolved loadout is exact and NOT ambiguous', () => {
  const c = comboClassesOf(interval(0, null, [slot(['CLR']), slot(['PAL'])]))
  assert.deepEqual(c.resolved, ['CLR', 'PAL'])
  assert.deepEqual(c.candidates, [])
  assert.equal(c.ambiguous, false)
  assert.deepEqual(comboClassSet(c), ['CLR', 'PAL'])
})

test('a NARROWED slot contributes its candidates and flags the whole answer ambiguous', () => {
  const c = comboClassesOf(interval(0, null, [slot(['ROG']), slot(['CLR', 'PAL'])]))
  assert.deepEqual(c.resolved, ['ROG'])
  assert.deepEqual(c.candidates, ['CLR', 'PAL'])
  assert.equal(c.ambiguous, true)
  assert.deepEqual(comboClassSet(c), ['CLR', 'PAL', 'ROG'])
})

test('an UNKNOWN slot (every class) contributes nothing — sixteen classes is not a loadout', () => {
  const c = comboClassesOf(interval(0, null, [slot(['ROG']), slot([...CLASS_ABBRS])]))
  assert.deepEqual(c.resolved, ['ROG'])
  assert.deepEqual(c.candidates, [])
  assert.equal(c.ambiguous, true)
})

test('no interval at all is "we do not know yet", never an empty loadout', () => {
  const c = comboClassesOf(null)
  assert.deepEqual(comboClassSet(c), [])
  assert.equal(c.ambiguous, true)
})

test('the join is BY TIMESTAMP — a ding lands in the interval that covered it', () => {
  const intervals = [
    interval(1000, 2000, [slot(['CLR']), slot(['PAL'])]),
    interval(2000, null, [slot(['ROG']), slot(['BER'])])
  ]
  assert.deepEqual(comboClassSet(comboClassesAt(intervals, 1500)), ['CLR', 'PAL'])
  assert.deepEqual(comboClassSet(comboClassesAt(intervals, 9999)), ['BER', 'ROG'])
  // Before the first interval: unknown, not the first one's classes.
  assert.deepEqual(comboClassSet(comboClassesAt(intervals, 10)), [])
})

// ---- the level fold ----------------------------------------------------------------------

const CLR_PAL = comboClassesOf(interval(0, null, [slot(['CLR']), slot(['PAL'])]))

test('a level lists only what THESE classes gain at THAT level', () => {
  const u = unlocksAtLevel(DATA, CLR_PAL, 12)
  assert.deepEqual(u.spells.map((r) => r.name), ['Cure Blindness', 'Word of Health'])
  assert.deepEqual(u.skills.map((r) => r.name), ['Bind Wound', 'Meditate'])
  assert.deepEqual(unlockCounts(u), { spells: 2, skills: 2 })
  // Cure Blindness is CLR 12 / PAL 22: at 12 it is a CLERIC row, and says so with one chip.
  assert.deepEqual(u.spells[0].classes, ['CLR'])
})

test('one thing two classes both gain is ONE row wearing two chips, never two rows', () => {
  const u = unlocksAtLevel(DATA, CLR_PAL, 12)
  const bindWound = u.skills.find((r) => r.name === 'Bind Wound')
  assert.deepEqual(bindWound?.classes, ['CLR', 'PAL'])
  assert.equal(u.skills.filter((r) => r.name === 'Bind Wound').length, 1)
})

test('a spell the wiki carries TWICE is one row — a bookkeeping duplicate never inflates a count', () => {
  const dupes: LevelUnlockData = {
    spells: [
      { name: 'Imbue Emerald', at: [{ cls: 'CLR', level: 29 }] },
      { name: 'Imbue Emerald', at: [{ cls: 'CLR', level: 29 }], mana: 100 }
    ],
    skills: {}
  }
  const clr = comboClassesOf(interval(0, null, [slot(['CLR']), slot(['CLR'])]))
  assert.deepEqual(unlockCounts(unlocksAtLevel(dupes, clr, 29)), { spells: 1, skills: 0 })
})

test('a class OUTSIDE the loadout contributes nothing, however loudly the DB states it', () => {
  const u = unlocksAtLevel(DATA, CLR_PAL, 12)
  assert.equal(u.skills.some((r) => r.name === 'Whirlwind'), false)
})

test('a disputed row is CARRIED with the wiki’s own sentence, never dropped', () => {
  const mnk = comboClassesOf(interval(0, null, [slot(['MNK']), slot(['MNK'])]))
  const u = unlocksAtLevel(DATA, mnk, 12)
  assert.equal(u.skills.length, 1)
  assert.equal(u.skills[0].kind, 'disc')
  assert.match(u.skills[0].dispute ?? '', /strikes MNK through/)
})

test('an unknown loadout answers empty rather than scanning the whole game', () => {
  const u = unlocksAtLevel(DATA, comboClassesOf(null), 12)
  assert.deepEqual(unlockCounts(u), { spells: 0, skills: 0 })
  assert.equal(u.ambiguous, true)
})

test('the levels a loadout has anything to say about come back ascending', () => {
  assert.deepEqual(unlockLevels(DATA, ['CLR']), [12, 30])
  assert.deepEqual(unlockLevels(DATA, ['PAL']), [1, 12, 22])
})

// ---- the toast subtitle ------------------------------------------------------------------

test('the subtitle counts both lists, singular and plural', () => {
  assert.equal(levelUpSubtitle(unlocksAtLevel(DATA, CLR_PAL, 12)), '2 new spells · 2 new skills')
  assert.equal(levelUpSubtitle(unlocksAtLevel(DATA, CLR_PAL, 30)), '1 new spell')
  assert.equal(levelUpSubtitle(unlocksAtLevel(DATA, CLR_PAL, 1)), '1 new skill')
})

test('a level that unlocks NOTHING gets no subtitle — the toast still celebrates it', () => {
  assert.equal(levelUpSubtitle(unlocksAtLevel(DATA, CLR_PAL, 13)), undefined)
})

test('an ambiguous loadout says so — the counts are an upper bound and the card admits it', () => {
  const narrowed = comboClassesOf(interval(0, null, [slot(['CLR', 'PAL']), slot([...CLASS_ABBRS])]))
  const sub = levelUpSubtitle(unlocksAtLevel(DATA, narrowed, 12))
  assert.match(sub ?? '', /~ambiguous loadout$/)
})

// ---- the REAL committed dataset ----------------------------------------------------------

const REAL = buildLevelUnlocks()

test('the committed dataset carries both halves at real scale', () => {
  // Floors under what the tree measures today (1,455 spells with pairs / 16 classes).
  assert.ok(REAL.spells.length >= 1400, `spells with stated levels: ${String(REAL.spells.length)}`)
  assert.equal(Object.keys(REAL.skills).length, CLASS_ABBRS.length)
  assert.ok((REAL.scrapedAt ?? '').length > 0)
})

test('BER, MNK and WAR are SKILLS-ONLY — zero Spellpage spells at any level, and that is not an error', () => {
  for (const cls of ['BER', 'MNK', 'WAR'] as ClassAbbr[]) {
    const combo = comboClassesOf(interval(0, null, [slot([cls]), slot([cls])]))
    let spells = 0
    let skills = 0
    for (let level = 1; level <= 65; level++) {
      const u = unlocksAtLevel(REAL, combo, level)
      spells += u.spells.length
      skills += u.skills.length
    }
    assert.equal(spells, 0, `${cls} must have no Spellpage spells`)
    assert.ok(skills >= 10, `${cls} must still gain skills (${String(skills)})`)
  }
})

test('a caster loadout gains real spells at real levels, with the card fields the hover prints', () => {
  const combo = comboClassesOf(interval(0, null, [slot(['ENC']), slot(['CLR'])]))
  let levelsWithSpells = 0
  let withDetail = 0
  for (let level = 1; level <= 60; level++) {
    const u = unlocksAtLevel(REAL, combo, level)
    if (u.spells.length > 0) levelsWithSpells++
    for (const row of u.spells) {
      if (row.spell?.castTimeMs !== undefined || row.spell?.mana !== undefined) withDetail++
    }
  }
  assert.ok(levelsWithSpells >= 20, `levels with new spells: ${String(levelsWithSpells)}`)
  assert.ok(withDetail >= 50, `spell rows carrying card fields: ${String(withDetail)}`)
})

test('JOS-415: a necro gets Leach at 9 and NOT at 12 — the duplicate page no longer places it twice', () => {
  // Reported 6AT44D (v1.5.0): "For a necro, on level up to level 12. Shows Leach beting a spell.
  // But leach was learned at lvl 9 for a necro." The wiki carries TWO pages whose `spellname` is
  // `Leach` — pageid 46874 (titled `Leech`, `Necromancer - Level 9`) and pageid 50162 (titled
  // `Leach`, `Necromancer - Level 12 Recourse Effect`) — so `buildLevelUnlocks` emitted a row at
  // each level and the panel drew a card at both. eqlwiki's OWN Necromancer spell list places the
  // spell once, at level 9; its level-12 rows are Bind Affinity, Convoke Shadow and Lifedraw.
  //
  // The correction (spellCorrectionsList.ts, the seventh drift class) writes EVERY row of the name,
  // which is what makes this assertion possible: half of it would leave the level-12 card exactly
  // where it was. Both halves are pinned, because "it shows at 9" and "it does not show at 12" are
  // the two different things that were reported.
  const nec = comboClassesOf(interval(0, null, [slot(['NEC']), slot(['NEC'])]))
  const nine = unlocksAtLevel(REAL, nec, 9).spells.map((r) => r.name)
  const twelve = unlocksAtLevel(REAL, nec, 12).spells.map((r) => r.name)
  assert.ok(nine.includes('Leach'), `level 9: ${nine.join(', ')}`)
  assert.ok(!twelve.includes('Leach'), `level 12 must not list Leach: ${twelve.join(', ')}`)
  // ONE card, not two: the renderer folds by name within a level, and both DB rows now say 9.
  assert.equal(nine.filter((n) => n === 'Leach').length, 1)
  // The level-12 card is not empty — the wiki's own list for that level survives untouched.
  assert.ok(twelve.length > 0, 'level 12 should still carry the necro spells the wiki does place there')
})

test('the innates the structure derived are placed: PAL Lay on Hands @1, SHD Harm Touch @1', () => {
  const pal = comboClassesOf(interval(0, null, [slot(['PAL']), slot(['SHD'])]))
  const u = unlocksAtLevel(REAL, pal, 1)
  const innates = u.skills.filter((r) => r.kind === 'innate').map((r) => r.name)
  assert.ok(innates.includes('Lay on Hands'), innates.join(', '))
  assert.ok(innates.includes('Harm Touch'), innates.join(', '))
})

/** Rows a player has confirmed in EQ Legends — `CONFIRMED_UNLOCKS` in src/main/data/levelUnlocks.ts. */
const CONFIRMED = new Set(['RNG:Disrupting Shot'])

test('every UNCONFIRMED non-Rogue discipline row is LABELED disputed; every Rogue one is not', () => {
  let disputed = 0
  for (const [cls, rows] of Object.entries(REAL.skills)) {
    for (const row of rows ?? []) {
      if (row.kind !== 'disc') continue
      if (cls === 'ROG') assert.equal(row.dispute, undefined, `ROG ${row.name} must carry no dispute`)
      else if (CONFIRMED.has(`${cls}:${row.name}`)) {
        assert.equal(row.dispute, undefined, `${cls} ${row.name} was confirmed in game — no chip`)
      } else {
        assert.match(row.dispute ?? '', /only Rogue poison disciplines/, `${cls} ${row.name}`)
        disputed++
      }
    }
  }
  // BER 2 + MNK 10 = 12 today (RNG's one row is confirmed); a floor, a re-scrape may find more.
  assert.ok(disputed >= 12, `disputed discipline rows: ${String(disputed)}`)
})

test('Disrupting Shot reads level 20 for a Ranger, with NO disputed chip (JOS-351)', () => {
  // The reporter and the owner both have it at 20 on Legends, so the wiki's whole-table strike
  // through of RNG disciplines is overridden for this row — and RNG's table is only this row.
  const rng = comboClassesOf(interval(0, null, [slot(['RNG']), slot(['RNG'])]))
  const u = unlocksAtLevel(REAL, rng, 20)
  const row = u.skills.find((r) => r.name === 'Disrupting Shot')
  assert.ok(row, `no Disrupting Shot at RNG 20: ${u.skills.map((r) => r.name).join(', ')}`)
  assert.equal(row.kind, 'disc')
  assert.equal(row.level, 20)
  assert.equal(row.dispute, undefined, 'Disrupting Shot must not wear the disputed chip')
  // And it appears at NO other level — a confirmation that also moved the row would be a new claim.
  for (let level = 1; level <= 65; level++) {
    if (level === 20) continue
    const other = unlocksAtLevel(REAL, rng, level).skills.find((r) => r.name === 'Disrupting Shot')
    assert.equal(other, undefined, `Disrupting Shot also placed at ${String(level)}`)
  }
})

test('a real ding produces a real subtitle — the exact string the toast would print', () => {
  const combo = comboClassesOf(interval(0, null, [slot(['CLR']), slot(['PAL']), slot(['ENC'])]))
  const u = unlocksAtLevel(REAL, combo, 24)
  const sub = levelUpSubtitle(u)
  assert.ok(sub && /new spell/.test(sub), `level 24 CLR/PAL/ENC subtitle: ${String(sub)}`)
  assert.equal(u.ambiguous, false)
  // Every row names at least one class IN the loadout — the join never leaks a stranger's unlock.
  for (const row of [...u.spells, ...u.skills]) {
    assert.ok(row.classes.every((c) => ['CLR', 'PAL', 'ENC'].includes(c)), `${row.name}: ${row.classes.join('/')}`)
  }
})

// ---- what a row says beyond its name (JOS-391) --------------------------------------------
//
// Four statements were added to the unlock row and each has a different failure mode, so each
// gets its own test. The ownership and replaces WORDING is pure over hand-built data (a class's
// own ladder is not this suite's subject — tests/spellLineLookup.test.mts owns it); the last two
// check that the COMMITTED dataset actually carries the fields, because a join that silently
// produces nothing is exactly what a floors test is for.

test('already yours names the loadout class that bought it EARLIER, and only those', () => {
  // Cure Blindness: CLR 12, PAL 22. Viewed at 22 for a CLR/PAL loadout, the cleric already has it.
  const combo = comboClassesOf(interval(0, null, [slot(['CLR']), slot(['PAL'])]))
  const row = spellRow(unlocksAtLevel(DATA, combo, 22), 'Cure Blindness')
  assert.deepEqual(row.earlier, [{ cls: 'CLR', level: 12 }])
  assert.equal(ownershipPhrase(row, new Set(['CLR', 'PAL'])), 'already yours (CLR 12)')

  // Viewed at 12 the cleric is gaining it NOW, so there is nothing earlier to claim.
  const at12 = spellRow(unlocksAtLevel(DATA, combo, 12), 'Cure Blindness')
  assert.equal(at12.earlier, undefined)
  assert.equal(ownershipPhrase(at12, new Set(['CLR', 'PAL'])), null)

  // A PALADIN-ONLY loadout at 22 has nobody who bought it earlier — the claim is about YOUR
  // classes, never about the game.
  const palOnly = comboClassesOf(interval(0, null, [slot(['PAL'])]))
  assert.equal(spellRow(unlocksAtLevel(DATA, palOnly, 22), 'Cure Blindness').earlier, undefined)
})

test('an UNRESOLVED slot marks the ownership claim, it does not suppress it', () => {
  // {CLR,PAL} narrows to two candidates and resolves neither. At 22 the row still knows a class
  // that could have it at 12 — and says so with the app's one marker for a narrowed loadout.
  const combo = comboClassesOf(interval(0, null, [slot(['CLR', 'PAL'])]))
  const row = spellRow(unlocksAtLevel(DATA, combo, 22), 'Cure Blindness')
  assert.deepEqual(row.earlier, [{ cls: 'CLR', level: 12 }])
  assert.equal(ownershipPhrase(row, new Set<string>()), '~already yours (CLR 12)')
  // Resolve the cleric and the tilde comes off.
  assert.equal(ownershipPhrase(row, new Set(['CLR'])), 'already yours (CLR 12)')
})

test('two loadout classes gaining it at the SAME level get the quiet `also`, not `already yours`', () => {
  const data: LevelUnlockData = {
    spells: [{ name: 'Sense Undead', at: [{ cls: 'CLR', level: 27 }, { cls: 'PAL', level: 27 }] }],
    skills: {}
  }
  const combo = comboClassesOf(interval(0, null, [slot(['CLR']), slot(['PAL'])]))
  const row = unlocksAtLevel(data, combo, 27).spells[0]
  assert.deepEqual(row.classes, ['CLR', 'PAL'])
  assert.equal(row.earlier, undefined)
  assert.equal(ownershipPhrase(row, new Set(['CLR', 'PAL'])), 'also PAL 27')
})

test('the replaces phrase is scoped to the row own classes, and dedupes', () => {
  const row: UnlockRow = {
    kind: 'spell',
    name: 'Healing',
    classes: ['CLR'],
    level: 10,
    spell: {
      name: 'Healing',
      at: [{ cls: 'CLR', level: 10 }, { cls: 'SHM', level: 19 }],
      replaces: [
        { name: 'Light Healing', cls: 'CLR' },
        { name: 'Light Healing', cls: 'SHM' }
      ]
    }
  }
  assert.equal(replacesPhrase(row), 'replaces Light Healing (CLR)', 'the shaman answer is not this row')
  assert.equal(replacesPhrase({ ...row, classes: ['SHM'], level: 19 }), 'replaces Light Healing (SHM)')
  // Two classes at once print both, because a trio really does retire two spells.
  assert.equal(
    replacesPhrase({ ...row, classes: ['CLR', 'SHM'] }),
    'replaces Light Healing (CLR), Light Healing (SHM)'
  )
  // A row with no line says nothing.
  assert.equal(replacesPhrase({ kind: 'spell', name: 'X', classes: ['CLR'], level: 1 }), null)

  // THE SAME ANSWER UNJOINED (JOS-392): the panel hangs the spell card off each replaced NAME, so
  // the parts are exported and the phrase is COMPOSED from them. Same scoping, same dedupe, same
  // order — a renderer re-splitting the sentence on ` (` would be a second parser for it.
  assert.deepEqual(replacesEntries(row), [{ name: 'Light Healing', cls: 'CLR' }])
  assert.deepEqual(replacesEntries({ ...row, classes: ['CLR', 'SHM'] }), [
    { name: 'Light Healing', cls: 'CLR' },
    { name: 'Light Healing', cls: 'SHM' }
  ])
  assert.deepEqual(replacesEntries({ kind: 'spell', name: 'X', classes: ['CLR'], level: 1 }), [])
})

/** The committed dataset's row for a spell, which must exist for the assertions beneath it. */
function realSpell(name: string): UnlockSpell {
  const s = REAL.spells.find((x) => x.name === name)
  assert.ok(s, `the committed dataset carries ${name}`)
  return s
}

test('the committed dataset carries real figures and real replaces', () => {
  // Read at the LOWEST level any class gains it (WIZ 34), not at the level being browsed.
  const anarchy = realSpell('Anarchy').metrics
  assert.equal(anarchy?.damage, 273)
  assert.ok((anarchy?.damagePerMana ?? 0) > 2)
  assert.equal(anarchy?.hot, undefined)

  const healing = realSpell('Healing')
  assert.ok(healing.replaces?.some((r) => r.cls === 'CLR' && r.name === 'Light Healing'))

  // FLOORS over the whole dataset — a join that quietly produced nothing is the failure this
  // catches, and exact counts would break on the next scrape.
  const withMetrics = REAL.spells.filter((s) => s.metrics !== undefined)
  const withReplaces = REAL.spells.filter((s) => s.replaces !== undefined)
  assert.ok(withMetrics.length > 300, `${String(withMetrics.length)} spells carry figures`)
  assert.ok(withReplaces.length > 500, `${String(withReplaces.length)} spells replace something`)
  // And nothing names a spell as replacing itself.
  for (const s of withReplaces) {
    for (const r of s.replaces ?? []) {
      assert.notEqual(r.name.toLowerCase(), s.name.toLowerCase(), `${s.name} replaces itself`)
    }
  }
})

test('a real level 24 CLR/PAL/ENC row reads the way the panel prints it', () => {
  const combo = comboClassesOf(interval(0, null, [slot(['CLR']), slot(['PAL']), slot(['ENC'])]))
  const rows = unlocksAtLevel(REAL, combo, 24).spells
  const withFigures = rows.filter((r) => r.spell?.metrics !== undefined)
  assert.ok(withFigures.length > 0, `level 24 CLR/PAL/ENC: ${String(rows.length)} spells, none with figures`)
  for (const r of withFigures) {
    const parts = spellMetricsParts(r.spell?.metrics ?? {})
    assert.ok(parts.length > 0, r.name)
    // No em dashes in anything a player reads.
    for (const p of parts) assert.ok(!/[—–]/.test(p), `${r.name}: ${p}`)
  }
})
