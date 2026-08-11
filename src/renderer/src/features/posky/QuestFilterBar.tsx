// posky/QuestFilterBar.tsx — the Sky tracker's one toolbar row.
//
// Split out of `PoskyView.tsx` when that file crossed the measured 400-line readability ceiling
// (2026-08-05), and this is the seam the ceiling was pointing at — the same one the planner's
// `EffectFilterBar` was cut on: the view is a windowed LIST plus its tabs and toasts, the bar is a
// set of independent CONTROLS, and they share nothing but the list state they read and write. No
// behaviour changed in the move.
//
// TWO KINDS OF CONTROL, and the `flexGrow` spacer between them is the whole layout argument.
// LEFT: class / island / boss filters, search, sort and the four hide-toggles — all of them narrow
// the list you are looking at, and all of them live on `useQuestList`'s state, so this file owns
// none of that storage. RIGHT: "Count items from" and "Reload inventory" — these change what the
// tab counts you as HOLDING, which moves every progress number under the bar rather than the set of
// rows above it. Mixing the two groups would read as one undifferentiated row of knobs.
//
// The three pickers lead, in the order a player narrows: class (who am I), island (where am I),
// boss (what am I standing in front of) — the WHERE facets sit beside the WHO facet rather than
// beside the search box, because all three answer "which quests are mine right now".
//
// This row WRAPS (`flexWrap="wrap" useFlexGap`), unlike the planner's nowrap bar: there are thirteen
// controls here and the tab's body is a scrolling accordion list that can afford to start lower.
//
// AND IT MOUNTS NO POPPER (JOS-143). This bar is five dropdowns — three chip-selects, Sort, and
// "Count items from" — and the owner could not work them: the quest rows immediately below open
// `placement="top"` hover cards that land ON this row and hold `pointer-events: auto` while they
// are up, so the click aimed at a select was eaten by a card belonging to a row underneath. That
// is the same defect JOS-127 removed from the Loot ledger, one surface wider, and the direction
// was the same: the poppers go, here and in every file that draws this tab. Hover text that
// survives is a native `title` — an OS tooltip is not in the DOM and has no hit area at all.

import { type JSX, useEffect, useRef } from 'react'
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField
} from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import FilterAltOffIcon from '@mui/icons-material/FilterAltOff'
import StarIcon from '@mui/icons-material/Star'
import StarBorderIcon from '@mui/icons-material/StarBorder'
import type { CountSource } from '@shared/types'
import ChipMultiSelect from '../../components/ChipMultiSelect'
import { SORT_OPTIONS, type SortKey } from './questSort'
import { withPicked } from './questFacets'
import type { QuestListState } from './useQuestList'

export interface QuestFilterBarProps {
  list: QuestListState
  classes: string[]
  countSource: CountSource
  onCountSource: (s: CountSource) => void
  onReload: () => Promise<void>
}

// The three "which quests are mine right now" pickers, in the order a player narrows: who I am,
// where I am, what I am standing in front of. Each is a closed list of what the data offers, and
// each stores its picks, so this is also the group whose state survives leaving the tab.
function QuestPickers({ list, classes }: { list: QuestListState; classes: string[] }): JSX.Element {
  return (
    <>
      <ChipMultiSelect
        options={classes}
        value={list.selectedClasses}
        onChange={(v) => list.setSelectedClasses(v)}
        label="Filter by class"
        placeholder="All classes"
        // The stable handle the JOS-157 drill-down spec reads: a click on a Classes-tab row has to
        // land as a pick VISIBLE in this control, not only in storage, or the user has a filtered
        // list with no chip saying why. The two facet pickers below already carry one for the same
        // reason.
        testId="posky-class-filter"
      />
      {/* The two JOS-124 facets. Both are stored preferences, so both carry a testid the
          persistence spec reads back, and both offer `withPicked` options so a stored pick the
          data no longer knows still shows as a removable chip. */}
      <ChipMultiSelect
        options={withPicked(list.facets.islands, list.islands)}
        value={list.islands}
        onChange={(v) => list.setIslands(v)}
        label="Filter by island"
        placeholder="All islands"
        minWidth={190}
        testId="posky-island-filter"
      />
      <ChipMultiSelect
        options={withPicked(list.facets.bosses, list.bosses)}
        value={list.bosses}
        onChange={(v) => list.setBosses(v)}
        label="Filter by boss"
        placeholder="All bosses"
        minWidth={230}
        testId="posky-boss-filter"
      />
    </>
  )
}

/**
 * The four narrowing CHECKBOXES, split out of the bar for the same reason `QuestPickers` above was:
 * one subject, and the bar was over the measured per-function line ceiling once JOS-145 added the
 * fourth. They are one group because each is a plain "take some rows away" bit on `useQuestList`
 * with no options behind it, unlike the pickers and the two dropdowns.
 *
 * THE FIRST TWO ARE THE TWO MEANINGS OF DONE (JOS-145), side by side and independent. Each LABEL
 * says exactly which reading it is, in the player's own terms ("I have every item for" / "I have
 * turned in"), because that difference is the whole reason there are two — and a label that states
 * its own rule is what lets the hover text stay one clause. The rules and the argument for keeping
 * them apart live on `hasEveryItem` and `everTurnedIn` in questCompletion.ts. Both testids and both
 * stored keys are stable handles for the persistence spec; the older box keeps the ones it always
 * had, so an existing user's saved choice still applies.
 *
 * Both clauses ride a native `title` rather than a popper (JOS-143), like everything else on this
 * bar: these boxes sit between the Sort select and "Count items from", so a card centred on one of
 * them opens into the band a neighbouring option list uses.
 */
