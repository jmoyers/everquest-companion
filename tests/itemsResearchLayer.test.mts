// THE CURATED ITEM-KNOWLEDGE LAYER, re-derived from the committed corpus (JOS-25, JOS-64).
//
// `src/main/data/itemsResearch.json` is hand-curated and merges OVER the wiki record, which makes
// it the one file in the item pipeline that can state a wrong answer LOUDLY: a stale entry does
// not look stale, it looks like scraped fact. Two of its three tables restate something the item
// pages themselves say (GM-event prose, bard instrument families), so this file re-derives BOTH
// from `items.json` and fails on any disagreement in either direction. A rescrape that moves a
// family or retires a page turns the suite red instead of leaving the curated answer winning.
//
// The third table (`summoned`) is owner-observation, has no corpus witness, and is deliberately
// not re-derived here — only its provenance is checked.
//
// WHAT "CLEARLY MARKED" MEANS, and why it is a test rather than a comment (the awaiting-sample
// law): an entry is admitted only when the page states a GM hand-out in UNHEDGED words AND names
// no drop source, quest or recipe anywhere. Pages that mention a GM and are absent on purpose are
// named one by one in `AMBIGUOUS` below with the reason each fails the bar, so re-admitting one is
// a deliberate edit to this file rather than a silent widening of a regex.
//
// JOS-64 (owner ruling, 2026-08-06 — *GM-only and GM-event both mean unfarmable*) admitted three
// of JOS-25's five refusals, which is why there are now TWO derivations here instead of one. The
// three were never hedged: they said GM *item* where the sweep's phrasings say GM *event*, and a
// player can no more farm a GM-only item than a GM-event one. They are filed under `gmOnly` and
// re-derived from their OWN anchored prose — the `gmEvent` derivation below is untouched, and each
// table must still equal its own half of the corpus exactly. Two refusals remain, for reasons that
// are about the FACTS and not about phrasing: `Dabner's Staff of Recall` names a live drop mob (so
// it is farmable, ruling or no ruling, and stays a DONOR), and `Shield of Hatred` asks a question
// ("Possibly a GM Event item?") — the layer files no guesses.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import itemsJson from '../src/main/data/items.json'
import { itemKey, knowledgeFromDb, type ItemDbEntry, type ItemDbFile } from '../src/main/itemsDb'
import {
  INSTRUMENT_FAMILIES,
  ITEMS_RESEARCH,
  isUnfarmable,
  type InstrumentFamily
} from '../src/main/itemsResearch'
import { buildPlannerIndex } from '../src/main/planner/effectIndex'
import type { EquipSlot } from '../src/shared/planner/types'

const file = itemsJson as unknown as ItemDbFile
const entries = Object.values(file.items ?? {})

/** One record → the key the layer is looked up by (`|itemname` when the page states one). */
const keyOf = (e: ItemDbEntry): string => itemKey(knowledgeFromDb(e).name)

/** Every page, by that key — the layer's whole address space. */
const pages = new Map<string, ItemDbEntry>(entries.map((e) => [keyOf(e), e]))

// ---- the GM-event half ---------------------------------------------------------------

/**
 * The UNHEDGED phrasings, quoted from the corpus. Anchored per shape rather than a loose
 * `/gm/` sweep, because the four rejects below all contain "GM" and three contain "GM item".
 */
const GM_PROSE = [
  /(^|\s)GM Event Item\.($|\s)/i,
  /Obtained during a GM event\./i,
  /Given out in a GM event\./i,
  /(^|\s)GM Event item for /i
]

/**
 * The UNHEDGED GM-ONLY phrasings, quoted from the corpus (JOS-64). A separate list from `GM_PROSE`
 * on purpose: these three pages name no event, and the flag they mint says so. Anchored per shape
 * for the same reason — `Shield of Hatred` contains "GM Event item" and must match neither list.
 */
const GM_ONLY_PROSE = [
  /This item is a GM item\./i,
  /GM item occasionally handed out\./i,
  /(^|\s)GM Only item\./i
]

/**
 * The pages that mention a GM and are NOT flagged, with the reason each fails the bar. Named
 * individually so a future sweep cannot quietly absorb one. JOS-64's ruling emptied this list of
 * every entry that was refused over PHRASING; what is left is refused over facts.
 */
