// ============================================================================
// session.ts — the ACTIVE CHARACTER's lifetime: resolve, replay, tail, switch, stop.
// ============================================================================
//
// One character is tracked at a time. Everything that changes when that choice changes lives
// here: which log is being read, the shared monotonic `seq` both feeders stamp events with,
// the byte-offset scan→tail handoff, the 1s wall-clock heartbeat, the inventory-file watcher,
// and the EQ-install-dir override that can invalidate all of it.
//
// pipeline.ts owns the world this feeds (bus, modules, combat engine); this module drives it.

import { existsSync } from 'fs'
import { IPC } from '../shared/ipc'
import { logConsoleError, logInfo, logWarn } from './errorLog'
import {
  characterId,
  invalidateEqDiscovery,
  listCharacters,
  parseLogName,
  refreshEqDiscoveryCheaply,
  resolveActiveCharacter,
  resolveEqDir,
  tailSurvivesRootChange
} from './log/config'
import { Tailer } from './log/Tailer'
import { parseEvent, parseLine } from './log/parser'
import { installCharacterName } from './log/rulesets'
import { scanLog } from './log/scanHistory'
import { createSlicer } from './log/replaySlicer'
import { saveUserOverlay } from './data/overlayPersistence'
import { loadInventory } from './inventory/parseInventory'
import { watchOutputKind, type OutputKindWatch } from './outputs'
import {
  bus,
  buffsModule,
  characterModule,
  combat,
  epoch,
  killsModule,
  levelingModule,
  lootModule,
  outputFilesModule,
  registry,
  rosterModule,
  sendWorldRebuilt,
  sessionDetector,
  turnInsModule
} from './pipeline'
import {
  getActiveLogPath,
  getEqInstallDir,
  getProgress,
  setActiveLogPath,
  setInventory
} from './store'
import { markFunnelStep, noteLinesParsed } from './telemetry'
import { refreshPresenceEffects, suspendCursorStream } from './presenceEffects'
import { setHistoricalReplayRunning } from './replayGate'
import { sendToMain, setOverlaysHidden } from './windows'
import type { CharacterRef, EqConfig } from '../shared/types'
import type { ScanResult } from './log/scanHistory'
import type { ReplayDutyStats } from '../shared/perf'

let tailer: Tailer | null = null
let character: CharacterRef | null = null
let inventoryWatch: OutputKindWatch | null = null
// Wall-clock heartbeat (Task #30): drives module onTick so real-time deadlines (the
// buffs 15s cast-landing timeout) fire even when the log is idle. Started once the
// live tail is running (never during replay), cleared on quit / character switch.
let tickTimer: ReturnType<typeof setInterval> | null = null
// The monotonic event seq shared by BOTH feeders (scan, then tail) — reset per character.
let seq = 0

/** The character currently being tailed, or null (no logs / dir moved out from under us). */
export function getActiveCharacter(): CharacterRef | null {
  return character
}

/** Store key for per-character state ('none' while nothing is tailed). */
export function activeCharId(): string {
  return character ? characterId(character) : 'none'
}

/**
 * FIX 4: throttle-emit a combat-activity ping to the renderer, at most once per
 * ~250ms. useCombat fetches a fresh snapshot on this event, so the meter updates
 * sub-second during a fight while idle polling stays cheap. A trailing timer
 * guarantees a final ping after a burst so the last hit isn't missed.
 */
const COMBAT_ACTIVITY_THROTTLE_MS = 250
let combatActivityLast = 0
let combatActivityTimer: ReturnType<typeof setTimeout> | null = null
function notifyCombatActivity(): void {
  const now = Date.now()
  const since = now - combatActivityLast
  if (since >= COMBAT_ACTIVITY_THROTTLE_MS) {
    combatActivityLast = now
    sendToMain(IPC.onCombatActivity)
    return
  }
  if (combatActivityTimer) return
  combatActivityTimer = setTimeout(() => {
    combatActivityTimer = null
    combatActivityLast = Date.now()
    sendToMain(IPC.onCombatActivity)
  }, COMBAT_ACTIVITY_THROTTLE_MS - since)
}

