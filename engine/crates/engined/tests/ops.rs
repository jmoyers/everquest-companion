//! EVERY OP, OVER A REAL SOCKET, AGAINST THE REAL BINARY.
//!
//! The op table has unit tests beside the code; those prove the shapes. THIS suite proves the
//! shapes survive the round trip — serialization, framing, a kernel's chunking, a second process's
//! deserialization — and it is the only place the CONNECTION-WIDE behaviour can be seen at all,
//! because an epoch that reaches every connection needs more than one connection to be a claim.

mod harness;

use harness::{attach, echo, health, progress, subscribe, unsubscribe, Engine};
use protocol::generated::{EngineMessage, ErrorCode, HealthResultStatus, ReplyResult};

#[test]
fn echo_returns_the_text_it_was_given() {
    let engine = Engine::start();
    let mut client = engine.connected();

    // Newlines, tabs, quotes and a backslash-n that is NOT a newline: the payload that would break
    // a line-framed wire if JSON did not escape control characters inside strings.
    let text = "line one\nline two\t\"quoted\"\\n \u{1f5e1}";
    client.send(&echo(1, text));

    let EngineMessage::Reply(reply) = client.recv() else {
        panic!("a reply");
    };
    assert_eq!(*reply.id, 1);
    assert!(reply.ok);
    let ReplyResult::EchoResult(result) = &reply.result else {
        panic!("an echo result");
    };
    assert_eq!(result.text, text);
}

#[test]
fn health_reports_an_idle_world_with_a_generation_and_an_uptime() {
    let engine = Engine::start();
    let mut client = engine.connected();

    client.send(&health(2));

    let EngineMessage::Reply(reply) = client.recv() else {
        panic!("a reply");
    };
    assert_eq!(*reply.id, 2);
    let ReplyResult::HealthResult(result) = &reply.result else {
        panic!("a health result");
    };
    assert!(
        matches!(result.status, HealthResultStatus::Idle),
        "phase 0 folds nothing, so idle is the only honest status"
    );
    assert_eq!(*result.epoch, 1, "a launch is generation one");
    assert!(result.uptime_ms >= 0);
}

#[test]
fn attach_bumps_the_generation_and_announces_it_to_every_connection() {
    let engine = Engine::start();
    let mut attacher = engine.connected();
    let mut bystander = engine.connected();

    attacher.send(&attach(
        3,
        "C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog.txt",
    ));

    // THE ANNOUNCEMENT PRECEDES THE REPLY ON THE ATTACHER'S OWN CONNECTION, and that ordering is
    // pinned rather than accidental: the bump and its broadcast happen in one critical section, so
    // the announcement is already in every outbox — this one included — before the reply is
    // composed. A client can therefore never see a reply naming a generation it has not been told
    // about.
    let EngineMessage::EpochMessage(announced) = attacher.recv() else {
        panic!("the attacher hears the bump first");
    };
    assert_eq!(*announced.epoch, 2);
    assert!(matches!(
        announced.reason,
        protocol::generated::EpochReason::Attach
    ));
    assert!(
        announced.progress.is_none(),
        "a bump that starts no fold claims no progress"
    );

    let EngineMessage::Reply(reply) = attacher.recv() else {
        panic!("then the reply");
    };
    assert_eq!(*reply.id, 3);
    let ReplyResult::AttachResult(result) = &reply.result else {
        panic!("an attach result");
    };
    assert!(result.accepted);
    assert_eq!(*result.epoch, 2);

    // CONNECTION-WIDE means the connection that did nothing hears it too.
    let EngineMessage::EpochMessage(heard) = bystander.recv() else {
        panic!("every connection hears a bump");
    };
    assert_eq!(*heard.epoch, 2);

    // And the world is process-global: the bystander's own health says so.
    bystander.send(&health(4));
    let EngineMessage::Reply(reply) = bystander.recv() else {
        panic!("a reply");
    };
    let ReplyResult::HealthResult(result) = &reply.result else {
        panic!("a health result");
    };
    assert_eq!(*result.epoch, 2);
}

