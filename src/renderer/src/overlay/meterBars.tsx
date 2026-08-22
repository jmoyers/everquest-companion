// meterBars — the damage overlay's BAR BODY: the ranked entity list and, one click down, the
// breakdown for one entity. Split out of OverlayMeter so that file is the window chrome (header,
// selector, footer) and this one is the meter itself.
//
// IT RENDERS THE SAME METER THE COMBAT TAB DOES (owner ruling, 2026-08-04: "they should be using
// the same underlying api and abstraction — if not, collapse"). It used to build its rows from a
// DIFFERENT fold: the overlay asked the engine for `combinePets`, which returns a synthetic
// "You +pets" source whose lanes are namespaced strings ("Vebarn: Slash") and which has no pet
// LINE at all, while the Combat tab built its rows in petRows.ts over the un-folded sources. Two
// folds, two answers to "what is my damage". The engine fold is deleted; every row on this
// surface now comes out of `petRows.meterPanel`, the same call `SegmentPanel` makes, over the
// same snapshot and honouring the same 'Combine pet into your damage' preference.
//
// MUI-FREE ON PURPOSE: the overlay is its own renderer entry (overlay.html) with no theme and
// no component library — every pixel here is plain React + inline styles. Do not import
// @mui/* into this bundle. petRows/dashboardData/landEvidence are pure TS and import legally.

import { type JSX, useMemo } from 'react'
import type { OverlayDrill } from '@shared/types'
import { type DamageCategory, type SegmentView, type SourceView } from '@shared/combat'
import { formatNum as fmt, formatRate } from '../lib/formatRate'
import { type FlatSkill, type SkillRow } from '../features/combat/dashboardData'
import { laneDps, meterPanel, type MeterPanel, type OwnRow, type PetRow } from '../features/combat/petRows'
import { useCombinePetRow } from '../features/combat/useCombatPrefs'
import { scopeSources } from '../features/combat/meterScope'
import { landEvidence } from '../features/combat/landEvidence'
import { MeterCrumb, type CrumbTotal } from './meterCrumb'
// The app's ONE `m:ss` spelling, out of the MUI-free primitives module every plain-text and
// plain-React surface already reads it from. The overlay does not get a second one.
import { fmtDur } from '../features/combat/copyTable'
import type { MeterScope, RosterSnap } from '@shared/roster'

// Kept in step with the Combat tab's KIND_COLOR (features/combat/combatShared.tsx) — the overlay
// is MUI-free and cannot import the theme, so the two lists are written out and must move
// together. `member` is a group-mate (docs/plans/group-model.md).
/**
 * The damage meter's accent — the gold the window border and the header title already wear, and
 * since JOS-158 the colour of the aggregate on the crumb row. Spelled out rather than borrowed
 * from `KIND_COLOR.you` below: the two happen to be the same hue and mean different things, and
 * the aggregate is the one number on this surface that is emphatically NOT yours.
 */
const ACCENT = '#d9b25f'

const KIND_COLOR: Record<string, string> = {
  you: '#d9b25f',
  pet: '#6fb3d2',
  allyPet: '#5b7f95',
  member: '#7fbf8f',
  other: '#5f8f74',
  enemy: '#cf6679'
}
// The one-word tag after a bar's name. KEEP IN SYNC with the app's KIND_TAG (features/combat/
// EntityRow.tsx), which carries the argument for each word — in particular why `other` (JOS-430)
// is not called 'player'.
const KIND_SUFFIX: Record<string, string> = {
  pet: ' ·pet',
  member: ' ·group',
  allyPet: ' ·ally',
  other: ' ·other'
}
// KEEP IN SYNC with the app's CAT_COLOR (features/combat/combatShared.tsx) — the overlay is a
// separate renderer entry with no MUI theme, so it carries its own copy. 'slay' is a radiant
// ivory, deliberately far from melee gold: a Slay Undead proc flattens into a row named after
// its weapon skill, so at the old pale-gold it was invisible next to the plain melee row.
const CAT_COLOR: Record<DamageCategory, string> = {
  melee: '#d9b25f',
  slay: '#f6f0da',
  spell: '#a98fe0',
  dot: '#6fb3d2',
  ds: '#cf6679'
}


/**
 * A single horizontal bar: label + right-text + pct-fill. Dense + high-contrast. Clickable to drill.
 *
 * NO HOVER (JOS-358, owner ruling from hands-on testing: tooltips on these windows live in the
 * title bar and the bars get NONE). It used to carry a `title` spelling out the compacted stats;
 * what a bar states is now exactly what is printed ON it, and the fully-labeled figures are on the
 * Combat tab, which is the surface that has room for them.
 */
