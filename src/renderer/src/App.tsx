import { type JSX, memo, useCallback, useEffect, useState } from 'react'
import { Box, CssBaseline } from '@mui/material'
import type { AppFocus, CharacterRef } from '@shared/types'
import TitleBar from './components/TitleBar'
import NavDrawer from './components/NavDrawer'
// THE CONTENT COLUMN — everything right of the nav drawer. Moved out of this file at its 400-
// code-line ceiling (JOS-503), where the house rule is to split rather than to ratchet; it carries
// the app's ONE scroller plus the two fixed bands above it (the gear area's in-area tab bar,
// JOS-324, and the engine's launch banner, JOS-503). Its header holds all three arguments.
import MainColumn from './components/MainColumn'
// THE CELEBRATION SURFACE (JOS-510 item 2). The three always-mounted detectors — boss kills, Sky
// turn-ins, level dings — plus the two snackbars they open and the alert player, in ONE component
// that owns its own state and renders nothing else. They used to run at THIS component's root,
// which meant every push to kills / loot / turnins / leveling / character re-rendered the entire
// application tree to feed two snackbars. See its header.
import AppCelebrations from './components/AppCelebrations'
// "Another character's log is active — switch?" (JOS-432). Self-contained: it subscribes to its own
// push and switches through the same `character:set` IPC the title bar uses, so the shell gains an
// element and no state. Main guarantees it can ask at most once per candidate log per app session.
import LogSwitchNudge from './components/LogSwitchNudge'
import NoLogsEmptyState from './components/NoLogsEmptyState'
import { VIEW_KEY, loadView, rememberGearTab, type View } from './appViews'
// The app's navigation MODEL — the deep-link routers and their nonce contract. See appRouting.ts.
import { useAppRouting, usePrefsRouting, type AppRouting, type PrefsRouting } from './appRouting'
// The mouse's Back button (JOS-201): the app-level answer, behind whatever drill is on screen.
import { useBackFallback } from './appBack'
import PoskyView from './features/posky/PoskyView'
import LootView from './features/loot/LootView'
import LevelingView from './features/leveling/LevelingView'
import PlannerView from './features/planner/PlannerView'
import GearView from './features/gear/GearView'
// The gear area's third tab (JOS-324). A placeholder panel until JOS-326 fills it, and imported
// plainly rather than lazily: it is a heading and two sentences, which is cheaper than the code
// that would defer it.
import WishlistView from './features/wishlist/WishlistView'
import BossView from './features/bosses/BossView'
import MobsView from './features/mobs/MobsView'
import MapsView from './features/maps/MapsView'
import CombatView from './features/combat/CombatView'
import OverviewView from './features/overview/OverviewView'
import AlertsView from './features/alerts/AlertsView'
import BuffsView from './features/buffs/BuffsView'
import TimersView from './features/timers/TimersView'
import PreferencesView from './features/preferences/PreferencesView'
// TWO FACTS THE PREFERENCES SNAPSHOT CANNOT LEARN FROM A CARD: what the X does (JOS-139 — the tray
// menu carries the same checkbox) and WHICH OVERLAYS ARE OPEN (JOS-408 — the title bar's Overlay
// menu opens them, and the Appearance rows tag a closed one). Both are recorded HERE, at the root.
// See the effect.
import { peekPrefsSnapshot, recordPref } from './features/preferences/prefsSnapshot'
import FeedbackDialog from './features/feedback/FeedbackDialog'
// OWNER-ONLY. `devTriage` holds the single `DEV_TOOLS ? lazy(() => import(…)) : null` — the
// STRIP, which is a compile-time question and stays on `DEV_TOOLS`; in a build without the flag
// its only use below is dead code, so rollup drops the import and the entire triage feature with
// it. WHETHER TO SHOW IT is a second question and a runtime one (`OWNER_TOOLS`, JOS-72). See
// devTriage.tsx / devFlags.ts.
import DevTriageView from './devTriage'
// The CHARACTER SHEET (JOS-45, released JOS-327). It used to come through `unreleasedCharacter.tsx`
// — a `UNRELEASED ? lazy(() => import(…)) : null` twin of `devTriage` above, whose whole job was to
// keep the tree out of packaged bytes. The owner released the tab, so that file is gone and this is
// an ordinary static import like the eleven views above it.
import CharacterView from './features/character/CharacterView'
import { SpellDrill } from './features/spells/SpellPage'
import { SpellLinkProvider } from './lib/spellLink'
import { OWNER_TOOLS } from './devFlags'
import { useFeedbackDialog, type FeedbackPrefill } from './features/feedback/useFeedback'
// Usage analytics (docs/plans/usage-analytics.md). The notice is mounted unconditionally and
// renders nothing once it has been answered; `useViewDwell` reports how long each tab was on
// screen. Both are local: the renderer only ever records into main's ring, and main decides —
// behind the consent gates — whether anything is ever sent.
import { TelemetryNotice } from './features/preferences/TelemetryNotice'
// What's new (JOS-73). The teaser strip is the telemetry notice's twin — one quiet line along
// the bottom edge, never a modal — and renders nothing unless this launch is the first one after
// an update. See features/whatsnew/WhatsNewTeaser.tsx.
import { WhatsNewTeaser } from './features/whatsnew/WhatsNewTeaser'
import { setCurrentView } from './lib/currentView'
import { dwellView, useViewDwell } from './lib/telemetry'

