// --- JS error capture harness (Task #13) ---
//
// Install process-level guards as early as possible so a crash during startup is
// logged instead of silently killing the app. In DEV we deliberately do NOT exit
// on uncaught errors: keeping the process alive lets watch-mode recover and keeps
// the window (and its ErrorBoundary) visible instead of leaving a blank shell.
//
// This is a SIDE-EFFECT module, imported for its import (index.ts pulls it in right after
// channel.ts/e2e.ts and before anything that does real work). That placement is the whole
// point: module bodies further down the import graph — the spell-DB load, the store
// migrations — run BEFORE index.ts's own body, so a guard installed there would be installed
// too late to catch them.

// THE STDIO SINKS GO IN FIRST, AND THAT ORDER IS THE FIX (JOS-197).
//
// `process.stdout` and `process.stderr` are EventEmitters, and an EventEmitter with no `'error'`
// listener THROWS its payload (`presence.ts detach` is written around the same law). So when the
// console's pipe closed under a packaged build, the failed write became an uncaught exception, the
// handler below answered it by writing to the console, and one install filed 7,272,196 occurrences
// of `EPIPE: broken pipe, write` in a day. Installing the listener is what stops a dead audience
// from being promoted into an app error at all; `errorLog.ts`'s `toConsole` is the other half, for
// the stdio flavours that throw synchronously instead.
//
// It is installed BEFORE the two handlers below purely so that no window exists in which this
// module is loaded and the promotion can still happen.
import { silenceStdioErrors } from './deadPipe'
import { logError } from './errorLog'

silenceStdioErrors()

// EPIPE IS NOT SPECIAL-CASED HERE, deliberately. A broken pipe that reaches this handler came from
// somewhere that is NOT our own stdio — a child process, a socket, the updater — and those are real
// failures a blanket rule would swallow. What was wrong was never that EPIPE arrived here; it was
// that handling it wrote to the thing that had just failed. The general backstop for any error that
// learns to repeat itself is the per-fingerprint budget inside `logError` (JOS-197).
process.on('uncaughtException', (err) => {
  logError('main:uncaughtException', err)
})
process.on('unhandledRejection', (reason) => {
  logError('main:unhandledRejection', reason)
})