/** Resolve which character to track on launch: last selected, else most recent. */
function resolveInitialCharacter(): CharacterRef | null {
  const savedPath = getActiveLogPath()
  if (savedPath) {
    const ref = parseLogName(savedPath)
    if (ref) return ref
  }
  return resolveActiveCharacter()
}

/** Build the EqConfig payload the Settings UI reads (effective dir + how it resolved). */
export function buildEqConfig(): EqConfig {
  const r = resolveEqDir()
  return {
    root: r.root,
    logsDir: r.logsDir,
    source: r.source,
    characterCount: r.characterCount,
    readable: r.readable,
    readError: r.readError,
    overridden: getEqInstallDir() !== undefined
  }
}

/**
 * Apply a change to the effective EQ install dir (override set/cleared). Re-lists
 * characters and, unless the currently-tailed log lives under the NEW Logs dir,
 * retails the most-recent character there (or idles + watches if the dir has none).
 * A no-op re-tail is avoided when the active log is still the right one, so a
 * settings save that didn't actually move the dir never disrupts an in-flight tail.
 *
 * THE PREDICATE IS "UNDER THE NEW DIR", NOT "STILL EXISTS" (bug 01KZ9BF43KYH…): the old
 * root's log file is still perfectly readable after the user points us somewhere else, so
 * an existence test kept the app reading a folder the user had just told us to stop reading.
 * `tailSurvivesRootChange` (log/discovery.ts) is the pure, unit-tested form of that rule.
 */
export async function applyEqDirChange(): Promise<EqConfig> {
  // The override just changed, which is the ONE moment a person can tell us that where EQ lives
  // has changed — so drop the memoized discovery (config.ts) before resolving anything. Clearing
  // an override must be able to re-probe the machine, not serve the root we found an hour ago.
  invalidateEqDiscovery()
  const config = buildEqConfig()
  // Refresh the character selector everywhere.
  const chars = listCharacters()
  sendToMain(IPC.onEqConfigChanged, config)

  if (tailSurvivesRootChange(character?.logPath, config.logsDir, existsSync)) return config

  // The dir moved out from under the tail (or we had none): pick the best character
  // under the new dir and re-tail, or gracefully idle if the dir has no logs.
  const next = resolveActiveCharacter() ?? chars[0] ?? null
  if (next) {
    await tailCharacter(next)
  } else {
    // Fresh/empty dir: stop tailing and tell the renderer there's no character,
    // so views show the quiet empty state instead of stale data.
    await tailer?.stop()
    tailer = null
    stopHeartbeat()
    inventoryWatch?.close()
    inventoryWatch = null
    character = null
    // No character ⇒ no self-`/who` row is identifiable. Clear the name rather than let a
    // stale one attribute the next log's rows to the character we just stopped tailing.
    installCharacterName(undefined)
    // Every window that folds a module, not just the main one (JOS-172): an overlay left open
    // over an install whose log went away must empty with everything else.
    sendWorldRebuilt(null)
    // …and start looking, because the empty state's own advice is "type /log on" and that is
    // the moment the log we are missing comes into existence. See `watchForFirstLog`.
    watchForFirstLog()
  }
  return config
}

/**
 * THE IDLE RESCAN — the other half of bug 01KZ9BF43KYH…, and the half the user actually hit.
 *
 * With no character attached the app shows a quiet empty state whose copy reads "Make sure
 * logging is on in-game (type /log on), or point us at your install folder" (App.tsx). A player
 * who has never enabled EQ logging has NO `eqlog_*.txt` at all, so pointing us at the right
 * folder legitimately finds nothing — and then they do as they are told, `/log on` creates the
 * file, and NOTHING in this process ever looks at that directory again. The instruction had no
 * observer. Their only way out was to re-pick the folder or restart the app.
 *
 * So while (and only while) nothing is attached, re-run the ordinary resolution every couple of
 * seconds and attach the instant a log appears. The cost is one `readdir` of one directory, the
 * same one `countCharacterLogs` already does per Settings render; the timer exists ONLY in the
 * idle state and is cleared by `tailCharacter` the moment it succeeds, so an app that is tailing
 * pays nothing. It is `unref`'d — a rescan must never be the reason the process stays alive.
 *
 * The zero-logs empty state is unchanged: this does not error, does not nag, and shows nothing
 * new. It just ends by itself when the log the user was told to create shows up.
 */
