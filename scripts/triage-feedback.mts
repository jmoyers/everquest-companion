/**
 * triage-feedback.mts — the feedback backlog, from the dev machine (§10).
 *
 *   npx tsx scripts/triage-feedback.mts <command> [options]
 *
 * Reads Aurora DSQL and S3 DIRECTLY OVER IAM; there is no server-side read API to
 * secure, and no database password to hold (DSQL authenticates with a signed IAM
 * token minted locally). Physical names come from `terraform output -json`, cached
 * in .triage/stack.json (gitignored) — nothing about the account is committed.
 *
 * THREE LAWS THIS FILE ENFORCES, not just documents:
 *
 *   1. A LOG SLICE NEVER REACHES A PUBLIC ISSUE. `issue` runs the body through
 *      `assertNoLogSlice` and refuses if a raw EQ log line is anywhere in it. The
 *      slice stays in S3 and in .triage/ (gitignored twice over).
 *   2. THE SCRIPT NEVER TAKES INSTRUCTIONS FROM REPORT CONTENT. It is deterministic
 *      end to end. The agentic layer is a HUMAN reading `digest` output, asking
 *      Claude for an opinion, and running the `set`/`issue` commands it suggests.
 *      Nothing here calls a model, and no model writes to the database unattended.
 *   3. NEITHER DOES THE TERMINAL. Law 2 is about the OPERATOR not being instructed by
 *      a report; law 3 is about the SHELL not being. Every client-supplied string this
 *      script prints goes through the shared `sanitizeOneLine`/`sanitizeMultiline`
 *      (src/shared/sanitizeText.ts) first, so a description carrying `ESC ] 0 ;` or
 *      `ESC [ 2 J` is inert text here rather than a command to the emulator. And every
 *      log slice it downloads is RE-SCRUBBED with the app's own shared scrubber before
 *      it touches the disk — the presign policy pins an upload's size and type, never
 *      its content, so what is in the bucket is only as scrubbed as the client chose
 *      to be. `show` prints the delta when it is non-zero.
 *
 * AUTH: `--profile <name>` (the deploy profile already performs role assumption via
 * source_profile/role_arn) or `--role-arn <arn>` to assume the triage role directly.
 *
 * THE I/O HALF NOW LIVES IN `src/main/triage/store.ts`, not beside this file. It moved when
 * the dev-only triage TAB landed in the app: both front ends read the same backlog, so there
 * is exactly one implementation of every statement and they cannot drift. Nothing about this
 * CLI changed — same commands, same flags, same output.
 */

import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  assertNoLogSlice,
  clusterReports,
  parseSince,
  renderDigest,
  type Cluster,
  type TriageReport,
} from './triageCluster.mjs'
import {
  applySchema,
  attachmentKeysOf,
  attachmentReports,
  deleteReportRow,
  deleteSlice,
  getFeedbackConfig,
  getReport,
  listReports,
  loadStack,
  makeClients,
  reportsForInstall,
  SCHEMA_FILE,
  setAccepting,
  setBlocked,
  setTriage,
  stampRedacted,
  toTriageReport,
  type Clients,
  type ListFilter,
  type Row,
} from '../src/main/triage/store'
import { analyticsFailure, runAnalytics, ANALYTICS_USAGE } from './triageAnalytics.mjs'
import { requireFreshExport } from './analyticsExport.mjs'
// The error store's own family (JOS-100), a sibling module for the same reason the analytics
// one is: this file is at the 400-code-line ceiling and a two-verb subcommand family with a
// symbolication step belongs beside it, not in it.
import { runErrors, ERRORS_USAGE } from './triageErrors.mjs'
import {
  REPORT_STATUSES,
  SEVERITIES,
  FEEDBACK_TYPES,
  type ReportStatus,
  type Severity,
} from '../src/shared/feedback'
import { formatPerfBlock } from '../src/shared/feedbackPerf'
import { parsePerf } from '../src/main/triage/rows'
import { sanitizeMultiline, sanitizeOneLine } from '../src/shared/sanitizeText'

