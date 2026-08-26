//! `JsMap` — a string-keyed map that iterates in INSERTION ORDER, because JavaScript's do.
//!
//! WHY THIS EXISTS AT ALL. Several ported modules turn a map into an ARRAY at snapshot time —
//! `spellSets.memorized` is `[...this.memorized.values()]`, and every set definition's `spells` is
//! the same expression — so the map's iteration order IS the serialized array's order, and array
//! order is a claim the comparator checks. A `HashMap` would randomize it and a `BTreeMap` would
//! sort it; neither is what a JS `Map` (or a plain object with non-index keys) does.
//!
//! THE TWO JS RULES IT REPRODUCES, and they are the same rule:
//!   * `map.set(k, v)` on a key that is already present KEEPS its original position.
//!   * `map.delete(k)` removes it and leaves everything else in order.
//!
//! O(n) REMOVAL, on purpose. Only `spellSets` deletes (a forgotten gem, a deleted set) and its maps
//! hold at most a couple of dozen entries; every large map here (kills, itemTiers,
//! observedSpellRanks, outputFiles) is insert-and-update only. A structure that made deletion cheap
//! would cost an indirection on the hot path to buy nothing.
//!
//! IT SERIALIZES AS A JSON OBJECT, and the insertion order does NOT survive that: `serde_json`'s
//! `Map` is a `BTreeMap`, so `to_value` sorts the keys. That is FINE and is stated here so nobody
//! "fixes" it — the phase-2 bar is DEEP equality (owner ruling 12 / `goldenOracle.mts firstDiff`),
//! under which object key order is not a claim either implementation makes. What the order is
//! load-bearing for is the arrays derived from `values()`, and those are built before serialization.

use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct JsMap<V> {
    entries: Vec<(String, V)>,
    at: HashMap<String, usize>,
}

impl<V> Default for JsMap<V> {
    fn default() -> Self {
        Self::new()
    }
}

impl<V> JsMap<V> {
    pub fn new() -> Self {
        JsMap {
            entries: Vec::new(),
            at: HashMap::new(),
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.at.clear();
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.at.contains_key(key)
    }

    pub fn get(&self, key: &str) -> Option<&V> {
        self.at.get(key).map(|&i| &self.entries[i].1)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        match self.at.get(key) {
            Some(&i) => Some(&mut self.entries[i].1),
            None => None,
        }
    }

    /// `map.set(k, v)` — an existing key keeps its position, a new one appends.
    pub fn insert(&mut self, key: String, value: V) {
        match self.at.get(&key) {
            Some(&i) => self.entries[i].1 = value,
            None => {
                self.at.insert(key.clone(), self.entries.len());
                self.entries.push((key, value));
            }
        }
    }

    /// `map.delete(k)` — true when something was removed. See the header on the cost.
    pub fn remove(&mut self, key: &str) -> bool {
        let Some(i) = self.at.remove(key) else {
            return false;
        };
        self.entries.remove(i);
        for slot in self.at.values_mut() {
            if *slot > i {
                *slot -= 1;
            }
        }
        true
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &V)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }

    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.entries.iter().map(|(_, v)| v)
    }

    /// `for (const v of map.values()) v.field = …` — a walk that WRITES to every value without
    /// touching the keys. The roster's offline-gap sweep marks its stale members in place, and the
    /// crowd-control half re-reads the estimator across every live hold of one (line, caster) after
    /// a sample lands.
    pub fn values_mut(&mut self) -> impl Iterator<Item = &mut V> {
        self.entries.iter_mut().map(|(_, v)| v)
    }

    /// The keys in insertion order — the LRU order the respawn module's history evicts from.
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(k, _)| k.as_str())
    }

    /// `[...map.values()]` — the values, owned, in insertion order. The combo scorer turns three of
    /// its maps straight into arrays this way, and the array's order is a published claim.
    pub fn into_values(self) -> Vec<V> {
        self.entries.into_iter().map(|(_, v)| v).collect()
    }
}

impl<V: serde::Serialize> serde::Serialize for JsMap<V> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(Some(self.entries.len()))?;
        for (k, v) in &self.entries {
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reinsert_keeps_its_place_and_a_delete_closes_the_gap() {
        let mut m: JsMap<i32> = JsMap::new();
        m.insert("a".into(), 1);
        m.insert("b".into(), 2);
        m.insert("c".into(), 3);
        m.insert("a".into(), 9);
        assert_eq!(m.values().copied().collect::<Vec<_>>(), vec![9, 2, 3]);
        assert!(m.remove("b"));
        assert!(!m.remove("b"));
        assert_eq!(m.values().copied().collect::<Vec<_>>(), vec![9, 3]);
        assert_eq!(m.get("c"), Some(&3));
        m.insert("b".into(), 4);
        assert_eq!(m.values().copied().collect::<Vec<_>>(), vec![9, 3, 4]);
    }
}
