// WHAT A SPELL IS WORTH, READ OFF THE WIKI'S OWN EFFECT LINES (JOS-391).
//
// `spellEffectClass.ts` classifies an effect line and deliberately reads no MAGNITUDES — its
// header says so, and says why: nobody had asked for them and inventing a taxonomy nobody has
// checked is how the name-stem era shipped four defects. Somebody has now asked. The Leveling
// tab's "New at this level" rows are a buying decision ("is this nuke worth the 99 mana"), and
// the only honest input to it is the number the page prints.
//
// So this is the magnitude reader, and it is a SEPARATE, DELETABLE layer for the same reason the
// classifier is: `spells.json` records what the wiki said, and everything derived from it lives
// where it can be deleted without taking the scrape with it. Pure over its arguments, no Electron -
// main computes it once at fold time (src/main/data/levelUnlocks.ts) and the numbers cross IPC
// while the effect strings stay behind. Its ONE import is `shared/spellScale.ts` (JOS-447), which
// is the same kind of layer one level further out: the mote-rank arithmetic, fitted to the owner's
// log, importing nothing itself.
//
// ── WHAT THESE NUMBERS ARE, AND WHAT THEY ARE NOT ──────────────────────────────────────────────
//
// They are the spell's BASE figures at a stated level: no critical hits, no AA multipliers, no
// spell-damage bonus, no resist. They are DIRECTIONAL - the right instrument for comparing two
// spells you are choosing between, not a damage meter.
//
// FOCUS ITEMS USED TO BE ON THAT LIST AND ARE NOT ANY MORE (JOS-452). Where a caller states the
// worn focus percentages this file applies them, so a reader with an inventory dump loaded is
// looking at figures that carry his own gear; a caller that states none gets exactly the numbers
// this file printed before, byte for byte. The overlay is `shared/wornFocus.ts` and the surfaces
// that turn it on say so in one quiet word.
//
// AND THE PER-SECOND FIGURES ARE SUSTAINED ONES SINCE JOS-444, BECAUSE RECAST IS IN THE CATALOG NOW.
// This header used to say the opposite - "RECAST IS NOT IN THE CATALOG AT ALL" - and it was true
// until 2026-08-22, when the scrape began capturing the wiki's `recast_time` (spells.json schema 3,
// `SpellEntry.recastMs`, 1,925 of 2,006 rows) and the client's own row grew a reader for the same
// number (spellsUsParse.ts field 10). So `dps`/`hps` divide by the CASTING CYCLE rather than by the
// cast alone: cast plus recast for an instant spell, cast plus the whole duration for an over-time
// one, and never a window shorter than cast plus recast.
//
// THE RE-USE TIMER STARTS WHEN THE CAST COMPLETES, which is the edge worth stating out loud: a
// recast SHORTER than the cast still lengthens the cycle. Garrison's Mighty Mana Shock is a 3.0s
// cast with a 1.5s recast and its sustained window is 4.5s, not 3.0s - 333 damage at L35 reads
// 74 dps where it used to read 111. What contributes nothing extra is a recast shorter than an
// OVER-TIME spell's own duration: those figures total the whole duration's ticks, so the window
// has to cover the duration, and a faster re-use timer cannot make the same ticks arrive sooner.
// A spell no source states a recast for is unchanged, figure for figure.
//
// AND A CAST CAN LAND MORE THAN ONCE SINCE JOS-449 (`SpellMetricsInput.hits`). The wiki's effect
// line for a RAIN states ONE WAVE - `Frost Storm` says `Decrease Hitpoints by 512` and delivers
// three waves of it - so a reader that took the line literally under-stated every rain in the game
// threefold. The multiplier is an INPUT rather than something derived here: this file has never
// known which spell is which, and the roster, the evidence and the target-cap arithmetic live in
// `src/main/data/rainSpells.ts` and `shared/aoeSpells.ts` where they can be deleted without taking
// the magnitude reader with them. Absent means 1, so every pre-JOS-449 figure is unchanged.
//
// AND SINCE JOS-451 THE CLIENT CAN CORRECT A NUMBER THE PAGE GOT WRONG, not only supply one the page
// omits. The wiki transcribed the BASE of a level curve on a handful of pages and dropped the curve
// (`Ethereal Cleansing`: `Increase Hitpoints by 10 per tick`, where the client states 10 plus two a
// level capped at 100), so the app faithfully drew a paladin's only heal-over-time at a tenth of its
// value. The rule is narrow, censused and lives beside `clientCurveSlot` below; the mana half is
// `resolveSpellMana`. Four catalog rows move; the other 1,450 placed spells are byte-identical.
//
// The remaining caveats stay out of the UI on purpose: the caveat diet (AGENTS.md) - the panel says
// one quiet `directional` and stops.
//
// ── THE SHAPES, MEASURED ───────────────────────────────────────────────────────────────────────
//
// 664 hitpoint lines over the committed catalog in 51 distinct shapes. Every one of them is one
// of: a constant, a LEVEL RAMP stated as breakpoints, a RANGE stated as two bounds, or one of
// those marked per-tick. `tests/spellMetrics.test.mts` pins the nine the ticket named plus the
// exclusions below.
//
// WHAT IS EXCLUDED, AND WHY EACH EXCLUSION IS EVIDENCE-BACKED:
//
//   * `Increase Max Hitpoints by 202 (L34) to 225 (L42)` - a MAX-HP BUFF is not a heal. The head
//     test refuses it because `Max` sits between the verb and the noun (39 rows, plus 12 more
//     spelled `Max HP` / `Max Hit Points`).
//   * `Decrease HP when cast by 50` (67 rows) and `Increase HP when cast by ...` (42) - the
//     abbreviated spelling, and it is a DUPLICATE RENDERING rather than a second effect:
//     `Armor of Protection` states `Increase Max Hitpoints by 202 (L34) to 225 (L42)` and
//     `Increase HP when cast by 202 (L34) to 225 (L42)`, the same numbers twice. Reading both
//     would double every figure it touches, so this reader answers to the `Hit Points` spelling
//     only and says so here rather than guessing which of a pair is the real one.
//   * `Stacking: Block new spell if slot 3 is effect 'Max Hitpoints' and < 1100` and
//     `UNKNOWN CALC 118 base 406 max 446 attrib Max Hitpoints` - neither is an effect magnitude;
//     both fail the head test for free.

// AND A THIRD OVERLAY SINCE JOS-452 (`SpellMetricsInput.focusDamagePct` / `focusHealPct`). The
// header above has always said these figures carry "no focus items"; they now carry the ones YOUR
// GEAR IS WEARING, when a caller states them. Same arrangement as the two before it: an input this
// file does not derive, resolved once into `Fold`, multiplied at the single `foldLine` site, and
// absent means no focus - `applyFocusPct(x, 0)` returns `x` by identity, so every figure printed
// before JOS-452 is unchanged. The families, the level-range decay and the qualification test live
// in `shared/wornFocus.ts`, which can be deleted without taking the magnitude reader with it.
import { normalizeSpellRank, scaleSpellDamage, scaleSpellHeal } from './spellScale'
import { applyFocusPct } from './wornFocus'

