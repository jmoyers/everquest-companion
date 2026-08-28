//! Fight search: the scoring half of `combat.searchFights`. The corpus half is the combat engine's
//! `fight_summaries`, one call away.
//!
//! The ranking lives in this crate and not in `fold` because the equivalence oracle compares what a
//! fold PUBLISHES; a scorer over published rows is not part of that claim, and putting it there
//! would put oracle-uncovered code inside the crate whose value is that the oracle covers it.
//!
//! Edit distance rather than anything semantic: the corpus is short proper nouns and the queries are
//! typo'd lookups, which is the one shape character-level distance is strictly better at. The rules
//! must match the app's exactly — two search boxes over one corpus that rank differently is the
//! defect this shared scoring exists to prevent — so the app's golden cases are mirrored below.
//!
//! The one place the two languages could drift is `tokenize`. JavaScript's `toLowerCase` is Unicode
//! full case folding and this uses `char::to_lowercase`, which is the same algorithm for every
//! character the class `[a-z0-9]` can survive; every character it cannot survive is dropped by the
//! class in both languages. The claim is over the class, not over the whole of Unicode casing.

/// Per-token match scores, in strict descending order of confidence. The gaps are wide on purpose:
/// an exact token match must always outrank a prefix, a prefix a substring, and any of those a typo
/// correction, no matter how the mean across tokens shakes out.
const SCORE_EXACT: f64 = 1.0;
const SCORE_PREFIX: f64 = 0.85;
const SCORE_SUBSTRING: f64 = 0.7;
/// Ceiling for a typo (edit-distance) match; scaled down by how many edits it took.
const SCORE_FUZZY: f64 = 0.6;

/// Shortest token either side may be and still be eligible for a typo match.
///
/// One edit on a 2-letter token reaches most of the alphabet: measured, without this `wan gohl`
/// returned "an urd ghoul wizard" beside the wan ghoul knight it was aimed at. Both sides are
/// checked, because the budget below keys on the LONGER token and a 2-letter haystack token would
/// otherwise inherit a long query's generous budget.
const MIN_FUZZY_LEN: usize = 3;

/// Edit budget for a typo match, keyed on the LONGER of the two tokens.
///
/// The longer one, not the query's, is load-bearing: `gohl` → `ghoul` is two edits and the query
/// token is four characters, so a query-length budget would reject exactly the case the user asked
/// for.
fn edit_budget(longest: usize) -> usize {
    match longest {
        0..=2 => 0,
        3..=4 => 1,
        _ => 2,
    }
}

