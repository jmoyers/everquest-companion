// The GitHub release download counts that ride beside the usage-analytics readout — the PURE
// half of `src/main/triage/ghDownloads.ts` (the releases list → one row per tag) and the digest
// section that prints it. No network here and none in the module's reduction: the fetch is a
// thin wrapper whose only job is to hand this function a parsed body.
//
// THREE CLAIMS, and the first is the reason the feature is labelled the way it is:
//
//   1. THE INSTALLER IS COUNTED APART FROM THE NOISE. A release carries latest.yml and a
//      .blockmap that the auto-updater fetches on every check, so a lump sum of every asset's
//      download_count would not even be a fetch count of the installer. `exeDownloads` is the
//      .exe alone; `totalDownloads` keeps the sum, labelled as such. NEITHER is an install
//      count — the updater re-downloads the installer for every install it updates — and the
//      rendered heading says so, which test 3 pins.
//   2. THE PAYLOAD IS UNTRUSTED JSON. Missing fields, a null body, an object where an array
//      belongs: all reduce to rows or to nothing, never to a throw. This runs inside a digest
//      that must survive GitHub having a bad day.
//   3. AN UNAVAILABLE SECTION SAYS WHY. "GitHub did not answer" and "nobody downloaded" are
//      opposite facts and must not share a rendering.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toDownloadRows } from '../src/main/triage/ghDownloads'
import { downloadsLines } from '../scripts/analyticsDigest.mjs'

/** The response shape, trimmed to the fields the reduction reads. */
const RELEASES: unknown = [
  {
    tag_name: 'v0.5.0',
    published_at: '2026-08-01T10:00:00Z',
    assets: [
      { name: 'everquest-companion-Setup-0.5.0.exe', download_count: 61 },
      { name: 'everquest-companion-Setup-0.5.0.exe.blockmap', download_count: 940 },
      { name: 'latest.yml', download_count: 5_400 }
    ]
  },
  {
    tag_name: 'v0.4.0',
    published_at: '2026-07-20T09:00:00Z',
    assets: [
      { name: 'everquest-companion-Setup-0.4.0.exe', download_count: 12 },
      { name: 'latest.yml', download_count: 300 }
    ]
  },
  {
    tag_name: 'v0.6.0-draft',
    draft: true,
    published_at: '2026-08-04T09:00:00Z',
    assets: [{ name: 'everquest-companion-Setup-0.6.0.exe', download_count: 0 }]
  }
]

test('the installer is counted apart from the yml/blockmap the updater fetches far more', () => {
  const rows = toDownloadRows(RELEASES)
  assert.equal(rows[0].tag, 'v0.5.0')
  assert.equal(rows[0].exeDownloads, 61)
  // Everything on the release, installer included — the honest sum, and visibly the larger one.
  assert.equal(rows[0].totalDownloads, 61 + 940 + 5_400)
  assert.equal(rows[1].exeDownloads, 12)
  assert.equal(rows[1].totalDownloads, 312)
})

test('drafts are dropped and the list reads newest first', () => {
  const rows = toDownloadRows(RELEASES)
  // A draft nobody could have downloaded would render as a zero row, which reads as a failed
  // launch rather than as an unpublished one.
  assert.deepEqual(rows.map((r) => r.tag), ['v0.5.0', 'v0.4.0'])
  assert.equal(rows[0].publishedAt, '2026-08-01T10:00:00Z')
})

test('an untrusted payload reduces to rows or to nothing — it never throws', () => {
  assert.deepEqual(toDownloadRows(null), [])
  assert.deepEqual(toDownloadRows({ message: 'API rate limit exceeded' }), [])
  assert.deepEqual(toDownloadRows('[]'), [])
  const sparse = toDownloadRows([{ tag_name: 'v0.1.0' }, { assets: [{ name: 'x.exe' }] }, 7])
  assert.deepEqual(sparse.map((r) => r.tag), ['v0.1.0', '(untagged)'])
  for (const r of sparse) {
    assert.equal(r.exeDownloads, 0)
    assert.equal(r.totalDownloads, 0)
    assert.equal(r.publishedAt, null)
  }
})

test('the digest section names the tags AND refuses to be read as installs', () => {
  const text = downloadsLines({
    available: true,
    releases: toDownloadRows(RELEASES),
    fetchedAtMs: 0
  }).join('\n')
  assert.match(text, /NOT installs/)
  assert.match(text, /v0\.5\.0\s+61 installer/)
  assert.match(text, /6401 all assets/)
  assert.match(text, /published 2026-08-01/)
  assert.equal(text.includes('v0.6.0-draft'), false)
})

test('an unavailable section prints the reason; an absent one prints nothing at all', () => {
  const failed = downloadsLines({ available: false, reason: 'github rate limit spent' })
  assert.match(failed.join('\n'), /\(unavailable: github rate limit spent\)/)
  // …and the heading is still there: a section that vanished would read as "no downloads".
  assert.match(failed.join('\n'), /GH DOWNLOADS/)
  assert.deepEqual(downloadsLines(undefined), [])
  assert.deepEqual(downloadsLines({ available: true, releases: [], fetchedAtMs: 0 }), [
    '',
    'GH DOWNLOADS (updater-inflated - NOT installs; global, never cohort-split)',
    '  (no published releases)'
  ])
})
