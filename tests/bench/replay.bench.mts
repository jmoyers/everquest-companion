/**
 * ============================================================================
 * replay.bench.mts — what the startup replay COSTS, measured on a real boot.
 * ============================================================================
 *
 * `npm run bench:replay` (docs/plans/chunked-replay.md §3). It is spec-shaped rather than a unit
 * test, and it is deliberately NOT in tests/e2e/run-all.mts: it boots the whole app against a
 * ~100 MB log, takes the better part of a minute, and its verdict depends on how busy the machine
 * running it is. A gate like that in CI would be a coin flip; a ledger like this on one developer's
 * machine is the before/after evidence a performance change lives or dies by.
 *
 * WHAT IT MEASURES, and why each number is here:
 *   replayMs         the `replayDone` phase — how long the historical fold took.
 *   eventsReplayed   how many events that was. "6 s" means something very different for 40k
 *                    events than for 1.2M, which is why the profile states both.
 *   eventsPerSec     the two above, divided — the wall-clock rate a user actually waits through.
 *   eventsPerWorkSec the same events over the time the fold spent FOLDING rather than resting.
 *                    Since JOS-50 the replay is duty-cycled on purpose, so the wall-clock rate is
 *                    partly a statement about the throttle; this one is the code's own speed and
 *                    is the number the floor below is asserted against.
 *   replayDuty       what fraction of the replay's wall clock was folding — measured by the
 *                    slicer, because a Windows timer delivers its own idea of a rest (15.6 ms
 *                    quantum), not the one that was requested.
 *   maxBlockMs       the worst single main-loop stall between appReady and replayDone, from the
 *                    always-on probe (plan §2). THE invariant: chunking exists to bound this.
 *   blocksOver50Ms   how many stalls crossed the same threshold the perf HUD calls "warn".
 *
 * AND SINCE JOS-55, A SECOND ARM: WHERE THE FOLD GOES.
 *   Everything above says how long the replay took; none of it says who spent it. `attribution.mts`
 *   folds the same log IN THIS PROCESS through the same modules in the same order (they are
 *   constructed by `src/main/modules/wiring.ts`, which pipeline.ts also calls, so the list cannot
 *   drift), with a per-consumer timer installed at the ModuleRegistry dispatch seam and a probe on
 *   the bus's derived drain. It prints a consumer × ms × us/event × % table, two parse-only
 *   comparator arms, and the instrument's OWN measured cost. Read foldArm.mts's header for what
 *   that arm shares with an Electron boot and what it honestly does not.
 *
 *   ITS FIRST RESULT OVERTURNED THE PREMISE IT WAS BUILT ON, which is the reason it exists as a
 *   committed arm rather than as a remembered number. The claim it inherited was "parsing alone
 *   runs at 565k events/sec while the pipeline manages 32k, so ~94% of a startup replay is
 *   downstream of the parser". MEASURED 2026-08-06 on this machine, 1,404,455 events:
 *
 *     parse only, BARE parser (no spell DB)   2,418 ms   1.72 us/event   580,900 events/sec
 *     parse only, the parser THE APP INSTALLS 10,454 ms  7.44 us/event   134,352 events/sec
 *     the whole fold, every consumer          18,228 ms  12.98 us/event   77,050 events/sec
 *
 *   The 565k figure is real and reproduces exactly — of a parser this app never runs. Installing
 *   the effective spell DB (spells.json + the observed-message overlay, which is what turns on
 *   message-driven buffApply/buffWearOff matching) costs 5.72 us per event, 8.0 s of that fold,
 *   and it is charged inside `parseEvent` before any consumer sees anything. So parsing is ~57% of
 *   the fold, not 6%, and the largest single line item in a startup replay is the spell DB's own
 *   matching. The consumers below it are the combat engine (21%) and the buffs module (10%);
 *   everything else in the tree together is under 4%.
 *
 * AND THEN JOS-58 SPENT THAT FINDING, which is what the table was built to make possible. The
 *   5.72 us was not "the spell DB": it was ONE of its three tables. `castOnYou` (849 messages) and
 *   `wearsOff` (397) were already exact-match hash lookups and cost 0.06 us/event between them;
 *   the cast-on-OTHER table could not be one, because the log names the target the wiki calls
 *   "Someone", so it was matched by walking all 648 suffixes calling `endsWith` — for every line
 *   no earlier family claimed, which is 20.2% of a real log. `SpellDb.castOnOtherByLastWord` now
 *   buckets those suffixes by the last word a matching line must end with. PAIRED BEFORE/AFTER,
 *   2026-08-06, this machine, this log, verified quiet (idle 1-3%), the two runs half an hour
 *   apart with nothing else changed:
 *
 *                                          before            after
 *     parse only, BARE parser         2,582 ms / 1.84 us   2,475 ms / 1.76 us
 *     parse only, THE APP INSTALLS   12,269 ms / 8.73 us   2,491 ms / 1.77 us
 *     …so the spell DB costs          9,688 ms / 6.90 us      17 ms / 0.01 us
 *     the whole fold, untimed        20,028 ms /  70,149/s  9,600 ms / 146,348/s
 *     the LAUNCH's replay phase      18,807 ms /  74,701/s 12,695 ms / 110,669/s
 *     …events/sec FOLDING               122,934              181,304
 *     max block                            22 ms                22 ms
 *
 *   The event stream is byte-identical across the change — same sha256 over all 1,404,455
 *   serialized events, same 94,923 buffApply, same 36,154,350 damage (law 8's tripwire, and
 *   tests/spellMessageIndex.test.mts is the permanent oracle). The parser the app installs is now
 *   within 1% of a parser with no spell DB at all, so the line item is not reduced but GONE, and
 *   `unattributed` — read + split + parse + dispatch — falls from 60.6% of the fold to 33.0%.
 *   What is left on top is the combat engine (37.3% of the smaller fold) and buffs (16.6%): the
 *   same absolute milliseconds as before, now the whole of the problem.
 *
 * AND THEN JOS-59 OPENED THE ENGINE ROW, which is what a table naming one opaque consumer is for.
 *   A THIRD ARM (`foldSections`) folds the same log with `combat/foldProbe.ts` installed and
 *   nothing else, and prints where the engine's own microseconds go. Its own arm on purpose: the
 *   section timer reads the clock inside `ingestEvent`, so beside the registry timer it would
 *   inflate the very row this comparison is about.
 *
 *   The sections named four per-line allocations, and a CPU profile of the same arm named the
 *   functions. All four are gone; every damage number is byte-identical
 *   (`npm run bench:engine-oracle`, 98 fixtures + the owner's log, diffs to nothing):
 *
 *                                        before            after
 *     engine: world model              1,302 ms            481 ms   (a mob's whole spawn history,
 *                                                                    walked and copied per line)
 *     engine: aggregate                1,490 ms          1,160 ms   (a string key per swing, twice)
 *     engine total                     4,042 ms          2,756 ms   2.88 -> 1.96 us/event
 *     module:buffs                     1,802 ms            977 ms   (a per-event sweep of a copy,
 *                                                                    through a regex, memoized)
 *     the whole fold, untimed          9,252 ms /151,877  7,051 ms /199,319
 *     the LAUNCH's replay phase       12,585 ms          9,034 ms
 *     …events/sec FOLDING                181,819            252,164
 *     max block                            18 ms             23 ms
 *
 *   Read the ARMS line with care after this change: the launch now reports a HIGHER folding rate
 *   than the in-process arm (0.79×), which trips the "arms disagree" note. That is the in-process
 *   arm being the slower of the two, not the launch cheating — the two were 0.84× before and the
 *   threshold is 0.80.
 *
 * THE INPUT. A bench that reads a different log each run measures the log, not the code. So:
 *   1. `tests/bench/fixtures/Logs/eqlog_*.txt` — the STANDARD fixture, if you have put one there.
 *      (Gitignored: a comparable bench log is ~100 MB of one person's real game log, which is
 *      exactly what the scrub law and the public-repo rule exist to keep out of git. Copy one in
 *      by hand; the path is the contract, not the bytes.)
 *   2. otherwise the machine's own EQ log, discovered exactly as the app discovers it — and the
 *      output SAYS SO, because numbers from a log that grows every evening are comparable with
 *      yesterday's run on this machine and with nothing else.
 * Either way the ledger line records the log's name and byte size, so a run whose input moved is
 * visible rather than mysterious.
 *
 * THE LEDGER. One JSON line per run appended to `.bench/replay.jsonl` (gitignored) — local,
 * accumulating, and the thing you actually diff when the next pipeline change lands.
 *
 * THE BUDGETS are constants below, each with its rationale. A human edits them deliberately;
 * nothing here ever ratchets them automatically, because a budget that moves itself is a budget
 * that has stopped saying anything.
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { MAIN_ENTRY, ROOT, buildIfStale, electronBinary, sleep } from '../e2e/appHarness.mjs'
// The e2e suite's own "which of these pages is the main window" answer — see the call site.
import { mainWindow } from '../e2e/appWindow.mjs'
import { printAttribution, runAttribution, type AttributionRun } from './attribution.mjs'
import { discoverEqRoot, fixedDrives, registryInstallCandidates, rootHasLogs } from '../../src/main/log/discovery'
import { REPLAY_DUTY } from '../../src/main/log/replaySlicer'
import {
  parseStartupProfile,
  replayDutyOf,
  type ReplayDutyStats,
  type StartupProfile
} from '../../src/shared/perf'
import { formatDataWeight } from '../../src/shared/dataWeight'

// ------------------------------------------------------------------------------- the budgets

/**
 * THE CHUNKING INVARIANT (plan §1): no main-loop block over 50 ms during replay. Same number the
 * perf HUD already calls "warn" — one threshold, one vocabulary. Before chunking this bench
 * FAILED here, loudly and on purpose; that failure is the whole reason the change exists.
 */
