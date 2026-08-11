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
// THE SLICE IS THE LEVELING TAB'S (JOS-130) AND ITS DEFAULT IS `session`. That default is the
// ticket's: a window you glance at mid-pull is asking "how am I doing right now", which is this
// session and not the whole record. It DEGRADES rather than sticks — a log stating no logout
// cannot define a session, and `resolveSliceId` falls back to `All` exactly as the tab's own
// control does. The pick is remembered per WINDOW, not shared with the app's: the two are read at
// different moments, and a slice chosen on the Loot tab has no business re-scoping a window
// floating over the game.
//
// IT TICKS ITSELF, for the same reason the timer bars do: deltas arrive when the LOG moves, and a
// slice that ends at the live edge keeps meaning something while the log is silent. The clock is
// SLOW here (30 s, not 1 s) because nothing in this window is a countdown — a rate over an hour
// does not visibly move in a second, and the cost of asking is a whole `rangeStats` fold.
//
// MUI-FREE, plain divs and inline styles, like every file in this bundle.

import { type JSX, useEffect, useMemo, useState } from 'react'
import type { LootDelta, LootEvent, LootSnap, ProgressionDelta, ProgressionSnap } from '@shared/types'
import { availableSlices, resolveSlice, resolveSliceId, sliceLabel, type SliceId } from '@shared/timeslice'
import { toggleXpRow, XP_ROW_IDS, xpRowVisible, type XpRowId } from '@shared/xpOverlay'
import { EMPTY_PROGRESSION, applyProgressionDelta } from '../features/leveling/progressionDelta'
import { dataBounds } from '../features/leveling/zoneBands'
import { OverlayHeader } from './OverlayHeader'
import type { OverlaySelectRow } from './OverlaySelect'
import { OverlayContent } from './overlayScale'
import { TextScaleStepper } from './TextScaleStepper'
import { useOverlayModule } from './useOverlayModule'
import { type OverlayChrome, useOverlayChrome } from './useOverlayChrome'
import { xpOverlayView, type XpOverlayRow } from './xpRows'

/** This window's accent — a cool blue, deliberately none of the three already in use (damage
 *  gold, healing green, debuff red). Two windows that look alike at a glance would be worse. */
const ACCENT = '#8fbfe8'
const ACCENT_BG = 'rgba(143,191,232,0.2)'

/** The `loot` module's whole delta contract: a concat, forever (features/loot/useLootHistory). */
const applyLootDelta = (s: LootSnap, d: LootDelta): LootSnap => [...s, ...d.appended]
const NO_LOOT: LootEvent[] = []
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

/** One printed row: label · number · unit, with the dim detail pushed to the right edge. */
function XpRowLine({ row }: { row: XpOverlayRow }): JSX.Element {
  return (
    <div
      data-testid={`xp-row-${row.id}`}
      data-row={row.row}
      title={row.title}
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
      title={on ? `Hide the ${ROW_LABEL[id]} row` : `Show the ${ROW_LABEL[id]} row`}
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

/** Footer — interactive mode only: the bg-alpha slider, the ROW CHECKLIST, and the text size. */
function XpFooter({
  bgAlpha,
  textScale,
  visible,
  patch,
  noDrag
}: {
  bgAlpha: number
  textScale: number
  visible: XpRowId[] | undefined
  patch: OverlayChrome['patch']
  noDrag: React.CSSProperties
}): JSX.Element {
  return (
    <div
      style={{
        ...noDrag,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 8px 5px',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        fontSize: 10,
        color: 'rgba(255,255,255,0.6)',
        flexShrink: 0
      }}
    >
      <input
        type="range"
        title="Background opacity"
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
      <TextScaleStepper textScale={textScale} patch={patch} noDrag={noDrag} />
    </div>
  )
}

/** The slice picker's rows: every slice THIS record can define, worded as the tab words them. */
function sliceRows(snap: ProgressionSnap, ids: SliceId[], bounds: ReturnType<typeof dataBounds>): OverlaySelectRow[] {
  return ids.map((id) => ({
    value: id,
    label: sliceLabel(id),
    rate: '',
    // The disambiguation line the popup already draws: the slice's own sentence-form wording, so
    // 'Zone' says which zone and 'Session' says what a session is measured from.
    timing: resolveSlice({ snap, bounds, id }).caption,
    live: false
  }))
}

export default function XpOverlay(): JSX.Element {
  // TWO MODULES, and both of them the ones the app itself reads — `progression` for the pace and
  // the projection, `loot` for the mote rates. Neither is re-folded here.
  const prog = useOverlayModule<ProgressionSnap, ProgressionDelta>(
    'progression',
    applyProgressionDelta,
    EMPTY_PROGRESSION
  )
  const loot = useOverlayModule<LootSnap, LootDelta>('loot', applyLootDelta, NO_LOOT)
  const { locked, bgAlpha, textScale, hovering, config, patch, toggleLock, capture, dragRegion, noDrag } =
    useOverlayChrome()
  useSlowClock()

  const bounds = useMemo(() => dataBounds(prog, NO_EXTRA), [prog])
  const available = useMemo(() => availableSlices(prog, bounds), [prog, bounds])
  // ABSENT means `session` — and `resolveSliceId` then degrades it to `All` on a record that
  // cannot define one, which is the same fallback the tab's control performs.
  const id = resolveSliceId(config?.xpSlice ?? 'session', prog, bounds)
  const slice = useMemo(() => resolveSlice({ snap: prog, bounds, id }), [prog, bounds, id])
  const visible = config?.xpRows
  const view = useMemo(
    () => xpOverlayView({ snap: prog, loot, slice, visible }),
    [prog, loot, slice, visible]
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
        tail={view.level === null ? undefined : `lvl ${view.level}`}
        tailTitle="The level the log last reported for this character."
        iconAccentBg={ACCENT_BG}
        select={{ rows: sliceRows(prog, available, bounds), value: id, onChange: (v) => patch({ xpSlice: v as SliceId }), accent: ACCENT }}
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
            that never stated its span lets one drop in five minutes read as a confident 12/hr. */}
        {view.rows.length > 0 && (
          <div
            data-testid="xp-span"
            style={{ fontSize: 9, color: 'rgba(255,255,255,0.38)', padding: '3px 2px 0' }}
          >
            {slice.caption} · {view.span}
          </div>
        )}
      </OverlayContent>

      {!locked && (
        <XpFooter bgAlpha={bgAlpha} textScale={textScale} visible={visible} patch={patch} noDrag={noDrag} />
      )}
    </div>
  )
}
