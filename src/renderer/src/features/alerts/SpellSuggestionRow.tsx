// SpellSuggestionRow — one spell LINE in the suggested-alerts wizard, and the chips it wears.
//
// Split out of SuggestAlertsDialog.tsx when the levelling intelligence (level chip, most-
// recently-cast rank, rank-pinned template chips) pushed that file past the 400-code-line
// factoring ceiling.
//
// COMPACT (docs/plans/suggest-dialog-redesign.md §3, owner: "more compact so things fit on
// screen"). The row is ONE LINE whenever one line will hold it: the NAME is the single
// shrinkable/ellipsizing thing, and the chips never shrink. `flexWrap` turns overflow into HEIGHT
// (AGENTS.md), which is what made the old pre-redesign row two and three lines tall on a spell
// with several classes, so height is spent only where it is the alternative to a collision —
// see SUGGEST_ROW_SX for what JOS-190 measured and why the row now wraps as its last resort.
//
// WHAT THE ROW STATES (never process — AGENTS.md UI conventions):
//   * the spell's line name,
//   * its class levels as one chip per class ("ENC 16"), RESOLVED classes first, with the
//     overflow folded into a "+N" chip whose tooltip names the rest. The spell DB has no
//     per-RANK levels at all, so a rank-III row still shows the LINE's level and says so,
//   * the rank you MOST RECENTLY CAST, when the log has shown one,
//   * how often the buffs model has observed the line.
// Buff/debuff is NOT a chip any more: the section header the row sits under states it, except
// in "From your fights", which mixes both — that section passes `showType`.

import { memo, useMemo, type JSX } from 'react'
import { Box, Chip, Typography } from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import type { SpellCatalogEntry } from '@shared/types'
import type { ClassAbbr } from '@shared/classCombo'
import { preferredRank, type SpellLine } from '@shared/spellLines'
import {
  RANK_TEMPLATES,
  SUGGEST_TEMPLATES,
  suggestionsFor,
  type Suggestion,
  type TemplateKind
} from './suggestions'
import { classLevelChips, type ClassLevelChip } from './lineIntel'
import { Tooltip } from '../../lib/Tooltip'

/** Everything a row needs beyond the catalog entry itself (line + loadout context). */
export interface RowContext {
  lines: Map<string, SpellLine>
  resolved: ClassAbbr[]
}

/** How many class-level chips a row shows before folding the rest into "+N". */
const MAX_LEVEL_CHIPS = 2

/**
 * Shared geometry for the row's small chips — the whole point of the redesign is density.
 * EXPORTED because the poison-slow offer is a row in the same list (SuggestSections.tsx): its
 * chips have to be the same 18px objects, not a second opinion about density.
 */
export const ROW_CHIP_SX = {
  height: 18,
  // A CHIP IS A FACT, NOT A SPRING (JOS-190). Left to the default `flex-shrink: 1` these squeezed
  // below their own labels the moment the facts group ran out of room, and — the group being an
  // un-clipped nowrap flex box — kept drawing past its edge and over the template chips beside it.
  // They hold their size now; what gives is the NAME, which ellipsizes, and then the row wraps.
  flexShrink: 0,
  '& .MuiChip-label': { px: 0.6, fontSize: '0.68rem' }
} as const
const CHIP_SX = ROW_CHIP_SX

/**
 * The row shell every suggestion line wears: facts on the left, one-click chips on the right,
 * hover-highlighted. Exported for the same reason as ROW_CHIP_SX — "the offer is just another
 * row" is a claim that only holds if it is literally the same box.
 *
 * IT WRAPS (JOS-190, GitHub issue 22). It used to be `nowrap` on the compact-bar contract
 * (AGENTS.md: "`flexWrap` converts content overflow into HEIGHT"), and that contract is still
 * right about height — but it comes with a second half the row was not honouring: the shrinkable
 * group must actually CLIP. A row wears up to seven chips whose labels are whole sentences
 * ("When it wears off (you or your pet)", "When it lands on someone (say who)", plus a rank-pinned
 * pair when the log has seen you cast one), and past ~836px of dialog those simply do not fit on
 * one line at any font. The old row answered that by squeezing the facts group and letting it
 * overprint the chips; wrapping answers it by giving the chips their own line when — and ONLY
 * when — they cannot share one. A row that fitted before still fits on one line and is
 * byte-identical: flex wrapping is decided on the items' natural widths, so nothing that used to
 * fit moves.
 */
