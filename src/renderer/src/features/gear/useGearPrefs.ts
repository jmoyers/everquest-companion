// gear/useGearPrefs.ts — the two view preferences the Gear tab remembers (JOS-297).
//
// THE STORAGE TIER IS `localStorage`, and the argument is `usePlans.ts`'s two tiers: which columns
// you like to read and which controls you keep on screen are facts about THIS MACHINE's window,
// with no meaning on another one and nothing to validate in main. So they sit under the
// `eq.<feature>.*` idiom and never cross IPC. (The argument arrived here from `useGearSets.ts`,
// which kept `eq.gear.set` / `eq.gear.setsOpen` on the same tier until JOS-325 retired the sets.)
//
// AND THEY ARE PREFERENCES PRECISELY BECAUSE A VIEW UNMOUNTS ON EVERY TAB SWITCH (JOS-90/97/116,
// the same bug three times). A column set held in `useState` would survive exactly until the user
// looked at the Loot tab. The two traps that law names are both avoided here: nothing resets from
// an effect (every write is on the change handler), and every read goes through `gearPrefs.ts`'s
// sanitizers, so a stored value from another build DEGRADES to the derived default instead of
// throwing inside a render.
//
// `null` IS A VALUE HERE, NOT A FAILURE — it is "no choice stored", which is what makes the
// derived column seed and the full toolbar the answer. Clearing a choice therefore REMOVES the
// key rather than writing `[]`, because `[]` is a different statement (gearPrefs.ts's header).

import { useCallback, useState } from 'react'
import type { GearSortKey } from './gearFilter'
import {
  GEAR_CONTROLS,
  sanitizeColumns,
  sanitizeControls,
  sanitizeDropCols,
  sanitizeWidths,
  type GearColumnWidths,
  type GearControl
} from './gearPrefs'

const COLUMNS_KEY = 'eq.gear.columns'
const CONTROLS_KEY = 'eq.gear.controls'
const WIDTHS_KEY = 'eq.gear.widths'
const DROPS_KEY = 'eq.gear.dropcols'

/**
 * One stored preference as parsed JSON, or `null` for anything unusable — absent, empty, truncated,
 * or a storage a private-mode window refuses to hand over. The sanitizer above this decides what
 * the parsed value MEANS; this only decides that reading it can never throw.
 */
function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw === null || raw === '' ? null : JSON.parse(raw)
  } catch {
    return null
  }
}

/** Write a choice, or remove the key when there is none. Quota/permission failures are ignored. */
function writeJson(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // A preference that cannot be persisted still applies to this session.
  }
}

export interface GearPrefs {
  /** the chosen numeric columns, or `null` to derive them from the filters and the sort */
  columns: GearSortKey[] | null
  setColumns: (next: GearSortKey[] | null) => void
  /** the visible filter controls, or `null` for the whole toolbar */
  controls: GearControl[] | null
  setControls: (next: GearControl[] | null) => void
  /** the dragged column widths (user ask, 2026-08-15), or `null` for the automatic layout */
  widths: GearColumnWidths | null
  setWidths: (next: GearColumnWidths | null) => void
  /** the Zone / Level / Mob columns (user ask, 2026-08-15) — on unless switched off */
  dropCols: boolean
  setDropCols: (next: boolean) => void
}

export function useGearPrefs(): GearPrefs {
  const [columns, setColumnsState] = useState<GearSortKey[] | null>(() => sanitizeColumns(readJson(COLUMNS_KEY)))
  const [controls, setControlsState] = useState<GearControl[] | null>(() => sanitizeControls(readJson(CONTROLS_KEY)))
  const [widths, setWidthsState] = useState<GearColumnWidths | null>(() => sanitizeWidths(readJson(WIDTHS_KEY)))
  const [dropCols, setDropColsState] = useState<boolean>(() => sanitizeDropCols(readJson(DROPS_KEY)))

  const setColumns = useCallback((next: GearSortKey[] | null) => {
    setColumnsState(next)
    writeJson(COLUMNS_KEY, next)
  }, [])

  // Written on every drag tick — a tiny object, and localStorage is synchronous and sub-millisecond,
  // so "the width you see is the width that is stored" holds without a debounce to flush.
  const setWidths = useCallback((next: GearColumnWidths | null) => {
    setWidthsState(next)
    writeJson(WIDTHS_KEY, next)
  }, [])

  /**
   * THE CONTROLS CHOICE IS WRITTEN WITH THE VOCABULARY IT WAS MADE FROM (2026-08-13, the owner's
   * "all filter controls enabled by default" ruling — `gearPrefs.LEGACY_GEAR_CONTROLS` carries the
   * whole argument).
   *
   * Storing only the SHOWN list made the value a closed statement about the controls that existed
   * when it was saved, so every control added afterwards read as one the user had hidden — which is
   * how the Weapon type picker went missing for everybody who had used this picker before JOS-302
   * added it. Recording `vocab` is what lets the reader tell "they hid this" from "they were never
   * asked", and writing it HERE is what heals a legacy key: one touch of the picker upgrades it.
   *
   * `next === null` still REMOVES the key, because no-choice and an empty choice are different
   * statements (the header, and gearPrefs.ts's absent-is-not-empty law).
   */
  const setControls = useCallback((next: GearControl[] | null) => {
    setControlsState(next)
    writeJson(CONTROLS_KEY, next === null ? null : { shown: next, vocab: [...GEAR_CONTROLS] })
  }, [])

  // ON is the default, so the key only needs to exist while the answer is the non-default one.
  const setDropCols = useCallback((next: boolean) => {
    setDropColsState(next)
    writeJson(DROPS_KEY, next ? null : false)
  }, [])

  return { columns, setColumns, controls, setControls, widths, setWidths, dropCols, setDropCols }
}
