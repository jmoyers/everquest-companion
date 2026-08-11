// JOS-140 — ONE MODEL FOR WHAT LANDS AND HOW LONG IT LASTS. The acceptances, through the REAL
// parser, the REAL BuffsModule, the REAL BuffTimersModule and the REAL projection.
//
// Three field reports converge here and each one is a test below:
//   * a Mesmerization VII bar stuck at the base rank's 24 s while the real cast runs 42-47 s
//     (report 01KZJHXJVAA7FNRDW83CTAYSF8, with slice; owner's own live session measured 31-36 s
//     on the same line). The CC half had no learner at all — JOS-126's measured root cause.
//   * a friendly Resist Magic on an ally landing on the DEBUFF overlay (report
//     01KZKVA30Y4QW0DW22ZAK1XR6Z, folded in from JOS-136). Classification was falling back to a
//     tally of the entity dispositions a spell had faded on, so a beneficial spell on somebody
//     the model was not holding as a pet classified as a debuff.
//   * phantom Focus Death bars on pets, from a sentence six spells share and none of them cast.
//
// A REPORTER'S SLICE NEVER BECOMES A FIXTURE (AGENTS.md). So every line below is a SHAPE the log
// really prints, taken from the tree's own committed fixtures or from the owner's log, with names
// and stamps substituted — the `tests/buffLandConfirmed.test.mts` precedent, and the same rule
// JOS-48's mobLifetapPlayer window follows. The shapes used here, and where each is attested:
//   `You begin casting <Spell> <rank>.`            w10-cazic-slow.log, w17-priming.log
//   `<Name> begins casting <Spell>.`               e2e/boss fixtures (Lord Nagafen), and the
//                                                   reporter slice's own two player casters
//   `You activate Quick Buff.`                     w7-quick-buff.log and fourteen others
//   `<mob> has been mesmerized.`                   w10-cazic-slow.log, g1-group-lifecycle.log
//   `Your <Spell> spell has worn off of <mob>.`    w10-cazic-slow.log, w6-rank-pairing.log
//   `<mob> has been charmed.`                      w13-charm-break-recharm.log
//   `<mob> slows down.`                            w6-rank-pairing.log
//   `<name> is resistant to magic.`                the DB's own msgCastOnOther for the Resist
//                                                   Magic family, as the reporter's burst prints it
//   `<name> feels much faster.`                    w1-current-session.log
//
// Run: `npm test`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser.ts'
import { installSpellDb, getParserConfig } from '../src/main/log/rulesets.ts'
import { loadSpellDb, spellNature, CLASSIFIED_SPELL_TYPES } from '../src/main/data/spellDb.ts'
import { BuffsModule } from '../src/main/modules/buffs.ts'
import { BuffTimersModule } from '../src/main/modules/buffTimers.ts'
import { buildTimerRows, rowsForSurface, orderTimerRows, type BuffTimerRow } from '../src/shared/buffTimers.ts'
import { SELF_CASTER, normalizeBuffTrustPrefs, addExternalCaster, removeExternalCaster } from '../src/shared/buffTrust.ts'
import type { BuffsSnap, SpellDbFile } from '../src/shared/types.ts'

const DAY = 'Sat Aug 09'
const YEAR = '2026'

/** An EQ-stamped line at `sec` seconds past 22:58:00 — the real `[Day Mon DD HH:MM:SS YYYY] ` shape. */
function at(sec: number, text: string): string {
  const h = 22 + Math.floor((58 * 60 + sec) / 3600)
  const m = Math.floor(((58 * 60 + sec) % 3600) / 60)
  const s = sec % 60
  const two = (n: number): string => String(n).padStart(2, '0')
  return `[${DAY} ${two(h)}:${two(m)}:${two(s)} ${YEAR}] ${text}`
}

interface Replay {
  buffs: BuffsSnap
  rows: BuffTimerRow[]
  timers: ReturnType<BuffTimersModule['snapshot']>['state']
}

/**
 * Replay a script through both modules, wired the way `modules/wiring.ts` wires them — ONE set of
 * cast anchors and ONE learner, shared. Constructing the CC half bare would give it a private and
 * permanently empty cast history, which is the pre-JOS-140 arrangement and not the one under test.
 */
