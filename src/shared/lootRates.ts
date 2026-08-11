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

import type { LootEvent } from './types'
import type { ZoneRangeRow } from './progressionStats'
import { zoneIdKey } from './progressionStats'
// The slice's MEMBERSHIP fold — coarser than the join's on purpose (see `WindowItemArgs.zoneKey`
// and `RangeStatsArgs.zoneKey`). The JOIN below still runs on `zoneIdKey`, which is rule 2.
import { zoneKey } from './zones'

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
  for (const e of events) {
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
   * The scope's ACTIVE ms — `RangeStats.activeMs`, the denominator every other rate on the
   * Leveling tab already divides by. Passed in rather than re-derived: a second active-time
   * derivation is precisely what windowScope.ts exists to prevent.
   */
  activeMs: number
  /**
   * The slice's zone restriction (JOS-130) — a `shared/zones.zoneKey` fold (the MEMBERSHIP fold,
   * which strips instance noise), or null/absent for every zone.
   *
   * It must be applied HERE and not by the caller, because `activeMs` above already is the zone's
   * own active time when the slice carries one: counting every zone's drops against one zone's
   * hours is the exact mismatch rule 2 exists to prevent. A row with NO zone belongs to the
   * `unknown` stretch and so matches only a filter for `unknown`.
   */
  zoneKey?: string | null
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
  const { events, t0, t1, activeMs } = args
  const rows = new Map<string, WindowItemRow>()
  for (const e of events) {
    if (e.ts < t0 || e.ts >= t1) continue
    if (args.zoneKey != null && zoneKey(e.zone ?? UNKNOWN_ZONE) !== args.zoneKey) continue
    const key = e.item.toLowerCase()
    let row = rows.get(key)
    if (!row) {
      row = { key, item: e.item, drops: 0, events: 0, dropsPerHourActive: null, firstTs: e.ts, lastTs: e.ts }
      rows.set(key, row)
    }
    row.drops += dropsOf(e)
    row.events += 1
    row.firstTs = Math.min(row.firstTs, e.ts)
    row.lastTs = Math.max(row.lastTs, e.ts)
  }
  const out = [...rows.values()]
  for (const row of out) row.dropsPerHourActive = perHour(row.drops, activeMs)
  return out.sort((a, b) => b.drops - a.drops || b.lastTs - a.lastTs || a.item.localeCompare(b.item))
}