const AMBIGUOUS: Record<string, string> = {
  "dabner's staff of recall": 'carries |gmitem AND a real |dropsfrom mob — a hand-out beside a live drop is not unfarmable, so it stays a donor',
  'shield of hatred': 'hedged: "Possibly a GM Event item?" — the layer files no guesses'
}

/**
 * The three JOS-64 admitted, and the flag each must now carry. Pinned by name for the same reason
 * `AMBIGUOUS` is: this is a RULING, and a ruling that quietly evaporates from the data is worse
 * than one never made.
 */
const RULED_UNFARMABLE = ['da oogly stick', 'gnome sandwich', 'stone of gnoming']

/** Does this page state a farm route of any kind? A GM hand-out beside one is not unfarmable. */
function farmable(e: ItemDbEntry): boolean {
  const k = knowledgeFromDb(e)
  return (
    (k.dropsFrom?.length ?? 0) > 0 ||
    k.quest ||
    k.questUses.length > 0 ||
    (k.recipes?.length ?? 0) > 0 ||
    (k.playerCrafted ?? false)
  )
}

/** The pages one prose list clearly marks AND that name no farm route — one table's whole source. */
function derivedFromProse(prose: RegExp[]): Set<string> {
  const out = new Set<string>()
  for (const e of entries) {
    const summary = e.summary ?? ''
    if (!prose.some((re) => re.test(summary))) continue
    if (farmable(e)) continue
    out.add(keyOf(e))
  }
  return out
}

/** The set the layer's `gmEvent` must equal. */
const derivedGmEvent = (): Set<string> => derivedFromProse(GM_PROSE)

/** The set the layer's `gmOnly` must equal (JOS-64). */
const derivedGmOnly = (): Set<string> => derivedFromProse(GM_ONLY_PROSE)

/** Every key the layer calls unfarmable, by either provenance. */
const filedWith = (pick: (r: (typeof ITEMS_RESEARCH)[string]) => boolean): Set<string> =>
  new Set(
    Object.entries(ITEMS_RESEARCH)
      .filter(([, r]) => pick(r))
      .map(([k]) => k)
  )

// ---- the slot-repair half (JOS-67) ----------------------------------------------------
//
// The one table that repairs a PARSE gap instead of adding knowledge. `applySlot` fills
// `stats.slot` only from a `Slot:` KEY, and a handful of pages write the slot line with no key, so
// it lands in `flags` and the item reaches the planner slotless — which R2 reads as "can never
// donate". The derivation below re-reads each filed page's own slot line, and then SWEEPS the whole
// corpus for a page of the same shape that nobody has filed. Both halves matter: the first catches
// a rescrape that changes what a page says (or that finally keys the line), the second catches a
// rescrape that adds a fourth one and would otherwise hide a donor in silence.

/** The slot vocabulary as the pages spell it, unkeyed — one token per canonical slot. */
const SLOT_WORD: Record<string, EquipSlot> = {
  primary: 'PRIMARY',
  secondary: 'SECONDARY',
  range: 'RANGE',
  ammo: 'AMMO',
  head: 'HEAD',
  face: 'FACE',
  ear: 'EAR',
  ears: 'EAR',
  neck: 'NECK',
  shoulders: 'SHOULDERS',
  back: 'BACK',
  chest: 'CHEST',
  arms: 'ARMS',
  wrist: 'WRIST',
  wrists: 'WRIST',
  hands: 'HANDS',
  finger: 'FINGER',
  fingers: 'FINGER',
  waist: 'WAIST',
  legs: 'LEGS',
  feet: 'FEET'
}

/**
 * The slots a page states on an unkeyed line, or null when it states none that way. A flag counts
 * ONLY when every one of its words is a slot word — the same corpus files a bare `MNK BRD ROG SHM`
 * class line under `flags`, and a looser read would mint slots out of it.
 */
function unkeyedSlots(e: ItemDbEntry): EquipSlot[] | null {
  const stats = e.stats
  if (!stats || stats.slot !== undefined) return null
  const out: EquipSlot[] = []
  for (const flag of stats.flags) {
    const words = flag.trim().split(/\s+/)
    const mapped = words.map((w) => SLOT_WORD[w.toLowerCase()])
    if (words.length === 0 || mapped.some((m) => m === undefined)) continue
    for (const slot of mapped) if (slot !== undefined && !out.includes(slot)) out.push(slot)
  }
  return out.length === 0 ? null : out
}

