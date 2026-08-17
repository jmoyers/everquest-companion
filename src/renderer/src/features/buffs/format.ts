// Small formatting helpers for BuffsView (kept out of the component for reuse/testing).

/**
 * Format a millisecond duration compactly: seconds under a minute, m:ss under an
 * hour, h:mm above. Null/≤0 renders as an em-dash.
 */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '-'
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (totalMin < 60) return `${totalMin}m ${sec.toString().padStart(2, '0')}s`
  const hr = Math.floor(totalMin / 60)
  const min = totalMin % 60
  return `${hr}h ${min.toString().padStart(2, '0')}m`
}

/**
 * Fraction of the estimated window still remaining (1 = just landed, 0 = expired),
 * clamped to [0,1]. Used to drive the progress bar. `estimatedMs` must be > 0.
 */
export function remainingFraction(elapsedMs: number, estimatedMs: number): number {
  if (estimatedMs <= 0) return 0
  const frac = 1 - elapsedMs / estimatedMs
  return frac < 0 ? 0 : frac > 1 ? 1 : frac
}

/**
 * True when a buff has run past its expected window (Task #30): elapsed exceeds the
 * p75 of observed durations, with at least 2 samples backing the estimate. Used to
 * flip the remaining-time from a (would-be-negative) countdown to a subtle "overdue"
 * hint. `p75`/`n` come straight off the ActiveBuff; null p75 or n<2 → not overdue.
 */
export function isOverdue(elapsedMs: number, p75: number | null, n: number): boolean {
  return p75 != null && n >= 2 && elapsedMs > p75
}

/**
 * WHAT THE PROVENANCE CHIP MEANS, in the user's words (JOS-117 + JOS-212 + JOS-379). All three
 * learned sources wear the same "log" chip because the number came from the log either way, but
 * they make DIFFERENT claims, so the tooltip must not be shared: 'observed' says the log ran longer
 * than the baseline, 'cluster' says the app's own repeated measurements overruled a baseline that
 * is too long (a classic-era wiki number for a spell this game re-tiered), and 'deathBound' says
 * something weaker than either — the mob died still carrying it, so the app knows a FLOOR under the
 * real duration and does not know the duration. Saying "longer than the baseline" for a shorter
 * number, or stating a bound as a measurement, are the two things this string may never do.
 */
export function estimatorSourceTitle(src: string | undefined): string {
  if (src === 'db') return 'The spell-database baseline'
  if (src === 'cluster') return 'From your logged casts - three clean casts agree it runs shorter than the baseline'
  if (src === 'deathBound') {
    return 'At least this long - the target died still carrying it and no wear-off was ever printed'
  }
  return 'From your logged casts - longer than the baseline'
}

/**
 * THE PREFIX A NUMBER WEARS WHEN IT IS A BOUND AND NOT AN ANSWER (JOS-379).
 *
 * `≥` for a death-bound estimate and nothing at all for every other source — the same device
 * `shared/respawn.ts` uses to print an upper-bounded respawn as `≤ 3m 00s`, pointing the other way
 * because the evidence points the other way. It is one character rather than a word because it sits
 * inline beside the figure in a table cell and in a countdown caption, and because a reader who
 * wants the sentence gets it from the tooltip.
 */
export function estimatePrefix(src: string | undefined): string {
  return src === 'deathBound' ? '≥ ' : ''
}

import type { ActiveBuff, BuffClass } from '@shared/types'

/**
 * The left-border accent color (an MUI theme path) for a buff-class (Task #35). A DEBUFF
 * (detrimental, cast on a hostile) is visually distinct with a red-ish accent so the user
 * never confuses a slow on an enemy with their own buff; beneficial buffs read gold.
 * NOTE (Task #35): the accent is a SPELL property (buff vs debuff), NOT who it's on — a
 * buff on the pet is not a different color from a buff on the player.
 */
export function classAccent(cls: BuffClass): string {
  return cls === 'debuff' ? 'error.main' : 'warning.main'
}

/**
 * The group key for the UI's PRIORITY layout (Task #35): self buffs first ('self'), then
 * one group per bound entity (the current pet naturally tops the per-entity list). Debuffs
 * on hostile mobs sit in their target's group but are styled distinct by `classAccent`.
 */
export function groupKey(b: ActiveBuff): string {
  return b.self ? 'self' : b.target ?? 'other'
}

/** Human label for an entity group header. */
export function groupLabel(key: string): string {
  return key === 'self' ? 'Your buffs' : key === 'other' ? 'Other targets' : key
}
