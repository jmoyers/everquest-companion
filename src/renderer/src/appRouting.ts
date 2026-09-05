// appRouting — the app's DEEP-LINK routers, lifted out of App.tsx (2026-08-04).
//
// They lived beside the component until the loot link pushed that file over the measured
// 400-code-line ceiling, and this is the seam the ceiling was pointing at: App.tsx is a
// COMPOSITION (title bar, nav, content, toasts, dialogs), while these two hooks are the app's
// navigation MODEL — pure state and openers, no JSX, no MUI. Splitting them changed no
// behaviour: every rule below is the one that was written next to the component, verbatim.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { VIEW_LABELS, type View } from './appViews'
import { afterBack, afterLink, originTop, type NavOrigin } from './navOrigin'
import type { CombatFocus } from './features/combat/combatFocus'
import type { MobTarget } from './features/mobs/mobTarget'

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
 *
 * THE RETURN IS MEMOIZED (JOS-510 item 3), and so is the `nav` object inside it. Every MEMBER was
 * already a `useCallback`, which made the individual openers stable and the CONTAINERS new objects
 * on every render — so `routing` and `routing.nav` defeated any `React.memo` placed downstream
 * before it could compare anything. `origin` is `originTop(origins)`, an ELEMENT of the state array
 * rather than a derived object, so it only moves when the stack does.
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

  const nav = useMemo<NavBack>(() => ({ origin, back, clear }), [origin, back, clear])
  return useMemo(() => ({ linkTo, selectView, nav }), [linkTo, selectView, nav])
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
  /** The spell the drilldown should draw, or null. Never bare — a spell page IS its spell. */
  spellName: string | null
  spellNonce: number
  /**
   * THE SPELL DRILLDOWN (JOS-508). The one opener here that takes a REQUIRED payload, and the
   * asymmetry is the feature: `openLoot()` and `openLeveling()` bare are real destinations (a
   * ledger, a tab), while a spell page with no spell is nothing at all — so the type refuses it
   * rather than the view having to draw an empty state nobody can reach on purpose.
   *
   * Always `anchored: true` for the same reason: every arrival here is a drill from a name
   * somewhere, so the page always shows a Back to wherever that name was.
   */
  openSpell: (name: string) => void
  clearSpellFocus: () => void
}

/**
 * ONE DEEP-LINK DESTINATION'S STATE: the payload it was asked for, the nonce that makes the same
 * ask twice arrive twice, the opener, and the way to retire a payload once applied.
 *
 * SIX COPIES OF THIS EXISTED INLINE until JOS-510 item 3, and the copies are why memoizing the
 * router's return would otherwise have pushed `useAppRouting` past the measured
 * `max-lines-per-function` ceiling: the six `clear*` members were bare arrows (a new identity per
 * render, which is exactly what pre-defeats a downstream `React.memo`), and giving each one a
 * `useCallback` plus listing twenty-four members in a dependency array is pure mass. Extracting the
 * shape they already shared pays for the memoization instead of ratcheting around it. NOTHING
 * ABOUT THE ROUTER'S CONTRACT MOVED — `AppRouting` below is byte-for-byte the interface it was.
 *
 * `open` takes an OPTIONAL payload so one signature serves both idioms: the three destinations that
 * are real places on their own (`openLoot()`, `openQuest()`, `openLeveling()` bare) and the three
 * that are nothing without their subject (`openMob`, `openCombat`, `openSpell`, whose declared
 * parameter is required and so can never reach the bare branch). `anchored` then falls out of the
 * payload rather than being spelled per opener — the same rule the six copies each wrote by hand:
 * did this link carry an anchor, i.e. is the user landing in a DRILL that will show a Back button?
 */
interface FocusSlot<T> {
  value: T | null
  nonce: number
  open: (v?: T | null) => void
  clear: () => void
}

