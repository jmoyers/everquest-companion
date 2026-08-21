import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CountSource,
  ItemCountOverride,
  LootDelta,
  LootEvent,
  LootSnap,
  PoskyQuest,
  ProgressState,
  TurnInDelta,
  TurnInSnap
} from '@shared/types'
import { getPoskyData } from '../../data'
import { itemCountKey, normalizeItemName } from '../../lib/itemName'
import {
  computeDestroyedAfter,
  computeDestroyedAfterPerKey,
  computeHeldCounts,
  computeHeldCountsAfter,
  computeHeldCountsAfterPerKey,
  computeLastLootedAt
} from './heldCounts'
import { useModule } from '../../lib/useModule'
import { reconcile, type InventoryRow } from '../inventory/reconcile'
import { COUNT_SOURCE_KEY, rebaselineInstant, resolveCountSource } from '../inventory/countSource'
import { questKey } from './keys'
import { ambiguousQuestNames, computeSharedItems, type SharedItemsMap } from './sharedItems'
import { skyDroppersFor, type DropperMob } from './poskyDroppers'
import { countTurnIns, newlyCompletedTurnIns } from './turnInCelebration'
import { questDropRecency } from './questSort'
// The turn-in ledger (JOS-131) — the ONE place a turn-in count is decided, shared with main's
// store so the renderer and the persisted file cannot disagree about what a count means.
// Relative value import, per the repo's node-tested-module rule.
import {
  resolveTurnIns,
  turnInsToPersist,
  type QuestTurnIns,
  type TurnInInstants
} from '../../../../shared/questTurnIns'
// The hand-stated held counts (JOS-186) — same deal, same relative-import rule: the fold that
// turns a stored list into the counting path's inputs is shared with main's store, so the two
// cannot disagree about what a statement is.
import {
  itemOverrideInstants,
  itemOverridesByKey,
  sanitizeItemOverrides
} from '../../../../shared/itemOverrides'

const applyLootDelta = (s: LootSnap, d: LootDelta): LootSnap => [...s, ...d.appended]
const applyTurnInDelta = (s: TurnInSnap, d: TurnInDelta): TurnInSnap => [...s, ...d.appended]
const EMPTY_LOOT: LootEvent[] = []

const posky = getPoskyData()

// "Shared items with" (Task #44): which OTHER quests contend for each quest's
// required items (normalized, Wind Runes excluded). The quest set is static bundled
// data, so this is derived ONCE at module load, not per render.
const sharedItemsMap: SharedItemsMap = computeSharedItems(posky.quests)
const ambiguousNames = ambiguousQuestNames(posky.quests)

// questKey → quest, derived once (static bundled data). Used by the live turn-in
// celebration to resolve a matched key back to its quest for the callback (Task #46).
const questByKey = new Map<string, PoskyQuest>(posky.quests.map((q) => [questKey(q), q]))

export { questKey }

/**
 * The stored pick, or the default for somebody who has never made one (JOS-294).
 *
 * BOTH HALVES LIVE IN `countSource.ts` NOW, and the default there is `both` rather than `log`. The
 * argument, the reports behind it and the proof that it changes nothing for an install with no dump
 * are all in that file's header; this is the one line of storage it needs. An explicit stored choice
 * is returned verbatim — the flip reaches only an absent key.
 */
function loadCountSource(): CountSource {
  return resolveCountSource(localStorage.getItem(COUNT_SOURCE_KEY))
}

/**
 * Display names keyed by the SAME normalized counting key logCounts uses, so the
 * reconcile rows (keyed by counting key) resolve a name. We prefer the BASE
 * (un-suffixed) display when we've seen it, so a `Sphinx Claw` + `Sphinx Claw +1`
 * pool reads as "Sphinx Claw" (the quest item), not the variant.
 *
 * A DESTROY ROW IS A NAME LIKE ANY OTHER (JOS-401, the census). This map is about SPELLING, not
 * about holdings — `You successfully destroyed 1 Efreeti Belt.` carries the game's own capitals
 * for that item exactly as a loot line does, which is the only thing being read here.
 */
