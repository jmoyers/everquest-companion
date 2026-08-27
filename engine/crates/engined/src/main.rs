//! `engined` — THE ENGINE PROCESS (JOS-459). A process that can be spawned, handed a secret, talked
//! to, and killed (phase 0, JOS-466) — and, since JOS-474, one that INGESTS: `session.attach` opens
//! the named log, scans it at full speed and follows it live, through `eqlog`.
//!
//! WHERE THE GAME LOGIC IS, AND IS NOT. Not here. `eqlog` owns what an event is (JOS-469, proven
//! byte-identical to the TS parser) and what a line is (JOS-472, proven scan-equivalent); the fold
//! that turns events into state arrives in `fold` (JOS-471) and reaches this crate through ONE
//! trait, [`ingest::EventSink`]. This crate owns the process, the protocol, and the question of who
//! is folding — see [`ingest`] for the generation law and [`world`] for the one door.
//!
//! THE SPAWN CONTRACT (binding, shared verbatim with the supervisor ticket JOS-467):
//!
//! 1. The supervisor spawns `engined.exe` with NO SECRETS IN ARGV OR ENV. The first line on stdin
//!    is the token. Argv is world-readable on both platforms this app can reach — `wmic`, `ps`,
//!    Task Manager's command-line column — and an environment block is readable by anything that
//!    can open the process; a pipe the parent already owns is neither.
//! 2. The engine binds `127.0.0.1:0` (the kernel picks the port) and prints EXACTLY ONE line to
//!    stdout: `EQC-ENGINE PORT=<port> PROTOCOL=<protocolVersion>`, flushed. NOTHING ELSE EVER GOES
//!    TO STDOUT — stdout is a machine channel with one reader and one message on it, so a stray
//!    `println!` is a supervisor that cannot parse its own child. Diagnostics go to stderr.
//! 3. The engine exits 0 promptly when stdin reaches EOF. That is owner ruling 10 — THE ENGINE DIES
//!    WITH THE APP — implemented as the only mechanism that cannot lie: the pipe closes when the
//!    parent's handles close, whether it exited cleanly, crashed, or was killed. No orphan mode, no
//!    PID file, no heartbeat to forget to send.
//! 4. Every TCP connection opens with a valid `hello` or is closed. Loopback is not a permission
//!    boundary (see `protocol::token`), so the port authenticates nobody and the token authenticates
//!    everybody.
//! 5. A respawn is a launch: fresh token, fresh epoch, fresh world. Resume is always re-query.
//!
//! EXIT CODES. `0` is the contract's own ending — stdin reached EOF and the app is gone. `1` is a
//! refusal to start: no token on stdin, a token that cannot be one, or a loopback socket that would
//! not bind. There is no third outcome, because everything else this process can meet is a
//! connection-level failure and a connection-level failure closes a connection, never the process.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

/// THE BUDGETS THIS BUILD ENFORCES (owner ruling 19, JOS-502) — the definitions `tests/budget.rs`
/// asserts in CI, served live off the generation that is running so the panel and a bug report
/// state what THIS machine did.
mod budgets;
mod concard;
mod conn;
mod foldsink;
mod ingest;
/// WHICH CHARACTERS THIS INSTALL HAS (owner ruling 21). The app pushes the directory; this is the
/// scan of it, and the one piece of this process that reads a log file's NAME rather than its bytes.
mod logs;
mod ops;
mod search;
mod spawn;
/// SEARCHING that table by TYPE (JOS-507) — the filter/sort/window the in-game Actions window's
/// Category and Subcategory columns make possible. `spells` owns the files; this owns the question,
/// the same split `search` and `fold::combat` make for fights.
mod spell_search;
/// The CLIENT's spell table, read by this process (boundary verdict 7). `fold::spells_us` is the
/// format; this is the file, the laziness and the once-ness.
mod spells;
mod state;
mod views;
mod wire;
mod world;

