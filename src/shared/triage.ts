// ============================================================================
// TRIAGE CONTRACT — the shapes the DEV-ONLY triage tab moves across IPC.
// ============================================================================
//
// This file is the seam between `src/main/triage/**` (which talks to Aurora DSQL and S3 over
// the launching shell's AWS profile) and `src/renderer/src/features/triage/**` (which renders
// what it is handed and fetches nothing itself — the renderer never reaches the network, and
// the CSP is untouched by this feature).
//
// WHY THE SHAPES LIVE HERE AND NOT IN `src/main/triage`: the renderer names every one of them
// and cannot import from `src/main` under either tsconfig. Same reasoning, same placement as
// `src/shared/feedback.ts`'s IPC-crossing block.
//
// PURE, like every other `src/shared/**` module: zero imports beyond the feedback contract's
// own type unions, no `node:`, no Electron, no DOM.
//
// THE LAW (docs/plans/feedback-triage.md §10.3) applies to everything here: a raw log slice
// never reaches anything public. `TriageSlice.lines` travels main -> renderer over IPC and is
// rendered in a local window; it is never written to a file the app publishes, never put in an
// issue body, and only ever exists in a build that has the dev flag compiled in.

import type {
  AppChannelTag,
  FeedbackType,
  ReportStatus,
  Severity
} from './feedback'

// ---- filters --------------------------------------------------------------------------

export type TriageChannelFilter = AppChannelTag | 'all'

/** Every field is re-validated AT THE HANDLER — `since` reaches `parseSince`, `limit` reaches
 *  a SQL `LIMIT`, and the two unions reach a WHERE clause. */
export interface TriageListQuery {
  channel: TriageChannelFilter
  /** `7d` / `12h` / `30m` / an ISO date — the CLI's own `--since` grammar. */
  since: string
  limit: number
  status?: ReportStatus
  type?: FeedbackType
}

/** The list's `since` choices, so the toolbar and the validator cannot disagree. */
export const TRIAGE_SINCE_CHOICES = ['24h', '7d', '30d', '90d', '365d'] as const
export const TRIAGE_LIMIT_MAX = 500
export const TRIAGE_DEFAULT_QUERY: TriageListQuery = {
  channel: 'all',
  since: '30d',
  limit: 200
}

// ---- rows -----------------------------------------------------------------------------

/**
 * Whether this report has a log slice, and whether it actually LANDED.
 *
 * TRI-STATE ON PURPOSE. `declared` means the report row carries slice metadata; whether the
 * presigned upload ever completed is a separate fact that costs one HeadObject to learn, so
 * the LIST reports `none | declared` (no per-row round trip) and the DETAIL upgrades it to
 * `present | missing`. Collapsing the two would make "the upload failed or expired" — a real
 * case the CLI prints — indistinguishable from a healthy attachment.
 */
export type TriageLogState = 'none' | 'declared' | 'present' | 'missing'

/** One row of the Reports table. The description IS the report: `title` and `contact` were
 *  retired from the wire contract and then dropped from the schema, so there is nothing here
 *  for a list to leak (the same rule `TriageReport` in scripts/triageCluster.mts obeys). */
export interface TriageRow {
  reportId: string
  type: FeedbackType
  description: string
  appVersion: string
  platform: string
  channel: AppChannelTag
  status: ReportStatus
  severity?: Severity
  cluster?: string
  spamScore: number
  receivedAt: number
  triagedAt?: number
  /** `none` or `declared` here — the list never pays for a HeadObject. */
  log: TriageLogState
}

/** The full record behind one row. There is no `contact`: the column is gone from the schema,
 *  so the detail pane has nothing extra to show and `forget` has nothing extra to clear. */
