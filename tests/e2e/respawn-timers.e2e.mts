/**
 * Headless Electron smoke test for RESPAWN CLOCKS (JOS-194).
 *
 * WHAT ONLY THE REAL APP CAN SHOW. The ladder, the gap rules and the fold are pinned over the
 * committed `wl40-farm-run.log` in tests/respawnTimers.test.mts, and the wiki grammar over its own
 * verbatim table in tests/respawnWiki.test.mts. None of those can claim THE PIECES ARE WIRED — that
 * a death message arriving in the LIVE log travels the entire real path (chokidar → Tailer →
 * parseEvent → RespawnModule → registry flush → `module:delta` → React) and comes out as a
 * countdown; that clicking Watch on a mob you just killed writes the store, reaches the running
 * module and produces a row from the kill ALREADY FOLDED rather than arming the next one; or that
 * the floating window receives the same fold in a second renderer.
 *
 * THE PLAYED LINES ARE THE SUBJECT, and they are played rather than borrowed because
 * e2e-leveling.log's own kills are days old and in zones the character has walked out of — nothing
 * of theirs is watched, and nothing of theirs is in the zone the tab defaults to. So a row appearing
 * in these steps can only have come down the live path. Both names and the sentence shape are real:
 * `a frenzied ghoul` and
 * `a wan ghoul knight` both appear in committed fixtures, and the first is one of the 394 mobs the
 * committed wiki floor states a duration for (9.5 min) while the second is one of the thousands it
 * says nothing about — which is what makes them the two ends of the estimate ladder.
 *
 * NEITHER OF THEM IS CLOCKED UNTIL IT IS ASKED FOR (owner ruling, prototype round 1). Tracking is
 * opt-in per mob, so both steps below play a death, watch it turn up in the Recently-killed panel,
 * and CLICK Watch — the difference between them is only which rung then numbers the clock.
 *
 * AND A COMBAT LINE IS PLAYED (round 3). A line that starts no clock, ends nothing and is not a
 * death still has to travel the whole path and change what both renderers draw — the row flips to
 * UP because the log NAMED the mob. Then the confirm affordance is CLICKED, which is the only
 * thing in this feature that moves a clock with no log line behind it; a build that re-based on the
 * sighting by itself fails the assertion that the clock was untouched before the click.
 *
 * AND UNWATCH IS CLICKED ON THE MOB ITSELF (round 4). The clock row's own control has to take the
 * row off BOTH renderers and out of the store, flip the Recently-killed entry back to offering
 * Watch, and give the identical clock back when it is watched again — and the floating window has
 * to be able to do the same thing, which is where the ruling came from.
 *
 * AND A LOOT LINE IS PLAYED (round 6). Pointing at a clock row has to answer the other half of
 * "should I keep standing here" — the mob's drop table, and what we have looted off it ourselves —
 * which is a JOIN no unit test can reach: a loot line folds into main's own-loot index, and a hover
 * on a row belonging to a different module entirely comes back carrying it.
 *
 * AND ROUND 7 IS FOUR MORE RULINGS, three of which are the tab's alone: the page is titled Timers;
 * "Your watches" is gone and its two controls are on the mob's Running entry (which also prints the
 * gaps it measured); Recently killed is searchable; and the mob card opens on a Recently-killed
 * entry too. The fifth is an ABSENCE and belongs over the game: the floating window draws NO card
 * any more, and says what it knows about the respawn on a plain title instead.
 *
 * AND ROUND 9 SUPERSEDES ONE OF THOSE (respawnRound9Steps.mts). The bare seconds box is deleted; the
 * duration and the rung that produced it are one bordered unit with an edit icon attached, and the
 * icon opens a MODAL carrying the card's own account, every measured gap, the wiki's words and a
 * link to the page they came from. Two steps, because the ruling has two halves: the modal itself is
 * tab-only and needs no second renderer, while "the OVERRIDDEN state reaches the window over the
 * game and none of the editing does" can only be claimed with both windows open.
 *
 * AND ROUND 8 IS THE ONE STEP THAT DOES NOT PLAY A LINE (respawnRound8Steps.mts). The owner came
 * back to the app hours after his kills, clicked Watch and got no row — a defect only OLD deaths can
 * show, so that step watches the fixture's own days-old kills through the all-zones view and asserts
 * the row is there and reads honestly. It runs first and puts everything back.
 *
 * AND THE ZONE LINE IS PLAYED TOO. The last step walks the character into another zone and asserts
 * the clocks LEAVE both surfaces while the fold keeps them: the tab's all-zones view brings them
 * straight back. That is the second owner ruling, and only the real app can show that a zone line
 * arriving on the live tail moves both windows.
 *
 * DEFAULT OFF for the window, and every launch here gets a fresh userData dir — so this spec is
 * always a first run, which makes it the one place that can prove what a new install gets.
 *
 * NO WINDOW IS EVER SHOWN (`EQ_E2E=1`, src/main/e2e.ts). The MAIN window is a real page and is
 * clicked; the OVERLAY is always-on-top and hidden, so it is read rather than clicked.
 *
 * WAIT FOR THE CONDITION, NEVER FOR THE CLOCK (wave E3): every read below goes through `settle`.
 *
 * Run: `npm run test:e2e -- respawn`.
 */
