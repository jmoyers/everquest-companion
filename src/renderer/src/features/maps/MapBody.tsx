// THE MAP AND ITS SIDEBAR — one flex row, and the jump that both of them fire.
//
// Split out of MapsView.tsx, which owns WHICH zone is open and nothing about how it is drawn.
// Everything here is the drawing: the positioned host the viewport measures, the canvas, the
// label layer, the three marks — the search flash, the selection ring and the typed-/loc crosshair
// — and the sidebar column beside them.
//
// WHEN THE SIDEBAR IS OFF IT IS NOT RENDERED AT ALL, so the surface is the row's only flex child
// and takes the full width. That is the whole anti-flicker design: no zero-width box, no width
// transition, no fixed-size arithmetic on either side. The surface is `flexGrow:1; minHeight:0`
// and the pane is a fixed `flexShrink:0` column, so a close is one layout pass and the viewport's
// ResizeObserver sees exactly one new size — it can never feed back into itself, because nothing
// here is sized from its own content.
//
// THE ROW IS THE POSITIONING CONTEXT for the reopen button, deliberately, rather than the map
// surface: the sidebar is the only way to search a map and it must be recoverable in EVERY state
// this row can be in, including the one where no map is drawn and there is no surface to float
// over.
//
// THE SIDEBAR RENDERS WITHOUT A MAP. Its "Other zones" section searches every installed map AND
// the whole wiki bestiary (crossZone.ts), so "which zone is Ambassador D`Vinn in?" is answerable
// from the state where nothing is open — which is exactly the state that question gets asked in.

import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode, type RefObject } from 'react'
import { Box, IconButton, Stack } from '@mui/material'
import ViewSidebarIcon from '@mui/icons-material/ViewSidebar'
import type { MapData, ZoneShort } from '@shared/maps'
import type { JumpTarget } from './crossZone'
import { MapCanvas } from './MapCanvas'
import { MapPointsLayer, labelPosition } from './MapPointsLayer'
import { MapMobPins } from './MapMobPins'
import { MapLocMarker } from './MapLocMarker'
import MapMobPane from './MapMobPane'
import type { MobPaneRow } from './mobPins'
import { paneOverlay, type PaneOverlay, type ZonePaneState } from './useMapPane'
import { connectionTarget } from './zoneLinks'
import { mapFromLoc, type EqLoc, type LayerMask } from './mapGeometry'
import { bandRange, type FloorBand } from './floorSlice'
import type { MapViewport } from './useMapViewport'
import { Tooltip } from '../../lib/Tooltip'

/** How long the jump-to marker stays on screen. Long enough to find, short enough to forget. */
const MARKER_MS = 2600
/**
 * Scale bump when jumping from a fitted view — a fitted zone puts a POI at a couple of pixels.
 *
 * EXPORTED so the `/loc` marker jumps with exactly the same feel (useLocMarker.ts). Two constants
 * for one gesture is how two gestures start behaving differently for no stated reason.
 */
export const JUMP_ZOOM = 6

/** The transient "here it is" pip a cross-zone hit leaves behind. */
export interface Marker {
  x: number
  y: number
  at: number
}

/**
 * THE JUMP-TO-A-HIT path, including the cross-zone case it exists for.
 *
 * A hit in the zone on screen is one `centerOn`. A hit in ANOTHER zone cannot be: the map has to
 * be fetched and the pane re-measured first, so the hit is PARKED and the jump fires from an
 * effect once `data.zone` matches and the host has a real size. Jumping into a zero-size pane
 * would clamp against a fit scale of 1 and land nowhere near the point.
 *
 * A TARGET MAY CARRY NO POSITION (JOS-135). The bestiary answers "which zone" far more often than
 * "where in it" — a wiki page may state no coordinate, or state one while naming several zones —
 * so a jump with `at: null` changes the map and stops there rather than flashing a mark at a
 * position nothing stated. The zone change is still the answer the user asked for.
 */
