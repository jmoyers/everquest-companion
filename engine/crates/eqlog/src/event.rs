//! The event writer: a JSON object built key by key in the order the app's object literal states
//! it, and the same event as a typed payload built in the same pass.
//!
//! The JSON is not a `serde` enum because the bar is byte identity with `JSON.stringify`, which
//! writes insertion order — a property of the code path, not of the kind. `damage` alone is written
//! four different ways, a field set to `undefined` disappears, and `group` puts `change` ahead of
//! `seq`/`ts`/`raw` where every other kind puts them first. A derived struct per kind would have to
//! be a struct per branch, with the ordering claim far from the branch that makes it. So a
//! classifier writes its fields in the same sequence its counterpart lists them, and the two can be
//! read side by side.
//!
//! [`Payload`] is those same writes recorded as data: the kind as a discriminant, each field as a
//! `(Key, Slot)` pair in write order. The fold reads it; re-parsing the NDJSON string back into a
//! `serde_json::Value` cost 9.6% of a whole fold. The string is still written because it is the
//! parser oracle's byte-identity artifact.
//!
//! It allocates nothing per event: every string a field carries goes into one reused arena and is
//! referred to by an `(offset, length)` pair, and every side table is a reused `Vec` cleared by
//! [`Ev::begin`].
//!
//! Absent is not null, and the writer is where that distinction is made. `s_opt`/`i_opt` push no
//! entry at all; `s_or_null`/`i_or_null` push [`Slot::Null`]. A reader that collapses the two must
//! be able to tell them apart first — `buffFade.target` absent means self, which is a different
//! claim from a `target` of nothing.
//!
//! Keys are first-wins on lookup, and no classifier writes a key twice: a repeated key would print
//! twice in the NDJSON, which `JSON.stringify` over an object literal cannot produce. [`Ev::note`]
//! carries a `debug_assert` so a classifier that repeats one fails a debug test rather than
//! shifting a lookup silently.

use crate::jsstr::{write_js_number, write_json_string};

/// Every event kind, as a discriminant. A closed enum rather than an interned string because the
/// fold's dispatch floor is this comparison: twenty-one consumers ask "is this mine" about every
/// event, which cost ~940 ms of a 2.5M-event fold as a map lookup and a string compare. Every
/// variant's [`Kind::as_str`] is the exact text the parser writes.
///
/// The last three are synthesized by the fold rather than by any classifier here, and are named
/// here because a derived event must answer the same question a primary does. [`Kind::Other`] is
/// what an unrecognized string becomes — reachable only from a hand-built fixture, never a parse.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Kind {
    AaActivate,
    AaGain,
    AaPotion,
    AaSpend,
    AllyPetLeader,
    BuffApply,
    BuffFade,
    BuffWearOff,
    CampAbort,
    CampStart,
    CastBegin,
    CastFizzle,
    CastInterrupted,
    CastResumed,
    Cc,
    CcWake,
    Charm,
    ClassUnlock,
    Coin,
    Consider,
    Damage,
    Death,
    ExpGain,
    Group,
    Heal,
    HealUnstated,
    IllusionFade,
    InstanceCreate,
    InvocationChange,
    ItemActivate,
    ItemMerge,
    ItemMergeFailed,
    ItemReceived,
    Level,
    Loot,
    Miss,
    Mitigation,
    Offer,
    OtherCastBegin,
    OutputFile,
    PetClaim,
    PetSay,
    PlayerDeath,
    PoisonCoat,
    PoisonDry,
    PoisonProc,
    Purchase,
    Resist,
    SelfWho,
    SessionStart,
    SkillUp,
    SpecialAttack,
    SpellEmote,
    SpellForget,
    SpellMemorize,
    SpellSet,
    StanceChange,
    Trade,
    Uncharm,
    Unknown,
    Zone,
    // The fold's own, never written by a classifier.
    Epoch,
    OfflineGap,
    BuffExpired,
    /// A `kind` string this build does not know. Not reachable from [`crate::Parser`].
    #[default]
    Other,
}

