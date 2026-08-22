// Healing + absorption aggregation (Task #59).
//
// The engine already ROUTED heals (routeHeal: enemy-healing annotation + a flat top-healers
// list). This module holds the full meter-grade accumulation behind that routing — per healer,
// per spell, with crit / min / max / overheal — plus the absorption lanes, and turns it into the
// serializable HealingView the two healing overlays render.
//
// It lives beside the damage aggregate (one HealAccum per Agg), NOT beside it in time: the engine
// folds heals into the SAME Agg objects the damage bars use, so a healing meter inherits fight /
// zone-session selection, the finalized-zone-session freeze, and the encounter history for free.
//
// HONESTY RULES baked in here (AGENTS.md world-model law 6 — say what the log cannot say):
//   - overheal is DERIVED from the `for N (M) hit points` form only. EQ writes the parens exactly
//     when raw > effective, so a plain line contributes 0 and the sum is a FLOOR, never a rate
//     projected over ticks we never saw.
//   - HoT ticks are NOT separated from direct heals HERE, though the log does distinguish them
//     (corrected 2026-08-04: `healed <target> over time for N` is a real family — 752 lines,
//     12 spells — and `HealEvent.overTime` now carries it. What this module still cannot do is
//     attribute a tick to the cast that started it; the split it declines to make is
//     "which heal was this a tick OF", not "was this a tick". A regen tick with no HoT wording
//     is still byte-identical in shape to a direct heal.)
//   - the two `magical skin absorbs` families carry NO amount. They are counted, never valued —
//     they enter no sum anywhere, because there is nothing to sum.
//   - a heal the log ANNOUNCES but never VALUES (JOS-86 — the monk's Mend, whose whole sentence
//     is `You mend your wounds and heal some damage.`) gets a lane of its own, classified
//     'unstated', carrying a COUNT and a total of 0. That 0 is the absence of a measurement, not
//     a measurement of zero, so it enters no sum and touches none of the row's headline stats —
//     the same treatment the rune lane gets for the opposite reason, and the same treatment the
//     `magical skin absorbs` families get for the identical one. What it must NOT be is a
//     `restored` lane reading 0: that is the one shape a reader would take as "Mend healed you
//     for nothing", and it is exactly the reading the log cannot support.
//   - a rune's amount is absorption GRANTED, not damage consumed. It DOES count toward the
//     healing total (a shield is sustain), but it is carried as a `classification: 'absorbed'`
//     LANE for its whole life so the assumption is never laundered into "hit points restored",
//     and it never touches the row's heal stats. A rune has no overheal; none is invented.
//   - rune SOURCES are not split (enchanter vs berserker AA). See the verified full-log sweep
//     documented above `mitigationView` — the gain line names no caster, and the correlate that
//     looked promising is 42%, not a rule.

import type {
  HealSourceKind,
  HealSourceView,
  HealSpellView,
  HealingView,
  MitigationView
} from '../../shared/combat'

/** One heal line, already attributed by the engine. */
export interface HealInput {
  /** Effective (landed) heal. */
  amount: number
  /** Raw/pre-overheal amount, present only on the `(M)` lines. */
  rawAmount?: number
  spell?: string
  crit?: boolean
}

interface HealSpellStat {
  name: string
  total: number
  count: number
  crits: number
  max: number
  min?: number
  overheal: number
  fullOverheal: number
}

interface HealSourceStat {
  name: string
  kind: HealSourceKind
  total: number
  count: number
  crits: number
  max: number
  min?: number
  overheal: number
  fullOverheal: number
  bySpell: Map<string, HealSpellStat>
}

/** Spell-less heal lines (482 in the real log) get one honest shared lane. */
export const UNSPECIFIED_SPELL = 'Unspecified'

/** Track the smallest LANDED heal. A 0-effective (fully overhealed) tick still landed a line, so
 *  it participates — unlike the damage model's min, which must never see a miss. */
function accrueMin(cur: number | undefined, amount: number): number {
  return cur === undefined ? amount : Math.min(cur, amount)
}

