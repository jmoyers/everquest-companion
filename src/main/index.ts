// ============================================================================
// index.ts — the main process's COMPOSITION ROOT.
// ============================================================================
//
// Everything this file does is ORDERING. The pieces themselves live next door:
//
//   channel.ts     which `userData` dir this process gets (prod / dev / e2e) + the one-time
//                  state seed. FIRST import, always.
//   crashGuards.ts process-level uncaught-error capture. Second, so it covers every module
//                  body that follows.
//   pipeline.ts    the log-derived world: LogBus, module registry (+ REGISTRATION ORDER),
//                  combat engine, epoch detector, spell DB.
//   session.ts     the active character's lifetime: scan → live tail, heartbeat, inventory
//                  watch, EQ-dir changes.
//   windows.ts     every BrowserWindow (main + overlays) and the Electron-side trust boundary.
//   ipc/           the IPC surface, one module per domain.
//
// What remains here is the sequence those pieces must be assembled in, and the app lifecycle
// that drives it. FOUR orderings are load-bearing and are called out at their call sites:
// the first-import law, the epoch subscription being the LAST bus subscriber,
// `registerSchemesAsPrivileged` running at module scope (before `ready`), and graphics safe mode
// being applied at module scope for the same before-`ready` reason (graphics.ts).

// FIRST import on purpose: channel.ts picks this process's `userData` dir (prod / dev /
// e2e — Task #58) and runs the one-time state seed, before electron-store is constructed
// (module-level) further down this import list.
import { CHANNEL, USER_DATA } from './channel'
// SECOND on purpose: installs the uncaughtException/unhandledRejection sinks before any
// module body below can throw. See crashGuards.ts.
import './crashGuards'
import { E2E } from './e2e'
import { OWNER_TOOLS } from './ownerTools'
import { app, BrowserWindow, protocol, session } from 'electron'
import { IPC } from '../shared/ipc'
import { errorLogPath, logError, logInfo } from './errorLog'
import { saveUserOverlay } from './data/overlayPersistence'
import { startQueueFlush, stopQueueFlush } from './feedback'
import { startTelemetry, stopTelemetry } from './telemetry'
import { registerAppSchemes } from './appSchemes'
import { applyGraphicsSafeMode } from './graphics'
import { installImageCacheProtocol } from './imageCache'
// The wiki art this build SHIPS (JOS-198). Pure path probing — Electron's three path facts are
// passed in below, so the module itself imports nothing from electron.
import { bundledImageRoots, findBundledImagesDir } from './bundledImages'
import { installSpeechCacheProtocol } from './speech/cache'
import { registerIpc } from './ipc'
import { DATA_READY_MS, bus, buffsModule, epoch, sendWorldRebuilt, sessionDetector } from './pipeline'
import { markStartupPhase, startPerfSampler, stopPerf } from './perf'
import { initPresenceEffects, stopPresenceEffects } from './presenceEffects'
import { provisionDefaultPacks } from './provisionPacks'
import { getActiveCharacter, startTailing, stopSession } from './session'
import { runSmokeFeedback } from './smokeFeedback'
import { STORE_READY_MS, getOverlayConfig, getPerfHudPrefs } from './store'
import { initUpdater } from './updater'
import {
  createMainWindow,
  createOverlayWindow,
  getMainWindow,
  hardenSession,
  hardenWebContents,
  reconcileOverlayDisplays,
  sendToMain
} from './windows'
import { watchDisplays } from './windowPlacement'
import { OVERLAY_KINDS } from '../shared/types'

// --- custom schemes: the permanent image cache (eqimg://) and the speech cache (eqspeech://) ---
// Scheme privileges MUST be declared before the app's `ready` event, so this runs at module
// scope; each handler itself is installed in whenReady below. Electron permits exactly ONE
// registerSchemesAsPrivileged call, which is why both schemes go through appSchemes.ts.
registerAppSchemes(protocol)

// --- graphics safe mode (JOS-40) ---
// FIRST STATEMENT OF THE BODY, and at module scope for a hard reason: Electron reads
// `disableHardwareAcceleration()` while it assembles the GPU process and ignores every call that
// arrives after `ready`. The imports above have already run, so the settings store is open and
// migrated by now (channel.ts → store.ts, the first-import law) and this can consult a PERSISTED
// switch at a point that precedes the app itself. `EQ_DISABLE_GPU=1` forces it for one launch
// without any UI, which is the case it exists for: you cannot open Preferences in a window you
// cannot see. All of the reasoning lives in graphics.ts.
applyGraphicsSafeMode()

