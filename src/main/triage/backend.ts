// ============================================================================
// backend.ts — the TriageBackend seam, and its one AWS-touching implementation.
// ============================================================================
//
// WHY AN INTERFACE AT ALL. `store.ts` is a set of free functions over a `Clients` value it
// builds itself from a Terraform output file and an AWS profile; it offers no injection point,
// so an IPC handler written directly against it can only be exercised with real credentials
// against the real cluster. The interface below is the injection point: `ipc.ts` names only
// `TriageBackend`, and `awsBackend()` is a thin pass-through whose entire job is to turn rows
// into the shapes in `src/shared/triage.ts` (all of which live in `rows.ts`, pure and tested).
//
// LAZY, AND ONE CONNECTION. `makeClients` opens the postgres socket on the FIRST statement,
// so merely having the triage tab compiled in costs nothing until the user opens it. The
// client is held for the process lifetime — a live DSQL connection is what makes the second
// query fast, and `close()` exists for the app's own teardown.
//
// CREDENTIALS COME FROM THE LAUNCHING SHELL: `AWS_PROFILE`, defaulting to `eqc` — the same
// profile name the CLI is documented with in AGENTS.md. Possession of those credentials IS
// the access control (see the header of store.ts); a different shell gets IAM denials, which
// arrive here as ordinary errors and are rendered as prose.

import { readFileSync } from 'node:fs'
import { PREVIEW_MAX_LINES } from '../../shared/feedback'
import type {
  TriageAnalytics,
  TriageAnalyticsData,
  TriageDetail,
  TriageDigest,
  TriageListQuery,
  TriageOpsState,
  TriagePatch,
  TriageRow,
  TriageSlice
} from '../../shared/triage'
import {
  clusterReports,
  parseSince,
  renderDigest,
  type TriageReport
} from '../../../scripts/triageCluster.mjs'
import {
  deleteSlice,
  downloadSlice,
  getFeedbackConfig,
  getReport,
  listInstallProfiles,
  listReports,
  loadStack,
  logKeyOf,
  logObjectExists,
  makeClients,
  missingColumn,
  missingTable,
  readAnalyticsInstalls,
  readErrorReports,
  readReportVersions,
  readUsageDaily,
  readUsageFunnelDaily,
  setAccepting,
  setBlocked,
  setTriage,
  stampRedacted,
  toTriageReport,
  unreachable,
  type Clients,
  type ListFilter
} from './store'
import { toDetail, toOps, toRow } from './rows'
import { buildAnalytics } from './analytics'
import {
  addDays,
  anyOwner,
  dayOf,
  ofCohort,
  toBugReportRows,
  toErrorIssueRows,
  toFunnelRows,
  toInstallRows,
  toUsageRows
} from './usageRows'
import type { UsageCohort } from '../../shared/telemetryRollup'

/** The whole surface `ipc.ts` is allowed to reach. Nothing here knows about Electron. */
export interface TriageBackend {
  list: (q: TriageListQuery) => Promise<TriageRow[]>
  detail: (reportId: string) => Promise<TriageDetail | null>
  slice: (reportId: string) => Promise<TriageSlice | null>
  patch: (reportId: string, patch: TriagePatch) => Promise<void>
  /** Delete the S3 slice object and stamp the redaction. The report STAYS — it is the report. */
  forget: (reportId: string) => Promise<void>
  ops: () => Promise<TriageOpsState>
  setAccepting: (accepting: boolean, message?: string) => Promise<void>
  setBlocked: (installId: string, blocked: boolean, reason: string) => Promise<void>
  digest: (q: TriageListQuery) => Promise<TriageDigest>
  /**
   * Usage analytics over the last `days`, USER COHORT by default. `includeOwner` adds the
   * owner's own use as a SECOND readout beside it — never folded into the first.
   * `available:false` only ever means "this cluster lacks a table or column we read".
   */
  analytics: (days: number, includeOwner: boolean) => Promise<TriageAnalytics>
  close: () => Promise<void>
}

/** The profile whose credentials this process signs with. Owner's shell, owner's access. */
export const TRIAGE_PROFILE = process.env.AWS_PROFILE ?? 'eqc'

function toFilter(q: TriageListQuery, now: number): ListFilter {
  return {
    channel: q.channel,
    sinceMs: parseSince(q.since, now),
    limit: q.limit,
    ...(q.status === undefined ? {} : { status: q.status }),
    ...(q.type === undefined ? {} : { type: q.type })
  }
}

/**
 * The digest's inputs, in the CLI's exact order: map, then sort by reportId, then cluster.
 *
 * THE SORT IS LOAD-BEARING, not cosmetic. reportId is a ULID, so sorting by it is sorting by
 * MINT TIME, and `clusterReports` derives each cluster's id from its first member. Feed it
 * `received_at DESC` (which is what `listReports` returns) and the same backlog yields
 * different cluster ids than the CLI printed an hour ago.
 */
