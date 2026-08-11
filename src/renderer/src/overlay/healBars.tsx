// healBars — the healing overlay's BAR CHROME. The ranked healer list and, one click down, that
// healer's flat spell list (heal lanes and the absorption lane together). Split out of
// HealMeter so that file is the window chrome (header, selector, footer) and this one is the
// meter itself.
//
// WHAT IT NO LONGER OWNS (P2, docs/plans/combat-overlay-parity.md): the LEVELS, the ranking and
// every word it prints. Those moved to `features/combat/healRows.ts`, which the Combat tab's
// Healing dimension calls too — one builder, two surfaces, exactly as `petRows.meterPanel` is
// one builder for both damage meters. What is left here is genuinely overlay-only: colors, bar
// geometry, the crumb chevron.
//
// MUI-FREE ON PURPOSE: the overlay is its own renderer entry (overlay.html) with no theme and
// no component library. Do not import @mui/* into this bundle.

import type { JSX } from 'react'
import type { OverlayDrill } from '@shared/types'
import type { HealSourceView, HealSpellView, MitigationView, SegmentView } from '@shared/combat'
import type { MeterScope, RosterSnap } from '@shared/roster'
import { scopeHealing } from '../features/combat/meterScope'
import { MeterCrumb, type CrumbTotal } from './meterCrumb'
// The app's ONE `m:ss` spelling — see meterBars.tsx for why it comes from here.
import { fmtDur } from '../features/combat/copyTable'
import { formatNum as fmt, formatHealRate } from '../lib/formatRate'
import {
  ABSORB_NOTE,
  healTotalTitle,
  UNSTATED_AMOUNT,
  hasAbsorbCounts,
  healPanel,
  healerAmount,
  healerStat,
  healerTitle,
  isAbsorbLane,
  isUnstatedLane,
  laneAmount,
  spellStat,
  spellTitle
} from '../features/combat/healRows'

// Re-exported so HealMeter (and anything else in this bundle) keeps one import site for the
// honesty note; the sentence itself lives with the builder that both surfaces share.
export { ABSORB_NOTE }

/** Absorption is a different KIND of number, so it gets a deliberately different, cooler hue —
 *  a rune bar can never be mistaken for a green "hit points restored" bar at a glance. */
export const MIT_COLOR = '#8fb8d8'

/**
 * The healing meter's accent — the green its window border and header title wear, and since
 * JOS-158 the colour of the aggregate on the crumb row. Spelled out rather than borrowed from
 * `KIND_COLOR.you`: the aggregate is the one number here that is emphatically NOT yours.
 */
const ACCENT = '#7fd1a0'

const KIND_COLOR: Record<string, string> = {
  you: '#7fd1a0',
  pet: '#6fb3d2',
  other: '#a98fe0',
  enemy: '#cf6679'
}

/** A single horizontal bar: label + right-text + pct-fill. Same treatment as the DPS overlay. */
function Bar({
  color,
  pct: fill,
  rank,
  label,
  right,
  onClick,
  accent,
  title
}: {
  color: string
  pct: number
  rank?: number
  label: React.ReactNode
  right: string
  onClick?: () => void
  accent?: string
  title?: string
}): JSX.Element {
  return (
    <div
      onClick={onClick}
      title={title}
      style={{
        position: 'relative',
        height: 18,
        borderRadius: 3,
        marginBottom: 2,
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        background: 'rgba(255,255,255,0.06)'
      }}
    >
      <div style={{ position: 'absolute', inset: 0, width: `${Math.max(2, fill)}%`, background: color, opacity: 0.55 }} />
      {accent && <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: accent }} />}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          padding: accent ? '0 6px 0 9px' : '0 6px',
          gap: 6,
          fontSize: 11,
          lineHeight: 1,
          textShadow: '0 1px 2px rgba(0,0,0,0.9)'
        }}
      >
        {rank != null && (
          <span style={{ color: 'rgba(255,255,255,0.55)', width: 12, textAlign: 'right' }}>{rank}</span>
        )}
        <span style={{ fontWeight: 600, flexGrow: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}
        </span>
        <span style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{right}</span>
      </div>
    </div>
  )
}

export type Drill = OverlayDrill

