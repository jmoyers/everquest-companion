/**
 * THE APP BOOTS ITS REAL ENGINE, AND TAKES IT WITH IT WHEN IT GOES (JOS-470, phase 0).
 *
 * WHAT IS NEW HERE. Every other spec in this suite drives ONE process. This one is about the seam
 * between two: Electron main spawns `engined.exe` (real Rust, built from this worktree), hands it a
 * secret down a pipe, connects to the loopback port it announces, and proves it is alive with a
 * `session.health` round-trip. Both halves are unit-tested already — `tests/dataServerSupervisor`
 * drives every failure path with no app and no Rust, and `engine/crates/engined/tests/
 * spawn_contract.rs` drives the whole contract with no app and no TypeScript — and neither of them
 * can see the thing this file is about: THE TWO REAL BINARIES, agreeing, in the running product.
 *
 * THERE IS NO FLAG LEFT TO ASK WITH (JOS-499). `EQC_ENGINE` was the one switch and it is deleted
 * along with the fold it used to select against: every launch gets an engine, because there is no
 * other world to run. So this spec no longer opts in, and step 5 no longer opts OUT — the absence it
 * asserts is the one a user can really have, a build with no engine BINARY, arranged by launching
 * from a directory the resolver can find nothing under (`NO_ENGINE_CWD`).
 *
 * THAT IS A BETTER TEST THAN THE FLAG WAS, for the same reason the flag was better than silence: it
 * asks the PRODUCT's own question (`engineBinaryCandidates` + `resolveEngineBinary`) rather than a
 * gate written to be asked. The user-facing half of that contract — the app boots, says so honestly,
 * invents no data and does not crash — is `tests/e2e/engine-absent.e2e.mts`.
 *
 * HOW READINESS IS OBSERVED, and why the spec KILLS the engine to see it.
 * `supervisor.ts reachedReady` narrates through `logInfo`, i.e. `console.log` in the main process,
 * i.e. the app's stdout — which Playwright pipes and is ALREADY READING by the time
 * `electron.launch()` resolves. MEASURED on this ticket: a tap attached the instant the launch
 * resolves has already missed the first ready line, every time. There are three ways out of that,
 * and two of them are worse:
 *   * make the line durable under `EQ_E2E` — a product change to suit the test, in the one module
 *     whose header explains why the test mode is not a gate there;
 *   * add an IPC or a bridge to report supervisor state — a renderer surface for a phase that has
 *     none, which is the thing JOS-467 says it will not do;
 *   * CAUSE a second one. The engine is killed from outside, exactly as a crash would kill it, and
 *     the supervisor does what a supervisor does: reports the exit, waits out its backoff, spawns
 *     again, and announces the new engine READY — this time with the harness listening.
 * The third costs nothing the product has to know about and proves strictly more: the ready line is
 * real AND the supervision behind it is real.
 *
 * WHAT EACH CLAIM RESTS ON:
 *   * the engine EXISTS — `wmic` names the `engined.exe` whose PARENT is this launch's Electron.
 *     Positive identification, `mainWindow()`'s rule applied to a process: "the one that appeared
 *     while I was launching" is right almost always and wrong exactly when a second run of this
 *     spec is on the machine, which is when it would matter most.
 *   * the engine is READY — the app's own sentence, carrying the pid, the port, the protocol
 *     version, the engine's version and its health status. The last two can only have come back
 *     over the socket, so the line is evidence of a round-trip and not of a process that started.
 *   * the port is not a door — a knock with a WRONG token is refused and hung up on. The harness
 *     learns the port from the dev log (a channel a stranger does not have) and never learns the
 *     token at all; that asymmetry IS the design (`shared/dataServer/token.ts`).
 *   * QUIT TAKES IT — the polite path (stdin EOF, exit 0, no escalation to `kill`) said out loud by
 *     the app, and then no `engined.exe` of ours left in the process table.
 *   * and with NO BINARY there is no engine at all — asserted at both ends, because absence is
 *     the claim a missed log line could fake: no child while it runs, and no shutdown narration on
 *     the way out (an engine that had existed would say goodbye).
 *
 * Run: `npm run test:e2e -- engine-boots`
 */
import { tmpdir } from 'node:os'
import { PROTOCOL_VERSION } from '../../src/shared/dataServer/protocol.generated'
import {
  buildEngineIfStale,
  buildIfStale,
  check,
  failures,
  note,
  reportRun,
  sleep
} from './appHarness.mjs'
import { closeWindows, mainWindow } from './appWindow.mjs'
import { launchOnFixture, type FixtureLaunch } from './logFixture.mjs'
import {
  engineDescendantsOf,
  engineTable,
  killEngine,
  knockWithWrongToken,
  settleErrorLog,
  settleReady,
  settleSaid,
  settleTable,
  tapOutput,
  type AppOutput,
  type EngineReady
} from './engineSteps.mjs'

