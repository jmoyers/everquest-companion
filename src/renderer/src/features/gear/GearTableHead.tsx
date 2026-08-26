// gear/GearTableHead.tsx — the Gear table's HEADER ROW: the sortable and plain header cells, the
// column resize handles (fork decision, kaltinril 2026-08-15) and the one row that assembles them. Split from
// GearTable.tsx when the wish column pushed that file over the repo's 400-code-line ceiling — the
// rule is to split, never to ratchet. The body rows, the windowing and the cell text stay with the
// table; everything about the HEADER lives here. (`NUMERIC_PAD` lives in gearColumns.ts with the
// other layout constants — the header and the body cells must state one padding or the columns
// shear, so neither component owns the number.)

import { memo, useEffect, useRef, type JSX } from 'react'
import { Box, TableCell, TableHead, TableRow, TableSortLabel } from '@mui/material'
import { NUMERIC_PAD, defaultColumnPx, type GearColumn, type GearTableLayout } from './gearColumns'
import { clampGearWidth, fitColumnWidth, type CellMeasure, type GearColumnWidths } from './gearPrefs'
import type { GearSort, GearSortKey } from './gearFilter'

/** One clause (the tooltip diet): the two gestures, and nothing about where they are stored. */
const RESIZE_HINT = 'Drag to resize, double-click to fit'

/** Every header's rendered width, read off the DOM — the seed both gestures start from. */
function seedWidths(headRow: HTMLElement): GearColumnWidths {
  const seed: GearColumnWidths = {}
  for (const cell of headRow.querySelectorAll('th[data-col]')) {
    const id = cell.getAttribute('data-col')
    if (id !== null) seed[id] = Math.round(cell.getBoundingClientRect().width)
  }
  return seed
}

/** The padding an element states on its two horizontal edges, as the browser resolved it. */
function horizontalPadding(style: CSSStyleDeclaration): number {
  return Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
}

/**
 * One node's CONTENT width, measured so the answer can never depend on the width the column has
 * NOW — that dependence is the whole bug this function has been through twice. The first version
 * read the cell's own `scrollWidth`, which is floored at its current width, so every double-click
 * grew the column (fork report, kaltinril 2026-08-15). The second read each CHILD's `scrollWidth`
 * plus a constant 24, and the Item cell's child is a flex Stack whose name shrinks with an
 * ellipsis rather than overflowing - a scrollWidth that never exceeds the cell, minus the cell's
 * 32px of padding, plus 24: eight pixels narrower on every double-click, forever. And an inline
 * link (the Zone and Mob cells) reports a scrollWidth of zero, so those fit to their `+N` tail.
 *
 * So the measurement is of the CONTENT ITSELF, recursively: a text node through a Range (its
 * inline boxes are laid out at full length whatever clips them, so the ellipsis is seen past); a
 * childless element - an icon, the sort arrow - by its own box; a container by the SUM of its
 * children plus the gaps between them, which is what a flex row or an inline run needs to show
 * every child unclipped (a shrunk child's right edge and its neighbour's left edge still state the
 * margin between them). The absolutely-positioned grip is skipped: it overlays padding, it does
 * not occupy. Nothing here reads the cell's width, so a second double-click lands on the same
 * number as the first.
 */
function contentWidth(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) {
    const range = document.createRange()
    range.selectNodeContents(node)
    return range.getBoundingClientRect().width
  }
  if (!(node instanceof HTMLElement) || node.getAttribute('data-testid') === 'gear-col-resize') return 0
  const style = getComputedStyle(node)
  if (style.position === 'absolute') return 0
  if (node.childNodes.length === 0) return node.getBoundingClientRect().width
  let sum = 0
  let prev: DOMRect | null = null
  for (const child of Array.from(node.childNodes)) {
    sum += contentWidth(child)
    // A gap is measured between two ELEMENT neighbours only; a text run between them is its own
    // width (the Range above) and the span it occupies must not be counted twice as a gap.
    if (!(child instanceof HTMLElement)) {
      prev = null
      continue
    }
    const box = child.getBoundingClientRect()
    if (prev !== null) sum += Math.max(0, box.left - prev.right)
    prev = box
  }
  return sum + horizontalPadding(style)
}

/** A cell as the fit reads it: what its children need, and the padding the cell states around them. */
function measureCell(cell: HTMLElement): CellMeasure {
  let content = 0
  for (const child of Array.from(cell.childNodes)) content += contentWidth(child)
  return { content, padding: horizontalPadding(getComputedStyle(cell)) }
}

/**
 * The width that FITS a column: the widest content among its header and the mounted body cells,
 * each plus the padding THAT cell states (a numeric header pads 8+16, an identity cell 16+16 - a
 * constant fit neither). Only the windowed screenful is measured — that is what the user is
 * looking at, and a wider row scrolled far away can be fit again when it is on screen. The
 * arithmetic is `gearPrefs.fitColumnWidth`, pure and node-tested; this is the DOM read.
 */
