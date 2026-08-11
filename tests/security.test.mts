// Electron runtime trust boundary (src/main/security.ts) — the pure half.
//
// These three functions are the only things standing between attacker-shaped text and three
// powerful sinks: `shell.openExternal` (the OS opens it — a `file:` URL EXECUTES), a window
// navigation (whatever loads inherits this app's preload bridge and its whole IPC surface),
// and a `join()` onto the soundpack roots. The text that reaches the first two is built from
// WIKI PAGE TITLES (shared/wiki.ts, fed by itemLookup's scraped `page` field), so "the only
// producer today spells it https://eqlwiki.com/…" is a convention, not a boundary — these
// tests are the boundary.
//
// No Electron, no network, no fixtures (the imageCache.test.mts precedent), so this suite
// never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  EXTERNAL_LINK_ALLOWLIST,
  allowedExternalUrl,
  isInsideDir,
  isInternalPageUrl,
  isSafePackId,
  isSafeSourcePath,
  isSafeSourceRef,
  isSafeSourceRepo
} from '../src/main/security'

const WIN = process.platform === 'win32'

// ---- allowedExternalUrl: what the OS may be asked to open -----------------------------

test('allowedExternalUrl accepts exactly the links the app produces today', () => {
  // shared/wiki.ts wikiPageUrl output, in both of its shapes.
  assert.equal(
    allowedExternalUrl('https://eqlwiki.com/Rod_of_Insidious_Glamour'),
    'https://eqlwiki.com/Rod_of_Insidious_Glamour'
  )
  assert.equal(
    allowedExternalUrl('https://eqlwiki.com/Enchanter_Plane_of_Sky_Tests'),
    'https://eqlwiki.com/Enchanter_Plane_of_Sky_Tests'
  )
  // Query + fragment survive (a wiki section link is legitimate).
  assert.equal(
    allowedExternalUrl('https://eqlwiki.com/Plane_of_Sky?action=raw#Quests'),
    'https://eqlwiki.com/Plane_of_Sky?action=raw#Quests'
  )
  // Every allowlisted host, exactly as listed.
  for (const host of EXTERNAL_LINK_ALLOWLIST) {
    assert.equal(allowedExternalUrl(`https://${host}/x`), `https://${host}/x`)
  }
  // An explicit :443 is redundant — WHATWG strips it, so this is the default port, not a
  // different service.
  assert.equal(allowedExternalUrl('https://eqlwiki.com:443/x'), 'https://eqlwiki.com/x')
})

test('allowedExternalUrl refuses every scheme but https — the RCE-adjacent shapes', () => {
  // `shell.openExternal('file:///…exe')` RUNS it. This is the one that matters most.
  assert.equal(allowedExternalUrl('file:///C:/Windows/System32/calc.exe'), null)
  assert.equal(allowedExternalUrl('file://attacker.example/share/payload.lnk'), null)
  // Registered protocol handlers reach arbitrary local software.
  assert.equal(allowedExternalUrl('ms-msdt:/id PCWDiagnostic'), null)
  assert.equal(allowedExternalUrl('search-ms:query=x&crumb=location:\\\\attacker\\share'), null)
  assert.equal(allowedExternalUrl('mailto:someone@example.com'), null)
  assert.equal(allowedExternalUrl('javascript:alert(1)'), null)
  assert.equal(allowedExternalUrl('data:text/html,<script>alert(1)</script>'), null)
  assert.equal(allowedExternalUrl('vbscript:msgbox(1)'), null)
  // Plain http is a downgrade, even on an allowlisted host.
  assert.equal(allowedExternalUrl('http://eqlwiki.com/x'), null)
  // Our own scheme is for <img src>, never for the OS.
  assert.equal(allowedExternalUrl('eqimg://item/1234'), null)
})