/**
 * A row column is `unknown`; never let one reach a template literal untyped — AND never let one
 * reach this terminal unsanitized.
 *
 * THE SECOND HALF IS NEW AND IT IS THE POINT. Everything this script prints lands in the
 * OWNER's terminal, and much of it is client-supplied: the description, every `env` value, a
 * `disposition` note. A terminal executes what it is sent — `ESC ] 0 ;` retitles the window,
 * `ESC [ 2 J` clears it, OSC 52 writes the clipboard — so a bug report that can put an ESC on
 * this stream is a bug report that can drive the operator's shell. The wire validators refuse
 * control characters now, but rows written before that rule existed are still in the table, and
 * a guard that only covers new rows is not a guard.
 *
 * `sanitizeOneLine` is the shared helper the triage TAB uses for the same values (via
 * `src/main/triage/rows.ts`), so the two front ends cannot disagree about what is safe to show.
 * One line, because these are printed into aligned rows and a newline would forge one.
 */
const text = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? sanitizeOneLine(v) : fallback

const USAGE = `triage-feedback <command> [options]

  migrate                             apply infra/schema.sql to the DSQL cluster (idempotent;
                                      run after every apply). NEEDS AN \`analytics export\` FROM
                                      THE LAST 6 HOURS — or --no-export-check, loudly.
  list    [--status S] [--channel prod|dev|all] [--type bug|feature] [--since 7d]
          [--min-score N] [--limit 100] [--json]
  show    <reportId>                  full record; downloads + gunzips the slice, the inventory
                                      export AND the achievements export, into .triage/
  digest  [--since 7d] [--channel C]  the markdown brief a human/Claude reads
  cluster [--since 30d] [--write]     deterministic clusters; --write stamps them
  set     <reportId...> [--status S] [--severity p0..p3] [--cluster ID]
          [--dupe-of ID] [--note "..."] [--stdin]
  issue   <reportId>                  gh issue create; stamps issueUrl back
  forget  <reportId>                  delete the slice object + stamp the redaction
  wipe    --install <installId>       delete every report + object from an install
  block   <installId> --reason "..."  |  unblock <installId>
  closed  [on|off] [--message "..."]  the kill switch (instant, no deploy); bare = read state

${ANALYTICS_USAGE}
${ERRORS_USAGE}
  Global: --profile <aws-profile> --role-arn <arn> --refresh (re-read tf outputs)`

const OPTIONS = {
  status: { type: 'string' },
  channel: { type: 'string' },
  type: { type: 'string' },
  since: { type: 'string' },
  'min-score': { type: 'string' },
  limit: { type: 'string' },
  severity: { type: 'string' },
  cluster: { type: 'string' },
  'dupe-of': { type: 'string' },
  note: { type: 'string' },
  reason: { type: 'string' },
  message: { type: 'string' },
  install: { type: 'string' },
  // `analytics wipe --id` / `analytics digest --days`. `--id` is deliberately NOT `--install`:
  // an analyticsId is not an installId and the two must never be interchangeable at the
  // command line either (plan T3 — they are deliberately non-correlatable).
  id: { type: 'string' },
  days: { type: 'string' },
  // `errors list --version` / `errors show --maps`. `--maps` names a directory of sourcemaps
  // for THAT build (the private CI artifact); without it the frames print as bundle positions.
  version: { type: 'string' },
  maps: { type: 'string' },
  // `analytics digest --cohort user|owner|all`. The default is `user` — the population
  // question — and `all` prints the two digests separately, never added together.
  cohort: { type: 'string' },
  profile: { type: 'string' },
  'role-arn': { type: 'string' },
  // `analytics export --out <dir>`; `analytics import --dry-run`; and the loud override for the
  // 6-hour export guard on `migrate` and the three backfill commands (JOS-399).
  out: { type: 'string' },
  'dry-run': { type: 'boolean' },
  'no-export-check': { type: 'boolean' },
  json: { type: 'boolean' },
  write: { type: 'boolean' },
  stdin: { type: 'boolean' },
  refresh: { type: 'boolean' },
  help: { type: 'boolean' },
} as const

