/**
 * triageAnalytics.mts — the `analytics …` subcommands of `triage-feedback`.
 *
 * A separate file for the reason every split in this repo is: `triage-feedback.mts` was at the
 * 400-code-line ceiling, and a split is the answer to that rather than a widened threshold
 * (`triageCluster.mts`, `analyticsDigest.mts` and `src/main/triage/store.ts` are the same
 * move). Nothing about the CLI's shape changes: `analytics` is one entry in its COMMANDS table
 * and this module is what that entry runs.
 *
 * IT READS THE SAME CODE THE APP DOES. `buildAnalytics` here is the same function
 * `src/main/triage/backend.ts` calls for the Analytics tab, over the same statements in
 * `store.ts`. The CLI and the panel cannot print different numbers for the same window.
 */

import { readFileSync } from 'node:fs'
import {
  deleteAnalyticsInstall,
  missingColumn,
  missingTable,
  readAnalyticsInstalls,
  readOwnerInstalls,
  readPerfDaily,
  readUsageDaily,
  readUsageFunnelDaily,
  SCHEMA_FILE,
  setInstallCohort,
  setTelemetryAccepting,
  unreachable,
  type Clients,
} from '../src/main/triage/store'
import { runBackfill, runSwap, verifyTables } from './analyticsBackfill.mjs'
// The offline copy (JOS-399) and the restore that shares its shape with JOS-398's S3 export.
// Their CLI entry points live beside their implementations for the same reason this whole file
// does: the parent router is at the 400-code-line ceiling and so, now, is this one.
import { cmdAnalyticsExport, requireFreshExport } from './analyticsExport.mjs'
import { cmdAnalyticsImport } from './analyticsImport.mjs'
import { buildAnalytics } from '../src/main/triage/analytics'
import {
  addDays,
  dayOf,
  ofCohort,
  toFunnelRows,
  toInstallRows,
  toPerfRows,
  toUsageRows,
  type FunnelRow,
  type InstallRow,
  type PerfRow,
  type UsageRow,
} from '../src/main/triage/usageRows'
import { USAGE_COHORTS, type UsageCohort } from '../src/shared/telemetryRollup'
import { fetchGhDownloads } from '../src/main/triage/ghDownloads'
import { fetchLiveSessions } from '../src/main/triage/liveSessions'
import { renderAnalyticsDigest } from './analyticsDigest.mjs'
import { sanitizeOneLine } from '../src/shared/sanitizeText'

/**
 * The `analytics …` block of `triage-feedback`'s usage text, spelled beside the commands it
 * describes rather than in the parent's USAGE string — the parent was at the 400-code-line
 * ceiling, and help that lives next to its implementation is the half of that trade worth
 * having anyway.
 */
