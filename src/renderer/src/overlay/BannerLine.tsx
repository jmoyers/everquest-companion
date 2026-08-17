// BannerLine — ONE line of the alert banner (JOS-378).
//
// MUI-FREE BY LAW (AGENTS.md: the overlay bundle is plain React + inline styles), and cheaper than
// the celebration card it is a sibling of: a banner is TEXT. No icon, no reward block, no deep
// link. The whole point of the surface is that a player mid-pull can read it without stopping, so
// it is one large, high-contrast sentence on dark glass and nothing else competing for the eye.
//
// THE TEXT IS CENTRED, and the dismiss button is balanced against an invisible twin so that
// centring stays true (JOS-380): this line is read at a glance over the game, from wherever the
// eyes already are, so a sentence hugging the left edge of a strip that spans a third of the
// screen reads as misplaced.
//
// THE COLOUR COMES FROM THE ALERT, NOT FROM THIS FILE. `ALERT_BANNER_COLOR_HEX` (shared/
// alertBanner.ts) is the one table, because the alert EDITOR draws the same six swatches and two
// tables of six colours is two answers to one question.
//
// THE COUNTDOWN IS A RENDER, NOT A TIMER (slice 2). An early-warning firing carries `dueAt` — the
// deadline main counted back from — and this line prints the seconds remaining, recomputed on
// every render. It needs no clock of its own: the queue already ticks 10×/sec while any line is on
// screen, which is exactly the cadence a seconds counter wants. A line with no `dueAt` (nearly all
// of them) prints its text and nothing else, because there is no deadline to state and inventing
// one would be the invented "remaining" world-model law 1 forbids.
//
// Enter/exit are CSS transitions on transform/opacity — compositor-only, so the animation costs
// the game nothing. Same motion the celebration card uses, deliberately: two notifiers that move
// differently read as two apps.

import { type CSSProperties, type JSX, useEffect, useState } from 'react'
import { ALERT_BANNER_COLOR_HEX, type AlertBannerPayload } from '@shared/alertBanner'
import { CARD_ENTER_MS, CARD_EXIT_MS } from './cardQueue'

const MUTED = '#a8b0c6'

/** The dismiss button's side, and therefore the balance spacer's — one number, or the text drifts. */
const BUTTON_PX = 20

/**
 * The enter/exit transition, as a style. `entering` is true for exactly one frame after mount,
 * which is what gives the browser a FROM state to animate out of — set both at once and there is
 * no transition at all, only a jump.
 */
function motionStyle(entering: boolean, exiting: boolean): CSSProperties {
  const hidden = entering || exiting
  return {
    opacity: hidden ? 0 : 1,
    transform: hidden ? 'translateY(-6px)' : 'translateY(0)',
    transition: `opacity ${String(exiting ? CARD_EXIT_MS : CARD_ENTER_MS)}ms ease-out, transform ${String(
      exiting ? CARD_EXIT_MS : CARD_ENTER_MS
    )}ms ease-out`
  }
}

/**
 * The seconds still to run on a warning, or null when this line is not counting anything down.
 *
 * Floored at zero rather than allowed to go negative: a deadline that has passed while the line
 * was pinned under the pointer says "in 0s", which is true, instead of counting upward into a
 * number that means nothing.
 */
function secondsLeft(dueAt: number | undefined, now: number): number | null {
  if (dueAt === undefined) return null
  return Math.max(0, Math.ceil((dueAt - now) / 1000))
}

export function BannerLine({
  payload,
  exiting,
  bgAlpha,
  onHover,
  onDismiss
}: {
  payload: AlertBannerPayload
  exiting: boolean
  bgAlpha: number
  onHover: (over: boolean) => void
  onDismiss: () => void
}): JSX.Element {
  const [entering, setEntering] = useState(true)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntering(false))
    return () => cancelAnimationFrame(id)
  }, [])

  const color = ALERT_BANNER_COLOR_HEX[payload.color ?? 'default']
  const left = secondsLeft(payload.dueAt, Date.now())

  return (
    <div
      data-testid="banner-line"
      data-alert-id={payload.alertId}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 10,
        marginBottom: 8,
        padding: '10px 16px',
        borderRadius: 8,
        border: `1px solid ${color}55`,
        background: `rgba(15,17,21,${String(bgAlpha)})`,
        backdropFilter: 'blur(6px)',
        boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
        ...motionStyle(entering, exiting)
      }}
    >
      {/* THE BUTTON'S INVISIBLE TWIN. Centred text in a row that ends with a 20 px control is not
          centred at all — it sits half that control off true — so the right edge's width is spent
          again on the left and the text span lands exactly on the line's midpoint. */}
      <span aria-hidden="true" style={{ flexShrink: 0, width: BUTTON_PX }} />
      <span
        data-testid="banner-text"
        style={{
          color,
          fontSize: 22,
          fontWeight: 700,
          lineHeight: 1.25,
          minWidth: 0,
          flex: '1 1 auto',
          textAlign: 'center'
        }}
      >
        {payload.text}
        {/* The deadline, said the way the reporter said it ("Celerity fades in 30 s"): part of the
            same sentence rather than a second element, so the line still reads as one thought. */}
        {left !== null && (
          <span data-testid="banner-countdown" style={{ color: MUTED, fontWeight: 500 }}>
            {` in ${String(left)}s`}
          </span>
        )}
      </span>
      {/* EVERY LINE CLOSES (the celebration card's JOS-83 rule, applied): this window is
          always-on-top over a game, and a user who wants a specific line gone must not have to
          find Preferences to do it. It is the only control on the line. */}
      <button
        type="button"
        data-testid="banner-close"
        aria-label="Dismiss this alert"
        onClick={onDismiss}
        style={{
          flexShrink: 0,
          width: BUTTON_PX,
          height: BUTTON_PX,
          lineHeight: '18px',
          padding: 0,
          borderRadius: 4,
          border: '1px solid rgba(255,255,255,0.18)',
          background: 'transparent',
          color: MUTED,
          fontSize: 13,
          cursor: 'pointer'
        }}
      >
        ×
      </button>
    </div>
  )
}
