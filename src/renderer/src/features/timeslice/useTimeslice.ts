// useTimeslice — THE PICK, shared by every surface that has a slice control (JOS-130).
//
// The definitions are pure and live in `shared/timeslice.ts`; this file is the two things a
// renderer has to add to them: a subscription to the `progression` snapshot the slice is resolved
// against, and the ONE place the user's choice is kept.
//
// WHY THE CHOICE IS APP-WIDE AND NOT PER TAB. The ticket is "one control everywhere", and a
// control that reads `Session` on the Loot tab while the Leveling tab quietly still reads `All`
// is two controls wearing one design. A reader who narrows to this session and then goes looking
// for the xp rate behind those drops is asking ONE question; the answer follows them.
//
// IT IS SESSION-LIFETIME AND UNPERSISTED, exactly like the timescale it absorbs (JOS-71) and the
// chart's range selection: a slice is a thing you choose while you are looking, not a preference.
// A store key would mean a user who once looked at one zone comes back tomorrow to a ledger that is
// quietly hiding most of their loot.
//
// THE PICK IS GLOBAL; THE UNCHOSEN OPENING IS NOT (JOS-288). `All` was the opening on every surface
// (owner direction 2026-08-09) until the owner ruled that the exp surfaces open on `Zone + Session`
// — the camp you are standing in, this session — while the LOOT LEDGER'S opening is untouched and
// stays `All` (its own owner direction: the ledger comes up hiding nothing). Those two are not in
// conflict, because "the choice is app-wide" is a statement about a CHOICE and nobody has made one
// yet at startup. So `pickedId` starts as null and each surface declares the id it opens on; the
// FIRST press anywhere writes the shared pick, and from that instant the answer follows the reader
// between tabs exactly as it always has — which is the property the header above is about. A reader
// who never touches the control sees each surface's own honest opening, which is what they saw
// before this existed on both of them.
//
// THE ZONE MEMBERSHIP IS APPLIED HERE AND NO LONGER KEPT HERE (JOS-291, moved by JOS-332). It is
// the same KIND of thing as the pick — a dimension of "which stretch of play am I looking at" — so
// it is app-wide (a reader who narrows to this tier and then looks at what dropped there is asking
// ONE question, and the answer follows them) and session-lifetime (a membership is a thing you
// choose while you are looking, not a preference). What changed is HOW FAR "app-wide" reaches: it
// used to be a module variable in this file, which meant the XP overlay — a separate renderer
// process — kept its own second copy, and the owner read `elapsed 27m` off this tab with *this
// tier* showing in a window that had never told this one. So the value moved to MAIN, which is the
// only process that can reach every window, and this file now reads it through `useScopeSelection`
// like every other surface does. `shared/scopeSelection.ts` carries the whole argument and the
// measurement behind it; the OPENING is `exactTier` (owner ruling), not the model's `allTiers`.
//
// THE SESSION SPLIT IS APP-WIDE FOR THE SAME REASON, AND SINCE JOS-322 IT LIVES IN MAIN. "Start a
// new session now" is a MARK — one instant — and the segments are the half-open intervals between
// the marks (`shared/sessionSegments.ts` carries the Details! research and the denominator
// argument). The marks used to be a module variable in THIS file, beside the pick, and the reasons
// they belonged app-wide are unchanged: a reader who splits their evening on the Loot tab and then
// asks the Leveling tab how that stretch paid is asking ONE question, and a mark describes what you
// are looking at right now, so it is session-lifetime.
//
// WHAT CHANGED IS HOW FAR "APP-WIDE" REACHES, and it is the JOS-332 move made a second time for a
// second reason. A module variable is per RENDERER PROCESS, so the zone meter overlay would have
// kept its own list; and the owner ruled that ONE CLICK SPLITS EVERYTHING — the loot ledger AND the
// combat engine's own records — which is a split only MAIN can make, because the engine is there.
// So main stamps the instant ONCE, hands that very number to `combat.sessionMark(ts)`, and fans the
// list out; `useSessionMarks` is this window's cache of it and `newSession` below is a write
// through. That is also why the clock read is no longer in this file: the user's "now" is still the
// click, but the click's instant is now stamped where both halves of the split can share it.
//
// The store below is a five-line external store rather than a context: every consumer is a leaf,
// the value is two scalars, and `useSyncExternalStore` over a VERSION counter is the whole thing (a
// getSnapshot returning a fresh object would re-render forever).

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ProgressionDelta, ProgressionSnap } from '@shared/types'
import {
  availableSlices,
  resolveSlice,
  resolveSliceId,
  type SliceId,
  type SliceRange,
  type Timeslice
} from '@shared/timeslice'
import {
  currentSegment,
  segmentAt,
  sessionSegments,
  type SessionSegment
} from '@shared/sessionSegments'
import type { ZoneScope } from '@shared/zoneScope'
import { useModule } from '../../lib/useModule'
import { EMPTY_PROGRESSION, applyProgressionDelta } from '../leveling/progressionDelta'
import { dataBounds, type DataBounds } from '../leveling/zoneBands'
import { resetScopeSelection, useScopeSelection } from './useScopeSelection'
import { resetSessionMarks, useSessionMarks } from './useSessionMarks'

