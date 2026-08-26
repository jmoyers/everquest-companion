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
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import type { CountSource } from '@shared/types'
import type { WindowLootRates } from '@shared/lootRates'
import type { Timeslice } from '@shared/timeslice'
import { formatDateTime, formatTime } from '../../lib/formatDate'
import { COUNT_SOURCE_OPTIONS } from '../inventory/countSource'
import type { GroupRow } from './lootGrouping'
import { LOOT_RATE_TITLE, lootRateText } from './lootRateText'
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

/** Which world this ledger is reading (JOS-484). `app` is the TypeScript fold every user sees. */
export type LootSource = 'app' | 'engine'

/**
 * THE DATA-SOURCE SWITCH — the first product surface that can read the Rust engine (JOS-484).
 *
 * IT IS NOT A PREFERENCE AND IT IS NOT A FEATURE. It exists so a developer can put the two worlds
 * side by side in the running product and so an e2e can assert they draw the same ledger; when the
 * cutover lands (docs/plans/data-server.md, "DELETED IN THE CUTOVER RELEASE") there is one world
 * left and this control goes with the other one.
 *
 * WHICH IS WHY IT IS GATED ON A CONNECTION RATHER THAN ON A FLAG. `LootView` renders it only when
 * the `EngineClientContext` holds a live client, which can only be true under `EQC_ENGINE=1` with a
 * built binary and a healthy launch. A control offering a source that is not there would be the
 * worst of both: invisible in every build that matters and a lie in the one that does not.
 *
 * `exclusive` with a null-guarded handler, the MUI idiom: clicking the pressed button yields null,
 * and a ledger with no source at all is not a state this view has.
 */
export function LootSourceToggle({
  source,
  setSource
}: {
  source: LootSource
  setSource: (v: LootSource) => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Typography variant="caption" color="text.secondary">
        Data source (dev)
      </Typography>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={source}
        onChange={(_e, v: LootSource | null) => {
          if (v !== null) setSource(v)
        }}
        data-testid="loot-source"
      >
        <ToggleButton value="app" data-testid="loot-source-app">
          App
        </ToggleButton>
        <ToggleButton value="engine" data-testid="loot-source-engine">
          Engine
        </ToggleButton>
      </ToggleButtonGroup>
    </Stack>
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
        control={
          // The testid is on the SWITCH rather than the label because a spec clicks the control
          // (JOS-484's row-parity e2e turns grouping off to reach the flat ledger — the shape
          // `loot.ledger` serves). MUI puts the input inside; clicking this element toggles it.
          <Switch
            checked={groupByItem}
            onChange={(e) => setGroupByItem(e.target.checked)}
            data-testid="loot-group"
          />
        }
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
          that cannot mount here.

          WHICH IS WHY THE OPTIONS HAD TO BE TRUE, and two of them were not (JOS-294): they spelled
          out JOS-128's reset semantics on a build that reverted them in JOS-141. This dropdown and
          the Sky tab's write the SAME stored key, so they now draw the same
          `COUNT_SOURCE_OPTIONS` — two copies of one sentence is how the reverted one survived. */}
      <TextField
        select
        size="small"
        label="Count from"
        value={countSource}
        onChange={(e) => setCountSource(e.target.value as CountSource)}
        sx={{ minWidth: 190 }}
      >
        {COUNT_SOURCE_OPTIONS.map((o) => (
          <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
        ))}
      </TextField>
      {/* No tooltip (JOS-127) — the ACCESSIBLE name still says what it does, and an aria-label
          mounts nothing that can cover the two selects it sits beside. */}
      <IconButton size="small" aria-label="Reload inventory export" onClick={onReload}>
        <RefreshIcon fontSize="small" />
      </IconButton>
    </Stack>
  )
}

/**
 * HOW FAST THIS SLICE IS PAYING, on its own line under the caption (JOS-261).
 *
 * It is the aggregate the ledger never had: the timeslice control could already CUT the counts, but
 * nothing on this tab ever divided them by the time they took — the one number two reporters asked
 * for ("motes per hour for the grind I am in"). Both denominators, each named, each beside its own
 * span; the words and every honesty rule behind them live in `lootRateText.ts`.
 *
 * Its own element, and its own testid, rather than another clause of the sentence above: that
 * sentence is about the LEDGER (how many rows, from where, how fresh) and this one is about the
 * PLAY behind it, and an e2e that wants to read one must not have to parse the other.
 */
function LootRateLine({ rates }: { rates: WindowLootRates | null }): JSX.Element | null {
  const text = rates ? lootRateText(rates) : null
  if (text == null) return null
  return (
    // Native `title`, no popper — the JOS-127 rule this file's header states: nothing interactive
    // may mount over the toolbar sitting directly above this line.
    <Typography variant="body2" color="text.secondary" data-testid="loot-rates" title={LOOT_RATE_TITLE}>
      {text}
    </Typography>
  )
}

/** The ledger caption: what the table is showing, and how fast the slice behind it is paying. It
 *  reads the auto-reload instant itself rather than taking it as a prop — it is the only thing that
 *  shows it. */
export function LootSummary({
  eventCount,
  uniqueCount,
  inventoryInfo,
  slice,
  totalCount,
  rates
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
  /** Loot per hour over the slice, both denominators (`useSliceLootRates`). Null ⇒ nothing parsed
   *  yet, and the rate line is simply absent — there is no play to state a rate over. */
  rates: WindowLootRates | null
}): JSX.Element {
  const autoUpdatedAt = useInventoryReloadedAt()
  return (
    // ONE Stack child, TWO lines: the caption and the rate line belong to the same paragraph of the
    // page, and letting them be two children of the view's `spacing={2}` column would put a 16px
    // gutter between a sentence and its own footnote.
    <Box>
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
      <LootRateLine rates={rates} />
    </Box>
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
