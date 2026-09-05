//! The client's spell table, read by this process. `fold::spells_us` is the format, pure over a
//! string; this file is the FILE — where it is, when it is read, and who waits.
//!
//! The table is never served as a bulk frame: measured at 48,252 entries and 6.13 MiB of JSON
//! against an 8 MiB frame ceiling, on a table that grows with every client patch. This process
//! parses it internally for its own joins and consumers ask per-spell questions instead. Nothing
//! here serialises the table and there is deliberately no method that could.
//!
//! The path is derived from the attach, never discovered: the app pushes a log at
//! `<eqRoot>/Logs/eqlog_<Char>_<server>.txt`, so the table is `<eqRoot>/spells_us.txt`. A character
//! switch that changes installs changes the table with it, and nothing on the wire says so.
//!
//! The file is allowed to be missing — a folder of logs with no EverQuest behind it is a real
//! configuration, and it produces a card that says so rather than a refusal.
//!
//! The read is lazy, on a connection thread, exactly once. Never on the ingest thread: 38 MB and a
//! few hundred milliseconds of parsing on the thread that tails the log is the class of stall this
//! program exists to remove. Never at attach, which would put a third of a second onto every
//! character switch to serve a question nobody may ask. [`std::sync::OnceLock`] is the whole
//! mechanism, and a failure is memoised too, so a missing file is answered instantly forever.
//!
//! Nothing is cached across a process, so there is nothing to invalidate: a client patch that
//! rewrites `spells_us.txt` is followed by a game launch and a fresh engine. What it will not do is
//! notice a patch mid-session, which costs a restart the player has already performed.

use fold::dbstr::{parse_spell_categories, CategoryNames};
use fold::spells_us::{parse_spells_us, SpellInfo, SpellTable};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The client table for one install, read at most once.
///
/// Created at attach (a path join and an empty cell) and filled by whoever asks first. A new attach
/// makes a new one, so an install change is a new table rather than a stale one to be noticed.
#[derive(Debug)]
pub struct ClientSpells {
    /// `<eqRoot>/spells_us.txt`, derived from the attach's log path.
    path: PathBuf,
    /// `<eqRoot>/dbstr_us.txt`, beside it. See [`ClientSpells::category_names`].
    dbstr_path: PathBuf,
    /// The parsed table, or `None` when the file could not be read. Filled once.
    table: OnceLock<Option<SpellTable>>,
    /// The spell-category vocabulary, read from `dbstr_us.txt`. Filled once, independently of
    /// `table`: a surface can want the words without the rows and the two files fail separately.
    categories: OnceLock<CategoryNames>,
}

/// Why there is no table, in the app's own words, so the two implementations describe the same three
/// situations the same way and a card's sentence does not depend on which process answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TableState {
    /// Read and parsed.
    Ok,
    /// There is no `spells_us.txt` at the derived path. A supported state — see the header.
    Missing,
    /// The file is there and could not be read or decoded.
    Unloadable,
}

impl ClientSpells {
    /// Where the table would be, given the log this world is folding.
    ///
    /// `<eqRoot>/Logs/eqlog_<Char>_<server>.txt` → `<eqRoot>/spells_us.txt`. `None` when the log
    /// path has no grandparent, which is a path shaped like nothing the product produces; answering
    /// `None` rather than guessing is the rule.
    #[must_use]
    pub fn beside_log(log: &Path) -> Option<Self> {
        let root = log.parent()?.parent()?;
        Some(Self {
            path: root.join("spells_us.txt"),
            dbstr_path: root.join("dbstr_us.txt"),
            table: OnceLock::new(),
            categories: OnceLock::new(),
        })
    }

    /// The path this would read. Reported on the health/diagnostic surfaces so a card that says
    /// "there is no spells_us.txt at …" can name the place it looked.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The table, parsing it if nobody has yet. Blocks the calling thread on the first call.
    ///
    /// See the header for why that is a connection thread and never the ingest's, and for why the
    /// `None` is memoised alongside the `Some`.
    pub fn table(&self) -> Option<&SpellTable> {
        self.table.get_or_init(|| read(&self.path)).as_ref()
    }

    /// One spell, by the name the asker spells it. `None` for a name the table has no row for, and
    /// for every state in which there is no table.
    ///
    /// The key is folded here: `spell_canon_key` strips a trailing Roman numeral and lower-cases, so
    /// `Scorching Arrow IV` and `scorching arrow` are one question. It is the same fold the table
    /// was built under, and a caller that pre-folded would be a second opinion about a join key.
    pub fn spell(&self, name: &str) -> Option<&SpellInfo> {
        self.table()?.get(&eqlog::names::spell_canon_key(name))
    }

    /// The words behind the category ids, parsing `dbstr_us.txt` if nobody has yet.
    ///
    /// `spells_us.txt` files a spell under integer ids and nothing else; the string table beside it
    /// is where `114` becomes `Taps`. Both live in the install the attach named.
    ///
    /// An unreadable string table is an empty map rather than a failure: every id resolves to no
    /// word, so a row reports no category and a surface offers no category filter — a degraded list
    /// rather than an outage.
    ///
    /// The read is the same shape as the table's: on whichever connection thread asks first, exactly
    /// once per install, memoised including its failure.
    pub fn category_names(&self) -> &CategoryNames {
        self.categories.get_or_init(|| {
            read_latin1(&self.dbstr_path)
                .map_or_else(CategoryNames::new, |text| parse_spell_categories(&text))
        })
    }

