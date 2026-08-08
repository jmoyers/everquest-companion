// QuestAccordion — ONE Plane of Sky quest, as the Quests tab draws it (see PoskyView.tsx).
//
// Its own file because it is the bulk of that tab: a collapsed summary row that has to answer
// "how close am I, and is anything else competing for these drops?" at a glance, and an expanded
// panel that spells out every required item with who drops it and where. PoskyView owns the
// filtering, sorting and paging; everything below owns the drawing of a single quest.
//
// ITEM NAMES LINK TO THE LOOT DRILL-DOWN (owner, 2026-08-04): "clicking on a sky item while you
// are hovering should take you to the item drill-down page." The hover card is unchanged — it is
// still `ItemTooltip`, the compact game-window popover — and the click is the app's standing link
// idiom (`openLoot`, appRouting.ts), the same one the Planner's donor names now use.
//
// WHICH NAMES, AND WHY NOT ALL OF THEM. The two names that had NO click before become links: the
// item name in the expanded table, and the reward caption in the summary row. The required-item
// CHIPS in the summary row keep their existing click, which toggles the favorite star — that is a
// documented affordance with no other home, and quietly replacing it would trade one deep link for
// one lost feature. A summary-row link stops propagation, because the row it sits in is the
// accordion's own expand control.

import { type JSX, useEffect, useRef } from 'react'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Checkbox,
  Chip,
  FormControlLabel,
  LinearProgress,
  Link,
  Stack,
  Typography
} from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked'
import StarIcon from '@mui/icons-material/Star'
import LinkIcon from '@mui/icons-material/Link'
import { Tooltip } from '../../lib/Tooltip'
import { skyQuestPage, wikiPageUrl } from '@shared/wiki'
import type { QuestProgress } from './useProgress'
import { ItemTooltip } from './ItemTooltip'
import { ItemNameLink, QuestItemsTable } from './QuestItemsTable'
import { KillTargetCaption } from './DropperCell'
import { questKillTargets, type KillTarget } from './poskyDroppers'
import type { MobTarget } from '../mobs/mobTarget'
import { sharingQuestLabel, type SharedItem, type SharingQuest } from './sharedItems'
import { QuestIgnoreButton, QuestStarButton } from '../favorites/QuestFlagButtons'
import { questIsland, questIslands } from './questSort'

// Wiki URLs are built in ONE place (src/shared/wiki.ts) — the verified root-path convention.
function wikiClassPage(className: string): string | undefined {
  return wikiPageUrl(skyQuestPage(className))
}

function ProgressBar({ q }: { q: QuestProgress }): JSX.Element {
  const pct = Math.round(q.ratio * 100)
  const color = q.completed ? 'success' : pct === 0 ? 'inherit' : pct >= 100 ? 'success' : 'primary'
  return (
    <Box sx={{ minWidth: 160 }}>
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="caption" color="text.secondary">
          {q.completed ? 'Turned in' : `${q.haveCount}/${q.needCount} items`}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {pct}%
        </Typography>
      </Stack>
      <LinearProgress variant="determinate" value={Math.min(100, pct)} color={color} />
    </Box>
  )
}

/**
 * One contending quest, as a chip you can hover for ITS reward (2026-08-04).
 *
 * The section answers "who else wants this drop"; the hover answers "and what do they get for
 * it" — the other half of deciding where a single looted claw should go. Same surface as every
 * other item hover in this tab (ItemTooltip → the game's item-window language), so a reward and
 * a turn-in item read identically.
 *
 * A quest the wiki lists no reward for gets NO tooltip — a bare chip, not an empty card. The
 * `data-reward` attribute is that decision, readable: it states what the chip believes it pays,
 * so "no reward ⇒ no tooltip" can be asserted from outside instead of inferred.
 */
