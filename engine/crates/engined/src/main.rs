//! `engined` — the engine process: spawned, handed a secret, talked to, and killed. `session.attach`
//! opens the named log, scans it at full speed and follows it live.
//!
//! No game logic lives here. `eqlog` owns what an event and a line are, `fold` owns the fold that
//! turns events into state, and it reaches this crate through one trait, [`ingest::EventSink`]. This
//! crate owns the process, the protocol, and the question of who is folding.
//!
//! The spawn contract, binding and shared with the supervisor:
//!
//! 1. No secrets in argv or env — argv is world-readable and an environment block is readable by
//!    anything that can open the process. The first line on stdin is the token.
//! 2. The engine binds `127.0.0.1:0` and prints exactly one line to stdout:
//!    `EQC-ENGINE PORT=<port> PROTOCOL=<protocolVersion>`, flushed. Nothing else ever goes to
//!    stdout — it is a machine channel with one reader and one message on it. Diagnostics go to
//!    stderr.
//! 3. The engine exits 0 promptly when stdin reaches EOF. The pipe closes when the parent's handles
//!    close however it ended, which is the only mechanism that cannot lie: no orphan mode, no PID
//!    file, no heartbeat to forget to send.
//! 4. Every TCP connection opens with a valid `hello` or is closed. The port authenticates nobody;
//!    the token authenticates everybody.
//! 5. A respawn is a launch: fresh token, fresh epoch, fresh world. Resume is always re-query.
//!
//! Two exit codes, and no third. `0` is the contract's own ending. `1` is a refusal to start: no
//! token on stdin, a token that cannot be one, or a loopback socket that would not bind. Everything
//! else this process can meet is connection-level, and closes a connection rather than the process.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

/// The budgets this build enforces, served live off the running generation so the panel and a bug
/// report state what this machine did.
mod budgets;
mod concard;
mod conn;
mod foldsink;
mod ingest;
/// Which characters this install has. The app pushes the directory; this is the scan of it, and the
/// one piece of this process that reads a log file's NAME rather than its bytes.
mod logs;
mod ops;
mod search;
mod spawn;
/// Searching that table by type — the filter/sort/window behind the in-game Actions window's
/// Category and Subcategory columns. `spells` owns the files; this owns the question.
mod spell_search;
/// The client's spell table, read by this process. `fold::spells_us` is the format; this is the
/// file, the laziness and the once-ness.
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

    // Step 2. Numeric 127.0.0.1, never the name `localhost` — a name is a resolver's opinion, and on
    // a misconfigured host it has been an IPv6 address, a second interface, or a slow lookup. Port 0
    // asks the kernel for an ephemeral port, so two engines coexist without a collision story.
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

    // The one line, written before anything else can possibly write to stdout; after it this
    // process never touches stdout again.
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

    // Every attach builds the module registry and folds into it; `foldsink.rs` says what an attach
    // constructs and why.
    let server = Arc::new(Server::new(
        World::with_ingest(ingest::starter(foldsink::folding_sinks())),
        token,
    ));
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                // One thread per connection, and the count is bounded by the app: one connection
                // per renderer. A thread blocked on `recv` for an idle subscription costs a stack.
                let server = Arc::clone(&server);
                if let Err(e) = thread::Builder::new()
                    .name("engined-conn".to_owned())
                    .spawn(move || server.serve(stream))
                {
                    eprintln!("{DIAGNOSTIC_PREFIX} could not serve a connection: {e}");
                }
            }
            // One failed accept is not a dead engine: a refused or reset connection must never take
            // the listener down, or the app sees the engine vanish for someone else's mistake.
            Err(e) => eprintln!("{DIAGNOSTIC_PREFIX} accept failed: {e}"),
        }
    }

    // Unreachable in practice: `incoming()` yields forever and the process ends inside
    // `die_with_stdin`. Stated rather than `unreachable!()` because a panic here would be a worse
    // ending than a clean one.
    ExitCode::SUCCESS
}
