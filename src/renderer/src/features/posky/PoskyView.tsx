import { type JSX, useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Chip, Collapse, Fab, Snackbar, Stack, Tab, Tabs, Typography } from '@mui/material'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp'
import StarIcon from '@mui/icons-material/Star'
import type { CountSource } from '@shared/types'
import { useProgress, type QuestProgress } from './useProgress'
// The `/outputfile` freshness line (JOS-44), wired to the registry: this tab's have/need chips
// read the same dump the Exaltations tab does, so they get the same one-line treatment — the
// command, one clause of why, and the FILE's own age (or "not yet run").
import OutputKindLine from '../../components/OutputKindLine'
import type { SharedItemsMap } from './sharedItems'
import { QuestIgnoreButton } from '../favorites/QuestFlagButtons'
import { QuestAccordion } from './QuestAccordion'
import QuestFilterBar from './QuestFilterBar'
import { useQuestList, type QuestListState, type TabKey } from './useQuestList'
import type { MobTarget } from '../mobs/mobTarget'
import Confetti from '../../lib/Confetti'
import { Tooltip } from '../../lib/Tooltip'

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
        No ignored quests — hide one with the eye icon on its row and it lands here.
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
            {q.completed && <Chip size="small" color="success" variant="outlined" label="Turned in" />}
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
        Every quest is ignored — the Ignored tab can bring them back.
      </Typography>
    )
  }
  return (
    <Typography variant="body2" color="text.secondary">
      {filteredCount} of {totalQuests} quests · counting from{' '}
      {countSource === 'log' ? 'looted log' : countSource === 'inventory' ? 'inventory export' : 'log + inventory'}
    </Typography>
  )
}

/** The quest a deep link asked us to open, and the nonce that re-delivers the same ask twice. */
interface QuestAnchor {
  key: string
  nonce: number
}

