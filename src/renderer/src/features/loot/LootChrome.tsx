// ============================================================================
// LootChrome — everything around the Loot ledger's table: the filter bar, the caption, and the
// notices that stand in for rows the table cannot show.
// ============================================================================
//
// Split out of LootView (JOS-160) when the view crossed its measured line ceiling. Nothing here
// changed in the move except where it lives; the one NEW member is `OwnedNotLootedNotice`, and its
// header says why it exists. The split is along the seam the file already had: LootView owns the
// state and the derivation, this file owns the chrome, and the table is `LootTables.tsx`.
//
// NO TOOLTIP MOUNTS ANYWHERE IN HERE (JOS-127, owner direction 2026-08-09). A 0.14.0 user could not
// change the sort because interactive hover cards on the surfaces below the toolbar opened upward
// across it and ate the click. The rule travelled with the code: labels and accessible names say
// what a popper used to, and `tests/tooltipCursor.test.mts` pins the absence structurally.

import { type JSX, useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Chip,
  FormControlLabel,
  IconButton,
  Link,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography
} from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import type { CountSource } from '@shared/types'
import type { Timeslice } from '@shared/timeslice'
import { formatDateTime, formatTime } from '../../lib/formatDate'
import type { GroupRow } from './lootGrouping'
import {
  DEFAULT_LOOT_SORT,
  isLootSortKey,
  LOOT_SORT_OPTIONS,
  type LootSortKey
} from './lootSort'

// The grouped table's order survives restarts, the way the Quests tab's does (useQuestList's
// `eq.questSort`). An order retired from LOOT_SORT_OPTIONS falls back to the default rather than
// sorting by nothing.
const SORT_KEY = 'eq.lootSort'

function loadLootSort(): LootSortKey {
  const v = localStorage.getItem(SORT_KEY)
  return isLootSortKey(v) ? v : DEFAULT_LOOT_SORT
}

/** The grouped order and its persistence, in one line of the view. */
export function useLootSort(): [LootSortKey, (v: LootSortKey) => void] {
  const [sort, setSort] = useState<LootSortKey>(loadLootSort)
  useEffect(() => {
    localStorage.setItem(SORT_KEY, sort)
  }, [sort])
  return [sort, setSort]
}

/** When main's chokidar watch last re-read the `*-Inventory.txt` underneath us — surfaced quietly
 *  in the caption, in success-green, rather than as a toast. */
export function useInventoryReloadedAt(): number | null {
  const [at, setAt] = useState<number | null>(null)
  useEffect(() => window.eq.onInventoryReload(() => setAt(Date.now())), [])
  return at
}

// The grouped table's order picker (JOS-91). Its own component so LootToolbar stays inside the
// measured lines-per-function ceiling.
//
// It is rendered ONLY when grouping is on, and that is a claim about honesty rather than about
// clutter: ungrouped, the ledger is already a chronological one — newest first — so an order
// picker there would be a control that either does nothing or lies about what it changed.
function LootSortSelect({
  sort,
  setSort
}: {
  sort: LootSortKey
  setSort: (v: LootSortKey) => void
}): JSX.Element {
  return (
    <TextField
      select
      size="small"
      label="Sort"
      value={sort}
      onChange={(e) => setSort(e.target.value as LootSortKey)}
      sx={{ minWidth: 160 }}
      data-testid="loot-sort"
    >
      {LOOT_SORT_OPTIONS.map((o) => (
        <MenuItem key={o.value} value={o.value}>
          {o.label}
        </MenuItem>
      ))}
    </TextField>
  )
}

export interface LootToolbarProps {
  query: string
  setQuery: (v: string) => void
  groupByItem: boolean
  setGroupByItem: (v: boolean) => void
  questOnly: boolean
  setQuestOnly: (v: boolean) => void
  sort: LootSortKey
  setSort: (v: LootSortKey) => void
  invOnlyCount: number
  showInventoryOnly: boolean
  onToggleInventoryOnly: () => void
  countSource: CountSource
  setCountSource: (s: CountSource) => void
  onReload: () => void
}

