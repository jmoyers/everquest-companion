/**
 * THE TWO FOLDS, COMPARED INSIDE THE RUNNING APP (JOS-479, phase 3).
 *
 * WHAT IS NEW HERE, AND WHY IT IS NOT `engine-boots`. That spec owns the LIFECYCLE seam — spawn,
 * ready, kill, respawn, quit, absence — and to observe a READY line it deliberately KILLS the
 * engine, because a tap attached when the launch resolves has already missed the first one. This
 * spec's subject is the opposite: an engine that lives long enough to fold a whole log and answer
 * questions about it. Putting both in one file would make each claim's evidence depend on the
 * other's staged failure (a probe running against the SECOND engine, its attach racing a backoff),
 * and it would put two full app launches and two full folds inside one 5-minute spec cap. Two
 * launches of two different shapes, so two specs.
 *
 * WHAT IT CLAIMS, in the order it proves them:
 *
 *   1. THE APP IS A CLIENT, AND THE ENGINE IS ON THE APP'S OWN LOG. The probe line's bracket quotes
 *      the engine's `session.health` mark — `mark <offset> of <path>`, the (log identity, byte
 *      offset) coordinate the whole design addresses state by (ruling 18 law 3) — and that path is
 *      the harness's private staged fixture. The engine NEVER DISCOVERS A PATH OF ITS OWN and never
 *      reads a settings file (`SessionAttachParams`), so an engine folding this file can only have
 *      been told to by this app's client. The epoch in the same bracket is `2` rather than `1`,
 *      which is the accepted attach that put it there.
 *
 *      WHY NOT ASSERT THE APP'S OWN `data-server engine attached: …` SENTENCE, which exists and is
 *      right there in the dev log? MEASURED on this ticket: it is printed BEFORE `electron.launch()`
 *      resolves, so a tap attached the instant a launch resolves has already missed it — the same
 *      rule `engine-boots.e2e.mts` documents for the READY line. And the mark echo is the stronger
 *      claim anyway: it is the ENGINE's statement about what it is doing, not the app's statement
 *      about what it asked for. Nothing here reaches for `window.eq`: the renderer is untouched by
 *      this ticket, and a spec that added a bridge to observe a main-process instrument would be
 *      testing a product nobody shipped.
 *
 *   2. BOTH WORLDS LANDED AND WERE COMPARED AT MATCHED MARKS. `skipped: 0` is load-bearing rather
 *      than tidy — the probe SKIPS any module whose two seqs disagree, so a run that skipped
 *      everything would report `0 diverge` and read like success.
 *
 *   3. THE VERDICT, MODULE BY MODULE, INCLUDING THE ONE THAT DOES NOT AGREE — see below.
 *
 *   4. AND THE ENGINE'S ANSWER ABOUT THE FILE ITSELF (JOS-481, owner ruling 21): `logMtimeMs`, in
 *      the same bracket, checked against a `statSync` of the staged fixture taken by this spec. It
 *      is not a verdict — there is no second side to disagree with it — it is the one served fact
 *      whose truth can be settled against the disk, which is why it is asserted rather than read.
 *
 * ── THE ONE KNOWN ASYMMETRY, PINNED RATHER THAN EXCUSED ────────────────────────────────────────
 *
 * JOS-479 measured TWO, and both turned out to be structural facts about where the wall clock and
 * the filesystem live rather than fold defects — which is precisely what an IN-APP probe can see and
 * the offline oracle (`npm run oracle:rust-fold`, green on all twenty modules over six slices)
 * structurally cannot. JOS-481 is the owner's resolution of both. One is closed and one is not, and
 * the survivor is asserted WITH ITS PATH, so that the day it closes this spec goes red and somebody
 * deletes the exemption instead of a divergence quietly appearing under a green tick.
 *
 *   * `character` at `.character.lastPlayed` — STILL EXEMPT, dated JOS-481 (2026-08-25). The app's
 *     `CharacterRef` carries `statSync(logPath).mtimeMs` (`main/log/config.ts`), pushed into the
 *     module by `session.ts resetWorldFor`. It is a FILESYSTEM fact, not a fold fact; the engine
 *     derives its ref from the log's file NAME and never puts an mtime into fold state
 *     (`engined/README.md`, "The fold seam"), which ruling 18 requires — a served process fact is
 *     not addressed by (log identity, byte offset) and must not enter a module. Ruling 21 answers
 *     the OTHER half: the engine now SERVES the fact, on `session.health` as `logMtimeMs`, and this
 *     spec asserts it. The exemption closes when the character-picker surface cuts over to that
 *     served answer and the TS fold stops publishing its app-pushed copy — a later ticket in the
 *     cutover ledger, not this one. Until then the app's fold carries a field the engine's cannot.
 *
 *     JOS-493 CLOSED THE PRODUCT'S HALF OF IT AND THIS ROW STILL STANDS, which is worth stating
 *     because the two look like the same claim and are not. The compat shim now GRAFTS the served
 *     `logMtimeMs` onto the character snapshot it hands the app (`serveShim.ts graftLastPlayed`), so
 *     a picker running under `EQC_ENGINE_SERVE=1` is no longer handed a ref with the field missing —
 *     `engine-shim.e2e.mts` claim 5 pins that end to end, through `window.eq`. THIS spec's probe has
 *     no shim in it: `engineClientHost.askOne` asks the engine directly and compares the RAW fold
 *     states, which is exactly the surface ruling 18 requires to stay free of a filesystem fact. So
 *     the row is not stale — it is measuring the thing that must not change, and it closes only when
 *     the app's own fold stops publishing its copy.
 *
 *   * `buffs` at `.active.length` — CLOSED by JOS-481 (owner ruling 22), and this spec now asserts
 *     agreement. The engine published 12 actives and the app 3; MEASURED on a bench fold of the same
 *     bytes, the TS fold publishes **12** before any tick and **3** after a single
 *     `registry.tick(Date.now())`. The two folds always agreed about the bytes — what differed was
 *     that only one of them had a heartbeat. The engine has one now: `fold::Fold::tick`, driven by
 *     the ingest ~1×/sec while the status is `live`, with ONE beat taken at go-live before
 *     `status: "live"` is ever published, which is the ordering that makes this assertion
 *     deterministic rather than a race against a cadence. A HISTORICAL FOLD STILL NEVER TICKS, so
 *     the equivalence law is untouched and the default oracle staying green is the proof of it.
 *
 * WHY THE FIXTURE MAKES THIS DETERMINISTIC. `logFixture.mts` stages a private copy of a committed
 * log and this spec never appends to it, so both folds read the same finite bytes and stop. On the
 * owner's live log the same probe would honestly report drift for anything the two worlds had not
 * reached together; here there is nothing left to reach. The buffs agreement is stable for a
 * stronger reason than "the counts happen to match": the fixture's buffs are dated Aug 2026 and
 * both worlds sweep them against the HOST's clock, which is past every cap by hours at minimum and
 * grows only further past it — so the fixture ages INTO the assertion, never out of it. And the
 * surviving `character` divergence is stable because an mtime is always present on one side and
 * structurally absent on the other.
 *
 * Run: `npm run test:e2e -- engine-parity`
 */
