// usageStore — the usage-analytics half of the triage store (docs/plans/usage-analytics.md §4).
//
// Split from store.ts when two independent waves (the A2/A3 readout and the smoke test's
// per-id reader) composed that file past the 400-line ceiling — the merge crossed the cap
// even though each wave alone stayed under it, which is exactly the failure mode a per-file
// cap is supposed to surface. Same laws as store.ts: every read is a single bounded
// statement; consumers import these names FROM store.ts (it re-exports this whole module),
// so the split moved code, not import paths.
//
// THREE READS, and each is a single indexed statement with a bound:
//   * `usage_daily_all` and `usage_funnel_daily` are `day >= :floor` over the PRIMARY KEY's
//     leading column, so the window bounds the scan. (`usage_daily_all` is a VIEW since
//     JOS-394 — the frozen pre-shard table UNION ALL the 32-way sharded one, summed back to
//     the old key — and `day` leads the primary key of both legs, so the bound survives the
//     union. Same for `perf_daily_all`. infra/schema.sql carries the why.)
//   * `analytics_install` is the whole table, because that is the question — WAU/MAU,
//     retention cohorts and version spread are all "count rows by a date", and there is no
//     window that makes them cheaper. It is bounded by a LIMIT anyway: this panel must not
//     promise to render an install base it has not measured.
//
// THE TABLES MAY NOT EXIST. A stack applied before the A2 migration answers `42P01
// undefined_table`, which is a genuinely different fact from "the tables are empty" and the
// panel renders it differently (available:false vs honest zeros). `missingTable` is how the
// caller tells them apart without matching on message text.
//
// NEITHER MAY THE `cohort` COLUMN. A stack migrated from a schema.sql that predates the
// user/owner split answers `42703 undefined_column` instead, which is the SAME class of fact —
// "this cluster has not been migrated to what this code reads" — and gets the same treatment
// rather than a stack trace in a panel. `missingColumn` is its `missingTable`.
//
// EVERY COHORT IS READ, ALWAYS, AND THE SPLIT HAPPENS IN JS. There is no `WHERE cohort = …`
// here on purpose: the default readout is the user cohort, but the caller ALSO has to know
// whether any owner rows exist at all (that is what makes the tab's toggle honest instead of a
// mystery switch), and `--cohort all` needs both anyway. One statement answers all three
// questions; a cohort predicate would have made it two or three.

import type { UsageCohort } from '../../shared/telemetryRollup'
import { sqlState, UNDEFINED_TABLE, type Clients, type Row } from './store'

/** The table named by a `42P01 undefined_table`, or null for any other failure. */
export function missingTable(err: unknown): string | null {
  if (sqlState(err) !== UNDEFINED_TABLE) return null
  const raw = err instanceof Error ? err.message : String(err)
  // postgres: `relation "usage_daily" does not exist`.
  return /relation "([^"]+)"/.exec(raw)?.[1] ?? 'usage_daily'
}

/** postgres `42703`: the relation is there, the column is not. */
const UNDEFINED_COLUMN = '42703'

/**
 * NEITHER MAY THE CONNECTION SURVIVE. The third classifier, and it lives beside the other two
 * because they answer the same question for the caller — "is this a fact about the CLUSTER, or a
 * bug?" — and a reader should find all three in one place. This one is not analytics-specific:
 * a dropped socket ends any read, feedback or usage.
 *
 * IT IS MESSAGE-SHAPED, NOT SQLSTATE-SHAPED, because a connection failure never reaches a
 * SQLSTATE: node-postgres fails every in-flight query with a plain `Error: Connection terminated
 * unexpectedly` when the socket ends, and the OS-level failures arrive as node system errors
 * whose `code` is `ECONNRESET`/`ETIMEDOUT`/… rather than five characters of postgres. Both are
 * matched; a real SQLSTATE (`42703`, `40001`) matches neither and is left to its own path.
 */
const CONNECTION_LOST =
  /Connection terminated|connection is closed|Client (has been closed|was closed)|socket hang up|timeout expired|ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|EAI_AGAIN/i

/** True when the cluster stopped answering — a NAMED degrade, never a stack trace in a panel. */
export function unreachable(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err)
  if (CONNECTION_LOST.test(raw)) return true
  const code: unknown = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  return typeof code === 'string' && CONNECTION_LOST.test(code)
}

/** The column named by a `42703 undefined_column`, or null for any other failure. */
export function missingColumn(err: unknown): string | null {
  if (sqlState(err) !== UNDEFINED_COLUMN) return null
  const raw = err instanceof Error ? err.message : String(err)
  // postgres: `column "cohort" does not exist`.
  return /column "([^"]+)"/.exec(raw)?.[1] ?? 'cohort'
}

/** Rows are capped hard: 90 days of counters is a few thousand rows even with the cohort key
 *  splitting them (there is exactly one owner), and a runaway `dim` cardinality (which the
 *  closed enums make impossible, but this is a boundary) stays bounded. */
export const USAGE_ROW_LIMIT = 20_000
export const INSTALL_ROW_LIMIT = 50_000