function QuestToggles({ list }: { list: QuestListState }): JSX.Element {
  return (
    <>
      <FormControlLabel
        title="Hide quests you already hold every item for. A quest you turn in comes back at zero, because handing it in spends the items, so it stays on this list until you have gathered them again."
        control={
          <Checkbox
            // The stable handle for the persistence spec (tests/e2e/sky-filters.e2e.mts): this
            // box's tick is a stored preference, so it is one of the two an e2e reads back.
            data-testid="posky-hide-completed"
            checked={list.hideCompleted}
            onChange={(e) => list.setHideCompleted(e.target.checked)}
          />
        }
        label="Hide quests I have every item for"
      />
      <FormControlLabel
        title="Hide quests you have handed in at least once, even the ones you are farming again."
        control={
          <Checkbox
            data-testid="posky-hide-turned-in"
            checked={list.hideTurnedIn}
            onChange={(e) => list.setHideTurnedIn(e.target.checked)}
          />
        }
        label="Hide quests I have turned in"
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
    </>
  )
}

// The three pickers, search, sort, the four toggles, and the inventory controls that decide
// which items the whole tab counts you as holding.
export default function QuestFilterBar({
  list,
  classes,
  countSource,
  onCountSource,
  onReload
}: QuestFilterBarProps): JSX.Element {
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'f' || (!event.ctrlKey && !event.metaKey)) return
      event.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [])

  const hasFilters =
    list.query.length > 0 ||
    list.selectedClasses.length > 0 ||
    list.islands.length > 0 ||
    list.bosses.length > 0 ||
    list.hideCompleted ||
    list.hideTurnedIn ||
    list.hideNoItems ||
    list.favoritesOnly

  return (
    <Stack direction="row" spacing={2} flexWrap="wrap" alignItems="center" useFlexGap>
      <QuestPickers list={list} classes={classes} />
      <TextField
        size="small"
        // The handle tests/e2e/sky-turnin.e2e.mts narrows the list with — the same
        // `[data-testid="…"] input` idiom the two facet pickers already carry.
        data-testid="posky-search"
        label="Search item / quest / reward"
        inputRef={searchRef}
        value={list.query}
        onChange={(e) => list.setQuery(e.target.value)}
        sx={{ minWidth: 240 }}
      />
      <TextField
        select
        size="small"
        label="Sort"
        // The handle tests/e2e/sky-dropdowns.e2e.mts opens: that spec's whole subject is whether a
        // click on this control reaches it, so the control needs a name a spec can say.
        data-testid="posky-sort"
        value={list.sort}
        onChange={(e) => list.setSort(e.target.value as SortKey)}
        sx={{ minWidth: 180 }}
      >
        {SORT_OPTIONS.map((o) => (
          <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
        ))}
      </TextField>
      <QuestToggles list={list} />
      <Button
        variant="outlined"
        startIcon={<FilterAltOffIcon />}
        onClick={list.resetFilters}
        disabled={!hasFilters}
        data-testid="posky-reset-filters"
      >
        Reset filters
      </Button>
      <Box sx={{ flexGrow: 1 }} />
      {/* This one carried a three-sentence popper explaining what each source counted, and it
          was the WORST anchor on the row: the widest control, at the wrapping end of the bar,
          directly over the accordion. It is gone rather than restated, and deliberately not
          replaced with a shorter spelling of the same claim — the sentence described the
          JOS-128 reset semantics, which JOS-141 reverted. The one place that states what a
          source means is the `CountSource` doc in shared/types.ts; the three option labels are
          what the user reads here. */}
      <TextField
        select
        size="small"
        label="Count items from"
        data-testid="posky-count-source"
        value={countSource}
        onChange={(e) => onCountSource(e.target.value as CountSource)}
        sx={{ minWidth: 190 }}
      >
        <MenuItem value="log">Log (ever looted)</MenuItem>
        <MenuItem value="inventory">Export, plus loot since</MenuItem>
        <MenuItem value="both">Export if any, else log</MenuItem>
      </TextField>
      {/* The span survives the tooltip that needed it: a DISABLED button swallows no mouse
          events, so the hint has to hang on the wrapper to be readable in the state where the
          user most wants it (Reload is disabled precisely while the source is Log). */}
      <span title="Run /outputfile inventory in-game, then reload">
        <Button
          variant="outlined"
          startIcon={<RefreshIcon />}
          onClick={() => void onReload()}
          disabled={countSource === 'log'}
        >
          Reload inventory
        </Button>
      </span>
    </Stack>
  )
}
