// THE CHARM / CROWD-CONTROL OWNERSHIP MODEL (Task #65) — and, since JOS-188, the one place
// that answers "did this caster-less line resolve one of MY casts?" for a third family too.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS: the two lines that bound a pet name a caster to nobody.
//
//   `<mob> has been charmed.`      `<mob> has been mesmerized.`
//
// Both are BROADCASTS. They are the wiki's `msg_cast_on_other` for the charm and mez
// families — the DB literally records them as `Someone has been charmed.` /
// `Someone has been mesmerized.` — so every player in the zone sees them and NONE of them
// names the caster. The engine used to bind every charm broadcast into `petNames`
// unconditionally and to open a 120s CC hold on every mez broadcast, which meant another
// enchanter's pet became YOUR pet and another enchanter's mez pinned YOUR fight open.
//
// Measured on the real log (eqlog_Primitive_freeport.txt, 2026-08-04):
//   381 charm broadcasts   — 366 the owner cast, 15 cast by ten OTHER players.
//   2,899 CC broadcasts    — 2,797 correlate with an own cast, 102 do not.
// One foreign block (Tue Aug 04 16:59, the player Scooba's Allure VII pets) put 91 hits /
// 10,016 points of a stranger's pet damage on the owner's meter inside a single seven-minute
// window, entered the PLAYER Scooba into the owner's `engaged` set as a hostile, booked his
// self-heals as enemy healing, and — because his presence kept refreshing — merged three
// separate pulls into one 214-second "a Champion of Innoruuk +3" segment.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE: a broadcast binds only when it RESOLVES ONE OF THE OWNER'S OWN CASTS.
//
// `You begin casting <Spell>.` is printed for the player and NOBODY else (a stranger's cast
// prints `<Name> begins casting <Spell>.`, which this parser does not emit at all). So an own
// cast of a charm/CC spell ARMS the model for that spell's own cast time plus a slack, and a
// broadcast inside the arm is ours. Everything else is somebody else's business.
//
// THE ARM WINDOW IS PER-SPELL, NOT A FLAT CONSTANT — measured, and it overturned the
// briefed "<= 2s". Delta from `You begin casting X.` to the broadcast, whole log:
//
//   spell               DB cast time   n     min   p50   max
//   Charm                     2400ms   95      0     2     3
//   Beguile                   3500ms   53      1     3     4
//   Cajoling Whispers         5500ms   59      1     5     6
//   Allure                    6000ms  159      2     4     5
//   Dazzle / Mesmerization  2500-3000ms       0     1     4
//
// The delta tracks the SPELL'S CAST TIME (log timestamps are second-granular, so it lands
// within ±1s of it). A flat 2s window would have bound Charm and missed 271 of the 366 real
// owner charms. `castTimeMs + CAST_SLACK_MS` binds 366/366 and 0/15 foreign — a perfect split
// on this log, with no other evidence needed.
//
// ─────────────────────────────────────────────────────────────────────────────
// STATE TABLE (one entry per mob name key; the arm is global — you cast one spell at a time)
//
//  FROM         EVENT                                              TO            NOTE
//  ──────────   ────────────────────────────────────────────────   ───────────   ─────────
//  —            own castBegin of a charm spell                     armed:charm   window =
//                                                                                castTime+slack
//  —            own castBegin of a CC spell                        armed:cc      same
//  —            own castBegin of a PET-ONLY spell (JOS-188)        armed:petBuff same
//  armed:petBuff a named landing of THAT spell inside the window   (bind)        CONSUMES the arm;
//                                                                                the caller binds
//                                                                                the target as a pet
//  armed        own castBegin of ANY other spell                   —             one cast at a time
//  armed        own fizzle / interrupt / resist OF THE SAME spell  —             the cast failed
//  armed:charm  `<mob> has been charmed.` inside the window        provisional   CONSUMES the arm
//                                                                                (charm is single-
//                                                                                target)
//  armed:cc     `<mob> has been mesmerized.` inside the window     (cc allowed)  does NOT consume:
//                                                                                one AE mez prints
//                                                                                one line per mob
//  —            `<mob> has been charmed.` with no arm              observed      inert; remembered
//                                                                                for PROMOTE_MS
//  provisional  pet-shaped evidence: a `… Master.' tell, the       confirmed     ownership proven
//               pet's own damage / miss / resisted cast, the
//               owner healing it, your charm wearing off it
//  provisional  the charm's OWN DURATION elapses with none         —             DEMOTED (unbound)
//               of the above (provisionalWindowMs)
//  observed     `<mob> told you, '… Master.'` within PROMOTE_MS    confirmed     PROMOTED as a
//                                                                                CHARMED pet
//  any          death / zone / uncharm                             —             released
//
// THE DEMOTION HORIZON IS THE SPELL'S DURATION, NOT A TUNED TIMEOUT — see
// provisionalWindowMs, which records what a 60-second version cost when it was measured.
// The briefed "uncorroborated binds demote" was overturned twice over: requiring the Master
// TELL alone would have demoted 162 genuine pets (44%), because the tell only fires when the
// pet is ordered onto a target; and any horizon shorter than the charm itself deletes the
// damage of a pet that simply stood still for a while.
//
// The briefed "never bind a name the owner damaged within the window" was overturned outright:
// 15 of the 366 real owner charms (4%) charm a mob the owner was mid-melee with — you charm
// what you are fighting all the time — and the veto addresses no failure mode the arm gate
// does not already close (a foreign charm lands on a mob we are NOT hitting).
//
// PURE + CLOCK-INJECTED: no Date.now(), no engine state, no I/O. Every method takes the log
// timestamp it is reasoning at, so a replay and a live tail behave identically.