function deriveLootNames(lootHistory: LootEvent[]): Record<string, string> {
  const m: Record<string, string> = {}
  for (const e of lootHistory) {
    const k = itemCountKey(e.item)
    const base = normalizeItemName(e.item)
    // First writer wins, but a base (un-suffixed) name upgrades a variant one.
    if (m[k] === undefined || (m[k] !== base && base === e.item)) m[k] = base
  }
  return m
}

export interface ItemProgress {
  name: string
  /** the posky scrape's RAW source strings (site abbreviations — see poskyDroppers.ts) */
  who: string[]
  where: string
  /**
   * The kill target: every Plane of Sky mob the committed data says drops this item, resolved
   * from the scrape's own naming first and the mob catalog's inverted loot lists second
   * (poskyDroppers.ts). EMPTY when nothing is known — the UI then shows `who` verbatim or
   * nothing at all, never a guess.
   */
  droppers: DropperMob[]
  need: number
  have: number
  /**
   * What the app counts you as HOLDING of this item, UNCAPPED (JOS-186). `have` is that number
   * clamped to `need` for the progress bar; this is the one the hand-correction control edits and
   * pre-fills, because clamping it would turn "I hold seven" into "I hold five" the moment the
   * user opened the box.
   */
  held: number
  stats?: string
  page?: string
  /** epoch ms this item last dropped (computeLastLootedAt); absent = never seen dropping. */
  lastLootedAt?: number
  /**
   * The hand-stated count in force for this item, when there is one (JOS-186). Present is what
   * makes the correction VISIBLY manual on the row — the ticket's first design constraint — and it
   * carries the instant, so the row can say when the statement was made.
   */
  override?: ItemCountOverride
}

export interface QuestProgress {
  key: string
  className: string
  name: string
  giver?: string
  rune?: string
  reward?: string
  rewardStats?: string
  items: ItemProgress[]
  haveCount: number
  needCount: number
  ratio: number
  missing: string[]
  /**
   * HOW MANY TIMES this quest has been turned in (JOS-131). Zero is "never". It is a count and
   * not a flag because a Sky quest can be run again: the turn-in subtracts what it consumed, so
   * the quest drops back to 0/N and this number is the only thing that remembers you did it.
   */
  turnIns: number
  /**
   * How many of those the LOG itself accounts for. The difference (`turnIns - logTurnIns`) is
   * what the user stated by hand, and it is the only part an "undo" can take back: the log is
   * evidence, and a control that appeared to delete evidence would silently re-assert it on the
   * next snapshot.
   */
  logTurnIns: number
  /** turned in at least once. Kept as the one-bit reading of `turnIns` for the surfaces that
   *  only need the badge (the Ignored list) and for sorts that predate the count. */
  completed: boolean
  /**
   * epoch ms of the NEWEST drop among this quest's required items — the "most recent drop"
   * sort key. Absent when nothing it needs has ever dropped; recency is then unknown, not old.
   * Read from the loot log regardless of the count source: a drop is a log fact, and an
   * inventory export carries no timestamps at all.
   */
  lastDropAt?: number
}

/** Per-quest turn-in counts, as `computeQuestProgress` needs them: the total, and the log's share. */
export interface QuestTurnInCounts {
  all: Record<string, number>
  log: Record<string, number>
}

/**
 * The per-item facts that are NOT the held count — recency and the hand statements. One bag rather
 * than two more positional parameters, which is also what keeps this function inside the measured
 * `max-params 4`.
 */
export interface QuestItemFacts {
  /** counting key → epoch ms that item last dropped (`computeLastLootedAt`) */
  lastLootedAt?: Record<string, number>
  /** counting key → the hand-stated count in force (JOS-186) */
  overrides?: Record<string, ItemCountOverride>
}

