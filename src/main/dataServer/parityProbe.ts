// ============================================================================
// parityProbe.ts — DO THE TWO WORLDS AGREE? Asked inside the running app (JOS-479, phase 3).
// ============================================================================
//
// `npm run oracle:rust-fold` proves the Rust fold equivalent to the TypeScript one over six slices
// of the owner's real log, offline, at a bench. This is the same question asked of the SHIPPING
// pipeline: the engine the supervisor spawned, folding the log the app is tailing, against the
// module registry in this very process. Two folds, one file, one comparison — and the answer goes
// to the dev log and nowhere else. NOTHING HERE CHANGES BEHAVIOUR. No UI, no IPC, no store write,
// no branch anywhere in the product reads a verdict. It is an instrument.
//
// THIS FILE IS THE PURE HALF, and that is the same split `supervisor.ts`/`engineHost.ts` keeps:
// engineClientHost.ts owns the socket, the clock and the log line; everything below is a function
// of two snapshots. So the awkward cases — a module the engine refuses, a module the app does not
// hold, two worlds at different marks — are `node:test` units with no app and no Rust binary.
//
// ── THE HONESTY PROBLEM, AND THE ONE RULE THAT ANSWERS IT ──────────────────────────────────────
//
// The two worlds fold the SAME BYTES at different speeds, and the file may be growing while they do
// (the owner plays). So a raw deep-equal between "the engine's loot" and "the app's loot" is not a
// claim about equivalence at all: it is a claim about whether the two happened to be at the same
// point in the log at the instant somebody asked. Nine times out of ten a mismatch would mean one
// side had folded a line the other had not yet reached, which is a race being reported as a defect.
//
// The rule is therefore: COMPARE AT MATCHED MARKS, OR DO NOT COMPARE. Every module publishes a
// `seq` — for most of them the seq of the last event they folded, and for the four that carry a
// private revision counter (combo, character, respawn, buffTimers — JOS-87) that counter. Both
// worlds fold the same event stream from byte zero and number it the same way (the phase-1 oracle
// is what makes that true), so equal `seq` means the two states describe the same prefix of the
// same file. Unequal `seq` is DRIFT and is reported as SKIPPED, by name, with both numbers. It is
// never quietly tolerated and never counted as agreement — a probe that reported "0 divergences"
// because it silently compared nothing would be worse than no probe at all.
//
// ── `updatedAt` IS THE ONE FIELD DROPPED, AND IT IS DROPPED FROM BOTH SIDES ────────────────────
//
// The message-overlay miner stamps `overlay.updatedAt` with the wall clock at the instant a
// SNAPSHOT is taken (`data/messageOverlay.ts`), so it says when somebody read the module and not
// what the module folded — two unchunked folds of the same bytes disagree about it too. The golden
// oracle strips exactly this field and nothing else (`goldenOracle.mts normalizeJson`,
// `tests/replayChunking.test.mts`), so this does the same, on both worlds, so that a stamp on
// either side cannot become a divergence.
//
// ── THE LINE ALSO QUOTES A FACT NOBODY COMPARES (JOS-481, owner ruling 21) ────────────────────
//
// `logMtimeMs` is the engine's answer about the FILE, not about the fold, so it is not a verdict and
// has no side to disagree with. It is on the line because the ruling moved the READING of that fact
// from the app to the server — the app has always taken it itself, `statSync(logPath).mtimeMs` in
// `main/log/config.ts` — and a served fact nobody can see is a fact nobody can check. The e2e checks
// it against the file on disk. No product code reads it yet: the character picker is the surface
// that will, at its cutover, and until then this is an instrument like everything else here.
//
// ── AND THE APP'S STATE IS ROUND-TRIPPED THROUGH JSON BEFORE IT IS COMPARED ────────────────────
//
// The engine's answer arrived over a JSON wire; the app's is a live object graph that may hold
// `undefined` values, `Date`s and class instances. Comparing those directly would report the
// SERIALIZER's opinions as fold divergences (a key whose value is `undefined` exists in the object
// and vanishes on the wire). One `JSON.parse(JSON.stringify(…))` puts both sides in the same
// vocabulary, which is the vocabulary the protocol actually speaks.