/**
 * The openers are memoized because one of them is a DEPENDENCY of the mount-only effect that
 * installs the cross-window `app:focusView` listener — a fresh identity each render would tear
 * down and re-register that subscription on every render.
 *
 * They navigate through `linkTo`, never through the raw `setView`: that is the ONE seam where a
 * cross-view jump parks the view it is leaving (JOS-43).
 *
 * A SPELL → SPELL HOP PARKS NOTHING, BY THE MODEL'S OWN RULE, and it is worth saying here because
 * the spell drilldown is the first link whose destination is routinely the view it was fired from.
 * `afterLink` returns the stack untouched when `from.view === to` ("you did not travel, so the
 * trail behind you is still the trail behind you"), so walking a ladder from one rung to the next
 * does NOT grow the trail: the whole excursion keeps ONE origin — the surface the first spell name
 * was clicked on — and one Back leaves it. That is a deliberate semantics rather than a gap, the
 * button says out loud where it goes, and the return trip up the ladder is the ladder itself,
 * which every rung's page draws. Retracing hop by hop would mean changing `afterLink` for the five
 * links that already depend on it.
 */
function useFocusSlot<T>(to: View, linkTo: NavSeam['linkTo']): FocusSlot<T> {
  const [value, setValue] = useState<T | null>(null)
  const [nonce, setNonce] = useState(0)
  const open = useCallback(
    (v?: T | null) => {
      setValue(v ?? null)
      setNonce((n) => n + 1)
      linkTo(to, v != null)
    },
    [linkTo, to]
  )
  const clear = useCallback(() => setValue(null), [])
  return useMemo(() => ({ value, nonce, open, clear }), [value, nonce, open, clear])
}

export function useAppRouting(view: View, setView: (v: View) => void): AppRouting {
  const { linkTo, selectView, nav } = useNavSeam(view, setView)
  const mob = useFocusSlot<MobTarget>('mobs', linkTo)
  const combat = useFocusSlot<CombatFocus>('combat', linkTo)
  const loot = useFocusSlot<string>('loot', linkTo)
  const quest = useFocusSlot<string>('posky', linkTo)
  const level = useFocusSlot<number>('leveling', linkTo)
  // The spell opener is load-bearing twice over: it is also the value `SpellLinkProvider` publishes
  // to every spell name in the window, so a fresh identity per render would re-render every list
  // that draws one.
  const spell = useFocusSlot<string>('spell', linkTo)
  // THE WHOLE ROUTER IS ONE MEMOIZED OBJECT (JOS-510 item 3). It is handed down as `routing` to
  // `ViewContent`, which is a `React.memo` boundary now — a fresh object here would make that
  // boundary compare unequal on every App render and buy nothing.
  return useMemo(
    () => ({
      selectView,
      nav,
      spellName: spell.value,
      spellNonce: spell.nonce,
      openSpell: spell.open,
      clearSpellFocus: spell.clear,
      mobTarget: mob.value,
      mobNonce: mob.nonce,
      openMob: mob.open,
      clearMob: mob.clear,
      questKey: quest.value,
      questNonce: quest.nonce,
      openQuest: quest.open,
      clearQuestFocus: quest.clear,
      levelFocus: level.value,
      levelNonce: level.nonce,
      openLeveling: level.open,
      clearLevelFocus: level.clear,
      combatFocus: combat.value,
      combatNonce: combat.nonce,
      openCombat: combat.open,
      clearCombatFocus: combat.clear,
      lootItem: loot.value,
      lootNonce: loot.nonce,
      openLoot: loot.open,
      clearLootFocus: loot.clear
    }),
    [selectView, nav, spell, mob, quest, level, combat, loot]
  )
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
  // Memoized for the same reason `useAppRouting`'s return is (JOS-510 item 3): this object travels
  // to `ViewContent` and to `BottomStrips` as a prop, and `ViewContent` is a `React.memo` boundary.
  return useMemo(() => ({ section, openSection }), [section, openSection])
}
