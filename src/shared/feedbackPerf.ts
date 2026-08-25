// ============================================================================
// feedbackPerf.ts — THE LAST TEN MINUTES, folded small enough to ride a bug report (JOS-369).
// ============================================================================
//
// "It hitches sometimes" is the report we get, and nothing in it says whether the MACHINE
// stalled, WE stalled, or the log READ stalled at that moment. JOS-367 built the two clocks and
// the ~10 minute rings (`main/livePerfProbe.ts`, `main/log/tailIoStats.ts`); this file is the
// fold that turns those rings into something a report can carry, and the one renderer the
// dialog, the triage CLI and the triage panel all print through.
//
// ============================ WHY UN-BUCKETED HERE, BUCKETED ON THE HEARTBEAT ============
// THE COMMENT LAW THE TICKET ASKS FOR, stated once, here, because the two paths look
// contradictory until you name what makes them different: CONSENT AND AUDIENCE.
//
//   * The HEARTBEAT (`telemetry/liveFacts.ts`) leaves the machine ON ITS OWN, for every install
//     with the switch on, and it describes a FLEET. Raw milliseconds there would be a per-install
//     fingerprint nobody asked to hand over and a resolution no fleet question needs, so it ships
//     BUCKET INDICES off a closed ladder (`LIVE_STALL_MS_EDGES`) — the telemetry bright line.
//   * A FEEDBACK REPORT is USER-INITIATED, shown in full before it is sent, and describes ONE
//     MOMENT the user is complaining about. Bucketing that would destroy the only thing it is
//     for: the SHAPE of the hitch — where in the ten minutes it happened, how wide it was, and
//     whether the tail was reading at the time. So this block is raw whole milliseconds.
//
// Neither posture is a relaxation of the other. Nothing here auto-sends, and nothing here is
// gathered unless a report is being composed.
//
// WHAT IS AND IS NOT IN IT. Whole numbers and members of closed enums declared in
// `shared/telemetry.ts` — no strings from the machine, no paths, nothing from the log, no
// character or install identity. The block is machine TIMING, which is why it is shown in the
// preview but is not behind its own checkbox: there is no personal data in it to consent to.
//
// PURE. It is imported by `shared/feedback.ts`, which the ingest Lambda bundles, so it may never
// reach Electron, the DOM or `node:`.

import { percentile, round } from './perf'
// THE OTHER HALF OF THE SAME BLOCK (JOS-458) — who owned the hitch, beside how bad it was. Its own
// file because this one is at its factoring ceiling; see its header for the cut.
import {
  foldPerfOwner,
  formatPerfOwner,
  validatePerfOwner,
  type FeedbackPerfGc,
  type FeedbackPerfSeam,
  type PerfGcSample,
  type PerfSeamSample
} from './feedbackPerfSeams'
import {
  LIVE_PROBE_REPORT_MS,
  LIVE_STALL_FREEZE_MS,
  LIVE_TIMELINE_MS,
  coincidentWindows,
  type LiveLateSample
} from './perfLive'
import {
  TELEMETRY_EQ_WINDOW_MODES,
  TELEMETRY_GPU_COMPOSITING,
  TELEMETRY_GPU_VENDORS,
  type TelemetryEqWindowMode,
  type TelemetryGpuCompositing,
  type TelemetryGpuVendor
} from './telemetry'

/** One row's width. Ten seconds is the coarsest grid a ~1 s freeze still stands out on, and the
 *  finest one that fits ten minutes into sixty rows and a few kilobytes of JSON. */
export const PERF_INTERVAL_MS = 10_000

/** Rows in the block — the whole ring, divided by the row width, and pinned equal to it in the
 *  tests so a change to either constant cannot silently shorten the timeline. */
export const PERF_ROWS = LIVE_TIMELINE_MS / PERF_INTERVAL_MS

