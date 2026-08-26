// BuffStats — the per-class DURATIONS tables, their search box, and the allow-list box on every
// row. Split out of BuffsView.tsx when JOS-168 added the last two: that file is at the repo's
// 400-code-line factoring ceiling and the house answer is a split, never a widened threshold.
//
// Nothing about the tables themselves changed in the move — the estimate cell, its provenance chip
// and the "everything unstated renders as a dash" rule are the same code they were in BuffsView.
//
// WHAT IS NEW IS THE SEARCH, AND WHY IT IS HERE (owner ask 2026-08-16): these tables are every
// spell this character's log has ever mined, which makes them the only complete list of "spells I
// could tick". In opt-in mode a player needs to allow a buff that is not currently up — there is no
// card to press — so the search is how they find it and the row's own box is how they check it. It
// replaces the earlier search-to-ADD design entirely: no suggestion flow, no wiki source, no second
// namespace. A spell the log has never seen has no row, and the answer for it is to cast it once
// and check it on the card.
//
// PLAIN SUBSTRING, CASE-INSENSITIVE, ACROSS EVERY CLASS. Not `spellSearch`'s token machinery: this
// is a filter over ~200 names the reader is already looking at, and the ticket says so explicitly.
// The input echoes instantly and the FILTER rides `useDeferredValue` (AGENTS.md's search rule).

import type { JSX } from 'react'
import { useDeferredValue, useMemo, useState } from 'react'
import {
  Box,
  Chip,
  InputAdornment,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import type { BuffClass, BuffStat } from '@shared/types'
import { fmtDuration, classAccent, estimatePrefix, estimatorSourceTitle } from './format'
import { Tooltip } from '../../lib/Tooltip'
import { BuffAllowCheck } from './BuffAllowCheck'
import { useBuffAllow } from './useBuffAllow'

// Stats-table sections: buffs first, then debuffs (Task #35 — a spell property).
const CLASS_ORDER: BuffClass[] = ['buff', 'debuff']
const CLASS_LABEL: Record<BuffClass, string> = { buff: 'Buffs', debuff: 'Debuffs' }

/**
 * The estimate the app uses (JOS-117): max(DB floor, recent observed max). The source names which
 * WON — 'db' when the DB floor held, 'observed' when a logged cast beat it, since JOS-212
 * 'cluster' when three agreeing clean cycles overruled a floor that was too long, and since
 * JOS-379 'deathBound' when the only evidence is a mob that died still carrying the spell. Every
 * learned source shows a "log" chip (the DB is the baseline, the log is what makes it accurate)
 * and they are told apart by the tooltip; a bound also wears a `≥` on the figure, because it is a
 * floor under the duration rather than the duration. Falls back to median for older deltas without
 * the field.
 */
function rowEstimate(s: BuffStat): { ms?: number | null; src?: string } {
  const ms = s.estimateMs ?? s.dbDurationMs ?? s.medianMs
  const src =
    s.estimatorSource ?? (s.dbDurationMs != null ? 'db' : s.medianMs != null ? 'observed' : undefined)
  return { ms, src }
}

/** The estimate cell: the figure plus a chip naming where it came from. */
function EstimateCell({ ms, src }: { ms?: number | null; src?: string }): JSX.Element {
  if (ms == null) return <>-</>
  return (
    <Tooltip title={estimatorSourceTitle(src)}>
      <span>
        {/* A DEATH BOUND IS A FLOOR, AND THE CELL SAYS SO (JOS-379): `≥ 3m 08s`, never a bare
            figure that reads as a measurement. See format.ts `estimatePrefix`. */}
        {estimatePrefix(src)}
        {fmtDuration(ms)}
        {src ? (
          <Chip
            size="small"
            label={src === 'db' ? 'db' : 'log'}
            variant="outlined"
            sx={{ ml: 0.5, height: 15, fontSize: 9, '& .MuiChip-label': { px: 0.4 } }}
          />
        ) : null}
      </span>
    </Tooltip>
  )
}

/** One stats row. Everything not stated by a source renders as '—', never as a zero. */
function StatsRow({ s, withBoxes }: { s: BuffStat; withBoxes: boolean }): JSX.Element {
  const est = rowEstimate(s)
  return (
    <TableRow hover data-testid="buff-stats-row" data-spell={s.spell}>
      {/* THE SECOND PLACE TO CHECK A SPELL (JOS-168) — the same box the active card carries, on
          every mined line, which is what makes a buff that is not currently up reachable. The
          COLUMN exists only in opt-in mode (owner ruling 2026-08-17): off means no boxes anywhere,
          and an empty column would be a box-shaped hole. */}
      {withBoxes ? (
        <TableCell padding="checkbox">
          <BuffAllowCheck spell={s.spell} dense />
        </TableCell>
      ) : null}
      <TableCell>{s.spell}</TableCell>
      <TableCell align="right">
        <EstimateCell ms={est.ms} src={est.src} />
      </TableCell>
      <TableCell align="right">
        {s.n === 0 ? (
          <Tooltip title="No cast→fade pair yet">
            <span style={{ opacity: 0.5 }}>0</span>
          </Tooltip>
        ) : (
          s.n
        )}
      </TableCell>
      <TableCell align="right">{fmtDuration(s.medianMs)}</TableCell>
      <TableCell align="right" style={{ opacity: 0.8 }}>
        {s.p25 != null && s.p75 != null ? `${fmtDuration(s.p25)} - ${fmtDuration(s.p75)}` : '-'}
      </TableCell>
      <TableCell align="right" style={{ opacity: 0.65 }}>
        {s.minMs != null && s.maxMs != null ? `${fmtDuration(s.minMs)} - ${fmtDuration(s.maxMs)}` : '-'}
      </TableCell>
    </TableRow>
  )
}

/** The dense per-spell stats table for ONE class, sorted by sample count. */
function StatsTable({ rows, withBoxes }: { rows: BuffStat[]; withBoxes: boolean }): JSX.Element {
  return (
    <Table size="small" sx={{ '& td, & th': { py: 0.5 } }}>
      <TableHead>
        <TableRow>
          {withBoxes ? <TableCell padding="checkbox">on</TableCell> : null}
          <TableCell>Spell</TableCell>
          <TableCell align="right">estimate</TableCell>
          <TableCell align="right">n</TableCell>
          <TableCell align="right">median</TableCell>
          <TableCell align="right">IQR (p25-p75)</TableCell>
          <TableCell align="right">min-max</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((s) => (
          <StatsRow key={s.spell} s={s} withBoxes={withBoxes} />
        ))}
      </TableBody>
    </Table>
  )
}