#[test]
fn the_generation_only_ever_goes_forward() {
    let engine = Engine::start();
    let mut client = engine.connected();

    let mut seen = Vec::new();
    for id in 0..3 {
        client.send(&attach(id, "C:/nowhere.txt"));
        let EngineMessage::EpochMessage(announced) = client.recv() else {
            panic!("a bump");
        };
        seen.push(*announced.epoch);
        let EngineMessage::Reply(_) = client.recv() else {
            panic!("a reply");
        };
    }

    assert_eq!(seen, vec![2, 3, 4]);
}

#[test]
fn progress_is_acknowledged_as_the_subscription_it_is() {
    let engine = Engine::start();
    let mut client = engine.connected();

    client.send(&progress(5));

    let EngineMessage::Reply(reply) = client.recv() else {
        panic!("a reply");
    };
    assert_eq!(*reply.id, 5);
    let ReplyResult::SubscribeAck(ack) = &reply.result else {
        panic!("an ack naming the channel");
    };
    assert_eq!(*ack.subscription, 5);
    assert!(ack.subscribed);

    // NOTHING FOLLOWS, and that is the honest answer in phase 0: the attach stub starts no fold, so
    // there is no progress to report. The frames, when they exist, are `EpochMessage`s carrying
    // `progress` on this same connection-wide channel — which is exactly what the next assertion
    // shows arriving, carrying no progress.
    client.send(&attach(6, "C:/nowhere.txt"));
    let EngineMessage::EpochMessage(announced) = client.recv() else {
        panic!("a bump");
    };
    assert!(announced.progress.is_none());
}

#[test]
fn a_subscription_acknowledges_then_opens_with_an_empty_reset() {
    let engine = Engine::start();
    let mut client = engine.connected();

    client.send(&subscribe(7, "loot.ledger"));

    let EngineMessage::Reply(reply) = client.recv() else {
        panic!("an ack first");
    };
    assert_eq!(*reply.id, 7);
    let ReplyResult::SubscribeAck(ack) = &reply.result else {
        panic!("a subscribe ack");
    };
    assert_eq!(*ack.subscription, 7);
    assert!(ack.subscribed);

    // Reset-then-diffs is rule 1 of the diff protocol, and it holds for an empty window: a client
    // must be able to tell an empty view from a view that never opened.
    let EngineMessage::ResetMessage(reset) = client.recv() else {
        panic!("then the window");
    };
    assert_eq!(*reset.id, 7);
    assert_eq!(*reset.epoch, 1);
    assert_eq!(reset.total, 0);
    assert!(reset.rows.is_empty());
}

#[test]
fn unsubscribing_closes_the_stream_and_saying_it_twice_is_not_found() {
    let engine = Engine::start();
    let mut client = engine.connected();

    client.send(&subscribe(7, "loot.ledger"));
    let _ack = client.recv();
    let _reset = client.recv();

    client.send(&unsubscribe(8, 7));
    let EngineMessage::Reply(reply) = client.recv() else {
        panic!("a reply");
    };
    let ReplyResult::SubscribeAck(ack) = &reply.result else {
        panic!("a subscribe ack");
    };
    assert_eq!(*ack.subscription, 7);
    assert!(!ack.subscribed);

    client.send(&unsubscribe(9, 7));
    let EngineMessage::ErrorReply(refusal) = client.recv() else {
        panic!("a refusal");
    };
    assert_eq!(*refusal.id, 9);
    assert!(!refusal.ok);
    assert!(matches!(refusal.error.code, ErrorCode::NotFound));
}

