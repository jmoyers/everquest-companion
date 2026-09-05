// lib/renderCommits.ts — THE COMMIT COUNTER'S ARITHMETIC, and nothing else (JOS-513).
//
// > "The app measures main, the engine, and serve latency, but nothing counts renderer COMMITS —
// > so a re-render regression shows up as feel, not as a number." — the ticket, ruling 19 extended
// > to the renderer.
//
// This file is the half that can be PROVEN AT A DESK: a ring of commit records and the four
// questions the panel asks of it (how many, how fast, how bad, and which surface). It knows nothing
// about React, nothing about `import.meta.env`, and nothing about MUI — which is what lets
// `tests/renderCommits.test.mts` drive it with a hand-turned clock. `renderMeter.tsx` is the other
// half: the Profiler mounts, the dev gate, and the poll-while-open hook.
//
// A RING, AND THE REASON IS THE SUBJECT. This counter runs INSIDE every commit it measures, so an
// instrument that allocated per commit would be a re-render regression of its own — measuring a
// render program with a tool that allocates on the render path is how you chase your own tail. Two
// `Float64Array`s and a pre-sized string array are written in place; recording a commit allocates
// nothing at all, and a full window costs one fixed buffer for the session.
//
// AND THE RING'S OWN LIMIT IS REPORTED RATHER THAN HIDDEN. A capacity is a number of commits, so a
// pathological render loop can overwrite records that were still inside the window. When that has
// happened the sample says `saturated` and every count below it is a FLOOR — the alternative, a
// count that silently understates exactly when the app is at its worst, is the one answer this
// panel must never give.

/** The rolling window every rate and every worst-case below is measured over. Five seconds is
 *  short enough that the number moves while you watch it and long enough that a single stray
 *  commit does not read as a spike. */
export const RENDER_WINDOW_MS = 5_000

/** How many commits the ring can hold. 512 over a 5 s window is ~100 commits/second before the
 *  floor caveat appears — an order of magnitude above the ~12-commits-per-engine-beat the render
 *  program's own probe measured on the owner's real tree, so ordinary badness still counts exactly
 *  and only pathological badness reads as "at least". */
export const RENDER_RING_CAPACITY = 512

/** A rate needs an interval. Below this much observed time the sample reports `null` rather than a
 *  number — the same call `PerfEngineSection`'s process row makes when it says "measuring" instead
 *  of printing a `0%` that no elapsed time stands behind. */
export const RENDER_MIN_SPAN_MS = 1_000

/**
 * The commit log. Written in place by `recordCommit`, read by `summarizeCommits`, and owned by
 * `renderMeter.tsx` — which holds exactly one of them, created on the FIRST commit rather than at
 * module load, so a build with no Profiler mounted never allocates it.
 */
export interface CommitRing {
  /** When each commit landed, on the caller's clock. Slot-indexed with the two arrays below. */
  readonly at: Float64Array
  /** What each commit cost, in milliseconds — React's `actualDuration`. */
  readonly durationMs: Float64Array
  /** Which Profiler reported it. */
  readonly ids: string[]
  /** The slot the next commit goes in. */
  next: number
  /** How many slots hold a real record (≤ capacity). */
  live: number
  /** Every commit ever offered, including ones the ring has since overwritten. Monotonic. */
  offered: number
  /** The clock reading when this ring started observing — the denominator's floor, so a rate is
   *  never divided by more time than the meter has actually been watching. */
  readonly since: number
}

/** One Profiler id's row. `null` is used for "there is no answer", never for zero. */
export interface SurfaceCommits {
  readonly id: string
  /** Commits inside the window. Zero is a real, measured answer here — an idle app committing
   *  nothing is the whole point of the counter. */
  readonly commits: number
  /** Commits per second, or `null` while the meter has less than `RENDER_MIN_SPAN_MS` behind it. */
  readonly perSecond: number | null
  /** The worst single commit in the window, or `null` when there were none: `0 ms` there would
   *  claim a render took no time, which is a different and false statement. */
  readonly worstMs: number | null
}

/** What the panel draws. */
export interface RenderCommitSample {
  /** How long this reading covers: the window, or the meter's whole life if that is shorter. */
  readonly spanMs: number
  /** The window the rates are over — carried so the panel never has to import the constant. */
  readonly windowMs: number
  /**
   * The root Profiler's row — ALWAYS PRESENT once the meter exists, at zero if the app committed
   * nothing. That is not a breach of the absent-not-zero rule one file over: the root Profiler IS
   * mounted, so "0 commits in the last 5 s" is a measurement somebody made, where an unmounted
   * surface's zero would be a measurement nobody made.
   */
  readonly root: SurfaceCommits
  /** Every OTHER Profiler id with a commit in the window, busiest first. Ids with nothing behind
   *  them are omitted entirely — those are the zeros that would be a lie. */
  readonly surfaces: SurfaceCommits[]
  /** The ring wrapped while its oldest live record was still inside the window: the counts above
   *  are a floor, not a total. */
  readonly saturated: boolean
}

