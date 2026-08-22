// THE ZONE HALF of the app-wide timeslice, on the Leveling tab (JOS-130) — living next door
// because leveling.e2e.mts sits AT the repo max-lines budget and the rule here is to SPLIT, never
// ratchet (drill.mts set the precedent; dropSteps.mts, combatSteps.mts and plannerSteps.mts
// followed it). The spec still owns the ORDER, the launch and the dashboard readout it hands in.
//
// WHY THIS IS ITS OWN STEP AND NOT ANOTHER RUNG OF THE TIMESCALE ONE. Every other slice replaces
// the drawn WINDOW, and the timescale step is built on exactly that: the strip re-cuts, a stale
// selection is dropped, the hover re-maps. `Zone` does the opposite — it is the whole record
// restricted to the zone the log last named, so the curve keeps its domain and only the
// arithmetic under it moves. Asserting that asymmetry as a PAIR is the point: a refactor that
// flattened the zone filter into a time window would still pass every check over there.
//
// IT ALSO CARRIES THE BAR'S SHAPE (JOS-301): with `Zone` in force every control of the scope is
// mounted at once, which is the only state in which "one row of controls, one line under them" can
// be measured at all — so the layout claim is asserted from inside the step that creates it.
//
// WHAT NO UNIT TEST CAN REACH: `tests/timeslice.test.mts` pins the definitions and the partition
// identity over a hand-built snapshot. It cannot see that the button in the real app resolves the
// real progression module's last zone line, hands one `zoneKey` down through `scopedStats` into
// `rangeStats`, and comes back to `All` with every rendered number byte for byte.

import type { Page } from 'playwright-core'
import { check, countOf, note, settle } from './appHarness.mjs'
import type { FixtureLog } from './logFixture.mjs'

const TS_WINDOW = '[data-testid="leveling-slice-window"]'
/** The ONE caption line under the row of controls (JOS-301) — both clauses live inside it. */
const CAPTION = '[data-testid="leveling-scope-caption"]'
/** The two toggle groups of the scope row, read for the pick in force (JOS-332). */
const TIER = '[data-testid="leveling-tier"]'
const BASIS = '[data-testid="leveling-basis"]'
/** The elapsed span the panel says its numbers cover — `RangeStats.durationMs`, which under a zone
 *  slice is Σ of the ADMITTED VISITS. The number the owner's bug report was about. */
const DURATION = '[data-testid="leveling-range-duration"]'
const LOOT_SLICE = '[data-testid="loot-slice"]'
const LOOT_SUMMARY = '[data-testid="loot-summary"]'
const LOOT_RATES = '[data-testid="loot-rates"]'
/** THE SESSION SPLIT (JOS-436) — the reset button and the history picker it creates. */
const NEW_SESSION = '[data-testid="loot-slice-new-session"]'
const SESSION_LIST = '[data-testid="loot-slice-session-list"]'
const SESSION_BUTTON = `${SESSION_LIST} [role="combobox"]`
/** The custom slice's `To` field — the control the report was literally about. */
const CUSTOM_TO = '[data-testid="loot-slice-custom-to"]'
/** What the appended drop is called. Distinctive enough that a miscount is readable. */
const NEW_DROP = 'Mote of Major Potential'
/** Narrowest first. Any of these is a real cut of the ledger; `custom` is not one until somebody
 *  types two instants into it, so it is deliberately never a candidate. */
const NARROW_ORDER = ['h1', 'h6', 'h24', 'd7', 'session', 'zone'] as const

/** Where a mounted box sits, in viewport coordinates; null when it isn't mounted. */
function boxOf(page: Page, sel: string): Promise<{ top: number; bottom: number; h: number } | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }
  }, sel)
}

/** Rendered text of the first match; '' when the node isn't mounted. */
function textOf(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', sel)
}

/** The slice ids one surface's control is offering. No SliceId carries a hyphen, which is what
 *  lets this drop the caption (`-window`) and the custom range's two inputs from the same prefix. */
