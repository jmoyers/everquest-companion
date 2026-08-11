/**
 * Headless Electron smoke test for CELEBRATION TOASTS (docs/plans/celebration-toasts.md).
 *
 * WHAT ONLY THE REAL APP CAN SHOW. The pure halves are pinned elsewhere — the payload validator
 * and the item card's formatting in tests/toastPayload.test.mts, the queue/hover timing in
 * tests/toastQueue.test.mts, the top-centre geometry in tests/overlayLayout.test.mts. What no
 * unit test can claim is that the PIECES ARE WIRED: that a fresh install spawns the sixth overlay
 * window on its own (the toast defaults ON since 2026-08-05), that Preferences shows that state
 * rather than a second opinion of it, that a payload sent over the REAL `toast:show` channel
 * crosses main (validation, item resolution, fan-out) and lands in that window's DOM as a card,
 * and that a refused payload lands nowhere.
 *
 * AND WHAT A BRAND-NEW INSTALL ACTUALLY SEES (JOS-83). Every launch gets a fresh userData dir, so
 * this spec is always a first run — which makes it the only place that can prove the introduction
 * card appears unprompted, names the app, closes on its ×, and leaves the window empty again. It
 * also reads the window's real bounds out of the main process, because "it covered the entire
 * screen" is a claim about geometry and a first open is the one geometry no user has chosen.
 *
 * NO WINDOW IS EVER SHOWN. `EQ_E2E=1` is the whole test mode (src/main/e2e.ts): the main window
 * never shows and overlays skip `showInactive`, so the toast window here is created, loaded and
 * driven entirely off-screen while the user plays. That is also why this spec drives the app's
 * own bridge rather than clicking a card: a hidden, always-on-top window has no pointer.
 *
 * IT ASSERTS THE DOM, NEVER THE ANIMATION. The card's enter/exit is a CSS transition on
 * transform/opacity; what is checked here is that the card, its title and — for a Sky
 * completion — its reward block with the item's name are actually rendered.
 *
 * Run: `npm run test:e2e` (or `node --import tsx tests/e2e/toast.e2e.mts`).
 */
import type { ElectronApplication, Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  note,
  reportRun,
  settle,
  settleStable
} from './appHarness.mjs'
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'

/** A Sky reward that exists in the committed item DB, so the card resolves with NO network. */
const REWARD = 'Shining Metallic Robes'

/** The level a synthetic ding celebrates, and the level its click must anchor the panel at. */
const DING_LEVEL = 24

/** A quest key that exists in the committed Plane of Sky dataset (`Class::Name`, the app's own). */
const QUEST_KEY = 'Paladin::Paladin Test of Spirit'

/** The toast overlay's page, identified by the `?kind=` query its window was opened with. */
async function findToastWindow(app: ElectronApplication): Promise<Page | null> {
  for (const w of app.windows()) {
    const search = await w.evaluate(() => window.location.search).catch(() => '')
    if (search.includes('kind=toast')) return w
  }
  return null
}

/** Poll until the toast window exists (window creation + page load is asynchronous). */
function waitForToastWindow(app: ElectronApplication, timeoutMs = 30_000): Promise<Page | null> {
  return settle(() => findToastWindow(app), (w) => w !== null, { timeoutMs })
}

/**
 * Send a toast and wait for the STACK to be what the send should have made it — the card count is
 * the condition, and it is the thing every assertion below reads.
 *
 * A REFUSAL is the one case with no positive signal: main is expected to drop the payload, so
 * nothing will ever change. That one waits for the count to hold still instead (`expect` equal to
 * what was already there), which is the same discipline the other absence assertions use.
 */
async function sendAndSettle(main: Page, toast: Page, req: Record<string, unknown>, expect: number): Promise<string[]> {
  await send(main, req)
  await settle(() => cardTexts(toast), (cards) => cards.length >= expect, { timeoutMs: 15_000 })
  return cardTexts(toast)
}

/** Send one toast request over the REAL renderer→main channel, exactly as a detector would. */
function send(page: Page, req: Record<string, unknown>): Promise<void> {
  return page.evaluate(
    (r) => (window as unknown as { eq: { showToast: (x: unknown) => void } }).eq.showToast(r),
    req
  )
}

/** Every rendered card's text, in stack order. */
function cardTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="toast-card"]')].map(
      (el) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
    )
  )
}

/**
 * The switch lives in Preferences → Overlays. It is ON out of the box now (owner, 2026-08-05),
 * so this step asserts the panel AGREES with the window rather than turning anything on — and
 * that the sound controls, which the Alerts module already owns, are gone from it.
 */
