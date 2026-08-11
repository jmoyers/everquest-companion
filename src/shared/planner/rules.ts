// planner/rules.ts — the exaltation RULES as pure functions (design §3.3).
//
// Every number here is DERIVED from the encoded rules in ../itemStats (EXALTATION_SLOT_TYPES,
// expToNextTier), never re-declared: the tier table and the merge-XP curve have exactly one home
// in this repo, and a planner that hardcoded "+4 costs 15" would drift from the item window the
// day the wiki corrects itself.
//
// The rules being enforced (docs/plans/exaltation-planner.md §1, verified 2026-08-04):
//   R1  a socket type unlocks at an item tier — Focus +1, Click +2, Worn +3, Proc +4 — and the
//       SAME threshold is the extraction threshold on the donor side.
//   R2  a transfer needs a shared equipment SLOT and at least one shared CLASS; socketing then
//       NARROWS the host's class list to the overlap. Wide-class donors are the valuable ones.
//   R3  haste never travels (../normalize.ts isHasteEffect owns which effects are haste).
//   R4  cost is merge XP: reaching tier T costs 2^T − 1 cumulative, and a difficulty-tier drop
//       is worth 2^n (D0=1 … D4=16) AND arrives pre-plussed at +n.

import { EXALTATION_SLOT_TYPES, expToNextTier } from '../itemStats'
import { hostSlotsOf, planSlotLabel } from './types'
import type { ClassAbbr } from '../classCombo'
import type {
  EquipSlot,
  ExaltPlan,
  ExtractTier,
  PlanSlotId,
  PlanSocket,
  PlannerDonor,
  SocketType
} from './types'

// ---- R1: which tier extracts which socket ---------------------------------------

/**
 * The merge tier a donor must reach before this socket's effect can be pulled out.
 *
 * Read out of `EXALTATION_SLOT_TYPES` rather than restated. The fallback is the STRICTEST tier:
 * if that table ever stopped naming a socket we would over-state the cost rather than promise an
 * extraction the game won't allow — and `plannerRules.test.mts` pins all four, so it can't apply
 * silently.
 */
export function extractionTier(socket: SocketType): ExtractTier {
  const row = EXALTATION_SLOT_TYPES.find((s) => s.type.toLowerCase() === socket)
  const t = row?.unlocksAt
  return t === 1 || t === 2 || t === 3 || t === 4 ? t : 4
}

// ---- R2: compatibility ----------------------------------------------------------

/** Why a donor cannot be socketed here. `haste` first — it is a property of the effect itself. */
export type IncompatibleReason = 'haste' | 'slot' | 'class'

export type SocketCompatibility = { ok: true } | { ok: false; reason: IncompatibleReason }

const OK: SocketCompatibility = { ok: true }

/**
 * Can this donor's effect be socketed into a host occupying `hostSlots`, on a set targeting
 * `planClasses`?
 *
 * Unknowns are NOT passes (law 1): a donor whose page stated no slot (`slots: []`) or no class
 * list (`classes: []`) cannot be PROVEN compatible, so it reports the missing dimension and the
 * UI says which fact is absent. The one deliberate exception is an empty `planClasses` — a set
 * that has not chosen a trio yet is asking for no class filter, not for zero classes.
 */
export function socketCompatibility(
  donor: PlannerDonor,
  hostSlots: readonly EquipSlot[],
  planClasses: readonly ClassAbbr[]
): SocketCompatibility {
  if (donor.hasteLocked) return { ok: false, reason: 'haste' }
  if (!donor.slots.some((s) => hostSlots.includes(s))) return { ok: false, reason: 'slot' }
  if (planClasses.length === 0) return OK
  if (!donor.classes.some((c) => planClasses.includes(c))) return { ok: false, reason: 'class' }
  return OK
}

/**
 * R2's side effect: socketing narrows the HOST's class list to the overlap with the donor's.
 * Shown on the host line whenever a socket is planned — this is how a 6-class sword silently
 * becomes a 4-class sword.
 *
 * An empty list means UNKNOWN, so narrowing against one returns the other side unchanged rather
 * than claiming an intersection nobody stated (an empty result would read as "usable by nobody").
 */
export function narrowedClasses(
  hostClasses: readonly ClassAbbr[],
  donorClasses: readonly ClassAbbr[]
): ClassAbbr[] {
  if (hostClasses.length === 0) return [...donorClasses]
  if (donorClasses.length === 0) return [...hostClasses]
  return hostClasses.filter((c) => donorClasses.includes(c))
}

// ---- R4: what the merge costs ---------------------------------------------------

/** The difficulty tier a D4 instance drop arrives at — pre-plussed, per R4. */
const D4_DROP_TIER = 4

/** Cumulative merge XP to reach `tier` from a fresh drop: Σ expToNextTier(0…tier-1) = 2^tier − 1. */
function cumulativeXp(tier: number): number {
  let xp = 0
  for (let t = 0; t < tier; t++) xp += expToNextTier(t) ?? 0
  return xp
}

