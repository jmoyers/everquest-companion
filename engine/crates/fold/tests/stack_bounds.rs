//! The fold's STACK BUDGET: the whole fold runs inside a bounded stack, whatever the log says.
//!
//! Production gives the ingest thread Rust's 2 MiB default and nothing raises it. The claim these
//! tests hold is the one that makes that safe: stack use is a property of the fold's SHAPE, not of
//! the bytes it is handed — it does not grow with the corpus and it does not grow with one
//! pathological line. A data-dependent recursive walk breaks exactly that claim.
//!
//! Measured 2026-08-30 on the owner's 225 MB log, fold plus a full snapshot: high-water under
//! 128 KiB in a release build and under 256 KiB in a debug one, flat from 4 MB of log to 225 MB.
//! [`STACK_BUDGET`] is 512 KiB — twice the debug measurement, a quarter of what production gives —
//! so a walk that recurses per event trips here long before it reaches a user's machine.
//!
//! A BREACH IS A PROCESS ABORT. Windows raises a stack overflow that no test can catch, so a
//! failure here reads as "the test binary did not exit successfully", not as an assertion.

use std::collections::HashSet;

use fold::combat::{CombatEngine, SnapshotOpts};
use fold::{registered, ClusterDeps, Fold};

/// The stack one fold may use. See the header for the measurement behind the number.
const STACK_BUDGET: usize = 512 * 1024;

/// The zone every case resolves timestamps through. Pinned rather than the host's: the corpus is
/// authored and its instants must mean the same thing on every machine.
const ZONE: &str = "America/Los_Angeles";

/// Fold `bytes` on a thread holding [`STACK_BUDGET`], and answer with the event count.
///
/// The snapshot is taken inside the same thread on purpose: serializing what a fold built walks the
/// same state the fold built, and a value that nests per event would overflow there rather than in
/// `fold_bytes`.
fn fold_within_budget(bytes: Vec<u8>) -> u64 {
    std::thread::Builder::new()
        .name("stack-bounds".to_owned())
        .stack_size(STACK_BUDGET)
        .spawn(move || {
            let tz = ZONE.parse::<eqlog::Tz>().expect("a known zone");
            let parser = eqlog::parser_for("Stackprobe", tz);
            let known: HashSet<String> = parser
                .spell_db()
                .map(|db| db.keys().map(str::to_string).collect())
                .unwrap_or_default();
            let clock = eqlog::Clock::new(tz);
            let launch_ms = fold::epoch::launch_ms(&clock);
            let deps = ClusterDeps {
                known_spell: known,
                spell_classes: parser
                    .spell_db()
                    .map(fold::modules::combo::evidence::spell_class_index)
                    .unwrap_or_default(),
                launch_ms,
                construction_now_ms: launch_ms,
                facts: parser
                    .spell_db()
                    .map(fold::spell_facts::SpellFacts::project)
                    .unwrap_or_default(),
                ..ClusterDeps::default()
            };
            let mut engine = CombatEngine::new();
            engine.reset();
            engine.set_player_name("Stackprobe");
            let mut folder = Fold::new(registered(deps), launch_ms).with_combat(engine);
            folder.fold_bytes(&parser, &bytes);
            let last_ts = folder.last_ts();
            let mut out = folder.registry.snapshots();
            if let Some(engine) = &folder.combat {
                let roster = folder.registry.roster();
                out["combat"] = engine.snapshot(last_ts, &SnapshotOpts::full(), roster);
            }
            assert!(
                serde_json::to_string(&out).is_ok(),
                "the snapshot serializes"
            );
            folder.events()
        })
        .expect("a thread with a bounded stack")
        .join()
        .expect("the fold finished")
}

/// Names invented for this file. The repo is public and no name here may be one the owner's log
/// holds; only the SHAPE matters to a parser.
const MOBS: [&str; 4] = [
    "a sand giant",
    "a dust devil",
    "an ancient cyclops",
    "an orc pawn",
];
const ALLIES: [&str; 2] = ["Stackrossa", "Budgetcat"];