impl Kind {
    /// The exact text the `kind` field carries. `Other` answers the empty string, which is what a
    /// reader that never saw the original string can honestly say — the fold's event type keeps the
    /// raw value for that one case instead of asking here.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::AaActivate => "aaActivate",
            Kind::AaGain => "aaGain",
            Kind::AaPotion => "aaPotion",
            Kind::AaSpend => "aaSpend",
            Kind::AllyPetLeader => "allyPetLeader",
            Kind::BuffApply => "buffApply",
            Kind::BuffFade => "buffFade",
            Kind::BuffWearOff => "buffWearOff",
            Kind::CampAbort => "campAbort",
            Kind::CampStart => "campStart",
            Kind::CastBegin => "castBegin",
            Kind::CastFizzle => "castFizzle",
            Kind::CastInterrupted => "castInterrupted",
            Kind::CastResumed => "castResumed",
            Kind::Cc => "cc",
            Kind::CcWake => "ccWake",
            Kind::Charm => "charm",
            Kind::ClassUnlock => "classUnlock",
            Kind::Coin => "coin",
            Kind::Consider => "consider",
            Kind::Damage => "damage",
            Kind::Death => "death",
            Kind::ExpGain => "expGain",
            Kind::Group => "group",
            Kind::Heal => "heal",
            Kind::HealUnstated => "healUnstated",
            Kind::IllusionFade => "illusionFade",
            Kind::InstanceCreate => "instanceCreate",
            Kind::InvocationChange => "invocationChange",
            Kind::ItemActivate => "itemActivate",
            Kind::ItemMerge => "itemMerge",
            Kind::ItemMergeFailed => "itemMergeFailed",
            Kind::ItemReceived => "itemReceived",
            Kind::Level => "level",
            Kind::Loot => "loot",
            Kind::Miss => "miss",
            Kind::Mitigation => "mitigation",
            Kind::Offer => "offer",
            Kind::OtherCastBegin => "otherCastBegin",
            Kind::OutputFile => "outputFile",
            Kind::PetClaim => "petClaim",
            Kind::PetSay => "petSay",
            Kind::PlayerDeath => "playerDeath",
            Kind::PoisonCoat => "poisonCoat",
            Kind::PoisonDry => "poisonDry",
            Kind::PoisonProc => "poisonProc",
            Kind::Purchase => "purchase",
            Kind::Resist => "resist",
            Kind::SelfWho => "selfWho",
            Kind::SessionStart => "sessionStart",
            Kind::SkillUp => "skillUp",
            Kind::SpecialAttack => "specialAttack",
            Kind::SpellEmote => "spellEmote",
            Kind::SpellForget => "spellForget",
            Kind::SpellMemorize => "spellMemorize",
            Kind::SpellSet => "spellSet",
            Kind::StanceChange => "stanceChange",
            Kind::Trade => "trade",
            Kind::Uncharm => "uncharm",
            Kind::Unknown => "unknown",
            Kind::Zone => "zone",
            Kind::Epoch => "epoch",
            Kind::OfflineGap => "offlineGap",
            Kind::BuffExpired => "buffExpired",
            Kind::Other => "",
        }
    }

    /// The discriminant for a `kind` string. [`Kind::Other`] for anything this build does not know —
    /// which a parse cannot produce, so it only ever describes a hand-built value.
    #[must_use]
    pub fn parse(s: &str) -> Kind {
        // A match on the string, not a map: a call with a literal argument folds away at compile
        // time.
        match s {
            "aaActivate" => Kind::AaActivate,
            "aaGain" => Kind::AaGain,
            "aaPotion" => Kind::AaPotion,
            "aaSpend" => Kind::AaSpend,
            "allyPetLeader" => Kind::AllyPetLeader,
            "buffApply" => Kind::BuffApply,
            "buffFade" => Kind::BuffFade,
            "buffWearOff" => Kind::BuffWearOff,
            "campAbort" => Kind::CampAbort,
            "campStart" => Kind::CampStart,
            "castBegin" => Kind::CastBegin,
            "castFizzle" => Kind::CastFizzle,
            "castInterrupted" => Kind::CastInterrupted,
            "castResumed" => Kind::CastResumed,
            "cc" => Kind::Cc,
            "ccWake" => Kind::CcWake,
            "charm" => Kind::Charm,
            "classUnlock" => Kind::ClassUnlock,
            "coin" => Kind::Coin,
            "consider" => Kind::Consider,
            "damage" => Kind::Damage,
            "death" => Kind::Death,
            "expGain" => Kind::ExpGain,
            "group" => Kind::Group,
            "heal" => Kind::Heal,
            "healUnstated" => Kind::HealUnstated,
            "illusionFade" => Kind::IllusionFade,
            "instanceCreate" => Kind::InstanceCreate,
            "invocationChange" => Kind::InvocationChange,
            "itemActivate" => Kind::ItemActivate,
            "itemMerge" => Kind::ItemMerge,
            "itemMergeFailed" => Kind::ItemMergeFailed,
            "itemReceived" => Kind::ItemReceived,
            "level" => Kind::Level,
            "loot" => Kind::Loot,
            "miss" => Kind::Miss,
            "mitigation" => Kind::Mitigation,
            "offer" => Kind::Offer,
            "otherCastBegin" => Kind::OtherCastBegin,
            "outputFile" => Kind::OutputFile,
            "petClaim" => Kind::PetClaim,
            "petSay" => Kind::PetSay,
            "playerDeath" => Kind::PlayerDeath,
            "poisonCoat" => Kind::PoisonCoat,
            "poisonDry" => Kind::PoisonDry,
            "poisonProc" => Kind::PoisonProc,
            "purchase" => Kind::Purchase,
            "resist" => Kind::Resist,
            "selfWho" => Kind::SelfWho,
            "sessionStart" => Kind::SessionStart,
            "skillUp" => Kind::SkillUp,
            "specialAttack" => Kind::SpecialAttack,
            "spellEmote" => Kind::SpellEmote,
            "spellForget" => Kind::SpellForget,
            "spellMemorize" => Kind::SpellMemorize,
            "spellSet" => Kind::SpellSet,
            "stanceChange" => Kind::StanceChange,
            "trade" => Kind::Trade,
            "uncharm" => Kind::Uncharm,
            "unknown" => Kind::Unknown,
            "zone" => Kind::Zone,
            "epoch" => Kind::Epoch,
            "offlineGap" => Kind::OfflineGap,
            "buffExpired" => Kind::BuffExpired,
            _ => Kind::Other,
        }
    }

    /// Every kind this build knows, for the round-trip test. `Other` is deliberately absent: it is
    /// the answer to an unknown string, not a kind anything writes.
    pub const ALL: [Kind; 63] = [
        Kind::AaActivate,
        Kind::AaGain,
        Kind::AaPotion,
        Kind::AaSpend,
        Kind::AllyPetLeader,
        Kind::BuffApply,
        Kind::BuffFade,
        Kind::BuffWearOff,
        Kind::CampAbort,
        Kind::CampStart,
        Kind::CastBegin,
        Kind::CastFizzle,
        Kind::CastInterrupted,
        Kind::CastResumed,
        Kind::Cc,
        Kind::CcWake,
        Kind::Charm,
        Kind::ClassUnlock,
        Kind::Coin,
        Kind::Consider,
        Kind::Damage,
        Kind::Death,
        Kind::ExpGain,
        Kind::Group,
        Kind::Heal,
        Kind::HealUnstated,
        Kind::IllusionFade,
        Kind::InstanceCreate,
        Kind::InvocationChange,
        Kind::ItemActivate,
        Kind::ItemMerge,
        Kind::ItemMergeFailed,
        Kind::ItemReceived,
        Kind::Level,
        Kind::Loot,
        Kind::Miss,
        Kind::Mitigation,
        Kind::Offer,
        Kind::OtherCastBegin,
        Kind::OutputFile,
        Kind::PetClaim,
        Kind::PetSay,
        Kind::PlayerDeath,
        Kind::PoisonCoat,
        Kind::PoisonDry,
        Kind::PoisonProc,
        Kind::Purchase,
        Kind::Resist,
        Kind::SelfWho,
        Kind::SessionStart,
        Kind::SkillUp,
        Kind::SpecialAttack,
        Kind::SpellEmote,
        Kind::SpellForget,
        Kind::SpellMemorize,
        Kind::SpellSet,
        Kind::StanceChange,
        Kind::Trade,
        Kind::Uncharm,
        Kind::Unknown,
        Kind::Zone,
        Kind::Epoch,
        Kind::OfflineGap,
    ];
}

