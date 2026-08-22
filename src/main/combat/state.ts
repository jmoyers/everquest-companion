// The combat engine's MUTABLE STATE — every field the old monolithic CombatEngine class
// carried, plus the small helpers that only read/refresh it (the classification ring, the
// presence axis, the two ring appenders, the defender-label resolution).
//
// Extracted so the routing / lifecycle / view modules can be plain functions over one
// explicit state object instead of methods on a 1,400-line class. `CombatEngine` (engine.ts)
// owns exactly one of these and is a thin facade over it — nothing outside this directory
// ever sees it.

import { WorldModel } from './world'
import { Agg } from './aggregate'
import {
  FALLBACK_IDLE_MS,
  MARKER_CAP,
  RECENT_CAP,
  TIMELINE_CAP,
  type Encounter,
  type MarkerRaw,
  type TimelineRaw,
  type ZoneSession
} from './encounter'
import { idKey } from '../log/parser'
import { SEC_RINGS, type EngineFoldProbe } from './foldProbe'
import { StateTimeline } from './stateTimeline'
import { CharmModel } from './charmModel'
import { AllyCharms } from './allyCharms'
import { SpecialAttacks } from './specialAttacks'
import { RecentCasts } from './procDetect'
import { PetNudgeState } from './petNudge'
import { OtherCombatants } from './otherCombatants'
import { EMPTY_ROSTER, EMPTY_ROSTER_VIEW, type RosterSnap, type RosterView } from '../../shared/roster'
import type { ClassifiedLine, CoatSlot } from '../../shared/combat'
import type { ComboInterval } from '../../shared/classCombo'

/** The held-clicky default: no dump loaded, so no ownership evidence and no reclassification.
 *  Shared rather than re-allocated, because `reset()` runs on every character switch. */
const NO_CLICKIES: ReadonlySet<string> = new Set<string>()

export class EngineState {
  /** Canonical name keys of your LIVE PETS — charmed AND summoned alike. Kept in
   *  lockstep with the WorldModel's pet instances so the pure classify() (which only
   *  needs name membership) stays cheap. This is an ATTRIBUTION set, NOT a charm
   *  roster: a summoned class pet (Vebarn, Garer…) belongs here exactly as much as a
   *  charmed mob does, because both attribute as "your pet". The charmed/summoned
   *  distinction lives on WorldModel Instance.petKind — see world.charmedInstances(). */
  petNames = new Set<string>()
  world = new WorldModel()

