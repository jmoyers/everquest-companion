// THE /loc CROSSHAIRS — up to TWO dots, each in a colour nothing else on this surface uses (JOS-98).
//
// A DISTINCT AUTHORITY NEEDS A DISTINCT SYMBOL. The surface already carries the map file's own
// labels (round dots in the pack author's category colours — recolouring them destroys meaning) and
// the app's own finds (spawn pins, the search flash, the selection ring — all the theme's WARNING
// tone, "the app found this for you"). The crosshairs are neither; they are the positions a /loc
// stated, so they take a crosshair shape ("this exact point", not "something is around here") and a
// colour of their own — and there are two of them, from two sources the user must be able to tell
// apart at a glance (JOS-98 wave 3):
//
//   * the TYPED readings the user PASTED into the box — up to four, each in one of a fixed cycle of
//     colours (blue, green, yellow, violet) so several marked spots stay told apart.
//   * `player` — the reading the LOG scraped, i.e. where the character stood. A light RED, so "where
//                I am" and "a spot I marked" never read as the same dot.
//
// Both PERSIST across a restart, which is the other reason neither can look like the search flash.
//
// INERT, like the label and pin layers: `pointerEvents:'none'` on the frame so drag-to-pan works
// straight through it, re-enabled on the crosshair itself so its tooltip works. Clearing one is
// deliberately NOT a click on the map — the toolbar's chips own that, next to the box, so a stray
// click on a map can never delete something the user is relying on.

import type { JSX } from 'react'
import { useTheme } from '@mui/material'
import type { EqLoc } from './mapGeometry'
import { formatLoc, MARKER_COLOR_HEX, type MarkerColor } from './locMarker'
import type { MapViewport } from './useMapViewport'

/** Outer diameter of the ring, CSS pixels. Fixed, like the pins: a mark is not a distance. */
const RING_PX = 18
/** How far each tick reaches beyond the ring — enough to find at a glance on a busy map. */
const TICK_PX = 7

export interface MapLocMarkerProps {
  /**
   * Which crosshair this is: one of the four typed colours, or the scraped `'player'` position. It
   * decides the colour, the test id, and the tooltip's words.
   */
  variant: MarkerColor | 'player'
  /** Where the reading is, in MAP coordinates — already through `mapFromLoc`. */
  at: { x: number; y: number }
  /** The reading itself, so the tooltip can state it in the game's own words and order. */
  loc: EqLoc
  vp: MapViewport
}

/** One arm of the crosshair. Four of these plus the ring is the whole symbol. */
function tick(color: string, style: React.CSSProperties): JSX.Element {
  return <span style={{ position: 'absolute', background: color, ...style }} />
}

export function MapLocMarker({ variant, at, loc, vp }: MapLocMarkerProps): JSX.Element {
  const palette = useTheme().palette
  const isPlayer = variant === 'player'
  // A light red for where you are (`error.light`, the theme's light red — legible in both themes),
  // else the typed colour's fixed hex. Player is one symbol; the typed ones are four of a set.
  const color = isPlayer ? palette.error.light : MARKER_COLOR_HEX[variant]
  const testId = isPlayer ? 'maps-loc-marker-player' : 'maps-loc-marker'
  // The crosshair is inert (centering is the chip's job), so its tooltip only IDENTIFIES the mark —
  // the "click to center" half lives on the chip, which is the thing you actually click.
  const title = isPlayer ? 'Most recent player /loc' : 'Manual marker'
  const p = vp.toScreen(at.x, at.y)
  const half = RING_PX / 2
  const arm = { width: 2, height: TICK_PX, marginLeft: -1 } as const
  const bar = { height: 2, width: TICK_PX, marginTop: -1 } as const
  return (
    <div
      data-testid={testId}
      data-color={variant}
      data-loc={formatLoc(loc)}
      style={{
        position: 'absolute',
        left: p.px,
        top: p.py,
        width: 0,
        height: 0,
        pointerEvents: 'none',
        zIndex: 4
      }}
    >
      <span
        title={title}
        style={{
          position: 'absolute',
          left: -half,
          top: -half,
          width: RING_PX,
          height: RING_PX,
          borderRadius: '50%',
          border: `2px solid ${color}`,
          boxShadow: '0 0 0 1px rgba(0,0,0,0.75)',
          pointerEvents: 'auto'
        }}
      />
      {tick(color, { ...arm, left: 0, top: -half - TICK_PX })}
      {tick(color, { ...arm, left: 0, top: half })}
      {tick(color, { ...bar, top: 0, left: -half - TICK_PX })}
      {tick(color, { ...bar, top: 0, left: half })}
    </div>
  )
}
