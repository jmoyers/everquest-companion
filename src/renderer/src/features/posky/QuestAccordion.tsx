// QuestAccordion — ONE Plane of Sky quest, as the Quests tab draws it (see PoskyView.tsx).
//
// Its own file because it is the bulk of that tab: a collapsed summary row that has to answer
// "how close am I, and is anything else competing for these drops?" at a glance, and an expanded
// panel that spells out every required item with who drops it and where. PoskyView owns the
// filtering, sorting and paging; everything below owns the drawing of a single quest.
//
// ITEM NAMES LINK TO THE LOOT DRILL-DOWN (owner, 2026-08-04): "clicking on a sky item while you
// are hovering should take you to the item drill-down page." The click is the app's standing link
// idiom (`openLoot`, appRouting.ts), the same one the Planner's donor names use.
//
// THE HOVER CARD LEFT AND CAME BACK, AND BOTH MOVES ARE THE SAME DEFECT (JOS-143 → JOS-181).
// Every item name and every required-item chip in this file used to anchor `ItemTooltip` — a
// `placement="top"`, up-to-380px, pointer-events-taking card. The chips live in the ACCORDION
// SUMMARY, i.e. the first row under QuestFilterBar, so those cards opened straight across the tab's
// five dropdowns and ate the clicks aimed at them; that is what the owner reported, and it is the
// Loot ledger's defect (JOS-127) on a second surface. JOS-143 removed them; JOS-173 then had to put
// the roster the chip lost back as a native `title`, because a hover that answers "Island 5" and
// nothing else is what a player reported next.
//
// The owner's v0.18.0 ruling is that the card is worth more than the removal — so it returns, with
// the click-eating fixed IN THE POPPER rather than by deleting it. Every card on this tab is mounted
// through `SkyItemCard`, which is `KnownItemTooltip` in click-through mode: it opens DOWNWARD and
// cannot flip up (so it cannot land on the toolbar its anchor sits below), it holds NO pointer
// events, and it closes on any pointerdown before the control the user aimed at opens its list.
// The native titles those anchors carried retire with it — the card's own Drops block is the same
// `itemDropFacts` derivation, and two hover surfaces on one anchor is an OS tooltip racing a popper.
//
// WHICH NAMES, AND WHY NOT ALL OF THEM. The two names that had NO click before become links: the
// item name in the expanded table, and the reward caption in the summary row. The required-item
// CHIPS in the summary row keep their existing click, which toggles the favorite star — that is a
// documented affordance with no other home, and quietly replacing it would trade one deep link for
// one lost feature. A summary-row link stops propagation, because the row it sits in is the
// accordion's own expand control.

import { type JSX, memo, useEffect, useRef } from 'react'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Chip,
  LinearProgress,
  Link,
  Stack,
  Typography
} from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked'
import StarIcon from '@mui/icons-material/Star'
import LinkIcon from '@mui/icons-material/Link'
import { skyQuestPage, wikiPageUrl } from '@shared/wiki'
// The turn-in badge and the manual counter (JOS-131), in their own file.
import { TurnInBadge, TurnInCounter } from './TurnInControls'
import type { QuestProgress } from './useProgress'
import { ItemNameLink, QuestItemsTable } from './QuestItemsTable'
import type { SetItemCount } from './ItemOverrides'
import { KillTargetCaption } from './DropperCell'
import { questKillTargets, type KillTarget } from './poskyDroppers'
import { SkyItemCard } from './SkyItemCard'
import type { MobTarget } from '../mobs/mobTarget'
import { sharingQuestLabel, type SharedItem, type SharingQuest } from './sharedItems'
import { QuestIgnoreButton, QuestStarButton } from '../favorites/QuestFlagButtons'

// Wiki URLs are built in ONE place (src/shared/wiki.ts) — the verified root-path convention.
function wikiClassPage(className: string): string | undefined {
  return wikiPageUrl(skyQuestPage(className))
}

// The bar states what you are HOLDING, always — since JOS-131 a turn-in spends those items, so a
// quest you just handed in is honestly back at 0/N and the badge beside it is what remembers the
// turn-in. Before this the bar read "Turned in" and sat pinned at 100% forever.
function ProgressBar({ q }: { q: QuestProgress }): JSX.Element {
  const pct = Math.round(q.ratio * 100)
  const color = pct === 0 ? 'inherit' : pct >= 100 ? 'success' : 'primary'
  return (
    <Box sx={{ minWidth: 160 }}>
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="caption" color="text.secondary">
          {q.haveCount}/{q.needCount} items
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {pct}%
        </Typography>
      </Stack>
      <LinearProgress variant="determinate" value={Math.min(100, pct)} color={color} />
    </Box>
  )
}