/** A hitpoint line, read: how much, per tick or not, and over how many ticks the line states. */
export interface HpLine {
  /** Positive magnitude at the evaluation level. */
  amount: number
  /** `Increase` (a heal) or `Decrease` (damage). */
  direction: 'up' | 'down'
  /** True when the amount lands EVERY tick rather than once. */
  perTick: boolean
  /**
   * THE LINE STATED ONE BARE NUMBER (JOS-451) — `by 10 per tick`, with no `(L44)` breakpoint, no
   * `between A and B` and no `by A to B`. Absent on every shape that carries a level range.
   *
   * It is here because it is the precondition of the client-curve rule below, and because only the
   * READER of a line can tell the two apart afterwards: a ramp evaluated at one level and a flat
   * line stating the same number are the same `amount`, and one of them is a claim about every
   * level while the other is a claim about one.
   */
  flat?: true
  /**
   * The tick count the LINE ITSELF states, when it states one.
   *
   * Two families do: `Increase Hitpoints between 165 and 190 for two additional ticks.` (the
   * cleric Echo tail - per tick, for exactly two) and `Increase Hitpoints by 300 after 4 ticks`
   * (Blooming Heal - the whole amount, once, after a delay). Where a line counts its own ticks
   * that count wins over the duration, because the line is the more specific evidence.
   */
  statedTicks?: number
}

// ── AND WHERE THE WIKI'S SLOT TABLE IS SIMPLY MISSING A LINE (JOS-396) ─────────────────────────
//
// Odium's page lists one effect — `Increase Curse Counter by 8` — and no hitpoint line at all, so
// the reader above correctly answers "no figures" and the owner correctly reported a shaman nuke
// showing no damage. The number is not missing from the GAME, only from the page: the client's own
// `spells_us.txt` carries `2|0|-217|0|103|325` on spell 4093, which is 217 plus twice the caster's
// level, capped at 325, every tick for five ticks.
//
// So there is a SECOND source, and it is strictly a FALLBACK: the wiki's lines win wherever they
// exist, because they carry the level range the way the wiki states it and because they are the
// source every existing figure in the app was computed from. The client is consulted only for a
// spell whose wiki lines yield nothing. Fifteen spells in the committed catalog change; every other
// figure is byte-identical.
//
// THE SLOTS ARE READ IN THE CLIENT'S UNITS, WHICH ARE NOT THE WIKI'S:
//
//   * a magnitude is `|base| + step x level`, capped at `|max|` when max is non-zero. `calc` names
//     the step (see `CALC_STEPS`) and the SIGN OF `base` says which side it lands on. Reading
//     `base + 2L` literally off a negative base would give Odium 131 rather than 303.
//   * a slot lands EVERY TICK when the spell has a duration formula at all, and the tick count is
//     the CLIENT'S (`clientDurationTicks`), never the wiki's `durationMs`. One source states the
//     slot and the same source states how long it runs; crossing them would let a page's duration
//     multiply a magnitude the page does not know about.
//   * a permanent duration (formula 50/51) is a RATE WITH NO LENGTH and therefore contributes
//     NOTHING, exactly as `foldLine` already refuses a wiki per-tick line with no duration. This is
//     what keeps Lich, Call of Bones, Dark Pact and the nine other shapeshift self-buffs — whose
//     effect-0 slot is a permanent per-tick drain — from printing a total nobody can state.

/** One hitpoint slot of the client's spell table. A subset of `SpellHpSlot` (shared/resistTypes). */
export interface ClientHpSlot {
  base: number
  max: number
  calc: number
  perTick: boolean
}

/**
 * The client facts this reader needs. A subset of `SpellResistInfo`, so a caller can pass one —
 * the same arrangement `SpellMetricsInput` has with `SpellEntry`, and for the same reason: this
 * file imports nothing, so that the node tests, main and the renderer all read one copy of it.
 */
export interface ClientHpFacts {
  hp?: readonly ClientHpSlot[]
  hpDuration?: { formula: number; value: number }
  /**
   * THE CLIENT'S RE-USE TIMER (JOS-444), and the only field here that is NOT part of the hitpoint
   * fallback: it is read even when the wiki's own lines answered, because 81 catalog rows state no
   * `recast_time` and a sustained figure with no denominator is the thing this ticket removed.
   * The page wins where it states one - see `spellMetricsAt`.
   */
  recastMs?: number
  /**
   * THE CLIENT'S OWN TARGET CAP (JOS-449, field 143), carried for `recastMs`'s reason and read by
   * `shared/aoeSpells.ts` rather than by anything in this file — a hit count reaches
   * `spellMetricsAt` already resolved, because only the CALLER knows whether it is asking about one
   * mob or a pack.
   */
  aeMaxTargets?: number
  /**
   * THE CLIENT'S MANA COST (JOS-451, field 14), read only where the page states none or states a
   * zero — `resolveSpellMana` is the whole rule and its header is the argument for it.
   */
  mana?: number
}

/**
 * `calc` -> how much the magnitude grows per level of the caster.
 *
 * JOS-396 shipped the six the ticket named (100 flat, 101 half a point a level, 102 one, 103 two,
 * 104 three, 105 four) and every other code answered `formulaUnknown`. JOS-451 EARNED four more and
 * a whole family, by MEASUREMENT rather than by copying EQEmu's table: for every catalog effect line
 * that states a two-point level ramp, the implied step is `(B - A) / (levelB - levelA)`, and the
 * client slot whose `base + step x levelA` lands on `A` is the slot the line describes. Fit over the
 * committed catalog against the owner's install (2026-08-23):
 *
 *   calc < 100   THE STEP IS THE CODE ITSELF. Fitted at 1, 2, 3, 4, 5, 6, 7, 10 and 15, each on its
 *                own rows and never off by more than integer truncation (`Liquid Silver I`, calc 6,
 *                `by 16 (L1) to 250 (L40)`; `Greater Healing`, calc 7, `by 280 (L20) to 350 (L30)`).
 *   109  0.25    `Brilliance` (`Increase INT by 12 (L44) to 14 (L52)`, base 1) and `Cassindra's
 *                Elegy` (`12 (L44) to 16 (L60)`, base 1) both read `base + level/4` exactly.
 *   110  0.2     `Psalm of Warmth` (`Increase Damage Shield by 6 (L25) to 13 (L60)`, base 1) and
 *                `Boiling Blood` (`24 per tick (L1) to 36 per tick (L60)`, base 24).
 *   119  0.125   `Cassindra's Chorus of Clarity` (`Increase Mana by 5 (L32) to 7 (L48)`, base 1).
 *   121  1/3     `Echinacea Infusion` (`Increase Poison Resist by 5 (L1) to 10 (L15)`, base 5) and
 *                `Fufil's Curtailing Chant` (`by 11 (L30) to 17 (L48) per tick`, base 1).
 *
 * Every code still absent from this table answers `formulaUnknown` and falls back to the base rather
 * than guessing a curve — 123 (the client's random-between-base-and-max spelling), 139, 144 and the
 * 4xxx family among them. The division is INTEGER, like the client's.
 */
