import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, IconButton, Paper, Stack, Typography } from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import RemoveIcon from '@mui/icons-material/Remove'
import FitScreenIcon from '@mui/icons-material/FitScreen'
import { Tooltip as MuiTooltip } from '../../lib/Tooltip'
import type { TimelineView } from '@shared/combat'
import { EventTicks, LaneRows, MarkerRail, PinLabels, PinSpans, TimeAxis } from './TimelineChart'
import { TimelineHoverLayer, type HoverHandle } from './TimelineHoverLayer'
import { buildDpsSeries } from './dashboardData'
import { MIN_PLOT_W, MIN_SPAN_MS, PAD, ZOOM_STEP, fmtDur, timelineMetrics, type WrapSize } from './timelineGeometry'
import { useTimelineViewport, type TimelineViewport } from './useTimelineViewport'

// Dense, dark, WarcraftLogs-style timeline (Task #51 v2): X = encounter time, Y = one row
// per skill/spell (left-axis labels), ticks where events occurred. Stance/invocation spans
// are pinned above the skill lanes, markers ride their own rail. SVG render (crisp at any zoom).
//
// The four halves live in their own modules: `timelineGeometry.ts` (sizing + tooltip models),
// `useTimelineViewport.ts` (the zoom/pan window and its wheel/drag interactions),
// `TimelineChart.tsx` (the SVG parts) and `TimelineHoverLayer.tsx` (the crosshair + tooltip).
// What is left here is the chart's frame.

/** ~6 evenly spaced axis ticks across the VISIBLE window. */
function axisTicks(start: number, span: number): number[] {
  const n = 6
  return Array.from({ length: n + 1 }, (_, i) => start + (span * i) / n)
}

/**
 * The measured frame. `minHeight` is NOT decoration: the scroller inside is absolutely
 * positioned, so this box has no in-flow content and its flex basis is 0 — in a Paper with no
 * free space left to hand out (a very short window) `flexGrow` would resolve it to a 0px box and
 * the chart would vanish. MEASURED: at a 900×420 window the frame reported `clientHeight` 0
 * before this floor existed. 120 is the same floor `useWrapSize` clamps to, so the size the
 * chart is drawn for and the box it is drawn in cannot disagree.
 */
const FRAME_SX = { flexGrow: 1, minHeight: 120, position: 'relative' } as const

/** The scroller fills its frame exactly — absolute, so its bars are invisible to the frame. */
const SCROLL_SX = { position: 'absolute', inset: 0, overflow: 'auto' } as const

/**
 * Measure the chart's container so the SVG fills it, responsively (Task #54).
 *
 * The observed element MUST be the non-scrolling frame, never the scroll box — see the header of
 * timelineGeometry.ts for the measured feedback loop that made the chart oscillate when the
 * surface was smaller than it. The frame's size comes from the flex layout alone, so no amount of
 * content can change what this reads.
 *
 * The identity guard is belt-and-braces on top of that: a ResizeObserver may legitimately re-fire
 * with the same box (a reflow elsewhere, a device-pixel-ratio change), and re-rendering the whole
 * chart for a size that did not move is pure waste. It is NOT the fix — a same-value guard cannot
 * damp an oscillation whose values genuinely differ.
 */
