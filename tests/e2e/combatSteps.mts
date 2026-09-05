// STEPS OF THE COMBAT-DASHBOARD SPEC that live next door, because combat-dashboard.e2e.mts sits
// AT the repo max-lines budget and the rule here is to split, never ratchet (drill.mts set the
// precedent). Each function below is one numbered step of that run, moved verbatim except where
// noted; the spec still owns the ORDER.
//
// ── THE COMBAT TAB'S HEALING DIMENSION, end to end (P2 of docs/plans/combat-overlay-parity.md —
// owner ruling: "the combat panel lacks the overlay's HEAL functionality — parity").
//
// The builder and every word it prints are pinned purely in tests/healRows.test.mts, including
// the one-builder seam that keeps the panel and the floating heal overlays rendering from the
// same function. What only the real app can show is that the third position of the direction
// filter is WIRED: the panel swaps to a healing list, its headline switches units to `hps` (a
// heal rate must never be readable as dps), and the copy affordance — which serializes damage
// tables only — stands down rather than putting the wrong view on the clipboard.
//
// The CONTENT is log-dependent (a session with no heals legitimately renders the quiet empty
// state), so nothing here asserts rows — only that the dimension exists and behaves.

import type { Page } from 'playwright-core'
import {
  check,
  closePicker,
  combatText,
  countOf,
  listedValues,
  note,
  openPicker,
  settle,
  settleCount,
  settleGone,
  settleStable,
  snapshot,
  type Snap,
  type SnapEntity
} from './appHarness.mjs'
import { drilled, leaveCombat, meterRows, returnToCombat } from './drill.mjs'
import {
  RETIRED_SCOPE_CHIP,
  SCOPE_LABEL_SEL,
  scopeFromPrefs,
  setMeterScope,
  type Scope
} from './combatPrefsSteps.mjs'
import {
  PET_BOUND_DAMAGE,
  PET_LEADER_BOUND_DAMAGE,
  PET_LEADER_LINES,
  PET_LEADER_NAME,
  PET_LEADER_UNBOUND_DAMAGE,
  PET_NAME,
  PET_ORDER_LINES,
  PET_PULL_LINES,
  PET_RETIRED_DAMAGE,
  PET_UNBOUND_DAMAGE,
  PULL_DAMAGE,
  PULL_LINES,
  PULL_TARGET,
  playPetLeaderAnswer,
  playPetOrder,
  playPetPull,
  playPull
} from './gameplay.mjs'
import type { FixtureLog } from './logFixture.mjs'

const TOGGLE = '[data-testid="direction-toggle"]'

/**
 * A toggle-button group's selected index, 1-based — the CONDITION a click on one produces.
 *
 * MUI marks the pressed button both ways (`aria-pressed` and `Mui-selected`); reading either keeps
 * a styling-only change from silently passing. Returns 0 when nothing in the group is selected,
 * which is what a group that has not rendered yet looks like.
 */
function selectedIndex(page: Page, testid: string): Promise<number> {
  return page.evaluate((id) => {
    const buttons = [...document.querySelectorAll(`[data-testid="${id}"] button`)]
    return (
      buttons.findIndex(
        (b) => b.getAttribute('aria-pressed') === 'true' || b.classList.contains('Mui-selected')
      ) + 1
    )
  }, testid)
}

/**
 * Click one position of a toggle group and WAIT FOR IT TO BE THE SELECTED ONE.
 *
 * This replaces the suite's most common bet — `click(); sleep(800)` — with the state the click was
 * supposed to produce. Selection here crosses a React state update and, for the scope toggle, a
 * store write and a re-resolved selection, so it is a wait by nature; the old sleep was simply a
 * guess at how long that takes on an unloaded machine.
 */
export async function clickToggle(page: Page, testid: string, index: number): Promise<boolean> {
  await page.click(`[data-testid="${testid}"] button:nth-child(${String(index)})`, { timeout: 15_000 })
  return (await settle(() => selectedIndex(page, testid), (n) => n === index, { timeoutMs: 10_000 })) === index
}

/** Fight | Overall. 1 = Fight, 2 = Overall. */
export const clickScope = (page: Page, index: 1 | 2): Promise<boolean> => clickToggle(page, 'scope-toggle', index)

/** Dashboard | Timeline. 1 = Dashboard, 2 = Timeline. */
export const clickView = (page: Page, index: 1 | 2): Promise<boolean> => clickToggle(page, 'view-toggle', index)

/**
 * The METER panel alone. TWO cards share the `dash-panel` testid, and the tab header carries an
 * outgoing-dps headline of its own — so a whole-page read could never tell a heal panel from a
 * damage one. The meter body is the unambiguous anchor; its enclosing panel is the subject.
 */
function meterPanelText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="meter-body"]')?.closest('[data-testid="dash-panel"]')
    return (el as HTMLElement | null)?.innerText ?? ''
  })
}

/** How many of `sel` live inside that same panel. */
function inMeterPanel(page: Page, sel: string): Promise<number> {
  return page.evaluate(
    (s) =>
      document
        .querySelector('[data-testid="meter-body"]')
        ?.closest('[data-testid="dash-panel"]')
        ?.querySelectorAll(s).length ?? 0,
    sel
  )
}

