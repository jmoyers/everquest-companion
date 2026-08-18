// ============================================================================
// usageRows.ts — DSQL counter rows -> typed values, plus the arithmetic over them.
// ============================================================================
//
// The same split, for the same reason, as `rows.ts` beside it: everything here is PURE (no
// `pg`, no `@aws-sdk/*`, no Electron), so `tests/usageAnalytics.test.mts` drives the whole
// read-time model with authored rows and no credentials.
//
// The interesting decisions live in `./analytics.ts`; this file is the boring half — parse a
// column, key a Map, walk a date. It is separate because the two together are past the repo's
// 400-code-line ceiling and a split is the answer to that, not a widened threshold.

import { cohortForChannel, cohortOf, DIM_NONE, type UsageCohort } from '../../shared/telemetryRollup'
import type { UsageDayPoint } from '../../shared/triage'

/** A DSQL row as node-postgres hands it over: every column is `unknown` until proven. */
export type Row = Record<string, unknown>

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
/**
 * `bigint` comes back as a number (store.ts sets the int8 parser on OID 20); anything else is 0.
 *
 * A NUMERIC STRING IS ALSO A NUMBER HERE, and that is a fix, not a loosening (JOS-394). MEASURED
 * against a real DSQL cluster: an uncast `SUM(bigint)` in a view is NUMERIC — OID 1700, which no
 * type parser is set for — so node-postgres hands the counter over as `'12'`. The old predicate
 * turned that into 0 SILENTLY, and a readout full of honest-looking zeros is the worst answer a
 * panel can give. `usage_daily_all` casts its sum back to bigint precisely so this cannot happen
 * (infra/schema.sql says so at the view), and this is the second line of defence for the next
 * aggregate somebody adds without reading that note.
 */
const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v !== 'string' || v.trim().length === 0) return 0
  const parsed = Number(v)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Every row carries its cohort ('user' or 'owner'), normalized through `cohortOf` so a NULL
 * column on a partly-migrated cluster reads as 'user' rather than blowing up a panel. The rows
 * are then PARTITIONED (`ofCohort`) and each side is built into its own readout — the two are
 * never merged, and `src/shared/telemetryRollup.ts` says why at length.
 */
export interface UsageRow {
  day: string
  cohort: UsageCohort
  metric: string
  dim: string
  n: number
}

export interface FunnelRow {
  day: string
  cohort: UsageCohort
  funnel: string
  step: string
  outcome: string
  appVersion: string
  n: number
}

/**
 * One `analytics_install` row — WITHOUT the id, which the readout never selects (store.ts says
 * why). What is left is population shape: when this install first appeared, when it was last
 * seen, how many distinct days it has been seen on, what it is running now, and which side of
 * the user/owner split it is on.
 */
export interface InstallRow {
  firstSeenDay: string
  lastSeenDay: string
  daysSeen: number
  appVersion: string
  channel: string
  cohort: UsageCohort
}

/**
 * ONE BUILD'S FEEDBACK BUG REPORTS (JOS-96) — the release-health section's fourth source, and the
 * only row shape here that comes from the `report` table rather than a counter table.
 *
 * It lives beside the other three, and carries a `cohort` like them, so `ofCohort` partitions it
 * with no special case. It is defined HERE rather than next to its only consumer because
 * `releaseHealth.ts` imports this module — putting the type there would make the two circular.
 */
export interface BugReportRow {
  appVersion: string
  cohort: UsageCohort
  n: number
}

export function toUsageRows(rows: readonly Row[]): UsageRow[] {
  return rows.map((r) => ({
    day: str(r.day),
    cohort: cohortOf(r.cohort),
    metric: str(r.metric),
    dim: str(r.dim, DIM_NONE),
    n: num(r.n)
  }))
}

export function toFunnelRows(rows: readonly Row[]): FunnelRow[] {
  return rows.map((r) => ({
    day: str(r.day),
    cohort: cohortOf(r.cohort),
    funnel: str(r.funnel),
    step: str(r.step),
    outcome: str(r.outcome, DIM_NONE),
    appVersion: str(r.app_version, '?'),
    n: num(r.n)
  }))
}

