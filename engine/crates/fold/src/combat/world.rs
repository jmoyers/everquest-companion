//! THE WORLD MODEL — entity-INSTANCE tracking (`src/main/combat/world.ts`).
//!
//! The engine used to key everything by bare name, which collapses same-named twins: charm one
//! `a fire giant warrior` while a hostile `a fire giant warrior` is present and the pet and the mob
//! it tanks are indistinguishable. Every spawn gets a distinct identity `<nameKey>#<gen>` instead,
//! so twins are separate entities in encounter aggregation and the charm/death lifecycle is
//! decidable rather than guessed.
//!
//! ── THE LIFECYCLE DECISION TABLE ───────────────────────────────────────────────────────────────
//!
//! Every rule is deterministic, and ambiguity is FLAGGED rather than silently resolved toward the
//! worse failure: a false pet-death drops all subsequent pet damage, so the bias is always AWAY
//! from retiring the pet.
//!
//!   see(name)     resolve an active instance, else spawn a hostile one (gen++). Same-name twins
//!                 are separated by EVIDENCE (`note_twin_evidence`), never by guesswork.
//!   charm(name)   bind a lone live hostile instance when there is no evidence of a second twin;
//!                 otherwise spawn a fresh charmed one (first-ever charm, or re-charm beside a
//!                 live twin).
//!   claim(name)   the SUMMONED half. Idempotent FIRST — a live pet of that name just refreshes,
//!                 so a claim and a later tell converge on one entity — else bind a lone hostile /
//!                 spawn. Binding a NEW summoned pet RETIRES the prior one (the single-pet
//!                 invariant; see `retire_prior_summoned`).
//!   uncharm(name) clear `charmed` on the charmed instance. It stays the SAME instance, hostile-
//!                 capable again. Does not retire.
//!   death(…)      decide WHICH instance dies; four cases, all below, all biased toward the pet.
//!   zone(ts)      retire everything except SUMMONED pets, which the real log proves follow you.
//!   staleness     a live HOSTILE unseen for `INSTANCE_STALE_MS` is retired the next time its name
//!                 is resolved, so the sighting after the gap spawns a FRESH generation. Without it
//!                 a slot is pinned live forever — death is the only other retirement, and a mob
//!                 killed off-screen (or despawned, or fled) logs NO death line, so every later
//!                 pull of that name inherited the corpse's identity, gen label and engagement
//!                 history. PETS ARE EXEMPT: a pet is bound by explicit evidence and may
//!                 legitimately stand quiet for minutes.
//!
//! ── RETIREMENT IS FINAL, AND SOMEBODY HAS TO HEAR ABOUT IT (JOS-176) ───────────────────────────
//!
//! Over there the world model calls an `onRetire` closure the engine state installs, which deletes
//! the retired instance's CC hold. A closure that reaches back into the state that owns this model
//! is not a shape Rust will accept, so the fact is QUEUED instead: `retire()` — still the one place
//! retirement is recorded — pushes the instance id onto `retired_ids`, and `EngineState` drains it
//! immediately after every call that can retire. The property the callback existed for is
//! unchanged and is the reason it must stay drained at the CALL SITE rather than lazily: the hold
//! in `Encounter.cc_active_until` claims a mez'd mob is still alive, and the moment the world model
//! retires that instance the claim is false forever, because a later sighting of the name spawns a
//! fresh `nameKey#gen` and can never redeem it. Before JOS-176 only `ingest_death` cleaned up, so a
//! mez'd mob aged out by STALENESS went on vetoing the death-close for the rest of its 120 seconds
//! (measured: 614 such retirements in the owner's whole log).

use crate::jsmap::JsMap;
use eqlog::names::{id_key, id_key_ref};
use std::collections::{HashMap, HashSet};

/// How long a LIVE hostile instance may go completely unobserved before its slot is eligible for
/// retirement. Deliberately the SAME number as the encounter layer's `PRESENCE_GONE_MS`: an
/// instance closure has already written off as "gone" is precisely the one whose identity a later
/// sighting must not inherit, so the two horizons agree by construction rather than by coincidence.
pub const INSTANCE_STALE_MS: i64 = crate::combat::encounter::PRESENCE_GONE_MS;

/// How an instance became your pet.
///
/// `Charmed` — bound by a `<mob> has been charmed.` line; cannot survive a zone.
/// `Summoned` — a class pet (random proper name) bound by a petClaim. It PERSISTS across zone
/// lines, verified in the real log: a summoned pet kept dealing damage after three zone transitions
/// with no re-summon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PetKind {
    Charmed,
    Summoned,
}

