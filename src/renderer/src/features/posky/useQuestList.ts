// useQuestList — everything the Quests tab REMEMBERS and DERIVES, in one hook.
//
// PoskyView is a container: it owns the confetti burst, the inventory-reload toast, and the
// layout. The list state — which tab, which classes, the search box, the sort, the three
// hide-toggles, the page cap — plus the filter/sort/pin derivation it feeds all live here, so
// the view can stay a view. The state deliberately lives ABOVE the tab switch (in the hook the
// container calls, not inside the Quests tab's markup) so flipping to Ignored and back does not
// reset the filters you had set up.
//
// EIGHT of those choices outlive the hook entirely, in localStorage: the class filter, the sort
// order, the two hide-boxes ("hide completed", JOS-90; "hide turned in", JOS-145 — see
// useStoredFlag), the island/boss facets (JOS-124), the Ready tab's first-time toggle
// (JOS-155, the only one that ships ticked) and "show all quests at once" (JOS-191). Living above
// the Quests/Ignored switch was never enough for them, because leaving the Sky tab for another
// VIEW unmounts this hook outright.

import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { QuestProgress } from './useProgress'
import { useFavorites } from '../favorites/useFavorites'
import { useQuestFavorites, useQuestIgnored, type QuestFlagSet } from '../favorites/useQuestFlags'
import { DEFAULT_SORT, isSortKey, orderQuests, type SortKey } from './questSort'
import { facetOptions, filterByFacets, type FacetOptions } from './questFacets'
// What the search box searches (JOS-207): the quest name, the reward, the required item names,
// and — through the facets' own derivations, so there is one truth per quest and not two — the
// bosses it stands in front of and the islands it names.
import { filterByQuery } from './questSearch'
// The two readings of "done" this tab offers, and the argument for keeping them apart (JOS-131 for
// has-every-item-now, JOS-145 for has-ever-turned-in). Two lines of code, a page of reasoning, and
// a node test — so they live in their own pure module.
import { everTurnedIn, firstTimeReady, hasEveryItem, readyQuests } from './questCompletion'
// The Targets tab's whole model (issue #30) — pure, node-tested, and fed the VISIBLE set below so
// ignoring a quest takes its wants out of the kill list by the same one rule every tab obeys.
import { skyTargets, type SkyTargetsModel } from './skyTargets'

export type { SortKey }

/**
 * Quests · Ready · Targets · Cleanup · Classes · Ignored. `ready` is JOS-147's turn-in list (rule
 * in questCompletion); `targets` is issue #30's kill list (rule in skyTargets.ts); `cleanup` is
 * JOS-389's spare-items list (rule in cleanup.ts); `classes` is JOS-148's per-class unlock
 * progress (rule in classUnlocks.ts). None of them reads any of the filter state below — they are
 * derivations over the same quests, which is why the tab key is the only thing each of them adds
 * to this hook.
 */
export type TabKey = 'quests' | 'ready' | 'targets' | 'cleanup' | 'classes' | 'ignored'

// How many Accordions to render before the "show more" cap kicks in. Exported because the LIST'S
// FOOTER has to know it too (PoskyView.ListFooter): once "show all" is on there is no cap left to
// compare against, so "is this list even long enough to be worth an off switch" is asked of this.
export const QUEST_PAGE = 40

const SELECTED_CLASSES_KEY = 'eq.selectedClasses'
const SORT_KEY = 'eq.questSort'
const HIDE_COMPLETED_KEY = 'eq.posky.hideCompleted'
const HIDE_TURNED_IN_KEY = 'eq.posky.hideTurnedIn'
const ISLANDS_KEY = 'eq.posky.islands'
const BOSSES_KEY = 'eq.posky.bosses'
/** JOS-155's Ready-tab toggle. Absent means ON — see the `useStoredFlag` default below. */
const READY_FIRST_TIME_KEY = 'eq.posky.readyFirstTimeOnly'
/** JOS-417's Targets-tab toggle — its OWN key, on JOS-155's rule that a user who wants one
 *  reading of one tab is never handed the other by an upgrade. Absent means ON. */
