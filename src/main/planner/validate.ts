// planner/validate.ts — the one place a stored PLAN is proven to be a plan: exaltation sets
// (`sanitizeExaltPlans`), gear sets since JOS-286 (`sanitizeGearSets`), and the flat wish list
// since JOS-326 (`sanitizeWishlist`).
//
// TWO CALLERS, ONE ANSWER (the ipc/knowledge + presencePrefs arrangement):
//   * `IPC.plannerSetPlans` runs it on the way IN. Renderer input is never trusted here, exactly
//     as `combo:setCorrection` and `sounds:getData` are not trusted — today's only caller being
//     the app's own UI is not a security property.
//   * `storePlans.getExaltPlans` runs it on the way OUT, so a hand-edited (or downgrade-written)
//     progress file cannot hand the renderer a shape it will crash on.
// Because both directions pass through here, "what is a valid plan" has exactly one definition
// and the round trip is a fixed point — which is what `tests/plannerStore.test.mts` asserts.
//
// It STRIPS rather than rejects (the profiles/share precedent): an unknown slot key, a fifth
// socket type, a class abbreviation that is not one of the sixteen, a socket with no donor —
// each is dropped and everything else is kept. Refusing the whole write over one bad field would
// lose a user's real work to a typo in a file they may never have edited.
//
// Electron-free and dependency-light on purpose: store.ts imports it from module scope.

import { isClassAbbr, MAX_COMBO_SLOTS, type ClassAbbr } from '../../shared/classCombo'
import { normalizeUpgradeState } from '../../shared/itemUpgrade'
import type { GearAssignment, GearSet } from '../../shared/planner/gearSet'
import type { GearPlan, GearPlanCell, GearPlanSocket } from '../../shared/planner/gearPlan'
import { MAX_WISHES, type WishEntry, type WishList } from '../../shared/planner/wishlist'
import {
  PLAN_SLOTS,
  SOCKET_TYPES,
  type ClassesProvenance,
  type ExaltPlan,
  type PlanSlot,
  type PlanSlotId,
  type PlanSocket,
  type SocketType
} from '../../shared/planner/types'

/** Bounds. Generous — they exist to stop a runaway write, not to tell the user how to plan. */
const MAX_PLANS = 100
const MAX_ID_CHARS = 128
const MAX_NAME_CHARS = 120

// The CELL allowlist, not the equip-slot one (JOS-67): a plan may key `FINGER2`, and it is the
// same list the board draws, so a cell the UI can fill can never be a cell the store strips.
const SLOT_SET: ReadonlySet<string> = new Set<string>(PLAN_SLOTS)
const SOCKET_SET: ReadonlySet<string> = new Set<string>(SOCKET_TYPES)

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A non-empty string, trimmed and capped. `undefined` for anything else. */
function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim().slice(0, max)
  return t === '' ? undefined : t
}

