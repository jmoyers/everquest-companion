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
// THE SERVED ARM (JOS-496): `mirroredModuleState` answers the `/outputfile` baseline seam from the
// engine when it is the world answering this app's reads, and `null` — no engine, not yet live, a
// world just replaced — is every caller's cue to ask this process's own fold instead.
import { mirroredModuleState } from './dataServer/serveMirrors'
// LOG DISCOVERY, SERVED (JOS-498, owner ruling 21 / decision sheet 1a). The engine scans the
// directory this app named and answers "who could you be playing"; `listCharacters` /
// `resolveActiveCharacter` are the arm that answers when it cannot. `pushLogDir` is the slot that
// lets this file say "the directory moved" without importing the engine client — which imports this
// file, and would be a cycle.
import { serveCharacterList } from './dataServer/serveLogs'
import { pushLogDir } from './dataServer/definePush'
import { baseName } from '../shared/outputs/baseline'
import { loadInventory } from './inventory/parseInventory'
import { loadAchievements, watchOutputKind, type OutputKindWatch } from './outputs'
import { sendWorldRebuilt } from './worldRebuilt'
import {
  getActiveLogPath,
  getEqInstallDir,
  getProgress,
  setActiveLogPath,
  setInventory
} from './store'
// The achievements dump's write pair (JOS-429) — a split-out store accessor, same reason the tail
// mark below is one: store.ts is at the factoring ceiling.
import { setAchievements } from './storeAchievements'
// The clean-shutdown tail mark (JOS-57 scope addition) — a split-out store accessor, for the
// reason its own header gives: store.ts is at the factoring ceiling.
import { markFunnelStep } from './telemetry'
// "Another character's log is active — switch?" (JOS-432). Three touch points in this file and
// nothing else: stamp every tailed line, follow the character we just attached, let go on the way
// out. The decision (and the reason it cannot nag) is src/main/log/quietSwitch.ts.
import { stopWatchingForQuietSwitch, watchForQuietSwitch } from './switchNudge'
// A leaf (see its header) — the two dump loads below are timed seams.
import { timeSeam } from './perfAttribution'
// WHO OWNS THE WORLD RIGHT NOW (JOS-457). Every switch takes a turn and re-asks `owns()` after
// every point it could have been suspended; a turn that has lost touches nothing shared and
// returns. The whole argument — why a generation and not a queue or a mutex — is in that file.
import { beginSwitch, type SwitchTurn } from './switchController'
import { sendToMain } from './windows'
import type { CharacterRef, EqConfig } from '../shared/types'

let character: CharacterRef | null = null
let inventoryWatch: OutputKindWatch | null = null
// The achievements dump gets the SAME treatment as the inventory one (JOS-429): read at session
// start, followed for rewrites. A separate slot rather than a list because the two are closed
// independently and each is armed for its own character — and because the day a third kind
// graduates, a list would hide which one failed to close.
let achievementsWatch: OutputKindWatch | null = null
// Wall-clock heartbeat (Task #30): drives module onTick so real-time deadlines (the
// buffs 15s cast-landing timeout) fire even when the log is idle. Started once the
// live tail is running (never during replay), cleared on quit / character switch.
// The monotonic event seq shared by BOTH feeders (scan, then tail) — reset per character.

/** The character currently being tailed, or null (no logs / dir moved out from under us). */
export function getActiveCharacter(): CharacterRef | null {
  return character
}

/** Store key for per-character state ('none' while nothing is tailed). */
export function activeCharId(): string {
  return character ? characterId(character) : 'none'
}

// THE COMBAT-ACTIVITY NUDGE MOVED (JOS-499) — `dataServer/serveDeltas.ts`.
//
// It is a throttled ping that makes the meter re-read sub-second during a fight, and its feeder
// was this file's tailer line handler: every raw line nudged it. There are no lines here. The
// engine's `moduleChanged` cursors are the same evidence arriving from the world that now folds
// them, so the nudge lives where they land.

