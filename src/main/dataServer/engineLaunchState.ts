// ============================================================================
// engineLaunchState.ts — THE ONE THING THE SHELL IS TOLD ABOUT THE ENGINE (JOS-503).
// ============================================================================
//
// Main holds one `EngineLaunchSay` and pushes it when it changes. That is the whole file.
//
// ── WHY MAIN AND NOT THE RENDERER'S OWN CLIENT ────────────────────────────────────────────────
//
// The renderer IS a first-class peer of the engine (JOS-484: it runs a real `EngineClient` over a
// brokered socket), and `client.onProgress` exists, so the progress half could have been read in
// the window with no IPC at all. It is not, for one reason that decides the whole design: THE
// FAILURE HALF CANNOT BE. When the engine cannot start there is no socket, no client and no frame —
// the renderer's evidence is an absence, and an absence cannot be distinguished from "not yet".
// Only the supervisor knows the difference, and the supervisor is here.
//
// Splitting the two would mean a renderer reconciling a progress stream against a health push and
// deriving a state main already has. So both ride ONE object on ONE channel, and the shell mounts
// ONE component. `src/shared/engineLaunch.ts` carries that argument as the shape's own header.
//
// ── WHAT IS NOT PUSHED, AND WHY IT MATTERS ────────────────────────────────────────────────────
//
// LIVE PROGRESS IS DROPPED. The engine reports progress from its TAIL as well as from its scan
// (`ingest.rs`: "a live progress frame is the only wire evidence a live line landed"), so a session
// where somebody is playing produces these forever. Nothing draws them — the bar is about a
// historical CATCH-UP — so a push per frame for the rest of a raid would be cost with no reader.
//
// AND SINCE JOS-518 THE FRAME ITSELF SAYS WHICH LOOP MADE IT. This used to be a phase test alone —
// record only while `folding` — and that was the whole defence, on a wire where the two loops emit
// an identical shape. It failed the way single defences do: the fold wait expired at its 120-second
// budget, nothing ever moved the phase off `folding`, and the tail's own frames then held a bar at
// 100% with the event count climbing for the rest of the session, which is what two 1.11.0 reports
// described. `FoldProgress.live` is the engine's own answer and is asked FIRST; the phase is still
// asked too. `foldFrameCounts` in `src/shared/engineLaunch.ts` is both, and carries the argument.
//
// ── THE PUSH IS A CHANGE NOTICE, NOT A HEARTBEAT ──────────────────────────────────────────────
//
// There is no timer in this file. During a fold the cadence is the ENGINE's (~4 Hz, its own
// pacing); before and after it, the channel is silent. That is the polling discipline
// `enginePerfWatch.ts` keeps for the same reason, arrived at from the other direction: that one
// polls only while somebody is looking, this one never polls at all.

import type {
  EngineFaultSay,
  EngineLaunchPhase,
  EngineLaunchSay,
  FoldSay
} from '../../shared/engineLaunch'
import { ENGINE_LAUNCH_STARTING, foldFrameCounts } from '../../shared/engineLaunch'
import type { FoldProgress } from '../../shared/dataServer/protocol.generated'
import { IPC } from '../../shared/ipc'
import { sendToMain } from '../windows'
import type { EngineFaultCause } from './supervisor'

/** The current answer. Module-level like every other singleton in `src/main`: one app, one engine. */
let say: EngineLaunchSay = ENGINE_LAUNCH_STARTING

/**
 * WHERE THE RESOLVER LOOKED, held here rather than travelling through the supervisor.
 *
 * `engineHost.ts` computes the candidate list and already narrates it; the supervisor is handed
 * `resolveBinary(): string | null` and has never seen it (its `EngineFaultCause` header says so).
 * This is the graft point, and it is a plain array rather than a callback because the list is a
 * fact about the last resolution rather than a question anybody needs re-asked.
 */
let lookedIn: readonly string[] = []

/** What `onEngineLaunch` last pushed — the mount-time read behind `IPC.engineLaunchState`. */
export function engineLaunchSay(): EngineLaunchSay {
  return say
}

/** `engineHost.ts` recording what `engineBinaryCandidates` produced on the last resolution. */
export function noteEngineCandidates(candidates: readonly string[]): void {
  lookedIn = [...candidates]
}

/**
 * Replace the state and push it, IF it changed.
 *
 * The comparison is field-by-field over a shape that is two scalars and two small objects, which is
 * cheaper than the alternative (a JSON round trip) and — more to the point — cannot be fooled by key
 * order. What it buys is silence: an unchanged state pushed four times a second would make every
 * window re-render for nothing.
 */
function set(next: EngineLaunchSay): void {
  if (same(say, next)) return
  say = next
  sendToMain(IPC.onEngineLaunch, next)
}