/**
 * THE MERGED VIEW, NEVER THE TABLE (JOS-394). `usage_daily_all` is
 * `usage_daily UNION ALL usage_daily_sharded`, summed back to the old key — the frozen
 * pre-cutover rows plus the 32-way sharded rows the Lambda writes now, in one projection that
 * is column-for-column what this function has always returned. Reading `usage_daily` directly
 * from here would report the fleet as it was on cutover day and nothing since, which is the
 * kind of wrong that looks like a quiet week.
 *
 * The degrade path is UNCHANGED and is the reason the name matters: a cluster that has not run
 * the JOS-394 migration answers `42P01` naming `usage_daily_all`, which `missingTable` above
 * hands back and the panel renders as "this cluster is not migrated" rather than as zeros.
 */
export function readUsageDaily(c: Clients, sinceDay: string): Promise<Row[]> {
  return c.query(
    'SELECT day, cohort, metric, dim, n FROM usage_daily_all WHERE day >= $1 ORDER BY day LIMIT $2',
    [sinceDay, USAGE_ROW_LIMIT],
  )
}

export function readUsageFunnelDaily(c: Clients, sinceDay: string): Promise<Row[]> {
  return c.query(
    'SELECT day, cohort, funnel, step, outcome, app_version, n FROM usage_funnel_daily' +
      ' WHERE day >= $1 ORDER BY day LIMIT $2',
    [sinceDay, USAGE_ROW_LIMIT],
  )
}

/**
 * FEEDBACK BUG REPORTS PER BUILD (JOS-96) — the release-health section's fourth source.
 *
 * It reads the `report` table rather than a counter table, and it is here rather than in
 * `store.ts` because it is an ANALYTICS read: it is grouped, it is capped by the analytics
 * window, and it selects three columns none of which is a person. `report_type` comes back so
 * the caller can keep bugs apart from feature requests — a wishlist entry is not a defect and
 * must never be plotted as one.
 *
 * NOTHING IDENTIFYING IS SELECTED. No `report_id`, no `install_id`, no `description` — the whole
 * projection is (build, kind, count), which is the least this question can be answered with. That
 * matters more here than in the other reads on this page, because `report` is the ONE table in
 * the cluster that holds human-written text.
 *
 * The channel is carried so the caller can derive the cohort the same way the ingest path does
 * (`cohortForChannel`): a dev-channel report is the author's own, and the user/owner split is not
 * suspended just because these rows came from a different table.
 */
export function readReportVersions(c: Clients, sinceMs: number): Promise<Row[]> {
  return c.query(
    'SELECT app_version, report_type, channel, COUNT(*) AS n FROM report' +
      ' WHERE received_at >= $1 GROUP BY app_version, report_type, channel LIMIT $2',
    [sinceMs, USAGE_ROW_LIMIT],
  )
}

/**
 * THE ERROR STORE (JOS-100) — the one analytics read that returns something other than a count.
 *
 * `usage_daily` can say a build reported 412 errors; only this table can say WHICH, because the
 * answer needs an EXEMPLAR and a counter has nowhere to put one. What comes back per row is
 * (day, cohort, version, fingerprint, count, exemplar), and the exemplar is a validated
 * `errorReport` event — a redacted message, `out/…` frames, parser event KINDS. There is no
 * `analytics_id` on the table at all, so unlike every other read on this page there is not even
 * an identifier to decline to select.
 *
 * BOUNDED THE SAME WAY the counter reads are, and by the same constant: the row count is
 * (days × versions × distinct issues), which is small while the app is healthy and is exactly
 * the number that stops being small on the day it is most worth reading.
 */
export function readErrorReports(c: Clients, sinceDay: string): Promise<Row[]> {
  return c.query(
    'SELECT day, cohort, version, fingerprint, count, exemplar FROM error_report' +
      ' WHERE day >= $1 ORDER BY day LIMIT $2',
    [sinceDay, USAGE_ROW_LIMIT],
  )
}

/**
 * THE PERF CUBE (JOS-372) — the one CROSS-TAB read on this page, and the only one that returns
 * more than one dimension per row.
 *
 * `usage_daily` can say how many session reports saw a bad stall; only this table can say whether
 * that rate is higher on fullscreen installs, on small boxes, or while an overlay is
 * locked, because a counter keyed on one `dim` structurally cannot cross two facts.
 *
 * BOUNDED EXACTLY LIKE THE COUNTER READS, and by the same constant: it is `day >= :floor` over the
 * PRIMARY KEY's leading column, and the row count per day is capped by the cube's own cardinality
 * (every dim is a closed set — infra/schema.sql states the budget), so the window bounds the scan
 * twice over. There is no id on this table at all, so as with `error_report` there is not even an
 * identifier to decline to select.
 *
 * IT READS `perf_daily_all`, THE MERGED VIEW (JOS-394), for the reason `readUsageDaily` does: the
 * cube is written 32 ways now and the pre-cutover rows are frozen in `perf_daily`. The view sums
 * both back to the seven-column key this function has always returned, so the cross-tab the panel
 * renders is unchanged — one shard's slice of a bucket was never a fact anybody asked for.
 */
