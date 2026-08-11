/**
 * Headless Electron smoke test for the XP OVERLAY (JOS-195).
 *
 * WHAT ONLY THE REAL APP CAN SHOW. The row model is pinned over hand-built snapshots in
 * tests/xpOverlay.test.mts (the checklist, the mote family, the cap switch, the refusals); the
 * arithmetic under it is pinned in the progression, levelEta, aaPace, lootRates and timeslice
 * suites; the ≤25 % first-open geometry over every work area in tests/overlayLayout.test.mts.
 * None of those can claim the PIECES ARE WIRED — that the window ships off, that toggling it
 * spawns a `?kind=xp` window with its own labelled chrome, that a window whose whole subject is a
 * fold over months of log actually RECEIVES that fold in a second renderer (`progression` AND
 * `loot`, through pipeline.ts's `MODULE_READING_OVERLAYS` fan-out), and that a mote looted in the
 * LIVE log travels the entire real path — chokidar → Tailer → parseEvent → LootModule → registry
 * flush → `module:delta` → the overlay's fan-out → React — and comes out as a named tier with a
 * rate beside it.
 *
 * That last one is the ticket's own ask ("motes/hr by mote type"), and it is the reason the mote
 * is PLAYED rather than borrowed from the fixture: e2e-leveling.log carries 341 experience lines
 * and no motes at all, so a mote row appearing here can only have come down the live path.
 *
 * DEFAULT OFF, and every launch here gets a fresh userData dir — so this spec is always a first
 * run, which makes it the one place that can prove what a new install gets.
 *
 * NO WINDOW IS EVER SHOWN. `EQ_E2E=1` is the whole test mode (src/main/e2e.ts): the main window
 * never shows and overlays skip `showInactive`. So this spec drives the app's own bridges rather
 * than clicking — a hidden, always-on-top window has no pointer — and reads geometry out of the
 * MAIN process, because "it covered my screen" is a claim about bounds.
 *
 * WAIT FOR THE CONDITION, NEVER FOR THE CLOCK (wave E3): every read below goes through `settle`.
 *
 * Run: `npm run test:e2e -- xp` (or `node --import tsx tests/e2e/xp-overlay.e2e.mts`).
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
import { mainWindow, overlayWindow } from './appWindow.mjs'
import { launchOnFixture, type FixtureLog } from './logFixture.mjs'

/** The main window's overlay bridge — the same one the title-bar menu calls. */
interface OverlayBridge {
  getOverlayState: () => Promise<Record<string, boolean>>
  toggleOverlay: (k: string) => Promise<boolean>
}
function bridge(page: Page): {
  state: () => Promise<Record<string, boolean>>
  toggle: (k: string) => Promise<boolean>
} {
  return {
    state: () => page.evaluate(() => (window as unknown as { eq: OverlayBridge }).eq.getOverlayState()),
    toggle: (k: string) =>
      page.evaluate((kind) => (window as unknown as { eq: OverlayBridge }).eq.toggleOverlay(kind), k)
  }
}

/** One rendered row, as the window draws it. */
interface Row {
  id: string
  row: string
  label: string
  value: string
}

/**
 * Every row on screen. `data-row` is the checklist entry it belongs to, which is what makes a
 * "this row is gone" assertion mean the checklist rather than an empty model.
 *
 * The prefix selects ROWS ONLY, and that is a property of the testids rather than of a filter
 * here: the value span is `xp-value` and the footer's checklist buttons are `xp-toggle-<id>`,
 * precisely so neither can be swept up by this query. The first cut of this spec counted the value
 * span as a row (`xp-row-value` matched), and every row count was silently doubled — JOS-119's
 * substring lesson, one nesting level down.
 */
function rows(page: Page): Promise<Row[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="xp-row-"]')].map((e) => ({
      id: (e.getAttribute('data-testid') ?? '').replace('xp-row-', ''),
      row: e.getAttribute('data-row') ?? '',
      label: (e.querySelector('span')?.textContent ?? '').trim(),
      value: (e.querySelector('[data-testid="xp-value"]')?.textContent ?? '').trim()
    }))
  )
}