function same(a: EngineLaunchSay, b: EngineLaunchSay): boolean {
  return a.phase === b.phase && sameFold(a.fold, b.fold) && sameFault(a.fault, b.fault)
}

function sameFold(a: FoldSay | null, b: FoldSay | null): boolean {
  if (a === null || b === null) return a === b
  // `at` is deliberately NOT compared: it is the host clock, it differs on every sample by
  // construction, and two frames reporting the same mark are the same measurement taken twice.
  return a.offset === b.offset && a.logSize === b.logSize && a.events === b.events
}

function sameFault(a: EngineFaultSay | null, b: EngineFaultSay | null): boolean {
  return a === null || b === null ? a === b : a.kind === b.kind && a.attempts === b.attempts
}

/**
 * A LAUNCH IS UNDER WAY. Called on the supervisor's READY edge and on the retry button.
 *
 * IT DOES NOT CLEAR A STANDING FAULT, and that omission is the whole of how the card stops
 * flickering. `onEngineReady(null)` fires at the END of every failed launch, and a crash loop is a
 * failed launch every few seconds — so a version of this that reset the phase would take the card
 * down and put it back up on every cycle of exactly the condition it exists to explain. The fault
 * is cleared by `noteEngineFault(null)`, which is the READY edge, i.e. by something working.
 */
export function noteEngineStarting(): void {
  if (say.fault !== null) return
  set({ phase: 'starting', fold: null, fault: null })
}

/** The retry button: the card comes down NOW, because the person just asked for something. */
export function noteEngineRetrying(): void {
  set({ phase: 'starting', fold: null, fault: null })
}

/**
 * A HISTORICAL FOLD HAS BEGUN — a launch's first attach, a character switch, or a respawn's
 * re-fold. Called from `engineClientHost.ts` where the attach is ACCEPTED, which is the earliest
 * instant this is true and is before any progress frame can arrive.
 *
 * The fold measurement starts null on purpose: a bar drawn from the previous fold's bytes would
 * show the new one starting at 100%.
 */
export function noteEngineFolding(): void {
  set({ phase: 'folding', fold: null, fault: null })
}

/** The go-live edge — the fold landed and the engine is answering. The bar resolves and goes. */
export function noteEngineLive(): void {
  set({ phase: 'live', fold: null, fault: null })
}

/** One progress frame, stamped with the host clock the estimate is taken against. */
export function noteFoldProgress(progress: FoldProgress, at: number): void {
  // TWO REASONS A FRAME IS NOT RECORDED, and the decision is `foldFrameCounts` rather than an `if`
  // here so the whole matrix is drivable in a unit test (this file imports `windows.ts`, which
  // imports Electron, so nothing can call it under plain node). Its header carries the argument for
  // why the flag AND the phase are both asked.
  if (!foldFrameCounts(say.phase, progress.live)) return
  const fold: FoldSay = {
    pct: progress.pct,
    offset: progress.offset,
    logSize: progress.logSize,
    events: progress.events,
    at
  }
  set({ phase: 'folding', fold, fault: null })
}

/**
 * THE SUPERVISOR'S FAULT EDGE — a diagnosis, or `null` for a launch that reached READY.
 *
 * The phase is DERIVED from the kind rather than sent alongside it, because the two can never
 * disagree: `no-binary` is an app that never launched anything (`absent`) and everything else is an
 * app whose launches kept failing (`failed`). A caller free to pair them differently would be a
 * caller able to say something untrue.
 */
export function noteEngineFault(cause: EngineFaultCause | null): void {
  if (cause === null) {
    set({ phase: 'starting', fold: null, fault: null })
    return
  }
  const phase: EngineLaunchPhase = cause.kind === 'no-binary' ? 'absent' : 'failed'
  set({
    phase,
    fold: null,
    fault: {
      kind: cause.kind,
      attempts: cause.attempts,
      // The paths are the actionable half of an absence and mean nothing for any other class, so
      // they are attached where they are true rather than carried on every fault.
      lookedIn: cause.kind === 'no-binary' ? lookedIn : [],
      detail: cause.detail
    }
  })
}

// THERE IS NO RESET, AND THE ABSENCE IS THE DECISION. A `resetEngineLaunchState()` was written here
// and deleted before it shipped: nothing called it. The app has one engine for one process
// lifetime, so the only thing that could want this state cleared is a test, and an export whose
// only reader is a test it does not have is exactly the dead code JOS-502 found rotting in
// `enginePerfSteps.mts` — documented as live in two places, run by nobody, and stale in content by
// the time anyone looked. A window that appears late does not need one either: it READS the current
// state on mount (`IPC.engineLaunchState`), which is the race a broadcast-on-window-create hook
// would have been trying to lose.
