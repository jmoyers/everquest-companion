// ============================================================================
// engineProtocol.ts — the PURE half of "is the engine alive, and where?" (JOS-467, phase 0).
// ============================================================================
//
// The `presenceProtocol.ts` / `presence.ts` split, applied to the data server's supervisor:
// everything in this file is a function of its arguments — the announce line's grammar, the
// restart schedule, the exit-trail fold, the binary-path probe order. No `node:child_process`, no
// `node:net`, no Electron, no clock. That is what lets the whole supervision POLICY be a
// `node:test` unit that never skips, and it is the same seam `processPriority.ts` describes: the
// arithmetic is a MECHANISM, the wiring is a POLICY, and the composition root owns both halves.
//
// THE SPAWN CONTRACT this file encodes is binding and is shared verbatim with the engine's own
// ticket (JOS-466). Restated here because a supervisor that only half-remembers it is a supervisor
// that will one day accept half a handshake:
//
//   1. NO SECRETS IN ARGV OR ENV. The first line on the child's STDIN is the token (64 hex chars,
//      LF-terminated). argv is world-readable on Windows (any process can walk the process list
//      and read a command line); a pipe between two processes is not.
//   2. THE CHILD BINDS 127.0.0.1 PORT 0 and prints EXACTLY ONE line to stdout:
//      `EQC-ENGINE PORT=<port> PROTOCOL=<protocolVersion>`, then flushes. Nothing else ever goes
//      to stdout; diagnostics go to stderr. That is why the regex below is anchored and total: a
//      binary that prints anything else on stdout is not the engine we asked for, and treating it
//      as a failed spawn is the only safe reading. (Ephemeral port 0 rather than a fixed number
//      because a fixed port is a collision with whatever else on the machine picked it, and a
//      port we did not choose cannot be squatted by an impostor before we launch.)
//   3. EOF ON STDIN IS THE SHUTDOWN SIGNAL — the dies-with-app law (plan ruling 10). The engine
//      exits 0 promptly when its stdin closes. `child.kill` is the ESCALATION, not the norm.
//   4. EVERY TCP CONNECTION OPENS WITH A VALID `hello` OR IS CLOSED.
//   5. A RESPAWN IS A LAUNCH: fresh token, fresh epoch world, resume is always requery. Nothing in
//      this file ever carries state across a spawn except the FAILURE trail, which is about the
//      supervisor's own patience and not about the world.

/**
 * THE ANNOUNCE LINE, and it is anchored on both ends on purpose.
 *
 * A loose `/PORT=(\d+)/` would happily read a port out of a Rust panic message, a linker warning,
 * or a debugger's banner — and then the supervisor would connect to whatever that number happened
 * to be and call the launch healthy. The whole line is the credential that this child is the
 * engine: exact prefix, exact spacing, exact key order, nothing after.
 *
 * The digit bounds are shape guards rather than range checks (that is `parseAnnounce`'s job) — they
 * stop a pathological line from making the regex engine chew through megabytes of digits.
 */
export const ANNOUNCE_RE = /^EQC-ENGINE PORT=(\d{1,5}) PROTOCOL=(\d{1,9})$/

/** What the announce line says once it has been believed. */
export interface EngineAnnounce {
  /** The ephemeral loopback port the engine bound. */
  readonly port: number
  /** The wire version the ENGINE was generated against — checked against ours at hello. */
  readonly protocolVersion: number
}

/**
 * Parse the one line the engine is allowed to print. Null for anything else, which the caller
 * reads as a failed spawn.
 *
 * A trailing `\r` is stripped rather than trusted: this is Windows, the child's stdout is a pipe,
 * and a Rust `println!` on a pipe emits LF — but a future build behind a shell wrapper could emit
 * CRLF and that is not a protocol violation, it is a line ending. (`ndjson.ts` strips the same
 * byte for the same reason, and says so.)
 *
 * PORT 0 IS REFUSED. The engine binds port 0 to ASK for an ephemeral port; the port it then
 * ANNOUNCES is the one the OS gave it, and that is never 0. A literal `PORT=0` means the child
 * printed the argument instead of the answer.
 */
export function parseAnnounce(line: string): EngineAnnounce | null {
  const match = ANNOUNCE_RE.exec(line.endsWith('\r') ? line.slice(0, -1) : line)
  if (!match) return null
  const port = Number(match[1])
  const protocolVersion = Number(match[2])
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  if (!Number.isInteger(protocolVersion) || protocolVersion < 0) return null
  return { port, protocolVersion }
}

