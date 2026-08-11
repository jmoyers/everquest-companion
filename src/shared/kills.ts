// THE KILL RECORD — per-mob kill history broken down PER INSTANCE TIER, the pure helpers
// that derive its convenience scalars, and the kills module's IPC shapes. Re-exported from
// types.ts (which sits at the 400-line factoring cap), so every existing
// `import type { KillInfo, KillMap } from '@shared/types'` keeps working unchanged.
//
// WHY PER TIER (2026-08-04, owner-verified misattribution). The record used to be five
// scalars — {count, bestTier, firstTs, lastTs, display} — and the fold took Math.max on BOTH
// the tier and the timestamp, so those two facts could come from DIFFERENT kills. The bosses
// view then grouped each target by the class-combo interval covering its `lastTs` while
// painting `bestTier`: Lord of Ire, killed at d4 on Aug 01 (a PAL/MNK/ENC loadout) and again
// at d0 on Aug 03 (ROG/PAL/BER), rendered a d4 badge filed under ROG/PAL/BER — a loadout that
// never killed it at d4. The combo-interval layer was right; the KILL RECORD was lossy.
//
// `tiers` is the TRUTH. The four scalars are DERIVED from it (`killTotals`) and kept only so
// consumers that legitimately want the whole-mob summary (mob page, loot sourcing, the
// new-defeat signal) keep working. One fold writes the tiers map; nothing writes a scalar by
// hand. See world-model law 10: the tier is a fact ABOUT a kill, so it lives with the kill —
// the combo interval, which is revisable, is still joined at read time and never stamped.

/**
 * How far BACK a kill line may reach for the experience line that credits it. The measured gap
 * is 0 s or 1 s (the full-log sweep quoted in main/modules/progression.ts: the exp line PRECEDES
 * its kill line, same second, 4,887 of 4,909), so 2.5 s is generous slack over the observed
 * spread while staying far under the time between kills — it absorbs the log's one-second
 * timestamp resolution, it does not hunt for a plausible line.
 *
 * It lives HERE, with the kill record, because two modules now join on it (the progression
 * series and the kills tracker's credit flag) and a second copy of the number is a second
 * answer to "was this kill yours".
 */
export const KILL_EXP_JOIN_MS = 2500

// ─────────────────────────────────────────────────────────────────────────────
// THE TIER KEY — what a kill record's `tiers` map is keyed BY (JOS-166)
// ─────────────────────────────────────────────────────────────────────────────
//
// A key is either one of the game's FIVE difficulties (0 = base … 4 = Refined) or one of the two
// NON-difficulties below. Before 2026-08-09 there were only the five, and key 0 carried three
// different worlds at once: a base-difficulty instance, the open world (which has no lockout of
// any kind), and a kill folded before the scan had seen any zone line at all. The owner clears
// d0 through d4 every week, so that conflation was not an edge case — it was the base rung of
// every weekly ladder, which the UI had to draw as an unfilled outline because the model could
// not commit to what it meant.
//
// The ZONE LINE can commit, and always could (`zoneTier`, main/log/parseWorld.ts): an instance
// entry carries a `- Solo`/`- Group N` suffix, an ordinal, or a difficulty adjective; the open
// world carries a bare zone name and nothing else. So the three worlds are now three different
// keys, and only the five difficulties are difficulties.

/**
 * The kill happened in the OPEN WORLD — a bare zone name, no instance of any kind.
 *
 * It is not d0 and it is not a lesser d0: the community wiki's instances-and-lockouts guide puts
 * the weekly lockout on a boss PER DIFFICULTY of its INSTANCE, and an open-world spawn has no
 * instance to be locked out of. These kills are counted (a boss that died is a boss that died —
 * the roster is right to record it) and they can never fill a ladder rung.
 */
export const TIER_OPEN_WORLD = -1

/**
 * The log did not STATE where this kill happened, so nothing about its difficulty is known.
 *
 * Two causes, both real: a kill folded before the scan reached any `You have entered` line (a log
 * that starts mid-session), and an instance whose difficulty adjective this app has never decoded.
 * Claiming d0 for either is the exact lie this vocabulary exists to stop — "the log didn't say"
 * is not "the base difficulty" (world-model law 1).
 */
export const TIER_UNKNOWN = -2

/** Every instance difficulty the game offers, base first. Mirrors TIER_STYLES / TIER_LABELS. */
export const DIFFICULTY_TIERS = [0, 1, 2, 3, 4]

/**
 * True when a tier key names one of the game's five difficulties — i.e. when it can carry a
 * weekly lockout. False for the two non-difficulties above and for any key outside the five.
 */
export function isDifficultyTier(tier: number): boolean {
  return DIFFICULTY_TIERS.includes(tier)
}

