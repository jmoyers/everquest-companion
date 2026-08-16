// plan/planData.ts — EVERYTHING THE PURE FOLD IS HANDED, AND NOTHING IT DECIDES
// (docs/plans/gear-progression-planner.md §2.4, §4).
//
// `shared/planner/progressionPlan.ts` takes its whole world as a parameter — the gear rows, the
// zone profiles, a mob-level lookup, the con function, what you own and what you have already
// wished for — precisely so the fold can be tested against synthetic corpora with no renderer
// anywhere near it. THIS FILE IS THE PRODUCTION WIRING OF THAT PARAMETER and it is deliberately
// the only place the two halves meet: no component below reaches for a catalog, a store or an IPC
// channel, and no rule about what belongs in a route lives here.
//
// THE TWO CATALOG FOLDS ARE BUILT ONCE PER WINDOW, LAZILY — the `lib/itemSources.ts` precedent,
// and for the same three reasons it states. `MOB_CATALOG` is 7,872 immutable rows compiled into
// this bundle, the Plan tab may never be opened this session, and a `useMemo` per mount would
// re-fold the whole catalog every time a tab switch remounted the view. Module scope with a lazy
// singleton is the shape that answers all three.
//
// THE MOB KEY IS THE FOLD `mergeItemSources` ALREADY USES — trim, case-fold, and nothing else. It
// is joining two halves of one wiki that disagree about capitalisation constantly (the item page's
// `|dropsfrom` spelling against the catalog's own page title), which is exactly the join that
// function documents. It is NOT `zoneLevelKey`, whose name is about zones, and it is NOT
// `sourceItemKey`, whose `+N` strip belongs to ITEMS: a mob named `Ixiblat Fer +5` is a creature
// this catalog has no row for at all (plan §0.2), and quietly folding it onto the base mob would
// hand back a level about a different creature — the very thing `witnessOf` refuses.
//
// A NAME THE CATALOG STATES TWICE KEEPS THE HIGHER LEVEL. The catalog is one row per PAGE and the
// same creature name recurs across zones and tiers, so a name can resolve to several stated levels.
// The route gates on "does this con inside my reach", and a higher level pushes a target LATER —
// so taking the maximum is the CAUTIOUS read, the same direction `conBands.SEED_BANDS` rounds its
// unsampled risky/deadly split ("a plan that calls a mob risky when it is deadly gets someone
// killed; the reverse wastes a pull"). Taking the minimum would advertise a camp you cannot hold.

import { useCallback, useMemo } from 'react'
import type { ClassAbbr } from '@shared/classCombo'
import { conBand } from '@shared/conBands'
import type { GearRow } from '@shared/planner/gear'
import type { EquipSlot } from '@shared/planner/types'
import type { WishList } from '@shared/planner/wishlist'
import {
  buildProgressionPlan,
  roleValue,
  type GearRole,
  type GearTarget,
  type PlanBracket,
  type PlanCorpora
} from '@shared/planner/progressionPlan'
import { statedLevel, zoneLevelProfile, type ZoneLevels } from '@shared/planner/zoneLevels'
import { MOB_CATALOG } from '../mobs/mobSearch'
import type { PlanReach } from '../gear/areaMemory'
import type { GearOwnershipMap } from '../gear/gearOwnership'
import { useWishlist } from '../wishlist/useWishlist'
import { wishFromGear } from '../wishlist/wishSearch'

// ---- the two catalog folds ---------------------------------------------------------------------

let PROFILES: ReadonlyMap<string, ZoneLevels> | null = null
let MOB_LEVELS: ReadonlyMap<string, number> | null = null

/** Every zone the catalog places a levelled mob in, profiled. Built on first use — see the header. */
export function zoneProfiles(): ReadonlyMap<string, ZoneLevels> {
  PROFILES ??= zoneLevelProfile(MOB_CATALOG)
  return PROFILES
}

/** The join key for a mob NAME, the `mergeItemSources` fold — see the header for what it is not. */
function mobKey(name: string): string {
  return name.trim().toLowerCase()
}

function mobLevels(): ReadonlyMap<string, number> {
  if (MOB_LEVELS !== null) return MOB_LEVELS
  const out = new Map<string, number>()
  for (const mob of MOB_CATALOG) {
    const level = statedLevel(mob.level)
    if (level === null) continue
    const key = mobKey(mob.name)
    const held = out.get(key)
    if (held === undefined || level > held) out.set(key, level)
  }
  MOB_LEVELS = out
  return out
}