const TARGETS_FIRST_TIME_KEY = 'eq.posky.targetsFirstTimeOnly'
/** JOS-191's "show all quests at once". Absent means OFF — a fresh install still pages. */
const SHOW_ALL_KEY = 'eq.posky.showAll'

/** A stored list of picked names. Anything that is not an array of strings reads as no picks —
 *  a corrupt or hand-edited value degrades to the default rather than throwing the tab away. */
function loadNames(key: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * State that IS a stored preference: the load is the initialiser, the write is the effect, and
 * the caller cannot get one without the other. The class filter, the island facet and the boss
 * facet are the same promise three times (JOS-90's rule, JOS-124's two new keys), so they are
 * the same nine lines once.
 */
function useStoredNames(key: string): [string[], (v: string[]) => void] {
  const [value, setValue] = useState<string[]>(() => loadNames(key))
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value))
  }, [key, value])
  return [value, setValue]
}

/** The sort order, stored. An order retired from SORT_OPTIONS falls back to the default rather
 *  than sorting by nothing. */
function useStoredSort(): [SortKey, (v: SortKey) => void] {
  const [sort, setSort] = useState<SortKey>(() => {
    const v = localStorage.getItem(SORT_KEY)
    return isSortKey(v) ? v : DEFAULT_SORT
  })
  useEffect(() => {
    localStorage.setItem(SORT_KEY, sort)
  }, [sort])
  return [sort, setSort]
}

/**
 * "Hide completed" is a PLACE IN THE GRIND, not a momentary filter (JOS-90). Hiding the quests
 * you are done with is how a user says "show me what is left", and that answer is true until
 * they say otherwise — but the state lived in plain `useState`, and `App`'s `ViewContent` mounts
 * exactly ONE feature view at a time, so every trip to another tab unmounted the hook and handed
 * the list back with completed quests in it. Same storage as the class filter and the sort order
 * two lines up, so it survives the tab switch AND the restart by the same mechanism.
 *
 * '1'/'0' is the one-bit view-pref idiom (features/combat/useCombatPrefs.ts). An ABSENT key is
 * the DEFAULT (false — a fresh install shows everything), never `false` itself: a user who has
 * never touched the box has not un-ticked it.
 *
 * THE BOX AND THE PREF ARE ONE THING — which is the whole reason `revealQuest`'s un-tick (below)
 * persists too rather than being a hidden temporary override. A deep link that reveals a completed
 * quest genuinely leaves the box unticked on screen, and what the user is looking at is what they
 * get back next time; re-ticking it is the same one click that set it.
 *
 * NOT WHITELISTED for share bundles (shared/shareSchema.ts UI_PREF_SPECS), deliberately: a new
 * key is private by default, and where one player is in Sky is not a setting worth exporting.
 * The two JOS-124 facet keys inherit that decision, and so does JOS-145's.
 *
 * JOS-145's "hide turned in" is the SAME nine lines under `eq.posky.hideTurnedIn`, and a SEPARATE
 * key on purpose. One key holding two meanings would either silently change what an existing
 * user's tick does, or need a migration to invent a preference nobody expressed; two independent
 * bits let each box mean only itself, and the default for the new one is the same absent-means-
 * false a fresh install gets for the old one.
 *
 * JOS-155 GENERALISED THE ABSENT KEY, because its box is the first one here that ships TICKED.
 * `whenAbsent` is what a key nobody has written yet reads as, so the Ready tab's toggle passes
 * `true` and its stored sense is INVERTED relative to every other flag in this file: '0' is the
 * user having turned it OFF, and an absent key is ON rather than off. The invariant is unchanged
 * and is the one that matters — a stored value is only ever a choice the user MADE, and the
 * default is what we do until they make one. Nothing is migrated and no existing key moves.
 */