/** A finite timestamp, or `fallback`. Never NaN — a NaN `updatedAt` sorts a set out of existence. */
function stamp(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** The target trio: the 16 known abbreviations only, de-duplicated, at most MAX_COMBO_SLOTS. */
function classes(v: unknown): ClassAbbr[] {
  if (!Array.isArray(v)) return []
  const out: ClassAbbr[] = []
  for (const c of v) {
    if (isClassAbbr(c) && !out.includes(c) && out.length < MAX_COMBO_SLOTS) out.push(c)
  }
  return out
}

/**
 * V2's provenance flag, and it is DROPPED rather than defaulted when it is absent or unknown.
 * Absent already means `user` to every reader (types.ts), so writing one in would change a stored
 * set's bytes for no change in meaning — and this function is the read path too, where that would
 * rewrite files the planner never touched.
 */
function provenance(v: unknown): ClassesProvenance | undefined {
  return v === 'detected' || v === 'user' ? v : undefined
}

function planSocket(v: unknown): PlanSocket | undefined {
  if (!isRecord(v)) return undefined
  const effect = text(v.effect, MAX_NAME_CHARS)
  const donorKey = text(v.donorKey, MAX_ID_CHARS)
  // Both halves or nothing: a socket naming an effect with no donor cannot be farmed, and one
  // naming a donor with no effect cannot say what it would extract.
  return effect && donorKey ? { effect, donorKey } : undefined
}

function planSlot(v: unknown): PlanSlot | undefined {
  if (!isRecord(v)) return undefined
  const sockets: Partial<Record<SocketType, PlanSocket>> = {}
  const raw = isRecord(v.sockets) ? v.sockets : {}
  for (const [name, value] of Object.entries(raw)) {
    if (!SOCKET_SET.has(name)) continue
    const socket = planSocket(value)
    if (socket) sockets[name as SocketType] = socket
  }
  const hostKey = text(v.hostKey, MAX_ID_CHARS)
  const hostName = text(v.hostName, MAX_NAME_CHARS)
  const slot: PlanSlot = { sockets }
  if (hostKey) slot.hostKey = hostKey
  if (hostName) slot.hostName = hostName
  // An empty cell is not a plan: no host, no sockets, nothing to store.
  return slot.hostKey || Object.keys(sockets).length > 0 ? slot : undefined
}

function planSlots(v: unknown): Partial<Record<PlanSlotId, PlanSlot>> {
  const out: Partial<Record<PlanSlotId, PlanSlot>> = {}
  if (!isRecord(v)) return out
  for (const [name, value] of Object.entries(v)) {
    if (!SLOT_SET.has(name)) continue
    const slot = planSlot(value)
    if (slot) out[name as PlanSlotId] = slot
  }
  return out
}

/** One plan, or `undefined` when it carries no usable identity (an id is the CRUD handle). */
function exaltPlan(v: unknown, now: number): ExaltPlan | undefined {
  if (!isRecord(v)) return undefined
  const id = text(v.id, MAX_ID_CHARS)
  if (!id) return undefined
  const createdAt = stamp(v.createdAt, now)
  const from = provenance(v.classesProvenance)
  const plan: ExaltPlan = {
    id,
    name: text(v.name, MAX_NAME_CHARS) ?? 'Untitled set',
    classes: classes(v.classes),
    createdAt,
    updatedAt: stamp(v.updatedAt, createdAt),
    slots: planSlots(v.slots)
  }
  if (from !== undefined) plan.classesProvenance = from
  return plan
}

/**
 * Whatever the renderer (or the store file) offered → the plans this app will actually keep.
 * Never throws, never rejects the batch: unusable entries are dropped, duplicate ids keep the
 * FIRST occurrence (the renderer's own list order is the user's order).
 */
export function sanitizeExaltPlans(raw: unknown, now: number = Date.now()): ExaltPlan[] {
  if (!Array.isArray(raw)) return []
  const out: ExaltPlan[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (out.length >= MAX_PLANS) break
    const plan = exaltPlan(entry, now)
    if (!plan || seen.has(plan.id)) continue
    seen.add(plan.id)
    out.push(plan)
  }
  return out
}

// ---- gear sets (JOS-286, phase 5) --------------------------------------------------------
//
// THE SAME DOOR, THE SAME DISCIPLINE, A DIFFERENT DOCUMENT. A gear set is a cell → item map with
// a per-assignment plus-state (shared/planner/gearSet.ts), and it goes through this file for
// exactly the reasons the exaltation plans do: `IPC.gearSetSets` runs it on the way IN because
// the renderer is not the authority on what may be stored, and `store.getGearSets` runs it on the
// way OUT so a hand-edited progress file cannot hand the renderer a shape it will crash on. Both
// directions ⇒ one definition ⇒ the round trip is a fixed point (tests/gearSetStore.test.mts).
//
// IT STRIPS RATHER THAN REJECTS, same as above: an unknown cell key, an assignment with no item
// key, a plus-state outside the game's own 0..10 × 0..2^full-1 grid — each is dropped or clamped
// and everything else is kept.
//
// THE PLUS-STATE IS CLAMPED BY PHASE 0'S OWN NORMALIZER (`normalizeUpgradeState`) rather than by
// a range check written here. That function IS the rule about which states exist — tier 0 and
// tier 10 bank nothing, a fraction lives in 0..2^full-1 — and a validator that re-stated it would
// be a second opinion about the game's item window. A state that is not an object at all reads as
// base, which is what an assignment carrying no state means.

/** A plus-state, clamped to a state the game can actually be in. Anything unreadable is base. */
function upgradeState(v: unknown): GearAssignment['state'] {
  if (!isRecord(v)) return normalizeUpgradeState({ full: 0, fraction: 0 })
  const full = typeof v.full === 'number' && Number.isFinite(v.full) ? v.full : 0
  const fraction = typeof v.fraction === 'number' && Number.isFinite(v.fraction) ? v.fraction : 0
  return normalizeUpgradeState({ full, fraction })
}

/** One assigned item, or `undefined` when it names none — a cell with no item is not an assignment. */
function gearAssignment(v: unknown): GearAssignment | undefined {
  if (!isRecord(v)) return undefined
  const key = text(v.key, MAX_ID_CHARS)
  if (!key) return undefined
  return { key, name: text(v.name, MAX_NAME_CHARS) ?? key, state: upgradeState(v.state) }
}

/** The cell map, filtered to the twenty-three cells the board can draw (the `PLAN_SLOTS` allowlist). */
function gearSlots(v: unknown): Partial<Record<PlanSlotId, GearAssignment>> {
  const out: Partial<Record<PlanSlotId, GearAssignment>> = {}
  if (!isRecord(v)) return out
  for (const [name, value] of Object.entries(v)) {
    if (!SLOT_SET.has(name)) continue
    const assignment = gearAssignment(value)
    if (assignment) out[name as PlanSlotId] = assignment
  }
  return out
}

/** One gear set, or `undefined` when it carries no usable identity. */
function gearSet(v: unknown, now: number): GearSet | undefined {
  if (!isRecord(v)) return undefined
  const id = text(v.id, MAX_ID_CHARS)
  if (!id) return undefined
  const createdAt = stamp(v.createdAt, now)
  return {
    id,
    name: text(v.name, MAX_NAME_CHARS) ?? 'Untitled set',
    createdAt,
    updatedAt: stamp(v.updatedAt, createdAt),
    slots: gearSlots(v.slots)
  }
}

/**
 * Whatever the renderer (or the store file) offered → the gear sets this app will actually keep.
 * Never throws, never rejects the batch; duplicate ids keep the FIRST occurrence, which is the
 * renderer's own list order and therefore the user's.
 */
export function sanitizeGearSets(raw: unknown, now: number = Date.now()): GearSet[] {
  if (!Array.isArray(raw)) return []
  const out: GearSet[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (out.length >= MAX_PLANS) break
    const set = gearSet(entry, now)
    if (!set || seen.has(set.id)) continue
    seen.add(set.id)
    out.push(set)
  }
  return out
}

// ---- the flat wish list (JOS-326) -----------------------------------------------------------
//
// THE SAME DOOR AND THE SAME DISCIPLINE, A THIRD TIME. `IPC.wishlistSet` runs this on the way IN
// because the renderer is not the authority on what may be stored, and `storePlans.getWishlist`
// runs it on the way OUT so a hand-edited progress file cannot hand the renderer a shape it will
// crash on. Both directions ⇒ one definition ⇒ the round trip is a fixed point
// (tests/wishlistStore.test.mts).
//
// IT STRIPS RATHER THAN REJECTS: an entry with no item key, a `kind` that is not one of the two,
// a `socket` outside the closed four, a source string nobody writes — each is dropped or
// defaulted and everything else is kept. Losing a user's other forty wishes to one bad line is
// the failure mode.
//
// TWO DEFAULTS ARE DELIBERATE RATHER THAN DROPS. An entry with an unreadable `kind` reads as
// `gear`, which is the shape that claims the LEAST — a gear wish states nothing about an effect —
// and an unreadable `source` reads as `user`, because the only thing `planImport` earns a row is
// a label saying the app put it there, and the app must not claim that about a line it cannot
// account for.
//
// THE DEDUPE IS THE MODEL'S, NOT A NEW RULE. `itemKey` is a wish's whole identity
// (shared/planner/wishlist.ts), so duplicate keys keep the FIRST occurrence — the same choice the
// two lists above make about duplicate ids, and the same reason: the renderer's order is the
// user's order.

/** The four socket types, as the closed allowlist a stored effect context is checked against. */
function wishSocket(v: unknown): SocketType | undefined {
  return typeof v === 'string' && SOCKET_SET.has(v) ? (v as SocketType) : undefined
}

/** One wish, or `undefined` when it names no item — a wish with no item is not a wish. */
function wishEntry(v: unknown, now: number): WishEntry | undefined {
  if (!isRecord(v)) return undefined
  const key = text(v.itemKey, MAX_ID_CHARS)
  if (!key) return undefined
  const entry: WishEntry = {
    itemKey: key,
    name: text(v.name, MAX_NAME_CHARS) ?? key,
    kind: v.kind === 'donor' ? 'donor' : 'gear',
    addedAt: stamp(v.addedAt, now),
    source: v.source === 'planImport' ? 'planImport' : 'user'
  }
  // The effect context is DONOR-ONLY and is dropped wholesale on a gear wish: an effect name on a
  // row that says it is not about an effect is a contradiction, not extra information. Each half
  // is assigned rather than spread so an absent one stays absent instead of becoming `undefined`.
  if (entry.kind === 'donor') {
    const effect = text(v.effect, MAX_NAME_CHARS)
    const socket = wishSocket(v.socket)
    if (effect !== undefined) entry.effect = effect
    if (socket !== undefined) entry.socket = socket
  }
  return entry
}

/**
 * Whatever the renderer (or the store file) offered → the wish list this app will actually keep.
 * Never throws, never rejects the batch; a value that is not a wish-list object at all reads as
 * the empty list, which is what a character who has never opened the tab has.
 */
function wishEntries(raw: unknown, now: number): WishEntry[] {
  const out: WishEntry[] = []
  const seen = new Set<string>()
  for (const value of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_WISHES) break
    const entry = wishEntry(value, now)
    if (!entry || seen.has(entry.itemKey)) continue
    seen.add(entry.itemKey)
    out.push(entry)
  }
  return out
}

