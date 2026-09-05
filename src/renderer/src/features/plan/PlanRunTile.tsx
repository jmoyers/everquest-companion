// plan/PlanRunTile.tsx — ONE TRIP, AND WHAT IS WORTH GETTING ON IT
// (docs/plans/gear-progression-planner.md §1; `progressionPlan.ts GearRun`, fold rule 7).
//
// IT WAS `PlanRunRow.tsx` UNTIL 2026-08-15 AND THE RENAME IS THE POINT OF THE CHANGE. The owner sent
// a screenshot of the new zone-first layout on a ~2,500px window and asked: *"can we condense this to
// columns that auto fold and collapse so that if possible, multiple zones can be side-by-side"*. Each
// run had been one full-width ROW, so a window three times wider than the content still showed six
// zones stacked vertically with two thirds of the glass empty. A run is now a TILE in a responsive
// grid (`PlanBracketCard.tsx` owns the grid; this file owns what sits in a cell), and a file called
// `Row` that draws a tile would be the sort of stale name this tree does not keep.
//
// AND IT FOLDS. The tile's HEADING is a button: clicking it collapses the tile to that one line, so a
// reader scanning eight zones can shut the ones they have already read and let the grid reflow. Two
// deliberate limits on that: EXPANDED IS THE DEFAULT — a card whose items are hidden on arrival
// answers nothing, and both the e2e's claims and a first read need the targets visible — and the
// state is PLAIN COMPONENT STATE with no persistence. There is no `eq.plan.*` key for it, because a
// fold is a glance ("I have read this one"), not a preference, and a collapsed tile restored three
// days later would just be a zone the player cannot find.
//
// THE SHAPE THE ASK ACTUALLY ASKED FOR, and the reason this file exists at all. The first cut of
// the Plan tab drew a bracket as a flat top-eight list of items, and the fold's own rule 7 records
// what that cost, measured rather than predicted: at level 44 the Refined runs the owner really
// farms — Befallen 4, Runnyeye 4, Splitpaw 4 — never cracked a bracket-wide top eight against
// planes loot, so the feature's own subject never rendered. The ask was for PLACES ("it should say
// crushbone … mistmoore splitpaw"), a run earns its line by containing an upgrade for this trio AT
// ALL, and this component is that line.
//
// A BASE ZONE AND ITS REFINED TIER ARE DIFFERENT LINES, because they are different trips with
// different difficulty and different drops — `GearRun` groups on (zone, tier) for that reason and
// this file never collapses them back.
//
// TWO SILENCES WEAR THE SAME WORD AND DIFFERENT HOVERS, which is the one subtlety here.
// `band: null` on a run means EITHER "this is a +N trip and nothing on this machine states how hard
// a tiered creature is" (fold rule 2) OR "this is a base zone no mob of which states a level, so
// there is no profile to read". `plus` is what tells them apart, so `BandChip` takes both and picks
// the sentence. On a TARGET the ambiguity cannot arise — a base witness always carries a real band,
// because an unlevelled mob is not a target at all.
//
// THE HOVER COMPARISON IS THE GEAR TAB'S, THROUGH ITS ONE DOOR (direct owner ask, 2026-08-15 20:17:
// *"add in the comparison that the main gear tab does on hover"*). `GearRowCompare` is that door —
// the same wrapper the gear table's rows and the Exaltations donor names go through, carrying the
// three structural guarantees its header states (never opens upward, holds no pointer events, gone
// on the first pointerdown). Nothing is rebuilt here: the target's `key` is `itemKey(name)` is the
// key `GearCompareData.byKey` is keyed on, so the pair costs one `Map.get` per hover and this file
// contributes a `<span>`.
//
// AT BASE, ALWAYS — `PlanView` hands `useGearCompare` the constant `ITEM_UPGRADE_BASE`, the
// EffectBrowser's own choice and for a reason this surface holds even harder: fold rule 6 scores
// every target off BASE stats ("base stats can be used, that's fine, because we can upgrade"), so a
// card simulating a tier would contradict the ranking that put the row on screen. The card's
// "simulated at Tier N" line correctly never appears.
//
// EVERY ROW IS `nowrap` WITH ONE SHRINKABLE GROUP (the flexWrap law), and the tile layout is what
// makes that rule load-bearing rather than tidy. A tile is ~320px wide instead of ~1,200, so item
// names and mob text now genuinely run out of room — they ellipsize inside their one `minWidth: 0`
// group while every chip stays `flexShrink: 0`, and the facts that got clipped are on the row's
// `title` instead. A tile that widened to fit its longest item name would break the grid's columns
// and put the page back into the sideways scroll the standing law forbids. The wish control is the
// one exception, and it is the shared control's own rule (`WishToggle`, JOS-346): it shrinks beside
// the name rather than refusing to, and its label clips with the full sentence still on its title.