function newSpell(name: string): HealSpellStat {
  return { name, total: 0, count: 0, crits: 0, max: 0, overheal: 0, fullOverheal: 0 }
}

function newSource(name: string, kind: HealSourceKind): HealSourceStat {
  return {
    name, kind, total: 0, count: 0, crits: 0, max: 0, overheal: 0, fullOverheal: 0, bySpell: new Map()
  }
}

/** The absorption counters. Amounts exist for runes only — the rest are counts by construction,
 *  which is exactly why only the rune lane can become a ledger row (see runeRow). */
interface MitAccum {
  runeTotal: number
  runeCount: number
  runeMax: number
  runeMin?: number
  absorbedSwings: number
  absorbedDamageShields: number
}

function newMit(): MitAccum {
  return { runeTotal: 0, runeCount: 0, runeMax: 0, absorbedSwings: 0, absorbedDamageShields: 0 }
}

/**
 * The healing half of an aggregate. Two independent ledgers, mirroring the damage model's
 * out/incoming split:
 *   - `friendly`: heals that landed on YOU, your pets, or the player by name — "who kept me
 *     alive". This is the meter's ranking.
 *   - `hostile`: heals that landed on an ENGAGED hostile instance — counter-healing that undid
 *     your damage. Ranked by HEALER (a mob healing itself is its own row).
 * Heals between third parties (other players healing each other) are deliberately NOT collected:
 * the log gives no faction for an arbitrary name, and guessing one would invent a world model.
 *
 * `mit` is the third ledger: the raw absorption counters. Its rune half is serialized BOTH as a
 * classified row inside `friendly`'s ranking (buildHealingView) and, unaggregated, as
 * `HealingView.mitigation` — one number, two views, no duplication of the accumulation itself.
 */
export class HealAccum {
  friendly = new Map<string, HealSourceStat>()
  hostile = new Map<string, HealSourceStat>()
  mit = newMit()
  /**
   * Amount-less heals BY SKILL NAME → how many landed. A Map rather than a single Mend counter
   * because the ledger should not have to change shape the day a second amount-less family
   * graduates — but nothing invents one: today the log prints exactly one (see MEND_RE).
   * Keyed on the skill name itself, which the parser owns; there is no case-folding to do
   * because the name is a constant in the parser, never a capture off a dirty line.
   */
  unstated = new Map<string, number>()

  addFriendly(key: string, name: string, kind: HealSourceKind, h: HealInput): void {
    add(this.friendly, key, { name, kind }, h)
  }
  /** One `You mend your wounds…` line. A count, and deliberately nothing else. */
  addUnstated(skill: string): void {
    this.unstated.set(skill, (this.unstated.get(skill) ?? 0) + 1)
  }
  addHostile(key: string, name: string, h: HealInput): void {
    add(this.hostile, key, { name, kind: 'enemy' }, h)
  }
  addRune(amount: number): void {
    const m = this.mit
    m.runeTotal += amount
    m.runeCount += 1
    m.runeMax = Math.max(m.runeMax, amount)
    m.runeMin = m.runeMin === undefined ? amount : Math.min(m.runeMin, amount)
  }
  addAbsorbedSwing(): void {
    this.mit.absorbedSwings += 1
  }
  addAbsorbedDamageShield(): void {
    this.mit.absorbedDamageShields += 1
  }

  /** A DEEP COPY. The merge (combat/mergeSessions.ts) is pure, so it may not hand back a ledger
   *  that aliases either input's counters. Lives here because the row shapes are module-private. */
  clone(): HealAccum {
    const copy = new HealAccum()
    copy.friendly = cloneSources(this.friendly)
    copy.hostile = cloneSources(this.hostile)
    copy.mit = { ...this.mit }
    copy.unstated = new Map(this.unstated)
    return copy
  }

