//! THE SPAWN CONTRACT, END TO END. Five clauses, each asserted against the real binary:
//! the token arrives on stdin and nowhere else, the port is announced in one line on stdout, the
//! process dies with its stdin, every connection opens with a valid hello, and a refused handshake
//! is answered once and closed.
//!
//! This file is the other half of an agreement whose first half is written in TypeScript
//! (JOS-467's supervisor). If a change here needs a change there, it is a protocol change and both
//! sides move together.

mod harness;

use std::io::Write;
use std::time::{Duration, Instant};

use harness::{echo, spawn_raw, Client, Engine, PATIENCE, TOKEN, WRONG_TOKEN};
use protocol::generated::EngineMessage;
use protocol::PROTOCOL_VERSION;

#[test]
fn the_engine_announces_one_line_naming_a_live_port_and_this_protocol_version() {
    let engine = Engine::start();

    assert_eq!(engine.protocol_version, PROTOCOL_VERSION);
    assert_ne!(
        engine.port, 0,
        "port 0 asks the kernel; it never reports it"
    );
    assert_eq!(
        engine.announce,
        format!(
            "EQC-ENGINE PORT={} PROTOCOL={PROTOCOL_VERSION}\n",
            engine.port
        )
    );

    // The port is not just a number in a line: it accepts.
    let _connection = engine.connect();
}

#[test]
fn the_announce_line_is_the_only_thing_that_ever_reaches_stdout() {
    let mut engine = Engine::start();

    // A whole session's worth of everything, including the paths that write diagnostics.
    let mut client = engine.connected();
    client.send(&echo(1, "hello"));
    let _reply = client.recv();
    client.send_bytes(b"{ not json at all\n");
    client.expect_closed();

    let mut refused = engine.connect();
    let denied = refused.say_hello(WRONG_TOKEN, PROTOCOL_VERSION);
    assert!(!denied.ok);

    let status = engine.close_stdin_and_wait();
    assert!(status.success());
    assert_eq!(
        engine.remaining_stdout(),
        "",
        "stdout carries the announce line and nothing else, ever"
    );
}

#[test]
fn the_engine_exits_zero_when_its_stdin_reaches_eof() {
    let mut engine = Engine::start();
    let _connection = engine.connected();

    let started = Instant::now();
    let status = engine.close_stdin_and_wait();

    assert_eq!(
        status.code(),
        Some(0),
        "the dies-with-the-app law ends the process cleanly"
    );
    assert!(
        started.elapsed() < PATIENCE,
        "and it ends promptly, with a connection still open"
    );
}

#[test]
fn an_engine_handed_no_token_refuses_to_start() {
    let (mut child, stdin) = spawn_raw();
    // Closing stdin with nothing on it is a supervisor that spawned the engine and never wrote the
    // secret. There is nothing the engine can do with a connection after that.
    drop(stdin);

    let status = wait_for(&mut child);
    assert_eq!(status.code(), Some(1));
}

#[test]
fn an_engine_handed_something_that_cannot_be_a_token_refuses_to_start() {
    let (mut child, mut stdin) = spawn_raw();
    stdin.write_all(b"hunter2\n").expect("stdin takes bytes");
    stdin.flush().expect("stdin flushes");

    let status = wait_for(&mut child);
    assert_eq!(
        status.code(),
        Some(1),
        "an engine holding an impossible token would refuse every connection instead"
    );
}

#[test]
fn a_connection_that_presents_the_right_token_is_told_who_it_reached() {
    let engine = Engine::start();
    let mut client = engine.connect();

    let reply = client.say_hello(TOKEN, PROTOCOL_VERSION);

    assert!(reply.ok);
    assert_eq!(reply.protocol_version, PROTOCOL_VERSION);
    assert!(
        !reply.engine_version.is_empty(),
        "engineVersion is informational, but it is not optional"
    );
}

#[test]
fn a_connection_that_presents_the_wrong_token_is_refused_and_closed() {
    let engine = Engine::start();
    let mut client = engine.connect();

    let reply = client.say_hello(WRONG_TOKEN, PROTOCOL_VERSION);

    assert!(!reply.ok);
    client.expect_closed();
}

#[test]
fn a_token_that_is_a_prefix_of_the_real_one_is_refused() {
    // The property `protocol::token`'s constant-time compare exists for, asserted where it actually
    // matters: over the socket, against the running process.
    let engine = Engine::start();
    let mut client = engine.connect();

    let reply = client.say_hello(&TOKEN[..48], PROTOCOL_VERSION);

    assert!(!reply.ok);
    client.expect_closed();
}

