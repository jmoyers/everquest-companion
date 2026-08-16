// gear/GearTableHead.tsx — the Gear table's HEADER ROW: the sortable and plain header cells, the
// column resize handles (user ask, 2026-08-15) and the one row that assembles them. Split from
// GearTable.tsx when the wish column pushed that file over the repo's 400-code-line ceiling — the
// rule is to split, never to ratchet. The body rows, the windowing and the cell text stay with the
// table; everything about the HEADER lives here. (`NUMERIC_PAD` lives in gearColumns.ts with the
// other layout constants — the header and the body cells must state one padding or the columns
// shear, so neither component owns the number.)

import { memo, type JSX } from 'react'
import { Box, TableCell, TableHead, TableRow, TableSortLabel } from '@mui/material'
import { NUMERIC_PAD, defaultColumnPx, type GearColumn, type GearTableLayout } from './gearColumns'
import { clampGearWidth, type GearColumnWidths } from './gearPrefs'
import type { GearSort, GearSortKey } from './gearFilter'

const RESIZE_HINT =
  'Drag to set this column width - it sticks on this machine. Double-click to fit the column to its content; Alt+double-click puts every column back on the automatic layout.'

/** Every header's rendered width, read off the DOM — the seed both gestures start from. */
function seedWidths(headRow: HTMLElement): GearColumnWidths {
  const seed: GearColumnWidths = {}
  for (const cell of headRow.querySelectorAll('th[data-col]')) {
    const id = cell.getAttribute('data-col')
    if (id !== null) seed[id] = Math.round(cell.getBoundingClientRect().width)
  }
  return seed
}

/**
 * One cell's CONTENT width — its child nodes measured directly, never the cell's own box. The
 * distinction is the whole function (user report, 2026-08-15: *every double-click keeps growing
 * the column*): a cell's `scrollWidth` is floored at its CURRENT width, so measuring the cell fed
 * the fit its own last answer plus padding, forever. A text node is measured through a Range
 * (which sees past the ellipsis clip); an element by its `scrollWidth` (its content when the cell
 * clips it); the absolutely-positioned grip is skipped — it overlays padding, it does not occupy.
 */
function contentWidth(cell: Element): number {
  let wide = 0
  for (const node of Array.from(cell.childNodes)) {
    if (node instanceof Element) {
      if (node.getAttribute('data-testid') === 'gear-col-resize') continue
      wide += node.scrollWidth
    } else if (node.nodeType === Node.TEXT_NODE) {
      const range = document.createRange()
      range.selectNode(node)
      wide += Math.round(range.getBoundingClientRect().width)
    }
  }
  return wide
}

/**
 * The width that FITS a column: the widest content among its header and the mounted body cells,
 * plus the cell padding and the grip's clearance. Only the windowed screenful is measured — that
 * is what the user is looking at, and a wider row scrolled far away can be fit again when it is
 * on screen. Same content, same answer: a second double-click lands on the same number.
 */
function fitWidth(th: HTMLTableCellElement): number {
  let want = contentWidth(th)
  const idx = th.cellIndex
  const table = th.closest('table')
  for (const tr of table?.querySelectorAll('tbody tr') ?? []) {
    const cell = (tr as HTMLTableRowElement).cells[idx]
    if (cell !== undefined) want = Math.max(want, contentWidth(cell))
  }
  return clampGearWidth(want + 24)
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
 * THE COLUMN RESIZE HANDLE (user ask, 2026-08-15: *resize and have the sizes stick*), one per
 * header cell, at its right edge.
 *
 * THE FIRST GESTURE SNAPSHOTS EVERY COLUMN, not just the touched one: the automatic layout is
 * percentages, and converting one column to pixels while its neighbours stay fractional would
 * reflow the whole row under the cursor mid-drag. So both gestures seed the whole map off the DOM
 * (`seedWidths`) and the table is in stated-pixel mode from the first tick — nothing moves except
 * the edge being worked. DOUBLE-CLICK FITS THE COLUMN to its content (the second user ask: stat
 * columns do not need their default room); Alt+double-click clears the map, the way back to
 * automatic.
 */
function ResizeHandle({ onWidths }: { onWidths: (next: GearColumnWidths | null) => void }): JSX.Element {
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
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }}
      // A VISIBLE grip, not a bare hot zone (user report, 2026-08-15: *i can't resize columns* —
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
  onSort,
  onWidths
}: {
  column: { key: GearSortKey; label: string }
  sort: GearSort
  width?: string
  align?: 'right'
  onSort: (key: GearSortKey) => void
  onWidths: (next: GearColumnWidths | null) => void
}): JSX.Element {
  const active = sort.key === column.key
  return (
    <TableCell
      align={align}
      data-col={column.key}
      // A right-aligned label ends where the GRIP sits, so the numeric headers state extra right
      // padding to clear it (user report, 2026-08-15: `STR` read `STI` at a narrow width). Body
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
  /** the Zone / Level / Mob trio, toggleable since 2026-08-15 (user ask) */
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
          title="Add puts the item on the wish list, Remove takes it off. The list groups your wants by where they drop."
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
        {/* The three drop columns (user ask, 2026-08-15): where it drops, from whom, and the
            MOB's stated level — the catalog states no zone-level range, so claiming one would be
            an invented number; the mob's own level is the fact it does state (law 1). Toggleable
            as one trio (the "Drop columns" chip on the count line) — the drill-down always has
            the full story either way. */}
        {showDrops && (
          <>
            <PlainHeader
              id="zone"
              width={w('zone', layout.zone)}
              title="Where the item is known to drop - the first zone, with the rest on hover"
              onWidths={onWidths}
            >
              Zone
            </PlainHeader>
            <PlainHeader
              id="zoneLevel"
              width={w('zoneLevel', layout.zoneLevel)}
              title="The stated level of the first drop mob - a range as often as a number. Hover for every mob's level."
              onWidths={onWidths}
            >
              Level
            </PlainHeader>
            <PlainHeader
              id="mob"
              width={w('mob', layout.mob)}
              title="Who drops it - the first known mob, with the rest on hover"
              onWidths={onWidths}
            >
              Mob
            </PlainHeader>
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

