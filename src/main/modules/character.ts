// character module — the active CharacterRef, the current zone, and WHAT LEVEL YOU ARE. The
// CharacterRef is owned by index.ts (it resolves which log to tail) and pushed in via
// setCharacter(); zone and level come from the log stream. All three surface through the same
// module transport so a view can subscribe to "who am I / where am I / what am I" without a
// bespoke channel. Delta is a partial merge (any subset changed).
//
// THE LEVEL FACT (JOS-192). Its rules — latest statement wins, `/who` breaks a tie, and it never
// enters the ding series — are argued in shared/currentLevel.ts, which also words it for the
// four surfaces that read it. This module is only the fold.
//
// WHY HERE AND NOT IN `leveling`/`progression`. Those two are SERIES: an append-only record of
// level-ups and a range-queryable analytics fold. A `/who` row is not a level-up and belongs in
// neither — putting it in either would fabricate a ding, and the AGENTS.md rule that the ding
// series stays dings-only exists because the chart, the per-level history and the next-level
// projection are all anchored on it. "What level am I right now" is a fact about the CHARACTER,
// which is this module's whole subject, and the one surface that already draws the level beside
// the name and the class trio (CharacterIdentity) already subscribes here.
//
// AND ITS SEQ IS ITS OWN REVISION, NOT THE LAST EVENT'S — the JOS-87 rule, second application.
// `useModule` dedupes with `if (d.seq <= knownSeq) return`, so a module whose state can move
// WITHOUT a log event needs a counter of its own. This one has always had such an input
// (`setCharacter`, which pushed a pending delta and advanced no seq), and the level fact adds the
// case that matters: a `/who` typed to correct a wrong loadout is usually the only line the log
// produces for minutes, and it must correct the level AND the classes while everything else is
// idle. The counter never resets — a seq that went backwards is a re-hydration signal to an
// overlay and a permanently-dropped delta to the main window, and neither is wanted here.

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import type { CharacterDelta, CharacterRef, CharacterSnap } from '../../shared/types'
import { laterStatement, type LevelStatement } from '../../shared/currentLevel'

export class CharacterModule implements EqModule<CharacterSnap, CharacterDelta> {
  readonly id = 'character'
  private character: CharacterRef | null = null
  private zone: string | undefined
  private level: LevelStatement | undefined
  /** The last LIVE `/loc`, cleared on every zone change — see CharacterSnap.loc for why transient. */
  private loc: CharacterSnap['loc']
  /** See the header: the module's OWN revision, monotonic for the life of the process. */
  private rev = 0
  private pending: CharacterDelta = {}

  reset(): void {
    // Keep the character ref across a reset — reset() runs on (re)load and the ref is set by
    // index.ts right before/after. Everything LOG-DERIVED clears: a rescan re-folds it, and a
    // character switch must not carry the previous character's zone or level into the new one.
    this.zone = undefined
    this.level = undefined
    this.loc = undefined
    this.pending = {}
    this.rev++
  }

  /** Called by index.ts when the tailed character changes. */
  setCharacter(ref: CharacterRef | null): void {
    this.character = ref
    this.pending.character = ref
    this.rev++
  }

  // `live` defaults to false so a one-arg caller (the unit tests, and any direct driver) gets
  // replay semantics — the /loc auto-place is a LIVE-only effect, and false is the safe read.
  onEvent(ev: LogEvent, live = false): void {
    if (ev.kind === 'epoch') {
      // Character rebirth (epochDetector.ts): the level and zone of the wiped character say
      // nothing about this one. The ref is index.ts's and stays.
      this.zone = undefined
      this.level = undefined
      this.clearLoc()
      this.pending.zone = undefined
      this.pending.level = undefined
      this.rev++
      return
    }
    if (ev.kind === 'zone' && ev.zone !== this.zone) {
      this.zone = ev.zone
      this.pending.zone = ev.zone
      // A /loc reading belongs to the zone it was taken in; leaving that zone retires it, so the
      // reading you took in East Freeport can never place a crosshair on the Commonlands map you
      // just walked into. Pushing `loc: undefined` (not erasing the marker) is what a consumer
      // reads as "nothing to auto-place now" — see CharacterSnap.loc.
      this.clearLoc()
      this.rev++
      return
    }
    // WHERE YOU ARE (JOS-98 wave 2), LIVE ONLY. The historical replay folds /loc lines like every
    // other module (the `live` flag gates nothing in the fold itself) but must NOT set this: a /loc
    // from days ago would otherwise place a marker on launch and overwrite the one you typed by
    // hand. So the guard is here, at the one field where a stale value would be user-visible.
    if (ev.kind === 'loc' && live) {
      this.loc = ev.loc
      this.pending.loc = ev.loc
      this.rev++
      return
    }
    if (ev.kind === 'level') {
      this.stateLevel({ level: ev.level, ts: ev.ts, source: 'ding' })
      return
    }
    if (ev.kind === 'selfWho') {
      this.stateLevel({ level: ev.level, ts: ev.ts, source: 'who' })
    }
  }

  /**
   * Fold one statement in. A replay can hand these out of order in principle (the fold is a single
   * seq stream, so in practice it cannot), and `laterStatement` is total — so the winner is decided
   * by the rule rather than by arrival order either way.
   *
   * Nothing is pushed when the statement already held WINS, which is the out-of-order case and the
   * same-second ding behind a `/who`. A row restating a level you already dinged to does push,
   * because the level is not the whole fact: the AGE of the statement is what the surfaces hedge
   * on, and "your own /who said 50 four seconds ago" is a different thing to know than "your last
   * level-up said 50 three days ago".
   */
  private stateLevel(next: LevelStatement): void {
    const held = this.level
    // `laterStatement` returns one of its two arguments, so identity IS the verdict.
    const winner = held ? laterStatement(held, next) : next
    if (winner === held) return
    this.level = winner
    this.pending.level = winner
    this.rev++
  }

  /** Drop the last /loc, staging the clear only when there was one to drop. Callers own the rev. */
  private clearLoc(): void {
    if (this.loc === undefined) return
    this.loc = undefined
    this.pending.loc = undefined
  }

  snapshot(): { seq: number; state: CharacterSnap } {
    return {
      seq: this.rev,
      state: { character: this.character, zone: this.zone, level: this.level, loc: this.loc }
    }
  }

  flushDelta(): { seq: number; delta: CharacterDelta } | null {
    if (Object.keys(this.pending).length === 0) return null
    const delta = this.pending
    this.pending = {}
    return { seq: this.rev, delta }
  }
}
