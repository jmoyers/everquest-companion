// ClassComboPanel — the class-loadout history and its correction surface (Preferences →
// Profiles). `profiles/` is the right neighbourhood: it already owns "who is this character"
// concerns, whereas `leveling/` owns a chart pinned by a golden window.
//
// WHAT IT SHOWS. Two things, in the order a user needs them (JOS-87 put them in this order —
// before it, the panel opened with a passive "Now" line and the only way to fix a wrong loadout
// was to find its row in the history and press Edit):
//   1. LoadoutOverride — what is in effect right now, where it came from, and the two buttons
//      that set it by hand or hand it back to autodetection.
//   2. the history — every interval the combo module believes in, NEWEST FIRST, in a
//      fixed-height scroll box (a growing list lives in a bounded box — AGENTS.md; the list
//      grows one row per detected swap and must never push the settings page taller). Each row
//      states the span, the slots as chips, where the belief came from, how confident it is,
//      and — when the boundary is fuzzy — a '~' whose tooltip gives the WINDOW and the detector.
//
// WHAT IT NEVER DOES. It does not explain the algorithm, and it does not smooth. A 33.9-hour
// swap window renders as 33.9 hours of not-knowing; a `{CLR,PAL}` slot renders as `CLR|PAL`
// forever rather than resolving to the likelier one.

import { type JSX, useMemo, useState } from 'react'
import { Box, Button, Chip, Paper, Stack, Typography } from '@mui/material'
import EditIcon from '@mui/icons-material/Edit'
import type { ComboInterval } from '@shared/classCombo'
import { useComboSnap } from './ClassComboData'
import { ConfidenceChip, LockedChip, OverruledChip, ProvenanceChip, SlotChips } from './ClassComboChips'
import { levelRangeText, spanText, startFuzzText } from './ClassComboLabels'
import ClassComboEditor from './ClassComboEditor'
import LoadoutOverride from './LoadoutOverride'
import { Tooltip } from '../../lib/Tooltip'

/** Explicit height + its own scroll, per the fixed-height law. Roughly four rows tall. */
const LIST_HEIGHT = 268

/** The '~' marker: the start is a RANGE, and the tooltip says how wide and why. */
function FuzzyMark({ interval }: { interval: ComboInterval }): JSX.Element | null {
  const text = startFuzzText(interval)
  if (!text) return null
  return (
    <Tooltip title={text}>
      <Typography component="span" variant="caption" color="warning.main">
        ~
      </Typography>
    </Tooltip>
  )
}

/** One interval. Everything on this row is a fact about the data, never about the method. */
function IntervalRow({
  interval,
  onEdit
}: {
  interval: ComboInterval
  onEdit: (i: ComboInterval) => void
}): JSX.Element {
  const levels = levelRangeText(interval)
  return (
    <Paper variant="outlined" sx={{ p: 1, mb: 0.75 }} data-testid="combo-interval-row">
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ minWidth: 0 }}>
        <SlotChips slots={interval.slots} />
        <Box sx={{ flexGrow: 1 }} />
        <ProvenanceChip interval={interval} />
        <ConfidenceChip interval={interval} />
        {interval.userLocked && <LockedChip />}
        <OverruledChip interval={interval} />
        <Button
          size="small"
          startIcon={<EditIcon sx={{ fontSize: 14 }} />}
          onClick={() => onEdit(interval)}
          sx={{ minWidth: 0, py: 0, px: 0.75 }}
        >
          Edit
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.25, display: 'block' }}>
        <FuzzyMark interval={interval} /> {spanText(interval)}
        {levels && ` · ${levels}`}
        {interval.evidenceCount > 0 && ` · ${interval.evidenceCount} signals`}
      </Typography>
    </Paper>
  )
}

/**
 * The Preferences → Profiles item. One component, so PreferencesView gains a single entry —
 * the same shape ProfileSharing's two settings take.
 */
export function ClassComboSetting(): JSX.Element {
  const snap = useComboSnap()
  const [editing, setEditing] = useState<ComboInterval | null>(null)
  // NEWEST FIRST: the loadout you care about is the one you are wearing.
  const newestFirst = useMemo(() => [...snap.intervals].reverse(), [snap.intervals])

  return (
    <Stack spacing={1}>
      <LoadoutOverride current={snap.current} />
      {!snap.ready && (
        <Tooltip title="This build ships no class knowledge tables.">
          <Chip size="small" variant="outlined" color="warning" label="class tables unavailable" sx={{ alignSelf: 'flex-start', height: 20 }} />
        </Tooltip>
      )}
      <Box
        data-testid="combo-interval-list"
        sx={{ height: LIST_HEIGHT, overflow: 'auto', pr: 0.5 }}
      >
        {newestFirst.length === 0 ? (
          <Typography variant="caption" color="text.disabled">
            Nothing recorded yet.
          </Typography>
        ) : (
          newestFirst.map((interval) => (
            <IntervalRow key={interval.id} interval={interval} onEdit={setEditing} />
          ))
        )}
      </Box>
      <Typography variant="caption" color="text.secondary">
        Edit any past range you know better - your correction wins over autodetection until a
        /who row says otherwise, and the panel tells you when one does.
      </Typography>
      <ClassComboEditor interval={editing} onClose={() => setEditing(null)} />
    </Stack>
  )
}
