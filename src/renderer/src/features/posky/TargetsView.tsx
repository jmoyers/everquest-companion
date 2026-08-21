// TargetsView — the Targets tab (issue #30): every mob still worth killing, and why.
//
// The MODEL is skyTargets.ts (pure, node-tested); this file only draws it. Mob-major on purpose:
// the Quests tab answers "what does this quest need" and players were inverting it in their heads
// to the question they actually walk the islands with. Its own file on the ClassUnlockList
// precedent - PoskyView is a container near its measured line ceiling, and a tab that draws its
// own rows rather than quest accordions is a view of its own.
//
// THE ORDER OF THE PANE IS THE ORDER OF USEFULNESS: mob cards first - each one an actionable pull
// - then the collective random-drop entry (the Wind Runes, which any Sky mob can drop), then the
// no-known-source note, which is missing DATA stated out loud rather than hidden (law 1).
//
// THE MOB CARDS ARE GROUPED BY ISLAND, IN WALK ORDER (JOS-423, owner directive). The model sorts
// them island-ascending with the old counted order kept as the tiebreak inside an island
// (skyTargets.ts argues both); this file draws that structure as HEADINGS rather than as a badge
// on every card, for three reasons. (1) The pane ALREADY speaks in titled sections - the two
// remainders below are exactly this shape - so an "Island 5" heading is the tab's existing visual
// language, not a new one; the island a player is standing on is a place they are in for a whole
// stretch of the list, which is what a heading means and what a per-card chip does not. (2) A chip
// repeated down fourteen consecutive cards is fourteen readings of one fact, and the caption it
// replaces sat inline with the mob name where it competed with the thing the row is FOR. (3) The
// unstated-island group needs a sentence, not a number, and only a heading can carry one - it is
// the same honest-remainder rendering the no-known-source note uses, one level up.
// The per-card caption SURVIVES for the one thing a heading cannot say: a mob whose outstanding
// drops span more than the heading's island keeps its full "Islands 3, 5" line, so grouping never
// silently narrows what the card claimed.
//
// EVERY NAME ON THIS PANE IS A DOOR, because the tab exists to be left. The MOB names go through
// `DropperName` - the same component the Quests tab's dropper cells use, exported from
// DropperCell.tsx rather than copied - so a card opens the same mob page with the same catalog row
// a search hit would. The QUEST names go through `revealQuest` (JOS-417), the deep link a
// celebration toast already uses: it switches to the Quests tab, clears every filter and searches
// the quest's name, so arriving from here is indistinguishable from having typed it. That is what
// makes the item lines a link to the quests rather than a mention of them, and the reason it is
// `revealQuest` and not a second navigation is that a name is exactly the ask a deep link answers.
// No Popper anywhere (JOS-143); the one hover is a native `title` carrying the same `dropperFacts`
// roster line the Quests tab shows, so the two tabs answer "who is this mob" with identical words.
//
// THE COUNT SOURCE RIDES THE PANE HEADER, above both states, on the Ready tab's JOS-294
// argument: the source decides every shortfall on this tab (a rotated log under `log` reads
// held 0 for everything and overstates the whole list), so the control that changes the
// membership has to be visible where the membership is read - and reachable when it has
// emptied the pane. THE FIRST-TIME TOGGLE (JOS-417) rides beside it for the identical reason,
// and it is the Ready tab's control down to the wording: a box that can empty a tab has to stay
// reachable when it has.

import type { JSX } from 'react'
import { Box, Checkbox, Chip, FormControlLabel, Link, Stack, Typography } from '@mui/material'
import type { CountSource } from '@shared/types'
import { dropperFacts, islandLabel, islandNumber } from './poskyDroppers'
import { DropperName } from './DropperCell'
import { InventorySource } from './QuestFilterBar'
import { groupTargetsByIsland, type NeededItem, type SkyTargetsModel, type TargetMob } from './skyTargets'
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
function NeededItemLine({
  item,
  onOpenQuest
}: {
  item: NeededItem
  onOpenQuest: (name: string) => void
}): JSX.Element {
  return (
    <Typography variant="body2" data-testid="sky-target-item">
      {item.shortfall}x <strong>{item.name}</strong>
      <Typography component="span" variant="body2" color="text.secondary">
        {' - '}
        {item.quests.map((q, i) => (
          // KEYED BY CLASS AND NAME, never by name alone: a Sky quest name occurs under more than
          // one class (`ambiguousQuestNames`), and the same item can be wanted by both.
          <span key={`${q.className}::${q.questName}`}>
            {i > 0 ? ', ' : ''}
            <Link
              component="button"
              type="button"
              variant="body2"
              underline="hover"
              color="inherit"
              data-testid="sky-target-quest"
              onClick={() => {
                onOpenQuest(q.questName)
              }}
            >
              {q.questName}
            </Link>
            {q.need > 1 ? ` x${String(q.need)}` : ''}
          </span>
        ))}
      </Typography>
    </Typography>
  )
}

