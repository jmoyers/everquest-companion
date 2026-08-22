// ScopeBar — WHICH STRETCH, WHICH TIERS OF IT, AND PER HOUR OF WHAT (JOS-288, JOS-291, JOS-301).
//
// The halves of one sentence, composed in one place so a surface cannot mount part of it. The
// SLICE (`SliceBar`, JOS-130) says which stretch of play the numbers are about; the ZONE SCOPE
// (`ZoneScopeBar`, JOS-291) says which tiers of the camp that stretch admits; the BASIS
// (`RateBasisBar`) says which of the two honest denominators its rates are divided by. They are
// separate CONTROLS on purpose — a reader does not choose between `Session` and `active` — and one
// COMPONENT on purpose, because every exp surface needs them and a page carrying only the first
// would show rates over an hour it never named.
//
// THE MIDDLE ONE IS CONDITIONAL, and that is the only asymmetry: a membership is meaningless on a
// slice with no zone in it, so it is drawn exactly while the slice carries one (`ZoneScopeBar`'s
// header states the whole rule). The other two always apply.
//
// IT IS NOT THE LOOT LEDGER'S CONTROL. That tab mounts `SliceBar` alone: its rate line prints BOTH
// readings side by side (JOS-261) precisely so neither can pass for the other, and a toggle there
// would replace a complete answer with half of one. The ledger still FOLLOWS the memberships
// chosen here, because the pick is app-wide and its caption names what it admitted — the same
// arrangement the slice pick itself has had since JOS-130.
//
// ONE ROW OF CONTROLS, ONE LINE THAT DESCRIBES THEM (JOS-301, owner feedback 2026-08-13 with a
// screenshot of the Leveling tab: *unbalanced*). Each control used to arrive as its own little bar
// carrying its own caption, so the scope stacked THREE rows — buttons+words, buttons, buttons+words
// — and read as three unrelated toolbars rather than one sentence with three knobs in it. It is one
// scope, so it is one row: every button on the same level, and every word about them on the ONE
// line underneath, joined by the middle dot this app already punctuates a caption's clauses with.
// The controls did not merge (they are still three separate picks for the reasons above) and the
// words did not change — only where each is drawn.
//
// THE ROW WRAPS, AND THAT IS THE DEGRADATION IT IS ALLOWED. `flexWrap` converts overflow into
// HEIGHT, which the compact-bar contract refuses for a bar that must stay one line — but this row
// is not that bar: it is the whole scope, its narrow end is the app's own 900px minimum, and a
// wrapped GROUP (whole toggle groups moving down together, never a group torn in half) is a far
// better answer than a horizontal scrollbar under the charts. The CAPTION keeps the contract:
// `noWrap`, one line, ellipsized rather than grown, because it is the line that describes the row
// and a second line of it would put the imbalance straight back.

import { type JSX } from 'react'
import { Stack, Typography } from '@mui/material'
import type { SliceId, SliceRange, Timeslice } from '@shared/timeslice'
import { RateBasisCaption, RateBasisControls } from './RateBasisBar'
import { SliceCaption, SliceControls } from './SliceBar'
import { ZoneScopeBar } from './ZoneScopeBar'

export interface ScopeBarProps {
  available: readonly SliceId[]
  slice: Timeslice
  onPick: (id: SliceId) => void
  onCustom: (range: SliceRange) => void
  /** THE RAW custom pick (`TimesliceState.custom`), passed straight through to `SliceControls` so
   *  the two datetime fields show what was typed rather than what the record clamped it to
   *  (JOS-436 — `SliceBar.CustomRange` carries the argument). It travels here for the same reason
   *  the buttons do: this is the SAME control as the Loot ledger's, and one of them displaying a
   *  different range than the other is two controls wearing one design. */
  custom?: SliceRange | null
  /** Prefix for the controls' testids: `<prefix>-slice…`, `<prefix>-tier…`, `<prefix>-basis…`. */
  testId: string
}

export function ScopeBar({ available, slice, onPick, onCustom, custom, testId }: ScopeBarProps): JSX.Element {
  return (
    <Stack spacing={0.75} sx={{ minWidth: 0 }}>
      {/* THE ROW. One `columnGap` and one `rowGap` for all three, so a wrapped row is spaced like
          the row it wrapped out of rather than by whichever group happens to sit at the seam. */}
      <Stack
        direction="row"
        alignItems="center"
        useFlexGap
        sx={{ flexWrap: 'wrap', columnGap: 1.5, rowGap: 1 }}
      >
        <SliceControls
          available={available}
          slice={slice}
          onPick={onPick}
          onCustom={onCustom}
          custom={custom}
          testId={`${testId}-slice`}
        />
        {slice.zoneKey !== null && <ZoneScopeBar testId={`${testId}-tier`} />}
        <RateBasisControls testId={`${testId}-basis`} />
      </Stack>
      {/* THE LINE. Both clauses keep their own testid — they are separately asserted facts, and
          each is still written where its logic lives (`SliceCaption`, `RateBasisCaption`); this
          places them, it does not restate them. */}
      <Typography
        variant="caption"
        color="text.secondary"
        noWrap
        sx={{ minWidth: 0 }}
        data-testid={`${testId}-scope-caption`}
      >
        <SliceCaption slice={slice} testId={`${testId}-slice`} />
        {' · '}
        <RateBasisCaption testId={`${testId}-basis`} />
      </Typography>
    </Stack>
  )
}