/// `entityRules.isLeftBehindOnZone` — TRUE if an entity of this kind is retired by a zone line.
/// Charmed pets and hostile mobs are left behind; summoned pets follow. `None` = a hostile mob.
pub fn is_left_behind_on_zone(kind: Option<PetKind>) -> bool {
    kind != Some(PetKind::Summoned)
}

#[derive(Debug, Clone)]
pub struct Instance {
    pub instance_id: String,
    pub name_key: String,
    pub display: String,
    pub charmed: bool,
    /// Set while `charmed` is true; distinguishes zone behaviour. `None` = hostile.
    pub pet_kind: Option<PetKind>,
    pub first_seen_ts: i64,
    pub last_seen_ts: i64,
    pub retired: bool,
    /// gen ordinal (1-based) among all instances ever spawned for this nameKey.
    pub gen: u32,
}

/// An instance resolved for ATTRIBUTION: the aggregate key, the name key the membership sets are
/// asked about, and the DISPLAY LABEL the meter row carries. The three always travel together over
/// there (`world.label(world.resolve(…))` is the idiom at every call site), so they travel together
/// here rather than handing callers an index into a model they would then have to ask again.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub instance_id: String,
    pub name_key: String,
    pub label: String,
}

/// Result of a `death()` decision, for the engine's processing line and ambiguity surfacing.
#[derive(Debug, Clone)]
pub struct DeathResolution {
    pub was_pet: bool,
    pub ambiguous: bool,
    pub reason: String,
}

#[derive(Default)]
pub struct WorldModel {
    /// THE ARENA. Every instance ever spawned, in spawn order; the indices below are handles into
    /// it. `byName` over there is the same record — "the honest record", read nowhere — and it is
    /// this vector's order restricted to a name.
    insts: Vec<Instance>,
    /// THE LIVE index, nameKey → active handles oldest→newest. Separate from the spawn history for
    /// one measured reason (JOS-59): a nameKey accumulates one instance per SPAWN and a busy zone
    /// respawns the same mob hundreds of times — `a greater kobold` alone reaches gen 38 on the
    /// owner's log — so a read that filtered the whole history allocated a copy of it, two or three
    /// times per `resolve()`, on every damage, miss, resist and heal line. Retirement is MONOTONE,
    /// so this list is spliced and never rebuilt.
    ///
    /// AN EMPTIED ENTRY IS KEPT rather than removed, so the map's INSERTION ORDER — which is the
    /// order `pet_instances()` and `charmed_instances()` report in, and therefore the order the UI
    /// lists pets in — is exactly what it was when this walked the spawn history.
    active_by_name: JsMap<Vec<usize>>,
    by_id: HashMap<String, usize>,
    /// gen counter per nameKey.
    gens: HashMap<String, u32>,
    /// Killers each charmed pet has been observed tanking (pet handle → attacker nameKeys that hit
    /// it / that it hit). Drives death case (b).
    pet_tanked_by: HashMap<usize, HashSet<String>>,
    /// THE RETIREMENT ANNOUNCEMENT QUEUE — see the module header. Drained by `EngineState` at every
    /// call site that can retire, which is what keeps it equivalent to the TS's synchronous
    /// `onRetire` callback rather than merely similar to it.
    pub retired_ids: Vec<String>,
}

impl WorldModel {
    pub fn new() -> Self {
        WorldModel::default()
    }

    pub fn reset(&mut self) {
        self.insts.clear();
        self.active_by_name.clear();
        self.by_id.clear();
        self.gens.clear();
        self.pet_tanked_by.clear();
        self.retired_ids.clear();
    }

