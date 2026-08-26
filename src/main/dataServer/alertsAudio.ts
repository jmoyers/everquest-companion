// ============================================================================
// alertsAudio.ts — THE ALERTS AUDIO CUTOVER, WIRED (JOS-491, phase 3).
// ============================================================================
//
// Owner ruling 9 says speech and audio stay app-side; owner ruling 22 says the ENGINE is what
// evaluates the user's alert definitions. Together they leave the app one job — RECEIVE FIRE,
// MAKE SOUND — and JOS-482 built everything but the last inch of it: the defs are pushed, the
// engine matches them against live events, and `engineClientHost.ts` has been logging the frames
// without playing them because this process's own evaluator was still the thing making noise.
// This file is that last inch. `alertsAudioRules.ts` holds the decisions; this holds the world —
// the flags, the store read, the alerts module, the dev log.
//
// ── THE THIRD FLAG, AND WHAT IT IS FOR NOW (JOS-495) ───────────────────────────────────────────
//
// THE ENGINE MAKES THE SOUND BY DEFAULT. `EQC_ENGINE_ALERTS=0` gives it back to this process's own
// evaluator and changes nothing else — the engine still folds, still serves the reads, still gets
// the defs pushed to it and still matches them; it simply stops being the thing whose match plays.
// Unset, which is every ordinary launch, means the ENGINE fires.
//
// IT WAS A THIRD FLAG BECAUSE A SOUND IS NOT A READ, and that argument is untouched by the flip —
// it is why this gate still exists at all rather than folding into the serve flag. A wrong read
// draws a wrong number on a panel somebody is looking at; a wrong fire interrupts a raid, and a
// MISSING one is worse and invisible. The owner is the regression test for this whole program and
// the thing being risked is the evidence itself. What changed is who has to act: the default now
// carries the risk (the owner ruled that the engine IS the product, and it earned that on his own
// hands-on runs and on `engine-alert-fires.e2e.mts` driving one live line to exactly one sound), and
// the flag is how a silence gets bisected in one launch — set it to `0`, and if the alert comes
// back the fault is downstream of the match rather than in it.
//
// IT IS STILL MEANINGLESS ALONE for `serveShim.ts`'s reason and by the same construction:
// `armEngineAlerts` is reached only from inside `engineHost.ts`'s own `engineEnabled()` guard, so
// `EQC_ENGINE=0` silences the engine's fires structurally, and the serve flag is read below — a
// launch not being SERVED is a launch whose reads come from the app's own fold, and letting the
// engine fire into it would mean two worlds sharing one alert lane.
//
// ── THE SINGLE-AUDIO GUARANTEE, STRUCTURALLY ───────────────────────────────────────────────────
//
// Exactly one thing may publish a firing, and arming swaps which one it is. `AlertsModule.publish`
// becomes a no-op (`setEngineOwnsAudio`) and `AlertsModule.engineFired` starts being called — one
// switch, both halves, in one statement pair, so there is no window in which both or neither is
// live. Everything downstream is untouched: the frame becomes a `FiredAlert` on the alerts delta,
// the renderer's always-mounted player plays it through the same `playAlertNow`, the recent-fires
// ring records it and `pipeline.ts feedAlertDelta` folds it into an event-feed row. NO SECOND AUDIO
// PATH EXISTS, which is the point — an app that could play a fire two ways eventually would.
//
// ── THE VERDICT IS TAKEN ONCE, AT ARM TIME ─────────────────────────────────────────────────────
//
// …and that is a decision rather than an omission. The flag is an environment variable, which is
// already a restart-shaped thing; a gate that re-opened mid-session would mean the app could start
// playing from the engine halfway through a raid because a def was deleted, which is a worse
// surprise than "set it and relaunch". A def edited to carry an early warning while an armed launch
// runs is therefore a def whose warning still speaks from this process until the next launch —
// the engine honours `earlyWarnSec` end to end since JOS-492 (the timer projection evaluates it
// at the engine's own heartbeat), so on relaunch the engine's evaluator carries it.

