// TARGETS THE USER HID FROM THE RAID ROSTER (GitHub issue #32) — the fourth flag set in the
// `useQuestFlags` shape, at yet another granularity: a RAID TARGET, not a quest, a class or an
// item. It gets its own key for that file's standing reason — one key holding two intents makes
// one control silently drive the other — and the store is the same factory rather than a fifth
// copy of it.
//
// KEYED BY TARGET NAME, lowercased by the store: the name IS the roster's identity (32 unique
// names in the bundled data; `match` is log-matching vocabulary, not identity), and the
// lowercasing is the same casing armour the quest flags state — a future casing drift in the
// bundled roster must not orphan a user's hides.
//
// WHAT HIDING MEANS is rosterFilter.ts's business (the card leaves the roster, the counts, and
// the tally's denominator; kills and lockouts still record — hiding is display-only). This file
// owns only the set.

import { useMemo, useState } from 'react'
import {
  createQuestFlagStore,
  useQuestFlagSet,
  type QuestFlagSet
} from '../favorites/useQuestFlags'
import type { TargetStatus } from './bossStatus'

const HIDDEN_KEY = 'eq.bosses.hidden'

const hiddenStore = createQuestFlagStore(HIDDEN_KEY)

/** Raid targets the user hid from the Raid Targets tab, by lowercased target name. */
export function useHiddenTargets(): QuestFlagSet {
  return useQuestFlagSet(hiddenStore)
}

/**
 * The hide feature's whole view-state, bundled for BossView (which is at the measured
 * per-function ceiling): the persisted set, the UNPERSISTED peek — "show me what I hid" is a
 * moment, not a place in the grind, so a fresh mount opens on the roster the user asked for —
 * and the VISIBLE roster, which is the tally's denominator. A hidden target leaves that
 * denominator (the Sky tab's rule: a thing the app was told to forget must not be counted
 * against you), and the peek does not bring it back, because peeking is looking, not un-hiding.
 */
export function useHiddenRoster(statuses: TargetStatus[]): {
  hidden: QuestFlagSet
  showHidden: boolean
  setShowHidden: (v: boolean) => void
  roster: TargetStatus[]
} {
  const hidden = useHiddenTargets()
  const [showHidden, setShowHidden] = useState(false)
  const roster = useMemo(
    () => (hidden.size ? statuses.filter((s) => !hidden.has(s.target.name)) : statuses),
    [statuses, hidden]
  )
  return { hidden, showHidden, setShowHidden, roster }
}