  /**
   * FOLD A LATER LEDGER INTO THIS ONE — the healing half of the merge-back proof obligation
   * (JOS-322). Every field here is a SUM, an EXTREMUM or a LATEST-WINS label, which is precisely
   * why the split is reversible: nothing in this ledger is a rate or a mean, and `overhealPct` /
   * `hps` are derived at VIEW time from the totals rather than stored.
   *
   * `min` follows the accumulator's own sentinel rule — `undefined` means "nothing landed yet", so
   * the merged minimum is the smaller of whichever sides actually have one — and `kind` follows
   * `add`'s: the LATEST attribution wins, and `next` is the later ledger.
   */
  absorb(next: HealAccum): void {
    absorbSources(this.friendly, next.friendly)
    absorbSources(this.hostile, next.hostile)
    const m = this.mit
    const n = next.mit
    m.runeTotal += n.runeTotal
    m.runeCount += n.runeCount
    m.runeMax = Math.max(m.runeMax, n.runeMax)
    assignMin(m, 'runeMin', minOf(m.runeMin, n.runeMin))
    m.absorbedSwings += n.absorbedSwings
    m.absorbedDamageShields += n.absorbedDamageShields
    for (const [k, v] of next.unstated) this.unstated.set(k, (this.unstated.get(k) ?? 0) + v)
  }
}

/** The smaller of two optional minima under the accumulator's own sentinel rule: `undefined` is
 *  "no landed line on this side", never a zero to be dragged into the answer. */