function replay(lines: [number, string][], opts?: { observeSec?: number; trust?: string[] }): Replay {
  const db = loadSpellDb()
  installSpellDb(db)
  const buffs = new BuffsModule(db)
  buffs.reset()
  if (opts?.trust) buffs.setTrust(normalizeBuffTrustPrefs({ externals: opts.trust }))
  const timers = new BuffTimersModule(buffs.castAnchors(), buffs.spellStats())
  timers.reset()
  let seq = 0
  for (const [sec, text] of lines) {
    const ev = parseEvent(at(sec, text), seq++)
    if (!ev) continue
    buffs.onEvent(ev)
    timers.onEvent(ev)
  }
  if (opts?.observeSec != null) {
    const tick = parseEvent(at(opts.observeSec, 'x'), seq)?.ts ?? 0
    buffs.onTick(tick)
    timers.onTick(tick)
  }
  const b = buffs.snapshot().state
  const t = timers.snapshot().state
  return { buffs: b, timers: t, rows: buildTimerRows(b, t) }
}

const rowFor = (r: Replay, name: string): BuffTimerRow | undefined => r.rows.find((x) => x.name === name)
const statFor = (r: Replay, key: string): BuffsSnap['stats'][string] | undefined => r.buffs.stats[key]

// ---------------------------------------------------------------------------------------------
// ACCEPTANCE 1 — THE MEZ LEARNS (report 01KZJHXJVAA7FNRDW83CTAYSF8).
//
// The reporter's own pattern, on shapes the owner's log prints: an AE mez cast repeatedly at a
// group of same-named mobs, with two mob names that happen to be UNIQUE in their round. Only the
// unique ones can ever be measured, and that is the whole design.
// ---------------------------------------------------------------------------------------------

/** One AE round: the cast, then a landing per mob, all inside the same second the game prints. */
function mezRound(sec: number, mobs: string[]): [number, string][] {
  return [
    [sec - 1, 'You begin casting Mesmerization VII.'],
    ...mobs.map((m): [number, string] => [sec, `${m} has been mesmerized.`])
  ]
}

test('the mez LEARNS its real duration, from the only cycles that can be measured', () => {
  // Two names, one of them duplicated. `a scareling` lands twice per round and can therefore never
  // be measured; `a turmoil toad` is alone in its round and can. Two clean cycles, 43 s and 44 s,
  // which is EXACTLY the yield the JOS-126 investigation measured on the reporter's 761-line slice
  // (fifty landings, twenty-one wear-offs, two clean cycles) — the rule is doing there what it
  // does here.
  const r = replay(
    [
      ...mezRound(2, ['a turmoil toad', 'a scareling', 'a scareling']),
      [45, 'Your Mesmerization spell has worn off of a turmoil toad.'],
      [46, 'Your Mesmerization spell has worn off of a scareling.'],
      [47, 'Your Mesmerization spell has worn off of a scareling.'],
      ...mezRound(50, ['a turmoil toad', 'a scareling', 'a scareling']),
      [94, 'Your Mesmerization spell has worn off of a turmoil toad.'],
      [95, 'Your Mesmerization spell has worn off of a scareling.'],
      [96, 'Your Mesmerization spell has worn off of a scareling.'],
      ...mezRound(100, ['a turmoil toad'])
    ],
    { observeSec: 110 }
  )

  const stat = statFor(r, 'mesmerization')
  assert.ok(stat, 'the mez line must reach the Buffs tab at all — before this it never did')
  assert.equal(stat.n, 2, 'two clean cycles: the duplicated name is refused, both rounds')
  assert.equal(stat.minMs, 43_000)
  assert.equal(stat.maxMs, 44_000)
  assert.equal(stat.estimateMs, 44_000, 'max(DB floor 24 s, recent observed max 44 s)')
  assert.equal(stat.estimatorSource, 'observed')

  // AND THE BAR READS IT. This is the defect in one assertion: 24 s before, 44 s now.
  const row = rowFor(r, 'Mesmerization VII')
  assert.ok(row, 'the row is named for the RANK the cast line spelled')
  assert.equal(row.mode, 'countdown')
  assert.equal(row.durationMs, 44_000, 'the bar counts down from what the log proved, not the base rank')
})

test('…and the DB floor is what it reads until a clean cycle exists', () => {
  const r = replay(mezRound(2, ['a turmoil toad']), { observeSec: 10 })
  const row = rowFor(r, 'Mesmerization VII')
  assert.ok(row)
  assert.equal(row.durationMs, 24_000, 'the committed spells.json states 24 s for the line')
})

