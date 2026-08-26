/**
 * THE COMPAT SHIM, PROVEN INSIDE THE RUNNING PRODUCT (JOS-489, phase 1 of the cutover).
 *
 * `engine-parity.e2e.mts` proves the two folds agree about five MODULES, through an instrument that
 * writes a log line and changes nothing. This spec's subject is the change: with
 * `EQC_ENGINE_SERVE=1` beside `EQC_ENGINE=1`, three of the app's own read IPCs are answered by the
 * ENGINE, and `window.eq` — the renderer's real door, unaltered by this ticket — gets whatever that
 * produces. So the question is no longer "do the two worlds agree", it is "does the product still
 * give the same answer now that the other world is giving it".
 *
 * WHAT IT CLAIMS, in the order it proves them:
 *
 *   1. THE ENGINE REALLY IS ANSWERING. Every arm the seam reports came back `served`, which is the
 *      shim saying it did not fall back. Load-bearing rather than tidy: the whole design of this
 *      feature is that a failure is INVISIBLE — the app answers exactly as it always did — so a
 *      spec that only compared values would pass just as brightly against an engine that never
 *      connected at all.
 *   2. THE TWO WORLDS AGREE, FIELD BY FIELD, at a matched mark: two module snapshots, the combat
 *      snapshot and a fight search, each deep-compared with `src/shared/deepDiff.ts` — the same one
 *      walk the in-app probe and the offline oracle use, because "are these the same?" must not
 *      have two implementations in one repo.
 *   3. THE PRODUCT PATH IS THE SERVED PATH. `window.eq.getCombatSnapshot` and
 *      `window.eq.getModuleSnapshot` are checked against the seam's ENGINE arm, not merely against
 *      "something plausible". That is what distinguishes "the engine can answer" from "the handler
 *      took the engine's arm", and only the second one is this ticket.
 *   4. FALLBACK HONESTY, STAGED. A module id the engine's registry does not carry is refused on the
 *      wire — and the renderer gets `null`, which is precisely what the flag-off world returns for
 *      an unknown id. No throw, no error dialog, no difference. The app says so in one coalesced
 *      dev-log sentence naming the reason.
 *   5. THE ONE FACT NO FOLD CAN CARRY IS STILL SERVED (JOS-493, owner ruling 21). The character
 *      snapshot's `lastPlayed` is the log file's mtime, which the ENGINE stats and serves on
 *      `session.health` and its FOLD deliberately never holds — so under the serve flag the product
 *      was being handed a character ref with the field gone. The shim grafts the served number on;
 *      this claim is that it arrives, that it is the engine's own answer about this file, and that
 *      it agrees with the app's own fold at the millisecond the protocol carries.
 *
 * ── WHY ONE LAUNCH AND A SEAM, RATHER THAN FLIPPING THE FLAG PER LAUNCH ────────────────────────
 *
 * The ticket offers both and this is the argument for this one. THE SHIM IS A PARITY INSTRUMENT,
 * and a parity claim is only worth making AT A MATCHED MARK (`parityProbe.ts`'s header: compare at
 * matched marks, or do not compare). Two launches would put the two answers in two processes,
 * minutes apart, each having staged and folded its own private copy of the fixture — so every
 * field that moves with the wall clock would differ for reasons that have nothing to do with
 * whether the folds agree, and the spec would have to weaken to floors and shapes until it proved
 * very little. Worse, it could not make claim 1 at all: a launch with the serve flag off has no
 * engine arm to report, so "the engine really is answering" would have no evidence in the run that
 * measured it.
 *
 * Asking ONE running app for both arms, back to back, is what the in-app probe already does and for
 * the same reason (`engineClientHost.ts askOne`): the engine's reply lands, and this process's own
 * read happens in that reply's microtask continuation, where the only thing that can have advanced
 * the app's fold is another microtask — never a tailer line, never a heartbeat tick, both of which
 * are macrotasks. The seam is `EQ_E2E`-only and serve-flag-only, is read by nothing in the product
 * and crosses no IPC: `overlayHover.ts`'s probe on exactly those terms, which is this repo's
 * existing answer to "a spec must observe a main-process seam without inventing a product surface".
 *
 * And the seam does NOT replace the product path — claim 3 is made through `window.eq`. What the
 * seam supplies is the SECOND arm, which the product deliberately stops exposing the moment the
 * flag is on.
 *
 * ── THE ASYMMETRIES, PINNED RATHER THAN EXCUSED — AND CURRENTLY NONE ───────────────────────────
 *
 * `KNOWN_ASYMMETRY` below is the same device `engine-parity.e2e.mts` uses and carries the same
 * contract: a row states WHERE the two worlds differ, dated, with the ticket that closes it. A
 * divergence anywhere else is red — and so is a PINNED path the two worlds have started agreeing
 * about, which is what makes deleting a row the way a fix is claimed rather than a chore somebody
 * has to remember. This ticket wrote three rows and then watched JOS-488 land and turn all three
 * red; the table is empty, by fix, and its comment keeps the measurement.
 *
 * WHY THE FIXTURE MAKES THIS DETERMINISTIC AT ALL. `logFixture.mts` stages a private copy of a
 * committed log and this spec never appends to it, so both worlds read the same finite bytes and
 * stop — the quiesced world the ticket asks for. On the owner's live log the combat snapshot's
 * `now` differs between the worlds by the round trip, and every elapsed time and `active` flag
 * derived from it would differ with it; here every fight in the fixture is dated Aug 2026 and both
 * worlds are hours past every close threshold, so the answer has stopped moving and stays stopped —
 * the fixture ages INTO the comparison rather than out of it, exactly as the parity spec's buffs
 * assertion does.
 *
 * Run: `npm run test:e2e -- engine-shim`
 */