    /// Active (non-retired) handles for a nameKey, oldest→newest.
    fn active(&self, name_key: &str) -> &[usize] {
        self.active_by_name
            .get(name_key)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    fn charmed_active(&self, name_key: &str) -> Option<usize> {
        self.active(name_key)
            .iter()
            .copied()
            .find(|&i| self.insts[i].charmed)
    }

    fn hostile_active(&self, name_key: &str) -> Option<usize> {
        self.active(name_key)
            .iter()
            .copied()
            .find(|&i| !self.insts[i].charmed)
    }

    /// Spawn a new instance. A `pet_kind` IS the charm flag: every call that spawned a charmed
    /// instance always named its kind, and every hostile spawn named none.
    fn spawn(
        &mut self,
        name_key: &str,
        display: &str,
        ts: i64,
        pet_kind: Option<PetKind>,
    ) -> usize {
        let gen = self.gens.get(name_key).copied().unwrap_or(0) + 1;
        self.gens.insert(name_key.to_string(), gen);
        let inst = Instance {
            instance_id: format!("{name_key}#{gen}"),
            name_key: name_key.to_string(),
            display: display.to_string(),
            charmed: pet_kind.is_some(),
            pet_kind,
            first_seen_ts: ts,
            last_seen_ts: ts,
            retired: false,
            gen,
        };
        let at = self.insts.len();
        self.by_id.insert(inst.instance_id.clone(), at);
        self.insts.push(inst);
        match self.active_by_name.get_mut(name_key) {
            Some(live) => live.push(at),
            None => self.active_by_name.insert(name_key.to_string(), vec![at]),
        }
        at
    }

    /// Adopt a fresher raw sighting as an instance's DISPLAY name — but never let EQ's
    /// sentence-casing overwrite the spawn's true name.
    ///
    /// EQ capitalizes a lowercase-article mob name whenever the name opens a sentence, so ONE spawn
    /// is printed two ways: mid-sentence it carries its real name (`You slash a zol ghoul knight
    /// …`), sentence-initial it is capitalized (`A zol ghoul knight resisted …`). Resist lines and
    /// incoming melee are ALWAYS sentence-initial; outgoing damage is always mid-sentence.
    ///
    /// THE RULE: a lowercase-initial sighting can only have come from mid-sentence, so it is the
    /// spawn's true name and always wins. A capital-initial sighting may be either, so it may only
    /// overwrite another capital-initial display. Proper names ("Kahaptra Z`Taj", players, summoned
    /// pets) have no lowercase variant and keep the old latest-wins behaviour exactly.
    ///
    /// Adopting the latest sighting unconditionally is what made one mob read as two rows in the
    /// per-mob timeline (which groups by the RAW target string): `a zol ghoul knight (230)` with
    /// all the damage and `A zol ghoul knight (230)` carrying a lone resist.
    fn adopt_display(&mut self, at: usize, name: &str) {
        if self.insts[at].display == name {
            return;
        }
        if id_key_ref(&self.insts[at].display) != id_key_ref(name) {
            return; // never relabel across identities
        }
        // `/^[a-z]/` is ASCII-only in JS, so this is `is_ascii_lowercase` and not `is_lowercase`.
        let incoming_lower = name.chars().next().is_some_and(|c| c.is_ascii_lowercase());
        let current_lower = self.insts[at]
            .display
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase());
        if incoming_lower || !current_lower {
            self.insts[at].display = name.to_string();
        }
    }

    /// Resolve a raw name to a live instance for attribution, spawning a hostile one if none is
    /// active. `prefer_charmed` picks the charmed pet when both a pet and a hostile twin are live
    /// and the caller knows this reference is the pet (e.g. the pet as damage attacker); otherwise
    /// a hostile instance is preferred (mob references).
    pub fn resolve(&mut self, name: &str, ts: i64, prefer_charmed: bool) -> Resolved {
        // BORROWED (JOS-506): every use below is a lookup or a comparison, and the two callers on
        // the damage path reach this twice per attributed line.
        let key = id_key_ref(name);
        if key == "you" {
            // 'you' is not modeled as a spawnable instance; every caller special-cases it first.
            // The synthetic sentinel is returned so none of them can crash on a `None`.
            return Resolved {
                instance_id: "you".to_string(),
                name_key: "you".to_string(),
                label: "You".to_string(),
            };
        }
        self.retire_stale(&key, ts);
        let Some(oldest) = self.active(&key).first().copied() else {
            let at = self.spawn(&key, name, ts, None);
            return self.resolved(at);
        };
        let at = if prefer_charmed {
            self.charmed_active(&key)
                .or_else(|| self.hostile_active(&key))
                .unwrap_or(oldest)
        } else {
            self.hostile_active(&key).unwrap_or(oldest)
        };
        self.insts[at].last_seen_ts = ts;
        self.adopt_display(at, name);
        self.resolved(at)
    }