export async function stepHealingDimension(page: Page): Promise<void> {
  await page.click(`${TOGGLE} button[value="heal"]`, { timeout: 15_000 })
  // The condition is the panel having SWAPPED units — the healing list is the whole claim.
  const panel = await settle(() => meterPanelText(page), (t) => /\bhps\b/.test(t), { timeoutMs: 10_000 })
  check('the meter panel offers a HEALING dimension beside Outgoing/Incoming', panel.length > 0)
  check(
    '…whose headline is an hps rate, never a dps one (one formatter, its own unit word)',
    /\bhps\b/.test(panel) && !/\bdps\b/.test(panel),
    panel.slice(0, 140).replace(/\s+/g, ' ')
  )
  check(
    '…and which offers no copy button (copyText serializes damage tables only)',
    (await inMeterPanel(page, '[data-testid="copy-view"]')) === 0
  )

  // Back to Outgoing so every later step sees the panel it expects — and so the switch is proved
  // to work in both directions rather than being a one-way trip.
  await page.click(`${TOGGLE} button[value="out"]`, { timeout: 15_000 })
  const back = await settle(() => meterPanelText(page), (t) => /\bdps\b/.test(t), { timeoutMs: 10_000 })
  check('…and switching back to Outgoing restores the damage meter', /\bdps\b/.test(back))
}

// ── THE METER DRILL, LEVEL BY LEVEL (JOS-35) ───────────────────────────────────────────
//
// The model is pinned purely in tests/combatPetNesting.test.mts — which level a drill token
// resolves to, what folds into whose bar, what a stale id degrades to. What only the real app
// can show is that the LEVELS ARE REACHABLE with a mouse: that the tab opens zoomed OUT, that
// clicking a bar (INCLUDING YOUR OWN — the click this surface lost) opens that entity's
// breakdown, and that there is a way back from it. Two of those three were the regressions the
// ticket was filed for, and all three are invisible to a unit test.
//
// Floors and identities only (AGENTS.md): the live log decides who is in the fight, so this
// asserts "at least one bar, and the first one drills", never a name or a count.

export async function stepMeterDrill(page: Page): Promise<void> {
  // 1. LEVEL 1 IS WHERE IT OPENS. No crumb, no Back — nothing has been drilled yet.
  //    (Every step before this one leaves the meter un-drilled; `meterRows` guarantees it.)
  const rows = await meterRows(page)
  check('the Combat tab opens ZOOMED OUT — one bar per combatant, no auto-drill', !(await drilled(page)))
  if (rows === 0) {
    note('the selection has no outgoing damage right now — there is no bar to click')
    return
  }

  // 2. CLICKING A BAR DRILLS IT. The first row is the biggest source, which on this log is you
  //    (or your bar with the pet folded in) — the exact bar whose click went missing.
  await page.click('[data-testid="meter-row"]', { timeout: 15_000 })
  const opened = await settle(() => drilled(page), (d) => d, { timeoutMs: 10_000 })
  check('…and clicking a source bar — your own included — opens that entity’s breakdown', opened)

  // 3. AND THERE IS A WAY BACK. The meter used to withhold Back on precisely the view it had
  //    opened on, which with the pet preference on was every view there was.
  const back = await inMeterPanel(page, '[data-testid="drill-back"]')
  check('…with the zoom-out affordance on that level', back === 1, `${back} back control(s)`)
  const after = await meterRows(page)
  check('…and Back returns to the same source list it came from', after === rows, `${rows} → ${after} rows`)
}

// ── ONE BAR PER ABILITY, STATS EXPAND INLINE (JOS-113) ─────────────────────────────────────
//
// This step replaces `stepCategoryDrill`. JOS-105 grouped a source's abilities under a CATEGORY
// chip and put the multi-attack readout one level down; the owner rejected both — "one bar per
// ability, flat, NO category strip; click an ability that has stats and its crit/double/triple/
// miss appear INLINE beneath its bar; an ability with no stats (a DoT tick) does nothing." So this
// walks that path with a mouse: drill a source, assert NO category chip, click a stat-bearing
// ability and watch its stats open in place.
//
// The shaping is pinned purely in tests/abilityStats.test.mts (which lane belongs to which
// ability, where flurry rides, the clickability gate) and the rows' words in
// tests/multiAttackRows.test.mts. What only the real app can show is that the expansion is
// REACHABLE with a click and that no category chip survives anywhere.
//
// FLOORS ONLY (AGENTS.md: frozen numbers rot). The live log decides what the selected fight used,
// so this asserts "an ability expanded, and its stats are inside" and notes on an empty selection.

const CHIP = '[data-testid="category-chip"]'
const SKILL = '[data-testid="skill-bar"]'
const STATS = '[data-testid="ability-stats"]'

/** The visible text of the first element matching `sel`, or '' when there is none. */
function textOf(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', sel)
}

