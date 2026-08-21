/**
 * Headless Electron spec for JOS-383 — A CON PUTS A CARD ON THE SCREEN.
 *
 * WHAT ONLY THE REAL APP CAN SHOW. The pure halves are pinned elsewhere: the chips, the drop
 * ranking, the two refusals and the auto-hide knob in tests/conCard.test.mts, the queue's timing in
 * tests/toastQueue.test.mts, the estimator in tests/resistModel.test.mts, and the "no migration
 * needed" claim in tests/storeMigrationsConCard.test.mts. What no unit test can claim is that THE
 * PIECES ARE WIRED, and the wiring here spans a log file, a parser, three modules, a store and two
 * renderers:
 *
 *   1. A FRESH INSTALL ALREADY HAS THE WINDOW. This kind is the first strip to ship ON, and a
 *      default is a claim about a window that either exists or does not. Every launch gets a fresh
 *      userData dir, so this spec is always a first run — which makes it the only place that can
 *      prove the presence.
 *   2. A `/con` WRITTEN INTO THE LIVE LOG DRAWS THE CARD. The line goes down the whole real path
 *      (chokidar → Tailer → parseWorld → ConsiderModule → main/conCard.ts → the overlay window),
 *      and comes out as a named card with the level the line stated and its resist chips. Playing
 *      the line is the point: nothing in the fixture's history may draw a card, because a startup
 *      replay of a month of logs must not fire hundreds of them.
 *   3. THE CHIPS IT KEEPS, COLOUR AND WORD AND TAG — and NO ACRONYM anywhere on the card.
 *   4. THE CARD IS A LINK (JOS-390): clicking it anywhere but the × opens that creature's page in
 *      the APP — a claim that spans two renderers, main's `focusView` and the app's router — and
 *      the card stays up. Clicking the × instead closes it and navigates NOTHING. And unlocked,
 *      where a click is the user dragging the window, a click navigates nothing either.
 *   5. THE NEXT CON REPLACES IT. One card, never a stack.
 *   6. A PLAYER GETS NO CARD, from a con line that is the same shape on the same faction rung.
 *   7. THE × CLOSES IT, AND A RE-CON DOES NOT PUT IT BACK. The close is local and the suppression
 *      is main's; only a real round trip can show them agreeing.
 *   8. THE DEFAULT AUTO-HIDE LEAVES BY ITSELF, in about the three seconds the owner ruled
 *      (JOS-388 measured five here; JOS-390 is the ruling that made it three).
 *   9. THE PREFERENCE TURNS IT OFF, and the window goes with it.
 *
 * WHAT LEFT THIS SPEC IN JOS-390: every drop assertion. The card no longer carries a drop table —
 * the mob page does, and claim 4 is the click that opens it — so `stepDrops` went with the feature
 * rather than being rewritten. Its second job is the one thing that had to be replaced: it was the
 * spec's WAIT for main's second pass (the client spell table arriving), and that wait now lives in
 * the chip steps next door, on the creature that actually grows chips.
 *
 * THE HOLD IS PINNED FOR CLAIMS 2-7 AND ONLY FOR THEM. The shipped auto-hide is 3 s and this
 * gauntlet takes minutes, so the spec sets the card's own knob to "until I close it" before the
 * first `/con` (stepPinTheHold) — a real user's setting, written through Preferences' own door,
 * never an inflated default. Claim 8 puts the knob back and measures what an untouched install
 * actually does. See stepPinTheHold and stepDefaultHideLeaves for both halves of that argument.
 *
 * NO WINDOW IS EVER SHOWN. `EQ_E2E=1` is the whole test mode (src/main/e2e.ts): the main window
 * never shows and overlays skip `showInactive`, so the card here is created, loaded and driven
 * entirely off-screen. That is also why the DOM is asserted rather than the animation.
 *
 * THE SPELLS CARVE-OUT, exactly as tests/e2e/mob-resists.e2e.mts takes it: the resist estimate joins
 * the client's own `spells_us.txt`, which this repo may not carry, so the harness links the real
 * install's copy in (`{ spells: true }`). On a machine with no EverQuest the chips are still five
 * and still say a word each — they simply say "no data", which is the app's honest degraded branch
 * and a supported configuration in its own right.
 *
 * Run: `npm run test:e2e -- con-card`.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import {
  ARTIFACTS,
  buildIfStale,
  check,
  dumpArtifacts,
  failures,
  note,
  reportRun,
  settle,
  settleStable,
  waitHydrated
} from './appHarness.mjs'
import { mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
import { launchOnFixture, stageFixture, type FixtureLog } from './logFixture.mjs'
// The RESIST-CHIP steps and the LINK steps live next door, because this spec is at the repo's
// max-lines budget and the rule is SPLIT, never ratchet. Each carries its own argument in its
// header: the chips' two creatures, and the click that made the card a lily pad (JOS-390).
import { stepNotableChips, stepResistantChip } from './conCardChipSteps.mjs'
import {
  stepClickOpensTheMobPage,
  stepCloseDoesNotNavigate,
  stepNoDropsOnTheCard,
  stepUnlockedClickDoesNotNavigate
} from './conCardLinkSteps.mjs'

const CARD = '[data-testid="con-card"]'
const NAME = '[data-testid="con-card-name"]'
const FACTS = '[data-testid="con-card-facts"]'
/** The box the renderer measures for the window fit (JOS-386): the drag frame + the scaled card. */
const FIT = '[data-testid="con-card-fit"]'