export function computeQuestProgress(
  quest: PoskyQuest,
  held: Record<string, number>,
  turnIns: QuestTurnInCounts,
  facts: QuestItemFacts = {}
): QuestProgress {
  const key = questKey(quest)
  const items: ItemProgress[] = quest.items.map((it) => {
    const need = it.count > 0 ? it.count : 1
    const countKey = itemCountKey(it.name)
    const holding = held[countKey] ?? 0
    const have = Math.min(need, holding)
    return {
      name: it.name,
      who: it.who,
      where: it.where,
      // Committed data, so this is a couple of Map lookups against a lazily-built index — no
      // reason to memoize it per item on top of the memo this whole list already sits behind.
      droppers: skyDroppersFor(it.name, it.who),
      need,
      have,
      held: holding,
      stats: it.stats,
      page: it.page,
      lastLootedAt: facts.lastLootedAt?.[countKey],
      override: facts.overrides?.[countKey]
    }
  })
  const needCount = items.reduce((s, i) => s + i.need, 0)
  const haveCount = items.reduce((s, i) => s + i.have, 0)
  const count = turnIns.all[key] ?? 0
  return {
    key,
    className: quest.className,
    name: quest.name,
    giver: quest.giver,
    rune: quest.rune,
    reward: quest.reward,
    rewardStats: quest.rewardStats,
    items,
    haveCount,
    needCount,
    // NO LONGER PINNED AT 1 BY COMPLETION (JOS-131). The ratio is what you are holding for this
    // quest right now, and a turn-in gives those items back to the grind — so a quest you just
    // handed in reads 0%, which is the true answer to "how close am I to running it again".
    ratio: needCount === 0 ? 0 : haveCount / needCount,
    missing: items.filter((i) => i.have < i.need).map((i) => i.name),
    turnIns: count,
    logTurnIns: turnIns.log[key] ?? 0,
    completed: count > 0,
    lastDropAt: questDropRecency(items)
  }
}

export interface UseProgress {
  character: string | null
  quests: QuestProgress[]
  classes: string[]
  progress: ProgressState | null
  lootHistory: LootEvent[]
  inventoryRows: InventoryRow[]
  countSource: CountSource
  setCountSource: (s: CountSource) => void
  reloadInventory: () => Promise<string>
  /** Record one more turn-in of this quest, dated now (JOS-131). Multiple turn-ins are the norm. */
  recordTurnIn: (key: string) => Promise<void>
  /**
   * Take back the most recent turn-in this app did not read out of the log. A count that is
   * entirely log-detected cannot be undone here (`QuestProgress.logTurnIns`) — the next snapshot
   * would simply re-assert it, and a button that silently loses its effect is worse than one that
   * says it does not apply.
   */
  undoTurnIn: (key: string) => Promise<void>
  /**
   * STATE ONE ITEM'S HELD COUNT BY HAND, or take the statement back with `count: null` (JOS-186).
   * Takes the item's DISPLAY name — the counting key is this module's business, not a control's —
   * and the statement is dated in main at the instant it lands.
   */
  setItemOverride: (name: string, count: number | null) => Promise<void>
  /** Every statement in force, oldest first — what the tab's status line counts. */
  itemOverrides: ItemCountOverride[]
  inventoryInfo: ProgressState['inventorySource']
  /** questKey → contested items (other quests sharing each required item). */
  sharedItems: SharedItemsMap
  /** quest names that occur under >1 class (chips class-prefix only these). */
  ambiguousQuestNames: Set<string>
}

export interface UseProgressOptions {
  /**
   * Fired ONCE PER TURN-IN, the instant a LIVE one is detected (the giver received every
   * required item while the app is open). Mirrors the boss-defeat celebration contract
   * (Task #46 / #24): the historical baseline (quests already turned in on load, and turn-ins
   * found in the initial log scan) is seeded SILENTLY on the first snapshot and NEVER fires;
   * only a transition observed after that baseline fires. A manually recorded turn-in
   * (`recordTurnIn`) does NOT route through here, so it never celebrates.
   *
   * `count` is which turn-in this was for that quest (1 the first time, 2 the second). Repeat
   * turn-ins celebrate, on the boss watch's precedent: every time is worth celebrating.
   */
  onQuestComplete?: (quest: PoskyQuest, count: number) => void
}

/** What the held-item fold hands back: the reconciled counts, the table rows, and recency. */
interface HeldItems {
  net: Record<string, number>
  inventoryRows: InventoryRow[]
  lastLootedAt: Record<string, number>
}

