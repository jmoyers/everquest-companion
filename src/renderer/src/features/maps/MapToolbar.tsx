// The map viewer's CONTROLS: the zone selector, zoom / fit, the layer toggles, the per-layer
// pack choice.
//
// THE ZONE SELECTOR AND THE MODE ARE THE ONLY CONTROLS THAT RENDER WITH NO MAP ON SCREEN, and
// they render FIRST. Everything else here describes the drawing — which layers, which floor,
// which pack — and a control that states a fact about nothing is worse than an absent one. Those
// two are the opposite case: they are how you get a map at all, how you leave the one you have
// (MapZoneSelect.tsx carries why that has to be permanent), and which of you and the log chose
// what is on screen (JOS-97 — see ZoneModeControls).
//
// STATE, NEVER PROCESS (AGENTS.md UI conventions). Every control here states a fact — which
// layers are drawn, which pack each half came from, which zone is open. Nothing narrates.
//
// …AND NOTHING HERE MOVES WHEN THE MAP ARRIVES (JOS-205). This is a WRAPPING row above the content
// area, so every control that appears with the map used to push the map down and shrink it. The
// row now holds the space its drawing controls will need while the map is in flight — see
// `DrawnRow` at the bottom, which carries the measurement.
//
// AND NOTHING ON THIS ROW MOUNTS A POPPER (JOS-143). It is a WRAPPING row of controls, three of
// which are dropdowns — the zone combobox and the two pack selects — and every popper on it was a
// hit target sitting in the space where a neighbour's option list opens. The zone-mode chip is the
// clearest case: it sits immediately right of the zone selector, so its card and that selector's
// dropdown claim the same rectangle, and MUI tooltips take pointer events. Hover text that is
// load-bearing survives as a native `title`: not in the DOM, no hit area, cannot eat a click. The
// icon-only buttons keep an `aria-label` too, because a title is decoration and a name is not.
//
// THE ONE BOX THAT IS NOT A CONTROL OVER THE MAP FILE is the `/loc` field (JOS-98,
// MapLocField.tsx): it states, and lets you set, the single position the app has been TOLD. It
// earns its place on a row about the drawing because that is exactly what it is — the marker is
// drawn on the surface, and this is the only way one gets there. It is gated on `hasMap` with the
// rest: a coordinate typed against no map has nowhere to land.
//
// NOTHING HERE SEARCHES. The bar used to carry a `Search labels…` box, a This zone / All zones
// scope toggle and a sidebar toggle called `Zone` — three controls asking the same question the
// sidebar's one box now answers, in a hit list that lived somewhere else entirely (MapMobPane.tsx
// carries the merge). What is left describes the DRAWING, which is the only thing this row was
// ever coherent about.
//
// WHY THE PACK CHOICE IS PER LAYER, and why `Auto` is the default: MEASURED (§1a) — the game's
// own map set holds 285 label points across 58 files while the shipped Brewall pack holds 26,607
// across 562. Geometry wants the EQL-authored default set; labels are a Brewall-pack feature.
// `Auto` is that resolution order, and it is what makes the search box non-empty on a stock
// install. Naming a pack here only overrides the order, never the merge.
//
// THE LEGEND LAYER IS OFF BY DEFAULT and that is not cosmetic: `_2` files draw a colour key at
// fixed off-map coordinates (measured, `brewall\airplane_2.txt`: y ∈ [-250, 4800] against a map
// of y ∈ [-1668, 1737]). It is excluded from the bounds by the parser, so switching it on shows
// it sitting outside the zone rather than shrinking the zone to a speck.

import type { JSX, KeyboardEvent } from 'react'
import {
  Box,
  Button,
  Chip,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup
} from '@mui/material'
import ZoomInIcon from '@mui/icons-material/ZoomIn'
import ZoomOutIcon from '@mui/icons-material/ZoomOut'
import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrong'
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp'
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown'
import MyLocationIcon from '@mui/icons-material/MyLocation'
import PushPinIcon from '@mui/icons-material/PushPin'
import ExploreIcon from '@mui/icons-material/Explore'
import type { MapLayer, MapPackInfo, MapPackPrefs, ZoneShort } from '@shared/maps'
import { bandLabel, type FloorBand } from './floorSlice'
import type { EqLoc, LayerMask } from './mapGeometry'
import type { MarkerColor, TypedMarker } from './locMarker'
import ZoneSelect from './MapZoneSelect'
import MapLocField from './MapLocField'
import type { ZoneMode } from './zoneFollow'

/** The three optional layers, in file order. Layer 0 (the zone's geometry) is always drawn. */
const TOGGLEABLE: { layer: MapLayer; label: string }[] = [
  { layer: 1, label: 'Labels' },
  { layer: 2, label: 'Legend' },
  { layer: 3, label: 'Extra' }
]

