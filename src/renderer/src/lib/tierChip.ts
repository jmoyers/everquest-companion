// Raid-difficulty tier chip colors (Task #44). EQ Legends instances have a
// difficulty tier d0..d4 (base / Awakened / Adaptive / Fused / Refined). BossView
// renders a small filled chip labelled "D0".."D4" on each defeated boss card —
// plus, since JOS-166, the two chips for kills that happened at no difficulty at
// all (see OPEN_WORLD_STYLE / UNKNOWN_TIER_STYLE below).
//
// THE BUG the user reported ("the chip color/text for the raid fights is hard to
// read for some tiers (like the text that says D(N))"): the chips painted WHITE text
// on light chip backgrounds — WCAG contrast on the dark theme was only ~2.1 (D4
// gold), ~2.3 (D1 green / D2 blue), ~3.1 (D3 purple): well under the 4.5 small-text
// threshold. The gold D4 and green D1 were the worst offenders.
//
// FIX: one shared source of truth for the { bg, fg, label, long } of each tier, with
// a hand-tuned DARK foreground on the colored chips (dark text on a saturated mid
// color reads far better than white). Measured contrast (fg vs bg), dark theme:
//   D0  bg #9aa0a6 (lightened from #7a7a7a so dark text clears 4.5) fg #10131a → 7.04
//   D1  bg #5fbf72  fg #10131a → 8.12   (was white 2.29 → FAIL)
//   D2  bg #6fb3d2  fg #10131a → 8.01   (was white 2.32 → FAIL)
//   D3  bg #b07fd0  fg #10131a → 6.01   (was white 3.09 → below 4.5)
//   D4  bg #e0a94a  fg #10131a → 8.80   (was white 2.11 → FAIL, the cited case)
// All comfortably pass WCAG AA (4.5) for normal text. Used by BossView (and any
// future tier-chip surface) so they stay consistent.

// RELATIVE value import, not `@shared`: this table is pulled in by features/bosses/lockout.ts,
// which is unit-tested under node/tsx where no alias and no bundler exist (the mobSearch.ts
// precedent — AGENTS.md, Toolchain gotchas).
import { TIER_OPEN_WORLD } from '../../../shared/kills'

export interface TierStyle {
  /** chip background */
  bg: string
  /** chip foreground (text/icon) — accessible on bg in the dark theme */
  fg: string
  /** short label, e.g. "D2" */
  label: string
  /** long/tooltip label, e.g. "D2 · Adaptive" */
  long: string
}

// Near-black foreground; matches the dark theme's ink and clears 4.5 on every tier bg.
const TIER_FG = '#10131a'

export const TIER_STYLES: TierStyle[] = [
  { bg: '#9aa0a6', fg: TIER_FG, label: 'D0', long: 'D0 · base' },
  { bg: '#5fbf72', fg: TIER_FG, label: 'D1', long: 'D1 · Awakened' },
  { bg: '#6fb3d2', fg: TIER_FG, label: 'D2', long: 'D2 · Adaptive' },
  { bg: '#b07fd0', fg: TIER_FG, label: 'D3', long: 'D3 · Fused' },
  { bg: '#e0a94a', fg: TIER_FG, label: 'D4', long: 'D4 · Refined' }
]

// THE TWO NON-DIFFICULTIES (JOS-166). A kill record's tier key is a difficulty OR one of these
// (shared/kills.ts), and each needs a chip of its own — the whole point of separating them is
// that an open-world kill must stop reading as a base-difficulty clear.
//
// They are deliberately NOT in the palette above. The five difficulties are a colour LADDER, and
// dropping a sixth hue into it would say "another rung"; these are dark neutrals with light text,
// which reads as "off the ladder" before the label is even parsed. Contrast, dark theme:
//   OW  #f3f5f8 on #4b5563 → 7.44        ?  #f3f5f8 on #3a3f4a → 9.56
// Both clear WCAG AA (4.5) by the same measurement the palette above documents.
const OFF_LADDER_FG = '#f3f5f8'

/** No instance at all: a bare zone name. There is no lockout to be on. */
export const OPEN_WORLD_STYLE: TierStyle = {
  bg: '#4b5563',
  fg: OFF_LADDER_FG,
  label: 'OW',
  long: 'Open world · no lockout'
}

/** The log never said where: no zone line yet, or an instance adjective we cannot decode. */
export const UNKNOWN_TIER_STYLE: TierStyle = {
  bg: '#3a3f4a',
  fg: OFF_LADDER_FG,
  label: '?',
  long: 'Difficulty not stated'
}

/**
 * The style for a tier KEY — one of the five difficulties, or one of the two off-ladder answers.
 * A difficulty above the known five still clamps to D4 (a decoder that learns a sixth adjective
 * would want a colour here before it wants a crash).
 */
export function tierStyle(tier: number): TierStyle {
  if (tier === TIER_OPEN_WORLD) return OPEN_WORLD_STYLE
  if (tier < TIER_OPEN_WORLD) return UNKNOWN_TIER_STYLE
  return TIER_STYLES[Math.min(TIER_STYLES.length - 1, tier)] ?? TIER_STYLES[0]
}