test('a duplicated name is ONE row with a count chip, and the wear-offs close it one at a time', () => {
  const r = replay(mezRound(2, ['a scareling', 'a scareling', 'a scareling']), { observeSec: 10 })
  const rows = r.rows.filter((x) => x.target === 'a scareling')
  assert.equal(rows.length, 1, 'three identical lines are not three rows')
  assert.equal(rows[0].count, 3, 'they are one row that says how many')

  const after = replay(
    [...mezRound(2, ['a scareling', 'a scareling', 'a scareling']), [40, 'Your Mesmerization spell has worn off of a scareling.']],
    { observeSec: 41 }
  )
  assert.equal(after.rows.filter((x) => x.target === 'a scareling')[0]?.count, 2, 'one closed, two still held')
})

test('a re-mez of the same round does not double the count', () => {
  const r = replay([...mezRound(2, ['a scareling', 'a scareling']), ...mezRound(30, ['a scareling', 'a scareling'])], {
    observeSec: 35
  })
  assert.equal(r.rows.filter((x) => x.target === 'a scareling')[0]?.count, 2, 'two mobs, re-mezzed')
})

// ---------------------------------------------------------------------------------------------
// ACCEPTANCE 2 — CLASSIFICATION IS THE SPELL'S NATURE (report 01KZKVA30Y4QW0DW22ZAK1XR6Z / JOS-136).
// ---------------------------------------------------------------------------------------------

test('THE ORACLE: every spellType the committed DB uses is classified, and none by the target', () => {
  // The table this rests on is the one the suggestion catalog already audited. Re-derived from
  // spells.json on every run, so a re-scrape that grows the vocabulary fails HERE rather than
  // silently filing a spell as a buff because nobody typed it.
  const db = JSON.parse(
    JSON.stringify(loadSpellDb().spells.map((s) => ({ spellType: s.spellType })))
  ) as SpellDbFile['spells']
  const unclassified = new Set<string>()
  for (const s of db) {
    if (s.spellType === undefined) continue
    if (!CLASSIFIED_SPELL_TYPES.has(s.spellType)) unclassified.add(s.spellType)
  }
  assert.deepEqual([...unclassified], [], 'a spellType nobody classified would fall to the unknown arm')
  // The three the reported defect turned on.
  assert.equal(spellNature('Resist Buff'), 'beneficial', 'Resist Magic is a Resist Buff, and it is a BUFF')
  assert.equal(spellNature('Detrimental'), 'detrimental')
  assert.equal(spellNature('Not A Real Type'), 'unknown', 'never guessed, and never resolved by the target')
})

test('a friendly resist buff on a named target is a BUFF row, on the buffs window', () => {
  // The reporter's shape: a Quick Buff burst landing beneficial spells on their charmed pet. The
  // sentence `<name> is resistant to disease.` is ONE spell in the DB, so the burst resolves it
  // outright; before JOS-140 it classified by the disposition its fades had landed on, and a
  // target the model was not holding as a pet tallied hostile.
  const r = replay(
    [
      [0, 'You activate Quick Buff.'],
      [3, 'a spinechiller spider is resistant to disease.']
    ],
    { observeSec: 10 }
  )
  const row = rowFor(r, 'Resist Disease')
  assert.ok(row, 'the burst landing is admitted — a Quick Buff activation IS a cast of yours')
  assert.equal(row.kind, 'buff')
  assert.equal(row.target, 'a spinechiller spider')
  assert.ok(rowsForSurface(r.rows, 'buffs').includes(row), 'and it belongs to the BUFFS window')
  assert.equal(rowsForSurface(r.rows, 'debuffs').length, 0, 'nothing beneficial reaches the debuffs window')
})