/// Lowercased alphanumeric tokens. EQ names carry backticks, apostrophes, `(3)` instance suffixes
/// and `+N` others-suffixes; all of that is punctuation to a search box.
#[must_use]
pub fn tokenize(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    for lowered in text.chars().flat_map(char::to_lowercase) {
        if lowered.is_ascii_alphanumeric() {
            current.push(lowered);
        } else if !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Restricted Damerau-Levenshtein (optimal string alignment) distance, aborted once it provably
/// exceeds `max`. Answers `max + 1` for "further apart than we care about", so the caller never pays
/// for a full matrix over two unrelated words.
///
/// "Restricted" means a transposed pair is one edit but may not be edited again afterwards — the
/// standard OSA variant, and the right one here because it makes `gohul`→`ghoul` and
/// `freeprot`→`freeport` one edit each. Where it diverges from unrestricted Damerau needs three or
/// more overlapping transpositions, already past any budget above.
///
/// Bytes, not chars, and that is exact rather than approximate: both sides are `[a-z0-9]` tokens
/// out of [`tokenize`], so every character is one ASCII byte.
#[must_use]
pub fn damerau_levenshtein(a: &str, b: &str, max: usize) -> usize {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a == b {
        return 0;
    }
    if a.len().abs_diff(b.len()) > max {
        return max + 1;
    }
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }

    // Three rolling rows — prev-prev is what makes the transposition step possible.
    let mut prev2: Vec<usize> = vec![0; b.len() + 1];
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur: Vec<usize> = vec![0; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        let mut row_min = cur[0];
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut v = (cur[j - 1] + 1).min(prev[j] + 1).min(prev[j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                v = v.min(prev2[j - 2] + 1);
            }
            cur[j] = v;
            row_min = row_min.min(v);
        }
        // Every remaining path goes through this row, so a row whose best cell already exceeds the
        // budget can never come back under it.
        if row_min > max {
            return max + 1;
        }
        std::mem::swap(&mut prev2, &mut prev);
        std::mem::swap(&mut prev, &mut cur);
    }
    let d = prev[b.len()];
    if d > max {
        max + 1
    } else {
        d
    }
}

/// Best score for ONE query token against ONE haystack token. `0` means no match at all, which is
/// what excludes a record — see [`score_query`]'s coverage rule.
fn token_score(q: &str, h: &str) -> f64 {
    if q == h {
        return SCORE_EXACT;
    }
    if h.starts_with(q) {
        return SCORE_PREFIX;
    }
    if h.contains(q) {
        return SCORE_SUBSTRING;
    }
    if q.len() < MIN_FUZZY_LEN || h.len() < MIN_FUZZY_LEN {
        return 0.0;
    }
    let longest = q.len().max(h.len());
    let budget = edit_budget(longest);
    if budget == 0 {
        return 0.0;
    }
    let d = damerau_levenshtein(q, h, budget);
    if d > budget {
        return 0.0;
    }
    // Length-normalized: the same number of edits is a weaker signal on a short token than on a
    // long one (`wan`→`can` is one edit across a third of the word).
    #[allow(clippy::cast_precision_loss)]
    let scaled = 1.0 - (d as f64) / (longest as f64);
    SCORE_FUZZY * scaled
}

/// Best score for one query token across a whole haystack. Short-circuits on an exact hit.
fn best_token_score(q: &str, hay: &[String]) -> f64 {
    let mut best = 0.0_f64;
    for h in hay {
        let s = token_score(q, h);
        if s > best {
            best = s;
            if (best - SCORE_EXACT).abs() < f64::EPSILON {
                break;
            }
        }
    }
    best
}

/// Score one record's haystack tokens against an already-tokenized query. `None` is EXCLUDED, which
/// is not the same as scored zero.
///
/// Each query token takes its best score across the haystack (exact > prefix > substring > bounded
/// Damerau-Levenshtein), and the record is excluded unless every query token matched something above
/// zero — `gohul knigt` must not surface every ghoul in the corpus because one word landed. The
/// score is the mean token score.
#[must_use]
pub fn score_query(query: &[String], hay: &[String]) -> Option<f64> {
    if query.is_empty() || hay.is_empty() {
        return None;
    }
    let mut sum = 0.0_f64;
    for q in query {
        let best = best_token_score(q, hay);
        if best == 0.0 {
            return None;
        }
        sum += best;
    }
    #[allow(clippy::cast_precision_loss)]
    let n = query.len() as f64;
    Some(sum / n)
}

/// One ranked fight, as this module hands it back.
pub struct Hit {
    /// The summary, exactly as the fold published it.
    pub summary: serde_json::Value,
    /// 0..1 relevance.
    pub score: f64,
}

/// Search a corpus of `SegmentSummary` JSON by name + zone.
///
/// Order: score desc, then recency (newer `startTs` first), then `id`, so the ranking never depends
/// on the corpus's arrival order. The last term is load-bearing — two fights against the same mob in
/// the same zone score identically by construction, and a search box whose rows swapped between
/// keystrokes would be the shuffled-window defect the view layer's total sort exists to prevent.
///
/// An empty or whitespace-only query returns no hits rather than everything: the UI shows its
/// ordinary browse list in that state, and the whole corpus would make the empty box the most
/// expensive keystroke of all.
///
/// No index, on purpose. A linear scan, measured at 1.71 ms for the worst real query over 2,080
/// fights and 7.66 ms cold over a synthetic 5,000 where every fight survives the coverage rule —
/// inside the per-keystroke budget, so an inverted index would be complexity bought with nothing.
#[must_use]
pub fn search(corpus: &[serde_json::Value], query: &str, limit: usize) -> Vec<Hit> {
    let terms = tokenize(query);
    if terms.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<Hit> = corpus
        .iter()
        .filter_map(|summary| {
            let score = score_query(&terms, &haystack(summary))?;
            Some(Hit {
                summary: summary.clone(),
                score,
            })
        })
        .collect();
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| start_ts(&b.summary).cmp(&start_ts(&a.summary)))
            .then_with(|| id_of(&a.summary).cmp(id_of(&b.summary)))
    });
    hits.truncate(limit);
    hits
}

/// The tokens one summary is matched against: the name, plus the zone when it has one.
///
/// No memoization, unlike the app's: the corpus is rebuilt per call from `fight_summaries`, so there
/// is no stable object to key a cache on and it would never hit. The measurement above is of the
/// unmemoized path anyway.
fn haystack(summary: &serde_json::Value) -> Vec<String> {
    let name = summary.get("name").and_then(serde_json::Value::as_str);
    let zone = summary.get("zone").and_then(serde_json::Value::as_str);
    match (name.unwrap_or_default(), zone) {
        (name, Some(zone)) if !zone.is_empty() => tokenize(&format!("{name} {zone}")),
        (name, _) => tokenize(name),
    }
}

fn start_ts(summary: &serde_json::Value) -> i64 {
    summary
        .get("startTs")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0)
}

