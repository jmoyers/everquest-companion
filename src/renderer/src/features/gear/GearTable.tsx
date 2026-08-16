// gear/GearTable.tsx — the windowed table: one uniform row per candidate item.
//
// THE FIXED-HEIGHT CONTRACT (JOS-260, lootRows.tsx states the full argument). `useWindowedRows` is
// a FIXED-row-height hook: every spacer, index and scroll offset it computes assumes each row is
// exactly `ROW_HEIGHT`, so a row that wraps to two lines desyncs the whole window and the drift
// compounds with every row above the viewport. `height` alone is only a MINIMUM for a table row,
// so the row states a maximum too and every cell is one clipped, ellipsised line — and the table
// is `tableLayout: fixed` with PERCENTAGE widths, so the columns are taken from the header alone
// (a windowed table can only ever SEE a screenful, and an auto layout would re-measure its columns
// every time scrolling swapped the rows underneath).
//
// A ROW'S KEY IS `row.key` — `itemKey(name)`, the corpus join key every other index in this app
// uses (loot, ownership, donors). That is deliberate and load-bearing beyond React, and phase 4
// (JOS-285) is what it was for: the OWNED column appends after `visibleColumns`' numerics and its
// cell is one `Map.get(row.key)` — no name matching, no normalising, nothing per row but a lookup.
// The words in that cell are all decided in `gearOwnership.ts`, which is pure and node-tested; the
// only judgement made HERE is that no witness at all means no column, because a blank ownership
// cell and "you do not own this" are two different statements and the app cannot tell them apart.
//
// NO MUI TOOLTIP ANYWHERE (JOS-143). These are dense rows under a toolbar full of selects and a
// slider; an interactive popper opened from the first row lands on those controls and eats the
// clicks aimed at them. Every explanation is a native `title`.
//
// …AND SINCE JOS-338 THERE IS EXACTLY ONE POPPER, WHICH IS THE NARROWING JOS-181 ALREADY MADE
// ELSEWHERE. The sentence above was never about the popper existing — it was about an INTERACTIVE
// card belonging to a row BELOW the toolbar, opening UPWARD across it and holding the pointer while
// it was up. The owner ruled that trade the other way on the Sky tab (JOS-181) and has now asked for
// the card here: hovering a row shows what the item would REPLACE. So the rule narrows to what it
// was always about, and the guarantee is structural rather than a promise — the cards are mounted
// through ONE wrapper (`GearCompareCard.tsx`'s `GearRowCompare`) that always opens them BELOW the
// row and clamped inside the window, never above it, with no pointer events at all and a
// capture-phase pointerdown close (JOS-344 rewrote that geometry; read its header). Every
// OTHER explanation in this file is still a native `title`, including both of the wish control's
// (JOS-343 kept them native when it took the heart away): a caption is not a card, and nothing else
// here grows a popper.
//
// AND SINCE JOS-297 THE COLUMN SET CAN BE WIDER THAN THE PANE. Nothing above changes: the table is
// still `tableLayout: fixed`, the row is still exactly `ROW_HEIGHT` tall with one clipped line per
// cell, and the windowing hook's contract does not know that widths exist. What changes is where
// the widths come from — `gearTableLayout` states percentages while they fit and stated pixels plus
// a table `minWidth` once they do not, so a thirty-column set overflows the table's OWN scroller
// (GearView's `gear-list` box, already `overflow: auto`) and never the page. Both halves are
// measured in `tests/e2e/gearColumnSteps.mts`, container-scroll and page-no-scroll in one step.
//
// AND SINCE JOS-335 A SEARCH ROW HAS A GESTURE AGAIN: it goes on the wish list. The tombstone in
// the name cell below records that JOS-325 took the sets `+` away and left the table with no
// per-row action at all, while the Exaltations donor rows kept theirs (JOS-326 re-aimed that button
// at the wish list). This restores the parity: same door (`useWishlist`), same document, same
// dedupe. What it deliberately does NOT restore is a COLUMN — the control shares the item name's
// cell exactly as the `+` did, because `gearTableLayout` states the width of every other column and
// a new one would be a change to the layout contract for one small control.
//
// …AND SINCE JOS-343 THAT GESTURE IS THE DONOR ROW'S CONTROL, WORD FOR WORD, AND IT TOGGLES (owner
// ruling 2026-08-13, one day after the heart shipped). Two JOS-335 arguments were overruled and
// both used to be argued at length right here, so both are named rather than quietly deleted:
//
//   * THE HEART. JOS-335 chose an ICON over the donor row's text button and the case was WIDTH —
//     `tableLayout: fixed`, a name column with no stated width to spare, 6,766 rows. The owner
//     overruled it for PARITY: the two surfaces are one feature and a reader should not have to
//     learn it twice. The width was a real measurement, not an excuse, so it is answered rather
//     than dropped — the shared control takes a `compact` wording for this table, and
//     `tests/e2e/gearWishSteps.mts` measures what it leaves the item name in the browser.
//   * THE LIT NO-OP. A lit heart accepted clicks and did nothing, on the reasoning that `addWish`
//     dedupes so the model was the enforcement. Overruled: the second click REMOVES, through
//     `useWishlist.remove` — the same entry delete the Wish list tab's own per-row remove calls.
//
// The control itself is `features/wishlist/WishToggle.tsx` now; nothing about it is decided here.

