//! The per-launch connection token.
//!
//! THE THREAT, STATED PLAINLY. The engine will listen on loopback TCP (owner ruling 7: a local
//! socket is the most cross-platform transport). Loopback is not a permission boundary: any
//! process running as this user — and on a shared machine, sometimes not even this user — can
//! connect to 127.0.0.1 on any port. So the port is not the authentication; the token is. Electron
//! main mints one per launch, hands it to the engine out of band at spawn, and the app presents it
//! in the first message on every connection. It is never written to disk, never logged, and never
//! survives the process that made it: a respawn is a launch, and a launch mints a new one.
//!
//! WHY THE COMPARE IS THE INTERESTING PART. A byte-at-a-time compare returns sooner for a wrong
//! guess that shares a longer prefix. Over loopback, where a caller can retry thousands of times a
//! second with no network jitter, that is a usable oracle: an attacker recovers the token one byte
//! at a time instead of guessing 2^128. [`tokens_match`] therefore folds every byte into one
//! accumulator with no data-dependent branch and no early return — length inequality included,
//! because returning early on a length mismatch is still a branch on the secret.
//!
//! THE HONEST LIMIT: a hand-written loop is at the optimizer's mercy, so the accumulator goes
//! through [`std::hint::black_box`] to stop LLVM proving it may exit early. That is the strongest
//! statement this crate can make without taking a dependency on a constant-time primitives crate;
//! the TypeScript side has it easier and uses `crypto.timingSafeEqual`, which is constant-time by
//! contract rather than by construction.
//!
//! MINTING IS NOT HERE, on purpose. The engine verifies; it never issues. Whatever spawns the
//! engine owns the secret's lifetime, and a process that can mint its own credential is a process
//! whose credential proves nothing.

/// The floor a token must clear, in bytes of the encoded string. It matches `minLength` on `Token`
/// in `protocol/schema/messages.schema.json`.
///
/// THE ARITHMETIC, because two languages state it and they must agree: the token travels as hex, so
/// 32 encoded bytes is 32 hex characters, which is 16 raw bytes — 128 bits. That is the FLOOR an
/// incoming token must clear, not what the app spends: `mintToken` in
/// `src/main/dataServer/token.ts` draws 32 raw bytes and sends 64 hex characters (256 bits).
/// Either figure is far past guessable at any rate a loopback socket can be driven, and the floor
/// is deliberately the weaker of the two so it can outlive a change to what minting chooses.
pub const MIN_TOKEN_BYTES: usize = 32;

/// The ceiling, matching `maxLength` on `Token`. It exists so a hostile first message cannot make
/// the compare loop arbitrarily long.
pub const MAX_TOKEN_BYTES: usize = 256;

/// Does the presented token match the expected one?
///
/// Constant-time with respect to CONTENT: the loop runs over the longer of the two and folds every
/// byte, so no prefix is cheaper to test than any other. It is deliberately NOT constant-time with
/// respect to the presented length, which the caller chose and which is therefore not a secret.
///
/// A token that fails the length bounds can never match, whatever `expected` holds — so an engine
/// that somehow started with an empty expectation still refuses an empty presentation rather than
/// accepting every caller.
#[must_use]
pub fn tokens_match(expected: &str, presented: &str) -> bool {
    let a = expected.as_bytes();
    let b = presented.as_bytes();

    let mut diff: usize = a.len() ^ b.len();
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= usize::from(x ^ y);
    }
    let equal = std::hint::black_box(diff) == 0;

    equal && well_formed(expected) && well_formed(presented)
}

/// Is this string inside the bounds the schema states for `Token`?
///
/// A separate, branchy check on purpose: it reads only lengths, never content, so it leaks
/// nothing a caller does not already know about its own input.
#[must_use]
pub fn well_formed(token: &str) -> bool {
    (MIN_TOKEN_BYTES..=MAX_TOKEN_BYTES).contains(&token.len())
}

#[cfg(test)]
mod tests {
    use super::{tokens_match, well_formed, MAX_TOKEN_BYTES, MIN_TOKEN_BYTES};

    const GOOD: &str = "0f7d2c9a4b1e6538aa03d7c5e9124f86b0d3a7c1e2f4085967ab3cd12e4f7089";

    #[test]
    fn the_same_token_matches_itself() {
        assert!(tokens_match(GOOD, GOOD));
    }

    #[test]
    fn one_flipped_byte_anywhere_refuses() {
        for i in 0..GOOD.len() {
            let mut bytes = GOOD.as_bytes().to_vec();
            bytes[i] = if bytes[i] == b'0' { b'1' } else { b'0' };
            let candidate = String::from_utf8(bytes).expect("hex stays ascii");
            assert!(
                !tokens_match(GOOD, &candidate),
                "a token differing only at byte {i} was accepted"
            );
        }
    }

    #[test]
    fn a_correct_prefix_is_not_a_partial_match() {
        // The property the constant-time compare exists for, asserted at the level a test can
        // reach: no prefix of the real token is ever accepted, however long.
        for cut in 1..GOOD.len() {
            assert!(!tokens_match(GOOD, &GOOD[..cut]));
        }
    }

    #[test]
    fn an_empty_presentation_never_matches_an_empty_expectation() {
        assert!(!tokens_match("", ""));
        assert!(!tokens_match("", GOOD));
        assert!(!tokens_match(GOOD, ""));
    }

    #[test]
    fn the_bounds_are_the_schemas_bounds() {
        assert!(!well_formed(&"a".repeat(MIN_TOKEN_BYTES - 1)));
        assert!(well_formed(&"a".repeat(MIN_TOKEN_BYTES)));
        assert!(well_formed(&"a".repeat(MAX_TOKEN_BYTES)));
        assert!(!well_formed(&"a".repeat(MAX_TOKEN_BYTES + 1)));
    }

    #[test]
    fn an_over_long_presentation_is_refused_rather_than_truncated() {
        let padded = format!("{GOOD}{}", "0".repeat(MAX_TOKEN_BYTES));
        assert!(!tokens_match(GOOD, &padded));
    }
}
