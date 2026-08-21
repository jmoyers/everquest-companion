// character/GearStats — what the worn gear adds up to, and only that.
//
// THE HONEST LABEL IS THE WHOLE DESIGN. The JOS-45 spike read the shipped client's own string
// table: no `/outputfile` variant exports character stats, and no AA export exists at all. So
// the app cannot know your AC — it can only know what your ITEMS say, and this panel says so
// once, in its heading, in three words. Per the tooltip-and-caveat diet that is the entire
// disclosure: no footnote about base stats, no lecture about buffs, no asterisks.
//
// THE SECOND AND LAST HONESTY MARKER IS THE CHIP, AND IT SAYS THE OPPOSITE OF WHAT IT USED TO
// (JOS-416, owner ruling 2026-08-19). It read `base` while these totals summed the item pages'
// BASE blocks and left every ` +N` un-applied; the sum now reads each worn item at the item level
// its own name states, through the same `scaleStatBlock` the Gear tab's comparison uses, so the
// chip reads `with +N` — one word about the ONE thing a reader could otherwise get wrong about
// these numbers. It is a claim about the arithmetic, not a caveat: per the tooltip-and-caveat diet
// there is still no footnote about base stats, no lecture about buffs, no asterisks.
//
// PERCENTAGES ARE STATED, NEVER ADDED. Two worn items in the real dump carry Haste (+36% and
// +21% at base). Whether worn haste stacks is a game rule no source in this repo states, so the
// row shows the values the items state, side by side, and never a total (law 6) — at their scaled
// values now, which is what makes a `Cloak of Flames +5` read `+41%` here and not `+36%`.

import type { JSX } from 'react'
import { Box, Chip, Paper, Stack, Typography } from '@mui/material'
import type { GearStat, GearTotals } from '@shared/characterSheet'

const signed = (n: number): string => (n > 0 ? `+${String(n)}` : String(n))

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ gap: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 0 }}>
        {label}
      </Typography>
      <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {value}
      </Typography>
    </Stack>
  )
}

function StatRows({ rows }: { rows: readonly GearStat[] }): JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <Box sx={{ flex: '1 1 150px', minWidth: 140 }}>
      {rows.map((s) => (
        <Row key={s.label} label={s.label} value={signed(s.total)} />
      ))}
    </Box>
  )
}

export default function GearStats({ totals }: { totals: GearTotals }): JSX.Element {
  return (
    <Paper variant="outlined" sx={{ p: 1.25 }} data-testid="character-gear-stats">
      <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 0.75 }}>
        <Typography variant="subtitle2">Stats from gear</Typography>
        <Chip size="small" variant="outlined" label="with +N" sx={{ height: 18, fontSize: 10 }} />
      </Stack>

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
        <StatRows rows={[{ label: 'AC', total: totals.ac, from: totals.counted }]} />
        <StatRows rows={totals.stats} />
        <StatRows rows={totals.saves} />
        {totals.unsummed.length > 0 && (
          <Box sx={{ flex: '1 1 150px', minWidth: 140 }}>
            {totals.unsummed.map((u) => (
              <Row key={u.label} label={u.label} value={u.values.join('  ')} />
            ))}
          </Box>
        )}
      </Box>

      {/* A count, not a caveat: it says how much of your gear these numbers actually cover. */}
      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.75 }}>
        {totals.counted} of {totals.counted + totals.unknown} worn items
        {totals.unknown > 0 ? ` · ${String(totals.unknown)} not in the item database` : ''}
      </Typography>
    </Paper>
  )
}
