// WHERE THE AGGREGATE WENT, AND WHAT THE TITLE BAR DID WITH THE ROOM — the overlay half of
// JOS-158 (owner direction 2026-08-09, from a screenshot).
//
// The meters' `21.7k dps` / `1.2k hps` used to sit hard right of the fight name in the title bar,
// unlabelled, next to a mob name that was ellipsizing to make space for it. It is now stated on
// the PANEL's own header row (the crumb above the bars), labelled `all` for what it covers and
// wearing the meter's accent so it can never be read as the personal figure on the You bar below.
//
// THREE CLAIMS, AND THE THIRD IS A MEASUREMENT:
//   1. the title bar no longer states a rate at all,
//   2. the panel does, labelled, and the label is a word rather than a hover,
//   3. a LONG FIXTURE MOB NAME now renders MORE CHARACTERS in that title than it did before.
//
// (3) is the whole point of the ticket, so it is measured rather than asserted from the diff. The
// technique is `overlayScopeSteps.stepTitleBarRoom`'s, and it is the only honest one available:
// this suite cannot run the previous build, so the OLD row is rebuilt in place — inside a single
// synchronous `evaluate` React never observes — and Chromium's own layout engine answers, at this
// window's real width, with a real name from the staged fixture in the title. What is counted is
// "characters of that name that fit the title span before it has to ellipsize", found by
// measuring prefixes against the span's own width with a hidden ruler in the span's own font. It
// is a prefix count, not a screenshot of glyphs, and the same method answers both passes — so the
// DIFFERENCE is the claim, and the absolute numbers are reported as notes.
//
// Its own module because tests/e2e/overlay-sync.e2e.mts sits at the repo's max-lines budget:
// split, never ratchet (drill.mts, combatPrefsSteps.mts and overlayScopeSteps.mts set the
// precedent).
//
// NO LOCAL FUNCTION BINDINGS IN ANYTHING EVALUATED IN THE PAGE. tsx compiles this file with
// esbuild's keep-names on, which wraps every named function binding in a `__name(…)` helper;
// Playwright ships the callback's SOURCE to the page, where that helper does not exist. Flat
// loops only (overlayScopeSteps.mts learned this the hard way).

import type { Page } from 'playwright-core'
import { check, countOf, note } from './appHarness.mjs'

/** The selector trigger, by the ARIA contract OverlayHeader renders. Its parent IS the row. */
const TRIGGER = '[aria-haspopup="listbox"]'
/** The scrolling bars pane — the panel content the aggregate had to land INSIDE. */
const BARS = '[data-testid="overlay-bars"]'
/** The labelled aggregate on the crumb row, and the number half of it on its own. */
const TOTAL = '[data-testid="overlay-total"]'
const TOTAL_VALUE = '[data-testid="overlay-total-value"]'
/** A ranked bar's own row — the surface the personal figure is printed on. */
const BAR = '[data-testid="overlay-bar"]'

/** A rate, as `lib/formatRate` spells one: a number, then the unit WORD. */
const RATE = /\d\s*(dps|hps)\b/

/** One pass's answer: how much title width there was, and how much of the name fitted it. */
interface NameFit {
  chars: number
  width: number
}

interface FitReadings {
  /** the row as it ships today — no tail. */
  after: NameFit
  /** the row with the pre-JOS-158 rate tail rebuilt into it. */
  before: NameFit
}

/**
 * Measure the fight name twice: as the title bar is now, and with the old rate tail put back.
 *
 * The tail's reconstruction carries the styles `OverlayHeader.HeaderBody` gave it (nowrap,
 * tabular numerals) and the REAL text the meter is showing right now, read off the crumb — so
 * this measures today's actual number rather than a hard-coded guess that would rot.
 */
function readNameFit(overlay: Page, name: string, rate: string): Promise<FitReadings | null> {
  return overlay.evaluate(
    ([trigSel, mobName, rateText]) => {
      const trigger = document.querySelector(trigSel)
      if (!trigger) return null
      const titleEl = trigger.querySelector('span') as HTMLElement | null
      if (!titleEl) return null

      const wasText = titleEl.textContent
      titleEl.textContent = mobName

      // A hidden ruler in the TITLE's own type, so a prefix is measured the way the title paints
      // it. `font` shorthand reads back empty in Blink, so the parts are copied one by one.
      const cs = getComputedStyle(titleEl)
      const ruler = document.createElement('span')
      ruler.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre'
      ruler.style.fontFamily = cs.fontFamily
      ruler.style.fontSize = cs.fontSize
      ruler.style.fontWeight = cs.fontWeight
      ruler.style.fontStyle = cs.fontStyle
      ruler.style.letterSpacing = cs.letterSpacing
      document.body.appendChild(ruler)

      const tail = document.createElement('span')
      tail.style.cssText = 'white-space:nowrap;font-variant-numeric:tabular-nums;flex-shrink:0'
      tail.textContent = rateText

      const passes: { chars: number; width: number }[] = []
      for (let pass = 0; pass < 2; pass++) {
        const width = titleEl.getBoundingClientRect().width
        let fits = 0
        for (let k = 1; k <= mobName.length; k++) {
          ruler.textContent = mobName.slice(0, k)
          if (ruler.getBoundingClientRect().width > width) break
          fits = k
        }
        passes.push({ chars: fits, width })
        // Pass 0 read today's row; now rebuild the one that had a tail and read it again.
        if (pass === 0) trigger.appendChild(tail)
      }

      tail.remove()
      ruler.remove()
      titleEl.textContent = wasText
      return { after: passes[0], before: passes[1] }
    },
    [TRIGGER, name, rate] as const
  )
}

