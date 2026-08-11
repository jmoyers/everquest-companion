import { type JSX, useEffect, useState } from 'react'
import { Box, CssBaseline, Snackbar, Alert } from '@mui/material'
import ShieldMoonIcon from '@mui/icons-material/ShieldMoon'
import EmojiEventsIcon2 from '@mui/icons-material/EmojiEvents'
import type { AppFocus, CharacterDelta, CharacterRef, CharacterSnap } from '@shared/types'
import TitleBar from './components/TitleBar'
import NavDrawer from './components/NavDrawer'
import NoLogsEmptyState from './components/NoLogsEmptyState'
import { VIEW_KEY, loadView, type View } from './appViews'
// The app's navigation MODEL — the deep-link routers and their nonce contract. See appRouting.ts.
import { useAppRouting, usePrefsRouting, type AppRouting, type PrefsRouting } from './appRouting'
// The mouse's Back button (JOS-201): the app-level answer, behind whatever drill is on screen.
import { useBackFallback } from './appBack'
import PoskyView from './features/posky/PoskyView'
import LootView from './features/loot/LootView'
import LevelingView from './features/leveling/LevelingView'
import PlannerView from './features/planner/PlannerView'
import BossView from './features/bosses/BossView'
import MobsView from './features/mobs/MobsView'
import MapsView from './features/maps/MapsView'
import CombatView from './features/combat/CombatView'
import OverviewView from './features/overview/OverviewView'
import AlertsView from './features/alerts/AlertsView'
import BuffsView from './features/buffs/BuffsView'
import TimersView from './features/timers/TimersView'
import PreferencesView from './features/preferences/PreferencesView'
import FeedbackDialog from './features/feedback/FeedbackDialog'
// OWNER-ONLY. `devTriage` holds the single `DEV_TOOLS ? lazy(() => import(…)) : null` — the
// STRIP, which is a compile-time question and stays on `DEV_TOOLS`; in a build without the flag
// its only use below is dead code, so rollup drops the import and the entire triage feature with
// it. WHETHER TO SHOW IT is a second question and a runtime one (`OWNER_TOOLS`, JOS-72). See
// devTriage.tsx / devFlags.ts.
import DevTriageView from './devTriage'
// UNRELEASED (JOS-45). Same shape, different axis: a product surface awaiting the owner's
// review rather than operator tooling. See unreleasedCharacter.tsx / devFlags.ts.
import UnreleasedCharacterView from './unreleasedCharacter'
import { OWNER_TOOLS, UNRELEASED } from './devFlags'
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
import { useModule } from './lib/useModule'
import { dwellView, useViewDwell } from './lib/telemetry'
import AlertPlayer, { fireAppSignal } from './features/alerts/player'
import { getBossData } from './data'
import { useBossKills } from './features/bosses/useBossKills'
import type { TargetStatus } from './features/bosses/bossStatus'
import { useProgress } from './features/posky/useProgress'
// The canonical `Class::Name` quest key — the same one the tracker keys its rows on, so the
// toast's anchor and the accordion it opens are the same string by construction.
import { questKey } from './features/posky/keys'
// The third always-mounted celebration watch (docs/plans/levelup-whats-new.md §2): a LIVE ding
// fires the level-up toast, counting what it unlocked against the loadout AT THE DING'S ts.
import { useLevelUpToast } from './features/leveling/useLevelUpToast'
import { skyQuestPage } from '@shared/wiki'
import { tierStyle } from './lib/tierChip'

const bossData = getBossData()

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
  onOpenVoicePrefs
}: {
  view: View
  viewKey: string
  routing: AppRouting
  /** CONTRACT with the alerts wave: AlertsView's optional "take me to the voice settings" hook.
   *  Spread rather than named so this tree compiles whether or not that prop exists yet. */
  onOpenVoicePrefs: () => void
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
      {view === 'buffs' && <BuffsView key={viewKey} />}
      {/* Respawn clocks (JOS-194). Character-scoped like the rest: the remount `key` is the
          whole contract, since the watch list lives in the store and the clocks are re-derived
          by the fold the character switch kicks off. */}
      {view === 'timers' && <TimersView key={viewKey} />}
      {view === 'alerts' && <AlertsView key={viewKey} {...{ onOpenVoicePrefs }} />}
      {/* UNRELEASED (JOS-45). It sits HERE, below the no-characters gate, and not beside the
          triage branch: unlike triage this tab reads the game log (name, level, loadout) and
          the character's own inventory dump, so a machine with no EverQuest install has
          nothing to show it. `UNRELEASED` folds to a literal in every build, so the branch and
          the lazily-imported tree behind it are deleted from shipped bytes. */}
      {UNRELEASED && view === 'character' && <UnreleasedCharacterView key={viewKey} />}
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
  return (
    <>
      <PlainView
        view={view}
        viewKey={viewKey}
        routing={routing}
        onOpenVoicePrefs={() => prefs.openSection('voice')}
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
    </>
  )
}