function Bar({
  color,
  pct,
  rank,
  label,
  right,
  onClick,
  accent
}: {
  color: string
  pct: number
  rank?: number
  label: React.ReactNode
  right: string
  onClick?: () => void
  /** Full-height left stripe — keeps a skill row's category readable at any bar width. */
  accent?: string
}): JSX.Element {
  return (
    <div
      // The e2e's only anchor into the bar body: a hidden always-on-top window has no cursor, so
      // the overlay drill spec drives these rows by selector (tests/e2e/overlay-sync.e2e.mts).
      data-testid="overlay-bar"
      onClick={onClick}
      style={{
        position: 'relative',
        height: 18,
        borderRadius: 3,
        marginBottom: 2,
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        background: 'rgba(255,255,255,0.06)'
      }}
    >
      <div style={{ position: 'absolute', inset: 0, width: `${Math.max(2, pct)}%`, background: color, opacity: 0.55 }} />
      {accent && <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: accent }} />}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          padding: accent ? '0 6px 0 9px' : '0 6px',
          gap: 6,
          fontSize: 11,
          lineHeight: 1,
          textShadow: '0 1px 2px rgba(0,0,0,0.9)'
        }}
      >
        {rank != null && (
          <span style={{ color: 'rgba(255,255,255,0.55)', width: 12, textAlign: 'right' }}>{rank}</span>
        )}
        <span style={{ fontWeight: 600, flexGrow: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}
        </span>
        <span style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{right}</span>
      </div>
    </div>
  )
}

// Mini drill-down (Task #54): {entityId} = level 2, ONE ranked list for that source — its
// skill/spell lanes (color = category, no legend — the overlay is too dense for one) plus, when
// the subject is YOU and the preference is on, one line item per pet ranked among them.
//
// The drill lives in the PERSISTED config (`overlays.<kind>.drill`), not component state, so it
// survives a restart exactly like window position does — the user plays pinned with a "damage by
// type" breakdown up and expects to find it there again. Locked mode RENDERS it (read-only,
// static crumb, zero affordances, still fully click-through); only interactive mode can change it.
//
// `null` (or absent) IS LEVEL 1 — the ranked source list — and it means exactly that on the
// Combat tab too (JOS-35). It used to mean "no drill of your own", with the pet preference then
// picking the opening level; that made "picking a different fight undrills" land somewhere
// different on each surface and, with the preference on, left the meter with no way back out at
// all. One spelling, one level, both surfaces.
export type Drill = OverlayDrill

// The row shaping — the flatten, the Slay Undead grouping, the pet nesting, the ranking and the
// re-based bar widths — is all `petRows.meterPanel`. What is duplicated here is only the CHROME
// (colors, bar geometry, the crumb), because this bundle has no MUI theme to read them from.

/**
 * The overlay's per-skill stat run, embedded INSIDE the bar after the name — identical form to
 * the main view's bars (features/combat/combatShared.tsx skillStatText):
 *   `12% miss · 3 - 145dmg`
 * Density here comes from carrying FEWER stats, never from compressing labels (`12%m` / `145/3`
 * are unreadable in a glance-and-forget overlay). The counts the main view puts one click down in
 * its expanded readout USED TO live in this row's hover title; since JOS-358 they live on the
 * Combat tab alone, which is the surface with room for them — this window has no expansion, no
 * hover, and in locked (click-through) mode no way to collapse either.
 * The row TOTAL is not here — it owns the right end of the bar.
 */
function skillStat(s: FlatSkill): string {
  // A lane with no damage line of its own — an effect proc counted from its landing emotes, or a
  // spell that only ever resisted. `landEvidence` is the ONE spelling of that row (see its
  // header): the main view's bar renders the identical string, and neither surface manufactures
  // a 100% resist rate out of resists alone.
  if (s.hits === 0) return landEvidence(s).text
  const misses = s.misses ?? 0
  const swings = s.hits + misses
  const parts: string[] = []
  if (misses > 0 && swings > 0) parts.push(`${Math.round((misses / swings) * 100)}% miss`)
  const min = s.min ?? 0
  parts.push(min > 0 && min !== s.max ? `${fmt(min)} - ${fmt(s.max)}dmg` : `${fmt(s.max)}dmg`)
  return parts.join(' · ')
}

