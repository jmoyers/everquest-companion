// The dashboard's ANCHOR PANEL — the source meter (level 1) and, when drilled, ONE subject below
// it. Split out of CombatView.tsx; the tab is now header + body + log, and this is the body's
// first cell.
//
// The drill kinds are a union, so there is always exactly one breadcrumb: an entity's flat ability
// list (whose stat-bearing abilities expand inline, JOS-113), or a MOB's list (everything you +
// pet landed on it).
//
// THE ROWS THEMSELVES ARE NOT HERE ANY MORE. Every level of the body is `MeterRows.tsx`, which
// the Overview card renders too — this file is the panel's chrome (header, crumb, scroll box,
// scope/dimension resolution) and the mob-drill arm that only this surface has.

import { useMemo } from 'react'
import { Box, Paper, Typography } from '@mui/material'
import { TargetSkillBars } from './CombatDashboard'
import { meterDrill, skillsForTarget, type Drill, type MeterMode, type TargetDetail } from './dashboardData'
import { HealBody } from './HealPanel'
import { DrillCrumb, MeterRows, crumbOf } from './MeterRows'
import { SegmentHeader } from './SegmentHeader'
import { meterPanel, panelTotals, type MeterPanel } from './petRows'
import { scopeSources, scopeTotals } from './meterScope'
import { useCombinePetRow } from './useCombatPrefs'
import { formatEntityText, formatSegmentText, formatTargetText } from './copyText'
import { formatNum as fmt } from '../../lib/formatRate'
import type { SegmentView, SourceView, TimelineView } from '@shared/combat'
import type { ProcSkillTag } from '@shared/procAnalytics'
import type { MeterScope, RosterSnap } from '@shared/roster'

function IncomingHeals({ seg }: { seg: SegmentView }): React.JSX.Element | null {
  if (seg.incomingHealTotal <= 0) return null
  const top = seg.incomingHealers.slice(0, 4)
  return (
    <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
      <Typography variant="caption" sx={{ color: '#5fbf7f', fontWeight: 600 }}>
        Heals received: {fmt(seg.incomingHealTotal)}
      </Typography>
      {top.map((h) => (
        <Typography key={h.name} variant="caption" sx={{ display: 'block', color: 'text.secondary', pl: 1 }}>
          {h.name} · {fmt(h.total)} ({h.count})
        </Typography>
      ))}
    </Box>
  )
}

// ── drill resolution ───────────────────────────────────────────────────────────────────

/** Which subject (if any) the current drill resolves to, against THIS segment. */
interface DrillState {
  targetName: string | null
  targetDetail: TargetDetail | null
  /** the breadcrumb, or null at level 1. `isTarget` picks the "damage to <mob>" wording. */
  crumb: { crumb: string; parent: SourceView | null; isTarget?: boolean } | null
}

/**
 * The SOURCE half of the drill is `MeterPanel`'s business — including both stale cases, where a
 * drill pointing at an entity no longer present (the fight changed) resolves to level 1 and one
 * pointing at a damage type this source never dealt resolves to level 2. This hook only adds the
 * MOB drill, which is this surface's alone: it reads the timeline's ring, and goes stale the same
 * way when the ring disappears.
 */
function useDrillState(panel: MeterPanel, tl: TimelineView | null, drill: Drill | null): DrillState {
  const targetName = drill?.kind === 'target' ? drill.target : null
  const targetDetail = useMemo(
    () => (tl && targetName ? skillsForTarget(tl, targetName) : null),
    [tl, targetName]
  )
  const source = crumbOf(panel)
  const target = targetDetail && targetName ? { crumb: targetName, parent: null, isTarget: true } : null
  return { targetName, targetDetail, crumb: source ?? target }
}

/**
 * The is-a-proc tags that belong to ONE drilled source: yours, or none.
 *
 * The proc ledger is folded from YOUR procs — poison Strikes on your blades, cast-less effects
 * behind your swings — so tagging a pet's lanes with those rates would credit your blades to the
 * pet. Its own function rather than a ternary at the call site so `SegmentContent` stays inside
 * the complexity budget with room to spare.
 */
function ownProcTags(seg: SegmentView, e: SourceView): readonly ProcSkillTag[] {
  return e.kind === 'you' ? (seg.procs.procSkills ?? []) : []
}

