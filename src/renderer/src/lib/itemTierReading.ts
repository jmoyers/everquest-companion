// itemTierReading.ts — what ItemWindow's tier meter reads, split out of ItemWindow.tsx (file
// ceiling). Pure: no React, so the order of precedence below is reachable from a node test.

// RELATIVE import, not `@shared`: kept node-testable (the tierChip.ts precedent).
import { percentLabel, type ItemUpgradeState } from '../../../shared/itemUpgrade'

/**
 * What the tier meter draws, or nothing (no `tier`) when no one has stated a level.
 * A simulated state wins outright: the reader chose it. Otherwise the displayed NAME wins when
 * it states a level — that is this exact instance's tier, what the game itself would print. The
 * observed tier is the fallback for a base name ("what have I got this item to?"), tagged `yours`.
 */
export function tierReading(
  upgrade?: ItemUpgradeState,
  nameTier?: number,
  observedTier?: number
): { tier?: number; note?: string; bonus?: string } {
  if (upgrade) return { tier: upgrade.full, note: 'simulated', bonus: `${percentLabel(upgrade)} stats` }
  if (nameTier !== undefined) return { tier: nameTier }
  return observedTier === undefined ? {} : { tier: observedTier, note: 'yours' }
}