export async function stepAbilityStats(page: Page): Promise<void> {
  // The dashboard opens on LEVEL 1 (JOS-35), so this step drills down to a source first — the
  // abilities belong to ONE source, and that is the level where a source is the subject.
  if (!(await drilled(page))) {
    await page.click('[data-testid="meter-row"]', { timeout: 15_000 }).catch(() => undefined)
    await settle(() => drilled(page), (d) => d, { timeoutMs: 10_000 })
  }

  // 1. NO CATEGORY CHIP. The strip the owner rejected must be gone — one bar per ability, flat.
  check('the drilled source shows NO category chip (JOS-113 removed the grouping layer)', (await inMeterPanel(page, CHIP)) === 0)

  const bars = await inMeterPanel(page, SKILL)
  if (bars === 0) {
    note('the drilled source dealt no damage in this selection — no ability bar to expand')
    return
  }
  check('…just one bar per ability, flat', bars >= 1, `${bars} abilities`)

  // 2. CLICKING A STAT-BEARING ABILITY EXPANDS IT IN PLACE. Most abilities are melee/slay swings
  //    (crit + miss are core stats there), so click each — a positional click at the BAR row, not
  //    a synthetic one, so React re-renders between awaits — until one opens its readout. A DoT
  //    tick is correctly inert and simply does not respond.
  const inPanel = page.locator(`[data-testid="dash-panel"] ${SKILL}`)
  let picked: string | null = null
  for (let i = 0; i < bars && picked === null; i++) {
    const bar = inPanel.nth(i)
    await bar.click({ position: { x: 12, y: 8 }, timeout: 5_000 }).catch(() => undefined)
    if ((await inMeterPanel(page, STATS)) >= 1) picked = ((await bar.textContent()) ?? '').split('·')[0]?.trim() ?? ''
  }
  const opened = picked !== null
  check('…and clicking a stat-bearing ability expands its stats INLINE, beneath its own bar', opened, picked ?? 'none expanded')
  if (!opened) return

  // 3. THE STATS ARE THE OWNER'S: crit is stated for every weapon swing; double/triple appear on
  //    the ability that multi-attacked (the auto-attack Melee, where the fixture has one).
  const body = await textOf(page, STATS)
  check('…whose figures include the crit rate', /crit/i.test(body), body.slice(0, 160).replace(/\s+/g, ' '))
  if (/double attack|triple attack|rounds/i.test(body)) {
    check('…and the double/triple attack it lists is over its ROUNDS (law 11)', /rounds/i.test(body))
  } else {
    note('the expanded ability opened no attack rounds — its multi-attack section correctly renders nothing')
  }

  // 4. THE OLD PANEL AND THE OLD LEVEL ARE GONE, everywhere on the page.
  check('the standalone multi-attack panel is gone', (await countOf(page, '[data-testid="multi-attack-panel"]')) === 0)
  check('and no category-drill level survives', (await countOf(page, '[data-testid="category-drill"]')) === 0)

  // 5. CLICKING AGAIN COLLAPSES IT — the list never gained a nav level, so the flat list is still
  //    right there and the SAME ability closes in place. Click the BAR row (y:8, above the now
  //    open readout) of the skill-bar that holds the stats, not its expanded body.
  const openBar = inPanel.filter({ has: page.locator(STATS) }).first()
  await openBar.click({ position: { x: 12, y: 8 }, timeout: 5_000 }).catch(() => undefined)
  await settleGone(page, STATS, { timeoutMs: 10_000 }).catch(() => undefined)
  check('…and clicking it again collapses the stats in place', (await inMeterPanel(page, STATS)) === 0)
  check('…while the ability list and its Back control stay put', await drilled(page))
}

// ── THE OPEN FIGHT LIST IS FROZEN (Task #61) ───────────────────────────────────────────