export const ANALYTICS_USAGE = `
  analytics digest [--days 30] [--json] [--cohort user|owner|all]
                                            usage analytics as text (same numbers as the
                                            Triage -> Analytics tab, one computation).
                                            DEFAULTS TO --cohort user: your own dev builds and
                                            any install you marked below are split OUT. 'all'
                                            prints BOTH digests; nothing ever sums them.
                                            The text digest also fetches GitHub release download
                                            counts — UPDATER-INFLATED, NOT installs, and global
                                            rather than per-cohort. Unreachable GitHub prints
                                            '(unavailable: …)' and changes nothing else.
  analytics wipe   --id <analyticsId>       delete that id's analytics_install row
  analytics open | close                    the TELEMETRY kill switch (instant, no deploy)

  analytics owner-add <analyticsId>         mark an install as YOURS (the installed copy — dev
                                            builds tag themselves from env.channel). Read the
                                            id in the app: Preferences -> Usage analytics ->
                                            "Anonymous id".
  analytics owner-rm  <analyticsId>         put it back in the user cohort
  analytics owner-ls                        what is marked. A ROTATED analyticsId is a NEW id
                                            and arrives UNMARKED — re-run owner-add after one.
                                            Marking is FROM-MARKING-ONWARD: counters already
                                            summed carry no id and are never re-attributed.

  THE OFFLINE COPY (JOS-399). Take one BEFORE anything that touches a table: \`migrate\` and the
  three backfill commands REFUSE to run without an export from the last 6 hours.
  analytics export [--out <dir>]            every table, gzipped, with a checksummed manifest.
                                            READ ONLY. Default --out .triage/exports/ (gitignored).
  analytics import <dir> [--dry-run]        put one back: checksums verified BEFORE any write,
                                            then an idempotent keyed upsert per table. Rows from
                                            a MERGED-VIEW export land under shard 0.

  THE ONE-OFF COHORT MIGRATION (a cluster with the PRE-COHORT counter tables). COPY FIRST —
  nothing is dropped until a verified copy exists. Ordered commands: infra/README.md.
  analytics backfill-cohort                 copy every counter row into cohort-keyed staging
                                            tables. Requires the switch CLOSED. Re-runnable.
  analytics backfill-verify                 old vs new, per table: row count AND sum(n)
  analytics backfill-swap                   drop the copied-from original and rename staging
                                            into its place. REFUSES on any mismatch.
`

/** The CLI's parsed flags, as `parseArgs` hands them over. */
export type Args = Record<string, string | boolean | undefined>

export interface AnalyticsCtx {
  args: Args
  /** The positionals AFTER `analytics`, subcommand first — `['owner-add', '<analyticsId>']`. */
  rest: string[]
  /** Lazily opens the DSQL connection — `analytics` with a bad flag must cost no round trip. */
  clients: () => Clients
  nowMs: number
}

const MAX_WINDOW_DAYS = 3650

/** `--cohort user|owner|all`, defaulting to the population question. */
type CohortChoice = UsageCohort | 'all'

function cohortChoice(raw: unknown): CohortChoice {
  if (raw === undefined) return 'user'
  const allowed: readonly string[] = [...USAGE_COHORTS, 'all']
  if (typeof raw !== 'string' || !allowed.includes(raw)) {
    throw new Error(`--cohort: expected one of ${allowed.join(', ')}`)
  }
  return raw as CohortChoice
}

/** The three row arrays, already typed and cohort-normalized — one read serves every choice. */
interface CohortRows {
  usage: UsageRow[]
  funnels: FunnelRow[]
  installs: InstallRow[]
  /** The perf cube (JOS-372) — a FOURTH table, read here for the same reason the other three
   *  are: the digest and the tab must render one computation, and a section the CLI could not
   *  feed would be a section that silently disagrees with the panel. */
  perf: PerfRow[]
}

/**
 * `analytics digest [--days N] [--cohort user|owner|all] [--json]` — the terminal view of the
 * SAME numbers the Analytics tab renders. Not a second computation: it reads the three tables
 * and hands them to `buildAnalytics`. A CLI that recomputed would eventually disagree with the
 * panel, and the disagreement would be invisible until somebody compared them side by side.
 *
 * THE DEFAULT IS `user`, AND `all` PRINTS TWO DIGESTS, NOT ONE COMBINED ONE. The owner's own
 * dev-build and installed use is real data worth keeping and worth reading — but summed into
 * the population it is the loudest install in a tiny fleet, so nothing here ever adds the two
 * together. Each digest is built from its own rows, so each cohort's rates use its own
 * denominators too.
 */
