/**
 * Headless Electron smoke test for the TWO TIMER OVERLAYS (JOS-89, split into two windows by
 * JOS-119 — docs/plans/buff-timer-overlay.md).
 *
 * WHAT ONLY THE REAL APP CAN SHOW. The entry model is pinned on real fixture bytes in
 * tests/buffTimers.test.mts (the chain-mez, the honesty law, the death clear, and — since
 * JOS-119 — that the two surfaces PARTITION the rows); the ≤25 % geometry over every work area is
 * pinned in tests/overlayLayout.test.mts; the text-scale seam in tests/overlayTextScale.test.mts.
 * What no unit test can claim is that the PIECES ARE WIRED — that both kinds ship OFF, that each
 * toggles into a window of its own with labelled chrome and a close affordance, that the two
 * windows are genuinely INDEPENDENT (open, position and close, one without the other), and above
 * all that a mez cast into the LIVE LOG travels the whole real path (chokidar → Tailer →
 * parseEvent → BuffTimersModule → registry flush → `module:delta` → the overlay's own fan-out in
 * pipeline.ts → React) and comes out as a NAMED, PER-TARGET COUNTDOWN.
 *
 * That last one is the ticket JOS-89 shipped for. Ten user reports asked to chain-mez four or five
 * enemies and see a countdown per enemy; this spec casts one AE mez at two mobs in the running app
 * and reads the two rows back out of the DOM. JOS-119's ticket is the one beside it: those mez rows
 * now have to arrive on the DEBUFFS window and be ABSENT from the buffs one, which is asserted both
 * ways — a filter that shows the right rows here and the wrong ones there is still a bug.
 *
 * BOTH SHIP DEFAULT OFF, and every launch here gets a fresh userData dir — so this spec is always
 * a first run, which makes it the one place that can prove "off" is what a new install gets for
 * BOTH kinds. That is asserted BEFORE anything is toggled.
 *
 * NO WINDOW IS EVER SHOWN. `EQ_E2E=1` is the whole test mode (src/main/e2e.ts): the main window
 * never shows and overlays skip `showInactive`. So this spec drives the app's own bridges rather
 * than clicking — a hidden, always-on-top window has no pointer — and reads geometry out of the
 * MAIN process, because "it covered my screen" is a claim about bounds.
 *
 * WAIT FOR THE CONDITION, NEVER FOR THE CLOCK (wave E3): every read below goes through `settle`.
 *
 * Run: `npm run test:e2e -- buffs` (or `node --import tsx tests/e2e/buffs-overlay.e2e.mts`).
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
import { mainWindow, makeUserData, overlayWindow, removeUserData } from './appWindow.mjs'
import { launchOnFixture, stageFixture } from './logFixture.mjs'
import { stepNoTooltipsAnywhere, stepRowsHoverNothing } from './overlayTooltipSteps.mjs'
// THE COLD START WITH THE WINDOW ALREADY OPEN (JOS-172) — a second launch with a narrative of its
// own, so it lives beside the other step modules rather than inside this one's.
import { seedRestart, stepRestartRehydrate } from './buffRestartSteps.mjs'
// Reading a timer window's rows in EITHER arrangement (flat or per-target) lives beside the other
// e2e readers - see ./buffTimerSteps.mts.
import {
  setTimerGrouping as setGrouping,
  timerGroups as groups,
  timerRows as rows,
  timerTargets as targets
} from './buffTimerSteps.mjs'
// CLEARING A BAR BY HAND (JOS-203) — its own narrative, beside the other step modules.
import { stepDismissBar } from './buffDismissSteps.mjs'
// THE BUFFS THAT NEVER EXPIRE (JOS-215) — hidden by default, revealed by a per-window preference.
import { stepPermanentRows } from './buffPermanentSteps.mjs'
// THE TRACKING ALLOW-LIST (JOS-168) — the mode switch and the boxes on the Buffs TAB, filtering
// what this window draws. Its own narrative, and the only step here that drives both windows at
// once (the controls are in the app, the rows are over the game).
import { stepAllowList } from './buffAllowSteps.mjs'
// HOW SMALL THESE TWO WINDOWS GO (JOS-278). The report that lowered the floor was about the DEBUFF
// window specifically — a player magnifying the screen with Lossless Scaling — and these two carry
// the busiest footer of any kind, so they are where the floor is proved.
import { stepMinimumSize } from './overlayMinSizeSteps.mjs'
import type { FixtureLog } from './logFixture.mjs'

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

/**
 * THE CHAIN-MEZ, played into the live log.
 *
 * These are the real sentences, in the real shapes, conjugated exactly as the owner's own
 * `w10-cazic-slow.log` prints them — one `You begin casting Mesmerization III.` followed by the
 * per-mob landing broadcasts in the same second. The two mob names are ordinary Plane of Fear
 * trash from that same window. Stamped at ONE instant so the model's 10 s own-cast window is
 * satisfied exactly as it is in the log.
 */
