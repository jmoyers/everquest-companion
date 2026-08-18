// ConCardOverlay — the 'conCard' overlay kind (JOS-383, shared/conCard.ts).
//
// A transparent strip near the top of the screen that USUALLY RENDERS NOTHING. Main sends one
// finished card per `/con` (`con:card`); this component holds it, times it and lets it go. It is a
// sibling of ToastOverlay and AlertBannerOverlay in the same overlay.html bundle (kind from
// `?kind=`), so it inherits the per-kind config, the persisted bounds and the lock semantics every
// overlay has — and, being MUI-free like them, it stays cheap to paint over the game.
//
// THE QUEUE IS THE SHARED ONE (cardQueue.ts), AT A CAP OF EXACTLY ONE. That cap is not a limit, it
// is the design: "every con REPLACES the card's content" is precisely what a one-deep queue does —
// a new arrival evicts the one on screen, and a re-con of the SAME mob refreshes the card already
// there instead of stacking a duplicate (the payload id is the mob key).
//
// THE AUTO-HIDE IS THE ONE KNOB, AND ZERO MEANS NEVER. `autoHideMs: 0` becomes an infinite hold, so
// the card sits there until the next con replaces it or the user closes it. Infinity lives HERE and
// never on the wire: the reducer subtracts it every tick and the card simply never expires.
//
// CLOSING IS TWO THINGS AT ONCE. Locally the card is dismissed; remotely main is told, because main
// owns the rule this window cannot see — a re-con of the same creature inside a minute must not put
// it back up (`CON_CARD_REOPEN_SUPPRESS_MS`). An auto-hide is NOT a close and says nothing: the
// card leaving by itself is not the user saying they have read it.
//
// AND CLICKING IT ANYWHERE ELSE OPENS THE MOB PAGE (JOS-390). That is the second thing this window
// sends, over the deep link every overlay shares (`eqOverlay.focusMob`), and the whole reason a
// LOCKED strip captures the mouse while a card is up in the first place (`useQueueMouseCapture`) —
// the × already needed that click, and the card body is the same click aimed one control over.
//
// INTERACTIVE MODE IS HOW YOU MOVE IT, exactly as it is for the other two strips: locked there is
// nothing to grab, and unlocked the window shows a drag frame carrying the text-size stepper. It is
// also why the link is LOCKED-ONLY: a click while positioning is the user dragging the card, not
// asking to leave the game.
//
// AND THE WINDOW IS THE CARD (JOS-386). This is the one strip whose window HEIGHT is not a size
// anybody chose: it is measured here, every time the card changes, and main resizes to it. The
// other two are deliberately over-tall transparent lanes, which costs nothing when the thing they
// hold is a notification you glance at; it costs real screen when it is a card you read over a
// game, and it costs the mouse in both overlay modes. `useFitWindowHeight` below is the measuring
// half; the policy and the window are main's (main/overlayBounds.ts).