import { statSync } from 'node:fs'
import { buildEngineIfStale, buildIfStale, check, failures, note, reportRun } from './appHarness.mjs'
import { closeWindows, mainWindow } from './appWindow.mjs'
import { launchOnFixture, type FixtureLaunch } from './logFixture.mjs'
import { settleParity, tapOutput } from './engineSteps.mjs'
import { firstDiff } from '../../src/shared/deepDiff'
import { normalizeState } from '../../src/main/dataServer/parityProbe'
import type { ElectronApplication, Page } from 'playwright-core'

/** The same fixture the parity spec folds — the richest committed one whose subject is the MODEL:
 *  buff landings and wear-offs, loot, kills and level-ups over 129 KB, with real fights in it, so
 *  the combat comparison below is about a meter with rows rather than two empty states. */
const FIXTURE = 'e2e-overlay.log'

/**
 * WHERE THE TWO WORLDS ARE KNOWN TO DIFFER, per surface, with the ticket that closes each. A row is
 * deleted the day its fix lands rather than being allowed to stand — `engine-parity.e2e.mts
 * KNOWN_ASYMMETRY`'s contract exactly, and the mechanism has teeth in both directions: a divergence
 * at an unpinned path is red, and so is a PINNED path the two worlds have started agreeing about.
 *
 * IT IS EMPTY, AND IT IS EMPTY BY FIX RATHER THAN BY OMISSION — which is worth writing down, because
 * an empty table and a table nobody wrote look identical.
 *
 * MEASURED ON THIS TICKET (2026-08-25), against the engine as it stood before JOS-488: the combat
 * snapshot diverged at exactly three paths — `.hydrating` (engine `true`, app `false`),
 * `.currentTarget` (engine still holding `Lord Nagafen`, app absent) and `.segments[0].kind` (engine
 * `"current"`, app `"fight"`). They were ONE gap rather than three: the snapshot-time sweep block
 * the cutover ledger names — charm sweep, ally expiry, pet nudge, deferred encounter closure —
 * unported to the Rust fold. In the app's own implementation `hydrating` is literally the flag that
 * gates that block (`if (!this.st.hydrating) { … evalClosure(…) }`, `src/main/combat/engine.ts
 * snapshot`), so an engine that could not honestly say `hydrating: false` was exactly an engine that
 * had not ported it, and the other two paths were what the block does — one world's newest encounter
 * finalized and the other's still open.
 *
 * JOS-488 PORTED THE BLOCK, and this spec then went red on all three rows demanding they be deleted,
 * which is the pin contract doing its whole job. They are deleted. **The engine's combat snapshot
 * now deep-equals this process's at every path**, and so do both module snapshots and the fight
 * search — which is the strongest form this spec's claim can take.
 *
 * NOTHING WAS EVER PATCHED IN THE SHIM to reach that state, and nothing should be: a shim that
 * rewrote a served field would manufacture agreement, which is the opposite of what an instrument is
 * for, and it would have hidden the very gap the ledger was tracking.
 */