/**
 * One mob's kills at ONE tier key — a difficulty, or one of the two non-difficulties above.
 * `firstTs`/`lastTs` bracket that key's kills only — which is what makes an honest per-tier
 * time join possible.
 */
export interface KillTierRun {
  count: number
  /** first kill of this mob AT THIS TIER (ms) */
  firstTs: number
  /** most recent kill of this mob AT THIS TIER (ms) */
  lastTs: number
  /**
   * How many of this run's `count` kills were CREDITED to you — i.e. an experience line landed
   * within KILL_EXP_JOIN_MS before the slain line (main/modules/kills.ts owns the join).
   *
   * WHY IT LIVES ON THE RUN. Credit is a fact ABOUT a kill, exactly as the tier is (world-model
   * law 10), so it belongs with the kill rather than in a parallel structure that could drift
   * from the record it describes. `credited <= count` always: your own kills, your pet's, and a
   * group-mate's killing blow (party experience credits you) are credited; a stranger's
   * open-world kill you merely WITNESSED is counted for tracking and credited to nobody.
   *
   * ONLY CELEBRATION reads it (bossStatus.bossKills). Tracking — the roster's defeated state,
   * the tier badges, the counts, the dates — reads `count` and is unchanged by it.
   */
  credited: number
  /**
   * WHEN the most recent CREDITED kill of this run happened (ms), or 0 if none of them were
   * yours. `lastTs` cannot answer that: it is the most recent kill of this mob at this tier
   * WHOEVER landed it, so a stranger's open-world kill moves it and `credited` (a count) says
   * nothing about which kill it counted.
   *
   * The weekly LOCKOUT view is what needed the distinction (JOS-74). A lockout is a fact about
   * a kill YOU were paid for, so "am I locked this week" is `lastCreditedTs >= <this week's
   * reset>` — and with only `lastTs` to read, a boss a passer-by killed on Wednesday would have
   * reported you locked out of loot you never took. Same argument as `credited` itself: credit
   * is a fact ABOUT a kill (world-model law 10), so its timestamp lives with the kill.
   */
  lastCreditedTs: number
}

/** Aggregated kill info for a mob (for loot sourcing + boss instance tiers). */
export interface KillInfo {
  /** DERIVED from `tiers`: total kills across every tier. */
  count: number
  /**
   * DERIVED from `tiers`: the HIGHEST tier key with kills on it (0=base … 4=Refined).
   *
   * A mob only ever killed outside an instance has no difficulty to report, and says so rather
   * than defaulting to 0: the key ordering puts both non-difficulties below d0, so this reads
   * TIER_OPEN_WORLD for an open-world-only record and TIER_UNKNOWN for one with no zone line
   * behind it (or for a mob with no kills at all).
   */
  bestTier: number
  /** DERIVED from `tiers`: first time this mob was killed at ANY tier (ms). */
  firstTs: number
  /** DERIVED from `tiers`: most recent kill at ANY tier (ms). */
  lastTs: number
  /** DERIVED from `tiers`: how many kills at ANY tier were credited to you (see KillTierRun). */
  credited: number
  /**
   * Human-readable display name (original casing/article of the first-seen slain
   * line). The KillMap is KEYED by the canonical lowercase name so that
   * sentence-start "A thunder spirit princess" (slain-by lines) and mid-sentence
   * "a thunder spirit princess" (You-have-slain lines) fold into one entry.
   */
  display: string
  /**
   * THE RECORD. Per-tier breakdown keyed by the tier key (the five difficulties plus
   * TIER_OPEN_WORLD / TIER_UNKNOWN); a key with no kills is absent, never a zero row. Every
   * scalar above is a fold of this map.
   */
  tiers: Record<number, KillTierRun>
}

/** Kill info keyed by CANONICAL (lowercase) mob name; see KillInfo.display. */
export type KillMap = Record<string, KillInfo>

/**
 * Shape version of a KillInfo entry, stamped onto every kills snapshot and delta.
 *
 * 1 = the five-scalar record (no `tiers`); 2 = the per-tier record; 3 = the same with each run
 * carrying how many of its kills were exp-CREDITED; 4 = the same with each run also carrying
 * WHEN its most recent credited kill landed (`lastCreditedTs`, the weekly lockout's input);
 * 5 = the same runs under a WIDER tier key (JOS-166) — key 0 now means the base-difficulty
 * INSTANCE alone, and the open world and the unknown zone have keys of their own. No field
 * changed shape, but 0 changed MEANING, which is exactly what this stamp is for: a renderer
 * merging v5 deltas into a v4 baseline would keep untouched mobs whose key 0 still conflates
 * three worlds, and would green ladder rungs off them.
 * It exists for ONE
 * hazard, which is real in dev and at every app update: the delta is a PER-MOB merge, so a
 * renderer holding a v1 baseline that starts receiving v2 deltas would keep every untouched
 * mob's narrow entry forever — a stale record surviving the fix that replaced it. The
 * renderer compares the delta's version against the baseline it hydrated and, on a mismatch,
 * throws the baseline away and re-hydrates rather than merging across shapes. Bump this
 * whenever a KillInfo field changes meaning.
 */
