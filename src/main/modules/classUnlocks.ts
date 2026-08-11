// classUnlocks module (JOS-148) — the classes this character may run as a primary, as the LOG
// stated them, in the order it stated them.
//
// It is the smallest module in the tree on purpose: one event kind in, an append-only list out.
// There is no resolution to do, because there is nothing to resolve — `classUnlock` is the one
// line in EQ Legends that answers the question outright, and world-model law 1 says a message
// beats an inference. The Plane of Sky tab derives the OTHER half (how many of a class's tests
// you have turned in) from the JOS-131 ledger, and composes the two at the read boundary.
//
// DEDUPED BY CLASS, first sighting wins. The achievement can only fire once per class per
// character, so a second row for the same class would mean a re-scan re-read the same line
// rather than a second unlock. Keeping the FIRST instant is what makes the timestamp worth
// carrying: it dates the unlock, not the last time the app happened to read the log.
//
// EPOCH RESETS IT, exactly as the turn-in ledger is reset (Task #49). A pre-launch beta
// character's unlocks belong to a dead character that shares this log file, and reporting them
// against the current one is the same contamination that made the AA tallies wrong. The owner's
// own unlock lands on the right side of the boundary anyway (Jul 28 15:51, hours after the
// launch anchor), so the reset costs nothing real and refuses the case it exists for.

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import type { ClassUnlockDelta, ClassUnlockRecord, ClassUnlockSnap } from '../../shared/types'

export class ClassUnlocksModule implements EqModule<ClassUnlockSnap, ClassUnlockDelta> {
  readonly id = 'classUnlocks'
  private unlocks: ClassUnlockRecord[] = []
  /** lowercased class names already recorded — the dedupe key (law 2: keys are case-folded). */
  private seen = new Set<string>()
  private seq = 0
  private pending: ClassUnlockRecord[] = []

  reset(): void {
    this.unlocks = []
    this.seen = new Set()
    this.seq = 0
    this.pending = []
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    if (ev.kind === 'epoch') {
      this.unlocks = []
      this.seen = new Set()
      this.pending = []
      return
    }
    if (ev.kind !== 'classUnlock') return
    const key = ev.className.toLowerCase()
    if (this.seen.has(key)) return
    this.seen.add(key)
    const rec: ClassUnlockRecord = { ts: ev.ts, className: ev.className }
    this.unlocks.push(rec)
    this.pending.push(rec)
  }

  snapshot(): { seq: number; state: ClassUnlockSnap } {
    return { seq: this.seq, state: this.unlocks }
  }

  flushDelta(): { seq: number; delta: ClassUnlockDelta } | null {
    if (this.pending.length === 0) return null
    const delta: ClassUnlockDelta = { appended: this.pending }
    this.pending = []
    return { seq: this.seq, delta }
  }
}