import type { ElectronApplication, Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  reportRun,
  settle,
  settleStable
} from './appHarness.mjs'
import { mainWindow, overlayWindow } from './appWindow.mjs'
import { launchOnFixture, type FixtureLog } from './logFixture.mjs'
// Round 7's surviving TAB-ONLY step lives beside this file (the 400-line ceiling, and the
// `buffRestartSteps.mts` precedent): the Recently-killed search.
import { stepSearchRecentlyKilled } from './respawnRound7Steps.mjs'
// Round 8's one step lives beside them for the same reason, and is the only one whose subject is a
// death the fixture itself carries rather than one played onto the tail.
import { stepAncientKillIsWatchable } from './respawnRound8Steps.mjs'
// Round 9's two: the edit modal that superseded round 7's seconds box, and the pair of claims about
// the overridden state that need both renderers open at once.
import { stepEditTheNumber, stepOverriddenOverTheGame } from './respawnRound9Steps.mjs'

/** A mob the committed wiki floor states a duration for: `9.5 min` → 570 s. */
const WIKI_MOB = 'a frenzied ghoul'
/** A mob it says nothing about — the 85 % case in the dungeons this ticket targets. */
const OWN_MOB = 'a wan ghoul knight'
/**
 * A MOB THE FIXTURE ITSELF KILLED, days ago (`e2e-leveling.log`, Aug 5 2026 — its last kills, in a
 * zone the character has since left). Round 8's subject: the owner's defect needs a death that is
 * genuinely old, which no line played onto the live tail can be.
 */
const ANCIENT_MOB = 'an essence tamer'

/** The main window's overlay bridge — the same one the title-bar menu calls. */
interface OverlayBridge {
  getOverlayState: () => Promise<Record<string, boolean>>
  toggleOverlay: (k: string) => Promise<boolean>
}
function overlayState(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() => (window as unknown as { eq: OverlayBridge }).eq.getOverlayState())
}
function toggleOverlay(page: Page, kind: string): Promise<boolean> {
  return page.evaluate((k) => (window as unknown as { eq: OverlayBridge }).eq.toggleOverlay(k), kind)
}

/** One clock as a surface draws it, from either the tab or the floating window. */
interface Clock {
  mob: string
  source: string
  due: string
  /** Round 3: the log has NAMED this mob since the clock started. */
  seen: string
  /** Round 3: what the clock counts from — 'death', or a sighting the user confirmed. */
  basis: string
  text: string
}