test('allowedExternalUrl matches the host EXACTLY (no endsWith/includes hole)', () => {
  assert.equal(allowedExternalUrl('https://eqlwiki.com.evil.com/x'), null)
  assert.equal(allowedExternalUrl('https://evil-eqlwiki.com/x'), null)
  assert.equal(allowedExternalUrl('https://evil.com/?u=https://eqlwiki.com/x'), null)
  assert.equal(allowedExternalUrl('https://evil.com/#https://eqlwiki.com/x'), null)
  assert.equal(allowedExternalUrl('https://sub.eqlwiki.com/x'), null)
  // Credentials: this parses with hostname `evil.com` — and we refuse userinfo outright.
  assert.equal(allowedExternalUrl('https://eqlwiki.com@evil.com/x'), null)
  assert.equal(allowedExternalUrl('https://user:pw@eqlwiki.com/x'), null)
  // A non-default port on an allowlisted host is a different service.
  assert.equal(allowedExternalUrl('https://eqlwiki.com:8443/x'), null)
  // Case + trailing-dot spellings must not sneak past the Set lookup (WHATWG lowercases the
  // host but keeps a trailing dot, which is a DIFFERENT hostname).
  assert.equal(allowedExternalUrl('https://EQLWIKI.COM/x'), 'https://eqlwiki.com/x')
  assert.equal(allowedExternalUrl('https://eqlwiki.com./x'), null)
})

test('allowedExternalUrl is total over garbage input', () => {
  assert.equal(allowedExternalUrl(undefined), null)
  assert.equal(allowedExternalUrl(null), null)
  assert.equal(allowedExternalUrl(42), null)
  assert.equal(allowedExternalUrl({ url: 'https://eqlwiki.com/' }), null)
  assert.equal(allowedExternalUrl(''), null)
  assert.equal(allowedExternalUrl('not a url'), null)
  assert.equal(allowedExternalUrl('/relative/path'), null)
  assert.equal(allowedExternalUrl('//eqlwiki.com/x'), null) // protocol-relative: no scheme
  assert.equal(allowedExternalUrl(`https://eqlwiki.com/${'a'.repeat(4000)}`), null)
})

// ---- isInternalPageUrl: where a window may navigate -----------------------------------

const RENDERER_DIR = WIN ? join('C:', 'app', 'out', 'renderer') : '/app/out/renderer'
/** `file://` form of a path inside RENDERER_DIR, the way Electron spells loadFile()'s result. */
const fileUrl = (rel: string): string =>
  WIN ? `file:///C:/app/out/renderer/${rel}` : `file:///app/out/renderer/${rel}`

test('isInternalPageUrl allows the bundled pages (packaged: no dev server)', () => {
  const o = { rendererDir: RENDERER_DIR }
  assert.equal(isInternalPageUrl(fileUrl('index.html'), o), true)
  assert.equal(isInternalPageUrl(fileUrl('overlay.html'), o), true)
  // loadFile(..., {search}) — the overlay's ?kind= is part of the real URL.
  assert.equal(isInternalPageUrl(fileUrl('overlay.html?kind=heal-fight'), o), true)
  assert.equal(isInternalPageUrl(fileUrl('assets/index-abc123.js'), o), true)
})

test('isInternalPageUrl allows the dev server ORIGIN, and nothing that merely looks like it', () => {
  // The port is whatever electron-vite took (5173, or 5174 when it was busy) — which is why
  // the caller passes the server's own URL instead of a hardcoded port.
  for (const dev of ['http://localhost:5173', 'http://localhost:5174']) {
    const o = { devServerUrl: dev, rendererDir: RENDERER_DIR }
    assert.equal(isInternalPageUrl(`${dev}/`, o), true)
    assert.equal(isInternalPageUrl(`${dev}/index.html`, o), true)
    assert.equal(isInternalPageUrl(`${dev}/overlay.html?kind=fight`, o), true)
    // HMR full reloads and the did-fail-load retry both go back to this origin.
    assert.equal(isInternalPageUrl(`${dev}/src/main.tsx`, o), true)
    // …but a different port is a different origin, and so is a lookalike host.
    assert.equal(isInternalPageUrl('http://localhost:9999/', o), false)
    assert.equal(isInternalPageUrl('http://localhost.evil.com:5173/', o), false)
    assert.equal(isInternalPageUrl('https://localhost:5173/', o), false)
  }
  // In a packaged app there is no dev server, so an http page is never internal.
  assert.equal(isInternalPageUrl('http://localhost:5173/', { rendererDir: RENDERER_DIR }), false)
})