/** NULL means nobody has pressed the control yet — each surface then opens on its own
 *  `initialId`. See the header for why that is not a second control. */
let pickedId: SliceId | null = null
let pickedCustom: SliceRange | null = null
/** WHICH segment the custom range currently IS, or null when the pair was typed by hand. It is the
 *  ordinal rather than a copy of the range, so a later mark re-derives the pick instead of leaving
 *  a stale open end overlapping the new session. */
let pickedSegment: number | null = null
let version = 0
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function getVersion(): number {
  return version
}

function emit(): void {
  version++
  for (const cb of [...listeners]) cb()
}

/** Reset to the default. Exported for tests and for a character rebuild that wants a clean slate;
 *  nothing in the app calls it today, and a slice surviving a character switch is fine because
 *  `resolveSliceId` degrades a pick the new record cannot define.
 *
 *  IT STILL CLEARS EVERY DIMENSION OF THE PICK, including the membership — which now lives one file
 *  over, so this delegates rather than assigns. A reset that left a membership behind for the next
 *  test is the bug this line has always been about; the value moving to main did not retire it. */
export function resetTimeslice(): void {
  pickedId = null
  pickedCustom = null
  pickedSegment = null
  resetScopeSelection()
  // AND THE SPLIT (JOS-436): a mark is an instant in ONE character's record, so carrying it into a
  // rebuilt one would draw a picker of segments whose boundaries mean nothing there. It delegates
  // now, like the membership above it — the list moved to main (JOS-322) and this clears the
  // WINDOW'S CACHE of it, never main's own, which a reset must not be able to reach.
  resetSessionMarks()
  emit()
}

/**
 * Put a segment in force: its range becomes the custom pick, its ordinal is remembered so the
 * caption and the picker agree with it, and `custom` becomes the slice.
 *
 * A MODULE FUNCTION, not a hook-local one: it writes only module state, and defining it inside the
 * hook would make it a dependency of the two callbacks that call it — a re-created identity on
 * every render, for a function that closes over nothing from the render.
 */
function selectSegment(seg: SessionSegment): void {
  pickedCustom = seg.range
  pickedSegment = seg.n
  pickedId = 'custom'
  emit()
}

export interface TimesliceState {
  /** The snapshot the slice was resolved against — handed back so a consumer that also needs
   *  `rangeStats` does not subscribe to the same module twice. */
  prog: ProgressionSnap
  /** Where the record starts and ends, or null when nothing carries a timestamp. */
  bounds: DataBounds | null
  /** The ids this record can offer, in render order (`shared/timeslice.availableSlices`). */
  available: SliceId[]
  /** The resolved slice — range, zone filter and wording. The whole object travels together. */
  slice: Timeslice
  /** The pick AFTER `resolveSliceId`, which is what the control must render as selected. */
  id: SliceId
  setId: (id: SliceId) => void
  custom: SliceRange | null
  setCustom: (range: SliceRange | null) => void
  /** THE SESSION SPLIT (JOS-436), oldest first. One segment when nobody has pressed the button —
   *  the whole record, still running — so a surface can draw the picker exactly when there is a
   *  choice in it. */
  segments: SessionSegment[]
  /** The ordinal of the segment in force, or null when the slice is not a segment at all (any
   *  preset, or a hand-typed custom pair). What the picker renders as selected. */
  segmentIndex: number | null
  /** Close what is running AT THE WALL CLOCK and open a fresh segment from there, then select it —
   *  the Details! reset, in one click. The old segment keeps both its ends and stays in the picker. */
  newSession: () => void
  /** Browse a segment. A PICK, never a mutation (Details! rule 4): the current segment keeps
   *  accruing behind whatever you are reading. */
  pickSegment: (n: number) => void
}

/**
 * WHICH TIERS of the current zone the slice admits (JOS-291), and the setter for it.
 *
 * Its OWN hook, exactly like `useRateBasis` is its own beside this file: the control that renders
 * it (`ZoneScopeBar`) is a leaf that needs the membership and nothing else, and making it a member
 * of `TimesliceState` would mean every surface hauling two more props through its layout to reach
 * one button.
 *
 * SINCE JOS-332 IT IS A NAMED VIEW OF THE APP-WIDE SCOPE SELECTION rather than a store of its own.
 * `useTimeslice` reads the SAME hook to resolve the slice, so a reader can never see a membership
 * the numbers did not use — and now neither can they see one the XP overlay did not use, because
 * both windows read the value main holds.
 */