#[test]
fn subscriptions_belong_to_their_own_connection() {
    let engine = Engine::start();
    let mut mine = engine.connected();
    let mut theirs = engine.connected();

    // Client-chosen ids collide across connections all the time; a subscription must never be
    // reachable from a connection that did not open it.
    mine.send(&subscribe(7, "loot.ledger"));
    let _ack = mine.recv();
    let _reset = mine.recv();

    theirs.send(&unsubscribe(1, 7));
    let EngineMessage::ErrorReply(refusal) = theirs.recv() else {
        panic!("a refusal");
    };
    assert!(matches!(refusal.error.code, ErrorCode::NotFound));
}

#[test]
fn an_unknown_op_is_refused_by_name_and_the_connection_survives() {
    let engine = Engine::start();
    let mut client = engine.connected();

    // Hand-written on purpose: an op this build has never heard of has no generated type to build
    // it from, and answering it is the whole point of the test.
    client.send_bytes(b"{\"id\":42,\"op\":\"loot.summon\",\"params\":{}}\n");

    let EngineMessage::ErrorReply(refusal) = client.recv() else {
        panic!("a refusal");
    };
    assert_eq!(*refusal.id, 42);
    assert!(!refusal.ok);
    assert!(matches!(refusal.error.code, ErrorCode::UnknownOp));

    // A REFUSED REQUEST IS NOT A BROKEN CONNECTION. The client asked for something that does not
    // exist; the conversation is still perfectly well-formed.
    client.send(&echo(43, "still talking"));
    let EngineMessage::Reply(reply) = client.recv() else {
        panic!("a reply");
    };
    assert_eq!(*reply.id, 43);
}

#[test]
fn a_known_op_with_params_this_build_cannot_read_is_a_different_refusal() {
    let engine = Engine::start();
    let mut client = engine.connected();

    client.send_bytes(b"{\"id\":44,\"op\":\"echo\",\"params\":{\"txt\":\"typo\"}}\n");

    let EngineMessage::ErrorReply(refusal) = client.recv() else {
        panic!("a refusal");
    };
    assert_eq!(*refusal.id, 44);
    assert!(matches!(refusal.error.code, ErrorCode::BadParams));

    client.send(&echo(45, "still talking"));
    let EngineMessage::Reply(reply) = client.recv() else {
        panic!("a reply");
    };
    assert_eq!(*reply.id, 45);
}

#[test]
fn a_malformed_frame_closes_the_connection() {
    let engine = Engine::start();
    let mut client = engine.connected();

    // Not a message at all. The two sides no longer agree about what is on the wire, so nothing
    // after it could be trusted either — the transport's own semantics, and there is no request id
    // to hang an error on.
    client.send_bytes(b"{ this is not json\n");

    client.expect_closed();
}

#[test]
fn a_frame_with_no_request_in_it_closes_the_connection() {
    let engine = Engine::start();
    let mut client = engine.connected();

    // Valid JSON, valid frame, no `id` — nothing to correlate a refusal with, so by the schema's
    // own rule ("a failure with no request behind it closes the connection") it ends here.
    client.send_bytes(b"{\"op\":\"echo\",\"params\":{\"text\":\"x\"}}\n");

    client.expect_closed();
}

#[test]
fn one_connections_malformed_frame_does_not_disturb_another() {
    let engine = Engine::start();
    let mut survivor = engine.connected();
    let mut breaker = engine.connected();

    // Bytes that are not even valid UTF-8, which is the refusal the transport documents as never a
    // lossy accept: a peer that cannot spell its own strings is a peer whose message must not be
    // guessed at.
    breaker.send_bytes(b"\xff\xfe{\"id\":1,\"op\":\"echo\"}\n");
    breaker.expect_closed();

    survivor.send(&echo(1, "unbothered"));
    let EngineMessage::Reply(reply) = survivor.recv() else {
        panic!("a reply");
    };
    assert_eq!(*reply.id, 1);

    // And the world it shares is intact.
    survivor.send(&health(2));
    let EngineMessage::Reply(reply) = survivor.recv() else {
        panic!("a reply");
    };
    assert!(matches!(reply.result, ReplyResult::HealthResult(_)));
}
