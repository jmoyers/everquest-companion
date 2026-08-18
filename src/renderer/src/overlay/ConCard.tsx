// ConCard — ONE card for one `/con` (JOS-383, narrowed to a LILY PAD by JOS-390).
//
// MUI-FREE BY LAW (AGENTS.md: the overlay bundle is plain React + inline styles), tooltip-shaped
// and semi-transparent, over the game. It answers the two questions you have in the two seconds
// before you pull — what is it, and how hard does it resist what I cast — and it is the CLICK that
// answers everything else.
//
// THE WHOLE CARD IS A LINK (owner ruling, 2026-08-16). A click anywhere on it except the × opens
// that creature's page in the app, over the SAME deep link the celebration toast's card has always
// used (`eqOverlay.focusMob` → main's `focusView` → `applyDeepLink` → `openMob`). That is why the
// drops and the respawn left this file: the page one click away has the drop table, the fold over
// `+N` variants, the perceived rate, the kills, the quests and all five resist rows, with room to
// explain each — and a card over a running game does not.
//
// AND IT IS A LINK ONLY WHILE THE OVERLAY IS LOCKED. Unlocked is positioning mode: the window wears
// a drag region and a click there is the user moving the card, so navigating would fight the drag.
// The hint follows the same gate — the name reads as a link, the cursor is a pointer and the card
// carries its accessible NAME exactly when a click would actually do something. Never a `title`:
// this bundle draws no tooltips at all, and the ruling behind that is at `CON_CARD_OPEN_HINT`.
//
// CLICKING DOES NOT CLOSE IT, deliberately: the app comes forward, the card is still up behind it,
// and the next con or the auto-hide takes it. "I read it" is the × and nothing else — which is the
// same statement main's re-con suppression rests on.
//
// EVERY SENTENCE ON IT IS SOMEBODY ELSE'S DERIVATION, deliberately:
//   * the axis WORD and its COLOUR come from `@shared/resistTypes` + `features/resists/
//     resistColors.ts`, which says in its own header that this overlay imports it — an axis that is
//     purple on the mob page and blue here is two axes to the person reading them;
//   * `R 126 (110-144)`, `n=32` and `not enough data (n=2)` come from `features/resists/
//     resistRow.ts`, the same three functions the mob page's rows print.
// Nothing here computes anything about the world. It lays the chips out and draws what it is told.
//
// NO ACRONYMS, EVER (owner ruling, 2026-08-16). A chip carries the colour AND the word AND the tag,
// in that fixed order, every time — magic, fire, cold, poison, disease — so the eye learns the
// positions and a red-green colour-blind reader never has to tell poison from disease by hue.
//
// AN ANSWER IS NEVER WITHHELD (owner ruling, 2026-08-16). Every chip the card draws carries the
// tag, the number, the interval and the count — at n = 1 exactly as at n = 600, with a quieter
// `low samples` caveat under ten — because the wide interval IS the honest display of a thin cell.
//
// …BUT ONLY THE AXES IT RESISTS ARE DRAWN AT ALL (second owner ruling, same day — the argument is
// at `notableChips` in conCardRows.ts). `weak`, `normal` and empty axes leave the card; the mob page
// keeps all five rows and is one click away, and when nothing qualifies this card says so in one
// quiet line rather than going silent.

import { type CSSProperties, type JSX, type MouseEvent, useEffect, useState } from 'react'
import type { ConCardPayload } from '@shared/conCard'
import { RESIST_AXIS_WORDS } from '@shared/resistTypes'
import { lowSamples } from '@shared/resistModel'
import { RESIST_AXIS_COLORS } from '../features/resists/resistColors'
import {
  FROM_RESIST_RATE_NOTE,
  LOW_SAMPLE_NOTE,
  NPC_ONLY_NOTE,
  benchmarkText,
  countText,
  estimateText,
  resistRateText
} from '../features/resists/resistRow'
import { CARD_ENTER_MS, CARD_EXIT_MS } from './cardQueue'
import { CON_CARD_OPEN_HINT, conCardTotalN, notableChips, type ConCardNotableChip } from './conCardRows'

const MUTED = '#a8b0c6'
const DIM = '#7c8397'
const GOLD = '#d9b25f'
const BUTTON_PX = 20

