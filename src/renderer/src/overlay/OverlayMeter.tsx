import { type JSX, useState } from 'react'
import type { OverlayKind } from '@shared/types'
import type { CombatSnapshot, PetSummonNudge, SegmentView } from '@shared/combat'
import { formatRate } from '../lib/formatRate'
import { formatTime } from '../lib/formatDate'
import { LIVE_SELECTION, scopeOptions, type ScopeOption } from '../features/combat/dashboardData'
import { useGlobalFight } from '../features/combat/useGlobalFight'
import { type OverlaySelectRow } from './OverlaySelect'
import { OverlayHeader, type OverlayHeaderAction } from './OverlayHeader'
import { useSessionMarks } from '../features/timeslice/useSessionMarks'
import { MeterBars } from './meterBars'
import { MeterPane } from './scopeFloor'
import { PetNudgeCard } from './petNudgeCard'
import { TextScaleStepper } from './TextScaleStepper'
import { FOOTER_ROW } from './overlayScale'
import { useOverlayChrome, type OverlayChrome } from './useOverlayChrome'
import { useOverlayCombat } from './useOverlayCombat'
import { useMeterScope } from '../features/combat/useCombatPrefs'
import { EMPTY_ROSTER, chipLabel } from '@shared/roster'

// Palette (matches the app's combat colors; the overlay has no MUI theme).
const GOLD = '#d9b25f'

/** The "head row" sentinel — one definition, shared with the main view (dashboardData). */
const LIVE = LIVE_SELECTION

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

/**
 * The dense disambiguation line under a selector row: start clock · coarse age · duration
 * (the still-running zone session says 'live' instead of a length it doesn't have yet).
 * Same information as the main view's selector, spelled terser for an 11px overlay.
 */
function overlayTiming(o: ScopeOption, now: number): string {
  const bits: string[] = []
  if (o.startTs) bits.push(formatTime(o.startTs))
  const age = relativeAge(o.startTs, now)
  if (age) bits.push(age)
  bits.push(o.durationSec > 0 ? fmtDur(o.durationSec) : o.live ? 'live' : '-')
  return bits.join(' · ')
}

/** Scope-filtered rows for the overlay selector: head first, then the rest. */
function selectorRows(head: ScopeOption | null, rest: ScopeOption[], now: number): OverlaySelectRow[] {
  return [...(head ? [head] : []), ...rest].map((o) => ({
    value: o.value,
    label: o.label,
    rate: formatRate(o.dps),
    timing: overlayTiming(o, now),
    live: o.live
  }))
}

/** Everything the chrome renders, resolved from one snapshot in one place. */
interface MeterView {
  seg: SegmentView | undefined
  live: boolean
  headerName: string
  rows: OverlaySelectRow[]
  /** on the head row, but the head row is the LAST (finished) fight — never dress it up as live */
  headIsLast: boolean
}

/** Header title + live dot for the selected segment. The RATE is not here any more — since
 *  JOS-158 the aggregate is stated, labelled, on the panel's own header row (overlay/meterCrumb).
 */
function headerFor(
  snap: CombatSnapshot | null,
  seg: SegmentView | undefined,
  isFight: boolean,
  hydrating: boolean
): Pick<MeterView, 'live' | 'headerName'> {
  return {
    live: !hydrating && !!snap?.inCombat,
    headerName: hydrating ? 'Reading log…' : seg?.name ?? (isFight ? 'No fight' : 'No zone')
  }
}

/** Selector options — ONE scope's rows, filtered by the shared helper the main view uses. */
function scopeRows(
  snap: CombatSnapshot | null,
  isFight: boolean,
  hydrating: boolean,
  now: number
): { rows: OverlaySelectRow[]; head: ScopeOption | null } {
  const opts = scopeOptions(
    isFight ? 'fight' : 'overall',
    hydrating ? [] : snap?.segments ?? [],
    hydrating ? [] : snap?.zoneSessions ?? []
  )
  return { rows: selectorRows(opts.head, opts.rest, now), head: opts.head }
}

/**
 * HYDRATION (Task #56): while the engine replays the log, every snapshot is a HISTORICAL
 * moment — an overlay pinned over the game would churn through hours-old pulls as if they
 * were live. Render quiet and empty until the tail takes over (the main window shows the
 * same "Reading log…" state); one flag gates the whole surface.
 */
function meterView(
  snap: CombatSnapshot | null,
  isFight: boolean,
  selection: string,
  now: number
): MeterView {
  const hydrating = snap?.hydrating ?? true
  const seg = hydrating ? undefined : snap?.selected ?? undefined
  const { rows, head } = scopeRows(snap, isFight, hydrating, now)
  return {
    seg,
    ...headerFor(snap, seg, isFight, hydrating),
    rows,
    headIsLast: selection === LIVE && !!head && !head.live
  }
}

/**
 * THE PET NUDGE (JOS-258), gated the way every other live signal on this surface is.
 *
 * No local state and no dismiss anywhere in the renderer: the engine decides, per poll, whether the
 * sentence exists — and it stops existing on its own. Suppressed while the log is still folding for
 * the reason `meterView` blanks everything else then: a summon replayed out of a months-old log is
 * a historical moment, not something to tell somebody about now.
 */