/** The two app-wide celebration toasts — they fire on ANY tab, so they live at app level. */
function CelebrationToasts({
  defeatToast,
  questToast,
  onDismissDefeat,
  onDismissQuest
}: {
  defeatToast: TargetStatus | null
  questToast: string | null
  onDismissDefeat: () => void
  onDismissQuest: () => void
}): JSX.Element {
  return (
    <>
      <Snackbar
        open={!!defeatToast}
        autoHideDuration={6000}
        onClose={onDismissDefeat}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert
          severity="success"
          variant="filled"
          icon={<EmojiEventsIcon2 fontSize="inherit" />}
          onClose={onDismissDefeat}
          sx={{ alignItems: 'center' }}
        >
          Raid target defeated: {defeatToast?.target.name}!
        </Alert>
      </Snackbar>

      <Snackbar
        open={!!questToast}
        autoHideDuration={6000}
        onClose={onDismissQuest}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert
          severity="success"
          variant="filled"
          icon={<ShieldMoonIcon fontSize="inherit" />}
          onClose={onDismissQuest}
          sx={{ alignItems: 'center' }}
        >
          Quest complete: {questToast}
        </Alert>
      </Snackbar>
    </>
  )
}

/**
 * The two ALWAYS-MOUNTED celebration watches, so both fire on any tab.
 *
 * Boss kills: useBossKills gates out the historical baseline. This is the SINGLE
 * always-mounted detector, so it's the one place we fire the 'bossDefeat' app signal for
 * the alerts extension. ONE callback carries all three surfaces — snackbar, sound and toast
 * fire on any roster kill CREDITED to you, repeats included, matching the confetti the Boss
 * tab bursts. A boss killed by a stranger in open world is tracked and celebrated by nobody
 * (owner, 2026-08-05); the credit test is the log's own experience line, which is also why a
 * GROUP kill still celebrates — party experience is experience.
 *
 * It used to be two (Task #24): the sound rode a narrower `onNewDefeat` — first kill at a new
 * instance tier — so the app cheered a repeat kill on screen and said nothing. Retired by the
 * owner 2026-08-04: "every time is worth celebrating." The alert's own cooldown is the rate
 * limit now, and fireAppSignal applies it, so even if the Boss tab's own detector fires in
 * the same instant it can't double-play.
 *
 * Sky turn-ins: useProgress seeds a silent baseline on the first hydrated snapshot, so
 * historical completions on load never fire — only a live turn-in transition does
 * (Task #46). This is the SINGLE always-mounted place we fire the 'questComplete' app
 * signal (sound) + the app-wide snackbar; PoskyView's own useProgress additionally bursts
 * confetti when that tab is open, and the shared cooldown stops a double-play. It is also
 * the ONE place a quest completion is reported into the live event feed (Task #59) — only
 * the renderer can match turn-ins against the posky dataset, so main can't detect this
 * itself. The report carries the QUEST link (the class's Plane of Sky Tests wiki page —
 * there are no per-quest pages) and, when the dataset names one, the reward item for the
 * event overlay's hover card. A quest with no known reward reports none: no fabricated
 * item (law 1).
 */
function useAppCelebrations(
  onDefeat: (s: TargetStatus) => void,
  onQuestComplete: (name: string) => void
): void {
  // Level-ups: the third watch, and the only one with no on-screen surface of its own — the
  // overlay card IS the celebration. It seeds its own silent baseline (the startup replay holds
  // every level the character ever gained) and joins its counts to the combo at the ding's ts.
  useLevelUpToast()

  // WHERE YOU ARE, from the module that owns that question (the ZoneStrip precedent). Read as a
  // plain value, not a ref: `useBossKills` refreshes its callback from every render before its
  // effect runs, so the closure below always holds the zone of the render the kill arrived in.
  const zone = useModule<CharacterSnap, CharacterDelta>('character', (s, d) => ({ ...s, ...d }))?.zone

  useBossKills(bossData.targets, {
    // THE TIER OF THIS KILL, AND THE INSTANCE IT HAPPENED IN (JOS-165). This block used to print
    // `tierStyle(s.bestTier)` and the roster's static zone — the target's ALL-TIME summary, which
    // is the right thing for the boss card and a false sentence on a per-event toast: the owner
    // clears d0 through d4 every week, so a Sunday d1 kill announced itself "D4 · Refined" all
    // the way back to the first Saturday he beat it at d4. The tier now comes off the KILL
    // (bossStatus.BossKill) and the zone off the CHARACTER module, so the toast says the instance
    // you were standing in — raw, as the game spells it (law 2), which is also the only way to
    // tell "- Solo 1 (Awakened)" from "- Group 2 (Awakened)". Only the toast changed: the card
    // badge still means highest-ever, because a card is a summary.
    onKill: ({ status: s, tier }) => {
      onDefeat(s)
      fireAppSignal('bossDefeat', s.target.name)
      window.eq.showToast({
        id: `boss:${s.target.name}:${String(s.lastTs)}`,
        kind: 'bossKill',
        title: `${s.target.name} defeated`,
        // A zone we have never seen a line for falls back to the roster's — never invented.
        subtitle: [tierStyle(tier).long, zone ?? s.target.zone].filter(Boolean).join(' · ')
      })
    }
  })

  useProgress({
    onQuestComplete: (q, count) => {
      onQuestComplete(q.name)
      fireAppSignal('questComplete', q.name)
      // The celebration toast (docs/plans/celebration-toasts.md T4) rides the SAME detector as
      // the sound and the snackbar — one live-only gate, three surfaces. The reward is sent by
      // NAME; main resolves the item card, because the overlay fetches nothing.
      // THE COUNT IS IN THE ID (JOS-131): a Sky quest can be run again, and the overlay keys its
      // cards by id, so the second turn-in of one quest has to be a second card.
      window.eq.showToast({
        id: `quest:${q.className}::${q.name}#${String(count)}`,
        kind: 'skyQuestComplete',
        title: `Quest complete: ${q.name}`,
        subtitle: q.giver ? `${q.className} · turned in to ${q.giver}` : q.className,
        itemName: q.reward,
        // ANCHORED AT THE QUEST since wave O2 (wave L shipped the tab and flagged this as the
        // follow-up): the canonical `Class::Name` key, which is what PoskyView reveals on.
        focus: { view: 'posky', quest: questKey(q) }
      })
      window.eq.reportFeedEvent({
        kind: 'quest',
        ts: Date.now(),
        title: q.name,
        detail: q.giver ? `turned in to ${q.giver}` : q.className,
        page: skyQuestPage(q.className),
        reward: q.reward ? { item: q.reward, page: q.rewardPage, stats: q.rewardStats } : undefined
      })
    }
  })
}

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

