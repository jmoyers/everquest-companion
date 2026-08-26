// XpOverlay (JOS-195) — the PROGRESS read, floating over the game: how fast the bar is moving,
// when it lands, and motes per hour by type.
//
// Two reports converged on it from opposite ends — "xp/hr + eta overlay" and "a session widget:
// dps, motes gathered, xp, money, configurable" — and the owner's scope is the narrow half of
// that: the numbers a leveller glances at, NUMBERS FIRST AND SMALL, with a ROW CHECKLIST and no
// widget builder. So there are three checklist entries, they can each be switched off, and that is
// the whole of the configurability. An ENTRY IS NOT A LINE COUNT: 'motes' draws one line per tier
// seen, and since JOS-202 'xp' draws one line per pace the log is stating — levels per hour and AA
// per hour, because both bars fill while you level (shared/xpOverlay.ts states the rule).
//
// IT DERIVES NOTHING. Every number is the Leveling tab's own — `rangeStats`, `levelEta`, `aaEta`,
// `windowItemRows` — composed by `overlay/xpRows.ts`, which is pure and node-tested. This file
// draws the result and owns the window: the persisted config, the drag/resize, the slice picker in
// the header, the checklist in the footer. A second rate math in a floating window would be the
// drift `windowScope.ts` exists to prevent, one process further away.
//
// THE SLICE IS THE LEVELING TAB'S (JOS-130) AND ITS DEFAULT IS `Zone + Session` (owner ruling,
// JOS-288 — it was `session` from JOS-195 until then). A window you glance at mid-pull is asking
// "how am I doing right now", and the audit measured what the session half alone does to that
// answer: `levelEquiv` sums straight across a loadout-swap boundary, so a session that began on a
// level-50 leg diluted the level-11 camp that followed it, and the same instant read 7.03 lvl/hr
// scoped to the camp against a figure ten times smaller scoped to the whole log. The camp you are
// standing in, this session, is the stretch the number is about. It DEGRADES rather than sticks — a
// preset this record cannot define is not offered and `resolveSliceId` falls back to `All`, exactly
// as the tab's own control does. The pick is remembered per WINDOW, not shared with the app's: the
// two are read at different moments, and a slice chosen on the Loot tab has no business re-scoping
// a window floating over the game.
//
// AND THE RATES ARE PER ELAPSED HOUR BY DEFAULT (owner ruling 3, JOS-288), with the active reading
// one click away in the footer. Both words are the loot ledger's (JOS-261) and both definitions are
// imported rather than re-worded. The bonus is an honesty the window did not have: the next-level
// ETA has ALWAYS divided by the wall rate while the pace row above it showed the active one, so
// until now those two lines were measured over different hours.
//
// THE TIER AND THE HOUR ARE NOT THIS WINDOW'S TO REMEMBER ANY MORE (JOS-332). They used to be two
// more persisted per-kind knobs beside the row checklist, on the argument that an overlay remembers
// everything about itself — and the owner's bug report is what that argument cost: he had *this
// tier* on screen over the game and read `elapsed 27m` off the Leveling tab, which is the every-tier
// number, because the two windows kept two states behind one label. So both knobs now read and
// write the ONE app-wide selection main holds (`shared/scopeSelection.ts`), the footer buttons flip
// it for every window at once, and the tab's toggle row flips it for this one. The SLICE is
// untouched and still remembered here: which stretch a floating window measures is genuinely its
// own business (`shared/types.ts xpSlice` states why), and it is not a knob the tab also shows.
//
// IT TICKS ITSELF, for the same reason the timer bars do: deltas arrive when the LOG moves, and a
// slice that ends at the live edge keeps meaning something while the log is silent. The clock is
// SLOW here (30 s, not 1 s) because nothing in this window is a countdown — a rate over an hour
// does not visibly move in a second, and the cost of asking is a whole `rangeStats` fold.
//
// MUI-FREE, plain divs and inline styles, like every file in this bundle.

