// gearplan/gearPlanSignalsHook.ts — the three verdicts, wired to the three sources that hold them.
//
// SPLIT FROM `gearPlanSignals.ts` so that file stays PURE and node-testable. The rules live there;
// this file only fetches. Same split as `gearFilter.ts` / `gearData.ts` next door.
//
// ONE HOOK, MOUNTED ONCE IN THE VIEW, handed to both pickers as a function. `useGearOwnership` does
// a real IPC read per mount and has no module cache, so two pickers each calling it would be two
// reads of the same dump for the same answer.
//
// THE ERA EVIDENCE COMES FROM THE GEAR INDEX, and that is the whole reason this is a hook rather
// than a `map` in the picker. A `PlannerItemHit` (what `plannerSearchItems` answers with) carries
// key, name, icon, slots and classes — and NO era fields at all. Asking `eraChip` about a bare
// `{key}` is entitled to a different answer than asking it about the corpus row (its own cache
// keys on the EVIDENCE for exactly this reason), and the honest answer needs the row. So a hit is
// joined to the gear index by key before its era is asked; an item the index does not carry reads
// `era?`, which is true.

import { useMemo } from 'react'
import type { ClassAbbr } from '@shared/classCombo'
import type { GearRow } from '@shared/planner/gear'
import { hasWish } from '@shared/planner/wishlist'
import { useGearClasses, useGearIndex, useGearOwnership } from '../gear/gearData'
import { factText, ownershipFor } from '../gear/gearOwnership'
import { eraChip, type EraSubject } from '../planner/plannerData'
import { useWishlist } from '../wishlist/useWishlist'
import { classFitOf, type RowSignals } from './gearPlanSignals'

/** What a caller must hand over: a key, its classes, and whatever era evidence it already has. */
export type SignalSubject = EraSubject & { classes?: readonly ClassAbbr[] }

/**
 * WHICH WITNESS `eraChip` IS ASKED ABOUT. A subject that carries its own era fields (a donor row
 * does) IS the row it came from and answers for itself; a bare search hit does not, so the corpus
 * row stands in. An item the index does not carry falls through to the hit, which reads `era?` —
 * true, and better than borrowing another item's provenance.
 */
function eraEvidence(subject: SignalSubject, row: GearRow | undefined): EraSubject {
  const bare = subject.eraTag === undefined && subject.wikiSources === undefined
  return bare && row !== undefined ? row : subject
}

/** A copy you hold or once looted, in the fewest words that are still true. `null` = neither. */
function ownedSignal(
  map: ReturnType<typeof useGearOwnership>['map'],
  subject: SignalSubject
): RowSignals['owned'] {
  if (map === null) return null
  const held = ownershipFor(map, subject)
  if (!held.owned && !held.looted) return null
  const first = held.facts[0]
  return {
    label: first === undefined ? 'looted' : factText(first),
    lootedOnly: held.lootedNotInDump
  }
}

export function useRowSignals(): (subject: SignalSubject) => RowSignals {
  const { rows } = useGearIndex()
  const { map } = useGearOwnership()
  const { classes: loadout } = useGearClasses()
  // THE WISH LIST IS A `useSyncExternalStore` DOCUMENT, so this re-renders the moment the board's
  // own wish control writes to it — the `wished` chip on a row cannot go stale against the list it
  // is reporting on, which it would if this were a fetch-on-mount snapshot.
  const wishlist = useWishlist()

  const byKey = useMemo(() => new Map(rows.map((r: GearRow) => [r.key, r])), [rows])

  return useMemo(
    () => (subject: SignalSubject): RowSignals => {
      const row = byKey.get(subject.key)
      return {
        era: eraChip(eraEvidence(subject, row)),
        classFit: classFitOf(subject.classes ?? row?.classes ?? [], loadout),
        owned: ownedSignal(map, subject),
        // `hasWish` and not a scan of the entries: it is the list's OWN predicate, the same one
        // `newWishes` filters by, so a row cannot read as unwished and then decline to be added.
        wished: hasWish(wishlist.list, subject.key)
      }
    },
    [byKey, map, loadout, wishlist.list]
  )
}
