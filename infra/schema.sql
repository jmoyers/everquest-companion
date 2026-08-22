-- =============================================================================
-- infra/schema.sql â€” the Aurora DSQL schema for the feedback store.
-- =============================================================================
--
-- APPLIED BY:  npx tsx scripts/triage-feedback.mts migrate --profile <p>
--
-- NOT by Terraform. DSQL DDL needs an IAM-signed postgres connection, which
-- Terraform cannot make; see the header of infra/dsql.tf. The migrate command
-- connects as `admin`, splits this file into statements, and runs each one in
-- its OWN transaction (DSQL law: one DDL statement per transaction, and DDL and
-- DML may not share a transaction).
--
-- IDEMPOTENT. Re-running is a no-op: tables use IF NOT EXISTS, and the runner
-- treats "already exists" (42P07 / 42710 / 42P06) as success and says so.
--
-- STATEMENT SPLITTING is line-based: a statement ends at the first line whose
-- last character is `;`. Therefore NO STRING LITERAL IN THIS FILE MAY END A LINE
-- WITH A SEMICOLON. Nothing here does; keep it that way (there is no PL/pgSQL to
-- dollar-quote â€” DSQL does not support it).
--
-- `${LAMBDA_ROLE_ARN}` is substituted by the migrate command from
-- `terraform output -raw lambda_role_arn`. It contains the account id, which is
-- why it is a placeholder in a public repo and not a literal.
--
-- ---------------------------------------------------------------------------
-- SHAPE NOTES (why the columns look like this)
-- ---------------------------------------------------------------------------
--  * TIMES ARE epoch-MILLISECOND `bigint`, not timestamptz. The whole contract
--    (`receivedAt`, `clientTs`, `triagedAt`, `expiresAt`) is `number` in
--    src/shared/feedback.ts and in the triage CLI. Storing the same number keeps
--    ONE representation end to end; a timestamptz would add a conversion at
--    every boundary for no query we run. Both readers set node-postgres's int8
--    parser to Number â€” epoch ms is exact well past year 10000.
--  * `env_json` / `log_json` are TEXT holding JSON, not jsonb. Nothing ever
--    queries INTO them (the CLI parses them in JS), jsonb cannot be indexed in
--    DSQL anyway, and DSQL's jsonb support is two months old. The three env
--    fields that ARE queried or displayed in every list â€” channel, app_version,
--    platform â€” are promoted to real columns; env_json stays authoritative for
--    `show`.
--  * PRIMARY KEYS ARE THE UNIQUENESS RULES. `report_idempotency` is keyed on
--    (install_id, client_report_id), so idempotency is enforced by the key
--    itself rather than by a secondary unique index that would be built
--    asynchronously (and therefore unenforced for a window). Same for the quota
--    and dedupe counters.
--  * NO FOREIGN KEYS â€” DSQL has none. Every relationship here is by id and is
--    already enforced by the handler, which is the only writer of report rows.
--  * `report_id` is a ULID (server-minted). It stays the primary key so a report
--    is addressable by exactly the id the user is shown, and `received_at`
--    carries the timeline for every range query.
--  * NO `title`, NO `contact`. Both were retired from the wire contract first (the
--    description is the whole draft) and then from storage: nothing writes them,
--    nothing reads them, and a stack migrated from this file never has them.
--    A CLUSTER MIGRATED BEFORE THAT CHANGE STILL HAS THE TWO COLUMNS, and this
--    file cannot remove them: Aurora DSQL's documented ALTER TABLE grammar has no
--    `DROP [COLUMN]` action (it has DROP DEFAULT / DROP NOT NULL / DROP EXPRESSION
--    / DROP IDENTITY / DROP CONSTRAINT, and conspicuously not that one) —
--    https://docs.aws.amazon.com/aurora-dsql/latest/userguide/alter-table-syntax-support.html
--    Writing the drop here anyway would fail the whole `migrate` run on syntax.
--    The runbook in infra/README.md carries the one-off statement that DESTROYS
--    the legacy values, and the physical drop stays open against DSQL.

-- ---- tables -----------------------------------------------------------------

-- The kill switch and the live quota (Â§9.6). One row, id 'FEEDBACK'.
-- Seeded below with accepting = false: a freshly migrated stack is CLOSED until
-- the operator runs `triage-feedback closed off`, which is the safe default for
-- an endpoint that has never been smoke-tested.
-- The two `telemetry_*`/`max_events_*` columns are NULLABLE on purpose: they were
-- added to a live table (the ALTERs further down are what a pre-existing cluster
-- runs), and NULL has to be a legal value there. Both readers treat NULL as
-- CLOSED / "use the env fallback", so an un-migrated column can only fail safe.
CREATE TABLE IF NOT EXISTS feedback_config (
  id                        text    NOT NULL,
  accepting                 boolean NOT NULL,
  closed_message            text    NOT NULL,
  max_per_install_per_day   integer NOT NULL,
  telemetry_accepting       boolean,
  max_events_per_id_per_day integer,
  PRIMARY KEY (id)
);

-- Per-install block list. Absent row = not blocked.
CREATE TABLE IF NOT EXISTS install_profile (
  install_id     text    NOT NULL,
  blocked        boolean NOT NULL,
  blocked_reason text,
  blocked_at     bigint,
  PRIMARY KEY (install_id)
);