import { type JSX, memo, useMemo } from 'react'
import { Box, Stack, Table, TableBody, TableCell, TableRow } from '@mui/material'
import type { WindowedRows } from '../../lib/useWindowedRows'
import { itemIconUrl } from '../../lib/ItemWindow'
import { EraChip, DonorName } from '../planner/PlannerChips'
import { NUMERIC_PAD, defaultColumnPx, gearColumnIds, gearTableLayout, statText, type GearColumn } from './gearColumns'
import type { GearColumnWidths } from './gearPrefs'
// JOS-338 — the ONE door a card may reach these rows through (its header states the three
// guarantees that make it safe over this tab's dropdown toolbar).
import { GearRowCompare } from './GearCompareCard'
import { GearHead } from './GearTableHead'
import type { GearCompareData, GearViewRow } from './gearData'
import { sortValue, type GearSort, type GearSortKey } from './gearFilter'
import type { GearDerivedOpts } from '@shared/planner/gearScale'
import { ownedCellText, ownedCellTitle, ownershipFor, type GearOwnershipMap } from './gearOwnership'
// JOS-343 — the ONE wish control in the app, shared with the Exaltations donor row by owner ruling.
import WishToggle from '../wishlist/WishToggle'
import type { ClassAbbr } from '@shared/classCombo'

/** Dense row height (px), MUI `size="small"` — the number the windowing hook is handed. */
export const ROW_HEIGHT = 37

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

/** The first entry, with a `+N` admitting how many more the hover title holds. Blank when none. */
function overflowText(values: readonly string[]): string {
  const first = values[0]
  if (first === undefined) return ''
  return values.length > 1 ? `${first} +${String(values.length - 1)}` : first
}

/** Sixteen classes is `Class: ALL`, and sixteen chips would be the widest cell in the table. */
function classText(classes: readonly ClassAbbr[]): string {
  if (classes.length === 0) return ''
  if (classes.length >= 16) return 'ALL'
  return classes.join(' ')
}

