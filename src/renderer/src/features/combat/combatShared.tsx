// Presentational primitives shared by the combat meter and the dashboard panels.
// Extracted from CombatView so both surfaces render the SAME bar, the SAME category
// colors and the SAME card chrome (one look, one source of truth).

import { type ReactNode } from 'react'
import { Box, Collapse, Paper, Stack, Typography } from '@mui/material'
import type { DamageCategory } from '@shared/combat'
import { CATEGORY_LABEL } from '@shared/combat'
import { formatNum as fmt, formatRate } from '../../lib/formatRate'
import { laneDps } from './petRows'
import type { ProcAnnotation } from './procRows'
import { landEvidence } from './landEvidence'
import { useAbilityExpand } from './abilityExpand'
import { abilityExpandable, type AbilityMulti } from './abilityStats'
import { groupLabels } from './skillGroups'
import type { FlatSkill, SkillRow } from './dashboardData'
import { Tooltip } from '../../lib/Tooltip'

// `fmtDur` lives in the MUI-free copyText module (the plain-text serializer needs it and cannot
// import this file), and is re-exported here so every JSX surface keeps its existing import.
export { fmtDur } from './copyText'
// The copy affordance moved to its own file (see its header — this one hit the line ceiling).
// Re-exported so every panel header keeps the import it already had.
export { CopyButton } from './CopyButton'
// …and so did the readout atoms, for the same reason and to the same kind of file.
import { MultiAttackStats, RiposteStats, StatItem } from './meterBits'

// `member` (a group-mate, docs/plans/group-model.md) is a green in the same muted family as the
// pet's blue — a friendly, clearly not you, and clearly not the enemy's red.
// `allyPet` (JOS-250) is somebody ELSE's charm pet: a dimmer, cooler wash of the pet blue, so it
// reads as the same KIND of thing as your pet while never being mistaken for it at a glance.
// `other` (JOS-430) is a combatant the log named that your roster has not: the same green as a
// group-mate, muted, so the list reads as one family of friendlies with the confirmed ones brighter.
export const KIND_COLOR: Record<string, string> = {
  you: '#d9b25f', pet: '#6fb3d2', allyPet: '#5b7f95', member: '#7fbf8f', other: '#5f8f74', enemy: '#cf6679'
}

/**
 * Category colors. Keep this map in sync with the overlay's copy (OverlayMeter.tsx) and the
 * timeline (CombatTimeline.tsx imports THIS map — one source).
 *
 * `slay` used to be #e8d48a: a pale gold that is indistinguishable from melee #d9b25f at the
 * 3px stripe width, which made Slay Undead procs look like duplicate weapon rows in the flat
 * drill-down. It is now a radiant ivory — a holy proc reads as near-white, and it separates
 * from gold at any stripe width while staying high-contrast on the dark bg.
 */
export const CAT_COLOR: Record<DamageCategory, string> = {
  melee: '#d9b25f',
  slay: '#f6f0da',
  spell: '#a98fe0',
  dot: '#6fb3d2',
  ds: '#cf6679'
}

/** Red-tint for resist/miss rate badges (matches the timeline's hollow marks). */
export const RESIST_COLOR = '#e05663'


