// respawnPins.ts — the RESPAWN-TIMER pin lane: where the mobs you are timing spawn (user ask,
// 2026-08-17: "the map should show the location of any mob on a timer").
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
import { zoneShortName } from '../../../../shared/zones'
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
 * The timer rows that belong to the map on screen, joined to their spawn points.
 *
 * `zoneStem` is the DRAWN map (`data.zone`); `zoneName` is the same long name the pane's catalog
 * join uses (`mobsInZone` owns the folding, exactly as mobRows says). Both null-safe: no map, no
 * lane.
 */
export function timerPinRows(
  rows: readonly RespawnRow[],
  zoneStem: ZoneShort | null,
  zoneName: string | null,
  catalog: MobEntry[]
): TimerPin[] {
  if (zoneStem == null || zoneName == null || rows.length === 0) return []
  const here = rows.filter((r) => zoneShortName(r.zone) === zoneStem)
  if (here.length === 0) return []
  // The catalog side of the name join, keyed by `mobKey` on BOTH sides — the fold shared/mobKey.ts
  // exists for (quote fold, whitespace); a plain-lowercase join would miss a backticked name.
  const index = new Map<string, MobEntry>()
  for (const m of mobsInZone(zoneName, catalog)) {
    const k = mobKey(m.name)
    if (!index.has(k)) index.set(k, m)
  }
  return here.map((r) => {
    const entry = index.get(mobKey(r.display))
    // A multi-zone page's numbers cannot be attributed to this map — mobRows' rule, restated
    // here because this lane reads the catalog directly rather than through the pane's rows.
    const pins = entry === undefined || (entry.zones?.length ?? 0) > 1 ? [] : mobPins(entry)
    return { id: r.id, display: r.display, row: r, pins }
  })
}

/**
 * What a timer pin says, at `nowMs`. Leads with the clock because that is what the lane is FOR;
 * the wording keeps the module's own honesty — an elapsed estimate is "due", never "up".
 */
export function timerPinText(t: TimerPin, nowMs: number): string {
  const r = respawnReading(t.row, nowMs)
  if (r.due) {
    const over = r.overdueMs > 0 ? ` (${formatRespawnDuration(r.overdueMs / 1000)} ago)` : ''
    return `${t.display} - respawn due${over}`
  }
  if (r.remainingMs !== undefined) {
    return `${t.display} - respawns in ${formatRespawnDuration(r.remainingMs / 1000)}`
  }
  // No estimate: the clock only knows when it started. Say that, and nothing more.
  return `${t.display} - killed ${formatRespawnDuration(r.elapsedMs / 1000)} ago, no respawn estimate`
}

/**
 * The clock ALONE — the label a timer pin wears all the time (user ask, 2026-08-18: the time
 * until it spawns, on the mob), where the hover still tells the whole `timerPinText` story.
 * "due" when it is; "?" when the clock only knows when it started — a duration would be a guess,
 * and the hover already says why.
 */
export function timerPinClock(t: TimerPin, nowMs: number): string {
  const r = respawnReading(t.row, nowMs)
  if (r.due) return 'due'
  return r.remainingMs === undefined ? '?' : formatRespawnDuration(r.remainingMs / 1000)
}

/** The drawable subset, in row order. Split out so the surface and the tests share the gate. */
export function placeableTimerPins(timers: readonly TimerPin[]): TimerPin[] {
  return timers.filter((t) => t.pins.length > 0)
}