export async function stepFrozenList(page: Page, log: FixtureLog): Promise<void> {
  // 10b. FROZEN WHILE OPEN (Task #61, the churn fix). The snapshot ticks ~4x/sec while the
  //      user is fighting, and every tick rebuilds the option rows: a fight finalizes, the head
  //      row relabels itself from "Current fight (live)" to "Last fight — …", the old head drops
  //      into the history under its own id, and every row below shifts down one. That is what
  //      "it gets all confused as it's switching" was. The contract now is that the OPEN list is
  //      a snapshot taken at open time — no reorder, no insert, no removal — so what is under
  //      your pointer stays under your pointer.
  //
  //      IT USED TO BE VACUOUS HALF THE TIME. The claim only means something while the world is
  //      actually moving under the open list, so the step slept three seconds and hoped the owner
  //      was fighting; when he was not, it noted and asserted nothing. Now the HARNESS plays the
  //      fight (gameplay.mts) into the tailed fixture while the list is open, so "busy" is
  //      something this step CAUSES rather than something it waits to be lucky about.
  await openPicker(page)
  const frozenBefore = await listedValues(page)
  const churnA = await snapshot(page)

  // The pull is written with the picker OPEN — that is the whole scenario.
  const written = await playPull(log, () =>
    settle(() => snapshot(page), (s) => s.recent.length !== churnA.recent.length, { timeoutMs: 8_000 })
  )
  // …and the churn we wait for is the engine's own view of the world moving: a fight opened, or
  // the selection's damage grew. Either is enough to have rebuilt the rows underneath.
  const churnB = await settle(
    () => snapshot(page),
    (s) =>
      !!s.segments.find((seg) => seg.kind === 'current') ||
      (s.selected?.outTotal ?? 0) !== (churnA.selected?.outTotal ?? 0),
    { timeoutMs: 15_000 }
  )
  const frozenAfter = await listedValues(page)
  const busy =
    !!churnB.segments.find((s) => s.kind === 'current') ||
    churnA.segments.length !== churnB.segments.length ||
    (churnA.selected?.outTotal ?? 0) !== (churnB.selected?.outTotal ?? 0)
  const sameList =
    frozenBefore.length === frozenAfter.length && frozenBefore.every((v, i) => v === frozenAfter[i])
  check(
    'the world moved under the open list — the harness played a fight into the tailed log',
    busy,
    `${String(written)} lines written · ${String(churnA.recent.length)} → ${String(churnB.recent.length)} in the ring`
  )
  check(
    'the OPEN fight list is frozen — a live fight changes neither its rows nor their order',
    sameList,
    `${frozenBefore.length} rows → ${frozenAfter.length} rows${sameList ? '' : ` (was ${frozenBefore.slice(0, 4).join(',')} · now ${frozenAfter.slice(0, 4).join(',')})`}`
  )
  await closePicker(page)
}

/**
 * THE LIVE TAIL, SCRIPTED (step 8 of the combat spec, rewritten in wave E2).
 *
 * It used to poll for 45 seconds hoping the owner was mid-fight, then assert a floor. Now the
 * harness plays a pull whose damage it STATES (gameplay.mts: ten hits, 442 points, four seconds)
 * and asserts the engine's arithmetic exactly.
 *
 * The pre-condition matters and is asserted rather than assumed: no fight may be OPEN when the
 * pull starts, or the scripted swings would join the fixture's last encounter as a second target
 * and the total would be that fight's, not this one's.
 */
export async function stepScriptedPull(page: Page, log: FixtureLog): Promise<Snap> {
  const quiet = await settle(() => snapshot(page), (s) => !s.segments.some((x) => x.kind === 'current'), {
    timeoutMs: 90_000,
    pollMs: 500
  })
  if (
    !check(
      'the fixture’s own fights have all closed before the scripted pull opens one',
      !quiet.segments.some((s) => s.kind === 'current'),
      quiet.segments.find((s) => s.kind === 'current')?.name ?? 'none open'
    )
  ) {
    return quiet
  }
  const before = quiet.recent.length
  const written = await playPull(log, () =>
    settle(() => snapshot(page), (s) => s.recent.length > before, { timeoutMs: 8_000 })
  )
  check('the harness wrote the whole pull into the tailed log', written === PULL_LINES, `${String(written)} lines`)

  // The ring is capped, so its LENGTH is not the claim — that it GREW from the live tail is.
  const after = await settle(() => snapshot(page), (s) => s.recent.length > before, { timeoutMs: 15_000 })
  check(
    'the live tail carried the scripted lines into the classification ring',
    after.recent.length > before,
    `${String(before)} → ${String(after.recent.length)} lines in the ring`
  )
  // WAIT FOR THE DOM CONDITION, NOT FOR THE IPC ONE (JOS-510). Every `settle` above reads
  // `snapshot(page)`, which calls `window.eq.getCombatSnapshot` DIRECTLY — it bypasses the React
  // tree, so it reports what MAIN holds, not what has been painted. Reading the DOM bare on the
  // next line therefore assumed the render had already happened, which is a bet on scheduling and
  // is the one thing this suite's own vocabulary says never to do.
  //
  // It was a bet that usually won and now wins less often: the served-data store coalesces its
  // pushes onto an animation frame, and an e2e window is NEVER COMPOSITED, so it always takes the
  // fallback timer rather than a real frame. Nothing about the claim changes — if the lines never
  // render, this settles at 0 and the check still fails.
  const LOG_ROW = '[data-testid="combat-log"] > div'
  const rendered = await settle(() => countOf(page, LOG_ROW), (n) => n >= 1, { timeoutMs: 8_000 })
  check('…and the combat log renders them', rendered >= 1, `${String(rendered)} rendered`)

  // THE POINT OF ALL OF IT: an EXACT number. The pull states its own damage, so the engine's
  // total is not a floor to be satisfied — it is an arithmetic identity to be checked.
  const exact = await settle(() => snapshot(page), (s) => (s.selected?.outTotal ?? 0) === PULL_DAMAGE, {
    timeoutMs: 20_000
  })
  check(
    'the scripted pull’s damage lands EXACTLY, not approximately',
    Math.round(exact.selected?.outTotal ?? -1) === PULL_DAMAGE,
    `${String(Math.round(exact.selected?.outTotal ?? -1))} of ${String(PULL_DAMAGE)} points`
  )
  check(
    '…on a fight named after the mob the harness pulled',
    (exact.selected?.name ?? '').includes(PULL_TARGET.replace(/^a /, '')),
    exact.selected?.name ?? 'no selection'
  )
  return exact
}

