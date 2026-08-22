// JOS-412 — THE REGISTRY VALIDATOR FOR SUBJECT PLACEHOLDERS, AND ITS CENSUS.
//
// THE REPORT THAT NAMES IT: GitHub issue 43 and in-app report 01M0BSTF14C2CHJ3D38BACGDZC, a shaman
// whose level-34 `Curse` never reached the debuff tracker. It is `Odium` — the level-43 rank of the
// SAME shaman line — one rank down, and Odium was swept ten days earlier in JOS-174. The sweep is a
// LIST, and a list only knows about the reports that reached it; nothing in the tree had ever asked
// which OTHER spells were in that state. The owner's ruling was to fix Curse and sweep the class.
//
// `src/main/data/spellSubjectAudit.ts` is the question, asked over the effective registry. This
// file is the ANSWER, pinned — which is the half that fails a build. Read that module's header for
// the mechanism (`castOnOtherSuffix` keys on a `Someone ` subject and on nothing else) and for why
// the two verdicts need different repairs.
//
// FOUR THINGS ARE PINNED HERE:
//
//   1. THE RULES, over hand-built lists: which messages the validator flags, what `restored` says,
//      and the `spellUnreachable` distinction that keeps a duplicate era row from reading as a lost
//      spell.
//   2. THE CENSUS, over the committed registry — every row, by name, in both verdicts. A re-scrape
//      that puts a spell into this state fails HERE, with the spell named, instead of waiting for a
//      user to notice a bar that never opens. That is the JOS-162 move: run the repo's own
//      validators against the live data and read what they say.
//   3. THE REPAIR IS REAL: every `wrongSubject` row's `restored` sentence actually keys the suffix
//      table, so the census is telling a reader the truth about what a correction would cost.
//   4. THE VALIDATOR AND THE SWEEP AGREE: no spell the corrections overlay has already fixed is
//      still in the census, and no census entry is silently corrected.
//
// WHAT THE CENSUS IS NOT. It is not a to-do list, and reducing it to zero would be the blanket
// subject-stripper JOS-174 measured and refused: 19 of the wrong-token sentences occur ZERO times
// in the owner's 2,138,726-line log, and minting a tail for a sentence nobody has observed puts it
// in a shared namespace competing with 665 others. A row leaves this file when a log proves it, or
// when the family already owns the sentence — never because the list looks long.
//
// Run: `npm test`.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSpellDb,
  castOnOtherSuffix,
  loadSpellDb,
  matchCastOnOtherSuffix
} from '../src/main/data/spellDb.ts'
import { auditSpellSubjects, restoreSubject } from '../src/main/data/spellSubjectAudit.ts'
import { applySpellCorrections, SPELL_CORRECTIONS } from '../src/main/data/spellCorrections.ts'
import { SUBJECT_PLACEHOLDER_CORRECTIONS } from '../src/main/data/spellCorrectionsSubjects.ts'
import { parseEvent } from '../src/main/log/parser.ts'
import { installSpellDb } from '../src/main/log/rulesets.ts'
import { BuffsModule } from '../src/main/modules/buffs.ts'
import { BuffTimersModule } from '../src/main/modules/buffTimers.ts'
import { buildTimerRows, rowsForSurface } from '../src/shared/buffTimers.ts'
import { POISON_PROCS } from '../src/shared/poisons.ts'
import type { SpellDbFile, SpellEntry } from '../src/shared/types.ts'
import spellsJson from '../src/main/data/spells.json' with { type: 'json' }

/** A registry row with only the fields the validator reads. */
function spell(name: string, fields: Partial<SpellEntry> = {}): SpellEntry {
  return { name, durationMs: null, illusion: false, ...fields }
}

const audit = auditSpellSubjects(loadSpellDb().spells)

// ---------------------------------------------------------------------------------------------
// 1 — THE RULES
// ---------------------------------------------------------------------------------------------

test('a landing the suffix table CAN key is not flagged, whatever else is odd about it', () => {
  const r = auditSpellSubjects([
    spell('Keyed', { msgCastOnOther: 'Someone looks tranquil.' }),
    // The wiki's spaced possessive, which `castOnOtherSuffix` handles and this must not second-guess.
    spell('Possessive', { msgCastOnOther: "Someone 's face contorts." }),
    // No third-person message at all: nothing to key, nothing to flag — a spell may simply not have
    // one, and the placeholder pass has already blanked the stubs that pretend to.
    spell('Silent', { msgCastOnYou: 'You feel different.' })
  ])
  assert.deepEqual(r.landings, [])
  assert.deepEqual(r.unreachable, [])
})