export interface GearTableProps {
  rows: readonly GearViewRow[]
  columns: readonly GearColumn[]
  win: WindowedRows
  sort: GearSort
  /**
   * The ownership join (JOS-285), keyed by `row.key` — `null` when this character has never
   * written a dump, which removes the column entirely rather than drawing a blank one
   * (gearColumns.ts states why).
   */
  ownership: GearOwnershipMap | null
  /** the Owned header's own explanation, including the uncounted-keyring note when there is one */
  ownedHint: string
  onSort: (key: GearSortKey) => void
  /**
   * Deep-link an item into the Loot tab's drill-down, where the ItemWindow draws its tier block.
   *
   * THE ONLY PER-ROW ACTION THIS TABLE HAS, since JOS-325. There was a second — `onAssign`, the `+`
   * that dropped a search row into the selected gear set (JOS-286) — and it went with the sets
   * surface the owner retired: no pane, no set to add to, nothing for the button to mean. The
   * argument it used to carry (absent beats disabled, because a button that does nothing is a worse
   * answer than no button) survives it as a general rule, and this prop is now the whole of its
   * application here: a host that has nowhere to send the click passes nothing, and `DonorName`
   * draws plain text rather than a link that goes nowhere.
   */
  onOpenLoot?: (item: string) => void
  /**
   * PUT THIS ROW ON THE WISH LIST, OR TAKE IT OFF (JOS-335, made a toggle by JOS-343) — the second
   * per-row action, and the one the general rule above was waiting for.
   *
   * IT TAKES THE STATE THE ROW WAS DRAWN IN, which is what keeps the handler STABLE: the host's
   * wished set is rebuilt on every edit, so a callback that read the set instead would change
   * identity on every click and defeat `GearLine`'s `memo` for the whole screenful.
   *
   * ABSENT, NEVER DISABLED, when the host has no wish list to write to. That is the same house rule
   * `onOpenLoot` applies one prop up, and here it covers exactly one case: the wish document has not
   * loaded yet, so `wished` would be a GUESS rather than a fact and an added state read off an empty
   * list would be a lie about what is already on it. A button that appears a beat late is honest; a
   * button that says "not wished" about an item that is, is not.
   */
  onToggleWish?: (row: GearViewRow, wished: boolean) => void
  /**
   * The user's dragged column widths (user ask, 2026-08-15), `null` until they have dragged one —
   * `useGearPrefs.widths`, localStorage-backed like the other two view choices. `onWidths` receives
   * the whole next map on every drag tick, or `null` from the double-click reset.
   */
  widths: GearColumnWidths | null
  onWidths: (next: GearColumnWidths | null) => void
  /**
   * The derived-score knobs (2026-08-15) — the haste opt-out and the class picks — as the SAME
   * stable object the sort upstream read (`derivedOpts`' one-entry cache), so the drawn EFF DMG /
   * BEST cells and the order the rows stand in can never disagree, and `GearLine`'s memo compares
   * one identity instead of a fresh literal.
   */
  derived: GearDerivedOpts
  /** Draw the Zone / Level / Mob trio (2026-08-15) — `useGearPrefs.dropCols`, on by default. */
  showDrops: boolean
  /**
   * The item keys already on the wish list — the added state, and since JOS-343 the reason a second
   * click on the same row REMOVES rather than doing nothing. Keys are `itemKey(name)`, which IS
   * `row.key`: the corpus join key this whole table is built on, so the membership test is one
   * `Set.has` per rendered row.
   */
  wished: ReadonlySet<string>
  /**
   * WHAT A HOVERED ROW IS COMPARED AGAINST (JOS-338) — the equipped-by-cell index, the corpus by
   * key, and when the dump was exported (`useGearCompare`).
   *
   * ABSENT MEANS NO CARD AT ALL, which is the same absent-not-disabled rule `onWish` states one
   * prop up: a host that cannot answer "what are you wearing" — a surface that draws this table
   * without the dump seam — should draw no card rather than one whose equipped half is a permanent
   * blank. Present-but-not-`ready` is a different thing and the CARD handles it: the reader is
   * hovering, so the card opens and simply says less until the first read lands.
   */
  compare?: GearCompareData
}

