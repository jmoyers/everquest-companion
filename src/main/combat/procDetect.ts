// PROC DETECTION (docs/plans/proc-analytics.md §4.1) — "a spell effect line with no own cast
// line behind it".
//
// THE ONE INFERENCE IN THIS FEATURE, and it is labeled as one everywhere it surfaces. The log
// prints `You begin casting <Spell>.` for every hand-cast the player makes, and prints
// NOTHING at all when a weapon, a buff-granted melee proc or the Spellblade invocation fires
// the same spell. So a spell effect with no own cast behind it, inside a stated window, is a
// proc — and the inference may name a CO-OCCURRENCE, never a source (a proc line in this log
// says nothing about which weapon, buff or AA produced it).
//
// THE WINDOW IS MEASURED, NOT GUESSED. At 12 seconds the real log's partition is clean
// (read-only sweep, rank-normalized names): every pure proc scores cast = 0
// (`Smiting Strike` 9,633 / `Lifetap Strike` 1,814 / `Condemnation of Nife` 1,096 /
// `Vampiric Embrace` 586 / `Ignite` 148 / `Dismiss Summoned` 23 / `Asp Venom Strike` 15) and
// every hand-cast nuke scores proc = 0 (`Chaotic Feedback` 893, `Sanity Warp` 502, `Anarchy`
// 112, `Strike` 90). The residual mixed lanes — `Discordant Mind` (352/352) and `Siphon Life`
// (293/293) — are GENUINELY mixed: they are the player's gem-#1 spells, and every cast-less
// firing of either happened while the `spellblade` invocation was active.
//
// THE DoT GATE IS LOAD-BEARING. A DoT tick arriving more than 12 seconds after its cast would
// misclassify as a proc by construction — its ticks are cast-DETACHED. So detection is gated
// to `dtype === 'spell'` and to heals; `dot` is NEVER eligible, and `melee`/`ds` are not spell
// effects at all. (Slay Undead procs are counted from the taxonomy's own `slay` category, not
// from here — they carry no spell line.)
//
// ── TWO CAST-LESS SHAPES THAT ARE NOT PROCS (2026-08-04, from the owner's accuracy report) ──
//
// The wave-1 header above measured the window against DIRECT DAMAGE lanes only, and the
// partition it reports is still exactly right for them. The HEAL half had no equivalent sweep,
// and it turns out to contain both of the failure modes a "no cast line behind it" inference
// can have. Full-log sweep, 2026-08-04, over every cast-less heal of the player's:
//
//   spell                castless  overTime  ≤5s after `You activate Quick Buff.`
//   Lifetap Strike           1964         0     0      ← true proc, untouched by both gates
//   Blood Siphon Strike      1160         0     0      ← true proc
//   Vampiric Embrace          562         0     0      ← true proc
//   Siphon Life               284         0     0      ← true proc (the spellblade lane)
//   Ethereal Cleansing         91        91     2      ← HoT TICKS
//   Valor                      57         0    57      ← QUICK BUFF BURST
//   Symbol of Pinzarn          55         0    55      ← QUICK BUFF BURST
//   Center                     54         0    54      ← QUICK BUFF BURST
//   Symbol of Ryltan           39         0    39      ← QUICK BUFF BURST
//   Daring                     28         0    28      ← QUICK BUFF BURST
//   Symbol of Transal          21         0    21      ← QUICK BUFF BURST
//
// The separation is total, which is why both gates are RULES and not thresholds:
//
//   1. THE HoT GATE, and it is the DoT gate again on the other side of the meter. Every one of
//      Ethereal Cleansing's 91 cast-less ticks is a `healed <target> over time for N` line, and
//      its ticks run 60+ seconds past a 3-second cast. `isCastlessHeal` refuses them outright.
//      (The owner saw `Ethereal Cleansing · proc` in the ledger; it is a hand-cast HoT.)
//   2. THE QUICK BUFF GATE. `You activate Quick Buff.` is an AA that re-applies the player's
//      memorized buffs and prints NO `You begin casting` line for any of them — only the
//      landings. Six buff spells account for 254 phantom "procs" that way, and every single one
//      of them lands within 5 seconds of that activation line. So the burst is CAST EVIDENCE of
//      a different shape, and it suppresses the heal inference for its duration.
//      It suppresses the HEAL side ONLY. A damage line inside the burst is still a weapon proc
//      — Smiting Strike alone has 9 of its 11,606 firings inside a burst window by coincidence,
//      and Quick Buff casts no nuke, so there is nothing for a damage-side gate to catch and a
//      real proc to lose by adding one.

