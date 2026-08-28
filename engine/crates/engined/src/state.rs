//! The app's `userData`, read and written by the engine. `fold` owns the two file SHAPES; this file
//! owns the directory, the disk, the cadence and the diagnostics. Nothing here parses a format and
//! nothing there opens a file.
//!
//! The directory is pushed as `session.attach`'s optional `stateDir`, never discovered — the engine
//! cannot derive Electron's `userData` and must not guess. Absent means no persistence at all:
//! nothing read, nothing written, and the fold is the file-free one the equivalence oracle records.
//! Every non-app client gets that by saying nothing.
//!
//! Both formats are the app's existing ones, verbatim, because both implementations have to be able
//! to hold the same file — a user who turns the engine off must not lose their ledger.
//!
//! Every write is temp + fsync + rename, in that order: a plain write onto the live path truncates
//! it first, so a process killed mid-write leaves a half-written file the reader treats as empty.
//! The fsync is a step of its own — renaming a file whose bytes are only in the page cache is how an
//! "atomic" write ends up truncated anyway. On failure the scratch file is taken back, because a
//! whole user ledger left in `.tmp` also fills the volume that just said it had no room.
//!
//! A failed write is a line on stderr and nothing more. The ledger's truth is in memory, every
//! reader comes through the fold, and the folded character re-derives its whole bucket from the log
//! on the next attach; a snapshot is the whole cost.
//!
//! The cadence is the app's: every 60th beat of the live heartbeat, and nothing during a replay —
//! structural rather than guarded, since `EventSink::tick` is the only path here and the historical
//! scan cannot reach it. Both writes are coalesced on a fingerprint of the serialized text, because
//! an app left open at the character select would otherwise rewrite hundreds of kilobytes an hour to
//! say the same thing.
//!
//! Three app behaviours are deliberately absent. There is no quit-final write, so up to 60 s of
//! accretion for the folded character can be lost — the one bucket the next attach re-derives in
//! full, while every other character's is seeded and rewritten unchanged. There is no retry backoff,
//! so a genuinely full volume will re-try and re-print once a minute. And there is no salvage or
//! quarantine on the resist read.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::spawn::DIAGNOSTIC_PREFIX;

/// `<userData>/resist-ledger.json` — the app's spelling, and the only one either side may use.
const RESIST_LEDGER: &str = "resist-ledger.json";

/// `<userData>/message-overlay.json`.
const MESSAGE_OVERLAY: &str = "message-overlay.json";

/// How many live beats between writes. The heartbeat is 1 Hz, so sixty of them is the app's own
/// minute.
pub const WRITE_EVERY_BEATS: u64 = 60;

/// FNV-1a over the serialized text, paired with its length — the app's own fingerprint, ported.
///
/// The pair rather than the hash alone because holding the previous JSON to compare against would
/// double the file's footprint in memory. A collision costs one snapshot of changed counts and
/// nothing durable.
///
/// The length is UTF-16 code UNITS, so this walks `encode_utf16()` rather than `chars()`: the two
/// differ on any astral character, and the app's number is the one being matched.
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

/// The app's `userData`, plus what this engine last wrote into it.
///
/// One per attach, because the coalescing fingerprint is a statement about what THIS generation has
/// written: the world was rebuilt, so the first write of a generation should land rather than be
/// declined by a memory of the last one.
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

    /// Read both artifacts, at attach, before the first byte is folded.
    ///
    /// Never fails: a missing file, an unreadable one, a stale version or a shape from another build
    /// are all an empty seed, which is what both app readers do.
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
    /// ENOENT and every other error collapse to the same answer: an empty string is not valid JSON,
    /// so it flows into the "reads as empty" arm the readers already have. A file that exists but
    /// cannot be read is worth a line, and gets one.
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

    /// Write both artifacts, coalesced. Called on every 60th live beat and never during a replay.
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
                // Never fatal. The fold is untouched, the in-memory ledger is the truth every reader
                // comes through, and the next attach re-derives this character's whole bucket from
                // the log. A snapshot is the whole cost.
                eprintln!(
                    "{DIAGNOSTIC_PREFIX} state: {} could not be written ({e}); the fold carries on",
                    path.display()
                );
            }
        }
    }
}

/// Temp + fsync + rename, in that order. The scratch file is `<path>.tmp`, the same spelling
/// app-side.
///
/// One writer per file is what makes a single scratch path safe: the write happens on the ingest
/// thread, from the tick, and there is exactly one ingest thread per generation.
///
/// The directory is created if missing, because a `stateDir` pushed before Electron had created it
/// is a race the engine should absorb rather than fail on.
///
/// On any failure the scratch file is removed, and the removal's own error is dropped: the caller is
/// already being told the write failed, and a second message would bury the first.
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

/// The scratch file, written and flushed to the device. `sync_all` is the fsync — see the module
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
        // Length is UTF-16 code units, so an astral character counts as two — the app's number.
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
        // The proof is the file's absence: after a write lands, the file is deleted out from under
        // the writer, and a second write of identical bytes must not bring it back because the
        // writer declined before touching the disk. A changed one must.
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

        // Two files, two memories: one shared fingerprint slot would make each write cancel the
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