/** The fixture: the smallest committed log the suite has. Nothing in this spec is about what the
 *  log SAYS — phase 0's engine opens no file and folds nothing — so the input is chosen to make the
 *  replay cheap and to keep the app on a staged install rather than the owner's real one. */
const FIXTURE = 'e2e-telemetry.log'

/**
 * A DIRECTORY WITH NO `engine/target/**` UNDER IT — which is how a launch is given no engine BINARY
 * to find (JOS-499, replacing the retired `EQC_ENGINE=0` opt-out).
 *
 * `engineBinaryCandidates` builds its list from `app.getAppPath()` and `process.cwd()`. The former
 * is the built `out/main` directory, which carries no engine; pointing the latter at the OS temp
 * dir leaves the resolver with nothing to find, so it narrates the absence and the supervisor never
 * spawns. That is the PRODUCT's own resolution path answering honestly rather than a flag telling
 * it to pretend — and it is the state a real user can actually be in.
 */
const NO_ENGINE_CWD = tmpdir()

/**
 * How long absence is given to prove itself on the second launch.
 *
 * A BOUND ON A NEGATIVE, and it is picked from the product's own clocks rather than from comfort:
 * the supervisor starts at `tailAttached` (immediately after the window exists, which is what
 * `mainWindow()` has just waited for) and would announce within `ENGINE_ANNOUNCE_TIMEOUT_MS` of
 * that. Anything that has not spawned a child by now was never going to.
 */
const ABSENCE_WINDOW_MS = 8_000

/** Everything the app said about the engine, tail first — the failure detail for the assertions
 *  whose evidence is a sentence that never arrived. */
function lastEngineLines(out: AppOutput): string {
  const said = out
    .text()
    .split('\n')
    .filter((line) => line.includes('data-server'))
  return said.slice(-3).join(' | ') || 'the app never mentioned the engine again'
}

/** Every engine that DESCENDS from this launch, or — on a machine with no `wmic` — every engine
 *  that was not already running before it started. The caller says which claim it got. */
function ours(launch: FixtureLaunch, before: readonly number[]): { pids: number[]; attributed: boolean } {
  const table = engineTable()
  const kin = engineDescendantsOf(table, launch.app.process().pid ?? -1)
  if (kin !== null) return { pids: kin, attributed: true }
  return { pids: table.pids.filter((pid) => !before.includes(pid)), attributed: false }
}

/**
 * STEP 1 — the flag spawns the binary, and the process it spawns belongs to THIS launch.
 *
 * Waits on the CONDITION (an engine appears), never on the clock: the spawn is two processes and a
 * disk read away from the moment `mainWindow()` resolved.
 */
async function stepSpawned(launch: FixtureLaunch, before: readonly number[]): Promise<number | null> {
  const appPid = launch.app.process().pid ?? -1
  await settleTable((table) => {
    const kin = engineDescendantsOf(table, appPid)
    return kin === null ? table.pids.some((pid) => !before.includes(pid)) : kin.length > 0
  })
  const found = ours(launch, before)
  if (!found.attributed) {
    note('this machine has no wmic — the engine is identified as "the one that appeared during this launch" rather than by descent')
  }
  check(
    'launching with EQC_ENGINE=1 spawns exactly one engined.exe under this launch',
    found.pids.length === 1,
    `${String(found.pids.length)} engine(s): ${found.pids.join(', ')} · launch pid ${String(appPid)}`
  )
  return found.pids.length === 1 ? found.pids[0] : null
}

/**
 * STEP 2 — kill it, and watch the supervisor put it back and say the engine is READY.
 *
 * The one place this spec is not a passive observer, and the header says why. Two claims come out
 * of it: the ready line itself (with everything it carries), and the fact that an engine dying is
 * a condition this app RECOVERS from rather than a session that quietly loses its engine.
 */
