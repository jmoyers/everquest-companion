// The WIKI PIN LAYER — where the catalog says this zone's named mobs spawn.
//
// A SECOND, CLEARLY DIFFERENT SYMBOL. `MapPointsLayer` draws the map file's own labels in the
// pack author's colours, because those colours ENCODE a category (zone connection, banker,
// merchant…) and recolouring them would destroy meaning. These pins are not that: they come from
// a different authority (the wiki catalog, not the map file), so they get one deliberate colour
// of their own — the theme's warning tone, the same one the search-jump ring already uses — and
// a triangular pin shape rather than a round dot. A user must never have to ask which source a
// mark came from.
//
// IT ONLY DRAWS WHAT THE PANE IS SHOWING. The pins follow the pane's filtered mob list, so
// typing "sarnak" narrows the map as well as the list. That is also what keeps the layer honest
// at scale: unfiltered Kael Drakkel is 343 named mobs, several of which state eight spawn points
// each, and `pinsForRows` caps the drawn set (reported, never silently trimmed).
//
// INERT TO DRAGS, like the label layer: `pointerEvents:'none'` on the container so drag-to-pan
// works straight through it, re-enabled on each pin. Clicking a pin ROUTES THROUGH THE PANE'S
// OWN `select` — selection still lives in exactly one place (useMapPane), so the ring, the
// raised pin and the highlighted pane row cannot fall out of sync: the pin is a second way to
// REACH the one selection, never a second copy of it. The clicked pin itself is passed as the
// target, so a mob with eight spawn points rings the one under the cursor, not its first.

import { useMemo, type JSX } from 'react'
import { useTheme } from '@mui/material'
import type { MobPaneRow, PlacedPin } from './mobPins'
import type { MapViewport } from './useMapViewport'

/** Pin body size in CSS pixels. Does not scale with zoom, for the same reason label text doesn't. */
const PIN_PX = 9

export interface MapMobPinsProps {
  /** The pins to draw — already capped and keyed by `pinsForRows`, in list order. */
  pins: readonly PlacedPin[]
  vp: MapViewport
  /**
   * The pane's selected row id. It raises that row's pins above the rest; the RING around the
   * selection is drawn once by MapsView, for mobs and map labels alike, so there is exactly one
   * "this is the thing you clicked" symbol on the surface.
   */
  selectedId: string | null
  /** The pane's `select`, with the clicked pin as the position to centre and ring. */
  onSelect: (row: MobPaneRow, at: { x: number; y: number }) => void
}

export function MapMobPins({ pins, vp, selectedId, onSelect }: MapMobPinsProps): JSX.Element {
  const { toScreen } = vp
  // The SAME token the search-jump marker paints with (`warning.main`), read from the theme
  // rather than spelled as a hex literal so a theme change can never leave the two disagreeing.
  const pinColor = useTheme().palette.warning.main
  // Keyed on the pin array and the projection, exactly like the label layer's declutter memo:
  // this recomputes per view CHANGE, not per frame.
  const placed = useMemo(() => pins.map((p) => ({ ...p, at: toScreen(p.pin.x, p.pin.y) })), [pins, toScreen])

  return (
    <div
      data-testid="maps-mob-pins"
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
    >
      {placed.map(({ row, pin, key, at }) => {
        const selected = row.id === selectedId
        return (
          <span
            key={key}
            data-testid="maps-mob-pin"
            title={
              pin.pct === undefined
                ? row.name
                : // The page's OWN number, verbatim — never rounded into "likely" or "rare".
                  `${row.name} - ${String(pin.pct)}% of spawns`
            }
            // Stop the press, not just the click — the same reason as the connection labels
            // (MapPointsLayer.tsx): the surface's pointer-down would take pointer capture and
            // swallow the click.
            onPointerDown={(ev) => {
              ev.stopPropagation()
            }}
            onClick={() => {
              onSelect(row, { x: pin.x, y: pin.y })
            }}
            style={{
              position: 'absolute',
              left: at.px,
              top: at.py,
              width: PIN_PX,
              height: PIN_PX,
              marginLeft: -PIN_PX / 2,
              marginTop: -PIN_PX / 2,
              borderRadius: '50% 50% 50% 0',
              transform: 'rotate(-45deg)',
              background: pinColor,
              boxShadow: '0 0 0 1px rgba(0,0,0,0.85)',
              opacity: selected ? 1 : 0.85,
              pointerEvents: 'auto',
              cursor: 'pointer',
              zIndex: selected ? 3 : 1
            }}
          />
        )
      })}
    </div>
  )
}
