// Pure, renderer-side derivations for the combat DASHBOARD panels. No JSX, no MUI —
// everything here is a single-pass grouping over the selected encounter's TimelineView
// (≤2k serialized events) or over the authoritative SourceView aggregates.
//
// HONESTY (world-model law 5 — aggregates lie; law 1 — anything inferred is LABELED):
//   - The engine downsamples an encounter's event ring with a UNIFORM STRIDE once it
//     exceeds its serialization budget. Every number derived from a downsampled event
//     list is therefore an ESTIMATE. We scale sums/counts by the sampling factor (the
//     unbiased estimator for uniform-stride sampling) and hand the caller `estimated`
//     so every affected number renders with the `~` prefix. Observed maxima are NOT
//     scaled — a sampled max is a lower bound, never inflated.
//   - The ring itself is capped drop-OLDEST, so a long enough fight can outgrow it
//     (`TimelineView.truncated`). That loss is NOT a uniform sample — it is a suffix of
//     the fight — so it is deliberately NOT folded into the sampling factor: scaling by
//     the true instant count would extrapolate the discarded prefix from the retained
//     tail, i.e. invent damage. Instead every number keeps the same `~` + explainer
//     treatment as a downsampled ring and reads as a LOWER BOUND over the retained
//     window (`approxNote()` spells out which loss, or both, applies).
//   - Finalized ZONE sessions keep no event ring at all (the snapshot's `timeline` is
//     null). Callers degrade to a quiet note; these functions are simply not called.
// The authoritative totals always remain the engine's SourceView bars.

// RELATIVE value import, like procRows.ts and mobSearch.ts: this module is imported by node
// tests (tests/combatPerMobGhosts.test.mts), which resolve no `@shared/*` alias for values.
import { LIVE_FIGHT } from '../../../../shared/fightSelection'
import { abilityMultiAttack, abilityRiposte, type AbilityMulti, type AbilityRiposte } from './abilityStats'
import { groupSpellComponents, mergeGroup, rankRows } from './skillGroups'
import type {
  DamageCategory,
  SegmentSummary,
  SkillView,
  SourceView,
  TimelineView,
  ZoneSessionSummary
} from '@shared/combat'

/** A skill row tagged with the category it was rolled up under (the color key). */
export type FlatSkill = SkillView & { category: DamageCategory }

/**
 * A row of the flat level-2 list. Identical to a FlatSkill except that a GROUP row also carries
 * the rows it stands for (`children`) — the Slay Undead aggregate and the spell-component merge —
 * and that a row may carry its own per-ability multi-attack reading (`multi`, JOS-113: the
 * double/triple that used to live one level down, attached to the ability it belongs to). Both
 * are optional; consumers that just render a bar ignore them, the ones that expand a row use them.
 */
export type SkillRow = FlatSkill & {
  children?: FlatSkill[]
  multi?: AbilityMulti | null
  /** The share of this ability's damage that came from riposte counter-swings (JOS-354). Present
   *  on the auto-attack ability only — see `abilityRiposte` for why it is a subset, not a row. */
  riposte?: AbilityRiposte | null
  /** What a GROUP row's children are, for the two labels that name them ("· 2 skills" on the bar
   *  face, "By skill" over the expansion). Absent ⇒ 'skill', which is what the Slay Undead group
   *  has always said. A spell group's children are the message SHAPES one cast printed, not
   *  separate abilities, so it says 'component' instead. */
  childKind?: 'skill' | 'component'
}

/**
 * Label for the aggregated slay row. Mirrors `CATEGORY_LABEL.slay` in @shared/combat, spelled
 * literally because this module is imported by node tests (tests/combatPerMobGhosts.test.mts),
 * which run without the renderer's `@shared` alias — a VALUE import here would break them.
 */
const SLAY_LABEL = 'Slay Undead'

/**
 * Collapse every `slay`-category row into ONE "Slay Undead" aggregate.
 *
 * WHY: a Slay Undead proc is a normal weapon swing that carries the proc, so the flatten names
 * it after the weapon verb — "Melee", "Backstab", "Bash", "Kick" — and the flat list grew a run
 * of near-duplicate ivory rows that are all the same THING (the paladin proc) seen through
 * different weapons. The user reads them as one ability, so the list shows one row; the weapon
 * split is one click down, inside the row's own expansion (no new nav level).
 *
 * Aggregation, child ranking and the list's re-scaling are `skillGroups.mergeGroup`/`rankRows` —
 * shared with the spell-component merge (JOS-244), so the two groups this list can hold behave
 * identically and there is one place to read what a group row's numbers mean.
 *
 * A single slay skill is left EXACTLY as it is: a group of one is a wrapper around nothing, and
 * the per-weapon row ("Backstab · Slay Undead") is strictly more informative than a "Slay Undead"
 * row whose only child repeats it.
 */