export function useSearchJump(args: {
  vp: MapViewport
  /** The zone actually ON SCREEN (`data.zone`), never the one being fetched. */
  zone: ZoneShort | undefined
  pick: (zone: ZoneShort) => void
}): { marker: Marker | null; onJump: (to: JumpTarget) => void } {
  const { vp, zone, pick } = args
  const { centerOn, zoomedIn, view, size } = vp
  const [marker, setMarker] = useState<Marker | null>(null)
  const [pending, setPending] = useState<JumpTarget | null>(null)

  const jump = useCallback(
    (x: number, y: number) => {
      // Fitted ⇒ a POI is a couple of pixels wide, so the jump also zooms in; already zoomed ⇒
      // keep the scale the user chose and only re-centre.
      centerOn(x, y, zoomedIn ? undefined : view.scale * JUMP_ZOOM)
      setMarker({ x, y, at: Date.now() })
    },
    [centerOn, zoomedIn, view.scale]
  )

  const onJump = useCallback(
    (to: JumpTarget) => {
      if (to.zone === zone) {
        if (to.at) jump(to.at.x, to.at.y)
        return
      }
      pick(to.zone)
      // Nothing to park when the row states no position: the zone change IS the whole jump.
      setPending(to.at ? to : null)
    },
    [zone, jump, pick]
  )

  useEffect(() => {
    if (pending?.at == null || zone !== pending.zone || size.w <= 0) return
    jump(pending.at.x, pending.at.y)
    setPending(null)
  }, [pending, zone, size.w, jump])

  // Transient by design: a marker that never fades becomes a second, permanent map symbol.
  useEffect(() => {
    if (marker == null) return
    const t = setTimeout(() => {
      setMarker(null)
    }, MARKER_MS)
    return () => {
      clearTimeout(t)
    }
  }, [marker])

  return { marker, onJump }
}

/** One of the two ring/pip marks. Same symbol, different lifetimes — see each call site. */
function MarkerRing({
  at,
  size,
  testId
}: {
  at: { px: number; py: number }
  size: number
  testId: string
}): JSX.Element {
  return (
    <Box
      data-testid={testId}
      sx={{
        position: 'absolute',
        left: at.px,
        top: at.py,
        width: size,
        height: size,
        transform: 'translate(-50%, -50%)',
        borderRadius: '50%',
        border: '2px solid',
        borderColor: 'warning.main',
        pointerEvents: 'none'
      }}
    />
  )
}

/**
 * The drawn map: the positioned host the viewport measures, the canvas, the label layer, and the
 * markers — positioned through `labelPosition`, the SAME arithmetic the labels use.
 */
function MapSurface({
  data,
  vp,
  hostRef,
  layers,
  bands,
  floor,
  marker,
  locMarker,
  pane,
  zones,
  onJump
}: {
  data: MapData
  vp: MapViewport
  hostRef: RefObject<HTMLDivElement | null>
  layers: LayerMask
  bands: readonly FloorBand[]
  floor: number | null
  marker: Marker | null
  /** The `/loc` the user typed for THIS zone, still in the game's own axes (JOS-98). */
  locMarker: EqLoc | null
  /** The sidebar's contribution, or null when it is closed and draws nothing. */
  pane: PaneOverlay | null
  /** Every stem an installed pack provides — gates which connection labels become links. */
  zones: readonly ZoneShort[]
  /** The search jump — a clicked connection label opens its zone with no position to centre on. */
  onJump: (to: JumpTarget) => void
}): JSX.Element {
  // A `to_…` label the zone table resolves to an INSTALLED map becomes a link (zoneLinks.ts).
  const linkFor = useMemo(() => {
    const installed = new Set(zones)
    return (display: string) => connectionTarget(display, installed)
  }, [zones])
  const at = marker == null ? null : labelPosition(vp, marker)
  // The SELECTION ring — one symbol for both kinds of pane row, so a wiki mob and a map label
  // are marked identically once clicked. Persistent, unlike the search jump's flash: a selection
  // is a state you can look away from and come back to.
  const ringAt = pane?.selectedAt == null ? null : labelPosition(vp, pane.selectedAt)
  // Resolved here rather than inside the canvas so the canvas stays ignorant of clustering: it
  // takes a z window and dims what falls outside it, nothing more. Memoized because it is a
  // canvas redraw dependency — a fresh object every render would repaint on every render.
  const zBand = useMemo(() => (floor == null ? null : bandRange(bands, floor)), [bands, floor])
  return (
    <Box
      ref={hostRef}
      data-testid="maps-surface"
      onPointerDown={vp.onPointerDown}
      onPointerMove={vp.onPointerMove}
      onPointerUp={vp.onPointerUp}
      sx={{
        position: 'relative',
        flexGrow: 1,
        minHeight: 0,
        overflow: 'hidden',
        borderRadius: 1,
        bgcolor: 'background.paper',
        touchAction: 'none',
        cursor: vp.dragging ? 'grabbing' : 'grab'
      }}
    >
      <MapCanvas lines={data.lines} vp={vp} layers={layers} zBand={zBand} />
      <MapPointsLayer
        points={data.points}
        vp={vp}
        layers={layers}
        bands={bands}
        floor={floor}
        linkFor={linkFor}
        onOpenZone={(zone) => {
          onJump({ zone, at: null })
        }}
      />
      {pane != null && (
        <MapMobPins
          pins={pane.pins}
          vp={vp}
          selectedId={pane.selectedId}
          wishes={pane.wishes}
          onSelect={pane.select}
        />
      )}
      {ringAt != null && <MarkerRing at={ringAt} size={26} testId="maps-pane-marker" />}
      {at != null && <MarkerRing at={at} size={22} testId="maps-marker" />}
      {/* THE ONE SEAM, AGAIN: the typed reading reaches the screen through `mapFromLoc` and then
          the same `project` every other mark uses. Nothing here knows which way north is. */}
      {locMarker != null && <MapLocMarker at={mapFromLoc(locMarker)} loc={locMarker} vp={vp} />}
    </Box>
  )
}