export function Bar({
  color,
  pct,
  rank,
  name,
  right,
  adorn,
  onClick,
  accent,
  selected
}: {
  color: string
  pct: number
  rank?: number
  name: ReactNode
  right: string
  /** A small RIGHT-ALIGNED annotation between the name and the total — it never shrinks and
   *  never competes with the total for the row's right edge. The proc-rate tag uses it. */
  adorn?: ReactNode
  onClick?: () => void
  /** Full-height left stripe — keeps a row's category readable even when its fill is 2% wide. */
  accent?: string
  /** Outline the row as the current drill subject. */
  selected?: boolean
}): React.JSX.Element {
  return (
    <Box
      onClick={onClick}
      sx={{
        position: 'relative',
        height: 22,
        borderRadius: 0.5,
        mb: '3px',
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        bgcolor: 'rgba(255,255,255,0.04)',
        outline: selected ? `1px solid ${color}` : 'none'
      }}
    >
      <Box sx={{ position: 'absolute', inset: 0, width: `${Math.max(2, pct)}%`, bgcolor: color, opacity: 0.5 }} />
      {accent && <Box sx={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, bgcolor: accent }} />}
      <Stack
        direction="row"
        alignItems="center"
        sx={{ position: 'absolute', inset: 0, pl: accent ? '9px' : 0.75, pr: 0.75 }}
        spacing={0.75}
      >
        {rank != null && (
          <Typography variant="caption" sx={{ color: 'text.secondary', width: 16, textAlign: 'right' }}>
            {rank}
          </Typography>
        )}
        <Typography variant="caption" noWrap sx={{ fontWeight: 600, flexGrow: 1 }}>
          {name}
        </Typography>
        {adorn}
        <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>
          {right}
        </Typography>
      </Stack>
    </Box>
  )
}

/**
 * A flat-row skill name that makes the row's CATEGORY readable from the ROW, not just from
 * its stripe. Only 'slay' needs it: the flatten renders a Slay Undead proc under its weapon
 * skill ("Melee"/"Backstab"), so it arrived as a DUPLICATE of the plain melee row separable
 * only by a 3px stripe. Every other category's lane names are already unambiguous.
 * Two rows skip the tag: the GROUPED aggregate (already named "Slay Undead" — tagging it
 * would stutter) and its children (`plain`), whose parent row already says it.
 */
export function SkillName({
  name,
  category,
  plain
}: {
  name: string
  category: DamageCategory
  plain?: boolean
}): React.JSX.Element {
  if (category !== 'slay' || plain || name === CATEGORY_LABEL.slay) return <>{name}</>
  return (
    <>
      {name}
      <Typography component="span" variant="caption" sx={{ ml: 0.5, color: CAT_COLOR.slay, fontWeight: 600 }}>
        · Slay Undead
      </Typography>
    </>
  )
}

/**
 * The per-skill stat summary that rides INSIDE the bar, after the skill name:
 *   `12% miss · 3 - 145dmg`
 * Deliberately just the two stats that can't be read off the bar itself: the miss rate and the
 * damage RANGE. Counts (hits/crits/resists) live one click down in the expanded readout — a bar
 * carrying five numbers stops being scannable. Both values are labeled (`% miss`, `dmg`); no
 * positional codes, because there is no column header in the middle of a colored row.
 * Omissions: no avoided swings → no miss rate; a lane whose smallest hit equals its largest
 * (a single hit, or a fixed-damage proc) collapses to just `145dmg`.
 * Miss rate is misses ÷ (hits + misses) for THIS lane. The row's TOTAL is deliberately not
 * here — it owns the right end of every bar so the list stays scannable as a ranked column.
 * `a` is the `~` estimate prefix the event-derived list wears on a downsampled ring; observed
 * max/min are NOT prefixed (they are not scaled estimates — they're an observed lower/upper
 * bound, which the panel's `~ N of M events` chip spells out).
 */
export function skillStatText(s: FlatSkill, a = ''): string {
  const misses = s.misses ?? 0
  const swings = s.hits + misses
  const parts: string[] = []
  if (misses > 0 && swings > 0) parts.push(`${a}${Math.round((misses / swings) * 100)}% miss`)
  const min = s.min ?? 0
  parts.push(min > 0 && min !== s.max ? `${fmt(min)} - ${fmt(s.max)}dmg` : `${fmt(s.max)}dmg`)
  return parts.join(' · ')
}


/**
 * The three figures that only exist once a lane has LANDED A HIT: the average, the crit rate and
 * the damage range. Split out of `SkillReadout` so the readout does not have to repeat the same
 * `hits > 0` guard four times — a lane can now be present with zero hits and real landings (an
 * effect proc), which makes the guard load-bearing rather than defensive.
 */