export default function App(): JSX.Element {
  const [view, setView] = useState<View>(loadView)
  const [character, setCharacter] = useState<CharacterRef | null>(null)
  const [characters, setCharacters] = useState<CharacterRef[]>([])
  const [live, setLive] = useState(false)
  // App-wide "raid target defeated" toast — fires on any tab.
  const [defeatToast, setDefeatToast] = useState<TargetStatus | null>(null)
  // App-wide "quest complete" toast — fires on any tab the instant a Sky turn-in
  // auto-completes a quest.
  const [questToast, setQuestToast] = useState<string | null>(null)

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

  useAppCelebrations(setDefeatToast, setQuestToast)

  // Remember the selected tab across launches (renderer-only).
  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view)
  }, [view])

  // How long each tab was on screen, reported ON SWITCH (plan §2). `View` and the schema's
  // `viewDwell` enum are the same set apart from the UNRELEASED views, which report nothing:
  // widening the enum before the ingest Lambda is deployed would 400 the whole batch and drop
  // every counter with it (JOS-45; `dwellView` states the rule).
  useViewDwell(dwellView(view))

  // …and the same fact, kept for the ERROR reporter (JOS-100). It is a separate mechanism on
  // purpose: `useViewDwell` reports the view you LEFT, on a switch, which is exactly the wrong
  // answer for "which tab was open when it broke". This is a plain module variable because its
  // readers — the global error handlers in main.tsx and ErrorBoundary — run at moments when the
  // React tree is not something to rely on. An UNRELEASED view sets it too and is folded to
  // `unknown` by main's closed-enum check, which is the right outcome: an error there is worth
  // reporting even though the view id is not.
  setCurrentView(view)

  useEffect(() => {
    void window.eq.getCharacter().then(setCharacter)
    void window.eq.listCharacters().then(setCharacters)
    // Any live module delta means the tail is producing events — light the dot.
    const offDelta = window.eq.onModuleDelta(() => setLive(true))
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
    return () => {
      offDelta()
      offChar()
      offEqConfig()
      offFocus()
    }
  }, [openMob, openQuest, openLeveling, selectView])

  const onCharacterSwitched = (c: CharacterRef): void => {
    setCharacter(c)
    setLive(false)
  }

  const viewKey = `${character?.logPath ?? 'none'}#${rebuild}`

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
        onOpenPreferences={() => selectView('preferences')}
      />

      {/* Everything below the bar: nav drawer + main content, side by side. */}
      <Box sx={{ display: 'flex', flexGrow: 1, minHeight: 0 }}>
        {/* MANUAL navigation: `selectView`, not the raw setter — the user choosing a tab by hand
            is also the user ending whatever deep-link journey was parked (navOrigin.ts). */}
        <NavDrawer view={view} onSelect={selectView} onSendFeedback={() => feedback.openFeedback()} />

        <Box
          component="main"
          sx={{ flexGrow: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
        >
          <Box sx={{ flexGrow: 1, overflow: 'auto', p: 2 }}>
            <ViewContent
              view={view}
              hasCharacters={characters.length > 0}
              viewKey={viewKey}
              routing={routing}
              prefs={prefsRouting}
              onOpenPreferences={() => selectView('preferences')}
              onOpenLeveling={() => openLeveling()}
              onSendFeedback={feedback.openFeedback}
            />
          </Box>
        </Box>
      </Box>

      {/* Always-mounted: plays fired alert sounds regardless of the active tab. */}
      <AlertPlayer />

      <CelebrationToasts
        defeatToast={defeatToast}
        questToast={questToast}
        onDismissDefeat={() => setDefeatToast(null)}
        onDismissQuest={() => setQuestToast(null)}
      />

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
