// THE POLARITY OVERLAY — A LULL IS A DEBUFF (JOS-413, owner ruling 2026-08-19).
//
// This is the SIXTH drift class of the corrections overlay and the only one that is not about a
// SENTENCE. READ `spellCorrectionsList.ts` FIRST: the evidence bar, the idempotence rules and the
// other five classes are stated there, and this file is held to the same mechanism —
// `spellCorrections.ts` applies it in the same pass, in the same shape, before `buildSpellDb` reads
// anything. The other five all assume the wiki is describing the right spell and getting its words
// wrong. This one says the wiki filed the spell on the wrong SIDE.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE REPORT AND THE RULING.
//
// Report 6BM6Y5 (v1.5.0), verbatim: "Pacify and Reoccurring Amnesia are listed as positive buffs in
// the Buffs section, rather than debuffs. Probably because the wiki lists them as 'beneficial' ...
// you already have Pacify showing up on the debuffs overlay, as expected, so that's inconsistent.
// Reoccurring Amnesia, unfortunately, does not show up on debuffs overlay."
//
// THE REPORTER DIAGNOSED IT CORRECTLY AND ALSO NAMED THE OLD FIX. `spell_type = Beneficial` is what
// the eqlwiki says for the whole lull line, `spellNature` folds that to 'beneficial',
// `SpellStats.classOf` folds THAT to `cls: 'buff'`, and the Buffs section lists the row under
// Buffs. JOS-213 had already answered the OVERLAY half of the same complaint — `calmsTarget` routes
// a calm-line row to the debuffs WINDOW while leaving `kind: 'buff'` alone — and that split is
// exactly the inconsistency this report is pointing at: one surface calls it a debuff and the other
// calls it a buff, about the same bar.
//
// THE OWNER'S RULING (2026-08-19) settles it at the source rather than at a second surface: THEY
// ARE DEBUFFS. So the polarity moves, and `calmsTarget` becomes a true statement that no longer has
// to carry the routing on its own — `timerRowSurface` sends these rows to the debuffs window on
// `kind` now, the way every other mob timer gets there. JOS-213's fact and its audit STAY: the
// roster is derived from the landing sentences, it is the guard that keeps a friendly buff off the
// debuffs window, and it would still be the answer for a spell this file has no ruling about.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE OVERLAY AND NOT A HAND-EDIT — the same argument the whole corrections layer rests on.
//
// `spells.json` is a SCRAPE and `scripts/scrape-spells.ts` rewrites it wholesale. Editing
// `spell_type` there would be reverted by the next re-scrape, silently, and the re-scrape's diff
// would stop being readable because our ruling and the wiki's changes would be mixed into the same
// lines. Stated as an entry, the ruling is IDEMPOTENT in both directions: `from: 'Beneficial'` is
// what the wiki says today, so a re-scrape that leaves it applies again; a wiki that adopts
// `Detrimental` upstream reports `satisfied`; and a wiki that changes to some THIRD word reports
// `stale` and `tests/spellCorrections.test.mts` fails, which is the point.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ROSTER IS DERIVED AND THE TABLE IS ITS CENSUS — which is the half that makes this durable.
//
// A hand list of names is what a re-scrape defeats: a new rank of the lull line, or a page that
// grows an effect list, joins the family and nobody notices. So the membership is computed from the
// EFFECT LINES on every run (`spellEffectClass.ts suppressesAggro` — the same oracle `charmRoster`,
// `holdRoster` and the slow group are built from), and `tests/spellPolarity.test.mts` pins the
// answer as a CENSUS: the derived roster must be EXACTLY the names below. A scrape that widens the
// family fails the suite with the new spell's name in the message, rather than shipping a lull that
// is still a buff.
//
// MEASURED over the committed registry, 18 rows, and the table below is that list verbatim:
//
//   pacify   Calm, Calm Animal, Harmony, Harmony of Nature, Kelin's Lugubrious Lament, Lull,
//            Lull Animal, Numb the Dead, Pacify, Rest the Dead, Soothe, Wake of Tranquility
//   memblur  Atone, Blanket of Forgetfulness, Memory Blur, Memory Flux, Mind Wipe,
//            Reoccurring Amnesia   (Rest the Dead carries BOTH and is counted once)
//
// EVERY ONE OF THEM IS `Beneficial` IN THE SCRAPE, every one is player-castable, and every one
// lands on somebody other than the caster. None is in `CC_STEMS` or `CHARM_STEMS`, which matters
// downstream and is stated again under THE TEMPLATE FLAGS below.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS DELIBERATELY NOT IN IT, both refusals measured rather than argued.
//
//   THE FACTION LADDER — `Alliance` (Ench 8), `Benevolence` (20), `Collaboration` (50). They print
//   `Someone looks friendly.` and JOS-213's landing-sentence roster therefore claims them, which is
//   why a reader will look for them here. Their effect list is `Increase Faction by 100/200/300`
//   and nothing else: that is a lasting BENEFIT to the mob, not a suppression of it, they state no
//   duration so they can never open an instance in either window, and `suppressesAggro` refuses
//   them because the effect lines do. The two rosters disagreeing here is correct — one asks what
//   sentence the spell prints and the other asks what the spell DOES.
//
//   THE MEZ FAMILY. `Mesmerize` and its siblings all state `Memblur(1%)` beside their mez line, so
//   a `some`-shaped predicate would have swept eleven spells that are ALREADY `Detrimental` and
//   already right. The `every` in `suppressesAggro` is what keeps them out, and it is the reason
//   that predicate is written the strict way.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT MOVES DOWNSTREAM, MEASURED — because a polarity is read in more places than a sentence is.
//
//   THE BUFFS MODEL. `spellNature` -> 'detrimental' -> `SpellStats.classOf` -> `cls: 'debuff'` ->
//   `BuffTimerRow.kind: 'debuff'` -> `timerRowSurface` -> the DEBUFFS window. That is the report,
//   answered on both surfaces at once: the Buffs section lists them under Debuffs and the debuff
//   overlay carries the bar. `Reoccurring Amnesia` is the one that was on NEITHER — it states 24 s
//   and its landing sentence keys the suffix table, so the bar existed; it was on the buffs side,
//   because `calmsTarget` reads the calm-line SENTENCES and `Someone blinks a few times.` is not
//   one of them. Polarity reaches it where the routing fact could not.
//
//   THE OFFLINE PAUSE (JOS-134). `BuffInstances.onOfflinePause` shifts a buff across an absence and
//   takes an EXPLICIT no-op on a debuff, because a debuff you left on a mob is a timer in the WORLD
//   and EQ never froze it. A Pacify is a timer on a mob. It has been shifted at every logout since
//   the split shipped, and after this it is not.
//
//   THE TEMPLATE FLAGS, which is where the arithmetic is worth writing down. `suggestionTemplates`
//   gates four flags on the disposition, so all 18 spells trade three beneficial-side chips for the
//   detrimental-side one:
//     GAINED  `lands` — "when it lands on a target", the `buffApply` on the mob. This is the chip a
//             player casting Pacify actually wants and no member of the family could be offered it.
//     LOST    `landsOnYou` (16 rows) and `wearsOff` (1 row, Kelin's Lugubrious Lament). Both are
//             corrections rather than losses, and `spellCorrectionsList.ts` had already written the
//             reason down: a spell you cast at a MOB prints its `msgCastOnYou` and `msgWearsOff` to
//             the MOB, so those sentences are unobservable in your own log forever. That header
//             names "the lull line (Pacify/Soothe/Calm/Lull)" in exactly that state. A chip that
//             cannot fire is worse than an absent one (shared/alertGroups.ts's law).
//     KEPT    `fade` and `landsOnOther`, and `fade` needed a gate change to stay — see below.
//
//   NOTHING ELSE MOVES. Measured by rebuilding the catalog over the flipped registry: not one spell
//   outside the 18 changes a single template flag.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE GATE THIS RULING HAD TO WIDEN, and the measurement that forced it.
//
// `fade` was gated on `beneficial` alone. Flipping the family would therefore have taken the `fade`
// chip off all 18 — and `fade` is the one beneficial-side flag that is NOT about a sentence printed
// to the mob. It fires on `buffFade`, which is the parser's event for `Your <X> spell has worn off
// of <mob>.` — a sentence printed to YOU, the caster, about a spell on somebody else. The template's
// own doc comment in the renderer names this exact family for it: "the 'Soothe has worn off a Fire
// Giant' sentence".
//
// MEASURED in the owner's log (2,147,672 lines, 2026-08-19): 365 `Your <lull-line spell> spell has
// worn off of <mob>.` lines. 200 of them are `Harmony of Nature` alone. The chip fires; the gate was
// standing in for "the parser can emit a buffFade for this spell" and the flip does not change that
// answer, because a `buffFade` becomes a `cc {refresh:true}` only for the HOLD rosters and not one
// of the 18 is in `CC_STEMS` or `CHARM_STEMS`.
//
// AND THE COST OF NOT WIDENING IT WAS NOT JUST A CHIP. `Harmony`, `Harmony of Nature` and `Lull
// Animal` state NO messages at all, so `fade` was the ONLY template any of them had — and a spell
// with no template is DROPPED FROM THE CATALOG ENTIRELY (`buildSpellCatalog`), which is JOS-103's
// reported defect exactly: it cannot be found in the suggestion wizard's search at all. Measured:
// the catalog goes 1,739 -> 1,736 without the widening and 1,739 -> 1,739 with it.
//
// THE WIDENING IS ONE NAME WIDE ON PURPOSE. `fade` is now `beneficial || suppressesAggro(s)`, not
// "every detrimental spell that is not a hold" — which is the honest general form of the gate and
// would offer a fade chip to some 700 DoTs and slows. That is a real question and a good one; it is
// an owner call about the wizard, not a consequence of this ruling, and it gets its own ticket
// rather than riding in on one.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DRUID HALF OF THE REPORT, WHICH IS A DIFFERENT DEFECT AND IS NOT FIXED HERE (JOS-413).
//
// The Reddit corroboration (Update #3 thread, opsers) says the DRUID pacify line does not show up in
// any timer window, and the brief expected the JOS-213 routing to be name-gated so the line could be
// extended. IT IS NOT NAME-GATED — it derives from landing sentences — and extending it would fix
// nothing, because for three members of this family THERE IS NO LANDING SENTENCE TO MATCH.
//
// MEASURED, and the measurement is the opposite of what a reader would assume. The owner scribed and
// cast `Harmony of Nature` 212 times in `eqlog_Primitive_freeport.txt`. Landing sentences printed
// within 12 s of one of those casts: ZERO — not `looks less aggressive.`, not any of the other four
// sentences the family writes. Ambient `<mob> yawns.` emotes were checked as a candidate and are not
// it: 1,156 whole-log, 32 inside a post-cast window, none inside 5 s, no cast-locked spike. And the
// spell is LANDING while it prints nothing: `Your Harmony of Nature spell has worn off of <mob>.`
// occurs 200 times, against 212 casts. The wiki's empty `msg_cast_on_other` for `Harmony`, `Harmony
// of Nature` and `Lull Animal` is TRUE, and a correction restoring a sentence for them would be
// inventing one the owner's own 212 casts affirmatively contradict — the awaiting-sample law's exact
// prohibition, refused here the way `spellCorrectionsSubjects.ts` refuses ` looks powerful.`
//
// So `applyMessageBuff` is never offered a landing, no instance opens, and the wear-off arrives with
// nothing to close. The DRUID RUNG THAT DOES WORK is `Calm Animal` (Druid 15 / Ranger 31), which
// states `Someone looks less aggressive.` and has always been routed. Opening a bar for a spell
// whose only evidence is its own END is a new mechanism with its own burden of proof — a cast plus
// the absence of a resist line, LABELLED inferred under world-model law 1 — and it is a separate
// ticket. `POLARITY_NO_LANDING` below is that finding as DATA rather than prose, so the suite fails
// if a re-scrape ever supplies one of the three sentences and the refusal stops being true.

