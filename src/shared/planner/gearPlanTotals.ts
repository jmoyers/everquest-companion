// planner/gearPlanTotals.ts — WHAT THE BOARD ADDS UP TO, and how it compares to what you are
// wearing.
//
// REVIVED, AND SAID SO. This is `shared/planner/gearSetTotals.ts` (JOS-286), which JOS-325 removed
// whole when the sets pane went — its own commit message states why: "Its only readers were the
// three deleted components and tests/gearSet.test.mts." Nothing in it was wrong. The arguments
// below are its arguments, kept in its words where they are unchanged, because each one was paid
// for once and re-deriving them would be strictly worse work. What is adapted is the document it
// reads (a `GearPlan`, not a `GearSet`) and one addition at the end.
//
// ============================================================================
// THE SUM IS `sumGear`'s, AND THE UPLIFT IS PHASE 0's. NEITHER IS RESTATED HERE.
// ============================================================================
// `shared/characterSheet.ts sumGear` is this repo's ONE answer to "what do these worn items add
// up to" (JOS-45). It already owns the ordering, the END/ENDURANCE folding, the saves split, the
// unknown-item count and — the load-bearing one — THE REFUSAL TO SUM PERCENTAGES. So this file
// does not add anything up. It builds one `ItemStatBlock` per cell and hands the array over.
//
// WHAT IS NEW IS THE ONE THING `sumGear` DELIBERATELY WOULD NOT DO. Its header states the refusal
// verbatim: it does not apply the ` +N` item-level uplift, and since JOS-281 the reason is not
// that the arithmetic is unknown (`scaleStatBlock` is the exact port of the wiki's own
// calculator) but that an inventory dump is EVIDENCE-POOR — it names an item, and only a ` +N`
// suffix says what state it is in. The sentence it closes with is "wiring it in is the Gear
// planner's job, not this sum's", and this file is that job: a board cell STATES its own
// plus-state (`GearPlanCell.state`, the per-item slider), so the evidence exists here and nowhere
// else. The character sheet's own totals are untouched.
//
// THE PERCENT REFUSAL SURVIVES BY CONSTRUCTION, not by being re-decided. `HASTE` is the one
// percent-valued key in the vector census (gear.ts), and it is spelled back out as `+41%` — so
// `sumGear`'s `statInteger` refuses it exactly as it refuses the two haste items in the owner's
// real dump, and it lands in `GearTotals.unsummed` as the individual values. Whether worn haste
// stacks is a game rule no source in this repo states (law 6); a board that quietly totalled it
// would be inventing one. The surface KEEPS that list visible.
//
// AND A THIRD REFUSAL THE RETIRED FILE HAD NO SOCKETS TO NEED. An exaltation moves an EFFECT, and
// `sumGear` sums `ac`, `stats` and `saves`. So a planned proc contributes exactly nothing to any
// number this file produces, and `gearPlan.plannedSockets` is what the surface lists them from —
// beside the totals, never inside them. A board that drew four socketed effects next to a stat
// total with nothing distinguishing them would be read as having counted them.
//
// ============================================================================
// THE SPELLING TABLE, AND WHY IT IS SAFE
// ============================================================================
// The gear index carries a NUMERIC VECTOR keyed by `normalizeStatKey`'s spelling (MANA → MP,
// REGEN → HP_REGEN — gear.ts states why), and `sumGear` reads `{key, value}` TEXT rows keyed the
// way the wiki writes them, because `statLabel` is what turns a key into a word. So the vector has
// to be spelled back out, and a spelling table is exactly the kind of second alias list this repo
// refuses to keep. It is kept HONEST rather than avoided: every entry is asserted to fold back to
// its own key through PHASE 0's `normalizeStatKey` (`tests/gearPlanTotals.test.mts`, which revives
// that claim from the deleted `tests/gearSet.test.mts`), so the table can never drift from the
// alias table it is the inverse of — a key added to `GEAR_STAT_KEYS` with no spelling here turns
// that test red rather than silently dropping a stat out of every total.