test('a WRONG placeholder is flagged, and `restored` states the one-token repair', () => {
  const r = auditSpellSubjects([
    spell('Curseish', { msgCastOnOther: 'Target has been cursed.' }),
    spell('Possessive', { msgCastOnOther: "Player's eyes glow." }),
    spell('Underscored', { msgCastOnOther: "Other_Player's hands glow." }),
    spell('Named', { msgCastOnOther: 'Soandso begins to bleed.' })
  ])
  assert.deepEqual(
    r.landings.map((x) => [x.verdict, x.restored]),
    [
      ['wrongSubject', 'Someone has been cursed.'],
      ['wrongSubject', "Someone's eyes glow."],
      ['wrongSubject', "Someone's hands glow."],
      ['wrongSubject', 'Someone begins to bleed.']
    ],
    'the sentence is the wiki`s own; only the subject token moves'
  )
  assert.equal(r.wrongSubject, 4)
  assert.equal(r.noSubject, 0)
})

test('a token is only a token at the START and only as a whole word', () => {
  // The refusal that keeps the validator from rewriting prose. `Targeted`, and a `Target` in the
  // middle of a sentence, are words — a subject placeholder is the first thing on the line or it is
  // not a placeholder at all.
  assert.equal(restoreSubject('Targeted energy washes over them.'), null)
  assert.equal(restoreSubject('The spirits Target their prey.'), null)
  assert.equal(restoreSubject('Playerful winds rise.'), null)
  assert.equal(restoreSubject('Target has been cursed.'), 'Someone has been cursed.')
})

test('a CROPPED subject is flagged too, and says it has no token to swap', () => {
  const r = auditSpellSubjects([
    spell('Cropped', { msgCastOnOther: "'s wounds fester." }),
    spell('Verbfirst', { msgCastOnOther: 'fades away.' })
  ])
  assert.deepEqual(
    r.landings.map((x) => [x.verdict, x.restored]),
    [
      ['noSubject', null],
      ['noSubject', null]
    ],
    'the repair here is a CLAIM about a cropped sentence, not a token swap, so the validator declines to state one'
  )
  assert.equal(r.noSubject, 2)
})

test('a DUPLICATE row is flagged but the SPELL is not counted lost', () => {
  // The scrape carries era/rank duplicates, and `spellCorrections.rowsFor` writes a message
  // correction to the FIRST row of a name only — so a duplicate row's wrong subject cannot be
  // corrected by this mechanism and costs nothing, because the spell is reachable through the row
  // that keys. A census that could not draw this distinction would report three phantom losses.
  const r = auditSpellSubjects([
    spell('Twice', { msgCastOnOther: "Someone 's image shimmers." }),
    spell('Twice', { msgCastOnOther: "Player's image shimmers." }),
    spell('Once', { msgCastOnOther: 'Target turns into a newt.' })
  ])
  assert.deepEqual(
    r.landings.map((x) => [x.spell, x.spellUnreachable]),
    [
      ['Twice', false],
      ['Once', true]
    ]
  )
  assert.deepEqual(r.unreachable, ['Once'], 'only the spell with NO keyable row is a loss')
})

test('the MIRROR defect: a first-person field naming a third party can never match either', () => {
  // `castOnYou` and `wearsOff` are EXACT-TEXT maps — no name is spliced in, so the whole message is
  // the key and the log will never print the literal word `Target`. `Someone` is just as dead there
  // as the others, which is why this rule tests the full vocabulary and the landing rule does not.
  const r = auditSpellSubjects([
    spell('Wrong', { msgCastOnYou: 'Target feels warm.', msgWearsOff: 'Someone cools down.' }),
    spell('Right', { msgCastOnYou: 'You feel warm.', msgWearsOff: 'You cool down.' })
  ])
  assert.deepEqual(r.firstPerson, [
    { spell: 'Wrong', field: 'msgCastOnYou', message: 'Target feels warm.' },
    { spell: 'Wrong', field: 'msgWearsOff', message: 'Someone cools down.' }
  ])
})

// ---------------------------------------------------------------------------------------------
// 2 — THE CENSUS, over the committed registry
// ---------------------------------------------------------------------------------------------