/**
 * The views the router reaches with at most ONE callback — split out of `ViewContent` purely as
 * factoring: the switch is one branch per view, so every view added to the app costs the
 * enclosing function a point of cyclomatic complexity, and the deep-linked views (the ones
 * carrying a nonce'd payload) are the half worth reading. Behaviour is identical: the `key`
 * still lives on each view, so a character rebuild still remounts them.
 *
 * Loot rides here rather than beside Mobs and Combat because its payload is a plain string with
 * no defaults to compose — but it IS a deep link, and it obeys the same nonce contract they do.
 */
function PlainView({
  view,
  viewKey,
  routing,
  onOpenVoicePrefs,
  onOpenOverlayPrefs
}: {
  view: View
  viewKey: string
  routing: AppRouting
  /** CONTRACT with the alerts wave: AlertsView's optional "take me to the voice settings" hook.
   *  Spread rather than named so this tree compiles whether or not that prop exists yet. */
  onOpenVoicePrefs: () => void
  /** The same contract for Preferences → Overlays (JOS-378): the alert editor's on-screen block
   *  links there when the banner overlay is off. */
  onOpenOverlayPrefs: () => void
}): JSX.Element {
  return (
    <>
      {/* The Loot tab stays MOUNTED across a deep link (no `key` churn on item change) —
          remounting per character rebuild only, exactly like Mobs and Combat. */}
      {view === 'loot' && (
        <LootView
          key={viewKey}
          focusItem={routing.lootItem}
          focusNonce={routing.lootNonce}
          onFocusConsumed={routing.clearLootFocus}
          nav={routing.nav}
        />
      )}
      {/* Maps remounts per character rebuild like the rest: the zone it auto-opens comes from
          the character module, which re-hydrates under the new character anyway. */}
      {view === 'maps' && <MapsView key={viewKey} />}
      {/* Leveling stays MOUNTED across a deep link like Loot and Mobs: the level a toast asked
          for arrives through the nonce, not through a remount. */}
      {view === 'leveling' && (
        <LevelingView
          key={viewKey}
          focusLevel={routing.levelFocus}
          focusNonce={routing.levelNonce}
          onFocusConsumed={routing.clearLevelFocus}
          // JOS-78: the in-window drops panel links OUT to an item's Loot drill-down, through the
          // same opener the Planner's donor names use — so the drill's Back returns HERE.
          onOpenLoot={routing.openLoot}
        />
      )}
      {/* The Planner's SETS need no props: they are character-scoped in the store, so the
          remount `key` is the whole character contract. The one prop it takes is the app's own
          router — every donor name in the pane links OUT to that item's Loot drill-down. */}
      {view === 'planner' && <PlannerView key={viewKey} onOpenLoot={routing.openLoot} />}
      {/* GEAR (JOS-284) takes the same one prop and for the same reason: the table reads the
          committed corpus, which is character-independent, so the remount `key` is the whole
          character contract and every item name links OUT to that item's Loot drill-down — which
          is where the per-item tier block is drawn. */}
      {view === 'gear' && <GearView key={viewKey} onOpenLoot={routing.openLoot} />}
      {/* WISH LIST (JOS-324's tab, JOS-326's feature) — one flat list of items this character has
          decided they want, grouped by where to go and get them. Keyed like the rest because a
          wish list is a CHARACTER's: the rebuild counter is how this app says that, and the
          remount is what re-reads the store under the new one. The one prop is the app's router —
          every wish name links OUT to that item's Loot drill-down, the same contract the
          Exaltations tab's donor names use, so the drill's Back arrow comes home here. */}
      {view === 'wishlist' && <WishlistView key={viewKey} onOpenLoot={routing.openLoot} />}
      {view === 'buffs' && <BuffsView key={viewKey} />}
      {/* Respawn clocks (JOS-194). Character-scoped like the rest: the remount `key` is the
          whole contract, since the watch list lives in the store and the clocks are re-derived
          by the fold the character switch kicks off. */}
      {view === 'timers' && <TimersView key={viewKey} />}
      {view === 'alerts' && <AlertsView key={viewKey} {...{ onOpenVoicePrefs, onOpenOverlayPrefs }} />}
      {/* CHARACTER (JOS-45, released JOS-327). It sits HERE, below the no-characters gate, and not
          beside the triage branch: unlike triage this tab reads the game log (name, level, loadout)
          and the character's own inventory dump, so a machine with no EverQuest install has nothing
          to show it. Keyed like the rest — the sheet and its carry-all ledger are one character's,
          and the remount is how this app says that. */}
      {view === 'character' && <CharacterView key={viewKey} />}
      {/* THE SPELL DRILLDOWN (JOS-508). Its view check and its payload check live in the feature
          file, not here: this switch is one branch per view and a branch needing both would have
          cost `PlainView` two points of the measured complexity ceiling. */}
      <SpellDrill view={view} viewKey={viewKey} routing={routing} />
    </>
  )
}

