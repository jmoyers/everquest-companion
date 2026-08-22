// shared/progressState.ts — THE PERSISTED PER-CHARACTER RECORD, and the two hand-made statements
// that hang off it.
//
// SPLIT OUT OF shared/types.ts (JOS-286), which had reached the measured 400-code-line ceiling.
// The repo law for that is a SPLIT rather than a widened threshold, and this is the cut with the
// clearest seam in the file: everything here describes ONE thing — what
// `everquest-companion-progress.json` holds for one character — and it is the only block in
// types.ts that four other modules already reach past this file to complete (./classCombo,
// ./outputs/baseline, ./planner/types, ./planner/gearSet each own one of its fields shapes).
//
// EVERY NAME IS RE-EXPORTED FROM shared/types.ts, so this is a move and not an API change: no
// importer anywhere had to be touched, and `import type { ProgressState } from '../shared/types'`
// keeps working exactly as it did. Import from here when you want only the store shape.
//
// TYPE-ONLY THROUGHOUT, so the imports below are erased at compile time and this file adds no
// runtime dependency to anything that reads it.

import type { ComboProgress } from './classCombo'
import type { ItemCountOverride } from './itemOverrides'
import type { AchievementsSource, ClassUnlockClaim } from './outputs/achievements'
import type { InventorySource } from './outputs/baseline'
import type { ExaltPlan } from './planner/types'
import type { GearSet } from './planner/gearSet'
import type { WishList } from './planner/wishlist'

/** Held-item counts keyed by lowercased item name. */
export type HeldCounts = Record<string, number>

/**
 * How the app decides which items you "have". A DUMP ADDS AND NEVER SUBTRACTS (JOS-141, owner
 * ruling 2026-08-09): loading one cannot lower any count, because a dump only covers what was
 * OPEN when it was generated and reading its silence as zero deleted banked Sky items. JOS-128
 * briefly made a dump load a BASELINE that reset the model; that is reverted.
 * - 'log'       : count everything the character has ever looted (log parsing). Never consults
 *                 a dump, and therefore CANNOT see an item you destroyed, sold to a vendor or
 *                 handed to another player; "ever looted" is exactly what it says.
 * - 'inventory' : the dump, exactly as written. Never consults the log. The only source that can
 *                 show a deletion, and it does so by ignoring the log rather than by resetting.
 * - 'both'      : `max(log, dump)` per item — whichever witness can vouch for more copies. A
 *                 maximum and not a sum, because the two OVERLAP: an item you looted and still
 *                 hold is in both.
 * - 'rebaseline': THE FOURTH MODE (JOS-186, owner ruling 2026-08-14) — the dump is your STARTING
 *                 POINT and the log is trusted only FORWARD from the instant it was generated.
 *                 Every log line older than the dump is discarded for counting; every drop after
 *                 it adds. This is the one source that can LOWER a count from log evidence, and it
 *                 is opt-in for exactly that reason: it is JOS-128's reverted reset offered as a
 *                 CHOICE rather than imposed as the default, so the banked items a closed bank
 *                 window kept out of the file are the user's own accepted cost, not a surprise.
 * The combination and the turn-in consumption that follows it live in ONE place,
 * renderer/features/inventory/reconcile.ts, which argues all four.
 *
 * THE DEFAULT IS `both` SINCE JOS-294, and it used to be `log` — which meant a player who ran
 * `/outputfile inventory`, and whose dump this app loaded by itself, was counted by a source that
 * reads the file for nothing. The default, the labels the user picks between and the proof that the
 * flip changes NOTHING for an install with no dump all live in
 * renderer/features/inventory/countSource.ts.
 */
export type CountSource = 'log' | 'inventory' | 'both' | 'rebaseline'

