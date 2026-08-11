// ============================================================================
// questTurnIns.ts — a Sky turn-in is an EVENT WITH A COUNT, not a terminal state.
// ============================================================================
//
// JOS-131, owner design 2026-08-09. A Sky farmer runs a quest more than once. Before this, a
// completed quest stayed 5/5 forever: the items it ate were subtracted from the model but the
// quest was pinned at complete, so a second copy of the Sphinx Claw you farmed for it was
// invisible. Now a turn-in SUBTRACTS what it consumed and COUNTS ITSELF, so the quest drops back
// to 0/5 and the badge says how many times you have handed it in. Multiple turn-ins are the
// default; nothing has to be enabled.
//
// THE LEDGER IS TWO SOURCES, MERGED BY INSTANT.
//   * DETECTED — the log's own turn-ins (`TurnInEvent.ts`, EQ's clock), re-derived from the
//     turnins module on every launch. The matching rule is unchanged and lives one file over
//     (renderer/features/posky/turnInCelebration.ts): the giver received every required item in
//     ONE trade.
//   * STORED — `ProgressState.questTurnIns`, which holds BOTH the detected instants (persisted,
//     so a truncated log or a character epoch cannot un-complete a quest) and the ones the user
//     recorded by hand.
// The union dedupes on the instant itself, so persisting a detected turn-in and then detecting
// it again is one turn-in, not two. That is the whole reason this is a list of instants rather
// than a tally: a tally forces `max(stored, detected)`, which cannot tell "I turned it in twice"
// from "I turned it in once and we saw it twice".
//   HONEST LIMIT: EQ log timestamps have one-second resolution (outputs/baseline.ts's header
// argues the same point for dumps), so two turn-ins of the SAME quest inside one second merge
// into one. A trade is several deliberate UI actions against an NPC, so this has no realistic
// shape; it is stated rather than hidden.
//
// THE LEGACY FLOOR. A store written before JOS-131 has `completedQuests` and no instants. Such a
// completion is real but UNDATED, so it contributes a FLOOR OF ONE to the count and nothing else.
// `completedQuests` keeps being written as the downgrade mirror (see shared/types.ts).
//
// THERE IS NO "SINCE THE DUMP" COUNT ANY MORE (JOS-141). This file used to report a second count
// — how many turn-ins landed after the loaded dump was generated — because JOS-128 made a dump
// load RESET the held-count model, and a base of `dump + loot since the dump` already had every
// pre-dump turn-in taken out of it. The owner reverted the reset on 2026-08-09 after field-testing
// (a dump only covers what was open when it was written, so resetting to it ate banked Sky items),
// and the window went with it. Consumption is now windowed by SOURCE instead of by instant: the
// log owes every turn-in, a dump owes none, and the whole argument lives at the one place that
// applies it (renderer/features/inventory/reconcile.ts). One count, all time, is all this ledger
// has to answer.

import type { ProgressState } from './types'

/** Quest key → the epoch-ms instants that quest was turned in, ascending and deduped. */
export type TurnInInstants = Record<string, number[]>

/**
 * Most turn-ins one quest key can carry. A guard on renderer-supplied input reaching the store
 * (the `isSafePackId` rule: validate at the boundary, never trust today's only caller), not a
 * statement about the game — the whole Sky set is ~50 quests and nobody hands one in 200 times.
 */
export const MAX_TURN_INS_PER_QUEST = 200

/**
 * Clean one quest's instants: whole non-negative milliseconds, ascending, deduped, capped.
 * Anything else in the slot (a hand-edited store, a bad IPC caller) is dropped rather than
 * throwing the character's whole progress away.
 */
export function sanitizeTurnInInstants(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<number>()
  for (const v of value) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue
    seen.add(Math.floor(v))
  }
  return [...seen].sort((a, b) => a - b).slice(0, MAX_TURN_INS_PER_QUEST)
}

/** Clean a whole ledger, dropping keys left with nothing. */
export function sanitizeTurnInLedger(value: unknown): TurnInInstants {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: TurnInInstants = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const instants = sanitizeTurnInInstants(v)
    if (instants.length > 0) out[key] = instants
  }
  return out
}

