// posky/CleanupList.tsx — THE FIFTH SKY TAB (JOS-389, rebuilt JOS-401): what you could destroy,
// and what it costs.
//
// The model is `cleanup.ts` and every sentence on a row comes out of it, so this file is a table,
// one control and the caveat above them. What it draws:
//
//   THE CAVEAT, ALWAYS. An `Alert severity="warning"` that cannot be dismissed. That is a
//   deliberate exception to the tooltip-and-caveat diet (AGENTS.md) rather than a lapse: the diet
//   is about defensive source-caveating on screens that state facts, and this screen states
//   ADVICE — the owner asked for the warning in his own words and asked for it to stay up, on the
//   argument that a player who deletes the wrong thing cannot undo it in the game.
//
//   ONE TABLE ROW PER ITEM, biggest stack first: the verdict, the name, how many, where the dump
//   says they are, and then the other half of the decision — every turn-in the item feeds, how
//   many times it has been run, what it pays, and whether the bags are good for another run.
//
// WHAT LEFT, AND WHY (JOS-401, owner report on his own character):
//
//   "I DESTROYED THESE" IS GONE, with its undo strip and the local state behind it. It existed
//   because this app believed the log could not see a destruction — a belief `reconcile.ts` stated
//   in prose and this file repeated. The log has been printing `You successfully destroyed <N>
//   <Item>.` all along (356 lines of the owner's), it is parsed now, and the held counts subtract
//   it. A button asking a player to hand-state a fact the log states is a button that can only be
//   wrong or redundant. The pencil on the quest row (`ItemOverrides.tsx`) stays as the escape hatch
//   for what the log genuinely cannot see — a trade, a bank deposit into a window no dump opened.
//
//   "REFRESH FROM INVENTORY" IS GONE. The Sky tab has followed the export file by itself since
//   JOS-268 (`inventory:autoReloaded`, which `useCharacterSheet` re-asks on); JOS-389 added a
//   manual re-read anyway, on this tab alone. Every other Sky surface is live and so is this one.
//   The count-source control STAYS — that is the strategy the reader picks, not a refresh.
//
// NO POPPER except the item card (JOS-143 / JOS-181). Every name here — the item and every reward —
// is an `ItemNameLink` (QuestItemsTable.tsx), which mounts `SkyItemCard`: hover explains, click
// opens the Loot drill-down. That is the standing idiom for an item name on this tab, and using it
// rather than a second local wrapper is what makes the reward name hoverable at all, which is the
// other half of the owner's report. `tests/tooltipCursor.test.mts` holds this file to it.

import { type JSX, useCallback, useMemo } from 'react'
import {
  Alert,
  Box,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography
} from '@mui/material'
import type { CountSource } from '@shared/types'
import { InventorySource } from './QuestFilterBar'
import { ItemNameLink } from './QuestItemsTable'
import { useCharacterSheet } from '../character/useCharacterSheet'
import { observedTierOf, useItemTiers } from '../../lib/ObservedItemWindow'
import type { QuestProgress } from './useProgress'
import {
  CLEANUP_CAVEAT,
  cleanupRowsFor,
  decisionLine,
  dumpLocationsFrom,
  locationsLine,
  rewardTierLine,
  setsLine,
  timesLine,
  turnInHeading,
  type CleanupRow,
  type CleanupTurnIn,
  type DumpLocations
} from './cleanup'

/** Nothing anywhere claims to know where an item is. Module-scope so it is identity-stable. */
export const NO_DUMP_LOCATIONS: DumpLocations = {}

export interface CleanupListProps {
  quests: QuestProgress[]
  countSource: CountSource
  onCountSource: (s: CountSource) => void
  inventoryLoadedAt: number | null
  /** an item name → the Loot tab's drill-down; absent leaves the names hoverable but unlinked */
  onOpenLoot?: (item: string) => void
}

/** One quest this item feeds, and the case for keeping the item instead of destroying it. */
function TurnInLine({
  t,
  tier,
  onOpenLoot
}: {
  t: CleanupTurnIn
  tier: number | undefined
  onOpenLoot?: (item: string) => void
}): JSX.Element {
  const sets = setsLine(t)
  const owned = rewardTierLine(t.reward, tier)
  const keep = t.sets >= 1
  return (
    <Box data-testid="posky-cleanup-turnin" data-sets={t.sets} sx={{ py: 0.4 }}>
      <Typography variant="body2" color="text.secondary" component="div">
        {turnInHeading(t)} {'· '}
        {timesLine(t)}
        {t.reward ? (
          <>
            {' · reward: '}
            {/* The wrapper is a HANDLE, not a style: both names on this row are the same
                component and therefore the same testid, and the e2e's subject is specifically the
                REWARD's hover (the owner's third ask). A `:nth-of-type` would pin the answer to
                the cell layout instead of to the thing being asserted. */}
            <Box component="span" data-testid="posky-cleanup-reward">
              <ItemNameLink name={t.reward} onOpenLoot={onOpenLoot} />
            </Box>
          </>
        ) : null}
        {owned ? ` · ${owned}` : ''}
      </Typography>
      {/* THE ONE LINE ON THE ROW THAT TAKES A SIDE, so it gets its own line and its own colour. */}
      <Typography
        variant="body2"
        component="div"
        sx={{ color: keep ? 'warning.main' : 'text.secondary' }}
      >
        {decisionLine(t)}
        {sets ? `, ${sets}` : ''}
      </Typography>
    </Box>
  )
}

