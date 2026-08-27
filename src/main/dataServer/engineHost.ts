// ============================================================================
// engineHost.ts — the composition root's half of the engine supervisor (JOS-467, phase 0).
// ============================================================================
//
// `supervisor.ts` is the state machine and imports nothing from Electron, Node's child process or
// Node's net. This file is everything that was left over when that was made true: which binary,
// which spawn, which socket, which clock, where a line goes. It is the same split
// `processPriority.ts` describes — mechanism there, policy and wiring here — and it is deliberately
// the only file in `src/main/dataServer` that anybody would have to rewrite to run the engine some
// other way.
//
// THE FLAG IS AN ESCAPE HATCH NOW, NOT A SWITCH (JOS-495, the owner's cutover ruling). `EQC_ENGINE=0`
// in the environment turns this OFF. Anything else turns it ON — and "anything else" is above all
// the UNSET variable that every ordinary launch has, in dev and in the packaged app alike. THE
// ENGINE IS THE PRODUCT; the flag is what you reach for when you need it gone.
//
// THAT IS THE EXACT INVERSION OF WHAT THIS HEADER USED TO ARGUE, and the old argument is not being
// quietly deleted — it was right for its phase and its phase is over. Default-off is how you carry
// a feature while you are still deciding about it, and the deciding is done: packaged builds have
// SHIPPED the binary since JOS-473, the whole e2e suite has run engine-on since JOS-490, the shim
// answers three of the app's own reads, the engine makes the sound, and the parity probe has been
// comparing the two folds on every rebuild for as long as any of it. A flag nobody sane leaves off
// is not a switch, it is a diagnostic.
//
// WHAT SURVIVES FROM THE OLD ARGUMENT IS THE SHAPE. It is still an environment variable rather than
// a store preference or a vite `define`, and for reasons the inversion does not touch:
//   * a STORE PREFERENCE would be a user-facing switch for the app's own architecture — nothing a
//     user can act on, and a support answer nobody should ever have to give;
//   * a VITE DEFINE would need the owner to restart `npm run dev` to change (AGENTS.md's rule), and
//     the whole point of an escape hatch is that a developer reaches for it in one shell;
//   * an env var read at boot is a FACT ABOUT HOW THE PROCESS WAS STARTED, so a diagnosis that
//     needs the engine gone gets it by starting the process differently rather than by editing one.
// `=1` still means on, and not as a compatibility special case — it is simply not `'0'`
// (`shared/dataServer/engineFlags.ts`, which owns the comparison for all five readers of it).
//
// THE E2E HARNESS IS NOT A SPECIAL CASE HERE, and that is still deliberate. `EQ_E2E` is not a gate
// on this file: the flags are a thing a developer sets in a shell, and since JOS-490 the harness is
// a developer who always sets them (`appWindow.mts ENGINE_ON`). That forcing became REDUNDANT with
// this ticket and is kept anyway — belt and braces across the default flip — while the one spec
// whose subject is the engine's ABSENCE opts out by name with `EQC_ENGINE=0`. The rule this repo
// actually keeps is that the test mode changes as little about the product as possible, and a
// harness that names what it wants changes nothing at all.
//
// TWO NARROWER FLAGS LIVE INSIDE THIS ONE and neither means anything without it: `EQC_ENGINE_SERVE`
// lets the engine answer the app's READS (serveShim.ts for the answers, serveDeltas.ts for the
// notification that there is a newer one), and `EQC_ENGINE_ALERTS` lets it make a SOUND
// (alertsAudio.ts). Both default ON beside this one and both are taken away the same way, by `=0`
// — which is what makes "is this the serve path or the audio path?" two launches rather than a
// build. They are read by their own files and reached only from inside the guard below, which is
// the same one-gate rule the client and the broker keep: this file decides whether there is an
// engine at all, and nothing else re-asks that question.
//
// AND SINCE JOS-479 THE FLAG BUYS ONE MORE THING: the app's own CLIENT. `engineClientHost.ts`
// connects to the launch this file supervises, attaches the engine to the log this process is
// tailing, and runs the parity probe. It is armed from inside the guard below and torn down beside
// the supervisor, so `EQC_ENGINE` remains the single switch for the whole feature — a second gate
// would be a second thing to forget.
//
// WHAT IT LOOKS LIKE WITH NO BINARY — UNCHANGED BY THE FLIP, AND THAT IS THE POINT. The supervisor
// probes, finds nothing, logs one line naming what it looked for, and stops. No error-store entry,
// no retry storm, no crash. Absence is a CONDITION here, not a failure. Which of the two worlds a
// launch is therefore in is decided by the DISK and not by the flag, and the two answers are:
//   * A DEV CHECKOUT THAT HAS NOT RUN `cargo build` gets exactly the app it got before this ticket
//     — TypeScript fold, TypeScript reads, TypeScript alerts — because default-on asks for an
//     engine that is not there and gets the same silent nothing it always did. Nobody has to know
//     the default moved to keep working in this tree.
//   * A PACKAGED BUILD HAS THE BINARY, always, and has since JOS-473 (`extraResources` copies
//     `resources/engine/engined.exe` beside the asar, the first path `engineBinaryCandidates`
//     probes, and `build:engine` fails the build rather than shipping without it). So default-on in
//     a shipped app means the engine actually runs, which is the entire content of this ticket.

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { logError, logInfo } from '../errorLog'
import { E2E } from '../e2e'
import { setEnginePid } from '../processPriority'
import { noteEngineEdge } from '../telemetry/breadcrumbs'
import { mintToken } from './token'
import { engineBinaryCandidates, isCargoTargetBinary, stagedEngineNames } from './engineProtocol'
import { connectToEngine } from './socketChannel'
import {
  createEngineSupervisor,
  type EngineStatus,
  type EngineSupervisor,
  type SupervisedChild
} from './supervisor'
// THE APP'S OWN CLIENT (JOS-479, phase 3). It lives behind THIS file's flag and nothing else, which
// is why it reads no environment variable of its own: one gate, in one place.
import { installEngineClient, onEngineReady, stopEngineClient } from './engineClientHost'
// THE RENDERERS' OWN CLIENTS (JOS-484, phase 3), behind THIS file's flag as well. The broker holds
// no flag of its own either — it simply never learns about a launch, so its IPC handler refuses.
import { noteEngineLaunch, stopRendererBroker } from './rendererBroker'
// THE AUDIO CUTOVER (JOS-491), behind THIS file's flag plus one of its own. It is armed and
// disarmed beside the supervisor for the reason the client is: one lifecycle, one place.
import { armEngineAlerts, disarmEngineAlerts } from './alertsAudio'
// THE LAUNCH, AS THE SHELL SEES IT (JOS-503). One object, pushed on change; this file feeds it the
// two edges only the supervisor has — a launch beginning, and a diagnosis that has stopped changing.
import {
  noteEngineCandidates,
  noteEngineFault,
  noteEngineRetrying,
  noteEngineStarting
} from './engineLaunchState'