/** The caption line under the rows: which stretch, and how much active play it is over. */
function span(page: Page): Promise<string> {
  return page.evaluate(
    () => (document.querySelector('[data-testid="xp-span"]') as HTMLElement | null)?.innerText.trim() ?? ''
  )
}

/** Write through the overlay's OWN config bridge — the same `overlay:setConfig` IPC the footer
 *  controls land on, carrying the KIND the preload read from its own `?kind=` query. A hidden,
 *  always-on-top window has no pointer to click those controls with. */
function setConfig(page: Page, patch: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(
    (p) =>
      (window as unknown as { eqOverlay: { setConfig: (x: unknown) => Promise<unknown> } }).eqOverlay.setConfig(p),
    patch
  )
}

function getConfig(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() =>
    (window as unknown as { eqOverlay: { getConfig: () => Promise<Record<string, unknown>> } }).eqOverlay.getConfig()
  )
}

/** How many windows the app currently has open on a given `?kind=` (exact, never a substring). */
async function windowsOfKind(app: ElectronApplication, kind: string): Promise<number> {
  let hit = 0
  for (const w of app.windows()) {
    const search = await w.evaluate(() => window.location.search).catch(() => '')
    if (new URLSearchParams(search).get('kind') === kind) hit++
  }
  return hit
}

async function stepDefaultOff(page: Page, app: ElectronApplication): Promise<void> {
  const state = await bridge(page).state()
  check('a fresh install has the XP overlay OFF', state.xp === false, JSON.stringify(state))
  check(
    '…and no XP window was spawned at startup',
    (await windowsOfKind(app, 'xp')) === 0,
    `${app.windows().length} window(s) open`
  )
}

async function stepOpenAndChrome(page: Page, app: ElectronApplication): Promise<Page | null> {
  const open = await bridge(page).toggle('xp')
  if (!check('toggling XP from the overlay menu reports it OPEN', open === true)) return null

  const overlay = await overlayWindow(app, 'xp')
  if (!check('…and a window for kind=xp really exists', overlay !== null)) return null
  const o = overlay

  const mounted = await settle(() => countOf(o, '[data-testid="xp-overlay"]'), (n) => n === 1, { timeoutMs: 20_000 })
  check('the XP surface mounts', mounted === 1)
  const text = await o.evaluate(() => document.body.innerText)
  check('…with the labelled XP chrome', text.includes('XP'), text.slice(0, 160))
  // Unlocked (the default), so the header's controls are real and reachable. Both are selected by
  // the aria-label the shared IconButton already carries.
  check('…and a visible close control', (await countOf(o, 'button[aria-label="Close overlay"]')) === 1)
  check('…and the lock (click-through) control beside it', (await countOf(o, 'button[aria-label^="Lock"]')) === 1)
  return o
}

/**
 * THE FOLD REACHES THE SECOND RENDERER.
 *
 * This is the claim `MODULE_READING_OVERLAYS` exists for, and the one a unit test cannot make: the
 * XP window is created in the same `whenReady` turn that starts the historical fold, so a window
 * that only rode `module:delta` would sit at an empty snapshot forever on an idle log. The fixture
 * carries 341 experience lines and a ding, so a REAL pace and a REAL level are what a wired window
 * shows — an em-dash on both would be exactly the JOS-172 bug in a new window.
 *
 * IT ALSO CARRIES AA GAIN LINES while the character is still levelling (the log states a level-bar
 * percentage on every one of those 341), which is JOS-202's whole case: both bars are filling, so
 * the window draws BOTH paces. This is the only test that can show the two arriving together out of
 * one real fold.
 */