export function groupSlay(rows: SkillRow[]): SkillRow[] {
  const slay = rows.filter((r) => r.category === 'slay')
  if (slay.length < 2) return rows
  const group = mergeGroup(slay, SLAY_LABEL, 'slay', 'skill')
  return rankRows([...rows.filter((r) => r.category !== 'slay'), group])
}

/**
 * Drill-down selection (union) — ONE token, one mechanic, every damage surface (JOS-105), now TWO
 * levels (JOS-113: the owner rejected the level-3 CATEGORY drill; per-ability stats expand INLINE
 * within the level-2 list instead — see abilityStats.ts / combatShared.SkillBar).
 *
 * `entity`   = level 2, the flat ONE-BAR-PER-ABILITY list for one source (the meter drill).
 * `target`   = the flat skill list for everything you and your pet landed on ONE mob (driven by
 *              the Damage-by-mob panel; Combat tab only).
 *
 * They are mutually exclusive by construction: picking either replaces the other, so the panel
 * always has exactly one subject and one breadcrumb.
 *
 * `name` IS THE IDENTITY THAT CROSSES FIGHTS (JOS-240), and it is why the entity arm carries two
 * fields for one subject. A `SourceView.id` is only as stable as what minted it: 'you',
 * `member:<key>` and `heal:<key>` are the same string in every fight, but `pet:<instanceId>` and
 * an incoming mob's id are WORLD INSTANCES — one spawn, one summon — so the same pet after a
 * re-summon, or the same fight after a restart re-folded the log, is a different id for what the
 * user reads as the same row. The name is what they clicked; the id is what they clicked it on.
 * Resolution prefers the id and falls back to the name (`petRows.meterPanel`), so an exact match
 * always wins and the name only ever rescues a drill that would otherwise have degraded.
 *
 * OPTIONAL, not required: a token written by a build before JOS-240 carries no name, and reads
 * exactly as it always did. The `target` arm needs none — a mob drill was always keyed by NAME.
 */
export type Drill = { kind: 'entity'; entityId: string; name?: string } | { kind: 'target'; target: string }

/**
 * The drill token as the ROW BUILDER wants it (`petRows.meterPanel`). The mob arm is not a source
 * drill at all, so it resolves to `null` — level 1 — exactly as an explicit un-drill does.
 *
 * This is the one translation between the Combat tab's union and the shape the overlay already
 * persists (`OverlayDrill`), which is why the overlay hands its stored value straight to the
 * builder and needs no translation of its own. The overlay passes no `name` and so keeps the
 * pure id resolution it has always had.
 */
export function meterDrill(drill: Drill | null): { entityId: string; name?: string } | null {
  if (!drill) return null
  if (drill.kind === 'entity') return { entityId: drill.entityId, name: drill.name }
  return null
}

/**
 * Flatten a source's per-category skill lists into ONE list ranked by damage desc, and
 * re-base each row's bar pct on the global max (the engine's `pct` is relative to the
 * skill's own category max, which would make small categories render full-width here).
 * The slay rows then collapse into a single grouped row (`groupSlay`), and the two message
 * shapes of one spell into another (`groupSpellComponents`, JOS-244) — the TWO places the flat
 * list departs from "one row per engine skill", so every surface that renders this list (meter
 * drill, overlay drill, breakdown preview, copy-to-clipboard) groups identically.
 */
export function flattenSkills(e: SourceView): SkillRow[] {
  const rows: FlatSkill[] = e.categories.flatMap((c) => c.skills.map((s) => ({ ...s, category: c.category })))
  rows.sort((a, b) => b.total - a.total || b.hits - a.hits || a.name.localeCompare(b.name))
  const max = Math.max(1, ...rows.map((r) => r.total))
  // Each row carries its OWN multi-attack reading (JOS-113): the double/triple that used to live
  // one drill level down, attached to the ability it belongs to. `abilityMultiAttack` reads the
  // engine's round lanes and files each to exactly one ability (auto-attack "Melee" pools its
  // weapon verbs; a named special is its own lane). groupSlay spreads it through onto any child.
  return groupSlay(
    groupSpellComponents(
      rows.map((r) => ({
        ...r,
        pct: (r.total / max) * 100,
        multi: abilityMultiAttack(e, r.name, r.category),
        // Riposte damage is a SUBSET of the ability it rides (JOS-354): stated inside the
        // auto-attack row's expansion, never given a bar of its own, because the damage is
        // already in that bar's total.
        riposte: abilityRiposte(e, r.name, r.category)
      }))
    )
  )
}