    /// Why there is no answer, for a surface that has to say something. Forces the read, like
    /// [`ClientSpells::table`], because "is it there" cannot be answered without looking.
    #[must_use]
    pub fn state(&self) -> TableState {
        if self.table().is_some() {
            return TableState::Ok;
        }
        if self.path.exists() {
            TableState::Unloadable
        } else {
            TableState::Missing
        }
    }
}

/// Read and parse, or `None`.
///
/// Latin-1, never UTF-8: latin1 never throws and never replaces a byte, and every field this parser
/// reads is ASCII. A UTF-8 read of a file with one stray high byte in a spell name would substitute
/// a replacement character, which changes a NAME and therefore a join key — so the bytes are widened
/// one at a time rather than run through `from_utf8_lossy`.
fn read(path: &Path) -> Option<SpellTable> {
    Some(parse_spells_us(&read_latin1(path)?))
}

/// One client file's bytes, widened to text. See [`read`] for why the encoding is latin-1.
fn read_latin1(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(bytes.iter().map(|&b| char::from(b)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn scratch(tag: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "engined-spells-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(dir.join("Logs")).expect("a scratch install");
        dir
    }

    /// One 173-field row. Hand-authored: the client table is Daybreak's file and no slice of it may
    /// enter this repo.
    fn row(id: &str, name: &str, resist_type: &str, slots: &str) -> String {
        let mut f = vec!["0".to_string(); 173];
        for field in f.iter_mut().take(52).skip(36) {
            *field = "255".to_string();
        }
        f[0] = id.to_string();
        f[1] = name.to_string();
        f[29] = resist_type.to_string();
        f[49] = "39".to_string();
        f[172] = slots.to_string();
        f.join("^")
    }

    #[test]
    fn the_table_sits_beside_the_install_the_log_names() {
        let dir = scratch("path");
        let log = dir.join("Logs").join("eqlog_Primitive_freeport.txt");
        let spells = ClientSpells::beside_log(&log).expect("a derivable path");
        // `<eqRoot>/Logs/<log>` → `<eqRoot>/spells_us.txt`. Nothing on the wire says this.
        assert_eq!(spells.path(), dir.join("spells_us.txt"));
    }

    #[test]
    fn a_log_path_with_no_install_above_it_derives_nothing() {
        assert!(ClientSpells::beside_log(Path::new("eqlog.txt")).is_none());
    }

    #[test]
    fn a_missing_file_is_a_supported_state_and_not_an_error() {
        let dir = scratch("missing");
        let log = dir.join("Logs").join("eqlog_Primitive_freeport.txt");
        let spells = ClientSpells::beside_log(&log).expect("a derivable path");
        // A folder of logs with no EverQuest behind it is a real configuration, and it produces a
        // card that says so — never a refusal, and never a panic.
        assert!(spells.table().is_none());
        assert_eq!(spells.state(), TableState::Missing);
        assert!(spells.spell("Tashani").is_none());
    }

    #[test]
    fn a_real_file_is_parsed_once_and_answered_per_spell() {
        let dir = scratch("ok");
        let log = dir.join("Logs").join("eqlog_Primitive_freeport.txt");
        std::fs::write(
            dir.join("spells_us.txt"),
            format!(
                "{}\n{}\n",
                row("677", "Tashani", "1", "2|50|-10|0|101|23"),
                row("350", "Chaos Flux", "1", "1|50|-20|0|101|30")
            ),
        )
        .expect("the staged table");
        let spells = ClientSpells::beside_log(&log).expect("a derivable path");
        assert_eq!(spells.state(), TableState::Ok);

        let tashani = spells.spell("Tashani").expect("a row");
        assert_eq!(tashani.axis, Some(fold::spells_us::Axis::Magic));
        assert_eq!(tashani.debuff_slots.len(), 1);

        // The key is folded here, so a rank suffix and a case difference are one question — the
        // same fold the table was built under.
        assert!(spells.spell("chaos flux").is_some());
        assert!(spells.spell("Chaos Flux II").is_some());
        assert!(spells.spell("Not A Spell").is_none());
    }

    #[test]
    fn the_read_happens_once_even_when_the_file_disappears_underneath_it() {
        // Once per install: the answer does not change when the input does. Nothing re-stats,
        // nothing re-parses, and a client patch mid-session costs the restart the player has
        // already performed.
        let dir = scratch("once");
        let log = dir.join("Logs").join("eqlog_Primitive_freeport.txt");
        let table = dir.join("spells_us.txt");
        std::fs::write(&table, format!("{}\n", row("677", "Tashani", "1", ""))).expect("staged");
        let spells = ClientSpells::beside_log(&log).expect("a derivable path");
        assert!(spells.spell("Tashani").is_some());
        std::fs::remove_file(&table).expect("removed");
        assert!(
            spells.spell("Tashani").is_some(),
            "the parsed table outlives the file it was read from"
        );
    }

    #[test]
    fn a_file_that_parses_to_nothing_is_still_a_read_file() {
        // An empty table is not a missing one. Every row was refused (none has 172 fields), which
        // is `ok` with no answers rather than `missing` — conflating them would tell a player to go
        // and find a folder they are already in.
        let dir = scratch("empty");
        let log = dir.join("Logs").join("eqlog_Primitive_freeport.txt");
        std::fs::write(dir.join("spells_us.txt"), "not^a^spell^row\n").expect("staged");
        let spells = ClientSpells::beside_log(&log).expect("a derivable path");
        assert_eq!(spells.state(), TableState::Ok);
        assert!(spells.table().expect("a table").is_empty());
    }
}
