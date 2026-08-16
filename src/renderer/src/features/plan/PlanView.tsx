// plan/PlanView.tsx — THE PLAN TAB (docs/plans/gear-progression-planner.md §1, §4).
//
// THE QUESTION IT ANSWERS, in the fork user's own words: *when finding the best gear for me I need
// a progression tree - Crushbone for the first N levels, Mistmoore, Splitpaw... based on the 3
// classes someone wants and the target (dps, tank, healer) - and when to grind +0 for exp vs +4
// areas for gear, because +4 is harder so we need the creatures to be blue and white solo.*
//
// IT IS A ROUTE, NOT AN OPTIMIZER, and the distinction is forced by the data rather than chosen: no
// drop rates exist anywhere in this repo, so there is nothing to optimize over. A bracket ranks
// ZONES by what their mobs' stated levels con at, and ITEMS by a role-weighted heuristic. Both
// derivations are labelled on the cards that draw them (`PlanBracketCard.tsx`, `PlanRunTile.tsx`).
//
// AND IT LOOKS AT WHAT YOU HAVE (owner, 2026-08-15: *"i should be able to gear my guy up, so it
// needs to look at what I have and the best in slot"*). The ownership join this view already read
// for the fold's `owned` set is folded a SECOND way in `planData.ownedBestBySlot` — the role-scored
// best owned item per equip slot — and the fold admits an item only when it strictly beats that bar
// somewhere it fits. Nothing new is fetched for it: same hook, same map, one more memo.
//
// SIX INPUTS, AND NOT ONE OF THEM IS NEW STATE.
//   * the LEVEL is `useStatedLevel` — the later of your last ding and your own `/who` row, with the
//     cue and the age it was stated at (JOS-192). It is the one input this view cannot ask for, and
//     when nothing has stated it the tab says exactly that and draws no route. A default of 1 would
//     be a confident six-bracket plan about a character the log has never described;
//   * the CLASS TRIO is `useGearClasses` — THE SAME PIN THE GEAR TAB USES (plan §4), key and all
//     (`eq.gear.classes`), so pinning a trio on either tab pins it for the reading of both. The
//     offer chip is that hook's own `offer`/`adopt`, drawn here as `plan-class-offer` beside the
//     Gear tab's `gear-class-offer`;
//   * the ERA toggle is `useEraOnly` — the SHARED `eq.planner.era` key, on purpose (the Exaltations
//     tab writes it too). "Is this server open yet" has one answer per machine, not one per tab;
//   * the ROLE and the REACH are this tab's own two picks, on the restart tier
//     (`areaMemory.AREA_FORM_TIER`, which argues why both are restart-scoped);
//   * WHAT YOU OWN and WHAT YOU HAVE WISHED FOR are `useGearOwnership` and `useWishlist`, the same
//     two documents the Gear tab joins on `row.key` — which is what lets the gap test above and the
//     hover comparison below both answer without a single new channel.
//
// EVERYTHING ELSE IS DERIVED, ONCE, IN `planData.ts`. This file wires controls to a fold and draws
// what comes back; it holds no rule about what belongs in a route and reaches for no catalog.
//
// THE HOVER COMPARISON IS THE GEAR TAB'S, UNCHANGED (owner ask, 2026-08-15 20:17: *"add in the
// comparison that the main gear tab does on hover"*). `useGearCompare` here, `GearRowCompare` on the
// item rows — the identical pair of calls `EffectBrowser` makes for the Exaltations donor names, and
// at `ITEM_UPGRADE_BASE` for the identical reason plus one of this tab's own: the fold scores every
// target off BASE stats (rule 6), so a card simulating a tier would contradict the ranking that put
// the row on screen. This tab has no plus-state slider and the card's "simulated at Tier N" line
// correctly never appears.
//
// THE PAGE NEVER SCROLLS SIDEWAYS AND THE LIST NEVER GROWS IT (the standing UI law): the header is
// one `nowrap` row of controls that do not shrink, and the cards live in their own bounded
// scroller, exactly as the gear table does.

import { type JSX, useMemo } from 'react'
import { Box, Chip, MenuItem, Stack, TextField, Typography } from '@mui/material'
import { CLASS_ABBRS } from '@shared/classCombo'
import { ITEM_UPGRADE_BASE } from '@shared/itemUpgrade'
import type { GearRole } from '@shared/planner/progressionPlan'
import type { ProgressionDelta, ProgressionSnap } from '@shared/types'
import ChipMultiSelect from '../../components/ChipMultiSelect'
import { useModule } from '../../lib/useModule'
import {
  PLAN_REACHES,
  PLAN_ROLES,
  sanitizePlanReach,
  sanitizePlanRole,
  type PlanReach
} from '../gear/areaMemory'
import {
  useGearClasses,
  useGearCompare,
  useGearIndex,
  useGearOwnership,
  type GearClasses
} from '../gear/gearData'
import { useRemembered } from '../gear/useAreaMemory'
import { EMPTY_PROGRESSION, applyProgressionDelta } from '../leveling/progressionDelta'
import { useStatedLevel, type StatedLevel } from '../leveling/useStatedLevel'
import { CURRENT_ERA_LABEL, useEraOnly } from '../planner/plannerData'
import PlanBracketCard from './PlanBracketCard'
import { usePlanCorpora, usePlanRoute, usePlanWishes } from './planData'