import { type JSX, useEffect, useMemo, useState } from 'react'
import type {
  CharacterSnap,
  LootEvent,
  LootSnap,
  OverlayConfig,
  ProgressionSnap
} from '@shared/types'
import {
  availableSlices,
  resolveSlice,
  resolveSliceId,
  sliceLabel,
  type SliceId,
  type Timeslice
} from '@shared/timeslice'
import { toggleXpRow, XP_ROW_IDS, xpRowVisible, type XpRowId } from '@shared/xpOverlay'
import { toggleRateBasis, type RateBasis } from '@shared/rateBasis'
import { ZONE_SCOPE_LABEL, toggleZoneScope, type ZoneScope } from '@shared/zoneScope'
import { EMPTY_PROGRESSION } from '../features/leveling/progressionDelta'
// THE APP-WIDE SCOPE SELECTION (JOS-332) — the same hook the Leveling tab's toggle row calls, over
// this window's own bridge. MUI-free by that file's own law, which is what lets this bundle import
// a module that lives under `features/`.
import { useScopeSelection } from '../features/timeslice/useScopeSelection'
import { dataBounds } from '../features/leveling/zoneBands'
// The two definitions of the two hours, imported and never re-worded (JOS-249 / JOS-261).
import { BASIS_TITLE } from '../features/leveling/rangeStatsRows'
import { OverlayHeader } from './OverlayHeader'
import type { OverlaySelectRow } from './OverlaySelect'
import { FOOTER_ROW, OverlayContent } from './overlayScale'
import { TextScaleStepper } from './TextScaleStepper'
import { useOverlayModule } from './useOverlayModule'
import { type OverlayChrome, useOverlayChrome } from './useOverlayChrome'
import { xpOverlayView, type XpOverlayRow } from './xpRows'

/** This window's accent — a cool blue, deliberately none of the three already in use (damage
 *  gold, healing green, debuff red). Two windows that look alike at a glance would be worse. */
const ACCENT = '#8fbfe8'
const ACCENT_BG = 'rgba(143,191,232,0.2)'

const NO_LOOT: LootEvent[] = []
const NO_CHARACTER: CharacterSnap = { character: null }
/** `dataBounds` takes the series the caller draws on top of the snapshot; this window draws none
 *  (the progression columns already carry the dings and the AA gains). Stable, so the memo holds. */
const NO_EXTRA: readonly number[] = []

/** How often the numbers are re-folded while the log is silent — see the file header. */
const TICK_MS = 30_000

/** The row checklist's button labels. The ids are `XpRowId`; these are what a user reads. 'xp' is
 *  the PACE entry — one button over however many pace lines the log can currently state. */
const ROW_LABEL: Record<XpRowId, string> = { xp: 'xp', eta: 'next', motes: 'motes' }

/** A slow local clock, so a slice that ends at the live edge keeps re-reading while nothing
 *  arrives. It asks main for nothing — the fold is over state this window already holds. */
function useSlowClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now())
    }, TICK_MS)
    return () => {
      clearInterval(id)
    }
  }, [])
  return now
}

/** One printed row: label · number · unit, with the dim detail pushed to the right edge.
 *  NO HOVER (JOS-358) — see the file header: what a row can say, it says in the open. */
function XpRowLine({ row }: { row: XpOverlayRow }): JSX.Element {
  return (
    <div
      data-testid={`xp-row-${row.id}`}
      data-row={row.row}
      style={{ display: 'flex', alignItems: 'baseline', gap: 5, padding: '2px 2px' }}
    >
      <span
        style={{
          fontSize: 9,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
          color: 'rgba(255,255,255,0.45)',
          flexShrink: 0,
          minWidth: 54
        }}
      >
        {row.label}
      </span>
      {/* NUMBERS FIRST (the ticket's word): the value is the biggest thing on the row and the unit
          rides its baseline, so a glance lands on the figure rather than on the vocabulary. */}
      {/* `xp-value`, NOT `xp-row-value`: a reader selecting `[data-testid^="xp-row-"]` wants the
          ROWS, and a child sharing that prefix turns every count into a double count. JOS-119's
          `kind=buffs` inside `kind=debuffs` is the same lesson, one nesting level down. */}
      <span
        data-testid="xp-value"
        style={{ fontSize: 15, fontWeight: 700, color: ACCENT, fontVariantNumeric: 'tabular-nums' }}
      >
        {row.value}
      </span>
      {row.unit !== '' && <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>{row.unit}</span>}
      <span style={{ flexGrow: 1 }} />
      {row.detail !== '' && (
        <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.42)', whiteSpace: 'nowrap' }}>{row.detail}</span>
      )}
    </div>
  )
}