function DamageStats({ s, a }: { s: FlatSkill; a: string }): React.JSX.Element | null {
  if (s.hits === 0) return null
  const min = s.min ?? 0
  return (
    <>
      <StatItem label="Avg per hit" value={`${a}${fmt(Math.round(s.total / s.hits))}`} />
      <StatItem label="Crits" value={`${a}${s.crits} (${Math.round((s.crits / s.hits) * 100)}% crit)`} />
      <StatItem label="Damage range" value={min > 0 && min !== s.max ? `${fmt(min)} - ${fmt(s.max)}` : fmt(s.max)} />
    </>
  )
}

/**
 * The expanded per-ability readout (inline — no new nav level, no breadcrumb). Everything the bar
 * compresses, spelled out and labeled: the category, the total, hit/crit counts with the crit
 * rate, the miss rate over swings, resists over casts, the damage range and the average per hit
 * (total ÷ hits — derived, so it's labeled as an average and never presented as an observed hit),
 * and — for a stat-bearing ability — the double/triple/quad attack rates (JOS-113).
 * `a` carries the `~` sample-estimate marker through; the observed range is never prefixed
 * (a sampled max is a lower bound, a sampled min an upper bound — the panel's chip says so).
 * `after` rides INSIDE the same block, under the figures — the grouped Slay Undead row uses it
 * for its per-weapon child rows, so one click gives both the group's stats and its split.
 */
function SkillReadout({
  s,
  multi,
  approx,
  after
}: {
  s: SkillRow
  /** this ability's own multi-attack reading (double/triple/quad/flurry), or null when it has none. */
  multi?: AbilityMulti | null
  approx?: boolean
  after?: ReactNode
}): React.JSX.Element {
  const a = approx ? '~' : ''
  const misses = s.misses ?? 0
  const resists = s.resists ?? 0
  const swings = s.hits + misses
  const land = landEvidence(s, a)
  const color = CAT_COLOR[s.category]
  return (
    <Box
      data-testid="ability-stats"
      sx={{
        mt: '-1px',
        mb: '3px',
        px: 1,
        py: 0.75,
        borderLeft: `3px solid ${color}`,
        borderRadius: '0 4px 4px 0',
        bgcolor: 'rgba(255,255,255,0.03)'
      }}
    >
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
        <StatItem label="Category" value={CATEGORY_LABEL[s.category]} color={color} />
        <StatItem label="Total" value={`${a}${fmt(s.total)}`} />
        <StatItem label="Hits" value={`${a}${s.hits}`} />
        <DamageStats s={s} a={a} />
        {misses > 0 && (
          <StatItem
            label="Miss rate"
            value={`${Math.round((misses / swings) * 100)}% (${a}${misses} of ${a}${swings} swings)`}
            color={RESIST_COLOR}
          />
        )}
        {/* LANDINGS WITH NO DAMAGE (an effect proc: a slow, a stun, a dispel). Its own figure,
            because "landed" and "hit for damage" are different facts and this lane has only the
            first. */}
        {(s.lands ?? 0) > 0 && <StatItem label="Landed" value={`${a}${s.lands}`} />}
        {resists > 0 && <StatItem label="Resists" value={land.resistText} color={RESIST_COLOR} />}
        {multi && <MultiAttackStats multi={multi} a={a} />}
        {/* The riposte share of this ability's damage (JOS-354) — a SUBSET of the total above,
            never a figure to add to it (meterBits.RiposteStats says so in its wording). */}
        {s.riposte && <RiposteStats riposte={s.riposte} a={a} />}
      </Stack>
      {multi?.flurry != null && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
          {multi.flurry}
        </Typography>
      )}
      {after}
    </Box>
  )
}

/**
 * The grouped row's child list — one bar per weapon skill the proc fired from, or per message
 * shape the spell printed — inside the parent's expansion. Each child is a full SkillBar, so it
 * keeps its embedded stats AND its own click-to-expand readout: the interaction is the identical
 * one users already know, just nested; no third nav level and no breadcrumb change. The heading
 * is `skillGroups.groupLabels`, which is also what wrote the count on the parent's face.
 */