/** Which feature view is on screen. Preferences renders even with zero characters — it's how
 *  a user fixes the install path, so the fresh-machine empty state must never hide it. */
function ViewContent({
  view,
  hasCharacters,
  viewKey,
  routing,
  onOpenPreferences,
  onOpenLeveling,
  onSendFeedback,
  prefs
}: {
  view: View
  hasCharacters: boolean
  viewKey: string
  routing: AppRouting
  onOpenPreferences: () => void
  /** Preferences' Feedback section opens the app-level dialog, preselecting a type. */
  onSendFeedback: (prefill?: FeedbackPrefill) => void
  /** Overview's leveling card → the Leveling tab, carrying no level (`openLoot`'s idiom: ONE
   *  opener, with or without a payload). It went through `AppRouting` the day the tab gained a
   *  deep link of its own — two openers for one destination is how they drift apart. */
  onOpenLeveling: () => void
  /** Which Preferences section a deep link asked for, and the way to retire that request. */
  prefs: PrefsRouting
}): JSX.Element {
  // ABOVE THE EARLY RETURNS, because hooks are. Both were inline arrows until JOS-510 item 2 —
  // harmless while this component re-rendered with the whole app anyway, and now the difference
  // between `PlainView` seeing stable props and seeing two fresh functions every time.
  const { openSection } = prefs
  const onOpenVoicePrefs = useCallback(() => openSection('voice'), [openSection])
  const onOpenOverlayPrefs = useCallback(() => openSection('overlays'), [openSection])
  if (view === 'preferences') {
    return (
      <PreferencesView key={prefs.section ?? 'prefs'} onSendFeedback={onSendFeedback} section={prefs.section} />
    )
  }
  // OWNER-ONLY (`OWNER_TOOLS` = DEV **and** `EQ_OWNER_TOOLS=1`, JOS-72), and ABOVE the
  // no-characters gate on purpose: the triage tab reads the cloud backlog, not the game log, so
  // a machine with no EverQuest install must still reach it.
  if (OWNER_TOOLS && view === 'triage') return <DevTriageView />
  if (!hasCharacters) return <NoLogsEmptyState onOpenPreferences={onOpenPreferences} />
  // EVERY SPELL NAME BELOW THIS LINE IS A LINK (JOS-508) — one provider rather than a prop threaded
  // through AlertsView, BuffsView and LevelingView to the five places a name is drawn.
  // `lib/spellLink.tsx`'s header carries the argument; the short form is that whether a spell name
  // links is a property of the APP, not a per-caller decision. It sits HERE rather than at App's
  // root because this is the exact subtree that draws spell names: Preferences and the owner-only
  // triage tab return above it and draw none, and the overlay bundle — a different window, mounting
  // no provider at all — keeps the plain text it has always had.
  return (
    <SpellLinkProvider open={routing.openSpell}>
      <PlainView
        view={view}
        viewKey={viewKey}
        routing={routing}
        onOpenVoicePrefs={onOpenVoicePrefs}
        onOpenOverlayPrefs={onOpenOverlayPrefs}
      />
      {/* The Mobs tab stays MOUNTED across a deep link (no `key` churn on target
          change) — remounting per character rebuild only, like every other view. */}
      {view === 'mobs' && (
        <MobsView
          key={viewKey}
          target={routing.mobTarget}
          targetNonce={routing.mobNonce}
          onTargetConsumed={routing.clearMob}
          nav={routing.nav}
        />
      )}
      {view === 'bosses' && <BossView key={viewKey} onOpenMob={routing.openMob} />}
      {/* Sky quest items name the mob that drops them, so the tracker links out to the Mobs
          tab exactly the way the boss roster does — and, since 2026-08-04, out to the LOOT
          drill-down for the item itself (owner: clicking a Sky item you are hovering should
          take you to its item page). It keeps its remount `key`: both deep links run the other
          way (out of posky). Its own INBOUND link — a celebration toast anchored at the quest
          that just completed — rides the nonce props instead, so the remount key stays what it
          always was: one per character rebuild. */}
      {view === 'posky' && (
        <PoskyView
          key={viewKey}
          onOpenMob={routing.openMob}
          onOpenLoot={routing.openLoot}
          focusQuest={routing.questKey}
          focusNonce={routing.questNonce}
          onFocusConsumed={routing.clearQuestFocus}
        />
      )}
      {view === 'overview' && (
        <OverviewView
          key={viewKey}
          onOpenCombat={routing.openCombat}
          onOpenMob={routing.openMob}
          onOpenLoot={routing.openLoot}
          onOpenLeveling={onOpenLeveling}
        />
      )}
      {/* Like Mobs, the Combat tab stays MOUNTED across a deep link — the focus arrives
          through the nonce, not through a remount. */}
      {view === 'combat' && (
        <CombatView
          key={viewKey}
          focus={routing.combatFocus}
          focusNonce={routing.combatNonce}
          onFocusConsumed={routing.clearCombatFocus}
        />
      )}
    </SpellLinkProvider>
  )
}

