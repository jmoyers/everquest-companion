// LootView — the loot ledger, and (since 2026-08-04) the item drill-down that TAKES THE PANE.
//
// TWO STATES, ONE VIEW. `selected === null` is the ledger: toolbar, summary, notable pickups,
// and the windowed table. A selection swaps the whole body for `ItemDetailPane` — breadcrumb
// "Loot › <item>", a back chevron, and the drill-down at full width. The old modal is gone; see
// that file's header for why.
//
// SCROLL POSITION IS SAVED ACROSS THE SWAP, and that is not a nicety: this table is the
// character's entire loot history, and a reader who clicks a row two thousand rows down must
// come back to it rather than to the top. The list unmounts on the swap (it is the pane that
// takes over), so the offset is captured on the way in and re-applied in a LAYOUT effect on the
// way back — before paint, so there is no visible jump. The windowing hook re-reads the offset
// from the scroll event that assignment fires.
//
// A DEEP LINK LANDS DIRECTLY ON THE DETAIL PANE. `focusItem`/`focusNonce` come from App.tsx's
// `openLoot` (the Overview's drop rows). Keyed on the NONCE, exactly like the Mobs tab's target:
// this view is remounted per character rebuild and unmounted whenever you leave the tab, so the
// effect runs on arrival, and asking for the same item twice must open it twice.
//
// THIS LEDGER MOUNTS NO TOOLTIP POPPER (JOS-127, owner direction 2026-08-09). A 0.14.0 user could
// not change the sort off "Last looted": the Sort select sits in the toolbar, and the surfaces
// stacked directly under it — the notable-pickups chips and the first table rows — wore
// `placement="top"`, INTERACTIVE hover cards (`lib/KnownItemTooltip`, up to 380px wide) that open
// upward across the toolbar and, being interactive, hold `pointer-events: auto` while they are up.
// The card was over the control and ate the click aimed at it. The fix is REMOVAL, not a timeout
// or a placement flip: the app wants fewer tooltips, and none that can sit over an interactive
// control. Same precedent, same reasoning as the nav's UpdateChip; `tests/tooltipCursor.test.mts`
// pins both structurally, because "the popper cannot mount" is what "it cannot eat the click"
// means. What the hover used to say is not lost — clicking a row (or a pickup chip) opens the
// drill-down, which is where the item window and its quest/recipe knowledge live anyway.

import { type JSX, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Box, Snackbar, Stack } from '@mui/material'
import type { LootEvent } from '@shared/types'
import type { NavBack } from '../../appRouting'
import { useBackTarget } from '../../appBack'
import { useWindowedRows } from '../../lib/useWindowedRows'
import { itemCountKey } from '../../lib/itemName'
import type { InventoryRow } from '../inventory/reconcile'
import { useProgress } from '../posky/useProgress'
import { ItemDetailPane } from './ItemDetailPane'
import { itemStats, questItemNames } from './lootItemData'
import { ROW_HEIGHT } from './lootRows'
import type { GroupRow, KeyedLoot } from './lootGrouping'
import { LootTable, type LootTableContext } from './LootTables'
// The chrome around the table — the toolbar, the caption and the notices — plus the two pieces of
// view state that belong to them. JOS-160 moved it out when this file crossed its measured line
// ceiling; nothing changed in the move.
import { LootNotices, LootSummary, LootToolbar, useLootSort } from './LootChrome'
import { NotablePickupsStrip, useNotableStrip } from './NotablePickupsStrip'
import { useLootRows } from './useLootRows'
// HOW FAST THE SLICE IS PAYING (JOS-261) — the aggregate loot-per-hour the caption states, joined
// against the same `progression` snapshot the slice was resolved from.
import { useSliceLootRates } from './useSliceLootRates'
// THE TIMESLICE (JOS-130): the app's one "which stretch of play is this about" control. The ledger
// is where it was asked for — "what did I gain in totality vs this session" — and it is the SAME
// control and the SAME pick the Leveling tab reads, so the drops and the xp behind them can never
// describe different stretches.
import { SliceBar } from '../timeslice/SliceBar'
import { useTimeslice, type TimesliceState } from '../timeslice/useTimeslice'
import { inSlice, type Timeslice } from '@shared/timeslice'