// The filter bar: search, the two view switches, the grouped table's sort, the opt-in
// inventory-only chip, and the count-source select that decides what "In inventory" is counting.
export function LootToolbar({
  query,
  setQuery,
  groupByItem,
  setGroupByItem,
  questOnly,
  setQuestOnly,
  sort,
  setSort,
  invOnlyCount,
  showInventoryOnly,
  onToggleInventoryOnly,
  countSource,
  setCountSource,
  onReload
}: LootToolbarProps): JSX.Element {
  return (
    <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
      {/* IT SEARCHES WHAT YOU OWN, NOT ONLY WHAT YOU LOOTED (JOS-160) — the label says "looted"
          because that is what the ledger under it is, but a query also reaches the items only your
          `/outputfile inventory` export knows about (useLootRows / ownedItems.ts). */}
      <TextField
        size="small"
        label="Search looted item"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        sx={{ minWidth: 260 }}
      />
      <FormControlLabel
        control={<Switch checked={groupByItem} onChange={(e) => setGroupByItem(e.target.checked)} />}
        label="Group by item"
      />
      <FormControlLabel
        control={<Switch checked={questOnly} onChange={(e) => setQuestOnly(e.target.checked)} />}
        label="Only Plane of Sky items"
      />
      {groupByItem && <LootSortSelect sort={sort} setSort={setSort} />}
      {groupByItem && invOnlyCount > 0 && (
        <Chip
          size="small"
          variant={showInventoryOnly ? 'filled' : 'outlined'}
          color={showInventoryOnly ? 'primary' : 'default'}
          label={`+${invOnlyCount.toLocaleString()} in inventory only`}
          onClick={onToggleInventoryOnly}
        />
      )}
      <Box sx={{ flexGrow: 1 }} />
      {/* Still NO tooltip (JOS-127): this select is one of the controls the removed poppers were
          covering, so JOS-128 says what the options do IN THE OPTIONS instead of in a hover card
          that cannot mount here. */}
      <TextField
        select
        size="small"
        label="Count from"
        value={countSource}
        onChange={(e) => setCountSource(e.target.value as CountSource)}
        sx={{ minWidth: 190 }}
      >
        <MenuItem value="log">Log (ever looted)</MenuItem>
        <MenuItem value="inventory">Export, plus loot since</MenuItem>
        <MenuItem value="both">Export if any, else log</MenuItem>
      </TextField>
      {/* No tooltip (JOS-127) — the ACCESSIBLE name still says what it does, and an aria-label
          mounts nothing that can cover the two selects it sits beside. */}
      <IconButton size="small" aria-label="Reload inventory export" onClick={onReload}>
        <RefreshIcon fontSize="small" />
      </IconButton>
    </Stack>
  )
}

/** The one-line ledger caption. It reads the auto-reload instant itself rather than taking it as a
 *  prop — it is the only thing that shows it. */
export function LootSummary({
  eventCount,
  uniqueCount,
  inventoryInfo,
  slice,
  totalCount
}: {
  eventCount: number
  uniqueCount: number
  inventoryInfo?: { path: string; loadedAt: string }
  /** The slice in force. It words the counts, and it is the reason the total is also stated. */
  slice: Timeslice
  /** Loot lines in the WHOLE record. Stated beside the sliced count because "in totality vs this
   *  session" is the literal question this control was asked for — a ledger that silently showed
   *  a third of its rows would answer half of it. Omitted under `All`, where the two are equal. */
  totalCount: number
}): JSX.Element {
  const autoUpdatedAt = useInventoryReloadedAt()
  return (
    <Typography variant="body2" color="text.secondary" data-testid="loot-summary">
      {eventCount.toLocaleString()} loot events
      {slice.id === 'all' ? '' : ` in ${slice.caption} of ${totalCount.toLocaleString()} all time`} ·{' '}
      {uniqueCount.toLocaleString()} unique items · click a row for mob/zone/drop-rate breakdown ·{' '}
      {inventoryInfo
        ? `inventory export ${formatDateTime(new Date(inventoryInfo.loadedAt).getTime())}`
        : 'no inventory export loaded'}
      {autoUpdatedAt && (
        <Typography component="span" variant="body2" sx={{ color: 'success.main' }}>
          {' '}· auto-updated {formatTime(autoUpdatedAt)}
        </Typography>
      )}
    </Typography>
  )
}

