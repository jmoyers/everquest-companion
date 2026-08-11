// planner/PlanBoard.tsx — Inventory mode: the whole set on one screen, over what you are wearing.
//
// EVERY CELL IN CHARACTER-SHEET ORDER, always all of them (`PLAN_SLOTS`). A board that only drew
// the slots you had already planned would answer "what have you done" when the question is "what is
// left"; the empty cells are the point, and they are drawn QUIET — a slot label and one muted
// invitation, never an error, never a warning about a decision you simply have not made.
//
// TWENTY-THREE AND NOT EIGHTEEN, and both widenings came from players. You wear two ears, two
// wrists and two rings (JOS-67, "only allows one finger slot focus effect"), and you wear two
// ANY-SLOT items on top of that (JOS-104, "missing 2x any slots"). A cell is a PLACE to wear
// something; what R2 compares against is the equip SLOT, and `equipSlotOf` / `hostSlotsOf` are the
// one-line bridges — the host picker and the browse preset both cross them, and nothing below this
// file knows either rule exists. The any-cells cross with `null`, which both of those consumers
// already spell "no slot filter".
//
// IT FILLS ITSELF (V7). The tab was called Board and started empty, which made it eighteen
// invitations to retype gear the game already knows about. Now each cell's host comes from the
// character's newest `/outputfile inventory` dump, joined by the hand-authored slot table
// (shared/planner/inventorySlots.ts, law 12) — and LIVE: main pushes on every rewrite, so running
// the command in game fills this tab while it is on screen (owner, 2026-08-05). Nothing is
// written into the plan by the dump, so a hand-picked host always wins and an auto-filled one
// follows your gear (`plannerInventory.effectiveHost`).
//
// The cell itself is `PlanCell.tsx`; this file is the grid, the dump, the host picker and the
// instructions card for a character who has never made a dump.

import { type JSX, useMemo, useState } from 'react'
import { Box, Paper, Stack, Typography } from '@mui/material'
import {
  equipSlotOf,
  PLAN_SLOTS,
  planSlotLabel,
  type ExaltPlan,
  type PlannerItemHit,
  type PlanSlotId,
  type SocketType
} from '@shared/planner/types'
// The `/outputfile` registry (JOS-44) — the command string and the why-clause come from there, so
// this tab and the Sky tracker cannot end up teaching two different commands for one dump.
import { outputKind } from '@shared/outputs/kinds'
import OutputFileLine from '../../components/OutputFileLine'
import HostPicker from './HostPicker'
import PlanCell from './PlanCell'
import { indexDonors, useDonors } from './plannerData'
import { hostsBySlot, usePlannerInventory } from './plannerInventory'
import type { BrowsePreset } from './plannerPreset'
import type { PlannerProgressApi } from './plannerProgress'

/** The dump this tab is fed by, as the registry states it (command + why-clause). */
const INVENTORY = outputKind('inventory')

/**
 * The one card that teaches the dump, shown only while there is no dump to read.
 *
 * It is a collaborative explainer rather than a caveat (the tooltip-and-caveat diet): it names
 * the command, says what happens next, and disappears the moment the file exists — because main
 * watches the install root for the first dump to APPEAR, not just for later rewrites.
 */
function InstructionsCard(): JSX.Element {
  return (
    <Paper variant="outlined" data-testid="planner-inventory-help" sx={{ p: 1.5, mb: 1 }}>
      <Stack spacing={0.5}>
        <Typography variant="subtitle2">Fill this in from the game</Typography>
        <Typography variant="body2" color="text.secondary">
          Type <b>{INVENTORY.command}</b> in EverQuest. Every slot below fills with what you are
          wearing, straight away - leave this tab open and watch it happen.
        </Typography>
        <Typography variant="caption" color="text.disabled">
          Anything you pick by hand stays picked.
        </Typography>
      </Stack>
    </Paper>
  )
}

export interface PlanBoardProps {
  plan: ExaltPlan
  progress: PlannerProgressApi
  onSocket: (slot: PlanSlotId, socket: SocketType, planned: null) => void
  onHost: (slot: PlanSlotId, host: { key: string; name: string } | null) => void
  /** V8 — hand the effect browser a preset for one socket of one host */
  onBrowse: (preset: BrowsePreset) => void
  /** deep-link a donor (or the host item) into the Loot tab's drill-down — App's `openLoot` */
  onOpenLoot?: (item: string) => void
}

interface Picking {
  slot: PlanSlotId
  anchor: HTMLElement
}

export default function PlanBoard({
  plan,
  progress,
  onSocket,
  onHost,
  onBrowse,
  onOpenLoot
}: PlanBoardProps): JSX.Element {
  const { donors } = useDonors()
  const index = useMemo(() => indexDonors(donors), [donors])
  const { inventory, ready } = usePlannerInventory()
  const worn = useMemo(() => hostsBySlot(inventory), [inventory])
  const [picking, setPicking] = useState<Picking | null>(null)

  const pick = (hit: PlannerItemHit): void => {
    if (picking) onHost(picking.slot, { key: hit.key, name: hit.name })
    setPicking(null)
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
      {/* Only once the read has settled: a card that flashes before the dump loads would teach a
          command to someone who already ran it. */}
      {ready && inventory === null && <InstructionsCard />}
      {/* …and once a dump EXISTS, the same three facts compressed into one line, with the file's
          own mtime on the end (JOS-42 refinement 5). This is the case the card cannot cover: the
          hosts below render with total confidence whether the dump is a minute or a month old,
          and "updated 3d ago" is the difference between reading your gear and reading a memory of
          it. Exactly one of the two is ever on screen. */}
      {/* The mtime comes from the SAME read that gates the card above it (main resolves both from
          the registry's one status), so the two can never disagree about whether a dump exists —
          the command and the clause come from the registry itself. */}
      {inventory !== null && (
        <OutputFileLine
          command={INVENTORY.command}
          why={INVENTORY.why}
          updatedAt={inventory.loadedAt}
          steps={INVENTORY.steps}
          testId="planner-inventory-fresh"
        />
      )}
      <Box
        data-testid="planner-board"
        sx={{
          flexGrow: 1,
          minHeight: 0,
          overflow: 'auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 1,
          alignContent: 'start',
          pr: 0.5
        }}
      >
        {PLAN_SLOTS.map((slot) => (
          <PlanCell
            key={slot}
            slot={slot}
            planSlot={plan.slots[slot] ?? { sockets: {} }}
            planClasses={plan.classes}
            equipped={worn.get(slot)}
            index={index}
            progress={progress}
            onSocket={onSocket}
            onHost={onHost}
            onPickHost={(s, anchor) => setPicking({ slot: s, anchor })}
            onBrowse={(s, socket, host) =>
              onBrowse({ slot: s, socket, hostKey: host.key, hostName: host.name })
            }
            onOpenLoot={onOpenLoot}
          />
        ))}
      </Box>
      {picking && (
        <HostPicker
          slot={equipSlotOf(picking.slot)}
          label={planSlotLabel(picking.slot)}
          planClasses={plan.classes}
          anchor={picking.anchor}
          onClose={() => setPicking(null)}
          onPick={pick}
        />
      )}
    </Box>
  )
}