test('ONE NAME, BOTH WINDOWS: a charmed pet carries its buffs and its debuffs at once', () => {
  // The owner's amendment, stated as a property: disposition is ORTHOGONAL to nature. The charm
  // itself and a Tashani are detrimental holds ON your own pet; the haste is a buff on the same
  // entity. Nothing routes by target, so all three are correct simultaneously.
  const r = replay(
    [
      [0, 'You begin casting Cajoling Whispers.'],
      [2, 'a spinechiller spider has been charmed.'],
      [10, 'You begin casting Tashani.'],
      [12, 'a spinechiller spider glances nervously about.'],
      [20, 'You begin casting Swift Like the Wind I.'],
      [22, 'a spinechiller spider feels much faster.']
    ],
    { observeSec: 30 }
  )
  const mine = r.rows.filter((x) => x.target === 'a spinechiller spider')
  assert.ok(mine.length >= 3, `expected the pet to carry buff and debuff rows: ${mine.map((x) => x.name).join(', ')}`)
  const buffSide = rowsForSurface(mine, 'buffs').map((x) => x.name)
  const debuffSide = rowsForSurface(mine, 'debuffs').map((x) => x.name)
  assert.ok(buffSide.includes('Swift Like the Wind I'), `the haste is a buff: ${buffSide.join(', ')}`)
  assert.ok(debuffSide.includes('Tashani'), `the resist debuff is a debuff: ${debuffSide.join(', ')}`)
  assert.ok(debuffSide.includes('Cajoling Whispers'), `and so is the charm: ${debuffSide.join(', ')}`)
})

test('THE CHARM COUNTDOWN EXISTS AT ALL, and its break closes it', () => {
  // `<mob> has been charmed.` used to open nothing anywhere — there has never been a charm timer,
  // and charm-break timing is the whole game for an enchanter.
  const held = replay(
    [
      [0, 'You begin casting Cajoling Whispers.'],
      [2, 'a scareling has been charmed.']
    ],
    { observeSec: 30 }
  )
  const row = rowFor(held, 'Cajoling Whispers')
  assert.ok(row, 'a charm you cast is a hold on the mob you cast it at')
  assert.equal(row.mode, 'countdown')
  assert.equal(row.durationMs, 960_000, 'the DB states 16 minutes for that charm line')

  const broken = replay(
    [
      [0, 'You begin casting Cajoling Whispers.'],
      [2, 'a scareling has been charmed.'],
      [400, 'Your Cajoling Whispers spell has worn off of a scareling.']
    ],
    { observeSec: 401 }
  )
  assert.equal(rowFor(broken, 'Cajoling Whispers'), undefined, 'the break line clears it')
  assert.equal(statFor(broken, 'cajoling whispers')?.n, 1, 'and a clean charm cycle IS a sample')
  assert.equal(statFor(broken, 'cajoling whispers')?.maxMs, 398_000)
})

// ---------------------------------------------------------------------------------------------
// ACCEPTANCE 3 — CAST-ANCHORED ATTRIBUTION (rulings 2 and 3), including the Focus Death refusal.
// ---------------------------------------------------------------------------------------------

test('an unanchored landing produces NOTHING — the phantom-bar refusal', () => {
  // `Someone's eyes gleam with madness.` is shared by six spells and the player cast none of them.
  // The shape below is the generic one: a landing sentence with no cast of ours anywhere near it.
  const r = replay([[2, 'a scareling has been mesmerized.']], { observeSec: 10 })
  assert.deepEqual(r.rows, [], 'a broadcast with nothing of ours behind it is somebody else`s work')
  assert.equal(r.timers.holds.length, 0)
})

test('a THIRD-PERSON cast line anchors nothing until its caster is on the allowlist', () => {
  const script: [number, string][] = [
    [0, 'Othen begins casting Mesmerization.'],
    [2, 'a scareling has been mesmerized.']
  ]
  const refused = replay(script, { observeSec: 10 })
  assert.deepEqual(refused.rows, [], 'the default allowlist is empty, and that is the whole default')

  const allowed = replay(script, { observeSec: 10, trust: ['othen'] })
  const row = rowFor(allowed, 'Mesmerization')
  assert.ok(row, 'a named caster you allowed gets the IDENTICAL rule, not a looser one')
  assert.equal(row.caster, 'othen', 'and the row says whose it is')
  assert.equal(row.target, 'a scareling')
})

