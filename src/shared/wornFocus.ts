// WHAT YOUR GEAR DOES TO YOUR CASTS (JOS-452, owner ask 2026-08-23: "research focus effects and
// see if we can simulate - based on what you're wearing. pay attention to level range etc.").
//
// This is the small pure core of the worn-focus overlay. It holds no roster, no catalog and no
// inventory: main resolves WHICH focus effects are worn (src/main/planner/wornFocusIndex.ts) and
// hands them across the wire already parsed, and this file owns the four things the model and the
// panel must not each have an opinion about - the SHAPE of a focus effect, the QUALIFICATION test,
// the LEVEL-RANGE arithmetic, and the WORDS.
//
// It is the third member of the deletable-overlay family that `shared/spellScale.ts` (the mote
// rank, JOS-447) and `shared/aoeSpells.ts` (the wave count, JOS-449) started: an INPUT field on
// `SpellMetricsInput`, resolved once, multiplied at the one `foldLine` site, and ABSENT MEANS 1 -
// so every figure this app printed before JOS-452 is unchanged by construction.
//
// ── WHERE THE NUMBERS COME FROM: NOWHERE NEW ──────────────────────────────────────────────────
//
// A focus effect is a SPELL PAGE, and the committed catalog already carries its slot lines
// verbatim. `Improved Damage II` reads:
//
//     Increase Spell Damage by 1% to 20%
//     Limit Max Level: 44 (lose 5% per level after)
//     Limit Effect: Current HP
//     Limit Max Duration: 0s
//     Limit Type: Detrimental
//     Limit Target: Exclude Caster AE / Caster PB / Target AE
//     Limit Target: Exclude Old Giants / Old Dragons
//     Limit Type: Exclude Combat Skills
//
// The ITEM corpus carries the effect NAME and nothing else (measured over items.json: all 150
// focus rows have no `detail` at all), and the name-to-page join already exists - the same exact,
// rank-preserving, case-folded join `effectIndex.ts buildSpellFacts` makes. So no scrape, no fetch
// and no hand-authored percentage table: the magnitudes and the level caps are read off bytes this
// repo already ships.
//
// ── THE LEVEL RANGE, WHICH IS THE HALF THE OWNER FLAGGED ──────────────────────────────────────
//
// `Limit Max Level: N (lose 5% per level after)` limits on the level of the SPELL BEING CAST, not
// on the caster. At or below N the focus is at full strength; above it the focus's OWN value is
// scaled by `(100 - 5 x over) / 100` and is gone entirely twenty levels past the cap. That is what
// the wiki's own prose says in words ("This bonus will decay on spells over level 20") and what
// EQEmu's `CalcFocusEffect` does in code, including the "under one percent left means no effect at
// all" floor. Caps in the committed corpus run 12, 16, 20, 24, 29, 34, 44, 49, 50, 51, 52, 60, 65 -
// tier I is nearly always 20, tier II 44, tier III 60.
//
// ── AND THE BONUS ROLLS. IT IS NOT A FLAT MULTIPLIER ──────────────────────────────────────────
//
// This is the finding that decided what number the readout prints, and it is MEASURED on the
// owner's own log rather than reasoned about. He looted the Polished Mithril Mask (Improved Damage
// II) on Jul 31 2026, which splits his log into a before and an after:
//
//   BEFORE, Chaos Flux on Jul 29 - 88% to 95% of non-critical hits land at EXACTLY the maximum
//   AFTER,  Garrison's Mighty Mana Shock on Aug 22 at L35 (n=261) - 5.4% at the maximum, and the
//           mass sits on TWENTY evenly spaced values (600 596 592 586 581 575 571 566 560 556 550
//           546 541 535 531 525 520 516 510 506, each holding 3% to 6% of the bucket) with the
//           partial-resist tail below them
//
// Twenty values, spaced by one percent of ~500, one roll per cast: `Increase Spell Damage by 1% to
// 20%` is a uniform integer roll of 1..20 percent, exactly as `shared/resistDamage.ts` already
// documents from the owner's own report ("focus effects roll a RANDOM bonus per cast ... uniform
// inside that band", JOS-385/387).
//
// SO THE READING IS THE MIDPOINT, and it is the repo's existing rule rather than a new one:
// `spellMetrics.ts magnitudeAt` reads a stated range at its midpoint because "the midpoint is the
// only summary that does not prefer one end of a claim the wiki did not make". Printing the top of
// the band would put 590 in front of a player whose typical Garrison's is 544 and who reaches 590
// once in twenty casts. Both ends ride on the record (`minPct`/`maxPct`) so the marker's tooltip
// can state the band and the tests can pin it; only the midpoint reaches a figure.
//
// ── AND THEY DO NOT STACK ─────────────────────────────────────────────────────────────────────
//
// The best QUALIFYING focus applies and the rest do nothing. Evidence, from the same log: a worn
// focus firing prints one line naming one item (`Your <item> shimmers briefly.` / `feels alive with
// power.`, JOS-79's law), and in the loadout where the owner carried Improved Damage II on BOTH the
// Polished Mithril Mask and its own exaltation, exactly one of the two ever announced - 6,681 lines
// to zero, not a split. So `bestWornFocus` takes the largest resolved percentage and names the item
// it came from; nothing here ever adds two focuses together.
//
// Pure, node-tested (tests/wornFocus.test.mts). Its ONE import is `isAeTargetType`, because "which
// target types mean more than one creature" is a question `shared/aoeSpells.ts` already answers and
// a second copy of that set is a second opinion.

