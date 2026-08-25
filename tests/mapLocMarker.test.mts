// THE TYPED-/loc MARKER (JOS-98) — the parser, the transform, and where the marker is remembered.
//
// TWO THINGS HERE ARE SILENTLY WRONG RATHER THAN LOUDLY BROKEN, and both get a golden:
//
//   * THE ORDER. /loc prints NORTH/SOUTH FIRST, then west/east, then elevation. Read it as x-first
//     and every marker lands mirrored about the diagonal — which, on a map you have never walked,
//     looks exactly like a marker.
//   * THE SIGNS. EQ's world grows WEST and NORTH; the map file grows EAST and SOUTH. Get one of the
//     two negations wrong and the marker is in the wrong half of the zone, still plausibly on a
//     path, still drawn in the right colour. This repo has already shipped that class of bug once
//     (JOS-65, "North for South"), so the transform is not asserted against its own arithmetic —
//     it is asserted against A LANDMARK, below.
//
// THE LANDMARK, AND WHY IT IS EVIDENCE RATHER THAN A RESTATEMENT. Two INDEPENDENT authorities in
// this repo describe the same NPCs in Oasis of Marr, in different coordinate spaces, neither
// derived from the other:
//
//   * the WIKI BESTIARY (`mobs.json`, scraped from eqlwiki page `|location` fields) states Transan
//     at /loc (613, 51) and Isslana at /loc (512, 71) — /loc order, as a player would read them;
//   * BREWALL'S HAND-DRAWN MAP of the same zone labels `Transan_(Weapons)` at map (-51, -613) and
//     `Isslana_(Merchant)` at map (-71, -512) — map-file order, verbatim bytes off a live install.
//
// Run the wiki's readings through the parser and `mapFromLoc` and they land on the map file's own
// labels TO THE UNIT, both signs pinned at once (positive ns → negative y, positive ew → negative
// x). A wrong order or a flipped sign misses by more than a thousand map units. Nothing in this
// chain is the transform quoting itself: a wiki scraper and a fan cartographer agreeing is the
// closest thing to ground truth this feature can have.
//
// Then the SCREEN, through the real parser and the real projection, because a correct map
// coordinate rendered upside down is still a marker in the wrong place (the JOS-65 lesson exactly).
//
// Arithmetic, strings and a fake store — no React, no DOM, no fixture — so this suite NEVER skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOC_MARKERS_KEY,
  MAX_TYPED,
  TYPED_COLORS,
  addTypedMarker,
  clearPlayerMarker,
  clearTypedMarker,
  formatLoc,
  loadLocMarkers,
  parseLoc,
  playerMarkerFor,
  saveLocMarkers,
  setPlayerMarker,
  typedMarkersFor,
  type LocStore
} from '../src/renderer/src/features/maps/locMarker'
import { fit, mapFromLoc, project } from '../src/renderer/src/features/maps/mapGeometry'
import { MOB_CATALOG } from '../src/renderer/src/features/mobs/mobSearch'
// The MAIN-side parser, imported on purpose and for the same reason the JOS-65 golden does it: the
// landmark is REAL BYTES, and "where the marker lands" starts at the bytes on disk.
import { buildMapData, parseMapText } from '../src/main/maps/parseMap'
import type { EqLoc } from '../src/renderer/src/features/maps/mapGeometry'

/** A `LocStore` over a plain object, so the persistence rules are drivable without a browser. */
function fakeStore(seed: Record<string, string> = {}): LocStore & { data: Record<string, string> } {
  const data = { ...seed }
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v
    }
  }
}

/** The reading a successful parse produced, or a failure with the reason attached. */
function loc(text: string): EqLoc {
  const parsed = parseLoc(text)
  assert.ok(parsed.ok, `expected "${text}" to parse${parsed.ok ? '' : ` — got: ${parsed.reason}`}`)
  return parsed.loc
}

/** The prose a refusal produced. Fails loudly if the input was accepted. */
function refusal(text: string): string {
  const parsed = parseLoc(text)
  assert.ok(!parsed.ok, `expected "${text}" to be REFUSED, got ${JSON.stringify(parsed)}`)
  return parsed.reason
}

// ---- 1. the shapes a real paste actually takes -------------------------------------------

