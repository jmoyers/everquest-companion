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
// none of that storage. RIGHT: "Count items from" — it changes what the tab counts you as HOLDING,
// which moves every progress number under the bar rather than the set of rows above it. Mixing the
// two groups would read as one undifferentiated row of knobs.
//
// AND SINCE JOS-268 THE RIGHT GROUP CARRIES THE DUMP'S FRESHNESS TOO, quietly and out of flow: the
// `/outputfile inventory` line hangs off the bottom edge of that one dropdown and never moves
// anything (the block on `InventorySource` is the whole argument). The "Reload inventory" button
// that used to sit beside the dropdown is gone — the app follows the file by itself now.
// JOS-294 gave that slot its second sentence: under `log`, with a dump already loaded, it says the
// export is loaded and NOT being counted. The one state that used to say nothing was the one the
// four reports were all standing in.
//
// AND JOS-431 PUT A RE-READ BACK ON THAT LINE, which is not a revert of the button JOS-268 deleted.
// What went was a full-height outlined control beside the dropdown, born `disabled` on the default
// source, that could only redo what the app had already done. What is there now is one quiet word
// INSIDE the freshness row, next to the two instants that are its own receipt — for the session
// where "the app follows the file" turned out not to be true (report 01M0FMGA4DQRMG46290GWVVHQ6:
// the dump was fresh on disk and the tab showed a days-old timestamp until a restart).
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

import { type JSX, memo, useCallback, useState } from 'react'
import {
  Box,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import StarIcon from '@mui/icons-material/Star'
import StarBorderIcon from '@mui/icons-material/StarBorder'
import type { CountSource } from '@shared/types'
import ChipMultiSelect from '../../components/ChipMultiSelect'
import OutputKindLine from '../../components/OutputKindLine'
import { COUNT_SOURCE_OPTIONS, countsFromInventory } from '../inventory/countSource'
import { SORT_OPTIONS, type SortKey } from './questSort'
import { withPicked } from './questFacets'
import type { QuestListState } from './useQuestList'

export interface QuestFilterBarProps {
  list: QuestListState
  classes: string[]
  countSource: CountSource
  onCountSource: (s: CountSource) => void
  /**
   * When this app last read the `/outputfile inventory` dump (`inventorySource.readAt`), or `null`
   * for "never" — the freshness line's second instant (JOS-253). It rides down here rather than
   * being drawn by the view because the line now BELONGS to the dropdown below (JOS-268).
   */
  inventoryLoadedAt: number | null
}

/**
 * WHY THE CONTROLS BELOW TAKE THEIR OWN STATE RATHER THAN `list` (JOS-206).
 *
 * `useQuestList` returns a NEW object every render, so a component that takes `list` can never be
 * memoized — and this bar re-renders on every character typed into the search box, because the
 * search box writes list state that the rows below are drawn from. Measured, that was ~4 ms per
 * keystroke, most of it the three Autocompletes rebuilding their option lists, adornments and
 * chips to draw exactly what they were already drawing. Each group therefore takes the pieces it
 * actually reads — all of them identity-stable at their source (state values, `useState` setters,
 * a `useMemo`'d facet table) — and is wrapped in `memo`, so typing re-renders the search field and
 * the Stack around it and nothing else.
 */

// The three "which quests are mine right now" pickers, in the order a player narrows: who I am,
// where I am, what I am standing in front of. Each is a closed list of what the data offers, and
// each stores its picks, so this is also the group whose state survives leaving the tab.
const QuestPickers = memo(function QuestPickers({
  classes,
  facets,
  selectedClasses,
  setSelectedClasses,
  islands,
  setIslands,
  bosses,
  setBosses
}: {
  classes: string[]
  facets: QuestListState['facets']
  selectedClasses: string[]
  setSelectedClasses: (v: string[]) => void
  islands: string[]
  setIslands: (v: string[]) => void
  bosses: string[]
  setBosses: (v: string[]) => void
}): JSX.Element {
  return (
    <>
      <ChipMultiSelect
        options={classes}
        value={selectedClasses}
        onChange={setSelectedClasses}
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
        options={withPicked(facets.islands, islands)}
        value={islands}
        onChange={setIslands}
        label="Filter by island"
        placeholder="All islands"
        minWidth={190}
        testId="posky-island-filter"
      />
      <ChipMultiSelect
        options={withPicked(facets.bosses, bosses)}
        value={bosses}
        onChange={setBosses}
        label="Filter by boss"
        placeholder="All bosses"
        minWidth={230}
        testId="posky-boss-filter"
      />
    </>
  )
})

/**
 * THE SEARCH BOX HOLDS ITS OWN TEXT (JOS-206).
 *
 * It used to be a controlled field reading `list.query`, so every character travelled up to
 * `useQuestList`, back down through this whole bar, and only then into the input — the echo the
 * user sees was queued behind the list's own re-render. Local state puts the character on screen
 * first and publishes it after; `useDeferredValue` in `useQuestList` already handles the rest.
 *
 * IT STILL FOLLOWS A PROGRAMMATIC WRITE, which is the half that is easy to lose: `revealQuest`
 * (a celebration toast's deep link) and the ambiguous-quest chips both SET the query, and a field
 * that only ever published would sit there showing the old text. The prev-props pattern below is
 * React's documented way to adjust state during render — `lastPublished` is what this component
 * last saw or sent, so a `query` that differs from it can only have come from somewhere else.
 */
const QuestSearchField = memo(function QuestSearchField({
  query,
  setQuery
}: {
  query: string
  setQuery: (v: string) => void
}): JSX.Element {
  const [text, setText] = useState(query)
  const [lastPublished, setLastPublished] = useState(query)
  if (query !== lastPublished) {
    setLastPublished(query)
    setText(query)
  }
  return (
    <TextField
      size="small"
      // The handle tests/e2e/sky-turnin.e2e.mts narrows the list with — the same
      // `[data-testid="…"] input` idiom the two facet pickers already carry.
      data-testid="posky-search"
      // JOS-207 added the boss and the island to what this matches, and the label says so: the
      // two facts a player standing in the zone is most likely to type were the two the box
      // silently did not search, and a control that has grown has to be seen to have grown.
      // questSearch.ts owns the rule; this string is the promise it keeps.
      label="Search quest / item / reward / boss / island"
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        // Recorded as well as published, so the sync check above does not fire on the way back.
        setLastPublished(e.target.value)
        setQuery(e.target.value)
      }}
      // Wide enough that the (now longer) label fits its own notch rather than being clipped by
      // it. The bar wraps (`flexWrap` on the Stack below), so buying the room costs a row on a
      // narrow window and never truncates the promise.
      sx={{ minWidth: 320 }}
    />
  )
})

