import type { CountSource, ItemCountOverride, PoskyQuest } from '@shared/types'
import type { TurnInInstants } from '@shared/questTurnIns'
import { itemCountKey } from '../../lib/itemName'
import { questKey } from '../posky/keys'

export interface InventoryRow {
  key: string
  name: string
  /**
   * What the LOG says you hold: everything looted, less everything destroyed (JOS-401 — the fold
   * is `computeHeldCounts`). It was "times looted" until the destroy line was parsed; the field is
   * still the log's whole answer for this item, which is what every reader uses it as.
   */
  log: number
  /** count in the inventory export */
  inv: number
  /** base held per the active count source, before turn-ins */
  base: number
  /**
   * What the turn-ins ACTUALLY took off this row, which is `base - net` and not the gross
   * `required x times` (JOS-141). Zero when the dump answered this row: a dump already reflects
   * every turn-in, so nothing was taken off it. The rule is argued on `netCount` below.
   */
  consumed: number
  /** net available after turn-ins. Always `base - consumed`. */
  net: number
  /** names of the quests whose turn-ins consumed this item, a quest run twice reading "… x2".
   *  Empty whenever `consumed` is 0, so it never blames a quest for a subtraction that did not
   *  happen. */
  consumedBy: string[]
  /**
   * The HAND-STATED count in force for this row, when there is one (JOS-186). Present means the
   * user told us what they hold and `base`/`net` are built from that statement plus everything
   * looted since it — so a surface drawing this row can say the number is theirs, and say when.
   * Absent is the ordinary case: nobody has stated anything about this item.
   */
  override?: ItemCountOverride
}

export interface ReconcileInput {
  /** loot counts keyed by lowercased item name */
  log: Record<string, number>
  /** inventory-export counts keyed by lowercased item name */
  inv: Record<string, number>
  /** display names keyed by lowercased item name (from loot events) */
  lootNames: Record<string, string>
  countSource: CountSource
  /**
   * HOW MANY TIMES each quest has been turned in, all time (JOS-131) — quest key → count. A Sky
   * quest can be run again, so this is a count and not a completed-set: a quest handed in twice
   * ate its items twice. Absent/0 means never turned in.
   */
  turnIns: Record<string, number>
  quests: PoskyQuest[]
  /**
   * THE TURN-IN LEDGER'S OWN INSTANTS (JOS-131's list, not its tally). Read only by the two
   * windowed sources below, which have to ask how many of a quest's turn-ins happened AFTER a
   * baseline; `turnIns` above stays the all-time count every other path uses. Absent means no
   * window can be computed, and both windowed paths degrade rather than guess.
   */
  turnInInstants?: TurnInInstants
  /** JOS-186 — the hand-stated held counts in force, by counting key. */
  overrides?: Record<string, ItemCountOverride>
  /**
   * JOS-186 — loot folded per counting key counting ONLY drops after that key's statement
   * (`computeHeldCountsAfterPerKey`). A key with no statement is absent from both maps.
   */
  lootSinceOverride?: Record<string, number>
  /**
   * JOS-186 — the instant the loaded dump was GENERATED, or null when nothing can anchor a
   * rebaseline (no dump, or a dump whose age this app could not establish).
   *
   * READ UNDER EVERY SOURCE THAT CONSULTS THE DUMP, not just `rebaseline` (JOS-403). It started as
   * the rebaseline anchor and it is now simply THE DUMP'S INSTANT: `inventory` and `both` read the
   * file as a witness too, so they need to know when it was written in order to tell a turn-in the
   * file already reflects from one made after it. Null keeps every dump-reading source undiscounted
   * — `rebaseline` then behaves exactly as `both`, and the two windowed discounts (destroys,
   * turn-ins) simply do not apply. The field name is unchanged on purpose: it is `useProgress`'s
   * prop and one rename would be the whole diff.
   */
  rebaselineAt?: number | null
  /**
   * JOS-186 — loot folded counting ONLY drops after `rebaselineAt` (`computeHeldCountsAfter`).
   *
   * READ UNDER `both` TOO SINCE JOS-409, for the same reason `rebaselineAt` itself outgrew its name:
   * this is not "the rebaseline baseline's loot", it is THE LOOT THE DUMP DID NOT SEE, and a witness
   * that is about to be discounted by post-dump destroys and post-dump turn-ins has to be credited
   * with the post-dump ACQUISITIONS in the same window or it is being charged for a period it is not
   * allowed to earn in. `inventory` still ignores it (that mode is literally "as dumped", and its
   * label says so); `log` never reads the file at all. The name stays for the reason above.
   */
  lootSinceRebaseline?: Record<string, number>
  /**
   * THE LOG-DETECTED SUBSET OF `turnInInstants` — the only instants allowed to window the DUMP
   * (JOS-409).
   *
   * A turn-in instant comes from one of two places (useProgress.useTurnInLedger): the LOG, where it
   * is the stamp on the line the game printed, and the hand counter, where it is `Date.now()` at the
   * moment the user clicked. Only the first is an EVENT time. The second is a click time, and a
   * player recording on Friday a hand-in they made on Tuesday would have that Friday instant
   * compared against the dump's Wednesday stamp and the dump discounted for a turn-in it already
   * reflects — the double-subtraction JOS-141 exists to prevent, arriving by the back door JOS-403
   * opened.
   *
   * So the dump-anchored window reads THIS list, and `turnInInstants` keeps every other job it has
   * (the all-time tally's list, and the per-statement windows — a hand statement's `setAt` is a
   * click time too, so comparing two click times there is comparing like with like).
   *
   * ABSENT MEANS "no provenance was stated", which falls back to `turnInInstants` and is exactly the
   * pre-JOS-409 contract — so every caller that has not been taught the difference reads what it
   * always did, and the additivity proof in tests/skyItemOverrides.test.mts stays literal.
   */
  detectedTurnInInstants?: TurnInInstants
  /**
   * JOS-401 — what the log says you DESTROYED after the dump was generated
   * (`computeDestroyedAfter`), by counting key. Read under EVERY source that consults the dump,
   * not just `rebaseline`: 'inventory' and 'both' read the file as a witness too, and a destroy
   * stamped after it makes that witness stale by exactly this much. Absent (or an undatable dump)
   * means no discount — never a guessed one.
   */
  destroyedSinceDump?: Record<string, number>
  /** JOS-401 — the same discount per key, after each key's own hand statement. */
  destroyedSinceOverride?: Record<string, number>
}

