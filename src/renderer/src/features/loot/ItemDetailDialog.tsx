import { type JSX, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Paper,
  Stack,
  Typography
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import type { ItemKnowledge, LootEvent } from '@shared/types'
import type { Timeslice } from '@shared/timeslice'
import { isAcquisition } from '@shared/lootDisposition'
import { formatDate } from '../../lib/formatDate'
import { EQ_ITEM_COLORS } from '../../lib/ItemWindow'
import { ObservedItemWindow } from '../../lib/ObservedItemWindow'
import { ItemDbSources, ObservedChip } from './ItemDbSources'
import { ItemZoneTable } from './ItemZoneTable'
import { KnowledgeSection } from './KnowledgeSection'
import { useItemZoneRates, type ItemZoneRates } from './useItemZoneRates'

/**
 * "What it's for" knowledge (Task #53): fetch this item's lore/quest knowledge when the
 * dialog opens. Local-posky-first + cached in main, so a known item resolves instantly;
 * a fresh wiki lookup shows a quiet loading state. Never throws (main degrades to a
 * cached-negative / offline record). Re-runs when the item changes.
 */
interface ItemKnowledgeState {
  data: ItemKnowledge | null
  loading: boolean
}

function useItemKnowledge(item: string, open: boolean): ItemKnowledgeState {
  const [data, setData] = useState<ItemKnowledge | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open) return
    let alive = true
    setData(null)
    setLoading(true)
    void window.eq
      .lookupItem(item)
      .then((k) => {
        if (alive) setData(k)
      })
      .catch(() => {
        /* main never rejects; guard anyway */
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [item, open])
  return { data, loading }
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }): JSX.Element {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, flex: 1, minWidth: 120 }}>
      <Typography variant="h5" sx={{ color: 'primary.main', lineHeight: 1.1 }}>
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      {hint && (
        <Typography variant="caption" color="text.disabled" display="block">
          {hint}
        </Typography>
      )}
    </Paper>
  )
}

function Bar({
  label,
  value,
  max,
  right
}: {
  label: string
  value: number
  max: number
  right: string
}): JSX.Element {
  const pct = max > 0 ? (value / max) * 100 : 0
  return (
    <Box sx={{ mb: 0.75 }}>
      <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.25 }}>
        <Typography variant="caption" noWrap sx={{ maxWidth: 220 }}>
          {label}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {right}
        </Typography>
      </Stack>
      <Box sx={{ height: 8, bgcolor: 'action.hover', borderRadius: 1 }}>
        <Box sx={{ height: 8, width: `${pct}%`, bgcolor: 'secondary.main', borderRadius: 1 }} />
      </Box>
    </Box>
  )
}

interface TimelineBins {
  counts: number[]
  from: number
  to: number
}

function Timeline({ events }: { events: LootEvent[] }): JSX.Element {
  const bins = useMemo<TimelineBins>(() => {
    const ts = events.map((e) => e.ts).filter(Boolean)
    if (ts.length === 0) return { counts: [], from: 0, to: 0 }
    const from = Math.min(...ts)
    const to = Math.max(...ts)
    const N = 32
    const span = Math.max(1, to - from)
    const counts = new Array<number>(N).fill(0)
    for (const t of ts) counts[Math.min(N - 1, Math.floor(((t - from) / span) * (N - 1)))]++
    return { counts, from, to }
  }, [events])

  if (bins.counts.length === 0) return <Typography variant="caption">No dated loot events.</Typography>
  const max = Math.max(...bins.counts, 1)
  const W = 640
  const H = 60
  const bw = W / bins.counts.length
  const fmt = (ms: number): string => formatDate(ms)
  return (
    <Box>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
        {bins.counts.map((c, i) => {
          const h = (c / max) * (H - 4)
          return (
            <rect
              key={i}
              x={i * bw + 1}
              y={H - h}
              width={bw - 2}
              height={h}
              fill="var(--mui-palette-primary-main, #d9b25f)"
              opacity={c ? 0.9 : 0.15}
            />
          )
        })}
      </svg>
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="caption" color="text.secondary">
          {fmt(bins.from)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {fmt(bins.to)}
        </Typography>
      </Stack>
    </Box>
  )
}

interface LootTally {
  name: string
  count: number
}

interface LootBreakdown {
  sources: LootTally[]
  zones: LootTally[]
}

// Who dropped it and where, most-seen first. A loot row with no `source` still counts —
// it happened — so it tallies under `unknown` rather than vanishing from the breakdown.
function aggregateLoot(events: LootEvent[]): LootBreakdown {
  const bySource = new Map<string, number>()
  const byZone = new Map<string, number>()
  for (const e of events) {
    const s = e.source ?? 'unknown'
    bySource.set(s, (bySource.get(s) ?? 0) + 1)
    if (e.zone) byZone.set(e.zone, (byZone.get(e.zone) ?? 0) + 1)
  }
  const sources = [...bySource.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
  const zones = [...byZone.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  return { sources, zones }
}

/* The item as the GAME shows it: wiki base data, drawn in the item-window language.
   `stats` (posky's scraped block) is the offline fallback when the wiki lookup hasn't
   structured one yet. */
function ItemWindowColumn({
  item,
  stats,
  knowledge
}: {
  item: string
  stats?: string
  knowledge: ItemKnowledgeState
}): JSX.Element {
  return (
    <Box sx={{ width: { xs: '100%', md: 340 }, flexShrink: 0 }}>
      <ObservedItemWindow
        name={item}
        stats={knowledge.data?.stats}
        rawStats={stats ?? knowledge.data?.statsBlock}
        iconId={knowledge.data?.iconId}
        flavor={knowledge.data?.summary}
      />
      {knowledge.loading && !knowledge.data && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1, color: 'text.secondary' }}>
          <CircularProgress size={14} />
          <Typography variant="caption">Looking up this item…</Typography>
        </Stack>
      )}
    </Box>
  )
}

