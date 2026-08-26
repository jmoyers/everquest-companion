import { type JSX, useMemo } from 'react'
import { Box, Chip, IconButton, LinearProgress, Stack, Typography } from '@mui/material'
import StarIcon from '@mui/icons-material/Star'
import StarBorderIcon from '@mui/icons-material/StarBorder'
import type { ClassUnlockSnap } from '@shared/types'
import { useModule } from '../../lib/useModule'
import { useClassFavorites } from '../favorites/useQuestFlags'
import { classUnlockRows, orderClassUnlockRows, type ClassUnlockRow } from './classUnlocks'
import type { QuestProgress } from './useProgress'

// The Classes tab (JOS-148): one row per class, N of M Sky tests turned in, closest to done
// first, starred classes pinned above that. classUnlocks.ts owns every rule; this file draws it.
//
// The tab exists because the Sky class tests are how a class becomes available as a primary — but
// only PARTLY, which is the fact this rendering is built around. See classUnlocks.ts for the
// measurement; the consequence on screen is that a row NEVER shows a bare verdict. It shows the
// turn-in count, which is always a true sentence, and then says where the unlock reading came
// from, so nothing here can quietly present a wiki claim as an observation.

const EMPTY: ClassUnlockSnap = []

/**
 * What a row's unlock state reads as, and the one clause of why. The `source` is IN THE TEXT
 * rather than in a hover, because the house rule is that a control carries no tooltip and because
 * a caveat nobody opens is a caveat nobody has.
 */
function unlockLabel(row: ClassUnlockRow): { text: string; color: 'success' | 'default' } {
  if (row.source === 'observed') return { text: 'Unlocked, the log said so', color: 'success' }
  if (row.source === 'derived') return { text: 'Every test turned in', color: 'success' }
  return { text: `${row.remaining} test${row.remaining === 1 ? '' : 's'} left`, color: 'default' }
}

/**
 * The class star. Its own button rather than the quest one (QuestStarButton) for two reasons: the
 * quest star's copy states a limit that does not apply here (JOS-146 stops a pin overriding the
 * most-recently-looted order, and this tab has no such order), and this one carries NO TOOLTIP.
 * What it does is said once in the line above the list instead, where it is readable without a
 * hover — the house rule about controls, honoured by not adding a popper rather than by tuning one.
 *
 * SINCE JOS-157 THE ROW AROUND IT NAVIGATES, so this button stops the click travelling. A star that
 * also opened the Quests tab would make pinning a class impossible without leaving the tab you
 * pinned it on — the star's whole job is to change THIS list's order, which you have to stay here
 * to see. Same for the keyboard: Enter and Space on the star are the star's, not the row's.
 */
function ClassStarButton({
  starred,
  className,
  onToggle
}: {
  starred: boolean
  className: string
  onToggle: () => void
}): JSX.Element {
  return (
    <IconButton
      size="small"
      aria-label={starred ? `Unpin ${className}` : `Pin ${className} to the top`}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
      }}
      sx={{ color: starred ? 'warning.main' : 'text.disabled', p: 0.25 }}
    >
      {starred ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
    </IconButton>
  )
}

/**
 * A class row, and since JOS-157 A DOOR TO ITS QUESTS: clicking anywhere on it but the star opens
 * the Quests tab filtered to exactly this class.
 *
 * THE WHOLE ROW IS THE TARGET rather than a link on the class name, because the row already reads
 * as one object — the name, the count, the bar and the verdict are four views of a single class —
 * and a click anywhere on it can only mean that class. It is a `role="button"` with a tab stop and
 * Enter/Space instead of a real `<button>` so the star can keep being a button in its own right;
 * nesting one button inside another is invalid, and the star's independence is the requirement.
 *
 * NO TOOLTIP SAYS SO (the standing house rule for controls, JOS-143). What a click does is stated
 * once in SourceNote below, in the same line that already explains the ordering and the star.
 */
