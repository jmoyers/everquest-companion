// feedHoverCards — the event overlay's ITEM hover card ("what it is", then "what it's for"), and
// this window's door to main's mob lookup.
//
// Split out of EventLogOverlay so that file is the feed itself (rows, header, footer) and this
// one is everything a row reveals when you point at it. THE MOB CARD MOVED DOWN TO `lib/`
// (JOS-194 round 6): a respawn clock wanted the identical card in the main window, so the one
// thing that differed between the two windows — the bridge that answers `mobs:lookup` — became a
// prop, and `overlayMobLookup` below is this window's. Nothing else about that card changed.
//
// LAW (do not weaken): the overlay bundle is MUI-FREE except for the ONE lazily-imported
// ItemWindow below. A pinned, locked overlay — and any session where nothing is hovered — never
// pulls MUI into this window at all. Keep the import lazy and keep everything else plain
// React + inline styles.
//
// HONESTY (law 1): each block renders only if that source said something. An item whose lookup
// says nothing renders as its NAME with no "what it's for" block at all — an empty block would
// claim "we checked, there's nothing", which we cannot know.

import { type JSX, Suspense, lazy, useEffect, useState } from 'react'
import type { ItemKnowledge } from '@shared/types'
import { questUseOutcomes, questUseWhere } from '../lib/itemKnowledgeView'
import { CARD_ITEM, CARD_LABEL, CARD_MONO, LABEL_STYLE, TEXT_STYLE } from '../lib/hoverCards'
import { nameUpgrade } from '../features/loot/itemUpgradeSim'

// The game-style item window is a MUI component; the overlay bundle is otherwise MUI-free by
// design. Loading it LAZILY keeps that promise where it matters — a pinned, locked overlay (and
// any session where the user never hovers a reward) never pulls MUI into this window at all.
const ItemWindow = lazy(() =>
  import('../lib/ItemWindow').then((m) => ({ default: m.ItemWindow }))
)

/** This card's own accent. The rest of the palette is the shared card vocabulary in lib/. */
const GOLD = '#d9b25f'
/** How many quest uses / recipes the card lists before collapsing to "+N more". */
const MAX_LISTED = 4

// ---- item knowledge: ONE fetch per item name, for the whole window's lifetime ----------
//
// Both consumers here ask the same question of the same door (`window.eqOverlay.lookupItem`,
// which is cache-first in main): the tradeskill FILTER asks about every loot row that appears,
// and the hover CARD asks about the row you're pointing at. Sharing one map means a hovered
// loot item is normally already answered — the card paints from memory with no IPC at all —
// and two rows for the same item can never race into two round trips.
const KNOWLEDGE = new Map<string, ItemKnowledge>()
const PENDING = new Map<string, Promise<ItemKnowledge | null>>()

function cachedKnowledge(name: string): ItemKnowledge | undefined {
  return KNOWLEDGE.get(name.toLowerCase())
}

/** Resolve an item's knowledge, at most once per name. Never rejects — a miss resolves null. */
export function lookupItemCached(name: string): Promise<ItemKnowledge | null> {
  const key = name.toLowerCase()
  const hit = KNOWLEDGE.get(key)
  if (hit) return Promise.resolve(hit)
  const inflight = PENDING.get(key)
  if (inflight) return inflight
  const p = window.eqOverlay
    .lookupItem(name)
    .then((k: ItemKnowledge) => {
      KNOWLEDGE.set(key, k)
      PENDING.delete(key)
      return k
    })
    .catch(() => {
      PENDING.delete(key)
      return null
    })
  PENDING.set(key, p)
  return p
}

/**
 * Knowledge for a card that is CURRENTLY OPEN. The card mounts on hover and unmounts on leave,
 * so "on mount" IS "on first hover" — a feed of 100 rows costs zero lookups until one is
 * pointed at, and a second hover of the same row costs nothing at all (the map above).
 */
