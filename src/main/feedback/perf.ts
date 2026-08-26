// ============================================================================
// feedback/perf.ts — THE GATHERING HALF of the report's perf block (JOS-369).
// ============================================================================
//
// `shared/feedbackPerf.ts` owns the arithmetic and the vocabulary — and can therefore be tested
// without an Electron process. THIS file owns the ASKING, and every question it asks is answered
// by our own probe, our own tail, our own windows, our own store, the OS or the driver. It is the
// same split `telemetry/setupSnapshot.ts` / `telemetry/setupFacts.ts` draw, and it is drawn in the
// same place for the same reason: no string from the machine, no path and no character identity
// survives the seam between the two files.
//
// ============================ THE ENVELOPE RULES, AS THEY APPLY HERE ============================
// The feedback envelope's laws (see `submit.ts` and `slice.ts`): nothing from the game log, no
// filesystem paths, and `installId` never joins `analyticsId`. This module reads NOTHING from the
// log — the only thing it knows about the tail is how long its reads TOOK — reads no path (the one
// file it consults, `eqclient.ini`, is read by `eqWindowMode()`, which returns one of three words
// and retains nothing else), and touches no identifier of any kind.
//
// NOTHING HERE THROWS AND NOTHING HERE IS REQUIRED. Every reading is wrapped independently: a
// store that refuses, an overlay registry mid-teardown, a GPU process that will not answer, an OS
// that will not report its own memory — each costs its own field and never the report. A
// diagnostic that can fail a bug report is worse than no diagnostic.

import { app } from 'electron'
import { cpus, totalmem } from 'node:os'
import {
  foldFeedbackPerf,
  MAX_PERF_BYTES,
  perfBytes,
  type FeedbackPerf,
  type FeedbackPerfState
} from '../../shared/feedbackPerf'
import type { EngineFoldInput } from '../../shared/feedbackPerfEngine'
import { presenceNeeded } from '../../shared/presencePrefs'
import type { RawProcessMetric } from '../../shared/perf'
import { OVERLAY_KINDS } from '../../shared/types'
import {
  enginePerfBudgets,
  enginePerfSnapshot,
  enginePerfTimeline
} from '../dataServer/engineClientHost'
import { eqWindowMode } from '../eqWindowMode'
import { peekLiveTimeline } from '../livePerfProbe'
import { peekAttributionTimeline } from '../perfAttribution'
import { peekTailIoTimeline } from '../log/tailIoStats'
import { getCursorRing, getOverlayAutoHide, getOverlayConfig } from '../store'
import { gpuCompositingOf, gpuVendorOf } from '../telemetry/setupFacts'
import { overlayStateMap } from '../windows'

/**
 * The cap on `getGPUInfo`, and it is DELIBERATELY SHORTER than the setup snapshot's five seconds.
 * That call is made ten seconds after launch with nobody waiting on it; this one is made while a
 * user sits in front of an open dialog, and the machines this whole feature is about are exactly
 * the ones whose GPU process is unhealthy. One second, then the vendor is `unknown`.
 */
const GPU_INFO_TIMEOUT_MS = 1_000

/** Run a reading, or answer with the fallback. The lambda-per-field shape is what keeps ONE
 *  failing driver call from costing the other ten readings their place in the block. */
function safely<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/**
 * The GPU's PCI vendor id, asked ONCE PER PROCESS and remembered.
 *
 * A machine does not change graphics card between two bug reports, and the second report must not
 * pay the timeout again — the whole reason the cap above is one second is that a human is waiting,
 * and the cheapest way to honour that is to only ever wait once. The memo holds the PROMISE, so
 * two dialogs opened in the same second share one call rather than racing two.
 */
let gpuVendorMemo: Promise<number | string | undefined> | null = null

function gpuVendorId(): Promise<number | string | undefined> {
  gpuVendorMemo ??= (async () => {
    try {
      const info = (await Promise.race([
        app.getGPUInfo('basic'),
        new Promise((resolve) => setTimeout(resolve, GPU_INFO_TIMEOUT_MS).unref())
      ])) as { gpuDevice?: { vendorId?: number | string; active?: boolean }[] } | undefined
      const devices = info?.gpuDevice ?? []
      // The ACTIVE device when Chromium names one — a laptop with switchable graphics lists both,
      // and the one doing the work is the one worth naming.
      return (devices.find((d) => d.active === true) ?? devices[0])?.vendorId
    } catch {
      return undefined
    }
  })()
  return gpuVendorMemo
}

/** Test seam: forget the memoized vendor. Never called by the app. */
export function resetFeedbackPerfMemo(): void {
  gpuVendorMemo = null
}

/** Kilobytes (Electron's and Chromium's unit for both readings below) → whole megabytes. */
function mb(kb: number): number {
  return Math.max(0, Math.round(kb / 1024))
}

/** Every process this app is running, summed — what WE were costing the machine while it stalled. */
function workingSetKb(): number {
  const metrics = app.getAppMetrics() as unknown as RawProcessMetric[]
  return metrics.reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0)
}

/**
 * What was switched on and what the machine is. The overlay half is read through the existing
 * exports (`overlayStateMap`, `getOverlayConfig`) rather than a new one, exactly as
 * `telemetry/liveRiders.ts` does: this file may DESCRIBE the window layer, not reach into it.
 */
