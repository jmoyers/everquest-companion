//! THE WORKED MOMENTS, PROVEN IN RUST.
//!
//! `protocol/fixtures/*.json` holds the four worked moments from the subscription-diff section of
//! `docs/plans/data-server.md`, plus the phase-0 handshake. They are the FIRST cross-language
//! artifacts in this repo: this suite deserializes every one of them into the generated types and
//! re-serializes it, and `tests/protocolSchema.test.mts` does the same on the TypeScript side over
//! the same bytes. A shape either language cannot express is a red suite in that language, which
//! is the only way a "contract" between two codebases stays one.
//!
//! ROUND-TRIP MEANS VERBATIM. The comparison is over parsed JSON values rather than bytes — key
//! order and whitespace are not part of the contract, and no JSON serializer promises them — but
//! nothing else is forgiven. A dropped field, an added default, an integer that came back as a
//! float: all of those are a failed assertion here. That last one is not hypothetical; it is why
//! `protocol::cell::Cell` is hand-written.

use std::fs;
use std::path::{Path, PathBuf};

use protocol::generated::{
    ClientMessage, DiffOp, EngineMessage, EpochReason, ErrorCode, HealthResultStatus,
    ProtocolMessage, ReplyResult, PROTOCOL_VERSION,
};

/// One line of a fixture conversation.
struct Frame {
    dir: String,
    raw: serde_json::Value,
}

/// One fixture file: a named moment and the messages it is made of.
struct Fixture {
    name: String,
    moment: String,
    frames: Vec<Frame>,
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("the crate is three levels below the repo root")
        .to_path_buf()
}

fn fixtures() -> Vec<Fixture> {
    let dir = repo_root().join("protocol").join("fixtures");
    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    assert!(!names.is_empty(), "no fixtures in {}", dir.display());

    names
        .into_iter()
        .map(|name| {
            let text = fs::read_to_string(dir.join(&name)).expect("fixture is readable");
            let doc: serde_json::Value = serde_json::from_str(&text)
                .unwrap_or_else(|e| panic!("{name} is not valid JSON: {e}"));
            let moment = doc["moment"]
                .as_str()
                .expect("every fixture names its moment")
                .to_owned();
            let frames = doc["messages"]
                .as_array()
                .expect("every fixture carries a messages array")
                .iter()
                .map(|frame| Frame {
                    dir: frame["dir"]
                        .as_str()
                        .expect("every frame names a direction")
                        .to_owned(),
                    raw: frame["message"].clone(),
                })
                .collect();
            Fixture {
                name,
                moment,
                frames,
            }
        })
        .collect()
}

/// Deserialize one frame into the union its direction names, then serialize it back.
fn round_trip(frame: &Frame, fixture: &str) -> serde_json::Value {
    match frame.dir.as_str() {
        "client" => {
            let typed: ClientMessage = serde_json::from_value(frame.raw.clone())
                .unwrap_or_else(|e| panic!("{fixture}: not a ClientMessage: {e}\n{}", frame.raw));
            serde_json::to_value(&typed).expect("a ClientMessage serializes")
        }
        "engine" => {
            let typed: EngineMessage = serde_json::from_value(frame.raw.clone())
                .unwrap_or_else(|e| panic!("{fixture}: not an EngineMessage: {e}\n{}", frame.raw));
            serde_json::to_value(&typed).expect("an EngineMessage serializes")
        }
        other => panic!("{fixture}: unknown direction {other}"),
    }
}

// ---- 1. every fixture, verbatim ---------------------------------------------------------------

#[test]
fn every_worked_moment_round_trips_verbatim() {
    let all = fixtures();
    let mut frames = 0;
    for fixture in &all {
        for frame in &fixture.frames {
            let back = round_trip(frame, &fixture.name);
            assert_eq!(
                back, frame.raw,
                "{} ({}): a message did not survive the round trip",
                fixture.name, fixture.moment
            );
            frames += 1;
        }
    }
    assert!(frames >= 12, "only {frames} frames were exercised");
}

