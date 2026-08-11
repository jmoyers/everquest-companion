// Pure boss-status derivation shared by BossView (cards + confetti) and App (the
// app-wide "raid target defeated" snackbar), so both agree on exactly what counts
// as a defeat and when a NEW defeat happened.

import type { KillMap, KillTierRun, RaidTarget } from '@shared/types'
// RELATIVE value import: this module is unit-tested under node/tsx, which has no `@shared`
// alias (the mobSearch.ts precedent — AGENTS.md, Toolchain gotchas).
import { addTierRun, killTotals } from '../../../../shared/kills'

export interface TargetStatus {
  target: RaidTarget
  killed: boolean
  /** highest tier across `tiers` — for a per-tier row this IS that row's tier. */
  bestTier: number
  count: number
  firstTs: number
  lastTs: number
  /**
   * How many of `count` were CREDITED to you — an experience line joined the slain line
   * (shared/kills.ts). The CELEBRATION predicate below is the only reader; every tracking
   * surface (killed, count, tiers, dates, badges) reads the plain count and is unaffected.
   */
  credited: number
  /**
   * The per-instance-tier breakdown of this target's kills, folded across every one of its
   * roster `match` names. A card grouped by class loadout is built from ONE of these runs, so
   * the tier it badges and the timestamp it joins on come from the same kills (shared/kills.ts).
   */
  tiers: Record<number, KillTierRun>
}

/**
 * Canonical match key: lowercase + strip a single leading article. EQ writes the
 * same mob with a capitalized article at sentence start ("A thunder spirit
 * princess" on slain-by lines) and lowercase mid-sentence, and roster `match`
 * names ("Thunder Spirit Princess") carry no article at all — so both sides must
 * be article-insensitive or the princess (killed by a charmed pet, hence a
 * slain-by line) reads as undefeated.
 */
function matchKey(name: string): string {
  return name.toLowerCase().replace(/^(?:an?|the) /, '').trim()
}

/**
 * Re-key a KillMap by the article-insensitive match key. Kill-map keys are already
 * canonical lowercase (kills module keys via idKey), so this only strips leading
 * articles; if two article variants ever collide, the higher-count entry wins.
 */
export function lowerKillMap(kills: KillMap): KillMap {
  const m: KillMap = {}
  for (const [name, info] of Object.entries(kills)) {
    const k = matchKey(name)
    const prev = m[k]
    if (!prev || info.count > prev.count) m[k] = info
  }
  return m
}

/** Fold a target's roster `match` names against the (article-insensitive) kill map. */
export function statusFor(target: RaidTarget, killByLower: KillMap): TargetStatus {
  const tiers: Record<number, KillTierRun> = {}
  let killed = false
  for (const name of target.match) {
    const info = killByLower[matchKey(name)]
    if (!info) continue
    killed = true
    for (const [tier, run] of Object.entries(info.tiers)) addTierRun(tiers, Number(tier), run)
  }
  // The scalars are a fold of `tiers`, exactly as KillInfo's are — one source, no drift.
  return { target, killed, ...killTotals(tiers), tiers }
}

/**
 * The same target seen through ONE of its tier runs: the card a loadout section draws. Every
 * scalar is re-derived from the given runs, so the badge, the dates and the count all describe
 * the same kills — which is the whole point of the per-tier record. A target with a single
 * tier projects to a status identical to its unprojected self (pinned in tests).
 */
export function projectStatus(s: TargetStatus, tiers: Record<number, KillTierRun>): TargetStatus {
  return { target: s.target, killed: true, ...killTotals(tiers), tiers }
}

export function allStatuses(targets: RaidTarget[], kills: KillMap): TargetStatus[] {
  const lower = lowerKillMap(kills)
  return targets.map((t) => statusFor(t, lower))
}

/**
 * ONE KILL, as the celebration detector reports it: the target's status AFTER the kill, and the
 * INSTANCE TIER that kill happened on.
 *
 * WHY THE TIER IS NOT ON THE STATUS (JOS-165). A TargetStatus is a FOLD over every kill the
 * target has ever taken — `bestTier` is its highest tier EVER, which is exactly right on a card
 * and exactly wrong on a per-event toast. The owner clears d0 through d4 every week, so a d1
 * kill announced as "D4 · Refined" is not a summary, it is a wrong sentence about a thing that
 * just happened. The tier of THIS kill is a fact about the EVENT, so it rides the event
 * (world-model law 10, the same argument that put `tier` and `credited` on the kill record
 * rather than beside it) and never widens the fold's shape with a field that means nothing on
 * the 500 statuses no kill just fired for.
 */
