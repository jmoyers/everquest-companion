// ============================================================================
// TELEMETRY ROLLUP — the ONE definition of what a batch becomes once it lands.
// ============================================================================
//
// `./telemetry.ts` says what a client may SEND. This file says what the server may KEEP, and
// the two are deliberately different documents: the wire schema is a privacy promise, this is
// a storage decision (plan T6 — "ingest aggregates on arrival … no raw-event store at all").
//
// WHO READS IT, and why it is shared rather than living in the Lambda:
//   * `infra/lambda/telemetry.ts` — turns one validated batch into the UPSERT rows;
//   * `src/main/triage/analytics.ts` — reads those same rows back for the Analytics panel;
//   * `scripts/triage-feedback.mts analytics digest` — the text version of the same numbers;
//   * `scripts/dev-feedback-server.mts` — the local rehearsal of the ingest path.
//
// If the metric NAMES lived in the handler, the readout would be a second hand-typed copy of
// them, and the first typo would be a silently empty panel rather than a compile error. They
// live here, spelled once, and every reader imports them.
//
// PURE, like the contract: the only import is `./telemetry` (types, the closed enums and
// `bucketOf`). No `node:`, no Electron, no DOM — it bundles into a Lambda and compiles under
// both of the repo's tsconfigs.
//
// ---------------------------------------------------------------------------------------
// WHAT AN AGGREGATE CAN AND CANNOT ANSWER — read this before adding a panel row.
// ---------------------------------------------------------------------------------------
// A daily counter keyed on (day, metric, dim) can answer "how many", "how much" and "how
// long" per day. It CANNOT answer anything that needs the identity behind the count:
//
//   * DISTINCT-PER-DAY is possible only where the ingest path already knows it is seeing an
//     id for the first time today — which it does, once, from the `analytics_install` UPSERT.
//     That is why `activeInstalls` (DAU) exists as a counter at all, and why the envelope
//     facts (version/channel/platform/tz) are counted ONLY on that first batch: counted per
//     batch they would measure flush loops, not people.
//   * WAU / MAU / retention are NOT unions of daily counters (an install active on Monday and
//     Tuesday would be counted twice). They are computed at READ time from
//     `analytics_install`, which is the one place a per-id fact survives.
//   * PER-FEATURE REACH ("what share of installs opened Maps") is not derivable here at all —
//     it would need per-id, per-feature state, which is exactly the per-user event trail T6
//     refused to keep. The panel reports uses and uses-per-session instead, and says so.
//   * A MEDIAN cannot be summed. So session length is kept twice: a total (for the mean) and
//     a HISTOGRAM over `SESSION_MS_EDGES` (for a median that is honest to a bucket, and is
//     rendered as a range rather than a fake exact number).

import {
  bucketOf,
  type EvErrorReport,
  type StartupReplayStats,
  type TelemetryBatch,
  type TelemetryEvent,
  type TelemetryRecord
} from './telemetry'

/** `dim` is NOT NULL in the schema; this is what "this metric has no dimension" looks like. */
export const DIM_NONE = '-'

// ---------------------------------------------------------------- the cohort dimension
//
// WHOSE USE IS THIS? The owner runs this app too — a dev build all day, and the installed copy
// in the evening — and their own use is a real signal about the BUILD but pure noise in every
// number about the USER BASE. A three-install "population" of which one is the author is not a
// population. So every counter row carries a cohort and the read paths default to 'user'.
//
// SPLIT, NEVER SUMMED, NEVER DROPPED (the owner's words: "just split it out, but keep it").
// `--cohort all` and the tab's toggle render two readouts SIDE BY SIDE; nothing anywhere adds
// them together, because a merged total is precisely the number the split exists to stop
// reporting. And nothing deletes an owner row: it is the only usage data about a build the
// author actually drives hard, which makes it the best signal there is about the build itself.
//
// TWO WAYS A ROW BECOMES 'owner', and they are deliberately different mechanisms:
//
//   * THE DEV CHANNEL TAGS ITSELF, SERVER-SIDE, WITH NO CLIENT CHANGE. `env.channel` has been in
//     the envelope since the contract was written (TELEMETRY.md documents it; `foldEnvelope`
//     below already counts it), so the ingest path derives the cohort from a field it is
//     already handed. A dev build cannot belong to anyone but the author, so there is nothing to
//     mark and nothing to get wrong.
//   * THE INSTALLED COPY IS MARKED BY HAND, ONCE, BY analyticsId
//     (`triage-feedback analytics owner-add <id>`). NOTHING in a prod payload distinguishes the
//     author's install from anybody else's — that is the entire point of the id — so the mark
//     has to be server-side state on `analytics_install`, and the owner reads their id out of
//     the app's own payload viewer. A rotated id is a NEW id and needs re-marking; the CLI help
//     says so, because a silently unmarked owner is exactly the failure this feature exists to
//     prevent.
//
// FROM-MARKING-ONWARD IS THE HONEST SEMANTIC. A counter is an anonymous SUM with no id in it, so
// rows already aggregated under 'user' cannot be re-attributed after a marking and are left
// exactly alone. The digest states that in its header rather than letting the reader assume the
// split is retroactive.

