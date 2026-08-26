import { type JSX, memo } from 'react'
import { Box, Chip, Stack, TableCell, TableRow, Typography } from '@mui/material'
import type { ItemKnowledge, LootDisposition, LootEvent } from '@shared/types'
// The SERVED row's cells (JOS-484). A `Cell` is `string | number | boolean | null` and that is all
// this file is allowed to know about one — see `EngineFlatRow` below.
import type { Cells } from '@shared/dataServer/protocol.generated'
import { formatDateTime } from '../../lib/formatDate'
import type { InventoryRow } from '../inventory/reconcile'
import { isQuestItem } from './lootItemData'
import { KnowledgeBadge } from './KnowledgeBadge'
import type { GroupRow } from './lootGrouping'

// Fixed dense-row height (px) for the windowed tables (MUI Table size="small").
export const ROW_HEIGHT = 37

/**
 * THE FIXED-HEIGHT CONTRACT, as CSS (JOS-260). `useWindowedRows` is a FIXED-row-height hook: every
 * spacer, every index and every scroll offset it computes assumes each row is exactly
 * `ROW_HEIGHT`. A row that wraps to two lines is therefore not a cosmetic problem — it desyncs the
 * whole window, because the browser's real geometry and the hook's arithmetic stop agreeing, and
 * the drift compounds with every row above the viewport. `height` alone is only a MINIMUM for a
 * table row, so the row states a maximum too and every cell is one clipped, ellipsised line. The
 * tables that use these rows are `tableLayout: fixed` for the same reason (LootTables.tsx).
 */
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