/**
 * 6b. THE METER SCOPE — You / Group / Everyone (docs/plans/group-model.md §2), a different axis
 * from the Fight|Overall toggle: that one says WHICH segment, this one says WHOSE damage in it.
 *
 * IT IS NO LONGER A CONTROL ON THIS SURFACE (JOS-115, owner: the selector "is shown INLINE on
 * every combat surface and is too crowded"). It is ONE preference in Preferences > Combat, and
 * the Combat tab keeps only the READOUT — because a meter that is filtering rows out has to be
 * able to say so where the rows are missing. So this step walks the new shape: the chip is gone,
 * the word is there, changing the preference two tabs away changes what this meter shows, and the
 * roster popover (which was never a scope control) still opens.
 *
 * THE ROSTER STATE IS NOT ASSERTED, because it belongs to whatever the log happens to contain: a
 * log with group lines in it leaves `seen: true`, one without leaves `seen: false`, and both are
 * correct. What IS asserted is that the readout and the popover AGREE about which of the two it
 * is — the pairing is the identity, and it is the one that can actually break. They are separate
 * sentences derived from one flag, and a Group scope silently narrowing while the popover says it
 * is showing everyone is precisely the lie this surface exists to prevent.
 */
export async function stepMeterScope(page: Page): Promise<void> {
  check(
    'the inline You/Group/Everyone control is GONE from the combat toolbar (JOS-115)',
    (await countOf(page, RETIRED_SCOPE_CHIP)) === 0
  )
  check('…replaced by a readout of the preference', (await countOf(page, SCOPE_LABEL_SEL)) === 1)

  const label = async (): Promise<string> => (await page.textContent(SCOPE_LABEL_SEL))?.trim() ?? ''

  // THE DEFAULT IS EVERYONE (JOS-229). It was Group, on the argument that an empty roster falls
  // back to Everyone anyway — which covers the empty roster and not the incomplete one, and an
  // incomplete roster is a missing player's bars with no word to explain them. One unambiguous
  // sentence now: no fallback wording, because nothing is being filtered.
  const first = await label()
  check('it defaults to Everyone', first === 'Everyone', first)
  // …and the PREFERENCE agrees, on a profile that has never written the key: an absent value is
  // Everyone, and the control has to say so too — the readout alone could not tell "chosen
  // Everyone" from "defaulted to Everyone", and only one of those is the claim.
  const chosen = await scopeFromPrefs(page, 'nav-combat')
  await settleCount(page, '[data-testid="combat-dashboard"]', 1, { timeoutMs: 20_000 })
  check('an absent preference resolves to Everyone in the control too', chosen === 'everyone', chosen)
  const baseline = await settle(() => meterRows(page), (n) => n > 0, { timeoutMs: 15_000 })

  // THE PREFERENCE APPLIES. Setting it two tabs away is the whole control now, and the CONDITION
  // each write produces is this surface's own next word.
  //
  // WAIT FOR THE BODY, not just for the header. Coming back from Preferences REMOUNTS this view,
  // and its first frames render the hydrating skeleton while the first snapshot is in flight — the
  // header (and this readout with it) is already there, so settling on the WORD alone would count
  // the meter's rows before the meter had any. `combat-dashboard` is the body, and it exists only
  // once there is a segment to rank.
  //
  // The wanted word is a PREDICATE rather than a string, because Group has two legal spellings and
  // which one this log produces is not this spec's business (see the popover pairing below).
  const setTo = async (scope: Scope, want: (t: string) => boolean): Promise<string> => {
    await setMeterScope(page, scope, 'nav-combat')
    await settleCount(page, '[data-testid="combat-dashboard"]', 1, { timeoutMs: 20_000 })
    return settle(label, want, { timeoutMs: 8_000 })
  }

  const groupWord = await setTo('group', (t) => t.startsWith('Group'))
  check('choosing Group in Preferences reaches the Combat tab', groupWord.startsWith('Group'), groupWord)
  // Which of the two Group states this log leaves behind — the popover pairing at the end of this
  // step is the one that cares, and it now learns it HERE rather than from the opening readout.
  const noRoster = groupWord === 'Group (no roster yet)'
  // The row count has to have STOPPED MOVING before it means anything: the panel is fed by a
  // snapshot that arrives a beat after the remount, so a reading taken on the first frame is a
  // reading of an empty meter (settleStable's argument, spelled with a floor).
  const group = await settle(() => meterRows(page), (n) => n > 0, { timeoutMs: 15_000 })
  // NARROWING NEVER WIDENS. Equal is legal and expected on the law-1 fallback, where Group renders
  // as Everyone; more rows under Group than under Everyone would mean the filter added somebody.
  check('Group shows no more than Everyone did', group <= baseline, `${group} vs ${baseline}`)

  check('…and so does choosing You', (await setTo('you', (t) => t === 'You')) === 'You', await label())
  // NO SCOPE EVER HIDES YOU OR YOUR PETS. The rows here are yours and your pets' — they must
  // survive every scope, and only a member row may ever go.
  const you = await settle(() => meterRows(page), (n) => n > 0, { timeoutMs: 15_000 })
  check('You scope keeps your own rows — only a member is ever filtered', you >= 1 && you <= group, `${you} of ${group}`)

  // PERSISTED: the choice survives leaving the tab and coming back, because it is a stored
  // preference and not component state.
  await page.click('[data-testid="nav-overview"]')
  await settleCount(page, '[data-testid="overview-grid"]')
  await page.click('[data-testid="nav-combat"]')
  await settleCount(page, SCOPE_LABEL_SEL)
  check('the scope is remembered across a tab round trip', (await settle(label, (t) => t === 'You')) === 'You', await label())

  // The roster popover (G3) — the answer to "who does the app think is with me, and why". Still a
  // control, and deliberately so: correcting a mis-inferred group is a different act from choosing
  // a scope, and it belongs where the missing rows are.
  await page.click('[data-testid="roster-open"]')
  const opened = await settleCount(page, '[data-testid="roster-popover"]')
  check('the roster popover still opens beside the readout', opened === 1)
  const popover = (await page.textContent('[data-testid="roster-popover"]'))?.toLowerCase() ?? ''
  check('…and offers the add box for the join line the log never carried', popover.includes('add'))
  if (popover.includes('nobody on the roster') || popover.includes('no group signal')) {
    // THE PAIRING. An empty roster says which KIND of empty it is, and the sentence has to match
    // the readout: `seen: false` falls back to Everyone (law 1), `seen: true` means the group
    // ended and Group really is narrowing to you and your pets.
    check(
      'the empty roster and the readout tell the same story',
      noRoster ? popover.includes('no group signal') : popover.includes('nobody on the roster'),
      `readout=${first} · popover=${popover.slice(0, 70)}`
    )
    check(
      '…and only the law-1 fallback claims to be showing everyone',
      noRoster ? popover.includes('showing everyone') : !popover.includes('showing everyone'),
      popover.slice(0, 90)
    )
  } else {
    note('the log left real members on the roster — the empty-state wording was not exercised')
  }

  // Close the popover and put the preference back on its default, so nothing downstream inherits
  // a narrowed meter.
  await page.keyboard.press('Escape')
  await settleGone(page, '[data-testid="roster-popover"]', { timeoutMs: 8_000 })
  await setMeterScope(page, 'everyone', 'nav-combat')
  await settleCount(page, '[data-testid="combat-dashboard"]', 1, { timeoutMs: 20_000 })
  check(
    'the meter is left on its Everyone default',
    (await settle(label, (t) => t === 'Everyone', { timeoutMs: 8_000 })) === 'Everyone',
    await label()
  )
}

