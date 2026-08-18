// lootRates.ts — WHERE AND HOW OFTEN AN ITEM DROPS FOR YOU (JOS-78).
//
// Two pure derivations over the loot history the `loot` module already folds, and nothing else:
//
//   • `itemZoneRows` — one item, every zone you have looted it in, with a drops-per-hour rate
//     whose denominator is that zone's own ACTIVE time. The item drill-down's table.
//   • `windowItemRows` — one stretch of time, every item that dropped inside it, ordered by how
//     many you observed. The Leveling tab's in-scope panel (JOS-75's windowScope feeds the range).
//
// Pure: no React, no DOM, no Electron, no clock read. The one VALUE import is relative
// (`./progressionStats`) so tests/lootRates.test.mts can import this file straight under tsx —
// the node runner has no `@shared/*` alias (the mobSearch.ts precedent, repo-wide).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE FOUR RULES
//
//   1. THE ZONE IS RECORDED, NOT DERIVED — and this file must never re-derive it. `LootModule`
//      (src/main/modules/loot.ts) stamps each row with the zone it was standing in when the loot
//      line printed, from the same `zone` event the progression module's spans are built from. So
//      the join here is on a NAME the loot row already carries, and the only thing read out of
//      the zone timeline is the DENOMINATOR (`ZoneRangeRow.activeMs`). Nothing is stored twice
//      and no second zone attribution exists to drift.
//
//      A row with NO zone is the pre-first-zone-line remainder, and it joins the `unknown` row —
//      which is exactly what `zoneSegments` calls the same stretch of time. The two agree by
//      construction rather than by coincidence.
//
//   2. ONE FOLD, THE ROWS' OWN. `rangeStats` groups its zone rows with `zoneIdKey`, so that is
//      the fold this join uses (imported, never re-spelled). Anything else — the renderer's
//      instance-noise-stripping `zoneKey`, a trim-only compare — would put drops in one bucket
//      and their active time in another.
//
//   3. A RATE CARRIES ITS SPAN, AND UNKNOWN IS NOT ZERO. Every row hands back the `activeMs` it
//      was measured over so the surface can state it; a rate over no active time is `null`, never
//      0.0 (the em-dash rule this repo's rate vocabulary already runs on). One drop in five
//      minutes is 12/hr and the row says "over 5m active" beside it — the number is honest, the
//      sample is small, and the reader is told which.
//
//   4. A DROP IS A STACK, NOT A LINE. `--You have looted 2 Bone Chips …--` is two items, and the
//      loot ledger's group counts have said so since Task #47 (`lootGrouping.ts`). These counts
//      are the same quantity, so "220 motes" means the same thing on both surfaces. The LINE
//      count rides along separately as `events` for anything that needs "how many times".
//
//   5. A LOOT RATE HAS TWO HONEST DENOMINATORS, AND THE LEDGER STATES BOTH (JOS-261). Active time
//      answers "how fast is this camp paying while I am working it"; it is also the denominator a
//      0.23.0 reporter said reads INFLATED, because every gap under five minutes — the regen sit
//      between pulls — stays inside it. The wall denominator answers the other half of the same
//      question, "how fast is this camp paying per hour of my evening", and the two together are
//      the only pair that cannot be mistaken for each other. So `windowLootRates` divides once by
//      each and hands back both, each beside the span it was measured over; a surface that shows
//      one alone must say WHICH one, in the words `lootRateText.ts` already spells.
//      SINCE JOS-288 `windowItemRows` does the same PER ITEM — the XP overlay's mote rows are the
//      caller that needed it, and a row carrying only the half its first caller printed is how the
//      second caller ends up on a quietly different denominator.
//
//      THE WALL DENOMINATOR IS THE ONE THIS REPO ALREADY HAS: `durationMs - offlineMs`, exactly
//      `RangeStats.levelsPerHourWall`'s (see that field). A logout the log CLOSED with a login
//      line is carved out and nothing else is — medding, banking and travelling stay in, because
//      you spent them — so an overnight in an `All` slice cannot drive the number toward zero and
//      make it arithmetic about an empty chair. A second definition of "wall" here would be world
//      -model law 12's drift with a clock in it.

