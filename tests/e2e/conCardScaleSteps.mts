/**
 * THE MOB CARD AT 100 / 150 / 200 % (JOS-406) — steps for tests/e2e/con-card.e2e.mts.
 *
 * The owner's report, in one sentence: at 200% the card kept the width it had at 100% while its
 * type doubled, so it laid out in HALF the room and the resist chips squeezed into ~80px columns
 * where `with overchannel 100%` wrapped one word per line. The answer is two halves and this file
 * is where the two are asserted TOGETHER, because either alone would still be wrong:
 *
 *   1. THE WINDOW IS THE CARD, so it scales with the text (main/overlayLayout.ts
 *      `scaledStripBounds`). Twice the text, twice the window — grown about its own middle.
 *   2. THE CHIP GRID WRAPS RATHER THAN SQUEEZING (overlay/ConCard.tsx): `auto-fill` over a
 *      MEASURED minimum column width, so the same number of columns survives the scale and a
 *      narrowed window loses columns to ROWS rather than shrinking chips into unreadable slivers.
 *
 * WHY THE PAYLOAD IS SYNTHETIC HERE, AND ONLY HERE. Every other step in this spec plays a real
 * `/con` down the whole path (chokidar → Tailer → ConsiderModule → main/conCard.ts → the window)
 * and asserts what came out — that is claim 2 of the spec and it is not weakened by anything below.
 * These steps are about LAYOUT AT A GIVEN CHIP COUNT, and the chip count of a real creature is a
 * fact about the committed resist baseline rather than about this feature: no mob in the fixture
 * resists all five axes, and the ticket asks for five chips AND one chip at three sizes. So the
 * card is fed the way main feeds it — `webContents.send` on the same channel, the same shape the
 * wire carries — and what is asserted is the grid it produced.
 *
 * THE COLUMN COUNT IS READ OFF THE RESOLVED GRID, never off the source: `getComputedStyle(...)
 * .gridTemplateColumns` is the list of tracks the engine actually created, so a build whose
 * `auto-fill` silently became `auto-fit` (one chip absorbing the row — the banner this ticket
 * forbids) fails here rather than passing a testid.
 */
import type { ElectronApplication, Page } from 'playwright-core'
import { check, note, settle } from './appHarness.mjs'
import {
  overlayBounds,
  setOverlayTextScale,
  shootOverlay,
  storedBounds,
  type Bounds
} from './stripScaleSteps.mjs'

const GRID = '[data-testid="con-card-chip-grid"]'
const KIND = 'conCard'

/**
 * `CHIP_MIN_PX` from src/renderer/src/overlay/ConCard.tsx, spelled out rather than imported: an e2e
 * file loads no `src` module. It is the MEASURED minimum a chip column may be — the widest phrase a
 * chip prints (`may not land even with overchannel`, 145.23px in the overlay's own type) plus 14px
 * of padding and border. A change to it that forgets this line fails loudly below.
 */
const CHIP_MIN_PX = 160
/** A window is whole pixels and a layout box is not; a pixel either way is nobody's intent. */
const SLACK = 2
/** Track widths are floats out of the layout engine; sub-pixel is not a squeeze. */
const PX_EPS = 0.5

/** The five axes, in the order the wire carries them (`RESIST_AXES`). */
const AXES = ['magic', 'fire', 'cold', 'poison', 'disease']

/** One benchmark, shaped exactly as the wire carries it: two probabilities, a band and a sentence. */
function bench(pPlain: number, pOver: number): unknown {
  const at = { level: 51, mobLevel: 51, atMobLevel: false, pPlain, pOver }
  return { ...at, tag: 'very resistant', guidance: 'may not land even with overchannel', atLo: at, atHi: at }
}

/**
 * A card carrying `count` NOTABLE chips (the rest are empty, which `notableChips` drops).
 *
 * The guidance sentence on every chip is the LONGEST one the vocabulary has
 * (`may not land even with overchannel`, shared/resistTypes.ts `ResistGuidance`) on purpose: it is
 * the phrase `CHIP_MIN_PX` was measured from, so this is the card at its widest demand rather than
 * a comfortable one.
 */
function payload(id: string, count: number): unknown {
  return {
    id,
    ts: Date.now(),
    // A NAME THAT IS NOT ONE OF THE SPEC'S CREATURES, deliberately: these cards are fed straight to
    // the window rather than conned, so a name the rest of the file waits on would let a later step
    // mistake this layout probe for the card it is waiting for.
    name: 'A shissar disease priest',
    level: 51,
    zone: 'Lower Guk',
    spellData: true,
    chips: AXES.map((axis, i) =>
      i < count
        ? {
            axis,
            tag: 'very resistant',
            benchmark: bench(0.34, 1),
            pinned: false,
            empirical: { total: 43, resisted: 39 },
            npcOnly: false,
            n: 43,
            nTotal: 43,
            fit: { R: 106, lo: 92, hi: 126 }
          }
        : {
            axis,
            tag: null,
            benchmark: null,
            pinned: false,
            empirical: { total: 0, resisted: 0 },
            npcOnly: false,
            n: 0,
            nTotal: 0,
            fit: null
          }
    )
  }
}

