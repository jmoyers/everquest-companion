// useQuestList — everything the Quests tab REMEMBERS and DERIVES, in one hook.
//
// PoskyView is a container: it owns the confetti burst, the inventory-reload toast, and the
// layout. The list state — which tab, which classes/island, the search box, sort + direction,
// list toggles, and page cap — plus the filter/sort derivation it feeds all live here, so
// the view can stay a view. The state deliberately lives ABOVE the tab switch (in the hook the
// container calls, not inside the Quests tab's markup) so flipping to Ignored and back does not
// reset the filters you had set up.
//
// Four of those choices outlive the hook entirely, in localStorage: the class filter, the sort
// key + direction, and "hide completed" (JOS-90 — see loadHideCompleted). Living above the
// Quests/Ignored switch was never enough for them, because leaving the Sky tab for another VIEW
// unmounts this hook outright. The island filter remains session-only: it is a temporary slice of
// the current run, not a statement about the player's overall Sky progression.

import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { QuestProgress } from './useProgress'
import { useFavorites } from '../favorites/useFavorites'
import { useQuestFavorites, useQuestIgnored, type QuestFlagSet } from '../favorites/useQuestFlags'
import {
  DEFAULT_SORT,
  defaultSortDirection,
  isSortDirection,
  isSortKey,
  questIslands,
  sortQuests,
  type SortDirection,
  type SortKey
} from './questSort'

export type { SortDirection, SortKey }

export type TabKey = 'quests' | 'ignored'

// How many Accordions to render before the "show more" cap kicks in.
const PAGE = 40

const SELECTED_CLASSES_KEY = 'eq.selectedClasses'
const SORT_KEY = 'eq.questSort'
const SORT_DIRECTION_KEY = 'eq.questSortDirection'
const HIDE_COMPLETED_KEY = 'eq.posky.hideCompleted'

function loadSelectedClasses(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SELECTED_CLASSES_KEY) ?? '[]')
    return Array.isArray(v) ? (v as string[]) : []
  } catch {
    return []
  }
}

interface QuestSortState {
  key: SortKey
  direction: SortDirection
}

// A retired order/direction falls back to that order's established direction, preserving the
// pre-toggle behavior for every existing install.
function loadSortState(): QuestSortState {
  const storedKey = localStorage.getItem(SORT_KEY)
  const key = isSortKey(storedKey) ? storedKey : DEFAULT_SORT
  const storedDirection = localStorage.getItem(SORT_DIRECTION_KEY)
  return {
    key,
    direction: isSortDirection(storedDirection) ? storedDirection : defaultSortDirection(key)
  }
}

/**
 * "Hide completed" is a PLACE IN THE GRIND, not a momentary filter (JOS-90). Hiding the quests
 * you have turned in is how a user says "show me what is left", and that answer is true until
 * they say otherwise — but the state lived in plain `useState`, and `App`'s `ViewContent` mounts
 * exactly ONE feature view at a time, so every trip to another tab unmounted the hook and handed
 * the list back with completed quests in it. It shares storage with the class and sort choices,
 * so it survives the tab switch AND the restart by the same mechanism.
 *
 * '1'/'0' is the one-bit view-pref idiom (features/combat/useCombatPrefs.ts). An ABSENT key is
 * the DEFAULT (false — a fresh install shows everything), never `false` itself: a user who has
 * never touched the box has not un-ticked it.
 *
 * NOT WHITELISTED for share bundles (shared/shareSchema.ts UI_PREF_SPECS), deliberately: a new
 * key is private by default, and where one player is in Sky is not a setting worth exporting.
 */
function loadHideCompleted(): boolean {
  return localStorage.getItem(HIDE_COMPLETED_KEY) === '1'
}

function questHasFavorite(q: QuestProgress, isFavorite: (name: string) => boolean): boolean {
  return q.items.some((it) => isFavorite(it.name))
}

interface QuestSelection {
  quests: QuestProgress[]
  selectedClasses: string[]
  query: string
  sort: SortKey
  sortDirection: SortDirection
  selectedIsland: number | null
  hideCompleted: boolean
  hideNoItems: boolean
  favoritesOnly: boolean
  isFavorite: (name: string) => boolean
  isQuestFavorite: (questKey: string) => boolean
}