import { type JSX, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import {
  DEFAULT_CON_CARD_CONFIG,
  conCardHoldMs,
  type ConCardOverlayConfig,
  type ConCardPayload
} from '@shared/conCard'
import type { OverlayConfig } from '@shared/types'
import { ConCard } from './ConCard'
import { ScaledContent } from './overlayScale'
import { cardReduce, useCardTick, useQueueMouseCapture, useUnpinOnPointerExit } from './cardQueue'
import type { CardAction, CardState } from './cardQueue'
import { TextScaleStepper } from './TextScaleStepper'
import { BgAlphaSlider } from './BgAlphaSlider'
import { useOverlayChrome, type OverlayChrome } from './useOverlayChrome'
import { fitChanged, overlayFitRequest } from './overlayFit'

const GOLD = '#d9b25f'

/** One card at a time, by design — see the header. */
const CAP = 1

/** The window's own inset, on every side. Chrome pixels: the root is outside ScaledContent. */
const PAD = 6

type ConAction = CardAction<ConCardPayload>
type ConState = CardState<ConCardPayload>[]

/** This kind's knob, always complete: main normalizes it, and an unhydrated window uses the same
 *  default main would have filled in. */
function conCardConfig(config: OverlayConfig | null): ConCardOverlayConfig {
  return config?.conCard ?? DEFAULT_CON_CARD_CONFIG
}

/**
 * The positioning frame, shown only while the overlay is unlocked — the banner's DragFrame with
 * this window's own words, and for the same reason: this kind renders nothing between cons, so the
 * frame is the only chrome it ever shows and the text size — and, since JOS-407, the transparency —
 * has nowhere else to live.
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
      data-testid="con-card-drag-frame"
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
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        Drag me where mob cards should appear
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
 * Subscribe to the cards main pushes.
 *
 * THE HOLD IS READ AT ARRIVAL, through a ref, so a user who changes the auto-hide in Preferences
 * sees it apply to the very next `/con` without this effect re-subscribing (and therefore without
 * dropping a card in the gap) — the banner's arrangement, for the same reason.
 */
function useCardFeed(cfg: ConCardOverlayConfig, dispatch: (a: ConAction) => void): void {
  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  useEffect(() => {
    return window.eqOverlay.onConCard((payload: ConCardPayload) => {
      dispatch({ type: 'show', payload, holdMs: conCardHoldMs(cfgRef.current), cap: CAP })
    })
  }, [dispatch])
}

/**
 * THE WINDOW FOLLOWS THE CARD (JOS-386) — measure what was drawn, tell main, once per change.
 *
 * WHAT IS MEASURED is the wrapper holding the drag frame and the scaled card, plus the root's own
 * padding (overlayFit.ts). Never the root itself: the root is `height: 100%` of the window whose
 * height this decides, so measuring it would only ever answer "whatever I already am".
 *
 * IT MEASURES ON EVERY RENDER, in a LAYOUT effect, and the ResizeObserver is the second net rather
 * than the first. That is a measured constraint, not belt-and-braces for its own sake: an overlay
 * window in `EQ_E2E=1` is never shown and therefore never composited, and Chromium's rendering
 * lifecycle — which is what delivers ResizeObserver callbacks and `requestAnimationFrame` — can
 * stop running entirely in such a window (AGENTS.md records rAF being throttled to nothing there,
 * and it is why `nextFrames` races a timer). A layout effect runs on React's own schedule and
 * `getBoundingClientRect` forces layout synchronously, so the fit works in a window that never
 * paints. Everything this card draws changes through React anyway (the payload, the second pass
 * that brings the drops, the text scale); the observer is there for the rest — a wrapped drop line
 * after a width drag, a font that resolved late.
 *
 * IT IS DEBOUNCED TO A MACROTASK, not to a frame, for exactly the same reason. The debounce is what
 * collapses "the card arrived" and "its drops landed" into one resize instead of two, and a frame
 * callback would be a debounce that in a hidden window never fires.
 *
 * IT DOES NOT RESIZE UNDER AN EXITING CARD. A card on its way out is fading in place; collapsing the
 * window under it would replace a fade with a snap, and the next card is about to re-measure
 * anyway. An EMPTY queue says nothing at all — the window keeps whatever height it had, because
 * what an empty con-card window does is not this ticket's business (the brief's own words).
 */
function useFitWindowHeight(el: HTMLElement | null, quiet: boolean): void {
  /** The last height sent, so a card that did not move sends nothing. */
  const sent = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const quietRef = useRef(quiet)
  quietRef.current = quiet

  const measure = (): void => {
    if (el === null || quietRef.current) return
    if (timer.current !== null) return
    timer.current = setTimeout(() => {
      timer.current = null
      if (el === null || quietRef.current) return
      const want = overlayFitRequest(el.getBoundingClientRect().height, PAD)
      if (!fitChanged(sent.current, want)) return
      sent.current = want
      window.eqOverlay.fitHeight(want)
    }, 0)
  }

  // Every render: the card changed, or the drag frame appeared, or the text scale moved.
  useLayoutEffect(measure)

  // …and anything React did not cause. Torn down with the element it watches.
  useEffect(() => {
    if (el === null || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `measure` reads its inputs by ref
  }, [el])

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    []
  )
}

export default function ConCardOverlay(): JSX.Element {
  const chrome = useOverlayChrome()
  const [cards, dispatch] = useReducer(cardReduce<ConCardPayload>, [] as ConState)
  const cfg = conCardConfig(chrome.config)
  useCardFeed(cfg, dispatch)
  useCardTick(cards.length > 0, () => dispatch({ type: 'tick', dtMs: 100 }))
  useQueueMouseCapture(chrome.ready, chrome.locked, cards.length > 0)
  // A pointer that left without saying so must not leave a card pinned forever (JOS-381) — and a
  // card with an INFINITE hold is exactly the case that would never recover from it.
  useUnpinOnPointerExit(cards, dispatch)
  // THE WINDOW FOLLOWS THE CARD (JOS-386). State rather than a ref, so the hook's observer is stood
  // up on the render the wrapper mounts rather than the one after it. Quiet on an empty queue (the
  // window keeps what it had) and while anything is fading out (a resize would replace the fade
  // with a snap).
  const [fitEl, setFitEl] = useState<HTMLDivElement | null>(null)
  useFitWindowHeight(fitEl, cards.length === 0 || cards.some((c) => c.exitingMs !== null))

  return (
    <div
      data-testid="con-card-overlay"
      /* 100%, NOT 100vw/100vh — a viewport unit inside the scaled card is resolved against the
         window and then zoomed (overlayScale). */
      style={{ width: '100%', height: '100%', padding: PAD, boxSizing: 'border-box', ...chrome.dragRegion }}
    >
      {/* THE MEASURED BOX (JOS-386): everything the window has to be tall enough for, and nothing
          that is sized BY the window. `fit-content`, never the root's 100% — a box that filled the
          window could only ever measure back the height it already has. */}
      <div ref={setFitEl} data-testid="con-card-fit" style={{ height: 'fit-content' }}>
        {/* The drag frame is CHROME: unscaled, so "Done" and A- / A+ stay inside the window at 2.0.
            It is INSIDE the measured box on purpose — the JOS-378 rule is that the frame stays in
            the window at every text scale, and a window fitted to the card alone would cut it off. */}
        {chrome.ready && !chrome.locked && (
          <DragFrame
            onDone={chrome.toggleLock}
            textScale={chrome.textScale}
            bgAlpha={chrome.bgAlpha}
            patch={chrome.patch}
            noDrag={chrome.noDrag}
          />
        )}
        <ScaledContent textScale={chrome.textScale}>
          {cards.map((c) => (
            <ConCard
              key={c.payload.id}
              payload={c.payload}
              exiting={c.exitingMs !== null}
              bgAlpha={chrome.bgAlpha}
              // A CLICK IS A LINK ONLY WHEN THE CARD IS PARKED (JOS-390). Unlocked, this window
              // wears a drag region and the click the user is making is a MOVE — `chrome.ready`
              // is in the gate for the toast's reason: acting on the default before the config
              // lands would make the very first card of a launch guess at its own mode.
              linked={chrome.ready && chrome.locked}
              onHover={(over) => dispatch({ type: 'hover', id: c.payload.id, over })}
              // THE DISPLAY NAME, never the queue id: `focusMob` is a lookup key on the app side
              // (`applyDeepLink` → `openMob({ mob })` → the mob page), and the id is the
              // article-folded `mobKey`. The same string the con line printed is what the mob
              // page, the catalog and the toast all speak.
              onOpen={() => window.eqOverlay.focusMob(c.payload.name)}
              onDismiss={() => {
                dispatch({ type: 'dismiss', id: c.payload.id })
                // Main owns the minute-long suppression; this is the only place it can learn that
                // the user closed THIS mob's card rather than the card simply timing out.
                window.eqOverlay.closeConCard(c.payload.id)
              }}
            />
          ))}
        </ScaledContent>
      </div>
    </div>
  )
}