const CALC_STEPS: Record<number, number> = {
  100: 0,
  101: 0.5,
  102: 1,
  103: 2,
  104: 3,
  105: 4,
  109: 0.25,
  110: 0.2,
  119: 0.125,
  121: 1 / 3
}

/** Codes at or above this are the named table above; below it the code IS the step. */
const CALC_TABLE_FLOOR = 100

/** The per-level step this reader models for a `calc` code, or null when it will not guess one. */
function calcStep(calc: number): number | null {
  if (Number.isInteger(calc) && calc >= 0 && calc < CALC_TABLE_FLOOR) return calc
  return CALC_STEPS[calc] ?? null
}

/** A client hitpoint slot below this magnitude is a rider, not the spell's purpose (see clientLine). */
const MIN_CLIENT_HP_MAGNITUDE = 2

/** A client slot's magnitude at a level: always positive, and honest about a formula it cannot read. */
export function clientHpMagnitudeAt(
  slot: ClientHpSlot,
  level: number
): { amount: number; formulaUnknown: boolean } {
  const base = Math.abs(slot.base)
  const step = calcStep(slot.calc)
  if (step === null) return { amount: base, formulaUnknown: true }
  const cap = Math.abs(slot.max)
  const raw = Math.floor(base + step * level)
  return { amount: cap > 0 && raw > cap ? cap : raw, formulaUnknown: false }
}

// ── AND WHERE THE WIKI TRANSCRIBED A CURVE'S BASE AND DROPPED THE CURVE (JOS-451) ──────────────
//
// The fallback above answers where the page says NOTHING. This answers a different failure, and it
// is the one the owner reported: the page states a hitpoint line and the number in it is WRONG.
//
// `Ethereal Cleansing` (PAL 44) reads `Increase Hitpoints by 10 per tick` on the wiki. The owner's
// client row (3683) states `1|100|10|0|103|100` — base 10, two more per level, capped at 100 — which
// is 98 a tick at 44 and 100 a tick from 45 up. The page transcribed the BASE of a level curve and
// dropped the curve, so a paladin's only heal-over-time read 40 total where the game heals 400.
//
// THE RULE IS THE SHAPE, AND THE SHAPE WAS CENSUSED BEFORE IT WAS WRITTEN. A wiki hitpoint line
// qualifies only when ALL of this holds:
//
//   * the line is FLAT (`HpLine.flat`) — one bare number, no `(L44)` ramp, no `A to B` range. A
//     ramp is the wiki stating the curve properly and it always wins.
//   * the client's row carries EXACTLY ONE hitpoint slot whose |base| is that number, whose sign
//     agrees with the line's direction, and whose per-tick verdict agrees with the line's. Exactly
//     one, because two candidates mean nothing states WHICH slot the sentence is about.
//   * that slot states a LEVEL CURVE this reader models — a nonzero step. A cap on its own changes
//     no number (`base + 0 x level` is the base, and every capped flat slot in the file caps at its
//     own base), and a `calc` this reader cannot read is not a curve it may claim to know.
//
// CENSUS over the committed catalog against the owner's install (2026-08-23). The shape matches 14
// rows and MOVES A NUMBER on FOUR of them; the rule is written to touch nothing else, and a
// before/after fold of all 1,454 placed spells is byte-identical on the other 1,450.
//
//   Ethereal Cleansing         PAL 44  10 per tick -> 98   (base 10, calc 103, cap 100)  heal  40 -> 392
//   Celestial Remedy           CLR 19  35 per tick -> 54   (base 35, calc 102, cap 65)   heal 140 -> 216
//   Selo's Chords of Cessation BRD 48   2 per tick -> 26   (base  2, calc 101, no cap)   dmg    6 ->  78
//   Denon's Disruptive Discord BRD 18   4 per tick ->  8   (base  4, calc 109, no cap)   dmg   12 ->  24
//
// The other ten match the shape and state the wiki's own number back, because their cap equals their
// base (the druid `... Heal` family's `90|103|90`, `Spike of Disease`'s `15|101|15`) — see
// `withClientCurve`, which refuses to flag a reading that moved nothing.
//
// Counted and deliberately NOT touched, because they are a different claim: 354 flat wiki hitpoint
// lines find no client slot that shares their base at all, and stay with the WIKI per the standing
// law. Some of those are a real disagreement worth a catalog correction one day (`Banish Undead`
// says 585 where the client's slot is base 270, calc 105, capped 468) and each one needs its own
// instrument rather than a blanket client-wins. Three more matched a slot under a `calc` this reader
// will not read (`Denon's Desperate Dirge` 144, `Force of Nature` 139, `Frost Shards` 10 on an NPC
// row) and are left alone for the same reason.
//
// THE DURATION IS STILL THE PAGE'S. Only the MAGNITUDE moves: the line is the wiki's sentence and
// the tick count it runs over is the wiki's `durationMs`, exactly as before. Both sources agree on
// the two rows this fires on (formula 3, cap 4 ticks; the pages say 24 seconds), so nothing is being
// papered over — it is simply not this rule's question.

/**
 * The ONE client slot that overrides this flat wiki line, or null. See the block above for the
 * shape and the census; this function is that paragraph, executable.
 */
function clientCurveSlot(line: HpLine, client: ClientHpFacts | undefined): ClientHpSlot | null {
  if (line.flat !== true) return null
  const found = onlySlotStating(client?.hp, line)
  if (!found) return null
  const step = calcStep(found.calc)
  return step !== null && step > 0 ? found : null
}

/** Is this the slot the sentence is about? Same magnitude, same side, same per-tick verdict. */
function slotStates(slot: ClientHpSlot, line: HpLine): boolean {
  if (slot.base === 0 || Math.abs(slot.base) !== line.amount) return false
  return slot.base < 0 === (line.direction === 'down') && slot.perTick === line.perTick
}

/** The one slot `slotStates` accepts, or null — including when TWO of them do (see the block above). */
function onlySlotStating(
  slots: readonly ClientHpSlot[] | undefined,
  line: HpLine
): ClientHpSlot | null {
  if (!slots) return null
  const hits = slots.filter((slot) => slotStates(slot, line))
  return hits.length === 1 ? hits[0] : null
}

