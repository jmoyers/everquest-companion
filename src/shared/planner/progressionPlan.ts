// planner/progressionPlan.ts — WHERE SHOULD I BE, AND WHAT AM I THERE FOR, ONE LEVEL BRACKET AT A
// TIME (docs/plans/gear-progression-planner.md §1, §2.4, §3).
//
// THE ASK THIS FILE ANSWERS, in the fork user's own words: *when finding the best gear for me I need
// a progression tree — Crushbone for the first N levels, Mistmoore, Splitpaw… based on the 3 classes
// someone wants and the target (dps, tank, healer) — and when to grind +0 for exp vs +4 areas for
// gear, because +4 is harder so we need the creatures to be blue and white solo.*
//
// IT IS A PLANNER, NOT AN OPTIMIZER, and the distinction is forced by the data rather than chosen:
// NO DROP RATES EXIST ANYWHERE IN THIS REPO (the item census's standing caveat), so there is nothing
// to optimize over. What the corpus does state is a mob's level, the zones it lives in, and which
// mobs an item page names as droppers — so a bracket ranks ZONES by what their mobs' stated levels
// read against the injected con model, and ITEMS by a role-weighted worth score. Both derivations
// are labeled, here and on every surface that draws them.
//
// EVERYTHING IS INJECTED (`PlanCorpora`) AND THE FOLD IS PURE. No data import, no `Date.now`, no
// `localStorage`, no renderer. The con function in particular is a PARAMETER and not a call into
// `shared/conBands.ts`: the plan is only as good as the band table it is handed, that table is
// LEARNED from one machine's consider history, and a fold that reached for it directly could not be
// tested against a band table whose shape the test controls. The renderer passes `conBand`.
//
// ELEVEN RULES THE FOLD REFUSES TO BEND:
//
//   1. AN EMPTY CLASS LIST IS UNKNOWN, NEVER "NOBODY" (`GearRow.classes`, law 1). An item whose page
//      stated no classes — or stated them unreadably — is KEPT for every trio. Excluding it would
//      quietly delete real gear on the strength of a wiki omission.
//   2. A +N TARGET CARRIES NO BAND. Plan §3: the game spells a tiered zone `<base> <N> (<TierWord>)`
//      and the wiki spells the same thing `<base> +N`, but the CATALOG states no level for any +N
//      mob (plan §0.2, re-verified 2026-08-15) — so nothing on this machine states how hard a +4
//      creature is. Printing "blue at 19" for one would be a fabricated number. `band: null` is the
//      honest answer and the renderer draws it as "difficulty unstated".
//   3. THE ROLE WEIGHTS ARE A HEURISTIC AND SAY SO. They live in `roleWeights.ts` (beside the weapon
//      policy of rule 10), which this file re-exports (`GearRole`, `roleValue`) so no caller has to
//      know they moved.
//   4. THE HORIZON IS DATA-DRIVEN, not a level cap this file claims to know. See
//      `buildProgressionPlan`.
//   5. THE TARGET GATE IS A CEILING, NOT A WINDOW. CORRECTED 2026-08-15, from the owner playing the
//      first cut: the plan was hiding good items because their drop mob conned GREY. "Blue and white
//      solo" was always an upper bound on how hard a fight the route may send you to, and a trivial
//      mob is the EASIEST farm in the game — so `trivial` is inside the gate for TARGETS (solo:
//      trivial|safe|even, group: +risky). EXP ZONES ARE UNCHANGED and still want safe/even, because
//      that half is about experience and a grey mob pays none.
//      THE CONSEQUENCE, stated rather than discovered: a grey-source item now qualifies from the
//      FIRST bracket, which is the correct advice ("go and grab this now") and does mean the opening
//      bracket sees the most competition. Nothing else was needed to keep that bounded — the role
//      score orders it, the caps bound it, and the consume-on-emission dedupe in `bracketOf` lets
//      anything every cap cut resurface later.
//   6. SCORES ARE READ OFF BASE STATS, and that is a RULING rather than a shortcut. Owner, 2026-08-15:
//      *"base stats can be used, that's fine, because we can upgrade"*. Every item in this game is
//      upgradeable, so a plus is a STATE OF ANY ITEM and not a property of the drop — which makes
//      base-against-base the only fair comparison, and scoring a `+4` witness at tier 4 while its
//      base-zone sibling scores at tier 0 would rank the SLIDER rather than the loot. The tier a
//      witness names is still carried (`GearTarget.plus`, `GearRun.plus`) because it changes WHERE
//      you go and what the trip costs; it just does not change what the item is worth.
//   7. THE ROUTE IS ZONE-FIRST — `PlanBracket.runs`. The ask was for places
//      ("it should say crushbone … mistmoore splitpaw") and the plan doc §1 mockup agrees
//      (*"**Mistmoore** — gear runs: …"*). A GLOBAL TOP-8 CANNOT ANSWER THAT, and the burial was
//      measured rather than predicted: at level 44 the Refined-tier runs the owner actually farms —
//      Befallen 4, Runnyeye 4, Splitpaw 4, and he is WEARING the Splitpaw axe (reported 2026-08-15)
//      — never crack a bracket-wide top eight against planes loot, so the feature's own subject
//      never rendered. A RUN EARNS ITS LINE BY CONTAINING AN UPGRADE FOR THIS TRIO AT ALL, never by
//      out-scoring raid gear. The flat `targets` list is kept beside it, unchanged in rule, so the
//      renderer can migrate without a flag day.
//   8. ADMISSION IS A GAP TEST, NOT A RANKING (owner, 2026-08-15: *"i should be able to gear my guy
//      up, so it needs to look at what I have and the best in slot"*). An item is a target when it
//      STRICTLY beats the best OWNED item in at least one slot it fits (`PlanCorpora
//      .ownedBestBySlot`, injected). A slot the map does not name is a GAP and admits anything
//      wearable — absent is "nothing stated there", not "an owned item worth zero" (law 1).
//      THE TWO SIDES OF `owned` INTERACT AND IT IS DELIBERATE: an owned item sets its slot's bar AND
//      is excluded as a target, because you do not farm what you have. Raising the PLUS on something
//      you already own is the Gear tab's business — that is what the upgrade slider is — and the
//      route deliberately says nothing about it.
//   9. A WISHED ITEM IS FLAGGED, NOT FILTERED (`GearTarget.wished`). It bypasses the gap test and
//      sorts FIRST, because the user declaring they want a thing is the strongest statement about it
//      in this whole corpus and it outranks a score rule 3 openly calls invented. Every other gate —
//      era, reach, wearability, the +N rules — still applies to it.
//  10. A ROLE MAY CLOSE A SLOT, AND A CLOSED SLOT IS NOT A GAP (`roleWeights.ts
//      ROLE_WEAPON_POLICY`). Owner, 2026-08-15: he wields a two-handed greataxe, so his
//      Secondary/Held is empty ON PURPOSE — and rule 8 read that empty slot as a gap and offered him
//      shields. An empty offhand under a two-hander is not a hole in his gear, it IS his gear, and
//      no weights table can say so because the difference is not in any stat. So the weapon roles
//      carry a POLICY beside their weights: `dps2h` closes the offhand and takes only two-handers in
//      the main hand, `dualwield` takes one-handers in both, `dps1h` constrains only the main hand,
//      `tank` takes only shield-shaped offhands. The five other roles state no policy, which is
//      today's behaviour written down rather than a new default.
//  11. NO CAMP TIMERS, NO DROP-RATE CLAIMS, NO COSTING, NO SECOND WISH LIST (plan §8). The plan
//      SEEDS the wish list; it does not become one.
//
// TWO PLACES THIS DIVERGES FROM THE PLAN DOC, both reported rather than smuggled:
//   * §2.4 says exp zones are "era-legal zones". `PlanCorpora` carries no zone-era witness, so the
//     gate here reads `era.ts layeredVerdict` on the zone name alone and drops only a POSITIVE
//     out-of-era. `unknown` is KEPT for a zone, where the gear rule hides it — see `expZonesFor`.
//   * The era verdict for an ITEM reads layers 1-2 (`layeredVerdict`). LAYER 3 — `GearRow.eraDerived`
//     — is NOT consulted, because the fold that weighs it against the other layers lives in the
//     renderer (`features/planner/plannerData.ts donorEra`) and re-implementing it here would create
//     the second opinion `era.ts` exists to prevent.