async function stepPreferences(page: Page): Promise<void> {
  await page.click('[data-testid="nav-preferences"]', { timeout: 60_000 })
  await page.waitForSelector('[data-testid="prefs-rail-overlays"]', { timeout: 20_000 })
  await page.click('[data-testid="prefs-rail-overlays"]')
  await page.waitForSelector('[data-testid="pref-toast"]', { timeout: 15_000 })
  if (!check('Preferences → Overlays offers the celebration toast', (await countOf(page, '[data-testid="pref-toast"]')) === 1)) {
    return
  }
  // The switch's testid sits on the MUI root, so the checkbox is the input inside it (the
  // telemetry pane's precedent). Its state arrives from MAIN's store over IPC, a beat after the
  // pane mounts — so it is read until it settles, and a switch that never turns on fails here
  // with whatever it last said rather than with whatever it happened to say first.
  const on = await settle(
    () =>
      page.evaluate(
        (sel) => (document.querySelector(sel) as HTMLInputElement | null)?.checked,
        '[data-testid="pref-toast-enabled"] input'
      ),
    (v) => v === true,
    { timeoutMs: 10_000 }
  )
  check('…with its switch already ON, matching the window that opened itself', on === true, String(on))
  check(
    '…and NO sound controls (the boss/quest alerts own that audio)',
    (await countOf(page, '[data-testid="pref-toast-sound"]')) === 0 &&
      (await countOf(page, '[data-testid="pref-toast-pack"]')) === 0
  )
}

/**
 * THE INTRODUCTION (JOS-83) — the one thing a BRAND-NEW install sees before anything is celebrated.
 *
 * The report this answers: a new user met the celebration strip as an anonymous rectangle, decided
 * the app was broken, and uninstalled. A fresh userData dir (every launch gets one) is therefore
 * the exact state under test, and what it must produce is a card that NAMES THE PROGRAM and can be
 * closed — not an empty window.
 *
 * It also pins the window's real GEOMETRY from the main process, because the other half of that
 * report was "it covered the entire screen": a first-open celebration overlay is a small strip near
 * the top of the work area, and no stored bounds exist on a fresh install to say otherwise.
 */
async function stepIntroduction(app: ElectronApplication, toast: Page): Promise<void> {
  const cards = await settle(() => cardTexts(toast), (c) => c.length >= 1, { timeoutMs: 20_000 })
  if (!check('a fresh install is INTRODUCED to the celebration overlay (one card, unprompted)', cards.length === 1, `${cards.length} card(s)`)) {
    return
  }
  check('…and the card names the program that put it there', cards[0].includes('EQ Legends Companion'), cards[0])
  check('…saying the window is not EverQuest’s', cards[0].includes('not to EverQuest'), cards[0])
  check('…and pointing at the switch that turns it off', cards[0].includes('Preferences'), cards[0])
  check('…with a source label on the card chrome', (await countOf(toast, '[data-testid="toast-source-label"]')) === 1)
  check('…a visible close control', (await countOf(toast, '[data-testid="toast-close"]')) === 1)
  check('…and a one-click way to disable the overlay for good', (await countOf(toast, '[data-testid="toast-intro-disable"]')) === 1)

  // GEOMETRY, read from MAIN — the answer to "it covered the entire screen".
  const win = await app.browserWindow(toast)
  const bounds = await win.evaluate((w) => w.getBounds())
  const area = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
  const share = (bounds.width * bounds.height) / (area.width * area.height)
  check(
    'the first-open celebration window is a small strip, not a screen-filling window',
    share < 0.25 && bounds.width < area.width && bounds.height < area.height,
    `${JSON.stringify(bounds)} on ${JSON.stringify(area)} (${(share * 100).toFixed(1)}%)`
  )
  check(
    '…parked near the TOP of the work area, horizontally centred',
    bounds.y - area.y < 100 && Math.abs(bounds.x - area.x - (area.width - bounds.width) / 2) <= 2,
    JSON.stringify(bounds)
  )

  // DISMISSIBLE: the × is wired to the queue's own dismiss action, so the card goes NOW rather
  // than at the end of its clock. (The overlay is never shown under EQ_E2E and has no pointer —
  // `el.click()` is a real DOM click and React's delegated listener cannot tell the difference.)
  await toast.evaluate(() => {
    ;(document.querySelector('[data-testid="toast-close"]') as HTMLElement | null)?.click()
  })
  const after = await settle(() => cardTexts(toast), (c) => c.length === 0, { timeoutMs: 10_000 })
  check('…and the close control actually dismisses it', after.length === 0, `${after.length} card(s)`)
  const rest = await settleStable(() => cardTexts(toast), { timeoutMs: 5_000, stable: 5, pollMs: 150 })
  check('…leaving the overlay back at its resting state: rendering nothing at all', rest.length === 0, rest.join(' | '))
}

