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
// OWN selection (`mark`) — selection still lives in exactly one place (useMapPane), so the ring,
// the raised pin and the highlighted pane row cannot fall out of sync: the pin is a second way to
// REACH the one selection, never a second copy of it. The clicked pin itself is passed as the
// target, so a mob with eight spawn points rings the one under the cursor, not its first. And it
// does NOT centre: the pin is already under the cursor, and centring moved it out from under the
// second click of a double-click (mobPins.ts `paneGestures` carries the split).
//
// A pin whose page drops a wish-list item paints `success.main` — its own lane, because the /loc
// crosshair already owns the user-stated `info` tone (MapLocMarker.tsx) and two different marks
// on one surface must never share a colour and differ only by shape. The pane's rows read the
// same `wishes` derivation, so list and map agree.
//
// DOUBLE-CLICK OPENS THE MOB'S PAGE (fork decision, kaltinril, 2026-08-18). Single click stays
// the pane's selection — the ring and the row highlight — and the page door needed a second
// gesture because the hover card is deliberately inert (JOS-143 bans interactive poppers on this
// surface).

import { useMemo, useState, type JSX } from 'react'
import { useTheme } from '@mui/material'
// The bundled boss roster (profile-keyed) — handed to mobArt.ts, which stays pure and node-tested.
import { getBossData } from '../../data'
import { PinHoverCard, onActivateKey } from './mapPinChrome'
import { mobPortraitUrl } from './mobArt'
import type { MobPin, MobPaneRow, PlacedPin } from './mobPins'
import type { MobTarget } from '../mobs/mobTarget'
import type { MapViewport } from './useMapViewport'

/** Pin body size in CSS pixels. Does not scale with zoom, for the same reason label text doesn't. */
const PIN_PX = 9

/** Name, level and spawn share exactly as the page states them, plus any wish-list drops. */
function pinText(row: MobPaneRow, pin: MobPin, wished?: readonly string[]): string {
  const level = row.level === undefined ? '' : ` (${row.level})`
  const share = pin.pct === undefined ? '' : ` - ${String(pin.pct)}% of spawns`
  const wish = wished == null || wished.length === 0 ? '' : ` - drops ${wished.join(', ')} (wish list)`
  return `${row.name}${level}${share}${wish}`
}

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
  /** Row id → the wish-list drops that mob carries — useMapPane's one derivation. */
  wishes: ReadonlyMap<string, readonly string[]>
  /** The pane's `mark`, with the clicked pin as the position to ring — never centred (header). */
  onMark: (row: MobPaneRow, at: { x: number; y: number }) => void
  /** Double-click's door to the mob's page. Absent ⇒ the pin has one gesture, as before. */
  onOpenMob?: (target: MobTarget) => void
}

export function MapMobPins({ pins, vp, selectedId, wishes, onMark, onOpenMob }: MapMobPinsProps): JSX.Element {
  const { toScreen } = vp
  // The hovered pin's key. Its text is drawn INSTANTLY as DOM beside the pin — the same deferred
  // -text gesture the label layer's dots use, and for the same reason the surface bans poppers
  // (JOS-143): the native `title` stays as the delayed backstop, but a hunter reading a zone
  // should not wait a second per pin to learn a name.
  const [hover, setHover] = useState<string | null>(null)
  // The SAME token the search-jump marker paints with (`warning.main`), read from the theme
  // rather than spelled as a hex literal so a theme change can never leave the two disagreeing.
  const { palette } = useTheme()
  const pinColor = palette.warning.main
  // The wish lane (see header): its own tone, never the /loc crosshair's `info`.
  const wishColor = palette.success.main
  // Keyed on the pin array and the projection, exactly like the label layer's declutter memo:
  // this recomputes per view CHANGE, not per frame.
  const placed = useMemo(() => pins.map((p) => ({ ...p, at: toScreen(p.pin.x, p.pin.y) })), [pins, toScreen])
  const hovered = placed.find((pp) => pp.key === hover)

  return (
    <div
      data-testid="maps-mob-pins"
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
    >
      {placed.map(({ row, pin, key, at }) => {
        const selected = row.id === selectedId
        const wished = wishes.get(row.id)
        const mark = (): void => {
          onMark(row, { x: pin.x, y: pin.y })
        }
        return (
          <span
            key={key}
            data-testid="maps-mob-pin"
            data-wished={wished == null ? undefined : 'true'}
            title={pinText(row, pin, wished)}
            // Keyboard-reachable (mapPinChrome.tsx): a pin is a control, and a control a
            // keyboard cannot reach is a mouse-only feature on a surface the pane already
            // drives from the keyboard.
            role="button"
            tabIndex={0}
            onKeyDown={onActivateKey(mark)}
            onMouseEnter={() => {
              setHover(key)
            }}
            onMouseLeave={() => {
              setHover(null)
            }}
            // NO pointer-down stop: the press falls through to the surface so a drag can START
            // on a pin (400 of them in Kael Drakkel is a lot of un-draggable map). The surface
            // takes pointer capture only once the pointer has MOVED (useMapViewport.ts), so a
            // still click — and a double-click — still lands here.
            onClick={mark}
            onDoubleClick={onOpenMob == null ? undefined : () => {
              onOpenMob({ mob: row.name, entry: row.entry })
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
              background: wished == null ? pinColor : wishColor,
              boxShadow: '0 0 0 1px rgba(0,0,0,0.85)',
              opacity: selected ? 1 : 0.85,
              pointerEvents: 'auto',
              cursor: 'pointer',
              zIndex: selected ? 3 : 1
            }}
          />
        )
      })}
      {/* The hovered pin's card, drawn from the same `placed` array as the pins so the two can
          never disagree about position: bundled portrait when one exists (mobArt.ts), and the
          pin's text. */}
      {hovered !== undefined && (
        <PinHoverCard
          testId="maps-mob-pin-name"
          at={hovered.at}
          lift={PIN_PX}
          color={wishes.has(hovered.row.id) ? wishColor : pinColor}
          art={mobPortraitUrl(hovered.row.name, getBossData().targets)}
          text={pinText(hovered.row, hovered.pin, wishes.get(hovered.row.id))}
        />
      )}
    </div>
  )
}