test('parseLoc reads the game sentence verbatim — /loc prints NORTH/SOUTH first, then west/east', () => {
  // Verbatim from scripts/sources/cache/quests/page-15280.wikitext (a player's own pasted /loc).
  assert.deepEqual(loc('Your Location is -192.19, -129.81, 3.26'), { ns: -192.19, ew: -129.81, z: 3.26 })
  // THE ORDER, stated as a fact rather than as a shape: the FIRST number is the north/south one.
  const yther = loc('Your Location is 155, -411, 15')
  assert.equal(yther.ns, 155)
  assert.equal(yther.ew, -411)
  assert.equal(yther.z, 15)
})

test('parseLoc accepts the slack a paste really carries', () => {
  const want = { ns: 275.07, ew: -3801.88, z: -366.59 }
  // Bare numbers — "OR raw comma-separated coordinates".
  assert.deepEqual(loc('275.07, -3801.88, -366.59'), want)
  // Whitespace instead of commas, and any amount of it either side.
  assert.deepEqual(loc('   275.07   -3801.88   -366.59  '), want)
  // The sentence's own trailing period (page-15178 states one mid-paragraph).
  assert.deepEqual(loc('Your Location is 275.07, -3801.88, -366.59.'), want)
  // The log's stamp, in case a future line is ever pasted out of the log file itself.
  assert.deepEqual(loc('[Wed Aug 06 18:45:55 2026] Your Location is 275.07, -3801.88, -366.59'), want)
  // The command as typed, and a lowercase spelling of the sentence.
  assert.deepEqual(loc('/loc 275.07, -3801.88, -366.59'), want)
  assert.deepEqual(loc('your location is 275.07, -3801.88, -366.59'), want)
  // A leading `+`, which nothing prints but somebody will type.
  assert.deepEqual(loc('+275.07, -3801.88, -366.59'), want)
})

test('parseLoc takes a two-number pair at ground elevation — a wiki page rarely states the third', () => {
  assert.deepEqual(loc('613, 51'), { ns: 613, ew: 51, z: 0 })
})

// ---- 2. and what it REFUSES, in prose, placing nothing ------------------------------------

test('parseLoc refuses rather than guessing, and names what it choked on', () => {
  // A word among the numbers. The offending token is quoted back, because "invalid input" sends
  // the user back to the same paste with nothing to change.
  assert.match(refusal('Your Location is 275.07, north, -366.59'), /“north”/)
  // The wiki sentence with its surrounding prose still attached — the numbers ARE in there, and
  // fishing them out of arbitrary text is precisely the guess this parser will not make.
  assert.match(refusal('Your Location is 275.07, -3801.88, -366.59. This is just North of the ruins'), /isn’t a number/)
  // Wrong counts, both directions. A single number is not a position and four is not a /loc.
  assert.match(refusal('275.07'), /a \/loc is three/)
  assert.match(refusal('1, 2, 3, 4'), /a \/loc is three/)
  // An empty box says what to do rather than what went wrong.
  assert.match(refusal('   '), /Nothing to place/)
  // Every refusal repeats the example, so the guidance can never drift between them.
  for (const bad of ['x', '1', '1,2,3,4', '', 'Your Location is'])
    assert.match(refusal(bad), /Your Location is 1414\.20, -735\.55, 12\.19/)
})

test('parseLoc refuses the shapes that LOOK numeric but are not', () => {
  for (const bad of ['1e5, 2, 3', 'NaN, 2, 3', 'Infinity, 2, 3', '1.2.3, 2, 3', '--5, 2, 3', '5-, 2, 3'])
    assert.ok(!parseLoc(bad).ok, bad)
})

// ---- 3. THE LANDMARK: the transform, against two authorities that never met ----------------

/**
 * Brewall's Oasis of Marr label points, VERBATIM from a live
 * `<eqRoot>\maps\brewall\oasis_1.txt` — the same provenance discipline as the JOS-65 golden.
 */
const OASIS_BREWALL_NPCS = `P 261.0000, 1321.0000, 4.8499, 0, 128, 0, 2, Marnan_(Merchant)
P 6.0000, -597.0000, 3.0323, 0, 128, 0, 2, Sythan_(Merchant)
P -51.0000, -613.0000, 3.0323, 0, 128, 0, 2, Transan_(Weapons)
P -71.0000, -512.0000, 3.0322, 0, 128, 0, 2, Isslana_(Merchant)`

