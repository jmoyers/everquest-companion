// AlertBannerOverlay — the 'alertBanner' overlay kind (JOS-378, shared/alertBanner.ts).
//
// A transparent strip a third of the way down the screen that USUALLY RENDERS NOTHING. The main
// window's always-mounted AlertPlayer sends one finished line per firing (`alerts:banner`); main
// relays it here; this component queues, times and dismisses it locally. It is a sibling of
// ToastOverlay in the same overlay.html bundle (kind from `?kind=`), so it inherits the per-kind
// config, the persisted bounds and the lock semantics every overlay has — and, being MUI-free like
// them, it stays cheap to paint over the game.
//
// ALL THE TIMING IS IN cardQueue.ts, as a pure reducer over an explicit `dtMs`, SHARED with the
// celebration toast rather than copied. This file owns exactly one interval — and only while a
// line is actually on screen (`useCardTick`), so the resting state of this window is a React tree
// with no timers in it at all.
//
// THE MOUSE RULE: the window is PERSISTENT while enabled and fully click-through when the queue is
// empty — an invisible strip across the middle of the screen must never eat a click meant for the
// game. `useQueueMouseCapture` is the one implementation of that rule, shared with the toast and
// read by main to decide whether an OPAQUE strip window is visible at all (windows.ts).
//
// INTERACTIVE MODE IS HOW YOU MOVE IT. Locked, there is nothing to grab — by design, since the
// window is empty most of the time. Unlocked (Preferences → Overlays → "Move it"), the strip shows
// its outline and a drag bar, and that frame is also where the TEXT SIZE lives, for the reason the
// toast's does: this kind has no header and no footer to hang a control off.
//
// THE ONE EXCEPTION TO "RENDERS NOTHING" IS THE INTRODUCTION: the first time this overlay ever
// comes up on an install it queues ONE line naming itself, so the user who has just switched it on
// in Preferences can see WHERE it landed before an alert ever fires. Once per install, and the flag
// is written the moment the line is queued rather than when it leaves.
//
// WHAT THIS WINDOW DOES NOT DO, stated here because a reader will look for it (owner scope): no
// per-alert positions and no second text area (one banner, one place), no font picker, no
// flashing, and no buff-window filtering (JOS-168). The events overlay stays the log; this is the
// glance.

import { type Dispatch, type JSX, useEffect, useReducer, useRef } from 'react'
import {
  DEFAULT_ALERT_BANNER_CONFIG,
  introBannerPayload,
  type AlertBannerOverlayConfig,
  type AlertBannerPayload
} from '@shared/alertBanner'
import type { OverlayConfig } from '@shared/types'
import { BannerLine } from './BannerLine'
import { ScaledContent } from './overlayScale'
import {
  cardReduce,
  useCardTick,
  useQueueMouseCapture,
  useUnpinOnPointerExit,
  type CardAction,
  type CardState
} from './cardQueue'
import { TextScaleStepper } from './TextScaleStepper'
import { BgAlphaSlider } from './BgAlphaSlider'
import { useOverlayChrome, type OverlayChrome } from './useOverlayChrome'

const GOLD = '#d9b25f'

type BannerAction = CardAction<AlertBannerPayload>
type BannerState = CardState<AlertBannerPayload>[]

/** This kind's knobs, always complete: main normalizes them, and an unhydrated window uses the
 *  same defaults main would have filled in. */
function bannerConfig(config: OverlayConfig | null): AlertBannerOverlayConfig {
  return config?.alertBanner ?? DEFAULT_ALERT_BANNER_CONFIG
}

/**
 * The positioning frame, shown only while the overlay is unlocked — the toast's DragFrame, with
 * this window's own words. It is also where the TEXT SIZE and the TRANSPARENCY live, for the same
 * reason: this kind renders nothing at all most of the time, so the frame is the only chrome it
 * ever shows, and Preferences → Overlays → "Move it" is the whole route to all three knobs. (The
 * `bg` slider arrived in JOS-407; until then this kind's 0.72 was not settable at all.)
 */
function DragFrame({
  onDone,
  textScale,
  bgAlpha,
  patch,
  noDrag
}: {
  onDone: () => void
  textScale: number
  bgAlpha: number
  patch: OverlayChrome['patch']
  noDrag: React.CSSProperties
}): JSX.Element {
  return (
    <div
      data-testid="banner-drag-frame"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        marginBottom: 8,
        padding: '6px 10px',
        borderRadius: 8,
        border: `1px dashed ${GOLD}`,
        background: 'rgba(15,17,21,0.65)',
        color: GOLD,
        fontSize: 11
      }}
    >
      {/* The PROSE is the give on a narrow strip; the three controls beside it are the whole point
          of the frame and stay whole at every width. */}
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        Drag me where alerts should appear
      </span>
      <BgAlphaSlider bgAlpha={bgAlpha} patch={patch} noDrag={noDrag} />
      <TextScaleStepper textScale={textScale} patch={patch} noDrag={noDrag} />
      <button
        type="button"
        onClick={onDone}
        style={{
          ...noDrag,
          flexShrink: 0,
          border: `1px solid ${GOLD}`,
          borderRadius: 4,
          background: 'transparent',
          color: GOLD,
          fontSize: 11,
          padding: '2px 8px',
          cursor: 'pointer'
        }}
      >
        Done
      </button>
    </div>
  )
}