import type { ClassAbbr } from '../classCombo'
import type { ConBand } from '../conBands'
import type { GearRow } from './gear'
import type { EquipSlot } from './types'
import { layeredVerdict } from './era'
import {
  ROLE_WEAPON_POLICY,
  policyAdmits,
  roleValue,
  type GearRole,
  type WeaponSlotPolicy
} from './roleWeights'
import { plusSuffix, zoneLevelKey, type PlusName, type ZoneLevels } from './zoneLevels'

// The two names this file used to define and now only passes through — see `roleWeights.ts`.
export { roleValue, type GearRole }

// =================================================================================================
// THE PLAN'S SHAPE
// =================================================================================================

/** What the player told the surface. Everything else the fold needs arrives in `PlanCorpora`. */
export interface PlanInputs {
  /** the character's CURRENT level — the first bracket opens here */
  level: number
  /** the class trio (detected or pinned). EMPTY means "no trio stated", which gates nothing. */
  classes: readonly ClassAbbr[]
  role: GearRole
  /**
   * THE CEILING on how hard a target's fight may be: solo tops out at even ("blue and white" in the
   * ask), group at risky. Anything EASIER always qualifies — see `SOLO_GATE`.
   */
  reach: 'solo' | 'group'
  eraOnly: boolean
  /** plan §8 calls 6 a first guess, so it is an input and not a constant. Default 6. */
  bracketSize?: number
}

