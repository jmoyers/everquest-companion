// Offline-gap detection (login/logout in the world model) — the sibling of epochDetector.ts,
// and wired the same way: index.ts subscribes it to the bus AFTER the modules and the combat
// engine have folded each event, and it hands its synthesized `offlineGap` back onto the SAME
// bus via `bus.emitDerived` (the Task #47 derived path). The bus drains derived events after
// the primary one finishes reaching every listener, so consumers see the `sessionStart` line
// first and the gap it implies second. Replay and live are IDENTICAL — nothing here reads the
// wall clock, so a rescan reconstructs every historical gap for free.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MEASUREMENT THAT SHAPES THIS FILE (real log, 1,152,483 lines 2026-08-03; re-measured
// over 1.60M lines and all 45 logins 2026-08-12 for JOS-262).
//
// The obvious rule — "fromTs is the last event before the Welcome" — DOES NOT WORK, and
// fails silently rather than loudly. Every login prints a RECONNECT PREAMBLE *before* the
// `Welcome to EverQuest Legends!` line, because the client is already connected to the chat
// servers while the character is still being placed in the world:
//
//   [Fri Jul 31 01:05:43] It will take you about 30 seconds to prepare your camp.   ← logout
//   [Fri Jul 31 01:06:07] It will take about 5 more seconds to prepare your camp.
//   [Fri Jul 31 14:49:09] You are not currently assigned to an adventure.           ← preamble
//   [Fri Jul 31 14:49:13] Channel General was too full to join
//   [Fri Jul 31 14:49:13] Channels: 1=General1(400)
//   [Fri Jul 31 14:49:15] Welcome to EverQuest Legends!                             ← login
//
// A last-event anchor would have reported that 13h43m absence as SIX SECONDS and would have
// emitted zero gaps, ever.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT USED TO BE A 30-SECOND WINDOW, AND THE WINDOW WAS THE BUG (JOS-262, owner ruling
// 2026-08-12). `fromTs` was the newest event at least RECONNECT_WINDOW_MS older than the
// Welcome, on the measurement that every observed preamble fits inside 22 seconds. A preamble
// is a CLIENT-SIDE duration, though, and the constant made the whole model a hostage to it:
// measured on the running detector, a 31s preamble emits NO GAP AT ALL (the anchor lands on a
// preamble line 31s back, 31s is under the emit floor, and the absence is silently dropped),
// and a sparse 5-minute preamble reports two minutes of a multi-hour absence. The reported
// defect is the user-visible end of it — buffs from the previous session missing at app start
// on a machine that loads the game slowly. Bumping the constant only moves the cliff.
//
// SO THE ANCHOR IS EVIDENCE, NOT A WINDOW. `fromTs` is the newest event that could ONLY have
// been printed because THIS CHARACTER WAS IN THE WORLD — see {@link inWorldEvidence}, which is
// the whole rule and states line by line what qualifies. Preamble length stops mattering
// because nothing in a preamble qualifies: the burst is channel/adventure noise (all
// `unknown`) plus, MEASURED, other players' combat.
//
// THE THIRD-PARTY HALF IS NOT A DETAIL — it is what makes "non-unknown" too weak a test.
// Measured 2026-08-12 on the real log, the Aug 07 20:32:35 login (a 58m48s absence) prints
//
//   [Fri Aug 07 20:32:33] A swirlspine seahorse has been slain by Dyson!
//   [Fri Aug 07 20:32:33] A seahorse patriarch has been slain by Madoxide!
//   [Fri Aug 07 20:32:35] Welcome to EverQuest Legends!
//
// — two fully typed `death` events TWO SECONDS before the Welcome, because the client is
// already receiving zone chatter while the character is being placed. Anchoring on "the newest
// typed event" would have read that 58-minute absence as two seconds and emitted nothing.
// Somebody else's kill is evidence that the CLIENT is connected; only a line about YOU is
// evidence that YOUR CHARACTER is in the world.
//
// THE COST, stated rather than papered over — the direction is unchanged and the size is not.
// `fromTs` is a LOWER bound on the last instant the character is KNOWN to be in the world, so
// the reported gap never UNDER-states the absence and can OVER-state it by the length of the
// trailing run of lines that name nobody. That run used to be capped at 30s by construction;
// it is now whatever the log happens to hold. Two measurements bracket it:
//
//   • the ordinary case is the CAMP COUNTDOWN — the five `It will take about N more seconds…`
//     ticks are deliberately `unknown` (parseSession.ts), so the anchor is the campStart line
//     they restate and the gap runs 24s long. 24s on 13 of the 45 logins, 0s on 11 more.
//   • the worst case is an AFK PARK: Aug 08 15:46:49 → 16:42:29 is 56 minutes in which the
//     only lines are NPC shouts and other players' fights, and the gap over-states by all of
//     it. Two logins in 45 do this (56 and 37 minutes).
//
// Nothing downstream may treat the number as exact — see the mining censor in
// buffsInstances.ts, which drops (rather than adjusts) any duration sample that spans a gap
// precisely because of this. The over-statement is self-limiting for the model that consumes
// it: a buff that expires during such a run prints its own wears-off line, which IS evidence
// and re-anchors the whole calculation.
//
// VERIFICATION against all 45 real logins (2026-08-12): every gap the old rule emitted is
// still emitted, every one it suppressed is still suppressed (26s / 34s / 50s / 58s of
// measured absence against the 60s floor — the four genuine sub-minute relogs), and no
// preamble anywhere in the log contributes to an anchor.

