// planner/FarmList.tsx — Farm mode: the rollup the whole feature exists for (design §5.4).
//
// "HERE IS WHERE TO GO AND WHAT TO CAMP." Every planned socket whose donor is not already
// extractable, grouped by the zone that feeds the most of them, so the biggest heading is
// literally the next trip worth making. The grouping arithmetic (primary zone, the "also" note,
// the four non-zone headings) lives in plannerFarm.ts; this file draws it.
//
// `ready` ROWS LEAVE THE LIST. A donor the log has already seen merged to its extraction tier is
// not something to farm, so it drops out — which means a finished set empties this pane, and the
// empty state says so in one line instead of pretending there is nothing planned.
//
// THE TIER MATH IS QUOTED, NEVER RECOMPUTED: `costText` reads `extractionCost`'s own fields
// (shared/planner/rules.ts). "≈15 D0 merges or 1 D4 drop" is the same sentence the item window
// would give you, because it is the same arithmetic.
//
// THE ERA TOGGLE IS SHARED WITH THE EFFECT BROWSER (one localStorage key, default ON). Out-of-era
// donors are HIDDEN rather than deleted from the plan — the count of what it hid is stated beside
// the toggle, because a rollup that silently drops half your set would be lying about the route.
// It also STEERS THE GROUPING (JOS-42): while it is on, a donor is filed under a zone you can
// actually reach, and its later-expansion zones drop to the "also:" tail chipped with their own
// expansion. `plannerFarm.groupNeeds` owns that rule; this file passes the toggle and draws it.
//
// THE BROWSER'S NON-EQUIPPABLE FILTER DELIBERATELY DOES NOT REACH HERE. That filter governs what
// you can PICK; this list is what you already picked. A slotless donor sitting in a plan (added
// before the rule was enforced, or from a set someone else built) still renders, chipped `no slot`
// so the reason it will not work is on screen — silently dropping planned work would leave a set
// that says it needs eight sockets and a route that mentions six.

import { type JSX, useMemo } from 'react'
import { Box, Chip, Paper, Stack, Typography } from '@mui/material'
import type { ClassAbbr } from '@shared/classCombo'
import { planSlotLabel, type ExaltPlan } from '@shared/planner/types'
import { Tooltip } from '../../lib/Tooltip'
import { DonorName, EraChip, MismatchChip, NoSlotChip, StateChip } from './PlannerChips'
import { classesMismatch } from './plannerClasses'
import { CURRENT_ERA_LABEL, eraHides, indexDonors, isNonEquippable, useDonors, useEraOnly } from './plannerData'
import {
  campText,
  collectNeeds,
  costText,
  groupNeeds,
  type FarmGroup,
  type FarmRow,
  type FarmZone
} from './plannerFarm'
import type { PlannerProgressApi } from './plannerProgress'

const KIND_HINT: Record<FarmGroup['kind'], string> = {
  zone: 'Donors whose best-known camp is in this zone.',
  quest: 'These come from a quest, not a camp.',
  crafted: 'These are made, not dropped.',
  unstated: 'The catalog states no home zone for these.',
  unknown: 'Nothing says where these come from.'
}

/**
 * The "also: …" tail — the donor's other camps. A zone from a LATER expansion carries its own
 * expansion name inline, because that is the whole difference between "another place you could
 * camp this" and "another place, once the server opens it". A zone the table cannot place says
 * nothing extra: an unplaceable name is a gap in our tables, not a claim about the game (law 1).
 */
function AlsoZones({ zones }: { zones: readonly FarmZone[] }): JSX.Element {
  return (
    <Typography
      variant="caption"
      noWrap
      data-testid="planner-farm-also"
      sx={{ display: 'block', color: 'text.disabled' }}
    >
      also:{' '}
      {zones.map((z, i) => (
        <Box key={z.name} component="span">
          {i > 0 && ', '}
          {z.name}
          {z.outOfEra && (
            <Box component="span" data-testid="planner-farm-also-era" sx={{ ml: 0.5, opacity: 0.85 }}>
              ({z.eraLabel})
            </Box>
          )}
        </Box>
      ))}
    </Typography>
  )
}