export const USAGE_COHORTS = ['user', 'owner'] as const
export type UsageCohort = (typeof USAGE_COHORTS)[number]

/** What an unmarked install is, what a NULL column reads as, and what the digest defaults to. */
export const DEFAULT_COHORT: UsageCohort = 'user'

/**
 * TOTAL, and it fails toward 'user' on purpose: a NULL column (the `ALTER` adds it nullable), a
 * value from a future schema, or junk all read as an ordinary user row. The alternative — a
 * strict parse that throws — would turn one bad row into an empty panel.
 */
export function cohortOf(value: unknown): UsageCohort {
  return value === 'owner' ? 'owner' : DEFAULT_COHORT
}

/** The channel that can only ever be the author's own machine. Everything else is a user. */
export function cohortForChannel(channel: string): UsageCohort {
  return channel === 'dev' ? 'owner' : DEFAULT_COHORT
}

/**
 * Every metric name the ingest path may write. A closed table for the same reason the event
 * union is closed: `usage_daily.metric` is free-form TEXT as far as postgres knows, and the
 * only thing that keeps it an enum is this object plus the fact that nothing else writes it.
 */
export const USAGE_METRICS = {
  /** Distinct installs that sent anything that day. Emitted once per id per day. */
  activeInstalls: 'activeInstalls',
  /** Installs whose `analytics_install` row was created that day. */
  newInstalls: 'newInstalls',
  /**
   * Installs that reported a DIFFERENT `appVersion` than the one their install row was holding.
   *
   * DERIVED SERVER-SIDE, and it has to be: the client has no idea what it used to be (a fresh
   * build reads its own version and nothing else), and asking it to remember would be a new
   * event, a schema change and a value we would then have to trust. The install UPSERT is
   * already reading the stored version in order to overwrite it, so the comparison is free and
   * lands in the same transaction as the counters it belongs beside.
   *
   * EXACTLY ONCE PER UPGRADE. The same statement writes the new version, so the very next batch
   * from that install sees no difference. A DOWNGRADE counts too, and deliberately so — the
   * fact worth knowing is "this install changed build", and a rollback is the version of that
   * fact most worth seeing.
   */
  upgrades: 'upgrades',
  sessions: 'sessions',
  sessionEnds: 'sessionEnds',
  sessionMsTotal: 'sessionMsTotal',
  /** dim = index into SESSION_MS_EDGES. The median's only honest source. */
  sessionLenBucket: 'sessionLenBucket',
  heartbeats: 'heartbeats',
  /**
   * Log lines this fleet PARSED — work done, not distinct lines. The startup replay re-reads a
   * character's whole history, so a line the app has seen before counts again on the next
   * launch; TELEMETRY.md says so in the field's own note. Summed from the optional `linesParsed`
   * on `sessionHeartbeat` / `sessionEnd`.
   */
  linesParsed: 'linesParsed',
  /** dim = index into COLD_START_MS_EDGES. */
  coldStartBucket: 'coldStartBucket',
  /** dim = view id. */
  viewDwellMs: 'viewDwellMs',
  viewVisits: 'viewVisits',
  /** dim = overlay kind. */
  overlayOpen: 'overlayOpen',
  overlayClose: 'overlayClose',
  /** dim = feature id. */
  featureUse: 'featureUse',
  alertsFired: 'alertsFired',
  alertsSpoken: 'alertsSpoken',
  /** The envelope facts, counted once per active install per day (see the header). */
  version: 'version',
  channel: 'channel',
  platform: 'platform',
  tzOffset: 'tzOffset',
  /** setupSnapshot, one metric per field; dim is the bucket index or the enum member. */
  setups: 'setups',
  setupChars: 'setupChars',
  setupLogSize: 'setupLogSize',
  setupAlerts: 'setupAlerts',
  setupOverlay: 'setupOverlay',
  setupCursorRing: 'setupCursorRing',
  setupAutoHide: 'setupAutoHide',
  setupVoice: 'setupVoice',
  setupPacks: 'setupPacks',
  setupUpdateChannel: 'setupUpdateChannel',
  /**
   * ERRORS PER BUILD (JOS-96) — "did I release buggy code", which is a question about a RELEASE
   * and so cannot be answered by a counter that only knows a field name.
   *
   * dim = `<version>:<field>`, n = the count reported. The JOS-57 startup precedent exactly:
   * `usage_daily` has no version COLUMN (the key is day+cohort+metric+dim and cannot grow one —
   * infra/schema.sql), so the version lives in `dim`, and that makes this additive with NO schema
   * change and NO migration. It is also free to redesign right now precisely because NO CLIENT HAS
   * EVER EMITTED `healthCounters`: there are zero rows in the live table to be re-encoded, so the
   * old field-name-only encoding has no history to preserve.
   */
  health: 'health',
  /**
   * dim = `<version>`. THE DENOMINATOR, and it is per-version for the same reason
   * `startupReplays` is: `health / healthReports` at the same version is a self-normalizing RATE
   * (errors per reporting session on that build), so a build that simply has more users cannot
   * look buggier than one that has fewer.
   *
   * It is also the CAPABILITY SIGNAL, which is the half that keeps the readout honest. A version
   * that predates the emitting client reports nothing at all — no `healthReports` row — and that
   * is visibly different from a version that reported sessions and found no errors. The panel
   * renders the first as "not reporting" and the second as a true zero; without a per-version
   * denominator the two would be the same absent row.
   */
  healthReports: 'healthReports',
  // (`HEALTH_NON_ERROR_FIELDS`, below this object, says which of the `health` dims may be summed
  //  into an error RATE and which may not. It lives outside `USAGE_METRICS` because it names
  //  fields of the event, not metrics of the table.)
  /**
   * THE STARTUP REPLAY (JOS-57), and every one of these is dimensioned BY VERSION because that is
   * the only question worth asking of it: "did the throttle we shipped make launches better" is a
   * comparison between builds, and a fleet-wide average over every version that ever ran would
   * smear the change we are looking for across the releases either side of it.
   *
   * `usage_daily` has no version COLUMN (the key is day+cohort+metric+dim, and it cannot grow one
   * — see infra/schema.sql), so the version lives in `dim`, exactly as `update` puts a step and an
   * outcome there. That is also why this is additive with NO SCHEMA CHANGE: new metric names in a
   * table that was built to hold arbitrary ones.
   */
  /** dim = appVersion. The DENOMINATOR: launches that reported a replay at all. */
  startupReplays: 'startupReplays',
  /** dim = `<version>:<index into REPLAY_MS_EDGES>`. A median cannot be summed — hence a histogram. */
  startupReplayMs: 'startupReplayMs',
  /** dim = `<version>:<index into BLOCK_MS_EDGES>`. Same argument, worst single stall. */
  startupBlockMs: 'startupBlockMs',
  /** dim = appVersion; n = the SUM of achieved duty percentages. Mean = this / startupReplays. */
  startupDutyPct: 'startupDutyPct',
  /** dim = appVersion; n = summed count of 50 ms+ stalls. */
  startupBlocksOver50: 'startupBlocksOver50',
  /** dim = appVersion; n = summed events folded. Mean = this / startupReplays. */
  startupEventsReplayed: 'startupEventsReplayed',
  /**
   * dim = index into LOG_SIZE_BYTES_EDGES, and deliberately NOT versioned: how big the fleet's
   * logs are is a fact about the population, not about a build, and it reads beside `setupLogSize`
   * (the same edges) rather than against it.
   */
  startupLogSize: 'startupLogSize',
  /**
   * ERROR REPORTS PER BUILD (JOS-100) — the DENOMINATOR beside `error_report`'s own counts.
   *
   * dim = `<version>`, n = errors reported (the sum of the events' `count` fields). The
   * per-fingerprint detail lives in its own table, because "which issue" needs an exemplar and
   * `usage_daily` has nowhere to put one; what lives HERE is the fleet-wide total, so a panel
   * can say "this build reported 412 errors across 9 issues" without reading the exemplars.
   */
  errors: 'errors',
  /** dim = `<version>`; n = distinct errorReport EVENTS. One event is one fingerprint-session,
   *  so `errors / errorEvents` is the average burst size — a loop that throws is visible. */
  errorEvents: 'errorEvents',
  /**
   * SWITCH FLIPS PER BUILD (JOS-109) — how many installs turned usage analytics off, and how many
   * turned it back on. dim = `<version>`, n = flips.
   *
   * The JOS-96 / JOS-57 additive pattern exactly: `usage_daily` has no version COLUMN (the key is
   * day+cohort+metric+dim and cannot grow one — infra/schema.sql), so the version lives in `dim`,
   * which makes these new metric NAMES in a table built to hold arbitrary ones. No schema change,
   * no migration.
   *
   * WHAT THESE TWO NUMBERS CAN AND CANNOT CLAIM, because a counter with a confident name is the
   * easiest thing in this pipeline to misread:
   *
   *   * EXACT, over installs that ever reported. One flip is one event and one event is one
   *     count; a user who flips off, on and off again contributes two `optOuts` and one `optIn`,
   *     which is the truth about what they did rather than a de-duplicated guess at what they
   *     meant. `main/telemetry/optOut.ts` is what makes "one per flip" mechanical.
   *   * BLIND TO THE FULLY-DARK INSTALL. An install that opted out before its first batch never
   *     sends one of these, so `optOuts` is a FLOOR on opt-outs and can never be a rate over
   *     downloads. `shared/telemetry.ts` states that problem where the events are declared, and
   *     the panel prints the two measurements side by side rather than dividing them.
   *   * AN UNDERCOUNT BY ONE MORE MECHANISM, stated so nobody has to rediscover it: the notice is
   *     ONE best-effort POST with no retry (retrying would mean keeping state after the user said
   *     stop), so a flip made while offline is simply never counted.
   *   * NO DENOMINATOR EXISTS, and none is invented. There is no per-session "this build can
   *     report a flip" signal the way `healthReports` is one for errors, so a version with no row
   *     here is genuinely ambiguous between "nobody left" and "this build predates the counter".
   *     The panel renders absence as a dash and says so; it does not render a zero.
   */
  optOuts: 'optOuts',
  /** dim = `<version>`. The counterpart, on a build that re-enabled. Never netted against
   *  `optOuts`: "flips off minus flips on" is not a population, it is two actions subtracted. */
  optIns: 'optIns',
  /** dim = `<step>:ok` / `<step>:failed`. */
  update: 'update',
  /** dim = `<step>:<failureClass>`. */
  updateFailure: 'updateFailure',
  /** dim = `<funnel>:<step>:<failureClass>` — the funnel table has no class column. */
  funnelFailure: 'funnelFailure'
} as const

