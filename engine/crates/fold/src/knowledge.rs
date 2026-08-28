//! The knowledge seam — how a module asks "what is this item / what does this mob drop" without
//! this crate ever learning what a corpus is.
//!
//! The lookup is a post-construction seam ([`Registry::install_knowledge`]) rather than a
//! `ClusterDeps` field somebody could default into existence. The parity construction injects
//! nothing, which is why every recorded golden carries `knowledge` absent from every consider row
//! and an empty event feed, and it must stay that way.
//!
//! The committed corpora live in the `knowledge` crate, which depends on this one and not the other
//! way round: a crate that cannot name the corpora cannot accidentally link them.
//!
//! The lookups are synchronous because the corpus is an in-memory index in the same process, so a
//! local answer is a map read with nothing to await. What cannot be answered locally is a miss: the
//! engine says so on the stream and the app, which owns the network, pushes the answer back with
//! `knowledge.define`. See [`Knowledge::take_misses`].
//!
//! Every answer is a record, including a miss: a name nothing knows still comes back carrying
//! whatever the local sources said, with the negative flagged. [`Answer`] is that contract, and
//! `found` is a flag rather than an `Option` so a caller cannot treat "no page for this" as
//! "nothing to show".

use serde_json::Value;

/// One item the current character has actually looted off one mob — `MobSeenDrop`.
///
/// The accounting rather than the index: `consider` owns the own-loot index and its lifetime, so
/// the knowledge join is handed rows rather than a handle on somebody else's state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeenDrop {
    /// Item name, in the first spelling the index recorded for it.
    pub item: String,
    /// How many have been looted — stacked loots add their `count`, never 1.
    pub count: i64,
    /// The most recent loot timestamp, on the log's own clock.
    pub last_ts: i64,
}

/// What you have looted — `mobLookupParse.ts MobLootIndex`, read side only.
///
/// A trait rather than a concrete type because the reader must not depend on the module that owns
/// the writer. `spellings` is every `mobKey` one creature answers to; an unaliased mob passes a
/// single spelling.
pub trait OwnLoot {
    /// Most-looted first, ties broken by recency — `MobLootIndex.dropsAcross`.
    fn drops_across(&self, spellings: &[String]) -> Vec<SeenDrop>;
}

/// An empty loot history: what a caller with no fold behind it passes, and what `drops_across`
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
/// `found: false` is an answer. The record still carries every local association — quest uses for
/// an item, your own loot history and the quest catalog's related NPCs for a mob — because a
/// missing wiki page does not unmake those. It never carries an invented drop list or guessed
/// level.
#[derive(Debug, Clone)]
pub struct Answer {
    /// The record, in the exact shape the app's IPC handler answers with today.
    pub record: Value,
    /// A committed (or pushed-in) source states this name.
    pub found: bool,
}

/// One name the engine could not answer locally — what becomes a `knowledgeMiss` stream frame.
///
/// It carries what the app needs in order to look: which corpus was asked, and the name as the
/// asker spelled it. Never a canonicalized key — the app's fetch resolves a wiki page from a
/// display name, and a folded key is not one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Miss {
    /// `item` or `mob` — the corpus that came up empty.
    pub domain: String,
    /// The name as it was asked for.
    pub name: String,
}

/// The engine-internal knowledge lookups — `main/itemLookup.ts lookupItem` and
/// `main/mobLookup.ts lookupMob`, minus the network.
///
/// `Send + Sync` because one instance is shared by the ingest thread and by every connection
/// thread: one corpus, one overlay, one miss ledger, and no copy of any of them anywhere else.
pub trait Knowledge: Send + Sync {
    /// "What is this lore/quest item for." Never fails; see [`Answer`].
    fn item(&self, name: &str) -> Answer;

    /// Every `mobKey` this creature answers to, canonical first — `mobAliases.resolveMobIdentity`.
    ///
    /// It is on this trait rather than inside [`Knowledge::mob`] because the own-loot half of a mob
    /// answer is read from the fold, which has to be told which keys to gather before the join can
    /// be made. An unaliased name answers with its single key.
    fn identity_keys(&self, mob: &str) -> Vec<String>;

    /// "What does this thing drop", joined with what you have looted off it. Never fails.
    fn mob(&self, name: &str, loot: &dyn OwnLoot) -> Answer;

    /// Does the committed catalog state this name at all?
    ///
    /// A separate method rather than `mob(…).found`, because of the miss ledger. [`Knowledge::mob`]
    /// is a lookup, so a name it cannot answer is announced and the app fetches a wiki page for it.
    /// This is a test, asked about names that are often not creatures at all — the con-card refusal
    /// asks it about every proper-named thing the player cons, some of which are people. Routing it
    /// through `mob` would scrape the wiki for another player's character name. So it reads the
    /// catalog, announces nothing, and builds no record.
    ///
    /// It asks the catalog and not the alias table: the index is keyed by both the page's `|name`
    /// and the page title, `mobKey`-folded, and that pair is what "the catalog has heard of this"
    /// means.
    fn known_mob(&self, name: &str) -> bool;

    /// Take the names this process could not answer, and forget them.
    ///
    /// A hand-back rather than a callback, like [`crate::EqModule::take_fires`]: a lookup called
    /// from inside a fold cannot reach the world, so it buffers and the caller drains at a boundary
    /// it already reaches. Each (domain, name) is announced at most once per process — a stacked
    /// loot burst probes one name many times and the app must not be asked to fetch it many times.
    /// A `knowledge.define` makes the next lookup a hit, so nothing has to un-remember anything.
    fn take_misses(&self) -> Vec<Miss>;
}
