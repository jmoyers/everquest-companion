import { DEFAULT_PROFILE } from '../../shared/profiles'
import type { SpellDb } from '../data/spellDb'
// THE DERIVED ROSTER (JOS-251). `charmRoster` reads the wiki EFFECT LINES the scrape now captures
// and answers "does this spell charm?" from data instead of from the stem alternation below. The
// import is one-way at runtime: spellEffectClass.ts reaches back here for nothing, and its own
// import of parseCommon.ts is `spellCanonKey`, which imports this file for a TYPE only.
import { charmRoster } from '../data/spellEffectClass'
import { spellCanonKey } from './parseCommon'

/**
 * WHAT A ROSTER HAS TO BE ABLE TO DO: answer, for one spell name off a log line, whether it is a
 * member. A `RegExp` satisfies this structurally, which is what lets the derived sets below slide
 * in under every existing `cfg.charmSpell.test(name)` call site without one of them changing.
 */
export interface SpellRoster {
  test(name: string): boolean
}

/**
 * Per-profile parser configuration. Different EQ servers/emulators can differ in
 * log wording, so the single parse pass (see parser.ts) is parameterized by a
 * config looked up per profile. Today the only genuine per-profile knob is the
 * charm-spell stem set (which "worn off" lines count as un-charm vs MEZ); the bulk
 * of the grammar is shared "classic" EQ. Add fields here as real divergences show
 * up rather than forking whole regex batteries.
 */
export interface ParserConfig {
  id: string
  /**
   * Optional injected spell database (Task #34). When present, the parser emits PRECISE,
   * message-driven buffApply / buffWearOff events by matching a line against the DB's
   * cast-on-you / cast-on-other / wears-off message tables. Injected at main startup via
   * installSpellDb(); ABSENT by default so parser purity holds — a profile with no DB
   * installed emits none of the new events and behaves exactly as before. This is the
   * ruleset/config injection path the buffs DB uses (never a direct module import in the
   * parser).
   */
  spellDb?: SpellDb
  /**
   * The TAILED character's name (Wave 1 of docs/plans/class-combo-inference.md). The self-`/who`
   * rule needs it because a `/who` lists every stranger in the zone in the SAME grammar as the
   * player's own row — the name is the only thing that tells them apart, and it must come from
   * the session (session.ts `resetWorldFor`), never from a constant. ABSENT by default, and the
   * rule declines every line while it is absent: with no character installed we cannot know
   * whose loadout a row states, and guessing would hand a stranger's classes to the player.
   */
  characterName?: string
  /**
   * Matches the spell name from "Your <spell> spell has worn off of <mob>." to
   * decide whether it un-charms a pet. True charm spells only — MEZ spells also
   * wear off but must NOT uncharm. Stems audited against real worn-off lines, and
   * completed against the spell DB's own charm rosters (see below).
   *
   * SINCE JOS-251 THIS IS A DERIVED SET once a spell DB is installed — every spell whose wiki
   * EFFECT LIST says it charms — with `CHARM_STEMS` demoted to the fallback for a name the catalog
   * does not carry. It is still typed as a roster rather than a regex for exactly that reason.
   */
  charmSpell: SpellRoster
  /**
   * Matches the spell name from "Your <spell> spell has worn off of <mob>." to
   * decide whether it is a CROWD-CONTROL (mez/root) spell — as opposed to a charm
   * spell (handled by charmSpell) or an unrelated buff/debuff. A CC spell wearing
   * off means the mob was mez'd/rooted right up to that moment, so the engine treats
   * it as a keep-alive CC refresh. Stems audited against real worn-off lines:
   * Mesmerization/Mesmerize/Enthrall/Entrance/Dazzle (mez), Screaming Terror and the
   * bard mez ladder, Ensnare/Immobilize/Suffocate (root).
   * Deliberately EXCLUDES pacify/lull/calm (aggro-reduction, not a hold), the
   * Selo's snare line (a movement slow, not a hold) — and, since JOS-225, the two
   * Largo's BINDING songs, which are that same movement debuff and were the one
   * member of this roster the log never once shows holding anything (see "NOT A
   * HOLD" below).
   *
   * STILL A STEM SET, DELIBERATELY (JOS-251 — see THE HALF-SWAP below the stems).
   */
  ccSpell: SpellRoster
}

