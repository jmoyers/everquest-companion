// OUR-SIDE CORRECTIONS TO THE SCRAPED SPELL DB (JOS-150).
//
// `spells.json` is a SCRAPE. `scripts/scrape-spells.ts` re-reads the eqlwiki
// `Template:Spellpage` pages and rewrites the file wholesale, so anything hand-edited into it is
// lost the next time somebody re-scrapes — and worse, the diff of a re-scrape stops being readable
// because our fixes and the wiki's changes are mixed into the same lines. This file is the other
// half of that arrangement: the wiki dataset stays PRISTINE and IDEMPOTENT under re-scrape, and
// everything we know that the wiki does not lives here, applied at load in `spellDb.ts`.
//
// WHY IT MATTERS AT ALL. The parser recognizes a spell landing or fading by matching the exact
// sentence the DB says it prints. One wrong word is total: a 0.14.0 druid reported that Drifting
// Death never tracks, and the slice showed why — the live game prints `<target> is engulfed BY a
// swarm.` and the wiki says `Someone is engulfed IN a swarm.`, so the landing line matched nothing
// and no bar could ever exist. That is not a bug in the matcher; it is one preposition of drift
// between a fan wiki and the shipped game, and there is no amount of matcher cleverness that
// fixes it. It gets fixed by writing down what the game really prints.
//
// THE EVIDENCE BAR — the rule this file lives or dies by, and the reason `evidence` is a required
// field rather than a comment. A correction is admitted ONLY when all four hold:
//
//   1. the wiki's text occurs ZERO times in the evidence log (1,460,978 lines of the owner's
//      `eqlog_Primitive_freeport.txt`, whole-log, measured 2026-08-09);
//   2. the replacement text DOES occur there;
//   3. the two differ by a stated mechanical drift — a preposition, an inflection, terminal
//      punctuation, a scrape artifact, a missing subject placeholder — never by a content word
//      that could name a DIFFERENT spell; and
//   4. it is ATTRIBUTED, by one of exactly three routes, named per entry:
//        `cast`   the owner demonstrably cast the spell and the replacement line follows the cast
//                 (the strongest, and the one the ticket asks for: N/M casts, measured);
//        `db`     sibling entries of the same family ALREADY carry the replacement text verbatim,
//                 so the DB is its own witness and the odd one out is the typo;
//        `sole`   no DB message anywhere is closer, so no other spell can be meant.
//
// Everything that failed the bar is REPORTED, not guessed at. The large majority of "the DB says a
// sentence the log never prints" is not drift at all: a DETRIMENTAL spell you cast lands on a MOB,
// so its `msgCastOnYou` and `msgWearsOff` print to the MOB and are unobservable in your own log
// forever. Sanity Warp, Color Shift, Enthrall, Entrance, Charm, Beguile, Cajoling Whispers, Strike,
// Smite, Flame Shock, Theft of Thought, Suffocating Sphere, Wandering Mind and the lull line
// (Pacify/Soothe/Calm/Lull) are all in that state and NONE of them is corrected here. Absence of
// evidence is not evidence of drift.
//
// AND NEITHER IS A WRONG NUMBER — WHAT THIS FILE IS NOT FOR (JOS-189). Two reports in the same wave
// looked like corrections and are not, because nothing about the wiki's SENTENCES is wrong in
// either. They are recorded here rather than forced into the table above, because the shape of the
// answer is what a reader of this file most needs to be able to tell apart.
//
//   `Short duration buffs don't show correct timers on the buffs window. Like Shield of Thistles,
//   and Sprouting Heal` (01KZNB36R74HF3A8BJ9N67R19Y), and `the timer for the spell Blooming Heal
//   keep reseting` (01KZPHASSS7R1E1Y6VTFSTJ9RV, with a slice). ONE defect, from both directions:
//   the DB duration is the wiki's figure for ONE level of a spell whose real duration scales with
//   the caster, and `SpellStats.estimateFor` treats it as a hard FLOOR that a clean observed cycle
//   may raise and can never lower (JOS-117 ruling 6, and rightly — it is what stops Invisibility's
//   20 minutes collapsing to the 4 m 24 of a run of early breaks).
//
//     * SHIELD OF THISTLES states 15 Min. Measured over the owner's whole log through the DB's own
//       pair (`You are surrounded by a thorny barrier.` -> `The brambles fall away.`): 6 self
//       cycles, 385 s / p50 551 s / 655 s. Every one of them BELOW the stated figure, so the floor
//       holds forever and the bar over-runs by four to eight minutes with no path to correcting
//       itself.
//     * THE SEEDED-HEAL FAMILY (Sprouting, Blooming, Blossoming, Budding, Efflorescing, Flowering)
//       states 24 seconds. On the reporter's own slice three Blooming Heal IV casts land and tick
//       for 27, 28 and 30 s — so the bar expires three to six seconds before the heal stops
//       healing, every cast. It cannot learn its way out either: not one of the six carries a
//       `msgWearsOff`, and the owner's whole log holds ZERO `Your <X> spell has worn off.` lines
//       for any of them, so no cycle can ever be paired and no sample can ever be minted.
//
//   Neither is a message this file could correct. `You feel a heal blooming within you.` really is
//   the self landing — the slice's own `Player Kallil creating instance` line names the reporter,
//   and the heal lines carry that same name — and the third-person half was already fixed by
//   JOS-174. What is wrong is a NUMBER and the rule that reads it, which is a change to the model
//   with its own burden of proof and its own ticket, not an entry in a table of sentences.
//
// THE ABSENT FIELD is the fourth drift class, and it is why `from` may be `null` (JOS-159). Almost
// everything here swaps one sentence for another, but the wiki can also state NOTHING where the
// game states something: `Allure`, the enchanter charm at 46, carries a cast time and a duration
// and no messages at all, so `Someone has been charmed.` named seven spells and not the one an
// enchanter actually casts. `from: null` says "the DB states nothing for this field" and is held
// to the same bar in both directions — it applies only while the field is genuinely ABSENT, it
// reports `satisfied` once a re-scrape supplies the same text, and it reports `stale` the moment a
// re-scrape supplies a DIFFERENT one. An empty field is not a licence to invent a sentence: the
// text still has to clear rules 2, 3 and 4 like every other line in this file.
//
// THE WRONG NAME is the fifth drift class, and it is why `field` may be `name` (JOS-161). The four
// above all assume the wiki and the game agree about WHICH SPELL is being described and disagree
// only about the words it prints. `Solon's Bewitching Bravura` — the bard mez at 39 — is the case
// where they disagree about the name itself: the wiki page's `spellname` is `Solon's Bravura` and
// the shipped game has never printed those two words in that order. A name is not decoration here,
// it is the JOIN KEY: `SpellDb.byKey` folds a cast line to it, so `You begin singing Solon's
// Bewitching Bravura IX.` anchored NOTHING; `SpellCatalogEntry.name`/`key` are it, so the alert
// wizard listed a spell no bard has; and `where.spell` is compared against it, so a landing alert
// and a break alert could not both be satisfied by any one string. Same bar, read for a name:
// rule 1 is "the wiki's name occurs zero times in the log", rule 2 "the replacement name occurs
// there", rule 3 a stated mechanical drift (a dropped word — never a different SPELL), rule 4 the
// same three attribution routes. A name correction patches EVERY row the DB names that way, unlike
// a message correction, which patches the first: the DB carries era/rank duplicates of one spell
// whose MESSAGES may legitimately differ (`Shock of Frost` has two rows saying two different
// things) but whose NAME cannot, and a half-renamed pair would put a phantom line in the catalog.
//
// THE WRONG POLARITY is the sixth drift class, and it is why `field` may be `spellType` (JOS-413).
// All five above are about WORDS; this one is about the wiki's TYPE COLUMN. `Pacify` is
// `spell_type = Beneficial` on eqlwiki and the owner has ruled that a lull is a DEBUFF, so a
// correction here writes the column rather than a sentence. The evidence bar is read one field
// over: rules 1 and 2 are the wiki's word against ours (`from`/`to`, idempotent exactly as a
// sentence is), rule 3's "stated mechanical drift" becomes a stated CATEGORY drift — the wiki filed
// the spell by who casts it rather than by what it does — and rule 4's `db` route carries it,
// because the wiki's OWN effect list is the witness against the wiki's own type column. It patches
// EVERY row of a name, like a name correction and for the same reason: duplicates cannot disagree
// about whether a spell is a good thing or a bad thing. The ruling, the derived census that keeps it
// honest and the measured blast radius live in `spellCorrectionsPolarity.ts`.
//
// THE WRONG LEVEL is the seventh drift class, and it is why `field` may be `classes` (JOS-415).
// Like the polarity it is a COLUMN rather than a sentence — the wiki's `classes` bullet list, which
// `shared/spellLevels.ts` reads into (class, level) pairs and `buildLevelUnlocks` turns into the
// "new at this level" cards. Reported 6AT44D (v1.5.0), verbatim: *For a necro, on level up to level
// 12. Shows Leach beting a spell. But leach was learned at lvl 9 for a necro.* He is right, and the
// wiki is its own witness: `Leach` has TWO pages, and the eqlwiki NECROMANCER SPELL LIST — the
// wiki's own index of what a necro gets when — carries the spell once, at level 9, linking the page
// titled `Leech`; its level-12 rows are Bind Affinity, Convoke Shadow and Lifedraw and none of them
// is this spell. The evidence bar read one column over: rule 1 is "the wiki's own class list does
// not place the spell at this level", rule 2 "it places it at ours", rule 3 a stated mechanical
// drift (a duplicate page whose `classes` line carries a note, `Level 12 Recourse Effect`, that the
// parser reads as the unlock level), rule 4 the `db` route — the DB, and the wiki behind it,
// contradicting itself. Like a name and a polarity it patches EVERY row of the name, and that
// matters most here: the two rows are exactly what disagree, `buildLevelUnlocks` emits one row per
// DB ROW, and the renderer folds by name only within ONE level — so a half-applied correction would
// leave the phantom level-12 card untouched. See `rowsFor` in spellCorrections.ts.
//
// IDEMPOTENCE, IN BOTH DIRECTIONS. Every correction states the text it REPLACES. If a re-scrape
// leaves the wiki text unchanged the correction applies; if the wiki is fixed upstream the entry
// is already correct and the correction reports `satisfied` and does nothing; if the wiki changes
// to some THIRD text the correction reports `stale` and `tests/spellCorrections.test.mts` fails,
// which is the whole point — a correction that has quietly stopped describing anything is worse
// than no correction, because it looks like coverage. A NAME correction is the one that cannot
// report `stale`, because a renamed row is no longer findable by the name the correction states:
// a wiki that fixes the name upstream reports `satisfied` (the row is already called `to`), and a
// wiki that renames it to some THIRD thing reports `unknownSpells`. The audit test fails on either
// list being non-empty, so the anti-rot guard is the same guard.