/** The sort order. Its own memoized component for the reason the block above `QuestPickers` gives:
 *  a `TextField select` is a MUI Select, and re-drawing one per keystroke buys nothing. */
const QuestSortSelect = memo(function QuestSortSelect({
  sort,
  setSort
}: {
  sort: SortKey
  setSort: (v: SortKey) => void
}): JSX.Element {
  return (
    <TextField
      select
      size="small"
      label="Sort"
      // The handle tests/e2e/sky-dropdowns.e2e.mts opens: that spec's whole subject is whether a
      // click on this control reaches it, so the control needs a name a spec can say.
      data-testid="posky-sort"
      value={sort}
      onChange={(e) => setSort(e.target.value as SortKey)}
      sx={{ minWidth: 180 }}
    >
      {SORT_OPTIONS.map((o) => (
        <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
      ))}
    </TextField>
  )
})

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
const QuestToggles = memo(function QuestToggles({
  hideCompleted,
  setHideCompleted,
  hideTurnedIn,
  setHideTurnedIn,
  hideNoItems,
  setHideNoItems,
  favoritesOnly,
  setFavoritesOnly
}: {
  hideCompleted: boolean
  setHideCompleted: (v: boolean) => void
  hideTurnedIn: boolean
  setHideTurnedIn: (v: boolean) => void
  hideNoItems: boolean
  setHideNoItems: (v: boolean) => void
  favoritesOnly: boolean
  setFavoritesOnly: (v: boolean) => void
}): JSX.Element {
  return (
    <>
      <FormControlLabel
        title="Hide quests you already hold every item for. A quest you turn in comes back at zero, because handing it in spends the items, so it stays on this list until you have gathered them again."
        control={
          <Checkbox
            // The stable handle for the persistence spec (tests/e2e/sky-filters.e2e.mts): this
            // box's tick is a stored preference, so it is one of the two an e2e reads back.
            data-testid="posky-hide-completed"
            checked={hideCompleted}
            onChange={(e) => setHideCompleted(e.target.checked)}
          />
        }
        label="Hide quests I have every item for"
      />
      <FormControlLabel
        title="Hide quests you have handed in at least once, even the ones you are farming again."
        control={
          <Checkbox
            data-testid="posky-hide-turned-in"
            checked={hideTurnedIn}
            onChange={(e) => setHideTurnedIn(e.target.checked)}
          />
        }
        label="Hide quests I have turned in"
      />
      <FormControlLabel
        control={<Checkbox checked={hideNoItems} onChange={(e) => setHideNoItems(e.target.checked)} />}
        label="Only quests with turn-ins"
      />
      <FormControlLabel
        control={
          <Checkbox
            checked={favoritesOnly}
            onChange={(e) => setFavoritesOnly(e.target.checked)}
            icon={<StarBorderIcon />}
            checkedIcon={<StarIcon />}
            sx={{ color: 'warning.main', '&.Mui-checked': { color: 'warning.main' } }}
          />
        }
        label="Favorites only"
      />
    </>
  )
})

