// The PURE half of the roster's "by class loadout" sectioning: which cards go under which
// combo interval. Split out of BossSections.tsx so the join is unit-testable without a DOM —
// it is the layer the Lord of Ire misattribution actually lived in.
//
// THE RULE, stated once. A card is a TIER RUN, not a target: one target's kills at one
// instance tier, which carry their own first/last timestamps (shared/kills.ts). Each run joins
// the combo intervals at ITS OWN most recent kill and is badged with ITS OWN tier, so a
// section header ("you were running these classes") is true of every card beneath it. The old
// rule joined at the target's overall `lastTs` while painting its overall `bestTier`, so a mob
// killed at d4 in one loadout and d0 in a later one showed a d4 badge under the later loadout.
//
// Two runs of the same target that land in the SAME section merge back into one card: the
// header's claim holds for both, and one target must not appear twice under one header.
// A single-tier target therefore produces exactly the card it produced before this change.
//
// The interval layer itself is untouched and stays revisable — nothing here stamps an interval
// id onto a kill (world-model law 10); the join happens at read, every time.
//
// ONE SECTION PER LOADOUT, NOT PER INTERVAL (JOS-236, owner-reported while release-testing: the
// board drew PAL / MNK / ENC as two separate groups). An INTERVAL is a contiguous span of one
// BELIEVED loadout, so leaving a trio and coming back to it — or a `/who` restating it, or any
// boundary a detector cuts inside it — produces TWO intervals carrying the SAME classes. The
// interval layer is RIGHT about that and is untouched here: "which loadout killed that" is a time
// join and needs every boundary it has (shared/comboIndex.ts). But a section header states "you
// were running these classes", and two of them said the identical sentence twice.
//
// THE MERGE RULE. Sectioning groups intervals whose LOADOUT is identical, order-insensitively:
// each slot's candidate set sorted, then the slots sorted — deliberately the same identity
// `mergeable` uses in src/main/modules/comboIntervals.ts, so the two layers can never disagree
// about what "the same loadout" means. What differs is what the rule is allowed to do, and that
// difference is the ticket: `collapse` there rewrites the MODEL, so it merges only ADJACENT
// intervals across a SOFT boundary (a `/who`, a level drop or a user range is a real event and
// deleting it would delete evidence). Here nothing is rewritten — every member survives verbatim
// in `LoadoutGrouping.intervals` — so a section merges non-adjacent members and merges across a
// hard boundary, a user-locked span and an overruled one alike: those flags qualify how we KNOW
// the loadout, never which loadout it was.
//
// WHAT A MERGED SECTION SAYS, field by field:
//   * the LOADOUT chips come from one member, and every member reads identically by construction
//     of the key. Slot ORDER may differ between members; a loadout is a set and the log never
//     states an order, so the section shows the representative's order.
//   * PROVENANCE is the WEAKEST member's (`inferred` < `who` < `user`) — a section half of which
//     is inference must not wear a `stated by /who` chip. That is why `interval` is the weakest
//     member rather than the earliest.
//   * the SPAN is the union, drawn as earliest start → latest end AND the number of ranges it
//     took (`spansText`, ClassComboLabels.ts): a merged span has holes in it, and drawing it as
//     one continuous range would claim hours the loadout was not running.
//   * the LEVEL RANGE is the hull [min levelLo, max levelHi] over the members. Each member's
//     range is already min-of-loadout (shared/classCombo.ts — your level is the loadout's, and
//     the interval records the levels OBSERVED inside it), so the union is a HULL: a level inside
//     it that no member observed was never observed. It is carried as data; nothing on this
//     surface draws it, and the surface that does draw level ranges (the Profile tab's interval
//     list) is per-interval and untouched.
// A SECTION HEADER IS A CLAIM ABOUT A KILL, SO IT ANSWERS TO THE CONFIDENCE GATE (JOS-239). The
// owner's roster showed Lord Nagafen defeated at D4 under a crisp `ENC / WIZ / MNK` header; his
// wizard was level 25 and had never been in the zone. The interval behind it already carried
// `overDetermined` and a level range of 11-50, and this layer printed the trio anyway. Now an
// interval that fails `loadoutUncertain` (shared/comboIndex.ts) is routed to ONE unresolved section
// instead of naming classes — see `UNCERTAIN_KEY` for why one and not one per span. Nothing about
// the JOIN changes: the same kills land under the same intervals, and the gate decides only what
// the header is allowed to SAY.
//
//   * the BADGES follow the rule above with one word widened — SAME SECTION rather than same
//     interval. The ticket's case, a target killed at d4 under the trio in one interval and at d0
//     under the SAME trio in a later one, is now ONE card wearing the d4 badge, which is a true
//     sentence: you killed it at d4 while running these classes. Per-kill attribution is
//     unchanged (nothing is stamped; the join still happens at read), and a run under a DIFFERENT
//     loadout is still a different section — the Lord of Ire regression, pinned in
//     tests/bossTierRuns.test.mts.