/**
 * The done strip's dismissals, filtered to the entries that survived.
 *
 * A dismissal for a wish that is no longer in the list is DROPPED, not kept: it is a statement
 * about a row, and a tombstone outliving its row would swallow the wish if it were ever added
 * again (shared/planner/wishlist.ts `removeWish` makes the same argument from the other side).
 */
function wishDismissals(raw: unknown, entries: readonly WishEntry[]): string[] {
  const live = new Set(entries.map((e) => e.itemKey))
  const out: string[] = []
  for (const value of Array.isArray(raw) ? raw : []) {
    const key = text(value, MAX_ID_CHARS)
    if (key && live.has(key) && !out.includes(key)) out.push(key)
  }
  return out
}

export function sanitizeWishlist(raw: unknown, now: number = Date.now()): WishList {
  if (!isRecord(raw)) return { entries: [], clearedDone: [] }
  const entries = wishEntries(raw.entries, now)
  const list: WishList = { entries, clearedDone: wishDismissals(raw.clearedDone, entries) }
  // Assigned rather than spread, the `classesProvenance` argument exactly: absent already means
  // "never seeded" to every reader, so writing `false` in would change a stored file's bytes for
  // no change in meaning — and this function is the READ path too.
  if (raw.seededFromPlans === true) list.seededFromPlans = true
  return list
}