const MAX_BLOCK_MS_BUDGET = 50

// ------------------------------------------------------- the post-fold window (JOS-458, goal G2)
//
// G2 IS ABOUT A WINDOW THIS BENCH DID NOT USED TO REACH. Every number above stops at `replayDone`,
// and the two field reports this ticket exists for describe stalls of 250-1186 ms in the minute
// AFTER it — while the renderer hydrates, every module is snapshotted, the dumps are read and the
// world-rebuild fan-out fires. So the bench now keeps watching past the profile.
//
// HOW, and it is deliberately through EXISTING PRODUCT SURFACE rather than a bench-only channel:
// the perf HUD's own switch (`window.eq.setPerfHudEnabled`) starts main's 500 ms event-loop lag
// probe and pushes a `PerfSample` every 2 s, whose `lag.maxMs` is the worst single stall inside
// that 2 s. A stall of 250 ms cannot hide from a 500 ms self-timing probe. Adding an IPC channel
// for a test would be product surface a user pays for and never sees.
//
// ============================ WHAT THIS NUMBER IS NOT ============================
// THE HARNESS CANNOT MEASURE G2, and the output says so rather than printing a figure dressed as
// one. Two honest gaps, both structural:
//
//   1. NO WINDOW IS EVER SHOWN. `EQ_E2E=1` is the whole test mode (src/main/e2e.ts) and it never
//      shows a window, so the renderer NEVER COMPOSITES. A real session's post-fold minute
//      includes layout, paint and the GPU process doing work this run does not do — and hydration
//      that races a paint is not hydration that races nothing.
//   2. NOBODY IS PLAYING. A real post-fold minute has a live tail appending, alerts evaluating and
//      a person clicking between tabs, each of which asks for snapshots this run never asks for.
//
// Both gaps make the harness's number a FLOOR: what it measures is real, and a real session can
// only be worse. So it is printed and NOT asserted — a budget that can only ever be optimistic
// would turn G2 into a green light it has not earned. `blocksOver250` from a live install is what
// closes this goal, and the seam attribution shipped in the same ticket is what that install now
// carries.

