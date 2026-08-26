// ============================================================================
// alertsAudioRules.ts — THE AUDIO CUTOVER'S DECISIONS, WITH NO WORLD ATTACHED (JOS-491).
// ============================================================================
//
// `alertsAudio.ts` is the world: the two environment flags, the store read, the alerts module, the
// dev log. This is everything it has to DECIDE, split out for `readShim.ts`'s reason exactly — the
// decisions are the part that can be wrong in a way nobody notices, and a pure file is the only
// kind a `node:test` process can load at all (the wired half imports `pipeline.ts`, which imports
// Electron). Three functions, no state, no clock, no I/O.

import type { FireMessage } from '../../shared/dataServer/protocol.generated'
import type { AlertDef, FiredAlert } from '../../shared/types'

/**
 * Whether the cutover arms, and the ONE line the dev log gets either way.
 *
 * IT IS STILL A VERDICT AND NOT A BOOLEAN, AFTER THE GATE STOPPED REFUSING ANYTHING (JOS-492 — see
 * `armVerdict`). The shape survives because the LINE is the reason it existed: a silent evaluator
 * with nothing in the log explaining itself is a state a developer cannot tell apart from a flag
 * nobody set, and that was true before there was a refusal to explain and is true after.
 */
export interface ArmVerdict {
  readonly arm: boolean
  /** Present tense, no prefix — `alertsAudio.ts` adds the app's own tag. Never empty: a refusal
   *  that said nothing would be indistinguishable from a flag nobody set. */
  readonly line: string
}

/**
 * ARM. UNCONDITIONALLY, SINCE JOS-492 — AND THE DELETED REFUSAL IS WHY THIS COMMENT IS LONG.
 *
 * ── WHAT THIS GATE WAS FOR ─────────────────────────────────────────────────────────────────────
 *
 * A def carrying `earlyWarnSec` does not sound when its trigger matches: the match ARMS a warning
 * that speaks N seconds before a timer row's estimated end (JOS-216). That needs a wall-clock
 * heartbeat AND the buffs/buffTimers projection, and JOS-482's engine had neither — so it COMPILED
 * SUCH A DEF OUT rather than firing it at the wrong instant, which was the right call (a sound made
 * a minute early is a wrong answer wearing a right answer's clothes). But it meant that arming the
 * cutover over such a def traded a correctly-delayed sound for NO SOUND AT ALL, silently. So this
 * function refused, and named the def it refused over.
 *
 * ── WHY IT NO LONGER REFUSES ───────────────────────────────────────────────────────────────────
 *
 * Both missing halves landed and the engine now honours the offset end to end
 * (`fold/src/modules/alerts_early.rs`): a landing arms against the timer projection, a break-family
 * def arms from the row appearing (JOS-235), the heartbeat delivers, and the fire that comes out is
 * the same fire this process would have made. The engine reads the offset through the APP'S OWN
 * NORMALIZER (`normalizeEarlyWarnSec`, ported bound for bound), so the one input where the two used
 * to disagree — the out-of-range number the app clamps and the engine used to read as absent —
 * now gives one answer on both sides. There is no def left that the engine "would swallow", and a
 * gate refusing over an emptied category is a gate that only ever produces false alarms.
 *
 * ── AND WHY THERE IS NO REPLACEMENT BLOCKER ────────────────────────────────────────────────────
 *
 * The honest test for a blocker is "a def the ENGINE genuinely cannot honour", and the list of those
 * is now EMPTY — deliberately, and it is worth saying what is NOT on it. An `app` trigger
 * (bossDefeat / questComplete) compiles to a condition that never matches engine-side, exactly as it
 * does here: those are renderer-evaluated on BOTH sides, so the engine swallows nothing. A `/regex/`
 * this build cannot compile degrades identically on both sides (JOS-491 measured the owner's real
 * def set: zero incompatible patterns). What a fire frame cannot CARRY — the JOS-103 captures, the
 * JOS-353 `{target}` token, the JOS-84 resolved spell name, the JOS-378 `dueAt` — costs a firing
 * some of its WORDS and never its existence, which `fireToFiring` states below and which was never
 * this gate's subject.
 *
 * A LIST WITH ONE ENTRY WOULD HAVE BEEN KEPT. It has none, so keeping the machinery would mean
 * keeping a predicate nobody can ever make true, and a dead gate is worse than no gate: the next
 * reader has to prove it is dead before they can trust anything downstream of it.
 *
 * ── AND THE ONE COST IT NAMED IS PAID OFF (JOS-500, ruling 27) ─────────────────────────────────
 *
 * The paragraph above used to end by conceding that a fire frame could not carry the JOS-103
 * captures, the JOS-353 `{target}` token, the JOS-84 resolved spell name or the JOS-378 `dueAt`, and
 * that this "costs a firing some of its WORDS and never its existence". That was true, and it was
 * survivable only for as long as this process still had an evaluator behind it. JOS-499 deleted the
 * evaluator, which turned a documented degradation into the shipped product — and the owner ruled
 * the loss release-gating ("we're not releasing without full parity"). THE FRAME GREW THE FIELDS.
 * `fireToFiring` below copies them across, and the concession is deleted rather than softened.
 */