import { firstDiff } from '../../shared/deepDiff'

/**
 * THE PROBE SET — five modules, chosen to span the shapes rather than to be exhaustive.
 *
 * `loot` and `kills` are appenders (a growing list, a keyed tally); `leveling` is the four-array
 * object the engine's own README shows on the wire; `character` is one of the four modules that
 * publish a private REVISION counter instead of an event seq, so it is the one that proves the
 * matched-mark rule is reading the module's own contract and not the fold's event count; and
 * `buffs` is the hardest module in the registry — cluster 2c, a shared core with buffTimers, the
 * message-overlay miner, and the only one of the five with a wall-clock `onTick`.
 *
 * ALL TWENTY IS NOT THE GOAL HERE. `oracle:rust-fold` compares all twenty over 1.28M events of the
 * owner's real log; this probe's subject is the CONNECTION — that a client inside the app can ask
 * the engine for state and get back something that agrees with what this process folded — and five
 * modules asked on every attach state that as well as twenty would, for a fifth of the wire.
 */
export const PARITY_PROBE_MODULES: readonly string[] = ['loot', 'kills', 'leveling', 'character', 'buffs']

/** What `module.snapshot` answered. `ModuleSnapshotResult`, narrowed to what a comparison needs. */
export interface EngineModuleSnapshot {
  readonly seq: number
  readonly state: unknown
}

/** What `registry.snapshot(id)` answered. */
export interface AppModuleSnapshot {
  readonly seq: number
  readonly state: unknown
}

/** One module, as both worlds answered for it. `engine`/`app` are null when that side had nothing
 *  to say, and `refusal` carries why — an engine `notFound`, a closed connection, a module id this
 *  build's registry does not carry. */
export interface ParityAsk {
  readonly module: string
  readonly engine: EngineModuleSnapshot | null
  readonly app: AppModuleSnapshot | null
  readonly refusal?: string
}

/** What the probe decided about one module. */
export type ParityVerdict =
  | { readonly module: string; readonly kind: 'agree'; readonly seq: number }
  | {
      readonly module: string
      readonly kind: 'diverge'
      readonly seq: number
      readonly path: string
      readonly engine: string
      readonly app: string
    }
  | {
      readonly module: string
      readonly kind: 'skipped'
      readonly why: 'drift'
      readonly engineSeq: number
      readonly appSeq: number
    }
  | { readonly module: string; readonly kind: 'skipped'; readonly why: 'unanswered'; readonly detail: string }

/** THE ENGINE'S OWN COORDINATE — `HealthResult.mark`, (log identity, byte offset) and nothing else
 *  (ruling 18 law 3). Absent before the engine has folded anything. */
export interface EngineMark {
  readonly log: string
  readonly offset: number
}

/** Everything one probe run says, before it is turned into a line. */
export interface ParityRun {
  /** The log THIS PROCESS folded — the app's active log path, which is also what was handed to the
   *  engine at attach. */
  readonly logPath: string
  /**
   * THE ENGINE'S ANSWER TO THE SAME QUESTION, quoted rather than assumed.
   *
   * The comparison is only meaningful if both worlds folded the SAME FILE, and the app cannot
   * establish that by remembering what it asked for — it establishes it by reading back what the
   * engine says it is reading. That is why the line prints the engine's `mark` and not the app's
   * request: an echo is evidence, a variable is a belief. It also carries the byte offset, which is
   * the coordinate the whole design addresses state by.
   */
  readonly mark: EngineMark | null
  /**
   * THE LOG FILE'S LAST-MODIFIED TIME, AS THE ENGINE SERVED IT (`HealthResult.logMtimeMs`, owner
   * ruling 21 — the server owns log-file facts). Null before the engine has a file to stat, or when
   * the stat failed.
   *
   * IT IS QUOTED FOR THE SAME REASON THE MARK IS: the app has always taken this fact itself
   * (`statSync(logPath).mtimeMs` in `main/log/config.ts`, pushed into the character module), and
   * the ruling moves the reading to the process that owns the file. Printing what the ENGINE
   * answered — rather than what this process believes — is how the e2e can check the served number
   * against the file on disk. Nothing in the product reads it yet; the character-picker surface is
   * the cutover that will.
   */
  readonly logMtimeMs: number | null
  /** The engine's generation, and what its ingest said it was doing when the probe ran. A probe
   *  taken at `folding` rather than `live` is not wrong, it is just early — and then every module
   *  drifts, which the line will show. */
  readonly epoch: number | null
  readonly engineStatus: string
  /** Events the ENGINE has folded in this generation (`HealthResult.events`), or null before it
   *  has folded anything. */
  readonly engineEvents: number | null
  readonly verdicts: readonly ParityVerdict[]
}

