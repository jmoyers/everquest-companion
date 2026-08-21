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
import { stepNoTooltipsAnywhere, stepRowsHoverNothing } from './overlayTooltipSteps.mjs'

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
  // The span NAMES its hour, whichever one is in force (JOS-288 — it was `active` unconditionally
  // before the elapsed default). What this step is about is that a wired window states a
  // denominator at all; which one it opens on is `stepRateBasis`'s claim, below.
  check('…under one span that says what every rate on it divides by', /elapsed|active/.test(caption), caption)
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
  // 'motes' covers however many tiers dropped (shared/xpOverlay.ts states the rule). The
  // denominator toggle beside them is `xp-basis` and deliberately does NOT share this prefix — it
  // switches an hour, not a row, and a selector that swept it up would be counting two things.
  check('the checklist offers one toggle per entry', (await countOf(overlay, '[data-testid^="xp-toggle-"]')) === 3)
  check('…and the denominator toggle sits beside them, outside the row prefix', (await countOf(overlay, '[data-testid="xp-basis"]')) === 1)

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
 * THE DEFAULT IS `Zone + Session` SINCE JOS-288 (owner ruling — it was `session` from JOS-195 until
 * then). e2e-leveling.log states no logout anywhere, so this record can define neither half's
 * session, and the default must therefore resolve to the whole log rather than to an invented
 * boundary — which is the SAME observable this step has always asserted, now standing on a
 * two-part degrade rather than a one-part one. The unit suite pins the offered/degrades pair over a
 * record that CAN define both halves; what only the real app can show is that the shipped default
 * travels main's own store and the renderer's own resolve and comes out honest on a first run.
 *
 * Then a duration rung proves the pick really re-scopes the numbers rather than only re-labelling.
 */
async function stepSlice(overlay: Page): Promise<void> {
  const opened = await settleStable(() => span(overlay), { timeoutMs: 15_000 })
  check(
    'a log that states no logout can define neither half of Zone + Session, so the window opens on the whole log',
    opened.includes('the whole log'),
    opened
  )
  const stored = await getConfig(overlay)
  check(
    '…and the default is ABSENT in the store rather than written out',
    stored.xpSlice === undefined,
    JSON.stringify(stored.xpSlice)
  )

  await setConfig(overlay, { xpSlice: 'h1' })
  const narrowed = await settle(() => span(overlay), (t) => t !== opened, { timeoutMs: 15_000 })
  check('picking a narrower slice re-words the caption', narrowed.includes('1h'), narrowed)
  check('…and re-measures the span every rate divides by', narrowed !== opened, `${opened} → ${narrowed}`)

  await setConfig(overlay, { xpSlice: 'all' })
  const back = await settle(() => span(overlay), (t) => t === opened, { timeoutMs: 15_000 })
  check('…and going back to the whole log restores it exactly', back === opened, `${narrowed} → ${back}`)
}

/** The footer's denominator toggle, as the DOM carries it. */
function basisButton(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector('[data-testid="xp-basis"]')?.getAttribute('data-basis') ?? ''
  )
}

/** Write through a window's SCOPE bridge — the app-wide pair (JOS-332). Both preloads carry the
 *  same member under the same name, which is what makes this one helper serve both windows. */
function setScope(page: Page, patch: Record<string, unknown>, bridge: 'eq' | 'eqOverlay'): Promise<void> {
  return page.evaluate(
    ([b, p]) =>
      (window as unknown as Record<string, { setScopeSelection: (x: unknown) => void }>)[
        b as string
      ].setScopeSelection(p),
    [bridge, patch] as const
  )
}

/** Read a window's SCOPE bridge. Same member, same name, either side. */
function getScope(page: Page, bridge: 'eq' | 'eqOverlay'): Promise<Record<string, string>> {
  return page.evaluate(
    (b) =>
      (window as unknown as Record<string, { getScopeSelection: () => Promise<Record<string, string>> }>)[
        b
      ].getScopeSelection(),
    bridge
  )
}