export interface TriageDetail {
  row: TriageRow
  installId: string
  clientTs: number
  /** `env_json`, parsed. TEXT-holding-JSON in the schema, so the parse is total: an
   *  unparseable blob yields `{}` rather than throwing across IPC. */
  env: Record<string, string>
  dupeOf?: string
  issueUrl?: string
  note?: string
  /** Stamped by `forget`: this report's log slice was destroyed on request. */
  redactedAt?: number
  logKey?: string
  /** From `log_json` — what the client SAID it uploaded. */
  logBytes?: number
  logLines?: number
  /** Resolved against S3: `present` or `missing` when a key exists, else `none`. */
  log: TriageLogState
}

/** The triage-only writes. Mirrors the CLI's `set` flags exactly. */
export interface TriagePatch {
  status?: ReportStatus
  severity?: Severity
  cluster?: string
  dupeOf?: string
  note?: string
}

// ---- the log slice --------------------------------------------------------------------

/**
 * A downloaded, gunzipped slice, CAPPED for the bridge. The bytes are fetched in main, cached
 * under `.triage/slices/` (gitignored twice over) and only `lines` crosses IPC — the same
 * discipline `feedback:buildSlice` uses for the outbound preview, and for the same reason: a
 * multi-megabyte string does not belong on the bridge.
 */
export interface TriageSlice {
  reportId: string
  lines: string[]
  /** True when the slice holds more than `lines` shows — `totalLines` is the real count. */
  truncated: boolean
  totalLines: number
  /** Where the cached copy lives on this machine. Local, gitignored, never published. */
  path: string
  /**
   * THE RE-SCRUB DELTA (src/main/triage/store.ts `downloadSlice`). The presign policy pins an
   * upload's key, size and type — it cannot pin its CONTENT, so the downloaded bytes are run
   * through the SHARED scrubber and the SHARED text sanitizer before they reach the owner's
   * disk. These two counts are what that pass removed:
   *
   *   * `rescrubDropped` — third-party chat/social lines. Zero for an honest client, because an
   *     honest client already ran the identical module. Non-zero is EVIDENCE that the
   *     client-side scrub was skipped or bypassed, and the UI says so out loud.
   *   * `rescrubCleaned` — lines that carried control characters or ANSI escape sequences.
   *
   * `rescrubUnknown` marks a copy cached BEFORE this pass existed: its counts were never
   * recorded, and claiming zeros for it would be asserting something we did not measure.
   */
  rescrubDropped: number
  rescrubCleaned: number
  rescrubUnknown: boolean
}

// ---- ops ------------------------------------------------------------------------------

/**
 * The kill switch, stated POSITIVELY.
 *
 * The CLI spells this as `closed on|off`, which is a double negative once it reaches
 * `setAccepting(state === 'off')`. The UI owns one polarity — `accepting` — and its label says
 * so, because an inverted kill switch is the single worst bug this panel could ship.
 */
export interface TriageOpsState {
  accepting: boolean
  closedMessage: string
  maxPerInstallPerDay: number
  blocked: TriageBlockedInstall[]
}

export interface TriageBlockedInstall {
  installId: string
  blocked: boolean
  reason?: string
  blockedAt?: number
}

// ---- digest ---------------------------------------------------------------------------

/** Structurally identical to `Cluster` in scripts/triageCluster.mts, restated here because the
 *  renderer cannot import from `scripts/` under tsconfig.web. Main passes those values through. */
export interface TriageClusterView {
  id: string
  kind: 'crash' | 'tokens'
  signature?: string
  reportIds: string[]
  types: FeedbackType[]
  versions: string[]
  regression: boolean
  withLogs: number
  label: string
}

export interface TriageDigest {
  /** Exactly what `triage-feedback digest` prints — the same `renderDigest` call. */
  markdown: string
  clusters: TriageClusterView[]
  reportCount: number
}

