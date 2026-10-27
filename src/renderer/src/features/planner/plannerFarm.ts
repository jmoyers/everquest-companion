// planner/plannerFarm.ts — a list of wanted items, turned into a route: what is still missing, and
// where it is.
//
// This is the arithmetic that was behind Farm mode (design §5.4), kept out of the view so the
// interesting part is one pure function over plain data. JOS-326 removed the Farm TAB and the plan
// board that fed it; the arithmetic is untouched and is now aimed at the WISH LIST
// (features/wishlist/wishFarm.ts collects the needs, this file groups them). That re-aim is the
// reason `FarmNeed` no longer names a plan CELL: a wish is flat by owner ruling, and every rule
// below — the primary zone, the "also:" tail, the four non-zone headings, the era override — only
// ever read a need's ZONES, its SOURCES and its donor row.
//
// WHY A DONOR IS LISTED UNDER ONE ZONE AND NOT ALL OF THEM. Roughly a third of donors drop in
// several zones, and listing each under every zone turns a route into a concordance: eight
// headings, the same four items under each, no idea where to actually go. So every donor is
// assigned to ONE primary zone — the zone that holds the most of THIS SET'S other needs — and
// keeps an "also" note naming the rest. The rollup then reads the way the feature was asked for:
// "go to Lower Guk, it feeds four sockets."
//
// Ties break ALPHABETICALLY, not by catalog order. Two zones that feed the same number of needs
// are equally good answers, and a stable, statable rule beats "whichever the scrape listed first"
// — a rescrape must never silently re-route the list.
//
// …AND THE ERA COMES FIRST, ABOVE BOTH (JOS-42, owner-reported 2026-08-06). Batfang Headband was
// filed under DRAGON NECROPOLIS — Velious, which this server has not opened — with Western Plains
// of Karana, where four classic-era ogres drop it, demoted to the muted "also:" tail. Nothing in
// the arithmetic was wrong: the three zones each fed one need, and the alphabetical tiebreak
// picked the first. But the heading a farm route prints is a place you are being told to GO, and
// a rollup that sends you somewhere unreachable is not a smaller answer than the right one — it
// is a wrong one, and it costs the whole surface its credibility.
//
// So with the era filter on, the primary zone is chosen from the IN-ERA zones whenever there are
// any, and the weights and the alphabetical tiebreak then decide among those. Out-of-era zones
// still appear — in the "also:" tail, each naming its own expansion, because "you could also camp
// this in Velious, later" is real knowledge and deleting it would be its own kind of lie. When NO
// zone is in era the candidate set is every zone again, which is the pre-existing behaviour: such
// a donor is out-of-era wholesale and the filter has already hidden it (FarmList), or the filter
// is off and the user has asked to see everything.
//
// THE FOUR NON-ZONE HEADINGS ARE HONEST STATES, NOT LEFTOVERS. A quest reward and a crafted item
// have no camp; a mob whose page states no home zone is a real camp with an unstated address; a
// donor with no source at all is a fact about our knowledge, not about the game. Each says which
// one it is rather than being dropped into a zone we invented.

import type { ClassAbbr } from '@shared/classCombo'
import type { EquipSlot, ExtractTier, SocketType } from '@shared/planner/types'
// RELATIVE value imports (the mobSearch house law): `tests/plannerFarm.test.mts` drives this
// rollup under the node runner, where the `@shared` alias — a vite-only resolution — does not
// exist. Type-only imports are erased and keep the alias.
import { extractionCost } from '../../../../shared/planner/rules'
import { CURRENT_ERA, ERA_LABEL, eraRank, zoneEra, type Era } from '../../../../shared/planner/era'
import type { EraSubject } from './plannerData'
import type { PlannerSource } from './sourceIndex'
import type { DonorProgress } from './plannerProgress'

/**
 * ONE WANTED ITEM, resolved against the corpus, the catalog and your own progress.
 *
 * `id` is the row's identity for React and for "every need appears exactly once" — the wish's
 * `itemKey`. It is a field rather than an implied composite because the shape used to be keyed by
 * `slot:socket:donorKey` and a flat list has no such tuple.
 *
 * THE EFFECT CONTEXT IS OPTIONAL, and that is the whole difference between the two kinds of wish.
 * A DONOR wish is wanted FOR an effect: it names the effect, the socket it occupies and therefore
 * the merge tier the effect extracts at, and the row states the cost of getting there. A GEAR wish
 * is wanted for itself: it names none of the three, and the row correctly says nothing about
 * merging (law 1 — silence, never a guessed tier).
 *
 * IT IS SELF-DESCRIBING, WHICH IS WHAT LETS TWO INDICES FEED IT. The need used to carry the
 * `DonorRow` the effect corpus answered with, and every reader reached through it for the item's
 * classes, slots, era witnesses and quest/crafted flags. A wish can equally be answered by the
 * GEAR index — different row type, same five facts — so the collector reads whichever index
 * knows and copies the facts here. Nothing downstream has to know which one spoke.
 */