/**
 * ConCardOverlay's root inset, on each side, spelled out rather than imported: an e2e file loads no
 * `src` module (overlayMinSizeSteps.mts states that rule for `MIN_W`/`MIN_H`). A change to `PAD`
 * that forgets this line fails loudly here.
 */
const PAD = 6
/** A window is whole pixels and a layout box is not; the fit rounds UP, so allow a pixel either way. */
const FIT_SLACK = 2
/**
 * `OVERLAY_MIN_SIZE.height` from src/main/overlayLayout.ts, spelled out for the reason `PAD` is.
 *
 * IT STARTED MATTERING IN JOS-390, and that is a finding worth the line: with the drops and the
 * respawn off the card, a plain "no notable resists" card MEASURES 86px and the smallest window
 * any overlay kind may be is 90 — it is the BrowserWindow's own `minHeight` (windows.ts), so
 * Electron clamps `setBounds` whatever main asks for, and `fittedOverlayHeight` clamps to the same
 * number precisely so main never believes a height the window does not have. So "the window IS the
 * card" is true down to this floor and no further, and a four-pixel apron under the shortest
 * possible card is a window-system fact rather than the empty apron JOS-386 was about (that one was
 * a 300px strip around a handful of rows). Asserted as the floor rather than quietly widened.
 */
const MIN_WINDOW_H = 90

/** What the window may actually become for a card that measured `want` px — the floor is real. */
function fittedTo(want: number): number {
  return Math.max(want, MIN_WINDOW_H)
}

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** The two bridges this spec reaches through, named the way every other e2e names them: the page's
 *  own globals are not in this file's types, so each call spells the shape it uses. */
interface OverlayBridge {
  setConfig: (patch: { textScale: number }) => Promise<unknown>
}
interface GraphicsBridge {
  setGraphicsPrefs: (patch: Record<string, string>) => Promise<{ opaqueOverlays: string }>
  getOverlayState: () => Promise<Record<string, boolean>>
  toggleOverlay: (kind: string) => Promise<unknown>
}
/** The auto-hide's door, and the ONE Preferences writes through (`ConCardSetting.tsx` `setHide`). */
interface ConCardBridge {
  setConCardConfig: (patch: {
    conCard: { autoHideMs: number }
  }) => Promise<{ conCard?: { autoHideMs: number } }>
}

/** Set the con card window's text size through the overlay's own config door — A+'s door. */
function setTextScale(card: Page, textScale: number): Promise<unknown> {
  return card.evaluate(
    (s) => (window as unknown as { eqOverlay: OverlayBridge }).eqOverlay.setConfig({ textScale: s }),
    textScale
  )
}

/**
 * `CON_CARD_NEVER_HIDES` and `DEFAULT_CON_CARD_AUTO_HIDE_MS` from src/shared/conCard.ts, spelled
 * out rather than imported for the reason `PAD` is: an e2e file loads no `src` module. A change to
 * the default that forgets this line fails loudly in the last step below.
 */
const NEVER_HIDES = 0
const DEFAULT_HIDE_MS = 3_000
/**
 * How long the last step gives a DEFAULT card to leave, from the moment it is drawn.
 *
 * THE EXPECTED READING IS ~3.3 s: a 3 s hold plus a 300 ms exit counted by a 100 ms interval, which
 * is the same arithmetic that measured 5233 ms when the hold was five (JOS-388). The ceiling is
 * more than twice that on purpose — this is a FAILURE deadline, not a schedule, and the suite runs
 * four Electron apps at once.
 *
 * WHAT IT DOES AND DOES NOT SEPARATE, said plainly rather than implied: it separates three seconds
 * from twenty, from a minute and from "never", which are the ways this can actually break (a hold
 * that never reaches the window, a config echo that loses the knob, a queue that never counts). It
 * does NOT separate three from five — the difference between two adjacent choices on the same list
 * is not a thing to measure under load, and it is pinned literally in tests/conCard.test.mts, where
 * the number is a source fact rather than a race.
 *
 * IT WAS NOT OBVIOUS THAT THE COUNT WOULD RUN AT ALL, which is half the value of this step: the
 * card window in `EQ_E2E=1` is never shown, and a window Chromium is not compositing can have its
 * timers throttled to a crawl (settle.mts's `nextFrames` exists because rAF is). `useCardTick` is a
 * `setInterval`, and the measurement above says it keeps real time here.
 */