function SkillChildren({ s, approx }: { s: SkillRow; approx?: boolean }): React.JSX.Element {
  return (
    <Box sx={{ mt: 1 }}>
      <Typography
        variant="caption"
        sx={{
          display: 'block',
          fontSize: 9,
          lineHeight: 1.4,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'text.disabled',
          mb: 0.5
        }}
      >
        {groupLabels(s).heading}
      </Typography>
      {(s.children ?? []).map((c) => (
        <SkillBar key={`${c.category}|${c.name}`} s={c} approx={approx} nested />
      ))}
    </Box>
  )
}

/** The dimmed stat run inside a bar. Lower contrast than the name so the row still reads
 *  name-first, but sits on the translucent (0.5-opacity) fill, not beyond it. */
function InlineStats({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Typography component="span" variant="caption" sx={{ ml: 0.75, color: 'text.secondary', fontWeight: 400 }}>
      {children}
    </Typography>
  )
}

/**
 * THE PROC-RATE TAG (docs/plans/proc-visibility.md §2) — `proc · 3.1 ppm` on a drill row whose
 * skill the proc ledger actually counts.
 *
 * The row is annotated because the LEDGER has a lane for it (the join runs in main against the
 * poison roster and the cast-less detector), so this can never appear on a row the Procs panel
 * would not list, and the rate is the lane's own — one number, two surfaces. The hover carries
 * the basis (count over active seconds) and, for an inferred lane, says that it is inferred.
 */
function ProcTag({ proc }: { proc: ProcAnnotation }): React.JSX.Element {
  return (
    <Tooltip title={proc.hint}>
      <Typography
        component="span"
        variant="caption"
        noWrap
        data-testid="proc-tag"
        sx={{ flexShrink: 0, color: proc.color, fontWeight: 600 }}
      >
        {proc.text}
      </Typography>
    </Tooltip>
  )
}

/**
 * A row's RIGHT END: `rate · total` inside a drill, the total alone outside one and in the glance
 * card, where a bar a third of the width cannot carry two numbers and a name.
 * Its own function so `SkillBar` stays inside the complexity budget.
 */
function skillRight(s: SkillRow, a: string, activeSec: number | undefined, compact?: boolean): string {
  if (activeSec === undefined || compact) return `${a}${fmt(s.total)}`
  return `${a}${formatRate(laneDps(s.total, activeSec))} · ${a}${fmt(s.total)}`
}

/**
 * The stat run that rides INSIDE the bar: the two stats a reader cannot get off the bar itself,
 * or — on a lane with no damage line of its own — the landing evidence, whose hover carries the
 * basis and, where there is none, the reason the resist rate is being withheld. Nothing at all in
 * the glance card, where there is no room for it.
 */
function skillInline(s: SkillRow, a: string, land: ReturnType<typeof landEvidence>, compact?: boolean): ReactNode {
  if (compact) return null
  if (s.hits > 0) return skillStatText(s, a)
  return (
    <Tooltip title={land.hint}>
      <span>{land.text}</span>
    </Tooltip>
  )
}

/**
 * One flat skill/spell row, colored by its parent category (fill + left stripe). Layout:
 * `<name> <embedded labeled stats> ………… <total>` — the stats live INSIDE the bar next to the
 * name (dimmed), and the right end is the total and nothing else, so a column of these reads
 * as a ranked list at a glance.
 * `approx` prefixes the derived numbers with `~` — used by the mob-filtered list when the
 * encounter's event ring was downsampled (the numbers are then sample estimates).
 * A GROUPED row (`s.children` — the Slay Undead aggregate, or the two message shapes of one
 * spell) renders exactly like any other row; the difference is only in what its expansion holds.
 * `nested` marks a child of such a group: its parent already names the proc, so the row drops
 * the `· Slay Undead` tag.
 */
