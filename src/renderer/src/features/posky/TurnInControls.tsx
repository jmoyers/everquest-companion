// posky/TurnInControls.tsx — the two surfaces that speak about TURN-INS (JOS-131).
//
// A Sky turn-in stopped being a terminal flag and became an event with a count: handing a quest
// in spends the items it required, so the progress bar drops back to what you are holding and
// these two controls are the only things that remember you did it. They live in their own file
// because they are read in two places (the quest row and the Ignored list) and because
// QuestAccordion.tsx was at its measured 400-line ceiling.
//
// NO POPPER (JOS-143). The badge sits in the collapsed summary row and the counter in the expanded
// panel's own toolbar, so both are candidates to open a card over the tab's dropdowns; the whole
// Sky tracker is popper-free now rather than file-by-file, which is the only version of the rule a
// guard can hold. Every sentence below survives verbatim as a native `title` — an OS tooltip that
// is not in the DOM and has no hit area, so it cannot intercept a click.

import type { JSX } from 'react'
import { Chip, IconButton, Stack, Typography } from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import RemoveIcon from '@mui/icons-material/Remove'
import { turnInBadgeLabel } from '@shared/questTurnIns'
import type { QuestProgress } from './useProgress'

/**
 * THE TURN-IN BADGE: whether you have handed this quest in, and how many times.
 *
 * It renders nothing at zero — an absent badge is how "never turned in" reads, and a chip saying
 * so would be noise on most of the list. The count appears from the second turn-in on
 * (`turnInBadgeLabel`), so the common case stays the plain "Turned in" it has always been.
 * `data-count` states the number a test can read without parsing the label.
 *
 * `inferred` is the issue-#27 reading — the count exists because the quest's REWARD is in the
 * loaded inventory export, not because a turn-in was logged or stated — and the hover says so,
 * because a reader who cannot tell "the log said so" from "we worked it out" cannot tell which
 * rows to trust (classUnlocks.ts). `data-inferred` states it for a test the same way
 * `data-count` states the number.
 */
export function TurnInBadge({
  count,
  inferred
}: {
  count: number
  inferred?: boolean
}): JSX.Element | null {
  if (count <= 0) return null
  return (
    <Chip
      size="small"
      color="success"
      variant="outlined"
      data-testid="posky-turned-in"
      data-count={count}
      data-inferred={inferred ? 'true' : undefined}
      title={
        inferred
          ? 'Turned in at least once: the reward for this quest is in your inventory export, and it cannot be obtained any other way.'
          : count > 1
            ? `Turned in ${String(count)} times. Each turn-in spends the items it required, so the progress beside this is what you hold toward doing it again.`
            : 'Turned in once. The items it required were spent, so the progress beside this is what you hold toward doing it again.'
      }
      label={turnInBadgeLabel(count)}
    />
  )
}

/** The undo button, with the one thing it has to say for itself when it cannot act. */
function UndoTurnIn({ q, onUndo }: { q: QuestProgress; onUndo: () => void }): JSX.Element {
  // An INFERRED count (issue #27) cannot be taken back for the same reason a log-detected one
  // cannot: the evidence (the reward in your export) would simply re-assert it on the next read.
  const canUndo = !q.rewardInferred && q.turnIns > q.logTurnIns
  return (
    // The span outlives the tooltip that needed it, for the same reason: a DISABLED button
    // swallows no mouse events, and "why is this dead" is exactly the question the words answer.
    <span
      title={
        canUndo
          ? 'Take back the most recent turn-in you recorded by hand'
          : q.rewardInferred
            ? 'This count comes from the reward in your inventory export, so it cannot be taken back here'
            : q.turnIns === 0
              ? 'Nothing to take back'
              : 'This count comes from your log, so it cannot be taken back here'
      }
    >
      <IconButton size="small" data-testid="posky-undo-turnin" disabled={!canUndo} onClick={onUndo}>
        <RemoveIcon fontSize="inherit" />
      </IconButton>
    </span>
  )
}

/**
 * THE MANUAL COUNTER, which replaced a "Turned in / complete" checkbox: a turn-in is an event you
 * can have more than one of, and a checkbox can only ever say "at least one".
 *
 * "+1" records one, dated now. "-1" takes back the most recent turn-in THIS APP DID NOT READ OUT
 * OF THE LOG, and is disabled when there is no such turn-in — the log is evidence, and the next
 * snapshot would simply re-assert whatever the log still says. The hover text says that outright
 * rather than leaving a dead-looking button to be discovered.
 */
export function TurnInCounter({
  q,
  onRecordTurnIn,
  onUndoTurnIn
}: {
  q: QuestProgress
  onRecordTurnIn: () => void
  onUndoTurnIn: () => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <Typography variant="caption" color="text.secondary" data-testid="posky-turnin-count">
        {q.turnIns > 0 ? turnInBadgeLabel(q.turnIns) : 'Not turned in yet'}
      </Typography>
      <UndoTurnIn q={q} onUndo={onUndoTurnIn} />
      <IconButton
        size="small"
        data-testid="posky-record-turnin"
        title="Record another turn-in. The items it required are subtracted, so the quest goes back to what you hold toward running it again."
        onClick={onRecordTurnIn}
      >
        <AddIcon fontSize="inherit" />
      </IconButton>
    </Stack>
  )
}
