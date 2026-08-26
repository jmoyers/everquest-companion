// The Maps tab (docs/plans/map-viewer.md §10, §11 wave 3) — the view that resolves WHICH zone to
// show and hands everything about the drawing to MapBody.tsx.
//
// AUTO-OPEN, AND THE ONE THING IT MUST NEVER DO. The log states the zone you are in and nothing
// else positional, so the feature's whole "it just knows" is one fold: `CharacterSnap.zone` (the
// raw long name, off the `You have entered X.` line) → `zoneShortName()` → the map-file stem.
// That table is HAND-AUTHORED because there is no algorithm — measured, naive normalization
// resolves 7 of the 51 zone names the real log has printed ("The Plane of Sky" → `airplane`).
// When it returns null the viewer draws no map and SAYS WHICH NAME it could not place. It never
// guesses a stem: a confidently wrong map is worse than an honest question (world-model law 1).
// The EQL Tutorial is the known unmapped zone and is exactly what that state exists for.
//
// AND THE WAY OUT IS ALWAYS ON SCREEN. The toolbar's Zone selector (MapZoneSelect.tsx) renders
// in every state — map or no map — so browsing to a zone you are not standing in, and leaving
// the map you are on, are the same one control rather than a state you have to fall back into.
// A pick made there PINS (JOS-97): it survives the next zone line, leaving the tab, and a
// restart, until the toolbar's `Current zone` hands the choice back to the log. Which of the two
// is deciding is stated beside the selector — `useZoneSelection` below, rules in zoneFollow.ts.
//
// FINDING ANYTHING IS THE SIDEBAR'S JOB, and it is OPEN BY DEFAULT (MapMobPane.tsx). The toolbar
// used to carry a label-search box and a This zone / All zones toggle beside the sidebar's own
// toggle — three controls over one question, answered in two places. The bar now describes the
// DRAWING and nothing else; the sidebar is the one filter over the wiki's bestiary, this map's
// own labels, every other installed map AND the bestiary of every other zone (JOS-135) — so a
// name you half-remember is findable from wherever you happen to be standing.
//
// WHAT THIS VIEW CANNOT DO, AND THE HALF OF IT THE USER CAN (JOS-98). There is no AUTOMATIC "you
// are here" marker and there cannot be: `Your Location` appears ZERO times in the log — re-measured
// across the owner's whole 116.8 MB of it for this ticket — because /loc answers in the game window
// and is never written to the file the app tails. What the viewer can do is take the answer from
// you: the toolbar's `/loc marker` field accepts the line the game printed, drops a crosshair where
// it says, and keeps it there per zone until you replace it or clear it. The caption states exactly
// that pair, because a user hunting for a dot that does not exist is a worse outcome than one quiet
// line saying so (§10) — and a user who does not know they can place one is the report we got.
//
// TWO DENSITY CONTROLS LIVE HERE AND BOTH ARE HONEST ABOUT WHAT THEY ARE. Labels declutter
// themselves (`labelLayout.ts`) — a label that loses its space becomes a dot and hover raises the
// text, so nothing is deleted. Floors are CLUSTERED from the map file's own elevations
// (`floorSlice.ts`) and stepped through by hand: the in-game height filter follows your
// character, and the log never says where that is, so there is no auto-select and the default is
// All levels. Out-of-band geometry DIMS rather than disappearing — a floor with its surroundings
// deleted is a diagram you cannot place.

import { useCallback, useEffect, useMemo, useState, useRef, type JSX } from 'react'
import { Box, Chip, Paper, Stack, Typography } from '@mui/material'
import MapIcon from '@mui/icons-material/Map'
import type { CharacterSnap } from '@shared/types'
import type { MapBounds, MapData, MapPackPrefs, ZoneShort } from '@shared/maps'
import { zoneShortName } from '@shared/zones'
import { useModule } from '../../lib/useModule'
import { trackFeature } from '../../lib/telemetry'
import MapBody, { useSearchJump } from './MapBody'
import { useZonePane } from './useMapPane'
import { DEFAULT_LAYERS, type LayerMask } from './mapGeometry'
import { floorBands } from './floorSlice'
import { useMapViewport } from './useMapViewport'
import MapToolbar from './MapToolbar'
import { zoneLabel } from './zoneOptions'
import { loadPackPrefs, savePackPrefs, useMapData, useMapPacks } from './useMapData'
import { useLocMarker } from './useLocMarker'
import {
  loadZoneSelection,
  onCharacterZone,
  onFollowCurrent,
  onPick,
  saveZoneSelection,
  type ZoneMode,
  type ZoneSelection
} from './zoneFollow'
import { Tooltip } from '../../lib/Tooltip'

