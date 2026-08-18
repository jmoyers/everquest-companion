// ToastOverlay — the 'toast' overlay kind (docs/plans/celebration-toasts.md).
//
// A transparent strip at the top of the screen that USUALLY RENDERS NOTHING. Main pushes one
// finished payload per celebration (`toast:card`); this component queues, times and dismisses
// it locally. It is a sibling of OverlayMeter / EventLogOverlay in the same overlay.html bundle
// (kind from `?kind=`), so it inherits their per-kind config, their persisted bounds and their
// lock semantics — and, being MUI-free like them, it stays cheap to paint over the game.
//
// ALL THE TIMING IS IN toastQueue.ts, as a pure reducer over an explicit `dtMs`. This file owns
// exactly one interval and one rule about the mouse.
//
// THE MOUSE RULE (T2): the window is PERSISTENT while enabled and fully click-through when the
// queue is empty — an invisible strip must never eat a click meant for the game. The moment a
// card is on screen the renderer asks main to flip `setIgnoreMouseEvents(false)` so hover-pin
// and the reward click work, and it flips back the moment the last card leaves. Only while
// LOCKED: an unlocked (interactive) toast is being positioned, and must keep the pointer.
//
// INTERACTIVE MODE is how you move it. Locked, there is nothing to grab — by design, since the
// window is empty most of the time. Unlocked (Preferences → Overlays → "Move the toast"), the
// strip shows its outline and a drag bar, so "configurable position later" is the mechanism
// every other overlay already has rather than a new one.
//
// THE ONE EXCEPTION TO "RENDERS NOTHING" IS THE INTRODUCTION (JOS-83, `useIntroduction` below):
// the first time this overlay ever comes up on an install it queues ONE card naming itself, so a
// user who has never triggered a celebration is not left staring at an anonymous rectangle.

import { type JSX, type Dispatch, useEffect, useReducer, useRef } from 'react'
import { DEFAULT_TOAST_CONFIG, introToastPayload, type ToastPayload } from '@shared/toast'
import type { OverlayConfig } from '@shared/types'
import { ToastCard } from './ToastCard'
import { ScaledContent } from './overlayScale'
import { useUnpinOnPointerExit } from './cardQueue'
import { toastReduce, type ToastAction, type ToastCardState } from './toastQueue'
import { TextScaleStepper } from './TextScaleStepper'
import { BgAlphaSlider } from './BgAlphaSlider'
import { useOverlayChrome, type OverlayChrome } from './useOverlayChrome'

/** How often the queue's clocks advance. 100 ms is imperceptible against a 6 s hold and costs
 *  nothing: the reducer returns the SAME array when no card moved, so React re-renders only
 *  when something actually changed. */
const TICK_MS = 100

const GOLD = '#d9b25f'

/**
 * The positioning frame, shown only while the overlay is unlocked.
 *
 * It is also where the TEXT SIZE and the TRANSPARENCY live for this kind, for the same reason the
 * drag handle does: the toast has no header and no footer to hang a control off — it renders
 * nothing at all most of the time — so this frame is the only chrome it ever shows. Preferences →
 * Overlays → "Move it" is therefore the whole route to all three knobs: move it, size it, fade it,
 * Done. (The `bg` slider arrived in JOS-407; until then this kind's 0.72 was not settable at all.)
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
      data-testid="toast-drag-frame"
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
        Drag me where celebrations should appear
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
 * Keep main's click-through state in step with the queue.
 *
 * PASS-THROUGH IS THE SAFE ANSWER, so it is also the answer BEFORE the persisted config
 * arrives: a transparent strip across the top of the screen that captured the mouse for even a
 * few frames at startup would eat a click aimed at the game, and the user would have no idea
 * what did it. Once the config is known: unlocked (being positioned) keeps the mouse
 * unconditionally; locked captures it only while a card is actually on screen.
 */
function useMouseCapture(ready: boolean, locked: boolean, hasCards: boolean): void {
  useEffect(() => {
    const ignore = !ready ? true : locked ? !hasCards : false
    window.eqOverlay.setIgnoreMouse(ignore)
  }, [ready, locked, hasCards])
}

/**
 * THE INTRODUCTION (JOS-83): the one card this overlay ever shows about ITSELF.
 *
 * A brand-new user reported the celebration strip as a rectangle they took for a malfunction —
 * the window is on by default and, until something is celebrated, it draws literally nothing to
 * say what it is. Painting a permanent label would trade that rare confusion for a constant one
 * (an empty, invisible, click-through strip is exactly why the kind can default on), so the
 * overlay introduces itself ONCE, through the queue it already has: a labelled card with the same
 * close button as every other, plus a button that switches the overlay off for good.
 *
 * ONCE PER INSTALL, and the flag is written the moment the card is queued rather than when it
 * leaves: a second window (or a reload) mid-introduction must not stack a second copy, and the
 * store is the only place two renderers can agree. A store with no `introduced` key reads false,
 * so installs that predate this see it too — they are precisely the ones that have been living
 * with the unlabelled strip.
 */
function useIntroduction(
  config: OverlayConfig | null,
  patch: (p: Partial<OverlayConfig>) => void,
  dispatch: Dispatch<ToastAction>
): void {
  const doneRef = useRef(false)
  useEffect(() => {
    // Nothing is decided until the persisted answer is in hand — the same rule `ready` exists for.
    if (doneRef.current || !config) return
    doneRef.current = true
    if (config.toast?.introduced === true) return
    dispatch({ type: 'show', payload: introToastPayload() })
    patch({ toast: { ...DEFAULT_TOAST_CONFIG, ...config.toast, introduced: true } })
  }, [config, patch, dispatch])
}

export default function ToastOverlay(): JSX.Element {
  const chrome = useOverlayChrome()
  const [cards, dispatch] = useReducer(toastReduce, [] as ToastCardState[])
  useIntroduction(chrome.config, chrome.patch, dispatch)

  // A toast overlay with nothing queued renders literally nothing — that empty, transparent,
  // click-through window IS the resting state, and it is why the window can stay open forever.
  useEffect(() => {
    return window.eqOverlay.onToast((payload: ToastPayload) => dispatch({ type: 'show', payload }))
  }, [])

  useEffect(() => {
    const id = setInterval(() => dispatch({ type: 'tick', dtMs: TICK_MS }), TICK_MS)
    return () => clearInterval(id)
  }, [])

  useMouseCapture(chrome.ready, chrome.locked, cards.length > 0)
  // A pointer that left without saying so must not leave a card pinned forever (JOS-381) — the
  // strip's own route into the stuck state, argued at `useUnpinOnPointerExit` (cardQueue.ts).
  useUnpinOnPointerExit(cards, dispatch)

  return (
    <div
      data-testid="toast-overlay"
      /* 100%, NOT 100vw/100vh — a viewport unit inside the scaled cards is resolved against the
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
      {/* The cards ARE the content — no scroll pane, because this kind renders nothing most of
          the time and a strip that could scroll would be a window, which is what it is not. */}
      <ScaledContent textScale={chrome.textScale}>
        {cards.map((c) => (
          <ToastCard
            key={c.payload.id}
            payload={c.payload}
            exiting={c.exitingMs !== null}
            bgAlpha={chrome.bgAlpha}
            onHover={(over) => dispatch({ type: 'hover', id: c.payload.id, over })}
            onDismiss={() => dispatch({ type: 'dismiss', id: c.payload.id })}
          />
        ))}
      </ScaledContent>
    </div>
  )
}