/** Persisted user progress (inventory + quest completion). */
export interface ProgressState {
  /** counts from the last inventory dump, keyed lowercased name */
  inventory: HeldCounts
  /**
   * Quest keys (className::name) turned in AT LEAST ONCE. Since JOS-131 this is the DOWNGRADE
   * MIRROR of `questTurnIns` rather than the record itself: it is written whenever the ledger is,
   * carries no count and no instant, and a build that predates JOS-131 still reads it and still
   * shows those quests as turned in. `questTurnIns` is what this build reads.
   */
  completedQuests: string[]
  /**
   * EVERY TURN-IN, AS AN EVENT (JOS-131): quest key → the epoch-ms instants it was turned in,
   * ascending. A Sky quest can be run again, so completion is a count, not a terminal flag, and
   * the count is the length of this list.
   *
   * WHY INSTANTS AND NOT A TALLY. Turn-ins have to be subtractable against an inventory dump,
   * and the dump already reflects every turn-in made BEFORE it was generated (JOS-128's
   * baseline). Only a dated turn-in can be placed on the right side of that line, and only exact
   * instants let the log-detected turn-ins and the persisted ones be MERGED without
   * double-counting the same event (the detected `ts` is stored verbatim, so the union dedupes
   * itself).
   *
   * WHAT IS IN IT. Both kinds: turn-ins detected in the log (`TurnInEvent.ts`, EQ's own clock)
   * and turn-ins the user recorded by hand (`Date.now()` at the click). Detected ones are
   * persisted deliberately, the way the old auto-complete persisted a completion: the log is
   * re-scanned per character epoch and truncated logs happen, and a turn-in the log can no longer
   * show is still a thing that happened.
   *
   * ADDITIVE and OPTIONAL — no schema bump and no migration (the `exaltPlans` precedent). A store
   * without this key reads its counts from `completedQuests`: one turn-in, undated, which is all
   * any reader needs now that consumption is windowed by SOURCE rather than by instant (JOS-141).
   */
  questTurnIns?: Record<string, number[]>
  /** metadata about the last inventory load */
  inventorySource?: InventorySource
  /**
   * THE EARNED CLASS-UNLOCK REWARDS the last `/outputfile achievements` dump vouched for
   * (JOS-429) — `<class, item>` pairs in the GAME's own spelling, the flat artifact taken at the
   * one place the file becomes the model (`loadAchievements`).
   *
   * IT IS NOT A LIST OF TURN-INS AND NEVER BECOMES ONE. Nothing here is written into
   * `questTurnIns` or into its downgrade mirror `completedQuests`: the join against the quest set
   * happens on every read in the renderer, labelled with where it came from
   * (shared/questTurnIns.ts's evidence ladder). Persisting it as a turn-in would forge an event
   * the player never made, would survive the file being corrected, and would hand an older build
   * a completion it has no way to explain.
   *
   * ONLY EARNED ROWS ARE IN IT, structurally. The dump also says which rewards you have NOT
   * obtained, and that is deliberately not stored: `I` is not evidence a quest was never turned
   * in, and a record that cannot express a denial cannot be misread as one (the "a dump adds, it
   * never subtracts" promise `CountSource` above already makes).
   *
   * ADDITIVE and OPTIONAL — no schema bump and no migration, the `exaltPlans` precedent: every
   * reader defaults on a missing key, so a store written by any older build loads unchanged and
   * one written here still opens in a build that predates the achievements reader.
   */
  achievementUnlocks?: ClassUnlockClaim[]
  /** metadata about the last achievements load — the file's mtime and when we read it (JOS-429). */
  achievementsSource?: AchievementsSource
  /**
   * HAND-STATED HELD COUNTS (JOS-186) — the escape hatch for an item the witnesses cannot see the
   * truth about: one destroyed, given away, or otherwise gone in a way no log line and no dump
   * records. One statement per counting key, each carrying the instant it was made, because loot
   * after a statement still counts forward (`shared/itemOverrides.ts` argues the whole model, and
   * `renderer/features/inventory/reconcile.ts` applies it).
   *
   * ADDITIVE and OPTIONAL — no schema bump and no migration, the `exaltPlans` precedent exactly:
   * every reader defaults on a missing key, so a store written by any older build loads unchanged
   * and one written here still opens in a build that predates the override.
   */
  itemOverrides?: ItemCountOverride[]
  /**
   * Class-combo user corrections (docs/plans/class-combo-inference.md § 7). Character-scoped,
   * because a loadout is. This is the ONLY durable combo state: intervals are re-derived from
   * the log on every replay, and persisting them would create a second source of truth that
   * could disagree with the log. Optional so a store written before this key round-trips.
   */
  combo?: ComboProgress
  /**
   * Saved exaltation sets (docs/plans/exaltation-planner.md D4). Character-scoped, like every
   * other key here: a plan is built for one character's loadout.
   *
   * ADDITIVE and OPTIONAL — deliberately no schema bump and no migration. Every reader defaults
   * on a missing key and electron-store rewrites the whole parsed object, so a store written by
   * any older build loads unchanged and a store written here still opens in one that predates
   * the planner (`tests/plannerStore.test.mts` pins both halves).
   */
  exaltPlans?: ExaltPlan[]
  /**
   * Saved GEAR SETS (JOS-286, phase 5 of the gear planner) — named virtual loadouts, one item per
   * equipment cell, each assignment carrying its own tracked plus-state
   * (`shared/planner/gearSet.ts`). Character-scoped for the same reason `exaltPlans` is: a
   * loadout is built for one character.
   *
   * **RETIRED FROM THE UI, KEPT ON DISK (JOS-325, owner ruling 2026-08-13).** The sets SURFACE is
   * gone — the Gear tab is pure search and acquisition planning is the wish list's job (JOS-326) —
   * but this key is not, and the distinction is the whole point. Nothing deletes a set, nothing
   * migrates one away, and no reader has to defend against the key's absence any differently than
   * it did before. A user who built ten loadouts still has ten loadouts in their store file; what
   * they no longer have is a pane that draws them. Removing a feature is the app's call to make,
   * and throwing away the user's own document while doing it is not the same act.
   *
   * SO THE MACHINERY THAT KEEPS THE PROMISE STAYS, and only that: the two interfaces in
   * `shared/planner/gearSet.ts`, main's `sanitizeGearSets` (both directions — a store file is
   * hand-editable and an unvalidated read is a crash waiting for whoever revives this), the
   * `getGearSets`/`setGearSets` store accessors, and the IPC pair behind them. The folds, the
   * totals and the pane went with the surface. `tests/gearSetStore.test.mts` still pins the round
   * trip, which is what makes "untouched on disk" a claim rather than a hope.
   *
   * A SECOND KEY RATHER THAN A FIELD ON `exaltPlans`, deliberately. The two answer different
   * questions — an exaltation set plans which EFFECT to socket where and which donor to farm for
   * it, a gear set plans which ITEM to wear where and at what +N — and they were edited on
   * different tabs by different code. Folding one into the other would have made every exaltation
   * set carry an empty gear plan, and a user who only ever opened one tab would still be writing
   * the other's shape.
   *
   * ADDITIVE and OPTIONAL — no schema bump and no migration, the `exaltPlans` precedent exactly:
   * every reader defaults on a missing key and electron-store rewrites the whole parsed object,
   * so a store written by any older build loads unchanged and one written here still opens in a
   * build that predates the gear planner (`tests/gearSetStore.test.mts` pins both halves).
   */
  gearSets?: GearSet[]
  /**
   * THE FLAT WISH LIST (JOS-326) — the things this character has decided they want, as one flat
   * list of items with no cell, socket or host structure at all
   * (`shared/planner/wishlist.ts`). Character-scoped for the same reason the two keys above are:
   * a wish is something one character wants.
   *
   * A THIRD KEY RATHER THAN A FIELD ON EITHER OF THEM — THE STORE-SEPARATION LAW, RESTATED. The
   * three planner documents answer three different questions, are edited on different tabs by
   * different code, and must be able to be empty independently:
   *   * `exaltPlans` — which EFFECT goes in which socket of which cell, and which donor supplies
   *     it. Still on disk and still served over its own IPC pair after JOS-326 removed the board
   *     that drew it; the wish list's one-time seed is what reads it now.
   *   * `gearSets`   — which ITEM goes in which cell, and at what +N. Retired from the UI in the
   *     same wave (JOS-325) and kept on disk for the reason its own block above argues.
   *   * `wishlist`   — which items are WANTED. No cell, no socket, no host, on an owner ruling:
   *     host targeting is an explicitly later addition, and a wish list that grew a cell map
   *     would be the plan board again under a friendlier name.
   * Folding any one into another would make every document of the host kind carry an empty copy
   * of the guest's shape, and a user who only ever opens one tab would still be writing the
   * other's.
   *
   * ADDITIVE and OPTIONAL — no schema bump and no migration, the `exaltPlans`/`gearSets`
   * precedent exactly: every reader defaults on a missing key and electron-store rewrites the
   * whole parsed object, so a store written by any older build loads unchanged and one written
   * here still opens in a build that predates the wish list (`tests/wishlistStore.test.mts` pins
   * both halves).
   */
  wishlist?: WishList
  /**
   * GROUP-ROSTER user edits (docs/plans/group-model.md §3). Character-scoped, like everything
   * else here. The roster itself is re-derived from the log on every replay; an edit is the one
   * piece of it the log can never tell us again — the member whose join line predates the file,
   * or the ex-member the game never printed a leave line for.
   *
   * TIME-KEYED, for the same reason combo corrections are: the roster module drops any edit
   * older than the epoch boundary or the last self-leave, because both mean the thing the edit
   * described is gone. Additive and optional — every reader defaults on a missing key, so no
   * schema bump and no migration (the `exaltPlans` precedent above).
   */
  rosterEdits?: RosterEdit[]
  /**
   * PET CLAIMS (JOS-47) — RETIRED AND UNREAD SINCE JOS-49. Nothing writes this key and nothing
   * reads it; the accessors that did are gone from src/main/store.ts along with the question
   * they answered ("<Name> — your pet?", cut by the owner: "if you just have to pet attack once,
   * this is a lot of work we can get wrong").
   *
   * IT STAYS ON THE TYPE ON PURPOSE. A v0.4.x user's answers are still in their store file, and
   * deleting them would be destroying that user's own statements to tidy up our types; a
   * migration that dropped the key would make going back to a build that reads them lossy.
   * electron-store rewrites the whole parsed object, so an unread key round-trips for free.
   * Delete it only if the feature is ever ruled out for good and the data is worth nothing.
   */
  petClaims?: PetClaimEdit[]
}

/**
 * ONE hand-made statement about a pet: "this is mine" or "this is not" — the shape of the
 * RETIRED claim store above. Kept only so `ProgressState.petClaims` can go on describing bytes
 * that are already on disk; nothing constructs one any more (JOS-49).
 */
export interface PetClaimEdit {
  /** Canonical identity key — `idKey(name)`. */
  key: string
  /** Display name as the log spelled it. */
  name: string
  /** 'claim' binds it as your pet everywhere; 'deny' means never ask about this name again. */
  action: 'claim' | 'deny'
  /** Wall-clock instant the statement was made — recorded for the reader, never for expiry. */
  setAt: number
}

/**
 * ONE hand-made statement about the group roster: "this person is with me" or "this person is
 * not". The provenance ladder's top rung (shared/roster.ts) — a later log line can neither
 * undo it nor be undone by it; only the opposite edit can.
 */
export interface RosterEdit {
  /** Canonical identity key — `idKey(name)`. */
  key: string
  /** Display name as the user typed it (an add) or as the log spelled it (a remove). */
  name: string
  action: 'add' | 'remove'
  /** Wall-clock instant the edit was made. Compared against the epoch boundary and the last
   *  self-leave to decide whether it still describes anything. */
  setAt: number
}
