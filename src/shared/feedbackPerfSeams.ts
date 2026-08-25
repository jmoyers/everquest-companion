// ============================================================================
// feedbackPerfSeams.ts — THE OWNER OF THE HITCH, on the bug report (JOS-458).
// ============================================================================
//
// `./feedbackPerf.ts` folds the last ten minutes into sixty rows so a reporter's freeze has a
// SHAPE. Two reports have now arrived carrying exactly that shape — a spike, `coincident: 0`, tail
// legs at 0 ms — and the shape was not enough: it said we stalled and did not say on what.
//
// This file is the answer's other half, and it is a SEPARATE FILE for the reason every split in
// this set has been made: `./feedbackPerf.ts` is at 303 of its 400 permitted code lines, and a
// type, a fold, a renderer and a validator do not fit. The cut is by SUBJECT — everything here is
// about WHO owned a moment rather than how bad it was — and, exactly as that file argues about its
// own validator, the shape being checked is declared HERE, one import from the thing that checks
// it, so the two cannot drift.
//
// ============================ RAW MILLISECONDS, SAME ARGUMENT ============================
// Un-bucketed, for `./feedbackPerf.ts`'s stated reason and no other: CONSENT AND AUDIENCE. The
// heartbeat leaves a machine on its own and describes a FLEET, so it ships bucket indices; a
// feedback report is user-initiated, shown in full before it is sent, and describes ONE MOMENT the
// user is complaining about — and "the world-rebuild fan-out took somewhere between half a second
// and a second" is not an answer anybody can act on.
//
// WHAT IS AND IS NOT IN IT. Whole numbers, and members of two closed enums compiled into the app
// (`PERF_SEAMS`, `GC_KINDS`). There is no field here a character, a zone, a spell, a path or a
// line of a log could reach — the seam is named at the bracket from a fixed list, and the fold
// only ever copies members of that list.
//
// PURE. It is imported by `./feedbackPerf.ts`, which `./feedback.ts` imports, which the ingest
// Lambda bundles — so it may never reach Electron, the DOM or `node:`.

import { GC_KINDS, PERF_SEAMS, SEAM_LATE_MS, SEAM_STALL_MS, type GcKind, type PerfSeamName } from './perfSeams'

/** Ceilings, restated from `./feedbackPerf.ts` by VALUE rather than imported — that file imports
 *  this one, and an import back would be a cycle inside the Lambda bundle. Pinned equal in the
 *  tests, which is how the repo keeps every other pair of restated constants honest. */
export const MAX_SEAM_MS = 3_600_000
export const MAX_SEAM_COUNT = 1_000_000

/**
 * The ceiling on a `t` offset, in SECONDS — the block's own window, and deliberately not
 * `MAX_SEAM_COUNT`.
 *
 * A `t` is not a count, it is an ADDRESS: the whole use of the field is that it names a row of
 * this same block, and `t: 999999` names no row that exists. Bounding it by the window makes the
 * validator refuse a value that could never be a row rather than storing an unusable one — the
 * same argument `optionalState` makes about `overlaysOpen` being capped by the number of overlay
 * kinds instead of by `MAX_COUNT`.
 *
 * Restated by value (600 = `PERF_ROWS * PERF_INTERVAL_MS / 1000`) and pinned equal in the tests,
 * because importing it would be a cycle inside the Lambda bundle.
 */
export const MAX_SEAM_T_S = 600

/**
 * ONE SEAM'S ACCOUNT of the window.
 *
 * `lateCalls` IS NOT `calls`, and the name is the whole caveat — the same one `p95MainMs` carries
 * one file over. The ring behind this fold only keeps calls at or over `SEAM_LATE_MS`, because
 * keeping every call would make the instrument part of the load it measures. So this counts what
 * was SLOW, never what ran; a seam entered ten thousand times and never slow appears here not at
 * all, which is the correct answer to "who owned the hitch".
 */
export interface FeedbackPerfSeam {
  /** A member of `PERF_SEAMS`. Never a string this machine produced. */
  seam: PerfSeamName
  lateCalls: number
  maxMs: number
  /**
   * Offset in SECONDS from the start of the window when the worst call ENDED — the same `t` the
   * rows use, and deliberately so: it ADDRESSES A ROW. A reader who sees a 900 ms spike at
   * `t: 540` can look here and find which seam was running at `t: 540`, which is the entire
   * mechanism by which this block stops being a shape and becomes a diagnosis.
   */
  t: number
}

