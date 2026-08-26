/**
 * ============================================================================
 * goldenOracle.mts — THE TRUTH THE RUST ENGINE MUST MATCH (JOS-465).
 * ============================================================================
 *
 * The owner's ruling on the data-server program (docs/plans/data-server.md, "the equivalence
 * oracle"): the Rust engine is proven by BYTE-IDENTICAL semantics against this TS pipeline over
 * six uncommitted slices of his real log, and only then cut over. Until this file, nothing
 * recorded those goldens — the bench arms count events and throw them away, `engineOracle.mts`
 * writes stdout a human diffs by eye, and the slices were referenced by zero code. This is the
 * recorder and the comparator that acceptance stands on; `goldenCli.mts` is its two commands.
 *
 * TWO ARTIFACTS PER SLICE, because the program's bar is two claims:
 *
 *   `<slice>.events.ndjson` — PHASE 1. One `JSON.stringify(ev)` per line, in emission order, for
 *      every PARSER-emitted event. Compared BYTE FOR BYTE, which is the phase-1 bar verbatim.
 *      Recorded from a listener subscribed AHEAD OF ALL MODULES (`WorldOpts.observe`), so it is
 *      the parser's output and not some consumer's reading of it.
 *
 *      DERIVED KINDS ARE EXCLUDED — `buffExpired`, `epoch`, `offlineGap`. None of them is
 *      produced by the parser: they are synthesized DOWNSTREAM (the buffs module, the epoch
 *      detector, the session detector) and handed back through `bus.emitDerived`. Including them
 *      would make a phase-1 artifact quietly assert phase-2 behaviour, and a Rust parser proven
 *      against it would be being asked to reproduce work it does not do.
 *
 *      THE `live` FLAG, recorded alongside — as a RUN-LENGTH ENCODING in the snapshots artifact
 *      (`liveRuns`) rather than an envelope on every line. It is per-event and lossless either
 *      way; a historical scan is `live:false` from the first byte to the last, so the envelope
 *      would have cost ~10 MB per slice to say "false" seven hundred thousand times, and the
 *      NDJSON would no longer be the event stream itself. The run-length form states the same
 *      fact and keeps the phase-1 artifact exactly what phase 1 is about.
 *
 *   `<slice>.snapshots.json` — PHASE 2. Every module in `modules.ordered` (all 20, in wiring
 *      order), then the combat engine: the full-fat snapshot plus the per-scope walk
 *      `engineOracle.mts` established. Compared by DEEP EQUALITY with a first-divergence path,
 *      because a snapshot is assembled on demand and key order is not a claim the engine makes.
 *
 * THE INSTANT IS THE LOG'S, NEVER `Date.now()` — `engineOracle.mts`'s rule, and this file needs
 * it twice over. `combat.snapshot(now)` takes the LAST EVENT's timestamp. And the world is
 * CONSTRUCTED under a pinned clock (`WorldOpts.constructionNowMs`, whose header carries the
 * argument): the respawn module seeds its ordering clock from `Date.now()` at `reset()`, nothing
 * advances it during a fold, and it survives into `snapshot()` where it orders the rows. Without
 * the pin a golden recorded on Monday does not re-check on Tuesday, and the check that later
 * gates a Rust cutover would be a coin flip.
 *
 * ONE FIELD IS STRIPPED AND IT IS THE ONE `tests/replayChunking.test.mts:346-353` names:
 * `updatedAt`. Everything else — every active, every mined duration, every learned message,
 * every point of damage — is compared exactly.
 *
 * WHY STREAMING, NOT ARRAYS. A slice folds to hundreds of thousands of events; holding the
 * stream as strings costs hundreds of megabytes and holding five slicer arms' worth costs more
 * than the machine has. So the recorder writes through a fixed buffer with `writeSync`, and the
 * comparator reads the golden through a fixed buffer with `readSync`. Both are synchronous
 * because the bus listener they run inside is, and neither ever holds more than one chunk.
 */
import {
  closeSync,
  createReadStream,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ROOT } from '../e2e/build.mjs'
