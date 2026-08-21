// alertGroups.ts — the CURATED one-click alert groups ("grounded sane defaults").
//
// A GROUP is a small, coherent set of AlertDefs the user turns on with one click: "Out of
// range", "Resists", "Mez / root broke". It is the counterpart to the per-spell suggestion
// templates in features/alerts/suggestions.ts — those answer "alert me about THIS spell",
// these answer "alert me about the things that silently cost you a pull".
//
// THE LAW HERE IS VERIFICATION. Every trigger below was checked READ-ONLY against the real
// log (eqlog_Primitive_freeport.txt, 1,144,036 lines, 2026-08-03) and the exact matched line
// shape + its occurrence count is quoted beside it. A group whose line does NOT exist in the
// log ships `verified: false` and is NOT rendered — a guessed regex that never fires is worse
// than an absent feature, because the user believes they are covered. Two groups the owner
// asked for are in exactly that state (feign-death failure, pet death); their comments say
// why, so nobody re-derives the same dead end.
//
// PARSED EVENTS OVER RAW REGEXES. Where the parser already emits a typed event for the line
// (resist, uncharm, cc, castFizzle, castInterrupted, playerDeath) the trigger uses the EVENT
// kind: it survives log-format drift, it carries structured `where` fields, and the parse is
// already golden-window tested. Raw regexes are used only for lines no event covers — the
// four client-side notices ("too far away", "out of range", "cannot see", "Insufficient
// Mana"), the two invisibility lines and the block notice.
//
// SOUNDS mirror the shipped Alan Rickman pack the same way suggestions.ts does — the ids are
// repeated as literals because a renderer module cannot import from src/main. They are
// declared in src/main/data/defaultPacks.ts (`DEFAULT_ALERT_SOUNDS`) so provisionPacks
// verifies they resolved after an install; keep the two lists in sync.
//
// COOLDOWNS are per-group judgment calls, documented on each group. The rule of thumb: the
// cooldown is the length of ONE user-visible episode, not the gap between two log lines — a
// melee out-of-range notice repeats 2-4× per second for as long as you hold auto-attack, so
// its cooldown is "tell me once per approach", not "once per line".

import type { AlertDef, AlertTrigger } from './alertTypes'
import { REFUSED_ALERT_GROUPS } from './alertGroupsRefused'

/** The shipped pack every group's sound points at (mirrors DEFAULT_ALERT_PACK_ID). */
export const GROUP_PACK_ID = 'alan-rickman'

/**
 * The rogue-slow group's id and its ONE def's id, named here so the two entry points that
 * create it — the groups panel and the observed-driven offer strip
 * (docs/plans/poison-slow-alerts.md §1.3) — author the SAME def. One id, two doors: creating
 * it from either is idempotent, and having it from either retires the offer.
 */
export const POISON_SLOW_GROUP_ID = 'poisonSlow'
export const POISON_SLOW_ALERT_ID = 'alert:poison-slow-landed'

/**
 * Alan Rickman lines used by the groups (derived soundIds; see defaultPacks.ts header).
 * The spoken line each one is, so a future edit keeps the INTENT rather than the id.
 */
const SOUND = {
  /** "You are out of position." — you cannot reach what you are attacking. */
  outOfRange: 'resource-limit-resource-limit-01',
  /** a dry error read — your spell was shrugged off. */
  resisted: 'task-error-task-error-01',
  /** a dry error read — the cast never happened. */
  castFailed: 'task-error-task-error-02',
  /** a limit read — you are becoming visible again. */
  invisDrop: 'resource-limit-resource-limit-02',
  /** a limit read — the mana is not there. */
  outOfMana: 'resource-limit-resource-limit-03',
  /** an error read — the spell bounced off an existing effect. */
  spellBlocked: 'task-error-task-error-03',
  /** a flat error read — you are dead. */
  playerDeath: 'task-error-task-error-04',
  /** "I find myself... requiring your attention." — the seeded charm-break line. */
  charmBreak: 'input-required-input-required-02',
  /** an attention read — the thing you were holding is loose again. */
  ccBreak: 'input-required-input-required-03',
  /** "Consider this my opening move." — a debuff took hold on the mob in front of you. */
  debuffLanded: 'task-acknowledge-task-acknowledge-05',
  /** "Pause, please. I have need of you." — the slow expired; it needs re-landing. */
  slowExpired: 'input-required-input-required-08',
  /**
   * "Your input would be most welcome. Whenever you're ready." — somebody is waiting on a reply.
   *
   * NOT A CHIME, and that is measured rather than a preference (JOS-69). The ONE pack the app
   * ships and provisions is Alan Rickman: 60 spoken-word lines across six CESP categories and
   * not a single tone, sting or bell in it (its manifest is the whole inventory). A seeded def
   * may only point at a pack the app guarantees is on disk — provisionPacks verifies exactly
   * REQUIRED_SOUND_IDS after the install, and an alert aimed at an un-provisioned registry pack
   * is silently MUTE for every user who never installed it. So the seed takes the closest
   * spoken line and the user re-points it at any installed pack from the alert row's picker,
   * which pre-selects alan-rickman through the ordinary `fallbackPack` path.
   */
  tellReceived: 'input-required-input-required-04',
  /** "There. Tied with a neat little bow." — something worth stopping for hit your bags. */
  moteLooted: 'task-complete-task-complete-10'
} as const

