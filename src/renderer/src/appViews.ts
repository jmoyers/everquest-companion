// The app's top-level view identity: the union the nav drawer, the content switch and the
// persisted "which tab was I on" key all agree on. Lives outside App.tsx so the nav drawer
// can import it without importing the app itself.

import { OWNER_TOOLS } from './devFlags'

export type View =
  | 'overview'
  | 'combat'
  | 'mobs'
  | 'maps'
  | 'bosses'
  | 'posky'
  | 'alerts'
  | 'leveling'
  | 'loot'
  | 'planner'
  // The GEAR PLANNER's search surface (JOS-284) — the candidate index over every equippable item.
  // It was a top-level nav row of its own until JOS-324; it is now the FIRST TAB of the gear area
  // (see `GEAR_AREA_VIEWS` below) and its view id, route and every `gear-*` testid are unchanged.
  | 'gear'
  // The PROGRESSION PLAN (docs/plans/gear-progression-planner.md §4) — the gear area's second tab
  // and the only one that answers a question about the FUTURE: where should I be at each level
  // bracket, and what am I there for. Gear is the corpus, Exaltations is the socket board, the Wish
  // list is what you decided you want; this is the route that produces the wanting. It sits beside
  // Gear rather than beside Leveling on purpose — the Leveling tab is OBSERVED HISTORY and stays
  // that (plan §4), and everything this surface reads (the item index, the class pin, the era
  // toggle, the wish list it seeds) is already standing in the gear area.
  | 'plan'
  // The WISH LIST (JOS-324 shell, JOS-326 content) — the third face of the gear area: the items
  // you have decided you want, kept as a list rather than derived from a plan. It ships this
  // ticket as an honest placeholder panel and gains its content in JOS-326.
  | 'wishlist'
  | 'buffs'
  | 'timers'
  | 'preferences'
  // OWNER-ONLY view (src/renderer/src/features/triage/**). It stays in the union
  // unconditionally because a union member is a TYPE and types are erased — nothing of it
  // survives compilation. What actually strips is the CODE: the nav row, the content branch
  // and the whole component tree sit behind `OWNER_TOOLS` (DEV **and** `EQ_OWNER_TOOLS=1`,
  // JOS-72), and `KNOWN_VIEWS` below drops the string itself in a build or a checkout without
  // it, so a persisted 'triage' can never leave anyone staring at an empty content area.
  | 'triage'
  // The CHARACTER SHEET (src/renderer/src/features/character/**) — the gear area's LAST TAB: what
  // you are wearing right now, read out of the newest `/outputfile inventory` dump, plus the
  // searchable ledger of everything else that dump lists. It was UNRELEASED from JOS-45 (a
  // compile-time strip behind `UNRELEASED`, absent from every packaged build) until the owner
  // released it in JOS-327; it is an ordinary member of both lists below now.
  | 'character'

export const VIEW_KEY = 'eq.view'
export const DEFAULT_VIEW: View = 'overview'

/**
 * What a view is CALLED, once. Two surfaces now say a tab's name out loud — the nav drawer's
 * rows, and a deep-linked drill's Back ("Back to Raid Targets", navOrigin.ts) — and a second copy
 * is exactly how one of them ends up saying "Bosses" while the other says "Raid Targets".
 *
 * A `Record<View, string>` rather than a lookup with a fallback: adding a view to the union
 * without naming it is a type error here, which is the only moment anyone would remember to.
 */
export const VIEW_LABELS: Record<View, string> = {
  overview: 'Overview',
  combat: 'Combat',
  mobs: 'Mobs',
  maps: 'Maps',
  bosses: 'Raid Targets',
  posky: 'Plane of Sky',
  alerts: 'Alerts',
  leveling: 'Leveling',
  loot: 'Loot',
  // THE TAB IS CALLED EXALTATIONS (owner, 2026-08-06, JOS-42). "Planner" described what the
  // surface does for us; "Exaltations" names the game system the player came here about. The
  // `planner` view id, its route, its `eq.planner.*` keys and every `planner-*` testid are
  // unchanged — this is a label, not a refactor — and since JOS-43 this table is the ONE place a
  // tab is named, so the nav row and a drill's Back button rename together by construction.
  planner: 'Exaltations',
  gear: 'Gear',
  // One word, and the noun rather than the verb: the tab holds a PLAN you can read, not a planning
  // mode you enter. "Progression" would have been the doc's word and is three syllables of tab bar.
  plan: 'Plan',
  // JOS-324. Two words, as a player writes it — the tab bar says it and, the day a wish-list row
  // deep-links into Loot, so will that drill's Back button.
  wishlist: 'Wish list',
  buffs: 'Buffs',
  timers: 'Timers',
  preferences: 'Preferences',
  triage: 'Triage',
  character: 'Character'
}

// Every member of `View` this BUILD can actually render. A view missing here is silently
// bounced to the default on the next launch, so the two lists are edited together — always.
const KNOWN_VIEWS: View[] = [
  'overview',
  'combat',
  'mobs',
  'maps',
  'bosses',
  'posky',
  'alerts',
  'leveling',
  'loot',
  'planner',
  'gear',
  'plan',
  'wishlist',
  'buffs',
  'timers',
  'preferences',
  // JOS-327: `character` used to be spliced in behind `UNRELEASED` right here, beside the
  // owner-tools splice below. It is a plain member now — every build draws it.
  'character',
  // Compile-time in a BUILD (`false ? [...] : []` folds away, taking the literal with it) and a
  // runtime read of the opt-in on a dev server — so a contributor's checkout, which has no
  // `EQ_OWNER_TOOLS`, bounces a persisted 'triage' to the default view instead of routing to a
  // tab it will not draw.
  ...(OWNER_TOOLS ? (['triage'] as const) : [])
]