import { statSync } from 'node:fs'
import { buildEngineIfStale, buildIfStale, check, failures, note, reportRun } from './appHarness.mjs'
import { closeWindows, mainWindow } from './appWindow.mjs'
import { launchOnFixture, type FixtureLaunch } from './logFixture.mjs'
import { PARITY_PROBE_MODULES } from '../../src/main/dataServer/parityProbe'
import { settleParity, tapOutput, type AppOutput, type ParitySay } from './engineSteps.mjs'
import { stepEnginePerfPanel } from './enginePerfSteps.mjs'

/**
 * The richest committed fixture whose subject is the MODEL rather than a window: buff landings and
 * wear-offs, loot, kills and level-ups over 129 KB. Chosen because `buffs` is the hardest module in
 * the probe set — cluster 2c, a shared core with buffTimers, the message-overlay miner riding along
 * — and a fixture that never lands a buff would compare five empty states and prove very little.
 */
const FIXTURE = 'e2e-overlay.log'

/** The divergences this spec is pinning, with the exact path each occurs at. Every other module in
 *  the probe set must agree. Deleting a row here is how a fix is claimed — JOS-481 deleted `buffs`.
 *
 *  `character` stays, dated JOS-481 (2026-08-25): the engine SERVES the mtime now (asserted below,
 *  off the same line) but the TS fold still publishes its own app-pushed copy inside
 *  `.character.lastPlayed`, and it will until the character-picker surface reads the served answer
 *  instead. That is the cutover, not this ticket. */
