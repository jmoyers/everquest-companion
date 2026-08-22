// PLANNER NORMALIZATION TESTS — the hand-authored variant tables, pinned against the corpus.
//
// Two layers, on purpose:
//   1. TABLE COVERAGE — every distinct slot/class token the committed corpus states today is
//      asserted by hand below. That inventory (measured 2026-08-04 over all 11,155 distinct item
//      pages in src/main/data/items.json) is the whole justification for a hand-authored table
//      instead of fuzzy matching (law 12), so it is written out rather than derived.
//   2. A CORPUS SWEEP — normalize every Slot:/Class: line in the real items.json and assert the
//      tables leave NOTHING unknown. This is the tripwire: a rescrape that introduces a new
//      spelling turns this red, which is exactly the moment a human should add a verified row.
//
// Counts are FLOORS or identities, never today's exact numbers (AGENTS.md: frozen numbers rot).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isHasteEffect,
  normalizeClasses,
  normalizeSlotTokens,
  socketTypeOf
} from '../src/shared/planner/normalize'
import { EQUIP_SLOTS } from '../src/shared/planner/types'
import { CLASS_ABBRS } from '../src/shared/classCombo'
import { buildItemDbIndex, type ItemDbFile } from '../src/main/itemsDb'
import itemsJson from '../src/main/data/items.json'

const db = itemsJson as unknown as ItemDbFile
const index = buildItemDbIndex(db)

/** Distinct item PAGES (an item can carry two keys — title and `|itemname`). */
function pages(): ItemDbFile['items'][string][] {
  const byPage = new Map<string, ItemDbFile['items'][string]>()
  for (const [, e] of index) if (!byPage.has(e.page)) byPage.set(e.page, e)
  return [...byPage.values()]
}

// ---- slots ------------------------------------------------------------------------

/**
 * THE MEASURED SLOT INVENTORY: all 32 distinct tokens, with the count they appeared at, and what
 * the table must do with each. `null` = noise, dropped silently (it is punctuation, not a slot).
 */
const SLOT_TOKENS: [token: string, canonical: string | null][] = [
  // the 18 canonical spellings (PRIMARY 1706 … AMMO 88)
  ['PRIMARY', 'PRIMARY'],
  ['SECONDARY', 'SECONDARY'],
  ['CHEST', 'CHEST'],
  ['HEAD', 'HEAD'],
  ['NECK', 'NECK'],
  ['WRIST', 'WRIST'],
  ['HANDS', 'HANDS'],
  ['FEET', 'FEET'],
  ['LEGS', 'LEGS'],
  ['ARMS', 'ARMS'],
  ['RANGE', 'RANGE'],
  ['WAIST', 'WAIST'],
  ['FACE', 'FACE'],
  ['BACK', 'BACK'],
  ['SHOULDERS', 'SHOULDERS'],
  ['FINGER', 'FINGER'],
  ['EAR', 'EAR'],
  ['AMMO', 'AMMO'],
  // hand-verified typos / plurals
  ['SHOULDER', 'SHOULDERS'],
  ['FINGERS', 'FINGER'],
  ['SECONDAY', 'SECONDARY'],
  // case variants (law 2 — fold at the boundary)
  ['Chest', 'CHEST'],
  ['Primary', 'PRIMARY'],
  ['Secondary', 'SECONDARY'],
  ['Ammo', 'AMMO'],
  ['Head', 'HEAD'],
  ['Range', 'RANGE'],
  ['Back', 'BACK'],
  ['Face', 'FACE'],
  ['Hands', 'HANDS'],
  // case variants added by the 2026-08-22 rescrape (the Mistmoore-rework wave of wiki edits
  // writes Title Case slot lines; the fold already handled them, only this inventory grew)
  ['Waist', 'WAIST'],
  ['Wrist', 'WRIST'],
  ['Feet', 'FEET'],
  ['Neck', 'NECK'],
  ['Arms', 'ARMS'],
  ['Shoulders', 'SHOULDERS'],
  ['Fingers', 'FINGER'],
  ['Ear', 'EAR'],
  // punctuation the wiki leaves behind
  ['BACK,', 'BACK'],
  ['/', null]
]