import { groupByCombo, loadoutUncertain } from '../../../../shared/comboIndex'
import { addTierRun, tierRuns } from '../../../../shared/kills'
import type { ComboInterval, ComboProvenance } from '../../../../shared/classCombo'
import type { KillTierRun } from '../../../../shared/kills'
import { intervalProvenance } from '../profiles/ClassComboLabels'
import { projectStatus, type TargetStatus } from './bossStatus'

/** One card: what it draws (a tier run of the target) and the whole target behind it. */
export interface LoadoutCard {
  /** the target projected onto this card's tier run(s) — badge, dates and count all agree */
  s: TargetStatus
  /** the target's COMPLETE kill record, for the mob page a click opens */
  whole: TargetStatus
}

/** One loadout section: the loadout its cards were killed under, and the cards. */
export interface LoadoutGrouping {
  key: string
  /**
   * THE CONFIDENCE GATE (JOS-239, `loadoutUncertain` in shared/comboIndex.ts). True ⇒ the members
   * are spans the model has said it cannot explain, so this section states NO loadout: the header
   * says the kills came from a stretch that held more than one, and `interval` is null even though
   * `intervals` is not. See the file header for why it is one section rather than one per member.
   */
  uncertain: boolean
  /**
   * The member that SPEAKS for the section — the one with the weakest provenance, so the chips
   * cannot upgrade a section that is partly inference. null in the two cases where the section
   * states no loadout: no interval covers these cards, or `uncertain` (JOS-239).
   */
  interval: ComboInterval | null
  /**
   * Every interval merged into this section, earliest first — the honest span, kept whole rather
   * than flattened into a synthetic interval (an id nothing in the model owns is a stale join
   * waiting to happen). Empty for the UNATTRIBUTED section only; a gated section has members and
   * no speaker, which is the whole point of it.
   */
  intervals: ComboInterval[]
  /** hull of the members' level ranges: min of the lows, max of the highs, null when unobserved */
  levelLo: number | null
  levelHi: number | null
  rows: LoadoutCard[]
}

/** A tier run awaiting its join: the run's own last kill is the timestamp it joins on. */
interface RunRow {
  ts: number
  status: TargetStatus
  tier: number
  run: KillTierRun
}

function runRows(list: readonly TargetStatus[]): RunRow[] {
  const rows: RunRow[] = []
  for (const status of list) {
    if (!status.killed) continue
    for (const { tier, ...run } of tierRuns(status.tiers)) {
      if (run.lastTs <= 0) continue
      // The WHOLE run rides along, minus the tier key `tierRuns` attached: a projected card must
      // describe the same kills as the run it came from — credit count, credit timestamp and
      // anything a later shape adds — even where only bossStatus and the week view read them.
      // Spelling the fields out by hand is how a new one gets silently dropped from every
      // loadout card, which is why this is a rest spread and not a literal.
      rows.push({ ts: run.lastTs, status, tier, run })
    }
  }
  return rows
}

/** Merge the runs that landed in one SECTION back into one card per target. */
function cardsFor(rows: readonly RunRow[]): LoadoutCard[] {
  const byTarget = new Map<string, { whole: TargetStatus; tiers: Record<number, KillTierRun> }>()
  for (const row of rows) {
    let entry = byTarget.get(row.status.target.name)
    if (!entry) {
      entry = { whole: row.status, tiers: {} }
      byTarget.set(row.status.target.name, entry)
    }
    addTierRun(entry.tiers, row.tier, row.run)
  }
  return [...byTarget.values()].map((e) => ({ s: projectStatus(e.whole, e.tiers), whole: e.whole }))
}

/**
 * THE SECTION IDENTITY of an interval: every slot's candidate SET, order-insensitive across the
 * slots. Two intervals share a section exactly when this string matches — the same identity
 * `mergeable` computes in main/modules/comboIntervals.ts (the candidate lists are already sorted
 * per shared/classCombo.ts; sorting them again costs nothing and cannot be got wrong), so "the
 * same loadout" means one thing in this app. Note it is the CANDIDATES and not the printed label:
 * a two-slot loadout and a three-slot one with an unknown third are different claims about how
 * many classes were running, and stay different sections.
 */
export function loadoutKey(interval: ComboInterval): string {
  return interval.slots
    .map((s) => [...s.candidates].sort().join('|'))
    .sort()
    .join('/')
}

/** Authority order (shared/classCombo.ts). A section is only as strong as its weakest member. */
const PROVENANCE_RANK: Record<ComboProvenance, number> = { inferred: 0, who: 1, user: 2 }