import type { LogEvent, OfflineGapEvent } from '../../shared/logEvents'
import { idKey } from './parser'

/**
 * Minimum absence worth reporting. Below this a relog is a BLIP, not an absence: nothing in
 * the world model changes meaningfully across a minute, and the 4 sub-minute relogs in the
 * real log (30–34s of measured gap) are exactly the noise this suppresses.
 */
export const OFFLINE_GAP_MIN_MS = 60_000

/**
 * How close a non-aborted `campStart` must sit to `fromTs` for the logout to count as CAMPED.
 * A camp takes ~30s (the initiation line says so and five ticks count it down), so the two
 * describe the same logout when they are a camp's length apart; 60s is the comfortable read.
 *
 * THE PAIRING GOT STRICTLY MORE RELIABLE WITH THE ANCHOR CHANGE (JOS-262), and the reason is
 * worth stating: `campStart` is itself in-world evidence, so it can never be older than
 * `fromTs` by more than the in-world lines that follow it. The countdown ticks are `unknown`,
 * so in the ordinary camp the two are THE SAME INSTANT and the window is not even exercised.
 */
export const CAMP_PAIRING_MS = 60_000

/** The canonical key the log writes for the tailed character in every name position. */
const YOU = 'you'

/** True when `name` is the tailed character (`You`, `YOU`, `your`… all canonicalize here). */
function isYou(name: string | null | undefined): boolean {
  return name != null && idKey(name) === YOU
}

/**
 * THE ANCHOR RULE (JOS-262): can this line ONLY have been printed because the tailed character
 * was standing in the world?
 *
 * It is a stricter question than "did the parser type this line", and the module header has the
 * measurement that forced the distinction: other players' combat arrives in the reconnect
 * preamble, seconds before the Welcome, because the client receives zone chatter while the
 * character is still being placed. A stranger's kill proves the CLIENT is connected. Only a
 * line about YOU proves the CHARACTER is in the world.
 *
 * Three groups, and the split is the whole rule:
 *
 *   • FIRST-PERSON FAMILIES — the log has no third-person grammar for them at all, so the
 *     sentence can only be about the tailed character (`You gain experience!`, `You begin
 *     casting …`, `You have become better at …!`, `Your <spell> spell has worn off …`, the camp
 *     lines, the acquisition families, the AA families, /consider, /outputfile, the self `/who`
 *     row, stance and invocation, the item families). A `sessionStart` is here too: the Welcome
 *     is the strongest statement in the whole log that the character is in the world.
 *   • NAMED FAMILIES — the shape exists for everyone, so the event's own fields decide. A swing,
 *     a miss, a heal, a resist or a landing emote counts only when it NAMES you; a death counts
 *     only in the `You have slain …` form.
 *   • EVERYTHING ELSE — chat and system noise (`unknown`), broadcasts that name no caster
 *     (`charm`, `cc`, `ccWake`, `poisonProc`, `spellEmote` on somebody else), another player's
 *     cast, another player's pet. None of them says anything about where YOU are.
 *
 * The refusals cost precision, never correctness: a refused line only leaves the anchor where
 * the previous accepted one put it, and the anchor is documented as a lower bound.
 */
export function inWorldEvidence(ev: LogEvent): boolean {
  return FIRST_PERSON_KINDS.has(ev.kind) || combatNamesYou(ev) || selfFormOf(ev)
}

/**
 * The FIRST-PERSON families: the log prints no third-person twin of any of these, so the
 * sentence can only be about the tailed character. `petClaim` is here because both of its
 * shapes name YOU (`<Name> told you, '… Master.'` and `<Name> says, 'My leader is <You>.'`);
 * the ally form has been its own kind since JOS-250 and is deliberately absent.
 *
 * `loot` covers the DESTROY line too since JOS-401 (`You successfully destroyed …` is a loot
 * event with disposition 'destroyed'), and it belongs on this list for the identical reason every
 * other loot line does: the game prints it for nobody but the character that typed it. The kind is
 * what this predicate asks about, so the addition needed no change here — this note is the census
 * saying so rather than leaving it to be re-derived.
 *
 * Everything NOT listed here and not handled by the two predicates below is refused, which
 * includes every broadcast that names no caster (`charm`, `cc`, `ccWake`, `poisonProc`,
 * `poisonCoat`), another player's cast (`otherCastBegin`), another player's pet
 * (`allyPetLeader`, `petSay`), and all of `unknown`.
 */