test('isInternalPageUrl denies everything outside the bundle', () => {
  const o = { devServerUrl: 'http://localhost:5173', rendererDir: RENDERER_DIR }
  // The whole point: a wiki link must not navigate the app window.
  assert.equal(isInternalPageUrl('https://eqlwiki.com/Plane_of_Sky', o), false)
  assert.equal(isInternalPageUrl('javascript:alert(1)', o), false)
  assert.equal(isInternalPageUrl('data:text/html,<script>alert(1)</script>', o), false)
  assert.equal(isInternalPageUrl('about:blank', o), false)
  assert.equal(isInternalPageUrl('eqimg://item/1234', o), false)
  // Other local files, including the user's own log and the store.
  assert.equal(isInternalPageUrl(WIN ? 'file:///C:/Windows/win.ini' : 'file:///etc/passwd', o), false)
  // Traversal out of the bundle dir, raw and percent-encoded.
  assert.equal(isInternalPageUrl(fileUrl('../../../Windows/win.ini'), o), false)
  assert.equal(isInternalPageUrl(fileUrl('..%2f..%2fsecret.txt'), o), false)
  // A sibling directory that merely starts with the same characters.
  assert.equal(
    isInternalPageUrl(WIN ? 'file:///C:/app/out/rendererEVIL/x.html' : 'file:///app/out/rendererEVIL/x.html', o),
    false
  )
  // UNC: a remote path must never read as "inside" a local directory.
  assert.equal(isInternalPageUrl('file://attacker.example/app/out/renderer/index.html', o), false)
  // Total over garbage.
  assert.equal(isInternalPageUrl(undefined, o), false)
  assert.equal(isInternalPageUrl('', o), false)
  assert.equal(isInternalPageUrl(123, o), false)
})

test('isInsideDir is segment-aware, traversal-aware, and platform-correct', () => {
  const dir = WIN ? join('C:', 'app', 'out', 'renderer') : '/app/out/renderer'
  assert.equal(isInsideDir(join(dir, 'index.html'), dir), true)
  assert.equal(isInsideDir(dir, dir), true)
  assert.equal(isInsideDir(join(dir, 'assets', 'x.js'), dir), true)
  assert.equal(isInsideDir(`${dir}EVIL`, dir), false)
  assert.equal(isInsideDir(join(dir, '..', 'main', 'index.js'), dir), false)
  assert.equal(isInsideDir('', dir), false)
  assert.equal(isInsideDir(join(dir, 'x'), ''), false)
  // A trailing separator on the dir must not change the answer.
  assert.equal(isInsideDir(join(dir, 'index.html'), `${dir}${WIN ? '\\' : '/'}`), true)
  if (WIN) {
    // Windows paths are case-insensitive; drive letters and separators vary by producer.
    assert.equal(isInsideDir('c:\\app\\out\\renderer\\index.html', dir), true)
    assert.equal(isInsideDir('C:/app/out/renderer/index.html', dir), true)
  }
})

// ---- isSafePackId: what may be join()ed onto the soundpack roots ----------------------

test('isSafePackId accepts real pack ids and rejects anything path-shaped', () => {
  // The ids actually in play (shipped default + registry packs).
  for (const ok of ['alan-rickman', 'sc_marine', 'peon', 'pack.v2', 'A1']) {
    assert.equal(isSafePackId(ok), true, ok)
  }
  for (const bad of [
    '..',
    '.',
    '.hidden',
    '../../../Users/jmoye/Documents',
    '..\\..\\Windows',
    'a/b',
    'a\\b',
    'C:\\Windows',
    '/etc',
    'pack:stream', // NTFS alternate data stream
    '\\\\server\\share', // UNC
    'pack\0.wav',
    '',
    'x'.repeat(129)
  ]) {
    assert.equal(isSafePackId(bad), false, JSON.stringify(bad))
  }
  assert.equal(isSafePackId(undefined), false)
  assert.equal(isSafePackId(null), false)
  assert.equal(isSafePackId(7), false)
})

// ---- registry source_* validators: what may reach a URL / an archive path -------------

