// ============================================================================
// cursorRingColor.test.mts — JOS-125: the cursor ring gets a colour.
// ============================================================================
//
// THE REPORT was a compliment with a question attached: a player who finds the ring genuinely
// useful asked whether its colour or shape could change. The owner's answer scoped it to COLOUR,
// through a picker like the one every web app has. Three claims came with that, and this file
// owns the two that are decidable from source:
//
//   1. THE DEFAULT DOES NOT MOVE. Every ring ever drawn by this app has been white at 0.9 alpha,
//      and an upgrade must not recolour anybody's screen. That is asserted twice: against the
//      constant, and against the literal in `src/renderer/cursor.html`, which is the rule the
//      ring window paints with before its config arrives. A shared constant that drifts from
//      that CSS would show one colour for a frame and another afterwards.
//   2. ONLY A HEX COLOUR SURVIVES. The value ends up in `element.style.borderColor` in the ring
//      window, so the normalizer is the boundary between "a colour the user picked" and "a CSS
//      declaration a store file wrote". Named colours, `rgb()`, `var()` and anything with a
//      semicolon in it are refused — none of which `<input type="color">` can produce anyway,
//      which is what makes the strictness free.
//
// The third claim — that the ring in the GAME comes up in the chosen colour — is not decidable
// here: the ring window only exists while EverQuest is the foreground window, so no test in this
// repo can hold one. What IS pinned is that the ring window, the Preferences sample and
// cursor.html all read ONE function, so the seam has no room for a second opinion; and
// `tests/e2e/cursor-ring-color.e2e.mts` drives the picker through the real app and reads the
// colour back out of a restarted process.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_CURSOR_RING,
  DEFAULT_RING_COLOR,
  RING_STROKE_ALPHA,
  normalizeCursorRing,
  normalizeRingColor,
  ringStrokeColor
} from '../src/shared/presencePrefs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

test('white is the default, and the default is what the ring has always been', () => {
  assert.equal(DEFAULT_RING_COLOR, '#ffffff')
  assert.equal(DEFAULT_CURSOR_RING.colorHex, DEFAULT_RING_COLOR)
  assert.equal(ringStrokeColor(DEFAULT_RING_COLOR), 'rgba(255, 255, 255, 0.9)')
  assert.equal(RING_STROKE_ALPHA, 0.9, 'the alpha is fixed: a colour choice is not a contrast choice')
})

test("cursor.html's first-frame colour is the same colour the shared seam answers with", () => {
  // The static rule decides the ONE frame between the window opening and its config arriving.
  // Reading it here is what stops a constant from drifting away from a stylesheet nobody edits.
  const html = readFileSync(join(REPO, 'src/renderer/cursor.html'), 'utf8')
  const ring = html.slice(html.indexOf('#ring {'))
  const declared = /border-color:\s*([^;]+);/.exec(ring)?.[1]?.trim()
  assert.equal(
    declared,
    ringStrokeColor(DEFAULT_RING_COLOR),
    'cursor.html paints a different default than the code that replaces it'
  )
})

test('a hex colour is accepted in either length and answered in one shape', () => {
  assert.equal(normalizeRingColor('#ff8800'), '#ff8800')
  assert.equal(normalizeRingColor('#FF8800'), '#ff8800', 'case is not a difference')
  assert.equal(normalizeRingColor('  #ff8800  '), '#ff8800', 'a hand-edited file may have spaces')
  assert.equal(normalizeRingColor('#f80'), '#ff8800', 'the short form expands, so consumers see one shape')
  assert.equal(normalizeRingColor('#000'), '#000000')
})

test('ANYTHING THAT IS NOT A HEX COLOUR IS REFUSED, and the refusal is the boundary', () => {
  // Every one of these is a string a store file, a share import or a future build could carry,
  // and every one of them would otherwise reach a style property in the ring window.
  const refused = [
    'red',
    'white',
    'rgb(255, 0, 0)',
    'rgba(255,0,0,0.5)',
    'var(--accent)',
    'transparent',
    'currentColor',
    'url(https://example.invalid/x.png)',
    '#fff; background-image: url(https://example.invalid/x.png)',
    '#ff88',
    '#gggggg',
    'ff8800',
    '#ff88008800',
    ''
  ]
  for (const junk of refused) {
    assert.equal(normalizeRingColor(junk), DEFAULT_RING_COLOR, `${junk} must not survive`)
  }
  for (const junk of [undefined, null, 42, {}, [], { colorHex: '#ff8800' }]) {
    assert.equal(normalizeRingColor(junk), DEFAULT_RING_COLOR)
  }
  // …and the fallback is a parameter, so a caller that has a better answer than white can say so.
  assert.equal(normalizeRingColor('nonsense', '#123456'), '#123456')
})

test('ringStrokeColor can only ever emit an rgba() built from three numbers', () => {
  // The property this feeds is a style assignment, so the guarantee that matters is about the
  // SHAPE of the output rather than about any one input: whatever goes in, what comes out is
  // three channels and the fixed alpha.
  assert.equal(ringStrokeColor('#000000'), 'rgba(0, 0, 0, 0.9)')
  assert.equal(ringStrokeColor('#ff8800'), 'rgba(255, 136, 0, 0.9)')
  assert.equal(ringStrokeColor('#0a1e28'), 'rgba(10, 30, 40, 0.9)')
  assert.equal(ringStrokeColor('#f80'), 'rgba(255, 136, 0, 0.9)', 'the short form is expanded first')
  for (const junk of ['red', 'var(--x)', '#fff; content: "x"', '']) {
    assert.match(ringStrokeColor(junk), /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0\.9\)$/)
  }
})

test('the colour rides the existing ring blob, defaulted field by field like every other key', () => {
  // No new store key and no schema bump: `cursorRing` gained a field, so a stored blob written
  // before this feature reads as white and everything else it holds is untouched.
  assert.deepEqual(normalizeCursorRing({ enabled: true, sizePx: 60, thicknessPx: 5 }), {
    enabled: true,
    sizePx: 60,
    thicknessPx: 5,
    colorHex: DEFAULT_RING_COLOR
  })
  assert.deepEqual(normalizeCursorRing({ enabled: true, sizePx: 60, thicknessPx: 5, colorHex: '#00E5FF' }), {
    enabled: true,
    sizePx: 60,
    thicknessPx: 5,
    colorHex: '#00e5ff'
  })
  // A bad colour never costs the user the rest of their settings.
  assert.equal(normalizeCursorRing({ sizePx: 120, colorHex: 'chartreuse' }).sizePx, 120)
  assert.equal(normalizeCursorRing({ sizePx: 120, colorHex: 'chartreuse' }).colorHex, DEFAULT_RING_COLOR)
})