/**
 * Rows whose message carries a subject placeholder that simply is not `Someone`. The repair is a
 * one-token swap, so every name here is a correction somebody could write TODAY — and the reason
 * they are not written is the awaiting-sample law, not doubt about the sentence: measured over the
 * owner's 2,138,726-line log on 2026-08-19, every restored shape below occurs ZERO times.
 *
 * TWO OF THEM ARE A DIFFERENT ANSWER. `Illusion: Air Elemental` and `Ring of South Ro` are
 * DUPLICATE rows of names whose first row already keys (see `REACHABLE_ANYWAY` below); their wrong
 * subject is unfixable by the corrections mechanism and costs nothing.
 *
 * AND EIGHT OF THEM ARE THE WARDERS. `Someone summons a warder.` is the shaman pet line, and a pet
 * spell in no suffix table cannot be a CANDIDATE for its own landing — which is the third binding
 * signal JOS-349 restored `Tiny Companion` for. Same refusal it recorded for six pet spells then,
 * for the same reason: no log has printed the pair, and a pattern is not evidence.
 */
const WRONG_SUBJECT_CENSUS = [
  'ancient breath',
  'Aria of Asceticism',
  'Blessing of the Squire',
  'Calming Visage',
  'Entrancing Lights',
  'Gift of Aerr',
  'Haunting Visage',
  'Illusion: Air Elemental',
  'Illusion: Scaled Wolf',
  'Lesser Familiar',
  'Lightning Call',
  'Mud',
  "O`Keil's Levity",
  'Remove Curse',
  'Remove Lesser Curse',
  'Remove Minor Curse',
  'Ring of South Ro',
  'Sanctuary',
  'Spirit of Herikol',
  'Spirit of Kashek',
  'Spirit of Keshuval',
  'Spirit of Khaliz',
  'Spirit of Sharik',
  'Spirit of Yekan',
  'Swarm of Retribution',
  'Tame Spirit',
  'Vision Shift',
  'Ward of Alendar',
  'Ward of Calrena',
  'Wild Spirit'
]

/**
 * Rows the wiki cropped the subject off entirely — JOS-174's population, restorable only as a CLAIM
 * about a sentence rather than as a token swap. Twenty of them are rogue poison Strikes and Venoms
 * whose lines `classifyPoisonProc` already claims ABOVE `classifyDbBuff`, so a correction there
 * would change nothing and would look like coverage (`shared/poisons.ts` owns that family), and
 * `Infusion of Spirit` is the sentence `SUBJECT_DRIFT_REFUSED` refuses by name.
 */
const NO_SUBJECT_CENSUS = [
  'Antimagic Poison',
  'Asp Venom',
  'Asp Venom Strike',
  'Auspice',
  'Banishing Poison',
  'Banishing Strike',
  'Befuddling Poison',
  'Befuddling Strike',
  'Binding Poison',
  'Blessing of Temperance',
  'Blood Draw Strike',
  'Blood Draw Venom',
  'Blood Siphon Strike',
  'Blood Siphon Venom',
  "Brell's Steadfast Aegis",
  'Burning Arrow',
  'Celestial Health',
  'Celestial Remedy',
  'Clumsiness Poison',
  'Clumsiness Strike',
  'Cobra Venom',
  'Cobra Venom Strike',
  'Concussive Poison',
  'Concussive Strike',
  'Despair',
  'Dustdevil',
  'Eternities Torment',
  'Fettering Poison',
  'Flaming Arrow',
  'Form of Bleached Bone',
  'Form of Chilled Bone',
  'Grimling Gate',
  'Grounding Poison',
  'Grounding Strike',
  'Grow',
  'Hobbling Poison',
  'Hobbling Strike',
  'Improved Invisibility to Undead',
  'Infectious Spores',
  'Infusion of Spirit',
  'Mage Bane Poison',
  'Magical Monologue',
  'Mind Wrack Poison',
  'Neurotoxic Poison',
  'Paralytic Poison',
  'Power of the Forests',
  'Primal Remedy',
  'Refresh Summoning',
  'Resurrection Effects',
  'Scorching Arrow',
  'Scream of Death',
  'Scream of Hate',
  'Scream of Pain',
  'Scythe of Darkness',
  'Searing Arrow',
  'Sermon of the Righteous',
  'Shackle of Bone',
  'Shackle of Spirit',
  'Spear of Disease',
  'Spear of Pain',
  'Static',
  'Stunning Strike',
  'Stunning Venom',
  // `Swarm of Pain` LEFT THIS LIST IN JOS-435, which is the census working in the direction it was
  // not designed for. The row was already named here, with the reason it had no correction stated
  // in advance (the awaiting-sample law: no log had printed the sentence attached to a cast). A
  // ranger's report was that log arriving, and the owner's own log then witnessed it 199 times —
  // see THE CENSUS ANSWERS BACK in src/main/data/spellCorrectionsSubjects.ts.
  'Temperance',
  'Terror of Darkness',
  'Terror of Shadows',
  'Thought Drain Poison',
  'Translocate: Cazic Temple',
  'Translocate: Greater Faydark',
  'Translocate: Nektulos',
  'Translocate: North Karana',
  'Translocate: North Ro',
  'Translocate: Stonebrunt',
  'Translocate: Toxxulia',
  'Translocate: West Commons',
  'Translocate: West Karana',
  'Voice of Shadows',
  'Ward of Calliav',
  'Wave of Life',
  'Weakening Poison',
  'Weakening Strike'
]