// Nothing parsed yet is a STATE, not an error: say where the rows will come from.
function NoLootYet(): JSX.Element {
  return (
    <Alert severity="info">
      No loot parsed yet. Loot something in-game (or check your log path) - every{' '}
      <code>--You have looted …--</code> line shows up here in real time, and the full history is read
      from your log on launch.
    </Alert>
  )
}

/** A slice that holds nothing is a STATE, and it says WHICH slice — distinguishable from "nothing
 *  parsed yet", which is about the log rather than about the control. */
function SliceEmpty({ slice }: { slice: Timeslice }): JSX.Element {
  return (
    <Alert severity="info" data-testid="loot-slice-empty">
      No loot in {slice.caption}. Widen the slice to see the rest of this character&apos;s history.
    </Alert>
  )
}

/** How many owned-but-never-looted names the notice spells out before it starts counting. */
const NOTICE_NAMES = 8

/**
 * THE UNGROUPED LEDGER'S ANSWER TO A SEARCH IT CANNOT SHOW (JOS-160).
 *
 * Flip "Group by item" off and the table becomes a list of loot EVENTS — and an item you own but
 * never looted has no event, so there is nothing for the search to put there however hard it looks.
 * Grouped, those items join the table directly; here, silence would be the same wrong answer this
 * ticket is about. So the view says the thing outright and makes it a way in: each name opens the
 * drill-down, where the export's count and the log's zero sit side by side.
 */
function OwnedNotLootedNotice({
  rows,
  onSelect
}: {
  rows: GroupRow[]
  onSelect: (item: string) => void
}): JSX.Element {
  const shown = rows.slice(0, NOTICE_NAMES)
  const rest = rows.length - shown.length
  return (
    <Alert severity="info" data-testid="loot-owned-not-looted">
      Your inventory export has{' '}
      {shown.map((r, i) => (
        <span key={r.key}>
          {i > 0 && ', '}
          <Link component="button" type="button" underline="hover" onClick={() => onSelect(r.item)}>
            {r.item}
          </Link>
          {r.owned !== undefined && r.owned > 0 ? ` (${String(r.owned)})` : ''}
        </span>
      ))}
      {rest > 0 ? ` and ${String(rest)} more` : ''}, never looted on this character - so no row in
      this ledger. Turn on Group by item to list them beside your loot.
    </Alert>
  )
}

/**
 * The ledger's three states-not-errors, in one element: nothing parsed at all, a search that
 * matched something the ungrouped table cannot hold, and a slice that holds nothing.
 *
 * "Nothing parsed yet" SHORT-CIRCUITS the other two: with no history there is no slice to be empty
 * of and no export row worth mentioning, and stacking three info alerts on an empty tab would say
 * the same thing three ways.
 */
export function LootNotices({
  historyCount,
  slicedCount,
  slice,
  owned,
  onSelect
}: {
  historyCount: number
  slicedCount: number
  slice: Timeslice
  /** Owned-but-never-looted rows the current view cannot show. Empty ⇒ no notice. */
  owned: GroupRow[]
  onSelect: (item: string) => void
}): JSX.Element | null {
  if (historyCount === 0) return <NoLootYet />
  return (
    <>
      {owned.length > 0 && <OwnedNotLootedNotice rows={owned} onSelect={onSelect} />}
      {slicedCount === 0 && <SliceEmpty slice={slice} />}
    </>
  )
}