/** The map file's own label points, by label, straight through the shipping parser. */
function labelled(text: string, zone: string): Map<string, { x: number; y: number }> {
  const data = buildMapData([parseMapText(text, 1)], { zone, sources: [] })
  return new Map(data.points.map((p) => [p.label, { x: p.x, y: p.y }]))
}

/** What the COMMITTED catalog states for this page, read live so the golden cannot be transcribed. */
function wikiLoc(page: string): EqLoc {
  const entry = MOB_CATALOG.find((m) => m.page === page)
  assert.ok(entry, `${page} is in the committed mob catalog`)
  const first = entry.loc?.[0]
  assert.ok(first, `${page}'s wiki page states a location`)
  return { ns: first.ns, ew: first.ew, z: first.z ?? 0 }
}

test('JOS-98 THE LANDMARK: a typed /loc lands on the map file’s own label for the same NPC', () => {
  const onMap = labelled(OASIS_BREWALL_NPCS, 'oasis')
  for (const [page, label] of [
    ['Transan', 'Transan_(Weapons)'],
    ['Isslana', 'Isslana_(Merchant)']
  ] as const) {
    const stated = wikiLoc(page)
    // The user types what the wiki (or the game) states — the sentence, not the numbers.
    const typed = loc(`Your Location is ${String(stated.ns)}, ${String(stated.ew)}, 0`)
    assert.deepEqual(typed, { ...stated, z: 0 }, `${page}: the sentence parses to the stated reading`)

    const placed = mapFromLoc(typed)
    const drawn = onMap.get(label)
    assert.ok(drawn, `${label} parsed out of the map bytes`)
    // TO THE UNIT. Two authorities, two coordinate spaces, one point.
    assert.equal(placed.x, drawn.x, `${page}: mapX`)
    assert.equal(placed.y, drawn.y, `${page}: mapY`)

    // BOTH SIGNS, PINNED SEPARATELY — a single equality would also pass if x and y were swapped
    // AND both signs were wrong. A northerly, westerly /loc is up and to the LEFT of the origin.
    assert.ok(stated.ns > 0 && placed.y < 0, `${page}: a NORTH reading is negative map y`)
    assert.ok(stated.ew > 0 && placed.x < 0, `${page}: a WEST reading is negative map x`)
  }
})

test('JOS-98 …and a wrong order or a flipped sign would miss by hundreds of units, not by rounding', () => {
  const stated = wikiLoc('Transan')
  const right = mapFromLoc(stated)
  // The three transforms this test exists to rule out, each measured against the truth.
  const swapped = mapFromLoc({ ns: stated.ew, ew: stated.ns, z: 0 })
  const unflipped = { x: stated.ew, y: stated.ns }
  const halfFlipped = { x: -stated.ew, y: stated.ns }
  for (const [name, wrong] of [
    ['x/y swapped', swapped],
    ['neither axis negated', unflipped],
    ['only x negated', halfFlipped]
  ] as const) {
    const off = Math.hypot(wrong.x - right.x, wrong.y - right.y)
    assert.ok(off > 500, `${name} would be ${String(Math.round(off))} map units away — not a rounding difference`)
  }
})

// ---- 4. …and the same reading, all the way to the screen -----------------------------------

/** Oasis of Marr's two zone exits, verbatim from a live `<eqRoot>\maps\oasis_1.txt`. */
const OASIS_EXITS = `P 58.7071, -2413.2568, 34.3489,  150, 0, 200,  3,  to_The_Northern_Desert_of_Ro
P -169.0031, 1859.4617, 1.6049,  150, 0, 200,  3,  to_The_Southern_Desert_of_Ro`

/** A realistic pane. These assertions are about ORDER, so any non-degenerate size will do. */
const PANE = { w: 900, h: 600 }

