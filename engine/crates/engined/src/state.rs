//! ============================================================================
//! THE APP'S `userData`, READ AND WRITTEN BY THE ENGINE (JOS-496 item 3).
//! ============================================================================
//!
//! Boundary verdict 4, cutover ledger item 6: two persisted artifacts the APP owns today move their
//! IO into the engine. `fold` owns the SHAPES (`fold::modules::resist::ledger_file` and
//! `fold::overlay_file`, each mirroring the app module it inherits its format from); this file owns
//! the DIRECTORY, the disk, the cadence and the diagnostics. Nothing here parses a format and
//! nothing there opens a file, which is the same split `ledgerFile.ts` / `store.ts` already draws
//! app-side and for the same reason.
//!
//! ── THE DIRECTORY IS PUSHED, NEVER DISCOVERED ──────────────────────────────────────────────────
//!
//! `session.attach`'s optional `stateDir` — Electron's `app.getPath('userData')`, which the engine
//! cannot derive and must not guess. **ABSENT MEANS NO PERSISTENCE AT ALL**: nothing is read,
//! nothing is written, and the fold is exactly the file-free one the six-slice equivalence oracle
//! records. Every non-app client — `parity`, every test in `engine/`, any future tool — gets that
//! by saying nothing, which is what keeps the oracle's world reachable without a state dir as a
//! matter of structure rather than of discipline.
//!
//! ── THE FORMATS ARE INHERITED, NOT NEGOTIATED ──────────────────────────────────────────────────
//!
//! Both files are read and written in the app's EXISTING shape, verbatim, because both
//! implementations have to be able to hold the same file: the app writes them today, the engine
//! writes them under the flag, and a user who turns the flag off must not lose their ledger.
//!
//! **WITH `EQC_ENGINE=0`, OR WITH NO ENGINE AT ALL, THE TYPESCRIPT IO PATH IS COMPLETELY
//! UNCHANGED.** `src/main/resist/store.ts` and `src/main/data/overlayPersistence.ts` are not edited
//! by this ticket and are not reached by anything in this file. Retiring the app-side writers when
//! the engine is serving is a separate, app-side half — deliberately not this one. What this file
//! delivers is an engine that is CAPABLE and PROVEN, not an app that has stopped.
//!
//! ── EVERY WRITE IS ATOMIC, AND NO WRITE MAY TAKE THE ENGINE DOWN ───────────────────────────────
//!
//! Temp + fsync + rename, in that order, onto `<path>.tmp` — the same three steps the telemetry
//! ring (JOS-265), the settings store (JOS-272), the resist ledger (JOS-419) and the overlay
//! register (JOS-419) all go through app-side, and for the reason `overlayPersistence.ts` states at
//! length: a plain write onto the live path TRUNCATES IT FIRST, so a process killed mid-write left
//! a half-written register that the reader treats as an EMPTY one. Every message this install had
//! ever learned, silently gone, with nothing on disk to say so.
//!
//! THE FSYNC IS NOT OPTIONAL AND IS NOT THE SAME STEP AS THE RENAME. Renaming a file whose bytes are
//! still only in the page cache is how an "atomic" write ends up truncated anyway after an unclean
//! shutdown. On a failure the scratch file is TAKEN BACK, because a failed write that leaves a whole
//! user ledger in `.tmp` is a failure that also filled the volume that had just said it had no room.
//!
//! And a failure is a LINE ON STDERR and nothing more (contract rule 2). Not a panic, not a refused
//! attach, not a status change: the ledger's truth is in memory, every reader comes through the
//! fold, and the character being folded re-derives its whole bucket from the log on the next attach
//! regardless. A snapshot is what a failed write costs.
//!
//! ── THE CADENCE IS THE APP'S ────────────────────────────────────────────────────────────────────
//!
//! Every 60th beat of the live heartbeat — `resist/module.ts onTick`'s "every sixtieth tick, a
//! ledger persist" at 1 Hz, and `session.ts`'s 60-second overlay save. **NOTHING DURING REPLAY**,
//! which is structural rather than guarded: `EventSink::tick` is the only path here and the
//! historical scan cannot reach it (`foldsink`'s header carries that argument in full). A replay is
//! re-deriving what is already on disk; writing during one would be the engine reporting its own
//! echo.
//!
//! Both writes are COALESCED on a fingerprint of the serialized text, which is `ledgerFile.ts`'s
//! own device and its own justification: "the ledger is snapshot once a minute whether or not
//! anything changed, so an app left open at the character select rewrote hundreds of kilobytes an
//! hour to say the same thing". The overlay gets it too, which is one more than the app has.
//!
//! ── WHAT IS NOT HERE, NAMED RATHER THAN IMPLIED ────────────────────────────────────────────────
//!
//!   * **NO QUIT-FINAL.** `overlayPersistence.saveUserOverlaySync` writes synchronously at
//!     `window-all-closed` so the last minute's observations survive. The engine has no equivalent:
//!     it writes on the cadence and stops when the process does. What that costs is at most 60 s of
//!     accretion for THE CHARACTER BEING FOLDED — whose bucket is re-derived from the log in full
//!     on the next attach, which is the app's own argument for why a dropped write costs nothing
//!     durable. Every OTHER character's bucket is seeded and re-written unchanged, so the
//!     irreplaceable half is never the half at risk. It is still a real difference and it is named.
//!   * **NO RETRY BACKOFF.** `ledgerFile.ts` pauses after a failure for a spell that doubles to
//!     fifteen minutes, so a full disk is not re-attempted every tick. Here a failure is retried on
//!     the next 60-second beat. The coalescing fingerprint blunts it — an unchanged ledger is not
//!     re-attempted at all — but on a genuinely full volume with a busy fold this will re-try, and
//!     re-print, once a minute.
//!   * **NO SALVAGE AND NO QUARANTINE** on the resist read. See `ledger_file.rs`'s header.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::spawn::DIAGNOSTIC_PREFIX;