type Args = Record<string, string | boolean | undefined>

interface Ctx {
  args: Args
  rest: string[]
  clients: () => Clients
}

const NOW = Date.now()

function oneOf<T extends string>(value: unknown, allowed: readonly T[], flag: string): T | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${flag}: expected one of ${allowed.join(', ')}`)
  }
  return value as T
}

function filterFrom(args: Args, defaultSince: string): ListFilter {
  const channel = oneOf(args.channel, ['prod', 'dev', 'all'] as const, '--channel') ?? 'prod'
  const filter: ListFilter = {
    channel,
    sinceMs: parseSince(typeof args.since === 'string' ? args.since : defaultSince, NOW),
    limit: Number(args.limit ?? 100),
  }
  const status = oneOf(args.status, REPORT_STATUSES, '--status')
  if (status) filter.status = status
  const type = oneOf(args.type, FEEDBACK_TYPES, '--type')
  if (type) filter.type = type
  if (args['min-score'] !== undefined) filter.minScore = Number(args['min-score'])
  return filter
}

function reportsFor(ctx: Ctx, defaultSince: string): Promise<Row[]> {
  return listReports(ctx.clients(), filterFrom(ctx.args, defaultSince))
}

function shortDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

// ---- commands ------------------------------------------------------------------------

/**
 * `migrate` — apply infra/schema.sql (F2 step 2.5).
 *
 * WHY THIS IS A CLI COMMAND AND NOT TERRAFORM. DSQL DDL needs an IAM-signed
 * postgres connection; Terraform has no resource that speaks the wire protocol and
 * no way to mint the token, so the alternative would be a `null_resource` +
 * `local-exec` shelling out to exactly this code with none of the reporting. The
 * schema is a reviewable SQL file and this is the reviewable thing that applies it.
 *
 * It is IDEMPOTENT and safe to re-run: every statement that already landed is
 * reported as `exists` rather than failing the run. `${LAMBDA_ROLE_ARN}` — the one
 * value that carries the account id, which is why schema.sql holds a placeholder —
 * is substituted from the terraform output.
 */
async function cmdMigrate(ctx: Ctx): Promise<void> {
  // THE EXPORT GUARD (JOS-399), and it is the FIRST thing this command does — before the
  // connection, before the schema is even read — so a refusal costs no round trip and no IAM
  // token. `migrate` is idempotent, but it is still DDL against the cluster that holds every
  // counter this product has, and the owner's ruling is that an offline copy exists first.
  requireFreshExport(ctx.args, 'migrate', NOW)
  const c = ctx.clients()
  const sql = readFileSync(SCHEMA_FILE, 'utf8')
    .replaceAll('${LAMBDA_ROLE_ARN}', text(c.stack.lambda_role_arn))
    .replaceAll('${TELEMETRY_LAMBDA_ROLE_ARN}', text(c.stack.telemetry_lambda_role_arn))
    .replaceAll('${EXPORT_LAMBDA_ROLE_ARN}', text(c.stack.export_lambda_role_arn))
  // A CACHED .triage/stack.json written before a new output existed has no value for it, and
  // the cache is deliberately read back without re-validating (it is a cache, not a contract).
  // So the check is on the SUBSTITUTED text: an `AWS IAM GRANT … TO '${…}'` that reached the
  // cluster literally would map the role to nothing and fail confusingly later.
  const unresolved = /\$\{([A-Z_]+)\}/.exec(sql)
  if (unresolved) {
    throw new Error(
      `schema.sql still contains ${unresolved[0]} — the terraform output for it is missing ` +
        'from .triage/stack.json. Re-run with --refresh (or delete the file) after an apply.',
    )
  }
  const steps = await applySchema(c, sql)
  for (const step of steps) {
    const head = step.sql.replace(/\s+/g, ' ').slice(0, 96)
    console.log(`${step.status === 'applied' ? 'applied ' : 'exists  '} ${head}`)
  }
  const applied = steps.filter((s) => s.status === 'applied').length
  console.log(
    `\n${String(applied)} applied, ${String(steps.length - applied)} already present.\n` +
      'Indexes are built ASYNCHRONOUSLY — they are usable once DSQL finishes the job.',
  )
}

async function cmdList(ctx: Ctx): Promise<void> {
  const rows = await reportsFor(ctx, '7d')
  if (ctx.args.json) {
    console.log(JSON.stringify(rows.map(toTriageReport), null, 2))
    return
  }
  for (const row of rows) {
    const r = toTriageReport(row)
    const head = r.description.replace(/\s+/g, ' ').slice(0, 60)
    // Three fixed-width attachment markers, `log`/`inv`/`ach` (JOS-296, JOS-441) — blank rather
    // than absent, so the columns stay aligned and a scan down the list reads which reports can
    // be answered.
    console.log(
      `${r.reportId}  ${shortDate(r.receivedAt)}  ${r.type.padEnd(7)} ${r.status.padEnd(9)} ` +
        `${r.appVersion.padEnd(8)} ${r.hasLog ? 'log' : '   '} ${r.hasInventory ? 'inv' : '   '} ` +
        `${r.hasAchievements ? 'ach' : '   '} ` +
        `${r.spamScore.toString().padStart(3)}  ${head}`,
    )
  }
  console.log(`\n${rows.length} report(s).`)
}

/**
 * `show` dumps the WHOLE row, so the sanitizer has to ride along on the JSON replacer rather
 * than on a field list. `JSON.stringify` escapes C0 by itself, but not C1 (0x80–0x9F, which
 * carries a single-byte CSI) and not the invisible/BiDi class — and "mostly escaped" is not a
 * property worth relying on when the alternative is one function call.
 */
function sanitizingReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'string' ? sanitizeMultiline(value) : value
}

async function cmdShow(ctx: Ctx): Promise<void> {
  const [reportId] = ctx.rest
  if (!reportId) throw new Error('show: <reportId> is required')
  const c = ctx.clients()
  const row = await getReport(c, reportId)
  if (!row) throw new Error(`no such report: ${reportId}`)
  console.log(JSON.stringify(row, sanitizingReplacer, 2))

  // The perf timeline (JOS-369), printed as a table rather than left inside the `env_json` string
  // the dump above escapes into one unreadable line. Same renderer as the dialog's preview and the
  // triage panel, so what the owner reads is what the reporter saw. Silent when there is none.
  const perf = parsePerf(row.env_json)
  if (perf) console.log(`\n${formatPerfBlock(perf)}`)

  // BOTH attachments, downloaded and described by the store (JOS-296). The verdicts print
  // LOUDLY and only when there are any — both note builders are empty for an honest client,
  // which is exactly what makes the other case worth reading.
  for (const leg of await attachmentReports(c, reportId, row)) {
    console.log(`\n${leg.line}`)
    for (const note of leg.warnings) console.warn(note)
  }
}

function digestInputs(rows: Row[]): { reports: TriageReport[]; clusters: Cluster[] } {
  const reports = rows.map(toTriageReport).sort((a, b) => a.reportId.localeCompare(b.reportId))
  return { reports, clusters: clusterReports(reports) }
}

async function cmdDigest(ctx: Ctx): Promise<void> {
  const filter = filterFrom(ctx.args, '7d')
  const { reports, clusters } = digestInputs(await listReports(ctx.clients(), filter))
  if (ctx.args.json) {
    console.log(JSON.stringify({ reports, clusters }, null, 2))
    return
  }
  console.log(renderDigest(reports, clusters, { sinceMs: filter.sinceMs, nowMs: NOW, channel: filter.channel }))
}

async function cmdCluster(ctx: Ctx): Promise<void> {
  const { clusters } = digestInputs(await reportsFor(ctx, '30d'))
  for (const c of clusters) {
    const flag = c.regression ? ` REGRESSION(${c.versions[0]})` : ''
    console.log(`${c.id}  ${c.kind.padEnd(6)} ${String(c.reportIds.length).padStart(3)}x${flag}  ${c.label}`)
    if (c.signature) console.log(`        signature ${c.signature}`)
  }
  if (!ctx.args.write) {
    console.log('\n(dry run — pass --write to stamp `cluster` on the members)')
    return
  }
  const client = ctx.clients()
  for (const c of clusters) {
    for (const id of c.reportIds) await setTriage(client, id, { cluster: c.id })
  }
  console.log(`\nstamped ${clusters.length} cluster(s).`)
}

function idsFor(ctx: Ctx): string[] {
  if (!ctx.args.stdin) return ctx.rest
  const raw = readFileSync(0, 'utf8').trim()
  if (raw.startsWith('[') || raw.startsWith('{')) {
    const parsed = JSON.parse(raw) as unknown
    const list = Array.isArray(parsed) ? parsed : []
    return list.map((e) => (typeof e === 'string' ? e : text((e as Row).reportId)))
  }
  return raw.split(/\s+/).filter((s) => s.length > 0)
}

async function cmdSet(ctx: Ctx): Promise<void> {
  const ids = idsFor(ctx)
  if (ids.length === 0) throw new Error('set: give at least one reportId (or --stdin)')
  const patch = {
    status: oneOf<ReportStatus>(ctx.args.status, REPORT_STATUSES, '--status'),
    severity: oneOf<Severity>(ctx.args.severity, SEVERITIES, '--severity'),
    cluster: typeof ctx.args.cluster === 'string' ? ctx.args.cluster : undefined,
    dupeOf: typeof ctx.args['dupe-of'] === 'string' ? ctx.args['dupe-of'] : undefined,
    note: typeof ctx.args.note === 'string' ? ctx.args.note : undefined,
  }
  const c = ctx.clients()
  for (const id of ids) await setTriage(c, id, patch)
  console.log(`updated ${ids.length} report(s).`)
}

function issueBody(row: Row, r: TriageReport): string {
  const env = JSON.parse(text(row.env_json, '{}')) as Record<string, unknown>
  const facts = ['appVersion', 'channel', 'updateChannel', 'platform', 'osRelease', 'arch', 'electron']
    .map((k) => `- ${k}: ${text(env[k], '?')}`)
    .join('\n')
  // Every attachment is MENTIONED and none is reproduced — THE LAW (see the file header): an
  // attachment never reaches a public issue. An inventory export is not chat, but it is still a
  // stranger's character laid out item by item, and an achievements export is that character's
  // whole play history. This repo is public.
  const kinds = [
    r.hasLog ? 'a scrubbed log slice' : '',
    r.hasInventory ? 'an inventory export' : '',
    r.hasAchievements ? 'an achievements export' : ''
  ]
  const present = kinds.filter((s) => s.length > 0)
  const attached =
    present.length <= 1
      ? (present[0] ?? '')
      : `${present.slice(0, -1).join(', ')} and ${present[present.length - 1]}`
  const log = attached === '' ? '' : `\n\n${attached[0].toUpperCase()}${attached.slice(1)} was attached and is available to maintainers; it is deliberately not reproduced here.`
  return `### Reported\n\n${r.description}\n\n### Environment\n\n${facts}\n\n_Report ${r.reportId}_${log}\n`
}

