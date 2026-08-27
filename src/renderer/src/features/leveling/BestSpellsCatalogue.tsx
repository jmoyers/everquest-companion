// SEARCH BY TYPE (JOS-507) — the control that picks a spell TYPE, and the rows the engine answers
// with.
//
// The owner's ask, from the in-game Actions/Spells window: a `tap` search over his SHD/BRD/WIZ combo
// returning every tap by level, with Category (`Taps`) and Subcategory (`Health` / `Duration Tap` /
// `Power Tap`) beside each row. Those words exist only in the player's own client files, so this
// body is served by `spells.search` rather than folded here (`useSpellCatalogue.ts`'s header carries
// the ruling-4 argument for why the join is not done in this window).
//
// ── THREE BODIES NOW, AND THE THIRD ENGAGES ONLY WHEN ASKED ───────────────────────────────────
//
// `BestSpellsPanel` draws the ranked table by default, the WIKI results while the box has text, and
// THIS while a type filter is picked. The order matters: with no type picked, nothing in this file
// runs and nothing is requested, so the two older bodies are byte for byte what they were before the
// control existed. That is a constraint rather than an optimization — the readout's whole existing
// e2e family derives its target spell at runtime from the wiki rows, and a filter that defaulted to
// anything but "all types" would change what those steps are looking at.
//
// ── WHY CHIPS AND NOT COLUMNS ─────────────────────────────────────────────────────────────────
//
// `BestSpellsPanel.tsx` carries a MEASUREMENT — at the app's own 260px floor the four numeric
// headers are already 38px past what they ask for, which is why a fifth column was refused there
// with the numbers attached. Category and Subcategory are two more columns that would have to come
// out of the same absent room. So they ride the `extra` slot of the row this readout already draws,
// which spans the full width under the name and is where the era verdict and the class levels
// already live. The Level the game sorts by is the row's own first line.
//
// ── AND IT NEVER FALLS BACK ───────────────────────────────────────────────────────────────────
//
// With no engine there is no client table and therefore no answer to a question about types. The
// body says so (the JOS-503 shape: the shell's own banner explains the engine, and a panel says only
// what it personally cannot do). Showing the wiki rows unfiltered instead would answer a question
// nobody asked while looking exactly like an answer to the one they did.

import { type JSX } from 'react'
import {
  Box,
  Chip,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography
} from '@mui/material'
import type {
  SpellCatalogueRow,
  SpellCategoryFacet
} from '@shared/dataServer/protocol.generated'
import { SpellTooltip } from '../../lib/SpellCard'
import type { SpellCatalogueState } from './useSpellCatalogue'

/** The control's own value for "do not filter by type at all" — the default, and the disengaged state. */
export const ALL_TYPES = ''

/**
 * THE TYPE CONTROL. Its options are the ENGINE's `categories`, and that is not a convenience: the
 * category vocabulary is Daybreak's and lives only in the player's own `dbstr_us.txt`, so a list
 * hardcoded here would be redistributed client data and wrong on the next patch. Until the reader
 * opens it there are no options because nothing has been asked — see the panel's `touched` state.
 */