function liveNudge(snap: CombatSnapshot | null): PetSummonNudge | undefined {
  if (!snap || snap.hydrating) return undefined
  return snap.petNudge
}

/**
 * THE ZONE METER'S TITLE-BAR "NEW SESSION" (JOS-322, owner ruling 2026-08-21: *the New-session
 * button DOES go on the zone meter overlay — small, in the title bar*).
 *
 * It is the SAME app-wide mark the Loot bar's button presses, through the same main-held list: one
 * click, one instant, and everything splits at it — the loot ledger's segments AND this meter's own
 * engine records. Nothing here knows the instant; main stamps it (src/main/sessionMarks.ts).
 *
 * ZONE ONLY, and that is the ruling's own shape rather than a simplification. This control's whole
 * meaning on a meter is "the Overall I am watching starts again from here", and Overall is exactly
 * what the ZONE kind draws. A FIGHT meter's records are pulls — the log opens and closes those, and
 * a button that split one would be answering a question nobody asked.
 *
 * The hook runs unconditionally (it is a hook) and the ACTION is what is withheld, so a fight meter
 * still shares the one cache and simply draws no button.
 */
function useNewSessionAction(isFight: boolean, after: () => void): OverlayHeaderAction | undefined {
  const { press } = useSessionMarks(window.eqOverlay)
  if (isFight) return undefined
  return {
    // The accessible NAME, not a tooltip — overlay chrome carries aria-labels and no native titles
    // (the 1111d8d9 ruling). It is the same three words the ledger's button prints, because it is
    // the same concept and the vocabulary is unified by ruling.
    label: 'New session',
    glyph: '⚑',
    onClick: () => {
      void press().then(after, () => undefined)
    }
  }
}