import { isAeTargetType } from './aoeSpells'

/**
 * WHICH FIGURE A FOCUS MOVES. Only the two the app's own metrics carry.
 *
 * The corpus holds seven more effect heads - spell haste, mana preservation, extended duration,
 * extended range, reagent conservation, pet power, and the four bard instrument resonances - and
 * every one of them is deliberately UNREAD here. Three of those would move a column this readout
 * draws (haste shortens the casting cycle, mana preservation moves `dmg/mana`), and modelling them
 * is a second decision with its own limits (`Limit Min Casting Time`, the reagent lane) rather than
 * an extension of this one. A focus effect whose head this file does not recognise parses to null
 * and says nothing, which is law 1 and not an omission.
 */
export type FocusKind = 'damage' | 'heal'

/** One focus effect that is IN FORCE: what it does, what it will do it to, and what it rides on. */
export interface WornFocus {
  /** the effect's own name, verbatim ("Improved Damage II") */
  effect: string
  /** the ITEM wearing it, as the dump named it - what the spell card prints (the owner's ask) */
  item: string
  kind: FocusKind
  /** the smallest percent the line states; equal to `maxPct` when it states one number */
  minPct: number
  /** the largest percent the line states - the top of the roll band */
  maxPct: number
  /** `Limit Max Level: N`. Absent when the page states no cap, which means it never decays. */
  maxLevel?: number
  /** `Limit Type: Detrimental` / `Beneficial`, lowercased. Absent when the page states neither. */
  polarity?: 'detrimental' | 'beneficial'
  /** `Limit Max Duration: Ns` in ms. `0` is the real answer for a nuke focus: instant spells only. */
  maxDurationMs?: number
  /** `Limit Min Duration: Ns` in ms - what makes Burning Affliction a DoT focus and not a nuke one. */
  minDurationMs?: number
  /** any `Limit Target: Exclude {Caster AE|Caster PB|Target AE}` - the spell must be single-target. */
  excludesArea?: true
  /** `Limit Spell: Exclude <name>`, case-folded. Empty when the page names none. */
  excludesSpells?: readonly string[]
}

/** The spell facts the qualification test reads. A subset of what every caller already holds. */
export interface FocusSpell {
  /** the display name, for the `Limit Spell: Exclude <name>` test */
  name: string
  /**
   * THE LEVEL OF THE SPELL, which is the level a class GAINS it at - never the level being viewed
   * and never the caster's level. `Limit Max Level` is a statement about the spell.
   *
   * Where a loadout could be more than one class the caller passes the LOWEST gain level, which is
   * the same number every other join in this app uses for a spell (`BestSpellRow.gainedAt`,
   * `SpellDetail.metricsLevel`) and which errs in the player's favour by at most a few levels of
   * decay.
   */
  level: number
  /** the catalog's `spellType`, verbatim. Absent means the page stated none. */
  spellType?: string
  /** the catalog's duration in ms. Null or absent is an INSTANT spell, which is a real answer. */
  durationMs?: number | null
  /** the catalog's `target_type`, verbatim - read only through `isAeTargetType`. */
  targetType?: string
}

/** `Limit Max Level: N (lose 5% per level after)` - how many points of the focus one level costs. */
export const FOCUS_DECAY_PER_LEVEL = 5

/** One EQ second, in ms. The limit lines are written in whole and fractional seconds. */
const SECOND_MS = 1000

const DAMAGE_HEAD = /^increase\s+spell\s+damage\s+by\s+(\d+)%(?:\s+to\s+(\d+)%)?/i
const HEAL_HEAD = /^increase\s+healing\s+by\s+(\d+)%(?:\s+to\s+(\d+)%)?/i
/** Both spellings the corpus uses: `Limit Max Level: 44 (...)` and the drift `Limit: Max Level (60)`. */
const MAX_LEVEL = /^limit:?\s*max\s+level:?\s*\(?(\d+)\)?/i
const MAX_DURATION = /^limit:?\s*max\s+duration:?\s*([\d.]+)\s*s/i
const MIN_DURATION = /^limit:?\s*min\s+duration:?\s*([\d.]+)\s*s/i
const POLARITY = /^limit:?\s*type:?\s*(detrimental|beneficial)\s*$/i
const EXCLUDE_AREA = /^limit:?\s*target:?\s*exclude\s+(?:caster\s+ae|caster\s+pb|target\s+ae)\b/i
const EXCLUDE_SPELL = /^limit:?\s*spell:?\s*exclude\s+(.+?)\s*$/i

