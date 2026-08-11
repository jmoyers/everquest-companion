// UnlockList — the rows of the "New at this level" panel (docs/plans/levelup-whats-new.md §2).
//
// ONE ROW SHAPE FOR BOTH LISTS. A spell and a discipline answer the same question ("what did this
// level give me") and differ only in what hangs off the name: a spell wears the class chips and a
// hover card built from the DB's own fields; a skill/disc/innate wears a KIND chip and, when the
// wiki contradicts itself about it, an honesty chip quoting the contradiction verbatim.
//
// THE HONESTY CHIP IS NOT DECORATION (law 1). Thirteen discipline rows — BER 2, MNK 10, RNG 1 —
// are stated with levels by their own class page and struck through by the central Disciplines
// page, which says only Rogue poison disciplines are on Legends. Both are the wiki's words. The
// row is drawn AND labeled, never silently shown and never silently dropped; the label's tooltip
// is the disputing sentence itself, copied out of classes.json.
//
// FIXED HEIGHT + WINDOWED, per the standing list law: the rows are uniform, a class trio can
// unlock a couple of dozen at one level, and the panel sits above two charts that must keep their
// space. `useWindowedRows` is the app's own hook (lib/useWindowedRows.ts).

import { type JSX, useRef } from 'react'
import { Box, Chip, Stack, Typography } from '@mui/material'
import type { ClassAbbr } from '@shared/classCombo'
import type { UnlockRow } from '@shared/levelUnlocks'
import { Tooltip } from '../../lib/Tooltip'
import { useWindowedRows } from '../../lib/useWindowedRows'
import { fmtDuration } from './levelChartGeometry'

/** Row height in px — fixed, which is what makes the window arithmetic exact. */
const ROW_H = 26

const KIND_LABEL: Record<UnlockRow['kind'], string> = {
  spell: 'spell',
  skill: 'skill',
  disc: 'disc',
  innate: 'innate'
}

const KIND_COLOR: Record<UnlockRow['kind'], string> = {
  spell: '#6fb3d2',
  skill: '#5fbf72',
  disc: '#b07fd0',
  innate: '#d9b25f'
}

/**
 * The spell card the name hovers into: the DB's fields, verbatim, in the game window's order.
 *
 * Nothing here computes or ranks a stat, and a field the wiki omits is simply absent — a spell
 * whose page states none of them says so rather than printing five dashes.
 */
function spellCardLines(row: UnlockRow): string[] {
  const s = row.spell
  if (!s) return []
  const lines: string[] = []
  if (s.spellType) lines.push(s.spellType)
  if (s.targetType) lines.push(`Target: ${s.targetType}`)
  lines.push(s.castTimeMs === undefined ? 'Cast time: -' : `Cast: ${(s.castTimeMs / 1000).toFixed(1)}s`)
  if (s.mana !== undefined) lines.push(`Mana: ${String(s.mana)}`)
  if (s.durationMs !== undefined && s.durationMs > 0) lines.push(`Duration: ${fmtDuration(s.durationMs)}`)
  return lines
}

/** The hover card's body. Plain text lines — the item-window idiom, without the item. */
function SpellCard({ row }: { row: UnlockRow }): JSX.Element {
  const lines = spellCardLines(row)
  return (
    <Box>
      <Typography variant="caption" sx={{ fontWeight: 700, display: 'block' }}>
        {row.name}
      </Typography>
      {lines.length === 0 ? (
        <Typography variant="caption" color="text.secondary">
          the spell DB states no details for this one
        </Typography>
      ) : (
        lines.map((l) => (
          <Typography key={l} variant="caption" display="block" color="text.secondary">
            {l}
          </Typography>
        ))
      )}
    </Box>
  )
}

/** The class chips: FILLED for a class we know is in the loadout, outlined for a candidate. */
function ClassChips({ classes, resolved }: { classes: ClassAbbr[]; resolved: ReadonlySet<string> }): JSX.Element {
  return (
    <>
      {classes.map((c) => (
        <Chip
          key={c}
          size="small"
          label={c}
          data-testid="unlock-class-chip"
          variant={resolved.has(c) ? 'filled' : 'outlined'}
          color="secondary"
          sx={{ height: 17, fontSize: 10, '& .MuiChip-label': { px: 0.6 } }}
        />
      ))}
    </>
  )
}

function Row({ row, resolved }: { row: UnlockRow; resolved: ReadonlySet<string> }): JSX.Element {
  const name =
    row.kind === 'spell' ? (
      <Tooltip title={<SpellCard row={row} />} placement="right">
        <Typography variant="caption" sx={{ fontWeight: 600 }} noWrap>
          {row.name}
        </Typography>
      </Tooltip>
    ) : (
      <Typography variant="caption" sx={{ fontWeight: 600 }} noWrap>
        {row.name}
      </Typography>
    )
  return (
    <Stack
      direction="row"
      spacing={0.75}
      alignItems="center"
      data-testid="unlock-row"
      data-kind={row.kind}
      sx={{ height: ROW_H, minWidth: 0 }}
    >
      {row.kind !== 'spell' && (
        <Chip
          size="small"
          label={KIND_LABEL[row.kind]}
          sx={{
            height: 17,
            fontSize: 10,
            bgcolor: `${KIND_COLOR[row.kind]}22`,
            color: KIND_COLOR[row.kind],
            '& .MuiChip-label': { px: 0.6 }
          }}
        />
      )}
      <Box sx={{ minWidth: 0, flexShrink: 1 }}>{name}</Box>
      <Box sx={{ flexGrow: 1 }} />
      {row.dispute && (
        <Tooltip title={row.dispute}>
          <Chip
            size="small"
            label="disputed"
            data-testid="unlock-disputed"
            color="warning"
            variant="outlined"
            sx={{ height: 17, fontSize: 10, '& .MuiChip-label': { px: 0.6 } }}
          />
        </Tooltip>
      )}
      <ClassChips classes={row.classes} resolved={resolved} />
    </Stack>
  )
}

/**
 * One titled, fixed-height, windowed list. `empty` is the sentence to print when there is
 * nothing — for BER/MNK/WAR the spells list is legitimately empty at EVERY level (they have no
 * Template:Spellpage spells at all), so an empty list is a stated fact here, never an error.
 */
export function UnlockList({
  title,
  rows,
  resolved,
  empty
}: {
  title: string
  rows: UnlockRow[]
  resolved: ReadonlySet<string>
  empty: string
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const win = useWindowedRows({ count: rows.length, rowHeight: ROW_H, scrollRef })
  return (
    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 0.25 }}>
        {title} ({rows.length})
      </Typography>
      <Box ref={scrollRef} sx={{ height: 120, overflow: 'auto', pr: 0.75 }}>
        {rows.length === 0 ? (
          <Typography variant="caption" color="text.disabled">
            {empty}
          </Typography>
        ) : (
          <>
            <Box sx={{ height: win.topPad }} />
            {rows.slice(win.start, win.end).map((r) => (
              <Row key={`${r.kind}:${r.name}`} row={r} resolved={resolved} />
            ))}
            <Box sx={{ height: win.bottomPad }} />
          </>
        )}
      </Box>
    </Box>
  )
}