function castChainMez(log: FixtureLog): void {
  const at = new Date()
  log.appendAt(at, 'You begin casting Mesmerization III.')
  log.appendAt(new Date(at.getTime() + 1000), 'a turmoil toad has been mesmerized.', 'a scareling has been mesmerized.')
}

/** The two timer kinds, and the chrome each one has to be wearing (JOS-119). */
const SURFACES = {
  buffs: {
    testid: 'buffs-overlay',
    tag: 'BUFFS',
    title: 'Buffs',
    empty: 'Watching for buffs you cast'
  },
  debuffs: {
    testid: 'debuffs-overlay',
    tag: 'DEBUFFS',
    title: 'Debuffs',
    empty: 'Watching for debuffs you land'
  }
} as const
type TimerKind = keyof typeof SURFACES
interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** How many windows the app currently has open on a given `?kind=`. */
async function windowsOfKind(app: ElectronApplication, kind: string): Promise<number> {
  let hit = 0
  for (const w of app.windows()) {
    const search = await w.evaluate(() => window.location.search).catch(() => '')
    // Exact match on the query: `kind=buffs` is a SUBSTRING of `kind=debuffs`, so a naive
    // `includes` would count the debuffs window as a buffs one and every independence
    // assertion below would pass for the wrong reason.
    if (new URLSearchParams(search).get('kind') === kind) hit++
  }
  return hit
}

async function stepDefaultOff(page: Page, app: ElectronApplication): Promise<void> {
  const state = await bridge(page).state()
  check(
    'a fresh install has BOTH timer overlays OFF (owner: validate internally first)',
    state.buffs === false && state.debuffs === false,
    JSON.stringify(state)
  )
  // …and no window for either exists, which is the part a stored flag alone could lie about.
  const spawned = app.windows().length
  const open = { buffs: await windowsOfKind(app, 'buffs'), debuffs: await windowsOfKind(app, 'debuffs') }
  check(
    '…and neither timer overlay window was spawned at startup',
    open.buffs === 0 && open.debuffs === 0,
    `${spawned} window(s) open, ${JSON.stringify(open)}`
  )
}