/** A fresh ring, observing from `now`. */
export function createRing(now: number, capacity: number = RENDER_RING_CAPACITY): CommitRing {
  return {
    at: new Float64Array(capacity),
    durationMs: new Float64Array(capacity),
    ids: new Array<string>(capacity).fill(''),
    next: 0,
    live: 0,
    offered: 0,
    since: now
  }
}

/** Record one commit. Allocation-free by construction — see the header. */
export function recordCommit(ring: CommitRing, id: string, at: number, durationMs: number): void {
  const capacity = ring.at.length
  ring.at[ring.next] = at
  ring.durationMs[ring.next] = durationMs
  ring.ids[ring.next] = id
  ring.next = (ring.next + 1) % capacity
  if (ring.live < capacity) ring.live += 1
  ring.offered += 1
}

/** Per-id accumulation while the walk is running. Mutable on purpose; frozen into `SurfaceCommits`
 *  rows at the end. */
interface Tally {
  commits: number
  worstMs: number | null
}

function tallyOf(byId: Map<string, Tally>, id: string): Tally {
  const existing = byId.get(id)
  if (existing !== undefined) return existing
  const fresh: Tally = { commits: 0, worstMs: null }
  byId.set(id, fresh)
  return fresh
}

/** Commits per second over `spanMs`, or `null` while there is not enough interval to divide by. */
function rate(commits: number, spanMs: number): number | null {
  if (spanMs < RENDER_MIN_SPAN_MS) return null
  return (commits * 1_000) / spanMs
}

function rowOf(id: string, tally: Tally, spanMs: number): SurfaceCommits {
  return {
    id,
    commits: tally.commits,
    perSecond: rate(tally.commits, spanMs),
    worstMs: tally.worstMs
  }
}

/**
 * Read the ring: what has committed in the last `windowMs`, split by Profiler id.
 *
 * `rootId` is named by the caller rather than guessed here — this file has no opinion about which
 * Profiler is the outermost one, and the panel's "app-wide" row is precisely that Profiler's row.
 * Everything else becomes a per-surface row, sorted busiest first (a stable tie-break on the id
 * keeps the order from flickering between two equally busy surfaces at 1 Hz).
 *
 * SORTING HERE IS NOT DOMAIN MUNGING: these rows are the renderer's measurements OF ITSELF, not
 * served rows — the distinction `eslint.domainMunging.mjs` draws by element-type declaration site,
 * and this type is declared right here.
 */
export function summarizeCommits(
  ring: CommitRing,
  now: number,
  options: { rootId: string; windowMs?: number }
): RenderCommitSample {
  const windowMs = options.windowMs ?? RENDER_WINDOW_MS
  const floor = now - windowMs
  const spanMs = Math.min(windowMs, Math.max(0, now - ring.since))
  const capacity = ring.at.length
  const byId = new Map<string, Tally>()
  let oldestInWindow = false

  for (let n = 0; n < ring.live; n += 1) {
    // Walk backwards from the most recent slot, so the first record older than the window ends the
    // walk: the ring is written in time order and reading it in reverse means a quiet app touches
    // a handful of slots rather than all 512.
    const slot = (ring.next - 1 - n + capacity * 2) % capacity
    const at = ring.at[slot] ?? 0
    if (at < floor) break
    if (n === ring.live - 1) oldestInWindow = true
    const tally = tallyOf(byId, ring.ids[slot] ?? '')
    tally.commits += 1
    const duration = ring.durationMs[slot] ?? 0
    if (tally.worstMs === null || duration > tally.worstMs) tally.worstMs = duration
  }

  const root = rowOf(options.rootId, byId.get(options.rootId) ?? { commits: 0, worstMs: null }, spanMs)
  const surfaces = [...byId.entries()]
    .filter(([id]) => id !== options.rootId)
    .map(([id, tally]) => rowOf(id, tally, spanMs))
    .sort((a, b) => b.commits - a.commits || a.id.localeCompare(b.id))

  return {
    spanMs,
    windowMs,
    root,
    surfaces,
    // The ring is full AND its oldest surviving record is still inside the window, so a record that
    // belonged in this count has already been overwritten.
    saturated: ring.live === capacity && oldestInWindow
  }
}
