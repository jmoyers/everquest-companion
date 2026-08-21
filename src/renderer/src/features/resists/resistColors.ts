// THE FIVE AXIS COLOURS, IN ONE PLACE (JOS-382).
//
// The con-tooltip overlay imports this file too, which is the whole reason it is a file and not
// five literals inside a component: an axis that is purple on the mob page and blue on the tooltip
// is two axes as far as the person reading them is concerned.
//
// NO ACRONYMS, EVER (owner ruling, 2026-08-16). `MR`, `FR` and `CR` appear nowhere; the axis WORD
// is the label, and the colour and the word always travel together. That pairing is also the
// accessibility answer: five hues alone would ask a red-green colour-blind reader to distinguish
// poison from disease, and the word means they never have to.
//
// THIS IS OUR PRESENTATION CHOICE, NOT A COLOUR THE GAME STATES — the same disclaimer
// `shared/considerFaction.ts` carries about its faction ramp.
//
// ── WHY THESE FIVE, AND THE MEASUREMENT ─────────────────────────────────────────────────────────
//
// Five INDEPENDENT axes, so they want five distinguishable HUES rather than a ladder (the
// difficulty chips in `lib/tierChip.ts` are a ladder, and dropping a sixth hue into one of those
// would say "another rung"). Purple, orange, blue, green and gold are as far apart as this
// palette gets while staying inside the app's existing vocabulary — every one of them is a hue
// already used somewhere in the tree.
//
// Contrast ratio against the app's paper background (#171a21), measured:
//
//   magic    #a98fe0   6.38
//   fire     #e0834a   6.23
//   cold     #6fb3d2   7.51
//   poison   #5fbf72   7.61
//   disease  #c9b45a   8.42
//
// All five clear WCAG AA for normal text (4.5) on the dark ground, which is the only ground this
// app has — `theme/theme.ts` builds one dark theme and there is no light variant to satisfy. The
// same values are used as a BAR FILL, where the requirement is 3:1 for non-text UI, so there is
// margin either way. If a light theme ever lands, these need re-measuring, not re-picking: the
// hues are right, the lightness is what would have to move.

import type { ResistAxis } from '@shared/resistTypes'

export const RESIST_AXIS_COLORS: Record<ResistAxis, string> = {
  magic: '#a98fe0',
  fire: '#e0834a',
  cold: '#6fb3d2',
  poison: '#5fbf72',
  disease: '#c9b45a',
}

/** The colour a cell with too little behind it draws in. Grey says "not an answer". */
export const RESIST_UNKNOWN_COLOR = '#6b7280'