const DEFAULT_HIDE_CEILING_MS = 8_000

/**
 * Write the con card's auto-hide, through Preferences' own door, and report what main stored.
 *
 * MAIN CLAMPS AND MAIN ANSWERS, so the returned value is the assertion: a spec that wrote a number
 * main rejected would otherwise go on to measure the old one and blame the feature.
 */
function setAutoHide(page: Page, autoHideMs: number): Promise<number | undefined> {
  return page.evaluate(async (ms) => {
    const eq = (window as unknown as { eq: ConCardBridge }).eq
    return (await eq.setConCardConfig({ conCard: { autoHideMs: ms } })).conCard?.autoHideMs
  }, autoHideMs)
}

/**
 * The mob: a catalog hit with 11 listed drops AND 33 rows in the committed resist baseline, spelled
 * one way by the log, the catalog and the ledger, so nothing here depends on the machine it runs on.
 *
 * IT USED TO BE `a zol ghoul knight` (the creature tests/e2e/mob-resists.e2e.mts still uses), and
 * the swap is JOS-385's doing rather than a preference: this spec's central claim is that the card
 * keeps ONLY the axes a creature resists, which needs a creature with at least one. The ghoul
 * knight had exactly one — cold, at R 60 [40,84] — and most of that number was focused Frost
 * Strike hits being counted as partials by the old max-value full-damage reference. Corrected, it
 * reads R 26 and the mob has no notable axis at all, so the card there is now the honest
 * "no notable resists" branch and this spec would be asserting a defect.
 *
 * A loathling lich carries the claim from the owner's OWN casts, and doubly: poison at R 60 and
 * disease at R 76, which is also the mob docs/plans/resist-mining.md section 3 predicted by hand
 * (51% of disease resisted against 1% magic) before any of this code existed.
 */
const MOB = 'A loathling lich'
const MOB_CON = `${MOB} scowls at you, ready to attack -- what would you like your tombstone to say? (Lvl: 51)`
/** A SECOND creature, to prove the next con replaces the card rather than stacking one. */
const OTHER = 'A wan ghoul knight'
const OTHER_CON = `${OTHER} regards you indifferently -- looks like quite a gamble. (Lvl: 35)`
/**
 * A PLAYER, conned. Verbatim from the committed fixture w24-consider-factions.log, and the reason
 * the ticket's "the ladder knows PC from NPC" was wrong: this line and the mob lines above are the
 * same shape, and two of them share a faction rung.
 */
const PLAYER_CON = 'Lasershark regards you indifferently -- looks like quite a gamble. (Lvl: 50)'
/** Where the character is standing. Played, so the zone on the card can only be the live one. */
const ZONE = 'Lower Guk'

/** The con card overlay's page, identified by the `?kind=` query its window was opened with. */
async function findCardWindow(app: ElectronApplication): Promise<Page | null> {
  for (const w of app.windows()) {
    const search = await w.evaluate(() => window.location.search).catch(() => '')
    if (search.includes('kind=conCard')) return w
  }
  return null
}

/** Every card on screen, as flattened text. There is never supposed to be more than one. */
function cardTexts(page: Page): Promise<string[]> {
  return page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)].map((el) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()),
    CARD
  )
}

function textOf(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim() ?? '', sel)
}

/** Play one line into the log the app is tailing, then wait for the card to say what it should. */
async function conAndWait(log: FixtureLog, card: Page, line: string, expect: string): Promise<string> {
  log.append(line)
  return settle(() => textOf(card, NAME), (n) => n === expect, { timeoutMs: 30_000 })
}

/** A FRESH INSTALL HAS THE WINDOW — this kind is the first strip to ship ON (owner, 2026-08-16). */
async function stepShipsOn(app: ElectronApplication): Promise<Page | null> {
  const card = await settle(() => findCardWindow(app), (w) => w !== null, { timeoutMs: 30_000 })
  check('a fresh install spawns the con card window — the kind ships ON', card !== null)
  if (card) {
    // …and it is EMPTY until something is conned. The window existing is not the card existing.
    const idle = await settleStable(() => cardTexts(card), { timeoutMs: 6_000, stable: 4, pollMs: 200 })
    check('…and it draws nothing until a con happens', idle.length === 0, `${String(idle.length)} card(s)`)
  }
  return card
}