function offeredSlices(page: Page, prefix: string): Promise<string[]> {
  return page.evaluate((p) =>
    Array.from(document.querySelectorAll(`[data-testid^="${p}-"]`))
      .map((e) => (e.getAttribute('data-testid') ?? '').replace(`${p}-`, ''))
      .filter((id) => id.length > 0 && id !== 'window' && !id.includes('-')), prefix)
}

/**
 * THE SCOPE IS ONE ROW OF CONTROLS WITH ONE LINE UNDER IT (JOS-301, owner feedback 2026-08-13).
 *
 * The bar used to arrive as three stacked bars — slice buttons and their caption, the tier toggle
 * alone, the basis toggle and its caption — which the owner called unbalanced from a screenshot of
 * this tab. The fix is a LAYOUT, so only a real render can hold it: `tests/zoneScope.test.mts` pins
 * which components `ScopeBar` composes and cannot see what a browser then does with them.
 *
 * It is measured with `Zone` in force because that is the only state in which all three controls
 * are mounted (the tier toggle is drawn exactly while the slice carries a zone), and it is measured
 * WIDE — the row is allowed to wrap by group at the app's narrow end, which is a degradation rather
 * than a violation, and `stepNarrowLayout` is what keeps that end honest.
 */
async function checkScopeRow(page: Page): Promise<void> {
  const slice = await boxOf(page, '[data-testid="leveling-slice"]')
  const tier = await boxOf(page, '[data-testid="leveling-tier"]')
  const basis = await boxOf(page, '[data-testid="leveling-basis"]')
  const caption = await boxOf(page, CAPTION)
  if (!check('the scope draws its three controls and one caption line', !!slice && !!tier && !!basis && !!caption)) return
  // Rounded tops within a couple of pixels: they are centred in one flex row and the two toggle
  // groups are the same height, so this is an alignment claim and not a font measurement.
  const level = Math.max(Math.abs(tier.top - slice.top), Math.abs(basis.top - slice.top))
  check(
    'every control sits on ONE level — the buttons are one row, not three stacked bars',
    level <= 2,
    `slice y=${String(slice.top)} · tier y=${String(tier.top)} · basis y=${String(basis.top)}`
  )
  check(
    '…and the description is on its own line BELOW them, not inline with the buttons',
    caption.top >= slice.bottom,
    `controls end at ${String(slice.bottom)}, caption starts at ${String(caption.top)}`
  )
  const words = (await textOf(page, CAPTION)).replace(/\s+/g, ' ')
  check(
    '…carrying BOTH clauses as one sentence — which stretch, and per hour of what',
    words.includes('→') && /rates per hour of (elapsed|active) time/.test(words),
    words
  )
  // One LINE, not a paragraph: the caption keeps the compact-bar contract, so a second line of it
  // would be the imbalance coming straight back in the other direction.
  check('…on a single line', caption.h <= 24, `${String(caption.h)}px tall`)
  await checkToggleTitles(page)
}

/**
 * EVERY TOGGLE IN THE SCOPE EXPLAINS ITSELF ON HOVER (JOS-304, owner feedback 2026-08-13: the two
 * pairs are *hard to understand*).
 *
 * The strings themselves are pinned as values next door (`tests/zoneScope.test.mts`,
 * `tests/rateBasis.test.mts`); what only a render can show is that the attribute survived the trip
 * through MUI's `ToggleButton` onto the element the pointer actually lands on. It does not: MUI
 * forwards unknown props to the underlying `button`, and that is precisely the kind of thing a
 * component-library bump breaks quietly. Measured from inside `checkScopeRow` because this is the
 * one moment both pairs are on the tab at once.
 *
 * Read as ALL FOUR BUTTONS OR NOTHING, since a per-button title is the whole point — a group that
 * explains only its selected half leaves the reader hovering the button they were thinking of
 * pressing and learning nothing.
 */