/**
 * Sampling factor for a (possibly downsampled) timeline: 1 when every retained event is
 * present. The denominator is `rawCount` — what the RING held — and never `totalCount`:
 * over the ring the stride is uniform (so this is unbiased), but the instants the ring
 * dropped are a whole missing prefix, and inflating by them would be a guess, not an
 * estimate. A truncated ring therefore keeps scale 1 and reports lower bounds.
 */
export function sampleScale(tl: TimelineView): number {
  if (!tl.downsampled || tl.events.length === 0) return 1
  return Math.max(1, tl.rawCount / tl.events.length)
}

/**
 * Are this timeline's event-derived numbers inexact — i.e. must every one of them wear the
 * `~` prefix and the panel wear the explainer chip? True for EITHER loss:
 *   downsampled → the numbers are scaled sample estimates;
 *   truncated   → the numbers cover only the fight's most recent instants (lower bounds).
 * ONE predicate so a panel can never label one loss and silently swallow the other.
 */
export function isApproximate(tl: TimelineView): boolean {
  return tl.downsampled || tl.truncated
}

/**
 * What the panel's explainer chip must say, or null when the timeline is exact.
 * `of` is the TRUE instant count (`totalCount`), so a truncated ring can never advertise
 * its own capacity as if it were the size of the fight.
 */
export interface ApproxNote {
  /** instants actually carried (and derived from). */
  shown: number
  /** instants the fight actually produced — what `shown` should be read against. */
  of: number
  /** a uniform-stride sample of the retained ring → numbers are scaled estimates. */
  downsampled: boolean
  /** the ring dropped the fight's oldest instants → numbers are lower bounds. */
  truncated: boolean
}

export function approxNote(tl: TimelineView): ApproxNote | null {
  if (!isApproximate(tl)) return null
  return {
    shown: tl.events.length,
    of: tl.totalCount,
    downsampled: tl.downsampled,
    truncated: tl.truncated
  }
}

// ── DPS over time ──────────────────────────────────────────────────────────────────

/** Widest bucket count we ever plot — the SVG is render-bound, so keep the polyline short. */
const MAX_BUCKETS = 360
/** Rolling-window width for the smoothed rate (reads as a curve, not a comb). */
const SMOOTH_MS = 5_000
/**
 * How much of a LIVE fight the curve actually SHOWS before it starts scrolling with `now`.
 * Spelled here rather than imported from dpsChart.ts so this module stays free of the chart
 * geometry (it is the pure, node-tested half); the chart owns the window, this owns the
 * sampling grid, and `bucketMsFor` below is the one place the two have to agree.
 */
const LIVE_WINDOW_MS = 120_000

/**
 * Bucket width for a series. The polyline must stay ≤ MAX_BUCKETS *of what is drawn* — and for
 * a scrolling live fight what is drawn is the last LIVE_WINDOW_MS, not the whole encounter.
 *
 * THE RESIDUAL THIS CLOSES (commit 5a9dbc2's note): sizing off raw `durationMs` made a long
 * live fight coarsen its buckets at 6/12/18 minutes even though the visible window never grew
 * past two minutes — so a marathon pull's curve lost resolution in the one region the user is
 * looking at, and every re-size stepped the whole line. Sizing off `min(durationMs,
 * LIVE_WINDOW_MS)` keeps 1-second buckets in the visible window for a fight of any length:
 * 120s ÷ 360 is well under a second, so the drawn bucket count stays ~120, far inside the
 * budget.
 *
 * A FINALIZED fight is byte-identical to before: it draws its WHOLE span, so its grid must be
 * sized by that span, and `live` defaults to false. This is opt-in on purpose — the timeline's
 * hover sampler reads the curve across the entire encounter and wants exactly the old grid.
 */
function bucketMsFor(durationMs: number, live: boolean): number {
  const shown = live ? Math.min(durationMs, LIVE_WINDOW_MS) : durationMs
  return Math.max(1000, Math.ceil(shown / MAX_BUCKETS / 1000) * 1000)
}

