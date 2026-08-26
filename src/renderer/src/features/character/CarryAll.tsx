// ============================================================================
// character/CarryAll — EVERYTHING YOU CARRY (JOS-327): the whole dump, searchable.
// ============================================================================
//
// The grid above this table draws twenty-four cells. The file it draws them from lists a hundred
// and twenty-three things on the owner's own character — bags, bank, the tradeskill depot, thirty
// seven key-ring rows — and every one of them was parsed, counted into `heldCounts` and then never
// shown to the person who typed `/outputfile inventory`. This is that list, and nothing else.
//
// READ-ONLY, DELIBERATELY. No stars, no "add to plan", no upgrade simulation, no row click. Those
// all exist one tab to the left, on surfaces whose whole job is deciding what you SHOULD have; this
// one answers "what do I have and where did I put it", and a surface that answers one question
// completely is worth more than a surface that half-answers two. A row is text.
//
// ---------------------------------------------------------------------------
// TWO CONTROLS, ONE AXIS EACH
// ---------------------------------------------------------------------------
// The box asks WHAT (a substring of the item's name) and the chips ask WHERE (which lane of
// `shared/carryAll.ts` the row is in). The split is why the search key is the name alone — folding
// the location in was measured and made `ring` match all thirty-seven `KeyRing` rows, which is not
// what anybody typing `ring` wants. See the carryAll header for the lanes themselves, including
// why there is no chip named after the Dragon's Hoard.
//
// THE CHIP CHOICE IS PERSISTED AND THE QUERY IS NOT, and that is the standing law rather than a
// coin toss: a view unmounts on every tab switch, so anything the user set ON PURPOSE lives in a
// renderer pref (JOS-90/97/116). A lane is a choice you make and keep; a half-typed search is not,
// and a box that greeted you with last week's query would be a worse surface, not a better one. The
// stored lane DEGRADES rather than errors (JOS-105): a value naming a lane this dump has no rows
// for simply reads as "All".
//
// …AND JOS-329 FOUND THE HOLE IN THAT SENTENCE, WITHOUT CHANGING WHAT IT ARGUES. "Persisted" and
// "not persisted" were being treated as the only two options, so the query was thrown away by every
// TAB SWITCH as well as by every launch — and the first of those was never the intent. The argument
// above is about what a NEW SESSION should open on, and it survives intact; what it needed was a
// second tier to be true in. The query is on the SESSION tier now (`gear/areaMemory.ts`, whose rule
// this paragraph is the original statement of): it comes back when you step to another module and
// return, and it is gone when you next launch the app, which is exactly what the sentence above
// asks for. The lane is unchanged, on the restart tier, under its own key.
//
// THE LIST IS WINDOWED AND THE BOX IS BOUNDED — `useWindowedRows` over a `tableLayout: fixed`
// table whose every row is exactly `ROW_HEIGHT` tall (the fixed-height contract, lootRows.tsx),
// inside its own `overflow: auto` scroller that takes the height the sheet above it leaves. A
// hundred and twenty-three rows would not need windowing; a bank-clearing session's dump might,
// and the pattern costs nothing.

import { type JSX, useCallback, useDeferredValue, useMemo, useRef, useState } from 'react'
import {
  Box,
  Chip,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography
} from '@mui/material'
import type { CarryAll as CarryAllData, CarryRow } from '@shared/carryAll'
import { EQ_ITEM_COLORS } from '../../lib/ItemWindow'
import { normalizeQuery } from '../../lib/search'
import { useWindowedRows } from '../../lib/useWindowedRows'
import { useRememberedSearch } from '../gear/useAreaMemory'

/** Where the chip choice is remembered. Renderer-only and machine-local, like `eq.view`. */
const LANE_KEY = 'eq.character.carryLane'

/** Dense row height (px), MUI `size="small"` — the number the windowing hook is handed. */
const ROW_HEIGHT = 37

/** The fixed-height contract as CSS — see lootRows.tsx, which states why every clause is here. */
const FIXED_ROW = {
  height: ROW_HEIGHT,
  maxHeight: ROW_HEIGHT,
  '& td': {
    py: 0,
    maxHeight: ROW_HEIGHT,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  }
} as const

/**
 * `tableLayout: fixed` — the other half of that contract. An auto-layout table sizes its columns
 * from the widest cell it can SEE, and a windowed table only ever sees a screenful, so scrolling
 * would re-measure the columns and move the row heights under a hook that assumes they cannot.
 */
const FIXED_TABLE = { tableLayout: 'fixed' } as const

/** The spacer rows that reserve the full scroll height — see useWindowedRows. */
function PadRow({ height }: { height: number }): JSX.Element | null {
  if (height <= 0) return null
  return (
    <TableRow style={{ height }}>
      <TableCell colSpan={3} sx={{ p: 0, border: 0 }} />
    </TableRow>
  )
}

/** One row: what it is, where the file says it is, and how many. */
function CarryTableRow({ row }: { row: CarryRow }): JSX.Element {
  return (
    <TableRow hover data-testid="character-carry-row" data-lane={row.lane} sx={FIXED_ROW}>
      {/* The name VERBATIM, ` +N` and all — the whole point of the column (carryAll.ts header).
          `title` rather than a popper: these are dense rows and the house rule for dense rows is a
          native tooltip (JOS-143), which is also the only thing that can show a clipped name. */}
      <TableCell sx={{ color: EQ_ITEM_COLORS.name }} title={row.name}>
        {row.name}
      </TableCell>
      <TableCell sx={{ color: 'text.secondary', fontSize: 12 }} title={row.location}>
        {row.location}
      </TableCell>
      <TableCell align="right">{row.count}</TableCell>
    </TableRow>
  )
}