/**
 * `report` rows grouped per build (JOS-96), for the release-health overlay.
 *
 * BUGS ONLY, and the filter is here rather than in the SQL so the discarded kinds are visible in
 * the code that decides: a feature request filed from 0.9.0 is not evidence 0.9.0 is buggy, and
 * plotting one beside a crash count would be the panel telling a small lie in a chart.
 *
 * The cohort is derived from the CHANNEL, exactly as the ingest path derives a counter row's
 * (`cohortForChannel`) — a dev-channel report is the author's own. That keeps the user/owner
 * split intact across a source that has no cohort column of its own; `ofCohort` then partitions
 * these rows beside the counters without anything special-casing them.
 *
 * TOTAL, like every other mapper here: a missing or wrong-typed column becomes a default. A row
 * with no `app_version` reads as '?', which groups the unknown builds together rather than
 * silently attaching their reports to a real release.
 */
export function toBugReportRows(rows: readonly Row[]): BugReportRow[] {
  return rows
    .filter((r) => str(r.report_type, 'bug') === 'bug')
    .map((r) => ({
      appVersion: str(r.app_version, '?'),
      cohort: cohortForChannel(str(r.channel, 'prod')),
      n: num(r.n)
    }))
}

/**
 * ONE STORED ERROR ISSUE (JOS-100), as `error_report` holds it.
 *
 * The only row shape on this page carrying something that is not a number, and the exemplar is
 * kept as an OPAQUE STRING here rather than parsed: this module's contract is "a database row
 * becomes a typed row, totally, with defaults" — no mapper here can throw — and `JSON.parse` on
 * a text column is the one thing that could. `releaseHealth.ts` parses it inside a guard, where
 * a failure has an obvious answer (list the issue with a count and no example).
 */
export interface ErrorIssueRow {
  day: string
  cohort: UsageCohort
  version: string
  fingerprint: string
  n: number
  /** The raw `exemplar` column. Empty string when the row has none. */
  exemplar: string
}

export function toErrorIssueRows(rows: readonly Row[]): ErrorIssueRow[] {
  return rows.map((r) => ({
    day: str(r.day),
    cohort: cohortOf(r.cohort),
    version: str(r.version, '?'),
    fingerprint: str(r.fingerprint),
    n: num(r.count),
    exemplar: str(r.exemplar, '')
  }))
}

/**
 * ONE `perf_daily` ROW (JOS-372) — the only row shape here that carries more than one dimension,
 * which is the entire reason that table exists.
 *
 * `stallBucket` is parsed to a NUMBER because the readout compares it against a rung of
 * `LIVE_STALL_MS_EDGES` ("was this report's worst tick at least half a second"), and -1 is what an
 * unparseable value becomes: such a row still counts in its slice's denominator (it was a real
 * report) and can never count as a stall, which is the fail-safe direction. `tailBucket` stays a
 * string — it is a dim like the other three, and '-' (the session tailed nothing) is one of its
 * legal values.
 */
export interface PerfRow {
  day: string
  cohort: UsageCohort
  windowMode: string
  machineClass: string
  locked: string
  stallBucket: number
  tailBucket: string
  n: number
}

/** A bucket index column, or -1 for anything that is not one. */
const idx = (v: unknown): number => {
  const i = Number(str(v, ''))
  return Number.isInteger(i) && i >= 0 ? i : -1
}

export function toPerfRows(rows: readonly Row[]): PerfRow[] {
  return rows.map((r) => ({
    day: str(r.day),
    cohort: cohortOf(r.cohort),
    windowMode: str(r.window_mode, 'unknown'),
    machineClass: str(r.machine_class, 'unknown'),
    locked: str(r.locked, DIM_NONE),
    stallBucket: idx(r.stall_bucket),
    tailBucket: str(r.tail_bucket, DIM_NONE),
    n: num(r.n)
  }))
}

export function toInstallRows(rows: readonly Row[]): InstallRow[] {
  return rows.map((r) => ({
    firstSeenDay: str(r.first_seen_day),
    lastSeenDay: str(r.last_seen_day),
    daysSeen: num(r.days_seen),
    appVersion: str(r.app_version, '?'),
    channel: str(r.channel, '?'),
    cohort: cohortOf(r.cohort)
  }))
}