// ── ONE CAST LINE EXPLAINS ONE FIRING (JOS-167, owner's discriminator made into a join) ──
//
// The wave-1 rule above was "is there a cast of this spell in the last 12 seconds", which is a
// MEMBERSHIP test, and a membership test cannot separate a spell you are SPAMMING from a proc
// that shares its name. A cleric casting `Banish Undead` on a 4-second cycle keeps the 12-second
// window permanently open, so every weapon proc of the same effect scores as a cast and the proc
// rate reads ZERO — the reported defect, and it is a defect of the JOIN, not of the window.
//
// So a cast record is CONSUMED. `You begin casting <Spell>.` explains exactly one FIRING, and a
// firing is identified by its INSTANT: every landing stamped at the same second belongs to it,
// and a landing at any later second needs a cast line of its own or it is a proc. The instant is
// the unit rather than the line because one firing legitimately prints several lines:
//   - an AoE nuke prints one damage line per target, all in one second (w43: four `Earthquake`
//     lines for 246 each inside one second) — one cast, four lines, all casts;
//   - a lifetap prints a damage line AND a heal line (the LaneSides rule below) — one firing,
//     two sides, and the second must not become a phantom proc.
//
// HONEST LIMIT, stated because the log's clock cannot do better: EQ stamps to the SECOND, so a
// proc that fires in the same second as its own spell's cast landing is absorbed into the cast
// and is invisible. Nothing in the line distinguishes them, and the alternative — refusing the
// second line — would fabricate procs out of every AoE.
//
// A CAST THAT NEVER RESOLVED EXPLAINS NOTHING (`forget`). A fizzle, an interrupt or a full
// resist means no effect landed, so the record must not stay behind to claim the next proc.
// MEASURED over the whole 1.4M-line log before writing this:
//   - FIZZLE, 478 lines: not ONE is followed within 12s by a landing of the same spell.
//     A fizzle is an unambiguous failure and dropping its record can cost nothing.
//   - INTERRUPT, 1,030 lines: 1,019 are followed by no landing at all; the 9 that ARE followed
//     by one are ALL preceded by `You regain your concentration and continue your casting.` —
//     EQ prints the interrupt, then the recovery, and the spell lands anyway. So the interrupt
//     alone is NOT evidence the cast failed, and dropping the record on it without handling the
//     recovery would have turned three real casts into procs (Lifedraw n2928, Siphon Life
//     n60339, Anarchy n361597 — each verified line by line). Hence `resume()`, wired to that
//     recovery line: forget on the interrupt, restore on the recovery.
//     (6 of those 9 have NO cast line at all — the SPELLBLADE proc itself gets interrupted and
//     recovers, printing `Your Discordant Mind spell is interrupted.` with nothing behind it.
//     That is the strongest available proof the interrupt line says nothing about ownership.)
// `forget` only drops an UNCLAIMED record: once a cast has explained a firing it can no longer
// claim a later instant anyway, and keeping it lets the REST of that instant's lines (an AoE's
// other targets, a tap's heal side) still join after a mid-burst resist line.

import { spellCanonKey } from '../log/parseCommon'
import type { DamageType } from '../../shared/combat'

/**
 * The cast-attribution window. See the file header for the measurement that fixes it at 12s;
 * do not change it without re-running that partition against the real log.
 */
export const PROC_CAST_WINDOW_MS = 12_000

/** Memory bound on the recent-cast map. Entries older than the window are pruned on write;
 *  this is the belt-and-braces cap for a pathological burst of distinct spell names. */
export const RECENT_CAST_CAP = 512

/** Where a landed spell effect of YOURS came from — the whole of this feature's judgement. */
export type SpellOrigin = 'cast' | 'proc'

/** One `You begin casting <Spell>.`, and the firing it has already explained (if any). */
interface CastRecord {
  /** ts of the cast line. */
  ts: number
  /** ts of the firing this cast explained; `undefined` until it explains one. */
  claimTs?: number
}