export function SpellTypeFilter({
  category,
  state,
  onChange,
  onOpen
}: {
  category: string
  state: SpellCatalogueState
  onChange: (next: string) => void
  onOpen: () => void
}): JSX.Element {
  const facets: readonly SpellCategoryFacet[] = state.result?.categories ?? []
  const loading = state.loading
  return (
    <TextField
      select
      size="small"
      value={category}
      onChange={(e) => onChange(e.target.value)}
      sx={{ width: '100%', mb: 0.5, '& .MuiInputBase-input': { fontSize: 11, py: 0.25 } }}
      slotProps={{
        select: {
          onOpen,
          native: false,
          displayEmpty: true,
          // The control is one line in a 260px column, so the value renders as a word rather than
          // as a label-plus-value pair.
          renderValue: (v) => (v === ALL_TYPES ? 'All types' : String(v))
        },
        htmlInput: { 'data-testid': 'best-spells-type-input' }
      }}
      data-testid="best-spells-type"
      data-category={category}
      data-facets={String(facets.length)}
      // WHY THE CONTROL IS EMPTY, ON THE CONTROL ITSELF. Without these two, "no engine connection"
      // and "an install with no client table in it" look identical from outside, and a spec's honest
      // skip branch reports the wrong cause — which is exactly what happened while this ticket's own
      // harness was silently dropping the staged tables.
      data-offline={String(state.offline)}
      data-table={state.result?.spellTable ?? 'unasked'}
    >
      <MenuItem value={ALL_TYPES} data-testid="best-spells-type-option" data-value={ALL_TYPES}>
        All types
      </MenuItem>
      {/* NO OPTIONS YET IS SAID, not drawn as an empty menu: the first open is what asks the engine,
          so an empty list for one beat is the ordinary first frame rather than "you have none". */}
      {facets.length === 0 && (
        <MenuItem disabled data-testid="best-spells-type-pending">
          {loading ? 'reading the client table…' : 'no types to filter by'}
        </MenuItem>
      )}
      {facets.map((f) => (
        <MenuItem key={f.name} value={f.name} data-testid="best-spells-type-option" data-value={f.name}>
          {f.name}
        </MenuItem>
      ))}
    </TextField>
  )
}

/** The two words the game files a spell under, on the row that carries them. */
function TypeChips({ row }: { row: SpellCatalogueRow }): JSX.Element {
  return (
    <>
      {row.category !== undefined && (
        <Chip
          size="small"
          label={row.category}
          data-testid="best-spells-catalogue-category"
          data-category={row.category}
          variant="outlined"
          sx={{ height: 16, fontSize: 9, '& .MuiChip-label': { px: 0.5 } }}
        />
      )}
      {row.subcategory !== undefined && (
        <Chip
          size="small"
          label={row.subcategory}
          data-testid="best-spells-catalogue-subcategory"
          data-subcategory={row.subcategory}
          color="secondary"
          variant="outlined"
          sx={{ height: 16, fontSize: 9, '& .MuiChip-label': { px: 0.5 } }}
        />
      )}
    </>
  )
}

/** The class levels the engine scoped to, spelled the way the readout's other chips are. */
function CatalogueClassChips({ row }: { row: SpellCatalogueRow }): JSX.Element {
  return (
    <>
      {row.classes.map((c) => (
        <Chip
          key={c.class}
          size="small"
          label={`${c.class} ${String(c.level)}`}
          data-testid="best-spells-catalogue-class"
          data-class={c.class}
          variant="filled"
          sx={{ height: 16, fontSize: 9, '& .MuiChip-label': { px: 0.5 } }}
        />
      ))}
    </>
  )
}