function SharingQuestChip({
  sq,
  ambiguousNames,
  onSelectQuest
}: {
  sq: SharingQuest
  ambiguousNames: Set<string>
  onSelectQuest: (name: string) => void
}): JSX.Element {
  const chip = (
    <Chip
      size="small"
      variant="outlined"
      color="info"
      data-testid="posky-shared-quest"
      data-reward={sq.reward ?? ''}
      label={sharingQuestLabel(sq, ambiguousNames)}
      onClick={() => onSelectQuest(sq.name)}
      sx={{ height: 20, fontSize: 11 }}
    />
  )
  if (!sq.reward) return chip
  return (
    <ItemTooltip name={sq.reward} stats={sq.rewardStats} where={`Reward for ${sq.className} · ${sq.name}`}>
      {chip}
    </ItemTooltip>
  )
}

// "Shared items with" (Task #44): a compact, dense section listing each of this
// quest's required items that ANOTHER Plane of Sky quest also needs — so before
// turning in you can see who else is contending for a drop. Currency (Wind Runes) is
// excluded upstream in the derivation.
function SharedItemsSection({
  shared,
  ambiguousNames,
  onSelectQuest
}: {
  shared: SharedItem[]
  ambiguousNames: Set<string>
  onSelectQuest: (name: string) => void
}): JSX.Element {
  return (
    <Box sx={{ mb: 1 }}>
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }}>
        <LinkIcon sx={{ fontSize: 15, color: 'text.secondary' }} />
        <Typography variant="caption" color="text.secondary">
          Shared items — other Sky quests contending for these drops
        </Typography>
      </Stack>
      <Stack spacing={0.5}>
        {shared.map((si) => (
          <Stack key={si.key} direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="caption" sx={{ fontWeight: 600, minWidth: 150 }}>
              {si.name}
            </Typography>
            {si.quests.map((sq) => (
              <SharingQuestChip
                key={sq.key}
                sq={sq}
                ambiguousNames={ambiguousNames}
                onSelectQuest={onSelectQuest}
              />
            ))}
          </Stack>
        ))}
      </Stack>
    </Box>
  )
}

// The collapsed header line: flags, class/primary island, name/reward/giver/kill target, the
// contested-items count, the ready/missing chip and the progress bar.
function QuestSummaryRow({
  q,
  primaryIsland,
  killTargets,
  sharedCount,
  favorited,
  onToggleFavorite,
  onToggleIgnore,
  onOpenLoot
}: {
  q: QuestProgress
  primaryIsland?: number
  killTargets: KillTarget[]
  sharedCount: number
  favorited: boolean
  onToggleFavorite: () => void
  onToggleIgnore: () => void
  onOpenLoot?: (item: string) => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={2} alignItems="center">
      {/* Star + ignore lead every row, always visible — the quest-level
          controls the user could not find when the only star lived on an
          item row inside the expanded panel. */}
      <Stack direction="row" alignItems="center" sx={{ minWidth: 48 }}>
        <QuestStarButton favorited={favorited} onToggle={onToggleFavorite} />
        <QuestIgnoreButton ignored={false} onToggle={onToggleIgnore} />
      </Stack>
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ width: 160, flexShrink: 0 }}>
        <Chip label={q.className} size="small" color="secondary" variant="outlined" sx={{ minWidth: 92 }} />
        {primaryIsland !== undefined && (
          <Chip
            data-testid="posky-primary-island-badge"
            label={`Island ${primaryIsland}`}
            size="small"
            variant="outlined"
            sx={{ height: 22, fontSize: 11 }}
          />
        )}
      </Stack>
      <Box sx={{ minWidth: 220 }}>
        <Typography variant="subtitle2">{q.name}</Typography>
        {q.reward && (
          <ItemTooltip name={q.reward} stats={q.rewardStats}>
            <Typography variant="caption" color="primary.main">
              → <ItemNameLink name={q.reward} onOpenLoot={onOpenLoot} inSummary />
            </Typography>
          </ItemTooltip>
        )}
        {q.giver && (
          <Typography variant="caption" color="text.secondary" display="block">
            Turn in → {q.giver}
          </Typography>
        )}
        {/* Variable-height box already (reward and giver are each optional), so a third
            caption line costs the row nothing it wasn't already prepared to pay. */}
        <KillTargetCaption targets={killTargets} />
      </Box>
      <Box sx={{ flexGrow: 1 }} />
      {sharedCount > 0 && (
        <Tooltip
          title={`Shares ${sharedCount} item${sharedCount === 1 ? '' : 's'} with other Sky quests — expand for details`}
        >
          <Chip
            size="small"
            variant="outlined"
            color="info"
            icon={<LinkIcon />}
            label={sharedCount}
            sx={{ height: 20, fontSize: 11, '& .MuiChip-icon': { fontSize: 14 } }}
          />
        </Tooltip>
      )}
      {q.completed ? (
        <Chip size="small" color="success" variant="outlined" label="Turned in" />
      ) : (
        <Chip
          size="small"
          variant="outlined"
          color={q.missing.length === 0 ? 'success' : 'default'}
          label={q.missing.length === 0 ? 'Ready to turn in' : `${q.missing.length} of ${q.items.length} missing`}
        />
      )}
      <ProgressBar q={q} />
    </Stack>
  )
}

