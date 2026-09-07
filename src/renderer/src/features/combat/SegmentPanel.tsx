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

import { useMemo, useState } from 'react'
import { Box, Paper, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import { TargetSkillBars } from './CombatDashboard'
import { DefensePanel } from './DefensePanel'
import { segmented } from './segmented'
import { meterDrill, skillsForTarget, type Drill, type MeterMode, type TargetDetail } from './dashboardData'
import { HealBody } from './HealPanel'
import { DrillCrumb, MeterRows, crumbOf } from './MeterRows'
import { SegmentHeader } from './SegmentHeader'
import { meterPanel, panelTotals, type MeterPanel } from './petRows'
import { scopeSources, scopeTotals } from './meterScope'
import { useCombinePetRow } from './useCombatPrefs'
import { useModule } from '../../lib/useModule'
import { selfMeterLabel, withSelfLabel } from './selfMeterLabel'
import { useShowSelfName } from './useSelfMeterName'
import type { CharacterSnap } from '@shared/types'
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

// ── the card's own two tabs (JOS-361) ──────────────────────────────────────────────────

/** Which question this card is answering about the INCOMING direction. */
type MeterTab = 'damage' | 'mitigation'

/**
 * THE TAB STRIP, and the two conditions that decide whether the card has tabs at all:
 *
 *  - the panel must be listing WHAT IS HITTING YOU. A source's own `missBreakdown` in the OUTGOING
 *    direction is the mob's avoidance of YOUR swings — the opposite fact — so the Outgoing and
 *    Healing dimensions have no second tab, not a disabled one (JOS-354's rule, unmoved).
 *  - no drill may be open. Mitigation is a statement about the WHOLE segment; offering it over one
 *    drilled subject's lanes would put two different subjects behind one pair of tabs.
 *
 * THE CONTROL IS THE COMBAT AREA'S OWN, not a new one: the same `segmented` pill track the
 * Dashboard/Timeline, Fight/Overall and Outgoing/Incoming switches wear, at the `quiet` weight
 * that means "this lives inside the unit it sits in" (segmented.ts). MUI `Tabs` exist elsewhere in
 * the app (the gear area, Plane of Sky) but they are PAGE-level chrome with a full-width rule
 * under them, which is not what a 22px-row card wants across its top.
 */
function MeterTabs({ tab, setTab }: { tab: MeterTab; setTab: (t: MeterTab) => void }): React.JSX.Element {
  return (
    <Box sx={{ mb: 0.75, flexShrink: 0 }}>
      <ToggleButtonGroup
        size="small"
        exclusive
        data-testid="meter-tabs"
        value={tab}
        onChange={(_e: unknown, v: MeterTab | null) => v && setTab(v)}
        sx={segmented('quiet')}
      >
        <ToggleButton value="damage">Damage breakdown</ToggleButton>
        <ToggleButton value="mitigation">Mitigation</ToggleButton>
      </ToggleButtonGroup>
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

/**
 * The DAMAGE BREAKDOWN tab's rows — the ranked source list at level 1, or the one drilled subject.
 *
 * A MOB drill replaces the source list entirely; it is this surface's own level and has no twin on
 * the glance card or the overlay, so it stays here rather than in the shared body.
 *
 * Split out of `SegmentContent` when the tabs landed (JOS-361): that function was already at the
 * measured complexity ceiling, and the house rule is to split rather than ratchet the threshold
 * (combatShared.tsx's CopyButton precedent, one file over).
 */
function DamageRows({
  seg,
  mode,
  panel,
  d,
  setDrill
}: {
  seg: SegmentView
  mode: MeterMode
  panel: MeterPanel
  d: DrillState
  setDrill: (drill: Drill | null) => void
}): React.JSX.Element {
  if (panel.level === 1 && d.targetDetail && d.targetName) {
    return <TargetSkillBars target={d.targetName} detail={d.targetDetail} seg={seg} />
  }
  return (
    <MeterRows
      panel={panel}
      activeSec={seg.activeSec}
      procs={panel.level === 1 ? [] : ownProcTags(seg, panel.subject)}
      // The Incoming direction has no drill: its rows fall back to EntityRow's own inline
      // expansion, exactly as they did before this body was shared.
      setDrill={mode === 'out' ? setDrill : null}
      empty={mode === 'out' ? 'No outgoing damage in this segment.' : 'No incoming damage in this segment.'}
    />
  )
}

/** The scrolling body: whichever of the card's tabs is showing (JOS-361). */
function SegmentContent({
  seg,
  mode,
  panel,
  scope,
  roster,
  d,
  drill,
  setDrill,
  tab
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
  /** the RESOLVED tab: 'damage' wherever the strip is not offered at all (see `SegmentBody`), so
   *  nothing downstream has to re-test the two conditions that decide whether tabs exist. */
  tab: MeterTab
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
  return (
    <Box data-testid="meter-body" sx={{ overflow: 'auto', flexGrow: 1, minHeight: 0 }}>
      {tab === 'mitigation' ? (
        // YOUR DEFENCE (JOS-354), on its own tab since JOS-361. Nothing else draws here: the two
        // tabs are two answers, not one column with a heading on it.
        <DefensePanel d={seg.defense} />
      ) : (
        <>
          <DamageRows seg={seg} mode={mode} panel={panel} d={d} setDrill={setDrill} />
          {mode === 'in' && !d.crumb && <IncomingHeals seg={seg} />}
        </>
      )}
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
  // WHICH TAB (JOS-361). Plain component state, NOT a renderer pref, and that is the neighbourhood
  // convention rather than an oversight: the two switches this one sits under — the view switch
  // (Dashboard/Timeline) and the direction filter (Outgoing/Incoming/Healing) — are both
  // `useState` in CombatView, and the owner's ruling is that the card OPENS on Damage breakdown.
  // A persisted tab would contradict that ruling the first time anyone left it on Mitigation.
  // (The things around here that DO persist — the drill, the chart's hidden lines, Fight/Overall —
  // persist because they are answers a user would have to re-derive; a tab is one click.)
  const [tab, setTab] = useState<MeterTab>('damage')
  const dim = scopedDimension(seg, mode, scope, roster)
  const [combinePetRow] = useCombinePetRow()
  // Show the self row as the tailed character's own name — `Primitive (You)` — when the user
  // asked for it (features/combat/selfMeterLabel.ts). Off by default: `withSelfLabel` hands back
  // `dim.rows` by reference, so this surface is byte-identical to before the feature.
  // The relabel is applied for EVERY `mode`, not just `'out'`, on purpose: a `kind === 'you'` row
  // on the Incoming (attackers) list is nearly impossible, and if one ever appears the
  // `<Char> (You)` label is still the correct thing to show for it.
  const selfName = useModule<CharacterSnap>('character')?.character?.name ?? null
  const selfLabel = selfMeterLabel(selfName, useShowSelfName())
  const scoped = withSelfLabel(dim.rows, selfLabel)
  // THE one row builder — the same call the floating overlay makes (petRows.meterPanel). Nesting
  // is an OUTGOING idea: the Incoming direction lists enemies, and none of them owns a pet of
  // yours, so the preference is folded into the `combine` argument rather than tested downstream.
  const panel = meterPanel(scoped, mode === 'out' && combinePetRow, meterDrill(drill))
  // …and the SAME panel decides the header's figures, so the number over the rows can never
  // describe a different set of rows than the ones under it (JOS-170).
  const head = headline(panel, dim)
  const d = useDrillState(panel, tl, drill)
  // The two conditions from `MeterTabs`, resolved ONCE: whether the card has tabs at all, and
  // therefore which tab the body is showing.
  const tabbed = mode === 'in' && d.crumb === null
  const shownTab: MeterTab = tabbed ? tab : 'damage'

  // "Copy this view" means THIS view: the same choice the body below makes, so the clipboard can
  // never hold a level the user isn't looking at. Built on click, never on render. The per-ability
  // stats a reader expanded inline (JOS-113) are not serialized: the paste is the ranked ability
  // table, and a single ability's crit/double/triple is a click-state, not a level to copy.
  //
  // …AND IT IS DELIBERATELY NOT TAB-AWARE (JOS-361). `formatSegmentText(seg, 'in')` already carries
  // the defence block AND the attacker table, and it keeps carrying both: the copy button belongs
  // to the panel HEADER, above the strip, so it is the CARD's affordance and not the visible tab's
  // — and the alternative loses one of the two halves of the incoming picture depending on which
  // tab happened to be open, which is exactly how a paste starts lying about the fight. Dropping
  // mitigation from the paste would also silently retire the one place JOS-354's answer is
  // shareable. The tab decides what is on SCREEN; the clipboard still gets the whole direction.
  const copyView = (): string => {
    if (panel.level !== 1) {
      // Copy carries the SAME self-label the meter shows (`<Char> (You)` when the pref is on,
      // `You` when off) at every drill level — `sourceName` applies it to the `kind === 'you'`
      // row regardless of the subject's `.name`, keeping `copyText` a pure function of its args.
      // The SAME pets the body nests into this list — `MeterPanel.pets` IS what was nested, so the
      // clipboard can no longer drop a row the reader can see on screen.
      return formatEntityText(seg, panel.subject, panel.pets, selfLabel)
    }
    return d.targetDetail && d.targetName
      ? formatTargetText(seg, d.targetName, d.targetDetail)
      : formatSegmentText(seg, mode === 'in' ? 'in' : 'out', selfLabel)
  }

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
      {/* The card's own tabs, at the top of its CONTENT and outside the scroll box below — a tab
          strip that scrolls away with the rows it switches is not a tab strip. */}
      {tabbed && <MeterTabs tab={tab} setTab={setTab} />}
      <SegmentContent
        seg={seg}
        mode={mode}
        panel={panel}
        scope={scope}
        roster={roster}
        d={d}
        drill={drill}
        setDrill={setDrill}
        tab={shownTab}
      />
    </Paper>
  )
}