async function checkToggleTitles(page: Page): Promise<void> {
  const titles = await page.evaluate(() =>
    ['leveling-tier-allTiers', 'leveling-tier-exactTier', 'leveling-basis-elapsed', 'leveling-basis-active'].map(
      (id) => {
        const el = document.querySelector(`[data-testid="${id}"]`)
        return { id, title: el?.getAttribute('title') ?? '' }
      }
    )
  )
  const bare = titles.filter((t) => t.title.length === 0).map((t) => t.id)
  check(
    'every toggle in the scope carries its own native hover, selected or not',
    bare.length === 0,
    bare.length > 0 ? `no title on ${bare.join(', ')}` : titles.map((t) => t.id).join(', ')
  )
  // And the words are the two SIDES of each difference, not one sentence repeated: the tier pair
  // talks about which visits count, the basis pair about which hour divides.
  const by = (id: string): string => titles.find((t) => t.id === id)?.title ?? ''
  check(
    '…and the tier pair states the difference from either side',
    /at any tier/.test(by('leveling-tier-allTiers')) && /only the tier you are standing in/.test(by('leveling-tier-exactTier')),
    `${by('leveling-tier-allTiers')} || ${by('leveling-tier-exactTier')}`
  )
  check(
    '…as does the basis pair, each carrying the definition of its own hour',
    /Elapsed time = /.test(by('leveling-basis-elapsed')) && /Active time = /.test(by('leveling-basis-active')),
    `${by('leveling-basis-elapsed')} || ${by('leveling-basis-active')}`
  )
}

/** An element's attribute, or '' when the node is not mounted at all. */
function attrOf(page: Page, sel: string, attr: string): Promise<string> {
  return page.evaluate(
    ([s, a]) => document.querySelector(s)?.getAttribute(a) ?? '',
    [sel, attr] as const
  )
}

/**
 * 5d. THE SURFACES OPEN ON THIS TIER AND ELAPSED (owner ruling, JOS-332) — read before any control
 * on the tab has been touched.
 *
 * `tests/scopeSelection.test.mts` pins the OPENING as a value and `tests/zoneScope.test.mts` pins
 * what it does to the numbers. Neither can see what the tab actually comes up on: the opening has
 * to survive `useScopeSelection`'s hydrate from main, and a hydrate that arrived with the OLD
 * default would repaint the row a frame after mount and be invisible to every unit test in the
 * suite.
 *
 * The BASIS group is always drawn, so its default is asserted unconditionally. The TIER group is
 * drawn exactly while the slice carries a zone (`ZoneScopeBar`'s rule), which depends on whether
 * this log can define `Zone + Session` at all — so it is asserted here when it is up, and again
 * inside `stepZoneSlice` at the moment picking `Zone` brings it out, which no log can skip.
 */
export async function stepScopeDefaults(page: Page): Promise<void> {
  const basis = await settle(() => attrOf(page, BASIS, 'data-basis'), (b) => b !== '', { timeoutMs: 8000 })
  check('the tab opens on the ELAPSED hour', basis === 'elapsed', basis)
  const tier = await attrOf(page, TIER, 'data-scope')
  if (tier === '') {
    note('this log defines no zoned slice to open on, so the tier toggle is not drawn yet')
    return
  }
  check('…and on THIS TIER, the tier you are standing in', tier === 'exactTier', tier)
  const words = (await textOf(page, CAPTION)).replace(/\s+/g, ' ')
  check('…and the caption says so, over the numbers it is about', words.includes('this tier only'), words)
}

/**
 * 5e. THIS TIER NARROWS THE ELAPSED TIME, NOT JUST THE ROWS (JOS-332, the owner's bug report).
 *
 * *logged in to base Befallen open world, killed a while, switched to Befallen D2, killed ~5m; the
 * panel reads elapsed time 27m across all tiers despite this-tier being selected.*
 *
 * The arithmetic is pinned over that exact scenario in `tests/zoneScope.test.mts`. What only the
 * real app can show is that the toggle on this row reaches it: that pressing `every tier` widens
 * the span the panel prints and pressing `this tier` narrows it back, byte for byte, on a fixture
 * whose current camp the log genuinely spells more than one way.
 *
 * AND THAT THE ROW FOLLOWS A CHANGE MADE SOMEWHERE ELSE. The last two checks write through the
 * app's own bridge instead of clicking — that is the path the XP overlay's footer button takes, so
 * this is the main window proving it obeys a flip it did not make. `xp-overlay.e2e.mts` proves the
 * mirror direction with the overlay's own rendered button.
 *
 * e2e-leveling.log is the right fixture by accident of the owner's own play: its last zone line is
 * plain `Nagafen's Lair`, and the same camp appears as `- Solo`, `- Solo 1 (Awakened)`,
 * `- Solo 2 (Adaptive)` and `- Solo 3 (Fused)` earlier in the record. So the two memberships have
 * genuinely different answers here, and `exactTier` is the strictly narrower one.
 */