function clocks(page: Page, testid: string): Promise<Clock[]> {
  return page.evaluate(
    (id) =>
      [...document.querySelectorAll(`[data-testid="${id}"]`)].map((e) => ({
        mob: e.getAttribute('data-respawn-mob') ?? '',
        source: e.getAttribute('data-respawn-source') ?? '',
        due: e.getAttribute('data-respawn-due') ?? '',
        seen: e.getAttribute('data-respawn-seen') ?? '',
        basis: e.getAttribute('data-respawn-basis') ?? '',
        text: (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
      })),
    testid
  )
}

const find = (rows: Clock[], mob: string): Clock | undefined => rows.find((r) => r.mob === mob)

/**
 * The watch-list bridge, i.e. what the tab's Watch button lands on. Used only to READ here — and
 * since round 7 also to prove the seconds box on a clock row PERSISTED, which is why `customSec`
 * is part of the shape.
 */
interface Watches {
  watches: { key: string; customSec?: number }[]
}
function readWatches(page: Page): Promise<Watches> {
  return page.evaluate(() =>
    (window as unknown as { eq: { getRespawn: () => Promise<Watches> } }).eq.getRespawn()
  )
}

/**
 * Click Watch on a mob offered in the Recently-killed panel. The only way a clock ever exists.
 *
 * AND IT PUTS THE POINTER BACK (round 7). A click leaves the mouse where it landed, and since round
 * 7 a Recently-killed entry has a hover CARD — so the Watch button's own click opens one and leaves
 * it standing over the panel for the rest of the run. That broke the hover step twice over: its
 * "nothing is drawn until you point at a row" assertion, and then its `settle` for the row's card,
 * which the candidate's own card satisfied because both carry the same drops. The click is about the
 * click; this helper hands the pointer back.
 */
async function clickWatch(page: Page, mob: string): Promise<void> {
  await page.click(`[data-testid="respawn-candidate"][data-respawn-mob="${mob}"] [data-testid="respawn-watch"]`, {
    timeout: 15_000
  })
  await page.mouse.move(0, 0)
}

async function stepFreshInstall(page: Page, app: ElectronApplication): Promise<void> {
  await page.click('[data-testid="nav-timers"]', { timeout: 30_000 })
  const mounted = await settle(() => countOf(page, '[data-testid="timers-view"]'), (n) => n === 1, {
    timeoutMs: 30_000
  })
  check('the Timers tab mounts', mounted === 1)

  // A whole log folded at launch starts NO clocks, because nothing in it is watched — the opt-in
  // ruling, in the real app. (Round 8: not because anything was swept. The step after this one
  // watches one of those days-old kills and asserts the row IS there.)
  const empty = await settle(() => countOf(page, '[data-testid="respawn-empty"]'), (n) => n === 1, {
    timeoutMs: 20_000
  })
  check('a fresh install clocks nothing at all, and says why', empty === 1)

  const prefs = await readWatches(page)
  check('a fresh install watches nothing at all', prefs.watches.length === 0, JSON.stringify(prefs))

  // ROUND 7, RULING 3: the page is called what the nav row has always called it. Two names for one
  // surface is the thing `VIEW_LABELS` exists to prevent one floor up, and this one had two.
  const heading = await page.evaluate(
    () => document.querySelector('[data-testid="timers-view"] h6')?.textContent ?? ''
  )
  check('the page is titled Timers, like the tab that opens it', heading.trim() === 'Timers', heading)

  // ROUND 7, RULING 2: "Your watches" is GONE. Both halves of what it held are on the mob now, so
  // this asserts the ABSENCE — a build that merely hid the empty state would keep the editor rows.
  check(
    'the watch list at the bottom of the page is gone, not emptied',
    (await countOf(page, '[data-testid="respawn-watches-empty"]')) === 0 &&
      (await countOf(page, '[data-testid="respawn-watch-row"]')) === 0
  )
  // ROUND 9: and round 7's own seconds box is gone in its turn — deleted, not hidden. Nothing on a
  // fresh install offers to edit a duration, because no duration exists to edit.
  check('the bare seconds box round 7 added is gone too', (await countOf(page, '[data-testid="respawn-custom"]')) === 0)
  check(
    '…and nothing offers to edit a number until a clock exists',
    (await countOf(page, '[data-testid="respawn-duration"]')) === 0 &&
      (await countOf(page, '[data-testid="respawn-edit"]')) === 0 &&
      (await countOf(page, '[data-testid="respawn-edit-dialog"]')) === 0
  )
  // ROUND 7, RULING 4: the discovery panel has its own search from the first render.
  check('Recently killed is searchable', (await countOf(page, '[data-testid="respawn-search"]')) === 1)

  const state = await overlayState(page)
  check('…and the floating window is OFF until asked for', state.respawn === false, JSON.stringify(state))
  check('…with no window spawned at startup', (await windowsOfKind(app, 'respawn')) === 0)
}

/** How many windows the app has open on a given `?kind=` (exact, never a substring). */
async function windowsOfKind(app: ElectronApplication, kind: string): Promise<number> {
  let hit = 0
  for (const w of app.windows()) {
    const search = await w.evaluate(() => window.location.search).catch(() => '')
    if (new URLSearchParams(search).get('kind') === kind) hit++
  }
  return hit
}

/**
 * A KILL IN THE LIVE LOG IS OFFERED, NOT CLOCKED — and watching it numbers the clock from the wiki.
 *
 * The opt-in ruling, down the live path. The mob is one of the 394 the committed floor gives a
 * duration for, which under the prototype was enough to put a countdown on screen unasked; now the
 * death only makes it a CANDIDATE, and the row appears when the button is clicked. The wiki's job
 * afterwards is unchanged: it numbers a watched mob you have no gap of your own for.
 */
async function stepLiveKillIsOfferedThenWatched(page: Page, log: FixtureLog): Promise<void> {
  log.append(`You have slain ${WIKI_MOB}!`)
  const offered = await settle(() => clocks(page, 'respawn-candidate'), (r) => find(r, WIKI_MOB) !== undefined, {
    timeoutMs: 30_000
  })
  if (!check('a death message in the LIVE log offers the mob', find(offered, WIKI_MOB) !== undefined, JSON.stringify(offered))) {
    return
  }
  // THE RULING, ASSERTED: the wiki knows this mob's respawn and that is STILL not a reason to clock
  // it. `settleStable` is how an absence is asserted (wave E3) — wait for the reading to stop
  // moving, then assert nothing is there.
  const rows = await settleStable(() => clocks(page, 'respawn-row'))
  check('…and clocks NOTHING, though the wiki states its respawn', find(rows, WIKI_MOB) === undefined, JSON.stringify(rows))

  await clickWatch(page, WIKI_MOB)
  const clocked = await settle(() => clocks(page, 'respawn-row'), (r) => find(r, WIKI_MOB) !== undefined, {
    timeoutMs: 30_000
  })
  const row = find(clocked, WIKI_MOB)
  if (!check('clicking Watch starts the clock', row !== undefined, JSON.stringify(clocked))) return
  check('…numbered from the wiki, because you have no gap of your own yet', row.source === 'wiki', JSON.stringify(row))
  check('…and it says so rather than presenting the number bare', row.text.includes('wiki default'), row.text)
  check('…counting down, not already due', row.due === 'false', JSON.stringify(row))
  // The ESTIMATE, printed beside the countdown: 570 s, which is what the committed floor reads out
  // of the page's "9.5 min". The number the wiki actually states, on screen, in the real app.
  check('…for the duration the wiki actually states', row.text.includes('9m 30s'), row.text)
}

/**
 * WATCH A MOB THE WIKI HAS NEVER HEARD OF, AND THE CLOCK STARTS FROM THE KILL YOU ALREADY MADE.
 *
 * The discoverability story, clicked rather than described. Two deaths are played three minutes
 * apart so the fold has a real same-stay gap to learn from BEFORE anything is watched; then the
 * Watch button in the Recently killed panel is clicked, and a row has to appear immediately —
 * carrying that learned gap. A build whose IPC setter forgot `flushNow`, or whose module reported
 * a log seq instead of its own revision, passes every unit test and fails right here.
 */
async function stepWatchFromRecentKills(page: Page, log: FixtureLog): Promise<void> {
  // ONE CLOCK READ, TWO STAMPS (flake ledger, 2026-08-13). The gap between the two deaths IS the
  // thing under test — four checks below spell it `3m 00s` — so it has to be built, not sampled.
  // Reading the clock twice (`Date.now()` here, a bare `append()` for the second death) let a
  // single second of wall clock land between the reads: EQ stamps are second-granular, so the
  // played gap became 181 s and the row printed `3m 01s`. Both deaths are stamped off `now`, which
  // makes the gap exactly 180 s by construction. The fix belongs HERE and never in the assertions.
  const now = new Date()
  const earlier = new Date(now.getTime() - 3 * 60_000)
  log.appendAt(earlier, `You have slain ${OWN_MOB}!`)
  // THE LOOT LINE RIDES THE FIRST CORPSE, AND THE ORDER IS LOAD-BEARING (round 7, measured).
  // `lib/hoverCards.tsx` fetches a mob's knowledge ONCE PER NAME for the window's lifetime, and
  // round 7 put the card on Recently-killed entries — so the Watch CLICK below is itself a hover,
  // and it is now the first thing that ever asks about this mob. Whatever main's own-loot index
  // holds at that instant is what every later card shows. Playing the loot BEFORE the second death
  // makes that instant deterministic: the settle underneath waits for the second death, which is
  // later in the file, so the loot is folded by construction rather than by luck. (Measured the
  // other way round: green at 38 s of wall clock, red at 96 s. Realistic, too — you loot the corpse
  // and then kill it again.)
  log.appendAt(earlier, `--You have looted 2 ${LOOTED} from ${OWN_MOB}'s corpse.--`)
  log.appendAt(now, `You have slain ${OWN_MOB}!`)

  const offered = await settle(
    () => clocks(page, 'respawn-candidate'),
    (r) => find(r, OWN_MOB) !== undefined,
    { timeoutMs: 30_000 }
  )
  const cand = find(offered, OWN_MOB)
  if (!check('a mob nobody watches is still OFFERED, having died', cand !== undefined, JSON.stringify(offered))) {
    return
  }
  check('…and is not clocked until asked for', find(await clocks(page, 'respawn-row'), OWN_MOB) === undefined)

  await clickWatch(page, OWN_MOB)

  const rows = await settle(() => clocks(page, 'respawn-row'), (r) => find(r, OWN_MOB) !== undefined, {
    timeoutMs: 30_000
  })
  const row = find(rows, OWN_MOB)
  if (!check('clicking Watch produces a clock at once', row !== undefined, JSON.stringify(rows))) return
  // FROM THE KILL ALREADY FOLDED, and numbered by the gap already learned — not from the next death.
  check('…numbered from YOUR kills, not from the wiki', row.source === 'observed', JSON.stringify(row))
  check('…stating how thin that evidence is', row.text.includes('your kills (1 gap)'), row.text)
  // The two deaths were played three minutes apart, so the learned bound is 3m — printed with the
  // "<=" that says it is a bound and not a measurement.
  check('…and the gap it learned is the one that was played', row.text.includes('<= 3m 00s'), row.text)
  // ROUND 7, RULING 2: the row shows its WORKING — the gaps it measured, not only the minimum it
  // reduced them to. One gap was played, so one is printed, and it is that gap.
  check('…and the row shows the gap itself, not only the estimate it became', row.text.includes('gaps: 3m 00s'), row.text)

  const prefs = await readWatches(page)
  check(
    '…and the choice was PERSISTED, not held in the component',
    prefs.watches.some((w) => w.key === OWN_MOB),
    JSON.stringify(prefs)
  )
}

/**
 * THE FOLD REACHES THE SECOND RENDERER — the claim `MODULE_READING_OVERLAYS` exists for.
 *
 * The window is created in the same `whenReady` turn that starts the historical fold, so a window
 * riding only `module:delta` would sit at an empty snapshot on a quiet log. Both clocks are already
 * in the model by the time it opens, so both have to be in the window (JOS-172).
 */
async function stepOverlay(page: Page, app: ElectronApplication): Promise<Page | null> {
  const open = await toggleOverlay(page, 'respawn')
  if (!check('toggling Respawn from the overlay menu reports it OPEN', open === true)) return null

  const overlay = await overlayWindow(app, 'respawn')
  if (!check('…and a window for kind=respawn really exists', overlay !== null)) return null
  const o = overlay

  const mounted = await settle(() => countOf(o, '[data-testid="respawn-overlay"]'), (n) => n === 1, {
    timeoutMs: 20_000
  })
  check('the respawn surface mounts', mounted === 1)
  check('…with a visible close control', (await countOf(o, 'button[aria-label="Close overlay"]')) === 1)
  check('…and the lock (click-through) control beside it', (await countOf(o, 'button[aria-label^="Lock"]')) === 1)

  const rows = await settle(
    () => clocks(o, 'respawn-overlay-row'),
    (r) => find(r, WIKI_MOB) !== undefined && find(r, OWN_MOB) !== undefined,
    { timeoutMs: 30_000 }
  )
  check(
    'a window opened AFTER the fold shows the clocks the fold already holds',
    find(rows, WIKI_MOB) !== undefined && find(rows, OWN_MOB) !== undefined,
    JSON.stringify(rows)
  )
  // ROUND 5 MOVED IT TO THE HOVER, and this still has to find it. The two claims this window makes
  // (a clock at zero is our estimate elapsing, UP is the game naming the mob) used to be a standing
  // legend line under the rows; the owner cut the explanatory text, so the sentence rode the header
  // count's TITLE - until 1111d8d9 (2026-08-16, owner ruling: no overlay hovers a tooltip, not
  // even the title bar) converted the chrome's native titles to aria-labels. The sentence still
  // ships, as the accessibility name (OverlayHeader.tsx `aria-label={tailTitle}`) - so that is the
  // surface this reads. If it were merely deleted, this fails. (This assertion went stale on
  // 08-16 and no full sweep ran this spec until 2026-08-20 - the collection was [] because the
  // chrome carries NO native titles at all now, by design.)
  const labels = await o.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[aria-label]')].map(
      (e) => e.getAttribute('aria-label') ?? ''
    )
  )
  check(
    '…and never claims the mob is standing there',
    labels.some((t) => t.includes('estimate elapsed, not a sighting')),
    JSON.stringify(labels)
  )
  const body = await o.evaluate(() => document.body.innerText)
  check(
    '…without spending a line of a 300px window saying it',
    !body.includes('estimate elapsed'),
    body.slice(0, 200)
  )
  return o
}

