// SpellCard — THE spell hover card: everything the committed sources state about one spell, in the
// place its name is already printed (JOS-293).
//
// WHY A CARD AND NOT A TOOLTIP. The tooltip diet (AGENTS.md UI conventions) is about CAPTIONS - one
// clause, naming a control. This is the other sanctioned shape: the HOVER-CARD idiom that
// `KnownItemTooltip` (an item) and `MobCard` (a mob) already use, where the anchor is a NAME and
// the card is the record behind it. A spell name in a list answers none of "should I memorize
// this": the effect list does, beside the mana, the cast time, the duration and who it can be cast
// on. Those are all in `spells.json` and were, until now, drawn nowhere.
//
// LAW 1 IS ENFORCED BY THE SELECTION, NOT BY THIS FILE. `shared/spellDetail.ts` decides which rows
// exist - a row is drawn if and only if a source stated the field behind it - so the card cannot
// print a dash where the wiki was silent even if a future editor wanted it to. What this file owns
// is where a row goes and what it looks like. `tests/spellDetailFacts.test.mts` pins the selection.
//
// FETCH-ON-OPEN, NEVER PER ROW: the lookup lives inside the tooltip BODY, and MUI mounts a
// Tooltip's `title` node only while the tooltip is open (the `KnownItemTooltip` precedent). So a
// list of 200 spell rows costs zero IPC calls until one name is actually pointed at. There is no
// renderer-side cache on purpose: the record carries the ranks you have CAST, which change while
// the app runs, and a cached card would keep saying you had never cast the rank you just cast.
//
// MAIN WINDOW ONLY. It reads `window.eq.lookupSpell`, which the overlay bundle has no bridge for.
// The card's own drawing borrows the MUI-FREE vocabulary in `hoverCards.tsx` (palette, section,
// "+N more") so the two hover cards in this app look like one family; only the anchoring Tooltip
// is MUI, exactly as the mob card's own Timers-tab anchor is.

import { type JSX, type ReactElement, useEffect, useState } from 'react'
import type { SpellDetail } from '@shared/spellDetail'
import {
  spellClassLine,
  spellEffectClassLabels,
  spellFactsAreForLine,
  spellFocusLines,
  spellLineageLine,
  spellStatRows
} from '@shared/spellDetail'
import { spellMetricsParts } from '@shared/spellMetrics'
import { romanRank } from '@shared/spellLines'
import { nameStatesRank, observedRankLabel, observedRankRow } from '@shared/spellRanks'
import { CARD_LABEL, CARD_MONO, CARD_TEXT, CardSection, LABEL_STYLE, MoreLine, TEXT_STYLE } from './hoverCards'
import { Tooltip } from './Tooltip'
import { useObservedSpellRanks } from './useObservedSpellRanks'

/** How many effect lines / rank members the card lists before collapsing to "+N more". */
const MAX_LISTED = 8

/**
 * THE OUT-OF-ERA PILL (JOS-393) — the words the item rows already wear (`PlannerChips.EraChip`
 * says `out of era` in MUI's warning outline), drawn in this card's own MUI-free vocabulary.
 *
 * It sits beside the NAME rather than in the stat block, because it is not a property of the spell
 * the way its mana is: it is a statement about whether this server has the content at all, and that
 * governs everything under it. `true`-or-absent (see `SpellDetail.outOfEra`), so an unclassified
 * page draws nothing at all rather than an "in era" claim nobody made.
 */
const ERA_PILL: React.CSSProperties = {
  color: '#e0b070',
  border: '1px solid #e0b07066',
  borderRadius: 3,
  fontSize: 9,
  lineHeight: 1.4,
  padding: '0 3px',
  whiteSpace: 'nowrap'
}

/**
 * THE OBSERVED-RANK PILL (JOS-446) — `yours: III`, beside the name, in the era pill's shape.
 *
 * The card is where a player decides whether to buy the next scroll, and until now it could not
 * say which one they already had: the DB carries one unsuffixed row for ~1,800 of its ~1,900
 * lines, so `Clarity`'s card described `Clarity` and stopped. The claim is the log's, not the
 * catalog's, so it is coloured apart from the era pill's warning amber.
 *
 * It is NOT drawn beside a name that already states the same rank or higher: hovering
 * `Clarity III` and being told `yours: III` is the card repeating its own title.
 */
const RANK_PILL: React.CSSProperties = {
  color: '#7fd8a0',
  border: '1px solid #7fd8a066',
  borderRadius: 3,
  fontSize: 9,
  lineHeight: 1.4,
  padding: '0 3px',
  whiteSpace: 'nowrap'
}