export interface ReconcileResult {
  rows: InventoryRow[]
  /** net held counts (base minus turn-in consumption), keyed lowercased */
  net: Record<string, number>
}

/**
 * Re-key the inventory-export counts onto the normalized counting key so a
 * `Sphinx Claw +1` in the export pools with a base `Sphinx Claw` (Task #42). The
 * `log` map arrives already normalized (useProgress.logCounts), but the raw
 * inventory export names do not, so fold them here (summing collisions).
 *
 * `nameByKey` is filled in place — display names are claimed first-writer-wins, and
 * the call order in `reconcile` (loot names, then export names, then quest item
 * names) is what decides which spelling the user sees.
 */
function foldInventoryByKey(
  inv: Record<string, number>,
  nameByKey: Record<string, string>
): Record<string, number> {
  const invByKey: Record<string, number> = {}
  for (const [rawK, n] of Object.entries(inv)) {
    const k = itemCountKey(rawK)
    invByKey[k] = (invByKey[k] ?? 0) + n
    nameByKey[k] ??= rawK
  }
  return invByKey
}

/**
 * ONE ITEM'S WITNESSES — everything any source could read about a single counting key, gathered
 * before anything decides which of them answers.
 *
 * The two optional members are the WINDOWED witnesses (JOS-186). Each is a baseline (a count
 * somebody vouched for at an instant, plus everything the log has seen drop since) paired with the
 * turn-in consumption owed since that same instant — so each is a complete little world with the
 * same shape as the all-time pair above it, and `witnessNet` never has to mix a windowed base with
 * an all-time subtraction.
 */
interface Witnesses {
  /** all-time looted, NET of every destroy the log recorded (`computeHeldCounts`) */
  log: number
  /** the dump, as written */
  inv: number
  /** what every turn-in ever recorded ate of this item */
  consumed: number
  /**
   * What the log says you DESTROYED after the dump was generated (JOS-401). Zero when nothing can
   * date the dump — the same degradation `rebaseline` makes, and for the same reason: a window
   * with no instant is not a window, and guessing one would discount a witness by destroys that
   * may well predate it.
   */
  invDestroyed: number
  /**
   * What the turn-ins recorded strictly AFTER the dump's instant ate of this item (JOS-403). Zero
   * when nothing can date the dump, for the same reason `invDestroyed` is: a window with no instant
   * is not a window. It sits BESIDE the base rather than inside it (see `witnessNet`), because a
   * turn-in is a subtraction the ledger owns and reports on the row — the row's `consumed` has to be
   * able to name the quest that took the copy.
   */
  invConsumed: number
  /**
   * What the log has seen DROP since the dump was generated (JOS-409) — the dump witness's own
   * forward credit, in the same window as the two discounts above it.
   *
   * Zero under every source but `both`, and zero there too when nothing can date the dump: gated at
   * the input (`reconcile`), so every reader below can simply add it. `rebaseline` carries the same
   * number inside its own baseline and does not read this field.
   */
  invSince: number
  /** the dump-anchored baseline, present only under `rebaseline` with an instant to anchor to */
  rebaseline?: { base: number; consumed: number }
  /** the hand-stated baseline, present only where the user has stated this item's count */
  override?: { statement: ItemCountOverride; base: number; consumed: number }
}

/**
 * The DUMP witness, discounted by the destroys the log recorded after it (JOS-401).
 *
 * `since` is the loot that landed after the same instant, which is 0 for every source but
 * `rebaseline` — so this one expression is both "the dump, less what you destroyed since" and
 * "the dump plus what dropped since, less what you destroyed since". Floored, because a destroy
 * of a stack the dump never saw (a bank window that was shut) must not drive the row negative.
 */
function dumpWitness(inv: number, since: number, destroyed: number): number {
  return Math.max(0, inv + since - destroyed)
}

/**
 * THE DUMP WITNESS'S BASE — the file, plus what dropped since it was written, less what was
 * destroyed since it was written (JOS-409).
 *
 * `w.invSince` is 0 for every source but `both` (gated at the input, see `reconcile`), so this one
 * expression is still "the dump, less what you destroyed since" for `inventory` and is now the full
 * windowed reading for `both`. The whole of JOS-409's first part is that `+ w.invSince`.
 */
function dumpBase(w: Witnesses): number {
  return dumpWitness(w.inv, w.invSince, w.invDestroyed)
}

/**
 * The dump witness NET of the turn-ins recorded after the dump was generated (JOS-403) — the whole
 * of `max(0, D + l_after - d_after - c_after)`, which is what `inventory` answers (with `l_after`
 * pinned to 0) and what `both` maxes against the log.
 *
 * It is a SECOND expression rather than another argument to `dumpWitness` because the two callers
 * want different halves of it: the row's `base` is the dump discounted by destroys only (a destroy
 * is a subtraction the WITNESS owes — the number the file printed was already wrong), and the row's
 * `net` is that less the turn-ins, so `consumed = base - net` stays the ledger's own answer. The
 * `rebaseline` witness is built the same way for the same reason and keeps its two fields.
 */