export type UsageMetric = (typeof USAGE_METRICS)[keyof typeof USAGE_METRICS]

/**
 * HEALTH FIELDS THAT ARE COUNTED BUT ARE NOT ERRORS (JOS-133).
 *
 * `USAGE_METRICS.health` holds one row per field per build, and two readers add those rows up:
 * the fleet-wide Health mix (which wants every field, and shows them by name), and the RELEASE
 * HEALTH error rate (`errors / healthReports` per build — main/triage/releaseHealth.ts), which
 * wants only the fields that mean something went wrong with THIS APP. The two are not the same
 * list, and this is where the difference is written down once.
 *
 * `imageFetchFailures` is the case that forced it. It counts a fully handled condition — a
 * volunteer wiki was unreachable, the image was hidden, the app carried on — and it is the single
 * largest number this app has ever counted (17,632 occurrences in 14 days, roughly two thirds of
 * every error line the fleet reported). Summed into the rate it would swamp every real signal and
 * make "did I release buggy code" unanswerable, and it would move with somebody else's uptime
 * rather than with anything a release could change.
 *
 * IT IS A DENY LIST RATHER THAN AN ALLOW LIST on purpose. A field added later and forgotten here
 * counts as an error — noisy, visible, and fixed by adding a line. The other way round, a
 * forgotten field would silently vanish from the rate, which is the failure this whole section
 * exists to prevent. `suppressedErrorLines` is deliberately NOT here: it counts error lines that
 * a cap withheld from the local file, so leaving it out of the rate would let the cap flatter a
 * build that had started looping.
 */
