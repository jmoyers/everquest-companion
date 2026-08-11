// planner/EffectRows.tsx — THE TWO ROWS THE EFFECT BROWSER DRAWS: a group header, and a donor.
//
// Split out of `EffectBrowser.tsx` when JOS-42's readability work pushed that file past the
// measured 400-code-line ceiling, and this is the seam the ceiling was pointing at — the same one
// PlanCell was split from PlanBoard on. The browser owns the PIPELINE (fetch, filter, group,
// window) and the shell; this file owns what one row of that pipeline looks like. Both rows are
// exactly `ROW_HEIGHT` tall, because `useWindowedRows` is a fixed-row-height hook and a header is
// a ROW rather than a container (EffectBrowser's own header explains why that shape exists).
//
// A ROW IS A COMPACT BAR, and the flexWrap law governs it (AGENTS.md): `nowrap`, controls that
// never shrink, and world-supplied text in shrinkable ellipsizing groups. `SHRINK` is the whole of
// the arbitration between those groups, and it is half of the JOS-42 fix — the other half is the
// one-liner moving up to the header, which is `plannerGroups.says` and arrives here as a flag.

import { type JSX } from 'react'
import { Box, Button, Chip, IconButton, Stack, Typography } from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import type { ClassAbbr } from '@shared/classCombo'
import { effectOneLiner } from '@shared/planner/effectText'
import { extractionTier } from '@shared/planner/rules'
import { itemIconUrl } from '../../lib/ItemWindow'
import { Tooltip } from '../../lib/Tooltip'
import { classFit, isNonEquippable, type DonorRow } from './plannerData'
import { SOCKET_LABEL, type DonorGroup } from './plannerGroups'
import { BestChip, DonorName, EraChip, NoSlotChip } from './PlannerChips'
import { sourcesFor } from './sourceIndex'

/** Every row in the list is this tall — the windowing hook's whole contract. */
export const ROW_HEIGHT = 44
/** How many class chips fit on a dense row before the rest collapse into "+N". */
const CLASS_CHIP_CAP = 6

/**
 * HOW A ROW GIVES WIDTH BACK, IN ONE PLACE (JOS-42 refinement 2).
 *
 * `flex-shrink` is WEIGHTED BY BASE WIDTH, so these are ratios rather than an order: the source
 * line and the effect's one-liner (each ~300px base × 30) absorb the deficit long before the donor
 * NAME (×3) gives up a pixel. That is the owner's rule — the names have ellipsis priority over the
 * source text, not the other way round.
 *
 * THE EFFECT NAME IS THE ONE GROUP THAT DOES NOT SHRINK AT ALL, and it took a measurement to earn
 * that. Ratios alone were not enough: a weight of 1 against 30 still hands the effect ~1.4% of any
 * deficit, and the e2e caught "Percussion Resonance 14" clipped by those few pixels on the one
 * focus family in the whole corpus whose ranks disagree — so its rows keep their own one-liner and
 * the row is at its most crowded. `flexShrink: 0` is what makes "the effect name always reads" a
 * property rather than a tendency. It is BOUNDED by `EFFECT_MAX_WIDTH` so a pathological corpus
 * entry cannot push the row's controls off the end: past that it ellipsizes like anything else,
 * and the compact-bar contract (nowrap PLUS shrinkable groups) still holds through the other three.
 */
const SHRINK = { name: 3, says: 30, source: 30 }
/** Enough for every effect name the corpus states; a cap, not a size. */
const EFFECT_MAX_WIDTH = '34%'

// ---- one donor's source line ---------------------------------------------------------

interface SourceText {
  text: string
  /** "+3 more" when the catalog knows other mobs; empty when it doesn't */
  more: string
}

/**
 * What the catalog knows about where this donor comes from, in one line. The FIRST source plus a
 * count — a 40-mob drop list belongs in Farm mode, not on a dense row.
 */
function sourceText(donor: DonorRow): SourceText {
  const sources = sourcesFor(donor.key)
  const first = sources[0]
  if (first) {
    const zone = first.zones[0] ?? 'zone unstated'
    return { text: `${first.mob} - ${zone}`, more: sources.length > 1 ? `+${String(sources.length - 1)} more` : '' }
  }
  if (donor.quest) return { text: 'quest reward', more: '' }
  if (donor.playerCrafted) return { text: 'player crafted', more: '' }
  return { text: 'no known source', more: '' }
}

// ---- one donor row -------------------------------------------------------------------