    /// PER-INSTANCE STALENESS (see the header). Retire every live HOSTILE instance of `name_key`
    /// that has gone `INSTANCE_STALE_MS` without a single observation, so the caller's sighting
    /// spawns a fresh generation instead of reviving a mob nobody has seen.
    ///
    /// Twin-safe: it walks the whole active list, so a pull where one twin died off-screen and the
    /// other is still swinging retires only the silent one. And because pets are skipped,
    /// `note_twin_evidence`'s pet-plus-hostile pairing is untouched — the hostile half it spawns is
    /// refreshed by the very damage that proved it exists.
    fn retire_stale(&mut self, name_key: &str, ts: i64) {
        // BACKWARDS BY INDEX: `retire()` splices this very array, and a forward walk would skip the
        // element that slid into the hole. Every instance here is by definition unretired.
        let mut i = match self.active_by_name.get(name_key) {
            Some(live) => live.len(),
            None => return,
        };
        while i > 0 {
            i -= 1;
            let at = match self.active_by_name.get(name_key) {
                Some(live) if i < live.len() => live[i],
                _ => continue,
            };
            if self.insts[at].charmed {
                continue;
            }
            if ts - self.insts[at].last_seen_ts >= INSTANCE_STALE_MS {
                self.retire(at, ts);
            }
        }
    }

    /// Record that `name` was observed at `ts` WITHOUT resolving or spawning anything — the
    /// world-model half of the encounter's PRESENCE axis (misses, resists, CC, heals). It only
    /// refreshes instances that already exist, so a whiff at a mob we have never damaged still has
    /// zero world-model side effects (law 8, the same guarantee `note_presence` makes).
    pub fn note_seen(&mut self, name: &str, ts: i64) {
        let key = id_key_ref(name);
        let live: Vec<usize> = match self.active_by_name.get(key.as_ref()) {
            Some(l) => l.clone(),
            None => return,
        };
        for at in live {
            if ts > self.insts[at].last_seen_ts {
                self.insts[at].last_seen_ts = ts;
            }
        }
    }

    /// The charmed pet instance for a name (attribution helper). No staleness sweep — pets are
    /// exempt from it, so there is nothing for one to do here.
    pub fn pet_instance(&self, name: &str) -> Option<Resolved> {
        self.charmed_active(&id_key_ref(name))
            .map(|at| self.resolved(at))
    }

    /// `charm(name)` — produce the charmed pet instance (decision table, row 2).
    pub fn charm(&mut self, name: &str, ts: i64) -> Resolved {
        let key = id_key(name);
        // A slot nobody has seen for INSTANCE_STALE_MS is not the mob we just charmed.
        self.retire_stale(&key, ts);
        // Bind an existing lone hostile only when there is exactly ONE active instance and it is
        // not already charmed — i.e. no evidence of a second twin yet.
        let act: Vec<usize> = self.active(&key).to_vec();
        let hostiles: Vec<usize> = act
            .iter()
            .copied()
            .filter(|&i| !self.insts[i].charmed)
            .collect();
        if self.charmed_active(&key).is_none() && hostiles.len() == 1 && act.len() == 1 {
            let at = hostiles[0];
            self.insts[at].charmed = true;
            self.insts[at].pet_kind = Some(PetKind::Charmed);
            self.insts[at].last_seen_ts = ts;
            self.pet_tanked_by.insert(at, HashSet::new());
            return self.resolved(at);
        }
        let at = self.spawn(&key, name, ts, Some(PetKind::Charmed));
        self.pet_tanked_by.insert(at, HashSet::new());
        self.resolved(at)
    }

    /// `claim(name)` — mark a SUMMONED pet. IDEMPOTENT FIRST, and that ordering is load-bearing:
    /// a pet re-tells you every few seconds, so the same pet's repeat tells resolve to the same
    /// live instance and never reach the succession below.
    pub fn claim(&mut self, name: &str, ts: i64) -> Resolved {
        let key = id_key(name);
        self.retire_stale(&key, ts);
        if let Some(at) = self.charmed_active(&key) {
            self.insts[at].last_seen_ts = ts;
            return self.resolved(at);
        }
        let act: Vec<usize> = self.active(&key).to_vec();
        let hostiles: Vec<usize> = act
            .iter()
            .copied()
            .filter(|&i| !self.insts[i].charmed)
            .collect();
        let at = if hostiles.len() == 1 && act.len() == 1 {
            let at = hostiles[0];
            self.insts[at].charmed = true;
            self.insts[at].pet_kind = Some(PetKind::Summoned);
            self.insts[at].last_seen_ts = ts;
            at
        } else {
            self.spawn(&key, name, ts, Some(PetKind::Summoned))
        };
        self.pet_tanked_by.insert(at, HashSet::new());
        self.retire_prior_summoned(at, ts);
        self.resolved(at)
    }

