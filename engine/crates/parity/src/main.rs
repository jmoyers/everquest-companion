//! ============================================================================
//! parity — the Rust parser's event stream, as NDJSON, for one log file (JOS-469).
//! ============================================================================
//!
//!     parity <logfile>                     write the stream to stdout
//!     parity <logfile> --golden <path>     diff it internally, report the FIRST divergence
//!     parity <logfile> --snapshots         fold it and write every module's snapshot as JSON
//!     parity <logfile> --tz <IANA zone>    resolve local time through that zone (default: host)
//!
//! THREE MODES. The first two are PHASE 1 (JOS-469): the parser's event stream, and the same
//! stream diffed against the recorded golden internally — internally, because the six goldens are
//! 380 MB of NDJSON and piping them through a Node comparator would make the pipe the measurement.
//! `--snapshots` is PHASE 2 (JOS-471): the event stream folded through `fold`'s module registry,
//! with each module's published snapshot written to stdout in registration order. That one DOES
//! come back over the pipe, because a snapshot is megabytes rather than hundreds of them, and
//! because its bar is DEEP equality — which is `firstDiff`'s job, in `tests/bench/rustParity.mts`,
//! where the goldens are already parsed.
//!
//! IT NEVER PRINTS MORE THAN ONE PAIR OF LINES — in `--golden` mode. The slices are the owner's
//! real game log and they never leave his machine; a diff report is a diagnostic, not an export.
//! `--snapshots` is a different thing and is honest about it: a module's published state is
//! DERIVED from the log and is exactly what the golden already holds on disk, so the mode is
//! usable only by a caller that has the corpus anyway. Its output is piped into a comparator and
//! never written down.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::process::ExitCode;

struct Args {
    log: String,
    golden: Option<String>,
    tz: Option<String>,
    snapshots: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut log: Option<String> = None;
    let mut golden: Option<String> = None;
    let mut tz: Option<String> = None;
    let mut snapshots = false;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--golden" => golden = Some(it.next().ok_or("--golden needs a path")?),
            "--tz" => tz = Some(it.next().ok_or("--tz needs an IANA zone name")?),
            "--snapshots" => snapshots = true,
            other if other.starts_with("--") => return Err(format!("unknown flag {other}")),
            other => log = Some(other.to_string()),
        }
    }
    Ok(Args {
        log: log.ok_or("usage: parity <logfile> [--golden <path>] [--snapshots] [--tz <zone>]")?,
        golden,
        tz,
        snapshots,
    })
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("parity: {e}");
            return ExitCode::from(2);
        }
    };
    let tz = match &args.tz {
        Some(name) => match name.parse::<eqlog::Tz>() {
            Ok(tz) => tz,
            Err(_) => {
                eprintln!("parity: {name} is not an IANA zone name");
                return ExitCode::from(2);
            }
        },
        None => eqlog::host_timezone(),
    };
    let file_name = std::path::Path::new(&args.log)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let Some(character) = eqlog::character_of(&file_name) else {
        eprintln!("parity: cannot read a character out of \"{file_name}\"");
        return ExitCode::from(2);
    };

    let mut bytes = Vec::new();
    if let Err(e) = File::open(&args.log).and_then(|mut f| f.read_to_end(&mut bytes)) {
        eprintln!("parity: cannot read {}: {e}", args.log);
        return ExitCode::from(2);
    }

    let parser = eqlog::parser_for(&character, tz);
    if args.snapshots {
        return snapshots(&parser, &bytes, tz, &character, &file_name, &args.log);
    }
    match args.golden {
        None => {
            let stdout = std::io::stdout();
            let mut out = BufWriter::with_capacity(1 << 20, stdout.lock());
            let n = eqlog::scan::scan_bytes(&parser, &bytes, |line| {
                let _ = out.write_all(line.as_bytes());
                let _ = out.write_all(b"\n");
            });
            let _ = out.flush();
            eprintln!("parity: {n} events, tz={tz}, character={character}");
            ExitCode::SUCCESS
        }
        Some(golden) => diff(&parser, &bytes, &golden, &character, tz),
    }
}