import { sumGear, type GearStat, type GearTotals } from '../characterSheet'
import { damageRatio, statLabel, type ItemStat, type ItemStatBlock } from '../itemStats'
import type { ItemUpgradeState } from '../itemUpgrade'
import {
  GEAR_PERCENT_STAT_KEYS,
  GEAR_STAT_KEYS,
  type GearRow,
  type GearStatKey,
  type GearStats
} from './gear'
import { scaleGearStats } from './gearScale'
import { filledCells, wornState, type GearPlan, type GearPlanCell, type GearPlanSocket } from './gearPlan'
import type { PlanSlotId, SocketType } from './types'

// ---- the vector, spelled the way an item page spells it --------------------------------------

/**
 * The six keys that are STRUCTURAL fields of an `ItemStatBlock` rather than `KEY: value` rows —
 * so they are never `stats` entries, and `sumGear` (which sums `ac`, `stats` and `saves` only)
 * never sees them. That is the right answer and not an omission: a board's total DMG is not a
 * number anybody wears, and the per-cell numbers state each weapon's own.
 */
const STRUCTURAL_KEYS: readonly GearStatKey[] = [
  'DMG',
  'DELAY',
  'DMG_BONUS',
  'BACKSTAB',
  'RANGE',
  'WEIGHT'
]

const STRUCTURAL_SET: ReadonlySet<string> = new Set<string>(STRUCTURAL_KEYS)
const PERCENT_SET: ReadonlySet<string> = new Set<string>(GEAR_PERCENT_STAT_KEYS)

/**
 * Vector key → the key an item page writes, for the twenty-five keys that become `{key, value}`
 * rows. `AC` is absent because it is `ItemStatBlock.ac`, a number of its own, and the six
 * structural keys are absent for the reason above.
 *
 * Every entry folds back to its own key through `normalizeStatKey` — the test asserts it.
 */
export const GEAR_STAT_SPELLING: Partial<Record<GearStatKey, string>> = {
  STR: 'STR',
  STA: 'STA',
  AGI: 'AGI',
  DEX: 'DEX',
  WIS: 'WIS',
  INT: 'INT',
  CHA: 'CHA',
  HP: 'HP',
  MP: 'MANA',
  END: 'END',
  HP_REGEN: 'Regen',
  MANA_REGEN: 'Mana Regen',
  END_REGEN: 'End Regen',
  ATTACK: 'Attack',
  HASTE: 'Haste',
  SV_FIRE: 'SV FIRE',
  SV_COLD: 'SV COLD',
  SV_MAGIC: 'SV MAGIC',
  SV_DISEASE: 'SV DISEASE',
  SV_POISON: 'SV POISON',
  SV_VOID: 'SV VOID',
  SV_CORRUPTION: 'SV CORRUPTION',
  SV_CHROMATIC: 'SV CHROMATIC',
  SV_PRISMATIC: 'SV PRISMATIC',
  SV_ALL: 'SV ALL'
}

/** `15` → `+15`, `-3` → `-3`, and a percent key carries its unit — which is what gets it refused. */
function statValueText(key: GearStatKey, value: number): string {
  const body = value > 0 ? `+${String(value)}` : String(value)
  return PERCENT_SET.has(key) ? `${body}%` : body
}

/** The `{key, value}` rows, split into the two lists the item window splits them into. */
function statRows(stats: GearStats): { stats: ItemStat[]; saves: ItemStat[] } {
  const rows: ItemStat[] = []
  const saves: ItemStat[] = []
  for (const [raw, value] of Object.entries(stats)) {
    const key = raw as GearStatKey
    if (value === undefined || key === 'AC' || STRUCTURAL_SET.has(key)) continue
    const spelling = GEAR_STAT_SPELLING[key]
    if (spelling === undefined) continue
    ;(key.startsWith('SV_') ? saves : rows).push({ key: spelling, value: statValueText(key, value) })
  }
  return { stats: rows, saves }
}