export interface DpsSeries {
  /** bucket width in ms (≥1s; grows for long fights so the polyline stays ≤MAX_BUCKETS). */
  bucketMs: number
  /** effective smoothing window in ms (a whole number of buckets, ≥ bucketMs). */
  smoothMs: number
  /** bucket count. */
  n: number
  /** smoothed rate (damage per second) per bucket. */
  you: Float64Array
  pet: Float64Array
  /** your GROUP's contribution (docs/plans/group-model.md) — every `member` instant, summed.
   *  Its own band rather than folded into `you` or `inc`: it is neither, and a curve that filed
   *  a group-mate's damage as incoming would draw the fight upside down. */
  group: Float64Array
  inc: Float64Array
  /** peak smoothed OUTGOING (you+pet+group) rate across the whole fight. */
  peakOut: number
  hasPet: boolean
  hasGroup: boolean
  hasInc: boolean
  /** true when any damage at all landed in the window. */
  hasAny: boolean
  durationMs: number
  /** true when the source events were downsampled and/or truncated → every rate here is
   *  inexact (a scaled estimate, a lower bound, or both — see `approxNote`). */
  estimated: boolean
}

/**
 * Bucket the encounter's events per `bucketMs` and smooth with a TRAILING rolling mean —
 * the same reading a live DPS meter gives ("your damage over the last 5 seconds"), so the
 * curve's height at time t is a rate you could actually have seen on screen at time t.
 * Leading buckets divide by the (shorter) elapsed window rather than the full one, so the
 * curve starts at the real opening rate instead of ramping from a fake zero.
 *
 * `live` says the curve will SCROLL — only then is the bucket grid sized by the visible window
 * instead of the whole encounter (see `bucketMsFor`). Default false, so every existing caller
 * and every finalized fight keeps exactly the grid it had.
 */
export function buildDpsSeries(tl: TimelineView, live = false): DpsSeries {
  const durationMs = Math.max(1000, tl.durationMs)
  const bucketMs = bucketMsFor(durationMs, live)
  const n = Math.max(1, Math.ceil(durationMs / bucketMs))
  const rawYou = new Float64Array(n)
  const rawPet = new Float64Array(n)
  const rawGroup = new Float64Array(n)
  const rawInc = new Float64Array(n)
  let hasPet = false
  let hasGroup = false
  let hasInc = false
  let hasAny = false
  const scale = sampleScale(tl)
  for (const e of tl.events) {
    if (e.amount <= 0) continue
    const i = Math.min(n - 1, Math.max(0, Math.floor(e.t / bucketMs)))
    hasAny = true
    if (e.kind === 'you') rawYou[i] += e.amount
    else if (e.kind === 'pet') {
      rawPet[i] += e.amount
      hasPet = true
    } else if (e.kind === 'member' || e.kind === 'allyPet' || e.kind === 'other') {
      // EXPLICIT, not an `else`. Before the group model the final branch was "everything that is
      // not you or your pet is incoming", which is exactly the assumption a fourth source kind
      // breaks: a group-mate's 300-damage nuke would have been drawn as damage taken. JOS-250's
      // FIFTH kind is the same trap again, so it is named here rather than left to fall through:
      // an ally's charm pet is somebody else's outgoing damage, which is what this band already
      // means. It shares the band rather than growing a sixth one because the curve answers "how
      // much is coming from where", and the row list beneath it is where the WHOSE is spelled out.
      // JOS-430's SIXTH kind ('other') is the trap a third time, and the most dangerous of the
      // three: it is the kind that fires on an ungrouped session, so a missing branch here would
      // have drawn a stranger's whole raid as damage TAKEN on the most common configuration there is.
      rawGroup[i] += e.amount
      hasGroup = true
    } else {
      rawInc[i] += e.amount
      hasInc = true
    }
  }
  const w = Math.max(1, Math.round(SMOOTH_MS / bucketMs))
  const smooth = (src: Float64Array): Float64Array => {
    const out = new Float64Array(n)
    let run = 0
    for (let i = 0; i < n; i++) {
      run += src[i]
      if (i >= w) run -= src[i - w]
      const spanSec = (Math.min(i + 1, w) * bucketMs) / 1000
      out[i] = (run * scale) / spanSec
    }
    return out
  }
  const you = smooth(rawYou)
  const pet = smooth(rawPet)
  const group = smooth(rawGroup)
  const inc = smooth(rawInc)
  let peakOut = 0
  for (let i = 0; i < n; i++) peakOut = Math.max(peakOut, you[i] + pet[i] + group[i])
  return {
    bucketMs,
    smoothMs: w * bucketMs,
    n,
    you,
    pet,
    group,
    inc,
    peakOut,
    hasPet,
    hasGroup,
    hasInc,
    hasAny,
    durationMs,
    // A truncated ring is inexact even at scale 1 (the curve simply has no data before the
    // retained window starts), so the flag is the loss predicate, not the scale.
    estimated: isApproximate(tl)
  }
}

