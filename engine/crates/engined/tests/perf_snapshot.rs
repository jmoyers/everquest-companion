//! The engine reports itself, over a real socket.
//!
//! `views::meter`'s own unit tests own what the counters count; this suite owns what a client can
//! get out of them — the sentences the in-app performance panel rests on:
//!
//!   * an engine with nothing attached answers rather than refusing: `idle`, a real uptime, an empty
//!     serve list, an ingest that has measured nothing;
//!   * after a real scan the ingest half is real — spell-DB time, scan time and scan bytes, beside
//!     the mark and the event count the scan reached;
//!   * after a subscribe and an append the serve half is real, including a fold-to-frame latency
//!     that exists where the opening reset's did not;
//!   * asking twice resets nothing, and the subscriber count is live where the frame counts are not.
//!
//! The log is a copy of a committed fixture with the suite's own tail appended: the fixture buys a
//! scan worth measuring (~450 KB), and the appended lines buy a ledger this suite knows every row
//! of, because the committed fixtures carry no loot at all.

mod harness;

use harness::{
    attach, attach_params, perf_budgets, perf_snapshot, perf_timeline, subscribe, unsubscribe,
    Client, Engine, PATIENCE,
};
use protocol::generated::{
    ClientMessage, ClockHint, EngineMessage, ErrorCode, PerfBudgetId, PerfBudgetVerdict,
    PerfBudgetsResult, PerfServeSource, PerfSnapshotResult, PerfSnapshotResultClockSource,
    PerfSnapshotResultStatus, PerfTimelineResult, ReplyResult, SessionAttachParams,
};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

/// The log this suite scans. Committed, dense, and with no loot in it — see the header.
const FIXTURE: &str = "cw2-loadout-swap-aug2.log";

/// The source the panel's serve table is proved over.
const SOURCE: &str = "loot.ledger";

/// The zone line that fires the rebirth boundary on an empty ledger, dated after the fixture's last
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

/// Ask `perf.snapshot` and take the result. Every other frame on the connection — the attach's epoch
/// announcement, a subscription's reset, a progress tick — is skipped rather than asserted about:
/// this suite is about one reply, and the ordering of the rest is `tests/ingest.rs`'s claim.
fn ask_perf(client: &mut Client, id: i64) -> PerfSnapshotResult {
    try_ask_perf(client, id).unwrap_or_else(|why| panic!("perf.snapshot was unavailable: {why}"))
}

/// [`ask_perf`] with the one refusal a healthy engine can give surfaced as `Err`: the fold was busy
/// past the world's patience (a spell catalog loading on a starved CI runner is enough). A caller
/// waiting for a condition reads that as "not yet"; every other refusal is still a panic, because
/// none of them means anything but a broken test.
fn try_ask_perf(client: &mut Client, id: i64) -> Result<PerfSnapshotResult, String> {
    client.send(&perf_snapshot(id));
    loop {
        match client.recv() {
            EngineMessage::Reply(reply) if *reply.id == id => {
                let ReplyResult::PerfSnapshotResult(result) = reply.result else {
                    panic!("a perf snapshot result, got {:?}", reply.result);
                };
                return Ok(result);
            }
            EngineMessage::ErrorReply(refusal) if *refusal.id == id => {
                if matches!(refusal.error.code, ErrorCode::Unavailable) {
                    return Err(refusal.error.message);
                }
                panic!("perf.snapshot was refused: {:?}", refusal.error);
            }
            _ => {}
        }
    }
}

/// Ask `perf.budgets` and take the result. Same skipping posture as [`ask_perf`].
fn ask_budgets(client: &mut Client, id: i64) -> PerfBudgetsResult {
    client.send(&perf_budgets(id));
    loop {
        match client.recv() {
            EngineMessage::Reply(reply) if *reply.id == id => {
                let ReplyResult::PerfBudgetsResult(result) = reply.result else {
                    panic!("a perf budgets result, got {:?}", reply.result);
                };
                return result;
            }
            EngineMessage::ErrorReply(refusal) if *refusal.id == id => {
                panic!("perf.budgets was refused: {:?}", refusal.error);
            }
            _ => {}
        }
    }
}