export async function cmdAnalyticsDigest(ctx: AnalyticsCtx): Promise<void> {
  const days = Number(ctx.args.days ?? 30)
  if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) {
    throw new Error(`analytics digest: --days must be a whole number of days (1..${String(MAX_WINDOW_DAYS)})`)
  }
  const choice = cohortChoice(ctx.args.cohort)
  const c = ctx.clients()
  const since = addDays(dayOf(ctx.nowMs), -(days - 1))
  // The GitHub release fetch rides ALONGSIDE the three reads rather than after them, and only
  // for the text digest — `--json` is the machine shape, whose consumers read the counter tables
  // this command owns and not a number from a third-party API. A GitHub failure cannot fail the
  // digest: `fetchGhDownloads` resolves to an `available: false` reason and the section says so.
  // The LIVE read rides along on the same terms as the GitHub one: text digest only, in parallel,
  // and unavailable is a printed reason rather than a failed command. It is CloudWatch (the EMF
  // heartbeat metric), not the cluster — the counter tables are keyed on a day and cannot answer
  // "right now" at all.
  const [usage, funnels, installs, perf, downloads, live] = await Promise.all([
    readUsageDaily(c, since),
    readUsageFunnelDaily(c, since),
    readAnalyticsInstalls(c),
    readPerfDaily(c, since),
    ctx.args.json ? undefined : fetchGhDownloads(ctx.nowMs),
    ctx.args.json
      ? undefined
      : fetchLiveSessions({
          profile: typeof ctx.args.profile === 'string' ? ctx.args.profile : undefined,
          nowMs: ctx.nowMs,
        }),
  ])
  const rows: CohortRows = {
    usage: toUsageRows(usage),
    funnels: toFunnelRows(funnels),
    installs: toInstallRows(installs),
    perf: toPerfRows(perf),
  }
  const build = (cohort: UsageCohort): ReturnType<typeof buildAnalytics> =>
    buildAnalytics({
      usage: ofCohort(rows.usage, cohort),
      funnels: ofCohort(rows.funnels, cohort),
      installs: ofCohort(rows.installs, cohort),
      perf: ofCohort(rows.perf, cohort),
      windowDays: days,
      nowMs: ctx.nowMs,
    })
  const wanted: UsageCohort[] = choice === 'all' ? [...USAGE_COHORTS] : [choice]
  if (ctx.args.json) {
    // One cohort keeps the historical shape (the bare data object); `all` has to name which is
    // which, and a keyed object is the only shape that cannot be mistaken for a sum.
    const out =
      choice === 'all'
        ? Object.fromEntries(wanted.map((k) => [k, build(k)]))
        : build(wanted[0])
    console.log(JSON.stringify(out, null, 2))
    return
  }
  // Downloads go to the FIRST digest only. `--cohort all` prints two, and a release download
  // belongs to neither cohort — printing the same table under both headings would imply a split
  // that does not exist and invite somebody to add the two up.
  console.log(
    wanted
      .map((k, i) =>
        renderAnalyticsDigest(build(k), k, i === 0 ? downloads : undefined, i === 0 ? live : undefined),
      )
      .join('\n'),
  )
}

/**
 * `analytics wipe --id <analyticsId>` (plan T7) — the deletion path for usage analytics, and
 * it is one statement because there is only one row.
 *
 * WHAT IS NOT DELETED, and why that is the right answer rather than a limitation: the counters
 * this id contributed to. They are anonymous SUMS — `usage_daily` holds "37 map opens on
 * 2026-08-04", with no id anywhere in the table — so there is nothing in them to attribute to
 * a person, and subtracting a guess would corrupt a true number to satisfy a request the data
 * does not contain. The install row IS the id's entire footprint (plan §4), and it goes.
 */
export async function cmdAnalyticsWipe(ctx: AnalyticsCtx): Promise<void> {
  const id = typeof ctx.args.id === 'string' ? ctx.args.id : ''
  if (!id) throw new Error('analytics wipe: --id <analyticsId> is required')
  const gone = await deleteAnalyticsInstall(ctx.clients(), id)
  console.log(
    gone > 0
      ? `deleted the analytics_install row for ${id}.\n` +
          'The daily counters it contributed to are anonymous sums and are deliberately ' +
          'untouched — they carry no id and cannot be attributed to one.'
      : `no analytics_install row for ${id} (nothing to delete).`,
  )
}

