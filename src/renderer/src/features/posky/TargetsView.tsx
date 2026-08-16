// TargetsView — the Targets tab (issue #30): every mob still worth killing, and why.
//
// The MODEL is skyTargets.ts (pure, node-tested); this file only draws it. Mob-major on purpose:
// the Quests tab answers "what does this quest need" and players were inverting it in their heads
// to the question they actually walk the islands with. Its own file on the ClassUnlockList
// precedent - PoskyView is a container near its measured line ceiling, and a tab that draws its
// own rows rather than quest accordions is a view of its own.
//
// THE ORDER OF THE PANE IS THE ORDER OF USEFULNESS (plan KTD): mob cards first - each one an
// actionable pull - then the collective random-drop entry (the Wind Runes, which any Sky mob can
// drop), then the no-known-source note, which is missing DATA stated out loud rather than hidden
// (law 1). The mob order inside the first section is counted, not guessed: most still-needed
// items covered first, ties by name (skyTargets.ts argues it).
//
// The names are the link, exactly as the Quests tab's dropper cells: `DropperName` is the same
// component (exported from DropperCell.tsx rather than copied), so a mob card opens the same mob
// page with the same catalog row a search hit would. No Popper anywhere (JOS-143); the only
// hover is the native `title` a name already carries.

import type { JSX } from 'react'
import { Box, Chip, Stack, Typography } from '@mui/material'
import { islandLabel } from './poskyDroppers'
import { DropperName } from './DropperCell'
import type { NeededItem, SkyTargetsModel, TargetMob } from './skyTargets'
import type { MobTarget } from '../mobs/mobTarget'

/** Selector-safe row handle: `sky-target-row-the-spiroc-lord`. */
function rowSlug(page: string): string {
  return page.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
}

/**
 * One still-needed item, as one line: how many are missing across every quest that wants it, and
 * the quests by name. The count is the AGGREGATE shortfall (skyTargets.ts: summed need minus the
 * uncapped held) - there is deliberately no per-quest split of the held copies, because any split
 * would be invented semantics. A quest needing more than one says so beside its own name.
 */
function NeededItemLine({ item }: { item: NeededItem }): JSX.Element {
  const quests = item.quests
    .map((q) => (q.need > 1 ? `${q.questName} x${String(q.need)}` : q.questName))
    .join(', ')
  return (
    <Typography variant="body2" data-testid="sky-target-item">
      {item.shortfall}x <strong>{item.name}</strong>
      <Typography component="span" variant="body2" color="text.secondary">
        {' '}
        - {quests}
      </Typography>
    </Typography>
  )
}

/** One mob card: the clickable name, where its outstanding drops are, and what it still yields. */
function TargetRow({ target, onOpenMob }: { target: TargetMob; onOpenMob: (t: MobTarget) => void }): JSX.Element {
  const islands = islandLabel(target.islands)
  return (
    <Box
      data-testid={`sky-target-row-${rowSlug(target.mob.page)}`}
      data-covers={target.covers}
      sx={{ border: 1, borderColor: 'divider', borderRadius: 1, px: 2, py: 1.5 }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <Typography variant="subtitle2" component="span">
          <DropperName mob={target.mob} onOpenMob={onOpenMob} />
        </Typography>
        {islands !== '' && (
          <Typography variant="caption" color="text.secondary">
            {islands}
          </Typography>
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Chip
          size="small"
          variant="outlined"
          label={`${String(target.covers)} item${target.covers === 1 ? '' : 's'}`}
        />
      </Stack>
      <Stack spacing={0.25}>
        {target.items.map((it) => (
          <NeededItemLine key={it.name} item={it} />
        ))}
      </Stack>
    </Box>
  )
}

/** The two honest remainders share one rendering: a titled list of the same item lines. */
function RemainderSection({
  title,
  items,
  testid
}: {
  title: string
  items: readonly NeededItem[]
  testid: string
}): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <Box data-testid={testid} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, px: 2, py: 1.5 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        {title}
      </Typography>
      <Stack spacing={0.25}>
        {items.map((it) => (
          <NeededItemLine key={it.name} item={it} />
        ))}
      </Stack>
    </Box>
  )
}

export interface TargetsViewProps {
  targets: SkyTargetsModel
  onOpenMob: (t: MobTarget) => void
}

/**
 * The pane. The count line reads the same `mobs` array the tab label counts, so the number on
 * the tab, the number up here and the rows below can never disagree. The empty state names the
 * rule that emptied it ("state, never process") - a fresh character sees a full list, a finished
 * one sees why there is nothing left.
 */
export function TargetsView({ targets, onOpenMob }: TargetsViewProps): JSX.Element {
  const n = targets.mobs.length
  const empty = n === 0 && targets.randomDrop.length === 0 && targets.unsourced.length === 0
  return (
    <Box data-testid="posky-targets" sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto' }}>
      {empty ? (
        <Typography color="text.secondary">
          Nothing left to hunt - every quest you are tracking is turned in, ignored, or already
          has its items. A quest joins this list the moment it needs something again.
        </Typography>
      ) : (
        <Stack spacing={1.5}>
          <Typography variant="body2" color="text.secondary" data-testid="posky-targets-count">
            {n === 0
              ? 'No kill targets right now - what is left is below.'
              : `${String(n)} mob${n === 1 ? '' : 's'} still worth killing. Mobs that close the most of what is left sort first.`}
            {' Derived from your quest progress and the committed drop data - never a guess.'}
          </Typography>
          {targets.mobs.map((t) => (
            <TargetRow key={t.mob.page} target={t} onOpenMob={onOpenMob} />
          ))}
          <RemainderSection
            title="Random drops - any Plane of Sky mob can drop these"
            items={targets.randomDrop}
            testid="posky-targets-random"
          />
          <RemainderSection
            title="No known source - the drop data does not say who carries these"
            items={targets.unsourced}
            testid="posky-targets-unsourced"
          />
        </Stack>
      )}
    </Box>
  )
}