// THE MECHANISM IS NEXT DOOR. `spellCorrections.ts` holds the types, the report and
// `applySpellCorrections` — which is what every consumer imports, and which re-exports this list
// so the seam is unchanged. The two are apart only because this one is a DATA file that grows by
// one entry per defect and the repo's max-lines ceiling is about code mass; keeping the prose
// above beside the entries it governs is the whole point of the split.

import type { SpellCorrection } from './spellCorrections'
// THE SUBJECT-PLACEHOLDER SWEEP (JOS-174), appended below. It is one of the drift classes this
// header governs and is held to this file's evidence bar; it lives next door only because it is
// the one class that arrives in bulk (35 entries over 47 spell rows) and the repo's max-lines
// ceiling is about code mass. Its own header states why the sweep is a LIST rather than a wider
// subject stripper, which sentence it still refuses, and — for the one sentence it stopped
// refusing — what taking a line off another classifier costs, measured (JOS-189).
import { SUBJECT_PLACEHOLDER_CORRECTIONS } from './spellCorrectionsSubjects'
// THE SHAMAN HEAL-OVER-TIME LADDER (JOS-318), appended below. Also one of this header's drift
// classes — the SCRAPE STUB, which is the fourth (an absent field) wearing a placeholder — and also
// held to this file's evidence bar. It lives next door because its argument is long and this file's
// code-mass ceiling is shared with none of it; that file's header carries the report, the four rungs
// of the ladder and the reason the fourth rung is deliberately left uncorrected.
import { HEALING_LADDER_CORRECTIONS } from './spellCorrectionsHealing'
// THE POLARITY RULING (JOS-413), appended below. The SIXTH drift class and the only one that is not
// about a sentence: the owner ruled that the lull and memory-wipe families are DEBUFFS, whatever the
// wiki's type column says. It lives next door for the same reason the two above do — its argument is
// long, it carries a derived census that this file's code-mass ceiling should not be shared with, and
// a reader checking the ruling is checking the whole family at once.
import { POLARITY_CORRECTIONS } from './spellCorrectionsPolarity'