/** Union two instant lists — the merge that makes "persisted, then detected again" one event. */
export function mergeTurnInInstants(a: readonly number[], b: readonly number[]): number[] {
  return sanitizeTurnInInstants([...a, ...b])
}

/** The ledger a persisted progress state holds, cleaned. Empty for a null/pre-JOS-131 store. */
export function storedTurnIns(progress: Pick<ProgressState, 'questTurnIns'> | null): TurnInInstants {
  return sanitizeTurnInLedger(progress?.questTurnIns)
}

/** What one quest key's turn-ins are, once the log and the store agree. */
export interface QuestTurnIns {
  /** key → every instant either source knows, merged */
  instants: TurnInInstants
  /** key → how many times it has been turned in, all time (a legacy completion floors this at 1) */
  all: Record<string, number>
}

/**
 * THE one place a turn-in count is decided. Merges the log's detected instants with the persisted
 * ones and floors the count at 1 for a legacy `completedQuests` entry.
 *
 * `detected` is keyed the same way everything else here is: the canonical `Class::Name` quest key.
 */
export function resolveTurnIns(
  progress: Pick<ProgressState, 'questTurnIns' | 'completedQuests'> | null,
  detected: TurnInInstants
): QuestTurnIns {
  const stored = storedTurnIns(progress)
  const legacy = new Set(progress?.completedQuests ?? [])
  const instants: TurnInInstants = {}
  for (const key of new Set([...Object.keys(stored), ...Object.keys(detected)])) {
    instants[key] = mergeTurnInInstants(stored[key] ?? [], detected[key] ?? [])
  }

  const all: Record<string, number> = {}
  for (const key of new Set([...Object.keys(instants), ...legacy])) {
    // The legacy floor: a pre-JOS-131 completion is one real turn-in with no instant attached.
    all[key] = Math.max((instants[key] ?? []).length, legacy.has(key) ? 1 : 0)
  }
  return { instants, all }
}

/**
 * What the auto-detect effect has to persist: the keys whose merged instants say more than the
 * store does. Returns nothing when the store is already complete, which is what stops the
 * write → push → re-derive loop from running forever.
 */
export function turnInsToPersist(
  progress: Pick<ProgressState, 'questTurnIns' | 'completedQuests'> | null,
  merged: TurnInInstants
): { key: string; instants: number[] }[] {
  const stored = storedTurnIns(progress)
  const out: { key: string; instants: number[] }[] = []
  for (const [key, instants] of Object.entries(merged)) {
    const have = stored[key] ?? []
    if (instants.length > have.length) out.push({ key, instants })
  }
  return out
}

/**
 * State one quest's turn-ins, as the two persisted keys.
 *
 * The list is SANITIZED here because this is where a renderer-supplied value becomes persisted
 * state, and `completedQuests` is written in step as the DOWNGRADE MIRROR: a build that predates
 * JOS-131 reads only that key, so a quest with turn-ins has to be in it and a quest whose last
 * turn-in was just taken back has to be out of it. Pure, so main's store is three lines and the
 * rule is testable without electron-store.
 */
export function applyTurnIns(
  progress: Pick<ProgressState, 'questTurnIns' | 'completedQuests'>,
  key: string,
  instants: number[]
): Pick<ProgressState, 'questTurnIns' | 'completedQuests'> {
  const clean = sanitizeTurnInInstants(instants)
  const ledger: TurnInInstants = {}
  for (const [k, v] of Object.entries(sanitizeTurnInLedger(progress.questTurnIns))) {
    if (k !== key) ledger[k] = v
  }
  if (clean.length > 0) ledger[key] = clean
  const completed = new Set(progress.completedQuests)
  if (clean.length > 0) completed.add(key)
  else completed.delete(key)
  return { questTurnIns: ledger, completedQuests: [...completed] }
}

/** How the badge says it: "Turned in" once, "Turned in x3" after that. Never for a count of 0. */
export function turnInBadgeLabel(count: number): string {
  return count > 1 ? `Turned in x${String(count)}` : 'Turned in'
}
