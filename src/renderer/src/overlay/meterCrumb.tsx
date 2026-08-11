// THE METER'S CRUMB ROW — the one line above an overlay meter's bars, on every meter kind.
//
// It carries TWO things, and it is the only place either of them lives (owner ruling, 2026-08-05
// — JOS-35):
//
//   THE WAY OUT. A back chevron whenever there is a level to go back TO — damage-fight,
//   damage-overall, heal-fight and heal-overall alike. It used to be four hand-rolled crumbs with
//   four different opinions: healBars offered Back unconditionally at level 2, while meterBars
//   withheld it whenever the drilled subject happened to be the level the meter had opened on
//   (`canLeave`, added in 9d5df44) — which, with the pet preference on, was ALWAYS. Two of the
//   four kinds could not be zoomed out at all. One component, one rule, no per-kind opinions.
//
//   THE FIGHT TIMER. It moved DOWN here out of the header, which now states the subject and the
//   rate and nothing else — a 380px-wide header holding a live dot, a kind tag, a scope chip, a
//   name, a chevron, a clock, a rate and two icon buttons had no room left for the one thing it
//   is for (the fight's NAME). The clock is the same `SegmentView.durationSec` it always was,
//   printed by the same `fmtDur`; it just sits on a line with room for it.
//
//   THE AGGREGATE (JOS-158, owner direction 2026-08-09 with a screenshot). The rate followed the
//   clock down out of the title bar, for the same reason and one more. The reason: a title bar
//   whose one job is a mob name was still handing ~55px of itself to a number. The one more: up
//   there the number was UNLABELLED, sitting a few pixels from a fight name and a few rows above
//   a bar reading `5.2k dps` that means something else entirely. Here it can say what it is.
//
//   SO IT IS LABELLED, AND THE LABEL IS THE HONEST ONE. `all` — every source the engine attributed
//   outgoing damage (or healing) to in this segment: you, your pets, your group, whoever swung.
//   It is the SAME `SegmentView.outDps` / `HealingView.hps` the header printed, moved and not
//   recomputed, which means it is deliberately NOT re-scoped by the meter's Whose-damage
//   preference the way the bars below it are. That gap is exactly what the word is for: a
//   You-scoped meter showing one bar and an `all` figure larger than it is telling the truth, and
//   the panel floor is already saying which scope the bars are under (overlay/scopeFloor.tsx).
//
//   AND IT IS VISUALLY DISTINCT FROM THE PERSONAL FIGURE, which is the other half of the ruling:
//   it wears the meter's ACCENT at full weight on the chrome row, while every bar's own number is
//   plain white inside a bar. Colour, weight, position and a word — four differences, so `all
//   21.7k dps` on the crumb and `5.2k dps · 300k` on your bar can never be read as the same claim.
//
// LOCKED MODE passes `onBack: null` — the same row renders, with no chevron, no pointer and no
// hit target, because a click-through window may not offer an affordance it cannot deliver. The
// aggregate is NOT chrome and does not vanish with the lock (the scopeFloor.tsx rule): a pinned
// meter is precisely the one with no header tail, no selector and no tooltip left to state it.
//
// ONE COMPONENT, FOUR KINDS (the JOS-119 no-fork rule). damage-fight, damage-overall, heal-fight
// and heal-overall all render this row, so the label, the layout and the treatment are one
// decision. What each meter supplies is only its own already-formatted number and accent — dps
// and hps are different units and `lib/formatRate` is the one place either is spelled.
//
// MUI-FREE ON PURPOSE: the overlay is its own renderer entry (overlay.html) with no theme and no
// component library. Plain React + inline styles, like every file in this bundle.

import type { JSX, ReactNode } from 'react'

/**
 * ONE WORD, ALL FOUR METERS. Exported so the tests can pin the label rather than re-type it, and
 * so neither meter can grow a second opinion about what the number covers.
 */
export const TOTAL_LABEL = 'all'

/** The aggregate this meter is showing, as the crumb row needs it. */
export interface CrumbTotal {
  /** already through `lib/formatRate` — `21.7k dps` for damage, `1.2k hps` for healing. */
  text: string
  /** the meter's own accent (damage gold / heal green), so it reads as the headline figure. */
  accent: string
  /**
   * ONE CLAUSE, on a span that is not a control (AGENTS.md tooltip diet). The healing meter's
   * restored/absorbed split lives here — it used to hang off the header tail this replaced, and
   * dropping it in a layout move would have been a quiet loss of an honesty note.
   */
  title?: string
}

export function MeterCrumb({
  name,
  dur,
  total,
  onBack,
  children
}: {
  /** the drilled subject, or null at level 1 — there is no subject and nowhere to go back to. */
  name: string | null
  /** the selected segment's length, already formatted (`3:33`). */
  dur: string
  /** the segment's aggregate rate; null while there is no segment to state one for. */
  total?: CrumbTotal | null
  /** null ⇒ locked, or already at the outermost level: the row renders inert. */
  onBack: (() => void) | null
  children: ReactNode
}): JSX.Element {
  return (
    <div>
      <div
        data-testid="overlay-crumb"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: 'rgba(255,255,255,0.7)',
          marginBottom: 3
        }}
      >
        {/* THE WAY OUT, and now its own element rather than the whole row: the aggregate beside it
            carries a hover note, and a note on a click target is the one thing the tooltip rule
            forbids. It still GROWS to fill everything the two right-hand items leave, so the
            reachable back area is what it always was minus the number's own width. */}
        <div
          onClick={onBack ?? undefined}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            flexGrow: 1,
            minWidth: 0,
            cursor: onBack ? 'pointer' : 'default'
          }}
        >
          {name !== null && (
            <>
              <span style={{ fontSize: 13 }} title={onBack ? 'Back' : undefined}>
                {onBack ? '‹' : '·'}
              </span>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
            </>
          )}
        </div>

        {total && (
          <span
            data-testid="overlay-total"
            title={total.title}
            style={{ display: 'flex', alignItems: 'baseline', gap: 3, flexShrink: 0 }}
          >
            <span
              style={{
                fontSize: 8,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
                color: 'rgba(255,255,255,0.4)'
              }}
            >
              {TOTAL_LABEL}
            </span>
            <span
              data-testid="overlay-total-value"
              style={{ color: total.accent, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
            >
              {total.text}
            </span>
          </span>
        )}

        {/* Hard right, and the last thing on the line, so the subject keeps the width it needs
            and the clock always sits in the same place whichever level you are on. */}
        <span
          style={{
            flexShrink: 0,
            color: 'rgba(255,255,255,0.5)',
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {dur}
        </span>
      </div>
      {children}
    </div>
  )
}
