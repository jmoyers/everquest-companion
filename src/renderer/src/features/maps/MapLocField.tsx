// THE PLACE POSITIONS ARE TYPED INTO THIS APP (JOS-98) — paste a `/loc`, get a coloured marker; plus
// the chips that state every marker a zone holds.
//
// UP TO FIVE CHIPS, ONE BOX (JOS-98 wave 4). The box ADDS a typed marker — up to four, each a spot
// you name (which may not be where you stand), coloured blue → green → yellow → violet as you add
// them and cycling as you clear and re-add. The RED `player` chip sets itself from the log every
// time you /loc in game. Each chip centres on its marker on click and removes it on ✕, so a stale
// dot — of any colour — is never stuck on the map with no way to reach it.
//
// WHY A TEXT BOX ON A TOOLBAR THAT "DESCRIBES THE DRAWING". Because this control describes the
// drawing: it states the positions drawn on the surface, and the box is the only way to put a typed
// one there.
//
// THE FIELD EMPTIES ON SUCCESS AND THE CHIPS TAKE OVER. Two kinds of control, two jobs: the box is
// where a loc goes IN, the chips are what the app currently BELIEVES — stated in the game's own
// words and order so they can be checked against the game window without translation.
//
// A REFUSAL IS PROSE AND IT STAYS PUT. The message names what the parser choked on and does not
// vanish on a timer — the user is about to retype something, and an error that disappears while
// they are reading it is worse than none. It clears when they type, which is the moment it stopped
// being true.
//
// CLEARING IS ON THE CHIP, NOT ON THE MAP. The marker persists across restarts; a stray click on a
// map surface must never be able to delete something the user typed and expects to find again.
//
// NO POPPER (JOS-143). This group sits at the wrapping end of the maps toolbar, so on a narrow
// window it lands on the row BELOW the two pack selects and the zone combobox — a card opened from
// here covers them. The field's own tooltip was the worse offender for a second reason the planner
// already wrote down (`ClassFilter`, owner 2026-08-05): a hover box over an input the user types
// into floats exactly where its own affordances are and reads as the UI blocking itself. All three
// strings survive as native `title`s.

import { useState, type JSX, type KeyboardEvent } from 'react'
import { Chip, IconButton, Stack, TextField, Typography } from '@mui/material'
import AddLocationAltIcon from '@mui/icons-material/AddLocationAlt'
import CancelIcon from '@mui/icons-material/Cancel'
import PlaceIcon from '@mui/icons-material/Place'
import MyLocationIcon from '@mui/icons-material/MyLocation'
import type { EqLoc } from './mapGeometry'
import { formatLoc, MARKER_COLOR_HEX, parseLoc, type MarkerColor, type TypedMarker } from './locMarker'

export interface MapLocFieldProps {
  /** This zone's TYPED markers (up to four, coloured), set from the box. */
  typed: readonly TypedMarker[]
  /** This zone's PLAYER marker (light red), scraped from the log, or null. */
  player: EqLoc | null
  /** A well-formed reading was entered — ADD it as a typed marker for this zone. */
  onPlace: (loc: EqLoc) => void
  /** Centre the view on the typed marker of this colour. */
  onShowTyped: (color: MarkerColor) => void
  /** Forget this zone's typed marker of this colour. */
  onClearTyped: (color: MarkerColor) => void
  /** Centre the view on the player marker. */
  onShowPlayer: () => void
  /** Forget this zone's player marker (it re-appears the next time you /loc in this zone). */
  onClearPlayer: () => void
}

export default function MapLocField({
  typed,
  player,
  onPlace,
  onShowTyped,
  onClearTyped,
  onShowPlayer,
  onClearPlayer
}: MapLocFieldProps): JSX.Element {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const commit = (): void => {
    const parsed = parseLoc(text)
    if (!parsed.ok) {
      setError(parsed.reason)
      return
    }
    setError(null)
    setText('')
    onPlace(parsed.loc)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Enter') return
    commit()
    e.preventDefault()
  }

  return (
    <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap data-testid="maps-loc">
      <TextField
        size="small"
        label="/loc marker"
        placeholder="1414.20, -735.55, 12.19"
        value={text}
        error={error != null}
        data-testid="maps-loc-field"
        title="Type /loc in game and paste the line here - north/south, west/east, elevation."
        slotProps={{
          htmlInput: { 'data-testid': 'maps-loc-input', 'aria-label': 'Place a marker from a /loc' }
        }}
        onChange={(e) => {
          setText(e.target.value)
          setError(null)
        }}
        onKeyDown={onKeyDown}
        sx={{ minWidth: 210 }}
      />
      {/* The span outlives its tooltip: the button is disabled until something is typed, and a
          disabled button swallows no mouse events. */}
      <span title="Place the marker">
        <IconButton
          size="small"
          aria-label="Place the marker"
          data-testid="maps-loc-place"
          disabled={text.trim() === ''}
          onClick={commit}
        >
          <AddLocationAltIcon fontSize="small" />
        </IconButton>
      </span>
      {/* WHERE YOU ARE, scraped from the log (light red). It has no box — it sets itself when you
          /loc in game — but it gets the same centre/clear chip so a stale dot is never stuck on the
          map. `error.light` matches the crosshair's own colour (MapLocMarker). */}
      {player != null && (
        <Chip
          size="small"
          variant="outlined"
          icon={<MyLocationIcon />}
          data-testid="maps-loc-chip-player"
          title="Most recent player /loc, click to center."
          label={formatLoc(player)}
          onClick={onShowPlayer}
          onDelete={onClearPlayer}
          deleteIcon={<CancelIcon data-testid="maps-loc-clear-player" titleAccess="Remove your position marker" />}
          sx={{
            color: 'error.light',
            borderColor: 'error.light',
            '& .MuiChip-icon': { color: 'error.light' },
            '& .MuiChip-deleteIcon': { color: 'error.light' }
          }}
        />
      )}
      {/* ONE CHIP PER TYPED MARKER, in the marker's own colour. NEWEST FIRST — the row grows outward
          from the red player chip on the left, so the freshest mark is always the one next to it and
          the oldest sits at the far right, which is the one the cycle drops next. `typed` is stored
          oldest-first, so the display is reversed. All share the `maps-loc-chip` test id (a
          `data-color` tells them apart) so a count is the number placed. */}
      {[...typed].reverse().map((m) => {
        const hex = MARKER_COLOR_HEX[m.color]
        return (
          <Chip
            key={m.color}
            size="small"
            variant="outlined"
            icon={<PlaceIcon />}
            data-testid="maps-loc-chip"
            data-color={m.color}
            title="Manual marker, click to center."
            label={formatLoc(m.loc)}
            onClick={() => { onShowTyped(m.color) }}
            onDelete={() => { onClearTyped(m.color) }}
            // NAMED, because the chip carries TWO icons and they do OPPOSITE things: the leading
            // Place icon is part of the click target that centres on the marker, and this one
            // deletes it. MUI's own class names distinguish them, but a spec that clicks
            // `[chip] svg` gets the first — which is how the clear affordance was first asserted
            // green while doing nothing at all.
            deleteIcon={<CancelIcon data-testid="maps-loc-clear" data-color={m.color} titleAccess="Remove this marker" />}
            sx={{
              color: hex,
              borderColor: hex,
              '& .MuiChip-icon': { color: hex },
              '& .MuiChip-deleteIcon': { color: hex }
            }}
          />
        )
      })}
      {error != null && (
        <Typography variant="caption" color="error" data-testid="maps-loc-error" sx={{ maxWidth: 420 }}>
          {error}
        </Typography>
      )}
    </Stack>
  )
}