#[test]
fn every_message_is_also_a_protocol_message() {
    // The root type the transport seam is generic over has to accept everything either side can
    // send, or a transport could not carry the whole protocol.
    for fixture in &fixtures() {
        for frame in &fixture.frames {
            let typed: ProtocolMessage = serde_json::from_value(frame.raw.clone())
                .unwrap_or_else(|e| panic!("{}: not a ProtocolMessage: {e}", fixture.name));
            assert_eq!(
                serde_json::to_value(&typed).expect("serializes"),
                frame.raw,
                "{}: ProtocolMessage lost something on the way back",
                fixture.name
            );
        }
    }
}

#[test]
fn the_four_plan_doc_moments_are_all_here() {
    let names: Vec<String> = fixtures().into_iter().map(|f| f.name).collect();
    for expected in [
        "01-subscribe.json",
        "02-live-diff.json",
        "03-meter-tick.json",
        "04-character-switch.json",
    ] {
        assert!(
            names.contains(&expected.to_owned()),
            "{expected} is missing"
        );
    }
}

// ---- 2. the rules the moments are there to demonstrate -----------------------------------------

fn engine_frames(file: &str) -> Vec<EngineMessage> {
    fixtures()
        .into_iter()
        .find(|f| f.name == file)
        .unwrap_or_else(|| panic!("{file} is missing"))
        .frames
        .iter()
        .filter(|f| f.dir == "engine")
        .map(|f| serde_json::from_value(f.raw.clone()).expect("an engine frame"))
        .collect()
}

#[test]
fn rule_one_a_subscription_opens_with_a_full_reset() {
    let [ack, reset] = engine_frames("01-subscribe.json")
        .try_into()
        .expect("an ack and a reset");

    // THE ACK IS NOT THE DATA. It says the subscription exists; the reset says what is in it. Two
    // messages rather than one because a subscription can be opened over a view whose first fold
    // has not landed yet, and a client that conflated them would have nothing to render and no way
    // to tell that from an empty view.
    let EngineMessage::Reply(ack) = ack else {
        panic!("a subscribe request is acknowledged before its data")
    };
    assert_eq!(*ack.id, 7);
    let ReplyResult::SubscribeAck(ack) = ack.result else {
        panic!("view.subscribe answers with a SubscribeAck")
    };
    assert_eq!(*ack.subscription, 7);
    assert!(ack.subscribed);

    let EngineMessage::ResetMessage(reset) = reset else {
        panic!("a subscription must open with a reset");
    };
    assert_eq!(*reset.id, 7);
    assert_eq!(*reset.epoch, 3);
    assert_eq!(reset.total, 1834, "total counts the VIEW, not the window");
    assert!(!reset.rows.is_empty());
}

#[test]
fn rule_two_an_update_carries_only_the_cells_that_moved() {
    let [diff] = engine_frames("03-meter-tick.json")
        .try_into()
        .expect("one engine frame");
    let EngineMessage::DiffMessage(diff) = diff else {
        panic!("a meter tick is a diff")
    };
    assert!(
        diff.total.is_none(),
        "the row count did not move, so total is absent"
    );

    let DiffOp::UpdateOp(update) = &diff.ops[0] else {
        panic!("the first op is an update")
    };
    assert_eq!(update.cells.len(), 3, "only the three cells that changed");
    for moved in ["damage", "dps", "share"] {
        assert!(update.cells.contains_key(moved), "{moved} is missing");
    }
    assert!(
        !update.cells.contains_key("name"),
        "a cell that did not change must be ABSENT, not resent"
    );

    // …and the insert names an anchor. Exactly one of before/after, which the schema cannot say.
    let DiffOp::InsertOp(insert) = &diff.ops[1] else {
        panic!("the second op is an insert")
    };
    assert!(
        insert.before.is_some() ^ insert.after.is_some(),
        "an insert names exactly one anchor"
    );
    assert_eq!(
        insert.after.as_deref().map(String::as_str),
        Some("ally:Rowel")
    );
}