/** WHAT V8 SPENT over the same window. One object rather than a per-kind list: the question is
 *  "was a collection what stopped us", and the major count plus the worst pause answer it. */
export interface FeedbackPerfGc {
  pauses: number
  majorPauses: number
  maxMs: number
  totalMs: number
  /** The worst pause's row offset, on the rows' own grid — `FeedbackPerfSeam.t`'s reason. */
  t: number
  /** Which kind the worst pause was, so a reader is not left to infer it from the count. */
  worstKind: GcKind
}

/** One late seam call off the ring, as much of it as this fold needs. */
export interface PerfSeamSample {
  at: number
  seam: PerfSeamName
  ms: number
}

/** One GC pause off the ring. */
export interface PerfGcSample {
  at: number
  ms: number
  kind: GcKind
}

/**
 * THE WINDOW THE ROWS WERE CUT FROM, as one value.
 *
 * The three numbers travel together everywhere below, and passing them together rather than as
 * three positional arguments is what keeps these folds inside the repo's four-parameter ceiling —
 * but the reason it is the right shape anyway is that they are only meaningful as a set: a
 * `start` from one block and a `rowMs` from another would produce a `t` that addresses a row of
 * neither. The caller (`foldFeedbackPerf`) builds it once from its own grid.
 */
export interface PerfWindow {
  start: number
  spanMs: number
  rowMs: number
}

/** Whole, finite, non-negative, bounded — `./feedbackPerf.ts`'s `whole`, restated for the same
 *  no-cycle reason the two ceilings above are. */
function whole(n: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : 0
}

/**
 * THE SEAM FOLD: a ring and a window → at most one entry per seam, WORST FIRST.
 *
 * Sorted by `maxMs` descending so `[0]` IS the culprit and every reader — the dialog, the CLI, the
 * triage panel — names the same one without each deciding for itself. Ties break in `PERF_SEAMS`
 * order, so two reads of one report agree.
 *
 * `[]` when nothing was late, and an empty array is dropped by the caller rather than sent: a
 * block claiming six seams of zero would say the app was measured and found fast, when what
 * happened is that no seam was slow enough to be recorded at all.
 */
export function foldPerfSeams(
  samples: readonly PerfSeamSample[],
  win: PerfWindow
): FeedbackPerfSeam[] {
  const byName = new Map<PerfSeamName, FeedbackPerfSeam>()
  for (const s of samples) {
    const t = rowOf(s.at, win)
    if (t === null) continue
    if (!PERF_SEAMS.includes(s.seam)) continue
    const ms = whole(s.ms, MAX_SEAM_MS)
    const prior = byName.get(s.seam)
    if (prior === undefined) {
      byName.set(s.seam, { seam: s.seam, lateCalls: 1, maxMs: ms, t })
      continue
    }
    prior.lateCalls = whole(prior.lateCalls + 1, MAX_SEAM_COUNT)
    if (ms > prior.maxMs) {
      prior.maxMs = ms
      prior.t = t
    }
  }
  return PERF_SEAMS.map((seam) => byName.get(seam))
    .filter((e): e is FeedbackPerfSeam => e !== undefined)
    .sort((a, b) => b.maxMs - a.maxMs)
}

/** A wall clock → the row it belongs to, in seconds, or `null` when it is outside the window.
 *  The rows' own grid, so the two halves of the block are addressable by the same number — and
 *  samples older than the window are DROPPED rather than piled onto row 0, which would invent a
 *  spike at the left edge out of everything the ring had not yet trimmed. */
function rowOf(at: number, win: PerfWindow): number | null {
  const offset = at - win.start
  if (offset < 0 || offset >= win.spanMs) return null
  return Math.floor(offset / win.rowMs) * (win.rowMs / 1000)
}

/**
 * THE GC FOLD: the ring's pauses inside the window → one object, or `null` when there were none.
 *
 * `null` rather than zeros, and this is the ONE place the local block and the wire rider disagree
 * on purpose. The heartbeat's `gc` reports zeros from a running observer because a fleet needs the
 * denominator; a bug report is about a moment, and "no collection was slow enough to record" is
 * said by leaving the field out, exactly as an empty timeline is said by leaving the whole block
 * out (`foldFeedbackPerf` returns `null`).
 */