export function readPerfDaily(c: Clients, sinceDay: string): Promise<Row[]> {
  return c.query(
    'SELECT day, cohort, window_mode, machine_class, locked, stall_bucket, tail_bucket, n' +
      ' FROM perf_daily_all WHERE day >= $1 ORDER BY day LIMIT $2',
    [sinceDay, USAGE_ROW_LIMIT],
  )
}

/**
 * NOTE WHAT IS NOT SELECTED: `analytics_id`. The readout needs day-grained facts about the
 * population (how many, first seen when, on what version) and never the identifier itself, so
 * the id does not leave the database — not into main, not over the bridge, not into a panel.
 * The one place it is named is `wipe --id`, where the caller already has it.
 */
export function readAnalyticsInstalls(c: Clients): Promise<Row[]> {
  return c.query(
    'SELECT first_seen_day, last_seen_day, days_seen, app_version, channel, cohort' +
      ' FROM analytics_install ORDER BY last_seen_day DESC LIMIT $1',
    [INSTALL_ROW_LIMIT],
  )
}

/**
 * ONE id's install row, or null. The only per-id READ in this module, and it exists for exactly
 * one caller: the post-release smoke test (`scripts/smoke-feedback.mts verify-telemetry`), which
 * has to answer "did the batch this VM sent actually land" and cannot do that from population
 * aggregates.
 *
 * It is the exact twin of `deleteAnalyticsInstall` below, and safe for the same reason: the
 * CALLER ALREADY HOLDS THE ID (it came off the machine that generated it, or from a user asking
 * for a deletion). Nothing here hands out an identifier that was not already in hand — the
 * SELECT list still omits `analytics_id`, so this cannot be used to enumerate ids, and the
 * readout path (`readAnalyticsInstalls`) is untouched.
 */
export async function readAnalyticsInstall(c: Clients, analyticsId: string): Promise<Row | null> {
  const rows = await c.query(
    'SELECT first_seen_day, last_seen_day, days_seen, app_version, channel, cohort' +
      ' FROM analytics_install WHERE analytics_id = $1',
    [analyticsId],
  )
  return rows[0] ?? null
}

// ---- the cohort mark (`analytics owner-add` / `owner-rm` / `owner-ls`) ---------------------
//
// THE ONE PLACE AN analyticsId IS WRITTEN BY HAND. A dev build tags itself server-side from
// `env.channel`, but nothing in a PROD payload can distinguish the author's install from any
// other — deliberately, that is what the id is for — so the installed copy is marked once, by
// id, from the owner's own terminal. The owner reads the id out of the app's payload viewer.
//
// FROM-MARKING-ONWARD: this touches the install row and nothing else. Counters already summed
// under 'user' stay there; they are anonymous sums with no id in them and there is nothing to
// re-attribute. The CLI and the digest both say so.

/** Set (or clear) one install's cohort. Returns rows updated — 0 means "no such id". */
export function setInstallCohort(
  c: Clients,
  analyticsId: string,
  cohort: UsageCohort,
): Promise<number> {
  return c.execute('UPDATE analytics_install SET cohort = $2 WHERE analytics_id = $1', [
    analyticsId,
    cohort,
  ])
}

/** More owner rows than this and something has gone wrong with the marking, not with the cap. */
export const OWNER_ROW_LIMIT = 200

/**
 * The marked rows, ID INCLUDED — the one read in this module that returns an analyticsId in a
 * list, and it is narrow by construction: the `WHERE` matches only rows the operator marked
 * themselves or that a dev build self-tagged, so it can never enumerate a user. It exists
 * because "which ids did I mark, and is my current one still among them after a rotation?" has
 * no other answer.
 */
export function readOwnerInstalls(c: Clients): Promise<Row[]> {
  return c.query(
    'SELECT analytics_id, first_seen_day, last_seen_day, days_seen, app_version, channel, cohort' +
      " FROM analytics_install WHERE cohort = 'owner' ORDER BY last_seen_day DESC LIMIT $1",
    [OWNER_ROW_LIMIT],
  )
}

/**
 * `analytics wipe --id` (T7). The install row is the ONLY per-id row that exists — the
 * counters it contributed to are anonymous sums with no id in them and are deliberately left
 * alone (they cannot be attributed, and unpicking one id's contribution from a sum is not
 * possible in either direction). Returns the number of rows deleted, so the CLI can say
 * whether the id was ever seen.
 */
export function deleteAnalyticsInstall(c: Clients, analyticsId: string): Promise<number> {
  return c.execute('DELETE FROM analytics_install WHERE analytics_id = $1', [analyticsId])
}

/**
 * The telemetry kill switch — `feedback_config.telemetry_accepting`, the twin of
 * `setAccepting`. An UPDATE rather than an UPSERT because the row is seeded by `migrate` and a
 * telemetry switch on a cluster with no config row would be a switch on nothing; zero rows
 * updated is reported to the caller as exactly that.
 */
export function setTelemetryAccepting(c: Clients, accepting: boolean): Promise<number> {
  return c.execute(
    `UPDATE feedback_config SET telemetry_accepting = $1 WHERE id = 'FEEDBACK'`,
    [accepting],
  )
}
