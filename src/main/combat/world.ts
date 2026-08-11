// WorldModel — entity-instance tracking for the combat engine.
//
// PURPOSE
// The engine historically keyed everything by bare name. That collapses same-named
// twins: when you charm one "a fire giant warrior" while a hostile "a fire giant
// warrior" is present, both share a name key, so the pet and the mob it tanks are
// indistinguishable. This model gives every spawn a distinct INSTANCE identity
// (`${nameKey}#${gen}`) so twins are separate entities in encounter aggregation and
// so charm/death lifecycle can be reasoned about deterministically.
//
// An instance is: { instanceId, nameKey, display, charmed, firstSeenTs, lastSeenTs,
// retired }. Per nameKey we keep an ordered list of instances; `gen` increments per
// spawn. At most a handful are "active" (not retired) at once. Display disambiguates
// the Nth live generation as e.g. "a fire giant warrior (2)".
//
// ─────────────────────────────────────────────────────────────────────────────
// LIFECYCLE DECISION TABLE (all rules deterministic; ambiguity is flagged, never
// silently guessed toward the worse failure mode — a false pet-death drops all
// subsequent pet damage, so we bias AWAY from retiring the pet on ambiguity):
//
//  EVENT            RULE
//  ─────────────    ───────────────────────────────────────────────────────────
//  see(name)        Resolve an active instance for `name`. If none active, spawn a
//                   new hostile instance (gen++). Used to resolve damage/heal
//                   attacker & target to instances. Same-name twins are separated
//                   by evidence (see noteTwinEvidence): a second active instance is
//                   spawned when the log proves two co-exist.
//
//  charm(name)      The charmed pet must be an ACTIVE instance marked charmed.
//                   - If an active, not-yet-charmed hostile instance of `name`
//                     exists AND there is no evidence of a second live twin, BIND
//                     it: mark that instance charmed (the mob you were fighting is
//                     now your pet).
//                   - Otherwise SPAWN a fresh charmed instance (gen++). This covers
//                     the first charm of a name never seen, and re-charming while a
//                     hostile twin is already live.
//
//  claim(name)      The SUMMONED-pet half of charm(): a `… Master.'` tell binds `name` as a
//                   summoned pet. Idempotent FIRST (a live pet of that name just refreshes —
//                   a claim and a later tell converge on one entity), else bind a lone live
//                   hostile instance / spawn a fresh summoned one. Binding a NEW summoned pet
//                   RETIRES the prior summoned pet (single-pet invariant, JOS-54 — you get one
//                   class pet and re-summoning despawns the old one silently). Charmed pets are
//                   untouched: the two kinds demonstrably co-exist (retirePriorSummoned).
//
//  twin evidence    You→name damage while an instance of name is charmed, OR
//                   name→name damage, proves a hostile twin co-exists with the pet.
//                   Ensure a second (hostile) active instance of name exists so the
//                   pet and the twin are distinct. (noteTwinEvidence)
//
//  uncharm(name)    Clear `charmed` on the charmed instance of name (it stays the
//                   SAME instance, now hostile-capable again). Does not retire.
//
//  death(name,      Decide WHICH instance of name dies:
//        killerKey)   1. If no charmed instance of name is active → retire the
//                       oldest active hostile instance of name (plain mob death).
//                     2. If a charmed instance IS active:
//                        a. killerKey === 'you' → the pet cannot be slain-by-you;
//                           retire a hostile twin if one exists, else (only the pet
//                           is live and you "killed" it — a charm-break-then-kill
//                           race) retire the pet.  [pet-safe]
//                        b. killerKey !== name (a different-named killer, e.g. a
//                           fire giant wizard) → this killer was fighting SOMETHING
//                           named `name`. Retire the pet ONLY if evidence shows the
//                           pet was the instance tanking THIS killer (petTankedBy);
//                           otherwise retire the hostile twin and, if no twin
//                           exists, flag ambiguity + retire the twin-slot (never
//                           silently kill the pet).  [bias: keep pet alive]
//                        c. killerKey === name (same-name "slain by") → genuinely
//                           ambiguous (pet↔twin). If a hostile twin exists, retire
//                           the twin (keep pet). If ONLY the pet is live, this is a
//                           real pet death (the game named the pet's killer as the
//                           same-named mob it was tanking, now despawned) → retire
//                           the pet. Flag ambiguity in both sub-cases.
//                     When ambiguous and a twin exists we always keep the pet.
//
//  zone             Retire ALL instances and clear charm (charm cannot survive a
//                   zone; matches the engine's existing zone reset).
//
//  staleness        A live HOSTILE instance unseen for INSTANCE_STALE_MS is retired the
//                   next time its name is resolved, so the sighting after the gap spawns a
//                   FRESH generation. Without it a slot could be pinned live forever:
//                   death() is the only other retirement, and a same-named mob killed
//                   off-screen (or despawned, or fled) logs NO death line — so every later
//                   pull of that name resolved into the corpse's slot and inherited its
//                   identity, its gen label and its engagement history. PETS ARE EXEMPT: a
//                   charmed/summoned pet is bound by explicit evidence and may legitimately
//                   stand quiet for minutes; only death/uncharm/zone retire one.
//                   `lastSeenTs` is refreshed by EVERY presence observation, not only by
//                   damage (see noteSeen + EngineState.notePresence), so the world model
//                   ages an instance out on exactly the evidence evalClosure() calls
//                   presence.
//
//  retirement       EVERY rule above funnels through one private `retire()`, and it announces
//                   itself on `onRetire` (JOS-176). Retirement is FINAL — a later sighting of
//                   the name mints a fresh gen — so anything holding state keyed by instanceId
//                   has to be told, not just the path that happened to remember.
// ─────────────────────────────────────────────────────────────────────────────

