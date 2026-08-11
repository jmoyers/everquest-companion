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
// WHAT EVERY ROW BELOW IS.
//
// The sentence is the WIKI'S OWN, unchanged. Only the subject token is restored, which is why the
// default attribution is `sole`: no DB message anywhere is closer to the live line (nothing else
// matches it at all — the tail is new to the table), so no other spell can be meant. `hits` is the
// whole-log count of the RESTORED shape in `eqlog_Primitive_freeport.txt`, measured 2026-08-10,
// and every one of those lines had no DB owner before this file existed.
//
// A row may override the attribution when a caster is demonstrably attached to the landing. Odium
// and the Tuyen chants are the ones here that do: their evidence is a reporter's slice, cited by
// report id, and that is the same route JOS-161 used for a song the owner never sang.
//
// ─────────────────────────────────────────────────────────────────────────────
// A ROW MAY ALSO JOIN A SUFFIX INSTEAD OF MINTING ONE (JOS-189), and the two shapes are held to
// different halves of the same rule.
//
// Every row above MINTS a tail: the restored sentence is new to the table, so nothing it matches
// was matching anything before and `sole` is the honest attribution. The Tuyen chant pair does not.
// All four of that family write ONE landing sentence and the scrape gave two of them `Someone` and
// two of them `Target`, so the suffix already exists and is already owned — restoring the subject
// adds CANDIDATES to a sentence the cast anchor is already narrowing, and mints nothing.
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

/**
 * One subject restoration. `field` and the sentence itself are implied — a row cannot express
 * anything but "this spell's cast-on-other message names its subject with the wrong token" — so
 * the shape carries only what varies. The full `SpellCorrection` is derived below.
 */
interface SubjectDrift {
  /** Exact `SpellEntry.name`s, as the SCRAPE spells them. */
  readonly spells: readonly string[]
  /** The wiki's sentence, verbatim, with whatever subject the scrape left on it. */
  readonly from: string
  /** The same sentence with `Someone`/`Someone's` restored. Nothing else changes. */
  readonly to: string
  /** Whole-log occurrences of the restored shape in the owner's log (see the header). */
  readonly hits: number
  /** Overrides the default `sole` when a cast is demonstrably attached to the landing. */
  readonly attribution?: CorrectionAttribution
  /** Replaces the generated evidence line when there is more to say than a count. */
  readonly evidence?: string
}

