// readyClasses — the Ready tab's own class pick (owner, 2026-10-11): "my class, or whatever class
// I chose", kept in localStorage so it survives the tab and the session. Deliberately separate
// from the Quests tab's class filter: the Ready tab reads no Quests-tab filter (JOS-147), and a
// pick made to walk the islands should not narrow the research list, nor the other way round.
// No pick means every class, as the tab has always shown.

import { useCallback, useState } from 'react'

const KEY = 'eq.posky.readyClasses'

function load(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function useReadyClasses(): [string[], (v: string[]) => void] {
  const [value, setValue] = useState<string[]>(load)
  const set = useCallback((v: string[]) => {
    setValue(v)
    try {
      localStorage.setItem(KEY, JSON.stringify(v))
    } catch {
      // Storage can be unavailable; the pick still holds for this session.
    }
  }, [])
  return [value, set]
}

/** The ready quests of the picked classes; every quest when nothing is picked. */
export function filterReadyByClass<T extends { className: string }>(quests: readonly T[], picked: readonly string[]): T[] {
  return picked.length ? quests.filter((q) => picked.includes(q.className)) : [...quests]
}