import { foldForGoldens } from './foldArm.mjs'
// THE DEEP-EQUALITY WALK LIVES IN `src/shared` SINCE JOS-479 and is re-exported below, unchanged.
// The in-app parity probe asks this file's question of the same pair of worlds inside the running
// product, and "are these the same?" may not have two implementations in one repo.
import { firstDiff, type Diff } from '../../src/shared/deepDiff'
import { parseEqTimestamp } from '../../src/main/log/parser'
import type { LogEvent } from '../../src/shared/logEvents'
import type { Slicer } from '../../src/main/log/replaySlicer'
import type { CombatEngine } from '../../src/main/combat/engine'
import type { ModuleRegistry } from '../../src/main/modules/registry'

// ------------------------------------------------------------------------------- the slice corpus

/** One row of `tests/bench/fixtures/slices/manifest.json`. */
export interface SliceRef {
  name: string
  file: string
  path: string
}

export const SLICES_DIR = join(ROOT, 'tests', 'bench', 'fixtures', 'slices')
export const GOLDENS_DIR = join(ROOT, 'tests', 'bench', 'fixtures', 'goldens')

/** Every slice the manifest declares, in manifest order. Throws if the corpus is absent — the
 *  slices are gitignored by design, so "no goldens" and "no input" must not look alike. */
export function readSlices(): SliceRef[] {
  const manifest = join(SLICES_DIR, 'manifest.json')
  const raw = JSON.parse(readFileSync(manifest, 'utf8')) as {
    slices: { name: string; file: string }[]
  }
  return raw.slices.map((s) => ({ name: s.name, file: s.file, path: join(SLICES_DIR, s.file) }))
}

/**
 * The character the slice was cut from, DERIVED FROM THE FILENAME —
 * `eqlog_<Name>_<server>.<slice>.txt`. The self-`/who` rule and the pet-leader carve-out both
 * need the same name the app would install, and hardcoding it here would make the corpus and
 * the harness able to drift apart silently.
 */
export function characterOf(slice: SliceRef): { name: string; server: string; logPath: string } {
  const m = /^eqlog_(.+?)_([^_]+?)\.[^.]+\.txt$/i.exec(slice.file)
  if (!m) throw new Error(`goldenOracle: cannot read a character out of "${slice.file}"`)
  return { name: m[1], server: m[2], logPath: slice.path }
}

/**
 * The artifact paths. `dir` defaults to the real goldens directory and is overridden by exactly
 * one caller — `tests/goldenOracle.test.mts`, which runs the whole record/check path over a
 * COMMITTED fixture in a temp dir. That test has to run on a machine that has never seen the
 * owner's slices (CI is one), so the corpus location cannot be baked into the harness.
 */
export const eventsPath = (name: string, dir = GOLDENS_DIR): string => join(dir, `${name}.events.ndjson`)
export const snapshotsPath = (name: string, dir = GOLDENS_DIR): string => join(dir, `${name}.snapshots.json`)

// --------------------------------------------------------------------------- what a fold produces

/** DERIVED kinds: synthesized downstream of the parser, out of phase-1 scope (header). */
const DERIVED_KINDS = new Set(['buffExpired', 'epoch', 'offlineGap'])
export const isParserEvent = (ev: LogEvent): boolean => !DERIVED_KINDS.has(ev.kind)

/** The phase-2 artifact: every published snapshot the fold can be asked for. */
export interface SnapshotGolden {
  slice: string
  /** `ScanResult.seq` — every event the scan stamped, derived ones included. */
  events: number
  /** How many lines the events NDJSON carries (parser events only). */
  parserEvents: number
  lastEventTs: number
  constructionNowMs: number
  /** The `live` flag per event, run-length encoded: `[flag, count]` pairs (header). */
  liveRuns: [boolean, number][]
  modules: { id: string; snapshot: unknown }[]
  combat: unknown
  scopes: { kind: string; id: string; selected: unknown }[]
}