export function SkillBar({
  s,
  approx,
  nested,
  activeSec,
  compact,
  proc
}: {
  s: SkillRow
  approx?: boolean
  nested?: boolean
  /**
   * The GLANCE variant (the Overview card, JOS-105): the embedded stat run and the lane's own
   * rate come off, leaving name and total, because the card's bar is a third of the tab's width
   * and a truncated stat run is worse than none. The CLICK is untouched — the same expansion
   * opens the same full readout, so the row behaves identically on both surfaces.
   */
  compact?: boolean
  /**
   * The segment's active seconds. Present ⇒ the row's right end carries its OWN rate beside its
   * total (`rate · total`, petRows.laneDps — owner ruling 2026-08-05: "every lane shows its own
   * DPS beside its total"). Absent ⇒ the total alone, which is what a row outside a drill
   * (an incoming source's inline expansion) has no honest divisor for.
   */
  activeSec?: number
  /** The proc-rate annotation, when the ledger has a lane for this skill. Absent otherwise —
   *  the row simply says nothing rather than guessing. */
  proc?: ProcAnnotation
}): React.JSX.Element {
  // Click expands the full per-ability readout in place (the same inline-Collapse pattern the
  // incoming meter rows use) — no extra nav level, so the flat ranked list never moves.
  //
  // ONLY A STAT-BEARING ABILITY EXPANDS (JOS-113, owner): a melee/slay swing, anything that
  // multi-attacked, a spell that crit — click it and its crit/double/triple/miss open beneath it.
  // A DoT tick has none, so it is not clickable and does nothing (abilityStats.abilityExpandable).
  //
  // THE OPEN STATE IS NOT THIS COMPONENT'S ANY MORE (JOS-116). It was a `useState` here, which
  // died with the view on every tab switch — the same lifecycle bug as the drill one level up. A
  // surface that REMEMBERS (the Combat tab, the Overview card) provides the answer through
  // `abilityExpand`; anywhere with no provider the hook falls back to exactly the local state this
  // line used to hold, so nothing had to opt in to keep working.
  const multi = s.multi ?? null
  const expandable = abilityExpandable(s, multi)
  const [open, toggle] = useAbilityExpand(s.category, s.name, expandable)
  const color = CAT_COLOR[s.category]
  const resists = s.resists ?? 0
  const a = approx ? '~' : ''
  // A spell/dot lane can carry resists (Task #51 v2) and — for an effect proc that prints only
  // a landing emote — LANDS with no damage behind them (2026-08-04). `landEvidence` owns both
  // the wording and the one case where the resist rate is withheld rather than divided: a lane
  // with no landing evidence at all has no denominator, and 100% would be a fabrication.
  const land = landEvidence(s, a)
  return (
    <Box data-testid="skill-bar">
      <Bar
        color={color}
        accent={color}
        pct={s.pct}
        // `open` is already gated on `expandable` (useAbilityExpand), so a non-expandable row is
        // never outlined and never expands — including a row that WAS expandable when its key was
        // remembered and is not any more.
        selected={open}
        onClick={expandable ? toggle : undefined}
        name={
          <>
            <SkillName name={s.name} category={s.category} plain={nested} />
            {land.resistPct !== undefined && (
              <Tooltip title={`${resists} resisted, ${land.landed} landed - ${Math.round(100 - land.resistPct)}% landed. ${land.hint}`}>
                <Typography component="span" variant="caption" sx={{ ml: 0.75, color: RESIST_COLOR }}>
                  {Math.round(land.resistPct)}% resist
                </Typography>
              </Tooltip>
            )}
            <InlineStats>
              {skillInline(s, a, land, compact)}
              {/* A group row says how many rows it stands for, so the merge is visible from the
                  row itself and the expansion is obviously worth a click (skillGroups.groupLabels
                  picks the noun: a spell group's parts are message SHAPES, not abilities). */}
              {groupLabels(s).face}
            </InlineStats>
          </>
        }
        adorn={proc ? <ProcTag proc={proc} /> : undefined}
        right={skillRight(s, a, activeSec, compact)}
      />
      {expandable && (
        <Collapse in={open} unmountOnExit>
          <SkillReadout
            s={s}
            multi={multi}
            approx={approx}
            after={s.children?.length ? <SkillChildren s={s} approx={approx} /> : undefined}
          />
        </Collapse>
      )}
    </Box>
  )
}