/** Filter, then apply the selected sort as the authoritative order. */
function selectQuests(sel: QuestSelection): QuestProgress[] {
  const { isFavorite, isQuestFavorite } = sel
  const q = sel.query.trim().toLowerCase()
  const selectedIsland = sel.selectedIsland
  let list = sel.quests
  if (sel.selectedClasses.length) list = list.filter((x) => sel.selectedClasses.includes(x.className))
  if (selectedIsland !== null) list = list.filter((x) => questIslands(x).includes(selectedIsland))
  if (sel.hideCompleted) list = list.filter((x) => !x.completed)
  if (sel.hideNoItems) list = list.filter((x) => x.needCount > 0)
  // "Favorites only" = the quest itself is starred OR it needs a starred item.
  if (sel.favoritesOnly)
    list = list.filter((x) => isQuestFavorite(x.key) || questHasFavorite(x, isFavorite))
  if (q) {
    list = list.filter(
      (x) =>
        x.name.toLowerCase().includes(q) ||
        // `?? false` only so the expression is a boolean; a quest with no reward matched
        // nothing here before either.
        (x.reward?.toLowerCase().includes(q) ?? false) ||
        x.items.some((i) => i.name.toLowerCase().includes(q))
    )
  }
  return sortQuests(list, sel.sort, sel.sortDirection)
}

export interface QuestListState {
  tab: TabKey
  setTab: (t: TabKey) => void
  /** quests NOT ignored — the list, its filters and its counts all describe this set */
  visible: QuestProgress[]
  /** the ignored ones, class-then-name sorted, for the Ignored tab */
  ignored: QuestProgress[]
  /** `visible` after filters and the selected authoritative sort */
  filtered: QuestProgress[]
  selectedClasses: string[]
  setSelectedClasses: (v: string[]) => void
  query: string
  setQuery: (v: string) => void
  sort: SortKey
  setSort: (v: SortKey) => void
  sortDirection: SortDirection
  toggleSortDirection: () => void
  selectedIsland: number | null
  setSelectedIsland: (island: number | null) => void
  availableIslands: number[]
  hideCompleted: boolean
  setHideCompleted: (v: boolean) => void
  hideNoItems: boolean
  setHideNoItems: (v: boolean) => void
  favoritesOnly: boolean
  setFavoritesOnly: (v: boolean) => void
  /** Clear every control that narrows the quest list; sorting and flags are not filters. */
  resetFilters: () => void
  visibleCount: number
  showMore: () => void
  isFavorite: (name: string) => boolean
  toggleFavorite: (name: string) => void
  questFavorites: QuestFlagSet
  questIgnored: QuestFlagSet
  /**
   * "Show me THIS quest" — the deep link's half of the per-quest anchor
   * (docs/plans/celebration-toasts.md T6): switch to the Quests tab and clear every filter that
   * could be hiding it, then let PoskyView expand and scroll to it.
   *
   * It has to reset the filters, not merely search: a Sky quest completes by TURN-IN, so the
   * quest a celebration toast links to is by definition a completed one — and "hide completed",
   * a class filter or "favorites only" would each leave the user staring at a list the link
   * promised something in. The search box is set to the quest's name so the reset is visible and
   * undoable rather than mysterious.
   */
  revealQuest: (name: string) => void
}

function useQuestGroups(
  quests: QuestProgress[],
  ignoredKeys: Set<string>
): { visible: QuestProgress[]; ignored: QuestProgress[]; availableIslands: number[] } {
  const [visible, ignored] = useMemo(() => {
    const shown: QuestProgress[] = []
    const hidden: QuestProgress[] = []
    for (const q of quests) (ignoredKeys.has(q.key.toLowerCase()) ? hidden : shown).push(q)
    hidden.sort((a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name))
    return [shown, hidden]
  }, [quests, ignoredKeys])
  const availableIslands = useMemo(
    () => [...new Set(quests.flatMap((q) => questIslands(q)))].sort((a, b) => a - b),
    [quests]
  )
  return { visible, ignored, availableIslands }
}