export function armVerdict(_defs: readonly AlertDef[]): ArmVerdict {
  return {
    arm: true,
    line: 'data-server alerts: the ENGINE now plays alert audio; this process’s evaluator is silent'
  }
}

/**
 * THE FRAME, AS A FIRING — so which def a fire belongs to is a question with a test rather than a
 * behaviour discovered in a raid.
 *
 * A FIRE NAMES ITS RULE BY LABEL, NOT BY ID (`FireMessage.rule` is `AlertDefinition.name`), and the
 * app needs the id: the renderer's player looks the def up by `alertId` to find its volume, its
 * audio channel and its phrase. So the label is resolved back, and the two honest hazards are
 * handled rather than assumed away:
 *
 *   * NOTHING ANSWERS TO IT — a def deleted between the push and the fire. Null, and the caller
 *     says so. Playing "some alert" would be worse than the silence.
 *   * TWO THINGS ANSWER TO IT — nothing stops a user naming two alerts the same. The `sound` key
 *     (`<packId>/<soundId>`, the second fully-resolved field of the frame) narrows first, because
 *     it is a fact the ENGINE stated about the def it fired rather than a guess made here. If that
 *     still does not separate them the FIRST is taken: two defs answering to one name with one
 *     sound would make the same noise, so what is left to get wrong is a volume — and a sound at
 *     the wrong volume beats no sound at all.
 *
 * MATCHING IS EXACT AND CASE-SENSITIVE. The label round-tripped through the engine verbatim (the
 * define pushes the store's own object and the fold republishes it), so any folding here would be
 * this file inventing a tolerance the wire does not need.
 *
 * ── WHAT IT CARRIES, AND WHY THIS FUNCTION DERIVES NONE OF IT (JOS-500, ruling 27) ─────────────
 *
 * The JOS-103 named captures, the JOS-353 `{target}` token, the JOS-84 resolved spell name and the
 * JOS-378 `dueAt` used to be listed here as things a fire frame could not carry, so a `custom`
 * phrase's tokens resolved to nothing and the `spellName` speech modes fell back to the alert's own
 * name. THE FRAME CARRIES THEM NOW and this is a COPY, deliberately — three assignments and not one
 * decision.
 *
 * THAT IS THE WHOLE POINT OF WHERE THE WORK HAPPENS. Every one of these is an EVALUATOR's answer:
 * which candidate satisfied the def's own matcher, which text the condition that matched had
 * actually tested, whether the phrase asked for `{target}` at all, who wins when a declared group
 * and the auto token share a name, and where the 8-value bound falls. Re-deriving any of it here
 * would be a second evaluator wearing the engine's clothes — the same refusal this file has always
 * made, now with something to copy instead of a gap to apologise for. The engine also SANITIZED the
 * captures before putting them on the wire (`fold::modules::alerts_captures`, the engine-side half
 * of shared/alertCaptures.ts's threat model), and `applyCaptures` sanitizes each value AGAIN at
 * substitution time — defense in depth, because the last code between a captured value and a speech
 * engine must not be trusting anybody upstream to have been careful.
 *
 * EACH IS OMITTED RATHER THAN SET TO `undefined`, matching what a main-side firing has always put on
 * the wire: an absent key is the honest encoding of "this firing has nothing true to say here", and
 * it keeps the payload byte-identical for the overwhelming majority of alerts, which carry none of
 * the three.
 */
export function fireToFiring(fire: FireMessage, defs: readonly AlertDef[]): FiredAlert | null {
  const named = defs.filter((d) => d.name === fire.rule)
  if (named.length === 0) return null
  const narrowed =
    named.length === 1
      ? named
      : named.filter((d) => `${d.sound.packId}/${d.sound.soundId}` === fire.sound)
  const def = narrowed[0] ?? named[0]
  // `at` is the LOG's own clock (schema: "never the host's wall clock"), which is exactly what
  // `FiredAlert.ts` has always carried for a main-side fire — so nothing downstream has to know
  // which world timed it. The one exception is an early warning, whose `at` and `dueAt` both come
  // from the engine's heartbeat because there is no line behind it; the retired evaluator stamped
  // that firing from its own clock in the same place, so the number is the one the app always got.
  const firing: FiredAlert = { alertId: def.id, ts: fire.at, matchedText: fire.message }
  // `{ ...fire.captures }` rather than the object itself: the frame is the client's parsed JSON and
  // a firing outlives the dispatch that made it. Copying costs nothing at this size and means no
  // consumer holds a reference into a decoded frame.
  if (fire.captures !== undefined) firing.captures = { ...fire.captures }
  if (fire.spell !== undefined) firing.spell = fire.spell
  if (fire.dueAt !== undefined) firing.dueAt = fire.dueAt
  return firing
}
