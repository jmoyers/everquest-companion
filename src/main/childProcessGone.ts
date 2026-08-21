// ============================================================================
// childProcessGone.ts — the Chromium children this app never noticed losing (JOS-364).
// ============================================================================
//
// `render-process-gone` has had a handler since the beginning (windowErrors.ts): a window that
// died is a blank app and impossible to miss. `child-process-gone` had none — so when the GPU
// process died, Chromium restarted it, every window's compositor was torn down and rebuilt, the
// user saw a black frame or a second-long freeze, and this app recorded NOTHING. The one field
// report we have of a ~1 s EverQuest hitch around an overlay show is exactly the shape of that,
// and there is no evidence either way because nobody was counting.
//
// TWO OUTPUTS, ONE EVENT, AND THEY ANSWER DIFFERENT QUESTIONS:
//   * a COUNTER (telemetry/health.ts) — how often does this happen across the fleet, per build.
//     A count is the only shape that can answer that, and it costs one integer add.
//   * an ERROR LINE, for GPU losses only — `logError('main:gpu-process-gone')` with the reason
//     and the exit code, so the error store holds an EXEMPLAR. A count says how often; an
//     exemplar says `crashed`, `oom` or `launch-failed`, which is the difference between a driver
//     problem and a machine out of memory, and no counter can carry it.
//
// …AND THE EXEMPLAR SAID NONE OF IT, FOR EVERY BUILD UP TO 1.5.0 (JOS-418). The reporter handed
// `logError` a bare `{ reason, exitCode }`, which is an object with no `message` and no `name` on
// it — and `caughtFields` reads exactly those. So the error store filed the loudest new family in
// the fleet (348550db, 21× on 1.5.0 + 14× on 1.4.0; bc8e5df6 is the SAME site at 1.1.0/1.2.0
// bundle lines) as the literal text `Error: ` and nothing else. Every fact this file had already
// computed was sitting in the payload one property away from a reader, unread.
//
// THE FIX IS THAT THE SITE STATES WHAT IT KNOWS, and the three fields it states are chosen for
// what `errorReports.ts` can actually carry:
//   * `name` — `GpuProcessGone`, not `Error`. `errorFingerprint` hashes the NAME and the frames
//     and never the message, so the name is the only field that can make this its own row; the
//     presence watcher's `PresenceWatcherExitLoop` (presenceProtocol.ts) is the same move.
//   * `message` — a sentence naming the child, the reason and the exit code. NEVER EMPTY: every
//     part of it has an honest fallback, so there is no input to this file that produces a blank.
//   * `code` — the exit code AGAIN, verbatim, because `redactMessage` folds any run of five or
//     more digits to `<n>` and a Windows crash exit code is ten digits (0xC0000005 is
//     3221225477). The `code` field is the wire's machine-readable one, `errorCodeOf` takes a
//     number, and `errors show` prints it — so the one number that separates an access violation
//     from a stack overflow survives the redactor by riding in the field built for it.
//
// THERE IS NO SIGNAL FIELD TO CARRY. The brief asked for one; Electron's `child-process-gone`
// payload is `{ type, reason, exitCode, name?, serviceName? }` and has never had a `signal`
// (checked against the electron.d.ts this repo builds against). On POSIX the signal is inside
// `exitCode` — it is a `waitpid` status — so the exit code IS that answer, and inventing a field
// no payload has ever printed is the thing the awaiting-sample law forbids.
//
// STILL GPU-ONLY, AND THAT IS NOW A MEASURED DECISION rather than an unexamined one. The fleet's
// own counters over the 7 days to 2026-08-19: `gpuProcessGone` 55, `utilityProcessGone` 608.
// Reporting utility losses too would put ~600 exemplars a week of a condition Chromium routinely
// self-heals (it restarts the network and audio services) into the error store, to say something
// `utilityProcessGone` already says. If the owner wants the WHICH — which service — the widening
// is `noteUtilityProcessGone()` growing a `report?.(…)` beside it with its own error name, and it
// is one line; the counter is the thing that would tell us it had become worth it.
//
// A CLEAN EXIT IS NOT A LOSS. Chromium tears its children down on the way out — a GPU process
// with `reason: 'clean-exit'` at shutdown is the app quitting properly, and a counter that
// included it would report one GPU loss on every ordinary session this app has ever run. That
// filter is the only judgement in this file, and it is stated where it happens.
//
// IT IMPORTS NO ELECTRON, deliberately — `watchChildProcessGone` takes the emitter, so the whole
// rule can be driven from a unit test with a plain EventEmitter and no app at all. The one caller
// that has a real `app` is `crashGuards.ts`, which is where every other process-level guard is
// installed.