const LOG_RESCAN_MS = 2000
let rescanTimer: ReturnType<typeof setInterval> | null = null

function stopWatchingForFirstLog(): void {
  if (rescanTimer) clearInterval(rescanTimer)
  rescanTimer = null
}

function watchForFirstLog(): void {
  stopWatchingForFirstLog()
  rescanTimer = setInterval(() => {
    if (character !== null) {
      stopWatchingForFirstLog()
      return
    }
    // A log that appears where auto-discovery could have found it (no override, non-default
    // install) also un-sticks the memoized "found nothing" — fs probes only, see config.ts.
    refreshEqDiscoveryCheaply()
    const next = resolveActiveCharacter()
    if (!next) return
    stopWatchingForFirstLog()
    logInfo(`[everquest-companion] A character log appeared: ${next.logPath}`)
    void tailCharacter(next).then(
      () => {
        // The selector + the no-logs empty state are driven by the character LIST, which the
        // renderer refreshes on `eqconfig:changed` — and the config really did change: its
        // `characterCount` just went from 0 to N. `onCharacter` alone would light the title bar
        // and leave the empty state on screen.
        sendToMain(IPC.onEqConfigChanged, buildEqConfig())
      },
      (err: unknown) => {
        logConsoleError('[everquest-companion] attach after rescan failed', err)
        watchForFirstLog() // it appeared and we fumbled it; keep looking
      }
    )
  }, LOG_RESCAN_MS)
  rescanTimer.unref?.()
}

/**
 * Rebuild the canonical event stream for this character from scratch: one bus,
 * one seq counter, both feeders (scan + tail). Consumers stay subscribed (see
 * pipeline.ts); we reset() them so their state rebuilds from this scan. The
 * character module gets the new ref up front so its snapshot is correct
 * immediately (zone is folded from the log during the scan).
 */
function resetWorldFor(ref: CharacterRef): void {
  seq = 0
  registry.reset()
  epoch.reset()
  // The offline-gap detector is per-LOG state (a rolling window of recent timestamps + the
  // pending camp), so it resets alongside the epoch detector: a new character's first login
  // must not inherit the previous log's last-seen instant as its `fromTs`.
  sessionDetector.reset()
  characterModule.setCharacter(ref)
  // Tell the PARSER whose log this is (class-combo inference Wave 1). A `/who` prints every
  // stranger in the zone in the same grammar as the player's own row, so the self-`/who` rule
  // can only fire once it knows the name — and it must learn it here, before the scan replay,
  // never from a constant. Same injection path as installSpellDb.
  installCharacterName(ref.name)
  // …and tell the ROSTER too (JOS-85). A Quick Buff burst names the player exactly the way the
  // log names them (`You healed <YourName> for …`), so the buff-fan-out rung would otherwise put
  // the character on their own group roster. Same injection path, same instant, for the same
  // reason: it must be in place before the scan replay folds the first burst.
  rosterModule.setSelfName(ref.name)
  combat.reset()
  // Inject the player's own name (we know it from the ref) BEFORE the scan replay,
  // so incoming self-heals ("You healed <Name> for N") attribute from the first
  // line rather than waiting for the engine to learn the name mid-scan.
  combat.setPlayerName(ref.name)
}