/** A boss kill: a gold title line and nothing else — no reward, no click target. */
async function stepBossToast(main: Page, toast: Page): Promise<void> {
  const cards = await sendAndSettle(
    main,
    toast,
    {
      id: 'e2e-boss-1',
      kind: 'bossKill',
      title: 'Lord Nagafen defeated',
      subtitle: 'D2 · Adaptive · Nagafen’s Lair',
      // A long hold on purpose: the later steps assert that a second card STACKS under this one,
      // and a 6 s default would make that a race against the machine rather than a claim about
      // the queue. The payload's own duration is honoured (and capped) by the validator.
      durationMs: 25_000
    },
    1
  )
  if (!check('a boss kill sent over `toast:show` renders a card in the toast window', cards.length === 1, `${cards.length} card(s)`)) {
    return
  }
  check('…carrying the kill’s own title', cards[0].includes('Lord Nagafen defeated'), cards[0])
  check('…and its tier/zone subtitle', cards[0].includes('D2'), cards[0])
  // JOS-83: EVERY card says whose window it is and offers a way out — not just the introduction.
  check(
    '…and the overlay’s own label + close control, on an ordinary celebration',
    (await countOf(toast, '[data-testid="toast-source-label"]')) === 1 &&
      (await countOf(toast, '[data-testid="toast-close"]')) === 1
  )
}

/** A refused payload must reach no window at all — the validator is main's, not the overlay's. */
async function stepRefusal(main: Page, toast: Page): Promise<void> {
  const before = (await cardTexts(toast)).length
  await send(main, { id: 'e2e-bogus', kind: 'somethingElse', title: 'should never render' })
  await send(main, { kind: 'bossKill', title: 'no id either' })
  // Nothing is supposed to happen, so the positive signal is the stack HOLDING STILL — a settled
  // count says "the send round trip has been and gone", which a flat 800ms only assumed.
  const after = await settleStable(() => cardTexts(toast), { timeoutMs: 8_000, stable: 5, pollMs: 150 })
  check(
    'a payload with an unknown kind (or no id) renders NOTHING — main refuses it',
    after.length === before,
    `${after.length} card(s): ${after.join(' | ')}`
  )
}

/** A Sky completion: the title, plus the reward item card MAIN resolved and embedded. */
async function stepQuestToast(main: Page, toast: Page): Promise<void> {
  // Item resolution is local-first (the committed items DB) but still a round trip through main;
  // the second card ARRIVING is the condition, so there is nothing left to guess at.
  const cards = await sendAndSettle(
    main,
    toast,
    {
      id: 'e2e-quest-1',
      kind: 'skyQuestComplete',
      title: 'Quest complete: Test of Sacrifice',
      subtitle: 'Paladin',
      itemName: REWARD,
      focus: { view: 'posky' },
      durationMs: 25_000
    },
    2
  )
  const quest = cards.find((c) => c.includes('Quest complete'))
  if (!check('a Sky completion renders its own card', !!quest, cards.join(' | ') || 'no cards')) return
  check('…titled with the quest', (quest ?? '').includes('Test of Sacrifice'), quest ?? '')
  check(
    '…and embedding the reward item RESOLVED IN MAIN (the overlay fetches nothing)',
    (quest ?? '').includes(REWARD),
    quest ?? ''
  )
  const stacked = cards.length
  check('…stacked under the boss card rather than replacing it', stacked === 2, `${stacked} card(s)`)
}

/**
 * A LEVEL-UP: the third kind (docs/plans/levelup-whats-new.md §2), and the first with no reward
 * block — so the CARD itself is the click target, which the next step exercises.
 */
async function stepLevelUpToast(mainPage: Page, toast: Page): Promise<void> {
  const cards = await sendAndSettle(
    mainPage,
    toast,
    {
      id: `e2e-level-${String(DING_LEVEL)}`,
      kind: 'levelUp',
      title: `Level ${String(DING_LEVEL)}!`,
      subtitle: '3 new spells · 2 new skills',
      focus: { view: 'leveling', level: DING_LEVEL },
      durationMs: 25_000
    },
    3
  )
  const card = cards.find((c) => c.includes(`Level ${String(DING_LEVEL)}!`))
  if (!check('a level-up sent over `toast:show` renders its own card', !!card, cards.join(' | ') || 'no cards')) {
    return
  }
  check('…subtitled with what the ding unlocked', (card ?? '').includes('new spells'), card ?? '')
}

/** Does the app have character logs at all? Without them no feature view mounts (App's gate). */
async function hasFeatureViews(page: Page): Promise<boolean> {
  const text = await page.evaluate(() => (document.querySelector('main') as HTMLElement | null)?.innerText ?? '')
  return !text.includes('No EverQuest logs found')
}