// ---- the instrument half -------------------------------------------------------------

/**
 * The wiki's four spellings of one family, and the two PLACES it writes them: the stats block
 * (`Wind Resonance: 12`, `Stringed Instrument`) and `|focus_effect` (`Brass Resonance 14`, which
 * the scrape folds in as a focus effect). Both are the item's own page stating its own family.
 */
const FAMILY_OF: [RegExp, InstrumentFamily][] = [
  [/^wind\b/i, 'wind'],
  [/^(string|stringed)\b/i, 'string'],
  [/^brass\b/i, 'brass'],
  [/^percussion\b/i, 'percussion'],
  [/^all instrument types$/i, 'all']
]
const INSTRUMENT_LINE = /resonance|instruments?\b|instrument types/i

/** Every line on a page that claims an instrument family, from either place. */
function instrumentLines(e: ItemDbEntry): string[] {
  const stats = e.stats
  if (!stats) return []
  const flags = [...stats.flags, ...stats.extras].filter((l) => INSTRUMENT_LINE.test(l))
  const focus = stats.effects.filter((x) => x.kind === 'focus' && INSTRUMENT_LINE.test(x.name))
  return [...flags, ...focus.map((x) => x.name)]
}

/** The family table the corpus states — the set the layer's `instrument` must equal. */
function derivedInstruments(): Map<string, InstrumentFamily> {
  const out = new Map<string, InstrumentFamily>()
  for (const e of entries) {
    const lines = instrumentLines(e)
    if (lines.length === 0) continue
    const fams = new Set(lines.map((l) => FAMILY_OF.find(([re]) => re.test(l.trim()))?.[1]))
    assert.equal(fams.size, 1, `${keyOf(e)} states more than one instrument family: ${lines.join(' | ')}`)
    const fam = [...fams][0]
    assert.ok(fam !== undefined, `${keyOf(e)}: unreadable instrument line ${lines.join(' | ')}`)
    out.set(keyOf(e), fam)
  }
  return out
}

// ---- the tests -----------------------------------------------------------------------

test('every curated entry names a real item and states its provenance', () => {
  const all = Object.entries(ITEMS_RESEARCH)
  assert.ok(all.length > 0, 'the curated layer is empty')
  for (const [key, entry] of all) {
    assert.ok(pages.has(key), `${key}: the layer keys an item the corpus has no page for`)
    assert.ok(entry.source.trim().length > 0, `${key}: a curated entry with no source reads as scraped fact`)
    assert.match(entry.checkedAt, /^\d{4}-\d{2}-\d{2}$/, `${key}: no checkedAt date`)
  }
})

test('the GM-event table is exactly what the committed prose clearly marks', () => {
  const flagged = filedWith((r) => r.gmEvent === true)
  const derived = derivedGmEvent()
  console.log('gm-event layer', { flagged: flagged.size, derived: derived.size })
  assert.deepEqual([...flagged].sort(), [...derived].sort())
  // Floor lowered 10 → 9 on 2026-08-22: `essence of gukta` retired with its page (rebuilt as the
  // player-crafted "Essence of Gukta (Wormwood)" — the GM-event prose is gone from the corpus).
  assert.ok(flagged.size >= 9, `only ${flagged.size} GM-event entries`)

  // Unfarmable is the whole claim — re-asserted on the flagged set itself, not just on the
  // derivation, because a hand-added entry never passes through `derivedGmEvent`.
  for (const key of flagged) {
    const page = pages.get(key)
    assert.ok(page, key)
    assert.equal(farmable(page), false, `${key}: flagged GM-event but the page names a farm route`)
  }

  // The exclusion has to BITE: if none of the ten carried an effect, flagging them would be a
  // statement with no consequence anywhere in the planner.
  const withEffects = [...flagged].filter((k) => (pages.get(k)?.stats?.effects.length ?? 0) > 0)
  assert.ok(withEffects.length >= 4, `only ${withEffects.length} flagged items carry an effect`)
})

