// ============================================================================
// feedbackPerfEngine.ts — THE ENGINE'S OWN NUMBERS, ON A BUG REPORT (ruling 19, JOS-502).
// ============================================================================
//
// Owner ruling 19, verbatim: *"the performance chip should incl perf of the server in end state."*
// The in-app panel has carried the engine row since JOS-483; this is the other half of the
// sentence — a bug report carries the engine's rates, latencies and budget verdicts exactly as it
// has carried main/renderer stalls since JOS-369.
//
// ── WHY IT IS ITS OWN FILE ──────────────────────────────────────────────────────────────────────
//
// The same reason `feedbackPerfSeams.ts` is: `feedbackPerf.ts` is near its 400-line ceiling, and
// `foldFeedbackPerf` and `validatePerf` each already sit at the repo's complexity ceiling of 12, so
// a fold and a validator apiece would take both over it. Like that file, this one restates the two
// numeric ceilings BY VALUE rather than importing them — `feedbackPerf.ts` imports this file, and an
// import back would be a cycle inside the ingest Lambda's bundle. `tests/feedbackPerfEngine.test.mts`
// pins them equal.
//
// ── THE TELEMETRY BRIGHT LINE, HELD BY SHAPE RATHER THAN BY A SCRUB ─────────────────────────────
//
// Standing law: diagnosability over anonymity, but gameplay data never leaves a client, and free
// text is refused BY SHAPE rather than sanitized. Read the interface below and note what it cannot
// express: EVERY FIELD IS A WHOLE NUMBER OR A MEMBER OF A CLOSED ENUM. There is no string on it at
// all. That is not an accident of what was convenient —
//
//   * the engine's `perf.snapshot` carries `mark.log`, which is an ABSOLUTE PATH to the user's game
//     log, and the envelope's first law is that no filesystem path rides. It is dropped at the
//     fold, and the shape here has nowhere to put it back;
//   * it also carries `lastEventTs`, which is the LOG's own clock and therefore says when a person
//     was playing. What survives is `behindMs` — how far the fold is behind that clock, a LATENCY,
//     which answers the diagnostic question ("is the engine keeping up?") without answering the
//     private one ("when were you at the keyboard?");
//   * `perf.budgets` renders its `limit`, `measured` and `note` as PROSE for the panel, and none of
//     the three rides here. A verdict is an enum member; the measurements ride as the raw integers
//     the engine already served (`scanMs`, `scanKb`, `worstServeUs`), so a reader has the number
//     rather than somebody's sentence about it — and the wire has no free-text channel;
//   * `perf.snapshot`'s serve table names SOURCES. Those are app-internal identifiers and would be
//     safe, but they are summed into counts here anyway, because a bug report wants one number per
//     question and sixty bytes of table per source is a size this block cannot afford.
//
// The validator below therefore never has to sanitize anything. It checks integers against bounds
// and strings against closed lists, and there is no third case.

/** The engine's own state, as `perf.snapshot` spells it. Restated by value: this file must not
 *  import the generated protocol at runtime, and the five members are a contract either way. */
export const ENGINE_STATES = ['starting', 'attaching', 'folding', 'live', 'idle'] as const
export type FeedbackEngineState = (typeof ENGINE_STATES)[number]

/** Every budget the engine enforces, and the verdicts it can give. Both closed sets, both checked
 *  against by the validator — see the bright-line note above. */
export const ENGINE_BUDGETS = ['foldRate', 'serveLatency'] as const
export type FeedbackEngineBudgetId = (typeof ENGINE_BUDGETS)[number]

export const ENGINE_VERDICTS = ['pass', 'fail', 'unmeasured'] as const
export type FeedbackEngineVerdict = (typeof ENGINE_VERDICTS)[number]

/** WHERE THE FOLD'S ZONE CAME FROM (JOS-536). A closed set, so it rides the same way every other
 *  string on this block does — as a member rather than as text. The ZONE ITSELF never rides: it is
 *  a name, and this block carries no strings (see the bright line above). */
export const ENGINE_CLOCK_SOURCES = ['host', 'platform', 'offset', 'utc'] as const
export type FeedbackEngineClockSource = (typeof ENGINE_CLOCK_SOURCES)[number]

/** Ceilings, restated from `./feedbackPerf.ts` BY VALUE for the cycle reason in the header, plus
 *  three this block needs and that file has no use for. Pinned equal in the tests. */
