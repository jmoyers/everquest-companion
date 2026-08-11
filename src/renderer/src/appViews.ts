// The app's top-level view identity: the union the nav drawer, the content switch and the
// persisted "which tab was I on" key all agree on. Lives outside App.tsx so the nav drawer
// can import it without importing the app itself.

import { OWNER_TOOLS, UNRELEASED } from './devFlags'

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
  // UNRELEASED view (src/renderer/src/features/character/**, JOS-45). Same erasure argument as
  // 'triage' above: the member is a TYPE. What strips is the CODE — the nav row, the content
  // branch and the lazily-imported tree all sit behind `UNRELEASED`, and `KNOWN_VIEWS` drops
  // the string in a build without it, so a persisted 'character' can never leave a shipped app
  // staring at an empty content area.
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
  'buffs',
  'timers',
  'preferences',
  // Compile-time in a BUILD (`false ? [...] : []` folds away, taking the literal with it) and a
  // runtime read of the opt-in on a dev server — so a contributor's checkout, which has no
  // `EQ_OWNER_TOOLS`, bounces a persisted 'triage' to the default view instead of routing to a
  // tab it will not draw.
  ...(OWNER_TOOLS ? (['triage'] as const) : []),
  ...(UNRELEASED ? (['character'] as const) : [])
]

export function loadView(): View {
  const v = localStorage.getItem(VIEW_KEY)
  // The Inventory feature was folded into Loot (Task #55) — land those users on Loot
  // instead of silently bouncing them to the default view.
  if (v === 'inventory') return 'loot'
  return v && (KNOWN_VIEWS as string[]).includes(v) ? (v as View) : DEFAULT_VIEW
}