/**
 * A SCALED vector as an `ItemStatBlock`, which is the only shape `sumGear` reads.
 *
 * The block is deliberately thin: flags, classes, effects and sockets are not part of a total and
 * carrying them would invite somebody to sum those too. `ac` and the two row lists are the whole
 * contribution, and the structural numbers ride along as the fields they belong in so the block
 * is a truthful description of the item rather than a fold input in disguise.
 */
export function statBlockFromVector(stats: GearStats): ItemStatBlock {
  const { stats: rows, saves } = statRows(stats)
  const block: ItemStatBlock = {
    flags: [],
    stats: rows,
    saves,
    effects: [],
    exaltationSlots: [],
    extras: []
  }
  if (stats.AC !== undefined) block.ac = stats.AC
  if (stats.DMG !== undefined) block.dmg = stats.DMG
  if (stats.DELAY !== undefined) block.atkDelay = stats.DELAY
  if (stats.DMG_BONUS !== undefined) block.dmgBonus = stats.DMG_BONUS
  if (stats.BACKSTAB !== undefined) block.backstab = stats.BACKSTAB
  if (stats.WEIGHT !== undefined) block.weight = stats.WEIGHT.toFixed(1)
  return block
}

/**
 * ONE CELL'S CONTRIBUTION: its corpus row, scaled to ITS OWN plus-state, as a stat block.
 *
 * `scaleGearStats` is phase 0's arithmetic reached through phase 2's vector — including the
 * synthetic `SV VOID` line an upgrade grants (`GearRow.voidSynth`), which is why the totals of a
 * merged board can carry a save no base item states.
 */
export function cellBlock(row: GearRow, state: ItemUpgradeState): ItemStatBlock {
  return statBlockFromVector(scaleGearStats(row.stats, state, row.voidSynth === true))
}

/**
 * WHAT ONE CELL CONTRIBUTES, in the same words the totals row uses (`statLabel`, so "Strength"
 * here and "Strength" there — a cell that spelled it `STR` would read as a different quantity).
 *
 * AC leads because it is the one attribute the block stores as a number of its own, and it is the
 * number a wearer reads first. Percent-valued rows are IN this list and carry their `%`: a cell
 * states what the item says even though the totals refuse to add it up, which is precisely the
 * distinction `GearTotals.unsummed` exists to draw.
 */
export function cellStatLine(block: ItemStatBlock): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = []
  if (block.ac !== undefined) out.push({ label: 'AC', value: statValueText('AC', block.ac) })
  for (const row of [...block.stats, ...block.saves]) {
    out.push({ label: statLabel(row.key), value: row.value })
  }
  return out
}

// ---- the totals -------------------------------------------------------------------------------

/** How a caller resolves a cell's `key` to its corpus row. `undefined` = the corpus has none. */
export type GearRowLookup = (key: string) => GearRow | undefined

/**
 * THE BOARD'S TOTALS. One block per filled cell, in board order, handed to `sumGear`.
 *
 * A cell whose key the corpus cannot resolve contributes `undefined` — which `sumGear` already
 * counts as `unknown` and adds to nothing, and which the panel states out loud. That is the same
 * honesty the character sheet applies to `Djarn's Amethyst Ring`, reached by the same route rather
 * than by a second convention.
 */
export function gearPlanTotals(gearPlan: GearPlan, lookup: GearRowLookup): GearTotals {
  return sumGear(
    filledCells(gearPlan).map(({ planned }) => {
      const row = lookup(planned.key)
      return row === undefined ? undefined : cellBlock(row, planned.state)
    })
  )
}

// ---- what you are actually wearing --------------------------------------------------------------

/** One equipped row as the diff needs it — `PlannerInventoryHost`, structurally. */
export interface EquippedHost {
  slot: PlanSlotId
  name: string
  key: string
  /** the ` +N` the dump's item name stated; ABSENT means it stated none, never tier 0 */
  tier?: number
  /** `itemKey` of each donor the dump names in this item's sockets, in file order */
  exaltationKeys?: string[]
  /** those donors' display names, same order — carried so a resolved socket can read as itself */
  exaltations?: string[]
}