/// Every field name any event can carry, as a discriminant.
///
/// The list is closed in both directions. Writing is closed by construction, since [`Ev`]'s methods
/// take a `Key`. Reading is closed by [`Key::parse`] answering `None`, which every reader treats as
/// absent — so a user-authored alert naming a field that does not exist still matches nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Key {
    Ability,
    Action,
    Amount,
    Attacker,
    AutoAttack,
    By,
    BySelf,
    Camped,
    Candidates,
    Caster,
    Category,
    Change,
    Classes,
    ClassName,
    Coins,
    Component,
    Cost,
    Count,
    Created,
    Crit,
    Dclass,
    Difficulty,
    Disposition,
    Done,
    Dtype,
    DurationMs,
    Effect,
    Faction,
    File,
    FromTs,
    Group,
    Healer,
    Illusion,
    Incoming,
    Instance,
    Invocation,
    Item,
    Killer,
    Kind,
    Level,
    Mob,
    Modifier,
    Modifiers,
    Mtype,
    Name,
    NowHave,
    Npc,
    OverTime,
    Owner,
    Party,
    Pct,
    Pet,
    Player,
    Poison,
    Price,
    Race,
    Rank,
    Rare,
    Raw,
    RawAmount,
    Reason,
    Refresh,
    Replaces,
    Say,
    Seq,
    Set,
    Skill,
    Source,
    Spell,
    Stance,
    Strike,
    Subject,
    Sung,
    Target,
    Text,
    Tier,
    ToTs,
    Ts,
    Value,
    Verb,
    Via,
    Who,
    Zone,
}

