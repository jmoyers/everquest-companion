// character/CharacterView — the Magelo-style character sheet (JOS-45), released in JOS-327.
//
// Identity across the top, the armory slot grid on the left, what the gear adds up to on the
// right, and — since JOS-327 — the whole rest of the dump underneath: every bag slot, every bank
// slot, every key ring, searchable. Everything on this tab comes from two places and says which:
// the log (name, level, class loadout) and the newest `/outputfile inventory` dump.
//
// IT WAS UNRELEASED, AND THIS PARAGRAPH IS THE LAW IT LIVED UNDER, KEPT ON PURPOSE. From JOS-45
// (owner, 2026-08-06) this whole tree sat behind the compile-time `UNRELEASED` flag: reachable in
// a dev build, STRIPPED from every packaged build, pending the owner's review — and it was stated
// that it would graduate by DELETING its gate rather than by flipping a setting. That is exactly
// what happened on 2026-08-13: `unreleasedCharacter.tsx` deleted, the `KNOWN_VIEWS` splice made
// unconditional, the main-side handler registered like any other. The flag machinery survives with
// no tenant (src/renderer/src/devFlags.ts, src/main/unreleased.ts) because the arrangement is worth
// more than this one use of it. Nothing about the gate is left in this file but its history.
//
// WHAT THIS TAB DOES NOT SHOW, AND WHY THERE IS NO PANEL APOLOGISING FOR IT: your real AC, HP,
// mana, resists and AA. The JOS-45 spike read the shipped client's own string table — no
// `/outputfile` variant exports character stats, and no AA export exists at all. So there is no
// empty "AA" card here to explain a permanent absence; the sheet shows what can be known and
// the gear panel names its own scope in its heading.
//
// AND THE TOTALS READ EACH ITEM AT ITS ` +N` (owner ruling, JOS-416, 2026-08-19 — reversing
// JOS-327's "keep character totals base initially"). The gear panel used to sum the item pages'
// BASE blocks while the rest of the app — the Gear tab's comparison, the wish list, every hover
// delta — already scaled the same worn item by the same suffix, so this tab was the one surface
// answering a different number for the same cloak. It now goes through `shared/itemUpgrade.ts
// scaleStatBlock`, the same algorithm, for EVERY stat that algorithm scales; the caption that used
// to say `base` says `with +N`, so the panel's meaning moved on purpose and out loud rather than
// silently. The per-item ` +N` is still visible where the dump spelled it, on the item's own name
// in the slot grid and in the carry-all ledger.
//
// ---------------------------------------------------------------------------
// THE LAYOUT: A SHEET ON TOP, A LEDGER UNDERNEATH, AND A MEASURED REASON THE PAGE SCROLLS
// ---------------------------------------------------------------------------
// MEASURED at the default window (1280x860, windowState.ts): identity + freshness line + the slot
// grid + the gear panel come to about 656px of the ~740px content area. The sheet is not a growing
// list — it is twenty-four cells and it is that tall on every character — so a ledger sharing the
// remaining height with `flexGrow` alone got EIGHTY-FIVE PIXELS, which is one row and a scrollbar.
// That is a worse surface than the one this ticket set out to build, so this tab is a naturally
// tall page: the root asks for `minHeight: 100%` rather than `height: 100%`, and `CarryAll` takes a
// FLOOR (`minHeight`) plus `flexGrow`, so it fills a tall window and still gets a usable box on a
// short one. The app shell scrolls the difference.
//
// THE GROWING-LIST LAW IS KEPT, AND KEPT WHERE IT MATTERS. What that law protects against is a page
// whose height is a function of the DATA — an append-only panel that squeezes its siblings to 0px
// as it fills. Nothing here does: the ledger is windowed inside its own `overflow: auto` box at a
// height that does not know how many rows exist, so a character with thirty things and a character
// with three hundred produce a page of exactly the same height. `tests/e2e/character-sheet.e2e.mts`
// asserts that identity directly (search the ledger down to four rows; the page must not move) and
// separately asserts that the WINDOW itself never scrolls, which is the half of the law that has no
// carve-outs anywhere.

import { type JSX } from 'react'
import { Box, Paper, Stack, Typography } from '@mui/material'
import type { SheetCellView } from '@shared/characterSheet'
// The `/outputfile` registry (JOS-44) owns the command string and — since JOS-185 — the steps
// that make the dump complete. This tab never re-types either of them.
import { outputKind } from '@shared/outputs/kinds'
import OutputFileLine from '../../components/OutputFileLine'
import CarryAll from './CarryAll'
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
    // `minHeight` rather than `height` — see the layout note in the header. It still FILLS the
    // content box (so the ledger's `flexGrow` has something to grow into on a tall window) and it no
    // longer CLAMPS it, so a short window scrolls the page instead of crushing the one panel below
    // the fold to nothing.
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minHeight: '100%', p: 0.5 }}>
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
          sx={{ minWidth: 0, flexShrink: 0 }}
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

      {/* …and the rest of the same dump (JOS-327). It is the one panel here that GROWS with what
          the player owns, so it is the one that takes the leftover height and scrolls inside
          itself; everything above is `flexShrink: 0` and sizes to its content. */}
      {sheet && <CarryAll carry={sheet.carry} />}
    </Box>
  )
}