// ── Damage by mob ──────────────────────────────────────────────────────────────────

export interface MobRow {
  /** raw defender name as the world model labelled it (twins already disambiguated). */
  target: string
  total: number
  hits: number
  crits: number
  /** avoided swings against this mob. */
  misses: number
  /** your spells this mob resisted. */
  resists: number
  /** pct of the LARGEST mob's total (bar fill). */
  pct: number
  /** pct of all event-derived outgoing damage (the ranked share). */
  share: number
}

export interface MobBreakdown {
  rows: MobRow[]
  /** event-derived outgoing total across all mobs. */
  total: number
  /** the ring was downsampled and/or truncated → every number above wears `~`. */
  estimated: boolean
}

/** Unnamed defender fallback — kept visible rather than silently dropped. */
const UNKNOWN_TARGET = 'unknown target'

/**
 * CASE FOLD (law 2 — names are dirty; key case-insensitively, display raw).
 *
 * EQ capitalizes an article-led mob name at SENTENCE START and leaves it lowercase
 * mid-sentence, so one spawn reaches the ring under two spellings:
 *   "A zol ghoul knight resisted your Smite!"          ← sentence-initial
 *   "You slash a zol ghoul knight for 118 points…"     ← mid-sentence, the TRUE name
 * Keying the panel by the raw string therefore split one mob into two rows — the reported
 * symptom being a phantom "0 · 0%" row holding a single resist.
 *
 * The engine now keeps an instance's display casing stable, and this fold is STILL required:
 * ring events are immutable once written, so a fight whose FIRST sighting of a mob is a
 * sentence-initial line (a pull that opens on a resist) has already stamped the capitalized
 * string into the ring before any mid-sentence line exists to correct it.
 *
 * The lowercase-INITIAL variant wins the label because that is the spawn's real name — the
 * capital is punctuation, not identity. A mob only ever seen capitalized keeps its capital
 * (proper names like "The Hand of Veeshan" are exactly that case), so the rule only ever
 * relabels a row once BOTH spellings have been seen.
 */
function startsLower(name: string): boolean {
  const c = name.charAt(0)
  return c !== '' && c === c.toLowerCase() && c !== c.toUpperCase()
}

/** The display name for a row that has now been seen as both `shown` and `next`. */
function preferredLabel(shown: string, next: string): string {
  if (shown === next) return shown
  return !startsLower(shown) && startsLower(next) ? next : shown
}

/**
 * Group OUTGOING instants (you + pet) by defender. One pass; misses/resists fold into the
 * same row as damage-free counters (law 8 — they're first-class but carry no amount).
 * Rows are keyed case-insensitively (see the fold above) and labelled with the best spelling
 * seen; everything downstream — sort, bar pct, share, sampling scale — is unchanged.
 */
export function groupByTarget(tl: TimelineView): MobBreakdown {
  const scale = sampleScale(tl)
  const byTarget = new Map<string, MobRow>()
  let total = 0
  for (const e of tl.events) {
    if (e.kind === 'enemy') continue
    const name = e.target ?? UNKNOWN_TARGET
    const key = name.toLowerCase()
    let row = byTarget.get(key)
    if (!row) {
      row = { target: name, total: 0, hits: 0, crits: 0, misses: 0, resists: 0, pct: 0, share: 0 }
      byTarget.set(key, row)
    } else {
      row.target = preferredLabel(row.target, name)
    }
    if (e.outcome === 'miss') row.misses += 1
    else if (e.outcome === 'resist') row.resists += 1
    else {
      row.total += e.amount
      row.hits += 1
      if (e.crit) row.crits += 1
      total += e.amount
    }
  }
  const rows = [...byTarget.values()]
  for (const r of rows) {
    r.total *= scale
    r.hits = Math.round(r.hits * scale)
    r.crits = Math.round(r.crits * scale)
    r.misses = Math.round(r.misses * scale)
    r.resists = Math.round(r.resists * scale)
  }
  total *= scale
  rows.sort((a, b) => b.total - a.total || b.hits - a.hits || a.target.localeCompare(b.target))
  const max = Math.max(1, ...rows.map((r) => r.total))
  for (const r of rows) {
    r.pct = (r.total / max) * 100
    r.share = total > 0 ? (r.total / total) * 100 : 0
  }
  return { rows, total, estimated: isApproximate(tl) }
}

export interface TargetDetail {
  /** flat, ranked skill/spell rows for the damage landed on this one mob (slay grouped). */
  rows: SkillRow[]
  total: number
  hits: number
  crits: number
  misses: number
  resists: number
  /** the ring was downsampled and/or truncated → every number above wears `~`. */
  estimated: boolean
}