function useStoredFlag(key: string, whenAbsent = false): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    const raw = localStorage.getItem(key)
    return raw === null ? whenAbsent : raw === '1'
  })
  useEffect(() => {
    localStorage.setItem(key, value ? '1' : '0')
  }, [key, value])
  return [value, setValue]
}

/**
 * The Quests/Ignored split. Ignored quests are gone from the main list, its filters, its facet
 * options and its counts — they exist only under the Ignored tab, where the same button
 * un-ignores them. JOS-147's Ready tab reads the SHOWN half too: ignoring a quest is the one flag
 * that means "never show me this", so it holds on every tab that is not the Ignored tab itself.
 */
function useVisibleQuests(
  quests: QuestProgress[],
  ignoredKeys: ReadonlySet<string>
): [QuestProgress[], QuestProgress[], QuestProgress[]] {
  return useMemo(() => {
    const shown: QuestProgress[] = []
    const hidden: QuestProgress[] = []
    for (const q of quests) (ignoredKeys.has(q.key.toLowerCase()) ? hidden : shown).push(q)
    hidden.sort((a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name))
    // The THIRD list, from the same one pass (JOS-147): the quests you are holding every item for.
    // It is derived here, beside the split, because that is the code saying out loud what the tab
    // depends on — the ignore flag and the item counts, and no filter state whatsoever. JOS-155's
    // first-time toggle narrows this OUTSIDE the memo, so flipping the box re-filters an already
    // built list instead of re-splitting every quest.
    return [shown, hidden, readyQuests(shown)]
  }, [quests, ignoredKeys])
}

function questHasFavorite(q: QuestProgress, isFavorite: (name: string) => boolean): boolean {
  return q.items.some((it) => isFavorite(it.name))
}

/**
 * The page cap, and the three things that move it: "show more" adds a page, "show all" takes the
 * cap off for good, and a change to WHAT THE USER ASKED TO SEE starts again from the top.
 *
 * Its own hook because it is the one piece of list state that is about RENDERING COST rather than
 * about what the user asked to see — accordions are variable-height, so this list caps and
 * paginates instead of windowing, and the cap is what keeps a keystroke from re-rendering more
 * than QUEST_PAGE quests at once. `reset` is exported beside `showMore` because `revealQuest` has
 * to put the user back at the top of a list it just re-filtered.
 *
 * IT USED TO RESET ON THE FILTERED ARRAY'S IDENTITY, AND THAT IS THE JOS-191 DEFECT. `filtered` is
 * a `useMemo` over the quests AND the favorites, and `quests` is itself rebuilt every time the loot
 * ledger appends, a turn-in is written, or an inventory reload lands. So the effect fired on things
 * that are not a request at all: starring a quest, favoriting an item off a chip, and any drop
 * arriving while the tab was open each handed back a NEW array and snapped a list the user had
 * paged all the way open back to the first 40 rows — with everything past row 40 unmounted, taking
 * its expanded accordion with it. The reporter's words were that clicking anything "resets the page
 * to collapsed", and that is this line.
 *
 * So the reset key is now the SELECTION — the class/island/boss picks, the search, the sort and the
 * four hide-boxes, i.e. exactly the controls whose whole purpose is to change which rows are in the
 * list — passed as a value-compared string rather than an array identity. A new search shows from
 * the top, as it always did; new DATA under an unchanged question leaves the user's place alone.
 * Nothing here reads the rows themselves, which is the point: the cap answers "how much of this did
 * you ask to see", and no amount of the list changing underneath is the user asking again.
 *
 * `showAll` is the persisted half (JOS-90's rule, the seventh preference in this file — see
 * `useStoredFlag`): a player who says "all of them" means it across the tab switch that unmounts
 * this hook and across the restart, not only until the next drop. Turning it off resets the page
 * count with it, so "show fewer" lands on the first page rather than wherever they had paged to.
 */