import { idKey } from '../log/parser'
import { PRESENCE_GONE_MS } from './encounter'
import { isLeftBehindOnZone, type PetKind } from './entityRules'
import { SEC_WORLD, type EngineFoldProbe } from './foldProbe'

/**
 * How long a LIVE hostile instance may go completely unobserved before its slot is eligible
 * for retirement. Deliberately the SAME number as the encounter layer's PRESENCE_GONE_MS: an
 * instance the closure logic has already written off as "gone" is precisely the one whose
 * identity a later sighting must not inherit, so the two horizons agree by construction
 * rather than by coincidence.
 */
export const INSTANCE_STALE_MS = PRESENCE_GONE_MS

/**
 * How an instance became your pet:
 *   'charmed'  — bound by a `<mob> has been charmed.` line; cannot survive a zone.
 *   'summoned' — a class pet (random proper name) bound by a petClaim (direct
 *                tell). Persists across zone lines (verified in the real log: a
 *                summoned pet kept dealing damage after 3 zone transitions with no
 *                re-summon), so zone() does NOT retire it.
 *
 * The type + the zone-survivor rule are now SHARED with the buffs simulation (Task
 * #32) — see combat/entityRules.ts. Re-exported here so existing importers of
 * `world.ts`'s PetKind are unaffected.
 */
export type { PetKind }

export interface Instance {
  instanceId: string
  nameKey: string
  display: string
  charmed: boolean
  /** Set while `charmed` is true; distinguishes zone behavior. Undefined = hostile. */
  petKind?: PetKind
  firstSeenTs: number
  lastSeenTs: number
  retired: boolean
  /** gen ordinal (1-based) among all instances ever spawned for this nameKey. */
  gen: number
}

/** Result of a death() decision, for engine logging / ambiguity surfacing. */
export interface DeathResolution {
  retired: Instance | null
  wasPet: boolean
  ambiguous: boolean
  reason: string
}

/** The answer `active()` gives for a name nothing has ever spawned under. Shared and frozen —
 *  it is only ever read, and minting an empty array per miss on a 1.4M-event fold is exactly the
 *  kind of allocation JOS-59 came here to delete. */
const NO_INSTANCES: readonly Instance[] = []