impl Key {
    /// The exact JSON key text. This is what the NDJSON writer emits, so a wrong answer here is a
    /// byte divergence the parser oracle fails on.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Key::Ability => "ability",
            Key::Action => "action",
            Key::Amount => "amount",
            Key::Attacker => "attacker",
            Key::AutoAttack => "autoAttack",
            Key::By => "by",
            Key::BySelf => "bySelf",
            Key::Camped => "camped",
            Key::Candidates => "candidates",
            Key::Caster => "caster",
            Key::Category => "category",
            Key::Change => "change",
            Key::Classes => "classes",
            Key::ClassName => "className",
            Key::Coins => "coins",
            Key::Component => "component",
            Key::Cost => "cost",
            Key::Count => "count",
            Key::Created => "created",
            Key::Crit => "crit",
            Key::Dclass => "dclass",
            Key::Difficulty => "difficulty",
            Key::Disposition => "disposition",
            Key::Done => "done",
            Key::Dtype => "dtype",
            Key::DurationMs => "durationMs",
            Key::Effect => "effect",
            Key::Faction => "faction",
            Key::File => "file",
            Key::FromTs => "fromTs",
            Key::Group => "group",
            Key::Healer => "healer",
            Key::Illusion => "illusion",
            Key::Incoming => "incoming",
            Key::Instance => "instance",
            Key::Invocation => "invocation",
            Key::Item => "item",
            Key::Killer => "killer",
            Key::Kind => "kind",
            Key::Level => "level",
            Key::Mob => "mob",
            Key::Modifier => "modifier",
            Key::Modifiers => "modifiers",
            Key::Mtype => "mtype",
            Key::Name => "name",
            Key::NowHave => "nowHave",
            Key::Npc => "npc",
            Key::OverTime => "overTime",
            Key::Owner => "owner",
            Key::Party => "party",
            Key::Pct => "pct",
            Key::Pet => "pet",
            Key::Player => "player",
            Key::Poison => "poison",
            Key::Price => "price",
            Key::Race => "race",
            Key::Rank => "rank",
            Key::Rare => "rare",
            Key::Raw => "raw",
            Key::RawAmount => "rawAmount",
            Key::Reason => "reason",
            Key::Refresh => "refresh",
            Key::Replaces => "replaces",
            Key::Say => "say",
            Key::Seq => "seq",
            Key::Set => "set",
            Key::Skill => "skill",
            Key::Source => "source",
            Key::Spell => "spell",
            Key::Stance => "stance",
            Key::Strike => "strike",
            Key::Subject => "subject",
            Key::Sung => "sung",
            Key::Target => "target",
            Key::Text => "text",
            Key::Tier => "tier",
            Key::ToTs => "toTs",
            Key::Ts => "ts",
            Key::Value => "value",
            Key::Verb => "verb",
            Key::Via => "via",
            Key::Who => "who",
            Key::Zone => "zone",
        }
    }

    /// The discriminant for a field-name string, or `None` for a name no event carries. `None`
    /// means absent.
    #[must_use]
    pub fn parse(s: &str) -> Option<Key> {
        // A match on the string, not a map — a call site passing a literal folds to a constant.
        Some(match s {
            "ability" => Key::Ability,
            "action" => Key::Action,
            "amount" => Key::Amount,
            "attacker" => Key::Attacker,
            "autoAttack" => Key::AutoAttack,
            "by" => Key::By,
            "bySelf" => Key::BySelf,
            "camped" => Key::Camped,
            "candidates" => Key::Candidates,
            "caster" => Key::Caster,
            "category" => Key::Category,
            "change" => Key::Change,
            "classes" => Key::Classes,
            "className" => Key::ClassName,
            "coins" => Key::Coins,
            "component" => Key::Component,
            "cost" => Key::Cost,
            "count" => Key::Count,
            "created" => Key::Created,
            "crit" => Key::Crit,
            "dclass" => Key::Dclass,
            "difficulty" => Key::Difficulty,
            "disposition" => Key::Disposition,
            "done" => Key::Done,
            "dtype" => Key::Dtype,
            "durationMs" => Key::DurationMs,
            "effect" => Key::Effect,
            "faction" => Key::Faction,
            "file" => Key::File,
            "fromTs" => Key::FromTs,
            "group" => Key::Group,
            "healer" => Key::Healer,
            "illusion" => Key::Illusion,
            "incoming" => Key::Incoming,
            "instance" => Key::Instance,
            "invocation" => Key::Invocation,
            "item" => Key::Item,
            "killer" => Key::Killer,
            "kind" => Key::Kind,
            "level" => Key::Level,
            "mob" => Key::Mob,
            "modifier" => Key::Modifier,
            "modifiers" => Key::Modifiers,
            "mtype" => Key::Mtype,
            "name" => Key::Name,
            "nowHave" => Key::NowHave,
            "npc" => Key::Npc,
            "overTime" => Key::OverTime,
            "owner" => Key::Owner,
            "party" => Key::Party,
            "pct" => Key::Pct,
            "pet" => Key::Pet,
            "player" => Key::Player,
            "poison" => Key::Poison,
            "price" => Key::Price,
            "race" => Key::Race,
            "rank" => Key::Rank,
            "rare" => Key::Rare,
            "raw" => Key::Raw,
            "rawAmount" => Key::RawAmount,
            "reason" => Key::Reason,
            "refresh" => Key::Refresh,
            "replaces" => Key::Replaces,
            "say" => Key::Say,
            "seq" => Key::Seq,
            "set" => Key::Set,
            "skill" => Key::Skill,
            "source" => Key::Source,
            "spell" => Key::Spell,
            "stance" => Key::Stance,
            "strike" => Key::Strike,
            "subject" => Key::Subject,
            "sung" => Key::Sung,
            "target" => Key::Target,
            "text" => Key::Text,
            "tier" => Key::Tier,
            "toTs" => Key::ToTs,
            "ts" => Key::Ts,
            "value" => Key::Value,
            "verb" => Key::Verb,
            "via" => Key::Via,
            "who" => Key::Who,
            "zone" => Key::Zone,
            _ => return None,
        })
    }

    /// Every key, for the round-trip test.
    pub const ALL: [Key; 83] = [
        Key::Ability,
        Key::Action,
        Key::Amount,
        Key::Attacker,
        Key::AutoAttack,
        Key::By,
        Key::BySelf,
        Key::Camped,
        Key::Candidates,
        Key::Caster,
        Key::Category,
        Key::Change,
        Key::Classes,
        Key::ClassName,
        Key::Coins,
        Key::Component,
        Key::Cost,
        Key::Count,
        Key::Created,
        Key::Crit,
        Key::Dclass,
        Key::Difficulty,
        Key::Disposition,
        Key::Done,
        Key::Dtype,
        Key::DurationMs,
        Key::Effect,
        Key::Faction,
        Key::File,
        Key::FromTs,
        Key::Group,
        Key::Healer,
        Key::Illusion,
        Key::Incoming,
        Key::Instance,
        Key::Invocation,
        Key::Item,
        Key::Killer,
        Key::Kind,
        Key::Level,
        Key::Mob,
        Key::Modifier,
        Key::Modifiers,
        Key::Mtype,
        Key::Name,
        Key::NowHave,
        Key::Npc,
        Key::OverTime,
        Key::Owner,
        Key::Party,
        Key::Pct,
        Key::Pet,
        Key::Player,
        Key::Poison,
        Key::Price,
        Key::Race,
        Key::Rank,
        Key::Rare,
        Key::Raw,
        Key::RawAmount,
        Key::Reason,
        Key::Refresh,
        Key::Replaces,
        Key::Say,
        Key::Seq,
        Key::Set,
        Key::Skill,
        Key::Source,
        Key::Spell,
        Key::Stance,
        Key::Strike,
        Key::Subject,
        Key::Sung,
        Key::Target,
        Key::Text,
        Key::Tier,
        Key::ToTs,
        Key::Ts,
        Key::Value,
        Key::Verb,
        Key::Via,
        Key::Who,
        Key::Zone,
    ];
}