import spellsJson from '../data/spells.json'
import { getParserConfig } from '../log/rulesets'
import { spellCanonKey } from '../log/parseCommon'
import type { SpellDbFile } from '../../shared/types'

/** How long after a cast's nominal completion a broadcast may still be that cast's. EQ log
 *  timestamps are truncated to whole seconds, so a cast begun at x.9s and resolving at
 *  x.9+castTime prints up to a second late; 1500ms covers that plus server resolution.
 *  Measured max overrun on the real log: +600ms (Charm, 2400ms cast, 3s observed). */
export const CAST_SLACK_MS = 1_500

/** Arm window for a charm/CC spell the spell DB has no cast time for (the DB is scraped and
 *  a few ranked lines — `Allure` among them — carry the time but not the message). 6000ms is
 *  the longest charm cast the DB knows (Allure), so an unknown spell gets the most generous
 *  honest window rather than a guess that silently drops real binds. */
export const DEFAULT_CAST_MS = 6_000

/**
 * How long a charm's OWN duration may overrun the DB's nominal figure before an
 * uncorroborated bind is dropped. The wiki's durations are level-scaled headline numbers
 * ("16 Min", "6.3 minutes @L53 to 7.0 minutes @L60"), so the slack absorbs the scaling rather
 * than the timing.
 */
export const DURATION_SLACK_MS = 60_000

/** Duration for a charm spell the DB has no figure for. 16 minutes is what every charm in the
 *  family except Dictate (48s) and Boltran's Agacerie (7m) is listed at. */
export const DEFAULT_CHARM_DURATION_MS = 960_000

/** How long an unbound charm sighting is remembered so a later `… Master.' tell can PROMOTE
 *  that name as a CHARMED (not summoned) pet. Generous on purpose: the tell is
 *  ownership-DEFINITIVE (0 of the 15 foreign charms in the log ever produced one), so the
 *  only cost of a long memory is remembering a handful of names. */
export const PROMOTE_MS = 600_000

/** The wiki/DB `msg_cast_on_other` that IS the charm broadcast. */
const CHARM_MSG = 'Someone has been charmed.'

/**
 * Rank-folded spell key → the longest cast time any rank of that line has, from the committed
 * spell DB. Built over EVERY spell rather than only the charm/CC families: the arm window is
 * "this spell's own cast time", and the table costs one pass over 1.9k rows at module load.
 * The JSON is ES-imported so electron-vite inlines it (AGENTS.md toolchain note) — a
 * path-relative read would miss in `out/main/`.
 */