import { logInfo } from '../errorLog'
import { IPC } from '../../shared/ipc'
import { sendToMain } from '../windows'
import { getAlerts } from '../store'
import { armVerdict, fireToFiring } from './alertsAudioRules'
import type { FireMessage } from '../../shared/dataServer/protocol.generated'

/**
 * IS THE ENGINE ALLOWED TO MAKE THE SOUND ON THIS LAUNCH? Read once, at module load, for
 * `serveShim.ts SERVING`'s reason: an environment variable is a fact about how the process was
 * started, and re-reading it per call would invite the belief that it can change. `EQC_ENGINE` is
 * deliberately not read here — the only caller is inside its guard.
 *
 * TRUE BY DEFAULT since JOS-495, and still the AND of both narrower flags: either `=0` hands the
 * sound back to this process's evaluator, and they are both read rather than one, because "the
 * engine answers the reads" and "the engine plays the alerts" are the two halves a bisecting
 * developer is trying to tell apart.
 */
// THE THIRD FLAG IS GONE (JOS-499 item 9), and it is the deletion that removes it rather than a
// tidy. `EQC_ENGINE_ALERTS=0` was a BISECT: it handed the sound back to this process's own
// evaluator so a developer could tell "the engine matched the wrong thing" from "the sound path is
// broken" in one launch. There is no evaluator to hand it back to. Keeping the variable would mean
// shipping a switch whose only effect is TOTAL SILENCE, which is the one outcome this file exists
// to prevent — so the read is deleted rather than defaulted, and `armed` below is now decided
// entirely by whether a real engine has been proven.
const WANTED = true

/** True once the swap has actually happened. `WANTED` is what the developer asked for; this is what
 *  the gate allowed, and the two differ on any store holding an early-warning def. */
let armed = false

/** Whether this launch is playing alerts from engine fires. */
export function engineAlertsArmed(): boolean {
  return armed
}

/** The dev log's voice for this file. `logInfo` is `console.log` verbatim, which is what a
 *  developer watching `npm run dev` reads and what the e2e harness taps. */
function note(line: string): void {
  logInfo(`[everquest-companion] ${line}`)
}

/**
 * ARM THE CUTOVER, OR SAY WHY NOT. Called from `engineHost.ts` on the supervisor's READY edge —
 * once per ENGINE LAUNCH, which since a respawn is a launch (contract rule 5) is the same "once"
 * this always meant.
 *
 * THAT EDGE, AND NOT PROCESS START, AND THE DIFFERENCE WAS A SHIPPED SILENCE (JOS-496). This used
 * to be called from `startEngineSupervisor()` before any binary had been probed for. Both flags it
 * reads are default-ON since JOS-495, so on a checkout with no `cargo build` it armed, silenced this
 * process's evaluator via `setEngineOwnsAudio(true)`, and then waited forever for a fire from an
 * engine that did not exist — no alerts at all, until quit. READY means a proven round trip to a
 * real process, which is the only honest answer to "is there an engine to hand the sound to".
 *
 * IT IS STILL NOT LATE, which was the original placement's one good reason: `onEngineReady` opens
 * the connection that hears a `fire` on the line after this call, so the swap is complete before a
 * frame can exist.
 *
 * IT READS THE STORE, not the module's compiled copy, because the store is what the engine was
 * handed (`appKnowledge.ts readDefine`): a gate asked about a different def set than the engine
 * compiled is a gate answering a different question.
 */
export function armEngineAlerts(): void {
  if (!WANTED || armed) return
  const verdict = armVerdict(getAlerts())
  note(verdict.line)
  if (!verdict.arm) return
  armed = true
  // NOTHING IS SILENCED HERE ANY MORE (JOS-499). This line used to be half of a SWAP —
  // `alertsModule.setEngineOwnsAudio(true)` made this process's own evaluator stop publishing at
  // the same instant the engine's fires started playing, in one statement pair, so there was no
  // window with two sources or none. The evaluator is deleted, so arming is no longer a swap: it is
  // the statement that a real engine has been proven and its fires may make a noise.
}