test('JOS-98 a /loc typed at the NORTH exit draws above one typed at the SOUTH exit', () => {
  const data = buildMapData([parseMapText(OASIS_EXITS, 1)], { zone: 'oasis', sources: [] })
  const view = fit(data.bounds, PANE)
  const at = new Map(data.points.map((p) => [p.label, p]))
  const north = at.get('to_The_Northern_Desert_of_Ro')
  const south = at.get('to_The_Southern_Desert_of_Ro')
  assert.ok(north && south, 'both exits parsed')

  // Stand at each exit and read /loc off the game: the inverse of what the file stores. Typed
  // back in, each marker must land on the exit it was read from — and on the correct SIDE of the
  // pane. This is the whole chain: sentence → parser → mapFromLoc → project → a pixel.
  const marker = (p: { x: number; y: number; z: number }): { px: number; py: number } => {
    const typed = loc(`Your Location is ${String(-p.y)}, ${String(-p.x)}, ${String(p.z)}`)
    const placed = mapFromLoc(typed)
    assert.equal(placed.x, p.x)
    assert.equal(placed.y, p.y)
    return project(view, PANE, placed)
  }
  const n = marker(north)
  const s = marker(south)
  // SMALLER py is HIGHER on screen — the whole of JOS-65, now asserted for a typed reading too.
  assert.ok(n.py < s.py, `north (py=${String(n.py)}) must draw above south (py=${String(s.py)})`)
  assert.ok(s.py - n.py > PANE.h / 2, 'and they are genuinely apart, not both at the pane centre')
})

// ---- 5. what the chip states ---------------------------------------------------------------

test('formatLoc states the reading back in the game’s own words and order', () => {
  assert.equal(formatLoc({ ns: -192.19, ew: -129.81, z: 3.26 }), '-192.19, -129.81, 3.26')
  // Two decimals, like /loc itself, and no trailing zeros on a whole number.
  assert.equal(formatLoc({ ns: 613, ew: 51, z: 0 }), '613, 51, 0')
  assert.equal(formatLoc({ ns: 1.006, ew: -2.9999, z: 0.1 }), '1.01, -3, 0.1')
  // Rounding is binary-honest and is not papered over: 1.005 is stored a hair BELOW the midpoint,
  // so it rounds down, exactly as `toFixed(2)` would. This is a display of a number the user typed
  // to two places anyway — the STORED value is untouched, which is what the round trip below pins.
  assert.equal(formatLoc({ ns: 1.005, ew: 0, z: 0 }), '1, 0, 0')
})

test('what the chip states round-trips back through the parser', () => {
  const there = { ns: -192.19, ew: -129.81, z: 3.26 }
  assert.deepEqual(loc(formatLoc(there)), there)
})

// ---- 6. sticking around, and the colour cycle (JOS-98 wave 4) --------------------------------

/** The colours of a zone's typed markers, in add order — the whole subject of the cycle tests. */
function colorsOf(marks: ReturnType<typeof addTypedMarker>, zone: string): string[] {
  return typedMarkersFor(marks, zone).map((m) => m.color)
}

test('a marker is remembered PER ZONE, and one zone’s markers are not another’s', () => {
  const store = fakeStore()
  let marks = addTypedMarker({}, 'oasis', { ns: 613, ew: 51, z: 0 })
  marks = addTypedMarker(marks, 'northkarana', { ns: -1, ew: -2, z: -3 })
  saveLocMarkers(marks, store)

  const back = loadLocMarkers(store)
  assert.deepEqual(back, marks, 'the whole set crosses the store intact')
  assert.deepEqual(typedMarkersFor(back, 'oasis'), [{ loc: { ns: 613, ew: 51, z: 0 }, color: 'blue' }])
  assert.deepEqual(typedMarkersFor(back, 'northkarana'), [{ loc: { ns: -1, ew: -2, z: -3 }, color: 'blue' }])
  // A zone with no marker, and the no-map-open case, are both the honest empty.
  assert.deepEqual(typedMarkersFor(back, 'freporte'), [])
  assert.deepEqual(typedMarkersFor(back, null), [])
})

test('typed markers and the player marker are INDEPENDENT — one never disturbs the other', () => {
  let marks = addTypedMarker({}, 'oasis', { ns: 1, ew: 2, z: 3 })
  marks = setPlayerMarker(marks, 'oasis', { ns: 4, ew: 5, z: 6 })
  assert.deepEqual(playerMarkerFor(marks, 'oasis'), { ns: 4, ew: 5, z: 6 })
  assert.deepEqual(colorsOf(marks, 'oasis'), ['blue'], 'the player set did not touch the typed list')
  // Adding more typed markers leaves the scraped one where it was.
  marks = addTypedMarker(marks, 'oasis', { ns: 7, ew: 8, z: 9 })
  assert.deepEqual(playerMarkerFor(marks, 'oasis'), { ns: 4, ew: 5, z: 6 })
  // …and re-scraping leaves the typed list untouched.
  marks = setPlayerMarker(marks, 'oasis', { ns: 10, ew: 11, z: 12 })
  assert.deepEqual(colorsOf(marks, 'oasis'), ['blue', 'green'])
})