/**
 * Dashboard card chrome: dense uppercase caption on the left, a free-form status slot on
 * the right, body fills the rest. Matches the app's outlined-Paper card style.
 *
 * TWO sizing modes, and a card must pick exactly one — a card NEVER sizes itself to its
 * content, because a content-sized card in a shared box silently steals the whole box from
 * its shrinkable siblings (that is precisely how the combat log once ate the dashboard):
 *  - `fill`   — the card takes 100% of whatever box it was given (a 2x2 grid CELL) and
 *               contributes NO intrinsic height. Its body scrolls internally, so a cramped
 *               cell clips nothing and cannot push the grid past the viewport.
 *  - `height` — FIXED px height, for a body that is an ever-growing append-only ring.
 */
export function DashCard({
  title,
  right,
  children,
  fill,
  height,
  testId
}: {
  title: string
  right?: ReactNode
  children: ReactNode
  /**
   * Grid-cell mode: `height: 100%` + `minHeight: 0` let a `minmax(0, 1fr)` track shrink the
   * card freely, and the body gets its own `overflow: auto` so content scrolls INSIDE the cell
   * instead of growing it.
   */
  fill?: boolean
  /** FIXED card height (`flex: 0 0 <height>px`) — the combat log's ring. */
  height?: number
  /** Marks the card as one of the dashboard's measurable panels (e2e layout assertions). */
  testId?: string
}): React.JSX.Element {
  return (
    <Paper
      variant="outlined"
      data-testid={testId}
      sx={{
        p: 1.25,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        ...(fill
          ? { height: '100%', minHeight: 0, overflow: 'hidden' }
          : height != null
            ? { flex: `0 0 ${height}px`, minHeight: 0, maxHeight: height }
            : { flex: '0 0 auto' })
      }}
    >
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="baseline"
        spacing={1}
        sx={{ mb: 0.75, flexShrink: 0 }}
      >
        <Typography
          variant="caption"
          noWrap
          sx={{ fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'text.secondary' }}
        >
          {title}
        </Typography>
        {right}
      </Stack>
      <Box
        sx={{
          minWidth: 0,
          minHeight: 0,
          flexGrow: 1,
          display: 'flex',
          flexDirection: 'column',
          ...(fill ? { overflow: 'auto' } : null)
        }}
      >
        {children}
      </Box>
    </Paper>
  )
}

/** A one-line quiet state for a panel that has nothing (honest) to show. Never an error. */
export function QuietNote({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Typography variant="caption" color="text.disabled" sx={{ py: 0.5 }}>
      {children}
    </Typography>
  )
}

/**
 * The `~ estimated` chip a panel wears when its numbers came from an INEXACT event ring —
 * downsampled (a uniform stride, so the numbers are scaled estimates), truncated (the ring
 * dropped the fight's oldest instants, so the numbers are lower bounds), or both. `raw` is
 * always the fight's TRUE instant count, so "N of M" never quotes the ring's own capacity as
 * if it were the size of the fight. ONE chip for both losses on purpose: they have the same
 * character (something is missing from the sample) and the same reading rule, so a second
 * visual language would only make the user learn two.
 */
export function ApproxChip({
  shown,
  raw,
  truncated
}: {
  shown: number
  raw: number
  truncated?: boolean
}): React.JSX.Element {
  const why = truncated
    ? `This fight outgrew its event ring, so its OLDEST instants were dropped: ${shown} of ${raw} instants are still held. Numbers below (marked ~) cover only that retained window - read them as LOWER BOUNDS on the fight, not as its totals.`
    : `This fight's event ring was downsampled: ${shown} of ${raw} instants were kept. Numbers below are scaled sample estimates (marked ~).`
  return (
    <Tooltip
      title={`${why} Observed maxima are lower bounds and observed minima upper bounds (the true biggest/smallest hit may not be in the sample). The source meter's totals are exact.`}
    >
      <Typography variant="caption" sx={{ color: RESIST_COLOR, whiteSpace: 'nowrap' }}>
        ~ {shown} of {raw} events
      </Typography>
    </Tooltip>
  )
}