/** How long a loopback connect may take before the probe gives up on it. Loopback either answers
 *  immediately or is not listening; this is a bound on the pathological case, not a budget. */
const CONNECT_TIMEOUT_MS = 2_000

/** The one instance. Module-level like every other singleton in `src/main`, because there is one
 *  app and one engine; the CLASS is per-instance so tests never see this. */
let supervisor: EngineSupervisor | null = null

/**
 * Is the engine wanted on this launch at all? ONE variable, read at boot — and WANTED BY DEFAULT
 * since JOS-495, so the honest reading of this function is "did anybody ask for it to be gone?".
 *
 * Answering `true` is not a claim that an engine EXISTS: `engineSupervisorStatus()` below
 * distinguishes the two absences, and the header says why a checkout with no binary is the ordinary
 * state rather than a broken one.
 */
/**
 * THE FLAG IS GONE (JOS-499 item 9), and what replaces it is nothing rather than `true`.
 *
 * `EQC_ENGINE=0` meant "run the app on its own fold". The fold is deleted, so the configuration
 * it selected does not exist: a launch without an engine is not a different MODE of the product,
 * it is the product unable to answer, which this release makes honest everywhere a read lands.
 * Keeping the variable would ship a switch whose only remaining effect is a blank app.
 *
 * WHAT STILL DISTINGUISHES THE ABSENCES is `engineSupervisorStatus()` below, and it is now the
 * only thing that has to: `'absent'` is a build carrying no binary — the ordinary state of a
 * checkout that has not run `cargo build` — and every other status is a real engine somewhere in
 * its life. There is no third case left to report.
 */