test('adding markers claims colours in cycle order — blue, green, yellow, violet', () => {
  let marks: ReturnType<typeof addTypedMarker> = {}
  for (let i = 0; i < MAX_TYPED; i++) marks = addTypedMarker(marks, 'oasis', { ns: i, ew: 0, z: 0 })
  assert.deepEqual(colorsOf(marks, 'oasis'), [...TYPED_COLORS])
  assert.equal(typedMarkersFor(marks, 'oasis').length, MAX_TYPED, 'four markers, one per colour')
})

test('clearing a colour frees it, and the next add takes the FIRST unused colour', () => {
  let marks: ReturnType<typeof addTypedMarker> = {}
  for (let i = 0; i < MAX_TYPED; i++) marks = addTypedMarker(marks, 'oasis', { ns: i, ew: 0, z: 0 })
  // Free green (the 2nd). The next add fills the hole rather than appending a 5th of a new colour.
  marks = clearTypedMarker(marks, 'oasis', 'green')
  assert.deepEqual(colorsOf(marks, 'oasis'), ['blue', 'yellow', 'violet'])
  marks = addTypedMarker(marks, 'oasis', { ns: 99, ew: 0, z: 0 })
  assert.deepEqual(colorsOf(marks, 'oasis'), ['blue', 'yellow', 'violet', 'green'], 'green reused')
})

test('AT CAPACITY the oldest marker is evicted and its colour cycles to the new one', () => {
  let marks: ReturnType<typeof addTypedMarker> = {}
  for (let i = 0; i < MAX_TYPED; i++) marks = addTypedMarker(marks, 'oasis', { ns: i, ew: 0, z: 0 })
  // The oldest is blue at ns 0. A fifth add drops it, reuses blue, and stays at four total.
  marks = addTypedMarker(marks, 'oasis', { ns: 500, ew: 0, z: 0 })
  const after = typedMarkersFor(marks, 'oasis')
  assert.equal(after.length, MAX_TYPED, 'never more than four typed markers')
  assert.deepEqual(after.map((m) => m.color), ['green', 'yellow', 'violet', 'blue'], 'blue cycled to the newest')
  assert.deepEqual(after[after.length - 1], { loc: { ns: 500, ew: 0, z: 0 }, color: 'blue' })
  assert.ok(!after.some((m) => m.loc.ns === 0), 'the evicted oldest is gone')
})

test('clearing one typed colour leaves the others and the player, and clearing all drops the zone', () => {
  let marks = addTypedMarker({}, 'oasis', { ns: 1, ew: 2, z: 3 }) // blue
  marks = addTypedMarker(marks, 'oasis', { ns: 4, ew: 5, z: 6 }) // green
  marks = setPlayerMarker(marks, 'oasis', { ns: 7, ew: 8, z: 9 })
  const noBlue = clearTypedMarker(marks, 'oasis', 'blue')
  assert.deepEqual(colorsOf(noBlue, 'oasis'), ['green'], 'only blue went')
  assert.deepEqual(playerMarkerFor(noBlue, 'oasis'), { ns: 7, ew: 8, z: 9 }, 'the player marker is untouched')
  // Clearing a colour the zone does not have is a no-op that does not churn the object.
  assert.equal(clearTypedMarker(noBlue, 'oasis', 'violet'), noBlue)
  // Clear the last typed AND the player ⇒ the zone key is dropped entirely (no empty shell).
  const noTyped = clearTypedMarker(noBlue, 'oasis', 'green')
  assert.deepEqual(noTyped, { oasis: { player: { ns: 7, ew: 8, z: 9 } } }, 'the player alone keeps the zone')
  const empty = clearPlayerMarker(noTyped, 'oasis')
  assert.deepEqual(empty, {})
  assert.ok(!('oasis' in empty), 'the zone key is dropped when nothing remains')
})

test('clearing survives the store and leaves every other zone alone', () => {
  let marks = addTypedMarker({}, 'oasis', { ns: 1, ew: 2, z: 3 })
  marks = addTypedMarker(marks, 'gfaydark', { ns: 4, ew: 5, z: 6 })
  const cleared = clearTypedMarker(marks, 'oasis', 'blue')
  assert.deepEqual(typedMarkersFor(cleared, 'oasis'), [])
  assert.deepEqual(colorsOf(cleared, 'gfaydark'), ['blue'])
  const store = fakeStore()
  saveLocMarkers(cleared, store)
  assert.deepEqual(typedMarkersFor(loadLocMarkers(store), 'oasis'), [])
})

