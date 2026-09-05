// PET NESTING — a PRESENTATION regrouping of the snapshot's existing source rows. No JSX, no
// MUI, no engine involvement: the engine hands us YOU and each PET as separate, authoritative
// `SourceView`s and this module only decides how they are LAID OUT.
//
// IT IS *THE* METER, NOT ONE METER'S HELPER (owner ruling, 2026-08-04): "the overlay is using a
// different source of data — combat has a breakdown with pet appropriately merged and overlay
// does not — this should not be possible, they should be using the same underlying api and
// abstraction — if not, collapse." They were two folds giving two answers: the Combat tab built
// its rows here, while the floating overlay asked the ENGINE for a `combinePets` fold (a
// synthetic "You +pets" source with namespaced skill lanes and no pet line at all). That engine
// fold is now DELETED — not deprecated, deleted, along with its parameter — and `meterPanel`
// below is the single row builder every damage-meter surface calls: the Combat tab's panel, the
// floating overlay, the Overview card. A second builder has nowhere left to live.
//
// MUI-FREE AND JSX-FREE ON PURPOSE. The overlay is its own renderer entry (overlay.html) with no
// theme and no component library, so the shared abstraction has to be plain TS to be importable
// from both bundles. Keep it that way: colors, bar chrome and crumbs stay in each surface.
//
// WHY (owner direction, 2026-08-03): the game is mostly played solo, so "your damage" and "the
// pet's damage" are two rows of a two-row meter and the interesting list is one level down. The
// default view is therefore YOUR breakdown with the pet as ONE line item inside it, drillable to
// the pet's own skills. A preference ('Show your pet inside your damage') turns the nesting off
// and restores the separate sources.
//
// LEVEL 1 IS THE DEFAULT, EVERYWHERE (owner ruling, 2026-08-05 — JOS-35). Every damage meter and
// the Combat tab OPEN on the ranked source list: one bar per combatant. Auto-drilling was the
// solo-play shortcut of 2026-08-03/04 (`defaultDrill`, now deleted), and it stopped being right
// the moment the meters grew group members — a meter that opens inside YOUR breakdown hides the
// four other people in the fight behind a chevron nobody knew to press. A drill the user makes is
// still remembered per surface; the out-of-box level is 1.
//
// THE PREFERENCE IS THE PET'S LAYOUT, AND ONLY THAT. `combine` no longer decides a level; it
// decides where the pet's damage LIVES, at every level:
//   ON  ⇒ the pet is NOT a source row of its own. Its damage rides inside YOUR level-1 bar
//         (`meterSources` below folds it in), and it appears exactly once more: as one named,
//         drillable line item inside your breakdown. Nowhere else — a pet listed both as its own
//         bar and inside your row was the double-count the owner saw (JOS-35).
//   OFF  ⇒ the pet is its own level-1 bar and nothing is nested; your breakdown is yours alone.
//
// HONESTY (world-model law 4 — "pet" is presentation, never a data-model class; law 5 —
// aggregates lie, derive from identities):
//   - The pet row is labelled with the pet's REAL display name off its own source row. It is
//     never a coined label ("Pet"), and it is never folded into one of YOUR skill lanes: your
//     per-skill numbers stay exactly the engine's, and the pet's total sits BESIDE them as its
//     own row. Nothing here adds a point of pet damage to a row of yours.
//   - One line item that DRILLS is what the owner asked for, not a merged lane list. The engine's
//     retired `combinePets` fold did the latter, which is why it is gone rather than reused.
//   - `total` here is self + nested pets, which is exactly `SegmentView.outTotal` whenever the
//     only outgoing sources are you and your pets (they are, by construction — the aggregate
//     keys outgoing damage as 'you' or 'pet:<id>'). Every surface that shows a combined headline
//     reads `outTotal`, so the two can't drift.

import { flattenSkills, type SkillRow } from './dashboardData'
import type { SourceView } from '@shared/combat'

/** The synthetic line item that stands for ONE pet inside your breakdown. */
export interface PetRow {
  /** `SourceView.id` of the pet — what a drill hands `setDrill({ kind: 'entity', … })`. */
  id: string
  /** the pet's real display name, straight off its source row. */
  name: string
  total: number
  dps: number
  hits: number
  crits: number
  misses: number
  resists: number
}

