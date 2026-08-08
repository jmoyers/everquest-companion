// posky/QuestFilterBar.tsx — the Sky tracker's one toolbar row.
//
// Split out of `PoskyView.tsx` when that file crossed the measured 400-line readability ceiling
// (2026-08-05), and this is the seam the ceiling was pointing at — the same one the planner's
// `EffectFilterBar` was cut on: the view is a windowed LIST plus its tabs and toasts, the bar is a
// set of independent CONTROLS, and they share nothing but the list state they read and write. No
// behaviour changed in the move.
//
// TWO KINDS OF CONTROL, and the `flexGrow` spacer between them is the whole layout argument.
// LEFT: class/island filters, search, sort/direction and list toggles — all narrow or order the
// list you are looking at, and all live on `useQuestList`'s state, so this file owns none of that
// storage. RIGHT: "Count items from" and "Reload inventory" — these change what the tab counts you
// as HOLDING, which moves every progress number under the bar rather than the set of rows above it.
// Mixing the two groups would read as one undifferentiated row of knobs.
//
// This row WRAPS (`flexWrap="wrap" useFlexGap`), unlike the planner's nowrap bar: there are eleven
// controls here and the tab's body is a scrolling accordion list that can afford to start lower.

import { type JSX, useEffect, useRef, useState } from 'react'
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  IconButton,
  MenuItem,
  Stack,
  TextField
} from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward'
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward'
import FilterAltOffIcon from '@mui/icons-material/FilterAltOff'
import StarIcon from '@mui/icons-material/Star'
import StarBorderIcon from '@mui/icons-material/StarBorder'
import type { CountSource } from '@shared/types'
import ChipMultiSelect from '../../components/ChipMultiSelect'
import { Tooltip } from '../../lib/Tooltip'
import { SORT_OPTIONS, type SortKey } from './questSort'
import type { QuestListState } from './useQuestList'

export interface QuestFilterBarProps {
  list: QuestListState
  classes: string[]
  countSource: CountSource
  onCountSource: (s: CountSource) => void
  onReload: () => Promise<void>
}

type IslandSelectList = Pick<
  QuestListState,
  'availableIslands' | 'selectedIsland' | 'setSelectedIsland'
>

function IslandSelect({ list }: { list: IslandSelectList }): JSX.Element {
  return (
    <TextField
      select
      data-testid="posky-island-filter"
      size="small"
      label="Filter by island"
      value={list.selectedIsland ?? ''}
      onChange={(e) => {
        const value = e.target.value
        list.setSelectedIsland(value === '' ? null : Number(value))
      }}
      sx={{ minWidth: 180 }}
    >
      <MenuItem value="">All islands</MenuItem>
      {list.availableIslands.map((island) => (
        <MenuItem key={island} value={island}>
          Island {island}
        </MenuItem>
      ))}
    </TextField>
  )
}

type SortControlList = Pick<
  QuestListState,
  'sort' | 'sortDirection' | 'setSort' | 'toggleSortDirection'
>

function SortControl({ list }: { list: SortControlList }): JSX.Element {
  const nextDirectionLabel = list.sortDirection === 'asc' ? 'descending' : 'ascending'

  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <TextField
        select
        data-testid="posky-sort"
        size="small"
        label="Sort"
        value={list.sort}
        onChange={(e) => list.setSort(e.target.value as SortKey)}
        sx={{ minWidth: 180 }}
      >
        {SORT_OPTIONS.map((o) => (
          <MenuItem key={o.value} value={o.value}>
            {o.label}
          </MenuItem>
        ))}
      </TextField>
      <Tooltip title={`Change to ${nextDirectionLabel} order`}>
        <IconButton
          data-testid="posky-sort-direction"
          size="small"
          aria-label={`Change to ${nextDirectionLabel} order`}
          onClick={list.toggleSortDirection}
        >
          {list.sortDirection === 'asc' ? (
            <ArrowUpwardIcon fontSize="small" />
          ) : (
            <ArrowDownwardIcon fontSize="small" />
          )}
        </IconButton>
      </Tooltip>
    </Stack>
  )
}

type ResetFilterList = Pick<
  QuestListState,
  | 'selectedClasses'
  | 'selectedIsland'
  | 'query'
  | 'hideCompleted'
  | 'hideNoItems'
  | 'favoritesOnly'
  | 'resetFilters'
>