/** How much of a divergent value is printed. A module's state is as long as the module says it is;
 *  this is a log line a person reads, and the PATH is the diagnosis anyway. */
const VALUE_CHARS = 80

/** One side's value at the divergence, bounded and control-free. */
export function shortValue(value: unknown): string {
  let text: string
  try {
    text = value === undefined ? '(absent)' : JSON.stringify(value) ?? '(unserializable)'
  } catch {
    text = '(unserializable)'
  }
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > VALUE_CHARS ? `${flat.slice(0, VALUE_CHARS)}…` : flat
}

/**
 * Both sides into the vocabulary the wire speaks, with `updatedAt` gone from each — see the header.
 * `undefined` in, `undefined` out: a state that does not survive `JSON.stringify` is not something
 * the engine could ever have sent, and inventing a value for it would be the comparison lying.
 */
export function normalizeState(state: unknown): unknown {
  const json = JSON.stringify(state, (key, value: unknown) => (key === 'updatedAt' ? undefined : value))
  if (json === undefined) return undefined
  return JSON.parse(json) as unknown
}

/**
 * One module's verdict. THE ORDER OF THE TESTS IS THE ARGUMENT: an unanswered side is not a
 * disagreement, and a mark mismatch is not one either — only two states at the same mark can
 * disagree about anything.
 */
export function verdictFor(ask: ParityAsk): ParityVerdict {
  const { module, engine, app } = ask
  if (engine === null || app === null) {
    return { module, kind: 'skipped', why: 'unanswered', detail: unansweredDetail(ask) }
  }
  if (engine.seq !== app.seq) {
    return { module, kind: 'skipped', why: 'drift', engineSeq: engine.seq, appSeq: app.seq }
  }
  const diff = firstDiff(normalizeState(engine.state), normalizeState(app.state), '')
  if (diff === null) return { module, kind: 'agree', seq: engine.seq }
  return {
    module,
    kind: 'diverge',
    seq: engine.seq,
    path: diff.path === '' ? '(the whole state)' : diff.path,
    // `expected` is the ENGINE's, because the engine is the side being proven — the app's fold is
    // the oracle here exactly as it is at the bench.
    engine: shortValue(diff.expected),
    app: shortValue(diff.actual)
  }
}

/** Why nobody could be compared. The refusal the caller collected wins; otherwise say which side
 *  was silent, because "the engine does not fold it" and "this build does not register it" are
 *  different bugs. */
function unansweredDetail(ask: ParityAsk): string {
  if (ask.refusal !== undefined && ask.refusal !== '') return ask.refusal
  if (ask.engine === null && ask.app === null) return 'neither world holds this module'
  return ask.engine === null ? 'the engine did not answer' : 'this app holds no such module'
}

/** Every ask, judged. */
export function judgeParity(asks: readonly ParityAsk[]): ParityVerdict[] {
  return asks.map(verdictFor)
}

/** How many of each. Exported because the e2e reads the counts out of the line and a test should
 *  be able to state them without re-parsing prose. */