async function stepOpenAndChrome(page: Page, app: ElectronApplication, kind: TimerKind): Promise<Page | null> {
  const s = SURFACES[kind]
  const open = await bridge(page).toggle(kind)
  if (!check(`toggling ${kind} from the overlay menu reports it OPEN`, open === true)) return null

  const overlay = await overlayWindow(app, kind)
  if (!check(`…and a window for kind=${kind} really exists`, overlay !== null)) return null
  const o = overlay

  // LABELLED CHROME + A CLOSE AFFORDANCE — the JOS-83 conventions, in the DOM. The testid is
  // per kind, so this also proves the right COMPONENT mounted behind the right query.
  const surface = await settle(() => countOf(o, `[data-testid="${s.testid}"]`), (n) => n === 1, {
    timeoutMs: 20_000
  })
  check(`the ${kind} surface mounts`, surface === 1)
  const tag = await o.evaluate(() => document.body.innerText)
  check(`…with the labelled ${s.tag} chrome`, tag.includes(s.tag), tag.slice(0, 120))
  check('…and its title', tag.includes(s.title), tag.slice(0, 120))
  // Unlocked (both kinds' default), so the header's controls are real and reachable. The close
  // affordance is selected by the aria-label the shared IconButton already carries.
  check('…and a visible close control', (await countOf(o, 'button[aria-label="Close overlay"]')) === 1)
  check('…and the lock (click-through) control beside it', (await countOf(o, 'button[aria-label^="Lock"]')) === 1)

  // IT HYDRATES FROM THE REPLAY, and that is worth pinning on its own: opening the window mid
  // session must show what the model already holds, not an empty pane waiting for the next cast.
  // (The fixture's replay leaves real rows standing, so the quiet empty state is the OTHER
  // branch here — asserted as an either/or so this step states a fact about both.)
  // settleStable, not settle: there is no single condition to wait FOR here (either branch is a
  // pass), so the honest wait is "until the reading stops changing" — wave E3's rule for
  // asserting a steady state rather than betting on a clock.
  const first = await settleStable(() => rows(o), { timeoutMs: 20_000 })
  check(
    `the ${kind} window shows what the model already holds, or says it is watching — never a blank pane`,
    first.length > 0 || tag.includes(s.empty),
    `${first.length} row(s)`
  )
  if (kind === 'debuffs' && first.length > 0) {
    // PER-TARGET, out of the replay alone: a debuff you landed NAMES the enemy it is on, which is
    // the first half of what the reports asked for and, since JOS-119, the whole subject of this
    // window. Since JOS-140 the window opens FLAT (soonest to expire first, across every target),
    // so the enemy is a chip on the row rather than a heading above it — `targets` reads either,
    // which is what keeps this claim independent of the arrangement the user has chosen.
    const g = await targets(o)
    check(
      '…and a debuff you landed names the enemy it is on',
      g.some((x) => x !== 'Your buffs' && x !== 'On you' && x !== ''),
      JSON.stringify(g)
    )
  }
  return o
}

async function stepGeometry(app: ElectronApplication, overlay: Page, kind: TimerKind): Promise<void> {
  // Read from MAIN — the answer to "it covered my whole screen". The pure invariant is pinned per
  // work area in tests/overlayLayout.test.mts; this is the real window on the real display.
  const win = await app.browserWindow(overlay)
  const bounds = await win.evaluate((w) => w.getBounds())
  const area = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
  const share = (bounds.width * bounds.height) / (area.width * area.height)
  check(
    `the first-open ${kind} overlay is a small window, not a screen-filling one (≤25%)`,
    share < 0.25 && bounds.width < area.width && bounds.height < area.height,
    `${JSON.stringify(bounds)} on ${JSON.stringify(area)} (${(share * 100).toFixed(1)}%)`
  )
  check(
    '…and it starts on-screen',
    bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width,
    JSON.stringify(bounds)
  )
}

/**
 * TWO WINDOWS, PLACED SEPARATELY — the JOS-119 ticket, against the real app.
 *
 * Three separate claims, because three separate things could be shared by accident: the windows
 * do not open on top of each other (the reserved-slot layout), moving one does not move the other
 * (two real BrowserWindows), and each PERSISTS its own bounds under its own store key
 * (`overlays.<kind>`) rather than through a single shared config.
 */
