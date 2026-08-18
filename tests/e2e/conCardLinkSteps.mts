/**
 * conCardLinkSteps.mts — THE CON CARD IS A LILY PAD (JOS-390): what a click on it does, what the ×
 * does instead, and what the card stopped carrying.
 *
 * Living next door for the reason the chip steps do: con-card.e2e.mts sits AT the repo's
 * `max-lines 400` factoring ceiling, and the rule here is SPLIT, never ratchet (drill.mts set the
 * precedent; conCardChipSteps.mts is this spec's own). The spec keeps the launch, the order and
 * everything about what a card IS; this file is the ticket that turned it into a link.
 *
 * Read con-card.e2e.mts's header first; it carries the frame these steps run inside — no window is
 * ever shown under `EQ_E2E=1`, so the overlay has no pointer and every click here is dispatched
 * in-page, exactly as toastDeepLinkSteps.mts dispatches the celebration card's.
 *
 * THE THREE CLAIMS, and why each needs the real app:
 *
 *   THE LINK. A click on the card body travels a chain no unit test can stand up: the con-card
 *   renderer → `eqOverlay.focusMob` → main's `focusView` handler (which re-validates the view and
 *   REBUILDS the payload) → the app renderer's `applyDeepLink` → `openMob` → the Mobs tab's drill.
 *   Five processes' worth of contract, and the only thing that reads all of it is a launched app.
 *
 *   THE TWO REFUSALS. The × closes the card and navigates NOTHING (a close is not a link), and an
 *   UNLOCKED card does not navigate either (unlocked is positioning mode — a click there is the
 *   user dragging the window, and a card that jumped to the Mobs tab every time it was moved would
 *   be unusable). Both are ABSENCES, and are asserted the way this suite asserts absences: park the
 *   app somewhere that is definitely not a mob page, act, then wait for the reading to STOP MOVING
 *   before reading it (wave E3).
 *
 *   THE REMOVAL. The drops, the counts and the respawn left the card in the same ruling. A payload
 *   field can be deleted while a component still draws a stale block, and the e2e is the only thing
 *   in this repo that reads the BUILT renderer.
 */
import type { Page } from 'playwright-core'
import { check, countOf, settle, settleStable } from './appHarness.mjs'

const CARD = '[data-testid="con-card"]'
const NAME = '[data-testid="con-card-name"]'
const CLOSE = '[data-testid="con-card-close"]'
/** The app's mob page, identified by its Back button — deep-link-back.e2e.mts's own handle on it. */
const MOBS_BACK = '[data-testid="mobs-back"]'
/** The one scroller every tab lives in (JOS-289); read for the name the mob page is showing. */
const APP_CONTENT = '[data-testid="app-content"]'

/** The lock's door, and the ONE Preferences' "Move it" switch writes through (ConCardSetting.tsx). */
interface LockBridge {
  setConCardLocked: (locked: boolean) => void
}

/** Rendered text of the first match, whitespace folded; '' when nothing is mounted. */
function textOf(page: Page, sel: string): Promise<string> {
  return page.evaluate(
    (s) => (document.querySelector(s) as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim() ?? '',
    sel
  )
}

/** An attribute of the first match; '' when the node is absent or the attribute is not set. */
function attrOf(page: Page, sel: string, attr: string): Promise<string> {
  return page.evaluate((a) => document.querySelector(a.sel)?.getAttribute(a.attr) ?? '', { sel, attr })
}

/** How many cards are on screen. There is never supposed to be more than one. */
function cardCount(card: Page): Promise<number> {
  return countOf(card, CARD)
}

/** Is a mob page up in the app, and whose? '' when there is no mob page at all. */
async function mobPageShowing(page: Page): Promise<string> {
  if ((await countOf(page, MOBS_BACK)) === 0) return ''
  return textOf(page, APP_CONTENT)
}

/**
 * Send the main window somewhere that is definitely NOT a mob page, so an arrival is a MOVE rather
 * than a reading of where the app already was — and so an absence claim has something to be absent
 * from.
 */
async function parkOnOverview(page: Page): Promise<void> {
  await page.click('[data-testid="nav-overview"]', { timeout: 15_000 })
  await settle(() => countOf(page, MOBS_BACK), (n) => n === 0, { timeoutMs: 15_000 }).catch(() => 0)
}

/**
 * Click the card BODY — the card ELEMENT itself, so the × inside it is never involved.
 *
 * `el.click()` dispatches on that node and React's delegated listener handles it exactly as it
 * handles a user's, with the card as the event target: precisely the case the handler's `closest`
 * on the close button has to let THROUGH. Clicking the × is the same call aimed one node over,
 * which is what makes the pair of them one assertion about one rule.
 */
function clickIn(card: Page, sel: string): Promise<boolean> {
  return card.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null
    if (!el) return false
    el.click()
    return true
  }, sel)
}

/**
 * THE CARD IS NOT A DROP LIST ANY MORE. One step where a whole drop-ranking step used to be.
 *
 * The card carried the wiki drop table, your looted counts and the respawn until the owner narrowed
 * it to a header, its resist chips and a click. Everything it dropped is on the page that click
 * opens, which the next step proves — so this is the other half of one ruling, not a deletion
 * standing on its own.
 */
