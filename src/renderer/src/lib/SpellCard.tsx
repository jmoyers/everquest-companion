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
  spellLineageLine,
  spellStatRows
} from '@shared/spellDetail'
import { spellMetricsParts } from '@shared/spellMetrics'
import { CARD_LABEL, CARD_MONO, CARD_TEXT, CardSection, LABEL_STYLE, MoreLine, TEXT_STYLE } from './hoverCards'
import { Tooltip } from './Tooltip'

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
 * The level is stated in the label because a ramp's numbers mean nothing without one, and because
 * this is the card: the panel's one quiet `directional` covers the caveat, and this covers the
 * WHERE. It sits above the effect list, which is the sentence these numbers were read out of.
 */
function Figures({ detail }: { detail: SpellDetail }): JSX.Element | null {
  if (detail.metrics === undefined) return null
  const parts = spellMetricsParts(detail.metrics)
  if (parts.length === 0) return null
  const at = detail.metricsLevel === undefined ? '' : ` at level ${String(detail.metricsLevel)}`
  return (
    <CardSection label={`Worth${at}:`}>
      <div style={TEXT_STYLE} data-testid="spell-card-figures">
        {parts.join(' · ')}
      </div>
    </CardSection>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <div style={{ color: accent, fontSize: 12, fontWeight: 700 }}>{name}</div>
        {data?.outOfEra === true && (
          <span style={ERA_PILL} data-testid="spell-card-out-of-era">
            out of era
          </span>
        )}
      </div>
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
