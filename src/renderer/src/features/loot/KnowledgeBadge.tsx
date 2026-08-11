import type { JSX } from 'react'
import { Chip, Stack } from '@mui/material'
import type { ItemKnowledge, ItemRecipeUse } from '@shared/types'

interface BadgeFlags {
  recipes: ItemRecipeUse[]
  hasQuests: boolean
  showQuest: boolean
  showTradeskill: boolean
}

// Task #61: an item whose stats block says QUEST ITEM but which no quest anywhere uses is a
// TRADESKILL component (Gnome Meat → Gnome Kabobs). Those get a `tradeskill` chip naming
// the recipes instead of a "quest" chip that leads nowhere. The PoSky chip already covers
// Sky items, so suppress a redundant "quest" badge there.
function badgeFlags(knowledge: ItemKnowledge, isPosky: boolean): BadgeFlags {
  const recipes = knowledge.recipes ?? []
  const hasQuests = knowledge.questUses.length > 0
  const tradeskillOnly = recipes.length > 0 && !hasQuests
  return {
    recipes,
    hasQuests,
    showQuest: (knowledge.quest || hasQuests) && !isPosky && !tradeskillOnly,
    showTradeskill: tradeskillOnly && !isPosky
  }
}

// A subtle indicator for an item the wiki knows is LORE or quest-relevant (Task #53),
// EXTENDING the local PoSky flag to any wiki-known quest item. Shown only when the async
// knowledge probe has resolved AND flags it; ordinary items render nothing (no noise).
//
// IT NO LONGER HOVERS (JOS-127). The badge used to wrap a tooltip naming the quests or recipes
// behind the flag — a popper anchored INSIDE a table row, which opens over the neighbouring
// row, and every row here is a control that takes the pane when clicked. The chip is already a
// state word (the house chip convention), and the list it used to name is exactly what the
// drill-down shows once you click through.
export function KnowledgeBadge({
  knowledge,
  isPosky
}: {
  knowledge?: ItemKnowledge
  isPosky: boolean
}): JSX.Element | null {
  if (!knowledge) return null
  const flags = badgeFlags(knowledge, isPosky)
  if (!knowledge.lore && !flags.showQuest && !flags.showTradeskill) return null
  return (
    <Stack direction="row" spacing={0.5} alignItems="center" component="span">
      {knowledge.lore && (
        <Chip size="small" color="warning" variant="outlined" label="LORE" sx={{ height: 18, fontSize: 10 }} />
      )}
      {flags.showQuest && (
        <Chip size="small" color="secondary" variant="outlined" label="quest" sx={{ height: 18, fontSize: 10 }} />
      )}
      {flags.showTradeskill && (
        <Chip size="small" color="info" variant="outlined" label="tradeskill" sx={{ height: 18, fontSize: 10 }} />
      )}
    </Stack>
  )
}