const KNOWN_ASYMMETRY: Readonly<Record<string, readonly string[]>> = {}

/** A module id nothing registers, in either world — the staged refusal for claim 4. */
const NO_SUCH_MODULE = 'jos489-no-such-module'

/** The fixture's one named opponent (`You have slain a fire giant warrior!`), so the search has
 *  something to rank rather than comparing two empty answers. A query with no hits would still be a
 *  valid parity claim about `corpus`, and a much weaker one about the ranking. */
const SEARCH_QUERY = 'giant'

/** The two modules compared through the shim. `loot` is an appending list and `kills` a keyed
 *  tally: two shapes, both already proven AGREE by `engine-parity.e2e.mts`, so a divergence here is
 *  about the SHIM and not about the fold. */
const MODULES = ['loot', 'kills'] as const

// ── the seam ───────────────────────────────────────────────────────────────────────────────────

/** One question, as both worlds answered it. `src/main/dataServer/serveShim.ts BothArms`. */
interface BothArms<T> {
  engine: T | null
  why: string | null
  ts: T
}

type ModuleSnap = { seq: number; state: unknown } | null

/** The probe object main installs under `EQ_E2E` + the serve flag. */
interface ShimProbe {
  module: (moduleId: string) => Promise<BothArms<ModuleSnap>>
  combat: (opts: Record<string, unknown>) => Promise<BothArms<Record<string, unknown>>>
  search: (text: string, limit?: number) => Promise<BothArms<Record<string, unknown>>>
}

/** One question for the seam. A DATA description rather than a callback, because Playwright ships
 *  the evaluated function as source and a closure cannot cross into the main process — so the
 *  question has to be an argument, and a closed union is the readable way to be one. */
type SeamAsk =
  | { readonly kind: 'module'; readonly module: string }
  | { readonly kind: 'combat' }
  | { readonly kind: 'search'; readonly text: string; readonly limit: number }

/** Ask the seam one question, in the MAIN process. Throws a legible message when the seam is not
 *  installed, which is itself a finding: it means the serve flag never took. */
function askSeam<T>(app: ElectronApplication, ask: SeamAsk): Promise<BothArms<T>> {
  return app.evaluate(async (_electron, a: SeamAsk): Promise<unknown> => {
    const probe = (globalThis as unknown as { __eqcEngineShim?: ShimProbe }).__eqcEngineShim
    if (probe === undefined) {
      throw new Error('main installed no shim probe — is EQC_ENGINE_SERVE=1 with EQ_E2E=1?')
    }
    if (a.kind === 'module') return probe.module(a.module)
    if (a.kind === 'combat') return probe.combat({})
    return probe.search(a.text, a.limit)
  }, ask) as Promise<BothArms<T>>
}

// ── the comparison ─────────────────────────────────────────────────────────────────────────────

/**
 * Both sides into the vocabulary the wire speaks, with `updatedAt` gone from each.
 *
 * THE SAME NORMALIZATION THE IN-APP PROBE APPLIES, imported rather than restated: the engine's
 * answer arrived over a JSON wire and the app's is a live object graph, and the message-overlay
 * miner stamps `updatedAt` with the clock at the instant a SNAPSHOT is taken — so it says when
 * somebody read the module, not what the module folded, and two honest folds disagree about it.
 */