/** The header row's own text — the title bar, and nothing below it. */
function headerText(overlay: Page): Promise<string> {
  return overlay.evaluate(
    (trig) => (document.querySelector(trig)?.parentElement as HTMLElement | null)?.innerText ?? '',
    TRIGGER
  )
}

/**
 * WHERE THE NUMBER IS NOW: in the panel, labelled, and told apart from the bars by colour as well
 * as by the word.
 *
 * The colour half is read from the live DOM rather than asserted as a hex literal — the overlay
 * carries its own palette per kind (it is MUI-free), and what the ruling asks for is that the two
 * numbers do not LOOK the same, not that either is a particular gold.
 */
async function checkLabelledInPanel(overlay: Page): Promise<void> {
  check('the meter states its aggregate inside the panel content', (await countOf(overlay, `${BARS} ${TOTAL}`)) === 1)

  // The row is two spans with a flex gap between them, so `textContent` reads them run together
  // ('all175 dps'). Take the number off the front-loaded label rather than asserting a space the
  // DOM never contained.
  const text = ((await overlay.textContent(TOTAL)) ?? '').replace(/\s+/g, ' ').trim()
  const value = ((await overlay.textContent(TOTAL_VALUE)) ?? '').trim()
  const label = text.slice(0, text.length - value.length).trim()
  check('…and it is LABELLED for what it covers, in the row itself rather than a hover', label === 'all', `${label} / ${value}`)
  check('…and the label is on a rate, unit word and all', RATE.test(value), value)

  const bars = await countOf(overlay, BAR)
  if (bars === 0) {
    note('the overlay’s selected fight has no bars right now — the colour comparison needs one')
    return
  }
  const colors = await overlay.evaluate(
    ([totalSel, barSel]) => {
      const total = document.querySelector(totalSel)
      const bar = document.querySelector(barSel)
      const figure = bar?.querySelectorAll('span')
      const own = figure && figure.length > 0 ? figure[figure.length - 1] : null
      if (!total || !own) return ''
      return `${getComputedStyle(total).color} | ${getComputedStyle(own).color}`
    },
    [TOTAL_VALUE, BAR] as const
  )
  const [aggregate, personal] = colors.split(' | ')
  check(
    'the aggregate is VISUALLY DISTINCT from the personal figure on the bar below it',
    Boolean(aggregate) && aggregate !== personal,
    colors || '(unreadable)'
  )
}

/**
 * THE MEASUREMENT the ticket asks for: a long mob name from the staged fixture, and how much of
 * it the title bar can print now that the rate has left it.
 *
 * THE OVERLAY MUST BE UNLOCKED: locked, there is no trigger to measure (and no selector at all
 * before P3). The caller leaves it that way.
 */
export async function stepTotalOnPanel(overlay: Page, longName: string): Promise<void> {
  const header = await headerText(overlay)
  check(
    'the meter title bar states NO rate any more — that row is the fight name’s now',
    !RATE.test(header),
    header.replace(/\s+/g, ' ').slice(0, 120)
  )

  await checkLabelledInPanel(overlay)

  if (!longName) {
    note('the fixture named no fight to measure a title with — the name-length step was skipped')
    return
  }
  const rate = ((await overlay.textContent(TOTAL_VALUE)) ?? '').trim() || '21.7k dps'
  const sample = overflowing(longName)
  if (sample !== longName) {
    note(
      `the staged fixture's longest fight name is “${longName}” (${longName.length} chars), which ` +
        'already fits this title bar whole — so what is measured is that name REPEATED past the ' +
        "row's width, which is a real EQ name's own letters at a length that has to truncate"
    )
  }
  const fit = await readNameFit(overlay, sample, rate)
  if (!check('the title bar could be measured', fit !== null)) return
  const { before, after } = fit as FitReadings
  note(
    `title bar with “${rate}” beside the name → without: ${before.chars} chars of “${sample}” fit → ` +
      `${after.chars} chars, title span ${before.width.toFixed(1)}px → ${after.width.toFixed(1)}px`
  )
  check(
    'A LONG MOB NAME RENDERS MORE CHARACTERS — the room the rate gave up went to the fight name',
    after.chars > before.chars,
    `${before.chars} → ${after.chars} characters (+${after.chars - before.chars})`
  )
}

/**
 * A name long enough to have to truncate at this window's width, built from the fixture's own.
 *
 * WHY IT IS BUILT AT ALL, stated rather than hidden: the point of the ticket is what happens to a
 * name the title cannot print whole, and the staged fixture's longest fight is 20 characters — it
 * fitted before the change and fits after it, so measured on that name alone the answer is 20 and
 * 20 and the improvement is invisible. Repeating the fixture's real name past the row's width
 * keeps the letters, the spacing and the proportional widths of an actual EQ mob name (which a
 * hand-typed 'X'.repeat(60) would not) while giving the measurement something to cut.
 */
function overflowing(name: string): string {
  let s = name
  while (s.length < 60) s = `${s} ${name}`
  return s
}