/**
 * WHO WAS PLAYED LAST, AS A SERVED ANSWER (JOS-498, owner ruling 21).
 *
 * The engine scans the directory this app pushed and returns the characters most-recently-written
 * first, so its first row IS "the log with the newest mtime" — which is exactly what
 * `resolveActiveCharacter` computes with its own readdir. `serveCharacterList` falls back to
 * `listCharacters()` for every reason an engine can fail to answer, so the two arms are the same
 * answer computed in two processes and this function does not have to know which one spoke.
 *
 * THE ENV OVERRIDE IS ASKED FIRST AND STAYS APP-SIDE. `EQ_LOG_PATH` names ONE FILE and outranks any
 * list — it is how the e2e harness and a developer point this process at a log, and it is a fact
 * about how THIS process was started rather than about what is in a folder. Asking the engine to
 * enumerate a directory in order to honour it would be asking a question that is already answered,
 * and could answer it differently. `resolveActiveCharacter` already implements the override
 * (including the `Unknown` ref it builds for a path that does not parse), so the whole arm is that
 * one call.
 */
async function resolveMostRecentCharacter(): Promise<CharacterRef | null> {
  if (process.env.EQ_LOG_PATH) return resolveActiveCharacter()
  const listed = await serveCharacterList(() => listCharacters())
  return listed[0] ?? null
}

/**
 * Resolve which character to track on launch: last selected, else most recent.
 *
 * THE SAVED PATH IS STILL FIRST AND IS STILL A STORE READ. It is not a fact about the log directory
 * at all — it is what this person chose last time — so ruling 21 does not touch it, and on every
 * launch after the first it means the engine is never asked. What became served is the OTHER arm:
 * the fresh install, and the launch whose saved log has been deleted.
 */