import { noteGpuProcessGone, noteUtilityProcessGone } from './telemetry/health'

/** Electron's `child-process-gone` payload, narrowed to what is read. Every field is optional
 *  here because it arrives from outside our types and a missing one must not throw on an error
 *  path — `unknown` is a fine thing for a diagnostic to say.
 *
 *  `name` is Chromium's human name for the process (`Audio Service`, `Network Service`) and
 *  `serviceName` its mojo name (`network.mojom.NetworkService`). Both are Chromium's own
 *  constants, and both are held to a SHAPE below rather than trusted for being so. */
export interface ChildProcessGoneDetails {
  type?: string
  reason?: string
  exitCode?: number
  serviceName?: string
  name?: string
}

/**
 * WHAT A CHILD LOSS IS REPORTED AS, once the counting is done — the payload `logError` receives.
 *
 * The three field names are `errorReports.ts`'s, not this module's invention: `caughtFields`
 * reads `name`, `message`, `stack` and `code` off whatever was handed to `logError`, and those
 * are the only properties of this object that reach the error store. `reason` and `exitCode`
 * ride along unread by the wire and land verbatim in `errors.log`, where a dev reading the file
 * wants them as fields rather than as prose.
 *
 * Injected as a callback so this module needs no `errorLog` import (which would pull in
 * `electron`) and so a test can watch exactly what it was told.
 */
export interface ChildLossReport {
  /** The error NAME the store fingerprints on — `GpuProcessGone`, never the default `Error`. */
  name: string
  /** A sentence. Never empty, never whitespace: see `describeChildLoss`. */
  message: string
  /** The exit code again, machine-readable, because the redactor eats long digit runs. */
  code: number
  reason: string
  exitCode: number
  /** Chromium's name for the process, when it supplied one that passed `CHILD_NAME_RE`. */
  child?: string
}

export type ChildLossReporter = (info: ChildLossReport) => void

/** The exit that means "we asked it to stop". Everything else is a loss. */
const CLEAN_EXIT = 'clean-exit'

/** The error NAME a GPU loss carries, and the whole reason it can be its own row in the error
 *  store instead of the twenty-first copy of `Error:` with nothing after the colon. */
export const GPU_LOSS_ERROR_NAME = 'GpuProcessGone'

/**
 * The shape a `reason` must have to be repeated back. Chromium's are all lower-kebab words —
 * `clean-exit`, `abnormal-exit`, `killed`, `crashed`, `oom`, `launch-failed`,
 * `integrity-failure`, `memory-eviction` — and holding the SHAPE rather than that list means a
 * reason a future Electron adds still reads through, while nothing that is not one of Chromium's
 * words can. Anything else reads as `unknown`, which is the honest answer.
 */
const REASON_RE = /^[a-z][a-z-]{0,23}$/

/**
 * The shape a process NAME must have. Chromium's constants (`Audio Service`,
 * `network.mojom.NetworkService`) are letters, digits, spaces and `. _ -`; a value that is not
 * that shape is dropped rather than repaired, for the same reason `normalizeFrameFile` drops a
 * frame it cannot classify. It is a bound on a channel, not a formality: this string comes from
 * outside our types and ends up in a message the fleet transmits.
 */
