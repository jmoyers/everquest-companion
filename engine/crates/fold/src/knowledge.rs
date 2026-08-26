//! THE KNOWLEDGE SEAM (JOS-486) — how a module asks "what is this item / what does this mob drop"
//! without this crate ever learning what a corpus is.
//!
//! ── WHY A TRAIT HERE AND THE CORPORA SOMEWHERE ELSE ────────────────────────────────────────────
//!
//! `consider` and `eventFeed` are the two modules whose TypeScript twins take an INJECTED lookup
//! (`deps.lookupMob`, `deps.lookupItem`) and do nothing at all without one. `tests/bench/
//! foldArm.mts` injects neither, which is why every recorded golden carries `knowledge` ABSENT from
//! every consider row and an EMPTY event feed — and why the parity construction must keep injecting
//! neither, forever. So the lookup cannot be a field of `ClusterDeps` that somebody might default
//! into existence; it is a POST-CONSTRUCTION SEAM ([`Registry::install_knowledge`]), installed by
//! exactly one caller — `engined::foldsink::registry_for`, the production construction — and by no
//! test, no bench and no oracle.
//!
//! The 12 MB of committed corpora live in the `knowledge` crate, which depends on THIS one (for
//! `mob_key`) and not the other way round. That direction is the whole reason the `parity` binary
//! does not carry items.json: a crate that cannot name the corpora cannot accidentally link them.
//!
//! ── SYNCHRONOUS, AND THAT IS THE BOUNDARY DISSOLVING ───────────────────────────────────────────
//!
//! Over there both lookups are `Promise`s, because main's answer may be a wiki round trip: the row
//! is appended immediately and `knowledge` lands later as its own delta. In the engine the committed
//! corpus is an in-memory index in the same process, so the local answer — which is the answer for
//! every item the corpus holds and every mob the catalog holds, i.e. the overwhelming majority — is
//! a map read. There is nothing to await and nothing to land later. What CANNOT be answered locally
//! is not awaited either: it is a MISS, the engine says so on the stream, and the app (which owns
//! the network — boundary verdict 5) pushes the answer back with `knowledge.define`. See
//! [`Knowledge::take_misses`].
//!
//! ── EVERY ANSWER IS A RECORD, INCLUDING A MISS ─────────────────────────────────────────────────
//!
//! `lookupItem`/`lookupMob` never reject and never return null: a name nothing knows still comes
//! back carrying whatever the LOCAL sources said (posky's quest uses, your own loot history), with
//! the negative flagged. [`Answer`] is that contract, and `found` is the flag rather than an
//! `Option` so a caller cannot accidentally treat "the corpus has no page for this" as "there is
//! nothing to show".

use serde_json::Value;

/// One item the current character has actually looted off one mob — `MobSeenDrop`.
///
/// THE SHAPE THAT CROSSES THE SEAM, and it is deliberately the accounting rather than the index:
/// the own-loot index is folded by `consider` (which owns its character-scoped, epoch-scoped
/// lifetime) and READ by the knowledge join, so the join is handed rows rather than a handle on
/// somebody else's state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeenDrop {
    /// Item name, in the first spelling the index recorded for it.
    pub item: String,
    /// How many have been looted — stacked loots add their `count`, never 1.
    pub count: i64,
    /// The most recent loot timestamp, on the LOG's own clock.
    pub last_ts: i64,
}

/// WHAT YOU HAVE LOOTED — `mobLookupParse.ts MobLootIndex`, read side only.
///
/// A trait rather than a concrete type because the reader (`knowledge`) must not depend on the
/// module that owns the writer, and because the ONE implementation that matters lives inside
/// `consider`. `spellings` is every `mobKey` one creature answers to (`mobAliases.ts` is what
/// states that two spellings are one creature); a single spelling is the byte-identical path every
/// unaliased mob takes.
pub trait OwnLoot {
    /// Most-looted first, ties broken by recency — `MobLootIndex.dropsAcross`.
    fn drops_across(&self, spellings: &[String]) -> Vec<SeenDrop>;
}

/// AN EMPTY LOOT HISTORY. What a caller with no fold behind it passes, and what `drops_across`
/// answers for a mob nothing has been looted from — the same value, so neither is a special case.
pub struct NoOwnLoot;

impl OwnLoot for NoOwnLoot {
    fn drops_across(&self, _spellings: &[String]) -> Vec<SeenDrop> {
        Vec::new()
    }
}