/**
 * The FLOOR STEPPER — a discrete walk up and down the zone's clustered elevations (§8).
 *
 * IT IS MANUAL, AND SAYING SO IS THE POINT. The in-game height filter follows your CHARACTER
 * ("N units above and below"); the log states the zone you entered and nothing else positional,
 * so there is no character z here and no honest auto-select. Default is All levels; the control
 * never claims to know which floor you are standing on (world-model law 1 and law 6).
 *
 * Compact by construction — two arrows and a chip — because a dozen bands as a button group
 * would be wider than every other control on this row put together. Fully keyboard operable:
 * both arrows are real buttons, and ↑/↓/Home work anywhere in the group.
 *
 * ONE BAND IS NOT A SLICE, AND THE CONTROL STILL HOLDS ITS SPACE (JOS-205). There is nothing to
 * step between, so the stepper states nothing and is invisible — but this row WRAPS, and a control
 * that appears and disappears changes how many lines the bar occupies, which moves the map below
 * it. `visibility:hidden` is the one way to be absent from the screen, from the tab order and from
 * the accessibility tree while still being absent from NOTHING that decides the layout.
 */
function FloorStepper({
  bands,
  floor,
  onFloor
}: {
  bands: readonly FloorBand[]
  floor: number | null
  onFloor: (floor: number | null) => void
}): JSX.Element {
  const empty = bands.length < 2
  const at = floor ?? -1
  // -1 is "All levels", so the list is [All, floor 1 … floor N] and stepping is plain arithmetic.
  const step = (d: number): void => {
    const next = Math.min(bands.length - 1, Math.max(-1, at + d))
    onFloor(next < 0 ? null : next)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowUp') step(1)
    else if (e.key === 'ArrowDown') step(-1)
    else if (e.key === 'Home') onFloor(null)
    else return
    e.preventDefault()
  }
  const band = floor == null ? null : bands[floor]
  return (
    <Stack
      direction="row"
      spacing={0.25}
      alignItems="center"
      data-testid="maps-floors"
      {...(empty ? { 'aria-hidden': true, 'data-reserved': 'true' } : {})}
      sx={empty ? { visibility: 'hidden' } : undefined}
      onKeyDown={onKeyDown}
    >
      {/* The spans stay: a DISABLED button swallows no mouse events, so the hover text has to
          hang on the wrapper to be readable at the top and bottom of the stack. */}
      <span title="Lower level">
        <IconButton
          size="small"
          aria-label="Lower level"
          data-testid="maps-floor-down"
          disabled={at <= -1}
          onClick={() => { step(-1) }}
        >
          <KeyboardArrowDownIcon fontSize="small" />
        </IconButton>
      </span>
      <Chip
        size="small"
        variant={floor == null ? 'outlined' : 'filled'}
        data-testid="maps-floor-label"
        title={band ? `Elevation ${bandLabel(band)}` : 'Every elevation'}
        onClick={() => { onFloor(null) }}
        label={floor == null ? 'All levels' : `Level ${String(floor + 1)} of ${String(bands.length)}`}
        sx={{ minWidth: 104 }}
      />
      <span title="Higher level">
        <IconButton
          size="small"
          aria-label="Higher level"
          data-testid="maps-floor-up"
          disabled={at >= bands.length - 1}
          onClick={() => { step(1) }}
        >
          <KeyboardArrowUpIcon fontSize="small" />
        </IconButton>
      </span>
    </Stack>
  )
}

/**
 * WHOSE ANSWER IS ON SCREEN — the map's mode, stated, plus the one way back (JOS-97).
 *
 * A SILENT MODE WOULD BE THE NEXT BUG REPORT. Once a manual pick survives zoning and navigation,
 * "the map is not following me any more" and "the map is broken" look identical from outside, so
 * the chip states which rule is in force at all times: `Following you` while the log wins,
 * `Pinned` while your pick does. It states, it does not narrate (the toolbar's rule).
 *
 * THE WAY BACK IS A LABELLED BUTTON, NOT A SECOND CLICK ON THE CHIP. `Current zone` appears only
 * in the mode where it does something, says what it will do, and is the ONLY thing that ends a
 * pin — a pick is not a timeout, so the app never ends one on its own schedule (zoneFollow.ts).
 */
function ZoneModeControls({
  mode,
  onFollowCurrent
}: {
  mode: ZoneMode
  onFollowCurrent: () => void
}): JSX.Element {
  const pinned = mode === 'pinned'
  return (
    <>
      {/* THE popper that had to go first (JOS-143): this chip is the control immediately right of
          the zone combobox, so its card opened into the space that combobox's option list uses. */}
      <Chip
        size="small"
        data-testid="maps-zone-mode"
        data-mode={mode}
        variant={pinned ? 'filled' : 'outlined'}
        icon={pinned ? <PushPinIcon /> : <ExploreIcon />}
        title={
          pinned
            ? 'This map is the one you picked. Zoning will not change it.'
            : 'This map follows the zone your character is in.'
        }
        label={pinned ? 'Pinned' : 'Following you'}
      />
      {pinned && (
        <Button
          size="small"
          data-testid="maps-zone-current"
          startIcon={<MyLocationIcon />}
          title="Show the zone your character is in - and follow it again from now on."
          onClick={onFollowCurrent}
        >
          Current zone
        </Button>
      )}
    </>
  )
}