/**
 * THE HOST, NUMERIC, ALWAYS — never the name `localhost`.
 *
 * The precedent is `src/main/feedback/net.ts`, and `token.ts`'s header already promised this file
 * would keep it: a NAME resolves through whatever the machine's resolver says today (a hosts file,
 * a split-horizon DNS server, an IPv6-first stack that sends us somewhere else entirely), and a
 * numeric literal cannot be pointed elsewhere. The token would still refuse the impostor, but the
 * token is the second line of defence, not the first.
 */
export const ENGINE_HOST = '127.0.0.1'

/**
 * How long the supervisor waits for the announce line before calling the spawn failed.
 *
 * Generous, because the thing being waited for is a cold-start process read off spinning rust on a
 * machine that may be mid-antivirus-scan, and the cost of being wrong here is killing a child that
 * was about to work. It is still bounded, because the alternative — waiting forever — is a feature
 * that is silently off with no error anywhere, which is the failure mode this whole file exists to
 * not have.
 */
export const ENGINE_ANNOUNCE_TIMEOUT_MS = 10_000

/**
 * How long a polite shutdown is given before `child.kill()`.
 *
 * Closing stdin IS the shutdown (contract rule 3). This is the escalation clock, and it is short:
 * it runs during `before-quit`, so every millisecond of it is a millisecond the user is looking at
 * a window that will not go away. An engine that has not noticed its own EOF in this long is
 * wedged, and a wedged child must never be the reason the app cannot quit.
 */
export const ENGINE_STOP_GRACE_MS = 2_000

/**
 * How often a READY engine is asked whether it is still there.
 *
 * The presence watchdog's argument, one process over: the supervisor's state is a CACHE of the last
 * thing it observed, and a child that is still in the process table but no longer serving is
 * indistinguishable from a healthy one unless somebody asks. An exit is observable directly
 * (`'exit'`); a WEDGE is only visible as an unanswered round-trip.
 *
 * 30 s, and cheap by construction: one loopback connect, two messages, close. It is not a
 * heartbeat the engine has to implement — `session.health` is an API surface the protocol already
 * has (plan §"The eight API surfaces", 1), so the watchdog reuses the product's own door.
 */
export const ENGINE_HEALTH_INTERVAL_MS = 30_000

/** How long one health round-trip may take before the engine is presumed wedged. */
export const ENGINE_HEALTH_TIMEOUT_MS = 5_000

/**
 * The restart schedule, in ms, indexed by consecutive failures — `WATCHER_RESTART_BACKOFF_MS`'s
 * shape and its argument (presenceProtocol.ts), because it is the same problem.
 *
 * CAPPED, and capped low enough to still be a recovery. The engine can fail for a reason that will
 * never clear on this machine (the binary is corrupt, an EDR product refuses to let it bind a
 * socket) and an uncapped retry against that is a restart storm; it can also fail for a reason that
 * clears in a second, which is why the first retry is fast. The counter resets the moment a launch
 * reaches READY, so a session that runs for eight hours with one hiccup at hour three retries at
 * 1 s, not at 30.
 */
export const ENGINE_RESTART_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 15_000, 30_000]

/** The delay before restart attempt number `consecutiveFailures` (1-based); the last entry is the
 *  ceiling and every later failure sits on it. */
export function engineRestartDelayMs(consecutiveFailures: number): number {
  const last = ENGINE_RESTART_BACKOFF_MS.length - 1
  const i = Number.isFinite(consecutiveFailures) ? Math.floor(consecutiveFailures) - 1 : 0
  return ENGINE_RESTART_BACKOFF_MS[Math.min(Math.max(i, 0), last)]
}

/**
 * THE ONE TIMER SEAM this feature has, and it is a function rather than a `{setTimeout, clearTimeout}`
 * pair on purpose: a schedule call that HANDS BACK ITS OWN CANCELLER cannot be paired with the wrong
 * handle, and there is no handle type for the two implementations to disagree about.
 *
 * In the app it is `setTimeout` with `unref()` — the supervisor must never be the reason a quitting
 * process stays alive (`presence.ts`'s rule for the same hazard). In a test it is whatever the test
 * wants, which is what lets a 30 s backoff be asserted in a millisecond.
 */
