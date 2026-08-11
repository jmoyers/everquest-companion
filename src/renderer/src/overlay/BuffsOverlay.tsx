// BuffsOverlay (JOS-89; split into TWO WINDOWS by JOS-119) — the timer-bar surface, rendered once
// per timer kind: 'buffs' draws the beneficial spells you have running, 'debuffs' draws what you
// have put on something else (debuffs plus the per-enemy crowd-control clocks, so a chain-mez
// shows a named countdown per enemy). Design record: docs/plans/buff-timer-overlay.md.
//
// Ten user reports converge on this window; the owner then asked for the two halves to be windows
// he could enable and place separately, because "what is on me" and "what is on them" are read at
// different moments and belong in different corners of the screen. Both ship DEFAULT OFF (store.ts
// DEFAULT_OVERLAY_CONFIG, no migration) — JOS-89's internal-validation stance, continued.
//
// ONE COMPONENT, TWO KINDS — the JOS-105 no-fork rule, and a copy of this file would be a defect.
// Everything that differs between the two windows is DATA (`SURFACE` below): the chrome label, the
// accent, the empty-state sentence, the heading a self row sits under, and which rows the surface
// keeps. Everything else — the modules, the projection, the clock, the chrome, the footer — is
// literally the same code running twice.
//
// A sibling of OverlayMeter and EventLogOverlay in the SAME overlay.html bundle (kind read from
// `?kind=`), so it shares every piece of per-kind machinery: the persisted `overlays.<kind>`
// config, drag/resize, the bg-alpha slider, the text-scale stepper and the lock (pin) semantics.
// Plain divs + inline styles, no MUI — the window has to be cheap to paint over the game.
//
// DATA: TWO modules, composed by ONE pure function, FOLDED ONCE — and then filtered. `buffs` owns
// the instances (self buffs, per-target debuffs, the DB duration prior, own-cast gating, the
// death/zone censoring); the small `buffTimers` module owns the per-target mez holds the buff
// model does not track. Neither is re-folded here and NEITHER IS FORKED FOR THE SECOND WINDOW —
// `shared/buffTimers.ts buildTimerRows` is the projection, `rowsForSurface` is the one-line split,
// both are pure, and tests/buffTimers.test.mts drives them over real fixture bytes. This file only
// draws the result. Two windows, one model: a second fold of the same events is the two-models
// scar world-model law 4 is made of.
//
// THE HONESTY LAW ON SCREEN: a receding bar means spells.json STATED a duration. A row with no
// bar and a `+` before its time is counting UP because nobody states one. The overlay never
// renders a remaining it had to invent — see buffTimerBars.tsx.
//
// WHY IT TICKS ITSELF: the module deltas arrive when the LOG moves, and a buff running out is
// precisely the moment the log is silent. A 1 Hz local clock re-reads rows the renderer already
// holds; it asks main for nothing.

import { type JSX, useEffect, useMemo, useRef, useState } from 'react'
import type { BuffsSnap, ModuleDelta } from '@shared/types'
import {
  type BuffTimerRow,
  type BuffTimersSnap,
  type TimerGrouping,
  type TimerOverlayKind,
  buildTimerRows,
  orderTimerRows,
  rowsForSurface,
  timerDrops
} from '@shared/buffTimers'
import { OverlayHeader } from './OverlayHeader'
import { OverlayContent } from './overlayScale'
import { TextScaleStepper } from './TextScaleStepper'
import { type OverlayChrome, useOverlayChrome } from './useOverlayChrome'
import { BuffTimerGroup } from './buffTimerBars'

const GOLD = '#d9b25f'
/** The debuff accent, and deliberately the same red `buffTimerBars.rowAccent` already gives a
 *  debuff row — two windows that look alike at a glance would be worse than one. */
const RED = '#e07a6a'

const EMPTY_BUFFS: BuffsSnap = { active: [], stats: {} }
const EMPTY_TIMERS: BuffTimersSnap = { holds: [], ends: [] }

/**
 * EVERYTHING THAT DIFFERS BETWEEN THE TWO WINDOWS, as data (JOS-119).
 *
 * If a change to one surface cannot be expressed as a row in this table, it is a change to BOTH
 * surfaces and belongs in the component — that is the whole test for whether the no-fork rule is
 * still holding.
 *
 * `dropFlash` is only on the buffs surface on purpose. The flash answers one of the ten reports —
 * "flash/alert when a positive spell drops" — and a debuff or a mez ending is not a loss the
 * player needs shouting at them; on the debuffs window the row simply leaves, which is the same
 * information without the noise.
 */