/** Full-fat, exactly as the ticket names it. */
const FULL_OPTS = { maxSegments: 100_000, timeline: true, showUnparsed: true }

/**
 * The scope walk `engineOracle.mts` does, as data instead of text: every ZONE SESSION and every
 * FINALIZED FIGHT resolved through the same `snapshot({selectedId})` door the UI uses, so a
 * change that moved a number the UI shows cannot hide behind an internal field that did not move.
 *
 * UNCAPPED, unlike engineOracle's `FIGHT_DETAIL = 25`. That cap was a reading convenience for a
 * file a human diffs by eye; this file is diffed by a program, and a cap is a hole in an
 * acceptance oracle — a Rust engine could be wrong about fight 26 and pass. `--fight-detail`
 * exists on the CLI for when a slice's walk is too slow to iterate on, and the manifest records
 * what was actually walked so a capped golden can never be mistaken for a complete one.
 */
function walkScopes(combat: CombatEngine, now: number, cap: number): SnapshotGolden['scopes'] {
  const base = combat.snapshot(now, FULL_OPTS)
  const out: SnapshotGolden['scopes'] = []
  for (const zs of base.zoneSessions) {
    out.push({ kind: 'zoneSession', id: zs.id, selected: combat.snapshot(now, { selectedId: zs.id, maxSegments: 1 }).selected })
  }
  let fights = 0
  for (const seg of base.segments) {
    if (seg.kind === 'zone') continue
    if (fights >= cap) break
    fights += 1
    out.push({ kind: 'fight', id: seg.id, selected: combat.snapshot(now, { selectedId: seg.id, maxSegments: 1 }).selected })
  }
  return out
}

/**
 * `updatedAt` — and ONLY `updatedAt` — is dropped, on `tests/replayChunking.test.mts`'s
 * precedent: the message-overlay miner stamps it when the SNAPSHOT is taken, so it is a
 * statement about the reader rather than about what was folded.
 */
export function normalizeJson(value: unknown): string {
  return JSON.stringify(value, (key, v: unknown) => (key === 'updatedAt' ? undefined : v))
}

function buildSnapshots(
  slice: string,
  world: { combat: CombatEngine; registry: ModuleRegistry; moduleIds: string[] },
  meta: { events: number; parserEvents: number; lastTs: number; constructionNowMs: number; liveRuns: [boolean, number][]; fightDetail: number }
): SnapshotGolden {
  return {
    slice,
    events: meta.events,
    parserEvents: meta.parserEvents,
    lastEventTs: meta.lastTs,
    constructionNowMs: meta.constructionNowMs,
    liveRuns: meta.liveRuns,
    modules: world.moduleIds.map((id) => ({ id, snapshot: world.registry.snapshot(id) })),
    combat: world.combat.snapshot(meta.lastTs, FULL_OPTS),
    scopes: walkScopes(world.combat, meta.lastTs, meta.fightDetail)
  }
}

// ------------------------------------------------------------------ the streaming event observers

/** Run-length accumulator for the `live` flag (header). */
class LiveRuns {
  readonly runs: [boolean, number][] = []
  push(live: boolean): void {
    const last = this.runs[this.runs.length - 1]
    if (last && last[0] === live) last[1] += 1
    else this.runs.push([live, 1])
  }
}

/** Buffered `writeSync` sink: one fixed string buffer, flushed when it passes the mark. */
class LineWriter {
  private buf = ''
  private readonly fd: number
  private readonly hash = createHash('sha256')
  constructor(path: string, private readonly mark = 4 << 20) {
    this.fd = openSync(path, 'w')
  }
  line(text: string): void {
    this.buf += text + '\n'
    if (this.buf.length >= this.mark) this.flush()
  }
  private flush(): void {
    if (this.buf.length === 0) return
    const b = Buffer.from(this.buf, 'utf8')
    this.hash.update(b)
    writeSync(this.fd, b)
    this.buf = ''
  }
  close(): string {
    this.flush()
    closeSync(this.fd)
    return this.hash.digest('hex')
  }
}

