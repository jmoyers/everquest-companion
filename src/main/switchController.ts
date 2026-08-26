// ============================================================================
// switchController.ts — who owns the world right now, and for how long.
// ============================================================================
//
// THE DEFECT (JOS-457, reported live by the owner 2026-08-23): switching back and forth quickly
// between characters via the dropdown effectively CRASHES the app — it locks up, shows random
// encounters, and plays random audio alerts while stuck in a pseudo-loading state.
//
// THE MECHANISM. `session.ts tailCharacter` is the one seam every switch funnels through, and it
// had no single-flight guard and no abort. Every dropdown pick started ANOTHER full historical
// replay, so N quick picks ran N whole-log folds CONCURRENTLY on the main process, interleaving at
// every `await`. Each one reset the shared world (`registry.reset()`, `combat.reset()`, `seq = 0`)
// while its predecessors were still folding into it, so character A's history landed in character
// B's freshly reset modules — the "random encounters". Worse, the replay bracket and the replay
// gate were ONE BOOLEAN EACH WITH NO OWNER: the first fold to finish ran `registry.endReplay()` and
// `setReplayGate(false)` while the others were still folding, which re-opened the push path and let
// months of historical events reach the renderer as live module deltas. `feedAlertDelta` rides that
// same flush, so history fired alerts — the "random audio".
//
// THE OWNER'S RULE, and it is why this file is a GENERATION rather than a queue or a mutex:
// A NEW SELECTION PREEMPTS THE IN-FLIGHT ONE. Last pick wins; intermediate picks are DROPPED, never
// stacked. A queue would make six impatient clicks into six sequential full replays — the lock-up
// with better manners. A mutex would do the same thing while also being able to deadlock a startup
// path. A counter can only ever say "you are not the current answer any more", which is exactly the
// question every statement in a switch needs to ask.
//
// WHAT A TURN IS FOR. `session.ts` takes a turn at the top of `tailCharacter` and re-asks `owns()`
// after every point at which it could have been suspended. Only the turn that still owns the world
// may touch anything shared: `resetWorldFor`, `registry.beginReplay`/`endReplay`, the replay gate,
// the module-level `tailer`, the heartbeat, `combat.setLive()`, `flushNow()`, `sendWorldRebuilt`,
// and the inventory/achievements loads and watchers. A turn that has lost does exactly one thing:
// it returns, having touched nothing. That is what makes replay silence STRUCTURAL — it rests on
// ownership rather than on call ordering, so a future edit that moves a statement cannot re-open
// the gate under a fold that is still running.
//
// THE GATE IS OPENED BY THE GENERATION THAT OWNS IT. The replay gate and the registry's replay
// bracket both CLOSE at the top of every switch and are opened only by the turn that reaches the
// end still owning the world. Across a storm of picks that means one continuous closed state from
// the first pick to the last winner's `endReplay()` — never a gap in the middle where the losers'
// half-built worlds could reach a renderer.
//
// WHY THE COUNTER LIVES ALONE IN A FILE. The same argument `replayGate.ts` made before JOS-499
// deleted it with the fold: the answer is needed
// by `session.ts` (which owns the switch) and by anything session hands a turn to, and a module
// variable living inside either of them is a module variable the other imports through a cycle.
// This file imports NOTHING, which is also what lets `tests/switchPreemption.test.mts` drive the
// real thing instead of a copy of it.
//
// WHAT IT IS NOT: it is not a cache, a checkpoint, or a record of anything a fold produced. The
// winner re-folds the whole log from byte zero, exactly as it always did (AGENTS.md — "The fold
// checkpoint, and why there isn't one"). All this counter decides is who is allowed to keep the
// answer.

/**
 * The monotonic switch generation. Bumped by `beginSwitch()` and read by nothing else — a turn
 * compares against its own captured value, so there is no way to ask this question ambiguously.
 */
let generation = 0

/** One character switch's claim on the world, captured at the moment the switch began. */
export interface SwitchTurn {
  /** This turn's generation. Diagnostics only — it is what the log line names when a pick loses. */
  readonly gen: number
  /**
   * Does this turn STILL own the world?
   *
   * False from the instant a newer switch begins, and never true again — a turn that has been
   * preempted cannot be handed the world back, because the thing that took it is by definition
   * more recent than anything this turn could still be describing.
   */
  owns: () => boolean
}

/**
 * Begin a switch, PREEMPTING whatever was in flight. The returned turn owns the world until the
 * next call.
 *
 * Every caller that can change which character is tailed takes one — including the "no character at
 * all" arm of an EQ-dir change, which is a switch like any other and must be able to preempt a fold
 * that would otherwise finish and re-attach the log the user just told us to stop reading.
 */
export function beginSwitch(): SwitchTurn {
  generation += 1
  const gen = generation
  return { gen, owns: () => generation === gen }
}