/**
 * ADD TO THE WISH LIST FROM A SEARCH ROW, AND TAKE IT BACK OFF (JOS-335, re-shaped by JOS-343) —
 * the Exaltations donor row's control, in the same component, wearing the short wording.
 *
 * THE HEART THAT USED TO BE HERE IS GONE, and the argument that put it here is overruled rather
 * than merely outvoted, so it is written down at the top of this file instead of in this comment.
 * The short version: JOS-335 traded parity for width; the owner traded it back the next day and
 * asked that the width be handled honestly instead of used as the reason.
 *
 * AND THIS SURFACE NOW DECIDES NOTHING ABOUT IT AT ALL (JOS-346). It used to pass `compact` for a
 * shorter pair of words, on the grounds that the Item column is shared three ways (control, name,
 * era chip) and is the only column in the table whose content actually runs out of room. The owner
 * overruled that on 2026-08-13: same words on both surfaces, width cost accepted. So the call is a
 * name, a state and a door — every decision about how the control reads lives in one file.
 */
function WishButton({
  row,
  wished,
  onToggleWish
}: {
  row: GearViewRow
  wished: boolean
  onToggleWish: (row: GearViewRow, wished: boolean) => void
}): JSX.Element {
  return (
    <WishToggle
      compact
      testId="gear-wish"
      name={row.name}
      wished={wished}
      onToggle={() => onToggleWish(row, wished)}
    />
  )
}

/** The spacer rows that reserve the full scroll height — see useWindowedRows. */
function PadRow({ height, colSpan }: { height: number; colSpan: number }): JSX.Element | null {
  if (height <= 0) return null
  return (
    <TableRow style={{ height }}>
      <TableCell colSpan={colSpan} sx={{ p: 0, border: 0 }} />
    </TableRow>
  )
}

/**
 * ONE CANDIDATE. Every number on it is the SCALED one — the row this component is handed has
 * already been through `scaleAll` at the table's plus-state, so nothing here knows the simulation
 * exists. `memo` because a slider drag re-renders the table and most visible rows are unchanged
 * objects when only the sort moved.
 */