/* The observed columns are YOUR loot history — chipped `observed` since 2026-08-04, because the
   `db` columns below them answer the same question from the committed wiki data and the two must
   never read as one list. "You have never looted this" is now a statement about you, not about
   the item. */
function ObservedHead({ title, hint }: { title: string; hint?: string }): JSX.Element {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }}>
      <Typography variant="subtitle2">{title}</Typography>
      {hint !== undefined && (
        <Typography component="span" variant="caption" color="text.secondary">
          {hint}
        </Typography>
      )}
      <ObservedChip />
    </Stack>
  )
}

function DroppedByColumn({ sources, max }: { sources: LootTally[]; max: number }): JSX.Element {
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <ObservedHead title="Dropped by" hint="(times seen)" />
      {sources.length === 0 && <Typography variant="caption">You have not looted this yet.</Typography>}
      {sources.map((s) => (
        <Bar key={s.name} label={s.name} value={s.count} max={max} right={`${s.count}× seen`} />
      ))}
    </Box>
  )
}

/* Everything BELOW/BESIDE the game block is OUR knowledge — what the live log and the local
   dataset add that the in-game window can't tell you.

   TWO PROVENANCES, IN ORDER. Your own history comes first (it is the only one with counts, and it
   is what you came here for), then the committed DBs' answer to the same question, chipped `db`.
   The second half is why a never-looted item is worth opening at all — a Planner donor deep-links
   straight here, and "No source recorded" would contradict the row that sent you. */
function ObservedColumn({
  events,
  agg,
  knowledge,
  item,
  zoneRates,
  owned
}: {
  events: LootEvent[]
  agg: LootBreakdown
  knowledge: ItemKnowledgeState
  item: string
  zoneRates: ItemZoneRates
  owned?: number
}): JSX.Element {
  return (
    <Box sx={{ flex: 1, minWidth: 0, width: '100%' }}>
      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        {/* TWO WITNESSES, EACH LABELLED WITH WHO SAID IT (JOS-160). "Times looted" counts loot
            lines and is honest to the LOG; "In your inventory export" is what the last
            `/outputfile inventory` vouched for and is honest to the DUMP. They disagree all the
            time and that is fine — an item acquired before this log exists reads 0 looted and 3
            held, which is the true state of affairs and precisely what this page used to hide
            behind a bare "Times looted 0". */}
        <StatCard label="Times looted" value={String(events.length)} />
        {owned !== undefined && owned > 0 && (
          <StatCard label="In your inventory export" value={String(owned)} hint="from /outputfile inventory" />
        )}
        <StatCard label="Distinct mobs" value={String(agg.sources.length)} />
        <StatCard label="Zones seen" value={String(agg.zones.length)} />
      </Stack>

      {/* "What it's for" (Task #53) — quest knowledge. Local posky + cached wiki. */}
      <KnowledgeSection data={knowledge.data} loading={knowledge.loading} />

      {/* WHO drops it beside WHERE — and the where half is a RATE now (JOS-78), because a zone's
          count alone cannot tell eleven-in-an-evening from eleven-over-a-fortnight. */}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3}>
        <DroppedByColumn sources={agg.sources} max={agg.sources[0]?.count ?? 1} />
        <ItemZoneTable rows={zoneRates.rows} clipped={zoneRates.clipped} looted={events.length > 0} />
      </Stack>

      <ItemDbSources item={item} knowledge={knowledge.data} />

      <Divider sx={{ my: 2 }} />
      <Typography variant="subtitle2" gutterBottom>
        Looted over time
      </Typography>
      <Timeline events={events} />
    </Box>
  )
}