/** One checklist button — pressed = the row is drawn. The two-state shape the timer windows'
 *  grouping button already uses, three times over. */
function RowToggle({
  id,
  on,
  onClick,
  noDrag
}: {
  id: XpRowId
  on: boolean
  onClick: () => void
  noDrag: React.CSSProperties
}): JSX.Element {
  return (
    <button
      type="button"
      data-testid={`xp-toggle-${id}`}
      data-on={on ? 'true' : 'false'}
      aria-pressed={on}
      // ARIA name, not a tooltip (JOS-358): a footer control on an overlay window.
      aria-label={on ? `Hide the ${ROW_LABEL[id]} row` : `Show the ${ROW_LABEL[id]} row`}
      onClick={onClick}
      style={{
        ...noDrag,
        flexShrink: 0,
        background: on ? ACCENT_BG : 'transparent',
        border: `1px solid ${on ? `${ACCENT}66` : 'rgba(255,255,255,0.14)'}`,
        borderRadius: 4,
        color: on ? ACCENT : 'rgba(255,255,255,0.5)',
        fontSize: 9,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        padding: '1px 5px',
        cursor: 'pointer'
      }}
    >
      {ROW_LABEL[id]}
    </button>
  )
}

/**
 * THE DENOMINATOR TOGGLE (JOS-288) — one button, two states, the word in force printed on it.
 *
 * It is a BUTTON RATHER THAN A PAIR OF THEM because there are exactly two honest denominators and a
 * two-option segmented control spends twice the width of this footer's whole budget to say the same
 * thing. It reads as a statement first ("these rates are per elapsed hour") and as a control second,
 * which is the right order for a number the reader is already looking at. The full definition of the
 * hour in force used to ride a hover; since JOS-358 it is the button's ARIA name, because these
 * windows carry tooltips only in the title bar — the WORD on the button is the state, and the state
 * is what a reader glancing over a game needs.
 */
function BasisToggle({
  basis,
  onClick,
  noDrag
}: {
  basis: RateBasis
  onClick: () => void
  noDrag: React.CSSProperties
}): JSX.Element {
  const other: RateBasis = basis === 'elapsed' ? 'active' : 'elapsed'
  return (
    <button
      type="button"
      data-testid="xp-basis"
      data-basis={basis}
      aria-label={`Rates are per hour of ${basis} time. Click for ${other} time. ${BASIS_TITLE[basis]}`}
      onClick={onClick}
      style={{
        ...noDrag,
        flexShrink: 0,
        background: ACCENT_BG,
        border: `1px solid ${ACCENT}66`,
        borderRadius: 4,
        color: ACCENT,
        fontSize: 9,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        padding: '1px 5px',
        cursor: 'pointer'
      }}
    >
      {basis}
    </button>
  )
}

/**
 * THE MEMBERSHIP TOGGLE (JOS-291) — one button, two states, the membership in force printed on it.
 *
 * A button rather than a pair, for `BasisToggle`'s reason: two states, and this footer's whole width
 * budget is smaller than a segmented control's. It is drawn ONLY while the slice carries a zone —
 * `every tier` of nothing is not a state a reader can act on. The definition and the promise of the
 * other state are its ARIA name rather than a hover (JOS-358).
 */
