// THE LEVEL THE LEVELING TAB IS SHOWING — one number, two panels (JOS-445).
//
// It lived inside `NewAtLevelPanel` while that panel was the only thing that had a level to show.
// The best-spells readout is the second, it sits in the OTHER column, and the owner's ask is that
// stepping the level re-ranks it — so the state has to be above both of them. Both panels draw a
// stepper now (owner ask 2026-08-23), and that is safe for exactly this reason: two handles on ONE
// state always show one number, where two states would have been two levels on one screen.
//
// `null` MEANS "FOLLOW THE CHARACTER", not "level 1". That distinction is what keeps the tab
// tracking dings until the reader steps it, and what makes the `back to N` chip a return to the
// character rather than a jump to a remembered number.
//
// The band is the DB's (1..63) with a ceiling that leaves room to grow, and clamping is done in one
// place so a deep link, a keypress and a stepper click cannot disagree about what level 0 means.

import { useState } from 'react'

export const LEVEL_MIN = 1
export const LEVEL_MAX = 65

export function clampLevel(n: number): number {
  return Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, Math.round(n)))
}

export interface ViewedLevel {
  /** The level every panel on the tab reads. Always inside the band. */
  level: number
  /** What the reader picked, or null while the tab is still following the character. */
  picked: number | null
  /** Pick a level, or null to go back to following the character. */
  pick: (n: number | null) => void
}

/**
 * The tab's viewed level. `currentLevel` is the character's own (JOS-192's stated level), which is
 * where the tab sits until somebody steps it.
 */
export function useViewedLevel(currentLevel: number | null): ViewedLevel {
  const [picked, setPicked] = useState<number | null>(null)
  return { level: clampLevel(picked ?? currentLevel ?? LEVEL_MIN), picked, pick: setPicked }
}