export const MAX_ENGINE_MS = 3_600_000
export const MAX_ENGINE_COUNT = 1_000_000
/** An uptime is not bounded by the ten-minute window the rest of the block is — the engine dies
 *  with the app, and an app can be left running for weeks. A year, so the bound is still a bound. */
export const MAX_ENGINE_UP_MS = 31_536_000_000
/** A latency in MICROSECONDS. An hour, for the same reason every other ceiling here is absurd:
 *  nothing real approaches it, and it exists so a forged block is bounded like every other field. */
export const MAX_ENGINE_US = 3_600_000_000
/** Kilobytes. A terabyte, which no scan of a game log will reach and no forgery may exceed. */
export const MAX_ENGINE_KB = 1_000_000_000

/** One budget's verdict. The definitions — label, limit, the caveat — are BUILD CONSTANTS and
 *  deliberately do not ride: they are the same on every report this version produces, they are
 *  roughly a kilobyte of prose, and the panel is where a person reads them. */
export interface FeedbackPerfBudget {
  id: FeedbackEngineBudgetId
  verdict: FeedbackEngineVerdict
}

/**
 * THE ENGINE'S BLOCK. Absent from a report means NO ENGINE ANSWERED — a build without one, a
 * supervisor between respawns, or a refusal — and it is absent rather than zeroed for the reason
 * every instrument in this family gives: a row of zeros is a measurement somebody took.
 *
 * The optional fields inside it keep the same rule one level down. An idle engine has a `state` and
 * an `upMs` and nothing else, because nothing else has happened yet; a scan still running has no
 * `scanMs`; a session whose every frame was an owed reset has no `worstServeUs`.
 */
export interface FeedbackPerfEngine {
  /** What the engine was doing when the report was composed. */
  state: FeedbackEngineState
  /** How long the ENGINE PROCESS had been up. Not the app's uptime — the engine is respawnable, and
   *  a young engine under an old app is itself the finding. */
  upMs: number
  /** Events folded in this generation. A COUNT of events, never any of their content. */
  events?: number
  /**
   * How far the fold was behind the LOG's own clock — a lag, not a timestamp (see the header).
   *
   * IT IS BOUNDED BY `MAX_ENGINE_UP_MS` AND NOT BY `MAX_ENGINE_MS`, and that is a correction rather
   * than a preference. The rest of this block's durations are costs — a scan, a catalog build — and
   * an hour is an absurd bound for those on purpose. A FRESHNESS LAG IS NOT A COST: it is the
   * distance between now and the last line the log has, so a user who has not played since Tuesday
   * honestly has one of several days, and this repo's own e2e fixture reports 23.4 days. Under an
   * hour's ceiling every one of those readings would be silently OMITTED (the `whole` helper drops
   * rather than clamps, correctly) — and "the engine is three days behind the log" is one of the
   * strongest things a stalled-app report can say.
   */
  behindMs?: number
  /**
   * WHICH CLOCK THE FOLD IS ON, and how far it disagrees with the machine that reported (JOS-536).
   *
   * `clockSource` says whether the engine was TOLD its zone or guessed it, and `utc` there is a
   * diagnosis on its own: it means neither the app's hint nor the platform probe answered, which is
   * the Wine failure that made three 1.15.0 reporters' fights one second long.
   *
   * `clockSkewMs` IS SIGNED, and it is the only signed number on this block. Everything else here
   * is a cost or a lag and cannot be negative; this is the distance between two clocks, and which
   * way round it points is half the finding — a US host reads hours behind, an east-of-UTC one
   * hours ahead. Bounded by `MAX_ENGINE_UP_MS` in both directions for `behindMs`'s reason: it is a
   * clock distance rather than a cost, and an hour would be the wrong ceiling for it.
   *
   * Neither says WHEN anybody played, and the zone NAME does not ride at all.
   */
  clockSource?: FeedbackEngineClockSource
  clockSkewMs?: number
  /** What the parser's spell catalog cost this attach. */
  spellDbMs?: number
  /** Wall time of the scan, and what it read. The fold RATE is these two divided, and it is left
   *  as two numbers rather than one derived one so the report carries what the engine served and
   *  nothing this process computed on top of it. */
  scanMs?: number
  scanKb?: number
  /** Frames served across every source, and what they weighed. Summed rather than tabled — a bug
   *  report wants one number per question. */
  frames?: number
  servedKb?: number
  /** The worst fold-to-frame latency any source reported, in microseconds. It includes the ~10 Hz
   *  coalescing beat and is not a compute measurement — the same caveat the panel's tooltip carries,
   *  restated here because this is where somebody will read the number without the tooltip. */
  worstServeUs?: number
  /** Every budget and its verdict, in the order the engine served them. Never empty when the block
   *  is present: a budget with nothing to judge says `unmeasured` rather than dropping out. */
  budgets: FeedbackPerfBudget[]
  /** The engine's own ring (`perf.timeline`), SUMMARIZED — how many windows it held, the busiest
   *  one's frame count, and how many were quiet. The thirty moments themselves are ten times this
   *  size and would not fit; what a report needs is whether the recent past was busy, uneven, or
   *  silent, and three numbers answer that. */
  windows?: number
  busiestFrames?: number
  quietWindows?: number
}