/**
 * Everything derived from the loot ledger plus the loaded dump — the three folds and the
 * reconcile, kept together because they are one derivation and split out of `useProgress`
 * because that hook was at its factoring ceiling.
 *
 * The disposition → held-vs-gone rule lives in computeHeldCounts (heldCounts.ts, the ONE place
 * counts derive — Tasks #40/#47): sold and combined rows are excluded, everything else
 * (kept/currency/hoard/depot) counts, stacked loots count their stack size. Turn-in subtraction
 * downstream (reconcile) operates on these held counts, so excluding sold there also keeps it
 * from ever subtracting an item that was never held.
 *
 * THE HELD-COUNT FOLD IS NOT WINDOWED BY THE DUMP (JOS-141). JOS-128 folded a SECOND held-count map
 * here, narrowed to loot after `inventorySource.generatedAt`, because a dump load reset the model
 * and the log accumulated from that instant. The owner reverted that after field-testing: a dump
 * only covers what was open when it was written, so the reset was eating banked Sky items. The fold
 * is the all-time one again, and the combination rule (reconcile.ts) is fully additive.
 *
 * WHAT THE DUMP'S INSTANT DOES WINDOW is the two DISCOUNTS reconcile applies to the dump witness
 * itself — the destroys recorded after it (JOS-401) and the turn-ins recorded after it (JOS-403) —
 * and, since JOS-409, the one CREDIT that balances them under `both`: the loot recorded after it.
 * All three are zero without an instant to date the dump, and none of them touches the all-time
 * baseline the reverted ticket was about — `computeHeldCounts` above is still the whole log.
 *
 * THE CREDIT IS NOT A SECOND FOLD: it is `lootSinceRebaseline`, the JOS-186 fold that has been here
 * since the fourth source shipped, asked for under one more mode. The turn-in discount needs no fold
 * at all — `detectedTurnIns` is already the ledger's own list and reconcile windows it.
 */
function useHeldItems(x: {
  lootHistory: LootEvent[]
  progress: ProgressState | null
  countSource: CountSource
  turnIns: QuestTurnIns
  /**
   * THE LOG'S OWN TURN-IN INSTANTS (JOS-409) — the subset of `turnIns.instants` that came off a
   * line the game printed, rather than off a click on the hand counter. Only these may window the
   * DUMP; reconcile.ts's `detectedTurnInInstants` argues why, and `useTurnInLedger` is where the
   * two provenances part.
   */
  detectedTurnIns: TurnInInstants
  /** the hand statements in force, already sanitized (JOS-186) */
  overrides: ItemCountOverride[]
}): HeldItems {
  const { lootHistory, progress, countSource, turnIns, detectedTurnIns, overrides } = x
  const logCounts = useMemo(() => computeHeldCounts(lootHistory), [lootHistory])
  const lootNames = useMemo(() => deriveLootNames(lootHistory), [lootHistory])
  // Per-item drop recency, same counting key as the held counts — the whole plumbing the
  // "most recent drop" sort needs, folded from the loot history that is already here.
  const lastLootedAt = useMemo(() => computeLastLootedAt(lootHistory), [lootHistory])
  // THE TWO FORWARD WINDOWS (JOS-186). Each is the same loot fold over fewer rows: what has
  // dropped since the dump was generated, and what has dropped since each hand statement was made.
  //
  // `rebaselineAt` ITSELF IS COMPUTED UNDER EVERY SOURCE and passed unconditionally — it is the
  // DUMP'S instant, and reconcile reads it for the two discounts every dump-reading source owes
  // (JOS-401's destroys, JOS-403's turn-ins), not only for the rebaseline baseline it was named
  // after.
  //
  // AND THE LOOT FOLD IS NO LONGER GATED TO `rebaseline` (JOS-409). `both` reads it too, because
  // its dump witness now earns in the same window it pays in — reconcile.ts carries the whole
  // argument and the rune report behind it. The gate SHRANK rather than vanished: `inventory` is
  // "as dumped" on its own label and `log` never opens the file, so neither pays for this pass, and
  // neither does an install whose dump cannot be dated.
  const rebaselineAt = rebaselineInstant(progress?.inventorySource)
  const readsDumpForward = countSource === 'rebaseline' || countSource === 'both'
  const lootSinceRebaseline = useMemo(
    () =>
      readsDumpForward && rebaselineAt !== null
        ? computeHeldCountsAfter(lootHistory, rebaselineAt)
        : {},
    [lootHistory, readsDumpForward, rebaselineAt]
  )
  const lootSinceOverride = useMemo(
    () => computeHeldCountsAfterPerKey(lootHistory, itemOverrideInstants(overrides)),
    [lootHistory, overrides]
  )
  // THE DESTROY DISCOUNTS (JOS-401) — what the log says left your bags after each witness spoke.
  // The dump one is computed under EVERY count source, not only `rebaseline`: 'inventory' and
  // 'both' read the file as a witness too, and it is exactly as stale. Undatable dump ⇒ no window
  // ⇒ no discount, which is the same degradation `rebaseline` makes rather than a guessed instant.
  const destroyedSinceDump = useMemo(
    () => (rebaselineAt === null ? {} : computeDestroyedAfter(lootHistory, rebaselineAt)),
    [lootHistory, rebaselineAt]
  )
  const destroyedSinceOverride = useMemo(
    () => computeDestroyedAfterPerKey(lootHistory, itemOverrideInstants(overrides)),
    [lootHistory, overrides]
  )
  // Reconcile held items (log + inventory), subtracting anything consumed by quests that have
  // been turned in, and letting a hand statement answer for the items it speaks about.
  const { net, rows: inventoryRows } = useMemo(
    () =>
      reconcile({
        log: logCounts,
        inv: progress?.inventory ?? {},
        lootNames,
        countSource,
        turnIns: turnIns.all,
        turnInInstants: turnIns.instants,
        detectedTurnInInstants: detectedTurnIns,
        quests: posky.quests,
        overrides: itemOverridesByKey(overrides),
        lootSinceOverride,
        rebaselineAt,
        lootSinceRebaseline,
        destroyedSinceDump,
        destroyedSinceOverride
      }),
    [
      logCounts,
      lootNames,
      progress,
      countSource,
      turnIns,
      detectedTurnIns,
      overrides,
      lootSinceOverride,
      rebaselineAt,
      lootSinceRebaseline,
      destroyedSinceDump,
      destroyedSinceOverride
    ]
  )
  return { net, inventoryRows, lastLootedAt }
}