-- The backlog. Written once by ingest (INSERT only â€” the ingest role holds no
-- SELECT/UPDATE/DELETE here), amended thereafter only by the triage path.
CREATE TABLE IF NOT EXISTS report (
  report_id   text   NOT NULL,
  install_id  text   NOT NULL,
  report_type text   NOT NULL,
  description text   NOT NULL,
  channel     text   NOT NULL,
  app_version text   NOT NULL,
  platform    text   NOT NULL,
  env_json    text   NOT NULL,
  log_json    text,
  log_key     text,
  -- The SECOND attachment (JOS-296): the `/outputfile inventory` dump, stored exactly the way
  -- the slice is — the client's declared metadata as TEXT holding JSON, and the S3 key computed
  -- at insert time so triage can find (and HeadObject, and delete) the object without guessing.
  -- Two columns rather than a widened `log_json`: the two attachments have different metadata,
  -- different keys and independent lifetimes, and `forget` deletes them one at a time.
  inventory_json text,
  inventory_key  text,
  -- The THIRD attachment (JOS-441): the `/outputfile achievements` dump, on the identical terms.
  -- It exists because three v1.7.0 reports about the achievements import all arrived carrying a
  -- log and an inventory, and NEITHER could answer the question — the whole defect lived in a
  -- file nothing sent.
  achievements_json text,
  achievements_key  text,
  client_ts   bigint NOT NULL,
  received_at bigint NOT NULL,
  spam_score  integer NOT NULL,
  status      text   NOT NULL,
  severity    text,
  cluster_id  text,
  dupe_of     text,
  disposition text,
  issue_url   text,
  triaged_at  bigint,
  redacted_at bigint,
  PRIMARY KEY (report_id)
);

-- Daily per-install quota counter. `expires_at` is swept by the handler; there
-- is no TTL in DSQL.
CREATE TABLE IF NOT EXISTS install_quota (
  install_id text    NOT NULL,
  quota_day  text    NOT NULL,
  n          integer NOT NULL,
  bytes      bigint  NOT NULL,
  expires_at bigint  NOT NULL,
  PRIMARY KEY (install_id, quota_day)
);

-- Idempotency across offline retries (Â§6.4). The PRIMARY KEY *is* the guarantee.
CREATE TABLE IF NOT EXISTS report_idempotency (
  install_id       text   NOT NULL,
  client_report_id text   NOT NULL,
  report_id        text   NOT NULL,
  expires_at       bigint NOT NULL,
  PRIMARY KEY (install_id, client_report_id)
);

-- Copy-paste-flood probe (Â§9.5): same description text, same day, different
-- install. A spam SIGNAL only â€” it never blocks anything.
CREATE TABLE IF NOT EXISTS dedupe_probe (
  hash          text    NOT NULL,
  probe_day     text    NOT NULL,
  first_install text    NOT NULL,
  n             integer NOT NULL,
  expires_at    bigint  NOT NULL,
  PRIMARY KEY (hash, probe_day)
);