// Cold-start stopwatch: module scope is the earliest this process can measure from, and the
// number is bucketed (never sent raw) into `sessionStart` when the window exists. See
// src/shared/telemetry.ts COLD_START_MS_EDGES.
const PROCESS_START_MS = Date.now()

// --- startup profile, phases 1 and 2 (docs/plans/perf-profiling.md P4) ---
//
// MARKED ON EVERY LAUNCH, HUD or no HUD: a mark is an array push, and the launch you wish you
// had profiled is always the one that already happened.
//
// These two are marked with the timestamps their OWN modules recorded, not with "now", because
// both finished during module EVALUATION — before this statement, and long before Electron's
// `ready`. The plan listed `appReady` first; the tree says otherwise, and a phase order that
// disagrees with the boot it describes would put three zeroes in the breakdown and hide the real
// cost of opening the store and parsing the spell DB inside `appReady`. Measured beats guessed
// (see shared/perf.ts STARTUP_PHASES for the full table).
markStartupPhase('storeLoaded', { atMs: STORE_READY_MS })
markStartupPhase('dataLoaded', { atMs: DATA_READY_MS })

// Epoch detection subscription (Task #49; launch-anchored in Task #50). Runs LAST — after
// pipeline.ts's registry + combat subscriptions, which is why it is added here rather than
// there — so it observes each event after the modules/combat have folded it, then at the
// first at/after-launch event queues a derived `epoch` event via emitDerived; the bus
// delivers that to EVERY listener (registry modules + combat) after the primary event
// finishes — the modules reset their live folded state on it. Ignore the derived epoch event
// itself here (the detector already ignores it internally too) so no feedback loop is
// possible, matching the buffs→buffExpired contract.
bus.subscribe((ev, live) => {
  if (ev.kind === 'epoch') return
  const epochEv = epoch.observe(ev)
  if (epochEv) {
    logInfo(
      `[everquest-companion] Character epoch boundary detected at ${new Date(epochEv.ts).toISOString()} (official launch): resetting character-scoped modules. Everything before this belongs to a prior same-name character wiped at launch (see epochDetector.ts).`
    )
    bus.emitDerived(epochEv, live)
    // A LIVE wipe (rare — deleting + recreating your character while the app tails) shrinks
    // every module's state, but module deltas are append/merge-only (a shrink can't be
    // expressed as a delta), so the renderer would keep the stale pre-epoch rows. Re-send
    // onCharacter so every useModule view RE-HYDRATES from the (now post-epoch) snapshots —
    // the same full-rebuild path a character switch uses. Deferred to a microtask so the
    // derived epoch event finishes draining to the modules (they reset) BEFORE the renderer
    // re-fetches their snapshots. During a rescan (live:false) the post-scan onCharacter send
    // in tailCharacter already covers this, so we only do it live.
    // …and to the module-reading OVERLAYS as well as the main window (JOS-172): they fold the
    // same modules and have the same nothing-but-deltas problem, so one signal, one list
    // (pipeline.ts `sendWorldRebuilt`).
    if (live) queueMicrotask(() => { sendWorldRebuilt(getActiveCharacter()) })
  }
})

// Offline-gap subscription (login/logout). Same position and same contract as the epoch
// subscription above and for the same reason: it must observe each event only after the
// modules and the combat engine have folded it, then hand its synthesized `offlineGap` back
// through emitDerived so the bus delivers it once the primary `sessionStart` has finished
// reaching everyone. Unlike the epoch, this fires repeatedly (15 times over the real log's
// 19 logins), so it does NOT force a renderer re-hydrate — modules fold a gap as an ordinary
// event and express the result through their normal deltas. The detector filters derived
// kinds itself; the guard here mirrors the epoch subscription so the no-feedback-loop
// contract is visible at the call site rather than only inside the class.
bus.subscribe((ev, live) => {
  if (ev.kind === 'offlineGap') return
  const gap = sessionDetector.observe(ev)
  if (gap) bus.emitDerived(gap, live)
})

