// ============================================================================
// triageErrors.mts — `triage-feedback errors` (JOS-100).
// ============================================================================
//
// The CLI half of the error store. `analytics digest` answers "how many"; this answers WHICH,
// and — with `--maps` — turns the bundle positions in an exemplar into source lines.
//
// ITS OWN MODULE beside `triageAnalytics.mts`, for the same reason that one exists:
// `triage-feedback.mts` is at the repo's 400-code-line ceiling, and a subcommand family with
// two verbs and a symbolication step is a family, not a function.
//
// ---------------------------------------------------------------------------------------
// WHY `show` TAKES A FINGERPRINT AND NOT A REPORT ID
// ---------------------------------------------------------------------------------------
// There is no per-report row to name. `error_report` is keyed on
// (day, cohort, version, fingerprint) with no id in it anywhere, which is the property that
// makes it a per-ISSUE store rather than the per-user event trail T6 refused. So the addressable
// unit is the ISSUE, and one issue is what a hundred installs hitting one bug produce.
//
// ---------------------------------------------------------------------------------------
// SYMBOLICATION IS OPT-IN, AND ITS FAILURE IS LOUD
// ---------------------------------------------------------------------------------------
// The maps live in a private CI artifact keyed by version (`sourcemaps-<tag>`), so the operator
// has to have fetched the right one; there is nothing this command can do to obtain them. With
// no `--maps` it prints the raw frames, which are still useful. With `--maps` pointed at the
// WRONG version it prints resolved lines that are quietly wrong — so `symbolicate.mts` reports
// the unmapped count to stderr, and that number is the tell.

import { readErrorReports, type Clients, type Row } from '../src/main/triage/store'
import { toErrorIssueRows, ofCohort, addDays, dayOf } from '../src/main/triage/usageRows'
import { validateTelemetryEvent } from '../src/shared/telemetryValidate'
import { cohortOf, type UsageCohort } from '../src/shared/telemetryRollup'
import { formatFrame, symbolicateFrames, type Frame } from './symbolicate.mjs'

export const ERRORS_USAGE = `  errors  list [--days 14] [--cohort user|owner|all] [--version V]
          show <fingerprint> [--days 14] [--maps <dir>]
                                      the error store: top issues per build, and one exemplar
                                      symbolicated against that version's sourcemaps`