/**
 * The level the catalog states for a mob, or `null` when it states none.
 *
 * `null` is an ANSWER and the fold treats it as one: a base witness whose mob has no stated level
 * is not a target at all, because an unlevelled mob cannot be conned and will not be guessed at
 * (`progressionPlan.qualify`). It is never 0.
 */
export function mobLevelOf(name: string): number | null {
  return mobLevels().get(mobKey(name)) ?? null
}

// ---- the corpora ------------------------------------------------------------------------------

/**
 * WHAT THIS CHARACTER ALREADY HAS, as the fold's `owned` set.
 *
 * The predicate is `gearData.useOwnedOrLooted`'s, restated over the map rather than per row because
 * the fold wants a SET and that hook wants a row predicate. All three arms are kept for the reason
 * `gearOwnership.ts` gives (rule 2): an exaltation is proof a copy passed through this character's
 * hands, and a route that offered you an item you have already melted would be answering a question
 * nobody asked.
 */
function ownedKeys(map: GearOwnershipMap | null): ReadonlySet<string> {
  const out = new Set<string>()
  if (map === null) return out
  for (const [key, o] of map) {
    if (o.owned || o.looted || o.exaltations > 0) out.add(key)
  }
  return out
}

/**
 * THE BAR EACH SLOT HAS TO BEAT — the half of the plan that makes it "look at what I have"
 * (owner, 2026-08-15: *"i should be able to gear my guy up, so it needs to look at what I have and
 * the best in slot"*), and the production side of `PlanCorpora.ownedBestBySlot`.
 *
 * ONE OWNED ITEM RAISES EVERY SLOT IT FITS, and the bar is the MAX rather than a sum or an average:
 * the question the fold asks is "would this beat what I would actually wear there", and what you
 * would wear there is your best. An earring that fits two ear cells raises both.
 *
 * BASE STATS, LIKE THE TARGETS THEY ARE COMPARED AGAINST (fold rule 6, the owner's *"base stats can
 * be used, that's fine, because we can upgrade"*). `useGearIndex` hands out the UNSCALED corpus, so
 * this is base-against-base by construction — and it has to be, because the owned copy's real `+N`
 * is a fact off the dump while a drop's tier is a thing you have not earned yet. Scoring the owned
 * side at its merged tier would raise every bar past every drop and empty the route.
 *
 * A KEY THE CORPUS HAS NO ROW FOR CONTRIBUTES NOTHING (law 1). Ownership is read from the player's
 * dump and their loot history, both of which name items this scrape may not describe; a row we
 * cannot score is not a bar of zero, it is a slot this map declines to speak for — which the fold
 * then reads as a gap and keeps offering upgrades into. That is the honest failure direction.
 */
function ownedBars(
  owned: ReadonlySet<string>,
  byKey: ReadonlyMap<string, GearRow>,
  role: GearRole
): ReadonlyMap<EquipSlot, number> {
  const bars = new Map<EquipSlot, number>()
  for (const key of owned) {
    const row = byKey.get(key)
    if (row === undefined) continue
    const score = roleValue(row.stats, role)
    for (const slot of row.slots) {
      const held = bars.get(slot)
      if (held === undefined || score > held) bars.set(slot, score)
    }
  }
  return bars
}

/**
 * The fold's whole world, memoized on the things that actually move: the corpus (once per window),
 * the ownership join (a dump re-read or a loot line), the wish list document (a click) and the ROLE
 * (a pick — it re-scores the owned side as well as the candidate side, so the bars move with it).
 *
 * The two catalog folds and `conBand` are constants, so they are not dependencies — which is what
 * keeps a keystroke on another tab from re-planning a route.
 *
 * AN EMPTY BAR MAP IS THE SAME STATEMENT AS AN ABSENT ONE, so this always passes a map rather than
 * branching: `ownedBestBySlot` reads a missing slot as a gap, and a map with no entries has every
 * slot missing. A character who has never run `/outputfile` and looted nothing therefore gets
 * exactly the documented default — every slot a gap, every wearable drop an upgrade.
 */