test('every measured slot token maps to a canonical slot or to silence', () => {
  assert.equal(SLOT_TOKENS.length, 40, 'the measured inventory is 40 distinct tokens (2026-08-22 rescrape)')
  for (const [token, canonical] of SLOT_TOKENS) {
    const { slots, unknown } = normalizeSlotTokens(token)
    assert.deepEqual(unknown, [], `${token} should be known to the table`)
    assert.deepEqual(slots, canonical == null ? [] : [canonical], `${token} normalized wrong`)
  }
})

test('the canonical slot list is closed and has no CHARM', () => {
  // 18 slots, and deliberately no CHARM: zero pages in the corpus name one (measured), so a
  // CHARM cell could only ever render empty while claiming the game has such a slot.
  assert.equal(EQUIP_SLOTS.length, 18)
  assert.ok(!EQUIP_SLOTS.includes('CHARM' as never))
  assert.equal(new Set(EQUIP_SLOTS).size, EQUIP_SLOTS.length, 'no duplicates')
})

test('multi-slot strings split into every slot they name', () => {
  // Verbatim rows from the corpus.
  assert.deepEqual(normalizeSlotTokens('PRIMARY SECONDARY').slots, ['PRIMARY', 'SECONDARY'])
  assert.deepEqual(normalizeSlotTokens('RANGE PRIMARY SECONDARY').slots, ['RANGE', 'PRIMARY', 'SECONDARY'])
  assert.deepEqual(normalizeSlotTokens('SHOULDERS ARMS BACK CHEST LEGS').slots, [
    'SHOULDERS',
    'ARMS',
    'BACK',
    'CHEST',
    'LEGS'
  ])
  assert.deepEqual(normalizeSlotTokens('BACK, SHOULDER').slots, ['BACK', 'SHOULDERS'])
  assert.deepEqual(normalizeSlotTokens('PRIMARY / SECONDARY').slots, ['PRIMARY', 'SECONDARY'])
  assert.deepEqual(normalizeSlotTokens('PRIMARY SECONDAY').slots, ['PRIMARY', 'SECONDARY'])
  assert.deepEqual(normalizeSlotTokens('EAR FINGERS').slots, ['EAR', 'FINGER'])
  // A slot named twice under two spellings is still one slot.
  assert.deepEqual(normalizeSlotTokens('FINGER FINGERS').slots, ['FINGER'])
})

test('an unknown slot token is returned verbatim, never guessed at', () => {
  const { slots, unknown } = normalizeSlotTokens('CHEST SHIELD')
  assert.deepEqual(slots, ['CHEST'])
  assert.deepEqual(unknown, ['SHIELD'], 'unknown tokens surface for a human to verify')
  assert.deepEqual(normalizeSlotTokens(undefined), { slots: [], unknown: [] })
  assert.deepEqual(normalizeSlotTokens('').slots, [])
})

test('the slot table covers the whole committed corpus', () => {
  const seen = new Set<string>()
  const stray: string[] = []
  let stated = 0
  for (const entry of pages()) {
    const slot = entry.stats?.slot
    if (slot == null) continue
    stated++
    for (const raw of slot.split(/\s+/).filter(Boolean)) seen.add(raw)
    for (const u of normalizeSlotTokens(slot).unknown) stray.push(`${entry.page}: ${u}`)
  }
  // Floor under the 2026-08-04 measurement (6,854 of 11,155 pages state an equip slot).
  assert.ok(stated >= 6000, `only ${stated} pages state a slot — expected >= 6000`)
  assert.deepEqual(stray.slice(0, 20), [], 'slot tokens the hand-authored table does not know')
  // Every token the corpus states must be in the table above, so the inventory can't drift.
  const known = new Set(SLOT_TOKENS.map(([t]) => t))
  assert.deepEqual([...seen].filter((t) => !known.has(t)), [], 'corpus token missing from SLOT_TOKENS')
})