import type { LootEvent } from './types'
import { isAcquisition, isDestroyed } from './lootDisposition'
import type { ZoneRangeRow } from './progressionStats'
// `wallMs` is rule 5's denominator as a function (JOS-288): the subtraction below used to be
// spelled out here, and once the AA rates and the XP overlay needed the same one, a per-file
// spelling became the drift law 12 warns about. Imported, never re-typed.
import { wallMs } from './progressionStats'
// The slice's MEMBERSHIP test — coarser than the join's on purpose, and since JOS-291 a CHOICE
// between this app's two zone folds (see `WindowItemArgs.zoneKey` / `.zoneExactKey` and
// `shared/zoneScope.ts`). The JOIN below still runs on `zoneIdKey`, which is rule 2.
import { zoneAdmits, zoneIdKey } from './zoneScope'

const MS_PER_HOUR = 3_600_000

/** The row time before the first zone line falls in — `progressionStats`' own spelling. */
export const UNKNOWN_ZONE = 'unknown'

/** A rate per hour, or null when there is no time to divide by. Rule 3. */
function perHour(amount: number, windowMs: number): number | null {
  return windowMs > 0 ? amount / (windowMs / MS_PER_HOUR) : null
}

/** Stack-aware drop count for one loot line. Rule 4. */
function dropsOf(e: LootEvent): number {
  return e.count ?? 1
}

/**
 * IS THIS ROW INSIDE THE WINDOW — the ONE membership test both window derivations run.
 *
 * Half-open `[t0, t1)` exactly like `rangeStats`, and the zone half is `zoneScope.zoneAdmits` —
 * the same predicate `timeslice.inSlice` and `rangeStats` apply to the very same rows, so the
 * exact-tier choice (JOS-291) reaches the ledger through one function rather than three copies.
 * Extracted (JOS-261) rather than written a second time for the totals: the ledger's caption states
 * a count and a rate over one slice, and two spellings of "inside" is how those two stop agreeing.
 *
 * `zk` bundles both keys because `max-params` is 4 and because they travel together by rule.
 */
function inWindow(e: LootEvent, t0: number, t1: number, zk: ZoneFilter): boolean {
  // A DESTROY IS NOT A DROP (JOS-401, the census). The destroy line rides the loot lane so held
  // counts can subtract it, and this file is the ONE membership test every rate derivation here
  // runs — item-zone rows, mote rates, the leveling window's drop rows and the XP overlay all come
  // through it — so refusing it once here is what keeps a bag cleanup out of every drops-per-hour
  // in the app. It is also the only refusal that has to be explicit: the mob-side drop knowledge
  // (main/mobLookupParse.ts) is immune already, because a destroy names no mob.
  if (isDestroyed(e)) return false
  if (e.ts < t0 || e.ts >= t1) return false
  return zoneAdmits(e.zone ?? UNKNOWN_ZONE, zk.zoneKey, zk.zoneExactKey)
}

/** The zone half of a slice, as every window derivation here reads it (JOS-130 / JOS-291). */
interface ZoneFilter {
  zoneKey?: string | null
  zoneExactKey?: string | null
}