function usePersistedQuestPreferences(
  selectedClasses: string[],
  sortState: QuestSortState,
  hideCompleted: boolean
): void {
  useEffect(() => {
    localStorage.setItem(SELECTED_CLASSES_KEY, JSON.stringify(selectedClasses))
  }, [selectedClasses])
  useEffect(() => {
    localStorage.setItem(SORT_KEY, sortState.key)
    localStorage.setItem(SORT_DIRECTION_KEY, sortState.direction)
  }, [sortState])
  useEffect(() => {
    localStorage.setItem(HIDE_COMPLETED_KEY, hideCompleted ? '1' : '0')
  }, [hideCompleted])
}

export function useQuestList(quests: QuestProgress[]): QuestListState {
  const { favorites, isFavorite, toggle: toggleFavorite } = useFavorites()
  // Quest-level flags (renderer-local localStorage, keyed by the canonical `Class::Name`
  // quest key) — the star the user could not find, and a permanent ignore.
  const questFavorites = useQuestFavorites()
  const questIgnored = useQuestIgnored()
  const [tab, setTab] = useState<TabKey>('quests')
  const [selectedClasses, setSelectedClasses] = useState<string[]>(loadSelectedClasses)
  const [query, setQuery] = useState('')
  const [sortState, setSortState] = useState<QuestSortState>(loadSortState)
  const [selectedIsland, setSelectedIsland] = useState<number | null>(null)
  const [hideCompleted, setHideCompleted] = useState(loadHideCompleted)
  const [hideNoItems, setHideNoItems] = useState(true)
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  // Accordions are variable-height so we cap+paginate rather than window them; a
  // keystroke never re-renders more than PAGE quests at once.
  const [visibleCount, setVisibleCount] = useState(PAGE)

  // Ignored quests are gone from the main list, its filters and its counts — they exist
  // only under the Ignored tab, where the same button un-ignores them.
  const ignoredKeys = questIgnored.keys
  const { visible, ignored, availableIslands } = useQuestGroups(quests, ignoredKeys)

  // Remember the class filter, sort order and completed visibility across restarts.
  usePersistedQuestPreferences(selectedClasses, sortState, hideCompleted)

  // Typing echoes immediately; the (accordion-rebuilding) filter consumes a deferred
  // copy so a keystroke never blocks on re-rendering dozens of Accordions (Task #41).
  const deferredQuery = useDeferredValue(query)

  const filtered = useMemo(
    () =>
      selectQuests({
        quests: visible,
        selectedClasses,
        query: deferredQuery,
        sort: sortState.key,
        sortDirection: sortState.direction,
        selectedIsland,
        hideCompleted,
        hideNoItems,
        favoritesOnly,
        isFavorite,
        isQuestFavorite: (questKey) => questFavorites.has(questKey)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      visible,
      selectedClasses,
      deferredQuery,
      sortState,
      selectedIsland,
      hideCompleted,
      hideNoItems,
      favoritesOnly,
      favorites,
      questFavorites.keys
    ]
  )

  // Reset the page cap whenever the filtered set changes (a new search shows from top).
  useEffect(() => {
    setVisibleCount(PAGE)
  }, [filtered])

  const resetFilters = (): void => {
    setQuery('')
    setSelectedClasses([])
    setSelectedIsland(null)
    setHideCompleted(false)
    setHideNoItems(false)
    setFavoritesOnly(false)
  }

  return {
    tab,
    setTab,
    visible,
    ignored,
    filtered,
    selectedClasses,
    setSelectedClasses,
    query,
    setQuery,
    sort: sortState.key,
    setSort: (key) => setSortState({ key, direction: defaultSortDirection(key) }),
    sortDirection: sortState.direction,
    toggleSortDirection: () => {
      setSortState((current) => ({
        ...current,
        direction: current.direction === 'asc' ? 'desc' : 'asc'
      }))
    },
    selectedIsland,
    setSelectedIsland,
    availableIslands,
    hideCompleted,
    setHideCompleted,
    hideNoItems,
    setHideNoItems,
    favoritesOnly,
    setFavoritesOnly,
    resetFilters,
    visibleCount,
    showMore: () => setVisibleCount((n) => n + PAGE),
    isFavorite,
    toggleFavorite,
    questFavorites,
    questIgnored,
    revealQuest: (name: string) => {
      setTab('quests')
      resetFilters()
      setQuery(name)
      setVisibleCount(PAGE)
    }
  }
}
