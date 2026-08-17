// gear plan/GearPlanView.tsx — THE PLAN TAB: one item per equipment cell, that item's exaltations in
// its sockets, and what the whole thing adds up to against what you are wearing.
//
// WHAT THIS TAB IS FOR, AND WHY IT IS NOT THE TWO SURFACES THAT WERE RETIRED. The gear area's other
// four tabs each answer one question and none of them is this one: Gear searches the corpus,
// Exaltations searches the donor corpus, Character reads out the dump, and the Wish list is FLAT by
// owner ruling — it "names no equipment cell, no socket and no host". `progressState.ts` states
// where the missing half went: host targeting is an explicitly later addition, and a wish list that
// grew a cell map would be the plan board again under a friendlier name. This is that addition, on
// its own surface, with its own store key, and the Gear tab untouched.
//
// AND THERE IS ONE BOARD. No set list, no switcher, no create/rename/delete — the machinery
// JOS-325 named when it retired gear sets, and JOS-326 named again when it retired the plan board.
// `useGearPlan` has no machine-class half at all, which is `useWishlist`'s argument for a
// one-document-per-character surface.
//
// THE TWO PANES ARE BOUNDED SEPARATELY (AGENTS.md UI conventions). The app's content area is
// already `overflow:auto`, so `height:100%` clamps nothing and a `flex: 0 0 auto` panel would size
// to its content and squeeze the board to zero. The board grows (twenty-three cells), the panel
// grows (a stat row per key, plus a socket row per plan), so both get their own scroller inside a
// row that takes the height it is given.
//
// THE ARITHMETIC IS NOT HERE. `gearPlanTotals.ts` folds a cell into a stat block through phase 0's
// own scaler and hands the array to `characterSheet.sumGear` — the one answer in this repo to "what
// do these items add up to". This file resolves keys to corpus rows and lays panes out.

import { useCallback, useMemo, useState, type JSX } from 'react'
import { Box, Stack, Typography } from '@mui/material'
import InventoryIcon from '@mui/icons-material/Inventory2Outlined'
import { outputKind } from '@shared/outputs/kinds'
import { type ItemUpgradeState } from '@shared/itemUpgrade'
import {
  assignedCount,
  cellAt,
  EMPTY_GEAR_PLAN,
  fromEquipped,
  overwriteCount,
  type LoadMode
} from '@shared/planner/gearPlan'
import type { PlanSlotId, PlannerDonor, PlannerItemHit } from '@shared/planner/types'
import OutputFileLine from '../../components/OutputFileLine'

import { usePlannerInventory } from '../planner/plannerInventory'
import { useDonors, useEraOnly } from '../planner/plannerData'
import { sanitizeGearPlanFilter } from '../gear/areaMemory'
import { useRemembered } from '../gear/useAreaMemory'
import GearPlanBoard from './GearPlanBoard'
import GearPlanFilterBar, { type GearPlanFilterBarProps } from './GearPlanFilterBar'
import type { GearPlanCellHandlers } from './GearPlanCellCard'
import GearPlanDonorPicker from './GearPlanDonorPicker'
import GearPlanSelectPanel from './GearPlanSelectPanel'
import { useGearPlanFold, type GearPlanFold, type ItemFacts } from './gearPlanFold'
import GearPlanTotalsPanel from './GearPlanTotalsPanel'
import type { CellContext } from './gearPlanRules'
import { useRowSignals } from './gearPlanSignalsHook'
import type { GearPlanRowFilter } from './gearPlanSignals'
import { cellWishes, newWishes, planWishes, type WishFilter } from './gearPlanWishes'
import GearPlanToolbar from './GearPlanToolbar'
import { useWishlist } from '../wishlist/useWishlist'
import { wishFulfilled } from '../wishlist/wishFarm'
import { usePlannerProgress } from '../planner/plannerProgress'
import { extractionTier } from '@shared/planner/rules'
import { hasWish } from '@shared/planner/wishlist'
import type { WishEntry } from '@shared/planner/wishlist'
import { useGearPlan } from './useGearPlan'

/** The dump this tab compares against, as the `/outputfile` registry states it (JOS-44). */
const INVENTORY = outputKind('inventory')

/** How wide the totals panel is. `SETS_PANE_WIDTH` revived — a number, so the board gets the rest. */
const PANEL_WIDTH = 380

/**
 * The empty state, in the design library's register 3: centred on `background.default`, a 48px
 * icon at 0.6 opacity, an h6 headline and ONE paragraph capped at 440px. It names what the tab is
 * FOR rather than what it is missing — "empty is a state, not an error" — and it carries no button
 * because there is nowhere to send anyone yet: the board is right there.
 */
