# infra/ — feedback + telemetry ingest stack (Terraform)

The cloud half of the in-app feedback loop and of usage analytics: one HTTP API with
**two routes**, **two Lambdas**, one **Aurora DSQL** cluster, one S3 bucket, and the guard
rails that make **publicly writable** endpoints safe to leave running. Design + rationale live
in `docs/plans/feedback-triage.md` (§7–§10) and `docs/plans/usage-analytics.md`; this file is
the runbook.

> **TWO FUNCTIONS, ON PURPOSE.** `POST /v1/telemetry` is its own Lambda with its own IAM role
> and its own **database** role, not a second route on the submit handler. Everything that
> makes either endpoint safe is per-identity — an IAM policy with one or two statements, and a
> GRANT list that is the real answer to "what can a compromised public endpoint do". One
> function serving both would hold the union: `INSERT ON report` plus an S3 presign permission
> for the counter path, and UPSERT on the counters for the feedback path. The cost of the split
> is one more zip and one more log group.

- **IaC: Terraform (HCL)** — owner decision, 2026-08-03. Not CDK.
- **Store: Aurora DSQL** (serverless Postgres) — owner decision. The plan and the
  first cut of this stack used DynamoDB; §3.2's single-table design existed only
  because DynamoDB cannot filter without an index, so in SQL the five item kinds
  are five tables, the two GSIs are two indexes, and `--since 7d` is a `WHERE`.
- **Region: us-east-1**, in a **dedicated AWS sub-account** (AWS Organizations).
- **CI validates. CI never plans and never applies.** There are no cloud
  credentials and no OIDC deploy role in a public repo; deploying is a manual act
  from the dev machine. See `.github/workflows/infra.yml`.

## What gets created

| File | Resources |
| --- | --- |
| `versions.tf` | provider pins (aws `~> 6.0` — `aws_dsql_cluster` needs it) + the `backend "s3"` block + default tags |
| `variables.tf` | region, name prefix, alarm email, triage principal, every spend knob (both routes) |
| `api.tf` | HTTP API `eqcompanion-api`, `$default` stage, `POST /v1/feedback` + `POST /v1/telemetry`, stage + per-route throttles, access logging |
| `lambda.tf` | `eqcompanion-feedback-submit` and `eqcompanion-telemetry-ingest` (both Node 22, arm64, 256 MB, 10 s), their log groups at 14-day retention |
| `dsql.tf` | the Aurora DSQL cluster (deletion protection + `prevent_destroy`) and the endpoint/ingest-role locals |
| `schema.sql` | the tables, the two **merge views** (JOS-394), indexes, config seed and the **three** database roles — two ingest, one read-only export (JOS-398) — applied by the CLI, not by Terraform (see step 2.5) |
| `s3.tf` | `eqcompanion-logs-<random hex>` + all four Block-Public-Access flags + SSE-S3 + versioning off + 90-day lifecycle + `prevent_destroy` |
| `iam.tf` | the two ingest roles (`dsql:DbConnect` only; telemetry has no S3 at all) and `EqCompanionFeedbackTriageRole` (`dsql:DbConnectAdmin`) |
| `alarms.tf` | `EqCompanionOpsAlerts` SNS topic + email sub + 9 alarms (the OCC one is metric math over a RATIO since JOS-394) + the monthly budget |
| `backup.tf` | **JOS-398** — AWS Backup vault + plan (daily 35 d, monthly 12 mo) + selection on the cluster ARN + the service role + a job-failure alarm |
| `export.tf` | **JOS-398** — `eqcompanion-analytics-archive-<acct>` (versioned, BPA, SSE, two-prefix lifecycle, encryption-deny policy), `eqcompanion-analytics-export` + its read-only role and log group, the 09:30 UTC EventBridge rule, and two alarms |
| `dashboard.tf` | `eqcompanion-telemetry` CloudWatch dashboard, fed by the ingest handler's EMF documents |
| `outputs.tf` | `api_url`, `telemetry_api_url`, `cluster_endpoint`, `bucket_name`, `triage_role_arn`, all three `*_role_arn`s, log group names, `archive_bucket_name`, `backup_vault_name` |
| `build.mjs` | esbuild bundles of `lambda/submit.ts`, `lambda/telemetry.ts` and `lambda/export.ts` → **deterministic** `dist/submit.zip` + `dist/telemetry.zip` + `dist/export.zip` |

Each handler imports its validator from `src/shared/` — `validateSubmit` from
`feedback.ts`, `validateTelemetryBatch` from `telemetryValidate.ts` — so the server runs the
same validator as the client. `build.mjs` is what makes those imports survive into a Lambda
zip, and CI runs it on every change to either side so the two cannot drift apart silently.

The telemetry handler additionally imports `src/shared/telemetryRollup.ts`, which is the ONE
definition of what a batch becomes: the metric names it writes are the metric names the triage
Analytics tab and `triage-feedback analytics digest` read back. Since JOS-372 it also imports
`src/shared/telemetryPerfCube.ts` on the same terms — the closed vocabulary of the one cross-tab
(`perf_daily`), spelled once and imported by the handler and by both readouts.

## There is no database password

Aurora DSQL authenticates with a short-lived IAM token that `@aws-sdk/dsql-signer`
derives **locally** (SigV4 over the cluster hostname — no network call) from
whatever credentials the caller already holds. Nothing is stored in Secrets
Manager or SSM, nothing rotates, and there is no credential to leak.

Two identities, and the difference matters:

| Who | IAM action | Database role | Can do |
| --- | --- | --- | --- |
| the submit Lambda | `dsql:DbConnect` | `feedback_ingest` | `INSERT` on `report`; read config/profile; read+write+delete the three counter tables |
| the telemetry Lambda | `dsql:DbConnect` | `telemetry_ingest` | read `feedback_config`; UPSERT `usage_daily_sharded`, `perf_daily_sharded`, `usage_funnel_daily`, `error_report`, `analytics_install`. **No privilege at all on `report`, no `install_profile`, no DELETE anywhere — and no SELECT on the merged views, which only the admin-connected triage side reads.** |
| the export Lambda | `dsql:DbConnect` | `analytics_export` | **SELECT on every table, and no INSERT, UPDATE or DELETE anywhere.** The widest read in the cluster and the narrowest write — and the one identity with **no public trigger at all**: EventBridge invokes it, nothing else can. No grant on the two merge views, because an export copies TABLES (a restore has to put a row back where it came from, and a view hands back a sum whose legs cannot be told apart) |
| the triage CLI | `dsql:DbConnectAdmin` | `admin` | everything — it applies the schema and it is the deletion path for `forget`/`wipe`/`analytics wipe` |

§8.5's promise — *the ingest path can create and count; it cannot read the corpus
or destroy anything* — used to be enforced by omitting `dynamodb:Query`/`Scan`/
`DeleteItem` from a policy. DSQL has one IAM action for data access, so the
property moved down a layer: the Lambda may only log in **as a named database
role**, and that role's `GRANT` list (bottom of `schema.sql`) is where the promise
now lives. Granting the Lambda `dsql:DbConnectAdmin` would hand a public write
endpoint superuser on the whole backlog. Never do it.

## One-time: the sub-account and the state backend

Already done for this product — recorded here so it can be redone or audited:

1. Create a dedicated account in AWS Organizations for the product.
2. Create a local profile that assumes an admin role in it. This repo commits
   **no profile name and no account id**; the examples below use `<profile>`.
3. Hand-create the state backend in that account, in **us-east-1** (a backend
   cannot bootstrap itself):
   - S3 bucket `eqcompanion-tf-state-dae027bf` — versioning **on**, Block Public
     Access all four flags, SSE-S3.
   - DynamoDB table `eqcompanion-tf-lock`, on-demand, partition key `LockID` (S).

Those names are hardcoded in the `backend "s3"` block in `versions.tf`. They are
physical names, not secrets: no account id appears anywhere in git.

> The lock table is the **last DynamoDB dependency in the tree** and it is
> Terraform's, not the product's. Terraform now deprecates `dynamodb_table` in
> favour of S3-native locking (`use_lockfile = true`), which would retire it —
> but that raises the required Terraform version and `.github/workflows/infra.yml`
> pins the CI toolchain, so it is a deliberate follow-up, not a drive-by.

## Deploy

```bash
export AWS_PROFILE=<profile>
cd infra

node build.mjs                     # BOTH zips FIRST — plan hashes them
terraform init                     # first run downloads providers + reads the backend
terraform plan  -var triage_principal_arn=arn:aws:iam::<acct>:user/<you>
terraform apply -var triage_principal_arn=arn:aws:iam::<acct>:user/<you>
```

`node build.mjs` now emits **two** bundles — `dist/submit.zip` and `dist/telemetry.zip` — and
both are hashed by the plan. A plan run without a build deploys nothing useful for either
function.

