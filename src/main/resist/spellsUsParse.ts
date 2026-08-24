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
//   8    cast time, ms                  10   recast (re-use) time, ms (JOS-444)
//   11   buff duration formula (JOS-396) 12  buff duration
//   14   mana (JOS-451)
//   29   resist type (see axisFromResistType)
//   30   target type                    36..51  class levels, WAR..BER (255 = cannot use)
//   78   resist adjust                  143  aemaxtargets (JOS-449)
//   172  effect slots, `$`-separated
//
// FIELD 14 IS THE MANA COST, verified the way 10 and 143 were — against the committed catalog rather
// than against a struct listing (owner's install, 2026-08-23). Over the 1,873 catalog spells that
// join a client row it agrees EXACTLY on 1,787 of them (95.4%), 553 of those on a shared zero and
// 1,234 on a shared positive number: Complete Heal 350, Odium 409, Garrison's Mighty Mana Shock 105,
// Ethereal Cleansing 150, Denon's Desperate Dirge 800. Of the 86 that disagree, 8 are the wiki
// stating no mana where the client states one (every last one an NPC-only or unlearnable row), 6 the
// reverse, and 72 two positive numbers that differ — a re-tune, which is a catalog question and not
// this file's.
//
// FIELD 10 IS THE RECAST AND FIELD 9 IS NOT, which is the only trap in that line and is measured
// rather than reasoned (owner's install, 2026-08-22). Field 9 is the RECOVERY time — the cooldown
// the game charges for any cast — and it reads 1500 on 18,008 of the 33,952 rows a class can cast,
// 0 on most of the rest; it disagrees with field 10 on 14,535 of them, so the two are plainly not
// one number written twice. WHICH of them is the re-use timer is settled by cross-checking against
// the wiki's own `recast_time` for the same spell: Odium (id 4093) reads 9 = 1500, 10 = 6000 and
// its page says 6 seconds; Garrison's Mighty Mana Shock (2552) reads 1500 in both and its page
// says 1.5; Complete Heal (1292) reads 9 = 1500, 10 = 0. Only field 10 tracks the page.
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
//
// AND TWO MORE EFFECT IDS STATE A HITPOINT MAGNITUDE (JOS-451), which the FIGURES list `hp` reads
// and the resist estimator's `hpSlot` deliberately does not:
//
//   100  heal over time. Ethereal Cleansing (3683) is `1|100|10|0|103|100` and its wiki page says
//        `Increase Hitpoints by 10 per tick`; Celestial Remedy, Celestial Health, Celestial
//        Cleansing, Celestial Healing and Primal Remedy all pair an effect-100 slot with a
//        hitpoint line on the page. It is the HoT spelling, and effect 0 is not used for one.
//   334  the bard's pulsing hitpoint effect. Five wiki pages name the magnitude of a 334 slot as a
//        hitpoint change and nothing else on the row states one: Chords of Dissonance
//        (`334|-2|109|0`, page `Decrease Hitpoints by 2 per tick`), Denon's Disruptive Discord
//        (`-4`), Denon's Bereavement (`-30`), Selo's Chords of Cessation (`-2`) and Song of
//        Midnight (`-1`).
//
// `hpSlot` STAYS EFFECT 0 ALONE on purpose. It answers one question for the resist estimator — is
// this spell's damage a fixed number — and widening it would change what the ledger, the fold and
// the con card are reading, for no gain: neither a HoT nor a bard pulse is a spell the estimator
// fits a resist from.

import { axisFromResistType, type ResistAxis, type ResistDebuffSlot, type SpellHpSlot, type SpellResistInfo, type SpellResistTable } from '../../shared/resistTypes'
import { spellCanonKey } from '../log/parseCommon'

const F_ID = 0
const F_NAME = 1
const F_CAST_MS = 8
const F_RECAST_MS = 10
const F_DURATION_FORMULA = 11
const F_DURATION = 12
/** Mana (JOS-451) — see `manaField` and the header for the measurement behind the index. */
const F_MANA = 14
const F_RESIST_TYPE = 29
const F_TARGET_TYPE = 30
const F_CLASS_FIRST = 36
const F_CLASS_COUNT = 16
/** Index of the bard among the sixteen class-level fields (WAR CLR PAL RNG SHD DRU MNK BRD …). */
const CLASS_BARD = 7
const F_RESIST_ADJ = 78
/** `aemaxtargets` (JOS-449) — see `aeTargetsField` for the measurement behind the index. */
const F_AE_MAX_TARGETS = 143
const F_SLOTS = 172

