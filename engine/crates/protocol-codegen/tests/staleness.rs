//! THE PIN. `engine/crates/protocol/src/generated.rs` is a committed artifact; this is what makes
//! committing it honest.
//!
//! Same contract `tests/telemetryDoc.test.mts` has with `gen-telemetry-doc.mts` and
//! `tests/dataWeight.test.mts` has with `gen-data-weight.mts`, restated in the other language: the
//! generator is re-run in memory and its output compared to the bytes on disk. A schema edit that
//! lands without `npm run gen:protocol` turns this red, with the fix in the failure message.
//!
//! IT REGENERATES IN FULL, unlike the TypeScript suite's check of this same file. That one can
//! only compare the digest in the header, because CI's `npm test` runs on a box that may have no
//! Rust toolchain and a check that can only run where the compiler is is a check that goes missing
//! exactly when it matters. Here the compiler is by definition present, so the comparison is over
//! every byte — the digest AND the types it produced.

use protocol_codegen::{committed, generated_path, render, schema_dir};

#[test]
fn the_committed_rust_types_are_what_the_schema_renders_today() {
    let fresh = render(&schema_dir()).expect("the schema renders");
    let on_disk = committed(&generated_path()).expect("the artifact is committed");

    if fresh == on_disk {
        return;
    }

    // A 3,000-line diff in a test failure helps nobody, so name the first line that disagrees.
    let (a, b): (Vec<&str>, Vec<&str>) = (on_disk.lines().collect(), fresh.lines().collect());
    let at = a.iter().zip(b.iter()).position(|(x, y)| x != y);
    let detail = at.map_or_else(
        || format!("the file is {} lines, the render is {}", a.len(), b.len()),
        |i| {
            format!(
                "line {}:\n  committed: {}\n  rendered:  {}",
                i + 1,
                a.get(i).unwrap_or(&"<end of file>"),
                b.get(i).unwrap_or(&"<end of file>")
            )
        },
    );
    panic!(
        "{} is STALE - run `npm run gen:protocol` and commit the result.\n{detail}",
        generated_path().display()
    );
}

#[test]
fn the_generated_file_carries_the_digest_of_the_schema_it_came_from() {
    // The cross-language half of the staleness check. `tests/protocolSchema.test.mts` recomputes
    // this same digest from the same files and looks for this same line, which is how the node
    // suite can call the Rust artifact stale without a Rust toolchain. If the two ever computed it
    // differently, this test and that one would disagree about a tree neither of them touched.
    let files = protocol_codegen::read_schema_files(&schema_dir()).expect("the schema reads");
    let digest = protocol_codegen::schema_digest(&files);
    let on_disk = committed(&generated_path()).expect("the artifact is committed");
    assert!(
        on_disk.contains(&format!("schema-digest: sha256:{digest}")),
        "the generated file does not carry the current schema digest ({digest})"
    );
}

#[test]
fn every_definition_in_the_schema_became_a_rust_type() {
    // THE MERGE GUARD. The bundling step is mirrored in two languages (see this crate's header),
    // and this is where a drift between them would show: a definition that one merge dropped
    // simply would not be here.
    //
    // TWO DELIBERATE ABSENCES, and they are the same defect twice: typify lowers a multi-type
    // schema to an enum whose number arm is `f64`, so a count comes back with a decimal point
    // stapled to it. `Cell` is replaced by the hand-written `protocol::cell::Cell` (that module's
    // header has the whole argument) and `ModuleState` by `serde_json::Value` (JOS-478 - the
    // definition says "any JSON, the module owns the shape", and that sentence IS `Value` in Rust,
    // so there is nothing to hand-write). Both are declared in this crate's `render_types` and both
    // are named here and in tests/protocolSchema.test.mts, so a third cannot appear silently.
    let files = protocol_codegen::read_schema_files(&schema_dir()).expect("the schema reads");
    let bundle = protocol_codegen::bundle(&files).expect("the schema bundles");
    let on_disk = committed(&generated_path()).expect("the artifact is committed");

    let defs = bundle["$defs"].as_object().expect("the bundle has $defs");
    assert!(
        defs.len() >= 30,
        "only {} definitions - did the merge drop a file?",
        defs.len()
    );

    for name in defs.keys() {
        if name == "Cell" {
            assert!(
                on_disk.contains("crate::cell::Cell"),
                "the hand-written Cell replacement is not being used"
            );
            continue;
        }
        if name == "ModuleState" {
            assert!(
                on_disk.contains("pub state: ::serde_json::Value"),
                "the ModuleState replacement is not being used"
            );
            continue;
        }
        let declared = [
            format!("pub struct {name} "),
            format!("pub struct {name}("),
            format!("pub struct {name} {{"),
            format!("pub enum {name} "),
            format!("pub type {name} "),
        ]
        .iter()
        .any(|needle| on_disk.contains(needle));
        assert!(declared, "$defs/{name} produced no Rust type");
    }
}

#[test]
fn the_wire_version_reaches_the_generated_file() {
    let files = protocol_codegen::read_schema_files(&schema_dir()).expect("the schema reads");
    let version = protocol_codegen::protocol_version(&files).expect("the schema states a version");
    let on_disk = committed(&generated_path()).expect("the artifact is committed");
    assert!(
        on_disk.contains(&format!("pub const PROTOCOL_VERSION: i64 = {version};")),
        "the generated file does not state protocol version {version}"
    );
    assert_eq!(
        protocol::PROTOCOL_VERSION,
        version,
        "the compiled constant disagrees with the schema"
    );
}

#[test]
fn a_schema_edit_that_skips_the_generator_is_detectable() {
    // The check above proves the artifact is current. This one proves the CHECK works: perturb the
    // schema text in memory, and the digest must move. Without this, a digest function that
    // returned a constant would pass every other assertion in this file.
    let mut files = protocol_codegen::read_schema_files(&schema_dir()).expect("the schema reads");
    let before = protocol_codegen::schema_digest(&files);
    files[0].text.push_str("\n// a comment nobody wrote\n");
    let after = protocol_codegen::schema_digest(&files);
    assert_ne!(before, after, "the digest ignores a change to the schema");
}
