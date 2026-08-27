//! WHAT THE ENGINE ANSWERS. Every shape here comes from the generated types and none of it is
//! hand-rolled JSON — the schema is the source of truth for both languages (owner ruling 14), so a
//! literal object written here would be a third opinion nobody regenerates.
//!
//! THERE IS NO GAME LOGIC IN THIS FILE and none may be added. `echo` proves a message crossed the
//! seam; `session.*` and `view.*` are answered at echo grade — the right envelope, the right
//! result shape, honest emptiness inside. Where an answer is a stub the doc comment says exactly
//! what it does and does not do, so that a later phase is filling a hole somebody described rather
//! than discovering one.
//!
//! DISPATCH IS A PURE FUNCTION OF (world, session, message). It returns messages instead of writing
//! them, which is what lets the whole op table be tested with no socket in the room — the same
//! argument `protocol::transport::memory` makes one layer down.

use protocol::generated::{
    AlertsDefineRequestOp, BuffTrustDefineRequestOp, ClientMessage, CombatSearchFightsRequestOp,
    CombatSearchFightsResult, CombatSnapshotOpts, CombatSnapshotRequestOp, CombatSnapshotResult,
    CombatState, ComboDefineRequestOp, DefineAck, EchoRequestOp, EchoResult, EngineMessage,
    ErrorCode, ErrorReply, ErrorReplyKind, FightSearchHit, FightSummary, HealthResultStatus,
    HelloOp, KnowledgeDefineRequestOp, KnowledgeDomain, KnowledgeItemRequestOp,
    KnowledgeMobRequestOp, KnowledgeRecord, KnowledgeResult, KnowledgeSearchRequestOp,
    KnowledgeSearchResult, KnowledgeSpellRequestOp, ModuleSnapshotRequestOp, ModuleSnapshotResult,
    PerfBudgetsRequestOp, PerfSnapshotRequestOp, PerfTimelineRequestOp, ProtocolError, Reply,
    ReplyKind, ReplyResult, RequestId, ResetMessage, ResetMessageKind, ResistLevelSource,
    ResistLevelsRequestOp, ResistLevelsResult, ResistMobLevel, RespawnConfirmAck,
    RespawnConfirmSightingRequestOp, RespawnDefineRequestOp, RosterDefineRequestOp,
    SessionAttachRequestOp, SessionHealthRequestOp, SessionMarkAck, SessionMarkAckStatus,
    SessionMarkAddRequestOp, SessionProgressRequestOp, SubscribeAck, ViewSubscribeRequestOp,
    ViewUnsubscribeRequestOp,
};
use protocol::generated::{
    ClassAbbr, ClientSpell, ClientSpellDebuff, ClientSpellDebuffAxis, ClientSpellSlot, ResistAxis,
    ResistSpellRequestOp, ResistSpellResult, SpellCatalogueRow, SpellCategoryFacet,
    SpellClassLevel, SpellSort, SpellTableState, SpellsSearchRequestOp, SpellsSearchResult,
};
use protocol::generated::{LogsListRequestOp, LogsListResult, LogsSetDirRequestOp};

use crate::ingest::CombatOpts;
use crate::world::{CombatAnswer, ListenerId, PerfAnswer, SnapshotAnswer, World};

/// How many creatures one `resist.levels` may name — the schema's `maxItems`, restated where it is
/// enforced.
///
/// IT IS A BOUND ON A STRANGER'S REQUEST, not a tuned number. Every caller this app has asks about
/// ONE creature (a resist card, a con card); the plural exists so a page drawing a list costs one
/// round trip instead of a dozen, and thirty-two is comfortably above any list a card surface
/// draws while still being a number this process can answer inside one read boundary.
const MAX_MOB_LEVEL_ASKS: usize = 32;

/// One parsed `spells_us.txt` row, as the wire describes it (JOS-497 item 3).
///
/// THE FOLD'S `f64`s BECOME THE SCHEMA'S NUMBERS UNCHANGED, and that is the right conversion rather
/// than a lazy one: the app's own parser produces JavaScript numbers, the app's own consumers read
/// them as such, and rounding to integers here would make this engine's answer differ from the
/// worker's on any row where the file carries a fraction. The schema says `number` for exactly that
/// reason.
///
/// ABSENT STAYS ABSENT. Every optional is absent-means-nothing at its producer (`fold::spells_us`
/// states the measurement behind each), so a `0` or a `false` invented here would be this layer
/// disagreeing with the parser about what the file said. `song` is `Some(true)` or nothing, never
/// `Some(false)` — the app payload's own shape.
fn client_spell(info: &fold::spells_us::SpellInfo) -> ClientSpell {
    use fold::spells_us::Axis;
    let axis = |a: Axis| match a {
        Axis::Magic => ClientSpellDebuffAxis::Magic,
        Axis::Fire => ClientSpellDebuffAxis::Fire,
        Axis::Cold => ClientSpellDebuffAxis::Cold,
        Axis::Poison => ClientSpellDebuffAxis::Poison,
        Axis::Disease => ClientSpellDebuffAxis::Disease,
        Axis::All => ClientSpellDebuffAxis::All,
    };
    ClientSpell {
        // A SPELL'S OWN AXIS IS NEVER `all` — that is a debuff SLOT's, and the two are different
        // sets on the wire for exactly this reason. The `All` arm here is unreachable and answers
        // `None`, which is what `axisFromResistType` answers for everything it refuses.
        axis: match info.axis {
            Some(Axis::Magic) => Some(ResistAxis::Magic),
            Some(Axis::Fire) => Some(ResistAxis::Fire),
            Some(Axis::Cold) => Some(ResistAxis::Cold),
            Some(Axis::Poison) => Some(ResistAxis::Poison),
            Some(Axis::Disease) => Some(ResistAxis::Disease),
            Some(Axis::All) | None => None,
        },
        resist_adj: info.resist_adj,
        cast_ms: info.cast_ms,
        recast_ms: info.recast_ms,
        ae_max_targets: info.ae_max_targets,
        mana: info.mana,
        target_type: info.target_type,
        level_cap: info.level_cap,
        song: info.song.then_some(true),
        damage_slot: info.damage_slot.map(|s| ClientSpellSlot {
            base: s.base,
            max: s.max,
            calc: s.calc,
        }),
        debuff_slots: info
            .debuff_slots
            .iter()
            .map(|d| ClientSpellDebuff {
                axis: axis(d.axis),
                base: d.base,
                calc: d.calc,
                max: d.max,
            })
            .collect(),
    }
}

/// The most spell rows one `spells.search` window may hold.
///
/// It is a bound on a stranger's request rather than a tuned number, and it is generous on purpose:
/// this is a BROWSE as much as a search — a player scrolling `Direct Damage` for their combo is
/// looking at a list, not at a type-ahead — so the cap sits well above any page a surface draws
/// while staying far enough under the frame ceiling that no window can approach it. The corpus
/// behind it is ~48k rows, which is exactly why the window exists.
const MAX_SPELL_ROWS: i64 = 200;

/// What a `spells.search` with no `limit` gets.
const DEFAULT_SPELL_ROWS: i64 = 50;

/// CLAMPED, NEVER REFUSED — [`clamp_hits`]'s argument, applied to the same kind of number.
fn clamp_spell_rows(limit: Option<i64>) -> usize {
    let wanted = limit.map_or(DEFAULT_SPELL_ROWS, |n| n.clamp(0, MAX_SPELL_ROWS));
    usize::try_from(wanted).unwrap_or(0)
}