`alarm_email` defaults to `jmoyers+eqc@gmail.com`; override with
`-var alarm_email=...`. **Confirm the SNS subscription email after the first
apply** — until you click it, every alarm and budget alert goes nowhere.

Commit `.terraform.lock.hcl` (the provider checksum lock). Never commit
`*.tfstate`, `*.tfvars`, `tfplan` or `dist/`; `.gitignore` covers them.

After a successful apply:

1. `terraform output api_url` → paste into `FEEDBACK_API_URL` in
   `src/main/feedback/net.ts` and commit. It contains the API id, not the account
   id, and has to be in the client anyway.

2. **Step 2.5 — apply the schema. The stack does not work without this.**

   **Export first, then migrate.** `migrate` refuses to run unless an offline copy from the
   last six hours exists in `.triage/exports/` — take one with
   `npx tsx scripts/triage-feedback.mts analytics export --profile <profile>` (read-only, a few
   hundred KB, gzipped and checksummed). The same guard covers `analytics backfill-cohort |
   backfill-verify | backfill-swap`. `--no-export-check` overrides it and prints the refusal
   anyway; restore a copy with `analytics import <dir>` (JOS-399).

   ```bash
   npx tsx scripts/triage-feedback.mts migrate --profile <profile>
   ```

   `terraform apply` creates an **empty** cluster: there is no `aws_dsql_*`
   resource that runs DDL, and DSQL's IAM-token auth means Terraform would have to
   mint a token and speak the postgres wire protocol to do it. So the schema is a
   reviewable SQL file (`infra/schema.sql`) applied by a reviewable command.

   `migrate` connects as `admin`, splits the file, and runs **one statement per
   transaction** (a DSQL law: a transaction may carry only one DDL statement and
   may not mix DDL with DML). It is idempotent — anything already present is
   reported as `exists`, not an error — so re-run it after any schema change and
   after any apply that replaced the cluster.

   Indexes are created with `CREATE INDEX ASYNC` (DDL cannot lock in a distributed
   database) and finish in the background; `migrate` says so when it is done.

3. The endpoint is seeded **closed**, on purpose. Open it once you have smoke
   tested: `npx tsx scripts/triage-feedback.mts closed off --profile <profile>`.

## THE COHORT MIGRATION — EXACTLY WHAT TO RUN, IN ORDER

**This is the live cluster's current pending work, and it is a COPY, not a drop.** The telemetry
stack itself is deployed and the client is lit; what the cluster does not have is the `cohort`
key on the two counter tables (the v0.4.0 smoke answered `column "cohort" does not exist`, which
is the tell). Those counters have been accumulating behind a lit client since **2026-08-04**, so
they may hold **real users' rows and not only the owner's testing** — the earlier version of this
runbook said `DROP TABLE usage_daily` and re-migrate, and that was written when these tables were
believed never to have been created. It is wrong now. **We don't drop anything.**

**Every step below is safe to stop at.** Nothing is destructive until step 5, step 5 refuses
unless step 4 passed, and every command is idempotent and re-runnable.

`<profile>` is the deploy profile (`eqc`); `<acct>` is the account id (never committed). Run
everything from the repo root unless it says `cd infra`.

```bash
export AWS_PROFILE=<profile>
```

### 0. Look before you touch

```bash
npx tsx scripts/triage-feedback.mts closed --profile <profile>
npx tsx scripts/triage-feedback.mts analytics backfill-verify --profile <profile>
```

`closed` prints both kill switches. `backfill-verify` names the cluster's state in one line per
table — on a cluster that still has the pre-cohort shape it says `no staging table — run
backfill-cohort`, and on one that is already migrated it says `already swapped`. If it says the
latter for both tables, the migration is already done; skip to step 6.

### 1. Freeze the writers (no deploy, one statement)

```bash
npx tsx scripts/triage-feedback.mts analytics close --profile <profile>
```

The copy in step 3 is a **snapshot**: a batch landing between the page that read past it and the
swap would be missed. `backfill-cohort` **refuses to run** while the switch is open, so this is
not optional.

Nothing is lost by closing. The client treats `503` as *"not now"* and keeps its buffer
(`src/main/telemetry/net.ts`), so a close measured in minutes costs nothing. The buffer is a
500-event ring (`TELEMETRY_BUFFER_CAP`) that drops its oldest, so a close measured in **days**
would start costing a busy install its oldest events. Do the whole sequence in one sitting.

### 2. Additive schema only

```bash
npx tsx scripts/triage-feedback.mts migrate --refresh --profile <profile>
```

`--refresh` because `.triage/stack.json` may predate `telemetry_lambda_role_arn`; `migrate`
stops and says so rather than sending an unsubstituted `${...}` to the cluster.

This adds `analytics_install.cohort` (the one cohort column an `ALTER` can add — it is not in a
key) and creates the `telemetry_ingest` role and its grants if they are not there. **The two
counter tables will report `exists`** — that is `CREATE TABLE IF NOT EXISTS` meeting the old
shape, and it is exactly why the next step exists. Nothing here drops or rewrites anything.

### 3. Copy every row into the new shape

```bash
npx tsx scripts/triage-feedback.mts analytics backfill-cohort --profile <profile>
```

One command, and it prints what it did per table. What it actually does:

* Creates `usage_daily_v2` and `usage_funnel_daily_v2` — **the cohort-keyed shape, with the
  `CREATE TABLE` text taken out of `infra/schema.sql` itself** so the staging table cannot drift
  from the table the app reads. (A schema whose PRIMARY KEY no longer carries `cohort` is refused
  outright.)
* `GRANT SELECT, INSERT, UPDATE` on both to `telemetry_ingest`. Privileges attach to the object
  rather than to the name, so these survive the rename in step 6 — which is what stops the new
  Lambda's first batch from being a permission denied.
* Fills `analytics_install.cohort` from what each row already **states** (`channel = 'dev'`, or a
  hand mark from `owner-add`).
* Copies **every** counter row, in pages of 500 (DSQL caps a transaction at 3,000 modified rows),
  through the store's bounded, jittered `40001` retry, with `ON CONFLICT … DO UPDATE SET n =
  EXCLUDED.n` — **assignment, not addition**, so re-running it converges instead of doubling.

**How the cohort is derived, and its one honest limit.** A counter row carries no id (that is the
entire point of aggregating on arrival), so the only truthful source is `analytics_install`:

* a day whose span is covered **only** by owner installs (dev-channel, or hand-marked) is
  `owner` — nobody else can have produced those rows, which is a derivation, not a guess;
* a day that **any user-cohort install could have contributed to** is `user`. There is nothing in
  the row to split on, so the alternative would be inventing a number;
* a day no surviving install row covers is `user` — the same fail-safe every reader of a NULL
  cohort takes.

So on days where the owner and a real user were both present, the owner's own use stays folded
into the user cohort **forever**. That is the honest limit of pre-split aggregates, and it is
precisely why the split had to become part of the KEY going forward. Everything from the swap
onward is exact.

### 4. Read the proof

```bash
npx tsx scripts/triage-feedback.mts analytics backfill-verify --profile <profile>
```

Prints, per table, the **row count and the sum of `n`** on both sides. The old → new mapping is
one-to-one (the new key adds `cohort`, which is a function of `day`, to a key that was already
unique), so a correct copy matches **exactly** on both numbers. A row count alone cannot see a
mangled counter, which is why it prints both.

If anything says `MISMATCH`: nothing has been dropped. Re-run step 3 (it is idempotent) and
verify again.

### 5. Swap — the only destructive step, and it re-checks first

```bash
npx tsx scripts/triage-feedback.mts analytics backfill-swap --profile <profile>
```

It **re-runs the verification itself** (a swap that trusted a check somebody ran an hour ago is a
swap that trusts a stale fact) and **refuses on any mismatch, having touched nothing**. On
success, per table and one DDL per transaction:

```sql
DROP TABLE usage_daily;                        -- now redundant: its rows are in the copy
ALTER TABLE usage_daily_v2 RENAME TO usage_daily;
```

`ALTER TABLE … RENAME TO` is **documented supported syntax in Aurora DSQL** ("There is no effect
on the stored data" — the same page this file already cites for the absence of `DROP COLUMN`:
<https://docs.aws.amazon.com/aurora-dsql/latest/userguide/alter-table-syntax-support.html>). That
is why the final table names never change and no reader, constant or Lambda statement has to be
re-pointed anywhere.

**If it dies between the two statements**, the data is intact under `usage_daily_v2` and every
reader answers `42P01` — which the CLI and the Analytics tab both render as the named "this
cluster is not migrated" state, not as a crash. Re-run the same command; it finishes the rename.

### 6. Put the cohort-aware Lambda live

```bash
cd infra
node build.mjs                     # BOTH zips FIRST — the plan hashes them
terraform plan  -var triage_principal_arn=arn:aws:iam::<acct>:user/<you>
terraform apply -var triage_principal_arn=arn:aws:iam::<acct>:user/<you>
cd ..
npx tsx scripts/triage-feedback.mts migrate --refresh --profile <profile>
```

The apply is what replaces the telemetry bundle with the one whose `INSERT` names `cohort`. The
`migrate` after it is confirmatory — it re-asserts the grants (idempotent) and will report
everything as `exists`.

**Order matters, and it is the same rule this file states for removing a column, in the other
direction: schema first, then the bundle that writes it.** Deploying the new bundle before the
swap would have every batch fail `42703`; doing it after is why the switch stays closed until
step 7.

### 7. Re-open, and prove it end to end

```bash
npx tsx scripts/triage-feedback.mts analytics open --profile <profile>

