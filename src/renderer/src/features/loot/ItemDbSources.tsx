// loot/ItemDbSources.tsx — "where does this item come from?", answered from the committed DBs
// rather than from what you personally happened to loot.
//
// WHY IT EXISTS (owner, 2026-08-04). The drill-down's "Dropped by" and "Seen in zones" columns are
// built from OBSERVED loot events, which is the right primary answer — it is YOUR history, with
// counts nothing else can give. But it is the ONLY answer the pane had, so an item you have never
// looted read "No source recorded" — including an item the Planner had, two clicks earlier, told
// you drops off a named mob in a named zone. The pane contradicted the app.
//
// TWO WITNESSES, MERGED, LABELLED `db`:
//   1. THE MOB CATALOG, inverted (`lib/itemSources`) — every mob page's `|known_loot`, read
//      backwards. This is the one that carries level text.
//   2. THE ITEM PAGE'S OWN `|dropsfrom` (`ItemKnowledge.dropsFrom`), which arrives on the record
//      the drill-down already fetches, so it costs no second request.
// They omit different things in both directions, so neither replaces the other; `mergeItemSources`
// states the fold rule (catalog row wins whole on a case-folded mob match) and lib/ owns it
// because the planner's Farm rollup performs the identical merge for the identical reason.
//
// `db` VS `observed` IS THE HOUSE CHIP CONVENTION (AGENTS.md UI conventions; the buffs pane's
// duration provenance is the precedent). The two families sit side by side and never blend: a
// zone the catalog names is not a zone you have been to, and a mob you looted twice is not a
// claim about drop rates. Each says which it is.
//
// NOTHING HERE FETCHES. The catalog index is a lazy renderer-side singleton built once per window
// (~33k links); the item page's half rides on the knowledge record the pane already has. An item
// neither witness knows renders the honest sentence rather than nothing at all (law 1).

import { type JSX, useEffect, useMemo } from 'react'
import { Box, Chip, Stack, Typography } from '@mui/material'
import type { ItemKnowledge } from '@shared/types'
import type { ZoneShort } from '@shared/maps'
import { mergeItemSources, sourceIndex, sourceItemKey, sourcesFor, type ItemSource } from '../../lib/itemSources'
import { Tooltip } from '../../lib/Tooltip'
import { CellLink } from '../../lib/CellLink'
// The drop trio's doors (gear/dropLinks.ts). These columns are the SAME merged sources the Gear
// tab's Zone/Level/Mob cells draw — an item opened FROM a gear row must not be where those links
// stop working — so the names open the same surfaces by the same refuse-over-guess rules.
import { dropMobTarget, dropZoneTarget } from '../gear/dropLinks'
import type { MobTarget } from '../mobs/mobTarget'

/**
 * How many source rows are drawn before the rest collapse into a count. A handful of common
 * components drop off well over a hundred mobs, and this pane is a drill-down, not a bestiary —
 * the standing list law asks for a bounded DOM, and the honest "+N more" keeps the total visible.
 */
const MAX_ROWS = 50

/** Fixed height, its own scrollbar — a growing list never grows the page (AGENTS.md). */
const LIST_SX = { maxHeight: 220, overflowY: 'auto', pr: 0.5 } as const

const DB_HINT = 'What the wiki says drops it, not what you have seen.'

/** The `db` provenance chip. Same vocabulary the buffs pane uses for `db` vs `observed`. */
export function DbChip(): JSX.Element {
  return (
    <Tooltip title={DB_HINT}>
      <Chip size="small" variant="outlined" label="db" data-testid="loot-db-chip" sx={{ height: 18, fontSize: 10 }} />
    </Tooltip>
  )
}

/** The `observed` provenance chip — its twin, worn by the columns built from your loot events. */
export function ObservedChip(): JSX.Element {
  return (
    <Tooltip title="What you have actually seen drop.">
      <Chip size="small" variant="outlined" label="observed" sx={{ height: 18, fontSize: 10 }} />
    </Tooltip>
  )
}