/**
 * WHAT A DONOR KEY OFFERS, so `equippedRead` can turn the dump's donor NAMES into planned sockets.
 *
 * THE DUMP NAMES A DONOR AND NEVER AN EFFECT (inventorySlots.ts states why), so the socket a
 * worn exaltation occupies is not in the file — it is in the CORPUS, which knows which effects
 * that donor carries and which socket each occupies. The caller injects that lookup because this
 * module is pure and the corpus lives behind an IPC read.
 *
 * MEASURED BEFORE IT WAS RELIED ON: of 1,448 donor keys in the committed corpus, THREE (0.2%)
 * carry two or more effects in the SAME socket. For every other donor the pair is determined, and
 * for those three it is genuinely ambiguous — so `equippedRead` fills the sockets it can name and
 * leaves the rest empty rather than picking one. An unfilled socket is the honest answer; a
 * guessed one would be a plan the user never made.
 */
export type DonorOffers = (donorKey: string) => readonly { effect: string; socket: SocketType }[]

/** The equipped gear plan read as a board, plus the one thing the dump could not say. */
export interface EquippedRead {
  gearPlan: GearPlan
  /**
   * How many worn items carried NO ` +N` suffix and are therefore read AT BASE.
   *
   * The dump states a tier only when the name carries one (`inventorySlots.ts`: absent means the
   * name said nothing, NOT tier 0), so reading those at base is a choice this app makes and the
   * panel says so. It is the right direction: an unmerged item prints no suffix, so base is what
   * the common case actually is, and a comparison that refused to read them at all would answer
   * nothing for a character who has merged one item.
   */
  unstated: number
  /**
   * How many socketed exaltations the dump named that are NOT in a socket on this board.
   *
   * The file names the DONOR item, never the effect, and never which of the four sockets the
   * extraction went into. Usually the corpus settles it — one donor, one effect, one socket. When
   * it does not (a donor carrying two effects in one socket, a donor the corpus has no row for, or
   * a socket an earlier donor already took) the socket is left EMPTY and counted here.
   *
   * IT COUNTS THE NOT-ATTEMPTED CASE TOO, and that is the whole reason it is a total rather than a
   * failure count. Called with no `offers` — the state this window is in for as long as the donor
   * corpus is still in flight — NOTHING can be placed, and reporting a comfortable zero there is
   * precisely what let a load run against an empty corpus and look like it had worked. The honest
   * reading of this number is "the dump says this many, and this many are not on the board"; WHY is
   * a question the caller is better placed to answer than this fold.
   *
   * It is a count and not a warning: law 1 — the app failing to know something is not the same as
   * the character having nothing there, and the surface says which of the two it means.
   */
  unresolved: number
}

/**
 * WHAT IS ON THE CHARACTER RIGHT NOW, as a board the same totals fold can read.
 *
 * The hosts come from `shared/planner/inventorySlots.ts equippedHosts` — the one reader of the
 * game's own `/outputfile inventory` dump, cells and all (both ears, both rings, both any-slots),
 * joined to `itemKey` in main. Nothing here re-decides which row is worn.
 *
 * SOCKETS ARE READ TOO, SINCE THE HOST CARRIES THEM — and only as far as the evidence goes. The
 * dump names a DONOR per socketed exaltation and never the effect, so `offers` resolves that donor
 * through the corpus; a socket is filled only when the donor offers exactly ONE effect for it.
 * Everything else is counted in `unresolved` and left empty, because a guessed socket is a plan the
 * user never made.
 *
 * WITHOUT AN `offers` RESOLVER NOTHING IS FILLED AND EVERYTHING IS COUNTED. A caller that only
 * wants the item-and-tier comparison may omit it and ignore the number; a caller that is about to
 * WRITE this read into the user's document must not, because "no corpus yet" and "no exaltations"
 * produce the same empty sockets and only this count tells them apart.
 */