/// One field's value, without the string that names it.
///
/// `Copy`, 16 bytes, and every string-shaped variant is a range rather than a pointer: text lives
/// in [`Payload`]'s arena, lists in its side tables. That is what makes a whole field list a
/// contiguous scan of one or two cache lines instead of a walk over a heap-allocated map.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Slot {
    /// A range into [`Payload`]'s arena.
    Str {
        at: u32,
        len: u32,
    },
    Int(i64),
    Float(f64),
    Bool(bool),
    /// A field written as an explicit `null` — present, and explicitly nothing.
    Null,
    /// A range into [`Payload`]'s string-array table.
    Strs {
        at: u32,
        len: u32,
    },
    /// A range into [`Payload`]'s candidate table.
    Cands {
        at: u32,
        len: u32,
    },
    /// A range into [`Payload`]'s coin table.
    Coins {
        at: u32,
        len: u32,
    },
}

/// One `candidates` entry, as stored. The name is a range into the arena; `illusion` is `false` on
/// the narrower (`cc`/`charm`) shape, which carries no such flag.
#[derive(Clone, Copy, Debug)]
pub struct CandSlot {
    pub name: (u32, u32),
    pub duration_ms: Option<i64>,
    pub illusion: bool,
}

/// One event, typed: the same writes [`Ev`] serialized, kept as data.
///
/// Reused across events — [`Ev::begin`] clears it and nothing here allocates once the buffers have
/// reached their working size.
#[derive(Clone, Debug, Default)]
pub struct Payload {
    kind: Kind,
    seq: i64,
    ts: i64,
    raw: (u32, u32),
    envelope_after: u8,
    arena: String,
    fields: Vec<(Key, Slot)>,
    strs: Vec<(u32, u32)>,
    cands: Vec<CandSlot>,
    coins: Vec<(&'static str, i64)>,
}

impl Payload {
    #[must_use]
    pub fn kind(&self) -> Kind {
        self.kind
    }

    #[must_use]
    pub fn seq(&self) -> i64 {
        self.seq
    }

    #[must_use]
    pub fn ts(&self) -> i64 {
        self.ts
    }

    #[must_use]
    pub fn raw(&self) -> &str {
        self.text(self.raw)
    }

    /// How many fields were written before the envelope: 0 for every kind but `group`.
    ///
    /// Recorded because the envelope is stored out of the field list — `seq`/`ts`/`raw` get a
    /// dedicated slot each, being read on every event — so the writer's key order would otherwise
    /// be unrecoverable. Nothing reads it today; anything that stops writing the NDJSON eagerly
    /// needs exactly this.
    #[must_use]
    pub fn envelope_after(&self) -> usize {
        self.envelope_after as usize
    }

    /// The fields, in the order they were written, envelope excluded.
    #[must_use]
    pub fn fields(&self) -> &[(Key, Slot)] {
        &self.fields
    }

    /// Resolve an arena range.
    #[must_use]
    pub fn text(&self, r: (u32, u32)) -> &str {
        let at = r.0 as usize;
        &self.arena[at..at + r.1 as usize]
    }

    /// The slot a key holds, or `None` when the writer never wrote it.
    ///
    /// A forward linear scan, which is the fast answer rather than the lazy one: an event carries a
    /// handful of fields, they are contiguous and 16 bytes wide, and the hottest are written first.
    /// First-wins is exact because no classifier writes a key twice.
    #[must_use]
    pub fn slot(&self, key: Key) -> Option<Slot> {
        self.fields.iter().find(|(k, _)| *k == key).map(|(_, s)| *s)
    }

    #[must_use]
    pub fn str(&self, key: Key) -> Option<&str> {
        match self.slot(key)? {
            Slot::Str { at, len } => Some(self.text((at, len))),
            _ => None,
        }
    }

    #[must_use]
    pub fn int(&self, key: Key) -> Option<i64> {
        match self.slot(key)? {
            Slot::Int(v) => Some(v),
            // The `serde_json` reader this replaces answered for an integral float too. No field is
            // written both ways; the coercion is kept so a reader cannot tell them apart.
            Slot::Float(v) if v.fract() == 0.0 => Some(v as i64),
            _ => None,
        }
    }

    #[must_use]
    pub fn f64(&self, key: Key) -> Option<f64> {
        match self.slot(key)? {
            Slot::Float(v) => Some(v),
            Slot::Int(v) => Some(v as f64),
            _ => None,
        }
    }

    #[must_use]
    pub fn bool(&self, key: Key) -> Option<bool> {
        match self.slot(key)? {
            Slot::Bool(v) => Some(v),
            _ => None,
        }
    }

    /// A string-array field.
    #[must_use]
    pub fn strs(&self, key: Key) -> Option<impl Iterator<Item = &str>> {
        let Slot::Strs { at, len } = self.slot(key)? else {
            return None;
        };
        let at = at as usize;
        Some(
            self.strs[at..at + len as usize]
                .iter()
                .map(|r| self.text(*r)),
        )
    }

