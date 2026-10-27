// maps/MapZoneAdviceBar — the controls over the "Where to level" table: level, goal, search, fit.
//
// Owner (2026-09-12): *"need filters/search/sort"*. The sort is the table header's; everything
// else is here, in the Gear bar's idiom, so a reader who knows the Gear tab knows this one.
//
// TWO CONTROLS THAT LOOK DIFFERENT BECAUSE THEY BEHAVE DIFFERENTLY. The first cut drew the goal
// and the fit filter as two rows of identical chips, and the owner could not tell that one row was
// exclusive and the other pick-and-choose: *"it was not obvious that on level, a reach, easy,
// deadly were all clickable but the first three are mutually exclusive. Maybe it needs to be a
// drop down selection list like the classes is"*. So the goal is a SELECT - the one-of-N control,
// the Exaltations bar's "Group by" - and the fit filter is the classes picker itself
// (`ChipMultiSelect`), whose empty state says ALL out loud.
//
// THE LEVEL IS A FIELD, SEEDED WITH YOURS. The first cut typed it and started at 20, on the
// argument that half the reason anybody opens this list is to plan for someone ELSE - the level
// you will be next week, the friend, the alt. The owner's first question was why it was not his
// level (2026-09-14). So the view seeds it with the stated level and the field stays editable:
// planning for someone else is one edit away instead of everyone retyping their own number.
// `DEFAULT_QUERY.level` is therefore EMPTY - "nothing stated yet", which the empty-table text
// already explains - and the view, not this bar, is where the seed comes from.

import type { JSX } from 'react'
import { Chip, MenuItem, Stack, TextField, Typography } from '@mui/material'
import ChipMultiSelect from '../../components/ChipMultiSelect'
import { moteGradeCap, type ZoneGoal } from '@shared/zoneAdvice'
import type { ZoneFit } from '@shared/zoneLevels'
import { FIT, FIT_ORDER, GOALS, GOAL_ORDER } from './zoneAdviceUi'

/** Everything the bar edits, as one object so the view holds one state and the bar one prop. */
export interface AdviceQuery {
  /** the level as typed - kept as text so an emptied field is empty rather than NaN */
  level: string
  goal: ZoneGoal
  search: string
  /** the fits kept; empty means every fit the goal admits */
  fits: ReadonlySet<ZoneFit>
  /** only zones EQ Legends has now - the Closest-port card's switch, shared (owner, 2026-09-14) */
  eraOnly: boolean
}

export const DEFAULT_QUERY: AdviceQuery = { level: '', goal: 'exp', search: '', fits: new Set(), eraOnly: true }

const TINY = { height: 18, fontSize: 10, '& .MuiChip-label': { px: 0.6 } } as const

/** The fit picker speaks in the words a row wears; these fold a picked word back to its fit. */
const FIT_WORDS: readonly string[] = FIT_ORDER.map((f) => FIT[f].label)
function fitsFromWords(words: readonly string[]): Set<ZoneFit> {
  const out = new Set<ZoneFit>()
  for (const fit of FIT_ORDER) if (words.includes(FIT[fit].label)) out.add(fit)
  return out
}

export default function MapZoneAdviceBar({
  query,
  onChange,
  count
}: {
  query: AdviceQuery
  onChange: (next: AdviceQuery) => void
  /** rows on screen after every filter, for the count at the right */
  count: number
}): JSX.Element {
  const level = Number.parseInt(query.level, 10)
  const pickedWords: string[] = []
  for (const fit of FIT_ORDER) if (query.fits.has(fit)) pickedWords.push(FIT[fit].label)
  return (
    <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap" sx={{ mb: 1 }}>
      <TextField
        size="small"
        label="Level"
        value={query.level}
        onChange={(e) => {
          onChange({ ...query, level: e.target.value.replace(/\D/g, '').slice(0, 2) })
        }}
        slotProps={{ htmlInput: { 'data-testid': 'zone-advice-level', inputMode: 'numeric' } }}
        sx={{ width: 80 }}
      />
      <TextField
        size="small"
        label="Search zones"
        value={query.search}
        data-testid="zone-advice-search"
        onChange={(e) => {
          onChange({ ...query, search: e.target.value })
        }}
        sx={{ minWidth: 160 }}
      />
      <TextField
        select
        size="small"
        label="Goal"
        value={query.goal}
        title={GOALS[query.goal].hint}
        onChange={(e) => {
          onChange({ ...query, goal: e.target.value as ZoneGoal })
        }}
        slotProps={{ htmlInput: { 'data-testid': 'zone-advice-goal' } }}
        sx={{ minWidth: 150 }}
      >
        {GOAL_ORDER.map((g) => (
          <MenuItem key={g} value={g} title={GOALS[g].hint} data-testid={`zone-advice-goal-${g}`}>
            {GOALS[g].label}
          </MenuItem>
        ))}
      </TextField>
      <ChipMultiSelect
        options={FIT_WORDS}
        value={pickedWords}
        onChange={(words) => {
          onChange({ ...query, fits: fitsFromWords(words) })
        }}
        label="Fit"
        placeholder="all"
        minWidth={170}
      />
      {/* The Closest-port card's switch, same words and same stored key: lifting it here lifts it there. */}
      <Chip
        size="small"
        label="Current era"
        title={query.eraOnly ? 'Only zones EQ Legends has now are listed. Click to lift.' : 'Every zone the bestiary documents is listed, including ones not in the game yet. Click to limit.'}
        data-testid="zone-advice-era"
        color={query.eraOnly ? 'primary' : 'default'}
        variant={query.eraOnly ? 'filled' : 'outlined'}
        onClick={() => {
          onChange({ ...query, eraOnly: !query.eraOnly })
        }}
        sx={TINY}
      />
      {Number.isFinite(level) && level > 0 && query.goal !== 'wish' && (
        <Typography variant="caption" color="text.disabled">
          {`motes cap at grade ${String(moteGradeCap(level))}`}
        </Typography>
      )}
      <Typography variant="caption" color="text.disabled" sx={{ ml: 'auto' }} data-testid="zone-advice-count">
        {`${String(count)} zones`}
      </Typography>
    </Stack>
  )
}