/**
 * The level-2 flat skill list for ONE mob: every lane you and your pet landed on it,
 * grouped by (lane, category). You + pet are COMBINED here — the ring's per-event `kind`
 * could split them, but the panel exists to answer "what killed this mob", and a combined
 * list keeps the row set short; the header labels the combination.
 * `max`/`min` are the largest/smallest single observed hits and are deliberately NOT scaled by
 * the sampling factor (a sampled max is a lower bound and a sampled min an upper bound;
 * scaling either would invent a hit that never landed). A TRUNCATED ring has exactly the same
 * character — the fight's dropped opening may hold a bigger hit than anything retained — which
 * is why truncation reuses this labeling rather than a second visual language.
 */
/** The per-mob running totals folded alongside the per-lane rows (all pre-scale). */
interface TargetTotals {
  total: number
  hits: number
  crits: number
  misses: number
  resists: number
}

/**
 * Fold ONE event into its lane row and the running per-mob totals. Split out of
 * `skillsForTarget` purely as factoring — the three outcome arms are the same three the
 * event model has everywhere (miss / resist / landed), and they carry the one subtlety worth
 * naming: `max`/`min` stay UNSCALED observations (see the header), and `min` skips 0 so a
 * miss/resist tick — which carries no amount — can never pull the minimum down to nothing.
 */
function foldTargetEvent(row: FlatSkill, e: TimelineView['events'][number], t: TargetTotals): void {
  if (e.outcome === 'miss') {
    row.misses = (row.misses ?? 0) + 1
    t.misses += 1
    return
  }
  if (e.outcome === 'resist') {
    row.resists = (row.resists ?? 0) + 1
    t.resists += 1
    return
  }
  row.total += e.amount
  row.hits += 1
  t.hits += 1
  if (e.crit) {
    t.crits += 1
    row.crits += 1
  }
  if (e.amount > row.max) row.max = e.amount
  if (!row.min || e.amount < row.min) row.min = e.amount
  t.total += e.amount
}

/** Apply the uniform-stride sampling factor to every derived count/sum (never to max/min). */
function scaleSkillRows(rows: FlatSkill[], scale: number): void {
  for (const r of rows) {
    r.total *= scale
    r.hits = Math.round(r.hits * scale)
    r.crits = Math.round(r.crits * scale)
    r.misses = Math.round((r.misses ?? 0) * scale)
    r.resists = Math.round((r.resists ?? 0) * scale)
  }
}

export function skillsForTarget(tl: TimelineView, target: string): TargetDetail {
  const scale = sampleScale(tl)
  // Same case fold as `groupByTarget`: a folded row is ONE mob, so drilling it must collect
  // every spelling EQ used for it — otherwise the drill would show a subset of the row it was
  // opened from. Matching is symmetric, so a drill persisted under either spelling resolves.
  const want = target.toLowerCase()
  const byLane = new Map<string, FlatSkill>()
  const t: TargetTotals = { total: 0, hits: 0, crits: 0, misses: 0, resists: 0 }
  for (const e of tl.events) {
    if (e.kind === 'enemy') continue
    if ((e.target ?? UNKNOWN_TARGET).toLowerCase() !== want) continue
    const key = `${e.category}|${e.lane}`
    let row = byLane.get(key)
    if (!row) {
      row = { name: e.lane, category: e.category, total: 0, pct: 0, hits: 0, crits: 0, max: 0, min: 0, misses: 0, resists: 0 }
      byLane.set(key, row)
    }
    foldTargetEvent(row, e, t)
  }
  const rows = [...byLane.values()]
  scaleSkillRows(rows, scale)
  rows.sort((a, b) => b.total - a.total || b.hits - a.hits || a.name.localeCompare(b.name))
  const max = Math.max(1, ...rows.map((r) => r.total))
  for (const r of rows) r.pct = (r.total / max) * 100
  return {
    // Same grouping as the source drill — the per-mob list is the same flat list, filtered to one
    // defender, so it must not regrow the per-weapon slay duplicates NOR the two-shapes-of-one-
    // spell duplicates (JOS-244). Grouping runs AFTER the sample scaling above, so a downsampled
    // ring's group sums the same estimates its children show (all of them wear the panel's `~`).
    rows: groupSlay(groupSpellComponents(rows)),
    total: t.total * scale,
    hits: Math.round(t.hits * scale),
    crits: Math.round(t.crits * scale),
    misses: Math.round(t.misses * scale),
    resists: Math.round(t.resists * scale),
    estimated: isApproximate(tl)
  }
}

