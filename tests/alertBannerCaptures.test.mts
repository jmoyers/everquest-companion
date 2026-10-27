// The banner's "On-screen text" is a TEMPLATE, like the spoken phrase (upstream issue #53).
//
// A user who wrote `{player}` into a custom phrase heard the name; the same token in the
// On-screen text printed its own braces, because `alertBannerText` never saw the firing. These
// pin the contract now that it does: an override resolves its tokens through the same one-pass
// `applyCaptures` the speech resolver uses, a missing value renders literally rather than
// vanishing, the NAME fallback is never templated, and the length cap still applies after the
// substitution rather than before it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_BANNER_CHARS, alertBannerText } from '../src/shared/alertBanner'

test('an override resolves the firing captures like a spoken phrase', () => {
  const def = { name: 'Puma landed', bannerText: 'Puma on {player}' }
  assert.equal(alertBannerText(def, { player: 'Bob' }), 'Puma on Bob')
})

test('a token with no value renders literally, never as an empty string', () => {
  const def = { name: 'Puma landed', bannerText: 'Puma on {player}' }
  assert.equal(alertBannerText(def, { target: 'a ghoul' }), 'Puma on {player}')
  assert.equal(alertBannerText(def), 'Puma on {player}', 'a Test firing carries no captures')
})

test('the name fallback is not a template', () => {
  const def = { name: 'Mez broke on {target}' }
  assert.equal(alertBannerText(def, { target: 'a ghoul' }), 'Mez broke on {target}')
})

test('the cap applies to the resolved sentence', () => {
  // A capture is itself capped at 48 chars (alertCaptures.ts), so an override that fits the
  // banner on its own can still overflow it once the value lands. The cap runs AFTER.
  const def = { name: 'x', bannerText: `${'x'.repeat(MAX_BANNER_CHARS - 10)} {player}` }
  const text = alertBannerText(def, { player: 'A'.repeat(40) })
  assert.ok(text)
  assert.equal(text.length, MAX_BANNER_CHARS)
  assert.ok(text.endsWith('A'), 'the value was substituted before the cut, not dropped by it')
})