/** One item worth going and getting, at one bracket, off one stated witness. */
export interface GearTarget {
  /** `itemKey(name)` — the key ownership, the wish list and the loot index all join on */
  key: string
  name: string
  iconId?: number
  /** the BASE zone (tier suffix stripped); `''` when the page listed the mob under no heading */
  zone: string
  /** the tier this witness names, or `null` for a base-zone witness */
  plus: number | null
  /** the BASE mob spelling, so a caller can look it up; the renderer composes `mob +plus` */
  mob: string
  /** the level the CATALOG states for that mob, or `null`. See `witnessesOf` for the +N split. */
  mobLevel: number | null
  /** the con verdict at the earliest level in the bracket where it qualifies — `null` for a +N */
  band: ConBand | null
  /**
   * `roleValue(row.stats, role)` at BASE stats — heuristic, and what targets are ranked by.
   *
   * BASE, not the witness's plus state. Owner ruling 2026-08-15: *"base stats can be used, that's
   * fine, because we can upgrade"* — see rule 6 in the header.
   */
  score: number
  /**
   * ALREADY ON THE WISH LIST. Flagged, not filtered: the user declaring they want a thing is the
   * strongest statement about it in the whole corpus, so the route keeps ROUTING to it — it bypasses
   * the upgrade-gap test and sorts first. See `candidatesOf`.
   */
  wished: boolean
}

/**
 * ONE PLACE, ONE TIER, AND WHAT IS WORTH GETTING THERE — the ZONE-FIRST shape the ask actually
 * asked for ("it should say crushbone … mistmoore splitpaw"), and the plan doc §1 mockup's own
 * spelling (*"**Mistmoore** — gear runs: …"*).
 *
 * A BASE ZONE AND ITS REFINED TIER ARE DIFFERENT RUNS. They are different trips with different
 * difficulty and different drops, and collapsing them would put a `+4` item under a heading whose
 * band was measured for the `+0` zone.
 */
export interface GearRun {
  /** the BASE zone spelling; `''` when the pages listed these droppers under no heading */
  zone: string
  /** the tier all of this run's witnesses named, or `null` for the base zone */
  plus: number | null
  /**
   * What the zone's MEDIAN mob cons at the bracket midpoint — the same reading `expZones` prints.
   * `null` for a +N run (difficulty unstated, rule 2) AND for a base zone this app has no profile
   * for. `plus` is what tells those two silences apart.
   */
  band: ConBand | null
  /** score-ordered (wished first), capped at `RUN_TARGET_CAP` */
  targets: GearTarget[]
}

/** One zone worth grinding in, at one bracket. Every field is DERIVED — `sampled` says how much. */
export interface ZonePick {
  zone: string
  median: number
  low: number
  sampled: number
  /** what the zone's MEDIAN mob cons at the bracket midpoint */
  band: ConBand
}

/** One six-level (by default) step of the route. */
export interface PlanBracket {
  from: number
  to: number
  expZones: ZonePick[]
  /** WHERE TO GO AND WHAT FOR — the zone-first answer. See `GearRun` and rule 8. */
  runs: GearRun[]
  /**
   * The same bracket's admitted items as ONE flat top-`TARGET_CAP` list.
   *
   * KEPT SO THE RENDERER CAN MIGRATE at its own pace: `runs` is additive, and both fields are built
   * from the identical admitted pool, so a row here is a row there.
   */
  targets: GearTarget[]
}