export const SUGGEST_ROW_SX = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 0.5,
  rowGap: 0.25,
  px: 0.75,
  py: 0.125,
  minHeight: 26,
  borderRadius: 1,
  '&:hover': { bgcolor: 'action.hover' }
} as const

/**
 * The FACTS half of a row (name · type · class levels · recency · usage).
 *
 * It is the group that gives — `flexGrow: 1` so it owns the free space, `minWidth: 0` so the name
 * may ellipsize — and it CLIPS (`overflow: hidden`), which is the half the compact-bar contract
 * was missing: a shrinkable group whose overflow is visible does not shrink, it overprints its
 * neighbour. Its chips hold their width (ROW_CHIP_SX), so the name is what shortens.
 */
export const SUGGEST_ROW_FACTS_SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 0.5,
  minWidth: 0,
  flexGrow: 1,
  overflow: 'hidden'
} as const

/**
 * The ACTIONS half of a row: the one-click template chips, right-aligned.
 *
 * `flexWrap` here is the second line's second line — once the chips have a row to themselves they
 * still have to fit in it, and at the app's 900px minimum a spell with five templates does not.
 * `minWidth: 0` lets the group take the width it is given rather than its content's, which is what
 * makes that inner wrap happen at all (and a single chip wider than the dialog ellipsizes inside
 * itself — MUI's own `max-width: 100%`). A plain Box rather than a Stack: Stack spaces its
 * children with MARGINS, which do not survive wrapping.
 */
export const SUGGEST_ROW_ACTIONS_SX = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
  gap: 0.5,
  minWidth: 0
} as const

/** Coarse relative-time label for the usage tooltip's "last seen" (Task #45 recency hint). */
export function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) return 'just now'
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.round(hr / 24)
  return `${d}d ago`
}

/** "ENC 16" — one class's entry level for this LINE. Yours is coloured; the DB fact is the same. */
function LevelChip({ chip }: { chip: ClassLevelChip }): JSX.Element {
  const title = `${chip.cls} learns this spell line at level ${chip.level}${chip.yours ? ' - one of your classes' : ''}`
  return (
    <Tooltip title={title}>
      <Chip
        size="small"
        variant="outlined"
        color={chip.yours ? 'primary' : 'default'}
        label={`${chip.cls} ${chip.level}`}
        sx={CHIP_SX}
      />
    </Tooltip>
  )
}

/** The class-level chips, resolved-first, with the overflow named in a "+N" tooltip. */
function LevelChips({ entry, resolved }: { entry: SpellCatalogEntry; resolved: ClassAbbr[] }): JSX.Element | null {
  const chips = useMemo(() => classLevelChips(entry, resolved), [entry, resolved])
  if (chips.length === 0) return null
  const shown = chips.slice(0, MAX_LEVEL_CHIPS)
  const hidden = chips.slice(MAX_LEVEL_CHIPS)
  return (
    <>
      {shown.map((c) => (
        <LevelChip key={c.cls} chip={c} />
      ))}
      {hidden.length > 0 && (
        <Tooltip title={hidden.map((c) => `${c.cls} ${c.level}`).join(' · ')}>
          <Chip size="small" variant="outlined" label={`+${hidden.length}`} sx={CHIP_SX} />
        </Tooltip>
      )}
    </>
  )
}

/** The "N×" badge, with its observed-count + last-seen tooltip. */
function UsageChip({ entry }: { entry: SpellCatalogEntry }): JSX.Element {
  const title = entry.lastSeenMs
    ? `Observed ${entry.usageCount}× · last seen ${relativeTime(entry.lastSeenMs)}`
    : `Observed ${entry.usageCount}× in your log`
  return (
    <Tooltip title={title}>
      <Chip size="small" color="primary" label={`${entry.usageCount}×`} sx={CHIP_SX} />
    </Tooltip>
  )
}