export type EngineTimer = (fn: () => void, ms: number) => () => void

// --------------------------------------------------------------- what ended a launch, and why
//
// THE REPORTING MISTAKE THIS SECTION EXISTS TO NOT REPEAT is written up in `childProcessGone.ts`:
// that reporter handed `logError` a bare `{ reason, exitCode }` — an object with no `name` and no
// `message` — and `caughtFields` reads exactly those, so the loudest new error family in the fleet
// was filed as the literal text `Error: ` and nothing else, for five releases. Every fact it had
// already computed sat in the payload one property away from a reader.
//
// So every report this supervisor makes is a NAME / MESSAGE / CODE triple:
//   * `name` — `errorFingerprint` hashes the NAME and the frames and never the message, so the
//     name is the only field that can make a condition its own row. Each failure MODE gets its
//     own, because "the binary would not start" and "the engine stopped answering" are different
//     tickets and a shared fingerprint would bury one under the other.
//   * `message` — a sentence, never empty for any input (every part has a fallback below).
//   * `code` — the exit code AGAIN, machine-readable, because `redactMessage` folds any run of five
//     or more digits to `<n>` and a Windows crash exit code is ten digits (0xC0000005 is
//     3221225477). The one number that separates an access violation from a stack overflow
//     survives the redactor by riding in the field built for it.

/** Which way a launch ended. Each is its own error NAME below. */
export type EngineFailure =
  | 'spawn-failed'
  | 'announce-timeout'
  | 'bad-announce'
  | 'unhealthy'
  | 'exited'
  /** Exited NONZERO after the app closed its stdin — the shutdown path, gone wrong. Distinct from
   *  `exited` because nothing about it is a crash of a running engine and it must never fold into
   *  the restart trail: the app asked the child to leave and the child left badly. */
  | 'shutdown-exit'

/** Everything known about ONE ended launch, in the order a reader asks for it. */
export interface EngineExitCause {
  readonly failure: EngineFailure
  /** The child's exit code, where an exit is what happened. Null when there never was a child
   *  (a spawn that threw) or when it is still running (a health failure, before the kill). */
  readonly exitCode: number | null
  /** The signal that ended it, when Windows or a `kill()` supplied one. */
  readonly signal: string | null
  /** How long the launch lived. The number that turns "it exited" into "it exited immediately". */
  readonly lifetimeMs: number
  /** Consecutive failures INCLUDING this one — i.e. which restart of the current run this is. */
  readonly attempt: number
  /** One bounded line of context: the offending stdout line, the spawn error, the engine's last
   *  stderr line. See `boundedDetail` for why it is shaped rather than trusted. */
  readonly detail: string | null
}

/** The payload the supervisor hands its reporter. See the section header for the three fields. */
export interface EngineExitLog extends EngineExitCause {
  readonly name: string
  readonly message: string
  /** The exit code, machine-readable, present only when there was one. */
  readonly code?: number
  /** Set only on the collapsed entry: how many launches in a row got us here. */
  readonly exits?: number
}

/** One error name per failure mode — see the section header for why they are not shared. */
const FAILURE_NAMES: Readonly<Record<EngineFailure, string>> = {
  'spawn-failed': 'EngineSpawnFailed',
  'announce-timeout': 'EngineAnnounceTimeout',
  'bad-announce': 'EngineBadAnnounce',
  unhealthy: 'EngineUnhealthy',
  exited: 'EngineExited',
  'shutdown-exit': 'EngineShutdownExit'
}

/** The sentence each failure opens with. */
const FAILURE_SENTENCES: Readonly<Record<EngineFailure, string>> = {
  'spawn-failed': 'the data-server engine could not be started',
  'announce-timeout': 'the data-server engine never announced its port',
  'bad-announce': 'the data-server engine printed something other than its announce line',
  unhealthy: 'the data-server engine stopped answering session.health',
  exited: 'the data-server engine exited unexpectedly',
  'shutdown-exit': 'the data-server engine exited nonzero after the shutdown signal'
}

