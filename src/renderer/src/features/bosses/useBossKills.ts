// useBossKills — kills module → roster boss statuses, plus the kill callback fired
// live (never for the historical baseline loaded on character load). Used by both
// BossView (cards + confetti + card flash) and App (the app-wide snackbar + the
// bossDefeat alert sound) so they share ONE definition of "a boss just died".
//
// ONE TIER OF DETECTION, since 2026-08-04:
//   - onKill — ANY roster-boss kill CREDITED TO YOU, including a repeat at the
//              same/lower tier. Confetti, card flash, snackbar, toast AND the
//              bossDefeat sound.
//
// CREDITED, not merely observed (owner, 2026-08-05). A boss that dies to a stranger
// across an open-world zone is still recorded by the kills module — the roster is a
// record of what has died, and that is a world fact. It is not YOUR kill, and the log
// says which is which: an experience line lands just before the kills you (or your
// group) are paid for. `bossStatus.bossKills` compares the CREDITED count for exactly
// that reason; every status this hook returns is unchanged.
// It used to be two: a narrower `onNewDefeat` (first kill at a new instance tier)
// carried the sound, so a repeat kill was celebrated on screen and silent in the
// ears. The owner retired that split — "every time is worth celebrating" — and
// rate-limiting now belongs to the alert's own cooldown, which fireAppSignal
// applies. See bossStatus.bossKills.
//
// The baseline problem: the first snapshot already contains every boss killed in
// the past. If we compared that against an empty `prev`, every historical kill
// would look "new" and fire confetti on launch. So we seed the baseline silently
// on the first state we see and only emit for changes after that.

import { useEffect, useRef, useState } from 'react'
import type { KillMap, KillsSnap, RaidTarget } from '@shared/types'
import { useModule } from '../../lib/useModule'
import { allStatuses, bossKills, type BossKill, type TargetStatus } from './bossStatus'

export interface BossKillCallbacks {
  /**
   * Fired for any roster-boss kill CREDITED to you, seen live (incl. repeats). The payload is
   * the KILL, not just the target: `status` is the fold every card reads and `tier` is the
   * instance tier THIS kill happened on, which is the only tier a per-event surface may state
   * (JOS-165 — the toast used to reach for the target's highest-ever tier instead).
   */
  onKill?: (kill: BossKill) => void
}

export function useBossKills(
  targets: RaidTarget[],
  cbs?: BossKillCallbacks
): { kills: KillMap; statuses: TargetStatus[] } {
  // Per-mob wholesale replace, with the shape guard: a delta stamped with a version the held
  // baseline was not written at re-hydrates instead of merging (shared/kills.ts).
  const snap = useModule<KillsSnap>('kills')
  const kills = snap?.mobs
  const [statuses, setStatuses] = useState<TargetStatus[]>([])
  // Previous per-target status; seeded silently on first snapshot.
  const prevRef = useRef<Map<string, TargetStatus> | null>(null)
  const cbsRef = useRef(cbs)
  cbsRef.current = cbs

  // Reset the baseline when the kills state is replaced wholesale (character
  // switch re-hydrates to a fresh object). We detect that by identity: a delta
  // mutates via spread into a new object too, so instead we clear the baseline
  // whenever the character changes.
  useEffect(() => {
    const off = window.eq.onCharacter(() => {
      prevRef.current = null
    })
    return off
  }, [])

  useEffect(() => {
    if (!kills) return
    const next = allStatuses(targets, kills)
    setStatuses(next)
    const prev = prevRef.current
    if (prev != null) {
      // Any CREDITED kill, repeats included → confetti/snackbar/toast/sound. `prev != null` is
      // the baseline guard: the first snapshot after a character switch celebrates nothing.
      for (const kill of bossKills(prev, next)) cbsRef.current?.onKill?.(kill)
    }
    prevRef.current = new Map(next.map((s) => [s.target.name, s]))
  }, [kills, targets])

  return { kills: kills ?? {}, statuses }
}