test('isSafeSourceRepo accepts owner/repo and rejects traversal, extra path, junk', () => {
  // The honest registry's own shape (the shipped default pack + typical rows).
  for (const ok of [
    'utensils/openpeon-alan-rickman-soundpack',
    'PeonPing/og-packs',
    'a/b',
    'user123/pack.v2',
    'x-y/z_1',
    // JOS-162: GitHub's REAL namespace, which predates today's signup form. `heron--` is a live
    // account and owns 45 of the live registry's rows; forbidding its trailing hyphen made all
    // 45 unreachable. Consecutive and trailing hyphens are legal owner spellings.
    'heron--/openpeon-mercy-soundpack',
    'a--b/repo', // consecutive hyphens mid-owner
    'x-/repo', // trailing hyphen, minimal
    `${'a'.repeat(38)}-/repo` // trailing hyphen at the 39-char cap
  ]) {
    assert.equal(isSafeSourceRepo(ok), true, ok)
  }
  for (const bad of [
    '../../evil', // traversal
    'owner/repo/../../evil', // extra segments + traversal
    'owner/repo/extra', // more than one slash
    'owner//repo', // empty segment
    '/repo', // missing owner
    'owner/', // missing repo
    'owner', // no slash at all
    'own er/repo', // space
    '-owner/repo', // leading-hyphen owner: the anchor the loosening KEPT
    '--/repo', // an all-punctuation owner is never a namespace
    'ow.ner/repo', // a dot in the owner — the charset is what forbids `..`
    'ow..ner/repo', // traversal spelled inside the owner
    './repo', // owner is `.`
    '../repo', // owner is `..`
    '%2e%2e/repo', // percent-encoded traversal (never decoded here, and `%` is out of charset)
    'ow/ner/repo', // a slash smuggled through the owner
    `${'a'.repeat(39)}-/repo`, // 40-char owner: the length cap survives the looser charset
    'owner/..', // repo is ..
    'owner/.', // repo is .
    'owner/re po', // space in repo
    'owner/re:po', // colon (ADS-ish)
    'owner\\repo', // backslash separator
    `${'a'.repeat(40)}/repo`, // over-long owner
    ''
  ]) {
    assert.equal(isSafeSourceRepo(bad), false, JSON.stringify(bad))
  }
  assert.equal(isSafeSourceRepo(undefined), false)
  assert.equal(isSafeSourceRepo(null), false)
  assert.equal(isSafeSourceRepo(42), false)
})

test('isSafeSourceRef accepts a tag and rejects separators/traversal/leading dot', () => {
  for (const ok of ['v1.1.2', 'v1', '1.0.0', 'release-2', 'RC_3']) {
    assert.equal(isSafeSourceRef(ok), true, ok)
  }
  for (const bad of [
    '..', // traversal
    'v1/../../x', // slash + traversal
    'refs/tags/v1', // slash walks the URL path
    '.hidden', // leading dot
    '-flag', // leading dash
    'v1 2', // space
    'v1:2', // colon
    'v1\\2', // backslash
    'a..b', // embedded ..
    ''
  ]) {
    assert.equal(isSafeSourceRef(bad), false, JSON.stringify(bad))
  }
  assert.equal(isSafeSourceRef(undefined), false)
  assert.equal(isSafeSourceRef(7), false)
})

test('isSafeSourcePath accepts `.`/relative subpaths and rejects escape shapes', () => {
  for (const ok of [
    '.',
    // JOS-162: `''` is the empty-string alias of `.` — the archive root. Two live registry rows
    // spell it this way, and every consumer already collapses `''` and `.` to the same prefix.
    '',
    'sounds',
    'sounds/foo',
    'a/b/c',
    'pack.v2',
    'sounds/'
  ]) {
    assert.equal(isSafeSourcePath(ok), true, JSON.stringify(ok))
  }
  for (const bad of [
    '..',
    '../x',
    'a/../b',
    'a/..',
    '/abs/path', // absolute
    'C:\\Windows', // drive + backslash
    'C:/Windows', // drive
    'a\\b', // backslash separator
    '\\\\server\\share', // UNC
    'a//b', // empty segment
    'sounds/\0', // NUL
    '/', // a bare separator is NOT the empty alias
    '//',
    ' ' // whitespace is a path segment, not "no path"
  ]) {
    assert.equal(isSafeSourcePath(bad), false, JSON.stringify(bad))
  }
  assert.equal(isSafeSourcePath(undefined), false)
  assert.equal(isSafeSourcePath(null), false)
  assert.equal(isSafeSourcePath(1), false)
})