async function stepIndependentBounds(
  app: ElectronApplication,
  buffsOverlay: Page,
  debuffsOverlay: Page
): Promise<void> {
  const buffsWin = await app.browserWindow(buffsOverlay)
  const debuffsWin = await app.browserWindow(debuffsOverlay)
  const before = {
    buffs: await buffsWin.evaluate((w) => w.getBounds()),
    debuffs: await debuffsWin.evaluate((w) => w.getBounds())
  }
  check(
    'the two windows open in two different places',
    before.buffs.x !== before.debuffs.x || before.buffs.y !== before.debuffs.y,
    JSON.stringify(before)
  )

  // Move ONLY the debuffs window, the way a user dragging it would — through the real window.
  const moved = { ...before.debuffs, x: before.debuffs.x - 60, y: before.debuffs.y - 40 }
  await debuffsWin.evaluate((w, b) => { w.setBounds(b) }, moved)

  const after = {
    buffs: await buffsWin.evaluate((w) => w.getBounds()),
    debuffs: await debuffsWin.evaluate((w) => w.getBounds())
  }
  check('moving the debuffs window moves the debuffs window', after.debuffs.x === moved.x, JSON.stringify(after.debuffs))
  check(
    '…and leaves the buffs window exactly where it was',
    after.buffs.x === before.buffs.x && after.buffs.y === before.buffs.y,
    `${JSON.stringify(before.buffs)} → ${JSON.stringify(after.buffs)}`
  )

  // …AND EACH REMEMBERS ITS OWN BOUNDS, under its own store key.
  //
  // The write goes through the overlay's OWN config bridge rather than by dragging the window,
  // and that is a measured choice, not a shortcut: `saveOverlayBounds` in windows.ts is installed
  // on the 'moved'/'resized' events, which Electron raises for a USER drag — a programmatic
  // `setBounds` from the main process does not raise them (measured here: the store stayed empty
  // after the move above), and an always-on-top window that is never shown has no pointer to drag
  // it with. `setConfig` is the same `overlay:setConfig` IPC that drag really lands on, carrying
  // the KIND the preload read from its own `?kind=` query — which is precisely the thing under
  // test: two windows, two keys, no shared slot.
  const setBounds = (o: Page, b: Bounds): Promise<unknown> =>
    o.evaluate(
      (bounds) =>
        (window as unknown as { eqOverlay: { setConfig: (p: unknown) => Promise<unknown> } }).eqOverlay.setConfig({
          bounds
        }),
      b
    )
  const cfgOf = (o: Page): Promise<Bounds | undefined> =>
    o.evaluate(() =>
      (window as unknown as { eqOverlay: { getConfig: () => Promise<{ bounds?: Bounds }> } }).eqOverlay
        .getConfig()
        .then((c) => c.bounds)
    )

  const buffsWant = { ...before.buffs, x: before.buffs.x - 130, y: before.buffs.y - 20 }
  const debuffsWant = { ...before.debuffs, x: before.debuffs.x - 240, y: before.debuffs.y - 90 }
  await setBounds(buffsOverlay, buffsWant)
  await setBounds(debuffsOverlay, debuffsWant)

  const savedBuffs = await settle(() => cfgOf(buffsOverlay), (b) => b?.x === buffsWant.x, { timeoutMs: 15_000 })
  const savedDebuffs = await settle(() => cfgOf(debuffsOverlay), (b) => b?.x === debuffsWant.x, { timeoutMs: 15_000 })
  check(
    'the buffs window persists its own bounds',
    savedBuffs?.x === buffsWant.x && savedBuffs.y === buffsWant.y,
    JSON.stringify(savedBuffs)
  )
  check(
    '…and the debuffs window persists a DIFFERENT set of its own',
    savedDebuffs?.x === debuffsWant.x && savedDebuffs.y === debuffsWant.y,
    JSON.stringify(savedDebuffs)
  )
  check(
    '…so neither write landed in the other kind’s slot',
    savedBuffs?.x !== savedDebuffs?.x,
    `${JSON.stringify(savedBuffs)} vs ${JSON.stringify(savedDebuffs)}`
  )
}

