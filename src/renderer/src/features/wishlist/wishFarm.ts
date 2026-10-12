// wishlist/wishFarm.ts — THE WISH LIST, TURNED INTO A ROUTE (JOS-326).
//
// The Farm tab is gone and the arithmetic behind it is not. `features/planner/plannerFarm.ts` was
// always a pure fold over needs — the primary zone (the one that feeds the most of the rest), the
// "also:" tail with each zone's expansion, the four honest non-zone headings, and the JOS-42 rule
// that a heading with the era filter on must be somewhere you can actually GO. None of that was
// ever about exaltation sets; it was about a list of items you want and where they drop. So this
// file is the collection half, re-aimed: wishes in, `FarmNeed`s out, `groupNeeds` unchanged.
//
// TWO INDICES ANSWER, AND EITHER MAY BE SILENT. A donor wish resolves against the DONOR CORPUS by
// (key, effect) — that row carries the merge tier, the effect's own facts and the item page's drop
// list. A gear wish resolves against the GEAR INDEX by key. A wish neither index knows (a rescrape
// dropped the page, or the store came from another machine) still produces a row: the name it was
// saved with, the mob catalog's own answer for its key, and nothing claimed that nobody stated.
//
// THE MERGE COST IS DONOR-ONLY, AND THAT IS NOT A GAP. "needs +4 - ≈15 D0 merges" answers "how far
// up the upgrade ladder before this effect can be EXTRACTED", which is a question a gear wish never
// asked: you want the breastplate, and looting it is the whole job. So `tierRequired` is absent
// there and the row says nothing about merging.
//
// FULFILLED MEANS TWO DIFFERENT THINGS, FOR THE SAME REASON. A donor wish is done when the log has
// seen the item merged to its extraction tier — `ready`, the state chip's own word, because short
// of that tier the effect will not come out. A gear wish is done the moment you HAVE one: held in
// the last dump or ever looted. Asking the merge ladder about a gear wish would leave a helm you
// are wearing sitting in the route forever.
//
// PURE AND NODE-TESTABLE (`tests/wishFarm.test.mts`) — every value import is relative, and the
// progress join arrives as a function rather than as a hook.

import type { ClassAbbr } from '@shared/classCombo'
import type { GearRow } from '@shared/planner/gear'
import type { EquipSlot, ExtractTier } from '@shared/planner/types'
import type { WishEntry } from '@shared/planner/wishlist'
// RELATIVE value imports (the mobSearch house law): the node runner drives this file, where the
// vite-only `@shared` alias does not resolve. Type-only imports are erased and keep the alias.
import { extractionTier } from '../../../../shared/planner/rules'
import { mergeItemSources } from '../../lib/itemSources'
import { donorFor, type DonorRow, type EraSubject } from '../planner/plannerData'
import type { FarmNeed } from '../planner/plannerFarm'
import type { DonorProgress } from '../planner/plannerProgress'
import { sourcesFor } from '../planner/sourceIndex'

/**
 * WHAT AN INDEX TOLD US ABOUT ONE WISHED ITEM — the five facts `FarmNeed` needs and the two row
 * types both carry, folded to one shape so the collector below never branches on which spoke.
 */
interface ItemFacts {
  name: string
  subject: EraSubject
  classes: readonly ClassAbbr[]
  slots: EquipSlot[]
  quest: boolean
  playerCrafted: boolean
  /** the item page's own drop list, the second witness beside the mob catalog */
  wikiSources?: { mob: string; zone?: string }[]
}

/** The honest answer when neither index carries the row: the name the wish was saved with. */
function unknownItem(entry: WishEntry): ItemFacts {
  return {
    name: entry.name,
    subject: { key: entry.itemKey },
    classes: [],
    slots: [],
    quest: false,
    playerCrafted: false
  }
}

function factsOfDonor(row: DonorRow): ItemFacts {
  const facts: ItemFacts = {
    name: row.name,
    subject: row,
    classes: row.classes,
    slots: row.slots,
    quest: row.quest,
    playerCrafted: row.playerCrafted
  }
  if (row.wikiSources !== undefined) facts.wikiSources = row.wikiSources
  return facts
}

function factsOfGear(row: GearRow): ItemFacts {
  const facts: ItemFacts = {
    name: row.name,
    subject: row,
    classes: row.classes,
    slots: row.slots,
    quest: row.quest,
    playerCrafted: row.playerCrafted
  }
  if (row.wikiSources !== undefined) facts.wikiSources = row.wikiSources
  return facts
}

/**
 * WHICH INDEX ANSWERS FOR THIS WISH, in the order that answers with the most.
 *
 * A DONOR wish asks the donor corpus for its exact (key, effect) pair first: that row is the only
 * one that knows the effect, and a different effect's row for the same item would state the wrong
 * merge tier. Anything the donor corpus cannot place falls through to the gear index, which knows
 * the item even when it does not know why you want it, and then to the honest unknown.
 */