#[test]
fn a_live_diff_moves_the_window_and_says_so() {
    let [diff] = engine_frames("02-live-diff.json")
        .try_into()
        .expect("one engine frame");
    let EngineMessage::DiffMessage(diff) = diff else {
        panic!("expected a diff")
    };
    assert_eq!(diff.total, Some(1835), "total moved, so it is present");
    assert_eq!(diff.ops.len(), 2);
    let DiffOp::InsertOp(insert) = &diff.ops[0] else {
        panic!("a kill inserts a row")
    };
    assert_eq!(
        insert.before.as_deref().map(String::as_str),
        Some("loot:9412")
    );
    let DiffOp::DropOp(dropped) = &diff.ops[1] else {
        panic!("the oldest row falls out")
    };
    assert_eq!(dropped.key.as_str(), "loot:8790");
}

#[test]
fn rule_three_an_epoch_bump_is_connection_wide_and_the_reset_follows_it() {
    let frames = engine_frames("04-character-switch.json");
    let [bump, reset] = frames.try_into().expect("a bump and a reset");

    let EngineMessage::EpochMessage(bump) = bump else {
        panic!("expected an epoch message")
    };
    assert_eq!(*bump.epoch, 4);
    assert!(matches!(bump.reason, EpochReason::Attach));
    let progress = bump.progress.expect("an attach reports its fold progress");
    // EXACT equality on an f64 is right here, and only here: this is the same decimal literal
    // parsed by the same routine that produced the fixture, so both sides land on the identical
    // nearest-f64. It is the byte-verbatim claim, restated at the field level - if it ever needed
    // an epsilon, the round-trip assertion above would already have failed.
    assert_eq!(
        progress.pct, 62.4,
        "the fold percent, fractional and unrounded"
    );
    assert_eq!(progress.events, 1_571_003);

    // …AND IT GOES BACK OUT AS THE SAME TEXT. This is the whole reason the worked example uses a
    // fractional value: `pct` is an f64, and Rust writes a whole f64 as `62.0`, which would not be
    // the `62` the plan doc prints. Pinned rather than assumed, because the claim the fixtures make
    // is byte-verbatim across two languages and this is the one field where the two could differ.
    let text = serde_json::to_string(&progress).expect("progress serializes");
    assert!(
        text.contains("\"pct\":62.4"),
        "the fold percent did not come back as 62.4: {text}"
    );

    let EngineMessage::ResetMessage(reset) = reset else {
        panic!("expected a reset")
    };
    assert_eq!(*reset.epoch, 4, "the reset is in the NEW generation");
    assert_eq!(*reset.id, 7, "the same subscription, re-reset");
    assert!(reset.rows.is_empty());
    assert_eq!(reset.total, 0);
}

#[test]
fn rule_four_rows_are_render_ready_scalars() {
    let [_ack, reset] = engine_frames("01-subscribe.json")
        .try_into()
        .expect("an ack and a reset");
    let EngineMessage::ResetMessage(reset) = reset else {
        panic!("expected a reset")
    };
    for row in &reset.rows {
        assert!(!row.key.is_empty(), "every row is identified");
        assert!(!row.cells.is_empty(), "every row says something");
        for (field, cell) in row.cells.iter() {
            assert!(
                protocol::Cell::is_scalar(cell.as_json()),
                "{field} is not render-ready"
            );
        }
    }
}

// ---- 3. the handshake and the reply envelope ---------------------------------------------------