/** Everything the fold reads, handed in — see the header on why the con model is a parameter. */
export interface PlanCorpora {
  gear: readonly GearRow[]
  /** `zoneLevelProfile(catalog)`, keyed by `zoneLevelKey` */
  profiles: ReadonlyMap<string, ZoneLevels>
  /** a catalog lookup: mob name → its stated level, or `null` when it states none */
  mobLevel: (mobName: string) => number | null
  /** `(myLevel, mobLevel) → band`. `conBands.conBand` in production, synthetic in the tests. */
  con: (myLevel: number, mobLevel: number) => ConBand
  /** item keys the character already owns — EXCLUDED as targets (you do not farm what you have) */
  owned: ReadonlySet<string>
  /**
   * item keys already on the wish list — FLAGGED, not excluded (`GearTarget.wished`). The plan seeds
   * that document and then keeps routing to it; it never silently drops a thing the user asked for.
   */
  wished: ReadonlySet<string>
  /**
   * THE BAR EACH SLOT HAS TO BEAT: the role-scored best OWNED item per equip slot, computed by the
   * caller (the renderer folds it out of ownership + `roleValue`; the tests build it by hand).
   *
   * A SLOT THAT IS ABSENT FROM THIS MAP IS A GAP, and any wearable item is an upgrade for a gap.
   * That is law 1 read carefully rather than bent: absent is not "an owned item worth 0" — it is the
   * ownership data declining to name anything there, and the honest consequence of not knowing what
   * you have in a slot is to keep showing you what you could put in it. The alternative (treat
   * absent as 0 and admit anything scoring above 0) reaches the same answer for real gear and a
   * WORSE one for a stated penalty item, so it is spelled out as a gap on purpose.
   *
   * OPTIONAL, and the default is the empty map — EVERY slot a gap, i.e. exactly what the fold did
   * before this rule existed. Additive for the same reason `runs` is: a caller that has not built
   * its ownership fold yet keeps compiling and keeps rendering, and gets the tighter answer the day
   * it passes one. The semantics compose without a special case: an absent MAP is every slot
   * absent, and an absent slot is a gap.
   */
  ownedBestBySlot?: ReadonlyMap<EquipSlot, number>
}

// ---- the constants, each with the reason it is that number ------------------------------------

/** Plan §8: "a first guess", and the fold takes it as an input so tuning it is a constant. */
const DEFAULT_BRACKET_SIZE = 6
/**
 * FOUR EXP ZONES PER BRACKET. A route is a recommendation, not a gazetteer: the real corpus profiles
 * ~190 zones and a bracket that listed every zone whose median reads even would be a list nobody
 * reads. Four fits one card without scrolling. The cap is stated here and on the surface.
 */
const EXP_ZONE_CAP = 4
/** EIGHT TARGETS PER BRACKET in the flat list, for the same reason and with the same disclosure. */
const TARGET_CAP = 8
/**
 * THREE TARGETS PER RUN. A run's job is to say "this trip is worth making, and here is a taste of
 * what is in it" — the full list is the Gear tab's, reached by drilling in. Three fits one line of a
 * bracket card. Stated on the surface.
 */
const RUN_TARGET_CAP = 3
/** SIX RUNS PER BRACKET, same disclosure. A bracket is an evening's advice, not an atlas. */
const RUN_CAP = 6
/**
 * THE HARD BACKSTOP: six default brackets past the current level. The horizon is meant to be
 * DATA-driven (see `buildProgressionPlan`), and this exists only so a corpus that keeps answering
 * cannot loop forever. It is NOT a level cap claim — this file states no level cap, because the
 * server's is not in any data this repo holds.
 */
const HORIZON_LEVELS = 36
/** How many consecutive silent brackets end the route. Two, so one gap does not truncate a plan. */
const QUIET_BRACKETS = 2

/**
 * THE TARGET GATE IS A CEILING, NOT A WINDOW — corrected 2026-08-15 from live testing, and the
 * correction is rule 5 in the header. "Blue and white solo" (plan §2.1) is the hardest fight the
 * route may send you to, so `trivial` rides INSIDE the gate: a grey mob is the easiest farm there
 * is, and a route that refused to mention the tunic off a level-4 rat because you have outlevelled
 * the rat is answering a question nobody asked.
 */
const SOLO_GATE: readonly ConBand[] = ['trivial', 'safe', 'even']
/** A group loosens the CEILING by exactly one band. An OPTION, not a guess (plan §8). */
const GROUP_GATE: readonly ConBand[] = ['trivial', 'safe', 'even', 'risky']

// =================================================================================================
// THE FOLD
// =================================================================================================

/** A bracket's bounds, before it has any content. */
interface Bracket {
  from: number
  to: number
}

/** One stated drop witness off an item page, with the tier suffix already split off. */
interface Witness {
  zone: string
  plus: number | null
  mob: string
  mobLevel: number | null
}

/** A gear row that survived the filters, with its witnesses resolved and its score computed once. */
interface Candidate {
  row: GearRow
  witnesses: Witness[]
  score: number
  wished: boolean
}

/** What the bracket fold needs, bundled — four positional arguments is the ceiling. */
interface PlanCtx {
  corpora: PlanCorpora
  /** the reach CEILING — every band a target's fight may read (rule 5), not a window */
  gate: readonly ConBand[]
  eraOnly: boolean
  candidates: Candidate[]
}

/**
 * THE ONE ORDER TARGETS ARE EVER PUT IN, so the flat list and a run can never disagree.
 *
 * WISHED FIRST — the user saying "I want this" outranks a heuristic score computed from a weights
 * table this file openly calls invented. Then score descending, then name, so the total order is
 * stable and a windowed list does not re-shuffle under the scrollbar.
 */
