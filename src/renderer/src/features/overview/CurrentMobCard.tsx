// CurrentMobCard — the mob in front of you, and what it drops.
//
// IDENTITY comes from `CombatSnapshot.currentTarget` (world-model law 6's LIVE naming half),
// exposed as a FACT rather than parsed back out of the composed encounter name. Between pulls the
// card says "Last target — X" instead of pretending you are still fighting: the same honesty rule
// the fight head row follows, and the reason `live` is read from `segments`, not from a guess
// about how recent `lastTs` is.
//
// WHAT IT DELIBERATELY DOES NOT SAY (owner decision, 2026-08-03): no con colour, no difficulty
// classification. A con verdict is a statement about the gap between your level and the mob's ON
// THE DAY YOU CONNED IT, and it is wrong the moment you ding. The DURABLE facts are the mob's
// NAME and its LEVEL — so that is all consider-seeded data ever contributes here, exactly as
// RecentlyConsidered was changed to do.
//
// EMPTY STATES ARE NOT DECORATION (law 1). "Still looking up", "no wiki page", "offline" and "the
// page lists no loot" are FOUR different facts and are never collapsed into "no drops". This card
// renders a leaner row set than MobPage — no rarity column, no per-item drill-down, no
// also-looted-by-you section — but it keeps those distinctions intact, because they are the
// difference between a claim and an absence of one.
//
// AND THE SAME ERA RULE THE MOB PAGE FOLLOWS (JOS-377), by the same call: out-of-era rows behind a
// "+N out of era" disclosure, in-era and unknown plainly, chips from the app's one era verdict.
// The card being small is not a reason to answer differently — it is the surface a player reads
// mid-pull, so it is the worst place to name loot the server does not run.

import { type JSX, useState } from 'react'
import { Box, Chip, CircularProgress, Stack, Typography } from '@mui/material'
import type { MobDrop, MobKnowledge } from '@shared/types'
import { DashCard, QuietNote } from '../combat/combatShared'
import { KnownItemTooltip } from '../../lib/KnownItemTooltip'
import { itemCountKey } from '../../lib/itemName'
import { dropEraSubject, outOfEraLabel, splitDropsByEra } from '../mobs/dropEra'
import type { MobTarget } from '../mobs/mobTarget'
import { foldSeenVariants } from '../mobs/seenVariants'
// The app's ONE era chip, from the app's ONE era verdict — the mob page's rows draw the same one.
import { EraChip } from '../planner/PlannerChips'
import type { CurrentMobState } from './useCurrentMob'

/** Drop rows before the "+N more" hands off to the mob page. */
const DROPS_SHOWN = 8

/** The drop list is a growing list, so it lives in a FIXED-height scroll box (AGENTS.md). */
const DROPS_BOX_HEIGHT = 150

export interface CurrentMobCardProps {
  state: CurrentMobState
  onOpenMob: (t: MobTarget) => void
}

/** Level + home zone AS THE SOURCE STATES THEM — a range as often as a number, hence text. */
function LevelZone({ k }: { k?: MobKnowledge }): JSX.Element | null {
  // Falsiness, not nullishness: an empty string from the page says nothing.
  if (!k?.levelText && !k?.zone) return null
  return (
    <Typography variant="caption" color="text.secondary" noWrap>
      {k.levelText && `level ${k.levelText}`}
      {k.levelText && k.zone && ' · '}
      {k.zone}
    </Typography>
  )
}

/** The four distinct honest answers to "why is the drop list empty". */
function DropsEmpty({ state }: { state: CurrentMobState }): JSX.Element {
  const { knowledge, loading } = state
  if (loading && !knowledge) {
    return (
      <Stack direction="row" spacing={1} alignItems="center" sx={{ color: 'text.secondary' }}>
        <CircularProgress size={13} thickness={5} />
        <Typography variant="caption">Looking up this mob…</Typography>
      </Stack>
    )
  }
  if (knowledge?.notFound) return <QuietNote>No wiki page for this mob.</QuietNote>
  if (knowledge?.offline) return <QuietNote>Offline - showing only what’s known locally.</QuietNote>
  if (knowledge?.page) return <QuietNote>The wiki page for this mob lists no loot.</QuietNote>
  return <QuietNote>Nothing known about this one yet.</QuietNote>
}

/** One drop line: the name, its era chip when there is one to draw, and your own count. */
function DropLine({ drop, seen }: { drop: MobDrop; seen?: { count: number } }): JSX.Element {
  return (
    <KnownItemTooltip name={drop.item}>
      <Stack direction="row" spacing={1} alignItems="baseline" sx={{ py: 0.15, minWidth: 0 }}>
        <Typography variant="caption" noWrap sx={{ minWidth: 0 }}>
          {drop.item}
        </Typography>
        <EraChip subject={dropEraSubject(drop)} />
        <Box sx={{ flexGrow: 1 }} />
        {seen && (
          <Typography variant="caption" sx={{ color: 'success.main', flexShrink: 0 }}>
            {seen.count}× yours
          </Typography>
        )}
      </Stack>
    </KnownItemTooltip>
  )
}