/// PHASE 2 (JOS-471): fold the stream through the module registry and write the result to stdout.
///
/// The envelope mirrors the golden's own so the comparator does no translation: `modules` is an
/// array of `{ id, snapshot: { seq, state } }` in REGISTRATION (= bus delivery) order, and
/// `skipped` names every module `fold::WIRING_ORDER` declares that this build has not ported. The
/// skipped list travels with the data on purpose — a comparator that silently compared the nine it
/// was handed and printed GREEN would be claiming coverage of twenty (the no-silent-caps law).
///
/// `meta` carries what the reader needs to know the run was the one it thinks it was: the event
/// count (`ScanResult.seq`), the character, the zone, the launch instant the epoch boundary was
/// resolved at, and — since cluster 2b — the PINNED CONSTRUCTION CLOCK the world is built under.
///
/// PHASE 2d (JOS-477) ADDS TWO MORE SECTIONS, joined to the golden's own by name: `combat` — the
/// full-fat snapshot at `now = lastEventTs`, opts `{ maxSegments: 100000, timeline: true,
/// showUnparsed: true }` — and `scopes`, the uncapped per-scope walk. THE INSTANT IS THE LOG'S,
/// never a wall clock: `Fold::last_ts()` is the same `max(ev.ts)` the recorder's bus listener
/// accumulates, and passing anything else would make a golden recorded on Monday fail on Tuesday.
///
/// `lastEventTs` travels in `meta` beside them so the comparator can prove the two folds agreed
/// about WHICH instant they were asked about before it reads anything into their disagreeing about
/// what was true at it.
///
/// THREE CONSTRUCTION INPUTS ARE DERIVED HERE (JOS-475), each the same way the golden recorder
/// derives it, because the goldens were recorded under those derivations and under no others:
///
///   * the `CharacterRef` — `{ name, server, logPath }` off the log's own FILENAME
///     (`goldenOracle.mts characterOf`, `eqlog_<Name>_<server>.<slice>.txt`), with `logPath` the
///     path this process was handed verbatim. Hardcoding any of it here would let the corpus and
///     the harness drift apart silently.
///   * the CONSTRUCTION CLOCK — the last timestamped LINE of the slice, read from the file's TAIL
///     through the parser's own `Clock` (`goldenOracle.mts lastTimestampOf`). Deliberately not the
///     last EVENT's ts: that is only known after a fold, and the clock has to be pinned before the
///     world is built. See `fold::modules::respawn`'s header for what depends on it — and note it
///     is a DIFFERENT instant from `lastEventTs` above, on purpose: one is when the world was
///     built, the other is what time it was in the world.
///   * `self_name` — NOT derived, and that is the point. `foldArm.mts construct` never calls
///     `roster.setSelfName`; that line is `session.ts`'s and the bench does not run it, so the
///     recorded goldens are what an unnamed roster produces. `None` is the faithful value.
fn snapshots(
    parser: &eqlog::Parser,
    bytes: &[u8],
    tz: eqlog::Tz,
    character: &str,
    file_name: &str,
    log_path: &str,
) -> ExitCode {
    let known: HashSet<String> = parser
        .spell_db()
        .map(|db| db.keys().map(str::to_string).collect())
        .unwrap_or_default();
    let spell_classes = parser
        .spell_db()
        .map(fold::modules::combo::evidence::spell_class_index)
        .unwrap_or_default();
    let clock = eqlog::Clock::new(tz);
    let launch_ms = fold::epoch::launch_ms(&clock);
    let Some(construction_now_ms) = last_timestamp_of(&clock, bytes) else {
        eprintln!("parity: no timestamped line in the last 64 KiB of {log_path}");
        return ExitCode::from(2);
    };
    let deps = fold::ClusterDeps {
        known_spell: known,
        spell_classes,
        launch_ms,
        construction_now_ms,
        character: Some(serde_json::json!({
            "name": character,
            "server": eqlog::server_of(file_name).unwrap_or_default(),
            "logPath": log_path,
        })),
        self_name: None,
        respawn_prefs: fold::modules::respawn::RespawnPrefs::default(),
        // `wiring.ts` hands the buffs module `spellDb` itself; the fold takes an owned PROJECTION
        // of `db.byKey` so nothing downstream borrows the parser (`fold::spell_facts`).
        facts: parser
            .spell_db()
            .map(fold::spell_facts::SpellFacts::project)
            .unwrap_or_default(),
    };
    let started = std::time::Instant::now();
    // The engine is constructed exactly as `foldArm.mts construct()` constructs it: the roster seam
    // installed (here, structurally — `Fold` hands the registry's roster module to the engine on
    // every delivery), then `reset()`, then the player name off the slice filename. It calls
    // `setCombo`, `setDerivedEmitter` and `setHeldClickies` nowhere, and neither do we.
    let mut engine = fold::combat::CombatEngine::new();
    engine.reset();
    engine.set_player_name(character);
    let mut folder = fold::Fold::new(fold::registered(deps), launch_ms).with_combat(engine);
    // …and `with_combat` resets, so the name is re-injected after it the way every construction
    // path does. `CombatEngine::reset` re-seeds an injected name by itself, so this is the same
    // ordering stated twice rather than two different orderings.
    folder.fold_bytes(parser, bytes);
    let ms = started.elapsed().as_millis();
    let last_ts = folder.last_ts();
    let mut out = folder.registry.snapshots();
    if let Some(engine) = &folder.combat {
        let roster = folder.registry.roster();
        out["combat"] = engine.snapshot(last_ts, &fold::combat::SnapshotOpts::full(), roster);
        out["scopes"] = serde_json::Value::Array(engine.walk_scopes(last_ts, roster));
    }
    out["meta"] = serde_json::json!({
        "events": folder.events(),
        "ms": ms,
        "character": character,
        "tz": tz.to_string(),
        "launchMs": launch_ms,
        "lastEventTs": last_ts,
        "constructionNowMs": construction_now_ms,
    });
    let stdout = std::io::stdout();
    let mut w = BufWriter::with_capacity(1 << 20, stdout.lock());
    if serde_json::to_writer(&mut w, &out).is_err() || w.flush().is_err() {
        eprintln!("parity: could not write the snapshot envelope");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

/// `goldenOracle.mts lastTimestampOf` — the last timestamped LINE's epoch millis, read from the
/// TAIL so it costs nothing whatever the slice weighs.
///
/// The bytes are already in memory here (the fold needs them whole), so the "read the last 64 KiB"
/// half of that function is a SLICE rather than a seek — same window, same answer, no second file
/// handle. The stamp goes through the PARSER'S OWN `Clock`: this instant has to be the same kind of
/// value the fold stamps its events with, and two spellings of "parse an EQ timestamp" would be a
/// way for the pin and the log to drift apart without anyone noticing.
fn last_timestamp_of(clock: &eqlog::Clock, bytes: &[u8]) -> Option<i64> {
    const WINDOW: usize = 1 << 16;
    let tail = &bytes[bytes.len().saturating_sub(WINDOW)..];
    // Lossy is safe for the purpose: a replacement character can only appear inside a line whose
    // leading `[stamp]` is intact ASCII, and it is only the stamp that is read.
    let text = String::from_utf8_lossy(tail);
    for line in text.split('\n').rev() {
        // `/^\[(.+?)\]/` — the first `]` on the line, and nothing before the `[`.
        let Some(rest) = line.strip_prefix('[') else {
            continue;
        };
        let Some(end) = rest.find(']') else {
            continue;
        };
        let ts = clock.parse_eq_timestamp(&rest[..end]);
        if ts > 0 {
            return Some(ts);
        }
    }
    None
}

/// Compare against the recorded stream, latching the FIRST divergence and folding on so the counts
/// are still reported — `checkSlice`'s rule: "the stream diverged at event 412,003 AND …" is a
/// different diagnosis from "the stream diverged and nothing else did".
fn diff(
    parser: &eqlog::Parser,
    bytes: &[u8],
    golden: &str,
    character: &str,
    tz: eqlog::Tz,
) -> ExitCode {
    let f = match File::open(golden) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("parity: cannot read {golden}: {e}");
            return ExitCode::from(2);
        }
    };
    let mut reader = BufReader::with_capacity(1 << 20, f);
    let mut want = String::new();
    let mut first: Option<(u64, String, String)> = None;
    let mut at: u64 = 0;
    let started = std::time::Instant::now();
    let n = eqlog::scan::scan_bytes(parser, bytes, |got| {
        if first.is_some() {
            return;
        }
        at += 1;
        want.clear();
        let read = reader.read_line(&mut want).unwrap_or(0);
        let expected = if read == 0 {
            "(golden ended)".to_string()
        } else {
            want.trim_end_matches('\n')
                .trim_end_matches('\r')
                .to_string()
        };
        if expected != got {
            first = Some((at, expected, got.to_string()));
        }
    });
    let ms = started.elapsed().as_millis();
    let stamps = parser.unparsed_stamps.get();
    if stamps > 0 {
        println!("  note   : {stamps} timestamped lines whose stamp the pattern declined");
    }
    match first {
        None => {
            // A golden with MORE lines than the re-fold produced is a divergence too.
            want.clear();
            if reader.read_line(&mut want).unwrap_or(0) > 0 {
                println!("DIVERGED at event {} (the golden has more)", n + 1);
                println!("  golden : {}", want.trim_end());
                println!("  rust   : (re-fold ended)");
                return ExitCode::FAILURE;
            }
            println!("OK {n} events in {ms} ms (character={character}, tz={tz})");
            ExitCode::SUCCESS
        }
        Some((at, expected, got)) => {
            println!("DIVERGED at event {at} (character={character}, tz={tz}); {n} events folded in {ms} ms");
            println!("  golden : {expected}");
            println!("  rust   : {got}");
            ExitCode::FAILURE
        }
    }
}