export interface ExtractionCost {
  tier: ExtractTier
  /** cumulative merge XP the donor must bank (2^tier − 1) */
  xp: number
  /** D0 copies still to farm, given you already hold one — each is worth 1 XP, so this IS the XP */
  d0Copies: number
  /** D4 copies still to farm — a D4 drop lands at +4, so one drop is already extractable */
  d4Copies: number
}

/**
 * The honest farm estimate for extracting an effect: "≈15 D0 copies, or 1 D4 copy" (R4).
 *
 * Both counts answer the SAME question — how many more drops must you farm, assuming you already
 * hold one copy of the item. A D0 copy adds 1 XP per merge, so a +4 proc donor wants 15 of them.
 * A D4 copy is worth 16 XP AND arrives pre-plussed at +4, so for every tier the planner cares
 * about (1–4) the very first D4 drop is already extractable with zero merging.
 */
export function extractionCost(tierRequired: ExtractTier): ExtractionCost {
  const xp = cumulativeXp(tierRequired)
  const banked = cumulativeXp(D4_DROP_TIER)
  const d4Copies = banked >= xp ? 1 : Math.ceil((xp - banked) / 2 ** D4_DROP_TIER) + 1
  return { tier: tierRequired, xp, d0Copies: xp, d4Copies }
}

// ---- set-level lint -------------------------------------------------------------

export type PlanWarningKind = 'unknown-donor' | 'haste' | 'slot' | 'class' | 'no-host'

export interface PlanWarning {
  /** the CELL, so a warning about your second ring says so (JOS-67) */
  slot: PlanSlotId
  /** absent for a slot-level warning ('no-host') */
  socket?: SocketType
  kind: PlanWarningKind
  donorKey?: string
  /** short state phrasing for the UI chip ("Ghoulbane — haste can't be moved") */
  message: string
}

/**
 * A donor key maps to MANY rows — one per effect on that item — so the lookup is a list and the
 * planned effect picks the row. (The design wrote `donorsByKey`; one row per key cannot express
 * an item with a proc and a click.)
 */
export type DonorIndex = ReadonlyMap<string, readonly PlannerDonor[]>

interface WarnCtx {
  /** the cell being linted; `hostSlotsOf` is what R2 is actually asked about */
  cell: PlanSlotId
  classes: readonly ClassAbbr[]
  donors: DonorIndex
}

const REASON_MESSAGE: Record<IncompatibleReason, (donor: PlannerDonor, ctx: WarnCtx) => string> = {
  haste: (d) => `${d.name} - haste can't be moved`,
  // Named by CELL, because "can't go in FINGER 2" is what the user is looking at; the RULE it
  // failed is about the slot, and `socketCompatibility` below is asked in those terms.
  slot: (d, ctx) => `${d.name} can't go in ${planSlotLabel(ctx.cell)}`,
  class: (d, ctx) => `${d.name} - no class overlap with ${ctx.classes.join('/')}`
}

function socketWarning(ctx: WarnCtx, socket: SocketType, planned: PlanSocket): PlanWarning | null {
  const donor = ctx.donors.get(planned.donorKey)?.find((d) => d.effect === planned.effect)
  if (!donor) {
    return {
      slot: ctx.cell,
      socket,
      kind: 'unknown-donor',
      donorKey: planned.donorKey,
      message: `${planned.effect} - no donor item in the database`
    }
  }
  // `hostSlotsOf`, not the cell's own slot: an any-cell (JOS-104) constrains no slot, so it hands
  // R2 all eighteen and the slot half simply cannot fail there. The class half is untouched — an
  // any-slot is a place to wear something, never a permit to socket a Ranger proc into a robe.
  const compat = socketCompatibility(donor, hostSlotsOf(ctx.cell), ctx.classes)
  if (compat.ok) return null
  return {
    slot: ctx.cell,
    socket,
    kind: compat.reason,
    donorKey: donor.key,
    message: REASON_MESSAGE[compat.reason](donor, ctx)
  }
}

/**
 * Set-level lint: every planned socket whose donor is unreachable (class-incompatible with the
 * set's trio, wrong slot, haste-locked, or absent from the DB), plus slots that plan sockets with
 * no host item picked. Decoration-free — this reads the PLAN, never the user's inventory.
 */
export function planWarnings(plan: ExaltPlan, donorsByKey: DonorIndex): PlanWarning[] {
  const out: PlanWarning[] = []
  for (const [slotName, planSlot] of Object.entries(plan.slots)) {
    if (!planSlot) continue
    const cell = slotName as PlanSlotId
    const entries = Object.entries(planSlot.sockets) as [SocketType, PlanSocket | undefined][]
    const ctx: WarnCtx = { cell, classes: plan.classes, donors: donorsByKey }
    if (planSlot.hostKey == null && entries.some(([, s]) => s != null)) {
      out.push({ slot: cell, kind: 'no-host', message: 'No host item picked' })
    }
    for (const [socket, planned] of entries) {
      const warning = planned == null ? null : socketWarning(ctx, socket, planned)
      if (warning) out.push(warning)
    }
  }
  return out
}