/**
 * THE OWN-CAST LEDGER. Rank-normalized (`spellCanonKey`) because casts print
 * `Swift Like the Wind I` while effect lines are rank-less — law 2, at the COUNTING boundary.
 *
 * Only the PLAYER prints `You begin casting`, which is exactly the gate this detector needs: a
 * mob's or another player's cast of the same spell never enters here and so can never explain
 * away one of our procs.
 */
export class RecentCasts {
  private readonly casts = new Map<string, CastRecord>()
  /** The record `forget()` most recently dropped, held for a `resume()`. */
  private suspended?: { key: string; rec: CastRecord }

  /** Record an own-cast (`You begin casting <Spell>.` / `You begin singing <Song>.`). */
  note(spell: string, ts: number): void {
    // Casting is SERIAL — a new cast line means whatever was interrupted is over, so a pending
    // suspension can never belong to the recovery that follows this one.
    this.suspended = undefined
    this.casts.set(spellCanonKey(spell), { ts })
    if (this.casts.size > RECENT_CAST_CAP) this.prune(ts)
  }

  /**
   * A cast line that resolved to NOTHING (fizzle / interrupt / full resist). See the file
   * header: dropped only while UNCLAIMED, and remembered so `resume()` can put it back.
   */
  forget(spell: string): void {
    const key = spellCanonKey(spell)
    const rec = this.casts.get(key)
    if (!rec || rec.claimTs !== undefined) return
    this.casts.delete(key)
    this.suspended = { key, rec }
  }

  /** `You regain your concentration and continue your casting.` — the interrupted cast is back
   *  on, so the record it lost comes back with its ORIGINAL cast ts (the window is measured from
   *  when the cast began, and the recovery does not restart it). The line names no spell; it does
   *  not have to, because only one cast can be in flight. */
  resume(): void {
    const s = this.suspended
    if (!s) return
    this.suspended = undefined
    if (!this.casts.has(s.key)) this.casts.set(s.key, s.rec)
  }

  /**
   * THE JOIN, and it CONSUMES: ask this once per landed effect line, in log order. Returns
   * `'cast'` when an in-window cast line explains this firing (claiming it if it had not claimed
   * one yet, or matching the instant it already claimed), `'proc'` otherwise.
   *
   * A cast in the FUTURE relative to this line (possible only on an out-of-order replay) is
   * treated as no cast at all: the window is `0 <= ts - castTs <= PROC_CAST_WINDOW_MS`.
   */
  origin(spell: string, ts: number): SpellOrigin {
    const rec = this.inWindow(spell, ts)
    if (!rec) return 'proc'
    if (rec.claimTs === undefined) {
      rec.claimTs = ts
      return 'cast'
    }
    return rec.claimTs === ts ? 'cast' : 'proc'
  }

  /** The same verdict WITHOUT consuming — diagnostics and tests only. Nothing on the ingest
   *  path may use it: two readers of one claim is how the join starts double-counting. */
  peek(spell: string, ts: number): SpellOrigin {
    const rec = this.inWindow(spell, ts)
    if (!rec) return 'proc'
    return rec.claimTs === undefined || rec.claimTs === ts ? 'cast' : 'proc'
  }

  /** Cast keys still held — memory-bound assertions and tests. */
  keys(): string[] {
    return [...this.casts.keys()]
  }

  clear(): void {
    this.casts.clear()
    this.suspended = undefined
  }

  private inWindow(spell: string, ts: number): CastRecord | undefined {
    const rec = this.casts.get(spellCanonKey(spell))
    if (!rec) return undefined
    const age = ts - rec.ts
    return age < 0 || age > PROC_CAST_WINDOW_MS ? undefined : rec
  }

  /** Drop cast records that can no longer explain anything. */
  private prune(now: number): void {
    for (const [key, rec] of this.casts) {
      if (now - rec.ts > PROC_CAST_WINDOW_MS) this.casts.delete(key)
    }
  }
}

