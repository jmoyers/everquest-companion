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
// and put the page back into the sideways scroll the standing law forbids.

import { useState, type JSX } from 'react'
import { Box, Chip, Stack, Typography } from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import type { ConBand } from '@shared/conBands'
import type { GearRun, GearTarget } from '@shared/planner/progressionPlan'
import { itemIconUrl } from '../../lib/ItemWindow'
// THE ONE DOOR a compare card may reach any surface through (JOS-344). Its header states the three
// guarantees and the measured geometry that made the anchoring law what it is.
import { GearRowCompare } from '../gear/GearCompareCard'
import type { GearCompareData } from '../gear/gearData'
import { DonorName } from '../planner/PlannerChips'

/** What each band means for a plan, said once — the chip's hover wherever one is drawn. */
const BAND_HINT: Record<ConBand, string> = {
  trivial: 'Grey: far below you, and the easiest farm there is. Fine for loot, worthless for exp.',
  safe: 'Blue: comfortably below you.',
  even: 'White: an even fight at this level.',
  risky: 'Above you - the log`s "would wipe the floor with you!" range.',
  deadly: 'Well above you.'
}

/** A `+N` trip: the refusal, worded. Plan §3, fold rule 2. */
const TIER_UNSTATED_HINT =
  'Nothing states how hard a tiered creature is. The catalog gives no level for any +N mob, so this line says where to go and declines to guess the fight.'
/** …and the OTHER silence: a base zone whose mobs state no level, so there is no profile to read. */
const UNPROFILED_HINT =
  'No mob the catalog places in this zone states a level, so this app has no profile to con it against.'

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
function mobText(target: GearTarget): string {
  const mob = target.plus === null ? target.mob : `${target.mob} +${String(target.plus)}`
  return target.mobLevel === null ? mob : `${mob} (Lvl ${String(target.mobLevel)})`
}

/**
 * ALREADY ON THE WISH LIST. It is a FLAG and not a filter (fold rule 9): a wished item bypasses the
 * upgrade-gap test and sorts first, so the row is here precisely BECAUSE it is wished, and saying
 * nothing would leave a reader wondering why an item they own the intent to get keeps leading.
 */
function WishedChip(): JSX.Element {
  return (
    <Chip
      size="small"
      variant="outlined"
      color="primary"
      label="wished"
      data-testid="plan-wished"
      title="Already on your wish list. A wished item skips the upgrade test and leads the run - you asking for it outranks any score this app computes."
      sx={{ flexShrink: 0 }}
    />
  )
}

/**
 * ONE TARGET. The item name is the Loot drill-down AND the hover comparison — the same two
 * affordances a gear search row carries, reached the same two ways.
 *
 * An icon only when the corpus has one; `itemIconUrl` is the app's permanent image cache, so a miss
 * 404s and `onError` hides the element, exactly as it does in the item window and the loot dialog.
 */
function TargetRow({
  target,
  runBand,
  compare,
  onOpenLoot
}: {
  target: GearTarget
  /** the band its RUN heading already printed — see the chip rule below */
  runBand: ConBand | null
  compare?: GearCompareData
  onOpenLoot?: (item: string) => void
}): JSX.Element {
  const name = <DonorName name={target.name} bold onOpen={onOpenLoot} />
  const row = compare?.byKey.get(target.key)
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      data-testid="plan-target"
      data-item-key={target.key}
      data-wished={target.wished ? 'true' : undefined}
      // THE SCORE LIVES HERE AND NOWHERE ELSE. `roleValue` is a heuristic rank with an invented
      // weights table behind it, so it is worth saying what ordered the list and it is not worth a
      // column that would read like a stat off the item page.
      //
      // AND SINCE THE TILE LAYOUT, THE WITNESS RIDES ALONG. In a ~320px column the mob text is the
      // first thing to ellipsize, so the hover carries what the row had to clip — the alternative
      // (letting the tile grow to fit) is the one thing the grid must not do.
      title={`${target.name} - ${mobText(target)}. Ranked ${String(target.score)} for this role - a heuristic ordering, not a game stat.`}
      sx={{ flexWrap: 'nowrap', minWidth: 0, py: 0.25, pl: 1 }}
    >
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
      {/* THE ONE SHRINKABLE GROUP: every piece of world text, ellipsizing together. */}
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minWidth: 0, flexGrow: 1, overflow: 'hidden' }}>
        {compare !== undefined && row !== undefined ? (
          <GearRowCompare row={row} data={compare}>
            <span>{name}</span>
          </GearRowCompare>
        ) : (
          name
        )}
        <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
          {mobText(target)}
        </Typography>
      </Box>
      {target.wished && <WishedChip />}
      {/* THE BAND ONLY WHEN IT ADDS SOMETHING. A run's heading already states one band for the whole
          trip, and inside a ~320px tile repeating it on every row costs the width the item name needs
          — worst case a `+N` run printing "difficulty unstated" four times in a column that fits it
          once. A target whose band DIFFERS from its run's still draws its own chip, because that is a
          real fact about a different mob; a target that agrees says nothing twice. Nothing is hidden
          by this rule that the tile is not already showing one line above. */}
      {target.band !== runBand && <BandChip band={target.band} plus={target.plus} />}
    </Stack>
  )
}

export interface PlanRunTileProps {
  run: GearRun
  /** the Gear tab's comparison seam; ABSENT means no card, the `GearTable` house rule */
  compare?: GearCompareData
  onOpenLoot?: (item: string) => void
}

/**
 * ONE RUN, AS A TILE: the place, its difficulty, how many things are in it, and — until you fold it
 * — up to three of them.
 *
 * THE TESTIDS ARE UNCHANGED THROUGH THE RELAYOUT (`plan-run`, `plan-run-head`, `plan-target`,
 * `plan-band`, `plan-wished`) and so is the DOM nesting the specs read: a `plan-run` still holds one
 * `plan-run-head` and its `plan-target`s as descendants. `tests/e2e/plan.e2e.mts` walks exactly that
 * shape, and a layout change that renamed a hook would have made a visual tweak look like a
 * behaviour change in the one suite that cannot be run casually.
 *
 * THE COUNT IS IN THE HEADING because the heading is all that survives a fold: "Befallen +4 · 3" is
 * still an answer when the items are hidden, where a bare zone name would leave a reader unable to
 * tell a rich trip from a thin one without opening every tile. It is rendered as its own node so the
 * chevron and the count cannot be mistaken for part of the place's name.
 */
export default function PlanRunTile({ run, compare, onOpenLoot }: PlanRunTileProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
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
          width: '100%',
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
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ flexShrink: 0 }}
          title={`${String(run.targets.length)} listed here - the fold caps a run at three.`}
        >
          {run.targets.length}
        </Typography>
      </Stack>
      {!collapsed &&
        run.targets.map((target) => (
          <TargetRow
            key={target.key}
            target={target}
            runBand={run.band}
            compare={compare}
            onOpenLoot={onOpenLoot}
          />
        ))}
    </Box>
  )
}
