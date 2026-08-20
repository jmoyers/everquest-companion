// THE REACT HALF of the typed-/loc marker (JOS-98) — the state, the persistence effect, and the
// two gestures. Every RULE it applies lives in `locMarker.ts`, which is pure and node-tested; this
// file is the wiring, and it is deliberately the only part of the feature that cannot be driven by
// `node --test`.
//
// PERSISTED BY ONE EFFECT, not by each transition — the same shape `useZoneSelection` uses for the
// pinned zone, and for the same reason: there is exactly one place that can forget to write, and
// none of the reducers has to be impure to be correct.
//
// KEYED BY ZONE, READ BY ZONE. The whole map of markers is held in state and the CURRENT zone's is
// derived, rather than loading one zone's marker on every zone change. That is what makes walking
// out of a zone and back — or pinning another map and returning — free of a reload, and it is why
// clearing one zone's marker provably cannot touch another's (`clearTypedMarker`).
//
// PLACING JUMPS, RESTORING DOES NOT. Typing a loc is a question ("where is that?") and the answer
// is useless off screen, so a placement centres the view on it at the search's own zoom. A marker
// restored from a previous session is NOT a question anyone just asked — snapping the viewport on
// mount would fight the zone's own fit and move a map the user never touched.

import { useCallback, useEffect, useState } from 'react'
import type { ZoneShort } from '@shared/maps'
import { JUMP_ZOOM } from './MapBody'
import { mapFromLoc, type EqLoc } from './mapGeometry'
import {
  addTypedMarker,
  clearPlayerMarker,
  clearTypedMarker,
  loadLocMarkers,
  playerMarkerFor,
  saveLocMarkers,
  setPlayerMarker,
  typedMarkersFor,
  type LocMarkers,
  type MarkerColor,
  type TypedMarker
} from './locMarker'
import type { MapViewport } from './useMapViewport'

/** What the toolbar needs to state the markers, and what the surface needs to draw them. */
export interface LocMarkerState {
  /** This zone's TYPED markers (up to four, each a distinct colour), oldest first. */
  typed: TypedMarker[]
  /** This zone's PLAYER marker (scraped from the log, drawn light red), or null. */
  player: EqLoc | null
  /** A well-formed reading was entered in the box: ADD it as a typed marker, and go look at it. */
  place: (loc: EqLoc) => void
  /**
   * Update the PLAYER marker WITHOUT moving the view — the auto-`/loc` path (JOS-98 wave 2). A
   * position read from the log is not a question the user just asked on the map (that is `place`,
   * the typed field), so it moves the crosshair and leaves the viewport exactly where it was.
   */
  setPlayer: (loc: EqLoc) => void
  /** Centre on the typed marker of this colour. A blue/green/yellow/violet chip's click. */
  showTyped: (color: MarkerColor) => void
  /** Centre on the player marker. The red chip's click. */
  showPlayer: () => void
  /** Forget this zone's typed marker of this colour. */
  clearTyped: (color: MarkerColor) => void
  /** Forget this zone's player marker. */
  clearPlayer: () => void
}

export function useLocMarker(zone: ZoneShort | null, vp: MapViewport): LocMarkerState {
  const [marks, setMarks] = useState<LocMarkers>(loadLocMarkers)
  useEffect(() => {
    saveLocMarkers(marks)
  }, [marks])

  const typed = typedMarkersFor(marks, zone)
  const player = playerMarkerFor(marks, zone)
  const { centerOn, zoomedIn, view } = vp

  // Fitted ⇒ a marker is a few pixels from everything else, so the jump also zooms in; already
  // zoomed ⇒ keep the scale the user chose. Identical to the search jump, on purpose.
  const goTo = useCallback(
    (loc: EqLoc) => {
      const p = mapFromLoc(loc)
      centerOn(p.x, p.y, zoomedIn ? undefined : view.scale * JUMP_ZOOM)
    },
    [centerOn, zoomedIn, view.scale]
  )

  const place = useCallback(
    (loc: EqLoc) => {
      // No map open ⇒ nowhere to remember it. The field is gated on `hasMap`, so this is a guard,
      // not a path: a marker filed under no zone could never be found again.
      if (zone == null) return
      setMarks((prev) => addTypedMarker(prev, zone, loc))
      goTo(loc)
    },
    [zone, goTo]
  )

  // The auto path: remember the PLAYER position for this zone, do NOT move the view (owner ruling,
  // JOS-98 wave 2). Same guard as `place` — no map open, nowhere to file it.
  const setPlayer = useCallback(
    (loc: EqLoc) => {
      if (zone == null) return
      setMarks((prev) => setPlayerMarker(prev, zone, loc))
    },
    [zone]
  )

  const showTyped = useCallback(
    (color: MarkerColor) => {
      const m = typed.find((t) => t.color === color)
      if (m != null) goTo(m.loc)
    },
    [typed, goTo]
  )
  const showPlayer = useCallback(() => {
    if (player != null) goTo(player)
  }, [player, goTo])

  const clearTyped = useCallback(
    (color: MarkerColor) => {
      if (zone == null) return
      setMarks((prev) => clearTypedMarker(prev, zone, color))
    },
    [zone]
  )
  const clearPlayer = useCallback(() => {
    if (zone == null) return
    setMarks((prev) => clearPlayerMarker(prev, zone))
  }, [zone])

  return { typed, player, place, setPlayer, showTyped, showPlayer, clearTyped, clearPlayer }
}
