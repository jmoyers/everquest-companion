// ============================================================================
// deadPipe.ts — an unwritable log destination is not an app error (JOS-197).
// ============================================================================
//
// WHAT THE FLEET SHOWED US. One 0.14.0 install filed 7,272,196 occurrences of ONE fingerprint in a
// single day: `Error: EPIPE: broken pipe, write`, frames `logError` ← `process.<anonymous>` — the
// `uncaughtException` handler in `crashGuards.ts`. That pair of frames IS the loop, read off the
// exemplar: the app narrates to `console.*`, the console's pipe is gone, the failed write becomes
// an uncaught exception, the handler answers it by writing to the console, and the whole thing
// runs again. Roughly eighty times a second, for a day.
//
// A PIPE THAT NOBODY IS READING IS NOT A FAULT IN THIS APP. It is the ordinary state of a packaged
// Windows build whose parent console has closed, and there is exactly one correct response to it:
// stop writing, say nothing, carry on. Anything else is the app reporting its own inability to
// report, which is the only error that can generate more of itself by being handled.
//
// TWO PLACES THE FAILURE ARRIVES, and both need a sink, because Node picks between them by what
// kind of handle stdio turned out to be:
//
//   * SYNCHRONOUSLY, as a throw out of `console.*` — when stdout is a file or a sync-write handle.
//     `errorLog.ts` wraps every console call and asks `isBrokenPipe` about what came out.
//   * ASYNCHRONOUSLY, as an `'error'` event on `process.stdout` / `process.stderr` — when stdio is a
//     socket or an async pipe. An EventEmitter with NO listener for `'error'` THROWS the payload
//     (the same law `presence.ts detach` is written around), so the missing listener is precisely
//     what promoted a dead pipe into an uncaught exception. `silenceStdioErrors()` installs it.
//
// ONCE DEAD, ALWAYS DEAD, for the rest of the session (`stdioIsDead`). A pipe does not come back,
// and the latch is what makes the fix free rather than merely correct: after the first failure the
// app stops attempting the write at all, so the cost of a dead console is one failed write and not
// one per line for the life of the process.
//
// IT IS DELIBERATELY NARROW. The latch and the silence are about OUR OWN STDIO — the two streams
// this process writes its log lines to — and nothing else. There is no blanket "drop every EPIPE"
// rule at the `uncaughtException` handler, because an EPIPE from a child process, a socket or the
// updater is a real failure that a general rule would swallow. What was wrong was never that EPIPE
// reached the handler; it was that HANDLING it wrote to the thing that had just failed.
//
// THIS MODULE IMPORTS NOTHING, for `errorRepeat.ts`'s reason: `errorLog.ts` and `crashGuards.ts`
// are both callers and both sit on the app's error path, where a module-init cycle is the single
// worst bug to discover. `process` is a global, not an import, so installing the stream sinks costs
// this file none of its leaf-ness — and `tests/errorFlood.test.mts` drives the real rule with no
// Electron in the process.

/**
 * The error codes that mean "the other end of this pipe is gone". Each one is a way Node reports
 * the same fact, and which one you get depends on the handle type and on how far through teardown
 * the stream was:
 *
 *   EPIPE                       — the classic: written to a pipe with no reader.
 *   EBADF / ENXIO               — the descriptor is not a thing that can be written to any more.
 *   ERR_STREAM_DESTROYED        — the stream was torn down under an in-flight write.
 *   ERR_STREAM_WRITE_AFTER_END  — the same, one step later.
 *   ECONNRESET                  — a socket-backed stdio whose peer went away.
 *
 * A LIST, not a pattern: this decides whether the app goes SILENT, so it may only ever match codes
 * whose meaning is exactly "this destination is unwritable". A regex over the string would grow to
 * mean whatever a future message says.
 */
export const BROKEN_PIPE_CODES: readonly string[] = [
  'EPIPE',
  'EBADF',
  'ENXIO',
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END'
]

/**
 * Is this the failure of a write to a destination that no longer exists?
 *
 * TOTAL and adversarial, like every predicate on this path: it is handed whatever came out of a
 * `catch` or off an `'error'` event, which may be anything at all including `undefined` or a
 * string. Only a `code` property is read — never the message — because the message is free text
 * from libuv and matching it would be matching a version of Node rather than a condition.
 */
export function isBrokenPipe(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && BROKEN_PIPE_CODES.includes(code)
}

/** The session latch. Reset only by `resetDeadPipe` (tests) — a pipe does not come back. */
let dead = false

/** Has a write to this process's stdout/stderr already failed as a dead pipe? */
export function stdioIsDead(): boolean {
  return dead
}

/**
 * Latch it. Idempotent, allocation-free, and callable from inside a `catch` on the error path —
 * which is why it is a bare boolean assignment and not a counter, a log line or a report.
 */
export function noteDeadStdio(): void {
  dead = true
}

/** Forget the latch. Tests only — the latch is per session (see `dead`). */
export function resetDeadPipe(): void {
  dead = false
}

/**
 * THE MISSING LISTENER. Give `process.stdout` and `process.stderr` an `'error'` sink so a failed
 * write is a fact about a stream rather than an uncaught exception in the main process.
 *
 * A broken pipe latches and is otherwise ignored. ANYTHING ELSE is left alone deliberately: this
 * function's job is to stop a dead console from crashing the app, not to make stdio failures
 * invisible in general — so a genuine stream fault still surfaces the way it always has.
 *
 * Idempotent: `crashGuards.ts` is a side-effect module and the e2e harness launches the app more
 * than once per process in some configurations, and duplicate listeners would only mean duplicate
 * work on the one path that must stay cheap.
 */
let installed = false

export function silenceStdioErrors(): void {
  if (installed) return
  installed = true
  for (const stream of [process.stdout, process.stderr]) {
    // `process.stdout` can be undefined in exotic embeddings; ask rather than assume.
    if (typeof stream?.on !== 'function') continue
    stream.on('error', (err: unknown) => {
      if (isBrokenPipe(err)) noteDeadStdio()
    })
  }
}
