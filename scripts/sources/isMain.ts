import { resolve } from 'path'
import { fileURLToPath } from 'url'

/** True when the module at `metaUrl` is the script node was asked to run (not a test import). */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1]
  return !!entry && resolve(entry).toLowerCase() === fileURLToPath(metaUrl).toLowerCase()
}
