// WHAT YOUR GEAR DOES TO YOUR CASTS (JOS-452) — the worn-focus overlay, pinned five ways:
//
//   1. the PARSE, over every focus page the committed catalog carries (a sweep with floors, the
//      `plannerFocusFamily.test.mts` shape) plus the hand cases the ticket named;
//   2. the LEVEL RANGE, which is the half the owner flagged;
//   3. the QUALIFICATION limits, which are what make Improved Damage a nuke focus and Burning
//      Affliction a DoT one over the same `Increase Spell Damage` head;
//   4. the JOIN, over the owner's real committed 295-line dump — including the exaltation socket,
//      which is where his entire damage focus lives;
//   5. the OWNER'S ACCEPTANCE, which is the log-measured worn factor of ~1.2216 the brief named,
//      decomposed and written down here so the fit can be re-argued rather than trusted.
//
// ── THE MEASUREMENT BEHIND THE ACCEPTANCE, SO LOSING IT NEVER MEANS MINING 200 MB AGAIN ────────
//
// The owner looted the Polished Mithril Mask on `[Fri Jul 31 18:00:11 2026]` and it began
// announcing itself at 18:02:18, which splits his log cleanly:
//
//   Jul 29, Chaos Flux and Anarchy - the worn factor is 1.017, and 88% to 95% of non-critical hits
//           in a bucket land at EXACTLY the maximum. No damage focus is on.
//   Aug 22, Garrison's Mighty Mana Shock at L35 (n=261) - the worn factor is 1.2216, only 5.4% of
//           hits are at the maximum, and the mass sits on TWENTY evenly spaced values:
//           600 596 592 586 581 575 571 566 560 556 550 546 541 535 531 525 520 516 510 506.
//
// Twenty values spaced by one percent of ~500 is a uniform integer roll of 1..20 percent, one roll
// per cast - which is exactly what `Increase Spell Damage by 1% to 20%` states and what
// `shared/resistDamage.ts` already documents from the owner's own report (JOS-385/387). So:
//
//     1.2216  =  1.20 (Improved Damage II at the TOP of its roll)  x  1.017 (unmodelled residual)
//     1.017   =  no damage focus                                   x  1.017
//
// The focus model explains the ENTIRE step change between the two windows. The residual is present
// in the July windows where no damage focus was worn, so it is not focus and this app models it
// nowhere; `spellScale.ts`'s header carries it as the same unexplained factor.
//
// No Electron, no network, no live log - this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyFocusPct,
  bestWornFocus,
  focusAdmits,
  focusLevelScale,
  focusPctFor,
  parseWornFocus,
  wornFocusLabel,
  type FocusSpell,
  type WornFocus
} from '../src/shared/wornFocus'
import { focusBearers, FOCUS_SOCKET_INDEX } from '../src/shared/planner/inventorySlots'
import { parseInventoryDump } from '../src/main/outputs/inventoryParse'
import { buildFocusLines, wornFocusFor } from '../src/main/planner/wornFocusIndex'
import type { ItemDbFile } from '../src/main/itemsDb'
import type { SpellDbFile } from '../src/shared/types'
import itemsJson from '../src/main/data/items.json' with { type: 'json' }
import spellsJson from '../src/main/data/spells.json' with { type: 'json' }

const ITEMS = itemsJson as unknown as ItemDbFile
const SPELLS = (spellsJson as unknown as SpellDbFile).spells
const LINES = buildFocusLines(SPELLS)

/** The page lines for one focus effect, straight off the committed catalog. */
function linesOf(effect: string): readonly string[] {
  const found = LINES.get(effect.toLowerCase())
  assert.ok(found, `${effect} has no spell page in the committed catalog`)
  return found
}

const focusOf = (effect: string, item = 'a test item'): WornFocus => {
  const parsed = parseWornFocus(effect, item, linesOf(effect))
  assert.ok(parsed, `${effect} did not parse into a focus this app applies`)
  return parsed
}

/** A spell as the qualification test reads one. Instant, single-target, detrimental by default. */
function spell(over: Partial<FocusSpell> = {}): FocusSpell {
  return { name: 'A Nuke', level: 20, spellType: 'Detrimental', ...over }
}

// ---- 1: the parse ------------------------------------------------------------------------