/** The head of a focus line, read: which figure it moves and the band it moves it by. */
function readHead(line: string): Pick<WornFocus, 'kind' | 'minPct' | 'maxPct'> | null {
  for (const [kind, re] of [['damage', DAMAGE_HEAD], ['heal', HEAL_HEAD]] as const) {
    const m = re.exec(line)
    if (!m) continue
    const lo = Number(m[1])
    const hi = m[2] === undefined ? lo : Number(m[2])
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= 0) return null
    return { kind, minPct: Math.min(lo, hi), maxPct: Math.max(lo, hi) }
  }
  return null
}

/** One limit line, folded onto the record under construction. Anything unrecognised is ignored. */
function readLimit(out: WornFocus, line: string, excluded: string[]): void {
  const level = MAX_LEVEL.exec(line)
  if (level) {
    out.maxLevel = Number(level[1])
    return
  }
  const maxDur = MAX_DURATION.exec(line)
  if (maxDur) {
    out.maxDurationMs = Number(maxDur[1]) * SECOND_MS
    return
  }
  const minDur = MIN_DURATION.exec(line)
  if (minDur) {
    out.minDurationMs = Number(minDur[1]) * SECOND_MS
    return
  }
  const pol = POLARITY.exec(line)
  if (pol) {
    out.polarity = pol[1].toLowerCase() as WornFocus['polarity']
    return
  }
  if (EXCLUDE_AREA.test(line)) out.excludesArea = true
  const spell = EXCLUDE_SPELL.exec(line)
  if (spell) excluded.push(spell[1].trim().toLowerCase())
}

/**
 * A focus effect's spell page, read into the record above - or null when its head is not one of the
 * two this file applies (see `FocusKind`) or when it carries no lines at all.
 *
 * DELIBERATELY UNREAD, and named so a future reader does not think they were missed:
 *   * `Limit Effect: Current HP` - every spell that reaches this overlay has a hitpoint line by
 *     construction, because `spellMetricsAt` produced no figures for one that does not.
 *   * `Limit Effect: Exclude Current HP Percent` - a percentage heal, which `parseHpLine` does not
 *     read either, so no figure this overlay could touch exists for one.
 *   * `Limit Type: Exclude Combat Skills` - 84 of 88 focus pages carry it and no spell is a combat
 *     skill.
 *   * `Limit Target: Exclude Old Giants` / `Old Dragons` - a fact about the TARGET, and this app
 *     never knows which mob a figure is about.
 */
export function parseWornFocus(
  effect: string,
  item: string,
  lines: readonly string[]
): WornFocus | null {
  let out: WornFocus | null = null
  const excluded: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (out === null) {
      const head = readHead(line)
      if (head) out = { effect: effect.trim(), item: item.trim(), ...head }
      continue
    }
    readLimit(out, line, excluded)
  }
  if (out !== null && excluded.length > 0) out.excludesSpells = excluded
  return out
}

/**
 * WHAT FRACTION OF ITS OWN VALUE A FOCUS KEEPS AT A SPELL LEVEL: 1 inside the range, decaying by
 * five points a level above the cap, and 0 from twenty levels past it.
 *
 * The "below one percent left means nothing at all" floor is EQEmu's own (`if (lvlModifier < 1)
 * break`), and it is what makes the twentieth level past the cap a clean zero rather than a
 * rounding question.
 */
export function focusLevelScale(maxLevel: number | undefined, spellLevel: number): number {
  if (maxLevel === undefined || !Number.isFinite(spellLevel)) return 1
  const over = spellLevel - maxLevel
  if (over <= 0) return 1
  const left = 100 - FOCUS_DECAY_PER_LEVEL * over
  return left < 1 ? 0 : left / 100
}

/**
 * The DURATION half of the qualification test, which is the one that separates a nuke focus from a
 * DoT focus over the same `Increase Spell Damage` head.
 *
 * A spell with no duration is read as 0 rather than as "unknown": an instant spell is exactly what
 * `Limit Max Duration: 0s` is about, and the catalog states an absent duration for every one.
 */
function durationAdmits(focus: WornFocus, spell: FocusSpell): boolean {
  const ms = typeof spell.durationMs === 'number' && spell.durationMs > 0 ? spell.durationMs : 0
  if (focus.maxDurationMs !== undefined && ms > focus.maxDurationMs) return false
  return !(focus.minDurationMs !== undefined && ms < focus.minDurationMs)
}

