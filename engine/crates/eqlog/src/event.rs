//! THE EVENT WRITER — a JSON object built key by key, in the order the TS object literal states.
//!
//! WHY THIS IS NOT A `serde` ENUM. The phase-1 bar is byte identity with `JSON.stringify(ev)`, and
//! what `JSON.stringify` writes is the object's INSERTION ORDER — which in the TS parser is a
//! property of the CODE PATH, not of the kind. `damage` alone is written four different ways
//! (`dclass` only on the typed-nuke path, `verb` only on the melee one, `modifiers` absent entirely
//! on the damage-shield one), a field set to `undefined` disappears, and `group` puts `change`
//! ahead of `seq`/`ts`/`raw` where every other kind puts them first. A derived struct per kind
//! would have to be a struct per BRANCH, and the ordering claim would live in a `#[derive]` far
//! from the branch that makes it.
//!
//! So a classifier writes its fields in the same sequence its TS twin lists them, and the two can
//! be read side by side. The buffer is reused across events; nothing here allocates per line.

use crate::jsstr::{write_js_number, write_json_string};

/// One event, being written. `begin` resets it; `finish` hands back the serialized line.
pub struct Ev {
    buf: String,
    first: bool,
}

impl Default for Ev {
    fn default() -> Self {
        Self::new()
    }
}

impl Ev {
    pub fn new() -> Self {
        Ev {
            buf: String::with_capacity(512),
            first: true,
        }
    }

    /// Open a fresh object and write its `kind` — every kind but `group` follows it with the
    /// envelope, so `begin` deliberately does NOT write one (see `envelope`).
    pub fn begin(&mut self, kind: &str) {
        self.buf.clear();
        self.buf.push('{');
        self.first = true;
        self.s("kind", kind);
    }

    /// `seq`, `ts`, `raw` — the three `LogEventBase` fields, in the order the TS literals spread
    /// them. Called AFTER whatever a kind puts ahead of them (`group.change` is the only one).
    pub fn envelope(&mut self, seq: i64, ts: i64, raw: &str) {
        self.i("seq", seq);
        self.i("ts", ts);
        self.s("raw", raw);
    }

    pub fn finish(&mut self) -> &str {
        self.buf.push('}');
        &self.buf
    }

    fn key(&mut self, k: &str) {
        if !self.first {
            self.buf.push(',');
        }
        self.first = false;
        self.buf.push('"');
        self.buf.push_str(k);
        self.buf.push_str("\":");
    }

    pub fn s(&mut self, k: &str, v: &str) {
        self.key(k);
        write_json_string(&mut self.buf, v);
    }

    /// A field JS wrote as `undefined` when absent — `JSON.stringify` omits the key entirely.
    pub fn s_opt(&mut self, k: &str, v: Option<&str>) {
        if let Some(v) = v {
            self.s(k, v);
        }
    }

    pub fn i(&mut self, k: &str, v: i64) {
        self.key(k);
        self.buf.push_str(&v.to_string());
    }

    pub fn i_opt(&mut self, k: &str, v: Option<i64>) {
        if let Some(v) = v {
            self.i(k, v);
        }
    }

    /// A field whose ABSENCE is spelled `null` in the TS (`durationMs`, `attacker` on a
    /// caster-less DoT) — present, and explicitly nothing.
    pub fn i_or_null(&mut self, k: &str, v: Option<i64>) {
        match v {
            Some(v) => self.i(k, v),
            None => {
                self.key(k);
                self.buf.push_str("null");
            }
        }
    }

    pub fn s_or_null(&mut self, k: &str, v: Option<&str>) {
        match v {
            Some(v) => self.s(k, v),
            None => {
                self.key(k);
                self.buf.push_str("null");
            }
        }
    }

    pub fn b(&mut self, k: &str, v: bool) {
        self.key(k);
        self.buf.push_str(if v { "true" } else { "false" });
    }

    pub fn f(&mut self, k: &str, v: f64) {
        self.key(k);
        write_js_number(&mut self.buf, v);
    }

    pub fn strs(&mut self, k: &str, v: &[String]) {
        self.key(k);
        self.buf.push('[');
        for (i, s) in v.iter().enumerate() {
            if i > 0 {
                self.buf.push(',');
            }
            write_json_string(&mut self.buf, s);
        }
        self.buf.push(']');
    }

    /// `candidates: cands.map((s) => ({ name, durationMs }))` — the charm/cc shape.
    pub fn cands_nd(&mut self, k: &str, v: impl Iterator<Item = (String, Option<i64>)>) {
        self.key(k);
        self.buf.push('[');
        for (i, (name, dur)) in v.enumerate() {
            if i > 0 {
                self.buf.push(',');
            }
            self.buf.push_str("{\"name\":");
            write_json_string(&mut self.buf, &name);
            self.buf.push_str(",\"durationMs\":");
            match dur {
                Some(d) => self.buf.push_str(&d.to_string()),
                None => self.buf.push_str("null"),
            }
            self.buf.push('}');
        }
        self.buf.push(']');
    }

    /// `candidates: cands.map((s) => ({ name, durationMs, illusion }))` — the buffApply shape.
    pub fn cands_ndi(&mut self, k: &str, v: impl Iterator<Item = (String, Option<i64>, bool)>) {
        self.key(k);
        self.buf.push('[');
        for (i, (name, dur, illusion)) in v.enumerate() {
            if i > 0 {
                self.buf.push(',');
            }
            self.buf.push_str("{\"name\":");
            write_json_string(&mut self.buf, &name);
            self.buf.push_str(",\"durationMs\":");
            match dur {
                Some(d) => self.buf.push_str(&d.to_string()),
                None => self.buf.push_str("null"),
            }
            self.buf.push_str(",\"illusion\":");
            self.buf.push_str(if illusion { "true" } else { "false" });
            self.buf.push('}');
        }
        self.buf.push(']');
    }

    /// `coins` / `price` — an object whose KEY ORDER is the order the denominations appeared in the
    /// clause (`parseCoins` assigns as it scans), which is why it is a slice of pairs and not a map.
    pub fn coins(&mut self, k: &str, v: &[(&'static str, i64)]) {
        self.key(k);
        self.buf.push('{');
        for (i, (denom, amount)) in v.iter().enumerate() {
            if i > 0 {
                self.buf.push(',');
            }
            write_json_string(&mut self.buf, denom);
            self.buf.push(':');
            self.buf.push_str(&amount.to_string());
        }
        self.buf.push('}');
    }
}