/** Every group sound id, for the defaultPacks.ts cross-check + provisioning verification. */
export const GROUP_SOUND_IDS: string[] = [...new Set(Object.values(SOUND))]

/** One alert a group authors. `id` is the FINAL alert id (stable, for created-detection). */
export interface AlertGroupDefSpec {
  id: string
  name: string
  trigger: AlertTrigger
  soundId: string
  cooldownMs: number
  /**
   * What the cooldown is measured PER (AlertDef.cooldownScope). Omitted ⇒ 'alert', the one
   * clock every group had before per-target scope existed. Only the rogue-slow group asks for
   * 'target' today, and its comment says why.
   */
  cooldownScope?: 'alert' | 'target'
  /** the verified log line this def fires on — quoted into the def's `note`. */
  line: string
  /** how many times that shape occurs in the reference log (provenance, not a threshold). */
  observed: number
  /**
   * A SECOND verified line the same def fires on, for a trigger that covers two shapes. Same
   * law as `line`: quoted verbatim from the real log with its own measured count, or absent.
   * Never a paraphrase of `line`.
   *
   * NO GROUP USES IT TODAY. The rogue-slow def did for one afternoon (2026-08-04), while its
   * trigger covered both slow Strikes; the owner narrowed it back to one emote, so the second
   * quote went with the second effect. The field stays because the shape it describes — one
   * def, two verified sentences — is still the honest way to write such a def if one lands.
   */
  line2?: string
  /** occurrences of `line2` in the reference log — required whenever `line2` is present. */
  observed2?: number
  /**
   * Extra provenance appended to the created def's `note` — what the alert MEANS in the
   * fight (a duration, a re-landing habit), never how the matcher works. Optional; most
   * groups' quoted line says everything there is to say.
   */
  note?: string
}

/** A one-click group of alerts. */
export interface AlertGroup {
  id: string
  /** what the group is, in the user's words. */
  title: string
  /** the STATE it reports (never how it works). */
  subtitle: string
  /**
   * false ⇒ the group is NOT offered: the log carries no line that could fire it. The UI
   * filters on this; `unverifiedReason` exists so the omission stays documented in one place.
   */
  verified: boolean
  unverifiedReason?: string
  defs: AlertGroupDefSpec[]
}

/**
 * A raw-line trigger for an EXACT client notice.
 *
 * A raw trigger is tested against `LogEvent.raw`, which is the WHOLE line INCLUDING the
 * `[Tue Jul 28 13:04:53 2026] ` timestamp prefix (parser.ts keeps `raw` verbatim and only
 * `text` is stripped). So the left anchor is the `] ` that closes the timestamp, never `^` —
 * a `^`-anchored pattern here would match nothing at all, silently.
 */
function rawLine(text: string): AlertTrigger {
  return { type: 'raw', regex: `\\] ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` }
}

