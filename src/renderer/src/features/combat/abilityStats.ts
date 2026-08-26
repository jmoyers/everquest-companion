// PER-ABILITY STATS, INLINE (JOS-113) — one bar per ability, and clicking a stat-bearing one
// opens ITS OWN crit / double / triple / miss beneath it.
//
// WHY THIS REPLACES A LEVEL (owner, JOS-113, correcting JOS-105): JOS-105 grouped the drill under
// a CATEGORY level — a "Melee" chip above the ability bars, and a third drill level per damage
// type carrying the multi-attack readout. The owner rejected that: "one bar per ability, flat, as
// before — Dragon Punch, Melee, Kick, each its own bar. NO category grouping layer, NO category
// strip. Click an ability that has stats and the ability's own stats appear inline beneath its
// bar." So the double/triple that used to live one level down now attaches to the ABILITY it
// belongs to, and the per-ability crit/miss the flat row already expanded (combatShared.SkillBar)
// gains it. There is no "which category does this round belong to" judgement any more — a round
// lane's counters are that lane's ability's, and a lane names exactly one ability (below).
//
// ENGINE UNTOUCHED, LAW 8 HOLDS. Every number here is read off the engine's existing rollup — the
// SkillView's own crits/resists/misses, and the round lanes' own swing-count buckets. Nothing
// derives a damage amount, so no total moves (the same tripwire multiAttackRows.ts lives under).
//
// PURE TS, RELATIVE/ TYPE-ONLY IMPORTS. Like multiAttackRows/categoryDrill before it, this module
// is exercised by node tests that run without the renderer's `@shared` value alias and is imported
// by the MUI-free overlay bundle. No JSX, no MUI, and only a TYPE borrow of `@shared/combat`.

import type { DamageCategory, RoundLaneView, SourceView } from '@shared/combat'
import { flurryText } from './multiAttackRows'
import type { FlatSkill } from './dashboardData'

/**
 * The generic weapon-verb lane name the parser gives every swing (roundViews.roundLaneLabel's
 * `GENERIC_LANE`). The auto-attack ability the engine files those swings under is a skill named
 * exactly this, so a bare-verb lane ("Slash", "Crush") belongs to the "Melee" ability. Spelled
 * literally rather than imported: this module is node-tested with no `@shared` value alias, and
 * roundViews.ts is main-process code the renderer never loads.
 */
const AUTO_ATTACK = 'Melee'

/** One ability's multi-attack reading, pooled across every round lane that belongs to it. */
export interface AbilityMulti {
  /** attack rounds counted for this ability — the denominator every percentage below is over. */
  rounds: number
  /** rounds that landed exactly 2 swings, as a percentage of `rounds`. */
  doubledPct: number
  /** exactly 3 swings. */
  tripledPct: number
  /** 4 or more swings (the engine's last bucket); 0 for almost every ability. */
  quadPct: number
  /**
   * The ability may only be read in AGGREGATE — a dual-wieldable weapon verb, where a same-second
   * second swing may be an off-hand rather than a double attack (RoundConfidenceView 'aggregate').
   * The single honesty marker this view spends ink on.
   */
  estimated: boolean
  /** `24% doubled · 3% tripled` — buckets that never fired are absent; '' when none did. */
  text: string
  /**
   * `flurry ×N · X% of rounds`, on the AUTO-ATTACK ability only (law 6: the log never says which
   * verb a flurried swing belonged to, so flurry is un-splittable and rides the ability that
   * actually auto-attacks). Null everywhere else, and null when nothing flurried.
   */
  flurry: string | null
}

/**
 * SKILL NAME → the category the engine booked it under, FIRST-WINS in the engine's own category
 * order (`SourceView.categories` is CATEGORY_ORDER — melee before slay). First-wins settles the
 * one real collision: a Slay Undead proc rides a weapon swing, so the engine names its `slay` row
 * after the weapon skill ("Bash"). The round belongs to the SWING that opened it, not the proc
 * that fired on it, so the "Bash" lane is the melee Bash ability's — the slay Bash proc gets none.
 */