/** What the turn-in ledger hands back: the counts the tab reads, and the two ways to change them. */
interface TurnInLedger {
  turnIns: QuestTurnIns
  /**
   * THE LOG'S OWN INSTANTS, unmerged (JOS-409). `turnIns.instants` is these plus the hand-recorded
   * ones, and the difference matters to exactly one reader: the dump's turn-in window, which
   * compares an instant against a file's generation stamp. A hand-recorded instant is `Date.now()`
   * at the moment of the CLICK (`recordTurnIn` below says so), so it can postdate a dump that
   * already reflects the turn-in — and windowing it would double-subtract. This list is the half
   * that is an EVENT time.
   */
  detected: TurnInInstants
  /** quest key → how many of its turn-ins the LOG accounts for */
  logCounts: Record<string, number>
  recordTurnIn: (key: string) => Promise<void>
  undoTurnIn: (key: string) => Promise<void>
}

/**
 * THE TURN-IN LEDGER (JOS-131), split out of `useProgress` because that hook was at its measured
 * factoring ceiling and because this is one subject: where turn-in counts come from, when they
 * celebrate, when they are written down, and how a user states one by hand.
 */
function useTurnInLedger(
  progress: ProgressState | null,
  setProgress: (p: ProgressState) => void,
  onQuestComplete?: (quest: PoskyQuest, count: number) => void
): TurnInLedger {
  // Raw (nullable) turn-in snapshot: null until the module hydrates. We gate the
  // celebration baseline on hydration so the historical turn-ins that arrive WITH the
  // snapshot seed the baseline silently instead of looking like live transitions.
  const turnInsRaw = useModule<TurnInSnap, TurnInDelta>('turnins', applyTurnInDelta)

  // Baseline of per-quest turn-in COUNTS — seeded silently on the FIRST observation so
  // historical turn-ins (in the initial log scan) never celebrate. A count that GROWS after the
  // baseline is a live transition → celebrate, including the second run of a quest you had
  // already done. Kept in a ref (not state) so it never triggers a re-render,
  // mirroring useBossKills' prevRef. Reset on character switch (state re-hydrates from scratch).
  const matchedBaselineRef = useRef<Record<string, number> | null>(null)
  const onQuestCompleteRef = useRef(onQuestComplete)
  onQuestCompleteRef.current = onQuestComplete

  useEffect(() => {
    const off = window.eq.onCharacter(() => {
      matchedBaselineRef.current = null
    })
    return off
  }, [])

  // The log's own turn-ins, quest key → instants. Null until the module hydrates; an empty
  // ledger until then, so nothing derived from it has to special-case the gap.
  const detected = useMemo<TurnInInstants>(
    () => countTurnIns(turnInsRaw ?? [], posky.quests),
    [turnInsRaw]
  )
  // The log's turn-ins merged with the persisted ones, as the all-time count the rest of the tab
  // reads. No since-the-dump count any more (JOS-141): consumption is windowed by SOURCE rather
  // than by instant now, and reconcile.ts argues why.
  const turnIns = useMemo(() => resolveTurnIns(progress, detected), [progress, detected])
  // The log's share of each count, for the "can this be undone" question (see UseProgress).
  const logCounts = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {}
    for (const [key, list] of Object.entries(detected)) out[key] = list.length
    return out
  }, [detected])

  // Persist the turn-ins the log knows about and celebrate ONLY genuine live transitions (never
  // the historical baseline). Gated on the turn-in snapshot being HYDRATED (turnInsRaw != null)
  // so the historical turn-ins that arrive with the first snapshot seed the baseline silently
  // rather than firing.
  useEffect(() => {
    if (!progress || turnInsRaw == null) return

    // Celebrate every quest whose count GREW since the last observation — but seed the
    // baseline SILENTLY on the first hydrated run so the initial log scan's historical
    // turn-ins (and already-persisted ones) never fire. This is the boss-defeat baseline rule
    // applied to turn-ins (Task #46), now counting rather than latching (JOS-131).
    for (const t of newlyCompletedTurnIns(matchedBaselineRef.current, turnIns.all)) {
      const quest = questByKey.get(t.key)
      if (quest) onQuestCompleteRef.current?.(quest, t.count)
    }
    matchedBaselineRef.current = turnIns.all

    // A detected turn-in is written to the store, the way the old auto-complete wrote a
    // completion: the log is re-scanned per character epoch and logs get truncated, and a
    // turn-in the log can no longer show still happened. The write settles because the merge is
    // idempotent — once stored, `turnInsToPersist` has nothing left to say.
    const pending = turnInsToPersist(progress, turnIns.instants)
    if (pending.length === 0) return
    void Promise.all(pending.map((p) => window.eq.setQuestTurnIns(p.key, p.instants))).then(
      (results) => {
        if (results.length) setProgress(results[results.length - 1])
      }
    )
  }, [turnInsRaw, progress, turnIns, setProgress])

  /** One more turn-in, dated NOW. `Date.now()` is the honest instant for a statement the user is
   *  making right now, and dating it is what keeps the ledger a list of events rather than a tally
   *  (an instant is what dedupes a detected turn-in against the stored one).
   *
   *  IT IS A CLICK TIME, NOT AN EVENT TIME, and JOS-409 is where that stopped being harmless: a
   *  player who hands a quest in and records it a day later stamps TOMORROW on YESTERDAY'S event.
   *  Nothing here can fix that — the user is telling us a thing happened, not when — so the fix is
   *  on the reader: only `detected` (above) windows the dump. Do not "improve" this to guess an
   *  earlier instant; a guessed event time is exactly the kind of invention law 1 forbids. */
  const recordTurnIn = useCallback(
    async (key: string): Promise<void> => {
      setProgress(
        await window.eq.setQuestTurnIns(key, [...(turnIns.instants[key] ?? []), Date.now()])
      )
    },
    [turnIns, setProgress]
  )

  /**
   * Drop the newest turn-in the LOG does not also know about. A log-detected instant is left
   * alone: removing it would be undone by the very next snapshot, so the UI disables the control
   * instead (it reads `QuestProgress.logTurnIns`). With no instants at all, this clears a
   * pre-JOS-131 completion, which is the only other thing a count can come from.
   */
  const undoTurnIn = useCallback(
    async (key: string): Promise<void> => {
      const list = turnIns.instants[key] ?? []
      const fromLog = new Set(detected[key] ?? [])
      const cut = [...list].reverse().find((ts) => !fromLog.has(ts))
      setProgress(
        await window.eq.setQuestTurnIns(key, cut === undefined ? [] : list.filter((ts) => ts !== cut))
      )
    },
    [turnIns, detected, setProgress]
  )

  return { turnIns, detected, logCounts, recordTurnIn, undoTurnIn }
}