test('the GM-only table is exactly the three the ruling admitted, and each is unfarmable', () => {
  const flagged = filedWith((r) => r.gmOnly === true)
  const derived = derivedGmOnly()
  console.log('gm-only layer', { flagged: flagged.size, derived: derived.size })

  // Both directions, like the GM-event half: the corpus's own prose is the whole address list, so
  // a rescrape that rewrites one of these three pages turns this red instead of leaving a curated
  // answer winning a merge it can no longer support.
  assert.deepEqual([...flagged].sort(), [...derived].sort())
  assert.deepEqual([...flagged].sort(), [...RULED_UNFARMABLE].sort(), 'the JOS-64 ruling is no longer what the data says')

  for (const key of flagged) {
    const page = pages.get(key)
    assert.ok(page, key)
    assert.equal(farmable(page), false, `${key}: flagged GM-only but the page names a farm route`)
    // The ruling is about DONATION, so a filed entry that no consumer would act on is a dead one.
    assert.equal(isUnfarmable(ITEMS_RESEARCH[key]), true, `${key}: filed but not read as unfarmable`)
    assert.equal(ITEMS_RESEARCH[key]?.gmEvent, undefined, `${key}: claims a GM EVENT its page never states`)
  }

  // The exclusion has to BITE for at least some of them — Da Oogly Stick and Stone of Gnoming both
  // carry a click illusion, so admitting the three takes real donor rows off the planner's list.
  const withEffects = [...flagged].filter((k) => (pages.get(k)?.stats?.effects.length ?? 0) > 0)
  assert.ok(withEffects.length >= 2, `only ${withEffects.length} GM-only items carry an effect`)
})

test('one verdict reads BOTH provenances, and the two tables never overlap', () => {
  // `effectIndex.excludedDonor` asks `isUnfarmable` and nothing else about GM provenance, so this
  // is the assertion that a flag added to the vocabulary reaches the planner at all.
  const unfarmable = filedWith((r) => isUnfarmable(r))
  const gmEvent = filedWith((r) => r.gmEvent === true)
  const gmOnly = filedWith((r) => r.gmOnly === true)
  assert.deepEqual([...unfarmable].sort(), [...new Set([...gmEvent, ...gmOnly])].sort())
  assert.equal(gmEvent.size + gmOnly.size, unfarmable.size, 'a page states one GM provenance, not two')
  for (const [key, entry] of Object.entries(ITEMS_RESEARCH)) {
    if (!isUnfarmable(entry)) continue
    assert.ok(entry.note !== undefined && entry.note.length > 0, `${key}: an unfarmable claim with no note`)
  }
})

test('the two remaining GM pages stay OUT, and each is named with its reason', () => {
  for (const [key, why] of Object.entries(AMBIGUOUS)) {
    assert.ok(pages.has(key), `${key}: the reject list names a page the corpus does not have`)
    assert.ok(why.length > 0)
    assert.equal(isUnfarmable(ITEMS_RESEARCH[key]), false, `${key} was admitted without review: ${why}`)
  }
  // Shield of Hatred is pinned by its PROSE, not just by its absence: it is the one page whose
  // wording sits between the two lists, so neither derivation may ever pick it up.
  const hatred = pages.get('shield of hatred')
  assert.ok(hatred)
  const hatredProse = hatred.summary ?? ''
  assert.ok(/GM Event item\?/i.test(hatredProse), 'the hedge this refusal rests on is gone from the corpus')
  assert.ok(!GM_PROSE.some((re) => re.test(hatredProse)), 'a hedged page matched the GM-event prose list')
  assert.ok(!GM_ONLY_PROSE.some((re) => re.test(hatredProse)), 'a hedged page matched the GM-only prose list')
  assert.equal(ITEMS_RESEARCH['shield of hatred'], undefined, 'Shield of Hatred is filed at all — the layer files no guesses')

  // Dabner's is the one that would have cost a real donor, so it is pinned by its own facts
  // rather than by its absence alone.
  const dabner = pages.get("dabner's staff of recall")
  assert.ok(dabner)
  assert.equal(farmable(dabner), true, "Dabner's Staff of Recall lost the drop source that keeps it farmable")
})