    /// The `candidates` list in its object shape: `{name, durationMs}` or
    /// `{name, durationMs, illusion}`.
    #[must_use]
    pub fn cands(&self, key: Key) -> Option<impl Iterator<Item = (&str, Option<i64>, bool)>> {
        let Slot::Cands { at, len } = self.slot(key)? else {
            return None;
        };
        let at = at as usize;
        Some(
            self.cands[at..at + len as usize]
                .iter()
                .map(|c| (self.text(c.name), c.duration_ms, c.illusion)),
        )
    }

    /// A coin object. The pairs are in the order the denominations appeared in the clause.
    #[must_use]
    pub fn coins(&self, key: Key) -> Option<&[(&'static str, i64)]> {
        let Slot::Coins { at, len } = self.slot(key)? else {
            return None;
        };
        let at = at as usize;
        Some(&self.coins[at..at + len as usize])
    }

    fn begin(&mut self, kind: Kind) {
        self.kind = kind;
        self.seq = 0;
        self.ts = 0;
        self.raw = (0, 0);
        self.envelope_after = 0;
        self.arena.clear();
        self.fields.clear();
        self.strs.clear();
        self.cands.clear();
        self.coins.clear();
    }

    fn push_text(&mut self, v: &str) -> (u32, u32) {
        let at = u32::try_from(self.arena.len()).unwrap_or(u32::MAX);
        self.arena.push_str(v);
        (at, u32::try_from(v.len()).unwrap_or(0))
    }
}

/// One event, being written. `begin` resets it; `finish` hands back the serialized line and
/// [`Ev::payload`] the typed one.
pub struct Ev {
    buf: String,
    first: bool,
    p: Payload,
}

impl Default for Ev {
    fn default() -> Self {
        Self::new()
    }
}

impl Ev {
    #[must_use]
    pub fn new() -> Self {
        Ev {
            buf: String::with_capacity(512),
            first: true,
            p: Payload {
                arena: String::with_capacity(512),
                fields: Vec::with_capacity(16),
                ..Payload::default()
            },
        }
    }

    /// Open a fresh object and write its `kind`. `begin` deliberately does not write the envelope,
    /// because `group` puts a field ahead of it.
    pub fn begin(&mut self, kind: Kind) {
        self.buf.clear();
        self.buf.push('{');
        self.first = true;
        self.p.begin(kind);
        self.json_key(Key::Kind);
        write_json_string(&mut self.buf, kind.as_str());
    }

    /// `seq`, `ts`, `raw` — the three base fields, in write order. Called after whatever a kind
    /// puts ahead of them (`group.change` is the only one).
    pub fn envelope(&mut self, seq: i64, ts: i64, raw: &str) {
        self.p.envelope_after = u8::try_from(self.p.fields.len()).unwrap_or(u8::MAX);
        self.json_key(Key::Seq);
        self.buf.push_str(itoa(seq).as_str());
        self.json_key(Key::Ts);
        self.buf.push_str(itoa(ts).as_str());
        self.json_key(Key::Raw);
        write_json_string(&mut self.buf, raw);
        self.p.seq = seq;
        self.p.ts = ts;
        self.p.raw = self.p.push_text(raw);
    }

    /// Close the object and hand back the serialized line.
    pub fn finish(&mut self) -> &str {
        self.buf.push('}');
        &self.buf
    }

    /// Close the object and hand back both halves — the NDJSON line and the typed payload.
    ///
    /// One method rather than two calls because `finish` takes `&mut self`, so a caller holding its
    /// answer could not then ask for the payload.
    pub fn done(&mut self) -> (&str, &Payload) {
        self.buf.push('}');
        (&self.buf, &self.p)
    }

    /// The typed half alone, valid until the next [`Ev::begin`].
    #[must_use]
    pub fn payload(&self) -> &Payload {
        &self.p
    }

    fn json_key(&mut self, k: Key) {
        if !self.first {
            self.buf.push(',');
        }
        self.first = false;
        self.buf.push('"');
        self.buf.push_str(k.as_str());
        self.buf.push_str("\":");
    }

    /// Record one typed field. The `debug_assert` enforces the header's first-wins claim where it
    /// would be broken rather than where it is relied on.
    fn note(&mut self, k: Key, slot: Slot) {
        debug_assert!(
            !self.p.fields.iter().any(|(x, _)| *x == k),
            "{} written twice on a {} event",
            k.as_str(),
            self.p.kind.as_str()
        );
        self.p.fields.push((k, slot));
    }

    pub fn s(&mut self, k: Key, v: &str) {
        self.json_key(k);
        write_json_string(&mut self.buf, v);
        let r = self.p.push_text(v);
        self.note(k, Slot::Str { at: r.0, len: r.1 });
    }

    /// A field written as `undefined` when absent: the key is omitted entirely and the payload
    /// records nothing.
    pub fn s_opt(&mut self, k: Key, v: Option<&str>) {
        if let Some(v) = v {
            self.s(k, v);
        }
    }

    pub fn i(&mut self, k: Key, v: i64) {
        self.json_key(k);
        self.buf.push_str(itoa(v).as_str());
        self.note(k, Slot::Int(v));
    }

    pub fn i_opt(&mut self, k: Key, v: Option<i64>) {
        if let Some(v) = v {
            self.i(k, v);
        }
    }

    /// A field whose absence is spelled `null` — present, and explicitly nothing.
    pub fn i_or_null(&mut self, k: Key, v: Option<i64>) {
        match v {
            Some(v) => self.i(k, v),
            None => {
                self.json_key(k);
                self.buf.push_str("null");
                self.note(k, Slot::Null);
            }
        }
    }