const SURFACE: Record<
  TimerOverlayKind,
  {
    tag: string
    title: string
    accent: string
    tailTitle: string
    selfLabel: string
    empty: string
    dropFlash: boolean
    /**
     * How this window arranges its rows when the user has not said (JOS-140, owner amendment).
     * The two differ on purpose: the DEBUFFS window is a queue of things running out, so it opens
     * FLAT with the soonest at the top; the BUFFS window answers "what is on me" and "what is on
     * my pet" separately, so it keeps its per-target blocks. Either can be set to either.
     */
    grouping: TimerGrouping
  }
> = {
  buffs: {
    tag: 'BUFFS',
    title: 'Buffs',
    accent: GOLD,
    tailTitle: 'Buffs you have running',
    selfLabel: 'Your buffs',
    empty: 'Watching for buffs you cast…',
    dropFlash: true,
    grouping: 'target'
  },
  debuffs: {
    tag: 'DEBUFFS',
    title: 'Debuffs',
    accent: RED,
    tailTitle: 'Debuffs and crowd control you are holding',
    // A debuff standing on YOU is still a target row in the model's sense of "not a buff of
    // yours", so it needs a heading that is not the buffs window's "Your buffs".
    selfLabel: 'On you',
    empty: 'Watching for debuffs you land and mez you hold…',
    dropFlash: false,
    grouping: 'none'
  }
}

/**
 * Hydrate one whole-snapshot module and ride its deltas. Both modules here ship their ENTIRE
 * state on every flush (`BuffsDelta = BuffsSnap`, `BuffTimersDelta = BuffTimersSnap`), so
 * applying a delta is a replace and there is nothing to accumulate.
 *
 * A `log:character` rebuild resets a module and its seq restarts low, so a delta whose seq went
 * BACKWARDS re-hydrates rather than being dropped forever — the same rule `useModule` enforces in
 * the app and `EventLogOverlay` enforces here.
 *
 * …AND THE REBUILD SIGNAL ITSELF, SINCE JOS-172. Riding deltas was never enough on its own: a
 * historical fold pushes NOTHING (the registry discards what it accumulated), so a window that
 * hydrated part-way through one — which is every overlay that was already open when the app
 * started — waited for a live event to touch this module before it could learn what the fold had
 * rebuilt. For a long debuff on a mob (a charm, an Ensnare) that event may never come. `onCharacter`
 * is main saying the world was rebuilt, and it is the same signal, on the same channel, that the
 * main window's `useModule` has always re-hydrated on.
 *
 * IT ALSO REPORTS HOW MANY TIMES IT HAS HYDRATED, because a row set that changed because we asked
 * again is not the same event as a row set that changed because the model moved — see
 * `useDropFlash`.
 */
function useWholeSnapshot<S>(moduleId: string, empty: S): { state: S; hydrations: number } {
  const [state, setState] = useState<S>(empty)
  const [hydrations, setHydrations] = useState(0)
  const seqRef = useRef(-1)

  useEffect(() => {
    let alive = true
    const hydrate = (): void => {
      void window.eqOverlay.getModuleSnapshot<S>(moduleId).then((snap) => {
        if (!alive || !snap) return
        seqRef.current = snap.seq
        setState(snap.state)
        setHydrations((n) => n + 1)
      })
    }
    hydrate()
    const off = window.eqOverlay.onModuleDelta<S>((d: ModuleDelta<S>) => {
      if (d.moduleId !== moduleId) return
      if (d.seq <= seqRef.current) {
        if (d.seq < seqRef.current) hydrate()
        return
      }
      seqRef.current = d.seq
      setState(d.delta)
    })
    const offChar = window.eqOverlay.onCharacter(() => {
      hydrate()
    })
    return () => {
      alive = false
      off()
      offChar()
    }
  }, [moduleId])

  return { state, hydrations }
}

/** A local 1 Hz clock. A timer must recede while the log is idle, which is exactly when no delta
 *  is coming; every row already carries its own `startedTs`, so this costs one render a second
 *  and zero IPC. */
function useSecondsClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(id)
    }
  }, [])
  return now
}

