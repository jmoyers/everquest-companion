// plan/PlanRunRow.tsx — ONE TRIP, AND WHAT IS WORTH GETTING ON IT
// (docs/plans/gear-progression-planner.md §1; `progressionPlan.ts GearRun`, fold rule 7).
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
// THE ROW IS `nowrap` WITH ONE SHRINKABLE GROUP (the flexWrap law): wrapping converts overflow into
// height and these rows sit in a column of cards, so the world text (item name, mob, zone) shares
// one `minWidth: 0` group that ellipsizes and every chip is `flexShrink: 0`.

import type { JSX } from 'react'
import { Box, Chip, Stack, Typography } from '@mui/material'
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
  compare,
  onOpenLoot
}: {
  target: GearTarget
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
      title={`Ranked ${String(target.score)} for this role - a heuristic ordering, not a game stat.`}
      sx={{ flexWrap: 'nowrap', minWidth: 0, py: 0.25, pl: 2 }}
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
      <BandChip band={target.band} plus={target.plus} />
    </Stack>
  )
}

export interface PlanRunRowProps {
  run: GearRun
  /** the Gear tab's comparison seam; ABSENT means no card, the `GearTable` house rule */
  compare?: GearCompareData
  onOpenLoot?: (item: string) => void
}

/** One run: the place, its difficulty, and up to three things worth carrying home from it. */
export default function PlanRunRow({ run, compare, onOpenLoot }: PlanRunRowProps): JSX.Element {
  return (
    <Box data-testid="plan-run" data-zone={run.zone} data-plus={run.plus === null ? '' : String(run.plus)} sx={{ mt: 0.75 }}>
      {/* THE HEADING IS ITS OWN NODE (`plan-run-head`) so a reader — human or spec — can take the
          place and its verdict as ONE string. The band sits on the same `nowrap` row, so reading
          the Box's first text line would depend on where the browser chose to break it. */}
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        data-testid="plan-run-head"
        sx={{ flexWrap: 'nowrap', minWidth: 0 }}
      >
        <Typography variant="body2" fontWeight={600} noWrap sx={{ minWidth: 0 }}>
          {runLabel(run)}
        </Typography>
        <BandChip band={run.band} plus={run.plus} />
      </Stack>
      {run.targets.map((target) => (
        <TargetRow key={target.key} target={target} compare={compare} onOpenLoot={onOpenLoot} />
      ))}
    </Box>
  )
}
