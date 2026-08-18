// BgAlphaSlider — the STRIPS' background-transparency control (JOS-407).
//
// The nine PANELS have carried a `bg` slider in their footer since the overlays existed. The three
// strips — the celebration toast, the alert banner and the mob card — never had one: their 0.72 was
// the only transparency they have ever had, because a window that renders nothing most of the time
// has no footer to hang a control off. So it goes in the DRAG FRAME beside the A− / A+, which is
// exactly where their text size already lives, and "Move it" is the whole route to both knobs.
//
// ONE COMPONENT FOR THE THREE, and not for the nine: each panel paints its slider in its OWN accent
// (the heal meter's gold is not the damage meter's, and the buffs window's is computed per row set),
// so folding them in would mean threading a colour through to make six call sites look exactly as
// they already do. The RANGE is the thing that must not fork, and that lives in
// shared/overlayBgAlpha.ts, which the panels read too.
//
// A SLIDER RATHER THAN A STEPPER, where the text size is the other way round: a shade is something
// you aim at while looking at the game behind it, not a ladder with four useful rungs.
//
// INTERACTIVE MODE ONLY, like every other knob out here — a locked overlay is click-through and
// shows no chrome, so each caller already renders this behind its own `!locked`.
//
// MUI-FREE, like the rest of this bundle; the styling is the drag frame's existing one.

import type { JSX } from 'react'
import { BG_ALPHA_MAX, BG_ALPHA_MIN, BG_ALPHA_STEP } from '@shared/overlayBgAlpha'
import type { OverlayChrome } from './useOverlayChrome'

/** The frame's accent, restated here because this bundle has no theme to import one from. */
const GOLD = '#d9b25f'

export function BgAlphaSlider({
  bgAlpha,
  patch,
  noDrag
}: {
  bgAlpha: number
  patch: OverlayChrome['patch']
  /** the caller's `no-drag` style: this sits inside a drag region in all three kinds. */
  noDrag: React.CSSProperties
}): JSX.Element {
  return (
    // NEVER SHRINKS, and never grows either. In a panel footer the slider IS the give; in a strip's
    // drag frame the PROSE is (it ellipsizes), and a slider that absorbed the spare width would
    // push "Done" off the end of a narrow strip — the control you needed and could not press.
    <span style={{ ...noDrag, display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      {/* The word IS the label (JOS-358) — the frame names its own controls, it does not hover. */}
      <span>bg</span>
      <input
        type="range"
        aria-label={`Background transparency (${String(Math.round(bgAlpha * 100))}%)`}
        data-testid="overlay-bg-alpha"
        min={BG_ALPHA_MIN}
        max={BG_ALPHA_MAX}
        step={BG_ALPHA_STEP}
        value={bgAlpha}
        onChange={(e) => { patch({ bgAlpha: Number(e.target.value) }) }}
        style={{ width: 64, flexShrink: 0, accentColor: GOLD, height: 4 }}
      />
    </span>
  )
}