const EFFECT_HITPOINTS = 0
const EFFECT_CHARM = 22
const EFFECT_MEZ = 31
const EFFECT_ALL_RESISTS = 111

/** Every effect id that states a HITPOINT magnitude, for the figures list. See the header. */
const HP_EFFECTS: ReadonlySet<number> = new Set([EFFECT_HITPOINTS, 100, 334])

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
 * EVERY hitpoint slot, in file order, marked per-tick or not (JOS-396; the effect set widened to
 * `HP_EFFECTS` by JOS-451).
 *
 * `perTick` is one question of the ROW rather than of the slot — does this spell have a duration at
 * all — and it is written onto each slot because that is where the reader needs it: a hitpoint slot
 * on a duration spell is a DoT/HoT/regen line that lands every tick, and on an instant spell it is
 * the whole hit. Odium's `2|0|-217|0|103|325` with duration formula 7 is the first kind; Bolt of
 * Karana's `1|0|-200|0|100|200` with formula 0 is the second.
 */
function hpSlotsOf(slots: readonly Slot[], perTick: boolean): SpellHpSlot[] | undefined {
  const out: SpellHpSlot[] = []
  for (const s of slots) {
    if (HP_EFFECTS.has(s.effect)) out.push({ base: s.base, max: s.max, calc: s.calc, perTick })
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

/**
 * Field 10, present only when POSITIVE: a 0 in that column is the file's way of saying "no re-use
 * timer", and storing it would cost a field on half the table to state what the absence states.
 *
 * A helper returning a SPREADABLE fragment rather than two lines inside `rowInfo`, because that
 * function sits at the complexity ceiling and every optional field it grows costs two branches.
 */
function recastField(f: readonly string[]): { recastMs?: number } {
  const ms = Number(f[F_RECAST_MS]) || 0
  return ms > 0 ? { recastMs: ms } : {}
}

/**
 * Field 143, `aemaxtargets`, present only when POSITIVE (JOS-449) — a spreadable fragment for
 * `recastField`'s reason, and absent-means-nothing for the same reason too: 71,864 of the file's
 * 73,971 rows read 0 there, which is what a single-target spell says.
 *
 * MEASURED against the owner's install (2026-08-23) rather than taken from a struct listing: the
 * column reads 4 on every one of the 23 rains, 4 on 45 of the 46 Targeted AE rows in the committed
 * catalog, 8 on a PB AE and 0 on every `Single` row. `Denon's Desperate Dirge` is the one targeted
 * AE that disagrees with its own page — the client says 5 where the wiki prose says "up to 8
 * enemies" — and the client wins, on the same grounds `spells_us.txt` wins on names.
 */
function aeTargetsField(f: readonly string[]): { aeMaxTargets?: number } {
  const n = Number(f[F_AE_MAX_TARGETS]) || 0
  return n > 0 ? { aeMaxTargets: n } : {}
}

/**
 * Field 14, the mana cost, present only when POSITIVE (JOS-451) — a spreadable fragment for
 * `recastField`'s reason, and absent-means-nothing for `aeTargetsField`'s: a 0 in that column is
 * what a bard song and every other free ability says, and the catalog already says it too.
 *
 * It answers exactly one question, and narrowly: a spell whose PAGE states no mana or states 0
 * while the client states a positive one (`resolveSpellMana`, shared/spellMetrics.ts). Where both
 * state a positive number the wiki still wins, which is the standing law and not re-opened here.
 */
function manaField(f: readonly string[]): { mana?: number } {
  const n = Number(f[F_MANA]) || 0
  return n > 0 ? { mana: n } : {}
}

function rowInfo(f: readonly string[]): SpellResistInfo {
  const slots = parseSlots(f[F_SLOTS])
  const { bardOnly } = classLevels(f)
  const info: SpellResistInfo = {
    axis: axisFromResistType(Number(f[F_RESIST_TYPE])),
    resistAdj: Number(f[F_RESIST_ADJ]) || 0,
    castMs: Number(f[F_CAST_MS]) || 0,
    ...recastField(f),
    ...aeTargetsField(f),
    ...manaField(f),
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