const CHILD_NAME_RE = /^[A-Za-z][A-Za-z0-9 ._-]{0,47}$/

/** A `details` string repeated back, or undefined — the one gate every outside string passes. */
function shaped(value: unknown, re: RegExp): string | undefined {
  return typeof value === 'string' && re.test(value) ? value : undefined
}

/**
 * THE SENTENCE, and the guarantee this ticket is about: it is never empty, for any input.
 *
 * `reason` and `exitCode` always print, because both have a fallback computed above them, and
 * the leading clause is a literal. So the shortest string this can return is
 * `GPU process gone: reason=unknown, exitCode=-1` — which still says which child died and that
 * the payload told us nothing else, and is a thing a reader can act on.
 *
 * The child's name is parenthesised when Chromium supplied one, because for the GPU process it
 * usually does not and a trailing `child=` with nothing after it is worse than silence.
 */
export function describeChildLoss(child: string | undefined, reason: string, exitCode: number): string {
  const who = child === undefined ? 'GPU process' : `GPU process (${child})`
  return `${who} gone: reason=${reason}, exitCode=${String(exitCode)}`
}

/**
 * One `child-process-gone`. Total: it never throws, and a payload it does not recognise is
 * ignored rather than counted under a guess.
 *
 * ONLY TWO TYPES ARE COUNTED. Chromium also reports `Zygote`, `Sandbox helper`, `Ppapi plugin`
 * and others; none of them exists on the platforms this app ships to, or none of them means
 * anything a user would notice, and a counter that quietly accumulated them would answer a
 * question nobody asked with a number nobody could act on.
 */
export function noteChildProcessGone(
  details: ChildProcessGoneDetails,
  report?: ChildLossReporter
): void {
  // THE CLEAN-EXIT FILTER READS THE RAW STRING, not the shaped one: `clean-exit` is a specific
  // word and a payload carrying it must be dropped whether or not anything else about it parses.
  if (details.reason === CLEAN_EXIT) return
  const reason = shaped(details.reason, REASON_RE) ?? 'unknown'
  const exitCode = typeof details.exitCode === 'number' ? details.exitCode : -1
  if (details.type === 'GPU') {
    noteGpuProcessGone()
    // The exemplar. `reason` is one of Chromium's own closed words, `exitCode` is a number, and
    // `child` is a Chromium constant held to `CHILD_NAME_RE` — none of the three can carry a
    // path, a character, a zone or a line of anyone's log. `name` before `serviceName` because
    // the human name (`Audio Service`) is the one a reader can do something with.
    const child = shaped(details.name, CHILD_NAME_RE) ?? shaped(details.serviceName, CHILD_NAME_RE)
    const info: ChildLossReport = {
      name: GPU_LOSS_ERROR_NAME,
      message: describeChildLoss(child, reason, exitCode),
      code: exitCode,
      reason,
      exitCode
    }
    if (child !== undefined) info.child = child
    report?.(info)
    return
  }
  if (details.type === 'Utility') noteUtilityProcessGone()
}

/** The minimum of `Electron.App` this file needs — narrow on purpose, so the unit test can pass
 *  an EventEmitter and the composition root can pass the real app, and neither is a cast. */
export interface ChildProcessGoneEmitter {
  on(
    event: 'child-process-gone',
    listener: (e: unknown, details: ChildProcessGoneDetails | undefined) => void
  ): unknown
}

/**
 * Install the listener. Safe BEFORE `ready` — which is where it is called from, so no window can
 * be created, and no GPU process can die, in a window where nobody is listening.
 */
export function watchChildProcessGone(
  app: ChildProcessGoneEmitter,
  report?: ChildLossReporter
): void {
  app.on('child-process-gone', (_e, details) => {
    // `?? {}` because the payload arrives from outside our types: a details-less event must cost
    // a count, not an exception on the app's own crash path.
    noteChildProcessGone(details ?? {}, report)
  })
}