function fitWidth(th: HTMLTableCellElement): number {
  const cells: CellMeasure[] = [measureCell(th)]
  const idx = th.cellIndex
  const table = th.closest('table')
  for (const tr of table?.querySelectorAll('tbody tr') ?? []) {
    const cell = (tr as HTMLTableRowElement).cells[idx]
    if (cell !== undefined) cells.push(measureCell(cell))
  }
  return fitColumnWidth(cells)
}

/** The header cell a grip gesture belongs to — the `th`, its row and its column id, or null when
 *  the event landed outside one. Both gestures resolve their target through this one spelling. */
function gripTarget(e: { target: EventTarget | null }): { th: HTMLTableCellElement; headRow: HTMLElement; id: string } | null {
  const th = (e.target as HTMLElement).closest('th')
  const headRow = th?.parentElement
  const id = th?.getAttribute('data-col')
  if (!th || !headRow || id === null || id === undefined) return null
  return { th, headRow, id }
}

/**
 * THE COLUMN RESIZE HANDLE (fork decision, kaltinril 2026-08-15: *resize and have the sizes stick*), one per
 * header cell, at its right edge.
 *
 * THE FIRST GESTURE SNAPSHOTS EVERY COLUMN, not just the touched one: the automatic layout is
 * percentages, and converting one column to pixels while its neighbours stay fractional would
 * reflow the whole row under the cursor mid-drag. So both gestures seed the whole map off the DOM
 * (`seedWidths`) and the table is in stated-pixel mode from the first tick — nothing moves except
 * the edge being worked. DOUBLE-CLICK FITS THE COLUMN to its content (the second fork ask (kaltinril): stat
 * columns do not need their default room); Alt+double-click clears the map, the way back to
 * automatic.
 */
function ResizeHandle({ onWidths }: { onWidths: (next: GearColumnWidths | null) => void }): JSX.Element {
  // THE DRAG IN FLIGHT, so an unmount mid-drag can end it. The two document listeners a drag
  // installs used to be removed only by `mouseup`; a header that unmounted with the button still
  // down (the table re-keyed under a character rebuild, a tab switch by keyboard) left both
  // listeners on `document` forever, moving widths for a table that no longer existed.
  const active = useRef<(() => void) | null>(null)
  useEffect(() => () => active.current?.(), [])
  return (
    <Box
      title={RESIZE_HINT}
      data-testid="gear-col-resize"
      onDoubleClick={(e) => {
        e.stopPropagation()
        if (e.altKey) {
          onWidths(null)
          return
        }
        const hit = gripTarget(e)
        if (hit === null) return
        onWidths({ ...seedWidths(hit.headRow), [hit.id]: fitWidth(hit.th) })
      }}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        const hit = gripTarget(e)
        if (hit === null) return
        const seed = seedWidths(hit.headRow)
        const startX = e.clientX
        const startW = seed[hit.id] ?? 0
        const move = (ev: MouseEvent): void => {
          onWidths({ ...seed, [hit.id]: clampGearWidth(startW + ev.clientX - startX) })
        }
        const up = (): void => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
          active.current = null
        }
        active.current?.()
        active.current = up
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }}
      // A VISIBLE grip, not a bare hot zone (fork decision, kaltinril 2026-08-15: *i can't resize columns* —
      // the mechanism worked, measured in a driven instance; what failed was an invisible 8px strip
      // nobody could find). The drawn bar is the affordance; the 12px box around it is the target.
      sx={{
        position: 'absolute',
        top: 0,
        right: 0,
        width: 12,
        height: '100%',
        cursor: 'col-resize',
        zIndex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        '&::after': {
          content: '""',
          width: '3px',
          height: '55%',
          borderRadius: 1,
          bgcolor: 'divider',
          mr: '2px'
        },
        '&:hover::after': { bgcolor: 'primary.main' }
      }}
    />
  )
}

/** One sortable header cell — clicking it sorts by that column, clicking again flips direction. */
function SortHeader({
  column,
  sort,
  width,
  align,
  title,
  onSort,
  onWidths
}: {
  column: { key: GearSortKey; label: string }
  sort: GearSort
  width?: string
  align?: 'right'
  /** the hover sentence a wordy column carries (the drop trio); the stat headers say it in data */
  title?: string
  onSort: (key: GearSortKey) => void
  onWidths: (next: GearColumnWidths | null) => void
}): JSX.Element {
  const active = sort.key === column.key
  return (
    <TableCell
      align={align}
      title={title}
      data-col={column.key}
      // A right-aligned label ends where the GRIP sits, so the numeric headers state extra right
      // padding to clear it (fork decision, kaltinril 2026-08-15: `STR` read `STI` at a narrow width). Body
      // cells keep `NUMERIC_PAD` — no grip lives there.
      sx={{
        position: 'relative',
        ...(width === undefined ? {} : { width }),
        ...(align === 'right' ? { ...NUMERIC_PAD, pr: '16px' } : {})
      }}
    >
      <TableSortLabel
        active={active}
        direction={active ? sort.dir : 'desc'}
        data-testid={`gear-sort-${column.key}`}
        onClick={() => onSort(column.key)}
      >
        {column.label}
      </TableSortLabel>
      <ResizeHandle onWidths={onWidths} />
    </TableCell>
  )
}