/// One knowledge answer: the record a caller renders, and whether a committed source actually had
/// a page for the name.
///
/// `found: false` IS AN ANSWER (law 1). The record still carries every local association — posky's
/// quest uses for an item, your own loot history and the quest catalog's `relatedNpcs` for a mob —
/// because those are facts a missing wiki page does not unmake. What it never carries is an
/// invented drop list or a guessed level.
#[derive(Debug, Clone)]
pub struct Answer {
    /// The record, in the exact shape the app's IPC handler answers with today.
    pub record: Value,
    /// A committed (or pushed-in) source states this name.
    pub found: bool,
}

/// ONE NAME THE ENGINE COULD NOT ANSWER LOCALLY — what becomes a `knowledgeMiss` stream frame.
///
/// It is the whole of what the app needs in order to go and look: which corpus was asked, and the
/// name as the ASKER spelled it (never a canonicalized key — the app's fetch resolves a wiki page
/// from a display name, and a folded key is not one).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Miss {
    /// `item` or `mob` — the corpus that came up empty.
    pub domain: String,
    /// The name as it was asked for.
    pub name: String,
}

/// THE ENGINE-INTERNAL KNOWLEDGE LOOKUPS — `main/itemLookup.ts lookupItem` and
/// `main/mobLookup.ts lookupMob`, minus the network.
///
/// `Send + Sync` because one instance is shared by the ingest thread (the fold's own probes) and by
/// every connection thread (the `knowledge.*` ops): boundary verdict 5's "the mutual dependency
/// dissolves in-process" is exactly this — one corpus, one overlay, one miss ledger, and no copy of
/// any of them anywhere else.
pub trait Knowledge: Send + Sync {
    /// "What is this lore/quest item for." Never fails; see [`Answer`].
    fn item(&self, name: &str) -> Answer;

    /// Every `mobKey` this creature answers to, canonical first — `mobAliases.resolveMobIdentity`.
    ///
    /// It is on this trait rather than inside [`Knowledge::mob`] because the OWN-LOOT half of a mob
    /// answer is read from the fold, and the fold has to be told which keys to gather before the
    /// join can be made. An unaliased name answers with its single key, which is the read every
    /// caller was making before aliases existed.
    fn identity_keys(&self, mob: &str) -> Vec<String>;

    /// "What does this thing drop", joined with what YOU have looted off it. Never fails.
    fn mob(&self, name: &str, loot: &dyn OwnLoot) -> Answer;

    /// DOES THE COMMITTED CATALOG STATE THIS NAME AT ALL? — `mobLookupLocal.ts localMobEntry(n)
    /// !== null`, as the one bit its callers actually want (JOS-492).
    ///
    /// A SEPARATE METHOD RATHER THAN `mob(…).found`, and the difference is not cosmetic — it is the
    /// MISS LEDGER. [`Knowledge::mob`] is a lookup: a name it cannot answer is recorded and
    /// announced, so the app goes and fetches a wiki page for it. This question is a TEST, asked
    /// about names that are very often not creatures at all (the con-card player refusal asks it
    /// about every proper-named thing the player cons, and the whole point is that some of them are
    /// PEOPLE). Routing it through `mob` would send this process off to scrape the wiki for another
    /// player's character name — a real privacy-shaped mistake and an etiquette violation besides.
    /// So it reads the catalog, announces nothing, and builds no record.
    ///
    /// IT ASKS THE CATALOG AND NOT THE ALIAS TABLE, because `localMobEntry` does not either: the
    /// index is keyed by the page's `|name` AND by the page TITLE, both `mobKey`-folded, and that
    /// pair is what "the catalog has heard of this" has always meant here.
    fn known_mob(&self, name: &str) -> bool;

    /// TAKE THE NAMES THIS PROCESS COULD NOT ANSWER, and forget them.
    ///
    /// A HAND-BACK RATHER THAN A CALLBACK, exactly like [`crate::EqModule::take_fires`] and for the
    /// same ownership reason: a lookup called from inside a fold cannot reach the world, so it
    /// buffers and the caller drains at a boundary it already reaches. Each (domain, name) is
    /// announced AT MOST ONCE per process — a stacked loot burst probes one name many times and the
    /// app must not be asked to fetch it many times (scraper etiquette is a law here, AGENTS.md
    /// "Data sources"). A `knowledge.define` for that name makes the next lookup a hit, so nothing
    /// has to un-remember anything.
    fn take_misses(&self) -> Vec<Miss>;
}