function categoryByName(source: SourceView): Map<string, DamageCategory> {
  const index = new Map<string, DamageCategory>()
  for (const c of source.categories) {
    for (const s of c.skills) {
      const key = s.name.toLowerCase()
      if (!index.has(key)) index.set(key, c.category)
    }
  }
  return index
}

/**
 * The round lanes that belong to ONE ability (name + category):
 *   - a NAMED-special lane whose label IS this ability ("Kick", "Bash"), filed to the first-wins
 *     category so the melee Bash keeps its rounds and the slay Bash proc gets none; or
 *   - for the AUTO-ATTACK "Melee" ability, every bare weapon-verb lane the log did not name after
 *     a special (`roundLaneLabel` titles those after the verb — "Slash", "Crush" — and no skill
 *     row carries that name).
 */
export function lanesForAbility(source: SourceView, name: string, category: DamageCategory): RoundLaneView[] {
  const r = source.roundStats
  if (!r) return []
  const index = categoryByName(source)
  const key = name.toLowerCase()
  const isAutoAttack = key === AUTO_ATTACK.toLowerCase() && category === 'melee'
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives RoundLaneView. Becomes a view descriptor when the source lands.
  return r.lanes.filter((lane) => {
    const owner = index.get(lane.label.toLowerCase())
    // A named lane matches a skill row: it belongs to that skill in its first-wins category.
    if (owner !== undefined) return lane.label.toLowerCase() === key && owner === category
    // A bare weapon verb names no skill: it is an auto-attack swing → the "Melee" ability.
    return isAutoAttack
  })
}

/** `buckets[i]` summed across a set of lanes: rounds that landed exactly i+1 swings. */
function bucketSum(lanes: RoundLaneView[], i: number): number {
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives RoundLaneView. Becomes a view descriptor when the source lands.
  return lanes.reduce((n, l) => n + (l.buckets[i] ?? 0), 0)
}

/** `24% doubled · 3% tripled` — buckets that never fired are simply absent, never `0%`. */
function multiText(doubled: number, tripled: number, quad: number): string {
  const parts: string[] = []
  if (doubled > 0) parts.push(`${Math.round(doubled)}% doubled`)
  if (tripled > 0) parts.push(`${Math.round(tripled)}% tripled`)
  if (quad > 0) parts.push(`${Math.round(quad)}% quad+`)
  return parts.join(' · ')
}

/**
 * ONE ability's multi-attack reading, or null when it opened no rounds. For the auto-attack Melee
 * ability the lanes are POOLED (its swings answer several weapon verbs — slash, crush — under one
 * ability), so the rates are over the summed rounds; a named special is its single lane.
 */
export function abilityMultiAttack(source: SourceView, name: string, category: DamageCategory): AbilityMulti | null {
  const lanes = lanesForAbility(source, name, category)
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives RoundLaneView. Becomes a view descriptor when the source lands.
  const rounds = lanes.reduce((n, l) => n + l.rounds, 0)
  const isAutoAttack = name.toLowerCase() === AUTO_ATTACK.toLowerCase() && category === 'melee'
  const flurry = isAutoAttack && source.roundStats ? flurryText(source.roundStats) : null
  if (rounds <= 0) return flurry ? { rounds: 0, doubledPct: 0, tripledPct: 0, quadPct: 0, estimated: false, text: '', flurry } : null
  const doubledPct = (bucketSum(lanes, 1) / rounds) * 100
  const tripledPct = (bucketSum(lanes, 2) / rounds) * 100
  const quadPct = (bucketSum(lanes, 3) / rounds) * 100
  return {
    rounds,
    doubledPct,
    tripledPct,
    quadPct,
    estimated: lanes.some((l) => l.confidence === 'aggregate'),
    text: multiText(doubledPct, tripledPct, quadPct),
    flurry
  }
}