import { useState, type JSX } from 'react'
import { Box, Chip, IconButton, Stack, Typography } from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import MapIcon from '@mui/icons-material/Map'
import type { ConBand } from '@shared/conBands'
import type { GearRun, GearTarget } from '@shared/planner/progressionPlan'
import type { ZoneShort } from '@shared/maps'
// The catalog-spelling fold, refuse-over-guess: only a zone the table resolves becomes a door.
import { zoneShortNameFromCatalog } from '@shared/zones'
import { itemIconUrl } from '../../lib/ItemWindow'
// THE ONE DOOR a compare card may reach any surface through (JOS-344). Its header states the three
// guarantees and the measured geometry that made the anchoring law what it is.
import { GearRowCompare } from '../gear/GearCompareCard'
import type { GearCompareData } from '../gear/gearData'
import { isCommonMob } from '@shared/mobNames'
import type { MobTarget } from '../mobs/mobTarget'
import { DonorName } from '../planner/PlannerChips'
import { CellLink } from '../../lib/CellLink'
// THE ONE WISH CONTROL (JOS-343/346): the same component the Gear and Exaltations rows draw, with the
// same two sentences, so a reader who learned it on one tab meets no second spelling here.
import WishToggle from '../wishlist/WishToggle'
import { mobEntryOf } from './planData'

/**
 * What each band means for a plan, said once — the chip's hover wherever one is drawn. ONE CLAUSE
 * EACH (the tooltip diet): the colour and where the fight sits, nothing about what to do with it.
 */
const BAND_HINT: Record<ConBand, string> = {
  trivial: 'Grey - far below you.',
  safe: 'Blue - below you.',
  even: 'White - an even fight.',
  risky: 'Above you.',
  deadly: 'Well above you.'
}

/** A `+N` trip: the refusal, worded. Plan §3, fold rule 2. */
const TIER_UNSTATED_HINT = 'No level is stated for a +N mob.'
/** …and the OTHER silence: a base zone whose mobs state no level, so there is no profile to read. */
const UNPROFILED_HINT = 'No mob in this zone states a level.'

/** `safe` / `even` / `difficulty unstated` — never a colour the game does not state (see below). */
function BandChip({ band, plus }: { band: ConBand | null; plus: number | null }): JSX.Element {
  return (
    <Chip
      size="small"
      variant="outlined"
      data-testid="plan-band"
      label={band ?? 'difficulty unstated'}
      title={band !== null ? BAND_HINT[band] : plus !== null ? TIER_UNSTATED_HINT : UNPROFILED_HINT}
      sx={{ flexShrink: 0 }}
    />
  )
}

/** The tiered spelling the wiki uses, composed here — `GearRun.zone` is the BASE spelling. */
function runLabel(run: GearRun): string {
  const zone = run.zone === '' ? 'no zone stated' : run.zone
  return run.plus === null ? zone : `${zone} +${String(run.plus)}`
}

/** Which mob, at what level the CATALOG states, in which zone — the stated witness, composed. */
/** `SECONDARY` → `Secondary` — the slot chip's one word (the vocabulary is single tokens). */
function slotWord(slot: string): string {
  return slot.charAt(0) + slot.slice(1).toLowerCase()
}

