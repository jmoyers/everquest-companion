// TOOLTIP AFFORDANCE — the app-wide rule, pinned structurally.
//
// Owner rule (2026-08-04): "anything wearing a MUI Tooltip shows the HAND". That is a property of
// ~130 call sites, so it is only true if it is CENTRAL: every site imports `lib/Tooltip`, which
// clones one class onto its anchor, and the theme carries that class's single cursor rule. A test
// that rendered one component would prove nothing about the other 129 — what has to be pinned is
// that no site can opt out by accident.
//
// So this suite reads the TREE, not a DOM:
//   1. nobody imports MUI's Tooltip directly (that is the only way to get an anchor with no class);
//   2. the class the wrapper applies and the class the theme styles are the same string;
//   3. the theme states both the rule and its disabled-control exception;
//   4. UpdateChip mounts no MUI Tooltip at all — the nav's update indicator sits directly under
//      Preferences, and a `placement="top"` popper there is an overlay across the row the user was
//      aiming at (the owner's report). Structural, because "the popper cannot mount" is exactly
//      what "it can't eat the click" means.
//   5. the LOOT LEDGER mounts none either (JOS-127) — same defect, one surface wider. A 0.14.0
//      user could not change the Loot sort off "Last looted": the notable-pickups chips and the
//      item names in the first table rows anchored `placement="top"`, INTERACTIVE
//      `KnownItemTooltip` cards, which open upward across the toolbar the Sort select lives in
//      and hold `pointer-events: auto` for as long as they are up. Owner direction was removal,
//      not a timeout or a placement flip, so the guard is the same structural one: no file that
//      draws the ledger may mount a popper of any kind.
//   6. NO DROPDOWN ANYWHERE WEARS ONE (JOS-143) — the owner hit the same blocked control a second
//      time, on the Sky tab, and the direction became universal: tooltips come off dropdown and
//      select controls app-wide. The guard below is that rule, and it is derived rather than
//      listed: it finds every renderer file that renders a dropdown (a MUI `Select`, an
//      `Autocomplete`, a `TextField select`, a `Menu`, a `ChipMultiSelect`) and insists none of
//      them mounts a popper. Derived, because a hardcoded list is precisely what let this ship
//      twice — a new select dropped into a file that already had a tooltip passes any list and
//      fails this. This rule is UNCHANGED by JOS-181: a card belongs to a row, never to a control.
//   7. …AND THE ROWS UNDER A TOOLBAR MOUNT ONLY A CARD THAT CANNOT REACH IT (JOS-181, the rule
//      that replaced JOS-143's second guard). The mechanism in both reports was never "a tooltip
//      existed" — it was a `placement="top"`, INTERACTIVE card belonging to a row BELOW the
//      toolbar, opening upward across it and holding `pointer-events: auto` for as long as it was
//      up. JOS-143 answered by banning the popper outright on those rows, which cost the Sky tab
//      its item cards; the owner has now ruled the trade the other way, so the ban narrows to what
//      it was always about. The rows may mount the item card, through ONE wrapper
//      (`features/posky/SkyItemCard.tsx`) that always passes `clickThrough` — the mode that opens
//      downward, disables `flip` so it cannot go up, holds no pointer events, and closes on
//      pointerdown. The guards below pin all three halves: the wrapper never stops passing the
//      mode, the mode never stops meaning those things, and no row file mounts a card any other
//      way. The files that still mount NOTHING are still listed, and still checked.
//
// No DOM, no fixture — it never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const RENDERER = join(ROOT, 'src', 'renderer', 'src')
/** The ONE file allowed to know MUI's Tooltip exists. */
const WRAPPER = join(RENDERER, 'lib', 'Tooltip.tsx')

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) sources(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

/** Does this file import MUI's Tooltip — as a named member, or from its own subpath? */
function importsMuiTooltip(src: string): boolean {
  if (/from '@mui\/material\/Tooltip'/.test(src)) return true
  const named = /import \{([^}]*)\} from '@mui\/material'/.exec(src)
  if (!named) return false
  return named[1]
    .split(',')
    .map((s) => s.trim())
    .some((m) => m === 'Tooltip' || m.startsWith('Tooltip as '))
}

test('lib/Tooltip.tsx is the ONLY importer of MUI’s Tooltip', () => {
  const offenders = sources(RENDERER)
    .filter((f) => f !== WRAPPER && importsMuiTooltip(readFileSync(f, 'utf8')))
    .map((f) => relative(ROOT, f))
  assert.deepEqual(offenders, [], `these bypass the shared wrapper: ${offenders.join(', ')}`)
})