/** What counts as a stall for G2. A quarter second is the magnitude the two field reports name. */
const POST_FOLD_STALL_MS = 250

/**
 * How long to keep watching after the profile lands. Thirty seconds rather than the goal's sixty,
 * because everything the harness CAN see — hydration, the module snapshot burst, both dump loads,
 * the rebuild fan-out — happens in the first few seconds of it, and the remaining half minute of
 * an idle hidden app measures the timer quantum at the cost of doubling the bench.
 *
 * `EQ_BENCH_POST_FOLD_MS=0` skips the window entirely, for a run that only wants the fold numbers.
 */
const POST_FOLD_MS = Number(process.env.EQ_BENCH_POST_FOLD_MS ?? '30000')

/**
 * THE THROUGHPUT FLOOR (plan §3), RE-DERIVED 2026-08-06 (JOS-50) — and now asserted against the
 * fold's WORKING time, not its wall clock.
 *
 * The original number: 0.5× the pre-chunking rate measured 2026-08-04 on this machine, when the
 * first line of .bench/replay.jsonl folded 1,240,019 events in 8,640 ms = 143,521 events/sec, half
 * of which was stated as a round 70,000.
 *
 * TWO THINGS BROKE THAT NUMBER, and only one of them is JOS-50's doing.
 *
 *   1. THE DUTY CYCLE (this change) makes the wall-clock rate partly a statement about the
 *      throttle: at a 60% duty the same code reports 60% of its own speed. An events-per-wall-
 *      second floor would therefore fail every time somebody chose to throttle harder, which is a
 *      decision, not a regression. So the floor moved onto `eventsPerWorkSec` — the slicer times
 *      its own rests, so the fold's speed can be asserted without the throttle in the way.
 *   2. THE FOLD ITSELF GOT MUCH MORE EXPENSIVE between 2026-08-04 and 2026-08-06, and this is NOT
 *      JOS-50: two baseline runs on the UNMODIFIED code (ledger lines 1 and 2, 2026-08-06) folded
 *      1,399,374 and 1,399,466 events at 32,596 and 31,877 events/sec — a 4.4× drop against the
 *      August 4 line on the same machine and the same log, which grew only 13% in events over
 *      those two days. It is not parsing: folding that same 108 MB log through `scanLog` with no
 *      module subscribers runs at 565k events/sec, so ~40 s of the 43 s is downstream of the
 *      parser. That regression wants its own ticket and its own bisect; what it must not do is
 *      sit behind a floor this bench has no way to distinguish from the throttle.
 *
 * So: 16,000 events per second OF FOLDING — 0.5× the re-measured 32k rate, the same "chunking may
 * cost throughput, but not half of it" rule applied to today's honest baseline. A human edits this
 * deliberately and states why, as here; nothing ratchets it automatically, because a budget that
 * moves itself has stopped saying anything.
 *
 * POSTSCRIPT, 2026-08-06 (JOS-55): THE 32k BASELINE DID NOT REPRODUCE, and the number above is
 * left exactly where it is until somebody decides otherwise deliberately. Three consecutive
 * launches on this machine and this log (ledger lines 1-3, same day, same 1,404,455 events) folded
 * at 134,182 / 134,494 / 132,957 events per second OF FOLDING — within 1% of each other and 4.2×
 * the 32k figure the floor was derived from, i.e. back level with the 143k measured on 2026-08-04
 * before the "regression" was noticed. Nothing in this repo changed to explain that, and the two
 * 32k lines were recorded on a day when several agents were running full e2e suites on the same
 * box. The likeliest reading is that the regression was MACHINE LOAD, not code — which is exactly
 * what a bench whose verdict depends on how busy the machine is will hand you if you let it.
 * JOS-56 should confirm on a quiet machine before bisecting anything. Raising the floor to match
 * today's rate is a budget decision, not a measurement, and is deliberately not taken here.
 *
 * RE-DERIVED 2026-08-06 (JOS-58) — 90,000, and the postscript above is why it had to move.
 *
 * That postscript disowned the foundation this number stood on: the 32k it is half of was a
 * loaded machine, not this code. A floor 11× below the real rate is not a lax floor, it is an
 * absent one — it could not catch a change that made the fold five times slower, and this file's
 * own doctrine is that a budget which has stopped saying anything is worse than no budget.
 *
 * THE HONEST BASELINE, on a machine verified quiet before each run (1-3% idle, nothing else on
 * the box — the contamination above is the reason that is now a precondition and not a habit):
 * 134,182 / 134,494 / 132,957 from JOS-55's three launches, 122,934 from JOS-58's paired BEFORE
 * run, and 181,304 AFTER it. Five launches, one machine, one log.
 *
 * So the floor is 0.5× the post-JOS-58 rate — the SAME rule as before ("chunking may cost
 * throughput, but not half of it"), applied to a baseline this repo can now reproduce rather than
 * to one it has since disavowed. 0.5 × 181,304 = 90,652, stated as a round 90,000.
 *
 * WHAT IT WILL AND WILL NOT CATCH, said plainly so the next failure is read correctly. It will
 * catch a real halving of the fold's speed. It will ALSO fail on a machine that is busy, because
 * a loaded box measured 32k on unmodified code — but every other number this bench prints (the
 * duty, the arms comparison, the whole attribution table) is already meaningless under load, the
 * header says so twice, and this bench deliberately does not run in CI. A red here means "either
 * you regressed the fold or you ran this beside something else"; check the second before
 * bisecting the first. A human edits this deliberately and states why, as here; nothing ratchets
 * it automatically.
 *
 * RE-DERIVED 2026-08-06 (JOS-59) — 115,000, by the SAME 0.5× rule, against a baseline this ticket
 * moved on purpose.
 *
 * JOS-59 deleted four per-line allocations from the fold (the world model's per-name spawn-history
 * walk, the two round accumulators' string keys, and the buffs module's per-event sweep through a
 * regex — see the commit messages), and the launch's `events/sec folding` went with them. THREE
 * consecutive launches after the change, this machine, this log: 252,164 / 236,376 / 228,457.
 *
 * AND THOSE THREE WERE NOT TAKEN ON A QUIET MACHINE, which is stated because this file's own
 * doctrine is that a bench whose verdict depends on the box has to say what the box was doing.
 * The owner returned mid-ticket: his dev app and `eqgame.exe` were both running for all three.
 * That makes them a LOWER bound rather than a best case, which is exactly the right direction for
 * a floor — so the derivation takes the WORST of the three rather than the mean or the best:
 * 0.5 × 228,457 = 114,228, stated as a round 115,000. A quiet machine clears it with more room
 * still (the quiet pre-change baseline was 181,819, and the quiet mid-ticket one 205,490).
 *
 * WHAT IT WILL AND WILL NOT CATCH is unchanged from the paragraph above, and so is the reading of
 * a red: check whether the box was busy before bisecting the fold.
 */