async function stepReady(launch: FixtureLaunch, out: AppOutput, firstPid: number): Promise<EngineReady | null> {
  killEngine(firstPid)
  const ready = await settleReady(out, firstPid)
  const announced = check(
    'killing the engine outright: the supervisor spawns another and announces it READY',
    ready !== null,
    ready === null ? lastEngineLines(out) : `pid ${String(ready.pid)}`
  )
  if (!announced || ready === null) return null
  check(
    '…and READY means a session.health ROUND TRIP answered, not a process that started',
    ready.status === 'idle' && ready.engineVersion !== '' && ready.engineVersion !== 'unknown',
    `engine ${ready.engineVersion}, status ${ready.status}`
  )
  check(
    '…on a live loopback port, at the protocol version both languages were generated against',
    ready.port > 0 && ready.port <= 65535 && ready.protocol === PROTOCOL_VERSION,
    `port ${String(ready.port)}, protocol ${String(ready.protocol)} (ours ${String(PROTOCOL_VERSION)})`
  )
  check(
    '…and the replacement is a DIFFERENT process, alive in the table (a respawn is a launch)',
    ready.pid !== firstPid && engineTable().pids.includes(ready.pid),
    `${String(firstPid)} → ${String(ready.pid)}`
  )
  // The durable half of the same event. The kill is a crash from the supervisor's point of view, and
  // an unexplained engine exit is a thing the fleet must be able to read about later — so it is an
  // errors.log entry with its own name, not a line that scrolls past in a dev terminal.
  const log = await settleErrorLog(launch.userData, (text) => text.includes('EngineExited'))
  check(
    'the crash is on the record: errors.log carries one EngineExited naming the exit',
    log.includes('EngineExited'),
    log.includes('EngineExited') ? 'named' : `${String(log.length)} bytes, no EngineExited`
  )
  return ready
}

/**
 * STEP 3 — the open port is not an open door.
 *
 * A 30-line knock, not a client: this is not about what the engine can DO for a caller (JOS-468's
 * library and its own tests are about that), it is about what it does for a caller who has the port
 * and not the secret — which is the only position the token exists to make useless.
 */
async function stepWrongToken(ready: EngineReady): Promise<void> {
  const knock = await knockWithWrongToken(ready.port, PROTOCOL_VERSION)
  if (!check('a stranger can reach the engine socket at all (loopback is not a boundary)', knock.connected)) return
  const refused = /"ok"\s*:\s*false/.test(knock.reply) && /"kind"\s*:\s*"hello"/.test(knock.reply)
  check(
    'a hello with the WRONG token is refused once and hung up on — the port is not the authentication',
    refused && knock.closed,
    `${knock.reply.trim().replace(/\s+/g, ' ').slice(0, 100) || '(silence)'}${knock.closed ? ' · closed' : ' · still open'}`
  )
}

/**
 * STEP 4 — quitting the app ends the engine, by the contract's own path.
 *
 * `closeWindows` rather than Playwright's `close()`, for the reason appWindow.mts states: the
 * default harness exit never emits `window-all-closed`, and both quit paths carry the engine
 * teardown. The claim is not merely "no orphan" but HOW: stdin EOF, exit 0, and the escalation to
 * `kill` never armed. A child that had to be killed is a child that could have been killed too late.
 */
async function stepQuit(launch: FixtureLaunch, out: AppOutput, pids: readonly number[]): Promise<void> {
  await closeWindows(launch.app)
  const bowedOut = await settleSaid(out, 'exited 0 after the shutdown signal')
  check(
    'quitting closes the engine’s stdin — the shutdown signal, never a signal',
    out.said('closing stdin (the shutdown signal)'),
    out.said('escalating to kill') ? 'and then ESCALATED TO KILL' : 'no escalation'
  )
  // THE NARRATION IS STDOUT FROM A PROCESS THAT IS QUITTING, so whether it exists is a race the
  // app is allowed to win — `stopEngine` deliberately does not wait, and a release-built engine
  // shifted the odds enough to fail this claim on a healthy machine (JOS-501 integration, twice in
  // one evening). The durable half replaces it: a NONZERO shutdown exit is an `errors.log` entry
  // with its own name (`EngineShutdownExit`, supervisor.ts `onExit`), so "no such entry, and the
  // escalation never armed" states the same contract in evidence that survives the app's death.
  // The stdout sentence stays as the fast path — when the engine wins the race, no file is read.
  const cleanEnding =
    bowedOut ||
    (!out.said('escalating to kill') &&
      !(
        await settleErrorLog(launch.userData, (text) => text.includes('EngineShutdownExit'), 2_000)
      ).includes('EngineShutdownExit'))
  check(
    '…and the engine takes the hint: exit 0, the contract’s own ending',
    cleanEnding,
    bowedOut ? 'said out loud' : 'app quit before narrating; errors.log carries no EngineShutdownExit'
  )
  const left = await settleTable((table) => pids.every((pid) => !table.pids.includes(pid)), 15_000)
  const orphans = pids.filter((pid) => left.pids.includes(pid))
  check(
    'no engined.exe outlives the app that spawned it',
    orphans.length === 0,
    orphans.length === 0 ? `${String(pids.length)} engine(s) accounted for` : `orphaned: ${orphans.join(', ')}`
  )
}