/** One item: the name, the count, where it sits, and the quests it would feed. */
function CleanupItemRow({
  row,
  tierOf,
  onOpenLoot
}: {
  row: CleanupRow
  tierOf: (reward: string | undefined) => number | undefined
  onOpenLoot?: (item: string) => void
}): JSX.Element {
  return (
    <TableRow data-testid="posky-cleanup-row" data-item={row.name} data-count={row.quantity}>
      <TableCell sx={{ verticalAlign: 'top', fontWeight: 600 }}>
        {/* No `row` for the card's drop roster: a Cleanup row is keyed by the counting key and can
            be claimed by several quests with different stated `where`s, so there is no ONE quest
            row to build it from. The card still draws the item window and what else it is for. */}
        <ItemNameLink name={row.name} onOpenLoot={onOpenLoot} />
      </TableCell>
      <TableCell data-testid="posky-cleanup-qty" sx={{ verticalAlign: 'top' }}>
        x{row.quantity}
      </TableCell>
      <TableCell
        data-testid="posky-cleanup-where"
        sx={{ verticalAlign: 'top', color: 'text.secondary' }}
      >
        {locationsLine(row.locations)}
      </TableCell>
      <TableCell sx={{ verticalAlign: 'top' }}>
        {row.turnIns.map((t) => (
          <TurnInLine key={t.questKey} t={t} tier={tierOf(t.reward)} onOpenLoot={onOpenLoot} />
        ))}
      </TableCell>
    </TableRow>
  )
}

/**
 * THE TAB.
 *
 * The dump's locations are read HERE rather than in `PoskyView` on purpose: they decide nothing
 * about which rows exist (that is the turn-in rule and the held counts alone), so the tab's COUNT
 * can be derived without asking main for the sheet, and a player who never opens Cleanup never
 * pays for the read. `useCharacterSheet` re-asks on every `inventory:autoReloaded`, so the places
 * follow the file by themselves — which is the whole reason this tab needs no reload button.
 */
export default function CleanupList({
  quests,
  countSource,
  onCountSource,
  inventoryLoadedAt,
  onOpenLoot
}: CleanupListProps): JSX.Element {
  const { sheet } = useCharacterSheet()
  const tiers = useItemTiers()

  const locations = useMemo(() => dumpLocationsFrom(sheet?.carry.rows), [sheet])
  const rows = useMemo(() => cleanupRowsFor(quests, locations), [quests, locations])
  const tierOf = useCallback(
    (reward: string | undefined) => (reward ? observedTierOf(tiers, reward) : undefined),
    [tiers]
  )

  return (
    <Box
      data-testid="posky-cleanup"
      sx={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <Alert severity="warning" data-testid="posky-cleanup-caveat" sx={{ mb: 2 }}>
        {CLEANUP_CAVEAT}
      </Alert>
      <Stack direction="row" spacing={2} alignItems="center" useFlexGap sx={{ mb: 2 }}>
        <Box sx={{ flexGrow: 1 }} />
        <InventorySource
          countSource={countSource}
          onCountSource={onCountSource}
          inventoryLoadedAt={inventoryLoadedAt}
        />
      </Stack>
      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        {rows.length === 0 ? (
          <Typography color="text.secondary" data-testid="posky-cleanup-empty">
            Nothing here to destroy - every Sky item you are holding is still wanted by a quest you
            have not turned in.
          </Typography>
        ) : (
          <>
            <Typography
              variant="body2"
              color="text.secondary"
              data-testid="posky-cleanup-count"
              sx={{ mb: 1 }}
            >
              {rows.length} item{rows.length === 1 ? '' : 's'} no un-turned-in quest still needs.
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Item</TableCell>
                  <TableCell>Held</TableCell>
                  <TableCell>Where</TableCell>
                  <TableCell>Feeds</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => (
                  <CleanupItemRow
                    key={row.key}
                    row={row}
                    tierOf={tierOf}
                    onOpenLoot={onOpenLoot}
                  />
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </Box>
    </Box>
  )
}