function ClassRow({
  row,
  starred,
  onToggleStar,
  onOpen
}: {
  row: ClassUnlockRow
  starred: boolean
  onToggleStar: () => void
  onOpen: () => void
}): JSX.Element {
  const label = unlockLabel(row)
  const pct = row.total === 0 ? 0 : (row.turnedIn / row.total) * 100
  return (
    <Stack
      direction="row"
      spacing={2}
      alignItems="center"
      role="button"
      tabIndex={0}
      aria-label={`Show the ${row.className} quests`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        // Space scrolls the pane otherwise, and this row is inside a scrolling list.
        e.preventDefault()
        onOpen()
      }}
      data-testid={`class-unlock-row-${row.className.replace(/\s+/g, '-').toLowerCase()}`}
      // The row's own numbers as ATTRIBUTES, the turn-in badge's `data-count` convention. A test
      // reading them off the rendered SENTENCE has to parse "0 of 44 tests left" and gets `0 of 44`
      // — it did, on the first run of the e2e below — because two independent numbers sit adjacent
      // with no separator a regex can trust. These are the same values the sentence is built from,
      // published once so the assertion and the reader are looking at the same thing.
      // The class's own spelling, published for the same reason the numbers are: the testid is
      // lowercased and hyphenated, and the JOS-157 drill-down has to assert the EXACT string that
      // reaches the class filter and its stored key.
      data-class={row.className}
      data-turned-in={row.turnedIn}
      data-total={row.total}
      data-remaining={row.remaining}
      data-source={row.source ?? ''}
      sx={{
        px: 1,
        py: 0.75,
        borderRadius: 1,
        cursor: 'pointer',
        '&:hover': { bgcolor: 'action.hover' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
      }}
    >
      <ClassStarButton starred={starred} className={row.className} onToggle={onToggleStar} />
      <Typography variant="subtitle2" sx={{ minWidth: 130 }}>
        {row.className}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 64 }}>
        {row.turnedIn} of {row.total}
      </Typography>
      <Box sx={{ flexGrow: 1, minWidth: 80 }}>
        <LinearProgress
          variant="determinate"
          value={pct}
          color={row.unlocked ? 'success' : 'primary'}
          sx={{ height: 6, borderRadius: 3 }}
        />
      </Box>
      <Chip
        label={label.text}
        size="small"
        color={label.color}
        variant={row.unlocked ? 'filled' : 'outlined'}
        sx={{ minWidth: 168 }}
      />
    </Stack>
  )
}

/**
 * The one caveat this tab owes the reader, stated once at the top rather than sixteen times in
 * sixteen hovers. It is the honest limit of the derived source, and it is short because the long
 * version is in classUnlocks.ts where the rule lives.
 */
function SourceNote({ rows }: { rows: readonly ClassUnlockRow[] }): JSX.Element {
  const observed = rows.filter((r) => r.source === 'observed').length
  const derived = rows.filter((r) => r.source === 'derived').length
  return (
    <Typography variant="body2" color="text.secondary" data-testid="class-unlock-note">
      Fewest tests left first. Click a class to see its quests. Star a class to pin it to the top.{' '}
      {observed} unlocked by a line in your log, {derived} read from a complete set of turn-ins.
      Turning in a Sky test prints
      nothing about unlocking, so a complete set is our reading and not the game saying so; a class
      can also unlock at level 11 or from a token, which is why a logged unlock outranks the count.
    </Typography>
  )
}

export default function ClassUnlockList({
  quests,
  onOpenClass
}: {
  quests: QuestProgress[]
  /** a class name → the Quests tab filtered to it (JOS-157). PoskyView hands this to the list. */
  onOpenClass: (className: string) => void
}): JSX.Element {
  const observed = useModule<ClassUnlockSnap>('classUnlocks') ?? EMPTY
  const stars = useClassFavorites()

  const rows = useMemo(
    () =>
      orderClassUnlockRows(classUnlockRows(quests, observed), (r) =>
        stars.has(r.className) ? 1 : 0
      ),
    [quests, observed, stars]
  )

  if (rows.length === 0) {
    return (
      <Typography color="text.secondary">
        No Plane of Sky data available, so there are no classes to track.
      </Typography>
    )
  }

  return (
    <Box
      data-testid="posky-classes"
      sx={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 1 }}
    >
      <SourceNote rows={rows} />
      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        <Stack spacing={0.25}>
          {rows.map((r) => (
            <ClassRow
              key={r.className}
              row={r}
              starred={stars.has(r.className)}
              onToggleStar={() => stars.toggle(r.className)}
              onOpen={() => onOpenClass(r.className)}
            />
          ))}
        </Stack>
      </Box>
    </Box>
  )
}