async function stepChainMez(overlay: Page, buffsOverlay: Page | null, log: FixtureLog): Promise<void> {
  castChainMez(log)

  // THE WHOLE POINT: one cast, two enemies, two rows. Wait for the MEZ rows specifically — the
  // window already carries the replay's buffs, so "some rows exist" would settle instantly and
  // assert nothing (it did, the first time this spec ran).
  const seen = await settle(
    () => rows(overlay),
    (r) => r.filter((x) => x.name.startsWith('Mesmerization')).length >= 2,
    { timeoutMs: 30_000 }
  )
  const cc = seen.filter((r) => r.name.startsWith('Mesmerization'))
  if (!check('one AE mez cast raises a row PER ENEMY', cc.length === 2, JSON.stringify(seen))) return

  // NAMED, not a family: "has been mesmerized." is four spells in the DB and the player's own
  // cast is what narrows it (JOS-84's law, end to end through the real parser).
  // NAMED, AND RANKED (JOS-140): the cast line is the only line in the family that carries a rank
  // — the landing sentence names no spell at all and the wear-off names the rank-less base — so
  // `Mesmerization III` on the row is the app saying which of your mezzes is on that mob.
  check(
    '…each row NAMES the spell, with the RANK the cast line spelled',
    cc.every((r) => r.name === 'Mesmerization III'),
    JSON.stringify(cc)
  )

  // COUNTING DOWN, because spells.json states Mesmerization at 24s.
  check('…and each counts DOWN from the stated duration', cc.every((r) => r.mode === 'countdown'), JSON.stringify(cc))
  check(
    '…showing a real remaining, never a negative or a blank',
    cc.every((r) => /^\d+s$/.test(r.time)),
    JSON.stringify(cc.map((r) => r.time))
  )
  check('…with a receding bar beside it', (await countOf(overlay, '[data-testid="buff-timer-fill"]')) >= 2)

  // PER-TARGET, and the targets are NAMED — the reports asked to see WHICH enemy. In the flat
  // arrangement this window now opens on, that name is a chip on the row.
  const named = await targets(overlay)
  check(
    '…each naming the enemy it is on',
    named.some((x) => x.includes('a turmoil toad')) && named.some((x) => x.includes('a scareling')),
    JSON.stringify(named)
  )

  // THE ARRANGEMENT IS A PREFERENCE (JOS-140, owner amendment). The default is the flat
  // soonest-first list above; switching to per-target blocks has to raise a HEADING per enemy over
  // exactly the same rows — a preference sorts, it never filters — and switching back removes them.
  await setGrouping(overlay, 'target')
  const blocked = await settle(() => groups(overlay), (g) => g.some((x) => x.includes('a turmoil toad')), {
    timeoutMs: 15_000
  })
  check('grouping by target raises a heading per enemy', blocked.some((x) => x.includes('a scareling')), JSON.stringify(blocked))
  const still = (await rows(overlay)).filter((r) => r.name.startsWith('Mesmerization'))
  check('…over exactly the same two rows', still.length === 2, JSON.stringify(still))
  await setGrouping(overlay, 'none')
  const flat = await settle(() => groups(overlay), (g) => g.length === 0, { timeoutMs: 15_000 })
  check('…and switching back takes the headings away again', flat.length === 0, JSON.stringify(flat))

  // …AND THE BUFFS WINDOW NEVER SAW IT (JOS-119). This is the half a one-sided filter would pass
  // while still being wrong: the mez arrived where it belongs AND stayed out of the other window.
  // settleStable, because the claim is an ABSENCE — wait for the reading to stop moving, then
  // assert nothing mez-shaped is there (wave E3's rule).
  if (buffsOverlay) {
    const onBuffs = await settleStable(() => rows(buffsOverlay), { timeoutMs: 15_000 })
    check(
      'the mez does NOT appear on the buffs window — the two surfaces do not overlap',
      !onBuffs.some((r) => r.name.startsWith('Mesmerization')),
      JSON.stringify(onBuffs.map((r) => r.name))
    )
  }
}

async function stepBreakClearsOneTarget(overlay: Page, log: FixtureLog): Promise<void> {
  // The break line for ONE of the two. The other must be untouched — that is the difference
  // between a per-target model and a single "mez is up" flag.
  log.append('Your Mesmerization spell has worn off of a scareling.')
  const after = await settle(
    () => rows(overlay),
    (r) => r.filter((x) => x.name.startsWith('Mesmerization')).length === 1,
    { timeoutMs: 30_000 }
  )
  const named = await targets(overlay)
  check('a break line clears ONLY its own target', !named.some((x) => x.includes('a scareling')), JSON.stringify(named))
  check(
    '…and the other enemy keeps its countdown',
    after.some((r) => r.name === 'Mesmerization III' && r.mode === 'countdown'),
    JSON.stringify(after)
  )
}