async function cmdIssue(ctx: Ctx): Promise<void> {
  const [reportId] = ctx.rest
  if (!reportId) throw new Error('issue: <reportId> is required')
  const c = ctx.clients()
  const row = await getReport(c, reportId)
  if (!row) throw new Error(`no such report: ${reportId}`)
  const r = toTriageReport(row)

  // The issue title is the first 100 characters of the description — reports carry no title
  // of their own any more, so there is nothing to prefer over it.
  const title = r.description.replace(/\s+/g, ' ').slice(0, 100)
  const body = issueBody(row, r)
  // THE LAW. Refuse rather than trust ourselves to have been careful.
  assertNoLogSlice(`${title}\n${body}`, `a public issue for ${reportId}`)

  const url = execFileSync(
    'gh',
    ['issue', 'create', '--title', title, '--body', body, '--label', r.type === 'bug' ? 'bug' : 'enhancement'],
    { encoding: 'utf8' },
  ).trim()
  await setTriage(c, reportId, { issueUrl: url, status: 'accepted' })
  console.log(url)
}

/**
 * `forget` — the deletion-request path, minus a job it no longer has.
 *
 * It used to do two things: NULL the `contact` column and delete the S3 slice object. The
 * contact half is gone with the column (retired from the wire, then dropped from the schema),
 * so what remains is the half that was always the substantive one — the artifacts somebody
 * attached are destroyed, and `redacted_at` records that it happened. The description stays: it
 * IS the bug report. For "delete everything about me", that is `wipe --install`.
 *
 * IT DELETES EVERY ATTACHMENT, not the slice (JOS-296). `attachmentKeysOf` is the list, on
 * purpose: a `forget` that removed the log window and left the inventory export in the bucket
 * would be this command telling a requester something untrue.
 */