export class WorldModel {
  /**
   * THE LIVE instances, keyed by nameKey → ordered oldest→newest. This is the index almost every
   * read below walks, and it is a SEPARATE list from `byName` for one measured reason (JOS-59):
   * a nameKey accumulates one instance per SPAWN and a busy zone respawns the same mob hundreds
   * of times, so on the owner's log `a greater kobold` alone reaches gen 38 and the log's worst
   * names run far past that. Every read used to walk the whole spawn history and allocate a
   * filtered copy of it — `active()` was called two or three times per `resolve()`, and
   * `resolve()` runs on every damage, miss, resist and heal line. Retirement is MONOTONE (nothing
   * ever un-retires), so this list can simply be spliced and never rebuilt.
   *
   * An emptied entry is KEPT rather than deleted, so map insertion order — which is the order
   * `petInstances()` and `charmedInstances()` report in, and therefore the order the UI lists
   * pets in — is exactly what it was when this walked `byName`.
   */
  private activeByName = new Map<string, Instance[]>()
  /** All instances ever, keyed by nameKey → ordered spawn list. Read only where the whole spawn
   *  history genuinely matters (nothing does today) — kept because it is the honest record. */
  private byName = new Map<string, Instance[]>()
  /** instanceId → instance, so `find()` is a lookup rather than a scan of a name's whole history
   *  (it is called from `isRetired`/`isLivePet`, i.e. once per engaged mob per closure eval). */
  private byId = new Map<string, Instance>()
  /** gen counter per nameKey. */
  private gens = new Map<string, number>()
  /** Killers each charmed pet has been observed tanking (pet instanceId → set of
   *  attacker nameKeys that hit it / that it hit). Drives death case (b). */
  private petTankedBy = new Map<string, Set<string>>()
  /**
   * THE BENCH'S SUB-ATTRIBUTION SEAM (JOS-59, foldProbe.ts) — undefined everywhere except under
   * `CombatEngine.attachFoldProbe`. Only the five per-EVENT entry points below are bracketed;
   * the lifecycle methods (charm/claim/death/uncharm/zone) fire per bind and per kill rather
   * than per line and are charged to `dispatch`, which the table's header says out loud.
   */
  probe?: EngineFoldProbe
  /**
   * RETIREMENT IS FINAL, AND THE ENCOUNTER LAYER HAS TO HEAR ABOUT IT (JOS-176). Installed by
   * `EngineState` and called from `retire()` — the ONE place retirement is recorded — so every
   * path that ends an instance (death, staleness, zone, pet succession, the foreign-killer ghost)
   * tells the same story. Before this, only `ingestDeath` cleaned up after itself, so a mez'd mob
   * retired by STALENESS left its CC hold behind in `Encounter.ccActiveUntil` vetoing the
   * death-close on behalf of an entity that could never rejoin the fight: a later sighting of that
   * name mints a fresh `nameKey#gen` (see `spawn`), so the hold was unredeemable by construction.
   * The world model deliberately knows nothing about encounters — it reports the fact and the
   * listener decides what it costs.
   */
  onRetire?: (inst: Instance, ts: number) => void

  reset(): void {
    this.activeByName.clear()
    this.byName.clear()
    this.byId.clear()
    this.gens.clear()
    this.petTankedBy.clear()
  }

  /**
   * Active (non-retired) instances for a nameKey, oldest→newest — THE LIVE ARRAY, not a copy.
   *
   * Callers that RETIRE while walking it must therefore walk it backwards by index (retireStale,
   * zone) or take a copy first; the two that do are commented at their loops. Everything else
   * only reads, and handing them the array directly is the whole point: this is the hottest read
   * in the engine and it used to allocate a filtered copy of a mob's entire spawn history.
   */
  private active(nameKey: string): readonly Instance[] {
    return this.activeByName.get(nameKey) ?? NO_INSTANCES
  }

  /** Spawn a new instance of `nameKey`. A `petKind` IS the charm flag: every call that
   *  spawned a charmed instance always named its kind, and every hostile spawn named none. */
  private spawn(nameKey: string, display: string, ts: number, petKind?: PetKind): Instance {
    const gen = (this.gens.get(nameKey) ?? 0) + 1
    this.gens.set(nameKey, gen)
    const charmed = petKind !== undefined
    const inst: Instance = {
      instanceId: `${nameKey}#${gen}`,
      nameKey,
      display,
      charmed,
      petKind,
      firstSeenTs: ts,
      lastSeenTs: ts,
      retired: false,
      gen
    }
    const list = this.byName.get(nameKey) ?? []
    list.push(inst)
    this.byName.set(nameKey, list)
    const live = this.activeByName.get(nameKey) ?? []
    live.push(inst)
    this.activeByName.set(nameKey, live)
    this.byId.set(inst.instanceId, inst)
    return inst
  }