/**
 * The `Limit Spell: Exclude <name>` half. A RANK of a named line is the same spell, so the test is
 * the name or the name plus a numeral - and never a bare substring, which would refuse an unrelated
 * spell for starting with the same word.
 */
function nameAdmits(focus: WornFocus, spell: FocusSpell): boolean {
  const name = spell.name.trim().toLowerCase()
  return !(focus.excludesSpells ?? []).some((x) => name === x || name.startsWith(`${x} `))
}

/** True when this spell is one the focus's own limit lines admit. The level rule is separate. */
export function focusAdmits(focus: WornFocus, spell: FocusSpell): boolean {
  if (focus.polarity !== undefined && spell.spellType?.trim().toLowerCase() !== focus.polarity) {
    return false
  }
  if (!durationAdmits(focus, spell)) return false
  if (focus.excludesArea === true && isAeTargetType(spell.targetType)) return false
  return nameAdmits(focus, spell)
}

/**
 * THE PERCENT ONE FOCUS CONTRIBUTES TO ONE SPELL: the midpoint of its band, scaled by the level
 * rule. 0 when the spell does not qualify or the focus has decayed away.
 *
 * The midpoint rather than the top of the band - the header carries the measurement and the
 * argument. It is deliberately NOT rounded: a 1% to 20% focus is 10.5 percent, and rounding it here
 * would move every figure it touches by half a point for no reason a reader could see.
 */
export function focusPctFor(focus: WornFocus, spell: FocusSpell): number {
  if (!focusAdmits(focus, spell)) return 0
  return ((focus.minPct + focus.maxPct) / 2) * focusLevelScale(focus.maxLevel, spell.level)
}

/** A focus that answered for a spell, and by how much. */
export interface FocusHit {
  focus: WornFocus
  /** the resolved percent - always positive; a hit is never recorded for a zero contribution */
  pct: number
}

/**
 * THE ONE FOCUS THAT APPLIES, of everything worn: the largest qualifying percentage for this spell.
 *
 * Ties break on the effect name so the answer is total and a row cannot swap which item it credits
 * between two renders. They do not stack (see the header); this is the whole stacking rule.
 */
export function bestWornFocus(
  worn: readonly WornFocus[],
  kind: FocusKind,
  spell: FocusSpell
): FocusHit | null {
  let best: FocusHit | null = null
  for (const focus of worn) {
    if (focus.kind !== kind) continue
    const pct = focusPctFor(focus, spell)
    if (pct <= 0) continue
    if (best === null || pct > best.pct || (pct === best.pct && focus.effect < best.focus.effect)) {
      best = { focus, pct }
    }
  }
  return best
}

/**
 * ONE MAGNITUDE WITH A FOCUS ON IT. A zero, negative or unreadable percent returns the amount
 * UNTOUCHED and by identity, which is what makes an absent focus byte-identical to no focus.
 *
 * No rounding: the amounts reaching here are already fractional (a wiki ramp read between its
 * breakpoints, a range read at its midpoint) and `spellMetricsAt` rounds once at the end.
 */
export function applyFocusPct(amount: number, pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0 || amount <= 0) return amount
  return amount * (1 + pct / 100)
}

/** A percent as the marker prints it: whole numbers whole, a half kept. `10.5` reads `+11%`. */
function pctText(pct: number): string {
  return `+${String(Math.round(pct))}%`
}

/**
 * THE VISIBLE MARKER (the owner's ask: the multiply must be visible, and the caveat diet says one
 * quiet word rather than a sentence - `aoeAssumptionLabel` is the model, one file over).
 *
 * COMPUTED FROM THE ROWS IN FORCE, never from the worn set: a table where one spell is inside its
 * focus's level range and another has decayed halfway is captioned with the range it really used.
 * Null when nothing in force was focused at all, which is what keeps the marker off a surface it
 * has nothing to say about.
 */
export function wornFocusLabel(pcts: readonly number[]): string | null {
  const seen = pcts.filter((p) => Number.isFinite(p) && p > 0)
  if (seen.length === 0) return null
  const lo = Math.min(...seen)
  const hi = Math.max(...seen)
  const loText = pctText(lo)
  const hiText = pctText(hi)
  return loText === hiText ? `worn ${hiText}` : `worn ${loText} to ${hiText}`
}

/** The longer sentence behind the marker, for its tooltip. Stated once, beside the words. */
export const WORN_FOCUS_TITLE =
  'Figures include the focus effects your gear is wearing, applied only where the spell is inside the focus effect level range and faded out above it. A focus rolls a fresh bonus on every cast, so the figure uses the middle of its band rather than its best case.'
