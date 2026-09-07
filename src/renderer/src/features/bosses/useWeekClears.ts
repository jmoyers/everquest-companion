// useWeekClears — the manual base-rung clear as ONE module-scope store the whole Bosses view reads
// (the useFavorites.ts / useQuestFlags.ts shape: one store, useSyncExternalStore hands out one
// snapshot, a toggle re-emits). The pure half — the stored shape, the one edit, and "is this mark
// still live this week" — is weekClears.ts + lockout.ts; this file is only the localStorage plumbing
// and the character switch.
//
// A DIFFERENT CHARACTER IS A DIFFERENT LOCKOUT. Lockouts are per character, so the storage key is
// namespaced by `<name>_<server>` and the store re-reads on window.eq.onCharacter — the
// useWishlist.ts `watch()` pattern, subscribed once for the life of the window. Until a character
// is known, `canToggle` is false: a write before then would land in the `unknown` bucket and be
// invisible once the real character arrives.
//
// COLD START. `window.eq.onCharacter` is a ONE-SHOT push per character resolution, and BossView is
// only conditionally mounted — so `watch()` can register its listener AFTER that push already
// fired and never learn the character (the whole-branch review's Critical 1). So `watch()`
// bootstraps with `window.eq.getCharacter()` first, then subscribes — the useProgress.ts precedent
// (`void window.eq.getCharacter().then(...)` then `window.eq.onCharacter(...)`). If a real push has
// already named a character by the time the bootstrap promise resolves, the push wins.

import { useMemo, useSyncExternalStore } from 'react'
import type { LockoutWindow } from './lockout'
import { manualClearIsLiveThisWeek } from './lockout'
import {
  nextWeekClearsOnToggle,
  parseWeekClears,
  serializeWeekClears,
  weekClearsStorageKey,
  type WeekClears
} from './weekClears'

export interface WeekClearsApi {
  /** the value to pass tierLadder as `manualBaseTs`: the mark, iff it is live for `w`. */
  liveBaseTs: (bossKey: string, w: LockoutWindow) => number | undefined
  /** false until a character is known — the affordance stays disabled. */
  canToggle: boolean
  /**
   * Flip this boss's d0 mark for lockout week `w`: clears a mark that is live this week, otherwise
   * stamps `Date.now()` (which also garbage-collects a stale mark from a previous week — see
   * weekClears.ts). No-op while `canToggle` is false.
   */
  toggle: (bossKey: string, w: LockoutWindow) => void
}

interface Snapshot {
  clears: WeekClears
  character: string | null
}

let snapshot: Snapshot = { clears: {}, character: null }
const listeners = new Set<() => void>()
let watching = false
/** Set once the first `onCharacter` push arrives — the bootstrap defers to it even when it
 *  cleared the character (a `null` push the `snapshot.character !== null` guard would miss). */
let sawPush = false

function read(character: string | null): WeekClears {
  try {
    return parseWeekClears(localStorage.getItem(weekClearsStorageKey(character)))
  } catch {
    return {}
  }
}

function emit(next: Snapshot): void {
  snapshot = next
  for (const l of [...listeners]) l()
}

function keyOf(c: { name: string; server: string } | null): string | null {
  return c ? `${c.name}_${c.server}` : null
}

function watch(): void {
  if (watching) return
  watching = true
  // Bootstrap for the cold start, then subscribe. A real onCharacter push always wins: if one has
  // already fired by the time this promise resolves, its answer stands (even a `null` clear) and
  // the possibly-stale bootstrap value is dropped.
  void window.eq.getCharacter().then((c) => {
    if (sawPush) return
    const character = keyOf(c)
    emit({ character, clears: read(character) })
  })
  window.eq.onCharacter((c) => {
    sawPush = true
    const character = keyOf(c)
    emit({ character, clears: read(character) })
  })
}

function subscribe(listener: () => void): () => void {
  watch()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): Snapshot {
  return snapshot
}

function write(next: WeekClears): void {
  try {
    localStorage.setItem(weekClearsStorageKey(snapshot.character), serializeWeekClears(next))
  } catch {
    /* a storage that won't take the write still updates the screen for this session */
  }
  emit({ ...snapshot, clears: next })
}

export function useWeekClears(): WeekClearsApi {
  const snap = useSyncExternalStore(subscribe, getSnapshot)
  return useMemo<WeekClearsApi>(
    () => ({
      canToggle: snap.character !== null,
      liveBaseTs: (bossKey, w) => {
        const ts = snap.clears[bossKey]
        return manualClearIsLiveThisWeek(ts, w) ? ts : undefined
      },
      toggle: (bossKey, w) => {
        // Read `snapshot.clears` FRESH, not the memoized `snap.clears` closure: two toggles in one
        // frame must fold over each other, and a character switch mid-frame must not be clobbered
        // (the whole-branch review's Important 3).
        if (snapshot.character === null) return
        write(nextWeekClearsOnToggle(snapshot.clears, bossKey, w, Date.now()))
      }
    }),
    [snap]
  )
}
