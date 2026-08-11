import { DEFAULT_PROFILE } from '../../shared/profiles'
import type { SpellDb } from '../data/spellDb'

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
   */
  charmSpell: RegExp
  /**
   * Matches the spell name from "Your <spell> spell has worn off of <mob>." to
   * decide whether it is a CROWD-CONTROL (mez/root) spell — as opposed to a charm
   * spell (handled by charmSpell) or an unrelated buff/debuff. A CC spell wearing
   * off means the mob was mez'd/rooted right up to that moment, so the engine treats
   * it as a keep-alive CC refresh. Stems audited against real worn-off lines:
   * Mesmerization/Mesmerize/Enthrall/Entrance/Dazzle (mez), Largo's Melodic Binding
   * & Screaming Terror (bard/enchanter mez), Ensnare/Immobilize/Suffocate (root).
   * Deliberately EXCLUDES pacify/lull/calm (aggro-reduction, not a hold) and the
   * Selo's snare line (a movement slow, not a hold).
   */
  ccSpell: RegExp
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
 *   "Someone 's eyes glaze over."                    Solon's Song of the Sirens   Bard 27
 *   "Someone 's eyes glaze over."                    Crission's Pixie Strike      Bard 28
 *   "Someone 's eyes glaze over."                    Solon's Bewitching Bravura   Bard 39
 *   "Target's eyes glaze over."                      Sionachie's Dreams           Bard 40
 *   "Someone is bound by strands of solid music."    Largo's Assonant Binding     Bard 51
 *
 * Largo's Assonant Binding is the tell: it is the DIRECT UPGRADE of the one song the list had,
 * one word apart, and it was missing — the level-up failure the roster law exists to prevent.
 *
 * AND THE BARD'S SONG IS A CHARM AFTER ALL (JOS-200) — the one call JOS-84 got wrong, corrected
 * here rather than quietly patched, because the WAY it was wrong is the reusable lesson.
 *
 * JOS-84 read `Solon's Bewitching Bravura` as a mez off the LANDING-MESSAGE FAMILY: spells.json
 * files it under `Someone 's eyes glaze over.` beside Solon's Song of the Sirens, Crission's Pixie
 * Strike and Sionachie's Dreams, which are genuine mezzes, so the roster oracle below put it in
 * `ccSpell`. But **spells.json has no effect column** — `spellType` is only Beneficial/Detrimental
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
 * THE CHARM SIDE gets the same completion, from the DB's other roster: five Necromancer
 * charm-undead spells share the landing message "Someone moans." — Dominate Undead 18, Beguile
 * Undead 31, Cajole Undead 47, Thrall of Bones 54, Enslave Death 60 — and the stems covered the
 * first three by accident (dominate / beguile / cajol) while a necro who reached 54 lost their
 * charm break. The Enchanter ladder (Charm 11, Beguile 23, Cajoling Whispers 37, Allure 46,
 * Boltran's Agacerie 53, Dictate 60) and the Druid/Shaman pair (Charm Animals, Allure of the
 * Wild) were already complete and are unchanged.
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
  /\bcharm\b|beguile|allure|cajol|dictate|besiege|agacerie|beckon|command of druzzil|dominate|boltran|thrall of bones|enslave death|solon.s (bewitching )?bravura/i
export const CC_STEMS =
  /mesmeriz|enthrall|entranc|dazzle|largo.s (melodic|assonant) binding|screaming terror|ensnar|immobiliz|suffocat|kelin.s lucid lullaby|song of the sirens|pixie strike|sionachie.s dreams/i

const classic: ParserConfig = {
  id: 'classic',
  charmSpell: CHARM_STEMS,
  ccSpell: CC_STEMS
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
 */
export function installSpellDb(db: SpellDb | undefined, profileId?: string): void {
  if (profileId) {
    const cfg = PARSER_CONFIGS[profileId]
    if (cfg) cfg.spellDb = db
    return
  }
  for (const cfg of Object.values(PARSER_CONFIGS)) cfg.spellDb = db
  classic.spellDb = db
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
