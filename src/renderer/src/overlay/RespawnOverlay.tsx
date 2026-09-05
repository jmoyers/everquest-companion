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
// while the log is silent — and a row carries its own `baseTs`, so ticking costs no IPC at all.
// (The XP window's clock is 30 s for the opposite reason: nothing in it is a countdown.)
//
// AND IT IS WHERE THE ROUND-3 RULING HAS TO LAND (owner, 2026-08-10). The defect was reported from
// live play: the mob was hitting him and the row over the game still read "due 4m ago". So a row
// the log has NAMED since its clock started reads UP here, in its own colour, sorted to the top —
// and the affordance that re-bases the clock onto that sighting lives here too, in INTERACTIVE
// mode, because a locked window is click-through by law and has no clicks to give. Confirming from
// the Timers tab is the same call on the same module (`confirmRespawnSighting`); this window simply
// spares you the alt-tab in the one moment the feature is for.
//
// AND ROUND 4 LANDS HERE FOR THE SAME REASON (owner, 2026-08-10). Unwatching used to mean finding
// the name in the watch list at the bottom of the Timers tab — i.e. alt-tabbing out of the game to
// get rid of a row that is wrong about the mob in front of you, which on EQ's duplicated names is
// the common case. So a row here carries its own Unwatch, in INTERACTIVE mode only, beside the
// confirm affordance and under the same law: a locked window is click-through and has no clicks to
// give. It stops that NAME everywhere, including zones this window does not show — which the
// button's title used to say, until the owner deleted every Unwatch tooltip in the round-7 addendum
// on the grounds that the control speaks for itself. The behaviour is unchanged and argued in
// shared/respawn.ts; nothing on screen recites it.
//
// AND ROUND 6'S HOVER CARD IS GONE AGAIN (owner, 2026-08-10, round 7 — and the reversal is the
// interesting part). Round 6 put the mob's drop card on these rows as well as on the tab's; the
// owner used it and ruled it out HERE only: it "takes the overlay over too completely". The
// arithmetic is plain once you have seen it — this window is about 300px wide and its rows are 30px
// tall, and the card is 300px wide and can run several times a row's height, so pointing anywhere
// replaces the countdown you opened the window for with a drop table. The card is not worse than it
// was; it is bigger than its host. So it is IN-APP ONLY.
//
// …AND JOS-358 FINISHED THE JOB: the plain `title` round 5 left on the row is gone too. The owner
// ruled from hands-on testing that these windows keep tooltips ONLY in the title bar, and a row
// hover was also leaving popups stranded over the game when the cursor flicked out. So a row states
// its clock, its colour and its bar, and nothing else; `respawnProvenance` is unchanged and is what
// the Timers tab's own card leads with (features/timers, lib/hoverCards.tsx). The header count's
// hover — `RESPAWN_LEGEND_TITLE`, the two claims this window makes — is in the TITLE BAR and stays.
//
// (Nothing about round 6's REFACTOR is undone: the card still lives in `lib/hoverCards.tsx`, where
// the event overlay's `/con` rows and the Timers tab both draw it. One of its two new callers went
// away, not the move.)
//
// AND ROUND 8 PUTS ROWS HERE THAT NO CLOCK IS RUNNING FOR (owner, 2026-08-11). A watched mob always
// has a row now — the fold no longer retires one whose estimate elapsed half an hour ago — so this
// window can hold a clock that ran out overnight beside one with four minutes left. Over the game
// that ordering is the whole product, so the two are told apart without reading: the long-gone row
// is GREY, says "due long ago" (or "awaiting next death") instead of a number that grows forever,
// draws no bar, and `orderRespawnRows` sinks it under every live clock. It keeps its Unwatch,
// because it is still a mob you asked for.
//
// AND ROUND 9 PUTS A STATE HERE AND NONE OF ITS CONTROLS (owner, 2026-08-11). A row whose duration
// the player set themselves is OVERRIDDEN, and over the game that is worth knowing at a glance — so
// the rung line goes violet, a colour this window uses for nothing else, off the same
// `respawnOverridden` the tab paints in gold. What does NOT come here is the editing: the edit icon
// and its modal are tab-only, for exactly the reason round 7 removed the hover card from this window
// (a 300px window cannot host a 300px surface) and because a locked window is click-through and has
// no clicks to give. Its rung line also stopped spelling the duration inline and reads
// `respawnDurationText`, so the `<=` that says "upper bound" cannot go missing on one surface.
//
// MUI-FREE, plain divs and inline styles, like every file in this bundle.