async function stepHydratesFromTheFold(overlay: Page): Promise<void> {
  // FOUR rows exactly, and the count is an assertion in its own right: the query below selects rows
  // and nothing else (see `rows`), so a fifth would mean something is being drawn twice.
  const seen = await settle(() => rows(overlay), (r) => r.length >= 4, { timeoutMs: 30_000 })
  check(
    'the window draws both paces, the projection and the motes line',
    JSON.stringify(seen.map((r) => r.id)) === '["xp","aa","eta","motes-none"]',
    JSON.stringify(seen)
  )
  const xp = seen.find((r) => r.id === 'xp')
  check(
    'the pace row carries a number folded out of the log, not an em-dash',
    xp !== undefined && /^\d/.test(xp.value),
    JSON.stringify(xp)
  )
  // JOS-202: the AA read is not reserved for the cap. This character is levelling — the levels row
  // above proves the log is still stating a bar — and the AA row is beside it, on the same
  // checklist entry, with a number out of the same fold.
  const aa = seen.find((r) => r.id === 'aa')
  check(
    'AA per hour is drawn WHILE LEVELING, beside the levels pace',
    aa !== undefined && aa.row === 'xp' && aa.label === 'AA' && /^\d/.test(aa.value),
    JSON.stringify(aa)
  )
  const header = await overlay.evaluate(() => document.body.innerText)
  check('…and the header states the level the log last reported', /lvl \d+/.test(header), header.slice(0, 160))
  const caption = await span(overlay)
  check('…under one span that says what every rate on it divides by', /active/.test(caption), caption)
}

/**
 * A MOTE LOOTED RIGHT NOW SHOWS UP AS ITS TIER, WITH A RATE — the ticket's own ask, end to end.
 *
 * The line is the real one, verbatim from the shape `shared/alertGroups.ts` quotes (the reference
 * log printed 285 of them). e2e-leveling.log contains none, so before this the window is showing
 * its honest "none here" row and afterwards it is showing a tier — which is the whole live path in
 * one before/after.
 */
async function stepLiveMote(overlay: Page, log: FixtureLog): Promise<void> {
  const before = (await rows(overlay)).filter((r) => r.row === 'motes')
  check(
    'a slice with no mote says so rather than leaving a blank section',
    before.length === 1 && before[0].id === 'motes-none',
    JSON.stringify(before)
  )

  log.append("--You have looted a Mote of Infinitesimal Potential from a zol ghoul knight's corpse.--")
  const after = await settle(
    () => rows(overlay),
    (r) => r.some((x) => x.row === 'motes' && x.id !== 'motes-none'),
    { timeoutMs: 30_000 }
  )
  const motes = after.filter((r) => r.row === 'motes')
  if (!check('a mote looted in the LIVE log reaches this window', motes.length === 1, JSON.stringify(after))) return
  check('…named by its TIER, not by the whole item name', motes[0].label === 'Infinitesimal', JSON.stringify(motes[0]))
  check('…with a rate beside it', /^\d/.test(motes[0].value), JSON.stringify(motes[0]))
}

/**
 * THE WHOLE OF THE CONFIGURABILITY (owner scope): a row checklist, persisted per window.
 *
 * Two halves, and the second is the one a local `useState` would pass without: the row leaves the
 * DOM, AND the choice lands in `overlays.xp` where the next launch will read it.
 */
async function stepRowChecklist(overlay: Page): Promise<void> {
  // One toggle per CHECKLIST ENTRY, which is not one per drawn line: 'xp' covers both paces and
  // 'motes' covers however many tiers dropped (shared/xpOverlay.ts states the rule).
  check('the checklist offers one toggle per entry', (await countOf(overlay, '[data-testid^="xp-toggle-"]')) === 3)

  await setConfig(overlay, { xpRows: ['xp', 'eta'] })
  const hidden = await settle(() => rows(overlay), (r) => !r.some((x) => x.row === 'motes'), { timeoutMs: 15_000 })
  check('switching the motes row off takes it out of the window', !hidden.some((r) => r.row === 'motes'), JSON.stringify(hidden))
  check(
    '…and leaves the other two exactly where they were',
    hidden.some((r) => r.row === 'xp') && hidden.some((r) => r.row === 'eta'),
    JSON.stringify(hidden)
  )
  const stored = await settle(() => getConfig(overlay), (c) => Array.isArray(c.xpRows), { timeoutMs: 10_000 })
  check('…written to this window’s own persisted config', JSON.stringify(stored.xpRows) === '["xp","eta"]', JSON.stringify(stored.xpRows))

  // A store cannot switch on a row this build does not have — the closed union, through the real
  // IPC and the real normalizer in main.
  await setConfig(overlay, { xpRows: ['xp', 'money'] })
  const rejected = await settle(() => getConfig(overlay), (c) => JSON.stringify(c.xpRows) === '["xp"]', {
    timeoutMs: 10_000
  })
  check('an unknown row id is dropped by main rather than stored', JSON.stringify(rejected.xpRows) === '["xp"]', JSON.stringify(rejected.xpRows))

  await setConfig(overlay, { xpRows: ['xp', 'eta', 'motes'] })
  const restored = await settle(() => rows(overlay), (r) => r.some((x) => x.row === 'motes'), { timeoutMs: 15_000 })
  check('…and switching it back on brings the row back', restored.some((r) => r.row === 'motes'), JSON.stringify(restored))
}