// ── Composition strip (authoritative — SourceView, not events) ──────────────────────

export interface CompositionSlice {
  category: DamageCategory
  total: number
  /** pct of the source's whole outgoing total. */
  pct: number
}

// ── Selector SCOPE (Fight vs Overall) ───────────────────────────────────────────────
//
// Fight and Overall are an explicit, user-chosen SCOPE — never an automatic switch. The
// dashboard used to fall back to the live ZONE aggregate whenever no fight was open, so the
// meter silently swapped between pulls; that is the behaviour this replaces. A scope decides
// BOTH what the body shows and what the selector may list:
//
//   fight   → the current fight while one is open, otherwise the LAST fight (labeled as such —
//             a finished fight is never dressed up as live), plus the finalized-fight history.
//             Zone sessions are not listed at all.
//   overall → the live zone session, plus the finalized zone-session history. Fights are not
//             listed at all.
//
// This lives here (a pure, MUI-free module) because every selector surface must filter
// identically: the Combat tab, the 'fight'/'overall' damage overlays and the heal overlays.

export type CombatScope = 'fight' | 'overall'

/**
 * WHICH DIMENSION the meter panel lists. `heal` joined the pair with P2
 * (docs/plans/combat-overlay-parity.md) — the panel had no healing at all while the floating
 * overlays had all of it, which is the parity the owner asked for.
 *
 * It is a DIMENSION, not a scope: it decides what one panel ranks, never which segment is
 * selected and never whether that segment is a fight or a zone session. Fight/Overall keeps
 * meaning exactly what it meant, in all three.
 */
export type MeterMode = 'out' | 'in' | 'heal'

/**
 * Sentinel selection meaning "whatever the fight scope's head row currently is". It is sent to
 * the engine as *no* `selectedId`, so the engine re-resolves it every tick (open fight → that
 * fight; none open → the most recent finalized fight). Pinning the last fight's real id instead
 * would freeze the meter on it when the next pull started.
 *
 * IT IS THE SAME SENTINEL THE GLOBAL SELECTION USES (P4) — `shared/fightSelection.ts` owns the
 * value now, because main validates against it too and two spellings of '__live__' would be a
 * silent cross-process disagreement. Re-exported under this name so every existing caller (the
 * overlays, useCombat, the picker) keeps the import it already had.
 */
export const LIVE_SELECTION = LIVE_FIGHT

/** One row of a scope-filtered selector. */
export interface ScopeOption {
  /** the value to hand `setSelection` (the LIVE sentinel for the fight scope's head row). */
  value: string
  /** the row's display name — already carries the honest live/last wording for a head row. */
  label: string
  /** raw name without the head-row wording (used for headers/titles). */
  name: string
  dps: number
  /** epoch ms of the segment's start; 0 when unknown. */
  startTs: number
  /** wall-clock length in seconds; 0 when it isn't knowable yet (the running zone session). */
  durationSec: number
  /** genuinely live right now — an OPEN fight, or the current zone session. */
  live: boolean
}

export interface ScopeOptions {
  /** The pinned first row. Null only when the scope has no data at all yet (fresh session). */
  head: ScopeOption | null
  /** Every other row, newest-first. Never contains `head`. */
  rest: ScopeOption[]
}

/** Fight scope: the current-or-last fight, then the finalized-fight history. NO zone sessions. */
export function fightScopeOptions(segments: SegmentSummary[]): ScopeOptions {
  const open = segments.find((s) => s.kind === 'current') ?? null
  const finalized = segments.filter((s) => s.kind === 'fight')
  const headSeg = open ?? finalized[0] ?? null
  if (!headSeg) return { head: null, rest: [] }
  const head: ScopeOption = {
    value: LIVE_SELECTION,
    // State, not process: while a fight is open this row IS the current fight; between pulls it
    // is plainly the last one. It must never read "live" for a finished encounter.
    label: open ? 'Current fight (live)' : `Last fight - ${headSeg.name}`,
    name: headSeg.name,
    dps: headSeg.dps,
    startTs: headSeg.startTs,
    durationSec: headSeg.durationSec,
    live: !!open
  }
  const rest = (open ? finalized : finalized.slice(1)).map((s) => ({
    value: s.id,
    label: s.name,
    name: s.name,
    dps: s.dps,
    startTs: s.startTs,
    durationSec: s.durationSec,
    live: false
  }))
  return { head, rest }
}