  constructor() {
    // A RETIRED INSTANCE CANNOT REDEEM ITS CC HOLD (JOS-176). The hold in
    // `Encounter.ccActiveUntil` is a claim that a mez'd mob is still alive and still in this
    // fight; the moment the world model retires that instance the claim is false forever,
    // because a later sighting of the name spawns a fresh `nameKey#gen` (world.ts spawn). Wired
    // here rather than at each call site so DEATH, STALENESS, zone, pet succession and the
    // foreign-killer ghost all agree — before this only ingestDeath cleaned up, and a mez'd mob
    // aged out by staleness went on vetoing the death-close for the rest of its 120 seconds.
    this.world.onRetire = (inst): void => {
      this.current?.ccActiveUntil.delete(inst.instanceId)
    }
  }
  /**
   * OWNERSHIP for the two caster-less broadcasts (`<mob> has been charmed.` /
   * `<mob> has been mesmerized.`) — see charmModel.ts for the state table and the
   * measurements. Nothing enters `petNames` from a charm line, and no CC hold opens, unless
   * this model says the broadcast resolved one of the OWNER's own casts.
   */
  charm = new CharmModel()
  /**
   * OWNERSHIP FOR SOMEBODY ELSE'S CHARM PET (JOS-250, allyCharms.ts). The other half of the same
   * caster-less broadcast: when `charm` above says "not yours", this model asks whether a NAMED
   * third party's cast explains it, and — if so — books that pet's mob-vs-mob damage to that
   * person under its own source kind.
   *
   * IT IS STRICTLY DISJOINT FROM YOUR ROWS. Nothing here ever enters `petNames`, `everPet`,
   * `knownPlayers` or the world model's pet set; an ally pet opens no encounter, engages no
   * hostile and refreshes no presence. That disjointness is what makes the whole feature
   * law-8-safe: every damage total that existed before this model existed is byte-identical
   * after it (tests/combatCharmOwnership.test.mts W44/W45 pin both halves).
   */
  ally = new AllyCharms()
  /**
   * EVERY OTHER COMBATANT THE LOG NAMES (JOS-430, otherCombatants.ts) — the refusal ladder that
   * replaced the roster as the thing deciding whether a player-vs-mob line is recorded at all.
   *
   * It is the WEAKEST model in this file and it is asked LAST, on purpose: `petNames`, `everPet`,
   * `charm`, `ally`, `everStruck` and the roster all get to speak first, and any one of them
   * refusing is final. What it adds is the case none of them cover — a name that just fights mobs
   * beside you and never says anything about itself.
   */
  others = new OtherCombatants()
  /**
   * Canonical name keys of entities known to be PLAYERS — never hostiles, never a pet's
   * target, never enemy healers. TWO sources, both narrow on purpose:
   *   - the tailed character (injected by setPlayerName, or learned by learnPlayerKey);
   *   - anyone who HEALED the owner (`<H> healed Primitive for N`) — a mob cannot.
   *
   * HONEST LIMIT, stated rather than pretended away: a stranger who never heals you is NOT
   * identifiable as a player from this log's grammar. The lines that would say so —
   * `<Name> tells <chan>, '…'`, `/who` rows, group join/leave — are exactly the ones
   * tests/fixture-scrub.mjs drops, and mobs share every remaining shape: they melee, they
   * cast, and they self-heal with the same `healed itself/himself/herself` wording (211
   * distinct `itself` healers in the real log, players and `a shadowknight pet` alike). The
   * obvious extra inference — "`You healed <X>` ⇒ X is a player" — was tried and MEASURED
   * WRONG; see routeHeal for what it cost. So this set is the belt beside the braces: what
   * actually keeps a stranger out of your fight is the charm gate plus the engage/presence
   * discipline in routing.ts.
   */
  knownPlayers = new Set<string>()
  /**
   * THE GROUP ROSTER, pulled live (docs/plans/group-model.md §3.5). Installed by pipeline.ts as
   * `() => rosterModule.view()`; the default returns an empty view, so every test, every replay
   * without a group and every pre-existing caller behaves exactly as it did before.
   *
   * A pull rather than a stored copy for two reasons: the roster module has already folded the
   * same bus event by the time the engine sees it, and a user edit made between two log lines
   * must reach the very next one. Cheap by construction — the view is at most five names.
   */
  rosterProvider: () => RosterView = () => EMPTY_ROSTER_VIEW
  /** The SERIALIZABLE roster the snapshot carries to both renderer bundles — provenance, names
   *  and staleness, which the hot-path `RosterView` deliberately does not carry. Read once per
   *  UI tick, never per line, and from the same module as `rosterProvider`, so the rows the
   *  meter draws and the chip that filters them always describe one group. */
  rosterSnapProvider: () => RosterSnap = () => EMPTY_ROSTER
  // NOTE: there is deliberately NO `petClaimsProvider` here any more (JOS-49). The engine used to
  // pull the user's own "that one is mine" statements per line, as a top-of-the-ladder override
  // the log could not contradict. The owner cut the question that produced them — "if you just
  // have to pet attack once, this is a lot of work we can get wrong" — so the ONLY thing that
  // binds a summoned pet is its own private tell, through `notePet` below.
  /** Every name key that has EVER been one of your pets this session. Small, never pruned,
   *  and the reason `notePlayer` can never mistake a pet for a player (see notePet). */
  everPet = new Set<string>()
  /**
   * Every name key YOU have LANDED DAMAGE ON this session (JOS-48) — the third absolute refusal
   * `notePlayer` runs beside `everPet` and `everCharmed`, and the mob half of `everPet`.
   *
   * Small and never pruned, exactly like its two siblings: a name is a handful of bytes and
   * "have I been killing this?" must have ONE answer for the whole session, not a per-encounter
   * one. Name-keyed rather than instance-keyed on purpose — `a spite golem` respawns, and the
   * eleventh one is the same KIND of thing as the first.
   *
   * WRITTEN FROM YOUR OWN OUTGOING DAMAGE AND NOTHING ELSE, which is the whole measurement
   * (see notePlayer). Not "it hit me", not "my pet hit it", not "it was engaged": those are all
   * things a CHARMED ALLY does, and a raid boss that mind-controls your healer turns each of
   * them into a rule that unfiles a real player. Your own swing is the one signal with a person
   * behind it.
   */
  everStruck = new Set<string>()
  /** The player's own proper name key (e.g. "primitive"). Normally INJECTED by
   *  index.ts via setPlayerName() (it knows the character from the tail ref). As a
   *  cheap fallback (guards a mis-parsed injected name) it can also be LEARNED from
   *  heal lines: EQ writes self-heals as "You healed <PlayerName> for N", so a heal
   *  whose healer is You and whose target is neither one of your pets nor an engaged
   *  hostile reveals the player's name. An injected name always wins over a learned
   *  one. Once known, heals targeting that name count as incoming. */
  playerKey?: string
  /** True once setPlayerName() injected the name, so heal-based learning can't
   *  overwrite it. */
  playerKeyInjected = false
  zone?: string
  seq = 0
  current: Encounter | null = null
  history: Encounter[] = []
  zoneAgg = new Agg()
  zoneFinalizedMs = 0
  /** Sum of finalized encounters' activeMs this zone (for the zone active-DPS). */
  zoneActiveMs = 0
  /** First/last attributed-damage ts in the LIVE zone session (0 = none yet). Task #54: drives
   *  the zone-session disambiguation timing (start clock + relative age + span). */
  zoneStartTs = 0
  zoneLastTs = 0
  /** Capped finalized-zone-session history (Task #54). Each entry keeps its FROZEN Agg + timing +
   *  a memoized SegmentView-less summary; the live zoneAgg is NOT in here. Newest last. */
  zoneHistory: ZoneSession[] = []
  zoneSeq = 0
  recent: ClassifiedLine[] = []
  recording = false
  /**
   * HYDRATION (Task #56). True from construction/reset until the historical scan hands off
   * to the live Tailer (`setLive()`, or the first live event as a belt-and-braces fallback).
   * While true, `current` is a fight from the PAST being replayed, so a snapshot's "live"
   * fields are historical — the snapshot carries this flag so the UI renders a loading state
   * instead of a churning fake-live meter.
   */
  hydrating = true
  /** ts of the last encounter-relevant activity (attributed damage OR a CC event).
   *  Drives the FALLBACK_IDLE_MS closure independent of the damage timeline. */
  lastActivityTs = 0
  /** Current combat-modifier pair (Task #51): the last stance/invocation the player
   *  committed to, with the ts of that change. Session-scoped (survives zones/epoch —
   *  a stance is not tied to a zone); reset() clears it. Exposed in the snapshot and
   *  used to open/close timeline stance spans on the current encounter. */
  stance?: { name: string; ts: number }
  invocation?: { name: string; ts: number }
  /**
   * BLADE COATS (Task #64). FOUR concurrent coats, because that is what the game has:
   * `coatUtility` is the ONE active utility poison (a new utility coat replaces it) and
   * `coatCombat` holds up to `MAX_COMBAT_COATS` (3) combat venoms, one per mutually-exclusive
   * VENOM LINE — venoms on different lines stack, the two members of a line replace each other
   * (shared/poisons.ts carries the wiki wording). Session-scoped exactly like the stance pair:
   * a coat survives zoning, and is stripped only by `reset()` or by one of the three boundaries
   * `procRouting.clearCoats` owns — your own death, a character rebirth, and the loadout ceasing
   * to contain ROG (JOS-305, combat/coatClass.ts). Never assign these two fields anywhere but
   * `routeCoat` / `routeDry` / `clearCoats`: a clear that moved the slots without ending the
   * spans is the exact defect JOS-305 was filed for, one case at a time.
   */
  coatUtility?: CoatSlot
  coatCombat: CoatSlot[] = []
  /**
   * WHICH THREE CLASSES IS THIS CHARACTER RUNNING? — pulled live from the combo module
   * (JOS-305). Installed by pipeline.ts as `() => comboModule.currentInterval()`; the default
   * returns null, so every test and every replay without the module behaves exactly as it did
   * before this seam existed.
   *
   * A PULL, and the SAME pull the roster seam is, for the same two reasons: the combo module is
   * registered FIRST on the bus (pipeline.ts), so by the time the engine folds a line the combo
   * state has already advanced for that same line; and a `/who` row typed between two log lines
   * has to reach the very next one. Unlike the roster this is NOT free to call — a rebuild walks
   * every retained observation (~5 ms at 30k, measured) — so coatClass.ts owns the gate that
   * decides when it may be asked, and nothing else in the engine reads it.
   */
  comboProvider: () => ComboInterval | null = () => null
  /** Log-clock ts of the last combo consultation (0 = never). The THROTTLE half of the
   *  class-swap coat clear; see combat/coatClass.ts for the period and why it is what it is.
   *  Driven entirely by event timestamps, so a replay consults at identical instants. */
  coatClassCheckedTs = 0
  /**
   * ROLLING TIME-TO-SLOW samples (Task #64), newest last, capped at SLOW_SAMPLE_CAP. One
   * entry per FINALIZED pull that opened with a slow-capable coat on: the ms to the first
   * slow landing, or null when the pull ended without one. The null entries are the whole
   * reason this is a list of samples and not a running mean — they are COUNTED (`noLand`) and
   * never averaged in as zero (law 5).
   */
  slowSamples: (number | null)[] = []
  /**
   * THE ACTIVE-STATE TIMELINE (proc-analytics §3) — "what was on at time T" as an interval
   * model with evidence on both edges. SESSION-level and purely ADDITIVE: it is written
   * alongside the fields above by the same writers (applyStance / routeCoat / routeDry / the
   * proc-buff landing path), and `Encounter.stanceSpans` is deliberately left alone — that
   * list feeds the shipped TimelineView and sits inside the byte-identical regression surface.
   */
  stateTimeline = new StateTimeline()
  /**
   * Rank-normalized own-casts (`You begin casting <Spell>.`), for the cast-less proc detector.
   * Only the PLAYER prints that line, which is exactly the gate the detector needs. Each record
   * explains ONE firing and is then spent (JOS-167); pruned to the 12s attribution window.
   */
  recentCasts = new RecentCasts()
  /**
   * WHICH SPELLS THIS CHARACTER OWNS AN INSTANT CLICKY FOR (JOS-438) — canonical spell keys,
   * installed by session.ts from the `/outputfile inventory` dump through
   * `CombatEngine.setHeldClickies`.
   *
   * A SEAM WITH AN EMPTY DEFAULT, exactly like `comboProvider` above and for the same reason:
   * every test, every replay on a machine that has never written a dump, and any future embedding
   * behaves precisely as it did before this gate existed — `castlessKind` over an empty set is the
   * identity function, so not one lane name moves.
   *
   * A PLAIN SET rather than a pull, because unlike the roster and the combo it does not advance
   * with the log: a dump is a snapshot the player writes by hand, and it is re-installed when one
   * is loaded. Reading it is a `Set.has` on the cast-less path only.
   */
  heldClickies: ReadonlySet<string> = NO_CLICKIES
  /**
   * ts of the last `You activate Quick Buff.` (0 = never). That AA re-applies the player's
   * memorized buffs and prints only their LANDINGS — no cast line for any of them — so the
   * burst it opens is cast evidence of a different shape, and the heal side of the cast-less
   * proc inference must not read those landings as procs (procDetect's Quick Buff gate).
   */
  quickBuffTs = 0
  /**
   * WHICH SPECIAL ATTACK IS LIVE IN EACH VERB LANE (specialAttacks.ts). The log states the switch
   * once — `You will now use Dragon Punch instead of Eagle Strike while attacking.` — and every
   * swing afterwards prints only the generic verb, so this is the ONLY thing that can name the
   * lane. Session-scoped and zone-surviving (the state line is printed once and holds across
   * hundreds of zone lines), cleared by reset() and by the epoch boundary.
   */
  specials = new SpecialAttacks()
  /**
   * THE ONE-SENTENCE NUDGE FOR AN UNBOUND SUMMONED PET (JOS-258, petNudge.ts).
   *
   * It is a DISPLAY timer and nothing else: it attributes no damage, opens no encounter, enters no
   * roster and is read by exactly one field of the snapshot. Armed by the player's own pet-summon
   * cast, cleared by any of the three petClaims.ts binds, and expired by its own clock.
   */
  petNudge = new PetNudgeState()
  /**
   * THE ENGINE'S OWN ATTRIBUTION SEAM (JOS-59, foldProbe.ts). Undefined on every boot and in
   * every test; installed only by `CombatEngine.attachFoldProbe`, which only the bench calls.
   * Read as `const p = this.probe; if (p) …` on the hot paths — one field read and one branch.
   */
  probe?: EngineFoldProbe