/// Ask `perf.timeline` and take the result. Same skipping posture as [`ask_perf`].
fn ask_timeline(client: &mut Client, id: i64) -> PerfTimelineResult {
    client.send(&perf_timeline(id));
    loop {
        match client.recv() {
            EngineMessage::Reply(reply) if *reply.id == id => {
                let ReplyResult::PerfTimelineResult(result) = reply.result else {
                    panic!("a perf timeline result, got {:?}", reply.result);
                };
                return result;
            }
            EngineMessage::ErrorReply(refusal) if *refusal.id == id => {
                panic!("perf.timeline was refused: {:?}", refusal.error);
            }
            _ => {}
        }
    }
}

/// One budget out of an answer, by id. Every budget is always present — see the schema.
fn budget(answer: &PerfBudgetsResult, id: PerfBudgetId) -> &protocol::generated::PerfBudget {
    answer
        .budgets
        .iter()
        .find(|b| b.id == id)
        .expect("a budget is never omitted from the list")
}

/// One source's row out of a snapshot, by name.
fn row<'a>(perf: &'a PerfSnapshotResult, source: &str) -> Option<&'a PerfServeSource> {
    perf.serve.iter().find(|r| r.source == source)
}

/// Poll `perf.snapshot` until `ready` is happy with the answer, or the suite's patience runs out.
///
/// A failure mechanism, not a synchronization one: every assertion below waits for a condition — the
/// scan finishing, a live line landing — and the deadline only turns a wedge into a red test.
fn until(
    client: &mut Client,
    id: &mut i64,
    what: &str,
    ready: impl Fn(&PerfSnapshotResult) -> bool,
) -> PerfSnapshotResult {
    let deadline = Instant::now() + PATIENCE;
    loop {
        *id += 1;
        // A fold too busy to answer inside the world's patience is "not yet" exactly like an
        // answer that is not ready — the deadline below is the only verdict this loop gives.
        let last = match try_ask_perf(client, *id) {
            Ok(perf) => {
                if ready(&perf) {
                    return perf;
                }
                format!("{perf:?}")
            }
            Err(why) => why,
        };
        assert!(
            Instant::now() < deadline,
            "waited {PATIENCE:?} for {what}; the engine last said {last}"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

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
    // Not zeros: nothing has been measured, so nothing is claimed.
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

    // The ingest half is real, and every field of it is now present rather than absent.
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

    // The opening reset is a frame with no fold behind it: counted and not timed, which is the
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

    // …and now a live line, which the next frame reports and which therefore has a fold instant
    // behind it: fold to frame, end to end, in microseconds because the whole path is tens of them.
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

    // Asking twice resets nothing: two panels open at once must see the same session.
    id += 1;
    let again = ask_perf(&mut client, id);
    let row_again = row(&again, SOURCE).expect("a row for the source");
    assert!(row_again.frames >= row_now.frames);
    assert!(row_again.payload_weight >= row_now.payload_weight);
    assert_eq!(row_again.subscribers, 1);

    // The subscriber count is live and the frame counts are not: closing the window stops somebody
    // watching, but does not un-spend what the generation already spent.
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

#[test]
fn an_idle_engine_states_its_budgets_and_refuses_to_pretend_it_measured_them() {
    // The case the `unmeasured` verdict exists for: a just-launched engine has folded and served
    // nothing, and that is exactly when somebody is most likely to open the panel. A budget that
    // read green here would be green for the one period in which it knows least.
    let engine = Engine::start();
    let mut client = engine.connected();
    let answer = ask_budgets(&mut client, 1);

    assert_eq!(*answer.epoch, 1, "a launch is generation 1");
    assert_eq!(answer.budgets.len(), 2, "a budget is never omitted");
    for budget in &answer.budgets {
        assert_eq!(budget.verdict, PerfBudgetVerdict::Unmeasured, "{budget:?}");
        assert_eq!(budget.measured, None, "absent, never zero");
        // …and the definition is served regardless: the ceiling and its caveat are what let a reader
        // judge instead of trusting a colour.
        assert!(!budget.label.is_empty(), "{budget:?}");
        assert!(!budget.limit.is_empty(), "{budget:?}");
        assert!(!budget.note.is_empty(), "{budget:?}");
    }
    // The rows arrive in the panel's order. A renderer that sorted these would be munging a served
    // view.
    let ids: Vec<PerfBudgetId> = answer.budgets.iter().map(|b| b.id).collect();
    assert_eq!(ids, [PerfBudgetId::FoldRate, PerfBudgetId::ServeLatency]);
}

#[test]
fn the_fold_rate_budget_says_the_g3_goal_is_not_met_rather_than_hiding_behind_a_pass() {
    // The floor is an eighth of the measured rate, so a pass is a much smaller claim than the
    // program's goal: the release cut folds 209 MB in 52.5 s against a 20 s goal. The note says so,
    // and it rides every panel row and bug report, so it is asserted on the wire.
    let engine = Engine::start();
    let mut client = engine.connected();
    let answer = ask_budgets(&mut client, 1);
    let fold = budget(&answer, PerfBudgetId::FoldRate);
    assert!(fold.note.contains("NOT met"), "{}", fold.note);
    assert!(fold.note.contains("52.5 s"), "{}", fold.note);
    // …and the serve row carries its own caveat, because a two-second ceiling on a number that
    // includes the coalescing beat is a wedge detector and must never read as a compute budget.
    let serve = budget(&answer, PerfBudgetId::ServeLatency);
    assert!(serve.note.contains("wedge detector"), "{}", serve.note);
    assert!(serve.limit.contains("at most"), "{}", serve.limit);
}

#[test]
fn a_finished_scan_gives_the_fold_rate_budget_something_to_judge() {
    let staged = Staged::new("budgets");
    let engine = Engine::start();
    let mut client = engine.connected();
    client.send(&attach(1, &staged.log().to_string_lossy()));

    let mut id = 100;
    until(&mut client, &mut id, "the scan to finish", |p| {
        p.ingest.scan_ms.is_some() && p.ingest.scan_bytes.is_some()
    });
    id += 1;
    let answer = ask_budgets(&mut client, id);
    let fold = budget(&answer, PerfBudgetId::FoldRate);

    // The verdict is not asserted: `cargo test` builds debug, and a debug fold runs about an order
    // of magnitude slower than the release build the floor was measured against (0.45 MB/s in a
    // debug run of the CI budget). So this asserts the budget measured something and rendered it,
    // and leaves judging the number to `tests/budget.rs`, which knows which profile it is in.
    assert_ne!(
        fold.verdict,
        PerfBudgetVerdict::Unmeasured,
        "a finished scan is something to judge"
    );
    let measured = fold
        .measured
        .as_deref()
        .expect("a finished scan has a rate");
    assert!(
        measured.ends_with("/s"),
        "a rate renders as a rate: {measured}"
    );
}

#[test]
fn an_idle_engine_states_the_timelines_horizon_over_an_empty_ring() {
    // An empty timeline is the commonest honest answer: the ring is filled by the ingest thread's
    // beat, so an engine with nothing attached has sampled nothing. The horizon is on the answer
    // anyway, because a client inferring it from the length would infer it wrongly early in every
    // generation.
    let engine = Engine::start();
    let mut client = engine.connected();
    let answer = ask_timeline(&mut client, 1);

    assert_eq!(*answer.epoch, 1);
    assert!(answer.timeline.is_empty(), "{:?}", answer.timeline);
    assert!(
        answer.capacity > 0,
        "the ring is bounded and says by how much"
    );
    assert!(answer.cadence_ms > 0, "…and how far apart its samples are");
}

#[test]
fn a_live_engine_fills_the_ring_and_the_ring_stays_bounded() {
    // The end-to-end wiring claim: the serve beat reaches `views::Timeline` with the world's uptime,
    // a window closes, and a moment crosses the socket. `views::meter`'s unit tests own the ring's
    // arithmetic; only this can say the ingest loop is actually turning the handle.
    //
    // It costs one cadence of wall clock deliberately: the alternative is a test-only seam that
    // shortens the cadence in production code.
    let staged = Staged::new("timeline");
    let engine = Engine::start();
    let mut client = engine.connected();
    client.send(&attach(1, &staged.log().to_string_lossy()));

    let mut id = 200;
    until(&mut client, &mut id, "the scan to finish", |p| {
        p.ingest.scan_ms.is_some()
    });

    let deadline = Instant::now() + PATIENCE;
    let answer = loop {
        id += 1;
        let answer = ask_timeline(&mut client, id);
        if !answer.timeline.is_empty() {
            break answer;
        }
        assert!(
            Instant::now() < deadline,
            "waited {PATIENCE:?} for the ring to take its first sample"
        );
        std::thread::sleep(std::time::Duration::from_millis(250));
    };

    assert!(
        i64::try_from(answer.timeline.len()).unwrap_or(i64::MAX) <= answer.capacity,
        "the ring never grows past its horizon: {} > {}",
        answer.timeline.len(),
        answer.capacity
    );
    let moment = &answer.timeline[0];
    assert!(moment.at_ms > 0, "stamped with process uptime");
    assert!(
        moment.span_ms >= answer.cadence_ms,
        "a window covers at least the cadence it waited for: {moment:?}"
    );
    // Oldest first, an ordering the server owes rather than one a caller sorts for.
    assert!(
        answer.timeline.windows(2).all(|w| w[0].at_ms < w[1].at_ms),
        "{:?}",
        answer.timeline
    );
}

#[test]
fn the_three_perf_ops_answer_on_one_connection_and_none_disturbs_the_others() {
    // Three ops, one door. The registry's guard matrix proves the shapes cannot be confused; this
    // proves the engine does not confuse them either — each reply carries its own result arm, and
    // asking all three in a row leaves the snapshot's cumulative counters intact.
    let engine = Engine::start();
    let mut client = engine.connected();

    let first = ask_perf(&mut client, 1);
    let budgets = ask_budgets(&mut client, 2);
    let timeline = ask_timeline(&mut client, 3);
    let second = ask_perf(&mut client, 4);

    assert_eq!(
        *first.epoch, *budgets.epoch,
        "one generation, three answers"
    );
    assert_eq!(*first.epoch, *timeline.epoch);
    assert_eq!(second.status, first.status);
    assert!(
        second.uptime_ms >= first.uptime_ms,
        "reading the budgets did not reset the process clock"
    );
    assert_eq!(second.serve.len(), first.serve.len());
}

// ---- the clock the fold is on ------------------------------------------------------------------

/// An offset this machine is provably NOT on, so the platform probe cannot claim agreement with it.
/// Both candidates are half-hour offsets, which no zone the CI fleet runs in uses.
fn a_foreign_offset_min() -> i32 {
    const CANDIDATES: [i32; 2] = [330, 210];
    let here = eqlog::platform_timezone()
        .map(|tz| eqlog::Zone::Iana(tz).offset_min_at_ms(wall_clock_ms()));
    CANDIDATES
        .into_iter()
        .find(|c| here != Some(*c))
        .expect("this machine cannot be on both offsets at once")
}

fn wall_clock_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("a clock after 1970")
            .as_millis(),
    )
    .expect("an instant that fits")
}

/// One EQ-stamped line, written in a stated zone. The weekday is not parsed, so `Xxx` is honest.
fn stamped(zone: eqlog::Zone, ms: i64, text: &str) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let civil = eqlog::Clock::new(zone)
        .civil(ms)
        .expect("a representable instant");
    let month = MONTHS[(civil.month as usize).saturating_sub(1).min(11)];
    format!(
        "[Xxx {month} {day:02} {hour:02}:{minute:02}:{second:02} {year}] {text}\n",
        day = civil.day,
        hour = civil.hour,
        minute = civil.minute,
        second = civil.second,
        year = civil.year
    )
}