export const HEALTH_NON_ERROR_FIELDS: readonly string[] = ['imageFetchFailures']

/** Whether a `health` dim's field name is an ERROR for rate purposes. See the list above. */
export function isErrorHealthField(field: string): boolean {
  return !HEALTH_NON_ERROR_FIELDS.includes(field)
}

/**
 * Session-length histogram edges: 1m / 5m / 15m / 30m / 1h / 2h / 4h ⇒ eight buckets.
 *
 * A STORAGE decision, not a wire one — the client sends `durationMs` and the server chooses
 * how coarsely to remember it — which is why these edges live here and not in the contract
 * (nothing in TELEMETRY.md needs to promise them; the number the user sent is the number the
 * payload viewer shows).
 */
export const SESSION_MS_EDGES = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  120 * 60_000,
  240 * 60_000
] as const

/**
 * Startup-replay histogram edges (JOS-57): 0.25 s / 1 s / 2.5 s / 5 s / 10 s / 30 s / 60 s ⇒ eight
 * buckets. STORAGE decisions like `SESSION_MS_EDGES` — the client sends the millisecond it
 * measured and the server chooses how coarsely to remember it, which is why they are here and not
 * in the contract.
 *
 * The spread is where the answers live rather than where the average is: a replay under a second
 * is a small log, and everything the chunked-replay work was ABOUT happens past five seconds.
 */
export const REPLAY_MS_EDGES = [250, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000] as const

/**
 * Worst-single-block edges: 10 / 25 / 50 / 100 / 250 / 500 / 1000 ms ⇒ eight buckets.
 *
 * 50 IS AN EDGE ON PURPOSE — it is the same number `STARTUP_BLOCK_THRESHOLD_MS` (shared/perf.ts)
 * calls a block and the HUD calls "warn", so "which bucket" and "did it count as a block" can
 * never disagree by a millisecond. It is restated rather than imported because this file's whole
 * contract is that it imports `./telemetry` and nothing else (it bundles into the Lambda).
 * 250 and 1000 bracket the two figures a person actually feels: a visible hitch, and a freeze.
 */
export const BLOCK_MS_EDGES = [10, 25, 50, 100, 250, 500, 1_000] as const