// ---------------------------------------------------------------------------------------
// DEV-ONLY: the feedback-triage IPC surface (src/main/triage/**).
// ---------------------------------------------------------------------------------------
//
// This is the operator's window onto the feedback backlog — the same Aurora DSQL rows and S3
// slices `scripts/triage-feedback.mts` reads, over the same IAM door. It exists in the OWNER's
// dev app and nowhere else, and there are THREE independent reasons a shipped build cannot
// reach it:
//
//   1. THIS GATE, which is `OWNER_TOOLS` since JOS-72 (src/shared/ownerTools.ts) and no longer
//      "am I a dev build?". `app.isPackaged` is false in a dev run — but it is also false in a
//      SELF-COMPILED build from this public repo, which is how a stranger's macOS recompile
//      ended up with the owner's backlog tab in its nav drawer. So the predicate now also
//      requires `EQ_OWNER_TOOLS=1`, which no fresh checkout has; `E2E` still excludes the
//      headless harness, which builds production-shaped and must stay off the network. The
//      import is DYNAMIC, so a build without the opt-in never even evaluates the module.
//   2. THE DEPENDENCIES. That module reaches `pg` and `@aws-sdk/*` — devDependencies, which
//      electron-builder never packages. A build with this gate patched out still could not
//      resolve them. The property is structural, not a runtime check.
//   3. THE CREDENTIALS. Auth is an IAM token derived locally from the LAUNCHING SHELL's AWS
//      profile (AWS_PROFILE, default 'eqc'). There is no password to leak, and a shell without
//      the owner's credentials gets IAM denials on the first statement.
//
// Failure to load is logged and startup continues: a dev tool must never be able to take the
// app down. `closeDevTriage` is the teardown — a live DSQL socket would otherwise hold the
// process open, the same hang the CLI's `finally` exists for.
let closeDevTriage: (() => Promise<void>) | null = null

function registerDevTriageIpc(): void {
  if (!OWNER_TOOLS) return
  void import('./triage/ipc')
    .then(({ registerTriageIpc }) => {
      closeDevTriage = registerTriageIpc()
      logInfo(
        '[everquest-companion] Owner triage IPC registered (EQ_OWNER_TOOLS=1, AWS profile auth).'
      )
    })
    .catch((err: unknown) => logError('main:triage', err))
}