/**
 * WHAT THE TAB SAYS WHEN THE DUMP IS LOADED AND THE ACTIVE SOURCE IGNORES IT (JOS-294, scope B).
 *
 * JOS-268 gated the freshness line on `countsFromInventory` — right, then, because `log` was the
 * DEFAULT, and a permanent bar about a file the current source does not read is the caveat the UI
 * diet refuses. JOS-294 makes `log` an EXPLICIT choice (the default is `both` now), and that turns
 * the same silence into the ticket's worst state: a player who ran `/outputfile inventory`, whose
 * dump this app went and loaded by itself, looking at counts that ignore every item in it and at a
 * screen with not one word about why. Three states, one line each, and the broken one was the third:
 *
 *   inventory-backed source  the freshness line — the file's age and when we read it (JOS-253).
 *   `log`, no dump loaded    nothing. There is no file, so there is nothing to fail to count.
 *   `log`, dump loaded       THIS. We have the file, we are not counting it, and the sentence says
 *                            so and names the source that would.
 *
 * It is drawn in the same slot, in the same quiet grey, out of flow: a line that appeared under the
 * dropdown by pushing the quest list down the page would be a worse answer than the silence.
 */
const DumpNotCounted = memo(function DumpNotCounted(): JSX.Element {
  return (
    <Typography
      variant="caption"
      color="text.disabled"
      data-testid="posky-inventory-ignored"
      // A BLOCK, and the same compressed line-height the quiet freshness line uses (OutputFileLine's
      // `QUIET`). Both halves were measured by the e2e rather than guessed: MUI's caption is an
      // inline span at line-height 1.66, and an inline box is laid out from FONT METRICS centred in
      // its line box — so the default rendering started 5px below the dropdown's edge and ended 4px
      // INSIDE the counts row, which is the one thing this slot is not allowed to do. As a block at
      // 1.2 the element's box IS the line box: flush to the edge above it, 14px tall, inside the gap.
      sx={{ display: 'block', lineHeight: 1.2 }}
    >
      Inventory export loaded but not counted - switch to Both to include it.
    </Typography>
  )
})

/** The RIGHT group: what the tab counts you as holding, and how fresh that is. Memoized like the
 *  rest — neither the dropdown nor the line has anything to do with the search box.
 *
 *  EXPORTED SINCE JOS-294 (scope C): the Ready tab draws this same group. A control that can empty
 *  a tab has to be visible from that tab — the JOS-155 argument, which put the first-time toggle
 *  above both of the Ready tab's states — and this one can empty it hardest of all, because under
 *  the wrong source a player holding every item for a quest is holding nothing the app can see. */