export interface ItemDetailProps {
  item: string
  events: LootEvent[]
  stats?: string
  isQuestItem: boolean
  /**
   * The timeslice the caller's `events` were already cut to (JOS-130), so the per-zone rates
   * divide by the SAME stretch those drops were counted over. Absent ⇒ the whole record, which is
   * what this drill-down has always measured and what the Mobs tab's dialog still wants: it opens
   * over a page that has no slice control, and a rate quietly measured over somebody else's
   * window is worse than a rate over all of it.
   */
  slice?: Timeslice
  /**
   * How many copies the loaded `/outputfile inventory` export vouches for on this item's counting
   * key (JOS-160). Absent — or 0 — renders NOTHING: a dump only covers what was open when it was
   * written (JOS-141), so its silence about an item is not a claim that you have none, and a
   * confident "0 held" would be a fabricated answer. The Mobs tab's dialog, which has no reconcile
   * to hand, simply omits it.
   */
  owned?: number
}

/**
 * THE ITEM DRILL-DOWN ITSELF, chrome-free — the game's item window beside everything the live
 * log adds to it.
 *
 * Split out of the dialog (2026-08-04) because the Loot tab retired its popover for a PANE
 * TAKEOVER with a breadcrumb (`ItemDetailPane`), while the Mobs tab's drop rows still open the
 * same drill-down as a dialog over a page they must not lose. Two chromes, ONE body: a second
 * copy would drift the moment either surface gained a section.
 *
 * `active` gates the knowledge fetch. The dialog passes its own `open` (a closed dialog stays
 * mounted); the pane passes true, because a pane that is rendered IS the screen.
 */
export function ItemDetailContent({
  item,
  events,
  stats,
  active,
  slice,
  owned
}: Omit<ItemDetailProps, 'isQuestItem'> & { active: boolean }): JSX.Element {
  /**
   * EVERY NUMBER BELOW IS ABOUT LOOTING, so the destroys come out here (JOS-401, the census).
   * `Times looted`, `Distinct mobs`, `Zones seen`, the mob breakdown, the per-zone rates and the
   * "Looted over time" histogram would each be wrong in the same way otherwise: a destroy names no
   * mob (it would tally under `unknown`), it is not a drop, and it happened in your bags.
   *
   * The filter is HERE rather than at the two call sites (`LootView`'s pane takeover and the Mobs
   * tab's dialog) precisely because there are two of them and a third would inherit the answer.
   */
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives LootEvent. Becomes a view descriptor when the source lands.
  const looted = useMemo(() => events.filter(isAcquisition), [events])
  const agg = useMemo(() => aggregateLoot(looted), [looted])
  const knowledge = useItemKnowledge(item, active)
  // The per-zone RATES (JOS-78). Its own hook because it joins a SECOND module — the progression
  // snapshot, for the active-time denominators — and that join is the one thing on this surface
  // that is not simply a fold of `events`.
  const zoneRates = useItemZoneRates(looted, slice)
  return (
    <Stack direction={{ xs: 'column', md: 'row' }} spacing={2.5} alignItems="flex-start">
      <ItemWindowColumn item={item} stats={stats} knowledge={knowledge} />
      <ObservedColumn
        events={looted}
        agg={agg}
        knowledge={knowledge}
        item={item}
        zoneRates={zoneRates}
        owned={owned}
      />
    </Stack>
  )
}

export function ItemDetailDialog({
  open,
  onClose,
  item,
  events,
  stats,
  isQuestItem
}: ItemDetailProps & { open: boolean; onClose: () => void }): JSX.Element {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ pr: 6 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Box component="span" sx={{ color: EQ_ITEM_COLORS.name }}>
            {item}
          </Box>
          {isQuestItem && <Chip size="small" color="primary" variant="outlined" label="Plane of Sky" />}
        </Stack>
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <ItemDetailContent item={item} events={events} stats={stats} active={open} />
      </DialogContent>
    </Dialog>
  )
}
