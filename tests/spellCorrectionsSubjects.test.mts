// JOS-174 — THE SUBJECT PLACEHOLDER THE SCRAPE LOST, SWEPT.
//
// THE REPORT: a 0.14.0 shaman said Odium never shows on the debuff timer, "leveled to VI if that's
// the issue". The rank was NOT the issue — `canonKey` folds ` VI` off a cast line and the anchor
// joins the DB's `Odium` row perfectly. The LANDING was: the wiki writes the third-person sentence
// as `Target staggers under a dark curse.`, and `castOnOtherSuffix()` keys the cast-on-other table
// on what follows a `Someone ` subject and nothing else — so the spell was in no table, the live
// line classified as `{kind:'unknown'}`, and no `buffApply` ever existed for a bar to draw.
//
// `src/main/data/spellCorrectionsSubjects.ts` is the sweep and its header carries the argument:
// why this is a measured LIST rather than a wider subject stripper, and which two sentences it
// refuses. This suite is the guard on the properties that argument rests on.
//
// JOS-189 ADDED THREE MORE REPORTS to the same sweep and the same suite: the bard whose four Tuyen
// chants share one landing sentence (01KZN3FSW4BQ519N3TV8CQ1TC1), and the beastlord whose Sha's
// Lethargy never reaches the debuff window (01KZP5B8F9GJ0J0BNCP29DH59J) — which is the sentence
// JOS-174 named and REFUSED, so it is the first entry that takes a line off another classifier.
//
// JOS-245 ADDED A FOURTH REPORT and the first row whose evidence log is not the owner's: a druid
// whose Vengeance of the Wild never reaches the debuff window (01KZSR4HQVWJKDG0NCDGZ01928). The
// owner's 1,608,490 lines hold NO trace of that spell — not the landing, not the wear-off, not the
// name — so the count comes from the reporter's slice instead (`hits: 0` says exactly that), and
// the acceptance below carries the extra half those two facts imply: the whole CYCLE, because what
// the correction really restores is the landing the learner needs before any observed duration can
// exist at all.
//
// JOS-349 ADDED A FIFTH REPORT and the first whose cost is not a missing BAR: a shaman whose
// summoned pet stopped being attributed at all (01M00ACVVFDRVWBXRDCFPHESNZ). `Tiny Companion` is the
// only `targetType: Pet` member of the ` shrinks.` family and the scrape gave it `Target`, so it
// could not be a CANDIDATE for its own landing — and JOS-188's third binding signal is exactly a
// membership test on that list. The row is the second JOIN rather than a mint, and the end-to-end
// acceptance lives with the rung it feeds, in `tests/petBuffBind.test.mts`.
//
// JOS-412 ADDED A SIXTH REPORT AND CHANGED HOW THE NEXT ONE ARRIVES. A shaman's level-34 `Curse`
// never reached the debuff tracker (GitHub issue 43, in-app report 01M0BSTF14C2CHJ3D38BACGDZC) — it
// is `Odium` one rank down the same line, and it sat unmatchable for ten days after Odium was swept
// because nothing in the tree ever ASKED which other spells were in that state. Something does now:
// `src/main/data/spellSubjectAudit.ts`, pinned as a census in `tests/spellSubjectAudit.test.mts`.
// The wave it produced is 18 rows — `Curse`, the one unkeyable sentence with owner-log evidence,
// plus all seventeen the family ALREADY owned, where restoring the subject mints nothing and only
// lets a spell be a candidate for its own landing. Its rows are held to invariants 1 and 2 below
// like every other; the ACCEPTANCE for the sixth report lives beside the validator, in
// `tests/spellSubjectAudit.test.mts`, so that ticket reads as one file.
//
// JOS-435 IS THE SEVENTH REPORT AND THE FIRST THE CENSUS HAD ALREADY NAMED. A ranger's Swarm of
// Pain never tracked in the Debuffs overlay (01M0GR6H8SJH69XS9W2RH61W90) — a CROPPED subject, so
// JOS-174's population rather than JOS-412's, and the spell was sitting in `NO_SUBJECT_CENSUS` with
// the reason it had no correction stated in advance: no log had printed the sentence attached to a
// cast. A report is that log arriving, and the owner's own then witnessed it 199 times. Its rows are
// held to invariants 1 and 2 below like every other; the ACCEPTANCE lives in
// `tests/swarmOfPainLanding.test.mts`, because this file is AT the 400-code-line ceiling.
//
// FIVE THINGS ARE PINNED HERE:
//
//   1. THE SHAPE. Every entry restores a SUBJECT and changes nothing else. Strip the leading
//      subject token from `from` and from `to` and the remainder is byte-identical — which is what
//      makes "the sentence is the wiki's own" a checkable claim rather than a promise.
//   2. ADDITIVE AT THE TABLE. A restored tail is either NEW to the suffix table or byte-identical
//      to one already in it (the Tuyen chants JOIN the sentence their two siblings already own);
//      what it may never be is a PARTIAL overlap, because there a line matches two tails and table
//      order decides which spell it means.
//   3. THE REFUSAL IS REAL. ` looks powerful.` has owner-log evidence and is deliberately NOT
//      corrected: `classifySpellEmote` already claims it and `classifyDbBuff` runs above it, so a
//      correction would TAKE a match rather than add one.
//   4. …AND WHAT IT COSTS TO STOP REFUSING ONE. ` feels lethargic.` left that list with a measured
//      whole-log blast radius beside it, and this suite pins both halves: the four lines that move,
//      and the emote path still claiming every other perception-verb sentence.
//   5. THE ACCEPTANCES: the reported defects, end to end, through the real parser and the real
//      unified model. An Odium VI cast plus the landing sentence the LIVE GAME prints opens a
//      DEBUFF row with a duration. It could not before, by one subject token.
//
// WHERE THE BYTES COME FROM. The landing sentence is the OWNER's own — `a rock golem staggers
// under a dark curse.` is in `eqlog_Primitive_freeport.txt` (Thu Jul 30 20:48:07; 19 lines of the
// shape whole-log, all previously unowned). The ONE sentence his log lacks is the cast, because he
// is not a shaman: `You begin casting Odium VI.` is quoted verbatim from report
// 01KZMS8NG4FBYCP1P51VK8WP1B and INJECTED here, which is the AGENTS.md rule for a defect that
// exists only in somebody else's log — no reporter-slice bytes enter the tree.
//
// MEASURED WHOLE-LOG BEFORE AND AFTER (the law-8 tripwire, every line parsed twice in one process).
// JOS-174, over 1,536,938 lines: `unknown` 140,167 -> 139,645 and `buffApply` 104,876 -> 105,398.
// One transition, `unknown -> buffApply`, 522 lines. Every other kind byte-identical.
// JOS-189's Sha's Lethargy entry, measured the same way over 1,557,575 lines and on its own:
// `buffApply` 106,507 -> 106,511, `spellEmote` 1,858 -> 1,855, `unknown` 141,281 -> 141,280. FOUR
// lines, named in `spellCorrectionsSubjects.ts` under THE PRECEDENCE CASE. Every other kind
// byte-identical.
//
// Run: `npm test`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser.ts'
import { installSpellDb } from '../src/main/log/rulesets.ts'
import { buildSpellDb, castOnOtherSuffix, loadSpellDb, matchCastOnOtherSuffix } from '../src/main/data/spellDb.ts'
import { applySpellCorrections, SPELL_CORRECTIONS } from '../src/main/data/spellCorrections.ts'
import {
  SUBJECT_DRIFT_REFUSED,
  SUBJECT_PLACEHOLDER_CORRECTIONS
} from '../src/main/data/spellCorrectionsSubjects.ts'
import { BuffsModule } from '../src/main/modules/buffs.ts'
import { BuffTimersModule } from '../src/main/modules/buffTimers.ts'
import { buildTimerRows, rowsForSurface } from '../src/shared/buffTimers.ts'
import type { SpellDbFile } from '../src/shared/types.ts'
import spellsJson from '../src/main/data/spells.json' with { type: 'json' }

