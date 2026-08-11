// RespawnOverlay (JOS-194) — the respawn clocks, floating over the game.
//
// This window is the whole point of the ticket in practice. A respawn timer you have to alt-tab to
// read is a timer you do not read; the corroborating report (01KZQ4X16MPDKQ2CF4SY35P5ED) is from
// somebody who left a tool that put named-mob clocks on screen and missed them. So the Timers tab
// is where you SET this up and this window is where you USE it.
//
// IT DERIVES NOTHING AND FOLDS NOTHING. Every row is the `respawn` module's own, composed by the
// same pure helpers the tab reads (`orderRespawnRows`, `respawnReading`, `respawnSourceLabel`) —
// a second opinion about which mob is due soonest, one process away from the first, is exactly the
// drift the shared/ split exists to prevent.
//
// IT SHOWS THE ZONE YOU ARE IN, AND NOTHING ELSE (owner ruling after the first hands-on round,
// 2026-08-10). The fold keeps every zone it has walked through, and this window used to draw all of
// them — so a Befallen camp put four Guk clocks over the game, none of which anybody could act on.
// The filter is `respawnInZone(snap.rows, snap.zone)`: the module's OWN zone-stay state, published
// in the snapshot, applied by the shared helper the Timers tab also calls. Nothing is derived here
// and no second zone is tracked. A clock in another zone is not hidden data — it is still in the
// fold and still on the tab's all-zones view — it is just not something this window can help with,
// and that includes one that has come DUE (see the helper's header).
//
// IT TICKS ITSELF, at 1 Hz, because a countdown is the one thing in this app that must keep moving
// while the log is silent — and a row carries its own `diedTs`, so ticking costs no IPC at all.
// (The XP window's clock is 30 s for the opposite reason: nothing in it is a countdown.)
//
// MUI-FREE, plain divs and inline styles, like every file in this bundle.

import { type JSX, useEffect, useState } from 'react'
import {
  EMPTY_RESPAWN_SNAP,
  mergeRespawnDelta,
  orderRespawnRows,
  respawnClockLabel,
  respawnInZone,
  respawnReading,
  respawnSourceLabel,
  type RespawnDelta,
  type RespawnRow,
  type RespawnSnap
} from '@shared/respawn'
import { fmtDuration } from '../features/buffs/format'
import { OverlayHeader } from './OverlayHeader'
import { OverlayContent } from './overlayScale'
import { TextScaleStepper } from './TextScaleStepper'
import { useOverlayModule } from './useOverlayModule'
import { type OverlayChrome, useOverlayChrome } from './useOverlayChrome'

/** This window's accent — a warm amber, deliberately none of the four already in use (damage gold,
 *  healing green, debuff red, XP blue). Two windows that look alike at a glance would be worse. */
const ACCENT = '#e8b45f'
const ACCENT_BG = 'rgba(232,180,95,0.2)'
/** A clock that has run out. Green, so "go look" is readable in peripheral vision. */
const DUE = '#7fd18b'

/** One second. A countdown is the one number in this app that has to move while the log is idle. */
const TICK_MS = 1000

function useSecondsClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now())
    }, TICK_MS)
    return () => {
      clearInterval(id)
    }
  }, [])
  return now
}

/** One clock. Name on the left, the number on the right, the provenance underneath in dim text. */
function RespawnLine({ row, nowMs }: { row: RespawnRow; nowMs: number }): JSX.Element {
  const r = respawnReading(row, nowMs)
  const hasEstimate = row.estimateMs !== undefined
  // The clock's WORDING is the tab's, from shared/respawn.ts — a countdown must not read one way
  // in the app and another way over the game.
  const label = respawnClockLabel(row, nowMs, fmtDuration)
  return (
    <div
      data-testid="respawn-overlay-row"
      data-respawn-mob={row.key}
      data-respawn-due={r.due ? 'true' : 'false'}
      // The full provenance sentence rides the native title, the same place the tab's tooltip
      // puts it — a floating window has no room to print it and no right to hide it.
      title={`${respawnSourceLabel(row)}${row.wikiText === undefined ? '' : ` · wiki: "${row.wikiText}"`}`}
      style={{ padding: '2px 2px 3px', borderLeft: `2px solid ${r.due ? DUE : ACCENT}66`, paddingLeft: 5 }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span
          style={{
            fontSize: 11.5,
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {row.display}
        </span>
        <span
          data-testid="respawn-overlay-clock"
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: r.due ? DUE : ACCENT,
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0
          }}
        >
          {label}
        </span>
      </div>
      {/* The bar is the estimate running down. Absent entirely when there is no estimate, rather
          than drawn empty — an empty bar reads as "nearly up", which would be a lie. */}
      {hasEstimate && (
        <div style={{ height: 2, background: 'rgba(255,255,255,0.08)', borderRadius: 2, marginTop: 2 }}>
          <div
            style={{
              height: '100%',
              width: `${String(Math.round((1 - r.fraction) * 100))}%`,
              background: r.due ? DUE : ACCENT,
              borderRadius: 2
            }}
          />
        </div>
      )}
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.42)', marginTop: 1 }}>
        {row.source === 'observed' ? '<= ' : ''}
        {hasEstimate ? fmtDuration(row.estimateMs) : 'no estimate'} · {respawnSourceLabel(row)}
      </div>
    </div>
  )
}