/**
 * "Flash when a positive spell drops" — one of the ten reports' asks, and pure renderer state.
 *
 * WHAT it may say is `timerDrops` (shared/buffTimers.ts), where it is a pure function over two row
 * sets and is unit-tested; this hook is only WHEN to ask. It watches the row set it is ALREADY
 * holding, so it can never announce a drop the model did not believe.
 *
 * `hydrations` is the JOS-172 guard, and it is why the rebuilt-world signal above is safe to add:
 * the count changes exactly when a row set arrived from a fresh SNAPSHOT rather than from a delta,
 * and rows that vanish across a re-fold of the whole log are not drops the player just suffered.
 * On a cold start with this window already open, the mid-fold hydrate and the post-fold one differ
 * by whatever wore off during the months in between — every one of which would otherwise flash.
 */
function useDropFlash(
  rows: BuffTimerRow[],
  nowMs: number,
  hydrations: number
): { id: string; name: string; at: number }[] {
  const prevRef = useRef<BuffTimerRow[] | null>(null)
  const hydrationsRef = useRef(hydrations)
  const [drops, setDrops] = useState<{ id: string; name: string; at: number }[]>([])

  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = rows
    const rebuilt = hydrationsRef.current !== hydrations
    hydrationsRef.current = hydrations
    const gone = timerDrops(prev, rows, { rebuilt }).map((d) => ({ ...d, at: Date.now() }))
    if (gone.length === 0) return
    // KEYED BY ROW ID, and one line per buff: a re-cast that drops again while the first notice
    // is still up replaces it rather than stacking a second identical line. (Without this the
    // window really did print "Valor dropped" three times — measured in the e2e.) The effect can
    // also run more than once for one transition (two modules, two deltas, StrictMode), and
    // deduping on the id makes that structurally harmless instead of merely unlikely.
    setDrops((d) => [...d.filter((x) => !gone.some((g) => g.id === x.id)), ...gone].slice(-3))
  }, [rows, hydrations])

  return drops.filter((d) => nowMs - d.at < DROP_FLASH_MS)
}

const DROP_FLASH_MS = 6_000

/** Footer — interactive mode only: the bg-alpha slider + text size, matching every other kind. */
function BuffsFooter({
  bgAlpha,
  textScale,
  grouping,
  patch,
  noDrag,
  accent
}: {
  bgAlpha: number
  textScale: number
  grouping: TimerGrouping
  patch: OverlayChrome['patch']
  noDrag: React.CSSProperties
  accent: string
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
        onChange={(e) => {
          patch({ bgAlpha: Number(e.target.value) })
        }}
        style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 24, accentColor: accent, height: 4 }}
      />
      {/* THE ROW ARRANGEMENT (JOS-140), a two-state button rather than a select: there are exactly
          two answers and the label states the one you would get by pressing it, which is the same
          shape the lock pin already uses. It writes through the SAME persisted per-kind config as
          the alpha slider beside it, so each window remembers its own answer. */}
      <button
        type="button"
        data-testid="buff-timer-grouping"
        data-grouping={grouping}
        title={
          grouping === 'none'
            ? 'Sorted by time left. Press to group by target instead.'
            : 'Grouped by target. Press to sort by time left instead.'
        }
        onClick={() => {
          patch({ grouping: grouping === 'none' ? 'target' : 'none' })
        }}
        style={{
          ...noDrag,
          flexShrink: 0,
          background: 'transparent',
          border: '1px solid rgba(255,255,255,0.14)',
          borderRadius: 4,
          color: 'rgba(255,255,255,0.7)',
          fontSize: 9,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
          padding: '1px 5px',
          cursor: 'pointer'
        }}
      >
        {grouping === 'none' ? 'time left' : 'by target'}
      </button>
      <TextScaleStepper textScale={textScale} patch={patch} noDrag={noDrag} />
    </div>
  )
}

/**
 * Cut the ordered rows into the blocks the eye reads.
 *
 * 'none' is ONE block with NO heading (JOS-140, the debuffs window's default): a flat list sorted
 * soonest-to-expire, where the target is a detail on the row rather than a section it lives under.
 * 'target' is the original: self rows first, then one contiguous block per target, labelled.
 * `selfLabel` is the one per-surface word (SURFACE).
 */