const KNOWN_ASYMMETRY: Readonly<Record<string, string>> = {
  character: '.character.lastPlayed'
}

/** Everything the app said about the engine — the failure detail for a claim whose evidence is a
 *  sentence that never arrived. */
function engineNarration(out: AppOutput): string {
  const said = out
    .text()
    .split('\n')
    .filter((line) => line.includes('data-server'))
  return said.slice(-6).join(' | ') || 'the app never mentioned the engine at all'
}

/** Windows says the same path in more than one case; the comparison is about WHICH FILE. */
function samePath(a: string, b: string): boolean {
  return a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()
}

/**
 * STEP 1 — the engine is folding the app's own log, and says so itself.
 *
 * The strongest claim available without a renderer, and it needs no second wait: the engine's
 * `session.health` mark is quoted in the very line this spec already waited for. See the header for
 * why the app's own attach sentence is not the evidence.
 */
function stepEngineIsOnOurLog(launch: FixtureLaunch, parity: ParitySay): void {
  const where = parity.engineLog
  check(
    'the ENGINE says it is folding the very log this app staged — it discovers no path of its own, so the app told it',
    where !== null && samePath(where, launch.log.logPath),
    where === null ? parity.where : `engine ${where} · app ${launch.log.logPath}`
  )
  check(
    '…in a generation the app’s own session.attach created: a fresh engine is epoch 1, and this is not',
    /epoch [2-9]\d*/.test(parity.where),
    parity.where
  )
}

/**
 * STEP 1b — THE FILE FACT THE ENGINE SERVES (JOS-481, owner ruling 21).
 *
 * The engine stats the log it owns and reports the mtime; this checks the number it reported against
 * the file on disk, statted here. TRUNCATED, because Node reports the NTFS stamp as a float with
 * sub-millisecond digits and the protocol field is an integer — `Math.floor` is exactly what the
 * Rust side's millisecond truncation produces for any stamp past the epoch.
 *
 * IT IS ASSERTED AGAINST THE FILE, NEVER AGAINST `Date.now()`. The claim is not "the engine said a
 * plausible number", it is "the engine read THIS file"; only the file can settle that, and a
 * now-shaped bound would be satisfied by an engine that statted the wrong log in the same second.
 */
function stepEngineServesTheFileFact(launch: FixtureLaunch, parity: ParitySay): void {
  const served = parity.engineMtimeMs
  const truth = Math.floor(statSync(launch.log.logPath).mtimeMs)
  check(
    'the ENGINE stats the log it owns and serves the mtime — the same number this spec reads off the file',
    served === truth,
    served === null ? `the line said no mtime · ${parity.where}` : `engine ${String(served)} · disk ${String(truth)}`
  )
}

/** STEP 2 — the probe ran, both worlds had landed, and it compared rather than skipped. */
function stepProbeIsSound(parity: ParitySay): boolean {
  const live = check(
    'the probe waited for the ENGINE’s fold: it reports a live ingest with an event count of its own',
    /engine live/.test(parity.where) && /[1-9]\d* events/.test(parity.where),
    parity.where
  )
  const whole = check(
    `every module in the probe set was asked (${String(PARITY_PROBE_MODULES.length)})`,
    parity.probed === PARITY_PROBE_MODULES.length,
    `probed ${String(parity.probed)}`
  )
  // THE ANTI-VACUITY CHECK. A module whose two seqs disagree is SKIPPED, never compared, so a run
  // that skipped everything would report `0 diverge` and read like success.
  const compared = check(
    '…and every one of them was compared AT A MATCHED MARK — nothing was skipped for drift',
    parity.skipped === 0,
    `${String(parity.skipped)} skipped · ${parity.line}`
  )
  return live && whole && compared
}