// The second summary line: every required item as a chip, favorites first, each one a
// click-to-favorite toggle that must NOT also expand the accordion (hence stopPropagation).
function QuestItemChips({
  q,
  isFavorite,
  toggleFavorite
}: {
  q: QuestProgress
  isFavorite: (name: string) => boolean
  toggleFavorite: (name: string) => void
}): JSX.Element {
  return (
    // Indent tracks the header's leading columns (buttons + stable class/island badge group).
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ pl: '232px' }}>
      {[...q.items]
        .sort((a, b) => Number(isFavorite(b.name)) - Number(isFavorite(a.name)))
        .map((it) => {
          const done = it.have >= it.need || q.completed
          const fav = isFavorite(it.name)
          return (
            <ItemTooltip
              key={it.name}
              name={it.name}
              stats={it.stats}
              who={it.who}
              where={it.where}
              droppers={it.droppers}
            >
              <Chip
                size="small"
                variant={fav ? 'filled' : 'outlined'}
                color={fav ? 'warning' : done ? 'success' : 'default'}
                icon={
                  fav ? (
                    <StarIcon />
                  ) : done ? (
                    <CheckCircleIcon />
                  ) : (
                    <RadioButtonUncheckedIcon />
                  )
                }
                onClick={(e) => {
                  e.stopPropagation()
                  toggleFavorite(it.name)
                }}
                label={it.need > 1 ? `${it.name} ${it.have}/${it.need}` : it.name}
                sx={{ opacity: done && !fav ? 0.65 : 1 }}
              />
            </ItemTooltip>
          )
        })}
    </Stack>
  )
}

// The expanded panel's top strip: rune / giver / wiki link, and the manual "turned in" checkbox.
function QuestDetailsToolbar({
  q,
  wikiHref,
  onSetComplete
}: {
  q: QuestProgress
  wikiHref?: string
  onSetComplete: (complete: boolean) => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={2} sx={{ mb: 1 }} alignItems="center" flexWrap="wrap" useFlexGap>
      {q.rune && <Chip size="small" label={`Rune: ${q.rune}`} />}
      {q.giver && <Chip size="small" label={`Giver: ${q.giver}`} />}
      {wikiHref && (
        <Link href={wikiHref} target="_blank" rel="noreferrer" variant="caption">
          wiki: {q.className} Plane of Sky Tests
        </Link>
      )}
      <Box sx={{ flexGrow: 1 }} />
      <FormControlLabel
        control={<Checkbox checked={q.completed} onChange={(e) => onSetComplete(e.target.checked)} />}
        label="Turned in / complete"
      />
    </Stack>
  )
}

