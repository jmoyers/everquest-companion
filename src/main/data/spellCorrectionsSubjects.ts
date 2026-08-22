// THE SUBJECT PLACEHOLDER THE SCRAPE LOST — THE SWEEP (JOS-174).
//
// This is one drift class of the corrections overlay, and it has its own file because it is the
// only one that comes in bulk. READ `spellCorrectionsList.ts` FIRST: the evidence bar, the five
// drift classes and the idempotence rules are stated there and every entry below is held to them.
// `spellCorrections.ts` is the mechanism; this list is appended to that one and is applied by the
// same pass, in the same shape.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT, AND WHY IT IS ONE SHAPE RATHER THAN ONE SPELL.
//
// A 0.14.0 shaman reported that Odium never appears on the debuff timer, "leveled to VI if that's
// the issue". The rank was NOT the issue and the ticket's hypothesis was wrong: `canonKey` folds
// ` VI` off a cast line and `You begin casting Odium VI.` anchors the DB's `Odium` row perfectly.
//
// What is missing is the LANDING. `castOnOtherSuffix()` (spellDb.ts) builds the cast-on-other
// table by stripping the wiki's `Someone ` subject and keying on the tail that follows it — the
// invariant half of the sentence, the half a log line ends with. The wiki writes Odium's
// third-person landing as `Target staggers under a dark curse.`, subject `Target`, so it yields NO
// suffix at all, the spell is in NO table, `<mob> staggers under a dark curse.` classifies as
// `{kind:'unknown'}`, and no `buffApply` is ever emitted. The overlay could not draw a bar because
// nothing ever told it one had started.
//
// MEASURED on the committed scrape: 242 of the 1,528 spells with a cast-on-other message are in
// that state (`Player` 58, `Target` 46, a bare possessive 28, `Soandso` 8, `Other_Player` 2, and
// the rest with the subject dropped entirely so the sentence starts on its verb). JOS-103 counted
// 68 of them from the DETRIMENTAL side and responded by SUPPRESSING the `lands` suggestion
// template for those spells, which was the honest move at the time — a guessed trigger that never
// fires is worse than an absent one — but it treated the symptom.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A LIST AND NOT A WIDER STRIPPER, WHICH IS THE OBVIOUS FIX AND IS WRONG.
//
// Teaching `castOnOtherSuffix()` the wiki's whole placeholder vocabulary would be one edit and
// would cover all 242. `subjectCapturePattern` (shared/alertCaptures.ts) already knows all four
// tokens, so the asymmetry looks like an oversight. It is not, and the difference is the reason:
// that function emits a PER-SPELL regex, while this table is a SHARED namespace where each new
// tail competes with 648 others by table order and by the cascade's ordering above it.
//
// Two measurements, both made for this ticket against the owner's whole log (1,533,938 lines) and
// the real parser:
//
//   * 66 of the 242 restored sentences occur ZERO times in that log. Minting ~100 suffixes for
//     sentences nobody has ever observed is the awaiting-sample law's exact prohibition, and every
//     one of them would be live in the matcher, competing for real lines.
//   * A blanket widening is NOT INERT. Of the 34 restored suffixes that DO have log evidence, 32
//     sample lines classify as `{kind:'unknown'}` today — strictly additive, cannot shadow
//     anything — and TWO do not: ` looks powerful.` (Infusion of Spirit) and ` feels lethargic.`
//     (Sha's Lethargy) are already claimed by `classifySpellEmote`, which sits BELOW
//     `classifyDbBuff` in the cascade. Correcting those two would silently RECLASSIFY existing
//     lines, so JOS-174 left both out. One of them has since been admitted WITH the argument that
//     absence stood in for — see THE PRECEDENCE CASE below; the other is still refused.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PRECEDENCE CASE: `<mob> feels lethargic.` (JOS-189).
//
// A beastlord reported that Sha's Lethargy — the level-50 slow — never reaches the debuff window
// (01KZP5B8F9GJ0J0BNCP29DH59J). It is the sentence JOS-174 named and refused, so it is the first
// entry in this file that TAKES a line from another classifier rather than adding one, and it is
// worth being clear about what was and was not in doubt.
//
// THE CASCADE ORDER WAS NEVER THE DOUBT. `classifyDbBuff` sits above `classifySpellEmote`
// deliberately and says why in its own doc comment: a line that EXACTLY matches a DB message names
// the exact spell, which is strictly more informative than a permissive emote candidate. What
// JOS-174 was missing was not a rule, it was the OTHER HALF OF THE ARGUMENT. Every entry in this
// sweep could be admitted on a count alone precisely because nothing was being taken; a sentence
// that is already parsing needs somebody to say what is downstream of the classifier losing it.
// So this entry supplies both halves.
//
//   THE COUNT. Owner log, 1,557,575 lines, parsed TWICE in one process with and without this one
//   correction: `buffApply` 106,507 -> 106,511, `spellEmote` 1,858 -> 1,855, `unknown` 141,281 ->
//   141,280. Every other kind byte-identical. FOUR lines move, and here they are, all of them:
//   `Magi P`tasa feels lethargic.` (x2) and `Vebarn feels lethargic.` go spellEmote -> buffApply,
//   and `a flighty fiend feels lethargic.` goes unknown -> buffApply.
//
//   THE FOURTH LINE IS ITS OWN ARGUMENT. `EMOTE_PET_RE` requires a CAPITALISED subject, and an
//   articled mob name is lowercase — so the family was already split, three lines going to the
//   emote learner and the fourth going nowhere, purely on whether the mob's name had "a " in front
//   of it. That is not an owner; it is an accident.
//
//   WHAT THE EMOTE PATH DOES WITH THEM, both consumers. `BuffsModule.mineForOverlay` treats
//   `spellEmote` and `buffApply` IDENTICALLY — both feed `observeMessage(text, ts, 'landing')` —
//   so the observed-message overlay miner sees exactly the same stream before and after, and that
//   is the half most easily missed. The only other consumer is `onSpellEmote`, which names the
//   SUBJECT of the player's own pending cast once the same text has been seen twice inside a five
//   second window. That is a cast-target DISCRIMINATOR, and what replaces it here is a landing
//   bound to the named entity outright — which is the thing the discriminator exists to
//   approximate. For this sentence the trade is not close: the owner cast Sha's Lethargy ZERO
//   times in the whole log (all 33 casts are other players'), so any pending cast of his those
//   three lines could have named a subject for was a DIFFERENT spell, and the emote was offering
//   to attribute somebody else's slow to it.
//
// ` looks powerful.` (Infusion of Spirit) IS STILL REFUSED, and the same measurement is why the two
// are not the same case. It occurs 15 times whole-log, TWELVE of them on player names and three on
// a mob, arriving in same-second PAIRS of players — the shape of a group buff landing, which is
// exactly the shape the emote learner's cast-target discrimination is for. No report names it, the
// owner is not the shaman casting it, and nothing in his log attaches those lines to a cast. It
// waits for a beastlord's equivalent: a user who says the bar is missing, and a log that says which
// cast each line belongs to. That is the awaiting-sample law, applied to the one sentence left.
//
// So: the registry, one measured entry per proven sentence, exactly like every other drift class.
// A future spell earns an entry by clearing the bar, not by matching a pattern.
//
// ALSO EXCLUDED, for a different reason: the rogue poison Strikes and Venoms (`begins to bleed
// profusely!`, `'s limbs move slower!`, `screams as poison burns their veins!`, …). Those lines
// are claimed by `classifyPoisonProc`, which is ABOVE `classifyDbBuff`, so restoring their subject
// would change nothing and would look like coverage. shared/poisons.ts owns that family.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ROW THE OWNER'S LOG CANNOT WITNESS: `<mob> has been consumed in the flames of the wild.`
// (JOS-245).
//
// A druid reported that Vengeance of the Wild — the level-49 DoT — never appears in the debuff
// window (01KZSR4HQVWJKDG0NCDGZ01928, v0.21.0). The shape is this sweep's, exactly: the wiki writes
// the third-person landing as `Target has been consumed in the flames of the wild.`, so the spell
// yields no suffix, is in no table, and the live line classifies as `{kind:'unknown'}` — MEASURED
// against the committed DB, before this entry, on the reporter's own bytes.
//
// WHAT IS NEW IS THE EVIDENCE LOG. Every row above is anchored in `eqlog_Primitive_freeport.txt`,
// and `hits` is a count in it. This spell has NO trace there at all: measured 2026-08-12 over
// 1,608,490 lines, the restored sentence occurs 0 times, the wiki form 0 times, the self landing
// (`You are consumed by the flames of the wild.`) 0, the wear-off (`The wild flames fade away.`) 0,
// and the words `Vengeance of the Wild` never appear in any line of any kind. The owner is not a
// druid of that level and nobody has cast it near him, so his log can neither confirm nor deny the
// sentence, and waiting for it to would be waiting forever.
//
// So this row's evidence log is the REPORTER'S SLICE, cited by report id — the same route Odium and
// the Tuyen chants use for their cast attribution, promoted here to carry the count as well, and the
// same route AGENTS.md already prescribes for a defect that exists only in somebody else's log. What
// the slice states, measured through the real parser: 3,405 lines, 7 `You begin casting Vengeance of
// the Wild VI.` casts, 6 lines of `<mob> has been consumed in the flames of the wild.` — one per
// cast, every one of them at EXACTLY +2 s (the DB's own 3 s cast time, rounded by the log's
// one-second stamp), and the seventh cast is the one the slice shows INTERRUPTED. Zero of the wiki
// form. That is a stronger cast attribution than most rows above can show, on a smaller log; what it
// cannot show is a whole-log frequency, and `hits: 0` says so rather than borrowing a number.
//
// The tail is minted, not joined, and nothing else in the DB comes near it: no other spell message
// mentions flames of the wild, and no existing suffix is a suffix of this one or has it as one
// (`tests/spellCorrectionsSubjects.test.mts` proves the second half for every row here). So the
// attribution would be `sole` on the table alone; it is `cast` because the slice shows the casts.
//
// THE BLAST RADIUS IS PROVABLY ZERO, and it was measured anyway rather than argued. The owner's
// whole log parsed TWICE in one process, with and without this one correction: 1,608,487 events
// across 56 kinds, and NOT ONE count moves. That is what a row whose sentence the evidence log has
// never printed looks like from the tripwire's side — the JOS-174 and JOS-189 rows each moved lines
// here, this one cannot, and the same measurement says so in both directions.
//
// NOT A DURATION FIX, and the difference matters (the WRONG NUMBER note in `spellCorrectionsList.ts`
// governs it). The DB states 5 ticks / 30 s and the slice's one complete cycle runs 47 s from
// landing to `Your Vengeance of the Wild spell has worn off of Lady Vox.` — eight damage ticks, not
// five, because the reporter is casting rank VI. That is the scaling-duration defect those two
// reports named, not a wrong sentence, and `SpellStats.estimateFor` is the thing that answers it: the
// DB figure is a FLOOR and a clean observed cycle raises it. This entry's job is to make the cycle
// OBSERVABLE at all — before it, there was no landing, so no instance, so nothing for the learner to
// pair the wear-off with and no bar to raise.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PET-BINDING HALF: A LOST SUBJECT CAN COST YOU A WHOLE PET, NOT JUST A BAR (JOS-349).
//
// Every row above is a missing debuff/buff BAR. `Tiny Companion` is the first whose damage is
// somewhere else entirely, and the reason is JOS-188's third binding signal: a summoned pet with no
// `… Master.` tell is bound by YOUR OWN CAST of a `targetType: Pet` spell plus the named landing
// that resolves it, and `CharmModel.petBuffLanding` requires the armed spell to be AMONG the
// landing's candidates. A spell in no suffix table is in no candidate list, so the one rung that
// binds an unordered pet cannot fire for it — the arm is correct, the landing parses, and the two
// can never meet.
//
// THE REPORT (01M00ACVVFDRVWBXRDCFPHESNZ): "Pet is not getting parsed. at the end of the log his
// name is Zarober." Measured on the reporter's own 6,544-line slice through the real engine, before
// this row: the shaman re-summons at 16:16:08 (`You summon a guardian spirit.`), buffs the new pet
// at 16:16:21 (`You begin casting Tiny Companion.`), the landing names it at 16:16:25 (`Zarober
// shrinks.`) — and `petDisplayNames()` ends `[]`, with all 142 Zarober lines, melee and spell,
// attributed to nobody. The predecessor `Kastik` is in the same state; the only pet-shaped lines in
// the whole slice are one inert `petSay` and this pair. That is JOS-188's reported defect reached
// through a different door: not a missing RULE, a spell the rule's evidence could not name.
//
// SIX MORE PET-ONLY SPELLS ARE STILL IN THAT STATE and they get no row here, which is the
// awaiting-sample law rather than an oversight. Measured over the committed DB: 40 spells are
// `targetType: Pet`, 33 key a cast-on-other suffix, and 7 do not — `Tiny Companion` (this row),
// `Ward of Calliav`, `Primal Remedy`, `Refresh Summoning`, `Form of Bleached Bone`, `Form of Chilled
// Bone` and `Minion of Hate`, the last of which states no third-person message at all and so cannot
// be corrected by anything. Each of the other five would MINT a tail rather than join one, none is
// named by any report, and none has a cast in the owner's log; a pattern is not evidence, so they
// wait for a log that prints the pair.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE VALIDATOR AND ITS CENSUS — THE WAVE THAT NOBODY REPORTED (JOS-412).
//
// FIVE REPORTS REACHED THIS FILE ONE AT A TIME, and the sixth (GitHub issue 43, in-app report
// 01M0BSTF14C2CHJ3D38BACGDZC: the shaman `Curse` at 34, which is `Odium` at 43 one rank down the
// SAME LINE) is the one that says the arrangement was wrong. Odium was swept in JOS-174 and its own
// junior rank sat unmatchable for ten more days, because nothing in the tree ever asked the
// question the sweep exists to answer. `src/main/data/spellSubjectAudit.ts` now asks it on every
// load, and `tests/spellSubjectAudit.test.mts` pins the ANSWER as a census — so a spell in this
// state is a failing test rather than a report six weeks later.
//
// WHAT THE VALIDATOR PROVED, over the effective registry (owner ruling 2026-08-19: fix Curse and
// sweep the whole class). 153 rows carry a third-person landing the suffix table cannot key, and
// they are TWO populations, not one:
//
//   * 71 rows over 37 sentences carry a WRONG SUBJECT TOKEN — the wiki wrote `Target`, `Player`,
//     `Soandso` or `Other_Player` where the table keys on `Someone`. The wiki has DECLARED that a
//     name goes there, so the repair is a one-token swap and nothing about the sentence is guessed.
//   * 82 rows carry NO SUBJECT AT ALL — the wiki cropped it (`'s wounds fester.`, `fades away.`).
//     JOS-174's population, restorable only as a CLAIM about a cropped sentence, and 16 of them are
//     poison procs a classifier above `classifyDbBuff` already owns.
//
// AND THE FIRST POPULATION SPLITS AGAIN, along the line JOS-189 drew. 17 of the 37 sentences are
// JOINS: the family already owns the suffix under a sibling's correctly-spelled `Someone`, so
// restoring the subject MINTS NOTHING and only adds candidates to lines that already parse. 20 are
// MINTS, and exactly ONE of those has evidence in the owner's log — `Curse`, at 68 landings.
//
// SO THIS WAVE IS 18 ROWS: every join (the safe shape, whose whole cost is a longer candidate list)
// plus the one evidenced mint. The other 19 mints occur ZERO times in 2,138,726 lines and no report
// names them, which is the awaiting-sample law verbatim — the same refusal JOS-349 recorded for six
// pet spells, and it is now a CENSUS ENTRY rather than a silence.
//
// MEASURED WHOLE-LOG, the law-8 tripwire (2,140,000 lines of `eqlog_Primitive_freeport.txt` parsed
// twice in one process, 2026-08-19, the committed DB against the DB minus these 18 rows):
//
//   * ONE kind transition, and it is the report: `unknown` 203,934 -> 203,866 and `buffApply`
//     141,980 -> 142,048. SIXTY-EIGHT lines, every one of them a `<mob> has been cursed.` that had
//     no owner. All 59 other event kinds byte-identical.
//   * 31,737 buffApply lines get a LONGER CANDIDATE LIST and nothing else — which is what a join
//     looks like from the outside. The big one is ` staggers.` at 29,897 lines going 37 candidates
//     to 38.
//   * AND 669 LINES CHANGE WHICH NAME LEADS, which JOS-349 did not have to say and this wave does.
//     `ev.spell` is the parser's best-effort FIRST candidate (JOS-84 — `candidates` carries the
//     truth and the model resolves against the caster's own casts), and first is decided by
//     REGISTRY ORDER: `buildSpellDb` walks the spell list, and the first row to claim a suffix
//     heads its bucket. A joined spell that sorts BEFORE the sibling that used to head it therefore
//     takes the lead. Six pairs do, all of them within one family:
//       358  Pillage Enchantment -> Beholder Dispel      (` feels very dispelled.`)
//       174  Talisman of Altuna  -> Harnessing of Spirit (` looks tougher.`)
//        60  Skin Like Nature    -> Protection of Nature (`'s skin shimmers with divine power.`)
//        53  Illusion: Air Elemental -> Bounce           (`'s image shimmers.`)
//        16  Skin Like Diamond   -> Protection of Diamond
//         8  Form of the Great Bear -> Form of the Bear
//     Priced and accepted rather than argued away: nothing the MODEL decides moves — a landing is
//     still resolved against the cast that anchored it — and five of the six are two ranks of one
//     line. The odd one is `Beholder Dispel`, an NPC dispel now leading a sentence a player's
//     `Pillage Enchantment` also writes; that name only surfaces where no cast anchors the line,
//     which is the case the model already declines to open a bar for.
//
// TWO ROWS OF THE JOIN GROUPS ARE DELIBERATELY NOT NAMED, and the reason is the mechanism rather
// than the evidence: `Illusion: Air Elemental` and `Ring of South Ro` are DUPLICATE rows of a name
// whose FIRST row already keys, and `rowsFor` (spellCorrections.ts) writes a message correction to
// the first row of a name only. Naming them would report `satisfied` and change nothing. The
// validator sees those rows and says so (`spellUnreachable: false` — the SPELL is reachable, the
// duplicate row is not), which is exactly the distinction a census has to be able to draw.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CENSUS ANSWERS BACK: `<mob> is covered in a swarm of nifiliks.` (JOS-435).
//
// A ranger reported that Swarm of Pain — the level-40 DoT — never tracks in the Debuffs overlay
// (01M0GR6H8SJH69XS9W2RH61W90, v1.6.0). This is the census working in the direction JOS-412 did NOT
// design it for and the more useful one: the spell was ALREADY NAMED in
// `tests/spellSubjectAudit.test.mts`'s `NO_SUBJECT_CENSUS`, sitting in the 82-row cropped-subject
// population, and the reason it had no correction was stated there in advance — the awaiting-sample
// law, no log had printed the sentence attached to a cast. A report is that log arriving. The
// triage question was therefore not "what is wrong with this spell" but "is the row the census
// already lists now evidenced", which took one measurement instead of one investigation.
//
// AND THE EVIDENCE IS THE STRONGEST IN THIS FILE. Unlike `Vengeance of the Wild` (a slice) or
// `Sha's Lethargy` (four lines), the OWNER'S log holds both halves at volume: 219 of his own casts
// and 199 landings, 198 of them 0-3 s after one of those casts and the 199th 2 s after one of the
// 14 third-person casts, over 2,192,979 lines measured 2026-08-20. The row's `evidence` carries the
// gap histogram.
//
// THE MINT IS STRICTLY ADDITIVE, and it was MEASURED rather than argued — the half JOS-189 taught
// this file to say out loud. The owner's whole log parsed TWICE in one process with and without this
// one row (2,192,979 lines, 59 event kinds, 2026-08-20): `unknown` 210,432 -> 210,233 and
// `buffApply` 146,467 -> 146,666, EXACTLY 199 lines, and all 57 other kinds byte-identical. So no
// classifier loses a line and there is nobody downstream to account for. `Swarm of Pain` is the only
// registry row that mentions nifiliks in any field, and the minted tail is neither a suffix of an
// existing one nor has one as a suffix (`tests/spellCorrectionsSubjects.test.mts` proves that
// invariant for every row here).
//
// NOT A DURATION CLAIM, same as JOS-245: the DB states 1 Min and the reporter is casting rank V, so
// whatever the Legends re-tiering did to the number is `SpellStats.estimateFor`'s question — the DB
// figure is a FLOOR and a clean observed cycle raises it. This row's job is to make the cycle
// OBSERVABLE, because before it there was no landing, hence no instance, hence nothing for a
// wear-off to pair with.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT EVERY ROW BELOW IS.
//
// The sentence is the WIKI'S OWN, unchanged. Only the subject token is restored, which is why the
// default attribution is `sole`: no DB message anywhere is closer to the live line (nothing else
// matches it at all — the tail is new to the table), so no other spell can be meant. `hits` is the
// whole-log count of the RESTORED shape in `eqlog_Primitive_freeport.txt`, measured 2026-08-10
// (the JOS-412 block re-measured 2026-08-19 over 2,138,726 lines), and every one of those lines had
// no DB owner before this file existed.
//
// A row may override the attribution when a caster is demonstrably attached to the landing. Odium
// and the Tuyen chants are the ones here that do: their evidence is a reporter's slice, cited by
// report id, and that is the same route JOS-161 used for a song the owner never sang.
//
// A JOIN row takes `db` instead, which is the evidence bar's own third route and the exact claim a
// join makes: sibling entries of the same family ALREADY carry the replacement text verbatim, so
// the DB is its own witness and the odd row out is the typo.
//
// ─────────────────────────────────────────────────────────────────────────────
// A ROW MAY ALSO JOIN A SUFFIX INSTEAD OF MINTING ONE (JOS-189), and the two shapes are held to
// different halves of the same rule.
//
// Most rows MINT a tail: the restored sentence is new to the table, so nothing it matches was
// matching anything before and `sole` is the honest attribution. The Tuyen chant pair does not.
// All four of that family write ONE landing sentence and the scrape gave two of them `Someone` and
// two of them `Target`, so the suffix already exists and is already owned — restoring the subject
// adds CANDIDATES to a sentence the cast anchor is already narrowing, and mints nothing.
// `Tiny Companion` (JOS-349) is the second join and the same shape: `Ant Legs` and `Shrink` already
// own ` shrinks.` with the `Someone` subject.
//
// That is the SAFER of the two shapes, not the looser one, and it is the same move the
// hand-derived list already makes for the twenty-four gates and for Cease/Desist/Sacred Word. No
// new tail means no new competition for any line in the log; the only thing that changes is which
// spells `admitLanding` may choose between, and it still refuses to choose without a cast. What it
// must NOT be is a PARTIAL overlap — a tail that is a suffix of an existing one, or has one as a
// suffix — because that is the case where table order silently decides which spell a line means.
// `tests/spellCorrectionsSubjects.test.mts` splits the invariant exactly there: a restored suffix
// must either be absent from the table or be byte-identical to one already in it, never in between.