function usePaging(selectionKey: string): {
  visibleCount: number
  showMore: () => void
  showAll: boolean
  setShowAll: (v: boolean) => void
  reset: () => void
} {
  const [showAll, setShowAll] = useStoredFlag(SHOW_ALL_KEY)
  const [pageCap, setPageCap] = useState(QUEST_PAGE)
  useEffect(() => {
    setPageCap(QUEST_PAGE)
  }, [selectionKey])
  return {
    // No cap at all when the user asked for the lot: `slice(0, Infinity)` is the whole list, and
    // `length > Infinity` is false, so the "show more" affordance disappears by the same test that
    // draws it. A number equal to today's row count would be a THIRD thing to keep in step.
    visibleCount: showAll ? Number.POSITIVE_INFINITY : pageCap,
    showMore: () => {
      setPageCap((n) => n + QUEST_PAGE)
    },
    showAll,
    setShowAll: (v: boolean) => {
      setShowAll(v)
      if (!v) setPageCap(QUEST_PAGE)
    },
    reset: () => {
      setPageCap(QUEST_PAGE)
    }
  }
}

/**
 * The Ready tab's list and the ONE control that narrows it (JOS-155).
 *
 * Its own hook because it is the only state on this tab: the toggle, the list it produces, and how
 * many rows the toggle is holding back, which is the number the empty state needs to be able to say
 * "there are refarms behind this box". `allReady` is the membership rule (useVisibleQuests), so the
 * narrowing happens here and the split above never re-runs when the box is clicked.
 */
function useReadySet(allReady: QuestProgress[]): {
  ready: QuestProgress[]
  readyFirstTimeOnly: boolean
  setReadyFirstTimeOnly: (v: boolean) => void
  readyRefarmCount: number
} {
  // The one flag in this file whose default is ON, hence the `true` (argued on useStoredFlag).
  const [readyFirstTimeOnly, setReadyFirstTimeOnly] = useStoredFlag(READY_FIRST_TIME_KEY, true)
  const ready = useMemo(
    () => (readyFirstTimeOnly ? firstTimeReady(allReady) : allReady),
    [allReady, readyFirstTimeOnly]
  )
  return {
    ready,
    readyFirstTimeOnly,
    setReadyFirstTimeOnly,
    readyRefarmCount: allReady.length - ready.length
  }
}


/**
 * The Targets tab's model (issue #30), derived from the VISIBLE quests and from nothing else —
 * not the class filter, not the facets, not the hide-boxes, on the Ready tab's exact argument:
 * the controls are not drawn on this tab, so no invisible state can be narrowing it. Its own
 * hook, like `useReadySet` above, so `useQuestList`'s body stays under the measured per-function
 * ceiling. The tab's COUNT reads `targets.mobs.length` — the same array the pane draws.
 *
 * ITS ONE CONTROL IS `useReadySet`'S, DOWN TO THE DEFAULT (JOS-417): a stored first-time-only flag
 * under its own key, ON when absent. Same reasoning as JOS-155, and the same reason the count of
 * what it holds back comes back with it — a toggle that can empty a tab has to be able to SAY it
 * did. The held-back number is quests, not mobs: mobs are what the pane draws, but "3 you have run
 * before still want items" is the sentence a player can act on, and counting the mobs behind the
 * box would need a second full fold on every render to produce a number nobody asked for.
 */
function useTargetsModel(visible: QuestProgress[]): {
  targets: SkyTargetsModel
  targetsFirstTimeOnly: boolean
  setTargetsFirstTimeOnly: (v: boolean) => void
  targetsRefarmCount: number
} {
  const [targetsFirstTimeOnly, setTargetsFirstTimeOnly] = useStoredFlag(TARGETS_FIRST_TIME_KEY, true)
  const targets = useMemo(
    () => skyTargets(visible, targetsFirstTimeOnly),
    [visible, targetsFirstTimeOnly]
  )
  // A quest the box is holding back AND that still wants something — `missing` is
  // computeQuestProgress's own per-quest list, so a refarm sitting at full holdings is not counted
  // as work the user is being denied a view of.
  const targetsRefarmCount = useMemo(
    () => (targetsFirstTimeOnly ? visible.filter((q) => everTurnedIn(q) && q.missing.length > 0).length : 0),
    [visible, targetsFirstTimeOnly]
  )
  return { targets, targetsFirstTimeOnly, setTargetsFirstTimeOnly, targetsRefarmCount }
}