function Row({
  row,
  planClasses,
  onOpenLoot
}: {
  row: FarmRow
  /** the set's class FILTER — a planned donor outside it is chipped, never dropped (V2) */
  planClasses: readonly ClassAbbr[]
  onOpenLoot?: (item: string) => void
}): JSX.Element {
  const camp = campText(row)
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      data-testid="planner-farm-row"
      sx={{ flexWrap: 'nowrap', py: 0.5, px: 1, borderBottom: 1, borderColor: 'divider' }}
    >
      <Box sx={{ minWidth: 0, flexShrink: 1, width: 260 }}>
        <Typography variant="body2" component="div" noWrap sx={{ minWidth: 0 }}>
          <DonorName name={row.donorName} bold onOpen={onOpenLoot} />
        </Typography>
        <Typography variant="caption" noWrap sx={{ display: 'block', color: 'text.secondary' }}>
          {row.effect} · {planSlotLabel(row.slot)}
        </Typography>
      </Box>

      <Box sx={{ minWidth: 0, flexShrink: 1, width: 240 }}>
        <Typography variant="caption" noWrap sx={{ display: 'block' }}>
          {camp === '' ? '-' : camp}
        </Typography>
        {row.also.length > 0 && <AlsoZones zones={row.also} />}
      </Box>

      <Typography variant="caption" sx={{ color: 'text.secondary', flexShrink: 1, minWidth: 0 }}>
        {costText(row.tierRequired)}
      </Typography>
      <Box sx={{ flexGrow: 1, minWidth: 4 }} />
      {row.donor !== null && classesMismatch(row.donor.classes, planClasses) && (
        <MismatchChip classes={row.donor.classes} />
      )}
      {row.donor !== null && isNonEquippable(row.donor) && <NoSlotChip />}
      <EraChip subject={row.donor ?? { key: row.donorKey }} />
      <StateChip progress={row.progress} />
    </Stack>
  )
}

function Group({
  group,
  planClasses,
  onOpenLoot
}: {
  group: FarmGroup
  planClasses: readonly ClassAbbr[]
  onOpenLoot?: (item: string) => void
}): JSX.Element {
  return (
    <Paper
      variant="outlined"
      data-testid="planner-farm-group"
      data-out-of-era={group.zone?.outOfEra === true ? 'true' : 'false'}
      sx={{ mb: 1 }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{ px: 1, py: 0.75, bgcolor: 'action.hover', flexWrap: 'nowrap' }}
      >
        <Tooltip title={KIND_HINT[group.kind]}>
          <Typography variant="subtitle2" noWrap sx={{ minWidth: 0 }}>
            {group.title}
          </Typography>
        </Tooltip>
        {/* Only reachable with the era filter OFF — with it on, a heading is always a zone you can
            go to (JOS-42). Off, the heading is honest about what it is asking of you. */}
        {group.zone?.outOfEra === true && (
          <Chip
            size="small"
            color="warning"
            variant="outlined"
            label={group.zone.eraLabel}
            sx={{ height: 18, fontSize: 10, flexShrink: 0 }}
          />
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="caption" color="text.secondary">
          {group.rows.length} {group.rows.length === 1 ? 'donor' : 'donors'}
        </Typography>
      </Stack>
      {group.rows.map((row) => (
        <Row
          key={`${row.slot}:${row.socket}:${row.donorKey}`}
          row={row}
          planClasses={planClasses}
          onOpenLoot={onOpenLoot}
        />
      ))}
    </Paper>
  )
}

export interface FarmListProps {
  plan: ExaltPlan
  progress: PlannerProgressApi
  /** deep-link a donor into the Loot tab's item drill-down (App's `openLoot`) */
  onOpenLoot?: (item: string) => void
}

export default function FarmList({ plan, progress, onOpenLoot }: FarmListProps): JSX.Element {
  const { donors, ready } = useDonors()
  const [eraOnly, setEraOnly] = useEraOnly()
  const index = useMemo(() => indexDonors(donors), [donors])

  const { groups, hidden, outstanding } = useMemo(() => {
    const needs = collectNeeds(plan, index, progress.of).filter((n) => n.progress.state !== 'ready')
    const kept = needs.filter((n) => !eraHides(n.donor ?? { key: n.donorKey }, eraOnly))
    return {
      groups: groupNeeds(kept, { eraOnly }),
      hidden: needs.length - kept.length,
      outstanding: needs.length
    }
  }, [plan, index, progress, eraOnly])

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'nowrap', mb: 1 }}>
        <Tooltip title={`Hide donors whose only known sources are outside ${CURRENT_ERA_LABEL}.`}>
          <Chip
            size="small"
            label="Current era"
            data-testid="planner-era-toggle"
            color={eraOnly ? 'primary' : 'default'}
            variant={eraOnly ? 'filled' : 'outlined'}
            onClick={() => setEraOnly(!eraOnly)}
            sx={{ flexShrink: 0 }}
          />
        </Tooltip>
        {hidden > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
            {hidden} out of era, hidden
          </Typography>
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
          {outstanding} {outstanding === 1 ? 'socket' : 'sockets'} still to source
        </Typography>
      </Stack>

      <Box data-testid="planner-farm-list" sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto', pr: 0.5 }}>
        {groups.map((group) => (
          <Group
            key={`${group.kind}:${group.title}`}
            group={group}
            planClasses={plan.classes}
            onOpenLoot={onOpenLoot}
          />
        ))}
        {groups.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
            {!ready
              ? 'Reading the item database…'
              : outstanding === 0
                ? 'Nothing left to farm in this set - every planned donor is merged to its extraction tier, or nothing is planned yet.'
                : `Every planned donor in this set is out of ${CURRENT_ERA_LABEL}.`}
          </Typography>
        )}
      </Box>
    </Box>
  )
}