// ── THE TWO LANES (JOS-167) ──────────────────────────────────────────────────────────────
//
// A spell that both CASTS and PROCS used to be one meter row, and the owner could not estimate
// the proc rate without deliberately not casting. The origin now decides the LANE NAME, so the
// two land in different rows of the same category and the split needs no new plumbing: the
// drill, the category rollup, the timeline lane, the copy-to-clipboard text and the overlay all
// read the same `skill` string the engine already files a hit under.
//
// The marker rides the NAME rather than a flag on the row for exactly that reason. The Combat
// drill's `proc · N ppm` tag (procViews.procSkillTags) reaches only YOUR rows on that one
// surface; the name reaches every surface there is. Two lanes therefore appear precisely when
// both origins occurred, which is the whole of the requirement.
//
// It is a DECORATION, not an identity: `laneCanonKey` strips it, so every join that matches a
// meter row to a spell (the is-a-proc tag, the effect-landing graft, the lane's own damage
// read-back) still sees one spell. Law 2 — canonicalize at the boundary, display raw.

/** What a cast-less lane's display name ends with. Never present in an EQ spell name. */
export const PROC_LANE_SUFFIX = ' · proc'

/** The meter lane a landing of `spell` belongs to, given where it came from. */
export function laneNameFor(spell: string, origin: SpellOrigin): string {
  return origin === 'proc' ? spell + PROC_LANE_SUFFIX : spell
}

/** True when a lane name is the cast-less half of a split. */
export function isProcLaneName(lane: string): boolean {
  return lane.endsWith(PROC_LANE_SUFFIX)
}

/** A lane name with the proc marker removed — the SPELL the row is about. */
export function baseLaneName(lane: string): string {
  return isProcLaneName(lane) ? lane.slice(0, -PROC_LANE_SUFFIX.length) : lane
}

/** `spellCanonKey` for a METER LANE: the marker is display, so both halves of a split key
 *  to the one spell they are both firings of. */
export function laneCanonKey(lane: string): string {
  return spellCanonKey(baseLaneName(lane))
}

/**
 * Damage types eligible for cast-less detection. `spell` ONLY — see the DoT gate in the file
 * header. Expressed as a function rather than a Set so the exclusion reads as a rule with a
 * reason attached, not as a list somebody can extend without noticing what it costs.
 */
export function procEligibleDamage(dtype: DamageType): boolean {
  return dtype === 'spell'
}

/**
 * How long after `You activate Quick Buff.` a landing still belongs to that burst.
 *
 * FIVE SECONDS, and the number is not this file's invention: it is the SAME window the buffs
 * module already uses to mark a burst's message-driven applies confident
 * (`buffsShapes.QUICK_BUFF_WINDOW_MS`). Spelled again here rather than imported because
 * src/main/combat may not depend on src/main/modules, and re-exporting a module constant
 * through shared/ to satisfy one comparison would be more coupling than the number is worth.
 * The two are pinned equal by a test.
 *
 * MEASURED, like the cast window: all 254 of the log's burst-delivered buff landings sit inside
 * it, and the nearest true proc (one Blood Siphon Strike tap) sits at 5–10s, outside.
 */
export const QUICK_BUFF_BURST_MS = 5_000

/** `idKey` of the AA whose activation opens that burst. Same reason as the window above:
 *  spelled here rather than imported from src/main/modules (buffsShapes imports back OUT of
 *  src/main/combat, so the import would close a cycle), and pinned equal by a test. */
export const QUICK_BUFF_AA = 'quick buff'

/** Everything the heal side of the inference needs to judge one line. */
export interface HealProcInput {
  spell: string
  ts: number
  /** The line said `over time` — a HoT tick. */
  overTime: boolean
  /** ts of the last `You activate Quick Buff.`, or 0 when none has been seen. */
  quickBuffTs: number
}

/**
 * True when a heal line of YOURS is a cast-less proc — the heal half of the inference, with
 * both of its exclusions in one place so neither can be applied at one call site and forgotten
 * at another. See the file header for the sweep that fixes each rule.
 */
export function isCastlessHeal(recent: RecentCasts, h: HealProcInput): boolean {
  if (h.overTime) return false
  const burst = h.ts - h.quickBuffTs
  if (h.quickBuffTs > 0 && burst >= 0 && burst <= QUICK_BUFF_BURST_MS) return false
  // CONSUMING, like the damage side, and deliberately sharing one claim with it: a lifetap's
  // damage line and heal line are one firing at one instant, so whichever arrives first claims
  // the cast and the other matches the instant it claimed (see the header's firing rule).
  return recent.origin(h.spell, h.ts) === 'proc'
}