function NothingPlanned(): JSX.Element {
  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      spacing={1.5}
      sx={{ py: 4, px: 4, textAlign: 'center', color: 'text.secondary' }}
    >
      <InventoryIcon sx={{ fontSize: 48, opacity: 0.6 }} />
      <Typography variant="h6" sx={{ color: 'text.primary' }}>
        Nothing planned yet
      </Typography>
      <Typography variant="body2" data-testid="gearplan-empty" sx={{ maxWidth: 440, lineHeight: 1.5 }}>
        {/* "a plan", not "a loadout": this app already says LOADOUT to the player about which
            CLASSES they are running (Preferences → Profiles), and one word cannot mean two things
            in one product. The tab is called Plan and so is this sentence. */}
        Put an item in a cell and this becomes a plan: what it adds up to, which exaltations its
        merge level unlocks, and what it would change about what you have on.
      </Typography>
    </Stack>
  )
}

/**
 * WHICH POPOVER IS OPEN, AND EVERY EDIT THE BOARD CAN MAKE.
 *
 * ONE anchor for the whole surface rather than one per card: two popovers open at once is a state
 * twenty-three independently-anchored cells can reach and a single `open` cannot. The socket picker
 * carries its whole `CellContext` because that is what `donorFitsCell` is asked with — the cell,
 * the socket, and the PLANNED item's classes (R2 against the item, not against a class trio the
 * document deliberately does not carry).
 *
 * `classesOf` reads the corpus, so an item the gear index has no row for narrows nothing and
 * filters nothing — UNKNOWN, never "nobody" (law 1).
 */
interface Editing {
  on: GearPlanCellHandlers
  itemCell: PlanSlotId | null
  socketCtx: CellContext | null
  anchor: HTMLElement | null
  close: () => void
  pickItem: (hit: PlannerItemHit) => void
  pickDonor: (donor: PlannerDonor) => void
  clearSocket: (() => void) | null
}

function useEditing(
  api: ReturnType<typeof useGearPlan>,
  /** what the corpus says the planned item IS — both axes R2 judges a donor against */
  facts: ItemFacts,
  addWishes: (offered: readonly WishEntry[]) => void
): Editing {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [itemCell, setItemCell] = useState<PlanSlotId | null>(null)
  const [socketCtx, setSocketCtx] = useState<CellContext | null>(null)
  const { gearPlan, assign, clear, setState, setSocket } = api

  const close = useCallback(() => {
    setAnchor(null)
    setItemCell(null)
    setSocketCtx(null)
  }, [])

  const on = useMemo<GearPlanCellHandlers>(
    () => ({
      pickItem: (cell, el) => {
        setSocketCtx(null)
        setItemCell(cell)
        setAnchor(el)
      },
      pickSocket: (cell, socket, el) => {
        setItemCell(null)
        const key = gearPlan.cells[cell]?.key ?? ''
        setSocketCtx({
          cell,
          socket,
          itemClasses: facts.classesOf(key),
          itemSlots: facts.slotsOf(key)
        })
        setAnchor(el)
      },
      setState: (cell: PlanSlotId, next: ItemUpgradeState) => {
        setState(cell, next)
      },
      clear: (cell: PlanSlotId) => {
        clear(cell)
      },
      wish: (cell: PlanSlotId) => {
        const planned = gearPlan.cells[cell]
        if (planned) addWishes(cellWishes(planned, Date.now()))
      }
    }),
    [gearPlan, facts, setState, clear, addWishes]
  )

  const pickItem = useCallback(
    (hit: PlannerItemHit) => {
      if (itemCell !== null) assign(itemCell, cellAt(hit))
      close()
    },
    [itemCell, assign, close]
  )

  const pickDonor = useCallback(
    (donor: PlannerDonor) => {
      if (socketCtx !== null) {
        setSocket(socketCtx.cell, socketCtx.socket, {
          effect: donor.effect,
          donorKey: donor.key,
          donorName: donor.name
        })
      }
      close()
    },
    [socketCtx, setSocket, close]
  )

  const filled =
    socketCtx !== null && gearPlan.cells[socketCtx.cell]?.sockets[socketCtx.socket] !== undefined
  const clearSocket = useCallback(() => {
    if (socketCtx !== null) setSocket(socketCtx.cell, socketCtx.socket, null)
    close()
  }, [socketCtx, setSocket, close])

  return {
    on,
    itemCell,
    socketCtx,
    anchor,
    close,
    pickItem,
    pickDonor,
    clearSocket: filled ? clearSocket : null
  }
}