import type { CorrectionAttribution, SpellCorrection } from './spellCorrections'
// THE TABLE ITSELF IS NEXT DOOR, for the reason `spellCorrections.ts` states about its own list:
// a data file that grows by one entry per defect should not be counted against a code-mass ceiling
// shared with the machinery that reads it. The edge is the same shape too — the list imports only
// the TYPE from here, so it is one-way at runtime.
import { SUBJECT_DRIFTS } from './spellCorrectionsSubjectsList'

/**
 * One subject restoration. `field` and the sentence itself are implied — a row cannot express
 * anything but "this spell's cast-on-other message names its subject with the wrong token" — so
 * the shape carries only what varies. The full `SpellCorrection` is derived below.
 */
export interface SubjectDrift {
  /** Exact `SpellEntry.name`s, as the SCRAPE spells them. */
  readonly spells: readonly string[]
  /** The wiki's sentence, verbatim, with whatever subject the scrape left on it. */
  readonly from: string
  /** The same sentence with `Someone`/`Someone's` restored. Nothing else changes. */
  readonly to: string
  /**
   * Whole-log occurrences of the restored shape in the owner's log (see the header). ZERO is
   * allowed and means one of exactly two things, and the row's `evidence` must say WHICH — it is
   * never "we did not check":
   *
   *   * A MINT the owner's log cannot witness at all, so the row's evidence log is a REPORTER'S
   *     SLICE, cited by report id and counted there (JOS-245).
   *   * A JOIN whose sentence nobody has printed either. A join mints no tail (the family already
   *     owns the suffix), so its blast radius is provably zero in both directions and the count is
   *     a fact about the SENTENCE rather than about the correction (JOS-412, `Wave of Fire`).
   *
   * For a JOIN the count is the sentence's whole-log frequency under its EXISTING owners — the
   * lines this row adds a candidate to — not lines that had no owner.
   */
  readonly hits: number
  /** Overrides the default `sole` when a cast is demonstrably attached to the landing. */
  readonly attribution?: CorrectionAttribution
  /** Replaces the generated evidence line when there is more to say than a count. */
  readonly evidence?: string
}