const RAW = (spellsJson as SpellDbFile).spells

/** The corrections the sweep did NOT bring — everything the registry held before JOS-174. */
const HAND_DERIVED = SPELL_CORRECTIONS.filter((c) => !SUBJECT_PLACEHOLDER_CORRECTIONS.includes(c))

/**
 * The wiki's subject vocabulary, stripped. The optional token AND the optional possessive are both
 * optional on purpose: the drift comes in two shapes — a WRONG placeholder (`Target's wounds
 * heal.`) and NO placeholder at all (`'s wounds heal.`, `becomes one with their weapons.`) — and
 * the sweep restores both to the same `Someone` form.
 */
function withoutSubject(msg: string): string {
  return msg.replace(/^(?:Someone|Player|Target|Soandso|Other_Player)?(?:\s*'s)?\s*/, '')
}

/** What a log line must END WITH for a suffix to match (spellDb.ts `matchTail`, restated). */
function tailOf(suffix: string): string {
  return suffix.startsWith("'s") ? suffix : ` ${suffix}`
}

// ---------------------------------------------------------------------------------------------
// 1 — THE SHAPE: a subject is restored, and nothing else is touched
// ---------------------------------------------------------------------------------------------

test('every sweep entry restores a SUBJECT and changes no other word', () => {
  assert.ok(SUBJECT_PLACEHOLDER_CORRECTIONS.length > 0, 'the sweep is supposed to contain something')
  for (const c of SUBJECT_PLACEHOLDER_CORRECTIONS) {
    const where = `${c.spells[0]}: ${c.from ?? '(absent)'} -> ${c.to}`
    assert.equal(c.field, 'msgCastOnOther', `${where}: the drift only exists on the third-person message`)
    assert.ok(c.from !== null, `${where}: this class replaces a sentence, it never fills an absent field`)
    assert.ok(c.to.startsWith('Someone'), `${where}: the restored subject is the one the table keys on`)
    assert.equal(
      withoutSubject(c.from),
      withoutSubject(c.to),
      `${where}: a subject restoration that also edits the sentence is a DIFFERENT correction and needs its own evidence`
    )
    // The point of the whole exercise, stated as an assertion: the wiki's text yields no suffix at
    // all (so the spell is in no table), and ours does.
    assert.equal(castOnOtherSuffix(c.from), null, `${where}: the wiki form must be the unkeyable one`)
    assert.ok(castOnOtherSuffix(c.to), `${where}: and the restored form must key`)
  }
})

test('every sweep entry states a measured evidence line and an attribution route', () => {
  // The registry-wide audit in `spellCorrections.test.mts` already checks this over
  // SPELL_CORRECTIONS as a whole. Repeated here against the DERIVED list because these entries are
  // built by a `map` rather than written out, and a generator that quietly produced an empty
  // `evidence` would satisfy nothing the reviewer can read.
  for (const c of SUBJECT_PLACEHOLDER_CORRECTIONS) {
    assert.ok(c.evidence.length > 40, `${c.spells[0]}: state what was measured`)
    assert.ok(['cast', 'db', 'sole'].includes(c.attribution), `${c.spells[0]}: ${c.attribution}`)
    assert.ok(c.spells.length > 0)
  }
})

// ---------------------------------------------------------------------------------------------
// 2 — STRICTLY ADDITIVE: no new tail competes with an old one
// ---------------------------------------------------------------------------------------------

/**
 * The suffixes this sweep JOINS rather than mints (JOS-189) — a row whose family already owns the
 * sentence, so restoring the subject adds candidates and creates no new tail. Named here rather
 * than inferred, so joining stays a decision somebody made per entry.
 *
 * ` shrinks.` is the second (JOS-349, Tiny Companion): `Ant Legs` and `Shrink` already own it.
 */
const JOINS_EXISTING = new Set([
  'begins to chant.',
  'shrinks.',
  // THE JOS-412 BLOCK — seventeen sentences the validator found and the family already owned. Each
  // one is a spell that could never be a candidate for its own landing while a sibling with the
  // correctly-spelled `Someone` matched the very same line. Named here rather than inferred,
  // because joining stays a decision somebody made per entry.
  'staggers.',
  'is surrounded by a brief lupine aura.',
  'feels very dispelled.',
  'screams in pain.',
  'looks tougher.',
  'looks stronger.',
  'looks protected.',
  "'s skin shimmers with divine power.",
  'goes berserk.',
  "'s image shimmers.",
  'begins to radiate.',
  'creates a mystic portal.',
  "'s skin turns hard as diamond.",
  'turns into a wolf.',
  'creates a shimmering portal.',
  'turns into a bear.',
  "'s skin sears."
])

test('every restored suffix is NEW to the table, or JOINS one exactly — never partially', () => {
  // The pre-sweep table: the scrape plus the hand-derived corrections, exactly what shipped before
  // JOS-174. Two shapes are admitted and the difference between them is the whole invariant.
  //
  // MINTING one is the ordinary case: the tail is absent, so nothing it matches was matching
  // anything before. JOINING one is the Tuyen chant case: all four chants write one sentence, the
  // scrape gave two of them a usable subject, and the other two are simply added as candidates to
  // a sentence the cast anchor already narrows.
  //
  // What neither may be is a PARTIAL overlap — a tail that is a suffix of an existing one, or has
  // one as a suffix. There a line matches both and which spell it means is decided by insertion
  // order rather than by anybody, which is the one thing this test exists to refuse.
  const before = buildSpellDb(applySpellCorrections(RAW, HAND_DERIVED).spells)
  const existing = [...before.castOnOtherSuffix.keys()].map(tailOf)
  for (const c of SUBJECT_PLACEHOLDER_CORRECTIONS) {
    const suffix = castOnOtherSuffix(c.to)
    assert.ok(suffix, `${c.spells[0]}: the restored message must yield a suffix`)
    const held = before.castOnOtherSuffix.get(suffix)
    if (JOINS_EXISTING.has(suffix)) {
      assert.ok(held, `${c.spells[0]}: \`${suffix}\` is declared a JOIN but the table does not hold it`)
      continue
    }
    assert.equal(held, undefined, `${c.spells[0]}: the table already held \`${suffix}\` — declare the join`)
    const tail = tailOf(suffix)
    for (const other of existing) {
      assert.ok(!other.endsWith(tail), `${c.spells[0]}: \`${tail}\` would also match every line of \`${other}\``)
      assert.ok(!tail.endsWith(other), `${c.spells[0]}: every line of \`${tail}\` already matches \`${other}\``)
    }
  }
})

test('JOS-189: the chant family is FOUR candidates for the one sentence it prints', () => {
  // The defect, at the layer it lives in. All four Tuyen chants print `<mob> begins to chant.`, and
  // the scrape wrote `Someone` for two of them and `Target` for the other two — so the sentence had
  // two owners, and a bard chaining all four had two of their debuffs filed under the wrong spell
  // and the other two nowhere at all.
  const db = loadSpellDb()
  const hit = matchCastOnOtherSuffix('an ice giant begins to chant.', db)
  assert.ok(hit, 'the live sentence must resolve at all')
  assert.equal(hit.target, 'an ice giant')
  assert.deepEqual(
    hit.entry.cands.map((c) => c.name).sort(),
    [
      "Tuyen's Chant of Disease",
      "Tuyen's Chant of Flame",
      "Tuyen's Chant of Frost",
      "Tuyen's Chant of Poison"
    ],
    'the whole family, under the names the log prints'
  )

  const bare = buildSpellDb(applySpellCorrections(RAW, HAND_DERIVED).spells)
  assert.deepEqual(
    matchCastOnOtherSuffix('an ice giant begins to chant.', bare)?.entry.cands.map((c) => c.name).sort(),
    ["Tuyen's Chant of Flame", "Tuyen's Chant of Frost"],
    'before the sweep the sentence had exactly the two owners whose subject the scrape got right'
  )
})

test('JOS-349: the shrink sentence is FOUR candidates, and Tiny Companion is the pet one', () => {
  // The second JOIN, and the one whose cost is not a bar. `Ant Legs` and `Shrink` carry `Someone`,
  // `Tiny Companion` carried `Target`, so the only `targetType: Pet` member of the family could not
  // be a candidate for its own landing — and JOS-188's pet bind tests exactly that membership.
  //
  // THREE -> FOUR (JOS-439), and the fourth arrived from the WIKI, not from this registry. The
  // 2026-08-18 game patch gave the alchemy shelf its Spellpages, and one of them is
  // `Donlo's Dementia` — the Army Ant Potion's GROUP shrink, `Decrease Player Size by 34%`, whose
  // `msg_cast_on_other` the scrape read as `Someone shrinks.` with the subject already correct. So
  // it needs no row here: it walks into the family the way a correctly-scraped spell is supposed
  // to, and the family growing is the shared-sentence law (world-model law 3) doing its job rather
  // than a defect. It is a clicky (`classes` says the spell cannot be cast directly), so nobody
  // scribes it, and it sorts after `Ant Legs`, which is what leaves the first pick alone below.
  const db = loadSpellDb()
  const hit = matchCastOnOtherSuffix('Dranix shrinks.', db)
  assert.ok(hit, 'the live sentence must resolve at all')
  assert.equal(hit.target, 'Dranix')
  assert.deepEqual(
    hit.entry.cands.map((c) => c.name).sort(),
    ['Ant Legs', "Donlo's Dementia", 'Shrink', 'Tiny Companion'],
    'the whole family that writes this sentence'
  )
  assert.equal(
    hit.entry.cands.find((c) => c.name === 'Tiny Companion')?.targetType,
    'Pet',
    'and the pet-only membership is the DB`s own — charmModel.PET_TARGET_SPELLS reads this field'
  )

  const bare = buildSpellDb(applySpellCorrections(RAW, HAND_DERIVED).spells)
  assert.deepEqual(
    matchCastOnOtherSuffix('Dranix shrinks.', bare)?.entry.cands.map((c) => c.name).sort(),
    ['Ant Legs', "Donlo's Dementia", 'Shrink'],
    'before the row the sentence had exactly the owners whose subject the scrape got right'
  )
})

test('JOS-349: the row moves NO line`s kind and NO line`s first pick — measured whole-log', () => {
  // THE LAW-8 TRIPWIRE, restated as the assertion it implies. The owner's log parsed TWICE in one
  // process with and without this one row (1,732,264 lines, 56 event kinds, 2026-08-14): not one
  // kind count moves, and the 33 ` shrinks.` lines keep `Ant Legs` as the parser's best-effort
  // first pick. The ONLY thing that changes is the candidate list — 33 lines go
  // `Ant Legs+Shrink` -> `Ant Legs+Shrink+Tiny Companion` — which is what a JOIN is supposed to
  // look like from the outside, and it is table ORDER that guarantees it (the joined spell is
  // appended to a bucket the two siblings already head).
  //
  // `Donlo's Dementia` joined the same bucket from the 2026-08-18 patch (JOS-439) and the tripwire
  // holds through it for the same reason: it sorts after `Ant Legs`, so the kind is still
  // `buffApply` and the first pick is still `Ant Legs`. Only the list got longer — which is the
  // one thing this test is willing to let move.
  installSpellDb(loadSpellDb())
  const ev = parseEvent('[Mon Jul 20 17:32:01 2026] Demilat shrinks.', 0)
  assert.equal(ev?.kind, 'buffApply', 'the sentence already parsed, and still does')
  assert.equal(ev.kind === 'buffApply' ? ev.spell : '', 'Ant Legs', 'the first pick is unchanged')
  assert.deepEqual(
    ev.kind === 'buffApply' ? ev.candidates.map((c) => c.name) : [],
    ['Ant Legs', "Donlo's Dementia", 'Shrink', 'Tiny Companion'],
    'world-model law 3: the candidate list carries the truth, and the model resolves it'
  )
})

// ---------------------------------------------------------------------------------------------
// 3 — THE REFUSALS: two sentences with real evidence that are deliberately left alone
// ---------------------------------------------------------------------------------------------

test('the cascade-claimed sentence that is still refused is still claimed by the cascade', () => {
  // `classifyDbBuff` sits ABOVE `classifySpellEmote`, so correcting this would not add a match, it
  // would take one — reclassifying lines that parse today. The list is data so this can assert on
  // it rather than on a comment; the subject below is a synthetic one-word name so no bystander's
  // enters the tree, and one word is what the emote matcher wants.
  //
  // JOS-174 wrote this list with two members and JOS-189 met the burden for one of them, so what
  // this test now guards is the SPLIT: `looks powerful.` is 15 whole-log lines, twelve of them on
  // player names arriving in same-second pairs — a group buff landing, which is the shape the emote
  // learner's cast-target discrimination exists for — and no report names it.
  installSpellDb(loadSpellDb())
  assert.deepEqual(
    SUBJECT_DRIFT_REFUSED.map((r) => r.spell),
    ['Infusion of Spirit'],
    'a sentence leaves this list only with a measured blast radius beside it — see THE PRECEDENCE CASE'
  )
  for (const r of SUBJECT_DRIFT_REFUSED) {
    assert.ok(
      !SPELL_CORRECTIONS.some((c) => c.field === 'msgCastOnOther' && c.spells.includes(r.spell)),
      `${r.spell} is refused, so nothing may correct its cast-on-other message`
    )
    const ev = parseEvent(`[Sat Aug 09 12:00:00 2026] Someguy ${r.suffix}`, 0)
    assert.equal(ev?.kind, r.claimedBy, `\`${r.suffix}\` must still parse the way it parsed before`)
  }
})

test('JOS-189: the slow sentence is TAKEN from the emote path, and only that sentence', () => {
  // THE PRECEDENCE CASE. Measured whole-log, 1,557,575 lines parsed twice in one process with and
  // without this one correction: buffApply 106,507 -> 106,511, spellEmote 1,858 -> 1,855, unknown
  // 141,281 -> 141,280, every other kind byte-identical. Four lines move and no others.
  installSpellDb(loadSpellDb())

  // The two shapes the sentence comes in, which is its own argument: EMOTE_PET_RE wants a
  // CAPITALISED subject, so an articled mob name never reached the emote learner at all and the
  // family was already split on whether the mob's name had "a " in front of it.
  for (const subject of ['Vebarn', 'a flighty fiend']) {
    const ev = parseEvent(`[Sat Aug 09 12:00:00 2026] ${subject} feels lethargic.`, 0)
    assert.equal(ev?.kind, 'buffApply', `${subject}: the slow now names its spell`)
    assert.equal(ev.kind === 'buffApply' ? ev.spell : '', "Sha's Lethargy")
    assert.equal(ev.kind === 'buffApply' ? ev.target : '', subject, 'and carries the target it landed on')
  }

  // AND THE EMOTE PATH IS OTHERWISE UNTOUCHED — the protected behaviour, pinned. The permissive
  // matcher still claims every OTHER perception-verb line, in both persons, which is what keeps
  // Task #33's cast-target learning working for spells the DB does not describe.
  const stillEmotes = [
    'Someguy looks powerful.', // the refused sentence, above
    'Bzzazzt feels tired.',
    'Bzzazzt looks refreshed.',
    'Bzzazzt seems more agile.',
    'You feel a traveling spirit surround you.',
    'You seem to be at peace.'
  ]
  for (const text of stillEmotes) {
    assert.equal(parseEvent(`[Sat Aug 09 12:00:00 2026] ${text}`, 0)?.kind, 'spellEmote', text)
  }
})

// ---------------------------------------------------------------------------------------------
// 4 — THE ACCEPTANCE: the reported defect, through the real parser and the real unified model
// ---------------------------------------------------------------------------------------------

/** An EQ-stamped line at `sec` seconds past 20:48:00 — the real `[Day Mon DD HH:MM:SS YYYY] ` shape. */
function at(sec: number, text: string): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return `[Thu Jul 30 20:${two(48 + Math.floor(sec / 60))}:${two(sec % 60)} 2026] ${text}`
}

/**
 * The `tests/spellCorrections.test.mts` harness: both modules, wired the way wiring.ts wires them.
 * `withDb` replays against a DB other than the committed one — which is how the "…and without the
 * correction" halves below state the defect through the same machinery rather than by inspection.
 */
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

test('THE REPORTED DEFECT: an Odium VI cast plus the live landing opens a DEBUFF bar', () => {
  const r = replay(
    [
      // Quoted verbatim from report 01KZMS8NG4FBYCP1P51VK8WP1B — the one line the owner's log has
      // no shaman to print. The reporter's own mob names stay in his log; the target below is the
      // owner's.
      [0, 'You begin casting Odium VI.'],
      [1, 'a rock golem staggers under a dark curse.']
    ],
    10
  )
  const row = r.rows.find((x) => x.target === 'a rock golem')
  assert.ok(row, `no Odium row: ${r.rows.map((x) => `${x.name}@${x.target ?? 'self'}`).join(', ') || '(none)'}`)
  assert.equal(row.name, 'Odium', 'the DB name is the row identity (JOS-238); the rank was never the defect')
  assert.equal(row.castName, 'Odium VI', 'and the rank the cast line spelled is kept beside it')
  assert.equal(row.kind, 'debuff')
  assert.equal(row.mode, 'countdown', 'a bar with a duration, which is the whole report')
  assert.equal(row.durationMs, 30_000, 'the committed DB states 30 seconds for the line')
  assert.ok(rowsForSurface(r.rows, 'debuffs').includes(row), 'and it belongs to the DEBUFFS window')
  // The instance under the row: before the correction the landing parsed to nothing at all, so
  // there was no held instance and no projection could have invented one.
  assert.ok(
    r.active.some((a) => a.spell === 'Odium' && a.target === 'a rock golem'),
    `no held instance: ${r.active.map((a) => `${a.spell}@${a.target ?? 'self'}`).join(', ') || '(none)'}`
  )
})

test('…and WITHOUT the sweep the same live sentence matches nothing at all, which is the defect', () => {
  // The defect stated the way the Allure and Bravura pairs state it in `spellCorrections.test.mts`:
  // the correction is the only thing standing between this test and the one above. The wiki's own
  // `Target staggers under a dark curse.` yields no suffix, so the shaman's landing was not in the
  // table under ANY key and no anchor, projection or overlay could have recovered it.
  const bare = buildSpellDb(applySpellCorrections(RAW, HAND_DERIVED).spells)
  assert.equal(
    matchCastOnOtherSuffix('a rock golem staggers under a dark curse.', bare),
    null,
    'the live sentence must resolve to nothing before the correction'
  )
  assert.equal(
    castOnOtherSuffix(bare.byKey.get('odium')?.msgCastOnOther ?? ''),
    null,
    'because the scrape wrote a subject placeholder the suffix table cannot key'
  )
})

test('the landing resolves to Odium alone, through the load seam the parser really reads', () => {
  const db = loadSpellDb()
  const hit = matchCastOnOtherSuffix('a rock golem staggers under a dark curse.', db)
  assert.ok(hit, 'the live sentence must resolve at all')
  assert.equal(hit.target, 'a rock golem')
  assert.deepEqual(hit.entry.cands.map((c) => c.name), ['Odium'], 'no other spell writes this sentence')
  assert.equal(db.castOnOtherSuffix.get('staggers under a dark curse.')?.length, 1)
})

/**
 * THE BARD'S CHAIN, in the rhythm the game prints it: a song every two or three seconds, each one
 * answered two seconds later by the landing sentence all four chants share — except the frost,
 * which is RESISTED and therefore answered by nothing. Four casts, three landings, and that
 * asymmetry is the whole report.
 *
 * Every shape here is the owner's own: `You begin singing <Song> <rank>.`, `<mob> begins to chant.`
 * (6 lines whole-log) and `<Mob> resisted your <Song>!` (the ordinary resist line), with the
 * reporter's mob replaced by one of the owner's.
 */
const CHAIN: [number, string][] = [
  [0, "You begin singing Tuyen's Chant of Frost V."],
  [2, "A fire giant warrior resisted your Tuyen's Chant of Frost V!"],
  [2, "You begin singing Tuyen's Chant of Disease VI."],
  [4, 'a fire giant warrior begins to chant.'],
  [4, "You begin singing Tuyen's Chant of Flame V."],
  [6, 'a fire giant warrior begins to chant.'],
  [7, "You begin singing Tuyen's Chant of Poison V."],
  [9, 'a fire giant warrior begins to chant.']
]

test('JOS-189: each chant of the chain gets its OWN row, and the resisted one gets none', () => {
  // THE REPORT (01KZN3FSW4BQ519N3TV8CQ1TC1, v0.17.0): frost shown active when it was not on the
  // mob, poison and disease missing, flame alone correct. With only two candidates for the shared
  // sentence, the DISEASE landing resolved to the most recently cast of THEM — the frost that had
  // just been resisted — and the poison and disease had no row of their own to draw.
  const r = replay(CHAIN, 10)
  const names = r.rows.map((x) => x.name).sort()
  assert.deepEqual(
    names,
    ["Tuyen's Chant of Disease", "Tuyen's Chant of Flame", "Tuyen's Chant of Poison"],
    'the three that landed, each under its own name — and no frost row at all'
  )
  for (const row of r.rows) {
    assert.equal(row.kind, 'debuff')
    assert.equal(row.target, 'a fire giant warrior')
    assert.equal(row.mode, 'countdown')
  }
  assert.equal(r.rows.find((x) => x.name.includes('Disease'))?.durationMs, 12_000, 'the DB states 2 ticks')
  assert.equal(r.rows.find((x) => x.name.includes('Flame'))?.durationMs, 18_000, '…and 3 for the flame')
})

test('…and with the wiki`s own two rows the same chain shows frost and loses two chants', () => {
  // The defect stated, the way the Odium pair above states it. The correction is the only thing
  // standing between this test and the one above: with Disease and Poison absent from the table,
  // every landing in the chain resolves to the most recently cast of Flame and Frost.
  const bare = buildSpellDb(applySpellCorrections(RAW, HAND_DERIVED).spells)
  try {
    const r = replay(CHAIN, 10, bare)
    assert.deepEqual(
      r.rows.map((x) => x.name).sort(),
      ["Tuyen's Chant of Flame", "Tuyen's Chant of Frost"],
      'a frost bar for a frost that was resisted, and nothing for the poison or the disease'
    )
  } finally {
    installSpellDb(loadSpellDb())
  }
})

test('JOS-189: a Sha`s Lethargy cast plus its landing opens the slow`s debuff bar', () => {
  // THE REPORT (01KZP5B8F9GJ0J0BNCP29DH59J, v0.18.0, a beastlord): the level-50 slow does not show
  // up in the debuff window. `<mob> feels lethargic.` is the owner's own sentence (4 lines
  // whole-log, every one of them within 12 s of a Sha's Lethargy cast); the cast line is cast in
  // the FIRST person here, as the JOS-161 windows are, so the anchor is the ordinary own-cast one.
  const r = replay(
    [
      [0, "You begin casting Sha's Lethargy."],
      [3, 'a fire giant warrior feels lethargic.']
    ],
    30
  )
  const row = r.rows.find((x) => x.target === 'a fire giant warrior')
  assert.ok(row, `no slow row: ${r.rows.map((x) => `${x.name}@${x.target ?? 'self'}`).join(', ') || '(none)'}`)
  assert.equal(row.name, "Sha's Lethargy")
  assert.equal(row.kind, 'debuff')
  assert.equal(row.mode, 'countdown')
  assert.equal(row.durationMs, 150_000, 'the committed DB states 2 Min 30 Sec')
  assert.ok(rowsForSurface(r.rows, 'debuffs').includes(row), 'the DEBUFF window, which is where it was missing')
  assert.ok(
    r.active.some((a) => a.spell === "Sha's Lethargy" && a.target === 'a fire giant warrior'),
    `no held instance: ${r.active.map((a) => `${a.spell}@${a.target ?? 'self'}`).join(', ') || '(none)'}`
  )
})

test('…and without the correction the same landing is a nameless emote, which is the defect', () => {
  const bare = buildSpellDb(applySpellCorrections(RAW, HAND_DERIVED).spells)
  try {
    const r = replay(
      [
        [0, "You begin casting Sha's Lethargy."],
        [3, 'a fire giant warrior feels lethargic.']
      ],
      30,
      bare
    )
    assert.deepEqual(r.rows, [], 'no row at all: the sentence named no spell, so no bar could exist')
    assert.equal(
      castOnOtherSuffix(bare.byKey.get("sha's lethargy")?.msgCastOnOther ?? ''),
      null,
      'because the scrape dropped the subject entirely and the suffix table cannot key it'
    )
  } finally {
    installSpellDb(loadSpellDb())
  }
})

// ---------------------------------------------------------------------------------------------
// 5 — JOS-245: the druid DoT whose landing sentence the owner's log has never printed
// ---------------------------------------------------------------------------------------------

/**
 * THE REPORT (01KZSR4HQVWJKDG0NCDGZ01928, v0.21.0, a druid): Vengeance of the Wild does not appear
 * in debuff tracking. Same shape as Odium — the wiki writes `Target has been consumed in the flames
 * of the wild.`, which keys nothing.
 *
 * WHERE THE BYTES COME FROM, and this one is ALL injected, which no other case here is. The owner's
 * log holds no line of this spell in any form (measured 2026-08-12, 1,608,490 lines: 0 landings, 0
 * casts, 0 wear-offs, 0 mentions), so both sentences are quoted verbatim from the report and the
 * MOB is swapped for one of the owner's — `Lady Vox` in the reporter's slice, `a fire giant warrior`
 * here. No reporter-slice bytes enter the tree; the AGENTS.md rule is the same one the Odium cast
 * line already travels.
 */
const DRUID_DOT: [number, string][] = [
  [0, 'You begin casting Vengeance of the Wild VI.'],
  [2, 'a fire giant warrior has been consumed in the flames of the wild.']
]

test('JOS-245: a Vengeance of the Wild cast plus its landing opens the DoT`s debuff bar', () => {
  const r = replay(DRUID_DOT, 10)
  const row = r.rows.find((x) => x.target === 'a fire giant warrior')
  assert.ok(row, `no dot row: ${r.rows.map((x) => `${x.name}@${x.target ?? 'self'}`).join(', ') || '(none)'}`)
  assert.equal(row.name, 'Vengeance of the Wild', 'the DB name is the row identity')
  assert.equal(row.castName, 'Vengeance of the Wild VI', 'and the rank the reporter`s cast line spelled')
  assert.equal(row.kind, 'debuff')
  assert.equal(row.mode, 'countdown')
  assert.equal(row.durationMs, 30_000, 'the committed DB states 5 ticks, which is the FLOOR (see below)')
  assert.ok(rowsForSurface(r.rows, 'debuffs').includes(row), 'the DEBUFFS window, which is where it was missing')
  assert.ok(
    r.active.some((a) => a.spell === 'Vengeance of the Wild' && a.target === 'a fire giant warrior'),
    `no held instance: ${r.active.map((a) => `${a.spell}@${a.target ?? 'self'}`).join(', ') || '(none)'}`
  )
})

test('…and without the correction the same landing names no spell, which is the whole report', () => {
  const bare = buildSpellDb(applySpellCorrections(RAW, HAND_DERIVED).spells)
  try {
    const r = replay(DRUID_DOT, 10, bare)
    assert.deepEqual(r.rows, [], 'no row at all: the landing sentence was in no table under any key')
    assert.equal(
      castOnOtherSuffix(bare.byKey.get('vengeance of the wild')?.msgCastOnOther ?? ''),
      null,
      'because the scrape wrote `Target` where the table keys on `Someone`'
    )
    assert.equal(
      matchCastOnOtherSuffix('a fire giant warrior has been consumed in the flames of the wild.', bare),
      null,
      'and the live sentence therefore resolved to nothing'
    )
  } finally {
    installSpellDb(loadSpellDb())
  }
})

test('JOS-245: the restored landing is what lets the bar LEARN the rank`s real duration', () => {
  // THE HONEST-DURATION HALF. The DB states 5 ticks / 30 s for a spell the reporter casts at rank
  // VI, and his slice's one complete cycle runs 47 s from landing to wear-off — eight damage ticks,
  // not five. That is the scaling-duration defect `spellCorrectionsList.ts` records under WRONG
  // NUMBER, and the answer to it is `SpellStats.estimateFor`: the DB figure is a FLOOR and a clean
  // observed cycle raises it. What was missing was the CYCLE — with no landing there was no
  // instance, so the wear-off closed nothing and no span could ever be minted. It can now.
  const cycle: [number, string][] = [
    ...DRUID_DOT,
    // The wear-off the slice prints, mob swapped: `Your <X> spell has worn off of <mob>.` is a
    // `buffFade` the fade path already understood — it just never had an instance to close.
    [49, 'Your Vengeance of the Wild spell has worn off of a fire giant warrior.'],
    [57, 'You begin casting Vengeance of the Wild VI.'],
    [59, 'a fire giant warrior has been consumed in the flames of the wild.']
  ]
  const r = replay(cycle, 65)
  const row = r.rows.find((x) => x.target === 'a fire giant warrior')
  assert.ok(row, 'the second cast opens its own row')
  assert.equal(row.durationMs, 47_000, 'the observed span of the first cycle, not the wiki`s 30 s')
  const held = r.active.find((a) => a.spell === 'Vengeance of the Wild')
  assert.equal(held?.durationSource, 'observed', 'and the bar says which number it is showing')
  assert.equal(held?.n, 1, 'one clean cycle, which is exactly what the correction made observable')
})

test('JOS-103`s type-less line has a typed event now: Spirit of the Puma', () => {
  // AGENTS.md records `<X> growls with the spirit of the puma.` as the family with "NO typed event
  // at all", which is why the shipped suggestion for it is a `raw` capture trigger. The subject was
  // the whole reason. The raw alert is unaffected — a `raw` condition tests `ev.raw` whatever the
  // kind turns out to be — so this is additive for the wizard and for the timers both.
  installSpellDb(loadSpellDb())
  const ev = parseEvent('[Sat Aug 01 18:38:10 2026] a young puma growls with the spirit of the puma.', 0)
  assert.equal(ev?.kind, 'buffApply')
  assert.equal(ev.kind === 'buffApply' ? ev.spell : '', 'Spirit of the Puma')
})