/**
 * PIN THE HOLD BEFORE ANY `/con` — the spec's own precondition, not a claim about the app.
 *
 * Every step below this one reads a card that is standing there: the drops arrive on a second pass,
 * the chips are read after them, the window fit is measured twice with a text-scale bump in
 * between, the card is screenshotted, and the opaque half re-cons and re-measures. That gauntlet
 * takes far longer than the shipped auto-hide (5 s since JOS-388), so an untouched card would
 * vanish out from under it.
 *
 * THE FIX IS THE USER'S OWN KNOB, NOT A BIGGER DEFAULT. `autoHideMs: 0` is `CON_CARD_NEVER_HIDES`,
 * a value a real reader can and does choose, written through the same door `ConCardSetting.tsx`
 * writes through — so the configuration under test for the rest of this file is a SHIPPED one. The
 * default gets its own step at the end, with the knob put back, which is the only honest way to
 * hold both facts in one spec.
 */
async function stepPinTheHold(page: Page): Promise<void> {
  const stored = await setAutoHide(page, NEVER_HIDES)
  check('the spec pins the card to "until I close it" through Preferences’ own door',
    stored === NEVER_HIDES, String(stored))
}

/** A REPLAY DRAWS NOTHING. The fixture's own history is folded before any of this runs. */
async function stepReplayIsSilent(page: Page, card: Page): Promise<void> {
  const { snap } = await waitHydrated(page)
  if (!check('hydration completes (the historical replay has finished)', !snap.hydrating)) return
  const after = await cardTexts(card)
  check('the replay of a month of log draws no card at all', after.length === 0, `${String(after.length)} card(s)`)
}

/** THE LIVE `/con`: one line in the log, one card on the screen, carrying what the line said. */
async function stepConDrawsTheCard(log: FixtureLog, card: Page): Promise<void> {
  // The zone is played too, on the line before: the card reports where the player IS, which is a
  // fact the con line never states and only the running world model can answer.
  log.append(`You have entered ${ZONE}.`)
  const name = await conAndWait(log, card, MOB_CON, MOB)
  if (!check('a `/con` written into the live log draws a card naming the creature', name === MOB, name)) return
  const facts = await textOf(card, FACTS)
  check('…carrying the LEVEL the con line stated', facts.includes('Level 51'), facts)
  check('…and the zone the character walked into on the line before it', facts.includes(ZONE), facts)
  const cards = await cardTexts(card)
  check('…and exactly one card, never a stack', cards.length === 1, `${String(cards.length)} card(s)`)
}

/** Put the lich back on screen: every step after this one is asserted against ITS card. */
async function stepBackToTheLich(log: FixtureLog, card: Page): Promise<void> {
  const name = await conAndWait(log, card, MOB_CON, MOB).catch(() => '')
  check(`the card returns to ${MOB} for the steps that measure it`, name === MOB, name)
}

/** Where the con card's window IS, asked of main. Identified by the `?kind=` it was opened with. */
function cardWindowBounds(app: ElectronApplication): Promise<Bounds | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('kind=conCard'))
    return w ? w.getBounds() : null
  })
}

/** How tall the thing the renderer measures actually is, in the card's own window. */
function fitBoxHeight(card: Page): Promise<number> {
  return card.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.getBoundingClientRect().height ?? 0,
    FIT
  )
}

/**
 * Poll until the window has caught up with the card. The fit is debounced by a macrotask and
 * crosses an IPC boundary, so "the window is the card" is a state to settle on, never one to read
 * once.
 */
function settleFit(app: ElectronApplication, card: Page): Promise<{ bounds: Bounds | null; want: number }> {
  return settle(
    async () => {
      const bounds = await cardWindowBounds(app)
      const want = Math.ceil(await fitBoxHeight(card)) + 2 * PAD
      return { bounds, want }
    },
    (r) => r.bounds !== null && r.want > 2 * PAD && Math.abs(r.bounds.height - fittedTo(r.want)) <= FIT_SLACK,
    { timeoutMs: 20_000 }
  )
}

/**
 * THE WINDOW IS THE CARD (JOS-386), and this is the only place that claim can be made: it spans a
 * measurement in one renderer, an IPC hop, a clamp in main and a real BrowserWindow.
 *
 * WHAT IS NOT ASSERTED IS AS IMPORTANT AS WHAT IS. x, y and width must not move — the top edge is
 * where the user (or the top-centre default) put it, and only the height is ours.
 */