function minOf(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

/**
 * Write an optional minimum WITHOUT MINTING THE KEY when there is nothing to say.
 *
 * `min: undefined` and an absent `min` are different objects to a deep comparison, and the
 * byte-identity gate (JOS-322) compares a merged ledger against one that was never split — where a
 * lane with no landed line simply has no `min` property at all. So an absent minimum stays absent.
 */
function assignMin<K extends string>(o: Partial<Record<K, number>>, key: K, v: number | undefined): void {
  if (v !== undefined) o[key] = v
}

function cloneSpell(s: HealSpellStat): HealSpellStat {
  return { ...s }
}

function cloneSource(s: HealSourceStat): HealSourceStat {
  const bySpell = new Map<string, HealSpellStat>()
  for (const [sk, sv] of s.bySpell) bySpell.set(sk, cloneSpell(sv))
  return { ...s, bySpell }
}

function cloneSources(m: Map<string, HealSourceStat>): Map<string, HealSourceStat> {
  const out = new Map<string, HealSourceStat>()
  for (const [k, s] of m) out.set(k, cloneSource(s))
  return out
}

/** Sum one heal ledger's rows into another's, row by row and lane by lane. */
function absorbSources(into: Map<string, HealSourceStat>, from: Map<string, HealSourceStat>): void {
  for (const [k, s] of from) {
    const cur = into.get(k)
    if (!cur) {
      into.set(k, cloneSource(s))
      continue
    }
    cur.name = s.name
    cur.kind = s.kind
    cur.total += s.total
    cur.count += s.count
    cur.crits += s.crits
    cur.max = Math.max(cur.max, s.max)
    assignMin(cur, 'min', minOf(cur.min, s.min))
    cur.overheal += s.overheal
    cur.fullOverheal += s.fullOverheal
    absorbSpells(cur.bySpell, s.bySpell)
  }
}

/** The lane half of `absorbSources` — same five sums, same extremum, same sentinel rule. */
function absorbSpells(into: Map<string, HealSpellStat>, from: Map<string, HealSpellStat>): void {
  for (const [sk, sv] of from) {
    const lane = into.get(sk)
    if (!lane) {
      into.set(sk, cloneSpell(sv))
      continue
    }
    lane.total += sv.total
    lane.count += sv.count
    lane.crits += sv.crits
    lane.max = Math.max(lane.max, sv.max)
    assignMin(lane, 'min', minOf(lane.min, sv.min))
    lane.overheal += sv.overheal
    lane.fullOverheal += sv.fullOverheal
  }
}

function add(
  m: Map<string, HealSourceStat>,
  key: string,
  ref: { name: string; kind: HealSourceKind },
  h: HealInput
): void {
  const { name, kind } = ref
  const s = m.get(key) ?? newSource(name, kind)
  if (s.name !== name) s.name = name
  // A healer first seen healing a hostile can later be reclassified (a charmed mob becomes your
  // pet); the LATEST attribution wins, matching how the damage model relabels a source.
  s.kind = kind
  // EQ omits the parens whenever nothing was wasted, so a plain line's raw == effective.
  const raw = h.rawAmount ?? h.amount
  const over = Math.max(0, raw - h.amount)
  s.total += h.amount
  s.count += 1
  if (h.crit) s.crits += 1
  s.max = Math.max(s.max, h.amount)
  s.min = accrueMin(s.min, h.amount)
  s.overheal += over
  if (h.amount === 0) s.fullOverheal += 1

  // An absent, blank or whitespace-only spell name all fall to the one shared lane — never
  // a nullish check, which would let `''` through as a lane of its own.
  const trimmedSpell = h.spell?.trim() ?? ''
  const spellName = trimmedSpell === '' ? UNSPECIFIED_SPELL : trimmedSpell
  const sp = s.bySpell.get(spellName) ?? newSpell(spellName)
  sp.total += h.amount
  sp.count += 1
  if (h.crit) sp.crits += 1
  sp.max = Math.max(sp.max, h.amount)
  sp.min = accrueMin(sp.min, h.amount)
  sp.overheal += over
  if (h.amount === 0) sp.fullOverheal += 1
  s.bySpell.set(spellName, sp)
  m.set(key, s)
}

/** Cap on serialized spell lanes per healer — same spirit as the damage model's 12-skill cap.
 *  It applies to the HEAL lanes only; the absorption lane is appended after the cap so it can
 *  never be squeezed out of the flat drill by a long tail of small heals. */
const SPELL_CAP = 14

function healLanes(s: HealSourceStat): HealSpellView[] {
  const rows = [...s.bySpell.values()].sort(
    (a, b) => b.total - a.total || b.count - a.count || a.name.localeCompare(b.name)
  )
  return rows.slice(0, SPELL_CAP).map((r) => ({
    name: r.name,
    total: r.total,
    pct: 0,
    count: r.count,
    crits: r.crits,
    max: r.max,
    ...(r.min !== undefined ? { min: r.min } : {}),
    overheal: r.overheal,
    fullOverheal: r.fullOverheal,
    classification: 'restored'
  }))
}

/** Display name of the absorption lane. */
export const RUNE_LANE = 'Rune'

/**
 * The rune grants as ONE drill lane. Nothing that would be a guess is filled in: no crits, and
 * no overheal — the log never says a shield expired unused, so "wasted absorption" would be an
 * invention (AGENTS.md law 1/6).
 */
function runeLane(m: MitAccum): HealSpellView | null {
  if (m.runeCount === 0) return null
  return {
    name: RUNE_LANE,
    total: m.runeTotal,
    pct: 0,
    count: m.runeCount,
    crits: 0,
    max: m.runeMax,
    ...(m.runeMin !== undefined ? { min: m.runeMin } : {}),
    overheal: 0,
    fullOverheal: 0,
    classification: 'absorbed'
  }
}

/**
 * The amount-less heal lanes (JOS-86). Every field that would be a claim about SIZE is 0 and
 * stays 0: no max, no min (absent, not zero — `min: 0` would read as "the smallest Mend healed
 * nothing"), no crits, no overheal. `count` is the entire content of the lane, which is the
 * entire content of the log line.
 *
 * Sorted by count then name so the order is stable; they rank LAST in the flat list by
 * construction, since `rankLanes` sorts on total and theirs is 0.
 */
function unstatedLanes(m: Map<string, number>): HealSpellView[] {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({
      name,
      total: 0,
      pct: 0,
      count,
      crits: 0,
      max: 0,
      overheal: 0,
      fullOverheal: 0,
      classification: 'unstated' as const
    }))
}

/** ONE flat ranked list — heals and absorption together, biggest first, each lane keeping its
 *  classification so the two are never confused. Deliberately NOT grouped into sections: a
 *  grouping level is exactly what hid the flat breakdown in the damage drill-down. */