// ---- analytics (usage telemetry — docs/plans/usage-analytics.md A3) ---------------------
//
// THE SHAPE IS WHAT THE TABLES CAN ACTUALLY ANSWER, and nothing more. Every field below is
// derivable from `usage_daily` + `usage_funnel_daily` + `analytics_install`; the numbers the
// plan asked for that are NOT derivable from anonymous daily counters are absent rather than
// approximated silently:
//
//   * per-feature REACH % (share of installs that used a feature) would need per-id,
//     per-feature state — the per-user trail T6 refuses to keep. `uses` and `perSession` are
//     what the counters can say, and the panel labels them as such.
//   * MEDIAN session length is a BUCKET RANGE (`medianSessionLabel`), because a median cannot
//     be summed across days; the ingest path keeps a histogram precisely so this is answerable
//     at all, and it is answerable to a bucket, not to a millisecond.
//   * RETENTION is survival: "first seen on day D and still seen on or after D+N", read off
//     `analytics_install`. It is not "came back ON day D+N" — no per-day-per-id row exists.
//
// `available: false` means exactly ONE class of thing: this cluster does not have what this
// code reads — a table the A2 migration creates, or the `cohort` column the user/owner split
// added. Tables that exist and are EMPTY render as honest zeros with a "no data yet" note — an
// empty stack is a real, informative state and hiding it behind the same arm as "not deployed"
// would make the two indistinguishable.
//
// THE USER/OWNER SPLIT IS AT THIS LEVEL, not inside `TriageAnalyticsData`. `data` is ALWAYS the
// user cohort — the population question, which is what the panel and the digest are for — and
// `owner` is a SECOND, COMPLETE readout rendered beside it when asked for. Two values rather
// than a cohort field on every row, because that shape makes summing them require writing code
// that adds two `TriageAnalyticsData`s together, which nobody will ever accidentally do.

/** One point of a daily series. `day` is the UTC `yyyy-mm-dd` key the counters are stored on. */
export interface UsageDayPoint {
  day: string
  n: number
}

export interface TriageAnalyticsPulse {
  /** Installs seen on the most recent day IN THE WINDOW that has any data. */
  dau: number
  /** Distinct installs whose `last_seen_day` is within 7 / 30 days of that day. */
  wau: number
  mau: number
  /** Every `analytics_install` row — the all-time footprint, not a window. */
  installsTotal: number
  /**
   * TODAY, in UTC, and today is the CLOCK's day rather than the window's last day with data —
   * unlike DAU beside it, which anchors on the last day anything arrived. "Installs today" that
   * silently meant "installs on the last day we heard anything" would read as a live number and
   * be a stale one; a true zero is the honest answer to a quiet morning.
   */
  installsToday: number
  /** Installs that reported a different build than they were last on, today. Server-derived. */
  upgradesToday: number
  /**
   * Log lines this fleet parsed IN THE WINDOW. Counts parsing work, not distinct lines: the
   * startup replay re-reads a character's history every launch and TELEMETRY.md says so.
   */
  linesParsed: number
  sessions: number
  sessionsPerDay: number
  /** From the `sessionMsTotal` / `sessionEnds` pair. Null when no session has ended yet. */
  meanSessionMs: number | null
  /** A RANGE (`15 min–30 min`), never a fake exact number. Null when the histogram is empty. */
  medianSessionLabel: string | null
  activeSeries: UsageDayPoint[]
  sessionSeries: UsageDayPoint[]
}

export interface TriageFeatureRow {
  id: string
  uses: number
  /** Uses per session in the window — the honest stand-in for reach. */
  perSession: number
}

export interface TriageViewRow {
  id: string
  dwellMs: number
  visits: number
  /** This view's share of all dwell time, 0..1. */
  share: number
}

export interface TriageMixRow {
  id: string
  n: number
}

export interface TriageAnalyticsAdoption {
  features: TriageFeatureRow[]
  views: TriageViewRow[]
  /** Overlay opens by kind, voice-engine mix and cursor-ring/auto-hide from setupSnapshot. */
  overlays: TriageMixRow[]
  voice: TriageMixRow[]
  cursorRing: TriageMixRow[]
  autoHide: TriageMixRow[]
  alertsFired: number
  alertsSpoken: number
}

export interface TriageFunnelStepRow {
  step: string
  n: number
  /** Share of the FIRST step that reached this one, 0..1. */
  conversion: number
  /** Share of the PREVIOUS step lost here, 0..1. */
  dropOff: number
}