export const KILLS_SHAPE_VERSION = 5

/** kills module snapshot: the map plus the shape version its entries were written at. */
export interface KillsSnap {
  v: number
  mobs: KillMap
}

/**
 * kills module delta: the per-mob entries that changed, stamped with the shape version.
 * A changed entry REPLACES its mob wholesale — entries are never merged field-by-field, so a
 * mob's tiers map can only ever be the one main just wrote.
 */
export interface KillsDelta {
  v: number
  changed: KillMap
}

/** The five derived scalars of a KillInfo, folded from its per-tier runs. */
export function killTotals(tiers: Record<number, KillTierRun>): {
  count: number
  bestTier: number
  firstTs: number
  lastTs: number
  credited: number
} {
  let count = 0
  // Seeded at the FLOOR of the key ordering, not at 0: a record whose only runs are open-world
  // (or whose zone was never stated) has no difficulty to report, and seeding 0 would have it
  // claim a base-instance clear it never made. An empty map folds to TIER_UNKNOWN for the same
  // reason — no kills, nothing known.
  let bestTier = TIER_UNKNOWN
  let firstTs = 0
  let lastTs = 0
  let credited = 0
  for (const [key, run] of Object.entries(tiers)) {
    if (run.count <= 0) continue
    count += run.count
    bestTier = Math.max(bestTier, Number(key))
    firstTs = firstTs ? Math.min(firstTs, run.firstTs) : run.firstTs
    lastTs = Math.max(lastTs, run.lastTs)
    credited += run.credited
  }
  return { count, bestTier, firstTs, lastTs, credited }
}

/** One tier run with its tier number attached, oldest LAST kill first. */
export interface TierRun extends KillTierRun {
  tier: number
}

/**
 * The per-tier runs as a list ordered by their OWN most recent kill — the order a
 * chronological grouping wants, since each run joins the timeline at its own `lastTs`.
 */
export function tierRuns(tiers: Record<number, KillTierRun>): TierRun[] {
  const out: TierRun[] = []
  for (const [key, run] of Object.entries(tiers)) {
    if (run.count > 0) out.push({ tier: Number(key), ...run })
  }
  out.sort((a, b) => a.lastTs - b.lastTs || a.tier - b.tier)
  return out
}

/** Fold one tier run into an accumulating tiers map (union of counts and time spans). */
export function addTierRun(into: Record<number, KillTierRun>, tier: number, run: KillTierRun): void {
  const prev = into[tier]
  if (!prev) {
    into[tier] = {
      count: run.count,
      firstTs: run.firstTs,
      lastTs: run.lastTs,
      credited: run.credited,
      lastCreditedTs: run.lastCreditedTs
    }
    return
  }
  prev.count += run.count
  prev.firstTs = prev.firstTs ? Math.min(prev.firstTs, run.firstTs) : run.firstTs
  prev.lastTs = Math.max(prev.lastTs, run.lastTs)
  prev.credited += run.credited
  // 0 means "none of these were yours", so a plain max is also the right union: a run with no
  // credited kill never drags a real timestamp backwards.
  prev.lastCreditedTs = Math.max(prev.lastCreditedTs, run.lastCreditedTs)
}

/**
 * True when a delta was written by a main process using a DIFFERENT kill-record shape than
 * the baseline the renderer is holding. Merging across that boundary is what leaves stale
 * narrow entries alive, so the caller re-hydrates instead (see KILLS_SHAPE_VERSION).
 */
export function killsBaselineStale(state: KillsSnap, delta: KillsDelta): boolean {
  return state.v !== delta.v
}

/**
 * Apply a kills delta to a baseline. Per-mob WHOLESALE replacement: a changed mob's entry is
 * the one main just wrote, never a field-wise merge of old and new. On a shape mismatch the
 * stale baseline is dropped rather than merged forward (the caller should also re-hydrate;
 * `killsBaselineStale` is the predicate for that).
 */
export function mergeKillsDelta(state: KillsSnap, delta: KillsDelta): KillsSnap {
  if (killsBaselineStale(state, delta)) return { v: delta.v, mobs: { ...delta.changed } }
  return { v: state.v, mobs: { ...state.mobs, ...delta.changed } }
}
