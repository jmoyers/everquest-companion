// useLevelUpToast — the DING DETECTOR (docs/plans/levelup-whats-new.md §2).
//
// THE CELEBRATIONS LAW IS THIS FILE'S WHOLE DISCIPLINE: exactly once per LIVE transition, and
// hydration seeds a silent baseline. The startup replay fills the `leveling` module with every
// level the character ever gained; the first snapshot this hook sees is therefore the PAST, and
// celebrating it would fire forty toasts on launch. So the first observation only records the
// newest timestamp it saw, and only dings ARRIVING AFTER it toast — the useBossKills /
// turnInCelebration idiom, which is the same law written for a different module. A character
// switch clears the baseline for the same reason it does there: main rebuilt the world.
//
// LAW 10 IS WHY THE COUNTS ARE JOINED AT READ. "3 new spells · 2 new skills" is computed against
// `comboAt(intervals, ding.ts)` — the loadout as of THE DING, not as of now and never a stamped
// id. A `/who` typed an hour later retroactively re-labels that span; the toast that already
// fired is gone, but the panel the toast links to recomputes from the same join and will be
// right, with nothing to reconcile.
//
// It is deliberately a hook with no return value, mounted once in App beside the boss-kill and
// Sky-turn-in watches: three detectors, one place, so "what celebrates" is one file's list.

import { useEffect, useRef } from 'react'
import type { ComboInterval } from '@shared/classCombo'
import { comboClassesAt, levelUpSubtitle, unlocksAtLevel } from '@shared/levelUnlocks'
import type { LevelEvent, LevelingSnap } from '@shared/types'
import { useModule } from '../../lib/useModule'
import { useComboIntervals } from '../profiles/ClassComboData'
import { levelUnlocks } from './useLevelUnlocks'

/** The newest ding in a snapshot, or null when the character has never levelled in this log. */
function newestDing(levels: readonly LevelEvent[]): number | null {
  let newest: number | null = null
  for (const l of levels) if (newest === null || l.ts > newest) newest = l.ts
  return newest
}

/**
 * Build and send ONE level-up toast. Async only because the unlock dataset is an IPC pull that
 * has almost certainly already resolved (the panel and this share one cached promise) — the
 * title never waits on it in practice, and if the pull failed the card still celebrates the
 * level with no subtitle rather than not celebrating at all.
 */
async function fireLevelUpToast(ding: LevelEvent, intervals: readonly ComboInterval[]): Promise<void> {
  const data = await levelUnlocks()
  const unlocks = unlocksAtLevel(data, comboClassesAt(intervals, ding.ts), ding.level)
  window.eq.showToast({
    // The ding's own timestamp is the dedupe key: the same level reached twice (a loadout swap
    // levels the new class back up through it) is two celebrations, as it should be.
    id: `level:${String(ding.level)}:${String(ding.ts)}`,
    kind: 'levelUp',
    title: `Level ${String(ding.level)}!`,
    subtitle: levelUpSubtitle(unlocks),
    // The click target: the Leveling tab, panel anchored at the level that just dinged.
    focus: { view: 'leveling', level: ding.level }
  })
}

/** Watch the leveling module and toast every LIVE ding. Mount once, app-wide. */
export function useLevelUpToast(): void {
  const state = useModule<LevelingSnap>('leveling')
  // Read at FIRE time, not at render time: the intervals a ding is joined against are whatever
  // the combo module knows the instant it lands.
  const intervals = useComboIntervals()
  const intervalsRef = useRef(intervals)
  intervalsRef.current = intervals
  // null = "no baseline yet"; the first snapshot sets it and celebrates nothing.
  const baselineRef = useRef<number | null>(null)

  useEffect(() => {
    const off = window.eq.onCharacter(() => {
      baselineRef.current = null
    })
    return off
  }, [])

  useEffect(() => {
    if (!state) return
    const newest = newestDing(state.levels)
    if (newest === null) return
    const baseline = baselineRef.current
    baselineRef.current = newest
    if (baseline === null) return
    // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives LevelEvent. Becomes a view descriptor when the source lands.
    for (const ding of state.levels.filter((l) => l.ts > baseline).sort((a, b) => a.ts - b.ts)) {
      void fireLevelUpToast(ding, intervalsRef.current)
    }
  }, [state])
}