function dumpNet(w: Witnesses): number {
  return Math.max(0, dumpBase(w) - w.invConsumed)
}

/**
 * Base held count for one key, per the active count source.
 *
 * ============================================================================
 * A DUMP ADDS, IT NEVER SUBTRACTS (JOS-141, owner ruling 2026-08-09).
 * ============================================================================
 *
 * JOS-128 made a loaded dump the BASELINE: it reset the model to what the dump said and let the
 * log accumulate from the generation instant forward. Field-testing Plane of Sky the same day
 * killed it. An `/outputfile inventory` dump only covers WHAT WAS OPEN WHEN IT WAS GENERATED —
 * the bank only if the bank window was up, the hoard likewise (the JOS-132 spike measured this,
 * and shared/outputs/baseline.ts carries the evidence) — and the file never says which storages
 * it spoke for. A reset reads all that silence as zero, so a routine reload made banked Sky items
 * disappear from quests the player was actually ready to hand in.
 *
 * So the combination is FULLY ADDITIVE again, and this is the whole rule:
 *   'log'       all-time looted. Never consults the dump.
 *   'inventory' the dump, exactly as written. Never consults the log.
 *   'both'      `max(log, dump)` per item — whichever source can vouch for more copies.
 *
 * A maximum rather than a sum because the two sources OVERLAP: an item you looted and still have
 * is in both, and adding them would double it. Max is the additive answer for overlapping
 * witnesses — each source is a lower bound on what you hold, and the count is the best lower
 * bound anyone can prove.
 *
 * THE COST THAT USED TO BE ACCEPTED HERE, AND THE HALF OF IT THAT WAS NEVER TRUE (JOS-401).
 *
 * This paragraph read: "a deletion is INVISIBLE … because the log records the loot and never
 * records the destruction (there is no such line — world-model law 6)". The first clause was a
 * real trade-off; the second clause was WRONG, and it was wrong in the file that decides what the
 * app counts. The line exists — `You successfully destroyed <N> <Item>.`, 356 of them in the
 * owner's live log, four in a committed fixture the parser sweep had already read — and it was
 * simply not parsed, because the sweep that catalogued it was asking about item TIERS, which it
 * genuinely retires nothing of. So the app inherited "the log cannot see a destroy" from an
 * argument that was never about held counts, and shipped a button asking the player to state by
 * hand a fact the log had been stating all along.
 *
 * WHAT IS TRUE NOW: the log states destroys, and this module subtracts them — each witness
 * discounted by the destroys recorded strictly AFTER its own instant, which is the JOS-186 rule
 * below applied to a second kind of subtraction. The all-time log witness owes every destroy ever
 * recorded (`computeHeldCounts` nets them in the fold). The dump owes those recorded after it was
 * generated. A hand statement owes those recorded after it was made.
 *
 * WHAT IS STILL TRUE: a dump that OMITS an item still cannot be told apart from a dump that never
 * looked, so the combination stays fully ADDITIVE — the 2026-08-09 ruling is untouched, and a
 * destroy is an explicit subtraction the log stated, never an inference from silence. And the
 * off-camera losses the log genuinely cannot see (a trade, a bank deposit into a window the dump
 * never opened) are still invisible, still by design, and still what the pencil override is for.
 *
 * ONE SEMANTICS CHANGE THE OWNER SHOULD KNOW ABOUT: 'inventory' used to mean "the dump, exactly as
 * written" and now means "the dump, less what you have destroyed since it was written". It is
 * argued as the owner's own ask (JOS-401 verbatim: destroy shows up in the log, so why are we
 * asking); if he wants that mode literal again, it is the `dumpWitness` call in `witnessBase` and
 * `witnessNet` and nothing else.
 *
 * AND SINCE JOS-403 IT IS ALSO "LESS WHAT YOU HANDED IN SINCE IT WAS WRITTEN" — the same window,
 * the same instant, the other kind of subtraction. That half is stated where it belongs, beside
 * `consumed` in the turn-in block below, because a turn-in is a subtraction the LEDGER owns and the
 * row has to be able to name the quest.
 *
 * AND SINCE JOS-409 THE `both` DUMP READING IS ALSO "PLUS WHAT DROPPED SINCE IT WAS WRITTEN" — the
 * same window again, the credit side of it. `inventory` is deliberately NOT given that term: its
 * label is "Export only (as dumped)" and it stays literal. The argument is in the turn-in block
 * below, under the heading about earning in the window you pay in.
 *
 * ============================================================================
 * AND SINCE JOS-186 THERE ARE TWO WAYS TO SAY "NO, IT IS GONE" — BOTH OPT-IN.
 * ============================================================================
 *
 * The paragraph above is not softened: it is still the rule for the three sources it was written
 * for, and it is still the DEFAULT behaviour. What the owner's 2026-08-14 ruling adds is that the
 * accepted cost now has a way out, and that the way out is always something the USER asked for.
 *
 *   'rebaseline' the dump is the STARTING POINT and the log counts only FORWARD from the instant
 *                the dump was generated: `dump + looted since`. Every log line older than the file
 *                is discarded. This IS JOS-128's reverted reset — offered as a fourth option
 *                instead of imposed as the default, which is the entire difference. Its cost is
 *                the one field-testing found: a dump only covers what was OPEN when it was
 *                written, so a banked item the file never saw reads zero until you loot another.
 *                With nothing to anchor it (no dump, or no generation instant), it falls back to
 *                `both` — never to a baseline of zero, which would be that cost with none of the
 *                consent.
 *   an OVERRIDE  a hand-stated count for ONE item, which wins over whichever source is selected.
 *                Same forward rule at item scale: the statement plus everything looted since it
 *                (shared/itemOverrides.ts argues why a pin would rot).
 */