function factsFor(entry: WishEntry, index: WishIndices): ItemFacts {
  if (entry.kind === 'donor' && entry.effect !== undefined) {
    const donor = donorFor(index.donors, entry.itemKey, entry.effect)
    if (donor !== null) return factsOfDonor(donor)
  }
  const gear = index.gear.get(entry.itemKey)
  if (gear !== undefined) return factsOfGear(gear)
  return unknownItem(entry)
}

/**
 * The merge tier a DONOR wish's effect extracts at — the corpus row's own answer when there is
 * one, else the socket's (R1: focus +1, click +2, worn +3, proc +4). Absent for a gear wish, and
 * absent for a donor wish that somehow carries no socket, because a tier nobody stated is not a
 * tier to print.
 */
function tierFor(entry: WishEntry, index: WishIndices): ExtractTier | undefined {
  if (entry.kind !== 'donor') return undefined
  const donor = entry.effect === undefined ? null : donorFor(index.donors, entry.itemKey, entry.effect)
  if (donor !== null) return donor.tierRequired
  return entry.socket === undefined ? undefined : extractionTier(entry.socket)
}

/** The two corpus views a wish can be resolved against, already keyed. */
export interface WishIndices {
  /** `indexDonors(donors)` — key → every (item, effect) row that key carries */
  donors: ReadonlyMap<string, DonorRow[]>
  /** key → the gear index's row for that item */
  gear: ReadonlyMap<string, GearRow>
}

/** `GearRow[]` → the key map `WishIndices` wants. One pass, done once per index change. */
export function indexGear(rows: readonly GearRow[]): Map<string, GearRow> {
  const out = new Map<string, GearRow>()
  for (const row of rows) if (!out.has(row.key)) out.set(row.key, row)
  return out
}

/**
 * Every wish, resolved. Includes the ones already satisfied — the CALLER decides what "still
 * wanted" means, because the wish list draws both: the route above and the done strip below
 * (`wishFulfilled`).
 *
 * A GEAR wish is asked about the progress join at tier 1, which is the lowest tier the type
 * allows and is a formality: `wishFulfilled` reads its held/looted counts and never its state, so
 * the tier passed here cannot change a gear wish's verdict. Passing the real tier is impossible —
 * there is not one — and passing the highest would make an ordinary owned helm read `+0/+4`.
 */
export function collectWishNeeds(
  entries: readonly WishEntry[],
  index: WishIndices,
  progressOf: (itemKey: string, tierRequired: ExtractTier) => DonorProgress
): FarmNeed[] {
  return entries.map((entry) => {
    const facts = factsFor(entry, index)
    const tierRequired = tierFor(entry, index)
    const sources = mergeItemSources(sourcesFor(entry.itemKey), facts.wikiSources)
    const need: FarmNeed = {
      id: entry.itemKey,
      itemKey: entry.itemKey,
      name: facts.name,
      subject: facts.subject,
      classes: facts.classes,
      slots: facts.slots,
      quest: facts.quest,
      playerCrafted: facts.playerCrafted,
      sources,
      // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: ItemSource now lives in shared so the gear index can build the drop trio (fork PR #31); no served source answers this read yet
      zones: [...new Set(sources.flatMap((s) => s.zones))],
      progress: progressOf(entry.itemKey, tierRequired ?? 1)
    }
    if (entry.effect !== undefined) need.effect = entry.effect
    if (entry.socket !== undefined) need.socket = entry.socket
    if (tierRequired !== undefined) need.tierRequired = tierRequired
    return need
  })
}

/**
 * IS THIS WISH DONE? Two rules, one per kind — see the header for why they differ.
 *
 * DONOR: `ready`, and only `ready`. `partial` is explicitly not done — "+2 of the +4 you need" is
 * the number that says how much farming is left, and moving that row to the done strip would
 * delete exactly the information it exists to carry.
 *
 * GEAR: held or looted. The log's merge ladder is not consulted at all, so an item you own reads
 * done whether or not you have ever merged it, and a `+0` observation cannot un-own it.
 *
 * `looted` counts an item you looted and later sold, gave away or destroyed, and that is the
 * intended reading rather than a bug: this decides whether the ROUTE still has to send you
 * somewhere, and a camp you have already beaten is not somewhere you need to be told to go. The
 * strip is dismissible and the row is removable, which is how a user says otherwise.
 */
export function wishFulfilled(entry: WishEntry, progress: DonorProgress): boolean {
  if (entry.kind === 'donor') return progress.state === 'ready'
  return progress.held > 0 || progress.looted > 0
}