/**
 * HOW NARROW A CHIP COLUMN MAY GET (JOS-406) — and it is MEASURED, not chosen.
 *
 * The number is the widest PHRASE a chip prints, laid out on one line in the overlay's own type,
 * plus the chip's own horizontal chrome. Measured in Electron itself (the overlay bundle declares
 * no `font-family` at all, so the type is Chromium's default standard font — Times New Roman on
 * Windows — and a measurement taken in any other face would be a guess about this one):
 *
 *   145.23 px  `may not land even with overchannel`   guidance line, 10 px   ← the widest
 *    94.98 px  `with overchannel 100%`                benchmark line, 10 px
 *    76.33 px  `R 106 (92-126) n=43`                  detail line, 9 px
 *   122.81 px  `very resistant · low samples`         tag line, 11 px
 *
 * plus 14 px of chrome: `padding: '4px 6px'` on each side (12) and the 1 px border twice (2).
 * 145.23 + 14 = 159.23, rounded up to 160.
 *
 * IT IS A MINIMUM, NOT A WIDTH. `1fr` is the other half of the track: at the default window every
 * column is wider than this, and this number is only what decides how many columns there are.
 *
 * AND IT IS WHAT THE DEFAULT CARD WIDTH IS SIZED FROM, not the other way round — see
 * `CON_CARD_SIZE` in main/overlayLayout.ts, which was moved up so three of these still fit.
 */
export const CHIP_MIN_PX = 160
/** The × — named once, because the card-wide click reads it back to exclude itself (JOS-390). */
const CLOSE_TESTID = 'con-card-close'

/** The enter/exit transition, as a style — the banner's, so two cards over one game move alike. */
function motionStyle(entering: boolean, exiting: boolean): CSSProperties {
  const hidden = entering || exiting
  return {
    opacity: hidden ? 0 : 1,
    transform: hidden ? 'translateY(-6px)' : 'translateY(0)',
    transition: `opacity ${String(exiting ? CARD_EXIT_MS : CARD_ENTER_MS)}ms ease-out, transform ${String(
      exiting ? CARD_EXIT_MS : CARD_ENTER_MS
    )}ms ease-out`
  }
}

/**
 * The identity line: what it is, what level the game just said it is, and where you are.
 *
 * THE NAME IS THE HINT (JOS-390). When a click would open the mob page the name wears a link's
 * underline — quiet, in the card's own gold, at the one place the eye is already reading. That is
 * the whole affordance: no button, no "click to open" instruction, and nothing at all in the mode
 * where a click means drag. NOT a `title`: this bundle draws no tooltips at all (the ruling and the
 * argument are at `CON_CARD_OPEN_HINT`), so the words go on the card as its accessible NAME.
 */
function Identity({ payload, linked }: { payload: ConCardPayload; linked: boolean }): JSX.Element {
  const facts = [
    payload.level === undefined ? null : `Level ${String(payload.level)}`,
    payload.rare === true ? 'rare creature' : null,
    payload.zone ?? null
  ].filter((f): f is string => f !== null)
  return (
    <div style={{ minWidth: 0 }}>
      <div
        data-testid="con-card-name"
        data-linked={linked ? 'true' : 'false'}
        style={{
          color: '#e6ebf5',
          fontSize: 15,
          fontWeight: 700,
          lineHeight: 1.25,
          overflowWrap: 'anywhere',
          ...(linked
            ? {
                textDecoration: 'underline',
                textDecorationColor: `${GOLD}88`,
                textDecorationThickness: 1,
                textUnderlineOffset: 3
              }
            : {})
        }}
      >
        {payload.name}
      </div>
      {facts.length > 0 && (
        <div data-testid="con-card-facts" style={{ color: MUTED, fontSize: 11, marginTop: 1 }}>
          {facts.join(' · ')}
        </div>
      )}
    </div>
  )
}

/**
 * ONE AXIS CHIP: colour, word, tag — and, underneath in smaller type, the estimate and its interval.
 * The number NEVER appears without its interval and its count, which is JOS-382's rule and the
 * difference between "nuke cold" and "we have no idea yet".
 *
 * Every chip that reaches here has an answer: `notableChips` is the only source of them and it
 * keeps nothing else, so there is no empty branch to draw. A chip with ONE observation still
 * reports in full — tag, R, interval, count — and wears the quieter `low samples` caveat.
 */
