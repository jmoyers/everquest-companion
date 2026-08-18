// appRouting — the app's DEEP-LINK routers, lifted out of App.tsx (2026-08-04).
//
// They lived beside the component until the loot link pushed that file over the measured
// 400-code-line ceiling, and this is the seam the ceiling was pointing at: App.tsx is a
// COMPOSITION (title bar, nav, content, toasts, dialogs), while these two hooks are the app's
// navigation MODEL — pure state and openers, no JSX, no MUI. Splitting them changed no
// behaviour: every rule below is the one that was written next to the component, verbatim.

import { useCallback, useEffect, useRef, useState } from 'react'
import { VIEW_LABELS, type View } from './appViews'
import { afterBack, afterLink, originTop, type NavOrigin } from './navOrigin'
import type { CombatFocus } from './features/combat/combatFocus'
import type { MobTarget } from './features/mobs/mobTarget'
import type { ZoneShort } from '@shared/maps'
// The Maps tab's zone selection is persisted machine-local state with pin semantics (JOS-97);
// `openMapZone` writes a pick through the same pure rules the toolbar uses. See the opener's doc.
import { onPick, saveZoneSelection } from './features/maps/zoneFollow'

/**
 * THE ONE BACK CONTRACT (JOS-43). Every cross-view drill receiver takes this same object — never
 * a bespoke `cameFrom` prop of its own, because per-view origin props are how five views end up
 * with five slightly different opinions about what Back means.
 *
 * `origin === null` is the NATIVE arrival: the receiver's Back keeps doing exactly what it always
 * did (drill → its own list). That is why `back()` returns a boolean rather than navigating
 * unconditionally — the receiver still owns its own fallback.
 */
export interface NavBack {
  /** Where the deep link that opened this view came from, or null when it was reached natively. */
  origin: NavOrigin | null
  /** Return to the origin and consume it. False ⇒ nothing parked; the caller's own Back stands. */
  back: () => boolean
  /** A NATIVE drill started here — the trail behind us belongs to a journey that just ended. */
  clear: () => void
}

/** What the openers navigate THROUGH, so the origin stack has exactly one place to be updated. */
interface NavSeam {
  /** Open `to`, parking the current view when the link carried an anchor. See navOrigin.ts. */
  linkTo: (to: View, anchored: boolean) => void
  /** MANUAL navigation (a nav-drawer row, the title bar): switch tabs and drop the trail. */
  selectView: (v: View) => void
  nav: NavBack
}

/**
 * The navigation-origin stack, kept beside the openers because they are the only things that
 * push to it.
 *
 * `viewRef` rather than a `view` dependency is load-bearing: `linkTo` is what every opener is
 * built from, and one of those openers is a dependency of App's MOUNT-ONLY `app:focusView`
 * subscription. If `linkTo` changed identity on every tab switch, that cross-window subscription
 * would be torn down and re-registered every time the user clicked a nav row. The ref is written
 * in an effect (after paint) and read in click handlers (later still), so it is never stale where
 * it is read.
 */
function useNavSeam(view: View, setView: (v: View) => void): NavSeam {
  const [origins, setOrigins] = useState<NavOrigin[]>([])
  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
  }, [view])

  const linkTo = useCallback(
    (to: View, anchored: boolean) => {
      const from = viewRef.current
      setOrigins((s) => afterLink(s, { view: from, label: VIEW_LABELS[from] }, to, anchored))
      setView(to)
    },
    [setView]
  )
  const selectView = useCallback(
    (v: View) => {
      setOrigins([])
      setView(v)
    },
    [setView]
  )
  const clear = useCallback(() => setOrigins([]), [])
  const origin = originTop(origins)
  const back = useCallback((): boolean => {
    if (!origin) return false
    setOrigins(afterBack)
    setView(origin.view)
    return true
  }, [origin, setView])

  return { linkTo, selectView, nav: { origin, back, clear } }
}