    pub fn s_or_null(&mut self, k: Key, v: Option<&str>) {
        match v {
            Some(v) => self.s(k, v),
            None => {
                self.json_key(k);
                self.buf.push_str("null");
                self.note(k, Slot::Null);
            }
        }
    }

    pub fn b(&mut self, k: Key, v: bool) {
        self.json_key(k);
        self.buf.push_str(if v { "true" } else { "false" });
        self.note(k, Slot::Bool(v));
    }

    pub fn f(&mut self, k: Key, v: f64) {
        self.json_key(k);
        write_js_number(&mut self.buf, v);
        self.note(k, Slot::Float(v));
    }

    pub fn strs(&mut self, k: Key, v: &[String]) {
        self.json_key(k);
        self.buf.push('[');
        let at = u32::try_from(self.p.strs.len()).unwrap_or(u32::MAX);
        for (i, s) in v.iter().enumerate() {
            if i > 0 {
                self.buf.push(',');
            }
            write_json_string(&mut self.buf, s);
            let r = self.p.push_text(s);
            self.p.strs.push(r);
        }
        self.buf.push(']');
        self.note(
            k,
            Slot::Strs {
                at,
                len: u32::try_from(v.len()).unwrap_or(0),
            },
        );
    }

    /// The charm/cc candidate shape: `{name, durationMs}`.
    pub fn cands_nd(&mut self, k: Key, v: impl Iterator<Item = (String, Option<i64>)>) {
        self.json_key(k);
        self.buf.push('[');
        let at = u32::try_from(self.p.cands.len()).unwrap_or(u32::MAX);
        let mut n = 0u32;
        for (i, (name, dur)) in v.enumerate() {
            if i > 0 {
                self.buf.push(',');
            }
            self.buf.push_str("{\"name\":");
            write_json_string(&mut self.buf, &name);
            self.buf.push_str(",\"durationMs\":");
            match dur {
                Some(d) => self.buf.push_str(itoa(d).as_str()),
                None => self.buf.push_str("null"),
            }
            self.buf.push('}');
            let r = self.p.push_text(&name);
            self.p.cands.push(CandSlot {
                name: r,
                duration_ms: dur,
                illusion: false,
            });
            n += 1;
        }
        self.buf.push(']');
        self.note(k, Slot::Cands { at, len: n });
    }

    /// The buffApply candidate shape: `{name, durationMs, illusion}`.
    pub fn cands_ndi(&mut self, k: Key, v: impl Iterator<Item = (String, Option<i64>, bool)>) {
        self.json_key(k);
        self.buf.push('[');
        let at = u32::try_from(self.p.cands.len()).unwrap_or(u32::MAX);
        let mut n = 0u32;
        for (i, (name, dur, illusion)) in v.enumerate() {
            if i > 0 {
                self.buf.push(',');
            }
            self.buf.push_str("{\"name\":");
            write_json_string(&mut self.buf, &name);
            self.buf.push_str(",\"durationMs\":");
            match dur {
                Some(d) => self.buf.push_str(itoa(d).as_str()),
                None => self.buf.push_str("null"),
            }
            self.buf.push_str(",\"illusion\":");
            self.buf.push_str(if illusion { "true" } else { "false" });
            self.buf.push('}');
            let r = self.p.push_text(&name);
            self.p.cands.push(CandSlot {
                name: r,
                duration_ms: dur,
                illusion,
            });
            n += 1;
        }
        self.buf.push(']');
        self.note(k, Slot::Cands { at, len: n });
    }