// ---- the gear plan board ------------------------------------------------------------------------
//
// THE SAME DOOR AND THE SAME DISCIPLINE, A FOURTH TIME. `IPC.gearPlanSet` runs this on the way IN
// because the renderer is not the authority on what may be stored, and `storePlans.getGearPlan`
// runs it on the way OUT so a hand-edited progress file cannot hand the renderer a shape it will
// crash on. Both directions ⇒ one definition ⇒ the round trip is a fixed point
// (tests/gearPlanStore.test.mts).
//
// IT REUSES THE THREE DOORS ABOVE RATHER THAN OPENING A FOURTH VOCABULARY. `SLOT_SET` is the same
// twenty-three-cell allowlist a gear set and an exaltation plan are checked against, `SOCKET_SET`
// the same closed four, and `upgradeState` the same clamp through phase 0's own normalizer. A
// board is the two documents' shapes in one cell, so it is validated by their two validators'
// parts — a new allowlist here would be a second opinion about how many ears a character has.
//
// IT STRIPS RATHER THAN REJECTS: an unknown cell key, a fifth socket type, a socket naming no
// donor, a cell naming no item — each is dropped and everything else is kept. Refusing the whole
// board over one bad field would lose a user's real work to a typo in a file they never edited.
//
// AND IT TOUCHES NOTHING ELSE. `sanitizeGearSets` and `sanitizeExaltPlans` above are unchanged and
// uncalled from here: the two documents they guard are retired from the UI and KEPT ON DISK on an
// owner promise, and this validator neither reads nor rewrites a byte of either.