/**
 * THE PARSE COUNTER + the first-run funnel's `firstParse` step (JOS-39).
 *
 * Both feeders come through here so there is ONE definition of "a line this app parsed": the
 * startup replay hands over its whole event count in one call, the live tail hands over one at a
 * time. Nothing about the line itself goes anywhere — `noteLinesParsed` takes a number and the
 * telemetry schema has no field that could hold text (src/shared/telemetry.ts).
 *
 * `parseMarkAttempted` bounds the store read to ONE per launch. `markFunnelStep` reads the prefs
 * file to check the once-ever mark, and this function runs on the app's hottest path; a latch
 * that only costs a delayed step (until the next launch) for a user who enables analytics
 * mid-session is the right trade against reading a JSON file per parsed line.
 */
let parseMarkAttempted = false

function noteParsed(count: number): void {
  if (count <= 0) return
  noteLinesParsed(count)
  if (parseMarkAttempted) return
  parseMarkAttempted = true
  markFunnelStep('first-run', 'firstParse')
}

/**
 * FIX 1: gapless handoff — start the tailer exactly where the scan stopped, so
 * lines the game appended during the (multi-second) scan are read, not dropped,
 * and none are re-read. The tailer is byte-level; we parse each raw line here
 * (continuing the shared seq) and emit onto the same bus with live:true.
 */
function startTailer(logPath: string, startOffset: number): void {
  tailer = new Tailer(logPath, { startOffset })
  tailer.on('line', (raw) => {
    const line = parseLine(raw)
    if (line) sendToMain(IPC.onLine, line)
    const ev = parseEvent(raw, seq)
    if (ev) {
      seq++
      noteParsed(1)
      bus.emit(ev, true)
    }
    notifyCombatActivity() // FIX 4: throttled push so the meter refreshes sub-second
  })
  tailer.on('error', (err) => logConsoleError('[everquest-companion] tailer error', err))
  void tailer.start()
}

/**
 * Start the wall-clock heartbeat now that the LIVE tail is running (the scan has
 * completed). registry.tick advances each module's onTick then flushes deltas only
 * when dirty — so an idle log still confirms a pending buff cast, and a stale cast
 * scanned from the log lands on the first tick (now ≫ its beganTs). Clear any prior
 * timer first (a character switch re-enters startTailing).
 */
/**
 * Stop the wall-clock heartbeat. Called on the way into a replay as well as on the way out of a
 * session (JOS-60): the interval belongs to the character being LEFT, and letting it keep firing
 * through the next character's replay is what used to tick a half-rebuilt world — and, before the
 * registry's replay gate existed, push that world to the renderer as an increment.
 */
function stopHeartbeat(): void {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
}

function startHeartbeat(): void {
  stopHeartbeat()
  let overlaySaveTick = 0
  // ONE TICK BEFORE THE INTERVAL (JOS-149). The fold judges every clock against the LOG's own
  // last instant, so a row cast a few minutes before the log went quiet survives it — correctly,
  // for the fold. Then the renderer re-hydrates (`registry.flushNow()` below) and draws that row
  // against WALL time, where it may be hours past its end. The interval would have retired it,
  // one second later; doing it here means the first snapshot the renderer ever sees is already
  // judged against now, and a row whose expiry and timeout are long gone never materializes at
  // all. Same call, same arguments, strictly earlier.
  registry.tick(Date.now())
  tickTimer = setInterval(() => {
    registry.tick(Date.now())
    // Debounced overlay persistence (Task #36): the miner accretes from the live tail; snap
    // it to userData every ~60s so the user's learned messages survive a restart. Cheap —
    // overlaySnapshot() builds a small object; the write is best-effort.
    if (++overlaySaveTick >= 60) {
      overlaySaveTick = 0
      saveUserOverlay(buffsModule.overlaySnapshot())
    }
  }, 1000)
}

/**
 * What attaching a character cost, in events. Returned rather than logged only, because the
 * startup profile states it beside the replay's duration (docs/plans/perf-profiling.md P4) —
 * "6 s" means something quite different for 40k events than for 1.1M, and the composition root
 * is where the two facts meet.
 */