function byWorth(a: GearTarget, b: GearTarget): number {
  return Number(b.wished) - Number(a.wished) || b.score - a.score || a.name.localeCompare(b.name)
}

/** The base spelling of a possibly-tiered name. */
function baseName(name: string): string {
  return plusSuffix(name)?.base ?? name
}

/**
 * CAN THE TRIO WEAR IT? Two ways to answer yes, and both are law 1.
 *
 * An EMPTY `row.classes` is the wiki declining to say, not a claim that nobody can wear the item
 * (`gear.ts`: "UNKNOWN, never 'nobody'"), so it is KEPT. And an empty INPUT trio means the surface
 * has no class detection to gate with, which gates nothing rather than everything.
 */
function wearable(row: GearRow, classes: readonly ClassAbbr[]): boolean {
  if (row.classes.length === 0 || classes.length === 0) return true
  return row.classes.some((c) => classes.includes(c))
}

/**
 * IS IT REACHABLE ON THE SERVER AS IT SHIPS TODAY?
 *
 * ONLY `in-era` SURVIVES — `unknown` hides too, which mirrors the gear surfaces exactly (the JOS-333
 * ruling in `plannerData.eraHides`: a question mark under a filter called "Current era" is a leak,
 * because the filter's promise is "what you can get" and "we cannot say" fails that promise the same
 * way "no" does).
 *
 * THE TIER SUFFIX IS STRIPPED BEFORE THE VERDICT (plan §3): `Timorous Deep +4` is Timorous Deep for
 * era purposes, and the zone table has never heard of the tiered spelling, so an unstripped name
 * would resolve to nothing and turn every tiered witness into an `unknown` the filter then hides.
 */
function eraLegal(row: GearRow, eraOnly: boolean): boolean {
  if (!eraOnly) return true
  const zones: string[] = []
  for (const source of row.wikiSources ?? []) {
    const zone = baseName(source.zone ?? '').trim()
    if (zone !== '') zones.push(zone)
  }
  return layeredVerdict(zones, row.eraTag) === 'in-era'
}

/**
 * The page's `|dropsfrom` witnesses, with the tier split off either side of the edge.
 *
 * THE TIER CAN RIDE ON EITHER NAME and the two cases are NOT the same fact, which is the whole
 * reason `mobLevel` is resolved here rather than at use:
 *   * the ZONE carries it (`Timorous Deep +4`, mob spelled plainly) — the mob is a mob the catalog
 *     knows, so its STATED level is carried. It is still ungated by con (`band: null`): what the
 *     catalog states is the base creature's level and nobody states what a tier does to it.
 *   * the MOB carries it (`Ixiblat Fer +5`) — that is a creature the catalog has no row for at all
 *     (plan §0.2: zero `MobEntry` names carry `+N`), and handing back the base mob's level would be
 *     stating a number about a different creature. `null`.
 */
function witnessesOf(row: GearRow, mobLevel: (name: string) => number | null): Witness[] {
  return (row.wikiSources ?? []).map((source) => witnessOf(source, mobLevel))
}

/** THE TIER, from whichever side of the edge spelled it. The zone wins when both do. */
function tierOf(zonePlus: PlusName | null, mobPlus: PlusName | null): number | null {
  return zonePlus?.plus ?? mobPlus?.plus ?? null
}

/** One `|dropsfrom` edge, resolved. Split out of `witnessesOf` for the complexity ceiling. */
function witnessOf(
  source: { mob: string; zone?: string },
  mobLevel: (name: string) => number | null
): Witness {
  const zoneRaw = source.zone ?? ''
  const zonePlus = zoneRaw === '' ? null : plusSuffix(zoneRaw)
  const mobPlus = plusSuffix(source.mob)
  const mob = mobPlus === null ? source.mob : mobPlus.base
  return {
    zone: (zonePlus === null ? zoneRaw : zonePlus.base).trim(),
    plus: tierOf(zonePlus, mobPlus),
    mob,
    mobLevel: mobPlus === null ? mobLevel(mob) : null
  }
}

/**
 * THE CON GATE, read across the WHOLE bracket: the band at the LOWEST level in `[from..to]` where a
 * mob of `mobLevel` falls inside `gate`, or `null` if it never does.
 *
 * Lowest rather than the midpoint because the bracket is advice about WHEN TO GO, and the earliest
 * level at which the fight is inside the gate is the answer to that question. A mob that only comes
 * into reach at the top of the bracket reports the band it has there — and one that is already grey
 * at the bottom reports `trivial` from the bottom, which is rule 5's whole point.
 */
