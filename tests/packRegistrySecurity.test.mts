// PACK REGISTRY SECURITY TEST (JOS-110) — the sound-pack installer validates the pack name
// BEFORE it is a path, and the registry drops poisoned rows at ingest.
//
// The disclosed hole: installPack() took `pack.name` from the untrusted remote registry and
// built `join(packsRoot, name)` directly, then DELETED that dir (`rmSync(packDir, {recursive})`)
// and WROTE a staged sibling. A crafted `../../..` name resolved OUTSIDE the soundpack root,
// turning the installer into arbitrary directory-tree deletion + write — gated only on the
// registry (peonping.github.io / raw.githubusercontent.com) being malicious or MITM'd.
//
// The fix reuses the trust-boundary allowlists (isSafePackId + isSafeSource* in security.ts):
// installPack rejects a bad name/source BEFORE constructing any path, and fetchRegistry /
// readDiskCache drop rows that fail validation at ingest so one poisoned entry never reaches
// the disk cache, the listing, or a preview. These tests prove no fs operation escapes the root
// and that a good registry with one bad row still works.
//
// No network (every case is refused before the download) and no Electron `app` call (the
// targetRootOverride path never touches userPacksRoot). Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installPack, sanitizeRegistryPacks } from '../src/main/packRegistry'
import type { PackInstallProgress, RegistryPack } from '../src/shared/types'

/** A structurally-valid registry row; override any field to craft an adversarial one. */
function pack(overrides: Partial<RegistryPack>): RegistryPack {
  return {
    name: 'good-pack',
    display_name: 'Good Pack',
    source_repo: 'utensils/openpeon-alan-rickman-soundpack',
    source_ref: 'v1.1.2',
    source_path: '.',
    categories: ['task.complete'],
    sound_count: 1,
    total_size_bytes: 1,
    ...overrides
  }
}

const noProgress = (_p: PackInstallProgress): void => {
  /* the install is refused long before any progress is emitted */
}

// ---- installPack refuses before any filesystem operation ------------------------------

// The adversarial names from the ticket: traversal (posix + windows), absolute, drive, a bare
// separator, `..`, an NTFS alternate-data-stream, and an over-long id.
const EVIL_NAMES = [
  '../../evil',
  '..\\..\\evil',
  '/abs/path',
  'C:\\x',
  'a/b',
  '..',
  '.hidden', // leading dot: could be `..` or a hidden dir
  'x:y', // alternate data stream
  'x'.repeat(129) // over the length cap
]