test('every focus page the catalog carries either parses or is honestly refused', () => {
  // The CORPUS SWEEP. A focus name on an item joins a page; the page either states a head this
  // overlay applies (damage or healing) or it does not, and neither answer may be a crash or a
  // half-built record.
  const names = new Set<string>()
  for (const entry of Object.values(ITEMS.items)) {
    for (const e of entry.stats?.effects ?? []) if (e.kind === 'focus') names.add(e.name)
  }
  assert.ok(names.size >= 70, `only ${String(names.size)} distinct focus effect names in the corpus`)
  let applied = 0
  let refused = 0
  for (const name of names) {
    const page = LINES.get(name.trim().toLowerCase())
    if (page === undefined) {
      refused++
      continue
    }
    const parsed = parseWornFocus(name, 'x', page)
    if (parsed === null) {
      refused++
      continue
    }
    applied++
    assert.ok(parsed.maxPct > 0, `${name}: a head with no magnitude`)
    assert.ok(parsed.minPct <= parsed.maxPct, `${name}: an inverted band`)
    assert.equal(parsed.effect, name.trim(), `${name}: the record must name its own effect`)
  }
  // The two heads this overlay applies are a MINORITY of the corpus on purpose - the seven it does
  // not read are named in `wornFocus.ts FocusKind`, with the reason.
  assert.ok(applied >= 12, `only ${String(applied)} focus names moved a figure`)
  assert.ok(refused >= 40, `only ${String(refused)} were refused; the sweep is not seeing the corpus`)
})

test('the two heads read their band, their cap and their limits off the page', () => {
  const damage = focusOf('Improved Damage II')
  assert.equal(damage.kind, 'damage')
  assert.equal(damage.minPct, 1)
  assert.equal(damage.maxPct, 20)
  assert.equal(damage.maxLevel, 44)
  assert.equal(damage.polarity, 'detrimental')
  // `Limit Max Duration: 0s` is what makes it a NUKE focus and not a DoT one.
  assert.equal(damage.maxDurationMs, 0)
  assert.equal(damage.excludesArea, true)

  const heal = focusOf('Improved Healing III')
  assert.equal(heal.kind, 'heal')
  assert.equal(heal.maxPct, 20)
  assert.equal(heal.maxLevel, 60)
  assert.equal(heal.polarity, 'beneficial')
  assert.deepEqual(
    [...(heal.excludesSpells ?? [])].sort(),
    ['complete heal', 'promised renewal'],
    'the two spells the healing focus names'
  )

  // The SAME head, the OPPOSITE duration limit: a DoT focus.
  const dot = focusOf('Burning Affliction II')
  assert.equal(dot.kind, 'damage')
  assert.equal(dot.minDurationMs, 24_000)
  assert.equal(dot.maxDurationMs, undefined)
})

test('a focus head this overlay does not apply parses to null, and says nothing', () => {
  // Seven heads exist and five are refused here: haste, mana preservation, duration, range, reagent.
  for (const name of ['Spell Haste II', 'Mana Preservation I', 'Extended Enhancement III', 'Extended Range II', 'Reagent Conservation I']) {
    assert.equal(parseWornFocus(name, 'x', linesOf(name)), null, name)
  }
  // And a page with no lines at all is not a focus record either.
  assert.equal(parseWornFocus('Nothing', 'x', []), null)
})

// ---- 2: the level range ------------------------------------------------------------------

test('a focus is at full strength inside its range, decays five points a level, and is gone at +20', () => {
  assert.equal(focusLevelScale(44, 1), 1, 'far below the cap')
  assert.equal(focusLevelScale(44, 44), 1, 'AT the cap is still full strength')
  assert.equal(focusLevelScale(44, 45), 0.95)
  assert.equal(focusLevelScale(44, 54), 0.5, 'ten levels over is half')
  assert.equal(focusLevelScale(44, 63), 0.05)
  assert.equal(focusLevelScale(44, 64), 0, 'twenty levels over is nothing at all')
  assert.equal(focusLevelScale(44, 99), 0)
  // A page that states no cap never decays - and a level nobody stated cannot make one decay.
  assert.equal(focusLevelScale(undefined, 65), 1)
  assert.equal(focusLevelScale(44, Number.NaN), 1)
})