#[test]
fn the_handshake_presents_and_answers_this_build_s_version() {
    let fixture = fixtures()
        .into_iter()
        .find(|f| f.name == "05-handshake.json")
        .expect("handshake");
    let ClientMessage::Hello(hello) =
        serde_json::from_value(fixture.frames[0].raw.clone()).expect("the first frame is a hello")
    else {
        panic!("the FIRST message on a connection is always a hello");
    };
    assert_eq!(hello.protocol_version, PROTOCOL_VERSION);
    assert!(protocol::token::well_formed(&hello.token));

    let EngineMessage::HelloReply(reply) =
        serde_json::from_value(fixture.frames[1].raw.clone()).expect("the answer")
    else {
        panic!("a hello is answered by a hello");
    };
    assert!(reply.ok);
    assert_eq!(reply.protocol_version, PROTOCOL_VERSION);
}

#[test]
fn ok_agrees_with_kind_in_every_reply_the_repo_ships() {
    // `kind` is the discriminant both sides branch on; `ok` is the ticket's spelling of the same
    // fact and a one-field check for a caller that does not want to match. The schema pins the
    // value with `enum: [true] / [false]` and a 2020-12 validator enforces it, but the Rust type
    // is a plain bool - typify does not specialize a boolean constant. So the agreement is
    // asserted here, over every reply this repo commits.
    for fixture in &fixtures() {
        for frame in &fixture.frames {
            if frame.dir != "engine" {
                continue;
            }
            match serde_json::from_value(frame.raw.clone()).expect("an engine message") {
                EngineMessage::Reply(reply) => {
                    assert!(reply.ok, "{}: a reply said ok:false", fixture.name)
                }
                EngineMessage::ErrorReply(err) => {
                    assert!(!err.ok, "{}: an error said ok:true", fixture.name);
                }
                _ => {}
            }
        }
    }
}

#[test]
fn a_message_from_the_wrong_direction_is_refused() {
    // The two unions are not interchangeable, and that is what keeps an engine from being handed
    // its own output. Without the typed tag enums this would silently succeed.
    let hello = serde_json::json!({
        "op": "hello",
        "token": "0f7d2c9a4b1e6538aa03d7c5e9124f86b0d3a7c1e2f4085967ab3cd12e4f7089",
        "protocolVersion": PROTOCOL_VERSION
    });
    assert!(serde_json::from_value::<EngineMessage>(hello).is_err());

    let reset = serde_json::json!({ "kind": "reset", "id": 1, "epoch": 0, "total": 0, "rows": [] });
    assert!(serde_json::from_value::<ClientMessage>(reset).is_err());
}

#[test]
fn two_ops_with_identical_parameter_shapes_stay_apart() {
    // `session.health` and `session.progress` are structurally identical - same id, same op field,
    // same empty params. Before the tag properties were given real types, an untagged union
    // deserialized BOTH as the first variant and the op silently vanished. This is the pin.
    let progress = serde_json::json!({ "id": 4, "op": "session.progress", "params": {} });
    let typed: ClientMessage =
        serde_json::from_value(progress.clone()).expect("a progress request");
    assert!(
        matches!(typed, ClientMessage::SessionProgressRequest(_)),
        "session.progress was read as something else"
    );
    assert_eq!(serde_json::to_value(&typed).expect("serializes"), progress);
}

// ---- 4. the fold serves (JOS-478) --------------------------------------------------------------