function witnessBase(w: Witnesses, countSource: CountSource): number {
  if (w.override) return w.override.base
  if (countSource === 'log') return w.log
  const dump = dumpBase(w)
  if (countSource === 'inventory') return dump
  if (countSource === 'rebaseline' && w.rebaseline) return w.rebaseline.base
  return Math.max(w.log, dump)
}

/**
 * What the turn-ins ate: counts per item key, plus the quest names that ate it.
 *
 * A quest turned in N times consumed N of everything it requires (JOS-131) — that is the whole
 * mechanism behind "hand it in and the quest drops back to 0/5, ready to farm again". The
 * `consumedBy` caption says the count too, so a row reading `-10 Sphinx Claw` can be traced to
 * one quest run twice rather than looking like a bug.
 *
 * HOW MANY TIMES IS A PARAMETER SINCE JOS-186, because a windowed base owes only the turn-ins made
 * after it: `timesAfter` answers the same question over the ledger's instants instead of its tally.
 * The all-time caller passes the tally and reads exactly what it always did.
 */
function questConsumption(quests: PoskyQuest[], times: (key: string) => number): Consumption {
  const consumed: Record<string, number> = {}
  const consumedBy: Record<string, string[]> = {}
  for (const q of quests) {
    const count = times(questKey(q))
    if (count <= 0) continue
    for (const it of q.items) {
      const k = itemCountKey(it.name)
      const need = it.count > 0 ? it.count : 1
      consumed[k] = (consumed[k] ?? 0) + need * count
      ;(consumedBy[k] ??= []).push(count > 1 ? `${q.name} x${String(count)}` : q.name)
    }
  }
  return { consumed, consumedBy }
}

/** What one pass of `questConsumption` produces: the counts, and who to blame for each. */
interface Consumption {
  consumed: Record<string, number>
  consumedBy: Record<string, string[]>
}

/** How many of a quest's turn-ins happened strictly after an instant (JOS-186's window). An
 *  undated legacy completion contributes none, which is right: it predates any statement made now. */
function timesAfter(instants: TurnInInstants, at: number): (key: string) => number {
  return (key) => (instants[key] ?? []).filter((ts) => ts > at).length
}

/**
 * Consumption windowed to an instant, MEMOIZED per instant — every hand-stated count carries its
 * own `setAt`, and a rebaseline carries the dump's, so the distinct instants are few and each one
 * costs a single pass over the quest set.
 */
function windowedConsumption(
  quests: PoskyQuest[],
  instants: TurnInInstants
): (at: number) => Consumption {
  const cache = new Map<number, Consumption>()
  return (at: number): Consumption => {
    let hit = cache.get(at)
    if (!hit) {
      hit = questConsumption(quests, timesAfter(instants, at))
      cache.set(at, hit)
    }
    return hit
  }
}

/**
 * The game's own spelling for every Sky quest item, keyed by counting key — the display name of
 * LAST resort before the export's key, and the reason a dump-only row reads `Ivory Sky Diamond`
 * rather than `ivory sky diamond` (JOS-160).
 *
 * AN EXPORT KEY IS A KEY, NOT A SPELLING. `heldCountsFromDump` lowercases every name it folds
 * (shared/outputs/inventory.ts — the key is documented as the raw name LOWERCASED), so the
 * `nameByKey[k] ??= rawK` fallback below was never showing "the export spelling" it reads like: it
 * was showing a lookup key with the capitals rubbed off. That went unnoticed while inventory-only
 * rows were an opt-in tail nobody could search; JOS-160 puts one in a search result and on the item
 * page's breadcrumb, where a lowercased name is simply wrong.
 *
 * It sits BELOW loot names (a loot line carries the game's spelling verbatim, and it is the
 * spelling of the copy this character actually handled) and ABOVE the export key. Scope is
 * deliberately the Sky quest set and nothing wider: it is the data this module already receives,
 * and the committed 11.2k item DB lives in main, behind an exact-name IPC — inventing a renderer
 * copy of it to case-correct a table cell is not a trade this ticket makes.
 */
function questItemNames(quests: PoskyQuest[]): Record<string, string> {
  const names: Record<string, string> = {}
  for (const q of quests) {
    for (const it of q.items) names[itemCountKey(it.name)] ??= it.name
  }
  return names
}