#[test]
fn a_client_from_another_build_is_refused_and_closed() {
    let engine = Engine::start();
    let mut client = engine.connect();

    // Version skew is a build error, not a runtime state to recover from: there is no compatibility
    // mode and the connection ends.
    let reply = client.say_hello(TOKEN, PROTOCOL_VERSION + 1);

    assert!(!reply.ok);
    assert_eq!(
        reply.protocol_version, PROTOCOL_VERSION,
        "the refusal still says which contract the engine speaks, so a supervisor can log the skew"
    );
    client.expect_closed();
}

#[test]
fn nothing_may_precede_the_hello() {
    let engine = Engine::start();
    let mut client = engine.connect();

    // A perfectly good request, in the wrong place.
    client.send(&echo(1, "before the handshake"));

    match client.recv() {
        EngineMessage::HelloReply(reply) => assert!(!reply.ok),
        other => panic!("an unauthenticated request is a handshake failure, got {other:?}"),
    }
    client.expect_closed();
}

#[test]
fn a_second_hello_ends_the_connection() {
    let engine = Engine::start();
    let mut client = engine.connected();

    client.send(&protocol_hello());

    client.expect_closed();
}

#[test]
fn one_refused_connection_does_not_disturb_another() {
    let engine = Engine::start();
    let mut good = engine.connected();

    let mut bad = engine.connect();
    assert!(!bad.say_hello(WRONG_TOKEN, PROTOCOL_VERSION).ok);
    bad.expect_closed();

    good.send(&echo(1, "still here"));
    let EngineMessage::Reply(reply) = good.recv() else {
        panic!("a reply");
    };
    assert_eq!(*reply.id, 1);
}

#[test]
fn the_engine_serves_several_connections_at_once() {
    let engine = Engine::start();
    let mut clients: Vec<Client> = (0..4).map(|_| engine.connected()).collect();

    // Interleaved on purpose: every connection has a request outstanding before any of them has an
    // answer, so a single-threaded engine would deadlock here rather than merely be slow.
    for (n, client) in clients.iter_mut().enumerate() {
        client.send(&echo(
            i64::try_from(n).expect("four fits"),
            &format!("connection {n}"),
        ));
    }
    for (n, client) in clients.iter_mut().enumerate() {
        let EngineMessage::Reply(reply) = client.recv() else {
            panic!("a reply");
        };
        assert_eq!(*reply.id, i64::try_from(n).expect("four fits"));
        let protocol::generated::ReplyResult::EchoResult(result) = &reply.result else {
            panic!("an echo result");
        };
        assert_eq!(result.text, format!("connection {n}"));
    }
}

#[test]
fn a_request_that_arrives_one_byte_at_a_time_is_still_one_message() {
    let engine = Engine::start();
    let mut client = engine.connected();

    // The whole frame, delivered in the worst chunking a socket can produce — including a
    // multi-byte character split across two reads, which is the case that turns into silent
    // corruption if a codec decodes text per read instead of per frame.
    let text = "a\u{fe0f}\u{1f9ff} nazgûl — 川 — \\n not a newline";
    let frame = protocol::transport::ndjson::encode_line(
        &serde_json::to_value(echo(77, text)).expect("serializes"),
    )
    .expect("encodes");
    client.send_bytes_one_at_a_time(frame.as_bytes());

    let EngineMessage::Reply(reply) = client.recv() else {
        panic!("a reply");
    };
    assert_eq!(*reply.id, 77);
    let protocol::generated::ReplyResult::EchoResult(result) = &reply.result else {
        panic!("an echo result");
    };
    assert_eq!(result.text, text);
}

/// A well-formed hello, for the tests that send one in the wrong place.
fn protocol_hello() -> protocol::generated::ClientMessage {
    protocol::generated::ClientMessage::Hello(protocol::generated::Hello {
        op: protocol::generated::HelloOp::Hello,
        protocol_version: PROTOCOL_VERSION,
        token: protocol::generated::Token::try_from(TOKEN).expect("a token"),
    })
}

/// Wait for a child that is expected to exit on its own.
///
/// # Panics
/// If it has not exited within [`PATIENCE`].
fn wait_for(child: &mut std::process::Child) -> std::process::ExitStatus {
    let deadline = Instant::now() + PATIENCE;
    loop {
        if let Some(status) = child.try_wait().expect("the child can be waited on") {
            return status;
        }
        assert!(
            Instant::now() < deadline,
            "the engine has not exited after {PATIENCE:?}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