  /**
   * Adopt a fresher raw sighting as an instance's DISPLAY name — but never let EQ's
   * sentence-casing overwrite the spawn's true name.
   *
   * EQ capitalizes a lowercase-article mob name whenever the name opens a sentence, so ONE
   * spawn is printed two ways: mid-sentence it carries its real name
   * (`You slash a zol ghoul knight for 19 points of damage.`), sentence-initial it is
   * capitalized (`A zol ghoul knight resisted your Condemnation of Nife!`,
   * `A zol ghoul knight hits YOU for 17 points of damage.`). Resist lines and incoming melee
   * are ALWAYS sentence-initial; outgoing damage is always mid-sentence.
   *
   * `resolve()` used to adopt the LATEST sighting unconditionally, so the display flip-flopped
   * with every incoming swing, and any timeline instant written while it happened to be
   * sentence-cased froze the wrong string. Aggregate rows key by instanceId so they only
   * relabelled, but the per-mob timeline grouping keys by the RAW target string — so the user
   * saw one mob as two rows: `a zol ghoul knight (230)` with all the damage and
   * `A zol ghoul knight (230)` carrying a lone resist.
   *
   * THE RULE: a lowercase-initial sighting can only have come from mid-sentence, so it is the
   * spawn's true name and always wins. A capital-initial sighting may be either the true name
   * or sentence-casing, so it may only overwrite another capital-initial display. Proper names
   * ("The Hand of Veeshan", "Kahaptra Z`Taj", players, summoned pets) have NO lowercase variant,
   * so they are always capital→capital and keep the old latest-wins behavior exactly.
   *
   * SPAWN-TIME CONVERGENCE: `spawn()` takes the FIRST sighting verbatim (there is no prior
   * evidence to weigh), so a mob first seen sentence-initially starts out capitalized. The
   * first mid-sentence sighting then flips it to canonical and pins it there — that is the
   * intended one-way settle, not a residual flip-flop.
   */
  private adoptDisplay(inst: Instance, name: string): void {
    if (inst.display === name) return
    if (idKey(inst.display) !== idKey(name)) return // never relabel across identities
    const incomingIsLower = /^[a-z]/.test(name)
    const currentIsLower = /^[a-z]/.test(inst.display)
    if (incomingIsLower || !currentIsLower) inst.display = name
  }

  /** The charmed active instance for a nameKey, if any. */
  private charmedActive(nameKey: string): Instance | undefined {
    return this.active(nameKey).find((i) => i.charmed)
  }
  /** The oldest active hostile (non-charmed) instance for a nameKey, if any. */
  private hostileActive(nameKey: string): Instance | undefined {
    return this.active(nameKey).find((i) => !i.charmed)
  }

  /**
   * Resolve a raw name to a live instance for attribution, spawning a hostile one
   * if none is active. `preferCharmed` picks the charmed pet when both a pet and a
   * hostile twin are live and the caller knows this reference is the pet (e.g. the
   * pet as damage attacker). Otherwise prefers a hostile instance (mob references).
   */
  resolve(name: string, ts: number, preferCharmed = false): Instance {
    const p = this.probe
    if (!p) return this.resolveInner(name, ts, preferCharmed)
    p.enter(SEC_WORLD)
    const inst = this.resolveInner(name, ts, preferCharmed)
    p.leave()
    return inst
  }

  private resolveInner(name: string, ts: number, preferCharmed: boolean): Instance {
    if (idKey(name) === 'you') {
      // 'you' is not modeled as a spawnable instance; caller handles it. Return a
      // synthetic sentinel so callers never crash (they special-case 'you' first).
      return {
        instanceId: 'you',
        nameKey: 'you',
        display: 'You',
        charmed: false,
        firstSeenTs: ts,
        lastSeenTs: ts,
        retired: false,
        gen: 1
      }
    }
    const key = idKey(name)
    this.retireStale(key, ts)
    const act = this.active(key)
    if (act.length === 0) {
      return this.spawn(key, name, ts)
    }
    let inst: Instance
    if (preferCharmed) {
      inst = this.charmedActive(key) ?? this.hostileActive(key) ?? act[0]
    } else {
      inst = this.hostileActive(key) ?? act[0]
    }
    inst.lastSeenTs = ts
    // Fresher casing wins, EXCEPT that EQ's sentence-capitalization can never overwrite the
    // spawn's true lowercase-article name — see adoptDisplay().
    this.adoptDisplay(inst, name)
    return inst
  }

