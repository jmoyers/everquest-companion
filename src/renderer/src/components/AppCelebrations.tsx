// components/AppCelebrations.tsx — the app's THREE always-mounted celebration watches, and the two
// snackbars they open, in one component that renders nothing else.
//
// ── WHY IT IS A COMPONENT AND NOT A HOOK IN App (JOS-510 item 2) ──────────────────────────────
//
// All of this used to run at App's ROOT: `useAppCelebrations` lived in App.tsx and the two toast
// states were App's own `useState`s. That put four live module subscriptions — kills, loot,
// turnins, leveling, plus character for the zone — and their state on the app's outermost
// component, so EVERY push to any of them re-rendered the ENTIRE application tree. A boss dying,
// an item dropping, a quest turning in, a level ding, or simply the character module reporting a
// zone change each re-rendered every tab, every card and every meter on screen, to move data that
// only two snackbars and three `window.eq.showToast` calls were ever going to read.
//
// The detectors have to stay MOUNTED — that is the whole point of them, they fire on any tab — but
// nothing says they have to be mounted at the ROOT. Moving them behind this component makes a
// push re-render THIS and only this: a component whose entire output is two `Snackbar`s that are
// closed almost all of the time. The app shell above it does not re-render at all.
//
// It owns its own state for the same reason. Lifting `defeatToast`/`questToast` into App bought
// nothing — no other part of the shell reads them — and cost a whole-tree re-render every time a
// celebration opened or auto-dismissed.
//
// ── THE THREE WATCHES, AND THE LAW THEY ALL OBEY ──────────────────────────────────────────────
//
// Exactly once per LIVE transition, and hydration seeds a silent baseline. Each of the three says
// it in its own file (useBossKills' `prevRef`, useProgress' `matchedBaselineRef`, useLevelUpToast's
// `baselineRef`) and each resets that baseline on a character switch, because main rebuilt the
// world. None of that moved in this ticket.

import { useCallback, useState, type JSX } from 'react'
import type { CharacterSnap } from '@shared/types'
import { skyQuestPage } from '@shared/wiki'
import CelebrationToasts from './CelebrationToasts'
import { useModule } from '../lib/useModule'
import { tierStyle } from '../lib/tierChip'
import AlertPlayer, { fireAppSignal } from '../features/alerts/player'
import { getBossData } from '../data'
import { useBossKills } from '../features/bosses/useBossKills'
import type { TargetStatus } from '../features/bosses/bossStatus'
import { useProgress } from '../features/posky/useProgress'
// The canonical `Class::Name` quest key — the same one the tracker keys its rows on, so the
// toast's anchor and the accordion it opens are the same string by construction.
import { questKey } from '../features/posky/keys'
// The third always-mounted celebration watch (docs/plans/levelup-whats-new.md §2): a LIVE ding
// fires the level-up toast, counting what it unlocked against the loadout AT THE DING'S ts.
import { useLevelUpToast } from '../features/leveling/useLevelUpToast'

const bossData = getBossData()

/**
 * The two ALWAYS-MOUNTED celebration watches, so both fire on any tab.
 *
 * Boss kills: useBossKills gates out the historical baseline. This is the SINGLE
 * always-mounted detector, so it's the one place we fire the 'bossDefeat' app signal for
 * the alerts extension. ONE callback carries all three surfaces — snackbar, sound and toast
 * fire on any roster kill CREDITED to you, repeats included, matching the confetti the Boss
 * tab bursts. A boss killed by a stranger in open world is tracked and celebrated by nobody
 * (owner, 2026-08-05); the credit test is the log's own experience line, which is also why a
 * GROUP kill still celebrates — party experience is experience.
 *
 * It used to be two (Task #24): the sound rode a narrower `onNewDefeat` — first kill at a new
 * instance tier — so the app cheered a repeat kill on screen and said nothing. Retired by the
 * owner 2026-08-04: "every time is worth celebrating." The alert's own cooldown is the rate
 * limit now, and fireAppSignal applies it, so even if the Boss tab's own detector fires in
 * the same instant it can't double-play.
 *
 * Sky turn-ins: useProgress seeds a silent baseline on the first hydrated snapshot, so
 * historical completions on load never fire — only a live turn-in transition does
 * (Task #46). This is the SINGLE always-mounted place we fire the 'questComplete' app
 * signal (sound) + the app-wide snackbar; PoskyView's own useProgress additionally bursts
 * confetti when that tab is open, and the shared cooldown stops a double-play. It is also
 * the ONE place a quest completion is reported into the live event feed (Task #59) — only
 * the renderer can match turn-ins against the posky dataset, so main can't detect this
 * itself. The report carries the QUEST link (the class's Plane of Sky Tests wiki page —
 * there are no per-quest pages) and, when the dataset names one, the reward item for the
 * event overlay's hover card. A quest with no known reward reports none: no fabricated
 * item (law 1).
 */
