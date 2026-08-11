// The Maps tab's SIDEBAR — the way you find anything on a map: what the wiki says lives in this
// zone, what the map file itself labels, and what every other installed zone labels. One box over
// all three, click to light it up on the map.
//
// IT IS THE DEFAULT EXPERIENCE, and the toolbar carries no search of its own. The bar used to
// hold a `Search labels…` box with a This zone / All zones toggle beside it, which asked the user
// to choose an authority before typing and then answered in a fourth list somewhere else on
// screen. One box, three labelled sections, is the same corpus with the choice removed.
//
// THREE SECTIONS BECAUSE THERE ARE THREE SCOPES, and blurring them would be the unlabelled
// inference the world-model laws forbid. "Named mobs" is the committed wiki catalog joined to
// this zone; "Map labels" is the parser's own `MapData.points` — the same points already drawn
// on the surface, never re-parsed; "Other zones" is SOMEWHERE ELSE, which is a different MAP and
// not a different part of this one, and says so by living under its own heading. The first two
// scopes are this map and rank first by simply being above; the third is the rest of the world.
//
// THE THIRD SECTION CARRIES TWO AUTHORITIES AND NAMES BOTH PER ROW (JOS-135): the installed map
// packs' label text (`maps:search` with no zone) and the wiki bestiary matched on mob name. They
// are ranked into one list because they answer one question, and every row states its zone, its
// kind and what it can and cannot tell you — so a wiki claim never reads as a map fact.
//
// THE HONEST BIT IS THE PIN AFFORDANCE. Roughly four in five catalog pages state coordinates;
// the rest say "Various" or "?" (MEASURED, 2026-08-04: 6,283 of 7,866 state at least one). A mob
// with no stated position is STILL LISTED — it lives here, and that is the fact the pane exists
// to carry — but it has no pin mark, it is not clickable, and the header chip says how many of
// the listed mobs are placeable at all. There is no zone-centre fallback and there must never be
// one (world-model law 1).
//
// PURELY PRESENTATIONAL. Query, filtering and selection live in `useMapPane` one level up,
// because the SURFACE pins the same filtered rows this list shows: one derivation, two readers,
// never a frame out of step.
//
// FIXED HEIGHT, OWN SCROLLER (AGENTS.md: "a growing list lives in a FIXED-height scroll box").
// All three sections share one `flexGrow:1; minHeight:0; overflow:auto` column, so 343 mobs
// scroll inside the pane instead of pushing the map out of the window.
//
// THE PANE DOES NOT EXIST WHEN IT IS OFF. MapBody renders nothing rather than a zero-width box,
// so the map's flex child is the only thing in the row and the ResizeObserver sees one clean
// resize on close — no width animation, no fixed-size arithmetic, nothing that could feed back
// into its own measurement. Closing it is this pane's own button; reopening is the affordance
// MapBody floats over the map, because a control that hides a panel has to live somewhere the
// panel is not.