/** The slot a target cleared in (fork ask, kaltinril 2026-09-04) — flexShrink 0: one short word
 *  that sits OUTSIDE the tile's shrinkable group entirely, so the name and mob ellipsize and the
 *  slot never clips (fork report: it printed cut off inside the group). Null for a wished
 *  non-upgrade, which cleared nothing and claims nothing. */
function SlotChip({ slot }: { slot: GearTarget['slot'] }): JSX.Element | null {
  if (slot === undefined) return null
  return (
    <Typography variant="caption" color="text.secondary" data-testid="plan-target-slot" sx={{ flexShrink: 0 }}>
      {slotWord(slot)}
    </Typography>
  )
}

function mobText(target: GearTarget): string {
  const mob = target.plus === null ? target.mob : `${target.mob} +${String(target.plus)}`
  return target.mobLevel === null ? mob : `${mob} (Lvl ${String(target.mobLevel)})`
}

/** The pointer, worded: `quest: <name> — <giver>` for the quest lane, the mob witness otherwise. */
function witnessText(target: GearTarget): string {
  if (target.quest === undefined) return mobText(target)
  return `quest: ${target.quest}${target.mob === '' ? '' : ` — ${target.mob}`}`
}

/**
 * THE WITNESS LINE — its own row under the name since the 2026-09-05 relayout (fork report: *"the
 * mob it drops from is now hidden by lack of space"* — the name, slot word and wish control left
 * the mob a sliver, and the tooltip was carrying what the tile should say). A second line costs
 * height the grid can afford; a witness nobody can read costs the whole point of the row.
 */
function WitnessLine({ target, onOpenMob }: { target: GearTarget; onOpenMob?: ((t: MobTarget) => void) | undefined }): JSX.Element {
  // NAMED, BASE-ZONE witnesses only (owner ruling, 2026-08-18): a `+N` witness names a creature
  // the catalog has no row for (planData header), and a common's bare name can mean nine pages —
  // both stay the plain text they were rather than linking to a guess. A quest is not a mob at all.
  const mobLinked =
    onOpenMob !== undefined && target.quest === undefined && target.plus === null && !isCommonMob(target.mob)
  return (
    <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', minWidth: 0, pl: 4.5 }}>
      {mobLinked ? (
        <>
          <CellLink text={target.mob} onOpen={() => { onOpenMob(mobTargetOf(target)) }} />
          {target.mobLevel === null ? '' : ` (Lvl ${String(target.mobLevel)})`}
        </>
      ) : (
        witnessText(target)
      )}
    </Typography>
  )
}

/**
 * THE MOB CLICK, with the page the item page named PINNED (`GearTarget.mobPage` → `MobTarget.entry`).
 * A name resolves to one page of possibly several; the entry is the row the wiki actually linked, so
 * the Mobs tab opens on that one. A page the catalog does not hold falls back to the bare name, which
 * is what the click did before the pin existed.
 */
function mobTargetOf(target: GearTarget): MobTarget {
  const entry = mobEntryOf(target.mobPage ?? target.mob)
  return entry === undefined ? { mob: target.mob } : { mob: target.mob, entry }
}

/**
 * ONE TARGET. The item name is the Loot drill-down AND the hover comparison — the same two
 * affordances a gear search row carries, reached the same two ways — and the wish control is the
 * gear search row's own (`WishToggle`), reading the fold's `wished` flag. A wished row is here
 * precisely BECAUSE it is wished (rule 9: flagged, never filtered), and the control's REMOVE state
 * is what says so; there is no second chip restating it.
 *
 * An icon only when the corpus has one; `itemIconUrl` is the app's permanent image cache, so a miss
 * 404s and `onError` hides the element, exactly as it does in the item window and the loot dialog.
 */