// Single-instance lock (Task #23): a second launch (e.g. re-running the installed
// app, or an auto-update restart) must not spin up a second window tailing the same
// log. If we don't get the lock, quit immediately; the primary instance receives a
// `second-instance` event and focuses/restores its existing window instead.
// The lock is PER CHANNEL, for free: Chromium keys it off the user-data dir, which
// channel.ts has already made distinct per channel — so the installed app and the dev
// app each hold their own lock and run side by side (Task #58).
// E2E: skip the lock entirely (never request it), so a headless test instance can run
// alongside the user's dev app instead of quitting — and can't steal its focus either.
const gotSingleInstanceLock = E2E || app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    markStartupPhase('appReady')
    logInfo(
      `[everquest-companion] Channel '${CHANNEL}' - userData ${USER_DATA}, error log ${errorLogPath()}`
    )
    registerIpc()
    registerDevTriageIpc()
    // Trust boundary, installed BEFORE the first window exists: the catch-all fires for every
    // webContents this process will ever create (main window, each overlay, anything a future
    // feature adds), which is the only placement that can't be forgotten later.
    app.on('web-contents-created', (_e, wc) => hardenWebContents(wc))
    // Permissions are a SESSION property; every window here uses the default session (no
    // custom `partition` anywhere — the same fact that lets one eqimg:// handler serve them all).
    hardenSession(session.defaultSession)
    // Serve `eqimg://item/<id>` BEFORE any window loads a page that can reference an item icon.
    // One handler on the default session covers the main window and every overlay (none of them
    // use a custom partition). Since JOS-198 the FIRST place it looks is the art this build
    // ships — `resources/wiki-images/`, whose three possible addresses (project root in dev and
    // e2e, inside the asar, beside it once unpacked) are probed here rather than guessed at in
    // the cache. A build without it resolves to null and falls back to the runtime cache,
    // exactly as before.
    const bundledDir = findBundledImagesDir(
      bundledImageRoots({
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath ?? '',
        cwd: process.cwd()
      })
    )
    logInfo(
      `[everquest-companion] Bundled wiki images: ${bundledDir ?? 'none (falling back to the runtime cache)'}`
    )
    installImageCacheProtocol(protocol, {
      userData: USER_DATA,
      bundledDir,
      onError: (msg, err) => logError('main:imageCache', { message: msg, err })
    })
    // …and `eqspeech://<hash>` from <userData>/speech-cache, beside it and for the same
    // reason: one read-only handler on the default session serves every window. It NEVER
    // synthesizes and never touches the network — only `speech:say` can cause a synthesis
    // (see speech/cache.ts).
    installSpeechCacheProtocol(protocol, {
      userData: USER_DATA,
      onError: (msg, err) => logError('main:speechCache', { message: msg, err })
    })
    markStartupPhase('protocols')
    createMainWindow()
    markStartupPhase('windowCreated')
    // `replayDone` is the LONG one on a real log (a full historical scan), so it is marked when
    // the session's promise settles — with the event count, because "6 s" means something very
    // different for 40k events than for 1.1M. `tailAttached` is marked immediately after the
    // call: the composition root's own step is handing the session its work, and everything the
    // scan then does belongs to the phase that names it. A failed attach still marks the phase
    // (with no count) rather than leaving the profile forever incomplete.
    void startTailing()
      .then((res) => {
        markStartupPhase('replayDone', {
          eventsReplayed: res?.eventsReplayed ?? 0,
          // …and what the fold's duty cycle actually cost (JOS-50), plus how many bytes it read
          // (JOS-57, the fleet reading's size bucket). Both absent on a machine with no log to
          // replay, where there was no fold to have a duty and no bytes to have a size.
          ...(res ? { replay: res.replay, bytesReplayed: res.logBytes } : {})
        })
      })
      .catch((err: unknown) => {
        markStartupPhase('replayDone')
        logError('main:startTailing', err)
      })
      // The post-release smoke hook (src/main/smokeFeedback.ts). A NO-OP on every launch that
      // is not one: without `EQ_SMOKE_FEEDBACK` in the environment it returns before touching
      // anything, and it refuses outright under EQ_E2E. When it IS armed it files exactly one
      // bug report through `submitFeedback` — the same call the dialog's Send button makes,
      // through every normal layer — and then quits.
      // HERE, chained off `startTailing`, because the report attaches a LOG SLICE: the active
      // character has to be resolved and the first scan settled before there is anything to
      // slice. `.finally` rather than `.then` so a scan that failed still leaves the harness a
      // verdict instead of a VM that hangs until the host's timeout.
      .finally(() => {
        void runSmokeFeedback()
      })
    markStartupPhase('tailAttached')
    // Drain the offline feedback queue (feedback/queue.ts). A report filed while the user's
    // network was unhappy is spooled to <userData>/feedback.json + feedback-pending/*.gz and
    // sent later over the same wire, carrying the same idempotency key; without this call it
    // would spool until it aged out unsent. Started HERE, right after the tail attaches,
    // because the first drain is deliberately +30 s behind startup (then every 30 min) and the
    // timers are unref'd, so it can neither compete with the replay nor hold the process open.
    // The E2E / no-endpoint guards live inside `startQueueFlush` (one predicate,
    // `queueFlushEnabled` in net.ts, shared with `flushQueue`) rather than being restated
    // here — two copies of a network gate is how one of them drifts.
    startQueueFlush()
    // Usage analytics (docs/plans/usage-analytics.md wave A1), started right beside the feedback
    // drain and for the same reasons: after the window exists, timers unref'd, and every gate
    // inside `startTelemetry` rather than restated here.
    //
    // WHAT THIS STARTS: an analytics id if the user's switch is on, a `sessionStart` record, a
    // 5-minute heartbeat into the ring at <userData>/telemetry.json — and, ONLY once every gate
    // is open, the 60 s flush loop that POSTs to the compiled-in endpoint. The flush timer is
    // not created at all under `EQ_E2E=1`, with the switch off, or before the first-run notice
    // has rendered (`telemetryFlushEnabled`, telemetry/net.ts); when the notice is answered
    // mid-session the loop starts then, not next launch. Same predicate discipline as
    // `queueFlushEnabled` — one gate, in one place.
    startTelemetry(Date.now() - PROCESS_START_MS)
    // Self-provision the shipped voice packs (Task #39): a CI-built installer ships
    // WITHOUT the gitignored peon/sc_marine packs, so a fresh install's seeded
    // charm-break alert would reference a missing sound. Download any missing default
    // pack in the background (non-blocking, silent — errors go to errors.log and retry
    // next launch). On success, tell the renderer the pack set changed so it re-lists +
    // invalidates its sound caches and the sound becomes usable live.
    // E2E: skip (fresh temp userData ⇒ it would re-download every pack, off-network noise).
    if (!E2E) {
      void provisionDefaultPacks()
        .then((n) => {
          if (n > 0) sendToMain(IPC.onSoundPacksChanged)
        })
        .catch((err: unknown) => logError('main:provisionPacks', err))
    }
    // Auto-update (Task #27): checks GitHub Releases on the selected channel;
    // no-ops in dev. getMainWindow is lazy so status pushes hit the live window.
    initUpdater(getMainWindow)

    // Restore any floating overlay (Task #52; per-kind in Task #54) that was open when the app
    // last quit. Deferred so the main window's did-finish-load sends its initial state first.
    for (const kind of OVERLAY_KINDS) {
      if (getOverlayConfig(kind).open) createOverlayWindow(kind)
    }

    // …and keep them on a display that exists (JOS-187). The line above places them against the
    // monitors present at launch; this one re-places them when that changes under a running app —
    // the moment the player unplugs the widescreen their meters are parked on. Registered after
    // the restore for the obvious reason (there is nothing to reconcile before it) and never
    // removed: it is app-lifetime, like the security catch-alls above.
    watchDisplays(reconcileOverlayDisplays)

    // Presence-driven features (overlay auto-hide + the cursor ring). LAST, because both act on
    // windows that must already exist. Costs one store read when both are off — which is the
    // default install: `presenceNeeded()` decides whether the watcher thread is started at all.
    initPresenceEffects()

    // The performance HUD (docs/plans/perf-profiling.md P1). Costs one store read when it is
    // off — which is the default install: with `perfHud.enabled` false no timer is created at
    // all, so there is nothing to skip on each tick. The pref is read HERE rather than inside
    // the sampler because src/main/perf.ts deliberately does not import the store (the sampler
    // is a mechanism, the switch is a policy) — the same one-way dependency the IPC setter keeps.
    if (getPerfHudPrefs().enabled) startPerfSampler()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })
}