export interface MapToolbarProps {
  /** Every stem any installed pack provides, ascending — the selector's corpus. */
  zones: readonly ZoneShort[]
  /** The stem the viewer is pointed at, drawn or not. */
  zone: ZoneShort | null
  onPick: (zone: ZoneShort) => void
  /** Is this map the log's answer or the user's? Stated beside the selector, never implied. */
  mode: ZoneMode
  /** Snap to the character's zone and follow it again — the only end to a pin. */
  onFollowCurrent: () => void
  /** Is a map actually DRAWN? Everything but the selector describes the drawing, so nothing
   *  else renders without one — a floor stepper over no floors states nothing. */
  hasMap: boolean
  /** A map COULD still be drawn here (JOS-205). No control appears, but the row they will need is
   *  held — see `DrawnRow`. False only on a machine with no map packs, where none ever can. */
  reserve: boolean
  layers: LayerMask
  onLayers: (layers: LayerMask) => void
  /** The zone's clustered floors, ascending. Fewer than two ⇒ the stepper is invisible but still
   *  occupies its space, so the bar's line count cannot depend on the map (JOS-205). */
  bands: readonly FloorBand[]
  /** The active floor index, or null for All levels. */
  floor: number | null
  onFloor: (floor: number | null) => void
  packs: readonly MapPackInfo[]
  prefs: MapPackPrefs
  onPrefs: (prefs: MapPackPrefs) => void
  /** This zone's TYPED markers (up to four, coloured) and PLAYER marker (light red) (JOS-98). */
  typedMarkers: readonly TypedMarker[]
  playerMarker: EqLoc | null
  onPlaceLoc: (loc: EqLoc) => void
  onShowTyped: (color: MarkerColor) => void
  onClearTyped: (color: MarkerColor) => void
  onShowPlayer: () => void
  onClearPlayer: () => void
  /** The view is tighter than the whole zone — zoom-out and Fit have something to do. */
  zoomedIn: boolean
  /** > 1 zooms in, < 1 out, around the pane centre. */
  onZoom: (factor: number) => void
  onFit: () => void
}

/**
 * The "no preference" option's value.
 *
 * A SENTINEL rather than `''`: an empty-string value renders an empty closed select, so the only
 * thing visible is the floating field label and the control reads as if it had failed to load.
 * `Auto` is a real, statable choice — it is the cross-pack resolution order (§6.3) — so it says
 * so. The `#` makes it unspellable as a pack id — ids are directory names run through
 * `isSafePackId` (`/^[A-Za-z0-9_][A-Za-z0-9._-]*$/`), so no real pack can ever collide with it.
 */
const AUTO = '#auto'

/** One `<TextField select>` over the installed packs. `AUTO` is the resolution order. */
function PackSelect({
  label,
  value,
  packs,
  onChange
}: {
  label: string
  value: string | undefined
  packs: readonly MapPackInfo[]
  onChange: (id: string | undefined) => void
}): JSX.Element {
  return (
    <TextField
      select
      size="small"
      label={label}
      value={value ?? AUTO}
      onChange={(e) => {
        onChange(e.target.value === AUTO ? undefined : e.target.value)
      }}
      sx={{ minWidth: 150 }}
    >
      <MenuItem value={AUTO}>Auto</MenuItem>
      {packs.map((p) => (
        <MenuItem key={p.id} value={p.id}>
          {p.name}
        </MenuItem>
      ))}
    </TextField>
  )
}

/**
 * The controls that describe the DRAWING — absent when there is nothing drawn.
 *
 * A Fragment, not a Box: `Stack useFlexGap` spaces its DOM children, and a wrapper here would
 * collapse eight controls into one gap-spaced unit and re-open the layout question the toolbar
 * already answered.
 */