/**
 * One contending quest, as a chip that names ITS reward (2026-08-04).
 *
 * The section answers "who else wants this drop"; the reward answers "and what do they get for
 * it" — the other half of deciding where a single looted claw should go.
 *
 * A quest the wiki lists no reward for says nothing extra — a bare chip, not an empty card. The
 * `data-reward` attribute is that decision, readable: it states what the chip believes it pays,
 * so "no reward ⇒ nothing to say" can be asserted from outside instead of inferred.
 *
 * IT KEEPS ITS NATIVE TITLE while the item names took the card back (JOS-181), because it is not an
 * item-name anchor: the chip names a QUEST, and its title states the relationship — "Reward for
 * <class> · <quest>: <item>" — which an item card has no place to say. Two hover surfaces on one
 * anchor is an OS tooltip racing a popper, so it is one or the other, and here the sentence wins.
 */
function SharingQuestChip({
  sq,
  ambiguousNames,
  onSelectQuest
}: {
  sq: SharingQuest
  ambiguousNames: Set<string>
  onSelectQuest: (name: string) => void
}): JSX.Element {
  return (
    <Chip
      size="small"
      variant="outlined"
      color="info"
      data-testid="posky-shared-quest"
      data-reward={sq.reward ?? ''}
      title={sq.reward ? `Reward for ${sq.className} · ${sq.name}: ${sq.reward}` : undefined}
      label={sharingQuestLabel(sq, ambiguousNames)}
      onClick={() => onSelectQuest(sq.name)}
      sx={{ height: 20, fontSize: 11 }}
    />
  )
}

// "Shared items with" (Task #44): a compact, dense section listing each of this
// quest's required items that ANOTHER Plane of Sky quest also needs — so before
// turning in you can see who else is contending for a drop. Currency (Wind Runes) is
// excluded upstream in the derivation.
function SharedItemsSection({
  shared,
  ambiguousNames,
  onSelectQuest
}: {
  shared: SharedItem[]
  ambiguousNames: Set<string>
  onSelectQuest: (name: string) => void
}): JSX.Element {
  return (
    <Box sx={{ mb: 1 }}>
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }}>
        <LinkIcon sx={{ fontSize: 15, color: 'text.secondary' }} />
        <Typography variant="caption" color="text.secondary">
          Shared items - other Sky quests contending for these drops
        </Typography>
      </Stack>
      <Stack spacing={0.5}>
        {shared.map((si) => (
          <Stack key={si.key} direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="caption" sx={{ fontWeight: 600, minWidth: 150 }}>
              {si.name}
            </Typography>
            {si.quests.map((sq) => (
              <SharingQuestChip
                key={sq.key}
                sq={sq}
                ambiguousNames={ambiguousNames}
                onSelectQuest={onSelectQuest}
              />
            ))}
          </Stack>
        ))}
      </Stack>
    </Box>
  )
}