test('an external caster`s durations are learned SEPARATELY from your own', () => {
  // Ruling 4's second half. A duration is a fact about a caster's AAs, focus items and rank, so
  // pooling a grouped enchanter's mez with yours would give a bar wrong for both.
  const r = replay(
    [
      [0, 'Othen begins casting Mesmerization.'],
      [2, 'a scareling has been mesmerized.'],
      [33, 'Your Mesmerization spell has worn off of a scareling.'],
      [40, 'Othen begins casting Mesmerization.'],
      [42, 'a scareling has been mesmerized.']
    ],
    { observeSec: 45, trust: ['Othen'] }
  )
  const row = rowFor(r, 'Mesmerization')
  assert.ok(row)
  assert.equal(row.durationMs, 31_000, 'their observed 31 s drives their bar')
  assert.equal(
    statFor(r, 'mesmerization')?.n ?? 0,
    0,
    'and YOUR stats are untouched — the Buffs tab is a page about your own spells'
  )
})

test('a Quick Buff burst that cannot be narrowed is a FAMILY, never a coin flip', () => {
  // The activation names no spell, so a sentence several spells share stays a family: the joined
  // names, the ambiguous chip, and a duration only because these candidates agree on one.
  const r = replay(
    [
      [0, 'You activate Quick Buff.'],
      [3, 'A cool breeze slips through your mind.']
    ],
    { observeSec: 10 }
  )
  const row = r.rows.find((x) => x.ambiguous === true)
  assert.ok(row, `expected a family row: ${r.rows.map((x) => x.name).join(', ')}`)
  assert.ok((row.candidates?.length ?? 0) > 1, 'and it names every spell the sentence could be')
  assert.equal(row.mode, 'countdown', 'the candidates agree on a duration, so the number is honest')
  assert.equal(row.kind, 'buff')
})

// ---------------------------------------------------------------------------------------------
// ACCEPTANCE 4 — THE UNWITNESSED-EXPIRY CULL (owner amendment: slow a boss, then die).
// ---------------------------------------------------------------------------------------------

test('a debuff whose close nobody witnessed is culled, and mints nothing', () => {
  const script: [number, string][] = [
    [0, 'You begin casting Shiftless Deeds IV.'],
    [3, 'a scareling slows down.']
  ]
  // Inside its life: the bar is there, counting down from the DB floor.
  const live = replay(script, { observeSec: 60 })
  assert.ok(rowFor(live, 'Shiftless Deeds IV'), 'the slow is up while it is up')

  // THE BOUND TIGHTENED (JOS-156): this used to be the duration AGAIN — 150 s + 150 s, so the row
  // sat at 0s until 300 s — and it is now the flat DB timeout, 150 s + 60 s. The old assertion
  // observed at 400 s and so passed either way; it pins the boundary now, because the boundary is
  // the thing the owner ruled on.
  const beat = replay(script, { observeSec: 200 })
  assert.ok(rowFor(beat, 'Shiftless Deeds IV'), 'visibly overdue for a beat is by design, not a bug')

  const later = replay(script, { observeSec: 220 })
  assert.equal(rowFor(later, 'Shiftless Deeds IV'), undefined, 'no wear-off ever arrived, so it is not held')
  assert.equal(statFor(later, 'shiftless deeds')?.n ?? 0, 0, 'an absence of evidence is not a measurement')
})

test('JOS-156: the owner`s Tashania leaves a minute past its countdown, not eleven', () => {
  // THE RULING'S OWN CASE (owner, 2026-08-09 live testing): he cast Tashania on Bzzazzt at
  // 15:41:44 and was killed at 15:41:55. The wear-off prints to a character who is not there, so
  // it never arrives. Tashania's committed DB row is ELEVEN MINUTES, and under the duration-again
  // grace that debuffs used to get, the bar sat at 0s for another eleven — until 15:53 for a spell
  // cast eleven seconds before he died. It now goes 60 s past the countdown, the same bound a
  // non-self buff has had since JOS-149.
  const script: [number, string][] = [
    [0, 'You begin casting Tashania.'],
    [2, 'Bzzazzt glances nervously about.']
  ]
  const row = rowFor(replay(script, { observeSec: 60 }), 'Tashania')
  assert.ok(row, 'the debuff is up while it is up')
  assert.equal(row.durationMs, 660_000, 'and its clock is the eleven-minute DB row')

  assert.ok(rowFor(replay(script, { observeSec: 700 }), 'Tashania'), 'a beat past zero is still information')
  assert.equal(
    rowFor(replay(script, { observeSec: 730 }), 'Tashania'),
    undefined,
    'and then it goes — 60 s, not another 660 s'
  )
})

