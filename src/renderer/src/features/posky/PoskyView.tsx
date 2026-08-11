import { type JSX, useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Checkbox,
  Chip,
  FormControlLabel,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  Typography
} from '@mui/material'
import type { CountSource } from '@shared/types'
import { useProgress, type QuestProgress } from './useProgress'
// The `/outputfile` freshness line (JOS-44), wired to the registry: this tab's have/need chips
// read the same dump the Exaltations tab does, so they get the same one-line treatment — the
// command, one clause of why, and the FILE's own age (or "not yet run").
import OutputKindLine from '../../components/OutputKindLine'
import { QuestIgnoreButton } from '../favorites/QuestFlagButtons'
import { TurnInBadge } from './TurnInControls'
import QuestFilterBar from './QuestFilterBar'
import ClassUnlockList from './ClassUnlockList'
import { useQuestList, type QuestListState, type TabKey } from './useQuestList'
import { QuestList, type QuestAnchor, type QuestListProps } from './QuestList'
import type { MobTarget } from '../mobs/mobTarget'
import Confetti from '../../lib/Confetti'

// The Ignored tab: every quest the user hid, in one flat compact list (no accordions —
// there is nothing to work on here), each row carrying the same button that put it here,
// now reading "Stop ignoring". Un-ignoring drops the row instantly and the quest
// reappears under Quests with its favorite state untouched.
function IgnoredList({
  quests,
  onUnignore
}: {
  quests: QuestProgress[]
  onUnignore: (questKey: string) => void
}): JSX.Element {
  if (quests.length === 0) {
    return (
      <Typography color="text.secondary">
        No ignored quests - hide one with the eye icon on its row and it lands here.
      </Typography>
    )
  }
  return (
    <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {quests.length} quest{quests.length === 1 ? '' : 's'} hidden from the list, filters and counts.
      </Typography>
      <Stack spacing={0.5}>
        {quests.map((q) => (
          <Stack
            key={q.key}
            direction="row"
            spacing={2}
            alignItems="center"
            sx={{ px: 1, py: 0.5, borderRadius: 1, '&:hover': { bgcolor: 'action.hover' } }}
          >
            <QuestIgnoreButton ignored onToggle={() => onUnignore(q.key)} />
            <Chip label={q.className} size="small" color="secondary" variant="outlined" sx={{ minWidth: 92 }} />
            <Typography variant="subtitle2" sx={{ minWidth: 220 }}>
              {q.name}
            </Typography>
            {q.reward && (
              <Typography variant="caption" color="primary.main">
                → {q.reward}
              </Typography>
            )}
            <Box sx={{ flexGrow: 1 }} />
            <TurnInBadge count={q.turnIns} />
          </Stack>
        ))}
      </Stack>
    </Box>
  )
}

