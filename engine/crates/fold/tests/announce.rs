//! Which modules announce, and on what — the under-announce proof, per module.
//!
//! Over-announcing on a real subset is honest; under-announcing loses UI updates and is the one
//! failure direction not allowed. A test that only checked the silence half would be satisfied by a
//! module that never announces at all, so every migrated module gets both claims: one representative
//! mutating event per arm family moves its cursor, and a line that is none of its business does not.
//!
//! The instrument is `Registry::published_seqs`, which is what `Serving::changed_modules` reads on
//! the serve beat — so this is the dirty bit itself, asked one event at a time.
//!
//! The input is JSON events rather than log lines, because a claim about what one arm does needs an
//! event whose every field is known. `engined`'s `tests/live_surfaces.rs` makes the same claim from
//! the other end, over a real socket with real EQ lines.

use fold::event::Event;
use fold::{registered, ClusterDeps, Fold};
use std::collections::BTreeMap;

/// A fold, one event at a time, reporting who announced.
struct Probe {
    fold: Fold,
    seen: BTreeMap<&'static str, i64>,
}

impl Probe {
    fn new() -> Self {
        // `launch_ms` at i64::MAX is the fold suite's own construction: no line is after the launch
        // anchor, so the epoch detector synthesizes nothing and every announce in this file is the
        // work of the event named beside it.
        let mut p = Probe {
            fold: Fold::new(registered(ClusterDeps::default()), i64::MAX),
            seen: BTreeMap::new(),
        };
        // The construction's own cursors are not this file's subject — take them once so the first
        // asserted line reports only itself.
        p.moved();
        p
    }

    /// Fold one event and answer with the ids whose announce cursor moved — `changed_modules`.
    fn fold(&mut self, line: &str) -> Vec<&'static str> {
        let ev = Event::from_json(line).expect("a JSON event");
        self.fold.on_primary(&ev, true);
        self.moved()
    }

    /// The wall-clock heartbeat, for the modules whose published state ages without a line.
    fn tick(&mut self, now_ms: i64) -> Vec<&'static str> {
        self.fold.tick(now_ms);
        self.moved()
    }

    fn moved(&mut self) -> Vec<&'static str> {
        let mut out = Vec::new();
        for (id, seq) in self.fold.registry.published_seqs() {
            if self.seen.insert(id, seq) != Some(seq) {
                out.push(id);
            }
        }
        out.sort_unstable();
        out
    }
}

/// Every migrated module, so a claim about "nothing else moved" is a claim about a named set rather
/// than about whatever happened to be registered.
const MIGRATED: [&str; 15] = [
    "alerts",
    "buffs",
    "classUnlocks",
    "consider",
    "eventFeed",
    "itemTiers",
    "kills",
    "leveling",
    "loot",
    "observedSpellRanks",
    "outputFiles",
    "progression",
    "roster",
    "spellSets",
    "turnins",
];