  /** Enable classification logging (after the historical scan, for the live tail), and
   *  flip HYDRATION off — from here on every snapshot describes the real present. */
  setLive(): void {
    this.recording = true
    this.hydrating = false
  }

  /**
   * Inject the player's own character name (from index.ts's tail ref). This is the
   * authoritative source: called before the scan replay and again on a character
   * switch after reset(). Keyed canonically so it matches the idKey() the heal path
   * uses. Wins over any heal-line-learned name.
   */
  setPlayerName(name: string): void {
    this.playerKey = idKey(name)
    this.playerKeyInjected = true
    this.knownPlayers.add(this.playerKey)
  }

  reset(): void {
    this.petNames.clear()
    this.everPet.clear()
    this.everStruck.clear()
    this.world.reset()
    this.charm.reset()
    this.ally.reset()
    this.others.reset()
    this.knownPlayers.clear()
    this.playerKey = undefined
    this.playerKeyInjected = false
    this.zone = undefined
    this.current = null
    this.history = []
    this.zoneAgg = new Agg()
    this.zoneFinalizedMs = 0
    this.zoneActiveMs = 0
    this.zoneStartTs = 0
    this.zoneLastTs = 0
    this.zoneHistory = []
    this.zoneSeq = 0
    this.recent = []
    this.recording = false
    // A reset always precedes a fresh full-log scan (startup / character switch), so we're
    // hydrating again until that scan hands off to the tail.
    this.hydrating = true
    this.lastActivityTs = 0
    this.stance = undefined
    this.invocation = undefined
    this.coatUtility = undefined
    this.coatCombat = []
    this.coatClassCheckedTs = 0
    this.slowSamples = []
    this.stateTimeline.reset()
    this.recentCasts.clear()
    // A reset precedes a fresh scan of a DIFFERENT character's log as often as the same one's, and
    // one character's bags say nothing about another's. session.ts re-installs immediately after.
    this.heldClickies = NO_CLICKIES
    this.quickBuffTs = 0
    this.specials.reset()
    this.petNudge.reset()
  }