function comparable(value: unknown): unknown {
  return normalizeState(value)
}

/** A ceiling on the erase-and-walk-again loop, so a comparison can never spin. It is far above the
 *  number of fields any of these surfaces has; reaching it is itself a finding. */
const MAX_DIVERGENCES = 40

/**
 * Deep-compare one surface's two arms, allowing exactly the paths pinned for it.
 *
 * IT KEEPS WALKING PAST A DIVERGENCE INSTEAD OF STOPPING AT THE FIRST. `firstDiff` reports ONE
 * disagreement and stops, which is the right shape for a diagnosis and the wrong shape for a
 * pinning spec: a pinned path standing in front of a real one would hide it, and — the reason this
 * loop is worth its lines — a regression that moved four fields would be reported as one, so the
 * run after the "fix" would find the second. Every path found is ERASED FROM BOTH SIDES and the
 * walk restarts, and the verdict at the end names the whole set.
 */
function compareArms(surface: string, engine: unknown, ts: unknown): void {
  const allowed = KNOWN_ASYMMETRY[surface] ?? []
  let a = comparable(engine)
  let b = comparable(ts)
  const excused: string[] = []
  const unexpected: string[] = []
  for (let i = 0; i < MAX_DIVERGENCES; i++) {
    const diff = firstDiff(a, b, '')
    if (diff === null) break
    const next = erasePath(a, b, diff.path)
    if (next === null) {
      // A shape `erasePath` cannot walk past. Reporting and stopping is what turns a hang into a
      // finding — and it names the path, so growing the helper is a small job when it happens.
      unexpected.push(`${diff.path} (which this spec cannot walk past)`)
      break
    }
    if (allowed.includes(diff.path)) excused.push(diff.path)
    else unexpected.push(`${diff.path} — engine ${short(diff.expected)} vs app ${short(diff.actual)}`)
    a = next[0]
    b = next[1]
  }
  check(
    `…${surface}: the ENGINE's answer deep-equals the app's own fold` +
      (allowed.length > 0 ? `, but for the pinned ${allowed.join(', ')}` : ''),
    unexpected.length === 0,
    unexpected.length === 0
      ? excused.length > 0
        ? `excused ${excused.join(', ')}`
        : 'deep-equal, nothing excused'
      : `${String(unexpected.length)} UNPINNED: ${unexpected.join(' · ')}`
  )
  for (const path of allowed) {
    check(
      `…${surface}: the pinned asymmetry at ${path} is STILL there — if it is fixed, delete the row`,
      excused.includes(path),
      excused.includes(path) ? 'still divergent' : 'the two worlds agree about it now'
    )
  }
}

/**
 * Take one dotted path out of BOTH sides, or answer null when the shape is one this cannot walk.
 *
 * TWO LEAF SHAPES, because `deepDiff.ts` emits exactly two kinds. An OBJECT KEY is omitted from
 * both sides, which is the honest spelling of "do not compare this field" — and an absent key is a
 * successful erase rather than a failure, since a field one world grew and the other never had is
 * the commonest excused shape there is. An ARRAY INDEX is replaced on both sides by one shared
 * sentinel rather than spliced out, because splicing would shorten the array and turn every later
 * index into a fresh disagreement.
 *
 * `.length` — the third thing `firstDiff` can report — reaches the object arm against an array and
 * is refused. That is deliberate: two arrays of different lengths is not a field to excuse.
 */
function erasePath(a: unknown, b: unknown, path: string): [unknown, unknown] | null {
  const steps = parsePath(path)
  if (steps === null) return null
  const left = without(a, steps)
  const right = without(b, steps)
  if (left === null || right === null) return null
  return [left.value, right.value]
}