function rankLanes(lanes: HealSpellView[]): HealSpellView[] {
  const sorted = [...lanes].sort(
    (a, b) => b.total - a.total || b.count - a.count || a.name.localeCompare(b.name)
  )
  const max = Math.max(1, ...sorted.map((r) => r.total))
  return sorted.map((l) => ({ ...l, pct: (l.total / max) * 100 }))
}

/**
 * A ledger row. `pct`/`hps` are placeholders — they are relative to the final row set, so
 * `rankRows` fills them in last.
 *
 * `extraLanes` carries the absorption lane onto the row it belongs to. The row's HEADLINE stats
 * (count, crits, max, min, overheal, overhealPct) stay about RESTORED healing only — mixing a
 * rune grant into "6 heals, max 428" would be an aggregate that lies (law 5). `total` is the
 * combined ranking figure and `absorbedTotal` says how much of it is absorption.
 */
function toView(key: string, s: HealSourceStat, extraLanes: HealSpellView[] = []): HealSourceView {
  const absorbedTotal = extraLanes.reduce(
    (t, l) => (l.classification === 'absorbed' ? t + l.total : t),
    0
  )
  // Summed off the LANES rather than tracked a second time on the row, so the two can never
  // disagree. It joins no total: an unstated lane's `total` is 0 by construction.
  const unstatedCount = extraLanes.reduce(
    (t, l) => (l.classification === 'unstated' ? t + l.count : t),
    0
  )
  return {
    id: key,
    name: s.name,
    kind: s.kind,
    total: s.total + absorbedTotal,
    absorbedTotal,
    hps: 0,
    pct: 0,
    count: s.count,
    unstatedCount,
    crits: s.crits,
    critPct: s.count > 0 ? (s.crits / s.count) * 100 : 0,
    max: s.max,
    ...(s.min !== undefined ? { min: s.min } : {}),
    overheal: s.overheal,
    // Relative to RESTORED healing, never to the combined total — absorption in the denominator
    // would silently deflate a healer's overheal rate.
    overhealPct: s.total + s.overheal > 0 ? (s.overheal / (s.total + s.overheal)) * 100 : 0,
    fullOverheal: s.fullOverheal,
    spells: rankLanes([...healLanes(s), ...extraLanes])
  }
}

/** Sort the final row set and derive the two scope-relative figures (bar fill + rate). */
function rankRows(rows: HealSourceView[], durationSec: number): HealSourceView[] {
  const sorted = [...rows].sort(
    (a, b) => b.total - a.total || b.count - a.count || a.name.localeCompare(b.name)
  )
  const max = Math.max(1, ...sorted.map((r) => r.total))
  const dur = Math.max(1, durationSec)
  return sorted.map((r) => ({ ...r, pct: (r.total / max) * 100, hps: r.total / dur }))
}

function sourceViews(m: Map<string, HealSourceStat>, durationSec: number): HealSourceView[] {
  return rankRows(
    [...m.entries()].map(([key, s]) => toView(key, s)),
    durationSec
  )
}

/** Row id of the SELF row — the row the absorption lane attaches to (see buildHealingView). */
export const SELF_ROW_ID = 'you'

/**
 * ONE rune source, not two — VERIFIED, not assumed (full-log sweep of
 * eqlog_Primitive_freeport.txt, 1,019,355 lines, 2026-08-02):
 *
 *   - `You gain a rune for N points of absorption.` is the ONLY rune-gain shape (1,169 lines).
 *     It names no spell and no caster, so the LINE can never distinguish its source.
 *   - Both plausible sources exist for this character on paper: the berserker Blood Rune AA
 *     (`You have improved Blood Rune 2/3` — owned) and the enchanter Rune line (`Spell: Rune I`
 *     purchased and scribed).
 *   - But the enchanter rune NEVER LANDED on the player: its landing messages are known
 *     (spells.json Rune I–V, "A … shimmer of runes surround you.") and across the whole log
 *     `shimmer of runes` occurs exactly ONCE — on another player (`Dranix is surrounded by a
 *     shimmer of runes.`).
 *   - The proposed `You hurt yourself for N points.` correlate is only a CORRELATION: 487/1169
 *     gains (42%) have a self-hurt within 1s, 240 (21%) have none within 30s, and the amounts
 *     never track (13/487 equal). Self-hurt is its own berserker mechanic — it is followed just
 *     as often by `You kick …` and by `You have become better at Strategy!`.
 *
 * ⇒ Per world-model law 1 there is NO defensible split, so the model carries ONE absorption
 *   lane. If a split is ever wanted, the honest handle is the MESSAGE, not the self-damage: an
 *   active "shimmer of runes" buff (already in the spell DB, already tracked by the buffs
 *   module) is what would make an enchanter rune knowable. Do not split on the self-hurt line.
 */