import { type JSX, useEffect, useState } from 'react'
import {
  EMPTY_RESPAWN_SNAP,
  RESPAWN_CONFIRM_TITLE,
  RESPAWN_UNWATCH_LABEL,
  orderRespawnRows,
  respawnBasisLabel,
  respawnClockLabel,
  respawnDurationText,
  respawnInZone,
  respawnOverridden,
  respawnReading,
  respawnSeenLabel,
  respawnSourceLabel,
  type RespawnRow,
  type RespawnSnap
} from '@shared/respawn'
import { fmtDuration } from '../features/buffs/format'
import { OverlayHeader } from './OverlayHeader'
import { FOOTER_ROW, OverlayContent } from './overlayScale'
import { TextScaleStepper } from './TextScaleStepper'
import { useOverlayModule } from './useOverlayModule'
import { type OverlayChrome, useOverlayChrome } from './useOverlayChrome'

/** This window's accent — a warm amber, deliberately none of the four already in use (damage gold,
 *  healing green, debuff red, XP blue). Two windows that look alike at a glance would be worse. */
const ACCENT = '#e8b45f'
const ACCENT_BG = 'rgba(232,180,95,0.2)'
/** A clock that has run out. Green, so "go look" is readable in peripheral vision. */
const DUE = '#7fd18b'
/**
 * THE LOG SAID IT IS THERE. Deliberately not green and not the window's amber: `due` and `seen`
 * are different kinds of claim — one is this app's estimate elapsing, the other is the game naming
 * the mob — and a player glancing at this window in peripheral vision has to be able to tell them
 * apart without reading a word. Red-pink also happens to be what the moment actually is: the
 * report that produced this ruling is a mob standing on top of the owner, hitting him.
 */
const SEEN = '#ff6b8a'
/**
 * A CLOCK THAT STOPPED MEANING ANYTHING (round 8). A watched mob always has a row now, including one
 * whose estimate elapsed hours ago — and over the game, where every pixel is spent, the row that
 * cannot help you must not look like the one that can. Grey is the absence of the other three
 * claims: not the window's amber, not due's green, not a sighting's red.
 */
const STALE = 'rgba(255,255,255,0.38)'
/**
 * A NUMBER THE PLAYER SET THEMSELVES (round 9). A soft violet, deliberately none of the four above:
 * this is not a claim about the clock (due / UP / long gone are), it is a claim about where the
 * clock's LENGTH came from, and a camp full of clocks has to say which of them you overruled without
 * being read word by word.
 */
const OVERRIDDEN = '#c3aef5'

/** One second. A countdown is the one number in this app that has to move while the log is idle. */
const TICK_MS = 1000

/**
 * WHAT THE TWO COLOURS CLAIM, on the header count's hover. The distinction is load-bearing - a
 * clock at zero is this app's estimate elapsing and is never a sighting, while UP is the game
 * having named the mob - and it is the one thing about this window a first glance cannot teach.
 * So it stays; it just stopped costing a line of a window that is 300px tall (round 5).
 */
const RESPAWN_LEGEND_TITLE =
  'Clocks running. Zero = our estimate elapsed, not a sighting. UP = the log named the mob.'

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

/**
 * The seen line, and the button that is the whole of the second ruling. Its own component because
 * `RespawnLine` is at the repo's factoring ceiling — and because the button exists only where a
 * click can land: a LOCKED overlay is click-through by law and passes them to the game.
 */
