// THE DAMAGE METER'S BODY — every level of it, for every surface that shows one.
//
// WHY IT IS ITS OWN MODULE (JOS-105, owner): "the Overview tab's damage panel behaves differently
// from the Combat tab - bars are not clickable, drill does not work. It must use THE EXACT SAME
// components so behavior is identical everywhere: combat overlay = combat module = overview
// combat tab. No forked panel implementations."
//
// It was already true of the ROWS' DATA — `petRows.meterPanel` has been the one row builder since
// JOS-35 — and false of the COMPONENTS. The Overview card drew its own bars (`Bar` with no
// `onClick`), kept its own three-value drill vocabulary (`sources | self | pet`), and reached
// past `meterPanel` to `ownBreakdown`/`nestedRows` directly. So a bar that drilled on the Combat
// tab was inert on Overview, and the two surfaces disagreed about what a drill even was.
//
// Now both render THIS, from the same `MeterPanel` and the same `Drill` token, and the glance
// card's density is a PROP:
//   `compact` — fewer badges per row, one stat line instead of a stat grid;
//   `maxRows` — the glance cap, with an honest `+n more` tail.
// A compact variant is a prop on the shared component, never a copy of it.
//
// The floating overlay renders the same LEVELS from the same builder but keeps its own chrome —
// it is a separate renderer entry with no MUI theme and cannot import a single component here
// (meterBars.tsx says so at length). Shared shaping, forked pixels, and that seam is deliberate.

import { useMemo } from 'react'
import { Box, Breadcrumbs, Button, IconButton, Link, Stack, Typography } from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import { QuietNote, SkillBar } from './combatShared'
import { MoreRows } from './meterBits'
import { EntityRow } from './EntityRow'
import { PetBar } from './PetBar'
import { procAnnotationFor, procTagIndex } from './procRows'
import type { Drill } from './dashboardData'
import type { MeterPanel, OwnRow } from './petRows'
import type { ProcSkillTag } from '@shared/procAnalytics'
import type { SourceView } from '@shared/combat'

/** How a drill token is handed back up. `null` is level 1 — the explicit un-drill. */
export type SetDrill = ((d: Drill | null) => void) | null

/**
 * LEVEL 2: ONE flat ranked list of every ability this entity landed — one bar per ability, flat
 * (JOS-113, owner: "Dragon Punch, Melee, Kick, each its own bar. NO category grouping layer, NO
 * category strip"). A stat-bearing ability's crit/double/triple/miss expand INLINE beneath its bar
 * (combatShared.SkillBar); an ability with no stats (a DoT tick) does not expand.
 *
 * `rows` are `MeterPanel.rows` — this entity's abilities with any nested pets ranked among them
 * (non-empty only for YOUR row, and only while the 'Combine pet into your damage' preference is
 * on). Each pet nests as one line item that drills into that pet's own breakdown; nothing about
 * your per-ability rows changes, because a pet's damage is never folded into a lane of yours.
 */
function EntityLanes({
  rows,
  activeSec,
  procs,
  compact,
  maxRows,
  onMore,
  setDrill
}: {
  rows: OwnRow[]
  /** The segment's active seconds — every lane's own rate divides by it (petRows.laneDps). */
  activeSec: number
  /** The is-a-proc tags for THIS source — empty for anyone but you. */
  procs: readonly ProcSkillTag[]
  compact?: boolean
  maxRows?: number
  onMore?: () => void
  setDrill: SetDrill
}): React.JSX.Element {
  const tags = useMemo(() => procTagIndex(procs), [procs])
  const shown = maxRows === undefined ? rows : rows.slice(0, maxRows)
  const hidden = rows.length - shown.length
  return (
    <Box>
      {shown.map((r) =>
        r.kind === 'pet' ? (
          <PetBar
            key={r.pet.id}
            pet={r.pet}
            pct={r.pct}
            onDrill={setDrill ? () => setDrill({ kind: 'entity', entityId: r.pet.id }) : undefined}
          />
        ) : (
          <SkillBar
            key={`${r.skill.category}|${r.skill.name}`}
            s={r.skill}
            activeSec={activeSec}
            compact={compact}
            proc={procAnnotationFor(tags, r.skill.name)}
          />
        )
      )}
      {rows.length === 0 && <QuietNote>No skill breakdown for this source.</QuietNote>}
      {hidden > 0 && <MoreRows n={hidden} onMore={onMore} />}
    </Box>
  )
}

