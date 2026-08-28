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
// list of 200 spell rows costs zero IPC calls until one name is actually pointed at.
//
// AND SINCE JOS-511 THERE IS A BOUNDED CACHE BEHIND THAT. This file used to say there was none "on
// purpose: the record carries the ranks you have CAST". That reason was real and is now written out
// properly, beside the cache it shapes — see `RECORD_TTL_MS`: the record has FOUR live inputs, not
// one, so the cache holds a record for seconds rather than forever, and the in-flight half (two
// overlapping opens of one name are one request) is unconditional because it can go stale at all.
//
// MAIN WINDOW ONLY. It reads `window.eq.lookupSpell`, which the overlay bundle has no bridge for.
// The card's own drawing borrows the MUI-FREE vocabulary in `hoverCards.tsx` (palette, section,
// "+N more") so the two hover cards in this app look like one family; only the anchoring Tooltip
// is MUI, exactly as the mob card's own Timers-tab anchor is.

import { cloneElement, type JSX, type ReactElement, useEffect, useMemo, useState } from 'react'
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
import { useSpellLink, type OpenSpell } from './spellLink'

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

// ---- the record cache: one lookup per spell per few seconds, and NOT one per open --------------
//
// THE COST IT REMOVES (measured by the JOS-511 probe): every open fires an UNCANCELLABLE
// `spells:detail`, which is three engine round trips plus ~8 linear scans of the 1,900-row catalog
// in main (src/main/ipc/knowledge.ts). A reader comparing two rows pays that on every crossing, and
// MUI's enter hysteresis is app-global — after any tooltip closes, enter delays are zeroed for
// ~860ms — so "cross back to the row you just read" is the ordinary case rather than the odd one.
//
// WHY IT IS BOUNDED RATHER THAN PERMANENT, and this overturns the file's own header AND half of
// the ticket that asked for it. The header declined a cache because "the record carries the ranks
// you have CAST"; the ticket answered that the record is cacheable because the rank PILL stays live
// through its own subscription. The pill is indeed live — but the record is not a pure function of
// the committed DB either, and the handler says so: it is built from `Object.keys(spellLastCast)`
// (which ranks the lineage may list), `observedRankRow(...).rank` (which is what `metricsAtRank`
// and the `at III:` line are read at), `currentWornFocus()` (the `with your gear:` line) and
// `currentCombo()` (the per-class levels on the upgrade ladder). A permanent cache freezes all four
// and produces exactly the contradiction JOS-447 was careful to avoid: a live pill saying
// `yours: VIII` above a cached line that says `at III:`.
//
// So the cache is the MobCard shape with a clock on it: an entry is reused for `RECORD_TTL_MS` and
// then re-asked. That buys the whole crossing case — a reader moving between rows is inside a few
// seconds, always — and bounds every staleness above to that window, which is shorter than the
// log-line-to-fold-to-delta path that could change any of them. The in-flight map is unconditional
// and has no staleness at all: two opens of one name that overlap are one request either way.
const RECORD_TTL_MS = 5_000
const SPELL_RECORDS = new Map<string, { at: number; data: SpellDetail }>()
const SPELL_PENDING = new Map<string, Promise<SpellDetail | null>>()

/** A record still inside its TTL, or null. Exported-adjacent only in spirit: tests drive the hook. */
function freshRecord(name: string): SpellDetail | null {
  const hit = SPELL_RECORDS.get(name)
  if (!hit) return null
  if (Date.now() - hit.at > RECORD_TTL_MS) {
    SPELL_RECORDS.delete(name)
    return null
  }
  return hit.data
}

/** Resolve one spell's record, at most once per name in flight. Never rejects — a failure is null. */
function lookupSpellCached(name: string): Promise<SpellDetail | null> {
  const inflight = SPELL_PENDING.get(name)
  if (inflight) return inflight
  const p = window.eq
    .lookupSpell(name)
    .then((d: SpellDetail) => {
      SPELL_RECORDS.set(name, { at: Date.now(), data: d })
      SPELL_PENDING.delete(name)
      return d
    })
    .catch(() => {
      SPELL_PENDING.delete(name)
      return null
    })
  SPELL_PENDING.set(name, p)
  return p
}