/**
 * CC AND CHARM ARE ROSTERS, NOT NAMES (JOS-84) — the same law shared/alertGroups.ts states for
 * slows ("a slow is the spell you REPLACE as you level, so a def pinned to one name goes silently
 * dead at the next tier"), applied to the two stem sets that decide whether a `Your <X> spell has
 * worn off of <mob>.` line is a charm break, a mez/root break, or an ordinary debuff fade.
 *
 * THE BUG THIS FIXES, in the reporter's words: "Hey, for bard the charm break doesnt work? :D".
 * Measured, not guessed. `ccSpell` covered exactly ONE bard song — Largo's Melodic Binding,
 * which a bard gets at level 20 — and NOTHING a bard casts after it. So every bard past the
 * mid-twenties held a crowd-control break that the parser filed as a plain `buffFade`: no `cc`
 * event, no `uncharm` event, and therefore neither the "Mez / root broke" group alert nor the
 * seeded charm-break alert could ever fire. The whole ladder, read out of the committed
 * spells.json by shared LANDING MESSAGE (which is what makes it evidence rather than a guess —
 * the same argument SLOW_SPELLS makes):
 *
 *   "Someone 's head nods."                          Kelin's Lucid Lullaby        Bard 15
 *   "Someone is bound in strands of solid music."    Largo's Melodic Binding      Bard 20  (was covered)
 *       — the SCRAPE's wording, quoted as JOS-84 read it. JOS-384 corrected it to the `by` form
 *         the shipped game prints, which makes this row and the Assonant row below ONE family.
 *   "Someone 's eyes glaze over."                    Solon's Song of the Sirens   Bard 27  (a CHARM — owner, 2026-08-12)
 *   "Someone 's eyes glaze over."                    Crission's Pixie Strike      Bard 28
 *   "Someone 's eyes glaze over."                    Solon's Bewitching Bravura   Bard 39  (a CHARM — JOS-200)
 *   "Target's eyes glaze over."                      Sionachie's Dreams           Bard 40
 *   "Someone is bound by strands of solid music."    Largo's Assonant Binding     Bard 51
 *
 * Largo's Assonant Binding is the tell: it is the DIRECT UPGRADE of the one song the list had,
 * one word apart, and it was missing — the level-up failure the roster law exists to prevent.
 * (Both Largo's songs have since LEFT this roster — see "NOT A HOLD" below — but the pairing
 * argument is why they left together: whatever is true of the level-20 song is true of the
 * level-51 one, in either direction.)
 *
 * AND THE BARD'S SONG IS A CHARM AFTER ALL (JOS-200) — the one call JOS-84 got wrong, corrected
 * here rather than quietly patched, because the WAY it was wrong is the reusable lesson.
 *
 * JOS-84 read `Solon's Bewitching Bravura` as a mez off the LANDING-MESSAGE FAMILY: spells.json
 * files it under `Someone 's eyes glaze over.` beside Solon's Song of the Sirens, Crission's Pixie
 * Strike and Sionachie's Dreams, which it took for genuine mezzes, so the roster oracle below put
 * it in `ccSpell`. (Sirens has since gone the same way — see the second Solon ruling below, which
 * makes the family two charms and two mezzes rather than one and three.)
 * But **spells.json has no effect column** — `spellType` is only Beneficial/Detrimental
 * — and the game reuses one sentence for two effects. A message family is not an effect family.
 * That substitution is the whole of the error, and the oracle in tests/charmCcRoster.test.mts now
 * says so out loud.
 *
 * THE OVERTURNING EVIDENCE is in the very slice JOS-84 cited (feedback report
 * 01KZAG2QAW885YJNRTDDND8BF2, read-only, never committed) — in the half it did not read. That
 * reporter is not only singing the song; fire giants sing it AT them, three times, and each
 * episode has the same shape to the second:
 *
 *   `A fire giant warrior begins singing Solon's Bewitching Bravura.`   T
 *   `You lose control of yourself!`                                     T + 3 s
 *   `You are no longer captivated.` + `You have control of yourself again.`   T + 21..32 s
 *
 * T+3 s is this song's OWN cast time (`castTimeMs: 3000` in the DB), `You are no longer
 * captivated.` is its own `msgWearsOff`, and lose/regain-control is EverQuest's charm-on-a-player
 * pair. The same slice separately carries nine `You are stunned!` / `You are no longer stunned.`
 * episodes, so the client is plainly printing different words for the two effects and this is not
 * the mez one. Corroborating from the same slice: the shortest gap between one of the reporter's
 * own casts and the next break line is 51 s and the longest is 117 s, against a listed duration of
 * 18 s (60 s for the retired April-2000 row) — no 18-second mez holds a mob through two minutes of
 * raid AE. And three reporters on three versions (0.14.0, 0.16.0, 0.18.0) each named it the bard
 * charm, unprompted, which is the kind of testimony JOS-84 argued away and should not have.
 *
 * SO THE BREAK IS AN `uncharm` NOW, and the seeded + grouped charm-break alert — the alert all
 * three of them went looking for and could not make fire — fires for it.
 *
 * THE LANDING DELIBERATELY STAYS `cc`. `<mob>'s eyes glaze over.` is shared VERBATIM with three
 * real mez songs and nothing in that line separates them, so routing the sentence to `charm` would
 * misfile the mezzes to buy a pet binding nobody asked for. The asymmetry is the honest state of
 * the evidence (awaiting-sample law), not an oversight, and it has a stated cost: the break alert
 * fires, but a bard's charmed pet is still not modelled as a pet. Every `uncharm` consumer is a
 * guarded no-op when no charm was recorded (`WorldModel.uncharm` returns undefined for an unknown
 * name, `buffs.onUncharm` is keyed on the charmed slot, `ingest`'s release path is idempotent), so
 * an `uncharm` with no preceding `charm` costs nothing beyond the alert it exists to fire.
 *
 * NOT A HOLD — THE TWO LARGO'S BINDING SONGS LEAVE `ccSpell` (JOS-225), and this is the OTHER
 * direction of the same mistake. JOS-200 removed a spell the message oracle wrongly called a mez;
 * this removes two the ORIGINAL hand-audited stem list called "bard/enchanter mez" in 2026-07 and
 * that JOS-84's ladder then completed without ever re-checking the effect. Same failure, one layer
 * up: the roster oracle is very good at "who else prints this sentence" and says nothing at all
 * about what the sentence DOES.
 *
 * THE REPORT (JOS-225): a bard — the same install as JOS-214, feedback report
 * 01KZSH65ZX4Z74AK1CSZWQ42VK, read-only, never committed — hears the "Mez / root broke" alert
 * every time `Largo's Melodic Binding` lapses. Replaying that slice through the real parser and
 * the real alerts module: `group:cc:broke` fires FOUR times and all four are Largo's. There is not
 * one genuine mez in the slice.
 *
 * THE EFFECT EVIDENCE, and it is mechanical rather than lexical:
 *
 *   1. THE MOB FIGHTS THROUGH IT. In the slice the song's target is trading melee blows in the
 *      same second the wear-off prints — landing hits and taking them. A mesmerized mob does
 *      neither; the first point of damage wakes it and the log SAYS SO (JOS-180's line).
 *   2. NO WAKE LINE, EVER, over the owner's whole log (1,593,491 lines, measured read-only
 *      2026-08-11). `<mob> has been awakened by <name>.` lands in the same or next second as the
 *      mob's own wear-off for 1,252 of 1,848 Mesmerization breaks (67.7%), 75 of 95 Enthrall
 *      (78.9%), 73 of 85 Dazzle (85.9%), 58 of 69 Entrance (84.1%) — and 0 of 81 Largo's Melodic
 *      Binding (0.0%). Every mez in the roster is broken by damage most of the time it is cast;
 *      this one never is, because there is nothing to break.
 *   3. IT NEVER APPLIES A HOLD. The four sentences `classifyCcApply` reads — `<mob> has been
 *      mesmerized/enthralled/entranced/ensnared.` — occur 3,116 times in that log (mesmerized
 *      2,889, enthralled 128, entranced 87, ensnared 12) and Largo's cannot be any of them: the
 *      DB records its landing as `<mob> is bound in strands of solid music.` (the `by` form since
 *      the JOS-384 correction — a different preposition, the same event shape), which is a
 *      `buffApply`. So the "hold" this roster claimed to keep alive has no application event
 *      anywhere in the corpus — the wear-off was the only evidence it ever existed, and a
 *      wear-off is what every debuff prints.
 *   4. IT IS A `PB AE` in the committed DB, sung on a 6-second pulse (the slice re-lands it every
 *      6-7 s for minutes) against an 18-second duration. A bard AE-holding every mob adjacent to
 *      themselves while the group melees those same mobs is not a thing the slice shows happening;
 *      what it shows is the group killing them.
 *
 * ONE ROSTER, TWO SONGS, and both go — Melodic 20 and Assonant 51 — for exactly the reason JOS-84
 * added the second: a fix that leaves the level-51 upgrade behind hands the same false positive
 * back to the same bard thirty levels later.
 *
 * FALLING OUT OF BOTH ROSTERS IS THE CORRECT FILING HERE, which is the one thing R1b in
 * tests/charmCcRoster.test.mts warns against — for a HOLD. A hold that lands in `buffFade` fires
 * nothing and that is JOS-84's defect. A movement debuff that lands in `buffFade` is a debuff
 * filed as a debuff: the Buffs tab still draws its bar off the landing emote and its fade off this
 * very sentence, and the alert that should not fire does not. The slice settles it from the inside
 * — that bard also sings `Selo's Consonant Chain`, the level-23 song of the same binding line,
 * which this roster has ALWAYS excluded; its three wear-offs in the slice are silent `buffFade`s
 * while Largo's four scream. Two songs, one effect, opposite behaviour, in one pull.
 *
 * AND `buffFade` IS WHERE THE SLOW GROUP PICKS THEM UP (JOS-233, owner ruling 2026-08-12). Nothing
 * in THIS file changes — both songs stay out of both parser rosters, exactly as above, and their
 * break is still an ordinary `buffFade`. What changed is downstream: shared/alertGroups.ts's slow
 * roster now claims them by NAME on the mob side, because the owner ruled the binding is an
 * attack-speed debuff as well as a snare and its expiry is the quiet loss the slow group exists
 * for. So JOS-225's silence was the correct middle step and not the destination: the alert that
 * fires is "Slow wore off a mob", never "Mez / root broke", and R1c/R1d below pin exactly that.
 * The wider binding line (`Selo's Consonant Chain` 23, `Selo's Chords of Cessation` 48,
 * `Selo's Assonant Strain` 54) is EXPLICITLY UNRULED and stays silent in every roster.
 *
 * THE CHARM SIDE gets the same completion, from the DB's other roster: five Necromancer
 * charm-undead spells share the landing message "Someone moans." — Dominate Undead 18, Beguile
 * Undead 31, Cajole Undead 47, Thrall of Bones 54, Enslave Death 60 — and the stems covered the
 * first three by accident (dominate / beguile / cajol) while a necro who reached 54 lost their
 * charm break.
 *
 * …AND THE DRUID/SHAMAN SIDE WAS NEVER A PAIR (JOS-250 charm roster research 2026-08-12). This
 * paragraph used to say "the Druid/Shaman pair (Charm Animals, Allure of the Wild) were already
 * complete", and that was FALSE. `Someone blinks.` is a SEVEN-member ladder in the committed
 * spells.json, every one of them castable and Detrimental: Befriend Animal (Druid 13 / Shaman 25),
 * Charm Animals (Druid 23 / Shaman 32), Beguile Plants (Druid 28), Beguile Animals (Druid 33),
 * Allure of the Wild (Druid 43), Call of Karana (Druid 52), Tunare`s Request (Druid 55). Three of
 * the seven — Befriend Animal, Call of Karana, Tunare`s Request — matched no stem at all, so the
 * druid's FIRST charm and their last two both lost their break line. The same "one word apart"
 * failure JOS-84 caught for Largo's, at the two ends of a different ladder.
 *
 * `tunare.s request` carries the same apostrophe/backtick dot the bard stems do, and here it is
 * load-bearing rather than defensive: the committed DB row spells it with a BACKTICK
 * (``Tunare`s Request``) while the log prints an apostrophe, so a stem written either way alone
 * would satisfy one of the two readers and fail the other.
 *
 * FOUR FALSE POSITIVES LEFT AT THE SAME TIME, and one of them was dangerous rather than untidy:
 *   * `\bcharm\b(?! of )` drops the two ITEM focus effects `Naki's Charm of Pernicity` and
 *     `Tavee's Charm of Diuturnity` — a charm is a trinket as well as a spell in this game.
 *   * `\ballure\b(?! of death)` drops `Allure of Death`, a Beneficial NECRO SELF-BUFF.
 *   * the `boltran` stem is DELETED outright. `agacerie` already matches `Boltran's Agacerie`
 *     uniquely, so the stem bought nothing — while it also matched `Boltran's Animation`, a
 *     Beneficial PET SUMMON with a 9,000 ms cast time. That is not a cosmetic miss: JOS-250 arms
 *     a charm-attribution window of `castTime + slack` on a matching cast, so the stem was
 *     handing a pet-summoning magician a 10.5-second window in which the next caster-less charm
 *     broadcast in the zone would be attributed to them. The exact adoption the ownership model
 *     exists to prevent, reached through the roster's back door.
 * `alluring whispers` is added for completeness (NPC-only, so no `Your … has worn off of` line can
 * ever name it, but it is a member of the enchanter landing family and the oracle walks members).
 *
 * AND THE SECOND SOLON SONG IS A CHARM TOO (owner ruling 2026-08-12, on the wiki evidence). This
 * paragraph said `song of the sirens` was contested and staying in `CC_STEMS`; the ruling settled
 * it, and the citation is the wiki page's own EFFECT line — **"1: Charm up to level 37"**, which
 * is the column spells.json does not carry and the column JOS-84's message-family walk had to
 * guess at. So BOTH of Solon's songs are the bard charm line: `Solon's Song of the Sirens` 27 and
 * `Solon's Bewitching Bravura` 39, one stem alternation, one roster.
 *
 * IT MOVES ROSTERS RATHER THAN JOINING ONE. Leaving it in `CC_STEMS` as well would make it the
 * only spell in the tree that satisfies both, which `isCcSpell`'s charm-wins overlap rule would
 * quietly paper over and which the roster oracle refuses outright — a spell has one effect. Its
 * wear-off is an `uncharm` and fires charm-break from here on, never the mez group.
 *
 * THE LANDING IS UNCHANGED and stays impure: `Someone 's eyes glaze over.` is now two charms
 * (Sirens 27, Bravura 39) and two real mezzes (Crission's Pixie Strike 28, Sionachie's Dreams 40),
 * so the sentence still cannot be routed and still resolves through the arm — exactly the
 * `goes berserk.` pattern charmModel.ts already runs on. That is JOS-200's standing cost, paid
 * once more rather than relitigated.
 *
 * FIELD CORROBORATION IS STILL OUTSTANDING, and it is named rather than implied: JOS-200 proved
 * Bravura a charm from a reporter's slice (`You lose control of yourself!` at T+3 s, against nine
 * `You are stunned!` episodes in the same slice), and no slice in hand shows Sirens doing the same
 * thing. The wiki effect line is the evidence this ruling rests on; a slice that shows the
 * lose-control pair for Sirens would upgrade it from stated to measured.
 *
 * NOTHING HERE IS INVENTED. Every added name is a spell in src/main/data/spells.json that shares
 * its landing message with a member the rosters already classified; tests/charmCcRoster.test.mts
 * re-derives both families from spells.json on every run, so a future scrape that adds a member
 * fails the suite instead of going quietly mute in somebody's ears.
 *
 * The `.` in `Kelin.s` / `Largo.s` / `Solon.s` is the same trick SLOW_SPELLS uses: EQ writes
 * possessives with both an apostrophe and a backtick, so one character class covers the pair.
 *
 * `(bewitching )?` is NOT decoration — the roster oracle found it. The committed spells.json
 * records the level-39 song as **"Solon's Bravura"** while the LOG prints **"Solon's Bewitching
 * Bravura"** (the wiki page's own `spellname` is the short form). The parser only ever sees the
 * log's spelling, but the roster is CHECKED against the DB's, so the stem has to answer to both or
 * the oracle and the game disagree about the same song. Nothing else in the DB is named Bravura.
 * SINCE JOS-161 the LOADED db says `Solon's Bewitching Bravura` too — the corrections overlay
 * renames both level-39 rows, because the name is the join key `byKey`, the alert catalog and
 * every `where.spell` are compared on. The optional group stays: this regex is also run against
 * the RAW `spells.json` (tests/charmCcRoster.test.mts, combat/charmModel.ts), which is pristine
 * by design, so both spellings are still live in the tree and both must classify. It rode from
 * `CC_STEMS` to `CHARM_STEMS` intact in JOS-200 for the same reason.
 *
 * THE STEMS ARE EXPORTED (JOS-161, widened JOS-200) for one reader beyond this file: `spellDb.ts`
 * gates the catalog's `breaks` template on `CC_STEMS` and its `charmBreaks` twin on `CHARM_STEMS`,
 * because a suggestion offered for a spell the parser would file as a plain `buffFade` is a
 * suggestion that cannot fire — and the two rosters answer to two different EVENTS (`cc` vs
 * `uncharm`), which is why they are two templates rather than one. Importing them is the same
 * "one source of truth per question" move `combat/charmModel.ts` already makes by reading them
 * back off `getParserConfig()`; there is no cycle, because rulesets.ts's only reference to
 * spellDb.ts is a `import type`.
 *
 * A WEAR-OFF LINE IS RANK-LESS, MEASURED (JOS-200), which is what lets either per-spell template
 * pin a bare name: over the owner's whole log, 3,382 of 3,383 `Your <X> spell has worn off of
 * <mob>.` lines carry no roman-numeral suffix (the single exception is a `Rune IV`), so a def
 * built from the catalog's display name matches the sentence the game actually prints.
 */