/**
 * "Flash/alert when a positive spell drops" — one of the ten reports' asks.
 *
 * `Your valor fades.` is Valor's own wears-off message and, measured against the committed
 * spells.json, it is UNIQUE to it (the other two self buffs the fixture leaves standing are not:
 * `The mystic symbol fades.` is six spells and `Your illusion fades.` is twenty-seven). So this
 * is the one self buff in this window whose drop the log can name without ambiguity, which makes
 * it the honest one to assert on.
 *
 * The flash is renderer state over rows the window already holds, so it can only ever fire on a
 * removal the MODEL believed — never on a guess.
 */
async function stepDropFlash(overlay: Page, debuffsOverlay: Page | null, log: FixtureLog): Promise<void> {
  // Raise it LIVE rather than borrowing one from the replay: every line this spec appends is
  // ~30 minutes of event time after the fixture's last, so the replayed actives are all long
  // past their duration and none of them can stand in for a buff you just cast.
  //
  // THEY ARE STILL ON SCREEN WHILE THIS RUNS, and that is the JOS-134 behaviour rather than a
  // leak: a log hole no longer wipes the model on sight. It waits for a login to explain it,
  // because the wipe used to beat the `offlineGap` that pauses the buffs EQ froze with your
  // character. Since JOS-262 the wait ends on EVIDENCE rather than on a timer, and the line
  // below is evidence — `You begin casting Valor.` could only have been printed for this
  // character, and no `Welcome to EverQuest Legends!` came first — so the hole is ruled
  // unexplained as this step appends, and the fixture's pre-hole rows go with it.
  //
  // Which means the fixture's OWN long-dead Valor is sitting in the list beside the one we are
  // about to cast, under the same name, and `find(name === 'Valor')` would happily return it (it
  // did, and asserted "counts down" about a row reading 0s). A remaining time is the thing that
  // tells them apart, so it is what selects the row.
  const at = new Date()
  log.appendAt(at, 'You begin casting Valor.')
  log.appendAt(new Date(at.getTime() + 1000), 'You feel valorous.')

  const fresh = (r: { name: string; time: string }): boolean => r.name === 'Valor' && r.time !== '0s'
  const up = await settle(() => rows(overlay), (r) => r.some(fresh), { timeoutMs: 30_000 })
  const valor = up.find(fresh)
  if (!check('a self buff you cast raises a row of your own', valor !== undefined, JSON.stringify(up))) {
    return
  }
  // 54 minutes is what spells.json states for Valor, so it counts DOWN — the self-buff bar with
  // a receding timer the reports asked for.
  check('…counting DOWN from the duration spells.json states', valor?.mode === 'countdown', JSON.stringify(valor))
  check('…under Your buffs', (await groups(overlay)).includes('Your buffs'))

  // The mirror of the mez assertion: a self buff belongs on the BUFFS window and must not turn up
  // on the debuffs one. Together the two make the split a partition rather than a coincidence.
  if (debuffsOverlay) {
    const onDebuffs = await settleStable(() => rows(debuffsOverlay), { timeoutMs: 15_000 })
    check(
      'a self buff does NOT appear on the debuffs window',
      !onDebuffs.some((r) => r.name === 'Valor'),
      JSON.stringify(onDebuffs.map((r) => r.name))
    )
  }

  log.append('Your valor fades.')
  const after = await settle(() => rows(overlay), (r) => !r.some((x) => x.name === 'Valor'), { timeoutMs: 30_000 })
  check('a wears-off message clears the buff it names', !after.some((r) => r.name === 'Valor'), JSON.stringify(after.map((r) => r.name)))
  const flashed = await settle(
    () => overlay.evaluate(() => [...document.querySelectorAll('[data-testid="buff-timer-drop"]')].map((e) => e.textContent?.trim() ?? '')),
    (t) => t.length > 0,
    { timeoutMs: 10_000 }
  )
  check('…and the overlay FLASHES that a positive spell dropped', flashed.some((t) => t.includes('Valor')), JSON.stringify(flashed))
  // NO TWO NOTICES READ THE SAME. The first cut printed "Valor dropped" twice — not a duplicate
  // but two REAL drops (the fixture has Valor up on the player AND on a fire giant warrior) that
  // the line could not tell apart, because it named the spell and not the target.
  check(
    '…and no two drop notices are indistinguishable',
    new Set(flashed).size === flashed.length,
    JSON.stringify(flashed)
  )
  check('…the self drop naming just the spell', flashed.includes('Valor dropped'), JSON.stringify(flashed))
}