/**
 * THE LEDGER'S SLICE BAR, INCLUDING THE SESSION SPLIT (JOS-436).
 *
 * This is the surface that carries "New session" — the instance-reset workflow the ledger was asked
 * for: one click ends the stretch you were farming and opens a new one from that instant, with the
 * old one still in the picker beside it. What it produces is an ordinary custom range, so every
 * other surface reads the result without knowing this button exists.
 *
 * `custom` is handed down BESIDE the resolved slice on purpose: the two datetime fields must show
 * what the user typed rather than what the record clamped it to (`SliceBar.CustomRange` states the
 * measurement behind that — it is the reporter's *cannot select a future date on the end time*).
 *
 * Its own element so `LootView` stays inside the measured lines-per-function ceiling, exactly like
 * `LootLedgerBody` and `LootDetailTakeover` below.
 */
function LootSliceBar(ts: TimesliceState): JSX.Element {
  return (
    <SliceBar
      available={ts.available}
      slice={ts.slice}
      onPick={ts.setId}
      onCustom={ts.setCustom}
      custom={ts.custom}
      sessions={{ segments: ts.segments, index: ts.segmentIndex, onNew: ts.newSession, onPick: ts.pickSegment }}
      testId="loot-slice"
    />
  )
}

export interface LootViewProps {
  /** An item to open on arrival — the Overview's drop rows deep-linking in. Re-applied whenever
   *  `focusNonce` changes, so the same item asked for twice opens twice. */
  focusItem?: string | null
  focusNonce?: number
  /** Told the moment the focus has been applied, so the router drops it and a later plain visit
   *  to this tab lands on the ledger rather than on wherever the last link pointed. */
  onFocusConsumed?: () => void
  /** The app's ONE back contract (appRouting `NavBack`, JOS-43). Present ⇒ the detail pane's Back
   *  returns to whatever tab deep-linked here (the Planner, the Overview, a Sky quest); absent or
   *  empty ⇒ it means the ledger, exactly as it always did. */
  nav?: NavBack
}

/** Which item the pane has taken over for, and the two ways in and out of it. */
interface LootDetail {
  selected: string | null
  open: (item: string) => void
  close: () => void
}

/**
 * THE PANE-TAKEOVER STATE, and the scroll contract it owes the ledger it replaces.
 *
 * The list unmounts on the swap, so the offset is captured on the way in and re-applied in a
 * LAYOUT effect on the way back — before paint, so returning never flashes the top of an
 * eleven-thousand-row table. A DEEP-LINKED entry saves 0 instead: the reader was on the Overview,
 * so there is no position of theirs to return to — and since JOS-43 "back" does not mean the
 * ledger for them at all, it means the tab they came from.
 *
 * Its own hook rather than inline, so `LootView` itself stays inside the measured
 * lines-per-function ceiling and this rule is readable in one screen.
 */
function useLootDetail(
  props: LootViewProps,
  scrollRef: React.RefObject<HTMLDivElement | null>
): LootDetail {
  const { focusItem, focusNonce, onFocusConsumed } = props
  const [selected, setSelected] = useState<string | null>(null)
  const savedScroll = useRef(0)

  // An inbound focus opens the detail pane, then is consumed. Keyed on the NONCE, not the item's
  // identity — the same item asked for twice must open twice.
  useEffect(() => {
    if (focusItem == null) return
    savedScroll.current = 0
    setSelected(focusItem)
    onFocusConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce])

  useLayoutEffect(() => {
    if (selected === null && scrollRef.current) scrollRef.current.scrollTop = savedScroll.current
  }, [selected, scrollRef])

  return {
    selected,
    open: (item) => {
      savedScroll.current = scrollRef.current?.scrollTop ?? 0
      // A NATIVE drill: the reader clicked a row in the ledger they are standing in, so the list
      // IS where back goes — and whatever a link parked before belongs to a journey that ended
      // when they started browsing here (navOrigin.ts).
      props.nav?.clear()
      setSelected(item)
    },
    close: () => setSelected(null)
  }
}

/**
 * THE TAKEOVER, as one element. Its own component so the swap reads as a single line where it
 * happens and the view stays inside its measured line budget — the same reason `useLootDetail`
 * lives beside it rather than inline.
 */
interface TakeoverProps {
  item: string
  events: LootEvent[]
  slice: Timeslice
  detail: LootDetail
  nav?: NavBack
  /** countKey → reconciled inventory row, so the pane can state what the export vouches for. */
  invByKey: Map<string, InventoryRow>
}

