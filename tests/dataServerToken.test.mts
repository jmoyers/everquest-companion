// The per-launch connection token (JOS-464). Net-new: before this ticket there was no token-auth
// code anywhere in src/.
//
// WHAT IS ACTUALLY BEING PROTECTED. The engine will listen on loopback TCP (owner ruling 7: a local
// socket is the most cross-platform transport). Loopback is not a permission boundary — any process
// running as this user can connect to 127.0.0.1 on any port — so the port is not the
// authentication; the token is. The properties below are the ones a wrong implementation quietly
// loses, and each of them has a real failure behind it in somebody's codebase:
//
//   * a compare that returns early on the first differing byte is a timing oracle over a link with
//     no jitter and no rate limit;
//   * a compare that returns early on a LENGTH mismatch is the same oracle, one level up;
//   * an empty expectation that matches an empty presentation turns "the supervisor forgot to set
//     the token" into "everyone is authenticated".
//
// The Rust half — `engine/crates/protocol/src/token.rs` — carries the mirror of these tests.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_TOKEN_CHARS,
  MIN_TOKEN_CHARS,
  TOKEN_ENTROPY_BYTES,
  isWellFormedToken
} from '../src/shared/dataServer/token'
import { mintToken, tokensMatch } from '../src/main/dataServer/token'

test('a minted token is the shape the schema states', () => {
  const token = mintToken()
  assert.equal(token.length, TOKEN_ENTROPY_BYTES * 2, 'hex doubles the byte count')
  assert.ok(token.length >= MIN_TOKEN_CHARS)
  assert.ok(token.length <= MAX_TOKEN_CHARS)
  assert.ok(isWellFormedToken(token))
})

test('every launch mints a different token — a respawn is a launch', () => {
  const minted = new Set(Array.from({ length: 200 }, () => mintToken()))
  assert.equal(minted.size, 200, 'two launches produced the same secret')
})

test('a token matches itself and nothing else', () => {
  const token = mintToken()
  assert.equal(tokensMatch(token, token), true)
  assert.equal(tokensMatch(token, mintToken()), false)
})

test('NO PREFIX OF THE REAL TOKEN IS EVER ACCEPTED', () => {
  // The property the constant-time compare exists for, at the level a test can reach: an attacker
  // who has recovered the first N characters is no closer than one who has recovered none.
  const token = mintToken()
  for (let cut = 1; cut < token.length; cut += 1) {
    assert.equal(tokensMatch(token, token.slice(0, cut)), false, `a ${String(cut)}-char prefix was accepted`)
  }
})

test('one flipped character anywhere refuses', () => {
  const token = mintToken()
  for (let i = 0; i < token.length; i += 1) {
    const flipped = `${token.slice(0, i)}${token[i] === '0' ? '1' : '0'}${token.slice(i + 1)}`
    if (flipped === token) continue
    assert.equal(tokensMatch(token, flipped), false, `a token differing only at ${String(i)} was accepted`)
  }
})

test('AN EMPTY EXPECTATION AUTHENTICATES NOBODY', () => {
  // The failure this guards is not a clever attack, it is a bug: a supervisor that spawned the
  // engine before minting. Without the well-formedness half, '' === '' would let every caller in.
  assert.equal(tokensMatch('', ''), false)
  assert.equal(tokensMatch('', mintToken()), false)
  assert.equal(tokensMatch(mintToken(), ''), false)
})

test('the shape rules refuse what the schema refuses', () => {
  assert.equal(isWellFormedToken('a'.repeat(MIN_TOKEN_CHARS - 1)), false, 'below the entropy floor')
  assert.equal(isWellFormedToken('a'.repeat(MAX_TOKEN_CHARS + 1)), false, 'above the ceiling')
  assert.equal(isWellFormedToken('0'.repeat(MIN_TOKEN_CHARS)), true)
  // Not the app's alphabet. A token is minted hex; anything else did not come from `mintToken`.
  assert.equal(isWellFormedToken('Z'.repeat(MIN_TOKEN_CHARS)), false)
  assert.equal(isWellFormedToken(`${'0'.repeat(MIN_TOKEN_CHARS - 1)} `), false)
})

test('an over-long presentation is refused rather than truncated to a match', () => {
  const token = mintToken()
  assert.equal(tokensMatch(token, `${token}0`), false)
  assert.equal(tokensMatch(token, token + '0'.repeat(MAX_TOKEN_CHARS)), false)
})
