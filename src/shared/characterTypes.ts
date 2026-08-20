// characterTypes.ts — the `character` module's transport: who you are, where you are, and what
// level the log last said you were.
//
// Split out of types.ts for the same reason progressionTypes.ts and alertTypes.ts were: that file
// sits right at the MEASURED 400-code-line factoring ceiling, and JOS-192's level field pushed it
// over. The names are still exported from `shared/types`, which re-exports this file explicitly,
// so no importer moved and no import path changed.
//
// THE LEVEL FIELD IS THE WHOLE REASON THIS FILE EXISTS, and its rules live one door down in
// ./currentLevel — the precedence between the two statements the game makes, and the wording every
// surface prints. Here is only the shape that carries it.

import type { CharacterRef } from './types'
import type { LevelStatement } from './currentLevel'
import type { LocReading } from './logEvents'

/** character module: current character, zone, and the level the log last STATED. */
export interface CharacterSnap {
  character: CharacterRef | null
  zone?: string
  /**
   * THE ONE ANSWER TO "what level am I" (JOS-192) — the latest of the two statements the game ever
   * makes (a level-up line, or your own `/who` row), with which one it was and when. Absent until
   * one of them has been seen; the surfaces omit the number rather than guess it.
   *
   * NOT a duplicate of `LevelingSnap.levels` / `ProgressionSnap.levelValue`: those are the DING
   * SERIES and stay dings-only (they anchor the chart, the per-level history and the next-level
   * projection). See shared/currentLevel.ts for the precedence rules and the wording.
   */
  level?: LevelStatement
  /**
   * THE LAST `/loc` YOU TYPED (JOS-98 wave 2) — north/south, west/east, elevation, as the game
   * printed it. The maps view reads this to move its marker automatically: type /loc in game and
   * the crosshair follows, no paste.
   *
   * TRANSIENT AND LIVE-ONLY, unlike `zone`/`level`. It is set only from a LIVE `loc` event and is
   * CLEARED the instant you zone (a reading for the zone you just left must never land on the map
   * you just entered). So the historical replay never resurrects a stale position on launch, and a
   * `loc: undefined` in a delta means "nothing to place", not "erase the marker" — the marker's own
   * per-zone persistence is the renderer's, in localStorage.
   */
  loc?: LocReading
}

/** Every field is optional in a delta — the module pushes only what actually moved. */
export type CharacterDelta = Partial<CharacterSnap>
