// ============================================================================
// telemetry/setupSnapshot.ts — THE PRODUCER the contract has been waiting for (JOS-364).
// ============================================================================
//
// `setupSnapshot` was declared in wave A1 with a full rollup, a TELEMETRY.md section and a
// deliberate note that its producer was unbuilt. Three waves of panels have since been built on
// top of a metric no client has ever emitted, and the fleet consequently cannot answer the
// simplest question anyone asks about a report — "what is this person's machine". This file is
// the missing half.
//
// ONE EVENT, ONCE PER SESSION, AFTER THE REPLAY. It is scheduled by `perf.ts` when the
// `replayDone` phase is marked, plus a short delay: the startup replay is the app's heaviest
// stretch of work, every reading here is a disk or a driver call, and a snapshot that stole
// milliseconds from the launch would corrupt the very startup numbers it sits beside. It also
// means the reading describes a settled app rather than one mid-boot.
//
// `recordEvent` IS THE GATE, exactly as it is for every other producer: the user's single switch
// is checked there, once, and an install with analytics off drops this on the floor with
// everything else. Nothing in this file consults the pref itself — a second opinion about the
// switch is how two answers to one question get born.
//
// NOTHING HERE THROWS AND NOTHING HERE IS REQUIRED. Every reading is wrapped: a store that
// refuses, a Logs directory that vanished, a GPU that will not answer inside the cap, an
// `eqclient.ini` an antivirus has locked — each degrades to `unknown` or to a default and the
// event still goes out with everything else it did learn. A snapshot is a diagnostic; losing one
// is not an app failure, and taking one must never become one.
//
// THE ARITHMETIC IS NOT HERE. `./setupFacts.ts` turns raw answers into buckets and enums, and it
// imports nothing but the contract so it can be unit-tested without an Electron process. What
// this file owns is asking — and every question it asks is answered by the OS, the driver, the
// screen or our own store. None of it comes from log content, and no path or device string
// survives the seam between the two files.

import { app, screen } from 'electron'
import { statSync } from 'fs'
import { cpus, totalmem } from 'os'
import { resolveAlertAudio } from '../../shared/speechText'
import { OVERLAY_KINDS } from '../../shared/types'
import type { TelemetryOverlayKind, TelemetryVoiceEngine } from '../../shared/telemetry'
// ONE READER FOR `eqclient.ini` (JOS-368). It was private to this file until a second consumer
// arrived — the perf block a feedback report carries (`feedback/perf.ts`) — and a second parse of
// somebody else's settings file is how two answers to one question get born.
import { readEqClientIni } from '../eqWindowMode'
import { activeSafeMode } from '../graphics'
import { listCharacters, resolveActiveCharacter } from '../log/config'
import {
  getAlerts,
  getCursorRing,
  getOverlayAutoHide,
  getOverlayConfig,
  getUpdateChannel,
  getVoicePrefs
} from '../store'
import { listPacks } from '../sounds'
import { recordEvent, telemetryCollecting } from './collector'
import { buildSetupSnapshot, type SetupFacts } from './setupFacts'

/**
 * How long after `replayDone` the snapshot is taken.
 *
 * LONG ENOUGH TO BE OUT OF THE WAY, short enough that a session which ends early still reports:
 * the ring is on disk and rides the next flush, so a snapshot taken at ten seconds survives a
 * player who quits at thirty, while one taken on the ten-minute heartbeat would be missing from
 * every short session — and short sessions are disproportionately the ones with something wrong.
 */
const SNAPSHOT_DELAY_MS = 10_000

/**
 * The cap on `getGPUInfo`. It is a PROMISE, not a timeout on a fast path: the call goes to the
 * GPU process, and the machines this whole ticket is about are exactly the ones where that
 * process is unhealthy. An unanswered call must cost the snapshot its vendor field and nothing
 * else — never the event, and never a pending promise held for the life of the session.
 */
const GPU_INFO_TIMEOUT_MS = 5_000

/**
 * How long after an OPT-IN the snapshot is re-armed. Short, because the reason the boot delay is
 * ten seconds — stay out of the way of a launch — does not apply to a switch a user pressed
 * minutes later. It is not zero so the toggle's own IPC answer is never behind a `getGPUInfo`.
 */
const OPT_IN_DELAY_MS = 1_000

