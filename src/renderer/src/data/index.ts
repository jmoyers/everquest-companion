import type { BossData, PoskyData } from '@shared/types'
import { DEFAULT_PROFILE } from '@shared/profiles'
// The item rename overlay (JOS-415). posky.json is a scrape rewritten wholesale by
// `npm run scrape:posky`, so an item the wiki has since renamed is corrected HERE, at the one
// place the dataset enters the renderer — read shared/itemRenames.ts before adding a row.
import { isRenamedItem, renameItemName } from '@shared/itemRenames'
import eqlegends from './eqlegends/posky.json'
import eqlegendsBosses from './eqlegends/bosses.json'

// Bundled quest datasets keyed by profile id. Add a profile's dataset here after
// scraping it (npm run scrape:posky -- --source <id>).
const DATASETS: Record<string, PoskyData> = {
  eqlegends
}

const BOSSES: Record<string, BossData> = {
  eqlegends: eqlegendsBosses
}

const PROFILE_KEY = 'eq.profile'

export function activeProfileId(): string {
  try {
    // `|| DEFAULT` semantics deliberately: an EMPTY stored id is as unusable as a
    // missing one, so both fall back rather than selecting an unknown profile.
    const id = localStorage.getItem(PROFILE_KEY)
    return id === null || id === '' ? DEFAULT_PROFILE : id
  } catch {
    return DEFAULT_PROFILE
  }
}

export function setActiveProfileId(id: string): void {
  localStorage.setItem(PROFILE_KEY, id)
}

/**
 * One quest dataset with every renamed item name rewritten — reward, reward PAGE (the wiki link
 * target, whose canonical title is the new name; the old one is only a redirect) and the required
 * item rows.
 *
 * Returns the dataset UNTOUCHED when nothing matched, so a profile with no renamed item pays one
 * scan and keeps object identity — which matters because callers memoize on it.
 */
function renamed(data: PoskyData): PoskyData {
  const touches = (q: PoskyData['quests'][number]): boolean =>
    (q.reward !== undefined && isRenamedItem(q.reward)) || q.items.some((it) => isRenamedItem(it.name))
  if (!data.quests.some(touches)) return data
  return {
    ...data,
    quests: data.quests.map((q) =>
      touches(q)
        ? {
            ...q,
            ...(q.reward === undefined ? {} : { reward: renameItemName(q.reward) }),
            ...(q.rewardPage === undefined ? {} : { rewardPage: renameItemName(q.rewardPage) }),
            items: q.items.map((it) =>
              isRenamedItem(it.name)
                ? { ...it, name: renameItemName(it.name), ...(it.page === undefined ? {} : { page: renameItemName(it.page) }) }
                : it
            )
          }
        : q
    )
  }
}

/** Built once per profile: the rename fold is a whole-dataset map and callers memoize on identity. */
const RENAMED = new Map<string, PoskyData>()

export function getPoskyData(profileId: string = activeProfileId()): PoskyData {
  const raw = DATASETS[profileId] ?? { scrapedAt: '', quests: [] }
  const hit = RENAMED.get(profileId)
  if (hit) return hit
  const out = renamed(raw)
  RENAMED.set(profileId, out)
  return out
}

export function getBossData(profileId: string = activeProfileId()): BossData {
  return BOSSES[profileId] ?? { scrapedAt: '', targets: [] }
}