interface QuestSelection {
  quests: QuestProgress[]
  selectedClasses: string[]
  /** the picked islands ("Island 3"), and the picked bosses by catalog name (JOS-124) */
  islands: string[]
  bosses: string[]
  query: string
  sort: SortKey
  hideCompleted: boolean
  hideTurnedIn: boolean
  hideNoItems: boolean
  favoritesOnly: boolean
  isFavorite: (name: string) => boolean
  isQuestFavorite: (questKey: string) => boolean
}

/** Filter → sort → pin, in that order. Pure, so the useMemo below is the only caller state. */
function selectQuests(sel: QuestSelection): QuestProgress[] {
  const { isFavorite, isQuestFavorite } = sel
  let list: readonly QuestProgress[] = sel.quests
  if (sel.selectedClasses.length) list = list.filter((x) => sel.selectedClasses.includes(x.className))
  // The island/boss facets, both dimensions in one pass (questFacets.ts owns the semantics).
  list = filterByFacets(list, sel)
  // The two readings of "done", as two independent narrowings applied one after the other, which
  // is what makes them AND (JOS-131 for has-every-item-now, JOS-145 for has-ever-turned-in).
  // Neither reads the other's state, so ticking one can never change what the other does.
  if (sel.hideCompleted) list = list.filter((x) => !hasEveryItem(x))
  if (sel.hideTurnedIn) list = list.filter((x) => !everTurnedIn(x))
  if (sel.hideNoItems) list = list.filter((x) => x.needCount > 0)
  // "Favorites only" = the quest itself is starred OR it needs a starred item.
  if (sel.favoritesOnly)
    list = list.filter((x) => isQuestFavorite(x.key) || questHasFavorite(x, isFavorite))
  // The typed query, in ONE pass over five fields (questSearch.ts owns the rule): the quest name,
  // the reward, the item names, and since JOS-207 the quest's bosses and islands — the latter two
  // read through the same `questBosses`/`questIslands` the facet dropdowns are built from, so the
  // box and the pickers can never disagree about what a quest's bosses and islands are. An empty
  // query hands the caller's own array straight back.
  list = filterByQuery(list, sel.query)
  // A quest the user STARRED outright outranks one that merely contains a favorited item — the
  // star is an explicit "I'm working on this", so it pins even once turned in; the item-level pin
  // stays what it always was (only while the quest still needs something, which since JOS-131 is
  // `hasEveryItem` rather than the turn-in flag).
  //
  // WHETHER THE PIN IS APPLIED AT ALL IS THE SORT'S CALL NOW (JOS-146, questSort.pinsFavorites).
  // It used to be an unconditional second `sort()` right here, which meant a star silently beat
  // every order the user could pick — including "most recently looted", whose whole answer is
  // which quest your last loot belonged to. `orderQuests` owns both passes so the rule is stated
  // in one place and testable without a browser.
  const rank = (x: QuestProgress): number =>
    isQuestFavorite(x.key) ? 2 : !hasEveryItem(x) && questHasFavorite(x, isFavorite) ? 1 : 0
  return orderQuests(list, sel.sort, rank)
}

