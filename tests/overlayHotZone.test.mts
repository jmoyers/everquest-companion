// THE HOOKLESS HOVER SENSOR (JOS-370), in test form — the half that is a function of its
// arguments.
//
// WHAT THIS FEATURE IS. A locked overlay used to be `setIgnoreMouseEvents(true, {forward:true})`,
// and on Windows that `forward` installs a low-level mouse hook (WH_MOUSE_LL) owned by the MAIN
// process: a low-level hook is a SYNCHRONOUS stop on the machine's mouse path, so every mouse event
// on the desktop — the ones EverQuest reads to turn the camera included — waited on our message
// loop. Any hitch of ours was a freeze of the user's cursor, and past `LowLevelHooksTimeout`
// Windows silently unhooked us and the hover pin quietly stopped working. The hook bought exactly
// one thing: mouse MOVES, so a pinned window could tell when to take the mouse back for its pin.
//
// It is replaced by asking the question from the other side: main names the RECTANGLES a pinned
// overlay still wants the mouse in, the presence worker hit-tests the cursor against them on its
// own thread, and only the enter/leave EDGES cross the wire.
//
// THREE PROPERTIES ARE WORTH PINNING HERE, because each is a promise a reviewer would otherwise
// have to take on trust:
//
//   1. THE ZONES MIRROR THE SENSOR EACH KIND'S RENDERER ALREADY RUNS. A meter that published its
//      whole window would take back exactly the click-through P3 exists to protect ("a LOCKED
//      overlay keeps its top dropdown usable; click-through everywhere else").
//   2. NOTHING IS WATCHED IN A STATE WHERE CAPTURE WOULD BE WRONG. A parked overlay is on screen at
//      opacity 0, and handing an invisible rectangle the mouse is a click-eater over whatever the
//      user just alt-tabbed to.
//   3. THE CODEC REFUSES JUNK IN BOTH DIRECTIONS. The downstream half is new — main now talks to
//      the watcher as well as listening to it — and the rule the upstream half has always had
//      applies unchanged: a malformed line decodes to NOTHING rather than moving the state.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHROME_STRIP_PX,
  GRIP_BAND_PX,
  hotZoneStyle,
  overlayHotZones,
  overlayWantsHoverZones,
  type ZoneRect
} from '../src/main/overlayHotZone'
import {
  HOVER_EVERY_FAST_TICKS,
  HOVER_POLL_MS,
  HOVER_ZONES_CLEAR,
  WATCHER_TICK_FLOOR_MS,
  FOREGROUND_EVERY_TICKS,
  encodeHoverTransition,
  encodeHoverZones,
  parseHoverZones,
  parsePresenceLine,
  pointInHoverZone,
  watcherCadence
} from '../src/main/presenceProtocol'
import { OVERLAY_KINDS, type OverlayKind } from '../src/shared/types'

/** A meter-sized window somewhere on a second monitor, so nothing accidentally passes at the origin. */
const WINDOW: ZoneRect = { x: 1920, y: 300, width: 380, height: 320 }

const ALIVE = { locked: true, alive: true, visible: true, parked: false }

// ----------------------------------------------------------------------------- the three answers

test('every kind gets the zone style its own renderer sensor implies', () => {
  const expected: Record<OverlayKind, string> = {
    // The METERS and the two panels with a header sensor: `capture('selector', …)` on the header
    // row alone, so the bars stay genuinely click-through.
    fight: 'chrome',
    overall: 'chrome',
    'heal-fight': 'chrome',
    'heal-overall': 'chrome',
    xp: 'chrome',
    respawn: 'chrome',
    // The LIST kinds hold capture over their whole window while hovered (`onMouseEnter={onEnter}`
    // on the root) — overlayScale.tsx calls it the same trade taken at the other extreme.
    events: 'window',
    buffs: 'window',
    debuffs: 'window',
    // The three STRIPS have no hover sensor at all: their capture comes from their QUEUE, and they
    // never forwarded either. Growing one here would put a hit test on three windows that are
    // empty almost all of the time.
    toast: 'none',
    alertBanner: 'none',
    conCard: 'none'
  }
  for (const kind of OVERLAY_KINDS) assert.equal(hotZoneStyle(kind), expected[kind], kind)
})