// ---- classes ----------------------------------------------------------------------

test('ALL means all sixteen, NONE means none, and case folds', () => {
  assert.deepEqual(normalizeClasses(['ALL']), [...CLASS_ABBRS])
  assert.deepEqual(normalizeClasses(['All']), [...CLASS_ABBRS])
  assert.deepEqual(normalizeClasses(['NONE']), [])
  assert.deepEqual(normalizeClasses(['None']), [])
  assert.deepEqual(normalizeClasses(undefined), [])
  assert.deepEqual(normalizeClasses([]), [])
})

test('`ALL except X Y` is the complement, computed not guessed', () => {
  // The corpus's most common exception row (455 pages) — the four pure casters.
  const casters = normalizeClasses(['ALL', 'except', 'NEC', 'WIZ', 'MAG', 'ENC'])
  assert.equal(casters.length, 12)
  for (const c of ['NEC', 'WIZ', 'MAG', 'ENC']) assert.ok(!casters.includes(c as never), `${c} excluded`)
  for (const c of ['WAR', 'BRD', 'BER']) assert.ok(casters.includes(c as never), `${c} kept`)
  assert.deepEqual(normalizeClasses(['ALL', 'except', 'MNK']).length, 15)
})

test('a bare `ALL except` states nothing and is reported as unknown', () => {
  // Nine pages write exactly this (Stein, Efreeti Dirk, Geologist's Hammer, Kerran Fishingpole,
  // Poorly Balanced Mace, Soulforge Hammer, Staff, Goblin Shin Splinter, Stein (of Water)).
  // "Complement of nothing = all 16" would invent the class list the page declined to state.
  assert.deepEqual(normalizeClasses(['ALL', 'except']), [])
})

test('explicit class lists keep their order, dedupe, and drop annotations', () => {
  assert.deepEqual(normalizeClasses(['WAR', 'PAL', 'SHD']), ['WAR', 'PAL', 'SHD'])
  assert.deepEqual(normalizeClasses(['WAR', 'WAR']), ['WAR'])
  // One page writes level annotations inline: "Class: CLR (35) PAL (48)" (Spell: Armor of Faith).
  assert.deepEqual(normalizeClasses(['CLR', '(35)', 'PAL', '(48)']), ['CLR', 'PAL'])
  // A token that is not a class code at all is dropped, never coerced.
  assert.deepEqual(normalizeClasses(['WAR', 'SHAMAN']), ['WAR'])
})

test('the class table covers the whole committed corpus', () => {
  const seen = new Set<string>()
  let allRows = 0
  let exceptRows = 0
  let noneRows = 0
  for (const entry of pages()) {
    const classes = entry.stats?.classes
    if (!classes) continue
    for (const t of classes) seen.add(t)
    if (classes.includes('except')) exceptRows++
    else if (classes.some((c) => c.toUpperCase() === 'ALL')) allRows++
    else if (classes.some((c) => c.toUpperCase() === 'NONE')) noneRows++
    const out = normalizeClasses(classes)
    assert.ok(out.length <= CLASS_ABBRS.length, `${entry.page} produced more than 16 classes`)
    for (const c of out) assert.ok(CLASS_ABBRS.includes(c), `${entry.page} produced a non-class ${c}`)
  }
  // Floors under the 2026-08-04 measurement (ALL 4752 bare rows, except 757, NONE 227).
  assert.ok(allRows >= 4000, `only ${allRows} plain ALL rows`)
  assert.ok(exceptRows >= 700, `only ${exceptRows} 'except' rows`)
  assert.ok(noneRows >= 150, `only ${noneRows} NONE rows`)
  // The measured token inventory: 16 codes + ALL/All + NONE/None + except + two annotations —
  // plus `War`, the one Title Case class code the 2026-08-22 rescrape added (the case fold
  // already normalizes it; it is listed so the inventory stays a census and not a guess).
  const known = new Set<string>([...CLASS_ABBRS, 'ALL', 'All', 'NONE', 'None', 'except', '(35)', '(48)', 'War'])
  assert.deepEqual([...seen].filter((t) => !known.has(t)), [], 'corpus class token outside the measured set')
})