function ClassChips({ donor, planClasses }: { donor: DonorRow; planClasses: readonly ClassAbbr[] }): JSX.Element {
  const fit = classFit(donor, planClasses)
  if (fit === 'unknown') {
    return <Chip size="small" variant="outlined" label="class unknown" sx={{ height: 18, fontSize: 10 }} />
  }
  const lit = donor.classes.filter((c) => planClasses.includes(c))
  const rest = donor.classes.filter((c) => !planClasses.includes(c))
  const shown = [...lit, ...rest].slice(0, CLASS_CHIP_CAP)
  return (
    <Stack direction="row" spacing={0.25} sx={{ flexShrink: 0 }}>
      {shown.map((c) => (
        <Chip
          key={c}
          size="small"
          label={c}
          color={lit.includes(c) ? 'primary' : 'default'}
          variant={lit.includes(c) ? 'filled' : 'outlined'}
          sx={{ height: 18, fontSize: 10, '& .MuiChip-label': { px: 0.5 } }}
        />
      ))}
      {donor.classes.length > CLASS_CHIP_CAP && (
        <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
          +{donor.classes.length - CLASS_CHIP_CAP}
        </Typography>
      )}
    </Stack>
  )
}

export interface DonorLineProps {
  donor: DonorRow
  planClasses: readonly ClassAbbr[]
  planned: boolean
  /** V5 — this row holds the top tier of its focus family among the rows that survived the filters */
  best: boolean
  /** the header above does not name this row's effect (any axis but `effect`), so the row does */
  namesEffect: boolean
  /** the header above did not take this effect's one-liner, so the row still carries it (JOS-42) */
  namesSays: boolean
  /**
   * THE ADD CONTROL'S WHOLE TRUTH (JOS-42 refinement 3): null when this donor's effect would land
   * in an empty socket, and the OUTGOING effect's name when it would land on top of something.
   * Resolved by the browser, which is the only place that knows both the plan and the target
   * socket — a preset names one exactly, and a one-slot donor implies one.
   */
  replaces: string | null
  onAdd: (donor: DonorRow, anchor: HTMLElement) => void
  /** deep-link this donor into the Loot drill-down; absent when the app wired no router */
  onOpenLoot?: (item: string) => void
}

/**
 * ADD, OR REPLACE — the button says which, and never both (JOS-42 refinement 3).
 *
 * A socket holds ONE effect, so adding into an occupied one silently discards a decision the user
 * already made. The label changes, the colour moves to the warning family, and the tooltip names
 * the casualty in ONE CLAUSE — "replaces Improved Healing III" — which is the caveat diet's whole
 * allowance: a tooltip may enable an action, and knowing what you are about to overwrite is what
 * makes this one safe to click.
 */
function AddButton({
  donor,
  replaces,
  onAdd
}: Pick<DonorLineProps, 'donor' | 'replaces' | 'onAdd'>): JSX.Element {
  const button = (
    <Button
      size="small"
      data-testid="planner-add"
      data-replaces={replaces ?? undefined}
      color={replaces === null ? 'primary' : 'warning'}
      disabled={donor.slots.length === 0}
      onClick={(e) => onAdd(donor, e.currentTarget)}
      sx={{ flexShrink: 0, minWidth: 88 }}
    >
      {replaces === null ? 'Add to set' : 'Replace'}
    </Button>
  )
  if (replaces === null) return button
  return <Tooltip title={`replaces ${replaces}`}>{button}</Tooltip>
}