/**
 * The default evidence line. Every route here is `sole` unless a row says otherwise, and `sole`
 * has one meaning: the tail is NEW to the suffix table, so no other spell's message matched these
 * lines and none can be meant. The count is what makes the claim checkable.
 */
function defaultEvidence(d: SubjectDrift): string {
  const plural = d.hits === 1 ? 'line' : 'lines'
  return (
    `Owner log: ${d.hits} ${plural} of the restored shape, which had no DB owner, and 0 of the ` +
    'wiki form. Subject restoration only: the sentence is the wiki`s own and the tail is new to ' +
    'the suffix table, so no other spell claimed those lines.'
  )
}

/** The drift table, as the overlay consumes it. Appended to `SPELL_CORRECTIONS`. */
export const SUBJECT_PLACEHOLDER_CORRECTIONS: readonly SpellCorrection[] = SUBJECT_DRIFTS.map(
  (d) => ({
    spells: d.spells,
    field: 'msgCastOnOther' as const,
    from: d.from,
    to: d.to,
    attribution: d.attribution ?? 'sole',
    evidence: d.evidence ?? defaultEvidence(d)
  })
)

/**
 * The sentences this sweep deliberately does NOT correct, and the reason, as data rather than prose
 * so the suite can pin it (`tests/spellCorrectionsSubjects.test.mts`).
 *
 * They have real owner-log evidence and would otherwise have earned an entry. They are already
 * claimed by `classifySpellEmote`, and `classifyDbBuff` runs ABOVE it in the cascade — so a
 * correction here would not ADD a match, it would TAKE one, reclassifying lines that are parsing
 * today. That is a different change with a different burden of proof: a measured whole-log blast
 * radius, and a statement of what the classifier losing the line was doing with it.
 *
 * JOS-174 wrote this list with TWO members. JOS-189 met that burden for one of them — `feels
 * lethargic.`, the beastlord slow, four lines whole-log, all four anchored to a cast of the spell —
 * and it has moved into the table above. THE PRECEDENCE CASE in this file's header carries the
 * measurement, and also why `looks powerful.` is not the same case and stays here.
 */
export const SUBJECT_DRIFT_REFUSED: readonly { spell: string; suffix: string; claimedBy: string }[] = [
  { spell: 'Infusion of Spirit', suffix: 'looks powerful.', claimedBy: 'spellEmote' }
]