/// The wire's answer to one `spells.search`.
///
/// `found` is `None` when there is no table to search, which is an EMPTY ANSWER rather than a
/// failure — `spell_table` beside it says which of the three situations produced it, and `path`
/// names the place this engine looked so the sentence a surface writes can be specific.
fn spells_search_result(
    found: Option<&crate::spell_search::Found>,
    spells: &crate::spells::ClientSpells,
    offset: usize,
    limit: usize,
) -> SpellsSearchResult {
    let as_i64 = |n: usize| i64::try_from(n).unwrap_or(i64::MAX);
    SpellsSearchResult {
        spells: found
            .map(|f| {
                f.rows
                    .iter()
                    .map(|row| SpellCatalogueRow {
                        name: row.name.clone(),
                        level: i64::from(row.level),
                        classes: row
                            .classes
                            .iter()
                            .map(|c| SpellClassLevel {
                                // EVERY CODE THIS PARSER PRODUCES IS A WIRE MEMBER — both lists are
                                // the same sixteen classes — so the fallback is unreachable and is
                                // written as a WARRIOR rather than a panic, because a row with one
                                // class mis-spelled is a smaller failure than a dead connection.
                                class: ClassAbbr::try_from(c.class).unwrap_or(ClassAbbr::War),
                                level: i64::from(c.level),
                            })
                            .collect(),
                        category: row.category.clone(),
                        subcategory: row.subcategory.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        total: found.map_or(0, |f| as_i64(f.total)),
        offset: as_i64(offset),
        limit: as_i64(limit),
        categories: found
            .map(|f| {
                f.categories
                    .iter()
                    .map(|facet| SpellCategoryFacet {
                        name: facet.name.clone(),
                        subcategories: facet.subcategories.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        spell_table: table_state(spells),
        path: spells.path().to_string_lossy().into_owned(),
    }
}

/// The client table's state in the wire's words. Shared by the two ops that report it, so the two
/// can never describe the same three situations differently.
fn table_state(spells: &crate::spells::ClientSpells) -> SpellTableState {
    match spells.state() {
        crate::spells::TableState::Ok => SpellTableState::Ok,
        crate::spells::TableState::Missing => SpellTableState::Missing,
        crate::spells::TableState::Unloadable => SpellTableState::Unloadable,
    }
}

/// One connection's own state — everything that belongs to this conversation rather than to the
/// world.
///
/// SUBSCRIPTIONS ARE PER-CONNECTION BY CONSTRUCTION, AND THE WORLD IS WHERE THEY LIVE. A
/// subscription is named by the id of the request that opened it, and request ids are
/// client-chosen, so two renderers routinely pick the same number; the world keys them by
/// (listener, id), so one client can never unsubscribe another's stream — a property worth having
/// structurally rather than by a check somebody remembers to write. They moved there when the fold
/// did: a landing fold must reset EVERY open subscription on EVERY connection, and a set held out
/// here is a set the world cannot see. This session is therefore its receipt and nothing else.
pub struct Session {
    /// This connection's membership of the world.
    listener: ListenerId,
}

impl Session {
    /// The session of the connection holding this membership.
    #[must_use]
    pub fn new(listener: ListenerId) -> Self {
        Self { listener }
    }
}

/// What a dispatched message produced.
pub enum Outcome {
    /// Messages to send to THIS connection, in the order given.
    Send(Vec<EngineMessage>),
    /// The connection must end. The string is a stderr diagnostic, never sent to the peer: it
    /// describes a peer that broke the conversation's shape, and there is no request id to hang an
    /// error on (per the schema: a failure with no request behind it closes the connection).
    Close(String),
}

impl Session {
    /// Answer one well-formed client message.
    pub fn dispatch(&mut self, world: &World, message: ClientMessage) -> Outcome {
        match message {
            // A SECOND HELLO IS THE END OF THE CONVERSATION. `Hello` carries no request id — it is
            // the one client message that cannot be answered with an error — and a peer that
            // re-handshakes mid-stream is a peer whose state machine disagrees with this one's.
            // Guessing at what it meant is how a session ends up authenticated twice with two
            // different tokens.
            ClientMessage::Hello(_) => {
                Outcome::Close("a second hello arrived on an open connection".to_owned())
            }

            // ECHO. The whole point of the op: a message the client composed came back with its
            // contents intact, which proves the envelope, the framing, the token check and the
            // reply correlation all work before a single log byte exists.
            ClientMessage::EchoRequest(request) => reply(
                request.id,
                ReplyResult::EchoResult(EchoResult {
                    text: request.params.text,
                }),
            ),

            ClientMessage::SessionHealthRequest(request) => {
                reply(request.id, ReplyResult::HealthResult(world.health()))
            }

            // ATTACH. Bumps the generation, announces it, and STARTS AN INGEST over the named log:
            // scan at full speed, then tail live. See `World::attach` for the critical section and
            // `ingest.rs` for the generation law that makes a second attach preempt this one.
            ClientMessage::SessionAttachRequest(request) => reply(
                request.id,
                ReplyResult::AttachResult(world.attach(
                    &request.params.log_path,
                    request.params.state_dir.as_deref(),
                )),
            ),

            // PROGRESS. Acknowledged with a `SubscribeAck` naming this request, because that is
            // what the op IS: a subscription to the connection-wide progress channel, whose frames
            // are `EpochMessage`s carrying `progress` (the schema says so in as many words — they
            // are not a fourth stream kind). The registry of reply shapes is closed and has no
            // arm of its own for this op; the ack shape fits it exactly, which is why no schema
            // change was needed to answer it honestly.
            //
            // THE FRAMES ARRIVE ON THE CHANNEL THIS ACK NAMES, and since JOS-474 they are real:
            // an attach starts a fold and the fold announces itself at a bounded cadence. They are
            // connection-wide, so an attach on ANOTHER connection is heard here too — which is what
            // makes a second renderer's loading state honest without it having asked for anything.
            ClientMessage::SessionProgressRequest(request) => {
                let subscription = RequestId(*request.id);
                reply(
                    request.id,
                    ReplyResult::SubscribeAck(SubscribeAck {
                        subscription,
                        subscribed: true,
                    }),
                )
            }

            // MODULE.SNAPSHOT — THE FIRST DATA-BEARING OP (JOS-478). Everything above this line is
            // an envelope; this one carries the fold's own answer.
            //
            // THE ANSWER IS THE INGEST THREAD'S, fetched through the one door. This dispatch stays
            // a pure function of (world, session, message) because `World::module_snapshot` returns
            // a value rather than writing one — it is the WAIT that is new, and it is bounded and
            // owned by the world (see that method for why the lock is not held across it).
            //
            // THREE OUTCOMES, THREE SENTENCES. A module the registry does not carry is `notFound`,
            // because the registry is the authority and an empty state would be a lie about a
            // module that does not exist. A world with no fold is `unavailable` — nothing is wrong
            // with the request, there is simply nothing attached yet, and telling a client
            // `notFound` there would send it hunting for a typo in a name that is perfectly good.
            ClientMessage::ModuleSnapshotRequest(request) => {
                let module = request.params.module;
                match world.module_snapshot(&module) {
                    SnapshotAnswer::Snapshot(snapshot) => reply(
                        request.id,
                        ReplyResult::ModuleSnapshotResult(ModuleSnapshotResult {
                            module,
                            seq: snapshot.seq,
                            state: snapshot.state,
                        }),
                    ),
                    SnapshotAnswer::NotFound => error(
                        request.id,
                        ErrorCode::NotFound,
                        format!("this engine folds no module named {module:?}"),
                    ),
                    SnapshotAnswer::Unavailable(why) => {
                        error(request.id, ErrorCode::Unavailable, why)
                    }
                }
            }

            // PERF.SNAPSHOT — THE ENGINE APPEARS IN THE APP'S PERFORMANCE PANEL (ruling 19 surface,
            // JOS-483). The one op whose subject is this process rather than the game.
            //
            // TWO OUTCOMES, NOT THREE. There is nothing here that could be `notFound` — the request
            // names no module, no source, nothing that might be absent — and an engine with nothing
            // attached is NOT `unavailable` either: it is an idle engine, and it answers with its
            // real status, epoch and uptime beside an empty serve list. The single refusal is a fold
            // that had a door and did not answer through it, which is a wedged ingest, and telling a
            // panel that is far more useful than drawing it a row of zeros.
            ClientMessage::PerfSnapshotRequest(request) => match world.perf_snapshot() {
                PerfAnswer::Perf(perf) => reply(request.id, ReplyResult::PerfSnapshotResult(*perf)),
                PerfAnswer::Unavailable(why) => error(request.id, ErrorCode::Unavailable, why),
            },

            // PERF.BUDGETS AND PERF.TIMELINE — RULING 19's SURFACE 8, COMPLETED (JOS-502).
            //
            // THREE OPS, ONE ASK, ONE SET OF OUTCOMES. Everything the arm above argues holds here
            // unchanged — no `notFound` is reachable because neither request names anything that
            // could be absent, an engine with nothing attached is idle rather than unavailable (no
            // budget has been measured and no moment has been sampled, and both say so), and the
            // single refusal is a fold with a door that did not answer through it.
            //
            // WHY TWO OPS AND NOT ONE. They answer different questions with different lifetimes: a
            // budget verdict is a judgement about the WHOLE generation and changes rarely, while
            // the timeline is a window that moves on every beat. A panel wants the first once and
            // the second on every redraw, and a client that had to refetch the ring to re-read a
            // verdict would pay the larger payload for the smaller answer.
            ClientMessage::PerfBudgetsRequest(request) => match world.perf_budgets() {
                PerfAnswer::Perf(result) => {
                    reply(request.id, ReplyResult::PerfBudgetsResult(*result))
                }
                PerfAnswer::Unavailable(why) => error(request.id, ErrorCode::Unavailable, why),
            },

            ClientMessage::PerfTimelineRequest(request) => match world.perf_timeline() {
                PerfAnswer::Perf(result) => {
                    reply(request.id, ReplyResult::PerfTimelineResult(*result))
                }
                PerfAnswer::Unavailable(why) => error(request.id, ErrorCode::Unavailable, why),
            },

            // SUBSCRIBE. Validate the descriptor, acknowledge, then open the stream with a reset —
            // reset-then-diffs is rule 1 of the diff protocol, and it holds even when the window is
            // empty. A client that special-cased "no reset because there was nothing" would be a
            // client that cannot tell an empty view from a view that never opened.
            //
            // THE SOURCE REGISTRY IS HERE NOW (JOS-480), and phase 0's accept-everything is gone.
            // The views schema is explicit that an unknown source is a `notFound` error and never
            // an empty result; `views::validate` is where that becomes true, along with every other
            // name in the descriptor — a sort term over a field the source does not carry, a
            // direction that is not asc/desc, a window outside the payload budget. Each is refused
            // BY NAME, because a client that silently gets a window it did not ask for has no way
            // to notice.
            //
            // THE OPENING RESET IS EMPTY EVEN OVER A LIVE FOLD, and that is a property of where the
            // rows live rather than of the protocol: they are on the ingest thread, this is a
            // connection thread, and the full window arrives from the fold at the next boundary it
            // already reaches. See `World::open_subscription`.
            ClientMessage::ViewSubscribeRequest(request) => {
                let view = match crate::views::validate(&request.params) {
                    Ok(view) => view,
                    Err(refusal) => {
                        return error(request.id, refusal.code, refusal.message);
                    }
                };
                // THE REGISTRATION AND THE STAMP ARE ONE ACT (`World::open_subscription`), so the
                // epoch this reset names cannot be superseded between reading it and sending it.
                let epoch = world.open_subscription(self.listener, *request.id, view);
                let subscription = RequestId(*request.id);
                let ack = Reply {
                    kind: ReplyKind::Reply,
                    id: RequestId(*request.id),
                    ok: true,
                    result: ReplyResult::SubscribeAck(SubscribeAck {
                        subscription,
                        subscribed: true,
                    }),
                };
                let reset = ResetMessage {
                    kind: ResetMessageKind::Reset,
                    id: RequestId(*request.id),
                    epoch,
                    total: 0,
                    rows: Vec::new(),
                };
                Outcome::Send(vec![
                    EngineMessage::Reply(ack),
                    EngineMessage::ResetMessage(reset),
                ])
            }

            // UNSUBSCRIBE. `notFound` for a subscription this connection does not hold — including
            // one it held a moment ago. Answering `subscribed: false` to a stream that was never
            // open would tell a client its bookkeeping is fine when it is not.
            ClientMessage::ViewUnsubscribeRequest(request) => {
                let named = *request.params.subscription;
                if world.close_subscription(self.listener, named) {
                    reply(
                        request.id,
                        ReplyResult::SubscribeAck(SubscribeAck {
                            subscription: RequestId(named),
                            subscribed: false,
                        }),
                    )
                } else {
                    error(
                        request.id,
                        ErrorCode::NotFound,
                        format!("no subscription {named} is open on this connection"),
                    )
                }
            }

            // ── THE FIVE `*.define` COMMANDS (JOS-482, boundary verdict 3) ──────────────────────
            //
            // APP KNOWLEDGE FLOWS IN HERE and nowhere else. The store stays persistence truth on
            // the app side — the engine never reads a settings file — and every preference the fold
            // used to read out of it arrives as one of these, pushed on connect and on change.
            //
            // EACH IS AN IDEMPOTENT FULL-SET REPLACE, which is why five near-identical arms are the
            // right shape rather than one generic one: the payload is TYPED per family (that is
            // what `count` is read off), and the only thing they share is the law. `World::define`
            // records the push and hands it to the live fold; see it for why the ack waits.
            //
            // THERE IS NO REFUSAL PATH. A payload that reached this point deserialized against the
            // schema, and a family this build folds no module for would be an engine bug rather
            // than a client mistake — so `applied` is pinned true by the schema and the honest
            // failure mode is a `badParams` refusal one layer up, in `classify`.
            ClientMessage::AlertsDefineRequest(request) => define(
                world,
                request.id,
                "alerts",
                &request.params.defs,
                json(&request.params.defs),
            ),

            ClientMessage::BuffTrustDefineRequest(request) => define(
                world,
                request.id,
                "buffTrust",
                // NOT A LIST: the family's knowledge is one object, so the ack carries no `count`.
                &(),
                json(&request.params.trust),
            ),

            ClientMessage::RespawnDefineRequest(request) => define(
                world,
                request.id,
                "respawn",
                &(),
                json(&request.params.prefs),
            ),

            ClientMessage::ComboDefineRequest(request) => define(
                world,
                request.id,
                "combo",
                &request.params.corrections,
                json(&request.params.corrections),
            ),

            ClientMessage::RosterDefineRequest(request) => define(
                world,
                request.id,
                "roster",
                &request.params.edits,
                json(&request.params.edits),
            ),

            // SESSIONMARKS.ADD — the one COMMAND in this table that can be refused without being
            // wrong (boundary verdict 6, JOS-487).
            //
            // A REFUSAL IS NOT AN ERROR AND MUST NOT BE ONE. The frame deserialized, the op exists,
            // the instant is well formed; the answer is "not now", and it is the world's own
            // `hydrating` law wearing the status's clothes. Sending an `ErrorReply` here would make
            // a client branch on `code` for a routine outcome and would put a normal press in every
            // error log the app collects.
            //
            // THE INSTANT IS THE CALLER'S CLOCK and this arm does not second-guess it. `Date.now()`
            // at the press is the number the app applies to its OWN half of the split, and the two
            // halves sharing one boundary is the whole point — an engine that stamped its own would
            // put everything looted between the two reads on the wrong side of one of them.
            ClientMessage::SessionMarkAddRequest(request) => {
                let (accepted, status) = world.session_mark(request.params.at);
                reply(
                    request.id,
                    ReplyResult::SessionMarkAck(SessionMarkAck {
                        accepted,
                        status: mark_status(status),
                    }),
                )
            }

            // RESPAWN.CONFIRMSIGHTING — the second COMMAND in this table, and the last one
            // (JOS-494; the census pre-ruled it an impure input into the fold).
            //
            // `confirmed: false` IS NOT AN ERROR EITHER, and for a narrower reason than the mark's:
            // there the request was well formed and the WORLD was not ready; here the request is
            // well formed and there is simply nothing to re-base — the row is gone, or nothing has
            // been seen on it since the clock started. Both are what a click that raced a death
            // looks like, both are what the app's own handler already answered the person with, and
            // an `ErrorReply` for either would put an ordinary press in every error log this app
            // collects.
            //
            // NO STATUS RIDES THE ACK, unlike the mark's. There is nothing for one to explain: the
            // two refusals are about the ROW, so a state the world happened to be in could not have
            // caused either, and a status here would invite a client to branch on a coincidence.
            ClientMessage::RespawnConfirmSightingRequest(request) => reply(
                request.id,
                ReplyResult::RespawnConfirmAck(RespawnConfirmAck {
                    confirmed: world.confirm_sighting(&request.params.row_id),
                }),
            ),

            // ── RESIST.LEVELS (JOS-497 item 1, cutover ledger item 6) ──────────────────────────
            //
            // HOW OLD IS THIS CREATURE, as the resist fold knows it. The last fact
            // `src/main/ipc/resist.ts` was still reading out of the app's own fold synchronously,
            // and the one the census's resist mirror had no way to carry: the resist module
            // publishes two integers and this is in neither of them, and an answer keyed by
            // creature name cannot be mirrored without holding every name anybody ever cons.
            //
            // THE BOUND IS ENFORCED HERE AND REFUSED BY NAME. The schema says at most
            // `MAX_MOB_LEVEL_ASKS` names, and a longer list is `badParams` rather than a truncation
            // — JOS-478's law about descriptors, which is the same law: a caller that believed it
            // asked about forty creatures and was answered about eight has no way to notice. An
            // EMPTY list is refused for the same reason and not answered with an empty result,
            // because `minItems` is part of the contract and silently agreeing with a request the
            // schema forbids is how the two sides drift.
            //
            // TWO OUTCOMES, LIKE `combat.snapshot`. There is no `notFound`: a creature nobody has
            // conned and the catalog has never heard of is a perfectly good question whose honest
            // answer is that nothing states a level, and it arrives as a MISSING ROW. The single
            // refusal is having nobody to ask.
            ClientMessage::ResistLevelsRequest(request) => {
                let mobs = request.params.mobs;
                if mobs.is_empty() || mobs.len() > MAX_MOB_LEVEL_ASKS {
                    return error(
                        request.id,
                        ErrorCode::BadParams,
                        format!(
                            "resist.levels takes between 1 and {MAX_MOB_LEVEL_ASKS} names; this \
                             request named {}",
                            mobs.len()
                        ),
                    );
                }
                match world.resist_levels(&mobs) {
                    Err(why) => error(request.id, ErrorCode::Unavailable, why),
                    Ok(found) => reply(
                        request.id,
                        ReplyResult::ResistLevelsResult(ResistLevelsResult {
                            levels: found
                                .into_iter()
                                .map(|(mob, fact)| ResistMobLevel {
                                    mob,
                                    level: fact.level,
                                    lo: fact.lo,
                                    hi: fact.hi,
                                    // THE FOLD'S `&'static str` BECOMES THE SCHEMA'S CLOSED SET
                                    // here rather than in the fold, which is this file's whole job.
                                    // The `_` arm cannot be reached — `MobLevelFact::from` is
                                    // written in exactly two places and both are below — and it
                                    // answers `Catalog` rather than panicking because a wrong
                                    // PROVENANCE on a right number is a card that reads oddly, and
                                    // a dead engine is a card that never draws.
                                    from: match fact.from {
                                        "con" => ResistLevelSource::Con,
                                        _ => ResistLevelSource::Catalog,
                                    },
                                })
                                .collect(),
                        }),
                    ),
                }
            }

            // ── RESIST.SPELL (boundary verdict 7, JOS-497 item 3) ──────────────────────────────
            //
            // ONE SPELL OUT OF THE CLIENT'S OWN TABLE. It is the only source that states how a
            // spell is RESISTED — the committed wiki scrape knows a spell's messages and neither
            // its resist type nor its resist adjust — and this process reads the player's own copy,
            // beside the install the attach named.
            //
            // NO `notFound`, AND THE REASON IS THE WHOLE SHAPE OF THE REPLY. Four situations reach
            // this op and only one of them is an error: the file was read and has a row (a hit);
            // the file was read and has no such row; there is no file at that path; there is a file
            // that could not be read. The middle two are not failures — they are what a card has to
            // SAY, in different words, and an `ErrorReply` would flatten them into one and put an
            // ordinary state into every error log this app collects. So `table` and `path` ride
            // every answer and `spell` rides a hit.
            //
            // THE ONE REFUSAL IS HAVING NO INSTALL TO SPEAK OF: nothing has been attached, so there
            // is no log, so there is no directory to look beside.
            //
            // THE READ HAPPENS ON THIS THREAD, deliberately. It is 38 MB and a few hundred
            // milliseconds, once per install per launch, on a connection thread whose only job is
            // this request — never on the ingest, which is the thread tailing the log.
            ClientMessage::ResistSpellRequest(request) => {
                let name = request.params.name;
                match world.client_spells() {
                    None => error(
                        request.id,
                        ErrorCode::Unavailable,
                        "no log is attached, so there is no install to read a spell table beside"
                            .to_owned(),
                    ),
                    Some(spells) => reply(
                        request.id,
                        ReplyResult::ResistSpellResult(ResistSpellResult {
                            spell: spells.spell(&name).map(client_spell),
                            spell_name: name,
                            table: table_state(&spells),
                            path: spells.path().to_string_lossy().into_owned(),
                        }),
                    ),
                }
            }

            // ── SPELLS.SEARCH (JOS-507) ────────────────────────────────────────────────────────
            //
            // THE CLIENT'S SPELL CATALOGUE, SEARCHED BY TYPE. The in-game Actions/Spells window can
            // search by TYPE, and it can because `spells_us.txt` files every spell under a category
            // and a subcategory id while `dbstr_us.txt` says what those ids are called. Both are in
            // the install the attach named, so this op adds no configuration and no discovery.
            //
            // A WINDOW, NEVER THE TABLE — the same standing ruling `resist.spell` lives under, and
            // the reason this is a filtered/sorted/windowed query rather than a bulk read that the
            // app would then re-cut. The engine does the whole job so the renderer can draw the rows
            // in the order they arrive (ruling 4).
            //
            // THE ONE REFUSAL IS THE SAME ONE `resist.spell` HAS: nothing attached means no log,
            // which means no directory to look beside. Everything else is an ANSWER — a missing
            // table, an unreadable one, a filter that excludes everything — and `spellTable` and
            // `path` ride every reply so a surface can tell those apart and name the place it looked.
            ClientMessage::SpellsSearchRequest(request) => {
                let params = request.params;
                match world.client_spells() {
                    None => error(
                        request.id,
                        ErrorCode::Unavailable,
                        "no log is attached, so there is no install to read a spell table beside"
                            .to_owned(),
                    ),
                    Some(spells) => {
                        // THE CLASS CODES BECOME THE CLIENT FILE'S COLUMNS HERE, through the parser
                        // that owns the file's column order — never through a second copy of it.
                        // Every code the wire can carry has a column, because both lists are the
                        // same sixteen classes; `filter_map` is the total function that says so
                        // without a panic standing behind it.
                        // SORTED AND DEDUPED, which is where this list's BOUND lives. The schema
                        // carries no `maxItems` (it would generate a tuple union in TypeScript that
                        // no ordinary array satisfies), so a stranger may send the same class ten
                        // thousand times; after this it is at most sixteen entries by construction.
                        // A repeated class was never meaningful, and the scope test below is a
                        // linear scan per row — an unbounded one would be the whole cost of the op.
                        let mut columns: Vec<usize> = params
                            .classes
                            .iter()
                            .filter_map(|c| fold::spells_us::class_column(&c.to_string()))
                            .collect();
                        columns.sort_unstable();
                        columns.dedup();
                        let limit = clamp_spell_rows(params.limit);
                        let offset = params
                            .offset
                            .and_then(|n| usize::try_from(n).ok())
                            .unwrap_or(0);
                        let query = crate::spell_search::Query {
                            text: params.text.as_deref(),
                            category: params.category.as_deref(),
                            subcategory: params.subcategory.as_deref(),
                            // ABSENT AND EMPTY ARE ONE STATE, and they have to be: an optional array
                            // arrives in Rust as an empty `Vec` with its absence already gone, so
                            // giving the two different meanings would make the languages disagree
                            // about a request neither could round-trip. Both mean every class, which
                            // is the surface's show-all.
                            classes: (!columns.is_empty()).then_some(columns.as_slice()),
                            sort: match params.sort {
                                Some(SpellSort::Name) => crate::spell_search::Sort::Name,
                                Some(SpellSort::Level) | None => crate::spell_search::Sort::Level,
                            },
                            offset,
                            limit,
                        };
                        // NO TABLE IS AN EMPTY ANSWER, NOT A FAILURE. `spellTable` beside it says
                        // which of the three situations produced it.
                        let found = spells.table().map(|table| {
                            crate::spell_search::search(table, spells.category_names(), &query)
                        });
                        reply(
                            request.id,
                            ReplyResult::SpellsSearchResult(spells_search_result(
                                found.as_ref(),
                                &spells,
                                offset,
                                limit,
                            )),
                        )
                    }
                }
            }

            // ── THE COMBAT SURFACE (JOS-485) ───────────────────────────────────────────────────
            //
            // COMBAT.SNAPSHOT. `src/main/ipc/world.ts`'s `combat:snapshot` handler, moved to the
            // process that owns the fold — and the ONE difference from that handler is the one
            // worth stating: it passes `Date.now()`, and this passes nothing, because the instant
            // is the engine's to choose and only the thread holding the fold knows whether this
            // world has reached its tail (`crate::foldsink`'s header). The reply says which instant
            // it chose.
            //
            // TWO OUTCOMES, LIKE `perf.snapshot` AND UNLIKE `module.snapshot`. The request names no
            // module, no source, nothing that could be absent — so there is no `notFound` here, and
            // every way of having nothing to ask is one `unavailable`.
            ClientMessage::CombatSnapshotRequest(request) => {
                let opts = combat_opts(request.params.opts.as_ref());
                match world.combat_snapshot(&opts) {
                    CombatAnswer::Unavailable(why) => {
                        error(request.id, ErrorCode::Unavailable, why)
                    }
                    CombatAnswer::Answer(snapshot) => match snapshot.state {
                        // THE SHAPE IS CHECKED RATHER THAN COERCED. `CombatEngine::snapshot`
                        // publishes an object and the schema says so, but "an empty object" is what
                        // an `unwrap_or_default` would put on the wire if it ever stopped — a
                        // meter with no rows, indistinguishable from a session with no fights. An
                        // engine bug says it is one.
                        serde_json::Value::Object(state) => reply(
                            request.id,
                            ReplyResult::CombatSnapshotResult(CombatSnapshotResult {
                                now: snapshot.now,
                                snapshot: CombatState(state),
                            }),
                        ),
                        other => error(
                            request.id,
                            ErrorCode::Internal,
                            format!(
                                "the combat engine published a {} where the protocol states an object",
                                shape_of(&other)
                            ),
                        ),
                    },
                }
            }

            // COMBAT.SEARCHFIGHTS. `world.ts:27`'s semantics, kept verbatim: a `limit` is CLAMPED
            // rather than refused, and the clamp is here rather than in the fold because it is a
            // payload decision about a wire message. The query needs no coercion on this side — the
            // schema makes it a string or the frame is `badParams` one layer up, which is the typed
            // half of `typeof text === 'string' ? text : ''`.
            ClientMessage::CombatSearchFightsRequest(request) => {
                let limit = clamp_hits(request.params.limit);
                match world.search_fights(&request.params.query, limit) {
                    CombatAnswer::Unavailable(why) => {
                        error(request.id, ErrorCode::Unavailable, why)
                    }
                    CombatAnswer::Answer(found) => reply(
                        request.id,
                        ReplyResult::CombatSearchFightsResult(CombatSearchFightsResult {
                            corpus: found.corpus,
                            hits: found
                                .hits
                                .into_iter()
                                .map(|hit| FightSearchHit {
                                    score: hit.score,
                                    summary: FightSummary(match hit.summary {
                                        serde_json::Value::Object(map) => map,
                                        // A summary is an object by construction; an empty one is
                                        // the honest floor if a future builder ever published
                                        // something else, and unlike the snapshot above it costs a
                                        // ROW rather than the whole answer.
                                        _ => serde_json::Map::new(),
                                    }),
                                })
                                .collect(),
                        }),
                    ),
                }
            }

            // ── THE KNOWLEDGE SURFACE (JOS-486, design surface 5) ───────────────────────────────
            //
            // FOUR READS AND A PUSH, and none of them can fail. There is no `notFound` arm anywhere
            // below and that is the design rather than an omission: a name no corpus holds is an
            // ANSWER — `found: false` beside a record carrying every local association the engine
            // could still gather (an item's posky quest uses, a mob's own-loot history and quest
            // cross-ref) — because that is exactly what `lookupItem`/`lookupMob` answer with today
            // and because a hover card with a name in it is never nothing to draw.
            //
            // NOR IS THERE AN `unavailable` ARM. `module.snapshot` has one because a world with no
            // fold cannot answer a module question at all; a corpus question names nothing that
            // could be absent — it is committed data, in this binary, whatever is attached. Only
            // `knowledge.mob` touches the fold, and only for the own-loot HALF of its join, which is
            // honestly empty on an engine that has folded nothing.
            //
            // A MISS IS ANNOUNCED AFTER THE REPLY IS BUILT, not before: the asker gets its answer,
            // and every connection — including this one — hears the name that could not be answered.
            ClientMessage::KnowledgeItemRequest(request) => {
                let name = request.params.name;
                let answer = fold::knowledge::Knowledge::item(&**world.knowledge(), &name);
                knowledge_reply(world, request.id, KnowledgeDomain::Item, name, &answer)
            }

            ClientMessage::KnowledgeMobRequest(request) => {
                let name = request.params.name;
                let answer = world.knowledge_mob(&name);
                knowledge_reply(world, request.id, KnowledgeDomain::Mob, name, &answer)
            }

            // THE ONE READ THAT NEVER MISSES. The spell catalog has no app-side fetcher, so a name
            // it does not carry is not a question anybody can answer — see `KnowledgePushDomain`.
            ClientMessage::KnowledgeSpellRequest(request) => {
                let name = request.params.name;
                let answer = world.knowledge().spell(&name);
                reply(
                    request.id,
                    ReplyResult::KnowledgeResult(KnowledgeResult {
                        domain: KnowledgeDomain::Spell,
                        name,
                        found: answer.found,
                        record: record_of(&answer.record),
                    }),
                )
            }

            ClientMessage::KnowledgeSearchRequest(request) => {
                let params = request.params;
                let hits = world.knowledge().search(
                    &params.query,
                    params.domain.map(|d| d.to_string()).as_deref(),
                    params.limit.and_then(|n| usize::try_from(n).ok()),
                );
                reply(
                    request.id,
                    ReplyResult::KnowledgeSearchResult(
                        serde_json::from_value::<KnowledgeSearchResult>(hits)
                            .unwrap_or_else(|_| empty_search(&params.query)),
                    ),
                )
            }

            // THE PUSH-BACK. `applied` is pinned true by the schema and the shape is what refuses
            // the impossible: `KnowledgePushDomain` has two members, so a `spell` push is a
            // `badParams` refusal one layer up in `classify` rather than a runtime check here. No
            // `count`, because the payload is one entry rather than a list — which is the same
            // sentence `DefineAck` already makes for `buffTrust` and `respawn`.
            ClientMessage::KnowledgeDefineRequest(request) => {
                let params = request.params;
                world.knowledge().define(
                    &params.domain.to_string(),
                    &params.name,
                    &serde_json::Value::Object(params.entry.0),
                );
                reply(
                    request.id,
                    ReplyResult::DefineAck(DefineAck {
                        applied: true,
                        count: None,
                    }),
                )
            }

            // ── LOG DISCOVERY (owner ruling 21, decision sheet 1a — JOS-498) ────────────────────
            //
            // LOGS.SETDIR — THE APP NAMES THE DIRECTORY. It is a command in the `*.define` mould
            // and answers the same ack, and it is deliberately NOT one of that family: those five
            // are FOLD inputs that a world re-applies at every attach's construction and that form
            // part of ruling 18's cache key, and this changes nothing about any fold. So it goes to
            // `set_log_dir` rather than to `define`, and no fold is told anything.
            //
            // NO REFUSAL PATH, for `AlertsDefineRequest`'s reason exactly: a payload that reached
            // here deserialized against the schema. A directory that does not EXIST is not a
            // refusal either — a machine with no EverQuest on it still resolves a path app-side,
            // and what that produces is a `logs.list` answering `missing` rather than a command
            // that failed. The two questions are asked separately on purpose.
            ClientMessage::LogsSetDirRequest(request) => {
                world.set_log_dir(&request.params.dir);
                reply(
                    request.id,
                    ReplyResult::DefineAck(DefineAck {
                        applied: true,
                        // NOT A LIST: one directory, so the ack carries no `count` — the same
                        // sentence `buffTrust.define` and `respawn.define` already make.
                        count: None,
                    }),
                )
            }

            // LOGS.LIST — `listCharacters` in `main/log/config.ts`, moved to the process that owns
            // log files. The scan itself is `crate::logs`; this arm is the envelope and the one
            // refusal.
            //
            // THE ONE REFUSAL IS NEVER HAVING BEEN TOLD, and it is an `unavailable` rather than an
            // empty answer because those are two different facts: an install with no character logs
            // in it is a real state a player is told how to fix (`/log on`), and a question nobody
            // armed is a bug in this app's own connect sequence. A caller handed `[]` for both could
            // not tell them apart, and would draw the empty picker for the second.
            //
            // EVERY OTHER OUTCOME IS AN ANSWER. A missing folder, an unreadable one and an empty
            // one all carry `readable` and the directory they are about — see `LogsListResult`,
            // which argues at length why the verdict rides every reply.
            ClientMessage::LogsListRequest(request) => match world.list_logs() {
                Err(why) => error(request.id, ErrorCode::Unavailable, why),
                Ok((dir, found)) => reply(
                    request.id,
                    ReplyResult::LogsListResult(LogsListResult {
                        dir,
                        readable: found.readable,
                        characters: found.characters,
                    }),
                ),
            },
        }
    }
}

/// The health status as the mark ack spells it.
///
/// THE TWO ENUMS ARE GENERATED FROM TWO SCHEMA DEFINITIONS WITH THE SAME FIVE MEMBERS, so this
/// mapping is exhaustive BY THE COMPILER — a member added to one and not the other stops the build
/// rather than being quietly mapped to the wrong thing. Exactly the argument `world::perf_status`
/// makes for the same shape one file over.
fn mark_status(status: HealthResultStatus) -> SessionMarkAckStatus {
    match status {
        HealthResultStatus::Starting => SessionMarkAckStatus::Starting,
        HealthResultStatus::Attaching => SessionMarkAckStatus::Attaching,
        HealthResultStatus::Folding => SessionMarkAckStatus::Folding,
        HealthResultStatus::Live => SessionMarkAckStatus::Live,
        HealthResultStatus::Idle => SessionMarkAckStatus::Idle,
    }
}

/// THE MOST HITS THIS ENGINE WILL RANK, whoever asks — `world.ts:30`'s own 500.
const MAX_FIGHT_HITS: i64 = 500;

/// The hits a request that named no limit gets — `fightSearch.ts`'s `DEFAULT_LIMIT`. The UI shows a
/// ranked list, not a page of 1,400.
const DEFAULT_FIGHT_HITS: i64 = 50;

/// `Math.min(Math.max(1, Math.floor(limit)), 500)`, and the floor is free: the wire type is an
/// integer, so a fractional limit is a frame the generated types already refused.
///
/// CLAMPED, NEVER REFUSED, which is the difference between this and a view's `window.limit`. A view
/// refuses an over-budget window BY NAME because the client stated a query it will keep re-cutting
/// and a silently-shrunk one it cannot notice is a window it did not ask for. A search is one
/// answer to one keystroke and the ranking is already truncated — so the smaller list IS the
/// answer, and a search box that stopped answering because a number was silly would be the worse
/// failure. `world.ts` made the same call and this is it kept.
fn clamp_hits(limit: Option<i64>) -> usize {
    let wanted = limit.map_or(DEFAULT_FIGHT_HITS, |n| n.clamp(1, MAX_FIGHT_HITS));
    usize::try_from(wanted).unwrap_or(0)
}

/// The wire's opts in the ingest's vocabulary, with every absence resolved to the app's own default.
///
/// THE DEFAULTS ARE `snapshot()`'s, not zero: `maxSegments` absent is 100 because that is what
/// `engine.ts` reads (`opts.maxSegments ?? 100`), and a cap of zero would serve a meter with no
/// fight list at all to a client that asked for the ordinary thing.
fn combat_opts(opts: Option<&CombatSnapshotOpts>) -> CombatOpts {
    /// `engine.ts snapshot`'s `opts.maxSegments ?? 100`.
    const DEFAULT_MAX_SEGMENTS: i64 = 100;
    let Some(opts) = opts else {
        return CombatOpts {
            max_segments: usize::try_from(DEFAULT_MAX_SEGMENTS).unwrap_or(0),
            ..CombatOpts::default()
        };
    };
    CombatOpts {
        selected_id: opts.selected_id.clone(),
        show_unparsed: opts.show_unparsed.unwrap_or(false),
        max_segments: usize::try_from(opts.max_segments.unwrap_or(DEFAULT_MAX_SEGMENTS).max(0))
            .unwrap_or(0),
        timeline: opts.timeline.unwrap_or(false),
    }
}

/// What a JSON value IS, for a diagnostic that has to say why an answer was refused.
fn shape_of(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

/// The reply for a lookup, plus the announcement a miss owes every connection.
fn knowledge_reply(
    world: &World,
    id: RequestId,
    domain: KnowledgeDomain,
    name: String,
    answer: &fold::knowledge::Answer,
) -> Outcome {
    let out = reply(
        id,
        ReplyResult::KnowledgeResult(KnowledgeResult {
            domain,
            name,
            found: answer.found,
            record: record_of(&answer.record),
        }),
    );
    world.announce_knowledge_misses(&fold::knowledge::Knowledge::take_misses(
        &**world.knowledge(),
    ));
    out
}

/// A record onto the wire's open object. A non-object answer is impossible — every path in the
/// corpus builds one — and an empty map is the honest fallback rather than a panic in an op table.
fn record_of(value: &serde_json::Value) -> KnowledgeRecord {
    KnowledgeRecord(value.as_object().cloned().unwrap_or_default())
}

/// The answer a search gives when its own result could not be read back as the wire shape. Nothing
/// produces it today (the corpus builds the shape from the same schema this deserializes against);
/// it exists so the op table has no `unwrap` in it.
fn empty_search(query: &str) -> KnowledgeSearchResult {
    KnowledgeSearchResult {
        query: query.trim().to_owned(),
        total: 0,
        hits: Vec::new(),
    }
}

/// WHAT A DEFINE'S `count` IS — the number of entries a LIST-shaped payload carried, and nothing
/// for a payload that is one object.
///
/// A trait rather than a parameter so the two answers are decided by the payload's own TYPE at each
/// call site: `()` is the family that pushes an object, a slice is the family that pushes a list.
/// A hand-written `Some(n)` at five call sites would be five chances to count the wrong thing.
trait Counted {
    fn count(&self) -> Option<i64>;
}

impl Counted for () {
    fn count(&self) -> Option<i64> {
        None
    }
}

impl<T> Counted for Vec<T> {
    fn count(&self) -> Option<i64> {
        Some(i64::try_from(self.len()).unwrap_or(i64::MAX))
    }
}

/// The payload as the fold reads it — the INNER value (the list, or the prefs object), never the
/// request's params wrapper. The wrapper is the protocol's envelope and the fold has no business
/// knowing the op it arrived under.
fn json<T: serde::Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

/// Record one family's push, apply it to the live fold, and acknowledge it.
fn define(
    world: &World,
    id: RequestId,
    family: &str,
    counted: &dyn Counted,
    payload: serde_json::Value,
) -> Outcome {
    world.define(family, payload);
    reply(
        id,
        ReplyResult::DefineAck(DefineAck {
            applied: true,
            count: counted.count(),
        }),
    )
}

/// Wrap one result in the reply envelope.
fn reply(id: RequestId, result: ReplyResult) -> Outcome {
    Outcome::Send(vec![EngineMessage::Reply(Reply {
        kind: ReplyKind::Reply,
        id,
        // The schema pins this to `true`; an unsuccessful answer is an `ErrorReply`, which is a
        // different message with a different discriminant rather than a flag on this one.
        ok: true,
        result,
    })])
}

/// Refuse one request, by its id.
fn error(id: RequestId, code: ErrorCode, message: String) -> Outcome {
    Outcome::Send(vec![EngineMessage::ErrorReply(ErrorReply {
        kind: ErrorReplyKind::Error,
        id,
        ok: false,
        error: ProtocolError { code, message },
    })])
}

/// What a frame turned out to be when the generated types could not read it as a whole message.
///
/// WHY THIS EXISTS AT ALL — the load-bearing paragraph of this file. `ClientMessage` is an untagged
/// union of seven request types, each with `deny_unknown_fields`. That makes it a perfect
/// discriminator for a message this build knows and a total loss for one it does not: serde tries
/// every arm, every arm fails, and the error says "data did not match any variant" without telling
/// anyone which `id` was in the frame. An engine that cannot name the request id cannot send an
/// `ErrorReply` — the schema requires one on every error — so a client's promise waits forever on
/// an op the engine simply does not have. Answering `unknownOp` is therefore only possible if the
/// raw frame survives the failed parse, which is why the transport's inbound type is
/// `serde_json::Value` and this function exists.
///
/// IT READS EXACTLY TWO FIELDS, `id` and `op`, and only after the typed parse has already failed.
/// Everything the engine does with a message it CAN read goes through the generated types.
pub enum Unreadable {
    /// A well-formed request naming an op this build does not implement.
    UnknownOp {
        /// The request to answer.
        id: RequestId,
        /// What it asked for, for the diagnostic. Bounded before it is quoted — see
        /// [`MAX_QUOTED_OP`].
        op: String,
    },
    /// A request for a known op whose params this build cannot read.
    BadParams {
        /// The request to answer.
        id: RequestId,
        /// The op it named.
        op: String,
    },
    /// Nothing correlatable: no object, no integer `id`, no string `op`. There is no request to
    /// answer, so the connection ends.
    Uncorrelatable,
}

/// The longest op string this engine will quote back in an error message.
///
/// A refusal is a diagnostic and a diagnostic gets pasted into bug reports, so a hostile peer must
/// not be able to choose a megabyte of it. The same reasoning as `MAX_CAPTURE_CHARS` app-side.
const MAX_QUOTED_OP: usize = 64;

/// Decide what to say about a frame the generated types refused.
#[must_use]
pub fn classify(raw: &serde_json::Value) -> Unreadable {
    let (Some(id), Some(op)) = (
        raw.get("id").and_then(serde_json::Value::as_i64),
        raw.get("op").and_then(serde_json::Value::as_str),
    ) else {
        return Unreadable::Uncorrelatable;
    };
    let quoted: String = op.chars().take(MAX_QUOTED_OP).collect();
    if is_known_op(op) {
        Unreadable::BadParams {
            id: RequestId(id),
            op: quoted,
        }
    } else {
        Unreadable::UnknownOp {
            id: RequestId(id),
            op: quoted,
        }
    }
}

/// Turn a classification into the message to send.
#[must_use]
pub fn refuse(what: &Unreadable) -> Option<EngineMessage> {
    let (id, code, message) = match what {
        Unreadable::UnknownOp { id, op } => (
            id,
            ErrorCode::UnknownOp,
            format!("this engine has no op named {op:?}"),
        ),
        Unreadable::BadParams { id, op } => (
            id,
            ErrorCode::BadParams,
            format!("the params of {op:?} are not the shape this protocol version states"),
        ),
        Unreadable::Uncorrelatable => return None,
    };
    match error(RequestId(**id), code, message) {
        Outcome::Send(mut messages) => messages.pop(),
        Outcome::Close(_) => None,
    }
}

/// Is this one of the ops the contract names?
///
/// THE STRINGS COME FROM THE GENERATED TAG ENUMS, never from literals typed here. `session.attach`
/// spelled by hand in this file would be a fourth place the op table lives, and the one that no
/// codegen run would ever correct.
fn is_known_op(op: &str) -> bool {
    [
        HelloOp::Hello.to_string(),
        EchoRequestOp::Echo.to_string(),
        SessionAttachRequestOp::SessionAttach.to_string(),
        SessionHealthRequestOp::SessionHealth.to_string(),
        SessionProgressRequestOp::SessionProgress.to_string(),
        ModuleSnapshotRequestOp::ModuleSnapshot.to_string(),
        PerfSnapshotRequestOp::PerfSnapshot.to_string(),
        PerfBudgetsRequestOp::PerfBudgets.to_string(),
        PerfTimelineRequestOp::PerfTimeline.to_string(),
        ViewSubscribeRequestOp::ViewSubscribe.to_string(),
        ViewUnsubscribeRequestOp::ViewUnsubscribe.to_string(),
        AlertsDefineRequestOp::AlertsDefine.to_string(),
        BuffTrustDefineRequestOp::BuffTrustDefine.to_string(),
        RespawnDefineRequestOp::RespawnDefine.to_string(),
        RespawnConfirmSightingRequestOp::RespawnConfirmSighting.to_string(),
        ComboDefineRequestOp::ComboDefine.to_string(),
        RosterDefineRequestOp::RosterDefine.to_string(),
        SessionMarkAddRequestOp::SessionMarksAdd.to_string(),
        CombatSnapshotRequestOp::CombatSnapshot.to_string(),
        CombatSearchFightsRequestOp::CombatSearchFights.to_string(),
        KnowledgeItemRequestOp::KnowledgeItem.to_string(),
        KnowledgeMobRequestOp::KnowledgeMob.to_string(),
        KnowledgeSpellRequestOp::KnowledgeSpell.to_string(),
        KnowledgeSearchRequestOp::KnowledgeSearch.to_string(),
        KnowledgeDefineRequestOp::KnowledgeDefine.to_string(),
        ResistLevelsRequestOp::ResistLevels.to_string(),
        ResistSpellRequestOp::ResistSpell.to_string(),
        SpellsSearchRequestOp::SpellsSearch.to_string(),
        LogsSetDirRequestOp::LogsSetDir.to_string(),
        LogsListRequestOp::LogsList.to_string(),
    ]
    .iter()
    .any(|known| known == op)
}

#[cfg(test)]
mod tests {
    use super::{
        classify, refuse, Outcome, Session, Unreadable, DEFAULT_SPELL_ROWS, MAX_MOB_LEVEL_ASKS,
        MAX_SPELL_ROWS,
    };
    use crate::world::World;
    use protocol::generated::{ClassAbbr, SpellTableState, SpellsSearchRequestOp};
    use protocol::generated::{
        ClientMessage, EchoParams, EchoRequest, EchoRequestOp, EngineMessage, ErrorCode,
        ErrorReply, Hello, HelloOp, ModuleSnapshotParams, ModuleSnapshotRequest,
        ModuleSnapshotRequestOp, PerfSnapshotRequest, PerfSnapshotRequestOp, ReplyResult,
        RequestId, ResistLevelsRequestOp, SessionAttachParams, SessionAttachRequest,
        SessionAttachRequestOp, SessionHealthRequest, SessionHealthRequestOp, Token,
        ViewDescriptor, ViewSubscribeRequest, ViewSubscribeRequestOp, ViewUnsubscribeParams,
        ViewUnsubscribeRequest, ViewUnsubscribeRequestOp,
    };

    fn echo(id: i64, text: &str) -> ClientMessage {
        ClientMessage::EchoRequest(EchoRequest {
            id: RequestId(id),
            op: EchoRequestOp::Echo,
            params: EchoParams {
                text: text.to_owned(),
            },
        })
    }

    fn subscribe(id: i64) -> ClientMessage {
        ClientMessage::ViewSubscribeRequest(ViewSubscribeRequest {
            id: RequestId(id),
            op: ViewSubscribeRequestOp::ViewSubscribe,
            params: ViewDescriptor {
                source: "loot.ledger".to_owned(),
                filter: None,
                sort: Vec::new(),
                window: None,
            },
        })
    }

    fn unsubscribe(id: i64, subscription: i64) -> ClientMessage {
        ClientMessage::ViewUnsubscribeRequest(ViewUnsubscribeRequest {
            id: RequestId(id),
            op: ViewUnsubscribeRequestOp::ViewUnsubscribe,
            params: ViewUnsubscribeParams {
                subscription: RequestId(subscription),
            },
        })
    }

    fn sent(outcome: Outcome) -> Vec<EngineMessage> {
        match outcome {
            Outcome::Send(messages) => messages,
            Outcome::Close(why) => panic!("expected messages, got a close: {why}"),
        }
    }

    /// A world whose attaches START NOTHING, and one connection joined to it.
    ///
    /// The op table's job is the envelope, and every test here is about a shape rather than about a
    /// fold; giving these tests a real ingest would make them depend on a file, a thread and a spell
    /// DB none of them says anything about. `ingest.rs` and `tests/ingest.rs` own that half.
    fn table() -> (World, Session) {
        let world = World::with_ingest(std::sync::Arc::new(
            |_world, _generation, _log, _state_dir| {},
        ));
        let session = Session::new(world.join().id);
        (world, session)
    }

    /// The path an attach names in this module. Nothing opens it.
    const A_LOG: &str = "C:/nowhere/eqlog_Primitive_freeport.txt";

    #[test]
    fn echo_returns_what_it_was_given() {
        let (world, mut session) = table();
        let messages = sent(session.dispatch(&world, echo(11, "a\nb\tc")));
        let [EngineMessage::Reply(reply)] = messages.as_slice() else {
            panic!("one reply");
        };
        assert_eq!(*reply.id, 11);
        assert!(reply.ok);
        let ReplyResult::EchoResult(result) = &reply.result else {
            panic!("an echo result");
        };
        assert_eq!(result.text, "a\nb\tc");
    }

    #[test]
    fn health_reports_the_worlds_generation() {
        let (world, mut session) = table();
        world.attach(A_LOG, None);
        let messages = sent(session.dispatch(
            &world,
            ClientMessage::SessionHealthRequest(SessionHealthRequest {
                id: RequestId(3),
                op: SessionHealthRequestOp::SessionHealth,
                params: protocol::generated::NoParams {},
            }),
        ));
        let [EngineMessage::Reply(reply)] = messages.as_slice() else {
            panic!("one reply");
        };
        let ReplyResult::HealthResult(result) = &reply.result else {
            panic!("a health result");
        };
        assert_eq!(*result.epoch, 2);
    }

    #[test]
    fn attach_answers_with_the_new_generation() {
        let (world, mut session) = table();
        let messages = sent(session.dispatch(
            &world,
            ClientMessage::SessionAttachRequest(SessionAttachRequest {
                id: RequestId(4),
                op: SessionAttachRequestOp::SessionAttach,
                params: SessionAttachParams {
                    log_path: "C:/nowhere/eqlog_Primitive_freeport.txt".to_owned(),
                    state_dir: None,
                },
            }),
        ));
        let [EngineMessage::Reply(reply)] = messages.as_slice() else {
            panic!("one reply");
        };
        let ReplyResult::AttachResult(result) = &reply.result else {
            panic!("an attach result");
        };
        assert!(result.accepted);
        assert_eq!(*result.epoch, 2);
    }

    #[test]
    fn a_subscription_acknowledges_then_opens_with_an_empty_reset() {
        let (world, mut session) = table();
        let messages = sent(session.dispatch(&world, subscribe(7)));
        let [EngineMessage::Reply(reply), EngineMessage::ResetMessage(reset)] = messages.as_slice()
        else {
            panic!("an ack then a reset, in that order");
        };
        let ReplyResult::SubscribeAck(ack) = &reply.result else {
            panic!("a subscribe ack");
        };
        assert_eq!(*ack.subscription, 7);
        assert!(ack.subscribed);
        assert_eq!(*reset.id, 7);
        assert_eq!(reset.total, 0);
        assert!(reset.rows.is_empty());
        assert_eq!(*reset.epoch, 1);
    }

    #[test]
    fn unsubscribing_closes_the_stream_once_and_then_reports_not_found() {
        let (world, mut session) = table();
        sent(session.dispatch(&world, subscribe(7)));

        let first = sent(session.dispatch(&world, unsubscribe(8, 7)));
        let [EngineMessage::Reply(reply)] = first.as_slice() else {
            panic!("one reply");
        };
        let ReplyResult::SubscribeAck(ack) = &reply.result else {
            panic!("a subscribe ack");
        };
        assert_eq!(*ack.subscription, 7);
        assert!(!ack.subscribed);

        let again = sent(session.dispatch(&world, unsubscribe(9, 7)));
        let [EngineMessage::ErrorReply(refusal)] = again.as_slice() else {
            panic!("a refusal");
        };
        assert_eq!(*refusal.id, 9);
        assert!(!refusal.ok);
        assert!(matches!(refusal.error.code, ErrorCode::NotFound));
    }

    #[test]
    fn one_connection_cannot_unsubscribe_anothers_stream() {
        let (world, mut mine) = table();
        // A SECOND CONNECTION, joined to the SAME world: the isolation is between listeners, so a
        // test that shared one membership would prove nothing.
        let mut theirs = Session::new(world.join().id);
        sent(mine.dispatch(&world, subscribe(7)));

        let messages = sent(theirs.dispatch(&world, unsubscribe(1, 7)));
        let [EngineMessage::ErrorReply(refusal)] = messages.as_slice() else {
            panic!("a refusal");
        };
        assert!(matches!(refusal.error.code, ErrorCode::NotFound));
    }

    #[test]
    fn a_second_hello_ends_the_conversation() {
        let (world, mut session) = table();
        let hello = ClientMessage::Hello(Hello {
            op: HelloOp::Hello,
            protocol_version: protocol::PROTOCOL_VERSION,
            token: Token::try_from(
                "0f7d2c9a4b1e6538aa03d7c5e9124f86b0d3a7c1e2f4085967ab3cd12e4f7089",
            )
            .expect("a token"),
        });
        assert!(matches!(session.dispatch(&world, hello), Outcome::Close(_)));
    }

    #[test]
    fn an_op_this_build_has_never_heard_of_is_named_and_refused() {
        let raw = serde_json::json!({"id": 42, "op": "loot.summon", "params": {}});
        let what = classify(&raw);
        assert!(matches!(what, Unreadable::UnknownOp { .. }));
        let Some(EngineMessage::ErrorReply(refusal)) = refuse(&what) else {
            panic!("a refusal");
        };
        assert_eq!(*refusal.id, 42);
        assert!(matches!(refusal.error.code, ErrorCode::UnknownOp));
    }

    #[test]
    fn a_known_op_with_the_wrong_params_is_a_different_refusal() {
        let raw = serde_json::json!({"id": 43, "op": "echo", "params": {"txt": "typo"}});
        let what = classify(&raw);
        let Some(EngineMessage::ErrorReply(refusal)) = refuse(&what) else {
            panic!("a refusal");
        };
        assert_eq!(*refusal.id, 43);
        assert!(matches!(refusal.error.code, ErrorCode::BadParams));
    }

    #[test]
    fn a_frame_with_no_request_in_it_is_not_answerable() {
        for raw in [
            serde_json::json!({"op": "echo"}),
            serde_json::json!({"id": 1}),
            serde_json::json!([1, 2, 3]),
            serde_json::json!("hello"),
            serde_json::json!({"id": "seven", "op": "echo"}),
        ] {
            let what = classify(&raw);
            assert!(matches!(what, Unreadable::Uncorrelatable), "{raw}");
            assert!(refuse(&what).is_none());
        }
    }

    #[test]
    fn module_snapshot_is_an_op_this_build_knows() {
        // THE KNOWN-OP LIST IS BUILT FROM THE GENERATED TAG ENUMS and a new op must be added to it,
        // or a request with a typo'd param gets `unknownOp` — which sends a client hunting for a
        // missing feature instead of for its own mistake. This is the pin for the op JOS-478 added.
        let raw =
            serde_json::json!({"id": 44, "op": "module.snapshot", "params": {"modul": "loot"}});
        let Some(EngineMessage::ErrorReply(refusal)) = refuse(&classify(&raw)) else {
            panic!("a refusal");
        };
        assert!(matches!(refusal.error.code, ErrorCode::BadParams));
    }

    #[test]
    fn a_module_snapshot_with_no_fold_is_unavailable_rather_than_not_found() {
        // A world whose attaches start NOTHING has no ingest to ask, and the two refusals mean
        // different things to a client — see the dispatch arm.
        let (world, mut session) = table();
        world.attach(A_LOG, None);
        let messages = sent(session.dispatch(
            &world,
            ClientMessage::ModuleSnapshotRequest(ModuleSnapshotRequest {
                id: RequestId(12),
                op: ModuleSnapshotRequestOp::ModuleSnapshot,
                params: ModuleSnapshotParams {
                    module: "loot".to_owned(),
                },
            }),
        ));
        let [EngineMessage::ErrorReply(refusal)] = messages.as_slice() else {
            panic!("a refusal");
        };
        assert_eq!(*refusal.id, 12);
        assert!(matches!(refusal.error.code, ErrorCode::Unavailable));
    }

    // ── resist.levels (JOS-497 item 1) ────────────────────────────────────────────────────────

    /// Build one `resist.levels` naming `count` creatures, all the same name — the CONTENT does not
    /// matter to any claim below, only how many there are.
    fn resist_levels(id: i64, count: usize) -> ClientMessage {
        ClientMessage::ResistLevelsRequest(protocol::generated::ResistLevelsRequest {
            id: RequestId(id),
            op: ResistLevelsRequestOp::ResistLevels,
            params: protocol::generated::ResistLevelsParams {
                mobs: vec!["a fire giant warlord".to_owned(); count],
            },
        })
    }

    fn refusal_for(message: ClientMessage) -> ErrorReply {
        let (world, mut session) = table();
        world.attach(A_LOG, None);
        let messages = sent(session.dispatch(&world, message));
        let [EngineMessage::ErrorReply(refusal)] = messages.as_slice() else {
            panic!("a refusal");
        };
        refusal.clone()
    }

    #[test]
    fn resist_levels_is_an_op_this_build_knows() {
        // The same pin the two ops above carry, and for the same failure: an op missing from the
        // known-op list answers `unknownOp` to a request with a typo'd param, which sends a client
        // hunting for a feature that is right there.
        let raw = serde_json::json!({"id": 46, "op": "resist.levels", "params": {"mob": "a lava guardian"}});
        let Some(EngineMessage::ErrorReply(refusal)) = refuse(&classify(&raw)) else {
            panic!("a refusal");
        };
        assert!(matches!(refusal.error.code, ErrorCode::BadParams));
    }

    #[test]
    fn a_resist_levels_naming_more_creatures_than_the_bound_is_refused_by_name() {
        // NOT TRUNCATED. A caller that believed it asked about thirty-three creatures and was
        // answered about thirty-two has no way to notice — JOS-478's law about descriptors, which
        // is the same law. The message names the bound so the refusal is actionable.
        let refusal = refusal_for(resist_levels(13, MAX_MOB_LEVEL_ASKS + 1));
        assert_eq!(*refusal.id, 13);
        assert!(matches!(refusal.error.code, ErrorCode::BadParams));
        assert!(
            refusal
                .error
                .message
                .contains(&MAX_MOB_LEVEL_ASKS.to_string()),
            "the refusal states the bound: {}",
            refusal.error.message
        );
    }

    #[test]
    fn a_resist_levels_naming_nobody_is_refused_rather_than_answered_emptily() {
        // `minItems` is part of the contract, and silently agreeing with a request the schema
        // forbids is how the two sides drift apart while both look green.
        let refusal = refusal_for(resist_levels(14, 0));
        assert!(matches!(refusal.error.code, ErrorCode::BadParams));
    }

    #[test]
    fn a_resist_levels_with_no_fold_is_unavailable() {
        // The one refusal this op has that is about the world rather than the request. A world
        // whose attaches start nothing has no ingest to ask — and note there is no `notFound` arm
        // to confuse it with: a creature nothing states a level for is a MISSING ROW, not an error.
        let refusal = refusal_for(resist_levels(15, 1));
        assert_eq!(*refusal.id, 15);
        assert!(matches!(refusal.error.code, ErrorCode::Unavailable));
    }

    // ── spells.search (JOS-507) ───────────────────────────────────────────────────────────────

    /// One `spells.search`. Every filter is optional, so the helper takes the two the claims below
    /// actually vary and leaves the rest absent.
    fn spells_search(
        id: i64,
        text: Option<&str>,
        classes: &[ClassAbbr],
        limit: Option<i64>,
    ) -> ClientMessage {
        ClientMessage::SpellsSearchRequest(protocol::generated::SpellsSearchRequest {
            id: RequestId(id),
            op: SpellsSearchRequestOp::SpellsSearch,
            params: protocol::generated::SpellsSearchParams {
                text: text.map(str::to_owned),
                category: None,
                subcategory: None,
                classes: classes.to_vec(),
                sort: None,
                offset: None,
                limit,
            },
        })
    }

    /// A staged install: a directory with a `Logs/` beside a hand-authored `spells_us.txt` and
    /// `dbstr_us.txt`. HAND-AUTHORED, always — the client's files are Daybreak's and no slice of
    /// either may enter this repo.
    fn staged_install(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "engined-ops-spells-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(dir.join("Logs")).expect("a scratch install");

        let row = |id: &str, name: &str, cat: &str, sub: &str, class: usize, level: &str| {
            let mut f = vec!["0".to_string(); 173];
            for field in f.iter_mut().take(52).skip(36) {
                *field = "255".to_string();
            }
            f[0] = id.to_owned();
            f[1] = name.to_owned();
            f[86] = cat.to_owned();
            f[87] = sub.to_owned();
            f[36 + class] = level.to_owned();
            f.join("^")
        };
        std::fs::write(
            dir.join("spells_us.txt"),
            format!(
                "{}\n{}\n{}\n",
                // SHD 1, Taps / Health — the row the owner's screenshot settled.
                row("341", "Lifetap", "114", "43", 4, "1"),
                // SHD 34, Taps / Power Tap — no `tap` in the name at all.
                row("343", "Siphon Strength", "114", "76", 4, "34"),
                // WIZ 29, Direct Damage — matched by neither name nor type.
                row("600", "Lightning Bolt", "25", "0", 11, "29"),
            ),
        )
        .expect("the staged spell table");
        std::fs::write(
            dir.join("dbstr_us.txt"),
            "114^5^Taps^0^\n43^5^Health^0^\n76^5^Power Tap^0^\n25^5^Direct Damage^0^\n",
        )
        .expect("the staged string table");
        dir
    }

    #[test]
    fn spells_search_is_an_op_this_build_knows() {
        // The known-op list is built from the generated tag enums, and an op missing from it answers
        // `unknownOp` to a request with a typo'd param — which sends a client hunting for a missing
        // feature instead of for its own mistake.
        let raw = serde_json::json!({"id": 60, "op": "spells.search", "params": {"txt": "tap"}});
        let Some(EngineMessage::ErrorReply(refusal)) = refuse(&classify(&raw)) else {
            panic!("a refusal");
        };
        assert!(matches!(refusal.error.code, ErrorCode::BadParams));
    }

    #[test]
    fn a_spells_search_with_nothing_attached_is_unavailable() {
        // THE ONE REFUSAL THIS OP HAS, and it is about the world rather than the request: no log
        // means no install directory to look beside. Note this canNOT use `refusal_for`, which
        // attaches — see the second half.
        let (world, mut session) = table();
        let messages = sent(session.dispatch(&world, spells_search(61, Some("tap"), &[], None)));
        let [EngineMessage::ErrorReply(refusal)] = messages.as_slice() else {
            panic!("a refusal, got {messages:?}");
        };
        assert_eq!(*refusal.id, 61);
        assert!(matches!(refusal.error.code, ErrorCode::Unavailable));
    }

    #[test]
    fn an_attached_install_with_no_spell_table_answers_rather_than_refuses() {
        // AND THIS IS THE HALF THAT MATTERS MORE. An `EQ_INSTALL_DIR` pointed at a folder of logs
        // with no EverQuest behind it is a real configuration, and what it must produce is a list
        // that says so — naming the path it looked at — never an error a surface has to translate.
        // Flattening it into `unavailable` would also put an ordinary state into every error log
        // this app collects.
        let (world, mut session) = table();
        world.attach(A_LOG, None);
        let messages = sent(session.dispatch(&world, spells_search(64, Some("tap"), &[], None)));
        let [EngineMessage::Reply(reply)] = messages.as_slice() else {
            panic!("a reply, got {messages:?}");
        };
        let ReplyResult::SpellsSearchResult(result) = &reply.result else {
            panic!("a spells.search result");
        };
        assert!(matches!(result.spell_table, SpellTableState::Missing));
        assert!(result.spells.is_empty());
        assert!(result.categories.is_empty());
        assert_eq!(result.total, 0);
        assert!(
            result.path.ends_with("spells_us.txt"),
            "the sentence a missing table produces has to name a place"
        );
    }

    #[test]
    fn a_tap_search_answers_off_the_players_own_two_files() {
        let dir = staged_install("tap");
        let (world, mut session) = table();
        world.attach(
            dir.join("Logs")
                .join("eqlog_Primitive_freeport.txt")
                .to_string_lossy()
                .as_ref(),
            None,
        );
        let messages = sent(session.dispatch(
            &world,
            spells_search(62, Some("tap"), &[ClassAbbr::Shd, ClassAbbr::Brd], None),
        ));
        let [EngineMessage::Reply(reply)] = messages.as_slice() else {
            panic!("a reply, got {messages:?}");
        };
        let ReplyResult::SpellsSearchResult(result) = &reply.result else {
            panic!("a spells.search result");
        };
        // LEVEL DESCENDING, the in-game window's order.
        let names: Vec<&str> = result.spells.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["Siphon Strength", "Lifetap"]);
        // …AND `Siphon Strength` HAS NO `tap` IN ITS NAME. It is in the list because its CATEGORY is
        // `Taps`, which is the whole capability this op exists for.
        let siphon = &result.spells[0];
        assert_eq!(siphon.level, 34);
        assert_eq!(siphon.category.as_deref(), Some("Taps"));
        assert_eq!(siphon.subcategory.as_deref(), Some("Power Tap"));
        assert_eq!(siphon.classes.len(), 1);
        assert!(matches!(siphon.classes[0].class, ClassAbbr::Shd));
        assert_eq!(siphon.classes[0].level, 34);
        // The words come from the player's own string table and ride the answer so a control can be
        // drawn from them — the app cannot ship this list.
        assert_eq!(result.total, 2);
        assert_eq!(result.categories.len(), 1);
        assert_eq!(result.categories[0].name, "Taps");
        assert_eq!(result.categories[0].subcategories, ["Health", "Power Tap"]);
        // `spellTable` and `path` ride EVERY answer, and the field is `spellTable` rather than
        // `table` because `resist.spell` owns that word in the app's guard matrix.
        assert!(matches!(result.spell_table, SpellTableState::Ok));
        assert!(result.path.ends_with("spells_us.txt"));
        assert_eq!(result.offset, 0);
        assert_eq!(result.limit, DEFAULT_SPELL_ROWS);
    }

    #[test]
    fn an_over_long_limit_is_clamped_rather_than_refused_and_the_reply_says_so() {
        let dir = staged_install("clamp");
        let (world, mut session) = table();
        world.attach(
            dir.join("Logs")
                .join("eqlog_Primitive_freeport.txt")
                .to_string_lossy()
                .as_ref(),
            None,
        );
        let messages = sent(session.dispatch(&world, spells_search(63, None, &[], Some(100_000))));
        let [EngineMessage::Reply(reply)] = messages.as_slice() else {
            panic!("a reply");
        };
        let ReplyResult::SpellsSearchResult(result) = &reply.result else {
            panic!("a spells.search result");
        };
        // ECHOING THE EFFECTIVE NUMBER rather than the requested one is what lets a caller notice it
        // was clamped — a silently shrunk window it cannot see is a window it did not ask for.
        assert_eq!(result.limit, MAX_SPELL_ROWS);
        // No class scope is every class, so the wizard's row is here too.
        assert_eq!(result.total, 3);
    }

    #[test]
    fn a_repeated_class_is_deduped_rather_than_scanned_ten_thousand_times() {
        // THE BOUND ON THIS LIST LIVES HERE rather than in the schema: a `maxItems` with no
        // `minItems` anchor generates a tuple union in TypeScript that no ordinary array satisfies,
        // and this list must be allowed to be empty. So the columns are sorted and deduped, and a
        // stranger sending the same class ten thousand times gets the same answer as one sending it
        // once — for the same work, which is the half that matters.
        let dir = staged_install("dedupe");
        let (world, mut session) = table();
        world.attach(
            dir.join("Logs")
                .join("eqlog_Primitive_freeport.txt")
                .to_string_lossy()
                .as_ref(),
            None,
        );
        let mut answer = |classes: &[ClassAbbr]| {
            let messages = sent(session.dispatch(&world, spells_search(65, None, classes, None)));
            let [EngineMessage::Reply(reply)] = messages.as_slice() else {
                panic!("a reply");
            };
            let ReplyResult::SpellsSearchResult(result) = &reply.result else {
                panic!("a spells.search result");
            };
            result
                .spells
                .iter()
                .map(|s| s.name.clone())
                .collect::<Vec<_>>()
        };
        let once = answer(&[ClassAbbr::Shd]);
        let many = answer(&vec![ClassAbbr::Shd; 10_000]);
        assert_eq!(once, many);
        assert_eq!(once, ["Siphon Strength", "Lifetap"]);
    }

    // ── logs.setDir / logs.list (owner ruling 21, decision sheet 1a — JOS-498) ─────────────────

    /// One `logs.setDir`, naming a directory. Nothing opens it.
    fn set_dir(id: i64, dir: &str) -> ClientMessage {
        ClientMessage::LogsSetDirRequest(protocol::generated::LogsSetDirRequest {
            id: RequestId(id),
            op: protocol::generated::LogsSetDirRequestOp::LogsSetDir,
            params: protocol::generated::LogsSetDirParams {
                dir: dir.to_owned(),
            },
        })
    }

    /// One `logs.list`, which names nothing at all — the directory is pushed, never sent.
    fn list_logs(id: i64) -> ClientMessage {
        ClientMessage::LogsListRequest(protocol::generated::LogsListRequest {
            id: RequestId(id),
            op: protocol::generated::LogsListRequestOp::LogsList,
            params: protocol::generated::NoParams {},
        })
    }

    #[test]
    fn the_log_ops_are_ops_this_build_knows() {
        // The pin every op in this table carries, and for the same failure: an op missing from the
        // known-op list answers `unknownOp` to a request with a typo'd param, which sends a client
        // hunting for a feature that is right there.
        for raw in [
            serde_json::json!({"id": 61, "op": "logs.setDir", "params": {"folder": "C:/EQ/Logs"}}),
            serde_json::json!({"id": 62, "op": "logs.list", "params": {"dir": "C:/EQ/Logs"}}),
        ] {
            let Some(EngineMessage::ErrorReply(refusal)) = refuse(&classify(&raw)) else {
                panic!("a refusal");
            };
            assert!(matches!(refusal.error.code, ErrorCode::BadParams));
        }
    }

    #[test]
    fn a_logs_list_before_anybody_named_a_directory_is_unavailable() {
        // AN EMPTY LIST WOULD BE THE WRONG ANSWER, and that is the whole reason this refusal
        // exists: an install with no character logs in it is a real state a player is told how to
        // fix, and a question nobody armed is a bug in the app's connect sequence. A caller handed
        // `[]` for both would draw the empty picker for the second.
        let (world, mut session) = table();
        let messages = sent(session.dispatch(&world, list_logs(63)));
        let [EngineMessage::ErrorReply(refusal)] = messages.as_slice() else {
            panic!("a refusal");
        };
        assert_eq!(*refusal.id, 63);
        assert!(matches!(refusal.error.code, ErrorCode::Unavailable));
    }

    #[test]
    fn the_pushed_directory_is_acknowledged_and_then_enumerated() {
        let dir = std::env::temp_dir().join(format!("engined-ops-logs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a scratch logs dir");
        std::fs::write(dir.join("eqlog_Primitive_freeport.txt"), "").expect("a staged log");
        let named = dir.to_string_lossy().into_owned();

        let (world, mut session) = table();
        // THE ACK IS `DefineAck` WITH NO `count`. One directory is not a list, which is the same
        // sentence `buffTrust.define` and `respawn.define` already make about a payload that is one
        // object — and it is why this op joins the ack family in the app-side guard matrix.
        let acked = sent(session.dispatch(&world, set_dir(64, &named)));
        let [EngineMessage::Reply(reply)] = acked.as_slice() else {
            panic!("one reply");
        };
        let ReplyResult::DefineAck(ack) = &reply.result else {
            panic!("a define ack");
        };
        assert!(ack.applied);
        assert_eq!(ack.count, None);

        // NO ATTACH ANYWHERE ABOVE, deliberately: a fresh install has characters to choose between
        // before there is anything to fold, and that is the launch this op exists for.
        let listed = sent(session.dispatch(&world, list_logs(65)));
        let [EngineMessage::Reply(reply)] = listed.as_slice() else {
            panic!("one reply");
        };
        let ReplyResult::LogsListResult(result) = &reply.result else {
            panic!("a logs list result");
        };
        // THE ECHO IS THE CLIENT'S STALENESS TEST, so it has to come back exactly as pushed.
        assert_eq!(result.dir, named);
        assert!(matches!(
            result.readable,
            protocol::generated::LogsDirReadable::Ok
        ));
        assert_eq!(result.characters.len(), 1);
        assert_eq!(result.characters[0].name, "Primitive");
        assert_eq!(result.characters[0].server, "freeport");
    }

    #[test]
    fn a_second_push_replaces_the_first_and_a_missing_folder_is_an_answer() {
        // THE COMMAND LAW, at one value: the latest push is the whole of what the app has said, so
        // a settings change is a push rather than a reconciliation. And the folder it names does
        // not have to exist — a machine with EverQuest installed somewhere else resolves a path
        // app-side every launch, and what that produces is `missing` rather than a refusal.
        let (world, mut session) = table();
        sent(session.dispatch(&world, set_dir(66, "C:/first/Logs")));
        sent(session.dispatch(&world, set_dir(67, "C:/nowhere/at/all/Logs")));
        let listed = sent(session.dispatch(&world, list_logs(68)));
        let [EngineMessage::Reply(reply)] = listed.as_slice() else {
            panic!("one reply");
        };
        let ReplyResult::LogsListResult(result) = &reply.result else {
            panic!("a logs list result");
        };
        assert_eq!(result.dir, "C:/nowhere/at/all/Logs");
        assert!(matches!(
            result.readable,
            protocol::generated::LogsDirReadable::Missing
        ));
        assert!(result.characters.is_empty());
    }

    #[test]
    fn perf_snapshot_is_an_op_this_build_knows() {
        // Same pin as `module_snapshot_is_an_op_this_build_knows`, and for the same failure: an op
        // missing from the known-op list answers `unknownOp` to a request with a typo'd param,
        // which sends a client hunting for a feature that is right there.
        let raw = serde_json::json!({"id": 45, "op": "perf.snapshot", "params": {"who": "me"}});
        let Some(EngineMessage::ErrorReply(refusal)) = refuse(&classify(&raw)) else {
            panic!("a refusal");
        };
        assert!(matches!(refusal.error.code, ErrorCode::BadParams));
    }

    #[test]
    fn surface_eights_other_two_ops_are_ops_this_build_knows() {
        // The same pin, twice more (JOS-502). It matters more here than for most ops: all three
        // perf requests take `NoParams`, so a typo'd param is the ONLY way a client can spell one
        // of them wrong, and the known-op list is the only thing standing between that typo and an
        // `unknownOp` that says the feature does not exist.
        for op in ["perf.budgets", "perf.timeline"] {
            let raw = serde_json::json!({"id": 46, "op": op, "params": {"who": "me"}});
            let Some(EngineMessage::ErrorReply(refusal)) = refuse(&classify(&raw)) else {
                panic!("a refusal for {op}");
            };
            assert!(
                matches!(refusal.error.code, ErrorCode::BadParams),
                "{op} answered {:?}",
                refusal.error.code
            );
        }
    }

    #[test]
    fn a_perf_snapshot_with_no_fold_answers_rather_than_refusing() {
        // THE ASYMMETRY WITH `module.snapshot` IS THE POINT. A world with no fold cannot answer a
        // module question at all, so that op says `unavailable`; a perf question names nothing that
        // could be absent, and an engine that has not attached yet is simply IDLE. A panel drawing
        // the engine on every launch depends on this being an answer.
        let (world, mut session) = table();
        let messages = sent(session.dispatch(
            &world,
            ClientMessage::PerfSnapshotRequest(PerfSnapshotRequest {
                id: RequestId(13),
                op: PerfSnapshotRequestOp::PerfSnapshot,
                params: protocol::generated::NoParams {},
            }),
        ));
        let [EngineMessage::Reply(reply)] = messages.as_slice() else {
            panic!("one reply");
        };
        assert_eq!(*reply.id, 13);
        let ReplyResult::PerfSnapshotResult(result) = &reply.result else {
            panic!("a perf snapshot result");
        };
        assert!(matches!(
            result.status,
            protocol::generated::PerfSnapshotResultStatus::Idle
        ));
        assert_eq!(*result.epoch, 1);
        assert!(result.serve.is_empty());
        // Absent, not zero — nothing has been measured.
        assert_eq!(result.ingest.scan_ms, None);
        assert_eq!(result.ingest.scan_bytes, None);
        assert_eq!(result.ingest.spell_db_ms, None);
    }

    #[test]
    fn a_perf_snapshot_counts_the_subscriptions_that_are_open_right_now() {
        // The world's own half of the answer, and the half no meter could give: the meter counts
        // frames that were sent and knows nothing about who is still listening. A source with a
        // subscriber and no frames yet is a row, because "opened and nothing came" and "never
        // opened" are different things to be looking at.
        let (world, mut session) = table();
        sent(session.dispatch(&world, subscribe(7)));
        let messages = sent(session.dispatch(
            &world,
            ClientMessage::PerfSnapshotRequest(PerfSnapshotRequest {
                id: RequestId(14),
                op: PerfSnapshotRequestOp::PerfSnapshot,
                params: protocol::generated::NoParams {},
            }),
        ));
        let [EngineMessage::Reply(reply)] = messages.as_slice() else {
            panic!("one reply");
        };
        let ReplyResult::PerfSnapshotResult(result) = &reply.result else {
            panic!("a perf snapshot result");
        };
        let [row] = result.serve.as_slice() else {
            panic!("one watched source, got {:?}", result.serve);
        };
        assert_eq!(row.source, "loot.ledger");
        assert_eq!(row.subscribers, 1);
        assert_eq!(row.frames, 0, "the serve pass has not run");
        assert_eq!(row.fold_to_frame_us_mean, None, "nothing was timed");

        // …and the count is LIVE: closing the window drops it, and the row goes with it because
        // nothing was ever served over it either.
        sent(session.dispatch(&world, unsubscribe(8, 7)));
        let after = sent(session.dispatch(
            &world,
            ClientMessage::PerfSnapshotRequest(PerfSnapshotRequest {
                id: RequestId(15),
                op: PerfSnapshotRequestOp::PerfSnapshot,
                params: protocol::generated::NoParams {},
            }),
        ));
        let [EngineMessage::Reply(reply)] = after.as_slice() else {
            panic!("one reply");
        };
        let ReplyResult::PerfSnapshotResult(result) = &reply.result else {
            panic!("a perf snapshot result");
        };
        assert!(result.serve.is_empty());
    }

    // ── THE KNOWLEDGE SURFACE (JOS-486) ────────────────────────────────────────────────────────
    //
    // THESE TESTS HOLD THEIR OWN CORPUS, and that is not tidiness. `knowledge::shared()` is a
    // process-wide singleton with an overlay and a miss ledger in it, and a test binary runs its
    // tests in one process: a `knowledge.define` in one test would be a hit in another, and a name
    // announced once would never be announced again. `World::with_parts` exists for exactly this.
    // The CORPUS ITSELF is the real committed one either way — this crate proves the op table over
    // the bytes the product ships, and `knowledge`'s own suite proves the indexes.

    fn knowledge_table() -> (World, Session, crate::world::Membership) {
        let world = World::with_parts(
            std::sync::Arc::new(|_world, _generation, _log, _state_dir| {}),
            std::sync::Arc::new(knowledge::Corpus::new()),
        );
        let membership = world.join();
        let session = Session::new(membership.id);
        (world, session, membership)
    }

    fn ask(id: i64, op: &str, params: serde_json::Value) -> ClientMessage {
        serde_json::from_value(serde_json::json!({ "id": id, "op": op, "params": params }))
            .expect("the request is the shape the schema states")
    }

    fn knowledge_result(messages: &[EngineMessage]) -> &protocol::generated::KnowledgeResult {
        let [EngineMessage::Reply(reply)] = messages else {
            panic!("one reply, got {messages:?}");
        };
        let ReplyResult::KnowledgeResult(result) = &reply.result else {
            panic!("a knowledge result");
        };
        result
    }

    /// Every `knowledgeMiss` frame this connection was sent, drained.
    fn misses(membership: &crate::world::Membership) -> Vec<(String, String)> {
        let mut out = Vec::new();
        while let Ok(message) = membership.inbox.try_recv() {
            if let EngineMessage::KnowledgeMissMessage(miss) = message {
                out.push((miss.domain.to_string(), miss.name));
            }
        }
        out
    }

    #[test]
    fn an_item_the_committed_corpus_holds_is_answered_and_nobody_is_asked_to_fetch() {
        let (world, mut session, membership) = knowledge_table();
        let messages = sent(session.dispatch(
            &world,
            ask(
                1,
                "knowledge.item",
                serde_json::json!({ "name": "Cloak of Flames" }),
            ),
        ));
        let result = knowledge_result(&messages);
        assert!(result.found);
        assert_eq!(result.name, "Cloak of Flames");
        assert_eq!(
            result.record.get("name"),
            Some(&serde_json::json!("Cloak of Flames"))
        );
        assert!(
            misses(&membership).is_empty(),
            "a corpus hit announces nothing"
        );
    }

    #[test]
    fn a_miss_answers_the_asker_and_tells_every_connection_once() {
        let (world, mut session, membership) = knowledge_table();
        // A SECOND CONNECTION, joined to the same world: a miss is connection-WIDE, so a bystander
        // that asked for nothing hears it too — which is what makes one app fetch it once however
        // many windows are open.
        let bystander = world.join();

        let messages = sent(session.dispatch(
            &world,
            ask(
                1,
                "knowledge.item",
                serde_json::json!({ "name": "Shard of Nothing" }),
            ),
        ));
        let result = knowledge_result(&messages);
        assert!(!result.found, "the corpus has no page for it");
        // AND IT STILL ANSWERS. `found: false` is not an absence — the record is a card with the
        // player's own name in it, which is what `lookupItem` hands back today.
        assert_eq!(
            result.record.get("name"),
            Some(&serde_json::json!("Shard of Nothing"))
        );
        assert_eq!(result.record.get("offline"), Some(&serde_json::json!(true)));

        assert_eq!(
            misses(&membership),
            vec![("item".to_owned(), "Shard of Nothing".to_owned())]
        );
        assert_eq!(
            misses(&bystander),
            vec![("item".to_owned(), "Shard of Nothing".to_owned())]
        );

        // …and asking again asks the app for nothing: the etiquette law is the engine's too.
        sent(session.dispatch(
            &world,
            ask(
                2,
                "knowledge.item",
                serde_json::json!({ "name": "Shard of Nothing" }),
            ),
        ));
        assert!(misses(&membership).is_empty());
    }

    #[test]
    fn the_answer_pushed_back_turns_the_same_lookup_into_a_hit() {
        // THE WHOLE OF BOUNDARY VERDICT 5, in one conversation: the engine cannot fetch, the app
        // can, and this is how the answer crosses back.
        let (world, mut session, membership) = knowledge_table();
        let before = sent(session.dispatch(
            &world,
            ask(
                1,
                "knowledge.item",
                serde_json::json!({ "name": "Shard of Nothing" }),
            ),
        ));
        assert!(!knowledge_result(&before).found);
        assert_eq!(misses(&membership).len(), 1);

        let ack = sent(session.dispatch(
            &world,
            ask(
                2,
                "knowledge.define",
                serde_json::json!({
                    "domain": "item",
                    "name": "Shard of Nothing",
                    "entry": { "page": "Shard of Nothing", "lore": true }
                }),
            ),
        ));
        let [EngineMessage::Reply(reply)] = ack.as_slice() else {
            panic!("one reply");
        };
        let ReplyResult::DefineAck(ack) = &reply.result else {
            panic!("a define ack");
        };
        assert!(ack.applied);
        assert_eq!(ack.count, None, "one entry is not a list");

        let after = sent(session.dispatch(
            &world,
            ask(
                3,
                "knowledge.item",
                serde_json::json!({ "name": "Shard of Nothing" }),
            ),
        ));
        let result = knowledge_result(&after);
        assert!(result.found);
        assert_eq!(result.record.get("lore"), Some(&serde_json::json!(true)));
        assert!(misses(&membership).is_empty(), "nothing left to ask about");
    }

    #[test]
    fn a_mob_card_is_a_real_card_before_the_first_attach() {
        // The asymmetry with `module.snapshot` restated one surface up: a corpus question names
        // nothing that could be absent. The one part a fold owns — your loot history — is honestly
        // empty on an engine that has folded nothing, which is not the same as unavailable.
        let (world, mut session, _membership) = knowledge_table();
        let messages = sent(session.dispatch(
            &world,
            ask(
                1,
                "knowledge.mob",
                serde_json::json!({ "name": "a sand giant" }),
            ),
        ));
        let result = knowledge_result(&messages);
        assert!(result.found);
        assert_eq!(result.name, "a sand giant");
        assert_eq!(
            result.record.get("dropsSeen"),
            None,
            "absent, never an empty claim"
        );
    }

    #[test]
    fn the_spell_surface_answers_and_the_search_surface_ranks() {
        let (world, mut session, membership) = knowledge_table();
        let spell = sent(session.dispatch(
            &world,
            ask(
                1,
                "knowledge.spell",
                serde_json::json!({ "name": "Complete Heal" }),
            ),
        ));
        let result = knowledge_result(&spell);
        assert!(result.found);
        assert!(matches!(
            result.domain,
            protocol::generated::KnowledgeDomain::Spell
        ));
        // A spell the catalog lacks announces NOTHING — there is no app-side spell fetcher to ask.
        sent(session.dispatch(
            &world,
            ask(
                2,
                "knowledge.spell",
                serde_json::json!({ "name": "Spell Of Nothing" }),
            ),
        ));
        assert!(misses(&membership).is_empty());

        let search = sent(session.dispatch(
            &world,
            ask(
                3,
                "knowledge.search",
                serde_json::json!({ "query": "Cloak of Flames", "limit": 5 }),
            ),
        ));
        let [EngineMessage::Reply(reply)] = search.as_slice() else {
            panic!("one reply");
        };
        let ReplyResult::KnowledgeSearchResult(hits) = &reply.result else {
            panic!("a search result");
        };
        assert_eq!(hits.query, "Cloak of Flames");
        assert!(hits.total >= 1);
        assert_eq!(hits.hits[0].name, "Cloak of Flames", "exact ranks first");
        assert!(hits.hits.len() <= 5);
    }

    #[test]
    fn every_knowledge_op_is_an_op_this_build_knows() {
        // THE SAME PIN `module.snapshot` and `perf.snapshot` carry, five times: an op missing from
        // the known-op list answers `unknownOp` to a request with a typo'd param, which sends a
        // client hunting for a feature that is right there.
        for op in [
            "knowledge.item",
            "knowledge.mob",
            "knowledge.spell",
            "knowledge.search",
            "knowledge.define",
        ] {
            let raw = serde_json::json!({"id": 1, "op": op, "params": {"nam": "typo"}});
            let Some(EngineMessage::ErrorReply(refusal)) = refuse(&classify(&raw)) else {
                panic!("a refusal for {op}");
            };
            assert!(matches!(refusal.error.code, ErrorCode::BadParams), "{op}");
        }
    }

    #[test]
    fn a_push_for_a_corpus_with_no_fetcher_is_refused_by_shape() {
        // `KnowledgePushDomain` has two members, so `spell` is not a runtime check this file makes
        // — it is a frame the generated types cannot read, and `classify` names it `badParams`.
        let raw = serde_json::json!({
            "id": 1, "op": "knowledge.define",
            "params": { "domain": "spell", "name": "Complete Heal", "entry": {} }
        });
        let Some(EngineMessage::ErrorReply(refusal)) = refuse(&classify(&raw)) else {
            panic!("a refusal");
        };
        assert!(matches!(refusal.error.code, ErrorCode::BadParams));
    }

    #[test]
    fn a_hostile_op_name_cannot_choose_the_length_of_the_diagnostic() {
        let raw = serde_json::json!({"id": 1, "op": "x".repeat(4096), "params": {}});
        let Unreadable::UnknownOp { op, .. } = classify(&raw) else {
            panic!("an unknown op");
        };
        assert_eq!(op.len(), super::MAX_QUOTED_OP);
    }
}
