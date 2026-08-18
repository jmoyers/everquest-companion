// overlayLabels.ts — WHAT THE APP CALLS EACH OVERLAY WINDOW, in one map (JOS-405).
//
// There were TWO of these and they disagreed. The title bar's Overlay menu said `Zone meter` and
// `Event log`; `shared/shareMerge.ts` said `Overall meter` and `Event feed` — so an imported
// settings bundle offered to change the opacity of a window whose name appeared nowhere in the
// menu the user opens to find it. Neither spelling was wrong; having two was.
//
// THE MENU'S WORDING WINS, because it is the one a user reads before they read any other: it is
// what they clicked to make the window exist. The three kinds that are NOT in that menu (the
// celebration toast, the alert banner, and — for this list's purposes — the mob card) are named
// here in the same voice.
//
// WHY ITS OWN FILE. `shared/types.ts` owns `OverlayKind` and is at the 400-code-line factoring
// ceiling (JOS-140's ruling, restated by this ticket's brief), and a label map is display
// vocabulary rather than a type. It imports nothing but the kind union, so a node test, the
// MUI-free overlay bundle and main can all read it.

import type { OverlayKind } from './types'

/** The name of each overlay window, as the app says it out loud. Keyed by the WHOLE union, so a
 *  new kind cannot ship without being named. */
export const OVERLAY_KIND_LABEL: Record<OverlayKind, string> = {
  fight: 'Fight meter',
  overall: 'Zone meter',
  'heal-fight': 'Fight healing',
  'heal-overall': 'Zone healing',
  events: 'Event log',
  buffs: 'Buffs',
  debuffs: 'Debuffs',
  xp: 'XP',
  respawn: 'Respawn',
  toast: 'Celebration toasts',
  alertBanner: 'Alert banner',
  conCard: 'Mob card on con'
}

/**
 * THE ORDER A LIST OF ALL TWELVE IS READ IN (Preferences → Per-overlay sizes).
 *
 * The nine windows you open from the Overlay menu, in the menu's own order, then the three STRIPS
 * — the ones that appear by themselves when something happens rather than because you asked for a
 * window. That is the grouping a user already has in their head: "the meters I placed" and "the
 * things that pop up". The mob card is in the Overlay menu too (JOS-383, so its off switch is
 * within reach), but it is a strip, and this list is about what the window IS.
 *
 * Kept beside the labels because the two are read together everywhere either is read at all.
 */
export const OVERLAY_LABEL_ORDER: readonly OverlayKind[] = [
  'fight',
  'overall',
  'heal-fight',
  'heal-overall',
  'events',
  'buffs',
  'debuffs',
  'xp',
  'respawn',
  'toast',
  'alertBanner',
  'conCard'
]

/** Where the strips start in `OVERLAY_LABEL_ORDER` — the seam a grouped list draws across. */
export const OVERLAY_STRIP_KINDS: readonly OverlayKind[] = ['toast', 'alertBanner', 'conCard']