// ---- the fold ----------------------------------------------------------------------------------

/** The three answers, exactly as the ops give them, plus the host clock the lag is measured
 *  against. Structurally typed rather than imported from the generated protocol so this file stays
 *  free of that dependency in the Lambda bundle — and so a test can hand it a literal. */
export interface EngineServeRow {
  frames: number
  payloadWeight: number
  foldToFrameUsMax?: number
}

export interface EngineFoldInput {
  snapshot: {
    status: string
    uptimeMs: number
    events?: number
    lastEventTs?: number
    // `clockZone` is deliberately absent from this shape: what the fold cannot see, it cannot send.
    clockSource?: string
    clockSkewMs?: number
    ingest: { spellDbMs?: number; scanMs?: number; scanBytes?: number }
    serve: EngineServeRow[]
  } | null
  budgets: { budgets: { id: string; verdict: string }[] } | null
  timeline: { timeline: { frames: number }[] } | null
  now: number
}

/** Bytes → whole kilobytes, floor. The unit change this block makes and the only arithmetic in it
 *  that is not a sum, a max or a subtraction. */
function kb(bytes: number): number {
  return Math.max(0, Math.floor(bytes / 1024))
}

/** A whole number in range, or `undefined` — anything a reading cannot honestly answer is OMITTED
 *  rather than clamped into a plausible-looking value. */
function whole(value: number | undefined, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  const n = Math.max(0, Math.round(value))
  return Number.isSafeInteger(n) && n <= max ? n : undefined
}

/** …and the same for a reading whose SIGN is part of the finding. Same bound, applied to the
 *  magnitude: a clock two hours ahead and one two hours behind are equally in range. */
function signed(value: number | undefined, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  const n = Math.round(value)
  return Number.isSafeInteger(n) && Math.abs(n) <= max ? n : undefined
}

/** The serve table, summed into the three numbers the block carries. */
function servePath(rows: readonly EngineServeRow[]): Partial<FeedbackPerfEngine> {
  if (rows.length === 0) return {}
  const worst = rows
    .map((r) => r.foldToFrameUsMax)
    .filter((us): us is number => us !== undefined)
  return {
    frames: whole(
      rows.reduce((sum, r) => sum + r.frames, 0),
      MAX_ENGINE_COUNT
    ),
    servedKb: whole(
      kb(rows.reduce((sum, r) => sum + r.payloadWeight, 0)),
      MAX_ENGINE_KB
    ),
    // Absent, never zero, when no frame anywhere had a fold behind it.
    ...(worst.length === 0 ? {} : { worstServeUs: whole(Math.max(...worst), MAX_ENGINE_US) })
  }
}

/** The ring, summarized into three numbers. Absent entirely when the ring is empty, which is what a
 *  just-attached engine honestly has. */
function ringSummary(moments: readonly { frames: number }[]): Partial<FeedbackPerfEngine> {
  if (moments.length === 0) return {}
  return {
    windows: whole(moments.length, MAX_ENGINE_COUNT),
    busiestFrames: whole(Math.max(...moments.map((m) => m.frames)), MAX_ENGINE_COUNT),
    quietWindows: whole(moments.filter((m) => m.frames === 0).length, MAX_ENGINE_COUNT)
  }
}

/** The verdicts, filtered to the budgets this contract knows. An id this build has never heard of
 *  is DROPPED rather than passed through — the closed-set rule applied at the fold as well as at
 *  the validator, so an engine ahead of the app cannot open a string channel. */
