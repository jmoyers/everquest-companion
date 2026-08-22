// The marker vocabulary — ONE source for the hue and the word every surface uses to say
// "a stance was committed" / "a coat went on" / "a slow landed".
//
// Extracted from CombatDashboard.tsx (Task #64), which owned the only copy while ProcsPanel and
// the header slots kept hand-copied hexes of the same values — a third copy waiting to drift.
// The precedent is CAT_COLOR in combatShared.tsx: a color that means something is data, and
// data has one home. MUI-free and free of `@shared/*` VALUE imports on purpose, so the pure
// modules that build tooltip text can import it without becoming un-loadable outside the
// renderer bundle.
//
// MARKER COLORS are deliberately the SAME hues as the header's modifier slots, so a violet tick
// on the curve and the violet "3: Neurotoxic" pill are obviously the same fact:
//   stance      gold   (slot 1)
//   invocation  violet (slot 2)
//   coat        magenta(slot 3)
//   slow        green  — the one marker that is an OUTCOME rather than a choice, so it also
//                        gets a flag head instead of a plain tick. It is what the user is
//                        looking for on these charts; it must not read as another setting.

import type { TimelineMarker } from '@shared/combat'
import type { ProcOrigin } from '@shared/procAnalytics'

export const MARKER_COLOR: Record<TimelineMarker['kind'], string> = {
  stance: '#d9b25f',
  invocation: '#a98fe0',
  coat: '#c46fd2',
  slow: '#57e0a0'
}

/**
 * The HELD-CLICKY hue (JOS-438) — the DoT blue of `CAT_COLOR`, spelled here because
 * combatShared.tsx sits at its measured line ceiling and this file is the vocabulary's home.
 *
 * Deliberately NOT the proc magenta. The reported defect was a clicky wearing the proc
 * vocabulary; a lane that reads `click` in the proc COLOUR would leave half of that in place.
 * Blue is the one hue in the vocabulary no proc origin already uses.
 */
export const CLICK_COLOR = '#6fb3d2'

/**
 * The PROC hue — the coat magenta, so the breakdown card's proc strip, a drill row's
 * `proc · 3.1 ppm` tag and the chart's coat markers all read as the same subject. It lived in
 * combatShared.tsx until JOS-438 needed a second value beside it.
 */
export const PROC_COLOR = MARKER_COLOR.coat

/**
 * The hue a lane's Procs-panel dot and its drill-row tag wear, by origin. ONE table, so the two
 * surfaces can never disagree about what a lane is — which is the whole reason a `click` lane
 * needed a colour of its own and not just a word.
 */
export const ORIGIN_COLOR: Record<ProcOrigin, string> = {
  poison: PROC_COLOR,
  spell: '#a98fe0',
  slay: '#f6f0da',
  // THE SWING-BORNE AA hue (JOS-437) — the stance GOLD, which is the one colour in the marker
  // vocabulary no proc origin had taken. Deliberately the warm neighbour of slay's cream rather
  // than a fifth unrelated hue: `slay` and `aa` are the two lanes that ride an ordinary weapon
  // swing, and reading as siblings is correct. They stay distinguishable — cream is a near-white
  // and this is an amber — which is what keeps it a relation rather than a collision.
  aa: '#d9b25f',
  click: CLICK_COLOR
}

// The WORD is extracted verbatim from its old home — the DPS curve's legend and native tick
// titles read from it, and this move is behavior-preserving by construction.
export const MARKER_WORD: Record<TimelineMarker['kind'], string> = {
  stance: 'stance',
  invocation: 'invocation',
  coat: 'coat',
  slow: 'slow landed'
}

/** The verb a marker's instant is stated with: a coat/slow HAPPENED, a stance was CHOSEN. */
export const MARKER_VERB: Record<TimelineMarker['kind'], string> = {
  stance: 'committed',
  invocation: 'committed',
  coat: 'applied',
  slow: 'landed'
}