/**
 * ============================================================================
 * THE TURN-IN WINDOW, RE-DECIDED UNDER ADDITIVE SEMANTICS (JOS-141).
 * ============================================================================
 *
 * JOS-131 subtracted only the turn-ins made SINCE the dump was generated, whenever the count
 * source read a dump. That window was a consequence of JOS-128's reset and nothing else: a base of
 * `dump + loot since the dump` already had every pre-dump turn-in taken out of it, so subtracting
 * them again would eat the copy you refarmed afterwards. With the reset gone the window has no
 * argument left, and the generation instant it needed is no longer consulted anywhere.
 *
 * THE WINDOW MOVES FROM TIME TO SOURCE, and JOS-131's own argument is what moves it:
 *
 *   THE LOG is a record of what you have ever LOOTED. It still contains every item any turn-in
 *   ever ate, because nothing removes a line from it. So a log-derived count owes EVERY turn-in,
 *   all time. This is the default count source and the one the Sky refarm story runs on: loot the
 *   claws, hand them in, the count drops back, and the next claw you farm shows.
 *
 *   THE DUMP is an observation of what you are HOLDING. Anything a turn-in ate is already not in
 *   it, whenever that turn-in happened, because the file was written after all of them. So a
 *   dump-derived count owes NOTHING. Subtracting there is double-subtraction, and it fails in the
 *   exact direction this ticket exists to stop: items the player still owns, quietly gone.
 *
 * ============================================================================
 * "BECAUSE THE FILE WAS WRITTEN AFTER ALL OF THEM" WAS ONLY HALF TRUE (JOS-403).
 * ============================================================================
 *
 * Read that clause again: it is a statement about TIME wearing the clothes of a statement about
 * SOURCE. A dump owes nothing to the turn-ins that happened BEFORE it — the game itself took those
 * items out of the file — and it owes every one made AFTER it, because the player kept playing and
 * the file did not. JOS-141 was arguing against the pre-dump half (JOS-131 subtracted the whole
 * history from a dump and ate the copy you refarmed), won that argument, and then threw away the
 * window rather than narrowing it. The post-dump half went with it, and stayed gone for nine
 * releases because the dump was UNDATED and there was nothing to window against.
 *
 * The report that found it (v1.4.0, feedback 01M081TPHPGB173YCC4YH7AMZB): a dump at 10:15 listing
 * three Efreeti War Bows, a Ranger turn-in at 10:17 eating one, two destroys at 10:19. Truth is
 * zero. The app read 1 — the destroys came off the witness (JOS-401) and the turn-in did not — so
 * the tracker kept counting a bow the player had handed over and the Cleanup tab kept listing it.
 *
 * WHAT MAKES THE NARROW WINDOW POSSIBLE NOW: JOS-186 dated the dump (`rebaselineAt`, from
 * countSource.ts `rebaselineInstant`) and JOS-401 proved the shape by applying exactly this
 * windowed subtraction to destroys. A turn-in after the dump is the same shape against the same
 * witness at the same instant. Pre-dump turn-ins stay un-subtracted — JOS-141's ruling is intact,
 * and it is the ONLY thing standing between a banked item and disappearing.
 *
 * So each witness is discounted on its own terms and the sources combine as they always do:
 *
 *   'log'        max(0, log - consumed)          [log is already net of every destroy]
 *   'inventory'  max(0, dump - destroyed since the dump - turn-ins recorded since the dump)
 *   'both'       max(0, dump + looted since the dump - destroyed since it - turn-ins since it)
 *                maxed against max(0, log - consumed)
 *
 * With no instant to date the dump, every windowed term is zero and the three lines above read
 * exactly as they did before any of these tickets — never a guessed instant, which would discount a
 * witness by events that may well predate it.
 *
 * ============================================================================
 * A WITNESS THAT PAYS IN A WINDOW MUST EARN IN THE SAME WINDOW (JOS-409).
 * ============================================================================
 *
 * `both`'s dump line above used to be `max(0, dump - destroyed since - turned in since)` — the
 * discounts windowed to the dump's instant, the CREDITS not windowed at all, because the credits
 * were supposed to arrive via the other witness. That works only while the two witnesses are looking
 * at the same physical copies. Where they are not, one physical turn-in is charged to BOTH of them
 * and a `max` of two independently-underpaid witnesses under-counts.
 *
 * THE CASE THAT PROVED IT is not exotic — it is the Plane of Sky rune refarm, and it is guaranteed
 * by a game fact this repo already states (shared/outputs/kinds.ts): a Wind Rune is looted straight
 * into the CURRENCY TAB, and `/outputfile inventory` never lists currency-tab items. So the dump's
 * reading of a rune is always 0 and the log's is the only one there is. Now hand a rune quest in
 * once, dump, and farm the rune again:
 *
 *   the log witness   1 looted, all-time consumption 1 (the turn-in)      → max(0, 1-1) = 0
 *   the dump witness  0 in the file, no post-dump turn-in to owe          → 0
 *   `both`            max(0, 0)                                          → 0
 *
 * The player is holding the rune. Three 1.5.0 reports said exactly that, one of them with a log
 * slice in it (feedback 01M0ATTCXBX3PB8NRSHM8E4EMY, and 01M0CVBWRBXZ3DVDY7CMXQ7SXE /
 * 01M0DADXKXPN5KJWFSAZNQ3VAA, the last of which named the mechanism: *all my runes are in currency
 * storage and aren't being reported during an inventory dump*). Nothing was wrong with the parser;
 * both witnesses were individually defensible; the combination was the bug.
 *
 * THE FIX IS ONE TERM: the dump witness accumulates the loot recorded after the dump before paying
 * the consumption recorded after the dump — `max(0, D + l_after - d_after - c_after)`. It is the
 * `rebaseline` witness's own arithmetic, which has been in this file since JOS-186 and was simply
 * gated to the one mode named after it. Under `both` it makes the dump line a complete little world
 * in its window, exactly as JOS-186 requires of every windowed witness, and the rune above reads 1.
 *
 * WHY THIS IS SAFE IN THE DIRECTION THE OWNER RULED ON. The new term is ADDED, so the dump witness
 * can only rise, so a `max` over it can only rise: no count this app has ever shown can fall because
 * of JOS-409. That is the 2026-08-09 ruling's direction (a count that is too low is the failure
 * mode), and it is why the bow case of JOS-403 stays 0 — those bows were in the dump, none were
 * looted after it, `l_after` is 0, and the whole expression is unchanged. Monotonicity is
 * unaffected: `l_after` is itself monotone in the player's own loot.
 *
 * AND `both` IS NOT `rebaseline` NOW. The dump lines coincide; the modes do not, because `both`
 * still maxes that line against the ALL-TIME log witness and `rebaseline` throws it away. The
 * banked item JOS-141 was written to protect — in a bank window that was shut, looted long before
 * the dump — is answered by the log witness under `both` and still reads 0 under `rebaseline`.
 * That difference IS the fourth source's stated cost, and it is untouched.
 *
 * WHY DISCOUNT-THEN-MAX RATHER THAN MAX-THEN-DISCOUNT: the second is not monotone in your own
 * loot. With a dump of 5, a quest that ate 2 and a log of 4, `max(4,5) - 2` reads 3; loot one more
 * claw and the log wins the max, so the same expression reads 3 again but a further one drops the
 * answer BELOW where it sat. A count that falls when you loot something is indefensible on a
 * screen whose whole job is "how close am I". Discounting first cannot do that: each witness is
 * monotone, and a maximum of monotone witnesses is monotone.
 *
 * The row's `consumed` is therefore what the turn-ins ACTUALLY took off this row (`base - net`),
 * not the gross `required x times`. Those differ exactly when a witness had less than the
 * turn-ins ate, or when the dump floor rescued the row, and reporting the gross figure there
 * would describe a subtraction that did not happen. `net === base - consumed` always.
 *
 * ============================================================================
 * A WINDOWED WITNESS IS DISCOUNTED IN ITS OWN WINDOW (JOS-186).
 * ============================================================================
 *
 * The two baselines added by JOS-186 owe only the turn-ins made AFTER them, for exactly the reason
 * a dump owes none: the baseline already reflects everything that happened before it. A dump
 * generated on Tuesday has Monday's turn-in taken out of it by the game itself; a user who says
 * "I hold two claws" is telling us what is in the bag right now, turn-ins and all. Subtracting the
 * whole history from either would be double-subtraction — the failure this rule exists to stop.
 *
 *   'rebaseline'  max(0, (dump + looted since it) - destroyed since it) - turn-ins recorded since it
 *   an OVERRIDE   max(0, (stated + looted since it) - destroyed since it) - turn-ins recorded
 *                 since it, and it WINS over the selected source, because it is the only witness
 *                 that is a person.
 *
 * THE DESTROY DISCOUNT IS THE SAME SHAPE AS THE TURN-IN ONE (JOS-401) and is stated in the base
 * rather than beside `consumed` for one reason: a turn-in is a subtraction the ledger owns and
 * reports on the row (`consumedBy` names the quest), while a destroy is a subtraction the WITNESS
 * owes — the number the dump printed was already wrong by then. Folding it into the base is what
 * keeps `consumed` an honest answer to "what did the quests take off this row".
 *
 * WHICH IS WHY THE DUMP'S TURN-IN WINDOW (JOS-403) IS ON THE OTHER SIDE OF THAT LINE. The dump
 * witness now has BOTH discounts, and they are placed by that same rule: `witnessBase` reports the
 * dump less its destroys, `witnessNet` takes the post-dump turn-ins off it (`dumpNet`), so the row
 * reads `base 3, consumed 1, net 2` and `consumedBy` names the quest that ate the copy — including
 * on a row the log has never seen, which is the case the reporter was looking at. `net === base -
 * consumed` still holds by construction, and every witness stays monotone in loot: the new
 * subtraction is a constant in the player's own farming, exactly like the destroy one.
 *
 * The override wins over a NEWER DUMP too, and that is deliberate rather than overlooked: a hand
 * statement sits at the top of the provenance ladder (the `RosterEdit` precedent — a later log
 * line can neither undo it nor be undone by it), and a dump reports only what a window happened to
 * be showing. Loot is different, and that is the one thing the statement does bend to: a drop is a
 * thing that demonstrably happened to this item after the statement was made, so it adds.
 */