/**
 * One row of the combined "your damage" list: either a real skill lane of YOURS, or the
 * synthetic aggregate for one pet. `total`/`pct` are lifted to the union so the two kinds sort
 * and size against each other without the caller having to know which it is holding.
 */
export type OwnRow =
  | { kind: 'skill'; total: number; pct: number; skill: SkillRow }
  | { kind: 'pet'; total: number; pct: number; pet: PetRow }

export interface OwnBreakdown {
  /** your source row, or null when this segment has none (a segment with no outgoing damage). */
  self: SourceView | null
  /** the pet sources nested into `rows` — empty when the preference is off, or petless. */
  pets: SourceView[]
  /** your skill lanes + one row per nested pet, ranked by damage desc. */
  rows: OwnRow[]
  /** self + nested pets. Equals `SegmentView.outTotal` for the combined case (see the header). */
  total: number
}

/** Your own source row. Keyed on `kind`, never on the aggregate's 'you' key — the id is the
 *  engine's business and the kind is the model's. */
export function selfSource(entities: SourceView[]): SourceView | null {
  return entities.find((e) => e.kind === 'you') ?? null
}

/** Every pet source in this segment (there is usually exactly one — the single-pet invariant
 *  retires the prior pet — but a segment spanning two pets legitimately carries both). */
export function petSources(entities: SourceView[]): SourceView[] {
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives SourceView. Becomes a view descriptor when the source lands.
  return entities.filter((e) => e.kind === 'pet')
}

/**
 * ONE LANE'S RATE — a level-2 row's own DPS, over the SEGMENT's active seconds (owner ruling,
 * 2026-08-05: "every lane shows its own DPS beside its total").
 *
 * The divisor is `SegmentView.activeSec`, which is exactly the denominator behind the segment's
 * shipped `activeDps` (`main/combat/segmentViews.ts` — `outTotal / Math.max(1, activeSec)`), so a
 * drill's lane rates and the fight's headline active rate are the same arithmetic. Wall-clock
 * duration would divide a lane by idle time it wasn't there for; active seconds is the meter
 * convention and the one this app already shipped.
 *
 * One number, stated plainly. There is no caveat prose beside it: the basis is the segment's, it
 * is the same for every lane in the list, and a per-row asterisk would say nothing a reader could
 * act on (AGENTS.md — the tooltip and caveat diet).
 */
export function laneDps(total: number, activeSec: number): number {
  return total / Math.max(1, activeSec)
}

/** Sum one numeric field across a set of sources. */
function sum(sources: SourceView[], pick: (s: SourceView) => number): number {
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives SourceView. Becomes a view descriptor when the source lands.
  return sources.reduce((n, s) => n + pick(s), 0)
}

/** Landed detrimental spell/dot hits — the resist rate's denominator, minus the resists
 *  themselves. Mirrors `main/combat/sourceViews.ts` exactly: melee/slay/ds hits can't be
 *  resisted, so they are not casts. */
function spellHits(s: SourceView): number {
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives CategoryView. Becomes a view descriptor when the source lands.
  return s.categories.reduce((n, c) => n + (c.category === 'spell' || c.category === 'dot' ? c.hits : 0), 0)
}

/**
 * YOUR LEVEL-1 BAR WITH THE PETS INSIDE IT — the combine preference's whole meaning at level 1.
 *
 * Every counter here is SUMMED FROM IDENTITIES (law 5): the pet's hits are hits, its crits are
 * crits, and the three percentages are re-derived from those sums by the engine's own formulas
 * rather than blended from the sources' percentages. Nothing is invented and nothing is dropped —
 * `total` is `self + pets`, which is `SegmentView.outTotal` for a solo fight, the same number the
 * panel header and the Overview card headline.
 *
 * What it does NOT touch: `skills`, `categories`, `rounds`, `roundStats` stay YOURS. They are
 * read one level down, where the pet is a line item of its own rather than a lane of yours (law
 * 4: "pet" is presentation, and the engine's attribution has to survive the layout). So drilling
 * this bar shows your lanes plus the pet's line — which sums to exactly this bar's total.
 */