/**
 * STOPPING THE WATCHER, BELT AND BRACES. `window-all-closed` below is the ordinary teardown, but
 * it is not the only way this process ends: an auto-updater `quitAndInstall`, an `app.quit()`
 * from anywhere, or an OS session logoff can reach `before-quit` on a path that never lands
 * there. The presence watcher is a WORKER THREAD, and a live thread is one more thing holding a
 * quitting process open. `stopPresenceEffects()` is idempotent, so running it on both events
 * costs nothing.
 *
 * THE HARD CASE STOPPED EXISTING IN JOS-182, which is worth recording rather than quietly
 * deleting: the watcher used to be a `powershell.exe` CHILD, Windows does not kill children with
 * their parent, and one missed teardown left a PowerShell loop polling user32 forever with nobody
 * reading the pipe. It carried a self-reap for exactly the kill -9 case no in-process handler can
 * cover. A thread cannot outlive its process, so both the hazard and its workaround are gone.
 */
app.on('before-quit', () => teardownStep('main:stopPresence', stopPresenceEffects))

/**
 * One teardown step, isolated. `window-all-closed` runs a LIST of these before `app.quit()`,
 * and a synchronous throw in any of them used to skip everything after it — including the
 * quit itself. That is not hypothetical: `stopPerf()` once threw "Object has been destroyed"
 * (a send to the already-destroyed main window), the uncaughtException guard swallowed it,
 * and the result was a windowless zombie process whose single-instance lock blocked every
 * relaunch until the user killed it in Task Manager. Each step gets its own try/catch so a
 * failing step can neither starve the steps after it nor veto the quit.
 */
function teardownStep(label: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    logError(label, err)
  }
}

app.on('window-all-closed', () => {
  teardownStep('main:stopSession', stopSession)
  // Stop the presence watcher thread + the cursor stream. Both already unref, but an unref'd
  // worker is still a running thread: nothing else would end it.
  teardownStep('main:stopPresence', stopPresenceEffects)
  // Stop the feedback drain's timers. They are unref'd, so they cannot be the reason the
  // process lives on; this is about not starting an attempt into a process that is quitting.
  teardownStep('main:stopQueueFlush', stopQueueFlush)
  // Close the analytics session: records `sessionEnd` into the LOCAL ring (duration + how many
  // tabs were visited) and stops the heartbeat. Nothing is transmitted — there is nowhere to
  // transmit to — and the timers were unref'd anyway, so this is about writing the last record
  // before the process goes, not about letting it go.
  teardownStep('main:stopTelemetry', stopTelemetry)
  // Stop the HUD's sampler and make sure this launch left a startup profile behind. The timers
  // are unref'd, so this is about not sampling a process that is quitting — and about the launch
  // that never reached `rendererHydrated` still writing what it DID reach, which is exactly the
  // launch whose profile is worth having.
  teardownStep('main:stopPerf', stopPerf)
  // Flush the learned message overlay one last time so the final session's observations
  // aren't lost between debounced saves (Task #36).
  teardownStep('main:saveOverlay', () => saveUserOverlay(buffsModule.overlaySnapshot()))
  // Dev only, and null in every other build: a live DSQL socket is not a timer and would hold
  // the process open long past the last window.
  teardownStep('main:triage', () => {
    if (closeDevTriage) void closeDevTriage().catch((err: unknown) => logError('main:triage', err))
  })
  if (process.platform !== 'darwin') app.quit()
})