export interface ErrorsCtx {
  args: Record<string, string | boolean | undefined>
  rest: string[]
  clients: () => Clients
  nowMs: number
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** The window, as both commands read it. Same shape the analytics digest uses. */
function sinceDay(ctx: ErrorsCtx): string {
  return addDays(dayOf(ctx.nowMs), -(num(ctx.args.days, 14) - 1))
}

/**
 * The cohort filter. `user` by DEFAULT and `all` prints both SIDE BY SIDE — the split's own rule
 * (src/shared/telemetryRollup.ts): nothing anywhere sums the author's rows with a user's,
 * because a merged total is precisely the number the split exists to stop reporting.
 */
function cohorts(ctx: ErrorsCtx): UsageCohort[] {
  const want = str(ctx.args.cohort, 'user')
  return want === 'all' ? ['user', 'owner'] : [cohortOf(want)]
}

interface Issue {
  version: string
  fingerprint: string
  count: number
  firstSeen: string
  lastSeen: string
  errorName: string
  message: string
  exemplar: Record<string, unknown> | null
}

/**
 * Fold the day-keyed rows into issues, FIRST EXEMPLAR WINS across days — the same rule the
 * ingest UPSERT applies within one, so the CLI and the panel describe an issue identically.
 */
function foldIssues(rows: readonly Row[], cohort: UsageCohort): Issue[] {
  const bag = new Map<string, Issue>()
  const mapped = ofCohort(toErrorIssueRows(rows), cohort).sort((a, b) => a.day.localeCompare(b.day))
  for (const r of mapped) {
    const key = `${r.version}|${r.fingerprint}`
    const held = bag.get(key)
    if (held !== undefined) {
      held.count += r.n
      if (r.day < held.firstSeen) held.firstSeen = r.day
      if (r.day > held.lastSeen) held.lastSeen = r.day
      continue
    }
    const ex = parseExemplar(r.exemplar)
    bag.set(key, {
      version: r.version,
      fingerprint: r.fingerprint,
      count: r.n,
      firstSeen: r.day,
      lastSeen: r.day,
      errorName: str(ex?.errorName, 'Error'),
      message: str(ex?.redactedMessage, '(no example stored)'),
      exemplar: ex
    })
  }
  return [...bag.values()].sort((a, b) => b.count - a.count)
}

/**
 * Parse and RE-VALIDATE a stored exemplar. Total: every failure ends in null.
 *
 * The validator runs here for the same reason it runs in the panel's reader — defense in depth
 * at the last boundary before a human looks at it. A row is data at rest in a table an operator
 * can also write to by hand, and this command prints its contents to a terminal.
 */
function parseExemplar(raw: string): Record<string, unknown> | null {
  if (raw === '') return null
  try {
    const v = validateTelemetryEvent(JSON.parse(raw))
    return v.ok && v.value.t === 'errorReport' ? (v.value as unknown as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function load(ctx: ErrorsCtx): Promise<Row[]> {
  return readErrorReports(ctx.clients(), sinceDay(ctx))
}

// ---- errors list ---------------------------------------------------------------------

async function cmdList(ctx: ErrorsCtx): Promise<void> {
  const rows = await load(ctx)
  const version = str(ctx.args.version)
  for (const cohort of cohorts(ctx)) {
    const issues = foldIssues(rows, cohort).filter((i) => version === '' || i.version === version)
    console.log(`\n=== ${cohort} cohort — ${String(issues.length)} issue(s) since ${sinceDay(ctx)}`)
    if (issues.length === 0) {
      // AN EMPTY LIST IS TWO DIFFERENT FACTS and the CLI says which it cannot tell apart, rather
      // than printing "no errors" and letting the reader assume the happy one.
      console.log('  nothing — either no client on a reporting build hit an error, or no client')
      console.log('  on a reporting build ran at all. `analytics digest` has the denominator.')
      continue
    }
    for (const i of issues) {
      console.log(
        `  ${i.count.toString().padStart(6)}×  ${i.version.padEnd(10)} ${i.fingerprint}  ` +
          `${i.firstSeen}${i.firstSeen === i.lastSeen ? '' : `→${i.lastSeen}`}`
      )
      console.log(`          ${i.errorName}: ${i.message}`)
    }
  }
}

// ---- errors show ---------------------------------------------------------------------

/**
 * THE FRAMES, under a heading that says what kind of location they are (JOS-111).
 *
 * `frameOrigin: 'capture'` means the throw had no stack and these name the site that CAUGHT it.
 * Printing that as plain `frames:` would send a reader hunting for the bug in the console
 * forwarder, so the heading changes rather than a flag appearing somewhere they have to notice.
 */
function printFrames(frames: Frame[], heading: string, mapsDir: string): void {
  if (frames.length === 0) return
  console.log(`\n  ${heading}`)
  if (mapsDir === '') {
    for (const f of frames) console.log(`    at ${f.func} (${f.file}:${f.line}:${f.col})`)
  } else {
    for (const line of symbolicateFrames(frames, mapsDir).map(formatFrame)) console.log(line)
  }
}

/** Every location the exemplar has, in the order a reader wants them (JOS-111). */
function printLocation(ex: Record<string, unknown>, mapsDir: string): void {
  const frames = (ex.frames ?? []) as Frame[]
  const external = (ex.externalFrames ?? []) as Frame[]
  if (frames.length === 0 && external.length === 0) {
    console.log('\n  frames:')
    console.log('    (none — the throw carried no stack, and the capture site had none either)')
    return
  }
  printFrames(
    frames,
    str(ex.frameOrigin) === 'capture'
      ? 'CAPTURE SITE (the throw carried no stack — this is where it was CAUGHT):'
      : 'frames:',
    mapsDir
  )
  // NOT symbolicated, and cannot be: these name a package or a Node module, not a bundle
  // position, so there is no sourcemap of ours they could be resolved against.
  if (external.length > 0) {
    console.log('\n  outside the app bundle:')
    for (const f of external) console.log(`    at ${f.func} (${f.file}:${f.line}:${f.col})`)
  }
  if (frames.length > 0 && mapsDir === '') {
    console.log('\n  (pass --maps <dir> with that version\'s sourcemaps for source terms)')
  }
}

function printExemplar(ex: Record<string, unknown>, mapsDir: string): void {
  console.log(`\n  ${str(ex.errorName, 'Error')}: ${str(ex.redactedMessage)}`)
  const code = str(ex.code)
  const components = str(ex.componentPath)
  const bits = [
    `mode=${str(ex.mode)}`,
    `view=${str(ex.view)}`,
    `sessionAge=bucket ${String(ex.sessionAgeBucket)}`,
    ...(code === '' ? [] : [`code=${code}`])
  ]
  console.log(`  ${bits.join(' · ')}`)
  if (components !== '') console.log(`  React components, innermost first: ${components}`)
  printLocation(ex, mapsDir)
  const crumbs = (ex.breadcrumbs ?? []) as { kind: string; offsetMs: number }[]
  if (crumbs.length > 0) {
    console.log('\n  log events just before, newest first (offsets in LOG time):')
    console.log(`    ${crumbs.map((c) => (c.offsetMs === 0 ? c.kind : `${c.kind} -${String(c.offsetMs)}ms`)).join(' · ')}`)
  }
}

async function cmdShow(ctx: ErrorsCtx): Promise<void> {
  const fingerprint = ctx.rest[1] ?? ''
  if (fingerprint === '') throw new Error('errors show: a fingerprint is required')
  const rows = await load(ctx)
  const mapsDir = str(ctx.args.maps)
  let found = false
  for (const cohort of cohorts(ctx)) {
    for (const i of foldIssues(rows, cohort).filter((x) => x.fingerprint === fingerprint)) {
      found = true
      console.log(
        `\n=== ${i.fingerprint} · ${i.version} · ${cohort} cohort · ${String(i.count)} occurrence(s) · ` +
          `${i.firstSeen}${i.firstSeen === i.lastSeen ? '' : ` → ${i.lastSeen}`}`
      )
      if (i.exemplar === null) {
        console.log('\n  No example was stored for this fingerprint — the count is still real.')
        continue
      }
      printExemplar(i.exemplar, mapsDir)
    }
  }
  if (!found) {
    throw new Error(
      `errors show: no issue ${fingerprint} in the last ${String(num(ctx.args.days, 14))} days ` +
        '(widen with --days, or add --cohort all if it was the owner\'s own install)'
    )
  }
}

const ERRORS_SUBCOMMANDS: Record<string, (ctx: ErrorsCtx) => Promise<void>> = {
  list: cmdList,
  show: cmdShow
}

/**
 * THE WHOLE FAMILY, dispatch and failure translation included, so `triage-feedback.mts` is one
 * line in its command table.
 *
 * That file is at the repo's 400-code-line ceiling and adding this family's dispatch to it put
 * it over — which is the file saying where the boundary belongs. `analyticsFailure` is injected
 * rather than imported so this module does not depend on its sibling for one error message; the
 * caller already holds it.
 */
export async function runErrors(
  ctx: ErrorsCtx,
  translate: (err: unknown) => unknown
): Promise<void> {
  const run = errorsSubcommand(ctx.rest[0])
  if (run === null) {
    throw new Error(`errors: expected one of ${Object.keys(ERRORS_SUBCOMMANDS).join(', ')}`)
  }
  try {
    await run(ctx)
  } catch (err) {
    // A missing `error_report` table is an un-run migration, and saying so beats a raw SQLSTATE.
    throw translate(err)
  }
}

function errorsSubcommand(name: string | undefined): ((ctx: ErrorsCtx) => Promise<void>) | null {
  return name === undefined ? null : (ERRORS_SUBCOMMANDS[name] ?? null)
}


