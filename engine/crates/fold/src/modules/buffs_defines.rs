//! The `buffTrust` define — what the app knows that the log did not say, for the buffs core.
//!
//! Moved out of `buffs.rs` when the payload grew a second half (the proc gate, upstream issue
//! #69): that file sits over the factoring bar and takes no new lines. The `impl` is verbatim what
//! it was, plus the two new fields.
//!
//! It lands on the shared core and therefore on both modules at once, so the buff bar and the
//! crowd-control bar cannot end up with two ideas of whose spell just landed. `buffs` answers for
//! the family because it owns the core's construction; `buffTimers` clones the same handle and
//! needs no define of its own.

use crate::modules::buffs::BuffsModule;
use serde_json::Value;

/// The strings of a JSON array, skipping anything that is not one. A missing array is empty.
fn strings_of(payload: &Value, key: &str) -> Vec<String> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

impl crate::Defines for BuffsModule {
    fn family(&self) -> &'static str {
        "buffTrust"
    }

    /// The whole preference, replaced whole: the externals allowlist, and the proc gate with the
    /// combat effects of the items the player holds (`procDebuffs`, `procSpells` — display names,
    /// keyed by the anchors). A payload with no `externals` is the malformed case the trait
    /// describes and leaves everything as it was; the proc fields absent read as the shipped
    /// default, off and empty, because the app sends the full set every time.
    fn define(&mut self, payload: &Value) {
        if payload.get("externals").and_then(Value::as_array).is_none() {
            return;
        }
        let enabled = payload
            .get("procDebuffs")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut core = self.core.borrow_mut();
        core.anchors.set_trust(strings_of(payload, "externals"));
        core.anchors
            .set_proc_trust(enabled, strings_of(payload, "procSpells"));
    }
}
