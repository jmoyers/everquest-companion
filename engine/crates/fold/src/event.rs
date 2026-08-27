//! `Event` — one canonical `LogEvent`, as the fold reads it.
//!
//! IT IS THE PARSER'S OWN TYPED PAYLOAD NOW (JOS-505), AND THE FILE HEADER THIS ONE REPLACES
//! PREDICTED THE EDIT. Through phase 2 it was a parsed `serde_json::Value`: `eqlog` wrote the
//! event's NDJSON line, this crate parsed that line back, and every module walked the resulting map
//! by string key. The reason was good at the time — the phase-1 bar is byte identity with
//! `JSON.stringify(ev)`, what that writes is the object's INSERTION order, and a typed struct per
//! kind beside the writer would have been a second declaration of the same shapes, free to drift.
//! The cost was measured in JOS-504 on the owner's 209 MB log: 9.6% of a whole fold on the re-parse
//! alone, and 69% in consumers walking the dynamic map it produced.
//!
//! THE RESOLUTION KEEPS THE ARGUMENT AND DROPS THE COST. There is still exactly ONE declaration of
//! every shape — the classifier that writes it — because `eqlog::event::Payload` is not a parallel
//! type but a RECORDING of the same writes: `out.s(Key::Attacker, x)` appends to the JSON string
//! and pushes `(Key::Attacker, Slot::Str)` in the same call. The string is still built eagerly and
//! still byte-identical, so the phase-1 oracle is untouched and nothing drifted; the fold simply
//! stopped reading it.
//!
//! ── TWO BODIES, AND WHY ────────────────────────────────────────────────────────────────────────
//!
//! A PRIMARY event borrows the parser's payload ([`Body::Typed`]). A DERIVED event — `epoch`,
//! `offlineGap`, `buffExpired`, and the early-warning break probes — is synthesized by the fold out
//! of a `json!` literal and keeps the `serde_json::Value` path ([`Body::Json`]). That is deliberate
//! rather than unfinished: the derived shapes are five, they are hand-written where they are
//! emitted, and the accessors answer them with the code this file has always used, so the
//! behaviour of the path is identical by construction rather than by re-derivation. The lifetime
//! is what the two bodies cost, and it is paid in three declarations: the fold's derived queue, the
//! buffs module's, and the break probe — all of which hold `Event<'static>` because a derived event
//! borrows nothing.
//!
//! ── ABSENT IS NOT NULL AND NEITHER IS ZERO ─────────────────────────────────────────────────────
//!
//! `str`/`int` answer `None` for a key the writer omitted AND for one it wrote as `null` — the TS
//! modules read both as `undefined` in every place any of them looks, and collapsing the two here
//! keeps the reading sites from each having to say so. The DISTINCTION still exists underneath
//! (`Slot::Null` versus no entry) because [`Event::has`] needs it: `buffFade.target` absent means
//! SELF, which is a different claim from a target of nothing.
//!
//! ── KEYS ───────────────────────────────────────────────────────────────────────────────────────
//!
//! Every accessor takes an [`EvKey`]: either a [`Key`] discriminant (the migrated, hot call sites)
//! or a `&str` (everything else, and the user-authored alert definitions, whose field names are not
//! known until runtime). A `&str` naming a field no event carries resolves to `None` and therefore
//! reads as ABSENT — exactly what a map lookup for a key nobody wrote answered before.

use eqlog::event::{Payload, Slot};
use serde_json::Value;

/// The parser's own field and kind discriminants, re-exported so a module names them through the
/// type it reads rather than through the crate that writes them.
pub use eqlog::event::{Key, Kind};

/// What an accessor may be handed as a key.
///
/// The `&str` impl exists so that a call site the perf work has not visited still compiles and
/// still means the same thing; `Key::parse` over a string LITERAL folds to a constant in release,
/// so the two forms usually cost the same. The `Key` form is what a hot site is migrated to,
/// because it cannot be wrong and cannot be slow.
pub trait EvKey: Copy {
    fn key(self) -> Option<Key>;
}