/**
 * Close ONE window the way a user would — its own ✕ — and prove the other one is still standing.
 * That is the enable/disable half of "two windows you place separately": a shared close, or a
 * shared open-state flag, would take both down here.
 */
async function stepCloseOne(
  page: Page,
  app: ElectronApplication,
  overlay: Page | null,
  { kind, other }: { kind: TimerKind; other: TimerKind }
): Promise<void> {
  if (overlay) {
    // THE CLICK DESTROYS THE PAGE IT IS EVALUATED IN, so the evaluate itself is allowed to lose
    // its context — observed once here: "at stepCloseOne … log: []", a Playwright rejection from a
    // window that closed before it could answer. Whether the close HAPPENED is not this call's
    // answer to give; the settle below is, and it asks main how many windows of this kind are
    // left. Swallowing the rejection weakens no assertion and removes a race the spec never meant
    // to be running.
    await overlay
      .evaluate(() => {
        ;(document.querySelector('button[aria-label="Close overlay"]') as HTMLElement | null)?.click()
      })
      .catch(() => undefined)
  } else {
    await bridge(page).toggle(kind)
  }
  const gone = await settle(() => windowsOfKind(app, kind), (n) => n === 0, { timeoutMs: 20_000 })
  check(`the ${kind} close affordance actually closes its window`, gone === 0, `${gone} still open`)
  // …and main recorded it, so the next launch does not bring it back uninvited.
  const state = await settle(() => bridge(page).state(), (s) => s[kind] === false, { timeoutMs: 10_000 })
  check(`…and the app records ${kind} as closed`, state[kind] === false, JSON.stringify(state))
  // THE INDEPENDENCE CLAIM: closing one did not close the other.
  check(`…while the ${other} window is untouched and still open`, state[other] === true, JSON.stringify(state))
  check(`…and its window really is still there`, (await windowsOfKind(app, other)) === 1)
}

/** Close whatever is left, so the run ends with both kinds off and both windows gone. */
async function stepCloseRest(page: Page, app: ElectronApplication, kind: TimerKind): Promise<void> {
  await bridge(page).toggle(kind)
  const gone = await settle(() => windowsOfKind(app, kind), (n) => n === 0, { timeoutMs: 20_000 })
  check(`the ${kind} window closes from the menu too`, gone === 0, `${gone} still open`)
  const state = await settle(() => bridge(page).state(), (s) => s[kind] === false, { timeoutMs: 10_000 })
  check('…and both timer overlays end the run closed', state.buffs === false && state.debuffs === false, JSON.stringify(state))
}