export function foldPerfGc(samples: readonly PerfGcSample[], win: PerfWindow): FeedbackPerfGc | null {
  let out: FeedbackPerfGc | null = null
  for (const s of samples) {
    const t = rowOf(s.at, win)
    if (t === null) continue
    const kind: GcKind = GC_KINDS.includes(s.kind) ? s.kind : 'other'
    const ms = whole(s.ms, MAX_SEAM_MS)
    out ??= { pauses: 0, majorPauses: 0, maxMs: 0, totalMs: 0, t, worstKind: kind }
    out.pauses = whole(out.pauses + 1, MAX_SEAM_COUNT)
    if (kind === 'major') out.majorPauses = whole(out.majorPauses + 1, MAX_SEAM_COUNT)
    out.totalMs = whole(out.totalMs + ms, MAX_SEAM_MS)
    if (ms > out.maxMs) {
      out.maxMs = ms
      out.t = t
      out.worstKind = kind
    }
  }
  return out
}

/**
 * BOTH GROUPS AS SPREADABLE FIELDS — the shape `foldFeedbackPerf` and `validatePerf` both want.
 *
 * It exists because each of those two functions sits at the repo's complexity ceiling of 12 and
 * two `...(x === undefined ? {} : { x })` spreads apiece is what took them to 13 and 15. The cut
 * is not cosmetic: gathering them here means the OMISSION RULE — an empty seam list is left out,
 * an absent GC reading is left out — is written once, on the same side of the seam as the folds
 * that decide it, rather than twice in two files that could disagree about what "nothing to say"
 * looks like.
 */
export interface PerfOwnerFields {
  seams?: FeedbackPerfSeam[]
  gc?: FeedbackPerfGc
}

export function foldPerfOwner(
  rings: { seams: readonly PerfSeamSample[]; gc: readonly PerfGcSample[] },
  win: PerfWindow
): PerfOwnerFields {
  const folded = foldPerfSeams(rings.seams, win)
  const pauses = foldPerfGc(rings.gc, win)
  return {
    // An empty list is OMITTED rather than sent: sixty rows of zeros are a shape, but six seams of
    // zero would be a claim that the app was measured and found fast.
    ...(folded.length === 0 ? {} : { seams: folded }),
    ...(pauses === null ? {} : { gc: pauses })
  }
}

/** …and the same two fields off an incoming report. Each is independently optional inside an
 *  already-optional block — the additive-field rule applied one level down. */
export function validatePerfOwner(raw: Record<string, unknown>): Validated<PerfOwnerFields> {
  const seams = validatePerfSeams(raw.seams)
  if (!seams.ok) return seams
  const gc = validatePerfGc(raw.gc)
  if (!gc.ok) return gc
  return {
    ok: true,
    value: {
      ...(seams.value === undefined || seams.value.length === 0 ? {} : { seams: seams.value }),
      ...(gc.value === undefined ? {} : { gc: gc.value })
    }
  }
}

// ---- one renderer, three readers ---------------------------------------------------------------

/**
 * THE LINE THE WHOLE TICKET IS FOR: "who owned it", in the words a person can act on.
 *
 * Absent both readings it says so rather than printing an empty line, and the wording is chosen to
 * be a FINDING rather than a shrug: a window with main-thread lateness in it and no seam named is
 * a real result — it eliminates all six instrumented places at once — and the reader has to be
 * able to tell that from "we did not look".
 */
export function formatPerfOwner(seams: readonly FeedbackPerfSeam[], gc: FeedbackPerfGc | null): string {
  const parts = seams.map(
    (s) => `${s.seam} ${s.maxMs}ms @t=${s.t}s (${s.lateCalls} over ${SEAM_LATE_MS}ms)`
  )
  if (gc !== null) {
    parts.push(
      `gc ${gc.pauses} pause${gc.pauses === 1 ? '' : 's'} (${gc.majorPauses} major) max ${gc.maxMs}ms ${gc.worstKind} @t=${gc.t}s`
    )
  }
  return parts.length === 0
    ? `no instrumented seam and no gc pause reached ${SEAM_LATE_MS}ms in this window`
    : parts.join(' · ')
}

/** Did anything here reach the STALL threshold — i.e. is there a culprit worth naming at all, as
 *  opposed to six seams that were merely measurable? The renderers use it to decide whether the
 *  owner line leads or follows. */
export function ownerIsStall(seams: readonly FeedbackPerfSeam[], gc: FeedbackPerfGc | null): boolean {
  return seams.some((s) => s.maxMs >= SEAM_STALL_MS) || (gc !== null && gc.maxMs >= SEAM_STALL_MS)
}