/**
 * RIPOSTE DAMAGE INSIDE THE MELEE BREAKDOWN (JOS-354, user report 01KZYKJPMBZ6G93AM7B2KXN7C3 —
 * "Can we get our riposte damage broken out inside our Melee damage?").
 *
 * IT IS A SUBSET, NEVER A ROW. A riposte counter-swing is an ordinary weapon swing that the game
 * annotated `(Riposte)`, so its damage is ALREADY inside the auto-attack lane's total — giving it
 * a bar of its own would double it on screen and make the ranked list add up to more than the
 * fight. It is stated as a share of the lane it is already in, which is exactly what the reporter
 * asked for ("broken out INSIDE our Melee damage").
 *
 * IT RIDES THE AUTO-ATTACK ABILITY, for the same reason flurry does: the engine tallies the
 * annotation on the SOURCE, not per lane, so this figure is the source's whole riposte damage and
 * has no per-verb split to offer. `pctOfSwingDamage` is over melee + slay together — a
 * `(Riposte Slay Undead)` counter is booked in the slay category — so the denominator matches
 * what the number is drawn from rather than the one lane it is printed on.
 */
export interface AbilityRiposte {
  /** `(Riposte)` counter-swings — landed AND avoided. */
  swings: number
  /** …of those, the ones that landed. */
  hits: number
  /** damage they dealt, already inside this ability's total. */
  damage: number
  /** that damage as a percentage of your melee + slay damage. */
  pct: number
  /** `1,847 hits · 62.3k dmg` is the caller's job; this is the rate run: `7% of swing damage`. */
  text: string
}

export function abilityRiposte(source: SourceView, name: string, category: DamageCategory): AbilityRiposte | null {
  const r = source.roundStats
  if (!r || r.ripostesGiven <= 0) return null
  if (name.toLowerCase() !== AUTO_ATTACK.toLowerCase() || category !== 'melee') return null
  const pct = r.riposteDamage > 0 ? riposteSharePct(source, r.riposteDamage) : 0
  return {
    swings: r.ripostesGiven,
    hits: r.riposteLanded,
    damage: r.riposteDamage,
    pct,
    text: pct > 0 ? `${pct.toFixed(1)}% of swing damage` : 'no damage landed'
  }
}

/** `riposteDamage` over the source's melee + slay totals — the categories a swing lands in. */
function riposteSharePct(source: SourceView, damage: number): number {
  const base = source.categories
    // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives CategoryView. Becomes a view descriptor when the source lands.
    .filter((c) => c.category === 'melee' || c.category === 'slay')
    // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives CategoryView. Becomes a view descriptor when the source lands.
    .reduce((n, c) => n + c.total, 0)
  return base > 0 ? (damage / base) * 100 : 0
}

/**
 * DOES THIS ABILITY HAVE STATS TO EXPAND? — the owner's clickability gate (JOS-113): "click an
 * ability THAT HAS STATS; abilities with no such stats (a DoT tick) are not clickable / do
 * nothing."
 *
 * A stat APPLIES to an ability, it is not merely observed non-zero — so Dragon Punch expands to
 * `0% crit · 0% miss` after a clean fight, and the reader learns the miss it did not take:
 *   - melee / slay  → weapon swings: crit and miss are core stats, shown even at 0% (plus any
 *                     multi-attack). Always expandable.
 *   - a multi-attack ability → its double/triple is a thing to see, whatever its category.
 *   - a direct spell that CRIT → crit rate is worth stating.
 *   - a GROUP row → its children ARE the thing to expand (JOS-244). Without this a merged spell
 *     row could hide its own components: a DoT whose ticks never crit passes none of the tests
 *     above, and collapsing two bars into one that will not open would take information away
 *     rather than tidy it. The slay group has always passed on its category; this is the same
 *     rule said generally, so no group is ever a dead end.
 * A DoT tick has none of these — no swings to miss, no rounds, and DoT ticks do not crit in this
 * engine — so it does not expand; its resist rate, if any, already rides the bar face (SkillBar).
 * A damage shield is passive and likewise inert.
 */
export function abilityExpandable(row: FlatSkill & { children?: unknown[] }, multi: AbilityMulti | null): boolean {
  if (row.category === 'melee' || row.category === 'slay') return true
  if (row.children && row.children.length > 0) return true
  if (multi) return true
  if (row.crits > 0) return true
  return false
}