// WHAT JOS-358 DELETED HERE, so nobody re-derives it from the comments above. Three builders lived
// in this file — `multiFacts`, `skillFacts` and `skillTitle` — and their whole job was the hover
// title on a bar: the fully-labeled figures, the multi-attack reading (JOS-113), and the grouped
// Slay Undead row's per-weapon split. The owner ruled the bars carry no tooltip at all, so they
// have no reader left and are gone rather than kept warm. NOTHING WAS LOST FROM THE PRODUCT: the
// Combat tab builds all three from `petRows`/`abilityStats` on a surface that can actually print
// them, and `landEvidence` (the damage-less row's honest sentence) still speaks ON the bar through
// `skillStat` above.

/** ONE skill/spell lane of the drilled source — category-colored, stats inside the bar, and its
 *  OWN rate at the right end beside its total (petRows.laneDps; owner ruling 2026-08-05). Every
 *  row in a level-2 list therefore ends `rate · total`, exactly like the pet line and like a
 *  level-1 source bar, so the three levels read as one column. */
function SkillLine({ s, activeSec }: { s: SkillRow; activeSec: number }): JSX.Element {
  return (
    <Bar
      color={CAT_COLOR[s.category]}
      accent={CAT_COLOR[s.category]}
      pct={s.pct}
      label={
        <>
          {s.name}
          {/* A lone Slay Undead proc flattens into a row named after its weapon skill, so
              without this tag it is a duplicate of the plain melee row. The category has
              to be readable from the ROW; the overlay has no legend to fall back on.
              A GROUP row is already named "Slay Undead" — tagging it would stutter — and
              instead says how many weapon skills it merges; the split is in its title. */}
          {s.category === 'slay' && !s.children && (
            <span style={{ color: CAT_COLOR.slay, fontWeight: 600 }}> · Slay Undead</span>
          )}
          {s.children && s.children.length > 0 && (
            <span style={{ color: 'rgba(255,255,255,0.62)', fontWeight: 400 }}> · {s.children.length} skills</span>
          )}
          {/* Labeled stats ride inside the bar, dimmed against the name; the right end
              of every row stays the total alone so the list scans as a ranking. */}
          <span style={{ marginLeft: 6, color: 'rgba(255,255,255,0.62)', fontWeight: 400 }}>{skillStat(s)}</span>
        </>
      }
      right={`${formatRate(laneDps(s.total, activeSec))} · ${fmt(s.total)}`}
    />
  )
}

/**
 * ONE PET, nested inside your breakdown as a single line item ranked among your lanes — the row
 * the overlay simply did not have while it was rendering the engine's merged fold.
 *
 * It wears the PET colour, not a category colour, because it is not a lane of yours (world-model
 * law 4: "pet" is presentation, and the engine's attribution has to survive the layout), and it
 * is labelled with the pet's own display name off its source row, never a coined "Pet" (law 2).
 * Its right-hand text is a rate + total, exactly like a level-1 source bar, because that is what
 * it stands for — a whole source, folded to one line.
 */
function PetLine({ pet, pct, onDrill }: { pet: PetRow; pct: number; onDrill?: () => void }): JSX.Element {
  return (
    <Bar
      color={KIND_COLOR.pet}
      accent={KIND_COLOR.pet}
      pct={pct}
      label={
        <>
          {pet.name}
          <span style={{ color: 'rgba(255,255,255,0.62)', fontWeight: 400 }}> ·pet</span>
        </>
      }
      right={`${formatRate(pet.dps)} · ${fmt(pet.total)}`}
      onClick={onDrill}
    />
  )
}

/** Nothing to show yet — quiet, and honest about which kind of nothing it is. */
function MeterEmpty({ live }: { live: boolean }): JSX.Element {
  return (
    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', padding: '8px 2px' }}>
      {live ? 'Engaging…' : 'Waiting for combat…'}
    </div>
  )
}

/** The level-1 ranked source list: one bar per entity, EVERY entity. There is no row budget any
 *  more (owner feedback 2026-08-05) — the content pane scrolls instead of the meter deciding for
 *  you which of your group is worth seeing. */
function SourceLines({
  sources,
  setDrill
}: {
  sources: SourceView[]
  setDrill: ((d: Drill | null) => void) | null
}): JSX.Element {
  return (
    <>
      {sources.map((e, i) => (
        <Bar
          key={e.id}
          color={KIND_COLOR[e.kind] ?? '#888'}
          pct={e.pct}
          rank={i + 1}
          label={
            <>
              {e.name}
              {KIND_SUFFIX[e.kind] ?? ''}
            </>
          }
          right={`${formatRate(e.dps)} · ${fmt(e.total)}`}
          onClick={setDrill ? () => setDrill({ entityId: e.id }) : undefined}
        />
      ))}
    </>
  )
}