const EVENTS_PER_WORK_SEC_FLOOR = 115_000

/**
 * THE DUTY CEILING (JOS-50): the fold may not claim more of the wall clock than it said it would.
 *
 * An upper bound only, and deliberately so. Resting MORE than the target is never the complaint —
 * a loaded machine that hands the timer back late leaves the fold quieter than promised, which is
 * the direction this feature wants. Resting LESS means the throttle is not working: a slicer whose
 * ledger stopped paying out, or a `setImmediate` that crept back into the yield path, both show up
 * here and nowhere else. The 0.05 allowance covers the ledger's own bounded overshoot.
 */
const REPLAY_DUTY_CEILING = REPLAY_DUTY + 0.05

// --------------------------------------------------------------------------------- the input

/** The standard fixture root, shaped like an EQ install (`<root>/Logs/eqlog_<Char>_<server>.txt`). */
const FIXTURE_ROOT = join(ROOT, 'tests', 'bench', 'fixtures')
/** Its OWN userData, never the e2e harness's: this must be runnable beside anything else. */
const BENCH_USER_DATA = join(tmpdir(), 'everquest-companion-bench-userdata')
const LEDGER_DIR = join(ROOT, '.bench')
const LEDGER = join(LEDGER_DIR, 'replay.jsonl')
/** A 100 MB log takes seconds to fold on a good machine and much longer on a loaded one. */
const REPLAY_TIMEOUT_MS = 300_000

type InputSource = 'fixture' | 'machine'

interface BenchInput {
  source: InputSource
  /** Set as EQ_INSTALL_DIR when we are pinning the app to the fixture; undefined = let it discover. */
  installDir?: string
  /** The log we EXPECT it to read, for the note. The authoritative answer comes from the app. */
  logPath?: string
}

function newestLogIn(logsDir: string): string | undefined {
  if (!existsSync(logsDir)) return undefined
  const logs = readdirSync(logsDir)
    .filter((f) => /^eqlog_.+\.txt$/i.test(f))
    .map((f) => join(logsDir, f))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return logs[0]?.p
}