function useWrapSize(ref: React.RefObject<HTMLDivElement>): WrapSize {
  const [wrap, setWrap] = useState<WrapSize>({ w: 900, h: 400 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (!cr) return
      const w = Math.max(MIN_PLOT_W + 140, cr.width)
      const h = Math.max(120, cr.height)
      setWrap((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return wrap
}

/** Title + the counts + the three zoom controls. */
function TimelineToolbar({ tl, vp }: { tl: TimelineView; vp: TimelineViewport }): React.JSX.Element {
  const { view, span, zoomedIn } = vp
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
      <Typography variant="subtitle1" noWrap>
        {tl.name} · timeline
      </Typography>
      <Stack direction="row" alignItems="center" spacing={0.5}>
        <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
          {zoomedIn ? `${fmtDur(view.start)}-${fmtDur(view.end)} of ` : ''}
          {fmtDur(tl.durationMs)} · {tl.lanes.length} lanes ·{' '}
          {/* The count after "of" is the fight's TRUE instant count (totalCount), so a ring
              that overflowed its drop-oldest cap reports what it LOST, not its own size. */}
          {tl.downsampled || tl.truncated
            ? `${tl.events.length} of ${tl.totalCount} events`
            : `${tl.totalCount} events`}
        </Typography>
        <MuiTooltip title="Zoom out">
          <span>
            <IconButton size="small" onClick={() => vp.zoomAround((view.start + view.end) / 2, ZOOM_STEP)} disabled={!zoomedIn}>
              <RemoveIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </MuiTooltip>
        <MuiTooltip title="Zoom in">
          <span>
            <IconButton size="small" onClick={() => vp.zoomAround((view.start + view.end) / 2, 1 / ZOOM_STEP)} disabled={span <= MIN_SPAN_MS}>
              <AddIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </MuiTooltip>
        <MuiTooltip title="Reset to fit">
          <span>
            <IconButton size="small" onClick={vp.fit} disabled={!zoomedIn}>
              <FitScreenIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </MuiTooltip>
      </Stack>
    </Stack>
  )
}

function CombatTimelineInner({ tl }: { tl: TimelineView }): React.JSX.Element {
  const dur = Math.max(1, tl.durationMs)
  const svgRef = useRef<SVGSVGElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const hoverRef = useRef<HoverHandle>(null)
  const wrap = useWrapSize(wrapRef)
  const m = timelineMetrics(tl, wrap)
  const vp = useTimelineViewport({ dur, id: tl.id, svgRef, labelW: m.labelW, plotW: m.plotW })
  const { view, span, zoomedIn, xOf } = vp

  // The hover readout's rate is a SAMPLE of the DPS card's own curve, so the two surfaces can
  // never disagree. Keyed on the timeline's identity, which CombatView stabilises across
  // snapshot ticks — a finalized fight builds this once.
  const dpsSeries = useMemo(() => buildDpsSeries(tl), [tl])

  // HOVER / DRAG SEAM (§7.1): a bare pointermove only. `buttons` is non-zero throughout a drag
  // (setPointerCapture included), so bailing on it lets the viewport's drag-pan and this hover
  // coexist with NO shared state and no change to useTimelineViewport.
  const onHoverMove = useCallback((ev: React.PointerEvent<HTMLDivElement>) => {
    const el = ev.currentTarget
    if (ev.buttons !== 0) {
      hoverRef.current?.clear()
      return
    }
    const r = el.getBoundingClientRect()
    hoverRef.current?.move(ev.clientX - r.left + el.scrollLeft, ev.clientY - r.top + el.scrollTop)
  }, [])
  const onHoverLeave = useCallback(() => hoverRef.current?.clear(), [])

  // Lane index by label (Y position). Lanes are pre-sorted (category, total desc) by the
  // engine; keep that order top→bottom.
  const laneIndex = useMemo(() => {
    const map = new Map<string, number>()
    tl.lanes.forEach((l, i) => map.set(l.lane, i))
    return map
  }, [tl.lanes])

  const ticks = useMemo(() => axisTicks(view.start, span), [view.start, span])

  // Windowed rendering: only ticks whose time falls within the visible window (a small
  // margin so ticks at the edge still draw). At the 5k ring cap + downsample budget this
  // keeps the DOM node count low even at full zoom-out.
  const visibleEvents = useMemo(
    // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives TimelineEvent. Becomes a view descriptor when the source lands.
    () => tl.events.filter((e) => e.t >= view.start - 1 && e.t <= view.end + 1),
    [tl.events, view.start, view.end]
  )

  return (
    <Paper variant="outlined" sx={{ p: 1.5, flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <TimelineToolbar tl={tl} vp={vp} />
      {/* TWO boxes, and the split is the flicker fix (2026-08-04). The OUTER one is what the
          ResizeObserver watches: it never scrolls, and its size is decided entirely by this
          Paper's flex column, so a scrollbar appearing inside can never change the number the
          chart sizes itself from. The INNER one is the scroller, absolutely positioned to the
          frame so it is exactly as big — its bars eat into ITS box, which nothing measures.
          Collapsing these back into one element restores the oscillation; the arithmetic that
          makes it oscillate is pinned in tests/timelineGeometry.test.mts. */}
      <Box ref={wrapRef} data-testid="timeline-frame" sx={FRAME_SX}>
        <Box
          data-testid="timeline-scroll"
          sx={SCROLL_SX}
          onPointerMove={onHoverMove}
          onPointerLeave={onHoverLeave}
        >
          <svg
            ref={svgRef}
            width={m.svgW}
            height={m.svgH}
            style={{ display: 'block', fontFamily: 'inherit', cursor: zoomedIn ? 'grab' : 'default', touchAction: 'none' }}
            onPointerDown={vp.onPointerDown}
            onPointerMove={vp.onPointerMove}
            onPointerUp={vp.onPointerUp}
          >
            {/* clip the plot so ticks/spans don't draw over the label gutter when panning */}
            <defs>
              <clipPath id="tl-plot-clip">
                <rect x={m.labelW} y={0} width={m.plotW + 1} height={m.totalH + PAD} />
              </clipPath>
            </defs>
  
            {/* pinned stance / invocation spans, then the marker rail + its guides — BEFORE the
                lanes, so a guide is a faint reference line behind the ticks, never over them */}
            <g clipPath="url(#tl-plot-clip)">
              <PinSpans tl={tl} m={m} xOf={xOf} />
              <MarkerRail tl={tl} m={m} xOf={xOf} />
            </g>
            {/* pin-row labels (outside the clip, in the gutter) */}
            <PinLabels pinRows={m.pinRows} />
  
            {/* lane labels + gridlines */}
            <g transform={`translate(0, ${m.laneTop})`}>
              <LaneRows tl={tl} m={m} />
  
              {/* event ticks (windowed to the visible time range) */}
              <g clipPath="url(#tl-plot-clip)" transform={`translate(0, ${-m.laneTop})`}>
                <g transform={`translate(0, ${m.laneTop})`}>
                  <EventTicks events={visibleEvents} laneIndex={laneIndex} m={m} xOf={xOf} />
                </g>
              </g>
            </g>
  
            {/* time axis */}
            <g transform={`translate(0, ${m.laneTop + m.plotH})`}>
              <TimeAxis ticks={ticks} m={m} xOf={xOf} zoomedIn={zoomedIn} />
            </g>
          </svg>

          <TimelineHoverLayer
            api={hoverRef}
            tl={tl}
            events={visibleEvents}
            laneIndex={laneIndex}
            m={m}
            view={view}
            span={span}
            series={dpsSeries}
          />
        </Box>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
        Scroll to zoom around the cursor · Shift+scroll or drag to pan · hollow red = miss/resist
      </Typography>
    </Paper>
  )
}

export const CombatTimeline = memo(CombatTimelineInner)