impl EvKey for Key {
    #[inline]
    fn key(self) -> Option<Key> {
        Some(self)
    }
}

impl EvKey for &str {
    #[inline]
    fn key(self) -> Option<Key> {
        Key::parse(self)
    }
}

/// One event's data — the parser's typed payload, or a `Value` the fold built itself.
#[derive(Debug, Clone)]
enum Body<'a> {
    Typed(&'a Payload),
    Json(Value),
}

/// One event on the bus: a primary event from the parser, or a DERIVED one the fold synthesized.
#[derive(Debug, Clone)]
pub struct Event<'a> {
    kind: Kind,
    body: Body<'a>,
}

impl<'a> Event<'a> {
    /// A PRIMARY event, straight off the parser — the production path, and the one this ticket
    /// exists for. Borrowed: the payload lives in the parser's reused buffers and is valid for
    /// exactly this event.
    #[must_use]
    pub fn typed(p: &'a Payload) -> Event<'a> {
        Event {
            kind: p.kind(),
            body: Body::Typed(p),
        }
    }
}

impl Event<'static> {
    /// Parse one NDJSON line from `eqlog::scan`. `None` when the line is not a JSON object, which
    /// the scanner cannot produce and which therefore only a corrupt input can reach.
    ///
    /// IT IS NO LONGER ON THE PRODUCTION PATH (JOS-505) and is kept for the modes that genuinely
    /// START from NDJSON text: the golden-driven view tests, the module-snapshot harness, and every
    /// unit test in this crate that states an event as the line the game would have produced.
    #[must_use]
    pub fn from_json(line: &str) -> Option<Event<'static>> {
        let v: Value = serde_json::from_str(line).ok()?;
        v.is_object().then(|| Event::from_value(v))
    }

    /// Wrap a value the fold built itself — `epoch`, `offlineGap`, `buffExpired`, and the
    /// early-warning break probes.
    #[must_use]
    pub fn from_value(v: Value) -> Event<'static> {
        let kind = Kind::parse(v.get("kind").and_then(Value::as_str).unwrap_or(""));
        Event {
            kind,
            body: Body::Json(v),
        }
    }
}