/**
 * THE DURATION FORMULAS, in ticks, and what each one is capped by.
 *
 * Every entry is EQEmu's `CalcBuffDuration_formula`, and each was CHECKED against the committed
 * catalog's own `durationMs` before being written here: over the 1,270 player spells the two
 * sources both describe, the formula reproduces the wiki's tick count wherever the two are read at
 * the same level, and the disagreements are all the wiki quoting a spell's duration at a HIGHER
 * level than the one it is gained at (`Berserker Spirit`, formula 7, cap 50: 47 ticks at 47 and the
 * page's 50 at 50). Formula 7 with cap 5 is Odium's, and gives five ticks at every level.
 *
 * NOT IN THE TABLE, ON PURPOSE: 0 (an instant spell — no ticks to state), 50 and 51 (PERMANENT,
 * until cancelled or until you zone), and every code the file carries that this list does not name.
 * All of them answer null, which the fold reads as "a rate with no length" and refuses to total.
 */
const DURATION_FORMULAS: Record<number, (level: number, value: number) => number> = {
  1: (l) => Math.max(1, Math.floor(l / 2)),
  2: (l) => Math.max(6, Math.floor(l / 2) + 5),
  3: (l) => l * 30,
  4: (_l, v) => (v > 0 ? v : 50),
  5: (_l, v) => Math.max(3, v),
  6: (l) => Math.max(1, Math.floor(l / 2)),
  7: (l) => Math.max(1, l),
  8: (l) => l + 10,
  9: (l) => l * 2 + 10,
  10: (l) => l * 3 + 10,
  11: (l) => l * 30 + 90,
  12: (l) => Math.max(1, Math.floor(l / 4)),
  15: (_l, v) => v
}

/** The client's duration in whole ticks at a level, or null for a formula this reader will not read. */
export function clientDurationTicks(
  spec: { formula: number; value: number },
  level: number
): number | null {
  const fn = DURATION_FORMULAS[spec.formula]
  if (!fn) return null
  const ticks = fn(level, spec.value)
  return spec.value > 0 && ticks > spec.value ? spec.value : ticks
}

/** The figures a row draws. Absent fields mean "this spell has no such line", never zero. */
export interface SpellMetrics {
  /** Total base damage at the evaluation level, DoT ticks included. */
  damage?: number
  /** Total base healing at the evaluation level, HoT ticks included. */
  heal?: number
  /** damage / mana. Absent when no source states a positive mana - see `resolveSpellMana`. */
  damagePerMana?: number
  /** heal / mana, same rule. */
  healPerMana?: number
  /** SUSTAINED damage per second: the total over one whole casting cycle (see the header). */
  dps?: number
  /** the same for healing. */
  hps?: number
  /**
   * The re-use timer, in ms, as some source stated it - echoed onto the figures because it is the
   * half of the `dps`/`hps` denominator that no other field on this record explains, and because
   * the formatter (`spellMetricsParts`) is the one place that decides whether it is worth printing.
   *
   * Written only when a source states a POSITIVE one. A stated 0 (432 catalog rows) is a real
   * answer meaning "no re-use timer", and it changes no window and prints nothing, so carrying it
   * across the wire on every row would be bytes saying nothing.
   */
  recastMs?: number
  /** True when any damage arrives per tick - the row marks it `over Ns`. */
  dot?: boolean
  /** True when any healing arrives per tick. */
  hot?: boolean
  /** The duration the ticks run over, in whole seconds. Present only with `dot`/`hot`. */
  overSec?: number
  /**
   * WHERE THE FIGURES CAME FROM (JOS-396). Absent means the wiki's own effect lines, which is every
   * figure this app drew before the client fallback existed; `'client'` means the page states no
   * hitpoint line and these numbers were read off the player's own `spells_us.txt`.
   *
   * A FLAG IN THE DATA, NOT A CAPTION ON THE SCREEN — the caveat diet. It rides across the wire so
   * a surface CAN say one quiet word about it if the owner ever asks for one, and so a test can
   * assert which source answered without re-deriving the join.
   */
  source?: 'client'
  /**
   * THE CLIENT'S CURVE ANSWERED FOR A FLAT WIKI LINE (JOS-451) — the page stated the hitpoint line
   * and the client stated the level curve the page transcribed the base of.
   *
   * A SEPARATE FLAG FROM `source`, because it is a separate claim: `source: 'client'` means the page
   * said nothing at all, and this means the page said something and one of its numbers was replaced.
   * Four spells in the committed catalog carry it at their own gain level (`Ethereal Cleansing`,
   * `Celestial Remedy`, `Selo's Chords of Cessation`, `Denon's Disruptive Discord`). Like `source` it
   * is a flag in the DATA and not a caption on the screen — the caveat diet.
   */
  clientCurve?: true
  /**
   * A contributing client slot used a `calc` code this reader does not model, so its magnitude is
   * the slot's BASE with no level curve applied — a floor rather than an answer. One spell in the
   * committed catalog (`Soul Bond`, calc 4005) is in this state today.
   */
  formulaUnknown?: true
}

/** The catalog fields this reader needs. A subset of `SpellEntry`, so a caller can pass one. */
export interface SpellMetricsInput {
  effects?: string[]
  /**
   * The wiki's mana cost. A stated 0 is the page claiming the spell is FREE, and since JOS-451 that
   * claim can be overturned by the client's own column — `resolveSpellMana` carries the rule, the
   * census and the reason it is narrower than the recast fallback beside it.
   */
  mana?: number
  castTimeMs?: number
  /**
   * The wiki's `recast_time`, in ms (schema 3). ABSENT means no source stated one, which is not
   * the same as the STATED 0 that 432 rows carry - both leave the window at the cast alone, but
   * only the second is an answer, and `spellMetricsAt` falls back to the client file for the first.
   */
  recastMs?: number
  durationMs?: number | null
  /** `target_type` verbatim. `Lifetap` changes what the Increase line means - see below. */
  targetType?: string
  /**
   * THE MOTE UPGRADE LEVEL this reading is taken at (JOS-447), 0..10. Absent and 1 both mean the
   * base spell — `shared/spellScale.ts normalizeSpellRank` owns that reading and says why.
   *
   * It rides on the INPUT rather than beside `level` for `recastMs`'s reason: it has to be resolved
   * ONCE, before either fold runs, so the wiki path and the client path scale by one number. Damage
   * and healing move with it at their own fitted rates; see spellScale.ts's header for what does
   * not (mana, cast time) and which way those figures err.
   */
  rank?: number
  /**
   * HOW MANY TIMES THE DAMAGE MAGNITUDE LANDS FROM ONE CAST (JOS-449). Absent and 1 are the same
   * answer, and 1 is what every spell in the catalog reads until a caller says otherwise — so every
   * figure this file printed before JOS-449 is unchanged by construction.
   *
   * It exists because the wiki's effect line for a RAIN states ONE WAVE. `Frost Storm` carries
   * `Decrease Hitpoints by 512` and delivers three waves of it, so a reader that took the line
   * literally under-stated the spell threefold and buried the most efficient nuke a wizard owns at
   * 50. The count itself is not decided here: `src/main/data/rainSpells.ts` carries the roster and
   * the evidence, `shared/aoeSpells.ts aeHits` turns waves and a target count into this number, and
   * this file only multiplies.
   *
   * DAMAGE ONLY, and the asymmetry is real rather than an omission: nothing in the catalog heals in
   * waves, and a rain's mana-drain rider is not a hitpoint line at all. A healing line is left
   * alone so a future two-sided spell cannot silently gain a heal it does not perform.
   *
   * IT MULTIPLIES THE MAGNITUDE, NOT THE TOTAL, which is what keeps the mote-rank arithmetic
   * intact: a rank scales the PER-WAVE amount (`scaleSpellDamage`) and the waves multiply what
   * comes out, in that order, because that is the order the game applies them in.
   */
  hits?: number
  /**
   * THE WORN DAMAGE FOCUS, as a percentage, already resolved for THIS spell (JOS-452). Absent, 0 and
   * anything unreadable are the same answer: no focus, and a byte-identical figure.
   *
   * Resolved by the caller and not here, for `hits`'s reason one step further out: which focus
   * effects a player is wearing is a fact about a `/outputfile inventory` dump, and whether one
   * QUALIFIES is a fact about the focus's own limit lines. `shared/wornFocus.ts bestWornFocus` owns
   * both and hands down one number.
   *
   * It is a PERCENT rather than a multiplier so that "no focus" is 0 rather than 1, which is the
   * same absent-is-nothing shape `rank` has and cannot be confused with a multiplier of zero.
   */
  focusDamagePct?: number
  /** The worn HEALING focus, same rule, resolved against the same spell. */
  focusHealPct?: number
}