  log(ts: number, cat: string, role: ClassifiedLine['role'], text: string): void {
    if (!this.recording) return
    const p = this.probe
    if (p) p.enter(SEC_RINGS)
    this.recent.push({ ts, cat, role, text })
    if (this.recent.length > RECENT_CAP) this.recent.shift()
    if (p) p.leave()
  }

  /** The in-progress encounter, but only while it is FRESH — the same rule routeMiss uses so a
   *  non-damage event can attach to the fight it belongs to without reviving a stale one (and
   *  without ever OPENING one: only damage/CC do that). */
  freshEncounter(ts: number): Encounter | null {
    return this.current && ts - this.current.lastTs <= FALLBACK_IDLE_MS ? this.current : null
  }

  /** Append a point annotation to an encounter's marker ring (Task #64), drop-oldest at
   *  MARKER_CAP. Draw-only: no count, DPS or attribution ever reads this. */
  pushMarker(enc: Encounter, m: MarkerRaw): void {
    const p = this.probe
    if (p) p.enter(SEC_RINGS)
    enc.markers.push(m)
    if (enc.markers.length > MARKER_CAP) enc.markers.shift()
    if (p) p.leave()
  }

  /** Append one instant to the current encounter's timeline ring (Task #51), capped
   *  drop-oldest at TIMELINE_CAP. Called from route()/routeMiss for attributed events.
   *  `eventsTotal` counts EVERY push, so a fight that outgrows the cap still knows its true
   *  instant count and buildTimeline can declare the loss instead of reporting the ring
   *  length as if it were the fight (law 1). The counter is display metadata only — no
   *  aggregate, DPS or attribution reads it. */
  pushTimeline(enc: Encounter, rec: TimelineRaw): void {
    const p = this.probe
    if (p) p.enter(SEC_RINGS)
    enc.events.push(rec)
    enc.eventsTotal++
    if (enc.events.length > TIMELINE_CAP) enc.events.shift()
    if (p) p.leave()
  }