// The collapsed header line: flags, class, name/reward/giver/kill target, the contested-items
// count, the ready/missing chip and the progress bar.
function QuestSummaryRow({
  q,
  killTargets,
  sharedCount,
  favorited,
  onToggleFavorite,
  onToggleIgnore,
  onOpenLoot
}: {
  q: QuestProgress
  killTargets: KillTarget[]
  sharedCount: number
  favorited: boolean
  onToggleFavorite: () => void
  onToggleIgnore: () => void
  onOpenLoot?: (item: string) => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={2} alignItems="center">
      {/* Star + ignore lead every row, always visible — the quest-level
          controls the user could not find when the only star lived on an
          item row inside the expanded panel. */}
      <Stack direction="row" alignItems="center" sx={{ minWidth: 48 }}>
        <QuestStarButton favorited={favorited} onToggle={onToggleFavorite} />
        <QuestIgnoreButton ignored={false} onToggle={onToggleIgnore} />
      </Stack>
      <Chip label={q.className} size="small" color="secondary" variant="outlined" sx={{ minWidth: 92 }} />
      <Box sx={{ minWidth: 220 }}>
        <Typography variant="subtitle2">{q.name}</Typography>
        {q.reward && (
          <Typography variant="caption" color="primary.main">
            {/* The reward hover, back as a card (JOS-181). No `row`: a reward is not one of the
                quest's required items, so this tab knows no dropper for it — the card is the item
                window plus whatever the item DB says it is for, which is the whole question here.
                The scraped stat text is the fallback when the DB has no block of its own. */}
            → <ItemNameLink name={q.reward} onOpenLoot={onOpenLoot} inSummary stats={q.rewardStats} />
          </Typography>
        )}
        {q.giver && (
          <Typography variant="caption" color="text.secondary" display="block">
            Turn in → {q.giver}
          </Typography>
        )}
        {/* Variable-height box already (reward and giver are each optional), so a third
            caption line costs the row nothing it wasn't already prepared to pay. */}
        <KillTargetCaption targets={killTargets} />
      </Box>
      <Box sx={{ flexGrow: 1 }} />
      {sharedCount > 0 && (
        <Chip
          size="small"
          variant="outlined"
          color="info"
          icon={<LinkIcon />}
          label={sharedCount}
          title={`Shares ${sharedCount} item${sharedCount === 1 ? '' : 's'} with other Sky quests - expand for details`}
          sx={{ height: 20, fontSize: 11, '& .MuiChip-icon': { fontSize: 14 } }}
        />
      )}
      {/* BOTH, since JOS-131. The turn-in badge is history ("you have done this, twice"); the
          chip beside it is the present ("and right now you are three items short of doing it
          again"). Collapsing them into one chip is what used to make a re-run invisible. */}
      <TurnInBadge count={q.turnIns} evidence={q.completionEvidence} />
      <Chip
        size="small"
        variant="outlined"
        color={q.missing.length === 0 ? 'success' : 'default'}
        label={q.missing.length === 0 ? 'Ready to turn in' : `${q.missing.length} of ${q.items.length} missing`}
      />
      <ProgressBar q={q} />
    </Stack>
  )
}

// The second summary line: every required item as a chip, favorites first, each one a
// click-to-favorite toggle that must NOT also expand the accordion (hence stopPropagation).
function QuestItemChips({
  q,
  isFavorite,
  toggleFavorite
}: {
  q: QuestProgress
  isFavorite: (name: string) => boolean
  toggleFavorite: (name: string) => void
}): JSX.Element {
  return (
    // Indent tracks the header's leading columns (buttons + class chip).
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ pl: '164px' }}>
      {[...q.items]
        .sort((a, b) => Number(isFavorite(b.name)) - Number(isFavorite(a.name)))
        .map((it) => {
          // Held, right now. It used to also be true for any turned-in quest, which since
          // JOS-131 would be a lie: the turn-in is exactly what spent the item.
          const done = it.have >= it.need
          const fav = isFavorite(it.name)
          return (
            // THE anchor of the whole affair: this Stack is the second line of the collapsed
            // summary, so for the top quest in the list a `placement="top"` card opened over
            // QuestFilterBar itself and ate its clicks (JOS-143). `SkyItemCard` is the card that
            // cannot — downward-only, no pointer events, gone on pointerdown — and it carries the
            // roster the JOS-173 title was a flattened copy of, so the native title retires here.
            <SkyItemCard key={it.name} name={it.name} row={it} stats={it.stats}>
              <Chip
                size="small"
                // The anchor tests/e2e/sky-dropdowns.e2e.mts hovers: this is the chip whose card
                // used to open onto the toolbar, so the spec that proves it no longer can needs to
                // be able to name it.
                data-testid="posky-item-chip"
                variant={fav ? 'filled' : 'outlined'}
                color={fav ? 'warning' : done ? 'success' : 'default'}
                icon={
                  fav ? (
                    <StarIcon />
                  ) : done ? (
                    <CheckCircleIcon />
                  ) : (
                    <RadioButtonUncheckedIcon />
                  )
                }
                onClick={(e) => {
                  e.stopPropagation()
                  toggleFavorite(it.name)
                }}
                label={it.need > 1 ? `${it.name} ${it.have}/${it.need}` : it.name}
                sx={{ opacity: done && !fav ? 0.65 : 1 }}
              />
            </SkyItemCard>
          )
        })}
    </Stack>
  )
}