function digestInputs(rows: Record<string, unknown>[]): TriageReport[] {
  return rows.map(toTriageReport).sort((a, b) => a.reportId.localeCompare(b.reportId))
}

/**
 * The slice, RE-SCRUBBED ON READ. A named function rather than a closure member for the same
 * reason `detail` is one: it is the longest step here and `awsBackend` is a dispatch table, not
 * a place to put bodies.
 *
 * `downloadSlice` runs the downloaded bytes through the app's OWN shared scrubber and text
 * sanitizer before they touch the disk — the presign policy pins an upload's key, size and
 * content-type and cannot pin its CONTENT — and reports what that removed. The counts travel
 * with the slice so the panel can warn instead of the owner having to notice.
 */
async function readSlice(c: Clients, reportId: string): Promise<TriageSlice | null> {
  const row = await getReport(c, reportId)
  if (!row) return null
  const key = logKeyOf(row)
  if (key === null) return null
  const re = await downloadSlice(c, reportId, key)
  // The gz bytes stay in main and on disk; only text crosses the bridge, capped by the same
  // constant the outbound feedback preview uses. THE LAW still holds: these lines are rendered
  // in a local window and go nowhere else.
  const all = readFileSync(re.path, 'utf8').split(/\r?\n/)
  const lines = all.slice(0, PREVIEW_MAX_LINES)
  return {
    reportId,
    lines,
    truncated: all.length > lines.length,
    totalLines: all.length,
    path: re.path,
    rescrubDropped: re.dropped,
    rescrubCleaned: re.cleaned,
    rescrubUnknown: re.fromLegacyCache
  }
}

/**
 * THE THREE OUTCOMES THIS DISTINGUISHES, because the panel renders them completely differently
 * and conflating them would be the tab’s worst lie:
 *
 *   * `42P01 undefined_table` (the A2 migration has not run here) or `42703 undefined_column`
 *     (it ran, but before the user/owner split added `cohort`). Both are "this cluster is not
 *     migrated to what this code reads": `state: 'missing'`, naming the missing thing, which
 *     is a fact an operator can act on in one command.
 *   * THE CLUSTER STOPPED ANSWERING mid-read — `state: 'unreachable'`. It used to be neither
 *     of these: the panel printed node-postgres’s own `Connection terminated unexpectedly`,
 *     and the ASYNC half of the same failure was an uncaughtException in the main process
 *     (store.ts `connect` now listens for it). It is a separate named state because it asks a
 *     different thing of the operator than a missing table does: nothing. Retry.
 *   * EVERY OTHER OUTCOME, including three empty result sets — the tables exist and are empty
 *     (the state of a lit client whose server-side `telemetry_accepting` is still closed, or
 *     simply a quiet day). That is honest zeros plus "no data yet", not a "not built" banner.
 *
 * Anything unclassified (an IAM denial, a permission error) is still THROWN and reaches the
 * panel as prose through `attempt()`. A degrade that swallowed everything would hide the next
 * real failure behind a reassuring banner.
 *
 * ONE READ, TWO READOUTS. The statements fetch every cohort; the split is the three `ofCohort`
 * calls below. `buildAnalytics` runs once per cohort over its own rows, so the owner’s sessions
 * are never a denominator for a user-cohort rate.
 */
