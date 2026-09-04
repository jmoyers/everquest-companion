// The RESPAWN-TIMER pin layer — the third authority's own symbol (respawnPins.ts is the join
// and carries the three refusals; nothing here decides who is placed).
//
// A THIRD, CLEARLY DIFFERENT SYMBOL, for the same reason the wiki pins are not the map file's
// dots (MapMobPins.tsx): a mark must say where it came from. The map file's labels keep the
// pack author's colours, the bestiary's pins are warning-toned teardrops, and a running clock
// is a DIAMOND in the theme's error tone — the kill lane's colour, which is what a respawn
// timer is about. It draws slightly smaller than the wiki teardrop and above it, so a watched
// named mob shows both: the teardrop says "spawns here", the diamond over it says "and your
// clock is running".
//
// THE TEXT IS A CLOCK, so the layer ticks. `useSecondsClock` is the Timers tab's own 1 Hz
// re-render (one shared cadence, never a second timer per pin); the snapshot itself pushes no
// per-second updates — `respawnReading` derives everything from `baseTs` against the local now,
// exactly as every other respawn surface does.
//
// INERT TO DRAGS like the other overlay layers: `pointerEvents:'none'` on the container,
// re-enabled per pin — but a timer pin has NO click. Its answers (confirm the sighting, edit
// the estimate, unwatch) all live on the Timers tab, and a pin that silently duplicated one of
// them would be a second copy of that surface's state. Hover names the mob and reads the clock;
// that is the whole contract.

import { useMemo, useState, type JSX } from 'react'
import { useTheme } from '@mui/material'
import type { ZoneShort } from '@shared/maps'
import { MOB_CATALOG } from '../mobs/mobSearch'
import { useRespawnSnap, useSecondsClock } from '../timers/useRespawn'
import { PinHoverCard, pinTextStyle } from './mapPinChrome'
import { placeableTimerPins, timerPinLabels, timerPinRows, timerZone, type TimerPin } from './respawnPins'
import type { MapViewport } from './useMapViewport'

/** Diamond edge in CSS pixels — under the teardrop's 9, so a shared spawn point shows both. */
const PIN_PX = 8

/**
 * The zone's timer rows, joined and memoized — the ONE derivation both this layer and any
 * future pane count read. Subscribes the respawn module (the Timers tab's snapshot transport).
 *
 * TWO MEMOS, ON PURPOSE. The catalog index is a 7,866-row walk and changes only with the DRAWN
 * map; the respawn snapshot's rows change on every module delta, which under a running clock is
 * often. Keying the index on the stem alone means a delta re-joins sixty rows against a map,
 * not the map against the catalog. The stem is `data.zone` — the map on screen, never the one
 * being fetched (respawnPins.ts `timerZone` says why that distinction was a bug).
 */
export function useTimerPins(zoneStem: ZoneShort | null): TimerPin[] {
  const snap = useRespawnSnap()
  const zone = useMemo(() => timerZone(zoneStem, MOB_CATALOG), [zoneStem])
  return useMemo(() => timerPinRows(snap.rows, zone), [snap.rows, zone])
}

export function MapTimerPins({ timers, vp }: { timers: readonly TimerPin[]; vp: MapViewport }): JSX.Element {
  const { toScreen } = vp
  // Hover text is INSTANT DOM, the surface's no-popper idiom (MapMobPins.tsx carries the why).
  const [hover, setHover] = useState<string | null>(null)
  const { palette } = useTheme()
  const pinColor = palette.error.main
  const now = useSecondsClock()
  // Position memo keyed on pins + projection (per view CHANGE); the 1 Hz tick re-renders only
  // the text reads below, which is a walk over at most the watch list's 60 rows.
  const placed = useMemo(() => {
    const out: { t: TimerPin; key: string; at: { px: number; py: number } }[] = []
    for (const t of placeableTimerPins(timers))
      for (let i = 0; i < t.pins.length; i += 1) {
        const pin = t.pins[i]
        out.push({ t, key: `${t.id}#${String(i)}`, at: toScreen(pin.x, pin.y) })
      }
    return out
  }, [timers, toScreen])
  // The clock is read ONCE per pin per tick — the title, the worn clock and the hover all draw
  // from this, where each used to call `respawnReading` for itself.
  const labels = useMemo(
    () => new Map(placed.map((pp) => [pp.key, timerPinLabels(pp.t, now)] as const)),
    [placed, now]
  )
  const hovered = placed.find((pp) => pp.key === hover)

  return (
    <div
      data-testid="maps-timer-pins"
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
    >
      {placed.map(({ key, at }) => (
        <span
          key={key}
          data-testid="maps-timer-pin"
          title={labels.get(key)?.text}
          onMouseEnter={() => {
            setHover(key)
          }}
          onMouseLeave={() => {
            setHover(null)
          }}
          style={{
            position: 'absolute',
            left: at.px,
            top: at.py,
            width: PIN_PX,
            height: PIN_PX,
            marginLeft: -PIN_PX / 2,
            marginTop: -PIN_PX / 2,
            transform: 'rotate(45deg)',
            background: pinColor,
            boxShadow: '0 0 0 1px rgba(0,0,0,0.85)',
            opacity: 0.9,
            pointerEvents: 'auto',
            zIndex: 2
          }}
        />
      ))}
      {/* THE CLOCK, WORN ALL THE TIME (the fork's ask, kaltinril, 2026-08-18): the whole point of
          watching a mob is knowing when, and a clock behind a hover is a clock you have to go and
          read. Just the duration — the mob's name and the full sentence stay on the hover. */}
      {placed.map(({ key, at }) => (
        <span
          key={`clock-${key}`}
          data-testid="maps-timer-pin-clock"
          style={{
            position: 'absolute',
            left: at.px,
            top: at.py + PIN_PX,
            transform: 'translate(-50%, 0)',
            pointerEvents: 'none',
            zIndex: 3,
            ...pinTextStyle(pinColor, 11)
          }}
        >
          {labels.get(key)?.clock}
        </span>
      ))}
      {hovered !== undefined && (
        <PinHoverCard
          testId="maps-timer-pin-name"
          at={hovered.at}
          lift={PIN_PX}
          color={pinColor}
          text={labels.get(hovered.key)?.text ?? ''}
        />
      )}
    </div>
  )
}