function combinedSelf(self: SourceView, pets: SourceView[]): SourceView {
  const all = [self, ...pets]
  const hits = sum(all, (s) => s.hits)
  const misses = sum(all, (s) => s.misses)
  const crits = sum(all, (s) => s.crits)
  const resists = sum(all, (s) => s.resists)
  const swings = hits + misses
  const casts = sum(all, spellHits) + resists
  return {
    ...self,
    total: sum(all, (s) => s.total),
    dps: sum(all, (s) => s.dps),
    hits,
    crits,
    critPct: hits ? (crits / hits) * 100 : 0,
    // The pet's name-ambiguity travels WITH its damage: folding the row must not fold away the
    // one badge that says some of these hits may belong to a hostile twin.
    ambiguousHits: sum(all, (s) => s.ambiguousHits),
    ambiguousTotal: sum(all, (s) => s.ambiguousTotal),
    misses,
    hitPct: swings ? (hits / swings) * 100 : 100,
    missBreakdown: {
      miss: sum(all, (s) => s.missBreakdown.miss),
      dodge: sum(all, (s) => s.missBreakdown.dodge),
      parry: sum(all, (s) => s.missBreakdown.parry),
      riposte: sum(all, (s) => s.missBreakdown.riposte),
      block: sum(all, (s) => s.missBreakdown.block),
      absorb: sum(all, (s) => s.missBreakdown.absorb)
    },
    resists,
    resistPct: casts ? (resists / casts) * 100 : 0
  }
}

/**
 * THE LEVEL-1 SOURCE LIST every damage meter ranks — the engine's rows, with the combine
 * preference applied.
 *
 * `combine` off (or nothing to fold) returns the SAME ARRAY BY REFERENCE, so an ungrouped,
 * petless session builds exactly the list it built before and no memo downstream churns — the
 * same invariant `meterScope.scopeSources` keeps.
 *
 * `pct` is re-based over the surviving rows because it is a BAR WIDTH: after the fold your row is
 * usually the longest, and leaving the engine's segment-relative percentages in place would draw
 * a ranking whose top bar stops short for no visible reason.
 */
export function meterSources(entities: SourceView[], combine: boolean): SourceView[] {
  if (!combine) return entities
  const self = selfSource(entities)
  const pets = petSources(entities)
  if (!self || pets.length === 0) return entities
  const petIds = new Set(pets.map((p) => p.id))
  const kept = entities
    // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives SourceView. Becomes a view descriptor when the source lands.
    .filter((e) => !petIds.has(e.id))
    .map((e) => (e.id === self.id ? combinedSelf(self, pets) : e))
    // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives SourceView. Becomes a view descriptor when the source lands.
    .sort((a, b) => b.total - a.total)
  const max = Math.max(1, ...kept.map((e) => e.total))
  return kept.map((e) => ({ ...e, pct: (e.total / max) * 100 }))
}

function toPetRow(p: SourceView): PetRow {
  return {
    id: p.id,
    name: p.name,
    total: p.total,
    dps: p.dps,
    hits: p.hits,
    crits: p.crits,
    misses: p.misses,
    resists: p.resists
  }
}

function rowLabel(r: OwnRow): string {
  return r.kind === 'pet' ? r.pet.name : r.skill.name
}

/**
 * ONE source's flat skill list with `pets` nested into it as line items, ranked together.
 * Pass no pets and this is exactly `flattenSkills` — which is what a drill into the PET itself
 * (or into any non-self source) uses, so there is one row builder for every level-2 list.
 *
 * Bar widths are re-based on the MERGED maximum — the pet is often the largest row, and a list
 * where two rows both render full-width would be lying about the ranking. A grouped row's
 * children keep their own (group-relative) pct: that expansion is its own ranking.
 */
export function nestedRows(source: SourceView | null, pets: SourceView[]): OwnRow[] {
  const skills: OwnRow[] = source
    ? flattenSkills(source).map((s) => ({ kind: 'skill' as const, total: s.total, pct: 0, skill: s }))
    : []
  const petRows: OwnRow[] = pets.map((p) => ({ kind: 'pet' as const, total: p.total, pct: 0, pet: toPetRow(p) }))
  const merged = [...skills, ...petRows].sort((a, b) => b.total - a.total || rowLabel(a).localeCompare(rowLabel(b)))
  const max = Math.max(1, ...merged.map((r) => r.total))
  return merged.map((r) => {
    const pct = (r.total / max) * 100
    return r.kind === 'skill' ? { ...r, pct, skill: { ...r.skill, pct } } : { ...r, pct }
  })
}

/**
 * YOUR breakdown for a whole segment: your skill lanes with every pet nested in. `combine` off
 * ⇒ pets are left out entirely (they stay separate source rows at level 1, exactly as today).
 */