function useAppCelebrations(
  onDefeat: (s: TargetStatus) => void,
  onQuestComplete: (name: string) => void
): void {
  // Level-ups: the third watch, and the only one with no on-screen surface of its own — the
  // overlay card IS the celebration. It seeds its own silent baseline (the startup replay holds
  // every level the character ever gained) and joins its counts to the combo at the ding's ts.
  useLevelUpToast()

  // WHERE YOU ARE, from the module that owns that question (the ZoneStrip precedent). Read as a
  // plain value, not a ref: `useBossKills` refreshes its callback from every render before its
  // effect runs, so the closure below always holds the zone of the render the kill arrived in.
  const zone = useModule<CharacterSnap>('character')?.zone

  useBossKills(bossData.targets, {
    // THE TIER OF THIS KILL, AND THE INSTANCE IT HAPPENED IN (JOS-165). This block used to print
    // `tierStyle(s.bestTier)` and the roster's static zone — the target's ALL-TIME summary, which
    // is the right thing for the boss card and a false sentence on a per-event toast: the owner
    // clears d0 through d4 every week, so a Sunday d1 kill announced itself "D4 · Refined" all
    // the way back to the first Saturday he beat it at d4. The tier now comes off the KILL
    // (bossStatus.BossKill) and the zone off the CHARACTER module, so the toast says the instance
    // you were standing in — raw, as the game spells it (law 2), which is also the only way to
    // tell "- Solo 1 (Awakened)" from "- Group 2 (Awakened)". Only the toast changed: the card
    // badge still means highest-ever, because a card is a summary.
    onKill: ({ status: s, tier }) => {
      onDefeat(s)
      fireAppSignal('bossDefeat', s.target.name)
      window.eq.showToast({
        id: `boss:${s.target.name}:${String(s.lastTs)}`,
        kind: 'bossKill',
        title: `${s.target.name} defeated`,
        // A zone we have never seen a line for falls back to the roster's — never invented.
        subtitle: [tierStyle(tier).long, zone ?? s.target.zone].filter(Boolean).join(' · ')
      })
    }
  })

  useProgress({
    onQuestComplete: (q, count) => {
      onQuestComplete(q.name)
      fireAppSignal('questComplete', q.name)
      // The celebration toast (docs/plans/celebration-toasts.md T4) rides the SAME detector as
      // the sound and the snackbar — one live-only gate, three surfaces. The reward is sent by
      // NAME; main resolves the item card, because the overlay fetches nothing.
      // THE COUNT IS IN THE ID (JOS-131): a Sky quest can be run again, and the overlay keys its
      // cards by id, so the second turn-in of one quest has to be a second card.
      window.eq.showToast({
        id: `quest:${q.className}::${q.name}#${String(count)}`,
        kind: 'skyQuestComplete',
        title: `Quest complete: ${q.name}`,
        subtitle: q.giver ? `${q.className} · turned in to ${q.giver}` : q.className,
        itemName: q.reward,
        // ANCHORED AT THE QUEST since wave O2 (wave L shipped the tab and flagged this as the
        // follow-up): the canonical `Class::Name` key, which is what PoskyView reveals on.
        focus: { view: 'posky', quest: questKey(q) }
      })
      window.eq.reportFeedEvent({
        kind: 'quest',
        ts: Date.now(),
        title: q.name,
        detail: q.giver ? `turned in to ${q.giver}` : q.className,
        page: skyQuestPage(q.className),
        reward: q.reward ? { item: q.reward, page: q.rewardPage, stats: q.rewardStats } : undefined
      })
    }
  })
}

/**
 * The celebration surface, mounted once by App and rendering only its own snackbars.
 *
 * `AlertPlayer` rides here too, and for the same reason it was always mounted: it plays whatever
 * alert sounds have fired regardless of the active tab. It holds subscriptions of its own, so
 * keeping it at App's root would have left one more always-live listener on the outermost
 * component — the exact thing this component exists to get away from.
 */
export default function AppCelebrations(): JSX.Element {
  // App-wide "raid target defeated" toast — fires on any tab.
  const [defeatToast, setDefeatToast] = useState<TargetStatus | null>(null)
  // App-wide "quest complete" toast — fires on any tab the instant a Sky turn-in
  // auto-completes a quest.
  const [questToast, setQuestToast] = useState<string | null>(null)

  useAppCelebrations(setDefeatToast, setQuestToast)

  const dismissDefeat = useCallback(() => setDefeatToast(null), [])
  const dismissQuest = useCallback(() => setQuestToast(null), [])

  return (
    <>
      {/* Always-mounted: plays fired alert sounds regardless of the active tab. */}
      <AlertPlayer />
      <CelebrationToasts
        defeatToast={defeatToast}
        questToast={questToast}
        onDismissDefeat={dismissDefeat}
        onDismissQuest={dismissQuest}
      />
    </>
  )
}
