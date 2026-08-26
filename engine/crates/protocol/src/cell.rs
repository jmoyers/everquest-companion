//! One render-ready cell — the one type the generator is told to leave alone.
//!
//! WHY THIS IS HAND-WRITTEN when everything else in the contract is generated. `Cell` is
//! `["string","number","boolean","null"]` in the schema, and typify lowers a multi-type schema to
//! an untagged enum whose number arm is `f64`. That is type-correct and quietly wrong for this
//! protocol: `184220` deserializes to `184220.0` and re-serializes as `184220.0`, so a value the
//! engine was handed is not the value the engine sends on. For a corpus of DAMAGE TOTALS and ITEM
//! COUNTS that is not a rounding nicety, it is the difference between a number and a number with a
//! decimal point stapled to it — and it would make the worked examples from the plan doc fail to
//! round-trip verbatim, which is exactly the property the fixture suite exists to assert.
//!
//! So `protocol-codegen` replaces the generated `Cell` with this one (`TypeSpaceSettings::
//! with_replacement`), and this one keeps the JSON number exactly as it arrived. It is still a
//! CLOSED type: deserialization refuses an object or an array, so `Cells` cannot quietly become a
//! nesting ground and the renderer's promise — that a cell is what the pixel says — survives.
//!
//! THE RULE THIS ENCODES (owner ruling 4): the renderer never munges domain data. A cell arrives
//! already formatted, already rounded, already in place. A `String` here is display text; a number
//! is here because the renderer needs the MAGNITUDE (a bar width, a share), never because it is
//! expected to do the formatting.

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// One render-ready value: a string, a number, a boolean, or null. Never an object or an array.
#[derive(Clone, Debug, PartialEq)]
pub struct Cell(serde_json::Value);

impl Cell {
    /// Display text.
    #[must_use]
    pub fn text(value: impl Into<String>) -> Self {
        Self(serde_json::Value::String(value.into()))
    }

    /// A whole number, kept whole.
    #[must_use]
    pub fn int(value: i64) -> Self {
        Self(serde_json::Value::Number(value.into()))
    }

    /// A fractional number. Rounded to what the pixel shows BEFORE it gets here — this type will
    /// carry whatever it is given, and NaN or an infinity is not representable in JSON, so both
    /// become null rather than a malformed message.
    #[must_use]
    pub fn float(value: f64) -> Self {
        serde_json::Number::from_f64(value)
            .map_or_else(Self::null, |n| Self(serde_json::Value::Number(n)))
    }

    /// A flag.
    #[must_use]
    pub fn flag(value: bool) -> Self {
        Self(serde_json::Value::Bool(value))
    }

    /// Nothing. Distinct from an ABSENT cell in a diff: absent means unchanged, null means cleared.
    #[must_use]
    pub fn null() -> Self {
        Self(serde_json::Value::Null)
    }

    /// The underlying JSON value.
    #[must_use]
    pub fn as_json(&self) -> &serde_json::Value {
        &self.0
    }

    /// Is this value one a cell may hold?
    #[must_use]
    pub fn is_scalar(value: &serde_json::Value) -> bool {
        matches!(
            value,
            serde_json::Value::Null
                | serde_json::Value::Bool(_)
                | serde_json::Value::Number(_)
                | serde_json::Value::String(_)
        )
    }
}

impl Serialize for Cell {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Cell {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        if Self::is_scalar(&value) {
            return Ok(Self(value));
        }
        Err(D::Error::custom(
            "a cell must be a string, number, boolean or null - never an object or an array",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::Cell;

    #[test]
    fn a_whole_number_survives_the_round_trip_whole() {
        // The entire reason this type is hand-written. `184220` must not come back `184220.0`.
        let json = "184220";
        let cell: Cell = serde_json::from_str(json).expect("a number is a cell");
        assert_eq!(serde_json::to_string(&cell).expect("cells serialize"), json);
    }

    #[test]
    fn a_fraction_survives_too() {
        for json in ["412.6", "0.38", "-1.5"] {
            let cell: Cell = serde_json::from_str(json).expect("a number is a cell");
            assert_eq!(serde_json::to_string(&cell).expect("cells serialize"), json);
        }
    }

    #[test]
    fn strings_booleans_and_null_survive() {
        for json in ["\"Cloak of Flames\"", "true", "false", "null"] {
            let cell: Cell = serde_json::from_str(json).expect("a scalar is a cell");
            assert_eq!(serde_json::to_string(&cell).expect("cells serialize"), json);
        }
    }

    #[test]
    fn structure_is_refused_rather_than_flattened() {
        for json in ["{}", "[]", "{\"nested\":1}", "[1,2]"] {
            assert!(
                serde_json::from_str::<Cell>(json).is_err(),
                "{json} was accepted as a cell"
            );
        }
    }

    #[test]
    fn a_number_json_cannot_represent_becomes_null_rather_than_a_broken_message() {
        assert_eq!(Cell::float(f64::NAN), Cell::null());
        assert_eq!(Cell::float(f64::INFINITY), Cell::null());
    }
}