curl -si -X POST "$(cd infra && terraform output -raw telemetry_api_url)" \
  -H 'content-type: application/json' \
  -d '{"v":1,"env":{"analyticsId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","appVersion":"0.4.0","channel":"dev","platform":"win32","tzOffsetBucket":0},"events":[{"ts":1,"ev":{"t":"sessionHeartbeat","uptimeMs":1000}}]}'
# expect: HTTP/2 202  {"ok":true,"accepted":1}

npx tsx scripts/triage-feedback.mts analytics digest --cohort all --profile <profile>
```

The `202` proves the route, the function, the DSQL connection, the config read and a cohort-keyed
UPSERT all work. `--cohort all` prints the two digests side by side — the legacy rows are in
there, under the cohort the backfill derived, and nothing sums them.

### 8. Mark your own installed copy

```bash
npx tsx scripts/triage-feedback.mts analytics owner-add <analyticsId> --profile <profile>
npx tsx scripts/triage-feedback.mts analytics owner-ls --profile <profile>
```

Your DEV builds tag themselves from `env.channel` and need nothing. The installed copy has no
server-side signal at all, by design — a prod payload from the author is deliberately
indistinguishable from anyone else's — so read its id out of the app itself, **Preferences →
Usage analytics → "Anonymous id"**, and mark it once. A rotated id is a NEW id and arrives
unmarked: run `owner-ls` after a rotation and re-add.

**The client is LIT (2026-08-04).** `TELEMETRY_API_URL` in `src/main/telemetry/net.ts` names
the live `/v1/telemetry` route, and `tests/telemetryNet.test.mts` pins the exact URL, the one
fetch site, and the consent gates. The owner-approved lighting commit rewrote `SECURITY.md`,
added the README paragraph, and regenerated `TELEMETRY.md`, exactly as the dark-build pins were
designed to force. Data flows once `analytics open` flips `telemetry_accepting` AND clients run
a build carrying the constant (v0.3.2+).

### First time on a FRESH cluster (no counter tables at all)

There is nothing to copy, so the migration above does not apply: `migrate` creates the two
tables in their cohort-keyed shape, `terraform apply` puts both bundles live, and `analytics
open` starts collection. `backfill-verify` says `neither table exists — this cluster needs
migrate, not a backfill`, which is the check that tells the two situations apart.


### Day-2 for the telemetry route

| Situation | Command |
| --- | --- |
| Stop collecting NOW | `triage-feedback analytics close` (one statement; **no deploy**) |
| Start collecting | `triage-feedback analytics open` |
| Tighten the per-id daily event cap | `UPDATE feedback_config SET max_events_per_id_per_day = N` — deploy-free |
| A deletion request for an analyticsId | `triage-feedback analytics wipe --id <analyticsId>` |
| The numbers, as text | `triage-feedback analytics digest [--days N] [--json]` — **user cohort by default** |
| …including your own use | `triage-feedback analytics digest --cohort all` (two digests, never summed) |
| The numbers, in the app | Triage → Analytics (dev builds only); "Include mine (split)" adds the owner readout |
| Mark / unmark your installed copy | `analytics owner-add <analyticsId>` / `owner-rm <analyticsId>` / `owner-ls` |
| "Is anyone using it right now" | the `eqcompanion-telemetry` CloudWatch dashboard |
| Read the handler's logs | `aws logs tail "$(terraform output -raw telemetry_log_group)" --follow` |

`analytics wipe --id` deletes the `analytics_install` row, which is the id's entire footprint.
The counters it contributed to are anonymous sums — `usage_daily` holds "37 map opens on
2026-08-04" with no id in the table — so there is nothing in them to attribute, and subtracting
a guess would corrupt a true number to satisfy a request the data does not contain.

### The user/owner split — whose use is in the numbers

The owner runs this app more than anyone, so their own use is signal about the *build* and
noise in every number about the *user base*. Every counter row therefore carries a
`cohort` ('user' or 'owner'), and **every read path defaults to `user`**. Nothing anywhere sums
the two: `--cohort all` prints two digests, and the tab renders two readouts.

Two mechanisms, because the two cases are genuinely different:

* **Dev builds tag themselves, server-side, with no client change.** `env.channel` has been in
  the telemetry envelope since the contract was written (`TELEMETRY.md` documents it), so the
  ingest handler derives the cohort from a field it already receives. Nothing new is
  transmitted for this feature.
* **The installed copy is marked by hand, once, by `analyticsId`.** A prod payload from the
  author is deliberately indistinguishable from anyone else's — that is what the id is for — so
  there is nothing to infer and any guess would mislabel a real user. `analytics owner-add`.

**FROM-MARKING-ONWARD.** Counters are anonymous sums with no id in them, so rows already
aggregated under `user` cannot be re-attributed when you mark an install, and are left alone.
The digest states this in its header on every render. **A rotated `analyticsId` is a new id and
arrives unmarked** — run `owner-ls` after a rotation and re-add.

**If a cluster already has the pre-cohort counter tables — and the live one does.** `cohort` is
part of the PRIMARY KEY of `usage_daily` and `usage_funnel_daily` (the `ON CONFLICT` target needs
it to be), and DSQL's `ALTER TABLE` cannot change a primary key — so unlike
`analytics_install.cohort`, there is no in-place migration for those two, and
`CREATE TABLE IF NOT EXISTS` silently reports `exists` against the old shape.

**The recovery is a COPY. Nothing is dropped until a verified copy exists** — the ordered
commands are the runbook at the top of this file (`analytics backfill-cohort` →
`backfill-verify` → `backfill-swap`). An earlier version of this paragraph said to
`DROP TABLE usage_daily` and re-migrate; that was written when these tables were believed never
to have been created, and it is wrong: they have been counting behind a lit client since
2026-08-04 and may hold real users' rows.

What the copy can and cannot recover: a row carries no id, so a **day** is labelled from what
`analytics_install` states about who could have reported it — owner only if no user-cohort
install's span covers that day, `user` otherwise. Days the owner shared with a real user stay
folded into `user`. That is the honest limit, and it is the reason the split is a KEY from the
swap onward rather than a filter applied at read time.

## PENDING: never lose the data (JOS-398) — **apply FIRST, then migrate**

Owner ruling 2026-08-16: the analytics data must never be lost. Two layers, both additive, and
they fail differently on purpose — `backup.tf` takes AWS Backup recovery points of the whole
cluster, `export.tf` writes a nightly row-level dump to S3 that anybody can read with `gunzip`.
The operational half (list, restore, drill) is the **Backup** section further down; this is the
deploy.

> **THIS ONE STEP ORDER IS THE REVERSE OF EVERY OTHER SECTION ON THIS PAGE, AND IT HAS TO BE.**
> Everywhere else the rule is *schema first, then the bundle that names it*, because a handler
> naming a column that does not exist is `42703` on every request. Here the schema statement is
> `AWS IAM GRANT analytics_export TO '${EXPORT_LAMBDA_ROLE_ARN}'`, and that ARN **does not exist
> until the apply creates the role** — `migrate` substitutes it from a Terraform output and stops
> with "run with `--refresh`" if it is missing. The reversal is safe here for a reason that does
> not generalise: the only thing that names the new database role is a function with **no public
> trigger**, whose first invocation is at 09:30 UTC, and whose failure is one alarm rather than an
> outage. Nothing user-facing changes in either order.

### 1. Build and apply

```bash
cd infra
node build.mjs                     # THREE zips now — submit, telemetry, export
terraform plan  -var triage_principal_arn=arn:aws:iam::<acct>:user/<you>
terraform apply -var triage_principal_arn=arn:aws:iam::<acct>:user/<you>
```

**What the plan must show — 23 resources to ADD, and NOTHING to change or destroy:**

| From | Added |
| --- | --- |
| `backup.tf` (7) | `aws_iam_role.backup`, its two managed-policy attachments, `aws_backup_vault.analytics`, `aws_backup_plan.analytics`, `aws_backup_selection.analytics`, `aws_cloudwatch_metric_alarm.backup_failed` |
| `export.tf` — bucket (6) | `aws_s3_bucket.archive` + `public_access_block` + `server_side_encryption_configuration` + `versioning` + `lifecycle_configuration` + `bucket_policy` |
| `export.tf` — identity (3) | `aws_iam_role.export`, `aws_iam_role_policy.export`, `aws_iam_role_policy_attachment.export_basic` |
| `export.tf` — function (2) | `aws_cloudwatch_log_group.export`, `aws_lambda_function.export` |
| `export.tf` — schedule (3) | `aws_cloudwatch_event_rule.export_nightly`, `aws_cloudwatch_event_target.export_nightly`, `aws_lambda_permission.export_events` |
| `export.tf` — alarms (2) | `aws_cloudwatch_metric_alarm.export_failed`, `aws_cloudwatch_metric_alarm.export_stale` |
| outputs | five new: `export_lambda_role_arn`, `archive_bucket_name`, `export_function_name`, `export_log_group`, `backup_vault_name` |

**`aws_lambda_function.submit` and `.telemetry` must show NO CHANGE AT ALL.** Nothing either of
them bundles was touched, and the zip is byte-deterministic, so `source_code_hash` is identical.
A plan that wants to redeploy either of them means a shared file moved and the diff is worth
reading before applying. Likewise: if the plan wants to **replace** the DSQL cluster, the logs
bucket, or any existing IAM role, stop — nothing in this change touches them.

### 2. Then the schema

```bash
# JOS-399's guard: `migrate` REFUSES without an offline copy from the last six hours.
npx tsx scripts/triage-feedback.mts analytics export --profile <profile>
npx tsx scripts/triage-feedback.mts migrate --profile <profile> --refresh
```

**Take the export first, and take it seriously** — this migration adds a role and thirteen grants
to the live cluster, which is exactly the class of change the guard was built for. (The escape
hatch is `--no-export-check`, which prints the refusal anyway; there is no reason to reach for it
here.)

`--refresh` is not optional either: there is a **new Terraform output**
(`export_lambda_role_arn`), and `.triage/stack.json` is a cache that is read back without
re-validating. Without it, `migrate` finds the unsubstituted `${EXPORT_LAMBDA_ROLE_ARN}` and stops
saying exactly this. It applies, all idempotent:

```sql
CREATE ROLE analytics_export WITH LOGIN;
AWS IAM GRANT analytics_export TO '<the export function's role ARN>';
GRANT SELECT ON feedback_config      TO analytics_export;   -- and twelve more, one per table
```

**SELECT and nothing else, on every table, with no `DELETE` and no grant on the two merge views.**
An export copies TABLES: a restore has to put a row back where it came from, and `usage_daily_all`
would hand back a sum whose two legs can no longer be told apart.

### 3. Confirm

```bash
# The export, on demand rather than waiting for 09:30 UTC.
aws lambda invoke --function-name "$(cd infra && terraform output -raw export_function_name)" /dev/null
aws logs tail "$(cd infra && terraform output -raw export_log_group)" --since 5m
ARCHIVE=$(cd infra && terraform output -raw archive_bucket_name)
aws s3 ls "s3://$ARCHIVE/exports/$(date -u +%F)/"
aws s3 ls "s3://$ARCHIVE/backlog/$(date -u +%F)/"
aws s3 cp "s3://$ARCHIVE/exports/$(date -u +%F)/manifest.json" - | head -40

