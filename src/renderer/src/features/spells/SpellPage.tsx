// SpellPage — ONE SPELL, IN FULL, WITH ITS LINE AND ITS SCHEDULE (JOS-508).
//
// The owner's ask, verbatim: from any spell, see THE LINE it belongs to (the prior and next spells
// in the same line), WHEN THE CURRENT COMBO GETS EACH ONE, and EVERY CLASS that gets the spell
// (with its level). Three sections, in that order, and nothing else.
//
// WHY A PAGE AND NOT A BIGGER CARD. `SpellCard` is a HOVER — 320px wide, non-interactive, closing
// the moment the pointer leaves the row, and rightly so: it answers "should I memorize this" while
// your eye is on a list. A ladder is a different shape of question. It is eight rows of two levels
// each, it wants to be read rather than glanced at, and every rung on it is itself a spell you may
// want to open next. None of that fits in a popper, and stretching the card to hold it would have
// cost the property that makes the card good.
//
// EVERY JOIN ARRIVES DONE (ruling 4, enforced by eslint.domainMunging.mjs). `main/data/spellLinePath.ts`
// chose the ladder, ordered the rungs, marked the one you asked about and computed each rung's
// combo level; `shared/spellDetail.ts` turned every claim into its sentence. Nothing below sorts,
// filters or aggregates anything — it maps. That is also why this file adds no lint exemption: it
// has nothing to exempt.
//
// THE PAGE IS ITS OWN LINK TARGET. Each rung of the ladder is a spell name, and a spell name in
// this app is a link (lib/spellLink.tsx), so walking a line is clicking down it — each hop parking
// the last, so Back retraces the walk. That is the whole reason the ladder's rows are rendered
// through the same `SpellTooltip` every other surface uses rather than as plain text: one
// affordance, one card, one destination, everywhere.

import { type JSX } from 'react'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { Box, Button, Chip, Divider, Stack, Typography } from '@mui/material'
import type { ClassAbbr } from '@shared/classCombo'
import type { SpellDetail, SpellLineStep } from '@shared/spellDetail'
import {
  spellClassIsYours,
  spellFactsAreForLine,
  spellLineNote,
  spellNeighbourLine,
  spellStatRows,
  spellStepWhen
} from '@shared/spellDetail'
import type { AppRouting, NavBack } from '../../appRouting'
import type { View } from '../../appViews'
import { SpellCardBody, SpellTooltip, useSpellDetail } from '../../lib/SpellCard'
import { useBackTarget } from '../../appBack'

/**
 * THE ONE RUNG OF THE LADDER, as a row: the level its class gains it at, the name, and when YOU
 * get it.
 *
 * The name is a `SpellTooltip` anchor like every other spell name in the app, so it hovers the card
 * and clicks through to that rung's own page — which is what makes a ladder walkable rather than a
 * list to read and then go looking for.
 *
 * The rung you are ON is marked and is NOT a link to itself: a row that navigates to the page it is
 * already on is a control that appears to do nothing, which is worse than no control.
 */
function LadderRow({ step, combo }: { step: SpellLineStep; combo: readonly ClassAbbr[] }): JSX.Element {
  const when = spellStepWhen(step, combo)
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="baseline"
      data-testid="spell-line-step"
      data-spell={step.name}
      data-here={step.queried ? 'yes' : 'no'}
      sx={{ py: 0.25, opacity: step.queried ? 1 : 0.92 }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ width: 28, flexShrink: 0 }}>
        {step.level}
      </Typography>
      {step.queried ? (
        <Typography variant="body2" sx={{ fontWeight: 700 }} data-testid="spell-line-here">
          {step.name}
        </Typography>
      ) : (
        <SpellTooltip name={step.name} placement="right">
          <Typography variant="body2">{step.name}</Typography>
        </SpellTooltip>
      )}
      <Box sx={{ flexGrow: 1 }} />
      <Typography variant="caption" color="text.secondary" data-testid="spell-line-when">
        {when}
      </Typography>
    </Stack>
  )
}

