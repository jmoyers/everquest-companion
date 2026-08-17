// MobDropsSection — the two DROP BLOCKS of the mob page, and the derivation behind them.
//
// Split out of MobPage.tsx when the era fold (JOS-377) pushed that file past the repo's measured
// `max-lines 400` factoring ceiling. The seam is the one the page's own section banners already
// drew: MobPage keeps the PAGE (identity, the tally strip, quests, kills, provenance), this file
// keeps everything that answers "what does it drop", and MobDropRow.tsx keeps one row of it.
//
// THE TABLE IS READ AGAINST THE ERA THE SERVER IS ON (JOS-377). The wiki's own mob page transcludes
// `{{:Item}}` per row and each row draws its OUT OF ERA pill from the item page; this page rendered
// the catalog's list straight through, so Cazic Thule offered the seven-item Fear revamp table as
// loot you could go and get. Now:
//   OUT     - behind a "+7 out of era" disclosure, each row inside it wearing the chip.
//   IN      - plainly.
//   UNKNOWN - plainly. Never hidden: the wiki says the mob drops it and nothing says it is gone.
// NOTHING IS DELETED. "The wiki lists it" and "it is not in era" are two facts and both stay
// sayable (law 1), which is why this is a disclosure and not a filter.
//
// ONE VERDICT: the split and the chip both come from `./dropEra.ts`, which is a thin call into the
// app's single era join (`features/planner/plannerData.ts` -> `shared/planner/era.ts`). No era rule
// is stated in this file or in the page above it.

import { type JSX, useState } from 'react'
import { Box, CircularProgress, Collapse, Divider, Stack, Typography } from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import type { MobDrop, MobKnowledge } from '@shared/types'
import { itemCountKey } from '../../lib/itemName'
import { dropEraSubject, outOfEraLabel, splitDropsByEra } from './dropEra'
import { DropRow, type OpenItem } from './MobDropRow'
import { foldSeenVariants, type SeenVariantGroup } from './seenVariants'

/** A quiet, honest empty note — never a claim that a source said "nothing". */
export function Quiet({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <Typography variant="caption" color="text.disabled" display="block">
      {children}
    </Typography>
  )
}

/**
 * What we say when the drop table is empty. Three DIFFERENT facts, never collapsed into one:
 * the lookup is still running, the wiki has no page, we could not reach the wiki, or the page
 * exists and genuinely lists no loot.
 */
function DropsEmptyState({
  data,
  loading
}: {
  data: MobKnowledge | null
  loading: boolean
}): JSX.Element {
  return (
    <Box sx={{ mb: 2 }}>
      {loading && !data && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ color: 'text.secondary' }}>
          <CircularProgress size={14} />
          <Typography variant="caption">Looking up this mob…</Typography>
        </Stack>
      )}
      {data?.notFound && <Quiet>No wiki page for this mob.</Quiet>}
      {data?.offline && <Quiet>Offline - showing only what&apos;s known locally.</Quiet>}
      {data && !data.notFound && !data.offline && data.page && (
        <Quiet>The wiki page for this mob lists no loot.</Quiet>
      )}
    </Box>
  )
}

/** One block of drop rows, each carrying its own era subject. Used twice: shown, then folded. */
function DropRows({
  drops,
  seenByKey,
  kills,
  onOpenItem
}: {
  drops: MobDrop[]
  seenByKey: Map<string, SeenVariantGroup>
  kills?: number
  onOpenItem: OpenItem
}): JSX.Element {
  return (
    <>
      {drops.map((d) => (
        <DropRow
          key={d.item}
          item={d.item}
          rarity={d.rarity}
          era={dropEraSubject(d)}
          seen={seenByKey.get(itemCountKey(d.item))}
          kills={kills}
          onOpenItem={onOpenItem}
        />
      ))}
    </>
  )
}

/**
 * THE DISCLOSURE (JOS-377) — "+7 out of era", and the rows behind it.
 *
 * IT IS A DISCLOSURE AND NOT A DELETION, which is the whole shape of the fix: the wiki lists these
 * items on this mob's page and that stays sayable, while the default answer to "what does this
 * drop" stops including a table the server does not run. One click is the whole cost of the other
 * fact (law 1), and each row behind it wears the chip that says which one it is.
 */