function longestByKey(pick: (s: SpellDbFile['spells'][number]) => number | null | undefined): Map<string, number> {
  const m = new Map<string, number>()
  for (const s of (spellsJson as SpellDbFile).spells) {
    const ms = pick(s)
    if (typeof ms !== 'number' || ms <= 0) continue
    const key = spellCanonKey(s.name)
    const prev = m.get(key)
    if (prev === undefined || ms > prev) m.set(key, ms)
  }
  return m
}

const CAST_MS_BY_SPELL: ReadonlyMap<string, number> = longestByKey((s) => s.castTimeMs)

/** Rank-folded spell key → the longest DURATION any rank of that line is listed at. */
const DURATION_MS_BY_SPELL: ReadonlyMap<string, number> = longestByKey((s) => s.durationMs)

/**
 * The charm spells whose cast-on-other message IS the charm broadcast, as the DB states it.
 * NOT the membership test (see `isCharmSpell`) — the DB omits the message for a couple of
 * ranked lines the log proves are charms (`Allure`, which the owner cast 159 times and whose
 * `Your Allure VII spell has worn off of …` lines the un-charm path already honors). Kept
 * because it is the honest, message-derived core of the family and a useful assertion target.
 */
export const CHARM_SPELLS_BY_MESSAGE: ReadonlySet<string> = new Set(
  (spellsJson as SpellDbFile).spells
    .filter((s) => s.msgCastOnOther === CHARM_MSG)
    .map((s) => spellCanonKey(s.name))
)

/** Membership tests. The audited stem regexes live in the parser ruleset (they are what the
 *  `Your <spell> spell has worn off of <mob>` path already uses to tell charm from mez), so
 *  they are read from there rather than re-implemented — one source of truth per question. */
function stems(): { charmSpell: RegExp; ccSpell: RegExp } {
  const cfg = getParserConfig()
  return { charmSpell: cfg.charmSpell, ccSpell: cfg.ccSpell }
}

export function isCharmSpell(spell: string): boolean {
  return stems().charmSpell.test(spellCanonKey(spell))
}

export function isCcSpell(spell: string): boolean {
  const { charmSpell, ccSpell } = stems()
  const key = spellCanonKey(spell)
  // Charm wins the overlap: `Boltran's Agacerie` must never be read as a mez.
  return !charmSpell.test(key) && ccSpell.test(key)
}

/**
 * THE PET-ONLY SPELLS (JOS-188), read straight off the DB's `targetType` rather than a name
 * list: the game refuses one of these on anything but YOUR OWN pet, which is the whole content
 * of the inference below. 40 spells across seven classes — Burnout, the necromancer's
 * Focus/Intensify/Augment Death line, Renew Elements, Sight/Voice Graft, the beastlord spirits,
 * Tiny Companion, Ward of Calliav, Reclaim Energy.
 *
 * `targetType` is the WIKI's word for a different server and AGENTS.md already records one case
 * where it disagrees with this log (`Skin Like Nature` is listed Single and lands on three
 * entities at once). That is a reason to measure rather than to trust, and this rule was:
 * whole-log, 19 binds / 14 names, every one of the 14 also bound by a `… Master.'` tell, none
 * bound by this rule alone. The table is not the gate anyway — the OWN CAST is.
 */
export const PET_TARGET_SPELLS: ReadonlySet<string> = new Set(
  (spellsJson as SpellDbFile).spells.filter((s) => s.targetType === 'Pet').map((s) => spellCanonKey(s.name))
)

export function isPetOnlySpell(spell: string): boolean {
  return PET_TARGET_SPELLS.has(spellCanonKey(spell))
}

/** The arm window for one own cast of `spell`, in ms after the `You begin casting` line. */
export function armWindowMs(spell: string): number {
  return (CAST_MS_BY_SPELL.get(spellCanonKey(spell)) ?? DEFAULT_CAST_MS) + CAST_SLACK_MS
}

