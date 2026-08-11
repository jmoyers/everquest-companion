// The classUnlocks module's wire types (JOS-148), in their own file for the reason `kills.ts` is
// in its own file: shared/types.ts sits at the 400-line factoring budget, and a module's record
// plus its snapshot and delta is one subject that reads better beside its own argument than as
// three more entries in a list. types.ts re-exports them, so no consumer's import moves.
//
// WHY THE LEDGER IS A LIST OF INSTANTS AND NOT A SET OF NAMES. A class unlock is a thing that
// HAPPENED, and when it happened is what tells a reader whether the answer predates the turn-ins
// it is sitting beside — the owner's Paladin unlocked at level 11, days before his first Sky
// turn-in, and a bare set could not say that. It is also the shape loot and turn-ins already use,
// so the renderer's delta fold is the same three words.

/**
 * A class the LOG said outright had unlocked — `You have completed achievement: Primary Class
 * Unlock - <Class>`. The class name is carried as the CLIENT spelled it; matching it to the Sky
 * catalog's spelling happens at the read boundary, case-insensitively (world-model law 2:
 * canonicalize at boundaries, display raw).
 */
export interface ClassUnlockRecord {
  ts: number
  className: string
}

/** classUnlocks module. Delta = unlocks appended since the last flush. */
export type ClassUnlockSnap = ClassUnlockRecord[]
export interface ClassUnlockDelta {
  appended: ClassUnlockRecord[]
}