    /// A coin object whose key order is the order the denominations appeared in the clause, which
    /// is why it is a slice of pairs and not a map.
    pub fn coins(&mut self, k: Key, v: &[(&'static str, i64)]) {
        self.json_key(k);
        self.buf.push('{');
        let at = u32::try_from(self.p.coins.len()).unwrap_or(u32::MAX);
        for (i, (denom, amount)) in v.iter().enumerate() {
            if i > 0 {
                self.buf.push(',');
            }
            write_json_string(&mut self.buf, denom);
            self.buf.push(':');
            self.buf.push_str(itoa(*amount).as_str());
            self.p.coins.push((denom, *amount));
        }
        self.buf.push('}');
        self.note(
            k,
            Slot::Coins {
                at,
                len: u32::try_from(v.len()).unwrap_or(0),
            },
        );
    }
}

/// `i64` to decimal without a heap allocation. `to_string` allocates per number and this writer
/// emits three per line — the one allocation this file was still paying per event.
struct Itoa {
    buf: [u8; 20],
    at: usize,
}

impl Itoa {
    fn as_str(&self) -> &str {
        // Every byte written is an ASCII digit or '-'.
        std::str::from_utf8(&self.buf[self.at..]).unwrap_or("0")
    }
}

fn itoa(v: i64) -> Itoa {
    let mut out = Itoa {
        buf: [0u8; 20],
        at: 20,
    };
    // `unsigned_abs` rather than `-v`: `i64::MIN` has no positive counterpart.
    let neg = v < 0;
    let mut n = v.unsigned_abs();
    loop {
        out.at -= 1;
        out.buf[out.at] = b'0' + u8::try_from(n % 10).unwrap_or(0);
        n /= 10;
        if n == 0 {
            break;
        }
    }
    if neg {
        out.at -= 1;
        out.buf[out.at] = b'-';
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_round_trips_through_its_own_text() {
        for k in Kind::ALL {
            assert_eq!(Kind::parse(k.as_str()), k, "{}", k.as_str());
        }
        assert_eq!(Kind::parse("buffExpired"), Kind::BuffExpired);
        assert_eq!(Kind::parse("nonsense"), Kind::Other);
        assert_eq!(Kind::Other.as_str(), "");
    }

    #[test]
    fn every_key_round_trips_through_its_own_text() {
        for k in Key::ALL {
            assert_eq!(Key::parse(k.as_str()), Some(k), "{}", k.as_str());
        }
        assert_eq!(Key::parse("nothing-writes-this"), None);
    }

    /// The lists are hand-written duplicates of the enums, so the one thing they can get wrong is
    /// a missing variant — which would make a real field read as absent forever.
    #[test]
    fn the_key_and_kind_tables_are_complete() {
        let mut names: Vec<&str> = Key::ALL.iter().map(|k| k.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), Key::ALL.len(), "a key text is repeated");
        let mut kinds: Vec<&str> = Kind::ALL.iter().map(|k| k.as_str()).collect();
        kinds.sort_unstable();
        kinds.dedup();
        assert_eq!(kinds.len(), Kind::ALL.len(), "a kind text is repeated");
    }

    #[test]
    fn the_two_halves_state_the_same_event() {
        let mut ev = Ev::new();
        ev.begin(Kind::Damage);
        ev.envelope(3, 7, "raw line");
        ev.s(Key::Attacker, "Primitive");
        ev.i(Key::Amount, 231);
        ev.b(Key::Crit, false);
        ev.s_or_null(Key::Spell, None);
        ev.s_opt(Key::Modifier, None);
        ev.strs(Key::Modifiers, &["crippling".to_string()]);
        let (json, p) = ev.done();
        assert_eq!(
            json,
            r#"{"kind":"damage","seq":3,"ts":7,"raw":"raw line","attacker":"Primitive","amount":231,"crit":false,"spell":null,"modifiers":["crippling"]}"#
        );
        assert_eq!(p.kind(), Kind::Damage);
        assert_eq!(p.seq(), 3);
        assert_eq!(p.ts(), 7);
        assert_eq!(p.raw(), "raw line");
        assert_eq!(p.str(Key::Attacker), Some("Primitive"));
        assert_eq!(p.int(Key::Amount), Some(231));
        assert_eq!(p.bool(Key::Crit), Some(false));
        // An explicit null is present and holds no string; an omitted key is not there at all.
        assert_eq!(p.slot(Key::Spell), Some(Slot::Null));
        assert_eq!(p.str(Key::Spell), None);
        assert_eq!(p.slot(Key::Modifier), None);
        let mods: Vec<&str> = p.strs(Key::Modifiers).expect("a list").collect();
        assert_eq!(mods, vec!["crippling"]);
        assert_eq!(p.envelope_after(), 0);
    }

    /// `group` is the one kind that writes a field ahead of the envelope, and the payload has to be
    /// able to say so or the line could not be rebuilt from it.
    #[test]
    fn the_group_kind_records_its_pre_envelope_field() {
        let mut ev = Ev::new();
        ev.begin(Kind::Group);
        ev.s(Key::Change, "join");
        ev.envelope(0, 1, "x");
        let (json, p) = ev.done();
        assert_eq!(
            json,
            r#"{"kind":"group","change":"join","seq":0,"ts":1,"raw":"x"}"#
        );
        assert_eq!(p.envelope_after(), 1);
    }

    #[test]
    fn the_buffers_are_reused_and_a_second_event_sees_none_of_the_first() {
        let mut ev = Ev::new();
        ev.begin(Kind::Loot);
        ev.envelope(0, 0, "a");
        ev.s(Key::Item, "a rusty dagger");
        let _ = ev.finish();
        ev.begin(Kind::Zone);
        ev.envelope(1, 2, "b");
        ev.s(Key::Zone, "Najena");
        let (json, p) = ev.done();
        assert_eq!(
            json,
            r#"{"kind":"zone","seq":1,"ts":2,"raw":"b","zone":"Najena"}"#
        );
        assert_eq!(p.str(Key::Item), None);
        assert_eq!(p.str(Key::Zone), Some("Najena"));
        assert_eq!(p.raw(), "b");
    }

    #[test]
    fn the_candidate_shapes_keep_their_own_flags() {
        let mut ev = Ev::new();
        ev.begin(Kind::BuffApply);
        ev.envelope(0, 0, "x");
        ev.cands_ndi(
            Key::Candidates,
            vec![
                ("Haste".to_string(), Some(1000), false),
                ("Form of the Wolf".to_string(), None, true),
            ]
            .into_iter(),
        );
        let (json, p) = ev.done();
        assert!(
            json.contains(r#""candidates":[{"name":"Haste","durationMs":1000,"illusion":false}"#)
        );
        let got: Vec<(&str, Option<i64>, bool)> =
            p.cands(Key::Candidates).expect("a list").collect();
        assert_eq!(got[0], ("Haste", Some(1000), false));
        assert_eq!(got[1], ("Form of the Wolf", None, true));
    }

    #[test]
    fn the_integer_writer_matches_the_one_it_replaces() {
        for v in [
            0i64,
            1,
            -1,
            9,
            -9,
            10,
            i64::MAX,
            i64::MIN,
            1_787_181_707_000,
        ] {
            assert_eq!(itoa(v).as_str(), v.to_string(), "{v}");
        }
    }
}