/**
 * THE WORD A ZONE-SESSION ROW IS CALLED BY (JOS-322) — the renderer's mirror of the engine's
 * `lifecycle.zoneSessionWord`, over the serialized summary.
 *
 * A stay the WORLD ended is that zone's `overall`; a stay the USER ended with the app-wide
 * "New session" mark is that zone's `session`, which is the word the loot ledger and the leveling
 * surfaces already print for the very same click. The live row has no `closedBy` at all and is
 * always `overall` — it has not ended, so nothing has decided anything about it yet.
 *
 * A MIRROR AND NOT A SECOND OPINION: the engine names the SegmentView it hands back with its own
 * copy of this rule, so the picker row and the header title of the thing it selects agree by
 * construction. Both read the same field of the same record.
 */
function zoneSessionWord(z: ZoneSessionSummary): string {
  return z.closedBy === 'mark' ? 'session' : 'overall'
}

/** Overall scope: the live zone session, then the finalized zone-session history. NO fights. */
export function overallScopeOptions(zoneSessions: ZoneSessionSummary[]): ScopeOptions {
  const toRow = (z: ZoneSessionSummary): ScopeOption => ({
    value: z.id,
    label: `${z.zone} - ${zoneSessionWord(z)}`,
    name: `${z.zone} - ${zoneSessionWord(z)}`,
    dps: z.dps,
    startTs: z.startTs,
    durationSec: z.live ? 0 : Math.max(1, (z.endTs - z.startTs) / 1000),
    live: z.live
  })
  const liveZone = zoneSessions.find((z) => z.live) ?? null
  const rest = zoneSessions.filter((z) => z !== liveZone).map(toRow)
  return { head: liveZone ? toRow(liveZone) : (rest.shift() ?? null), rest }
}

/**
 * IS THE THING ON SCREEN THE LIVE ONE? — the head row of its scope, and that head row genuinely
 * open (an in-progress fight, or the running zone session). Everything else the selector can
 * reach is finished: a `zs<n>` zone session you have left, a fight id from history, or the head
 * row between pulls, which is honestly labelled "Last fight — X" and is a finalized encounter.
 *
 * ONE SURFACE READS IT TODAY: the DPS curve's scrolling window, which follows `now` only for a
 * live selection — a finished fight must not scroll as if time were still passing in it.
 *
 * IT USED TO BE TWO. The second was the pet-claim OFFER ("<Name> — your pet?", with Yes and No),
 * which rendered only for a live selection because "is this thing yours?" is a question about the
 * fight in front of you. JOS-49 DELETED THE QUESTION — the owner's ruling was that ordering a pet
 * once is cheaper than a guess the app can get wrong — and nothing asks the user about a pet
 * anywhere in the product now (`tests/e2e/combatSteps.mts stepPetNeverAsked` asserts the absence,
 * including that the snapshot carries no `petClaims` for a surface to render).
 *
 * WHAT BINDS A PET INSTEAD lives entirely in main, in `src/main/combat/petClaims.ts`, and never
 * involves the user: three log lines, one state transition, no UI. The private `… Master.` tell
 * (JOS-47), the public `/pet who leader` answer (JOS-52), and your own pet-only buff landing
 * (JOS-188 — the route that costs the player nothing). The accepted blind spot is stated there
 * rather than papered over here: a player who neither orders nor buffs their pet has one the log
 * cannot bind, and that is the trade JOS-49 chose over asking.
 *
 * This function still lives here beside `scopeOptions` rather than in its one caller, because
 * panel/overlay parity is house law and "which selection is the live one" is the kind of question
 * a second surface asks the moment one appears.
 */
export function isLiveSelection(head: ScopeOption | null, selection: string): boolean {
  return !!head && selection === head.value && head.live
}

/** The scope-filtered selector rows. The ONE place a scope decides what may be listed. */
export function scopeOptions(
  scope: CombatScope,
  segments: SegmentSummary[],
  zoneSessions: ZoneSessionSummary[]
): ScopeOptions {
  return scope === 'fight' ? fightScopeOptions(segments) : overallScopeOptions(zoneSessions)
}

/** The selection a scope starts on (and returns to when the user switches scopes). */
export function defaultSelection(scope: CombatScope): string {
  return scope === 'fight' ? LIVE_SELECTION : 'zone'
}

/** 100%-stacked category composition for one source. Uses the engine's authoritative
 *  category rollups, so it stays exact for ring-less zone sessions too. */
export function composition(e: SourceView): CompositionSlice[] {
  const total = e.categories.reduce((n, c) => n + c.total, 0)
  if (total <= 0) return []
  return e.categories
    .filter((c) => c.total > 0)
    .map((c) => ({ category: c.category, total: c.total, pct: (c.total / total) * 100 }))
}