/**
 * A SHUTDOWN THAT ENDED BADLY, MADE DURABLE (JOS-501 integration).
 *
 * The deliberate-stop arm of `onExit` narrates the child's exit code to the dev log and nothing
 * else — which is right for the exit-0 case (we asked, it left) and was silently wrong for every
 * other one: the app is QUITTING when this fires, its stdout dies with it, and a child that
 * exited 3 or crashed on teardown left no evidence anywhere. The e2e spec that asserts the clean
 * ending could only read the stdout narration, so on any launch where the app won the race the
 * claim was unprovable — green or red by timing, never by truth.
 *
 * So the nonzero case gets an `errors.log` entry with its own name. It deliberately does NOT go
 * through `engineExitStep`: that machinery exists to fold RESTART decisions (quick-exit streaks,
 * collapse), and a shutdown exit must never count toward a restart trail — the launch is over
 * because we ended it. `attempt` is 0 for the same reason: this is not a retry of anything.
 */
export function engineShutdownExitLog(
  code: number | null,
  signal: string | null,
  lifetimeMs: number
): EngineExitLog {
  return {
    failure: 'shutdown-exit',
    exitCode: code,
    signal,
    lifetimeMs,
    attempt: 0,
    detail: null,
    ...(code === null ? {} : { code }),
    name: FAILURE_NAMES['shutdown-exit'],
    message:
      `the data-server engine exited ${code === null ? `by signal ${signal ?? 'unknown'}` : String(code)} ` +
      `after the shutdown signal — the polite path ended badly`
  }
}

/**
 * How much of a detail line is repeated back, and the alphabet it must be in.
 *
 * A `detail` is text from OUTSIDE our types — a child's stdout, an OS error message — and it lands
 * in `errors.log`, which is a place text goes to be read by a person, and in a message the fleet
 * may transmit. So it is bounded by SHAPE rather than trusted by provenance, exactly as
 * `presenceProtocol.ts logSafeTitle` and `childProcessGone.ts CHILD_NAME_RE` are: control bytes
 * (which could forge extra lines in the log) become spaces, runs of whitespace collapse, and the
 * result is capped.
 *
 * A CODE-POINT SCAN RATHER THAN A REGEX, for the reason AGENTS.md already has a law about: a
 * character class spelling a control range is the one place a raw control BYTE ends up in a source
 * file by accident, and a comparison cannot be mistyped invisibly.
 */
export const ENGINE_DETAIL_MAX = 200

/**
 * THE LAUNCH TOKEN NEVER SURVIVES A ROUND TRIP THROUGH THE CHILD'S OUTPUT — and this is not
 * hypothetical, it is what the first real-app boot of this feature printed.
 *
 * With a stand-in binary in place of `engined.exe`, the child read the token off stdin, failed to
 * understand it, and echoed it back on stderr inside its own error message. The supervisor then did
 * exactly what it is built to do: kept the last stderr line as the `detail` a failure report
 * carries — and a `detail` goes to `errors.log`, which a bug report attaches and the fleet can
 * transmit. That is the telemetry bright line with a secret walking across it.
 *
 * Main never logs the token itself; the hazard is entirely that the CHILD might. So every line off
 * the child's stdout and stderr passes through here first. It costs one `includes`-shaped split per
 * line on a stream that is idle in the healthy case, and the failure it prevents is one nobody
 * would ever notice had happened.
 */
export function redactToken(line: string, token: string): string {
  if (token === '' || !line.includes(token)) return line
  return line.split(token).join('<token>')
}

export function boundedDetail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let out = ''
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    out += code < 0x20 || code === 0x7f ? ' ' : ch
  }
  const flat = out.replace(/\s+/g, ' ').trim()
  if (flat === '') return null
  return flat.length <= ENGINE_DETAIL_MAX ? flat : `${flat.slice(0, ENGINE_DETAIL_MAX)}…`
}

/** The cause as one sentence. A function rather than a template at each call site so every failure
 *  mode describes the same facts the same way — a reader grepping errors.log and a reader watching
 *  dev stdout are reading about one mechanism. */
export function describeEngineExit(cause: EngineExitCause): string {
  const code = cause.exitCode === null ? '' : `, exit code ${String(cause.exitCode)}`
  const signal = cause.signal === null ? '' : `, signal ${cause.signal}`
  const detail = cause.detail === null ? '' : `: ${cause.detail}`
  return (
    `${FAILURE_SENTENCES[cause.failure]}${detail} (alive for ${String(cause.lifetimeMs)} ms` +
    `${code}${signal}; attempt ${String(cause.attempt)})`
  )
}