function verdicts(rows: readonly { id: string; verdict: string }[]): FeedbackPerfBudget[] {
  const out: FeedbackPerfBudget[] = []
  for (const row of rows) {
    const id = ENGINE_BUDGETS.find((b) => b === row.id)
    const verdict = ENGINE_VERDICTS.find((v) => v === row.verdict)
    if (id !== undefined && verdict !== undefined) out.push({ id, verdict })
  }
  return out
}

/**
 * The engine's block, or `null` when there is nothing honest to say.
 *
 * `null` WHEN NO SNAPSHOT ANSWERED, and only then: a snapshot is what carries the state and the
 * uptime, which are the two facts that make every other one readable. Budgets or a timeline
 * without it would be numbers with no engine attached to them.
 */
export function foldPerfEngine(input: EngineFoldInput): FeedbackPerfEngine | null {
  const snap = input.snapshot
  if (snap === null) return null
  const state = ENGINE_STATES.find((s) => s === snap.status)
  if (state === undefined) return null
  const behind =
    snap.lastEventTs === undefined ? undefined : Math.max(0, input.now - snap.lastEventTs)
  return {
    state,
    upMs: whole(snap.uptimeMs, MAX_ENGINE_UP_MS) ?? 0,
    ...optional('events', whole(snap.events, MAX_ENGINE_COUNT)),
    ...optional('behindMs', whole(behind, MAX_ENGINE_UP_MS)),
    // A source this build has never heard of is DROPPED, the closed-set rule applied at the fold:
    // an engine ahead of the app must not be able to open a string channel.
    ...clockSourceField(snap.clockSource),
    ...optional('clockSkewMs', signed(snap.clockSkewMs, MAX_ENGINE_UP_MS)),
    ...optional('spellDbMs', whole(snap.ingest.spellDbMs, MAX_ENGINE_MS)),
    ...optional('scanMs', whole(snap.ingest.scanMs, MAX_ENGINE_MS)),
    ...optional(
      'scanKb',
      snap.ingest.scanBytes === undefined ? undefined : whole(kb(snap.ingest.scanBytes), MAX_ENGINE_KB)
    ),
    ...servePath(snap.serve),
    budgets: verdicts(input.budgets?.budgets ?? []),
    ...ringSummary(input.timeline?.timeline ?? [])
  }
}

/** `{ key: value }` when the value is there, `{}` when it is not — the omission rule, once. */
function optional(key: string, value: number | undefined): Record<string, number> {
  return value === undefined ? {} : { [key]: value }
}

/** …and the same for the one enum member that is optional. */
function clockSourceField(raw: string | undefined): { clockSource?: FeedbackEngineClockSource } {
  const source = ENGINE_CLOCK_SOURCES.find((s) => s === raw)
  return source === undefined ? {} : { clockSource: source }
}

/**
 * THE BLOCK AS A SPREADABLE FIELD — the shape `foldFeedbackPerf` wants, and the reason it exists is
 * `foldPerfOwner`'s exactly: that function sits at the repo's complexity ceiling of 12, and one
 * `input.engine === undefined ? null : …` plus one `engine === null ? {} : { engine }` is what took
 * it to 13. Gathering both here means the OMISSION RULE — an engine that did not answer is left out
 * rather than sent as null — is written on the same side of the seam as the fold that decides it.
 */
export interface PerfEngineField {
  engine?: FeedbackPerfEngine
}

export function foldPerfEngineField(input: EngineFoldInput | undefined): PerfEngineField {
  if (input === undefined) return {}
  const engine = foldPerfEngine(input)
  return engine === null ? {} : { engine }
}

/** …and the same field off an incoming report, spreadable in one expression for the same reason
 *  `validatePerf` needs it: that function is at the ceiling too. */
export function validatePerfEngineField(raw: unknown): Validated<PerfEngineField> {
  const engine = validatePerfEngine(raw)
  if (!engine.ok) return engine
  return { ok: true, value: engine.value === undefined ? {} : { engine: engine.value } }
}

// ---- the validator -----------------------------------------------------------------------------

// STRUCTURALLY the `PerfValidated` shape `./feedbackPerf.ts` declares, restated here rather than
// imported for the cycle reason in the header — `validatePerf` returns one of these straight
// through, so the two must agree field for field. `feedbackPerfSeams.ts` carries the same copy for
// the same reason, and the drift risk is what its own comment names: a validator importing its
// error type from the thing that consumes it is the arrangement that lets them separate.
type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; error: 'invalid_payload'; message: string; field: string }