export function engineWanted(): boolean {
  return true
}

/**
 * Where the engine supervisor is right now — `null` when this launch never wanted one.
 *
 * THE PERFORMANCE PANEL'S GATE (JOS-483), and the two absences it distinguishes are the whole
 * reason it returns a union rather than a string. `null` means somebody turned the flag OFF, so
 * there is no feature to show — a rarer answer since JOS-495 and a louder one, because it can now
 * only be a deliberate `EQC_ENGINE=0`. `'absent'` means the engine is wanted and this build carries
 * no binary, which is the
 * ORDINARY state of a checkout that has not run `cargo build` — and drawing an ENGINE section
 * there would be showing the owner a row of dashes for a process that was never going to exist.
 * Every other status is a real engine at some point in its life, and the panel draws it.
 */
export function engineSupervisorStatus(): EngineStatus | null {
  return supervisor?.currentStatus() ?? 'stopped'
}

/**
 * Find the engine binary, or say there is none.
 *
 * A PROBE, not a guess — `sounds.ts bundledRoots()`'s precedent, and for its reason: one source
 * tree produces a dev run, an e2e build and a packaged app, and which one is running is not
 * something a module can read off its own path. The candidate list and its ORDER live in
 * `engineProtocol.ts` (pure, and therefore pinned by a test); the `existsSync` is here, because
 * touching the disk is exactly the kind of thing the pure half must not do.
 *
 * It NARRATES ITS OWN FAILURE. A resolver that answers null in silence is how "the feature is off"
 * and "the feature is broken" become the same observation; naming every path it looked at makes
 * the dev's next move obvious (`cargo build -p engined`).
 */
function resolveEngineBinary(): string | null {
  const candidates = engineBinaryCandidates({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath ?? '',
    cwd: process.cwd(),
    // THE HARNESS NAMES ITS OWN BINARY (JOS-501), and only the harness: read under `EQ_E2E=1`
    // alone, the same standing the staged EQ install has. The e2e suite builds the engine in
    // RELEASE and the candidate order below prefers debug, so without this a machine holding both
    // would run the suite against the binary the suite did not build. Not a gate — an absent or
    // wrong value simply falls through to the ordinary search.
    override: E2E ? (process.env.EQ_ENGINE_BIN ?? '') : ''
  })
  // THE SAME LIST THE NARRATION USES, KEPT FOR THE PERSON (JOS-503). "Where it looked" is the
  // actionable half of an absence — it is how somebody discovers their antivirus took the file out
  // of a directory they can go and check — and until now it existed only in a dev-log line that
  // `engine-absent.e2e.mts` measured as unreadable even to a test. Recorded on EVERY resolution,
  // including the successful ones, because a retry that succeeds must not leave a stale list behind.
  noteEngineCandidates(candidates)
  const found = candidates.find((path) => existsSync(path))
  if (found === undefined) {
    logInfo(`[everquest-companion] engine binary not found; looked in: ${candidates.join(', ')}`)
    return null
  }
  // A CARGO-BUILT BINARY IS RUN FROM A COPY — see `stageDevBinary` for the whole argument. The
  // packaged path never reaches it, and a copy that could not be made falls through to the original,
  // which is exactly the behaviour every launch before JOS-496 had.
  return isCargoTargetBinary(found) ? stageDevBinary(found) : found
}