/**
 * THE MEMO BOUNDARY (JOS-510 item 2), and the whole reason item 3 had to land first.
 *
 * Everything right of the nav drawer hangs off this one element, so this is the seam where a
 * re-render of the app SHELL stops being a re-render of every tab, card and meter on screen.
 * Its props are now all stable by construction: `view`, `hasCharacters` and `viewKey` are
 * primitives; `routing` and `prefs` are memoized objects (appRouting.ts); and the three callbacks
 * App hands down are `useCallback`s. So a shell re-render that changed none of them compares equal
 * here and the entire content subtree is skipped.
 *
 * WHAT THAT ACTUALLY BUYS, concretely. App still re-renders for its own reasons — the character
 * list arriving, the live dot, the feedback dialog opening and closing — and every one of those
 * used to walk the whole tree. Opening the feedback dialog is the clearest case: a dialog that
 * renders in a portal was re-rendering the Combat meter behind it.
 *
 * `PlainView` deliberately gets NO memo of its own. It sits inside this boundary and takes the
 * same `routing` and `viewKey` this does, so by the time it renders at all one of its own props
 * has genuinely changed — a second comparison there would cost a comparison and skip nothing.
 */
const ViewContentMemo = memo(ViewContent)

/**
 * THE BOTTOM EDGE, and both of the things allowed to occupy it.
 *
 * Two one-line strips, same shape, same rule: fixed-position and portalled, so they float over
 * the content area without reflowing anything, and NEITHER is ever a modal — this app must never
 * interrupt play. Each renders null unless it has something to say, and the two can never say it
 * at the same time: the telemetry notice is a FIRST-RUN event and the what's-new teaser is
 * suppressed on a fresh install by construction (shared/releaseNotes.ts).
 *
 * A component rather than two lines in App because App is at its factoring ceiling — and because
 * "what may appear along the bottom" is a real thing to be able to read in one place.
 */