/**
 * App-wide DEEP-LINK routing: one detail surface per subject, so the thing that ROUTES to it
 * is app-level. Mobs (Task #64) has three callers — a Raid Targets roster card, the Overview
 * mob card, and the `app:focusView` deep link from the events overlay's con rows; Combat has
 * Overview's DPS card linking down to the fight it is already showing; Loot has the Overview's
 * recent-drops rows, each opening the item it names.
 *
 * The NONCE is the load-bearing part: the destination view keys its effect on it and stays
 * MOUNTED across a link, so asking for the same subject twice arrives twice instead of looking
 * broken. `clear*` is called the moment the payload is applied, so a stale one can't re-fire
 * when you next return to that tab.
 */
export interface AppRouting {
  /**
   * MANUAL navigation. Everything that is a user choosing a tab — the nav drawer, the title
   * bar's Preferences, a bare `view` deep link — goes through here rather than through the raw
   * `setView`, because that choice is also what invalidates a parked origin (navOrigin.ts).
   */
  selectView: (v: View) => void
  /** What a drill's Back reads. ONE object, handed to every cross-view receiver. See NavBack. */
  nav: NavBack
  mobTarget: MobTarget | null
  mobNonce: number
  openMob: (t: MobTarget) => void
  clearMob: () => void
  combatFocus: CombatFocus | null
  combatNonce: number
  openCombat: (f: CombatFocus) => void
  clearCombatFocus: () => void
  /** The item the Loot tab should open its detail pane on, or null for the plain ledger. */
  lootItem: string | null
  lootNonce: number
  /**
   * Bare ⇒ the Loot tab's ledger (the drops card's "All loot" link). With an item ⇒ the DEEP
   * link: the loot view lands on that item's detail pane, breadcrumb and all. ONE opener for
   * both because they are one destination differing only in whether a payload rode along —
   * splitting them would put two names on the same tab switch.
   */
  openLoot: (item?: string) => void
  clearLootFocus: () => void
  /** The Sky quest the PoS tab should expand + scroll to, as a `Class::Name` key, or null. */
  questKey: string | null
  questNonce: number
  /**
   * Bare ⇒ the Plane of Sky tab. With a key ⇒ the DEEP link: the tab reveals that quest (its
   * filters are reset around it), expands its accordion and scrolls it into view. The celebration
   * toast's reward card is the caller (docs/plans/celebration-toasts.md T6, completed here — wave
   * L shipped the tab-level half and flagged the per-quest anchor as the follow-up).
   */
  openQuest: (quest?: string) => void
  clearQuestFocus: () => void
  /** The level the "New at this level" panel should open on, or null for the character's own. */
  levelFocus: number | null
  levelNonce: number
  /**
   * Bare ⇒ the Leveling tab as it stands (Overview's leveling card). With a level ⇒ the level-up
   * toast's deep link: the same tab, with the panel anchored at the level that just dinged
   * (docs/plans/levelup-whats-new.md §2). ONE opener, like `openLoot`: one destination differing
   * only in whether a payload rode along.
   */
  openLeveling: (level?: number) => void
  clearLevelFocus: () => void
  /**
   * The Maps tab, pointed at a zone another surface named (the Gear tab's Zone cells, user ask
   * 2026-08-17). UNLIKE the openers above there is no focus/nonce pair to hand `MapsView`: which
   * zone the viewer shows is already persisted machine-local state with pin semantics
   * (features/maps/zoneFollow.ts, JOS-97), and a cross-view zone link IS a pick — so this writes
   * the pick through the same pure rule the toolbar's selector uses and switches tabs; the
   * remount reads it back. Unanchored on purpose: Maps is a tab with no drill and no Back button,
   * so parking an origin would promise a return nothing on that surface can deliver.
   */
  openMapZone: (zone: ZoneShort) => void
}

