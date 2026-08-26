//! ============================================================================
//! WHICH CHARACTERS THIS INSTALL HAS (owner ruling 21, decision sheet 1a — JOS-498).
//! ============================================================================
//!
//! The last discovery item of the JOS-459 program. `listCharacters` in `src/main/log/config.ts` was
//! a readdir, a filename parse and a `statSync` per file, run on Electron main; ruling 21 moves the
//! READING of log-file facts to the process that owns log files, and decision sheet 1a settles who
//! names the folder — THE APP DOES, and pushes it (`logs.setDir`).
//!
//! ── THE SPLIT THIS FILE IS ON THE FORMAT SIDE OF ───────────────────────────────────────────────
//!
//! `spells.rs` states it best and this file keeps it: the FORMAT is one thing and the FILE is
//! another. Everything below is a pure function of a directory path plus whatever the filesystem
//! says when asked, so the whole answer — including the three ways a directory can fail to be a
//! directory — is exercised by a unit against a temp folder this test made. The WORLD holds the
//! pushed path (`world::State::log_dir`) and the op table turns the answer into a reply; neither of
//! those knows what an `eqlog_` filename is.
//!
//! ── IT IS NOT FOLD STATE, AND IT NEVER BECOMES ANY ────────────────────────────────────────────
//!
//! An mtime is a served PROCESS fact (ruling 18): it is not addressed by (log identity, byte
//! offset), no replay can produce it, and a fold that held one would be a fold whose output depended
//! on when it ran. So nothing here is pushed into a module, nothing here moves with the epoch, and
//! this file imports neither `fold` nor `ingest`. It is answerable by a world that has attached to
//! nothing at all, which is exactly the launch it exists for: a fresh install has characters to
//! choose between before there is anything to fold.
//!
//! ── THE APP'S OWN READ IS THE OTHER ARM, SO THE TWO MUST AGREE ────────────────────────────────
//!
//! `listCharacters` survived the deletion release on purpose — launch-time character choice has to
//! work on a launch with no engine — so there are two implementations of one answer and the app
//! degrades from this one to that one. Every rule below is therefore quoted from `config.ts` rather
//! than chosen here: the filename shape, the leftmost split, the truncated mtime, the
//! most-recent-first order. Where this file adds something the app's read does not have (the
//! tiebreak below), it is because a served list is compared frame to frame and an unstable order is
//! churn; it is stated, not silent.

use protocol::generated::{LogCharacter, LogsDirReadable};
use std::path::{Path, PathBuf};

/// What one scan of a log directory found.
///
/// THE VERDICT AND THE ROWS TRAVEL TOGETHER because an empty list means three different things and
/// only the verdict separates them — see `LogsListResult` in the schema, which is this type on the
/// wire.
///
/// NO `PartialEq`, and the absence is the generated types' rather than a choice: `LogCharacter` is
/// typify's output and derives `Debug`/`Clone`/serde and nothing else, so a comparison of two scans
/// is written field by field where a test wants one. That is the right direction anyway — a scan
/// carries an mtime, and a test that compared whole scans would be comparing the filesystem's clock.
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

/// SCAN ONE DIRECTORY.
///
/// **THE THREE OUTCOMES ARE THE APP'S THREE** (`ResolvedEqDir.readable`, and JOS-82's law that a
/// FAILED READ IS NOT "no logs"). `NotFound` is `missing` — the ordinary state of a machine with
/// EverQuest installed somewhere else, or none at all. Every other error is `unreadable`: a
/// permission refusal, a disconnected network share, a path that is a file rather than a folder.
/// They are two states rather than one because they are two sentences to a person, and because a
/// caller may reasonably want to try its own read on one of them and not on the other.
///
/// **A FILE THAT VANISHES MID-SCAN IS A ROW WITH NO `lastPlayed`, NOT A MISSING ROW.** The readdir
/// and the stat are two syscalls with a window between them, and EverQuest is writing into this
/// folder while a person clicks. Dropping the row would make a character disappear from a picker
/// for a reason nobody could ever see; carrying it without its sort key is the honest answer, and
/// the ordering rule below already says where an absent key sorts.
///
/// **A DIRECTORY ENTRY THAT IS NOT A FILE IS SKIPPED.** A folder called `eqlog_Foo_bar.txt` is not a
/// log, and handing one to `session.attach` would be an attach that can only fail. The check is on
/// the metadata this scan already has to take.
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
        // The metadata is taken ONCE and answers two questions: is this a file at all, and when was
        // it last written. A row survives a failure of the second and not of the first — see the
        // header.
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
/// **THE APP'S REGEX, STATED AS A RULE.** `/^eqlog_(.+?)_(.+?)\.txt$/i` is two LAZY groups, which
/// means the first underscore after the prefix ends the character name and everything up to `.txt`
/// is the server. That is not a detail: a server name containing an underscore is a thing that can
/// exist and a character name containing one is not, so the split must be leftmost or the two
/// implementations would disagree about a name — and a name is the join key the picker, the store's
/// per-character progress and `characterId` are all built on.
///
/// **CASE-INSENSITIVE AT BOTH ENDS, LIKE THE REGEX'S `i` FLAG**, and the NAMES themselves are taken
/// verbatim — the game's own capitalisation, never folded, because it is what the player sees.
///
/// **BOTH HALVES MUST BE NON-EMPTY**, which is the `+` in each group: `eqlog__freeport.txt` names no
/// character and `eqlog_Primitive_.txt` names no server, and a row carrying an empty string would be
/// a picker entry with a blank label.
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