/// A deterministic corpus of `rounds` fights, in the lanes a real fold spends its time in.
fn corpus(rounds: usize) -> Vec<u8> {
    let mut out = String::new();
    for i in 0..rounds {
        let mob = MOBS[i % MOBS.len()];
        let ally = ALLIES[i % ALLIES.len()];
        let stamp = stamp(i as u32);
        out.push_str(&format!("{stamp}You have entered South Ro.\n"));
        out.push_str(&format!("{stamp}You begin casting Burst of Flame.\n"));
        out.push_str(&format!(
            "{stamp}{mob} was hit by non-melee for {} points of damage.\n",
            40 + i % 90
        ));
        out.push_str(&format!(
            "{stamp}You slash {mob} for {} points of damage.\n",
            20 + i % 130
        ));
        out.push_str(&format!(
            "{stamp}{ally} hits {mob} for 31 points of damage.\n"
        ));
        out.push_str(&format!("{stamp}{mob} hits YOU for 44 points of damage.\n"));
        out.push_str(&format!("{stamp}You have slain {mob}!\n"));
        out.push_str(&format!("{stamp}--You have looted a rusty dagger.--\n"));
    }
    out.into_bytes()
}

/// One EQ stamp, walked a second at a time from a fixed instant after the launch anchor.
fn stamp(second: u32) -> String {
    let day = 3 + (second / 86_400) % 25;
    let rem = second % 86_400;
    let dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][(day % 7) as usize];
    format!(
        "[{dow} Aug {day:02} {:02}:{:02}:{:02} 2026] ",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// The load-bearing claim: the same budget holds for a corpus fifty times the size, so stack use is
/// flat in the number of events rather than merely small for a short log.
#[test]
fn the_stack_a_fold_needs_does_not_grow_with_the_corpus() {
    let small = fold_within_budget(corpus(20));
    let large = fold_within_budget(corpus(1_000));
    assert!(small > 0, "the small corpus folded events");
    assert!(
        large > small * 40,
        "the large corpus folded proportionally more: {small} then {large}"
    );
}

/// One line, as hostile as a log line can be — the shapes a recursive-descent reader would recurse
/// on, and the ones that make a name or a payload enormous. `n` is a repeat count, not a length.
fn hostile(n: usize) -> Vec<(&'static str, String)> {
    let s = stamp(0);
    let long = "a".repeat(n);
    let name = format!("a {} sand giant", "very ".repeat(n / 5));
    vec![
        (
            "nested parens",
            format!(
                "{s}You slash a sand giant for 59 points of damage. {}{}",
                "(".repeat(n),
                ")".repeat(n)
            ),
        ),
        (
            "unbalanced parens",
            format!(
                "{s}You slash a sand giant for 59 points of damage. {}",
                "(".repeat(n)
            ),
        ),
        ("bracket nesting", format!("{}{s}", "[".repeat(n))),
        (
            "a mob name without end",
            format!("{s}You slash {name} for 59 points of damage."),
        ),
        (
            "that name swinging back",
            format!("{s}{name} hits YOU for 106 points of damage."),
        ),
        (
            "a spell name without end",
            format!("{s}You begin casting {}.", "Ala".repeat(n / 3)),
        ),
        (
            "a loot line without end",
            format!("{s}--You have looted a {long}.--"),
        ),
        (
            "nothing but quotes",
            format!("{s}a sand giant says, {}", "'".repeat(n)),
        ),
        (
            "nothing but coin separators",
            format!(
                "{s}You receive {} platinum from the corpse.",
                "1,".repeat(n)
            ),
        ),
        (
            "a suffix repeated",
            format!(
                "{s}You slash a sand giant for 59 points of damage.{}",
                " (Critical)".repeat(n / 11)
            ),
        ),
        (
            "a zone name without end",
            format!("{s}You have entered {long}."),
        ),
    ]
}

/// …and the same budget holds for one line of a quarter of a megabyte, whatever it is made of. A
/// parser that recursed per character or per bracket would need megabytes here.
#[test]
fn the_stack_a_fold_needs_does_not_grow_with_one_pathological_line() {
    for (label, line) in hostile(20_000) {
        let mut bytes = line.into_bytes();
        bytes.push(b'\n');
        // Zero events is a fine answer: a line nothing parses is still a line the fold survived.
        let _ = fold_within_budget(bytes);
        eprintln!("stack_bounds: {label} folded inside {STACK_BUDGET} bytes");
    }
}