export interface TailResult {
  /** Events the historical scan folded. `seq` is reset per character, so this is the whole scan. */
  eventsReplayed: number
  /**
   * How the slicer split that time between folding and resting (JOS-50). Reported for the same
   * reason the event count is: the fold is duty-cycled on purpose, so "43 s" and "72 s" are the
   * same launch throttled differently, and only this says which.
   */
  replay: ReplayDutyStats
  /**
   * Bytes the scan actually folded — `ScanResult.endOffset`, i.e. the end of the last COMPLETE
   * line at or before the frozen EOF. It is the log's size to within a trailing partial line, and
   * it is free: the scan already computed it for the tailer handoff, so nothing here stats a file
   * a second time.
   *
   * Reported for the same reason the other two are: the fleet reading buckets a replay by the size
   * of the log it read (JOS-57), because "6 s" is a fine launch on a 600 MB log and a bad one on
   * a 2 MB log. It never leaves the process as a byte count — perf.ts turns it into a bucket.
   */
  logBytes: number
}

/**
 * THE REPLAY GATE (JOS-62) — ONE signal, both halves, both replays.
 *
 * While a historical fold is running, nothing of ours rides the user's mouse or their screen:
 * every locked overlay's click-through drops the WH_MOUSE_LL forwarding hook (which would
 * otherwise make every system mouse event queue behind a 12 ms fold slice — the reported jerky
 * mouselook), the overlays and the cursor ring stay off screen (they would be showing half-parsed
 * state), and the ring's 8 ms sampler does not run. `replayGate.ts` states the rules; this
 * function is where they are turned on and off, and it is called from exactly one place below —
 * so the cold-start scan and the shorter fold a character SWITCH runs get the same treatment
 * without a second call site to keep in step.
 *
 * The two sides are deliberately NOT mirror images, and both asymmetries are load-bearing:
 *
 *   * going IN we hide and park directly, because at cold start this runs before
 *     `initPresenceEffects` has — and a full presence re-evaluation there would spawn the watcher
 *     child early, during the fold, which is the opposite of the point;
 *   * coming OUT the full presence pass is the only correct restore, because IT is the authority
 *     on whether an overlay or the ring belongs on screen at all (auto-hide, EQ focus). The
 *     windows come back in their CONFIGURED state, which for an auto-hide user whose game is not
 *     focused is still "hidden" — never a flash of five overlays.
 *
 * Nothing here remembers a lock state: `setOverlaysHidden` re-applies each overlay's mode from
 * its PERSISTED flag on both edges, so there is exactly one definition of "is this locked" and
 * the gate only changes what that flag costs while the fold owns the message loop.
 */
function setReplayGate(running: boolean): void {
  setHistoricalReplayRunning(running)
  if (running) {
    setOverlaysHidden(true)
    suspendCursorStream()
    return
  }
  refreshPresenceEffects()
}

