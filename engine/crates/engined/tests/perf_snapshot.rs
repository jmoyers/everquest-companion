//! THE ENGINE REPORTS ITSELF, OVER A REAL SOCKET (owner ruling 19 surface, JOS-483).
//!
//! `views::meter`'s own unit tests own what the counters COUNT. This suite owns what a CLIENT can
//! get out of them — which is a different claim, and it is the one the in-app performance panel
//! rests on. Four things are proved here and each is a sentence the panel would otherwise be
//! guessing at:
//!
//!   * an engine with nothing attached ANSWERS rather than refusing — `idle`, a real uptime, an
//!     empty serve list and an ingest that has measured nothing. A panel that could not draw a
//!     just-launched engine would go blank exactly when somebody is waiting for one to come up;
//!   * after a real scan of a COMMITTED FIXTURE the ingest half is real: a spell-DB time, a scan
//!     time and the scan's own byte count, beside the mark and the event count the scan reached;
//!   * after a subscribe and an append the serve half is real: frames, bytes, a widest frame, and a
//!     fold-to-frame latency that EXISTS (the diff had a fold behind it) where the opening reset's
//!     did not;
//!   * asking twice does not reset anything, and the subscriber count is LIVE — it drops when the
//!     subscription closes while the frame counts, which are the generation's bill, do not.
//!
//! THE LOG IS A COPY OF A COMMITTED FIXTURE with the suite's own tail appended, staged under the
//! product's file-name shape. The fixture buys a scan worth measuring (~450 KB, thousands of
//! events); the appended lines buy a ledger this suite knows every row of, because the committed
//! fixtures carry no loot at all (`tests/views.rs` makes the same argument). Nothing here writes to
//! a real game log.

mod harness;

use harness::{attach, perf_snapshot, subscribe, unsubscribe, Client, Engine, PATIENCE};
use protocol::generated::{
    EngineMessage, PerfServeSource, PerfSnapshotResult, PerfSnapshotResultStatus, ReplyResult,
};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

/// The log this suite scans. Committed, dense, and with no loot in it — see the header.
const FIXTURE: &str = "cw2-loadout-swap-aug2.log";

/// The source the panel's serve table is proved over.
const SOURCE: &str = "loot.ledger";

/// The zone line that fires the rebirth boundary on an empty ledger, dated AFTER the fixture's last
/// line (Mon Aug 03 2026) so the appended tail is the newest thing in the file.
const ZONE: &str = "[Wed Aug 19 16:00:00 2026] You have entered Nagafen's Lair.\n";

/// What the game writes next — one loot, appended live, so the diff frame has a fold behind it.
const A_LOOT: &str =
    "[Wed Aug 19 16:16:44 2026] You have looted a Golden Efreeti Boots from Efreeti Lord Djarn corpse.\n";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("the crate is three levels below the repo root")
        .to_path_buf()
}

/// A scratch directory holding one log named the way the product names one.
struct Staged(PathBuf);

impl Staged {
    fn new(tag: &str) -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "engined-perf-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("a scratch dir");
        let staged = Self(dir);
        let source = repo_root().join("tests").join("fixtures").join(FIXTURE);
        let bytes = std::fs::read(&source)
            .unwrap_or_else(|e| panic!("the committed fixture {} reads: {e}", source.display()));
        staged.append_bytes(&bytes);
        staged.append(ZONE);
        staged
    }

    fn log(&self) -> PathBuf {
        self.0.join("eqlog_Primitive_freeport.txt")
    }

    fn append(&self, text: &str) {
        self.append_bytes(text.as_bytes());
    }

    /// Append the way EverQuest appends: an open, a write, a flush, one write per call.
    fn append_bytes(&self, bytes: &[u8]) {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.log())
            .expect("the log takes an append");
        file.write_all(bytes).expect("append");
        file.flush().expect("flush");
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        let _ignored = std::fs::remove_dir_all(&self.0);
    }
}

// ---- asking ------------------------------------------------------------------------------------

/// Ask `perf.snapshot` and take the result. Every other frame on the connection — the attach's
/// epoch announcement, a subscription's reset, a progress tick — is skipped rather than asserted
/// about: this suite is about ONE reply, and the ordering of the rest is `tests/ingest.rs`'s claim.
fn ask_perf(client: &mut Client, id: i64) -> PerfSnapshotResult {
    client.send(&perf_snapshot(id));
    loop {
        match client.recv() {
            EngineMessage::Reply(reply) if *reply.id == id => {
                let ReplyResult::PerfSnapshotResult(result) = reply.result else {
                    panic!("a perf snapshot result, got {:?}", reply.result);
                };
                return result;
            }
            EngineMessage::ErrorReply(refusal) if *refusal.id == id => {
                panic!("perf.snapshot was refused: {:?}", refusal.error);
            }
            _ => {}
        }
    }
}

/// One source's row out of a snapshot, by name.
fn row<'a>(perf: &'a PerfSnapshotResult, source: &str) -> Option<&'a PerfServeSource> {
    perf.serve.iter().find(|r| r.source == source)
}