/// `<userData>/resist-ledger.json` — the app's spelling, and the only one either side may use.
const RESIST_LEDGER: &str = "resist-ledger.json";

/// `<userData>/message-overlay.json`.
const MESSAGE_OVERLAY: &str = "message-overlay.json";

/// HOW MANY LIVE BEATS BETWEEN WRITES. The heartbeat is 1 Hz (`ingest::TICK_EVERY`), so sixty of
/// them is the app's own minute — `resist/module.ts`'s `if (++this.ticks % 60 === 0)` and
/// `session.ts`'s 60-second overlay save, which are the same interval stated twice over there.
pub const WRITE_EVERY_BEATS: u64 = 60;

/// FNV-1a over the serialized text, paired with its length — `ledgerFile.ts fingerprint`, ported
/// exactly, including the pairing.
///
/// The pair rather than the hash alone because holding the previous JSON to compare against would
/// double the file's footprint in memory for a question a 32-bit answer settles. A collision costs
/// ONE snapshot of changed counts and nothing durable: memory is unaffected, the next change writes,
/// and the folded character's bucket is re-derived from the log on the next attach regardless.
///
/// `charCodeAt` is a UTF-16 code UNIT and Rust's `chars()` yields code POINTS, so this walks
/// `encode_utf16()`. The two differ on any astral character — an emoji in a mob's name would be one
/// — and a fingerprint that silently disagreed with the app's would not be caught by anything,
/// because it is only ever compared against itself. Ported to match anyway: a function that says it
/// is `ledgerFile.ts fingerprint` should be it.
#[must_use]
pub fn fingerprint(text: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    let mut units = 0usize;
    for unit in text.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
        units += 1;
    }
    format!("{units}:{hash:x}")
}

/// THE APP'S `userData`, plus what this engine last wrote into it.
///
/// One per attach, owned by the `FoldSink`, because the coalescing fingerprint is a statement about
/// what THIS generation has written. A new attach is a new sink and therefore a fresh pair of
/// fingerprints, which is right: the world was rebuilt, and the first write of a generation should
/// land rather than be declined by a memory of the last one.
pub struct StateDir {
    dir: PathBuf,
    last_ledger: Option<String>,
    last_overlay: Option<String>,
}

impl StateDir {
    #[must_use]
    pub fn new(dir: &Path) -> Self {
        StateDir {
            dir: dir.to_path_buf(),
            last_ledger: None,
            last_overlay: None,
        }
    }

    /// READ BOTH ARTIFACTS — at attach, before the first byte is folded.
    ///
    /// NEVER FAILS. A missing file, an unreadable one, a stale version, a shape from another build:
    /// every one of them is an EMPTY seed, which is what both app readers do and what the read rules
    /// for this ticket state. A notice goes to stderr where there is something to say; an ordinary
    /// read says nothing.
    #[must_use]
    pub fn read(&self) -> fold::PersistedState {
        let ledger = fold::modules::resist::ledger_file::read_ledger(&self.slurp(RESIST_LEDGER));
        if let Some(notice) = &ledger.notice {
            eprintln!("{DIAGNOSTIC_PREFIX} state: {notice}");
        }
        let overlay = fold::overlay_file::seeds_of(fold::overlay_file::read_register(
            &self.slurp(MESSAGE_OVERLAY),
        ));
        eprintln!(
            "{DIAGNOSTIC_PREFIX} state: seeded {} resist bucket(s) and {} overlay bucket(s) from {}",
            ledger.sources.len(),
            overlay.len(),
            self.dir.display()
        );
        fold::PersistedState {
            resist: ledger.sources,
            overlay,
        }
    }

