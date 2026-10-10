// maps/MapZoneAdvice — "where should I be", for one level and one reason, as a table.
//
// Owner asks (kaltinril 2026-09-11, -12): *"somewhere it shows recommendation for where to level,
// where to get motes"*, then *"different level ranges for different stuff - D4 mote farming, or
// best EXP or best gear, or most wishlist items in a single zone"*, then, of the first table:
// *"this is a horrible gridview ... need filters/search/sort"*.
//
// `shared/zoneAdvice.ts` carries the three rankings, the measurements behind them, and why "best
// gear" is not one of them yet. This file owns the state and composes two neighbours in the Gear
// tab's arrangement: `MapZoneAdviceBar` (level, goal, search, fit filter) over
// `MapZoneAdviceTable` (sortable heads, windowed fixed-height rows).
//
// ── NOTHING IS FILTERED OR SORTED HERE (ruling 4) ────────────────────────────────────────────
//
// The bar's search and fit chips go INTO `rankZones` as options and the header's sort goes into
// `sortAdvice`; this file asks for the rows it wants and windows what comes back. That is the
// same seam `GearView` keeps with `filterGearRows` / `sortGearRows`, and it is what lets the
// ranking be tested without a renderer.
//
// ── THE RIGHT-HAND COLUMN IS THE GOAL'S, AND SOMETIMES THERE ISN'T ONE ───────────────────────
//
// The first version printed the mote rate on every row, and the owner's screenshot showed why
// that was noise: at one level every listed zone cons the same and every row said 8.5. So the
// column is the goal's own driver - the rate for experience (where green's 3.1 against 8.5 is
// the whole point), the wished-item count for the wish list - and the mote goal has NO extra
// number, because its driver is the fit chip and the band already on the row.

import { useMemo, useRef, useState, type JSX } from 'react'
import { Paper, Typography } from '@mui/material'
import { nextAdviceSort, rankZones, sortAdvice, type AdviceSort, type ZoneGoal } from '@shared/zoneAdvice'
import type { ProgressionSnap } from '@shared/types'
import { useModule } from '../../lib/useModule'
import { useWindowedRows } from '../../lib/useWindowedRows'
import { EMPTY_PROGRESSION } from '../leveling/progressionDelta'
import { useStatedLevel } from '../leveling/useStatedLevel'
import { useWishlist } from '../wishlist/useWishlist'
import MapZoneAdviceBar, { DEFAULT_QUERY, type AdviceQuery } from './MapZoneAdviceBar'
import MapZoneAdviceTable, { ROW_HEIGHT } from './MapZoneAdviceTable'
import { saveTravelEra, useTravelEra } from './useMapData'
import { wishedByZone, zoneBands } from './zoneBands'
import { GOALS } from './zoneAdviceUi'

/**
 * Zones the catalog knows through fewer than this many mobs are held back.
 *
 * Not a quality judgement about the zone — a judgement about OUR EVIDENCE. A band drawn from three
 * documented mobs will happily rank first and be wrong, and there is no way for the reader to tell
 * from the row. Eight is the point where the percentile band stops swinging on one entry.
 */
const MIN_EVIDENCE = 8

/** What an empty table means depends on which table it is. */
function emptyText(goal: ZoneGoal, level: number, haveWishes: boolean, narrowed: boolean): string {
  if (!Number.isFinite(level) || level <= 0) return 'Type a level to see the zones the bestiary can describe for it.'
  if (narrowed) return 'Nothing matches the search and filters.'
  if (goal === 'wish') {
    return haveWishes
      ? 'Nothing on your wish list drops in a zone the bestiary documents.'
      : 'Your wish list is empty - add items on the Gear tab and this will rank the zones that drop them.'
  }
  return 'The bestiary documents no zone that fits this level for this goal.'
}

export default function MapZoneAdvice({ onPick }: { onPick?: (zone: string) => void }): JSX.Element {
  // The era switch is the Closest-port card's, read live from the one value both surfaces share
  // (`useTravelEra`) rather than copied here, so the two cannot disagree about what EQ Legends has.
  const [stored, setQueryState] = useState<AdviceQuery>(DEFAULT_QUERY)
  const eraOnly = useTravelEra()
  // THE LEVEL STARTS AS YOURS (owner, 2026-09-14: *"why does it not default the LEVEL to my
  // current character's level"*) - the stated level the Leveling tab and the identity chip read,
  // so it follows a ding - and becomes the typed one the moment a different number is typed. The
  // field stays a field: planning for an alt or a friend is still one edit away, and the first cut
  // that started at 20 for that reason made everyone pay for it. `typed` is what tells the two
  // apart, because a goal or filter change also passes through `onChange` and must not freeze the
  // level at whatever it showed.
  const [typed, setTyped] = useState(false)
  const stated = useStatedLevel(useModule<ProgressionSnap>('progression') ?? EMPTY_PROGRESSION).level
  const query: AdviceQuery = { ...(typed || stated === null ? stored : { ...stored, level: String(stated) }), eraOnly }
  const setQuery = (next: AdviceQuery): void => {
    if (next.eraOnly !== query.eraOnly) saveTravelEra(next.eraOnly)
    if (next.level !== query.level) setTyped(true)
    setQueryState(next)
  }
  // null = the goal's own order, which is the honest default and lights no column.
  const [sort, setSort] = useState<AdviceSort | null>(null)
  const level = Number.parseInt(query.level, 10)

  // The wish list is the one input that is the PLAYER's rather than the catalog's; the per-zone
  // count is one walk of the bestiary, redone only when the list itself changes.
  const wishlist = useWishlist().list
  const wished = useMemo(
    () => wishedByZone(new Set(wishlist.entries.map((e) => e.itemKey))),
    [wishlist.entries]
  )

  const rows = useMemo(() => {
    if (!Number.isFinite(level) || level <= 0) return []
    const ranked = rankZones(zoneBands(), level, {
      goal: query.goal,
      min: MIN_EVIDENCE,
      wished,
      fits: query.fits,
      search: query.search,
      eraOnly: query.eraOnly
    })
    return sort === null ? ranked : sortAdvice(ranked, sort)
  }, [level, query.goal, query.fits, query.search, query.eraOnly, wished, sort])

  const scrollRef = useRef<HTMLDivElement>(null)
  const win = useWindowedRows({ count: rows.length, rowHeight: ROW_HEIGHT, scrollRef })
  const narrowed = query.search.trim() !== '' || query.fits.size > 0

  return (
    <Paper
      variant="outlined"
      data-testid="zone-advice"
      sx={{ p: 1, display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}
    >
      <MapZoneAdviceBar query={query} onChange={setQuery} count={rows.length} />
      {rows.length === 0 ? (
        <Typography variant="body2" color="text.disabled" data-testid="zone-advice-empty" sx={{ p: 2 }}>
          {emptyText(query.goal, level, wishlist.entries.length > 0, narrowed)}
        </Typography>
      ) : (
        <MapZoneAdviceTable
          rows={rows}
          win={win}
          sort={sort}
          column={GOALS[query.goal].column}
          scrollRef={scrollRef}
          onSort={(key) => {
            setSort(nextAdviceSort(sort, key))
          }}
          onPick={onPick}
        />
      )}
    </Paper>
  )
}
