// buffTimerBars — the BAR BODY of the 'buffs' overlay (JOS-89). BuffsOverlay.tsx is the window
// chrome; this file is the rows. Design record: docs/plans/buff-timer-overlay.md.
//
// THE BAR IS THE CLAIM. A row draws a receding bar if and only if `spells.json` STATES a
// duration for what it is showing — because a bar is a promise about when something ends, and
// this surface does not make one it cannot keep. An unknown-duration row therefore has NO BAR AT
// ALL and prints elapsed time counting up beside a `+`. That absence is the honest signal, and it
// is the whole visual difference between "18s left" and "you have had this for 18s".
//
// MUI-FREE ON PURPOSE, like every file in this bundle: the overlay is its own renderer entry with
// no theme and no component library. `fmtDuration` is imported rather than re-spelled — the app
// gets ONE duration formatter (AGENTS.md UI conventions), and features/buffs/format.ts is a pure
// module that pulls no MUI in behind it.

import { type JSX } from 'react'
import { type BuffTimerRow, timerReading } from '@shared/buffTimers'
import { fmtDuration } from '../features/buffs/format'

const GOLD = '#d9b25f'
/** A debuff you put on something else reads red — never confusable with your own buff (law 4's
 *  presentation rule, and the same split `features/buffs/format.ts classAccent` makes). */
const RED = '#e07a6a'
/** Crowd control is its own colour: a mez is not a damage debuff, and a player chain-mezzing
 *  four enemies needs to find those four rows at a glance. */
const VIOLET = '#a98cd8'

export function rowAccent(kind: BuffTimerRow['kind']): string {
  return kind === 'cc' ? VIOLET : kind === 'debuff' ? RED : GOLD
}

/** What the right-hand column says. The `+` is load-bearing: it is how a reader tells a count-up
 *  from a countdown without reading the bar (or its absence). */
export function timeLabel(row: BuffTimerRow, nowMs: number): string {
  const r = timerReading(row, nowMs)
  if (row.mode === 'permanent') return 'permanent'
  if (row.mode === 'elapsed') {
    // fmtDuration renders a 0 as an em-dash (it is the app's "no value" spelling); a buff that
    // landed this second has a real elapsed time of zero, so spell it as one.
    const elapsed = fmtDuration(r.elapsedMs)
    return `+${elapsed === '-' ? '0s' : elapsed}`
  }
  return r.overdue ? '0s' : fmtDuration(r.remainingMs ?? 0)
}

export function BuffTimerBar({
  row,
  nowMs,
  showTarget = false
}: {
  row: BuffTimerRow
  nowMs: number
  /**
   * Print the target ON the row. True in the FLAT soonest-first arrangement (JOS-140), where there
   * is no per-target heading above it — the owner's ask was a queue of things running out, and
   * which mob a row is on is then a detail on the row rather than a section it lives under.
   * Without this a flat list of five mez bars would be five rows that cannot be told apart.
   */
  showTarget?: boolean
}): JSX.Element {
  const r = timerReading(row, nowMs)
  const accent = rowAccent(row.kind)
  const countdown = row.mode === 'countdown'
  return (
    <div
      data-testid="buff-timer-row"
      data-timer-mode={row.mode}
      // The row's own facts as ATTRIBUTES, so a test reads what the model decided rather than
      // re-deriving it from rendered text: the name span also carries the ~ chip, the count and
      // the caster, and the target is a chip here but a block heading in the other arrangement.
      data-spell={row.name}
      data-target={row.target ?? ''}
      title={row.candidates ? `Shared landing message - one of: ${row.candidates.join(', ')}` : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '3px 4px 4px',
        borderLeft: `2px solid ${accent}`,
        marginBottom: 3
      }}
    >
      {/* ONE ROW, never wrapping: a wrap turns overflow into height and a compact bar list is
          the whole point. The name group shrinks and ellipsizes (world-supplied text); the time
          never does. */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'nowrap', minWidth: 0 }}>
        <span
          data-testid="buff-timer-name"
          style={{
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 11,
            color: '#f2f2f2'
          }}
        >
          {row.name}
          {/* The ~ chip is this repo's existing spelling of "ambiguous" (AGENTS.md UI
              conventions). It appears when the landing sentence is shared by several spells and
              nothing the player cast narrowed it — JOS-84's law, on screen. */}
          {row.ambiguous === true && (
            <span data-testid="buff-timer-ambiguous" style={{ color: 'rgba(255,255,255,0.45)', marginLeft: 4 }}>
              ~
            </span>
          )}
          {/* THE COUNT CHIP (JOS-140 ruling 7). EQ prints no instance identifier and stamps to the
              second, so five mobs of one name mezzed in one round are five identical lines: this
              row stands for all of them, and the chip is how it says so instead of pretending to
              be one. The clock is the OLDEST of them, which is the one the next wear-off closes. */}
          {row.count != null && row.count > 1 && (
            <span data-testid="buff-timer-count" style={{ color: 'rgba(255,255,255,0.55)', marginLeft: 4 }}>
              {`x${row.count}`}
            </span>
          )}
          {/* Whose spell this is, when it is not yours (the externals allowlist). Absent for your
              own, which is nearly every row — a caster chip on all of them would be noise. */}
          {row.caster != null && (
            <span data-testid="buff-timer-caster" style={{ color: 'rgba(255,255,255,0.4)', marginLeft: 4 }}>
              {row.caster}
            </span>
          )}
          {showTarget && row.target != null && (
            <span data-testid="buff-timer-target" style={{ color: 'rgba(255,255,255,0.45)', marginLeft: 6 }}>
              {row.target}
            </span>
          )}
        </span>
        <span
          data-testid="buff-timer-time"
          style={{
            flexShrink: 0,
            fontSize: 11,
            fontVariantNumeric: 'tabular-nums',
            color: r.overdue ? 'rgba(255,255,255,0.4)' : accent
          }}
        >
          {timeLabel(row, nowMs)}
        </span>
      </div>

      {/* THE BAR, and only when a duration was STATED. Its absence on a count-up row is
          deliberate and is the honest half of this design. */}
      {countdown && (
        <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
          <div
            data-testid="buff-timer-fill"
            style={{ width: `${(r.fraction * 100).toFixed(1)}%`, height: '100%', background: accent }}
          />
        </div>
      )}
    </div>
  )
}

/** One target's block: the entity's name, then its rows. Self rows use `Your buffs`. */
export function BuffTimerGroup({
  label,
  inferred,
  rows,
  nowMs
}: {
  label: string
  inferred: boolean
  rows: BuffTimerRow[]
  nowMs: number
}): JSX.Element {
  return (
    <div data-testid="buff-timer-group" style={{ marginBottom: 6 }}>
      {/* NO HEADING when there is no label — the flat soonest-first arrangement (JOS-140) is one
          block covering every target, and a heading over the whole list would name nothing. */}
      {label !== '' && (
        <div
          style={{
            fontSize: 9,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.45)',
            padding: '0 4px 2px'
          }}
        >
          {label}
          {/* `inferred` is not decoration: the model marks a target it INFERRED rather than read
              out of a sentence, and law 1 says an inference is labelled, never silently shown. */}
          {inferred && <span style={{ marginLeft: 4, opacity: 0.8 }}>· inferred</span>}
        </div>
      )}
      {rows.map((r) => (
        <BuffTimerBar key={r.id} row={r} nowMs={nowMs} showTarget={label === ''} />
      ))}
    </div>
  )
}
