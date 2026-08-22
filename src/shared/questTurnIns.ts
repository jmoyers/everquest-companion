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
// AND THE FLOORS THIS LEDGER DOES NOT SEE (issue #27, then JOS-429): the Sky tab's DISPLAYED count
// is decided in two stages. This module resolves the persisted + detected evidence; the renderer
// then floors a quest at one on DERIVED evidence, on every read, never written back here. Two
// stated consequences: any OTHER consumer of this ledger reads the un-floored count and may say
// "not turned in" where the Sky tab says "Turned in"; and the downgrade mirror never contains a
// derived completion, so an older build shows those quests un-done — both are the price of keeping
// derived evidence out of the persisted record, paid on purpose.
//
// THE LADDER THOSE FLOORS SIT ON IS DEFINED HERE, at the bottom of this file
// (`DERIVED_EVIDENCE_RANK` / `derivedCompletion`), because the moment there were TWO of them the
// question "which one gets to speak" stopped being either renderer module's business. It is the
// classUnlocks.ts evidence model applied to completions: OBSERVED WINS, DERIVED IS LABELLED, and
// among derived sources the one closer to an ANSWER outranks the one closer to an inference.
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

// ============================================================================
// THE DERIVED-EVIDENCE LADDER (JOS-429) — which source gets to speak, and what it is called.
// ============================================================================
//
// The ledger above is EVENTS: a turn-in the log printed, a turn-in the user stated, a legacy
// completion. Everything below is the other kind of knowledge — a completion nobody recorded that
// something else nonetheless CLAIMS — and there are three of them now, which is why the ordering is
// a shared rule instead of an if-statement in whichever module happened to run second. "Claims"
// rather than "proves" since JOS-441: one of the three deliberately proves nothing about the quest
// it names, and the ladder is where that is written down.
//
// THE ORDER, AND THE ARGUMENT FOR IT. `classUnlocks.ts` states the model this borrows: a turn-in is
// evidence of PROGRESS, the achievement line is evidence of the ANSWER. That distinction is exactly
// what separates the derived sources here.
//
//   'achievement'  THE SERVER'S OWN ANSWER ABOUT THIS QUEST. `/outputfile achievements` carries one
//                  row per Sky quest reward and a status the SERVER decided; `C` means it has
//                  already ruled that you obtained that reward. Nothing about a bag, a trade or a
//                  wiki page can make that reading wrong, and it keeps being true after the item is
//                  destroyed, sold or left in a bank the export never opened.
//   'reward'       AN INFERENCE FROM POSSESSION (issue #27) — the reward is in your inventory
//                  export and it cannot be obtained any other way. Sound, and gated hard
//                  (rewardInference.ts refuses the two rewards that can move), but still a
//                  conclusion this app drew from a bag rather than an answer the game gave.
//   'class-unlock' THE SERVER'S ANSWER TO A DIFFERENT QUESTION (JOS-441). The same `C`, on the same
//                  kind of row, under a class whose unlock the file itself says was GRANTED — by
//                  confirming your primary class, or by spending a Primary Class Unlock Token. The
//                  server cascaded that grant down into every component, so the row answers "is this
//                  class unlocked", not "did you run this quest". IT NEVER FLOORS A COMPLETION.
//
// THE THIRD RUNG IS A RUNG AND NOT A FILTER, by owner ruling 2026-08-21: class-unlock evidence and
// per-quest evidence are SEPARATELY TRACKED KINDS, each stored and labelled as itself. Dropping the
// cascaded rows at parse time would fix the count and lose the fact — and the fact is what a player
// staring at a quest they know they never ran actually needs to be told. So it is carried all the
// way to the badge and shown as what it is, with the completion it does not prove withheld.
//
// WHY THE ORDER IS OBSERVABLE AT ALL, given that the two flooring rungs floor the count at exactly 1:
// the LABEL differs, and the label is what the badge SAYS — since JOS-441 at badge level, not only
// in a hover. A reader who cannot tell "the game says so" from "we worked it out from your bag"
// cannot tell which rows to trust — the same reason classUnlocks.ts labels its derived rows.
//
// THEY DO NOT ADD. Two sources vouching for one quest are two witnesses to the SAME turn-in, not
// two turn-ins: the reward in the bag is the reward the achievement is about. `max(ledger, 1)` is
// the best LOWER BOUND either can prove, which is the identical move reconcile.ts makes for held
// counts and rewardInference.ts already made for one witness.
//
// AND THE LEDGER STILL WINS OUTRIGHT. Any recorded evidence at all leaves the row exactly as the
// ledger said it — count and label both — because a derived floor can only ever say "at least
// once", and the ledger may already know it happened four times.