/**
 * What the mob hover card is saying, on whichever surface is asked. Empty when none is open.
 *
 * `textContent`, not `innerText`: this card is drawn in a window that is never composited, and
 * `innerText` is the layout-aware reading of the two.
 */
function cardText(p: Page): Promise<string> {
  return p.evaluate(() => document.querySelector('[data-testid="mob-hover-card"]')?.textContent ?? '')
}

/**
 * Point at / away from a row of the FLOATING window, which is hidden here and so is driven rather
 * than pointed at. A BUBBLING `mouseover`, never `mouseenter`: React synthesises enter/leave at the
 * root out of mouseover/mouseout, so a directly dispatched `mouseenter` reaches no handler at all
 * (the overlay-sync spec learned this the same way). `relatedTarget` is the body — outside the
 * React root, which is what makes it read as arriving from outside the tree.
 */
function pointAtOverlayRow(overlay: Page, mob: string, over: boolean): Promise<void> {
  return overlay.evaluate(
    ({ mob: m, over: isOver }) => {
      const row = document.querySelector(`[data-testid="respawn-overlay-row"][data-respawn-mob="${m}"]`)
      row?.dispatchEvent(
        new MouseEvent(isOver ? 'mouseover' : 'mouseout', { bubbles: true, relatedTarget: document.body })
      )
    },
    { mob, over }
  )
}