function TierToggle({
  scope,
  zoneName,
  onClick,
  noDrag
}: {
  scope: ZoneScope
  zoneName: string
  onClick: () => void
  noDrag: React.CSSProperties
}): JSX.Element {
  const other = toggleZoneScope(scope)
  const meaning =
    scope === 'allTiers'
      ? `Every tier of ${zoneName} counts - the difficulty spelled into the zone name is folded away.`
      : `Only ${zoneName} counts - the other tiers of the same camp are out.`
  return (
    <button
      type="button"
      data-testid="xp-tier"
      data-scope={scope}
      aria-label={`${meaning} Click for ${ZONE_SCOPE_LABEL[other]}.`}
      onClick={onClick}
      style={{
        ...noDrag,
        flexShrink: 0,
        background: ACCENT_BG,
        border: `1px solid ${ACCENT}66`,
        borderRadius: 4,
        color: ACCENT,
        fontSize: 9,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        padding: '1px 5px',
        cursor: 'pointer'
      }}
    >
      {ZONE_SCOPE_LABEL[scope]}
    </button>
  )
}

/**
 * Footer — interactive mode only: the bg-alpha slider, the ROW CHECKLIST, the ZONE MEMBERSHIP and
 * DENOMINATOR toggles, and the text size.
 *
 * TWO KINDS OF KNOB SIT ON THIS ONE ROW, and since JOS-332 they are written through two different
 * doors on purpose. The alpha, the rows and the text size are about THIS WINDOW and go through
 * `patch` into its persisted per-kind config. The membership and the denominator are about the
 * NUMBERS, are shared with the Leveling tab, and go through the app-wide selection main holds. The
 * row looks identical either way; the difference is who else has to hear about the press.
 */
function XpFooter({
  bgAlpha,
  textScale,
  visible,
  basis,
  slice,
  patch,
  setZoneScope,
  setBasis,
  noDrag
}: {
  bgAlpha: number
  textScale: number
  visible: XpRowId[] | undefined
  basis: RateBasis
  /** The resolved slice — read for its zone half only: whether the tier toggle applies, and what
   *  the camp is called on its hover. */
  slice: Timeslice
  patch: OverlayChrome['patch']
  /** The app-wide setters (`useScopeSelection`) — NOT `patch`: these two move every window. */
  setZoneScope: (next: ZoneScope) => void
  setBasis: (next: RateBasis) => void
  noDrag: React.CSSProperties
}): JSX.Element {
  return (
    <div
      style={{
        ...FOOTER_ROW,
        ...noDrag,
        gap: 6,
        fontSize: 10,
        color: 'rgba(255,255,255,0.6)'
      }}
    >
      {/* No hover on the slider (JOS-358); it looks like what it is. */}
      <input
        type="range"
        aria-label="Background opacity"
        min={0.1}
        max={1}
        step={0.02}
        value={bgAlpha}
        onChange={(e) => {
          patch({ bgAlpha: Number(e.target.value) })
        }}
        style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 20, accentColor: ACCENT, height: 4 }}
      />
      {/* THE WHOLE OF THE CONFIGURABILITY (owner scope). Each press writes the SAME persisted
          per-kind config the alpha slider beside it writes, so the window remembers its rows the
          way it remembers its position. */}
      {XP_ROW_IDS.map((id) => (
        <RowToggle
          key={id}
          id={id}
          on={xpRowVisible(id, visible)}
          onClick={() => {
            patch({ xpRows: toggleXpRow(id, visible) })
          }}
          noDrag={noDrag}
        />
      ))}
      {/* WHICH TIERS, beside WHICH ROWS — but through the APP-WIDE selection, not this window's
          config (JOS-332): pressing it moves the Leveling tab's toggle too, which is the whole
          point of the ticket. Drawn only while the slice names a zone (the `ZoneScopeBar` rule, in
          a floating window). */}
      {slice.zoneName !== null && (
        <TierToggle
          scope={slice.zoneScope}
          zoneName={slice.zoneName}
          onClick={() => {
            setZoneScope(toggleZoneScope(slice.zoneScope))
          }}
          noDrag={noDrag}
        />
      )}
      {/* WHICH HOUR, beside WHICH ROWS — the same app-wide selection, the same one press. */}
      <BasisToggle
        basis={basis}
        onClick={() => {
          setBasis(toggleRateBasis(basis))
        }}
        noDrag={noDrag}
      />
      <TextScaleStepper textScale={textScale} patch={patch} noDrag={noDrag} />
    </div>
  )
}