export interface QuestListState {
  tab: TabKey
  setTab: (t: TabKey) => void
  /** quests NOT ignored — the list, its filters and its counts all describe this set */
  visible: QuestProgress[]
  /** the ignored ones, class-then-name sorted, for the Ignored tab */
  ignored: QuestProgress[]
  /**
   * The Ready tab (JOS-147): the quests you are holding every required item for, right now.
   *
   * Derived from `visible` and from NOTHING ELSE — not the class filter, not the facets, not the
   * search box, not the two hide-boxes. `questCompletion.readyQuests` states why at length; the
   * short version is that "hide completed" is the same predicate, so obeying it could only empty
   * the tab. None of those controls is drawn on this tab either.
   *
   * The ONE thing it does obey is the tab's own toggle (JOS-155): with `readyFirstTimeOnly` set —
   * which is the default — the quests you have handed in before are out of this list, and so out
   * of the tab's count, because the count IS this array's length.
   */
  ready: QuestProgress[]
  /**
   * The Targets tab (issue #30): every mob still worth killing for the quests that still want
   * something, plus the two honest remainders (the random-drop Wind Runes and the items nothing
   * committed can source). Derived from `visible` and from the toggle below — the rule and its
   * arguments live in skyTargets.ts.
   */
  targets: SkyTargetsModel
  /** the Targets tab's own toggle (JOS-417), the Ready tab's shape: ON leaves the quests you have
   *  already handed in out of the fold. Default ON, stored under its own key. */
  targetsFirstTimeOnly: boolean
  setTargetsFirstTimeOnly: (v: boolean) => void
  /** how many quests that toggle is holding back that still want items — the number the pane needs
   *  to be able to say there is more behind the box. Zero when the box is unticked. */
  targetsRefarmCount: number
  /** `visible` after the filters, the sort and the favorite pinning */
  filtered: QuestProgress[]
  selectedClasses: string[]
  setSelectedClasses: (v: string[]) => void
  /** the picked islands, e.g. ["Island 7"]. Empty is no island filter (JOS-124). */
  islands: string[]
  setIslands: (v: string[]) => void
  /** the picked bosses, by the catalog's own spelling of the name. Empty is no boss filter. */
  bosses: string[]
  setBosses: (v: string[]) => void
  /** what the two facet pickers can offer, derived from the quests on the tab */
  facets: FacetOptions
  query: string
  setQuery: (v: string) => void
  sort: SortKey
  setSort: (v: SortKey) => void
  hideCompleted: boolean
  setHideCompleted: (v: boolean) => void
  /** "Hide quests I have turned in" — has-EVER-turned-in, the other reading (JOS-145). Stored. */
  hideTurnedIn: boolean
  setHideTurnedIn: (v: boolean) => void
  /**
   * "Only quests I have never turned in", the Ready tab's own toggle (JOS-155). Stored, and TICKED
   * on a fresh install: the default walk-the-islands list is first-time turn-ins.
   */
  readyFirstTimeOnly: boolean
  setReadyFirstTimeOnly: (v: boolean) => void
  /** how many ready quests that toggle is currently holding back, so the tab can say so */
  readyRefarmCount: number
  hideNoItems: boolean
  setHideNoItems: (v: boolean) => void
  favoritesOnly: boolean
  setFavoritesOnly: (v: boolean) => void
  /**
   * How many rows the list may draw. `Infinity` when `showAll` is on — see `usePaging`, which also
   * states why this no longer restarts at a page whenever the data underneath changes (JOS-191).
   */
  visibleCount: number
  showMore: () => void
  /** "Show all quests at once", stored under `eq.posky.showAll`. Off on a fresh install. */
  showAll: boolean
  setShowAll: (v: boolean) => void
  isFavorite: (name: string) => boolean
  toggleFavorite: (name: string) => void
  questFavorites: QuestFlagSet
  questIgnored: QuestFlagSet
  /**
   * "Show me THIS quest" — the deep link's half of the per-quest anchor
   * (docs/plans/celebration-toasts.md T6): switch to the Quests tab and clear every filter that
   * could be hiding it, then let PoskyView expand and scroll to it.
   *
   * It has to reset the filters, not merely search: the quest a celebration toast links to has
   * just been handed in, and "hide completed", "hide turned in", a class filter, an island/boss
   * facet or "favorites only" would each leave the user staring at a list the link promised
   * something in. JOS-145's box is the sharpest case of it — the toast fires ON the turn-in that
   * makes the quest match, so the link would hide its own subject every single time — which is
   * why the reset is a list of every filter and not a judgement about which ones matter.
   * The search box is set to the quest's name so the reset is visible and undoable rather than
   * mysterious. The Ready tab's own toggle is deliberately NOT in the reset: it narrows a list
   * this link is navigating away from, so it can never be what hid the quest.
   */
  revealQuest: (name: string) => void
  /**
   * "Show me THIS class's quests" — the Classes tab's drill-down (JOS-157): switch to the Quests
   * tab with the class filter set to exactly this one class, replacing whatever was picked before.
   *
   * THE ASYMMETRY WITH `revealQuest` DIRECTLY ABOVE IS DELIBERATE, and it is the whole reason these
   * are two functions rather than one with a flag. That path CLEARS every filter because a deep
   * link promises one named quest and any filter could be the thing hiding it. This path SETS one
   * on purpose: the user clicked a class, so the class filter is the answer they asked for, not an
   * obstacle. Everything else they had set up — the search box, the island and boss facets, the
   * hide-boxes, favorites-only — is left exactly as it was, because none of it was part of the ask
   * and a drill-down that quietly reset a user's working filters would be spending their state to
   * pay for a click. Replacing rather than appending the class is the same reasoning: a row is one
   * class, so the filter after the click reads as that one class and nothing else.
   *
   * It writes the SAME stored state the class chip on QuestFilterBar writes (`setSelectedClasses`,
   * persisted under `eq.selectedClasses`), so the chip shows the pick, removing the chip undoes it,
   * and the choice survives a restart — arriving here is indistinguishable from having picked the
   * class by hand, which is what makes it undoable without a back button.
   */
  showClassQuests: (className: string) => void
}