// ------------------------------------------------------- the immediate-exit loop, folded
//
// A LOOP IS ONE FACT, AND THE PRECEDENT IS THAT IT GETS REPORTED AS N FACTS UNLESS SOMEBODY FOLDS
// IT. JOS-164's evidence was 245+ identical `presence watcher exited unexpectedly` entries from ONE
// install over two days, still climbing, because a child was reaping itself a second after every
// spawn and the backoff was sitting on its 30 s ceiling. Every entry said the same true thing and
// none of them said the interesting thing, which is only visible from the SHAPE of the sequence.
//
// The engine can produce that sequence with a dozen different excuses — a corrupt binary, a
// missing CRT, an EDR product that kills it the moment it binds a socket, a panic on a machine
// whose locale it cannot parse. All of them look identical from here: a launch that ends fast,
// forever, on the backoff. One diagnosis, said once.
//
// The first `ENGINE_QUICK_EXIT_STREAK - 1` failures are reported as they always would be — a single
// fast failure really can be a one-off, and silencing it would trade this bug for a quieter one.
// The failure that COMPLETES the streak carries a different error NAME, which is what makes it a
// distinct fingerprint in the error store, and every later failure in the same run is not logged at
// all until something breaks the pattern.

/**
 * How many consecutive fast failures it takes to call it a loop. THREE, for `presenceProtocol.ts`'s
 * reasons exactly: more than one (a single fast failure is a machine having a moment), more than
 * two (the backoff's own first two steps are 1 s and 2 s, so two failures fit inside one hiccup),
 * and three is the first count that can only be produced by a condition that is not clearing.
 */
export const ENGINE_QUICK_EXIT_STREAK = 3

/**
 * The window a failure has to land inside to count as "fast". A launch that reached READY and then
 * died an hour later is a different story and gets the ordinary report; the loop this folds is
 * launches that never got anywhere.
 */
export const ENGINE_QUICK_EXIT_MS = 30_000

/** The NAME the collapsed entry carries — a separate row in the error store rather than a 246th
 *  copy of the ordinary one. Distinct from every `FAILURE_NAMES` entry on purpose. */
export const ENGINE_EXIT_LOOP_ERROR_NAME = 'EngineLaunchLoop'

/** How long a streak of fast failures is, and whether the one diagnosis has been written for it. */
export interface EngineExitTrail {
  readonly streak: number
  readonly collapsed: boolean
}

export const NEW_ENGINE_EXIT_TRAIL: EngineExitTrail = { streak: 0, collapsed: false }

export interface EngineExitStep {
  readonly trail: EngineExitTrail
  readonly log: EngineExitLog | null
}

/** The exit-code field, present only when there is one — `errorCodeOf` takes a number. */
function codeField(cause: EngineExitCause): { code?: number } {
  return cause.exitCode === null ? {} : { code: cause.exitCode }
}

/** One ordinary report: the cause, its sentence, its own name. */
function ordinary(cause: EngineExitCause): EngineExitLog {
  return {
    ...cause,
    ...codeField(cause),
    name: FAILURE_NAMES[cause.failure],
    message: describeEngineExit(cause)
  }
}

/**
 * Fold one ended launch into the trail and say what to log.
 *
 * ANY failure that is not fast RESETS the trail — including a healthy engine that finally died
 * after a long run — so a machine that hiccups once an hour never accumulates its way into the
 * collapsed state, and a machine that gets fixed starts reporting normally again from the next
 * failure. `supervisor.ts` additionally resets it on every launch that reaches READY, which is the
 * stronger statement: the trail is about launches that never worked.
 */
export function engineExitStep(
  trail: EngineExitTrail,
  cause: EngineExitCause,
  streakToCollapse: number = ENGINE_QUICK_EXIT_STREAK,
  quickMs: number = ENGINE_QUICK_EXIT_MS
): EngineExitStep {
  if (!(cause.lifetimeMs >= 0 && cause.lifetimeMs < quickMs)) {
    return { trail: NEW_ENGINE_EXIT_TRAIL, log: ordinary(cause) }
  }
  // Already diagnosed: the pattern is unchanged, so there is nothing new to say. The streak is held
  // rather than incremented so the number cannot run away on a session that lasts all day.
  if (trail.collapsed) return { trail, log: null }
  const streak = trail.streak + 1
  if (streak < streakToCollapse) return { trail: { streak, collapsed: false }, log: ordinary(cause) }
  return {
    trail: { streak, collapsed: true },
    log: {
      ...cause,
      ...codeField(cause),
      name: ENGINE_EXIT_LOOP_ERROR_NAME,
      message:
        `data-server engine launch loop: ${String(streak)} consecutive launches failed inside ` +
        `${String(quickMs)} ms (last: ${describeEngineExit(cause)}). The engine is not going to ` +
        'start on this machine; the app runs without it. Further identical failures are counted ' +
        'by the restart backoff, not logged.',
      exits: streak
    }
  }
}