/** `.a.b[2].c` → `['a', 'b', 2, 'c']`, or null for anything this file has not taught itself. */
function parsePath(path: string): (string | number)[] | null {
  const steps: (string | number)[] = []
  const re = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]/g
  let consumed = 0
  for (let m = re.exec(path); m !== null; m = re.exec(path)) {
    if (m.index !== consumed) return null
    consumed = m.index + m[0].length
    steps.push(m[1] === undefined ? Number(m[2]) : m[1])
  }
  return consumed === path.length && steps.length > 0 ? steps : null
}

/** What an excused array element becomes on both sides — a string neither world can produce. */
const EXCUSED = '<excused by engine-shim.e2e.mts>'

/** Rebuild `value` with the leaf at `steps` excused. Null when the path does not describe it. */
function without(value: unknown, steps: readonly (string | number)[]): { value: unknown } | null {
  const [head, ...rest] = steps
  if (typeof head === 'number') {
    if (!Array.isArray(value) || head >= value.length) return null
    const copy: unknown[] = value.slice()
    if (rest.length === 0) copy[head] = EXCUSED
    else {
      const deeper = without(copy[head], rest)
      if (deeper === null) return null
      copy[head] = deeper.value
    }
    return { value: copy }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const src = value as Record<string, unknown>
  if (rest.length === 0) {
    return { value: Object.fromEntries(Object.entries(src).filter(([k]) => k !== head)) }
  }
  if (!(head in src)) return null
  const deeper = without(src[head], rest)
  if (deeper === null) return null
  return { value: { ...src, [head]: deeper.value } }
}

/** One side's value at a divergence, bounded — `parityProbe.ts shortValue`'s rule, restated here
 *  because an e2e file may not import a module for one line of formatting. */
function short(value: unknown): string {
  let text: string
  try {
    text = value === undefined ? '(absent)' : (JSON.stringify(value) ?? '(unserializable)')
  } catch {
    text = '(unserializable)'
  }
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
}

/** `n hits of m fights searched`, off whichever arm is being reported. Context for a reader of the
 *  run, so `deep-equal` is not indistinguishable from `both answered nothing`. */
function describeHits(answer: unknown): string {
  if (answer === null || typeof answer !== 'object') return 'no answer to describe'
  const hits = (answer as { hits?: unknown }).hits
  const corpus = (answer as { corpus?: unknown }).corpus
  const n = Array.isArray(hits) ? hits.length : -1
  return `${String(n)} hits of ${String(corpus)} fights searched`
}

/** CLAIM 1 for one surface: the engine answered, so what follows compares two worlds rather than
 *  one world with itself. */
function served<T>(surface: string, arms: BothArms<T>): boolean {
  return check(
    `${surface}: the ENGINE served this read — the shim did not quietly fall back`,
    arms.engine !== null,
    arms.why ?? 'served'
  )
}

// ── the steps ──────────────────────────────────────────────────────────────────────────────────

async function stepModules(app: ElectronApplication): Promise<void> {
  for (const module of MODULES) {
    const arms = await askSeam<ModuleSnap>(app, { kind: 'module', module })
    if (!served(module, arms)) continue
    const engine = arms.engine
    const ts = arms.ts
    if (engine === null || ts === null) {
      check(`…${module}: both worlds hold it`, false, `engine ${String(engine)} · app ${String(ts)}`)
      continue
    }
    // THE ANTI-RACE CHECK, and it is the reason this spec can assert equality at all: a module's
    // `seq` is its own published mark, and two states at different marks describe different
    // prefixes of the same file. Comparing those would report a race as a defect.
    if (
      !check(
        `…${module}: both worlds answered AT THE SAME MARK (seq ${String(engine.seq)})`,
        engine.seq === ts.seq,
        `engine seq ${String(engine.seq)} · app seq ${String(ts.seq)}`
      )
    ) {
      continue
    }
    compareArms(module, engine.state, ts.state)
  }
}

async function stepCombat(app: ElectronApplication): Promise<void> {
  const arms = await askSeam<Record<string, unknown>>(app, { kind: 'combat' })
  if (!served('combat snapshot', arms)) return
  compareArms('combat', arms.engine, arms.ts)
}

async function stepSearch(app: ElectronApplication): Promise<void> {
  // A real query and a limit, so the ranking, the corpus count and the clamp all travel. Both
  // worlds are asked for the same number of hits — `world.ts` clamps in front of the arm choice
  // precisely so two clamps cannot be applied to two different inputs.
  const arms = await askSeam<Record<string, unknown>>(app, {
    kind: 'search',
    text: SEARCH_QUERY,
    limit: 10
  })
  if (!served('fight search', arms)) return
  note(`the fight search asked both worlds for “${SEARCH_QUERY}” — ${describeHits(arms.engine)}`)
  compareArms('search', arms.engine, arms.ts)
}

/**
 * CLAIM 3 — THE PRODUCT PATH IS THE SERVED PATH.
 *
 * `window.eq` is the renderer's real door and this ticket did not touch it. Checking its answer
 * against the seam's ENGINE arm is what turns "the engine can answer" into "the handler took the
 * engine's arm" — the difference between a working data server and a working shim.
 *
 * It runs through the same `compareArms`, so any pin would apply here too — and for a subtler reason
 * than symmetry: the seam's arm and this call are two round trips a few milliseconds apart, so
 * anything a pin covers could legitimately have moved between them. With the table empty the two
 * must agree exactly, which they do.
 */
async function stepProductPath(page: Page, app: ElectronApplication): Promise<void> {
  const combatArms = await askSeam<Record<string, unknown>>(app, { kind: 'combat' })
  const overIpc = (await page.evaluate(
    () =>
      (window as unknown as { eq: { getCombatSnapshot: (o: unknown) => Promise<unknown> } }).eq
        .getCombatSnapshot({})
  )) as Record<string, unknown>
  if (served('combat snapshot (again, for the product path)', combatArms)) {
    compareArms('combat over window.eq', combatArms.engine, overIpc)
  }

  const moduleArms = await askSeam<ModuleSnap>(app, { kind: 'module', module: 'loot' })
  const moduleOverIpc = (await page.evaluate(
    () =>
      (window as unknown as { eq: { getModuleSnapshot: (id: string) => Promise<unknown> } }).eq
        .getModuleSnapshot('loot')
  )) as { seq: number; state: unknown } | null
  const fromEngine = moduleArms.engine
  if (fromEngine === null || moduleOverIpc === null) {
    check(
      'loot over window.eq: the renderer got a snapshot and the seam got a served one',
      false,
      `seam ${String(fromEngine)} · window.eq ${String(moduleOverIpc)}`
    )
    return
  }
  check(
    'loot over window.eq: the renderer’s snapshot is AT THE SAME MARK as the served one',
    fromEngine.seq === moduleOverIpc.seq,
    `seam seq ${String(fromEngine.seq)} · window.eq seq ${String(moduleOverIpc.seq)}`
  )
  compareArms('loot over window.eq', fromEngine.state, moduleOverIpc.state)
}

/**
 * CLAIM 5 — THE `lastPlayed` GRAFT (JOS-493, owner ruling 21's served fact).
 *
 * WHAT WAS LEAKING, and why it is the shim's problem rather than the fold's. The app's own
 * `character` module publishes a `CharacterRef` carrying `lastPlayed = statSync(logPath).mtimeMs` —
 * a FILESYSTEM fact pushed in by `session.ts`, never folded from a line. The ENGINE's character
 * module cannot carry it and must not: ruling 18 says a served process fact is not addressed by
 * (log identity, byte offset) and has no business inside fold state. So with the serve flag on, the
 * character snapshot reaching the product had the field simply GONE — and the character picker's
 * whole sort key is that field (`TitleBar.tsx`). JOS-490 found it in the product path and JOS-479
 * had already pinned the same divergence in the probe.
 *
 * RULING 21 SAYS WHERE THE FACT LIVES: the engine SERVES it, on `session.health` as `logMtimeMs`,
 * because the engine is the process that owns the file. The shim now grafts that served number onto
 * the served snapshot (`serveShim.ts graftLastPlayed`), which closes the leak in the product and
 * closes the JOS-479/481 exemption UNDER SERVE. `engine-parity.e2e.mts` KEEPS its row, and that is
 * not an inconsistency: that spec's probe compares the RAW engine module snapshot against the TS
 * fold, with no shim between them, so it is still measuring the thing ruling 18 requires to stay
 * absent. This spec measures what the PRODUCT is handed.
 *
 * THE PRECISION IS PINNED RATHER THAN FUDGED. The protocol carries an integer millisecond and Node
 * reports the NTFS stamp as a float with sub-millisecond digits, so the served value is `Math.floor`
 * of the app's own — the identical truncation `engine-parity.e2e.mts` already asserts against the
 * disk. Asserting equality at that precision is the honest claim; asserting bit equality would be a
 * claim about a stamp neither side promises.
 */
async function stepLastPlayed(
  launch: FixtureLaunch,
  page: Page,
  app: ElectronApplication
): Promise<void> {
  const arms = await askSeam<ModuleSnap>(app, { kind: 'module', module: 'character' })
  if (!served('character', arms)) return
  const fromEngine = lastPlayedOf(arms.engine)
  const fromApp = lastPlayedOf(arms.ts)
  const onDisk = Math.floor(statSync(launch.log.logPath).mtimeMs)
  if (
    !check(
      '…character: the SERVED snapshot carries a lastPlayed at all — the JOS-490 leak is closed',
      fromEngine !== undefined,
      fromEngine === undefined ? 'the served ref has no lastPlayed' : String(fromEngine)
    )
  ) {
    return
  }
  check(
    '…character: and it is the ENGINE’S OWN answer about this file — the mtime it serves on session.health',
    fromEngine === onDisk,
    `served ${String(fromEngine)} · disk ${String(onDisk)}`
  )
  check(
    '…character: which is the same fact the app’s own fold publishes, at the protocol’s millisecond',
    fromApp !== undefined && Math.floor(fromApp) === fromEngine,
    `served ${String(fromEngine)} · app ${String(fromApp)}`
  )
  // AND THROUGH THE PRODUCT'S OWN DOOR, for claim 3's reason: the graft is only worth anything if
  // the renderer gets it, and `window.eq` is what the picker actually calls.
  const overIpc = (await page.evaluate(
    () =>
      (window as unknown as { eq: { getModuleSnapshot: (id: string) => Promise<unknown> } }).eq
        .getModuleSnapshot('character')
  )) as { seq: number; state: unknown } | null
  check(
    'character over window.eq: the renderer sees the grafted lastPlayed, not an absent field',
    lastPlayedOf(overIpc) === fromEngine,
    `window.eq ${String(lastPlayedOf(overIpc))} · seam ${String(fromEngine)}`
  )
}

/** `.character.lastPlayed` out of one arm's module snapshot, or undefined when it is not there. */
function lastPlayedOf(snap: ModuleSnap): number | undefined {
  if (snap === null) return undefined
  const state = snap.state
  if (state === null || typeof state !== 'object') return undefined
  const ref = (state as { character?: unknown }).character
  if (ref === null || typeof ref !== 'object') return undefined
  const value = (ref as { lastPlayed?: unknown }).lastPlayed
  return typeof value === 'number' ? value : undefined
}

/**
 * CLAIM 4 — FALLBACK HONESTY, STAGED.
 *
 * An id neither registry carries: the engine refuses it on the wire (`notFound`, `ops.rs`) and the
 * app's own `registry.snapshot` answers `null`. So the shim must fall back, and the renderer must
 * see `null` — the flag-off answer, unchanged — rather than a rejected `invoke`, which is what a
 * shim that propagated the refusal would produce and which no caller of this channel has ever had
 * to handle.
 */
async function stepFallback(page: Page, app: ElectronApplication): Promise<void> {
  const arms = await askSeam<ModuleSnap>(app, { kind: 'module', module: NO_SUCH_MODULE })
  check(
    'a module NEITHER world carries: the engine refuses it rather than inventing one',
    arms.engine === null && arms.why !== null,
    arms.why ?? 'the engine served something for an id nothing registers'
  )
  const overIpc = await page.evaluate(
    async (id: string) => {
      try {
        const eq = (window as unknown as { eq: { getModuleSnapshot: (i: string) => Promise<unknown> } }).eq
        return { ok: true, value: await eq.getModuleSnapshot(id) }
      } catch (err) {
        return { ok: false, value: String(err) }
      }
    },
    NO_SUCH_MODULE
  )
  check(
    '…and the renderer gets `null` — exactly what the flag-off world returns, and never a throw',
    overIpc.ok && overIpc.value === null,
    overIpc.ok ? `value ${String(overIpc.value)}` : `it threw: ${String(overIpc.value)}`
  )
}

// ── the run ────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  buildIfStale()
  buildEngineIfStale()

  const launch = await launchOnFixture(FIXTURE, {
    env: { EQC_ENGINE: '1', EQC_ENGINE_SERVE: '1' }
  })
  const out = tapOutput(launch.app)
  let shimNote: string | null = null
  try {
    const page = await mainWindow(launch.app)
    // THE READINESS WAIT, AND IT IS THE PRODUCT'S OWN. The shim serves only once the engine is
    // connected, attached to the log THIS PROCESS folded, and live on it — which is precisely the
    // state the parity probe waits for and then narrates. So this spec waits for that sentence
    // rather than inventing a second readiness signal, and the line it waits for is also the
    // evidence that both worlds landed on the same file.
    //
    // NOT `settleHydrated`, deliberately: `hydrating` is the pinned asymmetry below, so with the
    // flag on the app's usual hydration wait would never finish. That is the exemption being real
    // rather than theoretical.
    const parity = await settleParity(out)
    const ready = check(
      'both worlds landed on the same log and the engine went live — the shim’s readiness, stated by the probe',
      parity !== null,
      parity?.line ?? 'the app never reported a parity run'
    )
    if (ready) {
      await stepModules(launch.app)
      await stepCombat(launch.app)
      await stepSearch(launch.app)
      await stepProductPath(page, launch.app)
      await stepLastPlayed(launch, page, launch.app)
      await stepFallback(page, launch.app)
    }
    // The coalesced note the staged refusal above must have produced. Read after it, because the
    // pipe is not a synchronous read.
    shimNote = findShimNote(out.text())
    check(
      'the fallback is NARRATED: one coalesced sentence naming the reason, not a line per call',
      shimNote !== null,
      shimNote ?? 'the app fell back and said nothing about it'
    )
    await closeWindows(launch.app)
  } finally {
    await launch.close()
  }

  if (shimNote !== null) note(`the shim reported: ${shimNote}`)
  if (failures.length === 0) {
    note('the engine answers module:getSnapshot, combat:snapshot and combat:searchFights, and window.eq cannot tell')
    note(
      'and it agrees at EVERY path: JOS-489 measured three divergences (`.hydrating`, ' +
        '`.currentTarget`, `.segments[0].kind` — one gap, the unported snapshot-time sweep block), ' +
        'JOS-488 ported it, and KNOWN_ASYMMETRY is empty by fix'
    )
    note(
      '…and the character ref reaches the product WHOLE: `lastPlayed` is grafted from the mtime the ' +
        'engine serves (ruling 21), so the JOS-479/481 exemption is closed UNDER SERVE while ' +
        'engine-parity keeps its row for the raw fold, which must never hold a filesystem fact'
    )
  }
  reportRun()
}

/** The shim's own sentence out of the app's narration — `readShim.ts flush`'s wording. */
function findShimNote(text: string): string | null {
  const found = /data-server shim: [^\n]*/.exec(text)
  return found ? found[0].trimEnd() : null
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