export interface TriageFunnelView {
  funnel: string
  steps: TriageFunnelStepRow[]
  /** The same curve per app version — where a regression shows up as a changed drop-off. */
  byVersion: { version: string; steps: TriageFunnelStepRow[] }[]
  /** `<step>:<failureClass>` counts, from `usage_daily`. */
  failures: TriageMixRow[]
}

export interface TriageUpdateRow {
  step: string
  ok: number
  failed: number
  /** ok / (ok + failed), or null when the step was never reported. */
  rate: number | null
}

export interface TriageAnalyticsHealth {
  /** Per error class, from `healthCounters`. */
  errors: TriageMixRow[]
  /** How many per-session health rollups arrived — the denominator for the row above. */
  reports: number
  update: TriageUpdateRow[]
  updateFailures: TriageMixRow[]
}

/**
 * ONE BUILD'S STARTUP REPLAY, as the fleet measured it (JOS-57).
 *
 * PERCENTILES ARE BUCKET RANGES, not numbers, and for exactly the reason `medianSessionLabel` is
 * one: the storage is a histogram, so a p95 rendered as `14,208 ms` would be a precision the data
 * never had. `2.5 s–5 s` is what a summable counter can honestly say.
 *
 * EVERYTHING HERE IS PER VERSION because the question the measurement exists for is a COMPARISON:
 * the chunked replay and its duty cycle were tuned on one machine, and "did the build that shipped
 * them make launches better" can only be read across builds. A fleet-wide average would smear the
 * change across the releases either side of it.
 */
export interface TriageStartupRow {
  version: string
  /** Launches that reported a replay on this build — the denominator for every mean below. */
  launches: number
  /** p50 / p95 of how long the startup replay took, as bucket ranges. Null when nothing reported. */
  p50ReplayLabel: string | null
  p95ReplayLabel: string | null
  /** p50 / p95 of the WORST single main-loop block during that replay, as bucket ranges. */
  p50BlockLabel: string | null
  p95BlockLabel: string | null
  /** Mean ACHIEVED duty, 0..1 — measured by the slicer, never the setting it aimed at. */
  dutyAchieved: number | null
  /** Mean log events folded per launch. Null when nothing reported. */
  meanEventsReplayed: number | null
  /** Total main-loop stalls of 50 ms or more, across those launches. */
  blocksOver50: number
}

export interface TriageAnalyticsStartup {
  /** One row per build that reported, newest first and capped. */
  byVersion: TriageStartupRow[]
  /**
   * How big the measured fleet's logs are — bucket LABELS, never sizes. It is not split by version
   * (a log's size is a fact about the player, not the build) and it is the context the rows above
   * are read in: a build whose p95 rose may simply have been run on bigger logs.
   */
  logSizes: TriageMixRow[]
}

export interface TriageVersionRow {
  version: string
  /** Installs currently ON this version (`analytics_install.app_version`). */
  installs: number
  /** Peak share of daily active installs this version reached, 0..1. */
  peakShare: number
  firstSeenDay: string | null
  /** The first day this version was more than half of that day's active installs. */
  majorityDay: string | null
  /** firstSeenDay → majorityDay, in days. Null while it has never reached a majority. */
  daysToAdopt: number | null
}

/**
 * ONE PUBLISHED RELEASE'S DOWNLOAD COUNTS, read off the public GitHub releases API.
 *
 * IT IS NOT AN INSTALL COUNT, and every label that renders it says so. The auto-updater fetches
 * the installer asset again on every install it updates, so `download_count` is dominated by the
 * fleet updating ITSELF — v0.5.0 took 61 downloads within hours of publication, from a fleet
 * nowhere near that size. `analytics_install` (the readout's "installs all-time") is the install
 * truth; this is a fetch count that happens to be public.
 */