/** One EQ tick. */
const TICK_MS = 6000

/** The tick counts the two self-counting families spell out in words. */
const TICK_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }

/**
 * The head of a hitpoint line: an increase or a decrease OF HIT POINTS, and nothing between the
 * verb and the noun but an optional `Current`.
 *
 * The gap is the whole point (the `spellEffectClass.ts` anchor argument, one noun further in):
 * `Increase Max Hitpoints` states a bigger HP POOL and `Increase Hitpoints` states hit points
 * arriving, and the only thing telling them apart is the word in between. The `v\d` tail is
 * Torpor's and Celestial Cleansing's spelling (`Increase Hitpoints v2 by 300 per tick`), and the
 * trailing `s` is `Increases hitpoints by 2 per tick` (Extended Regeneration).
 */
const HP_HEAD_RE = /^(increase|decrease)s?\s+(?:current\s+)?hit\s?points?(?:\s+v\d+)?\b/i

/**
 * `@L44` is the same statement as `(L44)`, and a `per tick` sitting BETWEEN a value and its
 * breakpoint is a rate marker rather than part of the ramp.
 *
 * The second half is what Sebilite Pox needs: `by 1 per tick (L1) to 22 per tick (L65)` states
 * the same two-point ramp as `by 1 (L1) to 22 (L65) per tick`, with the marker repeated inside
 * each clause. Reading it whole yields the value at L1 for every level. The rate is detected on
 * the untouched tail, so removing the words here costs nothing.
 */
function normalizeBreakpoints(s: string): string {
  return s.replace(/@\s*l(\d+)/gi, '(L$1)').replace(/\s*\bper\s+tick\b/gi, '')
}

/** A stated (level, value) breakpoint, e.g. the `22 (L50)` of a ramp. */
interface Breakpoint {
  level: number
  value: number
}

/** Every `N (LM)` the tail states, ascending by level. */
function breakpointsOf(tail: string): Breakpoint[] {
  const out: Breakpoint[] = []
  const re = /(-?\d+)\s*\(L(\d+)\)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(tail)) !== null) out.push({ value: Number(m[1]), level: Number(m[2]) })
  return out.sort((a, b) => a.level - b.level)
}

/**
 * A ramp read at `level`: linear between the two breakpoints it falls between, CLAMPED outside.
 *
 * Clamped rather than extrapolated because the wiki's ramp is a statement about a band, not a
 * formula - `Decrease Hitpoints by 10 (L1) to 0 (L70) to 65 (L110)` extrapolated below 1 or above
 * 110 produces numbers the page never claimed. Non-monotonic ramps like that one are handled for
 * free: nothing here assumes the values ascend, only that the LEVELS do.
 */
function rampAt(points: readonly Breakpoint[], level: number): number {
  const first = points[0]
  const last = points[points.length - 1]
  if (level <= first.level) return first.value
  if (level >= last.level) return last.value
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (level > b.level) continue
    const span = b.level - a.level
    if (span <= 0) return b.value
    return a.value + ((b.value - a.value) * (level - a.level)) / span
  }
  return last.value
}

/**
 * The magnitude the tail states at `level`, or null when it states none.
 *
 * The order is specific-to-general and each arm is a measured family:
 *   breakpoints  `by 273 (L34) to 288 (L39)`, `by 10 (L1) to 0 (L70) to 65 (L110)`, `by 360 (L50)`
 *   between/and  `between 165 and 190` (the Echo tail, and `Decrease Hitpoints between 40 and 90.`)
 *   bare range   `by 7 to 12` (Lifespike)
 *   constant     `by 100`
 * A range is read at its MIDPOINT: the page states two bounds and no distribution, and the
 * midpoint is the only summary that does not prefer one end of a claim the wiki did not make.
 */
function magnitudeAt(tailRaw: string, level: number): { value: number; flat: boolean } | null {
  const tail = normalizeBreakpoints(tailRaw)
  const points = breakpointsOf(tail)
  if (points.length > 0) return { value: rampAt(points, level), flat: false }
  const between = /\bbetween\s+(-?\d+)\s+and\s+(-?\d+)/i.exec(tail)
  if (between) return { value: (Number(between[1]) + Number(between[2])) / 2, flat: false }
  const range = /\bby\s+(-?\d+)\s+to\s+(-?\d+)/i.exec(tail)
  if (range) return { value: (Number(range[1]) + Number(range[2])) / 2, flat: false }
  const flat = /\bby\s+(-?\d+)/i.exec(tail)
  return flat ? { value: Number(flat[1]), flat: true } : null
}