/** The scrolling body: the ranked source list at level 1, one drilled subject below it. */
function SegmentContent({
  seg,
  mode,
  panel,
  scope,
  roster,
  d,
  drill,
  setDrill
}: {
  seg: SegmentView
  mode: MeterMode
  /** the whole body, at whatever level the shared builder resolved (`petRows.meterPanel`). */
  panel: MeterPanel
  scope: MeterScope
  roster: RosterSnap
  d: DrillState
  /** the raw token — the Healing dimension resolves it against healers, not damage sources. */
  drill: Drill | null
  setDrill: (drill: Drill | null) => void
}): React.JSX.Element {
  // THE HEALING DIMENSION IS ITS OWN LIST, top to bottom (P2). It shares this scroll box, the
  // drill token and the segment header — and nothing else: healers are not damage sources, so
  // there is no ranked-source level to reuse and no damage type to drill into.
  if (mode === 'heal') {
    return (
      <Box data-testid="meter-body" sx={{ overflow: 'auto', flexGrow: 1, minHeight: 0 }}>
        <HealBody healing={seg.healing} scope={scope} roster={roster} drill={drill} setDrill={setDrill} />
      </Box>
    )
  }
  // A MOB drill replaces the source list entirely; it is this surface's own level and has no
  // twin on the glance card or the overlay, so it stays here rather than in the shared body.
  const mob = panel.level === 1 && d.targetDetail && d.targetName
  return (
    <Box data-testid="meter-body" sx={{ overflow: 'auto', flexGrow: 1, minHeight: 0 }}>
      {mob && d.targetName && d.targetDetail ? (
        <TargetSkillBars target={d.targetName} detail={d.targetDetail} seg={seg} />
      ) : (
        <MeterRows
          panel={panel}
          activeSec={seg.activeSec}
          procs={panel.level === 1 ? [] : ownProcTags(seg, panel.subject)}
          // The Incoming direction has no drill: its rows fall back to EntityRow's own inline
          // expansion, exactly as they did before this body was shared.
          setDrill={mode === 'out' ? setDrill : null}
          empty={mode === 'out' ? 'No outgoing damage in this segment.' : 'No incoming damage in this segment.'}
        />
      )}
      {mode === 'in' && !d.crumb && <IncomingHeals seg={seg} />}
    </Box>
  )
}

/**
 * WHAT THE SELECTED DIMENSION IS MADE OF: the rows it ranks and its headline figures.
 *
 * The healing pair is `HealingView`'s own total/hps: restored hit points + granted absorption,
 * exactly the figures the heal overlays headline (shared/combat.ts states what each includes).
 *
 * Healing ranks HEALERS, not damage sources, so `rows` is empty there rather than borrowed —
 * `meterPanel` over an empty list yields level 1 with nothing in it, the right no-op while
 * another dimension is on screen.
 */
interface Dimension {
  rows: SourceView[]
  total: number
  dps: number
  /** the ACTIVE-time rate that rides beside the headline — printed in the outgoing dimension
   *  only (`ActiveDpsNote`), so the other two carry their own rate here rather than a fiction. */
  activeDps: number
}

function dimension(seg: SegmentView, mode: MeterMode): Dimension {
  if (mode === 'heal') {
    return { rows: [], total: seg.healing.total, dps: seg.healing.hps, activeDps: seg.healing.hps }
  }
  if (mode === 'in') return { rows: seg.incoming, total: seg.inTotal, dps: seg.inDps, activeDps: seg.inDps }
  return { rows: seg.entities, total: seg.outTotal, dps: seg.outDps, activeDps: seg.activeDps }
}

/**
 * …and the same things once the SCOPE has had its say (docs/plans/group-model.md §2).
 *
 * Only the OUTGOING dimension is scoped, because scope is a statement about whose damage — the
 * incoming list is always "what is hitting You", and no roster changes that. The headline figures
 * are recomputed from the surviving rows rather than carried over: `outTotal` counts members, so
 * a You-scoped list under a group-scoped total would headline a number no visible row explains.
 *
 * BOTH RATES ride through `scopeTotals`, because each shares its denominator with the total it
 * belongs to (`outDps` divides by elapsed time, `activeDps` by active seconds) — the same pair of
 * calls DpsCard's `scopedView` makes, so the glance card and this panel scale identically.
 */