/** The way back to a sidebar you closed. Floats over the row so it costs the map no layout. */
function PaneReopen({ onOpen }: { onOpen: () => void }): JSX.Element {
  return (
    <Tooltip title="Find a mob or label">
      <IconButton
        size="small"
        data-testid="maps-pane-open"
        onClick={onOpen}
        sx={{
          position: 'absolute',
          top: 4,
          right: 4,
          zIndex: 2,
          bgcolor: 'background.paper',
          border: '1px solid',
          borderColor: 'divider'
        }}
      >
        <ViewSidebarIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  )
}

export interface MapBodyProps {
  /** The map on screen, or null — in which case `empty` stands in its place. */
  data: MapData | null
  /** What to draw instead of a surface: the quiet picker state, or nothing while it loads. */
  empty: ReactNode
  vp: MapViewport
  hostRef: RefObject<HTMLDivElement | null>
  layers: LayerMask
  bands: readonly FloorBand[]
  floor: number | null
  pane: ZonePaneState
  /** The LONG zone name the catalog was joined on, for the sidebar's own honesty. */
  zoneName: string | null
  marker: Marker | null
  /** This zone's typed-/loc marker, or null. Persistent, unlike `marker` above it. */
  locMarker: EqLoc | null
  /** A cross-zone hit was clicked — `useSearchJump`'s handler, which changes zone first. */
  onJump: (to: JumpTarget) => void
  /** Every stem an installed pack provides — gates which connection labels become links. */
  zones: readonly ZoneShort[]
  /** Open a mob row's page on the Mobs tab. */
  onOpenMob?: (row: MobPaneRow) => void
}

export default function MapBody(props: MapBodyProps): JSX.Element {
  const { data, empty, vp, hostRef, layers, bands, floor, pane, zoneName, marker, onJump } = props
  const { locMarker, zones, onOpenMob } = props
  return (
    <Stack direction="row" spacing={1.5} sx={{ position: 'relative', flexGrow: 1, minHeight: 0 }}>
      {data != null ? (
        <MapSurface
          data={data}
          vp={vp}
          hostRef={hostRef}
          layers={layers}
          bands={bands}
          floor={floor}
          marker={marker}
          locMarker={locMarker}
          pane={paneOverlay(pane)}
          zones={zones}
          onJump={onJump}
        />
      ) : (
        empty
      )}
      {pane.open ? (
        <MapMobPane
          zoneName={zoneName}
          hasMap={data != null}
          mobs={pane.mobs}
          labels={pane.labels}
          hits={pane.hits}
          counts={pane.counts}
          query={pane.query}
          onQuery={pane.setQuery}
          selectedId={pane.selectedId}
          onSelect={pane.select}
          onHit={onJump}
          wishes={pane.wishes}
          onOpenMob={onOpenMob}
          pinsCapped={pane.pinsCapped}
          onClose={() => {
            pane.setOpen(false)
          }}
        />
      ) : (
        <PaneReopen
          onOpen={() => {
            pane.setOpen(true)
          }}
        />
      )}
    </Stack>
  )
}