/**
 * SECTION 2 — THE LINE, as a vertical progression with the combo's levels called out.
 *
 * Absent entirely when no class's research ladder carries this spell, which is most of the catalog
 * (`spellLinePath.ts` answers null and this draws nothing). A ladder of one would be a section that
 * looked like a progression and was not.
 *
 * The neighbour sentence sits ABOVE the rungs because it is the answer to the owner's question and
 * the rungs are its working — the same ordering the mob card's note block uses.
 */
function LineSection({ detail }: { detail: SpellDetail }): JSX.Element | null {
  const path = detail.linePath
  if (path === null) return null
  const note = spellLineNote(detail)
  const neighbours = spellNeighbourLine(detail)
  return (
    <Box data-testid="spell-line-section" data-line={path.line} data-line-class={path.cls}>
      <Typography variant="overline" color="text.secondary">
        {path.line} · {path.cls}
      </Typography>
      {note !== null && (
        <Typography variant="caption" color="warning.main" display="block" data-testid="spell-line-note">
          {note}
        </Typography>
      )}
      {neighbours !== null && (
        <Typography variant="body2" color="text.secondary" data-testid="spell-line-neighbours">
          {neighbours}
        </Typography>
      )}
      {/* A SET rather than a ladder (travel rings, the Imbue gems, the poison tiers) still lists its
          membership — the spell really is one of them — and says why it names no order. */}
      {!path.ladder && (
        <Typography variant="caption" color="text.secondary" display="block" data-testid="spell-line-set">
          these are one set rather than a progression - none of them replaces another
        </Typography>
      )}
      <Box sx={{ mt: 0.5 }}>
        {path.steps.map((s) => (
          <LadderRow key={s.name} step={s} combo={detail.combo} />
        ))}
      </Box>
    </Box>
  )
}

/**
 * SECTION 3 — EVERY CLASS THAT GETS THE SPELL, with its level.
 *
 * NOT filtered down to your loadout, deliberately: "who else casts this" is half the owner's ask,
 * and a table that quietly dropped the classes you are not playing would answer a question nobody
 * asked. Yours are CHIPPED instead, so the page states both facts at once.
 *
 * `classLevels` arrives sorted by level then class from main (`parseSpellClassLevels`), and is
 * rendered in exactly that order.
 */
function ClassSection({ detail }: { detail: SpellDetail }): JSX.Element | null {
  if (detail.classLevels.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary" data-testid="spell-classes-none">
        the database places this spell in no class at all
      </Typography>
    )
  }
  return (
    <Box data-testid="spell-classes-section">
      <Typography variant="overline" color="text.secondary">
        Classes
      </Typography>
      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ mt: 0.5 }}>
        {detail.classLevels.map((c) => {
          const mine = spellClassIsYours(detail, c.cls)
          return (
            <Chip
              key={c.cls}
              size="small"
              data-testid="spell-class-level"
              data-class={c.cls}
              data-mine={mine ? 'yes' : 'no'}
              color={mine ? 'primary' : 'default'}
              variant={mine ? 'filled' : 'outlined'}
              label={`${c.cls} ${String(c.level)}`}
            />
          )
        })}
      </Stack>
    </Box>
  )
}

/**
 * The stat strip under the title — the same rows the card draws, from the same selection, so the
 * hover and the page can never state different numbers for one spell.
 */
function StatStrip({ detail }: { detail: SpellDetail }): JSX.Element | null {
  const rows = spellStatRows(detail)
  if (rows.length === 0) return null
  return (
    <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap">
      {rows.map((r) => (
        <Typography key={r.id} variant="caption" color="text.secondary" data-testid="spell-page-stat" data-stat={r.id}>
          {r.label}: {r.value}
        </Typography>
      ))}
    </Stack>
  )
}