/**
 * The COUNT-ONLY absorption families. The rune lane is not here any more — it has an amount, so
 * it ranks among the bars above as an `absorbed` row. These two do not: the log gives them no
 * number at all, so they are counts under the bars, in no total, never a bar (a bar would imply
 * a magnitude that was never recorded).
 *
 * No `title`: the line itself ends '· no amount logged', which is the whole disclosure — a hover
 * restating the label earns nothing (AGENTS.md tooltip and caveat diet).
 */
function AbsorbCounts({ mit }: { mit: MitigationView }): JSX.Element | null {
  if (!hasAbsorbCounts(mit)) return null
  return (
    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', padding: '5px 2px 0', lineHeight: 1.5 }}>
      {mit.absorbedSwings > 0 && <>{mit.absorbedSwings} swings absorbed</>}
      {mit.absorbedSwings > 0 && mit.absorbedDamageShields > 0 && ' · '}
      {mit.absorbedDamageShields > 0 && <>{mit.absorbedDamageShields} damage shields absorbed</>}
      <span style={{ color: 'rgba(255,255,255,0.35)' }}> · no amount logged</span>
    </div>
  )
}

/**
 * A quiet state, not a zeroed meter. The amount-less absorption families can still have fired
 * with nothing to rank (swings eaten by a rune granted before this fight), so show those counts
 * rather than go blank. A rune GRANT would have produced a row above.
 */
function NothingToRank({ live, mit }: { live: boolean; mit: MitigationView | null }): JSX.Element {
  return (
    <>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', padding: '8px 2px' }}>
        {live ? 'No healing yet…' : 'Waiting for healing…'}
      </div>
      {mit && <AbsorbCounts mit={mit} />}
    </>
  )
}

/**
 * THE AGGREGATE THE TITLE BAR USED TO CARRY (JOS-158) — the SEGMENT's own `HealingView.hps`,
 * moved and not recomputed, so the number a pinned meter shows did not change on the day its
 * label appeared. It carries the restored/absorbed sentence that used to hang off the header tail
 * (`healTotalTitle` — the one phrasing both healing surfaces print), because a layout move is no
 * reason for an honesty note to go missing. What the number COVERS is said by the crumb row's own
 * label; see overlay/meterCrumb.tsx.
 */
function healTotal(seg: SegmentView | undefined): CrumbTotal {
  return {
    text: formatHealRate(seg?.healing.hps ?? 0),
    accent: ACCENT,
    title: healTotalTitle(seg?.healing)
  }
}

/**
 * The bar body: healers → that healer's spell list. Every decision below — which level, which
 * rows, the stale-drill fallback, what rides under level 1 — comes from `healPanel`, the SAME
 * call the Combat tab's Healing dimension makes. This function is the chrome around it.
 *
 * `setDrill` is null in locked mode: the same levels render, minus every affordance.
 */
export function HealBars({
  seg,
  scope,
  roster,
  drill,
  setDrill,
  live
}: {
  seg: SegmentView | undefined
  scope: MeterScope
  roster: RosterSnap
  drill: Drill | null
  setDrill: ((d: Drill | null) => void) | null
  live: boolean
}): JSX.Element {
  // EVERY healer, ranked — no row budget (owner feedback 2026-08-05); the content pane scrolls.
  // Scoped first, through the SAME filter the Combat tab's Healing dimension uses: You keeps you
  // and your pets, Group keeps the healers the roster names, Everyone keeps them all. One filter
  // and one builder, so the pinned overlay and the docked tab can never rank a fight differently.
  const panel = healPanel(scopeHealing(seg?.healing, scope, roster), drill?.entityId ?? null)
  const dur = fmtDur(seg?.durationSec ?? 0)
  const total = healTotal(seg)

  // Level 2: the healer's spells. Back is offered here and on every other meter kind now — the
  // SAME component, so the four kinds cannot drift into four opinions again (JOS-35).
  if (panel.level === 2) {
    return (
      <MeterCrumb
        name={panel.subject.name}
        dur={dur}
        total={total}
        onBack={setDrill ? () => setDrill(null) : null}
      >
        {/* ONE flat ranked list: heal spells and the absorption lane together, biggest first.
            No grouping level — that is what hid the flat breakdown in the damage drill-down.
            The absorption lane is told apart by COLOR + chip, never by where it sits. */}
        {panel.rows.map((s) => (
          <SpellBar key={`${s.classification}:${s.name}`} s={s} healerKind={panel.subject.kind} />
        ))}
      </MeterCrumb>
    )
  }

  if (panel.empty) return <NothingToRank live={live} mit={panel.mitigation} />

  // Level 1: healers, then the absorption section.
  return (
    <MeterCrumb name={null} dur={dur} total={total} onBack={null}>
      {panel.healers.map((h, i) => (
        <HealerBar
          key={h.id}
          h={h}
          rank={i + 1}
          onDrill={setDrill ? () => setDrill({ entityId: h.id }) : undefined}
        />
      ))}
      {panel.mitigation && <AbsorbCounts mit={panel.mitigation} />}
      <EnemyHealedLine enemy={panel.enemy} />
    </MeterCrumb>
  )
}