function FavoritesHeader({
  count,
  open,
  onToggle
}: {
  count: number
  open: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <Button
      data-testid="posky-favorites-toggle"
      fullWidth
      color="warning"
      startIcon={<StarIcon />}
      endIcon={open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
      aria-expanded={open}
      onClick={onToggle}
      sx={{
        position: 'sticky',
        top: 0,
        zIndex: 2,
        justifyContent: 'flex-start',
        bgcolor: 'background.paper',
        borderBottom: 1,
        borderColor: 'divider',
        borderRadius: 0,
        '&:hover': { bgcolor: 'background.paper' }
      }}
    >
      Favorites ({count})
    </Button>
  )
}

function ScrollToTop({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <Tooltip title="Scroll to top">
      <Fab
        data-testid="posky-scroll-top"
        size="small"
        color="primary"
        aria-label="Scroll to top"
        onClick={onClick}
        sx={{ position: 'absolute', right: 16, bottom: 16, zIndex: 3 }}
      >
        <KeyboardArrowUpIcon />
      </Fab>
    </Tooltip>
  )
}

// The scrolling body: one accordion per quest up to the page cap, then the "show more" button.
function QuestList({
  list,
  sharedItems,
  ambiguousNames,
  anchor,
  setQuestComplete,
  onOpenMob,
  onOpenLoot
}: {
  list: QuestListState
  sharedItems: SharedItemsMap
  ambiguousNames: Set<string>
  /** the anchored quest, or null. It becomes the controlled open row and scrolls into view. */
  anchor: QuestAnchor | null
  setQuestComplete: (key: string, complete: boolean) => Promise<void>
  onOpenMob: (t: MobTarget) => void
  onOpenLoot?: (item: string) => void
}): JSX.Element {
  // The list owns the one open key: opening a row replaces it, while closing that row returns
  // to no selection. A deep link is an external request to make its quest the open row.
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [favoritesOpen, setFavoritesOpen] = useState(true)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Preserve the selected comparator inside BOTH groups. Group membership is presentation, not a
  // second sort: a quest star, or a still-needed starred item, places the quest in Favorites.
  const favoriteQuests = list.filtered.filter(
    (q) =>
      list.questFavorites.has(q.key) ||
      (!q.completed && q.items.some((item) => list.isFavorite(item.name)))
  )
  const favoriteKeys = new Set(favoriteQuests.map((q) => q.key))
  const regularQuests = list.filtered.filter((q) => !favoriteKeys.has(q.key))
  const anchorIsFavorite = anchor !== null && favoriteKeys.has(anchor.key)
  useEffect(() => {
    if (!anchor) return
    setExpandedKey(anchor.key)
    if (anchorIsFavorite) setFavoritesOpen(true)
  }, [anchor, anchorIsFavorite])

  const toggleFavorites = (): void => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    setFavoritesOpen(!favoritesOpen)
  }

  const renderQuest = (q: QuestProgress): JSX.Element => (
    <QuestAccordion
      key={q.key}
      expanded={expandedKey === q.key}
      onExpandedChange={(nextExpanded) => setExpandedKey(nextExpanded ? q.key : null)}
      // The nonce lets a second link to the same already-open quest scroll it into view again.
      anchorNonce={anchor?.key === q.key ? anchor.nonce : undefined}
      q={q}
      shared={sharedItems.get(q.key) ?? []}
      ambiguousNames={ambiguousNames}
      favorited={list.questFavorites.has(q.key)}
      onToggleFavorite={() => list.questFavorites.toggle(q.key)}
      onToggleIgnore={() => list.questIgnored.toggle(q.key)}
      isFavorite={list.isFavorite}
      toggleFavorite={list.toggleFavorite}
      onSetComplete={(complete) => void setQuestComplete(q.key, complete)}
      onSelectQuest={(name) => list.setQuery(name)}
      onOpenMob={onOpenMob}
      onOpenLoot={onOpenLoot}
    />
  )

  return (
    <Box sx={{ flexGrow: 1, minHeight: 0, position: 'relative' }}>
      <Box
        ref={scrollRef}
        data-testid="posky-quest-scroll"
        onScroll={(event) => setShowScrollTop(event.currentTarget.scrollTop > 0)}
        sx={{ height: '100%', overflow: 'auto' }}
      >
        {favoriteQuests.length > 0 && (
          <>
            <FavoritesHeader
              count={favoriteQuests.length}
              open={favoritesOpen}
              onToggle={toggleFavorites}
            />
            <Collapse in={favoritesOpen}>
              <Box data-testid="posky-favorites-section" sx={{ mb: 1 }}>
                {favoriteQuests.map(renderQuest)}
              </Box>
            </Collapse>
          </>
        )}
        <Box data-testid="posky-regular-section">
          {regularQuests.slice(0, list.visibleCount).map(renderQuest)}
        </Box>
        {regularQuests.length > list.visibleCount && (
          <Box sx={{ textAlign: 'center', py: 1.5 }}>
            <Button variant="outlined" size="small" onClick={list.showMore}>
              Show more ({regularQuests.length - list.visibleCount} more)
            </Button>
          </Box>
        )}
      </Box>
      {showScrollTop && (
        <ScrollToTop onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })} />
      )}
    </Box>
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
    setQuestComplete,
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

  return (
    <Stack spacing={2} sx={{ height: '100%', position: 'relative' }}>
      {burst != null && <Confetti key={burst} onDone={() => setBurst(null)} />}
      <Tabs
        value={list.tab}
        onChange={(_e, v: TabKey) => list.setTab(v)}
        sx={{ minHeight: 36, mb: -1, '& .MuiTab-root': { minHeight: 36, py: 0 } }}
      >
        <Tab value="quests" label="Quests" />
        <Tab value="ignored" label={list.ignored.length ? `Ignored (${list.ignored.length})` : 'Ignored'} />
      </Tabs>
      {list.tab === 'ignored' ? (
        <IgnoredList quests={list.ignored} onUnignore={list.questIgnored.toggle} />
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
          <QuestList
            list={list}
            sharedItems={sharedItems}
            ambiguousNames={ambiguousQuestNames}
            anchor={anchor}
            setQuestComplete={setQuestComplete}
            onOpenMob={onOpenMob}
            onOpenLoot={onOpenLoot}
          />
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