function witnessNet(w: Witnesses, countSource: CountSource): number {
  if (w.override) return Math.max(0, w.override.base - w.override.consumed)
  const fromLog = Math.max(0, w.log - w.consumed)
  if (countSource === 'log') return fromLog
  if (countSource === 'rebaseline' && w.rebaseline) {
    return Math.max(0, w.rebaseline.base - w.rebaseline.consumed)
  }
  const dump = dumpNet(w)
  if (countSource === 'inventory') return dump
  return Math.max(dump, fromLog)
}

/**
 * DID THE DUMP EXPLAIN THIS ROW'S SUBTRACTION — the question `blameFor` has to answer once the dump
 * witness can be discounted by turn-ins (JOS-403).
 *
 * `inventory` reads nothing else, so it always did. Under `both` the dump explains the row only when
 * it won BOTH maxima: the base (`max(log, dump)`) and the net (`max(dumpNet, fromLog)`). Where the
 * log won either, the subtraction on the row is the all-time one and the all-time pass is what names
 * it. The mixed case — the log vouching for a bigger base while the dump answers the net — is
 * blamed all-time as it always was: `spent` is then a difference between two witnesses that no
 * single pass authored, and the all-time list is the superset that at least names every quest
 * involved.
 */
function dumpAnsweredRow(w: Witnesses, countSource: CountSource): boolean {
  if (countSource === 'inventory') return true
  if (countSource !== 'both') return false
  return dumpBase(w) >= w.log && dumpNet(w) >= Math.max(0, w.log - w.consumed)
}

/** Everything the row build reads, gathered so it travels as one argument. */
interface RowInputs {
  log: Record<string, number>
  invByKey: Record<string, number>
  nameByKey: Record<string, string>
  countSource: CountSource
  /** all-time turn-in consumption, and who to blame for it */
  all: Consumption
  /** the dump-anchored window, or null when the source is not `rebaseline` or nothing anchors it */
  rebaseline: { since: Record<string, number>; consumption: Consumption } | null
  /** the hand-stated counts and the loot that landed after each of them */
  overrides: Record<string, ItemCountOverride>
  overrideSince: Record<string, number>
  /** JOS-401 — the destroys recorded after the dump, and after each hand statement */
  destroyedSinceDump: Record<string, number>
  destroyedSinceOverride: Record<string, number>
  /**
   * JOS-409 — the loot recorded after the dump, credited to the dump witness under `both`. Already
   * gated by source and by whether the dump can be dated, so it is `{}` everywhere else and the
   * witness build can simply read it.
   */
  lootSinceDump: Record<string, number>
  /**
   * JOS-403 — the turn-ins recorded after the DUMP was generated, for every source that reads the
   * dump as a witness. Null when nothing can date the dump (no discount), and null under `log`,
   * which consults the file for nothing at all and would only be paying for a pass it never reads.
   * Under `rebaseline` it is the same memoized `Consumption` object as `rebaseline.consumption` —
   * same instant, one pass — and that path reads it through the rebaseline witness instead.
   */
  dumpWindow: Consumption | null
  /** consumption windowed to any instant, memoized (`windowedConsumption`) */
  windowed: (at: number) => Consumption
}

