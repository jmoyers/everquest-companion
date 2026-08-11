// planner/EffectBrowser.tsx — Effects mode: "which effect do I want, and who drops it?" (§5.2).
//
// THE LIST IS FLAT AND UNIFORM, and that is what lets it be windowed. Groups expand into their
// donors, so the natural shape is a tree — but `useWindowedRows` is a FIXED-row-height hook, and a
// growing list must live in a fixed-height scroll box (AGENTS.md UI conventions). So the tree is
// flattened into one row array of one height: a HEADER row, followed by its donor rows while it is
// open. Expanding is then just a longer array, and the DOM node count stays bounded whether the
// filter matches 3 groups or 300.
//
// WHAT THE HEADERS ARE IS A CHOICE NOW, NOT A CONSTANT (V4): `plannerGroups.ts` owns the axes —
// effect, focus family, slot, era — and this file owns none of that logic; it draws whatever
// groups it is handed and remembers which of them are open BY GROUP ID. Switching the axis
// therefore collapses everything, which is correct: the old ids named groups that no longer exist.
//
// EVERY DONOR ROW STATES ITS SOURCE, or says it has none. `sourceIndex` answers from the
// committed mob catalog; `quest` / `playerCrafted` ride on the donor row itself; an item with
// neither renders "no known source" rather than an empty space that reads like a loading state
// (law 1). Class chips are lit for the classes the SET can actually use — the wide-class donors
// light up most, which is precisely the R2 signal that makes them valuable.
//
// THE DONOR NAME HOVERS THE ITEM WINDOW AND CLICKS THROUGH TO THE LOOT DRILL-DOWN
// (`PlannerChips.DonorName`). Both affordances at once: the popup answers "what is it", the link
// answers "and everything else we know about it" — the drill now states the committed DBs' drop
// sources beside the observed ones, which is what made it a fair destination for a never-looted
// donor (see PlannerChips' header, and features/loot/ItemDbSources.tsx).
//
// TWO FILTERS SHRINK THE CORPUS BEFORE ANY OF THAT, and they are opposites in spirit.
//
// THE ERA FILTER IS ON BY DEFAULT and is the difference between a plan and a wish list. The
// committed corpus is scraped from a wiki that documents every expansion, so more than half the
// proc donors drop in Kunark and Velious zones this server has not opened; the toggle hides them,
// donors whose zones the era table cannot place stay visible with a quiet `era?`, and an effect
// whose every donor was hidden disappears with them — an effect row promising four donors that
// expand into nothing would be worse than not listing it.
//
// THE NON-EQUIPPABLE FILTER IS OFF BY DEFAULT, and it is R2 rather than taste: a donor with no
// equipment slot shares a slot with nothing, so its effect can never be socketed anywhere. 280 of
// the 1,462 donor rows are slotless — 213 of them in the Click tab, which is the potion mass, and
// 67 procs, which are poisons and coatings. Turning it on shows them chipped `no slot`, because an
// empty slot list is "the page stated none" (law 1) and just occasionally that is a wiki gap.
//
// …AND WHEN THE TWO OF THEM EMPTY THE LIST, THE LIST SAYS SO (JOS-67). A player searched for a
// click effect that was real, legal and hidden by the slot filter, and got "No effects match these
// filters" — a true sentence that told them nothing (feedback 01KZCGXY8WC6YCD8W44W7EAS5H). An empty
// result now counts what the two view toggles are holding back and names them, because a filter
// that can hide everything must be able to admit it (`hiddenByView`, plannerData.ts).

import { type JSX, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Menu, MenuItem, Typography } from '@mui/material'
import type { ClassAbbr } from '@shared/classCombo'
import {
  equipSlotOf,
  planSlotLabel,
  type ExaltPlan,
  type PlanSlotId,
  type PlanSocket,
  type SocketType
} from '@shared/planner/types'
import { useWindowedRows } from '../../lib/useWindowedRows'
import EffectFilterBar from './EffectFilterBar'
import { DonorLine, GroupLine, ROW_HEIGHT } from './EffectRows'
import {
  CURRENT_ERA_LABEL,
  DEFAULT_FILTERS,
  donorEraOf,
  filterDonors,
  hiddenByView,
  useDonors,
  useEraOnly,
  useGroupBy,
  useNonEquip,
  type DonorFilters,
  type DonorRow,
  type HiddenByView
} from './plannerData'
import { browserRows, groupDonors, type BrowserRow, type GroupAxis } from './plannerGroups'
import { outgoing, plannedBySocket, replacesFor, targetCells, type SocketKey } from './plannerReplace'
import { classesMismatch } from './plannerClasses'
import { useHostClasses, type BrowsePreset } from './plannerPreset'
import { sourceIndex } from './sourceIndex'