async function cmdForget(ctx: Ctx): Promise<void> {
  const [reportId] = ctx.rest
  if (!reportId) throw new Error('forget: <reportId> is required')
  const c = ctx.clients()
  const row = await getReport(c, reportId)
  if (!row) throw new Error(`no such report: ${reportId}`)
  const keys = attachmentKeysOf(row)
  for (const key of keys) await deleteSlice(c, key)
  await stampRedacted(c, reportId)
  console.log(
    keys.length > 0
      ? `forgot ${String(keys.length)} attachment(s) for ${reportId} (deleted ${keys.join(', ')})`
      : `${reportId} had no attachments; stamped redacted anyway`,
  )
}

async function cmdWipe(ctx: Ctx): Promise<void> {
  const installId = typeof ctx.args.install === 'string' ? ctx.args.install : ''
  if (!installId) throw new Error('wipe: --install <installId> is required')
  console.warn(
    'WARNING: wipe reads every report row — there is deliberately no index on ' +
      'installId, so this is an unindexed full-table query. It is billed by the ' +
      'bytes it touches; run it for a deletion request, not out of curiosity.',
  )
  const c = ctx.clients()
  const rows = await reportsForInstall(c, installId)
  for (const row of rows) {
    // EVERY attachment, same list `forget` uses (JOS-296) — "delete everything about me" cannot
    // mean "everything except the inventory export".
    for (const key of attachmentKeysOf(row)) await deleteSlice(c, key)
    await deleteReportRow(c, text(row.report_id))
  }
  console.log(`wiped ${rows.length} report(s) for install ${installId}.`)
}