test('THE LEVEL RANGE IS THE SPELL`S, and the percentage moves with it', () => {
  const damage = focusOf('Improved Damage II')
  // Midpoint of 1..20 is 10.5, and that is what a spell inside the range gets.
  assert.equal(focusPctFor(damage, spell({ level: 18 })), 10.5)
  assert.equal(focusPctFor(damage, spell({ level: 44 })), 10.5)
  // Above the cap it fades rather than switching off - a spell gained at 49 keeps three quarters.
  assert.equal(focusPctFor(damage, spell({ level: 49 })), 10.5 * 0.75)
  assert.equal(focusPctFor(damage, spell({ level: 64 })), 0, 'and past +20 the focus is not there')
})

// ---- 3: the qualification limits ---------------------------------------------------------

test('a nuke focus refuses a DoT, and a DoT focus refuses a nuke', () => {
  const nuke = focusOf('Improved Damage II')
  const dot = focusOf('Burning Affliction II')
  const instant = spell({ durationMs: null })
  const ticking = spell({ durationMs: 60_000 })
  assert.equal(focusAdmits(nuke, instant), true)
  assert.equal(focusAdmits(nuke, ticking), false, '`Limit Max Duration: 0s`')
  assert.equal(focusAdmits(dot, ticking), true)
  assert.equal(focusAdmits(dot, instant), false, '`Limit Min Duration: 24s`')
  // And the boundary is inclusive at both ends: exactly 24s qualifies.
  assert.equal(focusAdmits(dot, spell({ durationMs: 24_000 })), true)
  assert.equal(focusAdmits(dot, spell({ durationMs: 18_000 })), false)
})

test('a damage focus refuses a beneficial spell and an AREA spell', () => {
  const nuke = focusOf('Improved Damage II')
  assert.equal(focusAdmits(nuke, spell({ spellType: 'Beneficial' })), false)
  assert.equal(focusAdmits(nuke, spell({ spellType: undefined })), false, 'a page that states none')
  for (const targetType of ['Targeted AE', 'PB AE', 'PBAOE']) {
    assert.equal(focusAdmits(nuke, spell({ targetType })), false, targetType)
  }
  assert.equal(focusAdmits(nuke, spell({ targetType: 'Single' })), true)
})

test('a healing focus honours the spells its page excludes BY NAME', () => {
  const heal = focusOf('Improved Healing III')
  const beneficial = { spellType: 'Beneficial' as const }
  assert.equal(focusAdmits(heal, spell({ ...beneficial, name: 'Superior Healing' })), true)
  assert.equal(focusAdmits(heal, spell({ ...beneficial, name: 'Complete Heal' })), false)
  // The exclusion reaches the RANKS of a named line, which is the only reading that means anything:
  // a page naming `Complete Heal` is not silent about `Complete Heal II`.
  assert.equal(focusAdmits(heal, spell({ ...beneficial, name: 'Complete Heal II' })), false)
  // But it is a name and not a substring - a different spell that merely starts similarly is fine.
  assert.equal(focusAdmits(heal, spell({ ...beneficial, name: 'Completely Unrelated' })), true)
})

// ---- the arithmetic and the stacking rule ------------------------------------------------

test('the best QUALIFYING focus applies, and nothing ever stacks', () => {
  const two = focusOf('Improved Damage II', 'Polished Mithril Mask (Exaltation)')
  const one = focusOf('Minor Improved Damage I', 'a lesser thing')
  const hit = bestWornFocus([one, two], 'damage', spell({ level: 18 }))
  assert.ok(hit)
  assert.equal(hit.focus.effect, 'Improved Damage II', 'the larger band wins')
  assert.equal(hit.pct, 10.5, 'and the answer is ONE focus, never the sum of two')
  // The side is a hard filter: a healing question never reaches a damage focus.
  assert.equal(bestWornFocus([one, two], 'heal', spell({ level: 18 })), null)
  // A focus that does not qualify is not a weaker answer, it is no answer.
  assert.equal(bestWornFocus([two], 'damage', spell({ level: 18, durationMs: 60_000 })), null)
  // WEARING THE SAME EFFECT TWICE IS STILL ONE FOCUS - the tie breaks on the effect name so the
  // credited item cannot swap between two renders.
  const twice = bestWornFocus([two, focusOf('Improved Damage II', 'the other copy')], 'damage', spell())
  assert.equal(twice?.pct, 10.5)
})