export function ownBreakdown(entities: SourceView[], combine: boolean): OwnBreakdown {
  const self = selfSource(entities)
  const pets = combine ? petSources(entities) : []
  return {
    self,
    pets,
    rows: nestedRows(self, pets),
    // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives SourceView. Becomes a view descriptor when the source lands.
    total: (self?.total ?? 0) + pets.reduce((n, p) => n + p.total, 0)
  }
}

/**
 * WHAT ONE DAMAGE METER IS SHOWING — the whole answer, for every surface that shows one.
 *
 * Level 1 is the ranked source list AS THE PREFERENCE LAYS IT OUT (`meterSources`): one bar per
 * combatant, with your pets folded into your bar while combine is on. Level 2 is ONE
 * source's breakdown: its skill lanes, with the pets nested in as line items when the subject is
 * YOU and the preference is on. `parent` is the source the subject is currently being shown as a
 * line item OF — non-null only for a nested pet — and it is what lets a Back button return to the
 * view the pet was clicked FROM instead of pretending the pet was ever a top-level bar.
 *
 * A drill id that resolves to nothing (a `pet:<instanceId>` from a past session, a fight that
 * moved on, a 'you' that blinks out between fights) yields LEVEL 1 for this render — the caller's
 * stored value is never touched, so the drill re-applies the moment the entity is back.
 *
 * TWO LEVELS ONLY (JOS-113). JOS-105 added a third — one damage TYPE of a source, reached from a
 * category chip. The owner rejected the grouping: one bar per ability, flat, and a stat-bearing
 * ability's crit/double/triple/miss expand INLINE within this level-2 list (abilityStats.ts /
 * combatShared.SkillBar), never as a level of their own.
 */
export type MeterPanel =
  | { level: 1; sources: SourceView[] }
  | {
      level: 2
      subject: SourceView
      /** the source `subject` is nested inside right now (a pet's owner), else null. */
      parent: SourceView | null
      /** the pets nested into `rows` — empty unless `subject` is you and the preference is on. */
      pets: SourceView[]
      rows: OwnRow[]
    }

/**
 * A drill as the builder takes it: a source. It is exactly the shape the overlay persists
 * (`OverlayDrill`), so that surface hands its stored value straight in; the Combat tab and the
 * Overview card translate their richer union with `dashboardData.meterDrill`.
 *
 * `name` is the CROSS-FIGHT identity (JOS-240) and is optional everywhere: the overlay does not
 * persist one, and a token stored by an older build has none. See `resolveSubject`.
 */
export interface MeterDrill {
  entityId: string
  /** the drilled row's display name, when the caller recorded it. */
  name?: string
}

/**
 * WHICH ROW A DRILL IS POINTING AT — by id, then by NAME (JOS-240).
 *
 * The id is tried first and always wins, so nothing about an ordinary in-fight drill changes: the
 * exact row the user clicked is the exact row that opens, even when two same-named entities are
 * both in the segment (a pull that spanned two summons legitimately carries both).
 *
 * The NAME fallback exists because half the ids in this list are WORLD INSTANCES. 'you',
 * `member:<key>` and `heal:<key>` are the same string in every fight; `pet:<instanceId>` is minted
 * per summon and an incoming mob's id per spawn. So "keep my pet's breakdown open while I flip
 * between fights" is an id match in the lucky case and a name match in the real one — and after a
 * restart re-folds the log, always a name match. Matching on the exact display name is the same
 * identity the ability expansions already use (`abilityKey` is `category|name`) and the same one
 * the mob drill has always used.
 *
 * It is a FALLBACK and never a widening: with no name recorded, or no row bearing it, this returns
 * undefined and the panel degrades to level 1 exactly as it did before — the JOS-105 rule, intact.
 * Ties go to the first (highest-ranked) row, which is the one a reader means by the name.
 */
function resolveSubject(entities: SourceView[], drill: MeterDrill): SourceView | undefined {
  const byId = entities.find((e) => e.id === drill.entityId)
  if (byId || drill.name === undefined || drill.name === '') return byId
  return entities.find((e) => e.name === drill.name)
}