/**
 * Drill-down breadcrumb + Back — ONE mechanism, at every level and on every surface.
 *
 * One level of nesting is possible below the source list, plus the pet case: a pet opened from
 * inside your breakdown is a level below it. `parent` is what makes the trail honest: Back goes to
 * the row this level was opened from, "All" still goes all the way out, and neither pretends a
 * nested pet was ever a top-level bar.
 *
 * `compact` is the glance card's spelling of the same control — a chevron and the subject's name,
 * because a card four rows tall cannot spend a line on a breadcrumb trail. Same handler, same
 * destination, same `data-testid`.
 */
export function DrillCrumb({
  crumb,
  isTarget,
  parent,
  compact,
  setDrill
}: {
  crumb: string
  isTarget?: boolean
  /** the row this level was opened from (your row for a nested pet, the source for a category). */
  parent: SourceView | null
  compact?: boolean
  setDrill: (d: Drill | null) => void
}): React.JSX.Element {
  const up = (): void => setDrill(parent ? { kind: 'entity', entityId: parent.id } : null)
  const label = isTarget ? `damage to ${crumb}` : crumb
  if (compact) {
    return (
      <Stack direction="row" alignItems="center" spacing={0.25} sx={{ mb: 0.25, minWidth: 0 }}>
        <IconButton size="small" data-testid="drill-back" onClick={up} sx={{ p: 0.25 }}>
          <ChevronLeftIcon sx={{ fontSize: 16 }} />
        </IconButton>
        <Typography variant="caption" color="text.secondary" noWrap>
          {label}
        </Typography>
      </Stack>
    )
  }
  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75, flexShrink: 0 }}>
      <Button
        size="small"
        data-testid="drill-back"
        startIcon={<ArrowBackIcon sx={{ fontSize: 16 }} />}
        onClick={up}
        sx={{ minWidth: 0, py: 0 }}
      >
        Back
      </Button>
      <Breadcrumbs separator="›" sx={{ fontSize: 12 }}>
        <Link
          component="button"
          data-testid="drill-all"
          underline="hover"
          color="inherit"
          onClick={() => setDrill(null)}
          sx={{ fontSize: 12 }}
        >
          All
        </Link>
        {parent ? (
          <Link component="button" underline="hover" color="inherit" onClick={up} sx={{ fontSize: 12 }}>
            {parent.name}
          </Link>
        ) : null}
        <Typography variant="caption" color="text.primary">
          {label}
        </Typography>
      </Breadcrumbs>
    </Stack>
  )
}

/** What the crumb above a panel says, or null at level 1. Derived from the panel, never stored. */
export function crumbOf(panel: MeterPanel): { crumb: string; parent: SourceView | null } | null {
  if (panel.level === 1) return null
  return { crumb: panel.subject.name, parent: panel.parent }
}

/**
 * THE BODY. One `MeterPanel` in, one column of rows out, at whichever level the shared builder
 * resolved. Every surface that shows a damage meter with MUI available renders exactly this.
 */
export function MeterRows({
  panel,
  activeSec,
  procs,
  setDrill,
  compact,
  maxRows,
  onMore,
  empty
}: {
  panel: MeterPanel
  activeSec: number
  /** the is-a-proc tags for the drilled source — the caller decides whose (yours, or none). */
  procs: readonly ProcSkillTag[]
  /** null ⇒ the rows render with no drill affordance (the Incoming direction, a locked surface). */
  setDrill: SetDrill
  compact?: boolean
  maxRows?: number
  onMore?: () => void
  /** what level 1 says when there is nothing to rank. */
  empty?: string
}): React.JSX.Element {
  // Level 2 is ONE source's flat ability list — one bar per ability, no category strip (JOS-113).
  // A stat-bearing ability's stats expand inline beneath its bar (EntityLanes → SkillBar).
  if (panel.level !== 1) {
    const subject = panel.subject
    return (
      // Keyed by subject so switching sources remounts the list rather than reconciling a
      // stranger's rows into it.
      <Box key={subject.id}>
        <EntityLanes
          rows={panel.rows}
          activeSec={activeSec}
          procs={procs}
          compact={compact}
          maxRows={maxRows}
          onMore={onMore}
          setDrill={setDrill}
        />
      </Box>
    )
  }
  const shown = maxRows === undefined ? panel.sources : panel.sources.slice(0, maxRows)
  const hidden = panel.sources.length - shown.length
  if (shown.length === 0) return <QuietNote>{empty ?? 'No outgoing damage in this segment.'}</QuietNote>
  return (
    <>
      {shown.map((e, i) => (
        <EntityRow
          key={e.id}
          e={e}
          rank={i + 1}
          compact={compact}
          onDrill={setDrill ? () => setDrill({ kind: 'entity', entityId: e.id }) : undefined}
        />
      ))}
      {hidden > 0 && <MoreRows n={hidden} onMore={onMore} />}
    </>
  )
}