test('a chrome kind publishes the header strip and the grip — never the bars', () => {
  const zones = overlayHotZones('fight', WINDOW)
  assert.equal(zones.length, 2)
  const [strip, grip] = zones
  // The strip is the top of the window, full width: the pin, the lock and the P3 selector row.
  assert.deepEqual(strip, { x: 1920, y: 300, width: 380, height: CHROME_STRIP_PX })
  // The grip is the right edge BELOW the strip — JOS-138's scroll affordance, and the narrowest
  // thing that buys it.
  assert.deepEqual(grip, {
    x: 1920 + 380 - GRIP_BAND_PX,
    y: 300 + CHROME_STRIP_PX,
    width: GRIP_BAND_PX,
    height: 320 - CHROME_STRIP_PX
  })

  // THE CENTRE OF THE METER IS NOT IN ANY ZONE, and that is the whole ruling: a pinned meter's body
  // is click-through, so a click there goes to the game.
  const middle = { x: 1920 + 190, y: 300 + 200 }
  assert.equal(
    zones.some((z) => pointInHoverZone(middle.x, middle.y, z)),
    false,
    'the bars would have taken the mouse'
  )
  // …while the pin's own corner is.
  assert.ok(zones.some((z) => pointInHoverZone(1920 + 360, 300 + 12, z)), 'the pin is unreachable')
})

test('a window kind publishes its window, and a strip publishes nothing', () => {
  assert.deepEqual(overlayHotZones('events', WINDOW), [WINDOW])
  for (const kind of ['toast', 'alertBanner', 'conCard'] as OverlayKind[]) {
    assert.deepEqual(overlayHotZones(kind, WINDOW), [], kind)
  }
})

test('the zones never claim a pixel the window does not own', () => {
  // The floor every kind shares is 140x90 (OVERLAY_MIN_SIZE), which is shorter than the strip plus
  // a grip worth having — and a user can drag one there. The rectangles clamp rather than overhang.
  const tiny: ZoneRect = { x: 0, y: 0, width: 140, height: 30 }
  for (const z of overlayHotZones('fight', tiny)) {
    assert.ok(z.x >= tiny.x && z.y >= tiny.y, 'a zone started outside the window')
    assert.ok(z.x + z.width <= tiny.x + tiny.width, 'a zone ran past the right edge')
    assert.ok(z.y + z.height <= tiny.y + tiny.height, 'a zone ran past the bottom edge')
  }
})

test('the strip follows the page ZOOM, because a CSS pixel is only a DIP at zoom 1', () => {
  // Chromium stores zoom PER HOST and the dev server serves every page from one host, so the app's
  // text-size control has been MEASURED reaching an accessory window (JOS-154, the cursor ring). A
  // strip measured in CSS px and published as DIP would be silently short there, and a short strip
  // is a pin the user cannot reach — the failure this whole ticket is about, reintroduced.
  const [strip] = overlayHotZones('fight', WINDOW, 1.25)
  assert.equal(strip.height, Math.round(CHROME_STRIP_PX * 1.25))
  // Position and WIDTH are the window's and are never scaled.
  assert.equal(strip.x, WINDOW.x)
  assert.equal(strip.width, WINDOW.width)
  // A nonsense zoom cannot collapse the zone: it falls back to 1 rather than to nothing.
  assert.equal(overlayHotZones('fight', WINDOW, 0)[0].height, CHROME_STRIP_PX)
})

// ----------------------------------------------------------------------------- when it runs

test('nothing is watched in a state where taking the mouse would be wrong', () => {
  assert.equal(overlayWantsHoverZones(ALIVE), true)
  // An INTERACTIVE overlay owns the mouse outright — every real event reaches it already.
  assert.equal(overlayWantsHoverZones({ ...ALIVE, locked: false }), false)
  // Gone, or hidden by the replay gate / a session teardown: no pixels to hover.
  assert.equal(overlayWantsHoverZones({ ...ALIVE, alive: false }), false)
  assert.equal(overlayWantsHoverZones({ ...ALIVE, visible: false }), false)
  // PARKED is the one that would be a BUG rather than a waste: on screen at opacity 0, so capture
  // here is an invisible rectangle eating clicks over whatever the user switched to (JOS-427).
  assert.equal(overlayWantsHoverZones({ ...ALIVE, parked: true }), false)
})