/** Feed the con card window one card, the way main feeds it: the same channel, the same shape. */
function showCard(app: ElectronApplication, card: unknown): Promise<void> {
  return app.evaluate(({ BrowserWindow }, c) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents.getURL().includes('kind=conCard')) w.webContents.send('con:card', c)
    }
  }, card)
}

/** The tracks the engine actually created, in CSS px — one entry per column. */
function gridTracks(page: Page): Promise<number[]> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return []
    return getComputedStyle(el)
      .gridTemplateColumns.split(' ')
      .map((t) => Number.parseFloat(t))
      .filter((n) => Number.isFinite(n))
  }, GRID)
}

/** …once the card that produces them has arrived and settled. */
function settleTracks(page: Page, want: number): Promise<number[]> {
  return settle(() => gridTracks(page), (t) => t.length === want, { timeoutMs: 15_000 })
}

/**
 * FIVE CHIPS AT THE DEFAULT WIDTH ARE THREE COLUMNS AND THEN TWO — wrapped into rows, never
 * squeezed; and ONE chip is ONE COLUMN of that same row, never a banner.
 *
 * The second half is the whole reason this is `auto-fill` and not `auto-fit`, and it is the
 * argument the retired `repeat(max(3, n), 1fr)` was written for: with the card drawing only the
 * axes a creature actually resists, a lone survivor used to stretch across the whole card and read
 * as a banner. Empty tracks stay, so it cannot.
 */
export async function stepChipGridWraps(app: ElectronApplication, card: Page): Promise<number> {
  await showCard(app, payload('scale-five', 5))
  const five = await settleTracks(card, 3)
  check(
    'five chips at the default width lay out in THREE columns, wrapped into rows',
    five.length === 3,
    `${String(five.length)} column(s): ${five.map((n) => n.toFixed(1)).join(' ')}`
  )
  check(
    '…and no column was squeezed below the width a chip was measured to need',
    five.every((w) => w >= CHIP_MIN_PX - PX_EPS),
    `tracks ${five.map((n) => n.toFixed(1)).join(' ')} against a ${String(CHIP_MIN_PX)}px minimum`
  )
  note(`chip tracks at 100%: ${five.map((n) => n.toFixed(1)).join(' / ')}`)

  await showCard(app, payload('scale-one', 1))
  const one = await settleTracks(card, 3)
  check(
    'ONE chip is one column of the same row — auto-FILL keeps the empty tracks, so it is never a banner',
    one.length === 3 && Math.abs(one[0] - five[0]) <= SLACK,
    `${String(one.length)} column(s), first track ${String(one[0])} vs ${String(five[0])}`
  )
  return five.length
}

/**
 * THE WINDOW SCALES WITH THE TEXT, AND THE CARD INSIDE IT DOES NOT CHANGE SHAPE.
 *
 * Three sizes, both payloads, and a picture of each — the owner asked to judge this by eye and
 * there is no assertion in a file that can carry "that doesn't look good".
 *
 * WHAT IS ASSERTED AT EACH STOP: the window is the 100% window times the scale (± a pixel), the
 * chip grid has the SAME NUMBER OF COLUMNS it had at 100% (which is the whole claim — the same
 * card, bigger), and nothing runs off the edge of the window.
 */