/** A caption that behaves like a button — the card's two disclosures, one shape. */
function TapLine({
  onTap,
  testId,
  children
}: {
  onTap: () => void
  testId?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <Typography
      variant="caption"
      role="button"
      tabIndex={0}
      data-testid={testId}
      onClick={onTap}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onTap()
      }}
      sx={{ display: 'block', mt: 0.25, color: 'primary.main', cursor: 'pointer' }}
    >
      {children}
    </Typography>
  )
}

/**
 * The drop list: the wiki table leads (it is the definitive statement), capped, then "+N more".
 *
 * AND IT IS READ AGAINST THE ERA THE SERVER IS ON (JOS-377), by the same rule and the same call as
 * the mob page — a card that answers "what is this thing worth killing for" with a revamp table
 * the server does not run is the same lie in a smaller box. Out-of-era rows sit behind their own
 * "+N out of era" disclosure, which expands IN PLACE here rather than handing off to the page: the
 * "+N more" line already owns the hand-off, and two links that mean different things must not look
 * identical. In-era and unknown rows render plainly; nothing is dropped.
 */
function DropList({ state, onOpen }: { state: CurrentMobState; onOpen: () => void }): JSX.Element {
  const [showOut, setShowOut] = useState(false)
  const { shown, out } = splitDropsByEra(state.knowledge?.dropsWiki ?? [])
  // The SAME fold the mob page uses (JOS-196) — this card has no room for the breakdown and
  // deliberately does not offer it, but "3× yours" and "1× yours" cannot be two answers to one
  // question on two surfaces. Counting keys, so an upgrade annotates the row it belongs to.
  const seenByKey = new Map(foldSeenVariants(state.knowledge?.dropsSeen ?? []).map((g) => [g.key, g]))
  const line = (d: MobDrop): JSX.Element => (
    <DropLine key={d.item} drop={d} seen={seenByKey.get(itemCountKey(d.item))} />
  )
  return (
    <Box sx={{ height: DROPS_BOX_HEIGHT, overflow: 'auto', minWidth: 0 }}>
      {shown.length === 0 && out.length === 0 ? (
        <DropsEmpty state={state} />
      ) : (
        <>
          {shown.slice(0, DROPS_SHOWN).map(line)}
          {shown.length > DROPS_SHOWN && (
            <TapLine onTap={onOpen}>+{shown.length - DROPS_SHOWN} more</TapLine>
          )}
          {out.length > 0 && (
            <TapLine onTap={() => setShowOut(!showOut)} testId="overview-mob-era-toggle">
              {outOfEraLabel(out.length)}
            </TapLine>
          )}
          {showOut && out.map(line)}
        </>
      )}
    </Box>
  )
}

export function CurrentMobCard({ state, onOpenMob }: CurrentMobCardProps): JSX.Element {
  const { target, live, knowledge } = state
  // Everything we already hold travels with the route, so the mob page paints instantly and its
  // own refresh is usually free (MobTarget.seed — the same contract the consider rows use).
  const open = (): void => {
    if (target) onOpenMob(knowledge ? { mob: target.name, seed: knowledge } : { mob: target.name })
  }

  return (
    <DashCard title="Target" testId="overview-mob">
      {!target ? (
        <QuietNote>
          Nothing engaged - the mob you swing at appears here as soon as a hit lands.
        </QuietNote>
      ) : (
        <>
          <Stack direction="row" spacing={0.75} alignItems="baseline" flexWrap="wrap" useFlexGap sx={{ minWidth: 0 }}>
            {!live && (
              <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                Last target -
              </Typography>
            )}
            <Typography
              variant="subtitle1"
              role="button"
              tabIndex={0}
              data-testid="overview-mob-name"
              onClick={open}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') open()
              }}
              sx={{
                fontWeight: 600,
                minWidth: 0,
                cursor: 'pointer',
                textDecoration: 'underline dotted',
                textUnderlineOffset: 3,
                '&:hover': { color: 'primary.main' }
              }}
            >
              {target.name}
            </Typography>
            {/* The encounter's OTHER engaged targets — the '+N' the fight name carries. */}
            {target.others > 0 && (
              <Chip size="small" variant="outlined" label={`+${target.others}`} sx={{ height: 20 }} />
            )}
            {live && <Chip size="small" color="primary" label="live" sx={{ height: 20 }} />}
          </Stack>
          <LevelZone k={knowledge} />
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, mb: 0.25 }}>
            Drops
          </Typography>
          <DropList state={state} onOpen={open} />
        </>
      )}
    </DashCard>
  )
}
