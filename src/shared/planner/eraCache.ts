// eraCache.ts — A CATALOG FOLD TAKEN ONCE PER STATE OF THE ERA CHIP AND OF THE LOG'S EVIDENCE.
//
// The Recommended tab folds the 7,872-row bestiary into zone profiles and a mob-level join once per
// window (plan/planData.ts header). Both read the one mob era predicate (`shared/mobEra.mobOutOfEra`),
// and that predicate reads the player's own log (`shared/metInLog.ts`, owner ruling 2026-10-17: a
// mob the player killed, conned or looted from is in era for them). The evidence arrives after the
// first fold, so a fold kept forever would keep hiding a mob the log has since met. This is the
// cache that cannot: one answer per chip state, all of them dropped when `metVersion()` moves.
//
// Pure, relative imports: the node test runner loads it.

import { metVersion } from '../metInLog'

/** `build` per chip state, each taken once and taken again after the log's evidence moves. */
export function eraCached<T>(build: (eraOnly: boolean) => T): (eraOnly: boolean) => T {
  const held = new Map<boolean, T>()
  let met = metVersion()
  return (eraOnly) => {
    const now = metVersion()
    if (now !== met) {
      held.clear()
      met = now
    }
    let answer = held.get(eraOnly)
    if (answer === undefined) {
      answer = build(eraOnly)
      held.set(eraOnly, answer)
    }
    return answer
  }
}