fn attach_with_clock(id: i64, log_path: &str, clock: Option<ClockHint>) -> ClientMessage {
    attach_params(
        id,
        SessionAttachParams {
            log_path: log_path.to_owned(),
            state_dir: None,
            clock,
        },
    )
}

#[test]
fn an_attach_whose_zone_name_disagrees_with_its_offset_resolves_the_offset() {
    // THE AGREEMENT RULE ON THE WIRE. The offset came from the same ICU clock that stamped the log;
    // the name is a lookup that can be wrong. `Europe/Berlin` is east of UTC in every season, so it
    // can never carry a half-hour offset â€” and neither can this machine's own probe, by
    // construction. The answer states the fixed offset it fell through to, and says `offset` so a
    // bug report can tell a told zone from a guessed one.
    let offset_min = a_foreign_offset_min();
    let staged = Staged::new("clock-offset");
    let engine = Engine::start();
    let mut client = engine.connected();
    client.send(&attach_with_clock(
        1,
        &staged.log().to_string_lossy(),
        Some(ClockHint {
            tz: Some("Europe/Berlin".to_owned()),
            utc_offset_min: Some(i64::from(offset_min)),
        }),
    ));

    let mut id = 200;
    let perf = until(&mut client, &mut id, "the fold to go live", |p| {
        p.status == PerfSnapshotResultStatus::Live
    });
    assert_eq!(
        perf.clock_source,
        Some(PerfSnapshotResultClockSource::Offset)
    );
    assert_eq!(
        perf.clock_zone,
        Some(
            eqlog::Zone::fixed(offset_min)
                .expect("a representable offset")
                .name()
        )
    );
}

