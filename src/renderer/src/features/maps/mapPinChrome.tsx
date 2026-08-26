// mapPinChrome.tsx — what the two pin layers SHARE: the halo, the hover card, and the keyboard
// door.
//
// MapMobPins.tsx (the bestiary's teardrops) and MapTimerPins.tsx (the respawn lane's diamonds)
// each carried a verbatim copy of the four-way text halo and of the absolutely-positioned hover
// span — the same 20 lines twice, which is how the two cards start disagreeing about lift, z-order
// or font the first time one of them is touched. Each layer keeps its own SYMBOL (a mark must say
// where it came from — their headers); what they share is the chrome around a mark, and that lives
// here once.
//
// THE HALO IS DARK ON BOTH SIDES. The label layer picks its halo per label because the pack
// author's colours run light and dark (MapPointsLayer.tsx); every pin colour here is a theme tone
// that is light in both themes (`warning`, `success`, `error`), so the dark halo is fixed.
//
// THE KEYBOARD DOOR. A pin and a connection label are spans with a click — a mouse-only control on
// a surface a keyboard user can otherwise fully drive (the pane, the toolbar). `role="button"`,
// `tabIndex=0` and Enter/Space are the `CellLink` idiom the other fork branches spell for a name
// inside someone else's row; `onActivateKey` is that spelling, shared, so a glyph that gains a
// click gains the key for free and the two can never drift.

import type { CSSProperties, JSX, KeyboardEvent } from 'react'

/** Four-way dark halo behind pin text — the label layer's technique with the dark side fixed. */
export const HALO =
  '-1px 0 0 rgba(0,0,0,0.85), 1px 0 0 rgba(0,0,0,0.85), 0 -1px 0 rgba(0,0,0,0.85), 0 1px 0 rgba(0,0,0,0.85)'

/** The two keys a `role="button"` activates on. Pure, so the rule has its own node test. */
export function isActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' '
}

/**
 * A keydown handler that fires `activate` on Enter/Space — and swallows the default, because
 * Space scrolls the content area and Enter on a focused span does nothing a user asked for.
 * Null/undefined `activate` ⇒ no handler at all, so an inert glyph stays inert to the keyboard too.
 */
export function onActivateKey<E extends Element>(
  activate: (() => void) | null | undefined
): ((e: KeyboardEvent<E>) => void) | undefined {
  if (activate == null) return undefined
  return (e) => {
    if (!isActivationKey(e.key)) return
    e.preventDefault()
    activate()
  }
}

/** Pin text in the pin's own colour, haloed, one line — the clock label and the hover share it. */
export function pinTextStyle(color: string, px: number): CSSProperties {
  return { font: `${String(px)}px/1.1 inherit`, color, textShadow: HALO, whiteSpace: 'nowrap' }
}

/**
 * The hover card: lifted `lift` px above the pin, centred, inert to the pointer (JOS-143: the
 * card is instant DOM, never a popper). `art` is an `eqimg://` portrait when one is bundled
 * (mobArt.ts); a cache miss degrades to text-only, the BossImage posture.
 */
export function PinHoverCard({
  testId,
  at,
  lift,
  color,
  art,
  text
}: {
  testId: string
  at: { px: number; py: number }
  lift: number
  color: string
  art?: string | null
  text: string
}): JSX.Element {
  return (
    <span
      data-testid={testId}
      style={{
        position: 'absolute',
        left: at.px,
        top: at.py - lift,
        transform: 'translate(-50%, -100%)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        pointerEvents: 'none',
        zIndex: 4
      }}
    >
      {art != null && (
        <img
          src={art}
          alt=""
          onError={(ev) => {
            ev.currentTarget.style.display = 'none'
          }}
          style={{
            width: 44,
            height: 44,
            objectFit: 'cover',
            borderRadius: 4,
            boxShadow: '0 0 0 1px rgba(0,0,0,0.85)'
          }}
        />
      )}
      <span style={pinTextStyle(color, 12)}>{text}</span>
    </span>
  )
}