import type { JSX } from 'react'
import {
  Box,
  Chip,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import PlaceIcon from '@mui/icons-material/Place'
import { jumpTarget, type CrossZoneRow, type JumpTarget } from './crossZone'
import {
  MAX_PINS,
  isLocatable,
  type LabelPaneRow,
  type MapPaneRow,
  type MobPaneRow,
  type PaneCounts
} from './mobPins'
import { Tooltip } from '../../lib/Tooltip'

/** The pane's width. Fixed and `flexShrink:0` so the map, not the list, absorbs a window resize. */
export const PANE_WIDTH = 268

/** Rendered rows per section. The list is a filter, not a pager; typing is how you reach row 400. */
const SECTION_ROWS = 300

export interface MapMobPaneProps {
  /** Null ⇒ no zone is open, which the mob section states rather than showing an empty list. */
  zoneName: string | null
  /** Is a map actually DRAWN? The label section says which kind of nothing it is showing. */
  hasMap: boolean
  mobs: readonly MobPaneRow[]
  labels: readonly LabelPaneRow[]
  /** Matches in every OTHER zone, map labels and wiki mobs alike, under their own heading. */
  hits: readonly CrossZoneRow[]
  counts: PaneCounts
  query: string
  onQuery: (q: string) => void
  selectedId: string | null
  onSelect: (row: MapPaneRow) => void
  /** A cross-zone hit was clicked: change zone, then centre on it when it named a spot. */
  onHit: (to: JumpTarget) => void
  /** The drawn pin set hit its ceiling — said out loud rather than quietly trimmed. */
  pinsCapped: boolean
  onClose: () => void
}

/** The pin affordance: present exactly when the row has a real coordinate behind it. */
function PinMark({ locatable }: { locatable: boolean }): JSX.Element {
  return (
    <Box sx={{ width: 18, display: 'flex', justifyContent: 'center', flexShrink: 0, pt: 0.25 }}>
      {locatable ? (
        <PlaceIcon data-testid="maps-pane-pin" sx={{ fontSize: 15, color: 'warning.main' }} />
      ) : (
        // Deliberately EMPTY, not a greyed pin: a dimmed marker still reads as "there is a
        // position here, somewhere", and there is not.
        <Box sx={{ width: 15 }} />
      )}
    </Box>
  )
}

/**
 * The one-line "and what else does this row know" text. Null when it knows nothing extra.
 *
 * The two "no pin" reasons are DIFFERENT FACTS and are said differently: a page that stated
 * nothing, and a page that stated a position but named several zones so it cannot be attributed
 * to this map. Collapsing them into one message would misreport the second as missing data.
 */
function rowNote(row: MapPaneRow): string | null {
  if (row.kind !== 'mob') return null
  if (row.unattributable) return `position stated, but the page lists ${String(row.zoneCount)} zones`
  if (row.pins.length === 0) return 'no location on the wiki page'
  return row.pins.length > 1 ? `${String(row.pins.length)} spawn points` : null
}

function Row({
  row,
  selected,
  onSelect
}: {
  row: MapPaneRow
  selected: boolean
  onSelect: (row: MapPaneRow) => void
}): JSX.Element {
  const locatable = isLocatable(row)
  const level = row.kind === 'mob' ? row.level : undefined
  return (
    <ListItemButton
      dense
      disabled={!locatable}
      selected={selected}
      data-testid={row.kind === 'mob' ? 'maps-pane-mob' : 'maps-pane-label'}
      onClick={() => {
        onSelect(row)
      }}
      sx={{ gap: 0.75, alignItems: 'flex-start' }}
    >
      <PinMark locatable={locatable} />
      <ListItemText
        primary={row.name}
        secondary={rowNote(row)}
        slotProps={{ primary: { variant: 'body2', noWrap: true }, secondary: { variant: 'caption' } }}
      />
      {level !== undefined && level !== '' && (
        <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0, pt: 0.25 }}>
          {level}
        </Typography>
      )}
    </ListItemButton>
  )
}

/** The heading that names an AUTHORITY. Every list in this pane sits under exactly one. */
function SectionHead({ title, note }: { title: string; note: string }): JSX.Element {
  return (
    <Stack direction="row" spacing={0.75} alignItems="baseline" sx={{ px: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      <Typography variant="caption" color="text.disabled" noWrap>
        {note}
      </Typography>
    </Stack>
  )
}

/** One titled section with its own list. An empty section still renders its title and says why. */
function Section({
  title,
  note,
  rows,
  selectedId,
  onSelect,
  empty
}: {
  title: string
  note: string
  rows: readonly MapPaneRow[]
  selectedId: string | null
  onSelect: (row: MapPaneRow) => void
  empty: string
}): JSX.Element {
  return (
    <Stack spacing={0.5} sx={{ mb: 1 }}>
      <SectionHead title={title} note={note} />
      {rows.length > 0 ? (
        <List dense disablePadding>
          {rows.slice(0, SECTION_ROWS).map((r) => (
            <Row key={r.id} row={r} selected={r.id === selectedId} onSelect={onSelect} />
          ))}
        </List>
      ) : (
        <Typography variant="caption" color="text.disabled" sx={{ px: 1, pb: 0.5 }}>
          {empty}
        </Typography>
      )}
    </Stack>
  )
}

/**
 * ONE cross-zone row: what it is, which zone it is in, and what that zone can tell you.
 *
 * The second line is the ZONE FIRST, always, because the zone is the answer this section exists to
 * give (JOS-135: "which zone is Tarn Visilin in?"). The row's own note follows it when there is
 * one, so a row that cannot take you anywhere says why on the same line rather than by being
 * mysteriously dead.
 */
function HitRow({ row, onHit }: { row: CrossZoneRow; onHit: (to: JumpTarget) => void }): JSX.Element {
  const to = jumpTarget(row)
  return (
    <ListItemButton
      dense
      disabled={to == null}
      data-testid="maps-pane-hit"
      data-kind={row.kind}
      data-zone={row.zone ?? ''}
      onClick={() => {
        if (to) onHit(to)
      }}
      sx={{ gap: 0.75, alignItems: 'flex-start' }}
    >
      {/* The pin column states whether this row lands on a SPOT. A map label always does; a wiki
          mob does only when its page stated a position it can attribute to that one zone. */}
      <PinMark locatable={row.at != null} />
      <ListItemText
        primary={row.name}
        secondary={row.note == null ? row.zoneName : `${row.zoneName} · ${row.note}`}
        slotProps={{
          primary: { variant: 'body2', noWrap: true },
          secondary: { variant: 'caption' }
        }}
      />
      {row.level !== undefined && row.level !== '' && (
        <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0, pt: 0.25 }}>
          {row.level}
        </Typography>
      )}
    </ListItemButton>
  )
}