fn id_of(summary: &serde_json::Value) -> &str {
    summary
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{damerau_levenshtein, search, tokenize};
    use serde_json::json;

    /// One authored summary. Only the fields the scorer and the tie-break read are stated; the rest
    /// of a `SegmentSummary` is carried verbatim and is not this module's business.
    fn fight(id: &str, name: &str, zone: &str, start_ts: i64) -> serde_json::Value {
        json!({ "id": id, "kind": "fight", "name": name, "zone": zone, "startTs": start_ts })
    }

    fn names(hits: &[super::Hit]) -> Vec<String> {
        hits.iter()
            .map(|h| h.summary["id"].as_str().unwrap_or_default().to_owned())
            .collect()
    }

    #[test]
    fn punctuation_and_case_are_not_part_of_a_token() {
        assert_eq!(
            tokenize("Baron Telyx V`Zher"),
            ["baron", "telyx", "v", "zher"]
        );
        assert_eq!(
            tokenize("a zol ghoul knight (3)+2"),
            ["a", "zol", "ghoul", "knight", "3", "2"]
        );
        assert!(tokenize("   ").is_empty());
    }

    #[test]
    fn a_transposed_pair_is_one_edit_and_an_unrelated_word_aborts() {
        // The two real typos the app's own decision record names.
        assert_eq!(damerau_levenshtein("gohul", "ghoul", 2), 1);
        assert_eq!(damerau_levenshtein("freeprot", "freeport", 2), 1);
        // `gohl` → `ghoul` is two: transpose, then insert.
        assert_eq!(damerau_levenshtein("gohl", "ghoul", 2), 2);
        // Further apart than the budget: the answer is the abort value, not the true distance.
        assert_eq!(damerau_levenshtein("dragon", "slayer", 2), 3);
    }

    #[test]
    fn every_query_token_must_match_something() {
        // The coverage rule: `gohul knigt` must not surface every ghoul in the corpus because one
        // word landed, which is the difference between exclusion and a score of 0.
        let corpus = vec![
            fight("f1", "a zol ghoul knight", "Freeport", 100),
            fight("f2", "a zol ghoul wizard", "Freeport", 200),
        ];
        assert_eq!(names(&search(&corpus, "gohul knigt", 50)), ["f1"]);
        // …and a query that matches neither excludes both.
        assert!(search(&corpus, "dragon slayer", 50).is_empty());
    }

    #[test]
    fn the_zone_is_part_of_the_haystack_and_survives_a_typo() {
        let corpus = vec![
            fight("f1", "a dervish cutthroat", "Freeport", 100),
            fight("f2", "a dervish cutthroat", "Najena", 200),
        ];
        assert_eq!(names(&search(&corpus, "freprot", 50)), ["f1"]);
    }

    #[test]
    fn an_empty_query_is_no_hits_rather_than_everything() {
        let corpus = vec![fight("f1", "a bat", "Innothule Swamp", 100)];
        assert!(search(&corpus, "", 50).is_empty());
        assert!(search(&corpus, "   \t ", 50).is_empty());
        // …and a query of pure punctuation tokenizes to nothing, which is the same state.
        assert!(search(&corpus, "`'()", 50).is_empty());
    }

    #[test]
    fn ties_break_by_recency_and_then_by_id() {
        // Three fights that score identically by construction: same name, same zone. A search box
        // whose rows swapped between keystrokes would be the shuffled-window defect one layer up.
        let corpus = vec![
            fight("f1", "a sand giant", "Oasis", 100),
            fight("f3", "a sand giant", "Oasis", 300),
            // Same instant as f1 — EQ stamps to the second, so this is the common case rather than
            // a corner, and `id` is what settles it.
            fight("f0", "a sand giant", "Oasis", 100),
        ];
        assert_eq!(
            names(&search(&corpus, "sand giant", 50)),
            ["f3", "f0", "f1"]
        );
    }

    #[test]
    fn an_exact_token_outranks_a_prefix_and_a_prefix_a_typo() {
        let corpus = vec![
            fight("exact", "ghoul", "Neriak", 100),
            fight("prefix", "ghoulbane", "Neriak", 100),
            fight("typo", "gohul", "Neriak", 100),
        ];
        assert_eq!(
            names(&search(&corpus, "ghoul", 50)),
            ["exact", "prefix", "typo"]
        );
    }

    #[test]
    fn the_limit_caps_the_ranked_list_rather_than_the_search() {
        let corpus: Vec<serde_json::Value> = (0..10)
            .map(|i| fight(&format!("f{i}"), "a sand giant", "Oasis", i64::from(i)))
            .collect();
        let hits = search(&corpus, "sand", 3);
        assert_eq!(hits.len(), 3);
        // Newest first, because every one of them scores the same.
        assert_eq!(names(&hits), ["f9", "f8", "f7"]);
    }
}