/** A derived evidence source, named. Ordered by authority in `DERIVED_EVIDENCE_RANK`. */
export type DerivedEvidence = 'achievement' | 'reward' | 'class-unlock'

/**
 * The ladder, MOST AUTHORITATIVE FIRST. Exported as the order itself rather than as a comparator
 * so a test can assert the ranking directly and a new source cannot be added without choosing a
 * rung for it.
 *
 * `'class-unlock'` is LAST rather than absent: it is the weakest thing any source here says, but it
 * still speaks, and where a stronger rung also vouches for the quest that stronger rung is the one
 * the row should be labelled with.
 */
export const DERIVED_EVIDENCE_RANK: readonly DerivedEvidence[] = [
  'achievement',
  'reward',
  'class-unlock'
]

/**
 * WHICH RUNGS MAY FLOOR A QUEST AT ONE TURN-IN — the JOS-441 split, as a total table so a rung
 * cannot be added without answering the question.
 *
 * `'class-unlock'` is `false` and that single `false` IS the fix: the cascaded `C` under a granted
 * class unlock is real evidence about the unlock and no evidence at all about the quest, so it is
 * tracked, labelled and shown while proving nothing. Everything else here proves at least one
 * turn-in of the quest it names.
 */
export const DERIVED_EVIDENCE_FLOORS: Record<DerivedEvidence, boolean> = {
  achievement: true,
  reward: true,
  'class-unlock': false
}

/** One source's verdict: which quest keys it vouches for, under its own name. */
export interface DerivedCompletionSource {
  evidence: DerivedEvidence
  /** quest keys this source speaks about — proof of a turn-in only if its rung floors */
  vouched: ReadonlySet<string>
}

/**
 * WHICH derived source speaks for this quest AT ALL, or null when none does — flooring or not.
 *
 * Callers apply it ONLY where the ledger said nothing (`ledgerCount === 0`); this function
 * deliberately does not take the ledger, so it cannot be the place someone quietly teaches derived
 * evidence to override a recorded event.
 *
 * The sources may arrive in any order — the rank decides, not the array — which is what stops the
 * answer from depending on the order a hook happens to memoize things in.
 */
export function derivedEvidence(
  key: string,
  sources: readonly DerivedCompletionSource[]
): DerivedEvidence | null {
  for (const evidence of DERIVED_EVIDENCE_RANK) {
    if (sources.some((s) => s.evidence === evidence && s.vouched.has(key))) return evidence
  }
  return null
}

/**
 * WHICH derived source may FLOOR this quest's count at one, or null when none may.
 *
 * The narrowing of `derivedEvidence` to the rungs `DERIVED_EVIDENCE_FLOORS` admits, kept as its own
 * exported function because "what does this row say" and "what may this row change" became two
 * questions the moment a rung answered them differently (JOS-441).
 */
export function derivedCompletion(
  key: string,
  sources: readonly DerivedCompletionSource[]
): DerivedEvidence | null {
  const evidence = derivedEvidence(
    key,
    sources.filter((s) => DERIVED_EVIDENCE_FLOORS[s.evidence])
  )
  return evidence
}