/**
 * THE SIZE GUARD, in bytes of serialized JSON.
 *
 * The block RIDES `env_json` (it is a sub-object of `FeedbackEnv`), which means it shares
 * `MAX_BODY_BYTES` — 32 KB — with the user's 4,000-character description and both attachment
 * metadata blocks.
 *
 * MEASURED, and RE-MEASURED at JOS-458 when the two attribution groups joined the block: a quiet
 * window is 5,833 bytes, one carrying all six seams and a GC reading is 6,289, and a block with
 * every field at the ceilings below is 8,087. The grid is FIXED, so the size barely varies — which
 * is the property that makes 8 KB a tripwire rather than a budget: no shape-valid block can exceed
 * it today, and the day someone adds a seventh column the unit test goes red before the 400s do.
 *
 * THE HEADROOM IS NOW 105 BYTES, and that is said out loud because it is the number the NEXT
 * person needs. The cap was deliberately NOT raised for JOS-458 — a real block is 6,289 and has
 * nearly two kilobytes to spare, so nothing a user can produce is near it — but the adversarial
 * ceiling is close enough that the next field added here must re-price this constant rather than
 * assume it fits. The block shares `MAX_BODY_BYTES` with 4,000 characters of the user's prose, so
 * raising it is a decision with a second party, not a formality.
 *
 * The client OMITS an oversize block rather than shrinking it (a half-timeline is a wrong answer
 * that looks like a right one), and the validator refuses one, so a forged payload cannot use
 * this field as a 24 KB free-text channel either.
 */
export const MAX_PERF_BYTES = 8 * 1024

/** Ceilings for the whole numbers in a row. Nothing real approaches these — they exist so a
 *  forged block is bounded by the same validator that bounds every other field on this wire. */
export const MAX_PERF_MS = 3_600_000
export const MAX_PERF_COUNT = 1_000_000

/**
 * One ten-second bucket. Every field is a whole number and every field is a MAXIMUM or a COUNT,
 * never an average: an average over ten seconds hides the single 900 ms tick that is the entire
 * reason the user opened this dialog.
 */
export interface FeedbackPerfRow {
  /** Offset in SECONDS from the start of the window (0, 10, … 590). Not a wall clock: the block
   *  says how long ago something happened, never when — and never on whose machine. */
  t: number
  /** Worst main-thread timer lateness observed in this bucket. */
  mainMaxLateMs: number
  /** The same, on the probe WORKER. Both late in one bucket ⇒ the machine, not us. */
  workerMaxLateMs: number
  /** Worst single tail read leg — the number EverQuest's own synchronous append competes with. */
  tailMaxMs: number
  tailReads: number
  /** Read cycles that had to OPEN a handle. Steady-state tailing opens nothing. */
  tailReopens: number
}

/** The four numbers that answer "was this a real hitch, and whose". */
export interface FeedbackPerfSummary {
  /**
   * p95 OF THE LATE TICKS, and the name is the whole caveat: the ring only keeps ticks at or over
   * `LIVE_PROBE_REPORT_MS`, so this is a percentile of what was late, not of every tick. That is
   * the honest reading of the data that exists — a p95 over a ring that never stored the healthy
   * ticks would claim a denominator it does not have.
   */
  p95MainMs: number
  maxMainMs: number
  /** Stalls seen by BOTH threads in the window — `coincidentWindows`' verdict. The machine. */
  coincident: number
  /** Main-thread ticks at or over `LIVE_STALL_FREEZE_MS`. Not a hitch; a pause. */
  over500: number
}

/** What was switched on and what the machine is, while the rows above were measured. Booleans,
 *  whole numbers and closed enums — the same vocabulary the setup snapshot declared (JOS-364). */