-- ---- usage analytics (docs/plans/usage-analytics.md T6 + Â§4) ----------------
--
-- THREE TABLES, AND NO RAW EVENT STORE. The ingest handler AGGREGATES ON ARRIVAL:
-- a batch becomes counter UPSERTs and is then forgotten. There is no per-user
-- event trail here to subpoena, leak or have to delete, and the only per-id row
-- that exists at all is `analytics_install` (which `analytics wipe --id` drops).
--
-- WHY THESE SHAPES:
--  * `usage_daily` is ONE narrow table for every counter. `metric` names the
--    counter and `dim` carries its closed-enum dimension (a view id, a feature
--    id, a version, a bucket INDEX), '-' where the metric has none. The names
--    are enumerated in src/shared/telemetryRollup.ts, which both the handler and
--    the triage readout import â€” postgres sees text, the code sees an enum.
--  * `usage_funnel_daily` is separate because its key is genuinely five columns
--    wide and folding it into `dim` would make every funnel query a string parse.
--  * `analytics_install` carries the day-grained per-id facts that a counter can
--    never answer (WAU/MAU, retention cohorts, days-to-adopt) plus the per-id
--    DAILY EVENT CAP, kept here rather than in a fourth table so that the whole
--    per-id footprint stays exactly one row.
--
-- All four `n`/count columns are bigint: they are sums of client-reported counts
-- and durations, and a busy day of `viewDwellMs` is comfortably past 2^31.
--
-- ---------------------------------------------------------------------------
-- `cohort` — 'user' or 'owner', AND IT IS PART OF THE KEY
-- ---------------------------------------------------------------------------
-- The author runs this app too (a dev build all day, the installed copy in the
-- evening), and their own use is signal about the BUILD but noise in every number
-- about the USER BASE. So the counters are keyed per cohort and every read path
-- defaults to 'user'. The rationale in full — including why nothing ever SUMS the
-- two — is in src/shared/telemetryRollup.ts, which both writers import.
--
-- IT IS IN THE PRIMARY KEY, NOT BESIDE IT, and that is not a preference: the
-- ingest path's `ON CONFLICT (day, cohort, metric, dim) DO UPDATE` needs those four
-- columns to BE the uniqueness rule, and a non-key column would let one day's
-- user and owner rows collide into one counter.
--
-- WHICH MEANS THERE IS NO `ALTER` FOR THESE TWO TABLES, AND CANNOT BE. Aurora
-- DSQL's ALTER TABLE grammar can add a column; it cannot change a PRIMARY KEY
-- (the key is the table's distribution, not an index you can rebuild).
--
-- ON A FRESH CLUSTER the CREATE TABLE below IS the whole migration. ON A CLUSTER
-- THAT ALREADY HAS THE PRE-COHORT SHAPE — which the live one does; the v0.4.0
-- smoke test answered `column "cohort" does not exist` — `IF NOT EXISTS` reports
-- `exists` and silently keeps the old columns. `migrate` output is the check.
--
-- THE RECOVERY IS A COPY, NOT A DROP (owner, 2026-08-05: "we shouldn't drop
-- anything"). Those counters have been accumulating behind a lit client since
-- 2026-08-04 and may hold REAL USERS' rows, not just the owner's testing. So the
-- path is: create cohort-keyed STAGING tables (whose CREATE text is taken from
-- THIS file, so the shapes cannot drift), copy every row into them with the
-- cohort derived from what `analytics_install` states, verify old-vs-new counts
-- and sums, and only then drop the copied-from original and
-- `ALTER TABLE … RENAME TO` the staging table into its place — a form Aurora DSQL
-- documents as supported, which is why no table name outside that transition ever
-- changes. `triage-feedback analytics backfill-cohort|backfill-verify|
-- backfill-swap` (scripts/analyticsBackfill.mts); the ordered commands are the
-- runbook at the top of infra/README.md. NOTHING in this file drops anything.

CREATE TABLE IF NOT EXISTS usage_daily (
  day    text   NOT NULL,
  cohort text   NOT NULL,
  metric text   NOT NULL,
  dim    text   NOT NULL,
  n      bigint NOT NULL,
  PRIMARY KEY (day, cohort, metric, dim)
);

CREATE TABLE IF NOT EXISTS usage_funnel_daily (
  day         text   NOT NULL,
  cohort      text   NOT NULL,
  funnel      text   NOT NULL,
  step        text   NOT NULL,
  outcome     text   NOT NULL,
  app_version text   NOT NULL,
  n           bigint NOT NULL,
  PRIMARY KEY (day, cohort, funnel, step, outcome, app_version)
);

-- ONE ROW PER analyticsId, and that is the entire per-id footprint of this
-- feature. `quota_day`/`quota_n` are the daily event cap's counter: they live on
-- this row so the guarded UPSERT that maintains the row IS the cap check, in one
-- statement with no read-modify-write window (the same argument install_quota
-- makes for feedback, written out in infra/lambda/telemetry.ts).
--
-- `cohort` IS NULLABLE HERE, unlike in the two counter tables, for the same reason
-- the `telemetry_*` config columns are: it is the one cohort column that CAN be
-- added to a pre-existing table (it is not in the key), so the `ALTER` further
-- down is real and a row written before it ran has NULL. Every reader normalizes
-- NULL to 'user' (`cohortOf` in src/shared/telemetryRollup.ts), which is the
-- fail-safe direction — an install nobody has marked is a user.
--
-- `machine_class` / `window_mode` (JOS-372) are nullable for the same reason `cohort` is, plus
-- one of their own: they are written only when a `setupSnapshot` arrives, and an install that has
-- never sent one — or that runs a client predating those fields — legitimately has neither. Both
-- are CLOSED SETS spelled in src/shared/telemetryPerfCube.ts ('low-igpu' … 'unknown';
-- 'exclusive' | 'windowed' | 'unknown'), and every reader normalizes anything else to 'unknown',
-- which is a real class rather than a missing value. They live on this row because the stall
-- readings they slice arrive on EVERY session report while a snapshot arrives once per launch:
-- the row is where the two dims wait between launches. This is the whole per-install footprint
-- the perf cube adds — two enums on a row that already existed.
CREATE TABLE IF NOT EXISTS analytics_install (
  analytics_id   text   NOT NULL,
  first_seen_day text   NOT NULL,
  last_seen_day  text   NOT NULL,
  days_seen      integer NOT NULL,
  app_version    text   NOT NULL,
  channel        text   NOT NULL,
  cohort         text,
  quota_day      text   NOT NULL,
  quota_n        bigint NOT NULL,
  machine_class  text,
  window_mode    text,
  PRIMARY KEY (analytics_id)
);

-- ---- error reports (JOS-100) -------------------------------------------------
--
-- ADDITIVE, AND `usage_daily` IS UNTOUCHED. The counters keep answering "how many
-- errors did this build report"; this table answers "WHICH ones", which a counter
-- cannot, because the answer needs an example and `usage_daily` has no column an
-- example could live in.
--
-- ONE ROW PER (day, cohort, version, fingerprint), AND IT IS THE UNIQUENESS RULE:
-- the ingest path's `ON CONFLICT (day, cohort, version, fingerprint) DO UPDATE`
-- needs those four columns to BE the key. `cohort` is in the key for exactly the
-- reason it is in `usage_daily`'s (the long note above that table) — the author
-- runs this app too, and a merged total is the number the split exists to stop
-- reporting. `version` is in the key rather than in `dim` because THIS table has
-- room for a real column and the question is per-release: "did the build I just
-- shipped introduce this".
--
-- THIS TABLE IS BORN WITH ITS KEY. There is no `ALTER` path to a primary key in
-- Aurora DSQL, so a cluster that gets the CREATE below gets the final shape; a
-- future re-shape would need the copy-first staging runbook in infra/README.md,
-- exactly as the cohort migration did.
--
-- `exemplar` IS TEXT HOLDING JSON, NOT jsonb — and this file's own SHAPE NOTES are
-- why (env_json / log_json made the same call): nothing ever queries INTO it (both
-- readers parse it in JS), DSQL cannot index jsonb, and its jsonb support is young.
-- The JOS-100 brief asked for jsonb; the conventions this file states are older
-- than the brief and they win. Switching later is an ADD-a-column migration, which
-- is the one shape DSQL does support.
--
-- WHAT IS IN AN EXEMPLAR, so a reader of this file does not have to trust a comment
-- in another one: a validated `errorReport` event and nothing else — an error name,
-- a machine-readable code, a REDACTED message (the ingest Lambda re-runs the
-- redactor and refuses anything that changes under it), stack frames whose files
-- are all `out/…` bundle paths, and a list of parser event KINDS. No log line, no
-- chat, no character name, no filesystem path, no analyticsId. FIRST WINS: the
-- UPSERT writes the exemplar only when the row has none, so a hundred installs
-- hitting one bug store one example and add to one count.
CREATE TABLE IF NOT EXISTS error_report (
  day         text   NOT NULL,
  cohort      text   NOT NULL,
  version     text   NOT NULL,
  fingerprint text   NOT NULL,
  count       bigint NOT NULL,
  exemplar    text,
  PRIMARY KEY (day, cohort, version, fingerprint)
);

-- ---- the perf cube (JOS-372) -------------------------------------------------
--
-- THE ONE CROSS-TAB, AND STILL NO RAW EVENT STORE. `usage_daily` is (day, cohort, metric, dim, n)
-- — ONE dimension per row — so it can say "how many session reports saw a stall over 500 ms" and
-- it structurally CANNOT say "is that rate higher on exclusive-fullscreen installs, or on 8 GB
-- boxes, or when an overlay is locked". Those are the questions the ~1 s freeze reports actually
-- pose, and only a cube answers one. This is that cube and it is deliberately the only one.
--
-- WHAT A ROW IS: one SESSION REPORT that carried a live stall reading (a `sessionHeartbeat` or a
-- `sessionEnd` — both carry the identical rider for the interval since the last report). That is
-- the SAME population as `usage_daily`'s `liveStallP95` histogram, on purpose: the cube's rates
-- and the Live section's fleet-wide figures then share a denominator and can be read against each
-- other instead of being two numbers nobody can reconcile.
--
-- EVERY DIM IS A CLOSED ENUM OR A BUCKET INDEX, which is what keeps this inside the telemetry
-- bright line. The vocabulary is declared once, in src/shared/telemetryPerfCube.ts, which both
-- the ingest handler and the triage readout import:
--   * `window_mode`   'exclusive' | 'windowed' | 'unknown'
--   * `machine_class` 'low-igpu' | 'low-dgpu' | 'mid-igpu' | 'mid-dgpu' | 'high-igpu' |
--                     'high-dgpu' | 'unknown' — cores × memory collapsed to a TIER (the weaker
--                     axis wins) crossed with integrated-vs-discrete graphics. 27 raw
--                     combinations folded to 7 so the cube stays readable.
--   * `locked`        'on' | 'off' | '-' — was any overlay click-through (so the process-wide
--                     WH_MOUSE_LL hook was armed) at report time; '-' when the report carried no
--                     session-state rider to ask.
--   * `stall_bucket`  index into LIVE_STALL_MS_EDGES — the report's WORST probe tick (9 buckets).
--   * `tail_bucket`   the same ladder, the worst tail READ, or '-' when the session tailed
--                     nothing. A session with no character attached is a real and common state,
--                     and it is a different fact from "its reads were fast".
--
-- CARDINALITY BUDGET, stated because a cube is the one shape in this schema that can run away:
-- 3 window modes × 7 classes × 3 locked × 9 stall buckets × 10 tail values = 5,670 POSSIBLE rows
-- per day per cohort — the absolute ceiling, reached only by a fleet that is simultaneously every
-- machine there is. Realistically a day is a few hundred rows: a small fleet occupies a handful
-- of (mode, class) pairs and its stall/tail readings cluster in two or three buckets each. Note
-- what CANNOT grow it: every dim above is a closed set, so the only way this table gains a new
-- distinct row shape is a code change in this repo.
--
-- THE WHOLE ROW IS THE PRIMARY KEY, minus `n`, and that is not a preference: the ingest path's
-- `ON CONFLICT (day, cohort, window_mode, machine_class, locked, stall_bucket, tail_bucket)`
-- needs those seven columns to BE the uniqueness rule. As with `usage_daily` and `error_report`,
-- THIS TABLE IS BORN WITH ITS KEY — Aurora DSQL has no ALTER path to a primary key — so a
-- re-shape later would need the copy-first staging runbook in infra/README.md.
--
-- `n` is bigint like every other count here: it is a sum of session reports and this table is
-- keyed on a day, so it is small, and a narrower type would be a saving nobody can spend.
--
-- NO BACKFILL IS POSSIBLE, and none is attempted. The pipeline keeps no raw events (T6), so
-- yesterday's heartbeats no longer exist in any form that could be re-folded into a cube. This
-- table starts on the day the Lambda that writes it is deployed, and the readouts render an empty
-- window as "nothing reported yet" rather than as zeros.
CREATE TABLE IF NOT EXISTS perf_daily (
  day           text   NOT NULL,
  cohort        text   NOT NULL,
  window_mode   text   NOT NULL,
  machine_class text   NOT NULL,
  locked        text   NOT NULL,
  stall_bucket  text   NOT NULL,
  tail_bucket   text   NOT NULL,
  n             bigint NOT NULL,
  PRIMARY KEY (day, cohort, window_mode, machine_class, locked, stall_bucket, tail_bucket)
);

-- ---- the SHARDED counters, and the views that merge them (JOS-394) -----------
--
-- WHY THIS EXISTS. Every client increments the SAME handful of rows: `usage_daily`'s
-- (day, cohort, 'sessionHeartbeat', '-') and the small CLOSED set of `perf_daily`
-- buckets. DSQL is optimistic — it takes no locks and aborts the second committer of
-- a write-write race with 40001 — so the conflict rate is a function of how many
-- writers meet on ONE row, and at this product's traffic that is all of them. MEASURED
-- on the live stack 2026-08-16: ~1,350 telemetry requests per 5 minutes (4.5 RPS, flat,
-- 3-4 concurrent Lambdas) produced 60-90 OCC conflicts per 5 minutes — about 5% of
-- writes, every one of them on the `counters` transaction. Nothing was lost (the retry
-- ladder over two hours was 1,634 first-attempt conflicts -> 104 second -> 6 third ->
-- ZERO exhausted), but a permanently-firing alarm is an alarm nobody reads.
--
-- WHY A SHARD COLUMN AND NOT A BIGGER RETRY BUDGET. Retrying is paying for the
-- collision after it happens, and the bill grows with concurrency; the shard makes the
-- collision RARE. One row becomes SHARD_COUNT rows (32 — infra/lambda/telemetry.ts
-- carries the arithmetic beside the constant), and two concurrent writers now have to
-- agree on the shard as well as on the counter, so conflicts fall roughly linearly with
-- the shard count. Reading is a SUM that was already a SUM.
--
-- WHY THE SHARD IS RANDOM, AND WHY IT MAY NEVER BE A HASH OF THE INSTALL. The obvious
-- shard key is the analyticsId, and it is FORBIDDEN here: a hash of the install id is a
-- FUNCTION OF THE INSTALL ID, and this file's whole design (the long note above
-- `usage_daily`, the header of infra/lambda/telemetry.ts) is that no such function
-- reaches a counter table — a stable per-install shard would let anyone holding these
-- rows partition a day's counters into per-install buckets, which is exactly the
-- per-user trail the aggregate-on-arrival design refuses to keep. A shard drawn from
-- `Math.random()` per REQUEST spreads writes exactly as well and carries no information
-- about who sent them. The shard column is therefore not a key anybody can join on; it
-- is noise with a purpose.
--
-- WHY A NEW TABLE INSTEAD OF AN ALTER. The shard is part of the PRIMARY KEY (the
-- `ON CONFLICT` target has to BE the uniqueness rule, or two shards of one counter
-- collide into one row), and Aurora DSQL has no ALTER path to a primary key — a key is
-- the table's distribution, not an index. THESE TABLES ARE BORN WITH THEIR KEYS, like
-- every other keyed table in this file.
--
-- WHY THE OLD TABLES STAY, AND WHY THERE IS NO BACKFILL. `usage_daily` and `perf_daily`
-- hold real counters from real users. They are FROZEN at cutover — the Lambda stops
-- writing them, nothing drops them, nothing rewrites them — and the two views below add
-- them back to every read. A backfill would be a copy with no reader that needed it,
-- and a drop would be a data loss to save two `UNION ALL` legs (owner, 2026-08-05:
-- "we shouldn't drop anything"). The cutover DAY is the case that proves the shape: its
-- counters live half in the old table and half in the new one, and the view is what
-- makes that invisible to every reader.
--
-- WHY A VIEW AND NOT A UNION IN EVERY READER. There are five reader call sites for
-- these two tables (the app's Analytics tab, the CLI digest, the release smoke test,
-- and the two panels behind them) and one writer. A view puts the merge in ONE place,
-- in the database, so a reader that forgets it cannot silently report half the fleet.
-- VERIFIED ON A REAL DSQL CLUSTER, 2026-08-16 (an ephemeral cluster stood up for this
-- ticket and deleted after): DSQL accepts `CREATE VIEW` over a grouped `UNION ALL`,
-- accepts `CREATE OR REPLACE VIEW`, accepts `DROP VIEW`, answers a repeat `CREATE VIEW`
-- with `42P07` (which `migrate` already treats as `exists`, so the plain form below is
-- idempotent), and pushes `WHERE day >= $1 ORDER BY day LIMIT $2` through it.
--
-- `SUM(n)::bigint` IS LOAD-BEARING, and this is the one line here that a reviewer
-- should not "simplify". MEASURED on the same cluster: an uncast `SUM(bigint)` comes
-- back as NUMERIC (type OID 1700), and both readers set node-postgres's int8 parser on
-- OID 20 ONLY — so an uncast view hands every counter over as a STRING, and the
-- readouts' `num()` helpers turn a non-number into 0. That failure is SILENT and looks
-- exactly like a quiet fleet. The cast makes the view's `n` int8, i.e. the same type
-- and the same JS `number` the tables themselves have always produced.

CREATE TABLE IF NOT EXISTS usage_daily_sharded (
  shard  integer NOT NULL,
  day    text    NOT NULL,
  cohort text    NOT NULL,
  metric text    NOT NULL,
  dim    text    NOT NULL,
  n      bigint  NOT NULL,
  PRIMARY KEY (shard, day, cohort, metric, dim)
);

CREATE TABLE IF NOT EXISTS perf_daily_sharded (
  shard         integer NOT NULL,
  day           text    NOT NULL,
  cohort        text    NOT NULL,
  window_mode   text    NOT NULL,
  machine_class text    NOT NULL,
  locked        text    NOT NULL,
  stall_bucket  text    NOT NULL,
  tail_bucket   text    NOT NULL,
  n             bigint  NOT NULL,
  PRIMARY KEY (shard, day, cohort, window_mode, machine_class, locked, stall_bucket, tail_bucket)
);

-- THE MERGED READ, and the ONLY thing any reader outside the Lambda should name. The
-- projection is the OLD table's exactly — (day, cohort, metric, dim, n) — so switching
-- a reader over is a change of table name and nothing else, and the degrade path is
-- unchanged too: a cluster without this view answers `42P01` naming `usage_daily_all`,
-- which src/main/triage/usageStore.ts already renders as "this cluster is not migrated"
-- rather than as a crash.
CREATE VIEW usage_daily_all AS
SELECT day, cohort, metric, dim, SUM(n)::bigint AS n
  FROM (SELECT day, cohort, metric, dim, n FROM usage_daily
        UNION ALL
        SELECT day, cohort, metric, dim, n FROM usage_daily_sharded) t
 GROUP BY day, cohort, metric, dim;

-- The cube's twin, over its seven-column key. Same projection as `perf_daily`, same
-- cast, same reasoning.
CREATE VIEW perf_daily_all AS
SELECT day, cohort, window_mode, machine_class, locked, stall_bucket, tail_bucket,
       SUM(n)::bigint AS n
  FROM (SELECT day, cohort, window_mode, machine_class, locked, stall_bucket, tail_bucket, n
          FROM perf_daily
        UNION ALL
        SELECT day, cohort, window_mode, machine_class, locked, stall_bucket, tail_bucket, n
          FROM perf_daily_sharded) t
 GROUP BY day, cohort, window_mode, machine_class, locked, stall_bucket, tail_bucket;

-- The kill switch and the cap for the TELEMETRY route, added to the existing
-- config row rather than a second table: one row is where an operator already
-- looks, and `triage-feedback` already reads and writes it.
--
-- ADDED, NEVER DROPPED. Aurora DSQL's ALTER TABLE grammar has no DROP COLUMN
-- (infra/README.md carries the worked example), so a column here is forever â€” it
-- is two, both nullable, and the handler reads them field by field with a typed
-- fallback so a NULL can only ever mean CLOSED. On a cluster created from this
-- file the CREATE TABLE above already has them and these two statements report
-- `exists` (42701 duplicate_column, which the migrate runner treats as success,
-- same as 42P07 for a table).
ALTER TABLE feedback_config ADD COLUMN telemetry_accepting boolean;

ALTER TABLE feedback_config ADD COLUMN max_events_per_id_per_day integer;

-- The install row's cohort, added the same way and for the same reasons: nullable,
-- never dropped, and a NULL reads as 'user' at every reader. It is the ONE cohort
-- column that an ALTER can add, because it is not part of a primary key — the two
-- counter tables carry theirs IN the key and therefore had to be born with it (the
-- long note above `usage_daily` says what to do if a cluster already has the old
-- shape). On a cluster created from today's file the CREATE TABLE already has the
-- column and this reports `exists` (42701 duplicate_column).
ALTER TABLE analytics_install ADD COLUMN cohort text;

-- The inventory attachment's two columns on a LIVE cluster (JOS-296). Same shape of migration as
-- the three above, and the same reasoning: DSQL's ALTER TABLE grammar can ADD a column and has no
-- DROP, so these are forever and both are NULLABLE — which is also what makes them additive. A
-- report written before this ran has NULL in both, and every reader spells that "no dump", which
-- is exactly what it was.
--
-- THESE MUST LAND BEFORE THE HANDLER THAT NAMES THEM. `REPORT_SQL` in infra/lambda/submit.ts
-- lists `inventory_json, inventory_key` unconditionally, and naming a column that does not exist
-- 42703s EVERY SUBMIT — the same trap the retired `title`/`contact` columns document above. So
-- the order is: `migrate` first, `terraform apply` (the new bundle) second, client release third.
-- infra/README.md carries the runbook.
-- On a cluster created from today's file the CREATE TABLE already has them and these report
-- `exists` (42701 duplicate_column).
ALTER TABLE report ADD COLUMN inventory_json text;

ALTER TABLE report ADD COLUMN inventory_key text;

-- The achievements attachment's two columns on a LIVE cluster (JOS-441). Everything the paragraph
-- above says applies unchanged, including the ordering law: `REPORT_SQL` names
-- `achievements_json, achievements_key` unconditionally, so `migrate` runs FIRST, the new Lambda
-- bundle SECOND, and the client release THIRD. Deploy the bundle before this and every submit
-- 42703s with the endpoint open; ship the client first and it declares an attachment the server
-- has no column for, uploading nothing while telling the user it did.
ALTER TABLE report ADD COLUMN achievements_json text;

ALTER TABLE report ADD COLUMN achievements_key text;

-- The perf cube's two install-level dims on a LIVE cluster (JOS-372). Nullable, never dropped,
-- and the same shape of migration as the four above — a row written before this ran has NULL in
-- both, which every reader spells 'unknown' (a real class in the cube, not a missing value).
--
-- THESE MUST LAND BEFORE THE LAMBDA THAT NAMES THEM. `INSTALL_SQL` in infra/lambda/telemetry.ts
-- lists `machine_class, window_mode` unconditionally, and naming a column that does not exist is
-- `42703` on EVERY batch — the same trap the inventory columns document above. So the order is:
-- `migrate` first, `terraform apply` (the new telemetry bundle) second. There is no client step:
-- nothing new crosses the wire for this feature, both dims are DERIVED server-side from
-- `setupSnapshot` fields that shipped with JOS-364.
-- On a cluster created from today's file the CREATE TABLE already has them and these report
-- `exists` (42701 duplicate_column).
ALTER TABLE analytics_install ADD COLUMN machine_class text;

ALTER TABLE analytics_install ADD COLUMN window_mode text;

-- ---- indexes ----------------------------------------------------------------
--
-- `CREATE INDEX ASYNC` is mandatory in DSQL (DDL cannot lock in a distributed
-- system). It returns a job id immediately and builds in the background; the
-- migrate command prints the id. Deliberately NO `IF NOT EXISTS` â€” it is not
-- part of the ASYNC grammar everywhere, and the runner already treats
-- "already exists" as success, which is the check that matters.
--
-- Columns are ASC: PostgreSQL scans an index backwards for `ORDER BY ... DESC`,
-- so a DESC index would buy nothing and adds a syntax bet.
--
-- These two replace gsi1 (byChannel) and gsi2 (byStatus). There is deliberately
-- NO index on install_id: `wipe --install` is a once-a-year deletion request and
-- the CLI warns that it is an unindexed scan â€” the same trade the plan made when
-- it refused a third GSI. There is likewise no index on `expires_at`: the sweep
-- is bounded and time-gated, and indexing it would tax every submit to speed up
-- a janitor.

CREATE INDEX ASYNC report_by_channel ON report (channel, received_at);

CREATE INDEX ASYNC report_by_status ON report (status, received_at);

-- The ONE analytics index. Every `usage_*` read is a `day >= :floor` range over
-- the PRIMARY KEY's leading column, so those two tables need nothing extra â€” but
-- WAU/MAU and the retention cohorts count `analytics_install` rows by
-- `last_seen_day`, which is not the key, and that read grows with the install
-- base rather than with the window.
CREATE INDEX ASYNC analytics_install_by_last_seen ON analytics_install (last_seen_day);

-- ---- seed -------------------------------------------------------------------
-- DML, so it is its own transaction (DSQL forbids mixing it with DDL).

INSERT INTO feedback_config (id, accepting, closed_message, max_per_install_per_day)
VALUES ('FEEDBACK', false, 'Feedback is not open yet. Please try again later.', 10)
ON CONFLICT (id) DO NOTHING;

-- TELEMETRY IS SEEDED CLOSED, exactly like feedback was: a route that has never
-- been smoke tested accepts nothing. `triage-feedback analytics open` (or one
-- UPDATE) is the deliberate act that turns it on.
--
-- Guarded on IS NULL so it is idempotent AND so it can never re-close a switch an
-- operator has already opened â€” re-running `migrate` after a schema change must
-- not be a stealth outage.
UPDATE feedback_config
   SET telemetry_accepting = false
 WHERE id = 'FEEDBACK' AND telemetry_accepting IS NULL;

UPDATE feedback_config
   SET max_events_per_id_per_day = 20000
 WHERE id = 'FEEDBACK' AND max_events_per_id_per_day IS NULL;

-- ---- the ingest database role ----------------------------------------------
--
-- THE INGEST PATH CAN CREATE AND COUNT. IT CANNOT READ THE BACKLOG OR DELETE A
-- REPORT. That property was IAM-shaped under DynamoDB (no Query, no Scan, no
-- DeleteItem); with one SQL endpoint it has to be shaped by GRANTs instead, so
-- the Lambda logs in as this role and never as `admin`. Note what is absent
-- below: any privilege at all on `report` other than INSERT.
--
-- DELETE on the three counter tables is what makes the retention sweep real.

CREATE ROLE feedback_ingest WITH LOGIN;

AWS IAM GRANT feedback_ingest TO '${LAMBDA_ROLE_ARN}';

-- DSQL: schema-level grants on system-owned 'public' are unsupported ('feature not
-- supported on system entity', live 2026-08-04); table-level grants below suffice.
GRANT SELECT ON feedback_config TO feedback_ingest;

GRANT SELECT ON install_profile TO feedback_ingest;

GRANT INSERT ON report TO feedback_ingest;

GRANT SELECT, INSERT, DELETE ON report_idempotency TO feedback_ingest;

GRANT SELECT, INSERT, UPDATE, DELETE ON install_quota TO feedback_ingest;

GRANT SELECT, INSERT, UPDATE, DELETE ON dedupe_probe TO feedback_ingest;

-- ---- the TELEMETRY ingest database role -------------------------------------
--
-- A SECOND ROLE FOR A SECOND FUNCTION, and the reason is the same one that made
-- `feedback_ingest` narrow: what a public write endpoint may do is the GRANT list
-- below, not a promise in a handler. This role can count usage and it can touch
-- its own install row. It cannot read the feedback backlog, cannot see
-- install_profile, cannot write `report`, and holds no DELETE anywhere â€” a full
-- compromise of the telemetry Lambda can inflate counters and nothing else.
--
-- SELECT is granted alongside INSERT/UPDATE on the three tables because an
-- `ON CONFLICT DO UPDATE ... WHERE` reads the existing row to evaluate the guard,
-- and `RETURNING` reads it back. There is no DELETE: aggregates are anonymous and
-- are kept; the one deletion path (`analytics wipe --id`) runs as `admin`.

CREATE ROLE telemetry_ingest WITH LOGIN;

AWS IAM GRANT telemetry_ingest TO '${TELEMETRY_LAMBDA_ROLE_ARN}';

GRANT SELECT ON feedback_config TO telemetry_ingest;

GRANT SELECT, INSERT, UPDATE ON usage_daily TO telemetry_ingest;

GRANT SELECT, INSERT, UPDATE ON usage_funnel_daily TO telemetry_ingest;

GRANT SELECT, INSERT, UPDATE ON analytics_install TO telemetry_ingest;

-- The error store (JOS-100). SELECT rides along with INSERT/UPDATE for the same
-- reason it does on the three tables above: `ON CONFLICT DO UPDATE` reads the
-- existing row to evaluate `COALESCE(error_report.exemplar, EXCLUDED.exemplar)`.
-- Still NO DELETE — a compromised telemetry Lambda can add rows to this table and
-- can neither read the feedback backlog nor destroy an error history.
GRANT SELECT, INSERT, UPDATE ON error_report TO telemetry_ingest;

-- The perf cube (JOS-372). SELECT rides along with INSERT/UPDATE for the third time and for the
-- same reason: `ON CONFLICT DO UPDATE SET n = perf_daily.n + EXCLUDED.n` reads the existing row
-- to evaluate the sum. Still NO DELETE, so this role can add anonymous cube rows and can neither
-- read the feedback backlog nor destroy a history. The TRIAGE reader needs no grant here — it
-- connects as `admin` (src/main/triage/store.ts).
GRANT SELECT, INSERT, UPDATE ON perf_daily TO telemetry_ingest;

-- The two SHARDED counter tables (JOS-394) — the ONLY counter tables the Lambda writes from
-- cutover onward. Same three privileges and the same reason for the SELECT (the additive
-- `ON CONFLICT DO UPDATE` reads the existing row to evaluate the sum), and still no DELETE.
--
-- THESE MUST BE GRANTED BEFORE THE BUNDLE THAT WRITES THEM. A missing grant is `42501
-- permission denied` on every batch, which is the same shape of trap as a missing column, so
-- the order is the one this file and infra/README.md state everywhere: `migrate` first,
-- `terraform apply` second.
--
-- NO GRANT ON THE TWO VIEWS, deliberately. The Lambda never reads a counter back — it only
-- adds — and the only reader of `usage_daily_all` / `perf_daily_all` is the triage side, which
-- connects as `admin`. Granting SELECT on the merged view to a public write endpoint's role
-- would hand it the whole fleet's counters for nothing.
GRANT SELECT, INSERT, UPDATE ON usage_daily_sharded TO telemetry_ingest;

GRANT SELECT, INSERT, UPDATE ON perf_daily_sharded TO telemetry_ingest;

-- ---- the EXPORT database role (JOS-398) --------------------------------------
--
-- A THIRD ROLE, AND IT IS THE ONLY READ-ONLY ONE. The nightly archive Lambda
-- (infra/lambda/export.ts) copies every table to S3 so that a bad migration, a
-- table-swapping script or a fat-fingered DROP is recoverable at the ROW level and
-- not only through an AWS Backup restore. Owner ruling 2026-08-16: the analytics
-- data must never be lost.
--
-- IT IS THE WIDEST READ IN THIS FILE AND THE NARROWEST WRITE. Note what is absent
-- from every line below: INSERT, UPDATE and DELETE, on every table, without
-- exception. A full compromise of the export function can read the corpus — that is
-- its entire job — and cannot change one byte of it. That is the opposite shape from
-- the two ingest roles, which may write a little and read almost nothing, and the
-- asymmetry is the point: the thing with a public endpoint cannot read, and the thing
-- that can read has no public endpoint (its only invoker is an EventBridge rule).
--
-- NO GRANT ON THE TWO MERGE VIEWS, deliberately. The export copies TABLES — the
-- physical rows, each under its own name — because a restore has to put a row back
-- where it came from, and `usage_daily_all` would hand back a SUM whose two legs can
-- no longer be told apart. src/shared/analyticsTables.ts states the same rule from
-- the other end.

CREATE ROLE analytics_export WITH LOGIN;

AWS IAM GRANT analytics_export TO '${EXPORT_LAMBDA_ROLE_ARN}';

GRANT SELECT ON feedback_config TO analytics_export;

GRANT SELECT ON install_profile TO analytics_export;

GRANT SELECT ON report TO analytics_export;

GRANT SELECT ON install_quota TO analytics_export;

GRANT SELECT ON report_idempotency TO analytics_export;

GRANT SELECT ON dedupe_probe TO analytics_export;

GRANT SELECT ON usage_daily TO analytics_export;

GRANT SELECT ON usage_daily_sharded TO analytics_export;

GRANT SELECT ON usage_funnel_daily TO analytics_export;

GRANT SELECT ON analytics_install TO analytics_export;

GRANT SELECT ON error_report TO analytics_export;

GRANT SELECT ON perf_daily TO analytics_export;

GRANT SELECT ON perf_daily_sharded TO analytics_export;