/** Milliseconds, or seconds once past a second: `250 ms`, `2.5 s`. */
function msSpan(ms: number): string {
  return ms >= 1_000 ? `${String(Math.round(ms / 100) / 10)} s` : `${String(Math.round(ms))} ms`
}

/** Human range for a bucket index over `edges`, in ms: `1 s–2.5 s`, `60 s+`, `< 250 ms`. */
function msBucketLabel(edges: readonly number[], i: number): string {
  const clamped = Math.max(0, Math.min(i, edges.length))
  if (clamped >= edges.length) return `${msSpan(edges[edges.length - 1])}+`
  if (clamped === 0) return `<${msSpan(edges[0])}`
  return `${msSpan(edges[clamped - 1])}-${msSpan(edges[clamped])}`
}

/** Human range for a `startupReplayMs` bucket index. */
export function replayMsBucketLabel(i: number): string {
  return msBucketLabel(REPLAY_MS_EDGES, i)
}

/** Human range for a `startupBlockMs` bucket index. */
export function blockMsBucketLabel(i: number): string {
  return msBucketLabel(BLOCK_MS_EDGES, i)
}

/** Minutes, or hours once past the hour mark: `15 min`, `2 h`. */
function span(ms: number): string {
  return ms >= 60 * 60_000
    ? `${String(Math.round(ms / 3_600_000))} h`
    : `${String(Math.round(ms / 60_000))} min`
}

/** Human range for a `sessionLenBucket` index: `15 min–30 min`, `4 h+`. */
export function sessionBucketLabel(i: number): string {
  const clamped = Math.max(0, Math.min(i, SESSION_MS_EDGES.length))
  const lo = clamped === 0 ? 0 : SESSION_MS_EDGES[clamped - 1]
  if (clamped >= SESSION_MS_EDGES.length) return `${span(lo)}+`
  return `${clamped === 0 ? '0' : span(lo)}-${span(SESSION_MS_EDGES[clamped])}`
}

/**
 * The bucket index the p-th percentile falls in, or -1 when the histogram is empty.
 *
 * NEAREST-BUCKET, never interpolated INSIDE one: the storage deliberately threw that precision
 * away, so every reader renders the bucket's own RANGE rather than a number that would look
 * exact and be invented. The same reasoning `shared/perf.ts percentile` gives for nearest-rank.
 *
 * A p95 over eight buckets is coarse and is the honest limit of a summable histogram: it answers
 * "the slow tail is in the 10–30 s bucket", which is the question, and refuses "the p95 is
 * 14,208 ms", which the data cannot support.
 */
export function percentileBucket(counts: readonly number[], p: number): number {
  const total = counts.reduce((sum, n) => sum + Math.max(0, n), 0)
  if (total <= 0) return -1
  const want = total * (Math.min(100, Math.max(0, p)) / 100)
  let seen = 0
  for (let i = 0; i < counts.length; i++) {
    seen += Math.max(0, counts[i])
    if (seen >= want) return i
  }
  return counts.length - 1
}

/** The median's bucket index, or -1 when the histogram is empty. `percentileBucket` at p50 —
 *  one implementation, so the session median and the startup percentiles cannot drift apart. */
export function medianBucket(counts: readonly number[]): number {
  return percentileBucket(counts, 50)
}

// ---------------------------------------------------------------- the rollup

export interface UsageCounter {
  metric: string
  dim: string
  n: number
}

export interface FunnelCounter {
  funnel: string
  step: string
  /** `'-'` when the client reported no outcome — the column is NOT NULL and part of the key. */
  outcome: string
  appVersion: string
  n: number
}

/**
 * ONE ROW OF `error_report` (JOS-100) — the one place this pipeline keeps something that is not
 * a bare count, and the exception is deliberate and bounded.
 *
 * T6 refused a raw event store and this does not reopen it: what is kept is at most ONE
 * EXEMPLAR per (day, cohort, version, fingerprint), FIRST WINS, and the exemplar is an event
 * that has already been through `validateTelemetryEvent` — so it is a redacted message, a stack
 * of `out/…` frames and a list of parser event kinds, and there is no field on it a per-user
 * trail could hide in. A hundred installs hitting one bug write one row and add to its count.
 */
export interface ErrorReportRow {
  appVersion: string
  fingerprint: string
  /** Occurrences folded into this row by this batch. */
  n: number
  /** The event to store IF this (day, cohort, version, fingerprint) has none yet. */
  exemplar: EvErrorReport
}

export interface RollupResult {
  counters: UsageCounter[]
  funnels: FunnelCounter[]
  /** Empty for every batch that carries no `errorReport` — which is almost all of them. */
  errors: ErrorReportRow[]
}

/**
 * What the `analytics_install` UPSERT already learned, and the rollup cannot learn for itself.
 * Both facts are per-id-per-day and are the ONLY reason a distinct-install counter is possible
 * without keeping an id anywhere but that one row.
 */