/** An item played onto the live tail as looted off the watched mob — real EQ shape (parseWorld.ts). */
const LOOTED = 'Bone Chips'

/**
 * THE ROW ANSWERS "IS IT WORTH WAITING FOR" (owner ruling, round 6) — AND ONLY IN THE APP (round 7).
 *
 * A countdown says when; the question a player standing on a spawn point is asking is whether to
 * keep standing there, and that is a question about loot. So pointing at a clock row reveals the
 * mob's DROPS — the wiki table plus what we have looted off it ourselves — under what we know about
 * its respawn.
 *
 * ONLY THE REAL APP CAN SHOW THIS, because the claim is a JOIN across two subsystems that never
 * meet in a unit test: a loot line arriving on the live tail folds into main's own-loot index, and
 * a hover on a clock row belonging to an entirely different module has to come back carrying it —
 * through the same cache-first `mobs:lookup` door the `/con` card uses.
 *
 * THE LOOT LINE IS PLAYED IN `stepWatchFromRecentKills`, and the comment there says why it cannot be
 * played here any more. It is deliberately an item on a mob the wiki page does not list it for, so
 * it can only be on that card because the app watched it drop. The card is also asserted ABSENT
 * before the hover — nothing is DRAWN until a row is pointed at, which is the whole reason a list of
 * clocks can afford one at all.
 *
 * ROUND 7 MOVED THE LINE IN TWO DIRECTIONS AT ONCE, and both are asserted here:
 *   * THE RECENTLY-KILLED ENTRY gets the same card — the owner asked for it where the decision to
 *     watch is actually made — with the shorter note a mob with no clock can honestly carry.
 *   * THE FLOATING WINDOW LOSES IT. The card is 300px wide and the window is about 300px wide, so
 *     it took the window over; the owner ruled it in-app only. Pointing at an overlay row has to
 *     produce NOTHING.
 *
 * …AND JOS-358 TOOK THE LAST THING THAT ROW COULD SAY ON HOVER. Round 7 left the provenance
 * sentence on the row's native `title`; the owner ruled from hands-on testing that these windows
 * keep tooltips ONLY in the title bar (and that a stranded one was surviving the pointer leaving
 * the window). So the assertion below INVERTS: pointing at an overlay row produces no card AND no
 * title. The provenance itself is unchanged — the tab's card, asserted above, is built from the
 * same `respawnProvenance`, which is what keeps the two surfaces from drifting.
 */