async function main(): Promise<void> {
  await buildIfStale()
  // A dir shared by this spec's TWO launches and nothing else (the overlay-sync precedent): the
  // JOS-172 step is about an overlay whose open-state SURVIVED a quit, so launch 2 has to start
  // from the install launch 1 left behind. ONE staged log for both, so launch 2 re-folds exactly
  // what launch 1 played into it.
  const userData = makeUserData()
  const log = stageFixture('e2e-overlay.log')
  const { app, close } = await launchOnFixture(log, { userData })
  const page = await mainWindow(app)
  const consoleErrors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })

  try {
    await stepDefaultOff(page, app)

    // TWO SEPARATE TOGGLES, one after the other — the first must not bring the second with it.
    const buffsOverlay = await stepOpenAndChrome(page, app, 'buffs')
    const afterBuffs = await bridge(page).state()
    check(
      'opening the buffs window leaves the debuffs one closed — two switches, not one',
      afterBuffs.debuffs === false && (await windowsOfKind(app, 'debuffs')) === 0,
      JSON.stringify(afterBuffs)
    )
    const debuffsOverlay = await stepOpenAndChrome(page, app, 'debuffs')
    const bothOpen = await bridge(page).state()
    check(
      '…and opening the debuffs window leaves the buffs one open beside it',
      bothOpen.buffs === true && bothOpen.debuffs === true,
      JSON.stringify(bothOpen)
    )

    for (const [kind, o] of [['buffs', buffsOverlay] as const, ['debuffs', debuffsOverlay] as const]) {
      if (!o) continue
      o.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(`${kind} overlay: ${m.text()}`)
      })
      await stepGeometry(app, o, kind)
      // BEFORE stepIndependentBounds, which moves these windows and then asserts on where they
      // ended up: this step resizes and puts the rectangle back, so it must not be interleaved
      // with the one that owns the positions.
      await stepMinimumSize(app, o, kind, `the ${kind} window`)
    }

    if (buffsOverlay && debuffsOverlay) await stepIndependentBounds(app, buffsOverlay, debuffsOverlay)

    if (debuffsOverlay) {
      await stepChainMez(debuffsOverlay, buffsOverlay, log)
      // JOS-358, on the two rows that step just raised and before anything clears them. One of them
      // is the ambiguous shape whose shared-landing candidate list used to BE the row's hover.
      await stepRowsHoverNothing(debuffsOverlay, 'buff-timer-row')
      await stepNoTooltipsAnywhere(debuffsOverlay, 'the debuffs window')
      await stepBreakClearsOneTarget(debuffsOverlay, log)
      // …and the bar the break line SPARED is the one the user clears by hand (JOS-203).
      await stepDismissBar(debuffsOverlay, log)
    } else {
      note('the debuffs overlay window never appeared — the mez assertions could not run')
    }
    if (buffsOverlay) {
      await stepDropFlash(buffsOverlay, debuffsOverlay, log)
      // AFTER the drop flash, deliberately: that step's assertions are about the notices on screen,
      // and this one toggles a preference that removes rows. Running it first would put a second
      // set of notices in front of it if the epoch guard ever regressed — which is a thing this
      // step should FAIL on, not a thing it should hide from the step next door.
      await stepPermanentRows(buffsOverlay, log)
      // AFTER the permanent step, for its own reason: that step leaves `showPermanent` back OFF,
      // so the rows this one counts are the ordinary timed ones. It also runs after the drop flash
      // deliberately — this step's quiet-window claim is that IT raised no notices, and it reads
      // the ones already on screen as its baseline rather than requiring an empty one.
      await stepAllowList(page, buffsOverlay, log)
    } else {
      note('the buffs overlay window never appeared — the self-buff assertions could not run')
    }

    await stepCloseOne(page, app, buffsOverlay, { kind: 'buffs', other: 'debuffs' })
    await stepCloseRest(page, app, 'debuffs')

    // LAST, because it re-opens both windows and leaves them that way: launch 2 (JOS-172) is a
    // COLD START with them already on screen, which is the one arrangement every step above
    // cannot be in.
    await seedRestart(page, app, log)

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    if (failures.length) await dumpArtifacts(page, 'buffs-overlay-FAIL')
  } finally {
    await close()
  }

  // Its own launch, on the dir launch 1 wrote: an overlay that was ALREADY OPEN when the app
  // started cannot be observed in a process that is already running.
  await stepRestartRehydrate(log, userData)
  await removeUserData(userData)
  await log.dispose()

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  note('the buffs/debuffs overlay spec did not complete')
  process.exitCode = 1
})