export interface RollupContext {
  /** Is this the first batch this analyticsId has sent today? */
  firstOfDay: boolean
  /** Was the install row created by this batch? */
  newInstall: boolean
  /**
   * Did this batch arrive on a DIFFERENT `appVersion` than the install row was holding?
   *
   * The third fact of exactly the same kind as the two above: it is knowable only from the row
   * the ingest path is already touching, and it is knowable NOWHERE on the client — a build
   * reads its own version and has no memory of the one before it. Asking the client would mean a
   * new event, a schema change, and a number we would then have to trust.
   *
   * False on a brand-new install (there was no previous version to differ from), so
   * `newInstalls` and `upgrades` are disjoint and can be read side by side.
   */
  upgraded: boolean
}

/**
 * The accumulator key is the (metric, dim) PAIR, joined. A space is unambiguous: every legal
 * `dim` is a closed-enum member, a bucket index, a semver, or a colon-joined tuple of those
 * (`<step>:ok`, `<version>:<bucket>`) — none of which can contain one — and the key is never
 * parsed back apart (the counter it points at carries both fields).
 */
const KEY_SEP = ' '

type Bag = Map<string, UsageCounter>

function add(bag: Bag, metric: string, dim: string, n: number): void {
  if (!Number.isFinite(n) || n <= 0) return
  const key = `${metric}${KEY_SEP}${dim}`
  const held = bag.get(key)
  if (held) held.n += n
  else bag.set(key, { metric, dim, n })
}

const flag = (on: boolean): string => (on ? 'on' : 'off')

function foldSetup(bag: Bag, ev: Extract<TelemetryEvent, { t: 'setupSnapshot' }>): void {
  add(bag, USAGE_METRICS.setups, DIM_NONE, 1)
  add(bag, USAGE_METRICS.setupChars, String(ev.charCountBucket), 1)
  add(bag, USAGE_METRICS.setupLogSize, String(ev.logSizeBucket), 1)
  add(bag, USAGE_METRICS.setupAlerts, String(ev.alertCountBucket), 1)
  for (const kind of ev.overlaysEnabled) add(bag, USAGE_METRICS.setupOverlay, kind, 1)
  add(bag, USAGE_METRICS.setupCursorRing, flag(ev.cursorRing), 1)
  add(bag, USAGE_METRICS.setupAutoHide, flag(ev.autoHide), 1)
  add(bag, USAGE_METRICS.setupVoice, ev.voiceEngine, 1)
  add(bag, USAGE_METRICS.setupPacks, DIM_NONE, ev.soundPackCount)
  add(bag, USAGE_METRICS.setupUpdateChannel, ev.updateChannel, 1)
}

/**
 * ONE SESSION'S HEALTH ROLLUP, DIMENSIONED BY BUILD (JOS-96).
 *
 * `healthReports` is written UNCONDITIONALLY and is the denominator; the five field rows are
 * written only when non-zero, because `add()` refuses non-positive values and an absent row reads
 * identically to a zero row TO A SUM. That refusal is what makes a clean session cost one row
 * instead of six — and it is safe here for the same reason it is safe in `foldStartup`: the
 * denominator is always present, so "no error rows on a version that reported" is unambiguously
 * zero errors rather than missing data.
 *
 * The version is an ENVELOPE fact — no event carries its own — so it is threaded in exactly the
 * way `foldSession` threads it for the startup reading.
 */
function foldHealth(
  bag: Bag,
  ev: Extract<TelemetryEvent, { t: 'healthCounters' }>,
  version: string
): void {
  add(bag, USAGE_METRICS.healthReports, version, 1)
  add(bag, USAGE_METRICS.health, `${version}:rendererCrashes`, ev.rendererCrashes)
  add(bag, USAGE_METRICS.health, `${version}:mainErrorLogLines`, ev.mainErrorLogLines)
  add(bag, USAGE_METRICS.health, `${version}:parserStalls`, ev.parserStalls)
  add(bag, USAGE_METRICS.health, `${version}:presenceRestarts`, ev.presenceRestarts)
  add(bag, USAGE_METRICS.health, `${version}:speechFailures`, ev.speechFailures)
  // JOS-133's two, OPTIONAL on the wire (the additive-field rule) and so read through `?? 0` —
  // which needs no special case downstream, because `add()` already refuses a non-positive value
  // and an absent row reads identically to a zero row TO A SUM.
  add(bag, USAGE_METRICS.health, `${version}:imageFetchFailures`, ev.imageFetchFailures ?? 0)
  add(bag, USAGE_METRICS.health, `${version}:suppressedErrorLines`, ev.suppressedErrorLines ?? 0)
}

/**
 * ONE LAUNCH'S STARTUP REPLAY (JOS-57) — the passenger on whichever session report carried it.
 *
 * `startupReplays` is the only row that is always written, and it is the DENOMINATOR: every other
 * number here is a sum, and a sum is meaningless without the count it was summed over. `add()`
 * refuses non-positive values, so a perfectly smooth launch (0 duty, 0 blocks) writes no row for
 * those — an ABSENT row and a zero row read identically to a SUM, which is the property that
 * makes that refusal safe here.
 */