/** One module the two worlds are expected to agree about. */
function checkAgrees(parity: ParitySay, module: string): void {
  const verdict = parity.verdict(module)
  check(
    `…${module}: the Rust fold's published state deep-equals this process's`,
    verdict === 'AGREE',
    verdict === 'AGREE' ? 'deep-equal' : `said ${verdict ?? 'nothing — the line never named it'}`
  )
}

/** One module carrying a known asymmetry: it must still diverge, and at exactly the known path. */
function checkKnownAsymmetry(parity: ParitySay, module: string, path: string): void {
  const where = parity.divergePath(module)
  const detail =
    where === path
      ? `still ${path}`
      : where === null
        ? `it says ${parity.verdict(module) ?? 'nothing'} now — if this is a FIX, delete the row from KNOWN_ASYMMETRY`
        : `diverged at ${where} instead — a NEW divergence, not the known one`
  check(`…${module}: the KNOWN asymmetry at ${path}, and nothing else`, where === path, detail)
}

/** STEP 3 — the verdict, module by module, so a red run names which fold moved. */
function stepVerdicts(parity: ParitySay): void {
  const expectedAgree = PARITY_PROBE_MODULES.filter((m) => !(m in KNOWN_ASYMMETRY))
  const pinned = Object.keys(KNOWN_ASYMMETRY)
  check(
    `the two folds agree everywhere they can: ${String(expectedAgree.length)} agree and the only ` +
      `divergence is the pinned one (${pinned.join(', ')})`,
    parity.agree === expectedAgree.length && parity.diverge === pinned.length,
    parity.line
  )
  for (const module of PARITY_PROBE_MODULES) {
    const known = KNOWN_ASYMMETRY[module]
    if (known === undefined) checkAgrees(parity, module)
    else checkKnownAsymmetry(parity, module, known)
  }
}

async function main(): Promise<void> {
  buildIfStale()
  // The engine's own gate — build.mts says why it is a second gate rather than a wider `isFresh`.
  buildEngineIfStale()

  const launch = await launchOnFixture(FIXTURE, { env: { EQC_ENGINE: '1' } })
  // FIRST, before anything is driven: every line the app prints from here is this spec's evidence.
  const out = tapOutput(launch.app)
  let parity: ParitySay | null = null
  /** The ENGINE section's verbatim text — JOS-483's acceptance evidence, echoed at the end. */
  let panel: string | null = null
  try {
    await mainWindow(launch.app)
    parity = await settleParity(out)
    const ran = check(
      'the parity probe runs once BOTH worlds have landed, and says so in one line',
      parity !== null,
      parity === null ? engineNarration(out) : parity.line
    )
    if (ran && parity !== null) {
      stepEngineIsOnOurLog(launch, parity)
      stepEngineServesTheFileFact(launch, parity)
      if (stepProbeIsSound(parity)) stepVerdicts(parity)
    }
    // STEP 5 — THE ENGINE IN THE APP'S OWN PERFORMANCE PANEL (JOS-483, owner ruling 19). It rides
    // this spec rather than launching a sixth app because the only expensive thing it needs is an
    // engine that has folded something and been compared — which is the state this spec has just
    // spent a whole scan reaching, and which the panel's parity row then reports.
    panel = await stepEnginePerfPanel(await mainWindow(launch.app))
    await closeWindows(launch.app)
  } finally {
    await launch.close()
  }

  if (parity !== null) note(`the probe reported: ${parity.line}`)
  if (panel !== null) {
    note('…and the app’s own performance panel showed the engine — ruling 19 delivered in the product')
  }
  if (failures.length === 0) {
    note('LOG ONLY, by ruling: the probe writes one dev-log line and no product code reads a verdict')
    note('buffs AGREE closes JOS-479\'s wall-clock asymmetry: the engine ticks its own world now (ruling 22)')
    note('the surviving character divergence is the app still publishing its own copy of a fact the engine now SERVES (ruling 21) — it closes at the character-picker cutover')
    note('…and the PRODUCT no longer sees it: JOS-493 grafts the served mtime onto the shim’s character answer (engine-shim.e2e.mts claim 5); the RAW fold this probe compares must stay free of it')
  }
  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
