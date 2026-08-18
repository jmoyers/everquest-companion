// spells_us.txt -> the resist table (JOS-382).
//
// Pure over a string: no Electron, no node, no worker. `tests/spellsUsParse.test.mts` drives it
// with hand-authored rows so the field map below is pinned by something other than a comment.
//
// WHERE THE DATA COMES FROM, AND WHY IT IS NEVER COMMITTED. The wiki-scraped `spells.json` this
// repo ships knows what a spell's messages are and nothing about how it is resisted — no resist
// type, no resist adjust. The client install has both: `<eqRoot>/spells_us.txt`, 38 MB, caret
// delimited, 73,963 rows including the Legends-only 74xxx ids (Smiting Strike, Scorching Arrow)
// that no wiki has. It is Daybreak's file. We read the player's own copy at runtime and never
// redistribute it or anything derived from it, which is also why the ledger stores observations
// rather than conclusions: nothing on disk in this repo needs the table to be meaningful.
//
// THE FIELD MAP, verified by measurement against the owner's install (2026-08-16):
//
//   0    spell id                       1    name
//   8    cast time, ms                  11   buff duration formula (JOS-396)
//   12   buff duration                  29   resist type (see axisFromResistType)
//   30   target type                    36..51  class levels, WAR..BER (255 = cannot use)
//   78   resist adjust                  172  effect slots, `$`-separated
//
// FIELDS 11 AND 12 WERE ADDED BY JOS-396 and are measured the same way: Odium (id 4093) reads
// `11 = 7`, `12 = 5`, and formula 7 is "as many ticks as the caster's level, capped at field 12" —
// five ticks, thirty seconds, which is the duration the wiki's own page for Odium states and the
// duration the in-game spell window prints. `clientDurationTicks` (shared/spellMetrics.ts) holds
// the formula table and the measurement behind it.
//
// AND ONE CORRECTION TO THE BRIEF, because it was measured rather than assumed: an effect slot is
// `slot | effectId | base | limit | CALC | MAX`, not `… | max | calc`. The proof is Tashani
// (`2|50|-10|0|101|23`): Torven's table says Tashani is -23 magic resist, calc 101 is
// "base + level/2, capped", and 23 is the cap — read the other way round the formula code would
// be 23, which is not a formula, and the cap would be 101, which is not a number Tashani has ever
// produced. Malaisement (`…|-20|0|101|40`) confirms it at -40 all four, and Mesmerization
// (`1|31|2|0|100|55`) puts its documented "up to level 55" in the same position.
//
// EFFECT IDS THIS FILE CARES ABOUT: 0 hitpoints (the damage slot, which decides fixed vs
// variable), 46 fire / 47 cold / 48 poison / 49 disease / 50 magic / 111 all (the tash and malo
// family), 22 charm and 31 mesmerize (the two that carry a hard level cap).

import { axisFromResistType, type ResistAxis, type ResistDebuffSlot, type SpellHpSlot, type SpellResistInfo, type SpellResistTable } from '../../shared/resistTypes'
import { spellCanonKey } from '../log/parseCommon'

const F_ID = 0
const F_NAME = 1
const F_CAST_MS = 8
const F_DURATION_FORMULA = 11
const F_DURATION = 12
const F_RESIST_TYPE = 29
const F_TARGET_TYPE = 30
const F_CLASS_FIRST = 36
const F_CLASS_COUNT = 16
/** Index of the bard among the sixteen class-level fields (WAR CLR PAL RNG SHD DRU MNK BRD …). */
const CLASS_BARD = 7
const F_RESIST_ADJ = 78
const F_SLOTS = 172

const EFFECT_HITPOINTS = 0
const EFFECT_CHARM = 22
const EFFECT_MEZ = 31
const EFFECT_ALL_RESISTS = 111

const RESIST_EFFECTS: Record<number, ResistAxis> = {
  46: 'fire',
  47: 'cold',
  48: 'poison',
  49: 'disease',
  50: 'magic',
}

/**
 * A resist-debuff slot has to be worth something to count. Solon's Bewitching Bravura carries a
 * one-point magic-resist rider on slot 2 and is a CHARM, not a malo; opening an 11-minute debuff
 * window for one point of resist would file every charmed mob's later observations under a
 * condition that never mattered. Five is comfortably below the weakest real member of the family
 * (Tashani, 23) and comfortably above every rider seen in the file.
 */
const MIN_DEBUFF_MAGNITUDE = 5

interface Slot {
  effect: number
  base: number
  calc: number
  max: number
}

function parseSlots(field: string | undefined): Slot[] {
  if (!field) return []
  const out: Slot[] = []
  for (const chunk of field.trim().split('$')) {
    if (!chunk) continue
    const p = chunk.split('|')
    if (p.length < 6) continue
    out.push({ effect: Number(p[1]), base: Number(p[2]), calc: Number(p[4]), max: Number(p[5]) })
  }
  return out
}

