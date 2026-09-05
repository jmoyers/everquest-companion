//! Which characters this install has. The app names the folder and pushes it (`logs.setDir`); this
//! file reads it.
//!
//! Everything here is a pure function of a directory path plus whatever the filesystem says, so the
//! whole answer — including the three ways a directory can fail to be one — is exercised against a
//! temp folder. The world holds the pushed path and the op table turns the answer into a reply;
//! neither knows what an `eqlog_` filename is.
//!
//! None of this is fold state and none of it may become any. An mtime is a served process fact: it
//! is not addressed by (log identity, byte offset) and no replay can produce it, so nothing here is
//! pushed into a module and this file imports neither `fold` nor `ingest`. It is answerable by a
//! world that has attached to nothing, which is the launch it exists for.
//!
//! The app keeps its own reader for launches with no engine, so two implementations answer one
//! question and every rule below is the app's: the filename shape, the leftmost split, the truncated
//! mtime, the most-recent-first order. The one addition is the tiebreak, because a served list is
//! compared frame to frame and an unstable order is churn.

use protocol::generated::{LogCharacter, LogsDirReadable};
use std::path::{Path, PathBuf};

/// What one scan of a log directory found.
///
/// The verdict and the rows travel together because an empty list means three different things and
/// only the verdict separates them.
///
/// No `PartialEq`: `LogCharacter` is generated and derives none, so a comparison of two scans is
/// written field by field. That is the right direction anyway — a scan carries an mtime, and
/// comparing whole scans would be comparing the filesystem's clock.
#[derive(Debug, Clone)]
pub struct LogScan {
    /// How reading the directory went.
    pub readable: LogsDirReadable,
    /// The character logs found, most recently written first. Always empty when `readable` is not
    /// [`LogsDirReadable::Ok`].
    pub characters: Vec<LogCharacter>,
}

/// The filename prefix EverQuest gives every character log.
const PREFIX: &str = "eqlog_";

/// The extension it gives them.
const SUFFIX: &str = ".txt";

/// Scan one directory.
///
/// Three outcomes, and a failed read is never "no logs". `NotFound` is `missing` — a machine with
/// EverQuest installed somewhere else. Every other error is `unreadable`: a permission refusal, a
/// disconnected share, a path that is a file. Two states rather than one because they are two
/// sentences to a person.
///
/// A file that vanishes mid-scan is a row with no `lastPlayed`, not a missing row: the readdir and
/// the stat are two syscalls with a window between them, and EverQuest is writing into this folder
/// while a person clicks. Dropping the row would make a character disappear for a reason nobody
/// could see.
///
/// A directory entry that is not a file is skipped: handing a folder named `eqlog_Foo_bar.txt` to
/// `session.attach` would be an attach that can only fail.
#[must_use]
pub fn scan(dir: &Path) -> LogScan {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return LogScan {
                readable: LogsDirReadable::Missing,
                characters: Vec::new(),
            }
        }
        Err(_) => {
            return LogScan {
                readable: LogsDirReadable::Unreadable,
                characters: Vec::new(),
            }
        }
    };
    let mut characters: Vec<LogCharacter> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some((name, server)) = split_log_name(file_name) else {
            continue;
        };
        // The metadata is taken once and answers two questions: is this a file at all, and when was
        // it last written. A row survives a failure of the second and not of the first.
        let meta = std::fs::metadata(&path).ok();
        if meta.as_ref().is_some_and(|m| !m.is_file()) {
            continue;
        }
        characters.push(LogCharacter {
            name,
            server,
            log_path: path.to_string_lossy().into_owned(),
            last_played: meta.and_then(|m| mtime_ms(&m)),
        });
    }
    sort_most_recent_first(&mut characters);
    LogScan {
        readable: LogsDirReadable::Ok,
        characters,
    }
}

