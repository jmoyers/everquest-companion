/**
 * ============================================================================
 * goldenCli.mts — `npm run oracle:record` and `npm run oracle:check` (JOS-465).
 * ============================================================================
 *
 *   npm run oracle:record -- [slice...] [--fight-detail=N] [--verify-slicers]
 *   npm run oracle:check  -- [slice...] [--fight-detail=N]
 *
 * With no slice names both commands do all six. `goldenOracle.mts` carries the argument for what
 * the artifacts are and why; this file is the two commands, the manifest and the report.
 *
 * `oracle:check` IS THE ACCEPTANCE GATE the later Rust tickets run: it re-folds each slice and
 * exits nonzero on the first disagreement, naming the slice, the event ordinal, the module and
 * the dotted path. It re-folds rather than re-hashing on purpose — a hash says "different" and
 * a divergence report says WHERE, and a cutover argued from a changed hash is not an argument.
 *
 * THE MANIFEST IS GITIGNORED WITH EVERYTHING ELSE HERE, and records what a golden cannot state
 * about itself: the sha256 of each artifact, the TZ the machine was in, the tzdata and ICU the
 * Node build carried, the node version, and the git sha the fold ran at.
 *
 * WHY THE TIMEZONE IS RECORDED RATHER THAN NORMALIZED. `LogEvent.ts` is HOST-LOCAL by
 * construction: `parser.ts:87-97` reformats "Sat Aug 01 13:00:28 2026" into a string V8 parses
 * in the LOCAL zone, because that is what the game wrote and what the user reads. Every
 * timestamp in every golden is therefore a fact about this machine's zone as well as about the
 * log, and a golden recorded in America/Los_Angeles will not check in UTC. That is not a defect
 * to paper over here — it is a property of the pipeline the Rust engine must reproduce, and the
 * manifest states it so a failing check in a different zone is diagnosed in one line instead of
 * being mistaken for a semantic divergence.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { constants, setPriority } from 'node:os'
import { join } from 'node:path'
import { GOLDENS_DIR, checkSlice, eventsPath, readSlices, recordSlice, snapshotsPath, type Divergence, type SliceRef } from './goldenOracle.mjs'
import { REPLAY_SLICE_MS, createSlicer } from '../../src/main/log/replaySlicer'
import type { Slicer } from '../../src/main/log/replaySlicer'

const README = `# goldens/ — the TS pipeline's recorded truth (JOS-465)

Everything in this directory is GITIGNORED and machine-local. It is regenerated from the six
log slices in ../slices/ with two commands and no other context:

    npm run oracle:record        # fold all six slices, write the goldens + manifest.json
    npm run oracle:check         # re-fold all six, diff against the goldens, exit nonzero on any

Both take slice names as arguments (\`npm run oracle:check -- current sky-era\`).

Per slice: \`<slice>.events.ndjson\` is the parser's event stream, one JSON.stringify per line,
compared BYTE FOR BYTE (phase 1 of the data-server program). \`<slice>.snapshots.json\` is every
module's published snapshot plus the combat engine's full-fat snapshot and its per-scope walk,
compared by DEEP EQUALITY (phase 2). \`manifest.json\` records a sha256 per artifact plus the
machine facts a golden depends on but cannot state: the TZ, tzdata, ICU, node version and git sha.

THE GOLDENS ARE MACHINE-LOCAL. Event timestamps are host-local by construction (the parser
reformats and V8 Date.parses in the local zone), so a golden recorded in one timezone does not
check in another. Re-record after a timezone change, a tzdata bump, or any deliberate semantic
change to the pipeline — and when re-recording after a semantic change, say in the commit which
numbers were expected to move.

These artifacts are slices of the owner's real game log. They never leave this machine and they
never enter git.
`

interface Args {
  slices: string[]
  fightDetail: number
  verifySlicers: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = { slices: [], fightDetail: Number.POSITIVE_INFINITY, verifySlicers: false }
  for (const a of argv) {
    if (a === '--verify-slicers') out.verifySlicers = true
    else if (a.startsWith('--fight-detail=')) out.fightDetail = Number(a.slice('--fight-detail='.length))
    else if (a.startsWith('--')) throw new Error(`goldenCli: unknown flag ${a}`)
    else out.slices.push(a)
  }
  return out
}

function chosen(names: string[]): SliceRef[] {
  const all = readSlices()
  if (names.length === 0) return all
  return names.map((n) => {
    const hit = all.find((s) => s.name === n)
    if (!hit) throw new Error(`goldenCli: no slice named "${n}" (have ${all.map((s) => s.name).join(', ')})`)
    return hit
  })
}

/**
 * THE SLICER ARMS, `tests/replayChunking.test.mts:370`'s five verbatim: the unchunked control the
 * golden is recorded under, then budget 0 (a yield after EVERY event — the most interleaving this
 * design can produce), the production budget, and both again with the duty cycle's REST path
 * standing in for the OS via an instant fake timer.
 *
 * The rest is faked for the reason that file states: the corpus yields after every event, so real
 * rests would be hours, and a pause of zero exercises exactly the same branch as a pause of
 * 15.6 ms. What is being asked is only whether a PAUSE can change an answer.
 */