/** Fixture first, the machine's own log second. Never invents an input it cannot name. */
function resolveInput(): BenchInput {
  const fixtureLog = newestLogIn(join(FIXTURE_ROOT, 'Logs'))
  if (fixtureLog) return { source: 'fixture', installDir: FIXTURE_ROOT, logPath: fixtureLog }
  // The app's OWN discovery order, so the bench and the app never disagree about which log this is.
  const root = discoverEqRoot({
    hasLogs: rootHasLogs,
    extraCandidates: () => registryInstallCandidates(),
    fixedDrives
  })
  return { source: 'machine', ...(root ? { logPath: newestLogIn(join(root, 'Logs')) } : {}) }
}

// ------------------------------------------------------------------------------- the boot

function launch(input: BenchInput): Promise<ElectronApplication> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EQ_E2E: '1',
    EQ_E2E_USER_DATA: BENCH_USER_DATA,
    NODE_ENV: 'production'
  }
  if (input.installDir) env.EQ_INSTALL_DIR = input.installDir
  else delete env.EQ_INSTALL_DIR
  return electron.launch({
    executablePath: electronBinary(),
    args: [MAIN_ENTRY],
    cwd: ROOT,
    env,
    timeout: 60_000
  })
}

interface CharacterRefLite {
  name: string
  server: string
  logPath: string
}

/** Which log the app actually tailed — asked of the app, not inferred. Null until the scan ends. */
function activeCharacter(page: Page): Promise<CharacterRefLite | null> {
  return page.evaluate(() =>
    (
      window as unknown as { eq: { getCharacter: () => Promise<CharacterRefLite | null> } }
    ).eq.getCharacter()
  ) as Promise<CharacterRefLite | null>
}

/**
 * Wait for the launch to leave a COMPLETE profile behind. The file is written when the last phase
 * lands, so its appearance is the signal that both the replay and the renderer's mount are done —
 * there is nothing to poll inside the app for, and nothing to guess at with a sleep.
 */
async function waitForProfile(): Promise<StartupProfile | null> {
  const path = join(BENCH_USER_DATA, 'perf-startup.json')
  const deadline = Date.now() + REPLAY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const profile = parseStartupProfile(JSON.parse(readFileSync(path, 'utf8')) as unknown)
      if (profile?.complete) return profile
    } catch {
      // not written yet (or half-written — it is renamed into place, but be forgiving anyway)
    }
    await sleep(500)
  }
  return null
}

// ------------------------------------------------------- the post-fold observation (JOS-458)

/** What the window saw. `null` when it was skipped or when the HUD refused to start — never a row
 *  of zeros, which would claim a quiet thirty seconds were observed. */
interface PostFoldWindow {
  observedMs: number
  /** 500 ms lag-probe ticks folded into the 2 s samples below. The denominator: a `maxBlockMs` of
   *  0 over zero samples is not a smooth window, it is an unobserved one. */
  lagSamples: number
  /** 2 s samples collected. */
  windows: number
  maxBlockMs: number
  /** 2 s windows that contained at least one stall of `POST_FOLD_STALL_MS` or worse. It counts
   *  WINDOWS, not stalls, because `PerfSample.lag` reports a max rather than a list — so it is a
   *  floor on the stall count, and the name says which. */
  windowsOverStall: number
}

/**
 * Watch the app for `POST_FOLD_MS` after its profile lands, through the HUD's own switch.
 *
 * The collector is installed BEFORE the switch is flipped, so the first sample — which arrives
 * immediately rather than at the next tick, because `perf:setEnabled` starts the sampler in the
 * same call — is not lost. The switch is turned back off afterwards so nothing about this run's
 * teardown differs from an ordinary bench boot.
 */
async function observePostFold(page: Page): Promise<PostFoldWindow | null> {
  if (!(POST_FOLD_MS > 0)) return null
  const started = Date.now()
  // THE FAILURE IS REPORTED, NOT SWALLOWED. The first run of this window came back `null` and said
  // nothing about why, which for a bench is worse than not having the number: a measurement that
  // can quietly become "not observed" is one nobody will notice has stopped working.
  const installed = await page
    .evaluate(async () => {
      const w = window as unknown as {
        eq?: {
          onPerfSample?: (
            cb: (s: { lag: { samples: number; maxMs: number } } | null) => void
          ) => void
          setPerfHudEnabled?: (on: boolean) => Promise<unknown>
        }
        __benchLag?: { samples: number; maxMs: number }[]
      }
      if (typeof w.eq?.onPerfSample !== 'function') return 'no window.eq.onPerfSample'
      if (typeof w.eq.setPerfHudEnabled !== 'function') return 'no window.eq.setPerfHudEnabled'
      w.__benchLag = []
      w.eq.onPerfSample((s) => {
        if (s !== null) w.__benchLag?.push(s.lag)
      })
      try {
        await w.eq.setPerfHudEnabled(true)
      } catch (err) {
        return `setPerfHudEnabled threw: ${String(err)}`
      }
      return 'ok'
    })
    .catch((err: unknown) => `evaluate threw: ${String(err)}`)
  if (installed !== 'ok') {
    console.log(`  post-fold: NOT OBSERVED — ${installed}`)
    return null
  }
  await sleep(POST_FOLD_MS)
  const lags = await page
    .evaluate(async () => {
      const w = window as unknown as {
        eq: { setPerfHudEnabled: (on: boolean) => Promise<unknown> }
        __benchLag?: { samples: number; maxMs: number }[]
      }
      const out = w.__benchLag ?? []
      await w.eq.setPerfHudEnabled(false)
      return out
    })
    .catch(() => [] as { samples: number; maxMs: number }[])
  return {
    observedMs: Date.now() - started,
    lagSamples: lags.reduce((n, l) => n + l.samples, 0),
    windows: lags.length,
    maxBlockMs: lags.reduce((m, l) => Math.max(m, l.maxMs), 0),
    windowsOverStall: lags.filter((l) => l.maxMs >= POST_FOLD_STALL_MS).length
  }
}