/**
 * ONE PER PROCESS — AND THE LATCH IS ON THE RECORD, NOT ON THE TIMER (JOS-501).
 *
 * It used to be one boolean set when the timer was ARMED, and that quietly lost the snapshot for
 * a whole class of session. The snapshot fires ten seconds after `replayDone`; `recordEvent` drops
 * everything while collection is off; and the latch then guaranteed no second attempt. So a user
 * who launched opted out and turned telemetry ON afterwards contributed no machine-class row for
 * that session — which is the population the snapshot exists for, since somebody enabling
 * telemetry mid-session is very often doing it to report a problem.
 *
 * `armed` prevents two timers; `recorded` is the once-ever fact, and only a snapshot the ring
 * actually ACCEPTED sets it. The telemetry e2e was red on exactly this: its fourth launch boots
 * opted out and flips the switch on, and no snapshot could ever follow.
 */
let armed = false
let recorded = false

/**
 * Arm the snapshot. Called from `markStartupPhase('replayDone')` — the one moment the app agrees
 * its launch is over — and from the opt-in edge (`flush.ts applyTelemetryEnabled`). Idempotent:
 * an extra call is a no-op rather than a second event.
 *
 * The timer is `unref`'d: a snapshot pending when the user quits must not hold the process open
 * for ten seconds to file a diagnostic about a session that has ended.
 */
export function scheduleSetupSnapshot(delayMs = SNAPSHOT_DELAY_MS): void {
  if (armed || recorded) return
  armed = true
  const timer = setTimeout(() => {
    armed = false
    void recordSetupSnapshot()
  }, delayMs)
  timer.unref()
}

/**
 * THE USER JUST TURNED TELEMETRY ON. Re-arm if this process never managed to file its snapshot.
 *
 * Called from `flush.ts applyTelemetryEnabled`, which is the ONE place both the Preferences toggle
 * and the first-run notice go through — so the two can no more diverge here than they can on the
 * switch itself. A no-op when the snapshot already landed, which is the ordinary launch.
 */
export function armSetupSnapshotOnOptIn(): void {
  scheduleSetupSnapshot(OPT_IN_DELAY_MS)
}

/** Test seam: forget that a snapshot was armed or taken. Never called by the app. */
export function resetSetupSnapshot(): void {
  armed = false
  recorded = false
}

/**
 * Take the snapshot now. Exported for the IPC-free path a future "send diagnostics" button would
 * want, and awaited by nothing: the whole point is that it cannot delay anything.
 *
 * IT ASKS THE RING BEFORE IT BUILDS, and that order is the fix rather than an optimisation. The
 * gather below reaches the store, the filesystem and the GPU process; doing all of it to hand the
 * result to a `recordEvent` that will drop it is waste, but the part that MATTERS is that a
 * dropped snapshot must not count as a taken one. `recorded` is therefore set on the far side of
 * the record, and a disabled ring leaves the snapshot pending for the opt-in edge to re-arm.
 */
export async function recordSetupSnapshot(): Promise<void> {
  if (recorded || !telemetryCollecting()) return
  try {
    recordEvent(buildSetupSnapshot(await gatherFacts()))
    recorded = true
  } catch {
    // Deliberately silent, and deliberately not `logError`: a diagnostic that files an error
    // report about its own failure to file a diagnostic is a loop with a fleet-wide audience.
    // `recorded` stays false, so a later opt-in gets one more attempt.
  }
}

/** Everything the machine and the store will say, each reading independently defended. */
async function gatherFacts(): Promise<SetupFacts> {
  return {
    charCount: safely(() => listCharacters().length, 0),
    logBytes: safely(logBytes, 0),
    alertCount: safely(() => getAlerts().length, 0),
    overlaysEnabled: safely(openOverlays, []),
    cursorRing: safely(() => getCursorRing().enabled, false),
    autoHide: safely(autoHideOn, false),
    voiceEngine: safely(voiceEngine, 'off'),
    soundPackCount: safely(() => listPacks().length, 0),
    updateChannel: safely(getUpdateChannel, 'main'),
    cpuCount: safely(() => cpus().length, undefined),
    totalMemBytes: safely(totalmem, undefined),
    gpuVendorId: await gpuVendorId(),
    gpuCompositingStatus: safely(compositingStatus, undefined),
    // `activeSafeMode()` is what this launch DID, not what the setting says now — a user who
    // turned safe mode off ten seconds ago is still running the accelerated-or-not process they
    // started with, and the snapshot describes the running app.
    safeMode: safely(() => activeSafeMode() !== null, undefined),
    displayCount: safely(() => screen.getAllDisplays().length, undefined),
    primaryScaleFactor: safely(() => screen.getPrimaryDisplay().scaleFactor, undefined),
    eqClientIni: safely(readEqClientIni, null)
  }
}