export async function stepNoDropsOnTheCard(card: Page): Promise<void> {
  const body = await textOf(card, CARD)
  check('the card no longer draws a drop block at all',
    (await countOf(card, '[data-testid="con-card-drops"]')) === 0, body.slice(0, 200))
  check('…nor a single drop line', (await countOf(card, '[data-testid="con-card-drop"]')) === 0)
  check('…nor a respawn line', (await countOf(card, '[data-testid="con-card-respawn"]')) === 0)
  // The two sentences that block used to say. Either one on screen means an old renderer shipped.
  check('…and never says it is looking anything up',
    !/Looking up|No drops known/i.test(body), body.slice(0, 200))
  // …and the card says what it IS now. NAMED, NEVER HOVERED (the 2026-08-16 overlay tooltip
  // ruling): the words are the card's accessible name, the seeing reader's hint is the name wearing
  // a link's underline, and NOTHING in this bundle hands the DOM a `title` — which is asserted
  // structurally by tests/overlayTooltipPolicy.test.mts and observably right here.
  check('the card NAMES where a click goes',
    (await attrOf(card, CARD, 'aria-label')) === 'Open in the app', await attrOf(card, CARD, 'aria-label'))
  check('…and the name wears a link, which is the hint you can see',
    (await attrOf(card, NAME, 'data-linked')) === 'true', await attrOf(card, NAME, 'data-linked'))
  check('…and nothing on the card hovers a tooltip over the game',
    (await countOf(card, `${CARD} [title], ${CARD}[title]`)) === 0)
}

/**
 * A CLICK ANYWHERE BUT THE × OPENS THE MOB PAGE — the acceptance criterion this ticket exists for.
 *
 * AND THE CARD STAYS. That is not a detail: clicking is "show me more", not "I have read it", and
 * the difference is what main's minute-long re-con suppression rests on — only the × writes a close,
 * and the step below is what proves the × still does.
 */
export async function stepClickOpensTheMobPage(card: Page, page: Page, mob: string): Promise<void> {
  await parkOnOverview(page)
  const linked = await attrOf(card, CARD, 'data-linked')
  check('a LOCKED card is a link (the state the click claim is about)', linked === 'true', linked)
  if (!check('the card body is there to click', await clickIn(card, CARD))) return
  const landed = await settle(() => countOf(page, MOBS_BACK), (n) => n === 1, { timeoutMs: 20_000 }).catch(() => 0)
  if (!check('clicking the card opens the MOB PAGE in the app', landed === 1, `${String(landed)} mob page(s)`)) return
  const shown = await settle(() => mobPageShowing(page), (t) => t.includes(mob), { timeoutMs: 10_000 }).catch(() => '')
  check('…on the creature that was conned, under the name the log printed', shown.includes(mob), shown.slice(0, 160))
  check('…with the Mobs tab selected', (await countOf(page, '[data-testid="nav-mobs"].Mui-selected')) === 1)
  const still = await cardCount(card)
  check('…and the card is STILL up — a click is "show me more", not "I have read it"',
    still === 1, `${String(still)} card(s)`)
  check('…naming the same creature it just opened', (await textOf(card, NAME)) === mob, await textOf(card, NAME))
}

/**
 * UNLOCKED, A CLICK IS A DRAG — the half of the ruling that would break silently.
 *
 * Positioning the card means clicking on it, so a card that navigated while being dragged would
 * send the reader to the Mobs tab every time they tried to move it. The lock is written through
 * Preferences' own door (`setConCardLocked`, what the "Move it" switch calls), so the configuration
 * under test is one a real user can be in — and it is PUT BACK before returning, because every step
 * after this one reads a locked card.
 */
export async function stepUnlockedClickDoesNotNavigate(card: Page, page: Page): Promise<void> {
  const setLocked = (locked: boolean): Promise<void> =>
    page.evaluate((l) => (window as unknown as { eq: LockBridge }).eq.setConCardLocked(l), locked)
  const linkState = (want: string): Promise<string> =>
    settle(() => attrOf(card, CARD, 'data-linked'), (v) => v === want, { timeoutMs: 10_000 }).catch(() => '')

  await parkOnOverview(page)
  await setLocked(false)
  // The lock crosses IPC and comes back as a config echo, so the mode is a state to settle on.
  const unlocked = await linkState('false')
  if (!check('unlocking the card puts it in positioning mode — it stops being a link', unlocked === 'false', unlocked)) {
    await setLocked(true)
    await linkState('true')
    return
  }
  await clickIn(card, CARD)
  const stayed = await settleStable(() => countOf(page, MOBS_BACK), { timeoutMs: 8_000, stable: 5, pollMs: 200 })
  check('…and a click there navigates NOTHING — it is the user moving the window',
    stayed === 0, `${String(stayed)} mob page(s)`)
  await setLocked(true)
  const relocked = await linkState('true')
  check('…and locking it again makes it a link once more', relocked === 'true', relocked)
}

/**
 * THE × IS A CLOSE AND ONLY A CLOSE — the rule the card-wide handler excludes it by (ancestry, not
 * a `stopPropagation` in the button), read back from the outside.
 *
 * Returns whether the card actually went, so the caller's suppression claims know they have a close
 * to stand on.
 */
export async function stepCloseDoesNotNavigate(card: Page, page: Page): Promise<boolean> {
  await parkOnOverview(page)
  if (!check('the card’s × is there to click', await clickIn(card, CLOSE))) return false
  const gone = await settle(() => cardCount(card), (n) => n === 0, { timeoutMs: 10_000 }).catch(() => 1)
  if (!check('clicking the card’s own × closes it', gone === 0, `${String(gone)} card(s)`)) return false
  const stayed = await settleStable(() => countOf(page, MOBS_BACK), { timeoutMs: 8_000, stable: 5, pollMs: 200 })
  check('…and navigates NOTHING — the one control on the card that is not the link',
    stayed === 0, `${String(stayed)} mob page(s)`)
  return true
}