/**
 * THE CROSS-ZONE SECTION — an answer from a DIFFERENT map, so every row names its zone.
 *
 * TWO AUTHORITIES, ONE RANKED LIST (JOS-135). It used to be map-label text only, which is why
 * searching a High Keep NPC from High Pass answered nothing: no pack labels him. The wiki's
 * bestiary answers that question and the map corpus answers "what is that place called", so both
 * feed one list scored by the same scorer — see crossZone.ts for why merging them is honest and
 * why the zone tokens are kept out of the query side.
 *
 * Absent until the box has something in it, because with no query it would be the whole corpus and
 * a scroll bar to nowhere. Clicking one loads that zone, so the row is a doorway out of this map
 * rather than a thing to select on it: it carries no selection ring. A pick here PINS the map
 * (JOS-97) — an explicit choice, which is exactly the case that rule exists to honour.
 */
function HitSection({
  query,
  hits,
  onHit
}: {
  query: string
  hits: readonly CrossZoneRow[]
  onHit: (to: JumpTarget) => void
}): JSX.Element | null {
  if (query.trim().length === 0) return null
  return (
    <Stack spacing={0.5} sx={{ mb: 1 }}>
      <SectionHead title="Other zones" note="every map + the wiki" />
      {hits.length > 0 ? (
        <List dense disablePadding>
          {hits.map((row) => (
            <HitRow key={row.id} row={row} onHit={onHit} />
          ))}
        </List>
      ) : (
        <Typography variant="caption" color="text.disabled" sx={{ px: 1, pb: 0.5 }}>
          Nothing anywhere else answers to that.
        </Typography>
      )}
    </Stack>
  )
}

export default function MapMobPane(props: MapMobPaneProps): JSX.Element {
  const { zoneName, hasMap, mobs, labels, hits, counts, query, onQuery } = props
  const { selectedId, onSelect, onHit, pinsCapped, onClose } = props
  return (
    <Paper
      variant="outlined"
      data-testid="maps-pane"
      sx={{
        width: PANE_WIDTH,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden'
      }}
    >
      <Box sx={{ p: 1, pb: 0.75, flexShrink: 0 }}>
        <Stack direction="row" spacing={0.5} alignItems="center">
          <TextField
            size="small"
            fullWidth
            placeholder="Find a mob or label…"
            value={query}
            onChange={(e) => {
              onQuery(e.target.value)
            }}
            slotProps={{ htmlInput: { 'data-testid': 'maps-pane-search' } }}
          />
          <Tooltip title="Hide this panel">
            <IconButton size="small" data-testid="maps-pane-close" onClick={onClose}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
        <Stack direction="row" spacing={0.5} sx={{ mt: 0.75 }} flexWrap="wrap" useFlexGap>
          <Tooltip
            title={`${String(counts.located)} of ${String(counts.mobs)} named mobs here state a position`}
          >
            <Chip
              size="small"
              variant="outlined"
              data-testid="maps-pane-counts"
              label={`${String(counts.located)}/${String(counts.mobs)} placed`}
            />
          </Tooltip>
          <Chip size="small" variant="outlined" label={`${String(counts.labels)} labels`} />
          {pinsCapped && (
            <Tooltip title="Narrow the search to see the rest">
              <Chip
                size="small"
                color="warning"
                variant="outlined"
                data-testid="maps-pane-capped"
                label={`first ${String(MAX_PINS)} pinned`}
              />
            </Tooltip>
          )}
        </Stack>
      </Box>

      <Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto' }} data-testid="maps-pane-scroll">
        <Section
          title="Named mobs"
          note="wiki"
          rows={mobs}
          selectedId={selectedId}
          onSelect={onSelect}
          empty={
            zoneName == null
              ? 'No zone is open.'
              : counts.mobs === 0
                ? 'The mob catalog has no rows for this zone.'
                : 'No mob matches.'
          }
        />
        <Section
          title="Map labels"
          note="this map"
          rows={labels}
          selectedId={selectedId}
          onSelect={onSelect}
          empty={
            !hasMap
              ? 'No map is open.'
              : counts.labels === 0
                ? 'This map has no label points.'
                : 'No label matches.'
          }
        />
        <HitSection query={query} hits={hits} onHit={onHit} />
      </Box>
    </Paper>
  )
}
