// MobDropRow — the ITEM-facing half of the mob page (see MobPage.tsx for the page itself).
//
// ITEM NAMES ARE LIVE. Every one is a KnownItemTooltip anchor (hover = the EQ-style item window
// plus what it's for) AND clicks through to the loot tab's ItemDetailDialog. That second dialog
// needs the item's own loot history, so the loot module is subscribed inside a component that
// mounts only once an item is actually clicked — a mob page costs zero loot subscriptions until
// you drill into one of its drops.
//
// ONE LINE PER ITEM, VARIANTS ON DEMAND (JOS-196). What you looted arrives as one row per RAW
// name, so an item the mob has dropped as a base, a `+1` and a `+2` used to occupy three lines
// each claiming `1×`. The line now states the FOLDED fact — the combined count, and how often
// that works out to over your own recorded kills of this mob — with an affordance that opens the
// breakdown. `seenVariants.ts` owns the fold; this file only renders it. The drill-down follows
// the same distinction: the folded line opens the item's whole FAMILY, an expanded variant row
// opens that exact variant, and neither is a guess about which one you meant.

import { type JSX, useState } from 'react'
import { Box, Collapse, Stack, Typography } from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import type { LootSnap } from '@shared/types'
import { formatDate } from '../../lib/formatDate'
// The app's Tooltip, never MUI's — the anchor has to wear the hand (lib/Tooltip.tsx).
import { Tooltip } from '../../lib/Tooltip'
import { formatDropsPerKill } from '../../lib/formatRate'
import { itemCountKey } from '../../lib/itemName'
import { KnownItemTooltip } from '../../lib/KnownItemTooltip'
import { useModule } from '../../lib/useModule'
import { getPoskyData } from '../../data'
import { ItemDetailDialog } from '../loot/ItemDetailDialog'
// The app's ONE era chip, drawn from the app's ONE era verdict (JOS-377) — a drop row asks the
// same function the planner's donor rows and the gear browser's items ask, and asks it no
// differently for being on a mob page.
import { EraChip } from '../planner/PlannerChips'
import type { EraSubject } from '../planner/plannerData'
import { perceivedDropRate, type SeenVariantGroup } from './seenVariants'

// The Plane of Sky dataset, reused exactly as LootView reads it, so an item drilled into from a
// mob page gets the same "Plane of Sky" badge and offline stat blob it gets from the loot table.
const posky = getPoskyData()
// eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 8: PoskyQuest comes from a corpus still bundled in the renderer (mobs/posky/bosses JSON). Moves behind knowledge queries when that surface cuts over.
const questItemNames = new Set<string>(posky.quests.flatMap((q) => q.items.map((i) => itemCountKey(i.name))))
const itemStats: Record<string, string> = {}
for (const q of posky.quests) {
  for (const it of q.items) if (it.stats) itemStats[itemCountKey(it.name)] = it.stats
  if (q.reward && q.rewardStats) itemStats[itemCountKey(q.reward)] = q.rewardStats
}

/** What a click on an item name asks for: that exact name, or the whole `+N` family under it. */
export type OpenItem = (item: string, family?: boolean) => void

/** An item name, hoverable for the item window and clickable into its own loot history. */
function ItemName({
  name,
  onOpen,
  dim
}: {
  name: string
  onOpen: () => void
  dim?: boolean
}): JSX.Element {
  return (
    <KnownItemTooltip name={name}>
      <Box
        component="span"
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onOpen()
        }}
        sx={{
          color: dim ? 'text.secondary' : 'text.primary',
          fontSize: dim ? '0.8125rem' : undefined,
          cursor: 'pointer',
          textDecoration: 'underline dotted',
          textUnderlineOffset: 2,
          '&:hover': { color: 'primary.main' }
        }}
      >
        {name}
      </Box>
    </KnownItemTooltip>
  )
}

/**
 * What YOUR history says about this item: the folded count, the perceived rate when there are
 * recorded kills to divide by, and when you last saw one.
 *
 * The rate STATES ITS DENOMINATOR in the tooltip rather than hiding it, because a rate without
 * one is a claim rather than a measurement (JOS-78's rule, applied to the same page's other
 * number). With no recorded kills there is no rate at all — never a 0.
 */
function SeenNote({ seen, kills }: { seen: SeenVariantGroup; kills?: number }): JSX.Element {
  const rate = perceivedDropRate(seen.count, kills)
  return (
    <Typography variant="caption" sx={{ color: 'success.main', flexShrink: 0 }} data-testid="mob-drop-seen">
      seen by you: {seen.count}×
      {rate != null && (
        <Tooltip
          title={`${seen.count} looted over ${kills?.toLocaleString() ?? 0} kills of this mob that this character recorded - your own history, not a published drop rate`}
        >
          <Box component="span"> · {formatDropsPerKill(rate)}</Box>
        </Tooltip>
      )}{' '}
      · last {formatDate(seen.lastTs)}
    </Typography>
  )
}