test('applying a focus is exactly the percentage, and no focus is the identity', () => {
  assert.equal(applyFocusPct(492, 0), 492)
  assert.equal(applyFocusPct(492, -5), 492)
  assert.equal(applyFocusPct(492, Number.NaN), 492)
  assert.equal(applyFocusPct(0, 20), 0, 'nothing is not scaled up out of nothing')
  assert.equal(applyFocusPct(100, 10.5), 110.5)
  assert.equal(applyFocusPct(492, 20), 590.4)
})

test('the marker states the rows in force, and says nothing when nothing was focused', () => {
  assert.equal(wornFocusLabel([]), null)
  assert.equal(wornFocusLabel([0, 0]), null, 'a zero is not a focus')
  assert.equal(wornFocusLabel([10.5]), 'worn +11%')
  assert.equal(wornFocusLabel([10.5, 10.5]), 'worn +11%')
  assert.equal(wornFocusLabel([5.25, 10.5]), 'worn +5% to +11%')
  // No em dashes anywhere near a player (AGENTS.md).
  for (const label of [wornFocusLabel([10.5]), wornFocusLabel([5.25, 10.5])]) {
    assert.doesNotMatch(String(label), /[–—]/)
  }
})

// ---- 4: the join, over the owner's real dump ---------------------------------------------

const REAL_DUMP = parseInventoryDump(
  readFileSync(join(import.meta.dirname, 'fixtures', 'Primitive_freeport-Inventory.txt'), 'utf8')
)

test('the focus sockets of EQUIPPED items count, and a bag`s sockets do not', () => {
  const bearers = focusBearers(REAL_DUMP)
  const names = bearers.map((b) => b.name)
  assert.equal(FOCUS_SOCKET_INDEX, 7, 'the measured socket index; wornFocusIndex.ts carries the census')
  // The item on the body.
  assert.ok(names.includes('Polished Mithril Mask'), 'the worn face item')
  // AND the exaltation socketed into an equipped item - `Face-Slot7`, `Range-Slot7`, `Feet-Slot7`.
  assert.ok(
    bearers.some((b) => b.name === 'Golden Efreeti Boots' && b.exaltation),
    'a focus exaltation socketed into the boots he is wearing'
  )
  // NOT a bag: `General 6-Slot4` holds a Serpentine Bracer and `-Slot4-Slot7` its exaltation.
  assert.equal(names.includes('Serpentine Bracer'), false, 'an item in a bag is not being worn')
  // NOT a non-focus socket: `Primary-Slot10` holds a `Thelvorn, Blade of Light (Exaltation)`. The
  // sword itself is worn and IS a bearer; what must never be read is its socketed copy, because
  // slot 10 is the proc socket and whatever went in there did not go in as a focus.
  assert.ok(names.includes('Thelvorn, Blade of Light'), 'the sword on his body is a bearer')
  assert.equal(
    bearers.some((b) => b.name === 'Thelvorn, Blade of Light' && b.exaltation),
    false,
    'a proc socket is not a focus one'
  )
  // The ` +N` is split off, because the corpus is keyed by the base name.
  assert.equal(names.some((n) => / \+\d+$/.test(n)), false)
})

test('the owner`s committed dump resolves to the focus effects his gear really carries', () => {
  const worn = wornFocusFor(REAL_DUMP, ITEMS, LINES)
  const byEffect = new Map(worn.map((w) => [w.effect, w]))
  // The two heads this overlay applies. Everything else his gear carries (Extended Range II,
  // Enhancement Haste II) is refused at the parse and correctly absent.
  assert.deepEqual([...byEffect.keys()].sort(), ['Improved Damage II', 'Improved Healing III'])
  // AND THE ITEM IS NAMED, which is the owner's ask: the card has to say what did this.
  assert.equal(byEffect.get('Improved Damage II')?.item, 'Polished Mithril Mask')
  assert.equal(byEffect.get('Improved Healing III')?.item, 'Idol of the Underking')
  // ONE RECORD PER EFFECT. He wears Improved Damage II on the face item AND in that item's own
  // exaltation socket; they do not stack, and the copy on his BODY is the one the card names.
  assert.equal(worn.filter((w) => w.effect === 'Improved Damage II').length, 1)
})