// ------------------------------------------------------------------------------- the readout

interface BenchRun {
  ts: string
  version: string
  source: InputSource
  log: string
  logBytes: number
  totalMs: number
  replayMs: number
  eventsReplayed: number
  eventsPerSec: number
  /** Events per second of FOLDING. Null on a launch whose profile carried no duty ledger. */
  eventsPerWorkSec: number | null
  /** Fraction of the replay's wall clock spent folding, measured by the slicer. */
  replayDuty: number | null
  replayWorkMs: number | null
  replayRestMs: number | null
  replaySlices: number | null
  maxBlockMs: number | null
  blocksOver50Ms: number | null
  blockSamples: number
  /**
   * WHAT HAPPENED AFTER THE FOLD (JOS-458, goal G2) — the window the two field reports are about,
   * which every number above stops short of. Null when it was skipped or could not be observed;
   * read `POST_FOLD_MS`'s header for the two structural reasons this is a FLOOR and not a G2
   * verdict.
   */
  postFold: PostFoldWindow | null
  /**
   * WHAT THE COMMITTED DATA WEIGHS, total bytes (JOS-458). ONE field on the ledger line rather
   * than the whole table, deliberately: the per-file breakdown is in the profile and on the
   * startup log line, and what a run-over-run ledger needs is the single number whose MOVEMENT is
   * the question — "the launch got slower and the corpus grew 900 kB in the same release" is a
   * sentence this column makes writable. Null on a profile with no ledger.
   */
  dataBytes: number | null
  phases: Record<string, number>
  /**
   * WHERE THE FOLD WENT (JOS-55) — the in-process arm's per-consumer table, its parse-only
   * comparator and the instrument's own cost, carried on the SAME ledger line as the launch above
   * so a run accumulates one comparable record rather than two files nobody joins. Null when the
   * arm could not run (no log, or no character to name it after).
   */
  attribution: AttributionRun | null
}

/** What the ledger says the input WAS, so a run whose log moved is visible rather than mysterious. */
function describeLog(logPath: string | undefined): { log: string; logBytes: number } {
  if (!logPath || !existsSync(logPath)) return { log: logPath ? basename(logPath) : 'unknown', logBytes: 0 }
  return { log: basename(logPath), logBytes: statSync(logPath).size }
}

/** The duty ledger's columns (JOS-50). Absent on a launch with no log to fold — reported as nulls
 *  rather than as zeroes nobody measured, exactly like the block probe's samples. */
type DutyColumns = Pick<
  BenchRun,
  'eventsPerWorkSec' | 'replayDuty' | 'replayWorkMs' | 'replayRestMs' | 'replaySlices'
>

function dutyColumns(events: number, duty: ReplayDutyStats | undefined): DutyColumns {
  if (!duty) {
    return {
      eventsPerWorkSec: null,
      replayDuty: null,
      replayWorkMs: null,
      replayRestMs: null,
      replaySlices: null
    }
  }
  return {
    eventsPerWorkSec: duty.workMs > 0 ? Math.round((events / duty.workMs) * 1000) : null,
    replayDuty: replayDutyOf(duty),
    replayWorkMs: Math.round(duty.workMs),
    replayRestMs: Math.round(duty.restMs),
    replaySlices: duty.slices
  }
}

/** Everything the run knows that is not in the profile. One object rather than four positional
 *  arguments, so `foldRun` stays inside the repo's four-parameter ceiling as the ledger grows. */
interface RunExtras {
  logPath: string | undefined
  attribution: AttributionRun | null
  postFold: PostFoldWindow | null
}

function foldRun(profile: StartupProfile, input: BenchInput, extras: RunExtras): BenchRun {
  const phases: Record<string, number> = {}
  for (const p of profile.phases) phases[p.phase] = Math.round(p.durationMs)
  const replayMs = phases.replayDone ?? 0
  const events = profile.eventsReplayed ?? 0
  const block = profile.block
  return {
    ts: new Date().toISOString(),
    version: profile.version,
    source: input.source,
    ...describeLog(extras.logPath),
    totalMs: Math.round(profile.totalMs),
    replayMs,
    eventsReplayed: events,
    eventsPerSec: replayMs > 0 ? Math.round((events / replayMs) * 1000) : 0,
    ...dutyColumns(events, profile.replay),
    maxBlockMs: block ? block.maxBlockMs : null,
    blocksOver50Ms: block ? block.blocksOver50Ms : null,
    blockSamples: block ? block.samples : 0,
    postFold: extras.postFold,
    dataBytes: profile.data ? profile.data.totalBytes : null,
    phases,
    attribution: extras.attribution
  }
}

const num = (n: number): string => n.toLocaleString('en-US')