function bandInBracket(
  mobLevel: number,
  bracket: Bracket,
  con: (my: number, mob: number) => ConBand,
  gate: readonly ConBand[]
): ConBand | null {
  for (let my = bracket.from; my <= bracket.to; my++) {
    const band = con(my, mobLevel)
    if (gate.includes(band)) return band
  }
  return null
}

/**
 * DOES THIS WITNESS PUT THE ITEM IN THIS BRACKET? `null` = no; `{ band }` = yes, with the band to
 * print (and `band: null` is a real answer — see rule 2 in the header).
 *
 * BASE WITNESS: the mob's stated level has to con at or under the reach CEILING somewhere in the
 * bracket (rule 5 — a grey mob passes, a deadly one does not). No stated level means no target: an
 * unlevelled mob cannot be conned and will not be guessed at.
 *
 * +N WITNESS: the con gate CANNOT be applied, so the only gate left is the one that can actually be
 * stated — the BASE zone's profile median has to sit inside the reach gate somewhere in the bracket.
 * That is a claim about the place, not about the tiered creature, and it is deliberately the weaker
 * claim: it keeps a +4 run out of a bracket forty levels below the zone without pretending to know
 * what the +4 mob itself cons at. A +N witness naming no zone at all has nothing left to gate on and
 * is dropped.
 */
function qualify(witness: Witness, bracket: Bracket, ctx: PlanCtx): { band: ConBand | null } | null {
  const { con, profiles } = ctx.corpora
  if (witness.plus === null) {
    if (witness.mobLevel === null) return null
    const band = bandInBracket(witness.mobLevel, bracket, con, ctx.gate)
    return band === null ? null : { band }
  }
  const profile = witness.zone === '' ? undefined : profiles.get(zoneLevelKey(witness.zone))
  if (profile === undefined) return null
  return bandInBracket(profile.median, bracket, con, ctx.gate) === null ? null : { band: null }
}

/** The first witness of a candidate that qualifies for this bracket, as a target — or `null`. */
function targetOf(candidate: Candidate, bracket: Bracket, ctx: PlanCtx): GearTarget | null {
  for (const witness of candidate.witnesses) {
    const verdict = qualify(witness, bracket, ctx)
    if (verdict === null) continue
    return {
      key: candidate.row.key,
      name: candidate.row.name,
      iconId: candidate.row.iconId,
      zone: witness.zone,
      plus: witness.plus,
      mob: witness.mob,
      mobLevel: witness.mobLevel,
      band: verdict.band,
      score: candidate.score,
      wished: candidate.wished
    }
  }
  return null
}

/**
 * ONE TARGET PER ITEM PER BRACKET, off its FIRST qualifying witness — so `targets` and `runs` are
 * built from an identical pool and an item can never appear under two headings at once.
 *
 * Every admitted item of the bracket is here, uncapped: the caps are applied by the two VIEWS below,
 * which is what lets a low-scoring run still render (rule 7) instead of being pre-truncated.
 */
function admittedFor(ctx: PlanCtx, bracket: Bracket, used: ReadonlySet<string>): GearTarget[] {
  const found: GearTarget[] = []
  for (const candidate of ctx.candidates) {
    if (used.has(candidate.row.key)) continue
    const target = targetOf(candidate, bracket, ctx)
    if (target !== null) found.push(target)
  }
  return found.sort(byWorth)
}

/** The grouping key: one run per (base zone, tier). See `GearRun`. */
function runKey(target: GearTarget): string {
  return `${zoneLevelKey(target.zone)} ${target.plus ?? 0}`
}

/** A base run's band is the zone-median reading `expZones` would print; a +N run has none (rule 2). */
function runBand(head: GearTarget, ctx: PlanCtx, midpoint: number): ConBand | null {
  if (head.plus !== null) return null
  const profile = head.zone === '' ? undefined : ctx.corpora.profiles.get(zoneLevelKey(head.zone))
  return profile === undefined ? null : ctx.corpora.con(midpoint, profile.median)
}

/**
 * THE ZONE-FIRST VIEW — the bracket's admitted items, grouped into trips.
 *
 * RUNS ARE RANKED BY THEIR BEST MEMBER, not by a sum: a run earns its line by CONTAINING an upgrade
 * for this trio at all (rule 7), and totalling scores would just re-create the global ranking that
 * buried the Refined runs in the first place. Zone name then tier break a tie, so the order is total.
 */
function runsFrom(admitted: readonly GearTarget[], ctx: PlanCtx, midpoint: number): GearRun[] {
  const groups = new Map<string, GearTarget[]>()
  for (const target of admitted) {
    const key = runKey(target)
    const members = groups.get(key)
    if (members) members.push(target)
    else groups.set(key, [target])
  }
  const runs: GearRun[] = []
  for (const members of groups.values()) {
    const head = members[0]
    runs.push({
      zone: head.zone,
      plus: head.plus,
      band: runBand(head, ctx, midpoint),
      targets: members.slice(0, RUN_TARGET_CAP)
    })
  }
  runs.sort(
    (a, b) =>
      byWorth(a.targets[0], b.targets[0]) ||
      a.zone.localeCompare(b.zone) ||
      (a.plus ?? 0) - (b.plus ?? 0)
  )
  return runs.slice(0, RUN_CAP)
}