/** Which (donor, effect) pairs the selected set already plans — the "in set" chip. */
function plannedPairs(plan: ExaltPlan | null): ReadonlySet<string> {
  const out = new Set<string>()
  for (const planSlot of Object.values(plan?.slots ?? {})) {
    for (const socket of Object.values(planSlot?.sockets ?? {})) {
      if (socket) out.add(`${socket.donorKey}::${socket.effect}`)
    }
  }
  return out
}

// WHAT AN ADD WOULD OVERWRITE is `plannerReplace.ts` — pure, node-tested, and imported rather
// than improvised here. The browser is the only place that holds BOTH the plan and the target
// socket, so it is the caller; it is not the right place for the rule itself.

// ---- the row pipeline ------------------------------------------------------------------

interface RowsInput {
  donors: readonly DonorRow[]
  filters: DonorFilters
  /** the DEFERRED search text (the standing search law) */
  text: string
  planClasses: readonly ClassAbbr[]
  view: { eraOnly: boolean; nonEquip: boolean }
  /** V8 — the host's own class list; `[]` is unknown and filters nothing (law 1) */
  hostClasses: readonly ClassAbbr[]
  /** V8 — a preset promises only-legal-fits, so haste-locked donors are OUT there (R3; owner
   *  verdict 2026-08-05). In the free browser they stay, chipped — that is where R3 is taught. */
  presetActive: boolean
  axis: GroupAxis
  open: ReadonlySet<string>
}

/**
 * Donors → the flat, windowable row array, in the THREE MEMOS the search law wants and not one —
 * plus, when the answer is EMPTY, what the view toggles are holding back (JOS-67).
 *
 * The FILTER is what a keystroke changes; the GROUPING keys off the filtered array's identity, so
 * switching the group-by axis never re-filters 1.6k rows and a keystroke never pays for a fold it
 * is about to redo; the row flattening keys off the groups and the expanded set. The fourth memo
 * only ever runs when there is nothing to draw, and `NOTHING_HIDDEN` keeps that case free.
 */
function useVisibleRows(input: RowsInput): { rows: BrowserRow[]; hidden: HiddenByView } {
  const { donors, filters, text, planClasses, view, hostClasses, presetActive, axis, open } = input
  const filtered = useMemo(() => {
    const rows = filterDonors(donors, { ...filters, text }, planClasses, view)
    // ONE pass, two rules. Haste-locked donors are illegal under a preset (see
    // RowsInput.presetActive), and R2's class half runs against the HOST rather than the set: an
    // effect can only move into an item that shares a class with it. No empty-hostClasses guard
    // is needed — `classesMismatch` answers false for an unknown list by construction (law 1).
    return rows.filter((d) => !(presetActive && d.hasteLocked) && !classesMismatch(d.classes, hostClasses))
  }, [donors, filters, text, planClasses, view, hostClasses, presetActive])
  const groups = useMemo(() => groupDonors(filtered, axis, donorEraOf), [filtered, axis])
  const rows = useMemo(() => browserRows(groups, open), [groups, open])
  const hidden = useMemo(
    () =>
      rows.length > 0 ? NOTHING_HIDDEN : hiddenByView(donors, { ...filters, text }, planClasses, view),
    [rows.length, donors, filters, text, planClasses, view]
  )
  return { rows, hidden }
}

// ---- the browser ---------------------------------------------------------------------

interface PendingAdd {
  donor: DonorRow
  anchor: HTMLElement
}

/** The answer for every render that HAS rows — a constant, so the memo below never allocates. */
const NOTHING_HIDDEN: HiddenByView = { era: 0, nonEquip: 0 }

/**
 * WHICH CELL — asked only when the donor could land in more than one, because the planner must not
 * pick which of PRIMARY/SECONDARY a sword goes into, or WHICH RING (JOS-67), on the user's behalf.
 *
 * It is also where a multi-cell donor's REPLACE warning lives (JOS-42): FINGER 1 may be empty while
 * FINGER 2 already holds something, so the row's button cannot say which, and this menu is the
 * moment the target stops being ambiguous.
 */
function SlotMenu({
  pending,
  occupied,
  onClose,
  onPick
}: {
  pending: PendingAdd | null
  occupied: ReadonlyMap<SocketKey, PlanSocket>
  onClose: () => void
  onPick: (slot: PlanSlotId) => void
}): JSX.Element {
  return (
    <Menu anchorEl={pending?.anchor ?? null} open={pending !== null} onClose={onClose}>
      {(pending === null ? [] : targetCells(pending.donor)).map((cell) => {
        const over = pending === null ? null : outgoing(occupied, cell, pending.donor.socket, pending.donor)
        return (
          <MenuItem key={cell} data-testid="planner-slot-choice" onClick={() => onPick(cell)}>
            {planSlotLabel(cell)}
            {over !== null && (
              <Typography variant="caption" color="warning.main" sx={{ ml: 1 }}>
                replaces {over}
              </Typography>
            )}
          </MenuItem>
        )
      })}
    </Menu>
  )
}