// ------------------------------------------------------------------ where the binary lives
//
// TWO DEPLOYMENTS, AND THE RESOLUTION IS A PROBE RATHER THAN A GUESS — `sounds.ts bundledRoots()`
// is the precedent, and it is a probe for the same reason: the same source tree produces a dev run
// (cargo's `target/debug/` beside the checkout), an e2e build, and a packaged app (unpacked beside
// the asar under `process.resourcesPath`), and which one is running is not a thing this module can
// know from its own path.
//
// PACKAGING HAS LANDED (JOS-473, phase 3) AND THIS FILE DID NOT HAVE TO MOVE: `electron-builder.yml`
// copies the RELEASE binary to `resources/engine/engined.exe` — the address the packaged candidate
// below already named while nothing shipped it. `tests/enginePackaging.test.mts` COMPOSES that
// destination out of the config and requires it to be exactly this candidate, so the two files
// cannot drift into a packaged app that resolves nothing and logs an absence.

/** The engine binary's file name. Windows only today, like the rest of this app. */
export const ENGINE_BIN_NAME = process.platform === 'win32' ? 'engined.exe' : 'engined'

/**
 * What the resolver is told about the world. Every field is a string the caller already has, so
 * this function needs no `app`, no `process`, and no `fs`.
 *
 * THE THREE ROOTS ARE THE SAME THREE `bundledImageRoots` TAKES (src/main/index.ts), and for the
 * same measured reason: `app.getAppPath()` is NOT the project root on every dev launch. Under
 * `electron-vite dev` it is; launched against a built `out/main/index.js` — which is what the e2e
 * harness and a hand-run build do — it is the directory holding that file, and the checkout is two
 * levels up. `cwd` is the root in both cases, so the two together answer where one alone does not.
 */
export interface EngineBinaryEnv {
  /** `app.getAppPath()` — the project root under `electron-vite dev`, the asar when packaged. */
  readonly appPath: string
  /** `process.resourcesPath` — where a packaged build's unpacked resources live. */
  readonly resourcesPath: string
  /** `process.cwd()` — the checkout, on every launch a developer starts from it. */
  readonly cwd?: string
  /** The engine binary's file name; injected so a test can point at a fake. */
  readonly binName?: string
  /**
   * A binary named OUTRIGHT by whoever launched this process, tried before every guess (JOS-501).
   *
   * The e2e harness builds the engine itself and must run the one it built — and the probe order
   * below prefers DEBUG, so on any machine that has ever run a plain `cargo build` a harness that
   * built release would have been silently answered with the debug binary beside it. A suite that
   * pays for one build and then proves things about another is the exact failure the harness's
   * engine work exists to prevent, so the harness states the path instead of hoping for it.
   *
   * It is a PATH, not a gate: it selects which engine runs, never whether one does, and an absent
   * or misspelled value falls through to the ordinary candidates rather than disabling anything.
   * `engineHost.ts` reads it only under `EQ_E2E=1`, which is the same standing the staged EQ install
   * (`EQ_INSTALL_DIR`) already has — the harness owns the artifact and hands it over.
   */
  readonly override?: string
}

/**
 * Every path the engine binary could be at, in the order they should be tried.
 *
 * AN OUTRIGHT NAME WINS (JOS-501). `override` is whoever launched this process saying which binary
 * it means; nothing below can be a better answer than that. It is still only a CANDIDATE — the
 * caller checks it exists like any other — so a stale value degrades to the ordinary search.
 *
 * DEV FIRST, deliberately. A developer with a fresh `cargo build` in the tree means to run THAT
 * binary; a packaged app has no `engine/target/` at all, so the ordering costs it two `existsSync`
 * calls that answer false. Debug before release for the same reason: a debug build is what a
 * developer just produced, and a stale release build sitting beside it must not silently win.
 *
 * DEDUPED, because the common case is that `appPath` and `cwd` are the same string and a resolver
 * that probed each path twice would say so in its own absence log.
 *
 * Joined with a plain `/` rather than `node:path` so this file stays import-free and testable as a
 * pure string function; Windows accepts forward slashes everywhere the app uses them, and the
 * caller's `existsSync` does not care which separator it was handed.
 */