export const CHARM_STEMS =
  /\bcharm\b(?! of )|beguile|\ballure\b(?! of death)|alluring whispers|cajol|dictate|besiege|agacerie|beckon|command of druzzil|dominate|thrall of bones|enslave death|befriend animal|call of karana|tunare.s request|solon.s ((bewitching )?bravura|song of the sirens)/i
export const CC_STEMS =
  /mesmeriz|enthrall|entranc|dazzle|screaming terror|ensnar|immobiliz|suffocat|kelin.s lucid lullaby|pixie strike|sionachie.s dreams/i

/**
 * THE HALF-SWAP (JOS-251), and the half that did not move is the interesting one.
 *
 * `charmSpell` IS NOW DERIVED. The scrape captures each spell page's numbered effect list, and
 * `spellEffectClass.ts` reads it, so "does this spell charm?" is a query over committed data rather
 * than a stem alternation somebody has to remember to extend. The stems above stay as the FALLBACK
 * for a name the catalog does not carry — which is the only case left, because the derived set is
 * keyed by `spellCanonKey` and therefore already answers a ranked log name (`Allure VII`).
 *
 * THE SWAP IS PROVABLY BEHAVIOUR-PRESERVING TODAY, and that is the point of doing it this way
 * rather than as a rewrite: over all 1,928 rows of the corrected catalog, `CHARM_STEMS.test(name)`
 * and the derived set agree on EVERY name, in both directions — zero disagreements, measured, and
 * asserted every run by tests/charmCcRoster.test.mts. So this commit changes no classification at
 * all; what it changes is where the next charm comes from. JOS-250 had to hand-add four stems and
 * hand-remove four false positives after a human read the wiki page by page; the next scrape that
 * adds a charm adds it here for free, and a scrape that DISAGREES with a stem fails the suite
 * instead of quietly being right or quietly being wrong.
 *
 * `ccSpell` DID NOT MOVE, and refusing to move it is a finding rather than an omission. The derived
 * hold roster (mez ∪ root) disagrees with these stems on nineteen spells in both directions:
 *
 *   THE STEMS CLAIM FIVE NON-HOLDS — `Ensnare` (a pure `Decrease Movement Speed by 40%`, swept in
 *   by the `ensnar` stem that exists for Ensnaring ROOTS), `Suffocate` and `Suffocating Sphere`
 *   (damage-over-time and stat debuffs), and two NPC spells whose names contain "mesmeriz" while
 *   their effect lines say Silence and Stun. By the JOS-225 rule — a movement debuff is not a hold
 *   — the first three are that exact defect, still live.
 *
 *   THE DERIVATION CLAIMS FOURTEEN THE STEMS MISS — the whole druid root ladder, `Fetter`,
 *   `Paralyzing Earth`, three enchanter mezzes, and, most plainly, the spell literally named
 *   `Root`, whose break has never reached the "Mez / root broke" group at all.
 *
 * Both halves are corrections. But `Ensnare` is not a stray: it is the worked example in
 * tests/earlyWarningBreaks.test.mts, the debuff in the buff-overlay e2e, and the hold in the
 * offline-pause fixture — this tree has treated a snare as a trackable hold since long before
 * JOS-225 drew the line for ALERTS. Reconciling "a snare is a hold for the timer model" with "a
 * snare is not a hold for the alert" is an owner ruling about product behaviour, not a refactor an
 * executor performs on the way past. tests/spellEffectClass.test.mts pins the derivation's answer
 * for all nineteen so the ruling has something to land against.
 */
