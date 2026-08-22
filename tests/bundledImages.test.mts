// The wiki art this app SHIPS (JOS-198) — src/main/bundledImages.ts, and the bundle itself.
//
// Two suites in one file, because they pin the two halves of one promise.
//
// THE PROBE half is pure path arithmetic with an injected `exists`, so it can assert the ORDER
// the three addresses are tried in without a filesystem. The order is the whole content of that
// function: the same directory is the project root in dev and under the e2e harness, a path
// inside `app.asar` in a packaged build, and `app.asar.unpacked` once electron-builder's
// `asarUnpack` has moved it out. Getting it wrong is silent — the app falls back to fetching
// from the wiki, which is exactly the behaviour this ticket removed, and nothing says so.
//
// THE BUNDLE half reads `resources/wiki-images/manifest.json` back and holds it against the two
// committed data files it was derived from. This is the test that fails when someone re-scrapes
// bosses.json or items.json and forgets `npm run fetch:images`: a new raid target whose portrait
// was never downloaded, or a new item icon id, would otherwise ship as an image the app silently
// goes to the network for. It also re-hashes every shipped file, so a truncated or swapped
// binary cannot ride in unnoticed — the manifest is the provenance record for art that came
// from someone else's servers, and a provenance record nobody checks is decoration.
//
// No Electron, no network. The manifest suite reads the repo's own files; if the images have
// not been fetched yet (a fresh clone that skipped `npm run fetch:images`) it says so and skips,
// because a missing OPTIONAL bundle is a supported state — but a manifest that exists and
// disagrees with the data is always a failure.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_IMAGES_DIR_NAME,
  bundledImageRoots,
  findBundledImagesDir
} from '../src/main/bundledImages'
import {
  bundledCandidatePaths,
  cacheCandidateNames,
  normalizeUpstreamImageUrl,
  urlCacheHash,
  wikiItemIconUrl
} from '../src/main/imageCache'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---- the probe ----------------------------------------------------------------------

const PATHS = {
  appPath: join('C:', 'app', 'resources', 'app.asar'),
  resourcesPath: join('C:', 'app', 'resources'),
  cwd: join('C:', 'checkout')
}

test('bundledImageRoots tries the asar, then the unpacked copy, then resources, then cwd', () => {
  const roots = bundledImageRoots(PATHS)
  assert.deepEqual(roots, [
    join(PATHS.appPath, 'resources', BUNDLED_IMAGES_DIR_NAME),
    join(`${PATHS.appPath}.unpacked`, 'resources', BUNDLED_IMAGES_DIR_NAME),
    join(PATHS.resourcesPath, BUNDLED_IMAGES_DIR_NAME),
    join(PATHS.cwd, 'resources', BUNDLED_IMAGES_DIR_NAME)
  ])
})

test('bundledImageRoots drops the resources root when there is no resourcesPath', () => {
  // Plain `node`/`electron <script>` has no `process.resourcesPath`; index.ts passes ''. An
  // empty entry would make `join('', 'wiki-images')` a RELATIVE path — 'wiki-images' — which
  // would resolve against whatever the cwd happened to be. It must not be in the list at all.
  const roots = bundledImageRoots({ ...PATHS, resourcesPath: '' })
  assert.equal(roots.length, 3)
  for (const r of roots) assert.ok(isAbsolute(r), `root is relative and would follow the cwd: ${r}`)
})

test('findBundledImagesDir returns the FIRST root that exists', () => {
  const roots = bundledImageRoots(PATHS)
  // Both the unpacked copy and cwd "exist": the earlier one must win.
  const found = findBundledImagesDir(roots, (p) => p === roots[1] || p === roots[3])
  assert.equal(found, roots[1])
})

test('findBundledImagesDir returns null when this build ships no images', () => {
  // A SUPPORTED state, not an error: a source build that never ran `npm run fetch:images`
  // falls back to the runtime cache, which still works.
  assert.equal(findBundledImagesDir(bundledImageRoots(PATHS), () => false), null)
})

test("bundled lookup uses the runtime cache own names, so the two roots are one namespace", () => {
  const dir = join('C:', 'bundle')
  assert.deepEqual(bundledCandidatePaths(dir, { kind: 'item', id: '1234' }), [
    join(dir, 'item-1234.png')
  ])
  const url = 'https://wiki.project1999.com/images/Npc_master_yael.png'
  const req = { kind: 'url', url, hash: urlCacheHash(url) } as const
  assert.deepEqual(
    bundledCandidatePaths(dir, req),
    cacheCandidateNames(req).map((n) => join(dir, n))
  )
})

// ---- the bundle ---------------------------------------------------------------------

/** One row of resources/wiki-images/manifest.json. */
interface ManifestEntry {
  file: string
  url: string
  kind: 'item' | 'boss'
  bytes: number
  sha256: string
}

const imagesDir = join(ROOT, 'resources', BUNDLED_IMAGES_DIR_NAME)
const manifestPath = join(imagesDir, 'manifest.json')
const haveBundle = existsSync(manifestPath)
const skip = haveBundle ? false : 'resources/wiki-images/manifest.json not present (run `npm run fetch:images`)'