impl Event<'_> {
    /// The kind, as text. A `Body::Json` whose `kind` this build does not know answers with the
    /// string it actually carries rather than with the empty text [`Kind::Other`] would give — the
    /// only reader of that difference is a hand-built test fixture, and it deserves the truth.
    #[must_use]
    pub fn kind(&self) -> &str {
        match (&self.body, self.kind) {
            (Body::Json(v), Kind::Other) => v.get("kind").and_then(Value::as_str).unwrap_or(""),
            _ => self.kind.as_str(),
        }
    }

    /// THE KIND AS A DISCRIMINANT — an integer compare instead of a map lookup and a string
    /// compare. JOS-504 measured twenty-one consumers asking this question of every event at
    /// ~940 ms of a 2.5M-event fold; this is the answer that costs nothing.
    #[must_use]
    pub fn kind_of(&self) -> Kind {
        self.kind
    }

    /// The sequence number of the event. Every module writes it to its own `seq` field on EVERY
    /// event it is handed, derived ones included — that is the TS's first statement in `onEvent`.
    #[must_use]
    pub fn seq(&self) -> i64 {
        match &self.body {
            Body::Typed(p) => p.seq(),
            Body::Json(v) => v.get("seq").and_then(Value::as_i64).unwrap_or(0),
        }
    }

    #[must_use]
    pub fn ts(&self) -> i64 {
        match &self.body {
            Body::Typed(p) => p.ts(),
            Body::Json(v) => v.get("ts").and_then(Value::as_i64).unwrap_or(0),
        }
    }

    #[must_use]
    pub fn raw(&self) -> &str {
        match &self.body {
            Body::Typed(p) => p.raw(),
            Body::Json(v) => v.get("raw").and_then(Value::as_str).unwrap_or(""),
        }
    }

    #[must_use]
    pub fn str(&self, key: impl EvKey) -> Option<&str> {
        let k = key.key()?;
        match &self.body {
            Body::Typed(p) => match k {
                Key::Raw => Some(p.raw()),
                Key::Kind => Some(p.kind().as_str()),
                _ => p.str(k),
            },
            Body::Json(v) => v.get(k.as_str())?.as_str(),
        }
    }

    #[must_use]
    pub fn int(&self, key: impl EvKey) -> Option<i64> {
        let k = key.key()?;
        match &self.body {
            Body::Typed(p) => match k {
                Key::Seq => Some(p.seq()),
                Key::Ts => Some(p.ts()),
                _ => p.int(k),
            },
            Body::Json(v) => v.get(k.as_str())?.as_i64(),
        }
    }

    /// The one genuinely fractional field in the stream — `expGain.pct` (jsstr.rs's header names it
    /// as such). It widens an integral number too, which is what a log printing `(3%)` produces and
    /// what the TS reads as the same `number` either way.
    #[must_use]
    pub fn f64(&self, key: impl EvKey) -> Option<f64> {
        let k = key.key()?;
        match &self.body {
            Body::Typed(p) => p.f64(k),
            Body::Json(v) => v.get(k.as_str())?.as_f64(),
        }
    }

    #[must_use]
    pub fn bool(&self, key: impl EvKey) -> bool {
        let Some(k) = key.key() else {
            return false;
        };
        match &self.body {
            Body::Typed(p) => p.bool(k).unwrap_or(false),
            Body::Json(v) => v.get(k.as_str()).and_then(Value::as_bool).unwrap_or(false),
        }
    }

    /// A string ARRAY field — `selfWho.classes`, `damage.modifiers` and the `buffWearOff` candidate
    /// shape. A missing key, a non-array and a non-string element all read as absent, which is what
    /// `ev.classes.filter(isClassAbbr)` does with them on the other side.
    #[must_use]
    pub fn arr_str(&self, key: impl EvKey) -> Vec<&str> {
        let Some(k) = key.key() else {
            return Vec::new();
        };
        match &self.body {
            Body::Typed(p) => p.strs(k).map(Iterator::collect).unwrap_or_default(),
            Body::Json(v) => match v.get(k.as_str()).and_then(Value::as_array) {
                Some(list) => list.iter().filter_map(Value::as_str).collect(),
                None => Vec::new(),
            },
        }
    }

    /// HOW MANY ELEMENTS AN ARRAY FIELD HOLDS, without building the list — `ev.modifiers.length`.
    /// `0` for an absent field and for one that is not an array, which is what `map_or(0, len)`
    /// over the `Value` answered.
    #[must_use]
    pub fn arr_len(&self, key: impl EvKey) -> usize {
        let Some(k) = key.key() else {
            return 0;
        };
        match &self.body {
            Body::Typed(p) => match p.slot(k) {
                Some(Slot::Strs { len, .. } | Slot::Cands { len, .. }) => len as usize,
                _ => 0,
            },
            Body::Json(v) => v
                .get(k.as_str())
                .and_then(Value::as_array)
                .map_or(0, Vec::len),
        }
    }

    /// The `name` of every entry in an OBJECT array — the `candidates` list a `buffApply`, a `charm`
    /// and a `cc` carry. That list IS the spell DB's own cast-on-other suffix table, and the only
    /// thing most readers want from it is the names (`ev.candidates.map((c) => c.name)`).
    #[must_use]
    pub fn candidate_names(&self, key: impl EvKey) -> Vec<String> {
        let Some(k) = key.key() else {
            return Vec::new();
        };
        match &self.body {
            Body::Typed(p) => p
                .cands(k)
                .map(|it| it.map(|(n, _, _)| n.to_owned()).collect())
                .unwrap_or_default(),
            Body::Json(v) => match v.get(k.as_str()).and_then(Value::as_array) {
                Some(list) => list
                    .iter()
                    .filter_map(|c| c.get("name")?.as_str().map(str::to_string))
                    .collect(),
                None => Vec::new(),
            },
        }
    }

    /// EVERY NAME THE LIST CAN ANSWER TO, whichever shape it is in (JOS-84's reader).
    ///
    /// `buffWearOff.candidates` is a plain `string[]` where `buffApply`/`cc`/`charm` carry objects,
    /// and the alerts matcher is written against BOTH because a def does not know which sentence
    /// the game will print. One accessor rather than a caller-side union: the shapes are a fact
    /// about the writer and belong beside it.
    #[must_use]
    pub fn any_candidate_names(&self, key: impl EvKey) -> Vec<String> {
        let Some(k) = key.key() else {
            return Vec::new();
        };
        match &self.body {
            Body::Typed(p) => {
                if let Some(it) = p.cands(k) {
                    return it.map(|(n, _, _)| n.to_owned()).collect();
                }
                p.strs(k)
                    .map(|it| it.map(str::to_owned).collect())
                    .unwrap_or_default()
            }
            Body::Json(v) => match v.get(k.as_str()).and_then(Value::as_array) {
                Some(list) => list
                    .iter()
                    .filter_map(|c| match c {
                        Value::String(s) => Some(s.clone()),
                        Value::Object(o) => o.get("name")?.as_str().map(str::to_owned),
                        _ => None,
                    })
                    .collect(),
                None => Vec::new(),
            },
        }
    }

    /// The `candidates` list in full — `(name, durationMs, illusion)` per entry. `illusion` is
    /// `false` on the narrower `cc`/`charm` shape, which carries no such flag, exactly as the
    /// readers that walked the `Value` defaulted it.
    #[must_use]
    pub fn candidates(&self, key: impl EvKey) -> Vec<(String, Option<i64>, bool)> {
        let Some(k) = key.key() else {
            return Vec::new();
        };
        match &self.body {
            Body::Typed(p) => p
                .cands(k)
                .map(|it| it.map(|(n, d, i)| (n.to_owned(), d, i)).collect())
                .unwrap_or_default(),
            Body::Json(v) => match v.get(k.as_str()).and_then(Value::as_array) {
                Some(list) => list
                    .iter()
                    .map(|c| {
                        (
                            c.get("name")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            c.get("durationMs").and_then(Value::as_i64),
                            c.get("illusion")
                                .and_then(Value::as_bool)
                                .unwrap_or_default(),
                        )
                    })
                    .collect(),
                None => Vec::new(),
            },
        }
    }

    /// `ev.<key> != null` in the TS sense — the key is present AND not null. A 2c module branches
    /// on the DIFFERENCE between an absent optional and a present one whose value is falsy
    /// (`buffFade.target` absent means SELF; `''` would mean an unnamed entity), so the question
    /// has to be askable without reading the value.
    #[must_use]
    pub fn has(&self, key: impl EvKey) -> bool {
        let Some(k) = key.key() else {
            return false;
        };
        match &self.body {
            Body::Typed(p) => match k {
                Key::Kind | Key::Seq | Key::Ts | Key::Raw => true,
                _ => !matches!(p.slot(k), None | Some(Slot::Null)),
            },
            Body::Json(v) => !matches!(v.get(k.as_str()), None | Some(Value::Null)),
        }
    }

    /// STRINGIFY ONE FIELD THE WAY JAVASCRIPT'S `String()` DOES — the alerts matcher's only reader,
    /// and the reason it lives here rather than there: the coercion is a fact about the VALUE
    /// SHAPES, and after JOS-505 there are two representations of those shapes to keep honest.
    ///
    /// Reproduced rather than improved on, because the coerced text is exactly what every existing
    /// alert def is matched against: an array joins with ',' (a nullish element contributing ''),
    /// and an object element renders as the literal '[object Object]'. `None` for an absent field
    /// AND for an explicit null — a top-level null is refused by the matcher, exactly as `raw ==
    /// null` refuses it.
    #[must_use]
    pub fn field_text(&self, key: impl EvKey) -> Option<String> {
        let k = key.key()?;
        match &self.body {
            Body::Typed(p) => {
                if matches!(k, Key::Kind) {
                    return Some(p.kind().as_str().to_owned());
                }
                if matches!(k, Key::Raw) {
                    return Some(p.raw().to_owned());
                }
                if matches!(k, Key::Seq) {
                    return Some(js_number_text(p.seq() as f64));
                }
                if matches!(k, Key::Ts) {
                    return Some(js_number_text(p.ts() as f64));
                }
                match p.slot(k)? {
                    Slot::Str { .. } => p.str(k).map(str::to_owned),
                    Slot::Int(v) => Some(js_number_text(v as f64)),
                    Slot::Float(v) => Some(js_number_text(v)),
                    Slot::Bool(v) => Some(v.to_string()),
                    Slot::Null => None,
                    Slot::Strs { .. } => Some(
                        p.strs(k)
                            .map(|it| it.collect::<Vec<_>>().join(","))
                            .unwrap_or_default(),
                    ),
                    // Every element is an object, so `join` renders each as '[object Object]'.
                    Slot::Cands { .. } => Some(
                        p.cands(k)
                            .map(|it| it.map(|_| "[object Object]").collect::<Vec<_>>().join(","))
                            .unwrap_or_default(),
                    ),
                    Slot::Coins { .. } => Some("[object Object]".to_owned()),
                }
            }
            Body::Json(v) => match v.get(k.as_str()) {
                None | Some(Value::Null) => None,
                Some(raw) => Some(json_field_text(raw)),
            },
        }
    }
}