export function equippedRead(
  hosts: readonly EquippedHost[],
  now = 0,
  offers?: DonorOffers
): EquippedRead {
  const cells: Partial<Record<PlanSlotId, GearPlanCell>> = {}
  let unstated = 0
  let unresolved = 0
  for (const host of hosts) {
    if (host.tier === undefined) unstated += 1
    const read = wornSockets(host, offers)
    unresolved += read.unresolved
    cells[host.slot] = {
      key: host.key,
      name: host.name,
      state: wornState(host.tier),
      sockets: read.sockets
    }
  }
  return { gearPlan: { cells, updatedAt: now }, unstated, unresolved }
}

/**
 * One host's worn exaltations, resolved as far as the corpus allows.
 *
 * A DONOR IS SKIPPED, NOT GUESSED, when the corpus does not carry it, when it offers nothing for
 * any socket, or when the socket it would fill is already taken by an earlier donor — the file's
 * order is all the tie-break there is, and two donors claiming one socket is a state this app
 * cannot resolve from what the client wrote.
 *
 * NO RESOLVER MEANS EVERY DONOR IS UNRESOLVED, not zero of them. See `EquippedRead.unresolved`.
 */
function wornSockets(
  host: EquippedHost,
  offers?: DonorOffers
): { sockets: Partial<Record<SocketType, GearPlanSocket>>; unresolved: number } {
  const sockets: Partial<Record<SocketType, GearPlanSocket>> = {}
  const keys = host.exaltationKeys ?? []
  if (keys.length === 0) return { sockets, unresolved: 0 }
  if (offers === undefined) return { sockets, unresolved: keys.length }

  let unresolved = 0
  keys.forEach((donorKey, i) => {
    const rows = offers(donorKey)
    // Exactly one candidate for exactly one socket, and that socket still free. Anything else is
    // the 0.2% the measurement found, or a corpus miss — either way, not something to invent.
    const bySocket = new Map<SocketType, { effect: string; socket: SocketType }[]>()
    for (const row of rows) {
      const list = bySocket.get(row.socket)
      if (list) list.push(row)
      else bySocket.set(row.socket, [row])
    }
    const only = [...bySocket].filter(([socket, list]) => list.length === 1 && sockets[socket] === undefined)
    if (only.length !== 1) {
      unresolved += 1
      return
    }
    const [socket, [row]] = only[0]
    sockets[socket] = {
      effect: row.effect,
      donorKey,
      donorName: host.exaltations?.[i] ?? donorKey
    }
  })
  return { sockets, unresolved }
}

/** One stat that MOVED between two items, at the tiers each is actually at. */
export interface CellDelta {
  key: GearStatKey
  /** planned minus worn; never zero — an unmoved stat is not in this list */
  delta: number
}

/**
 * WHAT ONE CELL'S PLAN WOULD CHANGE, against the item worn in the same cell.
 *
 * ABSENT IS ZERO HERE, AND THAT IS NOT A LAW-1 VIOLATION — it is the rule the rest of this file
 * already runs on. `sumGear` folds these same vectors and a key no row states contributes nothing;
 * if absence meant "unknown" rather than "none", every total on this board would already be a lie.
 * A scraped item page lists what the item gives, so a page without `STR` is an item without STR.
 *
 * THIS IS WHY IT IS NOT `gearCompare.compareStats`, which answers a NEIGHBOURING question for the
 * Gear tab's hover card: there, a key one side omits reads `10 vs none`, because a card explaining
 * one item should not pretend to a subtraction. Rendered per cell across twenty-three cards that
 * phrasing buried the four numbers that moved under eight that only said "the other page is quiet".
 * Same inputs, different question, and the board's own arithmetic settles which answer belongs here.
 *
 * PERCENTAGES ARE FINE IN A DELTA even though `sumGear` refuses to add them across items: the
 * refusal is about STACKING two haste sources, and this subtracts one item from one other item.
 */
export function cellDelta(planned: GearStats, worn: GearStats): CellDelta[] {
  const out: CellDelta[] = []
  for (const key of GEAR_STAT_KEYS) {
    const delta = (planned[key] ?? 0) - (worn[key] ?? 0)
    if (delta !== 0) out.push({ key, delta })
  }
  return out
}