async function stepWindowFitsCard(app: ElectronApplication, card: Page): Promise<void> {
  const before = await settleFit(app, card)
  const b = before.bounds
  if (!check('the con card window has bounds to read', b !== null)) return
  check('the window’s height IS the card plus the overlay’s own padding — no empty apron',
    Math.abs((b as Bounds).height - fittedTo(before.want)) <= FIT_SLACK,
    `window ${String((b as Bounds).height)} vs card+padding ${String(before.want)} (floor ${String(MIN_WINDOW_H)})`)
  // It is genuinely FITTED, not just "some number": the old fixed strip was 300 tall and the card
  // is a handful of rows. A window that had not moved would sail through the check above only if
  // the card happened to be exactly that tall.
  note(`fitted con card window: ${String((b as Bounds).width)}x${String((b as Bounds).height)}`)
  if (before.want < MIN_WINDOW_H) {
    note(`the card measured ${String(before.want)}px and the smallest window any overlay may be is ${String(MIN_WINDOW_H)} — since JOS-390 a quiet card is SHORTER than the floor, so the floor is what the window wears`)
  }

  // A TEXT-SCALE BUMP RE-FITS IT. The scale is applied as a CSS `zoom` on the card (overlayScale),
  // so the measured box really does grow — and the window has to follow, which is acceptance
  // criterion 3. Written through the overlay's own config door, the same one A+ uses.
  await setTextScale(card, 1.5)
  const bigger = await settleFit(app, card)
  const big = bigger.bounds
  if (check('a bigger text size re-fits the window', big !== null)) {
    check('…and the window GREW with the card rather than clipping it',
      (big as Bounds).height > (b as Bounds).height &&
        Math.abs((big as Bounds).height - fittedTo(bigger.want)) <= FIT_SLACK,
      `${String((b as Bounds).height)} -> ${String((big as Bounds).height)} (card+padding ${String(bigger.want)})`)
    // THE POSITION NEVER GIVES. Only the height is the app's to change.
    check('…while x, y and width stayed exactly where they were',
      (big as Bounds).x === (b as Bounds).x && (big as Bounds).y === (b as Bounds).y &&
        (big as Bounds).width === (b as Bounds).width,
      `${JSON.stringify(b)} -> ${JSON.stringify(big)}`)
  }
  // Back to 1.0 so the screenshot below is the card at its shipped size.
  await setTextScale(card, 1)
  await settleFit(app, card)
}

/**
 * WHAT IT LOOKS LIKE, saved as a picture.
 *
 * This overlay's whole subject is APPEARANCE — colour, contrast and density over a running game —
 * and no assertion in this file can carry that. One PNG of the settled card, into the run's own
 * artifacts, is what a reviewer actually needs; it costs a few hundred milliseconds and it is the
 * only way this spec can hand over the thing the ticket asks to be judged.
 *
 * The overlay window is TRANSPARENT, so the image is the card on nothing — which is exactly the
 * layer that goes over the game.
 *
 * IT HAS TO SHOW THE WINDOW FIRST, and that is JOS-120's law arriving from the other side: a hidden
 * BrowserWindow produces no frames, so a screenshot of one never resolves. `EQ_E2E=1` skips every
 * `showInactive`, so this step asks MAIN to show the card window for the moment it takes to
 * capture and puts it back. Everything here is best-effort and reports through `note`, never a
 * check: a machine with no display owes this spec nothing.
 */
async function stepScreenshot(app: ElectronApplication, card: Page): Promise<void> {
  const path = join(ARTIFACTS, 'con-card.png')
  const setShown = (shown: boolean): Promise<void> =>
    app.evaluate(({ BrowserWindow }, show) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.webContents.getURL().includes('kind=conCard')) continue
        if (show) w.showInactive()
        else w.hide()
      }
    }, shown)
  try {
    mkdirSync(ARTIFACTS, { recursive: true })
    await setShown(true)
    await card.screenshot({ path, omitBackground: true, timeout: 20_000 })
    note(`card screenshot: ${path}`)
  } catch (err: unknown) {
    note(`card screenshot unavailable — ${String(err)}`)
  } finally {
    await setShown(false).catch(() => undefined)
  }
}

/** THE NEXT CON REPLACES IT. One card, always — the queue is one deep by design. */
async function stepNextConReplaces(log: FixtureLog, card: Page): Promise<void> {
  const name = await conAndWait(log, card, OTHER_CON, OTHER)
  if (!check('conning something else REPLACES the card', name === OTHER, name)) return
  const cards = await cardTexts(card)
  check('…rather than stacking a second one', cards.length === 1, `${String(cards.length)} card(s)`)
}