function ResetFiltersButton({ list }: { list: ResetFilterList }): JSX.Element {
  const active =
    list.selectedClasses.length > 0 ||
    list.selectedIsland !== null ||
    list.query.trim() !== '' ||
    list.hideCompleted ||
    list.hideNoItems ||
    list.favoritesOnly
  return (
    <Button
      data-testid="posky-reset-filters"
      variant="outlined"
      size="small"
      startIcon={<FilterAltOffIcon />}
      aria-label="Reset filters and search"
      disabled={!active}
      onClick={list.resetFilters}
    >
      Reset filters
    </Button>
  )
}

/** The one select whose explanatory tooltip must yield while its portalled menu is open. */
function CountSourceSelect({
  countSource,
  onCountSource
}: Pick<QuestFilterBarProps, 'countSource' | 'onCountSource'>): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [tipOpen, setTipOpen] = useState(false)

  return (
    <Tooltip
      title="Which source decides what you have."
      open={tipOpen}
      onOpen={() => setTipOpen(true)}
      onClose={() => setTipOpen(false)}
      disableHoverListener={menuOpen}
      disableFocusListener={menuOpen}
      disableTouchListener={menuOpen}
    >
      <TextField
        select
        data-testid="posky-count-source"
        size="small"
        label="Count items from"
        value={countSource}
        onChange={(e) => onCountSource(e.target.value as CountSource)}
        slotProps={{
          select: {
            onOpen: () => {
              setMenuOpen(true)
              setTipOpen(false)
            },
            onClose: () => setMenuOpen(false)
          }
        }}
        sx={{ minWidth: 170 }}
      >
        <MenuItem value="log">Log (looted)</MenuItem>
        <MenuItem value="inventory">Inventory export</MenuItem>
        <MenuItem value="both">Both (max)</MenuItem>
      </TextField>
    </Tooltip>
  )
}

// List filters/order plus the inventory controls that decide which items the tab counts as held.
export default function QuestFilterBar({
  list,
  classes,
  countSource,
  onCountSource,
  onReload
}: QuestFilterBarProps): JSX.Element {
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Electron has no browser find bar to fall back to. While this search-bearing view is
    // mounted, the familiar find shortcut belongs to its existing domain search.
    const onFind = (event: KeyboardEvent): void => {
      const findKey = event.key.toLowerCase() === 'f' && (event.ctrlKey || event.metaKey)
      if (!findKey || event.altKey || event.shiftKey) return
      event.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('keydown', onFind)
    return () => window.removeEventListener('keydown', onFind)
  }, [])

  return (
    <Stack direction="row" spacing={2} flexWrap="wrap" alignItems="center" useFlexGap>
      <ChipMultiSelect
        options={classes}
        value={list.selectedClasses}
        onChange={(v) => list.setSelectedClasses(v)}
        label="Filter by class"
        placeholder="All classes"
        testId="posky-class-filter"
      />
      <IslandSelect list={list} />
      <TextField
        inputRef={searchRef}
        data-testid="posky-search"
        size="small"
        label="Search item / quest / reward"
        value={list.query}
        onChange={(e) => list.setQuery(e.target.value)}
        sx={{ minWidth: 240 }}
      />
      <SortControl list={list} />
      <FormControlLabel
        control={
          <Checkbox
            // The stable handle for the persistence spec (tests/e2e/sky-filters.e2e.mts): this
            // box's tick is a stored preference, so it is the one control here an e2e reads back.
            data-testid="posky-hide-completed"
            checked={list.hideCompleted}
            onChange={(e) => list.setHideCompleted(e.target.checked)}
          />
        }
        label="Hide completed"
      />
      <FormControlLabel
        control={
          <Checkbox
            data-testid="posky-turn-ins-only"
            checked={list.hideNoItems}
            onChange={(e) => list.setHideNoItems(e.target.checked)}
          />
        }
        label="Only quests with turn-ins"
      />
      <FormControlLabel
        control={
          <Checkbox
            data-testid="posky-favorites-only"
            checked={list.favoritesOnly}
            onChange={(e) => list.setFavoritesOnly(e.target.checked)}
            icon={<StarBorderIcon />}
            checkedIcon={<StarIcon />}
            sx={{ color: 'warning.main', '&.Mui-checked': { color: 'warning.main' } }}
          />
        }
        label="Favorites only"
      />
      <ResetFiltersButton list={list} />
      <Box sx={{ flexGrow: 1 }} />
      <CountSourceSelect countSource={countSource} onCountSource={onCountSource} />
      <Tooltip title="Run /outputfile inventory in-game, then reload">
        <span>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={() => void onReload()}
            disabled={countSource === 'log'}
          >
            Reload inventory
          </Button>
        </span>
      </Tooltip>
    </Stack>
  )
}