const GearLine = memo(function GearLine({
  row,
  columns,
  ownership,
  wished,
  compare,
  derived,
  showDrops,
  on
}: {
  row: GearViewRow
  columns: readonly GearColumn[]
  ownership: GearOwnershipMap | null
  /** already on the wish list — a BOOLEAN and not the set, so `memo` can compare it (JOS-335) */
  wished: boolean
  /** the comparison seam (JOS-338); a STABLE object, or absent for a host with no dump seam */
  compare: GearCompareData | undefined
  /** the derived-score knobs — STABLE (derivedOpts' cache), so `memo` compares one identity */
  derived: GearDerivedOpts
  /** the Zone / Level / Mob trio, toggleable since 2026-08-15 — a primitive, same argument */
  showDrops: boolean
  on: { openLoot?: (item: string) => void; wish?: (row: GearViewRow, wished: boolean) => void }
}): JSX.Element {
  // ONE MAP LOOKUP PER RENDERED ROW, and only for the screenful the window mounted. `row.key` is
  // already the ownership key — phase 3's seam — so there is nothing to normalise here.
  const owned = ownership === null ? null : ownershipFor(ownership, row)
  const wish = on.wish
  const line = (
    <TableRow hover data-testid="gear-row" data-item-key={row.key} sx={FIXED_ROW}>
      <TableCell>
        {/* THE `+` IS GONE FROM THIS CELL (JOS-325) — it put the row into the selected gear set, and
            the sets are retired. WHAT STANDS IN ITS PLACE IS NOT IT (JOS-335, re-shaped by JOS-343):
            a wish control, writing a document that outlives any pane.

            IT SITS AT THE RIGHT EDGE OF THE CELL NOW (JOS-346), which is DONOR-ROW PARITY and not a
            new opinion: `planner/EffectRows.tsx` DonorLine ends with a `flexGrow` spacer and then
            the same control, so on the Exaltations tab the wish button is the last thing in the row.
            JOS-335 led the cell with it instead, on the argument that a control down the left edge
            is one target to aim at where a control after a variable-width name is a moving one —
            true of a NAKED name, and answered here by the spacer: the growing box between the name
            and the control is what pins the control to the cell's right edge whatever the name
            costs, so it is a fixed target on this surface too. The `Stack` was always what let the
            name share this cell with the era chip, and the FIXED_ROW contract above is what keeps
            all three one clipped line rather than two. */}
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexWrap: 'nowrap', minWidth: 0 }}>
          {/* THE ITEM'S OWN ICON (user ask, 2026-08-15), off the PERMANENT image cache — the same
              `eqimg://` door the ItemWindow draws through (imageCache.ts: bundled art, then disk,
              then ONE polite fetch stored forever), so a windowed scroll costs no wiki traffic. A
              404 hides itself; a row whose corpus page named no icon simply leads with the name. */}
          {row.iconId !== undefined && (
            <Box
              component="img"
              src={itemIconUrl(row.iconId)}
              alt=""
              onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
                e.currentTarget.style.display = 'none'
              }}
              sx={{ width: 22, height: 22, imageRendering: 'pixelated', flexShrink: 0 }}
            />
          )}
          <DonorName name={row.name} onOpen={on.openLoot} />
          {/* THE ONE CHIP A SEARCH ROW WEARS, and it is a POINTER rather than a verdict: the era
              join's (out of era / era?), which explains a row you can SEE.

              THE CLASS MISMATCH CHIP IS GONE FROM THIS TABLE (owner ruling 2026-08-13, JOS-302:
              *obviously wrong, it should just be removed*). A row this character's classes cannot
              use is no longer chipped here — it is not here at all, because `filterGearRows` now
              removes it (gearFilter.ts `GearFilters.classes` carries the full argument, including
              why the planner build pane's own mismatch chip stays exactly where it is). A chip that
              can only ever appear on a row the filter already removed would be dead code pretending
              to be a law. */}
          <EraChip subject={row} />
        </Stack>
      </TableCell>
      {/* THE WISH CONTROL'S OWN COLUMN (user ruling, 2026-08-15) — it shared the Item cell from
          JOS-335 until today, and the name paid for it at every narrow pane. The header (`WL`)
          carries the words, so the button can be the compact pair. Empty until the document has
          loaded — the same absent-not-disabled rule the cell followed inside the Item column. */}
      {/* Slim padding: the column is the narrowest in the table and the button needs the room. */}
      <TableCell sx={{ px: 0.5 }}>
        {wish !== undefined && <WishButton row={row} wished={wished} onToggleWish={wish} />}
      </TableCell>
      <TableCell title={row.slots.join(' ')}>{row.slots.join(' ')}</TableCell>
      <TableCell title={row.classes.join(' ')}>{classText(row.classes)}</TableCell>
      {showDrops && (
        <>
          <TableCell title={row.dropZones.join(' · ')}>{overflowText(row.dropZones)}</TableCell>
          {/* dropLevels[i] IS dropMobs[i]'s level (gearData.dropDetails), so the title can pair them. */}
          <TableCell title={row.dropMobs.map((m, i) => `${m}: ${row.dropLevels[i] === '' ? '?' : row.dropLevels[i]}`).join(' · ')}>
            {row.dropLevels[0] ?? ''}
          </TableCell>
          <TableCell title={row.dropMobs.join(' · ')}>{overflowText(row.dropMobs)}</TableCell>
        </>
      )}
      {columns.map((c) => (
        <TableCell key={c.key} align="right" data-testid={`gear-cell-${c.key}`} sx={NUMERIC_PAD}>
          {statText(sortValue(row, c.key, derived), c.key)}
        </TableCell>
      ))}
      {owned !== null && (
        <TableCell data-testid="gear-cell-owned" title={ownedCellTitle(owned)}>
          {ownedCellText(owned)}
        </TableCell>
      )}
    </TableRow>
  )
  // THE CARDS HANG OFF THE WHOLE ROW (JOS-338), which is what the owner asked for — you point at a
  // candidate, not at a particular cell of it. `GearRowCompare` adds no DOM (MUI's Tooltip renders
  // its child and portals the popper), so the FIXED_ROW contract at the top of this file is
  // untouched: same one `<tr>`, same `ROW_HEIGHT`, same windowing arithmetic.
  //
  // WHAT CHANGED UNDER THIS SEAM IN JOS-344, because it is the reason the row is STILL the anchor:
  // the pair opens from the row's bottom-LEFT corner now, not beside its right edge. The old
  // placement read the one edge of a full-width row that is off the screen, and drew the card 3px
  // inside a 1268px window — present in the DOM, invisible to a human. `GearCompareCard.tsx`'s
  // header carries the measurement and the new law; nothing here had to move for it.
  return compare === undefined ? line : (
    <GearRowCompare row={row} data={compare}>
      {line}
    </GearRowCompare>
  )
})