  /**
   * PRESENCE refresh (Task #55) — record that `name` is still in the current fight as of
   * `ts`. This is the liveness axis ONLY: it moves nothing on the damage timeline
   * (enc.lastTs / prevDamageTs / activeMs / lastActivityTs are untouched), so DPS
   * denominators and the fled-mob FALLBACK_IDLE_MS clock are unaffected (AGENTS.md law 8).
   *
   * Deliberately conservative in both directions:
   *   - it never ENGAGES anything: only instances ALREADY in enc.engaged are refreshed,
   *     so a miss/resist still cannot open or join an encounter;
   *   - it never resolves/creates a world instance (it matches the engaged instanceIds
   *     "<nameKey>#gen" by name prefix), so a whiff at a mob we've never damaged has no
   *     side effect on the world model at all.
   * Name-level matching refreshes every engaged twin sharing the name — the log cannot
   * tell twins apart on a miss line, and a retired twin is "gone" via isRetired anyway.
   */
  notePresence(name: string, ts: number): void {
    const enc = this.current
    if (!enc) return
    const key = idKey(name)
    if (this.isKnownPlayer(key)) return
    // …and a GROUP MEMBER is never a hostile either (docs/plans/group-model.md §3.5). Members
    // never reach `engaged` (engageHostile refuses them), so the loop below would find nothing
    // to refresh anyway; the early return states the rule where a reader looks for it and keeps
    // it from depending on that other guard staying correct.
    if (this.isMember(key)) return
    // Keep the WORLD's per-instance clock in lockstep with the encounter's presence axis, so
    // the staleness retirement in WorldModel.resolve() ages an instance out on exactly the
    // same evidence evalClosure() uses to call it gone (see world.ts INSTANCE_STALE_MS).
    this.world.noteSeen(key, ts)
    for (const id of enc.engaged) {
      const hash = id.lastIndexOf('#')
      if (hash > 0 && id.slice(0, hash) === key) this.notePresenceId(enc, id, ts)
    }
  }

  /**
   * Presence refresh for an already-resolved engaged instanceId (see notePresence).
   *
   * PRESENCE DISCIPLINE (Task #65): a refresh may only ever describe a HOSTILE we are
   * fighting. Two entities can never be refreshed here, because keeping the fight alive on
   * their account is what let a stranger's 214-second brawl swallow three of the owner's
   * pulls: a KNOWN PLAYER (never a hostile) and a LIVE PET of ours (never something we are
   * killing — hostilePresence() already skips it, and refreshing it is meaningless).
   */
  notePresenceId(enc: Encounter, instanceId: string, ts: number): void {
    if (!enc.engaged.has(instanceId)) return
    if (this.world.isLivePet(instanceId)) return
    const hash = instanceId.lastIndexOf('#')
    const nameKey = hash > 0 ? instanceId.slice(0, hash) : ''
    if (nameKey !== '' && (this.isKnownPlayer(nameKey) || this.isMember(nameKey))) return
    const prev = enc.engagedSeen.get(instanceId)
    if (prev === undefined || ts > prev) enc.engagedSeen.set(instanceId, ts)
  }

  /** True when `nameKey` is a player (the owner, or someone the heal stream tied to them). */
  isKnownPlayer(nameKey: string): boolean {
    return nameKey === 'you' || this.knownPlayers.has(nameKey)
  }

  /** The live roster view (see rosterProvider). One call per decision, never cached across
   *  lines — the roster can change between any two of them. */
  roster(): RosterView {
    return this.rosterProvider()
  }

  /** The roster as the snapshot serializes it (see rosterSnapProvider). */
  rosterSnap(): RosterSnap {
    return this.rosterSnapProvider()
  }

  /**
   * True when `nameKey` is someone the engine may book OUTGOING damage for as a group member.
   * This is the ADMISSION test — deliberately the wider `admitted` set, not the live roster, so
   * that a member who left mid-pull keeps being recorded (their damage is real and the Everyone
   * scope shows it) and so that a user REMOVING someone in the popover only ever hides a row.
   */
  isAdmittedMember(nameKey: string): boolean {
    if (nameKey === 'you') return false
    // A pet is never a member. The guard is the same absolute one notePlayer uses and it
    // matters for the same reason: a "member" is excluded from `engaged` and from presence, so
    // one bad entry would silently delete a real pet's damage with no error anywhere.
    if (this.petNames.has(nameKey) || this.everPet.has(nameKey)) return false
    return this.roster().admitted.has(nameKey)
  }