#[test]
fn a_module_snapshot_carries_whatever_shape_its_module_publishes() {
    // THE POINT OF THE MOMENT. `kills` publishes an object, `loot` publishes an array, and the
    // protocol names neither: `ModuleState` is replaced by `serde_json::Value` on this side
    // exactly so both survive. A generated multi-type enum would have lowered the numbers inside
    // them to f64 as well, which is the `Cell` defect one level up.
    let frames = engine_frames("06-module-snapshot.json");
    let mut shapes: Vec<(String, bool)> = Vec::new();
    for frame in &frames {
        let EngineMessage::Reply(reply) = frame else {
            continue;
        };
        let ReplyResult::ModuleSnapshotResult(snapshot) = &reply.result else {
            continue;
        };
        shapes.push((snapshot.module.clone(), snapshot.state.is_object()));
        assert!(snapshot.seq >= 0, "a hydration cursor is not negative");
    }
    assert_eq!(
        shapes,
        vec![("kills".to_owned(), true), ("loot".to_owned(), false)],
        "the moment must demonstrate BOTH published shapes"
    );

    // AND THE COUNTS INSIDE STAY INTEGRAL. This is the whole reason for the replacement: a `41`
    // that came back `41.0` would fail the verbatim round trip above, and this says so at the
    // field rather than leaving it to a whole-message compare to explain.
    let ReplyResult::ModuleSnapshotResult(kills) = module_result(&frames, "kills") else {
        panic!("a kills snapshot")
    };
    assert_eq!(kills.state["mobs"]["a sand giant"]["count"], 41);
    assert!(kills.state["mobs"]["a sand giant"]["count"].is_i64());
}

#[test]
fn a_module_the_registry_does_not_carry_is_not_found() {
    // The registry is the authority. An empty state would be a lie about a module that does not
    // exist, and `loot.ledger` is the trap worth pinning: it is a VIEW source name, and a caller
    // that confuses the two must be told so rather than handed nothing.
    let refusal = engine_frames("06-module-snapshot.json")
        .into_iter()
        .find_map(|frame| match frame {
            EngineMessage::ErrorReply(err) => Some(err),
            _ => None,
        })
        .expect("the moment refuses one name");
    assert!(matches!(refusal.error.code, ErrorCode::NotFound));
    assert!(!refusal.ok);
}

#[test]
fn health_states_its_coordinate_only_once_it_has_one() {
    // OPTIONAL IS THE HONEST SHAPE (ruling 18 law 3). The first health answer in the moment is a
    // fresh process: no attach, so no mark, no count, no log clock — ABSENT, never zero, because
    // a zero is a measurement and nobody took one. The last answer is live and carries all three.
    let frames = engine_frames("06-module-snapshot.json");
    let mut healths = frames.iter().filter_map(|frame| match frame {
        EngineMessage::Reply(reply) => match &reply.result {
            ReplyResult::HealthResult(health) => Some(health),
            _ => None,
        },
        _ => None,
    });

    let fresh = healths.next().expect("the first health answer");
    assert!(matches!(fresh.status, HealthResultStatus::Idle));
    assert!(fresh.mark.is_none());
    assert!(fresh.events.is_none());
    assert!(fresh.last_event_ts.is_none());

    let live = healths.next().expect("the health answer after the fold");
    assert!(matches!(live.status, HealthResultStatus::Live));
    let mark = live.mark.as_ref().expect("a live fold has a mark");
    assert!(mark.log.ends_with("eqlog_Primitive_freeport.txt"));
    assert_eq!(mark.offset, 9_185_240);
    assert_eq!(live.events, Some(139_860));
    assert_eq!(live.last_event_ts, Some(1_787_181_707_000));
}

// ---- 5. the combat surface (JOS-485) -----------------------------------------------------------

