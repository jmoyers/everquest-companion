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
import { placeableTimerPins, timerPinClock, timerPinRows, timerPinText, type TimerPin } from './respawnPins'
import type { MapViewport } from './useMapViewport'

/** Diamond edge in CSS pixels — under the teardrop's 9, so a shared spawn point shows both. */
const PIN_PX = 8

/** The label halo, verbatim from MapMobPins — the error tone is light in both themes too. */
const HALO =
  '-1px 0 0 rgba(0,0,0,0.85), 1px 0 0 rgba(0,0,0,0.85), 0 -1px 0 rgba(0,0,0,0.85), 0 1px 0 rgba(0,0,0,0.85)'

/**
 * The zone's timer rows, joined and memoized — the ONE derivation both this layer and any
 * future pane count read. Subscribes the respawn module (the Timers tab's snapshot transport).
 */
export function useTimerPins(zoneStem: ZoneShort | null, zoneName: string | null): TimerPin[] {
  const snap = useRespawnSnap()
  return useMemo(
    () => timerPinRows(snap.rows, zoneStem, zoneName, MOB_CATALOG),
    [snap.rows, zoneStem, zoneName]
  )
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

  return (
    <div
      data-testid="maps-timer-pins"
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
    >
      {placed.map(({ t, key, at }) => (
        <span
          key={key}
          data-testid="maps-timer-pin"
          title={timerPinText(t, now)}
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
      {/* THE CLOCK, WORN ALL THE TIME (user ask, 2026-08-18): the whole point of watching a mob
          is knowing when, and a clock behind a hover is a clock you have to go and read. Just the
          duration — the mob's name and the full sentence stay on the hover, where they were. */}
      {placed.map(({ t, key, at }) => (
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
            font: '11px/1.1 inherit',
            color: pinColor,
            textShadow: HALO,
            whiteSpace: 'nowrap'
          }}
        >
          {timerPinClock(t, now)}
        </span>
      ))}
      {placed
        .filter((pp) => pp.key === hover)
        .map(({ t, key, at }) => (
          <span
            key={`hover-${key}`}
            data-testid="maps-timer-pin-name"
            style={{
              position: 'absolute',
              left: at.px,
              top: at.py - PIN_PX,
              transform: 'translate(-50%, -100%)',
              pointerEvents: 'none',
              zIndex: 4,
              font: '12px/1.1 inherit',
              color: pinColor,
              textShadow: HALO,
              whiteSpace: 'nowrap'
            }}
          >
            {timerPinText(t, now)}
          </span>
        ))}
    </div>
  )
}