    /// THE SINGLE-PET INVARIANT, for summoned pets (world-model law 4; JOS-54).
    ///
    /// You get one class pet. Re-summoning despawns the one you had — the game prints NOTHING when
    /// it happens (no death line, no fade, no tell), so the successor's own claim tell is the only
    /// evidence that ever arrives. MEASURED on the owner's whole log (1.40M lines, 3,175 claim
    /// tells): without this the replay ended with TWENTY-THREE live summoned pets, every animation
    /// from Jul 19 to Aug 06 still attributing.
    ///
    /// RETIREMENT, NOT DELETION. The old pet keeps its instance and everything already attributed
    /// to it — aggregates key by instanceId, so its rows and its history are exactly as they were.
    /// What ends is its FUTURE. AND IT COSTS NOTHING: over the whole log the invariant fires 23
    /// times and the pet it retires lands ZERO further damage lines, ever.
    ///
    /// SUMMONED ONLY, and that restraint is measured. 344 charm binds land while a summoned pet is
    /// flagged live, but exactly FOUR have both entities swinging within five minutes, and in all
    /// four the "summoned" side is an article-named MOB that reached here by its own tell. So the
    /// log contains NO case of a proper-named class pet and a charmed pet demonstrably alive
    /// together — an unobserved shape, which the awaiting-sample law says does not get a rule
    /// invented for it, least of all one whose failure mode is deleting a live pet's damage.
    fn retire_prior_summoned(&mut self, pet: usize, ts: i64) {
        let keys: Vec<String> = self
            .active_by_name
            .iter()
            .map(|(k, _)| k.to_string())
            .collect();
        for key in keys {
            // Backwards by index, for the reason `retire_stale` states: `retire()` splices these.
            let mut i = match self.active_by_name.get(&key) {
                Some(live) => live.len(),
                None => continue,
            };
            while i > 0 {
                i -= 1;
                let at = match self.active_by_name.get(&key) {
                    Some(live) if i < live.len() => live[i],
                    _ => continue,
                };
                let inst = &self.insts[at];
                if !inst.charmed || inst.pet_kind != Some(PetKind::Summoned) || at == pet {
                    continue;
                }
                self.retire(at, ts);
            }
        }
    }

    /// `uncharm(name)` — clear the charmed flag on the pet instance (the SAME instance). Summoned
    /// pets are never un-charmed by a worn-off charm-spell line (they carry proper names, not the
    /// charmed mob's), so this is a no-op for them.
    pub fn uncharm(&mut self, name: &str, ts: i64) -> Option<Resolved> {
        let at = self.charmed_active(&id_key(name))?;
        if self.insts[at].pet_kind == Some(PetKind::Summoned) {
            return None;
        }
        self.insts[at].charmed = false;
        self.insts[at].pet_kind = None;
        self.insts[at].last_seen_ts = ts;
        Some(self.resolved(at))
    }

    /// Record evidence that a hostile twin of `name` co-exists with a charmed pet of the same name:
    /// ensure a second active hostile instance exists. Called on You→charmed-name damage and on
    /// name→name damage.
    pub fn note_twin_evidence(&mut self, name: &str, ts: i64) {
        let key = id_key(name);
        if self.charmed_active(&key).is_none() {
            return; // only meaningful while a pet is live
        }
        if self.hostile_active(&key).is_none() {
            self.spawn(&key, name, ts, None);
        }
    }

    /// Note that a charmed pet is trading blows with a killer of nameKey `other_key`. Drives death
    /// case (b): if that killer later "slays" the name and the pet was tanking it, the pet died.
    pub fn note_pet_engagement(&mut self, pet_name: &str, other_key: &str) {
        let Some(at) = self.charmed_active(&id_key(pet_name)) else {
            return;
        };
        self.pet_tanked_by
            .entry(at)
            .or_default()
            .insert(other_key.to_string());
    }