    /// A file's whole text, or `""` for anything that could not be read.
    ///
    /// ENOENT AND EVERY OTHER ERROR COLLAPSE TO THE SAME ANSWER, deliberately: an empty string is
    /// not valid JSON, so it flows into the same "reads as empty" arm the readers already have, and
    /// the alternative would be two spellings of one outcome. A file that exists but cannot be read
    /// is worth a line, and the reader prints one.
    fn slurp(&self, name: &str) -> String {
        match fs::read_to_string(self.dir.join(name)) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => {
                eprintln!(
                    "{DIAGNOSTIC_PREFIX} state: {name} could not be read ({e}); starting empty"
                );
                String::new()
            }
        }
    }

    /// WRITE BOTH ARTIFACTS, coalesced. Called on every 60th live beat and never during a replay.
    pub fn write(&mut self, registry: &fold::Registry) {
        if let Some(resist) = registry.resist() {
            let file = resist.user_ledger_file();
            if let Ok(text) = serde_json::to_string(&file) {
                self.put(RESIST_LEDGER, &text, true);
            }
        }
        if let Some(buffs) = registry.buffs() {
            let file = fold::overlay_file::register_file_of(buffs.overlay_register());
            if let Ok(text) = serde_json::to_string(&file) {
                self.put(MESSAGE_OVERLAY, &text, false);
            }
        }
    }

    /// One coalesced, atomic write. `is_ledger` picks which fingerprint slot this file owns — two
    /// files, two memories, because one shared slot would make each write cancel the other's.
    fn put(&mut self, name: &str, text: &str, is_ledger: bool) {
        let stamp = fingerprint(text);
        let last = if is_ledger {
            &mut self.last_ledger
        } else {
            &mut self.last_overlay
        };
        if last.as_deref() == Some(stamp.as_str()) {
            return;
        }
        let path = self.dir.join(name);
        match write_durable(&path, text) {
            Ok(()) => *last = Some(stamp),
            Err(e) => {
                // NEVER FATAL (contract rule 2). The fold is untouched, the in-memory ledger is the
                // truth every reader comes through, and the next attach re-derives this character's
                // whole bucket from the log. A snapshot is the whole cost.
                eprintln!(
                    "{DIAGNOSTIC_PREFIX} state: {} could not be written ({e}); the fold carries on",
                    path.display()
                );
            }
        }
    }
}