test('installPack REFUSES a traversal/invalid name before touching the filesystem', async () => {
  for (const name of EVIL_NAMES) {
    // A fresh, isolated root per case, with a canary sibling OUTSIDE it that a `../` name would
    // resolve onto. If the guard failed, the installer would delete/create around here.
    const base = mkdtempSync(join(tmpdir(), 'jos110-'))
    const root = join(base, 'soundpacks')
    mkdirSync(root)
    const canaryDir = join(base, 'evil') // sibling that `../../evil` / `..\\..\\evil` target
    mkdirSync(canaryDir)
    const canaryFile = join(canaryDir, 'keep.txt')
    writeFileSync(canaryFile, 'do not delete me')

    try {
      await assert.rejects(
        installPack(pack({ name }), noProgress, root),
        /not a valid identifier/,
        `name ${JSON.stringify(name)} must be refused as an identifier`
      )
      // POST-CHECK: nothing created inside the root, and the canary outside it is untouched.
      assert.deepEqual(readdirSync(root), [], `root must stay empty for ${JSON.stringify(name)}`)
      assert.equal(existsSync(canaryFile), true, `canary must survive ${JSON.stringify(name)}`)
      assert.equal(readdirSync(canaryDir).length, 1, `canary dir untouched for ${JSON.stringify(name)}`)
      // And no staged sibling (`<packDir>.installing`) was created anywhere under base.
      assert.equal(
        readdirSync(base).sort().join(','),
        ['evil', 'soundpacks'].join(','),
        `no stray dirs created for ${JSON.stringify(name)}`
      )
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }
})

test('installPack REFUSES a poisoned source_* field before touching the filesystem', async () => {
  const badSources: Partial<RegistryPack>[] = [
    { source_repo: '../../evil' },
    { source_repo: 'owner/repo/../../evil' },
    { source_ref: 'v1/../../x' },
    { source_ref: '..' },
    { source_path: '../../../etc' },
    { source_path: '/abs' },
    { source_path: 'C:\\Windows' }
  ]
  for (const bad of badSources) {
    const root = mkdtempSync(join(tmpdir(), 'jos110-src-'))
    try {
      await assert.rejects(
        // Valid name so the name guard passes and the source guard is what fires.
        installPack(pack({ name: 'ok-name', ...bad }), noProgress, root),
        /source fields are not valid/,
        `source ${JSON.stringify(bad)} must be refused`
      )
      assert.deepEqual(readdirSync(root), [], `root must stay empty for ${JSON.stringify(bad)}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

// ---- fetchRegistry / readDiskCache drop bad rows and keep good ones --------------------

test('sanitizeRegistryPacks drops poisoned rows and keeps the honest ones', () => {
  const good1 = pack({ name: 'alan-rickman' })
  const good2 = pack({ name: 'sc_marine', source_repo: 'PeonPing/og-packs', source_path: 'sc_marine' })
  const poisoned = [
    pack({ name: '../../../../Users/x/Documents' }),
    pack({ name: '..\\..\\Windows' }),
    pack({ name: 'x:y' }),
    pack({ name: 'ok', source_repo: '../../evil' }),
    pack({ name: 'ok', source_ref: 'v1/../../x' }),
    pack({ name: 'ok', source_path: '../escape' })
  ]

  // One good row survives a crowd of bad ones (the golden "one poisoned entry can't block a
  // good registry" case).
  const oneGood = sanitizeRegistryPacks([poisoned[0], good1, poisoned[1]])
  assert.equal(oneGood.length, 1)
  assert.equal(oneGood[0].name, 'alan-rickman')

  // Every good row is kept; every bad row is dropped.
  const mixed = sanitizeRegistryPacks([good1, ...poisoned, good2])
  assert.deepEqual(
    mixed.map((p) => p.name),
    ['alan-rickman', 'sc_marine']
  )

  // A fully-honest registry is passed through unchanged (nothing dropped).
  const honest = [good1, good2]
  assert.deepEqual(sanitizeRegistryPacks(honest), honest)

  // An all-poison registry collapses to empty rather than throwing.
  assert.deepEqual(sanitizeRegistryPacks(poisoned), [])
})

// ---- JOS-162: the honest shapes the guard used to eat ----------------------------------
//
// The live openpeon registry carries 350 packs and this filter dropped 47 of them: 45 rows from
// the real legacy GitHub account `heron--` (one per Overwatch hero voice pack), whose trailing
// double hyphen the owner rule forbade, and 2 rows publishing an empty `source_path` where the
// registry convention is `.` — a distinction no consumer below the validator makes. Both are
// honest data, so both are KEPT now, and the traversal protections are unchanged (proven by the
// adversarial rows sanitized alongside them, in the same call).

test('sanitizeRegistryPacks keeps the legacy `heron--` owner and the empty source_path', () => {
  // One row per real-world shape, plus the two attacks that must not ride in behind them: a
  // traversal spelled inside the now-looser owner segment, and a `..` source_path.
  const heron = pack({ name: 'mercy', source_repo: 'heron--/openpeon-mercy-soundpack' })
  const emptyPath = pack({ name: 'sc-marine', source_path: '' })
  const ownerTraversal = pack({ name: 'evil1', source_repo: 'ow..ner/repo' })
  const ownerSlash = pack({ name: 'evil2', source_repo: 'ow/ner/repo' })
  const pathTraversal = pack({ name: 'evil3', source_path: '../../etc' })

  const out = sanitizeRegistryPacks([heron, ownerTraversal, emptyPath, ownerSlash, pathTraversal])
  assert.deepEqual(
    out.map((p) => p.name),
    ['mercy', 'sc-marine']
  )

  // And the shape scaled up the way the live registry is: many `heron--` rows, all kept.
  const many = Array.from({ length: 45 }, (_, i) =>
    pack({ name: `heron-pack-${String(i)}`, source_repo: 'heron--/openpeon-hero-soundpack' })
  )
  assert.equal(sanitizeRegistryPacks(many).length, 45)
})
