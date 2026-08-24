// THE SEARCH HALF of the best-spells readout (JOS-450) — the box, and what the panel draws while
// there is something in it.
//
// ITS OWN FILE for the reason `NewAtLevelSearch.tsx` is one: AGENTS.md's 400-line ceiling is split,
// never ratcheted, and `BestSpellsPanel` already owns the tabs, the stepper, the sorts, the slider
// and the AOE marker. This file owns two things: the field, and the results table.
//
// SAME MATCHER, SAME GRAMMAR, SAME WORDS AS THE PANEL OPPOSITE. The tokenizer is
// `shared/spellSearch.ts` — the one the alerts wizard and the unlock panel type into, so
// `27-28 cleric shaman` means here exactly what it means there — and the projection is
// `shared/bestSpellsSearch.ts`, whose header carries the five decisions about what a result is.
// Nothing about which spells match is decided in this file.
//
// AND IT ASKS MAIN NOTHING PER KEYSTROKE. The whole unlock dataset is already in this window, pulled
// once per renderer session and cached by `useLevelUnlocks`; the fold runs here over ~1,450 rows.
//
// WHY THE RESULTS KEEP THE TABLE'S HEADERS. A result is a row of THIS readout, which is the whole
// feature: the owner wants to hold a druid heal beside his own and read one column down. So the
// headers are the same sortable ones, the sort is the tab's own, and pressing a header re-ranks the
// results exactly as it re-ranks the table they replaced.

import { type JSX } from 'react'
import {
  Box,
  Chip,
  IconButton,
  InputAdornment,
  Stack,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TextField,
  Typography
} from '@mui/material'
import ClearIcon from '@mui/icons-material/Clear'
import SearchIcon from '@mui/icons-material/Search'
import {
  TAB_LABEL,
  type BestSpellColumn,
  type BestSpellSort,
  type BestSpellTab
} from '@shared/bestSpells'
import { elsewhereLabel, type BestSpellSearchResults } from '@shared/bestSpellsSearch'
import type { ObservedSpellRanksSnap } from '@shared/spellRanks'
import type { SearchClassLevel } from '@shared/spellSearch'
import { classLevelLabel } from '@shared/unlockSearch'
import { HeadCell, SpellRow, widthOf } from './BestSpellsRows'
import { OutOfEraChip } from './UnlockList'

/**
 * SHORT, BECAUSE THE COLUMN IS. The panel opposite spells its grammar out in the placeholder
 * (`27-28 cleric shaman`) and has 380px to do it in; this box lives in a band with a 260px floor,
 * where that sentence is three visible words and an ellipsis. So the placeholder says the ONE thing
 * that is different about this box — it reaches every class, not just yours — and the grammar is
 * discoverable in the panel that has room to teach it.
 */
const PLACEHOLDER = 'Search all spells'

/** The box. Controlled by the panel, because the panel is what switches its body on the same state. */
export function BestSpellsSearchField({
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
      sx={{ width: '100%', mb: 0.5, '& .MuiInputBase-input': { fontSize: 11, py: 0.25 } }}
      slotProps={{
        htmlInput: { 'data-testid': 'best-spells-search', 'aria-label': 'search all spells' },
        input: {
          startAdornment: (
            <InputAdornment position="start" sx={{ mr: 0.5 }}>
              <SearchIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
            </InputAdornment>
          ),
          endAdornment:
            query === '' ? undefined : (
              <InputAdornment position="end">
                <IconButton
                  size="small"
                  aria-label="clear search"
                  data-testid="best-spells-search-clear"
                  onClick={() => onChange('')}
                >
                  <ClearIcon sx={{ fontSize: 13 }} />
                </IconButton>
              </InputAdornment>
            )
        }
      }}
    />
  )
}

/**
 * THE CLASS CHIPS ON A RESULT — `DRU 44`, every class the DB places the spell for.
 *
 * FILLED for a class the loadout could be, outlined for everyone else, which is the one glance the
 * owner asked for: a row that is yours and a row you are comparing against look different without
 * reading a word. The level is on the chip for the unlock search's reason (JOS-392): the row is
 * drawn under a level that is NOT necessarily the level this class gains it at, so a bare `DRU`
 * would be a fact withheld.
 */