test('a LEGACY bare {ns,ew,z} loads as one blue TYPED marker — a pre-wave-3 marker survives upgrade', () => {
  // Before the split, the box wrote a bare EqLoc under the zone key; it was always the typed mark.
  const store = fakeStore({ [LOC_MARKERS_KEY]: JSON.stringify({ oasis: { ns: 613, ew: 51, z: 0 } }) })
  assert.deepEqual(loadLocMarkers(store), { oasis: { typed: [{ loc: { ns: 613, ew: 51, z: 0 }, color: 'blue' }] } })
})

test('a wave-3 SINGLE typed reading loads as one blue typed marker', () => {
  const store = fakeStore({ [LOC_MARKERS_KEY]: JSON.stringify({ sro: { typed: { ns: 1, ew: 2, z: 3 }, player: { ns: 4, ew: 5, z: 6 } } }) })
  assert.deepEqual(loadLocMarkers(store), {
    sro: { typed: [{ loc: { ns: 1, ew: 2, z: 3 }, color: 'blue' }], player: { ns: 4, ew: 5, z: 6 } }
  })
})

test('a corrupt entry is dropped ALONE — one bad zone cannot take the others with it', () => {
  const store = fakeStore({
    [LOC_MARKERS_KEY]: JSON.stringify({
      oasis: { typed: [{ loc: { ns: 613, ew: 51, z: 0 }, color: 'yellow' }], player: { ns: 1, ew: 2, z: 3 } },
      legacy: { ns: 7, ew: 8, z: 9 }, // the bare pre-wave-3 shape, still read as one blue typed
      halfBad: { typed: [{ loc: { ns: 'north', ew: 51, z: 0 } }, { loc: { ns: 4, ew: 5, z: 6 }, color: 'violet' }] },
      duped: { typed: [{ loc: { ns: 1, ew: 1, z: 1 }, color: 'blue' }, { loc: { ns: 2, ew: 2, z: 2 }, color: 'blue' }] },
      nulled: null,
      wrong: 'nope',
      '': { typed: [{ loc: { ns: 1, ew: 2, z: 3 }, color: 'blue' }] }
    })
  })
  assert.deepEqual(loadLocMarkers(store), {
    // A stored colour is honoured.
    oasis: { typed: [{ loc: { ns: 613, ew: 51, z: 0 }, color: 'yellow' }], player: { ns: 1, ew: 2, z: 3 } },
    legacy: { typed: [{ loc: { ns: 7, ew: 8, z: 9 }, color: 'blue' }] },
    // The unreadable element drops; the good one keeps its stated colour.
    halfBad: { typed: [{ loc: { ns: 4, ew: 5, z: 6 }, color: 'violet' }] },
    // A duplicate colour is reassigned to the first unused one rather than dropped.
    duped: { typed: [{ loc: { ns: 1, ew: 1, z: 1 }, color: 'blue' }, { loc: { ns: 2, ew: 2, z: 2 }, color: 'green' }] }
  })
})

test('an absent, empty or unparseable store reads as no markers, never as a throw', () => {
  assert.deepEqual(loadLocMarkers(fakeStore()), {})
  assert.deepEqual(loadLocMarkers(fakeStore({ [LOC_MARKERS_KEY]: '' })), {})
  assert.deepEqual(loadLocMarkers(fakeStore({ [LOC_MARKERS_KEY]: '{oh no' })), {})
  assert.deepEqual(loadLocMarkers(fakeStore({ [LOC_MARKERS_KEY]: '[1,2,3]' })), {})
  assert.deepEqual(loadLocMarkers(fakeStore({ [LOC_MARKERS_KEY]: 'null' })), {})
})

test('the key is the one the app has shipped — a rename would silently drop every saved marker', () => {
  assert.equal(LOC_MARKERS_KEY, 'eq.maps.loc')
  const store = fakeStore()
  saveLocMarkers(addTypedMarker({}, 'oasis', { ns: 1, ew: 2, z: 3 }), store)
  assert.equal(store.data['eq.maps.loc'], '{"oasis":{"typed":[{"loc":{"ns":1,"ew":2,"z":3},"color":"blue"}]}}')
})