async function stepHoverCard(page: Page, overlay: Page): Promise<void> {
  const before = await settleStable(() => cardText(page))
  check('a clock row draws no card until it is pointed at', before === '', before)

  await page.hover(`[data-testid="respawn-row"][data-respawn-mob="${OWN_MOB}"]`, { timeout: 15_000 })
  const shown = await settle(() => cardText(page), (t) => t.includes(LOOTED), { timeoutMs: 30_000 })
  if (!check('pointing at a clock row opens the mob card', shown.length > 0, shown)) return
  // (a) THE DROPS, from our own entry for the mob — the item is on the card only because a loot
  // line said so, wherever the card's authority ordering ends up putting it.
  check('…carrying what we have actually seen it drop', shown.includes(LOOTED), shown)
  // (b) THE TIMER KNOWLEDGE, and it is round 5's provenance string rather than a second spelling:
  // the raw gap, what a gap proves, and how many kills are behind it.
  check('…under what we know about the respawn', shown.includes('A gap is an upper bound'), shown)
  check('…labelled as ours rather than the wiki’s', shown.includes('Your shortest gap'), shown)

  await page.mouse.move(0, 0)
  const tabGone = await settle(() => cardText(page), (t) => t === '', { timeoutMs: 20_000 })
  check('the card leaves with the pointer', tabGone === '', tabGone)

  // ROUND 7: THE SAME CARD ON THE MOB YOU HAVE ONLY KILLED. Same component, same lookup door, same
  // drops — a shorter note, because a candidate has no rung, no basis and no gap of its own.
  await page.hover(`[data-testid="respawn-candidate"][data-respawn-mob="${OWN_MOB}"]`, { timeout: 15_000 })
  const cand = await settle(() => cardText(page), (t) => t.includes(LOOTED), { timeoutMs: 30_000 })
  check('pointing at a Recently-killed entry opens the same card', cand.includes(LOOTED), cand)
  check('…saying what it can honestly say about a mob with no clock', cand.includes('Killed'), cand)
  await page.mouse.move(0, 0)
  const candGone = await settle(() => cardText(page), (t) => t === '', { timeoutMs: 20_000 })
  check('…and it leaves with the pointer too', candGone === '', candGone)

  // ROUND 7: AND NOT OVER THE GAME. Dispatched rather than pointed at, for the reason at the top of
  // this file: this window is hidden, so it is driven rather than clicked. A build that left round
  // 6's wiring in place fails here, because the row would answer with a card.
  await pointAtOverlayRow(overlay, OWN_MOB, true)
  const over = await settleStable(() => cardText(overlay))
  check('the floating window draws NO card at all - it is in-app only now', over === '', over)
  // …AND NO TITLE EITHER (JOS-358). Round 7 left the provenance sentence on the row's native title;
  // the owner's ruling takes it. Read as a TITLE on the ROW specifically — the header count's own
  // hover is in the title bar and is asserted alive in `stepOverlayShowsClocks`, so a change that
  // stripped the whole window would fail there instead of passing quietly here.
  const rowTitles = await overlay.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="respawn-overlay-row"]')].map((e) => e.title)
  )
  check(
    '…and no longer hovers a provenance sentence over the game either',
    rowTitles.every((t) => t === ''),
    JSON.stringify(rowTitles)
  )
  await pointAtOverlayRow(overlay, OWN_MOB, false)
}

/**
 * SEEN ON LOG EVIDENCE, AND THE RE-BASE THAT IS NEVER AUTOMATIC (owner ruling, round 3).
 *
 * The defect came from live play: the owner was being hit by a watched mob and the row still read
 * due-in-the-past. Only the real app can show the fix, because the claim is that a line arriving on
 * the LIVE tail — one that starts no clock and is not a death — travels the whole path and changes
 * what TWO renderers draw.
 *
 * The played line is a real shape (`<Mob> hits YOU for N points of damage.`, verbatim from
 * e2e-combat.log with the mob name swapped) and the mob is the one this spec already watches.
 *
 * IT IS DELIBERATELY THE STRICTER CASE. The owner's row was overdue; this one's countdown is still
 * running, because an e2e cannot wait out a three-minute estimate. Evidence overriding a LIVE
 * countdown is the same rule applied where it has more to prove — a seen row leads with the fact
 * whether or not the clock agrees, and that is exactly what shared/respawn.ts argues.
 */
async function stepSeenOnLogEvidence(page: Page, overlay: Page, log: FixtureLog): Promise<void> {
  log.append(`A wan ghoul knight hits YOU for 106 points of damage.`)

  const seen = await settle(() => clocks(page, 'respawn-row'), (r) => find(r, OWN_MOB)?.seen === 'true', {
    timeoutMs: 30_000
  })
  const row = find(seen, OWN_MOB)
  if (!check('a combat line naming a watched mob flips its row UP', row?.seen === 'true', JSON.stringify(seen))) {
    return
  }
  check('…and the clock says UP rather than reciting its estimate', row.text.includes('UP'), row.text)
  check('…stating what saw it, and how long ago', row.text.includes('seen') && row.text.includes('combat line'), row.text)
  check('…without touching the clock: it is still counting from the death', row.basis === 'death', JSON.stringify(row))

  const overlayRows = await settle(
    () => clocks(overlay, 'respawn-overlay-row'),
    (r) => find(r, OWN_MOB)?.seen === 'true',
    { timeoutMs: 30_000 }
  )
  check(
    '…and the floating window — where the ruling came from — says UP too',
    find(overlayRows, OWN_MOB)?.text.includes('UP') === true,
    JSON.stringify(overlayRows)
  )
  check(
    '…with its own confirm affordance, because it is unlocked',
    (await countOf(overlay, '[data-testid="respawn-overlay-confirm"]')) >= 1
  )

  // THE SECOND RULING: nothing above moved a clock. This click is the only thing that can.
  await page.click(`[data-testid="respawn-row"][data-respawn-mob="${OWN_MOB}"] [data-testid="respawn-confirm-sighting"]`, {
    timeout: 15_000
  })
  const rebased = await settle(() => clocks(page, 'respawn-row'), (r) => find(r, OWN_MOB)?.basis === 'sighting', {
    timeoutMs: 30_000
  })
  const after = find(rebased, OWN_MOB)
  if (!check('confirming the sighting re-bases the clock', after?.basis === 'sighting', JSON.stringify(rebased))) return
  check('…and says the number came from your judgement, not from a death line', after.text.includes('from your sighting'), after.text)
  check('…leaving the seen state, because the evidence is now the base', after.seen === 'false', JSON.stringify(after))
  check('…counting down again rather than sitting due', after.due === 'false', JSON.stringify(after))
}