// ---- validation --------------------------------------------------------------------------------
//
// Beside the types, for `./feedbackPerf.ts`'s stated reason: a validator that lives one import away
// from its own type is the arrangement that lets the two drift. It produces that file's
// `PerfValidated` shape STRUCTURALLY, so `validatePerf` returns one of these straight through.

type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; error: 'invalid_payload'; message: string; field: string }

const bad = (field: string, message: string): Validated<never> => ({
  ok: false,
  error: 'invalid_payload',
  message,
  field
})

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A whole number in [0, max]. Fractions are REJECTED rather than rounded — this block promises
 *  whole numbers, and a client sending 12.7 is not our client. */
function count(raw: unknown, field: string, max: number): Validated<number> {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw))
    return bad(field, `${field} must be a whole number.`)
  if (raw < 0 || raw > max) return bad(field, `${field} must be between 0 and ${max}.`)
  return { ok: true, value: raw }
}

/**
 * The seam list on an incoming report. ABSENT AND NULL ARE THE SAME ANSWER — "this client sent no
 * attribution" — which is what makes the field additive: every already-installed client omits it.
 *
 * THE SEAM NAME IS CHECKED AGAINST THE ENUM, not merely typed as a string, and that is the whole
 * security property of this field. This validator runs inside the ingest Lambda over bytes a
 * client chose; an unchecked `seam` would be a free-text channel into a stored report. At most one
 * entry per seam, so a forged list cannot repeat `worldRebuilt` six hundred times to bloat the
 * block past a reader's patience.
 */
export function validatePerfSeams(raw: unknown): Validated<FeedbackPerfSeam[] | undefined> {
  if (raw === null || raw === undefined) return { ok: true, value: undefined }
  if (!Array.isArray(raw) || raw.length > PERF_SEAMS.length)
    return bad('env.perf.seams', `env.perf.seams must be at most ${PERF_SEAMS.length} entries.`)
  const out: FeedbackPerfSeam[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const one = seamEntry(raw[i], `env.perf.seams[${i}]`)
    if (!one.ok) return one
    if (seen.has(one.value.seam))
      return bad(`env.perf.seams[${i}].seam`, `env.perf.seams names ${one.value.seam} twice.`)
    seen.add(one.value.seam)
    out.push(one.value)
  }
  return { ok: true, value: out }
}

function seamEntry(raw: unknown, at: string): Validated<FeedbackPerfSeam> {
  if (!isRec(raw)) return bad(at, `${at} must be an object.`)
  const seam = PERF_SEAMS.find((s) => s === raw.seam)
  if (seam === undefined)
    return bad(`${at}.seam`, `${at}.seam must be one of: ${PERF_SEAMS.join(', ')}.`)
  const lateCalls = count(raw.lateCalls, `${at}.lateCalls`, MAX_SEAM_COUNT)
  if (!lateCalls.ok) return lateCalls
  const maxMs = count(raw.maxMs, `${at}.maxMs`, MAX_SEAM_MS)
  if (!maxMs.ok) return maxMs
  const t = count(raw.t, `${at}.t`, MAX_SEAM_T_S)
  if (!t.ok) return t
  return { ok: true, value: { seam, lateCalls: lateCalls.value, maxMs: maxMs.value, t: t.value } }
}

/** The GC object on an incoming report. All six or none — a pause count with no worst pause beside
 *  it cannot say whether V8 collected often or collected badly, which is the whole hypothesis. */
export function validatePerfGc(raw: unknown): Validated<FeedbackPerfGc | undefined> {
  if (raw === null || raw === undefined) return { ok: true, value: undefined }
  if (!isRec(raw)) return bad('env.perf.gc', 'env.perf.gc must be an object or null.')
  const kind = GC_KINDS.find((k) => k === raw.worstKind)
  if (kind === undefined)
    return bad('env.perf.gc.worstKind', `env.perf.gc.worstKind must be one of: ${GC_KINDS.join(', ')}.`)
  const spec = [
    ['pauses', MAX_SEAM_COUNT],
    ['majorPauses', MAX_SEAM_COUNT],
    ['maxMs', MAX_SEAM_MS],
    ['totalMs', MAX_SEAM_MS],
    ['t', MAX_SEAM_T_S]
  ] as const
  const nums = {} as Record<(typeof spec)[number][0], number>
  for (const [key, max] of spec) {
    const v = count(raw[key], `env.perf.gc.${key}`, max)
    if (!v.ok) return v
    nums[key] = v.value
  }
  return { ok: true, value: { ...nums, worstKind: kind } }
}