export function engineBinaryCandidates(env: EngineBinaryEnv): string[] {
  const bin = env.binName ?? ENGINE_BIN_NAME
  const out: string[] = []
  const add = (path: string): void => {
    if (!out.includes(path)) out.push(path)
  }
  if (env.override !== undefined && env.override !== '') add(env.override.replace(/\\/g, '/'))
  for (const root of [env.appPath, env.cwd ?? '']) {
    if (root === '') continue
    add(`${root}/engine/target/debug/${bin}`)
    add(`${root}/engine/target/release/${bin}`)
  }
  // Packaged: beside the asar under `resources/`, which is where `extraResources` puts it — the
  // only arrangement a native executable can be launched from at all.
  if (env.resourcesPath !== '') {
    add(`${env.resourcesPath}/engine/${bin}`)
    add(`${env.resourcesPath}/${bin}`)
  }
  return out
}

/**
 * IS THIS BINARY THE ONE CARGO IS ABOUT TO OVERWRITE? (JOS-496)
 *
 * WHAT IT IS FOR. Windows takes a mandatory, exclusive lock on the image file of every RUNNING
 * process. So a dev app that spawns `engine/target/debug/engined.exe` directly holds that exact path
 * open for as long as the app is up — and the next `cargo build -p engined` fails at the LINK step
 * with "Access is denied", not at compile, which is the confusing half. The owner's dev app runs all
 * day; every agent and every worker in this program pays that toll. The fix is one copy: spawn a
 * DUPLICATE of the image and cargo's output path is never the file Windows has locked.
 *
 * SO THIS PREDICATE IS EXACTLY "DID THIS PATH COME OUT OF A CARGO TARGET DIRECTORY", and it is
 * spelled against the two dev candidates `engineBinaryCandidates` builds above rather than against
 * "is this app packaged" — because the question is about who ELSE writes to the path, and cargo is
 * the only writer that matters. A packaged build's `resources/engine/engined.exe` has no compiler
 * pointed at it and is answered `false`, which is what keeps the shipped launch byte-for-byte the
 * one JOS-473 signed and proved.
 *
 * SEPARATOR-BLIND, because the caller's `existsSync` is: the candidates are built with `/` but a
 * path that has been through `node:path` on Windows comes back with `\`, and a predicate that
 * silently answered `false` for the same file spelled the other way would stage nothing and leave
 * the lock exactly where it was.
 */
export function isCargoTargetBinary(path: string): boolean {
  const slashed = path.replace(/\\/g, '/')
  return slashed.includes('/engine/target/debug/') || slashed.includes('/engine/target/release/')
}

/**
 * THE NAMES THE STAGED COPY MAY TAKE, in the order to try them.
 *
 * WHY MORE THAN ONE. The first name is the whole story on an ordinary launch: one copy, overwritten
 * next time, no accumulation. The rest exist for a single awkward moment — a RESPAWN whose previous
 * engine has not exited yet. The supervisor ends a launch and schedules the next one on a backoff,
 * and three of its failure modes (`announce-timeout`, `bad-announce`, `unhealthy`) end a launch
 * whose child is still ALIVE and still holding its own image locked. Copying over it there fails,
 * and the honest answer is a second name rather than either spawning a stale copy or giving up on
 * the engine for the rest of the session.
 *
 * BOUNDED AT FOUR because the failure it covers is transient by construction (the supervisor's
 * `retire` escalates to `kill` after the stop grace), and an unbounded search would turn one wedged
 * child into a directory full of executables.
 */
export function stagedEngineNames(binName = ENGINE_BIN_NAME): string[] {
  const dot = binName.lastIndexOf('.')
  const stem = dot === -1 ? binName : binName.slice(0, dot)
  const ext = dot === -1 ? '' : binName.slice(dot)
  return [binName, `${stem}-1${ext}`, `${stem}-2${ext}`, `${stem}-3${ext}`]
}