function RespawnFooter({
  bgAlpha,
  textScale,
  patch,
  noDrag
}: {
  bgAlpha: number
  textScale: number
  patch: OverlayChrome['patch']
  noDrag: React.CSSProperties
}): JSX.Element {
  return (
    <div
      style={{
        ...noDrag,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 8px 5px',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        flexShrink: 0
      }}
    >
      <input
        type="range"
        title="Background opacity"
        min={0.1}
        max={1}
        step={0.02}
        value={bgAlpha}
        onChange={(e) => {
          patch({ bgAlpha: Number(e.target.value) })
        }}
        style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 20, accentColor: ACCENT, height: 4 }}
      />
      <TextScaleStepper textScale={textScale} patch={patch} noDrag={noDrag} />
    </div>
  )
}

export default function RespawnOverlay(): JSX.Element {
  const snap = useOverlayModule<RespawnSnap, RespawnDelta>('respawn', mergeRespawnDelta, EMPTY_RESPAWN_SNAP)
  const { locked, bgAlpha, textScale, hovering, patch, toggleLock, capture, dragRegion, noDrag } =
    useOverlayChrome()
  const nowMs = useSecondsClock()
  // Scoped to the zone the fold says you are in FIRST, then re-ordered against the LOCAL clock —
  // not the one the fold last published: "soonest due" moves every second whether or not the log
  // does, and a list that only re-sorts on a death line would put a mob that came due a minute ago
  // below one that has ten minutes to run.
  const rows = orderRespawnRows(respawnInZone(snap.rows, snap.zone), nowMs)
  /** Clocks the fold is holding for somewhere else. Counted so the empty state can say so. */
  const elsewhere = snap.rows.length - rows.length

  return (
    <div
      data-testid="respawn-overlay"
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Inter, "Segoe UI", Roboto, system-ui, sans-serif',
        color: '#f2f2f2',
        background: `rgba(14,17,21,${bgAlpha})`,
        border: locked ? '1px solid rgba(255,255,255,0.04)' : `1px solid ${ACCENT}66`,
        borderRadius: 8,
        boxSizing: 'border-box',
        overflow: 'hidden'
      }}
    >
      <OverlayHeader
        tag="RESP"
        title={snap.zone.length > 0 ? snap.zone : 'Respawn'}
        titleColor={ACCENT}
        tail={rows.length > 0 ? String(rows.length) : undefined}
        tailTitle="Clocks running."
        iconAccentBg={ACCENT_BG}
        chrome={{ locked, hovering, dragRegion, noDrag, toggleLock, capture }}
      />

      <OverlayContent textScale={textScale} testId="respawn-overlay-rows" locked={locked} capture={capture}>
        {rows.length === 0 ? (
          // An empty window is a STATE, and it says WHICH one — this is the single most likely
          // thing a first-time user sees. Two different empties: nothing watched anywhere (go to
          // the tab), or clocks running somewhere you are not (they are safe, they are not here).
          <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.5)', padding: '8px 2px' }}>
            {elsewhere > 0
              ? `No clocks in this zone - ${String(elsewhere)} running elsewhere.`
              : 'No clocks running - kill something, then Watch it on the Timers tab.'}
          </div>
        ) : (
          rows.map((row) => <RespawnLine key={row.id} row={row} nowMs={nowMs} />)
        )}
        {/* ONE SENTENCE FOR THE WHOLE WINDOW rather than a caveat per row: a clock at zero means
            the estimate elapsed. The app has never seen a spawn and cannot claim one. */}
        {rows.length > 0 && (
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', paddingTop: 4 }}>
            zero = estimate elapsed, not a sighting
          </div>
        )}
      </OverlayContent>

      {!locked && (
        <RespawnFooter bgAlpha={bgAlpha} textScale={textScale} patch={patch} noDrag={noDrag} />
      )}
    </div>
  )
}
