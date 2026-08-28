//! Log discovery over a real socket.
//!
//! `src/logs.rs`'s own unit tests prove the scan — the filename rule, the order, the three verdicts.
//! This suite proves the half a unit cannot: the directory the app pushes on a connection thread is
//! the directory a later `logs.list` on the same process enumerates, and none of it needs an attach.
//! A fresh install has characters to choose between before there is anything to fold, while every
//! other data-bearing op in this engine refuses a world with no ingest.
//!
//! Every directory below is a scratch folder holding zero-byte files with the product's own naming
//! shape; no real log is ever read.

mod harness;

use harness::{attach, logs_list, logs_set_dir, Client, Engine, PATIENCE};
use protocol::generated::{EngineMessage, LogsDirReadable, ReplyResult};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

/// A scratch Logs folder holding the character logs a test names.
struct Staged(PathBuf);

impl Staged {
    fn new(tag: &str, files: &[&str]) -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "engined-logs-wire-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("a scratch logs dir");
        for file in files {
            std::fs::write(dir.join(file), "").expect("a staged log");
        }
        Self(dir)
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }

    fn log(&self, file: &str) -> String {
        self.0.join(file).to_string_lossy().into_owned()
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        let _ignored = std::fs::remove_dir_all(&self.0);
    }
}

/// Read until the reply to `id` arrives, dropping the connection-wide frames on the way. Epoch
/// frames arrive whether anybody asked, which is why one `recv` is not enough.
fn reply(client: &mut Client, id: i64) -> ReplyResult {
    let deadline = Instant::now() + PATIENCE;
    loop {
        assert!(Instant::now() < deadline, "no reply to request {id}");
        match client.recv() {
            EngineMessage::Reply(r) if *r.id == id => return r.result,
            EngineMessage::ErrorReply(refusal) if *refusal.id == id => {
                panic!("request {id} was refused: {:?}", refusal.error)
            }
            _ => {}
        }
    }
}

/// Read until the refusal of `id` arrives — the outcome this suite asserts once.
fn refusal(client: &mut Client, id: i64) -> protocol::generated::ProtocolError {
    let deadline = Instant::now() + PATIENCE;
    loop {
        assert!(Instant::now() < deadline, "no answer to request {id}");
        match client.recv() {
            EngineMessage::ErrorReply(r) if *r.id == id => return r.error,
            EngineMessage::Reply(r) if *r.id == id => {
                panic!(
                    "request {id} was answered rather than refused: {:?}",
                    r.result
                )
            }
            _ => {}
        }
    }
}

fn list(client: &mut Client, id: i64) -> protocol::generated::LogsListResult {
    match reply(client, id) {
        ReplyResult::LogsListResult(result) => result,
        other => panic!("expected a logs list, got {other:?}"),
    }
}

#[test]
fn a_pushed_directory_is_enumerated_with_no_attach_anywhere() {
    // The launch this op exists for: nothing attached, nothing folded, and the picker still has to
    // draw. Every other data-bearing op in this engine would refuse here.
    let staged = Staged::new(
        "fresh",
        &[
            "eqlog_Primitive_freeport.txt",
            "eqlog_Alterna_freeport.txt",
            "dbg.txt",
        ],
    );
    let engine = Engine::start();
    let mut client = engine.connected();

    client.send(&logs_set_dir(1, &staged.path()));
    match reply(&mut client, 1) {
        ReplyResult::DefineAck(ack) => {
            assert!(ack.applied);
            // One directory is not a list, so the ack carries no count.
            assert_eq!(ack.count, None);
        }
        other => panic!("expected a define ack, got {other:?}"),
    }

    client.send(&logs_list(2));
    let listed = list(&mut client, 2);
    // The echo is the client's own staleness test, so it must come back exactly as pushed.
    assert_eq!(listed.dir, staged.path());
    assert!(matches!(listed.readable, LogsDirReadable::Ok));
    let mut names: Vec<&str> = listed.characters.iter().map(|c| c.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(
        names,
        vec!["Alterna", "Primitive"],
        "and dbg.txt is not one"
    );
    for row in &listed.characters {
        assert_eq!(row.server, "freeport");
        // The path is what `session.attach` takes, so a picked row has to be worth attaching.
        assert_eq!(
            row.log_path,
            staged.log(&format!("eqlog_{}_freeport.txt", row.name))
        );
    }
}

#[test]
fn the_directory_survives_an_attach_because_it_is_app_knowledge() {
    // A character switch is not the app withdrawing where its logs live. The `*.define` families
    // survive an attach by being re-applied at construction; this one never reaches a fold at all.
    let staged = Staged::new("attach", &["eqlog_Primitive_freeport.txt"]);
    let engine = Engine::start();
    let mut client = engine.connected();

    client.send(&logs_set_dir(1, &staged.path()));
    let _acked = reply(&mut client, 1);
    client.send(&attach(2, &staged.log("eqlog_Primitive_freeport.txt")));
    let _attached = reply(&mut client, 2);

    client.send(&logs_list(3));
    let listed = list(&mut client, 3);
    assert_eq!(listed.dir, staged.path());
    assert_eq!(listed.characters.len(), 1);
}

#[test]
fn a_second_connection_sees_what_the_first_one_pushed() {
    // The directory is the world's, not the connection's, so brokered renderer connections can ask
    // without each having to be told. A subscription is the opposite: keyed by (listener, id).
    let staged = Staged::new("shared", &["eqlog_Primitive_freeport.txt"]);
    let engine = Engine::start();
    let mut first = engine.connected();
    first.send(&logs_set_dir(1, &staged.path()));
    let _acked = reply(&mut first, 1);

    let mut second = engine.connected();
    second.send(&logs_list(9));
    let listed = list(&mut second, 9);
    assert_eq!(listed.dir, staged.path());
    assert_eq!(listed.characters.len(), 1);
}

#[test]
fn asking_before_anybody_named_a_directory_is_refused_rather_than_answered_emptily() {
    // An empty list would be the wrong answer: an install where nobody typed `/log on` is a real
    // empty picker, while a question nobody armed is a bug in the app's connect sequence. A caller
    // handed `[]` for both would draw the empty picker for the second.
    let engine = Engine::start();
    let mut client = engine.connected();
    client.send(&logs_list(4));
    let refused = refusal(&mut client, 4);
    assert!(matches!(
        refused.code,
        protocol::generated::ErrorCode::Unavailable
    ));
}

#[test]
fn a_folder_that_is_not_there_is_an_answer_and_a_later_push_replaces_it() {
    // Two properties in one conversation: a push is an idempotent full-set replace of one value, and
    // a directory that does not exist is a supported state rather than a refusal.
    let staged = Staged::new("replace", &["eqlog_Primitive_freeport.txt"]);
    let engine = Engine::start();
    let mut client = engine.connected();

    client.send(&logs_set_dir(1, &staged.log("nowhere-at-all")));
    let _acked = reply(&mut client, 1);
    client.send(&logs_list(2));
    let gone = list(&mut client, 2);
    assert!(matches!(gone.readable, LogsDirReadable::Missing));
    assert!(gone.characters.is_empty());

    // …and the settings change is one push rather than a reconciliation.
    client.send(&logs_set_dir(3, &staged.path()));
    let _acked = reply(&mut client, 3);
    client.send(&logs_list(4));
    let found = list(&mut client, 4);
    assert_eq!(found.dir, staged.path());
    assert!(matches!(found.readable, LogsDirReadable::Ok));
    assert_eq!(found.characters.len(), 1);
}
