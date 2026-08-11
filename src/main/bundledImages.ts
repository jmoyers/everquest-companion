// bundledImages.ts — the wiki art the app SHIPS, so a normal install never asks a wiki for a
// picture at all (JOS-198).
//
// THE PROBLEM THIS CLOSES. `imageCache.ts` was a runtime scraper with a permanent disk cache:
// correct, polite, and still wrong in two ways that only show up at fleet scale. (1) The FIRST
// time any install needed an icon or a portrait it went to eqlwiki.com / wiki.project1999.com,
// so two volunteer-run wikis sat in the startup path of every fresh install and every new
// character's first loot window. (2) Image fetching became the single noisiest error source in
// the fleet — one fingerprint, tens of thousands of occurrences, none of them actionable.
// Shipping the bytes removes the cause rather than the symptom.
//
// WHAT SHIPS: everything, because the whole set was MEASURED and it is small. 751 distinct item
// icons (~0.5 MB — they are 40x40 game icons) and 29 boss portraits (~2.5 MB — they are the
// pictures a user actually looks at), together ~3 MB, against a budget of 25. Numbers, and the
// scoping argument, are recorded in the JOS-198 comment and re-derivable from
// `resources/wiki-images/manifest.json`, which states the exact upstream URL, byte length and
// sha256 of every file. `scripts/fetch-wiki-images.mts` writes both.
//
// THE NAMESPACE IS THE CACHE'S OWN. A bundled file is named by `cacheFileName()` — the very
// function `<userData>/image-cache/` names its entries with — so this module is a second ROOT
// for one naming scheme rather than a second scheme. That is what lets the lookup below be
// four lines and what makes drift structurally impossible: the fetch script, the runtime cache
// and this probe all call the same helper.
//
// WHY A PROBE AND NOT A CONSTANT PATH: the same directory has three different addresses over
// this app's life — the project root in dev and in the e2e harness, inside `app.asar` in a
// packaged build, and `app.asar.unpacked` once `asarUnpack` has moved it out (which it must:
// see electron-builder.yml). `sounds.ts` already faces exactly this for bundled soundpacks and
// answers it the same way; the roots are ORDERED and the first that exists wins.
//
// Electron is INJECTED (the caller passes the three path facts), so this file imports nothing
// from `electron` and its tests never skip.

// Imports NOTHING from `imageCache.ts` — that module imports this one, and a cycle between the
// cache and the directory it probes would be a needless one. The lookup itself (which names to
// try under this directory) therefore lives over there, beside the function that spells the
// names: `bundledCandidatePaths`.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The directory, under whichever root wins. */
export const BUNDLED_IMAGES_DIR_NAME = 'wiki-images'

/** The three path facts the roots are built from. Named so a caller cannot transpose them. */
export interface BundledImageRootInputs {
  /** `app.getAppPath()` — the project root in dev, the asar path in a packaged build. */
  readonly appPath: string
  /** `process.resourcesPath` — the packaged `resources/` dir; '' when there isn't one. */
  readonly resourcesPath: string
  /** `process.cwd()` — the project root under `npm run dev` and under the e2e harness, which
   *  launches Electron with a bare main-script argument and `cwd` set to the checkout. */
  readonly cwd: string
}

/**
 * Every place the bundled images could be, in probe order. Pure, so the ordering is testable
 * without a filesystem: dev/e2e first (the common case while developing), then the two
 * packaged shapes, then cwd as the backstop for a launch whose app path is a bare script.
 */
export function bundledImageRoots({ appPath, resourcesPath, cwd }: BundledImageRootInputs): string[] {
  const roots = [
    join(appPath, 'resources', BUNDLED_IMAGES_DIR_NAME),
    // asarUnpack moves the directory out of the archive but keeps its path inside it.
    join(`${appPath}.unpacked`, 'resources', BUNDLED_IMAGES_DIR_NAME),
    join(cwd, 'resources', BUNDLED_IMAGES_DIR_NAME)
  ]
  if (resourcesPath !== '') roots.splice(2, 0, join(resourcesPath, BUNDLED_IMAGES_DIR_NAME))
  return roots
}

/**
 * The first root that exists, or null when the app ships without images (a source build that
 * has not run `npm run fetch:images`). Null is a SUPPORTED state, not an error: the runtime
 * cache is still there and still works, which is the whole point of keeping it.
 *
 * `exists` is injected so the ordering can be tested against a made-up filesystem.
 */
export function findBundledImagesDir(
  roots: readonly string[],
  exists: (p: string) => boolean = existsSync
): string | null {
  for (const root of roots) {
    if (exists(root)) return root
  }
  return null
}