function BottomStrips({ prefs }: { prefs: PrefsRouting }): JSX.Element {
  return (
    <>
      <TelemetryNotice onOpenDetails={() => prefs.openSection('analytics')} />
      <WhatsNewTeaser onOpen={() => prefs.openSection('whatsnew')} />
    </>
  )
}

/**
 * Switch the tailed character (the title bar's selector).
 *
 * Module-level, with the state write handed in, because App sits at the 100-code-line function
 * ceiling. `applied` runs ONLY when main actually moved: a refused switch must leave the selector
 * and the live dot exactly as they were rather than optimistically clearing them.
 */
async function selectCharacter(
  logPath: string,
  applied: (character: CharacterRef) => void
): Promise<void> {
  const res = await window.eq.setCharacter(logPath)
  if (res.ok && res.character) applied(res.character)
}

/**
 * The memoized openers a deep link can reach. Passed as ONE object so the router stays inside the
 * parameter ceiling; every member is a `useCallback` from appRouting, which is what lets the
 * `app:focusView` subscription stay a mount-only effect.
 */
interface DeepLinkOpeners {
  openMob: (t: { mob: string }) => void
  openQuest: (quest?: string) => void
  openLeveling: (level?: number) => void
  /** A bare `{view}` focus is a tab switch, so it takes the app's MANUAL navigator (JOS-43). */
  selectView: (v: View) => void
}

/**
 * A DEEP LINK from another window landed (Task #64) — main has already raised + focused us.
 * Three destinations: the Mobs tab, optionally drilled into a specific mob (a click on the events
 * overlay's con rows); the Plane of Sky tab, optionally ANCHORED at the quest that just completed
 * (docs/plans/celebration-toasts.md T6, finished in wave O2); and the Leveling tab, optionally
 * anchored at the level that just dinged (docs/plans/levelup-whats-new.md §2).
 *
 * Every payload field is optional on purpose: a bare view is a tab switch, a view with its anchor
 * is a drill. The nonce lives in the opener, so the same anchor twice arrives twice.
 *
 * A module-level function rather than an inline closure because App is at its factoring ceiling
 * and this is the branchy part of that effect, not the subscription bookkeeping around it.
 */
function applyDeepLink(focus: AppFocus | null, open: DeepLinkOpeners): void {
  if (focus?.view === 'posky') {
    open.openQuest(focus.quest)
    return
  }
  if (focus?.view === 'leveling') {
    open.openLeveling(focus.level)
    return
  }
  if (focus?.view !== 'mobs') return
  if (focus.mob) open.openMob({ mob: focus.mob })
  else open.selectView('mobs')
}

/**
 * THE TWO PREFERENCES FACTS THAT CHANGE WHERE THE PREFERENCES PANE CANNOT SEE THEM.
 *
 * The pane's cards seed from a warm snapshot (JOS-340, features/preferences/prefsSnapshot.ts) and
 * that cache is otherwise only ever written by a card's OWN reply — so anything moved from another
 * surface would be invisible in the pane until the next launch. Two things are:
 *
 *   * WHAT THE X DOES (JOS-139). The tray icon's menu carries the same checkbox, and it is used
 *     precisely while this window is hidden.
 *   * WHICH OVERLAYS ARE OPEN (JOS-408). The Appearance section's rows tag a row whose window is
 *     closed — the one control there whose honest answer to "what does pressing this change on
 *     screen" is "nothing yet" — and the thing that opens those windows is the TITLE BAR's Overlay
 *     menu, used with Preferences nowhere in sight. The card subscribes too, for a pane that is
 *     already open; this is what makes the NEXT mount right.
 *
 * Its own function rather than two more `const off…`s inside App's effect: that component is at the
 * repo's 100-code-line-per-function ceiling, and these two subscriptions are one idea.
 */