  /**
   * PER-INSTANCE STALENESS (see the header). Retire every live HOSTILE instance of `nameKey`
   * that has gone INSTANCE_STALE_MS without a single observation, so the caller's sighting
   * spawns a fresh generation instead of reviving a mob nobody has seen.
   *
   * Twin-safe: it walks the whole active list, so a pull where one twin died off-screen and
   * the other is still swinging retires only the silent one — the survivor keeps being
   * refreshed by resolve()/noteSeen() and stays exactly where it was. And because pets are
   * skipped, noteTwinEvidence()'s pet-plus-hostile pairing is untouched: the hostile half it
   * spawns is refreshed by the very damage that proved it exists.
   */
  private retireStale(nameKey: string, ts: number): void {
    const live = this.activeByName.get(nameKey)
    if (live === undefined || live.length === 0) return
    // BACKWARDS BY INDEX: `retire()` splices this very array, and a forward walk would skip the
    // element that slid into the hole. Every instance here is by definition unretired.
    for (let i = live.length - 1; i >= 0; i--) {
      const inst = live[i]
      if (inst.charmed) continue
      if (ts - inst.lastSeenTs >= INSTANCE_STALE_MS) this.retire(inst, ts)
    }
  }

  /**
   * Record that `name` was observed at `ts` WITHOUT resolving or spawning anything — the
   * world-model half of the encounter's presence axis (misses, resists, CC, heals). It only
   * refreshes instances that already exist, so a whiff at a mob we have never damaged still
   * has zero world-model side effects (AGENTS.md law 8, the same guarantee notePresence and
   * defenderLabel make).
   */
  noteSeen(name: string, ts: number): void {
    const p = this.probe
    if (p) p.enter(SEC_WORLD)
    for (const inst of this.active(idKey(name))) {
      if (ts > inst.lastSeenTs) inst.lastSeenTs = ts
    }
    if (p) p.leave()
  }

  /** Look up the charmed pet instance for a name (attribution helper). */
  petInstance(name: string): Instance | undefined {
    const p = this.probe
    if (!p) return this.charmedActive(idKey(name))
    p.enter(SEC_WORLD)
    const inst = this.charmedActive(idKey(name))
    p.leave()
    return inst
  }

  /**
   * charm(name): produce the charmed pet instance (see decision table).
   * Returns the instance now marked charmed.
   */
  charm(name: string, ts: number): Instance {
    const key = idKey(name)
    // A slot nobody has seen for INSTANCE_STALE_MS is not the mob we just charmed.
    this.retireStale(key, ts)
    // Bind an existing lone hostile instance only if there's exactly one active
    // instance and it isn't already charmed — no evidence of a second twin yet.
    const act = this.active(key)
    const hostiles = act.filter((i) => !i.charmed)
    if (!this.charmedActive(key) && hostiles.length === 1 && act.length === 1) {
      const inst = hostiles[0]
      inst.charmed = true
      inst.petKind = 'charmed'
      inst.lastSeenTs = ts
      this.petTankedBy.set(inst.instanceId, new Set())
      return inst
    }
    // Otherwise spawn a fresh charmed instance (first-ever charm, or re-charm while
    // a hostile twin is already live).
    const inst = this.spawn(key, name, ts, 'charmed')
    this.petTankedBy.set(inst.instanceId, new Set())
    return inst
  }

  /**
   * claim(name): mark a SUMMONED pet (see petClaim / PetKind). Idempotent — a pet
   * re-tells you every few seconds. If an instance of `name` is already a live pet
   * (charmed or summoned) this is a no-op that just refreshes lastSeen; else it
   * binds a lone live hostile instance as summoned, or spawns a fresh summoned
   * instance. Summoned pets survive zoning, so they must NOT be created via the
   * hostile-spawn path (which zone() would retire).
   *
   * BINDING A NEW SUMMONED PET RETIRES THE PRIOR ONE (JOS-54) — see retirePriorSummoned.
   * The idempotence branch above is what keeps that safe, and it must stay FIRST: the same
   * pet's repeat tells resolve to the same live instance and never reach the succession.
   */
  claim(name: string, ts: number): Instance {
    const key = idKey(name)
    this.retireStale(key, ts)
    const existing = this.active(key).find((i) => i.charmed)
    if (existing) {
      existing.lastSeenTs = ts
      return existing
    }
    const act = this.active(key)
    const hostiles = act.filter((i) => !i.charmed)
    if (hostiles.length === 1 && act.length === 1) {
      const inst = hostiles[0]
      inst.charmed = true
      inst.petKind = 'summoned'
      inst.lastSeenTs = ts
      this.petTankedBy.set(inst.instanceId, new Set())
      this.retirePriorSummoned(inst, ts)
      return inst
    }
    const inst = this.spawn(key, name, ts, 'summoned')
    this.petTankedBy.set(inst.instanceId, new Set())
    this.retirePriorSummoned(inst, ts)
    return inst
  }