/** Point the tailer + loot history at a character (used at startup and on switch). */
export async function tailCharacter(ref: CharacterRef): Promise<TailResult> {
  // THE GATE CLOSES FIRST — before the first `await`, so at cold start it is already shut when the
  // composition root goes on to restore the overlays and start the presence features a few
  // statements later. Those windows are then born hidden instead of being shown and hidden again.
  setReplayGate(true)
  // We have a log; the idle rescan (if it was running) has nothing left to look for.
  stopWatchingForFirstLog()
  await tailer?.stop()
  tailer = null
  // The heartbeat belongs to the character we are leaving; it must not tick (nor push) through
  // the replay that follows. `startHeartbeat()` below re-arms it once the live tail is running.
  stopHeartbeat()
  character = ref
  setActiveLogPath(ref.logPath)
  logInfo(`[everquest-companion] Tailing ${ref.name}@${ref.server}: ${ref.logPath}`)
  // THE FIRST-RUN FUNNEL'S `logDetected`, at the one moment that is unambiguously "we found a
  // log and are about to read it" — after resolution succeeded and before the replay. The
  // once-ever mark (telemetry/funnels.ts) is what keeps a character switch from re-firing it.
  markFunnelStep('first-run', 'logDetected')

  resetWorldFor(ref)

  // Scan the whole log first (live:false) so loot/kills/AA and the combat engine's
  // charm/encounter state reflect reality before the live tail takes over. Modules
  // fold silently during replay; no deltas push until the live tail runs.
  //
  // THE HANDOFF, stated once here because this is where the two feeders meet
  // (docs/plans/chunked-replay.md §1): there is NO buffer-then-drain in this app. `scanLog`
  // freezes EOF at its own `stat()` and returns `endOffset`, the byte offset of the last COMPLETE
  // line it folded; `startTailer` below opens the tailer AT that offset. Lines the game appends
  // during the scan land past the frozen EOF, are never seen by the scan, and become the tailer's
  // first bytes — so a line can be folded neither twice nor never. That property is a fact about
  // byte offsets, not about timing, which is what makes the replay safe to slice cooperatively:
  // the fold now yields to the event loop every REPLAY_SLICE_MS instead of every 1 MB read chunk,
  // and a longer wall clock simply leaves more bytes waiting for the tailer.
  //
  // THE SLICER IS BUILT HERE rather than left to scanLog's default (JOS-50) for one reason: it is
  // the instrument as well as the throttle. It times every rest the OS actually delivered, and
  // that measurement rides `TailResult` into the startup profile — a duty cycle nobody can read
  // back is a claim, not a measurement.
  //
  // THE REPLAY IS A STATE, AND THE REGISTRY IS TOLD SO (JOS-60). Modules fold replay events
  // "silently" only in the sense that no flush is SCHEDULED for them — they still accumulate a
  // pending delta, and anything that flushed mid-replay (the heartbeat above, the `flushNow()`
  // below) shipped the target character's whole history to the renderer as an INCREMENT against
  // the character it was still holding. Every celebration detector reads an increment as news, so
  // a switch re-fired the boss/quest alerts and re-showed the announcement cards. `endReplay()`
  // DISCARDS what the fold accumulated; the renderer gets all of it from `snapshot()` the moment
  // the `onCharacter` send below makes it re-hydrate.
  registry.beginReplay()
  const slicer = createSlicer()
  let scan: ScanResult
  try {
    scan = await scanLog(ref.logPath, bus, seq, { slicer })
    // The replay's whole cost, in one call: `seq` was reset to 0 by `resetWorldFor`, so `scan.seq`
    // IS the number of lines this scan parsed. Counted here rather than per line inside the fold so
    // the replay's inner loop is untouched.
    noteParsed(scan.seq)
    seq = scan.seq
    combat.setLive()
  } finally {
    // THE ONE DONE SIGNAL, twice over (JOS-60 + JOS-62) — and a `finally` on purpose: a scan that
    // throws (the log deleted out from under us mid-fold) must strand neither the registry (which
    // would otherwise never flush a delta again) nor the user's overlays and ring. `endReplay()`
    // discards the fold's accumulated deltas — the renderer gets all of it from `snapshot()` on
    // re-hydrate — and `setReplayGate(false)` brings the windows and the mouse back. `setLive()`
    // stays inside the try, so the meters that come back are live ones rather than a frame of the
    // hydrating placeholder.
    registry.endReplay()
    setReplayGate(false)
  }
  const lootState = lootModule.snapshot().state
  const killState = killsModule.snapshot().state
  const lvlState = levelingModule.snapshot().state
  logInfo(
    `[everquest-companion] Loaded ${lootState.length} loot, ${turnInsModule.snapshot().state.length} turn-ins, ${
      Object.keys(killState.mobs).length
    } mobs, ${lvlState.levels.length} level-ups, ${lvlState.aaGains.length} AA gains, ${lvlState.aaSpends.length} AA buys.`
  )

  startTailer(ref.logPath, scan.endOffset)
  startHeartbeat()

  // Watch this character's inventory export so a fresh /outputfile auto-reloads.
  startInventoryWatch(ref)

  // Push whatever the modules folded during replay (mainly the character module's
  // ref + zone) so first-paint snapshots are already current, then tell EVERY window that
  // folds a module the character's state was fully rebuilt, so views remount/re-hydrate.
  //
  // THE OVERLAYS ARE PART OF "EVERY WINDOW" SINCE JOS-172, and this is the line the whole
  // ticket turns on. `endReplay()` above discarded what the fold accumulated, so nothing the
  // replay rebuilt will ever arrive as a delta — and an overlay that was ALREADY OPEN when the
  // app started hydrated part-way through that fold. Telling only the main window left a debuff
  // that genuinely survived the rebuild (a charm, an Ensnare) on screen in the app and absent
  // from the floating window whose entire job is to show it.
  registry.flushNow()
  sendWorldRebuilt(character)
  return {
    eventsReplayed: scan.seq,
    replay: { slices: slicer.slices, workMs: slicer.workMs, restMs: slicer.restMs },
    logBytes: scan.endOffset
  }
}