test('every tooltip site goes through the wrapper (it is genuinely used, not just available)', () => {
  const users = sources(RENDERER).filter(
    (f) => f !== WRAPPER && /from '.*lib\/Tooltip'/.test(readFileSync(f, 'utf8'))
  )
  // A floor, and the floor MOVES DOWN. It exists to prove the wrapper is the live path rather
  // than a component nobody reaches — it was never a target for how many tooltips the app should
  // have. The original sweep found 47 and the note said "the number only grows"; JOS-127 and
  // JOS-143 are the tickets that make it shrink on purpose (54 → 41, measured 2026-08-09), and
  // the house direction is FEWER tooltips still. Lower this again rather than defending a count.
  assert.ok(users.length >= 25, `only ${String(users.length)} files import the shared Tooltip`)
})

test('the wrapper’s class and the theme’s rule are the same string', () => {
  const wrapper = readFileSync(WRAPPER, 'utf8')
  const theme = readFileSync(join(RENDERER, 'theme', 'theme.ts'), 'utf8')
  const declared = /TIP_ANCHOR_CLASS = '([^']+)'/.exec(wrapper)
  assert.ok(declared, 'the wrapper declares TIP_ANCHOR_CLASS')
  const cls = declared[1]
  assert.equal(cls, 'eq-tip-anchor')
  assert.ok(wrapper.includes('cursor?:'), 'the wrapper offers the documented opt-out')
  assert.ok(theme.includes(`.${cls}`), 'the theme styles the class the wrapper applies')
})

test('the theme states the hand cursor AND the disabled exception', () => {
  const theme = readFileSync(join(RENDERER, 'theme', 'theme.ts'), 'utf8')
  const block = /const tooltipAnchors = \{([\s\S]*?)\n\}/.exec(theme)
  assert.ok(block, 'the theme carries a tooltipAnchors block')
  assert.ok(/cursor: 'pointer'/.test(block[1]), 'anchors get the hand')
  assert.ok(/cursor: 'not-allowed'/.test(block[1]), 'disabled controls keep not-allowed')
  assert.ok(/:has\(\.Mui-disabled\)/.test(block[1]), 'the disabled rule reaches the wrapping span')
  assert.ok(theme.includes('...tooltipAnchors'), 'and the block is actually applied by CssBaseline')
})

/**
 * The files that draw the Loot LEDGER — the toolbar (with the Sort select), the strip under it,
 * the table, its rows and their badges, and the drill-down's own chrome. Not the drill-down BODY:
 * `ItemDetailDialog` and the sections it composes also render inside the Mobs tab's dialog, and
 * their `db`/`observed` provenance chips are two-word labels that cannot sit over any control.
 */
const LOOT_LEDGER = [
  'loot/LootView.tsx',
  'loot/LootTables.tsx',
  'loot/lootRows.tsx',
  'loot/KnowledgeBadge.tsx',
  'loot/NotablePickupsStrip.tsx',
  'loot/ItemDetailPane.tsx',
  // The timeslice control (JOS-130) draws on this surface too, and it is the WORST place left for
  // a popper: it is a row of small toggle buttons sitting directly above the toolbar it governs,
  // so a `placement="top"` card anchored on any of them would open across the ledger's own
  // controls — and one anchored on a button would cover the button beside it. Same rule, same
  // reason, one surface wider.
  'timeslice/SliceBar.tsx'
]

test('the Loot ledger mounts NO tooltip popper over its own controls (JOS-127)', () => {
  for (const name of LOOT_LEDGER) {
    const src = readFileSync(join(RENDERER, 'features', name), 'utf8')
    assert.equal(importsMuiTooltip(src), false, `${name} must not import MUI’s Tooltip`)
    assert.ok(!/from '.*lib\/Tooltip'/.test(src), `${name} must not import the shared Tooltip`)
    // KnownItemTooltip is the WORST of them here: interactive, `placement="top"`, up to 380px
    // wide, and anchored on rows that sit directly beneath the toolbar. Matched as an IMPORT and
    // as an ELEMENT, never as a bare word — these files explain in prose why it left.
    assert.ok(!/from '.*KnownItemTooltip'/.test(src), `${name} must not import the item hover card`)
    assert.ok(!/<KnownItemTooltip/.test(src), `${name} must not mount the item hover card`)
    assert.ok(!/<Tooltip/.test(src), `no Tooltip element may survive in ${name}`)
  }
})