/**
 * STEP 5 — a launch that ASKS FOR NO ENGINE, and gets none anywhere.
 *
 * IT USED TO BE THE DEFAULT AND NOW IT IS THE EXCEPTION (JOS-490). Until this ticket the harness set
 * nothing, so "no engine" was what every other spec in the suite was doing and this step merely
 * described it. The suite now launches every app with `EQC_ENGINE=1` and `EQC_ENGINE_SERVE=1`
 * (`appWindow.mts ENGINE_ON`), so absence has to be ASKED FOR — `ENGINE_OFF`, named and greppable —
 * and the contract is tested inverted rather than deleted.
 *
 * WHICH MAKES IT A BETTER TEST, not a preserved one. An absence assertion that rode on the harness
 * doing nothing could not fail the day the harness quietly changed; this one names the flag it is
 * turning off, so it is about the PRODUCT'S gate (`engineHost.ts engineEnabled`) and nothing else.
 *
 * Asserted at both ends on purpose. The process table is the claim while it runs; the quit
 * narration is the claim about the window this harness cannot see (the lines printed before the tap
 * was attached). An engine that had been spawned and then reached ready before the tap existed
 * would still be in the table AND would still say goodbye — so a silent, invisible engine is not a
 * shape these two assertions leave room for.
 *
 * `EQC_ENGINE_SERVE=1` IS STILL IN THIS LAUNCH'S ENVIRONMENT and that is deliberate: the serve flag
 * is meaningless without the engine flag by `serveShim.ts`'s own one-gate rule, so a launch that
 * carries it and still spawns nothing is that rule holding, observed.
 */
async function stepAbsence(): Promise<void> {
  const before = engineTable().pids
  const launch = await launchOnFixture(FIXTURE, { cwd: NO_ENGINE_CWD, waitForEngine: false })
  const out = tapOutput(launch.app)
  try {
    await mainWindow(launch.app)
    await sleep(ABSENCE_WINDOW_MS)
    const appPid = launch.app.process().pid ?? -1
    const table = engineTable()
    const kin = engineDescendantsOf(table, appPid) ?? table.pids.filter((pid) => !before.includes(pid))
    check(
      'with no engine BINARY reachable, no engine is spawned at all',
      kin.length === 0,
      kin.length === 0 ? `none, ${String(ABSENCE_WINDOW_MS / 1000)}s after the window came up` : kin.join(', ')
    )
    await closeWindows(launch.app)
    // A beat for the quit's own lines to reach this side of the pipe: an engine that HAD been
    // running would narrate its shutdown here, and reading before that arrives would call a race a
    // proof of absence.
    await sleep(1_500)
    check(
      '…and the app never narrates an engine on the way out either, so nothing was quietly running',
      !out.said('data-server engine'),
      out.said('data-server engine') ? lastEngineLines(out) : 'silent'
    )
  } finally {
    await launch.close()
  }
}

async function main(): Promise<void> {
  buildIfStale()
  // The engine's own gate, and the only spec that asks for it — build.mts says why it is a second
  // gate rather than a wider `isFresh`.
  buildEngineIfStale()

  const before = engineTable().pids
  if (before.length > 0) {
    note(`${String(before.length)} engined.exe already running before this spec launched anything — they are excluded, not killed`)
  }

  const launch = await launchOnFixture(FIXTURE)
  // FIRST, before anything is driven: everything the app prints from here on is evidence, and the
  // spec's own actions are what cause the lines it asserts about.
  const out = tapOutput(launch.app)
  const seen: number[] = []
  try {
    await mainWindow(launch.app)
    const firstPid = await stepSpawned(launch, before)
    if (firstPid !== null) {
      seen.push(firstPid)
      const ready = await stepReady(launch, out, firstPid)
      if (ready) {
        seen.push(ready.pid)
        await stepWrongToken(ready)
      }
    }
    await stepQuit(launch, out, seen)
  } finally {
    await launch.close()
  }

  await stepAbsence()

  if (failures.length === 0) {
    note('the ready line is the app’s OWN narration of a health round-trip, provoked by killing the engine — a tap attached at launch has already missed the first one')
  }
  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