/** `for two additional ticks` / `after 4 ticks` - the count, when the line counts for itself. */
function statedTicksOf(tail: string): number | undefined {
  const m = /\b(?:for|after)\s+(\d+|one|two|three|four|five|six)\s+(?:additional\s+)?ticks?\b/i.exec(tail)
  if (!m) return undefined
  const word = m[1].toLowerCase()
  const n = TICK_WORDS[word] ?? Number(word)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * Read ONE effect line, or null when it is not a hitpoint line.
 *
 * `after N ticks` is a DELAY, not a rate (`Increase Hitpoints by 300 after 4 ticks` heals 300
 * once, four ticks late), so it is deliberately NOT `perTick`; `for N additional ticks` IS a rate
 * and carries its own count. Everything else marked `per tick` takes its count from the duration.
 */
export function parseHpLine(line: string, level: number): HpLine | null {
  const s = line.trim()
  const head = HP_HEAD_RE.exec(s)
  if (!head) return null
  const tail = s.slice(head[0].length)
  const read = magnitudeAt(tail, level)
  if (read === null) return null
  const statedTicks = statedTicksOf(tail)
  const perTick = /\bper\s+tick\b/i.test(tail) || /\bfor\s+\S+\s+additional\s+ticks?\b/i.test(tail)
  const out: HpLine = {
    amount: Math.abs(read.value),
    direction: head[1].toLowerCase() === 'increase' ? 'up' : 'down',
    perTick
  }
  if (read.flat) out.flat = true
  if (statedTicks !== undefined) out.statedTicks = statedTicks
  return out
}

/** Whole ticks the duration covers. 0 when the catalog states no duration (an instant spell). */
export function ticksOf(durationMs: number | null | undefined): number {
  return typeof durationMs === 'number' && durationMs > 0 ? Math.round(durationMs / TICK_MS) : 0
}

/** Round to one decimal, and drop a trailing `.0` by returning a number rather than a string. */
function r1(n: number): number {
  return Math.round(n * 10) / 10
}

/** One side's running totals while the lines are folded. */
interface Side {
  total: number
  /** True when any of it arrives per tick. */
  overTime: boolean
}

/**
 * The multipliers resolved ONCE per reading, before either fold runs: the mote rank (JOS-447), the
 * number of times a cast lands (JOS-449) and the worn focus percentages (JOS-452).
 *
 * One object rather than separate arguments so `foldLine` stays inside the repo's four-parameter cap
 * and so a further multiplier cannot be added without a name for what it is - which is exactly the
 * door JOS-452 came through.
 */
interface Fold {
  rank: number
  hits: number
  /** the worn damage focus percent for THIS spell; 0 is no focus */
  focusDamagePct: number
  /** the worn healing focus percent for THIS spell; 0 is no focus */
  focusHealPct: number
}

/**
 * Fold one read line into the damage/heal totals.
 *
 * A per-tick line contributes `amount x ticks`, where the ticks are the line's own count when it
 * states one and the duration's otherwise. A per-tick line on a spell with NO duration and no
 * stated count contributes NOTHING - the catalog has told us a rate and not how long it runs, and
 * multiplying by a guess would put a made-up total in front of a player.
 */
function foldLine(side: Side, line: HpLine, durationTicks: number, fold: Fold): void {
  // THE ONE PLACE A MOTE RANK TOUCHES A NUMBER (JOS-447). Both paths - the wiki's own lines and the
  // client's slots - fold through here, so one scaling happens once rather than twice in agreement.
  // Each direction scales by its own measured rate: six percent a rank for damage, three for
  // healing (owner ruling 2026-08-23 shipped the healing half; spellScale.ts holds both fits).
  //
  // AND THE WAVES MULTIPLY WHAT THE RANK PRODUCED (JOS-449), in that order and damage-side only -
  // `SpellMetricsInput.hits` states why.
  //
  // AND THE WORN FOCUS SITS BETWEEN THEM (JOS-452), which is the order the game applies them in: a
  // mote rank is part of the spell you own, a focus rolls on top of the spell as it is cast, and the
  // waves are that cast landing more than once. Each side takes its OWN focus - a damage focus can
  // never lift a healing line, and the two are resolved separately against the same spell.
  const amount =
    line.direction === 'down'
      ? applyFocusPct(scaleSpellDamage(line.amount, fold.rank), fold.focusDamagePct) * fold.hits
      : applyFocusPct(scaleSpellHeal(line.amount, fold.rank), fold.focusHealPct)
  if (!line.perTick) {
    side.total += amount
    return
  }
  const ticks = line.statedTicks ?? durationTicks
  if (ticks <= 0) return
  side.total += amount * ticks
  side.overTime = true
}

/**
 * The spell with its re-use timer resolved: the page's own `recast_time`, or the client's row where
 * the page is silent (JOS-444). Returns the input UNTOUCHED when there is nothing to add, so a
 * caller that passes no client facts gets the object it handed in.
 */
function withRecast(spell: SpellMetricsInput, client?: ClientHpFacts): SpellMetricsInput {
  if (spell.recastMs !== undefined || client?.recastMs === undefined) return spell
  return { ...spell, recastMs: client.recastMs }
}

/**
 * THE MANA A SPELL COSTS: the page's number, or the CLIENT'S where the page states none or states a
 * zero (JOS-451). Returns undefined when neither source states a positive one, which is what every
 * bard song and every other free ability says and is not the same claim as a missing field.
 *
 * IT IS THE NARROWEST OF THE THREE CLIENT FALLBACKS IN THIS FILE, and deliberately so. The client's
 * column disagrees with the page on 72 of the 1,234 catalog rows where BOTH state a positive number
 * — a re-tune, an era difference, a wiki typo, no way to tell from here — and the standing law gives
 * those to the wiki. A stated zero is different in kind: it is the page claiming the spell is free,
 * and a spell the client charges for is not free.
 *
 * CENSUS (owner's install, 2026-08-23): 8 catalog rows are in the wiki-silent / client-positive
 * shape, and every one of them is an NPC-only or otherwise unlearnable row (`Alluring Whispers`,
 * `Cleanse`, `Frost Shards`, `Fury of the Chosen`, the classless second `Healing`, `Mana Flare`,
 * `Manifest Elements`, `Scorching Skin`) — none is placed at a level by `parseSpellClasses`, so no
 * unlock row's mana moves today. The rule is here for the shape rather than for a count: a scrape
 * that loses a mana figure now costs a wrong `dmg/mana` instead of a missing one.
 *
 * AND IT SAYS NOTHING ABOUT BARD SONGS, which is worth writing down because the ticket expected it
 * to: the client charges 0 for every bard song the catalog charges 0 for. The only mana-costing bard
 * rows in the owner's file are `Denon's Desperate Dirge` (800, which the catalog already states) and
 * the level-75-and-up `Denon's Dirge of ...` line.
 */
export function resolveSpellMana(page: number | undefined, client: number | undefined): number | undefined {
  if (typeof page === 'number' && page > 0) return page
  return typeof client === 'number' && client > 0 ? client : page
}

function withMana(spell: SpellMetricsInput, client?: ClientHpFacts): SpellMetricsInput {
  const mana = resolveSpellMana(spell.mana, client?.mana)
  return mana === spell.mana ? spell : { ...spell, mana }
}

/**
 * THE FIGURES FOR ONE SPELL AT ONE LEVEL. Returns undefined when the spell has no hitpoint line
 * at all, which is most of the catalog and is a row that simply shows no figures.
 *
 * `level` is the evaluation level: the level the class GAINS the spell at for an unlock row, the
 * level being viewed for a browsing one. Every ramp is read there and nowhere else.
 *
 * LIFETAPS COUNT AS DAMAGE, AND THE TARGET TYPE IS WHAT SAYS SO. `Lifetap` and `Siphon` state the
 * same magnitude twice - `Decrease Hitpoints by 80` then `Increase Hitpoints by 80 (Self)` - which
 * is one transfer written from both ends. Counting the second as healing would credit the spell
 * with a heal it does not perform on anybody but the caster and would put a `heal/mana` on a
 * detrimental spell. The catalog files all 28 such rows under `targetType: 'Lifetap'`, so the
 * increase side is dropped there and the damage side stands alone.
 *
 * THE RECAST FALLBACK IS RESOLVED HERE AND NOWHERE ELSE (JOS-444). The wiki's `recast_time` wins;
 * the client's field 10 answers for the 81 rows whose page omits it. It is folded into the input
 * rather than threaded past `assemble` so that every path below — the wiki fold, the client fold,
 * the unlock row, the spell card — divides by one denominator resolved one way.
 */
export function spellMetricsAt(
  input: SpellMetricsInput,
  level: number,
  client?: ClientHpFacts
): SpellMetrics | undefined {
  const spell = withMana(withRecast(input, client), client)
  // Resolved ONCE, here, for `withRecast`'s reason: one number reaches both folds.
  const fold: Fold = {
    rank: normalizeSpellRank(spell.rank),
    hits: hitsOf(spell.hits),
    focusDamagePct: pctOf(spell.focusDamagePct),
    focusHealPct: pctOf(spell.focusHealPct)
  }
  const lifetap = spell.targetType === 'Lifetap'
  const durationTicks = ticksOf(spell.durationMs)
  const dmg: Side = { total: 0, overTime: false }
  const heal: Side = { total: 0, overTime: false }
  let any = false
  let curved = false
  for (const raw of spell.effects ?? []) {
    const read = parseHpLine(raw, level)
    if (!read) continue
    if (lifetap && read.direction === 'up') continue
    any = true
    const line = withClientCurve(read, level, client)
    if (line !== read) curved = true
    foldLine(line.direction === 'down' ? dmg : heal, line, durationTicks, fold)
  }
  if (!any) return client ? clientMetricsAt(spell, level, client, fold) : undefined
  const out = assemble(dmg, heal, spell, durationTicks)
  if (out && curved) out.clientCurve = true
  return out
}

/**
 * DOES THE CLIENT'S CURVE ANSWER for any of these wiki hitpoint lines? The question main asks before
 * deciding whether a wiki-lined row still has to carry `clientHp` across the wire (JOS-451).
 *
 * Level-independent, and asked at 1 for the same reason `LEVEL_ANY` exists in levelUnlocks.ts: the
 * match is on the slot's base, sign and per-tick verdict, and a FLAT line's amount is the same
 * number at every level.
 */
export function anyClientCurve(
  lines: readonly string[],
  client: ClientHpFacts | undefined
): boolean {
  return lines.some((raw) => {
    const line = parseHpLine(raw, 1)
    return line !== null && clientCurveSlot(line, client) !== null
  })
}

/**
 * The line as the CLIENT states it, where the client states a curve the page dropped — else the
 * line untouched, IDENTICALLY (`===`), which is how the caller knows the rule fired.
 */
function withClientCurve(line: HpLine, level: number, client: ClientHpFacts | undefined): HpLine {
  const slot = clientCurveSlot(line, client)
  if (!slot) return line
  const amount = clientHpMagnitudeAt(slot, level).amount
  // A CURVE WHOSE CAP EQUALS ITS OWN BASE STATES THE WIKI'S NUMBER BACK. Eight rows in the committed
  // catalog are that shape (the druid `... Heal` family's `90|103|90`, `Spike of Disease`'s
  // `15|101|15`), and flagging a reading that moved nothing would make `clientCurve` mean "the shape
  // matched" when what a reader wants of it is "a number changed".
  return amount === line.amount ? line : { ...line, amount }
}

/** A focus percent as this file will read it: absent, negative and unreadable all mean no focus. */
function pctOf(pct: number | null | undefined): number {
  return typeof pct === 'number' && Number.isFinite(pct) && pct > 0 ? pct : 0
}

/** A hit count as this file will read it: a whole number, never below one. Absent means one. */
function hitsOf(hits: number | null | undefined): number {
  if (typeof hits !== 'number' || !Number.isFinite(hits)) return 1
  return Math.max(1, Math.trunc(hits))
}

/**
 * THE SAME FIGURES, READ OFF THE CLIENT'S SLOTS — reached only when the wiki's lines yielded none.
 *
 * It folds through the SAME `foldLine`/`assemble` the wiki path uses, so a client-sourced row and a
 * wiki-sourced one beside it are the same arithmetic and the same rounding rather than two
 * derivations that agree today. The only two differences are stated in the file header: the
 * magnitude comes from `|base| + step x level` capped at `|max|`, and the tick count comes from the
 * CLIENT'S duration rather than the page's.
 *
 * LIFETAPS ARE DAMAGE-ONLY HERE TOO, but by a different route. The wiki path DROPS a lifetap's
 * increase line because the page states the transfer twice, once from each end; the client states
 * it ONCE, so dropping it would throw away the only statement there is. An effect-0 slot on a
 * `Lifetap` spell is therefore counted as damage whatever its sign — `Soul Bond` is the one spell
 * in the catalog this decides.
 */
function clientMetricsAt(
  spell: SpellMetricsInput,
  level: number,
  client: ClientHpFacts,
  fold: Fold
): SpellMetrics | undefined {
  const slots = client.hp ?? []
  if (slots.length === 0) return undefined
  const lifetap = spell.targetType === 'Lifetap'
  const ticks = client.hpDuration ? (clientDurationTicks(client.hpDuration, level) ?? 0) : 0
  const dmg: Side = { total: 0, overTime: false }
  const heal: Side = { total: 0, overTime: false }
  let unknownFormula = false
  for (const slot of slots) {
    const line = clientLine(slot, level, lifetap)
    if (!line) continue
    if (line.formulaUnknown) unknownFormula = true
    foldLine(line.direction === 'down' ? dmg : heal, line, ticks, fold)
  }
  const out = assemble(dmg, heal, spell, ticks)
  if (!out) return undefined
  out.source = 'client'
  if (unknownFormula) out.formulaUnknown = true
  return out
}

/**
 * ONE CLIENT SLOT, read into the same shape a wiki line reads into — which is what lets both paths
 * share `foldLine` — or null when the slot states no magnitude at all.
 *
 * The SIGN OF `base` picks the side, except on a lifetap where everything is damage (see above).
 * `formulaUnknown` is reported only for a slot that CONTRIBUTES: a zero-magnitude slot under an
 * unread calc changes no figure, so flagging it would put a caveat on a number it never touched.
 */
function clientLine(
  slot: ClientHpSlot,
  level: number,
  lifetap: boolean
): (HpLine & { formulaUnknown: boolean }) | null {
  const read = clientHpMagnitudeAt(slot, level)
  // A ONE-POINT RIDER IS NOT A DAMAGE OR HEALING SPELL - the same floor `MIN_DEBUFF_MAGNITUDE`
  // draws for resist riders. Measured against the owner's client file: exactly two of the
  // fifteen wiki-less spells fall under it - Rage of Zomm (a pet summon with a 1 hp rider,
  // "dmg 1 - dps 0") and Illusion: Iksar (the racial 1 hp/tick regen over 36 minutes) - and
  // nothing else in the catalog moves. A slot under a formula this reader does not evaluate is
  // exempt: its base IS a floor and is already flagged as one (Soul Bond, calc 4005).
  if (read.amount < MIN_CLIENT_HP_MAGNITUDE && !read.formulaUnknown) return null
  const direction: HpLine['direction'] = lifetap || slot.base < 0 ? 'down' : 'up'
  return {
    amount: read.amount,
    direction,
    perTick: slot.perTick,
    formulaUnknown: read.formulaUnknown
  }
}

/** One side's three derived figures: the total, per mana, per second. */
interface SideFigures {
  total: number
  perMana?: number
  perSecond?: number
}

/**
 * One side, derived. `windowSec` is the casting cycle this side's total arrived over (see
 * `cycleSec`) — the honest denominator for "how fast does this arrive", and the reason a DoT's dps
 * is not its per-tick rate.
 */
function figures(side: Side, mana: number | null, windowSec: number): SideFigures | null {
  if (side.total <= 0) return null
  const out: SideFigures = { total: r1(side.total) }
  if (mana !== null) out.perMana = r1(side.total / mana)
  if (windowSec > 0) out.perSecond = r1(side.total / windowSec)
  return out
}

/**
 * THE CASTING CYCLE one side's total arrives over, in seconds (JOS-444).
 *
 * The cast is always in it, because you spend it either way. On top of that sits whichever is
 * LONGER: the duration an over-time side's ticks run for, or the re-use timer you must wait out
 * before the spell is yours to cast again. Both are measured from the moment the cast completes,
 * so they overlap rather than add - a 30s DoT on a 6s recast is one 30s cycle, not 36.
 */
function cycleSec(overTime: boolean, castSec: number, overSec: number, recastSec: number): number {
  return castSec + Math.max(overTime ? overSec : 0, recastSec)
}

/** The damage side's four fields, written onto the output. */
function writeDamage(f: SideFigures | null, overTime: boolean, out: SpellMetrics): void {
  if (!f) return
  out.damage = f.total
  if (f.perMana !== undefined) out.damagePerMana = f.perMana
  if (f.perSecond !== undefined) out.dps = f.perSecond
  if (overTime) out.dot = true
}

/** The heal side's four, spelled out separately rather than keyed, so the names stay checkable. */
function writeHeal(f: SideFigures | null, overTime: boolean, out: SpellMetrics): void {
  if (!f) return
  out.heal = f.total
  if (f.perMana !== undefined) out.healPerMana = f.perMana
  if (f.perSecond !== undefined) out.hps = f.perSecond
  if (overTime) out.hot = true
}

/** The per-mana and per-second derivations, once both sides are totalled. */
function assemble(
  dmg: Side,
  heal: Side,
  spell: SpellMetricsInput,
  durationTicks: number
): SpellMetrics | undefined {
  const mana = typeof spell.mana === 'number' && spell.mana > 0 ? spell.mana : null
  const castSec = (spell.castTimeMs ?? 0) / 1000
  const overSec = durationTicks * (TICK_MS / 1000)
  const recastMs = spell.recastMs ?? 0
  const recastSec = recastMs > 0 ? recastMs / 1000 : 0
  const d = figures(dmg, mana, cycleSec(dmg.overTime, castSec, overSec, recastSec))
  const h = figures(heal, mana, cycleSec(heal.overTime, castSec, overSec, recastSec))
  if (!d && !h) return undefined
  const out: SpellMetrics = {}
  writeDamage(d, dmg.overTime, out)
  writeHeal(h, heal.overTime, out)
  if ((dmg.overTime || heal.overTime) && overSec > 0) out.overSec = Math.round(overSec)
  if (recastMs > 0) out.recastMs = recastMs
  return out
}

/**
 * A RECAST BELOW THIS IS THE GAME'S GLOBAL COOLDOWN, not a property of the spell (JOS-444).
 *
 * 532 of the catalog's 1,925 stated recasts are exactly 1.5s — the floor every spell in EverQuest
 * pays — and printing `recast 1.5s` on a third of the rows would be a column of noise saying the
 * same thing. It still counts in the arithmetic, because the 1.5s is real time the caster spends;
 * what it does not earn is a word on a dense row.
 *
 * The threshold is drawn just above that floor rather than fitted to a distribution: 539 rows state
 * a positive recast under 2s (532 of them the 1.5s itself, plus 4 at 1.0s and 3 at 0.01s) and 954
 * state 2s or more, the smallest of which is 2s exactly — so the cut lands in a real gap and the
 * floor is inclusive.
 */
const RECAST_PART_MIN_MS = 2000

/** Seconds, one decimal, with a whole number left whole: `6s`, `2.3s`. */
function secondsPart(ms: number): string {
  return `${String(r1(ms / 1000))}s`
}

/**
 * The row's compact figures, in the order the panel prints them:
 * `dmg 143 · dps 48 · 2.1 dmg/mana`, `heal 250 · hps 83 · 3.6 heal/mana`, `over 24s`, `recast 6s`.
 *
 * ONE FORMATTER, shared by the unlock row and (by design) the spell search that reuses these
 * rows - two components formatting the same figures is two opinions about what `2.1` means.
 * No em dashes; the separator is the middle dot the rest of the app already uses.
 *
 * THE RECAST GOES LAST because it is the only part that is not a figure read off the effect list:
 * it is the cycle the per-second numbers were divided by, which is what a reader wants after the
 * number rather than before it.
 */
export function spellMetricsParts(m: SpellMetrics): string[] {
  const parts: string[] = []
  if (m.damage !== undefined) {
    parts.push(`dmg ${String(Math.round(m.damage))}`)
    if (m.dps !== undefined) parts.push(`dps ${String(Math.round(m.dps))}`)
    if (m.damagePerMana !== undefined) parts.push(`${String(m.damagePerMana)} dmg/mana`)
  }
  if (m.heal !== undefined) {
    parts.push(`heal ${String(Math.round(m.heal))}`)
    if (m.hps !== undefined) parts.push(`hps ${String(Math.round(m.hps))}`)
    if (m.healPerMana !== undefined) parts.push(`${String(m.healPerMana)} heal/mana`)
  }
  if (m.overSec !== undefined) parts.push(`over ${String(m.overSec)}s`)
  if (m.recastMs !== undefined && m.recastMs >= RECAST_PART_MIN_MS) {
    parts.push(`recast ${secondsPart(m.recastMs)}`)
  }
  return parts
}