/**
 * UNWATCH IS ON THE MOB, WHEREVER YOU MEET IT (owner ruling, round 4).
 *
 * Watch was always a per-mob click; stopping used to mean scrolling to the global watch list at the
 * bottom of the tab and matching a name against it. This step exercises the two ends of the new
 * symmetry on the mob the spec has been clocking from the wiki:
 *
 *   1. CLICK Unwatch ON ITS CLOCK ROW. The row has to leave the tab AND the floating window, the
 *      Recently-killed entry has to flip straight back to offering Watch (the toggle), the OTHER
 *      watched mob must be untouched, and the store must no longer hold it — a build that only
 *      hid the row locally fails all four.
 *   2. WATCH IT AGAIN, and the same clock comes back numbered the same way. That is the promise
 *      the control's own tooltip makes and the reason it needs no confirmation step: nothing but
 *      the preference was ever thrown away, because everything else is re-derived from the log.
 *
 * Then the FLOATING WINDOW's own path is driven, because that is where the ruling came from: a row
 * about the wrong duplicate-named mob is worth removing without alt-tabbing out of the fight. The
 * button's presence is asserted in the overlay DOM (it exists only because the window is unlocked —
 * a locked one is click-through by law), and the call itself goes through that window's bridge
 * rather than a synthetic click, for the reason stated at the top of this file: the overlay is
 * hidden here, so it is read rather than clicked.
 */
async function stepUnwatchOnTheMob(page: Page, overlay: Page, app: ElectronApplication): Promise<void> {
  check(
    'an unlocked floating window offers Unwatch on its rows',
    (await countOf(overlay, '[data-testid="respawn-overlay-unwatch"]')) >= 1
  )

  await page.click(`[data-testid="respawn-row"][data-respawn-mob="${WIKI_MOB}"] [data-testid="respawn-row-unwatch"]`, {
    timeout: 15_000
  })
  const left = await settle(() => clocks(page, 'respawn-row'), (r) => find(r, WIKI_MOB) === undefined, {
    timeoutMs: 30_000
  })
  if (!check('Unwatch on the clock row takes the clock away', find(left, WIKI_MOB) === undefined, JSON.stringify(left))) {
    return
  }
  check('…and leaves the other watched mob alone', find(left, OWN_MOB) !== undefined, JSON.stringify(left))
  const overlayLeft = await settle(
    () => clocks(overlay, 'respawn-overlay-row'),
    (r) => find(r, WIKI_MOB) === undefined,
    { timeoutMs: 30_000 }
  )
  check('…on the floating window too, off the one fold', find(overlayLeft, WIKI_MOB) === undefined, JSON.stringify(overlayLeft))
  check(
    '…and the choice was PERSISTED, not held in the component',
    (await readWatches(page)).watches.every((w) => w.key !== WIKI_MOB)
  )
  const offersWatch = await settle(
    () => countOf(page, `[data-testid="respawn-candidate"][data-respawn-mob="${WIKI_MOB}"] [data-testid="respawn-watch"]`),
    (n) => n === 1,
    { timeoutMs: 20_000 }
  )
  check('…while the mob itself is offered again, the same control saying the opposite thing', offersWatch === 1)

  // NOTHING BUT THE PREFERENCE WENT AWAY: one click and the clock is back, numbered as before.
  await clickWatch(page, WIKI_MOB)
  const back = await settle(() => clocks(page, 'respawn-row'), (r) => find(r, WIKI_MOB) !== undefined, {
    timeoutMs: 30_000
  })
  check('watching it again brings back the same clock', find(back, WIKI_MOB)?.source === 'wiki', JSON.stringify(back))
  check('…still the duration the wiki states, so the fold kept everything', find(back, WIKI_MOB)?.text.includes('9m 30s') === true)

  // AND THE WINDOW OVER THE GAME CAN DO IT, which is the half of the ruling the tab cannot show.
  await unwatchFromOverlay(overlay, WIKI_MOB)
  const goneAgain = await settle(
    () => clocks(overlay, 'respawn-overlay-row'),
    (r) => find(r, WIKI_MOB) === undefined,
    { timeoutMs: 30_000 }
  )
  check('the floating window can stop a clock on its own', find(goneAgain, WIKI_MOB) === undefined, JSON.stringify(goneAgain))
  const tabToo = await settle(() => clocks(page, 'respawn-row'), (r) => find(r, WIKI_MOB) === undefined, {
    timeoutMs: 30_000
  })
  check('…and the tab agrees, because both read one fold', find(tabToo, WIKI_MOB) === undefined, JSON.stringify(tabToo))
  check('…with no extra window spawned or lost along the way', (await windowsOfKind(app, 'respawn')) === 1)
}

