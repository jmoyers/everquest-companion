import { type JSX, useMemo, useState } from 'react'
import type { OverlayKind } from '@shared/types'
import type { CombatSnapshot, SegmentView } from '@shared/combat'
import { formatTime } from '../lib/formatDate'
import { scopeOptions } from '../features/combat/dashboardData'
import { useGlobalFight } from '../features/combat/useGlobalFight'
import { type OverlaySelectRow } from './OverlaySelect'
import { OverlayHeader } from './OverlayHeader'
import { HealBars } from './healBars'
import { useMeterScope } from '../features/combat/useCombatPrefs'
import { EMPTY_ROSTER, SCOPE_HINT, chipLabel } from '@shared/roster'
import { ICON_ACCENT_GREEN } from './IconButton'
import { MeterPane } from './scopeFloor'
import { TextScaleStepper } from './TextScaleStepper'
import { useOverlayChrome, type OverlayChrome } from './useOverlayChrome'
import { useOverlayCombat } from './useOverlayCombat'

/**
 * The floating HEALING overlay (Task #59) — the 'heal-fight' / 'heal-overall' twin of the DPS
 * OverlayMeter. Same window machinery (kind from `?kind=`, per-kind persisted config, locked
 * click-through vs interactive, persisted drill), same selection semantics ('heal-fight' picks a
 * FIGHT, 'heal-overall' picks a ZONE SESSION), and the same bar treatment: labeled stats embedded
 * after the name, `{min} - {max}` ranges, the TOTAL alone at the right end.
 *
 * Its own file on purpose: the damage meter's flattening, category colors and stat run are about
 * damage taxonomy, and healing has none of that. The small amount of shared bar styling is
 * duplicated below rather than extracted, so this component can evolve without touching the DPS
 * overlay.
 *
 * WHAT THE LOG SUPPORTS (and what it does NOT) — the honesty contract this UI keeps:
 *   - EFFECTIVE healing is what a heal line reports; OVERHEAL is real and derived, not invented:
 *     EQ writes `for N (M) hit points` exactly when M > N and omits the parens otherwise.
 *   - HoT ticks are INDISTINGUISHABLE from direct heals (no `healed over time` / `regeneration`
 *     line family exists), so there is no HoT/direct split anywhere in this UI.
 *   - ABSORPTION RANKS AS HEALING, LABELED. Rune grants are a lane in the SAME flat drill list as
 *     the heal spells and count toward the total, because a shield is sustain. It is told apart
 *     by its own cool COLOR and by WORDING — "Rune", "granted", "absorbed" in the stat run —
 *     never by a chip: a badge overflowed the bar at overlay width, and the color plus the words
 *     already say it. The honesty note (absorption GRANTED, not consumed) lives in the hover
 *     title, not in inline chrome. Absorption is never called restored hit points and never
 *     shows an overheal (a rune has none, and one is not invented for it).
 *   - The other two absorption families (absorbed swings, absorbed damage-shield ticks) carry NO
 *     amount at all, so they are COUNTS in the footer — never a bar, never in a total.
 *
 * DRILL SHAPE: healer → ONE flat ranked list of lanes (`Lay on Hands VI · Healing · Rune`). No
 * grouping level, deliberately: removing the category level is what made the damage drill-down
 * legible, and a separate "absorption" section here would repeat that mistake.
 */

// Palette. The overlay has no MUI theme, so it carries its own colors — a green-leaning ramp so a
// pinned healing meter is never confused with the gold DPS one at a glance.
const HEAL_GOLD = '#7fd1a0'

const LIVE = '__live__'