/**
 * One whole bracket, and the ONE place an item is consumed.
 *
 * DEDUPE IS BY EMISSION, NOT BY ADMISSION: a key is consumed when it actually LANDS somewhere the
 * reader will see it — the flat top-8 or a kept run — so anything every cap cut can still surface in
 * a later bracket, where it has fewer competitors. Consuming on admission would delete a row from the
 * whole plan on the strength of a display limit, which is the one thing a cap must never do.
 */
function bracketOf(ctx: PlanCtx, bracket: Bracket, used: Set<string>): PlanBracket {
  const midpoint = Math.floor((bracket.from + bracket.to) / 2)
  const admitted = admittedFor(ctx, bracket, used)
  const targets = admitted.slice(0, TARGET_CAP)
  const runs = runsFrom(admitted, ctx, midpoint)
  for (const target of targets) used.add(target.key)
  for (const run of runs) for (const target of run.targets) used.add(target.key)
  return {
    from: bracket.from,
    to: bracket.to,
    expZones: expZonesFor(ctx.corpora.profiles, midpoint, ctx.corpora.con, ctx.eraOnly),
    runs,
    targets
  }
}

/**
 * This bracket's exp zones: the ones whose profile MEDIAN cons `safe` or `even` at the bracket
 * midpoint. `trivial` is DELIBERATELY OUT HERE, which is the one place this fold and the target gate
 * disagree on purpose (rule 5): a grey mob is a fine thing to farm an item off and a useless thing to
 * grind experience on, so the ceiling that admits it for TARGETS would be a lie for EXP ZONES.
 *
 * Ranked by how close the median sits to the midpoint, then by `sampled` descending (a
 * profile folded from 60 stated levels is worth more than one folded from 2), then by name so the
 * order is total. Capped at `EXP_ZONE_CAP`, which the surface states.
 *
 * THE MEDIAN IS THE ZONE'S STAND-IN, and it is a coarse one: a zone with a level-6 entrance and a
 * level-40 basement has a median that describes neither. `low` rides along on every pick so the
 * surface can show the spread instead of the fold pretending to be a range.
 *
 * THE ERA GATE HERE DROPS ONLY A POSITIVE `out-of-era`, where the item gate hides `unknown` too.
 * The asymmetry is deliberate and is about what the two silences MEAN. For an ITEM, `unknown` is
 * usually the wiki badging a page our corpus does not hold (JOS-333's measured remainder), so it is
 * a leak. For a ZONE, the only witness is the hand-authored `zones.ts` table, whose unresolved
 * names are dirt, prose and EQL-new places — hiding every zone that table has not heard of would
 * delete the route's exp half wholesale rather than tighten it.
 */
function expZonesFor(
  profiles: ReadonlyMap<string, ZoneLevels>,
  midpoint: number,
  con: (my: number, mob: number) => ConBand,
  eraOnly: boolean
): ZonePick[] {
  const picks: ZonePick[] = []
  for (const profile of profiles.values()) {
    if (eraOnly && layeredVerdict([profile.zone], undefined) === 'out-of-era') continue
    const band = con(midpoint, profile.median)
    if (band !== 'safe' && band !== 'even') continue
    picks.push({
      zone: profile.zone,
      median: profile.median,
      low: profile.low,
      sampled: profile.sampled,
      band
    })
  }
  picks.sort(
    (a, b) =>
      Math.abs(a.median - midpoint) - Math.abs(b.median - midpoint) ||
      b.sampled - a.sampled ||
      a.zone.localeCompare(b.zone)
  )
  return picks.slice(0, EXP_ZONE_CAP)
}

/** What the admission test reads, bundled: the row's score, the owned bars, the role's policy. */
interface AdmitGate {
  score: number
  bars: ReadonlyMap<EquipSlot, number> | undefined
  policy: WeaponSlotPolicy
}