/**
 * WHICH HOUR THE RATES ARE PER, END TO END (JOS-288, owner ruling 3; re-homed by JOS-332).
 *
 * `tests/xpOverlay.test.mts` pins the arithmetic of both readings and `shared/rateBasis.ts` owns the
 * default. What only the real app can show is that the knob is wired at all: that the window opens
 * on `elapsed`, that the footer states the hour in force, that flipping it re-measures every rate
 * AND the span line, and that main's rebuild-not-trust normalizer refuses a denominator this build
 * cannot name.
 *
 * IT IS NO LONGER THIS WINDOW'S PERSISTED KNOB. `xpBasis` was retired with `xpZoneScope` (JOS-332):
 * the Leveling tab draws the same two controls, and while each side kept a copy the reader had no
 * way to tell which one the numbers obeyed. So the flips below go through the app-wide bridge — the
 * same call the footer button now makes — and `stepScopeParity` proves the other window hears them.
 */
async function stepRateBasis(overlay: Page): Promise<void> {
  check('the window opens on the elapsed hour', (await basisButton(overlay)) === 'elapsed')
  const opened = await settleStable(() => span(overlay), { timeoutMs: 15_000 })
  check('…and the span line names that hour, once, for every row', opened.includes('elapsed'), opened)
  const fresh = await getConfig(overlay)
  check(
    '…and the retired per-window key is gone from the store, not merely unset',
    fresh.xpBasis === undefined,
    JSON.stringify(fresh.xpBasis)
  )

  await setScope(overlay, { basis: 'active' }, 'eqOverlay')
  const flipped = await settle(() => span(overlay), (t) => t.includes('active'), { timeoutMs: 15_000 })
  check('flipping to active time re-words the span', flipped.includes('active'), `${opened} → ${flipped}`)
  check('…and the footer button follows it', (await basisButton(overlay)) === 'active')
  check(
    '…and it never lands in this window’s persisted config',
    (await getConfig(overlay)).xpBasis === undefined
  )

  // Nothing can name an hour this build does not have — the closed union, through the real IPC and
  // the real normalizer in main (the `xpRows` rule, applied to a knob that now crosses a channel).
  await setScope(overlay, { basis: 'wall' }, 'eqOverlay')
  const held = await getScope(overlay, 'eqOverlay')
  check('an unknown denominator is dropped by main rather than applied', held.basis === 'active', JSON.stringify(held))
  check('…and a rejected patch is a NO-OP, not a reset to the opening', (await basisButton(overlay)) === 'active')

  await setScope(overlay, { basis: 'elapsed' }, 'eqOverlay')
  const restored = await settle(() => span(overlay), (t) => t === opened, { timeoutMs: 15_000 })
  check('…and going back to the elapsed hour restores the line exactly', restored === opened, restored)
}

/** The footer's membership toggle, as the DOM carries it. '' when it is not mounted at all. */
function tierButton(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector('[data-testid="xp-tier"]')?.getAttribute('data-scope') ?? '')
}

/**
 * THIS TIER, OR EVERY TIER OF THE ZONE, END TO END (JOS-291).
 *
 * `tests/timeslice.test.mts` pins the two folds and `tests/progressionWindows.test.mts` pins them
 * over the real `The Plane of Hate - Solo 1 (Awakened)` / `- Solo 2 (Adaptive)` pair. What only the
 * real app can show is the fourth persisted knob wired end to end: that the control is absent while
 * the slice names no zone, that it appears with the default when one does, that the SPAN LINE names
 * the membership in force (the honesty rule — a caption reading `Nagafen's Lair` over numbers that
 * counted `Nagafen's Lair - Solo 3 (Fused)` is the defect this option was filed for), that flipping
 * it re-measures, and that main's rebuild-not-trust normalizer refuses a membership this build
 * cannot apply.
 *
 * e2e-leveling.log is the right fixture by accident of the owner's own play: it names five
 * spellings of ONE camp (plain `Nagafen's Lair` plus four `- Solo N (…)` tiers), so the two
 * memberships have genuinely different answers here.
 */
