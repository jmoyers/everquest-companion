//! `cargo run -p protocol-codegen [-- --check]`
//!
//! Writes `engine/crates/protocol/src/generated.rs` from `protocol/schema/*.schema.json`.
//! `npm run gen:protocol` drives this after generating the TypeScript twin, so one command
//! regenerates both sides from the one artifact.
//!
//! `--check` writes nothing and exits non-zero when the committed file is stale — the same question
//! `tests/staleness.rs` asks, without a test harness.

use std::process::ExitCode;

use protocol_codegen::{committed, generated_path, render, schema_dir};

fn main() -> ExitCode {
    let check = std::env::args().skip(1).any(|a| a == "--check");
    let out = generated_path();

    let fresh = match render(&schema_dir()) {
        Ok(text) => text,
        Err(e) => {
            eprintln!("gen:protocol (rust): {e}");
            return ExitCode::FAILURE;
        }
    };

    let before = committed(&out).unwrap_or_default();

    if check {
        if before == fresh {
            println!("gen:protocol (rust): generated.rs is current");
            return ExitCode::SUCCESS;
        }
        eprintln!(
            "gen:protocol (rust): {} is STALE - run `npm run gen:protocol` and commit the result",
            out.display()
        );
        return ExitCode::FAILURE;
    }

    if before == fresh {
        println!("gen:protocol (rust): generated.rs is already current");
        return ExitCode::SUCCESS;
    }
    if let Some(parent) = out.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("gen:protocol (rust): {}: {e}", parent.display());
            return ExitCode::FAILURE;
        }
    }
    match std::fs::write(&out, fresh.as_bytes()) {
        Ok(()) => {
            println!("gen:protocol (rust): wrote {}", out.display());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("gen:protocol (rust): {}: {e}", out.display());
            ExitCode::FAILURE
        }
    }
}