const bad = (field: string, message: string): Validated<never> => ({
  ok: false,
  error: 'invalid_payload',
  message,
  field
})

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A whole number in [0, max]. Fractions are REJECTED rather than rounded, as everywhere on this
 *  wire: the block promises whole numbers, and a client sending 12.7 is not our client. */
function count(raw: unknown, field: string, max: number): Validated<number> {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw))
    return bad(field, `${field} must be a whole number.`)
  if (raw < 0 || raw > max) return bad(field, `${field} must be between 0 and ${max}.`)
  return { ok: true, value: raw }
}

/** …and the same, optionally. Absent and null are the same answer, one level down. */
function maybe(raw: unknown, field: string, max: number): Validated<number | undefined> {
  if (raw === null || raw === undefined) return { ok: true, value: undefined }
  return count(raw, field, max)
}

/** The one SIGNED field, optionally — same whole-number discipline, bound applied to the
 *  magnitude. See `clockSkewMs`'s own doc for why a negative reading is a real one. */
function maybeSigned(raw: unknown, field: string, max: number): Validated<number | undefined> {
  if (raw === null || raw === undefined) return { ok: true, value: undefined }
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw))
    return bad(field, `${field} must be a whole number.`)
  if (Math.abs(raw) > max) return bad(field, `${field} must be between ${-max} and ${max}.`)
  return { ok: true, value: raw }
}

const OPTIONAL_FIELDS = [
  ['events', MAX_ENGINE_COUNT],
  // A LAG, NOT A COST — see the field's own doc for why an hour is the wrong bound for it.
  ['behindMs', MAX_ENGINE_UP_MS],
  ['spellDbMs', MAX_ENGINE_MS],
  ['scanMs', MAX_ENGINE_MS],
  ['scanKb', MAX_ENGINE_KB],
  ['frames', MAX_ENGINE_COUNT],
  ['servedKb', MAX_ENGINE_KB],
  ['worstServeUs', MAX_ENGINE_US],
  ['windows', MAX_ENGINE_COUNT],
  ['busiestFrames', MAX_ENGINE_COUNT],
  ['quietWindows', MAX_ENGINE_COUNT]
] as const

/** The budget list on an incoming report. AT MOST ONE ENTRY PER BUDGET, so a forged list cannot
 *  repeat `foldRate` a thousand times to bloat the block past a reader's patience — the same cap,
 *  for the same reason, as `validatePerfSeams`'s. */
function validateBudgets(raw: unknown): Validated<FeedbackPerfBudget[]> {
  if (!Array.isArray(raw) || raw.length > ENGINE_BUDGETS.length)
    return bad(
      'env.perf.engine.budgets',
      `env.perf.engine.budgets must be at most ${ENGINE_BUDGETS.length} entries.`
    )
  const out: FeedbackPerfBudget[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const at = `env.perf.engine.budgets[${i}]`
    const one: unknown = raw[i]
    if (!isRec(one)) return bad(at, `${at} must be an object.`)
    const id = ENGINE_BUDGETS.find((b) => b === one.id)
    if (id === undefined)
      return bad(`${at}.id`, `${at}.id must be one of: ${ENGINE_BUDGETS.join(', ')}.`)
    const verdict = ENGINE_VERDICTS.find((v) => v === one.verdict)
    if (verdict === undefined)
      return bad(`${at}.verdict`, `${at}.verdict must be one of: ${ENGINE_VERDICTS.join(', ')}.`)
    if (seen.has(id)) return bad(`${at}.id`, `env.perf.engine.budgets names ${id} twice.`)
    seen.add(id)
    out.push({ id, verdict })
  }
  return { ok: true, value: out }
}

/**
 * The engine block on an incoming report. ABSENT AND NULL ARE THE SAME ANSWER — "this client had no
 * engine to ask" — which is what makes the field additive: every already-installed client omits it
 * and is not rejected for doing so.
 *
 * IT RECONSTRUCTS RATHER THAN COPIES, like every validator on this wire, so a key the shape does
 * not name cannot ride along into a stored report. There is no string field here at all except the
 * two enum members, both checked against their closed lists — see the header.
 */