/** One zone this item has dropped in, for you. */
export interface ItemZoneRow {
  /** The `zoneIdKey` fold — React key and the identity the join ran on. */
  key: string
  /** RAW display name, first-seen casing (law 2: canonicalize at boundaries, display raw). */
  zone: string
  /** Σ stack sizes (rule 4) — the same quantity the loot ledger's group count states. */
  drops: number
  /** Loot LINES. Differs from `drops` exactly when something dropped in stacks. */
  events: number
  /**
   * ACTIVE ms you spent in this zone over the queried range, from `ZoneRangeRow.activeMs`.
   *
   * 0 when the zone is not in the range's zone rows at all — which is a real state, not a bug:
   * the progression module's zone column is capped drop-oldest, so a drop older than the analytics
   * window has its own timestamp but no span to divide by. The rate is then null and the surface
   * says so, rather than inventing a denominator.
   */
  activeMs: number
  /** Wall ms of the range spent here (`ZoneRangeRow.spanMs`) — context beside the active half. */
  spanMs: number
  /** Drops per hour of ACTIVE time in this zone. Null when `activeMs` is 0 (rule 3). */
  dropsPerHourActive: number | null
  firstTs: number
  lastTs: number
}

export interface ItemZoneArgs {
  /** This item's loot events — already filtered to the item by the caller. */
  events: readonly LootEvent[]
  /** The zone rows of the range the rates are measured over (`RangeStats.zones`). */
  zones: readonly ZoneRangeRow[]
}

/**
 * Where this item drops for you, and how often per hour you actually played there.
 *
 * Ordered by observed drops descending, then by active time descending, then by name — a total
 * order, so the table never reshuffles between renders on ties. NO invented ranking: nothing is
 * scored, weighted or thresholded, and a zone you looted it in once is a row exactly like a zone
 * you looted it in fifty times.
 *
 * The `zones` argument decides the DENOMINATORS and never the membership: a zone with active time
 * but no drop of this item is not a row here (the question is "where does it drop", not "where
 * have I been").
 */
export function itemZoneRows(args: ItemZoneArgs): ItemZoneRow[] {
  const { events, zones } = args
  const spans = new Map<string, ZoneRangeRow>()
  for (const z of zones) spans.set(zoneIdKey(z.zone), z)

  const rows = new Map<string, ItemZoneRow>()
  // The same refusal `inWindow` makes for the two windowed derivations (JOS-401) — this one takes
  // its rows pre-filtered by the caller and cut to one item, so it states the rule itself. Spelled
  // as a filter rather than as a `continue` because the loop below is at its measured branch
  // ceiling and this is not a per-row decision the body should have to re-read.
  for (const e of events.filter(isAcquisition)) {
    const name = e.zone ?? UNKNOWN_ZONE
    const key = zoneIdKey(name)
    let row = rows.get(key)
    if (!row) {
      const span = spans.get(key)
      row = {
        key,
        // The zone row's spelling wins when there is one — it is the first-seen casing of the
        // whole record, while a loot row only knows its own line.
        zone: span?.zone ?? name,
        drops: 0,
        events: 0,
        activeMs: span?.activeMs ?? 0,
        spanMs: span?.spanMs ?? 0,
        dropsPerHourActive: null,
        firstTs: e.ts,
        lastTs: e.ts
      }
      rows.set(key, row)
    }
    row.drops += dropsOf(e)
    row.events += 1
    row.firstTs = Math.min(row.firstTs, e.ts)
    row.lastTs = Math.max(row.lastTs, e.ts)
  }

  const out = [...rows.values()]
  for (const row of out) row.dropsPerHourActive = perHour(row.drops, row.activeMs)
  return out.sort((a, b) => b.drops - a.drops || b.activeMs - a.activeMs || a.zone.localeCompare(b.zone))
}

/** One item observed dropping inside a window. */
export interface WindowItemRow {
  /** Lowercased item name — the loot ledger's own grouping identity (`lootGrouping.ts` itemKey),
   *  so `Sphinx Claw +1` keeps its own row here exactly as it does there. */
  key: string
  /** RAW display name, first-seen casing. What the drill-down is opened on. */
  item: string
  /** Σ stack sizes inside the window (rule 4). */
  drops: number
  /** Loot LINES inside the window. */
  events: number
  /** Drops per hour of the window's ACTIVE time. Null when the window has none (rule 3). */
  dropsPerHourActive: number | null
  /**
   * Drops per hour of the window's ONLINE WALL time (`wallMs`) — rule 5's other denominator, per
   * item (JOS-288). Null when the window is entirely offline (rule 3).
   *
   * BOTH ARE ALWAYS COMPUTED, exactly as `windowLootRates` computes both: rule 5 says the pair is
   * what makes neither reading mistakable for the other, and a row that carried only the half its
   * first caller happened to print is how the second caller gets a subtly different denominator.
   */
  dropsPerHourWall: number | null
  firstTs: number
  lastTs: number
}