/** The three duplicate rows whose FIRST row keys — flagged, but no spell is lost. */
const REACHABLE_ANYWAY = ['Dustdevil', 'Illusion: Air Elemental', 'Ring of South Ro']

test('THE CENSUS: exactly these registry rows carry an unkeyable third-person landing', () => {
  assert.deepEqual(
    audit.landings.filter((r) => r.verdict === 'wrongSubject').map((r) => r.spell),
    WRONG_SUBJECT_CENSUS,
    'a spell entering or leaving this list is a ruling, not a diff to re-baseline — see the header'
  )
  assert.deepEqual(
    audit.landings.filter((r) => r.verdict === 'noSubject').map((r) => r.spell),
    NO_SUBJECT_CENSUS
  )
  assert.equal(audit.wrongSubject, 30)
  assert.equal(audit.noSubject, 81, 'JOS-435 took `Swarm of Pain` out of the cropped population')
  assert.equal(audit.landings.length, 111)
})

test('THE CENSUS: 108 spells cannot be resolved to their own landing, and three rows are free', () => {
  assert.deepEqual(
    audit.landings.filter((r) => !r.spellUnreachable).map((r) => r.spell),
    REACHABLE_ANYWAY,
    'the only rows flagged for a spell that IS reachable are the scrape`s duplicates'
  )
  assert.equal(audit.unreachable.length, 108, '111 rows minus the three duplicates')
  for (const name of REACHABLE_ANYWAY) assert.ok(!audit.unreachable.includes(name), name)
})

test('THE CENSUS: no first-person field names a third party — measured empty, pinned empty', () => {
  // The mirror defect. Zero today, and the pin is the point: "the scrape has never done this" is
  // exactly the kind of claim a re-scrape falsifies quietly, and asking costs one regex per field.
  assert.deepEqual(audit.firstPerson, [])
})

test('the 20 poison Strikes and Venoms in the census are claimed by a classifier ABOVE us', () => {
  // Why a fifth of the cropped population is not a to-do item: `classifyPoisonProc` runs before
  // `classifyDbBuff`, so restoring these subjects would change no line's kind and would look like
  // coverage. Derived from `shared/poisons.ts` rather than listed, so the two cannot drift.
  const poison = new Set(POISON_PROCS.map((p) => p.suffix))
  const claimed = audit.landings.filter((r) => poison.has(r.message))
  assert.equal(claimed.length, 20)
  for (const r of claimed) assert.equal(r.verdict, 'noSubject', `${r.spell}: a proc line has no subject to get wrong`)
})

// ---------------------------------------------------------------------------------------------
// 3 — THE REPAIR IS REAL, and 4 — the validator and the sweep agree
// ---------------------------------------------------------------------------------------------

test('every `wrongSubject` repair the validator states actually keys the suffix table', () => {
  // Without this the census would be telling a reader that a one-token swap fixes a row when it
  // might not — a placeholder followed by nothing usable restores to a sentence that still yields
  // no suffix. Measured true for all 30 today.
  for (const r of audit.landings) {
    if (r.verdict !== 'wrongSubject') continue
    assert.ok(r.restored, `${r.spell}: a wrongSubject row must state its repair`)
    assert.ok(
      castOnOtherSuffix(r.restored),
      `${r.spell}: \`${r.restored}\` still yields no suffix, so the census is overstating the repair`
    )
  }
})