/** A PLAYER IS NOT A MOB, and the con line is no help — the refusal is the shape plus the catalog. */
async function stepPlayerGetsNothing(log: FixtureLog, card: Page): Promise<void> {
  const before = await textOf(card, NAME)
  log.append(PLAYER_CON)
  // Nothing is supposed to happen, so the positive signal is the card HOLDING STILL.
  const after = await settleStable(() => textOf(card, NAME), { timeoutMs: 8_000, stable: 5, pollMs: 200 })
  check('conning a PLAYER draws no card (the name on screen never changed)', after === before, `${before} -> ${after}`)
  check('…and never names the player', !after.includes('Lasershark'), after)
}

/**
 * THE SAME MOB DOES NOT COME BACK FOR A MINUTE after its card was closed.
 *
 * THE CLOSE ITSELF IS `stepCloseDoesNotNavigate` (conCardLinkSteps.mts), because since JOS-390 the ×
 * carries two claims at once — it closes the card, and it is the ONE control on a card-wide link
 * that must not navigate — and those are one act to assert, not two clicks. This step picks up
 * where that one leaves off: a card demonstrably closed, and main's suppression to prove.
 */
async function stepSuppressAfterClose(log: FixtureLog, card: Page): Promise<void> {
  // The mob whose card was just closed is the one that must not come back.
  log.append(OTHER_CON)
  const still = await settleStable(() => cardTexts(card), { timeoutMs: 8_000, stable: 5, pollMs: 200 })
  check('…and re-conning that same creature does NOT put it back up', still.length === 0, `${String(still.length)} card(s)`)
  // A DIFFERENT creature still gets its card: the suppression is per mob, not a mute switch.
  const name = await conAndWait(log, card, MOB_CON, MOB).catch(() => '')
  check('…while a different creature still draws one — the suppression is per mob', name === MOB, name)
}

/**
 * THE SAME FIT IN OPAQUE MODE (JOS-386's "both modes"), which is where the apron was VISIBLE.
 *
 * Transparent, an over-tall strip is invisible and only costs the mouse. With `opaqueOverlays` on
 * (the JOS-40 compatibility switch, and the automatic path on a compositor that turns a transparent
 * frameless window black) the same window is a solid dark rectangle, so every unused pixel of it is
 * a box the player looks at over their game. The fit has to be the card in BOTH.
 *
 * TRANSPARENCY IS DECIDED AT CONSTRUCTION, so the ceremony is the one overlay-sync.e2e.mts uses:
 * write the preference, then close and reopen the window. The con card's open-state is its
 * Preferences toggle, so `toggleOverlay('conCard')` is that close and that reopen.
 *
 * It puts the switch back to 'off' and the window back up before returning — the step after this
 * one is about the preference closing the window, and it needs one to close.
 */
async function stepOpaqueModeFitsToo(app: ElectronApplication, page: Page, log: FixtureLog): Promise<void> {
  const openState = (): Promise<boolean> =>
    page.evaluate(async () => (await (window as unknown as { eq: GraphicsBridge }).eq.getOverlayState()).conCard)
  const reopen = async (): Promise<Page | null> => {
    await page.evaluate(async () => {
      const eq = (window as unknown as { eq: GraphicsBridge }).eq
      if ((await eq.getOverlayState()).conCard) await eq.toggleOverlay('conCard')
    })
    // THE WINDOW HAS TO BE GONE before it can be built differently, and main is the only side that
    // knows: the open-state it reports back is the close completing (wave E3 — condition, not
    // clock). overlay-sync.e2e.mts learned this on the fight overlay; it is the same ceremony.
    await settle(openState, (open) => open === false, { timeoutMs: 10_000 })
    await page.evaluate(async () => {
      const eq = (window as unknown as { eq: GraphicsBridge }).eq
      if (!(await eq.getOverlayState()).conCard) await eq.toggleOverlay('conCard')
    })
    return settle(() => findCardWindow(app), (w) => w !== null, { timeoutMs: 30_000 })
  }
  const background = (): Promise<string> =>
    app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('kind=conCard'))
      return w ? w.getBackgroundColor() : ''
    })

  const clearBg = await background()
  await page.evaluate(() => (window as unknown as { eq: GraphicsBridge }).eq.setGraphicsPrefs({ opaqueOverlays: 'on' }))
  const opaque = await reopen()
  if (!check('the con card window reopens in opaque mode', opaque !== null)) return
  // MEASURED, and spelled out rather than imported (an e2e file loads no src module): a transparent
  // window reports `#000000` here and an opaque one the solid overlay colour, `OPAQUE_OVERLAY_BG`
  // in src/shared/graphicsPrefs.ts — the same RGB the page already paints.
  const opaqueBg = await background()
  check('…and it really was built differently — the window carries the solid overlay colour',
    opaqueBg.toLowerCase() === '#0e1115' && opaqueBg !== clearBg, `${clearBg} -> ${opaqueBg}`)

  const card = opaque as Page
  const name = await conAndWait(log, card, MOB_CON, MOB).catch(() => '')
  if (check('a `/con` draws the card in opaque mode too', name === MOB, name)) {
    // `settleFit` is the wait now that the drops are gone (JOS-390): it polls until the window and
    // the measured box AGREE, which is exactly "the card has finished changing shape".
    const fit = await settleFit(app, card)
    const b = fit.bounds
    if (check('the opaque con card window has bounds to read', b !== null)) {
      check('IN OPAQUE MODE THE BOX ON SCREEN IS EXACTLY THE CARD — no dark apron under it',
        Math.abs((b as Bounds).height - fittedTo(fit.want)) <= FIT_SLACK,
        `window ${String((b as Bounds).height)} vs card+padding ${String(fit.want)} (floor ${String(MIN_WINDOW_H)})`)
    }
  }

  // …and back, so the switch is a switch and the next step has a transparent window to close.
  await page.evaluate(() => (window as unknown as { eq: GraphicsBridge }).eq.setGraphicsPrefs({ opaqueOverlays: 'off' }))
  const clear = await reopen()
  check('the con card reopens transparent again', clear !== null && (await background()) === clearBg)
}