/** A stand-in extent for the frames where no map is loaded. Never drawn; keeps the hook honest. */
const EMPTY_BOUNDS: MapBounds = { minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: 0, maxZ: 0 }

/** Layer → what that file conventionally holds (§2.3). Used for the per-layer source chips. */
const LAYER_NAME: Record<number, string> = { 0: 'Geometry', 1: 'Labels', 2: 'Legend', 3: 'Extra' }


/**
 * What to call the map on screen.
 *
 * The log's OWN spelling wins when it resolved to this map — displayed raw, tier suffix and all
 * (law 2: canonicalize at boundaries, display raw). A manually picked zone falls back to the
 * table's long name, and a stem the table does not carry is shown as the stem.
 */
function headerTitle(zone: ZoneShort | null, raw: string | undefined): string {
  if (zone == null) return 'Maps'
  return zoneLongName(zone, raw) ?? 'Maps'
}

/**
 * The LONG zone name for the map on screen — what the mob catalog is joined on (`mobsInZone`
 * folds instance suffixes and articles itself, so the log's raw spelling is fine as-is).
 *
 * The log's own spelling wins when it resolved to THIS map; a manually picked stem falls back to
 * the zone table's name. `null` when nothing is open. Same rule the header displays by, on
 * purpose: the sidebar's list and the title must be describing one place.
 */
function zoneLongName(zone: ZoneShort | null, raw: string | undefined): string | null {
  if (zone == null) return null
  if (raw != null && zoneShortName(raw) === zone) return raw
  return zoneLabel(zone)
}

/**
 * WHICH ZONE IS OPEN — and whether that is the app's answer or the user's (JOS-97).
 *
 * TWO MODES, both stated on screen, both remembered (`zoneFollow.ts` holds the rules and the
 * reasoning). In `follow` the log wins whenever it says something new, which is what the viewer
 * has always done and is still the default: "show me where I am" is the feature. In `pinned` a
 * manual pick holds — through zone lines, through leaving the tab (this view is UNMOUNTED the
 * moment you click another one), and through a restart — until `followCurrent` asks for the
 * character's zone back.
 *
 * THE STATE IS PERSISTED BY ONE EFFECT, not by each transition, so there is exactly one place
 * that can forget to write and none of the reducers has to be impure to be correct.
 *
 * AN UNMAPPED ZONE CLEARS THE MAP RATHER THAN LEAVING THE OLD ONE UP. Leaving the previous zone
 * drawn while you stand somewhere else is the same lie as guessing a stem — the user reads the
 * pane, not the header. So a stated-but-unresolvable zone (the EQL Tutorial is the known case)
 * clears the map and says which name it could not place (law 1); the toolbar's selector is still
 * right there, so it is a question, not a dead end.
 */
function useZoneSelection(raw: string | undefined): {
  zone: ZoneShort | null
  auto: ZoneShort | null
  mode: ZoneMode
  pick: (zone: ZoneShort) => void
  followCurrent: () => void
} {
  const auto = zoneShortName(raw)
  // Has the log said where the character is AT ALL? A fresh log (or a replay that has not reached
  // a zone line yet) is not a zone change, and must never overwrite what was remembered.
  const stated = raw != null && raw !== ''
  const [sel, setSel] = useState<ZoneSelection>(loadZoneSelection)
  useEffect(() => {
    saveZoneSelection(sel)
  }, [sel])
  useEffect(() => {
    if (!stated) return
    setSel((prev) => onCharacterZone(prev, auto))
  }, [stated, auto])
  const pick = useCallback((next: ZoneShort) => {
    setSel(onPick(next))
  }, [])
  const followCurrent = useCallback(() => {
    setSel((prev) => onFollowCurrent(prev, auto, stated))
  }, [auto, stated])
  return { zone: sel.zone, auto, mode: sel.mode, pick, followCurrent }
}