/** Run a reading, or answer with the fallback. The lambda-per-field shape is what keeps ONE
 *  failing driver call from costing the other twelve readings their event. */
function safely<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/** Size of the log the app is actually tailing. Not the biggest log, not the sum: the file whose
 *  size explains this session's replay cost. */
function logBytes(): number {
  const path = resolveActiveCharacter()?.logPath
  return path === undefined ? 0 : statSync(path).size
}

/** The overlay windows this install has OPEN. No cast is needed and that is the point:
 *  `OVERLAY_KINDS` and the schema's `TELEMETRY_OVERLAY_KINDS` are pinned equal
 *  (tests/telemetryContract.test.mts), so the app's own union assigns straight across — the day
 *  someone adds an overlay without teaching the schema, this stops compiling. */
function openOverlays(): TelemetryOverlayKind[] {
  return OVERLAY_KINDS.filter((kind) => getOverlayConfig(kind).open)
}

/**
 * IS OVERLAY AUTO-HIDE ON — one wire boolean over a preference that is two switches (hide while
 * EverQuest is not running, hide while it is not focused).
 *
 * EITHER ONE COUNTS, and that is the only reading the field can honestly carry: `autoHide` was
 * declared when there was one switch, the question it answers is "do this install's overlays
 * disappear on their own", and both switches answer yes to it. Which of the two is a question
 * this event cannot ask without a second field, and nothing needs it yet.
 */
function autoHideOn(): boolean {
  const prefs = getOverlayAutoHide()
  return prefs.hideWhenNotRunning || prefs.hideWhenUnfocused
}

/**
 * WHICH TIER THIS INSTALL SPEAKS WITH, under the contract's own definition of the field: 'off'
 * means NO ENABLED ALERT IS SET TO SPEAK (shared/telemetry.ts spells out why, and warns whoever
 * built this producer not to re-derive the retired master-switch meaning from the name).
 *
 * `resolveAlertAudio` is the one place a def's channel is decided — the same call the alert
 * firing path makes — so this reading cannot disagree with what the app would actually do.
 */
function voiceEngine(): TelemetryVoiceEngine {
  const speaks = getAlerts().some((def) => def.enabled && resolveAlertAudio(def) === 'speech')
  return speaks ? getVoicePrefs().engine : 'off'
}

/** `gpu_compositing` off the feature-status blob, verbatim — the folding into three words is
 *  `gpuCompositingOf`'s job, in the file that can be tested. */
function compositingStatus(): string | undefined {
  // Read as `unknown` on purpose: Electron's type says this field is a string, and Electron's
  // type is a promise about a Chromium blob that arrives at runtime from a machine we do not own.
  const raw: unknown = app.getGPUFeatureStatus().gpu_compositing
  return typeof raw === 'string' ? raw : undefined
}

/**
 * The GPU's PCI vendor id, or `undefined` if the GPU process does not answer within the cap.
 *
 * `'basic'` rather than `'complete'`: the complete blob carries driver versions, device names and
 * a display topology, none of which this schema can express and all of which would be sitting in
 * this process for no reason. The basic blob is a vendor and a device id, and only the vendor is
 * read.
 */
async function gpuVendorId(): Promise<number | string | undefined> {
  try {
    const info = (await Promise.race([
      app.getGPUInfo('basic'),
      new Promise((resolve) => setTimeout(resolve, GPU_INFO_TIMEOUT_MS).unref())
    ])) as { gpuDevice?: { vendorId?: number | string; active?: boolean }[] } | undefined
    const devices = info?.gpuDevice ?? []
    // The ACTIVE device when Chromium names one — a laptop with switchable graphics lists both
    // its integrated and its discrete GPU, and the one doing the work is the one worth counting.
    const device = devices.find((d) => d.active === true) ?? devices[0]
    return device?.vendorId
  } catch {
    return undefined
  }
}