// The one-line status under the filters. It states which of three situations you are in —
// there is no Sky data at all, there is data but you ignored every quest, or here are the
// counts — and which SOURCE the "have" numbers came from.
//
// HOW OLD that source is moved out of here in JOS-44: it is the `/outputfile` registry's line
// (OutputKindLine, right above), which reads the file's own mtime rather than the store's record
// of the last reload — so a dump this app has never loaded still dates itself honestly, and a
// character who has never run the command reads "not yet run" instead of nothing at all.
function CountsLine({
  questCount,
  totalQuests,
  filteredCount,
  countSource
}: {
  questCount: number
  totalQuests: number
  filteredCount: number
  countSource: CountSource
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
      {filteredCount} of {totalQuests} quests · counting from{' '}
      {countSource === 'log'
        ? 'looted log'
        : countSource === 'inventory'
          ? 'inventory export plus loot since'
          : 'inventory export if any, else the looted log'}
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
 */
function ReadyList(props: QuestListProps): JSX.Element {
  const n = props.quests.length
  const { readyFirstTimeOnly, readyRefarmCount } = props.list
  return (
    <Box
      data-testid="posky-ready"
      sx={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <ReadyFirstTimeToggle list={props.list} />
      {n === 0 ? (
        <Typography color="text.secondary">
          Nothing is ready to turn in - a quest lands here the moment you are holding every item it
          needs, and leaves when you hand them over.
          {readyFirstTimeOnly && readyRefarmCount > 0
            ? ` ${String(readyRefarmCount)} you have run before ${readyRefarmCount === 1 ? 'is' : 'are'} ready now - untick the box to see ${readyRefarmCount === 1 ? 'it' : 'them'}.`
            : ''}
        </Typography>
      ) : (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }} data-testid="posky-ready-count">
            {n} quest{n === 1 ? '' : 's'} you are holding every item for
            {readyFirstTimeOnly ? ' and have never turned in' : ''}.
            {readyFirstTimeOnly && readyRefarmCount > 0
              ? ` ${String(readyRefarmCount)} more you have run before ${readyRefarmCount === 1 ? 'is' : 'are'} ready too.`
              : ''}
          </Typography>
          <QuestList {...props} />
        </>
      )}
    </Box>
  )
}

/**
 * The four tabs, in the order the work happens: what you are farming, what you can hand in, what
 * all that grinding is FOR, and what you told the app to forget. Ready and Ignored carry their own
 * count, because the number IS the reason to look.
 *
 * Classes deliberately does not (JOS-148). Its number would be "how many classes are unlocked",
 * which needs the classUnlocks module — and subscribing to it HERE, just to letter a tab, would
 * put a second copy of the tab's own model in the container that mounts it. The count is the first
 * thing the tab says when you open it, one line above the rows.
 */
function PoskyTabs({ list }: { list: QuestListState }): JSX.Element {
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
    reloadInventory,
    recordTurnIn,
    undoTurnIn,
    sharedItems,
    ambiguousQuestNames
  } = useProgress({ onQuestComplete })
  const list = useQuestList(quests)
  const anchor = useQuestAnchor(quests, list, {
    quest: focusQuest,
    nonce: focusNonce,
    onConsumed: onFocusConsumed
  })
  const [toast, setToast] = useState<string | null>(null)

  const onReload = async (): Promise<void> => setToast(await reloadInventory())

  // Counts describe the list you are looking at, so ignored quests are not in them.
  const totalQuests = list.visible.length

  // Everything a quest ROW needs except which quests to draw. Both tabs that draw rows pass the
  // identical bundle, which is what "same row rendering" means in code rather than in prose.
  const rows: Omit<QuestListProps, 'quests'> = {
    list,
    sharedItems,
    ambiguousNames: ambiguousQuestNames,
    anchor,
    recordTurnIn,
    undoTurnIn,
    onOpenMob,
    onOpenLoot
  }

  return (
    <Stack spacing={2} sx={{ height: '100%', position: 'relative' }}>
      {burst != null && <Confetti key={burst} onDone={() => setBurst(null)} />}
      <PoskyTabs list={list} />
      {list.tab === 'ignored' ? (
        <IgnoredList quests={list.ignored} onUnignore={list.questIgnored.toggle} />
      ) : list.tab === 'ready' ? (
        <ReadyList quests={list.ready} {...rows} />
      ) : list.tab === 'classes' ? (
        // The VISIBLE quests, like every other tab: a quest the user permanently ignored is not
        // shown here either, and a class's total shrinks with it rather than counting a quest the
        // app has been told to forget. `list.visible` is that set (useQuestList.useVisibleQuests).
        // A row is a DOOR (JOS-157): clicking a class lands on the Quests tab filtered to it. The
        // navigation is `list.showClassQuests`, so the drill-down writes the same stored pick the
        // class chip writes and the state it leaves behind is one a user could have set by hand.
        <ClassUnlockList quests={list.visible} onOpenClass={list.showClassQuests} />
      ) : (
        <>
          <QuestFilterBar
            list={list}
            classes={classes}
            countSource={countSource}
            onCountSource={setCountSource}
            onReload={onReload}
          />
          {/* Only when the dump actually feeds the numbers: counting from the looted log alone
              means this tab does not read the export at all, and a freshness line about a file
              nothing on screen depends on is the caveat this diet exists to refuse. */}
          {countSource !== 'log' && (
            <OutputKindLine kind="inventory" testId="posky-inventory-fresh" />
          )}
          <CountsLine
            questCount={quests.length}
            totalQuests={totalQuests}
            filteredCount={list.filtered.length}
            countSource={countSource}
          />
          <QuestList quests={list.filtered} {...rows} />
        </>
      )}

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