    /// `death(name, killerKey)` — decide which instance retires.
    pub fn death(&mut self, name: &str, ts: i64, killer_key: Option<&str>) -> DeathResolution {
        let key = id_key(name);
        let act: Vec<usize> = self.active(&key).to_vec();
        if act.is_empty() {
            return DeathResolution {
                was_pet: false,
                ambiguous: false,
                reason: "no active instance".to_string(),
            };
        }
        let pet = self.charmed_active(&key);
        let hostile = self.hostile_active(&key);

        // Case 1: no charmed instance — plain hostile death.
        let Some(pet) = pet else {
            let victim = hostile.unwrap_or(act[0]);
            self.retire(victim, ts);
            return DeathResolution {
                was_pet: false,
                ambiguous: false,
                reason: "plain hostile death".to_string(),
            };
        };

        // Case 2a: the killer is You. The pet cannot be slain BY you; a hostile twin died.
        if killer_key == Some("you") {
            if let Some(hostile) = hostile {
                self.retire(hostile, ts);
                return DeathResolution {
                    was_pet: false,
                    ambiguous: false,
                    reason: "you slew hostile twin".to_string(),
                };
            }
            // Only the pet is live and the game says you slew it — charm broke this tick and then
            // you killed it. Rare, and deterministic.
            self.retire(pet, ts);
            return DeathResolution {
                was_pet: true,
                ambiguous: false,
                reason: "you slew pet (charm-break race)".to_string(),
            };
        }

        // Case 2b: the killer is a DIFFERENT name (e.g. a fire giant wizard).
        if let Some(kk) = killer_key {
            if kk != key {
                return self.death_by_foreign_killer(&key, name, ts, pet, hostile, kk);
            }
        }

        // Case 2c: the killer is the SAME name — pet↔twin, genuinely ambiguous.
        if let Some(hostile) = hostile {
            self.retire(hostile, ts);
            return DeathResolution {
                was_pet: false,
                ambiguous: true,
                reason: "ambiguous same-name death; kept pet, retired twin".to_string(),
            };
        }
        self.retire(pet, ts);
        DeathResolution {
            was_pet: true,
            ambiguous: true,
            reason: "ambiguous same-name death; only pet live → pet died".to_string(),
        }
    }

    /// `death()` case 2b: a charmed pet of `name` is live and the killer is a DIFFERENT name, so
    /// that killer was fighting SOMETHING named `name`. The bias is always AWAY from retiring the
    /// pet, which is why the twin is preferred and, when no twin exists, a twin SLOT is spawned and
    /// retired rather than the pet.
    fn death_by_foreign_killer(
        &mut self,
        key: &str,
        name: &str,
        ts: i64,
        pet: usize,
        hostile: Option<usize>,
        kk: &str,
    ) -> DeathResolution {
        let pet_tanked = self.pet_tanked_by.get(&pet).is_some_and(|s| s.contains(kk));
        if pet_tanked && hostile.is_none() {
            self.retire(pet, ts);
            return DeathResolution {
                was_pet: true,
                ambiguous: false,
                reason: format!("pet slain by {kk} it was tanking"),
            };
        }
        if let Some(hostile) = hostile {
            self.retire(hostile, ts);
            return DeathResolution {
                was_pet: false,
                ambiguous: pet_tanked,
                reason: if pet_tanked {
                    format!("ambiguous: pet also tanked {kk}; kept pet, retired twin")
                } else {
                    format!("hostile twin slain by {kk}")
                },
            };
        }
        // No hostile twin AND no evidence the pet tanked this killer: the killer was fighting a
        // same-named mob we had not separately instanced. Spawn+retire a hostile twin slot; keep
        // the pet, flag ambiguity — never silently kill the pet.
        let ghost = self.spawn(key, name, ts, None);
        self.retire(ghost, ts);
        DeathResolution {
            was_pet: false,
            ambiguous: true,
            reason: format!("ambiguous: {kk} slew a {name}; kept pet"),
        }
    }

    /// THE ONE PLACE RETIREMENT IS RECORDED. Everything above funnels through it, which is what
    /// makes the announcement queue (module header) complete rather than best-effort.
    fn retire(&mut self, at: usize, ts: i64) {
        {
            let inst = &mut self.insts[at];
            inst.retired = true;
            inst.last_seen_ts = ts;
            inst.charmed = false;
            inst.pet_kind = None;
        }
        self.pet_tanked_by.remove(&at);
        let name_key = self.insts[at].name_key.clone();
        if let Some(live) = self.active_by_name.get_mut(&name_key) {
            if let Some(pos) = live.iter().position(|&i| i == at) {
                live.remove(pos);
            }
        }
        let id = self.insts[at].instance_id.clone();
        self.retired_ids.push(id);
    }

    /// `zone(ts)` — retire everything EXCEPT summoned pets. Charm cannot survive a zone and hostile
    /// mobs do not follow you; summoned class pets do (real-log verified). Returns the survivors so
    /// the engine can rebuild its pet-name index from them.
    pub fn zone(&mut self, ts: i64) -> Vec<Resolved> {
        let mut survivors = Vec::new();
        let keys: Vec<String> = self
            .active_by_name
            .iter()
            .map(|(k, _)| k.to_string())
            .collect();
        for key in keys {
            // A COPY, not the live list: `retire()` splices it, and unlike `retire_stale` this loop
            // must stay FORWARD — the survivors it returns are rendered in this order. Zone lines
            // are rare, so the copy costs nothing measurable.
            let list: Vec<usize> = self.active_by_name.get(&key).cloned().unwrap_or_default();
            for at in list {
                let inst = &self.insts[at];
                let kind = if inst.charmed { inst.pet_kind } else { None };
                if inst.charmed && !is_left_behind_on_zone(kind) {
                    self.insts[at].last_seen_ts = ts;
                    survivors.push(self.resolved(at));
                } else {
                    self.retire(at, ts);
                }
            }
        }
        survivors
    }