/**
 * THE ONE WISH-WRITING PATH, shared by the per-cell heart and the whole-plan button.
 *
 * `newWishes` is asked BEFORE anything is written, because the count has to be truthful: the model
 * returns the same object for a no-op, so counting the list afterwards reads zero. That was the
 * first version's bug — the plan button always reported "already on your wish list", whatever it
 * had just added.
 *
 * The `fulfilled` half asks the WISH LIST'S OWN predicate (`wishFarm.wishFulfilled`), so the board
 * and the list can never disagree about what counts as already yours. The tier it needs is the
 * SOCKET's extraction tier (R1) rather than a corpus lookup — the wish already carries its socket,
 * and a gear wish has none, which is why that arm passes a tier the predicate never reads.
 */
function useWishWriter(): {
  addWishes: (offered: readonly WishEntry[]) => void
  wished: number | null
} {
  const wishlist = useWishlist()
  const progress = usePlannerProgress()
  const [wished, setWished] = useState<number | null>(null)

  const addWishes = useCallback(
    (offered: readonly WishEntry[]) => {
      const filter: WishFilter = {
        wished: (key) => hasWish(wishlist.list, key),
        fulfilled: (entry) =>
          wishFulfilled(
            entry,
            progress.of(entry.itemKey, entry.socket === undefined ? 1 : extractionTier(entry.socket))
          )
      }
      const taken = newWishes(offered, filter)
      for (const entry of taken) wishlist.add(entry)
      setWished(taken.length)
    },
    [wishlist, progress]
  )

  return { addWishes, wished }
}

/**
 * WHICH ROWS THE PICKERS MAY OFFER, and the one number that keeps the hiding honest.
 *
 * Its own hook for the reason `useWishWriter` is: the view is at the 100-line function ceiling, and
 * this is a self-contained tier — two persisted settings and a transient count that nothing else in
 * the file reads. Bundling them here also puts the ONE explanation of why era is separate in the
 * one place both halves are visible.
 */
function usePoolFilter(): {
  bar: Omit<GearPlanFilterBarProps, 'hidden'> & { hidden: number | null }
  pick: { filter: GearPlanRowFilter; eraOnly: boolean; onHidden: (n: number | null) => void }
} {
  // Three flags on the restart tier under one key (`eq.gear.filters`'s shape), plus the SHARED era
  // toggle, which has its own key and its own owner ruling about shipping ON —
  // `GearPlanFilterBar`'s header argues why it is not folded into the same blob.
  const [filter, setFilter] = useRemembered<GearPlanRowFilter>(
    'eq.gearplan.filters',
    sanitizeGearPlanFilter
  )
  const [eraOnly, setEraOnly] = useEraOnly()
  // Only ONE picker can be open (the view owns a single anchor), so one number is the whole story.
  // `null` is "nothing has been asked", which the bar renders as silence rather than as a zero.
  const [hidden, setHidden] = useState<number | null>(null)
  // STABLE, because both pickers report through it from inside an effect — a fresh identity every
  // render would re-run that effect every render and set state in a loop.
  const onHidden = useCallback((n: number | null) => {
    setHidden(n)
  }, [])

  return {
    bar: { filter, setFilter, eraOnly, setEraOnly, hidden },
    pick: { filter, eraOnly, onHidden }
  }
}

/**
 * ONE COLUMN, TWO JOBS. While a cell is being filled it shows the CANDIDATES and what each would
 * change; otherwise it shows what the board adds up to. They are never both useful at once —
 * choosing is the moment the sum matters least — and giving the selection this width is the whole
 * reason it is a panel rather than the popover it used to be.
 */
function RightColumn({
  fold,
  edit,
  assigned,
  signalsOf,
  pick
}: {
  fold: GearPlanFold
  edit: Editing
  assigned: number
  signalsOf: ReturnType<typeof useRowSignals>
  pick: ReturnType<typeof usePoolFilter>['pick']
}): JSX.Element {
  if (edit.itemCell !== null) {
    return (
      <GearPlanSelectPanel
        cell={edit.itemCell}
        onClose={edit.close}
        onPick={edit.pickItem}
        signalsOf={signalsOf}
        deltaFor={fold.candidateDelta}
        {...pick}
      />
    )
  }
  return (
    <GearPlanTotalsPanel
      totals={fold.totals}
      assigned={assigned}
      plannedSockets={fold.sockets}
      diff={fold.diff}
      unstated={fold.unstated}
      unresolved={fold.unresolved}
    />
  )
}