/** The TELEMETRY kill switch — `telemetry_accepting`, the twin of `closed on|off`. */
async function setSwitch(ctx: AnalyticsCtx, accepting: boolean): Promise<void> {
  const rows = await setTelemetryAccepting(ctx.clients(), accepting)
  if (rows === 0) throw new Error('no feedback_config row — run `triage-feedback migrate` first')
  console.log(
    accepting
      ? 'telemetry OPEN — /v1/telemetry now accepts batches.'
      : 'telemetry CLOSED — every batch gets 503 + no counters move. No deploy needed.',
  )
}

// ---- the owner mark -----------------------------------------------------------------------
//
// WHY THIS IS A COMMAND AND NOT A HEURISTIC. The dev channel tags itself: `env.channel` is in
// every payload, so the ingest path already knows a dev build is the author's and needs nothing
// from anyone. The INSTALLED copy is the case with no signal at all — a prod payload from the
// author is byte-identical in shape to a prod payload from a stranger, deliberately, and any
// server-side guess ("the install with the most sessions") would be a heuristic that quietly
// mislabels a real enthusiast. So it is a mark, placed by hand, once, against an id the owner
// reads out of the app's own payload viewer (Preferences → usage analytics).
//
// ROTATION IS THE FOOT-GUN, and it is the reason the help below says so twice: rotating the
// analyticsId mints a NEW id, the old row keeps its mark, and the new one arrives unmarked. Run
// `owner-ls` after a rotation and re-add.

/**
 * The id, positionally (`owner-add <analyticsId>`) or as `--id`, which is the spelling `wipe`
 * already uses. It is deliberately NOT `--install`: an analyticsId is not an installId and the
 * two must never be interchangeable at the command line either (plan T3).
 */
function requireId(ctx: AnalyticsCtx, command: string): string {
  const positional = ctx.rest[1] ?? ''
  const id = positional.length > 0 ? positional : typeof ctx.args.id === 'string' ? ctx.args.id : ''
  if (!id) throw new Error(`analytics ${command}: <analyticsId> (or --id <analyticsId>) is required`)
  return id
}

async function markCohort(ctx: AnalyticsCtx, cohort: UsageCohort): Promise<void> {
  const command = cohort === 'owner' ? 'owner-add' : 'owner-rm'
  const id = requireId(ctx, command)
  const rows = await setInstallCohort(ctx.clients(), id, cohort)
  if (rows === 0) {
    console.log(
      `no analytics_install row for ${id} — nothing marked.\n` +
        'The row is created by that install\'s FIRST accepted batch, so mark it after the app ' +
        'has reported at least once (and check the id in Preferences → usage analytics).',
    )
    return
  }
  console.log(
    cohort === 'owner'
      ? `${id} is now the OWNER cohort. From the next batch onward its counters land in ` +
          'owner-keyed rows and drop out of `analytics digest` by default.\n' +
          'Counters this id already contributed to stay where they are: they are anonymous ' +
          'sums with no id in them, so there is nothing to move. The split is ' +
          'from-marking-onward, and the digest header says so.\n' +
          'IF YOU ROTATE THE analyticsId, the new id arrives UNMARKED — re-run this command.'
      : `${id} is back in the USER cohort from the next batch onward. Owner-keyed rows it ` +
          'already produced stay owner-keyed, for the same reason: a counter has no id in it.\n' +
          'NOTE: a DEV-channel install re-tags itself as owner on its next batch regardless — ' +
          'the channel is derived server-side and this mark cannot outvote it.',
  )
}

/**
 * `owner-ls` — what is marked, and therefore what a rotation has orphaned.
 *
 * IT PRINTS analyticsIds, which no other read path does. That is safe here in the exact way it
 * is not elsewhere: the query matches ONLY rows whose cohort is already 'owner', i.e. rows the
 * operator marked themselves or that a dev build self-tagged. It cannot enumerate a user.
 */