/** The header colour says what KIND of spell it is - the same question the row's chip answers. */
const NATURE_COLOR: Record<SpellDetail['nature'], string> = {
  beneficial: '#7fd8a0',
  detrimental: '#e08a8a',
  unknown: CARD_TEXT
}

/**
 * Ask main about one spell, on MOUNT - which for a tooltip body means "on open".
 *
 * Never throws: the handler answers a `found: false` record for a name it does not know, and an
 * IPC failure leaves `data` null, which the card reports as "looking up" rather than as an empty
 * spell window.
 */
function useSpellOnOpen(name: string): { data: SpellDetail | null; loading: boolean } {
  const [data, setData] = useState<SpellDetail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void window.eq
      .lookupSpell(name)
      .then((d) => {
        if (alive) setData(d)
      })
      .catch(() => {
        /* main never rejects; a null record draws the honest "looking up" line */
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [name])

  return { data, loading }
}

/** The stat block: type, target, cast, mana, duration, instrument - each row only if stated. */
function StatRows({ detail }: { detail: SpellDetail }): JSX.Element | null {
  const rows = spellStatRows(detail)
  if (rows.length === 0) return null
  return (
    <div style={{ marginTop: 4 }}>
      {rows.map((r) => (
        <div key={r.id} style={TEXT_STYLE} data-testid="spell-card-stat" data-stat={r.id}>
          <span style={{ color: CARD_LABEL }}>{r.label}: </span>
          {r.value}
        </div>
      ))}
    </div>
  )
}

/**
 * WHAT IT IS WORTH — the row's own figures, on the card (JOS-392, owner addition).
 *
 * `dmg 143 · dps 48 · 2.1 dmg/mana`, `heal 250 · hps 83 · 3.6 heal/mana`, and the `over 24s` a DoT
 * or HoT earns: the SAME `spellMetricsParts` the unlock row prints, over metrics MAIN read off the
 * effect list. Nothing here re-reads an effect string — two formatters would be two opinions about
 * what `2.1` means, and two readers would be two answers.
 *
 * A LONG RECAST APPEARS TWICE ON THIS CARD, IN TWO DIFFERENT ROLES (JOS-444). The stat block above
 * states the timer as a fact about the spell, always. The `recast 6s` at the end of this line is
 * the DENOMINATOR the dps beside it was divided by, and it is here because the row that carries no
 * stat block needs it — dropping one of the two would leave the other surface unable to say which
 * job the number is doing.
 *
 * The level is stated in the label because a ramp's numbers mean nothing without one, and because
 * this is the card: the panel's one quiet `directional` covers the caveat, and this covers the
 * WHERE. It sits above the effect list, which is the sentence these numbers were read out of.
 */
function Figures({ detail }: { detail: SpellDetail }): JSX.Element | null {
  if (detail.metrics === undefined) return null
  const parts = spellMetricsParts(detail.metrics)
  if (parts.length === 0) return null
  const at = detail.metricsLevel === undefined ? '' : ` at level ${String(detail.metricsLevel)}`
  const atRank =
    detail.metricsAtRank === undefined || detail.metricsRank === undefined
      ? null
      : spellMetricsParts(detail.metricsAtRank)
  return (
    <CardSection label={`Worth${at}:`}>
      <div style={TEXT_STYLE} data-testid="spell-card-figures">
        {parts.join(' · ')}
      </div>
      {/* BOTH READINGS, LABELLED (JOS-447). The line above is the spell as the catalog describes it
          and this one is the spell as you own it; the card is the surface with room for the pair,
          which is exactly why the table below settles for one number and the `yours:` chip. */}
      {atRank !== null && atRank.length > 0 && (
        <div style={TEXT_STYLE} data-testid="spell-card-figures-at-rank" data-rank={String(detail.metricsRank)}>
          {`at ${romanRank(detail.metricsRank ?? 0)}: ${atRank.join(' · ')}`}
        </div>
      )}
      {/* AND A THIRD READING, WITH YOUR GEAR ON (JOS-452). The card is where the readout's quiet
          `worn +11%` marker is explained, so the figures come first and then the LINE that names
          which item produced them - the owner's ask read literally. Absent for anybody wearing
          nothing that qualifies, which is most spells for most players. */}
      <WithFocus detail={detail} />
    </CardSection>
  )
}

/**
 * The gear reading and its provenance: the focused figures, then one line per side naming the
 * effect and the item it is worn on.
 *
 * A component rather than two more branches inside `Figures` because that function was already at
 * the lint config's complexity ceiling, and because these two lines are one thought.
 */
function WithFocus({ detail }: { detail: SpellDetail }): JSX.Element | null {
  const parts = detail.metricsWithFocus === undefined ? [] : spellMetricsParts(detail.metricsWithFocus)
  const lines = spellFocusLines(detail)
  if (parts.length === 0 || lines.length === 0) return null
  return (
    <>
      <div style={TEXT_STYLE} data-testid="spell-card-figures-with-focus">
        {`with your gear: ${parts.join(' · ')}`}
      </div>
      {lines.map((line) => (
        <div key={line} style={TEXT_STYLE} data-testid="spell-card-focus-source">
          {line}
        </div>
      ))}
    </>
  )
}

/**
 * WHAT IT DOES, in the wiki's own numbered words (SpellEntry.effects, verbatim).
 *
 * This block is the reason the card exists. It is quoted rather than interpreted: "Increase
 * Hitpoints by 35 per tick" is what the page says, and any re-phrasing of it would be this app's
 * opinion about a number it did not measure.
 */
function Effects({ effects }: { effects: string[] | undefined }): JSX.Element | null {
  if (effects === undefined || effects.length === 0) return null
  return (
    <CardSection label="Effects:">
      {effects.slice(0, MAX_LISTED).map((e, i) => (
        <div key={`${String(i)}:${e}`} style={TEXT_STYLE} data-testid="spell-card-effect">
          {e}
        </div>
      ))}
      <MoreLine total={effects.length} shown={MAX_LISTED} />
    </CardSection>
  )
}

/** The derived rosters ("charm · slow"), read off the effect list by spellEffectClass.ts. */
function EffectClasses({ detail }: { detail: SpellDetail }): JSX.Element | null {
  const labels = spellEffectClassLabels(detail)
  if (labels.length === 0) return null
  return (
    <div style={{ ...LABEL_STYLE, marginTop: 3 }} data-testid="spell-card-classes">
      {labels.join(' · ')}
    </div>
  )
}

/**
 * THE RANK BLOCK - the plain rank of the name you asked about, and nothing more.
 *
 * OWNER RULING 2026-08-13 (JOS-293): ranks (the I/II/III upgrade mechanic) are orthogonal to
 * spell LINES in EQL, and a card saying "replaces <previous rank>" conflates the two - you
 * rarely keep an older rank, and the users who do are a special case. So the replaces phrase
 * and the member list came OFF the card; the derivation behind them stays in
 * shared/spellDetail.ts (tested) for any future power-user surface. The conceptual-LINE
 * lineage the owner wants lives in un-scraped wiki description prose - a data decision, not
 * this component's.
 */
function Lineage({ detail }: { detail: SpellDetail }): JSX.Element | null {
  const line = spellLineageLine(detail)
  if (line === null) return null
  // The composed line reads "Rank III · replaces X"; the card states only the first clause.
  const rankOnly = line.split(' · ')[0]
  return (
    <CardSection label="Rank:">
      <div style={TEXT_STYLE} data-testid="spell-card-lineage">
        {rankOnly}
      </div>
    </CardSection>
  )
}

/** The sentences the game prints for this spell - how you recognize it in the log. */
function Messages({ detail }: { detail: SpellDetail }): JSX.Element | null {
  const rows: { id: string; label: string; text: string }[] = []
  if (detail.msgCastOnYou !== undefined) rows.push({ id: 'you', label: 'On you', text: detail.msgCastOnYou })
  if (detail.msgCastOnOther !== undefined) {
    rows.push({ id: 'other', label: 'On a target', text: detail.msgCastOnOther })
  }
  if (detail.msgWearsOff !== undefined) rows.push({ id: 'off', label: 'Wears off', text: detail.msgWearsOff })
  if (rows.length === 0) return null
  return (
    <CardSection label="It says:">
      {rows.map((r) => (
        <div key={r.id} style={LABEL_STYLE} data-testid="spell-card-message" data-message={r.id}>
          {r.label}: {r.text}
        </div>
      ))}
    </CardSection>
  )
}

/**
 * The honest footer, and each line answers for exactly one source (the mob card's rule).
 *
 * "no page in the spell database" is a different statement from "its page states no details", and
 * the line-row note is a third thing again: the facts above are real, they just belong to the LINE
 * rather than to the rank you asked about.
 */
function Footer({ detail, loading }: { detail: SpellDetail | null; loading: boolean }): JSX.Element {
  return (
    <>
      {loading && !detail && <div style={{ ...LABEL_STYLE, marginTop: 4 }}>Looking up…</div>}
      {detail?.found === false && (
        <div style={{ ...LABEL_STYLE, marginTop: 4 }} data-testid="spell-card-notfound">
          no page in the spell database
        </div>
      )}
      {detail && spellFactsAreForLine(detail) && (
        <div style={{ ...LABEL_STYLE, marginTop: 4 }} data-testid="spell-card-line-note">
          these are the {detail.name} line&apos;s numbers - the database states none per rank
        </div>
      )}
    </>
  )
}

/**
 * The rank pill's text, or null. Read as a hook so the map is subscribed exactly where the card
 * is — which for a tooltip body means WHILE OPEN, the same mount discipline `ObservedItemWindow`
 * keeps for `useItemTiers`.
 */
function useRankPill(name: string): string | null {
  const ranks = useObservedSpellRanks()
  const row = observedRankRow(ranks, name)
  if (row === undefined || nameStatesRank(name, row)) return null
  return observedRankLabel(ranks, name)
}

/**
 * The header line: the name, and the pills that qualify the whole card rather than one of its
 * facts — whether the server has the content at all, and which rung of the line is yours.
 *
 * Its own component so the two conditionals live beside each other instead of inside the card
 * body, which the complexity ceiling reads as one branch each.
 */
function CardHeader({
  name,
  accent,
  detail
}: {
  name: string
  accent: string
  detail: SpellDetail | null
}): JSX.Element {
  const rankPill = useRankPill(name)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <div style={{ color: accent, fontSize: 12, fontWeight: 700 }}>{name}</div>
      {detail?.outOfEra === true && (
        <span style={ERA_PILL} data-testid="spell-card-out-of-era">
          out of era
        </span>
      )}
      {rankPill !== null && (
        <span style={RANK_PILL} data-testid="spell-card-observed-rank">
          {rankPill}
        </span>
      )}
    </div>
  )
}

