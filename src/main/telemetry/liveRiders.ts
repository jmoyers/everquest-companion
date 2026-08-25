// ============================================================================
// telemetry/liveRiders.ts — what a RUNNING session reports about itself (JOS-367).
// ============================================================================
//
// THE GATHERING HALF. `./liveFacts.ts` owns the arithmetic (and can therefore be tested); this
// file owns the asking, and every question it asks is answered by our own probe, our own tail,
// our own windows, our own store or the OS. None of it comes from log CONTENT, and no path or
// name survives the seam between the two files — the same boundary `setupSnapshot.ts` /
// `setupFacts.ts` draw, one subject over.
//
// DRAINED BY WHICHEVER SESSION REPORT FIRES FIRST — `sessionHeartbeat` or `sessionEnd`, exactly
// like `linesParsed` and the startup reading. That is what makes the fleet-wide numbers a sum of
// DELTAS: each interval is reported once, and a session that is killed loses at most its last
// window rather than double-counting an earlier one.
//
// NOTHING HERE THROWS AND NOTHING HERE IS REQUIRED. Each of the three groups is wrapped
// independently: a store that refuses, an overlay registry mid-teardown, an OS that will not
// answer for its own memory — each costs its own group and never the report, and never the
// session. A diagnostic that can fail a heartbeat is worse than no diagnostic.
//
// `recordEvent` IS STILL THE GATE. Nothing here consults the user's switch: the events these ride
// on are written through the one function that checks it, once, like every other producer.

import { app } from 'electron'
import { statSync } from 'fs'
import { presenceNeeded } from '../../shared/presencePrefs'
import type { RawProcessMetric } from '../../shared/perf'
import { OVERLAY_KINDS } from '../../shared/types'
import type { EvSessionHeartbeat } from '../../shared/telemetry'
import { peekTailIoTimeline, takeTailIoSummary } from '../log/tailIoStats'
import { resolveActiveCharacter } from '../log/config'
import { takeLiveProbeReading } from '../livePerfProbe'
import { takeGcTally, takeSeamTally } from '../perfAttribution'
import { getCursorRing, getOverlayAutoHide, getOverlayConfig } from '../store'
import { overlayStateMap } from '../windows'
import { gcStallStats, liveStallStats, seamStallStats, sessionStateStats, tailReadStats } from './liveFacts'

/** The five optional groups, in the shape both session reports spread. */
type LiveRiders = Pick<EvSessionHeartbeat, 'live' | 'tail' | 'state' | 'gc' | 'seams'>

/**
 * When the interval being reported began — `Date.now()` of the previous drain.
 *
 * It exists for ONE reader: the tail's p95, which is computed from a ring that is not reset by a
 * report (`tailIoStats.ts` keeps the fold and the shape apart on purpose), so the samples that
 * belong to THIS interval have to be selected by time. Everything else here is already a delta.
 */
let since = 0

/** Run a reading, or answer with the fallback. The lambda-per-group shape is what keeps one
 *  failing question from costing the other two their place on the report. */
function safely<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/** The stall reading, drained. Absent when the probe has not observed a single tick — a session
 *  that never ran it has not observed a smooth interval, it has observed nothing. */
function liveGroup(): LiveRiders['live'] {
  const reading = takeLiveProbeReading()
  return reading === null ? undefined : liveStallStats(reading)
}

/**
 * THE TWO ATTRIBUTION GROUPS (JOS-458), drained on exactly the terms `liveGroup` is drained on.
 *
 * They are separate functions rather than one because their absences mean different things and
 * neither may borrow the other's: `gc` is absent when the OBSERVER was not running (zeros are a
 * real reading from a running one), `seams` is absent when NO instrumented seam was entered (which
 * is not "they were fast" — it is the reading that clears all six at once).
 */
function gcGroup(): LiveRiders['gc'] {
  const tally = takeGcTally()
  return tally === null ? undefined : gcStallStats(tally)
}

function seamGroup(): LiveRiders['seams'] {
  const tally = takeSeamTally()
  return tally === null ? undefined : seamStallStats(tally)
}

/**
 * The tail's read cost, drained. Absent when nothing was read — which covers both the session
 * with no character attached and the interval in which the player was not playing. Neither is a
 * row of zeros: `takeTailIoSummary()` answers `null` rather than a zero row for exactly this
 * reason, and inventing one here would drag every fleet figure toward a machine that did no work.
 */
function tailGroup(from: number, to: number): LiveRiders['tail'] {
  const summary = takeTailIoSummary()
  if (summary === null) return undefined
  const window = peekTailIoTimeline().filter((s) => s.at >= from && s.at <= to)
  return tailReadStats({ summary, window, logBytes: safely(logBytes, 0) })
}

/** Size of the log the app is actually tailing — the file whose reads the numbers above describe.
 *  0 when nothing is attached, which buckets to 0 and is the honest reading of "no log". */
function logBytes(): number {
  const path = resolveActiveCharacter()?.logPath
  return path === undefined ? 0 : statSync(path).size
}

/**
 * What was switched on while the two groups above were measured.
 *
 * `overlaysLocked` counts OPEN overlays whose config is locked — click-through, which on Windows
 * means the process-wide `WH_MOUSE_LL` hook is armed and every system mouse event waits on our
 * message loop. Both halves are read through the existing exports (`overlayStateMap`,
 * `getOverlayConfig`) rather than a new one: this file may describe the window layer, not reach
 * into it.
 */
function stateGroup(): LiveRiders['state'] {
  const open = safely(overlayStateMap, null)
  if (open === null) return undefined
  const kinds = OVERLAY_KINDS.filter((kind) => open[kind])
  return sessionStateStats({
    overlaysOpen: kinds.length,
    overlaysLocked: safely(() => kinds.filter((k) => getOverlayConfig(k).locked).length, 0),
    presenceOn: safely(() => presenceNeeded(getCursorRing(), getOverlayAutoHide()), false),
    ringOn: safely(() => getCursorRing().enabled, false),
    freeMemKb: safely(() => process.getSystemMemoryInfo().free, 0),
    workingSetKb: safely(workingSetKb, 0)
  })
}

/** Every process this app is running, summed. The honesty term beside free memory: what WE were
 *  costing the machine while it stalled. */
function workingSetKb(): number {
  const metrics = app.getAppMetrics() as unknown as RawProcessMetric[]
  return metrics.reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0)
}

/**
 * The five riders for the report about to be written, drained and reset. Spread into
 * `sessionHeartbeat` / `sessionEnd` — `{}` for a group with nothing to say, so the property is
 * ABSENT rather than `undefined` (the same three-way distinction `startupField` keeps: the
 * validator's `undefined` arm, JSON's omission and the payload viewer all have to agree).
 *
 * EVERY GROUP IS DRAINED THROUGH ITS OWN `safely`, and that is load-bearing rather than tidy: a
 * report that lost its stall reading because the window layer was mid-teardown would also lose the
 * seam reading that explains it, and the pair is the whole point.
 */
export function liveRiderFields(now = Date.now()): LiveRiders {
  const from = since
  since = now
  const live = safely(liveGroup, undefined)
  const tail = safely(() => tailGroup(from, now), undefined)
  const state = safely(stateGroup, undefined)
  const gc = safely(gcGroup, undefined)
  const seams = safely(seamGroup, undefined)
  return {
    ...(live === undefined ? {} : { live }),
    ...(tail === undefined ? {} : { tail }),
    ...(state === undefined ? {} : { state }),
    ...(gc === undefined ? {} : { gc }),
    ...(seams === undefined ? {} : { seams })
  }
}