export interface FeedbackPerfState {
  overlaysOpen: number
  /** Open overlays that are LOCKED (click-through) — on Windows that arms a process-wide mouse
   *  hook, and every system mouse event then waits on our message loop. */
  overlaysLocked: number
  presenceOn: boolean
  ringOn: boolean
  freeMemMb: number
  /** Every process this app runs, summed — what WE were costing the machine while it stalled. */
  workingSetMb: number
  cpuCount: number
  totalMemGb: number
  gpuVendor: TelemetryGpuVendor
  gpuCompositing: TelemetryGpuCompositing
  /** How the game presents itself, which is the other half of any z-order stall over it.
   *  `fullscreen` is the game's own Fullscreen setting being on — a BORDERLESS fullscreen window
   *  on the current client, not an exclusive display mode (JOS-375). */
  eqWindowMode: TelemetryEqWindowMode
}

/** The block, as it rides `env_json`. */
export interface FeedbackPerf {
  intervalMs: number
  rows: FeedbackPerfRow[]
  summary: FeedbackPerfSummary
  state: FeedbackPerfState
  /**
   * WHO OWNED THE SLOW MOMENTS (JOS-458), worst first — so `seams[0]` is the culprit and every
   * reader names the same one. Absent when no instrumented seam was slow enough to record, which
   * is a FINDING (it clears all six at once) and not "we did not look"; `formatPerfOwner` says so
   * in words rather than leaving the reader to infer it from an empty key.
   *
   * ADDITIVE, on `optionalMeta`'s terms: absent and null are the same answer, so every client
   * already installed keeps validating.
   */
  seams?: FeedbackPerfSeam[]
  /** …and what V8 spent over the same window. Absent on the same terms. */
  gc?: FeedbackPerfGc
}

/** One tail read cycle, as much of it as this fold needs. */
export interface PerfTailSample {
  at: number
  readMs: number
  /** `reason !== 'reused'` — the fold never sees the reason itself, only whether it opened. */
  reopened: boolean
}

/** Everything the fold reads. Assembled by the main process from the two rings plus the store,
 *  the OS and the window layer; nothing in here is a string from the machine. */
export interface PerfFoldInput {
  main: readonly LiveLateSample[]
  worker: readonly LiveLateSample[]
  tail: readonly PerfTailSample[]
  state: FeedbackPerfState
  /** The attribution rings (JOS-458). OPTIONAL so every existing caller and every existing test
   *  compiles unchanged — and so a build with no attribution instrument folds a block that simply
   *  does not claim an owner, rather than one that claims there was none. */
  seams?: readonly PerfSeamSample[]
  gc?: readonly PerfGcSample[]
}

const zeroRow = (t: number): FeedbackPerfRow => ({
  t,
  mainMaxLateMs: 0,
  workerMaxLateMs: 0,
  tailMaxMs: 0,
  tailReads: 0,
  tailReopens: 0
})

/** Whole, finite, non-negative, bounded. Every number that reaches the wire goes through here. */
function whole(n: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : 0
}

/** Which of the `PERF_ROWS` buckets a wall-clock stamp falls in, or -1 when it is outside the
 *  window. Samples older than the window are dropped rather than piled into row 0, which would
 *  invent a spike at the left edge out of everything the ring had not yet trimmed. */
function bucketOf(at: number, windowStart: number): number {
  const i = Math.floor((at - windowStart) / PERF_INTERVAL_MS)
  return i < 0 || i >= PERF_ROWS ? -1 : i
}

/**
 * THE FOLD: two rings and a state reading → the block, or `null`.
 *
 * `null` WHEN THERE IS NOTHING TO SAY — no late tick on either thread and no tail read in the
 * whole window. That is the `feedback/slice.ts:238` spirit applied one artifact over: an empty
 * attachment is not an attachment, and sixty rows of zeros would be a claim that ten smooth
 * minutes were OBSERVED by a session that (before `replayDone`, or on a build with no probe)
 * observed nothing at all.
 *
 * Sixty rows are emitted whenever it answers at all, INCLUDING the quiet ones, and that is
 * deliberate: the grid is fixed, so the quiet stretches either side of a freeze are what give it
 * a shape, and every reader can index rows by time without carrying a cursor.
 */