export function usePlanCorpora(
  rows: readonly GearRow[],
  ownership: GearOwnershipMap | null,
  list: WishList,
  role: GearRole
): PlanCorpora {
  const owned = useMemo(() => ownedKeys(ownership), [ownership])
  const entries = list.entries
  const wished = useMemo(() => new Set(entries.map((e) => e.itemKey)), [entries])
  // Keyed on the ARRAY identity, which `useGearIndex` holds stable for the life of the window, so
  // this 6,766-entry map is built once per window and never per pick — `useGearCompare` builds the
  // same map next door for the hover cards and for the same reason.
  const byKey = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows])
  const ownedBestBySlot = useMemo(() => ownedBars(owned, byKey, role), [owned, byKey, role])
  return useMemo(
    () => ({
      gear: rows,
      profiles: zoneProfiles(),
      mobLevel: mobLevelOf,
      con: conBand,
      owned,
      wished,
      ownedBestBySlot
    }),
    [rows, owned, wished, ownedBestBySlot]
  )
}

/** What the player told the header. The level arrives separately because it can be UNSTATED. */
export interface PlanPicks {
  classes: readonly ClassAbbr[]
  role: GearRole
  reach: PlanReach
  eraOnly: boolean
}

/**
 * The route, or `[]` when nothing has stated a level.
 *
 * NO GUESSED LEVEL, EVER. `buildProgressionPlan` opens its first bracket at the character's current
 * level, so handing it a default would print a confident six-bracket route about a character the
 * log has never described. An empty route with the view's own empty state beside it is the honest
 * answer, and the moment a ding or a `/who` lands it fills in with no other change.
 */
export function usePlanRoute(
  level: number | null,
  picks: PlanPicks,
  corpora: PlanCorpora
): PlanBracket[] {
  const { classes, role, reach, eraOnly } = picks
  return useMemo(() => {
    if (level === null) return []
    return buildProgressionPlan({ level, classes, role, reach, eraOnly }, corpora)
  }, [level, classes, role, reach, eraOnly, corpora])
}

/**
 * EVERY TARGET A BRACKET IS DRAWING, across its runs — what the card's one button carries.
 *
 * IT WALKS `runs` AND NOT THE FLAT `targets`, and that is the whole rule: the button says "add
 * these" and "these" is what the reader can see. The two views are built from one admitted pool and
 * capped differently (six runs of three against a flat top eight), so a button wired to the flat
 * list would silently add items no run drew and silently skip ones every run did.
 *
 * A key can appear in at most one run — the fold emits one target per item per bracket — so the
 * `Set` is a belt on a fold that already wears braces, and the wish document dedupes again anyway.
 */
export function bracketTargets(bracket: PlanBracket): GearTarget[] {
  const seen = new Set<string>()
  const out: GearTarget[] = []
  for (const run of bracket.runs) {
    for (const target of run.targets) {
      if (seen.has(target.key)) continue
      seen.add(target.key)
      out.push(target)
    }
  }
  return out
}

/**
 * THE ONE DOOR OUT OF THIS TAB: a bracket's targets, onto the wish list.
 *
 * It is `useWishlist.add` per target and nothing else — the same call `wishFromGear` feeds from the
 * Gear tab's per-row control, so a wish written by the plan and one written by hand are the same
 * bytes, `source: 'user'` included. NOT `seed`/`applySeed`: that door is once-forever by design
 * (the exaltation plan's one-time fill), and a bracket button is a thing you press whenever you
 * like. Already-wished targets are a no-op, because the document dedupes by `itemKey`.
 *
 * AND THE ROWS STAY ON THE CARD AFTERWARDS (fold rule 9, and it is a reversal worth naming: the
 * first cut of this tab dropped them). A wished item is FLAGGED, not filtered — it bypasses the
 * upgrade-gap test and sorts first — because the user saying "I want this" is the strongest
 * statement in the corpus and a route that went quiet about it would be hiding the answer to the
 * question that was just asked.
 *
 * IT IS UNDEFINED UNTIL THE DOCUMENT HAS LOADED — the absent-not-disabled rule, exactly as
 * `GearView.useGearWishes` argues it: before `ready` the empty list is a default rather than an
 * answer, and a button that wrote against it could duplicate nothing and would still be a control
 * offered over a document nobody has read.
 */
export function usePlanWishes(): {
  list: WishList
  addBracket?: (bracket: PlanBracket) => void
} {
  const wishlist = useWishlist()
  const { add, ready } = wishlist
  const addBracket = useCallback(
    (bracket: PlanBracket) => {
      const now = Date.now()
      for (const target of bracketTargets(bracket)) add(wishFromGear(target, now))
    },
    [add]
  )
  return { list: wishlist.list, addBracket: ready ? addBracket : undefined }
}