function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Coarse, live-updating relative age for selector rows (Task #54 disambiguation timing). */
function relativeAge(ts: number, now: number): string {
  if (!ts) return ''
  const secs = Math.max(0, (now - ts) / 1000)
  if (secs < 45) return 'now'
  const mins = secs / 60
  if (mins < 60) return `${Math.round(mins)}m`
  const hrs = mins / 60
  if (hrs < 36) return `${Math.round(hrs)}h`
  return `${Math.round(hrs / 24)}d`
}

/** Everything the chrome renders, resolved from one snapshot in one place. */
interface HealView {
  seg: SegmentView | undefined
  live: boolean
  headerName: string
}

/**
 * HYDRATION (Task #56): while the engine replays the log every snapshot is HISTORICAL. Render
 * quiet and empty until the tail takes over rather than churning through hours-old pulls.
 *
 * The stat line's rate includes absorption, so the stat line is also where the split (and the
 * assumption behind it) is available on hover. One line, no methodology panel.
 */
/** The selected segment, or nothing at all while the engine is still replaying the log. */
function selectedSeg(snap: CombatSnapshot | null): {
  hydrating: boolean
  seg: SegmentView | undefined
} {
  const hydrating = snap?.hydrating ?? true
  return { hydrating, seg: hydrating ? undefined : snap?.selected ?? undefined }
}

function healView(snap: CombatSnapshot | null, isFight: boolean): HealView {
  const { hydrating, seg } = selectedSeg(snap)
  const live = !hydrating && !!snap?.inCombat
  // The RATE is not resolved here any more (JOS-158): the aggregate — and the restored/absorbed
  // sentence that used to ride its hover — are stated from the panel's own header row, off the
  // same segment, by overlay/healBars.tsx.
  return { seg, live, headerName: headerNameFor(hydrating, seg, isFight) }
}

/** "Reading log…" during hydration, then the segment's name — never a borrowed one. */
function headerNameFor(hydrating: boolean, seg: SegmentView | undefined, isFight: boolean): string {
  if (hydrating) return 'Reading log…'
  return seg?.name ?? (isFight ? 'No fight' : 'No zone')
}

/**
 * Scope-filtered selector rows — the SAME helper the damage meters use, so a heal-fight overlay
 * lists only fights (never crossing over to zone sessions between pulls) and heal-overall lists
 * only zone sessions. Rate is omitted: a fight's dps is not this meter's subject, and the name +
 * timing already disambiguate same-named pulls.
 */
function healSelectRows(snap: CombatSnapshot | null, isFight: boolean, now: number): OverlaySelectRow[] {
  if (snap?.hydrating !== false) return []
  const { head, rest } = scopeOptions(
    isFight ? 'fight' : 'overall',
    snap.segments ?? [],
    snap.zoneSessions ?? []
  )
  return [...(head ? [head] : []), ...rest].map((o) => ({
    value: o.value,
    label: o.label,
    rate: '',
    timing: [o.startTs ? formatTime(o.startTs) : '', relativeAge(o.startTs, now), o.durationSec > 0 ? fmtDur(o.durationSec) : o.live ? 'live' : '-']
      .filter(Boolean)
      .join(' · '),
    live: o.live
  }))
}

export default function HealMeter(): JSX.Element {
  // `kind` comes from the preload bridge (read from the window's ?kind= query). Fall back to
  // 'heal-fight' if the bridge is momentarily absent (e.g. an HMR reload before preload re-runs).
  const kind: OverlayKind = window.eqOverlay?.kind ?? 'heal-fight'
  const isFight = kind !== 'heal-overall'
  // Selection mirrors the damage pair exactly, including P4: the FIGHT half is the app-wide
  // global (shared with the Combat tab and the 'fight' overlay), the ZONE half stays local to
  // this window — the ruling's carve-out.
  const { fightId, selectFight } = useGlobalFight(window.eqOverlay)
  const [zoneSelection, setZoneSelection] = useState<string>('zone')
  const selection = isFight ? fightId : zoneSelection

  const snap = useOverlayCombat(selection === LIVE ? undefined : selection)
  const { locked, bgAlpha, textScale, drill, hovering, patch, setDrill, toggleLock, capture, dragRegion, noDrag } =
    useOverlayChrome()
  const now = Date.now()
  // WHOSE healing (docs/plans/group-model.md §2) — the app-wide preference, same key as every
  // other meter since JOS-115 (Preferences > Combat writes it; this window only reads). The
  // healing model already had the ally lane, so this is purely a filter over healers.
  const [meterScope] = useMeterScope()
  const roster = snap?.roster ?? EMPTY_ROSTER

  const { seg, live, headerName } = healView(snap, isFight)
  const selectRows = useMemo(
    () => healSelectRows(snap, isFight, now),
    // Same deps as before the extraction: the two lists the rows are built from, plus the
    // clock that ages them.
    [snap, isFight, now]
  )

  /** A drill is per-segment: picking a different fight / zone session undrills. On the change
   *  handler, NOT an effect — an effect fires on mount (twice under StrictMode) and would clear
   *  the drill we just hydrated. A fight picked in another window is a remote change and leaves
   *  the drill alone (see OverlayMeter's twin for the full reasoning). */
  const selectSegment = (id: string): void => {
    if (isFight) selectFight(id)
    else setZoneSelection(id)
    setDrill(null)
  }

  return (
    // No whole-window hover sensor (P3) — a locked heal meter captures the mouse only over its
    // header row, so the bars stay click-through.
    <div
      style={{
        // 100%, NOT 100vw/100vh — a viewport unit inside the scaled content pane is resolved
        // against the window and then zoomed (overlayScale).
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Inter, "Segoe UI", Roboto, system-ui, sans-serif',
        color: '#f2f2f2',
        background: `rgba(14,17,21,${bgAlpha})`,
        border: locked ? '1px solid rgba(255,255,255,0.04)' : `1px solid rgba(127,209,160,0.4)`,
        borderRadius: 8,
        boxSizing: 'border-box',
        overflow: 'hidden'
      }}
    >
      {/* Header AND selector, one row — same treatment as the damage pair: the title is the
          selected segment's name, and interactive mode makes the row the trigger. */}
      <OverlayHeader
        live={live}
        tag={isFight ? 'HEAL · FIGHT' : 'HEAL · ZONE'}
        title={headerName}
        titleColor={HEAL_GOLD}
        // The NAME alone. The fight clock went to the crumb row with JOS-35 and the aggregate
        // followed it with JOS-158 — same move, same row, same reasoning as the damage pair, and
        // the same freed width for a long mob name (overlay/meterCrumb.tsx).
        iconAccentBg={ICON_ACCENT_GREEN}
        select={{ rows: selectRows, value: selection, onChange: selectSegment, accent: HEAL_GOLD }}
        chrome={{ locked, hovering, dragRegion, noDrag, toggleLock, capture }}
      />

      {/* Bars + mini drill-down. Locked mode RENDERS the remembered drill read-only (no setter ⇒
          no click targets, no cursors, no back chevron) so the window stays click-through. */}
      {/* Same testid as the damage meter's body — the click-through half of the locked contract
          (P3) is measured on exactly this box. Every healer renders and the pane scrolls, and the
          pane is also where the text scale is applied; the chrome around it stays at 1. */}
      {/* JOS-121: the scope word is on this pane's FLOOR now, not in the title bar — same
          watermark, same reserved band, same helper as the damage meter (overlay/scopeFloor.tsx). */}
      {/* JOS-138: pinned, the strip along the pane's right edge takes the mouse while the rows
          overflow, so the wheel and the scrollbar work there and the rest of the body stays
          click-through — the same grip the damage meter has (overlay/overlayScale.tsx). */}
      <MeterPane
        textScale={textScale}
        locked={locked}
        capture={capture}
        scope={{
          label: chipLabel(meterScope, roster),
          title: `${SCOPE_HINT[meterScope]}. Change it in Preferences > Combat.`
        }}
      >
        <HealBars seg={seg} scope={meterScope} roster={roster} drill={drill} setDrill={locked ? null : setDrill} live={live} />
      </MeterPane>

      {!locked && <HealFooter bgAlpha={bgAlpha} textScale={textScale} patch={patch} noDrag={noDrag} />}
    </div>
  )
}

/** Footer controls — interactive mode only: bg-alpha slider + text size. Chrome, so unscaled and
 *  ONE ROW at any width: the buttons never shrink and the slider absorbs whatever the row is
 *  short (see the damage meter's twin for the whole reasoning). */
function HealFooter({
  bgAlpha,
  textScale,
  patch,
  noDrag
}: {
  bgAlpha: number
  textScale: number
  patch: OverlayChrome['patch']
  noDrag: React.CSSProperties
}): JSX.Element {
  return (
    <div
      style={{
        ...noDrag,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '3px 8px 5px',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        fontSize: 10,
        color: 'rgba(255,255,255,0.6)',
        flexShrink: 0
      }}
    >
      <span title="Background opacity" style={{ flexShrink: 0 }}>
        bg
      </span>
      <input
        type="range"
        min={0.1}
        max={1}
        step={0.02}
        value={bgAlpha}
        onChange={(e) => patch({ bgAlpha: Number(e.target.value) })}
        style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 24, accentColor: HEAL_GOLD, height: 4 }}
      />
      <TextScaleStepper textScale={textScale} patch={patch} noDrag={noDrag} />
    </div>
  )
}