/**
 * THE TWO WAYS INTO THE QUESTS TAB, written side by side so the asymmetry between them is one
 * screen rather than two. The long arguments are on `QuestListState` above; the short version is
 * that `revealQuest` CLEARS every filter (a deep link promises one named quest, so any filter is a
 * suspect) and `showClassQuests` SETS one (a click on a class row IS a filter request, and nothing
 * else the user set up was part of the ask).
 *
 * A plain function taking the setters rather than a hook: it holds no state of its own, and lifting
 * it out of `useQuestList` keeps that hook under the measured per-function ceiling while putting
 * the two navigations in the one place a reader can compare them.
 */
function questNavigation(set: {
  setTab: (t: TabKey) => void
  setQuery: (v: string) => void
  setSelectedClasses: (v: string[]) => void
  setIslands: (v: string[]) => void
  setBosses: (v: string[]) => void
  setHideCompleted: (v: boolean) => void
  setHideTurnedIn: (v: boolean) => void
  setHideNoItems: (v: boolean) => void
  setFavoritesOnly: (v: boolean) => void
  resetPaging: () => void
}): Pick<QuestListState, 'revealQuest' | 'showClassQuests'> {
  return {
    revealQuest: (name: string) => {
      set.setTab('quests')
      set.setQuery(name)
      set.setSelectedClasses([])
      set.setIslands([])
      set.setBosses([])
      set.setHideCompleted(false)
      set.setHideTurnedIn(false)
      set.setHideNoItems(false)
      set.setFavoritesOnly(false)
      set.resetPaging()
    },
    showClassQuests: (className: string) => {
      set.setTab('quests')
      // REPLACES the selection rather than adding to it, and touches nothing else. The paging cap
      // resets for the same reason `revealQuest` resets it: the filtered set just changed, so the
      // user should be looking at the top of the new list rather than however far down the old one
      // they had paged.
      set.setSelectedClasses([className])
      set.resetPaging()
    }
  }
}