test('the Loot ledger does not smuggle the hover text back in as a native title', () => {
  // A native `title` cannot eat a click (no hit area), so it is not the defect — but the owner's
  // direction was FEWER tooltips on this surface, not a quieter spelling of the same ones.
  for (const name of LOOT_LEDGER) {
    const src = readFileSync(join(RENDERER, 'features', name), 'utf8')
    assert.ok(!/\btitle=/.test(src), `${name} should carry no hover text at all`)
  }
})

test('the estimate caveat survives as a WORD in the header, not a sentence in a popper', () => {
  const tables = readFileSync(join(RENDERER, 'features', 'loot', 'LootTables.tsx'), 'utf8')
  assert.ok(tables.includes('In inventory (est.)'), 'the column header says est. out loud')
})

// ── JOS-143: no dropdown wears a popper, anywhere ───────────────────────────────────────────

/** Does this file RENDER a dropdown — something whose list opens over the layout on click? */
function rendersDropdown(src: string): boolean {
  return (
    /<Select\b/.test(src) ||
    /<NativeSelect\b/.test(src) ||
    /<Autocomplete\b/.test(src) ||
    /<Menu\b/.test(src) ||
    /<ChipMultiSelect\b/.test(src) ||
    // `<TextField select …>` — the prop sits on its own line in this tree, always has.
    /^\s*select\s*$/m.test(src)
  )
}

/**
 * Does this file MOUNT a popper — the shared wrapper, or any of the item hover cards?
 *
 * `SkyItemCard` counts (JOS-181) even though its card cannot cover a toolbar: a card belongs to a
 * ROW, and a file that renders the control has no row to hang one on. The narrowing JOS-181 made is
 * about where a card may live, never about putting one on a dropdown.
 */
function mountsPopper(src: string): boolean {
  return (
    importsMuiTooltip(src) ||
    /from '.*lib\/Tooltip'/.test(src) ||
    /<Tooltip[\s>]/.test(src) ||
    /<KnownItemTooltip[\s>]/.test(src) ||
    /<SkyItemCard[\s>]/.test(src) ||
    /<ItemTooltip[\s>]/.test(src)
  )
}

/**
 * Files still allowed to break the rule — EMPTY, and it should stay that way. The one debt it
 * ever held (`triage/ReportsPanel.tsx`, skipped 2026-08-09 while JOS-111 owned the triage
 * surface) was cleaned by the integrator the same day JOS-111 landed. Do not add an entry
 * without a ticket that says why.
 */
const DROPDOWN_POPPER_DEBT: string[] = []

test('no file that renders a DROPDOWN mounts a tooltip popper (JOS-143)', () => {
  const offenders = sources(RENDERER)
    .filter((f) => f !== WRAPPER)
    .filter((f) => {
      const src = readFileSync(f, 'utf8')
      return rendersDropdown(src) && mountsPopper(src)
    })
    .map((f) => relative(RENDERER, f).split('\\').join('/'))
    .filter((rel) => !DROPDOWN_POPPER_DEBT.includes(rel))
  assert.deepEqual(
    offenders,
    [],
    `a hover card can open over the option list in: ${offenders.join(', ')}`
  )
})

test('the dropdown-popper debt list stays a debt (it names files that still exist)', () => {
  // A stale entry is worse than no list: it would silently exempt a file that had been fixed, or
  // name one that had been renamed. Both are caught here rather than discovered by the next report.
  for (const rel of DROPDOWN_POPPER_DEBT) {
    const src = readFileSync(join(RENDERER, rel), 'utf8')
    assert.ok(
      rendersDropdown(src) && mountsPopper(src),
      `${rel} no longer needs its exemption — delete it from DROPDOWN_POPPER_DEBT`
    )
  }
})