/**
 * Auto-reload the active character's `*-Inventory.txt` when it changes on disk.
 * EQ rewrites this file on `/outputfile inventory`; the settle-debounced change event triggers a
 * reload + a push so InventoryView, the Plane-of-Sky progress and the Planner's Inventory tab
 * refresh without a manual click.
 *
 * THE WATCH ITSELF IS THE REGISTRY'S (JOS-44, `outputs/registry.ts watchOutputKind`) — including
 * the two-watchers-one-slot rule that covers a character's very FIRST dump, which used to live
 * here and therefore belonged to `inventory` alone. `active` is this session's own staleness
 * guard, handed to the registry so a watcher that outlives a character switch goes quiet without
 * the registry needing to know what a character is.
 */
function startInventoryWatch(ref: CharacterRef): void {
  inventoryWatch?.close()
  inventoryWatch = watchOutputKind(
    'inventory',
    { name: ref.name, server: ref.server },
    {
      onChange: () => {
        reloadInventoryNow(ref)
      },
      onError: (err) => {
        logConsoleError('[everquest-companion] inventory watch error', err)
      },
      active: () => character?.logPath === ref.logPath
    }
  )
}

/**
 * THE BASELINE SEAM (JOS-128): when did the log see this dump written?
 *
 * Exported so the manual `inventory:reload` handler (ipc/character.ts) resolves the baseline
 * through the SAME lookup the auto-reload does — one answer to "when was this generated", the
 * way JOS-44 gave "which file" and "how old" one answer each. `loadInventory` takes it as a
 * parameter rather than importing the pipeline, so the fs/parse layer stays testable without
 * one; without this seam it falls back to the file's mtime.
 */
export function inventoryWrittenAt(file: string): number | null {
  return outputFilesModule.writtenAt(file)
}

/** Re-read the dump and push it, guarded against a stale watcher firing after a switch. */
function reloadInventoryNow(ref: CharacterRef): void {
  if (character?.logPath !== ref.logPath) return
  const res = loadInventory(character.name, character.server, inventoryWrittenAt)
  if (!res) return
  setInventory(activeCharId(), res.counts, res.source)
  logInfo(`[everquest-companion] Inventory auto-reloaded: ${res.path}`)
  sendToMain(IPC.onInventoryReload, { path: res.path, loadedAt: res.loadedAt })
  sendToMain(IPC.onProgress, getProgress(activeCharId()))
}

/** Startup entry point: resolve a character and tail it, or idle quietly if there is none.
 *  Resolves to what the replay cost, or null on a machine with no log to tail at all. */
export async function startTailing(): Promise<TailResult | null> {
  const ref = resolveInitialCharacter()
  if (!ref) {
    logWarn('[everquest-companion] No EQ log found; watching for one to appear.')
    // Same trap as a dir change that finds nothing: the app launched before the player ever
    // typed `/log on`. Keep looking rather than requiring a restart.
    watchForFirstLog()
    return null
  }
  return tailCharacter(ref)
}

/** Release the session's OS resources (tail, watcher, heartbeat, rescan) on the way out. */
export function stopSession(): void {
  void tailer?.stop()
  inventoryWatch?.close()
  stopWatchingForFirstLog()
  stopHeartbeat()
}