/**
 * How long an UNCORROBORATED bind by `spell` may stand — the spell's own listed duration plus
 * a slack. This is the number the demotion runs on, and it is DERIVED rather than tuned: a
 * charm cannot outlive its own spell, so a bind that has produced no evidence for longer than
 * the game could possibly have held it is over whatever else is true.
 *
 * IT MUST NOT BE SHORTER, and that was measured the hard way. A flat 60s demotion — which is
 * how long 336 of the owner's 366 real binds take to produce SOME corroboration — silently
 * deleted 35,956 points of the Plane of Sky pet Bzzazzt's damage and 1,326 of a sprited
 * harpie's, because a charmed pet routinely stands idle for minutes between orders (bound
 * 01:02:56, first swing 01:05:01). The 60s figure measured "how fast does corroboration
 * USUALLY arrive", which is a different question from "when can this bind no longer be real".
 */
export function provisionalWindowMs(spell: string): number {
  return (DURATION_MS_BY_SPELL.get(spellCanonKey(spell)) ?? DEFAULT_CHARM_DURATION_MS) + DURATION_SLACK_MS
}

/** What a `<mob> has been charmed.` broadcast means for US. */
export type CharmVerdict = 'own' | 'foreign'

/** A provisional bind that has aged out and must be unbound. */
export interface CharmDemotion {
  nameKey: string
  display: string
}

interface Arm {
  kind: 'charm' | 'cc' | 'petBuff'
  spellKey: string
  ts: number
  until: number
}

export class CharmModel {
  /** The single pending own cast. You cast one spell at a time, so this is not a map. */
  private arm: Arm | null = null
  /** nameKey → { until, display } for binds awaiting corroboration. */
  private provisional = new Map<string, { until: number; display: string }>()
  /** nameKey of binds proven ours. Never auto-expires. */
  private confirmed = new Set<string>()
  /** nameKey → ts of a charm broadcast we did NOT bind, for the PROMOTE path. */
  private observed = new Map<string, number>()
  /** Every nameKey a charm broadcast has EVER named, ours or not. Session-scoped and never
   *  pruned (it is a handful of names). This is AGENTS.md's `everCharmed` idea: a name the
   *  zone has seen charmed is a MOB, whatever else it looks like — which is what stops the
   *  owner healing his own charmed pet from filing that pet as a player. */
  private seenCharmed = new Set<string>()

  reset(): void {
    this.arm = null
    this.provisional.clear()
    this.confirmed.clear()
    this.observed.clear()
    this.seenCharmed.clear()
  }

  /** True if a charm broadcast has ever named this entity (ours or a stranger's). */
  everCharmed(nameKey: string): boolean {
    return this.seenCharmed.has(nameKey)
  }

  /** `You begin casting <Spell>.` — arms the model, or clears a stale arm when the player
   *  moves on to an unrelated spell. */
  noteCastBegin(spell: string, ts: number): void {
    const kind = isCharmSpell(spell)
      ? 'charm'
      : isCcSpell(spell)
        ? 'cc'
        : isPetOnlySpell(spell)
          ? 'petBuff'
          : null
    if (!kind) {
      this.arm = null
      return
    }
    this.arm = { kind, spellKey: spellCanonKey(spell), ts, until: ts + armWindowMs(spell) }
  }

  /** `Your <Spell> spell fizzles!` / `is interrupted.` / `<mob> resisted your <Spell>!` — the
   *  armed cast did not land, so nothing it might have "resolved" is ours. Only the ARMED
   *  spell disarms: an unrelated fizzle mid-window is somebody else's problem. */
  noteCastFailed(spell: string, ts: number): void {
    if (this.arm?.spellKey === spellCanonKey(spell) && ts >= this.arm.ts) this.arm = null
  }

  /**
   * `<mob> has been charmed.` — is it ours? Consumes the arm on a hit, because every charm
   * spell in the DB is `targetType: Single`: one cast produces exactly one charmed mob, so a
   * SECOND broadcast in the same window is somebody else's and must not ride our cast in.
   */
  charmBroadcast(nameKey: string, display: string, ts: number): CharmVerdict {
    this.seenCharmed.add(nameKey)
    if (this.confirmed.has(nameKey) || this.provisional.has(nameKey)) return 'own'
    const a = this.arm
    if (a?.kind === 'charm' && ts >= a.ts && ts <= a.until) {
      this.arm = null
      this.provisional.set(nameKey, { until: ts + provisionalWindowMs(a.spellKey), display })
      return 'own'
    }
    this.observed.set(nameKey, ts)
    return 'foreign'
  }