/// `String(v)` over a `serde_json::Value` — the `Body::Json` half of [`Event::field_text`], and the
/// function that half of this file used to be written entirely in terms of.
fn json_field_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_text(n.as_f64().unwrap_or_default()),
        // Only reachable as an array ELEMENT — `join` renders nullish as ''.
        Value::Null => String::new(),
        Value::Array(a) => a.iter().map(json_field_text).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn js_number_text(v: f64) -> String {
    let mut out = String::new();
    eqlog::jsstr::write_js_number(&mut out, v);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use eqlog::event::Ev;

    #[test]
    fn an_omitted_key_and_an_explicit_null_read_the_same() {
        let ev = Event::from_json(r#"{"kind":"loot","seq":3,"ts":7,"raw":"x","source":null}"#)
            .expect("object");
        assert_eq!(ev.kind(), "loot");
        assert_eq!(ev.kind_of(), Kind::Loot);
        assert_eq!(ev.seq(), 3);
        assert_eq!(ev.ts(), 7);
        assert_eq!(ev.str("source"), None);
        assert_eq!(ev.str("item"), None);
        assert!(!ev.bool("created"));
        // …but `has` still separates them, which is what the buffFade rule rests on.
        assert!(!ev.has("source"));
        assert!(!ev.has("item"));
    }

    /// THE TWO BODIES MUST BE INDISTINGUISHABLE THROUGH THE ACCESSORS. This is the whole
    /// correctness claim of the ticket in one test: the same event, written by the parser's writer
    /// and parsed from that writer's own output, answers every question identically.
    #[test]
    fn the_typed_body_and_the_json_body_answer_alike() {
        let mut w = Ev::new();
        w.begin(Kind::Damage);
        w.envelope(11, 22, "a raw line");
        w.s(Key::Attacker, "Primitive");
        w.s_or_null(Key::Spell, None);
        w.i(Key::Amount, 231);
        w.b(Key::Crit, true);
        w.strs(
            Key::Modifiers,
            &["crippling".to_string(), "riposte".to_string()],
        );
        let (json, payload) = w.done();
        let line = json.to_owned();
        let typed = Event::typed(payload);
        let parsed = Event::from_json(&line).expect("an object");
        for ev in [&typed, &parsed] {
            assert_eq!(ev.kind(), "damage");
            assert_eq!(ev.kind_of(), Kind::Damage);
            assert_eq!(ev.seq(), 11);
            assert_eq!(ev.ts(), 22);
            assert_eq!(ev.raw(), "a raw line");
            assert_eq!(ev.str("attacker"), Some("Primitive"));
            assert_eq!(ev.str(Key::Attacker), Some("Primitive"));
            assert_eq!(ev.str("spell"), None);
            assert!(ev.has("attacker"));
            assert!(!ev.has("spell"), "an explicit null is not `!= null`");
            assert!(!ev.has("target"));
            assert_eq!(ev.int("amount"), Some(231));
            assert_eq!(ev.f64("amount"), Some(231.0));
            assert!(ev.bool("crit"));
            assert_eq!(ev.arr_str("modifiers"), vec!["crippling", "riposte"]);
            assert_eq!(ev.field_text("attacker").as_deref(), Some("Primitive"));
            assert_eq!(ev.field_text("amount").as_deref(), Some("231"));
            assert_eq!(ev.field_text("crit").as_deref(), Some("true"));
            assert_eq!(
                ev.field_text("modifiers").as_deref(),
                Some("crippling,riposte")
            );
            assert_eq!(ev.field_text("spell"), None);
            assert_eq!(ev.field_text("nothing-writes-this"), None);
            assert_eq!(ev.field_text("seq").as_deref(), Some("11"));
        }
    }

    /// The candidate list is the one field written in two different shapes, and the alerts matcher
    /// reads both through one door.
    #[test]
    fn both_candidate_shapes_answer_the_same_question() {
        let mut w = Ev::new();
        w.begin(Kind::BuffApply);
        w.envelope(0, 0, "x");
        w.cands_ndi(
            Key::Candidates,
            vec![("Haste".to_string(), Some(1000), true)].into_iter(),
        );
        let (json, payload) = w.done();
        let line = json.to_owned();
        for ev in [Event::typed(payload), Event::from_json(&line).expect("obj")] {
            assert_eq!(ev.candidate_names("candidates"), vec!["Haste".to_string()]);
            assert_eq!(
                ev.any_candidate_names("candidates"),
                vec!["Haste".to_string()]
            );
            assert_eq!(
                ev.candidates("candidates"),
                vec![("Haste".to_string(), Some(1000), true)]
            );
            assert_eq!(
                ev.field_text("candidates").as_deref(),
                Some("[object Object]")
            );
        }

        let mut w = Ev::new();
        w.begin(Kind::BuffWearOff);
        w.envelope(0, 0, "x");
        w.strs(
            Key::Candidates,
            &["Haste".to_string(), "Alacrity".to_string()],
        );
        let (json, payload) = w.done();
        let line = json.to_owned();
        for ev in [Event::typed(payload), Event::from_json(&line).expect("obj")] {
            // The OBJECT reader sees nothing in a string list — the same `None` a `c.name` lookup
            // over a string element produced.
            assert!(ev.candidate_names("candidates").is_empty());
            assert_eq!(
                ev.any_candidate_names("candidates"),
                vec!["Haste".to_string(), "Alacrity".to_string()]
            );
            assert_eq!(
                ev.field_text("candidates").as_deref(),
                Some("Haste,Alacrity")
            );
        }
    }

    /// A derived event rides the `Value` path, and nothing above it can tell.
    #[test]
    fn a_derived_event_answers_like_any_other() {
        let ev = Event::from_value(serde_json::json!({
            "kind": "buffExpired", "seq": 4, "ts": 9, "raw": "Haste wore off you.",
            "spell": "Haste", "target": "self",
        }));
        assert_eq!(ev.kind_of(), Kind::BuffExpired);
        assert_eq!(ev.kind(), "buffExpired");
        assert_eq!(ev.str(Key::Spell), Some("Haste"));
        assert!(ev.has("target"));
        assert_eq!(ev.seq(), 4);
    }

    /// A hand-built fixture naming a kind this build does not know keeps its own word for it.
    #[test]
    fn an_unrecognized_kind_keeps_its_text() {
        let ev = Event::from_value(serde_json::json!({ "kind": "nonsense" }));
        assert_eq!(ev.kind(), "nonsense");
        assert_eq!(ev.kind_of(), Kind::Other);
    }
}