async function perfState(): Promise<FeedbackPerfState> {
  const open = safely(overlayStateMap, null)
  const kinds = open === null ? [] : OVERLAY_KINDS.filter((kind) => open[kind])
  return {
    overlaysOpen: kinds.length,
    overlaysLocked: safely(() => kinds.filter((k) => getOverlayConfig(k).locked).length, 0),
    presenceOn: safely(() => presenceNeeded(getCursorRing(), getOverlayAutoHide()), false),
    ringOn: safely(() => getCursorRing().enabled, false),
    freeMemMb: mb(safely(() => process.getSystemMemoryInfo().free, 0)),
    workingSetMb: mb(safely(workingSetKb, 0)),
    cpuCount: safely(() => cpus().length, 0),
    // Whole gibibytes, ROUNDED: a 16 GB machine reports 15.9 after the firmware and the iGPU have
    // taken their share, and truncating would file it as 15 (the `memGb` note in setupFacts.ts).
    totalMemGb: safely(() => Math.floor(totalmem() / 1_073_741_824 + 0.5), 0),
    gpuVendor: gpuVendorOf(await gpuVendorId()),
    gpuCompositing: gpuCompositingOf(
      safely((): unknown => app.getGPUFeatureStatus().gpu_compositing, undefined)
    ),
    eqWindowMode: safely(eqWindowMode, 'unknown')
  }
}

/**
 * THE ENGINE'S THREE ANSWERS (owner ruling 19, JOS-502) — the asking half, which is all this file
 * ever owns. `shared/feedbackPerfEngine.ts` turns them into the block and argues the bright line.
 *
 * NOTHING HERE IS REQUIRED, AND EACH ANSWER COSTS ONLY ITSELF — this file's standing rule, applied
 * to three round trips instead of a driver call. All three accessors already resolve to `null`
 * rather than throwing (`engineClientHost.ts` calls that posture out explicitly: a diagnostic that
 * can break the thing it measures is worse than no diagnostic), and the `catch` is the backstop for
 * the case nobody thought of.
 *
 * THE SNAPSHOT IS ASKED FIRST AND ITS ABSENCE ENDS THE QUESTION. There is no engine to ask, so
 * there is nothing for the other two to be about — and skipping them saves a report composed on a
 * build with no engine two pointless round trips. It is the same ordering law the rings get below:
 * check the cheap thing that decides the answer before paying for the rest.
 *
 * IT ASKS RATHER THAN READING THE PANEL'S LAST SAMPLE, deliberately. `enginePerfWatch.ts` polls
 * only while the performance panel is open, so its newest sample is usually minutes old or absent
 * — and a bug report is composed at the moment something went wrong, which is exactly when a stale
 * reading would be worst.
 */
async function engineReadings(now: number): Promise<EngineFoldInput | undefined> {
  try {
    const snapshot = await enginePerfSnapshot()
    if (snapshot === null) return { snapshot: null, budgets: null, timeline: null, now }
    return {
      snapshot,
      budgets: await enginePerfBudgets(),
      timeline: await enginePerfTimeline(),
      now
    }
  } catch {
    return undefined
  }
}

/**
 * The block for the report being composed, or `null`.
 *
 * `null` in three cases, all of them normal and none of them an error: the rings are empty (a
 * report sent before `replayDone`, or a build with no probe), a reading threw so hard that the
 * fold had nothing to fold, or the block came out over `MAX_PERF_BYTES`.
 *
 * THE OVERSIZE CASE OMITS RATHER THAN TRIMS. A half-timeline is a well-formed block that quietly
 * claims the missing minutes were quiet — the same failure mode a trimmed inventory dump has, and
 * the reason that attachment is refused rather than shortened (`shared/feedback.ts`,
 * MAX_INVENTORY_LINES). The block is bounded by construction at sixty rows of six small integers,
 * so this arm should never fire; it is here so that "it fits" is enforced rather than assumed.
 */
export async function feedbackPerfBlock(now = Date.now()): Promise<FeedbackPerf | null> {
  try {
    const timeline = peekLiveTimeline(now)
    // The tail ring is read HERE rather than off `peekLiveTimeline()` because the block wants the
    // reopen count, and that view drops the reason to keep its own shape narrow.
    const tail = peekTailIoTimeline().map((s) => ({
      at: s.at,
      readMs: s.readMs,
      reopened: s.reason !== 'reused'
    }))
    // THE RINGS ARE CHECKED BEFORE THE MACHINE IS ASKED, and that ordering is the point: a report
    // composed before `replayDone` has no timeline to carry, and it must not pay a second of GPU
    // timeout to find that out. `foldFeedbackPerf` would answer `null` anyway — this is the same
    // decision made one step earlier, where it is still free.
    if (timeline.main.length === 0 && timeline.worker.length === 0 && tail.length === 0) return null
    // THE ATTRIBUTION RINGS ARE PEEKED, NEVER DRAINED (JOS-458) — `peekLiveTimeline`'s posture one
    // instrument over, and load-bearing: the telemetry seam drains the same instrument's
    // ACCUMULATOR on its own schedule, and a bug report that consumed the ring would silently cost
    // the next heartbeat its reading. They are read AFTER the empty check for the same reason the
    // tail is: a report composed before `replayDone` has no attribution either, and must not pay
    // for finding that out.
    const attribution = safely(() => peekAttributionTimeline(now), { seams: [], gc: [] })
    const perf = foldFeedbackPerf(
      {
        main: timeline.main,
        worker: timeline.worker,
        tail,
        state: await perfState(),
        seams: attribution.seams,
        gc: attribution.gc,
        engine: await engineReadings(now)
      },
      now
    )
    return perf !== null && perfBytes(perf) <= MAX_PERF_BYTES ? perf : null
  } catch {
    return null
  }
}