test('an exaltation is credited BY NAME as an exaltation', () => {
  // The owner's LIVE loadout moved the damage focus entirely into the socket (the face item became
  // a Triumphant Mask, which carries none), so the socketed spelling is what a card will print far
  // more often than the worn one. Driven here off a hand-authored dump rather than his live file,
  // which is not committed and never will be.
  const dump = parseInventoryDump(
    [
      'Location\tName\tID\tCount\tSlots',
      'Face\tTriumphant Mask +3\t1\t1\t10',
      'Face-Slot7\tPolished Mithril Mask (Exaltation)\t4505\t1\t10'
    ].join('\n')
  )
  const worn = wornFocusFor(dump, ITEMS, LINES)
  assert.equal(worn.length, 1)
  assert.equal(worn[0].effect, 'Improved Damage II')
  assert.equal(worn[0].item, 'Polished Mithril Mask (Exaltation)')
})

test('an item the corpus has never heard of contributes nothing, and does not throw', () => {
  // MEASURED, and it is the owner's own gear: `Djarn's Amethyst Ring` is his most-announced focus
  // item (19,291 firings in his log) and is MISSING from items.json entirely. Law 1 - the app says
  // nothing about it rather than guessing.
  assert.equal(ITEMS.items["djarn's amethyst ring"], undefined, 'the corpus gap this pins')
  const dump = parseInventoryDump(
    ['Location\tName\tID\tCount\tSlots', "Fingers\tDjarn's Amethyst Ring +4\t10366\t1\t10"].join('\n')
  )
  assert.deepEqual(wornFocusFor(dump, ITEMS, LINES), [])
})

// ---- 5: the owner's acceptance -----------------------------------------------------------

/**
 * THE LOG-MEASURED WORN FACTOR, DECOMPOSED. See this file's header for the measurement itself.
 *
 * The model reproduces the FOCUS half exactly, at the top of the roll band; the residual is not
 * focus and is not claimed to be.
 */
const MEASURED_AUGUST = 1.2216
const MEASURED_JULY = 1.017

test('acceptance: the owner`s Improved Damage II is the whole step between his July and August logs', () => {
  const mask = focusOf('Improved Damage II', 'Polished Mithril Mask (Exaltation)')
  // Garrison's Mighty Mana Shock: a wizard's L18 single-target instant nuke, inside the cap of 44.
  const garrisons = spell({ name: "Garrison's Mighty Mana Shock", level: 18, targetType: 'Single', durationMs: null })
  assert.equal(focusAdmits(mask, garrisons), true)
  // THE TOP OF THE BAND is what the log's MAXIMUM hits measure, and it is 1.20 exactly.
  const top = applyFocusPct(1, mask.maxPct)
  assert.equal(top, 1.2)
  // Which leaves the residual the July windows already carried, to within the rounding an integer
  // maximum can resolve.
  assert.ok(Math.abs(MEASURED_AUGUST / top - MEASURED_JULY) < 0.002, `residual ${String(MEASURED_AUGUST / top)}`)
  // AND THE FIGURE THE READOUT PRINTS IS THE MIDDLE OF THE BAND, not the top - the header carries
  // the twenty-value histogram that says the bonus rolls. His fitted rank-VIII base is 492.
  assert.equal(Math.round(applyFocusPct(492, focusPctFor(mask, garrisons))), 544)
  assert.equal(Math.round(applyFocusPct(492, mask.maxPct)), 590, 'the best case, which is not what is drawn')
})

test('acceptance: a spell above the focus`s level cap reads lower, and one far above reads base', () => {
  const mask = focusOf('Improved Damage II')
  // Discordant Mind is an enchanter L43 nuke: inside the cap of 44, so it gets the whole focus.
  assert.equal(focusPctFor(mask, spell({ level: 43 })), 10.5)
  // A spell gained at 50 is six levels over and keeps seventy percent of it.
  assert.equal(focusPctFor(mask, spell({ level: 50 })), 10.5 * 0.7)
  // And a level-65 spell is past the twenty, so the row shows the base figure with no marker on it.
  assert.equal(focusPctFor(mask, spell({ level: 65 })), 0)
})
