// KnownItemTooltip — the hover layer for an item NAME anywhere in the main window.
//
// It answers the two questions a name alone can't: "what IS this" (the EQ-style item window)
// and "what is it FOR" (the quests that use it / the recipes that consume it) — plus, one hop
// deep, "and what do I get out of that" (the quest's reward items, the recipe's result), each
// of which is itself hoverable.
//
// RELATIONSHIP TO THE OTHER TWO SURFACES:
//   ItemTooltip (features/posky) — the posky-specific hover: it already HAS its stat blob and
//     shows drop/island knowledge. Unchanged; this one is the generic, knowledge-fetching kin.
//   ItemDetailDialog (features/loot) — the CLICK layer, the deep dive (drop rates, timeline).
//     Unchanged. Hover explains, click investigates.
//
// FETCH-ON-OPEN, NEVER PER ROW: the lookup lives inside the tooltip BODY, and MUI mounts a
// Tooltip's `title` node only while the tooltip is open. So a 5,000-row loot table costs zero
// lookups and zero module subscriptions until a name is actually hovered (the same precedent
// ObservedItemWindow's header states). A caller that already holds the record (the loot view's
// knowledgeByKey map) passes it in and no fetch happens at all.
//
// NESTING: nested MUI Tooltips, capped at ONE level. The outer card is interactive (the mouse
// may enter it — that's how you reach an outcome name); the nested card is NOT interactive and
// opens to the SIDE, so you read it without ever needing to move onto it, and the outer never
// has to close to let you. A depth-1 card renders its own outcomes as plain text, so there is
// no third popper and no infinite chain. A click-to-pin Popover was the alternative; hover won
// because every other item surface in the app is hover-first and a pin would need a dismiss
// affordance on a surface that has none.
//
// CLICK-THROUGH MODE (`clickThrough`, JOS-181) — how this card is allowed BACK onto a surface
// that has a dropdown toolbar over it. Twice now (JOS-127 on the Loot ledger, JOS-143 on the Sky
// tab) the owner has been unable to work a `Select` because a card belonging to a row UNDER the
// toolbar opened upward across it and held the pointer; both times the answer was to delete the
// card, and on the Sky tab the owner has now ruled the trade the other way — the card comes back,
// the defect does not. So the mode fixes the three things that made the card a click-eater, and
// each of them is stated here rather than inherited:
//   1. it opens DOWNWARD (`bottom-start`) and CANNOT go up — `flip` is disabled, and so is
//      `preventOverflow`'s main axis, which is the other modifier that can slide a card back
//      across the row it belongs to. A card whose top edge is always below its anchor's top edge
//      can never be on a toolbar its anchor is below. (The price is honest: a card anchored on
//      the very last visible row is clipped by the window bottom rather than flipping above it.)
//   2. it holds NO pointer events. `disableInteractive` already gets MUI's popper there, but the
//      guarantee is written out as `pointerEvents: 'none'` as well — a default is someone else's
//      decision, and this one is the whole defect.
//   3. it CLOSES ON POINTERDOWN, anywhere, in the capture phase — so the card is gone before the
//      control the user just aimed at opens its own list, rather than floating over the options.
// The mode is opt-in per call site because the interactive outer card is a real feature elsewhere
// (it is how you hover a quest REWARD name inside the card); what makes it structural is that a
// surface under a toolbar mounts the card through one wrapper that always passes it, and
// tests/tooltipCursor.test.mts derives that from the tree.
//
// MAIN WINDOW ONLY: it draws ObservedItemWindow, which subscribes to the itemTiers module over
// `window.eq`. The overlay bundle has no such bridge (and stays MUI-free) — the overlay gets
// the tradeskill FILTER, not this card.

import { type JSX, type ReactNode, useCallback, useEffect, useState, type ReactElement } from 'react'
import { Box, CircularProgress, Stack, Typography } from '@mui/material'
import type { ItemKnowledge } from '@shared/types'
import { EQ_ITEM_COLORS } from './ItemWindow'
import { ObservedItemWindow } from './ObservedItemWindow'
import { questUseOutcomes, questUseWhere } from './itemKnowledgeView'
import { Tooltip, type TooltipProps } from './Tooltip'

/** How many quest uses / recipes the card lists before collapsing to "+N more". */
const MAX_LISTED = 4

/** Deepest card that still offers hoverable outcomes. 0 = only the top card does. */
const MAX_HOVER_DEPTH = 0