/** The member that speaks for the section: weakest provenance, earliest on a tie. */
function speaker(members: readonly ComboInterval[]): ComboInterval | null {
  let best: ComboInterval | null = null
  for (const member of members) {
    if (!best) {
      best = member
      continue
    }
    const delta = PROVENANCE_RANK[intervalProvenance(member)] - PROVENANCE_RANK[intervalProvenance(best)]
    if (delta < 0 || (delta === 0 && member.startTs < best.startTs)) best = member
  }
  return best
}

/** The hull of the members' observed level ranges — see the file header on why it is a hull. */
function levelHull(members: readonly ComboInterval[]): Pick<LoadoutGrouping, 'levelLo' | 'levelHi'> {
  const isLevel = (n: number | null): n is number => n !== null
  const los = members.map((m) => m.levelLo).filter(isLevel)
  const his = members.map((m) => m.levelHi).filter(isLevel)
  return {
    levelLo: los.length > 0 ? Math.min(...los) : null,
    levelHi: his.length > 0 ? Math.max(...his) : null
  }
}

/** A section under construction: the intervals that share its loadout, and the runs under them. */
interface Pending {
  key: string
  members: ComboInterval[]
  rows: RunRow[]
}

/** The one section for runs no interval covers — never merged with a real loadout's. */
const UNKNOWN_KEY = 'unknown'

/**
 * The one section for runs whose interval FAILED the confidence gate (JOS-239).
 *
 * ONE SECTION, NOT ONE PER MEMBER, and for JOS-236's reason: a section header is a SENTENCE, and
 * every gated span says the identical one — "these kills came out of a stretch that held more than
 * one loadout, and the app will not pick". Drawing that sentence four times with four different
 * date ranges is the exact complaint that ticket fixed. The members are all kept in `intervals`,
 * so the caption can still count the stretches and the tooltip can spell them out.
 *
 * It is deliberately NOT merged with `UNKNOWN_KEY`: "no interval covers these kills" and "an
 * interval covers them and cannot be trusted to name a trio" are different things to know, and the
 * second one has spans to show.
 */
const UNCERTAIN_KEY = 'uncertain'

/**
 * Defeated targets, split into tier runs, time-joined to the combo intervals, and sectioned by
 * LOADOUT — every interval stating the same classes is one section (JOS-236, file header).
 * Undefeated targets carry no timestamp to join on and are not returned here — the view keeps
 * them in their own trailing section rather than dropping or attributing them.
 *
 * Sections come out in the order their first kill did, and an interval with no kills under it
 * draws no section at all: both were true before the merge and stay true.
 *
 * `keep` (JOS-237) is the toolbar's "defeated" test, applied to the card AFTER the merge — the
 * only moment a card's own kill set exists. It runs at card grain deliberately: the view has
 * already applied the same predicate to whole targets, and a target kept because ONE of its runs
 * qualifies must not smuggle its other runs onto the screen (the week view's case — a boss
 * cleared at d0 this week and at d4 last month, sectioned under two loadouts). A section whose
 * every card is filtered out draws no header, because a header states something about cards.
 */
export function loadoutGroups(
  intervals: readonly ComboInterval[],
  list: readonly TargetStatus[],
  keep?: (card: TargetStatus) => boolean
): LoadoutGrouping[] {
  const byKey = new Map<string, Pending>()
  const ordered: Pending[] = []
  for (const group of groupByCombo(intervals, runRows(list))) {
    const gated = group.interval !== null && loadoutUncertain(group.interval)
    const key = !group.interval ? UNKNOWN_KEY : gated ? UNCERTAIN_KEY : `combo:${loadoutKey(group.interval)}`
    let pending = byKey.get(key)
    if (!pending) {
      pending = { key, members: [], rows: [] }
      byKey.set(key, pending)
      ordered.push(pending)
    }
    if (group.interval) pending.members.push(group.interval)
    pending.rows.push(...group.rows)
  }
  const out: LoadoutGrouping[] = []
  for (const pending of ordered) {
    // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives ComboInterval. Becomes a view descriptor when the source lands.
    const members = [...pending.members].sort((a, b) => a.startTs - b.startTs)
    // Re-sorted because a section's runs can come from intervals that are not neighbours, and
    // the card order (first appearance of each target) should still read oldest kill first.
    const cards = cardsFor([...pending.rows].sort((a, b) => a.ts - b.ts))
    const rows = keep ? cards.filter((c) => keep(c.s)) : cards
    if (rows.length === 0) continue
    const uncertain = pending.key === UNCERTAIN_KEY
    out.push({
      key: pending.key,
      uncertain,
      // A gated section names NO loadout, so it has no speaker — the chips are exactly what must
      // not be drawn. Its members are still carried, because the spans are true and useful.
      interval: uncertain ? null : speaker(members),
      intervals: members,
      ...levelHull(members),
      rows
    })
  }
  return out
}