async function checkTierScopedElapsed(page: Page): Promise<void> {
  const exact = await settle(() => textOf(page, DURATION), (t) => t !== '', { timeoutMs: 8000 })
  check('the panel states the elapsed span its numbers cover', exact !== '', exact)
  check('…on THIS TIER, which is what the tab opened on', (await attrOf(page, TIER, 'data-scope')) === 'exactTier')

  await page.click('[data-testid="leveling-tier-allTiers"]', { timeout: 10_000 })
  const every = await settle(() => textOf(page, DURATION), (t) => t !== exact, { timeoutMs: 8000 })
  check(
    'pressing "every tier" WIDENS the elapsed span — the other tiers of the camp are back in',
    every !== exact,
    `this tier ${exact} → every tier ${every}`
  )
  const captionEvery = (await textOf(page, CAPTION)).replace(/\s+/g, ' ')
  check('…and the caption says which membership the span belongs to', captionEvery.includes('every tier'), captionEvery)

  // THE BROADCAST PATH, not the click path: this is exactly what the overlay's footer button does.
  await page.evaluate(() =>
    (window as unknown as { eq: { setScopeSelection: (p: unknown) => void } }).eq.setScopeSelection({
      zoneScope: 'exactTier'
    })
  )
  const back = await settle(() => textOf(page, DURATION), (t) => t === exact, { timeoutMs: 8000 })
  check(
    'a flip made OUTSIDE this row moves it, and restores the narrowed span byte for byte',
    back === exact,
    `${every} → ${back}`
  )
  check('…including the buttons themselves', (await attrOf(page, TIER, 'data-scope')) === 'exactTier')
}

/**
 * 5c. Pick `Zone`, prove the window stayed and the numbers moved, then come back to `All`.
 *
 * `readDashboard` is the spec's own readout of every scoped number on the tab — passed in rather
 * than re-implemented, so "byte for byte" means the same bytes here as it does over there.
 */
export async function stepZoneSlice(page: Page, readDashboard: () => Promise<string>): Promise<void> {
  if (!(await offeredSlices(page, 'leveling-slice')).includes('zone')) {
    note('this log has no zone line, so there is no current zone and the Zone preset is not offered')
    return
  }
  const allReadout = await readDashboard()
  const before = await textOf(page, TS_WINDOW)

  await page.click('[data-testid="leveling-slice-zone"]', { timeout: 10_000 })
  const after = await settle(() => textOf(page, TS_WINDOW), (t) => t !== before, { timeoutMs: 8000 })
  check('picking "Zone" names the zone in the caption', after.includes('·'), after.replace(/\s+/g, ' '))
  check(
    '…and leaves the drawn window where it was — a zone is a place, not a stretch of time',
    after.startsWith(before.trim()),
    `${before} → ${after}`.replace(/\s+/g, ' ')
  )
  check(
    '…while the numbers under it are re-derived for that zone alone',
    (await settle(() => readDashboard(), (t) => t !== allReadout, { timeoutMs: 8000 })) !== allReadout
  )

  // THE OPENING, at the one moment no log can skip: the tier group has just been drawn for the
  // first time and nothing has pressed it (JOS-332). `stepScopeDefaults` says the same thing at
  // mount, when the log can define a zoned slice to open on.
  check(
    '…and the membership it comes out on is THIS TIER, the owner ruled opening',
    (await attrOf(page, TIER, 'data-scope')) === 'exactTier',
    await attrOf(page, TIER, 'data-scope')
  )

  // Measured HERE because this is the one moment all three controls are on the tab at once.
  await checkScopeRow(page)
  // …and so is this: the tier toggle only means something while the slice carries a zone.
  await checkTierScopedElapsed(page)

  await page.click('[data-testid="leveling-slice-all"]', { timeout: 10_000 })
  const restored = await settle(() => readDashboard(), (t) => t === allReadout, { timeoutMs: 8000 })
  check('returning to All restores every number, byte for byte', restored === allReadout)
}