/** Ordered by owner-log frequency, so a reader checking the load-bearing ones reads the top. */
const SUBJECT_DRIFTS: readonly SubjectDrift[] = [
  { spells: ['Celestial Echo', 'Echo of Health', 'Echoing Light', 'Sacred Echo'],
    from: 'Target is embraced by a spirit of healing.',
    to: 'Someone is embraced by a spirit of healing.',
    hits: 166 },
  { spells: ["Forest's Renewal", "Kragg's Salve", 'Spirit Salve'],
    from: "Target's wounds heal.",
    to: "Someone's wounds heal.",
    hits: 84 },
  { spells: ['Healing Light'],
    from: "'s wounds heal.",
    to: "Someone's wounds heal.",
    hits: 84,
    evidence:
      'Owner log: 84 lines of `<T>`s wounds heal.`, which had no DB owner. The same sentence as the entry above, from the OTHER shape of the same drift — this row lost its subject entirely where those three kept a placeholder — so the two land on one suffix and the four spells share it.' },
  { spells: ['Tangling Weeds'],
    from: "Target's movements slow as their feet are covered in tangling weeds.",
    to: "Someone's movements slow as their feet are covered in tangling weeds.",
    hits: 68 },
  { spells: ["Elnerick's Entombment of Ice"],
    from: 'Target is entombed by elemental ice.',
    to: 'Someone is entombed by elemental ice.',
    hits: 39 },
  {
    spells: ['Blooming Heal', 'Blossoming Heal', 'Budding Heal', 'Efflorescing Heal', 'Flowering Heal', 'Sprouting Heal'],
    from: 'Target is seeded with healing energy.',
    to: 'Someone is seeded with healing energy.',
    hits: 28 },
  {
    spells: ["Tuyen's Chant of Disease", "Tuyen's Chant of Poison"],
    from: 'Target begins to chant.',
    to: 'Someone begins to chant.',
    hits: 6,
    attribution: 'cast',
    evidence:
      'THE REPORTED DEFECT (01KZN3FSW4BQ519N3TV8CQ1TC1, v0.17.0, a bard): "chant of frost being active when it was not on a mob and NOT showing chant of poison or disease. The only one it had correct was chant of Flame". All four chants share ONE landing sentence and the DB gave it only TWO owners — Flame and Frost carry the `Someone` subject, Disease and Poison carry `Target`, so they were in no table at all. That is the whole report in one line: with only two candidates, `admitLanding` resolves each landing to the most recently cast of THEM, so the disease and poison landings were filed under frost — a frost the slice shows RESISTED on every cast — and the two real debuffs had no row. Restoring the subject makes all four candidates, and the bard`s 3 s chain then resolves each landing to its own cast. The suffix ALREADY EXISTS, so this creates no new tail: it adds two owners to a sentence the cast anchor was already narrowing. Owner log: 6 lines of the shape, with Flame 14 / Disease 12 / Frost 11 third-person casts beside them.'
  },
  { spells: ['Odium'],
    from: 'Target staggers under a dark curse.',
    to: 'Someone staggers under a dark curse.',
    hits: 19,
    attribution: 'cast',
    evidence:
      'THE REPORTED DEFECT. Report 01KZMS8NG4FBYCP1P51VK8WP1B (v0.14.0, a shaman): 10 `You begin casting Odium VI.` lines, 7 of them followed within 0-1 s by `<mob> staggers under a dark curse.` and the other 3 by a resist. Owner log: 19 lines of the shape with no DB owner, 0 of the wiki form. Vexing Mordinia writes a different curse sentence, so nothing else can be meant.' },
  { spells: ["Riftwind's Protection"],
    from: "'s skin glows with a pale greenish tint.",
    to: "Someone's skin glows with a pale greenish tint.",
    hits: 16 },
  { spells: ['Leviathan Eyes'],
    from: "Player's eyes fill with the water of the deep.",
    to: "Someone's eyes fill with the water of the deep.",
    hits: 12 },
  { spells: ['Blessing of Faith'],
    from: 'Target is quickened by the Blessing of Faith.',
    to: 'Someone is quickened by the Blessing of Faith.',
    hits: 8 },
  { spells: ['Blessing of the Knight'],
    from: "Target's hands gain a pale gold glow.",
    to: "Someone's hands gain a pale gold glow.",
    hits: 8 },
  { spells: ['Guard of Vie'],
    from: 'has been surrounded in a dull white aura.',
    to: 'Someone has been surrounded in a dull white aura.',
    hits: 8 },
  { spells: ['Blessing of Piety'],
    from: 'is quickened by the Blessing of Reverence.',
    to: 'Someone is quickened by the Blessing of Reverence.',
    hits: 6 },
  { spells: ['Insidious Retrogression'],
    from: "'s body is pelted by spores.",
    to: "Someone's body is pelted by spores.",
    hits: 6 },
  { spells: ['Minor Familiar'],
    from: 'Player summons forth a minor familiar.',
    to: 'Someone summons forth a minor familiar.',
    hits: 6 },
  { spells: ['Spiritual Brawn'],
    from: 'Target has been filled with spiritual brawn.',
    to: 'Someone has been filled with spiritual brawn.',
    hits: 6 },
  { spells: ['Pack Shrew', 'Spirit of the Shrew'],
    from: 'Target begins to move more gracefully.',
    to: 'Someone begins to move more gracefully.',
    hits: 5 },
  { spells: ['Spike of Disease'],
    from: "'s wounds fester.",
    to: "Someone's wounds fester.",
    hits: 5 },
  { spells: ['Laceration'],
    from: 'Soandso begins to bleed.',
    to: 'Someone begins to bleed.',
    hits: 4 },
  { spells: ["Nature's Precision"],
    from: 'becomes one with their weapons.',
    to: 'Someone becomes one with their weapons.',
    hits: 4 },
  { spells: ['Blessing of the Page'],
    from: "Other_Player's hands have a dull gold glow.",
    to: "Someone's hands have a dull gold glow.",
    hits: 3 },
  { spells: ['Promised Renewal'],
    from: 'Target is promised a divine renewal.',
    to: 'Someone is promised a divine renewal.',
    hits: 3 },
  { spells: ['Ward of the Divine'],
    from: 'is cloaked in the blessing of a divine touch.',
    to: 'Someone is cloaked in the blessing of a divine touch.',
    hits: 3 },
  { spells: ['Ward of Vie'],
    from: 'has been surrounded in a faint white aura.',
    to: 'Someone has been surrounded in a faint white aura.',
    hits: 3 },
  { spells: ['Dustdevil'],
    from: "'s body is crushed by flying debris.",
    to: "Someone's body is crushed by flying debris.",
    hits: 2 },
  { spells: ['Blood of Pain'],
    from: 'is tormented by the blood of pain.',
    to: 'Someone is tormented by the blood of pain.',
    hits: 1 },
  { spells: ['Dark Soul'],
    from: 'has been surrounded in cold darkness.',
    to: 'Someone has been surrounded in cold darkness.',
    hits: 1 },
  { spells: ['Dark Temptation'],
    from: "'s aura grows cold.",
    to: "Someone's aura grows cold.",
    hits: 1 },
  { spells: ['Hawk Eye'],
    from: "'s eyes sharpen with an aura of avian presence.",
    to: "Someone's eyes sharpen with an aura of avian presence.",
    hits: 1 },
  { spells: ['Mana Detonation'],
    from: 'Target is pierced by extraplanar energy.',
    to: 'Someone is pierced by extraplanar energy.',
    hits: 1 },
  { spells: ['Mana Ignition'],
    from: 'Target is pierced by cosmic energy.',
    to: 'Someone is pierced by cosmic energy.',
    hits: 1 },
  {
    spells: ["Sha's Lethargy"],
    from: 'feels lethargic.',
    to: 'Someone feels lethargic.',
    hits: 4,
    attribution: 'cast',
    evidence:
      'THE SENTENCE JOS-174 REFUSED, and the one that had to be TAKEN rather than added (see THE PRECEDENCE CASE below). Reported by a beastlord (01KZP5B8F9GJ0J0BNCP29DH59J, v0.18.0): "Sha`s Lethargy the Beastlord lvl 50 slow doesn`t show up in the debuff windows". Owner log, 1,557,569 lines: `<T> feels lethargic.` occurs 4 times and ALL FOUR fall within 12 s (p50 3 s) of one of the 33 `<Name> begins casting Sha`s Lethargy.` lines, so every occurrence of the sentence in the whole log is a Sha`s Lethargy landing and no other spell in the DB writes it. The wiki form occurs 0 times, as it must — it has no subject at all.'
  },
  { spells: ['Spirit of the Puma'],
    from: 'Target growls with the spirit of the puma.',
    to: 'Someone growls with the spirit of the puma.',
    hits: 1,
    evidence:
      'Owner log: 1 line, `Fail growls with the spirit of the puma.` (Sat Aug 01 18:38:10), which had no DB owner. AGENTS.md records this exact line as the one with "NO typed event at all" — JOS-103 shipped a `raw` capture suggestion because there was no typed path for the family. There is one now, and the raw alert is unaffected: a `raw` condition tests `ev.raw` whatever the event`s kind turns out to be.' },
  { spells: ['Voice of Darkness'],
    from: 'speaks with the voice of darkness.',
    to: 'Someone speaks with the voice of darkness.',
    hits: 1 }
]

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