/**
 * THE INTRODUCTION: the one line this overlay ever shows about ITSELF.
 *
 * The celebration overlay's JOS-83 rule, applied to a window that is switched on DELIBERATELY —
 * which changes what the line is for but not whether it is needed. A user who has just ticked
 * "Show alerts on screen" in Preferences has no way to learn where the strip landed until an alert
 * happens to fire, and a strip they cannot find is a strip they cannot move. So it says so once,
 * through the queue it already has.
 *
 * ONCE PER INSTALL, and the flag is written the moment the line is queued rather than when it
 * leaves: a reload mid-introduction must not stack a second copy, and the store is the only place
 * two renderers can agree. A store with no `introduced` key reads false.
 */
function useIntroduction(
  config: OverlayConfig | null,
  patch: (p: Partial<OverlayConfig>) => void,
  dispatch: Dispatch<BannerAction>
): void {
  const doneRef = useRef(false)
  useEffect(() => {
    // Nothing is decided until the persisted answer is in hand — the rule `ready` exists for.
    if (doneRef.current || !config) return
    doneRef.current = true
    const cfg = bannerConfig(config)
    if (cfg.introduced) return
    const payload = introBannerPayload(Date.now())
    dispatch({ type: 'show', payload, holdMs: payload.holdMs ?? cfg.holdMs, cap: cfg.maxLines })
    patch({ alertBanner: { ...cfg, introduced: true } })
  }, [config, patch, dispatch])
}

/**
 * Subscribe to the lines main relays.
 *
 * THE HOLD AND THE CAP ARE READ AT ARRIVAL, through a ref, so a user who changes either in
 * Preferences sees it apply to the very next alert without this effect re-subscribing (and
 * therefore without dropping a line in the gap). Main has already filled `holdMs` from the same
 * config; the fallback here is for a window whose config has not landed yet.
 *
 * A `dueAt` line holds until its DEADLINE instead of for the configured time (slice 2): a
 * countdown that vanished at 4 s while still counting down from 12 would be worse than no
 * countdown at all. It is floored at one tick so an already-past deadline still appears.
 */
function useBannerFeed(cfg: AlertBannerOverlayConfig, dispatch: Dispatch<BannerAction>): void {
  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  useEffect(() => {
    return window.eqOverlay.onAlertBanner((payload: AlertBannerPayload) => {
      const c = cfgRef.current
      const untilDue = payload.dueAt === undefined ? undefined : payload.dueAt - Date.now()
      const holdMs = untilDue === undefined ? (payload.holdMs ?? c.holdMs) : Math.max(200, untilDue)
      dispatch({ type: 'show', payload, holdMs, cap: c.maxLines })
    })
  }, [dispatch])
}

export default function AlertBannerOverlay(): JSX.Element {
  const chrome = useOverlayChrome()
  const [lines, dispatch] = useReducer(cardReduce<AlertBannerPayload>, [] as BannerState)
  const cfg = bannerConfig(chrome.config)
  useIntroduction(chrome.config, chrome.patch, dispatch)
  useBannerFeed(cfg, dispatch)
  useCardTick(lines.length > 0, () => dispatch({ type: 'tick', dtMs: 100 }))
  useQueueMouseCapture(chrome.ready, chrome.locked, lines.length > 0)
  // A pointer that left without saying so must not leave a line pinned forever (JOS-381) — the
  // strip's own route into the stuck state, argued at `useUnpinOnPointerExit`.
  useUnpinOnPointerExit(lines, dispatch)

  return (
    <div
      data-testid="alert-banner-overlay"
      /* 100%, NOT 100vw/100vh — a viewport unit inside the scaled lines is resolved against the
         window and then zoomed (overlayScale). */
      style={{ width: '100%', height: '100%', padding: 6, boxSizing: 'border-box', ...chrome.dragRegion }}
    >
      {/* The drag frame is CHROME: unscaled, so "Done" and A− / A+ stay inside the strip at 2.0
          — the one route to both knobs must not be the thing the scale pushes off screen. */}
      {chrome.ready && !chrome.locked && (
        <DragFrame
          onDone={chrome.toggleLock}
          textScale={chrome.textScale}
          bgAlpha={chrome.bgAlpha}
          patch={chrome.patch}
          noDrag={chrome.noDrag}
        />
      )}
      {/* The lines ARE the content — newest at the bottom (arrival order is render order), oldest
          evicted past the cap. No scroll pane: this kind renders nothing most of the time, and a
          strip that could scroll would be a window, which is what it is not. */}
      <ScaledContent textScale={chrome.textScale}>
        {lines.map((l) => (
          <BannerLine
            key={l.payload.id}
            payload={l.payload}
            exiting={l.exitingMs !== null}
            bgAlpha={chrome.bgAlpha}
            onHover={(over) => dispatch({ type: 'hover', id: l.payload.id, over })}
            onDismiss={() => dispatch({ type: 'dismiss', id: l.payload.id })}
          />
        ))}
      </ScaledContent>
    </div>
  )
}