/**
 * THE SAME CONTROL ON THE LOOT LEDGER (JOS-130) — where it was asked for.
 *
 * Three claims, and the first is the owner's standing direction rather than a nicety: the ledger
 * comes up on ALL TIME, so a reader who never touches this sees their whole history and the
 * summary makes no claim about a slice. The second is the report itself — "what did I gain in
 * totality vs this session" — which is why the sliced count is stated BESIDE the all-time one
 * rather than replacing it, and why coming back to `All` has to restore the caption exactly.
 *
 * The third is JOS-261's, and it rides this step because it rides this control: the caption now
 * also states how FAST the slice is paying, and that rate follows the same pick the counts do
 * (`stepLootRates` below states what it checks and why a unit test cannot).
 */
export async function stepLootSlice(page: Page): Promise<void> {
  if (!check('the timeslice control is mounted on the Loot tab', (await countOf(page, LOOT_SLICE)) === 1)) return
  const all = await textOf(page, LOOT_SUMMARY)
  check('…and the ledger comes up on ALL TIME, hiding nothing', !all.includes('all time'), all.replace(/\s+/g, ' '))
  const allRates = await stepLootRates(page)

  const offered = await offeredSlices(page, 'loot-slice')
  const narrow = NARROW_ORDER.find((id) => offered.includes(id))
  if (!narrow) {
    note(`this log defines no slice narrower than All — the ledger offers only [${offered.join(', ')}]`)
    return
  }
  await page.click(`[data-testid="loot-slice-${narrow}"]`, { timeout: 10_000 })
  const cut = await settle(() => textOf(page, LOOT_SUMMARY), (t) => t !== all, { timeoutMs: 8000 })
  check(
    `picking "${narrow}" states the sliced count BESIDE the all-time one`,
    cut.includes('all time'),
    cut.replace(/\s+/g, ' ')
  )
  // The rate line follows the SAME pick — the whole reason it is on this tab is "how fast is the
  // grind I am in paying", and a rate that stayed on the whole log while the counts narrowed would
  // be the exact mismatch `useSliceLootRates` exists to prevent. A slice can honestly hold the same
  // drops as All (a fixture short enough that `1h` covers it), so this only asserts it re-derived.
  if (allRates !== '') {
    const cutRates = await textOf(page, LOOT_RATES)
    check(
      `…and the loot-per-hour line describes the ${narrow} slice too`,
      cutRates === '' || /drops\/hr .*active/.test(cutRates),
      `${allRates} → ${cutRates}`.replace(/\s+/g, ' ')
    )
  }

  await page.click('[data-testid="loot-slice-all"]', { timeout: 10_000 })
  const back = await settle(() => textOf(page, LOOT_SUMMARY), (t) => t === all, { timeoutMs: 8000 })
  check('…and All restores the whole ledger, caption and all', back === all, back.replace(/\s+/g, ' '))
  check('…including the loot-per-hour line, byte for byte', (await textOf(page, LOOT_RATES)) === allRates)
}

/** The two numbers the ledger caption states: how many rows are in the slice, and how many the
 *  whole record holds. The all-time half is only printed off `All`, where the two are equal — so
 *  null there is the caption being honest rather than a parse failure. */
async function summaryCounts(page: Page): Promise<{ sliced: number; total: number | null }> {
  const text = (await textOf(page, LOOT_SUMMARY)).replace(/\s+/g, ' ')
  const num = (m: RegExpMatchArray | null): number | null => (m ? Number(m[1].replace(/,/g, '')) : null)
  return { sliced: num(/^([\d,]+) loot events/.exec(text)) ?? -1, total: num(/of ([\d,]+) all time/.exec(text)) }
}

/** `<input type="datetime-local">`'s own spelling of an instant — local wall time, no zone. The
 *  same conversion `SliceBar.toLocalInput` does, re-derived here rather than imported: a test that
 *  shared the formatter with the code could not catch the formatter. */