function SeenLine({
  row,
  nowMs,
  interactive,
  onConfirm
}: {
  row: RespawnRow
  nowMs: number
  interactive: boolean
  onConfirm: (rowId: string) => void
}): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
      <span data-testid="respawn-overlay-seen" style={{ fontSize: 9, color: SEEN, flexGrow: 1, minWidth: 0 }}>
        {respawnSeenLabel(row, nowMs, fmtDuration)}
      </span>
      {interactive && (
        <button
          type="button"
          data-testid="respawn-overlay-confirm"
          // The label IS the sentence ('start clock here'); `RESPAWN_CONFIRM_TITLE` explains it on
          // the Timers tab, where a hover is allowed. Out here it is a row control, and JOS-358
          // keeps hovers in the title bar.
          aria-label={RESPAWN_CONFIRM_TITLE}
          onClick={() => {
            onConfirm(row.id)
          }}
          style={{
            flexShrink: 0,
            fontSize: 9,
            lineHeight: 1.4,
            padding: '0 4px',
            color: SEEN,
            background: 'transparent',
            border: `1px solid ${SEEN}66`,
            borderRadius: 3,
            cursor: 'pointer'
          }}
        >
          start clock here
        </button>
      )}
    </div>
  )
}

/**
 * THE ROW'S OWN WAY OUT (round 4), and the second control on this window that exists only while it
 * is unlocked. Deliberately dim — it is the least urgent thing on a row whose whole job is a
 * countdown — and deliberately a WORD rather than an ×, which on a floating window reads as "close
 * this thing" and would be a lie: nothing closes and nothing derived from the log is lost.
 *
 * AND IT SAYS NOTHING ON HOVER (owner ruling, round 7 addendum). It carried the two consequences on
 * a native `title` until the owner deleted it — the control speaks for itself — so the attribute is
 * gone rather than shortened. The `aria-label` stays, because it is the only thing distinguishing
 * one row's button from the next one's to anything not reading pixels.
 */
function UnwatchButton({ row, onUnwatch }: { row: RespawnRow; onUnwatch: (key: string) => void }): JSX.Element {
  return (
    <button
      type="button"
      data-testid="respawn-overlay-unwatch"
      aria-label={`${RESPAWN_UNWATCH_LABEL} ${row.display}`}
      onClick={() => {
        onUnwatch(row.key)
      }}
      style={{
        flexShrink: 0,
        fontSize: 9,
        lineHeight: 1.4,
        padding: '0 4px',
        color: 'rgba(255,255,255,0.55)',
        background: 'transparent',
        border: '1px solid rgba(255,255,255,0.18)',
        borderRadius: 3,
        cursor: 'pointer'
      }}
    >
      {RESPAWN_UNWATCH_LABEL.toLowerCase()}
    </button>
  )
}