function printTable(run: BenchRun): void {
  const rows: [string, string][] = [
    ['log', `${run.log} (${num(Math.round(run.logBytes / 1_048_576))} MB, ${run.source})`],
    ['startup total', `${num(run.totalMs)} ms`],
    ['replay', `${num(run.replayMs)} ms`],
    ['events replayed', num(run.eventsReplayed)],
    ['events/sec', `${num(run.eventsPerSec)}  (wall clock — the wait a user sits through)`],
    [
      'events/sec folding',
      run.eventsPerWorkSec === null
        ? 'not measured (this launch left no duty ledger)'
        : `${num(run.eventsPerWorkSec)}  (floor ${num(EVENTS_PER_WORK_SEC_FLOOR)})`
    ],
    [
      'replay duty',
      run.replayDuty === null
        ? 'not measured'
        : `${String(Math.round(run.replayDuty * 100))}%  (target ${String(Math.round(REPLAY_DUTY * 100))}%, ceiling ${String(Math.round(REPLAY_DUTY_CEILING * 100))}%)` +
          ` — ${num(run.replayWorkMs ?? 0)} ms folding / ${num(run.replayRestMs ?? 0)} ms resting over ${num(run.replaySlices ?? 0)} slices`
    ],
    [
      'max block',
      run.maxBlockMs === null
        ? 'not measured (the probe held no ticks)'
        : `${num(run.maxBlockMs)} ms  (budget ${String(MAX_BLOCK_MS_BUDGET)} ms, ${String(run.blockSamples)} probe ticks)`
    ],
    ['blocks over 50 ms', run.blocksOver50Ms === null ? 'not measured' : num(run.blocksOver50Ms)],
    ['post-fold window', postFoldLine(run.postFold)]
  ]
  console.log('')
  for (const [label, value] of rows) console.log(`  ${label.padEnd(18)} ${value}`)
  console.log('')
  console.log(`  phases: ${Object.entries(run.phases).map(([k, v]) => `${k} ${num(v)}ms`).join(' · ')}`)
  console.log('')
  if (run.postFold !== null) {
    // THE CAVEAT TRAVELS WITH THE NUMBER. Printing `0 windows over 250 ms` beside the fold budgets
    // and saying nothing else would read as G2 met, and this harness structurally cannot say that
    // — see POST_FOLD_MS's header. It is a floor, and the line says the word.
    console.log(
      `  post-fold is a FLOOR, not a G2 verdict: EQ_E2E never shows a window (so the renderer never` +
        ` composites) and nobody is playing. A real session can only be worse.`
    )
    console.log('')
  }
}

/** The post-fold row, or why there isn't one. */
function postFoldLine(w: PostFoldWindow | null): string {
  if (w === null) return POST_FOLD_MS > 0 ? 'not observed (the HUD switch did not take)' : 'skipped'
  return (
    `${num(Math.round(w.observedMs / 1000))} s watched · max block ${num(w.maxBlockMs)} ms · ` +
    `${num(w.windowsOverStall)} of ${num(w.windows)} 2s windows held a stall >= ${String(POST_FOLD_STALL_MS)} ms ` +
    `(${num(w.lagSamples)} probe ticks)`
  )
}

/**
 * Who the attribution arm folds AS. The app's own answer if the launch gave one (it is the
 * authority on which log it tailed); otherwise the log's file name, which is the only other place
 * the character's name is written down. The name is not decoration: the parser's self-`/who` rule
 * cannot fire without it, so a fold that guessed wrong would fold a slightly different program.
 */
function characterFor(
  tailed: CharacterRefLite | null,
  logPath: string
): { name: string; server: string; logPath: string } | null {
  if (tailed) return { name: tailed.name, server: tailed.server, logPath: tailed.logPath }
  const m = /^eqlog_(.+)_([^_]+)\.txt$/i.exec(basename(logPath))
  return m?.[1] && m[2] ? { name: m[1], server: m[2], logPath } : null
}

/**
 * THE TWO ARMS ARE NOT THE SAME MEASUREMENT, and the readout says so rather than letting a reader
 * assume it. The launch folds inside Electron beside a renderer, a window and the IPC surface, on
 * a duty cycle; the attribution arm folds the same bytes through the same consumers in this
 * process, unthrottled. When they agree, the table describes the launch. When they do not, THAT is
 * the finding — something outside the fold's own code is charging the launch for it.
 */
function compareArms(run: BenchRun, attribution: AttributionRun): void {
  const launch = run.eventsPerWorkSec
  if (launch === null) return
  const ratio = attribution.foldEventsPerSec / Math.max(1, launch)
  console.log(
    `  arms: launch ${num(launch)} events/sec folding vs in-process ${num(attribution.foldEventsPerSec)} — ` +
      `${ratio.toFixed(2)}×${ratio > 1.25 || ratio < 0.8 ? ' — THE ARMS DISAGREE: the gap is not in the folding code' : ''}`
  )
  console.log('')
}

/** Append the run to the local ledger BEFORE asserting anything: a failing run is exactly the one
 *  whose numbers you want to keep. */
function record(run: BenchRun): void {
  mkdirSync(LEDGER_DIR, { recursive: true })
  appendFileSync(LEDGER, `${JSON.stringify(run)}\n`, 'utf8')
  console.log(`  ledger: .bench/replay.jsonl (+1 line, ${String(readFileSync(LEDGER, 'utf8').trim().split('\n').length)} total)`)
}