/** Round 4's write, from the floating window's OWN bridge — the path a click there would take. */
function unwatchFromOverlay(overlay: Page, mob: string): Promise<boolean> {
  return overlay.evaluate(
    (k) => (window as unknown as { eqOverlay: { unwatchRespawn: (key: string) => Promise<boolean> } }).eqOverlay.unwatchRespawn(k),
    mob
  )
}

/** A zone the fixture is NOT in, played onto the live tail. Real name, real sentence shape. */
const OTHER_ZONE = 'Befallen'

/**
 * ZONING AWAY EMPTIES BOTH SURFACES, AND THE FOLD KEEPS EVERYTHING (owner ruling, round 1).
 *
 * Only the real app can show this: a `You have entered` line arriving on the live tail has to move
 * TWO renderers at once — the floating window (which now shows the zone you are in and nothing
 * else) and the tab (which defaults to it) — off one piece of module state. The all-zones switch
 * then proves the data was never thrown away, which is the half of the ruling that is easy to
 * implement wrongly by simply dropping the rows.
 */
async function stepZoneScope(page: Page, overlay: Page, log: FixtureLog): Promise<void> {
  const before = await clocks(page, 'respawn-row')
  log.append(`You have entered ${OTHER_ZONE}.`)

  const gone = await settle(() => clocks(page, 'respawn-row'), (r) => r.length === 0, { timeoutMs: 30_000 })
  check('walking into another zone takes the clocks off the tab', gone.length === 0, JSON.stringify(gone))
  const empty = await settle(
    () => page.evaluate(() => document.querySelector('[data-testid="respawn-empty"]')?.textContent ?? ''),
    (t) => t.length > 0,
    { timeoutMs: 20_000 }
  )
  check('…and says where they went rather than looking broken', empty.includes('running in other zones'), empty)

  const overlayRows = await settle(() => clocks(overlay, 'respawn-overlay-row'), (r) => r.length === 0, {
    timeoutMs: 30_000
  })
  check('…and the floating window empties with it', overlayRows.length === 0, JSON.stringify(overlayRows))
  const overlayText = await overlay.evaluate(() => document.body.innerText)
  check('…saying the clocks are running elsewhere, not that they are gone', overlayText.includes('running elsewhere'), overlayText)

  // THE DATA IS KEPT. One click, and every clock the fold holds is back — same rows, same numbers.
  await page.click('[data-testid="respawn-scope-all"]', { timeout: 15_000 })
  const all = await settle(() => clocks(page, 'respawn-row'), (r) => r.length === before.length, { timeoutMs: 20_000 })
  check(
    'the all-zones view still holds every clock the fold learned',
    all.length === before.length && before.every((b) => find(all, b.mob) !== undefined),
    JSON.stringify({ before, all })
  )
}

async function main(): Promise<void> {
  buildIfStale()
  const launched = await launchOnFixture('e2e-leveling.log')
  const fixture = launched.log
  const page = await mainWindow(launched.app)
  await page.waitForSelector('[data-testid="nav-overview"]', { timeout: 60_000 })

  await stepFreshInstall(page, launched.app)
  // ROUND 8 runs while the fold still holds NOTHING but the fixture's own days-old kills, which are
  // its subject. It unwatches what it watched and puts the scope back, so the steps below still see
  // a fresh install.
  await stepAncientKillIsWatchable(page, ANCIENT_MOB)
  await stepLiveKillIsOfferedThenWatched(page, fixture)
  await stepWatchFromRecentKills(page, fixture)
  // ROUND 9's edit modal, and ROUND 7's search, before any window is opened: neither needs a second
  // renderer, and the search step deliberately leaves the box EMPTY so the steps below can still
  // click Watch. The modal step leaves the mob numbered by its own kills, which is what the hover
  // step's provenance assertion below reads.
  await stepEditTheNumber(page, OWN_MOB, readWatches)
  await stepSearchRecentlyKilled(page, OWN_MOB, WIKI_MOB)
  // The zone step needs the window the overlay step opened — it is the second half of the same
  // claim (one piece of zone state, two renderers), so it rides the same window rather than
  // toggling a fresh one.
  const overlay = await stepOverlay(page, launched.app)
  if (overlay) {
    // Round 6 rides the same window and runs FIRST of the three, for one reason: it asserts the
    // card is absent until a row is hovered, and the steps below leave pointers and rows moving.
    await stepHoverCard(page, overlay)
    // Round 9's second half needs both renderers: the OVERRIDDEN state has to reach the window over
    // the game while none of the EDITING does. It runs on the wiki-numbered mob (the committed floor
    // holds a page title for it, so the modal's link needs no network) and hands that mob back to
    // the wiki default, which is what the unwatch step below reads.
    await stepOverriddenOverTheGame(page, overlay, WIKI_MOB)
    // Round 3 rides the same window for the same reason the zone step does: the claim is that ONE
    // piece of module state moves two renderers. It runs BEFORE the zone step, which walks the
    // character out and empties both surfaces.
    await stepSeenOnLogEvidence(page, overlay, fixture)
    // Round 4 rides the same window again, and runs before the zone step for the same reason round
    // 3 does: the zone step walks the character out and empties both surfaces. It deliberately
    // leaves ONE clock watched, so what follows still has something to take away.
    await stepUnwatchOnTheMob(page, overlay, launched.app)
    await stepZoneScope(page, overlay, fixture)
  }

  if (failures.length) await dumpArtifacts(page, 'respawn-timers-FAIL')
  await launched.close()
  await fixture.dispose()
  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error -', err)
  process.exitCode = 1
})