/**
 * The slice picker's rows: every slice THIS record can define, worded as the tab words them.
 *
 * The membership in force is passed in rather than defaulted, so the two zone rows are worded with
 * the same clause the span line under the numbers will use — a picker that read `every tier` while
 * the window measured one would be the caption drift this whole option is about, inside the control
 * that sets it.
 */
function sliceRows(
  snap: ProgressionSnap,
  ids: SliceId[],
  bounds: ReturnType<typeof dataBounds>,
  zoneScope: ZoneScope
): OverlaySelectRow[] {
  return ids.map((id) => ({
    value: id,
    label: sliceLabel(id),
    rate: '',
    // The disambiguation line the popup already draws: the slice's own sentence-form wording, so
    // 'Zone' says which zone and 'Session' says what a session is measured from.
    timing: resolveSlice({ snap, bounds, id, zoneScope }).caption,
    live: false
  }))
}

/**
 * WHICH STRETCH THIS WINDOW IS ON, out of its own persisted config: the slice pick degraded to what
 * the record can define, and the zone membership applied to it.
 *
 * Its own hook so the component stays inside the measured complexity ceiling, and so the two knobs
 * that describe ONE scope are read in one place — a window resolving its slice here and its
 * membership somewhere else is how a caption ends up describing numbers it did not measure.
 */
function useXpSlice(
  prog: ProgressionSnap,
  bounds: ReturnType<typeof dataBounds>,
  config: OverlayConfig | null,
  zoneScope: ZoneScope
): { id: SliceId; slice: Timeslice } {
  // ABSENT means `zoneSession` — and `resolveSliceId` then degrades it to `All` on a record that
  // cannot define one, which is the same fallback the tab's control performs. The SLICE is still
  // this window's own persisted knob (shared/types.ts states why); the MEMBERSHIP is not, since
  // JOS-332 — it arrives as an argument, out of the one selection main holds for every window.
  const id = resolveSliceId(config?.xpSlice ?? 'zoneSession', prog, bounds)
  const slice = useMemo(
    () => resolveSlice({ snap: prog, bounds, id, zoneScope }),
    [prog, bounds, id, zoneScope]
  )
  return { id, slice }
}