export async function stepWindowScalesWithText(
  app: ElectronApplication,
  card: Page,
  columns: number
): Promise<void> {
  const start = await overlayBounds(app, KIND)
  if (!check('the con card window has bounds to scale from', start !== null)) return
  const base = start as Bounds

  for (const scale of [1, 1.5, 2]) {
    await setOverlayTextScale(card, scale)
    const want = Math.round(base.width * scale)
    const b = await settle(
      () => overlayBounds(app, KIND),
      (r) => r !== null && Math.abs(r.width - want) <= SLACK,
      { timeoutMs: 15_000 }
    )
    const pct = String(Math.round(scale * 100))
    if (
      !check(
        `at ${pct}% the con card WINDOW is ${String(want)}px — the layout box times the text scale`,
        b !== null && Math.abs((b as Bounds).width - want) <= SLACK,
        `${String((b as Bounds | null)?.width)} (was ${String(base.width)} at 100%)`
      )
    ) {
      continue
    }
    const big = b as Bounds
    check(
      `…grown about its own middle, with the top edge where the user left it`,
      Math.abs(big.x + big.width / 2 - (base.x + base.width / 2)) <= SLACK && big.y === base.y,
      `${JSON.stringify(base)} -> ${JSON.stringify(big)}`
    )
    for (const [count, tag] of [
      [5, 'five'],
      [1, 'one']
    ] as const) {
      await showCard(app, payload(`scale-${tag}-${pct}`, count))
      const tracks = await settleTracks(card, columns)
      check(
        `…and at ${pct}% the ${tag}-chip card still lays out in ${String(columns)} columns — the same card, bigger`,
        tracks.length === columns,
        `${String(tracks.length)} column(s) at ${pct}%`
      )
      const clip = await card.evaluate(() => ({
        scroll: (document.querySelector('[data-testid="con-card"]') ?? document.body).scrollWidth,
        client: document.documentElement.clientWidth
      }))
      check(
        `…with nothing clipped off the edge at ${pct}%`,
        clip.scroll <= clip.client + 1,
        `card ${String(clip.scroll)}px in a ${String(clip.client)}px window`
      )
      await shootOverlay(app, card, KIND, `con-card-${pct}-${tag}.png`)
    }
  }
  await setOverlayTextScale(card, 1)
  await settle(() => overlayBounds(app, KIND), (r) => r !== null && Math.abs(r.width - base.width) <= SLACK, {
    timeoutMs: 15_000
  })
}

/**
 * A DRAG AT 150% IS REMEMBERED AS THE BOX IT IS AT 100%.
 *
 * The user widens the card while the text is at 150%; what goes in the store is `chrome / 1.5`, so
 * pressing A− afterwards gives back the size that was dragged rather than a box half again too big.
 * Both halves are asserted: what was WRITTEN DOWN, and what the window becomes when the scale
 * changes under it.
 *
 * THE DRAG IS `setBounds` PLUS AN EXPLICIT 'resized', and that is not a shortcut. `EQ_E2E=1` never
 * shows a window, so there is no pointer in this process to drag an edge with; both a real drag and
 * this land on the SAME listener (overlayBounds.ts `installOverlayBounds`), which reads the
 * window's own bounds rather than anything the event carries. Emitting it explicitly makes the step
 * independent of whether a given Electron build reports a programmatic resize as one.
 */
export async function stepResizeRecordsLayoutBox(app: ElectronApplication, card: Page): Promise<void> {
  const SCALE = 1.5
  await setOverlayTextScale(card, SCALE)
  const at150 = await settle(() => overlayBounds(app, KIND), (b) => b !== null, { timeoutMs: 15_000 })
  if (!check('the con card window is up at 150% to be dragged', at150 !== null)) return
  const dragged = Math.round((at150 as Bounds).width) + 120

  await app.evaluate(
    ({ BrowserWindow }, width) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.webContents.getURL().includes('kind=conCard')) continue
        const b = w.getBounds()
        w.setBounds({ ...b, width })
        w.emit('resized')
      }
    },
    dragged
  )

  const want = Math.round(dragged / SCALE)
  const stored = await settle(
    () => storedBounds(card),
    (b) => b !== undefined && Math.abs(b.width - want) <= SLACK,
    { timeoutMs: 15_000 }
  )
  check(
    'a strip dragged wider at 150% is REMEMBERED as the box it would be at 100%',
    stored !== undefined && Math.abs((stored as Bounds).width - want) <= SLACK,
    `stored ${String(stored?.width)} for a ${String(dragged)}px window at ${String(SCALE)}x (want ${String(want)})`
  )

  // …and the other direction: back at 100%, the window IS that remembered box.
  await setOverlayTextScale(card, 1)
  const back = await settle(
    () => overlayBounds(app, KIND),
    (b) => b !== null && Math.abs(b.width - want) <= SLACK,
    { timeoutMs: 15_000 }
  )
  check(
    '…and turning the text back to 100% gives exactly that box as the window',
    back !== null && Math.abs((back as Bounds).width - want) <= SLACK,
    `${String((back as Bounds | null)?.width)} vs ${String(want)}`
  )

  // Put the width back where this spec found it, so the steps after this one measure an ordinary
  // card rather than one somebody in a test dragged.
  await app.evaluate(
    ({ BrowserWindow }, width) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.webContents.getURL().includes('kind=conCard')) continue
        w.setBounds({ ...w.getBounds(), width })
        w.emit('resized')
      }
    },
    Math.round((at150 as Bounds).width / SCALE)
  )
}