// ---- socket types (D2) -------------------------------------------------------------

test('combat and proc are one socket family, and a bare Effect is excluded', () => {
  assert.equal(socketTypeOf('combat'), 'proc')
  assert.equal(socketTypeOf('proc'), 'proc')
  assert.equal(socketTypeOf('worn'), 'worn')
  assert.equal(socketTypeOf('focus'), 'focus')
  assert.equal(socketTypeOf('click'), 'click')
  assert.equal(socketTypeOf('effect'), null, "a bare Effect: line names no socket — v1 excludes it")
})

/** Effect rows per `ItemEffectKind`, counted over item KEYS (the shape the index builder walks). */
function effectKindCounts(): (kind: string) => number {
  const kinds = new Map<string, number>()
  for (const [, entry] of index) {
    for (const eff of entry.stats?.effects ?? []) kinds.set(eff.kind, (kinds.get(eff.kind) ?? 0) + 1)
  }
  return (kind) => kinds.get(kind) ?? 0
}

test('the corpus really does spell procs `Combat Effect:` (D2)', () => {
  // Re-measured 2026-08-04 over item KEYS: click 823, combat 453, focus 143, worn 104, effect 51,
  // proc 0. A planner filtering `kind === 'proc'` would render an empty Proc tab.
  const n = effectKindCounts()
  const procFamily = n('combat') + n('proc')
  assert.ok(procFamily >= 400, `proc family is only ${procFamily} rows`)
  assert.ok(n('combat') > n('proc'), '`combat` is the spelling procs use')
  assert.ok(n('click') >= 700, 'click floor')
  assert.ok(n('focus') >= 100, 'focus floor')
  assert.ok(n('worn') >= 90, 'worn floor')
})

// ---- R3: the haste lock ------------------------------------------------------------

test('the haste family is locked — every attack-haste effect in the corpus', () => {
  // Names verified against spells.json's shared wear-off "Your speed returns to normal." plus the
  // two literal Haste spellings; all of these appear on real item pages today.
  for (const name of [
    'Haste',
    'Brittle Haste I',
    'Brittle Haste IV',
    'Alacrity',
    'Celerity',
    'Quickness',
    'Flurry',
    'Swift Like the Wind',
    'Swift Spirit',
    'Blessing of the Grove',
    "Aanya's Quickening",
    'Wonderous Rapidity',
    'Speed of the Shissar'
  ]) {
    assert.equal(isHasteEffect(name), true, `${name} must be haste-locked`)
  }
  assert.equal(isHasteEffect('Haste', 'Combat, Casting Time: Instant'), true)
  assert.equal(isHasteEffect('Haste', 'Req Level 30'), true)
})

test('cast-time focus families are NOT haste, despite the word', () => {
  // 28 focus rows. These shorten CASTING time; locking them would gut the Focus tab for no rule.
  for (const name of [
    'Spell Haste I',
    'Spell Haste II',
    'Affliction Haste I',
    'Summoning Haste III',
    'Enhancement Haste II',
    'Reanimation Haste I'
  ]) {
    assert.equal(isHasteEffect(name), false, `${name} is a cast-time focus, not attack haste`)
  }
})

test('ordinary effects are not haste', () => {
  for (const name of ['Improved Healing III', 'Ice Comet', 'Lifetap', 'Augment Death', 'Flowing Thought I']) {
    assert.equal(isHasteEffect(name), false, `${name} should not be flagged`)
  }
  assert.equal(isHasteEffect('Improved Healing III', 'Must Equip, Casting Time: Instant'), false)
})