  /**
   * True when `nameKey` is on the roster RIGHT NOW. This is the "never a hostile" test —
   * engageHostile and the presence axis both consult it, because a group member's TARGET is what
   * we are fighting and the member never is (docs/plans/group-model.md §3.5: the 214-second
   * merged pull is what happens when a friendly enters `engaged`).
   *
   * The live roster rather than `admitted`: someone who genuinely left your group and is now
   * duelling you is not protected by having once been a member. The admission set is about
   * damage already earned; this one is about who is on your side now.
   */
  isMember(nameKey: string): boolean {
    return this.roster().members.has(nameKey)
  }

  /**
   * Record player-shaped evidence for a name (see knownPlayers for what counts and why).
   *
   * A PET IS NEVER A PLAYER, and the guard is absolute in both directions: a name that is or
   * has ever been one of your pets — or that any charm broadcast has ever named — can never be
   * filed here, and `notePet` below evicts a name the moment it becomes a pet. Getting this
   * wrong is expensive and silent: a "player" is excluded from `engaged`, from enemy healing,
   * and from a pet's target set, so one bad entry deletes real damage with no error anywhere.
   *
   * SOMETHING YOU HAVE BEEN KILLING IS NEVER A PLAYER EITHER (JOS-48), and it is the same guard
   * for the same reason. The heal line the caller read is `<H> healed you for N`, and the belief
   * behind it — "a mob cannot heal the owner" — is FALSE. Your OWN lifetap prints exactly that
   * shape and names the DRAINED MOB as the healer:
   *
   *     You hit Lord of Loathing for 941 points of unresistable damage by Harm Touch X.
   *     Lord of Loathing has taken 509 damage from your Harm Touch X. (Critical)
   *     Your life force drains away.
   *     Lord of Loathing healed you for 509 hit points by Leech Touch I.
   *
   * Five of those in one reporting slice, plus two more for `a spite golem`. Both were raid mobs
   * the reporter was standing toe to toe with; filing them as players deleted every pet swing at
   * them from that instant on (measured: 18 hits, 398 points, on one named pet in one pull).
   *
   * THE SIGNAL IS YOUR OWN SWING, AND THE NARROWNESS IS MEASURED, NOT TIMID. The obvious wider
   * rule — "anything that was ever an engaged hostile" — is WRONG in the same corpus, and a raid
   * boss is what proves it: Warlord Skarlon mind-controls the reporter's own healer, so
   * `Sonista slashes YOU for 5 points of damage.` lands 27 seconds before
   * `Sonista healed you for 1219 hit points by Healing Light.` A rule reading "it hit me" would
   * unfile a real player and hand him straight back to the `engaged` set — which is the Task #65
   * defect (a stranger's 214-second brawl swallowing three of the owner's pulls) rebuilt from
   * the other end. Being hit is something that HAPPENS to you; hitting is something you DO, and
   * only the second one names a mob.
   *
   * It is deliberately BEHAVIOURAL rather than a catalog lookup, and that is not a compromise:
   * it works identically for a mob no catalog has ever heard of. `Lord of Loathing` is in the
   * shipped catalog and `a fire giant warrior` is too; neither fact is consulted, and the fix
   * would hold if both were absent. (The deleted pet-candidate detector excluded proper-named
   * mobs — `Cleric of Innoruuk`, `Lord of Loathing` — by this same reasoning, JOS-49.)
   *
   * ONE DIRECTION ONLY, and that is measured too. The refusal fires when your own damage came
   * FIRST; it does not RETIRE a filing the heal got in ahead of. Full replays say that ordering
   * is what actually happens — in the reporting slice the lifetap trailed the first exchange by
   * 632 s and 336 s, because a lifetap tick is downstream of the damage that produced it, and on
   * the owner's whole 1.4M-line log not one of the seven heal-minted players had ever been
   * struck by him. The retirement is not free (it would have to overrule a filing that is
   * protecting a real person), so it waits for a log that needs it.
   */
  notePlayer(nameKey: string | null | undefined): void {
    if (!nameKey || nameKey === 'you') return
    if (this.everPet.has(nameKey) || this.charm.everCharmed(nameKey)) return
    if (this.everStruck.has(nameKey)) return
    this.knownPlayers.add(nameKey)
    // …and a heal landing on YOU outranks a swing at you, so it also un-marks the record-everything
    // ladder's hostile flag (JOS-430). Law 4's own counterexample is the reason: a raid boss
    // mind-controls your healer, she hits you 27 seconds before she heals you, and the heal is the
    // line with a person behind it. The three refusals above make this safe — nothing you have
    // struck, charmed or owned as a pet can reach here.
    this.others.clearHostile(nameKey)
  }

  /**
   * Record that YOU landed damage on `nameKey` (JOS-48) — the mob half of `notePet`, and the
   * only writer of `everStruck`.
   *
   * Called from the single admission point in routing.ts, on the `out-you` verdict and nothing
   * else, beside the pet-candidate disqualifier that reads the same fact ("you do not attack
   * your own pet" — and you do not attack your own healer either). Your PET's swings are
   * deliberately not evidence here: a pet auto-attacks what it is pointed at, including a
   * charmed ally, so it carries no statement of intent.
   */
  noteStruck(nameKey: string): void {
    if (nameKey === '' || nameKey === 'you') return
    this.everStruck.add(nameKey)
  }