function groupRows(
  rows: BuffTimerRow[],
  selfLabel: string,
  grouping: TimerGrouping
): { key: string; label: string; inferred: boolean; rows: BuffTimerRow[] }[] {
  if (grouping === 'none') {
    return rows.length === 0 ? [] : [{ key: 'all', label: '', inferred: false, rows }]
  }
  const out: { key: string; label: string; inferred: boolean; rows: BuffTimerRow[] }[] = []
  for (const row of rows) {
    const key = row.group === 'self' ? 'self' : (row.targetKey ?? 'unknown')
    const last = out[out.length - 1]
    if (last?.key === key) {
      last.rows.push(row)
      last.inferred = last.inferred || row.inferredTarget === true
      continue
    }
    out.push({
      key,
      label: row.group === 'self' ? selfLabel : (row.target ?? 'Unknown target'),
      inferred: row.inferredTarget === true,
      rows: [row]
    })
  }
  return out
}

export default function BuffsOverlay({ kind }: { kind: TimerOverlayKind }): JSX.Element {
  const surface = SURFACE[kind]
  // BOTH kinds read BOTH modules. The window is a view; the model is not sliced per window, and
  // `rowsForSurface` below is the only thing that knows these are two windows at all.
  const { state: buffs, hydrations: buffsHydrations } = useWholeSnapshot<BuffsSnap>('buffs', EMPTY_BUFFS)
  const { state: timers, hydrations: timersHydrations } = useWholeSnapshot<BuffTimersSnap>(
    'buffTimers',
    EMPTY_TIMERS
  )
  const nowMs = useSecondsClock()
  const { locked, bgAlpha, textScale, hovering, config, patch, toggleLock, onEnter, onLeave, dragRegion, noDrag } =
    useOverlayChrome()

  // ABSENT means "this window's default", which is not the same for both — see SURFACE.
  const grouping = config?.grouping ?? surface.grouping
  const rows = useMemo(
    () => orderTimerRows(rowsForSurface(buildTimerRows(buffs, timers), kind), grouping),
    [buffs, timers, kind, grouping]
  )
  const groups = useMemo(() => groupRows(rows, surface.selfLabel, grouping), [rows, surface.selfLabel, grouping])
  // ONE COUNTER OVER BOTH MODULES: either one re-hydrating is a rebuilt row set, and the two
  // snapshots land as two separate promises — so a sum, which changes on each of them.
  const drops = useDropFlash(rows, nowMs, buffsHydrations + timersHydrations)

  return (
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      data-testid={`${kind}-overlay`}
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
        border: locked ? '1px solid rgba(255,255,255,0.04)' : `1px solid ${surface.accent}66`,
        borderRadius: 8,
        boxSizing: 'border-box',
        overflow: 'hidden'
      }}
    >
      {/* The same one-row header every kind draws, minus the selector: this kind has nothing to
          select — it shows what is on you and on your targets right now, which is one live set,
          not a set of segments. The lock pin and the close ✕ come from HeaderControls. */}
      <OverlayHeader
        tag={surface.tag}
        title={surface.title}
        titleColor={surface.accent}
        tail={String(rows.length)}
        tailTitle={surface.tailTitle}
        tailColor="rgba(255,255,255,0.5)"
        chrome={{ locked, hovering, dragRegion, noDrag, toggleLock }}
      />

      {/* A growing list in a fixed-height scroll box (AGENTS.md: a growing list never sizes to its
          content), which is also the one place the text scale applies — the chrome above and
          below stays at 1 so it cannot be pushed out of a small window. */}
      <OverlayContent textScale={textScale} testId="buff-timer-rows">
        {groups.length === 0 ? (
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', padding: '8px 2px' }}>{surface.empty}</div>
        ) : (
          groups.map((g) => (
            <BuffTimerGroup key={g.key} label={g.label} inferred={g.inferred} rows={g.rows} nowMs={nowMs} />
          ))
        )}

        {surface.dropFlash &&
          drops.map((d) => (
            <div key={d.id} data-testid="buff-timer-drop" style={{ fontSize: 10, color: RED, padding: '2px 4px' }}>
              {d.name} dropped
            </div>
          ))}
      </OverlayContent>

      {!locked && (
        <BuffsFooter
          bgAlpha={bgAlpha}
          textScale={textScale}
          grouping={grouping}
          patch={patch}
          noDrag={noDrag}
          accent={surface.accent}
        />
      )}
    </div>
  )
}