  /**
   * `<mob> has been mesmerized./enthralled./entranced./ensnared.` — is it ours? Does NOT
   * consume the arm: one `Mesmerization VI` prints one broadcast PER MOB it lands on (the
   * real log has two in the same second from a single cast), so an AE mez must gate them all.
   */
  ccBroadcast(ts: number): boolean {
    const a = this.arm
    return a?.kind === 'cc' && ts >= a.ts && ts <= a.until
  }

  /**
   * A NAMED buff landing (`<Name> goes berserk.`) — was it YOUR pet-only spell resolving?
   * (JOS-188.) The third thing in the log that can bind a summoned pet, and the first one that
   * does not require the player to have ORDERED it.
   *
   * `spellKeys` are the landing message's candidates. The message alone proves nothing —
   * `goes berserk.` resolves to Burnout / Fury / Rage / Voice of the Berserker and three of
   * those four are ordinary buffs — so the armed cast must be AMONG them, which is the same
   * "did this line resolve MY cast" test `charmBroadcast` runs, one field stricter.
   *
   * CONSUMES the arm on a hit, for charm's reason: a pet spell is single-target, so a second
   * landing inside the same window is a different spell's business (a Quick Buff burst prints
   * eleven landings in one second — one cast, one bind).
   */
  petBuffLanding(spellKeys: readonly string[], ts: number): boolean {
    const a = this.arm
    if (a?.kind !== 'petBuff' || ts < a.ts || ts > a.until) return false
    if (!spellKeys.some((k) => spellCanonKey(k) === a.spellKey)) return false
    this.arm = null
    return true
  }

  /** Pet-shaped evidence for `nameKey`: its own outgoing damage, its `… Master.` tell, or
   *  YOUR charm spell wearing off it. Promotes a provisional bind to confirmed. */
  notePetEvidence(nameKey: string): void {
    if (this.provisional.delete(nameKey)) this.confirmed.add(nameKey)
    else if (!this.confirmed.has(nameKey)) this.confirmed.add(nameKey)
    this.observed.delete(nameKey)
  }

  /**
   * A `<Name> told you, '… Master.'` tell arrived for a name we saw charmed but declined to
   * bind. The tell is ownership-definitive and pet-only, so this PROMOTES — and it promotes
   * the name as a CHARMED pet, not a summoned one (AGENTS.md: "a pet-claim tell from a name
   * EVER seen charmed re-arms the charmed set, never the permanent one"). Returns true when
   * the caller should bind it as a charm.
   */
  claimIsCharmed(nameKey: string, ts: number): boolean {
    const seen = this.observed.get(nameKey)
    if (seen === undefined || ts - seen > PROMOTE_MS) return false
    this.observed.delete(nameKey)
    this.confirmed.add(nameKey)
    return true
  }

  /** Forget a name entirely (death, un-charm, left behind on a zone). */
  release(nameKey: string): void {
    this.provisional.delete(nameKey)
    this.confirmed.delete(nameKey)
    this.observed.delete(nameKey)
  }

  /** Charm cannot survive a zone. Keep only the pets that actually walked through with you
   *  (the summoned survivors the world model hands back) and drop every pending arm/sighting. */
  zone(survivorKeys: readonly string[]): void {
    this.arm = null
    this.provisional.clear()
    this.observed.clear()
    const keep = new Set(survivorKeys)
    for (const k of [...this.confirmed]) if (!keep.has(k)) this.confirmed.delete(k)
  }

  /** True when the model has nothing that could expire — lets the caller skip the sweep. */
  get idle(): boolean {
    return this.provisional.size === 0
  }

  /** Provisional binds whose corroboration window has closed as of `now`. Removing them from
   *  the model is this call's side effect; unbinding them in the world is the caller's. */
  sweep(now: number): CharmDemotion[] {
    const out: CharmDemotion[] = []
    for (const [nameKey, v] of this.provisional) {
      if (v.until > now) continue
      out.push({ nameKey, display: v.display })
    }
    for (const d of out) this.provisional.delete(d.nameKey)
    return out
  }
}