    /// True if the instance with this id has been retired (dead/zoned). Unknown ids — never spawned
    /// — are treated as RETIRED: they cannot be a live engagement.
    pub fn is_retired(&self, instance_id: &str) -> bool {
        match self.by_id.get(instance_id) {
            Some(&at) => self.insts[at].retired,
            None => true,
        }
    }

    /// True if the instance is currently your (live, non-retired) charmed/summoned pet. Such an
    /// instance is never a hostile we are trying to kill, so it must NOT block an encounter's
    /// death-close — a charmed pet never dies, and would pin every charm-grind fight open forever.
    pub fn is_live_pet(&self, instance_id: &str) -> bool {
        self.by_id
            .get(instance_id)
            .is_some_and(|&at| !self.insts[at].retired && self.insts[at].charmed)
    }

    /// The GENUINELY-CHARMED live pets — mobs bound by a `<mob> has been charmed.` line. A summoned
    /// class pet is a pet but is NOT charmed, so it is excluded here by `pet_kind`. This is the ONLY
    /// honest source for a charm roster; the engine's pet-name set is attribution-only and holds
    /// both kinds.
    pub fn charmed_instances(&self) -> Vec<Resolved> {
        self.walk_pets(|k| k == Some(PetKind::Charmed))
    }

    /// All live pets, charmed AND summoned — the attribution roster.
    pub fn pet_instances(&self) -> Vec<Resolved> {
        self.walk_pets(|_| true)
    }

    fn walk_pets(&self, want: fn(Option<PetKind>) -> bool) -> Vec<Resolved> {
        let mut out = Vec::new();
        for (_, list) in self.active_by_name.iter() {
            for &at in list {
                let inst = &self.insts[at];
                if inst.charmed && want(inst.pet_kind) {
                    out.push(self.resolved(at));
                }
            }
        }
        out
    }

    /// The display name of every live pet, in the order `pet_instances` reports.
    pub fn pet_name_keys(&self) -> Vec<String> {
        self.pet_instances()
            .into_iter()
            .map(|r| r.name_key)
            .collect()
    }

