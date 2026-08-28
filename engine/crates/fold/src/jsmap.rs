//! `JsMap` — a string-keyed map that iterates in insertion order, because JavaScript's maps do.
//!
//! Several ported modules turn a map into an array at snapshot time (`[...map.values()]`), so the
//! iteration order is the serialized array's order, and array order is a claim the comparator
//! checks. A `HashMap` would randomize it and a `BTreeMap` would sort it.
//!
//! The two JS rules it reproduces: `set` on a present key keeps its original position, and `delete`
//! removes one entry and leaves the rest in order.
//!
//! Removal is O(n) on purpose. Only `spellSets` deletes and its maps hold a couple of dozen
//! entries; every large map here is insert-and-update only, so a structure with cheap deletion
//! would cost an indirection on the hot path to buy nothing.
//!
//! Insertion order does not survive serialization — `serde_json`'s `Map` sorts the keys — and that
//! is fine rather than a bug to fix: parity is deep equality, under which object key order is not a
//! claim. What the order is load-bearing for is the arrays derived from `values()`, and those are
//! built before serialization.

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

    /// A walk that writes to every value without touching the keys.
    pub fn values_mut(&mut self) -> impl Iterator<Item = &mut V> {
        self.entries.iter_mut().map(|(_, v)| v)
    }

    /// The keys in insertion order — the LRU order the respawn module's history evicts from.
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(k, _)| k.as_str())
    }

    /// `[...map.values()]` — the values, owned, in insertion order, which is a published claim
    /// wherever a map becomes an array.
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