  /**
   * THE SINGLE-PET INVARIANT, for summoned pets (AGENTS.md world-model law 4; JOS-54).
   *
   * You get one class pet. Re-summoning despawns the one you had — the game prints NOTHING
   * when it happens (no death line, no fade, no tell), so the successor's own claim tell is the
   * only evidence that arrives, and before this the world model held every pet the owner had
   * ever ordered as simultaneously live. MEASURED on the owner's whole log (1.40M lines,
   * 3,175 claim tells): the replay ended with TWENTY-THREE live summoned pets, every animation
   * from Jul 19 to Aug 06 still attributing. The committed fixture is the same defect in one
   * window: Jaber (tell 12:43:12) and Gonekn (tell 12:44:51) both stood live.
   *
   * RETIREMENT, NOT DELETION. The old pet keeps its instance and everything already attributed
   * to it — aggregates key by instanceId, so its rows and its history are exactly as they were.
   * What ends is its FUTURE: it is no longer a live pet, so nothing later is admitted as yours.
   *
   * AND IT COSTS NOTHING, which is the measurement that had to come before the rule. Over the
   * whole log the invariant fires 23 times, and the pet it retires lands ZERO further damage
   * lines — not within five minutes, not ever. A summoned pet that has been replaced is simply
   * gone; the successor's tell is late news, never a race.
   *
   * SUMMONED ONLY, and that restraint is measured rather than assumed. 344 charm binds land
   * while a summoned pet is still flagged live, so the crossover is not hypothetical — but of
   * those, exactly FOUR have both entities swinging within five minutes of the bind, and in all
   * four the "summoned" side is an article-named MOB that reached this method by its own tell
   * (a charmed mob sends `… Master.'` too, and binds here as summoned whenever no charm
   * broadcast was bound for it). So the log contains NO case of a proper-named class pet and a
   * charmed pet demonstrably alive together, and none of one replacing the other either. That is
   * an unobserved shape, and the awaiting-sample law says it does not get a rule invented for it
   * — especially not one whose failure mode is silently deleting a live pet's damage, which is
   * this model's whole stated bias. charm() is untouched for the same reason: charm succession
   * has its own evidence (the wear-off line), and the buffs module (modules/buffs.ts onCharm /
   * onPetClaim) already runs an entity-level succession across both kinds for its own purposes.
   */
  private retirePriorSummoned(pet: Instance, ts: number): void {
    // Backwards by index, for the reason retireStale states: `retire()` splices these arrays.
    for (const list of this.activeByName.values()) {
      for (let i = list.length - 1; i >= 0; i--) {
        const inst = list[i]
        if (!inst.charmed || inst.petKind !== 'summoned') continue
        if (inst.instanceId === pet.instanceId) continue
        this.retire(inst, ts)
      }
    }
  }

  /**
   * uncharm(name): clear the charmed flag on the pet instance (same instance).
   * Summoned pets are never un-charmed by a worn-off charm-spell line (they have
   * proper names, not the charmed mob's name), so this is a no-op for them.
   */
  uncharm(name: string, ts: number): Instance | undefined {
    const inst = this.charmedActive(idKey(name))
    if (inst && inst.petKind !== 'summoned') {
      inst.charmed = false
      inst.petKind = undefined
      inst.lastSeenTs = ts
      return inst
    }
    return undefined
  }

  /**
   * Record evidence that a hostile twin of `name` co-exists with a charmed pet of
   * the same name: ensure a second active hostile instance exists. Called when the
   * engine sees You→charmed-name damage or name→name damage.
   */
  noteTwinEvidence(name: string, ts: number): void {
    const key = idKey(name)
    if (!this.charmedActive(key)) return // only meaningful while a pet is live
    if (!this.hostileActive(key)) this.spawn(key, name, ts)
  }