export interface WindowItemArgs {
  /** The whole loot history. Filtered here, so the caller never has to state the range twice. */
  events: readonly LootEvent[]
  /** The scope's instants — `ScopedStats.range`, half-open at the top like `rangeStats`. */
  t0: number
  t1: number
  /**
   * The scope's spans — `rangeStats(...)` for THIS window, assignable verbatim (`WindowSpans`).
   *
   * Passed in rather than re-derived: a second active-time derivation is precisely what
   * windowScope.ts exists to prevent. It is the WHOLE spans object rather than a bare `activeMs`
   * (JOS-288) for the same reason `windowLootRates` takes one — the two denominators travel
   * together or they drift apart.
   */
  spans: WindowSpans
  /**
   * The slice's zone restriction (JOS-130) — a `shared/zones.zoneKey` fold (the MEMBERSHIP fold,
   * which strips instance noise), or null/absent for every zone.
   *
   * It must be applied HERE and not by the caller, because `spans` above is already the zone's
   * own time when the slice carries one: counting every zone's drops against one zone's
   * hours is the exact mismatch rule 2 exists to prevent. A row with NO zone belongs to the
   * `unknown` stretch and so matches only a filter for `unknown`.
   */
  zoneKey?: string | null
  /**
   * …AND ONLY THE TIER THE SLICE NAMES (JOS-291) — a `zoneScope.zoneIdKey` fold, or null/absent for
   * every tier of the place, which is byte-identical to the read this function has always done.
   *
   * It rides here for `zoneKey`'s reason and it must not be applied by the caller either: `spans`
   * is the EXACT TIER's own time when the slice carries one, so counting the whole camp's drops
   * against one tier's hours is rule 2's mismatch with a difficulty number on it.
   */
  zoneExactKey?: string | null
}

/**
 * What dropped in this stretch of the log, most-observed first.
 *
 * ORDERING IS THE OBSERVATION AND NOTHING ELSE (the ticket's rule): drops descending, then the
 * most recent, then the name. Motes float to the top because you loot a lot of them, not because
 * anything here knows what a mote is worth — nothing in this repo ranks the ten tiers, and a
 * per-tier weighting would be an invented fact (AGENTS.md's mote note).
 *
 * The membership test is the ROW'S OWN TIMESTAMP against `[t0, t1)`, matching `rangeStats`'
 * half-open convention exactly (`windowScope.statsRangeFor` already pushes a window's end one ms
 * past the newest event so the live edge is inside every scope).
 */
export function windowItemRows(args: WindowItemArgs): WindowItemRow[] {
  const { events, t0, t1, spans } = args
  const wall = wallMs(spans)
  const rows = new Map<string, WindowItemRow>()
  for (const e of events) {
    if (!inWindow(e, t0, t1, args)) continue
    const key = e.item.toLowerCase()
    let row = rows.get(key)
    if (!row) {
      row = {
        key,
        item: e.item,
        drops: 0,
        events: 0,
        dropsPerHourActive: null,
        dropsPerHourWall: null,
        firstTs: e.ts,
        lastTs: e.ts
      }
      rows.set(key, row)
    }
    row.drops += dropsOf(e)
    row.events += 1
    row.firstTs = Math.min(row.firstTs, e.ts)
    row.lastTs = Math.max(row.lastTs, e.ts)
  }
  const out = [...rows.values()]
  for (const row of out) {
    row.dropsPerHourActive = perHour(row.drops, spans.activeMs)
    row.dropsPerHourWall = perHour(row.drops, wall)
  }
  return out.sort((a, b) => b.drops - a.drops || b.lastTs - a.lastTs || a.item.localeCompare(b.item))
}