async function cmdOwnerLs(ctx: AnalyticsCtx): Promise<void> {
  const rows = await readOwnerInstalls(ctx.clients())
  if (rows.length === 0) {
    console.log(
      'no installs are marked as the owner cohort.\n' +
        'Dev builds tag themselves on their first batch (nothing to do). For the INSTALLED ' +
        'copy: read its analyticsId from Preferences → Usage analytics → "Anonymous id", ' +
        'then `analytics owner-add --id <analyticsId>`.',
    )
    return
  }
  const cell = (v: unknown): string => (typeof v === 'string' ? sanitizeOneLine(v) : '?')
  for (const r of rows) {
    console.log(
      `${cell(r.analytics_id)}  ${cell(r.channel).padEnd(5)} ${cell(r.app_version).padEnd(10)}` +
        ` first ${cell(r.first_seen_day)} · last ${cell(r.last_seen_day)}` +
        ` · ${String(typeof r.days_seen === 'number' ? r.days_seen : 0)} day(s)`,
    )
  }
  console.log(
    `\n${String(rows.length)} owner install(s). A ROTATED analyticsId is a NEW id: the old row ` +
      'above keeps its mark and the new one arrives unmarked, so re-run `owner-add` after any ' +
      'rotation.',
  )
}

// ---- the one-off cohort migration (scripts/analyticsBackfill.mts) ---------------------------
//
// THREE COMMANDS BECAUSE THERE ARE THREE MOMENTS TO BE ABLE TO STOP AT: after the copy, after
// reading the proof, and after the swap. Folding them into one would mean a single command that
// drops a live table somewhere in its middle, which is the shape of every migration anybody has
// ever regretted. The reasoning, the DSQL RENAME finding and the cohort derivation are all
// written out in the header of ./analyticsBackfill.mts; the ordered runbook is infra/README.md.

/**
 * THE EXPORT GUARD (JOS-399), on the three commands that rewrite or swap a physical table.
 *
 * It lives HERE, in the dispatch, rather than inside analyticsBackfill.mts, and that is the same
 * boundary that module's own header draws: it takes `Clients` as an argument and touches no
 * filesystem, so it can be driven end to end by a fake with no AWS in sight. A disk check inside
 * it would put an operator's `.triage/` directory into every one of those tests. The CLI is the
 * only way any of the three is ever reached.
 *
 * `backfill-verify` is guarded too even though it only reads: it is the step an operator runs
 * immediately before the swap, so refusing there is refusing at the moment the copy is still
 * cheap to take, rather than one command later with the DROP already queued up in their head.
 */
function guard(ctx: AnalyticsCtx, what: string): void {
  requireFreshExport(ctx.args, what, ctx.nowMs)
}

async function cmdBackfill(ctx: AnalyticsCtx): Promise<void> {
  guard(ctx, 'analytics backfill-cohort')
  const { installs, tables } = await runBackfill(ctx.clients(), readFileSync(SCHEMA_FILE, 'utf8'))
  for (const t of tables) {
    console.log(`${t.table.padEnd(20)} ${t.created ? 'staging created' : 'staging existed'} · ${String(t.copied)} row(s) copied`)
  }
  console.log(`analytics_install: ${String(installs)} row(s) given an explicit cohort.`)
  console.log('\nNOTHING HAS BEEN DROPPED. Next: `analytics backfill-verify`, then `analytics backfill-swap`.')
}

async function cmdBackfillVerify(ctx: AnalyticsCtx): Promise<void> {
  guard(ctx, 'analytics backfill-verify')
  const rows = await verifyTables(ctx.clients())
  const cell = (t: { rows: number; total: number } | null): string =>
    t === null ? '(absent)' : `${String(t.rows)} row(s) / n=${String(t.total)}`
  for (const r of rows) {
    console.log(`${r.table.padEnd(20)} from ${cell(r.from).padEnd(26)} to ${cell(r.to).padEnd(26)} ${r.ok ? 'OK  ' : 'FAIL'} ${r.note}`)
  }
  console.log(
    rows.every((r) => r.ok)
      ? '\nEvery table matched on BOTH numbers. `analytics backfill-swap` will re-check this before it touches anything.'
      : '\nDO NOT SWAP. Re-run `analytics backfill-cohort` (it is idempotent) and verify again.',
  )
}