  /**
   * Note that a charmed pet is tanking / trading blows with a killer of nameKey
   * `otherKey`. Drives death case (b): if that killer later "slays" name, and the
   * pet was tanking it, the pet is the one that died.
   */
  notePetEngagement(petName: string, otherKey: string): void {
    const pet = this.charmedActive(idKey(petName))
    if (!pet) return
    const set = this.petTankedBy.get(pet.instanceId) ?? new Set()
    set.add(otherKey)
    this.petTankedBy.set(pet.instanceId, set)
  }

  /**
   * death(name, killerKey): decide which instance retires. Returns the resolution
   * (retired instance, whether it was the pet, ambiguity flag, reason).
   */
  death(name: string, ts: number, killerKey: string | undefined): DeathResolution {
    const key = idKey(name)
    const act = this.active(key)
    if (act.length === 0) {
      return { retired: null, wasPet: false, ambiguous: false, reason: 'no active instance' }
    }
    const pet = this.charmedActive(key)
    const hostile = this.hostileActive(key)

    // Case 1: no charmed instance — plain hostile death.
    if (!pet) {
      const victim = hostile ?? act[0]
      this.retire(victim, ts)
      return { retired: victim, wasPet: false, ambiguous: false, reason: 'plain hostile death' }
    }

    const kk = killerKey

    // Case 2a: killer is You. The pet can't be slain BY you; a hostile twin died.
    if (kk === 'you') {
      if (hostile) {
        this.retire(hostile, ts)
        return { retired: hostile, wasPet: false, ambiguous: false, reason: 'you slew hostile twin' }
      }
      // Only the pet is live and the game says you slew it — charm broke this tick
      // then you killed it. Retire the pet (rare, deterministic).
      this.retire(pet, ts)
      return { retired: pet, wasPet: true, ambiguous: false, reason: 'you slew pet (charm-break race)' }
    }

    // Case 2b: killer is a DIFFERENT name (e.g. a fire giant wizard).
    if (kk && kk !== key) {
      return this.deathByForeignKiller({ key, name, ts, pet, hostile }, kk)
    }

    // Case 2c: killer is the SAME name ("a fire giant warrior slain by a fire giant
    // warrior") — pet↔twin, genuinely ambiguous.
    if (hostile) {
      // A hostile twin exists — retire it, keep the pet. Flag ambiguity.
      this.retire(hostile, ts)
      return { retired: hostile, wasPet: false, ambiguous: true, reason: 'ambiguous same-name death; kept pet, retired twin' }
    }
    // Only the pet is live and a same-named mob slew it → real pet death.
    this.retire(pet, ts)
    return { retired: pet, wasPet: true, ambiguous: true, reason: 'ambiguous same-name death; only pet live → pet died' }
  }

  /**
   * death() case 2b: a charmed pet of `name` is live and the killer is a DIFFERENT name
   * (e.g. a fire giant wizard) — so that killer was fighting SOMETHING named `name`. The
   * bias is always AWAY from retiring the pet (a false pet-death drops all subsequent pet
   * damage), which is why the twin is preferred and, when no twin exists, a twin SLOT is
   * spawned and retired rather than the pet.
   */
  private deathByForeignKiller(
    ctx: { key: string; name: string; ts: number; pet: Instance; hostile: Instance | undefined },
    kk: string
  ): DeathResolution {
    const { key, name, ts, pet, hostile } = ctx
    const petTanked = this.petTankedBy.get(pet.instanceId)?.has(kk) ?? false
    if (petTanked && !hostile) {
      // Only the pet was tanking this killer and no hostile twin exists → pet died.
      this.retire(pet, ts)
      return { retired: pet, wasPet: true, ambiguous: false, reason: `pet slain by ${kk} it was tanking` }
    }
    if (hostile) {
      // Prefer retiring the hostile twin (keep the pet — the safe bias).
      this.retire(hostile, ts)
      const ambiguous = petTanked
      return {
        retired: hostile,
        wasPet: false,
        ambiguous,
        reason: ambiguous ? `ambiguous: pet also tanked ${kk}; kept pet, retired twin` : `hostile twin slain by ${kk}`
      }
    }
    // No hostile twin AND no evidence the pet tanked this killer: the killer was
    // fighting a same-named mob we hadn't separately instanced. Spawn+retire a
    // hostile twin slot; keep the pet, flag ambiguity (never silently kill pet).
    const ghost = this.spawn(key, name, ts)
    this.retire(ghost, ts)
    return { retired: ghost, wasPet: false, ambiguous: true, reason: `ambiguous: ${kk} slew a ${name}; kept pet` }
  }