// The expanded panel's top strip: rune / giver / wiki link, and the manual turn-in counter.
function QuestDetailsToolbar({
  q,
  wikiHref,
  onRecordTurnIn,
  onUndoTurnIn
}: {
  q: QuestProgress
  wikiHref?: string
  onRecordTurnIn: () => void
  onUndoTurnIn: () => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={2} sx={{ mb: 1 }} alignItems="center" flexWrap="wrap" useFlexGap>
      {q.rune && <Chip size="small" label={`Rune: ${q.rune}`} />}
      {q.giver && <Chip size="small" label={`Giver: ${q.giver}`} />}
      {wikiHref && (
        <Link href={wikiHref} target="_blank" rel="noreferrer" variant="caption">
          wiki: {q.className} Plane of Sky Tests
        </Link>
      )}
      <Box sx={{ flexGrow: 1 }} />
      <TurnInCounter q={q} onRecordTurnIn={onRecordTurnIn} onUndoTurnIn={onUndoTurnIn} />
    </Stack>
  )
}

/**
 * The accordion's transition, told to throw the panel away when it is closed. Module-level because
 * it is a constant and a fresh object per row per render is exactly the kind of churn this ticket
 * is about. See the comment at the mount site for what it buys and what it costs.
 */
const UNMOUNT_COLLAPSED = { transition: { unmountOnExit: true } } as const

/**
 * THE ROW'S PROPS ARE ITS PERFORMANCE CONTRACT (JOS-206), which is why every per-quest handler
 * below takes the quest KEY instead of being a closure over one.
 *
 * A keystroke in the search box was measured at 82 ms at the default page cap and 179 ms with
 * "show all" — essentially all of it React reconciliation and MUI/emotion style recomputation over
 * rows whose content had not changed (1.86 ms per accordion, per keystroke). The filter itself
 * costs 0.016 ms, so there was never anything to move off the renderer; the fix is to stop
 * re-rendering rows that did not change, which means `memo` (bottom of this file) plus props whose
 * IDENTITY is stable across a keystroke. A `() => toggle(q.key)` written per row in the list is a
 * new function on every render and would defeat the memo silently — the list would still be
 * correct, just as slow as before, which is the failure mode worth naming.
 *
 * So the list hands down ONE stable function per action and this component binds it to its own
 * quest. The binding closures created below are per-RENDER of this row, which is exactly the thing
 * the memo makes rare.
 */