/** What each role is CALLED. A `Record` so a fifth role is a type error here (the `VIEW_LABELS` trick). */
const ROLE_LABEL: Record<GearRole, string> = {
  balanced: 'Balanced',
  tank: 'Tank',
  healer: 'Healer',
  // "(any)" rather than a bare "DPS", because four of the entries below are also DPS. This is the
  // one that constrains no weapon slot, and the label has to say which of the five it is.
  dps: 'DPS (any)',
  dps1h: '1H DPS',
  dps2h: '2H DPS',
  dualwield: 'Dual wield',
  dd: 'Caster DD',
  dot: 'Caster DoT'
}

/** …and the two reaches, whose words are the gate they open (`progressionPlan` SOLO/GROUP_GATE). */
const REACH_LABEL: Record<PlanReach, string> = {
  solo: 'Solo',
  group: 'Group'
}

const ROLE_HINT =
  'What the route ranks items for. The weights are an invented ordering, not a game stat - a tank plan and a dps plan simply order the same corpus differently. The same weights score what you already own: an item is listed only if it beats your best in at least one slot it fits, and a wished item always shows. The weapon roles also constrain the weapon slots: 2H DPS suggests two-handers and never offers an offhand, dual wield wants one-handers in both hands, 1H DPS constrains the main hand, and Tank takes only shield-shaped offhands. Caster DD and Caster DoT rank nearly alike - no stat in the corpus tells burst apart from a dot.'
const REACH_HINT =
  'The hardest fight the route will send you to. Solo tops out at blue and white; a group raises the ceiling by one band. Anything easier always makes the list.'

interface PicksProps {
  role: GearRole
  setRole: (r: GearRole) => void
  reach: PlanReach
  setReach: (r: PlanReach) => void
}

/** The two closed picks, drawn as the Gear tab's Effect control is — one select each. */
function PlanPickers({ role, setRole, reach, setReach }: PicksProps): JSX.Element {
  return (
    <>
      <TextField
        select
        size="small"
        label="Gearing for"
        value={role}
        data-testid="plan-role"
        title={ROLE_HINT}
        onChange={(e) => {
          setRole(e.target.value as GearRole)
        }}
        sx={{ minWidth: 140, flexShrink: 0 }}
      >
        {PLAN_ROLES.map((r) => (
          <MenuItem key={r} value={r}>
            {ROLE_LABEL[r]}
          </MenuItem>
        ))}
      </TextField>

      <TextField
        select
        size="small"
        label="Reach"
        value={reach}
        data-testid="plan-reach"
        title={REACH_HINT}
        onChange={(e) => {
          setReach(e.target.value as PlanReach)
        }}
        sx={{ minWidth: 110, flexShrink: 0 }}
      >
        {PLAN_REACHES.map((r) => (
          <MenuItem key={r} value={r}>
            {REACH_LABEL[r]}
          </MenuItem>
        ))}
      </TextField>
    </>
  )
}

/**
 * WHAT LEVEL THE ROUTE OPENS AT, with the provenance the fact comes with.
 *
 * `cue` and `title` are `currentLevelRead`'s own words and are printed rather than re-worded: an
 * old statement wears its age (`7h 0m ago`) because a loadout swap since then would have printed
 * nothing, and a `/who` correction wears the word so the player can see it land. When nothing has
 * stated a level the chip is ABSENT rather than showing a guess — the body says why.
 */
function LevelChip({ stated }: { stated: StatedLevel }): JSX.Element | null {
  if (stated.level === null) return null
  return (
    <Typography
      variant="body2"
      color="text.secondary"
      data-testid="plan-level"
      title={stated.title}
      sx={{ flexShrink: 0 }}
    >
      Level {stated.level}
      {stated.cue === '' ? '' : ` · ${stated.cue}`}
    </Typography>
  )
}

interface HeaderProps extends PicksProps {
  classes: GearClasses
  eraOnly: boolean
  setEraOnly: (v: boolean) => void
  stated: StatedLevel
}