/** One quiet caption, the panel's own shape for a thing it has to say rather than draw. */
function CatalogueNote({ text, testid }: { text: string; testid: string }): JSX.Element {
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

/**
 * WHY THERE ARE NO ROWS, in the words each state deserves. Returns null when there is nothing to
 * explain, which is when there are rows.
 *
 * The four are genuinely different sentences and the panel opposite makes the same distinction: an
 * absent engine is not an absent file, and an absent file is not a filter that excluded everything.
 */
function CatalogueEmpty({ state }: { state: SpellCatalogueState }): JSX.Element | null {
  const { result, loading, offline, error } = state
  // NEVER A FALLBACK. The reader asked about types; without the engine there is no client table to
  // read one out of, and the shell's own banner is what explains the engine itself (JOS-503).
  if (offline) {
    return (
      <CatalogueNote
        text="searching by type needs the engine - it is not answering yet"
        testid="best-spells-catalogue-offline"
      />
    )
  }
  if (error !== null) {
    return <CatalogueNote text={error} testid="best-spells-catalogue-error" />
  }
  if (result === null) {
    return loading ? (
      <CatalogueNote text="reading the client table…" testid="best-spells-catalogue-loading" />
    ) : null
  }
  if (result.spellTable !== 'ok') {
    // The engine names the place it looked, and that is the whole value of the sentence: this is how
    // somebody discovers the folder they pointed the app at has no EverQuest in it.
    return (
      <CatalogueNote
        text={
          result.spellTable === 'missing'
            ? `no spells_us.txt at ${result.path}`
            : `could not read ${result.path}`
        }
        testid="best-spells-catalogue-no-table"
      />
    )
  }
  if (result.spells.length === 0) {
    return (
      <CatalogueNote
        text="nothing of that type for this loadout - try All types, or show every class"
        testid="best-spells-catalogue-empty"
      />
    )
  }
  return null
}

export interface BestSpellsCatalogueProps {
  state: SpellCatalogueState
  /** Whether the list is scoped to the loadout, and the handle that flips it. */
  scoped: boolean
  onScoped: (next: boolean) => void
}

/**
 * THE CATALOGUE BODY. Rows arrive filtered, sorted (level descending, the game's own order) and
 * windowed; this draws them in the order they came and derives nothing (ruling 4).
 *
 * The header is `Level` and `Spell` rather than the ranked table's four numeric columns, because
 * these rows are not a metric — the client table states what a spell IS and when you learn it, and
 * has no opinion about its damage per mana.
 */
export function BestSpellsCatalogue({
  state,
  scoped,
  onScoped
}: BestSpellsCatalogueProps): JSX.Element {
  const rows = state.result?.spells ?? []
  const total = state.result?.total ?? 0
  return (
    <Box
      data-testid="best-spells-catalogue"
      data-count={String(rows.length)}
      data-total={String(total)}
      data-scoped={String(scoped)}
      data-offline={String(state.offline)}
    >
      {/* THE SHOW-ALL TOGGLE. Scoped to the combo by default, because the readout's every other body
          is about spells this loadout can have; the reader who wants to compare against a class they
          are not running says so, exactly as the wiki search's own placeholder promises. */}
      <Box
        role="button"
        tabIndex={0}
        aria-pressed={!scoped}
        onClick={() => onScoped(!scoped)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onScoped(!scoped)
        }}
        data-testid="best-spells-catalogue-scope"
        sx={{ cursor: 'pointer', color: 'text.secondary', '&:hover': { color: 'primary.main' }, mb: 0.25 }}
      >
        <Typography variant="caption" sx={{ fontSize: 9.5 }}>
          {scoped ? 'your classes - show every class' : 'every class - show only yours'}
        </Typography>
      </Box>
      <CatalogueEmpty state={state} />
      {rows.length > 0 && (
        <Table size="small" sx={{ tableLayout: 'fixed' }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: '22%', fontSize: 10, px: 0.5, py: 0.25 }}>Level</TableCell>
              <TableCell sx={{ width: '78%', fontSize: 10, px: 0.5, py: 0.25 }}>Spell</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.name} data-testid="best-spells-catalogue-row" data-name={row.name}>
                <TableCell sx={{ fontSize: 10, px: 0.5, py: 0.25, verticalAlign: 'top' }}>
                  <span data-testid="best-spells-catalogue-level">{row.level}</span>
                </TableCell>
                <TableCell sx={{ fontSize: 10, px: 0.5, py: 0.25 }}>
                  {/* THE ONE SEAM, LIKE EVERY OTHER SPELL NAME IN THE APP (JOS-508). Wrapping the
                      name in `SpellTooltip` is the whole of it: the drill link lives inside that
                      component behind a context, so a spell found by TYPE opens the same drilldown
                      page as one found by name, and this file neither knows a router exists nor
                      decides per-surface whether a name is a link. */}
                  <SpellTooltip name={row.name}>
                    <Typography variant="caption" display="block" sx={{ fontSize: 10.5 }}>
                      {row.name}
                    </Typography>
                  </SpellTooltip>
                  {/* THE TWO WORDS THE GAME PRINTS, in the slot the era verdict and the class levels
                      already share — see the header for the measurement that keeps them off the
                      column axis. */}
                  <Stack direction="row" spacing={0.5} alignItems="baseline" flexWrap="wrap" useFlexGap>
                    <TypeChips row={row} />
                    <CatalogueClassChips row={row} />
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {/* WHAT THE WINDOW IS NOT SHOWING. The engine states `total` behind the window precisely so a
          surface can say this without ever holding the rest. */}
      {total > rows.length && (
        <CatalogueNote
          text={`showing ${String(rows.length)} of ${String(total)} - refine your search`}
          testid="best-spells-catalogue-more"
        />
      )}
    </Box>
  )
}