/**
 * COULD A MAP STILL BE DRAWN HERE? (JOS-205.)
 *
 * The chrome that describes a map — the toolbar's drawing controls, the credits line — used to
 * materialise in the same frame the map did, which moved and shrank the pane the user was already
 * looking at. Both now HOLD their space whenever an answer is still possible, so opening a zone,
 * changing zone and coming back to the tab are all one layout rather than two.
 *
 * The only terminal "no" is a machine with no map packs at all: there is nothing to draw, ever,
 * and reserving a row of ghosts over that machine's picker would claim otherwise. Everything else
 * — the fetch in flight, the frame before the character module has said where you are, a zone the
 * table cannot place — is a map that may yet arrive, so the space is kept. `!ready` is deliberately
 * optimistic for the same reason: the listing has not answered, so it has not said no.
 */
function mapPossible(packs: { zones: readonly ZoneShort[]; ready: boolean }): boolean {
  return !packs.ready || packs.zones.length > 0
}

/**
 * The head: what zone this is, where each layer came from, and the one honest "cannot".
 *
 * IT IS ONE LINE TALL WHATEVER THE MAP TURNS OUT TO HOLD (JOS-205). Every chip on this row arrives
 * WITH the map — the per-layer sources, the label count, the unparsed-line warning — so while the
 * row wrapped it was a second way the pane below moved the moment a zone loaded: MEASURED at the
 * app's minimum window width (900 px), the chips took the header from 97 px to 129 px and pushed
 * the map down by exactly that. So the row is `nowrap` and the CHIPS are the shrinkable group
 * (AGENTS.md's compact-bar rule): MUI already ellipsizes a chip's own label, each one carries a
 * native `title` so the fact survives the ellipsis (JOS-143: a title, never a popper, on this
 * surface), and the title text never shrinks because the zone's name is the one thing this row
 * exists to say.
 */
