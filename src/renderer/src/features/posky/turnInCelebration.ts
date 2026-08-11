// Pure turn-in matching + celebration detection (Task #46, JOS-131) — the testable core of
// the "celebrate a Sky quest turn-in, never on load" rule. Kept free of
// React/data-bundle imports so tests can exercise it directly (the useProgress module
// pulls in @shared value imports the bare test runner can't alias-resolve).
//
// The celebration mirrors the boss-defeat baseline contract (bossStatus.bossKills):
// the FIRST observation seeds a silent baseline, and only turn-ins observed AFTER the
// baseline count as live transitions. This keeps historical
// completions (already persisted, or found in the initial log scan) from firing
// confetti/sound on launch.
//
// JOS-131 MADE IT A COUNT. A Sky quest can be run again, so the baseline is a COUNT PER QUEST
// rather than a set of keys: the second turn-in of the same quest is a transition too, and it
// celebrates the same way the boss-kill watch celebrates a repeat kill ("every time is worth
// celebrating", owner 2026-08-04). Exactly-once is still guaranteed per turn-in, because the
// baseline advances to the count that just fired.

import type { PoskyQuest, TurnInEvent } from '@shared/types'
import type { TurnInInstants } from '@shared/questTurnIns'
import { itemCountKey } from '../../lib/itemName'
import { questKey } from './keys'

/**
 * Match logged turn-ins to quests: a quest is turned in when its giver received
 * (in one trade) every item the quest requires. The +N variant is normalized at the
 * matching boundary (a `Sphinx Claw +1` offer satisfies a `Sphinx Claw` requirement,
 * Task #42), so the user's `Brass Knuckles +2` loot satisfies the base requirement.
 *
 * Returns the INSTANTS, quest key → every `TurnInEvent.ts` that satisfied it (JOS-131). The
 * count is the list's length; the instants are what let a turn-in be placed relative to an
 * inventory dump, and what let the log's turn-ins merge with the persisted ones without
 * double-counting (shared/questTurnIns.ts owns that merge).
 */
export function countTurnIns(turnIns: readonly TurnInEvent[], quests: PoskyQuest[]): TurnInInstants {
  const out: TurnInInstants = {}
  for (const t of turnIns) {
    const npc = t.npc.toLowerCase()
    const offered = new Set(t.items.map((i) => itemCountKey(i)))
    for (const q of quests) {
      if (q.giver?.toLowerCase() !== npc) continue
      if (q.items.length > 0 && q.items.every((it) => offered.has(itemCountKey(it.name)))) {
        ;(out[questKey(q)] ??= []).push(t.ts)
      }
    }
  }
  return out
}

/** A turn-in that just happened, and which number it was for that quest. */
export interface TurnInTransition {
  key: string
  /** how many times this quest has now been turned in — 1 the first time, 2 the second */
  count: number
}

/**
 * Given the previous per-quest turn-in COUNTS (null = not yet baselined) and the current ones,
 * return the quests that just gained a turn-in. Returns [] on the baseline run (prev == null) —
 * the historical set is seeded silently and never celebrated.
 *
 * A count that GREW by more than one (a delta carrying two turn-ins of the same quest, or a
 * catch-up after the app was closed) reports ONE transition at the new count. The event being
 * celebrated is "you turned this in", not "here are N confetti bursts", and the count in hand is
 * the honest one to show.
 */
export function newlyCompletedTurnIns(
  prevCounts: Record<string, number> | null,
  counts: Record<string, number>
): TurnInTransition[] {
  if (prevCounts == null) return []
  const out: TurnInTransition[] = []
  for (const [key, count] of Object.entries(counts)) {
    if (count > (prevCounts[key] ?? 0)) out.push({ key, count })
  }
  return out
}