/// ONE FILE'S LAST-MODIFIED TIME, in epoch milliseconds, or `None`.
///
/// TRUNCATED rather than rounded, so it equals `Math.floor(statSync(log).mtimeMs)` — Node reports
/// the same NTFS stamp as a float with sub-millisecond digits and the schema field is an integer.
/// The rule, and the reasons every failure answers `None` rather than `0`, are `world::mtime_ms`'s;
/// this is the same statement about a stat somebody else already took.
fn mtime_ms(meta: &std::fs::Metadata) -> Option<i64> {
    let since = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    i64::try_from(since.as_millis()).ok()
}

/// MOST RECENTLY WRITTEN FIRST — `listCharacters`'s `(b.lastPlayed ?? 0) - (a.lastPlayed ?? 0)`,
/// with the tiebreak the app's read does not need and this one does.
///
/// **AN ABSENT `lastPlayed` SORTS AS ZERO, exactly as the app's comparator does** — it goes last,
/// which is right for a file nothing can be said about and is the behaviour a launch with no engine
/// already has.
///
/// **THE TIEBREAK IS THE PATH, ASCENDING, AND IT IS DELIBERATE.** The app's comparator leans on
/// `Array.prototype.sort` being stable over whatever order `readdirSync` returned; `read_dir` makes
/// no such promise on any platform, so two logs with the same stamp — which is what a fresh copy of
/// an install looks like — could come back in either order on two consecutive calls. A served list
/// that reshuffles is diff churn against a client holding a window (the views law: every sort ends
/// in the source's own tiebreak, so order is TOTAL), and here it would also make a picker's rows
/// swap under a cursor. The cost is that on a tie this order may differ from the engine-absent
/// arm's; that is two equally-good answers to "which was played last", and it is stated here rather
/// than discovered.
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
/// IT IS A THIRD KIND OF STATE, like `client_spells` and for the mirror-image reason. It is not fold
/// state, so it does not move with the epoch; and unlike the spell table it is not derived from an
/// attach either — it is something the APP TOLD this process, so it survives an attach exactly as
/// `defines` does, and for the identical reason: a character switch is not the app withdrawing where
/// its logs live.
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

    /// A scratch Logs folder of this test's own. NEVER the owner's real logs, and nothing this
    /// creates is ever committed — the same rule every fixture in this program is under.
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

    /// Write one character log with a stated modification time, so ORDER is asserted against a fact
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
        // THE SORT KEY IS THE FILE'S OWN STAMP, which is what "last played" has always meant here.
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
        // A SERVER NAME MAY CARRY AN UNDERSCORE and a character name may not, which is why the app's
        // lazy regex splits leftmost and why this one does.
        log(&dir, "eqlog_Bard_test_server.txt", 1_700_000_002_000);
        // THE `i` FLAG, both ends.
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
        // JOS-82's law, served: a FAILED READ IS NOT "no logs", and the two are different sentences
        // to a person. A machine with EverQuest installed somewhere else reaches this every launch.
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
        // THE THIRD SILENCE, and it is the one a player is told to fix: the folder is right and
        // `/log on` has never been typed. `ok` with no rows is what says so.
        let dir = scratch("nologs");
        log(&dir, "dbg.txt", 1_700_000_000_000);
        let found = scan(&dir);
        assert_eq!(found.readable, LogsDirReadable::Ok);
        assert!(found.characters.is_empty());
    }

    #[test]
    fn ties_are_broken_by_path_so_two_scans_of_one_folder_agree() {
        // A FRESH COPY OF AN INSTALL is a folder of files with one stamp, and `read_dir` promises no
        // order at all — so without the tiebreak two consecutive scans could disagree and a served
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