import type { SpellCorrection } from './spellCorrections'

/**
 * One polarity ruling. The shape carries only what varies — the field and both texts are implied,
 * since a row here cannot express anything except "the wiki filed this spell as beneficial and it
 * is a debuff".
 */
export interface PolarityRuling {
  /** Exact `SpellEntry.name`s, as the SCRAPE spells them. */
  readonly spells: readonly string[]
  /** Which effect line puts them in the family, for a reader scanning the table. */
  readonly family: 'pacify' | 'memblur' | 'both'
  /** What the spell does to the mob, in one line. */
  readonly evidence: string
}

/** The wiki's word for these rows today, and ours. Stated once so no entry can typo either. */
export const WIKI_POLARITY = 'Beneficial'
export const RULED_POLARITY = 'Detrimental'

/**
 * THE RULING, one row per family rung. Ordered by family and then by the ladder, not alphabetically,
 * because the reason a spell is here is shared with its siblings and a reader checking one is
 * checking all of them.
 */
export const POLARITY_RULINGS: readonly PolarityRuling[] = [
  // --- the lull line: `Reaction Radius` / `Pacify`, the aggro clock a puller watches -------------
  {
    spells: ['Lull', 'Soothe', 'Calm', 'Pacify', 'Wake of Tranquility'],
    family: 'pacify',
    evidence:
      'THE REPORTED SPELL and its own ladder (Cleric 1/5/15/36/55, Enchanter 1/6/18/35/51, Paladin 10/25/43/49). Effect list `Frenzy Radius` / `Reaction Radius` / `Pacify`: it suppresses a mob`s aggro for a stated duration and does nothing else. Owner log: 215 casts of the four rungs he has scribed (Pacify 90, Soothe 61, Calm 53, Lull 11), 204 of them followed inside 12 s by `<mob> looks less aggressive.` — 210 lines whole-log.'
  },
  {
    spells: ['Lull Animal', 'Calm Animal', 'Harmony', 'Harmony of Nature'],
    family: 'pacify',
    evidence:
      'The DRUID/RANGER rungs of the same ladder (Druid 1/15/5/29, Ranger 4/31/22/39) — the line the Reddit report names. Same effect list, same mechanic. Three of the four print no landing sentence at all and so can open no bar; see THE DRUID HALF in this file`s header for the 212-cast measurement and why that is a separate defect from the polarity.'
  },
  {
    spells: ['Numb the Dead', 'Rest the Dead'],
    family: 'both',
    evidence:
      'The NECRO/SK undead rungs (Necromancer 2/23, Shadow Knight 9/52), printing `<mob> looks ambivalent.` — ZERO lines in the owner log, who is neither class, so the claim rests on the effect list alone as the `db` route allows. `Rest the Dead` states `Pacify` AND `Memblur`, which is the DB`s own witness that the two effect classes are one family.'
  },
  {
    spells: ["Kelin's Lugubrious Lament"],
    family: 'pacify',
    evidence:
      'The BARD rung (Bard 8), printing `<mob> looks sad.` — 13 lines in the owner log, none of them his (he has never sung it). Same `Reduce Aggro Radius` / `Reaction Radius` / `Pacify` effect list as the spell ladder; a song rather than a spell changes nothing about what it does to the mob.'
  },
  // --- the memory-wipe line: `Memblur`, the aggro RESET ------------------------------------------
  {
    spells: ['Reoccurring Amnesia'],
    family: 'memblur',
    evidence:
      'THE SECOND REPORTED SPELL (Enchanter 45). Effect list `Memblur(25%)` and nothing else: it wipes a mob`s memory of who hit it. The only rung of either family that states a duration AND a keyable landing sentence and was still on the buffs side — `Someone blinks a few times.` is not a calm-line sentence, so JOS-213`s routing could never reach it.'
  },
  {
    spells: ['Memory Blur', 'Mind Wipe', 'Blanket of Forgetfulness', 'Memory Flux'],
    family: 'memblur',
    evidence:
      'The rest of the enchanter memory-wipe ladder (10/36/46/55), sharing `Someone blinks a few times.` with the reported spell — 6 lines whole-log in the owner log, four of them following one of his own four Memory Blur casts inside 12 s. All four rungs state `Instant`, so none can open a bar in either window; what moves for them is the Buffs section, the spell search and the alert chips.'
  },
  {
    spells: ['Atone'],
    family: 'memblur',
    evidence:
      'The CLERIC rung (Cleric 32), effect list `Memblur(30%)`, printing `<mob> calms down.` — a calm-line sentence in JOS-213`s roster although the effect is a memory wipe, which is the row that proves the two rosters ask different questions. ZERO lines in the owner log. Instant, so no bar either.'
  }
]

