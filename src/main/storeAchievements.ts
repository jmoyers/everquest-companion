// storeAchievements.ts — the `/outputfile achievements` dump's store accessor (JOS-429).
//
// SPLIT OUT OF store.ts FOR FILE MASS, NOT FOR SCOPE — the roster.ts/windows.ts/perf.ts rule this
// repo states in four places now, and `storePlans.ts`'s header states it best: store.ts sits at the
// measured 400-code-line ceiling, and the answer to that is a SPLIT rather than a widened
// threshold. The second graduated `/outputfile` kind needed one write pair that file had no room
// for.
//
// WHAT MOVED IS CODE, NOT AUTHORITY. `setProgress` is still the one write path into `byCharacter`
// and it is imported from store.ts; the PROJECTION being written was already taken at the one place
// the file becomes the model (`outputs/index.ts loadAchievements`), so this file decides nothing
// about what an achievements dump means.
//
// IT IS DELIBERATELY THE SAME SHAPE AS `setInventory`: a flat artifact plus the record of which
// file it came from, written TOGETHER so neither half can end up describing the other's dump. That
// symmetry is the whole reason a second kind cost one function.
//
// AND IT WRITES NOTHING INTO THE TURN-IN LEDGER. Not `questTurnIns`, not its downgrade mirror
// `completedQuests`. The join against the Sky quest set happens on every read in the renderer,
// labelled with where it came from (shared/questTurnIns.ts's evidence ladder) — persisting it as a
// turn-in would forge an event the player never made, would survive the file being corrected, and
// would hand an older build a completion it has no way to explain. shared/progressState.ts argues
// it at length on the key itself.
//
// NO SCHEMA BUMP AND NO MIGRATION, the `exaltPlans` precedent exactly: `achievementUnlocks` and
// `achievementsSource` are ADDITIVE optional keys, every reader defaults on a missing one, and
// electron-store rewrites the whole parsed object so both survive a round trip through an older
// build.

import type { AchievementsSource, ClassUnlockClaim } from '../shared/outputs/achievements'
import type { ProgressState } from '../shared/types'
import { getProgress, setProgress } from './store'

/** Record the achievements dump's earned class-unlock rewards and where they came from. */
export function setAchievements(
  charId: string,
  unlocks: ClassUnlockClaim[],
  source: AchievementsSource
): ProgressState {
  const p = getProgress(charId)
  return setProgress(charId, { ...p, achievementUnlocks: unlocks, achievementsSource: source })
}