export function validatePerfEngine(raw: unknown): Validated<FeedbackPerfEngine | undefined> {
  if (raw === null || raw === undefined) return { ok: true, value: undefined }
  if (!isRec(raw)) return bad('env.perf.engine', 'env.perf.engine must be an object or null.')
  const state = ENGINE_STATES.find((s) => s === raw.state)
  if (state === undefined)
    return bad('env.perf.engine.state', `env.perf.engine.state must be one of: ${ENGINE_STATES.join(', ')}.`)
  const upMs = count(raw.upMs, 'env.perf.engine.upMs', MAX_ENGINE_UP_MS)
  if (!upMs.ok) return upMs
  const budgets = validateBudgets(raw.budgets)
  if (!budgets.ok) return budgets
  const value: FeedbackPerfEngine = { state, upMs: upMs.value, budgets: budgets.value }
  for (const [key, max] of OPTIONAL_FIELDS) {
    const v = maybe(raw[key], `env.perf.engine.${key}`, max)
    if (!v.ok) return v
    if (v.value !== undefined) value[key] = v.value
  }
  const clock = applyClock(raw, value)
  if (!clock.ok) return clock
  return { ok: true, value }
}

/**
 * The two clock fields, applied onto the block being reconstructed.
 *
 * Its own function for this file's standing reason: `validatePerfEngine` sits at the repo's
 * complexity ceiling of 12, and three more branches took it over. An unknown `clockSource` is
 * DROPPED rather than refused — an engine ahead of this build is a client with a field this one
 * cannot read, not a forgery, and that is the same answer the fold gives.
 */
function applyClock(raw: Record<string, unknown>, value: FeedbackPerfEngine): Validated<void> {
  const skew = maybeSigned(raw.clockSkewMs, 'env.perf.engine.clockSkewMs', MAX_ENGINE_UP_MS)
  if (!skew.ok) return skew
  if (skew.value !== undefined) value.clockSkewMs = skew.value
  const source = ENGINE_CLOCK_SOURCES.find((s) => s === raw.clockSource)
  if (source !== undefined) value.clockSource = source
  return { ok: true, value: undefined }
}

// ---- the printed line --------------------------------------------------------------------------

/**
 * THE ENGINE'S LINE, in the words a person acts on — one of the readers `formatPerfBlock` composes.
 *
 * ABSENT SAYS SO IN WORDS, and the wording is a FINDING rather than a shrug: "no engine answered"
 * on a report about a stall is itself a diagnosis, and a reader must be able to tell it from a
 * client too old to have looked. A build with no engine and an engine that refused are the same
 * sentence here on purpose — the panel is where that difference is visible, and a report that
 * guessed between them would be guessing.
 */
export function formatPerfEngine(engine: FeedbackPerfEngine | null | undefined): string {
  if (engine === null || engine === undefined) return 'no engine answered'
  return [
    `${engine.state} up ${Math.round(engine.upMs / 1000)}s`,
    ...ingestWords(engine),
    ...serveWords(engine),
    engine.budgets.length === 0
      ? 'no budgets reported'
      : engine.budgets.map((b) => `${b.id} ${b.verdict}`).join(', ')
  ].join(' · ')
}

/** What the fold has done and what it cost. Split out for the complexity ceiling — see the header
 *  for why this file has a habit of splitting rather than raising one. */
function ingestWords(engine: FeedbackPerfEngine): string[] {
  const words: string[] = []
  if (engine.events !== undefined) words.push(`${engine.events.toLocaleString()} events`)
  if (engine.behindMs !== undefined) words.push(`${engine.behindMs}ms behind`)
  // WHICH CLOCK, AND HOW WRONG. A whole number of hours here is the zone bug, and a reader who
  // never opens the panel has to be able to see it in the printed line.
  if (engine.clockSource !== undefined) words.push(`clock ${engine.clockSource}`)
  if (engine.clockSkewMs !== undefined) words.push(`skew ${engine.clockSkewMs}ms`)
  if (engine.scanMs !== undefined)
    words.push(
      `scan ${engine.scanMs}ms${engine.scanKb === undefined ? '' : ` of ${engine.scanKb}kB`}`
    )
  return words
}

/** …and what serving it has cost, plus the ring's shape. */
function serveWords(engine: FeedbackPerfEngine): string[] {
  const words: string[] = []
  if (engine.frames !== undefined)
    words.push(
      `${engine.frames} frames${engine.servedKb === undefined ? '' : ` / ${engine.servedKb}kB`}` +
        (engine.worstServeUs === undefined ? '' : ` worst ${engine.worstServeUs}us`)
    )
  if (engine.windows !== undefined)
    words.push(`${engine.windows} windows (${engine.quietWindows ?? 0} quiet)`)
  return words
}