/**
 * THE DEFAULT LEAVES BY ITSELF (JOS-388, re-ruled to three seconds by JOS-390) — the one step that
 * runs with the knob UNPINNED.
 *
 * The owner's ruling is a number, and a number in a source file is a unit test's business
 * (tests/conCard.test.mts pins 3_000). What only this file can say is that the number is WIRED: it
 * survives the store, reaches the overlay window through the config echo, becomes the queue's hold
 * at arrival, and is counted down by a 100 ms interval in a window that is never shown. Four places
 * where a 3 could quietly become an infinity.
 *
 * IT RUNS LAST, AND ON A WINDOW THAT WAS JUST REOPENED. The opaque step ends by rebuilding the card
 * window transparent again, so the queue here is empty and the card this step watches is one it
 * drew itself — there is no earlier card whose disappearance could be mistaken for this one's.
 *
 * THE CLOCK STARTS AT THE FIRST PAINT NOW, and that changed with the feature. The card used to
 * arrive in two passes whose SECOND one re-`show`ed the same id with the drops on it, restarting
 * the hold (`cardQueue.ts` `fresh`) — so the honest t0 was "the drops landed". Since JOS-390 the
 * second pass is the spell table alone AND main only re-sends when the chips actually changed, so
 * by this point in the spec (the table was read cons ago) there is no second send at all and the
 * card on screen is the whole card. Measuring from the name arriving is measuring the hold.
 */
async function stepDefaultHideLeaves(app: ElectronApplication, page: Page, log: FixtureLog): Promise<void> {
  const stored = await setAutoHide(page, DEFAULT_HIDE_MS)
  if (!check('the auto-hide goes back to the SHIPPED default', stored === DEFAULT_HIDE_MS, String(stored))) return
  const card = await settle(() => findCardWindow(app), (w) => w !== null, { timeoutMs: 30_000 })
  if (!check('the con card window is up to receive an untouched card', card !== null)) return

  const t0 = Date.now()
  const name = await conAndWait(log, card as Page, MOB_CON, MOB).catch(() => '')
  if (!check('a `/con` draws a card with the default hold in force', name === MOB, name)) return

  const gone = await settle(() => cardTexts(card as Page), (c) => c.length === 0, {
    timeoutMs: DEFAULT_HIDE_CEILING_MS + 6_000,
    pollMs: 100
  })
  const elapsed = Date.now() - t0
  note(`the default card stood ${String(elapsed)} ms after it was drawn`)
  check('AN UNTOUCHED CARD LEAVES ON ITS OWN — nobody closed it and nothing replaced it',
    gone.length === 0, `${String(gone.length)} card(s) still up after ${String(elapsed)} ms`)
  check('…inside the deadline a three-second hold has to beat (the ceiling, not a schedule)',
    gone.length === 0 && elapsed <= DEFAULT_HIDE_CEILING_MS,
    `${String(elapsed)} ms (ceiling ${String(DEFAULT_HIDE_CEILING_MS)})`)
  // …and it was a HOLD, not a card that never really arrived: the tick counts down 3 s of it, and
  // the floor is deliberately under that — this separates a hold from a flicker, nothing finer.
  check('…and it stood long enough to be read rather than flickering',
    elapsed >= 2_000, `${String(elapsed)} ms`)
}