/** Drop every cached record. For tests, and for anything that knows the world changed under it. */
export function clearSpellRecordCache(): void {
  SPELL_RECORDS.clear()
  SPELL_PENDING.clear()
}

/**
 * Ask main about one spell, on MOUNT - which for a tooltip body means "on open".
 *
 * Never throws: the handler answers a `found: false` record for a name it does not know, and an
 * IPC failure leaves `data` null, which the card reports as "looking up" rather than as an empty
 * spell window.
 *
 * EXPORTED SINCE JOS-508 for the drilldown page, which draws this card AND three sections beside
 * it off the SAME record. Sharing the hook rather than letting the page mount its own `SpellCard`
 * beside its own lookup is what keeps that to one IPC call - and, more importantly, guarantees the
 * ladder under the card and the card itself describe one answer rather than two round trips that
 * could straddle a combo correction.
 *
 * A FRESH RECORD IS TAKEN SYNCHRONOUSLY (JOS-511 item 4), in the state initializers, which is what
 * makes a re-open inside the TTL paint the answer immediately instead of flashing "Looking up…" at
 * a card the reader has already read. The `alive` flag IS the stale-open guard the integrator asked
 * about and it needs nothing new: MUI unmounts a tooltip's title node on close, so a resolution
 * arriving for a card that is no longer open is a resolution arriving after this cleanup ran.
 */