  /** Bind `nameKey` into the attribution set. THE one door, so "was this ever a pet?" has a
   *  single answer and a player can never shadow one. */
  notePet(nameKey: string): void {
    this.petNames.add(nameKey)
    this.everPet.add(nameKey)
    this.knownPlayers.delete(nameKey)
    this.retractOther(nameKey, 'bound as your pet')
  }

  /**
   * A STRONGER MODEL HAS CLAIMED A NAME — take back the row the record-everything ladder booked for
   * it (JOS-430). The pet and charm models are authoritative for pet attribution, so a pet that
   * swung a few times before its binding line arrived must end up with ONE row (its own), never
   * two.
   *
   * IT CANNOT LOSE A NUMBER THAT EXISTED BEFORE IT DID. An `'other'` row is additive by
   * construction — it enters no `you`/`pet` total, no target ledger, no `engaged` set and no
   * presence clock — so deleting it moves exactly the damage this feature added and nothing else.
   * The damage is not discarded either: the very same lines are re-booked under the pet's own row
   * from the bind onward, which is where they belonged.
   *
   * A ROSTER MEMBER IS NEVER RETRACTED. Their row is the roster's, not this ladder's; the guard
   * matters because `noteStruck` and a charm broadcast can both name a real group-mate (a raid boss
   * mind-controlling one, an AE catching one) and neither may delete a group-mate's bar.
   *
   * THE STATED LIMIT: it reaches the LIVE aggregates — the open fight, the finalized fights still
   * in history (whose memoized summary is dropped so it re-derives), and the live zone session. A
   * zone session already FROZEN keeps the row: its aggregate is immutable by design (Task #54) and
   * a pet bound after you left the zone is not worth a thaw. Measured on the owner's whole log,
   * every retraction fires within the same fight as the swings it takes back.
   */
  retractOther(nameKey: string, why: string): void {
    if (nameKey === '' || this.roster().admitted.has(nameKey)) return
    if (!this.others.notePet(nameKey)) return
    if (!this.others.isRecorded(nameKey)) return
    this.others.forget(nameKey)
    const id = `member:${nameKey}`
    this.zoneAgg.dropOut(id)
    if (this.current?.agg.dropOut(id) === true) this.current.summary = undefined
    for (const enc of this.history) if (enc.agg.dropOut(id)) enc.summary = undefined
    this.log(this.lastActivityTs, 'charm', 'dropped', `✕ ${nameKey}: ${why} - its recorded row is now the pet's`)
  }

  /**
   * RE-INDEX `petNames` off the world model's live pets, and report the name keys that fell out.
   *
   * `petNames` is not a second opinion about who your pets are — it is a fast NAME index of the
   * world model's pet INSTANCES, which is why every path that can retire one has to put the two
   * back in step (death does it by hand, zone rebuilds from the survivors). JOS-54 added a
   * third: `world.claim()` retires the prior summoned pet, and a name left behind in this set
   * would go on being admitted as yours by routing's `classify()` — the retirement would then
   * be invisible exactly where it matters.
   *
   * Deliberately DERIVED rather than surgical: whatever the world model says is live is the
   * answer, so the two can never drift. `everPet` is untouched by design — it records that a
   * name was EVER yours (the absolute refusal `notePlayer` runs on) and a retired pet is still
   * a pet, never a candidate player.
   */
  syncPetNames(): string[] {
    const live = new Set(this.world.petInstances().map((i) => i.nameKey))
    const dropped: string[] = []
    for (const key of this.petNames) if (!live.has(key)) dropped.push(key)
    for (const key of dropped) this.petNames.delete(key)
    return dropped
  }

  /**
   * DEMOTE the charm binds whose corroboration window has closed (charmModel's PROVISIONAL_MS).
   * Driven by the log clock — called once per ingested event and once per snapshot(now) — so a
   * replay and a live tail demote at exactly the same instants. Cheap: the guard is a
   * `Map.size === 0` read, and the map holds at most a handful of names.
   */
  sweepCharm(now: number): void {
    if (this.charm.idle) return
    for (const d of this.charm.sweep(now)) {
      this.world.uncharm(d.display, now)
      this.petNames.delete(d.nameKey)
      this.log(now, 'charm', 'dropped', `✕ ${d.display}: charm bind never corroborated - unbound`)
    }
  }

  /**
   * MAY `nameKey` BE A THIRD-PARTY CHARMER? (JOS-250.) The behavioural half of the caster gate —
   * shared/playerShape.ts answers the shape half, and the ally model asks both.
   *
   * The three refusals are the SAME absolute guards `notePlayer` wears, and they are here for the
   * same reason: a name YOU have landed damage on is a mob, a name any charm broadcast has ever
   * named is a mob, and a name that is or was your pet is a pet. A single-word proper-named mob is
   * exactly what the shape test cannot refuse, and these are what catch it.
   */
  allyCasterAllowed(nameKey: string): boolean {
    if (nameKey === '' || nameKey === 'you' || nameKey === this.playerKey) return false
    if (this.petNames.has(nameKey) || this.everPet.has(nameKey)) return false
    if (this.everStruck.has(nameKey) || this.charm.everCharmed(nameKey)) return false
    return true
  }