function OutOfEraDrops({
  drops,
  seenByKey,
  kills,
  onOpenItem
}: {
  drops: MobDrop[]
  seenByKey: Map<string, SeenVariantGroup>
  kills?: number
  onOpenItem: OpenItem
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (drops.length === 0) return null
  return (
    <Box>
      <Stack
        direction="row"
        alignItems="center"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setOpen(!open)
        }}
        data-testid="mob-drops-era-toggle"
        sx={{
          display: 'inline-flex',
          cursor: 'pointer',
          color: 'text.secondary',
          '&:hover': { color: 'primary.main' }
        }}
      >
        <Typography variant="caption">{outOfEraLabel(drops.length)}</Typography>
        <ExpandMoreIcon
          fontSize="inherit"
          sx={{ transition: 'transform 120ms', transform: open ? 'rotate(180deg)' : undefined }}
        />
      </Stack>
      <Collapse in={open} unmountOnExit>
        <DropRows drops={drops} seenByKey={seenByKey} kills={kills} onOpenItem={onOpenItem} />
      </Collapse>
    </Box>
  )
}

/** ---- 1. DROPS (definitive) ---- */
export function DropsSection({
  wiki,
  outOfEra,
  seenByKey,
  kills,
  data,
  loading,
  onOpenItem
}: {
  /** in-era and unknown, in page order — what the page answers with. */
  wiki: MobDrop[]
  /** positively out of era — folded, never dropped. */
  outOfEra: MobDrop[]
  seenByKey: Map<string, SeenVariantGroup>
  kills?: number
  data: MobKnowledge | null
  loading: boolean
  onOpenItem: OpenItem
}): JSX.Element {
  return (
    <>
      <Typography variant="subtitle2" gutterBottom>
        Drops{' '}
        <Typography component="span" variant="caption" color="text.secondary">
          (wiki drop table){wiki.length > 0 && ` · ${wiki.length}`}
        </Typography>
      </Typography>
      {/* The DISJUNCTION matters: a mob whose whole table is out of era has a drop list, and
          saying "its wiki page lists no loot" about it would be a new lie replacing the old one. */}
      {wiki.length > 0 || outOfEra.length > 0 ? (
        <Box sx={{ mb: 2 }}>
          <DropRows drops={wiki} seenByKey={seenByKey} kills={kills} onOpenItem={onOpenItem} />
          <OutOfEraDrops
            drops={outOfEra}
            seenByKey={seenByKey}
            kills={kills}
            onOpenItem={onOpenItem}
          />
        </Box>
      ) : (
        <DropsEmptyState data={data} loading={loading} />
      )}
    </>
  )
}

/** ---- 2. ALSO LOOTED BY YOU (corroboration the page doesn't list) ---- */
export function AlsoLootedSection({
  extraSeen,
  kills,
  onOpenItem
}: {
  extraSeen: SeenVariantGroup[]
  kills?: number
  onOpenItem: OpenItem
}): JSX.Element | null {
  if (extraSeen.length === 0) return null
  return (
    <>
      <Divider sx={{ my: 1.5 }} />
      <Typography variant="subtitle2" gutterBottom>
        Also looted by you{' '}
        <Typography component="span" variant="caption" color="text.secondary">
          (not listed on the wiki page)
        </Typography>
      </Typography>
      <Box sx={{ mb: 2 }}>
        {extraSeen.map((d) => (
          <DropRow key={d.key} item={d.item} seen={d} kills={kills} onOpenItem={onOpenItem} />
        ))}
      </Box>
    </>
  )
}

/**
 * The two drop sections' whole input, derived ONCE from the record (JOS-196).
 *
 * `lines` is your history folded to one line per item (`+N` variants included), `byKey` is that
 * same set addressed by counting key so a wiki row can annotate itself, and `extra` is what no
 * wiki row claimed. The membership test is the COUNTING key: an upgrade of a listed item belongs
 * to that item's row, not to a second section reporting it as loot the page never mentioned.
 *
 * THE ERA SPLIT IS PART OF THE DERIVATION, not of the rendering (JOS-377), so the tally strip's
 * count and the list itself read ONE answer. Membership of "also looted by you" is decided against
 * the WHOLE table, folded rows included: an out-of-era item you somehow have is still an item this
 * page lists, and reporting it as a find the wiki failed to mention would be the same lie inverted.
 */
export function dropSections(data: MobKnowledge | null): {
  wiki: MobDrop[]
  outOfEra: MobDrop[]
  lines: SeenVariantGroup[]
  byKey: Map<string, SeenVariantGroup>
  extra: SeenVariantGroup[]
} {
  const { shown, out } = splitDropsByEra(data?.dropsWiki ?? [])
  const lines = foldSeenVariants(data?.dropsSeen ?? [])
  const wikiKeys = new Set([...shown, ...out].map((d) => itemCountKey(d.item)))
  return {
    wiki: shown,
    outOfEra: out,
    lines,
    byKey: new Map(lines.map((g) => [g.key, g])),
    extra: lines.filter((g) => !wikiKeys.has(g.key))
  }
}