export interface TriageDownloadRow {
  /** The release tag, e.g. `v0.5.0`. */
  tag: string
  /** The `.exe` installer asset(s) only — latest.yml and .blockmap fetches are excluded. */
  exeDownloads: number
  /** Every asset on the release, installer and update metadata alike. */
  totalDownloads: number
  /** ISO timestamp, or null for a release GitHub reported without one. */
  publishedAt: string | null
}

/**
 * GitHub's answer, or why there is not one. UNAVAILABLE IS A QUIET STATE, NEVER AN ERROR: the
 * readout is a view over the cluster, and an unreachable github.com or a spent rate limit must
 * not take it down with it — the section says the reason and everything else renders as usual.
 */
export type TriageDownloads =
  | { available: true; releases: TriageDownloadRow[]; fetchedAtMs: number }
  | { available: false; reason: string }

/**
 * WHO IS IN THE APP RIGHT NOW — the one number in this whole readout that does not come from the
 * counter tables, because they cannot answer it: `usage_daily` is keyed on a DAY, and "right now"
 * is not a day.
 *
 * ITS SOURCE IS THE CloudWatch EMF METRIC `EQCompanion/Telemetry · Heartbeats` (Channel=prod),
 * which the ingest Lambda emits per accepted batch. One heartbeat per open session per five
 * minutes, so the Sum over a 300-second period IS the number of sessions that were alive in it.
 * Deliberately channel-split rather than cohort-split (a CloudWatch metric's identity is its
 * dimension set; adding Cohort would orphan every dashboard widget).
 *
 * THE AGE IS AN ESTIMATE AND IS LABELLED ONE, everywhere it is rendered. Nothing anywhere knows
 * when an individual session started — that would need the per-id, per-session trail this design
 * refuses to keep — so it is derived from how far back the heartbeat count has been sustained:
 * a session alive for N buckets contributes a heartbeat to each of them, so the number of
 * sessions alive now that were ALSO alive j buckets ago is at most `min(now, then)`, and summing
 * that over j gives a mean age in buckets. It is a FLOOR whenever the lookback window is fully
 * occupied (`ageIsFloor`), because a session older than the window is only counted as far back as
 * the window reaches.
 */
export type TriageLiveSessions =
  | {
      available: true
      /** Sessions alive in the last COMPLETE 5-minute bucket. Zero is a real answer. */
      activeNow: number
      /** End of that bucket, ms — what "now" actually means in this number. */
      asOfMs: number
      /** ESTIMATED mean age of those sessions, ms. Null when nothing is alive to have an age. */
      avgAgeMs: number | null
      /** The estimate hit the end of the lookback: `avgAgeMs` is a floor, not a mean. */
      ageIsFloor: boolean
      /** How far back the derivation could see. */
      lookbackMs: number
    }
  | { available: false; reason: string }

export interface TriageCohortRow {
  cohortDay: string
  installs: number
  /** Still seen on or after cohortDay + N. Null while the cohort is younger than N days. */
  d1: number | null
  d7: number | null
  d30: number | null
}

// ---- release health (JOS-96) ------------------------------------------------------------
//
// "DID I RELEASE BUGGY CODE" — an error rate per build, over time, read against how many people
// were actually ON that build and when it went out. Four sources, and they are deliberately
// different KINDS of evidence rather than four columns of the same thing:
//
//   * ERRORS come from `health` / `healthReports`, both dimmed by version (telemetryRollup.ts).
//     The rate is self-normalizing at one version, so a popular build cannot look buggier than
//     an unpopular one purely by having more sessions.
//   * ADOPTION comes from the `version` envelope fact, which EVERY client has always sent —
//     which is why the adoption curve is complete back through history while the error curve
//     starts the day a capable client shipped.
//   * RELEASE DATES come from `RELEASE_NOTES` (shared/releaseNotes.ts): committed source,
//     reviewed in the diff that ships it, available offline. Not a GitHub fetch.
//   * BUG REPORTS come from the feedback `report` table's `app_version` — a bug-rate proxy that
//     covers EVERY version ever shipped, including the ones that predate health reporting. It is
//     the only honest signal about those builds, and it is a different measurement (a human
//     bothered to type something) that must never be added to the error counts.
//
// THE HOUSE RULE, and it is the reason half these fields exist: A QUIET VERSION IS NOT A CLEAN
// ONE. A build that predates the emitting client sends no health report at all, so its error
// count is absent — identical, to a SUM, to a build that reported perfectly and found nothing.
// Every shape below keeps those two apart: `reporting` is a first-class field, the rate is
// `null` rather than 0 when nothing reported, and `coverage` says what share of the fleet is on
// builds that can report at all, so the reader can see how much of the picture is missing.