function useItemKnowledge(name: string): { data: ItemKnowledge | null; loading: boolean } {
  const [data, setData] = useState<ItemKnowledge | null>(() => cachedKnowledge(name) ?? null)
  const [loading, setLoading] = useState(() => !cachedKnowledge(name))

  useEffect(() => {
    const hit = cachedKnowledge(name)
    if (hit) {
      setData(hit)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    void lookupItemCached(name).then((k) => {
      if (!alive) return
      setData(k)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [name])

  return { data, loading }
}

/**
 * "What it's for" — the block BELOW the hairline, mirroring the main window's KnownItemTooltip:
 * quest uses first (the reason an item is notable at all), then the recipes that consume it,
 * which is the honest answer for the big family of QUEST-ITEM-flagged tradeskill components.
 *
 * Outcomes are PLAIN TEXT here, unlike the main window's nested card. This is a compact,
 * always-on-top window with no room to escape a popper chain and no dismiss affordance: ONE
 * card, no hops. Renders nothing when we know nothing (an empty block would read as "checked,
 * nothing there", which a failed lookup can't claim).
 */
function WhatItsFor({ k }: { k: ItemKnowledge }): JSX.Element | null {
  const uses = k.questUses
  const recipes = k.recipes ?? []
  if (uses.length === 0 && recipes.length === 0) return null

  const shownUses = uses.slice(0, MAX_LISTED)
  const shownRecipes = recipes.slice(0, MAX_LISTED)

  return (
    <div
      data-testid="feed-card-uses"
      style={{
        marginTop: 6,
        paddingTop: 5,
        borderTop: '1px solid rgba(255,255,255,0.12)',
        fontFamily: CARD_MONO
      }}
    >
      {shownUses.length > 0 && (
        <div style={{ marginBottom: shownRecipes.length > 0 ? 5 : 0 }}>
          <div style={LABEL_STYLE}>Used in {uses.length === 1 ? 'quest' : 'quests'}:</div>
          {shownUses.map((u) => {
            const where = questUseWhere(u)
            const outcomes = questUseOutcomes(u)
            return (
              <div key={`${u.source}:${u.page ?? ''}:${u.quest}:${u.role ?? ''}`} style={{ marginTop: 2 }}>
                <div style={TEXT_STYLE}>
                  {u.quest}
                  {u.role === 'reward' && <span style={{ color: CARD_LABEL }}> · reward</span>}
                  {where && <span style={{ color: CARD_LABEL }}> · {where}</span>}
                </div>
                {/* Turning it in yields these. Named, never hoverable — see the header above. */}
                {outcomes.length > 0 && (
                  <div style={{ ...LABEL_STYLE, paddingLeft: 8 }}>→ {outcomes.join(', ')}</div>
                )}
              </div>
            )
          })}
          {uses.length > shownUses.length && (
            <div style={LABEL_STYLE}>+{uses.length - shownUses.length} more</div>
          )}
        </div>
      )}

      {shownRecipes.length > 0 && (
        <div>
          <div style={LABEL_STYLE}>Used in {recipes.length === 1 ? 'recipe' : 'recipes'}:</div>
          {shownRecipes.map((r) => {
            const how = [r.tradeskill, r.trivial != null ? String(r.trivial) : null]
              .filter(Boolean)
              .join(' ')
            return (
              <div key={`${r.tradeskill ?? ''}:${r.recipe}`} style={{ ...LABEL_STYLE, marginTop: 2 }}>
                <span style={{ color: CARD_ITEM }}>{r.recipe}</span>
                {how && <> · {how}</>}
              </div>
            )
          })}
          {recipes.length > shownRecipes.length && (
            <div style={LABEL_STYLE}>+{recipes.length - shownRecipes.length} more</div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * THE item hover card — one component behind every hover in this window (a quest's reward item
 * and a loot row's item alike). It answers the two questions a name can't: what it IS (the same
 * game item window the loot dialog and posky tooltip draw) and what it's FOR (WhatItsFor).
 *
 * It prefers a live `lookupItem` result (structured stats + icon, cache-first in main) and falls
 * back to the stat blob the scraped quest data already carries, so a reward renders instantly
 * and offline. Neither available ⇒ ItemWindow shows just the NAME, which is the honest answer.
 */
export function ItemHoverCard({ item, stats }: { item: string; stats?: string }): JSX.Element {
  const { data, loading } = useItemKnowledge(item)
  return (
    <div
      data-testid="feed-item-card"
      data-item={item}
      style={{
        background: 'rgba(15,16,23,0.98)',
        border: `1px solid ${GOLD}`,
        borderRadius: 6,
        padding: 8,
        maxWidth: 300,
        boxShadow: '0 6px 20px rgba(0,0,0,0.6)'
      }}
    >
      <Suspense fallback={<div style={{ fontSize: 11, color: CARD_ITEM, fontFamily: CARD_MONO }}>{item}</div>}>
        <ItemWindow
          name={item}
          stats={data?.stats}
          rawStats={stats ?? data?.statsBlock}
          iconId={data?.iconId}
          flavor={data?.summary}
          // The base block drawn at the name's own ` +N`, as the main window's hover card draws it.
          upgrade={nameUpgrade(item)}
          simulated={false}
          compact
        />
      </Suspense>
      {loading && !data && (
        <div style={{ ...LABEL_STYLE, fontFamily: CARD_MONO, marginTop: 4 }}>Looking up…</div>
      )}
      {data && <WhatItsFor k={data} />}
      {data?.offline && (
        <div style={{ ...LABEL_STYLE, fontFamily: CARD_MONO, marginTop: 4 }}>
          offline - showing what&apos;s known locally
        </div>
      )}
    </div>
  )
}