function Chip({ chip }: { chip: ConCardNotableChip }): JSX.Element {
  const color = RESIST_AXIS_COLORS[chip.axis]
  return (
    <div
      data-testid={`con-chip-${chip.axis}`}
      data-tag={chip.tag}
      style={{
        minWidth: 0,
        padding: '4px 6px',
        borderRadius: 6,
        border: `1px solid ${color}66`,
        background: `${color}1f`
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: color, flex: '0 0 auto' }} />
        <span style={{ color, fontSize: 11, fontWeight: 700 }}>{RESIST_AXIS_WORDS[chip.axis]}</span>
      </div>
      {/* THE BAND IS WORDS, ALWAYS. `overflowWrap` rather than an ellipsis: "may not land even
          with overchannel" truncated to "may not land…" is the acronym problem wearing different
          clothes, and it would invert the sentence's meaning rather than merely shorten it. */}
      <div
        data-testid={`con-chip-tag-${chip.axis}`}
        style={{ color, fontSize: 11, marginTop: 2, overflowWrap: 'anywhere' }}
      >
        {chip.from === 'benchmark' ? chip.tag : resistRateText(chip.empirical)}
        {lowSamples(chip.n) && <span style={{ color: DIM }}>{` · ${LOW_SAMPLE_NOTE}`}</span>}
      </div>
      {/* THE GUIDANCE SENTENCE, under the word (owner ruling, 2026-08-16). The word is what the eye
          picks out of a card over a running game; this is what to do about it, and the two are one
          band read two ways. */}
      {chip.benchmark && (
        <div
          data-testid={`con-chip-guidance-${chip.axis}`}
          style={{ color: MUTED, fontSize: 10, marginTop: 1, overflowWrap: 'anywhere' }}
        >
          {chip.benchmark.guidance}
        </div>
      )}
      {/* THE TWO PERCENTAGES, under the band, on the card as on the page (owner ruling): the band
          answers the common case and these let a player scale their own — a rank-10 spell is another
          -150, a malo another 45.

          WHEN THE FIT DID NOT FIT there is no benchmark to print and no number to print either; the
          chip says where its claim came from instead, which is the whole point of the pinned guard.

          THE COUNT HERE IS THE INFORMATIVE ONE AND ONLY THAT (JOS-385). `chip.n` is the half of the
          evidence that could have gone either way. The mob page prints the total beside it because
          it has a column to print it in; a 9px chip does not. The total still crosses the wire
          (`chip.nTotal`) — a layout decision, not a shorter truth. */}
      <div data-testid={`con-chip-bench-${chip.axis}`} style={{ color: MUTED, fontSize: 10, marginTop: 1 }}>
        {chip.benchmark ? benchmarkText(chip.benchmark) : FROM_RESIST_RATE_NOTE}
      </div>
      <div data-testid={`con-chip-detail-${chip.axis}`} style={{ color: DIM, fontSize: 9, marginTop: 1 }}>
        {chip.fit ? `${estimateText(chip.fit)} ${countText(chip.n)}` : countText(chip.n)}
        {chip.npcOnly && ` · ${NPC_ONLY_NOTE}`}
      </div>
    </div>
  )
}

/**
 * The resist block: the axes this creature actually RESISTS, in `RESIST_AXES` order, and a quiet
 * line when there are none.
 *
 * THE EMPTY STATE IS A SENTENCE, NOT AN ABSENCE. "no notable resists" plus the observation count is
 * the card saying we looked — which is the half of the old five-chips argument that had to survive
 * the cut (conCardRows.ts `notableChips`). `n = 0` prints as "nothing seen yet" rather than as a
 * confident all-clear, because those are different answers and the difference is the whole reason
 * the count is on the line at all.
 */
function Chips({ payload }: { payload: ConCardPayload }): JSX.Element {
  const chips = notableChips(payload.chips)
  const totalN = conCardTotalN(payload.chips)
  return (
    <div data-testid="con-card-resists">
      {!payload.spellData && (
        <div style={{ color: DIM, fontSize: 10, marginBottom: 3 }}>
          Resists need your EverQuest install&apos;s spells_us.txt - resistance below is what the log
          alone can say.
        </div>
      )}
      {chips.length === 0 ? (
        <div data-testid="con-card-no-resists" style={{ color: DIM, fontSize: 11 }}>
          {totalN > 0 ? `no notable resists · ${countText(totalN)}` : 'no notable resists · nothing seen yet'}
        </div>
      ) : (
        /* A GRID OF COLUMNS AS WIDE AS A CHIP NEEDS, as many as fit (JOS-406).

           IT USED TO BE `repeat(max(3, n), 1fr)`, and both halves of that were doing real work.
           The `n` divided the row among however many chips survived the notable filter; the `max(3,
           …)` was there because once the card stopped drawing all five axes, ONE chip stretched
           across the whole card and read as a banner rather than as a chip. Both arguments survive
           here, and `auto-fill` is what carries them: a track is only ever created at the chip's own
           minimum width, so one chip is ONE COLUMN of the row and the rest of the row is empty
           tracks — never a banner. (`auto-fit`, which collapses the empty tracks and lets the single
           chip absorb them, is exactly the banner, which is why it is not what is written here.)

           WHAT `max(3, n)` COULD NOT DO is refuse to squeeze. It divided whatever width the card had
           by the column count, so at a text size the window had not grown for — the owner's 200% mob
           card, which is the report this ticket comes from — each chip got an ~80 px column and `with
           overchannel 100%` wrapped one word per line. `minmax(CHIP_MIN_PX, 1fr)` makes the failure a
           WRAP INTO ROWS instead: five chips at the default width are three columns and then two, and
           the window's height follows the card (JOS-386). That is the right failure at every width,
           and it is required even though half 1 of this ticket makes the window grow — a user may
           still narrow the strip by hand, and the work-area clamp can still bite on a small screen. */
        <div
          data-testid="con-card-chip-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fill, minmax(${String(CHIP_MIN_PX)}px, 1fr))`,
            gap: 4,
            alignItems: 'stretch'
          }}
        >
          {chips.map((c) => (
            <Chip key={c.axis} chip={c} />
          ))}
        </div>
      )}
    </div>
  )
}