/**
 * The other half, which no derivation can see: files that render NO control of their own but sit
 * in a scrolling list UNDER one, and anchored `placement="top"` cards that opened upward across it.
 *
 * This is the mechanism behind both of the owner's reports. On the Loot ledger (JOS-127) it was
 * the item names in the first table rows; on the Sky tab (JOS-143) it was every required-item chip
 * in the accordion SUMMARY — the row immediately below QuestFilterBar's five dropdowns — plus the
 * dropper cells and the expanded table's item names. `PlannerChips` is the same shape on a third
 * surface: donor names are rows under the Effects browser's Slot/Group-by selects and under the
 * board's Classes chip-select. A `title` attribute is fine on all of these and several carry one;
 * what may not come back is a node in the DOM that takes pointer events AND can open upward.
 *
 * These are the files where the answer is still NOTHING AT ALL — the ones whose hover text is a
 * sentence a native title carries perfectly well, so there is no card to weigh against the risk.
 * The Sky tab's two item-name files moved to `CLICK_THROUGH_ONLY` below when the owner ruled the
 * card back (JOS-181); nothing else did, and adding a file here is still free.
 */
const NO_UPWARD_CARD = [
  'features/posky/DropperCell.tsx',
  'features/posky/TurnInControls.tsx',
  'features/planner/PlannerChips.tsx',
  'features/alerts/AlertList.tsx',
  'features/combat/CombatHeader.tsx'
]

test('the rows under a dropdown toolbar mount NO popper of any kind (JOS-143)', () => {
  for (const rel of NO_UPWARD_CARD) {
    const src = readFileSync(join(RENDERER, rel), 'utf8')
    assert.equal(importsMuiTooltip(src), false, `${rel} must not import MUI’s Tooltip`)
    assert.ok(!/<Tooltip[\s>]/.test(src), `no Tooltip element may survive in ${rel}`)
    // Matched as an ELEMENT, never as a bare word — every one of these files explains in prose
    // why the card left, and the prose names it.
    assert.ok(!/<KnownItemTooltip[\s>]/.test(src), `${rel} must not mount the item hover card`)
    assert.ok(!/<SkyItemCard[\s>]/.test(src), `${rel} must not mount the Sky item card either`)
  }
})

// ── JOS-181: the Sky tab's cards are back, and they are the kind that cannot eat a click ────────

/** The ONE component the Sky tab's rows may mount a card through. */
const SKY_CARD = join(RENDERER, 'features', 'posky', 'SkyItemCard.tsx')

/**
 * Sky files that DO draw item cards. They may mount `SkyItemCard` and nothing else: not the shared
 * `Tooltip`, not `KnownItemTooltip` directly (which would let a call site forget the mode), and
 * certainly not MUI's Tooltip. That is what keeps "the Sky tab's cards are click-through" a
 * property of one file rather than of whoever edits these next.
 */
const CLICK_THROUGH_ONLY = [
  'features/posky/QuestAccordion.tsx',
  'features/posky/QuestItemsTable.tsx',
  // The Cleanup tab (JOS-389) draws item names in a scrolling list under its own toolbar - which
  // mounts the count-source dropdown - so it is the same geometry the rule was written for.
  'features/posky/CleanupList.tsx'
]

/**
 * TWO SPELLINGS OF THE SAME CARD, and both are the card (JOS-401).
 *
 * A file here either mounts `SkyItemCard` directly or mounts `ItemNameLink`, which is
 * QuestItemsTable's exported item NAME - a name that hovers into `SkyItemCard` and clicks into the
 * Loot drill-down. CleanupList went the second way when the owner asked for the reward names to
 * hover too: a second local wrapper around the same card would have been a second place for the
 * click-through mode to be forgotten, which is the exact failure this whole rule exists to stop.
 * The rule is unchanged in substance - no file below may reach MUI's Tooltip, the shared Tooltip
 * or `KnownItemTooltip`, and every card it draws still opens downward and takes no clicks.
 */
const SKY_CARD_MOUNT = /<(SkyItemCard|ItemNameLink)[\s>]/

test('the Sky tab draws its cards ONLY through SkyItemCard (JOS-181)', () => {
  for (const rel of CLICK_THROUGH_ONLY) {
    const src = readFileSync(join(RENDERER, rel), 'utf8')
    assert.equal(importsMuiTooltip(src), false, `${rel} must not import MUI’s Tooltip`)
    assert.ok(!/from '.*lib\/Tooltip'/.test(src), `${rel} must not import the shared Tooltip`)
    assert.ok(!/<Tooltip[\s>]/.test(src), `no bare Tooltip element may appear in ${rel}`)
    assert.ok(
      !/<KnownItemTooltip[\s>]/.test(src),
      `${rel} must go through SkyItemCard, not straight to the generic card`
    )
    assert.ok(SKY_CARD_MOUNT.test(src), `${rel} should still mount the Sky item card`)
  }
})

