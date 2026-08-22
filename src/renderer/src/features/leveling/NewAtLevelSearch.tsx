// THE SEARCH HALF of the "New at this level" panel (JOS-392) — the box, and what the panel becomes
// while there is something in it.
//
// ITS OWN FILE BECAUSE THE PANEL WAS ALREADY FULL. AGENTS.md's 400-line ceiling is split, never
// ratcheted, and the panel next door owns three things already (the stepper, the deep link's
// arrival, the loadout chips). This file owns two: the field, and the results body.
//
// WHAT THE BOX ANSWERS, and why it is not a second search implementation: the grammar is
// `shared/spellSearch.ts`, the same tokenizer the alerts wizard types into, extended by JOS-392 to
// read a class word and a `27-28` band as bare tokens in any order. The projection is
// `shared/unlockSearch.ts`. Both are pure and node-tested; this file draws what they return.
//
// AND IT ASKS MAIN NOTHING PER KEYSTROKE. The whole unlock dataset (every spell the DB places, with
// the figures and the line research already joined) is pulled ONCE per renderer session and cached
// by `useLevelUnlocks`; the filter runs here, over ~1,450 rows, on a memo keyed by the query.

import { type JSX } from 'react'
import { Box, IconButton, InputAdornment, Stack, TextField, Typography } from '@mui/material'
import ClearIcon from '@mui/icons-material/Clear'
import SearchIcon from '@mui/icons-material/Search'
import type { SpellSetsSnap } from '@shared/spellSets'
import type { ObservedSpellRanksSnap } from '@shared/spellRanks'
import type { UnlockSearchResults } from '@shared/unlockSearch'
import { UnlockList } from './UnlockList'

/** The one example in the placeholder is the owner's own query, spelled the way he typed it. */
const PLACEHOLDER = 'Search spells: name, class, level or range (27-28 cleric shaman)'

/** The box. Controlled by the panel, because the panel is what switches body on the same state. */
export function UnlockSearchField({
  query,
  onChange
}: {
  query: string
  onChange: (q: string) => void
}): JSX.Element {
  return (
    <TextField
      size="small"
      value={query}
      onChange={(e) => onChange(e.target.value)}
      placeholder={PLACEHOLDER}
      sx={{ width: '100%', maxWidth: 380, mb: 0.75, '& .MuiInputBase-input': { fontSize: 12, py: 0.5 } }}
      slotProps={{
        htmlInput: { 'data-testid': 'new-at-level-search', 'aria-label': 'search spells' },
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon sx={{ fontSize: 15, color: 'text.disabled' }} />
            </InputAdornment>
          ),
          endAdornment:
            query === '' ? undefined : (
              <InputAdornment position="end">
                <IconButton
                  size="small"
                  aria-label="clear search"
                  data-testid="new-at-level-search-clear"
                  onClick={() => onChange('')}
                >
                  <ClearIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </InputAdornment>
            )
        }
      }}
    />
  )
}

/**
 * The results body — the SAME row component the level lists use, over the matching spells.
 *
 * The cap line is a statement rather than a paginator: this panel is a place to look something up,
 * and a query with 400 answers is a query to narrow. It says the number it is not showing, which is
 * the difference between a cap and a lie by omission.
 */
export function UnlockSearchResultsList({
  results,
  resolved,
  sets,
  ranks
}: {
  results: UnlockSearchResults
  resolved: ReadonlySet<string>
  sets: SpellSetsSnap
  /** The observed spell ranks (JOS-446), null before hydration. Passed straight through. */
  ranks: ObservedSpellRanksSnap | null
}): JSX.Element {
  return (
    <Stack spacing={0.25} data-testid="new-at-level-results">
      <UnlockList
        title="Matching spells"
        rows={results.rows}
        count={results.matched}
        resolved={resolved}
        sets={sets}
        ranks={ranks}
        empty="no spell in the wiki DB matches that - try a name, a class, a level or a range"
      />
      {results.hidden > 0 && (
        <Box>
          <Typography variant="caption" color="text.disabled" data-testid="new-at-level-more" sx={{ fontSize: 10.5 }}>
            +{results.hidden} more, refine your search
          </Typography>
        </Box>
      )}
    </Stack>
  )
}
