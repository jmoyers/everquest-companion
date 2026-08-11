import { useSyncExternalStore } from 'react'

// QUEST-LEVEL flags — favorite (star) and permanently ignored — as two small
// localStorage-backed sets, siblings of the ITEM-level `useFavorites` store and
// deliberately NOT overloading it: starring a quest and starring one of its drops are
// different intents, and conflating them is exactly the indirection that made quest
// favoriting undiscoverable.
//
// Renderer-local on purpose (same as `eq.favorites`): these never touch the main
// electron-store, so no persisted-store schema migration is involved.
//
// Entries are keyed by the app's canonical quest key (`questKey()` — `Class::Name`,
// the same key persisted completions use), lowercased here so a future casing drift in
// the bundled data can't silently orphan someone's stars. Never key by quest NAME
// alone: Sky quest names repeat across classes, so a name-keyed flag would star or
// hide every class's copy at once.

// JOS-148 added a THIRD key, at a different granularity: the CLASS star on the Sky tab's Classes
// tab. It gets its own key rather than reusing either of the two above, for the reason the header
// gives about items and quests — starring the Warrior class and starring Warrior Test of Think are
// different intents, and one key holding both would make a class star silently pin six quests.
// The store shape is identical (a set of lowercased keys in localStorage), so it is the same
// factory rather than a fourth copy of it.
const FAVORITES_KEY = 'eq.questFavorites'
const IGNORED_KEY = 'eq.questIgnored'
const CLASS_FAVORITES_KEY = 'eq.classFavorites'

export interface QuestFlagSet {
  /** Raw lowercased keys — stable identity, so it is a sound useMemo dependency. */
  keys: Set<string>
  has: (questKey: string) => boolean
  toggle: (questKey: string) => void
  /** How many quests carry the flag. */
  size: number
}

interface QuestFlagStore {
  subscribe: (listener: () => void) => () => void
  snapshot: () => Set<string>
  toggle: (questKey: string) => void
}

function load(storageKey: string): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
    const list: unknown[] = Array.isArray(raw) ? raw : []
    return new Set(list.map((s) => String(s).toLowerCase()))
  } catch {
    return new Set()
  }
}

function createQuestFlagStore(storageKey: string): QuestFlagStore {
  let current = load(storageKey)
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot() {
      return current
    },
    toggle(questKey) {
      const key = questKey.toLowerCase()
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      current = next
      localStorage.setItem(storageKey, JSON.stringify([...current]))
      for (const l of listeners) l()
    }
  }
}

const favoriteStore = createQuestFlagStore(FAVORITES_KEY)
const ignoredStore = createQuestFlagStore(IGNORED_KEY)
const classFavoriteStore = createQuestFlagStore(CLASS_FAVORITES_KEY)

function useQuestFlagSet(store: QuestFlagStore): QuestFlagSet {
  const keys = useSyncExternalStore(store.subscribe, store.snapshot)
  return {
    keys,
    has: (questKey: string) => keys.has(questKey.toLowerCase()),
    toggle: store.toggle,
    size: keys.size
  }
}

/** Quests the user starred outright (pins them to the top of the list). */
export function useQuestFavorites(): QuestFlagSet {
  return useQuestFlagSet(favoriteStore)
}

/** Quests the user hid permanently (excluded from the list, filters and counts). */
export function useQuestIgnored(): QuestFlagSet {
  return useQuestFlagSet(ignoredStore)
}

/**
 * CLASSES the user starred on the Sky tab's Classes tab (JOS-148) — pins them above the
 * closest-to-done order, which JOS-146's rule permits because that order's subject is a standing
 * property rather than an event (classUnlocks.orderClassUnlockRows argues it).
 *
 * Keyed by the class name as the bundled Sky data spells it, lowercased by the store like every
 * other flag here. There is no ignore twin: a class you do not care about is one row among
 * sixteen, and hiding it would take a class's tests out of a view whose whole subject is how many
 * tests are left.
 */
export function useClassFavorites(): QuestFlagSet {
  return useQuestFlagSet(classFavoriteStore)
}