// ---- the cohort split ----------------------------------------------------------------
//
// TWO FILTERS, NOT ONE SUM. Both helpers are deliberately trivial and deliberately here rather
// than inlined at three call sites: the CLI, the IPC backend and the tests must all mean the
// same thing by "the user cohort", and a `.filter` copy-pasted three times is how they would
// eventually stop meaning it.

/** One cohort's rows. The other cohort is not summed in — it is rendered beside, or not shown. */
export function ofCohort<T extends { cohort: UsageCohort }>(
  rows: readonly T[],
  cohort: UsageCohort
): T[] {
  return rows.filter((r) => r.cohort === cohort)
}

/** Is there anything on the owner side at all? Drives whether the tab offers its toggle. */
export function anyOwner(rows: readonly { cohort: UsageCohort }[]): boolean {
  return rows.some((r) => r.cohort === 'owner')
}

// ---- days ---------------------------------------------------------------------------
//
// Day keys are UTC `yyyy-mm-dd` strings, which is what the counters are stored on. They sort
// and compare LEXICALLY, which is why every comparison below is `<=` on a string rather than
// arithmetic on a Date — the format makes the cheap thing also the correct thing.

const MS_PER_DAY = 86_400_000

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** `2026-08-04` + 3 → `2026-08-07`. Total: an unparseable key comes back unchanged. */
export function addDays(day: string, delta: number): string {
  const at = Date.parse(`${day}T00:00:00Z`)
  return Number.isFinite(at) ? dayOf(at + delta * MS_PER_DAY) : day
}

/** Whole days between two keys, or null when either is unparseable. */
export function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / MS_PER_DAY)
}

/** The window's day keys, ascending and DENSE — a day with no rows is a zero, not a gap. */
export function windowDays(nowMs: number, days: number): string[] {
  const today = dayOf(nowMs)
  const span = Math.max(1, Math.floor(days))
  return Array.from({ length: span }, (_, i) => addDays(today, i - (span - 1)))
}

// ---- aggregation --------------------------------------------------------------------

/** Every row for one metric, summed. */
export function sumOf(rows: readonly UsageRow[], metric: string): number {
  return rows.reduce((total, r) => (r.metric === metric ? total + r.n : total), 0)
}

/** One metric's dimensions, summed over the window: `dim -> n`. Insertion order is irrelevant;
 *  every caller sorts. */
export function dimsOf(rows: readonly UsageRow[], metric: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    if (r.metric !== metric) continue
    out.set(r.dim, (out.get(r.dim) ?? 0) + r.n)
  }
  return out
}

/** One metric's daily totals, aligned to `days` so a sparkline's x-axis is the window. */
export function seriesOf(
  rows: readonly UsageRow[],
  metric: string,
  days: readonly string[]
): UsageDayPoint[] {
  const byDay = new Map<string, number>()
  for (const r of rows) {
    if (r.metric !== metric) continue
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.n)
  }
  return days.map((day) => ({ day, n: byDay.get(day) ?? 0 }))
}

/** `dim -> n` as a sorted, typed list. Ties break on the dim so the order is deterministic. */
export function mixRows(counts: Map<string, number>): { id: string; n: number }[] {
  return [...counts.entries()]
    .map(([id, n]) => ({ id, n }))
    .sort((a, b) => b.n - a.n || a.id.localeCompare(b.id))
}

/** A histogram Map keyed by bucket INDEX (as text) → a dense array, index 0..max. */
export function bucketCounts(counts: Map<string, number>): number[] {
  const indices = [...counts.keys()]
    .map((k) => Number(k))
    .filter((i) => Number.isInteger(i) && i >= 0)
  if (indices.length === 0) return []
  const out = new Array<number>(Math.max(...indices) + 1).fill(0)
  for (const [key, n] of counts) {
    const i = Number(key)
    if (Number.isInteger(i) && i >= 0) out[i] += n
  }
  return out
}

/** x / y, or null when y is zero — a rate with no denominator is not zero, it is unknown. */
export function ratio(x: number, y: number): number | null {
  return y > 0 ? x / y : null
}