export default function GearPlanView(): JSX.Element {
  const api = useGearPlan()
  const { gearPlan, ready, replace } = api
  // The donor corpus's readiness, so an empty picker can say "still reading" rather than "nothing
  // fits" — two very different statements, and only one of them is the user's problem.
  const { ready: donorsReady } = useDonors()
  const { inventory } = usePlannerInventory()
  const fold = useGearPlanFold(gearPlan)
  const assigned = assignedCount(gearPlan)
  const { addWishes, wished } = useWishWriter()
  const signalsOf = useRowSignals()
  const edit = useEditing(api, fold.facts, addWishes)
  const pool = usePoolFilter()

  const addAll = useCallback(() => {
    addWishes(planWishes(gearPlan, Date.now()))
  }, [gearPlan, addWishes])
  // EMPTY THE BOARD. `EMPTY_GEAR_PLAN` with a moved stamp rather than a hand-built literal: the
  // document's own empty value is the one definition of what an empty board is, and `updatedAt` has
  // to move or the debounced save has nothing to notice.
  const clearAll = useCallback(() => {
    replace({ ...EMPTY_GEAR_PLAN, updatedAt: Date.now() })
  }, [replace])
  const load = useCallback(
    (mode: LoadMode) => {
      if (fold.equipped !== null) replace(fromEquipped(gearPlan, fold.equipped, mode, Date.now()))
    },
    [gearPlan, fold.equipped, replace]
  )

  return (
    <Stack
      spacing={1}
      data-testid="gearplan-view"
      // `height: 100%` and NOT `flexGrow`, because `app-content` is a plain `overflow:auto` box
      // rather than a flex container - every view in this app sizes itself against it that way,
      // and the two panes below then flex into what is left instead of growing the page.
      sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      {/* The freshness line, only once a dump exists — the case an instructions card cannot cover:
          the comparison below renders with total confidence whether the dump is a minute or a
          month old, and the file's own mtime is the difference. */}
      {inventory && (
        <Box sx={{ flexShrink: 0 }}>
          <OutputFileLine
            command={INVENTORY.command}
            why="Re-type it in game whenever your gear changes - the comparison follows the dump."
            updatedAt={inventory.loadedAt}
            steps={INVENTORY.steps}
            testId="gearplan-outputfile"
          />
        </Box>
      )}

      <GearPlanToolbar
        assigned={assigned}
        overwrites={fold.equipped === null ? null : overwriteCount(gearPlan, fold.equipped)}
        // The corpus a load resolves worn exaltations through. Loading without it silently drops
        // every socket into a cell that `fill` will then never revisit — see the toolbar's header.
        canLoad={donorsReady}
        onLoad={load}
        onClearAll={clearAll}
        onWish={addAll}
        wished={wished}
      />

      <GearPlanFilterBar {...pool.bar} />

      {ready && assigned === 0 && <NothingPlanned />}

      {/* TWO REGIONS, SO THE GAP IS 16px (`spacing={2}`) — the library's whole sectioning device
          is the 12px-within / 16px-between pair, with no rules and no second border level. There
          is deliberately NO vertical divider here any more: the panel is a card now, and cards own
          the only borders on a page. */}
      <Stack
        direction="row"
        spacing={2}
        sx={{ flexWrap: 'nowrap', flexGrow: 1, minHeight: 0, alignItems: 'stretch' }}
      >
        <Box sx={{ flexGrow: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
          <GearPlanBoard
            gearPlan={gearPlan}
            {...fold.board}

            on={edit.on}
          />
        </Box>
        {/* ONE COLUMN, TWO JOBS. While a cell is being filled it shows the CANDIDATES and what each
            would change; otherwise it shows what the board adds up to. They are never both useful at
            once — choosing is the moment the sum matters least — and giving the selection this width
            is the whole reason it is not a popover any more. */}
        <Box sx={{ width: PANEL_WIDTH, flexShrink: 0, minHeight: 0, display: 'flex' }}>
          <RightColumn
            fold={fold}
            edit={edit}
            assigned={assigned}
            signalsOf={signalsOf}
            pick={pool.pick}
          />
        </Box>
      </Stack>

      <GearPlanDonorPicker
        ctx={edit.socketCtx}
        anchor={edit.socketCtx === null ? null : edit.anchor}
        ready={donorsReady}
        onClose={edit.close}
        onPick={edit.pickDonor}
        signalsOf={signalsOf}
        onClear={edit.clearSocket}
        {...pool.pick}
      />
    </Stack>
  )
}