/** Buffered `readSync` line reader: never holds more than one chunk of the golden. */
class LineReader {
  private readonly fd: number
  private readonly chunk = Buffer.allocUnsafe(1 << 20)
  private tail = ''
  private lines: string[] = []
  private at = 0
  private eof = false
  constructor(path: string) {
    this.fd = openSync(path, 'r')
  }
  /** The next line, or undefined at end of file. */
  next(): string | undefined {
    while (this.at >= this.lines.length) {
      if (this.eof) return undefined
      const n = readSync(this.fd, this.chunk, 0, this.chunk.length, null)
      if (n === 0) {
        this.eof = true
        const rest = this.tail
        this.tail = ''
        this.lines = rest.length > 0 ? [rest] : []
        this.at = 0
        continue
      }
      const text = this.tail + this.chunk.toString('utf8', 0, n)
      const parts = text.split('\n')
      this.tail = parts.pop() ?? ''
      this.lines = parts
      this.at = 0
    }
    return this.lines[this.at++]
  }
  close(): void {
    closeSync(this.fd)
  }
}

// ------------------------------------------------------------------------------------ record/check

export interface FoldOpts {
  slicer?: Slicer
  fightDetail?: number
  /** Where the artifacts live. See `eventsPath` for the one caller that overrides it. */
  goldensDir?: string
}

/** The instant the world is constructed under, and the one the manifest records. See the
 *  `constructionNowMs` header in foldArm.mts for why a pinned clock is needed at all. */
export function constructionClockFor(slice: SliceRef): number {
  return lastTimestampOf(slice.path)
}

/**
 * The last timestamped LINE's epoch millis — a pure function of the bytes, read from the file's
 * tail so it costs nothing. Deliberately NOT the last EVENT's ts: that is only known after a
 * fold, and the clock has to be pinned before the world is built. The two are recorded
 * separately in the golden and are usually equal; they differ when the log's final lines parse
 * to no event, which is a fact about the log and stays visible.
 */
function lastTimestampOf(path: string): number {
  const fd = openSync(path, 'r')
  try {
    const { size } = fstatSync(fd)
    const want = Math.min(size, 1 << 16)
    const buf = Buffer.allocUnsafe(want)
    readSync(fd, buf, 0, want, size - want)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /^\[(.+?)\]/.exec(lines[i])
      if (!m) continue
      // The PARSER'S OWN function, not a copy: this instant has to be the same kind of value the
      // fold stamps its events with, and two spellings of "parse an EQ timestamp" would be a way
      // for the pin and the log to drift apart without anyone noticing.
      const ts = parseEqTimestamp(m[1])
      if (ts > 0) return ts
    }
    throw new Error(`goldenOracle: no timestamped line in the last ${String(want)} bytes of ${path}`)
  } finally {
    closeSync(fd)
  }
}

/** Fold one slice and WRITE both artifacts. Returns what the manifest needs to say about them. */
export async function recordSlice(
  slice: SliceRef,
  opts: FoldOpts = {}
): Promise<{ eventsSha: string; snapshotsSha: string; golden: SnapshotGolden; ms: number }> {
  const t0 = performance.now()
  const constructionNowMs = constructionClockFor(slice)
  const writer = new LineWriter(eventsPath(slice.name, opts.goldensDir))
  const live = new LiveRuns()
  let parserEvents = 0
  const { world, events, lastTs } = await foldForGoldens(characterOf(slice), {
    constructionNowMs,
    slicer: opts.slicer,
    observe: (ev, isLive) => {
      if (!isParserEvent(ev)) return
      parserEvents += 1
      live.push(isLive)
      writer.line(JSON.stringify(ev))
    }
  })
  const eventsSha = writer.close()
  const golden = buildSnapshots(slice.name, world, {
    events,
    parserEvents,
    lastTs,
    constructionNowMs,
    liveRuns: live.runs,
    fightDetail: opts.fightDetail ?? Number.POSITIVE_INFINITY
  })
  const body = normalizeJson(golden)
  writeFileSync(snapshotsPath(slice.name, opts.goldensDir), body)
  const snapshotsSha = createHash('sha256').update(body, 'utf8').digest('hex')
  return { eventsSha, snapshotsSha, golden, ms: performance.now() - t0 }
}