/**
 * Fetch an item's knowledge, unless the caller already has it. Runs on MOUNT, which for a
 * tooltip body means "on open". Never throws — main degrades to an offline/negative record.
 */
function useKnowledgeOnOpen(name: string, preloaded?: ItemKnowledge): {
  data: ItemKnowledge | null
  loading: boolean
} {
  const [data, setData] = useState<ItemKnowledge | null>(preloaded ?? null)
  const [loading, setLoading] = useState(!preloaded)

  useEffect(() => {
    if (preloaded) {
      setData(preloaded)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    void window.eq
      .lookupItem(name)
      .then((k) => {
        if (alive) setData(k)
      })
      .catch(() => {
        /* main never rejects; a null record just renders the name honestly */
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [name, preloaded])

  return { data, loading }
}

/** A dim label line inside the "what it's for" block. */
function Muted({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <Typography component="div" sx={{ color: EQ_ITEM_COLORS.label, fontSize: 11, lineHeight: 1.4 }}>
      {children}
    </Typography>
  )
}

/**
 * An OUTCOME item name — a quest reward, or a recipe's result. Hoverable (opening this same
 * card for that item) only while we're inside the depth cap; deeper than that it is plain
 * text, because a chain of poppers is a maze, not an explanation.
 */
function OutcomeName({ name, depth }: { name: string; depth: number }): JSX.Element {
  const label = (
    <Box
      component="span"
      sx={{
        color: EQ_ITEM_COLORS.name,
        ...(depth <= MAX_HOVER_DEPTH
          ? { textDecoration: 'underline dotted', textUnderlineOffset: 2 }
          : {})
      }}
    >
      {name}
    </Box>
  )
  if (depth > MAX_HOVER_DEPTH) return label
  return (
    <KnownItemTooltip name={name} depth={depth + 1}>
      {label}
    </KnownItemTooltip>
  )
}

/** `a`, `b` and `c` — outcome names, each independently hoverable. */
function Outcomes({ names, depth }: { names: string[]; depth: number }): JSX.Element | null {
  if (names.length === 0) return null
  return (
    <Typography component="div" sx={{ color: EQ_ITEM_COLORS.label, fontSize: 11, lineHeight: 1.4, pl: 1 }}>
      →{' '}
      {names.map((n, i) => (
        <Box component="span" key={n}>
          {i > 0 && ', '}
          <OutcomeName name={n} depth={depth} />
        </Box>
      ))}
    </Typography>
  )
}

/**
 * "What it's for" — the block BELOW the hairline. Quest uses first (they're the reason an item
 * is notable at all), then the recipes that consume it, which is the honest answer for the big
 * family of QUEST-ITEM-flagged tradeskill components. Renders nothing when we know nothing:
 * an empty block would read as "checked, nothing there", which we can't claim while a lookup
 * may simply have failed.
 */
function WhatItsFor({ data, depth }: { data: ItemKnowledge; depth: number }): JSX.Element | null {
  const uses = data.questUses
  const recipes = data.recipes ?? []
  if (uses.length === 0 && recipes.length === 0) return null

  const shownUses = uses.slice(0, MAX_LISTED)
  const shownRecipes = recipes.slice(0, MAX_LISTED)

  return (
    <Box sx={{ mt: 0.75, pt: 0.6, borderTop: '1px solid rgba(255,255,255,0.12)' }}>
      {shownUses.length > 0 && (
        <Box sx={{ mb: shownRecipes.length > 0 ? 0.6 : 0 }}>
          <Muted>Used in {uses.length === 1 ? 'quest' : 'quests'}:</Muted>
          {shownUses.map((u) => {
            const where = questUseWhere(u)
            return (
              <Box key={`${u.source}:${u.page ?? ''}:${u.quest}:${u.role ?? ''}`} sx={{ mt: 0.25 }}>
                <Typography component="div" sx={{ color: EQ_ITEM_COLORS.text, fontSize: 11, lineHeight: 1.4 }}>
                  {u.quest}
                  {u.role === 'reward' && (
                    <Box component="span" sx={{ color: EQ_ITEM_COLORS.label }}> · reward</Box>
                  )}
                  {where && <Box component="span" sx={{ color: EQ_ITEM_COLORS.label }}> · {where}</Box>}
                </Typography>
                {/* Turning it in yields these — one hop, each its own card. */}
                <Outcomes names={questUseOutcomes(u)} depth={depth} />
              </Box>
            )
          })}
          {uses.length > shownUses.length && <Muted>+{uses.length - shownUses.length} more</Muted>}
        </Box>
      )}

      {shownRecipes.length > 0 && (
        <Box>
          <Muted>Used in {recipes.length === 1 ? 'recipe' : 'recipes'}:</Muted>
          {shownRecipes.map((r) => {
            // `recipeUseLabel` is the ONE spelling of a recipe use ("Gnome Kabobs (Baking 56)").
            // Here the name is drawn separately (it's the hoverable crafted item), so the
            // tradeskill/trivial half is taken from the same fields the label uses.
            const how = [r.tradeskill, r.trivial != null ? String(r.trivial) : null].filter(Boolean).join(' ')
            return (
              <Typography
                key={`${r.tradeskill ?? ''}:${r.recipe}`}
                component="div"
                sx={{ color: EQ_ITEM_COLORS.label, fontSize: 11, lineHeight: 1.4, mt: 0.25 }}
              >
                {/* The recipe NAME is the crafted item — so it is the outcome, and hoverable. */}
                <OutcomeName name={r.recipe} depth={depth} />
                {how && <> · {how}</>}
              </Typography>
            )
          })}
          {recipes.length > shownRecipes.length && <Muted>+{recipes.length - shownRecipes.length} more</Muted>}
        </Box>
      )}
    </Box>
  )
}

/** The tooltip BODY: the game-style item window, then what our sources add beneath it. */
function KnownItemCard({
  name,
  knowledge,
  outcomeDepth,
  stats,
  extra
}: {
  name: string
  knowledge?: ItemKnowledge
  /**
   * The nesting level the outcome names inside this body are drawn at — the ONLY thing depth
   * decides here. `MAX_HOVER_DEPTH` or shallower and they are hoverable; deeper and they are plain
   * text, which is how both a depth-1 card and a click-through card (whose popper takes no pointer
   * events, so nothing inside it could be hovered anyway) end up saying the same thing.
   */
  outcomeDepth: number
  /** a stat block the CALLER already holds — used only when the lookup has none of its own */
  stats?: string
  /** a caller's own knowledge block, drawn under the item window (see the props doc) */
  extra?: ReactNode
}): JSX.Element {
  const { data, loading } = useKnowledgeOnOpen(name, knowledge)
  return (
    <Box sx={{ p: 0.25, minWidth: 190 }}>
      {/* Both the module subscription (observed tier) and the lookup live INSIDE the body,
          so they exist only while this tooltip is open. */}
      <ObservedItemWindow
        name={name}
        stats={data?.stats}
        // The lookup wins when it has a block; the caller's is the FALLBACK, never an override —
        // a Sky quest's scraped stat text is one wiki table's copy of what the item DB states.
        rawStats={data?.statsBlock ?? stats}
        iconId={data?.iconId}
        flavor={data?.summary}
        compact
      />
      {loading && !data && (
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.5 }}>
          <CircularProgress size={11} sx={{ color: EQ_ITEM_COLORS.label }} />
          <Typography sx={{ color: EQ_ITEM_COLORS.label, fontSize: 11 }}>Looking up…</Typography>
        </Stack>
      )}
      {/* The caller's block sits ABOVE "what it's for": on the surface that passes one, where the
          item comes from is the question the tab exists to answer, and the quest/recipe uses are
          the generic afterword. It never waits on the lookup — it is knowledge we already hold. */}
      {extra}
      {data && <WhatItsFor data={data} depth={outcomeDepth} />}
      {data?.offline && (
        <Typography sx={{ color: EQ_ITEM_COLORS.label, fontSize: 10, mt: 0.4 }}>
          offline - showing what&apos;s known locally
        </Typography>
      )}
    </Box>
  )
}

/**
 * The popper modifiers that make a click-through card unable to reach the toolbar above it
 * (header, point 1). Both are DISABLED modifiers: `flip` is what would move a bottom-placed card
 * to the top when it runs out of room, and `preventOverflow`'s main axis is what would slide it up
 * when the window's bottom edge is close. With neither, the card's top edge is always its anchor's
 * bottom edge, and the anchor is always below the toolbar.
 */
const NEVER_UPWARD = [
  { name: 'flip', enabled: false },
  { name: 'preventOverflow', options: { mainAxis: false, altAxis: true } }
]

export interface KnownItemTooltipProps {
  /** item name exactly as displayed (keeps its ` +N`) */
  name: string
  /** an already-fetched record, when the caller has one — skips the lookup entirely */
  knowledge?: ItemKnowledge
  /** nesting level; 0 = the card you hovered. Callers never pass this. */
  depth?: number
  /** a raw EQ stat-block string the caller holds, shown only when the lookup has none */
  stats?: string
  /**
   * A block of the CALLER's own knowledge about this item, drawn under the item window — the Sky
   * tracker's "where, and who drops it" is the one that exists (features/posky/SkyItemCard.tsx).
   * It is a node rather than a shape because what a surface knows is that surface's business; the
   * card only owns where it goes.
   */
  extra?: ReactNode
  /**
   * Open DOWNWARD, never flip up, take no pointer events, and close on any pointerdown — the mode
   * that makes this card safe above a dropdown toolbar (JOS-181; the header states all three and
   * why). Costs the interactive outer card, so an outcome name inside is plain text here.
   */
  clickThrough?: boolean
  /** the anchor: any single element that can hold a ref */
  children: ReactElement
}

/**
 * The click-through card's open state, which it has to hold itself for one reason: it CLOSES ON
 * POINTERDOWN, anywhere. Capture phase, so nothing downstream can swallow the event first, and
 * `pointerdown` rather than `click` so the card is gone before the control the user just aimed at
 * opens its own option list over the same band.
 *
 * Returns nothing at all when inactive — an ordinary card stays UNCONTROLLED, which is MUI's own
 * hover/focus/touch behaviour and not something worth reimplementing to share one code path.
 */
function useClickThroughControl(active: boolean): Partial<Pick<TooltipProps, 'open' | 'onOpen' | 'onClose'>> {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => {
    setOpen(false)
  }, [])
  const show = useCallback(() => {
    setOpen(true)
  }, [])
  useEffect(() => {
    if (!active || !open) return
    window.addEventListener('pointerdown', close, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
    }
  }, [active, open, close])
  return active ? { open, onOpen: show, onClose: close } : {}
}

/** Hover an item name → its EQ-style window plus what it's for. See the header for nesting. */
export function KnownItemTooltip({
  name,
  knowledge,
  depth = 0,
  stats,
  extra,
  clickThrough = false,
  children
}: KnownItemTooltipProps): JSX.Element {
  const nested = depth > 0
  const controlled = useClickThroughControl(clickThrough)
  return (
    <Tooltip
      {...controlled}
      title={
        <KnownItemCard
          name={name}
          knowledge={knowledge}
          // A click-through card's popper takes no pointer events, so an outcome name inside it
          // could never be hovered — it is drawn past the cap as plain text rather than offered
          // with a dotted underline that nothing answers.
          outcomeDepth={clickThrough ? MAX_HOVER_DEPTH + 1 : depth}
          stats={stats}
          extra={extra}
        />
      }
      arrow
      // The nested card opens to the SIDE and is NON-interactive: you read it in place, so the
      // outer card never has to surrender the pointer to keep it on screen. A click-through card
      // opens DOWNWARD, which is the placement that cannot land on the toolbar above its anchor.
      placement={nested ? 'right' : clickThrough ? 'bottom-start' : 'top'}
      disableInteractive={nested || clickThrough}
      enterDelay={nested ? 120 : 250}
      leaveDelay={nested ? 0 : 80}
      slotProps={{
        popper: clickThrough
          ? // Both halves of the guarantee, said out loud: the card cannot be moved above its
            // anchor, and it cannot be hit. `disableInteractive` already leaves MUI's popper at
            // `pointer-events: none`; this repeats it because that is a library default and this
            // is the defect the whole mode exists for.
            { modifiers: NEVER_UPWARD, sx: { pointerEvents: 'none' } }
          : undefined,
        tooltip: {
          sx: {
            bgcolor: EQ_ITEM_COLORS.bg,
            border: `1px solid ${EQ_ITEM_COLORS.border}`,
            borderRadius: 1,
            maxWidth: 380,
            p: 1,
            boxShadow: 6
          }
        },
        arrow: { sx: { color: EQ_ITEM_COLORS.bg, '&::before': { border: `1px solid ${EQ_ITEM_COLORS.border}` } } }
      }}
    >
      {children}
    </Tooltip>
  )
}
