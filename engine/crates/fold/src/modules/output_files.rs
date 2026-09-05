//! `src/main/modules/outputFiles.ts` — when the player last exported each `/outputfile` dump.
//!
//! Newest wins, and only the newest is kept: the log holds every export the character ever made,
//! but the only one that can be a baseline is the one that wrote the file now on disk.
//!
//! Epoch is deliberately not handled — the file on disk outlives the epoch too, and this module
//! reports when that file was written, not whose it was.
//!
//! `flushDelta` always returns null over there (nothing in the renderer subscribes; main reads it
//! through `writtenAt()`), which is what the trait's default `None` is.

use crate::event::Event;
use crate::jsfn::base_name;
use crate::jsmap::JsMap;
use crate::EqModule;
use eqlog::jsstr::js_trim;
use serde_json::{json, Value};

#[derive(Default)]
pub struct OutputFilesModule {
    written: JsMap<i64>,
    seq: i64,
    /// The announce cursor — see [`crate::announce`]. It must be seq-valued, not a counter: this
    /// module is mirrored in main (`serveMirrors.ts MIRRORED_MODULES`), and that mirror stores the
    /// snapshot's seq and drops any cursor at or below it, so a counter would freeze the mirror on
    /// its first refresh.
    announce: crate::announce::Announce,
}

impl OutputFilesModule {
    pub fn new() -> Self {
        Self::default()
    }
}

/// `fileKey` — the last path segment, trimmed and lowercased. EQ writes dumps into the install root
/// and prints the bare name, so the join is on that segment, case-insensitively.
fn file_key(path_or_name: &str) -> String {
    js_trim(base_name(path_or_name)).to_lowercase()
}

impl EqModule for OutputFilesModule {
    fn id(&self) -> &'static str {
        "outputFiles"
    }

    fn reset(&mut self) {
        self.written.clear();
        self.seq = 0;
        self.announce.reset();
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        self.seq = ev.seq();
        if ev.kind() != "outputFile" {
            return;
        }
        let key = file_key(ev.str("file").unwrap_or_default());
        let ts = ev.ts();
        match self.written.get(&key) {
            // A dump whose stamp is not newer than the one held changes nothing.
            Some(&prev) if ts <= prev => {}
            _ => {
                self.written.insert(key, ts);
                self.announce.changed(self.seq);
            }
        }
    }

    /// Moves on a dump not already recorded at that instant or later. See the `announce` field.
    fn published_seq(&self) -> Option<i64> {
        Some(self.announce.cursor())
    }

    fn snapshot(&self) -> Value {
        json!({ "seq": self.seq, "state": self.written })
    }
}
