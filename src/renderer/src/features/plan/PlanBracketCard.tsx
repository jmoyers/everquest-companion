// plan/PlanBracketCard.tsx — ONE STEP OF THE ROUTE, DRAWN
// (docs/plans/gear-progression-planner.md §1, §4).
//
// WHAT A CARD SAYS, in the plan's own sentence: *where should I be at these levels, and what am I
// there FOR?* The levels are the heading, the exp zones are where to grind, the targets are what to
// pick up while you are standing there, and the button is the one door out of this tab.
//
// EVERY DERIVATION IS LABELLED, AND THAT IS THE WHOLE POINT OF THIS FILE. Nothing on this card is a
// number EverQuest states:
//   * a zone's band comes from a MEDIAN over the levels its mobs state, so the chip carries
//     `from N stated mob levels` — `ZonePick.sampled`, printed rather than merely computed
//     (`zoneLevels.ts`: "the surface says 'from N stated mob levels' rather than presenting a
//     derived number as a fact");
//   * a target's rank is `roleValue`, which is an INVENTED ordering with a one-place weights table
//     behind it, so the score is drawn as a rank hint and never as a game stat. It is on the hover
//     rather than in the row for exactly that reason;
//   * a `+N` target has NO band at all and says so in words — `difficulty unstated`, plan §3. The
//     catalog states no level for any tiered creature, so "blue at 19" for one would be fabricated.
//
// THE BAND CHIP IS A WORD, NOT A COLOUR, and that is a refusal rather than an omission. EQ's own
// con colour encodes relative level (`shared/considerFaction.ts` says so while declining to claim
// it), and this repo has measured no mapping from a band to a colour — `CONSIDER_FACTION_COLOR` is
// the FACTION ladder and reusing it here would paint a difficulty in the palette of a completely
// different fact. A plain outlined chip carrying the band's word states exactly what is known.
//
// THE ROW IS `nowrap` WITH ONE SHRINKABLE GROUP (the flexWrap law). Wrapping converts overflow into
// height, and this card sits in a column of cards — so the world text (item name, mob, zone) shares
// one `minWidth: 0` group that ellipsizes, and every chip is `flexShrink: 0`. The page never
// scrolls sideways and a long mob name costs no height.
//
// NOT WINDOWED, MEASURED RATHER THAN ASSUMED: the fold caps a bracket at `EXP_ZONE_CAP` (4) zones
// and `TARGET_CAP` (8) targets, and the route at seven brackets, so the whole page is bounded at
// ~56 rows by construction. `useWindowedRows` exists for the 6,766-row gear table; mounting it over
// eight rows would be machinery guarding nothing.

import type { JSX } from 'react'
import { Box, Button, Chip, Stack, Typography } from '@mui/material'
import type { ConBand } from '@shared/conBands'
import type { GearTarget, PlanBracket, ZonePick } from '@shared/planner/progressionPlan'
import { itemIconUrl } from '../../lib/ItemWindow'
import { DonorName } from '../planner/PlannerChips'

/** What each band means for a plan, said once — the chip's hover on every surface that draws one. */
const BAND_HINT: Record<ConBand, string> = {
  trivial: 'Far below you - the log`s own "You could probably win this fight."',
  safe: 'Blue: comfortably below you.',
  even: 'White: an even fight at this level.',
  risky: 'Above you - the log`s "would wipe the floor with you!" range.',
  deadly: 'Well above you.'
}

/** The one place a `+N` target`s missing verdict is worded. Plan §3, and it is a refusal. */
const UNSTATED_HINT =
  'Nothing states how hard a tiered creature is. The catalog gives no level for any +N mob, so this row shows where it drops and declines to guess the fight.'

/** `safe` / `even` / `difficulty unstated` — the chip, and nothing dressed up as a measurement. */
function BandChip({ band }: { band: ConBand | null }): JSX.Element {
  return (
    <Chip
      size="small"
      variant="outlined"
      data-testid="plan-band"
      label={band ?? 'difficulty unstated'}
      title={band === null ? UNSTATED_HINT : BAND_HINT[band]}
      sx={{ flexShrink: 0 }}
    />
  )
}

/**
 * One exp zone. The band is what the zone's MEDIAN mob cons at the bracket midpoint, and the hover
 * carries the spread and the sample size — because a zone with a level-6 entrance and a level-40
 * basement has a median that describes neither, and the fold says so in as many words.
 */
function ZoneChip({ pick }: { pick: ZonePick }): JSX.Element {
  return (
    <Chip
      size="small"
      variant="outlined"
      data-testid="plan-zone"
      label={`${pick.zone} · ${pick.band}`}
      title={`Median mob level ${String(pick.median)}, lowest ${String(pick.low)} - from ${String(pick.sampled)} stated mob levels. A median is a coarse stand-in for a zone, not its range.`}
      sx={{ flexShrink: 0, maxWidth: 320 }}
    />
  )
}