/**
 * `analytics <digest|wipe|open|close>` — usage analytics (docs/plans/usage-analytics.md A2).
 *
 * The subcommands live in ./triageAnalytics.mts; this is the dispatch. The error translation
 * lives there too (`analyticsFailure`), beside the reads it describes: an un-migrated cluster and
 * an unreachable one are facts about the CLUSTER, and neither is a useful thing to print at
 * somebody as a postgres string.
 */
async function cmdBlock(ctx: Ctx): Promise<void> {
  const [installId] = ctx.rest
  if (!installId) throw new Error('block: <installId> is required')
  const reason = typeof ctx.args.reason === 'string' ? ctx.args.reason : ''
  if (!reason) throw new Error('block: --reason "..." is required (the profile records why)')
  await setBlocked(ctx.clients(), installId, true, reason)
  console.log(`blocked ${installId}: every submit now 403s. No deploy needed.`)
}

async function cmdUnblock(ctx: Ctx): Promise<void> {
  const [installId] = ctx.rest
  if (!installId) throw new Error('unblock: <installId> is required')
  await setBlocked(ctx.clients(), installId, false, 'unblocked')
  console.log(`unblocked ${installId}.`)
}

async function cmdClosed(ctx: Ctx): Promise<void> {
  const [state] = ctx.rest
  // Bare `closed` READS the switches instead of erroring — the question "is feedback open
  // right now?" should not require hand-writing SQL (it did, until a smoke-test pre-flight
  // had to do exactly that).
  if (state === undefined) {
    const row = await getFeedbackConfig(ctx.clients())
    if (!row) {
      console.log('no feedback_config row — `migrate` has not run against this stack.')
      return
    }
    const feedback = row.accepting === true ? 'OPEN' : `CLOSED ("${String(row.closed_message)}")`
    const telemetry = row.telemetry_accepting === true ? 'OPEN' : 'CLOSED'
    console.log(`feedback:  ${feedback}`)
    console.log(`telemetry: ${telemetry} (analytics open|close)`)
    return
  }
  if (state !== 'on' && state !== 'off') throw new Error('closed: expected `on`, `off`, or no argument to read the current state')
  const message = typeof ctx.args.message === 'string' ? ctx.args.message : undefined
  await setAccepting(ctx.clients(), state === 'off', message)
  console.log(
    state === 'on'
      ? 'feedback CLOSED — clients get 503 + the message, rendered verbatim.'
      : 'feedback OPEN.',
  )
}