const classic: ParserConfig = {
  id: 'classic',
  charmSpell: CHARM_STEMS,
  ccSpell: CC_STEMS
}

/**
 * The derived charm roster over an installed DB, with `fallback` answering for names it does not
 * carry.
 *
 * NPC-ONLY SPELLS ARE KEPT (`castableOnly: false`), which is not the default `effectRoster` gate
 * and is deliberate here: `CHARM_STEMS` matches `Alluring Whispers`, `Dragon Charm` and
 * `Vampire Charm` — JOS-250 added the first of them "for completeness" — and this config feeds
 * `charmModel.isCharmSpell`, which arms on a CAST rather than on a `Your <X> … worn off of` line.
 * Dropping them would be a real behaviour change smuggled inside a refactor. SELF-target rows stay
 * excluded (`targetOnly` default), because there are none in the charm class to exclude.
 */
function derivedCharmRoster(db: SpellDb, fallback: RegExp): SpellRoster {
  const keys = charmRoster(db.spells, { castableOnly: false })
  return { test: (name: string): boolean => keys.has(spellCanonKey(name)) || fallback.test(name) }
}

export const PARSER_CONFIGS: Record<string, ParserConfig> = {
  eqlegends: classic,
  p99: classic // classic format; refine if P99 diverges
}