export interface FarmNeed {
  /** the wish's `itemKey` — the React key, the remove handle, and the once-only identity */
  id: string
  /** the effect this row is wanted for; absent on a gear wish */
  effect?: string
  socket?: SocketType
  itemKey: string
  /** the display name — the corpus's when an index has the row, else the key itself */
  name: string
  /** the merge tier the effect extracts at — known from the SOCKET even without a corpus row */
  tierRequired?: ExtractTier
  /** what the era join is asked about: the row that answered, or the bare key when neither did */
  subject: EraSubject
  /** normalized classes; `[]` = UNKNOWN (never "nobody") */
  classes: readonly ClassAbbr[]
  /** normalized equip slots; `[]` = the page stated none */
  slots: EquipSlot[]
  /** the page states this is a quest reward / is player-crafted — from whichever row answered */
  quest: boolean
  playerCrafted: boolean
  /** every mob EITHER witness names — the mob catalog first, then page-only mobs (`mergedSources`) */
  sources: readonly PlannerSource[]
  /** distinct zones across every source, catalog order first */
  zones: string[]
  progress: DonorProgress
}

export type FarmGroupKind = 'zone' | 'quest' | 'crafted' | 'unstated' | 'unknown'

/**
 * One zone name with the expansion the zone table places it in — the "also:" tail's unit (JOS-42).
 *
 * `outOfEra` is a POSITIVE answer only. A zone the table cannot place (`era: null` — junk, prose,
 * an EQL-new zone) is never called out-of-era: that would dress a gap in our own tables up as a
 * fact about the game (law 1). It is simply a zone name with nothing else to say.
 */
export interface FarmZone {
  name: string
  era: Era | null
  outOfEra: boolean
  /** the expansion's display spelling, or '' — so a chip never re-states `ERA_LABEL` itself */
  eraLabel: string
}

/** A catalog zone string, placed. The one seam through which this rollup asks about eras. */
export function farmZone(name: string): FarmZone {
  const era = zoneEra(name)
  const outOfEra = era !== null && eraRank(era) > eraRank(CURRENT_ERA)
  return { name, era, outOfEra, eraLabel: era === null ? '' : ERA_LABEL[era] }
}

export interface FarmRow extends FarmNeed {
  /** the donor's OTHER zones — the "also: …" note, each carrying its own era verdict */
  also: FarmZone[]
}

/** What the rollup needs to know about the surface it is being drawn on. */
export interface FarmGrouping {
  /** the shared "Current era" toggle. ON ⇒ a donor never leads with a zone you cannot reach. */
  eraOnly: boolean
}

export interface FarmGroup {
  /** the zone name, or the heading for one of the four non-zone kinds */
  title: string
  kind: FarmGroupKind
  /**
   * The heading's own era, for a ZONE group; `null` for the four non-zone headings and for a zone
   * the table cannot place. With the era filter ON this is never a later expansion — that is the
   * JOS-42 invariant, and it is stated here so the UI can say so when the filter is OFF rather
   * than leaving "go to Dragon Necropolis" looking like an ordinary suggestion.
   */
  zone: FarmZone | null
  rows: FarmRow[]
}

const HEADINGS: Record<Exclude<FarmGroupKind, 'zone'>, string> = {
  quest: 'Quests',
  crafted: 'Crafted',
  unstated: 'Zone unstated',
  unknown: 'No known source'
}

/** Non-zone groups always follow the zones, in this order. */
const TAIL: Exclude<FarmGroupKind, 'zone'>[] = ['quest', 'crafted', 'unstated', 'unknown']

/**
 * BOTH WITNESSES TO "WHO DROPS THIS", AS ONE CAMP LIST — `lib/itemSources.mergeItemSources`.
 *
 * The rule (catalog row wins whole on a case-folded mob match; a page-only mob contributes a bare
 * name) lives in lib/ because the Loot tab's drill-down needs the identical fold for the identical
 * reason. Its header states why. This rollup only decides what to DO with the merged list.
 *
 * WHO ASSEMBLES THE NEEDS LIVES WITH THE DOCUMENT, NOT HERE (JOS-326). `collectNeeds(plan, …)`
 * used to sit at this point in the file and walked an `ExaltPlan`'s cells; the plan board is gone
 * and the wish list is what produces needs now, so the collection moved to
 * `features/wishlist/wishFarm.ts collectWishNeeds` and this file kept exactly the part that was
 * never about either document — the grouping arithmetic below.
 */