function TargetRow({
  target,
  runBand,
  compare,
  onOpenLoot,
  onOpenMob,
  onToggleWish
}: {
  target: GearTarget
  /** the band its RUN heading already printed — see the chip rule below */
  runBand: ConBand | null
  compare?: GearCompareData
  onOpenLoot?: (item: string) => void
  /** the witness mob's door to its page (App's `openMob`); absent, the plain text it was */
  onOpenMob?: ((t: MobTarget) => void) | undefined
  /** on or off the wish list (`usePlanWishes.toggle`); absent until the document has loaded */
  onToggleWish?: ((t: GearTarget) => void) | undefined
}): JSX.Element {
  const name = <DonorName name={target.name} bold onOpen={onOpenLoot} />
  const row = compare?.byKey.get(target.key)
  return (
    <Box
      data-testid="plan-target"
      data-item-key={target.key}
      data-wished={target.wished ? 'true' : undefined}
      title={`${target.name} - ${witnessText(target)}`}
      sx={{ minWidth: 0, py: 0.25, pl: 1 }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'nowrap', minWidth: 0 }}>
        {target.iconId !== undefined && (
          <Box
            component="img"
            src={itemIconUrl(target.iconId)}
            alt=""
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
            sx={{ width: 20, height: 20, flexShrink: 0 }}
          />
        )}
        {/* THE ONE SHRINKABLE GROUP: the name, ellipsizing alone — the witness has its own line. */}
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minWidth: 0, flexGrow: 1, overflow: 'hidden' }}>
          {compare !== undefined && row !== undefined ? (
            <GearRowCompare row={row} data={compare}>
              <span>{name}</span>
            </GearRowCompare>
          ) : (
            name
          )}
        </Box>
        <SlotChip slot={target.slot} />
        {onToggleWish !== undefined && (
          <WishToggle
            name={target.name}
            wished={target.wished}
            testId="plan-target-wish"
            onToggle={() => {
              onToggleWish(target)
            }}
          />
        )}
        {/* THE BAND ONLY WHEN IT ADDS SOMETHING. A run's heading already states one band for the
            whole trip, and inside a ~320px tile repeating it on every row costs the width the item
            name needs — worst case a `+N` run printing "difficulty unstated" four times in a column
            that fits it once. A target whose band DIFFERS from its run's still draws its own chip,
            because that is a real fact about a different mob; a target that agrees says nothing
            twice. Nothing is hidden by this rule that the tile is not already showing one line
            above. */}
        {target.band !== runBand && <BandChip band={target.band} plus={target.plus} />}
      </Stack>
      <WitnessLine target={target} onOpenMob={onOpenMob} />
    </Box>
  )
}

export interface PlanRunTileProps {
  run: GearRun
  /** the Gear tab's comparison seam; ABSENT means no card, the `GearTable` house rule */
  compare?: GearCompareData
  onOpenLoot?: (item: string) => void
  /** this trip's door to its map (App's `openMapZone`); absent, the heading stands alone */
  onOpenMapZone?: (zone: ZoneShort) => void
  /** a named witness mob's door to its page (App's `openMob`) — TargetRow states the gate */
  onOpenMob?: (t: MobTarget) => void
  /** each row's wish control (`usePlanWishes.toggle`); absent until the wish document has loaded */
  onToggleWish?: (t: GearTarget) => void
}

/**
 * ONE RUN, AS A TILE: the place, its difficulty, how many things are in it, and — until you fold it
 * — up to three of them.
 *
 * THE TESTIDS ARE UNCHANGED THROUGH THE RELAYOUT (`plan-run`, `plan-run-head`, `plan-target`,
 * `plan-band`; `plan-target-wish` is the per-row control, and the `plan-wished` chip it replaced is
 * gone — `data-wished` on the row was always the statement the specs read) and so is the DOM
 * nesting the specs read: a `plan-run` still holds one `plan-run-head` and its `plan-target`s as
 * descendants. `tests/e2e/plan.e2e.mts` walks exactly that shape, and a layout change that renamed
 * a hook would have made a visual tweak look like a behaviour change in the one suite that cannot
 * be run casually.
 *
 * THE COUNT IS IN THE HEADING because the heading is all that survives a fold: "Befallen +4 · 3" is
 * still an answer when the items are hidden, where a bare zone name would leave a reader unable to
 * tell a rich trip from a thin one without opening every tile. It is rendered as its own node so the
 * chevron and the count cannot be mistaken for part of the place's name.
 */