/**
 * THE SLICE IS THE LEVELING TAB'S, AND ITS DEFAULT DEGRADES HONESTLY.
 *
 * e2e-leveling.log states no logout anywhere, so this record cannot define a session — and the
 * stored default (`session`) must therefore resolve to the whole log rather than to an invented
 * boundary. Then a duration rung proves the pick really re-scopes the numbers rather than only
 * re-labelling them.
 */
async function stepSlice(overlay: Page): Promise<void> {
  const opened = await settleStable(() => span(overlay), { timeoutMs: 15_000 })
  check(
    'a log that states no logout cannot define a session, so the window opens on the whole log',
    opened.includes('the whole log'),
    opened
  )

  await setConfig(overlay, { xpSlice: 'h1' })
  const narrowed = await settle(() => span(overlay), (t) => t !== opened, { timeoutMs: 15_000 })
  check('picking a narrower slice re-words the caption', narrowed.includes('1h'), narrowed)
  check('…and re-measures the span every rate divides by', narrowed !== opened, `${opened} → ${narrowed}`)

  await setConfig(overlay, { xpSlice: 'all' })
  const back = await settle(() => span(overlay), (t) => t === opened, { timeoutMs: 15_000 })
  check('…and going back to the whole log restores it exactly', back === opened, `${narrowed} → ${back}`)
}

/** Close it the way a user would — its own ✕ — and prove main recorded it. */
async function stepClose(page: Page, app: ElectronApplication, overlay: Page | null): Promise<void> {
  if (overlay) {
    // The click destroys the page it is evaluated in, so this evaluate is allowed to lose its
    // context; whether the close happened is the settle below's answer to give, not this call's.
    await overlay
      .evaluate(() => {
        ;(document.querySelector('button[aria-label="Close overlay"]') as HTMLElement | null)?.click()
      })
      .catch(() => undefined)
  } else {
    await bridge(page).toggle('xp')
  }
  const gone = await settle(() => windowsOfKind(app, 'xp'), (n) => n === 0, { timeoutMs: 20_000 })
  check('the close affordance actually closes the window', gone === 0, `${gone} still open`)
  const state = await settle(() => bridge(page).state(), (s) => s.xp === false, { timeoutMs: 10_000 })
  check('…and the app records it as closed, so the next launch does not bring it back', state.xp === false, JSON.stringify(state))
}

async function main(): Promise<void> {
  await buildIfStale()
  const { app, close, log } = await launchOnFixture('e2e-leveling.log')
  const page = await mainWindow(app)
  const consoleErrors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })

  try {
    await stepDefaultOff(page, app)
    const overlay = await stepOpenAndChrome(page, app)
    if (overlay) {
      overlay.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(`xp overlay: ${m.text()}`)
      })
      await stepHydratesFromTheFold(overlay)
      await stepSlice(overlay)
      await stepLiveMote(overlay, log)
      await stepRowChecklist(overlay)
    } else {
      note('the XP window never opened, so every claim about its contents was skipped')
    }
    await stepClose(page, app, overlay)

    check(
      'no renderer console errors in either window during the run',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | ')
    )
  } catch (err) {
    check('the spec ran to completion', false, String(err))
    await dumpArtifacts(page, 'xp-overlay')
  } finally {
    if (failures.length > 0) await dumpArtifacts(page, 'xp-overlay')
    await close()
  }
  reportRun()
}

void main()