/// TEMP + FSYNC + RENAME, in that order — `telemetry/durableWrite.ts writeFileDurable`.
///
/// The scratch file is `<path>.tmp`, the same spelling app-side. ONE WRITER PER FILE is what makes
/// a single scratch path safe: the write happens on the ingest thread, from the tick, and there is
/// exactly one ingest thread per generation. (App-side that had to be earned with a latch, because
/// `writeFileDurableAsync` put two writes in libuv's threadpool at once.)
///
/// THE DIRECTORY IS CREATED IF IT IS MISSING, because a `stateDir` the app pushed before Electron
/// had created it is a race the engine should absorb rather than fail on, and `create_dir_all` on
/// an existing directory is a no-op.
///
/// ON ANY FAILURE THE SCRATCH FILE IS REMOVED, and the removal's own error is deliberately dropped:
/// the caller is already being told the write failed, and a second message about the cleanup of a
/// file nobody will read would bury the first.
fn write_durable(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(match path.extension() {
        Some(ext) => format!("{}.tmp", ext.to_string_lossy()),
        None => "tmp".to_owned(),
    });
    if let Err(e) = fill_and_flush(&tmp, text) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// The scratch file, written and FLUSHED TO THE DEVICE. `sync_all` is the fsync — see the module
/// header for why it is a step of its own and not a synonym for the rename.
fn fill_and_flush(tmp: &Path, text: &str) -> std::io::Result<()> {
    let mut file = File::create(tmp)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory of this test's own, under cargo's target dir so nothing escapes it.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("engined-state-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("a scratch dir");
        dir
    }

    /// The app's exact bytes for both files, hand-written.
    const APP_LEDGER: &str = r#"{"version":3,"sources":[{"key":"baseline","rows":[]},{"key":"primitive_freeport","rows":[{"mobKey":"a rat","spellKey":"malosi","family":"cast","casterKind":"self","casterLevel":51,"mobLevel":20,"debuffs":"","rank":0,"overchannel":false,"week":"2026-W34","resist":4,"land":7,"dmg":{"9":2},"firstTs":1000,"lastTs":2000}]}]}"#;
    const APP_OVERLAY: &str = r#"{"version":2,"updatedAt":"2026-08-19T16:21:54.000Z","sources":[{"key":"baseline","messages":[]},{"key":"primitive_freeport","messages":[{"text":"You feel much faster.","role":"landing","spells":[{"spell":"Alacrity","count":3}]}]}]}"#;

    #[test]
    fn the_fingerprint_is_the_apps_own_function() {
        // FNV-1a offset basis, paired with a length of zero.
        assert_eq!(fingerprint(""), "0:811c9dc5");
        // Length is UTF-16 code UNITS, so an astral character counts as two — the number
        // `String.prototype.length` gives and therefore the number `ledgerFile.ts` pairs.
        assert_eq!(fingerprint("\u{1F600}").split(':').next(), Some("2"));
        assert_ne!(fingerprint("a"), fingerprint("b"));
    }

    #[test]
    fn the_apps_files_are_read_and_the_baseline_buckets_are_refused() {
        let dir = scratch("read");
        fs::write(dir.join(RESIST_LEDGER), APP_LEDGER).expect("the ledger is written");
        fs::write(dir.join(MESSAGE_OVERLAY), APP_OVERLAY).expect("the register is written");
        let state = StateDir::new(&dir).read();
        assert_eq!(state.resist.len(), 1);
        assert_eq!(state.resist[0].key, "primitive_freeport");
        assert_eq!(state.overlay.len(), 1);
        assert_eq!(state.overlay[0].0, "primitive_freeport");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_directory_reads_as_empty_and_says_nothing_fatal() {
        let state = StateDir::new(Path::new("C:/nowhere/there-is-no-such-profile")).read();
        assert!(state.resist.is_empty());
        assert!(state.overlay.is_empty());
    }

    #[test]
    fn a_corrupt_file_reads_as_empty() {
        let dir = scratch("corrupt");
        fs::write(
            dir.join(RESIST_LEDGER),
            r#"{"version":3,"sources":[{"key":"#,
        )
        .expect("half a ledger is written");
        fs::write(dir.join(MESSAGE_OVERLAY), "not json at all").expect("junk is written");
        let state = StateDir::new(&dir).read();
        assert!(state.resist.is_empty());
        assert!(state.overlay.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_durable_write_leaves_no_scratch_file_and_replaces_the_target() {
        let dir = scratch("durable");
        let path = dir.join(RESIST_LEDGER);
        fs::write(&path, "the previous ledger").expect("a previous ledger");
        write_durable(&path, APP_LEDGER).expect("the write lands");
        assert_eq!(fs::read_to_string(&path).expect("readable"), APP_LEDGER);
        // `<path>.tmp` beside it, gone. A scratch file left behind holds a whole user ledger on a
        // volume that may have just said it had no room.
        assert!(!dir.join("resist-ledger.json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_identical_write_is_declined_and_a_changed_one_is_not() {
        // `ledgerFile.ts`'s own device: "the ledger is snapshot once a minute whether or not
        // anything changed, so an app left open at the character select rewrote hundreds of
        // kilobytes an hour to say the same thing."
        //
        // THE PROOF IS THE FILE'S ABSENCE. After a write lands, the file is DELETED out from under
        // the writer; a second write of identical bytes must not bring it back, because the writer
        // declined before it touched the disk. A changed one must.
        let dir = scratch("coalesce");
        let path = dir.join(RESIST_LEDGER);
        let mut state = StateDir::new(&dir);

        state.put(RESIST_LEDGER, APP_LEDGER, true);
        assert!(path.exists());
        fs::remove_file(&path).expect("the file is removed");

        state.put(RESIST_LEDGER, APP_LEDGER, true);
        assert!(!path.exists(), "identical bytes were rewritten");

        state.put(RESIST_LEDGER, r#"{"version":3,"sources":[]}"#, true);
        assert!(path.exists(), "changed bytes were declined");

        // TWO FILES, TWO MEMORIES. One shared fingerprint slot would make each write cancel the
        // other's, and the two artifacts change at completely different rates.
        fs::remove_file(&path).expect("the file is removed");
        state.put(MESSAGE_OVERLAY, APP_OVERLAY, false);
        state.put(RESIST_LEDGER, r#"{"version":3,"sources":[]}"#, true);
        assert!(
            !path.exists(),
            "the overlay's write disturbed the ledger's memory"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_write_into_a_missing_directory_creates_it() {
        let dir = scratch("makedir").join("not").join("yet");
        write_durable(&dir.join(RESIST_LEDGER), APP_LEDGER).expect("the write lands");
        assert!(dir.join(RESIST_LEDGER).exists());
        let _ = fs::remove_dir_all(
            dir.parent()
                .and_then(Path::parent)
                .expect("the scratch root"),
        );
    }
}