/** One build's numbers ON ONE DAY — the graph's vertices. */
export interface TriageReleaseHealthDay {
  day: string
  /** Health rollups received from this build that day. 0 ⇒ this build said nothing that day. */
  reports: number
  /** All five error fields summed, from this build, that day. */
  errors: number
  /** errors / reports, or NULL when reports is 0 — unknown, never a zero rate. */
  rate: number | null
  /** Installs seen on this build that day (`version`), and its share of that day's actives. */
  active: number
  share: number
}

export interface TriageReleaseHealthVersion {
  version: string
  /**
   * The release's committed date (`RELEASE_NOTES`), or null for a build with no note — a dev
   * build, or a version this build of the app is too old to have heard of.
   */
  releaseDate: string | null
  /**
   * DID ANY CLIENT ON THIS BUILD EVER SEND A HEALTH REPORT IN THE WINDOW? The whole
   * not-reporting / zero distinction hangs off this one boolean, and it is derived from the
   * DENOMINATOR (`healthReports` at this version), never from the error counts — a build with
   * zero errors is exactly the case that must still read as reporting.
   */
  reporting: boolean
  reports: number
  errors: number
  /** errors / reports over the window. NULL when `reporting` is false. */
  rate: number | null
  /** Per error class, prefix already stripped: `rendererCrashes`, `mainErrorLogLines`, … */
  byField: TriageMixRow[]
  /** Feedback bug reports filed FROM this build in the window. Never summed with `errors`. */
  bugReports: number
  /** Peak share of daily active installs this build reached in the window, 0..1. */
  peakShare: number
  /** Aligned to `TriageAnalyticsData.days` — dense, so a quiet day is a zero and not a gap. */
  days: TriageReleaseHealthDay[]
  /**
   * TOP ISSUES ON THIS BUILD (JOS-100), most frequent first, capped at `MAX_TOP_ISSUES`.
   *
   * This is the half `errors` cannot be: a count says the build is broken, an issue says HOW.
   * Empty on a build that reported and found nothing wrong — and also empty on a build too old
   * to send error reports at all, which is why the panel keys its "not reporting" wording off
   * `reporting` and never off this list being short.
   */
  topIssues: TriageReleaseIssue[]
}

/**
 * ONE ISSUE — a fingerprint, what it cost, and one example of it.
 *
 * The exemplar is carried through to the renderer AS THE VALIDATED EVENT it was stored as. It
 * crosses the bridge whole rather than being flattened into a string here for one reason: the
 * panel offers to VIEW it, and a reader looking at a crash wants the frames and the breadcrumbs
 * in the shape the client sent them, not a rendering of them somebody chose in advance.
 */
export interface TriageReleaseIssue {
  fingerprint: string
  /** Occurrences over the window, summed across days. */
  count: number
  /** First and last DAY this fingerprint was seen on this version, within the window. */
  firstSeen: string
  lastSeen: string
  /** `TypeError`, and the redacted message — the two lines a list row shows. */
  errorName: string
  redactedMessage: string
  /**
   * The stored exemplar, or null when the row predates it / could not be parsed. A row with a
   * count and no example is still worth listing: "this fires 400 times and we lost the sample"
   * is a fact, and hiding the row would make the count disappear with it.
   */
  exemplar: TriageErrorExemplar | null
}

/** As much of a stored `errorReport` as the panel renders. Structurally `EvErrorReport`, spelled
 *  here because `shared/triage.ts` is the bridge's own vocabulary and a stored row is data, not
 *  a live event — a future schema change to the event must not silently change this contract. */