function QuestAccordionRow({
  q,
  shared,
  ambiguousNames,
  favorited,
  onToggleFavorite,
  onToggleIgnore,
  isFavorite,
  toggleFavorite,
  onRecordTurnIn,
  onUndoTurnIn,
  onSelectQuest,
  onOpenMob,
  onOpenLoot,
  onSetItemCount,
  anchored = false
}: {
  q: QuestProgress
  shared: SharedItem[]
  ambiguousNames: Set<string>
  favorited: boolean
  /** star/unstar THIS quest — takes the key so the caller's function can be one stable reference */
  onToggleFavorite: (questKey: string) => void
  /** hide THIS quest, same shape and the same reason */
  onToggleIgnore: (questKey: string) => void
  isFavorite: (name: string) => boolean
  toggleFavorite: (name: string) => void
  /** record one more turn-in of this quest (JOS-131) */
  onRecordTurnIn: (questKey: string) => void
  /** take back the most recent hand-recorded turn-in */
  onUndoTurnIn: (questKey: string) => void
  onSelectQuest: (name: string) => void
  /** a dropper name → the Mobs tab's page for that catalog row (App-level routing) */
  onOpenMob: (t: MobTarget) => void
  /** an item name → the Loot tab's drill-down for it (App-level routing, `openLoot`) */
  onOpenLoot?: (item: string) => void
  /**
   * State or clear one item's held count by hand (JOS-186). ONE stable reference from the list,
   * taking the item name — the memo contract this block argues, same as the two turn-in actions.
   */
  onSetItemCount?: SetItemCount
  /**
   * A deep link landed on THIS quest (a celebration toast's reward card,
   * docs/plans/celebration-toasts.md T6): mount expanded and scroll into view.
   *
   * Mount-time, not a controlled `expanded` prop, because PoskyView remounts exactly this one
   * accordion per link (its key carries the nonce) — which keeps every other accordion in the
   * list uncontrolled and independently open, the way it has always been.
   */
  anchored?: boolean
}): JSX.Element {
  const wikiHref = wikiClassPage(q.className)
  // Nothing MISSING is what silences the kill-target caption (JOS-131). It used to be "turned
  // in", which is now the opposite of the truth: handing the quest in spends its items, so a
  // re-run needs every one of those mobs again.
  const killTargets = q.missing.length === 0 ? [] : questKillTargets(q.items)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // `block: 'nearest'` scrolls the enclosing list only as far as it must, so a quest already on
    // screen does not jump under the user.
    if (anchored) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [anchored])
  return (
    // The testid is how a spec COUNTS rows (JOS-191's paging spec): "the page cap did not snap
    // back" is a statement about how many of these are mounted, and `.MuiAccordion-root` would be
    // a bet on MUI's class names rather than on this app's own list.
    <Accordion
      disableGutters
      ref={ref}
      defaultExpanded={anchored}
      // A COLLAPSED PANEL IS NOT DRAWN AT ALL (JOS-206). MUI keeps a Collapse's children mounted
      // by default — height 0, `visibility: hidden`, and every node of them still in the DOM and
      // still reconciled on every render of this row. That is the item table, the shared-items
      // section and the turn-in toolbar for each of the 40 quests on a default page (~2,700 DOM
      // nodes, and about 60% of what a row costs to re-render) for a panel nobody has opened.
      // The anchored path is unaffected: it mounts EXPANDED (`defaultExpanded`), so the deep
      // link's scrollIntoView still has its content, and the accordion stays uncontrolled either
      // way. The price is honest and small — opening a panel now builds it rather than revealing
      // it, which is one row's worth of work on the click that asked for it.
      slotProps={UNMOUNT_COLLAPSED}
      data-testid="posky-quest-row"
      data-anchored={anchored || undefined}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack spacing={0.75} sx={{ width: '100%', pr: 2 }}>
          <QuestSummaryRow
            q={q}
            killTargets={killTargets}
            sharedCount={shared.length}
            favorited={favorited}
            onToggleFavorite={() => onToggleFavorite(q.key)}
            onToggleIgnore={() => onToggleIgnore(q.key)}
            onOpenLoot={onOpenLoot}
          />
          <QuestItemChips q={q} isFavorite={isFavorite} toggleFavorite={toggleFavorite} />
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <QuestDetailsToolbar
          q={q}
          wikiHref={wikiHref}
          onRecordTurnIn={() => onRecordTurnIn(q.key)}
          onUndoTurnIn={() => onUndoTurnIn(q.key)}
        />
        {q.rewardStats && (
          <Typography variant="caption" color="text.secondary" component="pre" sx={{ whiteSpace: 'pre-wrap', mb: 1 }}>
            {q.rewardStats}
          </Typography>
        )}
        {shared.length > 0 && (
          <SharedItemsSection shared={shared} ambiguousNames={ambiguousNames} onSelectQuest={onSelectQuest} />
        )}
        <QuestItemsTable
          q={q}
          isFavorite={isFavorite}
          toggleFavorite={toggleFavorite}
          onOpenMob={onOpenMob}
          onOpenLoot={onOpenLoot}
          onSetItemCount={onSetItemCount}
        />
      </AccordionDetails>
    </Accordion>
  )
}

/**
 * THE EXPORTED ROW IS MEMOIZED (JOS-206) — a keystroke that does not change a quest must not
 * re-render it.
 *
 * A shallow prop comparison is the whole rule, and it is only worth anything because the caller
 * holds up its end: `PoskyView.QuestList` passes one stable function per action (never a per-row
 * closure), a shared EMPTY array rather than a fresh `?? []`, and primitives for the two per-row
 * bits (`favorited`, `anchored`). `isFavorite` comes from `useFavorites`, which pins it to the
 * favorites Set; `toggleFavorite` and the two flag `toggle`s are module-lifetime functions.
 *
 * THE RISK THIS TAKES ON, stated plainly: a row frozen when it should have updated. Every update
 * path is therefore carried by a prop that genuinely changes — a favorite or ignore flips
 * `favorited` / the `isFavorite` identity, a turn-in or a drop rebuilds `quests` in `useProgress`
 * so `q` is a new object, and the anchor rides its own key. tests/e2e/sky-turnin.e2e.mts drives
 * loot → turn-in → refarm against real rows and tests/e2e/sky-filters.e2e.mts drives the star.
 */
export const QuestAccordion = memo(QuestAccordionRow)
