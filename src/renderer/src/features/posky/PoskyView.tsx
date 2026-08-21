import { type JSX, useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Box, Checkbox, FormControlLabel, Stack, Tab, Tabs, Typography } from '@mui/material'
import type { CountSource, ItemCountOverride } from '@shared/types'
import { OverrideSummaryChip } from './ItemOverrides'
import { useProgress, type QuestProgress } from './useProgress'
import { IgnoredList } from './IgnoredList'
import QuestFilterBar, { InventorySource } from './QuestFilterBar'
import { countSourcePhrase, countsFromInventory } from '../inventory/countSource'
// The game fact that can empty this tab and that no amount of re-exporting will fix (JOS-409).
import { DUMP_BLIND_READY_NOTE } from './dumpBlindItems'
import ClassUnlockList from './ClassUnlockList'
import { TargetsView } from './TargetsView'
import { useQuestList, type QuestListState, type TabKey } from './useQuestList'
// The rows themselves live in their own file since JOS-389 — see its header for why.
import { QuestList, type QuestAnchor, type QuestListProps } from './QuestList'
import CleanupList, { NO_DUMP_LOCATIONS } from './CleanupList'
import { cleanupRowsFor } from './cleanup'
import type { MobTarget } from '../mobs/mobTarget'
import Confetti from '../../lib/Confetti'

// The one-line status under the filters. It states which of three situations you are in —
// there is no Sky data at all, there is data but you ignored every quest, or here are the
// counts — and which SOURCE the "have" numbers came from.
//
// HOW OLD that source is moved out of here in JOS-44: it is the `/outputfile` registry's line
// (OutputKindLine), which reads the file's own mtime rather than the store's record of the last
// reload — so a dump this app has never loaded still dates itself honestly, and a character who
// has never run the command reads "not yet run" instead of nothing at all. Since JOS-268 that line
// lives on the filter bar, under the dropdown that decides whether the dump is counted at all.
//
// The WORDS for each source are `countSourcePhrase` (features/inventory/countSource.ts) since
// JOS-294: this line and the dropdown's own labels were two hand-written descriptions of one rule,
// and both of them still described JOS-128's reset semantics that JOS-141 reverted.
//
// AND IT CARRIES THE HAND-CORRECTION COUNT SINCE JOS-186. A stated count is the one input to the
// whole tab that no witness can be asked about, so the line that already names the SOURCE names it
// too — same argument, one ticket later.
function CountsLine({
  questCount,
  totalQuests,
  filteredCount,
  countSource,
  overrides
}: {
  questCount: number
  totalQuests: number
  filteredCount: number
  countSource: CountSource
  overrides: readonly ItemCountOverride[]
}): JSX.Element {
  if (questCount === 0) {
    return (
      <Alert severity="info">
        No Plane of Sky data available.
      </Alert>
    )
  }
  if (totalQuests === 0) {
    // Data exists, it is all ignored — say so, and point at the tab that undoes it.
    return (
      <Typography color="text.secondary">
        Every quest is ignored - the Ignored tab can bring them back.
      </Typography>
    )
  }
  return (
    // The stable handle for the filter specs: this line is where a narrowing filter becomes
    // VISIBLE, so it is what an e2e reads to prove a facet pick actually removed rows.
    <Typography variant="body2" color="text.secondary" data-testid="posky-counts">
      {filteredCount} of {totalQuests} quests · counting from {countSourcePhrase(countSource)}
      <OverrideSummaryChip overrides={overrides} />
    </Typography>
  )
}


/**
 * The Ready tab's ONE control (JOS-155): show only the quests you have never handed in.
 *
 * It ships TICKED, which is the owner's direction rather than a guess - the default
 * walk-the-islands list is first-time turn-ins, and untickng it is how you ask for the refarms you
 * have already completed. The stored sense is inverted to match (useQuestList's `useStoredFlag`
 * argues it); nothing about that is visible here, where the box is simply on until you turn it off.
 *
 * The LABEL is the whole explanation, deliberately, and there is no hover text on it: this tab sits
 * directly above the same accordion rows QuestFilterBar's controls do, and JOS-143 is the standing
 * answer to putting anything hoverable over a control here. It is worded to mirror the Quests tab's
 * "Hide quests I have turned in" from the other side, because it is the same predicate read as a
 * keep rather than a hide.
 */