/**
 * IS THIS AN UPGRADE? — the admission test (rule 8). A GAP test rather than a ranking, now read
 * THROUGH the role's weapon-slot policy (rule 11).
 *
 * An item is in when there is AT LEAST ONE slot it fits where BOTH are true: the role would take a
 * suggestion for that slot at all (`policyAdmits`), and its score STRICTLY beats the best owned
 * score there. A two-hander that beats your PRIMARY is worth the trip even if your SECONDARY is
 * better still; a ring that beats neither finger is not; and under a 2H role a shield fits nowhere
 * the role is listening, whatever it scores.
 *
 * A SLOT THE MAP DOES NOT NAME IS A GAP and admits anything wearable — see `PlanCorpora
 * .ownedBestBySlot` for why absent is read as "nothing stated there" rather than "an owned zero".
 * A row with no slots at all cannot fill a gap and is out; `gear.ts` says a row exists precisely
 * because it has one, so that arm is a guard rather than a case.
 *
 * THE POLICY IS CHECKED EVEN WHEN NO BARS WERE HANDED IN, which is the whole point of the empty
 * offhand: it is closed because the ROLE says so, not because anything is known to be worn there.
 */
function isUpgrade(row: GearRow, gate: AdmitGate): boolean {
  return row.slots.some((slot) => {
    if (!policyAdmits(gate.policy, slot, row)) return false
    if (gate.bars === undefined) return true
    const best = gate.bars.get(slot)
    return best === undefined || gate.score > best
  })
}

/** Every gear row that could ever be a target, filtered once and scored once (not per bracket). */
function candidatesOf(inputs: PlanInputs, corpora: PlanCorpora): Candidate[] {
  const out: Candidate[] = []
  const policy = ROLE_WEAPON_POLICY[inputs.role]
  for (const row of corpora.gear) {
    if (corpora.owned.has(row.key)) continue
    if (!wearable(row, inputs.classes)) continue
    if (!eraLegal(row, inputs.eraOnly)) continue
    const witnesses = witnessesOf(row, corpora.mobLevel)
    if (witnesses.length === 0) continue
    const score = roleValue(row.stats, inputs.role)
    // A WISHED ITEM SKIPS THE GAP TEST **AND THE POLICY**. The user declaring they want a thing is
    // the strongest statement about it anywhere in this corpus, and it outranks both a score this
    // file's own header calls invented and a loadout shape inferred from a picker. The policy exists
    // to stop UNSOLICITED suggestions; a wish is the opposite of unsolicited, so a 2H player who has
    // wish-listed a shield is told where to get their shield. Every other gate — era, reach,
    // wearability — still applies.
    const wished = corpora.wished.has(row.key)
    if (!wished && !isUpgrade(row, { score, bars: corpora.ownedBestBySlot, policy })) continue
    out.push({ row, witnesses, score, wished })
  }
  return out
}

/**
 * Is this bracket silent — nowhere to grind and nothing to go and get?
 *
 * `runs` is not consulted because it cannot disagree: both views are built from the same admitted
 * pool, so `targets` is empty exactly when `runs` is.
 */
function isQuiet(bracket: PlanBracket): boolean {
  return bracket.expZones.length === 0 && bracket.targets.length === 0
}

/**
 * THE ROUTE: brackets of `bracketSize` levels, opening at the character's CURRENT level (44 → 44-49,
 * 50-55, …), each carrying where to grind and what to go and get while you are there.
 *
 * THE HORIZON IS DATA-DRIVEN, because this repo has no level cap to read. The route stops after
 * `QUIET_BRACKETS` consecutive brackets that carry neither an exp zone nor a target — that is the
 * corpus saying it has run out of things to state, which is a fact, where "stop at 50" would be a
 * number invented about a server whose cap is nowhere in this data. `HORIZON_LEVELS` is a hard
 * backstop so a strange corpus cannot loop, not a claim. Trailing silent brackets are trimmed before
 * the route is returned — a silent bracket in the MIDDLE is information ("nothing here, keep going"),
 * a silent one at the end is just the loop's own footprint.
 *
 * Bracket midpoint is `floor((from + to) / 2)`: the con model is stated in whole levels on both
 * sides, so asking it about level 46.5 would be asking a question the game never answers.
 */
export function buildProgressionPlan(inputs: PlanInputs, corpora: PlanCorpora): PlanBracket[] {
  const size = Math.max(1, Math.floor(inputs.bracketSize ?? DEFAULT_BRACKET_SIZE))
  const start = Math.max(1, Math.floor(inputs.level))
  const ctx: PlanCtx = {
    corpora,
    gate: inputs.reach === 'group' ? GROUP_GATE : SOLO_GATE,
    eraOnly: inputs.eraOnly,
    candidates: candidatesOf(inputs, corpora)
  }
  const used = new Set<string>()
  const route: PlanBracket[] = []
  let quiet = 0
  for (let from = start; from <= start + HORIZON_LEVELS; from += size) {
    route.push(bracketOf(ctx, { from, to: from + size - 1 }, used))
    quiet = isQuiet(route[route.length - 1]) ? quiet + 1 : 0
    if (quiet >= QUIET_BRACKETS) break
  }
  while (route.length > 0 && isQuiet(route[route.length - 1])) route.pop()
  return route
}