/** The first place a re-fold stopped agreeing with the golden — the whole point of `oracle:check`. */
export interface Divergence {
  slice: string
  where: 'events' | 'snapshots'
  /** Event ordinal (1-based, parser events only) for `events`; absent for `snapshots`. */
  seq?: number
  /** Dotted path into the snapshot artifact — `modules[7].snapshot.state.rows[3].display`. */
  path?: string
  module?: string
  expected: string
  actual: string
}

const short = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s === undefined ? '(absent)' : s.length > 240 ? s.slice(0, 240) + '…' : s
}

/**
 * Fold one slice and COMPARE it against the recorded golden: byte-for-byte for the event stream,
 * deep-equal for the snapshots. Returns the FIRST divergence found, or null.
 *
 * The comparison does not abort the fold. A divergence is latched and the remaining events are
 * folded anyway, because the snapshot half is worth reporting even when the event half already
 * failed — "the stream diverged at event 412,003 AND the buffs module ended up different" is a
 * different diagnosis from "the stream diverged and nothing else did".
 */
export async function checkSlice(slice: SliceRef, opts: FoldOpts = {}): Promise<Divergence[]> {
  const constructionNowMs = constructionClockFor(slice)
  const reader = new LineReader(eventsPath(slice.name, opts.goldensDir))
  const found: Divergence[] = []
  const live = new LiveRuns()
  let n = 0
  try {
    const { world, events, lastTs } = await foldForGoldens(characterOf(slice), {
      constructionNowMs,
      slicer: opts.slicer,
      observe: (ev, isLive) => {
        if (!isParserEvent(ev)) return
        n += 1
        live.push(isLive)
        if (found.length > 0) return
        const want = reader.next()
        const got = JSON.stringify(ev)
        if (want === got) return
        found.push({ slice: slice.name, where: 'events', seq: n, expected: want ?? '(golden ended)', actual: got })
      }
    })
    if (found.length === 0) {
      const extra = reader.next()
      if (extra !== undefined) {
        found.push({ slice: slice.name, where: 'events', seq: n + 1, expected: extra, actual: '(re-fold ended)' })
      }
    }
    const golden = JSON.parse(readFileSync(snapshotsPath(slice.name, opts.goldensDir), 'utf8')) as SnapshotGolden
    const fresh = JSON.parse(
      normalizeJson(
        buildSnapshots(slice.name, world, {
          events,
          parserEvents: n,
          lastTs,
          constructionNowMs,
          liveRuns: live.runs,
          fightDetail: opts.fightDetail ?? Number.POSITIVE_INFINITY
        })
      )
    ) as unknown
    const d = firstDiff(golden as unknown, fresh, '')
    if (d) found.push({ slice: slice.name, where: 'snapshots', path: d.path, module: moduleOf(golden, d.path), expected: short(d.expected), actual: short(d.actual) })
  } finally {
    reader.close()
  }
  return found
}

/** Which module a snapshot path lands in, so the report can name it without the reader counting
 *  array indices — `modules[7].…` becomes `buffs`. */
function moduleOf(golden: SnapshotGolden, path: string): string | undefined {
  // Paths are rooted at '' so every one of them opens with a dot — `.modules[7].snapshot…`.
  const m = /^\.modules\[(\d+)\]/.exec(path)
  if (m) return golden.modules[Number(m[1])]?.id
  return /^\.(combat|scopes)\b/.test(path) ? 'combat engine' : undefined
}

/**
 * The deep-equality walk, re-exported so this file stays the one door every oracle caller already
 * knows (`rustParity.mts`, `goldenCli.mts`). The implementation and its whole argument moved to
 * `src/shared/deepDiff.ts` in JOS-479 — see the import above.
 */
export { firstDiff, type Diff }

/** sha256 of a file, streamed — used by the manifest and by nothing else. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