// ------------------------------------------------------------------ the dev copy (JOS-496)
//
// WHY THIS EXISTS, IN ONE SENTENCE: Windows locks the image file of a running process, so an app
// that spawns `engine/target/debug/engined.exe` makes `cargo build -p engined` fail at the LINK
// step for as long as the app is up.
//
// THAT IS NOT A THEORETICAL TOLL. The owner's dev app runs all day by design (the ENGINE-BY-DEFAULT
// checkout), and every worker in this program builds the engine; before this, the two could not both
// be true, and the workaround was "close the app, build, reopen it" performed by hand, repeatedly,
// by whoever remembered. Copying the image once per launch removes the conflict at its cause: the
// process holds a lock on the COPY, and the path cargo writes to is never open.
//
// IT IS CHEAP AND IT IS BOUNDED. One `copyFileSync` of a file the OS has in its cache moments after
// a build, once per LAUNCH (not per request, not per attach) — tens of milliseconds for a debug
// build, and it happens on the supervisor's own path before any socket exists, so nothing waits on
// it. The directory is swept at every app start, so a checkout never accumulates images.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   * IT DOES NOT TOUCH THE PACKAGED LAUNCH. `isCargoTargetBinary` is the gate and it is spelled
//     against cargo's own output directories, so a shipped `resources/engine/engined.exe` is spawned
//     exactly as it was — the same bytes JOS-473 signed, from the same path, with the same cwd.
//     A staged copy of a signed binary would be a second file for the AV heuristics and the
//     signature checker to have opinions about, for no benefit at all: nothing overwrites it.
//   * IT DOES NOT COPY ANYTHING BESIDE THE EXECUTABLE. That is not an omission — it is the shipped
//     arrangement, restated: `extraResources` puts `engined.exe` alone under `resources/engine/`
//     and that build runs, so a lone image is known to resolve its imports. The `cwd` the spawn
//     gives it is the staging directory rather than the cargo one, which matches the packaged
//     launch's own `cwd` discipline (AGENTS.md's DLL-resolution law) rather than diverging from it.
//   * IT DOES NOT FAIL A LAUNCH. Every error here is a dev-log line and a fall-through to the
//     original path — the pre-JOS-496 behaviour — because a copy is an ergonomic convenience and an
//     app that refused to start its engine over one would have traded a build annoyance for an
//     outage.

/** Where the copies live. Under `userData` rather than the OS temp directory on purpose: the app
 *  already owns this tree, it is not swept by anything else mid-session, and an executable a machine's
 *  temp cleaner can delete out from under a running process is a crash waiting for a slow week. */
function stagingDir(): string {
  return join(app.getPath('userData'), 'engine-run')
}

/**
 * Drop whatever a previous launch left behind. BEST EFFORT AND SILENT ON FAILURE, which is the
 * point: a copy still locked by an engine that outlived its app simply refuses to be deleted, and
 * the staging below will pick the next name. Called once per app start.
 */
function sweepStaging(dir: string): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      // Locked, or gone since the listing. Either way it is not this launch's copy yet.
    }
  }
}

/** True once the sweep has run — it is about the DIRECTORY's history, so it happens once per app
 *  rather than once per launch attempt (a crash loop must not keep re-sweeping the copy it is
 *  about to spawn). */
let swept = false

/**
 * Copy the cargo binary somewhere cargo does not write, and answer where. Falls back to `binPath`
 * itself whenever the copy cannot be made — see the section header for why that is the right
 * failure.
 */