/** One mob card: the clickable name, where its outstanding drops are, and what it still yields.
 *  The island caption is drawn ONLY where it says more than the heading above the card already
 *  does - i.e. when this mob's drops span a second island - so the common case reads once and the
 *  uncommon one is never quietly narrowed to its first island. */
function TargetRow({
  target,
  onOpenMob,
  onOpenQuest
}: {
  target: TargetMob
  onOpenMob: (t: MobTarget) => void
  onOpenQuest: (name: string) => void
}): JSX.Element {
  const islands = target.islands.length > 1 ? islandLabel(target.islands) : ''
  return (
    <Box
      data-testid={`sky-target-row-${rowSlug(target.mob.page)}`}
      data-covers={target.covers}
      sx={{ border: 1, borderColor: 'divider', borderRadius: 1, px: 2, py: 1.5 }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        {/* The same facts roster the Quests tab's dropper cell hovers - an OS tooltip, no DOM. */}
        <Typography variant="subtitle2" component="span" title={dropperFacts(target.mob)}>
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
          <NeededItemLine key={it.name} item={it} onOpenQuest={onOpenQuest} />
        ))}
      </Stack>
    </Box>
  )
}

/** The heading over one island's cards. A number when posky states one; otherwise a SENTENCE - the
 *  no-known-source note's law one level up: an island the data never stated is said out loud and
 *  sorted last, never dressed up as a guessed number (law 1). */
const UNSTATED_ISLAND_TITLE = 'Island not stated - the drop data does not say where these are'

/** One island's cards under their heading. `data-island` carries the sortable number (or `none`)
 *  so a test can read the pane's walk order without parsing the heading's prose. */
function IslandSection({
  island,
  mobs,
  onOpenMob,
  onOpenQuest
}: {
  island: string | null
  mobs: readonly TargetMob[]
  onOpenMob: (t: MobTarget) => void
  onOpenQuest: (name: string) => void
}): JSX.Element {
  return (
    <Box
      data-testid="sky-target-island"
      data-island={island === null ? 'none' : String(islandNumber(island))}
    >
      {/* `subtitle2` is the weight both remainder sections below title themselves with - the
          headings are the same kind of thing and must not read as a different rank. Secondary
          colour because a heading is scaffolding for the cards, never a row in its own right. */}
      <Typography
        variant="subtitle2"
        color="text.secondary"
        component="div"
        data-testid="sky-target-island-title"
        sx={{ mb: 0.75 }}
      >
        {island ?? UNSTATED_ISLAND_TITLE}
      </Typography>
      <Stack spacing={1.5}>
        {mobs.map((t) => (
          <TargetRow key={t.mob.page} target={t} onOpenMob={onOpenMob} onOpenQuest={onOpenQuest} />
        ))}
      </Stack>
    </Box>
  )
}

/** The two honest remainders share one rendering: a titled list of the same item lines. */
function RemainderSection({
  title,
  items,
  testid,
  onOpenQuest
}: {
  title: string
  items: readonly NeededItem[]
  testid: string
  onOpenQuest: (name: string) => void
}): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <Box data-testid={testid} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, px: 2, py: 1.5 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        {title}
      </Typography>
      <Stack spacing={0.25}>
        {items.map((it) => (
          <NeededItemLine key={it.name} item={it} onOpenQuest={onOpenQuest} />
        ))}
      </Stack>
    </Box>
  )
}

/** The tab's one narrowing control (JOS-417) - the Ready tab's box, one tab over and worded for
 *  what this list is made of. Drawn above BOTH states, because it is the likeliest reason the
 *  pane is empty. */