#[test]
fn a_combat_snapshot_says_which_clock_it_was_taken_by() {
    // THE CENTRAL CLAIM OF THE OP. A mid-fold answer is stamped with the LOG's own clock, because a
    // replay is not a moment in time; a live one is stamped with the process's, because a meter has
    // to age while the log is quiet. The two answers here are five seconds apart on a fold whose
    // last event is the same in both — which is the difference, on the wire, in one comparison.
    let mut answers = engine_frames("08-combat-snapshot.json")
        .into_iter()
        .filter_map(|frame| match frame {
            EngineMessage::Reply(reply) => match reply.result {
                ReplyResult::CombatSnapshotResult(snapshot) => Some(snapshot),
                _ => None,
            },
            _ => None,
        });

    let folding = answers.next().expect("the mid-fold answer");
    assert_eq!(folding.now, 1_787_181_707_000, "the log's own last stamp");
    // …and the keys the caller did not ask for are ABSENT rather than null. `timeline` is the one
    // that has to be both — absent when unasked, present-and-null when asked and unresolvable —
    // and this is the half `JSON.stringify` drops over there.
    assert!(
        !folding.snapshot.contains_key("timeline"),
        "an unasked timeline is not a key"
    );
    assert!(
        !folding.snapshot.contains_key("zone"),
        "no zone line folded yet, so there is no zone to state"
    );
    // THE INTEGERS SURVIVED, which is the whole reason `CombatState` is a raw map: a damage total
    // that came back as 43504.0 would fail the verbatim round trip above, and this says so at the
    // field rather than leaving a whole-message compare to explain it.
    let you = &folding.snapshot["selected"]["entities"][0];
    assert_eq!(you["total"], 43_504);
    assert!(you["total"].is_i64());

    let live = answers.next().expect("the live answer");
    assert!(
        live.now > folding.now,
        "a live meter ages past the log's last line: {} vs {}",
        live.now,
        folding.now
    );
    // Asked for, and resolved to nothing: the key is present and null.
    assert_eq!(live.snapshot["timeline"], serde_json::Value::Null);
    assert_eq!(live.snapshot["selectedId"], "zone");
}

#[test]
fn a_search_that_found_nothing_still_says_how_much_it_looked_through() {
    // `corpus` IS NOT THE RESULT SET, and the two empty answers are what make that a real claim
    // rather than a description: an empty query and a query nothing matched produce the identical
    // empty `hits` beside the identical 1,428, because both mean "draw no results" and the
    // difference between them is the query the client already holds.
    let results: Vec<_> = engine_frames("09-combat-search.json")
        .into_iter()
        .filter_map(|frame| match frame {
            EngineMessage::Reply(reply) => match reply.result {
                ReplyResult::CombatSearchFightsResult(found) => Some(found),
                _ => None,
            },
            _ => None,
        })
        .collect();
    let [found, empty_query, no_match] = results.as_slice() else {
        panic!("three answers, got {}", results.len());
    };
    assert_eq!(found.hits.len(), 2);
    assert_eq!(found.corpus, 1428);
    assert!(empty_query.hits.is_empty());
    assert_eq!(
        empty_query.corpus, 1428,
        "an empty box searched nothing, and there was plenty to search"
    );
    assert!(no_match.hits.is_empty());
    assert_eq!(no_match.corpus, 1428);

    // A HIT'S SUMMARY IS THE FOLD'S OWN ROW, carried whole. `durationSec` is a float and `total` is
    // an integer in the same object, which is exactly what an open map preserves and a generated
    // struct would have flattened to two f64s.
    let top = &found.hits[0].summary;
    assert_eq!(top["name"], "a zol ghoul knight");
    assert!(top["total"].is_i64());
    assert!(top["durationSec"].is_f64());
    // Ties break by RECENCY: the two hits score identically and the newer `startTs` is first.
    assert!(
        (found.hits[0].score - found.hits[1].score).abs() < f64::EPSILON,
        "the fixture's two hits are a tie, which is what makes the order a claim"
    );
    assert!(top["startTs"].as_i64() > found.hits[1].summary["startTs"].as_i64());
}

/// The reply result of the first `module.snapshot` answer naming `module`.
fn module_result(frames: &[EngineMessage], module: &str) -> ReplyResult {
    frames
        .iter()
        .find_map(|frame| match frame {
            EngineMessage::Reply(reply) => match &reply.result {
                ReplyResult::ModuleSnapshotResult(snapshot) if snapshot.module == module => {
                    Some(reply.result.clone())
                }
                _ => None,
            },
            _ => None,
        })
        .unwrap_or_else(|| panic!("no snapshot of {module}"))
}