/**
 * The ruling as the overlay consumes it — appended to `SPELL_CORRECTIONS` and applied by the same
 * pass. `attribution: 'db'` is the evidence bar's third route read for a polarity rather than a
 * sentence, and it is the honest one: the claim rests on the DB'S OWN effect list, which states
 * what the spell does to the mob, against the DB's own type column, which says how to feel about it.
 * The wiki is its own witness and the type column is the odd one out.
 */
export const POLARITY_CORRECTIONS: readonly SpellCorrection[] = POLARITY_RULINGS.map((r) => ({
  spells: r.spells,
  field: 'spellType' as const,
  from: WIKI_POLARITY,
  to: RULED_POLARITY,
  attribution: 'db' as const,
  evidence: r.evidence
}))

/**
 * THE THREE RUNGS THE GAME PRINTS NO LANDING FOR, as data rather than prose (JOS-413).
 *
 * These are NOT corrections and must never become them — the header states the measurement that
 * refuses them. They are recorded so the suite can hold the refusal: `tests/spellPolarity.test.mts`
 * asserts each still carries NO `msgCastOnOther`, so a re-scrape that supplies one turns this
 * finding from a standing limitation into a failing test somebody has to read.
 */
export const POLARITY_NO_LANDING: readonly { spell: string; measured: string }[] = [
  {
    spell: 'Harmony of Nature',
    measured:
      'Owner log 2026-08-19, 2,147,672 lines: 212 `You begin casting Harmony of Nature.`, 0 family landing sentences within 12 s of any of them, and 200 `Your Harmony of Nature spell has worn off of <mob>.` The spell lands and prints nothing when it does.'
  },
  {
    spell: 'Harmony',
    measured:
      'The same spell one rung down (Druid 5 / Ranger 22), same empty wiki fields, and 0 casts in the owner log — so the refusal rests on its sibling`s 212 rather than on its own silence.'
  },
  {
    spell: 'Lull Animal',
    measured:
      'The bottom rung (Druid 1 / Ranger 4), same empty wiki fields, 0 casts in the owner log. Its own upgrade `Calm Animal` DOES state `Someone looks less aggressive.`, which is what makes restoring a sentence here tempting and is not evidence about THIS row.'
  }
]