function ReadyFirstTimeToggle({ list }: { list: QuestListState }): JSX.Element {
  return (
    <FormControlLabel
      control={
        <Checkbox
          // The stable handle for tests/e2e/sky-turnin.e2e.mts, which drives the whole arc: a
          // refarmed quest is absent under the default and present the moment this is unticked.
          data-testid="posky-ready-first-time"
          checked={list.readyFirstTimeOnly}
          onChange={(e) => list.setReadyFirstTimeOnly(e.target.checked)}
        />
      }
      label="Only quests I have never turned in"
    />
  )
}

/** What the Ready tab needs on top of a list of rows: the count source, because the tab it can
 *  empty is this one (JOS-294, scope C). */
interface ReadyListProps extends QuestListProps {
  countSource: CountSource
  onCountSource: (s: CountSource) => void
  inventoryLoadedAt: number | null
}

/**
 * The Ready tab (JOS-147): what you can hand in RIGHT NOW, in the order you would walk it if the
 * data said where the givers stood (it does not - see questCompletion.readyQuests).
 *
 * Same rows as the main list, deliberately: this is the same quest, so it gets the same star, the
 * same ignore button, the same item chips and the same expandable panel with the turn-in counter
 * in it. A second, thinner row rendering would be a second thing to keep in step with the first.
 *
 * The set itself is `list.ready`, which no filter and neither of the QUESTS tab's hide-boxes can
 * reach. Since JOS-155 the tab has one control of its own, drawn above BOTH states rather than only
 * above the list: a toggle that can empty the tab has to stay reachable when it has, or the user is
 * left staring at an empty pane with no way to ask for the rest.
 *
 * AND SINCE JOS-294 THE COUNT SOURCE IS UP HERE TOO, on exactly that argument (scope C). It is the
 * strongest emptier of this tab in the app: "ready" is `haveCount === needCount`, so the source
 * decides the entire membership of the list — and the one control that could change it lived on
 * `QuestFilterBar`, which renders ONLY on the Quests branch. An in-app reporter with a deleted log
 * (01KZWDKMXYRERD96CF8AYQFA7P, and their friend) sat on an empty Ready tab holding a dump full of
 * the items, with the control that would have counted them on a tab they had no reason to open and
 * no line anywhere saying the dump was being ignored. Both come with the group: the dropdown, and
 * the caption under it that states the freshness — or, under `log` with a dump loaded, that the
 * dump is not being counted at all.
 *
 * The row leaves `mb: 2.5` below it because the caption is an OVERLAY hanging off the dropdown's
 * bottom edge (QuestFilterBar's `InventorySource` argues why it is out of flow) — on the Quests tab
 * it hangs in the view's own `Stack spacing`, and here that gap has to be bought explicitly.
 */
function ReadyList(props: ReadyListProps): JSX.Element {
  const n = props.quests.length
  const { readyFirstTimeOnly, readyRefarmCount } = props.list
  // THE RUNE CAVEAT (JOS-409), on both states of the tab for JOS-155's reason: the thing it
  // explains is a quest that is ABSENT, so the empty pane is precisely where it is needed most.
  // Gated on the source actually reading the export — under `log` the dump answers nothing and its
  // blindness explains nothing (`countsFromInventory` is that gate, shared with the freshness line).
  const runeNote = countsFromInventory(props.countSource) ? ` ${DUMP_BLIND_READY_NOTE}` : ''
  return (
    <Box
      data-testid="posky-ready"
      sx={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <Stack direction="row" spacing={2} alignItems="center" useFlexGap sx={{ mb: 2.5 }}>
        <ReadyFirstTimeToggle list={props.list} />
        <Box sx={{ flexGrow: 1 }} />
        <InventorySource
          countSource={props.countSource}
          onCountSource={props.onCountSource}
          inventoryLoadedAt={props.inventoryLoadedAt}
        />
      </Stack>
      {n === 0 ? (
        <Typography color="text.secondary" data-testid="posky-ready-empty">
          Nothing is ready to turn in - a quest lands here the moment you are holding every item it
          needs, and leaves when you hand them over.
          {readyFirstTimeOnly && readyRefarmCount > 0
            ? ` ${String(readyRefarmCount)} you have run before ${readyRefarmCount === 1 ? 'is' : 'are'} ready now - untick the box to see ${readyRefarmCount === 1 ? 'it' : 'them'}.`
            : ''}
          {runeNote}
        </Typography>
      ) : (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }} data-testid="posky-ready-count">
            {n} quest{n === 1 ? '' : 's'} you are holding every item for
            {readyFirstTimeOnly ? ' and have never turned in' : ''}.
            {readyFirstTimeOnly && readyRefarmCount > 0
              ? ` ${String(readyRefarmCount)} more you have run before ${readyRefarmCount === 1 ? 'is' : 'are'} ready too.`
              : ''}
            {/* THE WAY OFF A STUCK ROW (JOS-186). A reporter destroyed a quest item and this tab
                nagged forever, because nothing in a log or a dump records a destruction — so the
                sentence points at the control that fixes it rather than at a dismiss button this
                tab deliberately does not have (questCompletion.readyQuests). */}
            {' Holding something you no longer have? Expand the quest and correct the count beside the item.'}
            {runeNote}
          </Typography>
          <QuestList {...props} />
        </>
      )}
    </Box>
  )
}