/**
 * THE PET NOBODY ASKS ABOUT (JOS-49) — the last step of the run, deliberately, because it opens
 * a fight and leaves it open.
 *
 * JOS-47 shipped a QUESTION here: an unbound pet-shaped entity fighting beside you put
 * "<Name> — your pet?" above the bars, with Yes and No. The owner cut it —
 *
 *     "just cut out the 'is this my pet question' - if you just have to pet attack once,
 *      this is a lot of work we can get wrong."
 *
 * — so this step asserts an ABSENCE and then a CURE, which is the pair that says the deletion
 * was clean rather than merely quiet. An absence is asserted with the settle vocabulary
 * (`settleStable`: wait for the reading to stop changing, THEN assert nothing is there), never
 * by looking once and finding nothing yet.
 *
 * The pet is written by the harness (gameplay.playPetPull): a proper-named entity that fights the
 * two mobs you fight, never swings at you, and speaks one of the six pet-voiced sentences — the
 * strongest evidence the old detector had, and now inert. Then `playPetOrder` orders it, and the
 * private tell it answers with is the one line in this log that binds a summoned pet.
 */
export async function stepPetNeverAsked(page: Page, log: FixtureLog): Promise<void> {
  const OFFER = '[data-testid="pet-claim-offer"]'
  // Earlier steps leave a FINALIZED fight selected (the picker and the search both land on one).
  // Return to the head row: the live fight is where a question would have been asked.
  await openPicker(page)
  await page.click('li[data-value="__live__"]', { timeout: 15_000 })
  await closePicker(page)

  const written = playPetPull(log)
  check('the harness wrote the unbound pet into the tailed log', written === PET_PULL_LINES, `${String(written)} lines`)

  // The lines ARRIVED — otherwise every absence below is vacuous. Your own two swings are the
  // proof, because they are the half of the same bursts the meter is allowed to show.
  const petOf = (s: Snap): SnapEntity | undefined =>
    s.selected?.entities.find((e) => e.kind === 'pet' && e.name.replace(/\s+\(\d+\)$/, '') === PET_NAME)
  const landed = await settle(() => snapshot(page), (s) => (s.selected?.outTotal ?? 0) >= 78, { timeoutMs: 20_000 })
  if (!check('the scripted pull reached the meter', (landed.selected?.outTotal ?? 0) >= 78, `${String(Math.round(landed.selected?.outTotal ?? 0))} points`)) {
    return
  }

  // THE ABSENCE. Let the reading settle, then assert the three things that are gone.
  const settled = await settleStable(() => snapshot(page).then((s) => JSON.stringify(petOf(s) ?? null)), {
    timeoutMs: 10_000
  })
  check('the unbound pet gets NO row — the blind spot is accepted, not papered over', settled === 'null', settled)
  check(
    '…and the meter asks no question about it, on any surface',
    (await settleCount(page, OFFER, { timeoutMs: 5_000 })) === 0
  )
  check(
    '…nor is there a question in the snapshot for a surface to render',
    !('petClaims' in (await snapshot(page))),
    'CombatSnapshot carries no petClaims'
  )

  // THE CURE, and the whole of the owner's answer: order it once.
  const ordered = playPetOrder(log)
  check('the harness ordered the pet', ordered === PET_ORDER_LINES, `${String(ordered)} lines`)
  const bound = await settle(() => snapshot(page), (s) => petOf(s) !== undefined, { timeoutMs: 20_000 })
  const row = petOf(bound)
  if (!check('one pet command puts the pet on the meter', !!row, row ? row.name : 'still no pet row')) return
  // A TELL BINDS FORWARD, NOT BACKWARD (measured, JOS-49): the row is the ONE hit that landed
  // after the tell, and the three that came before it stay unattributed. That is the honest cost
  // of ordering late, and it is why the instruction is "order it when you summon it".
  check(
    '…and the row is what it did AFTER the order — a tell does not reach backwards',
    row?.total === PET_BOUND_DAMAGE,
    `${String(row?.total ?? 0)} of ${String(PET_BOUND_DAMAGE)} (unbound ${String(PET_UNBOUND_DAMAGE)} stays invisible)`
  )
}