test('JOS-156: …and the cull takes the ROW without locking the learner out', () => {
  // THE REFINEMENT, and the measurement that earned it. The tight timeout removes what is SHOWN;
  // it does not remove the (spell, entity) pairing record, which keeps the hygiene cap as its own
  // bound. Deleting both — the literal reading of the ruling — is a permanent lockout: the owner's
  // Shiftless Deeds IV really runs 234 s against a 150 s DB row, so EVERY cycle is culled at 210 s,
  // 24 s before its own wear-off arrives, nothing ever mints, and the estimate can never ratchet
  // past DB + 60 s. Twenty consecutive real-length cycles measured n=0 that way.
  //
  // Where the ruling actually bites — the Tashania above, a despawned pet — nothing ever pairs with
  // the surviving record and the hygiene cap collects it minting nothing, exactly as before.
  const cycles: [number, string][] = []
  for (let i = 0; i < 5; i++) {
    const t = i * 300
    cycles.push([t, 'You begin casting Shiftless Deeds IV.'], [t + 1, 'a gnoll pup slows down.'])
    cycles.push([t + 235, 'Your Shiftless Deeds spell has worn off of a gnoll pup.'])
  }
  const r = replay(cycles, { observeSec: 1_500 })
  const stat = statFor(r, 'shiftless deeds')
  assert.equal(stat?.n, 5, 'a wear-off that arrives 24 s past the cull still mints its own span')
  assert.equal(stat?.maxMs, 234_000, 'and it is the real 234 s, not the 150 s the DB states')
  assert.equal(stat?.estimatorSource, 'observed', 'so the learner climbs off the floor instead of being pinned to it')
})

test('…and a BUFF of yours is not culled, because your clock is the one that pauses', () => {
  const r = replay(
    [
      [0, 'You begin casting Swift Like the Wind I.'],
      [3, 'You feel much faster.']
    ],
    { observeSec: 2_000 }
  )
  assert.ok(rowFor(r, 'Swift Like the Wind I'), 'a self buff keeps the hygiene cap as its only long stop')
})

// ---------------------------------------------------------------------------------------------
// ACCEPTANCE 5 — THE SAME CULL ON A BUFF THAT IS NOT YOURS (JOS-149, owner ruling 2026-08-09).
//
// The owner's screenshot: `Focus Death` at 0s on two pets that had been gone for weeks, raised
// again by every startup replay. The cast anchor behind those rows is GENUINE — `You begin
// casting Focus Death.` appears five times in the owner's log on Jul 19 — so this is not the
// third-person refusal above. It is the exemption in acceptance 4 being too wide: JOS-140 spared
// the whole buffs window on the argument that a wear-off prints to you, which is a statement
// about YOUR buffs. The game does print `Your pet's <Spell> spell has worn off.` (412 times
// across 51 spells in the owner's log, twice for Focus Death), but it resolves against the
// CURRENT pet — so the instant a pet despawns, every row bound to it is unclosable by
// construction, and no later line can name it.
// ---------------------------------------------------------------------------------------------

/** The owner's own two lines, verbatim shapes: the named cast, then the six-spell gleam sentence. */
const PET_BUFF: [number, string][] = [
  [0, 'You begin casting Focus Death.'],
  [7, "Giber's eyes gleam with madness."]
]

test('a PET buff mid-duration tracks exactly as before — the cull changes nothing about it', () => {
  const live = replay(PET_BUFF, { observeSec: 1_800 })
  const row = rowFor(live, 'Focus Death')
  assert.ok(row, `the pet buff is up while it is up: ${live.rows.map((x) => x.name).join(', ')}`)
  assert.equal(row.kind, 'buff', 'a beneficial spell on a pet is a BUFF row, whoever it is on')
  assert.equal(row.target, 'Giber')
  assert.equal(row.mode, 'countdown')
  assert.equal(row.durationMs, 3_600_000, 'the DB floor is its clock, untouched')
  // AND THE NAME IS THE ANCHOR'S DOING: `Someone 's eyes gleam with madness.` is Augment Death,
  // Augmentation of Death, Focus Death, Intensify Death, Savage Spirit and Strengthen Death. The
  // named cast in window narrows the six to the one the player actually cast.
  assert.equal(row.ambiguous ?? false, false, 'a named anchor resolves the family outright')
})