/** The top line: the name, the number, and (unlocked only) the row's own way out. */
function ClockLine({
  row,
  label,
  tone,
  interactive,
  onUnwatch
}: {
  row: RespawnRow
  label: string
  tone: string
  interactive: boolean
  onUnwatch: (key: string) => void
}): JSX.Element {
  return (
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
        style={{ fontSize: 13, fontWeight: 700, color: tone, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
      >
        {label}
      </span>
      {/* After the number, so the countdown keeps its place on every row. */}
      {interactive && <UnwatchButton row={row} onUnwatch={onUnwatch} />}
    </div>
  )
}

/**
 * The dim line under the bar: the estimate, the rung that produced it, and the basis — one string,
 * because that is what it describes (round 9 made the tab's version one bordered object for the same
 * reason; over the game a line of its own IS the object).
 *
 * AND AN OVERRULED NUMBER SAYS SO IN COLOUR (owner ruling, round 9). `respawnOverridden` is the tab's
 * definition, read here rather than re-derived, and the colour is one this window uses nowhere else —
 * amber is the window, green is due, pink is UP, grey is long gone. Over the game the whole question
 * is "which of these clocks did I set myself", and it has to answer without being read.
 *
 * THE STATE ONLY. There is no edit affordance here and there will not be one: a modal over a 300px
 * window is round 7's card ruling with a bigger footprint, and a locked window is click-through and
 * has no clicks to give at all.
 */
function RungLine({ row }: { row: RespawnRow }): JSX.Element {
  const basis = respawnBasisLabel(row)
  const over = respawnOverridden(row)
  return (
    <div
      data-testid="respawn-overlay-rung"
      style={{ fontSize: 9, color: over ? OVERRIDDEN : 'rgba(255,255,255,0.42)', marginTop: 1 }}
    >
      {respawnDurationText(row, fmtDuration)} · {respawnSourceLabel(row)}
      {basis.length > 0 ? ` · ${basis}` : ''}
    </div>
  )
}

/** One clock. Name on the left, the number on the right, the rung underneath in dim text. */
function RespawnLine({
  row,
  nowMs,
  interactive,
  onConfirm,
  onUnwatch
}: {
  row: RespawnRow
  nowMs: number
  /** The window is UNLOCKED. A locked overlay is click-through, so it draws no button at all. */
  interactive: boolean
  onConfirm: (rowId: string) => void
  /** Round 4: stop watching this mob from here, without alt-tabbing to the tab's list. */
  onUnwatch: (key: string) => void
}): JSX.Element {
  const r = respawnReading(row, nowMs)
  const hasEstimate = row.estimateMs !== undefined
  // The clock's WORDING is the tab's, from shared/respawn.ts — a countdown must not read one way
  // in the app and another way over the game. That includes the UP a seen row shows instead.
  const label = respawnClockLabel(row, nowMs, fmtDuration)
  const tone = r.seen ? SEEN : r.stale ? STALE : r.due ? DUE : ACCENT
  return (
    <div
      data-testid="respawn-overlay-row"
      data-respawn-mob={row.key}
      data-respawn-due={r.due ? 'true' : 'false'}
      data-respawn-seen={r.seen ? 'true' : 'false'}
      data-respawn-stale={r.stale ? 'true' : 'false'}
      data-respawn-overridden={respawnOverridden(row) ? 'true' : 'false'}
      data-respawn-basis={row.basis}
      // NO HOVER AT ALL (JOS-358). Round 7 left `respawnProvenance` here as a native title; the
      // owner's ruling takes it, and `interactive` no longer changes anything about this row's
      // hover because there is none in either mode. See the file header.
      style={{ padding: '2px 2px 3px', borderLeft: `2px solid ${tone}66`, paddingLeft: 5 }}
    >
      <ClockLine row={row} label={label} tone={tone} interactive={interactive} onUnwatch={onUnwatch} />
      {/* The bar is the estimate running down. Absent entirely when there is no estimate, rather
          than drawn empty — an empty bar reads as "nearly up", which would be a lie. And absent on a
          STALE row (round 8) for the same reason: nothing is still running for it to draw. */}
      {hasEstimate && !r.stale && (
        <div style={{ height: 2, background: 'rgba(255,255,255,0.08)', borderRadius: 2, marginTop: 2 }}>
          <div
            style={{
              height: '100%',
              width: `${String(Math.round((1 - r.fraction) * 100))}%`,
              background: tone,
              borderRadius: 2
            }}
          />
        </div>
      )}
      {/* NOTHING RE-BASES ITSELF — the affordance below is the only path to `basis: 'sighting'`. */}
      {r.seen && <SeenLine row={row} nowMs={nowMs} interactive={interactive} onConfirm={onConfirm} />}
      <RungLine row={row} />
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
        ...FOOTER_ROW,
        ...noDrag,
        gap: 6
      }}
    >
      {/* No hover on the slider (JOS-358): it is the only thing in this footer and it looks like
          what it is. */}
      <input
        type="range"
        aria-label="Background opacity"
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
  const snap = useOverlayModule<RespawnSnap>('respawn', EMPTY_RESPAWN_SNAP)
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
  /** Fire-and-forget: the module answers with a delta, and a refusal is already described by it. */
  const confirmSighting = (rowId: string): void => {
    void window.eqOverlay.confirmRespawnSighting(rowId)
  }
  /** Same contract, round 4's write: main removes the watch, persists it and pushes the delta. */
  const unwatch = (key: string): void => {
    void window.eqOverlay.unwatchRespawn(key)
  }

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
        // The two claims this window makes, on the count's hover (round 5). It used to be a
        // standing legend line under the rows - a caption repeating what the words UP and `due`
        // already say, on the surface with the least room in the app.
        tailTitle={RESPAWN_LEGEND_TITLE}
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
              : 'No clocks running - watch a mob on the Timers tab.'}
          </div>
        ) : (
          rows.map((row) => (
            <RespawnLine
              key={row.id}
              row={row}
              nowMs={nowMs}
              interactive={!locked}
              onConfirm={confirmSighting}
              onUnwatch={unwatch}
            />
          ))
        )}
      </OverlayContent>

      {!locked && (
        <RespawnFooter bgAlpha={bgAlpha} textScale={textScale} patch={patch} noDrag={noDrag} />
      )}
    </div>
  )
}