function DrawnControls(props: MapToolbarProps): JSX.Element {
  const { layers, onLayers, bands, floor, onFloor, packs, prefs, onPrefs } = props
  const { zoomedIn, onZoom, onFit } = props
  const { typedMarkers, playerMarker, onPlaceLoc } = props
  const { onShowTyped, onClearTyped, onShowPlayer, onClearPlayer } = props
  const on = TOGGLEABLE.filter((t) => layers[t.layer]).map((t) => String(t.layer))
  return (
    <>
      <Box>
        <IconButton
          size="small"
          aria-label="Zoom in"
          title="Zoom in"
          data-testid="maps-zoom-in"
          onClick={() => { onZoom(1.35) }}
        >
          <ZoomInIcon fontSize="small" />
        </IconButton>
        <IconButton
          size="small"
          aria-label="Zoom out"
          title="Zoom out"
          data-testid="maps-zoom-out"
          onClick={() => { onZoom(1 / 1.35) }}
        >
          <ZoomOutIcon fontSize="small" />
        </IconButton>
        <span title="Fit the whole zone">
          <IconButton
            size="small"
            aria-label="Fit the whole zone"
            data-testid="maps-fit"
            disabled={!zoomedIn}
            onClick={onFit}
          >
            <CenterFocusStrongIcon fontSize="small" />
          </IconButton>
        </span>
      </Box>

      <ToggleButtonGroup
        size="small"
        value={on}
        data-testid="maps-layers"
        onChange={(_e, next: string[]) => {
          onLayers([true, next.includes('1'), next.includes('2'), next.includes('3')])
        }}
      >
        {TOGGLEABLE.map((t) => (
          <ToggleButton key={t.layer} value={String(t.layer)} data-testid={`maps-layer-${String(t.layer)}`}>
            {t.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      <FloorStepper bands={bands} floor={floor} onFloor={onFloor} />

      <PackSelect
        label="Geometry"
        value={prefs.geometry}
        packs={packs}
        onChange={(id) => {
          onPrefs({ ...prefs, ...(id == null ? { geometry: undefined } : { geometry: id }) })
        }}
      />
      <PackSelect
        label="Labels"
        value={prefs.labels}
        packs={packs}
        onChange={(id) => {
          onPrefs({ ...prefs, ...(id == null ? { labels: undefined } : { labels: id }) })
        }}
      />

      {/* The two positions the app can hold, and the only way one is typed in (JOS-98). It belongs
          on this row for the row's own reason: it describes what is DRAWN on the surface. */}
      <MapLocField
        typed={typedMarkers}
        player={playerMarker}
        onPlace={onPlaceLoc}
        onShowTyped={onShowTyped}
        onClearTyped={onClearTyped}
        onShowPlayer={onShowPlayer}
        onClearPlayer={onClearPlayer}
      />
    </>
  )
}

/**
 * THE DRAWING CONTROLS, AND THE SPACE THEY TAKE UP BEFORE THEY EXIST (JOS-205).
 *
 * MEASURED, on the owner's report that the map "bounces around" on load: this bar is 40 px tall
 * with only the zone selector on it and 88 px once a map arrives and eight more controls wrap it
 * onto a second line — so the map pane below started 48 px lower and 48 px shorter than it had
 * been a frame earlier, and everything on screen moved. The map is not what changed size; its
 * CHROME is.
 *
 * So the row is held while the map is in flight, by rendering the very controls that will fill it
 * with `visibility:hidden`. Nothing else can be as exact: the height of a wrapping row is a
 * function of its contents and the window's width, and no reserved constant can know either. A
 * `display:contents` wrapper keeps them DOM SIBLINGS of the selector — `Stack useFlexGap` spaces
 * its flex items, and a real box here would collapse eight controls into one unwrappable unit and
 * change the very number this exists to keep constant. `visibility` is inherited, so the one
 * declaration reaches every control; hidden controls are out of the tab order and take no hover.
 *
 * It reserves whenever a map could still be drawn (`reserve`, decided by the view). The one state
 * that does not is the machine with no map packs at all: nothing can ever draw there, so a held
 * row would be claiming otherwise. Everything else — the fetch in flight, the frame before the
 * character module has said where you are, a zone the table cannot place — is a map that may yet
 * arrive, and holding the row is also what stops the bounce when the picker finally yields one.
 */
function DrawnRow(props: MapToolbarProps): JSX.Element | null {
  if (props.hasMap) return <DrawnControls {...props} />
  if (!props.reserve) return null
  return (
    <Box aria-hidden data-testid="maps-toolbar-reserved" sx={{ display: 'contents', visibility: 'hidden' }}>
      <DrawnControls {...props} />
    </Box>
  )
}

export default function MapToolbar(props: MapToolbarProps): JSX.Element {
  const { zones, zone, onPick, mode, onFollowCurrent } = props
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      flexWrap="wrap"
      useFlexGap
      data-testid="maps-toolbar"
      sx={{ flexShrink: 0 }}
    >
      <ZoneSelect zones={zones} zone={zone} onPick={onPick} />
      {/* Beside the selector and OUTSIDE the `hasMap` gate, for the same reason the selector is:
          "which rule is choosing the map" is exactly the question a user has when no map drew. */}
      <ZoneModeControls mode={mode} onFollowCurrent={onFollowCurrent} />
      <DrawnRow {...props} />
    </Stack>
  )
}