test('EQ HOLDING THE FOREGROUND IS NOT A TERM — a pinned overlay over a browser reveals its pin', () => {
  // OWNER RULING, 2026-08-24, overturning JOS-370's condition (b): presence PREFERENCES are what
  // mean "hide when EQ is not open or not in the foreground"; EQ should not impact hover state
  // otherwise. The shipped gate had a fifth `eqFocused` term, so a meter pinned over a browser
  // published no rectangle and could not reveal its own pin — where the WH_MOUSE_LL hook this
  // feature replaced had forwarded moves from every app on the machine.
  //
  // Stated as an ABSENCE, which is the only way a removed term can be pinned: the predicate's
  // argument object is now exactly four booleans, and every one of them is about the WINDOW.
  assert.deepEqual(Object.keys(ALIVE).sort(), ['alive', 'locked', 'parked', 'visible'])
  assert.equal(overlayWantsHoverZones(ALIVE), true, 'a visible pinned overlay is always watched')
  // …and the honest coupling that replaced it: a user who DID ask for auto-hide is off the moment
  // they leave the game, because `presenceEffects.ts onPresence` PARKS the overlays and the park is
  // the term above. Nothing here re-derives a preference.
  assert.equal(overlayWantsHoverZones({ ...ALIVE, parked: true }), false)
  assert.equal(overlayWantsHoverZones({ ...ALIVE, visible: false }), false)
})

// ----------------------------------------------------------------------------- the cadence

test('the hit test is a MIDDLE cadence, and it never speeds the ring up', () => {
  // Ring on: the loop is already at the platform's floor for `GetCursorInfo`, and that one call
  // answers both questions. The hit test rides every second tick — it cannot ask for more.
  const ringOn = watcherCadence(true, true)
  assert.deepEqual(ringOn, {
    tickMs: watcherCadence(true).tickMs,
    foregroundEveryTicks: watcherCadence(true).foregroundEveryTicks,
    hoverEveryTicks: HOVER_EVERY_FAST_TICKS
  })
  // THE TWO CLOCKS ARE ONE CLOCK: two of the ring's floor ticks and one hover period are the same
  // two Windows timer quanta. They are not the same NUMBER, and that is the measurement rather than
  // sloppiness — a `setInterval` ends at the next edge AFTER the time requested, so 30 lands on the
  // second edge (31.3 ms measured) while 32 lands on the third (45.9 ms). The invariant is that the
  // request never exceeds what two floor ticks measure at.
  assert.ok(
    HOVER_POLL_MS <= WATCHER_TICK_FLOOR_MS * HOVER_EVERY_FAST_TICKS,
    'a hover period past two floor ticks would silently cost a third of the sample rate'
  )
  assert.ok(
    HOVER_POLL_MS > WATCHER_TICK_FLOOR_MS,
    'and one below one floor tick would be asking for the ring cadence under another name'
  )

  // Ring off with a pinned overlay: the coarse ~160 ms tick cannot put chrome under a pointer, so
  // the loop asks for the hover period — and the EXPENSIVE half keeps the cadence it always had.
  const hoverOnly = watcherCadence(false, true)
  assert.equal(hoverOnly.tickMs, HOVER_POLL_MS)
  assert.equal(hoverOnly.hoverEveryTicks, 1)
  // THE FOREGROUND/ALT-TAB CADENCE MUST NOT MOVE — auto-hide is judged on how fast an overlay
  // reacts to an alt-tab, and it is the same ~156 ms either way. Counted in QUANTA rather than in
  // nominal milliseconds, because that is what the machine actually delivers: the ring's path is
  // ten floor ticks, the hover path is five two-quanta ticks, and both are ten edges.
  assert.equal(
    hoverOnly.foregroundEveryTicks * HOVER_EVERY_FAST_TICKS,
    FOREGROUND_EVERY_TICKS,
    'the foreground/alt-tab cadence moved'
  )
  assert.ok(
    Math.abs(hoverOnly.tickMs * hoverOnly.foregroundEveryTicks - WATCHER_TICK_FLOOR_MS * FOREGROUND_EVERY_TICKS) <=
      WATCHER_TICK_FLOOR_MS,
    'and the nominal request is within a quantum of the one it replaced'
  )

  // Neither: exactly the loop JOS-193 left behind, and `hoverEveryTicks: 0` is what the worker
  // reads as "there is no hit-test block in this loop at all".
  assert.equal(watcherCadence(false, false).hoverEveryTicks, 0)
  assert.equal(watcherCadence(false).hoverEveryTicks, 0, 'and the default is OFF')

  // THE BUDGET THE TICKET SET: one sample plus one IPC hop is what a pin reveal costs. Stated as
  // arithmetic so nobody has to re-derive it from two constants in two files.
  assert.ok(HOVER_POLL_MS <= 50, 'a hover sample has to land inside the 50 ms budget on its own')
})