function foldStartup(bag: Bag, s: StartupReplayStats, version: string): void {
  add(bag, USAGE_METRICS.startupReplays, version, 1)
  add(bag, USAGE_METRICS.startupReplayMs, `${version}:${String(bucketOf(s.replayMs, REPLAY_MS_EDGES))}`, 1)
  add(bag, USAGE_METRICS.startupBlockMs, `${version}:${String(bucketOf(s.maxBlockMs, BLOCK_MS_EDGES))}`, 1)
  add(bag, USAGE_METRICS.startupDutyPct, version, s.dutyPct)
  add(bag, USAGE_METRICS.startupBlocksOver50, version, s.blocksOver50)
  add(bag, USAGE_METRICS.startupEventsReplayed, version, s.eventsReplayed)
  add(bag, USAGE_METRICS.startupLogSize, String(s.logSizeBucket), 1)
}

/**
 * The three session events, split out of `foldEvent` so neither switch is past the repo's
 * complexity ceiling. Returns whether it handled the event — the caller's `switch` then covers
 * exactly the kinds this one does not, and a new event kind still fails to compile in one of
 * them (both are exhaustive over the union).
 *
 * It takes the batch's `appVersion` because two of the three kinds can carry a startup reading,
 * and that reading is dimensioned by version (see `USAGE_METRICS.startupReplays`). The version is
 * an ENVELOPE fact, not an event one — no event carries its own — so it has to be threaded here.
 */
function foldSession(bag: Bag, ev: TelemetryEvent, version: string): boolean {
  switch (ev.t) {
    case 'sessionStart':
      add(bag, USAGE_METRICS.sessions, DIM_NONE, 1)
      add(bag, USAGE_METRICS.coldStartBucket, String(ev.coldStartMsBucket), 1)
      return true
    case 'sessionHeartbeat':
      add(bag, USAGE_METRICS.heartbeats, DIM_NONE, 1)
      add(bag, USAGE_METRICS.linesParsed, DIM_NONE, ev.linesParsed ?? 0)
      if (ev.startup !== undefined) foldStartup(bag, ev.startup, version)
      return true
    case 'sessionEnd':
      add(bag, USAGE_METRICS.sessionEnds, DIM_NONE, 1)
      add(bag, USAGE_METRICS.sessionMsTotal, DIM_NONE, ev.durationMs)
      add(bag, USAGE_METRICS.sessionLenBucket, String(bucketOf(ev.durationMs, SESSION_MS_EDGES)), 1)
      add(bag, USAGE_METRICS.linesParsed, DIM_NONE, ev.linesParsed ?? 0)
      if (ev.startup !== undefined) foldStartup(bag, ev.startup, version)
      return true
    default:
      return false
  }
}

/**
 * The two events that carry an OUTCOME — an update step and a funnel step. Split out for the
 * same reason `foldSession` is: three of the union's eleven kinds carry conditional fields, and
 * one switch over all eleven is past the repo's complexity ceiling.
 */
function foldOutcome(bag: Bag, ev: TelemetryEvent): boolean {
  if (ev.t === 'updateOutcome') {
    add(bag, USAGE_METRICS.update, `${ev.step}:${ev.ok ? 'ok' : 'failed'}`, 1)
    if (ev.failureClass !== undefined) {
      add(bag, USAGE_METRICS.updateFailure, `${ev.step}:${ev.failureClass}`, 1)
    }
    return true
  }
  if (ev.t !== 'funnelStep') return false
  // A funnel step's STEPS go to the funnel table (foldFunnels); only its failure class lands
  // here, because `usage_funnel_daily`'s key has no column for one.
  if (ev.failureClass !== undefined) {
    add(bag, USAGE_METRICS.funnelFailure, `${ev.funnel}:${ev.step}:${ev.failureClass}`, 1)
  }
  return true
}

/**
 * The error rows for one batch, folded by (version, fingerprint) — FIRST EXEMPLAR WINS, which
 * is the same rule the UPSERT applies at the row and for the same reason: two reports of one
 * issue are one issue, and the first one to arrive is as good an example as the second.
 *
 * Deterministic order (the key's own sort), like `foldFunnels`, so the handler's multi-row
 * statement is reproducible and this file stays testable without a database.
 */
function foldErrors(records: readonly TelemetryRecord[], appVersion: string): ErrorReportRow[] {
  const bag = new Map<string, ErrorReportRow>()
  for (const { ev } of records) {
    if (ev.t !== 'errorReport') continue
    const held = bag.get(ev.fingerprint)
    if (held) held.n += ev.count
    else bag.set(ev.fingerprint, { appVersion, fingerprint: ev.fingerprint, n: ev.count, exemplar: ev })
  }
  return [...bag.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v)
}