export interface BossKill {
  /** The target AFTER the kill — the same fold the cards read, unchanged. */
  status: TargetStatus
  /** The instance difficulty tier THIS kill happened on (0 = base … 4 = Refined). */
  tier: number
}

/**
 * WHICH TIER just got a kill: the run whose CREDITED count grew, most recent first.
 *
 * The kill record is a per-tier breakdown, so "what tier was that kill" is answerable by diffing
 * the previous snapshot's runs against the current one — no new state, no second source. Ties
 * (two runs grown by one delta, which takes two instances inside 100 ms) resolve to the run whose
 * most recent credited kill is LATEST, then to the higher tier; that is the kill the toast is
 * about, since a delta is delivered after the fold that produced it.
 *
 * The `bestTier` seed is unreachable from `bossKills` — it only asks after `credited` grew, and a
 * total cannot grow unless one of its runs did — and is stated rather than thrown because a
 * celebration that cannot name its tier should still celebrate.
 */
function killedTier(before: TargetStatus | undefined, after: TargetStatus): number {
  let tier = after.bestTier
  let at = -1
  for (const [key, run] of Object.entries(after.tiers)) {
    const n = Number(key)
    if (run.credited <= (before?.tiers[n]?.credited ?? 0)) continue
    if (run.lastCreditedTs < at || (run.lastCreditedTs === at && n < tier)) continue
    at = run.lastCreditedTs
    tier = n
  }
  return tier
}

/**
 * ANY roster-boss kill CREDITED TO YOU: a target whose credited-kill count increased since the
 * previous snapshot — including a REPEAT kill at the same-or-lower tier. Compares a previous
 * status snapshot (keyed by target name) to the current one; returns the kills that just landed,
 * each carrying the TIER it landed on (see BossKill — the per-event fact the fold cannot state).
 *
 * THE ONLY DEFEAT PREDICATE THERE IS, since 2026-08-04. It drives confetti, the card flash,
 * the snackbar, the celebration toast AND the bossDefeat alert sound. There used to be a second,
 * narrower one — `newDefeats`, "first kill at a new instance tier" — which gated the SOUND alone,
 * so killing Lord Nagafen a second time was silent. The owner's call: "every time is worth
 * celebrating." A boss is not a checklist item, so a second kill is not a lesser event; the
 * alert's own cooldown is where "don't repeat yourself" belongs, not a first-time-only predicate.
 *
 * CREDITED, NOT MERELY OBSERVED (owner, 2026-08-05: "it looks like it's celebrating even when I'm
 * not the killer of the boss — I'm in open world and somebody killed. If I'm not in a group with
 * them, it should not count."). The kills module counts every boss that DIES anywhere in your
 * log, which is right for the roster — a thunder spirit princess that died at 00:33:45 on Wed Aug
 * 05 to a passing stranger is a defeated mob, and the tracker records it. It is not a thing to
 * cheer. The distinction the log actually makes is the experience line: yours and your group's
 * kills print one immediately before the slain line, a stranger's prints nothing. So celebration
 * reads `credited` and tracking still reads `count` — one predicate moved, no state moved.
 *
 * WHAT DID NOT CHANGE: the baseline. `useBossKills` seeds silently on the first snapshot, so
 * this only ever sees LIVE transitions — history loaded on character switch celebrates
 * nothing (AGENTS.md: celebrations fire on live transitions; hydration seeds a baseline).
 */
export function bossKills(
  prev: Map<string, TargetStatus>,
  next: TargetStatus[]
): BossKill[] {
  const out: BossKill[] = []
  for (const s of next) {
    if (!s.killed) continue
    const before = prev.get(s.target.name)
    const prevCredited = before?.credited ?? 0
    if (s.credited > prevCredited) out.push({ status: s, tier: killedTier(before, s) })
  }
  return out
}