async function cmdBackfillSwap(ctx: AnalyticsCtx): Promise<void> {
  guard(ctx, 'analytics backfill-swap')
  for (const step of await runSwap(ctx.clients())) console.log(`${step.done ? 'ran     ' : 'skipped '} ${step.sql}`)
  console.log(
    '\nThe cohort-keyed tables now carry the real names, with every legacy row in them.\n' +
      'Next: `terraform apply` (the cohort-aware Lambda), then `analytics open`.',
  )
}

/**
 * The ONE error translation this layer owns, shared with `triage-feedback.mts`'s `analytics`
 * dispatch: a cluster that has not been migrated, and a cluster that stopped answering, are both
 * facts about the CLUSTER rather than bugs, and printing node-postgres's own words at the
 * operator is how the app came to show them a raw `Connection terminated unexpectedly`.
 */
export function analyticsFailure(err: unknown): Error {
  const missing = missingTable(err) ?? missingColumn(err)
  if (missing !== null) {
    return new Error(
      `'${missing}' does not exist on this cluster. The usage-analytics tables AND the ` +
        'user/owner `cohort` column both ship in infra/schema.sql — run `triage-feedback ' +
        'migrate --refresh` after the apply that carries them.',
    )
  }
  if (unreachable(err)) {
    return new Error(
      'the DSQL cluster stopped answering (the connection dropped). Nothing needs migrating — ' +
        'run the command again and it opens a fresh connection.',
    )
  }
  return err instanceof Error ? err : new Error(String(err))
}

export const ANALYTICS_SUBCOMMANDS: Record<string, (ctx: AnalyticsCtx) => Promise<void>> = {
  digest: cmdAnalyticsDigest,
  wipe: cmdAnalyticsWipe,
  open: (ctx) => setSwitch(ctx, true),
  close: (ctx) => setSwitch(ctx, false),
  'owner-add': (ctx) => markCohort(ctx, 'owner'),
  'owner-rm': (ctx) => markCohort(ctx, 'user'),
  'owner-ls': cmdOwnerLs,
  // The offline copy and its restore (JOS-399). `export` is the only command in this family that
  // is safe against production by construction: it holds no statement that writes.
  export: cmdAnalyticsExport,
  import: cmdAnalyticsImport,
  'backfill-cohort': cmdBackfill,
  'backfill-verify': cmdBackfillVerify,
  'backfill-swap': cmdBackfillSwap,
}

function analyticsSubcommand(name: string | undefined): ((ctx: AnalyticsCtx) => Promise<void>) | null {
  return name === undefined ? null : (ANALYTICS_SUBCOMMANDS[name] ?? null)
}

/**
 * THE WHOLE FAMILY, dispatch and failure translation included, so `triage-feedback.mts` is one
 * line in its command table.
 *
 * MOVED HERE BY JOS-100, and by that file's own line count rather than by taste: adding the
 * error family's dispatcher put it over the repo's 400-code-line ceiling, and two nearly
 * identical eleven-line dispatchers living in the router was exactly the shape that did it.
 * `runErrors` (triageErrors.mts) is the twin of this function; keeping the two families
 * symmetric is what makes "add a third family" a one-line change there.
 */
export async function runAnalytics(ctx: AnalyticsCtx): Promise<void> {
  const run = analyticsSubcommand(ctx.rest[0])
  if (run === null) {
    throw new Error(`analytics: expected one of ${Object.keys(ANALYTICS_SUBCOMMANDS).join(', ')}`)
  }
  try {
    await run(ctx)
  } catch (err) {
    throw analyticsFailure(err)
  }
}
