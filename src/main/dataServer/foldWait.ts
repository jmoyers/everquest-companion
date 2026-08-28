// ============================================================================
// foldWait.ts — WAITING OUT A CATCH-UP, WITH NO CLOCK TO GIVE UP ON (JOS-518).
// ============================================================================
//
// `engineClientHost.ts` polls `session.health` after every accepted attach until the engine says
// `live`, and THAT LOOP IS THE ARMING OF THE ENTIRE READ PATH: it is what records `engineLiveOn`,
// which is what `engineServeReadiness()` answers on every served IPC. Until it lands, every panel in
// the product is empty by construction.
//
// ── WHAT WAS WRONG WITH IT ─────────────────────────────────────────────────────────────────────
//
// It had a 120-second budget, and the budget was a SURVIVOR. It belonged to the parity probe
// (deleted by JOS-499), where it was honest: the probe compared two folds and a bound on its own
// patience only cost it a verdict — the comment said so, "how long the probe waits before it gives
// up and reports what it actually found". Post-cutover the same expiry strands the session. The
// loop returns, `engineLiveOn` is never set, readiness answers `notLive` FOREVER, and nothing ever
// asks again — while the engine on the other end is perfectly healthy and still folding.
//
// And it is worse than silent. The engine's LIVE TAIL keeps emitting progress frames, the banner is
// still in its `folding` phase because nothing ever moved it, so the bar sits at 100% with the event
// count climbing for the rest of the session. That is exactly what two 1.11.0 reports described —
// "100% for over 5 minutes, still reading the log and the number of events is still going up
// (9,087,066 and rising)" and "Log keeps catching up even while in-game".
//
// ── THE RULE THIS FILE ENCODES (owner, verbatim) ───────────────────────────────────────────────
//
// *"it should only give up if the engine isn't doing anything or not present due to AV - in all
// cases but the most pathological, if its already parsing, why are we having a timeout?"*
//
// A FOLDING ENGINE IS NEVER GIVEN UP ON. Every exit below is a real event and none of them is a
// timer:
//
//   * the engine says `live` — the fold landed, which is the answer the loop was waiting for;
//   * the turn was superseded (`mine()` answers false) — a respawn, a character switch or a world
//     rebuild replaced the world, and the fresh turn is already waiting on its own fold;
//   * the connection refused the poll a bounded few times running — the engine is not answering AT
//     ALL, which is the wedged-alive pathology, and the supervisor's own health watch is what
//     handles a process in that state (a respawn is a launch, and the fresh turn re-arms).
//
// A log the size of the ones in those reports takes as long as it takes. The only thing this file
// owes a person waiting on one is to SAY SO, which is the narration below.
//
// ── WHY IT IS A LEAF WITH ITS DEPENDENCIES HANDED IN ───────────────────────────────────────────
//
// `readShim.ts`'s reason exactly: every interesting case here is a failure, and not one of them can
// be staged reliably against a real engine on a real socket — an engine that folds past two minutes,
// a poll refused once and then answered, a connection that dies mid-wait. So the loop takes its
// request, its turn, its sleep and its log sink as arguments and `tests/dataServerFoldWait.test.mts`
// drives the whole matrix with no Electron, no socket and no Rust binary in the room.
//
// NOTHING HERE READS A CLOCK. The narration counts POLLS rather than milliseconds, which is the same
// discipline the fold itself keeps (`tests/foldDeterminism.test.mts`: a historical replay reads no
// wall clock) and is what lets a test drive thirty simulated minutes in a millisecond.

import { EngineError } from '../../shared/dataServer/client'
import { humanBytes } from '../../shared/engineLaunch'

/** How often the fold is asked how it is getting on. The engine's own progress cadence is ~4 Hz,
 *  so this is a beat slower than the thing it is watching and costs one round trip. */
export const FOLD_POLL_MS = 400

/**
 * How many refusals IN A ROW end the turn.
 *
 * NOT ONE, WHICH IS WHAT IT USED TO BE. A single refusal ended the wait and therefore stranded the
 * session just as permanently as the budget did — and a refusal is the one failure here that is
 * routinely transient, because the client's own per-request deadline (JOS-518 item 2) turns a slow
 * answer into a rejection. Three consecutive refusals is a statement about the engine rather than
 * about one ask.
 */
export const FOLD_REFUSAL_LIMIT = 3

/** The pause after a refused poll. Longer than the ordinary beat on purpose: a refusal is not a
 *  measurement that came back uninteresting, it is the engine failing to speak. */
export const FOLD_REFUSAL_PAUSE_MS = 1_000

/**
 * How many polls between two narration lines — thirty seconds' worth, counted rather than timed.
 *
 * COARSE BECAUSE THE DEV LOG IS A PLACE SOMEBODY READS. A line per poll would be 150 lines a minute
 * and would bury the very fold it was describing; a line every thirty seconds is enough for a person
 * reading `errors.log` after the fact to see the offset moving and know the engine is alive.
 */