export function DonorLine({
  donor,
  planClasses,
  planned,
  best,
  namesEffect,
  namesSays,
  replaces,
  onAdd,
  onOpenLoot
}: DonorLineProps): JSX.Element {
  const src = sourceText(donor)
  // V6 — "Beneficial · Single Friendly · 27 minutes", or '' when the spell DB never named this
  // effect. Same 44px row (the windowing law): muted inline text, ellipsized, with the full line
  // in `title` for the ones that do not fit.
  //
  // JOS-42: silent here when the GROUP HEADER already states it for every row under it (the focus
  // families), which is what stopped "Burning Af…" truncating on every donor of one family.
  const says = namesSays ? effectOneLiner(donor) : ''
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      data-testid="planner-donor-row"
      sx={{ height: ROW_HEIGHT, pl: 5, pr: 1, flexWrap: 'nowrap', borderBottom: 1, borderColor: 'divider' }}
    >
      {donor.iconId !== undefined && (
        <Box
          component="img"
          src={itemIconUrl(donor.iconId)}
          alt=""
          onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
            e.currentTarget.style.display = 'none'
          }}
          sx={{ width: 22, height: 22, imageRendering: 'pixelated', flexShrink: 0 }}
        />
      )}
      <Typography variant="body2" component="div" noWrap sx={{ minWidth: 0, flexShrink: SHRINK.name }}>
        <DonorName name={donor.name} bold onOpen={onOpenLoot} />
      </Typography>
      {namesEffect && (
        <Typography
          variant="caption"
          color="text.secondary"
          noWrap
          data-testid="planner-donor-effect"
          sx={{ minWidth: 0, flexShrink: 0, maxWidth: EFFECT_MAX_WIDTH }}
        >
          {donor.effect}
        </Typography>
      )}
      {says !== '' && (
        <Typography
          variant="caption"
          color="text.disabled"
          noWrap
          title={says}
          data-testid="planner-effect-says"
          sx={{ minWidth: 0, flexShrink: SHRINK.says }}
        >
          {says}
        </Typography>
      )}
      {best && <BestChip />}
      <Stack direction="row" spacing={0.25} sx={{ flexShrink: 0 }}>
        {donor.slots.map((s) => (
          <Chip key={s} size="small" variant="outlined" label={s} sx={{ height: 18, fontSize: 10, '& .MuiChip-label': { px: 0.5 } }} />
        ))}
      </Stack>
      {isNonEquippable(donor) && <NoSlotChip />}
      <ClassChips donor={donor} planClasses={planClasses} />
      <Tooltip title={`This effect only extracts once the donor is merged to +${String(donor.tierRequired)}.`}>
        <Chip size="small" color="secondary" variant="outlined" label={`+${String(donor.tierRequired)} to extract`} sx={{ height: 18, fontSize: 10 }} />
      </Tooltip>
      {donor.hasteLocked && <Chip size="small" color="warning" label="haste - can't move" sx={{ height: 18, fontSize: 10 }} />}
      <EraChip subject={donor} />
      <Box sx={{ flexGrow: 1, minWidth: 8 }} />
      <Typography
        variant="caption"
        color="text.secondary"
        noWrap
        title={src.text}
        sx={{ minWidth: 0, flexShrink: SHRINK.source, maxWidth: 320 }}
      >
        {src.text}
      </Typography>
      {src.more !== '' && (
        <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0 }}>
          {src.more}
        </Typography>
      )}
      {planned && <Chip size="small" color="success" variant="outlined" label="in set" sx={{ height: 18, fontSize: 10, flexShrink: 0 }} />}
      <AddButton donor={donor} replaces={replaces} onAdd={onAdd} />
    </Stack>
  )
}

// ---- one group header row --------------------------------------------------------------

export function GroupLine({
  group,
  expanded,
  onToggle
}: {
  group: DonorGroup
  expanded: boolean
  onToggle: (id: string) => void
}): JSX.Element {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      data-testid="planner-effect-row"
      data-axis={group.axis}
      onClick={() => onToggle(group.id)}
      sx={{
        height: ROW_HEIGHT,
        px: 1,
        flexWrap: 'nowrap',
        cursor: 'pointer',
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'action.hover'
      }}
    >
      <IconButton size="small" sx={{ flexShrink: 0 }}>
        {expanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
      </IconButton>
      {/* The family's own name gets the header's equivalent of the row rule: it does not shrink,
          because it is the thing you are reading the header for. */}
      <Typography variant="body2" noWrap sx={{ minWidth: 0, flexShrink: 0, maxWidth: EFFECT_MAX_WIDTH, fontWeight: 600 }}>
        {group.label}
      </Typography>
      {group.note !== '' && (
        <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0, flexShrink: SHRINK.name }}>
          best: {group.note}
        </Typography>
      )}
      {/* JOS-42 — the line every row under this header shares, stated ONCE where there is room.
          Shrinks first of everything on the row: it is the least load-bearing text here, and the
          header's job is to name the family. */}
      {group.says !== '' && (
        <Typography
          variant="caption"
          color="text.disabled"
          noWrap
          title={group.says}
          data-testid="planner-group-says"
          sx={{ minWidth: 0, flexShrink: SHRINK.says }}
        >
          {group.says}
        </Typography>
      )}
      <Chip size="small" variant="outlined" label={SOCKET_LABEL[group.socket]} sx={{ height: 18, fontSize: 10, flexShrink: 0 }} />
      <Chip
        size="small"
        color="secondary"
        variant="outlined"
        label={`+${String(extractionTier(group.socket))} to extract`}
        sx={{ height: 18, fontSize: 10, flexShrink: 0 }}
      />
      {group.hasteLocked && <Chip size="small" color="warning" label="haste - can't move" sx={{ height: 18, fontSize: 10, flexShrink: 0 }} />}
      <Box sx={{ flexGrow: 1 }} />
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
        {group.donors.length} {group.donors.length === 1 ? 'donor' : 'donors'}
      </Typography>
    </Stack>
  )
}