/** The pet rows are matched on the display name with the spawn-generation ` (N)` suffix off —
 *  `WorldModel.label()` appends one and it appears in no log line (world-model law 2). */
const petRowFor = (s: Snap, name: string): SnapEntity | undefined =>
  s.selected?.entities.find((e) => e.kind === 'pet' && e.name.replace(/\s+\(\d+\)$/, '') === name)

/**
 * THE OTHER CURE: `/pet who leader` (JOS-52) — runs straight after `stepPetNeverAsked` and
 * inherits its bound pet, because the point is the SUCCESSION as much as the bind.
 *
 * This is the only place the rule can be proved end to end. Its whole guard is that the leader
 * the pet names is the TAILED CHARACTER, and that name arrives from the session
 * (session.ts `resetWorldFor` → rulesets.ts `installCharacterName`), never from a constant. A
 * unit test installs it by hand; only a real launch proves the product does — and the harness
 * tails `eqlog_Primitive_freeport.txt`, so the answer has to name Primitive to work at all.
 */
// ── THE DPS LEGEND SWITCHES ITS OWN LINES OFF (JOS-264) ────────────────────────────────────
//
// From a report of the chart read from across a room: four curves plus four marker colours in one
// small plot, and the ask was to be able to put some of it away. The geometry is node-tested
// (tests/dpsChartLines.test.mts) and so is the stored vocabulary (tests/combatPrefs.test.mts).
// What only the real app can show is the part those two cannot see:
//   * the legend entry is WIRED to the drawing — a click removes that line's element from the SVG;
//   * hiding is REVERSIBLE, because the entry it was made from is still on screen (dimmed) rather
//     than deleted. A legend that removed its own entries would be a one-way door, and no unit
//     test can tell "styled as off" from "gone";
//   * it SURVIVES THE TAB SWITCH, which is the whole reason this is a stored pref rather than a
//     useState (AGENTS.md: prove it by navigating and asserting the view was GONE first);
//   * and ALL LINES OFF renders a card, not a crash or an empty box.
//
// It leaves the legend exactly as it found it, so no step after this one inherits a hidden line.

const LEGEND_KEYS = ['out', 'pet', 'group', 'inc'] as const
const DPS_PLOT = '[data-testid="dps-plot"]'
const legendSel = (k: string): string => `[data-testid="chart-legend-${k}"]`
const lineSel = (k: string): string => `[data-testid="dps-line-${k}"]`

/** '1' when the entry says its line is hidden, '0' when drawn, '' when there is no such entry —
 *  the control's own account of the state, which is what the user reads off the strip. */
function legendHidden(page: Page, k: string): Promise<string> {
  return page.evaluate((sel) => document.querySelector(sel)?.getAttribute('data-hidden') ?? '', legendSel(k))
}

/** The curve entries this fight actually has. `pet`/`group`/`incoming` appear only when the fight
 *  had one, so the set is log-dependent and is read rather than assumed. */
async function legendEntries(page: Page): Promise<string[]> {
  const found: string[] = []
  for (const k of LEGEND_KEYS) {
    if ((await countOf(page, legendSel(k))) === 1) found.push(k)
  }
  return found
}