/**
 * THE DEEP-LINK ROUNDTRIP, end to end and through the REAL plumbing: a click on the toast card in
 * the overlay window → `eqOverlay.focusApp` → main's `focusView` handler (which re-validates the
 * view AND the anchor) → the app renderer's `applyDeepLink` → the Leveling tab, with the "New at
 * this level" panel opened ON THE LEVEL THAT DINGED.
 *
 * The click is dispatched inside the page rather than with the mouse because the overlay is
 * always-on-top and NEVER SHOWN under EQ_E2E — it has no pointer to move. `el.click()` is a real
 * DOM click event and React's delegated listener handles it exactly as it handles the user's.
 */
async function stepDeepLinkRoundtrip(mainPage: Page, toast: Page): Promise<void> {
  const clicked = await toast.evaluate((needle) => {
    const el = [...document.querySelectorAll('[data-testid="toast-card"]')].find((e) =>
      (e as HTMLElement).innerText.includes(needle)
    )
    if (!el) return false
    ;(el as HTMLElement).click()
    return true
  }, `Level ${String(DING_LEVEL)}!`)
  if (!check('the level-up card is a click target (no reward block ⇒ the card itself)', clicked)) return

  const landed = await mainPage
    .waitForSelector('[data-testid="new-at-level"]', { timeout: 20_000 })
    .then(
      () => true,
      () => false
    )
  if (!check('…and the click lands the app on the Leveling tab’s "New at this level" panel', landed)) return
  const value = await mainPage.evaluate(
    () => (document.querySelector('[data-testid="new-at-level-value"]') as HTMLElement | null)?.innerText ?? ''
  )
  check('…anchored at the level that dinged, not at the character’s own', value.includes(String(DING_LEVEL)), value)
  check(
    '…with the level stepper mounted (the panel is browsable, not just historical)',
    (await countOf(mainPage, '[data-testid="new-at-level-next"]')) === 1
  )
}

/**
 * THE PER-QUEST ANCHOR (docs/plans/celebration-toasts.md T6, finished in wave O2). Wave L shipped
 * the tab-level half and flagged this as the follow-up: the payload now names a quest, and the
 * Plane of Sky tab must EXPAND and reveal exactly that one.
 *
 * Driven through the same `focusApp` door the reward card's click uses (the click plumbing itself
 * is already proven by the step above), so what this asserts is the receiving half: main's
 * validation forwards the anchor, and PoskyView resets its filters around the quest and mounts
 * its accordion expanded.
 */
async function stepQuestAnchor(mainPage: Page, toast: Page): Promise<void> {
  await toast.evaluate((quest) => {
    ;(window as unknown as { eqOverlay: { focusApp: (f: unknown) => void } }).eqOverlay.focusApp({
      view: 'posky',
      quest
    })
  }, QUEST_KEY)
  const anchored = await mainPage
    .waitForSelector('[data-anchored="true"]', { timeout: 20_000 })
    .then(
      () => true,
      () => false
    )
  if (!check('a toast focus naming a quest anchors the Plane of Sky tab on it', anchored)) return
  const state = await mainPage.evaluate(() => {
    const el = document.querySelector('[data-anchored="true"]')
    return {
      expanded: !!el?.classList.contains('Mui-expanded'),
      text: (el as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').slice(0, 80) ?? ''
    }
  })
  check('…mounting that quest EXPANDED, not merely scrolled to', state.expanded, state.text)
  check('…and it is the quest the payload named', state.text.includes('Test of Spirit'), state.text)
}

async function main(): Promise<void> {
  buildIfStale()

  console.log('launch: hidden Electron (EQ_E2E=1) against tests/fixtures/e2e-toast.log…')
  const { app, close } = await launchOnFixture('e2e-toast.log')

  let page: Page | null = null
  try {
    page = await mainWindow(app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })

    // ON OUT OF THE BOX (owner, 2026-08-05: "it should be on by default"). A fresh install has
    // no stored `overlays.toast`, so the DEFAULT decides — and the window is the feature, so the
    // proof is that it exists before anybody has touched a setting.
    const toast = await waitForToastWindow(app)
    if (check('the toast overlay is ON for a fresh install (hidden, under EQ_E2E)', toast !== null)) {
      const t = toast as Page
      await stepIntroduction(app, t)
      await stepPreferences(page)
      await stepBossToast(page, t)
      await stepRefusal(page, t)
      await stepQuestToast(page, t)
      await stepLevelUpToast(page, t)
      // The two deep links need a mounted feature view to land in; a machine with no character
      // logs shows App's fresh-machine empty state in front of every one of them, which is the
      // CORRECT behaviour and not something these steps can assert through.
      if (await hasFeatureViews(page)) {
        await stepDeepLinkRoundtrip(page, t)
        await stepQuestAnchor(page, t)
      } else {
        note('no character logs on this machine — the deep-link roundtrips need a mounted feature view, so they are skipped')
      }
    }

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    if (failures.length) await dumpArtifacts(page, 'toast-FAIL')
  } finally {
    await close()
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  note('the toast spec did not complete')
  process.exitCode = 1
})