function keepPrefsSnapshotCurrent(): () => void {
  const offTray = window.eq.onCloseToTray((p) => {
    recordPref('closeToTray', p)
  })
  const offOverlays = window.eq.onOverlayState((s) => {
    const cur = peekPrefsSnapshot()?.overlayOpen
    if (cur) recordPref('overlayOpen', { ...cur, [s.kind]: s.open })
  })
  return () => {
    offTray()
    offOverlays()
  }
}

export default function App(): JSX.Element {
  const [view, setView] = useState<View>(loadView)
  const [character, setCharacter] = useState<CharacterRef | null>(null)
  const [characters, setCharacters] = useState<CharacterRef[]>([])
  const [live, setLive] = useState(false)
  const [rebuild, setRebuild] = useState(0)
  // The feedback dialog's open-state + seed (Task #65). Also picks up a crash parked by the
  // ErrorBoundary's "Report this", which reloads the window to get here.
  const feedback = useFeedbackDialog()

  // `view` goes IN as well as out: the router parks the tab a cross-view deep link is leaving, so
  // the drill it opens can offer a Back that returns there (JOS-43, navOrigin.ts).
  const routing = useAppRouting(view, setView)
  const prefsRouting = usePrefsRouting(view, routing.selectView)
  const { openMob, openQuest, openLeveling, selectView } = routing
  // The mouse's Back button, when no drill on screen claimed it (JOS-201): the SAME parked-origin
  // walk every Back affordance in the app reads. `back()` reports whether it navigated, so a press
  // with nothing parked is a no-op rather than a surprise tab switch.
  useBackFallback(routing.nav.back)

  // Remember the selected tab across launches (renderer-only) — and, when that tab is one of the
  // gear area's four, remember it a SECOND time as the area's last-used tab (JOS-324). Two keys
  // because they answer two questions: `eq.view` is "where was I", which relaunch restores, while
  // `eq.gear.tab` is "which door does the Gear nav row open", which has to survive visits to every
  // other tab in the app. Written here rather than in the tab bar's click handler so that arriving
  // by deep link or by Back counts as using the tab, which is what a reader means by last-used.
  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view)
    rememberGearTab(view)
  }, [view])

  // How long each tab was on screen, reported ON SWITCH (plan §2). `View` and the schema's
  // `viewDwell` enum are the SAME SET as of JOS-327, which released the last view that was held out
  // of it — `dwellView` still folds an unknown id to `null` rather than reporting it, because
  // widening the enum before the ingest Lambda is deployed would 400 the whole batch and drop every
  // counter with it. `tests/telemetryContract.test.mts` pins the equality in both directions.
  useViewDwell(dwellView(view))

  // …and the same fact, kept for the ERROR reporter (JOS-100). It is a separate mechanism on
  // purpose: `useViewDwell` reports the view you LEFT, on a switch, which is exactly the wrong
  // answer for "which tab was open when it broke". This is a plain module variable because its
  // readers — the global error handlers in main.tsx and ErrorBoundary — run at moments when the
  // React tree is not something to rely on. A view the schema has not learned would set it too and
  // be folded to `unknown` by main's closed-enum check, which is the right outcome: an error there
  // is worth reporting even though the view id is not.
  setCurrentView(view)

  useEffect(() => {
    void window.eq.getCharacter().then(setCharacter)
    void window.eq.listCharacters().then(setCharacters)
    // Any served cursor means the engine is folding live events — light the dot. It was a module
    // DELTA until JOS-499; main folds nothing now, and a cursor is the same evidence: something
    // moved in a module because the log did.
    const offDelta = window.eq.onModuleChanged(() => setLive(true))
    // FIX 3: main pushes onCharacter once state is fully rebuilt (startup + switch).
    // Sync the character and bump a rebuild counter so views reliably remount and
    // re-fetch their snapshots against the freshly-rebuilt state.
    const offChar = window.eq.onCharacter((c) => {
      setCharacter(c)
      setLive(false)
      setRebuild((n) => n + 1)
    })
    // The EQ install dir changed (Settings override applied/cleared): re-list the
    // characters so the TitleBar selector reflects the new folder. Main separately
    // pushes onCharacter if the active tail moved.
    const offEqConfig = window.eq.onEqConfigChanged(() => {
      void window.eq.listCharacters().then(setCharacters)
    })
    const offFocus = window.eq.onFocusView((focus) =>
      applyDeepLink(focus, { openMob, openQuest, openLeveling, selectView })
    )
    const offPrefs = keepPrefsSnapshotCurrent()
    return () => {
      offDelta()
      offChar()
      offEqConfig()
      offFocus()
      offPrefs()
    }
  }, [openMob, openQuest, openLeveling, selectView])

  const onCharacterSwitched = (c: CharacterRef): void => {
    setCharacter(c)
    setLive(false)
  }

  const viewKey = `${character?.logPath ?? 'none'}#${rebuild}`
  // The three callbacks that cross the memo boundary below. Inline arrows here would hand
  // `ViewContentMemo` three fresh functions on every shell re-render and it would never bail out
  // once — the boundary would cost a comparison and buy nothing.
  const onOpenPreferences = useCallback(() => selectView('preferences'), [selectView])
  const onOpenLeveling = useCallback(() => openLeveling(), [openLeveling])
  const hasCharacters = characters.length > 0

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <CssBaseline />

      {/* The single frameless title bar: brand + live dot + character selector +
          window min/max/close buttons. Replaces the OS chrome AND the old AppBar. */}
      <TitleBar
        live={live}
        character={character}
        characters={characters}
        onSelectCharacter={(logPath) => void selectCharacter(logPath, onCharacterSwitched)}
      />

      {/* Everything below the bar: nav drawer + main content, side by side. The engine's launch
          banner (JOS-503) is mounted inside `MainColumn`, above the scroller — see its header. */}
      <Box sx={{ display: 'flex', flexGrow: 1, minHeight: 0 }}>
        {/* MANUAL navigation: `selectView`, not the raw setter — the user choosing a tab by hand
            is also the user ending whatever deep-link journey was parked (navOrigin.ts). */}
        {/* …and it takes the prefs router the way `BottomStrips` does (JOS-254): the patch-notes
            icon beside the version number in the chip at its foot opens a Preferences SECTION,
            which is not a view, so the destination travels as the router rather than as a tab. */}
        <NavDrawer view={view} onSelect={selectView} prefs={prefsRouting} onSendFeedback={() => feedback.openFeedback()} />

        <MainColumn view={view} onSelect={selectView} onReport={feedback.openFeedback}>
          <ViewContentMemo
            view={view}
            hasCharacters={hasCharacters}
            viewKey={viewKey}
            routing={routing}
            prefs={prefsRouting}
            onOpenPreferences={onOpenPreferences}
            onOpenLeveling={onOpenLeveling}
            onSendFeedback={feedback.openFeedback}
          />
        </MainColumn>
      </Box>

      {/* The three always-mounted celebration watches, the two snackbars they open, and the alert
          player — all of it below this component rather than inside it, so a push to any of the
          four modules they read re-renders THEM and not the app. See AppCelebrations. */}
      <AppCelebrations />

      <LogSwitchNudge />

      {/* Feedback is a DIALOG, not a view (appViews.ts is untouched), so it is hosted here and
          opened from the nav footer, from Preferences, and by the ErrorBoundary's "Report this"
          (which reloads and lands a prefilled bug — see useFeedbackDialog). */}
      <FeedbackDialog open={feedback.open} onClose={feedback.close} prefill={feedback.prefill} />

      {/* The bottom edge: the first-run usage-analytics notice (plan T1 — the ONLY thing that
          sets `noticeShown`, which main's network gate requires) and the what's-new teaser
          (JOS-73). Both are slim bars rather than modals, and both render nothing most launches.
          See BottomStrips above. */}
      <BottomStrips prefs={prefsRouting} />
    </Box>
  )
}