export default function XpOverlay(): JSX.Element {
  // TWO MODULES, and both of them the ones the app itself reads — `progression` for the pace and
  // the projection, `loot` for the mote rates. Neither is re-folded here.
  const prog = useOverlayModule<ProgressionSnap>('progression', EMPTY_PROGRESSION)
  const loot = useOverlayModule<LootSnap>('loot', NO_LOOT)
  // THE THIRD (JOS-192) — `character`, for one field: the level the log last STATED. The ding
  // series is silent across a loadout swap, so a floating window that reads only the dings keeps
  // announcing the level of a class you are no longer running; your own `/who` row is what
  // corrects it, and it arrives here.
  const who = useOverlayModule<CharacterSnap>('character', NO_CHARACTER)
  const { locked, bgAlpha, textScale, hovering, config, patch, toggleLock, capture, dragRegion, noDrag } =
    useOverlayChrome()
  useSlowClock()

  // THE TWO KNOBS THIS WINDOW SHARES WITH THE APP (JOS-332) — which tiers count, and which hour
  // the rates divide by. They come from main through the SAME hook the Leveling tab's toggle row
  // uses, over the same three bridge members under the same names, so a flip in either place moves
  // both. The window's own persisted config still owns everything that is genuinely about THIS
  // window: its bounds, its lock, its alpha, its text size, its row checklist and its slice.
  const { zoneScope, basis, setZoneScope, setBasis } = useScopeSelection(window.eqOverlay)
  const bounds = useMemo(() => dataBounds(prog, NO_EXTRA), [prog])
  const available = useMemo(() => availableSlices(prog, bounds), [prog, bounds])
  // The scope both knobs describe, resolved together (see `useXpSlice`) — so the caption and every
  // number below travel with the same slice AND the same membership by construction.
  const { id, slice } = useXpSlice(prog, bounds, config, zoneScope)
  const visible = config?.xpRows
  const view = useMemo(
    () => xpOverlayView({ snap: prog, loot, slice, visible, level: who.level, basis }),
    [prog, loot, slice, visible, who.level, basis]
  )

  return (
    <div
      data-testid="xp-overlay"
      style={{
        // 100%, NOT 100vw/100vh — a viewport unit inside the scaled content pane resolves against
        // the window and is then zoomed (overlayScale).
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Inter, "Segoe UI", Roboto, system-ui, sans-serif',
        color: '#f2f2f2',
        background: `rgba(14,17,21,${bgAlpha})`,
        border: locked ? '1px solid rgba(255,255,255,0.04)' : `1px solid ${ACCENT}66`,
        borderRadius: 8,
        boxSizing: 'border-box',
        overflow: 'hidden'
      }}
    >
      {/* The slice picker rides the header exactly as the meters' fight picker does — including
          while PINNED, through the same named-reason hover sensor (`capture`). "Which stretch am
          I looking at" is this window's version of "which fight am I watching": the one question a
          click-through window still has to be able to answer. */}
      <OverlayHeader
        tag="XP"
        title={sliceLabel(id)}
        titleColor={ACCENT}
        tail={view.level === null ? undefined : `lvl ${view.level}${view.levelCue ? ` ${view.levelCue}` : ''}`}
        tailTitle={view.levelTitle}
        iconAccentBg={ACCENT_BG}
        select={{ rows: sliceRows(prog, available, bounds, zoneScope), value: id, onChange: (v) => patch({ xpSlice: v as SliceId }), accent: ACCENT }}
        chrome={{ locked, hovering, dragRegion, noDrag, toggleLock, capture }}
      />

      <OverlayContent textScale={textScale} testId="xp-rows" locked={locked} capture={capture}>
        {view.rows.length === 0 ? (
          // Every row switched off is a STATE the user chose, and it says so rather than leaving a
          // blank box that reads as a broken window.
          <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.5)', padding: '8px 2px' }}>
            No rows selected - unpin this window and pick some.
          </div>
        ) : (
          view.rows.map((r) => <XpRowLine key={r.id} row={r} />)
        )}
        {/* ONE SPAN FOR THE WHOLE WINDOW, stated once rather than repeated on every row — a rate
            that never stated its span lets one drop in five minutes read as a confident 12/hr. It
            is also owner ruling 2 (JOS-288): the time spent in the current scope so far, which is
            the very denominator the rates above divided by, so the two cannot disagree. */}
        {view.rows.length > 0 && (
          <div
            data-testid="xp-span"
            // WHAT THAT SPAN IS used to ride a hover here (JOS-249/JOS-288). JOS-358 takes it: the
            // caption already names the stretch and the `· too short to rate` marker below already
            // says when it cannot be divided by, both in the open.
            style={{ fontSize: 9, color: 'rgba(255,255,255,0.38)', padding: '3px 2px 0' }}
          >
            {slice.caption} · {view.span}
            {/* JUST ARRIVED, SAID ONCE. Four em-dashes with no explanation on a window this small
                read as a broken window; the rows carry the reason on hover and this carries it in
                the open, exactly where the span it is about is printed. */}
            {!view.measurable && <span data-testid="xp-too-short"> · too short to rate</span>}
          </div>
        )}
      </OverlayContent>

      {!locked && (
        <XpFooter
          bgAlpha={bgAlpha}
          textScale={textScale}
          visible={visible}
          basis={basis}
          slice={slice}
          patch={patch}
          setZoneScope={setZoneScope}
          setBasis={setBasis}
          noDrag={noDrag}
        />
      )}
    </div>
  )
}