export function useAppRouting(view: View, setView: (v: View) => void): AppRouting {
  const { linkTo, selectView, nav } = useNavSeam(view, setView)
  const [mobTarget, setMobTarget] = useState<MobTarget | null>(null)
  const [mobNonce, setMobNonce] = useState(0)
  const [combatFocus, setCombatFocus] = useState<CombatFocus | null>(null)
  const [combatNonce, setCombatNonce] = useState(0)
  const [lootItem, setLootItem] = useState<string | null>(null)
  const [lootNonce, setLootNonce] = useState(0)
  const [questKey, setQuestKey] = useState<string | null>(null)
  const [questNonce, setQuestNonce] = useState(0)
  const [levelFocus, setLevelFocus] = useState<number | null>(null)
  const [levelNonce, setLevelNonce] = useState(0)
  // The openers are memoized because one of them is a DEPENDENCY of the mount-only effect that
  // installs the cross-window `app:focusView` listener — a fresh identity each render would
  // tear down and re-register that subscription on every render.
  //
  // They navigate through `linkTo`, never through the raw `setView`: that is the ONE seam where a
  // cross-view jump parks the view it is leaving (JOS-43). The boolean is the whole rule — did
  // this link carry an anchor, i.e. is the user landing in a DRILL that will show a Back button?
  // `openLoot()` bare is the drops card's "All loot", a plain tab switch; `openLoot(item)` is the
  // deep link this ticket exists for.
  const openMob = useCallback(
    (t: MobTarget) => {
      setMobTarget(t)
      setMobNonce((n) => n + 1)
      linkTo('mobs', true)
    },
    [linkTo]
  )
  const openCombat = useCallback(
    (f: CombatFocus) => {
      setCombatFocus(f)
      setCombatNonce((n) => n + 1)
      linkTo('combat', true)
    },
    [linkTo]
  )
  const openLoot = useCallback(
    (item?: string) => {
      setLootItem(item ?? null)
      setLootNonce((n) => n + 1)
      linkTo('loot', item != null)
    },
    [linkTo]
  )
  // Both cross-window deep links (a toast card's click) memoize for the same reason `openMob`
  // does: `applyDeepLink` runs inside the mount-only `app:focusView` subscription effect.
  const openQuest = useCallback(
    (quest?: string) => {
      setQuestKey(quest ?? null)
      setQuestNonce((n) => n + 1)
      linkTo('posky', quest != null)
    },
    [linkTo]
  )
  const openLeveling = useCallback(
    (level?: number) => {
      setLevelFocus(level ?? null)
      setLevelNonce((n) => n + 1)
      linkTo('leveling', level != null)
    },
    [linkTo]
  )
  const openMapZone = useCallback(
    (zone: ZoneShort) => {
      // Persist first, then navigate: App mounts one view at a time, so the Maps remount's
      // `loadZoneSelection` is what reads this back — the ordering is the whole mechanism.
      saveZoneSelection(onPick(zone))
      linkTo('maps', false)
    },
    [linkTo]
  )
  return {
    selectView,
    nav,
    mobTarget,
    mobNonce,
    openMob,
    clearMob: () => setMobTarget(null),
    questKey,
    questNonce,
    openQuest,
    clearQuestFocus: () => setQuestKey(null),
    levelFocus,
    levelNonce,
    openLeveling,
    clearLevelFocus: () => setLevelFocus(null),
    combatFocus,
    combatNonce,
    openCombat,
    clearCombatFocus: () => setCombatFocus(null),
    lootItem,
    lootNonce,
    openLoot,
    clearLootFocus: () => setLootItem(null),
    openMapZone
  }
}

/**
 * A deep link INTO a Preferences section. No nonce: PreferencesView is KEYED on the section, so
 * asking for one always lands there — even from Preferences itself. The request is dropped the
 * moment the user leaves the view, so a later plain visit opens on the usual section rather
 * than wherever the last link pointed.
 *
 * Two callers today: the first-run telemetry notice's "Details" link (plan T1, section
 * 'analytics'), and the Alerts tab's route to its spoken-alert settings (section 'voice').
 *
 * Its `setView` is handed the app's MANUAL navigator (`AppRouting.selectView`), not the raw
 * setter: a Preferences section is a place you go, not a drill you back out of — it has no Back
 * of its own — so arriving there ends whatever journey was parked (navOrigin.ts).
 */
export interface PrefsRouting {
  section: string | null
  openSection: (id: string) => void
}

export function usePrefsRouting(view: View, setView: (v: View) => void): PrefsRouting {
  const [section, setSection] = useState<string | null>(null)
  useEffect(() => {
    if (view !== 'preferences') setSection(null)
  }, [view])
  const openSection = useCallback(
    (id: string) => {
      setSection(id)
      setView('preferences')
    },
    [setView]
  )
  return { section, openSection }
}