const COMMANDS: Record<string, (ctx: Ctx) => Promise<void>> = {
  migrate: cmdMigrate,
  list: cmdList,
  show: cmdShow,
  digest: cmdDigest,
  cluster: cmdCluster,
  set: cmdSet,
  issue: cmdIssue,
  forget: cmdForget,
  wipe: cmdWipe,
  block: cmdBlock,
  unblock: cmdUnblock,
  closed: cmdClosed,
  // BOTH SUBCOMMAND FAMILIES OWN THEIR OWN DISPATCH, in their own modules. This file is at the
  // 400-code-line ceiling, and two nearly identical eleven-line dispatchers living here is
  // exactly the shape that pushed it over — so each family exports one entry point instead.
  analytics: (ctx) => runAnalytics({ ...ctx, nowMs: NOW }),
  // The errors family owns its own dispatch (triageErrors.mts) — see runErrors.
  errors: (ctx) => runErrors({ ...ctx, nowMs: NOW }, analyticsFailure),
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: OPTIONS,
    allowPositionals: true,
  })
  const [command, ...rest] = positionals
  if (!command || values.help || !(command in COMMANDS)) {
    console.log(USAGE)
    process.exitCode = command && !(command in COMMANDS) ? 1 : 0
    return
  }

  // A box rather than a `let`: the finally below has to see what the closure
  // assigned, and control-flow analysis narrows a captured `let` to `null` there.
  const held: { clients: Clients | null } = { clients: null }
  const ctx: Ctx = {
    args: values,
    rest,
    clients: () => {
      held.clients ??= makeClients(loadStack(values.refresh === true), {
        ...(typeof values.profile === 'string' ? { profile: values.profile } : {}),
        ...(typeof values['role-arn'] === 'string' ? { roleArn: values['role-arn'] } : {}),
      })
      return held.clients
    },
  }
  try {
    await COMMANDS[command](ctx)
  } finally {
    // A live postgres socket holds the event loop open. Without this the CLI
    // prints its answer and then hangs until DSQL's one-hour connection timeout.
    await held.clients?.close()
  }
}

await main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