test('nothing the sweep already corrected is still in the census, and vice versa', () => {
  // The two halves of JOS-412 have to agree or one of them is lying. A corrected spell keys, so it
  // cannot appear here — EXCEPT for the two duplicate rows the mechanism cannot reach, which the
  // sweep names in its header for exactly this reason.
  const corrected = new Set(SUBJECT_PLACEHOLDER_CORRECTIONS.flatMap((c) => c.spells))
  for (const r of audit.landings) {
    if (REACHABLE_ANYWAY.includes(r.spell)) continue
    assert.ok(
      !corrected.has(r.spell),
      `${r.spell} is corrected by the sweep and STILL unkeyable — the correction went stale or wrote the wrong row`
    )
  }
  assert.ok(!audit.unreachable.includes('Curse'), 'the reported spell, from the validator`s own side')
  assert.ok(!audit.unreachable.includes('Odium'), '…and the rank above it that got there first')
})

// ---------------------------------------------------------------------------------------------
// 5 — THE ACCEPTANCE: the sixth report, end to end, through the real parser and unified model
// ---------------------------------------------------------------------------------------------

/** An EQ-stamped line at `sec` seconds past 22:34:00 — the real `[Day Mon DD HH:MM:SS YYYY] ` shape. */
function at(sec: number, text: string): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return `[Thu Aug 13 22:${two(34 + Math.floor(sec / 60))}:${two(sec % 60)} 2026] ${text}`
}