function scopedDimension(seg: SegmentView, mode: MeterMode, scope: MeterScope, roster: RosterSnap): Dimension {
  const base = dimension(seg, mode)
  if (mode !== 'out') return base
  const rows = scopeSources(base.rows, scope, roster)
  return {
    rows,
    ...scopeTotals(base.rows, rows, base.total, base.dps),
    activeDps: scopeTotals(base.rows, rows, base.total, base.activeDps).dps
  }
}

/**
 * …and finally what THIS PANEL is showing, which is the pair the header prints (JOS-170).
 *
 * At level 1 that is the scoped dimension untouched; drilled, it is the subject plus the pets
 * nested into it — see `petRows.panelTotals`, the ONE derivation the Overview card reads too.
 * Without it the header stated the fight while the rows stated the subject, and flipping the pet
 * preference under an open You drill moved the rows and left the number where it was.
 */
function headline(panel: MeterPanel, dim: Dimension): { total: number; dps: number; activeDps: number } {
  const { total, dps } = panelTotals(panel, dim.total, dim.dps)
  return { total, dps, activeDps: panelTotals(panel, dim.total, dim.activeDps).dps }
}

export function SegmentBody({
  seg,
  tl,
  mode,
  scope,
  roster,
  drill,
  setDrill
}: {
  seg: SegmentView
  tl: TimelineView | null
  mode: MeterMode
  scope: MeterScope
  roster: RosterSnap
  drill: Drill | null
  setDrill: (d: Drill | null) => void
}): React.JSX.Element {
  const heal = mode === 'heal'
  const dim = scopedDimension(seg, mode, scope, roster)
  const scoped = dim.rows
  const [combinePetRow] = useCombinePetRow()
  // THE one row builder — the same call the floating overlay makes (petRows.meterPanel). Nesting
  // is an OUTGOING idea: the Incoming direction lists enemies, and none of them owns a pet of
  // yours, so the preference is folded into the `combine` argument rather than tested downstream.
  const panel = meterPanel(scoped, mode === 'out' && combinePetRow, meterDrill(drill))
  // …and the SAME panel decides the header's figures, so the number over the rows can never
  // describe a different set of rows than the ones under it (JOS-170).
  const head = headline(panel, dim)
  const d = useDrillState(panel, tl, drill)

  // "Copy this view" means THIS view: the same choice the body below makes, so the clipboard can
  // never hold a level the user isn't looking at. Built on click, never on render. The per-ability
  // stats a reader expanded inline (JOS-113) are not serialized: the paste is the ranked ability
  // table, and a single ability's crit/double/triple is a click-state, not a level to copy.
  const copyView = (): string =>
    panel.level !== 1
      ? // The SAME pets the body nests into this list — `MeterPanel.pets` IS what was nested,
        // so the clipboard can no longer drop a row the reader can see on screen.
        formatEntityText(seg, panel.subject, panel.pets)
      : d.targetDetail && d.targetName
        ? formatTargetText(seg, d.targetName, d.targetDetail)
        : formatSegmentText(seg, mode === 'in' ? 'in' : 'out')

  return (
    // Grid-cell sizing, exactly like DashCard's `fill`: 100% of the cell, zero intrinsic
    // height (so a `minmax(0, 1fr)` row can shrink it), everything below the header scrolls
    // internally. The meter must never be what makes the dashboard taller than its box.
    <Paper
      variant="outlined"
      data-testid="dash-panel"
      sx={{
        p: 1.5,
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <SegmentHeader
        seg={seg}
        mode={mode}
        total={head.total}
        dps={head.dps}
        activeDps={head.activeDps}
        copyView={heal ? null : copyView}
      />
      {/* The damage crumb; the Healing dimension draws its own inside HealBody, because its one
          drill level has no nested-pet case and therefore no parent link to render. */}
      {!heal && d.crumb && (
        <DrillCrumb
          crumb={d.crumb.crumb}
          isTarget={d.crumb.isTarget}
          parent={d.crumb.parent}
          setDrill={setDrill}
        />
      )}
      <SegmentContent
        seg={seg}
        mode={mode}
        panel={panel}
        scope={scope}
        roster={roster}
        d={d}
        drill={drill}
        setDrill={setDrill}
      />
    </Paper>
  )
}
