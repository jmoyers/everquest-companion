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
import { turnInBadgeLabel, type DerivedEvidence } from '@shared/questTurnIns'
import type { QuestProgress } from './useProgress'

/**
 * WHAT EACH DERIVED SOURCE SAYS FOR ITSELF (JOS-429). One sentence per rung of the ladder, in the
 * badge's own voice: what we concluded, and what the evidence for it was. A reader who cannot tell
 * "the game says so" from "we worked it out from your bag" cannot tell which rows to trust — the
 * classUnlocks.ts rule, which is also why the two sentences are visibly different claims rather
 * than one wording with a noun swapped.
 *
 * TOTAL over `DerivedEvidence` on purpose: a source added to the ladder is a compile error here
 * until somebody writes the sentence that explains it to a player.
 */
const EVIDENCE_HOVER: Record<DerivedEvidence, string> = {
  achievement:
    'Turned in at least once: your achievements export marks this quest’s reward as obtained, which only completing the quest can do.',
  reward:
    'Turned in at least once: the reward for this quest is in your inventory export, and it cannot be obtained any other way.',
  'class-unlock':
    'NOT counted as a turn-in. Your achievements export marks this quest’s reward as obtained, but it marks every reward of this class that way: the class unlock was granted (you confirmed the class, or spent a Primary Class Unlock Token) and the game completed its parts for you. Record a turn-in yourself if you did run it.'
}

/**
 * WHAT THE BADGE SAYS, PER RUNG (JOS-441) — the owner ruling that derived completion must read
 * VISIBLY different from an observed turn-in, at BADGE level rather than only on hover.
 *
 * A ledger turn-in keeps the plain green `Turned in` it has always had. A derived one keeps the
 * word — it is still the claim being made — and NAMES ITS SOURCE in the label, in `info` blue so the
 * difference survives a glance down a list of forty rows without anybody hovering anything. The
 * non-flooring rung says only what it is, in the neutral default colour, because it is not claiming
 * a turn-in at all.
 *
 * TOTAL over `DerivedEvidence`, like the two tables around it: a rung added to the ladder is a
 * compile error here until somebody decides how it looks and what it is called.
 */
const EVIDENCE_BADGE: Record<DerivedEvidence, { label: string; color: 'info' | 'default' }> = {
  achievement: { label: 'Turned in · achievements', color: 'info' },
  reward: { label: 'Turned in · reward held', color: 'info' },
  'class-unlock': { label: 'Class unlock', color: 'default' }
}

/** Why the undo control is dead on a derived row — the same claims, answering a different question. */
const EVIDENCE_UNDO: Record<DerivedEvidence, string> = {
  achievement: 'This count comes from your achievements export, so it cannot be taken back here',
  reward:
    'This count comes from the reward in your inventory export, so it cannot be taken back here',
  // Unreachable while a class-unlock row has no count to take back, and written anyway because the
  // table is total and a silently wrong sentence is worse than an unused right one.
  'class-unlock': 'Nothing to take back - this quest is not counted as turned in'
}

/**
 * THE TURN-IN BADGE: whether you have handed this quest in, and how many times.
 *
 * It renders nothing at zero — an absent badge is how "never turned in" reads, and a chip saying
 * so would be noise on most of the list. The count appears from the second turn-in on
 * (`turnInBadgeLabel`), so the common case stays the plain "Turned in" it has always been.
 * `data-count` states the number a test can read without parsing the label.
 *
 * `evidence` is the DERIVED reading (issue #27, extended by JOS-429 and JOS-441) — something other
 * than a logged or stated turn-in speaks for this row — and since JOS-441 the badge itself says
 * WHICH thing, in its label and its colour, rather than keeping the difference in a hover nobody
 * opens. Three v1.7.0 reporters read a derived completion as an observed one because the two were
 * the same green chip; that is the ruling this implements.
 *
 * IT ALSO RENDERS WITH A COUNT OF ZERO NOW, for exactly one case: the `'class-unlock'` rung, which
 * speaks for the row without flooring it. That chip carries its own testid (`posky-class-unlock`)
 * rather than sharing `posky-turned-in`, because every selector in the app and the e2e suite reads
 * that testid as "this row says turned in" and this chip says the opposite.
 *
 * `data-inferred` is unchanged and still means "this reading is derived", so every existing test
 * that asks the one-bit question keeps its answer; `data-evidence` names the rung.
 */
export function TurnInBadge({
  count,
  evidence
}: {
  count: number
  evidence?: DerivedEvidence
}): JSX.Element | null {
  const derived = evidence === undefined ? null : EVIDENCE_BADGE[evidence]
  if (count <= 0 && derived === null) return null
  return (
    <Chip
      size="small"
      color={derived?.color ?? 'success'}
      variant="outlined"
      data-testid={count > 0 ? 'posky-turned-in' : 'posky-class-unlock'}
      data-count={count}
      data-inferred={evidence ? 'true' : undefined}
      data-evidence={evidence}
      title={
        evidence
          ? EVIDENCE_HOVER[evidence]
          : count > 1
            ? `Turned in ${String(count)} times. Each turn-in spends the items it required, so the progress beside this is what you hold toward doing it again.`
            : 'Turned in once. The items it required were spent, so the progress beside this is what you hold toward doing it again.'
      }
      label={derived === null ? turnInBadgeLabel(count) : derived.label}
    />
  )
}

/** The undo button, with the one thing it has to say for itself when it cannot act. */
function UndoTurnIn({ q, onUndo }: { q: QuestProgress; onUndo: () => void }): JSX.Element {
  // A DERIVED count (issue #27, any rung of JOS-429's ladder) cannot be taken back for the same
  // reason a log-detected one cannot: the evidence would simply re-assert it on the next read.
  const canUndo = q.completionEvidence === undefined && q.turnIns > q.logTurnIns
  return (
    // The span outlives the tooltip that needed it, for the same reason: a DISABLED button
    // swallows no mouse events, and "why is this dead" is exactly the question the words answer.
    <span
      title={
        canUndo
          ? 'Take back the most recent turn-in you recorded by hand'
          : q.completionEvidence !== undefined
            ? EVIDENCE_UNDO[q.completionEvidence]
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