export function useSpellDetail(name: string): { data: SpellDetail | null; loading: boolean } {
  const [data, setData] = useState<SpellDetail | null>(() => freshRecord(name))
  const [loading, setLoading] = useState(() => freshRecord(name) === null)

  useEffect(() => {
    const hit = freshRecord(name)
    if (hit) {
      setData(hit)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    void lookupSpellCached(name).then((d) => {
      if (!alive) return
      // A null is an IPC failure, and it stays on the honest "looking up" line rather than
      // replacing a record this card may already be showing.
      if (d) setData(d)
      setLoading(false)
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

/**
 * The card body over a record SOMEBODY ELSE fetched (JOS-508).
 *
 * Split out of `SpellCard` so the drilldown page can draw the card and its own three sections off
 * one lookup. `SpellCard` below is this plus the hook, unchanged in shape and behaviour, and every
 * existing caller still passes only a name.
 */
export function SpellCardBody({
  name,
  data,
  loading
}: {
  name: string
  data: SpellDetail | null
  loading: boolean
}): JSX.Element {
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

/** The card, fetching its own record. Exported for the surfaces that draw it somewhere other than
 *  a Tooltip — the drilldown page (features/spells) is the one that does. */
export function SpellCard({ name }: { name: string }): JSX.Element {
  const { data, loading } = useSpellDetail(name)
  return <SpellCardBody name={name} data={data} loading={loading} />
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

/**
 * What this component adds to an anchor when the app published an opener. Declaring it — rather
 * than cloning into `ReactElement`'s `any` props — is what keeps the type-aware lint honest about
 * a call site that hands over something these cannot be attached to.
 */
interface SpellAnchorProps {
  onClick?: (e: React.MouseEvent) => void
  onKeyDown?: (e: React.KeyboardEvent) => void
  role?: string
  tabIndex?: number
  style?: React.CSSProperties
}

export interface SpellTooltipProps {
  /** the spell name exactly as the surface displays it, rank suffix intact */
  name: string
  /** where the card opens; the default suits a dense row in a list */
  placement?: 'top' | 'right' | 'bottom' | 'left' | 'right-start' | 'bottom-start'
  /** the anchor: any single element that can hold a ref */
  children: ReactElement<SpellAnchorProps>
}

/**
 * THE ANCHOR, MADE CLICKABLE — or handed back untouched (JOS-508).
 *
 * CLONED RATHER THAN WRAPPED, and that is the whole reason this is five lines instead of a `<span>`:
 * the five anchors are a `noWrap` Typography in a table cell, an inline `Box` inside a sentence, and
 * three list rows. A wrapper element changes what ellipsis, flex shrink and baseline alignment do in
 * every one of them, on surfaces this ticket has no business relayouting. `cloneElement` adds
 * handlers to the element the surface already chose and changes no box at all.
 *
 * THE PROPS THEMSELVES ARE THE CALLER'S NOW (`useAnchorProps` below, JOS-511) — this decides only
 * whether they are attached, which is still the one thing a null opener changes.
 */
function anchorFor(
  children: ReactElement<SpellAnchorProps>,
  open: OpenSpell | null,
  name: string,
  props: SpellAnchorProps
): ReactElement {
  if (open === null) return children
  return cloneElement(children, props)
}

/**
 * THE ANCHOR'S PROPS, BUILT ONCE PER NAME (JOS-511 item 2, and the measurement is the integrator's:
 * this minted THREE fresh objects — two closures and the `style` literal — per spell name per
 * render, on surfaces that draw up to forty of them).
 *
 * `SPELL_CARD_SLOT_PROPS` was hoisted to module scope for exactly this reason and its comment says
 * so; these cannot be hoisted the same way because they close over the opener and the name, so they
 * are memoized on precisely those two. The opener's identity was verified stable (it is a context
 * value published once by `lib/spellLink.tsx`), so in practice this is one object per anchor for
 * the life of the row.
 *
 * `style` rather than `sx` for the cursor, deliberately: an inline style beats MUI's generated
 * class, so the one anchor that already asks for `cursor: help` (UnlockList's `replaces …` note)
 * reads as a link here without that file being edited to say so.
 *
 * KEYBOARD TOO, because a click affordance that only a mouse can reach is half a feature — and
 * `role="link"` is what tells a screen reader the name is now a destination rather than a label.
 */
function useAnchorProps(open: OpenSpell | null, name: string): SpellAnchorProps {
  return useMemo(
    () => ({
      onClick: () => {
        open?.(name)
      },
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        open?.(name)
      },
      role: 'link',
      tabIndex: 0,
      style: { cursor: 'pointer' }
    }),
    [open, name]
  )
}

/**
 * Hover a spell name → the card. Click it → the spell's own page (JOS-508).
 *
 * STILL NON-INTERACTIVE, and the two facts are compatible rather than in tension: the card's own
 * contents remain plain text nobody has to travel onto the popper to reach, and the thing that
 * became clickable is the ANCHOR, which the pointer is already on. That is also why the drilldown
 * did not become a link INSIDE the card — `disableInteractive` would have had to go, and with it
 * the property that a list row's hover closes the moment you leave it.
 *
 * The link is ON exactly when an app published an opener (`lib/spellLink.tsx`). Nothing in the
 * overlay bundle does, so every spell name over the game is the plain text it has always been.
 *
 * `enterNextDelay` IS THE ONE THAT GOVERNS A SCROLL (JOS-511 item 4, `GearRowCompare` is the
 * precedent and its comment carries the same reason). MUI's enter hysteresis is APP-GLOBAL: once
 * ANY tooltip anywhere has closed, the next tooltip's `enterDelay` is skipped for ~860ms, and
 * `enterNextDelay` — which defaults to 0 — is what applies instead. So the 250ms above bought
 * nothing in the only situation that matters: after one card had been read, every spell name the
 * cursor crossed on the way down the list opened INSTANTLY and fired its own uncancellable
 * `spells:detail` (three engine round trips plus ~8 scans of the 1,900-row catalog, each). Naming
 * the same 250 here means a crossing is a crossing whether or not a card was open a moment ago,
 * and a deliberate hover still opens in a quarter second. It is deliberately SHORTER than the gear
 * table's 350: these anchors are names inside prose and table cells rather than whole dense rows,
 * so the pointer is aimed at one when it is on one.
 */
export function SpellTooltip({ name, placement = 'right', children }: SpellTooltipProps): JSX.Element {
  const open = useSpellLink()
  const anchorProps = useAnchorProps(open, name)
  return (
    <Tooltip
      title={<SpellCard name={name} />}
      placement={placement}
      disableInteractive
      enterDelay={250}
      enterNextDelay={250}
      leaveDelay={60}
      slotProps={SPELL_CARD_SLOT_PROPS}
    >
      {anchorFor(children, open, name, anchorProps)}
    </Tooltip>
  )
}
