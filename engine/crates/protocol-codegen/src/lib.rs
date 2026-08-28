//! The Rust half of `npm run gen:protocol`.
//!
//! The source of truth is `protocol/schema/*.schema.json` — neutral JSON Schema draft 2020-12,
//! privileging neither language. This crate turns it into `protocol/src/generated.rs` with typify;
//! the TypeScript twin comes from the same files. Both artifacts are committed and pinned by a test
//! that regenerates and diffs.
//!
//! The bundle step is mirrored, not shared, which is the one place the two generators could drift:
//! typify panics on cross-file `$ref`s, so both sides merge the topic files' `$defs` into one
//! document where every `#/$defs/Name` pointer resolves. The merge is deliberately trivial — union
//! the maps, reject a duplicate name, bolt on a fixed root — and `tests/protocolSchema.test.mts`
//! catches drift by asserting every definition appears as a type in both generated files.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use sha2::{Digest as _, Sha256};

/// Anything that can go wrong turning the schema into Rust. Every variant names a file or a
/// command, because the only reader is a person staring at a failed `npm run gen:protocol`.
#[derive(Debug)]
pub enum CodegenError {
    /// A schema file could not be read or parsed.
    Schema(String),
    /// typify could not turn the bundle into types.
    Typify(String),
    /// The generated token stream was not parseable Rust — a typify bug, or a schema shape it
    /// mis-lowered. Either way the bytes are printed rather than written.
    Syntax(String),
    /// rustfmt was missing or refused the input.
    Rustfmt(String),
}

impl std::fmt::Display for CodegenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Schema(m) => write!(f, "schema: {m}"),
            Self::Typify(m) => write!(f, "typify: {m}"),
            Self::Syntax(m) => write!(f, "generated code did not parse: {m}"),
            Self::Rustfmt(m) => write!(f, "rustfmt: {m}"),
        }
    }
}

impl std::error::Error for CodegenError {}

type Result<T> = std::result::Result<T, CodegenError>;

/// The extension keyword one schema file carries to state the wire version. See [`protocol_version`].
const VERSION_KEY: &str = "x-protocolVersion";

/// The repo root, derived from this crate's manifest directory: `<root>/engine/crates/protocol-codegen`.
#[must_use]
pub fn repo_root() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest
        .ancestors()
        .nth(3)
        .expect("crate is three levels below the repo root")
        .to_path_buf()
}

/// `<root>/protocol/schema`.
#[must_use]
pub fn schema_dir() -> PathBuf {
    repo_root().join("protocol").join("schema")
}

/// `<root>/engine/crates/protocol/src/generated.rs` — the committed artifact this crate writes.
#[must_use]
pub fn generated_path() -> PathBuf {
    repo_root()
        .join("engine")
        .join("crates")
        .join("protocol")
        .join("src")
        .join("generated.rs")
}

/// One `*.schema.json`, with its text already LF-normalized.
pub struct SchemaSource {
    /// File name only — the digest's stable key.
    pub name: String,
    /// LF-normalized text, exactly as the digest measures it.
    pub text: String,
    /// The parsed document.
    pub json: serde_json::Value,
}

/// Every `*.schema.json` in `dir`, name-sorted so the digest is order-independent.
///
/// The text is LF-normalized before anything measures it: this repo checks out with
/// `core.autocrlf=true`, so the same commit has different on-disk bytes on a dev box and a CI
/// runner.
pub fn read_schema_files(dir: &Path) -> Result<Vec<SchemaSource>> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map_err(|e| CodegenError::Schema(format!("{}: {e}", dir.display())))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".schema.json"))
        .collect();
    names.sort();
    if names.is_empty() {
        return Err(CodegenError::Schema(format!(
            "no *.schema.json in {}",
            dir.display()
        )));
    }
    names
        .into_iter()
        .map(|name| {
            let path = dir.join(&name);
            let raw = fs::read_to_string(&path)
                .map_err(|e| CodegenError::Schema(format!("{}: {e}", path.display())))?;
            let text = raw.replace("\r\n", "\n");
            let json: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| CodegenError::Schema(format!("{name}: {e}")))?;
            Ok(SchemaSource { name, text, json })
        })
        .collect()
}