interface RowListProps {
  rows: readonly BrowserRow[]
  win: { start: number; end: number; topPad: number; bottomPad: number }
  planClasses: readonly ClassAbbr[]
  planned: ReadonlySet<string>
  /** what each row's ADD would displace — `replacesFor`, folded once per plan change */
  replaces: (donor: DonorRow) => string | null
  ready: boolean
  /** what the two view toggles are holding back — only consulted when `rows` is empty (JOS-67) */
  hidden: HiddenByView
  onToggle: (id: string) => void
  onAdd: (donor: DonorRow, anchor: HTMLElement) => void
  onOpenLoot?: (item: string) => void
}

/**
 * WHY THE LIST IS EMPTY, in one sentence that names the filter responsible.
 *
 * "No effects match these filters" is true of a typo and of a filter quietly holding back four
 * real answers, and the second is the case a user reported (JOS-67). The counts come from
 * `hiddenByView`; the toggles they name are two controls up, in the filter bar.
 */
function emptyText(ready: boolean, hidden: HiddenByView): string {
  if (!ready) return 'Reading the item database…'
  const parts: string[] = []
  if (hidden.era > 0) parts.push(`${String(hidden.era)} outside ${CURRENT_ERA_LABEL}`)
  if (hidden.nonEquip > 0) parts.push(`${String(hidden.nonEquip)} with no equipment slot`)
  if (parts.length === 0) return 'No effects match these filters.'
  return `No effects match these filters - but ${parts.join(' and ')} are hidden by the toggles above.`
}

/** The bounded scroll box (AGENTS.md UI conventions) and the window of rows inside it. */
function RowList(props: RowListProps): JSX.Element {
  const { rows, win, planClasses, planned, replaces, ready, hidden, onToggle, onAdd, onOpenLoot } = props
  return (
    <>
      <Box sx={{ height: win.topPad }} />
      {rows.slice(win.start, win.end).map((row: BrowserRow) =>
        row.kind === 'header' ? (
          <GroupLine key={row.group.id} group={row.group} expanded={row.expanded} onToggle={onToggle} />
        ) : (
          <DonorLine
            key={`${row.groupId}:${row.donor.key}:${row.donor.effect}`}
            donor={row.donor}
            planClasses={planClasses}
            planned={planned.has(`${row.donor.key}::${row.donor.effect}`)}
            best={row.best}
            namesEffect={row.namesEffect}
            namesSays={row.namesSays}
            replaces={replaces(row.donor)}
            onAdd={onAdd}
            onOpenLoot={onOpenLoot}
          />
        )
      )}
      <Box sx={{ height: win.bottomPad }} />
      {rows.length === 0 && (
        <Typography variant="body2" color="text.secondary" data-testid="planner-effects-empty" sx={{ p: 2 }}>
          {emptyText(ready, hidden)}
        </Typography>
      )}
    </>
  )
}

/**
 * THE TWO WRITES THE BROWSER MAKES, and the one question it may have to ask first.
 *
 * One CELL ⇒ one click. Several ⇒ the slot menu, because the planner must not pick which of
 * PRIMARY/SECONDARY a sword goes into — or which of your two rings (JOS-67) — on the user's behalf.
 * UNDER A PRESET THERE IS NOTHING TO ASK (V8): you clicked a specific socket of a specific item, so
 * a two-slot sword goes into the socket you opened rather than into a menu re-asking the question.
 *
 * A plain function, not a hook — it closes over props and state the caller already holds, and
 * calls nothing of React's.
 */
function writeFlow(ctx: {
  preset: BrowsePreset | null
  onSocket: (slot: PlanSlotId, socket: SocketType, planned: { effect: string; donorKey: string }) => void
  pending: PendingAdd | null
  setPending: (p: PendingAdd | null) => void
}): {
  add: (donor: DonorRow, anchor: HTMLElement) => void
  chooseSlot: (slot: PlanSlotId) => void
} {
  const { preset, onSocket, pending, setPending } = ctx
  return {
    add: (donor, anchor) => {
      const planned = { effect: donor.effect, donorKey: donor.key }
      const cells = targetCells(donor)
      if (preset !== null) onSocket(preset.slot, preset.socket, planned)
      else if (cells.length === 1) onSocket(cells[0], donor.socket, planned)
      else if (cells.length > 1) setPending({ donor, anchor })
    },
    chooseSlot: (slot) => {
      if (pending) {
        onSocket(slot, pending.donor.socket, { effect: pending.donor.effect, donorKey: pending.donor.key })
      }
      setPending(null)
    }
  }
}