function mitigationView(m: MitAccum): MitigationView {
  return {
    runeTotal: m.runeTotal,
    runeCount: m.runeCount,
    runeMax: m.runeMax,
    ...(m.runeMin !== undefined ? { runeMin: m.runeMin } : {}),
    absorbedSwings: m.absorbedSwings,
    absorbedDamageShields: m.absorbedDamageShields
  }
}

/**
 * Serialize an accumulator into the snapshot's HealingView.
 *
 * The rune lane attaches to the SELF row so a drill-down is ONE flat ranked list of everything
 * that kept you up — `Lay on Hands VI · Healing · Rune` — instead of hiding absorption behind a
 * section of its own. The self row is synthesized when it does not exist (absorption with no
 * heals is a real segment: see the W28 window).
 *
 * ATTRIBUTION, stated plainly: `You gain a rune for N points of absorption.` names no caster, so
 * "you granted it" is NOT something the log says. It is credited to your own sustain row because
 * the line is addressed to you and this meter's question is "what kept me alive" — and it is
 * LABELED as absorption everywhere it appears rather than silently merged (law 1). For this
 * character the credit is also very likely literally true: the enchanter rune never landed on
 * them in 1.02M lines (see the sweep above the mitigationView).
 *
 * The ENEMY ledger gets no absorption: runes are yours, and a mob's own shield is a miss
 * (mtype 'absorb'), never our mitigation.
 */
export function buildHealingView(acc: HealAccum, durationSec: number): HealingView {
  const rune = runeLane(acc.mit)
  // Both extras hang off the SELF row for the same reason: a rune is addressed to you and a Mend
  // is something you did to yourself, so "what kept me alive" is the row both belong on. They are
  // appended AFTER the SPELL_CAP for the same reason too — a long tail of small heals must not be
  // able to push either off the drill.
  const extras = [...(rune ? [rune] : []), ...unstatedLanes(acc.unstated)]
  const rows: HealSourceView[] = []
  let selfSeen = false
  for (const [key, s] of acc.friendly.entries()) {
    const isSelf = key === SELF_ROW_ID
    if (isSelf) selfSeen = true
    rows.push(toView(key, s, isSelf ? extras : []))
  }
  // A segment can hold NOTHING but extras — a rune ticking out of combat (the W28 window), or a
  // Mend with no valued heal beside it (the W55 window). The self row is synthesized so the lane
  // has somewhere to be; its headline stats stay honestly empty.
  if (extras.length > 0 && !selfSeen) {
    rows.push(toView(SELF_ROW_ID, newSource('You', 'you'), extras))
  }
  const healers = rankRows(rows, durationSec)
  const enemyHealers = sourceViews(acc.hostile, durationSec)
  const total = healers.reduce((s, h) => s + h.total, 0)
  const absorbedTotal = healers.reduce((s, h) => s + h.absorbedTotal, 0)
  return {
    healers,
    total,
    hps: total / Math.max(1, durationSec),
    restoredTotal: total - absorbedTotal,
    absorbedTotal,
    overheal: healers.reduce((s, h) => s + h.overheal, 0),
    enemyHealers,
    enemyTotal: enemyHealers.reduce((s, h) => s + h.total, 0),
    mitigation: mitigationView(acc.mit)
  }
}