/** `tests/spellCorrectionsSubjects.test.mts`'s harness: both modules, wired the way wiring.ts does. */
function replay(lines: [number, string][], observeSec: number, withDb?: ReturnType<typeof loadSpellDb>) {
  const db = withDb ?? loadSpellDb()
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

/** The registry as it shipped BEFORE this sweep — every correction except the subject ones. */
const HAND_DERIVED = SPELL_CORRECTIONS.filter((c) => !SUBJECT_PLACEHOLDER_CORRECTIONS.includes(c))
const RAW = (spellsJson as SpellDbFile).spells

/**
 * THE REPORTED DEFECT (GitHub issue 43, in-app report 01M0BSTF14C2CHJ3D38BACGDZC): the shaman
 * `Curse` at 34 never reaches the debuff tracker. It is `Odium` — the level-43 rank of the same
 * line, swept in JOS-174 — one rank down, and the wiki made the same mistake on both pages.
 *
 * WHERE THE BYTES COME FROM, and this one needs nothing injected at all. Unlike Odium, the OWNER's
 * log holds BOTH halves: 89 `You begin casting Curse.` casts and 68 `<mob> has been cursed.`
 * landings, every one of the 68 falling 0-3 s after one of the casts (measured 2026-08-19 over
 * 2,138,726 lines; 0 of the wiki's `Target has been cursed.`). The pair below is one of his,
 * verbatim — Thu Aug 13 22:34:06/07, re-stamped by `at()` like every other case here. The
 * reporter's slice is the corroboration, not the source, and none of its bytes enter the tree.
 */
const SHAMAN_CURSE: [number, string][] = [
  [0, 'You begin casting Curse.'],
  [1, 'a ghoul ritualist has been cursed.']
]

test('JOS-412: a Curse cast plus the live landing opens a DEBUFF bar', () => {
  const r = replay(SHAMAN_CURSE, 10)
  const row = r.rows.find((x) => x.target === 'a ghoul ritualist')
  assert.ok(row, `no Curse row: ${r.rows.map((x) => `${x.name}@${x.target ?? 'self'}`).join(', ') || '(none)'}`)
  assert.equal(row.name, 'Curse')
  assert.equal(row.kind, 'debuff', 'spellType `Curse` folds detrimental — spellDb.ts DETRIMENTAL_TYPES')
  assert.equal(row.mode, 'countdown', 'a bar with a duration, which is the whole report')
  assert.equal(row.durationMs, 30_000, 'the committed DB states 30 seconds, as it does for Odium')
  assert.ok(rowsForSurface(r.rows, 'debuffs').includes(row), 'and it belongs to the DEBUFFS window')
  assert.ok(
    r.active.some((a) => a.spell === 'Curse' && a.target === 'a ghoul ritualist'),
    `no held instance: ${r.active.map((a) => `${a.spell}@${a.target ?? 'self'}`).join(', ') || '(none)'}`
  )
})

test('…and WITHOUT the sweep the same live sentence matches nothing at all, which is the defect', () => {
  const bare = buildSpellDb(applySpellCorrections(RAW, HAND_DERIVED).spells)
  try {
    const r = replay(SHAMAN_CURSE, 10, bare)
    assert.deepEqual(r.rows, [], 'no row at all: the landing sentence was in no table under any key')
    assert.equal(
      castOnOtherSuffix(bare.byKey.get('curse')?.msgCastOnOther ?? ''),
      null,
      'because the scrape wrote `Target` where the table keys on `Someone` — the Odium defect exactly'
    )
  } finally {
    installSpellDb(loadSpellDb())
  }
})

test('JOS-412: the minted tail resolves to Curse alone, and Magi Curse keeps its own', () => {
  // The near-neighbour a reader would worry about, since this row MINTS rather than joins:
  // `Someone has been Magi cursed.` ends in the same two words. Neither tail is a suffix of the
  // other (` has been cursed.` vs ` has been Magi cursed.`), so each line has exactly one owner.
  // Invariant 2 above pins the general rule; this pins the concrete pair.
  const db = loadSpellDb()
  const hit = matchCastOnOtherSuffix('a ghoul ritualist has been cursed.', db)
  assert.ok(hit, 'the live sentence must resolve at all')
  assert.equal(hit.target, 'a ghoul ritualist')
  assert.deepEqual(hit.entry.cands.map((c) => c.name), ['Curse'], 'no other spell writes this sentence')
  assert.deepEqual(
    matchCastOnOtherSuffix('a ghoul ritualist has been Magi cursed.', db)?.entry.cands.map((c) => c.name),
    ['Magi Curse']
  )
})

test('JOS-412: a JOIN row adds a candidate to a sentence that already parsed', () => {
  // THE OTHER HALF OF THE WAVE, and the reason it is safe: a join mints no tail, so the sentence
  // already parsed and already resolved to somebody. What changes is which spells the model may
  // choose between — and `Frenzy` could not be among them for its own landing sentence.
  installSpellDb(loadSpellDb())
  const ev = parseEvent('[Thu Aug 13 22:34:07 2026] a ghoul ritualist goes berserk.', 0)
  assert.equal(ev?.kind, 'buffApply', 'the sentence already parsed, and still does')
  assert.equal(ev.kind === 'buffApply' ? ev.spell : '', 'Burnout', 'this bucket`s head does not move')
  assert.ok(
    ev.kind === 'buffApply' && ev.candidates.some((c) => c.name === 'Frenzy'),
    'and `Frenzy` — which wrote `Target goes berserk.` — can finally be one of the candidates'
  )
})

test('JOS-412: …and where the joined spell sorts FIRST, it leads — 669 lines, priced', () => {
  // THE COST THE TRIPWIRE FOUND, pinned rather than glossed. `ev.spell` is the parser's best-effort
  // FIRST candidate (JOS-84 — `candidates` carries the truth), and first is decided by REGISTRY
  // ORDER: the first row to claim a suffix heads its bucket. A joined spell that sorts before the
  // sibling which used to head it therefore takes the lead. Measured whole-log (2,140,000 lines,
  // 2026-08-19): 669 lines over SIX pairs, every pair inside one family, and the model's own
  // resolution — which answers to the cast that anchored the landing — moves on none of them.
  // The list is in `spellCorrectionsSubjects.ts`'s header; this pins the one that is not two ranks
  // of the same line, so a reader meets it here too.
  installSpellDb(loadSpellDb())
  const ev = parseEvent('[Thu Aug 13 22:34:07 2026] a ghoul ritualist feels very dispelled.', 0)
  assert.equal(ev?.kind, 'buffApply')
  assert.equal(
    ev.kind === 'buffApply' ? ev.spell : '',
    'Beholder Dispel',
    'the NPC dispel now leads the sentence `Pillage Enchantment` used to — 358 of the 669'
  )
  assert.deepEqual(
    ev.kind === 'buffApply' ? ev.candidates.map((c) => c.name).sort() : [],
    ['Beholder Dispel', 'Pillage Enchantment', 'Strip Enchantment'],
    'and all three are candidates, which is what the join was for'
  )
})

