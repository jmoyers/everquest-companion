// mobEra.ts — IS THIS BESTIARY ROW CONTENT THE SERVER RUNS TODAY. The one mob era predicate:
// every surface that hides or tags a catalog mob asks this function and nothing else.
//
// The catalog documents the Fear/Hate revamp beside the classic planes it replaced: the Plane of
// Hate's level 60-63 revamp mobs stand in the same zone as the classic ones, so no zone rule can
// tell them apart. The verdict is NOT taken here from the page's raw banner (`MobEntry.eraTag`): a
// banner alone would hide mobs the player fights ("a cave bat" is bannered Velious and lives in a
// classic zone). The data build applies the blanket wiki rule (banner and zones together) once and
// stores the answer as `MobEntry.outOfEra`.
//
// AND THE LOG OUTRANKS IT (owner ruling, 2026-10-17): a mob the player's own log shows they
// killed, conned or looted from is in era for them, whatever the flag says (`metInLog.ts`).
//
// A MOB WITHOUT THE FLAG IS IN ERA. Absent says nothing about its era, and silence is not "out"
// (law 1). Pure, relative imports: the node test runner loads it.

import { wasMet } from './metInLog'
import type { MobEntry } from './mobTypes'

/** True exactly when the data build put this mob out of era and the player's log never met it. */
export function mobOutOfEra(mob: Pick<MobEntry, 'outOfEra' | 'name'> & { readonly page?: string }): boolean {
  if (mob.outOfEra !== true) return false
  return !wasMet('mobs', mob.name) && !(mob.page !== undefined && wasMet('mobs', mob.page))
}