/// The fingerprint both generated files carry in their header, byte-for-byte identical to the one
/// `scripts/protocolSchema.mts` computes: for each file, in name order, the name, a newline, the
/// LF-normalized text, a newline.
#[must_use]
pub fn schema_digest(files: &[SchemaSource]) -> String {
    let mut hash = Sha256::new();
    for file in files {
        hash.update(file.name.as_bytes());
        hash.update(b"\n");
        hash.update(file.text.as_bytes());
        hash.update(b"\n");
    }
    format!("{:x}", hash.finalize())
}

/// The single document typify reads: `$defs` merged across every source file under one fixed root.
///
/// The root is `ProtocolMessage` — anything that can travel the wire in either direction — rather
/// than an empty object, because both generators emit a type for the root whether or not it says
/// anything, and a named union is worth having where a placeholder is not.
pub fn bundle(files: &[SchemaSource]) -> Result<serde_json::Value> {
    let mut defs: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    let mut source: BTreeMap<String, String> = BTreeMap::new();
    for file in files {
        let file_defs = file
            .json
            .get("$defs")
            .and_then(|v| v.as_object())
            .ok_or_else(|| {
                CodegenError::Schema(format!(
                    "{}: every schema file must carry a top-level $defs object",
                    file.name
                ))
            })?;
        for (name, def) in file_defs {
            if let Some(previous) = source.get(name) {
                return Err(CodegenError::Schema(format!(
                    "$defs/{name} is defined in both {previous} and {}",
                    file.name
                )));
            }
            source.insert(name.clone(), file.name.clone());
            defs.insert(name.clone(), def.clone());
        }
    }
    for required in ["ClientMessage", "EngineMessage"] {
        if !defs.contains_key(required) {
            return Err(CodegenError::Schema(format!(
                "$defs/{required} is missing from the bundle"
            )));
        }
    }
    Ok(serde_json::json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://everquest-companion.local/protocol",
        "title": "ProtocolMessage",
        "description": "Anything that can travel the wire, in either direction. The transport adapters are generic over exactly this: a transport moves ProtocolMessages and knows nothing else about the protocol.",
        "oneOf": [{ "$ref": "#/$defs/ClientMessage" }, { "$ref": "#/$defs/EngineMessage" }],
        "$defs": serde_json::Value::Object(defs),
    }))
}

/// The wire version: one integer, bumped on any breaking change, fatal on mismatch at hello.
/// Exactly one schema file may declare it, so two files cannot disagree.
pub fn protocol_version(files: &[SchemaSource]) -> Result<i64> {
    let declaring: Vec<&SchemaSource> = files
        .iter()
        .filter(|f| f.json.get(VERSION_KEY).is_some())
        .collect();
    let [only] = declaring.as_slice() else {
        return Err(CodegenError::Schema(format!(
            "exactly one schema file must declare \"{VERSION_KEY}\"; found {}",
            declaring.len()
        )));
    };
    match only
        .json
        .get(VERSION_KEY)
        .and_then(serde_json::Value::as_i64)
    {
        Some(v) if v >= 1 => Ok(v),
        other => Err(CodegenError::Schema(format!(
            "\"{VERSION_KEY}\" must be a positive integer, got {other:?}"
        ))),
    }
}

/// The header the generated file carries. Same facts as the TypeScript banner, same digest line.
fn banner(digest: &str) -> String {
    [
        "//! GENERATED FILE - DO NOT EDIT.",
        "//!",
        "//! Generated from protocol/schema/*.schema.json by `npm run gen:protocol`.",
        "//! Edit the schema, run the generator, commit both sides.",
        "//!",
        "//! Neither language is privileged: this file and its TypeScript twin",
        "//! (src/shared/dataServer/protocol.generated.ts) come from the same neutral JSON Schema,",
        "//! and a schema edit that lands without regenerating turns the protocol-codegen staleness",
        "//! test red on this side and tests/protocolSchema.test.mts red on the other.",
        "//!",
        &format!("//! schema-digest: sha256:{digest}"),
    ]
    .join("\n")
}

/// The trailer: the one constant that is a fact about the schema rather than a type in it.
fn trailer(version: i64) -> String {
    [
        "/// THE WIRE VERSION. A single integer, bumped on any breaking change. A client presents it",
        "/// in `Hello::protocol_version`; the engine answers with its own in",
        "/// `HelloReply::protocol_version`. A mismatch is FATAL by ruling - both sides log and the",
        "/// connection closes. Version skew is a build error, not a runtime state to recover from,",
        "/// because both sides generate from this one artifact.",
        &format!("pub const PROTOCOL_VERSION: i64 = {version};"),
    ]
    .join("\n")
}