export function getParserConfig(profileId: string = DEFAULT_PROFILE): ParserConfig {
  return PARSER_CONFIGS[profileId] ?? classic
}

/**
 * Inject a spell database into a profile's parser config (Task #34), enabling the
 * message-driven buffApply / buffWearOff events. Called once at main startup after the DB
 * is loaded. Applies to ALL configs by default (they share the same message grammar); pass
 * a profileId to scope it. Idempotent — re-installing replaces the DB.
 *
 * IT ALSO INSTALLS THE DERIVED CHARM ROSTER (JOS-251). A DB is the only thing that carries the
 * effect lines, so this is the one place that can build the roster from them — and clearing the DB
 * puts `CHARM_STEMS` back, which keeps the purity contract this function was written under: a
 * profile with no DB behaves exactly as it did before any of this existed.
 */
export function installSpellDb(db: SpellDb | undefined, profileId?: string): void {
  const roster = db ? derivedCharmRoster(db, CHARM_STEMS) : CHARM_STEMS
  if (profileId) {
    const cfg = PARSER_CONFIGS[profileId]
    if (cfg) {
      cfg.spellDb = db
      cfg.charmSpell = roster
    }
    return
  }
  for (const cfg of Object.values(PARSER_CONFIGS)) {
    cfg.spellDb = db
    cfg.charmSpell = roster
  }
  classic.spellDb = db
  classic.charmSpell = roster
}

/**
 * Inject the TAILED character's name into the parser config, enabling the self-`/who` rule
 * (Wave 1 of docs/plans/class-combo-inference.md). Called from session.ts on every character
 * (re)tail, BEFORE the replay, so the very first `/who` row in the scan is attributed
 * correctly. Same injection path as installSpellDb — the parser stays pure and never reaches
 * for the session. Pass undefined to clear (no character ⇒ no self row can be identified).
 */
export function installCharacterName(name: string | undefined, profileId?: string): void {
  if (profileId) {
    const cfg = PARSER_CONFIGS[profileId]
    if (cfg) cfg.characterName = name
    return
  }
  for (const cfg of Object.values(PARSER_CONFIGS)) cfg.characterName = name
  classic.characterName = name
}
