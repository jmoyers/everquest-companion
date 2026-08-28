//! The spawn contract's three moments: taking the secret, announcing the port, and dying with the
//! app. Everything here is tiny and pure where it can be, because the supervisor on the other side
//! is written in another language and the two must agree byte for byte about one line of text.

use std::io::{BufRead, Read};
use std::process::exit;
use std::thread;

use protocol::token::well_formed;

/// The stderr tag every diagnostic this process writes carries.
///
/// It exists so the supervisor can fold the engine's stderr into the app's own error log without
/// losing which process said what.
pub const DIAGNOSTIC_PREFIX: &str = "[eqc-engine]";

/// The word the announce line opens with. A supervisor reading a line that does not start with this
/// is reading somebody else's output and must not try to parse it.
pub const ANNOUNCE_TAG: &str = "EQC-ENGINE";

/// Why the engine refused to start before it ever bound a socket.
#[derive(Debug)]
pub enum TokenError {
    /// Stdin ended before a line arrived. Almost always a supervisor that spawned the process and
    /// forgot to write the token, or wrote it without a terminating newline and then exited.
    Absent,
    /// The line arrived but cannot be a token. Refusing here rather than at the first hello is
    /// deliberate: an engine holding a token no client could present refuses every connection, which
    /// is far harder to read from the app side than a process that never started.
    Malformed {
        /// The length of what arrived, in bytes. The value itself is never reported — a malformed
        /// token is still somebody's secret, and a diagnostic gets pasted into bug reports.
        bytes: usize,
    },
    /// Stdin could not be read at all.
    Unreadable(std::io::Error),
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Absent => write!(f, "stdin reached EOF before the token line arrived"),
            Self::Malformed { bytes } => write!(
                f,
                "the first line on stdin is {bytes} bytes, which cannot be a token"
            ),
            Self::Unreadable(e) => write!(f, "stdin could not be read: {e}"),
        }
    }
}

/// Take the token from the first line of the given reader.
///
/// The terminator is stripped, CR included, because a Windows text-mode stream translates one into
/// the other.
///
/// The token is returned as a plain `String` and not the generated `Token` newtype on purpose:
/// `Token` is a wire type that exists to be serialized, and the engine's copy is the one value in
/// the process that must never appear in a message.
///
/// # Errors
/// [`TokenError`] — see its variants; each is a refusal to start.
pub fn read_token(reader: &mut impl BufRead) -> Result<String, TokenError> {
    let mut line = String::new();
    let read = reader
        .read_line(&mut line)
        .map_err(TokenError::Unreadable)?;
    if read == 0 {
        return Err(TokenError::Absent);
    }
    // One terminator, stripped in the order the wire wrote it. Not `trim_end`, which would also eat
    // meaningful trailing bytes if a token ever grew a character class this one does not have.
    let token = line.strip_suffix('\n').unwrap_or(line.as_str());
    let token = token.strip_suffix('\r').unwrap_or(token);
    if !well_formed(token) {
        return Err(TokenError::Malformed { bytes: token.len() });
    }
    Ok(token.to_owned())
}

/// Render the one line this process writes to stdout, terminator included.
///
/// Pure, and tested as a string, because it is a cross-language contract: a space or a case change
/// here is a supervisor that hangs waiting for a line it will never recognise. The version travels
/// on this line so a supervisor can refuse a skewed build before it opens a socket.
#[must_use]
pub fn announce_line(port: u16, protocol_version: i64) -> String {
    format!("{ANNOUNCE_TAG} PORT={port} PROTOCOL={protocol_version}\n")
}

/// Arm the dies-with-the-app law: a thread that reads stdin to its end and exits the process.
///
/// It consumes no messages: the token was the whole protocol on this pipe, so everything read here
/// is discarded and reaching the end is the only event this thread waits for.
///
/// A read error is also an ending. A broken pipe reports itself as an error on one platform and as a
/// zero-length read on another; both mean the parent's handle is gone, so both exit 0. Treating an
/// error as a reason to keep serving is exactly the orphan this rule prevents.
///
/// `process::exit` is the right instrument and not a shortcut: connection threads are blocked in
/// `recv` on sockets nobody will write to again, and there is no state worth unwinding for — the
/// engine holds no cache and no file it is midway through writing.
pub fn die_with_stdin() {
    let spawned = thread::Builder::new()
        .name("engined-stdin".to_owned())
        .spawn(|| {
            let mut stdin = std::io::stdin().lock();
            let mut scratch = [0_u8; 256];
            loop {
                match stdin.read(&mut scratch) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            exit(0);
        });
    if let Err(e) = spawned {
        // Without this thread the engine cannot promise to die with the app, so it must not pretend
        // to. The supervisor reports a spawn that never came up.
        eprintln!("{DIAGNOSTIC_PREFIX} could not watch stdin, so the engine cannot promise to die with the app: {e}");
        exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{announce_line, read_token, TokenError};

    const GOOD: &str = "0f7d2c9a4b1e6538aa03d7c5e9124f86b0d3a7c1e2f4085967ab3cd12e4f7089";

    #[test]
    fn the_first_line_is_the_token() {
        let wire = format!("{GOOD}\n").into_bytes();
        let token = read_token(&mut wire.as_slice()).expect("a token");
        assert_eq!(token, GOOD);
    }

    #[test]
    fn a_crlf_terminator_is_tolerated() {
        let wire = format!("{GOOD}\r\n").into_bytes();
        let token = read_token(&mut wire.as_slice()).expect("a token");
        assert_eq!(token, GOOD);
    }

    #[test]
    fn a_final_line_with_no_terminator_is_still_a_token() {
        let wire = GOOD.to_owned().into_bytes();
        let token = read_token(&mut wire.as_slice()).expect("a token");
        assert_eq!(token, GOOD);
    }

    #[test]
    fn nothing_at_all_is_a_refusal_to_start() {
        let wire: Vec<u8> = Vec::new();
        assert!(matches!(
            read_token(&mut wire.as_slice()),
            Err(TokenError::Absent)
        ));
    }

    #[test]
    fn a_line_that_cannot_be_a_token_is_a_refusal_to_start() {
        let wire = b"hunter2\n".to_vec();
        assert!(matches!(
            read_token(&mut wire.as_slice()),
            Err(TokenError::Malformed { bytes: 7 })
        ));
    }

    #[test]
    fn the_announce_line_is_exactly_this_shape() {
        assert_eq!(
            announce_line(49711, 1),
            "EQC-ENGINE PORT=49711 PROTOCOL=1\n"
        );
    }

    #[test]
    fn the_announce_line_is_one_line() {
        let line = announce_line(1, 7);
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.ends_with('\n'));
    }
}