function stageDevBinary(binPath: string): string {
  const dir = stagingDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    logInfo(`[everquest-companion] data-server engine: no staging directory (${describeErr(err)}); running the cargo binary in place`)
    return binPath
  }
  if (!swept) {
    swept = true
    sweepStaging(dir)
  }
  // THE NAMES ARE TRIED IN ORDER and the first that copies wins — see `stagedEngineNames` for what
  // the later ones are for. A failure here is almost always EBUSY/EPERM against a child that has
  // not exited yet, which is a fact about THIS name and not about the directory.
  let lastErr: unknown = null
  for (const name of stagedEngineNames()) {
    const dest = join(dir, name)
    try {
      copyFileSync(binPath, dest)
      logInfo(`[everquest-companion] data-server engine: running a copy at ${dest} so cargo can relink ${binPath}`)
      return dest
    } catch (err) {
      lastErr = err
    }
  }
  logInfo(`[everquest-companion] data-server engine: could not stage a copy (${describeErr(lastErr)}); running the cargo binary in place — a build will fail to link while this app is up`)
  return binPath
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Spawn the engine.
 *
 * NO SECRETS IN ARGV OR ENV (contract rule 1): no arguments at all, and the environment is
 * inherited untouched. The token goes down stdin, which is why all three streams are pipes.
 *
 * `windowsHide` so a console window never flashes over a full-screen game — the same courtesy every
 * other child this app has ever spawned was given. `cwd` is the binary's own directory, matching
 * the DLL-resolution law in AGENTS.md: a shipped native binary resolves its imports from its own
 * directory, so that is where it should be standing.
 */
function spawnEngine(binPath: string): SupervisedChild {
  return spawn(binPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: dirOf(binPath)
  })
}

/** The directory part of a path, with either separator. Two lines rather than a `node:path` import
 *  because `engineBinaryCandidates` builds these strings with `/` and `dirname` on Windows is happy
 *  with both — this keeps the two halves spelling paths the same way. */
function dirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut === -1 ? '.' : path.slice(0, cut)
}

/**
 * Start the supervisor, if this launch wants an engine.
 *
 * Called from the composition root beside `startTailing`. Idempotent: a second call while one is
 * running is the supervisor's own no-op.
 */