async function resolveInitialCharacter(): Promise<CharacterRef | null> {
  const savedPath = getActiveLogPath()
  if (savedPath) {
    const ref = parseLogName(savedPath)
    if (ref) return ref
  }
  return resolveMostRecentCharacter()
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
  // THE ENGINE IS TOLD, AND IT IS TOLD HERE (JOS-498). This is the one moment a person can say where
  // EverQuest lives, and it is AFTER `invalidateEqDiscovery` + `buildEqConfig` on purpose: the push
  // reads `eqLogsDir()` for itself, so it must not run until this process has resolved the new
  // setting. Everything downstream of this line — including the served list below — is then asking
  // about the folder the user just picked.
  pushLogDir()
  sendToMain(IPC.onEqConfigChanged, config)

  if (tailSurvivesRootChange(character?.logPath, config.logsDir, existsSync)) return config

  // The dir moved out from under the tail (or we had none): pick the best character
  // under the new dir and re-tail, or gracefully idle if the dir has no logs.
  const next = await resolveMostRecentCharacter()
  if (next) {
    await tailCharacter(next)
  } else {
    // Fresh/empty dir: stop tailing and tell the renderer there's no character,
    // so views show the quiet empty state instead of stale data.
    //
    // AND "NO CHARACTER" IS A SWITCH LIKE ANY OTHER (JOS-457), so it takes a turn — for the one
    // reason that survives the fold: a `tailCharacter` still in flight would otherwise finish and
    // cheerfully attach the ENGINE to the log the user just told us to stop reading.
    const turn = beginSwitch()
    await Promise.resolve()
    if (!turn.owns()) return config
    // Nothing is attached, so there is no "our log went quiet" to ask about (JOS-432).
    stopWatchingForQuietSwitch()
    inventoryWatch?.close()
    inventoryWatch = null
    achievementsWatch?.close()
    achievementsWatch = null
    character = null
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
    // DELIBERATELY THE LOCAL READ (JOS-498; serveLogs.ts's header lists the exceptions and why). The
    // tick's whole subject is whether a file has appeared where THIS process's own discovery can see
    // one — the line above re-probes the machine — so the question and the answer belong to the same
    // process. A round trip per two seconds would also make an idle app talk to the engine forever
    // about a folder neither of them has any news about.
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

// `resetWorldFor` AND `installClickies` ARE GONE (JOS-499).
//
// The first rebuilt this process's world for a character: reset the registry and the combat
// engine, re-file the message-overlay and resist buckets under the new character, reset the epoch
// and offline-gap detectors, and inject the four impure facts the fold needed BEFORE its replay —
// the character's own name (the self-`/who` rule), the roster's self name, the player name for
// self-heal attribution, and the held instant-clicky set. Every one of those is an ENGINE
// construction input now, pushed as a `*.define` or carried on the attach.
//
// `installClickies` reached the catalog THROUGH `pipeline.ts` on purpose — an indirection that was
// load-bearing rather than tidy, because importing it here broke JOS-431's inventory watcher. That
// hazard leaves with the module edge it was about.

// THE PARSE COUNTER IS GONE (JOS-499). It was the app's one definition of "a line this app
// parsed" — both feeders came through it — and it drove `noteLinesParsed` plus the first-run
// funnel's `firstParse` step. This process parses nothing.
//
// THE FUNNEL STEP IT MARKED IS NOT LOST: `logDetected` still fires in `tailCharacter` below, at
// the moment this app resolves a log and hands it to the engine, which is the same thing
// `firstParse` was standing in for — that a real player with a real log got as far as reading it.

// THE TAILER AND THE HEARTBEAT ARE GONE (JOS-499).
//
// `startTailer` opened the live byte tail at the scan's frozen EOF — the gapless handoff that
// made a line impossible to fold twice or never — parsed each raw line, and pushed it onto the
// bus. The ENGINE owns the tail now (boundary verdict 4), and it owns the same seam: it folds
// from byte zero and tails from where it stopped, in its own process.
//
// `startHeartbeat` was the 1 Hz wall clock that advanced each module's `onTick` so a buff could
// expire while the log was silent — the one thing a purely event-driven fold cannot do. Owner
// ruling 22 moved it: the engine ticks its own modules with its own clock while LIVE, and
// historical replay stays clockless so the equivalence law is untouched. Its 60-tick rider that
// snapped the learned message-overlay register to disk is gone with it, because that register is
// the engine's file now (JOS-497, boundary verdict 4).

// `TailResult` LIVED HERE AND IS GONE (JOS-499). Every field of it measured THIS PROCESS's own
// historical fold — events replayed, the slicer's duty cycle, bytes read, the cold-read delta,
// how long the first megabyte took — and it fed the startup profile's replay section. This
// process folds nothing, so there is no honest number to report and reporting zeros would be
// worse than reporting nothing.
//
// THE MEASUREMENT MOVED RATHER THAN DIED (owner ruling 19: the app's performance surface includes
// the engine's own numbers). Fold rate, event counts and serve latency are the ENGINE's to report
// now, over `perf.snapshot` and the perf channel `enginePerfWatch.ts` already pushes.

// THE REPLAY GATE IS GONE (JOS-499), and so is everything it gated.
//
// It existed because a historical fold ran ON THIS PROCESS and owned the message loop for the
// seconds it took: the overlays and the cursor ring came off screen (they would have been showing
// half-parsed state), the ring's 8 ms sampler stopped, and — until JOS-370 retired the mouse hook
// — every locked overlay dropped its WH_MOUSE_LL forwarding so the user's mouselook did not queue
// behind a 12 ms fold slice.
//
// THE BOUNDARY IS THE FIX THE GATE WAS AN APPROXIMATION OF. The fold is in another process at
// below-normal priority, so there is no moment when reading the log costs this process its
// responsiveness — which is the whole argument for the engine (docs/plans/data-server.md, 'the
// architecture makes politeness fragile — the fix is a boundary, not another throttle'). Nothing
// hides, nothing suspends, and the overlays simply stay where the user put them while the engine
// catches up. `presenceProtocol.ts ringDisposition` lost its replay term for the same reason.

/**
 * A switch that lost its turn, on its way out: say so once, and answer NULL.
 *
 * A LOG LINE RATHER THAN SILENCE because this is the one thing an owner reproducing a switch storm
 * needs to see in `errors.log` — how many picks were dropped and which one survived. It is bounded
 * by how fast a person can use a dropdown, so it cannot flood.
 *
 * NULL RATHER THAN A `TailResult` because there is no honest one to give: this call folded a partial
 * history into a world somebody else has since rebuilt, and every number it could report — events
 * replayed, bytes read, the duty cycle — would describe work that was thrown away. `startTailing`
 * already answers `TailResult | null` for the machine with no log at all, and the startup profile
 * reads it with `res?.` (index.ts), so the absent case was already carried end to end.
 */
function preempted(ref: CharacterRef, turn: SwitchTurn): null {
  logInfo(
    `[everquest-companion] Switch to ${ref.name}@${ref.server} (gen ${String(turn.gen)}) was preempted by a newer pick; its replay is discarded.`
  )
  return null
}

/**
 * Point the tailer + loot history at a character (used at startup and on switch).
 *
 * ONE SWITCH AT A TIME, AND THE NEWEST ONE WINS (JOS-457). Every path that can change the tailed
 * character funnels through here — the dropdown's `character:set`, an EQ-dir change, the idle
 * rescan, the quiet-switch nudge — and until this ticket none of them was guarded, so N quick
 * dropdown picks ran N whole-log folds CONCURRENTLY, interleaving at every `await` and resetting
 * the shared world out from under each other. That is the reported lock-up, the random encounters
 * and the random audio, all three.
 *
 * The fix is OWNERSHIP, not ordering. This call takes a turn (switchController.ts) which the next
 * switch silently revokes, and it re-asks `owns()` after each of its two suspension points. There
 * are exactly two, and that is a property of the code rather than an accident worth restating:
 * everything from the first check to `scanLog` runs synchronously, and so does everything from the
 * second check to the `return` — so the ONLY thing that can interleave with a switch is another
 * switch's fold, which `ScanOptions.cancelled` stops at its own next suspension point.
 *
 * A call that has lost its turn RETURNS NULL, having touched nothing shared: no world reset, no
 * `tailer` assignment, no heartbeat, no go-live, no push, and — critically — it does NOT open the
 * replay gate or end the registry's replay bracket. Those close at the top of every switch and are
 * opened only by the turn that reaches the end still owning the world, which across a storm of
 * picks is ONE continuous closed state from the first pick to the last winner's `endReplay()`.
 *
 * THE WINNER STILL FINISHES PARSING. Nothing here caches, checkpoints or resumes a fold: the
 * surviving switch replays its whole log from byte zero and hands its own frozen-EOF `endOffset`
 * to its own tailer, exactly as a lone switch always did.
 */
export async function tailCharacter(ref: CharacterRef): Promise<boolean> {
  const turn = beginSwitch()
  // We have a log; the idle rescan (if it was running) has nothing left to look for.
  stopWatchingForFirstLog()
  // THE ONE SUSPENSION POINT LEFT, and it is kept deliberately rather than removed with the rest.
  //
  // This function used to have two — a tailer stop and a whole-log fold — and the ownership model
  // existed because N quick dropdown picks ran N whole-log folds CONCURRENTLY, resetting a shared
  // world out from under each other (JOS-457: the reported lock-up, the random encounters and the
  // random audio, all three). None of that world is here now.
  //
  // WHAT IS STILL TRUE is that the ENGINE preempts, and this app must not tell it two things in an
  // order neither of them chose. `session.attach` is last-pick-wins by protocol law, and the
  // attach is sent from `sendWorldRebuilt` below — so the turn still decides which pick gets to
  // announce itself, and a superseded pick announces nothing. The await is what makes that
  // meaningful: without a suspension point there is no interleaving to guard, and the guard would
  // be decoration. It is `Promise.resolve()` rather than nothing so the shape survives the next
  // edit that adds real asynchronous work here.
  await Promise.resolve()
  if (!turn.owns()) return preempted(ref, turn) !== null
  character = ref
  setActiveLogPath(ref.logPath)
  logInfo(`[everquest-companion] Tailing ${ref.name}@${ref.server}: ${ref.logPath}`)
  // THE FIRST-RUN FUNNEL'S `logDetected`, at the one moment that is unambiguously "we found a log
  // and are about to read it" — after resolution succeeded. The once-ever mark
  // (telemetry/funnels.ts) is what keeps a character switch from re-firing it.
  markFunnelStep('first-run', 'logDetected')

  // …and start the quiet clock. It watches whether OUR file is being written to at all, which is a
  // question about the log rather than about a fold, so it is unaffected by the boundary — except
  // that its feeder is now the engine's cursors rather than this process's tail lines
  // (`dataServer/serveDeltas.ts noteTailLine`).
  watchForQuietSwitch(ref)

  // READ THE DUMP, THEN FOLLOW IT (JOS-253) — the same two-step the log itself gets. The watcher is
  // armed with `ignoreInitial: true` (outputs/watch.ts) and a file rewritten while the app was
  // closed never changes again, so a player who typed `/outputfile inventory` between sessions
  // would otherwise be tailed against a dump this app had never opened.
  loadInventoryNow(ref, 'startup')
  startInventoryWatch(ref)

  // The second graduated kind gets the identical two steps (JOS-429). It matters MORE here, not
  // less: the whole point of reading achievements is the player who did Sky content this app never
  // saw, and that player types the command once, between sessions, expecting it to be noticed.
  loadAchievementsNow(ref, 'startup')
  startAchievementsWatch(ref)

  // THE ATTACH RIDES THIS CALL, and that is the whole of what "tailing a character" means now.
  //
  // `sendWorldRebuilt` tells every window that folds a module to re-hydrate, and — through the one
  // in-process observer slot (`worldRebuilt.ts setWorldRebuiltObserver`) — tells the data-server
  // client, which sends `session.attach` for this log. So the engine learns which character to
  // fold from the same signal the windows learn to ask again from, which is exactly the property
  // JOS-172 fought for: ONE answer to "the world for this character was rebuilt".
  //
  // THE WINDOWS ARE TOLD FIRST AND WILL BRIEFLY GET NOTHING, and that is the honest state rather
  // than a race. They re-ask immediately, the engine is still attaching or folding, and
  // `module:getSnapshot` answers null until it goes live — which `useModule` draws as loading. The
  // alternative would be showing the previous character's rows under this character's name.
  sendWorldRebuilt(character)
  return true
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
        loadInventoryNow(ref, 'watch')
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
  // THE SERVED ANSWER FIRST (JOS-496). This is a MIRROR read rather than a query for a structural
  // reason: `loadInventory` takes this function BY REFERENCE and calls it from inside a synchronous
  // parse (`inventory/parseInventory.ts`), so there is nowhere to put an await without rewriting the
  // fs/parse layer — which is the layer this seam exists to keep pipeline-free. See
  // `serveMirrors.ts` for the third shape and what it costs.
  //
  // THE KEY IS FOLDED HERE, exactly as the module folds it (`modules/outputFiles.ts fileKey`): EQ
  // writes dumps into the install root and prints the bare name, so the join is on the last
  // segment, case-insensitively. The engine's own module folds the identical key
  // (`fold/src/modules/output_files.rs file_key`), which is what makes a served map answerable with
  // the same string this process would have used.
  // THE MIRROR IS THE ONLY ARM NOW (JOS-499). It fell back to this process own outputFiles
  // module; there is none. An unmirrored moment answers null, which is the same answer this
  // function has always given for a dump the world has never seen written.
  const mirrored = mirroredModuleState('outputFiles') as Record<string, number> | null
  return mirrored?.[outputFileKey(file)] ?? null
}

/** `modules/outputFiles.ts fileKey`, applied to the SERVED map. It is spelled here rather than
 *  exported from the module because the module's copy is the one the cutover deletes, and a served
 *  read that imported it would be a live dependency on the thing being retired. */
function outputFileKey(pathOrName: string): string {
  return baseName(pathOrName).trim().toLowerCase()
}

/**
 * Read the dump and push it, guarded against a stale watcher firing after a switch.
 *
 * ONE FUNCTION FOR BOTH HALVES OF "follows itself" (JOS-253): the read at session start and the
 * re-read the watcher triggers are the same act on the same file, and the only thing that differs
 * is what the log line says happened. Splitting them would be two places to forget the push.
 *
 * A missing dump is silence, not an error: on a machine where `/outputfile inventory` has never
 * been typed there is nothing to load, and the surfaces already render that as the never-run
 * state (the `/outputfile` registry's own line).
 *
 * A TIMED SEAM (JOS-458): a synchronous file read plus a parse plus a clicky re-derivation over
 * the item corpus, on main, one statement before the rebuild fan-out. The STALENESS GUARD is
 * outside the bracket and the missing-file arm is inside it, deliberately — a call that was
 * refused for the wrong character did no work and must not be counted, while a call that went to
 * the filesystem and found nothing DID, and on a cold disk that probe is the measurement.
 */
function loadInventoryNow(ref: CharacterRef, why: 'startup' | 'watch'): void {
  // Captured rather than re-read inside the bracket: `character` is module-level and mutable, so
  // a closure cannot carry the guard's narrowing, and re-reading it would ALSO be a second read of
  // a value the guard has already ruled on.
  const who = character
  if (who?.logPath !== ref.logPath) return
  timeSeam('inventoryLoad', () => {
    const res = loadInventory(who.name, who.server, inventoryWrittenAt)
    if (!res) return
    setInventory(activeCharId(), res.counts, res.source)
    // A dump is the ONLY evidence that a cast-less firing was a click you made (JOS-438). The set
    // used to be re-derived here and pushed into this process's combat engine; it is an ENGINE
    // construction input now and reaches it on the next attach. NAMED GAP: a dump read mid-session
    // does not re-arm the clicky classification until the engine next re-folds, where it used to
    // take effect on the tail's next line. Closing it needs a `clickies.define` command.
    logInfo(
      `[everquest-companion] Inventory ${why === 'startup' ? 'loaded at startup' : 'auto-reloaded'}: ${res.path}`
    )
    sendToMain(IPC.onInventoryReload, { path: res.path, loadedAt: res.loadedAt })
    sendToMain(IPC.onProgress, getProgress(activeCharId()))
  })
}

/**
 * THE ACHIEVEMENTS DUMP'S TWO STEPS (JOS-429), written as the two functions above are written and
 * for the same reasons — read + follow, one function for both halves, a missing file is silence.
 *
 * WHAT IT PUSHES, AND WHAT IT DOES NOT. The store write lands on `ProgressState`, so `onProgress`
 * is the whole delivery: the Sky tab already re-renders on that push and derives the completions
 * from it on every read. There is NO second `inventory:autoReloaded`-shaped channel, deliberately —
 * that event means "the held counts moved", and an achievements dump moves no count. The freshness
 * line re-asks the registry on `onProgress` too (OutputKindLine), which is the one line that made a
 * new channel unnecessary.
 */
function loadAchievementsNow(ref: CharacterRef, why: 'startup' | 'watch'): void {
  const who = character
  if (who?.logPath !== ref.logPath) return
  // A TIMED SEAM, on `loadInventoryNow`'s terms exactly — same shape of work, same second file,
  // same place in `tailCharacter`, and the guard is likewise outside the bracket.
  timeSeam('achievementsLoad', () => {
    const res = loadAchievements(who.name, who.server)
    if (!res) return
    setAchievements(activeCharId(), res.unlocks, res.source)
    logInfo(
      `[everquest-companion] Achievements ${
        why === 'startup' ? 'loaded at startup' : 'auto-reloaded'
      }: ${res.path} (${String(res.unlocks.length)} class-unlock rewards earned)`
    )
    sendToMain(IPC.onProgress, getProgress(activeCharId()))
  })
}

/** Follow the achievements dump — `startInventoryWatch`'s twin, same registry, same staleness guard. */
function startAchievementsWatch(ref: CharacterRef): void {
  achievementsWatch?.close()
  achievementsWatch = watchOutputKind(
    'achievements',
    { name: ref.name, server: ref.server },
    {
      onChange: () => {
        loadAchievementsNow(ref, 'watch')
      },
      onError: (err) => {
        logConsoleError('[everquest-companion] achievements watch error', err)
      },
      active: () => character?.logPath === ref.logPath
    }
  )
}

/** Startup entry point: resolve a character and tail it, or idle quietly if there is none.
 *  Resolves to what the replay cost, or null on a machine with no log to tail at all — and, since
 *  JOS-457, also null when the user picked a different character before the startup fold finished,
 *  which is the same statement about the same number: this launch's replay was not the one kept. */
export async function startTailing(): Promise<boolean> {
  // AND ON THIS CALL THE SERVED ARM DEGRADES BY CONSTRUCTION, which is worth saying here rather than
  // leaving to be discovered in a fallback tally. `index.ts` calls this BEFORE
  // `startEngineSupervisor()`, and the supervisor is asynchronous end to end — so at the first
  // character choice of a launch there is no engine to ask and this process reads the folder itself.
  // That is precisely the arm `listCharacters` survived the deletion release for; every LATER
  // resolution (the picker's rows, a settings change, the idle rescan) happens with the engine
  // connected and is served.
  const ref = await resolveInitialCharacter()
  if (!ref) {
    logWarn('[everquest-companion] No EQ log found; watching for one to appear.')
    // Same trap as a dir change that finds nothing: the app launched before the player ever
    // typed `/log on`. Keep looking rather than requiring a restart.
    watchForFirstLog()
    return false
  }
  return tailCharacter(ref)
}

// `markTailPosition` IS GONE (JOS-499, boundary verdict 4). It recorded THIS process's tailer
// offset at both orderly exits so the next launch could say how many of the bytes it read were
// new since the last clean shutdown (JOS-57). The engine owns the tail and its own mark; an app
// that wrote one would be stating a position it never held.


/**
 * Release the session's OS resources (tail, watcher, heartbeat, rescan) on the way out — and leave
 * the mark above, BEFORE the tail is stopped in program order.
 */
export function stopSession(): void {
  // THE TAIL MARK IS THE ENGINE'S NOW (boundary verdict 4: "the log tail mark — the engine owns
  // the tail"). `markTailPosition()` wrote this process's own tailer offset so the next launch
  // could measure how many bytes had been appended since a clean shutdown; there is no tailer and
  // no offset of ours to write.
  inventoryWatch?.close()
  achievementsWatch?.close()
  stopWatchingForFirstLog()
  stopWatchingForQuietSwitch()
}

// `logTailIo` IS GONE (JOS-499). It printed what the live tail's file I/O cost — reopens, reads
// over 100 ms and over 500 ms — so the owner reproducing the EverQuest render freezes could say
// what the tail was doing rather than guess. `log/tailIoStats.ts` SURVIVES as the shape of that
// measurement; its feeder is the engine's tail now, and reporting it is part of ruling 19's
// engine-side perf surface rather than a line this process can write.
