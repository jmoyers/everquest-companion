// lib/kept.ts — A ONE-SLOT MEMO THAT OUTLIVES THE COMPONENT (the lag sweep, owner ask 2026-10-11).
//
// `useMemo` forgets on unmount, and a view unmounts on every tab switch. The Gear tab's first
// paint therefore re-derived its whole table on every re-open — scale, filter and sort over
// 6,899 rows, 116 ms on the main thread — for a question whose answer had not changed since the
// last time the tab was open. A slot at MODULE scope holds the last answer and the key it answered;
// a render that asks with the same key takes the answer and pays a handful of `Object.is` calls.
//
// ONE SLOT, NOT A MAP. The question only ever has one current answer (the rows on screen), and a
// map would keep every past answer alive until the window closed — 6,899 scaled rows per slider
// position is exactly the sort of thing that must not accumulate.
//
// THE CALLER SPELLS THE KEY OUT, and the spelling is the contract: an IDENTITY where the input is
// held stable for the window (the index array `useGearIndex` caches), a PRIMITIVE where the input
// is rebuilt per mount (a form read back from storage is a fresh object every time, so its identity
// would miss on every re-open and the slot would be a no-op), and an input that the answer does not
// read at the moment (a predicate behind a toggle that is off) is left out, so the answer survives
// the input moving. Compared like React's own dependency list: same length, `Object.is` per entry.
//
// NOT A HOOK, on purpose. It is called during render like `useMemo` would be, but it has no
// per-instance state to hold, so it needs no hook rules and can be called from a plain function.

/** The slot: declare one per question at module scope, `{ last: null }`. */
export interface Kept<T> {
  last: { key: readonly unknown[]; value: T } | null
}

/** The slot's answer for `key`, computing and recording it when the key moved. */
export function kept<T>(slot: Kept<T>, key: readonly unknown[], compute: () => T): T {
  const last = slot.last
  if (last !== null && last.key.length === key.length && last.key.every((k, i) => Object.is(k, key[i]))) {
    return last.value
  }
  const value = compute()
  slot.last = { key, value }
  return value
}