export default function OverlayMeter(): JSX.Element {
  // `kind` comes from the preload bridge (read from the window's ?kind= query). Fall back to
  // 'fight' if the bridge is momentarily absent (e.g. an HMR reload before the preload re-runs).
  const kind: OverlayKind = window.eqOverlay?.kind ?? 'fight'
  const isFight = kind === 'fight'
  // Selection is SCOPED to this overlay's kind and never crosses over: a 'fight' overlay lists
  // (and shows) only fights — the current one while a pull is open, else the LAST one — and a
  // 'overall' overlay lists only zone sessions. A fight meter silently becoming a zone meter
  // between pulls was the same bug the Combat tab had.
  //
  // …and the FIGHT half of that is now GLOBAL (P4): this window shares one selection with the
  // Combat tab and the heal-fight overlay, so picking a fight in any of them moves all of them.
  // The ZONE half is untouched and deliberately LOCAL — the ruling's explicit carve-out.
  const { fightId, selectFight } = useGlobalFight(window.eqOverlay)
  const [zoneSelection, setZoneSelection] = useState<string>('zone')
  const selection = isFight ? fightId : zoneSelection

  const snap = useOverlayCombat(selection === LIVE ? undefined : selection)
  const { locked, bgAlpha, textScale, drill, hovering, patch, setDrill, toggleLock, capture, dragRegion, noDrag } =
    useOverlayChrome()
  // WHOSE damage (docs/plans/group-model.md §2). ONE app-wide preference since JOS-115: the
  // Combat tab, the Overview card and every floating meter read this key, and only
  // Preferences > Combat writes it. The roster itself is the snapshot's, so this window and the
  // tab always filter the same names by the same rule.
  const [meterScope] = useMeterScope()
  const roster = snap?.roster ?? EMPTY_ROSTER
  const newSession = useNewSessionAction(isFight, () => {
    // The engine's Overall drops to zero and the stay you just closed appears in THIS selector as
    // one more finalized entry — so the window snaps back to the live session rather than sitting
    // on a browse of whatever was picked. Anything else already selected is left alone: the click
    // splits the record, and Details! rule 4 says browsing is a pick, not a mutation.
    setZoneSelection('zone')
    setDrill(null)
  })

  const { seg, live, headerName, rows, headIsLast } = meterView(
    snap,
    isFight,
    selection,
    Date.now()
  )

  /** A drill is per-segment: picking a different fight / zone session undrills. This lives on the
   *  selector's change handler, NOT in an effect keyed on `selection` — an effect fires on mount
   *  (twice, under StrictMode) and would clear the drill we just hydrated. Only genuine user
   *  actions — this and the back chevron — ever clear the stored value.
   *
   *  A fight picked in ANOTHER window therefore does NOT undrill this one, on purpose: that is a
   *  remote change, not a click here, and a persisted drill that no longer resolves already
   *  degrades correctly (it renders level 1 for this render and re-applies when the entity is
   *  back — the same stale-id rule the whole overlay uses). Writing the store from someone
   *  else's click would be the surprise. */
  const selectSegment = (id: string): void => {
    if (isFight) selectFight(id)
    else setZoneSelection(id)
    setDrill(null)
  }

  return (
    // NO whole-window hover sensor any more (P3): a LOCKED meter captures the mouse only while
    // the pointer is over its header row (OverlayHeader's `capture`), so the bars themselves stay
    // genuinely click-through — which is what "locked" was always supposed to mean.
    <div
      style={{
        // 100%, NOT 100vw/100vh: the shell fills the window, and a viewport unit inside the
        // scaled content pane resolves against the window and is then zoomed (overlayScale).
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Inter, "Segoe UI", Roboto, system-ui, sans-serif',
        color: '#f2f2f2',
        background: `rgba(14,17,21,${bgAlpha})`,
        border: locked ? '1px solid rgba(255,255,255,0.04)' : `1px solid rgba(217,178,95,0.4)`,
        borderRadius: 8,
        boxSizing: 'border-box',
        overflow: 'hidden'
      }}
    >
      {/* Header AND selector, one row: the title is the selected segment's own name, and the row
          is the trigger — clicking it drops the fight/zone list under the header. Since P3 that
          is true LOCKED as well: `capture` is what makes the click land on a click-through
          window, and it is scoped to this row alone. */}
      <OverlayHeader
        live={live}
        tag={isFight ? 'FIGHT' : 'ZONE'}
        last={headIsLast}
        title={headerName}
        titleColor={GOLD}
        // THE FIGHT'S NAME, AND NOTHING ELSE (owner direction 2026-08-09 — JOS-158). JOS-35 had
        // already sent the fight CLOCK down to the crumb row above the bars; the RATE has now
        // followed it (overlay/meterCrumb.tsx), where it can be labelled for what it covers
        // instead of floating unlabelled beside a mob name. So this header passes NO tail at all,
        // and every pixel it was holding is width a long mob name gets to use at 380px.
        select={{ rows, value: selection, onChange: selectSegment, accent: GOLD }}
        // ONE small control beside the lock/close pair, on the ZONE kind only (JOS-322). Undefined
        // on a fight meter, so that title bar is byte-for-byte the row it was.
        action={newSession}
        chrome={{ locked, hovering, dragRegion, noDrag, toggleLock, capture }}
      />

      {/* Bars + mini drill-down. Locked mode RENDERS the remembered drill (the pinned "damage by
          type" breakdown the user plays with) but hands MeterBars no setter, so there are no
          click targets, no pointer cursors and no back chevron — the window stays click-through. */}
      {/* The testid names the CLICK-THROUGH half of the locked contract (P3): everything below
          the selector row must offer no hit target at all, and the e2e harness measures exactly
          this box to say so. */}
      {/* EVERY source, not a top-5: the pane scrolls (owner feedback 2026-08-05), and it is also
          the one place the text scale is applied — chrome above and below stays at 1. */}
      {/* …and since JOS-121 the pane's FLOOR carries the scope word that used to sit in the title
          bar: a low-contrast, click-through watermark in a band the bars are padded out of, still
          able to say the long 'Group (no roster yet)' that explains a widened meter. */}
      {/* …and since JOS-138 the pane also carries the SCROLL GRIP: pinned, the strip along its
          right edge takes the mouse while the rows overflow, so the wheel and the scrollbar both
          work there and the rest of the body stays click-through (overlayScale.tsx). */}
      <MeterPane
        textScale={textScale}
        locked={locked}
        capture={capture}
        scope={{ label: chipLabel(meterScope, roster) }}
        notice={<PetNudgeCard nudge={liveNudge(snap)} />}
      >
        <MeterBars
          seg={seg}
          scope={meterScope}
          roster={roster}
          drill={drill}
          setDrill={locked ? null : setDrill}
          live={live}
        />
      </MeterPane>

      {!locked && <MeterFooter bgAlpha={bgAlpha} textScale={textScale} patch={patch} noDrag={noDrag} />}
    </div>
  )
}

/**
 * Footer controls — interactive mode only: bg-alpha slider + text size.
 *
 * CHROME, so it is UNSCALED and must fit whatever window it is in — ONE ROW, always (owner: the
 * A+ was rendering cut off mid-glyph on a narrow meter). The BUTTONS are fixed-size and never
 * shrink; the SLIDER is the give: `flexBasis: 0` + a floor small enough to still be draggable
 * means it absorbs every pixel the row is short, instead of an `<input type=range>`'s intrinsic
 * width pushing the controls that fix a too-small window off the edge of one.
 */
function MeterFooter({
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
        ...FOOTER_ROW,
        ...noDrag,
        gap: 8,
        fontSize: 10,
        color: 'rgba(255,255,255,0.6)'
      }}
    >
      {/* The word IS the label (JOS-358) — the footer names its own controls, it does not hover. */}
      <span style={{ flexShrink: 0 }}>bg</span>
      <input
        type="range"
        min={0.1}
        max={1}
        step={0.02}
        value={bgAlpha}
        onChange={(e) => patch({ bgAlpha: Number(e.target.value) })}
        style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 24, accentColor: GOLD, height: 4 }}
      />
      <TextScaleStepper textScale={textScale} patch={patch} noDrag={noDrag} />
    </div>
  )
}