export function startEngineSupervisor(): void {
  // THE AUDIO CUTOVER'S SWITCH IS NOT THROWN HERE ANY MORE (JOS-496 fixing JOS-491's placement) —
  // it is thrown on the supervisor's READY edge below. The bug, measured by reading:
  //
  //   `armEngineAlerts()` used to be called on this line, BEFORE any binary had been probed for. It
  //   gates on `EQC_ENGINE_SERVE` and `EQC_ENGINE_ALERTS`, both DEFAULT-ON since JOS-495, so on a
  //   dev checkout that has never run `cargo build` it armed — and arming calls
  //   `alertsModule.setEngineOwnsAudio(true)`, which makes this process's own `publish` a no-op. No
  //   binary means no client, no client means no `fire` frame, ever. So the app silenced its own
  //   evaluator in favour of an engine that did not exist and PLAYED NO ALERTS AT ALL until quit,
  //   with `disarmEngineAlerts()` unreachable before `stopEngineSupervisor()`.
  //
  // It contradicted this file's own header, which promises a cargo-less checkout "exactly the app it
  // got before this ticket — TypeScript fold, TypeScript reads, TypeScript alerts". The same state
  // is reachable in a packaged build whose engine fails to spawn or enters the crash-loop backoff.
  //
  // THE FLAG WAS NEVER THE RIGHT QUESTION. "Did anybody ask for the engine to be gone" is not "is
  // there an engine", and every publisher handed off on the first answer goes silent when the second
  // is no. The con card had the identical defect in this same ticket (`conCard.ts
  // registerConCardIpc`); this is the third instance of the shape and the only one that was already
  // shipping.
  //
  // ARMED BEFORE THE SUPERVISOR CAN REACH READY. `installEngineClient` only registers the
  // world-rebuilt observer — it opens no socket — but the TypeScript fold can land at any moment
  // and a rebuild that arrived before the observer existed would be a rebuild the client never
  // hears about, i.e. an engine that stays pointed at nothing until the next character switch.
  installEngineClient()
  supervisor ??= createEngineSupervisor({
    resolveBinary: resolveEngineBinary,
    spawn: spawnEngine,
    connect: (port) => connectToEngine(port, CONNECT_TIMEOUT_MS),
    mintToken,
    // UNREF'D, ALWAYS. Nothing this supervisor holds may be the reason a quitting process stays
    // alive — `presence.ts`'s rule for its restart timer, and the same hazard: a 30 s backoff timer
    // armed at the moment the user hits X would otherwise hold the app open for 30 seconds.
    timer: (fn, ms) => {
      const handle = setTimeout(fn, ms)
      handle.unref?.()
      return () => clearTimeout(handle)
    },
    now: () => Date.now(),
    debug: (line) => logInfo(`[everquest-companion] ${line}`),
    // The name/message/code triple `engineProtocol.ts` built. `logError` reads `name`, `message`,
    // `stack` and `code` off whatever it is handed (`caughtFields`), which is the whole reason the
    // supervisor reports an OBJECT rather than an Error — see childProcessGone.ts's header for the
    // five releases that lesson cost.
    report: (log) => logError('main:dataServerEngine', log),
    // The priority arm. Below-normal, following the same switch as the rest of the app — the
    // argument is on `setEnginePid` in processPriority.ts.
    onPid: (pid) => {
      setEnginePid(pid)
      // A BREADCRUMB FOR THE BOOT WINDOW (JOS-501). This is the earliest thing this process can
      // say about an engine, and until now nothing said anything until the first module cursor
      // moved — which on the owner's real log is the better part of a minute in. Every crash
      // before that produced a report with an empty ring. The pid itself is NOT recorded: the
      // edge is the fact, and `noteEngineEdge` has no parameter one could travel in.
      noteEngineEdge(pid === null ? 'engine:gone' : 'engine:spawned')
    },
    // …and the CLIENT arm (JOS-479): the port and the launch's token, at the one moment a round
    // trip has proven there is something to talk to. `onPid` is about a process and this is about a
    // connection — see the dep's own comment for why they are two callbacks rather than one.
    // TWO READERS OF ONE EDGE, and they are told in this order on purpose. The broker's half is
    // DESTRUCTIVE — every port a renderer is holding names a process that no longer exists — so the
    // stale connections are taken away before the app's own client starts building a new one and
    // renderers begin asking for replacements. Neither reader waits on the other; the supervisor
    // waits on neither.
    onReady: (info) => {
      noteEngineLaunch(info)
      // THE SOUND FOLLOWS THE LAUNCH (JOS-496). This is the edge that means "there IS an engine and
      // a round trip has proven it" — not a process that started, and emphatically not a flag — so
      // it is the earliest moment the handoff can be made honestly. `null` is the same edge in the
      // other direction and gives the sound straight back, which is what makes a crash-loop, a
      // failed spawn and a wedged engine all end in an app that still plays its own alerts.
      //
      // STILL BEFORE ANYTHING CAN FIRE, which was the original placement's one good reason: the
      // client that will hear a `fire` frame is opened by `onEngineReady` on the line below, so the
      // swap is complete before a frame can exist. That is the whole of what "must not be late"
      // needed, and it never needed to be this early.
      //
      // IT IS STILL A LAUNCH-SHAPED EDGE, and that matters for `alertsAudio.ts`'s own argument that
      // the verdict is taken ONCE rather than re-asked mid-session ("a gate that re-opened
      // mid-session would mean the app could start playing from the engine halfway through a
      // raid"). A respawn IS a launch (contract rule 5), so arming per launch keeps that property;
      // arming on, say, the engine's fold going live would not.
      //
      // THE RESIDUAL, NAMED: between READY and the engine's own fold going live, this process's
      // evaluator is silent and the engine's has not reached the tail. A live line in that window
      // fires in neither world — the engine meets it during its historical catch-up, where it is
      // not live and does not fire. That window is bounded by the fold and is STRICTLY SMALLER than
      // the one shipping today (which began at process start); closing it entirely means arming on
      // go-live, which trades this gap for the mid-session re-opening the file argues against. Left
      // as an owner call rather than decided here.
      if (info === null) disarmEngineAlerts()
      else armEngineAlerts()
      // READY means a round trip ANSWERED, which is the one edge in this flow worth a crumb of its
      // own: a report whose ring shows `engine:spawned` and no `engine:ready` says the child
      // started and never proved itself, and that is a different bug from one that never spawned.
      if (info !== null) noteEngineEdge('engine:ready')
      // …AND THE SHELL IS TOLD A LAUNCH IS UNDER WAY (JOS-503). Both edges say the same thing to a
      // window: nothing to draw yet. `noteEngineStarting` deliberately cannot take a standing card
      // down — see its own comment for why a crash loop would otherwise flicker one.
      noteEngineStarting()
      onEngineReady(info)
    },
    // THE DIAGNOSIS, WHEN IT HAS STOPPED CHANGING (JOS-503). Fires twice at most in a session and
    // is what puts the failure card on screen; `null` is a launch that reached READY and takes it
    // back off. The candidate paths are grafted on inside `noteEngineFault` from the list above.
    onFault: (fault) => {
      noteEngineFault(fault)
    }
  })
  supervisor.start()
}