export async function stepChartLegendToggles(page: Page): Promise<void> {
  // The outgoing entry exists whenever the curve is drawn at all; no curve is a NOTE, the same
  // convention the hover step uses for a ringless or damage-free selection.
  if ((await countOf(page, legendSel('out'))) === 0) {
    note('the DPS-over-time curve is not drawn for this selection - its legend is not asserted this run')
    return
  }
  const entries = await legendEntries(page)
  check('every drawn line has a legend entry', entries.includes('out'), entries.join(' · '))

  // 1. ONE CLICK TAKES A LINE OFF THE PLOT — and leaves the entry that says so.
  await page.click(legendSel('out'), { timeout: 15_000 })
  check('clicking a legend entry takes its line off the chart', await settleGone(page, lineSel('out'), { timeoutMs: 10_000 }))
  check('…and the shaded area under it goes with it, not on its own', (await countOf(page, '[data-testid="dps-area"]')) === 0)
  check(
    'THE ENTRY STAYS IN THE LEGEND, DIMMED — hidden is a state you can see and undo',
    (await countOf(page, legendSel('out'))) === 1 && (await legendHidden(page, 'out')) === '1',
    `entry ${String(await countOf(page, legendSel('out')))}, data-hidden=${await legendHidden(page, 'out')}`
  )

  // 2. …AND IT SURVIVES THE TAB SWITCH. A `useState` here would pass every check above and lose
  //    the choice on the way to the Overview tab — the JOS-90/97/116 bug, which is why the value
  //    is a renderer pref.
  const left = await leaveCombat(page)
  if (check('leaving the Combat tab unmounts it', left) && (await returnToCombat(page))) {
    const still = await settle(() => legendHidden(page, 'out'), (v) => v === '1', { timeoutMs: 10_000 })
    check('A HIDDEN LINE SURVIVES LEAVING AND RETURNING TO THE COMBAT TAB', still === '1', `data-hidden=${still}`)
    check('…and the line is still off the plot, not merely remembered', (await countOf(page, lineSel('out'))) === 0)
  }

  // 3. REVERSIBLE from the entry it left behind.
  await page.click(legendSel('out'), { timeout: 15_000 })
  check('clicking the dimmed entry draws its line again', (await settleCount(page, lineSel('out'), 1, { timeoutMs: 10_000 })) === 1)
  check('…and the entry reads as drawn again', (await legendHidden(page, 'out')) === '0')

  // 4. EVERY LINE OFF is a legal state: a note where the plot was, the legend still under it.
  for (const k of entries) await page.click(legendSel(k), { timeout: 15_000 })
  check('with every line hidden the card draws no plot at all', await settleGone(page, DPS_PLOT, { timeoutMs: 10_000 }))
  check('…and says so, rather than rendering an empty box', /every line is hidden/i.test(await combatText(page)))
  check('…with the whole legend still there to switch one back on', (await legendEntries(page)).length === entries.length)
  check('…and the dashboard still standing', (await countOf(page, '[data-testid="combat-dashboard"]')) === 1)

  // 5. Put it back the way it was found.
  for (const k of entries) await page.click(legendSel(k), { timeout: 15_000 })
  const back = await settleCount(page, DPS_PLOT, 1, { timeoutMs: 10_000 })
  check('switching them back on restores the chart', back === 1 && (await countOf(page, lineSel('out'))) === 1)
}

export async function stepPetAnswersWhoLeads(page: Page, log: FixtureLog): Promise<void> {
  const asked = playPetLeaderAnswer(log)
  check('the harness asked the new pet who its leader is', asked === PET_LEADER_LINES, `${String(asked)} lines`)
  const after = await settle(() => snapshot(page), (s) => petRowFor(s, PET_LEADER_NAME) !== undefined, {
    timeoutMs: 20_000
  })
  const heir = petRowFor(after, PET_LEADER_NAME)
  if (!check('a pet that NAMES YOU ITS LEADER lands on the meter', !!heir, heir ? heir.name : 'no row')) return
  check(
    '…forward only, exactly like the tell — the hit before the answer stays invisible',
    heir?.total === PET_LEADER_BOUND_DAMAGE,
    `${String(heir?.total ?? 0)} of ${String(PET_LEADER_BOUND_DAMAGE)} (unbound ${String(PET_LEADER_UNBOUND_DAMAGE)} dropped)`
  )
  // ONE PET AT A TIME (JOS-54), through the whole product: binding the successor retired the
  // predecessor, so its LATER swing is nobody's — while everything it earned while it was yours
  // stays exactly where it was. Settle first: an unchanged number is an absence, and an absence
  // is asserted by waiting for the reading to stop moving.
  const held = await settleStable(
    () => snapshot(page).then((s) => String(petRowFor(s, PET_NAME)?.total ?? -1)),
    { timeoutMs: 10_000 }
  )
  check(
    `the retired pet keeps its ${String(PET_BOUND_DAMAGE)} and earns nothing more — one pet at a time`,
    held === String(PET_BOUND_DAMAGE),
    `${held} (the ${String(PET_RETIRED_DAMAGE)} it swung after the succession is not yours)`
  )
}