/**
 * THE SPELL DRILLDOWN.
 *
 * SECTION 1 IS THE CARD ITSELF, drawn inline rather than re-implemented: `SpellCard` is already the
 * agreed rendering of "what the spell record carries" — effects verbatim, the figures at three
 * readings, the messages the game prints — and a second component saying the same things in
 * different words is exactly how two surfaces come to disagree about a spell. It is exported for
 * this (its own header says so: "for the surfaces that draw it somewhere other than a Tooltip").
 *
 * `name` is the string the user clicked, rank suffix intact. The record answers for the row behind
 * it and says so (`spellFactsAreForLine`), and the page repeats that caveat because a page is read
 * for longer than a hover.
 */
export function SpellPage({
  name,
  nav,
  onClose
}: {
  name: string
  /** the app's ONE back contract — a spell page is ALWAYS a drill, so this is always present. */
  nav?: NavBack
  onClose: () => void
}): JSX.Element {
  // ONE LOOKUP for the card and the three sections beside it (see `useSpellDetail`'s header). It
  // re-runs on `name`, which is what makes walking the ladder work: clicking a rung remounts
  // nothing and simply asks about the next spell.
  const { data: detail, loading } = useSpellDetail(name)
  // ONE expression read by two things, the mob drill's rule: the button, and the mouse's Back
  // button for as long as this page is up.
  const back = (): boolean => {
    if (!nav?.back()) onClose()
    return true
  }
  useBackTarget(back)
  return (
    <Stack spacing={1} sx={{ height: '100%' }} data-testid="spell-page" data-spell={name}>
      <Box>
        <Button size="small" data-testid="spell-page-back" startIcon={<ArrowBackIcon />} onClick={back}>
          {nav?.origin?.label ?? 'Back'}
        </Button>
      </Box>
      <Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto' }}>
        <Stack spacing={1.5} sx={{ maxWidth: 720 }}>
          <Box>
            <Typography variant="h6" data-testid="spell-page-title">
              {name}
            </Typography>
            {detail !== null && spellFactsAreForLine(detail) && (
              <Typography variant="caption" color="text.secondary" data-testid="spell-page-line-note">
                these are the {detail.name} line&apos;s numbers - the database states none per rank
              </Typography>
            )}
            {detail !== null && <StatStrip detail={detail} />}
          </Box>
          <Divider />
          {/* SECTION 1 — the spell itself, in the app's one spell rendering. */}
          <Box data-testid="spell-page-record">
            <SpellCardBody name={name} data={detail} loading={loading} />
          </Box>
          {detail?.linePath != null && <Divider />}
          {detail !== null && <LineSection detail={detail} />}
          <Divider />
          {detail !== null && <ClassSection detail={detail} />}
        </Stack>
      </Box>
    </Stack>
  )
}

/**
 * THE ROUTER'S END OF THE DRILL — the view check, the payload check and the remount key.
 *
 * IT LIVES HERE RATHER THAN IN App.tsx, and the reason is measured rather than aesthetic: this
 * branch needs BOTH a view test and a payload test, which cost `PlainView` two points of the
 * complexity ceiling and pushed App.tsx one line past its 400-line one. AGENTS.md records the
 * identical move for the loot link ("this is the seam the ceiling was pointing at"), and it is the
 * right seam here too — everything below is about spells, and nothing about it is about the app.
 *
 * KEYED ON THE SPELL rather than on `viewKey`: walking a line is a hop from one spell page to the
 * next, and remounting is how the page drops the previous spell's scroll position and its in-flight
 * lookup instead of briefly drawing one spell's ladder under another spell's title.
 */
export function SpellDrill({
  view,
  viewKey,
  routing
}: {
  view: View
  viewKey: string
  routing: AppRouting
}): JSX.Element | null {
  if (view !== 'spell' || routing.spellName === null) return null
  return (
    <SpellPage
      key={`${viewKey}#${routing.spellName}`}
      name={routing.spellName}
      nav={routing.nav}
      onClose={() => {
        routing.clearSpellFocus()
        // A spell page has no browse surface of its own to fall back to, so a Back with nothing
        // parked lands on the app's front door rather than on a tab that was never in the journey.
        routing.selectView('overview')
      }}
    />
  )
}