export default function PlanRunTile({ run, compare, onOpenLoot, onOpenMapZone, onOpenMob, onToggleWish }: PlanRunTileProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  // The trip's door to its map (user ruling, 2026-08-18) — its own button BESIDE the heading,
  // because the heading IS the fold button and a control inside a control answers to neither.
  // Present exactly when the table resolves the base zone's spelling and the host routes it.
  const stem = onOpenMapZone === undefined ? null : zoneShortNameFromCatalog(run.zone)
  return (
    <Box
      data-testid="plan-run"
      data-zone={run.zone}
      data-plus={run.plus === null ? '' : String(run.plus)}
      // THE TILE'S OWN STATE, on the tile rather than on the heading: what folds is the whole run,
      // and a spec asserting the fold wants `[data-testid="plan-run"][data-collapsed="true"]`.
      data-collapsed={collapsed ? 'true' : 'false'}
      // `minWidth: 0` is what lets the grid column shrink at all — without it a grid item's automatic
      // minimum is its content, and one long item name would widen the whole column past its track.
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        p: 0.75,
        minWidth: 0,
        overflow: 'hidden'
      }}
    >
      {/* THE HEADING IS ITS OWN NODE (`plan-run-head`) so a reader — human or spec — can take the
          place and its verdict as ONE string. The band sits on the same `nowrap` row, so reading
          the Box's first text line would depend on where the browser chose to break it.
          It is also the FOLD CONTROL: a real <button> element, so the keyboard and a screen reader
          reach it the same way the pointer does, with the MUI button reset undone by `sx` because a
          heading that looked like a button would shout on a page of eight of them. */}
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexWrap: 'nowrap', minWidth: 0 }}>
        <Stack
          component="button"
          type="button"
          direction="row"
          spacing={1}
          alignItems="center"
          data-testid="plan-run-head"
          aria-expanded={!collapsed}
          title={collapsed ? 'Show what is worth getting here' : 'Fold this trip down to its heading'}
          onClick={() => {
            setCollapsed((v) => !v)
          }}
          sx={{
            flexWrap: 'nowrap',
            minWidth: 0,
            flexGrow: 1,
            font: 'inherit',
            color: 'inherit',
            textAlign: 'left',
            background: 'none',
            border: 0,
            p: 0,
            cursor: 'pointer'
          }}
        >
          {/* An SVG affordance rather than a text glyph, deliberately: the specs read this node's
              `innerText` and assert the zone name is in it, so the chevron must contribute no text. */}
          {collapsed ? (
            <ChevronRightIcon fontSize="small" sx={{ flexShrink: 0, opacity: 0.7 }} />
          ) : (
            <ExpandMoreIcon fontSize="small" sx={{ flexShrink: 0, opacity: 0.7 }} />
          )}
          <Typography variant="body2" fontWeight={600} noWrap sx={{ minWidth: 0 }}>
            {runLabel(run)}
          </Typography>
          <BandChip band={run.band} plus={run.plus} />
          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
            {run.targets.length}
          </Typography>
        </Stack>
        {stem !== null && onOpenMapZone !== undefined && (
          <IconButton
            size="small"
            data-testid="plan-run-map"
            title="Open this zone's map"
            onClick={() => {
              onOpenMapZone(stem)
            }}
            sx={{ flexShrink: 0, p: 0.25 }}
          >
            <MapIcon sx={{ fontSize: 15 }} />
          </IconButton>
        )}
      </Stack>
      {!collapsed &&
        run.targets.map((target) => (
          <TargetRow
            key={target.key}
            target={target}
            runBand={run.band}
            compare={compare}
            onOpenLoot={onOpenLoot}
            onOpenMob={onOpenMob}
            onToggleWish={onToggleWish}
          />
        ))}
    </Box>
  )
}