export default function GearTable({
  rows,
  columns,
  win,
  sort,
  ownership,
  ownedHint,
  onSort,
  onOpenLoot,
  onToggleWish,
  wished,
  compare,
  widths,
  onWidths,
  derived,
  showDrops
}: GearTableProps): JSX.Element {
  // ONE layout per (count, owned, drops) — memoized for identity, because `GearHead` is `memo`'d
  // and reads the same object this function takes `minWidth`/`mode` from.
  const layout = useMemo(() => gearTableLayout(columns.length, ownership !== null, showDrops), [columns.length, ownership, showDrops])
  // The roster in draw order (gearColumnIds — the one statement of it): the colspan the pad rows
  // state, and the ids the pixel-mode width sum walks.
  const allIds = gearColumnIds(columns, showDrops, ownership !== null)
  const span = allIds.length
  // THE USER'S DRAGGED WIDTHS WIN WHOLE (user ask, 2026-08-15): any stored map puts the entire
  // table in stated pixels — a dragged column beside percentage ones would reflow on every pane
  // resize, which is the opposite of "stick". A column the map has no entry for (a numeric column
  // picked after the drag) takes the pixel-mode default, so it arrives at a legible width instead
  // of an unstated one. `GearHead` resolves the per-column widths by the same rule.
  const minWidth = widths === null ? layout.minWidth : allIds.reduce((a, id) => a + (widths[id] ?? defaultColumnPx(id)), 0)
  // ONE object for the row's callbacks, memoized on the callbacks themselves: `GearLine` is
  // `memo`'d and a fresh literal per render would defeat it on every keystroke. It held two until
  // JOS-325 retired the `+`, and holds two again since JOS-335 — which is exactly why it stayed an
  // object through the year it held one: the wrapper is what the memo depends on.
  const handlers = useMemo(() => ({ openLoot: onOpenLoot, wish: onToggleWish }), [onOpenLoot, onToggleWish])
  return (
    <Table
      size="small"
      stickyHeader
      data-testid="gear-table"
      data-layout={widths === null ? layout.mode : 'pixel'}
      // `minWidth`, never `width`: a pane wider than the set still fills it, a narrower one scrolls
      // the table sideways inside its own box. 0 in percentage mode means the table IS the pane.
      sx={{ tableLayout: 'fixed', minWidth: minWidth === 0 ? undefined : minWidth }}
    >
      <GearHead
        columns={columns}
        sort={sort}
        hasOwned={ownership !== null}
        showDrops={showDrops}
        ownedHint={ownedHint}
        onSort={onSort}
        onWidths={onWidths}
        widths={widths}
        layout={layout}
      />
      <TableBody>
        <PadRow height={win.topPad} colSpan={span} />
        {rows.slice(win.start, win.end).map((row) => (
          <GearLine
            key={row.key}
            row={row}
            columns={columns}
            ownership={ownership}
            wished={wished.has(row.key)}
            compare={compare}
            derived={derived}
            showDrops={showDrops}
            on={handlers}
          />
        ))}
        <PadRow height={win.bottomPad} colSpan={span} />
      </TableBody>
    </Table>
  )
}