async function stepZoneScope(overlay: Page): Promise<void> {
  check('a slice that names no zone offers no membership toggle', (await tierButton(overlay)) === '')

  await setConfig(overlay, { xpSlice: 'zone' })
  const exact = await settle(() => span(overlay), (t) => t.includes('tier'), { timeoutMs: 15_000 })
  // THE OPENING IS THIS TIER (owner ruling, JOS-332) — it was `allTiers` here until today.
  check('picking Zone brings the membership toggle out, on THIS TIER', (await tierButton(overlay)) === 'exactTier')
  check(
    '…and the span line NAMES what that membership admitted, rather than only the current tier',
    /this tier only/.test(exact),
    exact
  )
  check(
    '…while the checklist prefix still selects rows only',
    (await countOf(overlay, '[data-testid^="xp-toggle-"]')) === 3,
    'the tier toggle is `xp-tier`, deliberately outside the row prefix'
  )

  await setScope(overlay, { zoneScope: 'allTiers' }, 'eqOverlay')
  const every = await settle(() => span(overlay), (t) => t.includes('every tier'), { timeoutMs: 15_000 })
  check('flipping to every tier re-words the caption', every.includes('every tier'), `${exact} → ${every}`)
  check('…and the footer button follows it', (await tierButton(overlay)) === 'allTiers')
  check(
    '…and the span itself is re-measured, because the other tiers of the camp are back in',
    every !== exact,
    `${exact} → ${every}`
  )
  check(
    '…and none of it lands in this window’s persisted config any more',
    (await getConfig(overlay)).xpZoneScope === undefined
  )

  // Nothing can name a membership this build cannot apply — the closed union, through the real IPC
  // and the real normalizer in main (the `xpRows` rule, applied to a knob that crosses a channel).
  await setScope(overlay, { zoneScope: 'everyTier' }, 'eqOverlay')
  const held = await getScope(overlay, 'eqOverlay')
  check('an unknown membership is dropped by main rather than applied', held.zoneScope === 'allTiers', JSON.stringify(held))
  const restored = await settle(() => span(overlay), (t) => t === every, { timeoutMs: 15_000 })
  check('…so the window holds the read it had, rather than degrading to a blank', restored === every, restored)

  // Back to the OPENING before leaving: the selection is app-wide now, so a step that walks away
  // from it having moved it hands the next step a state it did not ask for (this one did exactly
  // that to `stepScopeParity` on the first run of this file).
  await setScope(overlay, { zoneScope: 'exactTier' }, 'eqOverlay')
  await settle(() => tierButton(overlay), (s) => s === 'exactTier', { timeoutMs: 15_000 })

  // Back to the whole log for the steps below, and the toggle goes away with the zone it was about.
  await setConfig(overlay, { xpSlice: 'all' })
  const back = await settle(() => tierButton(overlay), (s) => s === '', { timeoutMs: 15_000 })
  check('…and it leaves again with the zone half it was about', back === '')
}

/**
 * THE TWO WINDOWS ARE ONE ANSWER (JOS-332) — the ticket's own third part, and the reason the other
 * two steps above stopped writing to this window's config.
 *
 * THE REPORT: *with this tier selected on Leveling, the numbers still cover every tier* — the owner
 * had `this tier` on screen and read the every-tier `elapsed 27m`. The arithmetic was never wrong
 * (tests/zoneScope.test.mts replays his scenario and pins the narrowed denominator); the membership
 * was simply TWO STATES, one in a module variable in the main renderer and one persisted per
 * overlay window, with no channel between them.
 *
 * `tests/scopeSelection.test.mts` pins the seam in source — main owns it, both preloads carry the
 * same three members, one hook reads them. What only two real windows can show is the round trip:
 * a value written in one process reaching the OTHER process's rendered DOM. So this step drives
 * each direction from a different window and reads the effect in the far one:
 *
 *   • MAIN → OVERLAY, read as pixels: the flip is made on the main window's bridge and the
 *     floating window's own footer button and span line follow it. This is the direction the
 *     owner's defect ran, and it is the one with a rendered assertion on the receiving end.
 *   • OVERLAY → MAIN, read as state: the flip is made on the overlay's bridge and the MAIN
 *     window's bridge reports it. `leveling.e2e.mts` carries the rendered half of this direction
 *     (`checkTierScopedElapsed` drives the bridge and watches the tab's own row and elapsed span
 *     move), because this spec never navigates the main window to the Leveling tab.
 *
 * It runs on the `zone` slice, because a membership with no zone in it is not a control.
 */