/**
 * THE HAND-STATED WITNESS for one key — the statement, plus what the log has seen happen to the
 * item since it was made.
 *
 * Its own function because it is the one witness with three forward rules on it (loot adds,
 * destroys subtract, turn-ins subtract) and `witnessesFor` sits under the measured complexity
 * ceiling. The statement is a witness like any other, so it is discounted the same way — by what
 * the log recorded you destroying after you made it, floored (JOS-401). Saying "I hold 3" and then
 * destroying 5 leaves 0, not -2.
 */
function overrideWitness(
  k: string,
  statement: ItemCountOverride,
  x: RowInputs
): NonNullable<Witnesses['override']> {
  return {
    statement,
    base: Math.max(
      0,
      statement.count + (x.overrideSince[k] ?? 0) - (x.destroyedSinceOverride[k] ?? 0)
    ),
    consumed: x.windowed(statement.setAt).consumed[k] ?? 0
  }
}

/** Gather one key's witnesses, building only the windows that actually apply to it. */
function witnessesFor(k: string, x: RowInputs): Witnesses {
  const w: Witnesses = {
    log: x.log[k] ?? 0,
    inv: x.invByKey[k] ?? 0,
    consumed: x.all.consumed[k] ?? 0,
    invDestroyed: x.destroyedSinceDump[k] ?? 0,
    invConsumed: x.dumpWindow?.consumed[k] ?? 0,
    invSince: x.lootSinceDump[k] ?? 0
  }
  if (x.rebaseline) {
    w.rebaseline = {
      base: dumpWitness(w.inv, x.rebaseline.since[k] ?? 0, w.invDestroyed),
      consumed: x.rebaseline.consumption.consumed[k] ?? 0
    }
  }
  const statement = x.overrides[k]
  if (statement) w.override = overrideWitness(k, statement, x)
  return w
}

/** Which pass of `questConsumption` explains THIS row's subtraction — the one its base came from. */
function blameFor(k: string, w: Witnesses, x: RowInputs): string[] {
  if (w.override) return x.windowed(w.override.statement.setAt).consumedBy[k] ?? []
  if (w.rebaseline && x.rebaseline) return x.rebaseline.consumption.consumedBy[k] ?? []
  // JOS-403 — a dump-answered row was discounted by the POST-DUMP turn-ins, so the post-dump pass is
  // what names them. The all-time list would name the same quests plus the ones whose turn-ins the
  // file already reflects, and its `x2` captions would count runs this row never paid for.
  if (x.dumpWindow && dumpAnsweredRow(w, x.countSource)) return x.dumpWindow.consumedBy[k] ?? []
  return x.all.consumedBy[k] ?? []
}

/** Apply `witnessNet` per key and emit the table rows, sorted by what you actually hold. */
function buildRows(x: RowInputs): ReconcileResult {
  const net: Record<string, number> = {}
  const rows: InventoryRow[] = []
  const keys = new Set([
    ...Object.keys(x.log),
    ...Object.keys(x.invByKey),
    ...Object.keys(x.all.consumed),
    // A statement about an item nobody has ever looted or dumped is still a statement, and the
    // quest counting reads `net` — so its key has to be in this set or the count it states would
    // simply never be computed.
    ...Object.keys(x.overrides)
  ])
  for (const k of keys) {
    const w = witnessesFor(k, x)
    const l = w.log
    const i = w.inv
    const b = witnessBase(w, x.countSource)
    const n = witnessNet(w, x.countSource)
    // What the turn-ins actually cost this row. Zero under a dump-reading source the dump itself
    // answered, which is the whole point of the rule above.
    const spent = b - n
    net[k] = n
    // A ROW EXISTS WHENEVER ANY WITNESS VOUCHES FOR THE ITEM (JOS-160), not when the ACTIVE
    // source's base happens to be non-zero.
    //
    // The old test was `b === 0 && spent === 0`, and under the default count source `log` that
    // silently DELETED every item known only to the dump: base is 0 because `log` never consults
    // the export, so the row never reached `rows` at all. The Loot page is the only consumer of
    // `rows`, and its "in inventory only" tail filters them — so a reporter's three Ivory Sky
    // Diamonds, sitting in his `/outputfile inventory` and counted by the Sky tracker, could not be
    // found on the Loot page under any toggle. Two surfaces, one reconcile, opposite answers.
    //
    // `net` IS UNTOUCHED BY THIS — it is written on the line above, before the skip, so the map the
    // quest counting reads is byte-identical whatever this test says. That is exactly why the Sky
    // tracker was right while the Loot page was blind, and it is the regression gate the test pins.
    // What changes is only which rows the TABLE can see, and each row already reports its witnesses
    // separately (`log`, `inv`, `base`, `net`), so a `log`-source row for a dump-only item reads
    // `log: 0, inv: 3, net: 0` — every number honest to its own source.
    //
    // A HAND STATEMENT IS A WITNESS TOO (JOS-186), so a row the user has spoken about is drawn
    // whatever the log and the dump say — including the "I have none of these" that is the whole
    // point of the feature, which every other witness reports as silence.
    if (l === 0 && i === 0 && spent === 0 && !w.override) continue
    rows.push({
      key: k,
      name: x.nameByKey[k] ?? k,
      log: l,
      inv: i,
      base: b,
      consumed: spent,
      net: n,
      consumedBy: spent > 0 ? blameFor(k, w, x) : [],
      ...(w.override ? { override: w.override.statement } : {})
    })
  }
  rows.sort((a, b) => b.net - a.net || a.name.localeCompare(b.name))
  return { rows, net }
}