// ----------------------------------------------------------------------------- the codec

test('a zone set round-trips, and an empty one is that key CLEARING', () => {
  const zones = overlayHotZones('fight', WINDOW)
  const line = encodeHoverZones('fight', zones)
  assert.deepEqual(parseHoverZones(line), { key: 'fight', zones })
  // The retraction is the same line with no rectangles — one shape for "watch these" and "watch
  // nothing", so a key can never be half-updated.
  assert.deepEqual(parseHoverZones(encodeHoverZones('heal-overall', [])), {
    key: 'heal-overall',
    zones: []
  })
  // …and the bare `Z` is every key at once: the feature going off.
  assert.deepEqual(parseHoverZones(HOVER_ZONES_CLEAR), { key: null, zones: [] })
})

test('a malformed downstream line decodes to NOTHING — it must never move the state', () => {
  for (const junk of [
    '',
    'Z|', // no key
    'Z|fight|1|2|3', // three fields is not a rectangle
    'Z|fight|1|2|3|4|5', // …and neither is five
    'Z|fight|1|2|0|4', // a zero-area rectangle can never contain a point
    'Z|fight|1|2|3|-4',
    'Z|fight|a|b|c|d',
    'Z|fight|1.5|2|3|4', // the wire is whole pixels
    'Z|Fight!|1|2|3|4', // a key is a bounded token
    'stop',
    'H'
  ]) {
    assert.equal(parseHoverZones(junk), null, junk)
  }
})

test('an upstream transition decodes, and its key is checked by SHAPE', () => {
  assert.deepEqual(parsePresenceLine(encodeHoverTransition('fight', true)), {
    t: 'hover',
    key: 'fight',
    inside: true
  })
  assert.deepEqual(parsePresenceLine(encodeHoverTransition('heal-overall', false)), {
    t: 'hover',
    key: 'heal-overall',
    inside: false
  })
  for (const junk of ['V', 'V|fight', 'V|fight|2|3', 'V|fight|yes', 'V||1', 'V|1fight|1']) {
    assert.equal(parsePresenceLine(junk), null, junk)
  }
  // A well-formed line whose key names no window of ours still decodes here — this file is a codec
  // and a bounded token is all it can honestly promise. `overlayHover.ts` is where a key has to
  // name an OVERLAY_KIND before it can reach a window.
  assert.deepEqual(parsePresenceLine('V|nosuchkind|1'), {
    t: 'hover',
    key: 'nosuchkind',
    inside: true
  })
})

test('the hit test itself is half-open on the far edges, like every other window test here', () => {
  const z = { x: 10, y: 20, width: 5, height: 5 }
  assert.equal(pointInHoverZone(10, 20, z), true, 'the top-left pixel is inside')
  assert.equal(pointInHoverZone(14, 24, z), true, 'and so is the last one')
  // A cursor at `x + width` is on the first pixel of whatever is next to it — pointerWatch.ts's
  // rule, restated in the module the WORKER loads.
  assert.equal(pointInHoverZone(15, 24, z), false)
  assert.equal(pointInHoverZone(14, 25, z), false)
  assert.equal(pointInHoverZone(9, 20, z), false)
})