use std::io::{self, Write};
use std::net::{Ipv4Addr, TcpListener};
use std::process::ExitCode;
use std::sync::Arc;
use std::thread;

use protocol::PROTOCOL_VERSION;

use crate::conn::Server;
use crate::spawn::DIAGNOSTIC_PREFIX;
use crate::world::World;

/// The refusal-to-start code. See the module header: there are two exit codes and this is the
/// other one.
const EXIT_REFUSED_TO_START: u8 = 1;

fn main() -> ExitCode {
    // Step 1 of the contract. The lock is scoped so the stdin-EOF watch below can take it again;
    // both use the process-global stdin buffer, so nothing the supervisor wrote is lost between
    // them.
    let token = {
        let mut stdin = io::stdin().lock();
        match spawn::read_token(&mut stdin) {
            Ok(token) => token,
            Err(why) => {
                eprintln!("{DIAGNOSTIC_PREFIX} refusing to start: {why}");
                return ExitCode::from(EXIT_REFUSED_TO_START);
            }
        }
    };

    // Step 2. NUMERIC 127.0.0.1, never the name `localhost` — a name is a resolver's opinion and on
    // a misconfigured host it has been an IPv6 address, a second interface, or a lookup that took
    // a second. Port 0 asks the kernel for an ephemeral port, which is what makes two engines (a
    // dev app and an e2e run, say) coexist without a port-collision story.
    let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, 0)) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("{DIAGNOSTIC_PREFIX} refusing to start: could not bind loopback: {e}");
            return ExitCode::from(EXIT_REFUSED_TO_START);
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(e) => {
            eprintln!("{DIAGNOSTIC_PREFIX} refusing to start: bound socket has no address: {e}");
            return ExitCode::from(EXIT_REFUSED_TO_START);
        }
    };

    // THE ONE LINE. It is written before anything else can possibly write to stdout, and after it
    // this process never touches stdout again.
    let announce = spawn::announce_line(port, PROTOCOL_VERSION);
    {
        let mut stdout = io::stdout().lock();
        if let Err(e) = stdout
            .write_all(announce.as_bytes())
            .and_then(|()| stdout.flush())
        {
            eprintln!("{DIAGNOSTIC_PREFIX} refusing to start: could not announce the port: {e}");
            return ExitCode::from(EXIT_REFUSED_TO_START);
        }
    }

    // Step 3, armed before the first connection can exist so there is no window in which the engine
    // outlives its parent.
    spawn::die_with_stdin();

    // THE FOLD IS ON (JOS-478). One line, and it is the whole of what turns a counting engine into
    // a data-bearing one: every attach now builds the twenty-module registry and folds into it, and
    // `module.snapshot` answers off it. See `foldsink.rs` for what an attach constructs and why.
    let server = Arc::new(Server::new(
        World::with_ingest(ingest::starter(foldsink::folding_sinks())),
        token,
    ));
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                // ONE THREAD PER CONNECTION, and the count is bounded by the app: one connection
                // per renderer, brokered by main. A thread that blocks on `recv` for an idle
                // subscription costs a stack and nothing else.
                let server = Arc::clone(&server);
                if let Err(e) = thread::Builder::new()
                    .name("engined-conn".to_owned())
                    .spawn(move || server.serve(stream))
                {
                    eprintln!("{DIAGNOSTIC_PREFIX} could not serve a connection: {e}");
                }
            }
            // ONE FAILED ACCEPT IS NOT A DEAD ENGINE. A refused or reset connection must never take
            // the listener down with it — the app would see the engine vanish for someone else's
            // mistake.
            Err(e) => eprintln!("{DIAGNOSTIC_PREFIX} accept failed: {e}"),
        }
    }

    // Unreachable in practice: `incoming()` yields forever and the process ends inside
    // `die_with_stdin`. Stated rather than `unreachable!()` because a panic here would be a worse
    // ending than a clean one.
    ExitCode::SUCCESS
}