export interface EffectBrowserProps {
  plan: ExaltPlan
  /**
   * V8 — browsing ONE SOCKET OF ONE HOST, arrived at by clicking a socket on the Inventory tab.
   * It overrides the socket and slot controls and narrows to the host's own classes; clearing it
   * (the X on the preset chip, or touching any filter control) hands the browser back.
   */
  preset?: BrowsePreset | null
  onClearPreset?: () => void
  /** write one socket of the selected set (usePlans' `setSocket`) */
  onSocket: (slot: PlanSlotId, socket: SocketType, planned: { effect: string; donorKey: string }) => void
  /** deep-link a donor into the Loot tab's item drill-down (App's `openLoot`) */
  onOpenLoot?: (item: string) => void
}

export default function EffectBrowser({
  plan,
  preset = null,
  onClearPreset,
  onSocket,
  onOpenLoot
}: EffectBrowserProps): JSX.Element {
  const { donors, ready } = useDonors()
  const era = useEraOnly()
  const nonEquip = useNonEquip()
  const [own, setOwn] = useState<DonorFilters>(DEFAULT_FILTERS)
  const hostClasses = useHostClasses(preset)
  // THE PRESET WINS while it is on: the socket and slot it names are facts about the item window
  // you came from, not preferences. Touching any control clears it (`change` below), because
  // changing the socket tab while filtered to a Proc socket would be asking two things at once.
  // The preset names a CELL; the donor filter is about the equipment SLOT that cell occupies, so
  // browsing FINGER 2 shows the same ring donors as browsing FINGER 1 (JOS-67). An ANY cell
  // occupies none, and `equipSlotOf` returns null there — which is already this filter's word for
  // "every slot" (JOS-104), so browsing an any-slot's socket narrows by socket and host classes
  // and leaves the slot alone, which is exactly what that place allows.
  const filters: DonorFilters = useMemo(
    () => (preset === null ? own : { ...own, socket: preset.socket, slot: equipSlotOf(preset.slot) }),
    [own, preset]
  )
  const change = (next: DonorFilters): void => {
    setOwn(next)
    onClearPreset?.()
  }
  const groupBy = useGroupBy(filters.socket)
  const [text, setText] = useState('')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [pending, setPending] = useState<PendingAdd | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Warm the source index AFTER mount, not on the render path: the first donor row to ask for a
  // source would otherwise pay the whole ~33k-link build inside a paint (design §4.2, "off-path").
  useEffect(() => {
    sourceIndex()
  }, [])

  // The input echoes instantly; the FILTER runs on the deferred value (the standing search law).
  const deferredText = useDeferredValue(text)
  // Read out of the tuples so the memo's dependency list names the VALUES: the setter half of
  // each tuple is a fresh identity nothing here depends on.
  const view = useMemo(() => ({ eraOnly: era[0], nonEquip: nonEquip[0] }), [era, nonEquip])
  const { rows, hidden } = useVisibleRows({
    donors,
    filters,
    text: deferredText,
    planClasses: plan.classes,
    view,
    hostClasses,
    presetActive: preset !== null,
    axis: groupBy[0],
    open
  })
  const planned = useMemo(() => plannedPairs(plan), [plan])
  // Folded once per plan (or preset) change, not per row: the occupancy map is a handful of
  // entries and every visible row asks it the same question.
  const occupied = useMemo(() => plannedBySocket(plan), [plan])
  const replaces = useMemo(
    () => (donor: DonorRow) => replacesFor(occupied, preset, donor),
    [occupied, preset]
  )
  const win = useWindowedRows({ count: rows.length, rowHeight: ROW_HEIGHT, scrollRef })

  const toggle = (id: string): void => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }
  const { add, chooseSlot } = writeFlow({ preset, onSocket, pending, setPending })

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
      <EffectFilterBar
        filters={filters}
        setFilters={change}
        text={text}
        setText={setText}
        era={era}
        nonEquip={nonEquip}
        groupBy={groupBy}
        preset={preset}
        onClearPreset={onClearPreset}
      />

      <Box
        ref={scrollRef}
        data-testid="planner-effect-list"
        sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}
      >
        <RowList
          rows={rows}
          win={win}
          planClasses={plan.classes}
          planned={planned}
          replaces={replaces}
          ready={ready}
          hidden={hidden}
          onToggle={toggle}
          onAdd={add}
          onOpenLoot={onOpenLoot}
        />
      </Box>

      <SlotMenu
        pending={pending}
        occupied={occupied}
        onClose={() => setPending(null)}
        onPick={chooseSlot}
      />
    </Box>
  )
}