/** One lane inside a healer's drill: a heal spell, or the absorption lane. */
function SpellBar({ s, healerKind }: { s: HealSpellView; healerKind: string }): JSX.Element {
  const color = isAbsorbLane(s) ? MIT_COLOR : KIND_COLOR[healerKind] ?? '#888'
  return (
    <Bar
      color={color}
      accent={color}
      pct={s.pct}
      label={
        <>
          {s.name}
          {/* Heal lines that named no spell get an explicit, labeled lane — never folded
              silently into a real spell's numbers. */}
          {s.name === 'Unspecified' && (
            <span style={{ color: 'rgba(255,255,255,0.45)', fontWeight: 400 }}> ~no spell named</span>
          )}
          {/* The classification as a plain suffix, matching this file's existing `·pet` /
              `·enemy` convention — no badge, so it can never overflow the bar. */}
          {isAbsorbLane(s) && (
            <span style={{ color: 'rgba(255,255,255,0.5)', fontWeight: 400 }}> ·absorbed</span>
          )}
          {/* …and the third classification: a heal the log announced without an amount (Mend).
              The suffix is what stops the zero-length bar beside it reading as a heal that did
              nothing. */}
          {isUnstatedLane(s) && (
            <span style={{ color: 'rgba(255,255,255,0.5)', fontWeight: 400 }}> ·{UNSTATED_AMOUNT}</span>
          )}
          <span style={{ marginLeft: 6, color: 'rgba(255,255,255,0.62)', fontWeight: 400 }}>
            {spellStat(s)}
          </span>
        </>
      }
      right={laneAmount(s)}
      title={spellTitle(s)}
    />
  )
}

/** One ranked healer at level 1. */
function HealerBar({
  h,
  rank,
  onDrill
}: {
  h: HealSourceView
  rank: number
  onDrill?: () => void
}): JSX.Element {
  return (
    <Bar
      color={KIND_COLOR[h.kind] ?? '#888'}
      // A row carrying absorption gets the cool accent stripe, so it reads as mixed before a
      // single number is read. The split itself is in the stat run and the drill.
      accent={h.absorbedTotal > 0 ? MIT_COLOR : undefined}
      pct={h.pct}
      rank={rank}
      label={
        <>
          {h.name}
          {h.kind === 'pet' ? ' ·pet' : h.kind === 'enemy' ? ' ·enemy' : ''}
          <span style={{ marginLeft: 6, color: 'rgba(255,255,255,0.62)', fontWeight: 400 }}>
            {healerStat(h)}
          </span>
        </>
      }
      right={healerAmount(h)}
      onClick={onDrill}
      title={healerTitle(h)}
    />
  )
}

/** Counter-healing is an ANNOTATION on your damage, not part of your sustain, so it never
 *  enters the ranking above — it gets one honest line. */
function EnemyHealedLine({
  enemy
}: {
  enemy: { total: number; healers: HealSourceView[] }
}): JSX.Element | null {
  if (enemy.total <= 0) return null
  return (
    <div
      style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', padding: '6px 2px 0' }}
      title={`Healing that landed on mobs you fought. Top: ${enemy.healers
        .slice(0, 3)
        .map((h) => `${h.name} ${fmt(h.total)}`)
        .join(', ')}`}
    >
      enemies healed {fmt(enemy.total)}
    </div>
  )
}
