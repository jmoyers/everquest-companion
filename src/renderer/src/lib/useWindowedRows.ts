// useWindowedRows — a dependency-free fixed-row-height windowing hook.
//
// The app's dense lists (loot rows, spell rows, pack rows) are fixed-height dense
// rows — the ideal case for simple windowing: we only render the slice of rows that
// intersects the scroll viewport, plus a small overscan, and reserve the total
// height with two spacer elements (top + bottom). This keeps the rendered DOM node
// count bounded (≈ viewport / rowHeight) no matter how long the list is, so a filter
// keystroke never has to mount hundreds of MUI rows synchronously.
//
// Why hand-rolled (not react-window): the lists are uniform-height and this is ~1
// screen of code with zero deps — see AGENTS.md "search pattern" note. For
// variable-height surfaces (Accordions) we cap+paginate instead of windowing.
//
// Usage:
//   const scrollRef = useRef<HTMLDivElement>(null)
//   const win = useWindowedRows({ count: rows.length, rowHeight: 33, scrollRef })
//   return (
//     <div ref={scrollRef} style={{ overflow: 'auto', height: '100%' }}>
//       <div style={{ height: win.topPad }} />
//       {rows.slice(win.start, win.end).map(...)}
//       <div style={{ height: win.bottomPad }} />
//     </div>
//   )
// For a <table>, render the spacers as rows with a single full-colspan <td> whose
// height is set (see LootView) so the browser's table layout keeps the geometry.
//
// THE LISTENERS BIND TO THE ELEMENT, NEVER TO THE REF (JOS-260). A ref object is stable for the
// life of the component, so an effect keyed on it runs ONCE — and a caller whose container node
// is replaced (unmounted and remounted under the same ref, as the Loot ledger's detail takeover
// does) stranded the scroll listener and the ResizeObserver on the DETACHED node. The window then
// froze at whatever slice it held: about thirty rows, the rest of the ledger blank on scroll —
// the 0.23.0 report this hook was root-caused from. The container is therefore held in STATE, and
// a layout effect with no dependency array re-reads the ref after every commit and adopts the
// node when its identity changes (the `setEl` bails on `Object.is`, so a steady container costs
// one ref read per commit and no render). Every consumer whose container mounts and unmounts with
// the hook was already immune; this makes the whole class impossible rather than conventional.

import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react'

/**
 * What a container is assumed to be tall enough to show before it has ever been measured, in px.
 * A first paint happens before the ResizeObserver has said anything, and the old fallback was
 * `overscan` ROWS (eight) — barely a quarter of a screen, which is fine when the measurement
 * lands a frame later and a blank list when it never does. A screenful is the honest guess: it
 * over-renders by a few rows for one frame at worst.
 */
const UNMEASURED_VIEWPORT = 800

export interface WindowedRows {
  /** First row index to render (inclusive). */
  start: number
  /** One past the last row index to render (exclusive). */
  end: number
  /** Height (px) of the spacer BEFORE the rendered slice. */
  topPad: number
  /** Height (px) of the spacer AFTER the rendered slice. */
  bottomPad: number
  /** Total content height (px) — count * rowHeight. */
  totalHeight: number
  /** The container's scrollTop the slice was computed from, clamped non-negative — so a consumer
   *  can style a scrolled state (the gear header's shadow) without a second listener. */
  scrollTop: number
}

export interface UseWindowedRowsOptions {
  /** Number of rows in the (already-filtered) list. */
  count: number
  /** Fixed pixel height of one row. */
  rowHeight: number
  /** Ref to the scrolling container element. Nullable: the hook reads it after every commit and
   *  simply windows nothing while there is no container (see the header). */
  scrollRef: RefObject<HTMLElement | null>
  /** Extra rows rendered above/below the viewport to hide scroll seams. Default 8. */
  overscan?: number
}

/** The measured facts a slice is computed from — everything the hook learns from the DOM. */
export interface WindowedRowsInput {
  count: number
  rowHeight: number
  /** Current `scrollTop` of the container (px). */
  scrollTop: number
  /** Measured `clientHeight` of the container (px); 0 means "never measured". */
  viewport: number
  overscan: number
}

/**
 * THE SLICE, as pure arithmetic — exported so the clamps below are testable without a browser.
 *
 * Every index is clamped and the padding invariant is total:
 *   `topPad + (end - start) * rowHeight + bottomPad === totalHeight`
 * holds for every input, including an empty list, a garbage `scrollTop` far past the end of the
 * content, and a zero/negative `rowHeight` (which no caller passes, and which would otherwise
 * divide by zero and hand the table `NaN` heights).
 */
export function windowSlice({
  count,
  rowHeight,
  scrollTop,
  viewport,
  overscan
}: WindowedRowsInput): WindowedRows {
  const row = rowHeight > 0 ? rowHeight : 1
  const rows = Math.max(0, Math.floor(count))
  const totalHeight = rows * row
  // A never-measured viewport renders a SCREENFUL rather than a handful, so a container the
  // ResizeObserver has not reported on yet still shows a usable list (see UNMEASURED_VIEWPORT).
  const visibleCount = Math.max(1, Math.ceil((viewport > 0 ? viewport : UNMEASURED_VIEWPORT) / row))
  const maxStart = Math.max(0, rows - 1)
  const wanted = Math.floor(Math.max(0, scrollTop) / row) - overscan
  const start = Math.min(maxStart, Math.max(0, wanted))
  const end = Math.max(start, Math.min(rows, start + visibleCount + overscan * 2))

  return {
    start,
    end,
    topPad: start * row,
    bottomPad: Math.max(0, (rows - end) * row),
    totalHeight,
    scrollTop: Math.max(0, scrollTop)
  }
}

export function useWindowedRows({
  count,
  rowHeight,
  scrollRef,
  overscan = 8
}: UseWindowedRowsOptions): WindowedRows {
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  // THE CONTAINER ITSELF, held in state — see the header. `scrollRef.current` is read after every
  // commit and adopted only when the NODE changes, so the effects below re-bind to a replaced
  // container instead of stranding on the detached one.
  const [el, setEl] = useState<HTMLElement | null>(null)
  // NO DEPENDENCY ARRAY, and that is the fix rather than an oversight: the array the lint rule
  // wants here — `[scrollRef]` — is exactly the stale binding this hook was root-caused for. A ref
  // OBJECT never changes, so an effect keyed on it runs once and can never notice that the node
  // inside it was replaced; only a read on every commit can. React sets refs during commit, so
  // this cannot be a render-phase read either. It is not an update chain: `setEl` returns the
  // previous element unless the node's identity actually changed, and React bails out of a state
  // write whose value is `Object.is`-equal, so a steady container costs one ref read per commit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    setEl((prev) => (prev === scrollRef.current ? prev : scrollRef.current))
  })

  const measure = useCallback(() => {
    if (!el) return
    setScrollTop(el.scrollTop)
    setViewport(el.clientHeight)
  }, [el])

  // Measure once mounted and whenever the container resizes.
  useLayoutEffect(() => {
    if (!el) return
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el, measure])

  // Track scroll position on the container.
  useEffect(() => {
    if (!el) return
    const onScroll = (): void => setScrollTop(el.scrollTop)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [el])

  return windowSlice({ count, rowHeight, scrollTop, viewport, overscan })
}