/** The tiered spelling the wiki uses, composed here rather than stored — `GearTarget.mob` is base. */
function mobText(target: GearTarget): string {
  const mob = target.plus === null ? target.mob : `${target.mob} +${String(target.plus)}`
  const level = target.mobLevel === null ? '' : ` (Lvl ${String(target.mobLevel)})`
  const zone = target.zone === '' ? '' : ` · ${target.zone}`
  return `${mob}${level}${zone}`
}

/**
 * ONE TARGET. The item name is the Loot drill-down (the `DonorName` contract every other surface in
 * this app uses for an item name), and the rest of the row is the stated witness that put it here:
 * which mob, at what level the CATALOG states, in which zone.
 *
 * An icon only when the corpus has one. `itemIconUrl` is the app's permanent image cache, so a miss
 * 404s and `onError` hides the element — exactly as it does in the item window and the loot dialog.
 */
function TargetRow({
  target,
  onOpenLoot
}: {
  target: GearTarget
  onOpenLoot?: (item: string) => void
}): JSX.Element {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      data-testid="plan-target"
      data-item-key={target.key}
      // THE SCORE LIVES HERE AND NOWHERE ELSE. `roleValue` is a heuristic rank with an invented
      // weights table behind it, so it is worth saying what ordered the list and it is not worth a
      // column that would read like a stat off the item page.
      title={`Ranked ${String(target.score)} for this role - a heuristic ordering, not a game stat.`}
      sx={{ flexWrap: 'nowrap', minWidth: 0, py: 0.25 }}
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
        <DonorName name={target.name} bold onOpen={onOpenLoot} />
        <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
          {mobText(target)}
        </Typography>
      </Box>
      <BandChip band={target.band} />
    </Stack>
  )
}

export interface PlanBracketCardProps {
  bracket: PlanBracket
  /** absent until the wish list document has loaded — see `usePlanWishes` for the rule */
  onAdd?: (bracket: PlanBracket) => void
  onOpenLoot?: (item: string) => void
}

/**
 * ONE BRACKET.
 *
 * A BRACKET WITH ZONES AND NO TARGETS STILL DRAWS, and that is information rather than an oversight:
 * "there is somewhere to be at 30-35 and nothing here worth a detour" is an answer, and a card that
 * hid itself would read as a gap in the route. Only the fold's own trailing-silence trim removes a
 * bracket, and it removes only the ones at the END (`buildProgressionPlan`).
 *
 * THE BUTTON'S SIDE EFFECT IS STATED ON THE BUTTON. The fold dedupes targets against the wish list,
 * so the rows this adds LEAVE this card on the next render. That is the plan seeding the wish list
 * rather than duplicating it (plan §8) — but it is surprising if nobody says it, so the hover does.
 */
export default function PlanBracketCard({ bracket, onAdd, onOpenLoot }: PlanBracketCardProps): JSX.Element {
  return (
    <Box
      data-testid="plan-bracket"
      data-from={String(bracket.from)}
      sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5, mb: 1.5 }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'nowrap', minWidth: 0 }}>
        <Typography variant="subtitle2" sx={{ flexShrink: 0 }}>
          {bracket.from}-{bracket.to}
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.5, minWidth: 0, flexGrow: 1, overflow: 'hidden' }}>
          {bracket.expZones.map((pick) => (
            <ZoneChip key={pick.zone} pick={pick} />
          ))}
          {bracket.expZones.length === 0 && (
            <Typography variant="caption" color="text.secondary" noWrap>
              no zone this era profiles at these levels
            </Typography>
          )}
        </Box>
        {bracket.targets.length > 0 && onAdd !== undefined && (
          <Button
            size="small"
            variant="outlined"
            data-testid="plan-add-bracket"
            title="Adds these items to the Wish list. They leave this card when they land: the plan seeds that document, it never keeps a second copy of it."
            onClick={() => {
              onAdd(bracket)
            }}
            sx={{ flexShrink: 0 }}
          >
            Add {bracket.targets.length} to wish list
          </Button>
        )}
      </Stack>

      <Box sx={{ mt: 0.5 }}>
        {bracket.targets.map((target) => (
          <TargetRow key={target.key} target={target} onOpenLoot={onOpenLoot} />
        ))}
        {bracket.targets.length === 0 && (
          <Typography variant="caption" color="text.secondary" data-testid="plan-no-targets">
            Nothing here to go and get - grind it, and keep going.
          </Typography>
        )}
      </Box>
    </Box>
  )
}