export function useQuestList(quests: QuestProgress[]): QuestListState {
  const { favorites, isFavorite, toggle: toggleFavorite } = useFavorites()
  // Quest-level flags (renderer-local localStorage, keyed by the canonical `Class::Name`
  // quest key) — the star the user could not find, and a permanent ignore.
  const questFavorites = useQuestFavorites()
  const questIgnored = useQuestIgnored()
  const [tab, setTab] = useState<TabKey>('quests')
  const [selectedClasses, setSelectedClasses] = useStoredNames(SELECTED_CLASSES_KEY)
  const [islands, setIslands] = useStoredNames(ISLANDS_KEY)
  const [bosses, setBosses] = useStoredNames(BOSSES_KEY)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useStoredSort()
  const [hideCompleted, setHideCompleted] = useStoredFlag(HIDE_COMPLETED_KEY)
  const [hideTurnedIn, setHideTurnedIn] = useStoredFlag(HIDE_TURNED_IN_KEY)
  const [hideNoItems, setHideNoItems] = useState(true)
  const [favoritesOnly, setFavoritesOnly] = useState(false)

  const [visible, ignored, allReady] = useVisibleQuests(quests, questIgnored.keys)
  // The Ready tab, whole: its list after its own toggle, the toggle, and what the toggle is
  // holding back. The tab's COUNT reads the same array the pane draws, so the number on the tab
  // and the rows under it can never disagree.
  const readySet = useReadySet(allReady)
  // The Targets tab, whole (issue #30). Same shape as the Ready line above, down to the spread:
  // the derivation is a pure module, the hook owns the tab's one toggle, and the tab count reads
  // the array the pane draws.
  const targetSet = useTargetsModel(visible)

  // What the two facet pickers can offer. Derived from the VISIBLE quests, so an ignored quest
  // takes its island and its boss out of the pickers along with itself.
  const facets = useMemo(() => facetOptions(visible), [visible])

  // Typing echoes immediately; the (accordion-rebuilding) filter consumes a deferred
  // copy so a keystroke never blocks on re-rendering dozens of Accordions (Task #41).
  const deferredQuery = useDeferredValue(query)

  const filtered = useMemo(
    () =>
      selectQuests({
        quests: visible,
        selectedClasses,
        islands,
        bosses,
        query: deferredQuery,
        sort,
        hideCompleted,
        hideTurnedIn,
        hideNoItems,
        favoritesOnly,
        isFavorite,
        isQuestFavorite: (questKey) => questFavorites.has(questKey)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      visible,
      selectedClasses,
      islands,
      bosses,
      deferredQuery,
      sort,
      hideCompleted,
      hideTurnedIn,
      hideNoItems,
      favoritesOnly,
      favorites,
      questFavorites.keys
    ]
  )

  // The page cap. Its reset key is the SELECTION — every control that decides which rows belong in
  // the list — and deliberately NOT the filtered array, which changes identity whenever a drop
  // lands or a star is clicked (usePaging states the defect that was, JOS-191).
  const { visibleCount, showMore, showAll, setShowAll, reset: resetPaging } = usePaging(
    JSON.stringify([
      selectedClasses, islands, bosses, deferredQuery, sort,
      hideCompleted, hideTurnedIn, hideNoItems, favoritesOnly
    ])
  )

  return {
    tab,
    setTab,
    visible,
    ignored,
    // `ready`, the toggle and its setter, and the held-back count, all from the one hook above.
    ...readySet,
    // `targets` and its own toggle, setter and held-back count — the same deal, one tab over.
    ...targetSet,
    filtered,
    selectedClasses,
    setSelectedClasses,
    islands,
    setIslands,
    bosses,
    setBosses,
    facets,
    query,
    setQuery,
    sort,
    setSort,
    hideCompleted,
    setHideCompleted,
    hideTurnedIn,
    setHideTurnedIn,
    hideNoItems,
    setHideNoItems,
    favoritesOnly,
    setFavoritesOnly,
    visibleCount,
    showMore,
    showAll,
    setShowAll,
    isFavorite,
    toggleFavorite,
    questFavorites,
    questIgnored,
    // Both navigations, from the one function above that states how they differ.
    ...questNavigation({
      setTab, setQuery, setSelectedClasses, setIslands, setBosses,
      setHideCompleted, setHideTurnedIn, setHideNoItems, setFavoritesOnly, resetPaging
    })
  }
}