/**
 * A WEAPON'S THREE NUMBERS. `null` for everything that is not a weapon, which is most of the board.
 *
 * RATIO IS DERIVED AND NOT A VECTOR KEY, which is why it cannot ride in `cellDelta` and gets its
 * own line instead. `GEAR_STAT_KEYS` indexes what an item page STATES; damage over delay is a
 * quotient this app computes, and `damageRatio` is the one place it is computed (the Gear tab's
 * `RATIO` column reads the same function).
 *
 * IT IS THE NUMBER THE TIER SLIDER IS FOR. `scaleGearStat` scales DMG and deliberately leaves DELAY
 * alone — `gearScale.ts` calls that out as "a game fact with a consequence (it is the whole reason a
 * weapon's damage RATIO improves)". So on a board where every cell states its own `+N`, the ratio is
 * the number that moves when you drag, and the surface that lets you drag was the one surface not
 * showing it.
 *
 * BOTH INPUTS OR NOTHING. `damageRatio` returns `undefined` when either is missing or zero, and that
 * propagates here rather than being filled in: a page that states a damage and no delay is not a
 * weapon this app can rate, and half a ratio is not a number.
 */
export interface WeaponFacts {
  dmg: number
  delay: number
  /** damage ÷ delay, unrounded — the renderer decides how many places to print. */
  ratio: number
}

/** One item's weapon numbers at whatever tier its stats were already scaled to. */
export function weaponFacts(stats: GearStats): WeaponFacts | null {
  const { DMG: dmg, DELAY: delay } = stats
  const ratio = damageRatio(dmg, delay)
  if (ratio === undefined || dmg === undefined || delay === undefined) return null
  return { dmg, delay, ratio }
}

/**
 * THE TWO STATS A SMALLER NUMBER IS BETTER ON.
 *
 * `DELAY` is the time between swings, so less of it is more attacks; `WEIGHT` is what you carry
 * against your encumbrance limit, so less of it is more of everything else. Every other key in
 * `GEAR_STAT_KEYS` is a quantity you want more of, including the saves — the corpus states those as
 * resistances, not as the damage taken.
 *
 * THIS SET EXISTS BECAUSE A SIGN IS NOT A VERDICT, and until it did, `WEIGHT -1.6` was drawn as a
 * cost, in the adverse colour, next to a red minus. It was one of the better things about the item.
 */
const LOWER_IS_BETTER: ReadonlySet<GearStatKey> = new Set<GearStatKey>(['DELAY', 'WEIGHT'])

/** Would this movement please the person wearing it? The sign, corrected for what the stat IS. */
export function isImprovement(entry: CellDelta): boolean {
  return LOWER_IS_BETTER.has(entry.key) ? entry.delta < 0 : entry.delta > 0
}

/**
 * A delta list cut into what it GIVES and what it COSTS, each half keeping `GEAR_STAT_KEYS` order.
 *
 * Sign order is the order `cellDelta` produces, and it is the wrong order to READ. A good item and
 * a bad one both come back as one interleaved run — `AC +12 · AGI -3 · STR +8 · SV MAGIC -8` — so
 * the question actually being asked ("what does this cost me") gets answered by hunting for minus
 * signs down a row of sixteen entries. Two runs answer it without reading the numbers at all.
 *
 * IT SPLITS ON `isImprovement`, NOT ON THE SIGN, which is the same distinction and only looks like
 * it in the common case. `WEIGHT -1.6` belongs with the gains and keeps its minus sign: the number
 * is what the arithmetic says and the group is what it MEANS, and a surface that grouped by sign
 * would file a lighter helm under what it costs you.
 *
 * THE ORDER INSIDE EACH HALF IS DELIBERATELY NOT BY MAGNITUDE. `GEAR_STAT_KEYS` is the order the
 * Character tab prints, and the totals panel's standing rule is that a number reads in the same
 * place it reads there. Sorting by size would land the same stat somewhere new on every candidate
 * row, which costs more scanning than putting the biggest gain first buys.
 *
 * ZERO CANNOT APPEAR IN EITHER HALF — `CellDelta.delta` is never zero — so `gains.length +
 * losses.length === delta.length`, and the caller never has to draw a third group.
 */