# The backup, after the first 09:00 UTC run.
aws backup list-recovery-points-by-backup-vault \
  --backup-vault-name "$(cd infra && terraform output -raw backup_vault_name)" \
  --query 'RecoveryPoints[].[CreationDate,Status,BackupSizeInBytes]' --output table
```

The log's `export.table` lines carry a row count per table and never a row. The
`eqcompanion-analytics-export-stale` alarm sits in **ALARM until the first export emits
`ExportRows`** — that is correct rather than a misconfiguration, because until then there has not
been one.

**REHEARSED END TO END ON A REAL, EPHEMERAL DSQL CLUSTER** — `dzuag6oc2hgx5nczqvvbnte4ba`, created
and deleted for the ticket, with a throwaway bucket carrying the same policy. **Production was not
touched.** What was actually measured:

| Step | Result |
| --- | --- |
| `migrate` on a fresh cluster | 46 applied, 15 already present — 61 statements |
| The BUILT bundle (`dist/export.mjs`), connecting as `analytics_export` | `tables=13 rows=11 missing=[]` |
| Objects written | `exports/<day>/` **13 files** (12 tables + `manifest.json`), `backlog/<day>/` **2** (`report.json.gz` + its manifest) |
| The manifest | `clusterId=dzuag6oc2hgx5…`, `schemaRevision=61` (read from the schema bundled into the zip), a sha256 per file |
| Before | `usage_daily_all SUM(n)=65` · `usage_daily=3` · `usage_daily_sharded=3` · `perf_daily_all SUM(n)=6` · `report=1` |
| After DELETE FROM every table | `usage_daily_all SUM(n)=null` · everything 0 |
| `analytics import` (JOS-399's, checksums verified first) | `usage_daily_all SUM(n)=65` · `usage_daily=3` · `usage_daily_sharded=3` · `perf_daily_all SUM(n)=6` · `report=1` — **table for table, byte for byte** |
| Importing the same directories AGAIN | identical — idempotent |
| The read-only role | `42501 permission denied` to INSERT, UPDATE, DELETE **and** to a SELECT on `usage_daily_all` (ungranted on purpose); SELECT on `report` and the counters allowed |
| `PutObject` with no encryption header | refused — *"explicit deny in a resource-based policy"*. The same put with `AES256` succeeded |

The restore is what makes this a backup rather than a copy, and it was run against the artifact
the apply uploads rather than against the TypeScript.

**Rollback** is `terraform destroy -target` on the new resources, and it is not needed for
anything: nothing in this change alters an existing resource, an existing bundle, or an existing
grant. The `analytics_export` role can be left in place — a role nothing logs in as does nothing.

## PENDING: sharded counters (JOS-394) — schema, then readers, then ONE apply

The OCC-conflict alarm (`eqcompanion-feedback-dsql-occ-conflicts`) fired all day. **Measured on
the live stack 2026-08-16:** ~1,350 telemetry requests per 5 min (4.5 RPS, flat, 3-4 concurrent
Lambdas), 60-90 OCC conflicts per 5 min (~5% of writes, all on the `counters` transaction), a
retry ladder over two hours of 1,634 first-attempt conflicts → 104 second → 6 third → **zero
exhausted**, zero API 5xx, and 4xx at 2-12 per 5 min. Nothing was being lost. The cause is
structural: every install increments the SAME rows, and DSQL is optimistic.

The fix is a `shard` column (32 ways, **random per request — never a hash of the analyticsId**),
two new tables, two merge views, a full-jitter retry, a rescoped alarm pair and route headroom.
`infra/schema.sql` carries the reasoning at the tables; this is the runbook.

**Nothing is dropped and there is no backfill.** `usage_daily` and `perf_daily` freeze at
cutover with every row they hold, and `usage_daily_all` / `perf_daily_all` add them back to
every read. The cutover DAY lands half in each table, which is exactly what the views are for.

**REHEARSED ON A REAL DSQL CLUSTER** (an ephemeral one, created and deleted for the ticket —
prod was not touched): DSQL accepts `CREATE VIEW` over a grouped `UNION ALL`, accepts
`CREATE OR REPLACE VIEW` and `DROP VIEW`, answers a repeat `CREATE VIEW` with `42P07` (so the
plain form in `schema.sql` is idempotent under `migrate`), and pushes `WHERE day >= $1 ORDER BY
day LIMIT $2` through the view. The real ingest handler, connected as `telemetry_ingest`,
answered `202` and left 112 sharded rows across 8 distinct shards; the view returned
`11 frozen + 8 sharded = 19` for one counter, as a JS number. Eight concurrent writers × 12
upserts: **64 conflicts on one hot row, 8 with the 32-way shard.**

### 1. Schema first — it is additive, and the readers below need the views

```bash
npx tsx scripts/triage-feedback.mts migrate --profile <profile>
```

Applies, all idempotent (`exists` on a re-run):

```sql
CREATE TABLE IF NOT EXISTS usage_daily_sharded (…, PRIMARY KEY (shard, day, cohort, metric, dim));
CREATE TABLE IF NOT EXISTS perf_daily_sharded  (…, PRIMARY KEY (shard, day, cohort, window_mode, machine_class, locked, stall_bucket, tail_bucket));
CREATE VIEW usage_daily_all AS SELECT …, SUM(n)::bigint AS n FROM (usage_daily UNION ALL usage_daily_sharded) …;
CREATE VIEW perf_daily_all  AS …;
GRANT SELECT, INSERT, UPDATE ON usage_daily_sharded TO telemetry_ingest;
GRANT SELECT, INSERT, UPDATE ON perf_daily_sharded  TO telemetry_ingest;
```

**Why first:** the new bundle's `INSERT` names the sharded tables unconditionally, so deploying
it against a cluster without them (or without the grants) is `42P01`/`42501` on **every batch**,
instantly, with the endpoint open — the same trap the perf-cube and inventory sections above
document. `SUM(n)::bigint` is not decoration: an uncast `SUM(bigint)` is NUMERIC, which no type
parser covers, and the readouts would silently render every counter as 0.

**No `DELETE` in the grants, and no grant on the views.** The Lambda only adds; the only reader
of the merged views is the triage side, which connects as `admin`.

### 2. The readers are already switched — and they were safe to switch first

`src/main/triage/usageStore.ts` reads `usage_daily_all` / `perf_daily_all`, which every other
reader (`triage-feedback analytics digest`, the Analytics tab, `smoke-feedback verify-telemetry`)
goes through. **A view equals the old table until the Lambda cuts over**, so this half can ship
in any order — and after step 1 it is what proves the views answer before anything depends on
them. A cluster that has not run step 1 answers `42P01` naming `usage_daily_all`, which the CLI
and the tab already render as "this cluster is not migrated" rather than as a crash.

`scripts/analyticsBackfill.mts` deliberately still names the physical tables: it is the one-off
cohort re-key, and its whole job is to copy, verify and swap a TABLE. Pointing it at a view
would be meaningless.

### 3. Bundle and Terraform, in one apply

```bash
cd infra
node build.mjs                     # BOTH zips FIRST — the plan hashes them
terraform plan  -var triage_principal_arn=arn:aws:iam::<acct>:user/<you>
terraform apply -var triage_principal_arn=arn:aws:iam::<acct>:user/<you>
```

**What the plan should show — six changes and no destroys:**

| Resource | Change |
| --- | --- |
| `aws_lambda_function.telemetry` | `source_code_hash` only (the sharded `INSERT`s + the shard) |
| `aws_lambda_function.submit` | `source_code_hash` only (it bundles `db.ts`, which gained the retry metric) |
| `aws_cloudwatch_metric_alarm.dsql_occ_conflicts` | **in-place update**: `metric_query` blocks replace the single metric — conflicts / telemetry invocations > 0.25 over 3 × 5-min periods |
| `aws_cloudwatch_metric_alarm.telemetry_db_retry_exhausted` | **new** — `EQCompanion/Telemetry` `DbRetryExhausted >= 1` |
| `aws_apigatewayv2_stage.default` | throttles: stage 5 → 15 rps / burst 10 → 30, `/v1/telemetry` 5 → 10 rps / burst 10 → 20 |
| everything else | no change |

If the plan wants to **replace** the DSQL cluster, the S3 bucket, or any IAM role, stop: nothing
in this change touches them.

### 4. Confirm

```bash
aws logs tail "$(cd infra && terraform output -raw telemetry_log_group)" --since 5m
npx tsx scripts/triage-feedback.mts analytics digest --cohort all --profile <profile>
```

The log's `telemetry.accepted` lines are unchanged (they carry counts, never a shard). The
digest is the real check that the views merge: it reads through `usage_daily_all`, so the
numbers must be continuous across the cutover — a drop to "today only" would mean a reader is
still on a frozen table. Watch `OccConflicts` for the following hour; the ratio should fall from
~5% toward ~0.2%, and the alarm should leave ALARM within three periods.

**Rollback** is the bundle, not the schema: `terraform apply` an earlier zip and the handler
writes `usage_daily` again, which the views still merge. The sharded rows written meanwhile stay
readable through the views. Nothing needs to be dropped or copied in either direction.

## PENDING: the perf cube (JOS-372) — two steps, in this order, and NO client step

`usage_daily` carries one dimension per row, so it can count stalls and can never say whether
they cluster on exclusive-fullscreen installs, on small boxes, or while an overlay is locked.
`perf_daily` is the one cube that can: five closed dims wide, one row per session report that
carried a live stall reading, and **still no raw event store**. The reasoning and the cardinality
budget are written where the table is, in `infra/schema.sql`.

**Schema-first**, exactly as the inventory columns were, and for the same reason: `INSTALL_SQL`
in `infra/lambda/telemetry.ts` names `machine_class, window_mode` unconditionally, and naming a
column that does not exist is `42703` on **every batch**, instantly, with the endpoint open.

1. **Schema.** `npx tsx scripts/triage-feedback.mts migrate --profile <profile>` — it applies, all
   idempotent (`exists` on a cluster that already has them):

   ```sql
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
   ALTER TABLE analytics_install ADD COLUMN machine_class text;
   ALTER TABLE analytics_install ADD COLUMN window_mode text;
   GRANT SELECT, INSERT, UPDATE ON perf_daily TO telemetry_ingest;
   ```

   `SELECT` rides along with `INSERT`/`UPDATE` because `ON CONFLICT DO UPDATE SET n = perf_daily.n
   + EXCLUDED.n` reads the existing row to evaluate the sum. **No `DELETE`**, like every other
   telemetry grant. The TRIAGE reader needs no grant at all — it connects as `admin`.

   The primary key is **seven columns**. That is one more than `usage_funnel_daily`'s six, so it is
   the one statement here worth watching the `migrate` output for; the runner prints the failing
   statement rather than half-applying anything.

2. **Infra.** `node infra/build.mjs` (THE DEPLOY LAW — the plan hashes the zips), then
   `terraform plan` / `terraform apply`. Only `source_code_hash` moves: no new resource, no new
   permission, no Terraform change of any kind. The bundle is the telemetry Lambda, which then
   starts writing the cube and the two install columns.

**There is no client step, and there cannot be one to wait for.** Nothing new crosses the wire:
both dims are derived **server-side** from `setupSnapshot` fields that shipped with JOS-364, and
the stall/tail/state riders shipped with JOS-367. A client that predates either simply produces
`unknown` dims, which is a real class in the cube rather than a missing value.

**NO BACKFILL IS POSSIBLE.** The pipeline keeps no raw events (plan T6), so yesterday's heartbeats
do not exist in any form that could be re-folded. The table starts on the day step 2 lands, and
both readouts (Triage → Analytics → "Stalls by", and `analytics digest`) say "no rows in this
window" rather than printing zeros.

**Reading it:** `triage-feedback analytics digest` prints the three cross-tabs under the LIVE
SESSIONS section — user cohort by default, `--cohort all` for both side by side, and as everywhere
else nothing is ever summed across cohorts *or* across the three cuts (they are the same reports
sliced three ways).

## PENDING: the inventory attachment (JOS-296) — three steps, in this order

A bug report can now carry a **second** attachment beside the log slice: the player's
`/outputfile inventory` dump, gzipped, on its own presign, under its own `inventory/` prefix.
The client half is on `main`; **nothing below has been applied yet.**

Adding a column is the **schema-first** order (the section below explains why removing one is
the reverse), and the client is a third step behind both:

1. **Schema.** `npx tsx scripts/triage-feedback.mts migrate --profile <profile>` — applies
   `ALTER TABLE report ADD COLUMN inventory_json text` and `… inventory_key text`. Idempotent;
   a cluster that already has them reports `exists` (42701).
   *Why first:* the new handler's `INSERT` names both columns unconditionally, and naming a
   column that does not exist is `42703` on **every** submit, instantly, with the endpoint open.

2. **Infra.** `node infra/build.mjs` (THE DEPLOY LAW — the plan hashes the zips, so a plan run
   without a build deploys nothing), then `terraform plan` / `terraform apply`. Three things
   change beside the bundle, and each is additive:
   - `iam.tf` — the ingest role may now presign `inventory/*` as well as `logs/*`, and the
     triage role may Get/Delete/List it. Presigning is bounded by what the signer itself may
     `PutObject`, so this list *is* the set of paths a client can be granted.
   - `s3.tf` — a **second** lifecycle rule, `expire-inventory-dumps`, on the same window. The
     existing rule filters on `logs/` and would never have touched the new prefix, so without
     this the dumps would live forever.
   - `lambda.tf` — untouched; only `source_code_hash` moves.

3. **Client.** Only then does a release carrying the new field go out. A client that declares an
   `inventory` attachment to a server without the columns gets a 500 on every report; one that
   declares it to a server without the presign permission uploads nothing and says it did.
   The reverse order is safe in the other direction: the new server accepts an old client
   unchanged, because `inventory` is an **additive optional** field and
   `FEEDBACK_API_VERSION` deliberately stays `1` (a bump is a hard gate — see the constant's
   note in `src/shared/feedback.ts`).

Smoke it with the local stack first (`npm run dev:stack`), which mints the same two presigns and
enforces the same policy: `tests/devFeedbackServer.test.mts` covers both legs.

## Removing a column: the ordering, and what DSQL will not do

**THE BUNDLE GOES FIRST, THEN THE SCHEMA.** A running Lambda that still names a
column in its `INSERT` starts failing with `42703 undefined_column` the instant
that column disappears — every submit, immediately, with the endpoint open. So:

1. `npm run build` in `infra/`, `terraform apply` — the new bundle is live and its
   `INSERT` no longer names the column.
2. *Then* change the live schema.

Reversing the two turns a cleanup into an outage. Adding a column is the opposite
order (schema first, then the bundle that writes it), for the same reason.

**`title` and `contact` are the worked example, and step 2 is blocked.** Both left
the wire contract, then `schema.sql`, then every reader — so a stack migrated from
today's `schema.sql` never has them. A cluster migrated *before* that still does,
and **Aurora DSQL cannot drop a column**: its documented `ALTER TABLE` grammar has
no `DROP [COLUMN]` action at all (it has `DROP DEFAULT`, `DROP NOT NULL`,
`DROP EXPRESSION`, `DROP IDENTITY` and `DROP CONSTRAINT` — and not that one). See
<https://docs.aws.amazon.com/aurora-dsql/latest/userguide/alter-table-syntax-support.html>.
Putting the statement in `schema.sql` anyway would fail the whole `migrate` run on
a syntax error, so it is not there.

What *is* available is destroying the values, which is the point of the exercise:

```sql
UPDATE report SET title = NULL, contact = NULL
 WHERE title IS NOT NULL OR contact IS NOT NULL;
```

Run it once, as `admin`, against a cluster that predates the change — never as part
of `migrate`, because on a cluster built from today's `schema.sql` those column
names do not resolve. It is idempotent (the `WHERE` makes a re-run touch nothing)
and it is bounded by DSQL's **3,000-modified-rows-per-transaction** cap: if the
backlog is ever larger than that, run it in `report_id`-keyed batches. Afterwards
the columns are empty shells — no reader anywhere names them — and the physical
drop stays open until DSQL grows the grammar for it.

## Validate without touching the cloud

Exactly what CI runs. No credentials, no state, no lock:

```bash
cd infra
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
node build.mjs
```

Note what this does **not** cover: `schema.sql` is never executed by CI (there is
no cluster to execute it against), so a SQL typo surfaces at `migrate` time. That
is the same trade as every migration in every repo, and `migrate` stops on the
offending statement and prints it.

## What a client sends is never trusted — where each rule lives

Sanitization used to be entirely **client-side**: `src/shared/logScrub.ts` and the
bounds in `src/shared/feedback.ts` both run in the app before a byte leaves the
machine, and the server trusted that an honest client had run them. A hostile or
buggy client is not obliged to. The rules below close that at every boundary we
actually control; each is enforced in code, and the code says so at the site.

| Boundary | Rule | Where |
| --- | --- | --- |
| Raw HTTP body, both routes | a **NUL byte anywhere** is refused *before* `JSON.parse` — step 1.5, right after the size check | `lambda/submit.ts`, `lambda/telemetry.ts`, `hasNulByte` in `src/shared/sanitizeText.ts` |
| `draft.description` (multi-line prose) | control characters are **STRIPPED**: whole ANSI/VT escape sequences, C0 minus TAB/LF, DEL, C1, and the zero-width/BiDi/BOM class. CRLF and CR normalize to LF. Then trim, then the length bound | `validateDraft` in `src/shared/feedback.ts` |
| `env.*` free-form strings (`platform`, `osRelease`, `arch`, `electron`, `chrome`, `node`) | **any** control or invisible character is **REJECTED** `400 invalid_payload`, naming the field. These are `os.release()` and `process.versions.*`; none can legitimately hold one | `validateEnv` in `src/shared/feedback.ts` |
| `appVersion`, `installId`, `clientReportId`, `log.sha256` | already regex-pinned to closed character sets, and JS `$` matches only end-of-input — no extra rule, deliberately | `src/shared/feedback.ts` |
| Every telemetry field | the schema has **no free-text slot at all**: every string is enum- or regex-bound, and the validators *construct* the value field by field rather than sanitizing it | `src/shared/telemetryValidate.ts`, pinned by `tests/wireSanitize.test.mts` + `tests/telemetryContract.test.mts` |
| The uploaded log slice | the presign policy pins the **key, size and content-type — it cannot pin the content**. So a downloaded slice is **re-scrubbed on read** with the app's own shared scrubber, and each line is sanitized, before it touches the owner's disk. The delta is reported: the CLI prints it, the triage tab shows a warning chip. **The S3 object is left untouched — it is the evidence** | `downloadSlice` in `src/main/triage/store.ts`, `rescrubSlice` in `src/main/triage/rows.ts` |
| Anything printed at the owner | every client-supplied string is stripped of ANSI escapes and control characters before it reaches the terminal or the triage tab — a report must not be able to retitle the operator's window, clear their screen, or write their clipboard via OSC 52 | `sanitizeOneLine`/`sanitizeMultiline` in `src/shared/sanitizeText.ts`, applied in `store.ts` (CLI) and `rows.ts` (tab) |

**Strip vs reject is not an inconsistency.** Removing a control character is
*normalization*, the same act as the `trim` the validators have always done —
nobody types a NUL into a bug report, so nothing the user wrote is shortened, and
REJECT-NEVER-TRUNCATE (which is a law about **length**) is untouched. A single-line
runtime string is different: there is no benign reading of an ESC in `os.release()`,
so the honest answer is a 400 rather than a quiet repair.

**The re-scrub delta is a signal, not noise.** An honest client already ran the
identical module, so its delta is **zero**. A non-zero one means the object in the
bucket holds third-party chat our client would have removed — evidence that the
upload did not come from our client. `triage-feedback show <id>` prints it; the
triage tab shows it above the slice.

## Day-2 operations

| Situation | Command |
| --- | --- |
| Active flood — stop everything now | `triage-feedback closed on --message "..."` (one statement; **no deploy**) |
| One install spamming | `triage-feedback block <installId> --reason "..."` |
| Tighten the daily quota | `UPDATE feedback_config SET max_per_install_per_day = N` — deploy-free |
| Deletion request | `triage-feedback forget <reportId>` (the slice) / `wipe --install <id>` (everything) |
| Schema change | edit `schema.sql`, then `triage-feedback migrate` |
| **Data is wrong / a migration went bad** | the **Backup** section above — path A restores the cluster, path B reloads rows with `analytics import`. Do the dry run first |
| **Prove the backup still works** | the drill in the Backup section, against an ephemeral cluster. Never against prod |
| Read the handler's logs | `aws logs tail "$(terraform output -raw lambda_log_group)" --follow` |
| Who hit us | `aws logs tail "$(terraform output -raw api_access_log_group)"` (source IPs, 14-day retention, incident-only) |

The kill switch and the quota live in the database precisely so that answering
abuse never requires a release. The app fetches no configuration at any point —
the kill switch rides in the submit response.

## Backup — what runs, how to read it, how to restore, and the drill

Two layers. **Neither is a substitute for the other**, and the split is the design:

| | AWS Backup (`backup.tf`) | The nightly export (`export.tf`) |
| --- | --- | --- |
| What it holds | the WHOLE cluster, as a recovery point | every table's rows, as gzipped JSON |
| When | **09:00 UTC** daily (kept 35 days) and the **1st of the month** (kept 12 months) | **09:30 UTC** daily |
| Where | vault `eqcompanion-analytics` | `s3://eqcompanion-analytics-archive-<acct>/` — **two prefixes**, each a complete export with its own `manifest.json`: `exports/<YYYY-MM-DD>/<table>.json.gz` (the counters, kept) and `backlog/<YYYY-MM-DD>/report.json.gz` (the one human-text table, 90 days) |
| Restores | to a **NEW cluster** — AWS Backup cannot restore DSQL in place, which is also why it is safe | into any cluster, with the SAME `analytics import` the operator-side export uses |

**THE NIGHTLY JOB WRITES JOS-399's FORMAT, EXACTLY.** A gzipped JSON array with one row per line
plus a checksummed manifest — byte-for-byte what `triage-feedback analytics export` puts on the
operator's own disk. So `aws s3 sync` of one night into a directory and then
`analytics import <dir>` restores it with no S3-specific code anywhere: checksums verified before
the first INSERT, then the same idempotent keyed upsert. There is ONE importer, `analytics import`,
and both backup tickets use it (`scripts/analyticsImport.mts`).

**WHY TWO PREFIXES.** An S3 lifecycle filter is a prefix and has no wildcard, so it cannot pick one
file out of a per-night directory. `report` is the only table holding anything a person wrote and
SECURITY.md promises a deletion request is honoured, so it needs a rule of its own — which means a
prefix of its own. The object layout is shaped by the retention promise rather than the other way
round.
| Answers | "the cluster is wrong and I want yesterday's, all of it" | "one table is wrong", "I want to look without standing up a cluster", "the recovery point is the thing that is missing" |
| Alarms | `eqcompanion-backup-jobs-failed` | `…-analytics-export-failed` (it ran and broke) and `…-analytics-export-stale` (it never ran) |

**What each protects against, stated plainly.** DSQL's own multi-AZ durability answers a disk
dying and always did. It faithfully replicates a **bad migration**, a `scripts/analyticsBackfill.mts`
run against the wrong table, a fat-fingered `DROP`, and an account-level event. Those are what
these two are for.

### Look before you touch

```bash
export AWS_PROFILE=<profile>
VAULT=$(cd infra && terraform output -raw backup_vault_name)
ARCHIVE=$(cd infra && terraform output -raw archive_bucket_name)

# Recovery points, newest first.
aws backup list-recovery-points-by-backup-vault --backup-vault-name "$VAULT" \
  --query 'reverse(sort_by(RecoveryPoints,&CreationDate))[].[CreationDate,Status,RecoveryPointArn]' \
  --output table

# Last night's export, both prefixes, and what each contained.
DAY=$(date -u +%F)
aws s3 ls "s3://$ARCHIVE/exports/$DAY/"
aws s3 cp "s3://$ARCHIVE/exports/$DAY/manifest.json" - | head -60
aws s3 cp "s3://$ARCHIVE/backlog/$DAY/manifest.json" - | head -20
```

A manifest is the index: per table, the file, the row count, the compressed size and a sha256 of
the bytes in the object. It also carries `schemaRevision` (the statement count of the
`infra/schema.sql` the deployed bundle was built from) and a `missing` list — tables the schema
declares that the cluster answered `42P01` for, which is a genuinely different fact from "empty"
and which a missing file alone could not tell you. It is the fastest way to answer "did last
night's export actually contain everything" without downloading a byte.

### Restore path A — AWS Backup, to a NEW cluster

Use this when the whole cluster is suspect. It cannot damage the live one: AWS Backup restores
DSQL to a **new** cluster with a **new identifier**, so nothing is overwritten and the decision to
switch over stays yours.

```bash
RP=<the RecoveryPointArn from the listing above>

# The metadata keys a DSQL restore takes are read from the recovery point rather than guessed —
# AWS documents this call for exactly that reason, and the set has changed before.
aws backup get-recovery-point-restore-metadata --backup-vault-name "$VAULT" --recovery-point-arn "$RP"

aws backup start-restore-job \
  --recovery-point-arn "$RP" \
  --iam-role-arn "arn:aws:iam::<acct>:role/eqcompanion-backup-role" \
  --resource-type DSQL \
  --metadata '<the keys the call above returned, with deletionProtectionEnabled true>'

aws backup describe-restore-job --restore-job-id <id>       # until Status is COMPLETED
```

**Then point the readers at it.** `cluster_endpoint` is derived from the cluster identifier
(`dsql.tf`), and every reader — the triage CLI, the app's Analytics tab, `analytics digest` —
resolves it through the **cache** `.triage/stack.json`, which is gitignored and is a cache rather
than a contract. So:

1. Edit `cluster_endpoint` in `.triage/stack.json` to `<new-identifier>.dsql.us-east-1.on.aws`.
2. `npx tsx scripts/triage-feedback.mts analytics digest --cohort all --profile <profile>` and read
   the numbers. **Verify before adopting.**
3. Only then decide whether to adopt it permanently, which is a Terraform decision (import the new
   cluster over `aws_dsql_cluster.feedback`, or move the rows across with path B) and not
   something to do at the same time as reading the data.

The two Lambdas still point at the OLD cluster until an apply moves them — deliberately. A restore
that silently redirected the public ingest endpoints would be a second incident.

### Restore path B — reload from S3

Use this when one table is wrong, when the damage is recent and narrow, or when there is no usable
recovery point. It writes into whatever cluster `.triage/stack.json` names, so **check that
first**.

**Each prefix is its own export**, with its own manifest, so each is one `sync` and one `import`.
Restore the counters, the backlog, or both — nothing depends on the other.

```bash
DAY=2026-08-16

# The counters, the install rows and the config.
aws s3 sync "s3://$ARCHIVE/exports/$DAY/"  .triage/restore-counters
npx tsx scripts/triage-feedback.mts analytics import .triage/restore-counters --dry-run --profile <profile>
npx tsx scripts/triage-feedback.mts analytics import .triage/restore-counters --profile <profile>

# The backlog, if that is what was lost.
aws s3 sync "s3://$ARCHIVE/backlog/$DAY/" .triage/restore-backlog
npx tsx scripts/triage-feedback.mts analytics import .triage/restore-backlog --profile <profile>
```

**Always `--dry-run` first.** It re-computes every file's sha256 against the manifest and counts
the rows without issuing a statement, so a truncated download is discovered before the first
INSERT rather than three tables into the restore.

Three properties worth knowing before you run it:

- **It verifies before it writes.** A checksum mismatch stops the whole run having touched
  nothing, and says so.
- **It is idempotent.** Every write is `ON CONFLICT (<primary key>) DO UPDATE SET <every non-key
  column> = EXCLUDED.<column>` — assignment, never the ingest path's addition — so running the
  same directory in twice leaves the cluster identical. That is what makes "it died halfway, just
  run it again" a safe instruction.
- **It restores TABLE FOR TABLE.** `usage_daily`'s rows go back to `usage_daily` (the frozen
  pre-shard table) and `usage_daily_sharded`'s go back carrying their own shards. Because
  `usage_daily_all` is the two summed, that is the only routing that cannot double a counter. (An
  export taken from the merged VIEW has no shard column at all, and those rows land under shard 0 —
  `scripts/analyticsImport.mts` handles both spellings.)
- **The switches are not restored for you.** `feedback_config` comes back as it was exported, so
  check `triage-feedback closed` afterwards and set both switches deliberately.

### The drill — run it against an ephemeral cluster, not against prod

A backup nobody has restored is a hypothesis. This is the whole loop, and it is what was run to
land JOS-398 — **last run 2026-08-17**, cluster `dzuag6oc2hgx5nczqvvbnte4ba`, created and deleted
for the ticket. Take the numbers from production BEFORE you start, so step 6 has something to
compare against.

1. **Stand one up.** `aws dsql create-cluster --no-deletion-protection-enabled --tags Ephemeral=true`
   — note the identifier, and wait for `aws dsql get-cluster --identifier <id> --query status` to
   read `ACTIVE` (a minute or two).
2. **Point a COPY of the cache at it.** `cp .triage/stack.json .triage/stack.prod.json` first, then
   edit `cluster_endpoint` to `<new-id>.dsql.us-east-1.on.aws`. Getting this backwards is the one
   way this drill can touch production, so do it before anything else and read the file back.
3. **Migrate.** `npx tsx scripts/triage-feedback.mts migrate --profile <profile> --no-export-check`
   — a fresh cluster has nothing to export, which is the one honest use of that flag. Expect **46
   applied, 15 already present** on today's schema.
4. **Pull last night down**, both prefixes:

   ```bash
   DAY=$(date -u -d yesterday +%F)
   aws s3 sync "s3://$ARCHIVE/exports/$DAY/"  .triage/drill-counters
   aws s3 sync "s3://$ARCHIVE/backlog/$DAY/" .triage/drill-backlog
   ```

5. **Dry run, then import.** `analytics import .triage/drill-counters --dry-run` must verify every
   checksum and name every table you expected; then the same without the flag, and again for the
   backlog directory.
6. **Read it back.** `npx tsx scripts/triage-feedback.mts analytics digest --cohort all --days 30 --profile <profile>`
   against the drill cluster. The numbers must match what the same command printed against
   production for the same window — that comparison **is** the drill's pass condition, and it is
   the only step that proves the export is COMPLETE rather than merely present. A restore that
   loads without error and is missing a table still loads without error.
7. **Tear it down and put the cache back.** `aws dsql delete-cluster --identifier <id>`, confirm
   `status` reads `DELETING`, then `mv .triage/stack.prod.json .triage/stack.json`. Do the move
   even if the drill failed.

Do it after any change to `infra/schema.sql`, to `src/shared/analyticsSchema.ts`, or to either
half of the pair — and note the date above when you do.

## Retention, and the one thing DSQL does not do

| Data | Retention | Mechanism |
| --- | --- | --- |
| Report row | indefinite — it *is* the backlog | none |
| `usage_daily(_sharded)` / `perf_daily(_sharded)` / `usage_funnel_daily` | indefinite | none — they are anonymous daily sums with no id in them, and the whole point of the aggregates-on-arrival design (plan T6) is that there is no per-user trail to expire. The `shard` column (JOS-394) is a random integer drawn per request, not a function of any id, and readers see it summed away by `usage_daily_all` / `perf_daily_all` |
| `analytics_install` | indefinite; deleted on request | `triage-feedback analytics wipe --id`. One row per analyticsId, and the only per-id row this feature has |
| Log object | 90 days | **S3 lifecycle — unchanged**; `triage-feedback forget <id>` deletes one on request |
| Quota counters (3 d), idempotency keys (7 d), dedupe probes (2 d) | lazy | swept by the ingest handler |
| Lambda / API access logs | 14 days | CloudWatch retention |
| **`exports/`** — the nightly counter archive (JOS-398) | indefinite, GLACIER_IR after 30 days; superseded versions 365 days | S3 lifecycle on `eqcompanion-analytics-archive-<acct>`. They are anonymous daily sums with no id in them, and "the series starts 2026-08-04 and there will never be earlier data" is what makes an old copy worth keeping |
| **`backlog/`** — the ONE prefix that expires | **90 days** | The same window the attached log slice already has, and it is a separate prefix precisely so a lifecycle rule can reach it: `report` is the only table holding human-written text, and a versioned archive with no expiry would turn SECURITY.md's deletion promise into "the live row goes and a copy of your words stays forever" |
| **AWS Backup recovery points** | daily 35 days, monthly 12 months | `backup.tf`. They hold the whole cluster, so a deleted report can survive in a monthly point for up to a year. That is inherent to having backups at all; SECURITY.md **states** it rather than leaving it to be discovered |

**DynamoDB had TTL. DSQL has nothing.** So the three counter tables are swept by
the ingest path itself (`infra/lambda/db.ts`), immediately after a submit clears
the quota gate: at most once per 10 minutes per warm container, at most 200 rows
per table per pass, and every failure logged and swallowed. The bound is not
politeness — DSQL caps a transaction at 3,000 modified rows, so an unbounded
`DELETE` would eventually *fail* rather than merely be slow.

The consequence, stated plainly: expired rows go away **as traffic flows**, not on
a clock. If ingest goes idle they linger. That costs a few kilobytes and leaks
nothing (an installId is an anonymous token, §9.3), and the alternative — an
EventBridge rule plus a second Lambda to delete six rows a week — is more moving
parts than the problem deserves.

## Teardown

`terraform destroy` **will fail**, four times over and on purpose: the logs
bucket, the **archive bucket**, the **backup vault** and the cluster all carry
`lifecycle { prevent_destroy = true }`, and the cluster also has service-side
`deletion_protection_enabled`. A teardown cannot take user-submitted evidence,
the whole backlog, **or the backups of both** with it. Undoing them is the
deliberate act that makes a real teardown possible. Do it in a commit, not in a
panic — and note that the archive bucket and the vault are the two whose whole
reason for existing is that the rest of this stack can be lost.

## Cost shape

DSQL bills request-based DPU plus storage — nothing to provision, nothing to
autoscale, no capacity setting that turns a flood into a bill (the same property
`PAY_PER_REQUEST` bought before). The free tier is 100k DPU and 1 GB/month, which
is orders of magnitude past this product's volume. Around it: a 2 rps route
throttle, reserved concurrency 5, a 2 MB S3-enforced upload cap, 90-day object
expiry and 14-day log retention. An attacker saturating the route throttle for a
full month is roughly 5.2 M requests — about $5 of API Gateway plus bounded
Lambda/DSQL, under the $10 budget and alarmed within five minutes.

## Gotchas

- **Build before you plan.** `source_code_hash` reads `dist/submit.zip`,
  `dist/telemetry.zip` and `dist/export.zip`. All three are guarded by `fileexists()` so
  `terraform validate` works on a clean checkout, but a plan without a build deploys nothing
  useful.
- **A DELETION REQUEST IS TRUE IN THE DATABASE IMMEDIATELY AND EVERYWHERE WITHIN 90 DAYS.**
  `forget` / `wipe` remove the live row and the S3 object, as they always have — but since
  JOS-398 a copy of the `report` row also sits in each nightly export, and the whole cluster sits
  in a monthly recovery point. The `backlog/` prefix therefore expires at 90 days (the one lifecycle
  carve-out in the archive bucket), and SECURITY.md states both windows in the user's own words.
  Raising `archive_backlog_retention_days` is a change to a published promise, not a tuning knob.
- **The export role can read everything, and that is the point of it having no trigger.**
  `analytics_export` holds SELECT on every table — the only identity in the cluster that can read
  both the counters and the backlog. What bounds it is not its grants but its reachability: no
  route, no API, no presign, one EventBridge rule. Never attach it to anything that answers HTTP.
- **A NEW OUTPUT MEANS A STALE `.triage/stack.json`.** The cache is read back without
  re-validating (it is a cache, not a contract), so a stack.json written before
  `telemetry_lambda_role_arn` existed simply has no value for it. `migrate` catches that on the
  SUBSTITUTED text — an unresolved `${...}` stops the run and says `--refresh` — because an
  `AWS IAM GRANT … TO '${…}'` reaching the cluster literally would map the role to nothing and
  fail much later, much more confusingly.
- **`ALTER TABLE … ADD COLUMN` is how the config row grew, and it is not spelled
  `IF NOT EXISTS`.** DSQL's supported ALTER grammar is a documented subset and that clause is
  not in it, so a self-guarding statement would risk failing the whole run on syntax. Instead
  the migrate runner treats `42701 duplicate_column` as "already there", exactly as it already
  treats `42P07` for a table. Adding a column is therefore idempotent; **removing** one is
  still impossible (see the section above).
- **The zip is byte-deterministic** (fixed 1980 timestamps). Rebuilding without a
  source change produces the same hash and therefore no redeploy. Do not "fix"
  that by stamping the current time.
- **…BUT ONLY FROM `infra/`. `cd infra && node build.mjs`, never `node infra/build.mjs`.**
  MEASURED 2026-08-17 while proving a plan touched no existing function: esbuild resolves
  `absWorkingDir` from the process cwd and writes cwd-relative module paths into the bundle, so
  the *same sources* produce **different bytes** from the two directories. Run from the repo root,
  `dist/submit.zip` hashes `18cf6849…` and from `infra/` it hashes `fea5fde4…` — a plan that then
  redeploys both ingest functions for no source change at all, which is exactly the noise
  `source_code_hash` determinism exists to prevent. Every command in this file already says
  `cd infra`; that is why.
- **`pg` is bundled pure-JS.** `build.mjs` replaces `pg-native` and
  `cloudflare:sockets` with a stub that throws if anything ever evaluates it.
  Nothing does; do not "fix" it by installing `pg-native`.
- **`bigint` comes back as a string.** Both readers set node-postgres's int8 type
  parser to `Number` once, at module scope. Every bigint in this schema is an
  epoch-millisecond or a byte count, so the conversion is exact — but a new
  `bigint` column that is a real 64-bit integer would need its own handling.
- **Retry is part of the contract.** DSQL takes no locks; a write that raced is
  aborted at commit with SQLSTATE `40001`. Every write in the handler and the CLI
  goes through a bounded retry — **full jitter** since JOS-394,
  `sleep(random(0, 25 * 2^attempt))` over five attempts, because a fixed step
  re-synchronises exactly the two callers that just collided. Code that talks to
  this database directly must do the same. **And a conflict COUNT is not a health
  signal**: what the alarms watch is conflicts per invocation (pathology) and
  `DbRetryExhausted` (a ladder that actually ran out, i.e. a lost write).
- **Alarm dimensions are not interchangeable.** DSQL's usage (DPU) metrics key on
  `ResourceId`; its observability metrics key on `ClusterId`. The wrong one gives
  an alarm that sits in `INSUFFICIENT_DATA` forever and never fires.
- **The stage is `$default`, not `v1`.** A named stage prefixes every path, so
  stage `v1` + route `/v1/feedback` would resolve at `/v1/v1/feedback`. The
  version lives in the path; `api.tf` explains it at length. `/v1/telemetry` rides the same
  stage, for the same reason.
- **EMF is a LOG LINE, not an API call.** The telemetry dashboard is fed by JSON documents the
  handler writes to stdout (`infra/lambda/emf.ts`); CloudWatch extracts the metrics from the log
  group. So a metric that never appears has a typo in `_aws`, not a permission problem — a
  malformed document is silently just a log line. Never put an analyticsId in a dimension: a
  dimension value mints a billed metric and would rebuild, in the metrics store, exactly the
  per-user trail the storage design refuses to keep.
- **`.triage/stack.json` is a cache.** After an apply that renames anything, run
  the triage CLI once with `--refresh` (or delete the file).