/**
 * Give the sound back. Idempotent, and a no-op on a launch that never armed.
 *
 * TWO CALLERS, AND THE SECOND IS THE ONE THAT MATTERS (JOS-496). The supervisor TEARDOWN has always
 * called it, so a deliberate quit cannot leave a silenced app behind. The READY edge now calls it
 * too, with `null` — which is every way a launch can end that is not a quit: a spawn that threw, a
 * bad announce, an announce timeout, a failed health probe, a crash entering the backoff. Each of
 * those leaves the app with no engine for at least the backoff, and before this the evaluator stayed
 * silenced through all of it.
 */
export function disarmEngineAlerts(): void {
  if (!armed) return
  armed = false
  // AND THE HONEST LINE IS A DIFFERENT ONE NOW. It used to say the evaluator was making sounds
  // again, which was true and is no longer: there is nothing behind the engine. An app whose engine
  // died plays no alerts until one is respawned, and saying so is the point — a silence somebody
  // can read in the dev log is a different thing from a silence nobody can.
  note('data-server alerts: the engine is gone; no alerts will fire until it is back')
}

/** Fires this launch actually PLAYED, and frames no def answered to. Both are reported on the line
 *  a drop prints, so a silence carries a number beside it rather than an absence. */
let played = 0
let unplaceable = 0

/**
 * ONE FIRE FROM THE ENGINE, PLAYED. Answers whether it was, so the caller's log line can say which
 * world made the noise.
 *
 * `registry.flushNow()` is what puts it on the wire now rather than at the next heartbeat — the
 * same trailing flush `ipc/alerts.ts` gives a renderer-reported app fire, and for the same reason:
 * an alert that arrives a second late is a different product than one that arrives.
 *
 * IT IS NEVER THE REASON A CONNECTION BREAKS. This runs inside the client's frame dispatch, where a
 * throw would surface as a transport fault, so the one honest failure — no def answers to the label
 * — is a line and a `false` rather than an exception.
 */
export function playEngineFire(fire: FireMessage): boolean {
  if (!armed) return false
  const firing = fireToFiring(fire, getAlerts())
  if (firing === null) {
    unplaceable += 1
    note(
      `data-server alerts: nothing in the store answers to "${fire.rule}" — ` +
        `the fire is dropped (unplaceable this launch: ${String(unplaceable)})`
    )
    return false
  }
  played += 1
  // STRAIGHT TO THE WINDOW THAT MAKES THE SOUND (JOS-499 item 7).
  //
  // THIS USED TO GO THROUGH THIS PROCESS'S OWN ALERTS MODULE — `alertsModule.engineFired(firing)`
  // followed by `registry.flushNow()` — and the renderer heard it as a `module:delta` like any
  // main-side fire. That was the right shape while the TS fold existed: one audio lane, and
  // everything downstream (the recent-fires ring, the event-feed row) already read that delta.
  //
  // THE MODULE IN THE MIDDLE IS DELETED, so the fire needs its own door or every alert in the
  // product goes silent. `IPC.onAlertFired` carries the same `FiredAlert` the delta's `fired[]`
  // carried, so `AlertPlayer` reads exactly what it always read — the `origin: 'app'` echo rule
  // included — and the single-audio guarantee is now structural in the simplest possible way:
  // there is one sender and one receiver.
  //
  // THE RING AND THE FEED ROW ARE THE ENGINE'S NOW rather than lost: the engine evaluates the
  // alert, its own alerts module records the firing, and its own eventFeed folds the row — both
  // reach the renderer through the served `module:getSnapshot`. What this call is responsible for
  // is the one thing the engine cannot do, which is ruling 9's whole point: make a noise.
  sendToMain(IPC.onAlertFired, firing)
  return true
}

/** How many engine fires this launch has played. */
export function enginePlayedCount(): number {
  return played
}