/// `eqlog_<Character>_<server>.txt` → the two names, or `None` for a filename that is not one.
///
/// The split is LEFTMOST, matching the app's two lazy regex groups: a server name may contain an
/// underscore and a character name may not, so a rightmost split would make the two implementations
/// disagree about a name — and a name is the join key the picker and `characterId` are built on.
///
/// Case-insensitive at both ends, and the names themselves are verbatim: the game's own
/// capitalisation is what the player sees.
///
/// Both halves must be non-empty — a row carrying an empty string is a picker entry with a blank
/// label.
fn split_log_name(file_name: &str) -> Option<(String, String)> {
    let lower = file_name.to_ascii_lowercase();
    if !lower.starts_with(PREFIX) || !lower.ends_with(SUFFIX) {
        return None;
    }
    let middle = file_name.get(PREFIX.len()..file_name.len() - SUFFIX.len())?;
    let (name, server) = middle.split_once('_')?;
    if name.is_empty() || server.is_empty() {
        return None;
    }
    Some((name.to_owned(), server.to_owned()))
}

/// One file's last-modified time, in epoch milliseconds, or `None`.
///
/// Truncated rather than rounded, to equal the app's `Math.floor(mtimeMs)`: Node reports the same
/// NTFS stamp as a float with sub-millisecond digits and the schema field is an integer. Every
/// failure answers `None` rather than `0` — see `world::mtime_ms`.
fn mtime_ms(meta: &std::fs::Metadata) -> Option<i64> {
    let since = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    i64::try_from(since.as_millis()).ok()
}

/// Most recently written first, with an absent `lastPlayed` sorting as zero — the app's comparator,
/// and the right place for a file nothing can be said about.
///
/// The tiebreak is the path ascending, which the app's read does not need and this one does:
/// `read_dir` promises no order, so two logs with the same stamp — a fresh copy of an install —
/// could come back either way on consecutive calls, and a served list that reshuffles is diff churn
/// against a client holding a window. On a tie this order may differ from the engine-absent arm's;
/// both are equally good answers to "which was played last".
fn sort_most_recent_first(characters: &mut [LogCharacter]) {
    characters.sort_by(|a, b| {
        b.last_played
            .unwrap_or(0)
            .cmp(&a.last_played.unwrap_or(0))
            .then_with(|| a.log_path.cmp(&b.log_path))
    });
}

/// The directory this engine has been told to enumerate, held for the life of the process.
///
/// A third kind of state: not fold state, so it does not move with the epoch, and not derived from
/// an attach either — the app told this process, so it survives an attach exactly as `defines` does.
/// A character switch is not the app withdrawing where its logs live.
#[derive(Debug, Clone, Default)]
pub struct LogDir(Option<PathBuf>);

impl LogDir {
    /// Take the app's statement. An idempotent full-set replace of one value: the latest push is the
    /// whole of what the app has said.
    pub fn set(&mut self, dir: &str) {
        self.0 = Some(PathBuf::from(dir));
    }

    /// The directory, or `None` when no `logs.setDir` has arrived.
    #[must_use]
    pub fn get(&self) -> Option<&Path> {
        self.0.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A scratch Logs folder of this test's own. Never a real install's logs.
    fn scratch(tag: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "engined-logs-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("a scratch logs dir");
        dir
    }

    /// Write one character log with a stated modification time, so order is asserted against a fact
    /// rather than against how fast the test ran.
    fn log(dir: &Path, file: &str, mtime_ms: u64) -> PathBuf {
        let path = dir.join(file);
        std::fs::write(
            &path,
            "[Wed Aug 20 12:00:00 2026] You have entered Freeport.\n",
        )
        .expect("a staged log");
        let handle = std::fs::File::options()
            .write(true)
            .open(&path)
            .expect("the staged log, to stamp");
        handle
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(mtime_ms))
            .expect("a stamped log");
        path
    }

    #[test]
    fn a_directory_of_logs_becomes_rows_most_recently_written_first() {
        let dir = scratch("order");
        log(&dir, "eqlog_Primitive_freeport.txt", 1_700_000_002_000);
        log(&dir, "eqlog_Alt_freeport.txt", 1_700_000_009_000);
        log(&dir, "eqlog_Third_povar.txt", 1_700_000_005_000);

        let found = scan(&dir);
        assert_eq!(found.readable, LogsDirReadable::Ok);
        let names: Vec<&str> = found.characters.iter().map(|c| c.name.as_str()).collect();
        // The sort key is the file's own stamp, which is what "last played" means here.
        assert_eq!(names, vec!["Alt", "Third", "Primitive"]);
        assert_eq!(found.characters[0].server, "freeport");
        assert_eq!(found.characters[0].last_played, Some(1_700_000_009_000));
        assert_eq!(
            found.characters[0].log_path,
            dir.join("eqlog_Alt_freeport.txt").to_string_lossy()
        );
    }