/** A plain (non-sorting) header cell: its id, its width, its words, its handle. */
function PlainHeader({
  id,
  width,
  title,
  testId,
  onWidths,
  children
}: {
  id: string
  width: string | undefined
  title?: string
  testId?: string
  onWidths: (next: GearColumnWidths | null) => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <TableCell data-col={id} title={title} data-testid={testId} sx={{ position: 'relative', width }}>
      {children}
      <ResizeHandle onWidths={onWidths} />
    </TableCell>
  )
}

/**
 * The header row, split from the table when the wish column took the function over the measured
 * 100-line ceiling (the rule is to split, never to ratchet). It takes the host's LAYOUT and the
 * stored WIDTHS as plain values and resolves each column's width itself — the user's dragged
 * pixels win whole when any are stored, the automatic layout answers otherwise. `memo` because
 * every prop is a stable identity or a primitive, so a scroll tick — which re-renders the table
 * for the row window — never re-renders sixteen header cells whose inputs did not move.
 */
export const GearHead = memo(function GearHead({
  columns,
  sort,
  hasOwned,
  showDrops,
  ownedHint,
  onSort,
  onWidths,
  widths,
  layout
}: {
  columns: readonly GearColumn[]
  sort: GearSort
  hasOwned: boolean
  /** the Zone / Level / Mob trio, toggleable since 2026-08-15 (fork decision, kaltinril) */
  showDrops: boolean
  ownedHint: string
  onSort: (key: GearSortKey) => void
  onWidths: (next: GearColumnWidths | null) => void
  /** the dragged widths, `null` until a drag stores one — any map puts the whole table in pixels */
  widths: GearColumnWidths | null
  /** the automatic layout the host already computed (it reads `minWidth`/`mode` from the same one) */
  layout: GearTableLayout
}): JSX.Element {
  const w = (id: string, auto: string | undefined): string | undefined =>
    widths === null ? auto : `${String(widths[id] ?? defaultColumnPx(id))}px`
  return (
    <TableHead>
      <TableRow>
        {/* In percentage mode the item NAME states no width and takes whatever the stated columns
            leave (LootTables.tsx); in pixel mode every column is stated, because the SUM is what
            makes the table wider than the pane. */}
        <SortHeader column={{ key: 'name', label: 'Item' }} sort={sort} width={w('name', layout.name)} onSort={onSort} onWidths={onWidths} />
        <PlainHeader
          id="wish"
          width={w('wish', layout.wish)}
          title="Add to or remove from the wish list"
          onWidths={onWidths}
        >
          Wish list
        </PlainHeader>
        <PlainHeader id="slot" width={w('slot', layout.slot)} onWidths={onWidths}>
          Slot
        </PlainHeader>
        <PlainHeader id="classes" width={w('classes', layout.classes)} onWidths={onWidths}>
          Classes
        </PlainHeader>
        {/* The three drop columns (fork decision, kaltinril 2026-08-15): where it drops, from whom, and the
            MOB's stated level — the catalog states no zone-level range, so claiming one would be
            an invented number; the mob's own level is the fact it does state (law 1). Toggleable
            as one trio (the "Drop columns" chip on the count line) — the drill-down always has
            the full story either way. */}
        {showDrops && (
          <>
            {/* Sortable since 2026-08-18 (fork decision, kaltinril: standing in a zone and reading its roster).
                Text axes sort by the FIRST entry — the name the cell shows — and Level by the
                first mob's stated LOW end; unstated rows file last (gearFilter's drop sorts). */}
            <SortHeader
              column={{ key: 'zone', label: 'Zone' }}
              sort={sort}
              width={w('zone', layout.zone)}
              title="Where it drops"
              onSort={onSort}
              onWidths={onWidths}
            />
            <SortHeader
              column={{ key: 'zoneLevel', label: 'Level' }}
              sort={sort}
              width={w('zoneLevel', layout.zoneLevel)}
              title="The first drop mob's stated level"
              onSort={onSort}
              onWidths={onWidths}
            />
            <SortHeader
              column={{ key: 'mob', label: 'Mob' }}
              sort={sort}
              width={w('mob', layout.mob)}
              title="Who drops it"
              onSort={onSort}
              onWidths={onWidths}
            />
          </>
        )}
        {columns.map((c) => (
          <SortHeader key={c.key} column={c} sort={sort} width={w(c.key, layout.numeric)} align="right" onSort={onSort} onWidths={onWidths} />
        ))}
        {/* The one column that is not a number and not sortable: it reports a live file, and the
            header carries the two things a reader has to know about it — that a `+N` is its own
            copy, and which key rings the fold left out. It stays LAST whatever the picker shows
            (JOS-297): the numerics are what an item reads, this is what you have. */}
        {hasOwned && (
          <PlainHeader id="owned" width={w('owned', layout.owned)} title={ownedHint} testId="gear-owned-header" onWidths={onWidths}>
            Owned
          </PlainHeader>
        )}
      </TableRow>
    </TableHead>
  )
})