export const FOLD_NARRATE_EVERY = Math.round(30_000 / FOLD_POLL_MS)

/** What `session.health` says, reduced to the fields this loop and its caller quote. */
export interface FoldHealth {
  readonly status: string
  readonly epoch: number
  readonly events?: number
  /** The engine's own (log identity, byte offset). Absent until it has folded something. */
  readonly mark?: { readonly logPath?: string; readonly offset?: number }
  /** THE LOG FILE'S mtime, as the ENGINE stats it (owner ruling 21). Absent before an attach, and
   *  absent when the stat failed — never zero, which would claim 1970. */
  readonly logMtimeMs?: number
}

/** Everything the loop cannot get for itself. One object rather than four arguments, so a caller
 *  cannot pass them in the wrong order. */
export interface FoldWaitDeps {
  /** Ask the engine how it is. Rejects when the connection refuses OR when the client's own
   *  per-request deadline expires — the loop treats those the same, because they are the same
   *  sentence: nobody answered. */
  readonly ask: () => Promise<FoldHealth>
  /** Is this still the turn that started the wait? Asked after every suspension point — the rule
   *  every `await` in `engineClientHost.ts` is followed by. */
  readonly mine: () => boolean
  /** Sleep, without ever being the reason this process stays alive. */
  readonly rest: (ms: number) => Promise<void>
  /** Every health answer, on the way past. The caller's go-live edge lives here — see
   *  `engineClientHost.ts`, which is the only thing that knows what going live MEANS. */
  readonly saw: (health: FoldHealth) => void
  /** The dev log. */
  readonly note: (line: string) => void
  /** What the engine last said this log's size was, or null before any progress frame. The
   *  narration's denominator, and the reason it is a callback: it moves while the fold runs
   *  (EverQuest is still appending), so a value captured at the start would go stale. */
  readonly logSize: () => number | null
}

/**
 * POLL UNTIL THE ENGINE IS LIVE. The health answer that said so, or null when the turn ended.
 *
 * Null means "say nothing": either somebody replaced this world, or the engine stopped answering
 * and the supervisor owns what happens next. Neither is a thing to report from here.
 */
export async function waitForFold(deps: FoldWaitDeps): Promise<FoldHealth | null> {
  let refusals = 0
  let sincePoll = 0
  for (;;) {
    let health: FoldHealth
    try {
      health = await deps.ask()
    } catch (err) {
      if (!deps.mine()) return null
      refusals += 1
      if (refusals >= FOLD_REFUSAL_LIMIT) {
        deps.note(
          `data-server client: session.health was refused ${String(refusals)} times running — ` +
            `this turn stops asking (${describeErr(err)})`
        )
        return null
      }
      deps.note(
        `data-server client: session.health was refused (${describeErr(err)}); ` +
          `asking again (${String(refusals)} of ${String(FOLD_REFUSAL_LIMIT)})`
      )
      await deps.rest(FOLD_REFUSAL_PAUSE_MS)
      if (!deps.mine()) return null
      continue
    }
    if (!deps.mine()) return null
    // A POLL THAT WAS ANSWERED CLEARS THE COUNT. The limit is about consecutive silence; an engine
    // that refused once at minute three and has answered every poll since is not the pathology.
    refusals = 0
    deps.saw(health)
    if (health.status === 'live') return health
    sincePoll += 1
    if (sincePoll >= FOLD_NARRATE_EVERY) {
      sincePoll = 0
      deps.note(stillFolding(health, deps.logSize()))
    }
    await deps.rest(FOLD_POLL_MS)
    if (!deps.mine()) return null
  }
}

/**
 * THE LINE A LONG FOLD EXPLAINS ITSELF WITH.
 *
 * It says the same two things the launch banner says, for the same reason: a percentage alone
 * cannot tell a person whether to wait, and a byte offset with no denominator cannot either. The
 * denominator comes from the engine's own progress frames rather than from a `statSync` here — the
 * engine owns log-file facts (owner ruling 21), and re-stating one it has already stated would be
 * this process reaching into a file it does not own to answer a question it was already told.
 *
 * IT DEGRADES RATHER THAN GUESSING. No mark yet, no denominator yet: each clause is omitted where
 * there is nothing true to put in it (world-model law 1), and the sentence still says the one thing
 * that matters, which is that the fold is running.
 */
export function stillFolding(health: FoldHealth, logSize: number | null): string {
  const offset = health.mark?.offset
  const where =
    offset === undefined
      ? 'nothing folded yet'
      : logSize === null
        ? humanBytes(offset)
        : `${humanBytes(offset)} of ${humanBytes(Math.max(offset, logSize))}`
  const events = health.events === undefined ? '' : `, ${health.events.toLocaleString('en-US')} events`
  return `data-server client: still folding — ${where}${events} (epoch ${String(health.epoch)})`
}

/** The same two lines four other files in this directory spell for themselves. */
function describeErr(err: unknown): string {
  if (err instanceof EngineError) return `${err.code}: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}
