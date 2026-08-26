//! The ported modules. One file per `src/main/modules/*.ts`, named after it, and each carrying its
//! TS twin's header argument rather than a pointer to it — a reader of this crate has to be able
//! to tell whether a quirk is deliberate without opening the other tree.
//!
//! CLUSTER 2a (JOS-471) is the NINE simple appenders; CLUSTER 2b (JOS-475) is the five STATEFUL
//! ones; CLUSTER 2c (JOS-476) is the hard five plus the feed. That is all twenty of
//! `WIRING_ORDER` — and what a build has not registered is still reported as SKIPPED, by name, on
//! every parity run, because the report is about what was COMPARED and never about what exists.
//!
//! `combo` is the one entry with a DIRECTORY beside it, and that is its TS twin's factoring rather
//! than a new one: `combo.ts` is a shell over four pure siblings (`comboEvidence`, `comboScore`,
//! `comboLevels`, `comboIntervals`), and the file this crate names `combo.rs` is the same shell
//! over the same four. `resist` is the second, for the same reason. One EqModule per file still
//! holds — there is exactly one `EqModule` impl in each subtree.
//!
//! The `buff*` files are a THIRD shape and deliberately not a directory: `buffs.ts` has ten
//! collaborators beside it in the same folder over there, so this crate keeps the same flat layout
//! and the two trees read alike. `buffs.rs` holds one `EqModule` and `buff_timers.rs` the other;
//! the two SHARE their cast anchors and their learner, which is the whole of JOS-140.

pub mod alerts;
/// The alerts module's SPEECH half (JOS-500, ruling 27) — `shared/alertCaptures.ts` plus
/// `shared/alertTargets.ts`, together because both answer "what may this firing SAY" and both are
/// enforcement points of one threat model. It is what turns the three fields the fire frame lost at
/// the cutover back into words the app can speak.
pub mod alerts_captures;
/// The alerts module's SCHEDULE half (JOS-492) — `shared/earlyWarning.ts` plus
/// `main/modules/alertsEarlyWarning.ts`, together because over there the split is an Electron
/// boundary (the alert EDITOR asks the same questions and cannot import `main/`) and here there is
/// none. It is what turns `earlyWarnSec` from a def the engine refused into a def the engine honours.
pub mod alerts_early;
/// The alerts module's MATCHER half (JOS-482), split out for the reason `alertsFields.ts` was split
/// out of `alerts.ts` over there: the evaluator is a different kind of thing from the two maps the
/// fold has always kept, and putting it in one file would put that file past the repo's factoring
/// ceiling.
pub mod alerts_rules;
pub mod buff_anchors;
pub mod buff_landing;
pub mod buff_rounds;
/// The TIMER-ROW PROJECTION (JOS-487) — `src/shared/buffTimers.ts`'s model half. A FOURTH shape in
/// this folder and the only one whose TS twin lives in `shared/` rather than in `src/main/modules/`:
/// it is a pure fold over two modules' published state, imported by the renderer over there and by
/// the view layer and the alerts evaluator over here. It holds no `EqModule`.
pub mod buff_timer_rows;
pub mod buff_timers;
pub mod buffs;
pub mod buffs_entities;
pub mod buffs_instance_rules;
pub mod buffs_instances;
pub mod buffs_mining;
pub mod buffs_session;
pub mod buffs_shapes;
pub mod buffs_stats;
pub mod buffs_view;
pub mod character;
pub mod class_unlocks;
pub mod combo;
pub mod consider;
pub mod event_feed;
pub mod item_tiers;
pub mod kills;
pub mod leveling;
pub mod loot;
pub mod observed_spell_ranks;
pub mod output_files;
pub mod progression;
pub mod resist;
pub mod respawn;
pub mod roster;
pub mod spell_sets;
pub mod turnins;