const FIRST_PERSON_KINDS = new Set<LogEvent['kind']>([
  'sessionStart',
  'zone',
  'loot',
  'coin',
  'itemReceived',
  'purchase',
  'offer',
  'trade',
  'level',
  'expGain',
  'aaGain',
  'aaSpend',
  'aaPotion',
  'aaActivate',
  'castBegin',
  'castFizzle',
  'castInterrupted',
  'castResumed',
  'buffFade',
  'buffWearOff',
  'illusionFade',
  'playerDeath',
  'healUnstated',
  'mitigation',
  'campStart',
  'campAbort',
  'outputFile',
  'selfWho',
  'skillUp',
  'specialAttack',
  'classUnlock',
  'itemActivate',
  'itemMerge',
  'itemMergeFailed',
  'consider',
  'stanceChange',
  'invocationChange',
  'petClaim'
])

/** The combat families, which exist for everyone: only a line that NAMES you is evidence. */
function combatNamesYou(ev: LogEvent): boolean {
  switch (ev.kind) {
    case 'damage':
    case 'miss':
      return isYou(ev.attacker) || isYou(ev.target)
    case 'heal':
      return isYou(ev.healer) || isYou(ev.target)
    case 'resist':
      // The incoming form (`You resist <mob>'s <Spell>!`) names you as the resister.
      return ev.incoming || isYou(ev.caster) || isYou(ev.target)
    case 'death':
      // `You have slain <X>!`. The other two shapes are somebody else's kill (or nobody's).
      return ev.bySelf
    default:
      return false
  }
}

/** Families with a SELF form and a broadcast form; only the self form is about you. */
function selfFormOf(ev: LogEvent): boolean {
  switch (ev.kind) {
    case 'buffApply':
      // A `msg_cast_on_you` match. A named target is the third-person broadcast, which every
      // player in earshot receives — including one who is not in the world yet.
      return ev.target === 'self'
    case 'spellEmote':
      return ev.subject === 'self'
    case 'group':
      // `You have joined the group.` / `You have left the group.` — `name` is absent for
      // exactly the two self shapes (see GroupEvent).
      return ev.change === 'selfJoin' || ev.change === 'selfLeave'
    default:
      return false
  }
}

/**
 * Stateful, single-character offline-gap detector. Feed it every LogEvent in stream order;
 * a `sessionStart` returns the `OfflineGapEvent` to emit, or null when the absence was too
 * short to be worth reporting (or when this is the first login of the log, which has no
 * observed "before"). Reset per character (re)load, exactly like EpochDetector.
 */
export class SessionDetector {
  /**
   * THE ANCHOR: the newest instant the character is KNOWN to have been in the world, or 0
   * before the first such line. One number, advanced by {@link inWorldEvidence} and by nothing
   * else — the rolling 30s window this replaced (JOS-262) is gone along with the preamble
   * length it made the model sensitive to.
   */
  private evidenceTs = 0

  /** ts of the most recent `campStart` that has not been abandoned, or 0. */
  private campTs = 0

  reset(): void {
    this.evidenceTs = 0
    this.campTs = 0
  }

  /**
   * Observe one event. Returns an `OfflineGapEvent` to emit at a `sessionStart` whose implied
   * absence exceeds {@link OFFLINE_GAP_MIN_MS}, else null.
   *
   * The derived events of OTHER producers are ignored: an `offlineGap` is our own output (a
   * feedback loop), and an `epoch` / `buffExpired` is a synthesized restatement of a primary
   * event whose timestamp we have already recorded — folding them would double-count nothing
   * but is still a second opinion on "when was the character last seen".
   */
  observe(ev: LogEvent): OfflineGapEvent | null {
    if (ev.kind === 'offlineGap' || ev.kind === 'epoch' || ev.kind === 'buffExpired') return null
    // An unparseable timestamp (0) can neither anchor a gap nor advance the anchor.
    if (ev.ts <= 0) return null

    if (ev.kind === 'campStart') this.campTs = ev.ts
    // The game states the cancellation outright (law 1) — an abandoned camp is not a logout.
    if (ev.kind === 'campAbort') this.campTs = 0

    // The gap is built BEFORE the Welcome advances the anchor — it is measured against the
    // previous session, and it is also the login that ends the absence.
    const gap = ev.kind === 'sessionStart' ? this.buildGap(ev.ts, ev.seq, ev.raw) : null
    if (inWorldEvidence(ev)) this.evidenceTs = ev.ts
    return gap
  }

  /**
   * Build the gap implied by a login at `toTs`, or null when there is nothing to report.
   *
   * Returns null when the log has shown no in-world evidence yet — the first login in a
   * freshly-started log has no observed "before", and inventing one out of the preamble is
   * exactly the mistake this file exists to avoid.
   */
  private buildGap(toTs: number, seq: number, raw: string): OfflineGapEvent | null {
    const fromTs = this.evidenceTs
    if (fromTs <= 0) return null
    if (toTs - fromTs <= OFFLINE_GAP_MIN_MS) return null
    const camped = this.campTs > 0 && Math.abs(fromTs - this.campTs) <= CAMP_PAIRING_MS
    return { kind: 'offlineGap', seq, ts: toTs, raw, fromTs, toTs, camped }
  }
}