/** One class's durations table, under its accent swatch. */
function StatsSection({ cls, rows, withBoxes }: { cls: BuffClass; rows: BuffStat[]; withBoxes: boolean }): JSX.Element {
  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: classAccent(cls) }} />
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {CLASS_LABEL[cls]}
        </Typography>
      </Stack>
      <Paper variant="outlined" sx={{ p: 1, borderLeft: '3px solid', borderLeftColor: classAccent(cls) }}>
        <StatsTable rows={rows} withBoxes={withBoxes} />
      </Paper>
    </Box>
  )
}

/** The rows of one class that match the query, sorted by sample count then name. */
function matching(stats: Record<string, BuffStat>, cls: BuffClass, needle: string): BuffStat[] {
  return Object.values(stats)
    // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives BuffStat. Becomes a view descriptor when the source lands.
    .filter((s) => s.cls === cls && (needle === '' || s.spell.toLowerCase().includes(needle)))
    // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives BuffStat. Becomes a view descriptor when the source lands.
    .sort((a, b) => b.n - a.n || a.spell.localeCompare(b.spell))
}

/**
 * The whole Durations block: the search field, then one table per class that still has a row.
 *
 * A class with no MATCH disappears rather than printing its own empty state, so a search reads as
 * one list narrowing rather than as two tables arguing about it; the one empty state below says
 * which of the two situations you are in — nothing mined yet, or nothing matching.
 */
export function BuffStats({ stats }: { stats: Record<string, BuffStat> }): JSX.Element {
  const [query, setQuery] = useState('')
  // The input echoes instantly; the FILTER is deferred (AGENTS.md's search rule).
  const needle = useDeferredValue(query).trim().toLowerCase()
  const sections = useMemo(
    () => CLASS_ORDER.map((cls) => ({ cls, rows: matching(stats, cls, needle) })).filter((s) => s.rows.length > 0),
    [stats, needle]
  )
  const mined = useMemo(() => Object.keys(stats).length > 0, [stats])
  // The boxes and their column exist only in opt-in mode; the search stays in both, because the
  // tables are worth searching whether or not you are ticking them.
  const withBoxes = useBuffAllow(window.eq).prefs.optIn

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <Typography variant="subtitle2">Durations</Typography>
        <Box sx={{ flexGrow: 1 }} />
        <TextField
          size="small"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
          }}
          placeholder="Search spells"
          data-testid="buff-stats-search"
          // NO TOOLTIP ON AN INPUT THE USER TYPES INTO (AGENTS.md's tooltip diet) — the
          // placeholder is the label and the magnifier is the affordance.
          slotProps={{
            htmlInput: { 'aria-label': 'Search spells' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              )
            }
          }}
          sx={{ width: 240 }}
        />
      </Stack>
      {sections.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {mined && needle !== '' ? `No spells match "${query.trim()}".` : 'No buff durations yet.'}
        </Typography>
      ) : (
        <Stack spacing={1.5}>
          {sections.map((s) => (
            <StatsSection key={s.cls} cls={s.cls} rows={s.rows} withBoxes={withBoxes} />
          ))}
        </Stack>
      )}
    </Box>
  )
}