export interface TriageErrorExemplar {
  errorName: string
  code?: string
  redactedMessage: string
  frames: { file: string; line: number; col: number; func: string }[]
  /** `capture` when `frames` names the site that CAUGHT the error rather than the site that threw
   *  it (JOS-111). Absent on a row stored before the field existed, which means `thrown`. */
  frameOrigin?: string
  /** Node/Electron/dependency frames the throw passed through, when it had any (JOS-111). */
  externalFrames?: { file: string; line: number; col: number; func: string }[]
  /** The React components the error came through, innermost first (JOS-111). */
  componentPath?: string
  breadcrumbs: { kind: string; offsetMs: number }[]
  view: string
  sessionAgeBucket: number
  mode: string
}

/** How many issues a version's row lists. Enough to see the shape of a bad release, few enough
 *  that the section stays a summary — the CLI is where an exhaustive list belongs. */
export const MAX_TOP_ISSUES = 5

/** One day's answer to "how much of the fleet could have told us if something was wrong". */
export interface TriageReleaseCoverageDay {
  day: string
  /** Active installs that day on builds that reported health in the window. */
  covered: number
  /** Active installs that day, all builds. */
  active: number
  /** covered / active, or null on a day with no actives at all. */
  share: number | null
}

export interface TriageAnalyticsReleaseHealth {
  /** Newest build first, capped. Includes NON-reporting builds — that is the point. */
  versions: TriageReleaseHealthVersion[]
  /** Per-day reporting coverage, aligned to the window. */
  coverage: TriageReleaseCoverageDay[]
  /** Window-wide coverage: covered install-days / all install-days. Null when nothing was active. */
  coverageShare: number | null
  /**
   * Has ANY build reported health in this window? False is the pre-rollout state and gets its own
   * sentence in the panel — it means the whole error curve is missing, not that the fleet is
   * healthy, and it is the single most misreadable state this section has.
   */
  anyReporting: boolean
}

/** One build's switch flips. Absent from the list entirely when that build reported none. */
export interface TriageCoverageVersion {
  version: string
  /** Installs on this build that turned analytics OFF, in the window. */
  optOuts: number
  /** …and back on. NEVER netted against `optOuts`: two actions, not a balance. */
  optIns: number
}

/**
 * HOW MUCH OF THE FLEET THIS PIPELINE CAN SEE (JOS-109) — the one section whose subject is the
 * limits of every other section.
 *
 * TWO MEASUREMENTS, NEVER CONFLATED, and `src/main/triage/coverage.ts` carries the full argument:
 *
 *   * the FLIP counts are EXACT over installs that ever reported, and are a FLOOR on opt-outs
 *     (an install that went dark before its first batch is invisible by definition, and a flip
 *     made offline is never retried);
 *   * the DARK COHORT is an ESTIMATE and lives outside this shape entirely — it is the
 *     comparison between `reportingInstalls` here and `TriageDownloads` merged at the IPC edge.
 *     The two are printed side by side and NEVER subtracted: a download is not an install.
 */
export interface TriageAnalyticsCoverage {
  /** Distinct installs that have EVER sent a batch (`analytics_install` rows). ALL-TIME, not
   *  windowed — unlike every count beside it, which is why the panel labels both spans. */
  reportingInstalls: number
  /** Flips to OFF in the window, all builds. */
  optOuts: number
  /** Flips back ON in the window, all builds. */
  optIns: number
  /** Per build, newest first. Capped, and lists ONLY builds that reported a flip. */
  byVersion: TriageCoverageVersion[]
  /**
   * Has ANY build reported a flip in this window?
   *
   * FALSE IS AMBIGUOUS AND THE PANEL SAYS SO. There is no per-version "this build can report a
   * flip" denominator (nothing emits one unless somebody flips), so "no flips" and "no client old
   * enough to tell us" are the same absence here. It is the most misreadable state this section
   * has, and it is rendered as a sentence rather than as a zero.
   */
  anyFlips: boolean
}