function LootDetailTakeover(p: TakeoverProps): JSX.Element {
  const { item, events, slice, detail, nav, invByKey } = p
  // Back consults the origin stack FIRST and falls back to closing the pane — the whole JOS-43
  // contract in one line. `nav.back()` reports whether it navigated, so a natively opened drill
  // (nothing parked) behaves exactly as it did before.
  //
  // ONE expression, read by TWO things (JOS-201): the arrow below, and the mouse's Back button,
  // which registers it for as long as this pane is on screen. Never a second opinion about what
  // Back means here. The ledger behind it registers nothing — it has no Back affordance — so a
  // press there falls through to the app-level origin walk.
  const back = (): boolean => {
    if (!nav?.back()) detail.close()
    return true
  }
  useBackTarget(back)
  return (
    <ItemDetailPane
      item={item}
      // NOT sliced, unlike `events` below, and deliberately: an inventory export is a single
      // observation of what you hold NOW and carries no timestamps at all (JOS-160). Cutting it to
      // a window would be inventing dates the file does not have.
      owned={invByKey.get(itemCountKey(item))?.inv}
      // SLICED, like the ledger it came from: the drill-down's counts, its mob table and its
      // per-zone rates all describe the stretch the control says they do.
      events={events.filter((e) => e.item.toLowerCase() === item.toLowerCase())}
      slice={slice}
      stats={itemStats[itemCountKey(item)]}
      isQuestItem={questItemNames.has(itemCountKey(item))}
      onBack={back}
      onList={detail.close}
      origin={nav?.origin?.label ?? null}
    />
  )
}

/**
 * THE LEDGER BODY: the scroll container, and the windowing hook that reads it — TOGETHER (JOS-260).
 *
 * They used to be apart. `useWindowedRows` was called in `LootView`, which returns the detail
 * takeover early, so the container it windows mounts and unmounts UNDER a hook that never does.
 * That is what broke this list for a 0.23.0 reporter: the hook's listeners bound once, to the
 * first node, and a drill-in-and-back replaced that node — leaving the window frozen at the
 * thirty-odd rows it happened to hold while the rest of the ledger scrolled past blank.
 *
 * The hook is hardened against that on its own side now. This split is the structural half: with
 * the hook living in the same component as the `Box` it measures, there is no lifetime for them to
 * disagree about — the same shape `LogPreview.PreviewLines` and `ReportsPanel.ReportRows` already
 * had, which is why neither of them ever showed this bug.
 *
 * The ref still comes from `LootView`, because the scroll-position contract across the takeover
 * (save on the way in, restore in a layout effect on the way back) belongs to the view.
 */
function LootLedgerBody({
  scrollRef,
  groupByItem,
  groupRows,
  events,
  ctx
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  groupByItem: boolean
  groupRows: GroupRow[]
  events: KeyedLoot[]
  ctx: Omit<LootTableContext, 'win'>
}): JSX.Element {
  // Window whichever list is active — only the rows intersecting the viewport are
  // mounted, so a filter keystroke never mounts hundreds of MUI rows synchronously.
  const count = groupByItem ? groupRows.length : events.length
  const win = useWindowedRows({ count, rowHeight: ROW_HEIGHT, scrollRef })
  return (
    // The scroll container owns the ref the windowing hook reads. Spacer rows (top/bottom) reserve
    // the full scroll height so only the visible slice of MUI rows is mounted — see
    // useWindowedRows. `minHeight: 0` is what lets it actually SHRINK inside the column flex above
    // it, so this box is the only thing on the page that scrolls the ledger.
    // `overscrollBehavior: contain` is the other half of the reporter's sentence (JOS-260): they
    // described dead space above and below that the wheel moved through. A wheel gesture that
    // reaches the end of this box CHAINS into whatever is behind it, so a list that had stopped
    // rendering still felt like it was scrolling — the app shell moving instead of the ledger.
    // Contained, the gesture ends here, which is what a self-scrolling pane means.
    <Box
      ref={scrollRef}
      data-testid="loot-scroll"
      sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain' }}
    >
      <LootTable groupByItem={groupByItem} rows={groupRows} events={events} ctx={{ ...ctx, win }} />
    </Box>
  )
}