export function foldFeedbackPerf(input: PerfFoldInput, now: number): FeedbackPerf | null {
  const windowStart = now - PERF_ROWS * PERF_INTERVAL_MS
  const main = input.main.filter((s) => bucketOf(s.at, windowStart) >= 0)
  const worker = input.worker.filter((s) => bucketOf(s.at, windowStart) >= 0)
  const tail = input.tail.filter((s) => bucketOf(s.at, windowStart) >= 0)
  if (main.length === 0 && worker.length === 0 && tail.length === 0) return null

  const rows = Array.from({ length: PERF_ROWS }, (_v, i) => zeroRow(i * (PERF_INTERVAL_MS / 1000)))
  for (const s of main) {
    const row = rows[bucketOf(s.at, windowStart)]
    row.mainMaxLateMs = Math.max(row.mainMaxLateMs, whole(s.lateMs, MAX_PERF_MS))
  }
  for (const s of worker) {
    const row = rows[bucketOf(s.at, windowStart)]
    row.workerMaxLateMs = Math.max(row.workerMaxLateMs, whole(s.lateMs, MAX_PERF_MS))
  }
  for (const s of tail) {
    const row = rows[bucketOf(s.at, windowStart)]
    row.tailMaxMs = Math.max(row.tailMaxMs, whole(s.readMs, MAX_PERF_MS))
    row.tailReads = whole(row.tailReads + 1, MAX_PERF_COUNT)
    if (s.reopened) row.tailReopens = whole(row.tailReopens + 1, MAX_PERF_COUNT)
  }

  const late = main.map((s) => whole(s.lateMs, MAX_PERF_MS))
  // THE OWNER, over the SAME window the rows were cut from — `windowStart` and the two spans are
  // passed rather than re-derived, so a seam's `t` addresses a row of THIS block and not of a
  // block computed a millisecond later.
  const owner = foldPerfOwner(
    { seams: input.seams ?? [], gc: input.gc ?? [] },
    { start: windowStart, spanMs: PERF_ROWS * PERF_INTERVAL_MS, rowMs: PERF_INTERVAL_MS }
  )
  return {
    intervalMs: PERF_INTERVAL_MS,
    rows,
    summary: {
      p95MainMs: round(percentile(late, 95), 0),
      maxMainMs: late.length === 0 ? 0 : Math.max(...late),
      coincident: coincidentWindows(main, worker),
      over500: late.filter((ms) => ms >= LIVE_STALL_FREEZE_MS).length
    },
    state: input.state,
    ...owner
  }
}

/** Serialized size, the number `MAX_PERF_BYTES` is about. One place, so the client's omission
 *  and the validator's refusal are measuring the same thing. */
export function perfBytes(perf: FeedbackPerf): number {
  return new TextEncoder().encode(JSON.stringify(perf)).length
}

// ---- one renderer, three readers -------------------------------------------------------------
//
// The dialog's preview, `triage-feedback.mts show` and the triage panel all print THESE strings.
// A second opinion about what a hitch looked like is how the owner and the reporter end up
// describing different reports.

/** The summary, as one line. Whole numbers with their units, no prose about what they mean. */
export function formatPerfSummary(perf: FeedbackPerf): string {
  const s = perf.summary
  const reads = perf.rows.reduce((n, r) => n + r.tailReads, 0)
  const reopens = perf.rows.reduce((n, r) => n + r.tailReopens, 0)
  const tailMax = perf.rows.reduce((m, r) => Math.max(m, r.tailMaxMs), 0)
  return [
    `late p95 ${s.p95MainMs}ms`,
    `max ${s.maxMainMs}ms`,
    `${s.over500} freeze${s.over500 === 1 ? '' : 's'} (>=${LIVE_STALL_FREEZE_MS}ms)`,
    `${s.coincident} coincident`,
    `tail ${reads} reads / ${reopens} reopens / max ${tailMax}ms`
  ].join(' · ')
}