/**
 * THE SLOW ROSTER — every attack-slow a PLAYER can cast, as a `where` field matcher.
 *
 * An `event` trigger's `where` value is an exact case-insensitive compare UNLESS it is wrapped
 * in slashes, in which case it is a case-insensitive RegExp against the stringified field
 * (main/modules/alerts.ts `compileFieldMatch`). That is what lets ONE def cover the whole
 * family, which is the point: a slow is a spell you REPLACE as you level, so a def pinned to
 * one name goes silently dead at the next tier. An enchanter walks Languid Pace (9) → Tepid
 * Deeds (23) → Shiftless Deeds (41) → Forlorn Deeds (57) and a shaman walks Drowsy (5) →
 * Walking Sleep (13) → Tagar's (27) → Togor's (38) → Turgur's (51) → Tigir's (58); one alert
 * has to survive all of it or it is worse than no alert.
 *
 * THE ROSTER IS DB KNOWLEDGE, NOT A GUESS. It is every spells.json entry whose cast-on-other
 * message is one of the game's two slow landing emotes — `Someone slows down.` (the enchanter
 * line, and the one AGENTS.md's log-format reference already names as a slow LANDING) and
 * `Someone yawns.` (the shaman line). Same argument as the rogue-slow group below, which
 * matches on the poison `effect` rather than on a Strike name and reads its coat roster out of
 * shared/poisons.ts: a family the DB enumerates is evidence, and pinning one member is the
 * fragile choice. The two NPC-ONLY members of those emote families (Rejuvenation, Energy Sap)
 * are deliberately absent — you cannot cast them, so `Your <X> spell has worn off of …` can
 * never print for one.
 *
 * The `.` in `Tagar.s` is doing real work: EQ writes possessives with BOTH an apostrophe and a
 * backtick and the spell DB carries both spellings of the same spell (`Turgur's Insects` /
 * `Turgur\`s Insects`), so one character class covers the pair instead of eight alternatives.
 *
 * WHAT THE OWNER'S LOG ACTUALLY PRINTED (read-only sweep of eqlog_Primitive_freeport.txt,
 * 1,406,311 lines, 2026-08-06): 52 mob-side wear-offs across three of the ten — Shiftless
 * Deeds 26, Languid Pace 23, Tepid Deeds 3 — and zero for the other seven, because this
 * character is an enchanter who has not reached 57. The two defs below quote what was
 * observed; the roster is what the def has to cover to still be right next month.
 *
 * THE BARD'S BINDING SONGS JOIN THE MOB SIDE (JOS-233, owner ruling 2026-08-12), and they are
 * the first members that do NOT come from the emote oracle — so they are listed separately and
 * the reason is written down rather than folded into the family regex.
 *
 * JOS-225 took `Largo's Melodic Binding` (Bard 20) and `Largo's Assonant Binding` (Bard 51) out
 * of the parser's `ccSpell` roster because their wear-off was firing "Mez / root broke" at a bard
 * and they hold nothing — the target trades melee blows through the song and `<mob> has been
 * awakened by <name>.` accompanies 0 of 81 of the level-20 song's wear-offs (see the NOT A HOLD
 * section of src/main/log/rulesets.ts for the full count table). That fix was right about what
 * they are not, and it left them SILENT: the break fell through to a plain `buffFade` that no
 * group claimed. The owner's ruling names what they are — an attack-speed debuff as well as a
 * snare, i.e. a slow whose expiry is the same quiet loss this group exists for — so the wear-off
 * fires "Slow wore off a mob" instead of nothing.
 *
 * THE PROVENANCE IS AN OWNER RULING, NOT THE MESSAGE ORACLE, and that distinction is the whole
 * reason for two lists. The DB groups spells by LANDING message, and the two Largo's songs share
 * ONE — `Someone is bound by strands of solid music.`, which since JOS-384 is what the corrections
 * overlay gives the level-20 song as well (the wiki wrote `in` and the shipped game prints `by`).
 * Before that correction each had a one-member family of its own, and the note here said the
 * landing-message oracle had nothing to say about them in either direction; now it has a family to
 * say it about, and the answer is the same, because a message family is not an effect family (the
 * law JOS-200 and JOS-225 each learned the hard way). That cuts both ways: the oracle cannot put
 * these songs in, and it cannot keep them out. What the shared sentence DOES change is the mob
 * side's arithmetic — see the on-you paragraph below, which was already written for exactly this
 * shape and is why the two sides take different rosters.
 *
 * THE WIDER BARD BINDING LINE STAYS OUT — `Selo's Consonant Chain` (23), `Selo's Chords of
 * Cessation` (48) and `Selo's Assonant Strain` (54) are the same shape of song and are EXPLICITLY
 * UNRULED. They print their own wear-off sentences, they have never been in any roster, and
 * guessing them in would be inventing an effect claim the owner did not make. JOS-225's slice
 * used Consonant Chain's silence as its control; it stays silent.
 *
 * AND THE ON-YOU SIDE DOES NOT GET THEM, MEASURED. Both Largo's print `The strands fade away.`
 * when they expire ON you — and so does `Lyssa's Solidarity of Vision`, the Bard 34 BENEFICIAL
 * vision buff, verbatim. A `where:{spell:…}` matcher tests the whole CANDIDATE list (JOS-84), so
 * one roster shared by both defs would fire "Slow wore off you" every time a bard's own beneficial
 * buff lapsed, with no way to tell which spell the sentence meant. That is the haste twin
 * (`Your speed returns to normal.`) all over again, except the two sentences are not one word
 * apart — they are IDENTICAL. So the mob side, where `Your <X> spell has worn off of <mob>.` names
 * the spell outright and carries no candidates at all, takes the two songs; the on-you side keeps
 * the emote-derived ten, whose two shared sentences resolve to slows and nothing else. Pinned in
 * tests/slowMoteTellAlerts.test.mts (J1b) and tests/charmCcRoster.test.mts (R1c).
 *
 * OWNER-LOG COUNTS for the pair (same file, re-measured read-only 2026-08-12, 1,593,491 lines):
 * `Your Largo's Melodic Binding spell has worn off of <mob>.` 81, Assonant Binding 0 (this
 * character never reached 51), `The strands fade away.` 0, and Consonant Chain 0.
 */
const SLOW_LADDERS = [
  // The enchanter line — `Someone slows down.`
  'Languid Pace',
  'Tepid Deeds',
  'Shiftless Deeds',
  'Forlorn Deeds',
  // The shaman line — `Someone yawns.`
  'Drowsy',
  'Walking Sleep',
  'Tagar.s Insects',
  'Togor.s Insects',
  'Turgur.s Insects',
  'Tigir.s Insects'
]

/** The two songs JOS-233 ruled in — mob side only; see the header for why not the on-you side. */
const BARD_BINDINGS = ['Largo.s Melodic Binding', 'Largo.s Assonant Binding']

/**
 * THE OPTIONAL RANK TAIL EVERY ROSTER REGEX CARRIES (JOS-276, owner law 2026-08-13: ranks are not
 * used for ANYTHING in the alert system).
 *
 * The rank fold that makes a LITERAL `where.spell` matcher rank-blind (JOS-259) deliberately does
 * not touch `/regex/` specs, because a user-authored pattern is intent rather than a spelling. But
 * the two rosters below are not user-authored — the APP writes them, out of a DB roster, and the
 * `$` anchor is ours. So the fold has to be spelled INTO the pattern here, and this is where.
 *
 * IT IS NOT A THEORETICAL GAP. `Your <X> spell has worn off of <mob>.` is rank-less in 3,382 of
 * 3,383 whole-log occurrences (JOS-200's count) — and the 3,383rd is
 * `[Wed Aug 05 17:18:06 2026] Your Rune IV spell has worn off of a gust of wind.`, which proves
 * the SHAPE exists. A slow whose wear-off printed that way would have fallen straight through both
 * defs, silently, exactly as the wizard's resisted alert did.
 *
 * Non-capturing so it cannot become a named group; the numerals mirror `spellLineKey`'s I–X.
 */