  private retire(inst: Instance, ts: number): void {
    inst.retired = true
    inst.lastSeenTs = ts
    inst.charmed = false
    inst.petKind = undefined
    this.petTankedBy.delete(inst.instanceId)
    // Out of the live index — the one place retirement is recorded, so the index cannot drift.
    const live = this.activeByName.get(inst.nameKey)
    if (live) {
      const at = live.indexOf(inst)
      if (at >= 0) live.splice(at, 1)
    }
    // …and say so, once, from the one place that records it (see onRetire).
    this.onRetire?.(inst, ts)
  }

  /**
   * zone: retire everything EXCEPT summoned pets. Charm cannot survive a zone and
   * hostile mobs don't follow you, so both are retired; SUMMONED class pets persist
   * across zone lines (real-log verified), so they're kept live. Returns the
   * summoned pet instances that survived, so the engine can keep their name keys in
   * its charmed set.
   */
  zone(ts: number): Instance[] {
    const survivors: Instance[] = []
    for (const list of this.activeByName.values()) {
      // A COPY, not the live array: `retire()` splices it, and unlike retireStale this loop must
      // stay FORWARD — the survivors it returns are rendered in this order. Zone lines are rare,
      // so the copy costs nothing measurable.
      for (const inst of [...list]) {
        // Shared rule (entityRules.isLeftBehindOnZone): only a live SUMMONED pet
        // survives a zone; charmed pets and hostiles are left behind. A hostile
        // instance has petKind undefined → left behind (unchanged behavior).
        const kind = inst.charmed ? inst.petKind : undefined
        if (inst.charmed && !isLeftBehindOnZone(kind)) {
          inst.lastSeenTs = ts
          survivors.push(inst)
        } else {
          this.retire(inst, ts)
        }
      }
    }
    return survivors
  }

  private find(instanceId: string): Instance | undefined {
    return this.byId.get(instanceId)
  }

  /** True if the instance with this id has been retired (dead/zoned). Unknown ids
   *  (never spawned) are treated as retired — they can't be a live engagement. */
  isRetired(instanceId: string): boolean {
    const p = this.probe
    if (p) p.enter(SEC_WORLD)
    const inst = this.find(instanceId)
    if (p) p.leave()
    return inst ? inst.retired : true
  }

  /** True if the instance is currently your (live, non-retired) charmed/summoned pet.
   *  Such an instance is never a hostile we're trying to kill, so it must NOT block
   *  an encounter's death-close (a charmed pet never dies, so it would pin every
   *  charm-grind fight open forever). */
  isLivePet(instanceId: string): boolean {
    const p = this.probe
    if (p) p.enter(SEC_WORLD)
    const inst = this.find(instanceId)
    if (p) p.leave()
    return !!inst && !inst.retired && inst.charmed
  }

  /**
   * The GENUINELY-CHARMED live pets — mobs bound by a `<mob> has been charmed.` line.
   * A summoned class pet (bound by its owner-only "… Master." claim tell) is a pet but is
   * NOT charmed, so it is excluded here by petKind. This is the ONLY honest source for a
   * charm roster; the engine's petNames set is attribution-only and contains both kinds.
   */
  charmedInstances(): Instance[] {
    const out: Instance[] = []
    for (const list of this.activeByName.values())
      for (const i of list) if (i.charmed && i.petKind === 'charmed') out.push(i)
    return out
  }

  /** All live pets, charmed AND summoned (the attribution roster). */
  petInstances(): Instance[] {
    const p = this.probe
    if (p) p.enter(SEC_WORLD)
    const out: Instance[] = []
    for (const list of this.activeByName.values()) for (const i of list) if (i.charmed) out.push(i)
    if (p) p.leave()
    return out
  }

  /**
   * Display label for an instance in encounter views. When more than one instance
   * of a nameKey has ever been engaged, later gens get a " (N)" suffix so twins are
   * visually distinct; the first gen keeps the bare name.
   */
  label(inst: Instance): string {
    const p = this.probe
    if (!p) return this.labelInner(inst)
    p.enter(SEC_WORLD)
    const out = this.labelInner(inst)
    p.leave()
    return out
  }

  private labelInner(inst: Instance): string {
    const total = this.gens.get(inst.nameKey) ?? 1
    if (total <= 1 || inst.gen === 1) return inst.display
    return `${inst.display} (${inst.gen})`
  }
}