/** The machine, as one line. */
export function formatPerfState(perf: FeedbackPerf): string {
  const st = perf.state
  return [
    `${st.cpuCount} cpu`,
    `${st.totalMemGb} GB (${st.freeMemMb} MB free)`,
    `${st.gpuVendor}/${st.gpuCompositing}`,
    `eq ${st.eqWindowMode}`,
    `overlays ${st.overlaysOpen} (${st.overlaysLocked} locked)`,
    `presence ${st.presenceOn ? 'on' : 'off'}`,
    `ring ${st.ringOn ? 'on' : 'off'}`,
    `us ${st.workingSetMb} MB`
  ].join(' · ')
}

/** ASCII on purpose: this string is printed into the owner's terminal, pasted into issues and
 *  rendered in a browser, and a box-drawing ramp is exactly the kind of thing one of those three
 *  renders as squares. Blank is "nothing was late in this bucket", which is most of a good run. */
const RAMP = '.:-=+*#@'

/**
 * Sixty characters, oldest first: the SHAPE of the hitch at a glance.
 *
 * The ramp is scaled to the window's own worst tick rather than to a fixed ladder, because the
 * question this line answers is "where in the last ten minutes did it happen", not "how bad is
 * this compared to other machines" — the summary line already carries the absolute numbers, and
 * a fixed ladder would flatten a whole session of 30 ms hitches into an empty row.
 */
export function perfSparkline(perf: FeedbackPerf): string {
  const peak = perf.rows.reduce((m, r) => Math.max(m, r.mainMaxLateMs), 0)
  if (peak <= 0) return ' '.repeat(perf.rows.length)
  return perf.rows
    .map((r) => {
      if (r.mainMaxLateMs < LIVE_PROBE_REPORT_MS) return ' '
      const i = Math.ceil((r.mainMaxLateMs / peak) * RAMP.length) - 1
      return RAMP[Math.min(RAMP.length - 1, Math.max(0, i))]
    })
    .join('')
}

/**
 * The block as the CLI prints it: four lines, no colour, no cleverness.
 *
 * THE OWNER LINE IS LAST BECAUSE IT IS THE CONCLUSION. The three above it establish that something
 * happened, how bad it was and on what machine; this one says on WHAT — and it is printed even
 * when a build carried no attribution at all, because a bug report whose owner line is missing
 * entirely and one whose owner line says nothing reached the threshold are different reports, and
 * the reader has to be able to tell them apart at a glance.
 */
export function formatPerfBlock(perf: FeedbackPerf): string {
  const minutes = Math.round((perf.rows.length * perf.intervalMs) / 60_000)
  return [
    `perf (last ${minutes} min, ${perf.intervalMs / 1000}s rows): ${formatPerfSummary(perf)}`,
    `  machine: ${formatPerfState(perf)}`,
    `  main late |${perfSparkline(perf)}| oldest→newest, peak ${perf.summary.maxMainMs}ms`,
    `  owner: ${formatPerfOwner(perf.seams ?? [], perf.gc ?? null)}`
  ].join('\n')
}

// ---- validation ------------------------------------------------------------------------------
//
// IT LIVES HERE, NOT IN `shared/feedback.ts`, AND THE PRIMITIVES BELOW ARE RESTATED ON PURPOSE.
// The contract file is at 366 of its 400 permitted code lines and this validator is fifty; more
// to the point, the shape being checked is declared in THIS file, and a validator that lives one
// import away from its own type is the arrangement that lets the two drift. The three helpers are
// four lines each and produce the contract's own `ValidationFailure` shape structurally, so
// `validateEnv` can return one of these straight through without a translation layer.
//
// The vocabularies are re-exported from `shared/telemetry.ts` rather than restated: these three
// enums are the setup snapshot's (JOS-364), and a feedback report that spelled `gpuVendor`
// differently from the fleet would make the two impossible to read together.