const RANK_TAIL = '(?: (?:I|II|III|IV|V|VI|VII|VIII|IX|X))?'

/** The mob-side roster: `Your <X> spell has worn off of <mob>.` names the spell outright. */
const SLOW_SPELLS_MOB = `/^(${[...SLOW_LADDERS, ...BARD_BINDINGS].join('|')})${RANK_TAIL}$/`

/** The on-you roster: shared sentences, so only families whose every candidate is a slow. */
const SLOW_SPELLS_SELF = `/^(${SLOW_LADDERS.join('|')})${RANK_TAIL}$/`

/**
 * THE CATALOG. Order is the order the surface renders them: the two the owner called out
 * first (range, resists), then the crowd-control pair, then the cast/resource failures.
 */
export const ALERT_GROUPS: AlertGroup[] = [
  {
    id: 'range',
    title: 'Out of range',
    subtitle: 'Your swings and casts are not reaching the target.',
    verified: true,
    defs: [
      {
        // COOLDOWN 8s: the melee notice repeats 2-4× per second for the whole time auto-attack
        // is on and the mob is out of reach (3,329 lines, in bursts). 8s = one nudge per
        // approach; anything shorter is a machine-gun.
        id: 'group:range:melee',
        name: 'Out of range - melee',
        trigger: rawLine('Your target is too far away, get closer!'),
        soundId: SOUND.outOfRange,
        cooldownMs: 8000,
        line: 'Your target is too far away, get closer!',
        observed: 3329
      },
      {
        // The SPELL-side twin — a different sentence entirely, and rarer (you notice a failed
        // cast sooner than a failed swing). Same 8s episode length.
        id: 'group:range:spell',
        name: 'Out of range - spell',
        trigger: rawLine('Your target is out of range, get closer!'),
        soundId: SOUND.outOfRange,
        cooldownMs: 8000,
        line: 'Your target is out of range, get closer!',
        observed: 72
      },
      {
        // Line of sight, not distance — the third way "you are attacking nothing" happens, and
        // the one people mistake for lag. Same burst behaviour as the melee notice.
        id: 'group:range:sight',
        name: 'No line of sight',
        trigger: rawLine('You cannot see your target.'),
        soundId: SOUND.outOfRange,
        cooldownMs: 8000,
        line: 'You cannot see your target.',
        observed: 2600
      }
    ]
  },
  {
    id: 'resists',
    title: 'Resists',
    subtitle: 'A spell you cast was fully resisted.',
    verified: true,
    defs: [
      {
        // The FIRST-CLASS `resist` event, not a regex: the parser already separates the three
        // resist shapes and sets caster='you' for your own (Task #51 v2). `where:{caster:'you'}`
        // therefore excludes your pet's resists and every mob-vs-mob resist in the zone.
        // COOLDOWN 5s: a mez chain eats 2-3 resists back to back; 5s is one nudge per attempt
        // cycle rather than one per resist.
        id: 'group:resists:yours',
        name: 'Your spell was resisted',
        trigger: { type: 'event', kind: 'resist', where: { caster: 'you' } },
        soundId: SOUND.resisted,
        cooldownMs: 5000,
        line: '<target> resisted your <Spell>!',
        observed: 1779
      }
    ]
  },
  {
    id: 'charm',
    title: 'Charm break',
    subtitle: 'Your charmed pet is loose.',
    verified: true,
    defs: [
      {
        // Deliberately the SEEDED id: a user who already has the built-in charm-break alert
        // sees this group as already created instead of getting a duplicate.
        // COOLDOWN 3s: one event per break; the window only collapses a double-log.
        id: 'charm-break',
        name: 'Charm break',
        trigger: { type: 'event', kind: 'uncharm' },
        soundId: SOUND.charmBreak,
        cooldownMs: 3000,
        line: 'Your Allure spell has worn off of <mob>.',
        observed: 379
      }
    ]
  },
  {
    id: 'cc',
    title: 'Mez / root broke',
    subtitle: 'A mob you had mezzed or rooted is free again.',
    verified: true,
    defs: [
      {
        // The parser routes a CC spell's "worn off of <mob>" to `cc` with refresh:true (charm
        // goes to uncharm; anything else to buffFade), so this fires for mez/root ONLY.
        //
        // HONEST LIMIT: the log prints the SAME sentence whether the mez ran its full duration
        // or was broken early by damage. There is no "early break" line — so this alert is
        // "it broke", never "it broke early", and it is named that way.
        // COOLDOWN 3s: several mobs can break in the same tick; 3s makes that one alert.
        id: 'group:cc:broke',
        name: 'Mez / root broke',
        trigger: { type: 'event', kind: 'cc', where: { refresh: 'true' } },
        soundId: SOUND.ccBreak,
        cooldownMs: 3000,
        line: 'Your Mesmerization spell has worn off of <mob>.',
        observed: 1738
      }
    ]
  },
  {
    // THE SLOW EXPIRING IS THE MEZ BREAK'S QUIET COUSIN (JOS-69). A mez break is loud — the mob
    // is on you the same second. A slow just... stops, and the first evidence is the tank's
    // health bar. Both sides of it are here for the reason Task #47 gave for the wears-off
    // suggestion template ("the wears off for you is different than for somebody else … build
    // good sane defaults that help with both by default"), and both were measured.
    id: 'slow',
    title: 'Slow wore off',
    subtitle: 'A mob you slowed is swinging at full speed again.',
    verified: true,
    defs: [
      {
        // THE MOB SIDE. `Your <Slow> spell has worn off of <mob>.` is the universal named-target
        // wear-off sentence, and the parser routes it by SPELL: a charm spell there is an
        // `uncharm`, a mez/root spell is a `cc` refresh, and anything else — a slow included —
        // is a `buffFade { spell, target }` (log/parseCasts.ts classifyWornOff). So the event
        // kind cannot discriminate a slow on its own and the SPELL NAME is the whole matcher,
        // which is why it is the family regex above rather than one name.
        //
        // This sentence NAMES the spell and carries no candidate list, so it is the one side that
        // can safely hold the two bard binding songs JOS-233 ruled in — see the roster header.
        //
        // COOLDOWN 5s: one wear-off per slow, and a pull rarely holds two slowed mobs whose
        // timers land together. 5s only ever collapses a genuine double.
        id: 'group:slow:mob',
        name: 'Slow wore off a mob',
        trigger: { type: 'event', kind: 'buffFade', where: { spell: SLOW_SPELLS_MOB } },
        soundId: SOUND.slowExpired,
        cooldownMs: 5000,
        line: 'Your Shiftless Deeds spell has worn off of King Tranix.',
        observed: 26,
        line2: 'Your Languid Pace spell has worn off of a froglok ton knight.',
        observed2: 23,
        note:
          'Fires for any player-castable attack slow - the enchanter line (Languid Pace, Tepid ' +
          'Deeds, Shiftless Deeds, Forlorn Deeds) and the shaman line (Drowsy, Walking Sleep, ' +
          "Tagar's, Togor's, Turgur's, Tigir's) - so it keeps working when you out-level the " +
          'one you cast today. Tepid Deeds accounts for 3 more wear-offs in the reference log. ' +
          "The bard's binding songs count too (Largo's Melodic Binding and its level 51 upgrade " +
          "Largo's Assonant Binding), because they slow the mob's swings as well as its feet."
      },
      {
        // THE ON-YOU SIDE, and it is a SHARED MESSAGE (world-model law 3), so the trigger is
        // built to be right about the FAMILY rather than about which spell it was. The two self
        // sentences are `Your speed returns.` (21 in the reference log) and `You feel less
        // drowsy.` (62) and neither names a spell — the parser resolves each against the DB and
        // emits `buffWearOff { spell, candidates, target:'self' }` where `spell` is only the
        // FIRST candidate. That would be a coin flip for a def that cared which one it was.
        // It does not: every candidate of both messages is a slow (`Your speed returns.` →
        // Forlorn/Shiftless/Tepid Deeds; `You feel less drowsy.` → the six insect/sleep spells),
        // so whichever name the resolver picked, "a slow on you expired" is true.
        //
        // THE HASTE TWIN IS THE TRIPWIRE and it is one word apart: `Your speed returns to
        // normal.` resolves to nine HASTES (Alacrity, Celerity, Swift Like The Wind …) and must
        // never fire this. The roster regex is anchored `^…$`, which is what keeps them apart —
        // pinned in tests/slowMoteTellAlerts.test.mts.
        //
        // …and THAT is why this side reads the SELF roster, which is the emote-derived ten and
        // NOT the two bard binding songs JOS-233 added to the mob side: their self sentence
        // (`The strands fade away.`) is shared verbatim with a beneficial bard buff, so no
        // candidate list here could tell a slow expiring from a buff expiring.
        //
        // COOLDOWN 5s, same episode length as the mob side.
        id: 'group:slow:you',
        name: 'Slow wore off you',
        trigger: {
          type: 'event',
          kind: 'buffWearOff',
          where: { spell: SLOW_SPELLS_SELF, target: 'self' }
        },
        soundId: SOUND.slowExpired,
        cooldownMs: 5000,
        line: 'Your speed returns.',
        observed: 21,
        line2: 'You feel less drowsy.',
        observed2: 62,
        note:
          'Both sentences are shared by a whole slow family and name no spell, so this alert ' +
          'reports that a slow expired, never which one. The haste line "Your speed returns to ' +
          'normal." is deliberately not included.'
      }
    ]
  },
  {
    id: 'invis',
    title: 'Invisibility dropping',
    subtitle: 'You are becoming visible.',
    verified: true,
    defs: [
      {
        // ONE def over an 'any' composite of the two real lines rather than two defs: they fire
        // ~1s apart on the same drop (the warning, then the fact), and two defs would mean two
        // sounds for one event. Composite cooldown is alert-level (Task #47), so 5s collapses
        // the pair into a single alert.
        id: 'group:invis:drop',
        name: 'Invisibility dropping',
        trigger: {
          type: 'any',
          conditions: [
            { type: 'raw', regex: '\\] You feel yourself starting to appear\\.$' },
            { type: 'raw', regex: '\\] You become visible\\.$' }
          ]
        },
        soundId: SOUND.invisDrop,
        cooldownMs: 5000,
        line: 'You feel yourself starting to appear. / You become visible.',
        observed: 241
      }
    ]
  },
  {
    id: 'castFail',
    title: 'Cast failed',
    subtitle: 'A spell you started never went off.',
    verified: true,
    defs: [
      {
        // COOLDOWN 4s: fizzles come in streaks of 3-5 on a low skill; 4s reports the streak once.
        id: 'group:castFail:fizzle',
        name: 'Fizzle',
        trigger: { type: 'event', kind: 'castFizzle' },
        soundId: SOUND.castFailed,
        cooldownMs: 4000,
        line: 'Your Chaotic Feedback spell fizzles!',
        observed: 535
      },
      {
        // The other half of a dead cast — moved, stunned, or bashed mid-cast.
        id: 'group:castFail:interrupted',
        name: 'Cast interrupted',
        trigger: { type: 'event', kind: 'castInterrupted' },
        soundId: SOUND.castFailed,
        cooldownMs: 4000,
        line: 'Your Invisibility spell is interrupted.',
        observed: 979
      },
      {
        // A spell that was BLOCKED by a stronger/incompatible effect already on the target —
        // it consumed the cast and did nothing, which is easy to miss mid-fight.
        // Not anchored at the end: the line carries a trailing "(Blocked by X.)" clause.
        id: 'group:castFail:blocked',
        name: 'Spell did not take hold',
        trigger: { type: 'raw', regex: '\\] Your .+ spell did not take hold' },
        soundId: SOUND.spellBlocked,
        cooldownMs: 5000,
        line: 'Your Arch Shielding spell did not take hold. (Blocked by Talisman of Altuna.)',
        observed: 88
      }
    ]
  },
  {
    id: 'mana',
    title: 'Out of mana',
    subtitle: 'The cast never started - not enough mana.',
    verified: true,
    defs: [
      {
        // COOLDOWN 6s: this is a key-mash line (529 occurrences, always in clusters of 2-5).
        id: 'group:mana:insufficient',
        name: 'Not enough mana',
        trigger: rawLine('Insufficient Mana to cast this spell!'),
        soundId: SOUND.outOfMana,
        cooldownMs: 6000,
        line: 'Insufficient Mana to cast this spell!',
        observed: 529
      }
    ]
  },
  {
    id: 'death',
    title: 'You died',
    subtitle: 'Your corpse and your buffs are gone.',
    verified: true,
    defs: [
      {
        id: 'group:death:you',
        name: 'You died',
        trigger: { type: 'event', kind: 'playerDeath' },
        soundId: SOUND.playerDeath,
        cooldownMs: 5000,
        line: 'You have been slain by a magician!',
        observed: 21
      }
    ]
  },
  {
    // ON-YOU VARIANT: DELIBERATELY ABSENT. Weakening Strike's msgCastOnYou is
    // `Your limbs slow down!` (spells.json), but a full-log sweep of
    // eqlog_Primitive_freeport.txt (1,211,830 lines, 2026-08-03) finds it ZERO times, so
    // there is no fixture line to quote and no `observed` count to state — this file's law
    // forbids shipping it. It would also NOT be a `poisonProc`: that line's last word is
    // "down!", which is in no proc suffix, so the parser cascade falls through the poison
    // branch to the DB cast-on-you table and emits `buffApply { spell:'Weakening Strike' }`
    // (pinned in tests/poisonSlowAlerts.test.mts, so if the line ever appears, the shape it
    // needs is already measured rather than guessed).
    id: POISON_SLOW_GROUP_ID,
    title: 'Rogue slow poisons',
    subtitle: 'A mob in your fight just got slowed.',
    verified: true,
    defs: [
      {
        // ONE PROC, ONE FAMILY. This def fires on WEAKENING STRIKE and on nothing else:
        //   Weakening Strike  → `<mob>'s limbs move slower!`  effect 'slow'  (attack slow)
        // "Poisons", plural, in the group's title is the family of COATS behind that single
        // emote, not a second emote: four utility poisons grant Weakening Strike — Weakening,
        // Binding, Neurotoxic and Paralytic (the roster in shared/poisons.ts) — so a landing
        // proves "a rogue slow proc", never which coat threw it.
        //
        // CLUMSINESS STRIKE IS DELIBERATELY OUT, and that is a decision rather than an
        // oversight. It prints `<mob>'s fingers slow down.` and carries effect 'spellSlow' —
        // a CASTING slow, a different fact about the fight than "the thing hitting me now
        // swings slower". Between 2026-08-04 and this commit the trigger was widened to
        // `/^(slow|spellSlow)$/` so it covered both; the owner rejected the widening the same
        // day — "i dont want the spell cast time slow to count. one proc, one family" — so the
        // shipped trigger is `effect:'slow'` again, and a user who took the widened def is
        // carried back by step 2 of src/main/data/alertDefMigrations.ts. Nothing about the
        // PARSE changed: both Strikes are still first-class `poisonProc` events and both are
        // still counted on the Procs tab. This is a choice about which landing is worth
        // interrupting you for, never about what the log can say.
        //
        // `observed` is a read-only sweep of eqlog_Primitive_freeport.txt at 1,330,626 lines
        // (2026-08-04): 800 `limbs move slower!`. The 482 the first count stated was the same
        // shape against the younger 1,144,036-line log — the live log grows, so a count is a
        // provenance stamp, never a threshold.
        //
        // The Strike prints no cast line, so the parser's first-class `poisonProc` event is
        // the only honest handle on it; matching on `effect` (not on the Strike name) keeps
        // the def right for an emote that a PAIR of Strikes could come to share, and survives
        // a Strike being renamed.
        //
        // NO PERCENTAGE APPEARS ANYWHERE IN THIS COPY, deliberately: the wiki states both
        // 35% and 15% for this line on different pages and the contradiction is unresolved.
        // The DURATION is safe — spells.json has 210000 ms for Weakening Strike — so that is
        // what the note says.
        //
        // COOLDOWN 30s PER MOB (`cooldownScope: 'target'`). The proc RE-LANDS on a mob that is
        // already slowed several times a pull — the reference window
        // (tests/fixtures/w41-poison-asp-venom.log) lands four on Stonesoul the Unmoving
        // inside 44 s — so a rate limit is required. But under ONE clock for the whole alert
        // a re-land on the mob you are already fighting silences the first slow on the mob you
        // pull NEXT, which is the only landing that carries information. Measured in the
        // owner's log 2026-08-04 (tests/fixtures/w44-poison-slow-per-mob.log): a slow on King
        // Tranix at 22:31:16 muted the fire giant warrior's first slow 27 s later, and the
        // player died at 22:33:40. Per-mob scope makes the first slow on a fresh mob
        // unconditional and quiets only the re-lands on that same mob.
        id: POISON_SLOW_ALERT_ID,
        name: 'Mob slowed (rogue poison)',
        trigger: { type: 'event', kind: 'poisonProc', where: { effect: 'slow' } },
        soundId: SOUND.debuffLanded,
        cooldownMs: 30000,
        cooldownScope: 'target',
        line: "Stonesoul the Unmoving's limbs move slower!",
        observed: 800,
        note:
          'Weakening Strike - the attack slow (3:30) granted by Weakening, Binding, Neurotoxic ' +
          'and Paralytic poison. Clumsiness Strike, the casting slow, is deliberately not ' +
          'included. Each mob gets its own 30-second quiet period: the first slow on a mob ' +
          'always speaks, and only re-lands on that same mob are held back.'
      }
    ]
  },
  {
    // A LOOT FILTER, IN THE PATH OF EXILE SENSE (JOS-69): the drop that is worth looking up from
    // the fight for gets a sound of its own, and everything else stays silent. In this game that
    // drop is a MOTE — the Item Upgrade System's currency, the thing an Exaltations plan is
    // actually gated on — and it arrives inside an ordinary loot line with nothing to mark it.
    id: 'motes',
    title: 'Mote dropped',
    subtitle: 'An upgrade mote just went into your bags.',
    verified: true,
    defs: [
      {
        // A PARSED EVENT, NOT A RAW REGEX — and that overturns the shape this was briefed as.
        // The dashed loot family is already first-class: `--You have looted <item> from <mob>'s
        // corpse.--` parses to `loot { item, source }` (log/parseWorld.ts), so the def matches
        // the ITEM FIELD and inherits the parse instead of re-deriving it. That is this file's
        // standing rule ("parsed events over raw regexes"), and here it also buys real safety: a
        // raw regex over the whole line would fire on the four chat lines in the reference log
        // in which players discuss motes, because a raw trigger sees text and knows nothing
        // about who is speaking.
        //
        // THE MATCHER IS THE ITEM FAMILY, ANCHORED. Every mote the committed items catalog knows
        // is `Mote of <tier> Potential` (10 entries: Infinitesimal, Minor, Lesser, Potential,
        // Major, Greater, Superior, Grand, Ascendant, Infinite) and the reference log printed
        // seven of them — Infinitesimal 220, Minor 31, Lesser 16, Major 8, Potential 7, Greater
        // 2, Superior 1, for 285 loot lines. `^Mote of ` covers the three the log has not shown
        // as well, which is the whole reason to anchor a family rather than list the tiers.
        //
        // NO PER-TIER SPLIT, deliberately. A real loot filter is loudest for the rarest drop,
        // and the tier ORDER is exactly what nothing states: neither the items catalog nor the
        // log ranks these names, and "Mote of Potential" sits at an unknown rung among the
        // adjectives. Ranking them by eye to pick which gets the better sound would be an
        // invented fact (the awaiting-sample law); one sound for the family is what the evidence
        // supports today.
        //
        // ONE KNOWN OVER-REACH, stated rather than papered over: the loot family also covers the
        // vendor shape (`You looted <item> … and sold it for <money>.`), which emits the same
        // `loot` event, so vendoring motes would speak. A `where` cannot express "and no
        // disposition" (an absent field fails every matcher), and the reference log contains
        // zero sold motes — nobody sells the upgrade currency. The 4s cooldown bounds it if
        // somebody does.
        //
        // COOLDOWN 4s: motes drop one per corpse and no two share a second anywhere in the
        // reference log, so this is a bound on a bag-clearing burst, not on normal play.
        id: 'group:motes:looted',
        name: 'Mote dropped',
        trigger: { type: 'event', kind: 'loot', where: { item: '/^Mote of /' } },
        soundId: SOUND.moteLooted,
        cooldownMs: 4000,
        line: "--You have looted a Mote of Infinitesimal Potential from a zol ghoul knight's corpse.--",
        observed: 285,
        note:
          'Every tier of Mote of Potential, from Infinitesimal to Ascendant - the currency the ' +
          'Item Upgrade System runs on. All tiers share one sound: nothing in the game or the ' +
          'catalog states which tier outranks which.'
      }
    ]
  },
  {
    // A PLAYER IS TALKING TO YOU AND THE GAME SAYS SO ONCE, in a chat window you are not looking
    // at because a mob is on you (JOS-69).
    id: 'tells',
    title: 'Tell received',
    subtitle: 'Another player sent you a private message.',
    verified: true,
    defs: [
      {
        // A RAW TRIGGER, AND THE BRIEF'S "PARSED TELL EVENT" DOES NOT EXIST. Swept the tree:
        // the parser claims exactly two things out of the tell channel, both spoken by NPCs —
        // the pet-claim tell (`<Name> told you, '… Master.'` → petClaim) and nothing else. A
        // player's tell parses to `unknown`, deliberately: shared/logScrub.ts DROPS every line
        // carrying quoted speech, so a tell can never reach a committed fixture and nothing
        // downstream could ever be golden-tested on one. This file's own rule covers the case —
        // raw regexes are for "lines no event covers" — and the four client notices already
        // ship that way. The unknown event still carries `raw`, which is what a raw trigger
        // tests, so nothing else is needed.
        //
        // THE TENSE IS THE DISCRIMINATOR, AND IT IS MEASURED (whole-log sweep,
        // eqlog_Primitive_freeport.txt, 1,406,311 lines, 2026-08-06):
        //   `<Name> tells you, '…'`   11 lines — every one a real player (ten distinct senders:
        //                             a guild recruiter, a group invite, a thank-you …).
        //   `<Name> told you, '…'`  3537 lines — NOT ONE of them a person: 3050 pet-claim tells
        //                             and the rest a merchant NPC quoting prices ("Klok Sasz
        //                             told you, 'I'll give you 3 platinum for the …'").
        // Present tense is a player; past tense is the game. That is the whole rule, and it is
        // why this pattern is anchored on ` tells you, '` rather than on anything cleverer.
        //
        // CAPITALIZATION IS NOT A SIGNAL, and the brief's other hypothesis — "capitalized proper
        // name ⇒ a player" — is MEASURED WRONG here: the log capitalizes a sentence-initial
        // article, so a charmed pet's tell reads `A gorgon told you, …` and looks exactly as
        // proper as `Shiro tells you, …`. Adding a `[A-Z]` guard would have bought nothing and
        // implied a rule the log does not follow.
        //
        // CHANNELS AND OUTGOING TELLS CANNOT MATCH, because they are different sentences:
        // `X tells General:1, '…'`, `X tells the group, '…'`, `You told X, '…'` and `You tell
        // your party, '…'`. All four are pinned as negatives in the suite.
        //
        // COOLDOWN 6s: a conversation arrives in bursts of two or three lines and one nudge per
        // exchange is the point — you are being told to go and read the window, not to hear
        // every sentence.
        id: 'group:tells:received',
        name: 'Tell received',
        trigger: { type: 'raw', regex: "\\] .+ tells you, '" },
        soundId: SOUND.tellReceived,
        cooldownMs: 6000,
        // The SHAPE, with the message elided — the `resists` def's convention, and here it is
        // also the privacy rule: this string is rendered in the UI and committed to a public
        // repo, and a real tell is someone else's words (shared/logScrub.ts family 1).
        line: "<Player> tells you, '<message>'",
        observed: 11,
        note:
          'Player tells only. NPC and pet tells use the past tense ("told you") and never fire ' +
          'this; neither do channel tells, group chat, or the tells you send.'
      }
    ]
  },
  // ---- NOT OFFERED --------------------------------------------------------------------
  // The refusal register: sets that were asked for and that no real log line can fire. They
  // live in shared/alertGroupsRefused.ts — same list, same `verified:false` contract, kept
  // apart because they are prose rather than triggers (and because this file is at its
  // factoring ceiling). VERIFIED_ALERT_GROUPS filters them out; G4 pins that they stay out.
  ...REFUSED_ALERT_GROUPS
]