function MapsHeader({
  title,
  zone,
  data
}: {
  title: string
  zone: ZoneShort | null
  data: MapData | null
}): JSX.Element {
  return (
    <Stack spacing={0.5} data-testid="maps-header" sx={{ flexShrink: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="nowrap" useFlexGap sx={{ minWidth: 0 }}>
        <MapIcon sx={{ fontSize: 18, color: 'text.disabled', flexShrink: 0 }} />
        <Typography variant="h6" noWrap sx={{ mr: 0.5, flexShrink: 0 }}>
          {title}
        </Typography>
        {zone != null && (
          <Chip size="small" variant="outlined" data-testid="maps-zone-chip" label={zone} sx={{ flexShrink: 0 }} />
        )}
        {/* THE SHRINKABLE GROUP, and the reason it clips rather than wraps: everything in it
            arrives with the map, and a row that grows a line when a map loads moves the map.
            `overflow:hidden` is the backstop under the chips' own ellipsis — without it a row
            that cannot shrink far enough overflows the content area sideways, which is the one
            thing the Maps tab must never do (maps.e2e.mts asserts exactly that). */}
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', minWidth: 0, overflow: 'hidden' }}>
          {/* Which pack each layer actually came from. Geometry and labels routinely come from
              DIFFERENT packs (§6.3), and silently merging two while naming one would be exactly
              the unlabelled inference the world-model laws forbid. */}
          {data?.sources.map((s) => (
            <Chip
              key={`${String(s.layer)}#${s.packId}`}
              size="small"
              data-testid="maps-source"
              title={`${LAYER_NAME[s.layer] ?? String(s.layer)} drawn from the ${s.packId} pack`}
              label={`${LAYER_NAME[s.layer] ?? String(s.layer)}: ${s.packId}`}
            />
          ))}
          {data != null && data.points.length > 0 && (
            <Chip
              size="small"
              variant="outlined"
              title={`${String(data.points.length)} labels in this map`}
              label={`${String(data.points.length)} labels`}
            />
          )}
          {data != null && data.skipped > 0 && (
            <Chip
              size="small"
              color="warning"
              variant="outlined"
              title={`${String(data.skipped)} lines of this map file could not be parsed`}
              label={`${String(data.skipped)} unparsed lines`}
            />
          )}
        </Box>
      </Stack>
      <Typography variant="caption" color="text.disabled">
        The log states the zone you entered and nothing else positional - so there is no automatic
        “you are here”. Type <code>/loc</code> in game and paste the line into the toolbar to mark
        where you are; the mark stays with this zone until you replace or clear it.
      </Typography>
    </Stack>
  )
}

/**
 * Everything that is NOT a drawn map: no packs, no mapping for this zone, or nothing picked.
 *
 * IT NO LONGER CARRIES ITS OWN PICKER. The toolbar's Zone selector renders in every state,
 * directly above this panel, so a second list here would be the same control twice — and the
 * older arrangement, where selection existed ONLY here, is exactly what made a drawn map a dead
 * end (feedback: no visible way back to map selection). This states WHY there is no map; the
 * selector above is how you get one, and the sidebar beside it still searches every other
 * installed map.
 */
function MapsEmpty({
  raw,
  auto,
  zones,
  zone,
  error
}: {
  raw: string | undefined
  auto: ZoneShort | null
  zones: ZoneShort[]
  zone: ZoneShort | null
  error: string | null
}): JSX.Element {
  const unmapped = raw != null && raw !== '' && auto == null
  return (
    <Paper
      variant="outlined"
      data-testid="maps-empty"
      sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto', p: 2 }}
    >
      <Stack spacing={1.5} alignItems="flex-start">
        <Typography variant="body2" color="text.secondary">
          {zones.length === 0
            ? 'No map files were found in your EverQuest folder. The game ships them under maps\\ - set your install folder in Preferences if this looks wrong.'
            : unmapped
              ? `We don’t have a map name for “${raw}” yet - pick one above.`
              : 'Pick a zone above to open its map.'}
        </Typography>
        {zone != null && error != null && (
          <Typography variant="body2" color="text.secondary" data-testid="maps-error">
            {error}
          </Typography>
        )}
      </Stack>
    </Paper>
  )
}

/**
 * THE ATTRIBUTION LINE (§9.2).
 *
 * These packs ship no license file and state no terms — the credit lives INSIDE the map data,
 * as legend-layer label points, and `parseMap.ts` mines it into `MapData.credits` already
 * deduped and reader-ready (underscores expanded, first-seen order). Brewall's only stated wish
 * is that credit, so the viewer prints it under the map it describes, naming whoever drew the
 * layers actually on screen. Parsing it and dropping it would be the one discourtesy the feature
 * cannot afford.
 *
 * `noWrap` + tooltip because this is WORLD-SUPPLIED text of unbounded length (AGENTS.md: one
 * ellipsizing group for it, the tooltip keeps the facts) — the map owns the height, not its
 * footnote. It takes the whole `MapData | null` and decides for itself: the caller stays one
 * expression, not another branch in a view that is already at the complexity ceiling.
 *
 * ITS LINE IS ONE LINE TALL WHEREVER A MAP COULD BE DRAWN (`reserve`, JOS-205). It used to
 * render NOTHING until the credits existed, so it materialised in the same frame the map did and
 * took 32 px (its line plus the stack's gap) off the bottom of the pane the user was already
 * looking at — half of the measured bounce, the toolbar's wrap being the other half. `noWrap`
 * already fixes the line count at one whatever the packs say, so the reservation is exact rather
 * than a guess: same element, same box, `visibility:hidden` until there is something to credit.
 * A pack with no credit points therefore also keeps the pane still, instead of trading one jump
 * for another.
 */
function MapCredits({ data, reserve }: { data: MapData | null; reserve: boolean }): JSX.Element | null {
  const line = data == null ? '' : data.credits.join(' · ')
  if (line === '' && !reserve) return null
  const blank = line === ''
  return (
    <Tooltip title={line}>
      <Typography
        variant="caption"
        color="text.secondary"
        noWrap
        data-testid="maps-credits"
        {...(blank ? { 'aria-hidden': true, 'data-reserved': 'true' } : {})}
        sx={{ flexShrink: 0, ...(blank ? { visibility: 'hidden' } : {}) }}
      >
        {/* A NO-BREAK space, spelled OUT rather than typed: an ordinary space collapses to
            nothing and the reserved line would be zero pixels tall, which is the bug rather
            than the fix - and an invisible byte in source is a repo rule of its own. */}
        {blank ? '\u00a0' : line}
      </Typography>
    </Tooltip>
  )
}

/**
 * usage-analytics `featureUse: mapOpen` — a map that actually RENDERED, which is a different
 * fact from "the Maps tab was visited" (`viewDwell` already carries that, including the
 * zero-maps case where this view only ever shows the picker). Fires once per loaded zone.
 *
 * The zone itself is never carried: the schema has no field a zone name could go in, and this
 * hook takes the whole `MapData` precisely so the caller never has to reach for one.
 */
function useMapOpenTracking(data: MapData | null): void {
  const loaded = data?.zone
  useEffect(() => {
    if (loaded !== undefined) trackFeature('mapOpen')
  }, [loaded])
}

export default function MapsView(): JSX.Element {
  // WHERE YOU ARE. The character module owns the raw display zone off the `zone` log event; it
  // is undefined until the log prints one, and that absence is a state this view renders.
  const raw = useModule<CharacterSnap>('character')?.zone
  const { zone, auto, mode, pick, followCurrent } = useZoneSelection(raw)
  const [prefs, setPrefs] = useState<MapPackPrefs>(loadPackPrefs)
  const [layers, setLayers] = useState<LayerMask>(DEFAULT_LAYERS)

  const { packs, zones, ready } = useMapPacks()
  const { data, error, loading } = useMapData(zone, prefs)

  // Does the chrome that describes a map hold its space? See `mapPossible` above (JOS-205).
  const reserve = mapPossible({ zones, ready })

  // THE FLOORS. `zLevels` is the raw distinct set (measured: 10,694 values in the default set's
  // crystallos.txt), so it is clustered once per loaded map and stepped through by hand — there
  // is no character z to auto-select with, and pretending otherwise would be law 1's exact sin.
  const bands = useMemo(
    () => (data ? floorBands(data.zLevels, data.heightHint ? { hint: data.heightHint } : {}) : []),
    [data]
  )
  const [floor, setFloor] = useState<number | null>(null)
  // A new zone starts on All levels — a floor index means nothing across two different maps.
  useEffect(() => setFloor(null), [data?.zone])

  useMapOpenTracking(data)

  const hostRef = useRef<HTMLDivElement>(null)
  const vp = useMapViewport({ bounds: data?.bounds ?? EMPTY_BOUNDS, id: data?.zone ?? '', hostRef })
  const { marker, onJump } = useSearchJump({ vp, zone: data?.zone, pick })
  // THE POSITION YOU TOLD IT (JOS-98). Keyed on the zone actually DRAWN, never the one being
  // fetched: a marker attributed to a map that has not loaded would be drawn against the previous
  // zone's bounds for a frame — a dot in the wrong place, which is the one thing this must not do.
  const loc = useLocMarker(data?.zone ?? null, vp)

  // THE SIDEBAR. Open by default, remembered in `eq.maps.pane`, closed from its own header. Its
  // filtered rows are derived ONCE and read by both the list and the surface's pins.
  const zoneName = zoneLongName(zone, raw)
  const pane = useZonePane({ vp, data, zoneName, prefs, zones })

  return (
    <Stack spacing={1.5} sx={{ height: '100%' }}>
      <MapsHeader title={headerTitle(zone, raw)} zone={zone} data={data} />
      {/* ALWAYS RENDERED, because the Zone selector inside it is how you leave the map you are
          on. Everything else in the bar is gated on `hasMap`. */}
      <MapToolbar
        zones={zones}
        zone={zone}
        onPick={pick}
        mode={mode}
        onFollowCurrent={followCurrent}
        hasMap={data != null}
        // A map could still be drawn here ⇒ the bar holds the row its drawing controls will need,
        // so the pane below does not move when they arrive (JOS-205; `DrawnRow` measured it).
        reserve={reserve}
        layers={layers}
        onLayers={setLayers}
        bands={bands}
        floor={floor}
        onFloor={setFloor}
        packs={packs}
        prefs={prefs}
        onPrefs={(p) => {
          setPrefs(p)
          savePackPrefs(p)
        }}
        locMarker={loc.marker}
        onPlaceLoc={loc.place}
        onShowLoc={loc.show}
        onClearLoc={loc.clear}
        zoomedIn={vp.zoomedIn}
        onZoom={vp.zoomBy}
        onFit={vp.fit}
      />
      <MapBody
        data={data}
        // Nothing is claimed before the pack listing and the first fetch have answered — a
        // panel that flashes up and vanishes reads as a bug, not as a load.
        empty={
          ready && !loading && <MapsEmpty raw={raw} auto={auto} zones={zones} zone={zone} error={error} />
        }
        vp={vp}
        hostRef={hostRef}
        layers={layers}
        bands={bands}
        floor={floor}
        pane={pane}
        zoneName={zoneName}
        marker={marker}
        locMarker={loc.marker}
        onJump={onJump}
      />
      {/* Reserved for the same reason and on the same condition as the toolbar's row (JOS-205). */}
      <MapCredits data={data} reserve={reserve} />
    </Stack>
  )
}