/** The affordance: how many spellings folded into this line, and the toggle that opens them. */
function VariantToggle({
  count,
  open,
  onToggle
}: {
  count: number
  open: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <Tooltip title={open ? 'Hide the +N variants' : 'Show each +N variant separately'}>
      <Stack
        direction="row"
        alignItems="center"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onToggle()
        }}
        data-testid="mob-drop-variants-toggle"
        sx={{ flexShrink: 0, cursor: 'pointer', color: 'text.secondary', '&:hover': { color: 'primary.main' } }}
      >
        <Typography variant="caption">
          {count} variant{count === 1 ? '' : 's'}
        </Typography>
        <ExpandMoreIcon
          fontSize="inherit"
          sx={{ transition: 'transform 120ms', transform: open ? 'rotate(180deg)' : undefined }}
        />
      </Stack>
    </Tooltip>
  )
}

/** The breakdown: one line per raw spelling, in upgrade order, each its own drill-down. */
function VariantList({ seen, onOpenItem }: { seen: SeenVariantGroup; onOpenItem: OpenItem }): JSX.Element {
  return (
    <Box sx={{ pl: 2, borderLeft: 1, borderColor: 'divider', ml: 0.5, mb: 0.3 }}>
      {seen.variants.map((v) => (
        <Stack
          key={v.item}
          direction="row"
          spacing={1}
          alignItems="baseline"
          sx={{ py: 0.1, minWidth: 0 }}
          data-testid="mob-drop-variant"
        >
          <ItemName name={v.item} dim onOpen={() => onOpenItem(v.item)} />
          <Box sx={{ flexGrow: 1 }} />
          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
            {v.count}× · last {formatDate(v.lastTs)}
          </Typography>
        </Stack>
      ))}
    </Box>
  )
}

/**
 * ONE drop row: the item name (hoverable + clickable), whatever the page said about how often
 * it drops, and — when your own history corroborates it — how many you've had, how often that
 * is per kill, and when. A row whose history folded `+N` variants together carries the toggle
 * that opens them; one whose history is a single unvarianted loot carries nothing extra.
 */
export function DropRow({
  item,
  rarity,
  era,
  seen,
  kills,
  onOpenItem
}: {
  item: string
  rarity?: string
  /**
   * WHAT THE WIKI SAYS ABOUT THIS ITEM'S ERA (JOS-377) — the subject, never a verdict: `EraChip`
   * asks `eraChip` the same way the planner's rows and the gear browser's do. Absent on the rows
   * that have no era question to answer (the "also looted by you" block is YOUR history).
   */
  era?: EraSubject
  seen?: SeenVariantGroup
  /** your recorded kills of THIS mob — the perceived rate's denominator, absent when unknown */
  kills?: number
  onOpenItem: OpenItem
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const foldable = seen?.hasVariants === true
  return (
    <Box sx={{ py: 0.2, minWidth: 0 }} data-testid="mob-drop-row">
      <Stack direction="row" spacing={1} alignItems="baseline" sx={{ minWidth: 0 }}>
        <ItemName name={item} onOpen={() => onOpenItem(item, foldable)} />
        {era && <EraChip subject={era} />}
        {rarity && (
          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
            {rarity}
          </Typography>
        )}
        <Box sx={{ flexGrow: 1 }} />
        {seen && <SeenNote seen={seen} kills={kills} />}
        {foldable && seen && (
          <VariantToggle count={seen.variants.length} open={open} onToggle={() => setOpen(!open)} />
        )}
      </Stack>
      {foldable && seen && (
        <Collapse in={open} unmountOnExit>
          <VariantList seen={seen} onOpenItem={onOpenItem} />
        </Collapse>
      )}
    </Box>
  )
}

/**
 * The nested item drill-down. Mounted ONLY once an item name is clicked, which is what keeps
 * the mob page free of the loot module's full history until it is actually needed.
 *
 * `family` follows what was clicked (JOS-196): a FOLDED line is a statement about every `+N`
 * spelling at once, so its dialog lists them all — otherwise clicking a line that says `3×`
 * would open a history holding one event, or none at all when every loot was an upgrade. An
 * expanded variant row asks for that exact name and gets exactly it.
 */
export function ItemDrillDown({
  item,
  family,
  onClose
}: {
  item: string
  family?: boolean
  onClose: () => void
}): JSX.Element {
  const history = useModule<LootSnap>('loot')
  const key = itemCountKey(item)
  const matches = family
    ? (e: { item: string }): boolean => itemCountKey(e.item) === key
    : (e: { item: string }): boolean => e.item.toLowerCase() === item.toLowerCase()
  return (
    <ItemDetailDialog
      open
      onClose={onClose}
      item={item}
      // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives LootEvent. Becomes a view descriptor when the source lands.
      events={(history ?? []).filter(matches)}
      stats={itemStats[key]}
      isQuestItem={questItemNames.has(key)}
    />
  )
}