export function ConCard({
  payload,
  exiting,
  bgAlpha,
  linked,
  onHover,
  onOpen,
  onDismiss
}: {
  payload: ConCardPayload
  exiting: boolean
  bgAlpha: number
  /** The overlay is LOCKED, so a click on this card is a link rather than the start of a drag. */
  linked: boolean
  onHover: (over: boolean) => void
  /** "Open this creature's page in the app." Called for a click anywhere but the × — see header. */
  onOpen: () => void
  onDismiss: () => void
}): JSX.Element {
  const [entering, setEntering] = useState(true)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntering(false))
    return () => cancelAnimationFrame(id)
  }, [])

  /**
   * ONE handler on the whole card, and the × excluded by ANCESTRY rather than by
   * `stopPropagation` on the button.
   *
   * That is the difference between a rule and a coincidence: `closest` asks "did this click land
   * inside the close control", so anything the button ever grows inside it (an icon, a focus ring)
   * is excluded for free, and a future control that must not navigate opts out by saying so in one
   * place. A `stopPropagation` in the button would put the same rule somewhere it cannot be read
   * from here.
   */
  const openUnlessClose = (e: MouseEvent<HTMLDivElement>): void => {
    if (!linked) return
    if ((e.target as HTMLElement).closest(`[data-testid="${CLOSE_TESTID}"]`)) return
    onOpen()
  }

  return (
    <div
      data-testid="con-card"
      data-mob={payload.id}
      data-linked={linked ? 'true' : 'false'}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onClick={openUnlessClose}
      /* NAMED, NEVER HOVERED — the title bar's own remedy under the 2026-08-16 tooltip ruling, and
         the reason there is no `title` anywhere in this bundle (see CON_CARD_OPEN_HINT). Only while
         the click means something: an unlocked card is a thing you drag, not a link. */
      aria-label={linked ? CON_CARD_OPEN_HINT : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 10px',
        borderRadius: 8,
        border: `1px solid ${GOLD}55`,
        background: `rgba(15,17,21,${String(bgAlpha)})`,
        backdropFilter: 'blur(6px)',
        boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
        cursor: linked ? 'pointer' : 'default',
        ...motionStyle(entering, exiting)
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <Identity payload={payload} linked={linked} />
        <span style={{ flex: '1 1 auto' }} />
        {/* EVERY CARD CLOSES (the celebration card's JOS-83 rule, kept twice over): this window is
            always-on-top over a game, and a user who wants it gone must not have to find
            Preferences. Closing also tells main, which is what stops a re-con putting it straight
            back up (ConCardOverlay.tsx). */}
        <button
          type="button"
          data-testid={CLOSE_TESTID}
          aria-label="Close this mob card"
          onClick={onDismiss}
          style={{
            flexShrink: 0,
            width: BUTTON_PX,
            height: BUTTON_PX,
            lineHeight: '18px',
            padding: 0,
            borderRadius: 4,
            border: '1px solid rgba(255,255,255,0.18)',
            background: 'transparent',
            color: MUTED,
            fontSize: 13,
            cursor: 'pointer'
          }}
        >
          ×
        </button>
      </div>
      <Chips payload={payload} />
      {/* THE FACTION SLOT (JOS-94). Deliberately EMPTY and deliberately here: the ticket that owns
          faction-on-con lands its standing read in this exact position, under the resists, and a
          slot reserved in the layout is the difference between that being an insertion and a
          redesign. Nothing is drawn, because nothing is known — the con line states a faction RUNG,
          which is a fact about standing this card does not yet claim to report. */}
      <div data-testid="con-card-faction" />
    </div>
  )
}