export function useProgress(opts?: UseProgressOptions): UseProgress {
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [character, setCharacter] = useState<string | null>(null)
  const [countSource, setCountSourceState] = useState<CountSource>(loadCountSource)

  const lootHistory = useModule<LootSnap, LootDelta>('loot', applyLootDelta) ?? EMPTY_LOOT

  useEffect(() => {
    void window.eq.getProgress().then(setProgress)
    void window.eq.getCharacter().then((c) => setCharacter(c?.name ?? null))
    // Progress can change in main (auto-complete from a turn-in, inventory
    // auto-reload) — stay consistent with those pushes instead of a refetch race.
    const offProgress = window.eq.onProgress(setProgress)
    const offInv = window.eq.onInventoryReload(() => void window.eq.getProgress().then(setProgress))
    const offChar = window.eq.onCharacter((c) => {
      setCharacter(c?.name ?? null)
      void window.eq.getProgress().then(setProgress)
    })
    return () => {
      offProgress()
      offInv()
      offChar()
    }
  }, [])

  const { turnIns, detected, logCounts, recordTurnIn, undoTurnIn } = useTurnInLedger(
    progress,
    setProgress,
    opts?.onQuestComplete
  )

  const setCountSource = useCallback((s: CountSource) => {
    localStorage.setItem(COUNT_SOURCE_KEY, s)
    setCountSourceState(s)
  }, [])

  const reloadInventory = useCallback(async (): Promise<string> => {
    const res = await window.eq.reloadInventory()
    if (res.ok && res.progress) {
      setProgress(res.progress)
      return `Loaded ${res.path}`
    }
    return res.error ?? 'Failed to load inventory'
  }, [])

  // The statements in force, cleaned on the way out of the store the same way main cleans them on
  // the way in. Memoized on the stored array so the two folds below (and the reconcile memo they
  // feed) do not see a new list on every render.
  const itemOverrides = useMemo(
    () => sanitizeItemOverrides(progress?.itemOverrides),
    [progress?.itemOverrides]
  )

  /**
   * State (or take back) one item's held count. The counting key is derived HERE — a control hands
   * over the name it drew, and `itemCountKey` is the same normalization the counts themselves are
   * keyed by, so a statement about `Sphinx Claw +1` lands on the row that counts Sphinx Claws.
   */
  const setItemOverride = useCallback(
    async (name: string, count: number | null): Promise<void> => {
      setProgress(await window.eq.setItemOverride(itemCountKey(name), name, count))
    },
    []
  )

  const { net, inventoryRows, lastLootedAt } = useHeldItems({
    lootHistory,
    progress,
    countSource,
    turnIns,
    detectedTurnIns: detected,
    overrides: itemOverrides
  })

  const overridesByKey = useMemo(() => itemOverridesByKey(itemOverrides), [itemOverrides])
  const quests = useMemo<QuestProgress[]>(() => {
    if (!progress) return []
    const counts = { all: turnIns.all, log: logCounts }
    const facts = { lastLootedAt, overrides: overridesByKey }
    return posky.quests.map((q) => computeQuestProgress(q, net, counts, facts))
  }, [progress, net, lastLootedAt, turnIns, logCounts, overridesByKey])

  const classes = useMemo(() => [...new Set(posky.quests.map((q) => q.className))].sort(), [])

  return {
    character,
    quests,
    classes,
    progress,
    lootHistory,
    inventoryRows,
    countSource,
    setCountSource,
    reloadInventory,
    recordTurnIn,
    undoTurnIn,
    setItemOverride,
    itemOverrides,
    inventoryInfo: progress?.inventorySource,
    sharedItems: sharedItemsMap,
    ambiguousQuestNames: ambiguousNames
  }
}