/**
 * The lane chips, plus the All chip that clears them.
 *
 * Every chip prints its own count, so the partition is legible before anything is clicked — and a
 * lane with no rows was never emitted, so there is no chip here that filters to nothing.
 */
function LaneChips({
  lanes,
  lane,
  total,
  onPick
}: {
  lanes: CarryAllData['lanes']
  lane: string | null
  total: number
  onPick: (id: string | null) => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
      <Chip
        label={`All ${String(total)}`}
        size="small"
        data-testid="character-carry-chip-all"
        color={lane === null ? 'primary' : 'default'}
        variant={lane === null ? 'filled' : 'outlined'}
        onClick={() => {
          onPick(null)
        }}
      />
      {lanes.map((l) => (
        <Chip
          key={l.id}
          label={`${l.label} ${String(l.count)}`}
          size="small"
          data-testid={`character-carry-chip-${l.id}`}
          color={lane === l.id ? 'primary' : 'default'}
          variant={lane === l.id ? 'filled' : 'outlined'}
          onClick={() => {
            // Clicking the chip you are already on clears it — the same affordance both ways, so
            // nobody has to find the All chip to undo one click.
            onPick(lane === l.id ? null : l.id)
          }}
        />
      ))}
    </Stack>
  )
}

/** The remembered lane, validated against the lanes THIS dump produced (see the header). */
function loadLane(lanes: CarryAllData['lanes']): string | null {
  const stored = localStorage.getItem(LANE_KEY)
  return stored !== null && lanes.some((l) => l.id === stored) ? stored : null
}

export default function CarryAll({ carry }: { carry: CarryAllData }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [text, setText] = useRememberedSearch('eq.character.search')
  // The initializer runs once, on mount — which is once per character rebuild, since the whole tab
  // is keyed on it. A dump that changes under a mounted tab keeps whatever lane is on screen.
  const [lane, setLane] = useState<string | null>(() => loadLane(carry.lanes))
  const deferred = useDeferredValue(text)

  const pickLane = useCallback((id: string | null) => {
    setLane(id)
    if (id === null) localStorage.removeItem(LANE_KEY)
    else localStorage.setItem(LANE_KEY, id)
  }, [])

  const rows = useMemo(() => {
    const q = normalizeQuery(deferred)
    // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives CarryRow. Becomes a view descriptor when the source lands.
    return carry.rows.filter(
      (r) => (lane === null || r.lane === lane) && (q === '' || r.searchKey.includes(q))
    )
  }, [carry.rows, lane, deferred])

  const win = useWindowedRows({ count: rows.length, rowHeight: ROW_HEIGHT, scrollRef })

  return (
    <Paper
      variant="outlined"
      data-testid="character-carry"
      // `flex: 1 0 360px` PLUS `minHeight: 0`, and every term of that is load-bearing on a page
      // whose height is not clamped (CharacterView's header explains why it is not).
      //
      //   360px BASIS — the panel's hypothetical height, which is what makes it independent of the
      //     data. A flex item's hypothetical size is its CONTENT height when the basis is `auto`,
      //     and this panel's content is a 123-row table: measured, that produced a 5368px page.
      //   grow 1     — a tall window has free space after the sheet, and the ledger should have it.
      //   shrink 0   — a short one does not, and the floor is the whole point.
      //   minHeight 0 — a flex item's `min-height` defaults to `auto`, i.e. its content, which
      //     would quietly undo the basis. This is the same clause every windowed box in the app
      //     carries and the same one whose absence is always the bug.
      sx={{ p: 1, display: 'flex', flexDirection: 'column', flex: '1 0 360px', minHeight: 0 }}
    >
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'center' }} sx={{ mb: 0.75 }}>
        <Typography variant="subtitle2" sx={{ flexShrink: 0 }}>
          Everything you carry
        </Typography>
        <TextField
          size="small"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
          }}
          placeholder="Search items"
          slotProps={{ htmlInput: { 'data-testid': 'character-carry-search' } }}
          sx={{ width: { xs: '100%', md: 220 } }}
        />
        <LaneChips lanes={carry.lanes} lane={lane} total={carry.rows.length} onPick={pickLane} />
        {/* The count is the honest answer to "is the box doing anything" — and the number the e2e
            reads, because a windowed table's mounted row count is a fact about the viewport. */}
        <Typography
          variant="caption"
          color="text.secondary"
          data-testid="character-carry-count"
          sx={{ ml: { md: 'auto' }, flexShrink: 0 }}
        >
          {rows.length} of {carry.rows.length}
        </Typography>
      </Stack>

      <Box
        ref={scrollRef}
        data-testid="character-carry-list"
        sx={{
          flexGrow: 1,
          minHeight: 0,
          overflow: 'auto',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1
        }}
      >
        <Table size="small" stickyHeader sx={FIXED_TABLE} data-testid="character-carry-table">
          <TableHead>
            <TableRow>
              {/* No width on Item: the name takes whatever the two stated columns leave. */}
              <TableCell>Item</TableCell>
              <TableCell sx={{ width: '38%' }}>Location</TableCell>
              <TableCell align="right" sx={{ width: 72 }}>
                Count
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            <PadRow height={win.topPad} />
            {rows.slice(win.start, win.end).map((r) => (
              <CarryTableRow key={r.line} row={r} />
            ))}
            <PadRow height={win.bottomPad} />
          </TableBody>
        </Table>
        {rows.length === 0 && (
          <Typography
            variant="caption"
            color="text.disabled"
            data-testid="character-carry-empty"
            sx={{ display: 'block', p: 1 }}
          >
            Nothing here matches.
          </Typography>
        )}
      </Box>
    </Paper>
  )
}
