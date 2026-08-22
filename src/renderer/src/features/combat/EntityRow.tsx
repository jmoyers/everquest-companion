// ONE ROW of the source meter — the ranked bar that IS the combat tab's level 1. Its
// value-equality memo is the reason a 1s snapshot tick doesn't re-render a frozen fight's whole
// list, so it lives in its own module with that gate.

import { memo, useState } from 'react'
import { Box, Chip, Collapse, Typography } from '@mui/material'
import { Bar, KIND_COLOR, RESIST_COLOR, SkillBar } from './combatShared'
import { flattenSkills } from './dashboardData'
import { formatNum as fmt, formatRate } from '../../lib/formatRate'
import type { SourceView } from '@shared/combat'
import { Tooltip } from '../../lib/Tooltip'

/**
 * WHOSE ROW THIS IS, in one word beside the name. `you` and `enemy` get nothing: the direction
 * filter already said which of the two you are looking at, and a row tagged 'you' in your own
 * damage list is noise. The two that DO need a word are the ones a bare name cannot tell apart
 * from you — your pet, and a group-mate (docs/plans/group-model.md).
 *
 * State, never process (AGENTS.md): the word names what the row IS, and it carries no tooltip,
 * because a chip reading 'group' beside a player's name has nothing left to explain. "Why is
 * this name here?" is answered where it can be answered properly — the roster popover, with
 * provenance (ScopeStatus.tsx).
 *
 * HERE rather than in combatShared.tsx because this is that file's only consumer and it sits at
 * the measured line ceiling: the rule is to split rather than ratchet.
 */
// `ally` (JOS-250): somebody else's charm pet, credited to whoever charmed it. The row's NAME
// already carries the charmer, so the chip only has to say which kind of thing the row is.
//
// `other` (JOS-430) says the honest thing and no more: the log named this combatant, and no model
// of ours claims it. It is NOT tagged 'player' — EQ spells a summoned pet's name with the same
// grammar it gives people, so a row of this kind can be either and the word must not pick one
// (src/main/combat/otherCombatants.ts). The moment the roster learns the name the SAME row becomes
// 'group', which is the whole reason the two share an id.
const KIND_TAG: Partial<Record<string, string>> = {
  pet: 'pet', member: 'group', allyPet: 'ally', other: 'other'
}

function KindChip({ kind }: { kind: string }): React.JSX.Element | null {
  const tag = KIND_TAG[kind]
  if (tag === undefined) return null
  return (
    <Chip label={tag} size="small" sx={{ ml: 0.5, height: 14, fontSize: 9, bgcolor: `${KIND_COLOR[kind] ?? '#888'}33` }} />
  )
}

function missSummary(m: SourceView['missBreakdown']): string {
  const parts: string[] = []
  if (m.miss) parts.push(`${m.miss} miss`)
  if (m.dodge) parts.push(`${m.dodge} dodge`)
  if (m.parry) parts.push(`${m.parry} parry`)
  if (m.riposte) parts.push(`${m.riposte} riposte`)
  if (m.block) parts.push(`${m.block} block`)
  if (m.absorb) parts.push(`${m.absorb} absorb`)
  return parts.join(' · ') || 'none'
}

/**
 * WHO AVOIDED THOSE SWINGS — the sentence that made the miss breakdown ambiguous until JOS-354.
 *
 * The engine books an avoided swing on the source that SWUNG it, so the same six numbers mean
 * opposite things on the two directions: on an outgoing row they are the MOB's avoidance of your
 * swings, and on an incoming (enemy) row they are YOURS — the block/parry/dodge/riposte the user
 * asked about. One tooltip that says "avoided" for both was a coin flip; each direction now names
 * the defender, and the incoming row points at the panel that states the rates.
 */
function missLead(kind: SourceView['kind']): string {
  return kind === 'enemy' ? 'you avoided' : 'the defender avoided'
}

/**
 * The two hover badges a row carries when its numbers earn them: the hit rate (only where swings
 * were avoided — a 100% row would be furniture) and the spell-resist rate. Their own function so
 * `EntityRow` stays inside the complexity budget, and so the glance card can drop both with one
 * test rather than three.
 */