/// Poll `perf.snapshot` until `ready` is happy with the answer, or the suite's patience runs out.
///
/// A FAILURE MECHANISM, not a synchronization one: every assertion below waits for a CONDITION —
/// the scan finishing, a live line landing — and the deadline only turns a wedge into a red test.
fn until(
    client: &mut Client,
    id: &mut i64,
    what: &str,
    ready: impl Fn(&PerfSnapshotResult) -> bool,
) -> PerfSnapshotResult {
    let deadline = Instant::now() + PATIENCE;
    loop {
        *id += 1;
        let perf = ask_perf(client, *id);
        if ready(&perf) {
            return perf;
        }
        assert!(
            Instant::now() < deadline,
            "waited {PATIENCE:?} for {what}; the engine last said {perf:?}"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

// ---- the claims ---------------------------------------------------------------------------------

#[test]
fn an_engine_with_nothing_attached_answers_rather_than_refusing() {
    // A perf question names nothing that could be absent, so there is no `notFound` to give — and
    // an idle engine is not a broken one. The panel draws this state on every launch.
    let engine = Engine::start();
    let mut client = engine.connected();
    let perf = ask_perf(&mut client, 1);

    assert_eq!(perf.status, PerfSnapshotResultStatus::Idle);
    assert_eq!(*perf.epoch, 1, "a launch is generation 1");
    assert!(
        perf.serve.is_empty(),
        "nothing has served: {:?}",
        perf.serve
    );
    // NOT ZEROS. Nothing has been measured, so nothing is claimed.
    assert_eq!(perf.ingest.spell_db_ms, None);
    assert_eq!(perf.ingest.scan_ms, None);
    assert_eq!(perf.ingest.scan_bytes, None);
    assert!(perf.mark.is_none(), "no attach, so no coordinate");
    assert_eq!(perf.events, None);
}

#[test]
fn a_finished_scan_reports_what_it_cost_and_where_it_reached() {
    let staged = Staged::new("scan");
    let engine = Engine::start();
    let mut client = engine.connected();
    client.send(&attach(1, &staged.log().to_string_lossy()));

    let mut id = 10;
    let perf = until(&mut client, &mut id, "the fold to go live", |p| {
        p.status == PerfSnapshotResultStatus::Live
    });

    // THE INGEST HALF IS REAL, and every field of it is now present rather than absent.
    let scan_bytes = perf.ingest.scan_bytes.expect("the scan reports its bytes");
    assert!(
        scan_bytes > 400_000,
        "the committed fixture is ~450 KB, scan read {scan_bytes}"
    );
    assert!(
        perf.ingest.scan_ms.is_some(),
        "a finished scan reports how long it took"
    );
    assert!(
        perf.ingest.spell_db_ms.is_some(),
        "the spell db reports its build even when it is a shared copy"
    );
    // …beside the coordinate the whole design addresses state by.
    let mark = perf.mark.as_ref().expect("a live fold has a mark");
    assert!(mark.offset > 0, "the mark is a real byte offset");
    assert!(
        perf.events.unwrap_or_default() > 0,
        "the fixture is dense traffic; events {:?}",
        perf.events
    );
    // Nothing has subscribed, so the serve list is empty rather than a row of zeros.
    assert!(perf.serve.is_empty(), "{:?}", perf.serve);
}

#[test]
fn a_subscribe_and_an_append_fill_the_serve_table() {
    let staged = Staged::new("serve");
    let engine = Engine::start();
    let mut client = engine.connected();
    client.send(&attach(1, &staged.log().to_string_lossy()));

    let mut id = 100;
    until(&mut client, &mut id, "the fold to go live", |p| {
        p.status == PerfSnapshotResultStatus::Live
    });

    // THE OPENING RESET IS A FRAME WITH NO FOLD BEHIND IT. It is counted and NOT timed — the
    // discipline `views::meter` keeps, asserted here at the far end of a socket.
    client.send(&subscribe(2, SOURCE));
    let opened = until(
        &mut client,
        &mut id,
        "the opening reset to be counted",
        |p| row(p, SOURCE).is_some_and(|r| r.frames > 0),
    );
    let opening = row(&opened, SOURCE).expect("a row for the source");
    assert_eq!(opening.subscribers, 1, "one connection is watching");
    assert!(opening.resets >= 1);
    assert!(
        opening.payload_weight > 0,
        "a frame that was sent has a size"
    );
    assert!(opening.widest_payload_weight > 0);

    // …AND NOW A LIVE LINE, which the next frame reports and which therefore HAS a fold instant
    // behind it. This is the measurement ruling 19 names: fold to frame, end to end, in
    // microseconds because the whole path is tens of them.
    staged.append(A_LOOT);
    let served = until(&mut client, &mut id, "a frame with a fold behind it", |p| {
        row(p, SOURCE).is_some_and(|r| r.fold_to_frame_us_mean.is_some())
    });
    let row_now = row(&served, SOURCE).expect("a row for the source");
    assert!(row_now.diffs >= 1, "the appended loot arrived as a diff");
    assert!(row_now.rows >= 0);
    assert!(row_now.frames >= opening.frames, "counters are cumulative");
    let mean = row_now
        .fold_to_frame_us_mean
        .expect("a timed frame has a mean");
    let max = row_now.fold_to_frame_us_max.expect("…and a worst");
    assert!(max >= mean, "the worst is not better than the mean");

    // ASKING TWICE RESETS NOTHING. Two panels open at once must see the same session, and the
    // engine's own stderr report must not lose the interval it was about to print.
    id += 1;
    let again = ask_perf(&mut client, id);
    let row_again = row(&again, SOURCE).expect("a row for the source");
    assert!(row_again.frames >= row_now.frames);
    assert!(row_again.payload_weight >= row_now.payload_weight);
    assert_eq!(row_again.subscribers, 1);

    // THE SUBSCRIBER COUNT IS LIVE AND THE FRAME COUNTS ARE NOT. Closing the window stops somebody
    // watching; it does not un-spend what the generation already spent.
    client.send(&unsubscribe(3, 2));
    let closed = until(&mut client, &mut id, "the subscription to close", |p| {
        row(p, SOURCE).is_some_and(|r| r.subscribers == 0)
    });
    let row_closed = row(&closed, SOURCE).expect("the row survives the unsubscribe");
    assert!(
        row_closed.frames >= row_now.frames,
        "the bill stands after the window closes"
    );
}
