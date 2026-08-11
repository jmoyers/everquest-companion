import type { JSX } from 'react'
import { Box, Chip, CircularProgress, Stack, Typography } from '@mui/material'
import AutoStoriesIcon from '@mui/icons-material/AutoStories'
import type { ItemKnowledge, ItemQuestUse, ItemRecipeUse } from '@shared/types'
import { craftedByLabel, recipeUseLabel } from '@shared/itemKnowledge'
import { wikiPageUrl } from '@shared/wiki'
import { questUseWhere } from '../../lib/itemKnowledgeView'

// The quiet "still asking" state — shown only while the FIRST lookup for this item is in
// flight (a re-open with cached data never flashes it).
function KnowledgeLoading(): JSX.Element {
  return (
    <Box sx={{ mb: 2 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ color: 'text.secondary' }}>
        <CircularProgress size={14} />
        <Typography variant="caption">Looking up what this is for…</Typography>
      </Stack>
    </Box>
  )
}

// Does OUR knowledge add anything the in-game item window can't already say? Nothing
// notable AND we successfully checked the wiki — stay silent (don't add noise to ordinary
// vendor trash). If it was offline/notFound with no local data, also silent.
function hasKnowledge(data: ItemKnowledge, recipes: ItemRecipeUse[], crafted?: string): boolean {
  return data.lore || data.quest || data.questUses.length > 0 || recipes.length > 0 || !!crafted
}

function KnowledgeHeader({ offline }: { offline?: boolean }): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
      <AutoStoriesIcon fontSize="small" sx={{ color: 'secondary.main' }} />
      <Typography variant="subtitle2">What it&apos;s for</Typography>
      {offline && (
        <Typography variant="caption" color="text.disabled">
          (offline - showing what&apos;s known locally)
        </Typography>
      )}
    </Stack>
  )
}

/**
 * ONE QUEST USE, SPELLED IN FULL: the quest, what this item IS to it, and where it happens.
 *
 * The chip used to read `quest · giver` and drop the rest on the floor — so a use that knew its
 * start zone, or that this item is the quest's REWARD rather than its turn-in, said neither. The
 * hover card (`lib/KnownItemTooltip`) already stated all three, which meant the drill-down knew
 * less than the tooltip it replaced. Roles are the source's words, not ours: `role` is present
 * only on the quests-catalog uses, so an absent one prints nothing rather than assuming "turn-in".
 * `questUseWhere` is the ONE spelling of "giver · zone" (lib/itemKnowledgeView), shared with the
 * tooltip so the two surfaces can never word it differently.
 */
function questUseLabel(u: ItemQuestUse): string {
  const role = u.role === undefined ? undefined : u.role === 'reward' ? 'reward' : 'turn-in'
  return [u.quest, role, questUseWhere(u)].filter((s): s is string => s !== undefined && s !== '').join(' · ')
}

// The quest chips (quest · role · giver · zone), or — when the wiki flagged the item but named no
// quest — the honest admission. That admission is worth printing ONLY when we genuinely have
// nothing else: the recipe list below explains most QUEST-ITEM-flagged components.
function QuestUsesBlock({
  data,
  recipes,
  crafted
}: {
  data: ItemKnowledge
  recipes: ItemRecipeUse[]
  crafted?: string
}): JSX.Element | null {
  if (data.questUses.length > 0) {
    return (
      <Box>
        <Typography variant="caption" color="text.secondary">
          Used in {data.questUses.length === 1 ? 'quest' : 'quests'}:
        </Typography>
        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
          {data.questUses.map((u) => (
            <Chip
              key={`${u.source}:${u.quest}:${u.role ?? ''}`}
              size="small"
              variant="outlined"
              data-testid="loot-quest-use"
              color={u.source === 'posky' ? 'primary' : 'default'}
              label={questUseLabel(u)}
              sx={{ height: 22 }}
            />
          ))}
        </Stack>
      </Box>
    )
  }
  if (!data.quest || recipes.length > 0 || crafted) return null
  return (
    <Typography variant="caption" color="text.secondary">
      Flagged as a quest item on the wiki (no specific quest association found).
    </Typography>
  )
}

// The tradeskill recipes that CONSUME this item (`|recipes`).
function RecipesBlock({ recipes, questUseCount }: { recipes: ItemRecipeUse[]; questUseCount: number }): JSX.Element | null {
  if (recipes.length === 0) return null
  return (
    <Box sx={{ mt: questUseCount > 0 ? 1 : 0 }}>
      <Typography variant="caption" color="text.secondary">
        Used in {recipes.length === 1 ? 'recipe' : 'recipes'}:
      </Typography>
      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
        {recipes.map((r) => (
          <Chip
            key={`${r.tradeskill ?? ''}:${r.recipe}`}
            size="small"
            variant="outlined"
            label={recipeUseLabel(r)}
            sx={{ height: 22 }}
          />
        ))}
      </Stack>
    </Box>
  )
}

// The prose fallback for when `|recipes` wasn't a parseable bullet list — printed only when
// there is no structured recipe list to print instead.
function RecipesNote({ note, recipeCount }: { note?: string; recipeCount: number }): JSX.Element | null {
  if (!note || recipeCount > 0) return null
  return (
    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
      Used in: {note}
    </Typography>
  )
}

function CraftedNote({ crafted }: { crafted?: string }): JSX.Element | null {
  if (!crafted) return null
  return (
    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
      Crafted: {crafted}
    </Typography>
  )
}

// Attribution. ONE place builds eqlwiki URLs (src/shared/wiki.ts): eqlwiki serves articles
// from the ROOT — the `/wiki/<Title>` form this used to build 404s for EVERY item. The URL is
// undefined when there's no page title, so the link renders only when it can actually go
// somewhere.
function SourceNote({ wikiUrl, questUses }: { wikiUrl?: string; questUses: ItemQuestUse[] }): JSX.Element | null {
  if (!wikiUrl) return null
  return (
    <Typography variant="caption" color="text.disabled" display="block" sx={{ mt: 1 }}>
      Source: <a href={wikiUrl} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>eqlwiki.com</a>
      {questUses.some((u) => u.source === 'posky') && ' + Plane of Sky dataset'}
    </Typography>
  )
}

/**
 * The "What it's for" card: quest chips (with giver when known), the tradeskill recipes
 * that consume the item, and source attribution. Quiet loading/offline/empty states — no
 * narration. Rendered only when there's something to say (or while loading). The item's own
 * stats/lore live in the game-style item window above; this block is only what OUR sources
 * add on top of it.
 */
export function KnowledgeSection({
  data,
  loading
}: {
  data: ItemKnowledge | null
  loading: boolean
}): JSX.Element | null {
  if (loading && !data) return <KnowledgeLoading />
  if (!data) return null

  // Tradeskill knowledge (Task #61): a QUEST ITEM flag with no quest anywhere means the
  // item is a recipe COMPONENT, and `|recipes` says which. That's a real answer, so it
  // opens the card on its own even for an item nothing flags.
  const recipes = data.recipes ?? []
  const crafted = craftedByLabel(data)
  if (!hasKnowledge(data, recipes, crafted)) return null

  return (
    <Box sx={{ mb: 2 }}>
      <KnowledgeHeader offline={data.offline} />
      <QuestUsesBlock data={data} recipes={recipes} crafted={crafted} />
      <RecipesBlock recipes={recipes} questUseCount={data.questUses.length} />
      <RecipesNote note={data.recipesNote} recipeCount={recipes.length} />
      <CraftedNote crafted={crafted} />
      <SourceNote wikiUrl={wikiPageUrl(data.page)} questUses={data.questUses} />
    </Box>
  )
}