function debuffSlots(slots: readonly Slot[]): ResistDebuffSlot[] | undefined {
  const out: ResistDebuffSlot[] = []
  for (const s of slots) {
    const axis = s.effect === EFFECT_ALL_RESISTS ? 'all' : RESIST_EFFECTS[s.effect]
    if (!axis) continue
    // Only DECREASES; a spell that raises a resist is a buff and never opens a window here.
    if (s.base >= 0) continue
    const magnitude = Math.max(Math.abs(s.base), Math.abs(s.max))
    if (magnitude < MIN_DEBUFF_MAGNITUDE) continue
    out.push({ axis, base: s.base, calc: s.calc, max: s.max })
  }
  return out.length > 0 ? out : undefined
}

/**
 * The level cap the game enforces regardless of rc, and ONLY from the primary slot. Chaos Flux
 * carries a stun rider capped at 55; being above it costs the stun, not the nuke, so a rider's
 * cap must never make the whole spell "always resisted" (world-model law 6 — say what the log
 * cannot say, and this one it does not say at all).
 */
function levelCapOf(slots: readonly Slot[]): number | undefined {
  const first = slots[0]
  if (!first) return undefined
  if (first.effect !== EFFECT_CHARM && first.effect !== EFFECT_MEZ) return undefined
  return first.max > 0 ? first.max : undefined
}

function hpSlotOf(slots: readonly Slot[]): SpellResistInfo['hpSlot'] {
  for (const s of slots) {
    if (s.effect === EFFECT_HITPOINTS) return { base: s.base, max: s.max, calc: s.calc }
  }
  return undefined
}

/**
 * EVERY effect-0 slot, in file order, marked per-tick or not (JOS-396).
 *
 * `perTick` is one question of the ROW rather than of the slot — does this spell have a duration at
 * all — and it is written onto each slot because that is where the reader needs it: an effect-0 slot
 * on a duration spell is a DoT/HoT/regen line that lands every tick, and on an instant spell it is
 * the whole hit. Odium's `2|0|-217|0|103|325` with duration formula 7 is the first kind; Bolt of
 * Karana's `1|0|-200|0|100|200` with formula 0 is the second.
 */
function hpSlotsOf(slots: readonly Slot[], perTick: boolean): SpellHpSlot[] | undefined {
  const out: SpellHpSlot[] = []
  for (const s of slots) {
    if (s.effect === EFFECT_HITPOINTS) out.push({ base: s.base, max: s.max, calc: s.calc, perTick })
  }
  return out.length > 0 ? out : undefined
}

function classLevels(f: readonly string[]): { any: boolean; bardOnly: boolean } {
  let any = false
  let nonBard = false
  let bard = false
  for (let i = 0; i < F_CLASS_COUNT; i++) {
    const v = Number(f[F_CLASS_FIRST + i])
    if (!Number.isFinite(v) || v >= 255 || v <= 0) continue
    any = true
    if (i === CLASS_BARD) bard = true
    else nonBard = true
  }
  return { any, bardOnly: bard && !nonBard }
}

function rowInfo(f: readonly string[]): SpellResistInfo {
  const slots = parseSlots(f[F_SLOTS])
  const { bardOnly } = classLevels(f)
  const info: SpellResistInfo = {
    axis: axisFromResistType(Number(f[F_RESIST_TYPE])),
    resistAdj: Number(f[F_RESIST_ADJ]) || 0,
    castMs: Number(f[F_CAST_MS]) || 0,
    targetType: Number(f[F_TARGET_TYPE]) || 0,
  }
  const hp = hpSlotOf(slots)
  if (hp) info.hpSlot = hp
  const formula = Number(f[F_DURATION_FORMULA]) || 0
  const hpSlots = hpSlotsOf(slots, formula !== 0)
  if (hpSlots) {
    info.hp = hpSlots
    if (formula !== 0) info.hpDuration = { formula, value: Number(f[F_DURATION]) || 0 }
  }
  const debuffs = debuffSlots(slots)
  if (debuffs) info.debuffSlots = debuffs
  const cap = levelCapOf(slots)
  if (cap !== undefined) info.levelCap = cap
  if (bardOnly) info.song = true
  return info
}

/**
 * Which of two rows sharing a canonical name is "the base row". Ranked spells
 * (`Scorching Arrow` I..IV) and NPC copies of a player spell all fold onto one key via
 * `spellCanonKey`, so the file order decides — with one override: a row NO class can cast is a
 * mob's or an item's copy, and loses to a row a player can actually learn.
 */
function prefer(existing: { info: SpellResistInfo; playable: boolean }, playable: boolean): boolean {
  return !existing.playable && playable
}

/**
 * Parse the whole file. ~74k rows; measured around 350 ms on the owner's machine, which is
 * exactly why the caller runs it on a worker thread (JOS-371: no synchronous multi-MB work on the
 * thread that tails the log).
 */
export function parseSpellsUs(text: string): SpellResistTable {
  const table: SpellResistTable = {}
  const seen = new Map<string, { info: SpellResistInfo; playable: boolean }>()
  for (const line of text.split('\n')) {
    if (!line) continue
    const f = line.split('^')
    if (f.length < F_SLOTS) continue
    const name = f[F_NAME]
    if (!name || !Number.isFinite(Number(f[F_ID]))) continue
    const key = spellCanonKey(name)
    if (!key) continue
    const playable = classLevels(f).any
    const existing = seen.get(key)
    if (existing && !prefer(existing, playable)) continue
    const info = rowInfo(f)
    seen.set(key, { info, playable })
    table[key] = info
  }
  return table
}