function ClassLevelChips({
  levels,
  loadout
}: {
  levels: readonly SearchClassLevel[]
  loadout: ReadonlySet<string>
}): JSX.Element {
  return (
    <>
      {levels.map((p) => (
        <Chip
          key={p.cls}
          size="small"
          label={classLevelLabel(p)}
          data-testid="best-spells-result-class"
          data-class={p.cls}
          color="secondary"
          variant={loadout.has(p.cls) ? 'filled' : 'outlined'}
          sx={{ height: 16, fontSize: 9, '& .MuiChip-label': { px: 0.5 } }}
        />
      ))}
    </>
  )
}

/** A quiet line under the results: what the cap is not showing, and what this tab cannot read. */
function ResultNote({ text, testid }: { text: string; testid: string }): JSX.Element {
  return (
    <Typography
      variant="caption"
      color="text.disabled"
      display="block"
      data-testid={testid}
      sx={{ fontSize: 9.5, mt: 0.25 }}
    >
      {text}
    </Typography>
  )
}

export interface BestSpellsResultsProps {
  results: BestSpellSearchResults
  /** the tab the results were read on: its columns, and its name in the `elsewhere` line */
  tab: BestSpellTab
  columns: readonly BestSpellColumn[]
  sort: BestSpellSort
  onSort: (s: BestSpellSort) => void
  ranks: ObservedSpellRanksSnap | null
  /** the loadout classes, for the filled/outlined chip split */
  loadout: ReadonlySet<string>
}

/**
 * THE RESULTS TABLE. The same headers, the same widths, the same two-line rows as the ranked table
 * it replaces, plus the two chips a result carries: the era verdict and the class levels.
 *
 * EMPTY IS STATED, and it states the two different empties differently. A query nothing matches
 * gets the honest "nothing in the wiki DB"; a query whose matches simply have no figures on THIS
 * tab is told so and pointed at the tabs, because the answer really is on screen one click away.
 */
export function BestSpellsResults({
  results,
  tab,
  columns,
  sort,
  onSort,
  ranks,
  loadout
}: BestSpellsResultsProps): JSX.Element {
  const elsewhere = elsewhereLabel(results.elsewhere, TAB_LABEL[tab])
  return (
    <Box
      data-testid="best-spells-results"
      data-tab={tab}
      data-count={String(results.matched)}
      data-elsewhere={String(results.elsewhere)}
      data-sort={sort.column}
      data-desc={String(sort.desc)}
    >
      {results.rows.length === 0 ? (
        <Typography variant="caption" color="text.disabled" display="block" data-testid="best-spells-search-empty">
          {results.elsewhere > 0
            ? `nothing that matches has a ${TAB_LABEL[tab]} reading - try another tab`
            : 'no spell in the wiki DB matches that - try a name, a class, a level or a range'}
        </Typography>
      ) : (
        <Table size="small" sx={{ tableLayout: 'fixed' }}>
          <TableHead>
            <TableRow>
              {columns.map((c) => (
                <HeadCell key={c} column={c} width={widthOf(tab, c)} sort={sort} onSort={onSort} />
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {results.rows.map((r) => (
              <SpellRow
                key={r.name}
                row={r}
                columns={columns}
                ranks={ranks}
                extra={
                  <Stack direction="row" spacing={0.5} alignItems="baseline" flexWrap="wrap" useFlexGap>
                    <OutOfEraChip outOfEra={r.outOfEra} />
                    <ClassLevelChips levels={r.levels} loadout={loadout} />
                  </Stack>
                }
              />
            ))}
          </TableBody>
        </Table>
      )}
      {results.hidden > 0 && (
        <ResultNote text={`+${String(results.hidden)} more, refine your search`} testid="best-spells-search-more" />
      )}
      {elsewhere !== null && results.rows.length > 0 && (
        <ResultNote text={elsewhere} testid="best-spells-search-elsewhere" />
      )}
    </Box>
  )
}
