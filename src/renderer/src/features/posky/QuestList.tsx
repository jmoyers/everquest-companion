// QuestList — the scrolling Plane of Sky quest rows and their paging/scroll affordances.
//
// Split from PoskyView when JOS-191's stored Show all footer and the return-to-top control pushed
// the container past the measured file ceiling. PoskyView still owns tab/navigation state; this
// file owns only drawing and scrolling the same rows shared by the Quests and Ready tabs.

import { type JSX, useRef, useState } from 'react'
import { Box, Button, IconButton, Stack } from '@mui/material'
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp'
import type { SharedItemsMap } from './sharedItems'
import { QuestAccordion } from './QuestAccordion'
import { QUEST_PAGE, type QuestListState } from './useQuestList'
import type { QuestProgress } from './useProgress'
import type { MobTarget } from '../mobs/mobTarget'

/** The quest a deep link asked us to open, and the nonce that re-delivers the same ask twice. */
export interface QuestAnchor {
  key: string
  nonce: number
}

export interface QuestListProps {
  /** the rows to draw, already filtered and ordered by the caller */
  quests: QuestProgress[]
  list: QuestListState
  sharedItems: SharedItemsMap
  ambiguousNames: Set<string>
  /** the anchored quest, or null. Its accordion mounts expanded and scrolls itself into view. */
  anchor: QuestAnchor | null
  recordTurnIn: (key: string) => Promise<void>
  undoTurnIn: (key: string) => Promise<void>
  onOpenMob: (t: MobTarget) => void
  onOpenLoot?: (item: string) => void
}

/** JOS-191's stored Show all switch and its paging/off affordances. */
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

export function QuestList({
  quests,
  list,
  sharedItems,
  ambiguousNames,
  anchor,
  recordTurnIn,
  undoTurnIn,
  onOpenMob,
  onOpenLoot
}: QuestListProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showScrollTop, setShowScrollTop] = useState(false)

  return (
    <Box sx={{ flexGrow: 1, minHeight: 0, position: 'relative' }}>
      <Box
        ref={scrollRef}
        data-testid="posky-quest-scroll"
        onScroll={(event) => setShowScrollTop(event.currentTarget.scrollTop > 0)}
        sx={{ height: '100%', overflow: 'auto' }}
      >
        {quests.slice(0, list.visibleCount).map((q) => (
          <QuestAccordion
            // The nonce remounts this uncontrolled row, so the same deep link reopens it without
            // closing any other quest the user chose to leave expanded.
            key={anchor?.key === q.key ? `${q.key}#${String(anchor.nonce)}` : q.key}
            anchored={anchor?.key === q.key}
            q={q}
            shared={sharedItems.get(q.key) ?? []}
            ambiguousNames={ambiguousNames}
            favorited={list.questFavorites.has(q.key)}
            onToggleFavorite={() => list.questFavorites.toggle(q.key)}
            onToggleIgnore={() => list.questIgnored.toggle(q.key)}
            isFavorite={list.isFavorite}
            toggleFavorite={list.toggleFavorite}
            onRecordTurnIn={() => void recordTurnIn(q.key)}
            onUndoTurnIn={() => void undoTurnIn(q.key)}
            onSelectQuest={(name) => list.setQuery(name)}
            onOpenMob={onOpenMob}
            onOpenLoot={onOpenLoot}
          />
        ))}
        <ListFooter total={quests.length} list={list} />
      </Box>
      {showScrollTop && (
        <IconButton
          title="Scroll to top"
          aria-label="Scroll to top"
          data-testid="posky-scroll-top"
          onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
          sx={{
            position: 'absolute',
            right: 16,
            bottom: 16,
            zIndex: 1,
            bgcolor: 'background.paper',
            boxShadow: 3,
            '&:hover': { bgcolor: 'action.hover' }
          }}
        >
          <KeyboardArrowUpIcon />
        </IconButton>
      )}
    </Box>
  )
}