/** THE PREFERENCE: off means off, and the window goes with it. */
async function stepPreferenceTurnsItOff(app: ElectronApplication, page: Page): Promise<void> {
  await page.click('[data-testid="nav-preferences"]', { timeout: 60_000 })
  await page.waitForSelector('[data-testid="prefs-rail-overlays"]', { timeout: 20_000 })
  await page.click('[data-testid="prefs-rail-overlays"]')
  await page.waitForSelector('[data-testid="pref-con-card"]', { timeout: 15_000 })
  const on = await settleStable(
    () => page.evaluate((sel) => (document.querySelector(sel) as HTMLInputElement | null)?.checked, '[data-testid="pref-con-card-enabled"] input'),
    { timeoutMs: 8_000, stable: 4, pollMs: 150 }
  )
  check('Preferences agrees the card is ON, matching the window that already exists', on === true, String(on))
  // …AND THE HOLD CONTROL PAINTS THE SHIPPED DEFAULT (JOS-388's lesson, JOS-390's number). A closed
  // list has a failure mode a slider does not: a stored value with no member to match renders as an
  // EMPTY control, and the shipped default is what every untouched install carries. The step above
  // put the knob back to the default, so what this reads is exactly what a fresh install would show.
  const hide = await textOf(page, '[data-testid="pref-con-card-hide"]')
  check('…and the "a card stays for" control shows the shipped default rather than nothing',
    /3 seconds/.test(hide), hide || '(empty)')
  await page.click('[data-testid="pref-con-card-enabled"] input')
  const closed = await settle(() => findCardWindow(app), (w) => w === null, { timeoutMs: 20_000 })
  check('turning it off closes the window — off means off', closed === null)
}

async function main(): Promise<void> {
  buildIfStale()

  // The spells link is the resist half's only machine dependency; the card is asserted either way.
  const log = stageFixture('e2e-overlay.log', { spells: true })
  const userData = makeUserData()

  console.log('launch: hidden Electron (EQ_E2E=1) against tests/fixtures/e2e-overlay.log…')
  const { app, close } = await launchOnFixture(log, { userData })
  let page: Page | null = null
  try {
    page = await mainWindow(app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))
    await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })

    const card = await stepShipsOn(app)
    if (card) {
      // THE PRECONDITION FIRST, before a single `/con` — see stepPinTheHold. Everything from here
      // to stepDefaultHideLeaves runs on a card the user has told to stay.
      await stepPinTheHold(page)
      await stepReplayIsSilent(page, card)
      await stepConDrawsTheCard(log, card)
      await stepNoDropsOnTheCard(card)
      // THE RESISTANT CREATURE COMES FIRST, and the order is a finding rather than a preference.
      // The card arrives in TWO passes and the client's 38 MB `spells_us.txt` is read on a worker,
      // so the first pass genuinely has no resist table behind it — the drops step used to be this
      // spec's wait for that, and since JOS-390 there are no drops to wait on. `stepResistantChip`
      // SETTLES on a chip appearing, so running it first is what proves the table has landed before
      // the lich's "nothing is worth a chip" is read as an answer rather than as an empty table.
      await stepResistantChip(card, (line, expect) => conAndWait(log, card, line, expect))
      await stepBackToTheLich(log, card)
      await stepNotableChips(card)
      await stepWindowFitsCard(app, card)
      await stepScreenshot(app, card)
      // THE LINK (JOS-390), on the lich's card, which is the one on screen: a click opens its page
      // in the app and leaves the card up; unlocked, the same click navigates nothing.
      await stepClickOpensTheMobPage(card, page, MOB)
      await stepUnlockedClickDoesNotNavigate(card, page)
      await stepNextConReplaces(log, card)
      await stepPlayerGetsNothing(log, card)
      // The × is the one control on a card-wide link that must not navigate — it closes, and only
      // closes. Its suppression half follows, and only runs on a card that demonstrably went.
      if (await stepCloseDoesNotNavigate(card, page)) await stepSuppressAfterClose(log, card)
      await stepOpaqueModeFitsToo(app, page, log)
      // …the knob comes OFF here, and the default gets the last word before the window is closed.
      await stepDefaultHideLeaves(app, page, log)
      await stepPreferenceTurnsItOff(app, page)
    } else {
      note('no con card window — every claim below it was skipped')
    }

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    if (failures.length) await dumpArtifacts(page, 'con-card-FAIL')
  } finally {
    await close()
  }

  await removeUserData(userData)
  await log.dispose()
  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