/** The chip caption for one suggestion — rank-pinned templates name the rank they target. */
function chipLabel(s: Suggestion): string {
  if (s.template === 'illusion') return 'When your illusion fades'
  if (s.rank !== undefined && (s.template === 'castRank' || s.template === 'resistRank')) {
    return RANK_TEMPLATES[s.template].chip(s.rank)
  }
  // Keyed off the RECORD rather than a hand-written union of its keys: the union went stale the
  // moment JOS-103 added `landsOnOther`, and a stale one here does not fail to compile — it
  // falls through and renders the template's internal id as the user-facing chip label.
  return s.template in SUGGEST_TEMPLATES
    ? SUGGEST_TEMPLATES[s.template as TemplateKind].chip
    : s.template
}

/** A one-click template chip; renders checked + disabled once the alert exists. */
export function TemplateChip({
  label,
  created,
  onClick
}: {
  label: string
  created: boolean
  onClick: () => void
}): JSX.Element {
  const sx = { height: 20, '& .MuiChip-label': { px: 0.75, fontSize: '0.7rem' } }
  if (created) {
    return (
      <Chip
        size="small"
        icon={<CheckCircleIcon />}
        color="success"
        variant="filled"
        label={label}
        disabled
        sx={sx}
      />
    )
  }
  return <Chip size="small" variant="outlined" clickable onClick={onClick} label={label} sx={sx} />
}

/** A single dense spell row: name, class levels, recency/usage, one-click template chips. */
function SpellRow({
  entry,
  existingIds,
  onCreate,
  ctx,
  showType = false
}: {
  entry: SpellCatalogEntry
  existingIds: Set<string>
  onCreate: (s: Suggestion) => void
  ctx: RowContext
  /** state buff/debuff on the row — for "From your fights", which mixes both. */
  showType?: boolean
}): JSX.Element {
  const isDebuff = entry.spellType === 'Detrimental'
  // The rank the one-click chips target: the MOST RECENTLY CAST rank of this line (the owner's
  // rule), falling back to the highest rank known when the line has never been observed.
  const rank = useMemo(() => preferredRank(ctx.lines.get(entry.key)?.ranks ?? []), [ctx.lines, entry.key])
  // Building the AlertDefs is the row's heaviest work, and it depends only on the entry and the
  // rank — so a re-render that changes neither (a parent re-render, a hover) does none of it.
  const suggestions = useMemo(() => suggestionsFor(entry, rank), [entry, rank])
  return (
    <Box sx={SUGGEST_ROW_SX} data-testid="suggest-row">
      <Box sx={SUGGEST_ROW_FACTS_SX}>
        <Typography variant="body2" sx={{ fontWeight: 500, minWidth: 0 }} noWrap>
          {entry.name}
        </Typography>
        {showType && (
          <Chip
            size="small"
            label={isDebuff ? 'debuff' : 'buff'}
            color={isDebuff ? 'error' : 'success'}
            variant="outlined"
            sx={CHIP_SX}
          />
        )}
        <LevelChips entry={entry} resolved={ctx.resolved} />
        {rank?.lastCastMs != null && (
          <Tooltip title={`You last cast ${rank.name} ${relativeTime(rank.lastCastMs)}`}>
            <Chip
              size="small"
              variant="outlined"
              color="primary"
              label={rank.suffixed ? rank.name : 'recent'}
              sx={CHIP_SX}
            />
          </Tooltip>
        )}
        {entry.usageCount > 0 && <UsageChip entry={entry} />}
      </Box>
      <Box sx={SUGGEST_ROW_ACTIONS_SX}>
        {suggestions.map((s) => (
          <TemplateChip
            key={s.def.id}
            label={chipLabel(s)}
            created={existingIds.has(s.def.id)}
            onClick={() => onCreate(s)}
          />
        ))}
      </Box>
    </Box>
  )
}

/**
 * MEMOIZED (shallow compare on the props). The wizard mounts up to MAX_ROWS of these, so a
 * keystroke that leaves a row's entry in the result set must not re-render it. That only holds
 * while the caller keeps `existingIds`, `onCreate` and `ctx` referentially stable — the dialog
 * memoizes all three; a fresh object literal for any of them silently restores the old cost.
 */
export default memo(SpellRow)