test('the instrument table is exactly what the committed corpus states, both ways', () => {
  const derived = derivedInstruments()
  const filed = new Map<string, InstrumentFamily>()
  for (const [key, entry] of Object.entries(ITEMS_RESEARCH)) {
    if (entry.instrument !== undefined) filed.set(key, entry.instrument)
  }
  const tally: Record<string, number> = {}
  for (const fam of derived.values()) tally[fam] = (tally[fam] ?? 0) + 1
  console.log('instrument layer', { filed: filed.size, derived: derived.size, ...tally })

  assert.deepEqual([...filed.keys()].sort(), [...derived.keys()].sort(), 'the filed table and the corpus disagree about WHICH items are instruments')
  for (const [key, fam] of derived) assert.equal(filed.get(key), fam, `${key}: filed family disagrees with the page`)
  assert.ok(filed.size >= 47, `only ${filed.size} instrument entries`)

  // Every value is one of the five families, and every family the game has is represented —
  // a mapping bug that folded everything into one bucket would still pass a size floor.
  for (const [key, fam] of filed) {
    assert.ok((INSTRUMENT_FAMILIES as readonly string[]).includes(fam), `${key}: ${fam} is not a family`)
  }
  assert.deepEqual([...new Set(filed.values())].sort(), [...INSTRUMENT_FAMILIES].sort())
})

test('the slot table is exactly the pages whose slot line the scrape could not key', () => {
  const filed = new Map<string, EquipSlot[]>()
  for (const [key, entry] of Object.entries(ITEMS_RESEARCH)) {
    if (entry.slots !== undefined) filed.set(key, entry.slots)
  }
  const derived = new Map<string, EquipSlot[]>()
  for (const e of entries) {
    const slots = unkeyedSlots(e)
    if (slots !== null) derived.set(keyOf(e), slots)
  }
  console.log('slot layer', { filed: filed.size, derived: derived.size })

  // BOTH directions. A filed entry the corpus no longer supports is a stale answer winning a
  // merge; a derived page nobody filed is a donor about to go missing the way the wand did.
  assert.deepEqual([...filed.keys()].sort(), [...derived.keys()].sort())
  for (const [key, slots] of derived) {
    assert.deepEqual(filed.get(key), slots, `${key}: the filed slots disagree with the page`)
  }
  assert.ok(filed.size >= 3, `only ${filed.size} slot entries`)

  // The report's own item, pinned by name: this is the fact JOS-67 shipped, and an entry that
  // quietly evaporates from the data is worse than one never filed (the RULED_UNFARMABLE idiom).
  assert.deepEqual(filed.get('golem metal wand'), ['PRIMARY', 'SECONDARY'])
})

test('the curated slots reach the planner index — the wand can be socketed again', () => {
  // The end-to-end claim the report is about: the layer is worthless if the builder ignores it.
  const index = buildPlannerIndex(file)
  const wand = index.donors.filter((d) => d.key === 'golem metal wand')
  assert.equal(wand.length, 1, 'the Golem Metal Wand carries exactly one effect')
  assert.equal(wand[0].socket, 'click')
  assert.deepEqual(wand[0].slots, ['PRIMARY', 'SECONDARY'])

  // …and the host it was reported against really is one of those slots, so the transfer the user
  // was refused is legal: SECONDARY shared, and the wand's ALL class list overlaps a six-class
  // shield. The item index is what the Board's host picker reads.
  const shield = index.items.find((i) => i.key === 'shield of rainbow hues')
  assert.ok(shield, 'Shield of Rainbow Hues is missing from the item index')
  assert.deepEqual(shield.slots, ['SECONDARY'])
  assert.ok(shield.classes.some((c) => wand[0].classes.includes(c)), 'no class overlap')

  // The wristwraps are the same repair on a donor with a REQUIRED LEVEL and one class — filed at
  // the same time so the table is not a one-item special case.
  const wraps = index.donors.filter((d) => d.key === 'azarack skin wristwraps')
  assert.equal(wraps.length, 1)
  assert.deepEqual(wraps[0].slots, ['WRIST'])
})

test('an instrument entry never excludes a donor', () => {
  // The instrument table is a GROUPING fact. `excludedDonor` reads `summoned` plus the unfarmable
  // verdict, so filing 47 families must not have quietly taken 47 items off the planner's donor
  // list — and a bard's horn is exactly the kind of page a widened GM sweep could swallow.
  for (const [key, entry] of Object.entries(ITEMS_RESEARCH)) {
    if (entry.instrument === undefined) continue
    assert.equal(isUnfarmable(entry), false, `${key}: an instrument entry also claims a GM provenance`)
    assert.equal(entry.summoned, undefined, `${key}: an instrument entry also claims summoned`)
  }
})
