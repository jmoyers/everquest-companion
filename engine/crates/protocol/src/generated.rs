//! GENERATED FILE - DO NOT EDIT.
//!
//! Generated from protocol/schema/*.schema.json by `npm run gen:protocol`.
//! Edit the schema, run the generator, commit both sides.
//!
//! Neither language is privileged: this file and its TypeScript twin
//! (src/shared/dataServer/protocol.generated.ts) come from the same neutral JSON Schema,
//! and a schema edit that lands without regenerating turns the protocol-codegen staleness
//! test red on this side and tests/protocolSchema.test.mts red on the other.
//!
//! schema-digest: sha256:b6f362f405c373d629ffc2b193a21b016358eb8c7b1a53857f89be2c02068103
#![allow(missing_docs, clippy::all, clippy::pedantic)]

/// Error types.
pub mod error {
    /// Error from a `TryFrom` or `FromStr` implementation.
    pub struct ConversionError(::std::borrow::Cow<'static, str>);
    impl ::std::error::Error for ConversionError {}
    impl ::std::fmt::Display for ConversionError {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> Result<(), ::std::fmt::Error> {
            ::std::fmt::Display::fmt(&self.0, f)
        }
    }
    impl ::std::fmt::Debug for ConversionError {
        fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> Result<(), ::std::fmt::Error> {
            ::std::fmt::Debug::fmt(&self.0, f)
        }
    }
    impl From<&'static str> for ConversionError {
        fn from(value: &'static str) -> Self {
            Self(value.into())
        }
    }
    impl From<String> for ConversionError {
        fn from(value: String) -> Self {
            Self(value.into())
        }
    }
}
///One alert, EXACTLY AS THE STORE HOLDS IT — `src/shared/alertTypes.ts AlertDef`. The protocol states nothing about its shape, and that is the `ModuleState`/`Cells` argument at full strength rather than a shortcut. Two reasons, and the second is the load-bearing one. (1) The field set is the STORE's contract: a def carries an id, a name, an enabled flag, a trigger grammar and a sound reference that the engine's evaluator reads, plus volume, audio channel, speech phrase, banner colour, notes and the early-warning offset that belong entirely to the app — and an alert growing a field must not be a protocol change or turn a whole push into `badParams`. (2) A DEFINITION ROUND-TRIPS: the fold republishes the pushed list as the `alerts` module's own `defs`, which is what the app's alert list is drawn from, so a typed protocol shape that quietly dropped an unlisted field would REWRITE THE USER'S ALERTS as they passed through the engine. Typed-where-cheap is not cheap here. The engine reads what it needs with its own reader (`fold::modules::alerts_rules::Rule::compile`), exactly as the fold reads an event.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "AlertDefinition",
///  "description": "One alert, EXACTLY AS THE STORE HOLDS IT — `src/shared/alertTypes.ts AlertDef`. The protocol states nothing about its shape, and that is the `ModuleState`/`Cells` argument at full strength rather than a shortcut. Two reasons, and the second is the load-bearing one. (1) The field set is the STORE's contract: a def carries an id, a name, an enabled flag, a trigger grammar and a sound reference that the engine's evaluator reads, plus volume, audio channel, speech phrase, banner colour, notes and the early-warning offset that belong entirely to the app — and an alert growing a field must not be a protocol change or turn a whole push into `badParams`. (2) A DEFINITION ROUND-TRIPS: the fold republishes the pushed list as the `alerts` module's own `defs`, which is what the app's alert list is drawn from, so a typed protocol shape that quietly dropped an unlisted field would REWRITE THE USER'S ALERTS as they passed through the engine. Typed-where-cheap is not cheap here. The engine reads what it needs with its own reader (`fold::modules::alerts_rules::Rule::compile`), exactly as the fold reads an event.",
///  "type": "object",
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(transparent)]
pub struct AlertDefinition(pub ::serde_json::Map<::std::string::String, ::serde_json::Value>);
impl ::std::ops::Deref for AlertDefinition {
    type Target = ::serde_json::Map<::std::string::String, ::serde_json::Value>;
    fn deref(&self) -> &::serde_json::Map<::std::string::String, ::serde_json::Value> {
        &self.0
    }
}
impl ::std::convert::From<AlertDefinition>
    for ::serde_json::Map<::std::string::String, ::serde_json::Value>
{
    fn from(value: AlertDefinition) -> Self {
        value.0
    }
}
impl ::std::convert::From<::serde_json::Map<::std::string::String, ::serde_json::Value>>
    for AlertDefinition
{
    fn from(value: ::serde_json::Map<::std::string::String, ::serde_json::Value>) -> Self {
        Self(value)
    }
}
///`AlertsDefineParams`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "AlertsDefineParams",
///  "type": "object",
///  "required": [
///    "defs"
///  ],
///  "properties": {
///    "defs": {
///      "description": "THE WHOLE SET, always. Not a delta: a define replaces what the engine holds, so a crash-respawn is a replay of the latest push and a command input is hash-friendly.",
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/AlertDefinition"
///      }
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct AlertsDefineParams {
    ///THE WHOLE SET, always. Not a delta: a define replaces what the engine holds, so a crash-respawn is a replay of the latest push and a command input is hash-friendly.
    pub defs: ::std::vec::Vec<AlertDefinition>,
}
///THE USER'S ALERT DEFINITIONS, pushed (boundary verdict 3). The store stays persistence truth app-side and the engine never reads a settings file; the app pushes the WHOLE set on connect and on every save/delete. Since ruling 22 the engine is also what EVALUATES them: a match on a LIVE event becomes a `FireMessage` on the stream, and the app-side alert system reduces to receive-fire-make-sound.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "AlertsDefineRequest",
///  "description": "THE USER'S ALERT DEFINITIONS, pushed (boundary verdict 3). The store stays persistence truth app-side and the engine never reads a settings file; the app pushes the WHOLE set on connect and on every save/delete. Since ruling 22 the engine is also what EVALUATES them: a match on a LIVE event becomes a `FireMessage` on the stream, and the app-side alert system reduces to receive-fire-make-sound.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "alerts.define"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/AlertsDefineParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct AlertsDefineRequest {
    pub id: RequestId,
    pub op: AlertsDefineRequestOp,
    pub params: AlertsDefineParams,
}
///`AlertsDefineRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "alerts.define"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum AlertsDefineRequestOp {
    #[serde(rename = "alerts.define")]
    AlertsDefine,
}
impl ::std::fmt::Display for AlertsDefineRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::AlertsDefine => f.write_str("alerts.define"),
        }
    }
}
impl ::std::str::FromStr for AlertsDefineRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "alerts.define" => Ok(Self::AlertsDefine),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for AlertsDefineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for AlertsDefineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for AlertsDefineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`AttachResult`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "AttachResult",
///  "type": "object",
///  "required": [
///    "accepted",
///    "epoch"
///  ],
///  "properties": {
///    "accepted": {
///      "description": "False when the attach was preempted by a later one before it began — the caller's own attach is the one that lost, and the epoch names the winner.",
///      "type": "boolean"
///    },
///    "epoch": {
///      "$ref": "#/$defs/Epoch"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct AttachResult {
    ///False when the attach was preempted by a later one before it began — the caller's own attach is the one that lost, and the epoch names the winner.
    pub accepted: bool,
    pub epoch: Epoch,
}
///`BuffTrustDefineParams`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "BuffTrustDefineParams",
///  "type": "object",
///  "required": [
///    "trust"
///  ],
///  "properties": {
///    "trust": {
///      "$ref": "#/$defs/BuffTrustPrefs"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct BuffTrustDefineParams {
    pub trust: BuffTrustPrefs,
}
///WHOSE CASTS, BESIDES YOUR OWN, MAY ANCHOR A LANDING (JOS-140). Pushed like every other piece of app knowledge; it ships empty and stays empty for almost everybody.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "BuffTrustDefineRequest",
///  "description": "WHOSE CASTS, BESIDES YOUR OWN, MAY ANCHOR A LANDING (JOS-140). Pushed like every other piece of app knowledge; it ships empty and stays empty for almost everybody.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "buffTrust.define"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/BuffTrustDefineParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct BuffTrustDefineRequest {
    pub id: RequestId,
    pub op: BuffTrustDefineRequestOp,
    pub params: BuffTrustDefineParams,
}
///`BuffTrustDefineRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "buffTrust.define"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum BuffTrustDefineRequestOp {
    #[serde(rename = "buffTrust.define")]
    BuffTrustDefine,
}
impl ::std::fmt::Display for BuffTrustDefineRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::BuffTrustDefine => f.write_str("buffTrust.define"),
        }
    }
}
impl ::std::str::FromStr for BuffTrustDefineRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "buffTrust.define" => Ok(Self::BuffTrustDefine),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for BuffTrustDefineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for BuffTrustDefineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for BuffTrustDefineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`src/shared/buffTrust.ts BuffTrustPrefs`. Typed because it is cheap to type: one list of display spellings, in the order the user added them.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "BuffTrustPrefs",
///  "description": "`src/shared/buffTrust.ts BuffTrustPrefs`. Typed because it is cheap to type: one list of display spellings, in the order the user added them.",
///  "type": "object",
///  "required": [
///    "externals"
///  ],
///  "properties": {
///    "externals": {
///      "type": "array",
///      "items": {
///        "type": "string"
///      }
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct BuffTrustPrefs {
    pub externals: ::std::vec::Vec<::std::string::String>,
}
///A row's fields by name. Open by design — the field set is the VIEW's contract, not the protocol's, so a new column is not a protocol change.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "Cells",
///  "description": "A row's fields by name. Open by design — the field set is the VIEW's contract, not the protocol's, so a new column is not a protocol change.",
///  "type": "object",
///  "additionalProperties": {
///    "$ref": "#/$defs/Cell"
///  }
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(transparent)]
pub struct Cells(pub ::std::collections::BTreeMap<::std::string::String, crate::cell::Cell>);
impl ::std::ops::Deref for Cells {
    type Target = ::std::collections::BTreeMap<::std::string::String, crate::cell::Cell>;
    fn deref(&self) -> &::std::collections::BTreeMap<::std::string::String, crate::cell::Cell> {
        &self.0
    }
}
impl ::std::convert::From<Cells>
    for ::std::collections::BTreeMap<::std::string::String, crate::cell::Cell>
{
    fn from(value: Cells) -> Self {
        value.0
    }
}
impl ::std::convert::From<::std::collections::BTreeMap<::std::string::String, crate::cell::Cell>>
    for Cells
{
    fn from(value: ::std::collections::BTreeMap<::std::string::String, crate::cell::Cell>) -> Self {
        Self(value)
    }
}
///One of the sixteen EverQuest classes, spelled the way `src/shared/classCombo.ts CLASS_ABBRS` spells it. Note SHD, not SHK. The order here is alphabetical like the app's list; the CLIENT FILE's column order is a different order entirely and belongs to the parser that reads it, never to the wire.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ClassAbbr",
///  "description": "One of the sixteen EverQuest classes, spelled the way `src/shared/classCombo.ts CLASS_ABBRS` spells it. Note SHD, not SHK. The order here is alphabetical like the app's list; the CLIENT FILE's column order is a different order entirely and belongs to the parser that reads it, never to the wire.",
///  "type": "string",
///  "enum": [
///    "BER",
///    "BRD",
///    "BST",
///    "CLR",
///    "DRU",
///    "ENC",
///    "MAG",
///    "MNK",
///    "NEC",
///    "PAL",
///    "RNG",
///    "ROG",
///    "SHD",
///    "SHM",
///    "WAR",
///    "WIZ"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum ClassAbbr {
    #[serde(rename = "BER")]
    Ber,
    #[serde(rename = "BRD")]
    Brd,
    #[serde(rename = "BST")]
    Bst,
    #[serde(rename = "CLR")]
    Clr,
    #[serde(rename = "DRU")]
    Dru,
    #[serde(rename = "ENC")]
    Enc,
    #[serde(rename = "MAG")]
    Mag,
    #[serde(rename = "MNK")]
    Mnk,
    #[serde(rename = "NEC")]
    Nec,
    #[serde(rename = "PAL")]
    Pal,
    #[serde(rename = "RNG")]
    Rng,
    #[serde(rename = "ROG")]
    Rog,
    #[serde(rename = "SHD")]
    Shd,
    #[serde(rename = "SHM")]
    Shm,
    #[serde(rename = "WAR")]
    War,
    #[serde(rename = "WIZ")]
    Wiz,
}
impl ::std::fmt::Display for ClassAbbr {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Ber => f.write_str("BER"),
            Self::Brd => f.write_str("BRD"),
            Self::Bst => f.write_str("BST"),
            Self::Clr => f.write_str("CLR"),
            Self::Dru => f.write_str("DRU"),
            Self::Enc => f.write_str("ENC"),
            Self::Mag => f.write_str("MAG"),
            Self::Mnk => f.write_str("MNK"),
            Self::Nec => f.write_str("NEC"),
            Self::Pal => f.write_str("PAL"),
            Self::Rng => f.write_str("RNG"),
            Self::Rog => f.write_str("ROG"),
            Self::Shd => f.write_str("SHD"),
            Self::Shm => f.write_str("SHM"),
            Self::War => f.write_str("WAR"),
            Self::Wiz => f.write_str("WIZ"),
        }
    }
}
impl ::std::str::FromStr for ClassAbbr {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "BER" => Ok(Self::Ber),
            "BRD" => Ok(Self::Brd),
            "BST" => Ok(Self::Bst),
            "CLR" => Ok(Self::Clr),
            "DRU" => Ok(Self::Dru),
            "ENC" => Ok(Self::Enc),
            "MAG" => Ok(Self::Mag),
            "MNK" => Ok(Self::Mnk),
            "NEC" => Ok(Self::Nec),
            "PAL" => Ok(Self::Pal),
            "RNG" => Ok(Self::Rng),
            "ROG" => Ok(Self::Rog),
            "SHD" => Ok(Self::Shd),
            "SHM" => Ok(Self::Shm),
            "WAR" => Ok(Self::War),
            "WIZ" => Ok(Self::Wiz),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ClassAbbr {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ClassAbbr {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ClassAbbr {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///Every message the app sends the engine. Internally tagged on `op`, so a new surface is a new branch and the envelope never changes.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ClientMessage",
///  "description": "Every message the app sends the engine. Internally tagged on `op`, so a new surface is a new branch and the envelope never changes.",
///  "oneOf": [
///    {
///      "$ref": "#/$defs/Hello"
///    },
///    {
///      "$ref": "#/$defs/EchoRequest"
///    },
///    {
///      "$ref": "#/$defs/SessionAttachRequest"
///    },
///    {
///      "$ref": "#/$defs/SessionHealthRequest"
///    },
///    {
///      "$ref": "#/$defs/SessionProgressRequest"
///    },
///    {
///      "$ref": "#/$defs/ModuleSnapshotRequest"
///    },
///    {
///      "$ref": "#/$defs/PerfSnapshotRequest"
///    },
///    {
///      "$ref": "#/$defs/PerfBudgetsRequest"
///    },
///    {
///      "$ref": "#/$defs/PerfTimelineRequest"
///    },
///    {
///      "$ref": "#/$defs/ViewSubscribeRequest"
///    },
///    {
///      "$ref": "#/$defs/ViewUnsubscribeRequest"
///    },
///    {
///      "$ref": "#/$defs/AlertsDefineRequest"
///    },
///    {
///      "$ref": "#/$defs/BuffTrustDefineRequest"
///    },
///    {
///      "$ref": "#/$defs/RespawnDefineRequest"
///    },
///    {
///      "$ref": "#/$defs/ComboDefineRequest"
///    },
///    {
///      "$ref": "#/$defs/RosterDefineRequest"
///    },
///    {
///      "$ref": "#/$defs/CombatSnapshotRequest"
///    },
///    {
///      "$ref": "#/$defs/CombatSearchFightsRequest"
///    },
///    {
///      "$ref": "#/$defs/KnowledgeItemRequest"
///    },
///    {
///      "$ref": "#/$defs/KnowledgeMobRequest"
///    },
///    {
///      "$ref": "#/$defs/KnowledgeSpellRequest"
///    },
///    {
///      "$ref": "#/$defs/KnowledgeSearchRequest"
///    },
///    {
///      "$ref": "#/$defs/KnowledgeDefineRequest"
///    },
///    {
///      "$ref": "#/$defs/SessionMarkAddRequest"
///    },
///    {
///      "$ref": "#/$defs/RespawnConfirmSightingRequest"
///    },
///    {
///      "$ref": "#/$defs/ResistLevelsRequest"
///    },
///    {
///      "$ref": "#/$defs/ResistSpellRequest"
///    },
///    {
///      "$ref": "#/$defs/SpellsSearchRequest"
///    },
///    {
///      "$ref": "#/$defs/LogsSetDirRequest"
///    },
///    {
///      "$ref": "#/$defs/LogsListRequest"
///    }
///  ]
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum ClientMessage {
    Hello(Hello),
    EchoRequest(EchoRequest),
    SessionAttachRequest(SessionAttachRequest),
    SessionHealthRequest(SessionHealthRequest),
    SessionProgressRequest(SessionProgressRequest),
    ModuleSnapshotRequest(ModuleSnapshotRequest),
    PerfSnapshotRequest(PerfSnapshotRequest),
    PerfBudgetsRequest(PerfBudgetsRequest),
    PerfTimelineRequest(PerfTimelineRequest),
    ViewSubscribeRequest(ViewSubscribeRequest),
    ViewUnsubscribeRequest(ViewUnsubscribeRequest),
    AlertsDefineRequest(AlertsDefineRequest),
    BuffTrustDefineRequest(BuffTrustDefineRequest),
    RespawnDefineRequest(RespawnDefineRequest),
    ComboDefineRequest(ComboDefineRequest),
    RosterDefineRequest(RosterDefineRequest),
    CombatSnapshotRequest(CombatSnapshotRequest),
    CombatSearchFightsRequest(CombatSearchFightsRequest),
    KnowledgeItemRequest(KnowledgeItemRequest),
    KnowledgeMobRequest(KnowledgeMobRequest),
    KnowledgeSpellRequest(KnowledgeSpellRequest),
    KnowledgeSearchRequest(KnowledgeSearchRequest),
    KnowledgeDefineRequest(KnowledgeDefineRequest),
    SessionMarkAddRequest(SessionMarkAddRequest),
    RespawnConfirmSightingRequest(RespawnConfirmSightingRequest),
    ResistLevelsRequest(ResistLevelsRequest),
    ResistSpellRequest(ResistSpellRequest),
    SpellsSearchRequest(SpellsSearchRequest),
    LogsSetDirRequest(LogsSetDirRequest),
    LogsListRequest(LogsListRequest),
}
impl ::std::convert::From<Hello> for ClientMessage {
    fn from(value: Hello) -> Self {
        Self::Hello(value)
    }
}
impl ::std::convert::From<EchoRequest> for ClientMessage {
    fn from(value: EchoRequest) -> Self {
        Self::EchoRequest(value)
    }
}
impl ::std::convert::From<SessionAttachRequest> for ClientMessage {
    fn from(value: SessionAttachRequest) -> Self {
        Self::SessionAttachRequest(value)
    }
}
impl ::std::convert::From<SessionHealthRequest> for ClientMessage {
    fn from(value: SessionHealthRequest) -> Self {
        Self::SessionHealthRequest(value)
    }
}
impl ::std::convert::From<SessionProgressRequest> for ClientMessage {
    fn from(value: SessionProgressRequest) -> Self {
        Self::SessionProgressRequest(value)
    }
}
impl ::std::convert::From<ModuleSnapshotRequest> for ClientMessage {
    fn from(value: ModuleSnapshotRequest) -> Self {
        Self::ModuleSnapshotRequest(value)
    }
}
impl ::std::convert::From<PerfSnapshotRequest> for ClientMessage {
    fn from(value: PerfSnapshotRequest) -> Self {
        Self::PerfSnapshotRequest(value)
    }
}
impl ::std::convert::From<PerfBudgetsRequest> for ClientMessage {
    fn from(value: PerfBudgetsRequest) -> Self {
        Self::PerfBudgetsRequest(value)
    }
}
impl ::std::convert::From<PerfTimelineRequest> for ClientMessage {
    fn from(value: PerfTimelineRequest) -> Self {
        Self::PerfTimelineRequest(value)
    }
}
impl ::std::convert::From<ViewSubscribeRequest> for ClientMessage {
    fn from(value: ViewSubscribeRequest) -> Self {
        Self::ViewSubscribeRequest(value)
    }
}
impl ::std::convert::From<ViewUnsubscribeRequest> for ClientMessage {
    fn from(value: ViewUnsubscribeRequest) -> Self {
        Self::ViewUnsubscribeRequest(value)
    }
}
impl ::std::convert::From<AlertsDefineRequest> for ClientMessage {
    fn from(value: AlertsDefineRequest) -> Self {
        Self::AlertsDefineRequest(value)
    }
}
impl ::std::convert::From<BuffTrustDefineRequest> for ClientMessage {
    fn from(value: BuffTrustDefineRequest) -> Self {
        Self::BuffTrustDefineRequest(value)
    }
}
impl ::std::convert::From<RespawnDefineRequest> for ClientMessage {
    fn from(value: RespawnDefineRequest) -> Self {
        Self::RespawnDefineRequest(value)
    }
}
impl ::std::convert::From<ComboDefineRequest> for ClientMessage {
    fn from(value: ComboDefineRequest) -> Self {
        Self::ComboDefineRequest(value)
    }
}
impl ::std::convert::From<RosterDefineRequest> for ClientMessage {
    fn from(value: RosterDefineRequest) -> Self {
        Self::RosterDefineRequest(value)
    }
}
impl ::std::convert::From<CombatSnapshotRequest> for ClientMessage {
    fn from(value: CombatSnapshotRequest) -> Self {
        Self::CombatSnapshotRequest(value)
    }
}
impl ::std::convert::From<CombatSearchFightsRequest> for ClientMessage {
    fn from(value: CombatSearchFightsRequest) -> Self {
        Self::CombatSearchFightsRequest(value)
    }
}
impl ::std::convert::From<KnowledgeItemRequest> for ClientMessage {
    fn from(value: KnowledgeItemRequest) -> Self {
        Self::KnowledgeItemRequest(value)
    }
}
impl ::std::convert::From<KnowledgeMobRequest> for ClientMessage {
    fn from(value: KnowledgeMobRequest) -> Self {
        Self::KnowledgeMobRequest(value)
    }
}
impl ::std::convert::From<KnowledgeSpellRequest> for ClientMessage {
    fn from(value: KnowledgeSpellRequest) -> Self {
        Self::KnowledgeSpellRequest(value)
    }
}
impl ::std::convert::From<KnowledgeSearchRequest> for ClientMessage {
    fn from(value: KnowledgeSearchRequest) -> Self {
        Self::KnowledgeSearchRequest(value)
    }
}
impl ::std::convert::From<KnowledgeDefineRequest> for ClientMessage {
    fn from(value: KnowledgeDefineRequest) -> Self {
        Self::KnowledgeDefineRequest(value)
    }
}
impl ::std::convert::From<SessionMarkAddRequest> for ClientMessage {
    fn from(value: SessionMarkAddRequest) -> Self {
        Self::SessionMarkAddRequest(value)
    }
}
impl ::std::convert::From<RespawnConfirmSightingRequest> for ClientMessage {
    fn from(value: RespawnConfirmSightingRequest) -> Self {
        Self::RespawnConfirmSightingRequest(value)
    }
}
impl ::std::convert::From<ResistLevelsRequest> for ClientMessage {
    fn from(value: ResistLevelsRequest) -> Self {
        Self::ResistLevelsRequest(value)
    }
}
impl ::std::convert::From<ResistSpellRequest> for ClientMessage {
    fn from(value: ResistSpellRequest) -> Self {
        Self::ResistSpellRequest(value)
    }
}
impl ::std::convert::From<SpellsSearchRequest> for ClientMessage {
    fn from(value: SpellsSearchRequest) -> Self {
        Self::SpellsSearchRequest(value)
    }
}
impl ::std::convert::From<LogsSetDirRequest> for ClientMessage {
    fn from(value: LogsSetDirRequest) -> Self {
        Self::LogsSetDirRequest(value)
    }
}
impl ::std::convert::From<LogsListRequest> for ClientMessage {
    fn from(value: LogsListRequest) -> Self {
        Self::LogsListRequest(value)
    }
}
///One row of `spells_us.txt` as the app's own `SpellResistInfo` describes it, field for field. THE OPTIONALS ARE ABSENT-MEANS-NOTHING and each absence was measured rather than chosen: a zero recast is the file saying there is no re-use timer, a zero `aeMaxTargets` is what 71,864 of ~74k rows read, and a zero mana is what every bard song says. Storing those zeros would cost a field on most of the table to state what the absence already states.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ClientSpell",
///  "description": "One row of `spells_us.txt` as the app's own `SpellResistInfo` describes it, field for field. THE OPTIONALS ARE ABSENT-MEANS-NOTHING and each absence was measured rather than chosen: a zero recast is the file saying there is no re-use timer, a zero `aeMaxTargets` is what 71,864 of ~74k rows read, and a zero mana is what every bard song says. Storing those zeros would cost a field on most of the table to state what the absence already states.",
///  "type": "object",
///  "required": [
///    "castMs",
///    "debuffSlots",
///    "resistAdj",
///    "targetType"
///  ],
///  "properties": {
///    "aeMaxTargets": {
///      "type": "number"
///    },
///    "axis": {
///      "$ref": "#/$defs/ResistAxis"
///    },
///    "castMs": {
///      "type": "number"
///    },
///    "damageSlot": {
///      "$ref": "#/$defs/ClientSpellSlot"
///    },
///    "debuffSlots": {
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/ClientSpellDebuff"
///      }
///    },
///    "levelCap": {
///      "description": "The level the game refuses the spell above, regardless of resist. From the PRIMARY slot only and only for a charm or a mez: a stun rider's cap costs the stun, not the nuke.",
///      "type": "number"
///    },
///    "mana": {
///      "type": "number"
///    },
///    "recastMs": {
///      "type": "number"
///    },
///    "resistAdj": {
///      "type": "number"
///    },
///    "song": {
///      "description": "Only the bard can cast it. Present only when true - a song is never filed as a cast.",
///      "type": "boolean"
///    },
///    "targetType": {
///      "type": "number"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ClientSpell {
    #[serde(
        rename = "aeMaxTargets",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub ae_max_targets: ::std::option::Option<f64>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub axis: ::std::option::Option<ResistAxis>,
    #[serde(rename = "castMs")]
    pub cast_ms: f64,
    #[serde(
        rename = "damageSlot",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub damage_slot: ::std::option::Option<ClientSpellSlot>,
    #[serde(rename = "debuffSlots")]
    pub debuff_slots: ::std::vec::Vec<ClientSpellDebuff>,
    ///The level the game refuses the spell above, regardless of resist. From the PRIMARY slot only and only for a charm or a mez: a stun rider's cap costs the stun, not the nuke.
    #[serde(
        rename = "levelCap",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub level_cap: ::std::option::Option<f64>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub mana: ::std::option::Option<f64>,
    #[serde(
        rename = "recastMs",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub recast_ms: ::std::option::Option<f64>,
    #[serde(rename = "resistAdj")]
    pub resist_adj: f64,
    ///Only the bard can cast it. Present only when true - a song is never filed as a cast.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub song: ::std::option::Option<bool>,
    #[serde(rename = "targetType")]
    pub target_type: f64,
}
///A resist-DECREASE slot worth at least five points. The floor is not arbitrary: Solon's Bewitching Bravura carries a one-point magic-resist rider and is a CHARM, and opening an eleven-minute debuff window for one point would file every charmed mob's later observations under a condition that never mattered. Five sits comfortably below the weakest real member of the family (Tashani, 23) and above every rider in the file.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ClientSpellDebuff",
///  "description": "A resist-DECREASE slot worth at least five points. The floor is not arbitrary: Solon's Bewitching Bravura carries a one-point magic-resist rider and is a CHARM, and opening an eleven-minute debuff window for one point would file every charmed mob's later observations under a condition that never mattered. Five sits comfortably below the weakest real member of the family (Tashani, 23) and above every rider in the file.",
///  "type": "object",
///  "required": [
///    "axis",
///    "base",
///    "calc",
///    "max"
///  ],
///  "properties": {
///    "axis": {
///      "$ref": "#/$defs/ClientSpellDebuffAxis"
///    },
///    "base": {
///      "type": "number"
///    },
///    "calc": {
///      "type": "number"
///    },
///    "max": {
///      "type": "number"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ClientSpellDebuff {
    pub axis: ClientSpellDebuffAxis,
    pub base: f64,
    pub calc: f64,
    pub max: f64,
}
///A debuff SLOT's axis, which is the five plus `all` - the tash and malo family, effect 111. A SPELL's own axis is never `all`, which is why this is a separate set from `ResistAxis` rather than that set with a member added.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ClientSpellDebuffAxis",
///  "description": "A debuff SLOT's axis, which is the five plus `all` - the tash and malo family, effect 111. A SPELL's own axis is never `all`, which is why this is a separate set from `ResistAxis` rather than that set with a member added.",
///  "type": "string",
///  "enum": [
///    "magic",
///    "fire",
///    "cold",
///    "poison",
///    "disease",
///    "all"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum ClientSpellDebuffAxis {
    #[serde(rename = "magic")]
    Magic,
    #[serde(rename = "fire")]
    Fire,
    #[serde(rename = "cold")]
    Cold,
    #[serde(rename = "poison")]
    Poison,
    #[serde(rename = "disease")]
    Disease,
    #[serde(rename = "all")]
    All,
}
impl ::std::fmt::Display for ClientSpellDebuffAxis {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Magic => f.write_str("magic"),
            Self::Fire => f.write_str("fire"),
            Self::Cold => f.write_str("cold"),
            Self::Poison => f.write_str("poison"),
            Self::Disease => f.write_str("disease"),
            Self::All => f.write_str("all"),
        }
    }
}
impl ::std::str::FromStr for ClientSpellDebuffAxis {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "magic" => Ok(Self::Magic),
            "fire" => Ok(Self::Fire),
            "cold" => Ok(Self::Cold),
            "poison" => Ok(Self::Poison),
            "disease" => Ok(Self::Disease),
            "all" => Ok(Self::All),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ClientSpellDebuffAxis {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ClientSpellDebuffAxis {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ClientSpellDebuffAxis {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///The effect-0 hitpoint slot, which is what the resist estimator reads to decide whether a spell's damage is a fixed number. Effect 0 ALONE, deliberately: neither a heal-over-time (effect 100) nor a bard's pulse (334) is a spell the estimator fits a resist from, and widening it would change what the ledger and the con card read for no gain. An effect slot is `slot | effectId | base | limit | CALC | MAX` - measured, and the one correction the original brief needed.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ClientSpellSlot",
///  "description": "The effect-0 hitpoint slot, which is what the resist estimator reads to decide whether a spell's damage is a fixed number. Effect 0 ALONE, deliberately: neither a heal-over-time (effect 100) nor a bard's pulse (334) is a spell the estimator fits a resist from, and widening it would change what the ledger and the con card read for no gain. An effect slot is `slot | effectId | base | limit | CALC | MAX` - measured, and the one correction the original brief needed.",
///  "type": "object",
///  "required": [
///    "base",
///    "calc",
///    "max"
///  ],
///  "properties": {
///    "base": {
///      "type": "number"
///    },
///    "calc": {
///      "type": "number"
///    },
///    "max": {
///      "type": "number"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ClientSpellSlot {
    pub base: f64,
    pub calc: f64,
    pub max: f64,
}
///`CombatSearchFightsParams`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "CombatSearchFightsParams",
///  "type": "object",
///  "required": [
///    "query"
///  ],
///  "properties": {
///    "limit": {
///      "description": "How many ranked hits to return. CLAMPED to the engine's own bounds rather than refused, which is `world.ts`'s rule kept verbatim: a renderer bug asking for an unbounded payload is a payload problem, not a conversation-ending one, and a search box that stopped answering because a number was silly would be the worse failure. Absent takes the engine's default.",
///      "type": "integer"
///    },
///    "query": {
///      "description": "What the user typed. Tokenized to lowercase alphanumerics; an empty or whitespace-only query answers NO hits rather than everything — the UI shows its ordinary browse list in that state, and returning the whole corpus would make the empty box the most expensive keystroke of all.",
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct CombatSearchFightsParams {
    ///How many ranked hits to return. CLAMPED to the engine's own bounds rather than refused, which is `world.ts`'s rule kept verbatim: a renderer bug asking for an unbounded payload is a payload problem, not a conversation-ending one, and a search box that stopped answering because a number was silly would be the worse failure. Absent takes the engine's default.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub limit: ::std::option::Option<i64>,
    ///What the user typed. Tokenized to lowercase alphanumerics; an empty or whitespace-only query answers NO hits rather than everything — the UI shows its ordinary browse list in that state, and returning the whole corpus would make the empty box the most expensive keystroke of all.
    pub query: ::std::string::String,
}
///SEARCH THE FIGHT HISTORY (Task #61, moved server-side by JOS-485). `src/main/ipc/world.ts`'s `searchFights` handler, whose semantics are mirrored here exactly: a non-string query is the empty string, and a `limit` is CLAMPED rather than refused — see `CombatSearchFightsParams.limit`. The corpus is the engine's UNCAPPED encounter history plus the open fight, which is why this is an op and not a view: it is a ranked answer to a question, not a window over a collection, and its rows are the app's own `SegmentSummary` rather than cells.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "CombatSearchFightsRequest",
///  "description": "SEARCH THE FIGHT HISTORY (Task #61, moved server-side by JOS-485). `src/main/ipc/world.ts`'s `searchFights` handler, whose semantics are mirrored here exactly: a non-string query is the empty string, and a `limit` is CLAMPED rather than refused — see `CombatSearchFightsParams.limit`. The corpus is the engine's UNCAPPED encounter history plus the open fight, which is why this is an op and not a view: it is a ranked answer to a question, not a window over a collection, and its rows are the app's own `SegmentSummary` rather than cells.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "combat.searchFights"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/CombatSearchFightsParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct CombatSearchFightsRequest {
    pub id: RequestId,
    pub op: CombatSearchFightsRequestOp,
    pub params: CombatSearchFightsParams,
}
///`CombatSearchFightsRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "combat.searchFights"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum CombatSearchFightsRequestOp {
    #[serde(rename = "combat.searchFights")]
    CombatSearchFights,
}
impl ::std::fmt::Display for CombatSearchFightsRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::CombatSearchFights => f.write_str("combat.searchFights"),
        }
    }
}
impl ::std::str::FromStr for CombatSearchFightsRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "combat.searchFights" => Ok(Self::CombatSearchFights),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for CombatSearchFightsRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for CombatSearchFightsRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for CombatSearchFightsRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`src/shared/combat.ts FightSearchResult`. Ranked hits, best first, ties broken by recency and then by id so the order never depends on the corpus's arrival order.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "CombatSearchFightsResult",
///  "description": "`src/shared/combat.ts FightSearchResult`. Ranked hits, best first, ties broken by recency and then by id so the order never depends on the corpus's arrival order.",
///  "type": "object",
///  "required": [
///    "corpus",
///    "hits"
///  ],
///  "properties": {
///    "corpus": {
///      "description": "How many fights were SEARCHED — the whole uncapped history plus the open fight. It lets a UI say `12 of 1,428` honestly instead of implying the corpus is the result set, and it is present even when `hits` is empty, because `no matches in 1,428` and `nothing to search` are different sentences.",
///      "type": "integer"
///    },
///    "hits": {
///      "description": "The ranked hits, already capped by `limit`.",
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/FightSearchHit"
///      }
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct CombatSearchFightsResult {
    ///How many fights were SEARCHED — the whole uncapped history plus the open fight. It lets a UI say `12 of 1,428` honestly instead of implying the corpus is the result set, and it is present even when `hits` is empty, because `no matches in 1,428` and `nothing to search` are different sentences.
    pub corpus: i64,
    ///The ranked hits, already capped by `limit`.
    pub hits: ::std::vec::Vec<FightSearchHit>,
}
///`src/shared/combat.ts SnapshotOpts`, and OPEN rather than closed — the one shape in this schema where an unlisted key is IGNORED instead of refused. An option is a request for MORE work, so an engine that does not know one has already given the honest answer by not doing it; refusing the whole call would turn a client that learned a new option into a client that cannot ask for anything. That is the opposite of `AlertDefinition`'s openness, which exists because a definition ROUND-TRIPS and a dropped field would rewrite the user's data — nothing here comes back, so dropping an unknown key costs a caller nothing it can lose. Every field is absent-means-the-engine's-default; there is deliberately no `combinePets`, which the owner cut in 2026-08-04 and which lives in the renderer now.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "CombatSnapshotOpts",
///  "description": "`src/shared/combat.ts SnapshotOpts`, and OPEN rather than closed — the one shape in this schema where an unlisted key is IGNORED instead of refused. An option is a request for MORE work, so an engine that does not know one has already given the honest answer by not doing it; refusing the whole call would turn a client that learned a new option into a client that cannot ask for anything. That is the opposite of `AlertDefinition`'s openness, which exists because a definition ROUND-TRIPS and a dropped field would rewrite the user's data — nothing here comes back, so dropping an unknown key costs a caller nothing it can lose. Every field is absent-means-the-engine's-default; there is deliberately no `combinePets`, which the owner cut in 2026-08-04 and which lives in the renderer now.",
///  "type": "object",
///  "properties": {
///    "maxSegments": {
///      "description": "Cap on finalized-fight summaries to serialize, newest-first. A PAYLOAD bound, never a retention one: the current encounter and the zone summary are always included, and a selected fight outside the cap still resolves fully through `selected`.",
///      "type": "integer"
///    },
///    "selectedId": {
///      "description": "Which fight or zone session to resolve `selected` against. An id this fold does not carry falls back to the default selection — the open fight, else the most recent finalized one, and NEVER the zone aggregate.",
///      "type": "string"
///    },
///    "showUnparsed": {
///      "description": "Include lines the engine could not classify. Reads the classification ring, which this fold never writes — see `fold/src/combat/state.rs` fact 2 — so it moves nothing here and is carried because the option is the app's and this op is its replacement.",
///      "type": "boolean"
///    },
///    "timeline": {
///      "description": "Include the SELECTED encounter's event timeline. Off by default because the timeline payload is heavier than the bar view.",
///      "type": "boolean"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CombatSnapshotOpts {
    ///Cap on finalized-fight summaries to serialize, newest-first. A PAYLOAD bound, never a retention one: the current encounter and the zone summary are always included, and a selected fight outside the cap still resolves fully through `selected`.
    #[serde(
        rename = "maxSegments",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub max_segments: ::std::option::Option<i64>,
    ///Which fight or zone session to resolve `selected` against. An id this fold does not carry falls back to the default selection — the open fight, else the most recent finalized one, and NEVER the zone aggregate.
    #[serde(
        rename = "selectedId",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub selected_id: ::std::option::Option<::std::string::String>,
    ///Include lines the engine could not classify. Reads the classification ring, which this fold never writes — see `fold/src/combat/state.rs` fact 2 — so it moves nothing here and is carried because the option is the app's and this op is its replacement.
    #[serde(
        rename = "showUnparsed",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub show_unparsed: ::std::option::Option<bool>,
    ///Include the SELECTED encounter's event timeline. Off by default because the timeline payload is heavier than the bar view.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub timeline: ::std::option::Option<bool>,
}
impl ::std::default::Default for CombatSnapshotOpts {
    fn default() -> Self {
        Self {
            max_segments: Default::default(),
            selected_id: Default::default(),
            show_unparsed: Default::default(),
            timeline: Default::default(),
        }
    }
}
///`CombatSnapshotParams`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "CombatSnapshotParams",
///  "type": "object",
///  "properties": {
///    "opts": {
///      "$ref": "#/$defs/CombatSnapshotOpts"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct CombatSnapshotParams {
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub opts: ::std::option::Option<CombatSnapshotOpts>,
}
impl ::std::default::Default for CombatSnapshotParams {
    fn default() -> Self {
        Self {
            opts: Default::default(),
        }
    }
}
///THE COMBAT ENGINE, ASKED (JOS-485). The whole of what `combat:snapshot` serves over IPC today — the selection, the segment list, the zone sessions, the stance and poison readouts, the roster and the hydration flag — from the fold that is running, through the same one door `module.snapshot` uses. It is NOT a `module.snapshot`: the combat engine is not in the registry (`WIRING_ORDER` does not name it), it is the post-registry subscriber, and asking for it by a module name would be asking the wrong authority. THE INSTANT IS THE ENGINE'S TO CHOOSE and the reply says which one it chose — see `CombatSnapshotResult.now`.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "CombatSnapshotRequest",
///  "description": "THE COMBAT ENGINE, ASKED (JOS-485). The whole of what `combat:snapshot` serves over IPC today — the selection, the segment list, the zone sessions, the stance and poison readouts, the roster and the hydration flag — from the fold that is running, through the same one door `module.snapshot` uses. It is NOT a `module.snapshot`: the combat engine is not in the registry (`WIRING_ORDER` does not name it), it is the post-registry subscriber, and asking for it by a module name would be asking the wrong authority. THE INSTANT IS THE ENGINE'S TO CHOOSE and the reply says which one it chose — see `CombatSnapshotResult.now`.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "combat.snapshot"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/CombatSnapshotParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct CombatSnapshotRequest {
    pub id: RequestId,
    pub op: CombatSnapshotRequestOp,
    pub params: CombatSnapshotParams,
}
///`CombatSnapshotRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "combat.snapshot"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum CombatSnapshotRequestOp {
    #[serde(rename = "combat.snapshot")]
    CombatSnapshot,
}
impl ::std::fmt::Display for CombatSnapshotRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::CombatSnapshot => f.write_str("combat.snapshot"),
        }
    }
}
impl ::std::str::FromStr for CombatSnapshotRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "combat.snapshot" => Ok(Self::CombatSnapshot),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for CombatSnapshotRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for CombatSnapshotRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for CombatSnapshotRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///The snapshot, and the instant it was taken at. TWO FIELDS RATHER THAN ONE because `now` is not recoverable from the payload and the whole answer is a function of it: a fight closes on elapsed time, `inCombat` is a freshness test, and a summary's `active` flag is the same question per row. A client that could not see which clock the engine used could not tell a stale answer from a quiet log.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "CombatSnapshotResult",
///  "description": "The snapshot, and the instant it was taken at. TWO FIELDS RATHER THAN ONE because `now` is not recoverable from the payload and the whole answer is a function of it: a fight closes on elapsed time, `inCombat` is a freshness test, and a summary's `active` flag is the same question per row. A client that could not see which clock the engine used could not tell a stale answer from a quiet log.",
///  "type": "object",
///  "required": [
///    "now",
///    "snapshot"
///  ],
///  "properties": {
///    "now": {
///      "description": "THE INSTANT THE SNAPSHOT WAS TAKEN AT, in epoch millis, and the engine chose it: the process's own wall clock once the tail is LIVE, and the fold's own `lastTs` — the log's clock — at every moment before that. A REPLAY IS NOT A MOMENT IN TIME (`engine.ts`'s hydrating gate, ported): every line of a months-old log is weeks behind the host clock, so a mid-scan answer stamped `Date.now()` would finalize whatever fight was open and hand the rest of it to a fresh encounter — MEASURED app-side, one 53,577-damage fight splitting into 43,504 + 10,073 under load. It is stated rather than assumed because it is what makes a mid-fold answer a REAL PREFIX STATE: the same bytes asked at the same `seq` give the same snapshot, which is ruling 18 law 1 for this surface.",
///      "type": "integer"
///    },
///    "snapshot": {
///      "$ref": "#/$defs/CombatState"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct CombatSnapshotResult {
    ///THE INSTANT THE SNAPSHOT WAS TAKEN AT, in epoch millis, and the engine chose it: the process's own wall clock once the tail is LIVE, and the fold's own `lastTs` — the log's clock — at every moment before that. A REPLAY IS NOT A MOMENT IN TIME (`engine.ts`'s hydrating gate, ported): every line of a months-old log is weeks behind the host clock, so a mid-scan answer stamped `Date.now()` would finalize whatever fight was open and hand the rest of it to a fresh encounter — MEASURED app-side, one 53,577-damage fight splitting into 43,504 + 10,073 under load. It is stated rather than assumed because it is what makes a mid-fold answer a REAL PREFIX STATE: the same bytes asked at the same `seq` give the same snapshot, which is ruling 18 law 1 for this surface.
    pub now: i64,
    pub snapshot: CombatState,
}
///THE COMBAT SNAPSHOT, AND THE PROTOCOL STATES NOTHING ABOUT ITS SHAPE — the `ModuleState` argument, one surface over. `src/shared/combat.ts CombatSnapshot` is ~14 fields of nested view builders (six of them, each with its own row types), it is the app's own contract with its renderer, and a meter growing a column must not be a protocol change or a `badParams` refusal. Typed-where-cheap is emphatically not cheap here: typify would lower every count in it to `f64`, which is the `Cell` defect at the scale of a whole damage meter. It is an OBJECT and always one, which is where it differs from `ModuleState` — the registry publishes both objects and arrays, `CombatEngine::snapshot` publishes an object and nothing else — so this says `object` and lowers to an ordered map of raw JSON in both languages, with every integer intact.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "CombatState",
///  "description": "THE COMBAT SNAPSHOT, AND THE PROTOCOL STATES NOTHING ABOUT ITS SHAPE — the `ModuleState` argument, one surface over. `src/shared/combat.ts CombatSnapshot` is ~14 fields of nested view builders (six of them, each with its own row types), it is the app's own contract with its renderer, and a meter growing a column must not be a protocol change or a `badParams` refusal. Typed-where-cheap is emphatically not cheap here: typify would lower every count in it to `f64`, which is the `Cell` defect at the scale of a whole damage meter. It is an OBJECT and always one, which is where it differs from `ModuleState` — the registry publishes both objects and arrays, `CombatEngine::snapshot` publishes an object and nothing else — so this says `object` and lowers to an ordered map of raw JSON in both languages, with every integer intact.",
///  "type": "object",
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(transparent)]
pub struct CombatState(pub ::serde_json::Map<::std::string::String, ::serde_json::Value>);
impl ::std::ops::Deref for CombatState {
    type Target = ::serde_json::Map<::std::string::String, ::serde_json::Value>;
    fn deref(&self) -> &::serde_json::Map<::std::string::String, ::serde_json::Value> {
        &self.0
    }
}
impl ::std::convert::From<CombatState>
    for ::serde_json::Map<::std::string::String, ::serde_json::Value>
{
    fn from(value: CombatState) -> Self {
        value.0
    }
}
impl ::std::convert::From<::serde_json::Map<::std::string::String, ::serde_json::Value>>
    for CombatState
{
    fn from(value: ::serde_json::Map<::std::string::String, ::serde_json::Value>) -> Self {
        Self(value)
    }
}
///`src/shared/classCombo.ts ComboCorrection` — a span the user re-labelled, and when they said so.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ComboCorrection",
///  "description": "`src/shared/classCombo.ts ComboCorrection` — a span the user re-labelled, and when they said so.",
///  "type": "object",
///  "required": [
///    "classes",
///    "endTs",
///    "setAt",
///    "startTs"
///  ],
///  "properties": {
///    "classes": {
///      "description": "One to three class codes, as the `/who` row spells them.",
///      "type": "array",
///      "items": {
///        "type": "string"
///      }
///    },
///    "endTs": {
///      "description": "`null` means `from startTs onward`, i.e. it applies to the open interval too. REQUIRED AND NULLABLE rather than optional, because the store's own type says `number | null` and its only writer always writes one of the two — and because an optional nullable is a field that does not survive a round trip: a generator lowers it to `Option`, drops the null on the way back out, and a fixture that carried the store's own shape stops matching itself.",
///      "type": [
///        "integer",
///        "null"
///      ]
///    },
///    "setAt": {
///      "description": "When the user set it — a later correction wins over an earlier overlapping one.",
///      "type": "integer"
///    },
///    "startTs": {
///      "type": "integer"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ComboCorrection {
    ///One to three class codes, as the `/who` row spells them.
    pub classes: ::std::vec::Vec<::std::string::String>,
    ///`null` means `from startTs onward`, i.e. it applies to the open interval too. REQUIRED AND NULLABLE rather than optional, because the store's own type says `number | null` and its only writer always writes one of the two — and because an optional nullable is a field that does not survive a round trip: a generator lowers it to `Option`, drops the null on the way back out, and a fixture that carried the store's own shape stops matching itself.
    #[serde(rename = "endTs")]
    pub end_ts: ::std::option::Option<i64>,
    ///When the user set it — a later correction wins over an earlier overlapping one.
    #[serde(rename = "setAt")]
    pub set_at: i64,
    #[serde(rename = "startTs")]
    pub start_ts: i64,
}
///`ComboDefineParams`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ComboDefineParams",
///  "type": "object",
///  "required": [
///    "corrections"
///  ],
///  "properties": {
///    "corrections": {
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/ComboCorrection"
///      }
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ComboDefineParams {
    pub corrections: ::std::vec::Vec<ComboCorrection>,
}
///THE USER'S CLASS-COMBO CORRECTIONS — the one input to the loadout model that the log cannot state. Character-scoped app-side; the engine holds whatever the app last pushed for the character it is folding.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ComboDefineRequest",
///  "description": "THE USER'S CLASS-COMBO CORRECTIONS — the one input to the loadout model that the log cannot state. Character-scoped app-side; the engine holds whatever the app last pushed for the character it is folding.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "combo.define"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/ComboDefineParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ComboDefineRequest {
    pub id: RequestId,
    pub op: ComboDefineRequestOp,
    pub params: ComboDefineParams,
}
///`ComboDefineRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "combo.define"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum ComboDefineRequestOp {
    #[serde(rename = "combo.define")]
    ComboDefine,
}
impl ::std::fmt::Display for ComboDefineRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::ComboDefine => f.write_str("combo.define"),
        }
    }
}
impl ::std::str::FromStr for ComboDefineRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "combo.define" => Ok(Self::ComboDefine),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ComboDefineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ComboDefineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ComboDefineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///ONE AXIS CHIP (`shared/conCard.ts ConCardChip`). IT CARRIES NUMBERS, NOT SENTENCES, and that is the same decision the app made: the words on the chip (`R 126 (110-144)`, `n=32`) are the mob page's own vocabulary, built by the one derivation both surfaces read, and a wire carrying finished strings would be a second copy of it that drifts the first time a word changes. This is the one place the render-ready rule bends, and it bends the way the app already bent it. ABSENT IS THE EMPTY CELL. `tag`, `benchmark` and `fit` are optional here where the app's type spells them `| null`, and the two say the same thing: a con card is a WHOLE CARD every time, so absence has no second meaning to be confused with — unlike a diff's `cells`, where absent means unchanged and null means cleared. The three travel together: a chip has all of them or none of them. `tag` is the guidance band, absent when nothing at all has been observed on this axis AND when the fit is PINNED — a posterior that slid off the end of the grid is the model saying it cannot answer, and a card that printed a band anyway would be inventing one. `benchmark` is the two landing chances behind that band at the viewer's level, plus the same pair at each end of the interval. `fit` is the estimate and its 95% interval, wide at a low `n`, which is the honest display of a thin cell rather than a reason to withhold it.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ConCardChip",
///  "description": "ONE AXIS CHIP (`shared/conCard.ts ConCardChip`). IT CARRIES NUMBERS, NOT SENTENCES, and that is the same decision the app made: the words on the chip (`R 126 (110-144)`, `n=32`) are the mob page's own vocabulary, built by the one derivation both surfaces read, and a wire carrying finished strings would be a second copy of it that drifts the first time a word changes. This is the one place the render-ready rule bends, and it bends the way the app already bent it. ABSENT IS THE EMPTY CELL. `tag`, `benchmark` and `fit` are optional here where the app's type spells them `| null`, and the two say the same thing: a con card is a WHOLE CARD every time, so absence has no second meaning to be confused with — unlike a diff's `cells`, where absent means unchanged and null means cleared. The three travel together: a chip has all of them or none of them. `tag` is the guidance band, absent when nothing at all has been observed on this axis AND when the fit is PINNED — a posterior that slid off the end of the grid is the model saying it cannot answer, and a card that printed a band anyway would be inventing one. `benchmark` is the two landing chances behind that band at the viewer's level, plus the same pair at each end of the interval. `fit` is the estimate and its 95% interval, wide at a low `n`, which is the honest display of a thin cell rather than a reason to withhold it.",
///  "type": "object",
///  "required": [
///    "axis",
///    "empirical",
///    "n",
///    "nTotal",
///    "npcOnly",
///    "pinned"
///  ],
///  "properties": {
///    "axis": {
///      "$ref": "#/$defs/ResistAxis"
///    },
///    "benchmark": {
///      "$ref": "#/$defs/ResistAxisBenchmark"
///    },
///    "empirical": {
///      "$ref": "#/$defs/ResistEmpirical"
///    },
///    "fit": {
///      "$ref": "#/$defs/ResistFit"
///    },
///    "n": {
///      "description": "OBSERVATIONS THAT COULD HAVE GONE EITHER WAY — `ResistEstimate.nInformative`, not `n`. The two are the same number on most cells and part company exactly where a proc dominates, which is where an older chip claimed eighty observations off eight.",
///      "type": "integer"
///    },
///    "nTotal": {
///      "description": "Everything the fit saw, informative or not. Printed beside `n` when they differ.",
///      "type": "integer"
///    },
///    "npcOnly": {
///      "description": "Every observation behind this axis came from a pet or another creature. The chip says so.",
///      "type": "boolean"
///    },
///    "pinned": {
///      "description": "The fit ran out of grid: no number, no band, and the raw resist rate instead.",
///      "type": "boolean"
///    },
///    "tag": {
///      "$ref": "#/$defs/ResistTag"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ConCardChip {
    pub axis: ResistAxis,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub benchmark: ::std::option::Option<ResistAxisBenchmark>,
    pub empirical: ResistEmpirical,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub fit: ::std::option::Option<ResistFit>,
    ///OBSERVATIONS THAT COULD HAVE GONE EITHER WAY — `ResistEstimate.nInformative`, not `n`. The two are the same number on most cells and part company exactly where a proc dominates, which is where an older chip claimed eighty observations off eight.
    pub n: i64,
    ///Everything the fit saw, informative or not. Printed beside `n` when they differ.
    #[serde(rename = "nTotal")]
    pub n_total: i64,
    ///Every observation behind this axis came from a pet or another creature. The chip says so.
    #[serde(rename = "npcOnly")]
    pub npc_only: bool,
    ///The fit ran out of grid: no number, no band, and the raw resist rate instead.
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub tag: ::std::option::Option<ResistTag>,
}
///ONE LIVE `/con`, AS A FINISHED CARD (boundary verdict 2). The fold used to call synchronously INTO Electron — `considerModule.setConCardHook` — and the verdict inverts that: the engine emits the card and main only opens the overlay window. CONNECTION-WIDE, carrying no `id` and no `epoch`, on the `FireMessage` precedent and for its reasons: a con belongs to the world rather than to any subscription, and it is a thing that HAPPENED once, with no window state to reconcile across a generation. LIVE ONLY, STRUCTURALLY — a historical fold reaches this nowhere, so a startup replay of a month of logs draws nothing. It is the same boundary law a fire obeys and the same one `main/conCard.ts` states as its third refusal. SELF-CONTAINED BY LAW: the overlay window has no knowledge service, no ledger and no store, so everything the card draws is in this frame and the window fetches nothing (`shared/conCard.ts ConCardPayload`, whose field set this is). TWO OF THE APP'S THREE REFUSALS ARE NOT HERE, and both absences are argued rather than overlooked. The re-open suppression is a fact about the PERSON — a card they closed within the last minute, measured on the wall clock they live on — and it is driven by a window event (`con:card-closed`) that never reaches the fold; it stays with the window that owns it. The PLAYER refusal (`conCardIsPlayer`) needs the committed mob catalog to answer, and applying only its name-shape half would refuse a card for every proper-named NPC the app draws one for today (Innoruuk, Blugurg) — a regression dressed as a port. It arrives with the knowledge surface; until then the app's own gate still stands in front of the overlay.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ConCardMessage",
///  "description": "ONE LIVE `/con`, AS A FINISHED CARD (boundary verdict 2). The fold used to call synchronously INTO Electron — `considerModule.setConCardHook` — and the verdict inverts that: the engine emits the card and main only opens the overlay window. CONNECTION-WIDE, carrying no `id` and no `epoch`, on the `FireMessage` precedent and for its reasons: a con belongs to the world rather than to any subscription, and it is a thing that HAPPENED once, with no window state to reconcile across a generation. LIVE ONLY, STRUCTURALLY — a historical fold reaches this nowhere, so a startup replay of a month of logs draws nothing. It is the same boundary law a fire obeys and the same one `main/conCard.ts` states as its third refusal. SELF-CONTAINED BY LAW: the overlay window has no knowledge service, no ledger and no store, so everything the card draws is in this frame and the window fetches nothing (`shared/conCard.ts ConCardPayload`, whose field set this is). TWO OF THE APP'S THREE REFUSALS ARE NOT HERE, and both absences are argued rather than overlooked. The re-open suppression is a fact about the PERSON — a card they closed within the last minute, measured on the wall clock they live on — and it is driven by a window event (`con:card-closed`) that never reaches the fold; it stays with the window that owns it. The PLAYER refusal (`conCardIsPlayer`) needs the committed mob catalog to answer, and applying only its name-shape half would refuse a card for every proper-named NPC the app draws one for today (Innoruuk, Blugurg) — a regression dressed as a port. It arrives with the knowledge surface; until then the app's own gate still stands in front of the overlay.",
///  "type": "object",
///  "required": [
///    "at",
///    "chips",
///    "id",
///    "kind",
///    "name",
///    "spellData"
///  ],
///  "properties": {
///    "at": {
///      "description": "When the `/con` happened, on THE LOG'S OWN CLOCK — the `ts` of the consider event, never the host's. Spelled `at` here rather than `ts` because that is what every other connection-wide frame the engine sends calls its instant (`FireMessage.at`), and one vocabulary for one concept is worth a rename in the app-side shim.",
///      "type": "integer"
///    },
///    "chips": {
///      "description": "ALWAYS FIVE, ALWAYS IN `RESIST_AXES` ORDER (magic, fire, cold, poison, disease). All five are present whatever the ledger has seen, because `we have not seen fire cast on this` and `fire is fine` are different statements and a missing chip says neither.",
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/ConCardChip"
///      }
///    },
///    "id": {
///      "description": "QUEUE IDENTITY: the canonical mob key (`shared/mobKey.ts mobKey`). A re-con REFRESHES the card on screen rather than stacking a second one, which is what the overlay's card queue keys off.",
///      "type": "string"
///    },
///    "kind": {
///      "type": "string",
///      "enum": [
///        "conCard"
///      ]
///    },
///    "level": {
///      "description": "The level the con line stated. Every con line in the real log states one; absent when this one did not.",
///      "type": "integer"
///    },
///    "name": {
///      "description": "The mob's display name as the log printed it, whitespace-collapsed and capped (`cappedName`) — a rendering guarantee, not taste: a 40 kB mob name cannot push a card off the screen.",
///      "type": "string"
///    },
///    "rare": {
///      "description": "The ` - a rare creature - ` infix was on the line. Absent rather than false when it was not, which is the shape the app's payload has.",
///      "type": "boolean"
///    },
///    "spellData": {
///      "description": "FALSE WHEN THE CLIENT'S `spells_us.txt` COULD NOT BE READ, and the card says so instead of drawing five identical `not enough data` chips with no explanation. It is false in every frame this build sends: the spell-table parse is boundary verdict 7 and has not moved engine-side yet, so this engine takes the SAME branch `mobResistProfile` takes app-side when the table is absent — five empty chips and this flag down. That is the app's own honest answer under the same condition rather than a stub, and it is named in the engine README as the gap the con-card cutover waits on.",
///      "type": "boolean"
///    },
///    "zone": {
///      "description": "The zone the player was in when they conned. Absent before the first zone line of the fold.",
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ConCardMessage {
    ///When the `/con` happened, on THE LOG'S OWN CLOCK — the `ts` of the consider event, never the host's. Spelled `at` here rather than `ts` because that is what every other connection-wide frame the engine sends calls its instant (`FireMessage.at`), and one vocabulary for one concept is worth a rename in the app-side shim.
    pub at: i64,
    ///ALWAYS FIVE, ALWAYS IN `RESIST_AXES` ORDER (magic, fire, cold, poison, disease). All five are present whatever the ledger has seen, because `we have not seen fire cast on this` and `fire is fine` are different statements and a missing chip says neither.
    pub chips: ::std::vec::Vec<ConCardChip>,
    ///QUEUE IDENTITY: the canonical mob key (`shared/mobKey.ts mobKey`). A re-con REFRESHES the card on screen rather than stacking a second one, which is what the overlay's card queue keys off.
    pub id: ::std::string::String,
    pub kind: ConCardMessageKind,
    ///The level the con line stated. Every con line in the real log states one; absent when this one did not.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub level: ::std::option::Option<i64>,
    ///The mob's display name as the log printed it, whitespace-collapsed and capped (`cappedName`) — a rendering guarantee, not taste: a 40 kB mob name cannot push a card off the screen.
    pub name: ::std::string::String,
    ///The ` - a rare creature - ` infix was on the line. Absent rather than false when it was not, which is the shape the app's payload has.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub rare: ::std::option::Option<bool>,
    ///FALSE WHEN THE CLIENT'S `spells_us.txt` COULD NOT BE READ, and the card says so instead of drawing five identical `not enough data` chips with no explanation. It is false in every frame this build sends: the spell-table parse is boundary verdict 7 and has not moved engine-side yet, so this engine takes the SAME branch `mobResistProfile` takes app-side when the table is absent — five empty chips and this flag down. That is the app's own honest answer under the same condition rather than a stub, and it is named in the engine README as the gap the con-card cutover waits on.
    #[serde(rename = "spellData")]
    pub spell_data: bool,
    ///The zone the player was in when they conned. Absent before the first zone line of the fold.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub zone: ::std::option::Option<::std::string::String>,
}
///`ConCardMessageKind`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "conCard"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum ConCardMessageKind {
    #[serde(rename = "conCard")]
    ConCard,
}
impl ::std::fmt::Display for ConCardMessageKind {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::ConCard => f.write_str("conCard"),
        }
    }
}
impl ::std::str::FromStr for ConCardMessageKind {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "conCard" => Ok(Self::ConCard),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ConCardMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ConCardMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ConCardMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///The answer to every `*.define` command, and it is deliberately the SAME shape for all five. A define is an idempotent FULL-SET REPLACE (the cutover ledger's command law: replayable, order-collapsing, hash-friendly for ruling 18's cache key), so there is nothing per-family to report back — the engine either took the set or refused the frame. `count` is how many entries it took, which is the one number a caller can check its own push against; it is absent for a family whose payload is not a list (`buffTrust`, `respawn` push one object each).
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "DefineAck",
///  "description": "The answer to every `*.define` command, and it is deliberately the SAME shape for all five. A define is an idempotent FULL-SET REPLACE (the cutover ledger's command law: replayable, order-collapsing, hash-friendly for ruling 18's cache key), so there is nothing per-family to report back — the engine either took the set or refused the frame. `count` is how many entries it took, which is the one number a caller can check its own push against; it is absent for a family whose payload is not a list (`buffTrust`, `respawn` push one object each).",
///  "type": "object",
///  "required": [
///    "applied"
///  ],
///  "properties": {
///    "applied": {
///      "type": "boolean",
///      "enum": [
///        true
///      ]
///    },
///    "count": {
///      "description": "Entries taken, for a list-shaped payload. Absent means the payload was not a list, NEVER that nothing was taken — an empty list answers `count: 0`, which is how a caller clears a family and can tell it worked.",
///      "type": "integer"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct DefineAck {
    pub applied: bool,
    ///Entries taken, for a list-shaped payload. Absent means the payload was not a list, NEVER that nothing was taken — an empty list answers `count: 0`, which is how a caller clears a family and can tell it worked.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub count: ::std::option::Option<i64>,
}
///One coalesced batch of changes to the open window. Ops apply IN ORDER. `total` is present only when it moved.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "DiffMessage",
///  "description": "One coalesced batch of changes to the open window. Ops apply IN ORDER. `total` is present only when it moved.",
///  "type": "object",
///  "required": [
///    "epoch",
///    "id",
///    "kind",
///    "ops"
///  ],
///  "properties": {
///    "epoch": {
///      "$ref": "#/$defs/Epoch"
///    },
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "kind": {
///      "type": "string",
///      "enum": [
///        "diff"
///      ]
///    },
///    "ops": {
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/DiffOp"
///      }
///    },
///    "total": {
///      "type": "integer"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct DiffMessage {
    pub epoch: Epoch,
    pub id: RequestId,
    pub kind: DiffMessageKind,
    pub ops: ::std::vec::Vec<DiffOp>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub total: ::std::option::Option<i64>,
}
///`DiffMessageKind`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "diff"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum DiffMessageKind {
    #[serde(rename = "diff")]
    Diff,
}
impl ::std::fmt::Display for DiffMessageKind {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Diff => f.write_str("diff"),
        }
    }
}
impl ::std::str::FromStr for DiffMessageKind {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "diff" => Ok(Self::Diff),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for DiffMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for DiffMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for DiffMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`DiffOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "DiffOp",
///  "oneOf": [
///    {
///      "$ref": "#/$defs/InsertOp"
///    },
///    {
///      "$ref": "#/$defs/UpdateOp"
///    },
///    {
///      "$ref": "#/$defs/DropOp"
///    }
///  ]
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum DiffOp {
    InsertOp(InsertOp),
    UpdateOp(UpdateOp),
    DropOp(DropOp),
}
impl ::std::convert::From<InsertOp> for DiffOp {
    fn from(value: InsertOp) -> Self {
        Self::InsertOp(value)
    }
}
impl ::std::convert::From<UpdateOp> for DiffOp {
    fn from(value: UpdateOp) -> Self {
        Self::UpdateOp(value)
    }
}
impl ::std::convert::From<DropOp> for DiffOp {
    fn from(value: DropOp) -> Self {
        Self::DropOp(value)
    }
}
///A row left the window. It may still exist in the view — a newest-first window pushes the oldest row out on every insert.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "DropOp",
///  "description": "A row left the window. It may still exist in the view — a newest-first window pushes the oldest row out on every insert.",
///  "type": "object",
///  "required": [
///    "key",
///    "op"
///  ],
///  "properties": {
///    "key": {
///      "$ref": "#/$defs/RowKey"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "drop"
///      ]
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct DropOp {
    pub key: RowKey,
    pub op: DropOpOp,
}
///`DropOpOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "drop"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum DropOpOp {
    #[serde(rename = "drop")]
    Drop,
}
impl ::std::fmt::Display for DropOpOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Drop => f.write_str("drop"),
        }
    }
}
impl ::std::str::FromStr for DropOpOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "drop" => Ok(Self::Drop),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for DropOpOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for DropOpOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for DropOpOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`EchoParams`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "EchoParams",
///  "type": "object",
///  "required": [
///    "text"
///  ],
///  "properties": {
///    "text": {
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct EchoParams {
    pub text: ::std::string::String,
}
///The skeleton's own op: it proves a whole message travelled the seam and came back, with no game logic anywhere.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "EchoRequest",
///  "description": "The skeleton's own op: it proves a whole message travelled the seam and came back, with no game logic anywhere.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "echo"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/EchoParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct EchoRequest {
    pub id: RequestId,
    pub op: EchoRequestOp,
    pub params: EchoParams,
}
///`EchoRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "echo"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum EchoRequestOp {
    #[serde(rename = "echo")]
    Echo,
}
impl ::std::fmt::Display for EchoRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Echo => f.write_str("echo"),
        }
    }
}
impl ::std::str::FromStr for EchoRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "echo" => Ok(Self::Echo),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for EchoRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for EchoRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for EchoRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`EchoResult`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "EchoResult",
///  "type": "object",
///  "required": [
///    "text"
///  ],
///  "properties": {
///    "text": {
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct EchoResult {
    pub text: ::std::string::String,
}
///Every message the engine sends the app. Internally tagged on `kind`.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "EngineMessage",
///  "description": "Every message the engine sends the app. Internally tagged on `kind`.",
///  "oneOf": [
///    {
///      "$ref": "#/$defs/HelloReply"
///    },
///    {
///      "$ref": "#/$defs/Reply"
///    },
///    {
///      "$ref": "#/$defs/ErrorReply"
///    },
///    {
///      "$ref": "#/$defs/ResetMessage"
///    },
///    {
///      "$ref": "#/$defs/DiffMessage"
///    },
///    {
///      "$ref": "#/$defs/EpochMessage"
///    },
///    {
///      "$ref": "#/$defs/FireMessage"
///    },
///    {
///      "$ref": "#/$defs/KnowledgeMissMessage"
///    },
///    {
///      "$ref": "#/$defs/ConCardMessage"
///    },
///    {
///      "$ref": "#/$defs/ModuleChangedMessage"
///    }
///  ]
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum EngineMessage {
    HelloReply(HelloReply),
    Reply(Reply),
    ErrorReply(ErrorReply),
    ResetMessage(ResetMessage),
    DiffMessage(DiffMessage),
    EpochMessage(EpochMessage),
    FireMessage(FireMessage),
    KnowledgeMissMessage(KnowledgeMissMessage),
    ConCardMessage(ConCardMessage),
    ModuleChangedMessage(ModuleChangedMessage),
}
impl ::std::convert::From<HelloReply> for EngineMessage {
    fn from(value: HelloReply) -> Self {
        Self::HelloReply(value)
    }
}
impl ::std::convert::From<Reply> for EngineMessage {
    fn from(value: Reply) -> Self {
        Self::Reply(value)
    }
}
impl ::std::convert::From<ErrorReply> for EngineMessage {
    fn from(value: ErrorReply) -> Self {
        Self::ErrorReply(value)
    }
}
impl ::std::convert::From<ResetMessage> for EngineMessage {
    fn from(value: ResetMessage) -> Self {
        Self::ResetMessage(value)
    }
}
impl ::std::convert::From<DiffMessage> for EngineMessage {
    fn from(value: DiffMessage) -> Self {
        Self::DiffMessage(value)
    }
}
impl ::std::convert::From<EpochMessage> for EngineMessage {
    fn from(value: EpochMessage) -> Self {
        Self::EpochMessage(value)
    }
}
impl ::std::convert::From<FireMessage> for EngineMessage {
    fn from(value: FireMessage) -> Self {
        Self::FireMessage(value)
    }
}
impl ::std::convert::From<KnowledgeMissMessage> for EngineMessage {
    fn from(value: KnowledgeMissMessage) -> Self {
        Self::KnowledgeMissMessage(value)
    }
}
impl ::std::convert::From<ConCardMessage> for EngineMessage {
    fn from(value: ConCardMessage) -> Self {
        Self::ConCardMessage(value)
    }
}
impl ::std::convert::From<ModuleChangedMessage> for EngineMessage {
    fn from(value: ModuleChangedMessage) -> Self {
        Self::ModuleChangedMessage(value)
    }
}
///The world's generation. Monotonic within one engine process. A client that sees an epoch it did not expect DROPS ALL STATE and waits for the reset — it never reconciles across a bump.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "Epoch",
///  "description": "The world's generation. Monotonic within one engine process. A client that sees an epoch it did not expect DROPS ALL STATE and waits for the reset — it never reconciles across a bump.",
///  "type": "integer"
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(transparent)]
pub struct Epoch(pub i64);
impl ::std::ops::Deref for Epoch {
    type Target = i64;
    fn deref(&self) -> &i64 {
        &self.0
    }
}
impl ::std::convert::From<Epoch> for i64 {
    fn from(value: Epoch) -> Self {
        value.0
    }
}
impl ::std::convert::From<i64> for Epoch {
    fn from(value: i64) -> Self {
        Self(value)
    }
}
impl ::std::str::FromStr for Epoch {
    type Err = <i64 as ::std::str::FromStr>::Err;
    fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
        Ok(Self(value.parse()?))
    }
}
impl ::std::convert::TryFrom<&str> for Epoch {
    type Error = <i64 as ::std::str::FromStr>::Err;
    fn try_from(value: &str) -> ::std::result::Result<Self, Self::Error> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<String> for Epoch {
    type Error = <i64 as ::std::str::FromStr>::Err;
    fn try_from(value: String) -> ::std::result::Result<Self, Self::Error> {
        value.parse()
    }
}
impl ::std::fmt::Display for Epoch {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        self.0.fmt(f)
    }
}
///CONNECTION-WIDE, and therefore the one stream message with no `id`: the world's generation belongs to the connection, not to any subscription. It announces a bump (`attach`, `restart`) or reports fold progress within the current generation (`progress`, which never changes `epoch`). After a bump every open subscription receives its own fresh reset when the fold lands.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "EpochMessage",
///  "description": "CONNECTION-WIDE, and therefore the one stream message with no `id`: the world's generation belongs to the connection, not to any subscription. It announces a bump (`attach`, `restart`) or reports fold progress within the current generation (`progress`, which never changes `epoch`). After a bump every open subscription receives its own fresh reset when the fold lands.",
///  "type": "object",
///  "required": [
///    "epoch",
///    "kind",
///    "reason"
///  ],
///  "properties": {
///    "epoch": {
///      "$ref": "#/$defs/Epoch"
///    },
///    "kind": {
///      "type": "string",
///      "enum": [
///        "epoch"
///      ]
///    },
///    "progress": {
///      "$ref": "#/$defs/FoldProgress"
///    },
///    "reason": {
///      "$ref": "#/$defs/EpochReason"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct EpochMessage {
    pub epoch: Epoch,
    pub kind: EpochMessageKind,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub progress: ::std::option::Option<FoldProgress>,
    pub reason: EpochReason,
}
///`EpochMessageKind`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "epoch"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum EpochMessageKind {
    #[serde(rename = "epoch")]
    Epoch,
}
impl ::std::fmt::Display for EpochMessageKind {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Epoch => f.write_str("epoch"),
        }
    }
}
impl ::std::str::FromStr for EpochMessageKind {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "epoch" => Ok(Self::Epoch),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for EpochMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for EpochMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for EpochMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`EpochReason`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "EpochReason",
///  "type": "string",
///  "enum": [
///    "attach",
///    "restart",
///    "progress"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum EpochReason {
    #[serde(rename = "attach")]
    Attach,
    #[serde(rename = "restart")]
    Restart,
    #[serde(rename = "progress")]
    Progress,
}
impl ::std::fmt::Display for EpochReason {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Attach => f.write_str("attach"),
            Self::Restart => f.write_str("restart"),
            Self::Progress => f.write_str("progress"),
        }
    }
}
impl ::std::str::FromStr for EpochReason {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "attach" => Ok(Self::Attach),
            "restart" => Ok(Self::Restart),
            "progress" => Ok(Self::Progress),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for EpochReason {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for EpochReason {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for EpochReason {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///A CLOSED set. Both sides generate from this artifact, so adding a member is a schema edit that regenerates both — there is no version of the app that can meet a code it has never heard of.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ErrorCode",
///  "description": "A CLOSED set. Both sides generate from this artifact, so adding a member is a schema edit that regenerates both — there is no version of the app that can meet a code it has never heard of.",
///  "type": "string",
///  "enum": [
///    "protocolMismatch",
///    "unauthorized",
///    "unknownOp",
///    "badParams",
///    "notFound",
///    "unavailable",
///    "internal"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum ErrorCode {
    #[serde(rename = "protocolMismatch")]
    ProtocolMismatch,
    #[serde(rename = "unauthorized")]
    Unauthorized,
    #[serde(rename = "unknownOp")]
    UnknownOp,
    #[serde(rename = "badParams")]
    BadParams,
    #[serde(rename = "notFound")]
    NotFound,
    #[serde(rename = "unavailable")]
    Unavailable,
    #[serde(rename = "internal")]
    Internal,
}
impl ::std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::ProtocolMismatch => f.write_str("protocolMismatch"),
            Self::Unauthorized => f.write_str("unauthorized"),
            Self::UnknownOp => f.write_str("unknownOp"),
            Self::BadParams => f.write_str("badParams"),
            Self::NotFound => f.write_str("notFound"),
            Self::Unavailable => f.write_str("unavailable"),
            Self::Internal => f.write_str("internal"),
        }
    }
}
impl ::std::str::FromStr for ErrorCode {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "protocolMismatch" => Ok(Self::ProtocolMismatch),
            "unauthorized" => Ok(Self::Unauthorized),
            "unknownOp" => Ok(Self::UnknownOp),
            "badParams" => Ok(Self::BadParams),
            "notFound" => Ok(Self::NotFound),
            "unavailable" => Ok(Self::Unavailable),
            "internal" => Ok(Self::Internal),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ErrorCode {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ErrorCode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ErrorCode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///A refused request. An error is always a reply to a request id — a failure with no request behind it closes the connection instead.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ErrorReply",
///  "description": "A refused request. An error is always a reply to a request id — a failure with no request behind it closes the connection instead.",
///  "type": "object",
///  "required": [
///    "error",
///    "id",
///    "kind",
///    "ok"
///  ],
///  "properties": {
///    "error": {
///      "$ref": "#/$defs/ProtocolError"
///    },
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "kind": {
///      "type": "string",
///      "enum": [
///        "error"
///      ]
///    },
///    "ok": {
///      "type": "boolean",
///      "enum": [
///        false
///      ]
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ErrorReply {
    pub error: ProtocolError,
    pub id: RequestId,
    pub kind: ErrorReplyKind,
    pub ok: bool,
}
///`ErrorReplyKind`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "error"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum ErrorReplyKind {
    #[serde(rename = "error")]
    Error,
}
impl ::std::fmt::Display for ErrorReplyKind {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Error => f.write_str("error"),
        }
    }
}
impl ::std::str::FromStr for ErrorReplyKind {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "error" => Ok(Self::Error),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ErrorReplyKind {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ErrorReplyKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ErrorReplyKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`FightSearchHit`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "FightSearchHit",
///  "type": "object",
///  "required": [
///    "score",
///    "summary"
///  ],
///  "properties": {
///    "score": {
///      "description": "0..1 relevance. Exact token matches outrank prefix, prefix substring, substring a bounded typo correction. A FLOAT and deliberately not a percentage: it is a ranking key the UI may show as a bar, and rounding it here would flatten ties the sort has already broken.",
///      "type": "number"
///    },
///    "summary": {
///      "$ref": "#/$defs/FightSummary"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct FightSearchHit {
    ///0..1 relevance. Exact token matches outrank prefix, prefix substring, substring a bounded typo correction. A FLOAT and deliberately not a percentage: it is a ranking key the UI may show as a bar, and rounding it here would flatten ties the sort has already broken.
    pub score: f64,
    pub summary: FightSummary,
}
///One fight, EXACTLY AS THE ENGINE SUMMARIZES IT — `src/shared/combat.ts SegmentSummary`. Open for `CombatState`'s reason and read off the same builder, so a hit and the same fight inside a snapshot are byte-identical rather than two renderings of one row.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "FightSummary",
///  "description": "One fight, EXACTLY AS THE ENGINE SUMMARIZES IT — `src/shared/combat.ts SegmentSummary`. Open for `CombatState`'s reason and read off the same builder, so a hit and the same fight inside a snapshot are byte-identical rather than two renderings of one row.",
///  "type": "object",
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(transparent)]
pub struct FightSummary(pub ::serde_json::Map<::std::string::String, ::serde_json::Value>);
impl ::std::ops::Deref for FightSummary {
    type Target = ::serde_json::Map<::std::string::String, ::serde_json::Value>;
    fn deref(&self) -> &::serde_json::Map<::std::string::String, ::serde_json::Value> {
        &self.0
    }
}
impl ::std::convert::From<FightSummary>
    for ::serde_json::Map<::std::string::String, ::serde_json::Value>
{
    fn from(value: FightSummary) -> Self {
        value.0
    }
}
impl ::std::convert::From<::serde_json::Map<::std::string::String, ::serde_json::Value>>
    for FightSummary
{
    fn from(value: ::serde_json::Map<::std::string::String, ::serde_json::Value>) -> Self {
        Self(value)
    }
}
/**WHAT THE FIRING MAY SAY OUT LOUD — the named regex captures the rule's own matcher took (JOS-103), PLUS the one auto token (JOS-353). Open by design for `Cells`' reason at full strength: the key set is the DEF'S OWN PATTERN's contract (`(?<player>…)` makes `{player}` sayable), never the protocol's, so a user writing a new group is not a protocol change.

EVERY VALUE IS ALREADY DEFANGED, AND THAT IS THIS TYPE'S WHOLE POINT. The keys come from a pattern the user may have imported from a stranger; the VALUES come out of a log line, which carries other players' chosen names and — for the chat families — text a stranger typed. So each value has crossed `sanitizeCapture`'s two controls ENGINE-SIDE before it reaches this frame: ANSI/VT sequences removed whole, every C0/C1/DEL control and the invisible + BiDi-override class deleted, CR/LF/TAB folded to one space, and the result capped at 48 characters — a NAME's worth of text, not a LINE's. At most 8 entries survive, in the pattern's own declaration order. The full threat model is `src/shared/alertCaptures.ts`; `fold::modules::alerts_captures` is its engine-side half, and the two are pinned equal by test. A CONSUMER STILL MUST NOT TREAT THESE AS TRUSTED TEXT — defanged is not the same as authored by the user.

THE `target` KEY IS THE ONE THE PATTERN DID NOT DECLARE (JOS-353, and it is a closed list of one). It holds the entity the matched event says the spell is affecting, resolved from a CLOSED TABLE of parser-extracted fields on the very event this def matched, with the parser's sentinels rendered as English ('self' → "you", 'pet' → "your pet"). It is present ONLY when the def's own speech phrase writes `{target}`, and a group the pattern declared under that name always wins — so a def that never asks carries no `captures` key at all and its frame is byte-identical to the one it sent before this field existed.

WHY IT IS MERGED HERE RATHER THAN SENT AS A SEPARATE `target` FIELD. The app must not re-derive the merge: which token the phrase wanted, who wins a name collision, and where the 8-entry bound falls are all EVALUATOR decisions, and an app that made them again would be the second evaluator this boundary exists to delete (`alertsAudioRules.ts`'s own refusal). One resolved map is what `FiredAlert.captures` has always been and what `applyCaptures` reads, so the app copies it across and substitutes.*/
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "FireCaptures",
///  "description": "WHAT THE FIRING MAY SAY OUT LOUD — the named regex captures the rule's own matcher took (JOS-103), PLUS the one auto token (JOS-353). Open by design for `Cells`' reason at full strength: the key set is the DEF'S OWN PATTERN's contract (`(?<player>…)` makes `{player}` sayable), never the protocol's, so a user writing a new group is not a protocol change.\n\nEVERY VALUE IS ALREADY DEFANGED, AND THAT IS THIS TYPE'S WHOLE POINT. The keys come from a pattern the user may have imported from a stranger; the VALUES come out of a log line, which carries other players' chosen names and — for the chat families — text a stranger typed. So each value has crossed `sanitizeCapture`'s two controls ENGINE-SIDE before it reaches this frame: ANSI/VT sequences removed whole, every C0/C1/DEL control and the invisible + BiDi-override class deleted, CR/LF/TAB folded to one space, and the result capped at 48 characters — a NAME's worth of text, not a LINE's. At most 8 entries survive, in the pattern's own declaration order. The full threat model is `src/shared/alertCaptures.ts`; `fold::modules::alerts_captures` is its engine-side half, and the two are pinned equal by test. A CONSUMER STILL MUST NOT TREAT THESE AS TRUSTED TEXT — defanged is not the same as authored by the user.\n\nTHE `target` KEY IS THE ONE THE PATTERN DID NOT DECLARE (JOS-353, and it is a closed list of one). It holds the entity the matched event says the spell is affecting, resolved from a CLOSED TABLE of parser-extracted fields on the very event this def matched, with the parser's sentinels rendered as English ('self' → \"you\", 'pet' → \"your pet\"). It is present ONLY when the def's own speech phrase writes `{target}`, and a group the pattern declared under that name always wins — so a def that never asks carries no `captures` key at all and its frame is byte-identical to the one it sent before this field existed.\n\nWHY IT IS MERGED HERE RATHER THAN SENT AS A SEPARATE `target` FIELD. The app must not re-derive the merge: which token the phrase wanted, who wins a name collision, and where the 8-entry bound falls are all EVALUATOR decisions, and an app that made them again would be the second evaluator this boundary exists to delete (`alertsAudioRules.ts`'s own refusal). One resolved map is what `FiredAlert.captures` has always been and what `applyCaptures` reads, so the app copies it across and substitutes.",
///  "type": "object",
///  "additionalProperties": {
///    "type": "string"
///  }
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(transparent)]
pub struct FireCaptures(
    pub ::std::collections::BTreeMap<::std::string::String, ::std::string::String>,
);
impl ::std::ops::Deref for FireCaptures {
    type Target = ::std::collections::BTreeMap<::std::string::String, ::std::string::String>;
    fn deref(&self) -> &::std::collections::BTreeMap<::std::string::String, ::std::string::String> {
        &self.0
    }
}
impl ::std::convert::From<FireCaptures>
    for ::std::collections::BTreeMap<::std::string::String, ::std::string::String>
{
    fn from(value: FireCaptures) -> Self {
        value.0
    }
}
impl
    ::std::convert::From<::std::collections::BTreeMap<::std::string::String, ::std::string::String>>
    for FireCaptures
{
    fn from(
        value: ::std::collections::BTreeMap<::std::string::String, ::std::string::String>,
    ) -> Self {
        Self(value)
    }
}
/**AN ALERT FIRED (owner ruling 22). The engine evaluates the user's alert definitions against LIVE events — replay must never make a sound, which is the same boundary law the app-side evaluator has always obeyed — and this is what it says when one matches. CONNECTION-WIDE, and therefore carrying NO `id`: a fire belongs to the world rather than to any subscription, which is the `EpochMessage` precedent. It carries no `epoch` either, and that is the difference from an epoch message rather than an oversight: every other stream frame describes WINDOW STATE a client has to reconcile across a generation, while a fire is a thing that happened once — there is nothing to drop and nothing to re-request, so a generation number would be a field with no reader. IT IS FULLY RESOLVED SERVER-SIDE (the conCard principle): everything the app needs in order to make the identical noise is in this frame, so no client ever has to hold the definition the fire came from.

THE FRAME GREW THREE OPTIONAL FIELDS AND THE REASON IS A REGRESSION THE OWNER MADE RELEASE-GATING (JOS-500, ruling 27: "we're not releasing without full parity"). Until them the frame had exactly four, and `alertsAudioRules.ts` said what that cost in the same breath as claiming it was survivable — "costs a firing some of its WORDS and never its existence". It was survivable only while the app still had an evaluator to fall back to. The deletion release (JOS-499) removed that fallback, which turned a degradation into the product: a `custom` phrase's `{token}`s resolved to nothing, the `spellName` speech modes fell back to the alert's own name, and an early warning's banner had no deadline to count down to. `captures`, `spell` and `dueAt` are those three losses, restored — and they are what a fire SAYS rather than whether it happened, which is why every one of them is optional and why nearly every real firing still sends none of them.

THE ABSENCES ARE THE COMMON CASE, DELIBERATELY. An alert that declares no capture group, whose phrase writes no `{target}`, whose event family names no spell and which carries no early-warning offset sends the identical four fields it always sent. Nothing is null-filled and nothing is synthesized: an absent key is the honest encoding of "this firing has nothing true to say here", and inventing a value would be worse than saying less (world-model law 1).*/
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "FireMessage",
///  "description": "AN ALERT FIRED (owner ruling 22). The engine evaluates the user's alert definitions against LIVE events — replay must never make a sound, which is the same boundary law the app-side evaluator has always obeyed — and this is what it says when one matches. CONNECTION-WIDE, and therefore carrying NO `id`: a fire belongs to the world rather than to any subscription, which is the `EpochMessage` precedent. It carries no `epoch` either, and that is the difference from an epoch message rather than an oversight: every other stream frame describes WINDOW STATE a client has to reconcile across a generation, while a fire is a thing that happened once — there is nothing to drop and nothing to re-request, so a generation number would be a field with no reader. IT IS FULLY RESOLVED SERVER-SIDE (the conCard principle): everything the app needs in order to make the identical noise is in this frame, so no client ever has to hold the definition the fire came from.\n\nTHE FRAME GREW THREE OPTIONAL FIELDS AND THE REASON IS A REGRESSION THE OWNER MADE RELEASE-GATING (JOS-500, ruling 27: \"we're not releasing without full parity\"). Until them the frame had exactly four, and `alertsAudioRules.ts` said what that cost in the same breath as claiming it was survivable — \"costs a firing some of its WORDS and never its existence\". It was survivable only while the app still had an evaluator to fall back to. The deletion release (JOS-499) removed that fallback, which turned a degradation into the product: a `custom` phrase's `{token}`s resolved to nothing, the `spellName` speech modes fell back to the alert's own name, and an early warning's banner had no deadline to count down to. `captures`, `spell` and `dueAt` are those three losses, restored — and they are what a fire SAYS rather than whether it happened, which is why every one of them is optional and why nearly every real firing still sends none of them.\n\nTHE ABSENCES ARE THE COMMON CASE, DELIBERATELY. An alert that declares no capture group, whose phrase writes no `{target}`, whose event family names no spell and which carries no early-warning offset sends the identical four fields it always sent. Nothing is null-filled and nothing is synthesized: an absent key is the honest encoding of \"this firing has nothing true to say here\", and inventing a value would be worse than saying less (world-model law 1).",
///  "type": "object",
///  "required": [
///    "at",
///    "kind",
///    "message",
///    "rule",
///    "sound"
///  ],
///  "properties": {
///    "at": {
///      "description": "When it fired, on THE LOG'S OWN CLOCK — the `ts` of the event that matched, never the host's wall clock. A fire is a statement about the log (ruling 18 law 1).",
///      "type": "integer"
///    },
///    "captures": {
///      "description": "THE WORDS THIS FIRING MAY SPEAK, or absent when it has none — see `FireCaptures` for what may be in it and what has already been done to it. Absent for the overwhelming majority of alerts, which declare no named group and ask for no `{target}`.",
///      "$ref": "#/$defs/FireCaptures"
///    },
///    "dueAt": {
///      "description": "WHEN THE THING THIS FIRING WARNS ABOUT IS DUE (ms epoch) — the countdown half of JOS-378, and present ONLY on an EARLY-WARNING firing (`AlertDef.earlyWarnSec`, JOS-216/235). IT IS THE ROW'S STATED END, not the instant the warning spoke: `at` is when the sound was made and this is what it was early FOR, so the difference between them IS the lead time the user configured. A banner counts down to it (`BannerLine.tsx` re-renders against the wall clock, so the number on screen is a render rather than a timer) and holds until the deadline instead of for the configured dwell. IT IS A HOST CLOCK WHERE `at` IS ORDINARILY THE LOG'S, and so is the `at` beside it on this one frame: an early warning has no matching event — its whole subject is a deadline that arrives WHILE THE LOG IS IDLE, which is exactly when a player is watching a mez run down — so it is delivered by the engine's heartbeat and both stamps come from that beat. The retired evaluator made the same choice in the same place, so the app receives the identical number under either. ABSENT ON EVERY ORDINARY FIRE, which is nearly all of them: a fire that IS the thing happening warns about nothing, and a deadline field on it would have no reader.",
///      "type": "integer"
///    },
///    "kind": {
///      "type": "string",
///      "enum": [
///        "fire"
///      ]
///    },
///    "message": {
///      "description": "THE TEXT THAT MATCHED — the log line the trigger fired on, which is what `FiredAlert.matchedText` has always carried and what the event log prints beside the alert's name.",
///      "type": "string"
///    },
///    "rule": {
///      "description": "The alert's LABEL — `AlertDefinition.name`. What fired, in the words the user gave it, so a log line or a banner needs nothing else to be readable.",
///      "type": "string"
///    },
///    "sound": {
///      "description": "THE KEY THE APP WOULD PLAY: `<packId>/<soundId>`, joined from the definition's `sound` reference, which is exactly how the renderer's sound cache is keyed. Resolved here rather than sent as a reference for the conCard reason — an app that had to look the definition back up to know what to play would be holding a second copy of the rule set, which is the coupling this boundary exists to delete.",
///      "type": "string"
///    },
///    "spell": {
///      "description": "THE SPELL THIS FIRING IS ABOUT, display form with the rank suffix INTACT (\"Mesmerization III\") — exactly as the log spelled it, and exactly what `FiredAlert.spell` has always carried. Rank-stripping is the SPEAKER's job (`speechTextFor` folds it out through the same rank machinery the matcher uses), not the producer's: a consumer that wants the rank must still be able to see it. IT IS THE NAME THAT ACTUALLY SATISFIED THE ALERT (JOS-84), not the event's best-effort pick — EQ's landing sentences are shared across a whole spell family (`<mob> slows down.` is five different spells), so the parser puts a guess in the event's `spell` and the truth in its `candidates`, and once a Shiftless Deeds alert is allowed to fire on a line whose `spell` field says \"Forlorn Deeds\", speaking \"Forlorn Deeds\" would be a second wrong answer wearing the first one's clothes. The name reported is the candidate the def's OWN matcher accepted, asked with the same rank fold the match used, so the two cannot split apart. ABSENT whenever the matched event names no spell: most event families, every `raw` trigger that matched a spell-less line, and every `app` signal. Never synthesized and never guessed — a spell mode with no spell falls back to the alert's own name, which is a true statement about what fired.",
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct FireMessage {
    ///When it fired, on THE LOG'S OWN CLOCK — the `ts` of the event that matched, never the host's wall clock. A fire is a statement about the log (ruling 18 law 1).
    pub at: i64,
    ///THE WORDS THIS FIRING MAY SPEAK, or absent when it has none — see `FireCaptures` for what may be in it and what has already been done to it. Absent for the overwhelming majority of alerts, which declare no named group and ask for no `{target}`.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub captures: ::std::option::Option<FireCaptures>,
    ///WHEN THE THING THIS FIRING WARNS ABOUT IS DUE (ms epoch) — the countdown half of JOS-378, and present ONLY on an EARLY-WARNING firing (`AlertDef.earlyWarnSec`, JOS-216/235). IT IS THE ROW'S STATED END, not the instant the warning spoke: `at` is when the sound was made and this is what it was early FOR, so the difference between them IS the lead time the user configured. A banner counts down to it (`BannerLine.tsx` re-renders against the wall clock, so the number on screen is a render rather than a timer) and holds until the deadline instead of for the configured dwell. IT IS A HOST CLOCK WHERE `at` IS ORDINARILY THE LOG'S, and so is the `at` beside it on this one frame: an early warning has no matching event — its whole subject is a deadline that arrives WHILE THE LOG IS IDLE, which is exactly when a player is watching a mez run down — so it is delivered by the engine's heartbeat and both stamps come from that beat. The retired evaluator made the same choice in the same place, so the app receives the identical number under either. ABSENT ON EVERY ORDINARY FIRE, which is nearly all of them: a fire that IS the thing happening warns about nothing, and a deadline field on it would have no reader.
    #[serde(
        rename = "dueAt",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub due_at: ::std::option::Option<i64>,
    pub kind: FireMessageKind,
    ///THE TEXT THAT MATCHED — the log line the trigger fired on, which is what `FiredAlert.matchedText` has always carried and what the event log prints beside the alert's name.
    pub message: ::std::string::String,
    ///The alert's LABEL — `AlertDefinition.name`. What fired, in the words the user gave it, so a log line or a banner needs nothing else to be readable.
    pub rule: ::std::string::String,
    ///THE KEY THE APP WOULD PLAY: `<packId>/<soundId>`, joined from the definition's `sound` reference, which is exactly how the renderer's sound cache is keyed. Resolved here rather than sent as a reference for the conCard reason — an app that had to look the definition back up to know what to play would be holding a second copy of the rule set, which is the coupling this boundary exists to delete.
    pub sound: ::std::string::String,
    ///THE SPELL THIS FIRING IS ABOUT, display form with the rank suffix INTACT ("Mesmerization III") — exactly as the log spelled it, and exactly what `FiredAlert.spell` has always carried. Rank-stripping is the SPEAKER's job (`speechTextFor` folds it out through the same rank machinery the matcher uses), not the producer's: a consumer that wants the rank must still be able to see it. IT IS THE NAME THAT ACTUALLY SATISFIED THE ALERT (JOS-84), not the event's best-effort pick — EQ's landing sentences are shared across a whole spell family (`<mob> slows down.` is five different spells), so the parser puts a guess in the event's `spell` and the truth in its `candidates`, and once a Shiftless Deeds alert is allowed to fire on a line whose `spell` field says "Forlorn Deeds", speaking "Forlorn Deeds" would be a second wrong answer wearing the first one's clothes. The name reported is the candidate the def's OWN matcher accepted, asked with the same rank fold the match used, so the two cannot split apart. ABSENT whenever the matched event names no spell: most event families, every `raw` trigger that matched a spell-less line, and every `app` signal. Never synthesized and never guessed — a spell mode with no spell falls back to the alert's own name, which is a true statement about what fired.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub spell: ::std::option::Option<::std::string::String>,
}
///`FireMessageKind`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "fire"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum FireMessageKind {
    #[serde(rename = "fire")]
    Fire,
}
impl ::std::fmt::Display for FireMessageKind {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Fire => f.write_str("fire"),
        }
    }
}
impl ::std::str::FromStr for FireMessageKind {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "fire" => Ok(Self::Fire),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for FireMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for FireMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for FireMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///What the loading UI reads. Present while a fold is running and on the bump that starts one.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "FoldProgress",
///  "description": "What the loading UI reads. Present while a fold is running and on the bump that starts one.",
///  "type": "object",
///  "required": [
///    "events",
///    "logSize",
///    "offset",
///    "pct"
///  ],
///  "properties": {
///    "events": {
///      "type": "integer"
///    },
///    "logSize": {
///      "description": "`pct`'s DENOMINATOR - how big the fold currently believes the log to be, which is the larger of the file's size at open and the amount actually read. EverQuest is still appending while the fold runs, so a denominator fixed at open would let a live tail report more than 100%. It can therefore GROW between two frames, which is honest rather than awkward: a client deriving a completion estimate must re-read it every frame instead of caching the first one it saw.",
///      "type": "integer"
///    },
///    "offset": {
///      "description": "THE MARK: the end of the last complete line this fold has folded, and `pct`'s own numerator. It is the SAME coordinate `HealthMark.offset` reports and the same one cache law 3 names (state is addressed by log identity and byte offset), which is why it carries that field's name rather than a new one - it is a fact about the LOG, not about the wire, and nothing here is a framing concern. It rides the frame because `pct` cannot be turned back into it: a client holding only a percentage can say `62%` and can never say `128 MB of 205 MB`, and the second sentence is the one that tells a person whether to wait or to go and make coffee.",
///      "type": "integer"
///    },
///    "pct": {
///      "description": "How far the fold has got, 0 to 100, FRACTIONAL. The engine emits the number it actually measured and does not pre-round it: rounding is a display decision and belongs to whoever is drawing the bar. That is not in tension with the renderer-never-munges rule - that rule is about DOMAIN data (no client-side filtering, sorting or aggregation of the world), and formatting a progress readout for the pixel it lands on is not domain work. A NOTE FOR WORKED EXAMPLES: Rust serializes an f64 whole value as X.0, so a fixture carrying `62` would come back `62.0` and stop being byte-verbatim across the two languages. Examples therefore use a genuinely fractional value (62.4), which round-trips identically in both.",
///      "type": "number"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct FoldProgress {
    pub events: i64,
    ///`pct`'s DENOMINATOR - how big the fold currently believes the log to be, which is the larger of the file's size at open and the amount actually read. EverQuest is still appending while the fold runs, so a denominator fixed at open would let a live tail report more than 100%. It can therefore GROW between two frames, which is honest rather than awkward: a client deriving a completion estimate must re-read it every frame instead of caching the first one it saw.
    #[serde(rename = "logSize")]
    pub log_size: i64,
    ///THE MARK: the end of the last complete line this fold has folded, and `pct`'s own numerator. It is the SAME coordinate `HealthMark.offset` reports and the same one cache law 3 names (state is addressed by log identity and byte offset), which is why it carries that field's name rather than a new one - it is a fact about the LOG, not about the wire, and nothing here is a framing concern. It rides the frame because `pct` cannot be turned back into it: a client holding only a percentage can say `62%` and can never say `128 MB of 205 MB`, and the second sentence is the one that tells a person whether to wait or to go and make coffee.
    pub offset: i64,
    ///How far the fold has got, 0 to 100, FRACTIONAL. The engine emits the number it actually measured and does not pre-round it: rounding is a display decision and belongs to whoever is drawing the bar. That is not in tension with the renderer-never-munges rule - that rule is about DOMAIN data (no client-side filtering, sorting or aggregation of the world), and formatting a progress readout for the pixel it lands on is not domain work. A NOTE FOR WORKED EXAMPLES: Rust serializes an f64 whole value as X.0, so a fixture carrying `62` would come back `62.0` and stop being byte-verbatim across the two languages. Examples therefore use a genuinely fractional value (62.4), which round-trips identically in both.
    pub pct: f64,
}
///What the engine's ingest is doing, and where it has got to. THE LAST FOUR FIELDS ARE OPTIONAL AND THAT IS NOT A CONVENIENCE: a health answer given before any attach honestly has no mark, no event count, no log timestamp and no file to stat, and a zero would be a measurement nobody took. Absent means `this engine has not folded anything`; present means the numbers are the fold's own.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "HealthResult",
///  "description": "What the engine's ingest is doing, and where it has got to. THE LAST FOUR FIELDS ARE OPTIONAL AND THAT IS NOT A CONVENIENCE: a health answer given before any attach honestly has no mark, no event count, no log timestamp and no file to stat, and a zero would be a measurement nobody took. Absent means `this engine has not folded anything`; present means the numbers are the fold's own.",
///  "type": "object",
///  "required": [
///    "epoch",
///    "status",
///    "uptimeMs"
///  ],
///  "properties": {
///    "epoch": {
///      "$ref": "#/$defs/Epoch"
///    },
///    "events": {
///      "description": "Events folded in this generation. Counts EVENTS, not lines — a log line the parser declines is not one.",
///      "type": "integer"
///    },
///    "lastEventTs": {
///      "description": "The `ts` of the last event folded — THE LOG'S OWN CLOCK, never the host's. Absent when nothing folded, or when no event so far carried a stamp the parser could read.",
///      "type": "integer"
///    },
///    "logMtimeMs": {
///      "description": "THE LOG FILE'S LAST-MODIFIED TIME, in epoch milliseconds, as the engine stats it (owner ruling 21: the server owns log-file facts — `the server should be the one reading the log file, rather than the app reaching in… reported so the app can use it to display and choose the correct character on launch`). A FILESYSTEM FACT, NOT A FOLD FACT, and the distinction is ruling 18's: it never enters fold state, it is not addressed by (log identity, byte offset), and it is re-stated fresh on every health answer rather than remembered — a remembered mtime is a cache of something the filesystem already holds. Absent before any attach (no file to stat), and absent when the stat fails, which is honest: a log that was renamed out from under the engine has no answer, and 0 would claim 1970. Truncated to whole milliseconds, so it equals `Math.floor(statSync(log).mtimeMs)`.",
///      "type": "integer"
///    },
///    "mark": {
///      "$ref": "#/$defs/LogMark"
///    },
///    "status": {
///      "type": "string",
///      "enum": [
///        "starting",
///        "attaching",
///        "folding",
///        "live",
///        "idle"
///      ]
///    },
///    "uptimeMs": {
///      "type": "integer"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct HealthResult {
    pub epoch: Epoch,
    ///Events folded in this generation. Counts EVENTS, not lines — a log line the parser declines is not one.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub events: ::std::option::Option<i64>,
    ///The `ts` of the last event folded — THE LOG'S OWN CLOCK, never the host's. Absent when nothing folded, or when no event so far carried a stamp the parser could read.
    #[serde(
        rename = "lastEventTs",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub last_event_ts: ::std::option::Option<i64>,
    ///THE LOG FILE'S LAST-MODIFIED TIME, in epoch milliseconds, as the engine stats it (owner ruling 21: the server owns log-file facts — `the server should be the one reading the log file, rather than the app reaching in… reported so the app can use it to display and choose the correct character on launch`). A FILESYSTEM FACT, NOT A FOLD FACT, and the distinction is ruling 18's: it never enters fold state, it is not addressed by (log identity, byte offset), and it is re-stated fresh on every health answer rather than remembered — a remembered mtime is a cache of something the filesystem already holds. Absent before any attach (no file to stat), and absent when the stat fails, which is honest: a log that was renamed out from under the engine has no answer, and 0 would claim 1970. Truncated to whole milliseconds, so it equals `Math.floor(statSync(log).mtimeMs)`.
    #[serde(
        rename = "logMtimeMs",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub log_mtime_ms: ::std::option::Option<i64>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub mark: ::std::option::Option<LogMark>,
    pub status: HealthResultStatus,
    #[serde(rename = "uptimeMs")]
    pub uptime_ms: i64,
}
///`HealthResultStatus`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "starting",
///    "attaching",
///    "folding",
///    "live",
///    "idle"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum HealthResultStatus {
    #[serde(rename = "starting")]
    Starting,
    #[serde(rename = "attaching")]
    Attaching,
    #[serde(rename = "folding")]
    Folding,
    #[serde(rename = "live")]
    Live,
    #[serde(rename = "idle")]
    Idle,
}
impl ::std::fmt::Display for HealthResultStatus {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Starting => f.write_str("starting"),
            Self::Attaching => f.write_str("attaching"),
            Self::Folding => f.write_str("folding"),
            Self::Live => f.write_str("live"),
            Self::Idle => f.write_str("idle"),
        }
    }
}
impl ::std::str::FromStr for HealthResultStatus {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "starting" => Ok(Self::Starting),
            "attaching" => Ok(Self::Attaching),
            "folding" => Ok(Self::Folding),
            "live" => Ok(Self::Live),
            "idle" => Ok(Self::Idle),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for HealthResultStatus {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for HealthResultStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for HealthResultStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///The FIRST message on a connection, always. The engine answers with HelloReply or closes the connection; nothing else may precede it.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "Hello",
///  "description": "The FIRST message on a connection, always. The engine answers with HelloReply or closes the connection; nothing else may precede it.",
///  "type": "object",
///  "required": [
///    "op",
///    "protocolVersion",
///    "token"
///  ],
///  "properties": {
///    "op": {
///      "type": "string",
///      "enum": [
///        "hello"
///      ]
///    },
///    "protocolVersion": {
///      "description": "The version the CLIENT was generated against. A mismatch is fatal by ruling: both sides log and the connection closes. Version skew is a build error, not a runtime state to recover from.",
///      "type": "integer"
///    },
///    "token": {
///      "$ref": "#/$defs/Token"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Hello {
    pub op: HelloOp,
    ///The version the CLIENT was generated against. A mismatch is fatal by ruling: both sides log and the connection closes. Version skew is a build error, not a runtime state to recover from.
    #[serde(rename = "protocolVersion")]
    pub protocol_version: i64,
    pub token: Token,
}
///`HelloOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "hello"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum HelloOp {
    #[serde(rename = "hello")]
    Hello,
}
impl ::std::fmt::Display for HelloOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Hello => f.write_str("hello"),
        }
    }
}
impl ::std::str::FromStr for HelloOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "hello" => Ok(Self::Hello),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for HelloOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for HelloOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for HelloOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///The handshake answer. `ok: false` is a courtesy sent immediately before the engine closes the connection — a client must treat a closed connection with no reply as the same outcome.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "HelloReply",
///  "description": "The handshake answer. `ok: false` is a courtesy sent immediately before the engine closes the connection — a client must treat a closed connection with no reply as the same outcome.",
///  "type": "object",
///  "required": [
///    "engineVersion",
///    "kind",
///    "ok",
///    "protocolVersion"
///  ],
///  "properties": {
///    "engineVersion": {
///      "description": "The engine binary's own version (informational; it is NOT the compatibility check).",
///      "type": "string"
///    },
///    "kind": {
///      "type": "string",
///      "enum": [
///        "hello"
///      ]
///    },
///    "ok": {
///      "type": "boolean"
///    },
///    "protocolVersion": {
///      "description": "The version the ENGINE was generated against.",
///      "type": "integer"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct HelloReply {
    ///The engine binary's own version (informational; it is NOT the compatibility check).
    #[serde(rename = "engineVersion")]
    pub engine_version: ::std::string::String,
    pub kind: HelloReplyKind,
    pub ok: bool,
    ///The version the ENGINE was generated against.
    #[serde(rename = "protocolVersion")]
    pub protocol_version: i64,
}
///`HelloReplyKind`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "hello"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum HelloReplyKind {
    #[serde(rename = "hello")]
    Hello,
}
impl ::std::fmt::Display for HelloReplyKind {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Hello => f.write_str("hello"),
        }
    }
}
impl ::std::str::FromStr for HelloReplyKind {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "hello" => Ok(Self::Hello),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for HelloReplyKind {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for HelloReplyKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for HelloReplyKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///A row entered the window. EXACTLY ONE of `before`/`after` is present and names an anchor row already in the window; neither present means the window was empty. That constraint is not expressible here without an if/then the Rust generator cannot read, so it is enforced in code and pinned by test.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "InsertOp",
///  "description": "A row entered the window. EXACTLY ONE of `before`/`after` is present and names an anchor row already in the window; neither present means the window was empty. That constraint is not expressible here without an if/then the Rust generator cannot read, so it is enforced in code and pinned by test.",
///  "type": "object",
///  "required": [
///    "op",
///    "row"
///  ],
///  "properties": {
///    "after": {
///      "$ref": "#/$defs/RowKey"
///    },
///    "before": {
///      "$ref": "#/$defs/RowKey"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "insert"
///      ]
///    },
///    "row": {
///      "$ref": "#/$defs/Row"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct InsertOp {
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub after: ::std::option::Option<RowKey>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub before: ::std::option::Option<RowKey>,
    pub op: InsertOpOp,
    pub row: Row,
}
///`InsertOpOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "insert"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum InsertOpOp {
    #[serde(rename = "insert")]
    Insert,
}
impl ::std::fmt::Display for InsertOpOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Insert => f.write_str("insert"),
        }
    }
}
impl ::std::str::FromStr for InsertOpOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "insert" => Ok(Self::Insert),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for InsertOpOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for InsertOpOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for InsertOpOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`entry` is what the app learned. A record carrying `notFound: true` is a real negative and is a perfectly good answer — it is the app saying `I looked and the wiki has no page`, which stops the engine ever announcing that name again. That is the ONE thing this engine cannot conclude for itself, having no network to look with.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "KnowledgeDefineParams",
///  "description": "`entry` is what the app learned. A record carrying `notFound: true` is a real negative and is a perfectly good answer — it is the app saying `I looked and the wiki has no page`, which stops the engine ever announcing that name again. That is the ONE thing this engine cannot conclude for itself, having no network to look with.",
///  "type": "object",
///  "required": [
///    "domain",
///    "entry",
///    "name"
///  ],
///  "properties": {
///    "domain": {
///      "$ref": "#/$defs/KnowledgePushDomain"
///    },
///    "entry": {
///      "$ref": "#/$defs/KnowledgeRecord"
///    },
///    "name": {
///      "description": "The name the miss frame carried, echoed back unchanged. The engine folds it into the domain's own key on the way in, so the app never has to know how an item key differs from a mob key.",
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeDefineParams {
    pub domain: KnowledgePushDomain,
    pub entry: KnowledgeRecord,
    ///The name the miss frame carried, echoed back unchanged. The engine folds it into the domain's own key on the way in, so the app never has to know how an item key differs from a mob key.
    pub name: ::std::string::String,
}
/**THE ANSWER TO A MISS, PUSHED BACK (boundary verdict 5). The engine ships without a network stack; the app owns the wiki fetch and with it the scrape etiquette that is a LAW here (a serialized queue, 150 ms spacing, and the server's own `Retry-After` honoured across the whole queue). So the engine says `knowledgeMiss`, the app fetches, and this is how the answer arrives.

IT IS NOT A FULL-SET REPLACE, and that is stated rather than slipped in. The other five `*.define` commands carry a WHOLE set because they carry user PREFERENCES — small, bounded, owned by a store that can restate them. This set is the WIKI: unbounded, not the app's to own, learned one entry at a time in answer to one miss at a time. A full-set replace would mean restating 11,288 item records on every push. What it KEEPS of the command law is the part the law is for: it is IDEMPOTENT and ORDER-INDEPENDENT per key — pushing the same entry twice leaves what pushing it once leaves, and two names commute — so a crash-respawn is still trivial (the overlay is empty, every name misses again, the app answers again) and the input is still hash-friendly for ruling 18's cache key, as the set of (key, entry) pairs. What it gives up is DELETE, which nothing asks for.*/
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "KnowledgeDefineRequest",
///  "description": "THE ANSWER TO A MISS, PUSHED BACK (boundary verdict 5). The engine ships without a network stack; the app owns the wiki fetch and with it the scrape etiquette that is a LAW here (a serialized queue, 150 ms spacing, and the server's own `Retry-After` honoured across the whole queue). So the engine says `knowledgeMiss`, the app fetches, and this is how the answer arrives.\n\nIT IS NOT A FULL-SET REPLACE, and that is stated rather than slipped in. The other five `*.define` commands carry a WHOLE set because they carry user PREFERENCES — small, bounded, owned by a store that can restate them. This set is the WIKI: unbounded, not the app's to own, learned one entry at a time in answer to one miss at a time. A full-set replace would mean restating 11,288 item records on every push. What it KEEPS of the command law is the part the law is for: it is IDEMPOTENT and ORDER-INDEPENDENT per key — pushing the same entry twice leaves what pushing it once leaves, and two names commute — so a crash-respawn is still trivial (the overlay is empty, every name misses again, the app answers again) and the input is still hash-friendly for ruling 18's cache key, as the set of (key, entry) pairs. What it gives up is DELETE, which nothing asks for.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "knowledge.define"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/KnowledgeDefineParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeDefineRequest {
    pub id: RequestId,
    pub op: KnowledgeDefineRequestOp,
    pub params: KnowledgeDefineParams,
}
///`KnowledgeDefineRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "knowledge.define"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum KnowledgeDefineRequestOp {
    #[serde(rename = "knowledge.define")]
    KnowledgeDefine,
}
impl ::std::fmt::Display for KnowledgeDefineRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::KnowledgeDefine => f.write_str("knowledge.define"),
        }
    }
}
impl ::std::str::FromStr for KnowledgeDefineRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "knowledge.define" => Ok(Self::KnowledgeDefine),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for KnowledgeDefineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for KnowledgeDefineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for KnowledgeDefineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///WHICH COMMITTED CORPUS AN ANSWER CAME OUT OF. A CLOSED set, like every other enum here: both sides generate from this artifact, so a corpus this build has never heard of cannot arrive. `item` and `mob` are the two the engine can be pushed answers for; `spell` is the parser's own effective catalog, which has no live fallback anywhere in this app, and `quest` is the scraped quest catalog, which is reachable only through search (a quest is not a card this app draws on its own).
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "KnowledgeDomain",
///  "description": "WHICH COMMITTED CORPUS AN ANSWER CAME OUT OF. A CLOSED set, like every other enum here: both sides generate from this artifact, so a corpus this build has never heard of cannot arrive. `item` and `mob` are the two the engine can be pushed answers for; `spell` is the parser's own effective catalog, which has no live fallback anywhere in this app, and `quest` is the scraped quest catalog, which is reachable only through search (a quest is not a card this app draws on its own).",
///  "type": "string",
///  "enum": [
///    "item",
///    "mob",
///    "spell",
///    "quest"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum KnowledgeDomain {
    #[serde(rename = "item")]
    Item,
    #[serde(rename = "mob")]
    Mob,
    #[serde(rename = "spell")]
    Spell,
    #[serde(rename = "quest")]
    Quest,
}
impl ::std::fmt::Display for KnowledgeDomain {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Item => f.write_str("item"),
            Self::Mob => f.write_str("mob"),
            Self::Spell => f.write_str("spell"),
            Self::Quest => f.write_str("quest"),
        }
    }
}
impl ::std::str::FromStr for KnowledgeDomain {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "item" => Ok(Self::Item),
            "mob" => Ok(Self::Mob),
            "spell" => Ok(Self::Spell),
            "quest" => Ok(Self::Quest),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for KnowledgeDomain {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for KnowledgeDomain {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for KnowledgeDomain {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///One search hit: what it is, what it is called, and the wiki page that names it when a corpus states one. It is deliberately NOT a card — a hit is the handle a caller passes back to `knowledge.item`/`mob`/`spell`, and serving thirty-field records for twenty hits would be a type-ahead paying a card's payload per keystroke.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "KnowledgeHit",
///  "description": "One search hit: what it is, what it is called, and the wiki page that names it when a corpus states one. It is deliberately NOT a card — a hit is the handle a caller passes back to `knowledge.item`/`mob`/`spell`, and serving thirty-field records for twenty hits would be a type-ahead paying a card's payload per keystroke.",
///  "type": "object",
///  "required": [
///    "domain",
///    "name"
///  ],
///  "properties": {
///    "domain": {
///      "$ref": "#/$defs/KnowledgeDomain"
///    },
///    "name": {
///      "type": "string"
///    },
///    "page": {
///      "description": "The wiki page title, when the corpus states one. Absent for a spell (the catalog is a scrape of the game's own table, not of pages).",
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeHit {
    pub domain: KnowledgeDomain,
    pub name: ::std::string::String,
    ///The wiki page title, when the corpus states one. Absent for a spell (the catalog is a scrape of the game's own table, not of pages).
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub page: ::std::option::Option<::std::string::String>,
}
///"What's this lore/quest item for" — `main/itemLookup.ts lookupItem`, served from the committed corpus the engine now holds (boundary verdict 5; ~12 MB leaves main's heap with this surface and the renderer's bundled copies follow). IT NEVER FAILS AND NEVER ANSWERS `notFound`: a name no corpus holds still comes back carrying every LOCAL association — the Plane of Sky dataset's quest uses and the scraped quest catalog's, which are facts a missing wiki page does not unmake — with `found: false` beside it. The engine also announces that name once on the stream (`knowledgeMiss`), because the fetch is the app's.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "KnowledgeItemRequest",
///  "description": "\"What's this lore/quest item for\" — `main/itemLookup.ts lookupItem`, served from the committed corpus the engine now holds (boundary verdict 5; ~12 MB leaves main's heap with this surface and the renderer's bundled copies follow). IT NEVER FAILS AND NEVER ANSWERS `notFound`: a name no corpus holds still comes back carrying every LOCAL association — the Plane of Sky dataset's quest uses and the scraped quest catalog's, which are facts a missing wiki page does not unmake — with `found: false` beside it. The engine also announces that name once on the stream (`knowledgeMiss`), because the fetch is the app's.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "knowledge.item"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/KnowledgeNameParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeItemRequest {
    pub id: RequestId,
    pub op: KnowledgeItemRequestOp,
    pub params: KnowledgeNameParams,
}
///`KnowledgeItemRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "knowledge.item"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum KnowledgeItemRequestOp {
    #[serde(rename = "knowledge.item")]
    KnowledgeItem,
}
impl ::std::fmt::Display for KnowledgeItemRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::KnowledgeItem => f.write_str("knowledge.item"),
        }
    }
}
impl ::std::str::FromStr for KnowledgeItemRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "knowledge.item" => Ok(Self::KnowledgeItem),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for KnowledgeItemRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for KnowledgeItemRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for KnowledgeItemRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
/**THE ENGINE COULD NOT ANSWER A NAME, AND THE APP OWNS THE NETWORK (boundary verdict 5: "The wiki FETCH stays app-side in v1 — app fetches on an engine miss-event and pushes the result in — so the engine ships without a network stack. Scrape throttles preserved."). This is that miss-event, and the answer comes back as a `knowledge.define` command.

CONNECTION-WIDE, AND THEREFORE CARRYING NO `id` — the `EpochMessage`/`FireMessage` precedent. A miss belongs to the PROCESS rather than to any subscription or any request: the same name is missing whether it was asked for by a `knowledge.item` op on one connection or by the fold's own probe on the ingest thread, and every window on this app would want the same fetch made once.

IT CARRIES NO `epoch` EITHER, and that is the `FireMessage` argument exactly. Every frame that carries a generation describes WINDOW STATE a client has to reconcile across a bump; this describes the CORPUS, which is committed data plus an overlay that survives an attach (a character switch is not the app withdrawing what it fetched). There is nothing to drop and nothing to re-request, so a generation number would be a field with no reader.

EACH NAME IS ANNOUNCED AT MOST ONCE PER PROCESS. A stacked loot burst probes one name many times and a `/con` ring re-cons the same mob three times in five seconds; asking the app to fetch each of those would be the engine breaking the etiquette law on the app's behalf. A `knowledge.define` for the name makes every later lookup a hit, so nothing has to un-remember anything.*/
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "KnowledgeMissMessage",
///  "description": "THE ENGINE COULD NOT ANSWER A NAME, AND THE APP OWNS THE NETWORK (boundary verdict 5: \"The wiki FETCH stays app-side in v1 — app fetches on an engine miss-event and pushes the result in — so the engine ships without a network stack. Scrape throttles preserved.\"). This is that miss-event, and the answer comes back as a `knowledge.define` command.\n\nCONNECTION-WIDE, AND THEREFORE CARRYING NO `id` — the `EpochMessage`/`FireMessage` precedent. A miss belongs to the PROCESS rather than to any subscription or any request: the same name is missing whether it was asked for by a `knowledge.item` op on one connection or by the fold's own probe on the ingest thread, and every window on this app would want the same fetch made once.\n\nIT CARRIES NO `epoch` EITHER, and that is the `FireMessage` argument exactly. Every frame that carries a generation describes WINDOW STATE a client has to reconcile across a bump; this describes the CORPUS, which is committed data plus an overlay that survives an attach (a character switch is not the app withdrawing what it fetched). There is nothing to drop and nothing to re-request, so a generation number would be a field with no reader.\n\nEACH NAME IS ANNOUNCED AT MOST ONCE PER PROCESS. A stacked loot burst probes one name many times and a `/con` ring re-cons the same mob three times in five seconds; asking the app to fetch each of those would be the engine breaking the etiquette law on the app's behalf. A `knowledge.define` for the name makes every later lookup a hit, so nothing has to un-remember anything.",
///  "type": "object",
///  "required": [
///    "domain",
///    "kind",
///    "name"
///  ],
///  "properties": {
///    "domain": {
///      "$ref": "#/$defs/KnowledgePushDomain"
///    },
///    "kind": {
///      "type": "string",
///      "enum": [
///        "knowledgeMiss"
///      ]
///    },
///    "name": {
///      "description": "The name to look up, in the spelling the FETCH should use — the display name for an item (what `resolvePage(display)` searches for), and for a mob the CANONICAL spelling the raid roster states, because that is the spelling the wiki and the committed catalog use. Never a folded key: a key is a join handle and the wiki has no page for one.",
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeMissMessage {
    pub domain: KnowledgePushDomain,
    pub kind: KnowledgeMissMessageKind,
    ///The name to look up, in the spelling the FETCH should use — the display name for an item (what `resolvePage(display)` searches for), and for a mob the CANONICAL spelling the raid roster states, because that is the spelling the wiki and the committed catalog use. Never a folded key: a key is a join handle and the wiki has no page for one.
    pub name: ::std::string::String,
}
///`KnowledgeMissMessageKind`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "knowledgeMiss"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum KnowledgeMissMessageKind {
    #[serde(rename = "knowledgeMiss")]
    KnowledgeMiss,
}
impl ::std::fmt::Display for KnowledgeMissMessageKind {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::KnowledgeMiss => f.write_str("knowledgeMiss"),
        }
    }
}
impl ::std::str::FromStr for KnowledgeMissMessageKind {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "knowledgeMiss" => Ok(Self::KnowledgeMiss),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for KnowledgeMissMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for KnowledgeMissMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for KnowledgeMissMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///"What does this thing drop" — `main/mobLookup.ts lookupMob`. FOUR SOURCES JOINED SERVER-SIDE, which is the whole reason this op is worth having rather than shipping the catalog to the renderer: the committed drop table, YOUR OWN LOOT HISTORY (read off the fold's own index — the mutual dependency verdict 5 names dissolves in-process), the quest catalog's `relatedNpcs`, and the era evidence each drop's ITEM page carries. The name is answered under every spelling the raid roster states for that creature (`mobAliases.ts`) and the record still reads back the spelling the CALLER used.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "KnowledgeMobRequest",
///  "description": "\"What does this thing drop\" — `main/mobLookup.ts lookupMob`. FOUR SOURCES JOINED SERVER-SIDE, which is the whole reason this op is worth having rather than shipping the catalog to the renderer: the committed drop table, YOUR OWN LOOT HISTORY (read off the fold's own index — the mutual dependency verdict 5 names dissolves in-process), the quest catalog's `relatedNpcs`, and the era evidence each drop's ITEM page carries. The name is answered under every spelling the raid roster states for that creature (`mobAliases.ts`) and the record still reads back the spelling the CALLER used.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "knowledge.mob"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/KnowledgeNameParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeMobRequest {
    pub id: RequestId,
    pub op: KnowledgeMobRequestOp,
    pub params: KnowledgeNameParams,
}
///`KnowledgeMobRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "knowledge.mob"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum KnowledgeMobRequestOp {
    #[serde(rename = "knowledge.mob")]
    KnowledgeMob,
}
impl ::std::fmt::Display for KnowledgeMobRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::KnowledgeMob => f.write_str("knowledge.mob"),
        }
    }
}
impl ::std::str::FromStr for KnowledgeMobRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "knowledge.mob" => Ok(Self::KnowledgeMob),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for KnowledgeMobRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for KnowledgeMobRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for KnowledgeMobRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///ONE NAME, as the asker spells it. Never a canonical key: the engine folds the name itself (each corpus has its own fold — the ` +N` item-level suffix, the mob-name quote glyphs and copy numbers), and a caller that pre-folded would be a second opinion about a join key.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "KnowledgeNameParams",
///  "description": "ONE NAME, as the asker spells it. Never a canonical key: the engine folds the name itself (each corpus has its own fold — the ` +N` item-level suffix, the mob-name quote glyphs and copy numbers), and a caller that pre-folded would be a second opinion about a join key.",
///  "type": "object",
///  "required": [
///    "name"
///  ],
///  "properties": {
///    "name": {
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeNameParams {
    pub name: ::std::string::String,
}
///THE TWO CORPORA THE APP CAN ANSWER FOR — a strictly smaller set than `KnowledgeDomain`, and the difference is where the FETCHER lives (boundary verdict 5). `itemLookup`/`mobLookup` resolve a wiki page on demand app-side, so a name those corpora lack is a question somebody can go and answer. The spell catalog has no live fallback at all — it is regenerated by `npm run scrape:spells` and committed — so a spell the DB lacks is not a miss, and a `knowledge.define` naming `spell` would be asking the engine to take an answer nothing produced. Refused by SHAPE rather than by a runtime check.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "KnowledgePushDomain",
///  "description": "THE TWO CORPORA THE APP CAN ANSWER FOR — a strictly smaller set than `KnowledgeDomain`, and the difference is where the FETCHER lives (boundary verdict 5). `itemLookup`/`mobLookup` resolve a wiki page on demand app-side, so a name those corpora lack is a question somebody can go and answer. The spell catalog has no live fallback at all — it is regenerated by `npm run scrape:spells` and committed — so a spell the DB lacks is not a miss, and a `knowledge.define` naming `spell` would be asking the engine to take an answer nothing produced. Refused by SHAPE rather than by a runtime check.",
///  "type": "string",
///  "enum": [
///    "item",
///    "mob"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum KnowledgePushDomain {
    #[serde(rename = "item")]
    Item,
    #[serde(rename = "mob")]
    Mob,
}
impl ::std::fmt::Display for KnowledgePushDomain {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Item => f.write_str("item"),
            Self::Mob => f.write_str("mob"),
        }
    }
}
impl ::std::str::FromStr for KnowledgePushDomain {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "item" => Ok(Self::Item),
            "mob" => Ok(Self::Mob),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for KnowledgePushDomain {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for KnowledgePushDomain {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for KnowledgePushDomain {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///ONE KNOWLEDGE CARD, AND THE PROTOCOL STATES NOTHING ABOUT ITS SHAPE — the `ModuleState`/`AlertDefinition` argument a third time, and here it is the strongest of the three. The field set belongs to the SCRAPER: `itemsDb.ts` says a stored record is *literally* the `ItemKnowledge` fields `parseItemWikitext` produces, no projection and no renaming, and that type carries a nested in-game stat block, recipe lists, craft trees with ingredient lines, drop sources and era banners — around thirty fields that grow whenever the wiki grows a field worth scraping. A typed protocol mirror of that would be a translation layer whose only job is to LOSE a field the day the scraper gains one, and it would do it silently, because a knowledge card degrades quietly rather than failing. Worse, a record ROUND-TRIPS: `knowledge.define` pushes one in and every later `knowledge.item` hands it back, so a generator that dropped an unlisted field would rewrite the answer the app just fetched. The engine reads the handful of fields it needs with its own reader (`knowledge::items::knowledge_from_db`, `is_notable`), exactly as the fold reads an event.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "KnowledgeRecord",
///  "description": "ONE KNOWLEDGE CARD, AND THE PROTOCOL STATES NOTHING ABOUT ITS SHAPE — the `ModuleState`/`AlertDefinition` argument a third time, and here it is the strongest of the three. The field set belongs to the SCRAPER: `itemsDb.ts` says a stored record is *literally* the `ItemKnowledge` fields `parseItemWikitext` produces, no projection and no renaming, and that type carries a nested in-game stat block, recipe lists, craft trees with ingredient lines, drop sources and era banners — around thirty fields that grow whenever the wiki grows a field worth scraping. A typed protocol mirror of that would be a translation layer whose only job is to LOSE a field the day the scraper gains one, and it would do it silently, because a knowledge card degrades quietly rather than failing. Worse, a record ROUND-TRIPS: `knowledge.define` pushes one in and every later `knowledge.item` hands it back, so a generator that dropped an unlisted field would rewrite the answer the app just fetched. The engine reads the handful of fields it needs with its own reader (`knowledge::items::knowledge_from_db`, `is_notable`), exactly as the fold reads an event.",
///  "type": "object",
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(transparent)]
pub struct KnowledgeRecord(pub ::serde_json::Map<::std::string::String, ::serde_json::Value>);
impl ::std::ops::Deref for KnowledgeRecord {
    type Target = ::serde_json::Map<::std::string::String, ::serde_json::Value>;
    fn deref(&self) -> &::serde_json::Map<::std::string::String, ::serde_json::Value> {
        &self.0
    }
}
impl ::std::convert::From<KnowledgeRecord>
    for ::serde_json::Map<::std::string::String, ::serde_json::Value>
{
    fn from(value: KnowledgeRecord) -> Self {
        value.0
    }
}
impl ::std::convert::From<::serde_json::Map<::std::string::String, ::serde_json::Value>>
    for KnowledgeRecord
{
    fn from(value: ::serde_json::Map<::std::string::String, ::serde_json::Value>) -> Self {
        Self(value)
    }
}
///One knowledge card. `found` and `record` are BOTH required and they answer different questions: `found` is whether a committed (or pushed-in) source states this name, and `record` is what to draw either way — a miss still carries every local association it could gather. A client that branched on `record` being absent would never see a miss, because a miss is not an absence.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "KnowledgeResult",
///  "description": "One knowledge card. `found` and `record` are BOTH required and they answer different questions: `found` is whether a committed (or pushed-in) source states this name, and `record` is what to draw either way — a miss still carries every local association it could gather. A client that branched on `record` being absent would never see a miss, because a miss is not an absence.",
///  "type": "object",
///  "required": [
///    "domain",
///    "found",
///    "name",
///    "record"
///  ],
///  "properties": {
///    "domain": {
///      "$ref": "#/$defs/KnowledgeDomain"
///    },
///    "found": {
///      "type": "boolean"
///    },
///    "name": {
///      "description": "The name as it was asked for, echoed back so a caller holding several in flight needs no bookkeeping of its own.",
///      "type": "string"
///    },
///    "record": {
///      "$ref": "#/$defs/KnowledgeRecord"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeResult {
    pub domain: KnowledgeDomain,
    pub found: bool,
    ///The name as it was asked for, echoed back so a caller holding several in flight needs no bookkeeping of its own.
    pub name: ::std::string::String,
    pub record: KnowledgeRecord,
}
///`domain` searches ONE corpus and its absence means all four; it is a FILTER and not a hint — an unranked hit from another corpus would be the same defect an accept-and-ignore filter field is on a view.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "KnowledgeSearchParams",
///  "description": "`domain` searches ONE corpus and its absence means all four; it is a FILTER and not a hint — an unranked hit from another corpus would be the same defect an accept-and-ignore filter field is on a view.",
///  "type": "object",
///  "required": [
///    "query"
///  ],
///  "properties": {
///    "domain": {
///      "$ref": "#/$defs/KnowledgeDomain"
///    },
///    "limit": {
///      "description": "How many hits to return. Absent takes the engine's default; a number above its cap takes the cap, because this is a type-ahead rather than a page — the window/offset machinery belongs to `view.subscribe`, where a list is the product. `total` states how many matched, so a caller can say `1-20 of 143` without ever holding 143.",
///      "type": "integer"
///    },
///    "query": {
///      "description": "What to look for. Case-folded on both sides; an empty or whitespace-only query answers with no hits rather than with the whole corpus.",
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeSearchParams {
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub domain: ::std::option::Option<KnowledgeDomain>,
    ///How many hits to return. Absent takes the engine's default; a number above its cap takes the cap, because this is a type-ahead rather than a page — the window/offset machinery belongs to `view.subscribe`, where a list is the product. `total` states how many matched, so a caller can say `1-20 of 143` without ever holding 143.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub limit: ::std::option::Option<i64>,
    ///What to look for. Case-folded on both sides; an empty or whitespace-only query answers with no hits rather than with the whole corpus.
    pub query: ::std::string::String,
}
///NAME SEARCH ACROSS EVERY CORPUS THE ENGINE HOLDS. It answers what the three lookups cannot: a lookup needs the exact name, and a person types three letters. THE RANKING IS THE ENGINE'S (ruling 4): hits arrive EXACT first, then PREFIX, then CONTAINS, and within a rank by name length then alphabetically — a search that handed back an unordered bag would be handing the renderer the munging the ruling forbids.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "KnowledgeSearchRequest",
///  "description": "NAME SEARCH ACROSS EVERY CORPUS THE ENGINE HOLDS. It answers what the three lookups cannot: a lookup needs the exact name, and a person types three letters. THE RANKING IS THE ENGINE'S (ruling 4): hits arrive EXACT first, then PREFIX, then CONTAINS, and within a rank by name length then alphabetically — a search that handed back an unordered bag would be handing the renderer the munging the ruling forbids.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "knowledge.search"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/KnowledgeSearchParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeSearchRequest {
    pub id: RequestId,
    pub op: KnowledgeSearchRequestOp,
    pub params: KnowledgeSearchParams,
}
///`KnowledgeSearchRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "knowledge.search"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum KnowledgeSearchRequestOp {
    #[serde(rename = "knowledge.search")]
    KnowledgeSearch,
}
impl ::std::fmt::Display for KnowledgeSearchRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::KnowledgeSearch => f.write_str("knowledge.search"),
        }
    }
}
impl ::std::str::FromStr for KnowledgeSearchRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "knowledge.search" => Ok(Self::KnowledgeSearch),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for KnowledgeSearchRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for KnowledgeSearchRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for KnowledgeSearchRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`KnowledgeSearchResult`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "KnowledgeSearchResult",
///  "type": "object",
///  "required": [
///    "hits",
///    "query",
///    "total"
///  ],
///  "properties": {
///    "hits": {
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/KnowledgeHit"
///      }
///    },
///    "query": {
///      "type": "string"
///    },
///    "total": {
///      "description": "How many names MATCHED, ignoring the limit — the one number a caller cannot compute from what it was handed.",
///      "type": "integer"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeSearchResult {
    pub hits: ::std::vec::Vec<KnowledgeHit>,
    pub query: ::std::string::String,
    ///How many names MATCHED, ignoring the limit — the one number a caller cannot compute from what it was handed.
    pub total: i64,
}
///ONE SPELL, from the parser's own EFFECTIVE catalog — the committed scrape with removals, derived durations and corrections applied, which is the same table the fold classifies against, never a second load. A NAMED GAP RIDES THIS OP AND IS STATED HERE RATHER THAN DISCOVERED: it carries the DB's stated fields and not the JOIN half of `main/data/spellDetail.ts` — no derived effect classes, no rank lineage, and none of the metrics `spellMetricsAt` reads at a gain level, at a mote rank or with worn focus. Those need three inputs this engine does not have yet (the parsed `spells_us.txt` client table — boundary verdict 7, unbuilt; the observed-rank module's join; the planner's worn-focus reading), and half a card is a wrong answer wearing a right one's clothes. The op answers `found: false` for a rank-suffixed name the DB carries no row for, rather than answering it with the LINE's numbers and no note that they are the line's. The spell-surface ticket owns the rest.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "KnowledgeSpellRequest",
///  "description": "ONE SPELL, from the parser's own EFFECTIVE catalog — the committed scrape with removals, derived durations and corrections applied, which is the same table the fold classifies against, never a second load. A NAMED GAP RIDES THIS OP AND IS STATED HERE RATHER THAN DISCOVERED: it carries the DB's stated fields and not the JOIN half of `main/data/spellDetail.ts` — no derived effect classes, no rank lineage, and none of the metrics `spellMetricsAt` reads at a gain level, at a mote rank or with worn focus. Those need three inputs this engine does not have yet (the parsed `spells_us.txt` client table — boundary verdict 7, unbuilt; the observed-rank module's join; the planner's worn-focus reading), and half a card is a wrong answer wearing a right one's clothes. The op answers `found: false` for a rank-suffixed name the DB carries no row for, rather than answering it with the LINE's numbers and no note that they are the line's. The spell-surface ticket owns the rest.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "knowledge.spell"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/KnowledgeNameParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeSpellRequest {
    pub id: RequestId,
    pub op: KnowledgeSpellRequestOp,
    pub params: KnowledgeNameParams,
}
///`KnowledgeSpellRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "knowledge.spell"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum KnowledgeSpellRequestOp {
    #[serde(rename = "knowledge.spell")]
    KnowledgeSpell,
}
impl ::std::fmt::Display for KnowledgeSpellRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::KnowledgeSpell => f.write_str("knowledge.spell"),
        }
    }
}
impl ::std::str::FromStr for KnowledgeSpellRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "knowledge.spell" => Ok(Self::KnowledgeSpell),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for KnowledgeSpellRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for KnowledgeSpellRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for KnowledgeSpellRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///One character log, as `src/shared/types.ts CharacterRef` describes it - field for field, because this reply IS what the app's picker has always been handed and a served shape that differed by a name would make the engine-absent arm a second contract. THE NAME AND SERVER ARE READ OFF THE FILENAME and nothing else: `eqlog_<Character>_<server>.txt`, split at the FIRST underscore after the prefix, which is the app's own `parseLogName` regex stated as a rule - a character whose name contains an underscore is not a thing EverQuest allows, and a SERVER containing one is, so the split must be leftmost and the remainder must be the server.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "LogCharacter",
///  "description": "One character log, as `src/shared/types.ts CharacterRef` describes it - field for field, because this reply IS what the app's picker has always been handed and a served shape that differed by a name would make the engine-absent arm a second contract. THE NAME AND SERVER ARE READ OFF THE FILENAME and nothing else: `eqlog_<Character>_<server>.txt`, split at the FIRST underscore after the prefix, which is the app's own `parseLogName` regex stated as a rule - a character whose name contains an underscore is not a thing EverQuest allows, and a SERVER containing one is, so the split must be leftmost and the remainder must be the server.",
///  "type": "object",
///  "required": [
///    "logPath",
///    "name",
///    "server"
///  ],
///  "properties": {
///    "lastPlayed": {
///      "description": "The file's last-modified time in epoch milliseconds, TRUNCATED to an integer, which is the sort key the picker orders by. ABSENT MEANS THE ENGINE COULD NOT STATE IT - a file that vanished between the readdir and the stat, or a filesystem with no modification time - and never zero, which would draw a real date in 1970 beside a real character name. It is the same fact and the same rule `HealthResult.logMtimeMs` carries for the attached log, and it stays a served PROCESS fact rather than fold state (ruling 18): no module holds it, and no replay can produce it.",
///      "type": "integer"
///    },
///    "logPath": {
///      "description": "The absolute path of the log file, which is what `session.attach` takes and therefore what a picked row is worth.",
///      "type": "string"
///    },
///    "name": {
///      "description": "The character, as the filename spells it - the game's own capitalisation, never folded.",
///      "type": "string"
///    },
///    "server": {
///      "description": "The server, as the filename spells it.",
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct LogCharacter {
    ///The file's last-modified time in epoch milliseconds, TRUNCATED to an integer, which is the sort key the picker orders by. ABSENT MEANS THE ENGINE COULD NOT STATE IT - a file that vanished between the readdir and the stat, or a filesystem with no modification time - and never zero, which would draw a real date in 1970 beside a real character name. It is the same fact and the same rule `HealthResult.logMtimeMs` carries for the attached log, and it stays a served PROCESS fact rather than fold state (ruling 18): no module holds it, and no replay can produce it.
    #[serde(
        rename = "lastPlayed",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub last_played: ::std::option::Option<i64>,
    ///The absolute path of the log file, which is what `session.attach` takes and therefore what a picked row is worth.
    #[serde(rename = "logPath")]
    pub log_path: ::std::string::String,
    ///The character, as the filename spells it - the game's own capitalisation, never folded.
    pub name: ::std::string::String,
    ///The server, as the filename spells it.
    pub server: ::std::string::String,
}
///THE ADDRESSABLE COORDINATE (owner ruling 18 law 3): state is addressed by (log identity, byte offset) and by nothing else — never by wall time, never by `current`. `offset` is the end of the last COMPLETE line folded, which is the same definition as the scan's end offset; a half-written line is not an event and the mark waits with it. THIS IS NOT A FRAMING CONCERN: it is a coordinate INSIDE the file the engine reads, and it would mean the same thing over any transport.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "LogMark",
///  "description": "THE ADDRESSABLE COORDINATE (owner ruling 18 law 3): state is addressed by (log identity, byte offset) and by nothing else — never by wall time, never by `current`. `offset` is the end of the last COMPLETE line folded, which is the same definition as the scan's end offset; a half-written line is not an event and the mark waits with it. THIS IS NOT A FRAMING CONCERN: it is a coordinate INSIDE the file the engine reads, and it would mean the same thing over any transport.",
///  "type": "object",
///  "required": [
///    "log",
///    "offset"
///  ],
///  "properties": {
///    "log": {
///      "description": "The log being folded, as the path the app handed the engine at attach. The engine never discovers a path of its own.",
///      "type": "string"
///    },
///    "offset": {
///      "description": "The end of the last complete line folded, counted from the start of the file.",
///      "type": "integer"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct LogMark {
    ///The log being folded, as the path the app handed the engine at attach. The engine never discovers a path of its own.
    pub log: ::std::string::String,
    ///The end of the last complete line folded, counted from the start of the file.
    pub offset: i64,
}
///HOW READING THE DIRECTORY WENT - `ResolvedEqDir.readable` in `main/log/config.ts`, member for member, so the served answer and the app's own read describe the same three situations in the same words. A FAILED READ IS NOT `no logs` (JOS-82): `missing` is a path with nothing at it, which is the ordinary state of a machine where EverQuest is installed somewhere else, and `unreadable` is a directory that exists and refused - a permission, a disconnected network share, a share violation - which is a different sentence to a person and a different decision to the caller.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "LogsDirReadable",
///  "description": "HOW READING THE DIRECTORY WENT - `ResolvedEqDir.readable` in `main/log/config.ts`, member for member, so the served answer and the app's own read describe the same three situations in the same words. A FAILED READ IS NOT `no logs` (JOS-82): `missing` is a path with nothing at it, which is the ordinary state of a machine where EverQuest is installed somewhere else, and `unreadable` is a directory that exists and refused - a permission, a disconnected network share, a share violation - which is a different sentence to a person and a different decision to the caller.",
///  "type": "string",
///  "enum": [
///    "ok",
///    "missing",
///    "unreadable"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum LogsDirReadable {
    #[serde(rename = "ok")]
    Ok,
    #[serde(rename = "missing")]
    Missing,
    #[serde(rename = "unreadable")]
    Unreadable,
}
impl ::std::fmt::Display for LogsDirReadable {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Ok => f.write_str("ok"),
            Self::Missing => f.write_str("missing"),
            Self::Unreadable => f.write_str("unreadable"),
        }
    }
}
impl ::std::str::FromStr for LogsDirReadable {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "ok" => Ok(Self::Ok),
            "missing" => Ok(Self::Missing),
            "unreadable" => Ok(Self::Unreadable),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for LogsDirReadable {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for LogsDirReadable {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for LogsDirReadable {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///WHICH CHARACTERS THIS INSTALL HAS, as the engine sees the folder the app named. The served half of ruling 21: the app has always read this directory itself (`listCharacters` in `main/log/config.ts` - a readdir, a filename parse and a `statSync` per file) and the ruling moves the reading to the process that owns log files. IT TAKES NO PARAMS BECAUSE THE DIRECTORY IS PUSHED, and that is the point of the split rather than an economy: a request carrying the folder would make the answer a function of whatever the caller happened to send, and two callers could then disagree about which install this app is looking at. It IS ANSWERABLE BY A WORLD WITH NO FOLD, like `knowledge.*` and `perf.snapshot` and unlike `module.snapshot`: a fresh install has characters to choose between before there is anything to attach to, which is precisely the moment this op exists for. THE ONE REFUSAL IS NEVER HAVING BEEN TOLD - an engine that has heard no `logs.setDir` has no directory to enumerate, which is `unavailable` rather than an empty list, because a caller cannot tell an install with no characters from a question nobody armed.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "LogsListRequest",
///  "description": "WHICH CHARACTERS THIS INSTALL HAS, as the engine sees the folder the app named. The served half of ruling 21: the app has always read this directory itself (`listCharacters` in `main/log/config.ts` - a readdir, a filename parse and a `statSync` per file) and the ruling moves the reading to the process that owns log files. IT TAKES NO PARAMS BECAUSE THE DIRECTORY IS PUSHED, and that is the point of the split rather than an economy: a request carrying the folder would make the answer a function of whatever the caller happened to send, and two callers could then disagree about which install this app is looking at. It IS ANSWERABLE BY A WORLD WITH NO FOLD, like `knowledge.*` and `perf.snapshot` and unlike `module.snapshot`: a fresh install has characters to choose between before there is anything to attach to, which is precisely the moment this op exists for. THE ONE REFUSAL IS NEVER HAVING BEEN TOLD - an engine that has heard no `logs.setDir` has no directory to enumerate, which is `unavailable` rather than an empty list, because a caller cannot tell an install with no characters from a question nobody armed.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "logs.list"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/NoParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct LogsListRequest {
    pub id: RequestId,
    pub op: LogsListRequestOp,
    pub params: NoParams,
}
///`LogsListRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "logs.list"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum LogsListRequestOp {
    #[serde(rename = "logs.list")]
    LogsList,
}
impl ::std::fmt::Display for LogsListRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::LogsList => f.write_str("logs.list"),
        }
    }
}
impl ::std::str::FromStr for LogsListRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "logs.list" => Ok(Self::LogsList),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for LogsListRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for LogsListRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for LogsListRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///THE CHARACTERS, AND WHERE THEY WERE LOOKED FOR. `dir` and `readable` ride every answer and the rows are whatever was found, which is `ResistSpellResult`'s shape and its argument: an empty list means three different things to a person - no such folder, a folder that could not be read, a folder with no character logs in it - and a reply that carried only the rows would flatten them into one silence. `dir` IS ALSO THE ECHO TEST. The app compares it against the directory it currently resolves, and a mismatch means this engine is answering about a folder the app has since been pointed away from - a `logs.setDir` still in flight - so the app reads the folder itself rather than drawing a picker for the wrong install. It is the same test `module.snapshot`'s echoed `module` gets, for the same reason: a bookkeeping failure between two processes must not reach a surface wearing the right answer's clothes.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "LogsListResult",
///  "description": "THE CHARACTERS, AND WHERE THEY WERE LOOKED FOR. `dir` and `readable` ride every answer and the rows are whatever was found, which is `ResistSpellResult`'s shape and its argument: an empty list means three different things to a person - no such folder, a folder that could not be read, a folder with no character logs in it - and a reply that carried only the rows would flatten them into one silence. `dir` IS ALSO THE ECHO TEST. The app compares it against the directory it currently resolves, and a mismatch means this engine is answering about a folder the app has since been pointed away from - a `logs.setDir` still in flight - so the app reads the folder itself rather than drawing a picker for the wrong install. It is the same test `module.snapshot`'s echoed `module` gets, for the same reason: a bookkeeping failure between two processes must not reach a surface wearing the right answer's clothes.",
///  "type": "object",
///  "required": [
///    "characters",
///    "dir",
///    "readable"
///  ],
///  "properties": {
///    "characters": {
///      "description": "One row per `eqlog_<Character>_<server>.txt`, most recently written first. Empty whenever `readable` is not `ok`, and legitimately empty when it is.",
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/LogCharacter"
///      }
///    },
///    "dir": {
///      "description": "The directory this answer is about, echoed back exactly as it was pushed - never normalized, never re-cased, so a caller can compare it against what it sent.",
///      "type": "string"
///    },
///    "readable": {
///      "$ref": "#/$defs/LogsDirReadable"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct LogsListResult {
    ///One row per `eqlog_<Character>_<server>.txt`, most recently written first. Empty whenever `readable` is not `ok`, and legitimately empty when it is.
    pub characters: ::std::vec::Vec<LogCharacter>,
    ///The directory this answer is about, echoed back exactly as it was pushed - never normalized, never re-cased, so a caller can compare it against what it sent.
    pub dir: ::std::string::String,
    pub readable: LogsDirReadable,
}
///`LogsSetDirParams`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "LogsSetDirParams",
///  "type": "object",
///  "required": [
///    "dir"
///  ],
///  "properties": {
///    "dir": {
///      "description": "The folder holding `eqlog_<Character>_<server>.txt`, absolute, as the app resolved it. A directory that does not exist is a perfectly good push and is not refused: the app resolves a path on a machine with no EverQuest on it too, and what that produces is a `logs.list` saying `missing` rather than a command that failed.",
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct LogsSetDirParams {
    ///The folder holding `eqlog_<Character>_<server>.txt`, absolute, as the app resolved it. A directory that does not exist is a perfectly good push and is not refused: the app resolves a path on a machine with no EverQuest on it too, and what that produces is a `logs.list` saying `missing` rather than a command that failed.
    pub dir: ::std::string::String,
}
///WHERE THE CHARACTER LOGS LIVE, PUSHED (owner ruling 21, decision sheet 1a). Log DISCOVERY migrates server-side and launch-time character choice becomes a served answer - but THE APP NAMES THE DIRECTORY, which is boundary verdict 3 applied to a path instead of to a preference: the store is persistence truth, the engine never reads a settings file, and the directory is the product of an override plus an auto-discovery sweep plus a registry read that this engine has no business doing. So the app resolves it (`main/log/config.ts eqLogsDir`) and states it here, on connect and whenever the setting moves. IT IS AN IDEMPOTENT FULL-SET REPLACE like the five `*.define` commands, which for a single value means the last push is the whole of what the app has said; the ack is therefore `DefineAck` with no `count`, exactly as `buffTrust.define` and `respawn.define` answer for a payload that is one object rather than a list. IT IS NOT A `*.define` BY NAME, deliberately: those five are FOLD inputs and part of ruling 18's cache key - a rule set that changes what folding a log produces - and this changes nothing about any fold. It names a directory nobody folds, answers one query, and a world that never hears it folds byte-identically to one that does. THE DIRECTORY IS NOT THE ATTACH. `session.attach` names one FILE to fold and this names the folder to enumerate; a fresh install has the second and not the first, which is the whole reason this command exists rather than the list being derived from the attached log's parent.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "LogsSetDirRequest",
///  "description": "WHERE THE CHARACTER LOGS LIVE, PUSHED (owner ruling 21, decision sheet 1a). Log DISCOVERY migrates server-side and launch-time character choice becomes a served answer - but THE APP NAMES THE DIRECTORY, which is boundary verdict 3 applied to a path instead of to a preference: the store is persistence truth, the engine never reads a settings file, and the directory is the product of an override plus an auto-discovery sweep plus a registry read that this engine has no business doing. So the app resolves it (`main/log/config.ts eqLogsDir`) and states it here, on connect and whenever the setting moves. IT IS AN IDEMPOTENT FULL-SET REPLACE like the five `*.define` commands, which for a single value means the last push is the whole of what the app has said; the ack is therefore `DefineAck` with no `count`, exactly as `buffTrust.define` and `respawn.define` answer for a payload that is one object rather than a list. IT IS NOT A `*.define` BY NAME, deliberately: those five are FOLD inputs and part of ruling 18's cache key - a rule set that changes what folding a log produces - and this changes nothing about any fold. It names a directory nobody folds, answers one query, and a world that never hears it folds byte-identically to one that does. THE DIRECTORY IS NOT THE ATTACH. `session.attach` names one FILE to fold and this names the folder to enumerate; a fresh install has the second and not the first, which is the whole reason this command exists rather than the list being derived from the attached log's parent.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "logs.setDir"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/LogsSetDirParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct LogsSetDirRequest {
    pub id: RequestId,
    pub op: LogsSetDirRequestOp,
    pub params: LogsSetDirParams,
}
///`LogsSetDirRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "logs.setDir"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum LogsSetDirRequestOp {
    #[serde(rename = "logs.setDir")]
    LogsSetDir,
}
impl ::std::fmt::Display for LogsSetDirRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::LogsSetDir => f.write_str("logs.setDir"),
        }
    }
}
impl ::std::str::FromStr for LogsSetDirRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "logs.setDir" => Ok(Self::LogsSetDir),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for LogsSetDirRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for LogsSetDirRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for LogsSetDirRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///A MODULE'S PUBLISHED STATE MOVED — the dirty bit, and nothing more. CONNECTION-WIDE and carrying no `id`, on the `FireMessage` precedent: a module belongs to the world rather than to any subscription. IT CARRIES NO STATE, DELIBERATELY. The whole payload is a name and a cursor, so a client that is not showing that module pays one small frame and ignores it, and a client that is re-fetches through `module.snapshot` — which is the op that already exists and the only place a module's shape is stated. A frame that carried the state would be `module.snapshot` pushed at a cadence nobody asked for, which is the per-window snapshot fan-out this whole boundary exists to delete. IT IS COALESCED TO ONE PER MODULE PER SERVE BEAT (~10 Hz, `views::SERVE_EVERY`), not one per event: a busy tail moves a module's seq many times between two beats and the newest cursor is the whole answer — the same newest-wins rule rule 2 states for diffs. Nothing is sent for a module whose seq did not move, so an idle session pays nothing. IT IS NOT AN EPOCH AND DOES NOT REPLACE ONE: a bump still means drop-everything-and-take-the-reset, and a `moduleChanged` inside one generation means only `there is something newer to fetch`.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ModuleChangedMessage",
///  "description": "A MODULE'S PUBLISHED STATE MOVED — the dirty bit, and nothing more. CONNECTION-WIDE and carrying no `id`, on the `FireMessage` precedent: a module belongs to the world rather than to any subscription. IT CARRIES NO STATE, DELIBERATELY. The whole payload is a name and a cursor, so a client that is not showing that module pays one small frame and ignores it, and a client that is re-fetches through `module.snapshot` — which is the op that already exists and the only place a module's shape is stated. A frame that carried the state would be `module.snapshot` pushed at a cadence nobody asked for, which is the per-window snapshot fan-out this whole boundary exists to delete. IT IS COALESCED TO ONE PER MODULE PER SERVE BEAT (~10 Hz, `views::SERVE_EVERY`), not one per event: a busy tail moves a module's seq many times between two beats and the newest cursor is the whole answer — the same newest-wins rule rule 2 states for diffs. Nothing is sent for a module whose seq did not move, so an idle session pays nothing. IT IS NOT AN EPOCH AND DOES NOT REPLACE ONE: a bump still means drop-everything-and-take-the-reset, and a `moduleChanged` inside one generation means only `there is something newer to fetch`.",
///  "type": "object",
///  "required": [
///    "kind",
///    "module",
///    "seq"
///  ],
///  "properties": {
///    "kind": {
///      "type": "string",
///      "enum": [
///        "moduleChanged"
///      ]
///    },
///    "module": {
///      "description": "The module's id, exactly as the registry spells it and exactly as `module.snapshot` takes it — `loot`, `kills`, `buffTimers`.",
///      "type": "string"
///    },
///    "seq": {
///      "description": "The module's OWN published seq as of this beat — the same cursor `ModuleSnapshotResult.seq` carries, so a client holding a snapshot compares the two numbers and refetches only when this one is ahead. For the four modules that publish a private revision counter (combo, character, respawn, buffTimers) it is that counter, because a preference push advances no log seq.",
///      "type": "integer"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ModuleChangedMessage {
    pub kind: ModuleChangedMessageKind,
    ///The module's id, exactly as the registry spells it and exactly as `module.snapshot` takes it — `loot`, `kills`, `buffTimers`.
    pub module: ::std::string::String,
    ///The module's OWN published seq as of this beat — the same cursor `ModuleSnapshotResult.seq` carries, so a client holding a snapshot compares the two numbers and refetches only when this one is ahead. For the four modules that publish a private revision counter (combo, character, respawn, buffTimers) it is that counter, because a preference push advances no log seq.
    pub seq: i64,
}
///`ModuleChangedMessageKind`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "moduleChanged"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum ModuleChangedMessageKind {
    #[serde(rename = "moduleChanged")]
    ModuleChanged,
}
impl ::std::fmt::Display for ModuleChangedMessageKind {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::ModuleChanged => f.write_str("moduleChanged"),
        }
    }
}
impl ::std::str::FromStr for ModuleChangedMessageKind {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "moduleChanged" => Ok(Self::ModuleChanged),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ModuleChangedMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ModuleChangedMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ModuleChangedMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ModuleSnapshotParams`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ModuleSnapshotParams",
///  "type": "object",
///  "required": [
///    "module"
///  ],
///  "properties": {
///    "module": {
///      "description": "The module's id, exactly as the registry spells it — `loot`, `kills`, `buffTimers`. Not a view source: a view is filtered, sorted and windowed, and this is the module's whole state.",
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ModuleSnapshotParams {
    ///The module's id, exactly as the registry spells it — `loot`, `kills`, `buffTimers`. Not a view source: a view is filtered, sorted and windowed, and this is the module's whole state.
    pub module: ::std::string::String,
}
///THE FIRST DATA-BEARING OP. Asks the live fold for one module's published state — the same `{ seq, state }` the app's own module registry hydrates from today. The answer is a point-in-time read of the ingest's fold: mid-scan it is a real PREFIX state (every event up to `seq` and no part of another), because the fold answers between its own read boundaries and never inside one. An unknown module name is `notFound`: the registry is the authority on what a module is, and an empty state would be a lie about a module that does not exist.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ModuleSnapshotRequest",
///  "description": "THE FIRST DATA-BEARING OP. Asks the live fold for one module's published state — the same `{ seq, state }` the app's own module registry hydrates from today. The answer is a point-in-time read of the ingest's fold: mid-scan it is a real PREFIX state (every event up to `seq` and no part of another), because the fold answers between its own read boundaries and never inside one. An unknown module name is `notFound`: the registry is the authority on what a module is, and an empty state would be a lie about a module that does not exist.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "module.snapshot"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/ModuleSnapshotParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ModuleSnapshotRequest {
    pub id: RequestId,
    pub op: ModuleSnapshotRequestOp,
    pub params: ModuleSnapshotParams,
}
///`ModuleSnapshotRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "module.snapshot"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum ModuleSnapshotRequestOp {
    #[serde(rename = "module.snapshot")]
    ModuleSnapshot,
}
impl ::std::fmt::Display for ModuleSnapshotRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::ModuleSnapshot => f.write_str("module.snapshot"),
        }
    }
}
impl ::std::str::FromStr for ModuleSnapshotRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "module.snapshot" => Ok(Self::ModuleSnapshot),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ModuleSnapshotRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ModuleSnapshotRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ModuleSnapshotRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ModuleSnapshotResult`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ModuleSnapshotResult",
///  "type": "object",
///  "required": [
///    "module",
///    "seq",
///    "state"
///  ],
///  "properties": {
///    "module": {
///      "description": "The module that answered, echoed back so a caller holding several in flight needs no bookkeeping of its own.",
///      "type": "string"
///    },
///    "seq": {
///      "description": "The module's OWN published seq — for most modules the seq of the last event it folded, and for the four that publish a private revision counter (combo, character, respawn, buffTimers) that counter. It is a hydration cursor, not the fold's event count; `HealthResult.events` is the count.",
///      "type": "integer"
///    },
///    "state": {
///      "$ref": "#/$defs/ModuleState"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ModuleSnapshotResult {
    ///The module that answered, echoed back so a caller holding several in flight needs no bookkeeping of its own.
    pub module: ::std::string::String,
    ///The module's OWN published seq — for most modules the seq of the last event it folded, and for the four that publish a private revision counter (combo, character, respawn, buffTimers) that counter. It is a hydration cursor, not the fold's event count; `HealthResult.events` is the count.
    pub seq: i64,
    pub state: ::serde_json::Value,
}
///An op that takes nothing still sends `params: {}`. The envelope keeps one shape, so adding a parameter later is a schema edit rather than an envelope change.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "NoParams",
///  "description": "An op that takes nothing still sends `params: {}`. The envelope keeps one shape, so adding a parameter later is a schema edit rather than an envelope change.",
///  "type": "object",
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct NoParams {}
impl ::std::default::Default for NoParams {
    fn default() -> Self {
        Self {}
    }
}
///ONE BUDGET: what it is called, what it allows, what it measured, and the verdict - render-ready, which is ruling 4 applied to a diagnostic rather than to a list. `limit` and `measured` are STRINGS the engine formatted, not numbers with a unit the caller has to know, and that is deliberate on three counts: the two budgets in this build are measured in different units (bytes per second, microseconds) so a shared numeric field would need a unit discriminant nobody reads; the comparison that produces `verdict` is arithmetic and ruling 4 puts arithmetic on this side of the wire; and a third budget can ship without one line changing in the renderer. Locale is fixed en-US per ruling 25. A budget carries no name, no path and no log content by construction - it is a rate, a latency and a verdict, which is exactly the set the telemetry bright line admits.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "PerfBudget",
///  "description": "ONE BUDGET: what it is called, what it allows, what it measured, and the verdict - render-ready, which is ruling 4 applied to a diagnostic rather than to a list. `limit` and `measured` are STRINGS the engine formatted, not numbers with a unit the caller has to know, and that is deliberate on three counts: the two budgets in this build are measured in different units (bytes per second, microseconds) so a shared numeric field would need a unit discriminant nobody reads; the comparison that produces `verdict` is arithmetic and ruling 4 puts arithmetic on this side of the wire; and a third budget can ship without one line changing in the renderer. Locale is fixed en-US per ruling 25. A budget carries no name, no path and no log content by construction - it is a rate, a latency and a verdict, which is exactly the set the telemetry bright line admits.",
///  "type": "object",
///  "required": [
///    "id",
///    "label",
///    "limit",
///    "note",
///    "verdict"
///  ],
///  "properties": {
///    "id": {
///      "description": "The budget's stable key, for a test or a bug report to name it by. Never drawn - `label` is what a person reads - and never re-ordered against, because the server already sent the rows in their drawing order.",
///      "type": "string",
///      "enum": [
///        "foldRate",
///        "serveLatency"
///      ]
///    },
///    "label": {
///      "description": "What the budget is called, in the words the panel prints.",
///      "type": "string"
///    },
///    "limit": {
///      "description": "The ceiling or the floor, rendered with its unit and its direction - `at least 1.0 MB/s`, `at most 2.0 s` - so the row reads as a sentence and a reader never has to guess which way the comparison runs.",
///      "type": "string"
///    },
///    "measured": {
///      "description": "What this generation actually did, rendered in the same unit as `limit`. ABSENT MEANS NOT YET MEASURED and never zero, the same rule `PerfIngest` keeps: a scan still running has no rate, and a source whose every frame was an owed reset has no latency, and reporting either as `0` would be the one lie an instrument must not tell.",
///      "type": "string"
///    },
///    "note": {
///      "description": "The one sentence a reader needs so the number is not misread - the caveat travelling with the measurement instead of living in a doc nobody has open. It is where `serveLatency` says that it includes the coalescing beat and is a wedge detector rather than a compute budget, and where `foldRate` says the floor is an eighth of the measured rate on purpose so a debug build is what trips it.",
///      "type": "string"
///    },
///    "verdict": {
///      "description": "`pass` when the measurement satisfies the limit, `fail` when it does not, `unmeasured` when there is nothing yet to judge - which is a third state rather than an optimistic `pass`, because a budget that reads green before it has measured anything is worse than one that says nothing.",
///      "type": "string",
///      "enum": [
///        "pass",
///        "fail",
///        "unmeasured"
///      ]
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct PerfBudget {
    ///The budget's stable key, for a test or a bug report to name it by. Never drawn - `label` is what a person reads - and never re-ordered against, because the server already sent the rows in their drawing order.
    pub id: PerfBudgetId,
    ///What the budget is called, in the words the panel prints.
    pub label: ::std::string::String,
    ///The ceiling or the floor, rendered with its unit and its direction - `at least 1.0 MB/s`, `at most 2.0 s` - so the row reads as a sentence and a reader never has to guess which way the comparison runs.
    pub limit: ::std::string::String,
    ///What this generation actually did, rendered in the same unit as `limit`. ABSENT MEANS NOT YET MEASURED and never zero, the same rule `PerfIngest` keeps: a scan still running has no rate, and a source whose every frame was an owed reset has no latency, and reporting either as `0` would be the one lie an instrument must not tell.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub measured: ::std::option::Option<::std::string::String>,
    ///The one sentence a reader needs so the number is not misread - the caveat travelling with the measurement instead of living in a doc nobody has open. It is where `serveLatency` says that it includes the coalescing beat and is a wedge detector rather than a compute budget, and where `foldRate` says the floor is an eighth of the measured rate on purpose so a debug build is what trips it.
    pub note: ::std::string::String,
    ///`pass` when the measurement satisfies the limit, `fail` when it does not, `unmeasured` when there is nothing yet to judge - which is a third state rather than an optimistic `pass`, because a budget that reads green before it has measured anything is worse than one that says nothing.
    pub verdict: PerfBudgetVerdict,
}
///The budget's stable key, for a test or a bug report to name it by. Never drawn - `label` is what a person reads - and never re-ordered against, because the server already sent the rows in their drawing order.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "description": "The budget's stable key, for a test or a bug report to name it by. Never drawn - `label` is what a person reads - and never re-ordered against, because the server already sent the rows in their drawing order.",
///  "type": "string",
///  "enum": [
///    "foldRate",
///    "serveLatency"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum PerfBudgetId {
    #[serde(rename = "foldRate")]
    FoldRate,
    #[serde(rename = "serveLatency")]
    ServeLatency,
}
impl ::std::fmt::Display for PerfBudgetId {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::FoldRate => f.write_str("foldRate"),
            Self::ServeLatency => f.write_str("serveLatency"),
        }
    }
}
impl ::std::str::FromStr for PerfBudgetId {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "foldRate" => Ok(Self::FoldRate),
            "serveLatency" => Ok(Self::ServeLatency),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for PerfBudgetId {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for PerfBudgetId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for PerfBudgetId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`pass` when the measurement satisfies the limit, `fail` when it does not, `unmeasured` when there is nothing yet to judge - which is a third state rather than an optimistic `pass`, because a budget that reads green before it has measured anything is worse than one that says nothing.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "description": "`pass` when the measurement satisfies the limit, `fail` when it does not, `unmeasured` when there is nothing yet to judge - which is a third state rather than an optimistic `pass`, because a budget that reads green before it has measured anything is worse than one that says nothing.",
///  "type": "string",
///  "enum": [
///    "pass",
///    "fail",
///    "unmeasured"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum PerfBudgetVerdict {
    #[serde(rename = "pass")]
    Pass,
    #[serde(rename = "fail")]
    Fail,
    #[serde(rename = "unmeasured")]
    Unmeasured,
}
impl ::std::fmt::Display for PerfBudgetVerdict {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Pass => f.write_str("pass"),
            Self::Fail => f.write_str("fail"),
            Self::Unmeasured => f.write_str("unmeasured"),
        }
    }
}
impl ::std::str::FromStr for PerfBudgetVerdict {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "pass" => Ok(Self::Pass),
            "fail" => Ok(Self::Fail),
            "unmeasured" => Ok(Self::Unmeasured),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for PerfBudgetVerdict {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for PerfBudgetVerdict {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for PerfBudgetVerdict {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///THE ENGINE'S OWN BUDGETS, DEFINITIONS AND VERDICT TOGETHER (owner ruling 19 surface, JOS-502). `engine/crates/engined/tests/budget.rs` asserts these same ceilings in CI against a synthetic corpus; this op answers them LIVE, off the generation that is actually running, so the panel and the bug report state what THIS machine did rather than what a runner did. Ruling 3 is the whole reason the op carries the definitions and not just the numbers - performance goals are self-measured and never promised, so a reader must be able to see the ceiling beside the measurement and judge for himself instead of trusting a colour. Same door and same cost as `perf.snapshot` (one ask on the fold's boundary), same standing warning: THE APP MUST NOT POLL THIS IDLY, because a budget surface that costs a round trip a second while nobody is looking is precisely the bug it exists to find.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "PerfBudgetsRequest",
///  "description": "THE ENGINE'S OWN BUDGETS, DEFINITIONS AND VERDICT TOGETHER (owner ruling 19 surface, JOS-502). `engine/crates/engined/tests/budget.rs` asserts these same ceilings in CI against a synthetic corpus; this op answers them LIVE, off the generation that is actually running, so the panel and the bug report state what THIS machine did rather than what a runner did. Ruling 3 is the whole reason the op carries the definitions and not just the numbers - performance goals are self-measured and never promised, so a reader must be able to see the ceiling beside the measurement and judge for himself instead of trusting a colour. Same door and same cost as `perf.snapshot` (one ask on the fold's boundary), same standing warning: THE APP MUST NOT POLL THIS IDLY, because a budget surface that costs a round trip a second while nobody is looking is precisely the bug it exists to find.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "perf.budgets"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/NoParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct PerfBudgetsRequest {
    pub id: RequestId,
    pub op: PerfBudgetsRequestOp,
    pub params: NoParams,
}
///`PerfBudgetsRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "perf.budgets"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum PerfBudgetsRequestOp {
    #[serde(rename = "perf.budgets")]
    PerfBudgets,
}
impl ::std::fmt::Display for PerfBudgetsRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::PerfBudgets => f.write_str("perf.budgets"),
        }
    }
}
impl ::std::str::FromStr for PerfBudgetsRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "perf.budgets" => Ok(Self::PerfBudgets),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for PerfBudgetsRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for PerfBudgetsRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for PerfBudgetsRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///Every budget this build enforces, judged against the generation named by `epoch`. IT DELIBERATELY RESTATES NEITHER `status` NOR `uptimeMs`, which `PerfSnapshotResult` does restate from `HealthResult`: `session.health`'s guard in `src/shared/dataServer/ops.ts` is `uptimeMs` present and `serve` absent, so a budgets answer carrying an uptime would be a third arm that guard could not refuse - the registry's matrix would go red, and correctly, because a shape two ops both pass is a shape no caller can identify. The epoch is here because a budget verdict is a fact about ONE generation and a reader comparing two answers across an attach must be able to see that they are not comparable.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "PerfBudgetsResult",
///  "description": "Every budget this build enforces, judged against the generation named by `epoch`. IT DELIBERATELY RESTATES NEITHER `status` NOR `uptimeMs`, which `PerfSnapshotResult` does restate from `HealthResult`: `session.health`'s guard in `src/shared/dataServer/ops.ts` is `uptimeMs` present and `serve` absent, so a budgets answer carrying an uptime would be a third arm that guard could not refuse - the registry's matrix would go red, and correctly, because a shape two ops both pass is a shape no caller can identify. The epoch is here because a budget verdict is a fact about ONE generation and a reader comparing two answers across an attach must be able to see that they are not comparable.",
///  "type": "object",
///  "required": [
///    "budgets",
///    "epoch"
///  ],
///  "properties": {
///    "budgets": {
///      "description": "One row per budget, in the order the panel draws them - a fixed order this engine owns, never an order a caller re-derives (ruling 4). The list is never empty: a build with a budget it cannot measure yet says `unmeasured` in the row rather than omitting it, because a budget that vanishes when it is inconvenient is not a budget.",
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/PerfBudget"
///      }
///    },
///    "epoch": {
///      "$ref": "#/$defs/Epoch"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct PerfBudgetsResult {
    ///One row per budget, in the order the panel draws them - a fixed order this engine owns, never an order a caller re-derives (ruling 4). The list is never empty: a build with a budget it cannot measure yet says `unmeasured` in the row rather than omitting it, because a budget that vanishes when it is inconvenient is not a budget.
    pub budgets: ::std::vec::Vec<PerfBudget>,
    pub epoch: Epoch,
}
///WHAT STARTING THIS GENERATION COST. Every field is optional and absent means NOT YET MEASURED rather than zero: `scanMs` is unknown until the scan finishes, and a zero there would say a whole log folded instantly. The engine prints the same two numbers to stderr; this is the same measurement on the wire, so a panel does not have to scrape a log.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "PerfIngest",
///  "description": "WHAT STARTING THIS GENERATION COST. Every field is optional and absent means NOT YET MEASURED rather than zero: `scanMs` is unknown until the scan finishes, and a zero there would say a whole log folded instantly. The engine prints the same two numbers to stderr; this is the same measurement on the wire, so a panel does not have to scrape a log.",
///  "type": "object",
///  "properties": {
///    "scanBytes": {
///      "description": "Bytes read by the scan, up to the mark it landed on. Absent while the scan is still running.",
///      "type": "integer"
///    },
///    "scanMs": {
///      "description": "Wall time from the first byte read to the fold landing. Absent while the scan is still running.",
///      "type": "integer"
///    },
///    "spellDbMs": {
///      "description": "How long the parser's spell catalog took to become available for this attach. Near zero after the first attach of a process — the catalog is built once per process — and the number is reported rather than assumed.",
///      "type": "integer"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct PerfIngest {
    ///Bytes read by the scan, up to the mark it landed on. Absent while the scan is still running.
    #[serde(
        rename = "scanBytes",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub scan_bytes: ::std::option::Option<i64>,
    ///Wall time from the first byte read to the fold landing. Absent while the scan is still running.
    #[serde(
        rename = "scanMs",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub scan_ms: ::std::option::Option<i64>,
    ///How long the parser's spell catalog took to become available for this attach. Near zero after the first attach of a process — the catalog is built once per process — and the number is reported rather than assumed.
    #[serde(
        rename = "spellDbMs",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub spell_db_ms: ::std::option::Option<i64>,
}
impl ::std::default::Default for PerfIngest {
    fn default() -> Self {
        Self {
            scan_bytes: Default::default(),
            scan_ms: Default::default(),
            spell_db_ms: Default::default(),
        }
    }
}
///ONE SAMPLED WINDOW OF THE SERVE PATH, and every figure in it is an INTERVAL rather than a running total - which is the one design decision in this shape. `perf.snapshot` already answers the cumulative question and answers it better; what a history is for is saying that the minute at 04:12 cost four times what the minute before it did, and a list of ever-growing totals makes a reader do that subtraction himself over numbers whose baseline he cannot see. A quiet window is RECORDED as a quiet window rather than skipped, because a ring that dropped its empty samples would compress a two-minute silence into no space at all and make the busy moments look adjacent. Nothing here can carry game data: it is a count of frames, a weight of bytes and a latency.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "PerfMoment",
///  "description": "ONE SAMPLED WINDOW OF THE SERVE PATH, and every figure in it is an INTERVAL rather than a running total - which is the one design decision in this shape. `perf.snapshot` already answers the cumulative question and answers it better; what a history is for is saying that the minute at 04:12 cost four times what the minute before it did, and a list of ever-growing totals makes a reader do that subtraction himself over numbers whose baseline he cannot see. A quiet window is RECORDED as a quiet window rather than skipped, because a ring that dropped its empty samples would compress a two-minute silence into no space at all and make the busy moments look adjacent. Nothing here can carry game data: it is a count of frames, a weight of bytes and a latency.",
///  "type": "object",
///  "required": [
///    "atMs",
///    "frames",
///    "payloadWeight",
///    "spanMs"
///  ],
///  "properties": {
///    "atMs": {
///      "description": "When the window CLOSED, as milliseconds since this process started - the same clock `PerfSnapshotResult.uptimeMs` is on, so a panel holding both can place the moments against the uptime without a second time base. Process-relative on purpose: the engine reads no wall clock to answer a performance question, and a process-relative stamp carries nothing about when or where a person plays.",
///      "type": "integer"
///    },
///    "foldToFrameUsMax": {
///      "description": "The worst fold-to-frame latency in MICROSECONDS among the frames timed in this window, or ABSENT when no frame in it had a fold behind it. The worst rather than the mean, on `widestPayloadWeight`'s argument: a mean over a ten-second window hides the one frame that stalled somebody's screen, which is the only frame the window was sampled to find.",
///      "type": "integer"
///    },
///    "frames": {
///      "description": "Frames sent across every source during this window, resets and diffs together. Per-source detail is `perf.snapshot`'s serve table and is deliberately not duplicated here: a ring that held one row per source per sample would grow with the source registry, which is exactly the unbounded growth this shape refuses.",
///      "type": "integer"
///    },
///    "payloadWeight": {
///      "description": "What those frames weighed, summed over every source, in the same accounting `PerfServeSource.payloadWeight` uses - and the unit is in this sentence rather than in the name for the same reason it is there, because a property name in this schema may not carry a wire unit.",
///      "type": "integer"
///    },
///    "spanMs": {
///      "description": "How long this window ACTUALLY covered, measured rather than assumed equal to `cadenceMs`. It is what makes the counts below dividable into rates honestly, and a span noticeably longer than the cadence is itself the finding - the sampling thread was busy.",
///      "type": "integer"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct PerfMoment {
    ///When the window CLOSED, as milliseconds since this process started - the same clock `PerfSnapshotResult.uptimeMs` is on, so a panel holding both can place the moments against the uptime without a second time base. Process-relative on purpose: the engine reads no wall clock to answer a performance question, and a process-relative stamp carries nothing about when or where a person plays.
    #[serde(rename = "atMs")]
    pub at_ms: i64,
    ///The worst fold-to-frame latency in MICROSECONDS among the frames timed in this window, or ABSENT when no frame in it had a fold behind it. The worst rather than the mean, on `widestPayloadWeight`'s argument: a mean over a ten-second window hides the one frame that stalled somebody's screen, which is the only frame the window was sampled to find.
    #[serde(
        rename = "foldToFrameUsMax",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub fold_to_frame_us_max: ::std::option::Option<i64>,
    ///Frames sent across every source during this window, resets and diffs together. Per-source detail is `perf.snapshot`'s serve table and is deliberately not duplicated here: a ring that held one row per source per sample would grow with the source registry, which is exactly the unbounded growth this shape refuses.
    pub frames: i64,
    ///What those frames weighed, summed over every source, in the same accounting `PerfServeSource.payloadWeight` uses - and the unit is in this sentence rather than in the name for the same reason it is there, because a property name in this schema may not carry a wire unit.
    #[serde(rename = "payloadWeight")]
    pub payload_weight: i64,
    ///How long this window ACTUALLY covered, measured rather than assumed equal to `cadenceMs`. It is what makes the counts below dividable into rates honestly, and a span noticeably longer than the cadence is itself the finding - the sampling thread was busy.
    #[serde(rename = "spanMs")]
    pub span_ms: i64,
}
///ONE SOURCE'S SERVE PATH, cumulative for this generation — the counters `views::meter` keeps, exactly as ruling 19 names them. QUEUE TIME IS NEVER COUNTED AS COMPUTE: `foldToFrameUs*` is measured from the instant the fold produced what the frame reports to the instant the frame reached the connection's outbox, and a frame with no fold behind it (the fresh reset a just-opened subscription is owed) is COUNTED but not TIMED — which is why the two latency fields are optional and their absence means `no frame here had a fold behind it`, never `zero microseconds`.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "PerfServeSource",
///  "description": "ONE SOURCE'S SERVE PATH, cumulative for this generation — the counters `views::meter` keeps, exactly as ruling 19 names them. QUEUE TIME IS NEVER COUNTED AS COMPUTE: `foldToFrameUs*` is measured from the instant the fold produced what the frame reports to the instant the frame reached the connection's outbox, and a frame with no fold behind it (the fresh reset a just-opened subscription is owed) is COUNTED but not TIMED — which is why the two latency fields are optional and their absence means `no frame here had a fold behind it`, never `zero microseconds`.",
///  "type": "object",
///  "required": [
///    "diffs",
///    "frames",
///    "payloadWeight",
///    "resets",
///    "rows",
///    "source",
///    "subscribers",
///    "widestPayloadWeight"
///  ],
///  "properties": {
///    "diffs": {
///      "type": "integer"
///    },
///    "foldToFrameUsMax": {
///      "description": "The worst timed frame, in microseconds.",
///      "type": "integer"
///    },
///    "foldToFrameUsMean": {
///      "description": "Mean fold-to-frame latency in MICROSECONDS, over the timed frames only. Microseconds rather than milliseconds because cutting a fifty-row window off a fold takes tens of them, and a serve path reporting `0 ms` reads as a measurement nobody took.",
///      "type": "integer"
///    },
///    "frames": {
///      "description": "Frames actually sent — `resets + diffs`. Reported rather than left to the caller's addition so the row reads without arithmetic.",
///      "type": "integer"
///    },
///    "payloadWeight": {
///      "description": "HOW MUCH THIS SOURCE HAS SENT, cumulative — the payload budget ruling 4 asks for, weighed off the frames' own serializations. THE UNIT IS IN THIS SENTENCE AND NOT IN THE NAME, and that is this schema keeping its own law rather than dodging it: a property name here may not carry a wire unit, because a schema that grew a byte count would quietly make the transport unswappable (the owner's constraint, enforced structurally in tests/protocolSchema.test.mts) — while the prose is exactly where a measurement is allowed to say what it measured. It is bytes of the JSON this engine serialized, so a different encoding would weigh the same frames differently: a client compares this against itself over time, never against a constant. `weight` is the vocabulary this repo already uses for the size of a committed thing (scripts/gen-data-weight.mts).",
///      "type": "integer"
///    },
///    "resets": {
///      "type": "integer"
///    },
///    "rows": {
///      "description": "Rows carried by the resets. A diff carries ops, not rows.",
///      "type": "integer"
///    },
///    "source": {
///      "description": "The view source's name, exactly as the source registry spells it.",
///      "type": "string"
///    },
///    "subscribers": {
///      "description": "Open subscriptions over this source RIGHT NOW, across every connection — a live count, not a cumulative one, and the world's answer rather than the meter's. It is what makes a row with no recent frames readable: nobody is watching, as against nothing is moving.",
///      "type": "integer"
///    },
///    "widestPayloadWeight": {
///      "description": "The largest single frame, weighed the same way. The budget number that matters — a mean hides the one frame that stalled a window.",
///      "type": "integer"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct PerfServeSource {
    pub diffs: i64,
    ///The worst timed frame, in microseconds.
    #[serde(
        rename = "foldToFrameUsMax",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub fold_to_frame_us_max: ::std::option::Option<i64>,
    ///Mean fold-to-frame latency in MICROSECONDS, over the timed frames only. Microseconds rather than milliseconds because cutting a fifty-row window off a fold takes tens of them, and a serve path reporting `0 ms` reads as a measurement nobody took.
    #[serde(
        rename = "foldToFrameUsMean",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub fold_to_frame_us_mean: ::std::option::Option<i64>,
    ///Frames actually sent — `resets + diffs`. Reported rather than left to the caller's addition so the row reads without arithmetic.
    pub frames: i64,
    ///HOW MUCH THIS SOURCE HAS SENT, cumulative — the payload budget ruling 4 asks for, weighed off the frames' own serializations. THE UNIT IS IN THIS SENTENCE AND NOT IN THE NAME, and that is this schema keeping its own law rather than dodging it: a property name here may not carry a wire unit, because a schema that grew a byte count would quietly make the transport unswappable (the owner's constraint, enforced structurally in tests/protocolSchema.test.mts) — while the prose is exactly where a measurement is allowed to say what it measured. It is bytes of the JSON this engine serialized, so a different encoding would weigh the same frames differently: a client compares this against itself over time, never against a constant. `weight` is the vocabulary this repo already uses for the size of a committed thing (scripts/gen-data-weight.mts).
    #[serde(rename = "payloadWeight")]
    pub payload_weight: i64,
    pub resets: i64,
    ///Rows carried by the resets. A diff carries ops, not rows.
    pub rows: i64,
    ///The view source's name, exactly as the source registry spells it.
    pub source: ::std::string::String,
    ///Open subscriptions over this source RIGHT NOW, across every connection — a live count, not a cumulative one, and the world's answer rather than the meter's. It is what makes a row with no recent frames readable: nobody is watching, as against nothing is moving.
    pub subscribers: i64,
    ///The largest single frame, weighed the same way. The budget number that matters — a mean hides the one frame that stalled a window.
    #[serde(rename = "widestPayloadWeight")]
    pub widest_payload_weight: i64,
}
///THE ENGINE'S OWN PERFORMANCE, ASKED FOR (owner ruling 19 surface, JOS-483). Everything `session.health` says about where the fold has got to, plus what the ingest cost to build and what the serve path has cost since — the counters `views::meter` already keeps, read WITHOUT resetting them so two asks read as a progression rather than as two disconnected windows. It is answered through the same one door `module.snapshot` uses: the meter lives on the ingest thread, the request arrives on a connection thread, and the ingest answers at a boundary it already reaches. THE APP MUST NOT POLL THIS IDLY. It is the in-app performance panel's data and the panel is open a few seconds at a time; a perf surface that costs a round trip a second while nobody is looking at it is the bug it exists to find.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "PerfSnapshotRequest",
///  "description": "THE ENGINE'S OWN PERFORMANCE, ASKED FOR (owner ruling 19 surface, JOS-483). Everything `session.health` says about where the fold has got to, plus what the ingest cost to build and what the serve path has cost since — the counters `views::meter` already keeps, read WITHOUT resetting them so two asks read as a progression rather than as two disconnected windows. It is answered through the same one door `module.snapshot` uses: the meter lives on the ingest thread, the request arrives on a connection thread, and the ingest answers at a boundary it already reaches. THE APP MUST NOT POLL THIS IDLY. It is the in-app performance panel's data and the panel is open a few seconds at a time; a perf surface that costs a round trip a second while nobody is looking at it is the bug it exists to find.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "perf.snapshot"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/NoParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct PerfSnapshotRequest {
    pub id: RequestId,
    pub op: PerfSnapshotRequestOp,
    pub params: NoParams,
}
///`PerfSnapshotRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "perf.snapshot"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum PerfSnapshotRequestOp {
    #[serde(rename = "perf.snapshot")]
    PerfSnapshot,
}
impl ::std::fmt::Display for PerfSnapshotRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::PerfSnapshot => f.write_str("perf.snapshot"),
        }
    }
}
impl ::std::str::FromStr for PerfSnapshotRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "perf.snapshot" => Ok(Self::PerfSnapshot),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for PerfSnapshotRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for PerfSnapshotRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for PerfSnapshotRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///What the engine is doing and what it has cost. The first five fields are `HealthResult`'s and mean exactly what they mean there, restated rather than nested so a panel reads one object — and OPTIONAL on the same terms, because a health answer given before any attach honestly has no mark, no event count and no log timestamp. `ingest` is what building this generation cost; `serve` is one row per view source, cumulative for the generation.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "PerfSnapshotResult",
///  "description": "What the engine is doing and what it has cost. The first five fields are `HealthResult`'s and mean exactly what they mean there, restated rather than nested so a panel reads one object — and OPTIONAL on the same terms, because a health answer given before any attach honestly has no mark, no event count and no log timestamp. `ingest` is what building this generation cost; `serve` is one row per view source, cumulative for the generation.",
///  "type": "object",
///  "required": [
///    "epoch",
///    "ingest",
///    "serve",
///    "status",
///    "uptimeMs"
///  ],
///  "properties": {
///    "epoch": {
///      "$ref": "#/$defs/Epoch"
///    },
///    "events": {
///      "description": "Events folded in this generation. Counts EVENTS, not lines — the same number `HealthResult.events` carries.",
///      "type": "integer"
///    },
///    "ingest": {
///      "$ref": "#/$defs/PerfIngest"
///    },
///    "lastEventTs": {
///      "description": "The `ts` of the last event folded — THE LOG'S OWN CLOCK, never the host's. Its distance from the host's clock is the freshness figure the panel draws, and that subtraction is the CALLER's to make: the engine does not read a wall clock to answer this.",
///      "type": "integer"
///    },
///    "mark": {
///      "$ref": "#/$defs/LogMark"
///    },
///    "serve": {
///      "description": "One row per view source that has served a frame in this generation. A source nobody has subscribed to is ABSENT rather than a row of zeros — the same rule the panel applies to a process type with no process behind it.",
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/PerfServeSource"
///      }
///    },
///    "status": {
///      "type": "string",
///      "enum": [
///        "starting",
///        "attaching",
///        "folding",
///        "live",
///        "idle"
///      ]
///    },
///    "uptimeMs": {
///      "description": "How long THIS PROCESS has been up. Process metadata, never world state: it survives an attach, which the epoch does not.",
///      "type": "integer"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct PerfSnapshotResult {
    pub epoch: Epoch,
    ///Events folded in this generation. Counts EVENTS, not lines — the same number `HealthResult.events` carries.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub events: ::std::option::Option<i64>,
    pub ingest: PerfIngest,
    ///The `ts` of the last event folded — THE LOG'S OWN CLOCK, never the host's. Its distance from the host's clock is the freshness figure the panel draws, and that subtraction is the CALLER's to make: the engine does not read a wall clock to answer this.
    #[serde(
        rename = "lastEventTs",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub last_event_ts: ::std::option::Option<i64>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub mark: ::std::option::Option<LogMark>,
    ///One row per view source that has served a frame in this generation. A source nobody has subscribed to is ABSENT rather than a row of zeros — the same rule the panel applies to a process type with no process behind it.
    pub serve: ::std::vec::Vec<PerfServeSource>,
    pub status: PerfSnapshotResultStatus,
    ///How long THIS PROCESS has been up. Process metadata, never world state: it survives an attach, which the epoch does not.
    #[serde(rename = "uptimeMs")]
    pub uptime_ms: i64,
}
///`PerfSnapshotResultStatus`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "starting",
///    "attaching",
///    "folding",
///    "live",
///    "idle"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum PerfSnapshotResultStatus {
    #[serde(rename = "starting")]
    Starting,
    #[serde(rename = "attaching")]
    Attaching,
    #[serde(rename = "folding")]
    Folding,
    #[serde(rename = "live")]
    Live,
    #[serde(rename = "idle")]
    Idle,
}
impl ::std::fmt::Display for PerfSnapshotResultStatus {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Starting => f.write_str("starting"),
            Self::Attaching => f.write_str("attaching"),
            Self::Folding => f.write_str("folding"),
            Self::Live => f.write_str("live"),
            Self::Idle => f.write_str("idle"),
        }
    }
}
impl ::std::str::FromStr for PerfSnapshotResultStatus {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "starting" => Ok(Self::Starting),
            "attaching" => Ok(Self::Attaching),
            "folding" => Ok(Self::Folding),
            "live" => Ok(Self::Live),
            "idle" => Ok(Self::Idle),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for PerfSnapshotResultStatus {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for PerfSnapshotResultStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for PerfSnapshotResultStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///THE RECENT HISTORY BEHIND `perf.snapshot`'s TOTALS (owner ruling 19 surface, JOS-502). A snapshot is cumulative for the generation, so two of them a minute apart cannot say WHEN the serve path was slow - this is the same instrument sampled on a beat and kept in a BOUNDED RING, which is the whole difference between a history and a leak. The ring is fixed-capacity and overwrites its oldest entry, so an engine up for a week costs exactly what one up for a minute costs; `capacity` is on the answer so a reader can see the horizon rather than infer it. Same door and same cost as `perf.snapshot`, and THE APP MUST NOT POLL THIS IDLY for the same reason.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "PerfTimelineRequest",
///  "description": "THE RECENT HISTORY BEHIND `perf.snapshot`'s TOTALS (owner ruling 19 surface, JOS-502). A snapshot is cumulative for the generation, so two of them a minute apart cannot say WHEN the serve path was slow - this is the same instrument sampled on a beat and kept in a BOUNDED RING, which is the whole difference between a history and a leak. The ring is fixed-capacity and overwrites its oldest entry, so an engine up for a week costs exactly what one up for a minute costs; `capacity` is on the answer so a reader can see the horizon rather than infer it. Same door and same cost as `perf.snapshot`, and THE APP MUST NOT POLL THIS IDLY for the same reason.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "perf.timeline"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/NoParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct PerfTimelineRequest {
    pub id: RequestId,
    pub op: PerfTimelineRequestOp,
    pub params: NoParams,
}
///`PerfTimelineRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "perf.timeline"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum PerfTimelineRequestOp {
    #[serde(rename = "perf.timeline")]
    PerfTimeline,
}
impl ::std::fmt::Display for PerfTimelineRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::PerfTimeline => f.write_str("perf.timeline"),
        }
    }
}
impl ::std::str::FromStr for PerfTimelineRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "perf.timeline" => Ok(Self::PerfTimeline),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for PerfTimelineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for PerfTimelineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for PerfTimelineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///The ring as it stands, oldest moment first, for the generation named by `epoch`. It restates neither `status` nor `uptimeMs` for the reason `PerfBudgetsResult` gives at length. AN EMPTY TIMELINE IS AN HONEST ANSWER and the commonest one: the ring is filled by the ingest thread's own beat, so an engine with nothing attached has taken no samples, and a panel opened three seconds after launch sees a horizon it will fill rather than a defect.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "PerfTimelineResult",
///  "description": "The ring as it stands, oldest moment first, for the generation named by `epoch`. It restates neither `status` nor `uptimeMs` for the reason `PerfBudgetsResult` gives at length. AN EMPTY TIMELINE IS AN HONEST ANSWER and the commonest one: the ring is filled by the ingest thread's own beat, so an engine with nothing attached has taken no samples, and a panel opened three seconds after launch sees a horizon it will fill rather than a defect.",
///  "type": "object",
///  "required": [
///    "cadenceMs",
///    "capacity",
///    "epoch",
///    "timeline"
///  ],
///  "properties": {
///    "cadenceMs": {
///      "description": "The NOMINAL interval between samples. Each moment also carries the span it actually covered, because a thread that was busy takes its sample late and a timeline that reported only the nominal figure would quietly turn a stall into a shorter-looking window.",
///      "type": "integer"
///    },
///    "capacity": {
///      "description": "How many moments the ring holds before it starts overwriting. The bound, stated rather than implied - a client that wanted to know how far back the history reaches would otherwise have to guess from the length, which is wrong for the whole first period of every generation.",
///      "type": "integer"
///    },
///    "epoch": {
///      "$ref": "#/$defs/Epoch"
///    },
///    "timeline": {
///      "description": "The moments, OLDEST FIRST, at most `capacity` of them. Order is the server's and a caller re-sorting it would be munging a served view (ruling 4); a panel wanting newest-first draws it backwards rather than sorting it.",
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/PerfMoment"
///      }
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct PerfTimelineResult {
    ///The NOMINAL interval between samples. Each moment also carries the span it actually covered, because a thread that was busy takes its sample late and a timeline that reported only the nominal figure would quietly turn a stall into a shorter-looking window.
    #[serde(rename = "cadenceMs")]
    pub cadence_ms: i64,
    ///How many moments the ring holds before it starts overwriting. The bound, stated rather than implied - a client that wanted to know how far back the history reaches would otherwise have to guess from the length, which is wrong for the whole first period of every generation.
    pub capacity: i64,
    pub epoch: Epoch,
    ///The moments, OLDEST FIRST, at most `capacity` of them. Order is the server's and a caller re-sorting it would be munging a served view (ruling 4); a panel wanting newest-first draws it backwards rather than sorting it.
    pub timeline: ::std::vec::Vec<PerfMoment>,
}
///`ProtocolError`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ProtocolError",
///  "type": "object",
///  "required": [
///    "code",
///    "message"
///  ],
///  "properties": {
///    "code": {
///      "$ref": "#/$defs/ErrorCode"
///    },
///    "message": {
///      "description": "Human-readable, for a log line and a bug report. Never parsed — branch on `code`.",
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProtocolError {
    pub code: ErrorCode,
    ///Human-readable, for a log line and a bug report. Never parsed — branch on `code`.
    pub message: ::std::string::String,
}
///Anything that can travel the wire, in either direction. The transport adapters are generic over exactly this: a transport moves ProtocolMessages and knows nothing else about the protocol.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "$id": "https://everquest-companion.local/protocol",
///  "title": "ProtocolMessage",
///  "description": "Anything that can travel the wire, in either direction. The transport adapters are generic over exactly this: a transport moves ProtocolMessages and knows nothing else about the protocol.",
///  "oneOf": [
///    {
///      "$ref": "#/$defs/ClientMessage"
///    },
///    {
///      "$ref": "#/$defs/EngineMessage"
///    }
///  ]
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum ProtocolMessage {
    ClientMessage(ClientMessage),
    EngineMessage(EngineMessage),
}
impl ::std::convert::From<ClientMessage> for ProtocolMessage {
    fn from(value: ClientMessage) -> Self {
        Self::ClientMessage(value)
    }
}
impl ::std::convert::From<EngineMessage> for ProtocolMessage {
    fn from(value: EngineMessage) -> Self {
        Self::EngineMessage(value)
    }
}
///A successful answer to one request.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "Reply",
///  "description": "A successful answer to one request.",
///  "type": "object",
///  "required": [
///    "id",
///    "kind",
///    "ok",
///    "result"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "kind": {
///      "type": "string",
///      "enum": [
///        "reply"
///      ]
///    },
///    "ok": {
///      "type": "boolean",
///      "enum": [
///        true
///      ]
///    },
///    "result": {
///      "$ref": "#/$defs/ReplyResult"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Reply {
    pub id: RequestId,
    pub kind: ReplyKind,
    pub ok: bool,
    pub result: ReplyResult,
}
///`ReplyKind`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "reply"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum ReplyKind {
    #[serde(rename = "reply")]
    Reply,
}
impl ::std::fmt::Display for ReplyKind {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Reply => f.write_str("reply"),
        }
    }
}
impl ::std::str::FromStr for ReplyKind {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "reply" => Ok(Self::Reply),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ReplyKind {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ReplyKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ReplyKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///THE RESULT REGISTRY, and it is CLOSED. Which shape a reply carries is decided by the OP of the request whose id it names - the envelope does not repeat it, because a reply that had to restate its own op would be a second place for the two to disagree. This list is the additive seam for the eight API surfaces: a new op adds an arm and nothing else in the envelope moves. There is deliberately NO open arm for a shape this build does not know: both sides generate from this one artifact and a protocolVersion mismatch is fatal at hello, so an engine that could answer with an unnamed shape is an engine this client already refused to talk to. A wildcard arm would also make the whole list unusable - an open object matches every named shape too, so `oneOf` could never pick one.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ReplyResult",
///  "description": "THE RESULT REGISTRY, and it is CLOSED. Which shape a reply carries is decided by the OP of the request whose id it names - the envelope does not repeat it, because a reply that had to restate its own op would be a second place for the two to disagree. This list is the additive seam for the eight API surfaces: a new op adds an arm and nothing else in the envelope moves. There is deliberately NO open arm for a shape this build does not know: both sides generate from this one artifact and a protocolVersion mismatch is fatal at hello, so an engine that could answer with an unnamed shape is an engine this client already refused to talk to. A wildcard arm would also make the whole list unusable - an open object matches every named shape too, so `oneOf` could never pick one.",
///  "oneOf": [
///    {
///      "$ref": "#/$defs/EchoResult"
///    },
///    {
///      "$ref": "#/$defs/HealthResult"
///    },
///    {
///      "$ref": "#/$defs/AttachResult"
///    },
///    {
///      "$ref": "#/$defs/SubscribeAck"
///    },
///    {
///      "$ref": "#/$defs/ModuleSnapshotResult"
///    },
///    {
///      "$ref": "#/$defs/PerfSnapshotResult"
///    },
///    {
///      "$ref": "#/$defs/PerfBudgetsResult"
///    },
///    {
///      "$ref": "#/$defs/PerfTimelineResult"
///    },
///    {
///      "$ref": "#/$defs/DefineAck"
///    },
///    {
///      "$ref": "#/$defs/CombatSnapshotResult"
///    },
///    {
///      "$ref": "#/$defs/CombatSearchFightsResult"
///    },
///    {
///      "$ref": "#/$defs/KnowledgeResult"
///    },
///    {
///      "$ref": "#/$defs/KnowledgeSearchResult"
///    },
///    {
///      "$ref": "#/$defs/SessionMarkAck"
///    },
///    {
///      "$ref": "#/$defs/RespawnConfirmAck"
///    },
///    {
///      "$ref": "#/$defs/ResistLevelsResult"
///    },
///    {
///      "$ref": "#/$defs/ResistSpellResult"
///    },
///    {
///      "$ref": "#/$defs/SpellsSearchResult"
///    },
///    {
///      "$ref": "#/$defs/LogsListResult"
///    }
///  ]
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum ReplyResult {
    EchoResult(EchoResult),
    HealthResult(HealthResult),
    AttachResult(AttachResult),
    SubscribeAck(SubscribeAck),
    ModuleSnapshotResult(ModuleSnapshotResult),
    PerfSnapshotResult(PerfSnapshotResult),
    PerfBudgetsResult(PerfBudgetsResult),
    PerfTimelineResult(PerfTimelineResult),
    DefineAck(DefineAck),
    CombatSnapshotResult(CombatSnapshotResult),
    CombatSearchFightsResult(CombatSearchFightsResult),
    KnowledgeResult(KnowledgeResult),
    KnowledgeSearchResult(KnowledgeSearchResult),
    SessionMarkAck(SessionMarkAck),
    RespawnConfirmAck(RespawnConfirmAck),
    ResistLevelsResult(ResistLevelsResult),
    ResistSpellResult(ResistSpellResult),
    SpellsSearchResult(SpellsSearchResult),
    LogsListResult(LogsListResult),
}
impl ::std::convert::From<EchoResult> for ReplyResult {
    fn from(value: EchoResult) -> Self {
        Self::EchoResult(value)
    }
}
impl ::std::convert::From<HealthResult> for ReplyResult {
    fn from(value: HealthResult) -> Self {
        Self::HealthResult(value)
    }
}
impl ::std::convert::From<AttachResult> for ReplyResult {
    fn from(value: AttachResult) -> Self {
        Self::AttachResult(value)
    }
}
impl ::std::convert::From<SubscribeAck> for ReplyResult {
    fn from(value: SubscribeAck) -> Self {
        Self::SubscribeAck(value)
    }
}
impl ::std::convert::From<ModuleSnapshotResult> for ReplyResult {
    fn from(value: ModuleSnapshotResult) -> Self {
        Self::ModuleSnapshotResult(value)
    }
}
impl ::std::convert::From<PerfSnapshotResult> for ReplyResult {
    fn from(value: PerfSnapshotResult) -> Self {
        Self::PerfSnapshotResult(value)
    }
}
impl ::std::convert::From<PerfBudgetsResult> for ReplyResult {
    fn from(value: PerfBudgetsResult) -> Self {
        Self::PerfBudgetsResult(value)
    }
}
impl ::std::convert::From<PerfTimelineResult> for ReplyResult {
    fn from(value: PerfTimelineResult) -> Self {
        Self::PerfTimelineResult(value)
    }
}
impl ::std::convert::From<DefineAck> for ReplyResult {
    fn from(value: DefineAck) -> Self {
        Self::DefineAck(value)
    }
}
impl ::std::convert::From<CombatSnapshotResult> for ReplyResult {
    fn from(value: CombatSnapshotResult) -> Self {
        Self::CombatSnapshotResult(value)
    }
}
impl ::std::convert::From<CombatSearchFightsResult> for ReplyResult {
    fn from(value: CombatSearchFightsResult) -> Self {
        Self::CombatSearchFightsResult(value)
    }
}
impl ::std::convert::From<KnowledgeResult> for ReplyResult {
    fn from(value: KnowledgeResult) -> Self {
        Self::KnowledgeResult(value)
    }
}
impl ::std::convert::From<KnowledgeSearchResult> for ReplyResult {
    fn from(value: KnowledgeSearchResult) -> Self {
        Self::KnowledgeSearchResult(value)
    }
}
impl ::std::convert::From<SessionMarkAck> for ReplyResult {
    fn from(value: SessionMarkAck) -> Self {
        Self::SessionMarkAck(value)
    }
}
impl ::std::convert::From<RespawnConfirmAck> for ReplyResult {
    fn from(value: RespawnConfirmAck) -> Self {
        Self::RespawnConfirmAck(value)
    }
}
impl ::std::convert::From<ResistLevelsResult> for ReplyResult {
    fn from(value: ResistLevelsResult) -> Self {
        Self::ResistLevelsResult(value)
    }
}
impl ::std::convert::From<ResistSpellResult> for ReplyResult {
    fn from(value: ResistSpellResult) -> Self {
        Self::ResistSpellResult(value)
    }
}
impl ::std::convert::From<SpellsSearchResult> for ReplyResult {
    fn from(value: SpellsSearchResult) -> Self {
        Self::SpellsSearchResult(value)
    }
}
impl ::std::convert::From<LogsListResult> for ReplyResult {
    fn from(value: LogsListResult) -> Self {
        Self::LogsListResult(value)
    }
}
///Client-chosen correlation id. A reply carries the id of its request; every stream message carries the id of the subscribe request that opened it.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "RequestId",
///  "description": "Client-chosen correlation id. A reply carries the id of its request; every stream message carries the id of the subscribe request that opened it.",
///  "type": "integer"
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(transparent)]
pub struct RequestId(pub i64);
impl ::std::ops::Deref for RequestId {
    type Target = i64;
    fn deref(&self) -> &i64 {
        &self.0
    }
}
impl ::std::convert::From<RequestId> for i64 {
    fn from(value: RequestId) -> Self {
        value.0
    }
}
impl ::std::convert::From<i64> for RequestId {
    fn from(value: i64) -> Self {
        Self(value)
    }
}
impl ::std::str::FromStr for RequestId {
    type Err = <i64 as ::std::str::FromStr>::Err;
    fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
        Ok(Self(value.parse()?))
    }
}
impl ::std::convert::TryFrom<&str> for RequestId {
    type Error = <i64 as ::std::str::FromStr>::Err;
    fn try_from(value: &str) -> ::std::result::Result<Self, Self::Error> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<String> for RequestId {
    type Error = <i64 as ::std::str::FromStr>::Err;
    fn try_from(value: String) -> ::std::result::Result<Self, Self::Error> {
        value.parse()
    }
}
impl ::std::fmt::Display for RequestId {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        self.0.fmt(f)
    }
}
///The whole window, as of now. Every subscription opens with one, and every epoch bump produces a new one once the fold lands.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ResetMessage",
///  "description": "The whole window, as of now. Every subscription opens with one, and every epoch bump produces a new one once the fold lands.",
///  "type": "object",
///  "required": [
///    "epoch",
///    "id",
///    "kind",
///    "rows",
///    "total"
///  ],
///  "properties": {
///    "epoch": {
///      "$ref": "#/$defs/Epoch"
///    },
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "kind": {
///      "type": "string",
///      "enum": [
///        "reset"
///      ]
///    },
///    "rows": {
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/Row"
///      }
///    },
///    "total": {
///      "description": "How many rows the view holds in total, ignoring the window — what a `1–50 of 1834` line reads off.",
///      "type": "integer"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ResetMessage {
    pub epoch: Epoch,
    pub id: RequestId,
    pub kind: ResetMessageKind,
    pub rows: ::std::vec::Vec<Row>,
    ///How many rows the view holds in total, ignoring the window — what a `1–50 of 1834` line reads off.
    pub total: i64,
}
///`ResetMessageKind`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "reset"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum ResetMessageKind {
    #[serde(rename = "reset")]
    Reset,
}
impl ::std::fmt::Display for ResetMessageKind {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Reset => f.write_str("reset"),
        }
    }
}
impl ::std::str::FromStr for ResetMessageKind {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "reset" => Ok(Self::Reset),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ResetMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ResetMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ResetMessageKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`shared/resistTypes.ts ResistAxis`. The display order is this list's order and every surface uses all five of it.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ResistAxis",
///  "description": "`shared/resistTypes.ts ResistAxis`. The display order is this list's order and every surface uses all five of it.",
///  "type": "string",
///  "enum": [
///    "magic",
///    "fire",
///    "cold",
///    "poison",
///    "disease"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum ResistAxis {
    #[serde(rename = "magic")]
    Magic,
    #[serde(rename = "fire")]
    Fire,
    #[serde(rename = "cold")]
    Cold,
    #[serde(rename = "poison")]
    Poison,
    #[serde(rename = "disease")]
    Disease,
}
impl ::std::fmt::Display for ResistAxis {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Magic => f.write_str("magic"),
            Self::Fire => f.write_str("fire"),
            Self::Cold => f.write_str("cold"),
            Self::Poison => f.write_str("poison"),
            Self::Disease => f.write_str("disease"),
        }
    }
}
impl ::std::str::FromStr for ResistAxis {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "magic" => Ok(Self::Magic),
            "fire" => Ok(Self::Fire),
            "cold" => Ok(Self::Cold),
            "poison" => Ok(Self::Poison),
            "disease" => Ok(Self::Disease),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ResistAxis {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ResistAxis {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ResistAxis {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`shared/resistTypes.ts ResistAxisBenchmark` — the answer at the estimate, and the answer at each end of the interval, so a surface prints the uncertainty in the reader's own units. `atLo` is the OPTIMISTIC end (the low R) and `atHi` the pessimistic one: the interval's ends CROSS when they are mapped through the level formula, and naming them after the R they came from is what stops a surface printing the range backwards.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ResistAxisBenchmark",
///  "description": "`shared/resistTypes.ts ResistAxisBenchmark` — the answer at the estimate, and the answer at each end of the interval, so a surface prints the uncertainty in the reader's own units. `atLo` is the OPTIMISTIC end (the low R) and `atHi` the pessimistic one: the interval's ends CROSS when they are mapped through the level formula, and naming them after the R they came from is what stops a surface printing the range backwards.",
///  "type": "object",
///  "required": [
///    "atHi",
///    "atLo",
///    "atMobLevel",
///    "guidance",
///    "level",
///    "mobLevel",
///    "pOver",
///    "pPlain",
///    "tag"
///  ],
///  "properties": {
///    "atHi": {
///      "$ref": "#/$defs/ResistBenchmark"
///    },
///    "atLo": {
///      "$ref": "#/$defs/ResistBenchmark"
///    },
///    "atMobLevel": {
///      "type": "boolean"
///    },
///    "guidance": {
///      "$ref": "#/$defs/ResistGuidance"
///    },
///    "level": {
///      "type": "integer"
///    },
///    "mobLevel": {
///      "type": [
///        "integer",
///        "null"
///      ]
///    },
///    "pOver": {
///      "type": "number"
///    },
///    "pPlain": {
///      "type": "number"
///    },
///    "tag": {
///      "$ref": "#/$defs/ResistTag"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ResistAxisBenchmark {
    #[serde(rename = "atHi")]
    pub at_hi: ResistBenchmark,
    #[serde(rename = "atLo")]
    pub at_lo: ResistBenchmark,
    #[serde(rename = "atMobLevel")]
    pub at_mob_level: bool,
    pub guidance: ResistGuidance,
    pub level: i64,
    #[serde(rename = "mobLevel")]
    pub mob_level: ::std::option::Option<i64>,
    #[serde(rename = "pOver")]
    pub p_over: f64,
    #[serde(rename = "pPlain")]
    pub p_plain: f64,
    pub tag: ResistTag,
}
///ONE EVALUATION OF THE BENCHMARK (`shared/resistTypes.ts ResistBenchmark`): the two probabilities the tag is drawn from, and how they were evaluated. `level` is the caster level `rc0` was computed at; `atMobLevel` says the viewer's own level was not known, so the benchmark is an EVEN-LEVEL cast and the surfaces say `at the mob's level`.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ResistBenchmark",
///  "description": "ONE EVALUATION OF THE BENCHMARK (`shared/resistTypes.ts ResistBenchmark`): the two probabilities the tag is drawn from, and how they were evaluated. `level` is the caster level `rc0` was computed at; `atMobLevel` says the viewer's own level was not known, so the benchmark is an EVEN-LEVEL cast and the surfaces say `at the mob's level`.",
///  "type": "object",
///  "required": [
///    "atMobLevel",
///    "guidance",
///    "level",
///    "mobLevel",
///    "pOver",
///    "pPlain",
///    "tag"
///  ],
///  "properties": {
///    "atMobLevel": {
///      "type": "boolean"
///    },
///    "guidance": {
///      "$ref": "#/$defs/ResistGuidance"
///    },
///    "level": {
///      "type": "integer"
///    },
///    "mobLevel": {
///      "type": [
///        "integer",
///        "null"
///      ]
///    },
///    "pOver": {
///      "description": "The same, with the overchannel invocation up.",
///      "type": "number"
///    },
///    "pPlain": {
///      "description": "P(a rank-0, adjust-0, all-or-nothing spell lands), 0 to 1.",
///      "type": "number"
///    },
///    "tag": {
///      "$ref": "#/$defs/ResistTag"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ResistBenchmark {
    #[serde(rename = "atMobLevel")]
    pub at_mob_level: bool,
    pub guidance: ResistGuidance,
    pub level: i64,
    #[serde(rename = "mobLevel")]
    pub mob_level: ::std::option::Option<i64>,
    ///The same, with the overchannel invocation up.
    #[serde(rename = "pOver")]
    pub p_over: f64,
    ///P(a rank-0, adjust-0, all-or-nothing spell lands), 0 to 1.
    #[serde(rename = "pPlain")]
    pub p_plain: f64,
    pub tag: ResistTag,
}
///What the informative observations said, with no model in the way: how many there were and how many of them resisted.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ResistEmpirical",
///  "description": "What the informative observations said, with no model in the way: how many there were and how many of them resisted.",
///  "type": "object",
///  "required": [
///    "resisted",
///    "total"
///  ],
///  "properties": {
///    "resisted": {
///      "type": "integer"
///    },
///    "total": {
///      "type": "integer"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ResistEmpirical {
    pub resisted: i64,
    pub total: i64,
}
///The posterior's point estimate and the ends of its 95% interval, in resist points. Clamped at zero for DISPLAY app-side — the grid runs below zero because `rc` does, and `R -150` is noise on a card while `R 0` is the same statement in the reader's units.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ResistFit",
///  "description": "The posterior's point estimate and the ends of its 95% interval, in resist points. Clamped at zero for DISPLAY app-side — the grid runs below zero because `rc` does, and `R -150` is noise on a card while `R 0` is the same statement in the reader's units.",
///  "type": "object",
///  "required": [
///    "R",
///    "hi",
///    "lo"
///  ],
///  "properties": {
///    "R": {
///      "type": "number"
///    },
///    "hi": {
///      "type": "number"
///    },
///    "lo": {
///      "type": "number"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ResistFit {
    pub hi: f64,
    pub lo: f64,
    #[serde(rename = "R")]
    pub r: f64,
}
///`shared/resistTypes.ts ResistGuidance` — the sentence under the word. The same three bands read twice: `resistant` means `needs overchannel`, every time, on every surface.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ResistGuidance",
///  "description": "`shared/resistTypes.ts ResistGuidance` — the sentence under the word. The same three bands read twice: `resistant` means `needs overchannel`, every time, on every surface.",
///  "type": "string",
///  "enum": [
///    "should land",
///    "needs overchannel",
///    "may not land even with overchannel"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum ResistGuidance {
    #[serde(rename = "should land")]
    ShouldLand,
    #[serde(rename = "needs overchannel")]
    NeedsOverchannel,
    #[serde(rename = "may not land even with overchannel")]
    MayNotLandEvenWithOverchannel,
}
impl ::std::fmt::Display for ResistGuidance {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::ShouldLand => f.write_str("should land"),
            Self::NeedsOverchannel => f.write_str("needs overchannel"),
            Self::MayNotLandEvenWithOverchannel => {
                f.write_str("may not land even with overchannel")
            }
        }
    }
}
impl ::std::str::FromStr for ResistGuidance {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "should land" => Ok(Self::ShouldLand),
            "needs overchannel" => Ok(Self::NeedsOverchannel),
            "may not land even with overchannel" => Ok(Self::MayNotLandEvenWithOverchannel),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ResistGuidance {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ResistGuidance {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ResistGuidance {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///WHO SAID SO, and the order is the fold's own precedence: a `/con` this session beats the committed catalog beats nothing. It reaches the card as prose (`level 52, from a con`), so it is a closed set rather than free text.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ResistLevelSource",
///  "description": "WHO SAID SO, and the order is the fold's own precedence: a `/con` this session beats the committed catalog beats nothing. It reaches the card as prose (`level 52, from a con`), so it is a closed set rather than free text.",
///  "type": "string",
///  "enum": [
///    "con",
///    "catalog"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum ResistLevelSource {
    #[serde(rename = "con")]
    Con,
    #[serde(rename = "catalog")]
    Catalog,
}
impl ::std::fmt::Display for ResistLevelSource {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Con => f.write_str("con"),
            Self::Catalog => f.write_str("catalog"),
        }
    }
}
impl ::std::str::FromStr for ResistLevelSource {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "con" => Ok(Self::Con),
            "catalog" => Ok(Self::Catalog),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ResistLevelSource {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ResistLevelSource {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ResistLevelSource {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///The creatures to answer for, spelled as the log spells them. PLURAL FOR A REASON THAT IS NOT SPECULATION: a resist card asks about one mob, and the con card asks about one mob, but a caller holding several in flight is a round trip per card on a page that draws a list - and the answer is a handful of integers per name, so the batch costs nothing the singular form would have saved. The list is BOUNDED (`maxItems`) and an over-long one is refused by name as `badParams` rather than silently truncated: a caller that believed it asked about forty creatures and was answered about eight has no way to notice.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ResistLevelsParams",
///  "description": "The creatures to answer for, spelled as the log spells them. PLURAL FOR A REASON THAT IS NOT SPECULATION: a resist card asks about one mob, and the con card asks about one mob, but a caller holding several in flight is a round trip per card on a page that draws a list - and the answer is a handful of integers per name, so the batch costs nothing the singular form would have saved. The list is BOUNDED (`maxItems`) and an over-long one is refused by name as `badParams` rather than silently truncated: a caller that believed it asked about forty creatures and was answered about eight has no way to notice.",
///  "type": "object",
///  "required": [
///    "mobs"
///  ],
///  "properties": {
///    "mobs": {
///      "type": "array",
///      "items": {
///        "type": "string"
///      },
///      "maxItems": 32,
///      "minItems": 1
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ResistLevelsParams {
    pub mobs: ::std::vec::Vec<::std::string::String>,
}
///HOW OLD IS THIS CREATURE, as the resist fold knows it (JOS-497 item 1, cutover ledger item 6). The LAST synchronous main-side read of the app's own fold, and the reason it needed an op of its own rather than a mirror or a view. IT IS NOT A MIRROR. `serveMirrors.ts` holds a module's WHOLE published state, refreshed on the engine's own cursor; the resist module publishes two integers (`{rows, mobs}`) and this fact is in neither of them. Nor could a mirror carry it: the answer is keyed by creature name, so mirroring it would mean holding an unbounded map of every mob anybody has ever conned. IT IS NOT A VIEW EITHER. A view is filtered, sorted and windowed, and this is a point lookup keyed by a name the asker already has - `knowledge.mob`'s shape, not `kills.recent`'s. So it is an op, and the ledger's own rule about names applies: the caller sends the name as the LOG spells it and this engine folds the key, because a pre-folded key would be a second opinion about a join key (`mobKey`, then the verified alias roster).
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ResistLevelsRequest",
///  "description": "HOW OLD IS THIS CREATURE, as the resist fold knows it (JOS-497 item 1, cutover ledger item 6). The LAST synchronous main-side read of the app's own fold, and the reason it needed an op of its own rather than a mirror or a view. IT IS NOT A MIRROR. `serveMirrors.ts` holds a module's WHOLE published state, refreshed on the engine's own cursor; the resist module publishes two integers (`{rows, mobs}`) and this fact is in neither of them. Nor could a mirror carry it: the answer is keyed by creature name, so mirroring it would mean holding an unbounded map of every mob anybody has ever conned. IT IS NOT A VIEW EITHER. A view is filtered, sorted and windowed, and this is a point lookup keyed by a name the asker already has - `knowledge.mob`'s shape, not `kills.recent`'s. So it is an op, and the ledger's own rule about names applies: the caller sends the name as the LOG spells it and this engine folds the key, because a pre-folded key would be a second opinion about a join key (`mobKey`, then the verified alias roster).",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "resist.levels"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/ResistLevelsParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ResistLevelsRequest {
    pub id: RequestId,
    pub op: ResistLevelsRequestOp,
    pub params: ResistLevelsParams,
}
///`ResistLevelsRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "resist.levels"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum ResistLevelsRequestOp {
    #[serde(rename = "resist.levels")]
    ResistLevels,
}
impl ::std::fmt::Display for ResistLevelsRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::ResistLevels => f.write_str("resist.levels"),
        }
    }
}
impl ::std::str::FromStr for ResistLevelsRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "resist.levels" => Ok(Self::ResistLevels),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ResistLevelsRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ResistLevelsRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ResistLevelsRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///What the fold can state about each creature asked about. A CREATURE WITH NO LEVEL SIMPLY HAS NO ROW, which is why nothing here is nullable: `resist/world.ts levelOf` answers `null` for a mob nobody has conned and the committed catalog has never heard of, and an entry carrying four absent fields would be that same absence spelled less clearly. The caller maps name to row and reads a miss as the null it already handles. ORDER IS NOT PROMISED and `mob` is echoed on every row for exactly that reason - the same bookkeeping-free rule `KnowledgeResult.name` states.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ResistLevelsResult",
///  "description": "What the fold can state about each creature asked about. A CREATURE WITH NO LEVEL SIMPLY HAS NO ROW, which is why nothing here is nullable: `resist/world.ts levelOf` answers `null` for a mob nobody has conned and the committed catalog has never heard of, and an entry carrying four absent fields would be that same absence spelled less clearly. The caller maps name to row and reads a miss as the null it already handles. ORDER IS NOT PROMISED and `mob` is echoed on every row for exactly that reason - the same bookkeeping-free rule `KnowledgeResult.name` states.",
///  "type": "object",
///  "required": [
///    "levels"
///  ],
///  "properties": {
///    "levels": {
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/ResistMobLevel"
///      }
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ResistLevelsResult {
    pub levels: ::std::vec::Vec<ResistMobLevel>,
}
///`src/main/resist/world.ts MobLevelFact`, plus the name it answers for. `level` is what the estimator uses - the stated level, or a range's MIDPOINT - and `lo`/`hi` are the range it came from, which the resist card prints as `level 39 - 43` rather than as the midpoint it fits against. They are equal for a `/con`, because the game just said the number.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ResistMobLevel",
///  "description": "`src/main/resist/world.ts MobLevelFact`, plus the name it answers for. `level` is what the estimator uses - the stated level, or a range's MIDPOINT - and `lo`/`hi` are the range it came from, which the resist card prints as `level 39 - 43` rather than as the midpoint it fits against. They are equal for a `/con`, because the game just said the number.",
///  "type": "object",
///  "required": [
///    "from",
///    "hi",
///    "level",
///    "lo",
///    "mob"
///  ],
///  "properties": {
///    "from": {
///      "$ref": "#/$defs/ResistLevelSource"
///    },
///    "hi": {
///      "type": "integer"
///    },
///    "level": {
///      "description": "What the estimator fits against: the stated level, or `Math.round((lo + hi) / 2)` for a catalog range.",
///      "type": "integer"
///    },
///    "lo": {
///      "type": "integer"
///    },
///    "mob": {
///      "description": "The name as it was asked for, echoed back unchanged - never the folded key.",
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ResistMobLevel {
    pub from: ResistLevelSource,
    pub hi: i64,
    ///What the estimator fits against: the stated level, or `Math.round((lo + hi) / 2)` for a catalog range.
    pub level: i64,
    pub lo: i64,
    ///The name as it was asked for, echoed back unchanged - never the folded key.
    pub mob: ::std::string::String,
}
///ONE SPELL OUT OF THE CLIENT'S OWN TABLE (boundary verdict 7, JOS-497 item 3). `<eqRoot>/spells_us.txt` is the only source that states how a spell is RESISTED - the wiki-scraped corpus this repo ships knows a spell's messages and neither its resist type nor its resist adjust - and the engine reads the player's own copy, derived from the attach's log path (`<eqRoot>/Logs/<log>` up two). THIS IS A PER-SPELL OP AND THERE WILL NEVER BE A BULK ONE, which is a RULING rather than a phase: the owner's own parsed table is 48,252 entries and 6.13 MiB of JSON against an 8 MiB frame ceiling, on one machine, against a table that grows with every client patch, so a single reply serving the whole table is a design with a date on it (measured 2026-08-25). It is a `resist.*` op rather than an extension of `knowledge.spell` because the two answer about different SOURCES: `knowledge.spell` serves the committed wiki scrape with removals, corrections and derived durations applied, and this serves Daybreak's file. A caller asking `how is this resisted` and a caller asking `what does the wiki say` must be able to tell which one answered, and merging them into one record would make that unanswerable from the value. NOTHING DERIVED FROM THE FILE IS EVER COMMITTED, which is why every test on either side is driven by hand-authored rows.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ResistSpellRequest",
///  "description": "ONE SPELL OUT OF THE CLIENT'S OWN TABLE (boundary verdict 7, JOS-497 item 3). `<eqRoot>/spells_us.txt` is the only source that states how a spell is RESISTED - the wiki-scraped corpus this repo ships knows a spell's messages and neither its resist type nor its resist adjust - and the engine reads the player's own copy, derived from the attach's log path (`<eqRoot>/Logs/<log>` up two). THIS IS A PER-SPELL OP AND THERE WILL NEVER BE A BULK ONE, which is a RULING rather than a phase: the owner's own parsed table is 48,252 entries and 6.13 MiB of JSON against an 8 MiB frame ceiling, on one machine, against a table that grows with every client patch, so a single reply serving the whole table is a design with a date on it (measured 2026-08-25). It is a `resist.*` op rather than an extension of `knowledge.spell` because the two answer about different SOURCES: `knowledge.spell` serves the committed wiki scrape with removals, corrections and derived durations applied, and this serves Daybreak's file. A caller asking `how is this resisted` and a caller asking `what does the wiki say` must be able to tell which one answered, and merging them into one record would make that unanswerable from the value. NOTHING DERIVED FROM THE FILE IS EVER COMMITTED, which is why every test on either side is driven by hand-authored rows.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "resist.spell"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/KnowledgeNameParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ResistSpellRequest {
    pub id: RequestId,
    pub op: ResistSpellRequestOp,
    pub params: KnowledgeNameParams,
}
///`ResistSpellRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "resist.spell"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum ResistSpellRequestOp {
    #[serde(rename = "resist.spell")]
    ResistSpell,
}
impl ::std::fmt::Display for ResistSpellRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::ResistSpell => f.write_str("resist.spell"),
        }
    }
}
impl ::std::str::FromStr for ResistSpellRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "resist.spell" => Ok(Self::ResistSpell),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ResistSpellRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ResistSpellRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ResistSpellRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///What the client's table says about one spell, or why it says nothing. `table` is ALWAYS present and `spell` is present only on a hit, which is the distinction the card needs: `table: missing` means the player has no EverQuest install behind the folder this app was pointed at, and the surface says exactly that and names the path; `table: ok` with no `spell` means the file was read and has no row under this name, which is a different sentence entirely. A client that branched on `spell` alone would tell a player to go and find a folder they are already in.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ResistSpellResult",
///  "description": "What the client's table says about one spell, or why it says nothing. `table` is ALWAYS present and `spell` is present only on a hit, which is the distinction the card needs: `table: missing` means the player has no EverQuest install behind the folder this app was pointed at, and the surface says exactly that and names the path; `table: ok` with no `spell` means the file was read and has no row under this name, which is a different sentence entirely. A client that branched on `spell` alone would tell a player to go and find a folder they are already in.",
///  "type": "object",
///  "required": [
///    "path",
///    "spellName",
///    "table"
///  ],
///  "properties": {
///    "path": {
///      "description": "Where this engine looked. Present always, because the sentence a missing table produces has to name a place.",
///      "type": "string"
///    },
///    "spell": {
///      "$ref": "#/$defs/ClientSpell"
///    },
///    "spellName": {
///      "description": "The name as it was asked for, echoed back - never the folded key.",
///      "type": "string"
///    },
///    "table": {
///      "$ref": "#/$defs/SpellTableState"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ResistSpellResult {
    ///Where this engine looked. Present always, because the sentence a missing table produces has to name a place.
    pub path: ::std::string::String,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub spell: ::std::option::Option<ClientSpell>,
    ///The name as it was asked for, echoed back - never the folded key.
    #[serde(rename = "spellName")]
    pub spell_name: ::std::string::String,
    pub table: SpellTableState,
}
///`shared/resistTypes.ts ResistTag` — the scannable word. NO ACRONYMS, EVER (owner ruling): the axis word is the only label this app prints for an axis, and these four are the only bands.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ResistTag",
///  "description": "`shared/resistTypes.ts ResistTag` — the scannable word. NO ACRONYMS, EVER (owner ruling): the axis word is the only label this app prints for an axis, and these four are the only bands.",
///  "type": "string",
///  "enum": [
///    "weak",
///    "normal",
///    "resistant",
///    "very resistant"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum ResistTag {
    #[serde(rename = "weak")]
    Weak,
    #[serde(rename = "normal")]
    Normal,
    #[serde(rename = "resistant")]
    Resistant,
    #[serde(rename = "very resistant")]
    VeryResistant,
}
impl ::std::fmt::Display for ResistTag {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Weak => f.write_str("weak"),
            Self::Normal => f.write_str("normal"),
            Self::Resistant => f.write_str("resistant"),
            Self::VeryResistant => f.write_str("very resistant"),
        }
    }
}
impl ::std::str::FromStr for ResistTag {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "weak" => Ok(Self::Weak),
            "normal" => Ok(Self::Normal),
            "resistant" => Ok(Self::Resistant),
            "very resistant" => Ok(Self::VeryResistant),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ResistTag {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ResistTag {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ResistTag {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///RE-BASED, OR A NO-OP — and `confirmed: false` IS NOT AN ERROR. It is `respawnModule.confirmSighting`'s own `false` on the wire: the id names no row this fold has, or the row is not currently seen, which is what a click that lost a race with a death looks like. The caller is the app's IPC handler, which has already answered the person from its OWN module's `false`; this ack is a dev-log line and a test's grip, never a branch (`serveCommands.ts`'s fire-and-forget law). IT CARRIES ONE FIELD AND THE NAME IS THE DISCRIMINATOR. `applied` would have made this the seventh member of the `DefineAck` family and unseparable from six other ops by shape — the collision `accepted` walked into when `sessionMarks.add` met `AttachResult`, and `status` walked into twice, taught the guard matrix (`src/shared/dataServer/ops.ts`) that a field two arms carry cannot tell them apart. `confirmed` is this shape's own word: no other result carries it, and it is what the act is called everywhere else in the feature. IT DELIBERATELY DOES NOT SAY WHICH OF THE TWO REFUSALS HAPPENED. The app-side seam answers one boolean for both, and an engine that answered a finer question would be a second opinion about a seam whose whole job is to match — the honest report of what the fold now holds is the module's own state, which the next `module.snapshot` states in full.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "RespawnConfirmAck",
///  "description": "RE-BASED, OR A NO-OP — and `confirmed: false` IS NOT AN ERROR. It is `respawnModule.confirmSighting`'s own `false` on the wire: the id names no row this fold has, or the row is not currently seen, which is what a click that lost a race with a death looks like. The caller is the app's IPC handler, which has already answered the person from its OWN module's `false`; this ack is a dev-log line and a test's grip, never a branch (`serveCommands.ts`'s fire-and-forget law). IT CARRIES ONE FIELD AND THE NAME IS THE DISCRIMINATOR. `applied` would have made this the seventh member of the `DefineAck` family and unseparable from six other ops by shape — the collision `accepted` walked into when `sessionMarks.add` met `AttachResult`, and `status` walked into twice, taught the guard matrix (`src/shared/dataServer/ops.ts`) that a field two arms carry cannot tell them apart. `confirmed` is this shape's own word: no other result carries it, and it is what the act is called everywhere else in the feature. IT DELIBERATELY DOES NOT SAY WHICH OF THE TWO REFUSALS HAPPENED. The app-side seam answers one boolean for both, and an engine that answered a finer question would be a second opinion about a seam whose whole job is to match — the honest report of what the fold now holds is the module's own state, which the next `module.snapshot` states in full.",
///  "type": "object",
///  "required": [
///    "confirmed"
///  ],
///  "properties": {
///    "confirmed": {
///      "description": "True when the fold re-based that row's clock onto its sighting. False when there was nothing to re-base.",
///      "type": "boolean"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct RespawnConfirmAck {
    ///True when the fold re-based that row's clock onto its sighting. False when there was nothing to re-base.
    pub confirmed: bool,
}
///THE ROW, AND NOTHING ELSE — the whole of what the ipc handler takes (`IPC.respawnConfirmSighting`). ONE IDENTIFIER, NO SECOND ADDRESSING SCHEME: `rowId` is the id the surfaces draw and the id the fold keys its history by, so a zone and a mob key spelled separately here would be a second way to name a row and a second thing to keep in step with `RespawnRow.id`. NO INSTANT RIDES THIS COMMAND, which is the one place it differs from `SessionMarkAddParams` and is not an oversight: the instant the clock re-bases onto is the row's OWN `seenTs`, a LOG timestamp the fold already holds, so a caller's clock has nothing to say about it — and handing one over would let the app move an engine clock to a moment the engine's log never stated (ruling 18 law 1, from the other direction).
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "RespawnConfirmSightingParams",
///  "description": "THE ROW, AND NOTHING ELSE — the whole of what the ipc handler takes (`IPC.respawnConfirmSighting`). ONE IDENTIFIER, NO SECOND ADDRESSING SCHEME: `rowId` is the id the surfaces draw and the id the fold keys its history by, so a zone and a mob key spelled separately here would be a second way to name a row and a second thing to keep in step with `RespawnRow.id`. NO INSTANT RIDES THIS COMMAND, which is the one place it differs from `SessionMarkAddParams` and is not an oversight: the instant the clock re-bases onto is the row's OWN `seenTs`, a LOG timestamp the fold already holds, so a caller's clock has nothing to say about it — and handing one over would let the app move an engine clock to a moment the engine's log never stated (ruling 18 law 1, from the other direction).",
///  "type": "object",
///  "required": [
///    "rowId"
///  ],
///  "properties": {
///    "rowId": {
///      "description": "`<zone key>::<mob key>`, exactly as `RespawnRow.id` spells it. VALIDATED AT THE DOOR AND NOT TRUSTED HERE: the ipc handler refuses a non-string, an empty string and anything past 160 chars before this command is ever composed (the `sounds:getData` rule), and the engine's own seam refuses an id its history does not carry — which is the same `false` a stale click gets.",
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct RespawnConfirmSightingParams {
    ///`<zone key>::<mob key>`, exactly as `RespawnRow.id` spells it. VALIDATED AT THE DOOR AND NOT TRUSTED HERE: the ipc handler refuses a non-string, an empty string and anything past 160 chars before this command is ever composed (the `sounds:getData` rule), and the engine's own seam refuses an id its history does not carry — which is the same `false` a stale click gets.
    #[serde(rename = "rowId")]
    pub row_id: ::std::string::String,
}
///"YES, THAT SIGHTING WAS THE SPAWN — START THE CLOCK THERE" (owner ruling, respawn round 3). THE THIRD RESPAWN INPUT AND THE ONLY ONE THAT IS A COMMAND. A death line is the log's; the watch list is a PREFERENCE and rides `respawn.define`, which the world records so the next attach can re-apply it; this is neither. It is a judgement about ONE spawn of ONE mob in ONE session, and `src/main/ipc/respawn.ts` says out loud that it PERSISTS NOTHING — the fold it lives in is rebuilt from the log at every launch and the log has never heard of it, so a stored copy would outlive its subject. THE ENGINE THEREFORE STORES NOTHING EITHER, exactly as `sessionMarks.add` stores nothing and for the identical reason: an impure input that is not persisted cannot make a replay diverge from a live fold, which is what keeps ruling 18's determinism law structural here rather than carefully avoided. It is `sessionMarks.add`'s sibling in every way but one — it CANNOT be refused for being early. A mark cannot enter a replaying fold at all (`combat/engine.ts sessionMark` refuses while hydrating and the ack carries the status it refused under); a confirm has no such law app-side, because `respawnModule.confirmSighting` has exactly two refusals and both are about the ROW rather than about the world. So the ack below says which of `taken` or `nothing to take` happened and nothing about what the fold was doing.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "RespawnConfirmSightingRequest",
///  "description": "\"YES, THAT SIGHTING WAS THE SPAWN — START THE CLOCK THERE\" (owner ruling, respawn round 3). THE THIRD RESPAWN INPUT AND THE ONLY ONE THAT IS A COMMAND. A death line is the log's; the watch list is a PREFERENCE and rides `respawn.define`, which the world records so the next attach can re-apply it; this is neither. It is a judgement about ONE spawn of ONE mob in ONE session, and `src/main/ipc/respawn.ts` says out loud that it PERSISTS NOTHING — the fold it lives in is rebuilt from the log at every launch and the log has never heard of it, so a stored copy would outlive its subject. THE ENGINE THEREFORE STORES NOTHING EITHER, exactly as `sessionMarks.add` stores nothing and for the identical reason: an impure input that is not persisted cannot make a replay diverge from a live fold, which is what keeps ruling 18's determinism law structural here rather than carefully avoided. It is `sessionMarks.add`'s sibling in every way but one — it CANNOT be refused for being early. A mark cannot enter a replaying fold at all (`combat/engine.ts sessionMark` refuses while hydrating and the ack carries the status it refused under); a confirm has no such law app-side, because `respawnModule.confirmSighting` has exactly two refusals and both are about the ROW rather than about the world. So the ack below says which of `taken` or `nothing to take` happened and nothing about what the fold was doing.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "respawn.confirmSighting"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/RespawnConfirmSightingParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct RespawnConfirmSightingRequest {
    pub id: RequestId,
    pub op: RespawnConfirmSightingRequestOp,
    pub params: RespawnConfirmSightingParams,
}
///`RespawnConfirmSightingRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "respawn.confirmSighting"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum RespawnConfirmSightingRequestOp {
    #[serde(rename = "respawn.confirmSighting")]
    RespawnConfirmSighting,
}
impl ::std::fmt::Display for RespawnConfirmSightingRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::RespawnConfirmSighting => f.write_str("respawn.confirmSighting"),
        }
    }
}
impl ::std::str::FromStr for RespawnConfirmSightingRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "respawn.confirmSighting" => Ok(Self::RespawnConfirmSighting),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for RespawnConfirmSightingRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for RespawnConfirmSightingRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for RespawnConfirmSightingRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`RespawnDefineParams`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "RespawnDefineParams",
///  "type": "object",
///  "required": [
///    "prefs"
///  ],
///  "properties": {
///    "prefs": {
///      "$ref": "#/$defs/RespawnPrefs"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct RespawnDefineParams {
    pub prefs: RespawnPrefs,
}
///WHICH MOBS GET A CLOCK (JOS-194) — tracking is opt-in per mob, so this list is the whole of what the respawn fold knows that the log did not tell it.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "RespawnDefineRequest",
///  "description": "WHICH MOBS GET A CLOCK (JOS-194) — tracking is opt-in per mob, so this list is the whole of what the respawn fold knows that the log did not tell it.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "respawn.define"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/RespawnDefineParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct RespawnDefineRequest {
    pub id: RequestId,
    pub op: RespawnDefineRequestOp,
    pub params: RespawnDefineParams,
}
///`RespawnDefineRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "respawn.define"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum RespawnDefineRequestOp {
    #[serde(rename = "respawn.define")]
    RespawnDefine,
}
impl ::std::fmt::Display for RespawnDefineRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::RespawnDefine => f.write_str("respawn.define"),
        }
    }
}
impl ::std::str::FromStr for RespawnDefineRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "respawn.define" => Ok(Self::RespawnDefine),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for RespawnDefineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for RespawnDefineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for RespawnDefineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`src/shared/respawn.ts RespawnPrefs`. An object rather than a bare array because that is the shape the store holds and the shape a later preference would grow into.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "RespawnPrefs",
///  "description": "`src/shared/respawn.ts RespawnPrefs`. An object rather than a bare array because that is the shape the store holds and the shape a later preference would grow into.",
///  "type": "object",
///  "required": [
///    "watches"
///  ],
///  "properties": {
///    "watches": {
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/RespawnWatch"
///      }
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct RespawnPrefs {
    pub watches: ::std::vec::Vec<RespawnWatch>,
}
///One mob the user chose to watch, and the number they typed if they typed one.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "RespawnWatch",
///  "description": "One mob the user chose to watch, and the number they typed if they typed one.",
///  "type": "object",
///  "required": [
///    "display",
///    "key"
///  ],
///  "properties": {
///    "customSec": {
///      "description": "The user's own respawn, in SECONDS. Absent means `use what you learn`, which is a different statement from zero.",
///      "type": "integer"
///    },
///    "display": {
///      "type": "string"
///    },
///    "key": {
///      "description": "Canonical (lowercased) mob name — what a death line's name canonicalizes to.",
///      "type": "string"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct RespawnWatch {
    ///The user's own respawn, in SECONDS. Absent means `use what you learn`, which is a different statement from zero.
    #[serde(
        rename = "customSec",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub custom_sec: ::std::option::Option<i64>,
    pub display: ::std::string::String,
    ///Canonical (lowercased) mob name — what a death line's name canonicalizes to.
    pub key: ::std::string::String,
}
///`RosterDefineParams`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "RosterDefineParams",
///  "type": "object",
///  "required": [
///    "edits"
///  ],
///  "properties": {
///    "edits": {
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/RosterEdit"
///      }
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct RosterDefineParams {
    pub edits: ::std::vec::Vec<RosterEdit>,
}
///THE USER'S GROUP-ROSTER EDITS — names they added the log never named, and names they removed that it did.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "RosterDefineRequest",
///  "description": "THE USER'S GROUP-ROSTER EDITS — names they added the log never named, and names they removed that it did.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "roster.define"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/RosterDefineParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct RosterDefineRequest {
    pub id: RequestId,
    pub op: RosterDefineRequestOp,
    pub params: RosterDefineParams,
}
///`RosterDefineRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "roster.define"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum RosterDefineRequestOp {
    #[serde(rename = "roster.define")]
    RosterDefine,
}
impl ::std::fmt::Display for RosterDefineRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::RosterDefine => f.write_str("roster.define"),
        }
    }
}
impl ::std::str::FromStr for RosterDefineRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "roster.define" => Ok(Self::RosterDefine),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for RosterDefineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for RosterDefineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for RosterDefineRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`src/shared/progressState.ts RosterEdit` — one name, one verb, and the instant the user said it. The instant is load-bearing rather than provenance: an edit older than the last character rebirth, or older than the last `You have been removed from the group.`, described a group that no longer exists and is dropped by the fold rather than by the pusher.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "RosterEdit",
///  "description": "`src/shared/progressState.ts RosterEdit` — one name, one verb, and the instant the user said it. The instant is load-bearing rather than provenance: an edit older than the last character rebirth, or older than the last `You have been removed from the group.`, described a group that no longer exists and is dropped by the fold rather than by the pusher.",
///  "type": "object",
///  "required": [
///    "action",
///    "key",
///    "name",
///    "setAt"
///  ],
///  "properties": {
///    "action": {
///      "type": "string",
///      "enum": [
///        "add",
///        "remove"
///      ]
///    },
///    "key": {
///      "description": "The canonical identity key — `idKey(name)`.",
///      "type": "string"
///    },
///    "name": {
///      "type": "string"
///    },
///    "setAt": {
///      "type": "integer"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct RosterEdit {
    pub action: RosterEditAction,
    ///The canonical identity key — `idKey(name)`.
    pub key: ::std::string::String,
    pub name: ::std::string::String,
    #[serde(rename = "setAt")]
    pub set_at: i64,
}
///`RosterEditAction`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "add",
///    "remove"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum RosterEditAction {
    #[serde(rename = "add")]
    Add,
    #[serde(rename = "remove")]
    Remove,
}
impl ::std::fmt::Display for RosterEditAction {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Add => f.write_str("add"),
            Self::Remove => f.write_str("remove"),
        }
    }
}
impl ::std::str::FromStr for RosterEditAction {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "add" => Ok(Self::Add),
            "remove" => Ok(Self::Remove),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for RosterEditAction {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for RosterEditAction {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for RosterEditAction {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///One render-ready row: its key and its cells. THE KEY IS OUTSIDE THE CELLS on purpose — an `update` op carries `cells` alone, so reset rows and diff updates have to agree on where the identity lives or a client cannot apply a diff to a row it already holds.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "Row",
///  "description": "One render-ready row: its key and its cells. THE KEY IS OUTSIDE THE CELLS on purpose — an `update` op carries `cells` alone, so reset rows and diff updates have to agree on where the identity lives or a client cannot apply a diff to a row it already holds.",
///  "type": "object",
///  "required": [
///    "cells",
///    "key"
///  ],
///  "properties": {
///    "cells": {
///      "$ref": "#/$defs/Cells"
///    },
///    "key": {
///      "$ref": "#/$defs/RowKey"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Row {
    pub cells: Cells,
    pub key: RowKey,
}
///Stable identity of a row within one view, e.g. `loot:9413` or `ally:Primitive`. Unique inside a subscription; meaningless outside it.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "RowKey",
///  "description": "Stable identity of a row within one view, e.g. `loot:9413` or `ally:Primitive`. Unique inside a subscription; meaningless outside it.",
///  "type": "string"
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize, ::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd,
)]
#[serde(transparent)]
pub struct RowKey(pub ::std::string::String);
impl ::std::ops::Deref for RowKey {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<RowKey> for ::std::string::String {
    fn from(value: RowKey) -> Self {
        value.0
    }
}
impl ::std::convert::From<::std::string::String> for RowKey {
    fn from(value: ::std::string::String) -> Self {
        Self(value)
    }
}
impl ::std::str::FromStr for RowKey {
    type Err = ::std::convert::Infallible;
    fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
        Ok(Self(value.to_string()))
    }
}
impl ::std::fmt::Display for RowKey {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        self.0.fmt(f)
    }
}
///`SessionAttachParams`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SessionAttachParams",
///  "type": "object",
///  "required": [
///    "logPath"
///  ],
///  "properties": {
///    "logPath": {
///      "description": "Absolute path to the EverQuest log file. The engine never discovers a path of its own and never reads a settings file — the app owns discovery and pushes the answer in.",
///      "type": "string"
///    },
///    "stateDir": {
///      "description": "WHERE THE ENGINE'S OWN PERSISTED KNOWLEDGE LIVES — Electron's `userData` directory, pushed in because the engine cannot derive it (boundary verdict 4, cutover ledger item 6). Two artifacts are read out of it at attach and written back on the engine's own cadence: `resist-ledger.json` and `message-overlay.json`, both in the app's EXISTING format, verbatim, so the two implementations can hold the same file. IT IS A FIELD OF THE ATTACH RATHER THAN A `*.define`, and the distinction is load-bearing twice over. A define may arrive mid-fold and this may not: the seed has to be in place BEFORE the first byte is folded, because a bucket seeded after the fold began would be added to the fold's own output — the JOS-231 doubling — and because `begin_source` can only discard a bucket it already has. And a state dir that could be changed halfway through a fold would mean the engine could be told to write this log's ledger somewhere else mid-flight, which is not a thing with an honest meaning. It rides `logPath` because it is the same KIND of fact: this world, folded from this log, filed beside this profile. ABSENT MEANS NO PERSISTENCE AT ALL — nothing is read, nothing is written, and the fold is exactly the file-free one the equivalence oracle records. That is the default and it is what every non-app client (the parity runner, every test) gets by saying nothing.",
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SessionAttachParams {
    ///Absolute path to the EverQuest log file. The engine never discovers a path of its own and never reads a settings file — the app owns discovery and pushes the answer in.
    #[serde(rename = "logPath")]
    pub log_path: ::std::string::String,
    ///WHERE THE ENGINE'S OWN PERSISTED KNOWLEDGE LIVES — Electron's `userData` directory, pushed in because the engine cannot derive it (boundary verdict 4, cutover ledger item 6). Two artifacts are read out of it at attach and written back on the engine's own cadence: `resist-ledger.json` and `message-overlay.json`, both in the app's EXISTING format, verbatim, so the two implementations can hold the same file. IT IS A FIELD OF THE ATTACH RATHER THAN A `*.define`, and the distinction is load-bearing twice over. A define may arrive mid-fold and this may not: the seed has to be in place BEFORE the first byte is folded, because a bucket seeded after the fold began would be added to the fold's own output — the JOS-231 doubling — and because `begin_source` can only discard a bucket it already has. And a state dir that could be changed halfway through a fold would mean the engine could be told to write this log's ledger somewhere else mid-flight, which is not a thing with an honest meaning. It rides `logPath` because it is the same KIND of fact: this world, folded from this log, filed beside this profile. ABSENT MEANS NO PERSISTENCE AT ALL — nothing is read, nothing is written, and the fold is exactly the file-free one the equivalence oracle records. That is the default and it is what every non-app client (the parity runner, every test) gets by saying nothing.
    #[serde(
        rename = "stateDir",
        default,
        skip_serializing_if = "::std::option::Option::is_none"
    )]
    pub state_dir: ::std::option::Option<::std::string::String>,
}
///Begins tail + fold of one log. PREEMPTS any in-flight attach — last pick wins, never queued (JOS-457's generation ownership, promoted to protocol law). A successful attach bumps the epoch.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SessionAttachRequest",
///  "description": "Begins tail + fold of one log. PREEMPTS any in-flight attach — last pick wins, never queued (JOS-457's generation ownership, promoted to protocol law). A successful attach bumps the epoch.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "session.attach"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/SessionAttachParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SessionAttachRequest {
    pub id: RequestId,
    pub op: SessionAttachRequestOp,
    pub params: SessionAttachParams,
}
///`SessionAttachRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "session.attach"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum SessionAttachRequestOp {
    #[serde(rename = "session.attach")]
    SessionAttach,
}
impl ::std::fmt::Display for SessionAttachRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::SessionAttach => f.write_str("session.attach"),
        }
    }
}
impl ::std::str::FromStr for SessionAttachRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "session.attach" => Ok(Self::SessionAttach),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for SessionAttachRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for SessionAttachRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for SessionAttachRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`SessionHealthRequest`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SessionHealthRequest",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "session.health"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/NoParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SessionHealthRequest {
    pub id: RequestId,
    pub op: SessionHealthRequestOp,
    pub params: NoParams,
}
///`SessionHealthRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "session.health"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum SessionHealthRequestOp {
    #[serde(rename = "session.health")]
    SessionHealth,
}
impl ::std::fmt::Display for SessionHealthRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::SessionHealth => f.write_str("session.health"),
        }
    }
}
impl ::std::str::FromStr for SessionHealthRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "session.health" => Ok(Self::SessionHealth),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for SessionHealthRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for SessionHealthRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for SessionHealthRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///TAKEN, OR NOT TAKEN, AND WHAT THE WORLD WAS DOING. `accepted: false` IS NOT AN ERROR — it is the census's own semantics (boundary verdict 6) and it mirrors `combat/engine.ts sessionMark`, which returns false while the historical fold is still running. A mark cannot enter a replaying fold at all, which is what makes the JOS-208 replay-versus-live divergence class structurally impossible here rather than carefully avoided. THE CALLER MUST TREAT A REFUSAL AS `NEITHER HALF` (`pressNewSession`'s own law): a mark the engine never took is a boundary only half the app has, so the app records nothing either and leaves its loading state up. `status` is here rather than left to a follow-up `session.health` because the two would RACE — a fold that went live between the refusal and the question would explain the refusal with a state that no longer holds — and because a refusal that cannot say what it was refusing under is a bug report with a hole in it. WHETHER THE MARK MINTED A RECORD IS A DIFFERENT QUESTION and this ack deliberately does not answer it: an empty stay mints nothing, which is also what makes a double press harmless, and the honest answer to `did anything change` is the history itself.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SessionMarkAck",
///  "description": "TAKEN, OR NOT TAKEN, AND WHAT THE WORLD WAS DOING. `accepted: false` IS NOT AN ERROR — it is the census's own semantics (boundary verdict 6) and it mirrors `combat/engine.ts sessionMark`, which returns false while the historical fold is still running. A mark cannot enter a replaying fold at all, which is what makes the JOS-208 replay-versus-live divergence class structurally impossible here rather than carefully avoided. THE CALLER MUST TREAT A REFUSAL AS `NEITHER HALF` (`pressNewSession`'s own law): a mark the engine never took is a boundary only half the app has, so the app records nothing either and leaves its loading state up. `status` is here rather than left to a follow-up `session.health` because the two would RACE — a fold that went live between the refusal and the question would explain the refusal with a state that no longer holds — and because a refusal that cannot say what it was refusing under is a bug report with a hole in it. WHETHER THE MARK MINTED A RECORD IS A DIFFERENT QUESTION and this ack deliberately does not answer it: an empty stay mints nothing, which is also what makes a double press harmless, and the honest answer to `did anything change` is the history itself.",
///  "type": "object",
///  "required": [
///    "accepted",
///    "status"
///  ],
///  "properties": {
///    "accepted": {
///      "description": "True when the live fold took the instant. False ONLY when the world was not live — see `status`.",
///      "type": "boolean"
///    },
///    "status": {
///      "description": "What the engine's ingest was doing at the moment it decided, in `HealthResult.status`'s own words. `live` accompanies every acceptance; anything else accompanies a refusal.",
///      "type": "string",
///      "enum": [
///        "starting",
///        "attaching",
///        "folding",
///        "live",
///        "idle"
///      ]
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SessionMarkAck {
    ///True when the live fold took the instant. False ONLY when the world was not live — see `status`.
    pub accepted: bool,
    ///What the engine's ingest was doing at the moment it decided, in `HealthResult.status`'s own words. `live` accompanies every acceptance; anything else accompanies a refusal.
    pub status: SessionMarkAckStatus,
}
///What the engine's ingest was doing at the moment it decided, in `HealthResult.status`'s own words. `live` accompanies every acceptance; anything else accompanies a refusal.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "description": "What the engine's ingest was doing at the moment it decided, in `HealthResult.status`'s own words. `live` accompanies every acceptance; anything else accompanies a refusal.",
///  "type": "string",
///  "enum": [
///    "starting",
///    "attaching",
///    "folding",
///    "live",
///    "idle"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum SessionMarkAckStatus {
    #[serde(rename = "starting")]
    Starting,
    #[serde(rename = "attaching")]
    Attaching,
    #[serde(rename = "folding")]
    Folding,
    #[serde(rename = "live")]
    Live,
    #[serde(rename = "idle")]
    Idle,
}
impl ::std::fmt::Display for SessionMarkAckStatus {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Starting => f.write_str("starting"),
            Self::Attaching => f.write_str("attaching"),
            Self::Folding => f.write_str("folding"),
            Self::Live => f.write_str("live"),
            Self::Idle => f.write_str("idle"),
        }
    }
}
impl ::std::str::FromStr for SessionMarkAckStatus {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "starting" => Ok(Self::Starting),
            "attaching" => Ok(Self::Attaching),
            "folding" => Ok(Self::Folding),
            "live" => Ok(Self::Live),
            "idle" => Ok(Self::Idle),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for SessionMarkAckStatus {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for SessionMarkAckStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for SessionMarkAckStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`SessionMarkAddParams`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SessionMarkAddParams",
///  "type": "object",
///  "required": [
///    "at"
///  ],
///  "properties": {
///    "at": {
///      "description": "THE INSTANT THE PERSON PRESSED, in epoch milliseconds, on the app's WALL CLOCK — and it is the caller's clock rather than the engine's on purpose (JOS-436's rule, moved rather than re-decided). Marking at the live edge of the log would hand the stale minutes since the newest line — the zoning, the corpse run, the instance reset itself — to the session that had not started yet. It is also the one number that makes the two halves of the split share ONE boundary: the app applies the same value to its own ledger, so nothing looted in between can fall on the wrong side of one of them. This is NOT in tension with ruling 18 law 1: a mark is an IMPURE INPUT (law 4), pushed and named, never a clock the engine read for itself.",
///      "type": "integer"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SessionMarkAddParams {
    ///THE INSTANT THE PERSON PRESSED, in epoch milliseconds, on the app's WALL CLOCK — and it is the caller's clock rather than the engine's on purpose (JOS-436's rule, moved rather than re-decided). Marking at the live edge of the log would hand the stale minutes since the newest line — the zoning, the corpse run, the instance reset itself — to the session that had not started yet. It is also the one number that makes the two halves of the split share ONE boundary: the app applies the same value to its own ledger, so nothing looted in between can fall on the wrong side of one of them. This is NOT in tension with ruling 18 law 1: a mark is an IMPURE INPUT (law 4), pushed and named, never a clock the engine read for itself.
    pub at: i64,
}
///PRESS `NEW SESSION` (boundary verdict 6: `sessionMark` is a command with an accepted/refused reply; marks stay ephemeral for replay determinism). ONE INSTANT SPLITS EVERYTHING — the loot ledger app-side and the meter's engine records — so the app stamps the clock ONCE and hands that same number here, exactly as `src/main/sessionMarks.ts pressNewSession` hands it to `combat.sessionMark(ts)` today. THE ENGINE STORES NOTHING. A mark is a user action that is persisted nowhere, which is half of why a relaunch replays the log into the records the log alone describes; the other half is the refusal below. IT CAN BE REFUSED, and a refusal is not an error: the request is perfectly well formed and the honest answer is `not now` (see SessionMarkAck).
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SessionMarkAddRequest",
///  "description": "PRESS `NEW SESSION` (boundary verdict 6: `sessionMark` is a command with an accepted/refused reply; marks stay ephemeral for replay determinism). ONE INSTANT SPLITS EVERYTHING — the loot ledger app-side and the meter's engine records — so the app stamps the clock ONCE and hands that same number here, exactly as `src/main/sessionMarks.ts pressNewSession` hands it to `combat.sessionMark(ts)` today. THE ENGINE STORES NOTHING. A mark is a user action that is persisted nowhere, which is half of why a relaunch replays the log into the records the log alone describes; the other half is the refusal below. IT CAN BE REFUSED, and a refusal is not an error: the request is perfectly well formed and the honest answer is `not now` (see SessionMarkAck).",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "sessionMarks.add"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/SessionMarkAddParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SessionMarkAddRequest {
    pub id: RequestId,
    pub op: SessionMarkAddRequestOp,
    pub params: SessionMarkAddParams,
}
///`SessionMarkAddRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "sessionMarks.add"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum SessionMarkAddRequestOp {
    #[serde(rename = "sessionMarks.add")]
    SessionMarksAdd,
}
impl ::std::fmt::Display for SessionMarkAddRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::SessionMarksAdd => f.write_str("sessionMarks.add"),
        }
    }
}
impl ::std::str::FromStr for SessionMarkAddRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "sessionMarks.add" => Ok(Self::SessionMarksAdd),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for SessionMarkAddRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for SessionMarkAddRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for SessionMarkAddRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///Asks to be told about fold progress. The ticks themselves arrive as connection-wide EpochMessage frames carrying `progress` — the same channel the epoch bump uses, which is why they are not a fourth stream kind.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SessionProgressRequest",
///  "description": "Asks to be told about fold progress. The ticks themselves arrive as connection-wide EpochMessage frames carrying `progress` — the same channel the epoch bump uses, which is why they are not a fourth stream kind.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "session.progress"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/NoParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SessionProgressRequest {
    pub id: RequestId,
    pub op: SessionProgressRequestOp,
    pub params: NoParams,
}
///`SessionProgressRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "session.progress"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum SessionProgressRequestOp {
    #[serde(rename = "session.progress")]
    SessionProgress,
}
impl ::std::fmt::Display for SessionProgressRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::SessionProgress => f.write_str("session.progress"),
        }
    }
}
impl ::std::str::FromStr for SessionProgressRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "session.progress" => Ok(Self::SessionProgress),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for SessionProgressRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for SessionProgressRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for SessionProgressRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///One sort key as the pair the plan doc writes: ["at","desc"]. THE DOUBLE SPELLING IS DELIBERATE. A draft 2020-12 VALIDATOR reads `prefixItems` and therefore enforces that the second element is asc or desc - that is the real contract. Both CODE GENERATORS predate or ignore that keyword and read `items` + minItems/maxItems instead, landing on a fixed-length array of strings in each language. The two can never disagree about a legal value: with minItems = maxItems = 2 there is no element left for `items` to reach under 2020-12 semantics, so the fallback is vacuous for a compliant validator and merely weaker for a generator. Anything the generated types accept and the validator rejects is caught by the fixture suite, which validates every message against the schema itself.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SortTerm",
///  "description": "One sort key as the pair the plan doc writes: [\"at\",\"desc\"]. THE DOUBLE SPELLING IS DELIBERATE. A draft 2020-12 VALIDATOR reads `prefixItems` and therefore enforces that the second element is asc or desc - that is the real contract. Both CODE GENERATORS predate or ignore that keyword and read `items` + minItems/maxItems instead, landing on a fixed-length array of strings in each language. The two can never disagree about a legal value: with minItems = maxItems = 2 there is no element left for `items` to reach under 2020-12 semantics, so the fallback is vacuous for a compliant validator and merely weaker for a generator. Anything the generated types accept and the validator rejects is caught by the fixture suite, which validates every message against the schema itself.",
///  "type": "array",
///  "items": {
///    "type": "string"
///  },
///  "maxItems": 2,
///  "minItems": 2,
///  "prefixItems": [
///    {
///      "type": "string"
///    },
///    {
///      "enum": [
///        "asc",
///        "desc"
///      ],
///      "type": "string"
///    }
///  ]
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(transparent)]
pub struct SortTerm(pub [::std::string::String; 2usize]);
impl ::std::ops::Deref for SortTerm {
    type Target = [::std::string::String; 2usize];
    fn deref(&self) -> &[::std::string::String; 2usize] {
        &self.0
    }
}
impl ::std::convert::From<SortTerm> for [::std::string::String; 2usize] {
    fn from(value: SortTerm) -> Self {
        value.0
    }
}
impl ::std::convert::From<[::std::string::String; 2usize]> for SortTerm {
    fn from(value: [::std::string::String; 2usize]) -> Self {
        Self(value)
    }
}
///One spell as the Actions/Spells window draws it: a name, a level, and the two words it is filed under. The CATEGORY AND SUBCATEGORY ARRIVE AS WORDS AND NEVER AS IDS - a client receiving `114` would have to join it against a table it is not allowed to have, which is exactly the munging ruling 4 forbids.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SpellCatalogueRow",
///  "description": "One spell as the Actions/Spells window draws it: a name, a level, and the two words it is filed under. The CATEGORY AND SUBCATEGORY ARRIVE AS WORDS AND NEVER AS IDS - a client receiving `114` would have to join it against a table it is not allowed to have, which is exactly the munging ruling 4 forbids.",
///  "type": "object",
///  "required": [
///    "classes",
///    "level",
///    "name"
///  ],
///  "properties": {
///    "category": {
///      "description": "The Category column's word. Absent when the row files itself under none - 34,462 of the file's ~74k rows carry a zero there, which is the file saying uncategorised rather than naming category zero - and absent for every row when the string table could not be read.",
///      "type": "string"
///    },
///    "classes": {
///      "description": "Every in-scope class that can cast it, with the level each learns it at, in the client file's column order.",
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/SpellClassLevel"
///      }
///    },
///    "level": {
///      "description": "THE LEVEL THE LIST IS SORTED AND FILED BY: the LOWEST level at which any class in scope learns this, i.e. the earliest a character with this combo could have had it. The game's own window never has to answer this because a character there is one class; a combo of three needs one number to sort by, and `classes` beside it carries the whole truth so nothing is hidden by the choice.",
///      "type": "integer"
///    },
///    "name": {
///      "description": "The client file's OWN spelling. The log and `spells_us.txt` outrank the wiki on a spell's name, always - the repo already says so where the two disagree (`spellCorrectionsList.ts`'s fifth drift class restores the game's spelling against a retitled wiki page), and this is that authority at its source.",
///      "type": "string"
///    },
///    "subcategory": {
///      "description": "The Subcategory column's word. Absent independently of `category`.",
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SpellCatalogueRow {
    ///The Category column's word. Absent when the row files itself under none - 34,462 of the file's ~74k rows carry a zero there, which is the file saying uncategorised rather than naming category zero - and absent for every row when the string table could not be read.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub category: ::std::option::Option<::std::string::String>,
    ///Every in-scope class that can cast it, with the level each learns it at, in the client file's column order.
    pub classes: ::std::vec::Vec<SpellClassLevel>,
    ///THE LEVEL THE LIST IS SORTED AND FILED BY: the LOWEST level at which any class in scope learns this, i.e. the earliest a character with this combo could have had it. The game's own window never has to answer this because a character there is one class; a combo of three needs one number to sort by, and `classes` beside it carries the whole truth so nothing is hidden by the choice.
    pub level: i64,
    ///The client file's OWN spelling. The log and `spells_us.txt` outrank the wiki on a spell's name, always - the repo already says so where the two disagree (`spellCorrectionsList.ts`'s fifth drift class restores the game's spelling against a retitled wiki page), and this is that authority at its source.
    pub name: ::std::string::String,
    ///The Subcategory column's word. Absent independently of `category`.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub subcategory: ::std::option::Option<::std::string::String>,
}
///A category and the subcategories found under it IN THIS SCOPE - never the whole vocabulary, so a control never offers a value that would return nothing. Alphabetical, both levels.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SpellCategoryFacet",
///  "description": "A category and the subcategories found under it IN THIS SCOPE - never the whole vocabulary, so a control never offers a value that would return nothing. Alphabetical, both levels.",
///  "type": "object",
///  "required": [
///    "name",
///    "subcategories"
///  ],
///  "properties": {
///    "name": {
///      "type": "string"
///    },
///    "subcategories": {
///      "type": "array",
///      "items": {
///        "type": "string"
///      }
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SpellCategoryFacet {
    pub name: ::std::string::String,
    pub subcategories: ::std::vec::Vec<::std::string::String>,
}
///One class that can cast a spell, and when it learns it. The level is always 1..=254: the client file writes 255 for `this class cannot use it` and 0 for nothing, and neither becomes a row here.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SpellClassLevel",
///  "description": "One class that can cast a spell, and when it learns it. The level is always 1..=254: the client file writes 255 for `this class cannot use it` and 0 for nothing, and neither becomes a row here.",
///  "type": "object",
///  "required": [
///    "class",
///    "level"
///  ],
///  "properties": {
///    "class": {
///      "$ref": "#/$defs/ClassAbbr"
///    },
///    "level": {
///      "type": "integer"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SpellClassLevel {
    pub class: ClassAbbr,
    pub level: i64,
}
///How the list is ordered. TWO MEMBERS AND NO MORE, and the restraint is the design: an unknown sort is `badParams` because this enum refuses it, which satisfies the standing law that an unknown filter or sort field is refused rather than accepted-and-ignored (serving every row while the client believes it sorted is the one answer that cannot be debugged) without anyone having to remember to write a check. `level` is DESCENDING - the in-game window's own order - and every sort ends in the source's own tiebreak so the order is TOTAL: the corpus is a hash map with randomised iteration, so an order stopping at the level would answer the same query differently on every call, which is the shuffled-window defect in its purest form.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SpellSort",
///  "description": "How the list is ordered. TWO MEMBERS AND NO MORE, and the restraint is the design: an unknown sort is `badParams` because this enum refuses it, which satisfies the standing law that an unknown filter or sort field is refused rather than accepted-and-ignored (serving every row while the client believes it sorted is the one answer that cannot be debugged) without anyone having to remember to write a check. `level` is DESCENDING - the in-game window's own order - and every sort ends in the source's own tiebreak so the order is TOTAL: the corpus is a hash map with randomised iteration, so an order stopping at the level would answer the same query differently on every call, which is the shuffled-window defect in its purest form.",
///  "type": "string",
///  "enum": [
///    "level",
///    "name"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum SpellSort {
    #[serde(rename = "level")]
    Level,
    #[serde(rename = "name")]
    Name,
}
impl ::std::fmt::Display for SpellSort {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Level => f.write_str("level"),
            Self::Name => f.write_str("name"),
        }
    }
}
impl ::std::str::FromStr for SpellSort {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "level" => Ok(Self::Level),
            "name" => Ok(Self::Name),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for SpellSort {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for SpellSort {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for SpellSort {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`shared/resistTypes.ts SpellTableState`, minus its `loading` member. The app's own reader has a fourth state because its parse is on a worker thread and a caller can arrive mid-flight; this engine's read BLOCKS the connection thread that asked, so by the time a reply exists the question is settled. `missing` and `unloadable` are two states rather than one because they are two different sentences to a person: no file at that path, versus a file that could not be read.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SpellTableState",
///  "description": "`shared/resistTypes.ts SpellTableState`, minus its `loading` member. The app's own reader has a fourth state because its parse is on a worker thread and a caller can arrive mid-flight; this engine's read BLOCKS the connection thread that asked, so by the time a reply exists the question is settled. `missing` and `unloadable` are two states rather than one because they are two different sentences to a person: no file at that path, versus a file that could not be read.",
///  "type": "string",
///  "enum": [
///    "ok",
///    "missing",
///    "unloadable"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum SpellTableState {
    #[serde(rename = "ok")]
    Ok,
    #[serde(rename = "missing")]
    Missing,
    #[serde(rename = "unloadable")]
    Unloadable,
}
impl ::std::fmt::Display for SpellTableState {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Ok => f.write_str("ok"),
            Self::Missing => f.write_str("missing"),
            Self::Unloadable => f.write_str("unloadable"),
        }
    }
}
impl ::std::str::FromStr for SpellTableState {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "ok" => Ok(Self::Ok),
            "missing" => Ok(Self::Missing),
            "unloadable" => Ok(Self::Unloadable),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for SpellTableState {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for SpellTableState {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for SpellTableState {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///EVERY FILTER IS AND-ED AND AN ABSENT ONE FILTERS NOTHING. The corpus is always the spells a PLAYER can learn: a row no class can cast is a mob's or an item's copy of a spell, and the in-game window does not list those either, so they are in no answer here and there is no option to ask for them.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SpellsSearchParams",
///  "description": "EVERY FILTER IS AND-ED AND AN ABSENT ONE FILTERS NOTHING. The corpus is always the spells a PLAYER can learn: a row no class can cast is a mob's or an item's copy of a spell, and the in-game window does not list those either, so they are in no answer here and there is no option to ask for them.",
///  "type": "object",
///  "properties": {
///    "category": {
///      "description": "An exact category, spelled as `categories` in the result spells it. Case-insensitive so a value round-tripped through a stored preference still matches. A category no row carries is not an error - it is an empty list, which is what a filter that excludes everything means.",
///      "type": "string"
///    },
///    "classes": {
///      "description": "Scope the list to these classes - the player's own combo, which is what the surface sends by default. ABSENT OR EMPTY MEANS EVERY CLASS, which is the show-all toggle; the two spellings are one state because an optional array cannot carry its own absence into Rust (typify defaults it to an empty vector), so giving them different meanings would make the languages disagree about a request neither could round-trip. The app names the classes rather than the engine reading its own combo module, deliberately: this is a question about a static client file, and answering it out of fold state would make a catalogue lookup depend on how far a replay had got. THERE IS NO `maxItems` HERE AND THAT IS DELIBERATE: a `maxItems` with no `minItems` anchor generates a tuple UNION in TypeScript that no ordinary array satisfies (`resist.levels` escapes that only because its `minItems: 1` makes it a rest-tuple), and this list must be allowed to be empty. The bound belongs in the engine, which sorts and dedupes the columns it derives - at most sixteen by construction, and a repeated class was never meaningful anyway.",
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/ClassAbbr"
///      }
///    },
///    "limit": {
///      "description": "How many rows the window holds. Absent takes the engine's default and a number above its cap takes the cap - CLAMPED rather than refused, which is the same call `combat.searchFights` makes about the same kind of number. `total` states how many matched, so a caller says `1-20 of 143` without ever holding 143.",
///      "type": "integer"
///    },
///    "offset": {
///      "description": "Where the window starts. Past the end is an EMPTY PAGE and never an error: a client holding a stale offset while a filter narrows underneath it is ordinary rather than exceptional, and `total` still says how many there were.",
///      "type": "integer"
///    },
///    "sort": {
///      "$ref": "#/$defs/SpellSort"
///    },
///    "subcategory": {
///      "description": "An exact subcategory. INDEPENDENT OF `category` AND NOT A REFINEMENT OF IT: the client table files nine rows under a subcategory with no category at all (rogue poisons under `Misc`), so the two are separate filters that happen to nest in the common case.",
///      "type": "string"
///    },
///    "text": {
///      "description": "A case-insensitive SUBSTRING of the spell's NAME, ITS CATEGORY OR ITS SUBCATEGORY - the three are one haystack, and that is the whole point of the op rather than a convenience. The owner's `tap` search returns `Leech` and `Siphon Strength`, and neither NAME contains `tap`; they are in the list because their category is `Taps`. A name-only filter reproduces the first row of that screenshot and silently loses two thirds of it. It is a substring match rather than the typo-tolerant scorer `combat.searchFights` runs, because that corpus is proper nouns a player half-remembers and this one is a vocabulary they are browsing. An empty or absent value filters nothing, which is a browse rather than a search - unlike `knowledge.search`, where an empty query answers with nothing, because there the whole corpus is the alternative and here the window already bounds it.",
///      "type": "string"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SpellsSearchParams {
    ///An exact category, spelled as `categories` in the result spells it. Case-insensitive so a value round-tripped through a stored preference still matches. A category no row carries is not an error - it is an empty list, which is what a filter that excludes everything means.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub category: ::std::option::Option<::std::string::String>,
    ///Scope the list to these classes - the player's own combo, which is what the surface sends by default. ABSENT OR EMPTY MEANS EVERY CLASS, which is the show-all toggle; the two spellings are one state because an optional array cannot carry its own absence into Rust (typify defaults it to an empty vector), so giving them different meanings would make the languages disagree about a request neither could round-trip. The app names the classes rather than the engine reading its own combo module, deliberately: this is a question about a static client file, and answering it out of fold state would make a catalogue lookup depend on how far a replay had got. THERE IS NO `maxItems` HERE AND THAT IS DELIBERATE: a `maxItems` with no `minItems` anchor generates a tuple UNION in TypeScript that no ordinary array satisfies (`resist.levels` escapes that only because its `minItems: 1` makes it a rest-tuple), and this list must be allowed to be empty. The bound belongs in the engine, which sorts and dedupes the columns it derives - at most sixteen by construction, and a repeated class was never meaningful anyway.
    #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
    pub classes: ::std::vec::Vec<ClassAbbr>,
    ///How many rows the window holds. Absent takes the engine's default and a number above its cap takes the cap - CLAMPED rather than refused, which is the same call `combat.searchFights` makes about the same kind of number. `total` states how many matched, so a caller says `1-20 of 143` without ever holding 143.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub limit: ::std::option::Option<i64>,
    ///Where the window starts. Past the end is an EMPTY PAGE and never an error: a client holding a stale offset while a filter narrows underneath it is ordinary rather than exceptional, and `total` still says how many there were.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub offset: ::std::option::Option<i64>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub sort: ::std::option::Option<SpellSort>,
    ///An exact subcategory. INDEPENDENT OF `category` AND NOT A REFINEMENT OF IT: the client table files nine rows under a subcategory with no category at all (rogue poisons under `Misc`), so the two are separate filters that happen to nest in the common case.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub subcategory: ::std::option::Option<::std::string::String>,
    ///A case-insensitive SUBSTRING of the spell's NAME, ITS CATEGORY OR ITS SUBCATEGORY - the three are one haystack, and that is the whole point of the op rather than a convenience. The owner's `tap` search returns `Leech` and `Siphon Strength`, and neither NAME contains `tap`; they are in the list because their category is `Taps`. A name-only filter reproduces the first row of that screenshot and silently loses two thirds of it. It is a substring match rather than the typo-tolerant scorer `combat.searchFights` runs, because that corpus is proper nouns a player half-remembers and this one is a vocabulary they are browsing. An empty or absent value filters nothing, which is a browse rather than a search - unlike `knowledge.search`, where an empty query answers with nothing, because there the whole corpus is the alternative and here the window already bounds it.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub text: ::std::option::Option<::std::string::String>,
}
impl ::std::default::Default for SpellsSearchParams {
    fn default() -> Self {
        Self {
            category: Default::default(),
            classes: Default::default(),
            limit: Default::default(),
            offset: Default::default(),
            sort: Default::default(),
            subcategory: Default::default(),
            text: Default::default(),
        }
    }
}
///SEARCH THE CLIENT'S OWN SPELL TABLE BY TYPE (JOS-507). The in-game Actions/Spells window can search by TYPE - a `tap` search over a SHD/BRD/WIZ combo returns every tap by level, with a Category column reading `Taps` and a Subcategory column reading `Health`, `Duration Tap` or `Power Tap` - and this is that capability, off the same source the game itself uses. `spells_us.txt` files every spell under two integer ids (fields 86 and 87, verified against the owner's install) and `dbstr_us.txt` type 5 says what those ids are called; both sit in the install the attach named, so this needs no configuration and no discovery. IT IS A WINDOWED QUERY AND NEVER A BULK READ, which is the standing no-bulk-frame ruling rather than a phase: the parsed table is 48,256 entries and 6.13 MiB of JSON against an 8 MiB frame ceiling on one machine, against a table that grows with every client patch. So the engine filters, sorts and windows, and the app draws what arrives without re-deriving any of it (ruling 4). It is a `spells.*` op rather than a second `resist.*` one because it answers about the table as a CATALOGUE - what exists, filed under what - where `resist.spell` answers about ONE spell's mechanics; and it is not `knowledge.search`, which ranks the committed wiki scrape and knows nothing about categories at all. NOTHING DERIVED FROM EITHER CLIENT FILE IS EVER COMMITTED, which is why every test on both sides is driven by hand-authored rows.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SpellsSearchRequest",
///  "description": "SEARCH THE CLIENT'S OWN SPELL TABLE BY TYPE (JOS-507). The in-game Actions/Spells window can search by TYPE - a `tap` search over a SHD/BRD/WIZ combo returns every tap by level, with a Category column reading `Taps` and a Subcategory column reading `Health`, `Duration Tap` or `Power Tap` - and this is that capability, off the same source the game itself uses. `spells_us.txt` files every spell under two integer ids (fields 86 and 87, verified against the owner's install) and `dbstr_us.txt` type 5 says what those ids are called; both sit in the install the attach named, so this needs no configuration and no discovery. IT IS A WINDOWED QUERY AND NEVER A BULK READ, which is the standing no-bulk-frame ruling rather than a phase: the parsed table is 48,256 entries and 6.13 MiB of JSON against an 8 MiB frame ceiling on one machine, against a table that grows with every client patch. So the engine filters, sorts and windows, and the app draws what arrives without re-deriving any of it (ruling 4). It is a `spells.*` op rather than a second `resist.*` one because it answers about the table as a CATALOGUE - what exists, filed under what - where `resist.spell` answers about ONE spell's mechanics; and it is not `knowledge.search`, which ranks the committed wiki scrape and knows nothing about categories at all. NOTHING DERIVED FROM EITHER CLIENT FILE IS EVER COMMITTED, which is why every test on both sides is driven by hand-authored rows.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "spells.search"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/SpellsSearchParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SpellsSearchRequest {
    pub id: RequestId,
    pub op: SpellsSearchRequestOp,
    pub params: SpellsSearchParams,
}
///`SpellsSearchRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "spells.search"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum SpellsSearchRequestOp {
    #[serde(rename = "spells.search")]
    SpellsSearch,
}
impl ::std::fmt::Display for SpellsSearchRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::SpellsSearch => f.write_str("spells.search"),
        }
    }
}
impl ::std::str::FromStr for SpellsSearchRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "spells.search" => Ok(Self::SpellsSearch),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for SpellsSearchRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for SpellsSearchRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for SpellsSearchRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///A window onto the client's spell catalogue, already filtered, already sorted. `spellTable` and `path` ride EVERY answer for `ResistSpellResult`'s reason exactly - an empty list means several different things to a person (no such install, a file that would not read, a filter that excludes everything) and a reply carrying only the rows would flatten them into one silence. IT IS `spellTable` RATHER THAN `table`, AND THE MATRIX IS WHY: `resist.spell` already owns the bare word `table` as its discriminator in `src/shared/dataServer/ops.ts`, and a second result carrying that field would make that guard accept two shapes it could no longer tell apart. Same lesson as `perf.budgets` picking `budgets` over the tempting generic `epoch`, reached from the other direction. This shape's own discriminator is `spells`.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SpellsSearchResult",
///  "description": "A window onto the client's spell catalogue, already filtered, already sorted. `spellTable` and `path` ride EVERY answer for `ResistSpellResult`'s reason exactly - an empty list means several different things to a person (no such install, a file that would not read, a filter that excludes everything) and a reply carrying only the rows would flatten them into one silence. IT IS `spellTable` RATHER THAN `table`, AND THE MATRIX IS WHY: `resist.spell` already owns the bare word `table` as its discriminator in `src/shared/dataServer/ops.ts`, and a second result carrying that field would make that guard accept two shapes it could no longer tell apart. Same lesson as `perf.budgets` picking `budgets` over the tempting generic `epoch`, reached from the other direction. This shape's own discriminator is `spells`.",
///  "type": "object",
///  "required": [
///    "categories",
///    "limit",
///    "offset",
///    "path",
///    "spellTable",
///    "spells",
///    "total"
///  ],
///  "properties": {
///    "categories": {
///      "description": "The category vocabulary present in this scope, for a filter control to draw. THE ENGINE HAS TO SUPPLY THIS AND THE APP CANNOT SHIP IT: the words are Daybreak's and live only in the player's own `dbstr_us.txt`, so a hardcoded list would be both redistributed client data and wrong on the next patch. It describes the CLASS AND TEXT scope and deliberately ignores the `category`/`subcategory` filters it populates - a control that collapsed to the value just picked is one a user cannot get back out of. Empty when the string table could not be read.",
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/SpellCategoryFacet"
///      }
///    },
///    "limit": {
///      "description": "The window's size AS THE ENGINE APPLIED IT, which is the request's value clamped to the cap. Echoing the effective number rather than the requested one is what lets a caller notice it was clamped.",
///      "type": "integer"
///    },
///    "offset": {
///      "description": "The window's start, echoed - including when the request omitted it, so a caller paging through never has to remember what it asked for.",
///      "type": "integer"
///    },
///    "path": {
///      "description": "Where this engine looked for `spells_us.txt`. Present always, because the sentence a missing table produces has to name a place.",
///      "type": "string"
///    },
///    "spellTable": {
///      "$ref": "#/$defs/SpellTableState"
///    },
///    "spells": {
///      "description": "The window. Filtered, sorted and bounded by the request - the renderer draws these in the order they arrive and never re-sorts or re-filters them (ruling 4).",
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/SpellCatalogueRow"
///      }
///    },
///    "total": {
///      "description": "How many rows MATCHED, before the window was taken. A surface says `1-20 of 143` off this without ever holding 143.",
///      "type": "integer"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SpellsSearchResult {
    ///The category vocabulary present in this scope, for a filter control to draw. THE ENGINE HAS TO SUPPLY THIS AND THE APP CANNOT SHIP IT: the words are Daybreak's and live only in the player's own `dbstr_us.txt`, so a hardcoded list would be both redistributed client data and wrong on the next patch. It describes the CLASS AND TEXT scope and deliberately ignores the `category`/`subcategory` filters it populates - a control that collapsed to the value just picked is one a user cannot get back out of. Empty when the string table could not be read.
    pub categories: ::std::vec::Vec<SpellCategoryFacet>,
    ///The window's size AS THE ENGINE APPLIED IT, which is the request's value clamped to the cap. Echoing the effective number rather than the requested one is what lets a caller notice it was clamped.
    pub limit: i64,
    ///The window's start, echoed - including when the request omitted it, so a caller paging through never has to remember what it asked for.
    pub offset: i64,
    ///Where this engine looked for `spells_us.txt`. Present always, because the sentence a missing table produces has to name a place.
    pub path: ::std::string::String,
    #[serde(rename = "spellTable")]
    pub spell_table: SpellTableState,
    ///The window. Filtered, sorted and bounded by the request - the renderer draws these in the order they arrive and never re-sorts or re-filters them (ruling 4).
    pub spells: ::std::vec::Vec<SpellCatalogueRow>,
    ///How many rows MATCHED, before the window was taken. A surface says `1-20 of 143` off this without ever holding 143.
    pub total: i64,
}
///`SubscribeAck`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SubscribeAck",
///  "type": "object",
///  "required": [
///    "subscribed",
///    "subscription"
///  ],
///  "properties": {
///    "subscribed": {
///      "type": "boolean"
///    },
///    "subscription": {
///      "$ref": "#/$defs/RequestId"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SubscribeAck {
    pub subscribed: bool,
    pub subscription: RequestId,
}
///The per-launch shared secret. Minted by Electron main at spawn, handed to the engine out of band, presented once at hello. It is never persisted and never reused across launches. Compare it in CONSTANT TIME (src/main/dataServer/token.ts, engine/crates/protocol/src/token.rs) - a byte-at-a-time compare over a loopback socket is a timing oracle. The shape rules are environment-neutral and live in src/shared/dataServer/token.ts.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "Token",
///  "description": "The per-launch shared secret. Minted by Electron main at spawn, handed to the engine out of band, presented once at hello. It is never persisted and never reused across launches. Compare it in CONSTANT TIME (src/main/dataServer/token.ts, engine/crates/protocol/src/token.rs) - a byte-at-a-time compare over a loopback socket is a timing oracle. The shape rules are environment-neutral and live in src/shared/dataServer/token.ts.",
///  "type": "string",
///  "maxLength": 256,
///  "minLength": 32
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct Token(::std::string::String);
impl ::std::ops::Deref for Token {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<Token> for ::std::string::String {
    fn from(value: Token) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for Token {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 256usize {
            return Err("longer than 256 characters".into());
        }
        if value.chars().count() < 32usize {
            return Err("shorter than 32 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for Token {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for Token {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for Token {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for Token {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///CHANGED CELLS ONLY. A cell absent from `cells` is unchanged, never cleared — clearing is an explicit null.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "UpdateOp",
///  "description": "CHANGED CELLS ONLY. A cell absent from `cells` is unchanged, never cleared — clearing is an explicit null.",
///  "type": "object",
///  "required": [
///    "cells",
///    "key",
///    "op"
///  ],
///  "properties": {
///    "cells": {
///      "$ref": "#/$defs/Cells"
///    },
///    "key": {
///      "$ref": "#/$defs/RowKey"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "update"
///      ]
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct UpdateOp {
    pub cells: Cells,
    pub key: RowKey,
    pub op: UpdateOpOp,
}
///`UpdateOpOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "update"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum UpdateOpOp {
    #[serde(rename = "update")]
    Update,
}
impl ::std::fmt::Display for UpdateOpOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Update => f.write_str("update"),
        }
    }
}
impl ::std::str::FromStr for UpdateOpOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "update" => Ok(Self::Update),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for UpdateOpOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for UpdateOpOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for UpdateOpOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ViewDescriptor`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ViewDescriptor",
///  "type": "object",
///  "required": [
///    "source"
///  ],
///  "properties": {
///    "filter": {
///      "$ref": "#/$defs/ViewFilter"
///    },
///    "sort": {
///      "type": "array",
///      "items": {
///        "$ref": "#/$defs/SortTerm"
///      }
///    },
///    "source": {
///      "description": "Which collection the view reads, e.g. `loot.ledger` or `combat.live`. The engine owns the registry of sources; an unknown one is a `notFound` error, never an empty result.",
///      "type": "string"
///    },
///    "window": {
///      "$ref": "#/$defs/ViewWindow"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ViewDescriptor {
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub filter: ::std::option::Option<ViewFilter>,
    #[serde(default, skip_serializing_if = "::std::vec::Vec::is_empty")]
    pub sort: ::std::vec::Vec<SortTerm>,
    ///Which collection the view reads, e.g. `loot.ledger` or `combat.live`. The engine owns the registry of sources; an unknown one is a `notFound` error, never an empty result.
    pub source: ::std::string::String,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub window: ::std::option::Option<ViewWindow>,
}
///Field-name to value, ANDed. Open by design for the same reason Cells is: which fields a source filters on is the SOURCE's contract, not the protocol's.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ViewFilter",
///  "description": "Field-name to value, ANDed. Open by design for the same reason Cells is: which fields a source filters on is the SOURCE's contract, not the protocol's.",
///  "type": "object",
///  "additionalProperties": {
///    "$ref": "#/$defs/Cell"
///  }
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(transparent)]
pub struct ViewFilter(pub ::std::collections::BTreeMap<::std::string::String, crate::cell::Cell>);
impl ::std::ops::Deref for ViewFilter {
    type Target = ::std::collections::BTreeMap<::std::string::String, crate::cell::Cell>;
    fn deref(&self) -> &::std::collections::BTreeMap<::std::string::String, crate::cell::Cell> {
        &self.0
    }
}
impl ::std::convert::From<ViewFilter>
    for ::std::collections::BTreeMap<::std::string::String, crate::cell::Cell>
{
    fn from(value: ViewFilter) -> Self {
        value.0
    }
}
impl ::std::convert::From<::std::collections::BTreeMap<::std::string::String, crate::cell::Cell>>
    for ViewFilter
{
    fn from(value: ::std::collections::BTreeMap<::std::string::String, crate::cell::Cell>) -> Self {
        Self(value)
    }
}
///Opens a subscription. The reply acknowledges; the data starts with a `reset` carrying the whole window.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ViewSubscribeRequest",
///  "description": "Opens a subscription. The reply acknowledges; the data starts with a `reset` carrying the whole window.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "view.subscribe"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/ViewDescriptor"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ViewSubscribeRequest {
    pub id: RequestId,
    pub op: ViewSubscribeRequestOp,
    pub params: ViewDescriptor,
}
///`ViewSubscribeRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "view.subscribe"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum ViewSubscribeRequestOp {
    #[serde(rename = "view.subscribe")]
    ViewSubscribe,
}
impl ::std::fmt::Display for ViewSubscribeRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::ViewSubscribe => f.write_str("view.subscribe"),
        }
    }
}
impl ::std::str::FromStr for ViewSubscribeRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "view.subscribe" => Ok(Self::ViewSubscribe),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ViewSubscribeRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ViewSubscribeRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ViewSubscribeRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ViewUnsubscribeParams`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ViewUnsubscribeParams",
///  "type": "object",
///  "required": [
///    "subscription"
///  ],
///  "properties": {
///    "subscription": {
///      "$ref": "#/$defs/RequestId"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ViewUnsubscribeParams {
    pub subscription: RequestId,
}
///Closes a subscription. `id` is this REQUEST's id; `params.subscription` names the subscribe request whose stream is to stop.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ViewUnsubscribeRequest",
///  "description": "Closes a subscription. `id` is this REQUEST's id; `params.subscription` names the subscribe request whose stream is to stop.",
///  "type": "object",
///  "required": [
///    "id",
///    "op",
///    "params"
///  ],
///  "properties": {
///    "id": {
///      "$ref": "#/$defs/RequestId"
///    },
///    "op": {
///      "type": "string",
///      "enum": [
///        "view.unsubscribe"
///      ]
///    },
///    "params": {
///      "$ref": "#/$defs/ViewUnsubscribeParams"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ViewUnsubscribeRequest {
    pub id: RequestId,
    pub op: ViewUnsubscribeRequestOp,
    pub params: ViewUnsubscribeParams,
}
///`ViewUnsubscribeRequestOp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "enum": [
///    "view.unsubscribe"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
)]
pub enum ViewUnsubscribeRequestOp {
    #[serde(rename = "view.unsubscribe")]
    ViewUnsubscribe,
}
impl ::std::fmt::Display for ViewUnsubscribeRequestOp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::ViewUnsubscribe => f.write_str("view.unsubscribe"),
        }
    }
}
impl ::std::str::FromStr for ViewUnsubscribeRequestOp {
    type Err = self::error::ConversionError;
    fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "view.unsubscribe" => Ok(Self::ViewUnsubscribe),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ViewUnsubscribeRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ViewUnsubscribeRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ViewUnsubscribeRequestOp {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///The slice of the sorted, filtered view the client wants. Absent means the engine's default window for that source — never `everything`, because an unbounded window is how a payload budget gets blown.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ViewWindow",
///  "description": "The slice of the sorted, filtered view the client wants. Absent means the engine's default window for that source — never `everything`, because an unbounded window is how a payload budget gets blown.",
///  "type": "object",
///  "required": [
///    "limit",
///    "offset"
///  ],
///  "properties": {
///    "limit": {
///      "type": "integer"
///    },
///    "offset": {
///      "type": "integer"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ViewWindow {
    pub limit: i64,
    pub offset: i64,
}
/// THE WIRE VERSION. A single integer, bumped on any breaking change. A client presents it
/// in `Hello::protocol_version`; the engine answers with its own in
/// `HelloReply::protocol_version`. A mismatch is FATAL by ruling - both sides log and the
/// connection closes. Version skew is a build error, not a runtime state to recover from,
/// because both sides generate from this one artifact.
pub const PROTOCOL_VERSION: i64 = 1;