function manifest(): { images: ManifestEntry[]; totals: { files: number; bytes: number } } {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    images: ManifestEntry[]
    totals: { files: number; bytes: number }
  }
}

/** Every DISTINCT item icon id in the committed item DB — the work list the script derives. */
function itemIconIds(): Set<number> {
  const db = JSON.parse(readFileSync(join(ROOT, 'src', 'main', 'data', 'items.json'), 'utf8')) as {
    items: Record<string, { iconId?: number }>
  }
  const ids = new Set<number>()
  for (const item of Object.values(db.items)) if (typeof item.iconId === 'number') ids.add(item.iconId)
  return ids
}

/** Every boss portrait URL in the committed raid-target list, normalized as the app would. */
function bossImageUrls(): string[] {
  const db = JSON.parse(
    readFileSync(join(ROOT, 'src', 'renderer', 'src', 'data', 'eqlegends', 'bosses.json'), 'utf8')
  ) as { targets: { image?: string }[] }
  const urls: string[] = []
  for (const t of db.targets) {
    const u = typeof t.image === 'string' ? normalizeUpstreamImageUrl(t.image) : null
    if (u) urls.push(u)
  }
  return urls
}

/**
 * Icon ids an item page CLAIMS that the wiki has no file for — so `npm run fetch:images` cannot
 * ever satisfy them and this suite must not ask it to.
 *
 * EVERY ENTRY WAS VERIFIED RATHER THAN ASSUMED — an id belongs here only with a 404 beside it;
 * the list is evidence, not a mute button. The app's behaviour for these is already correct: the
 * bundle misses, the runtime cache asks once, the host says no, and the refusal is remembered for
 * the session — so the only thing wrong was a test telling the next person to re-run a script
 * that cannot help.
 *
 *   2850 — `Potion of Mystical Aptitude` states `|lucy_img_ID = 2850`;
 *          `Special:Redirect/file/Item_2850.png` answered 404 (checked live 2026-08-13, and
 *          again 2026-08-22).
 *   1918 — the `Distillate of Replenishment I..IX` pages (2026-08-22 rescrape);
 *          `Item_1918.png` answered 404 (fetch:images run, 2026-08-22).
 *   1920 — the `Distillate of Spirituality I..IX` pages, same run, same 404.
 */
const UPSTREAM_HAS_NO_FILE = new Set([2850, 1918, 1920])

test('every item icon the app can ask for is in the bundle', { skip }, () => {
  const shipped = new Set(manifest().images.filter((i) => i.kind === 'item').map((i) => i.url))
  const missing = [...itemIconIds()].filter(
    (id) => !shipped.has(wikiItemIconUrl(String(id))) && !UPSTREAM_HAS_NO_FILE.has(id)
  )
  assert.deepEqual(
    missing,
    [],
    `items.json has icon ids the bundle does not ship — re-run \`npm run fetch:images\`: ${missing.slice(0, 10).join(', ')}`
  )
})

test('every boss portrait is in the bundle', { skip }, () => {
  const shipped = new Set(manifest().images.filter((i) => i.kind === 'boss').map((i) => i.url))
  const missing = bossImageUrls().filter((u) => !shipped.has(u))
  assert.deepEqual(missing, [], `bosses.json portraits missing from the bundle: ${missing.join(', ')}`)
})

test('every manifest row names a real file with the bytes it claims', { skip }, () => {
  const m = manifest()
  let total = 0
  for (const entry of m.images) {
    const path = join(imagesDir, entry.file)
    assert.ok(existsSync(path), `manifest names a file that is not there: ${entry.file}`)
    const bytes = readFileSync(path)
    assert.equal(bytes.length, entry.bytes, `${entry.file}: byte length does not match the manifest`)
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      entry.sha256,
      `${entry.file}: contents do not match the sha256 the manifest recorded`
    )
    total += bytes.length
  }
  assert.equal(m.totals.files, m.images.length)
  assert.equal(m.totals.bytes, total)
})

test('the bundle stays small enough to ship in an installer', { skip }, () => {
  // The scoping decision, written down where it can fail. 3.75 MB measured at JOS-198 against a
  // ~25 MB budget; the ceiling is generous on purpose (a re-scrape legitimately adds icons) and
  // exists so that "ship every image" cannot quietly become "ship 60 MB of them".
  const bytes = manifest().totals.bytes
  assert.ok(bytes < 25 * 1024 * 1024, `bundled images are ${(bytes / 1024 / 1024).toFixed(2)} MB`)
})

test('every shipped image came from one of the two credited wikis', { skip }, () => {
  // The credit in Preferences -> Thanks and in the README names exactly two sites. Anything
  // whose URL is not one of them would make that credit incomplete, and could only have got
  // here by hand — the fetch script refuses anything the runtime allowlist refuses.
  for (const entry of manifest().images) {
    assert.equal(
      normalizeUpstreamImageUrl(entry.url),
      entry.url,
      `${entry.file} came from a host the app is not allowed to fetch: ${entry.url}`
    )
  }
})