export function useZoneScope(): { zoneScope: ZoneScope; setZoneScope: (next: ZoneScope) => void } {
  const { zoneScope, setZoneScope } = useScopeSelection(window.eq)
  return { zoneScope, setZoneScope }
}

const NO_EXTRA: readonly number[] = []

/**
 * The slice in force on this surface.
 *
 * `extraTs` widens the record's bounds with series the progression snapshot does not carry — the
 * Leveling tab's level dings and AA gains. Pass a MEMOIZED array; it is a dependency.
 *
 * `initialId` is what THIS surface opens on before anyone has pressed the control (see the header).
 * It defaults to `all`, so a caller that says nothing gets the behaviour every caller had.
 */
export function useTimeslice(extraTs: readonly number[] = NO_EXTRA, initialId: SliceId = 'all'): TimesliceState {
  const prog = useModule<ProgressionSnap, ProgressionDelta>('progression', applyProgressionDelta) ?? EMPTY_PROGRESSION
  useSyncExternalStore(subscribe, getVersion, getVersion)
  // THE MEMBERSHIP IS READ, NEVER KEPT (JOS-332). One value per app, held in main, so the tab and
  // the floating window cannot be on different tiers while both say `this tier`.
  const { zoneScope } = useScopeSelection(window.eq)
  // …AND THE MARKS THE SAME WAY SINCE JOS-322, for the same reason plus one: the click has to reach
  // the combat engine, which is in main. One instant, stamped there, split everywhere.
  const { marks, press } = useSessionMarks(window.eq)

  const bounds = useMemo(() => dataBounds(prog, extraTs), [prog, extraTs])
  const available = useMemo(() => availableSlices(prog, bounds), [prog, bounds])
  // A pick the record can no longer define degrades to `all` rather than to a window the log
  // cannot fill — the `resolveTimescale` rule this absorbs, over a wider id space. The surface's
  // own opening goes through the very same degrade, so a log with no logout in it cannot open the
  // Leveling tab on a `Zone + Session` this record could not define.
  const id = resolveSliceId(pickedId ?? initialId, prog, bounds)
  const custom = pickedCustom
  // The split is derived from the marks on every read (JOS-436), never stored: that is what makes
  // "the segment I am browsing" and "the segment that is accruing" the same list. Not memoized —
  // it is a map over at most `MAX_SESSION_MARKS + 1` entries, and the store it reads is a module
  // variable, which is not a dependency a hook may be keyed on.
  const segments = sessionSegments(marks)
  // A segment names the slice it resolves to — `session 2` rather than `the custom range` — and
  // only while the custom slice is actually the one in force.
  const segmentIndex = id === 'custom' ? pickedSegment : null
  const customCaption = segments.find((s) => s.n === segmentIndex)?.caption ?? null
  const slice = useMemo(
    () => resolveSlice({ snap: prog, bounds, id, custom, customCaption, zoneScope }),
    [prog, bounds, id, custom, customCaption, zoneScope]
  )

  const setId = useCallback((next: SliceId) => {
    pickedId = next
    emit()
  }, [])
  const setCustom = useCallback((range: SliceRange | null) => {
    pickedCustom = range
    // A HAND-TYPED PAIR IS NOT A SEGMENT ANY MORE (JOS-436). Editing either instant of a segment's
    // range makes it the user's own range, so it stops carrying the segment's name and the picker
    // stops claiming that segment is what you are reading.
    pickedSegment = null
    // Choosing a range IS choosing the custom slice — a control that made you press two buttons
    // to see what you just typed would be stating the pick twice.
    if (range) pickedId = 'custom'
    emit()
  }, [])

  const newSession = useCallback(() => {
    // MAIN STAMPS THE INSTANT (see the header): the user's "now" is still the click, but it is
    // stamped where the loot split and the engine split can share one number. Marking at the live
    // edge of the log instead would hand the stale minutes since the last line — the zoning, the
    // corpse run, the instance reset itself — to the session that had not started yet.
    //
    // The SELECTION waits for the answer rather than guessing: the segment this opens begins at an
    // instant this window does not know until main says so, and selecting a guessed range would
    // leave the picker reading a boundary the numbers were never measured over.
    void press().then((next) => {
      selectSegment(currentSegment(next))
    }, () => undefined)
  }, [press])
  const pickSegment = useCallback(
    (n: number) => {
      const seg = segmentAt(marks, n)
      if (seg) selectSegment(seg)
    },
    [marks]
  )

  return {
    prog, bounds, available, slice, id, setId, custom, setCustom,
    segments, segmentIndex, newSession, pickSegment
  }
}