export { TELEMETRY_EQ_WINDOW_MODES, TELEMETRY_GPU_COMPOSITING, TELEMETRY_GPU_VENDORS }
export type { TelemetryEqWindowMode, TelemetryGpuCompositing, TelemetryGpuVendor }

/** Structurally `shared/feedback.ts`'s `Validated<T>`. See the note above for why it is spelled
 *  again rather than imported — importing it would make the contract file and this one a cycle. */
export type PerfValidated<T> =
  | { ok: true; value: T }
  | { ok: false; error: 'invalid_payload'; message: string; field: string }

const bad = (field: string, message: string): PerfValidated<never> => ({
  ok: false,
  error: 'invalid_payload',
  message,
  field
})

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A whole number in [0, max], or the field that is wrong. Fractions are REJECTED rather than
 *  rounded: this block promises whole numbers, and a client sending 12.7 is not our client. */
function count(raw: unknown, field: string, max: number): PerfValidated<number> {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw))
    return bad(field, `${field} must be a whole number.`)
  if (raw < 0 || raw > max) return bad(field, `${field} must be between 0 and ${max}.`)
  return { ok: true, value: raw }
}

function member<T extends string>(
  raw: unknown,
  field: string,
  allowed: readonly T[]
): PerfValidated<T> {
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw))
    return { ok: true, value: raw as T }
  return bad(field, `${field} must be one of: ${allowed.join(', ')}.`)
}

function flag(raw: unknown, field: string): PerfValidated<boolean> {
  return typeof raw === 'boolean'
    ? { ok: true, value: raw }
    : bad(field, `${field} must be true or false.`)
}

/** Read a group of whole numbers into a record, first failure wins and names its own field. */
function counts<K extends string>(
  raw: Record<string, unknown>,
  prefix: string,
  spec: readonly (readonly [K, number])[]
): PerfValidated<Record<K, number>> {
  const out = {} as Record<K, number>
  for (const [key, max] of spec) {
    const v = count(raw[key], `${prefix}.${key}`, max)
    if (!v.ok) return v
    out[key] = v.value
  }
  return { ok: true, value: out }
}

const ROW_FIELDS = [
  ['mainMaxLateMs', MAX_PERF_MS],
  ['workerMaxLateMs', MAX_PERF_MS],
  ['tailMaxMs', MAX_PERF_MS],
  ['tailReads', MAX_PERF_COUNT],
  ['tailReopens', MAX_PERF_COUNT]
] as const

/** The sixty rows, on the FIXED grid. `t` is checked against its index rather than merely
 *  bounded — the grid is what makes a row addressable by time, and a block whose offsets do not
 *  march by `intervalMs` is one no reader could align against anything. */
function validateRows(raw: unknown): PerfValidated<FeedbackPerfRow[]> {
  if (!Array.isArray(raw) || raw.length !== PERF_ROWS)
    return bad('env.perf.rows', `env.perf.rows must be ${PERF_ROWS} rows.`)
  const rows: FeedbackPerfRow[] = []
  for (let i = 0; i < raw.length; i++) {
    const at = `env.perf.rows[${i}]`
    const row: unknown = raw[i]
    if (!isRec(row)) return bad(at, `${at} must be an object.`)
    if (row.t !== i * (PERF_INTERVAL_MS / 1000))
      return bad(`${at}.t`, `${at}.t must be ${i * (PERF_INTERVAL_MS / 1000)}.`)
    const nums = counts(row, at, ROW_FIELDS)
    if (!nums.ok) return nums
    rows.push({ t: i * (PERF_INTERVAL_MS / 1000), ...nums.value })
  }
  return { ok: true, value: rows }
}

const SUMMARY_FIELDS = [
  ['p95MainMs', MAX_PERF_MS],
  ['maxMainMs', MAX_PERF_MS],
  ['coincident', MAX_PERF_COUNT],
  ['over500', MAX_PERF_COUNT]
] as const

