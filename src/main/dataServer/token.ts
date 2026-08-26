// Minting and verifying the per-launch connection token. MAIN ONLY — it needs `node:crypto`, and
// `src/shared` is bundled into the renderer, where a token has no business existing at all.
//
// THE THREAT, STATED PLAINLY. The engine will listen on loopback TCP (owner ruling 7). Loopback is
// not a permission boundary: any process running as this user can connect to 127.0.0.1 on any port.
// The port is not the authentication; the token is. Main mints one per launch, hands it to the
// engine out of band at spawn, and the renderer's connection presents it in the first message. It
// is never written to disk, never logged, and never survives the process that made it.
//
// WHY THE COMPARE IS THE INTERESTING PART. A byte-at-a-time compare returns sooner for a wrong
// guess that shares a longer prefix. Over loopback, where a caller can retry thousands of times a
// second with no network jitter, that is a usable oracle: an attacker recovers the token one byte
// at a time instead of guessing 2^128. So the compare goes through `crypto.timingSafeEqual`, which
// is constant-time BY CONTRACT rather than by construction — the strongest form of this available
// in either language here. (The engine's Rust half hand-rolls the same property with a
// `black_box`'d accumulator, and says so in its own header.)
//
// TIMINGSAFEEQUAL THROWS ON A LENGTH MISMATCH, which would reintroduce the early return this whole
// function exists to avoid. So both sides are hashed to a fixed 32 bytes first and the DIGESTS are
// compared: a fixed-length input by construction, and the comparison still turns on the whole
// secret. This is the standard shape for the problem and costs a single SHA-256 of 64 bytes.
//
// WHEN THE SOCKET LANDS (a later phase-0 ticket), the host allowlist follows the precedent already
// set by `src/main/feedback/net.ts`: NUMERIC loopback literals only — `127.0.0.1` and `[::1]` —
// never the NAME `localhost`, because a name resolves through whatever the machine's resolver says
// today and a numeric literal cannot be pointed elsewhere.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { TOKEN_ENTROPY_BYTES, isWellFormedToken } from '../../shared/dataServer/token'

/** Mint a fresh per-launch token. Call it once, at spawn, and never write the result anywhere. */
export function mintToken(): string {
  return randomBytes(TOKEN_ENTROPY_BYTES).toString('hex')
}

/** A fixed-width stand-in for a variable-length secret. See the header. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/**
 * Does the presented token match the expected one?
 *
 * Constant-time with respect to CONTENT: the comparison is over two fixed-width digests, so no
 * prefix of the real token is cheaper to test than any other.
 *
 * A malformed presentation can never match, whatever `expected` holds — so a supervisor that
 * somehow started with an empty expectation still refuses an empty presentation rather than
 * accepting every caller.
 */
export function tokensMatch(expected: string, presented: string): boolean {
  const equal = timingSafeEqual(digest(expected), digest(presented))
  return equal && isWellFormedToken(expected) && isWellFormedToken(presented)
}