/**
 * THE SPANS A WINDOW'S RATES DIVIDE BY — `RangeStats`' three time columns, taken as a plain shape.
 *
 * A shape rather than the whole `RangeStats` so this file keeps its TYPE-only dependency on
 * `progressionStats` and a test can state three numbers instead of building a snapshot; the three
 * fields are named exactly as that interface names them, so the caller's `rangeStats(...)` answer
 * is assignable verbatim and nothing has to be re-spelled on the way in.
 */
export interface WindowSpans {
  /** The window's WALL clock — Σ of the zone's own visits when the slice carries a zone. */
  durationMs: number
  /** `durationMs` minus idle minus offline (`RangeStats.activeMs`). */
  activeMs: number
  /** The logouts the log CLOSED with a login line. Carved out of the wall denominator (rule 5). */
  offlineMs: number
}

/** What dropped in a window, and how fast — over BOTH denominators (rule 5). */
export interface WindowLootRates {
  /** Σ stack sizes inside the window (rule 4) — the numerator of both rates. */
  drops: number
  /** Loot LINES inside the window. Differs from `drops` exactly when something dropped in stacks. */
  events: number
  /** The ACTIVE denominator, restated so a surface can print the span beside the rate it made. */
  activeMs: number
  /** The WALL denominator: `durationMs - offlineMs`, never negative (rule 5). */
  wallMs: number
  /** Drops per hour of active time. Null when there is no active time (rule 3). */
  dropsPerHourActive: number | null
  /** Drops per hour of online wall time. Null when the window is entirely offline (rule 3). */
  dropsPerHourWall: number | null
}

export interface WindowRatesArgs {
  /** The whole loot history. Filtered here, exactly as `windowItemRows` filters it. */
  events: readonly LootEvent[]
  /** The window's instants, half-open at the top like `rangeStats`. */
  t0: number
  t1: number
  /** `rangeStats(...)` for THIS window — the same object, never a second query over a wider one. */
  spans: WindowSpans
  /** The slice's zone restriction (a `shared/zones.zoneKey` fold), or null/absent for every zone.
   *  Applied HERE for `windowItemRows`' reason: `spans` is already the zone's own time. */
  zoneKey?: string | null
  /** …and its tier restriction (a `zoneScope.zoneIdKey` fold, JOS-291), or null/absent for every
   *  tier of the place. Same reason it cannot be applied by the caller. */
  zoneExactKey?: string | null
}

/**
 * HOW FAST THIS STRETCH OF PLAY IS PAYING, said twice so neither reading can pass for the other.
 *
 * The numerator is the window's drops (stack-aware, rule 4); the denominators are the window's own
 * active time and its own online wall time, and both are handed back beside the rates they made so
 * a caption can state the span rather than imply it. Nothing is ranked, weighted or thresholded —
 * this is one division per denominator over counts the loot module already folded.
 *
 * `drops === 0` is a MEASURED zero and prints as one: unlike a missing denominator it is a fact
 * about the window ("you looted nothing in this hour"), which is why only the rates are nullable.
 */
export function windowLootRates(args: WindowRatesArgs): WindowLootRates {
  const { events, t0, t1, spans } = args
  let drops = 0
  let lines = 0
  for (const e of events) {
    if (!inWindow(e, t0, t1, args)) continue
    drops += dropsOf(e)
    lines += 1
  }
  const wall = wallMs(spans)
  return {
    drops,
    events: lines,
    activeMs: spans.activeMs,
    wallMs: wall,
    dropsPerHourActive: perHour(drops, spans.activeMs),
    dropsPerHourWall: perHour(drops, wall)
  }
}