/** The groups the surface actually renders — the unverified ones are documentation only. */
export const VERIFIED_ALERT_GROUPS: AlertGroup[] = ALERT_GROUPS.filter((g) => g.verified)

/** Build the concrete AlertDefs a group authors, pointed at `packId`. */
export function alertGroupDefs(group: AlertGroup, packId: string = GROUP_PACK_ID): AlertDef[] {
  return group.defs.map((spec) => {
    const def: AlertDef = {
      id: spec.id,
      name: spec.name,
      enabled: true,
      trigger: spec.trigger,
      sound: { packId, soundId: spec.soundId },
      cooldownMs: spec.cooldownMs,
      note:
        `Suggested group "${group.title}" - fires on: ${spec.line}` +
        (spec.line2 ? ` and: ${spec.line2}` : '') +
        (spec.note ? ` ${spec.note}` : '')
    }
    // Written ONLY when it is not the default, so a group def that never asked for per-target
    // scope serializes byte-identically to how it always did (the same rule the voice fields
    // follow in shareSchema.ts, and what keeps import dedupe stable).
    if (spec.cooldownScope === 'target') def.cooldownScope = 'target'
    return def
  })
}

/**
 * The def(s) the rogue-slow OFFER creates when accepted — the same list the groups panel's
 * "Add" button produces for that group, built from the same catalog entry. Two entry points,
 * one authored def: accepting the offer and clicking the group card are interchangeable, and
 * doing both is a no-op (the store upserts by id).
 */
export function poisonSlowAlertDefs(packId: string = GROUP_PACK_ID): AlertDef[] {
  const group = ALERT_GROUPS.find((g) => g.id === POISON_SLOW_GROUP_ID)
  return group ? alertGroupDefs(group, packId) : []
}

/** Every def id a group would create (for the created/partially-created chip state). */
export function alertGroupDefIds(group: AlertGroup): string[] {
  return group.defs.map((d) => d.id)
}