export interface TriageAnalyticsData {
  windowDays: number
  /** The day keys the window covers, ascending — the x-axis every series is aligned to. */
  days: string[]
  /** True when every table exists and none of them had a row in the window. */
  empty: boolean
  pulse: TriageAnalyticsPulse
  adoption: TriageAnalyticsAdoption
  funnels: TriageFunnelView[]
  health: TriageAnalyticsHealth
  /** How the fleet's launches actually went — the startup replay, per build (JOS-57). */
  startup: TriageAnalyticsStartup
  /** Error rate per build over time, against adoption and release dates (JOS-96). */
  releaseHealth: TriageAnalyticsReleaseHealth
  /** What this pipeline can and cannot see: opt-out flips, and the reporting base (JOS-109). */
  coverage: TriageAnalyticsCoverage
  versions: TriageVersionRow[]
  retention: TriageCohortRow[]
}

/** The window choices, so the toolbar and the handler validator cannot disagree. */
export const TRIAGE_ANALYTICS_DAYS = [7, 30, 90, 365] as const
export const TRIAGE_ANALYTICS_DEFAULT_DAYS = 30

export type TriageAnalytics =
  /**
   * NOT AVAILABLE, AND WHICH KIND — `state` names it, the same way `TriageLogState` names the
   * four things a slice can be. Two genuinely different facts, and the panel says different
   * words for each:
   *   * `missing` — the cluster answered, and does not have a table or column this code reads.
   *     `missing` names it. One `migrate` fixes it.
   *   * `unreachable` — the cluster did not answer at all: the socket dropped mid-read
   *     (`store.ts unreachable()`). Nothing is wrong with the schema and nothing needs
   *     migrating; the next attempt opens a fresh connection. Before this state existed the
   *     panel printed node-postgres's raw `Connection terminated unexpectedly` at the owner —
   *     and the async half of the same failure was an uncaughtException in the main process.
   */
  | { available: false; state: 'missing'; reason: string; missing: string }
  | { available: false; state: 'unreachable'; reason: string }
  | {
      available: true
      /** The USER cohort — the owner's own use is not in here. Always present. */
      data: TriageAnalyticsData
      /** The OWNER cohort, as its own complete readout. Null unless it was asked for. */
      owner: TriageAnalyticsData | null
      /** Is there any owner data at all in the window? Decides whether the toggle is offered. */
      ownerPresent: boolean
      /**
       * GITHUB RELEASE DOWNLOADS, MERGED IN AT THE IPC EDGE (`src/main/triage/ipc.ts`) and
       * nowhere else. `buildAnalytics` is pure over the three counter tables and NEVER populates
       * this; the field is optional precisely so that stays true — an answer built without ever
       * touching the network is a legal `TriageAnalytics`.
       *
       * It sits beside `data`/`owner` rather than inside `TriageAnalyticsData` because a
       * releases page knows nothing about who downloaded: downloads are GLOBAL and are rendered
       * once, never split or summed per cohort.
       */
      downloads?: TriageDownloads
      /**
       * LIVE SESSIONS, merged at the same edge and for the same reason: it is a CloudWatch read,
       * not a counter row, and `buildAnalytics` stays pure over the three tables.
       *
       * It is likewise GLOBAL rather than per cohort — the EMF metric is split by channel, never
       * by cohort (`TriageLiveSessions` says why) — so it is rendered once, above both readouts.
       */
      live?: TriageLiveSessions
    }

// ---- the reply envelope ----------------------------------------------------------------

/**
 * EVERY triage channel answers with one of these instead of rejecting.
 *
 * The failure mode this exists for is not a bug, it is the ACCESS CONTROL working: a shell
 * without the owner's AWS credentials gets an IAM denial from DSQL or S3 on the very first
 * statement. That has to render as prose in the panel, not as an unhandled rejection in a
 * renderer that then shows a blank tab.
 */
export type TriageResult<T> = { ok: true; value: T } | { ok: false; error: string }