/**
 * The five tabs, in the order the work happens: what you are farming, what you can hand in, what
 * you could throw away now that you have, what all that grinding is FOR, and what you told the app
 * to forget. Ready, Cleanup and Ignored carry their own count, because the number IS the reason to
 * look.
 *
 * Classes deliberately does not (JOS-148). Its number would be "how many classes are unlocked",
 * which needs the classUnlocks module — and subscribing to it HERE, just to letter a tab, would
 * put a second copy of the tab's own model in the container that mounts it. The count is the first
 * thing the tab says when you open it, one line above the rows.
 *
 * Cleanup's number arrives as a PROP rather than off `list` (JOS-389): it is not list state at
 * all, it is the cleanup model's own row count, and the view computes it once above both this bar
 * and the pane so the tab and its rows cannot disagree.
 */
function PoskyTabs({ list, cleanupCount }: { list: QuestListState; cleanupCount: number }): JSX.Element {
  return (
    <Tabs
      value={list.tab}
      onChange={(_e, v: TabKey) => list.setTab(v)}
      sx={{ minHeight: 36, mb: -1, '& .MuiTab-root': { minHeight: 36, py: 0 } }}
    >
      <Tab value="quests" label="Quests" data-testid="posky-tab-quests" />
      {/* "Ready" - the shortest true name for it, and the same word the row's own chip already
          uses ("Ready to turn in"). Anything longer would be a sentence on a tab. The COUNT is
          `list.ready.length`, the same array the tab draws, so it follows JOS-155's first-time
          toggle without knowing the toggle exists - a number that disagreed with the rows under
          it would be worse than no number. */}
      <Tab
        value="ready"
        label={list.ready.length ? `Ready (${list.ready.length})` : 'Ready'}
        data-testid="posky-tab-ready"
      />
      {/* "Targets" - who to pull next (issue #30). The COUNT is `list.targets.mobs.length`, the
          same array the pane draws, on the Ready precedent above - the collective random-drop
          entry and the no-known-source note are NOT in it, because the number answers "how many
          mobs", not "how many sections". */}
      <Tab
        value="targets"
        label={list.targets.mobs.length ? `Targets (${list.targets.mobs.length})` : 'Targets'}
        data-testid="posky-tab-targets"
      />
      {/* "Cleanup" - the owner's own word for the screen (JOS-389). The count is how many items
          the model lists, i.e. how many stacks are candidates to throw away, which is exactly the
          number that decides whether the tab is worth opening after a long campaign. */}
      <Tab
        value="cleanup"
        label={cleanupCount ? `Cleanup (${String(cleanupCount)})` : 'Cleanup'}
        data-testid="posky-tab-cleanup"
      />
      {/* "Classes" - what the tests are for. The word is the class, not the unlock, because a row
          is a class whether or not it is unlocked and the tab is as much a progress list. */}
      <Tab value="classes" label="Classes" data-testid="posky-tab-classes" />
      <Tab
        value="ignored"
        label={list.ignored.length ? `Ignored (${list.ignored.length})` : 'Ignored'}
        data-testid="posky-tab-ignored"
      />
    </Tabs>
  )
}

/**
 * Resolve a deep link's quest KEY against the loaded quests and reveal it.
 *
 * TWO STEPS, because the ask can land before the data does: the toast fires the instant a turn-in
 * is observed, and this tab's dataset + progress arrive asynchronously. So the request is HELD
 * (`pending`) until a quest with that key exists, then the filters are reset around it and the
 * anchor is published for the list to expand + scroll. A key that never resolves simply never
 * anchors — the tab still opened, which is the honest partial answer.
 */