    #[test]
    fn only_character_logs_are_rows_and_the_split_is_leftmost() {
        let dir = scratch("names");
        log(&dir, "eqlog_Primitive_freeport.txt", 1_700_000_003_000);
        // A server name may carry an underscore and a character name may not, which is why the
        // split is leftmost.
        log(&dir, "eqlog_Bard_test_server.txt", 1_700_000_002_000);
        // Case-insensitive at both ends.
        log(&dir, "EQLOG_Shouty_FREEPORT.TXT", 1_700_000_001_000);
        // …and four things that are not character logs at all.
        log(&dir, "eqlog_.txt", 1_700_000_004_000);
        log(&dir, "eqlog__freeport.txt", 1_700_000_004_000);
        log(&dir, "eqlog_Nameless_.txt", 1_700_000_004_000);
        log(&dir, "dbg.txt", 1_700_000_004_000);
        std::fs::create_dir_all(dir.join("eqlog_Folder_freeport.txt")).expect("a decoy directory");

        let found = scan(&dir);
        let rows: Vec<(&str, &str)> = found
            .characters
            .iter()
            .map(|c| (c.name.as_str(), c.server.as_str()))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("Primitive", "freeport"),
                ("Bard", "test_server"),
                ("Shouty", "FREEPORT")
            ]
        );
    }

    #[test]
    fn a_missing_directory_is_missing_and_not_an_empty_install() {
        // A failed read is not "no logs" — the two are different sentences to a person. A machine
        // with EverQuest installed somewhere else reaches this every launch.
        let dir = scratch("gone").join("Logs");
        let found = scan(&dir);
        assert_eq!(found.readable, LogsDirReadable::Missing);
        assert!(found.characters.is_empty());
    }

    #[test]
    fn a_path_that_is_a_file_is_unreadable_rather_than_missing() {
        let dir = scratch("notadir");
        let file = log(&dir, "eqlog_Primitive_freeport.txt", 1_700_000_000_000);
        let found = scan(&file);
        assert_eq!(found.readable, LogsDirReadable::Unreadable);
        assert!(found.characters.is_empty());
    }

    #[test]
    fn an_install_with_no_character_logs_is_ok_and_empty() {
        // The third silence, and the one a player is told to fix: the folder is right and `/log on`
        // has never been typed. `ok` with no rows is what says so.
        let dir = scratch("nologs");
        log(&dir, "dbg.txt", 1_700_000_000_000);
        let found = scan(&dir);
        assert_eq!(found.readable, LogsDirReadable::Ok);
        assert!(found.characters.is_empty());
    }

    #[test]
    fn ties_are_broken_by_path_so_two_scans_of_one_folder_agree() {
        // A fresh copy of an install is a folder of files with one stamp, and `read_dir` promises
        // no order — so without the tiebreak two consecutive scans could disagree and a served
        // window would churn for a world that did not move.
        let dir = scratch("ties");
        log(&dir, "eqlog_Zeta_freeport.txt", 1_700_000_000_000);
        log(&dir, "eqlog_Alpha_freeport.txt", 1_700_000_000_000);
        let order = |found: &LogScan| -> Vec<String> {
            found
                .characters
                .iter()
                .map(|c| c.log_path.clone())
                .collect()
        };
        let first = order(&scan(&dir));
        let again = order(&scan(&dir));
        assert_eq!(first, again);
        let names: Vec<String> = scan(&dir)
            .characters
            .iter()
            .map(|c| c.name.clone())
            .collect();
        assert_eq!(names, vec!["Alpha".to_owned(), "Zeta".to_owned()]);
    }

    #[test]
    fn the_pushed_directory_is_a_full_set_replace_of_one_value() {
        let mut held = LogDir::default();
        assert!(held.get().is_none(), "nothing has been told to this engine");
        held.set("C:/EverQuest Legends/Logs");
        assert_eq!(held.get(), Some(Path::new("C:/EverQuest Legends/Logs")));
        // The latest push is the whole of what the app has said — there is nothing to accumulate.
        held.set("D:/Second Install/Logs");
        assert_eq!(held.get(), Some(Path::new("D:/Second Install/Logs")));
    }
}
