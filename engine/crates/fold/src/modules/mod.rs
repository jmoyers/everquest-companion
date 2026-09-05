//! The ported modules. One file per `src/main/modules/*.ts`, named after it, each stating its TS
//! twin's design rules rather than pointing at them.
//!
//! `combo` and `resist` each have a directory beside them, mirroring their TS twin's own factoring:
//! a shell over pure siblings. Exactly one `EqModule` impl per subtree either way.
//!
//! The `buff*` files stay flat rather than becoming a directory, so this crate's layout matches the
//! folder their TS twins share. `buffs.rs` and `buff_timers.rs` hold one `EqModule` each and share
//! their cast anchors and their learner.

pub mod alerts;
/// The alerts module's speech half — `shared/alertCaptures.ts` plus `shared/alertTargets.ts`, one
/// file because both answer "what may this firing say" and both enforce the same threat model.
pub mod alerts_captures;
/// The alerts module's schedule half — `shared/earlyWarning.ts` plus
/// `main/modules/alertsEarlyWarning.ts`, one file because the Electron boundary that splits them
/// over there does not exist here.
pub mod alerts_early;
/// The alerts module's matcher half: the evaluator is a different kind of thing from the two maps
/// the fold keeps, and one file would put it past the repo's factoring ceiling.
pub mod alerts_rules;
pub mod buff_anchors;
pub mod buff_landing;
pub mod buff_rounds;
/// The timer-row projection — `src/shared/buffTimers.ts`'s model half. A pure fold over two
/// modules' published state, read by the view layer and the alerts evaluator. Holds no `EqModule`.
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
