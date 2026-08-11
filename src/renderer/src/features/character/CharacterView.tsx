// character/CharacterView — the Magelo-style character sheet (JOS-45).
//
// Identity across the top, the armory slot grid on the left, what the gear adds up to on the
// right. Everything on this tab comes from two places and says which: the log (name, level,
// class loadout) and the newest `/outputfile inventory` dump (every slot, every socket).
//
// UNRELEASED. This whole tree is behind the compile-time `UNRELEASED` flag — it is reachable
// in a dev build and STRIPPED from every packaged build, pending the owner's review (owner,
// 2026-08-06). See src/renderer/src/devFlags.ts and src/main/unreleased.ts. It graduates by
// deleting its gate, not by flipping a setting.
//
// WHAT THIS TAB DOES NOT SHOW, AND WHY THERE IS NO PANEL APOLOGISING FOR IT: your real AC, HP,
// mana, resists and AA. The JOS-45 spike read the shipped client's own string table — no
// `/outputfile` variant exports character stats, and no AA export exists at all. So there is no
// empty "AA" card here to explain a permanent absence; the sheet shows what can be known and
// the gear panel names its own scope in its heading.

import { type JSX } from 'react'
import { Box, Paper, Stack, Typography } from '@mui/material'
import type { SheetCellView } from '@shared/characterSheet'
// The `/outputfile` registry (JOS-44) owns the command string and — since JOS-185 — the steps
// that make the dump complete. This tab never re-types either of them.
import { outputKind } from '@shared/outputs/kinds'
import OutputFileLine from '../../components/OutputFileLine'
import CharacterIdentity from './CharacterIdentity'
import GearStats from './GearStats'
import SlotGrid from './SlotGrid'
import { useCharacterSheet } from './useCharacterSheet'

/** The dump this tab is fed by, as the registry states it. */
const INVENTORY = outputKind('inventory')

/**
 * The one card that teaches the dump, shown only while there is no dump to read — the same
 * collaborative explainer the Planner's Inventory tab uses, because it is the same command and
 * the same live fill (main watches the install root for the FIRST dump to appear, not just for
 * later rewrites).
 */
function InstructionsCard(): JSX.Element {
  return (
    <Paper variant="outlined" data-testid="character-sheet-help" sx={{ p: 1.5 }}>
      <Stack spacing={0.5}>
        <Typography variant="subtitle2">Fill this in from the game</Typography>
        <Typography variant="body2" color="text.secondary">
          Type <b>/outputfile inventory</b> in EverQuest. Every slot below fills with what you are
          wearing, straight away - leave this tab open and watch it happen.
        </Typography>
      </Stack>
    </Paper>
  )
}

/** Equipped rows the grid has no cell for. Never seen in a real dump; drawn if one ever appears. */
function Unplaced({ cells }: { cells: SheetCellView[] }): JSX.Element | null {
  if (cells.length === 0) return null
  return (
    <Paper variant="outlined" sx={{ p: 1 }} data-testid="character-unplaced">
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Also equipped
      </Typography>
      <SlotGrid cells={cells} />
    </Paper>
  )
}

export default function CharacterView(): JSX.Element {
  const { sheet, ready } = useCharacterSheet()

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, height: '100%', minHeight: 0, p: 0.5 }}>
      <CharacterIdentity />

      {/* Only once the read has settled: a card that flashes before the dump loads would teach
          a command to someone who already ran it. */}
      {ready && sheet === null && <InstructionsCard />}
      {/* …and once a dump EXISTS, the shared freshness line (JOS-42's OutputFileLine, whose
          header asked the second `/outputfile` surface to adopt it rather than grow a second
          dialect). It is the case the card cannot cover: every slot below renders with total
          confidence whether the dump is a minute or a month old, and the file's own mtime is
          the difference between reading your gear and reading a memory of it. */}
      {sheet && (
        <OutputFileLine
          command={INVENTORY.command}
          why="Re-type it in game whenever your gear changes - this sheet follows the dump."
          updatedAt={sheet.loadedAt}
          steps={INVENTORY.steps}
          testId="character-outputfile"
        />
      )}

      {sheet && (
        <Stack
          direction={{ xs: 'column', lg: 'row' }}
          spacing={1}
          alignItems="flex-start"
          sx={{ minWidth: 0 }}
          data-testid="character-sheet"
        >
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <SlotGrid cells={sheet.cells} />
          </Box>
          <Stack spacing={1} sx={{ width: { xs: '100%', lg: 340 }, flexShrink: 0 }}>
            <GearStats totals={sheet.totals} />
            <Unplaced cells={sheet.unplaced} />
          </Stack>
        </Stack>
      )}
    </Box>
  )
}