/**
 * THE DUMP'S INSTANT, AND THE TURN-IN WINDOW IT ANCHORS (JOS-403).
 *
 * `log` reads the file for nothing at all, so it never pays for the pass. Null means the dump is
 * undatable (or there is no dump) and no window can be computed — the no-discount degradation the
 * destroy window already makes, rather than a guessed instant that would discount the witness by
 * turn-ins that may well predate it.
 *
 * THE WINDOW IS OVER THE LOG-DETECTED INSTANTS ONLY (JOS-409) — `detectedTurnInInstants`, falling
 * back to the full list when the caller states no provenance. The argument is on that input.
 */
function dumpTurnInWindow(
  input: ReconcileInput,
  windowed: (at: number) => Consumption
): { at: number | null; window: Consumption | null } {
  const at = input.countSource === 'log' ? null : (input.rebaselineAt ?? null)
  return { at, window: at === null ? null : windowed(at) }
}

/** Everything anchored to the dump's instant — the three windows the file's own witness owns. */
interface DumpAnchored {
  dumpWindow: Consumption | null
  rebaseline: RowInputs['rebaseline']
  lootSinceDump: Record<string, number>
}

/**
 * THE DUMP-ANCHORED HALF OF THE INPUTS, gathered in one place (JOS-409 factored it out — `reconcile`
 * was over the measured complexity ceiling with three windows and their degradations inline).
 *
 * All three hang off ONE instant and ONE memoized pass, and all three degrade the same way when
 * that instant is missing: no window is not a guessed window.
 *
 * `windowedDetected` is the DETECTED memoizer for both the dump's turn-in discount and the
 * rebaseline baseline's, because the rebaseline baseline IS the dump at the dump's instant — a
 * click-time instant is as wrong against one as against the other.
 */
function dumpAnchored(input: ReconcileInput, quests: PoskyQuest[], windowed: (at: number) => Consumption): DumpAnchored {
  const detected = input.detectedTurnInInstants
  // The same object as `windowed` whenever the caller states no provenance, so the ordinary case
  // still pays for one pass per instant rather than two.
  const windowedDetected = detected === undefined ? windowed : windowedConsumption(quests, detected)
  const { at: dumpAt, window: dumpWindow } = dumpTurnInWindow(input, windowedDetected)
  const since = input.lootSinceRebaseline ?? {}
  // The baseline is anchored only where the user asked for it AND something can date the dump.
  // `null` is the fallback to `both` the base/net rules spell out, never a baseline of zero.
  const at = input.countSource === 'rebaseline' ? dumpAt : null
  return {
    dumpWindow,
    rebaseline: at === null ? null : { since, consumption: windowedDetected(at) },
    // JOS-409 — the dump witness earns in its own window under `both`, and only there: `inventory`
    // means "as dumped" and says so on its label, `rebaseline` carries the same loot inside its own
    // baseline, and `log` never opens the file. An undatable dump is no window at all, exactly as
    // for the two discounts.
    lootSinceDump: input.countSource === 'both' && dumpAt !== null ? since : {}
  }
}

/**
 * Reconcile held items from the loot log and the inventory export, then subtract
 * everything consumed by the quest turn-ins — so a drop that was handed in for one quest no
 * longer counts toward another quest that needs it, and a quest handed in twice has eaten its
 * items twice.
 *
 * EVERY JOS-186 INPUT IS OPTIONAL AND DEFAULTS TO ABSENT, which is what makes the fourth source and
 * the overrides a pure ADDITION: a caller that passes none of them gets the three-source arithmetic
 * unchanged, key for key and row order included, and `tests/countSourceDefault.test.mts` still
 * proves the `both`/`log` reduction over the same generated space it always did.
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const { log, inv, lootNames, countSource, quests } = input

  // Display-name precedence, highest first: what a loot line called it, then what the quest data
  // calls it, then the export's lowercased key (JOS-160 — see questItemNames). A hand statement's
  // spelling sits BELOW all of those and above the bare key: it is what one surface called the item
  // once, not what the game calls it.
  const nameByKey: Record<string, string> = { ...questItemNames(quests), ...lootNames }
  const invByKey = foldInventoryByKey(inv, nameByKey)
  const overrides = input.overrides ?? {}
  for (const [k, o] of Object.entries(overrides)) nameByKey[k] ??= o.name

  // The ALL-INSTANTS memoizer. It answers the per-STATEMENT windows: a hand statement's `setAt` is
  // a click time, and a hand-recorded turn-in's is too, so comparing those two is comparing like
  // with like. The dump's windows are the ones that need a provenance (`dumpAnchored`).
  const windowed = windowedConsumption(quests, input.turnInInstants ?? {})
  const all = questConsumption(quests, (k) => input.turnIns[k] ?? 0)
  const dump = dumpAnchored(input, quests, windowed)

  return buildRows({
    log,
    invByKey,
    nameByKey,
    countSource,
    all,
    rebaseline: dump.rebaseline,
    overrides,
    overrideSince: input.lootSinceOverride ?? {},
    destroyedSinceDump: input.destroyedSinceDump ?? {},
    destroyedSinceOverride: input.destroyedSinceOverride ?? {},
    lootSinceDump: dump.lootSinceDump,
    dumpWindow: dump.dumpWindow,
    windowed
  })
}