export function loadView(): View {
  const v = localStorage.getItem(VIEW_KEY)
  // The Inventory feature was folded into Loot (Task #55) — land those users on Loot
  // instead of silently bouncing them to the default view.
  if (v === 'inventory') return 'loot'
  return v && (KNOWN_VIEWS as string[]).includes(v) ? (v as View) : DEFAULT_VIEW
}

// ============================================================================
// THE GEAR AREA — one nav row, four tabs (JOS-324); five since the progression planner
// ============================================================================
//
// THE LAW THIS REPLACES. Until JOS-324 the nav drawer's law was one row per view, full stop, and
// three of those rows were three faces of the SAME question — Gear (what should I be wearing),
// Exaltations (what am I farming for) and the dev-only Character sheet (what am I wearing right
// now). Three rows put three answers to one question in a vertical list where nothing said they
// belonged together, and the third of them hung off the bottom behind a flag. The owner's ruling
// (2026-08-13, the One Coin Four Faces design) collapses them into ONE nav row with an in-area tab
// bar — and adds the fourth face the list had no room to grow: a Wish list (what do I want).
//
// WHAT DID **NOT** CHANGE, and that is the whole point of this shape. The view ids are untouched
// (`gear`, `planner`, `character`, plus the new `wishlist`), App still renders exactly ONE view at
// a time, and every tab switch travels the ordinary `selectView` path a nav row travels. So deep
// links still land, `viewKey` still unmounts the outgoing view on a switch, and the Back stack
// (appRouting.ts / navOrigin.ts / backTargets.ts) keeps its semantics to the letter — a tab click
// is MANUAL navigation and clears the parked trail, which is what a nav-row click always did.
//
// THE ORDER IS THE TAB BAR'S ORDER, and Character is LAST on purpose: it is the only member that
// is not a shopping question. (It was also the one the review gate could still take away — JOS-327
// released it, and the order is unchanged because the first reason was always the real one.)

/** Where the area remembers which tab you were last on. Renderer-only, like `VIEW_KEY`. */
export const GEAR_TAB_KEY = 'eq.gear.tab'

/** The tab the nav row opens when nothing has been remembered — the area's front door. */
export const DEFAULT_GEAR_TAB: View = 'gear'

/**
 * The faces, in tab order — FILTERED BY WHAT THIS BUILD CAN RENDER.
 *
 * Deriving the roster from `KNOWN_VIEWS` rather than re-spelling a per-view gate is what keeps the
 * two lists from disagreeing: a tab appears exactly when the build can draw the view behind it.
 * JOS-327 is the proof it works — graduating the Character tab was one word moved in `KNOWN_VIEWS`
 * above, no edit down here, and no window in which the bar offered a tab that mounts nothing.
 *
 * FOUR UNTIL THE PROGRESSION PLANNER, WHICH MAKES IT FIVE and takes the second seat. `plan` sits
 * immediately RIGHT OF `gear` because it is the same corpus asked a different question — Gear is
 * "what is out there", Plan is "and in what order should I go and get it" — and because the two
 * share every input the area holds (the class pin, the era toggle, the item index). Anywhere
 * further right would have put the socket board and the character sheet between a question and its
 * answer. The ordering rule the run already had is untouched: the shopping questions lead, and
 * intent (Wish list) is still last with truth (Character) beside it.
 */
export const GEAR_AREA_VIEWS: readonly View[] = (
  // Character sits LEFT of Wish list, in the run with everything else (owner ruling 2026-08-13:
  // the right-pushed placement hid the tab well enough that the owner reported it missing).
  ['gear', 'plan', 'planner', 'character', 'wishlist'] as const
).filter((v) => (KNOWN_VIEWS as readonly View[]).includes(v))

/** Is this view drawn inside the gear area? (⇒ the nav row reads selected, the tab bar is up.) */
export function isGearAreaView(view: View): boolean {
  return GEAR_AREA_VIEWS.includes(view)
}

/**
 * Which tab the Gear nav row opens.
 *
 * A row that always opened the Gear tab would make the other three cost two clicks forever, and a
 * row that opened whatever you last had would be wrong the first time. So: last-used, defaulting
 * to Gear — validated against `GEAR_AREA_VIEWS`, so a value written by a build that HAD the
 * Character tab cannot strand a packaged user on a tab their build does not draw.
 */
export function loadGearTab(): View {
  const v = localStorage.getItem(GEAR_TAB_KEY)
  return v && (GEAR_AREA_VIEWS as readonly string[]).includes(v) ? (v as View) : DEFAULT_GEAR_TAB
}

/**
 * Remember the area tab, if this view is one. Called on EVERY view change rather than from the
 * tab bar's click handler, because "last-used tab" has to mean the tab you were last standing on
 * however you got there — a deep link and a Back both count.
 */
export function rememberGearTab(view: View): void {
  if (isGearAreaView(view)) localStorage.setItem(GEAR_TAB_KEY, view)
}