export function QuestAccordion({
  q,
  shared,
  ambiguousNames,
  favorited,
  onToggleFavorite,
  onToggleIgnore,
  isFavorite,
  toggleFavorite,
  onSetComplete,
  onSelectQuest,
  onOpenMob,
  onOpenLoot,
  expanded,
  onExpandedChange,
  anchorNonce
}: {
  q: QuestProgress
  shared: SharedItem[]
  ambiguousNames: Set<string>
  favorited: boolean
  onToggleFavorite: () => void
  onToggleIgnore: () => void
  isFavorite: (name: string) => boolean
  toggleFavorite: (name: string) => void
  onSetComplete: (complete: boolean) => void
  onSelectQuest: (name: string) => void
  /** a dropper name → the Mobs tab's page for that catalog row (App-level routing) */
  onOpenMob: (t: MobTarget) => void
  /** an item name → the Loot tab's drill-down for it (App-level routing, `openLoot`) */
  onOpenLoot?: (item: string) => void
  /** controlled by the list so opening this quest closes the previously open quest */
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  /**
   * A deep link landed on THIS quest (a celebration toast's reward card,
   * docs/plans/celebration-toasts.md T6). The nonce changes on every delivery, including two
   * consecutive links to the same quest, so each request can scroll into view.
   */
  anchorNonce?: number
}): JSX.Element {
  const wikiHref = wikiClassPage(q.className)
  // A turned-in quest has nothing left to kill for, whatever its item counts say.
  const killTargets = q.completed ? [] : questKillTargets(q.items)
  const ref = useRef<HTMLDivElement>(null)
  const anchored = anchorNonce !== undefined
  const primaryIsland = questIsland(q)
  useEffect(() => {
    // `block: 'nearest'` scrolls the enclosing list only as far as it must, so a quest already on
    // screen does not jump under the user. Wait until it is open so its final height is in layout.
    if (anchored && expanded) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [anchorNonce, anchored, expanded])
  return (
    <Accordion
      disableGutters
      ref={ref}
      expanded={expanded}
      onChange={(_event, nextExpanded) => onExpandedChange(nextExpanded)}
      data-anchored={anchored || undefined}
      data-testid="posky-quest"
      data-islands={questIslands(q).join(',')}
      data-primary-island={primaryIsland}
      sx={{
        // A quiet tonal fill marks the open quest as the selected block without introducing a
        // second outline or competing with the gold/green progress states inside it.
        '&.Mui-expanded': { backgroundColor: 'action.hover' },
        // MUI normally trades these two hairlines for expanded-row gutters. This list disables
        // those gutters, so keep its existing dividers visible instead of leaving no boundary.
        '&.Mui-expanded::before': { opacity: 1 },
        '&.Mui-expanded + .MuiAccordion-root::before': { display: 'block' },
        // A group's final row has no next accordion to supply that lower hairline (Favorites is
        // its own collapsible group), so close only that edge with one ordinary divider.
        '&.Mui-expanded:last-child': { borderBottom: 1, borderColor: 'divider' }
      }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack spacing={0.75} sx={{ width: '100%', pr: 2 }}>
          <QuestSummaryRow
            q={q}
            primaryIsland={primaryIsland}
            killTargets={killTargets}
            sharedCount={shared.length}
            favorited={favorited}
            onToggleFavorite={onToggleFavorite}
            onToggleIgnore={onToggleIgnore}
            onOpenLoot={onOpenLoot}
          />
          <QuestItemChips q={q} isFavorite={isFavorite} toggleFavorite={toggleFavorite} />
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <QuestDetailsToolbar q={q} wikiHref={wikiHref} onSetComplete={onSetComplete} />
        {q.rewardStats && (
          <Typography variant="caption" color="text.secondary" component="pre" sx={{ whiteSpace: 'pre-wrap', mb: 1 }}>
            {q.rewardStats}
          </Typography>
        )}
        {shared.length > 0 && (
          <SharedItemsSection shared={shared} ambiguousNames={ambiguousNames} onSelectQuest={onSelectQuest} />
        )}
        <QuestItemsTable
          q={q}
          isFavorite={isFavorite}
          toggleFavorite={toggleFavorite}
          onOpenMob={onOpenMob}
          onOpenLoot={onOpenLoot}
        />
      </AccordionDetails>
    </Accordion>
  )
}