function fmtTime(ts: number): string {
  return formatDateTime(ts, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// A subtle disposition chip (Tasks #40/#47): where a looted-and-routed item went.
// Dense, low-emphasis — no chip for ordinary kept loot. Kept storage (currency/hoard/
// depot) reads info-blue; 'sold' (gone) is dimmed; 'combined' (merged into an upgrade)
// reads success-green; 'destroyed' (JOS-401) reads warning, because it is the one row on
// this ledger that says an item LEFT — the strongest thing a bag-history row can say, and
// the only one the held counts subtract for.
function DispositionChip({ disposition }: { disposition?: LootDisposition }): JSX.Element | null {
  if (!disposition) return null
  const sx = { height: 18, fontSize: 11 } as const
  if (disposition === 'sold') {
    return <Chip size="small" variant="outlined" color="default" label="sold" sx={{ ...sx, opacity: 0.7 }} />
  }
  if (disposition === 'destroyed') {
    return <Chip size="small" variant="outlined" color="warning" label="destroyed" sx={sx} />
  }
  if (disposition === 'combined') {
    return <Chip size="small" variant="outlined" color="success" label="combined" sx={sx} />
  }
  return <Chip size="small" variant="outlined" color="info" label={disposition} sx={sx} />
}

/**
 * The "In inventory" cell — an ESTIMATE, never a fact (world-model law 1). The number is
 * the reconciled net held count (inventory/reconcile.ts): the active count source (looted
 * log and/or the last `/outputfile inventory` export) minus everything consumed by a
 * turned-in quest. The log cannot see bank deposits, destroys, trades or vendor sales that
 * happen off-camera, so it renders as a `~` chip like every other inferred value. `+N`
 * upgrade variants pool onto the base counting key, so a `Sphinx Claw` row and a
 * `Sphinx Claw +1` row show the same pooled estimate.
 *
 * IT USED TO SPELL THE INPUTS OUT IN A TOOLTIP, and does not any more (JOS-127). A popper on a
 * table row opens over the NEXT row, and every row here is a control (clicking one takes the
 * pane). The house convention already had the answer: one word, `est.`, beats a sentence — it
 * is in the column header, and the toolbar's "Count from" select names the source. Which
 * quests consumed how many still has a home, at full width, in the drill-down.
 *
 * IT TAKES A NUMBER RATHER THAN A ROW (JOS-160) because the two row kinds ask different witnesses.
 * A loot row's estimate is the reconciled `net` — the active count source, minus turn-ins, exactly
 * as before. An INVENTORY-ONLY row has no loot history at all and its `net` is 0 under the `log`
 * source, so it reports what the export vouches for; a row the app is showing you *because* the
 * export named it, rendering a dash where that count goes, would be the app declining to repeat
 * its own evidence.
 */
const InventoryEstimate = memo(function InventoryEstimate({ n }: { n: number }): JSX.Element {
  if (n <= 0) return <Box component="span" sx={{ color: 'text.disabled' }}>-</Box>
  return (
    <Chip
      size="small"
      variant="outlined"
      label={`~${n}`}
      sx={{ height: 18, fontSize: 11, color: 'text.secondary' }}
    />
  )
})

// Memoized rows (React.memo + stable props) so a re-render that doesn't touch a
// given row's data skips it entirely (precedent: #17's combat work).
//
// WHAT A ROW IS, AFTER JOS-345. Both kinds used to open with a `padding="checkbox"` cell holding a
// favorite star, and the props to drive it (`favorited`, `onToggleFavorite`) rode down from the
// view through LootTables to get here. The owner ruled the star out of this window during the
// 0.27.0 test pass — it was pre-board (it dates to the initial public commit), it was never asked
// for, and it rendered misaligned at the head of every row, which is what a reader actually saw.
// So a grouped row is now Item · Times looted · In inventory (est.) · Top source · Zones · Last
// looted, and a flat row is Time · Item · From · Zone. The whole row is still ONE control — click
// it and the drill-down takes the pane — and with the star gone there is no longer a click target
// inside a row that means something else, which is the second thing that was wrong with it.
//
// The stars themselves are NOT gone from the app: the same `eq.favorites` store still drives the
// item stars on the Plane of Sky tab (favorites/FavoriteStar is that tab's control now), so
// nothing was deleted from disk and nothing stopped being shared. This window simply stopped
// showing a column it never wanted.
export const GroupedRow = memo(function GroupedRow({
  g,
  knowledge,
  inv,
  onSelect
}: {
  g: GroupRow
  knowledge?: ItemKnowledge
  inv?: InventoryRow
  onSelect: (item: string) => void
}): JSX.Element {
  const posky = isQuestItem(g.item)
  return (
    <TableRow
      hover
      // The stable handle for "a drill opened from the ledger itself" — a NATIVE arrival, whose
      // Back must still mean this list (JOS-43). Both row kinds carry it: they are one control.
      data-testid="loot-row"
      sx={{ ...FIXED_ROW, cursor: 'pointer', opacity: g.invOnly ? 0.7 : 1 }}
      onClick={() => onSelect(g.item)}
    >
      <TableCell>
        <Stack direction="row" spacing={1} alignItems="center">
          {/* The NAME is plain text (JOS-127). It used to anchor a `placement="top"`, interactive
              item card, which on the rows nearest the top of the ledger opened straight across
              the toolbar and held the pointer there. Click the row: the drill-down says all of
              it, and is the surface that was always meant to. The testid is the handle
              `loot-sort.e2e.mts` hovers to prove nothing opens there any more. */}
          <Box component="span" data-testid="loot-item-name">
            {g.item}
          </Box>
          {posky && <Chip size="small" color="primary" variant="outlined" label="PoSky" />}
          <KnowledgeBadge knowledge={knowledge} isPosky={posky} />
          <DispositionChip disposition={g.disposition} />
        </Stack>
      </TableCell>
      <TableCell align="right" sx={g.invOnly ? { color: 'text.disabled' } : undefined}>
        {g.invOnly ? '-' : g.count}
      </TableCell>
      <TableCell align="right">
        <InventoryEstimate n={g.invOnly ? (g.owned ?? 0) : (inv?.net ?? 0)} />
      </TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{g.topSource ?? '-'}</TableCell>
      <TableCell align="right" sx={{ color: 'text.secondary' }}>
        {g.zoneCount || '-'}
      </TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{g.invOnly ? '-' : fmtTime(g.last)}</TableCell>
    </TableRow>
  )
})

// ============================================================================
// THE SAME ROW, SERVED (JOS-484) — `loot.ledger`'s cells, drawn VERBATIM.
// ============================================================================
//
// `FlatRow` above draws a `LootEvent`: it formats the instant (`fmtTime`), reads `source`, reads
// `zone`. `EngineFlatRow` draws a `{key, cells}` row the engine already made render-ready, and the
// difference between the two is the whole point of owner ruling 4 — every derivation `FlatRow` does
// happened engine-side before this row was sent, and this component may not redo any of it.
//
// WHAT IT MAY STILL DO, and the line is worth stating precisely because it looks like a loophole.
//
//   * FORMAT `count` AND `item` INTO ONE STRING. `engine/crates/engined/src/views/loot.rs`'s header
//     argues this deliberately: the stack size is served as its own NUMBER rather than composed
//     into `"2 × Bone Chips"`, because the composed string is LOSSY for every other reader of the
//     row and a client that had to split it back apart would be doing exactly the munging the
//     ruling forbids. Joining them with `×` is a format, in the same class as rounding a percentage
//     for the bar it is drawn in. The engine chose the honest decomposition; this is the join.
//   * DRAW A DASH FOR NULL. Same header: an absent value is served as `null`, never as `"-"`,
//     because a cell of `"-"` cannot be told from an item genuinely called `-` and it would take
//     the diff protocol's explicit-null clear away from the source. The dash is a DISPLAY decision
//     about absence, which is what it always was.
//   * JOIN THE APP'S OWN KNOWLEDGE. The PoSky chip and the `KnowledgeBadge` are not cells and never
//     were: they are the renderer-bundled corpora, which are the LAST thing on this row that is not
//     served (the plan's cutover ledger item 3 moves them behind Knowledge queries). Drawing them
//     here is what makes the two rows comparable at all — the e2e's oracle is the DOM, and a row
//     that dropped its badges would differ from the app's for a reason that has nothing to do with
//     the fold.
//
// WHAT IT MAY NOT DO, and does not: parse `at` back into an instant, sort, filter, re-key, or total
// anything. The order these rows arrive in is the order they are drawn in.
//
// IT TAKES `cells` AND NOT A ROW because the key is the caller's business (it is the React key and
// the diff's identity, not a thing the reader sees), and because that keeps this component's whole
// contract visible in its signature.

/** Read one cell as the text a table draws. Absent, null and non-text all mean "nothing here", and
 *  the caller decides what nothing looks like — see the dash rule above. */
function text(cells: Cells, name: string): string | null {
  const value = cells[name]
  return typeof value === 'string' ? value : null
}

/** Read one cell as a number, for the one cell that is one. */
function num(cells: Cells, name: string): number | null {
  const value = cells[name]
  return typeof value === 'number' ? value : null
}

/**
 * The dispositions this build can draw a chip for — NARROWED, not cast.
 *
 * A cell is `string | number | boolean | null` by protocol, so the served disposition arrives as a
 * plain string and asserting it into the union would be a lie the type system agreed to. Anything
 * outside the set draws NO CHIP, which is the honest degradation and also a tripwire: the row-parity
 * e2e compares this row's text against the app-fed one, so a disposition the engine grew and this
 * build has not heard of makes that spec red instead of quietly disappearing from a ledger.
 */
const DISPOSITIONS: readonly LootDisposition[] = [
  'currency',
  'sold',
  'hoard',
  'depot',
  'combined',
  'destroyed'
]

function asDisposition(value: string | null): LootDisposition | undefined {
  return DISPOSITIONS.find((d) => d === value)
}

export const EngineFlatRow = memo(function EngineFlatRow({
  cells,
  knowledge,
  onSelect
}: {
  cells: Cells
  knowledge?: ItemKnowledge
  onSelect: (item: string) => void
}): JSX.Element {
  const item = text(cells, 'item') ?? ''
  const count = num(cells, 'count')
  const disposition = text(cells, 'disposition')
  const created = text(cells, 'created')
  const posky = isQuestItem(item)
  return (
    <TableRow
      hover
      // The SAME handle as the app-fed row, deliberately: these are two sources for one list, not
      // two lists, and the e2e that compares them reads one selector.
      data-testid="loot-row"
      sx={{ ...FIXED_ROW, cursor: 'pointer' }}
      onClick={() => onSelect(item)}
    >
      {/* ALREADY A STRING when it arrives — `at` is served as the prose the ledger draws, and the
          instant it was drawn from is a query FIELD with no cell. This is the cell ruling 4 is
          easiest to see in: there is no `fmtTime` here and there cannot be one. */}
      <TableCell sx={{ color: 'text.secondary' }}>{text(cells, 'at') ?? ''}</TableCell>
      <TableCell>
        <Stack direction="row" spacing={1} alignItems="center">
          <Box component="span" data-testid="loot-item-name">
            {count !== null && count > 1 ? `${String(count)} × ${item}` : item}
          </Box>
          {posky && <Chip size="small" color="primary" variant="outlined" label="PoSky" />}
          <KnowledgeBadge knowledge={knowledge} isPosky={posky} />
          <DispositionChip disposition={asDisposition(disposition)} />
          {disposition === 'combined' && created !== null && (
            <Typography variant="caption" color="text.secondary">
              → {created}
            </Typography>
          )}
        </Stack>
      </TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{text(cells, 'from') ?? '-'}</TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{text(cells, 'zone') ?? '-'}</TableCell>
    </TableRow>
  )
})

export const FlatRow = memo(function FlatRow({
  e,
  knowledge,
  onSelect
}: {
  e: LootEvent
  knowledge?: ItemKnowledge
  onSelect: (item: string) => void
}): JSX.Element {
  const posky = isQuestItem(e.item)
  return (
    <TableRow
      hover
      data-testid="loot-row"
      sx={{ ...FIXED_ROW, cursor: 'pointer' }}
      onClick={() => onSelect(e.item)}
    >
      <TableCell sx={{ color: 'text.secondary' }}>{fmtTime(e.ts)}</TableCell>
      <TableCell>
        <Stack direction="row" spacing={1} alignItems="center">
          {/* Plain text, same reason as GroupedRow above (JOS-127). */}
          <Box component="span" data-testid="loot-item-name">
            {e.count && e.count > 1 ? `${e.count} × ${e.item}` : e.item}
          </Box>
          {posky && <Chip size="small" color="primary" variant="outlined" label="PoSky" />}
          <KnowledgeBadge knowledge={knowledge} isPosky={posky} />
          <DispositionChip disposition={e.disposition} />
          {e.disposition === 'combined' && e.created && (
            <Typography variant="caption" color="text.secondary">
              → {e.created}
            </Typography>
          )}
        </Stack>
      </TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{e.source ?? '-'}</TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{e.zone ?? '-'}</TableCell>
    </TableRow>
  )
})