/** zone → how many distinct known sources drop this item there, most first, ties alphabetical. */
function zoneTally(sources: readonly ItemSource[]): { zone: string; mobs: number }[] {
  const counts = new Map<string, number>()
  for (const s of sources) {
    for (const zone of new Set(s.zones)) counts.set(zone, (counts.get(zone) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([zone, mobs]) => ({ zone, mobs }))
    .sort((a, b) => b.mobs - a.mobs || a.zone.localeCompare(b.zone))
}

/** A zone spelling that resolves to a map opens it; the refused ones stay the text they were. */
function ZoneName({ zone, onOpenMapZone }: { zone: string; onOpenMapZone?: OpenMapZone }): JSX.Element {
  const stem = onOpenMapZone === undefined ? null : dropZoneTarget(zone)
  if (stem === null || onOpenMapZone === undefined) return <>{zone}</>
  return <CellLink text={zone} onOpen={() => { onOpenMapZone(stem) }} />
}

/** One known source: the mob, its level text VERBATIM when stated, and where it lives. */
function SourceRow({
  source,
  onOpenMob,
  onOpenMapZone
}: {
  source: ItemSource
  onOpenMob?: OpenMob
  onOpenMapZone?: OpenMapZone
}): JSX.Element {
  return (
    <Box data-testid="loot-db-source" sx={{ py: 0.25 }}>
      <Typography variant="caption" sx={{ display: 'block' }}>
        {onOpenMob === undefined ? (
          source.mob
        ) : (
          <CellLink text={source.mob} onOpen={() => { onOpenMob(dropMobTarget(source.mob, source.mobPage ?? '')) }} />
        )}
        {source.levelText != null && (
          <Box component="span" sx={{ color: 'text.disabled' }}> · lvl {source.levelText}</Box>
        )}
      </Typography>
      {source.zones.length > 0 && (
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
          {source.zones.map((z, i) => (
            <Box key={z} component="span">
              {i > 0 && ', '}
              <ZoneName zone={z} onOpenMapZone={onOpenMapZone} />
            </Box>
          ))}
        </Typography>
      )}
    </Box>
  )
}

function SectionHead({ title }: { title: string }): JSX.Element {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }}>
      <Typography variant="subtitle2">{title}</Typography>
      <DbChip />
    </Stack>
  )
}

function DropsFromColumn({
  sources,
  onOpenMob,
  onOpenMapZone
}: {
  sources: readonly ItemSource[]
  onOpenMob?: OpenMob
  onOpenMapZone?: OpenMapZone
}): JSX.Element {
  const shown = sources.slice(0, MAX_ROWS)
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <SectionHead title="Drops from" />
      {sources.length === 0 && (
        <Typography variant="caption" color="text.secondary">
          The mob catalog and this item’s page name no mob for it.
        </Typography>
      )}
      <Box sx={LIST_SX}>
        {shown.map((s) => (
          <SourceRow key={`${s.mobPage ?? ''}:${s.mob}`} source={s} onOpenMob={onOpenMob} onOpenMapZone={onOpenMapZone} />
        ))}
      </Box>
      {sources.length > shown.length && (
        <Typography variant="caption" color="text.disabled">
          +{sources.length - shown.length} more of {sources.length}
        </Typography>
      )}
    </Box>
  )
}

function DbZonesColumn({
  zones,
  onOpenMapZone
}: {
  zones: { zone: string; mobs: number }[]
  onOpenMapZone?: OpenMapZone
}): JSX.Element {
  const shown = zones.slice(0, MAX_ROWS)
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <SectionHead title="Zones" />
      {zones.length === 0 && (
        <Typography variant="caption" color="text.secondary">
          No zone is stated for any known source.
        </Typography>
      )}
      <Box sx={LIST_SX}>
        {shown.map((z) => (
          <Typography key={z.zone} variant="caption" data-testid="loot-db-zone" sx={{ display: 'block', py: 0.25 }}>
            <ZoneName zone={z.zone} onOpenMapZone={onOpenMapZone} />
            <Box component="span" sx={{ color: 'text.disabled' }}>
              {' '}
              · {z.mobs} {z.mobs === 1 ? 'mob' : 'mobs'}
            </Box>
          </Typography>
        ))}
      </Box>
      {zones.length > shown.length && (
        <Typography variant="caption" color="text.disabled">
          +{zones.length - shown.length} more
        </Typography>
      )}
    </Box>
  )
}

/** The two routes out, by their `appRouting` names. Optional everywhere: absent means plain text. */
type OpenMob = ((t: MobTarget) => void) | undefined
type OpenMapZone = ((zone: ZoneShort) => void) | undefined

export interface ItemDbSourcesProps {
  /** the item's DISPLAY name — keyed through `sourceItemKey`, never used raw */
  item: string
  /** the knowledge record the drill-down already fetched; null while it is in flight */
  knowledge: ItemKnowledge | null
  /** a source mob's door to its page (App's `openMob`); absent, the plain text it was */
  onOpenMob?: (t: MobTarget) => void
  /** a stated zone's door to the Maps tab (App's `openMapZone`); absent, plain text */
  onOpenMapZone?: (zone: ZoneShort) => void
}

/**
 * The `db` half of "where does this come from" — always rendered, so a never-looted item still
 * gets a real answer, and an item nothing knows still gets an honest one.
 */
export function ItemDbSources({ item, knowledge, onOpenMob, onOpenMapZone }: ItemDbSourcesProps): JSX.Element {
  // Warm the catalog inversion AFTER mount, never on the render path: the first column to ask
  // would otherwise pay the whole ~33k-link build inside a paint.
  useEffect(() => {
    sourceIndex()
  }, [])

  const sources = useMemo(
    () => mergeItemSources(sourcesFor(sourceItemKey(item)), knowledge?.dropsFrom),
    [item, knowledge]
  )
  const zones = useMemo(() => zoneTally(sources), [sources])

  return (
    <Box data-testid="loot-db-sources" sx={{ mt: 2 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3}>
        <DropsFromColumn sources={sources} onOpenMob={onOpenMob} onOpenMapZone={onOpenMapZone} />
        <DbZonesColumn zones={zones} onOpenMapZone={onOpenMapZone} />
      </Stack>
    </Box>
  )
}