/**
 * THE ROW BUILDER. Every damage meter calls exactly this, with exactly its own drill token — the
 * Combat tab and the Overview card through `dashboardData.meterDrill`, the overlay by handing
 * over the value it persisted. `null` means LEVEL 1 on all three: one spelling, one level, so no
 * two surfaces can open on different things. Everything downstream — nesting, ranking, bar
 * widths, the pet's real name, the parent for the crumb, and the category detail — is decided
 * here, once.
 *
 * The drill is resolved against the RAW entity list, never the folded one: a pet that has no
 * level-1 bar of its own while combine is on is still a perfectly good drill subject (it is a
 * line item inside your breakdown, and a persisted drill straight into it must still resolve).
 *
 * A STALE DRILL DEGRADES TO LEVEL 1, never to a blank list: a token that resolves to nothing
 * renders the source list. The caller's stored value is untouched, so the drill re-applies the
 * moment the data is back — which is what lets the Combat tab keep a drill across a fight change
 * (JOS-240) instead of throwing it away: a fight without that subject shows the clean source list
 * and the next fight that HAS it opens drilled again.
 *
 * "Resolves" is `resolveSubject` above: the id, then the recorded name.
 */
/**
 * WHAT THE HEADLINE OVER *THIS* PANEL COVERS — the one derivation every UNLABELLED damage
 * headline in the app reads (JOS-170).
 *
 * THE DEFECT IT FIXES, in the owner's words: "with a fight drilled into the You row, changing the
 * pet preference does not recalculate the You line - the pet was moved out, and the title line for
 * the You drill kept the old combined total (321 in the observed case)."
 *
 * Nothing was memoized wrong and nothing was snapshotted at drill time. The headline was simply
 * the SEGMENT's aggregate at every level — you + your pets + whoever else swung — and while the
 * pet was folded INTO your row that aggregate happened to be exactly what the You drill was
 * showing (`total` there is self + nested pets, which IS `outTotal` for a solo fight; see the
 * header of this file). Turn the preference off and the pet's damage leaves the drill while the
 * headline stays where it was: a number no visible row accounts for, which is the "aggregates
 * lie" failure (world-model law 5) and the exact reason `meterScope.scopeTotals` exists one axis
 * over. The preference did not fail to apply — the rows moved and the headline was never asked to.
 *
 * SO IT IS DERIVED FROM WHAT THE PANEL IS SHOWING, at whichever level it resolved:
 *   level 1 ⇒ the caller's already-scoped pair, unchanged (the ranked list IS the segment, minus
 *             whatever the meter scope filtered — which `scopeTotals` has already accounted for).
 *   level 2 ⇒ the drilled subject plus the pets nested INTO it, which is exactly what
 *             `MeterPanel.rows` sums to. Flip the preference and `pets` empties, so the number
 *             follows in the same render — in both directions and without re-selecting anything.
 *
 * `dps` is SCALED rather than re-derived, for `scopeTotals`' reason: every source's rate divides
 * by the same segment elapsed time (`main/combat/sourceViews.ts` — `s.total / durationSec`), so
 * the ratio is exact arithmetic rather than a second opinion. That also makes it the right call
 * for the ACTIVE-time rate, which no source carries at all: one function, either rate.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH: the overlay meters' crumb figure, which is LABELLED `all`
 * and states the whole segment on purpose (JOS-158, owner direction with a screenshot —
 * overlay/meterCrumb.tsx says so at length). That is the rule this ticket makes explicit: a
 * headline that SAYS what it covers may cover the segment; an unlabelled one sitting above the
 * rows must describe the rows.
 */
export function panelTotals(panel: MeterPanel, total: number, dps: number): { total: number; dps: number } {
  if (panel.level === 1) return { total, dps }
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives SourceView. Becomes a view descriptor when the source lands.
  const shown = [panel.subject, ...panel.pets].reduce((n, s) => n + s.total, 0)
  return { total: shown, dps: total > 0 ? (dps * shown) / total : 0 }
}

export function meterPanel(entities: SourceView[], combine: boolean, drill: MeterDrill | null): MeterPanel {
  const subject = drill ? resolveSubject(entities, drill) : undefined
  if (!subject) return { level: 1, sources: meterSources(entities, combine) }
  // Pets nest into YOUR row only: a pet inside a pet would be a fiction, and an enemy's row in
  // the Incoming direction has no pets of yours in it at all.
  const nestable = combine ? petSources(entities) : []
  const pets = subject.kind === 'you' ? nestable : []
  const parent = subject.kind === 'pet' && nestable.some((p) => p.id === subject.id) ? selfSource(entities) : null
  return { level: 2, subject, parent, pets, rows: nestedRows(subject, pets) }
}
