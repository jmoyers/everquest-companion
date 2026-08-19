// PrefStepper — THE ONLY STEPPER ON THE APPEARANCE PAGE (JOS-408).
//
// WHY ONE COMPONENT. The owner's review of the JOS-405 / JOS-407 page: "make the controls uniform -
// the +/- version of the control on the whole page." Before this there were three shapes for four
// values — a five-button ladder for the window, an A− / A+ for the overlays' size, a slider for
// their transparency — so a reader had to work out three interaction models to change four numbers
// that all mean "a bit more" or "a bit less". Now there is one, and every value on the page is a
// minus, a number, and a plus.
//
// THE ONLY DISABLED BUTTONS ON THIS PAGE ARE THE ENDS, and they are disabled for the one reason a
// disabled control is honest: the value cannot move. Everything else the owner's review objected
// to — a live-looking control that does nothing, a tooltip explaining why a control is dead — is
// gone from this section, because a control that is not in force is no longer rendered at all.
//
// THE TWO KINDS DIFFER ONLY IN WHAT THE BUTTONS SAY. `A−` / `A+` is the vocabulary the overlays'
// own footers have used since 2026-08-05 and it belongs on a text size; a bare `−` / `+` belongs on
// a transparency, which is not text. The FRAME is identical on purpose, so the page reads as one
// control repeated rather than as two designs.
//
// IT DOES NOT KNOW WHAT IT IS STEPPING. The caller owns the value, the clamp and the detents
// (`stepUiScale`, `clampTextScale`, `stepBgAlpha` — each in its own shared module beside the range
// it belongs to), and hands this the ANSWER plus the two facts about the ends. That is what keeps
// one component honest across a five-rung ladder, a 0.1 detent and a 5% grid.
//
// ONE BORDER: PreferencesView already wraps each item in an outlined Paper, so this renders bare.

import { type JSX } from 'react'
import { IconButton, Stack, Typography } from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import RemoveIcon from '@mui/icons-material/Remove'

/** What this stepper is stepping — which decides the button faces and how they are spoken. */
export type StepperKind = 'size' | 'transparency'

/**
 * The two words each kind uses, in one table so a button face and its accessible name can never
 * drift apart. The name is completed by `name` — the thing being stepped, spoken: "the overlays",
 * or one window's own label.
 *
 * BOTH KINDS END IN `for`, and that is not a detail: the JOS-408 confusion audit read every
 * accessible name in the section out of the real DOM and caught this one saying "More see-through
 * the overlays". A screen reader announces exactly that string, so a missing preposition is the
 * whole sentence a blind user gets.
 */
const WORDS: Record<StepperKind, { less: string; more: string; lessName: string; moreName: string }> = {
  size: { less: 'A−', more: 'A+', lessName: 'Smaller text for', moreName: 'Larger text for' },
  transparency: {
    less: '−',
    more: '+',
    lessName: 'More see-through for',
    moreName: 'More solid for'
  }
}

/**
 * MINUS · VALUE · PLUS.
 *
 * `atMin` / `atMax` are the CALLER's answer to "can this move", not a range this component knows:
 * the in-app ladder ends at its own five stops, the overlay size at TEXT_SCALE_MIN / MAX, the
 * transparency at the slider's 10 / 100%.
 */
/**
 * The width one stepper occupies: two small icon buttons, the 44px value, and the two gaps between.
 * EXPORTED so a header row above a column of these can size its labels to the same box (the
 * per-overlay list, owner 2026-08-17: "a label along the top of the columns").
 */
export const PREF_STEPPER_W = 112

export function PrefStepper({
  kind,
  value,
  name,
  atMin,
  atMax,
  onStep,
  testid,
  plain = false
}: {
  kind: StepperKind
  /** Already said: "125%". This component never formats a number. */
  value: string
  name: string
  atMin: boolean
  atMax: boolean
  onStep: (dir: 1 | -1) => void
  testid: string
  /**
   * PLAIN − / + FACES FOR BOTH KINDS (owner, 2026-08-17). In the per-overlay list a column header
   * already says which column is text size, so the `A` on the size buttons is a second label for
   * the same thing; the faces go plain and the header does the naming. The accessible names are
   * unchanged either way — a screen reader still hears "Larger text for Fight meter".
   */
  plain?: boolean
}): JSX.Element {
  const words = WORDS[kind]
  const lettered = kind === 'size' && !plain
  return (
    <Stack
      direction="row"
      alignItems="center"
      justifyContent="center"
      spacing={0.5}
      data-testid={testid}
      sx={{ flexShrink: 0, width: PREF_STEPPER_W }}
    >
      <IconButton
        size="small"
        aria-label={`${words.lessName} ${name}`}
        data-testid={`${testid}-minus`}
        disabled={atMin}
        onClick={() => {
          onStep(-1)
        }}
      >
        {lettered ? (
          <Typography variant="caption" sx={{ fontWeight: 700, lineHeight: 1 }}>
            {words.less}
          </Typography>
        ) : (
          <RemoveIcon fontSize="inherit" />
        )}
      </IconButton>
      <Typography
        variant="body2"
        data-testid={`${testid}-value`}
        // A fixed width so a column of these lines up and none of them jumps as it changes.
        sx={{ minWidth: 44, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </Typography>
      <IconButton
        size="small"
        aria-label={`${words.moreName} ${name}`}
        data-testid={`${testid}-plus`}
        disabled={atMax}
        onClick={() => {
          onStep(1)
        }}
      >
        {lettered ? (
          <Typography variant="caption" sx={{ fontWeight: 700, lineHeight: 1 }}>
            {words.more}
          </Typography>
        ) : (
          <AddIcon fontSize="inherit" />
        )}
      </IconButton>
    </Stack>
  )
}
