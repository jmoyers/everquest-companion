// posky/QuestList.tsx — the scrolling list of quest rows, and the bottom of it.
//
// Split out of PoskyView.tsx (JOS-389), which went over the measured 400-line ceiling when the
// Cleanup tab added a fifth pane. Nothing about the rows changed: this is the same list both
// row-drawing tabs mount, with the same identity-stable props argument (JOS-206) and the same
// paging footer, moved verbatim so the container can stay a container.

import { type JSX, useCallback } from 'react'
import { Box, Button, Stack } from '@mui/material'
import { QuestAccordion } from './QuestAccordion'
import type { SetItemCount } from './ItemOverrides'
import type { QuestProgress } from './useProgress'
import type { SharedItem, SharedItemsMap } from './sharedItems'
import { QUEST_PAGE, type QuestListState } from './useQuestList'
import type { MobTarget } from '../mobs/mobTarget'
/** The quest a deep link asked us to open, and the nonce that re-delivers the same ask twice. */
export interface QuestAnchor {
  key: string
  nonce: number
}

/**
 * Everything it takes to draw a list of quest rows. One interface because the Quests tab and the
 * Ready tab draw the SAME row (JOS-147's requirement) — the only thing that differs between them
 * is which quests go in, so `quests` is a parameter and the rest is shared verbatim.
 */
export interface QuestListProps {
  /** the rows to draw, already filtered and ordered by the caller */
  quests: QuestProgress[]
  list: QuestListState
  sharedItems: SharedItemsMap
  ambiguousNames: Set<string>
  /** the anchored quest, or null. Its accordion mounts EXPANDED and scrolls itself into view. */
  anchor: QuestAnchor | null
  recordTurnIn: (key: string) => Promise<void>
  undoTurnIn: (key: string) => Promise<void>
  /** correct one item's held count by hand (JOS-186) — the same bundle on both row-drawing tabs */
  setItemCount: (name: string, count: number | null) => Promise<void>
  onOpenMob: (t: MobTarget) => void
  onOpenLoot?: (item: string) => void
}

/**
 * THE BOTTOM OF THE LIST: how to see more of it, and how to stop (JOS-191).
 *
 * "Show more" is the page it always was. "Show all" beside it is the reporter's ask — they had
 * paged the whole list open, and every star, every drop and every turn-in threw it back to the
 * first page (the cause was `usePaging`'s reset key, fixed there). One click for the lot is the
 * affordance they thought they were using, and it is a STORED preference, so it holds across the
 * tab switch that unmounts this view and across a restart.
 *
 * SO THE OFF SWITCH LIVES HERE TOO, in the place the on switch was: a preference with no visible
 * way back is a trap, and the bottom of the list is where the user just clicked. It appears only
 * when the list is long enough for the cap to have meant something — under one page, "show fewer"
 * would draw exactly the same rows and read as a button that does nothing.
 */
function ListFooter({ total, list }: { total: number; list: QuestListState }): JSX.Element | null {
  if (list.showAll) {
    if (total <= QUEST_PAGE) return null
    return (
      <Box sx={{ textAlign: 'center', py: 1.5 }}>
        <Button size="small" data-testid="posky-show-fewer" onClick={() => list.setShowAll(false)}>
          Show fewer
        </Button>
      </Box>
    )
  }
  if (total <= list.visibleCount) return null
  return (
    <Stack direction="row" spacing={1} justifyContent="center" sx={{ py: 1.5 }}>
      <Button variant="outlined" size="small" data-testid="posky-show-more" onClick={list.showMore}>
        Show more ({total - list.visibleCount} more)
      </Button>
      <Button
        variant="outlined"
        size="small"
        data-testid="posky-show-all"
        title="Draw every quest, and keep drawing them - this is remembered"
        onClick={() => list.setShowAll(true)}
      >
        Show all ({total})
      </Button>
    </Stack>
  )
}

/**
 * The shared "this quest shares nothing" answer. A `?? []` written in the map would mint a new
 * array per row per render, which is a changed prop on a memoized row — the whole point of
 * JOS-206's first fix — for a quest that shares nothing with anything.
 */
const NO_SHARED_ITEMS: SharedItem[] = []

/**
 * The scrolling body: one accordion per quest up to the page cap, then the list footer.
 *
 * EVERY PROP THIS PASSES DOWN IS IDENTITY-STABLE ACROSS A KEYSTROKE (JOS-206), because
 * `QuestAccordion` is `memo`'d and a shallow comparison is only as good as what it is handed. The
 * two turn-in actions are the only ones that need wrapping — they are async, and the row wants a
 * `void` handler — so they are `useCallback`ed here rather than written inline in the map. The
 * rest are already stable at their source: `questFavorites.toggle` / `questIgnored.toggle` are
 * module-lifetime store methods, `setQuery` is a `useState` setter, `isFavorite` is pinned to the
 * favorites Set (useFavorites), and `onOpenMob`/`onOpenLoot` are App's memoized routers.
 */
export function QuestList({
  quests,
  list,
  sharedItems,
  ambiguousNames,
  anchor,
  recordTurnIn,
  undoTurnIn,
  setItemCount,
  onOpenMob,
  onOpenLoot
}: QuestListProps): JSX.Element {
  const onRecordTurnIn = useCallback(
    (questKey: string) => {
      void recordTurnIn(questKey)
    },
    [recordTurnIn]
  )
  const onUndoTurnIn = useCallback(
    (questKey: string) => {
      void undoTurnIn(questKey)
    },
    [undoTurnIn]
  )
  const onSetItemCount = useCallback<SetItemCount>(
    (name, count) => {
      void setItemCount(name, count)
    },
    [setItemCount]
  )
  return (
    <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
      {quests.slice(0, list.visibleCount).map((q) => (
        <QuestAccordion
          // The NONCE rides the key for the anchored quest alone: the accordion is uncontrolled
          // (each one opens and closes independently, and lifting that into one "which is open"
          // state would silently make the list single-open), so a remount is what lets a SECOND
          // link to the same quest re-open and re-scroll it.
          key={anchor?.key === q.key ? `${q.key}#${String(anchor.nonce)}` : q.key}
          anchored={anchor?.key === q.key}
          q={q}
          shared={sharedItems.get(q.key) ?? NO_SHARED_ITEMS}
          ambiguousNames={ambiguousNames}
          favorited={list.questFavorites.has(q.key)}
          onToggleFavorite={list.questFavorites.toggle}
          onToggleIgnore={list.questIgnored.toggle}
          isFavorite={list.isFavorite}
          toggleFavorite={list.toggleFavorite}
          onRecordTurnIn={onRecordTurnIn}
          onUndoTurnIn={onUndoTurnIn}
          onSetItemCount={onSetItemCount}
          onSelectQuest={list.setQuery}
          onOpenMob={onOpenMob}
          onOpenLoot={onOpenLoot}
        />
      ))}
      <ListFooter total={quests.length} list={list} />
    </Box>
  )
}