function StatBadges({ e }: { e: SourceView }): React.JSX.Element {
  const swings = e.hits + e.misses
  return (
    <>
      {e.misses > 0 && (
        <Tooltip title={`${e.hits} landed / ${swings} swings - ${missLead(e.kind)}: ${missSummary(e.missBreakdown)}`}>
          <Typography component="span" variant="caption" sx={{ ml: 0.5, color: 'text.secondary' }}>
            {Math.round(e.hitPct)}% hit
          </Typography>
        </Tooltip>
      )}
      {/* Spell-resist rate (Task #51 v2) — resists / (spell+dot casts + resists). */}
      {e.resists > 0 && (
        <Tooltip title={`${e.resists} of your detrimental spells were resisted - ${Math.round(e.resistPct)}% resist rate (resists ÷ spell casts).`}>
          <Typography component="span" variant="caption" sx={{ ml: 0.5, color: RESIST_COLOR }}>
            {Math.round(e.resistPct)}% resist
          </Typography>
        </Tooltip>
      )}
    </>
  )
}

export const EntityRow = memo(function EntityRow({
  e,
  rank,
  compact,
  onDrill
}: {
  e: SourceView
  rank: number
  /**
   * The GLANCE variant (the Overview card, JOS-105): the same row, the same click, the same
   * drill — carrying only the rate on its right end and none of the hover badges, because the
   * card is a quarter of the Combat tab's width and a badge nobody can read is not density.
   * A prop, never a second component: the behaviour has to be identical everywhere.
   */
  compact?: boolean
  onDrill?: () => void
}): React.JSX.Element {
  // Fallback inline expand (the same flat, category-colored skill list) for the incoming
  // view, which has no drill-down; the outgoing view uses onDrill instead.
  const [open, setOpen] = useState(false)
  const crit = e.critPct >= 1 ? ` · ${Math.round(e.critPct)}% crit` : ''
  const onClick = onDrill ?? (e.skills.length ? () => setOpen((o) => !o) : undefined)
  return (
    <Box data-testid="meter-row">
      <Bar
        color={KIND_COLOR[e.kind] ?? '#888'}
        pct={e.pct}
        rank={rank}
        onClick={onClick}
        name={
          <>
            {e.name}
            <KindChip kind={e.kind} />
            {/* Not gated on `kind` any more: with the pet preference on, a pet's damage is
                folded into YOUR level-1 bar (petRows.meterSources) and its name-ambiguity comes
                with it. The badge belongs to the number, wherever the number is shown. */}
            {e.ambiguousHits > 0 && (
              <Tooltip
                title={`${e.ambiguousHits} hit${e.ambiguousHits === 1 ? '' : 's'} (${fmt(
                  e.ambiguousTotal
                )} dmg) are name-ambiguous: a same-named hostile twin exists, so this damage could belong to the twin rather than your pet.`}
              >
                <Chip
                  label="~"
                  size="small"
                  sx={{ ml: 0.5, height: 14, fontSize: 10, fontWeight: 700, bgcolor: 'rgba(207,102,121,0.25)' }}
                />
              </Tooltip>
            )}
            {!compact && <StatBadges e={e} />}
          </>
        }
        right={compact ? formatRate(e.dps) : `${fmt(e.total)} · ${formatRate(e.dps)}${crit}`}
      />
      {!onDrill && (
        <Collapse in={open}>
          <Box sx={{ pl: 3, pr: 0.5, py: 0.5 }}>
            {flattenSkills(e).map((s) => (
              <SkillBar key={`${s.category}|${s.name}`} s={s} />
            ))}
          </Box>
        </Collapse>
      )}
    </Box>
  )
},
// Value-equality gate: a fresh snapshot rebuilds every SourceView object each
// tick (new references) even when the underlying data is unchanged — which is
// ALWAYS the case for a selected finalized fight (its aggregate is frozen). A
// reference-only memo would never skip; comparing the rendered fields by value
// lets those rows skip re-render, so only the genuinely-changing live/current
// rows re-render per tick. The SourceView is small, so this compare is cheap.
sourceViewEqual)

function sourceViewEqual(
  prev: { e: SourceView; rank: number; compact?: boolean; onDrill?: () => void },
  next: { e: SourceView; rank: number; compact?: boolean; onDrill?: () => void }
): boolean {
  return (
    prev.rank === next.rank &&
    !!prev.compact === !!next.compact &&
    !!prev.onDrill === !!next.onDrill &&
    JSON.stringify(prev.e) === JSON.stringify(next.e)
  )
}