async function stepScopeParity(page: Page, overlay: Page): Promise<void> {
  await setConfig(overlay, { xpSlice: 'zone' })
  // STATE THE PRECONDITION RATHER THAN INHERIT IT. The selection is app-wide, so what the earlier
  // steps left behind is not this step's subject — it puts both windows on a known membership and
  // then measures the round trip. (Inheriting it is the mistake this comment is paying for.)
  await setScope(overlay, { zoneScope: 'exactTier' }, 'eqOverlay')
  const opened = await settle(() => tierButton(overlay), (s) => s === 'exactTier', { timeoutMs: 15_000 })
  check('the floating window is on this tier, with a zone to apply it to', opened === 'exactTier', opened)
  const mainOpen = await getScope(page, 'eq')
  check(
    'and the MAIN window already agrees — there is one value, and main is holding it',
    mainOpen.zoneScope === 'exactTier',
    JSON.stringify(mainOpen)
  )

  // ── MAIN → OVERLAY, on the far window's pixels ──
  const before = await settleStable(() => span(overlay), { timeoutMs: 15_000 })
  await setScope(page, { zoneScope: 'allTiers' }, 'eq')
  const moved = await settle(() => tierButton(overlay), (s) => s === 'allTiers', { timeoutMs: 15_000 })
  check('a flip in the MAIN window moves the floating window’s own button', moved === 'allTiers', moved)
  const widened = await settle(() => span(overlay), (t) => t.includes('every tier'), { timeoutMs: 15_000 })
  check(
    '…and its span line, which is the number the report was about',
    widened !== before && widened.includes('every tier'),
    `${before} → ${widened}`
  )

  // ── OVERLAY → MAIN, on the far window's state ──
  await setScope(overlay, { zoneScope: 'exactTier' }, 'eqOverlay')
  const heard = await settle(() => getScope(page, 'eq'), (s) => s.zoneScope === 'exactTier', { timeoutMs: 15_000 })
  check('and a flip in the FLOATING window is heard by the main one', heard.zoneScope === 'exactTier')
  const narrowed = await settle(() => span(overlay), (t) => t === before, { timeoutMs: 15_000 })
  check('…restoring the narrowed span byte for byte', narrowed === before, `${widened} → ${narrowed}`)

  // THE HOUR TRAVELS THE SAME WIRE, and the halves are independent: moving one must not move the
  // other, or a reader flipping the tier would silently re-divide every rate on both surfaces.
  await setScope(page, { basis: 'active' }, 'eq')
  const hour = await settle(() => basisButton(overlay), (b) => b === 'active', { timeoutMs: 15_000 })
  check('the DENOMINATOR travels the same wire', hour === 'active')
  check('…and moving one half leaves the other exactly where it was', (await tierButton(overlay)) === 'exactTier')
  await setScope(page, { basis: 'elapsed' }, 'eq')
  await settle(() => basisButton(overlay), (b) => b === 'elapsed', { timeoutMs: 15_000 })

  // Back to the whole log, so the steps after this see the state they expect.
  await setConfig(overlay, { xpSlice: 'all' })
  await settle(() => tierButton(overlay), (s) => s === '', { timeoutMs: 15_000 })
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
      // AFTER the fold, so there are real rows to have (or not have) a hover (JOS-358; the title
      // bar's own tooltips went too on 2026-08-16, so there is no longer a pin popup to dismiss).
      await stepRowsHoverNothing(overlay, 'xp-row-xp')
      await stepNoTooltipsAnywhere(overlay, 'the XP window')
      await stepSlice(overlay)
      await stepRateBasis(overlay)
      await stepZoneScope(overlay)
      // AFTER both knob steps, because it is the claim they now depend on: the two windows are
      // reading one value (JOS-332). It leaves the slice back on `all`, as they do.
      await stepScopeParity(page, overlay)
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