#[test]
fn an_attach_whose_zone_name_agrees_is_taken_at_its_word() {
    // UTC is the one name every machine can be told and every test can check: the hint agrees with
    // itself, so rung (a) answers and the engine says it was TOLD rather than that it guessed.
    let staged = Staged::new("clock-host");
    let engine = Engine::start();
    let mut client = engine.connected();
    client.send(&attach_with_clock(
        1,
        &staged.log().to_string_lossy(),
        Some(ClockHint {
            tz: Some("UTC".to_owned()),
            utc_offset_min: Some(0),
        }),
    ));

    let mut id = 300;
    let perf = until(&mut client, &mut id, "the fold to go live", |p| {
        p.status == PerfSnapshotResultStatus::Live
    });
    assert_eq!(perf.clock_source, Some(PerfSnapshotResultClockSource::Host));
    assert_eq!(perf.clock_zone.as_deref(), Some("UTC"));
    // The scan measured no skew: the age of a line from a committed fixture is a fact about when
    // somebody played, never about a clock.
    assert_eq!(perf.clock_skew_ms, None);
}

#[test]
fn a_live_line_stamped_now_reports_a_skew_of_about_nothing() {
    // THE SENTINEL'S HAPPY CASE, and the measurement the broken one is read against. The log is
    // stamped in the zone the engine is told to resolve, so a line appended now is seconds old and
    // the signed distance between the two clocks is about zero. Under the UTC fallback this same
    // reading was a whole number of hours.
    let staged = Staged::new("clock-skew");
    let engine = Engine::start();
    let mut client = engine.connected();
    client.send(&attach_with_clock(
        1,
        &staged.log().to_string_lossy(),
        Some(ClockHint {
            tz: Some("UTC".to_owned()),
            utc_offset_min: Some(0),
        }),
    ));

    let mut id = 400;
    until(&mut client, &mut id, "the fold to go live", |p| {
        p.status == PerfSnapshotResultStatus::Live
    });
    staged.append(&stamped(
        eqlog::Zone::Iana(eqlog::Tz::UTC),
        wall_clock_ms(),
        "You have looted a Golden Efreeti Boots from Efreeti Lord Djarn corpse.",
    ));
    let perf = until(&mut client, &mut id, "the tail to measure a skew", |p| {
        p.clock_skew_ms.is_some()
    });
    let skew = perf.clock_skew_ms.expect("the tail measured one");
    assert!(
        skew.abs() < 60_000,
        "a line stamped in the resolved zone is seconds old, not {skew} ms"
    );
}
