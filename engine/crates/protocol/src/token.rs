//! The per-launch connection token.
//!
//! The engine listens on loopback TCP, and loopback is not a permission boundary: any process on
//! the machine can connect. The port is not the authentication — the token is. It is minted per
//! launch, handed to the engine out of band at spawn, presented in the first message of every
//! connection, and never written to disk or logged.
//!
//! The compare must be constant-time with respect to content: over loopback a caller can retry
//! thousands of times a second with no jitter, so a byte-at-a-time compare is a usable oracle that
//! recovers the token one byte at a time. [`tokens_match`] folds every byte into one accumulator
//! with no data-dependent branch and no early return — length inequality included, because an early
//! return on a length mismatch is still a branch on the secret. The accumulator goes through
//! [`std::hint::black_box`] so the optimizer cannot prove an early exit.
//!
//! Minting is not here. The engine verifies and never issues: a process that can mint its own
//! credential has a credential that proves nothing.

/// The floor a token must clear, in bytes of the encoded string, matching `minLength` on `Token` in
/// the schema.
///
/// The token travels as hex, so 32 encoded bytes is 16 raw bytes — 128 bits. This is the floor, not
/// what minting spends (the app sends 64 hex characters); the floor is deliberately the weaker of
/// the two so it outlives a change to what minting chooses.
pub const MIN_TOKEN_BYTES: usize = 32;

/// The ceiling, matching `maxLength` on `Token`. It exists so a hostile first message cannot make
/// the compare loop arbitrarily long.
pub const MAX_TOKEN_BYTES: usize = 256;

/// Does the presented token match the expected one?
///
/// Constant-time with respect to content: the loop runs over the longer of the two and folds every
/// byte, so no prefix is cheaper to test than any other. Deliberately not constant-time with respect
/// to the presented length, which the caller chose and is therefore not a secret.
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
        // No prefix of the real token is ever accepted, however long.
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