/**
 * THE TWO SWITCH-FLIP EVENTS (JOS-109), split out for exactly the reason `foldSession` and
 * `foldOutcome` were: `foldEvent`'s one switch would otherwise be past the repo's complexity
 * ceiling, and the answer to that here is a helper, not a widened threshold.
 *
 * Both are one row and nothing else — a flip has no payload to fold — and both are dimmed by the
 * build that was running when the user reached for the switch, which is the only version the
 * question "did the build I shipped make people leave" can be about.
 */
function foldFlip(bag: Bag, ev: TelemetryEvent, version: string): boolean {
  if (ev.t === 'optOut') {
    add(bag, USAGE_METRICS.optOuts, version, 1)
    return true
  }
  if (ev.t !== 'optIn') return false
  add(bag, USAGE_METRICS.optIns, version, 1)
  return true
}

/** One event's contribution. TOTAL: a kind with nothing to count simply adds nothing. */
function foldEvent(bag: Bag, ev: TelemetryEvent, version: string): void {
  if (foldSession(bag, ev, version) || foldOutcome(bag, ev) || foldFlip(bag, ev, version)) return
  switch (ev.t) {
    case 'viewDwell':
      add(bag, USAGE_METRICS.viewVisits, ev.view, 1)
      add(bag, USAGE_METRICS.viewDwellMs, ev.view, ev.ms)
      return
    case 'overlayToggle':
      add(bag, ev.open ? USAGE_METRICS.overlayOpen : USAGE_METRICS.overlayClose, ev.kind, 1)
      return
    case 'featureUse':
      add(bag, USAGE_METRICS.featureUse, ev.feature, ev.count)
      return
    case 'alertFired':
      add(bag, USAGE_METRICS.alertsFired, DIM_NONE, ev.count)
      add(bag, USAGE_METRICS.alertsSpoken, DIM_NONE, ev.spokenCount)
      return
    case 'setupSnapshot':
      foldSetup(bag, ev)
      return
    case 'healthCounters':
      foldHealth(bag, ev, version)
      return
    case 'errorReport':
      // The COUNTERS half only. The per-fingerprint rows are `foldErrors`, which needs the
      // whole record list rather than one event at a time (first exemplar wins).
      add(bag, USAGE_METRICS.errors, version, ev.count)
      add(bag, USAGE_METRICS.errorEvents, version, 1)
      return
    default:
      // The session kinds, the two outcome kinds and the two flip kinds, already folded by the
      // three helpers above.
      return
  }
}

/** The envelope facts, counted ONCE per active install per day. See the header. */
function foldEnvelope(bag: Bag, batch: TelemetryBatch): void {
  add(bag, USAGE_METRICS.activeInstalls, DIM_NONE, 1)
  add(bag, USAGE_METRICS.version, batch.env.appVersion, 1)
  add(bag, USAGE_METRICS.channel, batch.env.channel, 1)
  add(bag, USAGE_METRICS.platform, batch.env.platform, 1)
  add(bag, USAGE_METRICS.tzOffset, String(batch.env.tzOffsetBucket), 1)
}

function foldFunnels(records: readonly TelemetryRecord[], appVersion: string): FunnelCounter[] {
  const bag = new Map<string, FunnelCounter>()
  for (const { ev } of records) {
    if (ev.t !== 'funnelStep') continue
    const outcome = ev.outcome ?? DIM_NONE
    const key = [ev.funnel, ev.step, outcome].join(KEY_SEP)
    const held = bag.get(key)
    if (held) held.n += 1
    else bag.set(key, { funnel: ev.funnel, step: ev.step, outcome, appVersion, n: 1 })
  }
  return [...bag.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v)
}

/**
 * ONE validated batch → the rows the ingest handler UPSERTs. Pure and deterministic: the same
 * batch always yields the same rows in the same order, which is what makes the handler's
 * multi-row UPSERT reproducible and this file testable without a database.
 *
 * The funnel FAILURE CLASS is folded into `usage_daily` rather than the funnel table: plan §4
 * keys that table on (day, funnel, step, outcome, appVersion), and adding a sixth key column
 * to carry a rarely-set coarse enum would multiply every funnel row for one field.
 */
export function rollupBatch(batch: TelemetryBatch, ctx: RollupContext): RollupResult {
  const bag: Bag = new Map()
  if (ctx.firstOfDay) foldEnvelope(bag, batch)
  if (ctx.newInstall) add(bag, USAGE_METRICS.newInstalls, DIM_NONE, 1)
  // Counted ONCE per version change, and that is a property of the statement that hands this
  // fact over rather than of a flag here: the same UPSERT writes the new version, so the very
  // next batch from this install sees no difference to report.
  if (ctx.upgraded) add(bag, USAGE_METRICS.upgrades, DIM_NONE, 1)
  for (const { ev } of batch.events) foldEvent(bag, ev, batch.env.appVersion)
  const counters = [...bag.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => v)
  return {
    counters,
    funnels: foldFunnels(batch.events, batch.env.appVersion),
    errors: foldErrors(batch.events, batch.env.appVersion)
  }
}

/** The UTC day a row is keyed on. ARRIVAL day, never the client's clock (which can lie). */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}