function slicerArms(): { name: string; make: () => Slicer }[] {
  return [
    { name: 'budget 0ms, no rest', make: () => createSlicer({ budgetMs: 0, duty: 1 }) },
    { name: `budget ${String(REPLAY_SLICE_MS)}ms, no rest`, make: () => createSlicer({ budgetMs: REPLAY_SLICE_MS, duty: 1 }) },
    { name: 'budget 0ms, RESTING', make: () => createSlicer({ budgetMs: 0, restFor: () => Promise.resolve() }) },
    { name: `budget ${String(REPLAY_SLICE_MS)}ms, RESTING`, make: () => createSlicer({ budgetMs: REPLAY_SLICE_MS, restFor: () => Promise.resolve() }) }
  ]
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

function report(d: Divergence): void {
  const at = d.where === 'events' ? `event #${String(d.seq)}` : `${d.module ?? 'snapshot'} @ ${d.path ?? '(root)'}`
  console.error(`  DIVERGED  ${d.slice} · ${d.where} · ${at}`)
  console.error(`    golden : ${d.expected}`)
  console.error(`    re-fold: ${d.actual}`)
}

/** Git sha, or a marker — a manifest that cannot say which tree it came from must say so. */
function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return '(unknown)'
  }
}

async function record(args: Args): Promise<number> {
  mkdirSync(GOLDENS_DIR, { recursive: true })
  writeFileSync(join(GOLDENS_DIR, 'README.md'), README)
  const rows: Record<string, unknown>[] = []
  let bad = 0
  for (const slice of chosen(args.slices)) {
    const res = await recordSlice(slice, { fightDetail: args.fightDetail })
    console.log(
      `recorded ${slice.name}: ${String(res.golden.parserEvents)} parser events ` +
        `(${String(res.golden.events)} total), ${String(res.golden.modules.length)} modules, ` +
        `${String(res.golden.scopes.length)} scopes, ${secs(res.ms)}`
    )
    rows.push({
      slice: slice.name,
      source: slice.file,
      parserEvents: res.golden.parserEvents,
      events: res.golden.events,
      lastEventTs: res.golden.lastEventTs,
      constructionNowMs: res.golden.constructionNowMs,
      liveRuns: res.golden.liveRuns,
      modules: res.golden.modules.length,
      scopes: res.golden.scopes.length,
      recordMs: Math.round(res.ms),
      events_sha256: res.eventsSha,
      snapshots_sha256: res.snapshotsSha
    })
    if (args.verifySlicers) bad += await verifySlicers(slice, args)
  }
  writeFileSync(
    join(GOLDENS_DIR, 'manifest.json'),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        // The machine facts a golden depends on but cannot state — see the header.
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        tzOffsetMinutes: new Date().getTimezoneOffset(),
        tzdata: process.versions.tz ?? '(not reported by this node)',
        icu: process.versions.icu ?? '(not reported by this node)',
        node: process.version,
        gitSha: gitSha(),
        fightDetail: args.fightDetail === Number.POSITIVE_INFINITY ? 'uncapped' : args.fightDetail,
        slicerVerified: args.verifySlicers,
        artifacts: rows
      },
      null,
      2
    ) + '\n'
  )
  console.log(`manifest: ${join(GOLDENS_DIR, 'manifest.json')}`)
  return bad
}