export const InventorySource = memo(function InventorySource({
  countSource,
  onCountSource,
  inventoryLoadedAt
}: {
  countSource: CountSource
  onCountSource: (s: CountSource) => void
  inventoryLoadedAt: number | null
}): JSX.Element {
  /**
   * RE-READ THE DUMP, FROM THE LINE THAT DATES IT (JOS-431).
   *
   * The ask is the reporter's own ("is there a way to refresh, or a dropdown to select an
   * inventory file?" — 01M0FMGA4DQRMG46290GWVVHQ6), and it is here rather than threaded down from
   * `PoskyView` because there is nothing for a parent to own: main answers this by PUSHING
   * (`inventory:reload` + `progress`), which is the same path the automatic re-read takes, so
   * `useProgress`, the freshness line and every other dump-fed surface update from one place. A
   * prop would have been the same call, drilled through four callers of this component.
   *
   * NOT the second half of the ask. A dropdown to pick an inventory FILE is a second discovery
   * model beside `preferredOutputFile`, and JOS-431 is a robustness ticket: the watcher fix is
   * what makes the app find the right file, and this is the door for the day it still does not.
   */
  const refresh = useCallback(() => {
    // Fire and forget, and a rejection is not news: main never throws here (it answers a missing
    // dump with `ok: false`), and the two stamps on the line beside this button are what tell the
    // player whether anything moved.
    void window.eq.reloadInventory().catch(() => undefined)
  }, [])
  return (
    <Box sx={{ position: 'relative', display: 'inline-flex' }}>
      {/* This one carried a three-sentence popper explaining what each source counted, and it
          was the WORST anchor on the row: the widest control, at the wrapping end of the bar,
          directly over the accordion. It is gone rather than restated, and deliberately not
          replaced with a shorter spelling of the same claim — the sentence described the
          JOS-128 reset semantics, which JOS-141 reverted. The one place that states what a
          source means is the `CountSource` doc in shared/types.ts; the three option labels are
          what the user reads here.

          AND TWO OF THOSE LABELS DESCRIBED THE SAME REVERTED SEMANTICS UNTIL JOS-294 — the popper
          was deleted and the sentences under it were not. They come from `COUNT_SOURCE_OPTIONS`
          now, one table shared with the Loot ledger's identical dropdown, which is also why the
          two surfaces can no longer disagree about what the key they share means. */}
      <TextField
        select
        size="small"
        label="Count items from"
        data-testid="posky-count-source"
        value={countSource}
        onChange={(e) => onCountSource(e.target.value as CountSource)}
        sx={{ minWidth: 190 }}
      >
        {COUNT_SOURCE_OPTIONS.map((o) => (
          <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
        ))}
      </TextField>
      {/* THE FRESHNESS LINE, HUNG UNDER THE DROPDOWN IT BELONGS TO (JOS-268).

          There WAS a "Reload inventory" button here, and removing it is the ticket's fourth
          constraint: main reads the dump at session start and follows it on every rewrite
          (JOS-253, session.ts), so the button could only ever do again what the app had already
          done by itself. (Its own history is worth one sentence, because it was the JOS-253 bug:
          it carried `disabled={countSource === 'log'}` and `log` is the DEFAULT source, so on a
          fresh install it was born disabled and no detection path was ever consulted.) The Loot
          ledger keeps its own reload control; this surface no longer needs one.

          ABSOLUTE, AND THAT IS THE POINT. The line is out of flow, anchored to the bottom edge of
          the select above it, so the counts and the quest list underneath sit at exactly the same
          y whether it is on screen or not — a caption that shoved the whole tab down when you
          picked an inventory source, and pulled it back up when you picked the log, would be the
          loudest thing on the tab. `right: 0` (with no `left`) keeps the box the width of its own
          text, so it grows LEFTWARD across the panel background and eats no clicks it does not
          own. It hangs in the gap the view's `Stack spacing` already leaves below the bar, which
          is why the quiet chrome compresses its line-height (OutputFileLine's `QUIET`).

          `loadedAt` is what this tab knows and the registry cannot: the store's record of when
          main last read a dump. `null` says we have never loaded one, which is a different
          sentence from the file not existing, and both can be true at once.

          AND THE SLOT HAS A SECOND TENANT SINCE JOS-294 (scope B): under `log`, with a dump this
          app has already loaded, `DumpNotCounted` says so here. Same box, same quiet grey, same
          out-of-flow geometry — so every layout promise this ticket made about the freshness line
          is a promise about that sentence too, and neither of them can shove the tab down. */}
      {(countsFromInventory(countSource) || inventoryLoadedAt !== null) && (
        <Box
          // FLUSH TO THE SELECT'S BOTTOM EDGE, with no margin of its own: the gap this hangs in is
          // the view's own `Stack spacing` and it is 17px, which a 12px caption row fills almost
          // exactly. Two pixels of offset here is two pixels of the row below.
          sx={{ position: 'absolute', top: '100%', right: 0, zIndex: 1, whiteSpace: 'nowrap' }}
        >
          {countsFromInventory(countSource) ? (
            <OutputKindLine
              quiet
              kind="inventory"
              loadedAt={inventoryLoadedAt}
              onRefresh={refresh}
              testId="posky-inventory-fresh"
            />
          ) : (
            <DumpNotCounted />
          )}
        </Box>
      )}
    </Box>
  )
})

// The three pickers, search, sort, the four toggles, and the inventory controls that decide
// which items the whole tab counts you as holding.
export default function QuestFilterBar({
  list,
  classes,
  countSource,
  onCountSource,
  inventoryLoadedAt
}: QuestFilterBarProps): JSX.Element {
  return (
    <Stack direction="row" spacing={2} flexWrap="wrap" alignItems="center" useFlexGap>
      <QuestPickers
        classes={classes}
        facets={list.facets}
        selectedClasses={list.selectedClasses}
        setSelectedClasses={list.setSelectedClasses}
        islands={list.islands}
        setIslands={list.setIslands}
        bosses={list.bosses}
        setBosses={list.setBosses}
      />
      <QuestSearchField query={list.query} setQuery={list.setQuery} />
      <QuestSortSelect sort={list.sort} setSort={list.setSort} />
      <QuestToggles
        hideCompleted={list.hideCompleted}
        setHideCompleted={list.setHideCompleted}
        hideTurnedIn={list.hideTurnedIn}
        setHideTurnedIn={list.setHideTurnedIn}
        hideNoItems={list.hideNoItems}
        setHideNoItems={list.setHideNoItems}
        favoritesOnly={list.favoritesOnly}
        setFavoritesOnly={list.setFavoritesOnly}
      />
      <Box sx={{ flexGrow: 1 }} />
      <InventorySource
        countSource={countSource}
        onCountSource={onCountSource}
        inventoryLoadedAt={inventoryLoadedAt}
      />
    </Stack>
  )
}