function TargetsFirstTimeToggle({
  firstTimeOnly,
  onFirstTimeOnly
}: {
  firstTimeOnly: boolean
  onFirstTimeOnly: (v: boolean) => void
}): JSX.Element {
  return (
    <FormControlLabel
      control={
        <Checkbox
          size="small"
          checked={firstTimeOnly}
          data-testid="posky-targets-first-time"
          onChange={(e) => {
            onFirstTimeOnly(e.target.checked)
          }}
        />
      }
      label="Only quests I have never turned in"
    />
  )
}

export interface TargetsViewProps {
  targets: SkyTargetsModel
  onOpenMob: (t: MobTarget) => void
  /** a quest NAME to reveal on the Quests tab - `QuestListState.revealQuest`, the deep link */
  onOpenQuest: (name: string) => void
  countSource: CountSource
  onCountSource: (s: CountSource) => void
  inventoryLoadedAt: number | null
  firstTimeOnly: boolean
  onFirstTimeOnly: (v: boolean) => void
  /** quests the toggle is holding back that still want items; 0 when it is unticked */
  refarmCount: number
}

/**
 * The pane. The count line reads the same `mobs` array the tab label counts, so the number on
 * the tab, the number up here and the rows below can never disagree.
 *
 * THE EMPTY STATE NAMES THE RULE THAT EMPTIED IT, and since JOS-417 it names the RIGHT one. The
 * contributed copy ended "a quest joins this list the moment it needs something again", which the
 * first-time need set makes false for every quest you have handed in - they never rejoin, which is
 * the box's whole point. So the sentence now says what the code does and points at the control
 * that changes it, with the held-back count when there is one (the Ready tab's empty-state shape).
 * The header row leaves `mb: 2.5` for the same reason ReadyList's does: the source caption is an
 * overlay hanging off the dropdown's bottom edge.
 */
export function TargetsView({
  targets,
  onOpenMob,
  onOpenQuest,
  countSource,
  onCountSource,
  inventoryLoadedAt,
  firstTimeOnly,
  onFirstTimeOnly,
  refarmCount
}: TargetsViewProps): JSX.Element {
  const n = targets.mobs.length
  const empty = n === 0 && targets.randomDrop.length === 0 && targets.unsourced.length === 0
  const behindTheBox =
    firstTimeOnly && refarmCount > 0
      ? ` ${String(refarmCount)} quest${refarmCount === 1 ? '' : 's'} you have run before still want${refarmCount === 1 ? 's' : ''} items - untick the box to hunt for ${refarmCount === 1 ? 'it' : 'them'} too.`
      : ''
  return (
    <Box data-testid="posky-targets" sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto' }}>
      <Stack direction="row" spacing={2} alignItems="center" useFlexGap sx={{ mb: 2.5 }}>
        <TargetsFirstTimeToggle firstTimeOnly={firstTimeOnly} onFirstTimeOnly={onFirstTimeOnly} />
        <Box sx={{ flexGrow: 1 }} />
        <InventorySource
          countSource={countSource}
          onCountSource={onCountSource}
          inventoryLoadedAt={inventoryLoadedAt}
        />
      </Stack>
      {empty ? (
        <Typography color="text.secondary" data-testid="posky-targets-empty">
          Nothing left to hunt - every quest you are tracking is ignored, holding everything it
          needs, or {firstTimeOnly ? 'already turned in' : 'wanting nothing'}.{behindTheBox}
        </Typography>
      ) : (
        <Stack spacing={1.5}>
          <Typography variant="body2" color="text.secondary" data-testid="posky-targets-count">
            {n === 0
              ? 'No kill targets right now - what is left is below.'
              : `${String(n)} mob${n === 1 ? '' : 's'} still worth killing - island by island, and inside an island the ones that close the most of what is left come first.`}
            {behindTheBox}
          </Typography>
          {groupTargetsByIsland(targets.mobs).map((g) => (
            <IslandSection
              key={g.island ?? 'none'}
              island={g.island}
              mobs={g.mobs}
              onOpenMob={onOpenMob}
              onOpenQuest={onOpenQuest}
            />
          ))}
          <RemainderSection
            title="Random drops - any Plane of Sky mob can drop these"
            items={targets.randomDrop}
            testid="posky-targets-random"
            onOpenQuest={onOpenQuest}
          />
          <RemainderSection
            title="No known source - the drop data does not say who carries these"
            items={targets.unsourced}
            testid="posky-targets-unsourced"
            onOpenQuest={onOpenQuest}
          />
        </Stack>
      )}
    </Box>
  )
}