/** One `nowrap` row: what to plan for, who for, how far, and from what level. */
function PlanHeader(props: HeaderProps): JSX.Element {
  const { classes, eraOnly, setEraOnly, stated } = props
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{ flexWrap: 'nowrap', minWidth: 0, mb: 1, flexShrink: 0 }}
    >
      <PlanPickers role={props.role} setRole={props.setRole} reach={props.reach} setReach={props.setReach} />

      {/* THE GEAR TAB'S OWN PIN (see the header): one trio, read by both tabs. */}
      <ChipMultiSelect
        options={CLASS_ABBRS}
        value={classes.classes}
        onChange={classes.set}
        label="Classes"
        placeholder="every class"
        minWidth={190}
        testId="plan-classes"
      />
      {classes.offer !== null && (
        <Chip
          size="small"
          color="warning"
          variant="outlined"
          label={`detected: ${classes.offer.join(' ')}`}
          data-testid="plan-class-offer"
          title="What the app currently infers you are running. Click to plan for it."
          onClick={classes.adopt}
          sx={{ flexShrink: 0 }}
        />
      )}

      <Chip
        size="small"
        label="Current era"
        data-testid="plan-era-toggle"
        title={`Keep the route inside ${CURRENT_ERA_LABEL}. Shared with the Exaltations tab - one answer per machine.`}
        color={eraOnly ? 'primary' : 'default'}
        variant={eraOnly ? 'filled' : 'outlined'}
        onClick={() => {
          setEraOnly(!eraOnly)
        }}
        sx={{ flexShrink: 0 }}
      />

      <LevelChip stated={stated} />
    </Stack>
  )
}

/**
 * The one sentence an empty page says, and the three silences are DIFFERENT silences.
 *
 * No stated level is not "no plan" — it is the app declining to invent the input the whole route
 * opens at. An unready index is a load. An empty route under a stated level is the corpus saying it
 * has nothing left to state above here, which is a real answer and the same one the fold's own
 * trailing-silence trim produces.
 */
function emptyText(level: number | null, ready: boolean): string {
  if (level === null) {
    return 'No line has stated your level yet. A level-up ("Welcome to level N!") or your own /who row is what states it - the route opens at the level you are, so there is nothing honest to draw until one of them does.'
  }
  if (!ready) return 'Reading the item database…'
  return `Nothing above level ${String(level)} to plan: no zone this era profiles for experience at those levels, and nothing dropping inside your reach that beats what you already own. Widening the reach, switching the era chip off, or picking a different role is what has more to say.`
}

export interface PlanViewProps {
  /**
   * Deep-link an item name into the Loot tab's drill-down (App's `openLoot`) — the same contract
   * every other item name in this app travels, so a drill's Back arrow comes home here.
   */
  onOpenLoot?: (item: string) => void
}

export default function PlanView({ onOpenLoot }: PlanViewProps = {}): JSX.Element {
  const { rows, ready } = useGearIndex()
  const classes = useGearClasses()
  const ownership = useGearOwnership()
  const wishes = usePlanWishes()
  const [eraOnly, setEraOnly] = useEraOnly()
  const [role, setRole] = useRemembered<GearRole>('eq.plan.role', sanitizePlanRole)
  const [reach, setReach] = useRemembered<PlanReach>('eq.plan.reach', sanitizePlanReach)
  // The progression snapshot supplies the LOG clock the level statement's age is measured against
  // (never the wall clock, which would call a freshly-loaded log three weeks stale) — the read
  // `LevelingView` and `CharacterIdentity` both make, spelled the same way.
  const prog = useModule<ProgressionSnap, ProgressionDelta>('progression', applyProgressionDelta)
  const stated = useStatedLevel(prog ?? EMPTY_PROGRESSION)

  // THE HOVER PAIR'S SEAM, at BASE (see the header): one `plannerInventory` read per mount and per
  // `inventory:autoReloaded`, two memos over data that moves only when the corpus arrives or the
  // player re-exports, and one `Map.get` per hover. `ITEM_UPGRADE_BASE` is a module constant, so the
  // memo inside the hook is stable.
  const compare = useGearCompare(rows, ITEM_UPGRADE_BASE)
  // THE ROLE GOES IN TOO: it scores the OWNED side of the gap test as well as the candidate side, so
  // switching role re-reads what you have rather than merely re-sorting what you might get.
  const corpora = usePlanCorpora(rows, ownership.map, wishes.list, role)
  const picks = useMemo(
    () => ({ classes: classes.classes, role, reach, eraOnly }),
    [classes.classes, role, reach, eraOnly]
  )
  const route = usePlanRoute(stated.level, picks, corpora)

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-testid="plan-view">
      <PlanHeader
        role={role}
        setRole={setRole}
        reach={reach}
        setReach={setReach}
        classes={classes}
        eraOnly={eraOnly}
        setEraOnly={setEraOnly}
        stated={stated}
      />

      {/* The cards' own bounded scroller: a seven-card route grows THIS box, never the page. */}
      <Box sx={{ flexGrow: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }} data-testid="plan-route">
        {route.map((bracket) => (
          <PlanBracketCard
            key={bracket.from}
            bracket={bracket}
            onAdd={wishes.addBracket}
            compare={compare}
            onOpenLoot={onOpenLoot}
          />
        ))}
        {route.length === 0 && (
          <Typography variant="body2" color="text.secondary" data-testid="plan-empty" sx={{ p: 2 }}>
            {emptyText(stated.level, ready)}
          </Typography>
        )}
      </Box>
    </Box>
  )
}