/**
 * SLICER INVARIANCE, asserted BEFORE a golden is accepted. The golden was just recorded under
 * `unchunkedSlicer()`; each budgeted arm re-folds the same bytes and is compared against it with
 * the very same comparator `oracle:check` uses. If a yield can change an answer, the golden is
 * not a fact about the log and must not be accepted — so this prints a refusal and the command
 * exits nonzero.
 */
async function verifySlicers(slice: SliceRef, args: Args): Promise<number> {
  let bad = 0
  for (const arm of slicerArms()) {
    const t0 = performance.now()
    const found = await checkSlice(slice, { slicer: arm.make(), fightDetail: args.fightDetail })
    if (found.length === 0) {
      console.log(`  slicer OK  ${slice.name} · ${arm.name} · ${secs(performance.now() - t0)}`)
      continue
    }
    bad += 1
    console.error(`  SLICER-DEPENDENT GOLDEN REFUSED  ${slice.name} · ${arm.name}`)
    for (const d of found) report(d)
  }
  return bad
}

async function check(args: Args): Promise<number> {
  let bad = 0
  for (const slice of chosen(args.slices)) {
    const t0 = performance.now()
    const found = await checkSlice(slice, { fightDetail: args.fightDetail })
    const ms = performance.now() - t0
    if (found.length === 0) {
      console.log(`ok ${slice.name} · ${secs(ms)}`)
      continue
    }
    bad += 1
    console.error(`FAIL ${slice.name} · ${secs(ms)}`)
    for (const d of found) report(d)
  }
  console.log(bad === 0 ? 'oracle:check GREEN' : `oracle:check RED — ${String(bad)} slice(s) diverged`)
  return bad
}

/**
 * BELOW NORMAL, SET BY THE TOOL RATHER THAN BY WHOEVER REMEMBERS TO (house rule, 2026-08-23:
 * heavy suites and folds run at BelowNormal while the owner is at the machine).
 *
 * A fold of all six slices pins a core for minutes and the owner may well be playing EverQuest
 * on the other side of it. A `start /belownormal` wrapper in the npm script would work until the
 * first person ran the file directly; `os.setPriority` is the same request made by the process
 * that actually does the work, so there is no invocation that escapes it. Best-effort: a
 * platform that refuses the call is not a reason to refuse the recording.
 */
function runBelowNormal(): void {
  try {
    setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    console.warn('oracle: could not lower process priority; continuing at normal')
  }
}

/**
 * Refuse a check with nothing to check against, BY NAME. Without this the first missing artifact
 * surfaces as an ENOENT from deep inside the line reader, and "no such file" is the one failure
 * mode that must never be mistaken for a divergence — the goldens are gitignored, so a fresh
 * worktree has none and this is the message it should get.
 */
function requireGoldens(names: string[]): void {
  const missing = chosen(names)
    .flatMap((s) => [eventsPath(s.name), snapshotsPath(s.name)].map((p) => ({ slice: s.name, p })))
    .filter((r) => !existsSync(r.p))
  if (missing.length === 0) return
  const first = missing[0]
  throw new Error(`no golden at ${first.p} — run \`npm run oracle:record -- ${first.slice}\` first`)
}

async function main(): Promise<void> {
  runBelowNormal()
  const [mode, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  if (mode !== 'record' && mode !== 'check') throw new Error(`expected "record" or "check", got "${mode ?? '(nothing)'}"`)
  if (mode === 'check') requireGoldens(args.slices)
  const bad = mode === 'record' ? await record(args) : await check(args)
  if (bad > 0) process.exitCode = 1
}

main().catch((err: unknown) => {
  console.error('oracle:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