/** Which non-zone heading a zoneless need belongs under. Quest wins over crafted when both. */
function tailKind(need: FarmNeed): Exclude<FarmGroupKind, 'zone'> {
  if (need.sources.length > 0) return 'unstated'
  if (need.quest) return 'quest'
  if (need.playerCrafted) return 'crafted'
  return 'unknown'
}

/** zone → how many of these needs it could supply (a multi-zone donor votes for each of its zones). */
function zoneWeights(needs: readonly FarmNeed[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const need of needs) {
    for (const zone of need.zones) counts.set(zone, (counts.get(zone) ?? 0) + 1)
  }
  return counts
}

/** The zone that feeds the most of the set's other needs; ties alphabetical (see the header). */
function primaryZone(zones: readonly string[], weights: ReadonlyMap<string, number>): string {
  let best = zones[0]
  for (const zone of zones) {
    const better = (weights.get(zone) ?? 0) - (weights.get(best) ?? 0)
    if (better > 0 || (better === 0 && zone < best)) best = zone
  }
  return best
}

/**
 * WHICH ZONES MAY BE THE HEADING (JOS-42). With the era filter on, the reachable ones — and only
 * if there are none does every zone become a candidate again, which is exactly the old behaviour
 * for the wholesale-out-of-era donor the filter has already hidden.
 */
function candidateZones(zones: readonly string[], eraOnly: boolean): readonly string[] {
  if (!eraOnly) return zones
  const inEra = zones.filter((z) => !farmZone(z).outOfEra)
  return inEra.length > 0 ? inEra : zones
}

/**
 * Needs → the rollup: zone groups first (most needed donors first, ties alphabetical), then the
 * four honest non-zone headings. Every need appears EXACTLY ONCE.
 */
export function groupNeeds(needs: readonly FarmNeed[], opts: FarmGrouping): FarmGroup[] {
  const weights = zoneWeights(needs)
  const zones = new Map<string, FarmRow[]>()
  const tails = new Map<FarmGroupKind, FarmRow[]>()

  for (const need of needs) {
    if (need.zones.length === 0) {
      const kind = tailKind(need)
      const list = tails.get(kind)
      const row: FarmRow = { ...need, also: [] }
      if (list) list.push(row)
      else tails.set(kind, [row])
      continue
    }
    const primary = primaryZone(candidateZones(need.zones, opts.eraOnly), weights)
    const row: FarmRow = { ...need, also: need.zones.filter((z) => z !== primary).map(farmZone) }
    const list = zones.get(primary)
    if (list) list.push(row)
    else zones.set(primary, [row])
  }

  const zoneGroups: FarmGroup[] = [...zones.entries()]
    .map(([title, rows]) => ({ title, kind: 'zone' as const, zone: farmZone(title), rows }))
    .sort((a, b) => b.rows.length - a.rows.length || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))

  const tailGroups: FarmGroup[] = TAIL.filter((kind) => tails.has(kind)).map((kind) => ({
    title: HEADINGS[kind],
    kind,
    zone: null,
    rows: tails.get(kind) ?? []
  }))

  return [...zoneGroups, ...tailGroups]
}

/**
 * "needs +4 — ≈15 D0 merges or 1 D4 drop" — the merge cost, read straight out of
 * `extractionCost`'s fields. The arithmetic (2^t − 1, the ×16 D4 multiplier, the pre-plussed
 * drop) lives in shared/planner/rules.ts and is never restated here.
 */
export function costText(tierRequired: ExtractTier): string {
  const cost = extractionCost(tierRequired)
  const drops = cost.d4Copies === 1 ? '1 D4 drop' : `${String(cost.d4Copies)} D4 drops`
  return `needs +${String(cost.tier)} - ≈${String(cost.d0Copies)} D0 merges or ${drops}`
}

/**
 * The camp line for one row: the first mob EITHER witness names for this item, with its level
 * text VERBATIM (a range as often as a number) when the catalog knew it — a mob only the item page
 * names renders as a bare name, which is exactly what the page stated. Empty when nobody is named.
 */
export function campText(row: Pick<FarmNeed, 'sources'>): string {
  const first = row.sources[0]
  return first ? `${first.mob}${campTail(row)}` : ''
}

/** The camp line AFTER the mob's name — split out so a surface can make the name itself a door
 *  (WishGroups) while the level/`+N more` tail stays this module's one spelling. */
export function campTail(row: Pick<FarmNeed, 'sources'>): string {
  const first = row.sources[0]
  if (!first) return ''
  const extra = row.sources.length > 1 ? ` +${String(row.sources.length - 1)} more` : ''
  return first.levelText == null ? extra : ` (lvl ${first.levelText})${extra}`
}