function localInput(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * START A NEW SESSION NOW, ON THE DETAILS! RESET MODEL (JOS-436) — the whole ticket, end to end,
 * against a log that is genuinely still being written.
 *
 * *really it would be ideal to just say "start a new session" from now so i can pop a new session
 * when i reset the instance.*
 *
 * WHAT NO UNIT TEST CAN REACH. `tests/sessionSegments.test.mts` pins the tiling and — the part this
 * ticket is really about — that Σ over the segments equals the unsplit range for every denominator,
 * including across a silence that straddles the mark. It cannot see the button take a wall-clock
 * instant, hand it through `useTimeslice` into an open-ended custom range, and have the real loot
 * module's next delta land on the correct side of it. That is what happens here: the spec presses
 * the button and then LOOTS SOMETHING, and the three claims are the acceptance criteria verbatim —
 * the old session's totals are frozen and still selectable, the new one accrues from the click, and
 * the two of them still add up to the whole record.
 *
 * THE APPEND'S INSTANT IS AN INSTRUMENT, not a bet. EQ stamps whole SECONDS, so a line written in
 * the same second as the click could parse to an instant up to 999 ms BEFORE the mark and land in
 * the wrong session for reasons that have nothing to do with the code under test. Rounding up to the
 * next whole second past the click removes that entirely — the stamp is then strictly after the
 * mark, by construction rather than by timing luck.
 */
export async function stepNewSession(page: Page, log: FixtureLog): Promise<void> {
  if (!check('the ledger carries a one-click "New session"', (await countOf(page, NEW_SESSION)) === 1)) return
  check(
    '…and no session picker before the first press — one stretch of play is not a choice',
    (await countOf(page, SESSION_LIST)) === 0
  )
  const before = await summaryCounts(page)
  if (!check('the ledger is on All, so its count IS the whole record', before.total === null, String(before.total))) {
    return
  }

  await page.click(NEW_SESSION, { timeout: 10_000 })
  const at = new Date(Math.ceil((Date.now() + 1000) / 1000) * 1000)
  const cut = await settle(() => textOf(page, LOOT_SUMMARY), (t) => /session 2/.test(t), { timeoutMs: 8000 })
  check('pressing it opens session 2, and the caption says which session you are reading', /session 2/.test(cut),
    cut.replace(/\s+/g, ' '))
  check('…and the picker appears, now that there are two stretches to choose between',
    (await countOf(page, SESSION_LIST)) === 1)
  const opened = await summaryCounts(page)
  check(
    '…holding nothing yet: the new session starts at the CLICK, not at the newest log line',
    opened.sliced === 0 && opened.total === before.sliced,
    `${String(opened.sliced)} of ${String(opened.total)} · was ${String(before.sliced)}`
  )

  log.appendAt(at, `--You have looted a ${NEW_DROP} from a decaying skeleton corpse.--`)
  const grown = await settle(() => summaryCounts(page), (c) => c.sliced > 0, { timeoutMs: 25_000 })
  check(
    'a drop looted AFTER the click accrues to the new session, and only to it',
    grown.sliced === 1,
    `${String(grown.sliced)} of ${String(grown.total)} all time`
  )

  await stepBrowseOldSession(page, before.sliced)
  await stepFutureEndSticks(page)
  await page.click('[data-testid="loot-slice-all"]', { timeout: 10_000 })
  const back = await settle(() => summaryCounts(page), (c) => c.total === null, { timeoutMs: 8000 })
  check('All restores the whole ledger, the new drop included', back.sliced === before.sliced + 1,
    `${String(back.sliced)} · was ${String(before.sliced)}`)
}

/**
 * THE OLD REFERENCE IS KEPT (the owner's words) — browse back to it and prove it did not move.
 *
 * Details! rule 4: browsing is a pick, not a mutation. Session 1 must hold exactly what the whole
 * ledger held at the instant of the click — not one row more, even though the record has grown
 * since — and the two sessions must still tile the record between them.
 */
async function stepBrowseOldSession(page: Page, atClick: number): Promise<void> {
  await page.click(SESSION_BUTTON, { timeout: 10_000 })
  await page.click('[data-testid="loot-slice-session-opt-1"]', { timeout: 10_000 })
  const said = await settle(() => textOf(page, LOOT_SUMMARY), (t) => /session 1/.test(t), { timeoutMs: 8000 })
  if (!check('the history picker offers the closed session, and picking it names it in the caption',
    /session 1/.test(said), said.replace(/\s+/g, ' '))) return
  const read = await summaryCounts(page)
  check(
    'the session the reset closed is still selectable, holding exactly what it held at the click',
    read.sliced === atClick,
    `session 1 has ${String(read.sliced)}, the ledger had ${String(atClick)} when the button was pressed`
  )
  check(
    '…and the two sessions tile the record — every drop is in exactly one of them',
    read.total !== null && read.sliced + 1 === read.total,
    `${String(read.sliced)} + 1 vs ${String(read.total)} all time`
  )
}

/**
 * THE SYMPTOM THE AFFORDANCE OBVIATES, FIXED IN PASSING (JOS-436): *cannot select a future date on
 * the end time.*
 *
 * The field used to re-render from the CLAMPED slice, so an end past the newest log line snapped
 * straight back to it while the reporter was typing. The clamp itself is right and stays — nothing
 * happened after the last line — so what moved is which range the control DISPLAYS. Only a real
 * render can show it: the value is written by React on every commit, and no unit test holds a
 * controlled input across one.
 */
async function stepFutureEndSticks(page: Page): Promise<void> {
  if ((await countOf(page, CUSTOM_TO)) !== 1) {
    note('the custom range fields are not mounted, so there is no end time to type into')
    return
  }
  // MUI puts an extra prop on whichever node it considers the root, and that has moved between
  // majors — resolve it once rather than betting on this version's answer.
  const field = (await countOf(page, `${CUSTOM_TO} input`)) === 1 ? `${CUSTOM_TO} input` : CUSTOM_TO
  const typed = localInput(new Date(Date.now() + 26 * 60 * 60 * 1000))
  await page.fill(field, typed)
  // AN ABSENCE, asserted the way wave E3's law says: poll for the regression — the value CHANGING
  // out from under what was typed — and only claim it did not happen once the reading has stopped
  // being given a chance to. The snap-back this covers used to be immediate, on the very next
  // React commit.
  const kept = await settle(() => page.inputValue(field), (v) => v !== typed, { timeoutMs: 3000 })
  check(
    'an end time in the future STAYS typed — it no longer snaps back to the last log line',
    kept === typed,
    `typed ${typed}, field reads ${kept}`
  )
}

/**
 * LOOT PER HOUR, WITH BOTH DENOMINATORS NAMED (JOS-261) — read off the real ledger.
 *
 * `tests/lootRateText.test.mts` pins the words and `tests/lootRates.test.mts` pins the arithmetic;
 * neither can see that the Loot tab actually joins the loot module's history against a `rangeStats`
 * over the slice in force and renders the result. That is this check: the line is mounted, and it
 * names BOTH hours — which is the ticket's own requirement that neither reading pass for the other.
 *
 * Returns the line's text ('' when the fixture looted nothing, which is a real state and not a
 * failure) so the caller can prove the slice moves it and All restores it.
 */
async function stepLootRates(page: Page): Promise<string> {
  const text = await settle(() => textOf(page, LOOT_RATES), (t) => t !== '', { timeoutMs: 8000 })
  if (text === '') {
    note('this fixture has no loot at all, so the ledger states no rate — the honest empty state')
    return ''
  }
  check('the ledger states loot per hour for the slice in force', /drops\/hr/.test(text), text.replace(/\s+/g, ' '))
  check(
    '…over BOTH denominators, each named, so neither reading can pass for the other',
    text.includes('active') && text.includes('elapsed'),
    text.replace(/\s+/g, ' ')
  )
  // Rule 2 of lootRateText.ts: a rate that outran its span would be a confident claim about ten
  // minutes of play. Every rate the line prints carries the span it divided by.
  check(
    '…and every rate carries the span it was measured over',
    !/[\d.]+ drops\/hr(?! over)/.test(text),
    text.replace(/\s+/g, ' ')
  )
  return text
}