/// Assert exactly which of the migrated modules announced. Modules outside `MIGRATED` are ignored,
/// since pinning them would fail for a reason that has nothing to do with what this checks.
#[track_caller]
fn announced(moved: &[&'static str], want: &[&str]) {
    let mut got: Vec<&str> = moved
        .iter()
        .copied()
        .filter(|id| MIGRATED.contains(id))
        .collect();
    got.sort_unstable();
    let mut want: Vec<&str> = want.to_vec();
    want.sort_unstable();
    assert_eq!(got, want);
}

/// A pure melee round, the busiest thing a log does. None of the fifteen modules has anything to say
/// about it except the ones that watch combat.
const MELEE_HIT: &str = r#"{"kind":"damage","seq":10,"ts":10000,"raw":"h","source":"Primitive","target":"a fire giant","amount":42,"dtype":"melee","skill":"slash"}"#;
const MELEE_MISS: &str = r#"{"kind":"miss","seq":11,"ts":10500,"raw":"m","source":"a fire giant","target":"Primitive","skill":"kick"}"#;

/// What still announces on a melee round.
///
/// `progression` is the one left, and honestly so: its published `lastTs` really does advance on a
/// melee line carrying a newer timestamp, and the zone-band chart draws the open interval's right
/// edge from that number. Its migration bought one announce per log second of combat instead of
/// dozens — measured in its own test below.
const STILL_LOUD: [&str; 1] = ["progression"];

#[test]
fn a_melee_round_moves_nothing_that_does_not_watch_combat() {
    let mut p = Probe::new();
    let first = p.fold(MELEE_HIT);
    announced(&first, &STILL_LOUD);
    let second = p.fold(MELEE_MISS);
    announced(&second, &STILL_LOUD);
}

#[test]
fn loot_announces_on_the_line_that_moves_its_ledger_and_on_nothing_else() {
    let mut p = Probe::new();
    // A zone line is the module's own bookkeeping: it decides what label the next row carries and
    // changes not one byte of the published ledger.
    let zoned = p.fold(r#"{"kind":"zone","seq":1,"ts":1000,"raw":"z","zone":"Nagafen's Lair"}"#);
    assert!(
        !zoned.contains(&"loot"),
        "a zone line is not a ledger change"
    );
    // The row.
    let looted = p.fold(
        r#"{"kind":"loot","seq":2,"ts":2000,"raw":"l","item":"Bone Chips","source":"a corpse"}"#,
    );
    assert!(looted.contains(&"loot"));
    // …and a line that is nobody's loot leaves it exactly where it was.
    let after = p.fold(MELEE_HIT);
    assert!(!after.contains(&"loot"));
    // The epoch arm is a change: clearing the ledger is what a panel most needs to hear about, and a
    // module that announced only on growth would leave a dead character's rows up.
    let reborn = p.fold(r#"{"kind":"epoch","seq":3,"ts":3000,"raw":"e"}"#);
    assert!(reborn.contains(&"loot"));
}

#[test]
fn turnins_announces_on_the_trade_that_closes_a_group_and_not_on_the_offer() {
    let mut p = Probe::new();
    // Handing over two items publishes nothing: the group is pending and pending is not state.
    let first = p.fold(
        r#"{"kind":"offer","seq":1,"ts":1000,"raw":"o","item":"Bone Chips","npc":"Kizdean Gix"}"#,
    );
    assert!(!first.contains(&"turnins"));
    let second = p.fold(
        r#"{"kind":"offer","seq":2,"ts":1100,"raw":"o","item":"Bone Chips","npc":"Kizdean Gix"}"#,
    );
    assert!(!second.contains(&"turnins"));
    // The trade closes it, and that is the row.
    let traded = p.fold(r#"{"kind":"trade","seq":3,"ts":1200,"raw":"t","npc":"Kizdean Gix"}"#);
    assert!(traded.contains(&"turnins"));
    // A trade with nothing pending records nothing and says nothing.
    let empty = p.fold(r#"{"kind":"trade","seq":4,"ts":1300,"raw":"t","npc":"Kizdean Gix"}"#);
    assert!(!empty.contains(&"turnins"));
}

#[test]
fn class_unlocks_announces_the_first_sighting_of_a_class_and_not_the_second() {
    let mut p = Probe::new();
    let first =
        p.fold(r#"{"kind":"classUnlock","seq":1,"ts":1000,"raw":"c","className":"Shadow Knight"}"#);
    assert!(first.contains(&"classUnlocks"));
    // The same class in the other casing folds to the same key and is dropped by the dedupe — so
    // the published list did not move and neither does the cursor.
    let again =
        p.fold(r#"{"kind":"classUnlock","seq":2,"ts":1100,"raw":"c","className":"shadow knight"}"#);
    assert!(!again.contains(&"classUnlocks"));
}

#[test]
fn leveling_announces_on_every_arm_that_appends_and_on_nothing_between_them() {
    let mut p = Probe::new();
    for (seq, line) in [
        r#"{"kind":"level","seq":1,"ts":1000,"raw":"v","level":26}"#,
        r#"{"kind":"aaGain","seq":2,"ts":2000,"raw":"a","amount":1,"nowHave":3}"#,
        r#"{"kind":"aaSpend","seq":3,"ts":3000,"raw":"s","ability":"Natural Durability","cost":1,"rank":1}"#,
        r#"{"kind":"aaPotion","seq":4,"ts":4000,"raw":"p"}"#,
        r#"{"kind":"epoch","seq":5,"ts":5000,"raw":"e"}"#,
    ]
    .iter()
    .enumerate()
    {
        assert!(
            p.fold(line).contains(&"leveling"),
            "arm {seq} should announce: {line}"
        );
    }
    // …and the melee round the panel was re-fetching its whole history for.
    assert!(!p.fold(MELEE_HIT).contains(&"leveling"));
}

#[test]
fn kills_announces_the_counted_kill_and_not_the_zone_or_the_experience_that_set_it_up() {
    let mut p = Probe::new();
    // Both of these mutate state — the tier label and the parked experience stamp — and neither is
    // published.
    let zoned = p.fold(r#"{"kind":"zone","seq":1,"ts":1000,"raw":"z","zone":"Permafrost Keep"}"#);
    assert!(!zoned.contains(&"kills"));
    let exp = p.fold(r#"{"kind":"expGain","seq":2,"ts":2000,"raw":"e","party":false}"#);
    assert!(!exp.contains(&"kills"));
    let slain = p.fold(
        r#"{"kind":"death","seq":3,"ts":2001,"raw":"d","name":"a froglok ton knight","bySelf":true}"#,
    );
    assert!(slain.contains(&"kills"));
    // A kill somebody else landed is not a counted kill: the map does not move.
    let theirs = p.fold(
        r#"{"kind":"death","seq":4,"ts":3000,"raw":"d","name":"a froglok","bySelf":false,"killer":"You"}"#,
    );
    assert!(!theirs.contains(&"kills"));
}

#[test]
fn output_files_announces_a_newer_dump_and_not_a_restatement_of_an_older_one() {
    let mut p = Probe::new();
    let wrote =
        p.fold(r#"{"kind":"outputFile","seq":1,"ts":5000,"raw":"o","file":"Inventory.txt"}"#);
    assert!(wrote.contains(&"outputFiles"));
    // An older stamp for the same file is refused by the map, and so by the cursor.
    let older = p.fold(
        r#"{"kind":"outputFile","seq":2,"ts":4000,"raw":"o","file":"C:\\EQ\\inventory.txt"}"#,
    );
    assert!(!older.contains(&"outputFiles"));
    let newer =
        p.fold(r#"{"kind":"outputFile","seq":3,"ts":6000,"raw":"o","file":"Inventory.txt"}"#);
    assert!(newer.contains(&"outputFiles"));
}

#[test]
fn roster_announces_a_group_line_and_not_the_party_experience_that_gates_it() {
    let mut p = Probe::new();
    // The party-experience line opens the gate the weakest membership rung is admitted through. It
    // names nobody, never sets `seen`, and publishes nothing.
    let party = p.fold(r#"{"kind":"expGain","seq":1,"ts":1000,"raw":"e","party":true}"#);
    assert!(!party.contains(&"roster"));
    // Every group line is published: even an invite, which is usually declined, sets `seen` and
    // `lastSignalTs` — and both are in the snapshot.
    let invited =
        p.fold(r#"{"kind":"group","seq":2,"ts":2000,"raw":"g","change":"invite","name":"Dranix"}"#);
    assert!(invited.contains(&"roster"));
    let joined =
        p.fold(r#"{"kind":"group","seq":3,"ts":3000,"raw":"g","change":"join","name":"Dranix"}"#);
    assert!(joined.contains(&"roster"));
    // A charm refuses a name for the weakest rung — knowledge about a name, published nowhere, and
    // nothing this one evicts because no `buffed` member answers to it.
    let charmed =
        p.fold(r#"{"kind":"charm","seq":4,"ts":4000,"raw":"c","mob":"a spiroc banisher"}"#);
    assert!(!charmed.contains(&"roster"));
}

#[test]
fn consider_announces_the_con_and_not_the_loot_it_files_away() {
    let mut p = Probe::new();
    let conned = p.fold(
        r#"{"kind":"consider","seq":1,"ts":1000,"raw":"c","mob":"a goblin priest","rare":false,"level":20,"faction":"indifferent","difficulty":"???"}"#,
    );
    assert!(conned.contains(&"consider"));
    // The own-loot index is not published: it reaches a client through `knowledge.mob`'s
    // `dropsSeen`, a join made on demand, so a farming session's loot lines move this module's real
    // state and say nothing.
    let looted = p.fold(
        r#"{"kind":"loot","seq":2,"ts":2000,"raw":"l","item":"Bone Chips","source":"a goblin priest"}"#,
    );
    assert!(!looted.contains(&"consider"));
    // The zone is the label the next row carries.
    let zoned = p.fold(r#"{"kind":"zone","seq":3,"ts":3000,"raw":"z","zone":"Najena"}"#);
    assert!(!zoned.contains(&"consider"));
}

#[test]
fn the_event_feed_admits_nothing_historical_and_says_so() {
    // The feed's own gate is `live`, so a historical fold reaches nothing.
    let mut historical = Probe {
        fold: Fold::new(registered(ClusterDeps::default()), i64::MAX),
        seen: BTreeMap::new(),
    };
    historical.moved();
    let ev = Event::from_json(
        r#"{"kind":"consider","seq":1,"ts":1000,"raw":"c","mob":"a rat","rare":false,"faction":"indifferent","difficulty":"???"}"#,
    )
    .expect("a JSON event");
    historical.fold.on_primary(&ev, false);
    assert!(!historical.moved().contains(&"eventFeed"));

    // Live, the same line is a row.
    let mut p = Probe::new();
    let conned = p.fold(
        r#"{"kind":"consider","seq":1,"ts":1000,"raw":"c","mob":"a rat","rare":false,"faction":"indifferent","difficulty":"???"}"#,
    );
    assert!(conned.contains(&"eventFeed"));
    // The same mob again inside the anti-spam window is refused by the ring, and by the cursor.
    let again = p.fold(
        r#"{"kind":"consider","seq":2,"ts":1100,"raw":"c","mob":"a rat","rare":false,"faction":"indifferent","difficulty":"???"}"#,
    );
    assert!(!again.contains(&"eventFeed"));
}

#[test]
fn alerts_announces_the_cast_that_moved_its_recency_map_and_not_the_one_that_went_backwards() {
    let mut p = Probe::new();
    let cast =
        p.fold(r#"{"kind":"castBegin","seq":1,"ts":5000,"raw":"c","spell":"Mesmerization VII"}"#);
    assert!(cast.contains(&"alerts"));
    // A stamp that went backwards does not move the recency and does not move the key's position.
    let backwards =
        p.fold(r#"{"kind":"castBegin","seq":2,"ts":4000,"raw":"c","spell":"Mesmerization VII"}"#);
    assert!(!backwards.contains(&"alerts"));
    // A slow proc is the other published field.
    let proc = p.fold(
        r#"{"kind":"poisonProc","seq":3,"ts":6000,"raw":"p","effect":"slow","target":"a spectre","strike":"Weakening Strike"}"#,
    );
    assert!(proc.contains(&"alerts"));
    // With no defs pushed nothing can fire, so an ordinary combat line writes no history.
    let hit = p.fold(MELEE_HIT);
    assert!(!hit.contains(&"alerts"));
}

#[test]
fn buffs_announces_the_landing_and_the_wear_off_and_not_the_round_between_them() {
    let mut p = Probe::new();
    let cast = p.fold(r#"{"kind":"castBegin","seq":1,"ts":1000,"raw":"c","spell":"Clarity"}"#);
    assert!(cast.contains(&"buffs"));
    let landed = p.fold(
        r#"{"kind":"buffApply","seq":2,"ts":2000,"raw":"a","target":"self","spell":"Clarity","illusion":false,"durationMs":600000,"candidates":[{"name":"Clarity","durationMs":600000,"illusion":false}]}"#,
    );
    assert!(landed.contains(&"buffs"));
    // The round between: each of these runs the hygiene sweep, the miner and the session frame, and
    // finds nothing to do in any of them.
    for seq in 3..9 {
        let line = format!(
            r#"{{"kind":"damage","seq":{seq},"ts":3000,"raw":"h","source":"Primitive","target":"a fire giant","amount":42,"dtype":"melee","skill":"slash"}}"#
        );
        assert!(!p.fold(&line).contains(&"buffs"), "melee line {seq}");
    }
    let worn = p.fold(
        r#"{"kind":"buffWearOff","seq":9,"ts":9000,"raw":"w","spell":"Clarity","candidates":["Clarity"],"target":"self"}"#,
    );
    assert!(worn.contains(&"buffs"));
}

#[test]
fn progression_announces_once_per_log_second_of_combat_and_not_once_per_line() {
    let mut p = Probe::new();
    // The first line of a second advances the published `lastTs` — a real change, and announced.
    let opens = p.fold(
        r#"{"kind":"damage","seq":1,"ts":10000,"raw":"h","source":"Primitive","target":"a fire giant","amount":42,"dtype":"melee","skill":"slash"}"#,
    );
    assert!(opens.contains(&"progression"));
    // EQ stamps its log to the second, so the rest of the round carries the same ts and none of
    // these changes a published byte.
    for seq in 2..8 {
        let line = format!(
            r#"{{"kind":"damage","seq":{seq},"ts":10000,"raw":"h","source":"Primitive","target":"a fire giant","amount":42,"dtype":"melee","skill":"slash"}}"#
        );
        assert!(
            !p.fold(&line).contains(&"progression"),
            "line {seq} of the same log second announced"
        );
    }
    // A pet claim binds a name for the credit rule and publishes nothing.
    let claim =
        p.fold(r#"{"kind":"petClaim","seq":8,"ts":10000,"raw":"p","name":"Gyrating Bones"}"#);
    assert!(!claim.contains(&"progression"));
    // A kill inside that same second is a column push and announces on its own account, which a
    // `lastTs`-only signal would have missed.
    let killed = p.fold(
        r#"{"kind":"death","seq":9,"ts":10000,"raw":"d","name":"a fire giant","bySelf":true}"#,
    );
    assert!(killed.contains(&"progression"));
}

#[test]
fn spell_sets_announces_the_gem_that_landed_and_the_settle_that_had_no_line_behind_it() {
    let mut p = Probe::new();
    // A begin line proves the player is working and publishes nothing.
    let begun = p.fold(
        r#"{"kind":"spellMemorize","seq":1,"ts":1000,"raw":"m","spell":"Clarity II","done":false}"#,
    );
    assert!(!begun.contains(&"spellSets"));
    let done = p.fold(
        r#"{"kind":"spellMemorize","seq":2,"ts":2000,"raw":"m","spell":"Clarity II","done":true}"#,
    );
    assert!(done.contains(&"spellSets"));
    // A `loaded` line opens a pending window — not state, so not a change.
    let loaded =
        p.fold(r#"{"kind":"spellSet","seq":3,"ts":3000,"raw":"s","set":"dam","action":"loaded"}"#);
    assert!(!loaded.contains(&"spellSets"));
    // …and an unrelated line inside the settle window still says nothing.
    let quiet = p.fold(MELEE_HIT);
    assert!(!quiet.contains(&"spellSets"));
    // The heartbeat settle, with no event behind it: the set's definition is written here, so a
    // cursor that could not outrun the fold position would have had nothing to say.
    let settled = p.tick(3000 + 20_000);
    assert!(
        settled.contains(&"spellSets"),
        "a wall-clock settle must announce"
    );
    // A second beat settles nothing and announces nothing.
    let idle = p.tick(3000 + 40_000);
    assert!(!idle.contains(&"spellSets"));
}

#[test]
fn item_tiers_and_observed_ranks_each_announce_only_what_reached_their_map() {
    let mut p = Probe::new();
    // A `+N` merge is an item tier and carries no roman numeral, so observedSpellRanks refuses it.
    let merged = p.fold(
        r#"{"kind":"itemMerge","seq":1,"ts":1000,"raw":"m","item":"Whitened Treant Fists +4","tier":4}"#,
    );
    assert!(merged.contains(&"itemTiers"));
    assert!(!merged.contains(&"observedSpellRanks"));
    // A cast with a numeral is the mirror case: a rank sighting, and nothing itemTiers watches.
    let cast =
        p.fold(r#"{"kind":"castBegin","seq":2,"ts":2000,"raw":"c","spell":"Lay on Hands IX"}"#);
    assert!(cast.contains(&"observedSpellRanks"));
    assert!(!cast.contains(&"itemTiers"));
    // An itemMergeFailed that is not the 'mismatch' shape names no item and reaches neither map.
    let failed =
        p.fold(r#"{"kind":"itemMergeFailed","seq":3,"ts":3000,"raw":"f","reason":"missing"}"#);
    assert!(!failed.contains(&"itemTiers"));
    assert!(!failed.contains(&"observedSpellRanks"));
}