async function readAnalytics(
  c: Clients,
  days: number,
  includeOwner: boolean
): Promise<TriageAnalytics> {
  const nowMs = Date.now()
  const since = addDays(dayOf(nowMs), -(days - 1))
  try {
    const [rawUsage, rawFunnels, rawInstalls, rawBugs, rawIssues] = await Promise.all([
      readUsageDaily(c, since),
      readUsageFunnelDaily(c, since),
      readAnalyticsInstalls(c),
      // THE FOURTH READ (JOS-96), and the only one that touches the `report` table. It is in the
      // same `Promise.all` and inside the same try, so a cluster missing that table degrades
      // through the identical `missingTable` arm rather than through a second, drifting one.
      //
      // `report.received_at` is epoch MILLISECONDS while the counter tables are keyed on a day
      // string, so the same window has to be expressed twice. Converting the day key (rather than
      // subtracting from `nowMs`) is what keeps the two windows identical: both start at the same
      // UTC midnight, so a report and a counter from the same morning are either both in or both
      // out, and the bug overlay can never be a day out of step with the curve it sits under.
      readReportVersions(c, Date.parse(`${since}T00:00:00Z`)),
      // THE FIFTH READ (JOS-100): the per-fingerprint error store. Same window, same
      // `Promise.all`, same `try` — so a cluster that has not run the migration adding
      // `error_report` degrades through the identical `missingTable` arm and the whole tab
      // says which table is missing, rather than this one read failing quietly and the panel
      // simply never listing an issue.
      readErrorReports(c, since)
    ])
    const usage = toUsageRows(rawUsage)
    const funnels = toFunnelRows(rawFunnels)
    const installs = toInstallRows(rawInstalls)
    const bugReports = toBugReportRows(rawBugs)
    const issues = toErrorIssueRows(rawIssues)
    const build = (cohort: UsageCohort): TriageAnalyticsData =>
      buildAnalytics({
        usage: ofCohort(usage, cohort),
        funnels: ofCohort(funnels, cohort),
        installs: ofCohort(installs, cohort),
        bugReports: ofCohort(bugReports, cohort),
        issues: ofCohort(issues, cohort),
        windowDays: days,
        nowMs
      })
    return {
      available: true,
      data: build('user'),
      owner: includeOwner ? build('owner') : null,
      ownerPresent: anyOwner(usage) || anyOwner(funnels) || anyOwner(installs)
    }
  } catch (err) {
    const missing = missingTable(err) ?? missingColumn(err)
    if (missing !== null) {
      return {
        available: false,
        state: 'missing',
        missing,
        reason:
          `This cluster does not have '${missing}', which the usage-analytics readout selects. ` +
          'The tables and the user/owner `cohort` column both ship in infra/schema.sql - run ' +
          '`npx tsx scripts/triage-feedback.mts migrate --refresh` after the apply that ' +
          'carries them.'
      }
    }
    if (!unreachable(err)) throw err
    return {
      available: false,
      state: 'unreachable',
      reason:
        'The DSQL cluster stopped answering while the readout was reading it (the connection ' +
        'dropped). Nothing is wrong with the schema and nothing needs migrating - the next ' +
        'attempt opens a fresh connection. If it keeps happening, check that this shell still ' +
        'holds valid credentials for the triage role.'
    }
  }
}

/**
 * `open` is the TEST SEAM, and the default is the real thing — the same shape `registerTriageIpc`
 * uses for `backend`. It exists so the two DEGRADE paths below (a cluster missing a table or a
 * column; a cluster that stopped answering) can be pinned by a test with authored failures,
 * instead of only ever being observed in production the way the second one was.
 */
export function awsBackend(
  open: () => Clients = () => makeClients(loadStack(), { profile: TRIAGE_PROFILE })
): TriageBackend {
  let held: Clients | null = null
  const clients = (): Clients => {
    held ??= open()
    return held
  }

  const detail = async (reportId: string): Promise<TriageDetail | null> => {
    const c = clients()
    const row = await getReport(c, reportId)
    if (!row) return null
    const key = logKeyOf(row)
    // ONE HeadObject, and only when a key exists — this is what upgrades `declared` to
    // `present` / `missing`, and it is why the LIST does not attempt the same answer.
    return toDetail(row, key === null ? false : await logObjectExists(c, key))
  }

  return {
    list: async (q) => (await listReports(clients(), toFilter(q, Date.now()))).map(toRow),

    detail,

    slice: (reportId) => readSlice(clients(), reportId),

    patch: (reportId, patch) => setTriage(clients(), reportId, patch),

    forget: async (reportId) => {
      const c = clients()
      const row = await getReport(c, reportId)
      if (!row) throw new Error(`no such report: ${reportId}`)
      const key = logKeyOf(row)
      // Statement for statement, this is the CLI's `forget`: the slice object goes and the row
      // is stamped redacted. The report stays because the description IS the bug report — and
      // there is no contact column left to clear, the schema dropped it.
      if (key) await deleteSlice(c, key)
      await stampRedacted(c, reportId)
    },

    ops: async () => {
      const c = clients()
      return toOps(await getFeedbackConfig(c), await listInstallProfiles(c))
    },

    setAccepting: (accepting, message) => setAccepting(clients(), accepting, message),

    setBlocked: (installId, blocked, reason) => setBlocked(clients(), installId, blocked, reason),

    digest: async (q) => {
      const filter = toFilter(q, Date.now())
      const reports = digestInputs(await listReports(clients(), filter))
      const clusters = clusterReports(reports)
      const markdown = renderDigest(reports, clusters, {
        sinceMs: filter.sinceMs,
        nowMs: Date.now(),
        channel: q.channel
      })
      return { markdown, clusters, reportCount: reports.length }
    },

    /** The usage-analytics readout — body in `readAnalytics` above (this is a dispatch table). */
    analytics: (days, includeOwner) => readAnalytics(clients(), days, includeOwner),

    close: async () => {
      const open = held
      held = null
      if (open) await open.close()
    }
  }
}