/**
 * The hand-derived overlay. Ordered by the drift it fixes, not by spell name, because the drifts
 * come in families and a reader checking one is checking all of them.
 *
 * All counts below are whole-log over the owner's `eqlog_Primitive_freeport.txt` (1,460,978 lines,
 * measured 2026-08-09). "N/M casts" means N of the M `You begin casting <Spell>.` lines in that log
 * are followed by the replacement shape within 12 s.
 */
const HAND_DERIVED_CORRECTIONS: readonly SpellCorrection[] = [
  // --- the reported defect, and its family: `in a swarm` -> `by a swarm` -------------------------
  {
    spells: ['Creeping Crud', 'Drifting Death', 'Drones of Doom', 'Stinging Swarm'],
    field: 'msgCastOnOther',
    from: 'Someone is engulfed in a swarm.',
    to: 'Someone is engulfed by a swarm.',
    attribution: 'sole',
    evidence:
      'Reported by a 0.14.0 druid and slice-proven for Drifting Death itself. Owner log: 12 lines of `<T> is engulfed by a swarm.` with no DB owner, 0 of the wiki form. The other three are the same druid DoT ladder (Stinging Swarm 10 → Creeping Crud 24 → Drones of Doom 32 → Drifting Death 40) sharing ONE wiki sentence, so whatever that sentence is it is the same for all four; Winged Death 53 writes a different one and is untouched.'
  },
  // --- the same preposition, three more families ------------------------------------------------
  // THE DARKNESS LINE, IN TWO PASSES — and the second one is why the first was written carefully.
  //
  // The whole family (Cascading 47, Dooming 27/44, Engulfing 11/20) writes `in darkness` for the
  // third-person landing, and the log has 124 lines of `by` and 0 of `in`. JOS-150 corrected ONLY
  // Engulfing Darkness, because its own `msgCastOnYou` already says `by` — the wiki disagreeing
  // with itself inside one entry, with 84 first-person `by` lines saying which half is right — and
  // it deliberately left the other two alone: the bard root pair below proves this game really does
  // change the preposition between ranks of one line, so a zero count may only mean nobody in this
  // log ever cast the OTHER rank.
  //
  // JOS-189 CLOSED THAT DOUBT with the thing it was waiting for: evidence that the other ranks ARE
  // cast in this log. They are, hundreds of times, and the sentence the wiki gives them has still
  // never once been printed. The report that asked is 01KZNWX8Y6YWXQ8YRM8KGWN48E (v0.18.0): "Debuff
  // tracker does not track Dooming Darkness (the darkness line for SK/Necro)."
  {
    spells: ['Engulfing Darkness'],
    field: 'msgCastOnOther',
    from: 'Someone is engulfed in darkness.',
    to: 'Someone is engulfed by darkness.',
    attribution: 'db',
    evidence:
      'Owner log: 123 lines of `<T> is engulfed by darkness.` with no DB owner, 0 of the wiki form, and 78 first-person `You are engulfed by darkness.` matching this same entry`s own msgCastOnYou.'
  },
  {
    spells: ['Cascading Darkness', 'Dooming Darkness'],
    field: 'msgCastOnOther',
    from: 'Someone is engulfed in darkness.',
    to: 'Someone is engulfed by darkness.',
    attribution: 'cast',
    evidence:
      'THE REPORTED DEFECT (01KZNWX8Y6YWXQ8YRM8KGWN48E, v0.18.0, an SK/necro). Owner log, 1,557,569 lines: `<T> is engulfed in darkness.` occurs ZERO times while `<Name> begins casting Dooming Darkness.` occurs 159 times and `Cascading Darkness` 36 — so both ranks ARE cast here, which is precisely what JOS-150 could not establish and why it left them alone. 17 of the 159 Dooming casts and 1 of the 36 Cascading casts are followed within 12 s (p50 3 s) by `<T> is engulfed by darkness.`; the rate is low because that sentence is SHARED with Engulfing Darkness (249 casts, 106 matched) and only the nearest cast can claim each of the 124 landings. Purely additive to the table: the suffix already exists, so this adds two candidates to a sentence the cast anchor already resolves and creates no new tail.'
  },
  // THE BARD BINDING PAIR — NOT CORRECTED FOR THREE TICKETS, AND CORRECTED NOW (JOS-384).
  //
  // JOS-150 wrote the note this entry replaces: Largo's Melodic Binding (bard 20) says `bound IN
  // strands of solid music.` while its direct upgrade Largo's Assonant Binding (bard 51) says
  // `bound BY`; the log had thousands of `by` and zero `in`, and the honest reading THEN was that
  // this is not drift at all but a level-20 song nobody in this log ever sang. That reading rested
  // on one thing — that the sentence's real owner is the level-51 song — and it is the thing the
  // awaiting-sample law was waiting to test.
  //
  // JOS-382 TESTED IT, from a direction nothing before had looked from: the RESIST half. The log
  // prints `<T> resisted your Largo's Melodic Binding!` 570 times and the Assonant resist line
  // ZERO times, interleaved with the 4,152 `bound by` emotes on one six-second SYMPHONIC AURA grid,
  // while the character is level 21-24. So the level-20 song was sung here, constantly, and the
  // level-51 one has never been cast in this corpus at all. `by` is MELODIC's sentence on Legends.
  //
  // WHAT ASSONANT KEEPS: its own text, unchanged. Nothing says the wiki is wrong ABOUT ASSONANT —
  // `bound by` is what the wiki gives it and what the game prints — so there is no drift to correct
  // and correcting it would be inventing one. The two therefore SHARE the sentence, which is
  // world-model law 3's ordinary case (EQ prints one sentence per spell FAMILY) and is what the
  // shared-message machinery exists for: `messageOverlay` files the text SHARED, so it never names
  // a spell on its own, and `buffLanding.ts` resolves it by EVIDENCE — the cast anchor first, so a
  // level-21 bard's `You begin singing Largo's Melodic Binding.` claims its own landing and the
  // level-51 song it cannot have does not. Pinned in `tests/largoBinding.test.mts`.
  //
  // The RESIST module used to carry this same correction locally, as a two-name pooling table in
  // `src/main/resist/songIdentity.ts`. Owner ruling 2026-08-16: an override on wiki data is
  // APP-WIDE or it is nothing, because a module-local one means the buff overlay, the alerts and
  // the timers keep reading a catalog the resist page has already decided is wrong.
  {
    spells: ["Largo's Melodic Binding"],
    field: 'msgCastOnOther',
    from: 'Someone is bound in strands of solid music.',
    to: 'Someone is bound by strands of solid music.',
    attribution: 'cast',
    evidence:
      "Owner log, 2,013,844 lines (whole-log, read-only, measured 2026-08-16): `<T> is bound in strands of solid music.` occurs ZERO times, `<T> is bound by strands of solid music.` 4,152 times. The attribution is the RESIST line rather than a cast line, because the aura prints no cast line at all — `You begin singing` occurs 0 times for either song in the whole log — and `<T> resisted your Largo's Melodic Binding!` is first-person, names the spell outright, and occurs 570 times against 0 for the Assonant form; the two shapes interleave on one six-second grid while the character is level 21-24, and a level-21 bard cannot have a level-51 song. Corroborated the `db` way as well: Assonant carries this exact replacement text verbatim, so the DB is its own witness for the wording. Purely additive at the suffix table — Assonant has owned `is bound by strands of solid music.` since the scrape, so this adds a second candidate to a sentence the cast anchor already resolves and mints no new tail."
  },
  // STILL NOT CORRECTED, and for the reason the entry above has now outgrown: Selo's Chords of
  // Cessation says `in chords` in the wiki against 7 log lines of `by chords` with no DB owner.
  // The shape is real, the SPELL is not established — no resist line, no cast line, nothing that
  // names it the way 570 lines name Melodic — so it waits for a bard's log rather than being
  // guessed. This is the awaiting-sample law, still applied, against a correction that would
  // otherwise look obvious by analogy.
  {
    spells: ['Resist Magic', 'Resistance to Magic'],
    field: 'msgCastOnYou',
    from: 'You feel resistant from magic.',
    to: 'You feel resistant to magic.',
    attribution: 'cast',
    evidence:
      'Resist Magic 2/4 casts (+3 s each); owner log 2 lines of the `to` form, 0 of the `from` form. The other two casts produced no landing at all.'
  },
  // --- the root line: the wiki names the feet, the game names the target ------------------------
  {
    spells: ['Fetter', 'Instill', 'Paralyzing Earth', 'Root'],
    field: 'msgCastOnOther',
    from: "Someone 's feet adhere to the ground.",
    to: 'Someone adheres to the ground.',
    attribution: 'cast',
    evidence:
      'Root 1/1 cast (+2 s). Owner log: 493 lines of `<T> adheres to the ground.` with NO DB owner at all, 0 of the wiki form. The cast-on-YOU half (`Your feet adhere to the ground.`, 798 lines) is correct and untouched.'
  },
  {
    spells: ['Immobilize'],
    field: 'msgCastOnOther',
    from: "Someone's feet adhere to the ground.",
    to: 'Someone adheres to the ground.',
    attribution: 'cast',
    evidence:
      'Immobilize 14/14 casts (0-8 s). Same 493 lines as the entry above; Immobilize spells the possessive without the wiki space, hence the separate `from`.'
  },
  // --- the subject placeholder the scrape lost: no `Someone`, so NO suffix and no event ----------
  //
  // `castOnOtherSuffix()` keys the table by what follows the wiki's "Someone " subject. A message
  // written with any OTHER subject ("Target", "Player", "Soandso") or with none at all yields NO
  // suffix, so the spell is absent from the matcher entirely — JOS-103 measured 68 spells in that
  // state. These are the ones the owner's log can prove, and note what the fix IS: the sentence is
  // the wiki's own, unchanged; only the subject token is restored.
  {
    spells: ["Garrison's Mighty Mana Shock"],
    field: 'msgCastOnOther',
    from: "Target's skin blisters as it is consumed by pure mana.",
    to: "Someone's skin blisters as it is consumed by pure mana.",
    attribution: 'cast',
    evidence: '347/352 casts (0-2 s); owner log 341 lines of the shape, which had no DB owner.'
  },
  {
    spells: ['Cease', 'Desist', 'Sacred Word'],
    field: 'msgCastOnOther',
    from: 'is struck by a sudden force.',
    to: 'Someone is struck by a sudden force.',
    attribution: 'cast',
    evidence:
      'Cease 122/142 casts, Desist 103/120. The suffix already exists (Force, Markar`s Clash/Discord, Monkey Stun, Stun Command, Tishan`s) and matches 597 lines; these three were simply missing from it.'
  },
  {
    spells: ['Cancelling of Life', 'Cessation of Life', 'Negation of Life'],
    field: 'msgCastOnOther',
    from: 'is shrouded by anti-life magic.',
    to: 'Someone is shrouded by anti-life magic.',
    attribution: 'cast',
    evidence: 'Negation of Life 68/83 casts; owner log 239 lines of the shape, which had no DB owner.'
  },
  {
    spells: ['Force Snap'],
    field: 'msgCastOnOther',
    from: 'Target has been force struck.',
    to: 'Someone has been force struck.',
    attribution: 'cast',
    evidence: '6/8 casts (1-2 s); owner log 8 lines of `<T> has been force struck.`, which had no DB owner.'
  },
  {
    spells: ['Thunder of Karana'],
    field: 'msgCastOnOther',
    from: "'s ears fill with the deafening roar of Karana's Thunder.",
    to: "Someone's ears fill with the deafening roar of Karana's Thunder.",
    attribution: 'cast',
    evidence: '3/7 casts (+3 s each); owner log 3 lines of the shape, which had no DB owner.'
  },
  {
    spells: ['Intellectual Advancement'],
    field: 'msgCastOnOther',
    from: "Someone' mind sharpens.",
    to: "Someone's mind sharpens.",
    attribution: 'cast',
    evidence:
      '1/3 casts (+4 s); owner log 31 lines of `<T>`s mind sharpens.`, 0 of the apostrophe-only form. The scrape dropped the possessive s.'
  },
  {
    spells: ['Ethereal Cleansing'],
    field: 'msgCastOnOther',
    from: "'s body is covered in ethereal light.",
    to: "Someone's body is covered in ethereal light.",
    attribution: 'sole',
    evidence:
      'Owner log: 2 lines of `<T>`s body is covered in ethereal light.` with no DB owner. Subject restoration only; the sentence is the wiki`s own and no other spell claims it.'
  },
  {
    spells: ['Instrument of Nife'],
    field: 'msgCastOnOther',
    from: "'s weapon becomes an instrument of Rodcet Nife.",
    to: "Someone's weapon becomes an instrument of Rodcet Nife.",
    attribution: 'sole',
    evidence: 'Owner log: 8 lines of the shape, no DB owner. Subject restoration only.'
  },
  {
    spells: ['Valor of Marr'],
    field: 'msgCastOnOther',
    from: 'feels the blessing of Mithaniel Marr.',
    to: 'Someone feels the blessing of Mithaniel Marr.',
    attribution: 'sole',
    evidence: 'Owner log: 5 lines of the shape, no DB owner. Subject restoration only.'
  },
  {
    spells: ['Divine Vigor'],
    field: 'msgCastOnOther',
    from: 'begins to radiate with divine favor.',
    to: 'Someone begins to radiate with divine favor.',
    attribution: 'sole',
    evidence: 'Owner log: 39 lines of the shape, no DB owner. Subject restoration only.'
  },
  {
    spells: [
      'Cazic Temple Gate', 'Greater Faydark Gate', 'Nektulos Gate', 'North Karana Gate',
      'North Ro Gate', 'Ring of Misty Thicket', 'Ring of South Ro', 'Ring of Stonebrunt',
      'Ring of West Commons', 'Stonebrunt Gate', 'Toxxulia Gate', 'West Commons Gate',
      'West Karana Gate', 'Zephyr: Butcherblock', 'Zephyr: Feerrott', 'Zephyr: Lavastorm',
      'Zephyr: Misty Thicket', 'Zephyr: North Karana', 'Zephyr: South Ro', 'Zephyr: Steamfont',
      'Zephyr: Stonebrunt', 'Zephyr: Surefall Glade', 'Zephyr: Toxxulia', 'Zephyr: West Commons'
    ],
    field: 'msgCastOnOther',
    from: 'Player fades away.',
    to: 'Someone fades away.',
    attribution: 'db',
    evidence:
      'Twenty-odd sibling gates (Abscond, Gate, Common Gate, Fay Gate, Frost Port, …) already say `Someone fades away.` verbatim, so the suffix already exists and matches 155 owner-log lines; these 24 use the wiki`s other placeholder and were absent from it. Purely additive: no new suffix is created.'
  },
  // --- scrape artifacts: HTML, wiki navigation and stray editorial marks in the message ----------
  {
    spells: ['Invisibility Versus Undead'],
    field: 'msgWearsOff',
    from: 'Your skin stops tingling. <!--',
    to: 'Your skin stops tingling.',
    attribution: 'cast',
    evidence:
      '26/27 casts fade to the clean sentence. The scrape swallowed the start of an HTML comment; four sibling entries (Invisibility to Undead, Improved Invis vs Undead, Sunskin, …) carry the clean text.'
  },
  {
    spells: ['Instill'],
    field: 'msgWearsOff',
    from: 'Your feet come free. Cleric Spell Vendors Enchanter Spell Vendors Necromancer Spell Vendors Paladin Spell Vendors Shaman Spell Vendors Wizard Spell Vendors',
    to: 'Your feet come free.',
    attribution: 'db',
    evidence:
      'The wiki page`s vendor navigation bled into the field. Ten sibling roots (Root, Fetter, Immobilize, Paralyzing Earth, Bonds of Force, …) carry the clean text, which matches 869 owner-log lines.'
  },
  {
    spells: ['Poison'],
    field: 'msgCastOnYou',
    from: 'You have been poisoned. (?)',
    to: 'You have been poisoned.',
    attribution: 'db',
    evidence:
      'An editorial `(?)` from the wiki page. Eighteen sibling poisons carry the clean text, which matches 447 owner-log lines.'
  },
  {
    spells: ['Poison'],
    field: 'msgWearsOff',
    from: 'The poison has run its course. (?)',
    to: 'The poison has run its course.',
    attribution: 'db',
    evidence: 'Same `(?)`; 48 sibling poisons carry the clean text, which matches 168 owner-log lines.'
  },
  {
    // JOS-251, and the first correction this file has taken for an edit made UPSTREAM rather than a
    // scrape artifact. The re-scrape that captured the effect lists picked up 160 changed pages, and
    // one of them had had its self wear-off sentence replaced with a description of the THIRD-person
    // one: `Your Beguile spell has worn off of <mob>.` is a real line (50 of them in the owner's
    // log) and is not what `msg_wears_off` records — that field is what prints on the charmed
    // TARGET, which for every other member of the family is `You are no longer charmed.`
    //
    // It is here rather than in the scrape for the reason the file's header gives: the wiki dataset
    // stays pristine and idempotent under re-scrape, and if the page is fixed upstream this entry
    // reports `satisfied` and the audit test says so.
    spells: ['Beguile'],
    field: 'msgWearsOff',
    from: 'Your beguile spell has worn off',
    to: 'You are no longer charmed.',
    attribution: 'db',
    evidence:
      'Six siblings sharing Beguile`s own landing sentence (`Someone has been charmed.` — Charm, Cajoling Whispers, Boltran`s Agacerie, Dictate, Alluring Whispers, Vampire Charm) all carry `You are no longer charmed.` verbatim. The owner`s log cannot witness either text (he is the charmER: 50 `Your Beguile spell has worn off of <mob>.` lines, 0 self charm fades), which is exactly the unobservable-detrimental state the header describes — so the DB is the only witness and it is unanimous.'
  },
  {
    spells: ["Ikatiar's Revenge"],
    field: 'msgCastOnOther',
    from: 'Someone has been poison.',
    to: 'Someone has been poisoned.',
    attribution: 'db',
    evidence:
      'The scrape truncated the participle. Forty-seven sibling poisons carry the full suffix, which matches 952 owner-log lines.'
  },
  {
    spells: ['Frost Shards'],
    field: 'msgCastOnYou',
    from: 'You feel your skin freeze',
    to: 'You feel your skin freeze.',
    attribution: 'db',
    evidence:
      'Terminal period lost by the scrape. Four siblings (Ice Comet, Silver Breath, …) carry the full stop, which matches 376 owner-log lines.'
  },
  {
    spells: ['Shock of Frost'],
    field: 'msgCastOnYou',
    from: 'Your feel your skin freeze.',
    to: 'You feel your skin freeze.',
    attribution: 'db',
    evidence: 'A `Your`/`You` typo on the wiki page; the same four siblings carry the correct sentence.'
  },
  // --- inflection and spelling drift between the wiki text and the shipped string ----------------
  {
    spells: ['Lifedraw', 'SpectreLifetap'],
    field: 'msgCastOnYou',
    from: 'You feel your lifeforce drain away.',
    to: 'You feel your life force drain away.',
    attribution: 'db',
    evidence:
      'Seventeen sibling lifetaps (Lifetap, Lifespike, Siphon Life, Drain Soul, …) spell it as two words, which matches 1,639 owner-log lines; the one-word form occurs 0 times.'
  },
  {
    spells: ['Rune II', 'Rune III', 'Rune IV', 'Rune V'],
    field: 'msgWearsOff',
    from: 'The shimmer of runes fade.',
    to: 'The shimmer of runes fades.',
    attribution: 'db',
    evidence: 'Rune I carries the inflected verb, which matches 19 owner-log lines; the bare form occurs 0 times.'
  },
  {
    spells: ['Rune IV', 'Rune V'],
    field: 'msgCastOnYou',
    from: 'A coat of shimmering runes surround you.',
    to: 'A coat of shimmering runes surrounds you.',
    attribution: 'sole',
    evidence:
      'Owner log: 19 lines of the inflected sentence with no DB owner at all, 0 of the wiki form; it pairs one-for-one with the 19 fades above.'
  },
  {
    spells: ['Guardian Rhythms'],
    field: 'msgCastOnYou',
    from: 'You feel an aura of mystic protection surround you.',
    to: 'You feel an aura of mystic protection surrounding you.',
    attribution: 'sole',
    evidence: 'Owner log: 264 lines of the participle form with no DB owner, 0 of the wiki form.'
  },
  {
    spells: ['Reckoning'],
    field: 'msgCastOnYou',
    from: 'You have been struck down by the judgement of the gods.',
    to: 'You have been struck down by the judgment of the gods.',
    attribution: 'sole',
    evidence:
      'British spelling on the wiki, American in the game: 14 owner-log lines of `judgment`, 0 of `judgement`, and Reckoning is the only spell with the sentence.'
  },
  {
    spells: ['Torbas Poison Blast'],
    field: 'msgCastOnYou',
    from: 'A blast of poison eats at your skin.',
    to: 'A blast of Poison eats at your skin.',
    attribution: 'sole',
    evidence:
      'The game capitalizes the damage type: 3 owner-log lines of `A blast of Poison`, 0 of the lowercase form, no DB owner. Matching is case-sensitive, so the case IS the defect.'
  },
  {
    spells: ['Scarab Storm'],
    field: 'msgCastOnOther',
    from: 'Someone shrieks as scarabs burrow into their skin.',
    to: 'Someone shrieks as a scarab burrows into their skin.',
    attribution: 'sole',
    evidence: 'Owner log: 5 lines of the singular form with no DB owner, 0 of the wiki plural.'
  },
  {
    spells: ['Scarab Storm'],
    field: 'msgWearsOff',
    from: 'The scarabs die.',
    to: 'The scarab dies.',
    attribution: 'sole',
    evidence: 'Owner log: 2 lines of the singular form with no DB owner, 0 of the wiki plural; the same drift as its landing.'
  },
  // --- the stun family: the wiki writes the sentence the game does not print ---------------------
  {
    spells: ['Divine Wrath', 'Sound of Force', 'Stun'],
    field: 'msgCastOnYou',
    from: 'You are stunned.',
    to: 'You are stunned!',
    attribution: 'sole',
    evidence:
      'Owner log: 1,208 lines of `You are stunned!` with no DB owner, 0 of the period form, against 1,214 of the wear-off `You are no longer stunned.` these same spells already match. The pair is the evidence: the fade half was matching and the landing half was not.'
  },
  {
    spells: ['Stun'],
    field: 'msgCastOnOther',
    from: 'Someone is stunned.',
    to: 'Someone is struck by a sudden force.',
    attribution: 'cast',
    evidence:
      '15/20 casts (0-2 s), and NONE of the 20 had another stun-family cast of ours in the prior 20 s, so it is not the neighbouring Cease/Desist. `<T> is stunned.` occurs 0 times whole-log. Left alone for Holy Might and Sound of Force, which share the wiki text and which the log cannot separate.'
  },
  // --- the symbol line: the wiki writes one generic sentence, the game names the symbol ----------
  //
  // `messageOverlay.baseline.json` already LEARNED the Pinzarn form from the log (spellDb.ts
  // `applyOverlayCorrections`); that path is per-user, mined and revocable. These two are the same
  // fact stated once, for everybody, at the source. The other three spells sharing the wiki
  // sentence (Naltron`s Mark, Symbol of Marzin, Symbol of Naltron) are NOT corrected: the log has
  // never printed their landings, and inventing `The symbol of Marzin …` is exactly the guess this
  // file refuses.
  {
    spells: ['Symbol of Transal'],
    field: 'msgCastOnYou',
    from: 'A mystic symbol flashes before your eyes.',
    to: 'The symbol of Transal flashes before your eyes.',
    attribution: 'cast',
    evidence: '12/16 casts (3-10 s); owner log 22 lines of the sentence, 0 of the wiki form.'
  },
  {
    spells: ['Symbol of Pinzarn'],
    field: 'msgCastOnYou',
    from: 'A mystic symbol flashes before your eyes.',
    to: 'The symbol of Pinzarn flashes before your eyes.',
    attribution: 'cast',
    evidence: '1/3 casts; owner log 50 lines of the sentence, 0 of the wiki form.'
  },
  // --- the absent field: the wiki states nothing, so the sentence had one owner too few ---------
  //
  // THE GAP THE OWNER LIVED IN (JOS-159). `<mob> has been charmed.` is the enchanter charm
  // ladder's landing line, and the DB gave it seven owners with Allure not among them — so
  // JOS-140's charm countdown, which opens a hold only for the candidate whose own cast is
  // anchored, had NOTHING to narrow to for the one charm this enchanter actually casts. Not a
  // wrong word this time: the entry carries a cast time and a 16-minute duration and all three
  // message fields are simply empty.
  //
  // THE LOG CASTS IT BY RANK and the DB knows only the base line, which is fine and is exactly
  // what `spellCanonKey` folding is for: `You begin casting Allure VI.` and the candidate `Allure`
  // meet at the key `allure`, so the anchor matches and the row still prints the ranked name the
  // cast line carried. The BREAK half already worked — `Your Allure spell has worn off of <mob>.`
  // names the spell and `CHARM_STEMS` has always matched it (161 such lines in the owner's log).
  // The landing half was the only one missing, and it was missing because the field is EMPTY.
  //
  // ONLY `msgCastOnOther` IS SUPPLIED, and the other two stay empty on purpose. A charm is
  // detrimental and lands on a MOB, so `You have been charmed.` and `You are no longer charmed.`
  // print to the mob: both occur 0 times. That is the unobservable-detrimental case the header
  // names, and a DB sibling is not a licence to copy text this log can never witness into fields
  // nothing reads.
  //
  // THE COUNTS BELOW ARE THE SAME LOG, ONE SESSION LONGER: 1,473,035 lines against the header's
  // 1,460,978, because the owner kept playing on 2026-08-09 while this was being measured. Same
  // file, same whole-log method.
  {
    spells: ['Allure'],
    field: 'msgCastOnOther',
    from: null,
    to: 'Someone has been charmed.',
    attribution: 'cast',
    evidence:
      'Allure VI 108/111 casts, Allure IV 59/65, Allure III 48/51 (215/227, 1-12 s, p50 4 s). 201 of the log`s 423 `<T> has been charmed.` lines have an Allure rank as their nearest preceding own cast, against 95 Charm, 59 Cajoling Whispers and 53 Beguile; 161 `Your Allure spell has worn off of <T>.` lines close the same lifecycle. The five ladder siblings (Charm 11, Beguile 23, Cajoling Whispers 37, Boltran`s Agacerie 53, Dictate 60) already carry this exact sentence, and Allure is the ONLY enchanter detrimental in the DB with no cast-on-other message at all.'
  },
  // --- the bard mez ladder: one subject token and one dropped word (JOS-161) --------------------
  //
  // THE REPORT: a bard on 0.14.0 could not get an alert to fire for `Sionachie's Dreams` or
  // `Solon's Bewitching Bravura` with any trigger type. Both songs were in `ccSpell` at the time
  // (JOS-84), so the "Mez / root broke" GROUP had fired for them all along — what could not fire
  // was anything naming the spell, and each song had its own reason. JOS-200 later moved Bravura to
  // `charmSpell` (it is the bard's level-39 CHARM, not a mez — see rulesets.ts for the log
  // evidence), which changes which alert its break fires and changes NOTHING about the two
  // corrections below: a name is a join key whatever roster the spell sits in, and the landing
  // sentence it shares with the mez ladder is exactly why the message oracle got it wrong.
  //
  // THE COUNTS BELOW are whole-log over the owner's `eqlog_Primitive_freeport.txt` (1,494,065
  // lines, measured 2026-08-09) unless a reporter slice is named. `<mob>'s eyes glaze over.` is a
  // BARD's line and the owner is not one, so the witness is a bard standing beside him: Enzee, in
  // Lower Guk on Thu Jul 30, whose `<Name> begins singing <Song>.` lines the parser already reads
  // as `otherCastBegin`. That is the same third-person anchor JOS-140 admits for a landing.
  {
    spells: ["Sionachie's Dreams"],
    field: 'msgCastOnOther',
    from: "Target's eyes glaze over.",
    to: "Someone 's eyes glaze over.",
    attribution: 'db',
    evidence:
      'The subject-placeholder drift, on the one song of the ladder that has it: `castOnOtherSuffix` keys the table by what follows the wiki`s `Someone ` subject, so `Target`s ...` is in no table at all and `Sionachie`s Dreams` could not be a candidate for its own landing (JOS-103 measured 68 spells in that state; this is one). The three ladder siblings — Solon`s Song of the Sirens 27, Crission`s Pixie Strike 28, Solon`s Bewitching Bravura 39 — already carry the replacement VERBATIM, spaced possessive included, so the sentence is not being invented. Owner log: 14 lines of `<T>`s eyes glaze over.`, 0 of the wiki form; `Enzee begins singing Sionachie`s Dreams.` (Thu Jul 30 18:32:40) is followed 3 s later by `a revenant`s eyes glaze over.`, and four `Enzee begins singing Solon`s Bewitching Bravura III.` lines are each followed 2-3 s later by one more.'
  },
  {
    spells: ["Solon's Bravura"],
    field: 'name',
    from: "Solon's Bravura",
    to: "Solon's Bewitching Bravura",
    attribution: 'sole',
    evidence:
      'The wiki page`s `spellname` is `Solon`s Bravura`; the game has never printed it. Owner log: 20 lines naming `Solon`s Bewitching Bravura` (5 own-guild casts by the bard Enzee, 14 sung AT the player by fire giants, 1 resist) and 0 naming `Solon`s Bravura`. Reporter slice 01KZAG2QAW885YJNRTDDND8BF2 adds `You begin singing Solon`s Bewitching Bravura IX.` x5 and `Your Solon`s Bewitching Bravura spell has worn off of a fire giant warrior.` x5; slice 01KZM7F36JD12WYF15DHCCWNEE ends on `You have finished memorizing Solon`s Bewitching Bravura.`. A dropped word, never a different spell: nothing else in the DB is named Bravura (src/main/log/rulesets.ts says so too), the level, class, cast time, duration and all three messages are untouched, and the entry`s own `You are captivated by the bewitching tune.` carries the missing word already. Both level-39 rows (18 s and the April-2000 1 Min) are renamed together.'
  },
  // Found by the JOS-387 audit of what the resist fold recognises as a RESIST DEBUFF. The tash
  // ladder, the malo ladder and the whole Scent line are recognised correctly off the catalog`s
  // verbatim `Decrease <Axis> Resist` effect lines; this one name is the only member of any of them
  // that the log and the wiki spell differently, so it was the only one whose windows never opened.
  {
    spells: ['Malisement'],
    field: 'name',
    to: 'Malaisement',
    from: 'Malisement',
    attribution: 'sole',
    evidence:
      'The shaman malo ladder`s level-32 rung. Owner log, whole file (2,026,223 lines): 229 lines naming `Malaisement` (123 `<mob> begins casting Malaisement.`, 5 `You begin casting Malaisement.`, the rest interrupts and fades) and 0 naming `Malisement`. One inserted vowel, never a different spell: nothing else in the DB is named Mal*sement, and the entry`s four `Decrease Cold/Magic/Poison/Fire Resist by 36-40` effect lines are exactly the rung between Malaise (15-20) and Malosi (59-60), which the log casts 136 and 63 times under names the catalog already matches. Until this correction `isResistDebuff` (main/resist/world.ts) answered false for all 229 lines, so the debuff was never recorded against a mob and every observation made under it was fitted at an offset 36 to 40 points too small.'
  },
  // --- the seventh drift class: the wrong LEVEL (JOS-415) ----------------------------------------
  // The header's paragraph carries the bar; this is its one entry. The wiki has two pages for this
  // spell — pageid 46874, titled `Leech`, `{{Classic Era}}`, `* [[Necromancer]] - Level 9`, and
  // pageid 50162, titled `Leach`, `{{Paineel Era}}`, `* [[Necromancer]] - Level 12 Recourse
  // Effect` — and BOTH set `spellname = Leach`, so the scrape files two rows under one name. Every
  // other field the two share is identical (mana 72, cast 2.40, recast 10.00, the same
  // `Decrease Hitpoints by 8 per tick` slot, the same four vendors in the same four zones), which
  // is what makes them one spell rather than two. The level-12 row is the one that is wrong.
  {
    spells: ['Leach'],
    field: 'classes',
    from: '* Necromancer - Level 12 Recourse Effect',
    to: '* Necromancer - Level 9',
    attribution: 'db',
    evidence:
      'Reported 6AT44D (v1.5.0): `For a necro, on level up to level 12. Shows Leach beting a spell. But leach was learned at lvl 9 for a necro.` Checked against EQ LEGENDS data, not classic EQ: eqlwiki`s own Necromancer spell list places the spell ONCE, at Level 9, as `Leach NEC(9)` linking the page titled `Leech`; its Level 12 rows are Bind Affinity, Convoke Shadow and Lifedraw, and no row anywhere in that list links the page titled `Leach`. The DB is its own witness twice over: our other row for this name already says `* Necromancer - Level 9` (so this correction reports satisfied on it), and the level-12 page`s own description reads `6 ticks @L9 to 9 ticks @L15` while its duration row says `7 ticks @L12` — the page contradicts itself about the floor. `Level 12 Recourse Effect` is a note the wiki hung on the classes bullet; shared/spellLevels.ts`s SEGMENT regex reads the number and ignores the trailing words, which is correct behaviour on a line that is wrong. Blast radius: buildLevelUnlocks emitted a second Leach row at NEC 12 and the panel drew a card there; with both rows at NEC 9 the renderer`s fold-by-name draws one card at 9 and none at 12. spellClasses is unchanged (both rows already said Necromancer).'
  }
]

/**
 * THE COMMITTED OVERLAY: the hand-derived entries above, then the subject-placeholder sweep, then
 * the shaman heal-over-time ladder, then the polarity ruling.
 *
 * ORDER IS NOT SIGNIFICANT HERE and the suite proves it: `applySpellCorrections` matches each
 * entry against the CURRENT text of the spell it names, and `tests/spellCorrections.test.mts`
 * refuses two entries that claim the same spell and field — so no entry can ever be reading what
 * another one wrote. The sweep goes last because it is the newer, bulkier half and a diff of it
 * should not push the hand-derived families around. The polarity block is trivially independent of
 * all three: it is the only one that writes a field other than a message or a name.
 */
export const SPELL_CORRECTIONS: readonly SpellCorrection[] = [
  ...HAND_DERIVED_CORRECTIONS,
  ...SUBJECT_PLACEHOLDER_CORRECTIONS,
  ...HEALING_LADDER_CORRECTIONS,
  ...POLARITY_CORRECTIONS
]