const STATE_COUNTS = [
  ['overlaysOpen', MAX_PERF_COUNT],
  ['overlaysLocked', MAX_PERF_COUNT],
  ['freeMemMb', MAX_PERF_COUNT],
  ['workingSetMb', MAX_PERF_COUNT],
  ['cpuCount', MAX_PERF_COUNT],
  ['totalMemGb', MAX_PERF_COUNT]
] as const

function validateState(raw: unknown): PerfValidated<FeedbackPerfState> {
  if (!isRec(raw)) return bad('env.perf.state', 'env.perf.state must be an object.')
  const nums = counts(raw, 'env.perf.state', STATE_COUNTS)
  if (!nums.ok) return nums
  const presenceOn = flag(raw.presenceOn, 'env.perf.state.presenceOn')
  if (!presenceOn.ok) return presenceOn
  const ringOn = flag(raw.ringOn, 'env.perf.state.ringOn')
  if (!ringOn.ok) return ringOn
  const gpuVendor = member(raw.gpuVendor, 'env.perf.state.gpuVendor', TELEMETRY_GPU_VENDORS)
  if (!gpuVendor.ok) return gpuVendor
  const gpuCompositing = member(
    raw.gpuCompositing,
    'env.perf.state.gpuCompositing',
    TELEMETRY_GPU_COMPOSITING
  )
  if (!gpuCompositing.ok) return gpuCompositing
  const eqWindowMode = member(
    raw.eqWindowMode,
    'env.perf.state.eqWindowMode',
    TELEMETRY_EQ_WINDOW_MODES
  )
  if (!eqWindowMode.ok) return eqWindowMode
  return {
    ok: true,
    value: {
      ...nums.value,
      presenceOn: presenceOn.value,
      ringOn: ringOn.value,
      gpuVendor: gpuVendor.value,
      gpuCompositing: gpuCompositing.value,
      eqWindowMode: eqWindowMode.value
    }
  }
}

/**
 * The perf block on an incoming report. ABSENT AND NULL ARE THE SAME ANSWER — "this client sent
 * no timeline" — which is what makes the field additive: every already-installed client omits it
 * and is not rejected for doing so, exactly as `optionalMeta` says for the two attachments.
 *
 * A block that is PRESENT and malformed is a named 400, never a silently dropped field: the value
 * is reconstructed here field by field, so anything the shape does not name cannot ride along.
 * The size guard is last because it is the only check that has to serialize what it measures.
 */
export function validatePerf(raw: unknown): PerfValidated<FeedbackPerf | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (!isRec(raw)) return bad('env.perf', 'env.perf must be an object or null.')
  if (raw.intervalMs !== PERF_INTERVAL_MS)
    return bad('env.perf.intervalMs', `env.perf.intervalMs must be ${PERF_INTERVAL_MS}.`)
  const rows = validateRows(raw.rows)
  if (!rows.ok) return rows
  if (!isRec(raw.summary)) return bad('env.perf.summary', 'env.perf.summary must be an object.')
  const summary = counts(raw.summary, 'env.perf.summary', SUMMARY_FIELDS)
  if (!summary.ok) return summary
  const state = validateState(raw.state)
  if (!state.ok) return state
  // The two JOS-458 groups, each INDEPENDENTLY optional inside an already-optional block — the
  // additive-field rule applied one level down, exactly as `startupDiscriminators` applies it
  // inside the startup reading.
  const owner = validatePerfOwner(raw)
  if (!owner.ok) return owner

  const value: FeedbackPerf = {
    intervalMs: PERF_INTERVAL_MS,
    rows: rows.value,
    summary: summary.value,
    state: state.value,
    ...owner.value
  }
  const bytes = perfBytes(value)
  if (bytes > MAX_PERF_BYTES)
    return bad('env.perf', `env.perf must be ${MAX_PERF_BYTES} bytes or fewer (it is ${bytes}).`)
  return { ok: true, value }
}