export default function LootView(props: LootViewProps = {}): JSX.Element {
  // ONE subscription to the loot module: useProgress already owns it (and needs it for the
  // reconcile), so the merged view reads its history from there rather than holding a
  // second copy of the full loot snapshot.
  const {
    lootHistory: history,
    inventoryRows,
    countSource,
    setCountSource,
    reloadInventory,
    inventoryInfo
  } = useProgress()
  const [query, setQuery] = useState('')
  const [groupByItem, setGroupByItem] = useState(true)
  const [questOnly, setQuestOnly] = useState(false)
  const [sort, setSort] = useLootSort()
  const [showInventoryOnly, setShowInventoryOnly] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  // `prog` comes back with the slice on purpose (TimesliceState.prog): the rate line below needs a
  // `rangeStats` over this very slice, and a second subscription to the same module is how a
  // numerator and a denominator end up describing two different snapshots.
  const timeslice = useTimeslice()
  const { prog, slice } = timeslice
  // THE SLICE IS APPLIED ONCE, HERE, and everything below reads the result — the ledger, the
  // grouped counts, the notable strip and the drill-down's events. `inSlice` is the shared
  // membership test (`shared/timeslice.ts`), half-open exactly like `rangeStats`, so a row is in
  // this table if and only if the same instant is inside the range the xp numbers were measured
  // over. Under `All` it keeps every row, so this costs one pass and changes nothing.
  const sliced = useMemo(() => history.filter((e) => inSlice(slice, e.ts, e.zone)), [history, slice])
  // THE WHOLE history goes in, not `sliced`: the hook applies the slice through the same membership
  // test `inSlice` is, so the caption's count and the caption's rate cannot disagree about what
  // "inside this slice" means (useSliceLootRates' header states the argument).
  const rates = useSliceLootRates(history, slice, prog)
  const { knowledgeByKey, strip } = useNotableStrip(sliced)
  const rows = useLootRows({
    history: sliced,
    inventoryRows,
    query,
    questOnly,
    showInventoryOnly,
    sort
  })
  const { events, grouped, groupRows, invOnlySource, invOnlyRows, invByKey } = rows

  const onReload = async (): Promise<void> => setToast(await reloadInventory())

  const scrollRef = useRef<HTMLDivElement>(null)
  const detail = useLootDetail(props, scrollRef)

  const selected = detail.selected
  if (selected !== null) {
    const p = { item: selected, events: sliced, slice, detail, nav: props.nav, invByKey }
    return <LootDetailTakeover {...p} />
  }

  return (
    // `minHeight: 0`: this column's last child is the scrolling ledger, and a flex column whose
    // items keep their automatic minimum size cannot shrink one — the list would size itself to
    // its own content and push the scroll onto the app shell behind it (JOS-260).
    <Stack spacing={2} data-testid="loot-list" sx={{ height: '100%', minHeight: 0 }}>
      {/* ABOVE the toolbar and on its own row: it governs everything below it, including the
          filters, and it must never be crowded into the same line as the search box (the
          compact-bar contract — controls never shrink). */}
      <LootSliceBar {...timeslice} />

      <LootToolbar
        query={query}
        setQuery={setQuery}
        groupByItem={groupByItem}
        setGroupByItem={setGroupByItem}
        questOnly={questOnly}
        setQuestOnly={setQuestOnly}
        sort={sort}
        setSort={setSort}
        invOnlyCount={invOnlySource.length}
        showInventoryOnly={showInventoryOnly}
        onToggleInventoryOnly={() => setShowInventoryOnly((v) => !v)}
        countSource={countSource}
        setCountSource={setCountSource}
        onReload={() => void onReload()}
      />

      <LootSummary
        eventCount={sliced.length}
        totalCount={history.length}
        slice={slice}
        uniqueCount={grouped.length}
        inventoryInfo={inventoryInfo}
        rates={rates}
      />

      <NotablePickupsStrip {...strip} onSelect={detail.open} />

      {/* The states-not-errors. `owned` is only ever non-empty in the UNGROUPED ledger under a
          search: grouped, those rows are IN the table, and with an empty box the set is the
          player's whole bank — a table's job, not a sentence's (JOS-160). */}
      <LootNotices
        historyCount={history.length}
        slicedCount={sliced.length}
        slice={slice}
        owned={!groupByItem && query.trim() !== '' ? invOnlyRows : []}
        onSelect={detail.open}
      />

      <LootLedgerBody
        scrollRef={scrollRef}
        groupByItem={groupByItem}
        groupRows={groupRows}
        events={events}
        ctx={{ knowledgeByKey, invByKey, onSelect: detail.open }}
      />

      <Snackbar
        open={!!toast}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        message={toast ?? ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Stack>
  )
}