test('the Sky item NAME is one component, so the card cannot be forgotten on a name (JOS-401)', () => {
  // ItemNameLink is the second spelling allowed above, and it is only allowed because it mounts
  // the card itself. If that stops being true, every file that reached for the link instead of the
  // card silently loses its hover - so the claim is pinned where the component lives.
  const src = readFileSync(join(RENDERER, 'features', 'posky', 'QuestItemsTable.tsx'), 'utf8')
  assert.ok(/<SkyItemCard[\s>]/.test(src), 'ItemNameLink still wraps its name in SkyItemCard')
})

test('SkyItemCard always passes clickThrough — the mode is never a call-site decision (JOS-181)', () => {
  const src = readFileSync(SKY_CARD, 'utf8')
  // ONE mount, and the flag is on it as a bare boolean attribute (never `clickThrough={x}`, which
  // would make it conditional on something).
  const mounts = src.match(/<KnownItemTooltip\b/g) ?? []
  assert.equal(mounts.length, 1, 'SkyItemCard mounts the generic card exactly once')
  // Its own line, bare — `\s*$` rather than `\n` because a checkout may hand this file CRLF.
  assert.ok(/^\s*clickThrough\s*$/m.test(src), 'and passes clickThrough unconditionally')
  assert.equal(importsMuiTooltip(src), false, 'it reaches MUI only through the generic card')
})

test('clickThrough still MEANS all three things it was introduced to mean (JOS-181)', () => {
  // The prose in KnownItemTooltip.tsx numbers them; these are the three lines that implement them.
  // A regex on source is a weak proof of behaviour on its own — tests/e2e/sky-dropdowns.e2e.mts is
  // where the browser is asked — but it is what stops a refactor quietly dropping one of the three.
  const src = readFileSync(join(RENDERER, 'lib', 'KnownItemTooltip.tsx'), 'utf8')
  // 1. downward, and unable to flip back up.
  assert.ok(/clickThrough \? 'bottom-start'/.test(src), 'a click-through card opens downward')
  assert.ok(/name: 'flip', enabled: false/.test(src), 'flip is disabled, so it cannot go up')
  assert.ok(/mainAxis: false/.test(src), 'preventOverflow may not slide it up either')
  // 2. no pointer events — stated, not inherited from MUI's disableInteractive default.
  assert.ok(/pointerEvents: 'none'/.test(src), 'the popper takes no pointer events')
  assert.ok(/disableInteractive=\{nested \|\| clickThrough\}/.test(src), '…and is non-interactive')
  // 3. gone before the control it floated near opens its own list.
  assert.ok(
    /addEventListener\('pointerdown', close, true\)/.test(src),
    'it closes on a capture-phase pointerdown'
  )
})

test('the Sky tracker’s OLD hover card is still gone (JOS-143, and it stays gone)', () => {
  // features/posky/ItemTooltip.tsx was the `placement="top"`, 380px-wide, INTERACTIVE card that
  // landed on the Sky toolbar. JOS-181 brings the CARD back but not THAT card: the tab's hover is
  // the app's one shared item card in click-through mode, so there is still nothing here to import
  // and no second opinion about how an item hover behaves.
  assert.throws(
    () => readFileSync(join(RENDERER, 'features', 'posky', 'ItemTooltip.tsx'), 'utf8'),
    /ENOENT/,
    'features/posky/ItemTooltip.tsx should not exist'
  )
  const importers = sources(RENDERER).filter((f) => /from '.*posky\/ItemTooltip'/.test(readFileSync(f, 'utf8')))
  assert.deepEqual(importers, [], 'nothing may import the deleted posky hover card')
})

test('the nav’s update indicator mounts NO tooltip popper over Preferences', () => {
  const chip = readFileSync(join(RENDERER, 'components', 'UpdateChip.tsx'), 'utf8')
  assert.equal(importsMuiTooltip(chip), false, 'UpdateChip must not import a Tooltip')
  assert.ok(!/from '.*lib\/Tooltip'/.test(chip), '…nor the shared one')
  assert.ok(!/<Tooltip/.test(chip), 'no Tooltip element survives in the file')
  // The strings it used to carry are native `title` attributes: an OS tooltip is not in the DOM
  // and has no hit area, so it cannot intercept the click aimed at the row above.
  assert.ok(/title="Only the installed app auto-updates\./.test(chip))
  assert.ok(/title=\{tip\}/.test(chip))
})