export interface ParityTally {
  readonly agree: number
  readonly diverge: number
  readonly skipped: number
}

export function tallyParity(verdicts: readonly ParityVerdict[]): ParityTally {
  return {
    agree: verdicts.filter((v) => v.kind === 'agree').length,
    diverge: verdicts.filter((v) => v.kind === 'diverge').length,
    skipped: verdicts.filter((v) => v.kind === 'skipped').length
  }
}

/** One module's verdict, as it appears in the line. */
function phrase(v: ParityVerdict): string {
  if (v.kind === 'agree') return `${v.module} AGREE(seq ${String(v.seq)})`
  if (v.kind === 'diverge') {
    return `${v.module} DIVERGE(seq ${String(v.seq)}) at ${v.path}: engine ${v.engine} vs app ${v.app}`
  }
  if (v.why === 'drift') {
    return `${v.module} SKIP(drift: engine seq ${String(v.engineSeq)} vs app seq ${String(v.appSeq)})`
  }
  return `${v.module} SKIP(${v.detail})`
}

/**
 * THE PREFIX THE LINE IS FOUND BY. It is a constant rather than a spelling inside the template
 * because the e2e greps for it and a log line nobody can find is a measurement nobody took.
 */
export const PARITY_LINE_PREFIX = 'data-server parity:'

/**
 * ONE LINE PER PROBE RUN — the whole output of this feature.
 *
 * It states the counts first (so a reader knows the verdict before reading five clauses), then the
 * coordinate BOTH worlds were asked about, then every module by name. Nothing is elided: a probe
 * that printed only the failures would make "all five agreed" and "the probe never ran" the same
 * observation, which is the mistake `engineHost.ts` already refuses to make about a missing binary.
 */
export function parityLine(run: ParityRun): string {
  const t = tallyParity(run.verdicts)
  const events = run.engineEvents === null ? 'nothing folded' : `${String(run.engineEvents)} events`
  const epoch = run.epoch === null ? 'no epoch' : `epoch ${String(run.epoch)}`
  // THE FILE FACT, STATED EVEN WHEN IT IS ABSENT (ruling 21). `no mtime` rather than an omitted
  // clause, for the same reason the whole line elides nothing: a missing clause would make "the
  // engine could not stat it" and "this build does not serve it" the same observation.
  const mtime = run.logMtimeMs === null ? 'no mtime' : `mtime ${String(run.logMtimeMs)}`
  const head =
    `${PARITY_LINE_PREFIX} ${String(t.agree)} agree, ${String(t.diverge)} diverge, ` +
    `${String(t.skipped)} skipped of ${String(run.verdicts.length)}`
  // THE MARK CLAUSE STAYS LAST, and that is a parsing contract rather than taste: the log path is
  // the one field that can contain anything (commas, spaces, `of`), so it is the sentence's ending
  // and every clause that could follow it goes in front of it instead.
  const where = `[${epoch}, engine ${run.engineStatus}, ${events}, ${mtime}, ${whereBoth(run)}]`
  return `${head} ${where} — ${run.verdicts.map(phrase).join(' · ')}`
}

/**
 * The coordinate clause: the ENGINE's mark when the two worlds are on the same file, and a shout
 * when they are not.
 *
 * TWO FOLDS OF DIFFERENT FILES IS THE ONE FAILURE THAT WOULD MAKE EVERY OTHER NUMBER IN THIS LINE A
 * LIE — agreement would be luck and divergence would be a defect report about nothing — so it gets
 * the loudest phrasing in the sentence rather than a quiet field somebody has to compare by eye.
 */
function whereBoth(run: ParityRun): string {
  if (run.mark === null) return `no engine mark yet, app ${run.logPath}`
  if (run.mark.log !== run.logPath) {
    return `LOG MISMATCH: app ${run.logPath} but engine ${run.mark.log} @${String(run.mark.offset)}`
  }
  return `mark ${String(run.mark.offset)} of ${run.mark.log}`
}