function useQuestAnchor(
  quests: QuestProgress[],
  list: QuestListState,
  focus: { quest: string | null; nonce: number; onConsumed?: () => void }
): QuestAnchor | null {
  const [pending, setPending] = useState<QuestAnchor | null>(null)
  const [anchor, setAnchor] = useState<QuestAnchor | null>(null)
  const { quest, nonce, onConsumed } = focus

  useEffect(() => {
    if (!quest) return
    setPending({ key: quest, nonce })
    onConsumed?.()
    // The NONCE is the trigger, by the standing contract: the same quest asked for twice must
    // arrive twice, and the payload is read fresh each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce])

  useEffect(() => {
    if (!pending) return
    const match = quests.find((q) => q.key.toLowerCase() === pending.key.toLowerCase())
    if (!match) return
    list.revealQuest(match.name)
    setAnchor({ key: match.key, nonce: pending.nonce })
    setPending(null)
    // `list` is rebuilt every render (it is a hook result, not a value); depending on it would
    // re-run this on every keystroke. The quests and the pending ask are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, quests])

  return anchor
}

/** Everything the five panes need between them. One bag, because it is one switch. */
interface PoskyBodyProps {
  quests: QuestProgress[]
  list: QuestListState
  classes: string[]
  /** the identical bundle both row-drawing tabs take (see `QuestListProps`) */
  rows: Omit<QuestListProps, 'quests'>
  countSource: CountSource
  onCountSource: (s: CountSource) => void
  inventoryLoadedAt: number | null
  /** an item name → the Loot tab's drill-down, for the pane that draws names without quest rows */
  onOpenLoot?: (item: string) => void
  itemOverrides: readonly ItemCountOverride[]
}

/**
 * WHICH PANE IS UNDER THE TABS. Its own function since JOS-389 put a fifth branch in the chain:
 * the container was over the measured per-function ceiling, and the split is the honest one —
 * `PoskyView` owns the hooks, the confetti and the derivations, and this owns the switch.
 */
function PoskyBody(x: PoskyBodyProps): JSX.Element {
  const { list, rows, countSource, onCountSource, inventoryLoadedAt } = x
  if (list.tab === 'ignored') {
    return <IgnoredList quests={list.ignored} onUnignore={list.questIgnored.toggle} />
  }
  if (list.tab === 'cleanup') {
    return (
      <CleanupList
        // EVERY quest, ignored ones included - see the note on `cleanupCount` below.
        quests={x.quests}
        countSource={countSource}
        onCountSource={onCountSource}
        inventoryLoadedAt={inventoryLoadedAt}
        onOpenLoot={x.onOpenLoot}
      />
    )
  }
  if (list.tab === 'ready') {
    return (
      <ReadyList
        quests={list.ready}
        {...rows}
        countSource={countSource}
        onCountSource={onCountSource}
        inventoryLoadedAt={inventoryLoadedAt}
      />
    )
  }
  if (list.tab === 'targets') {
    // The kill list (issue #30): derived from the same visible set as every other tab, drawn
    // by its own view file (TargetsView.tsx) because it renders mob cards, not quest rows.
    // `onOpenMob` rides in on the rows bundle — same router the quest rows' mob chips use, and
    // `list.revealQuest` is the other door: a quest name on a card is the same deep link a
    // celebration toast follows (JOS-417), so the tab a player leaves is the one they arrived
    // for. The count source and the first-time toggle ride along on the Ready tab's JOS-294
    // argument - between them they decide every shortfall this tab shows.
    return (
      <TargetsView
        targets={list.targets}
        onOpenMob={rows.onOpenMob}
        onOpenQuest={list.revealQuest}
        countSource={countSource}
        onCountSource={onCountSource}
        inventoryLoadedAt={inventoryLoadedAt}
        firstTimeOnly={list.targetsFirstTimeOnly}
        onFirstTimeOnly={list.setTargetsFirstTimeOnly}
        refarmCount={list.targetsRefarmCount}
      />
    )
  }
  if (list.tab === 'classes') {
    // The VISIBLE quests, like every other tab: a quest the user permanently ignored is not shown
    // here either, and a class's total shrinks with it rather than counting a quest the app has
    // been told to forget. `list.visible` is that set (useQuestList.useVisibleQuests). A row is a
    // DOOR (JOS-157): clicking a class lands on the Quests tab filtered to it. The navigation is
    // `list.showClassQuests`, so the drill-down writes the same stored pick the class chip writes
    // and the state it leaves behind is one a user could have set by hand.
    return <ClassUnlockList quests={list.visible} onOpenClass={list.showClassQuests} />
  }
  return (
    <>
      {/* THE FRESHNESS LINE MOVED INTO THIS BAR (JOS-268), and both halves of that are the
          owner's ruling on the JOS-253 surface. WHERE: it hangs under the "Count items from"
          dropdown as an absolutely-positioned caption, so it is beside the control it is
          about and nothing below it moves when it appears. WHEN: only while an inventory-
          backed source is selected — JOS-253 put it on ALWAYS, because `log` is the default
          and a player who never opened the dropdown had no line at all, but the answer to
          that was auto-loading (this app now reads the dump at startup and follows it), not a
          permanent bar about a file the current source does not read. */}
      <QuestFilterBar
        list={list}
        classes={x.classes}
        countSource={countSource}
        onCountSource={onCountSource}
        inventoryLoadedAt={inventoryLoadedAt}
      />
      <CountsLine
        questCount={x.quests.length}
        // Counts describe the list you are looking at, so ignored quests are not in them.
        totalQuests={list.visible.length}
        filteredCount={list.filtered.length}
        countSource={countSource}
        overrides={x.itemOverrides}
      />
      <QuestList quests={list.filtered} {...rows} />
    </>
  )
}

export default function PoskyView({
  onOpenMob,
  onOpenLoot,
  focusQuest = null,
  focusNonce = 0,
  onFocusConsumed
}: {
  onOpenMob: (t: MobTarget) => void
  /** an item name → the Loot tab's drill-down (App's `openLoot`); optional so the pane stands alone */
  onOpenLoot?: (item: string) => void
  /** a celebration toast's per-quest anchor: the canonical `Class::Name` key, or null for the tab */
  focusQuest?: string | null
  /** bumps per link (appRouting's nonce contract) so the same quest can be asked for twice */
  focusNonce?: number
  onFocusConsumed?: () => void
}): JSX.Element {
  // A quest completing via a LIVE turn-in bursts confetti over this view (mirrors
  // BossView's onKill confetti, Task #46). useProgress gates out the historical
  // baseline, so this only fires for a real turn-in observed while the app is open.
  const [burst, setBurst] = useState<number | null>(null)
  const onQuestComplete = useCallback(() => {
    setBurst((n) => (n ?? 0) + 1)
  }, [])

  const {
    quests,
    classes,
    countSource,
    setCountSource,
    recordTurnIn,
    undoTurnIn,
    setItemOverride,
    itemOverrides,
    inventoryInfo,
    sharedItems,
    ambiguousQuestNames
  } = useProgress({ onQuestComplete })
  const list = useQuestList(quests)
  /**
   * THE CLEANUP COUNT, derived without the dump (JOS-389). Where an item SITS decides nothing
   * about whether it belongs on that tab — membership is the turn-in rule and the held counts, and
   * nothing else (cleanup.ts) — so the number on the tab costs one pass over the quests here and
   * no `character:sheet` read for a player who never opens it. The pane recomputes the same list
   * WITH the places on it; the two agree by construction because locations are decoration.
   *
   * It reads EVERY quest, ignored ones included, unlike every other tab on this view. Ignoring a
   * quest means "never show me this row"; it does not mean "give away the drops it needs". On a
   * screen whose advice is destructive the safe reading is the conservative one, so an ignored
   * quest still speaks for its items.
   */
  const cleanupCount = useMemo(() => cleanupRowsFor(quests, NO_DUMP_LOCATIONS).length, [quests])
  const anchor = useQuestAnchor(quests, list, {
    quest: focusQuest,
    nonce: focusNonce,
    onConsumed: onFocusConsumed
  })

  // Everything a quest ROW needs except which quests to draw. Both tabs that draw rows pass the
  // identical bundle, which is what "same row rendering" means in code rather than in prose.
  const rows: Omit<QuestListProps, 'quests'> = {
    list,
    sharedItems,
    ambiguousNames: ambiguousQuestNames,
    anchor,
    recordTurnIn,
    undoTurnIn,
    setItemCount: setItemOverride,
    onOpenMob,
    onOpenLoot
  }

  return (
    <Stack spacing={2} sx={{ height: '100%', position: 'relative' }}>
      {burst != null && <Confetti key={burst} onDone={() => setBurst(null)} />}
      <PoskyTabs list={list} cleanupCount={cleanupCount} />
      <PoskyBody
        quests={quests}
        list={list}
        classes={classes}
        rows={rows}
        countSource={countSource}
        onCountSource={setCountSource}
        inventoryLoadedAt={inventoryInfo?.readAt ?? null}
        onOpenLoot={onOpenLoot}
        itemOverrides={itemOverrides}
      />
    </Stack>
  )
}