test('a PET buff nobody can see expire times out a minute past its countdown', () => {
  // A beat past zero is still information — the row says the app is waiting for a line.
  const overdue = replay(PET_BUFF, { observeSec: 3_650 })
  assert.ok(rowFor(overdue, 'Focus Death'), 'visibly overdue for a beat is by design')

  // And then it goes. The owner's ruling is that it does NOT get the debuff rule's DB grace here
  // (which would wait the duration again): an hour of 0s on a pet buff IS the reported defect.
  const gone = replay(PET_BUFF, { observeSec: 3_700 })
  assert.equal(rowFor(gone, 'Focus Death'), undefined, 'a close nobody can witness stops being waited for')
  assert.equal(statFor(gone, 'focus death')?.n ?? 0, 0, 'and a timeout mints nothing, exactly like the debuff cull')
})

// ---------------------------------------------------------------------------------------------
// THE WINDOW ORDER (owner amendment): the debuffs surface reads soonest-first, flat.
// ---------------------------------------------------------------------------------------------

test('the flat order is ascending time remaining, with the unnumbered rows after it', () => {
  const r = replay(
    [
      // A long charm, a short mez, and a slow between them — three targets, three clocks.
      [0, 'You begin casting Cajoling Whispers.'],
      [2, 'a scareling has been charmed.'],
      [10, 'You begin casting Mesmerization VII.'],
      [12, 'a turmoil toad has been mesmerized.'],
      [20, 'You begin casting Shiftless Deeds IV.'],
      [22, 'a glare lord slows down.']
    ],
    { observeSec: 25 }
  )
  const flat = orderTimerRows(rowsForSurface(r.rows, 'debuffs'), 'none')
  assert.deepEqual(
    flat.map((x) => x.name),
    ['Mesmerization VII', 'Shiftless Deeds IV', 'Cajoling Whispers'],
    'soonest to expire first, across every target — 24 s, then 150 s, then 16 minutes'
  )
  // And the grouped arrangement is still the projection's own order, untouched.
  assert.deepEqual(
    orderTimerRows(rowsForSurface(r.rows, 'debuffs'), 'target'),
    rowsForSurface(r.rows, 'debuffs'),
    'grouping by target hands back the model order, and sorts nothing'
  )
})

// ---------------------------------------------------------------------------------------------
// THE ALLOWLIST's own rules — the normalizer both ends share.
// ---------------------------------------------------------------------------------------------

test('the allowlist normalizer refuses what could never match a cast line', () => {
  assert.deepEqual(normalizeBuffTrustPrefs(undefined), { externals: [] }, 'absent is the shipped default')
  assert.deepEqual(normalizeBuffTrustPrefs({ externals: 'Othen' }), { externals: [] }, 'not a list, so no names')
  assert.deepEqual(
    normalizeBuffTrustPrefs({ externals: ['Othen', 'othen', '  ', 42, 'you', 'self', 'a[b'] }),
    { externals: ['Othen'] },
    'deduped case-insensitively, and nothing that is not a bare name survives'
  )
  const one = addExternalCaster({ externals: [] }, 'Othen')
  assert.deepEqual(one.externals, ['Othen'])
  assert.equal(addExternalCaster(one, 'OTHEN'), one, 'a duplicate is a no-op, object identity and all')
  assert.deepEqual(removeExternalCaster(one, 'othen').externals, [], 'and removal is case-insensitive too')
})

test('SELF is a sentinel, not a name anybody can claim', () => {
  assert.deepEqual(normalizeBuffTrustPrefs({ externals: [SELF_CASTER] }), { externals: [] })
})

// ---------------------------------------------------------------------------------------------
// THE CC ROSTER's nature — the assumption the row routing rests on, re-derived every run.
// ---------------------------------------------------------------------------------------------

test('every crowd-control spell the parser recognizes is DETRIMENTAL in the DB', () => {
  // A `cc` hold is drawn on the debuffs window by construction. That is only honest while the
  // roster and the nature table agree; if a future scrape ever types a mez as beneficial, the
  // routing would be a lie and this fails instead.
  const db = loadSpellDb()
  const cc = getParserConfig().ccSpell
  const members = db.spells.filter((s) => cc.test(s.name))
  assert.ok(members.length > 0, 'the roster matched nothing — the roster or the DB moved')
  for (const s of members) {
    assert.notEqual(spellNature(s.spellType), 'beneficial', `${s.name} is a crowd-control spell typed beneficial`)
  }
})