/** The card body. Exported for the surfaces that draw it somewhere other than a Tooltip. */
export function SpellCard({ name }: { name: string }): JSX.Element {
  const { data, loading } = useSpellOnOpen(name)
  const accent = data ? NATURE_COLOR[data.nature] : CARD_TEXT
  const classLine = data ? spellClassLine(data) : null
  return (
    <div
      data-testid="spell-hover-card"
      data-spell={name}
      style={{
        background: 'rgba(15,16,23,0.98)',
        border: `1px solid ${accent}`,
        borderRadius: 6,
        padding: 8,
        maxWidth: 320,
        fontFamily: CARD_MONO,
        boxShadow: '0 6px 20px rgba(0,0,0,0.6)'
      }}
    >
      <CardHeader name={name} accent={accent} detail={data} />
      {classLine !== null && (
        <div style={LABEL_STYLE} data-testid="spell-card-classes-levels">
          {classLine}
        </div>
      )}
      {data && <EffectClasses detail={data} />}
      {data && <StatRows detail={data} />}
      {data && <Figures detail={data} />}
      {data && <Effects effects={data.effects} />}
      {data && <Lineage detail={data} />}
      {data && <Messages detail={data} />}
      <Footer detail={data} loading={loading} />
    </div>
  )
}

/**
 * HOW THE TOOLTIP DRESSES THIS CARD, hoisted to module scope so every anchor in a list passes the
 * SAME object identity - the JOS-206 finding, which the mob card's `MOB_CARD_SLOT_PROPS` states in
 * full: a fresh `slotProps` with a nested `sx` per render is real reconciliation cost across a
 * list, and this card hangs off every spell name on two surfaces already.
 *
 * The values are the tooltip getting out of the card's way: `SpellCard` draws its own surface, so
 * the popper contributes no padding, no background and no 300px width cap on top of it.
 */
const SPELL_CARD_SLOT_PROPS = {
  tooltip: { sx: { p: 0, bgcolor: 'transparent', maxWidth: 'none' } }
} as const

export interface SpellTooltipProps {
  /** the spell name exactly as the surface displays it, rank suffix intact */
  name: string
  /** where the card opens; the default suits a dense row in a list */
  placement?: 'top' | 'right' | 'bottom' | 'left' | 'right-start' | 'bottom-start'
  /** the anchor: any single element that can hold a ref */
  children: ReactElement
}

/**
 * Hover a spell name → the card. NON-INTERACTIVE by construction: there is nothing inside to reach
 * (every name in there is plain text), so the pointer never has to travel onto the card to read it,
 * and a list row's hover can close it the moment you leave.
 */
export function SpellTooltip({ name, placement = 'right', children }: SpellTooltipProps): JSX.Element {
  return (
    <Tooltip
      title={<SpellCard name={name} />}
      placement={placement}
      disableInteractive
      enterDelay={250}
      leaveDelay={60}
      slotProps={SPELL_CARD_SLOT_PROPS}
    >
      {children}
    </Tooltip>
  )
}