function assertBudgets(run: BenchRun): number {
  const failures: string[] = []
  if (run.maxBlockMs === null) {
    failures.push('the startup block probe recorded no samples — maxBlockMs cannot be asserted')
  } else if (run.maxBlockMs > MAX_BLOCK_MS_BUDGET) {
    failures.push(
      `maxBlockMs ${num(run.maxBlockMs)} ms exceeds the ${String(MAX_BLOCK_MS_BUDGET)} ms chunking invariant`
    )
  }
  if (run.eventsPerWorkSec === null) {
    failures.push('the replay left no duty ledger — neither the fold rate nor the duty can be asserted')
  } else if (run.eventsPerWorkSec < EVENTS_PER_WORK_SEC_FLOOR) {
    failures.push(
      `events/sec folding ${num(run.eventsPerWorkSec)} is under the ${num(EVENTS_PER_WORK_SEC_FLOOR)} floor ` +
        `(0.5× the worst of JOS-59's three post-change launches) — confirm the machine was idle before bisecting the fold`
    )
  }
  if (run.replayDuty !== null && run.replayDuty > REPLAY_DUTY_CEILING) {
    failures.push(
      `replay duty ${String(Math.round(run.replayDuty * 100))}% exceeds the ${String(Math.round(REPLAY_DUTY_CEILING * 100))}% ceiling — the throttle is not throttling`
    )
  }
  if (failures.length === 0) {
    console.log('  bench: both budgets met')
    return 0
  }
  console.log(`  bench: FAILED (${String(failures.length)})`)
  for (const f of failures) console.log(`    - ${f}`)
  return 1
}

// ------------------------------------------------------------------------------------- main

async function main(): Promise<void> {
  const input = resolveInput()
  if (input.source === 'fixture') {
    console.log(`bench: standard fixture — ${input.logPath ?? '?'}`)
  } else {
    console.log('bench: NO fixture at tests/bench/fixtures/Logs — falling back to this machine’s own EQ log.')
    console.log('bench: NOTE — numbers from a live, growing log are comparable with earlier runs on THIS')
    console.log('bench:        machine and with nothing else. Do not quote them against another machine.')
  }
  if (!input.logPath) {
    console.error('bench: no EQ log found at all — nothing to replay. (Put one under tests/bench/fixtures/Logs/.)')
    process.exitCode = 1
    return
  }

  buildIfStale()
  rmSync(BENCH_USER_DATA, { recursive: true, force: true })

  console.log(`launch: hidden Electron (EQ_E2E=1), fresh userData — replaying ${basename(input.logPath)}…`)
  const t0 = Date.now()
  const app = await launch(input)
  let tailed: CharacterRefLite | null = null
  let profile: StartupProfile | null = null
  let postFold: PostFoldWindow | null = null
  try {
    // THE MAIN WINDOW, NOT THE FIRST ONE. `firstWindow()` answers with whichever page loaded
    // first, and the toast overlay defaults OPEN (AGENTS.md, JOS-58's ruling) — so on a normal
    // boot it is frequently the overlay bundle, which carries `eqOverlay` and not `eq`. The
    // character read below tolerated that by falling back to the log's file name; the post-fold
    // window did not, and reported `no window.eq.onPerfSample` on its first run. `mainWindow` is
    // the e2e suite's existing answer to exactly this and is now what the bench asks too.
    const page = await mainWindow(app, 60_000)
    profile = await waitForProfile()
    tailed = await activeCharacter(page).catch(() => null)
    // …and THEN keep watching (JOS-458, G2). It runs after the profile is complete and before the
    // close, which is the only place it can: the window this measures opens exactly where the
    // profile stops, and the app has to still be alive to be watched.
    if (profile) {
      console.log(`  post-fold: watching for ${String(Math.round(POST_FOLD_MS / 1000))}s past replayDone…`)
      postFold = await observePostFold(page)
    }
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(`  boot: ${String(Math.round((Date.now() - t0) / 1000))}s wall clock (launch → profile → close)`)

  if (!profile) {
    console.error(`bench: the launch never wrote a complete perf-startup.json within ${String(REPLAY_TIMEOUT_MS / 1000)}s`)
    process.exitCode = 1
    return
  }

  // THE ATTRIBUTION ARM (JOS-55), after the launch has closed: four folds of the same log in this
  // process — parse-only, timing off, timing on, timing off again. Nothing else may be running on
  // this machine while it does (see the header): the % column survives a busy machine, the
  // absolute microseconds do not.
  const foldPath = tailed?.logPath ?? input.logPath
  const character = characterFor(tailed, foldPath)
  const attribution = character ? await runAttribution(character) : null

  const run = foldRun(profile, input, { logPath: foldPath, attribution, postFold })
  printTable(run)
  // THE DATA LEDGER (JOS-458), printed whole rather than as the one column the ledger line carries:
  // the run-over-run question is answered by `dataBytes`, but the question a person asks the FIRST
  // time a run gets slower is "which corpus", and that needs the table.
  console.log(
    profile.data === undefined
      ? '  data: no ledger in this profile (run npm run gen:data-weight)'
      : `  ${formatDataWeight(profile.data)}`
  )
  console.log('')
  if (attribution) {
    printAttribution(attribution)
    compareArms(run, attribution)
  } else {
    console.log('  attribution: skipped — the log’s character could not be named (see characterFor).')
  }
  record(run)
  process.exitCode = assertBudgets(run)
}

main().catch((err: unknown) => {
  console.error('bench: harness error —', err)
  process.exitCode = 1
})