/** One row of a level-2 list: a lane of the subject's, or a whole pet folded into one line. */
function ownLine(r: OwnRow, activeSec: number, setDrill: ((d: Drill | null) => void) | null): JSX.Element {
  return r.kind === 'pet' ? (
    <PetLine
      key={r.pet.id}
      pet={r.pet}
      pct={r.pct}
      onDrill={setDrill ? () => setDrill({ entityId: r.pet.id }) : undefined}
    />
  ) : (
    <SkillLine key={`${r.skill.category}|${r.skill.name}`} s={r.skill} activeSec={activeSec} />
  )
}

/**
 * LEVEL 2: one source's ability list — one bar per ability (JOS-113), the per-ability stats on
 * each bar's hover title (this window has no room for an inline expansion, and locked mode is
 * click-through).
 *
 * Back goes to the row this level was opened FROM — a nested pet's owner (your breakdown), else
 * all the way out to the source list. The zoom-out is offered here: the meter no longer opens
 * drilled, so there is no view that is its own home and no reason to withhold the way out (the
 * `canLeave` gate this replaces is JOS-35's zoom-out regression).
 */
function DrilledBars({
  panel,
  activeSec,
  dur,
  total,
  setDrill
}: {
  panel: Extract<MeterPanel, { level: 2 }>
  activeSec: number
  dur: string
  /** the SEGMENT's aggregate, unchanged by the drill: it is the fight's number, not the
   *  subject's, which is exactly why it is labelled `all` (JOS-158). */
  total: CrumbTotal
  setDrill: ((d: Drill | null) => void) | null
}): JSX.Element {
  const out: Drill | null = panel.parent ? { entityId: panel.parent.id } : null
  return (
    <MeterCrumb
      name={panel.subject.name}
      dur={dur}
      total={total}
      onBack={setDrill ? () => setDrill(out) : null}
    >
      {panel.rows.map((r) => ownLine(r, activeSec, setDrill))}
    </MeterCrumb>
  )
}

/**
 * The bar body: the source list, or ONE source's breakdown — whichever `petRows.meterPanel` says,
 * from the persisted drill and the shared preference. `setDrill` is null in locked mode: the same
 * levels render, minus every affordance.
 */
export function MeterBars({
  seg,
  scope,
  roster,
  drill,
  setDrill,
  live,
}: {
  seg: SegmentView | undefined
  scope: MeterScope
  roster: RosterSnap
  drill: Drill | null
  setDrill: ((d: Drill | null) => void) | null
  live: boolean
}): JSX.Element {
  // The SAME preference the Combat tab reads, out of the same localStorage key — one origin, one
  // store, and a 'storage' event when the other window's Preferences tab writes it.
  const [combine] = useCombinePetRow()
  // …and the SAME scope filter, out of the same shared module (features/combat/meterScope). It
  // returns the identical array by reference when nothing is filtered out, so a solo session
  // pays nothing and this memo does not churn.
  const entities = useMemo(() => scopeSources(seg?.entities ?? [], scope, roster), [seg, scope, roster])
  // No drill of our own ⇒ LEVEL 1, the ranked source list — the same thing `null` means on the
  // Combat tab (JOS-35). A drill that resolves to nothing renders level 1 for THIS render only:
  // `meterPanel` never touches the stored value, so a restored `pet:<instanceId>` from a past
  // session, a fight that moved on, or a 'you' that blinks out between fights all re-drill
  // silently the moment the entity is back in the segment.
  // The overlay hands its PERSISTED drill straight to the builder — `OverlayDrill` is exactly the
  // shape `meterPanel` takes, which is why this surface needs no translation where the Combat tab
  // and the Overview card each call `dashboardData.meterDrill` on their richer union.
  const panel = useMemo(() => meterPanel(entities, combine, drill), [entities, combine, drill])
  const dur = fmtDur(seg?.durationSec ?? 0)

  if (!seg || (panel.level === 1 && panel.sources.length === 0)) return <MeterEmpty live={live} />

  // THE AGGREGATE THE TITLE BAR USED TO CARRY (JOS-158) — the same `SegmentView.outDps`, moved
  // rather than recomputed, so the number a pinned meter shows did not change on the day its
  // label appeared. The crumb states what it covers; see overlay/meterCrumb.tsx.
  const total: CrumbTotal = { text: formatRate(seg.outDps), accent: ACCENT }

  if (panel.level !== 1)
    return <DrilledBars panel={panel} activeSec={seg.activeSec} dur={dur} total={total} setDrill={setDrill} />

  return (
    <MeterCrumb name={null} dur={dur} total={total} onBack={null}>
      <SourceLines sources={panel.sources} setDrill={setDrill} />
    </MeterCrumb>
  )
}