/**
 * TRY AGAIN — the failure card's button, arriving over `IPC.engineRetry` (JOS-503).
 *
 * The card comes down FIRST and unconditionally, before anything is asked of the supervisor: a
 * person who clicked a button is owed an immediate answer, and if the retry fails the same way the
 * fault edge will put the card straight back with a fresh count. A retry on a launch that never
 * started one at all (no supervisor — this is only reachable before `startEngineSupervisor`) is a
 * no-op rather than an error, because there is nothing for it to be wrong about.
 */
export function retryEngineSupervisor(): void {
  noteEngineRetrying()
  supervisor?.restart()
}

/**
 * Stop the engine. Called from BOTH quit paths through `teardownStep`, for `stopPresenceEffects`'s
 * reason exactly: `window-all-closed` is the ordinary teardown but an auto-updater's
 * `quitAndInstall`, an `app.quit()` from anywhere, or an OS logoff can reach `before-quit` on a
 * path that never lands there — and a CHILD PROCESS is the case Windows does not clean up for us.
 * Idempotent, so running it twice costs one `end()` on a closed pipe.
 *
 * IT DOES NOT WAIT. Closing stdin is the shutdown signal and the engine exits on its own; the
 * escalation to `kill` is armed on an unref'd timer inside the supervisor. Blocking quit on a
 * child's exit is how a wedged child becomes a window that will not close.
 */
export function stopEngineSupervisor(): void {
  // THE SOUND COMES BACK FIRST (JOS-491). An engine that is being stopped is about to stop firing,
  // and an app left silenced by a departed evaluator would be an app with no alerts at all — the
  // one failure this whole feature must never produce. It is the reverse of the arm order for the
  // same reason the client closes before the engine does: nothing is left depending on a thing that
  // has already gone.
  disarmEngineAlerts()
  // THE CLIENT GOES NEXT, and the order is the same courtesy the supervisor extends to the engine:
  // closing our socket before closing the engine's stdin means the engine sees a client leave and
  // then a shutdown, rather than being asked to exit while a connection is still open. Idempotent
  // and safe on a launch that never armed a client.
  stopEngineClient()
  // …and the renderers' connections, for the same courtesy and in the same direction: every client
  // lets go before the engine is asked to exit. A window that is still up simply finds its channel
  // closed, which is a state its view already draws.
  stopRendererBroker()
  supervisor?.stop()
  setEnginePid(null)
}