/** One planned exaltation, or `undefined` when it names no effect or no donor to farm it from. */
function gearPlanSocket(v: unknown): GearPlanSocket | undefined {
  if (!isRecord(v)) return undefined
  const effect = text(v.effect, MAX_NAME_CHARS)
  const donorKey = text(v.donorKey, MAX_ID_CHARS)
  if (!effect || !donorKey) return undefined
  return { effect, donorKey, donorName: text(v.donorName, MAX_NAME_CHARS) ?? donorKey }
}

/** A cell's sockets, filtered to the closed four. A socket the board cannot draw is not stored. */
function gearPlanSockets(v: unknown): Partial<Record<SocketType, GearPlanSocket>> {
  const out: Partial<Record<SocketType, GearPlanSocket>> = {}
  if (!isRecord(v)) return out
  for (const [name, value] of Object.entries(v)) {
    if (!SOCKET_SET.has(name)) continue
    const planned = gearPlanSocket(value)
    if (planned) out[name as SocketType] = planned
  }
  return out
}

/** One planned cell, or `undefined` when it names no item — a cell without an item is not a plan. */
function gearPlanCell(v: unknown): GearPlanCell | undefined {
  if (!isRecord(v)) return undefined
  const key = text(v.key, MAX_ID_CHARS)
  if (!key) return undefined
  return {
    key,
    name: text(v.name, MAX_NAME_CHARS) ?? key,
    state: upgradeState(v.state),
    sockets: gearPlanSockets(v.sockets)
  }
}

/**
 * Whatever the renderer (or the store file) offered → the board this app will actually keep.
 * Never throws, never rejects the document; an unreadable value is an empty board, which is what
 * a character who has never opened the tab has anyway.
 */
export function sanitizeGearPlan(raw: unknown, now: number = Date.now()): GearPlan {
  if (!isRecord(raw)) return { cells: {}, updatedAt: now }
  const cells: Partial<Record<PlanSlotId, GearPlanCell>> = {}
  for (const [name, value] of Object.entries(isRecord(raw.cells) ? raw.cells : {})) {
    if (!SLOT_SET.has(name)) continue
    const planned = gearPlanCell(value)
    if (planned) cells[name as PlanSlotId] = planned
  }
  return { cells, updatedAt: stamp(raw.updatedAt, now) }
}