  /**
   * IS `nameKey` ON THE FRIENDLY SIDE OF AN ALLY CHARM? (JOS-250.) A bound ally pet swinging at
   * one of these is the SOFT-HOSTILE PROOF that its charm broke — see allyCharms.ts.
   *
   * Five sources, widest first: you, your own live pets, the group roster, anyone the heal stream
   * proved a player, and the ally model's own caster/charmer set. The last is the one that does
   * the work in practice, because the measured breaks are pets turning on the STRANGER who
   * charmed them, and a stranger is invisible to the other four.
   */
  allyFriendly(nameKey: string): boolean {
    if (nameKey === '' || nameKey === 'you') return true
    if (this.petNames.has(nameKey)) return true
    if (this.isKnownPlayer(nameKey) || this.isMember(nameKey)) return true
    return this.ally.isFriendly(nameKey)
  }

  /**
   * END the ally binds whose charm can no longer be running (allyCharms.sweep). Driven by the LOG
   * clock from the same two places `sweepCharm` is — once per ingested event and once per
   * snapshot(now) — so a replay and a live tail expire at identical instants.
   */
  sweepAlly(now: number): void {
    if (this.ally.idle) return
    for (const e of this.ally.sweep(now)) {
      this.log(now, 'charm', 'dropped', `✕ ${e.display}: ${e.charmer}'s charm has run its full duration - unbound`)
    }
  }

  /** Display names of the live ALLY pets — somebody else's charm pets, never yours. Deliberately
   *  separate from `petDisplayNames()`: nothing here is in the attribution set. */
  allyPetNames(): string[] {
    return this.ally.boundNames()
  }

  /**
   * Learn the player's proper name as a FALLBACK only (injected name wins):
   * "You healed <Player>" where the target is not a pet and not an engaged
   * hostile → that name IS the player. (EQ never writes literal "You" as a heal
   * target; it uses the character name.)
   */
  learnPlayerKey(healerKey: string | null, tKey: string, isYouTgt: boolean, isPetTgt: boolean): void {
    if (
      !this.playerKeyInjected &&
      healerKey === 'you' &&
      !isYouTgt &&
      !isPetTgt &&
      !this.isEngagedHostile(tKey) &&
      this.playerKey === undefined
    ) {
      this.playerKey = tKey
    }
    if (this.playerKey !== undefined) this.knownPlayers.add(this.playerKey)
  }

  /** True if `nameKey` currently resolves to an engaged hostile instance. */
  isEngagedHostile(nameKey: string): boolean {
    if (!this.current) return false
    for (const list of [this.current]) {
      for (const id of list.engaged) {
        // engaged ids are instanceIds "<nameKey>#gen"; compare the nameKey prefix.
        const hash = id.lastIndexOf('#')
        if (hash > 0 && id.slice(0, hash) === nameKey) return true
      }
    }
    return false
  }

  /**
   * INSTANCE-RESOLVED defender label for a damage-free instant (miss/resist), Task #58.
   *
   * The damage path labels its defender `world.label(world.resolve(target, ts))`, so twins
   * read as "a deadly black widow (7)" / "(8)". Miss and resist ticks carried the RAW log
   * name instead, so the dashboard's per-mob panel — which groups timeline instants by
   * `target` — grew a bare-named 0-damage ghost row alongside the two real instances.
   *
   * Resolution is GATED on the name already being engaged in this encounter (the same
   * nameKey-prefix scan notePresence uses). That keeps AGENTS.md law 8 intact in both
   * directions: `engaged` membership only ever comes from LANDED damage/heals, so a whiff
   * at a mob we have never damaged still has ZERO world-model side effects (no instance is
   * spawned, no gen counter moves) and simply keeps its raw name — the honest label when no
   * instance exists. When the name IS engaged, resolve() returns the same instance the next
   * landed hit would, so the miss lands on the right twin's row.
   */
  defenderLabel(enc: Encounter, name: string, ts: number): string {
    const key = idKey(name)
    if (key === 'you') return 'You'
    for (const id of enc.engaged) {
      const hash = id.lastIndexOf('#')
      if (hash > 0 && id.slice(0, hash) === key) return this.world.label(this.world.resolve(name, ts))
    }
    return name
  }

  /**
   * Display names of your GENUINELY-CHARMED live pets (mobs bound by a
   * `<mob> has been charmed.` line). SUMMONED class pets are deliberately excluded —
   * they are pets, not charms. Deliberately NOT in the snapshot: no UI needs a charm
   * roster today, and the old snapshot field lied (it was the attribution set). This is
   * the ONLY correct door for one; never reconstruct it from petNames.
   */
  charmedPetNames(): string[] {
    return this.world.charmedInstances().map((i) => i.display)
  }

  /** Display names of ALL your live pets — charmed AND summoned. This is what the DPS
   *  meter attributes to (both kinds produce `kind: 'pet'` source rows). */
  petDisplayNames(): string[] {
    return this.world.petInstances().map((i) => i.display)
  }
}