/**
 * ONE FIRING CAN PRINT TWO LINES, and counting both is how a tap lane starts reporting double.
 *
 * `Lifetap Strike` fires once and the game prints `You hit <mob> … by Lifetap Strike.` AND
 * `You healed Primitive for N hit points by Lifetap Strike.` — two events, one proc. A single
 * `count` bumped from both ingest paths read 24 for w39's twelve firings (the defect wave 2
 * pinned with a deliberate warning assertion).
 *
 * So the two sides are counted SEPARATELY and the lane's count is `max` of them, never the sum:
 *   - a damage-only proc (Smiting Strike) counts its damage lines,
 *   - a heal-only proc (Center, delivered inside a Quick Buff burst) still counts once,
 *   - a tap that prints both counts each firing exactly once.
 * `max` and not `damageHits` alone precisely because of the third case above and because a tick
 * can print no heal line at all (w41's Blood Siphon: 14 ticks, 13 heals) — the larger side is
 * the number of firings we actually observed.
 */
export interface LaneSides {
  /** Firings that printed a DAMAGE line. */
  damage: number
  /** Firings that printed a HEAL line. */
  heal: number
}

/** One accumulated proc lane of `origin: 'spell'`: exact counts and the damage/healing those
 *  lines carried. Keyed by `spellCanonKey`, displayed by the raw name we first saw. */
export interface SpellProcLane {
  name: string
  /** Firings, split by which line carried them — see LaneSides. */
  hits: LaneSides
  damage: number
  heal: number
  /**
   * THE PER-STATE FIRING SPLIT (proc-analytics §2.1 `ProcLink`), folded on INGEST because it can never be
   * folded later: the encounter event ring is capped, truncated on finalize, and absent
   * ENTIRELY for zone sessions, so a link derived from it would be silently wrong exactly where
   * the sample is biggest.
   *
   * `<kind>:<key>` (stateKeyOf) → the firings observed while that state was open, split by side
   * under the same rule the lane's own count uses. States OVERLAP, so these never sum to the
   * lane count and are not meant to: each entry answers one question, "how many of this lane's
   * firings happened with X on".
   */
  byState: Map<string, LaneSides>
}

/** Firings on a side pair: `max`, never the sum — see LaneSides. */
export function sidesCount(s: LaneSides | undefined): number {
  return s ? Math.max(s.damage, s.heal) : 0
}

/** One lane's firings, the number every rate and every link is built from. */
export function laneCount(l: SpellProcLane): number {
  return sidesCount(l.hits)
}

/** Everything one detected proc contributes. An args object: five positional parameters would
 *  blow `max-params`, and the active set is not optional — a firing with no state open folds an
 *  EMPTY set, which is a real observation ("nothing was on"), not a missing argument. */
export interface SpellProcFold {
  spell: string
  amount: number
  isHeal: boolean
  /** `<kind>:<key>` of every state open at the firing instant (StateTimeline.active). */
  active: ReadonlySet<string>
}

/** Fold one detected proc into a lane map. `amount` lands in `damage` or `heal` per `isHeal`;
 *  a proc that carries neither (none exist today) still counts, because the COUNT is the
 *  measurement and the amount is the annotation. */
export function addSpellProc(lanes: Map<string, SpellProcLane>, f: SpellProcFold): void {
  const key = spellCanonKey(f.spell)
  const lane = lanes.get(key) ?? {
    name: f.spell,
    hits: { damage: 0, heal: 0 },
    damage: 0,
    heal: 0,
    byState: new Map<string, LaneSides>()
  }
  bumpSide(lane.hits, f.isHeal)
  if (f.isHeal) lane.heal += f.amount
  else lane.damage += f.amount
  for (const stateKey of f.active) {
    const sides = lane.byState.get(stateKey) ?? { damage: 0, heal: 0 }
    bumpSide(sides, f.isHeal)
    lane.byState.set(stateKey, sides)
  }
  lanes.set(key, lane)
}

function bumpSide(s: LaneSides, isHeal: boolean): void {
  if (isHeal) s.heal++
  else s.damage++
}
