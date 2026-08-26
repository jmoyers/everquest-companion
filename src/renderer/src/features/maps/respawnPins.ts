// respawnPins.ts — the RESPAWN-TIMER pin lane: where the mobs you are timing spawn (the fork's
// ask, kaltinril, 2026-08-17: "the map should show the location of any mob on a timer").
//
// A THIRD AUTHORITY joins the surface, and like the first two it is never blurred into them:
// the respawn module's rows are YOUR OWN kills and sightings (src/main/modules/respawn.ts, the
// watch list the Timers tab draws), the wiki catalog is where those mobs SPAWN, and this module
// is the join. The pin says "you have a clock running on a mob that spawns here" — never "the
// mob is standing here" (the reading's own honesty, shared/respawn.ts `RespawnReading.due`).
//
// THE JOIN, in three refusals (all world-model law 1):
//
//   * ZONE FIRST: a timer row carries the raw zone the death was logged in; it is folded to a
//     map stem by `zoneShortName` and rows that fold to a DIFFERENT map — or to none — are not
//     this map's business (the Timers tab's own respawnInZone posture, one authority up).
//   * NAME BY `mobKey`, against `mobsInZone`'s rows — NOT `mobRows`'. The pane's list drops
//     articled commons on purpose (mobPins.ts `isCommonMob`), but a watch on `a froglok knight`
//     is a clock the user explicitly set, and the catalog page for it exists; the map filter
//     must not eat the timer lane's join.
//   * POSITION LAST, by the SAME rules the wiki lane already states: `mobPins` for a page that
//     stated numbers, nothing for one that did not, and nothing for a multi-zone page — which
//     numbers belong to which zone is unknowable, exactly `mobRows`' ambiguity rule.
//
// A row that survives the zone filter but wins no pin is still RETURNED (pins: []), so a
// surface can say "3 timers here, 1 with no stated spawn point" instead of quietly dropping it.
//
// Pure and node-tested (tests/mapTimerPins.test.mts): RELATIVE value imports, the repo rule.

import type { MobEntry } from '@shared/types'
import type { ZoneShort } from '@shared/maps'
import type { RespawnRow } from '@shared/respawn'
import { formatRespawnDuration, respawnReading } from '../../../../shared/respawn'
import { ZONES, zoneShortName } from '../../../../shared/zones'
import { mobKey } from '../../../../shared/mobKey'
import { mobsInZone } from '../mobs/mobZone'
import { mobPins, type MobPin } from './mobPins'

/** One watched mob with a clock running, placed on THIS map. `pins` empty ⇒ no stated spawn. */
export interface TimerPin {
  /** `RespawnRow.id` (`<zone key>::<mob key>`) — unique in the snapshot, the React key. */
  id: string
  /** The name as the death line printed it (law 2: displayed raw). */
  display: string
  /** The whole row, so the surface can read the clock (`respawnReading`) at its own `now`. */
  row: RespawnRow
  pins: MobPin[]
}

/**
 * The catalog side of the join for ONE drawn map: the stem, and its zone's rows keyed by `mobKey`.
 *
 * KEYED ON THE STEM AND NOTHING ELSE. The lane used to take the stem AND the pane's long zone name
 * as two arguments, and MapBody paired `data.zone` with the name of the zone being OPENED — which
 * are different places for the length of a fetch, because useMapData keeps the previous map on
 * screen while the next one loads. Rows filtered by the old map, names indexed from the new zone's
 * catalog: diamonds from the wrong bestiary during every zone switch. Deriving the long name from
 * the stem HERE (the zone table's own spelling — `mobsInZone` folds it exactly as it folds the
 * log's) makes the mismatch unwritable, and lets the hook memoize this walk on the stem alone
 * rather than rebuilding a 7,866-row index on every one-second respawn delta.
 */
export interface TimerZone {
  stem: ZoneShort
  /** `mobKey` → catalog row. The fold shared/mobKey.ts exists for (quote fold, whitespace); a
   *  plain-lowercase join would miss a backticked name. First page wins on a collision. */
  byKey: ReadonlyMap<string, MobEntry>
}

export function timerZone(stem: ZoneShort | null, catalog: MobEntry[]): TimerZone | null {
  if (stem == null) return null
  const name = ZONES.find((z) => z.short === stem)?.name
  // A stem the table does not carry has no bestiary to join — an empty index, not a guess.
  const byKey = new Map<string, MobEntry>()
  if (name !== undefined)
    for (const m of mobsInZone(name, catalog)) {
      const k = mobKey(m.name)
      if (!byKey.has(k)) byKey.set(k, m)
    }
  return { stem, byKey }
}

/**
 * The timer rows that belong to the map on screen, joined to their spawn points. Null-safe on
 * the zone: no map, no lane.
 */
export function timerPinRows(rows: readonly RespawnRow[], zone: TimerZone | null): TimerPin[] {
  if (zone == null || rows.length === 0) return []
  const here = rows.filter((r) => zoneShortName(r.zone) === zone.stem)
  return here.map((r) => {
    const entry = zone.byKey.get(mobKey(r.display))
    // A multi-zone page's numbers cannot be attributed to this map — mobRows' rule, restated
    // here because this lane reads the catalog directly rather than through the pane's rows.
    const pins = entry === undefined || (entry.zones?.length ?? 0) > 1 ? [] : mobPins(entry)
    return { id: r.id, display: r.display, row: r, pins }
  })
}

/** Both strings a timer pin wears, from ONE reading of the clock. */
export interface TimerPinLabels {
  /** The whole sentence — the hover and the native title. */
  text: string
  /** The clock alone — worn under the diamond all the time. */
  clock: string
}

/**
 * What a timer pin says, at `nowMs`, read ONCE: the layer ticks at 1 Hz over every placed pin,
 * and the title, the clock and the hover used to each call `respawnReading` for themselves.
 *
 * `text` leads with the clock because that is what the lane is FOR, and keeps the module's own
 * honesty — an elapsed estimate is "due", never "up"; no estimate admits it. `clock` is the label
 * a timer pin wears all the time (the fork's ask, kaltinril, 2026-08-18: the time until it
 * spawns, on the mob): "due" when it is, "?" when the clock only knows when it started — a
 * duration would be a guess, and the hover already says why.
 */
export function timerPinLabels(t: TimerPin, nowMs: number): TimerPinLabels {
  const r = respawnReading(t.row, nowMs)
  if (r.due) {
    const over = r.overdueMs > 0 ? ` (${formatRespawnDuration(r.overdueMs / 1000)} ago)` : ''
    return { text: `${t.display} - respawn due${over}`, clock: 'due' }
  }
  if (r.remainingMs !== undefined) {
    const left = formatRespawnDuration(r.remainingMs / 1000)
    return { text: `${t.display} - respawns in ${left}`, clock: left }
  }
  // No estimate: the clock only knows when it started. Say that, and nothing more.
  return {
    text: `${t.display} - killed ${formatRespawnDuration(r.elapsedMs / 1000)} ago, no respawn estimate`,
    clock: '?'
  }
}

/** The drawable subset, in row order. Split out so the surface and the tests share the gate. */
export function placeableTimerPins(timers: readonly TimerPin[]): TimerPin[] {
  return timers.filter((t) => t.pins.length > 0)
}
