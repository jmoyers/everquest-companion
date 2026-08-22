// THE PROCS PANEL (JOS-37) — a glanceable list of what procced in the selected segment:
// name · PPM · count, ranked by count.
//
// It is a first-class dashboard CELL now, not a tab. It used to share the second cell with the
// composition breakdown behind a tab pair, and that arrangement had already cost the owner the
// feature once ("I can't find it in the UI"); when the dedicated You breakdown retired, the cell
// it freed went to the thing that had been hiding behind it.
//
// AND IT IS THREE COLUMNS, deliberately. The shipped tab carried the slow headline, the rolling
// time-to-slow, the coat roster, proc rates with two denominators, Tier-A contribution, the
// active-state span ledger with per-edge evidence chips, the Tier-B effects report, the dispel
// disclaimer and a mid-fight change log. Every one of those was true; together they were a
// research surface, not a readout. The deeper attribution lives in the DAMAGE BREAKDOWN — drill
// a source and its proc lanes carry `proc · N ppm` on the skill rows themselves — and the
// segment header still states the slow. What is left here is the question a player asks mid-pull:
// what is firing, and how often.
//
// SOURCE OF TRUTH: every number is folded on ingest by the engine (ProcsView), never derived from
// the per-event ring — so this panel carries no `~ N of M events` chip and no downsample caveat.
// The only `~` in it marks a lane whose NAME the game left ambiguous (two Strikes sharing one
// emote), never a scaled number.

import { Box, Stack, Typography } from '@mui/material'
import type { SegmentView } from '@shared/combat'
import { CopyButton, DashCard, QuietNote } from './combatShared'
import { formatProcsText } from './copyText'
// Lane hues, by origin — ONE table, shared with the drill row's tag, so a lane means one thing
// app-wide (JOS-438 gave `click` a hue of its own and that table a single home).
import { ORIGIN_COLOR } from './markerStyle'
import { procListRows, procSummary, type ProcListRow } from './procRows'

/** `Smiting Strike ······ 4.0 ppm  ×214`. The count is exact; the rate may be an honest dash. */
function ProcRow({ row }: { row: ProcListRow }): React.JSX.Element {
  return (
    <Box data-testid="proc-row" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: '1px', minWidth: 0 }}>
      <Box sx={{ width: 6, height: 6, borderRadius: '2px', bgcolor: ORIGIN_COLOR[row.origin], flexShrink: 0 }} />
      <Typography variant="caption" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
        {row.ambiguous ? `~ ${row.name}` : row.name}
      </Typography>
      <Typography variant="caption" color="text.secondary" noWrap sx={{ width: 62, textAlign: 'right', flexShrink: 0 }}>
        {row.ppm}
      </Typography>
      <Typography variant="caption" noWrap sx={{ width: 48, textAlign: 'right', flexShrink: 0 }}>
        ×{row.count}
      </Typography>
    </Box>
  )
}

/**
 * The dashboard's PROCS cell. Its subject is the selected segment — the same subject the meter
 * beside it ranks — so it needs no state of its own and follows every scope change for free.
 */
export function ProcsCard({ seg }: { seg: SegmentView }): React.JSX.Element {
  const rows = procListRows(seg.procs)
  // ONE rollup for the header and the list: the header's count IS the lanes' own total, so the
  // card can never advertise a number the rows under it do not add up to.
  const summary = procSummary(seg.procs)
  return (
    <DashCard
      title="Procs"
      right={
        rows.length === 0 ? undefined : (
          <Stack direction="row" spacing={0.75} alignItems="baseline" sx={{ minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" noWrap>
              {summary.header}
            </Typography>
            <CopyButton getText={() => formatProcsText(seg)} title="Copy this proc list as text" />
          </Stack>
        )
      }
      fill
      testId="dash-panel"
    >
      {rows.length === 0 ? (
        <QuietNote>No procs in this selection.</QuietNote>
      ) : (
        <Box sx={{ overflow: 'auto', flexGrow: 1, minHeight: 0, minWidth: 0 }}>
          {rows.map((r) => (
            <ProcRow key={r.key} row={r} />
          ))}
        </Box>
      )}
    </DashCard>
  )
}