export function splitDelta(delta: readonly CellDelta[]): {
  gains: CellDelta[]
  losses: CellDelta[]
} {
  return {
    gains: delta.filter(isImprovement),
    losses: delta.filter((e) => !isImprovement(e))
  }
}

// ---- the diff -----------------------------------------------------------------------------------

/** One stat, both ways round. `delta` is the plan MINUS what is worn — the number a planner reads. */
export interface GearDiffRow {
  label: string
  plan: number
  equipped: number
  delta: number
}

/** The whole comparison. `unsummed` is NOT diffed — see `gearPlanDiff`. */
export interface GearPlanDiff {
  ac: GearDiffRow
  stats: GearDiffRow[]
  saves: GearDiffRow[]
  /** rows whose delta is not zero — the count the summary line states */
  changed: number
  /** cells the plan fills that the character is not wearing the same item in */
  cellsChanged: number
}

function rowsOf(stats: readonly GearStat[]): Map<string, number> {
  return new Map(stats.map((s) => [s.label, s.total]))
}

/**
 * The labels of both sides, in the PLAN's order first and the worn-only ones appended. `sumGear`
 * already ordered each side (`STAT_ORDER`, then alphabetical), so this preserves the reading order
 * a player already knows from the character sheet instead of imposing a third one.
 */
function mergedLabels(plan: readonly GearStat[], equipped: readonly GearStat[]): string[] {
  const out = plan.map((s) => s.label)
  for (const s of equipped) if (!out.includes(s.label)) out.push(s.label)
  return out
}

function diffRows(plan: readonly GearStat[], equipped: readonly GearStat[]): GearDiffRow[] {
  const a = rowsOf(plan)
  const b = rowsOf(equipped)
  return mergedLabels(plan, equipped).map((label) => {
    const mine = a.get(label) ?? 0
    const worn = b.get(label) ?? 0
    return { label, plan: mine, equipped: worn, delta: mine - worn }
  })
}

/**
 * How many CELLS the plan would actually change. A cell the plan leaves empty is not a change —
 * a board is a plan for the cells it names, and reading an empty cell as "take that off" would
 * turn every half-finished board into a proposal to strip the character.
 *
 * The plus-state counts: planning the sword you are already wearing at +7 when it is at +5 IS a
 * change, and it is the change a merge plan is made of. Sockets do NOT count, because the worn
 * side cannot state them (see `equippedRead`) and counting a difference against a blank would
 * report every planned exaltation as a change forever.
 */
function sameCell(a: GearPlanCell, b: GearPlanCell): boolean {
  return a.key === b.key && a.state.full === b.state.full && a.state.fraction === b.state.fraction
}

function changedCells(plan: GearPlan, equipped: GearPlan): number {
  return filledCells(plan).filter(({ cell, planned }) => {
    const worn = equipped.cells[cell]
    return worn === undefined || !sameCell(worn, planned)
  }).length
}

/**
 * THE PLAN AGAINST THE BODY. Every summable row on either side, with the delta.
 *
 * THE UNSUMMED LIST IS NOT DIFFED, and that is the percent refusal again rather than an omission:
 * subtracting `+36%` from `+21%` would be arithmetic on values this repo has already said it
 * cannot add. Both sides' unsummed lists stay visible, side by side, and the reader decides.
 */
export function gearPlanDiff(
  totals: { plan: GearTotals; equipped: GearTotals },
  boards: { plan: GearPlan; equipped: GearPlan }
): GearPlanDiff {
  const ac: GearDiffRow = {
    label: 'AC',
    plan: totals.plan.ac,
    equipped: totals.equipped.ac,
    delta: totals.plan.ac - totals.equipped.ac
  }
  const stats = diffRows(totals.plan.stats, totals.equipped.stats)
  const saves = diffRows(totals.plan.saves, totals.equipped.saves)
  const changed = [ac, ...stats, ...saves].filter((r) => r.delta !== 0).length
  return { ac, stats, saves, changed, cellsChanged: changedCells(boards.plan, boards.equipped) }
}