/// Turn the bundled schema into Rust source. Types only — no transport, no framing, no IO.
pub fn render_types(bundle: &serde_json::Value) -> Result<String> {
    let root: schemars::schema::RootSchema = serde_json::from_value(bundle.clone())
        .map_err(|e| CodegenError::Schema(format!("bundle is not a JSON Schema document: {e}")))?;
    let mut settings = typify::TypeSpaceSettings::default();
    settings.with_struct_builder(false);
    // Ordered maps: `Cells` and `ViewFilter` are open objects, and a `HashMap` would re-serialize
    // them in a per-process order, making a wire capture unreproducible and a golden a coin flip.
    settings.with_map_type("::std::collections::BTreeMap");
    // The two replacements are the same defect twice: typify lowers a multi-type schema to an
    // untagged enum whose number arm is `f64`, turning `184220` into `184220.0` on the way back out,
    // and both of these types carry counts.
    //
    //   * `Cell` — hand-written because it is also a closed type: it must refuse an object and an
    //     array.
    //   * `ModuleState` — a module's published state, whose shape is the module's contract and not
    //     the protocol's. The definition says "any JSON", and `serde_json::Value` is that sentence
    //     in Rust.
    //
    // Every other type is generated, and `tests/protocolSchema.test.mts` knows both names by
    // exception, so a third replacement cannot be added silently.
    settings.with_replacement("Cell", "crate::cell::Cell", std::iter::empty());
    settings.with_replacement("ModuleState", "::serde_json::Value", std::iter::empty());
    let mut space = typify::TypeSpace::new(&settings);
    space
        .add_root_schema(root)
        .map_err(|e| CodegenError::Typify(e.to_string()))?;
    let stream = space.to_stream();
    let file: syn::File = syn::parse2(stream).map_err(|e| CodegenError::Syntax(format!("{e}")))?;
    Ok(prettyplease::unparse(&file))
}

/// The whole committed artifact, formatted exactly as `cargo fmt` would leave it.
pub fn render(dir: &Path) -> Result<String> {
    let files = read_schema_files(dir)?;
    let digest = schema_digest(&files);
    let version = protocol_version(&files)?;
    let types = render_types(&bundle(&files)?)?;
    // `#[allow(...)]` on the module contents rather than on the crate, so the hand-written modules
    // beside it still answer for themselves.
    let body = format!(
        "{}\n#![allow(missing_docs, clippy::all, clippy::pedantic)]\n\n{}\n{}\n",
        banner(&digest),
        types.trim_end(),
        trailer(version)
    );
    rustfmt(&body)
}

/// Format through the pinned toolchain's rustfmt, over stdin.
///
/// A direct exec of the rustfmt binary — never a shell, and never powershell.exe, which is an
/// antivirus trigger nothing under `engine/` may reintroduce. A missing rustfmt is an error rather
/// than a silent fallback: the committed artifact must be byte-identical to what `cargo fmt` would
/// produce, or the staleness test fails on formatting for a schema nobody touched.
fn rustfmt(source: &str) -> Result<String> {
    let mut child = Command::new("rustfmt")
        .args(["--edition", "2021", "--emit", "stdout", "--quiet"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            CodegenError::Rustfmt(format!(
                "could not run rustfmt ({e}) - the pinned toolchain in engine/rust-toolchain.toml \
                 lists it as a component; try `rustup component add rustfmt`"
            ))
        })?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| CodegenError::Rustfmt("no stdin".to_owned()))?
        .write_all(source.as_bytes())
        .map_err(|e| CodegenError::Rustfmt(e.to_string()))?;
    let out = child
        .wait_with_output()
        .map_err(|e| CodegenError::Rustfmt(e.to_string()))?;
    if !out.status.success() {
        return Err(CodegenError::Rustfmt(
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).replace("\r\n", "\n"))
}

/// The committed artifact as it stands on disk, LF-normalized for comparison.
pub fn committed(path: &Path) -> Result<String> {
    fs::read_to_string(path)
        .map(|s| s.replace("\r\n", "\n"))
        .map_err(|e| CodegenError::Schema(format!("{}: {e}", path.display())))
}