    /// Display label for an instance in encounter views. When more than one instance of a nameKey
    /// has EVER been spawned, later gens get a ` (N)` suffix so twins are visually distinct; the
    /// first gen keeps the bare name.
    fn resolved(&self, at: usize) -> Resolved {
        let inst = &self.insts[at];
        let total = self.gens.get(&inst.name_key).copied().unwrap_or(1);
        let label = if total <= 1 || inst.gen == 1 {
            inst.display.clone()
        } else {
            format!("{} ({})", inst.display, inst.gen)
        };
        Resolved {
            instance_id: inst.instance_id.clone(),
            name_key: inst.name_key.clone(),
            label,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_spawn_of_a_name_labels_itself_and_the_first_keeps_the_bare_name() {
        let mut w = WorldModel::new();
        let a = w.resolve("a spite golem", 1_000, false);
        assert_eq!(a.instance_id, "a spite golem#1");
        assert_eq!(a.label, "a spite golem");
        // Only a fresh SPAWN mints a gen — a second sighting inside the staleness window is the
        // same mob.
        let again = w.resolve("a spite golem", 2_000, false);
        assert_eq!(again.instance_id, "a spite golem#1");
        // …and past it, the slot is retired and the sighting spawns gen 2, which now labels itself.
        let b = w.resolve("a spite golem", 2_000 + INSTANCE_STALE_MS, false);
        assert_eq!(b.instance_id, "a spite golem#2");
        assert_eq!(b.label, "a spite golem (2)");
    }

    /// EQ's sentence-capitalization can never overwrite the spawn's true lowercase-article name.
    #[test]
    fn sentence_casing_never_overwrites_the_true_name() {
        let mut w = WorldModel::new();
        // First sighting is sentence-initial, so the spawn takes it verbatim…
        assert_eq!(
            w.resolve("A zol ghoul knight", 1, false).label,
            "A zol ghoul knight"
        );
        // …the first mid-sentence sighting flips it to canonical…
        assert_eq!(
            w.resolve("a zol ghoul knight", 2, false).label,
            "a zol ghoul knight"
        );
        // …and pins it there.
        assert_eq!(
            w.resolve("A zol ghoul knight", 3, false).label,
            "a zol ghoul knight"
        );
    }

    /// A PET IS EXEMPT FROM STALENESS — it is bound by explicit evidence and may legitimately stand
    /// quiet for minutes; only death, uncharm and zone retire one.
    #[test]
    fn a_pet_never_ages_out_but_a_hostile_twin_does() {
        let mut w = WorldModel::new();
        let pet = w.charm("a fire giant warrior", 0);
        w.note_twin_evidence("a fire giant warrior", 0);
        let late = 10 * INSTANCE_STALE_MS;
        w.resolve("a fire giant warrior", late, false);
        assert!(w.is_live_pet(&pet.instance_id));
        // The silent twin was retired and the sighting spawned a fresh generation.
        assert!(w.is_retired("a fire giant warrior#2"));
    }

    /// THE SINGLE-PET INVARIANT: claiming a new summoned pet retires the one you had.
    #[test]
    fn a_new_summoned_pet_retires_the_prior_one() {
        let mut w = WorldModel::new();
        let first = w.claim("Jaber", 0);
        let second = w.claim("Gonekn", 1_000);
        assert!(w.is_retired(&first.instance_id));
        assert!(w.is_live_pet(&second.instance_id));
        // A CHARMED pet is untouched — the two kinds demonstrably co-exist.
        let charmed = w.charm("a rock golem", 2_000);
        w.claim("Vebarn", 3_000);
        assert!(w.is_live_pet(&charmed.instance_id));
    }

    /// A repeat tell from the SAME pet converges on one entity and never reaches the succession.
    #[test]
    fn repeat_claims_from_one_pet_are_idempotent() {
        let mut w = WorldModel::new();
        let a = w.claim("Jaber", 0);
        let b = w.claim("Jaber", 5_000);
        assert_eq!(a.instance_id, b.instance_id);
        assert!(!w.is_retired(&a.instance_id));
    }

    /// The bias is always AWAY from the pet: a foreign killer with no twin spawns and retires a
    /// GHOST slot rather than killing the pet.
    #[test]
    fn a_foreign_killer_with_no_twin_retires_a_ghost_and_keeps_the_pet() {
        let mut w = WorldModel::new();
        let pet = w.charm("a fire giant warrior", 0);
        let res = w.death("a fire giant warrior", 1_000, Some("a fire giant wizard"));
        assert!(!res.was_pet);
        assert!(res.ambiguous);
        assert!(w.is_live_pet(&pet.instance_id));
    }

    /// …and the one case where the pet really does die: the same-named killer with nothing else
    /// live.
    #[test]
    fn a_same_named_death_with_only_the_pet_live_is_a_real_pet_death() {
        let mut w = WorldModel::new();
        let pet = w.charm("a fire giant warrior", 0);
        let res = w.death("a fire giant warrior", 1_000, Some("a fire giant warrior"));
        assert!(res.was_pet);
        assert!(res.ambiguous);
        assert!(w.is_retired(&pet.instance_id));
    }

    /// Only a SUMMONED pet walks through the door with you.
    #[test]
    fn a_zone_keeps_the_summoned_pet_and_leaves_everything_else() {
        let mut w = WorldModel::new();
        let charmed = w.charm("a rock golem", 0);
        let summoned = w.claim("Vebarn", 0);
        let mob = w.resolve("a spite golem", 0, false);
        let survivors = w.zone(1_000);
        assert_eq!(survivors.len(), 1);
        assert_eq!(survivors[0].instance_id, summoned.instance_id);
        assert!(w.is_retired(&charmed.instance_id));
        assert!(w.is_retired(&mob.instance_id));
    }

    /// Every retirement path announces itself exactly once, through the one recorder.
    #[test]
    fn every_retirement_is_announced_once() {
        let mut w = WorldModel::new();
        w.resolve("a spite golem", 0, false);
        w.death("a spite golem", 10, None);
        assert_eq!(w.retired_ids, vec!["a spite golem#1".to_string()]);
        w.retired_ids.clear();
        w.resolve("a bat", 0, false);
        w.zone(20);
        assert_eq!(w.retired_ids, vec!["a bat#1".to_string()]);
    }

    /// An id nothing ever spawned is RETIRED, not live — it cannot be a live engagement.
    #[test]
    fn an_unknown_instance_id_is_retired() {
        let w = WorldModel::new();
        assert!(w.is_retired("nobody#1"));
        assert!(!w.is_live_pet("nobody#1"));
    }
}
