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
    stages: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut log: Option<String> = None;
    let mut golden: Option<String> = None;
    let mut tz: Option<String> = None;
    let mut snapshots = false;
    let mut stages = false;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--golden" => golden = Some(it.next().ok_or("--golden needs a path")?),
            "--tz" => tz = Some(it.next().ok_or("--tz needs an IANA zone name")?),
            "--snapshots" => snapshots = true,
            "--stages" => stages = true,
            other if other.starts_with("--") => return Err(format!("unknown flag {other}")),
            other => log = Some(other.to_string()),
        }
    }
    Ok(Args {
        log: log.ok_or(
            "usage: parity <logfile> [--golden <path>] [--snapshots] [--stages] [--tz <zone>]",
        )?,
        golden,
        tz,
        snapshots,
        stages,
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
    if args.stages {
        return stages(&parser, &bytes, tz, &character, &file_name, &args.log);
    }
    if args.snapshots {
        return snapshots(&parser, &bytes, tz, &character, &file_name, &args.log);
    }
    match args.golden {
        None => {
            let stdout = std::io::stdout();
            let mut out = BufWriter::with_capacity(1 << 20, stdout.lock());
            let n = eqlog::scan::scan_bytes(&parser, &bytes, |line, _payload| {
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

/// THE STAGE BASELINE (JOS-504, owner ask 2026-08-26): where does a full-speed historical fold
/// actually spend its time? Five passes over the same in-memory bytes, each adding ONE stage of
/// the production pipeline, so each stage's cost is the DELTA between neighbours:
///
///   lines      — split on `\n`, trim `\r`, materialize the `&str` (`from_utf8_lossy`)
///   parse      — + `parser.parse_event` (events recognized, both halves built)
///   serialize  — + `ev.done()` (the NDJSON string the production seam still emits)
///   fold       — the whole thing: `Fold::fold_bytes`, 20 modules + combat, exactly what
///                `--snapshots` runs minus the final envelope serialization
///
/// JOS-505 TOOK A STAGE OUT OF THE PIPELINE, and this table had to stop counting it as one. The
/// fold used to parse the NDJSON back into a `serde_json::Value` before any module could read a
/// field; it reads the parser's typed payload now, so `reparse` is no longer a stage and
/// `modules+combat` is measured against `serialize` rather than against it. The old pass is still
/// RUN and still printed — under the line, labelled as the cost the deleted round trip would have
/// had — because a number this table used to carry should not simply vanish from it, and because
/// it is the honest measure of what the change was worth on this machine.
///
/// The construction mirrors `snapshots()` field for field so the `fold` row is the production
/// fold and not a lighter cousin. Each pass reports MB/s over the SAME byte count, so the rows
/// are directly comparable; wall times are one run each — run it three times and read the middle
/// if the machine is busy. PRINTS, NEVER ASSERTS (the G3 rule: a wall clock is a claim about a
/// machine, and this binary does not know which one it is on).
fn stages(
    parser: &eqlog::Parser,
    bytes: &[u8],
    tz: eqlog::Tz,
    character: &str,
    file_name: &str,
    log_path: &str,
) -> ExitCode {
    let mb = bytes.len() as f64 / 1_000_000.0;
    let rate = |ms: u128| -> f64 {
        if ms == 0 {
            f64::INFINITY
        } else {
            mb / (ms as f64 / 1000.0)
        }
    };
    fn split(bytes: &[u8], per_line: &mut dyn FnMut(&str)) {
        let mut start = 0usize;
        while let Some(off) = bytes[start..].iter().position(|&b| b == b'\n') {
            let nl = start + off;
            let mut end = nl;
            if end > start && bytes[end - 1] == b'\r' {
                end -= 1;
            }
            if end > start {
                let line = String::from_utf8_lossy(&bytes[start..end]);
                per_line(&line);
            }
            start = nl + 1;
        }
    }

    let t = std::time::Instant::now();
    let mut lines = 0u64;
    split(bytes, &mut |_line| lines += 1);
    let lines_ms = t.elapsed().as_millis();

    let t = std::time::Instant::now();
    let mut parsed = 0u64;
    {
        let mut ev = eqlog::event::Ev::new();
        let mut seq: i64 = 0;
        split(bytes, &mut |line| {
            if parser.parse_event(line, seq, &mut ev) {
                seq += 1;
                parsed += 1;
            }
        });
    }
    let parse_ms = t.elapsed().as_millis();

    let t = std::time::Instant::now();
    let mut ser_bytes = 0u64;
    {
        let mut ev = eqlog::event::Ev::new();
        let mut seq: i64 = 0;
        split(bytes, &mut |line| {
            if parser.parse_event(line, seq, &mut ev) {
                seq += 1;
                ser_bytes += ev.finish().len() as u64;
            }
        });
    }
    let ser_ms = t.elapsed().as_millis();

    let t = std::time::Instant::now();
    let mut reparsed = 0u64;
    {
        let mut ev = eqlog::event::Ev::new();
        let mut seq: i64 = 0;
        split(bytes, &mut |line| {
            if parser.parse_event(line, seq, &mut ev) {
                seq += 1;
                if fold::event::Event::from_json(ev.finish()).is_some() {
                    reparsed += 1;
                }
            }
        });
    }
    let reparse_ms = t.elapsed().as_millis();

    // The full fold, constructed exactly as `snapshots()` constructs it.
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
        facts: parser
            .spell_db()
            .map(fold::spell_facts::SpellFacts::project)
            .unwrap_or_default(),
    };
    let t = std::time::Instant::now();
    let mut engine = fold::combat::CombatEngine::new();
    engine.reset();
    engine.set_player_name(character);
    let mut folder = fold::Fold::new(fold::registered(deps), launch_ms).with_combat(engine);
    folder.fold_bytes(parser, bytes);
    let fold_ms = t.elapsed().as_millis();

    println!("stage baseline: {mb:.1} MB, {lines} lines, {parsed} events (tz={tz})");
    println!("  cumulative                          wall        rate");
    println!(
        "  lines (split+materialize)      {lines_ms:>7} ms  {:>7.1} MB/s",
        rate(lines_ms)
    );
    println!(
        "  + parse                        {parse_ms:>7} ms  {:>7.1} MB/s",
        rate(parse_ms)
    );
    println!(
        "  + serialize (ev.finish)        {ser_ms:>7} ms  {:>7.1} MB/s",
        rate(ser_ms)
    );
    println!(
        "  + fold (20 modules + combat)   {fold_ms:>7} ms  {:>7.1} MB/s",
        rate(fold_ms)
    );
    println!("  per-stage share of the full fold:");
    let stage = |name: &str, ms: u128| {
        let pct = if fold_ms == 0 {
            0.0
        } else {
            ms as f64 * 100.0 / fold_ms as f64
        };
        println!("    {name:<28} {ms:>7} ms  {pct:>5.1}%");
    };
    stage("lines", lines_ms);
    stage("parse", parse_ms.saturating_sub(lines_ms));
    stage("serialize", ser_ms.saturating_sub(parse_ms));
    stage("modules+combat", fold_ms.saturating_sub(ser_ms));
    println!("  (serialized {ser_bytes} bytes of NDJSON)");
    // NOT A STAGE ANY MORE (JOS-505) — printed under the line rather than in it. See this
    // function's header for why a retired measurement is kept rather than deleted.
    println!(
        "  [retired] the deleted round trip (Event::from_json over the same events): {} ms, {reparsed} values",
        reparse_ms.saturating_sub(ser_ms)
    );

    // ── the dispatch floor: what 21 consumers pay just to refuse an event ─────────────────────
    //
    // Every module's `on_event` begins by asking whether the event is its business and returning
    // when it is not — which for sixteen of the twenty is nearly every event. This pass measures
    // exactly that and nothing else: 21 kind checks per event, no module logic at all.
    //
    // IT ASKS THE QUESTION THE WAY PRODUCTION ASKS IT (JOS-505). It used to re-parse the NDJSON and
    // compare `kind()` against a string, and it measured ~940 ms of a 2.5M-event fold that way. The
    // modules match on the discriminant now, so the probes are `Kind`s and the pass wraps the
    // parser's payload — and the floor it reports is a floor somebody could still act on rather
    // than a memorial to one nobody pays.
    let t = std::time::Instant::now();
    let mut floor_hits = 0u64;
    {
        let mut ev = eqlog::event::Ev::new();
        let mut seq: i64 = 0;
        use eqlog::event::Kind;
        const PROBES: [Kind; 21] = [
            Kind::Damage,
            Kind::Heal,
            Kind::Loot,
            Kind::Trade,
            Kind::ClassUnlock,
            Kind::Death,
            Kind::Consider,
            Kind::ExpGain,
            Kind::Level,
            Kind::SelfWho,
            Kind::OutputFile,
            Kind::SpellSet,
            Kind::ItemReceived,
            Kind::CastBegin,
            Kind::BuffApply,
            Kind::BuffFade,
            Kind::Cc,
            Kind::Charm,
            Kind::Resist,
            Kind::Zone,
            Kind::Miss,
        ];
        split(bytes, &mut |line| {
            if parser.parse_event(line, seq, &mut ev) {
                seq += 1;
                let (_json, payload) = ev.done();
                let v = fold::event::Event::typed(payload);
                for probe in PROBES {
                    if v.kind_of() == probe {
                        floor_hits += 1;
                    }
                }
            }
        });
    }
    let floor_ms = t.elapsed().as_millis().saturating_sub(ser_ms);
    println!(
        "  dispatch floor (21 kind checks/event, minus the serialize pass): ~{floor_ms} ms ({floor_hits} hits)"
    );

    // ── the attribution pass: WHERE inside the fold (JOS-504) ─────────────────────────────────
    //
    // A second, fresh construction (the first fold consumed its world), folded through
    // `fold_bytes_attributed` — per-module, combat, detectors and the event WRAP, each under its
    // own stopwatch. Shares are the trustworthy read; the observer cost note is on the method.
    //
    // The `wrap` row was `reparse` until JOS-505 and is the same bucket, kept under a name that
    // says what is in it now: a discriminant copy and a reference where a `serde_json` parse used
    // to be. Keeping the row is what makes this table comparable with JOS-504's.
    let known2: HashSet<String> = parser
        .spell_db()
        .map(|db| db.keys().map(str::to_string).collect())
        .unwrap_or_default();
    let deps2 = fold::ClusterDeps {
        known_spell: known2,
        spell_classes: parser
            .spell_db()
            .map(fold::modules::combo::evidence::spell_class_index)
            .unwrap_or_default(),
        launch_ms,
        construction_now_ms,
        character: Some(serde_json::json!({
            "name": character,
            "server": eqlog::server_of(file_name).unwrap_or_default(),
            "logPath": log_path,
        })),
        self_name: None,
        respawn_prefs: fold::modules::respawn::RespawnPrefs::default(),
        facts: parser
            .spell_db()
            .map(fold::spell_facts::SpellFacts::project)
            .unwrap_or_default(),
    };
    let mut engine2 = fold::combat::CombatEngine::new();
    engine2.reset();
    engine2.set_player_name(character);
    let mut folder2 = fold::Fold::new(fold::registered(deps2), launch_ms).with_combat(engine2);
    let t = std::time::Instant::now();
    let attr = folder2.fold_bytes_attributed(parser, bytes);
    let attr_ms = t.elapsed().as_millis();
    let total_ns: u64 =
        attr.module_ns.iter().sum::<u64>() + attr.combat_ns + attr.detectors_ns + attr.reparse_ns;
    println!("  attribution pass ({attr_ms} ms wall incl. observer cost); consumers by share:");
    let mut rows: Vec<(&str, u64)> = attr
        .module_ids
        .iter()
        .zip(attr.module_ns.iter())
        .map(|(id, ns)| (*id, *ns))
        .collect();
    rows.push(("combat", attr.combat_ns));
    rows.push(("detectors", attr.detectors_ns));
    rows.push(("wrap (was reparse)", attr.reparse_ns));
    rows.sort_by_key(|r| std::cmp::Reverse(r.1));
    for (id, ns) in rows {
        let pct = if total_ns == 0 {
            0.0
        } else {
            ns as f64 * 100.0 / total_ns as f64
        };
        println!("    {id:<24} {:>8} ms  {pct:>5.1}%", ns / 1_000_000);
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
    let n = eqlog::scan::scan_bytes(parser, bytes, |got, _payload| {
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
