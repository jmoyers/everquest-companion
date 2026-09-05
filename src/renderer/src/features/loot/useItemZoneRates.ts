// useItemZoneRates — the item drill-down's per-zone drop rates (JOS-78).
//
// It joins TWO modules that already exist and adds no third store: the `loot` history supplies the
// drops (each row already carrying the zone it happened in — see lootRates.ts rule 1), and the
// `progression` snapshot supplies the DENOMINATOR, through the very same `rangeStats` query the
// Leveling tab's range panel reads. Nothing here divides anything by anything; `lootRates.ts` does
// the arithmetic and this hook only decides WHICH RANGE.
//
// THE RANGE IS THE CALLER'S SLICE, AND THE WHOLE RECORD WHEN THERE IS NONE (JOS-130). This
// drill-down still invents no scope of its own — it now FOLLOWS the app's one timeslice control
// when the surface it was opened from has one (the Loot ledger, which already cut the `events` it
// hands in), and falls back to `dataBounds` end to end for the Mobs tab's dialog, which opens over
// a page that carries no control. Either way the same `+1 ms` tail `windowScope.statsRangeFor`
// uses keeps the newest event inside a half-open range.
//
// THE DENOMINATOR AND THE NUMERATOR COME FROM ONE SLICE OR NEITHER. `events` is cut by the caller
// and the zone rows are queried here; handing in a sliced numerator and asking for a whole-record
// denominator would read as a farm that fell off a cliff.
//
// WHAT IT DOES NOT DO: it never consults the wiki's `dropsFrom`. Those rows are elsewhere on this
// page, chipped `db`, answering the same question from the committed catalog — and blending them
// into a rate would put a number this character never observed under an `observed` heading.

import { useMemo } from 'react'
import type { LootEvent, ProgressionSnap } from '@shared/types'
import type { Timeslice } from '@shared/timeslice'
import { rangeStats } from '@shared/progressionStats'
import { itemZoneRows, type ItemZoneRow } from '@shared/lootRates'
import { useModule } from '../../lib/useModule'
import { EMPTY_PROGRESSION } from '../leveling/progressionDelta'
import { dataBounds } from '../leveling/zoneBands'

/** The same one-millisecond tail `windowScope.ts` documents: `rangeStats` ranges are half-open,
 *  and the newest loot line in the log is stamped at `bounds.hi` exactly. */
const TAIL_MS = 1

export interface ItemZoneRates {
  rows: ItemZoneRow[]
  /**
   * True when the range reached below the analytics module's capped window — the same `clipped`
   * flag the range panel surfaces. Drops older than that window keep their own timestamps but
   * have no span to divide by, so their rows are honest counts with an em-dash rate.
   */
  clipped: boolean
}

const NO_ROWS: ItemZoneRates = { rows: [], clipped: false }

/** The zone half of a slice as `rangeStats` takes it — both keys or neither, so a drill-down can
 *  never be scoped to the place by one of them and to the tier by the other. */
function zoneOf(slice: Timeslice | undefined): { zoneKey: string | null; zoneExactKey: string | null } {
  return { zoneKey: slice?.zoneKey ?? null, zoneExactKey: slice?.zoneExactKey ?? null }
}

/**
 * This item's zones, drops and per-hour-of-active-time rates over the character's whole record.
 *
 * `events` must already be filtered to the item (the pane holds that filter for its other
 * columns too). An empty list short-circuits to no rows — a never-looted item asks the
 * progression snapshot nothing.
 */
export function useItemZoneRates(events: readonly LootEvent[], slice?: Timeslice): ItemZoneRates {
  const prog = useModule<ProgressionSnap>('progression') ?? EMPTY_PROGRESSION
  return useMemo(() => {
    if (events.length === 0) return NO_ROWS
    const bounds = dataBounds(prog, [])
    const range = slice?.range ?? (bounds ? { t0: bounds.lo, t1: bounds.hi + TAIL_MS } : null)
    // No record at all ⇒ no zone rows, so every rate is null and every count is still true.
    // BOTH halves of the zone membership, absent-as-null either way (JOS-130 / JOS-291).
    const stats = range ? rangeStats({ snap: prog, range, ...zoneOf(slice) }) : null
    return { rows: itemZoneRows({ events, zones: stats?.zones ?? [] }), clipped: stats?.clipped ?? false }
  }, [events, prog, slice])
}
