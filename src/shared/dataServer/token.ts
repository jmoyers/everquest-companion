// The per-launch connection token — the SHAPE rules, which both processes and the schema agree on.
//
// THE MINTING AND THE COMPARE ARE NOT HERE, and the split is the repo's own boundary rather than
// fussiness: everything in `src/shared` is bundled into the RENDERER as well as main, so nothing
// here may import `node:crypto`. Randomness and a real constant-time compare both need it, so they
// live in `src/main/dataServer/token.ts` — which is also the honest place for them, because main is
// what spawns the engine and hands it the secret. The engine's half is
// `engine/crates/protocol/src/token.rs`, and it only ever VERIFIES: a process that can mint its own
// credential is a process whose credential proves nothing.
//
// WHY A TOKEN AT ALL. The engine will listen on loopback TCP (owner ruling 7: a local socket is the
// most cross-platform transport). Loopback is not a permission boundary — any process running as
// this user can connect to 127.0.0.1 on any port — so the port is not the authentication. The token
// is. One per launch, never persisted, never logged; a respawn is a launch and mints a new one.

/**
 * How many random BYTES a token is minted from. 32 bytes is 256 bits, which hex-encodes to the
 * 64-character token `mintToken` returns. That is comfortably above `MIN_TOKEN_CHARS` — the floor
 * is what an incoming token must CLEAR, this is what this app chooses to SPEND — and either number
 * is far past guessable at any rate a loopback socket can be driven. The token is also thrown away
 * when the process ends, so there is no long-lived secret to grind at in the first place.
 */
export const TOKEN_ENTROPY_BYTES = 32

/**
 * The token's length in characters once hex-encoded, and the floor `minLength` states on `Token` in
 * `protocol/schema/messages.schema.json`. The schema, this constant and `MIN_TOKEN_BYTES` in the
 * Rust crate are three spellings of one number; `tests/protocolSchema.test.mts` pins that they
 * agree.
 */
export const MIN_TOKEN_CHARS = 32

/** The ceiling, matching `maxLength` on `Token`. A hostile first message cannot make the compare
 *  loop arbitrarily long. */
export const MAX_TOKEN_CHARS = 256

/** The alphabet a minted token uses. Stated so a malformed token is recognisable as one. */
const HEX = /^[0-9a-f]+$/

/**
 * Is this the shape of a token this app mints?
 *
 * It reads only the length and the alphabet — never a comparison against a secret — so it is safe
 * to call on untrusted input before the constant-time compare, and it leaks nothing the caller does
 * not already know about its own string.
 */
export function isWellFormedToken(token: string): boolean {
  return token.length >= MIN_TOKEN_CHARS && token.length <= MAX_TOKEN_CHARS && HEX.test(token)
}
