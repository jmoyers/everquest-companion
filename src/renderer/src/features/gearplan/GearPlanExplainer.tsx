// gearplan/GearPlanExplainer.tsx — THE CARD THAT TEACHES THE BOARD.
//
// `planner/RulesExplainer.tsx` for the Plan tab, and the reason it is a second file rather than a
// mode of that one is that they teach different things: that card teaches EXALTATION, a set of
// game rules; this one teaches a SURFACE, which controls do what. The two overlap on the merge
// ladder alone, and that one line is read from the same function on both.
//
// -------------------------------------------------------------------------------------------------
// IT WAITS TO BE ASKED, AND THAT IS AN OWNER RULING RATHER THAN A PREFERENCE.
//
// `RulesExplainer`'s header records what happened to the alternative:
//
//   "BUT IT WAITS TO BE ASKED (owner, 2026-08-06 - JOS-51). This file used to argue that a player
//    should MEET the rules on their first visit, so the card opened itself and filled the top of
//    the tab for every new install. The owner overturned that: the rules are there when asked for,
//    never by default."
//
// So this card has exactly one door in - the `?` in the toolbar - and the remembered state works in
// both directions: a card you left open is up next visit, a card you dismissed stays away.
//
// THE FIRST-VISIT TEACHING LIVES IN THE EMPTY STATE INSTEAD (`NothingPlanned`), which is a better
// answer than a first-run flag anyway. An empty board IS the first-visit state; it needs no flag,
// no dismissal and no way back, it never interrupts somebody who already has a plan, and it returns
// exactly when it is true again. A remembered "have they seen it" bit is a thing that can be wrong.
// An empty board cannot be wrong about being empty.
//
// -------------------------------------------------------------------------------------------------
// EVERY NUMBER IS READ, NOT WRITTEN — `RulesExplainer`'s rule, and the reason it has one.
//
// `extractionTier` gives the four unlock tiers, `extractionCost` gives the merge arithmetic,
// `SOCKET_TYPES` gives how many sockets there are and their order, and the `/outputfile` command
// and its steps come from the registry (`shared/outputs/kinds.ts`). Nothing here restates a
// constant: "+4 costs 15" has exactly one home, and a teaching card that quoted it by hand would be
// the first thing to go stale when the wiki is corrected.
//
// THE DUMP INSTRUCTIONS LIVE HERE NOW. They used to sit in a permanent `OutputFileLine` at the top
// of the tab; the command, the why-clause and the How steps are all TEACHING, and teaching belongs
// in the thing you open when you want to be taught. What stayed on the tab is the one part of that
// row that is not teaching - how old your dump is - because that is ambient state about the data on
// screen, it matters most when this card is closed, and it has nowhere else to go.

import { type JSX, useCallback, useState } from 'react'
import { Alert, AlertTitle, Box, Stack, Typography } from '@mui/material'
import { SOCKET_TYPES, type SocketType } from '@shared/planner/types'
import { extractionCost, extractionTier } from '@shared/planner/rules'
import { outputKind } from '@shared/outputs/kinds'

const KEY = 'eq.gearplan.explainer'
const INVENTORY = outputKind('inventory')

/**
 * Whether the card is showing. CLOSED unless the store explicitly says otherwise: only a remembered
 * '1' — written when somebody asked for the card with the toolbar's `?` and left it up — opens it.
 * Absent (a fresh install) and '0' (dismissed) both mean closed, so the ask is the only door in.
 *
 * RAW `localStorage`, matching `RulesExplainer` rather than the area-memory table. That table is for
 * FORM state a view restores (`areaMemory.ts`); whether a teaching card is open is neither a form
 * field nor scoped to the gear area's tabs, and routing it through the tiered store would put a
 * fourteenth key in a table whose whole value is that every entry there is a form field.
 */
export function useGearPlanExplainer(): { open: boolean; show: () => void; dismiss: () => void } {
  const [open, setOpen] = useState(() => localStorage.getItem(KEY) === '1')
  const set = useCallback((v: boolean) => {
    localStorage.setItem(KEY, v ? '1' : '0')
    setOpen(v)
  }, [])
  return { open, show: () => set(true), dismiss: () => set(false) }
}

/** "focus at +1, click at +2, worn at +3, proc at +4" — built from the rule, in unlock order. */
function unlockLine(): string {
  return SOCKET_TYPES.map((s: SocketType) => `${s} at +${String(extractionTier(s))}`).join(', ')
}

/** The dearest socket's own arithmetic, quoted from `extractionCost` and never recomputed. */
function costLine(): string {
  const dearest = SOCKET_TYPES.reduce((a, b) => (extractionTier(a) >= extractionTier(b) ? a : b))
  const cost = extractionCost(extractionTier(dearest))
  return `Extracting into the ${dearest} socket needs the donor merged to +${String(cost.tier)}, which is about ${String(cost.d0Copies)} ordinary copies of it, or ${String(cost.d4Copies)} from the hardest tier.`
}

/** One teaching paragraph: a bold lead, then the sentence that earns it. */
function Point({ lead, children }: { lead: string; children: string }): JSX.Element {
  return (
    <Typography variant="body2" sx={{ lineHeight: 1.55 }}>
      <Box component="span" sx={{ fontWeight: 600 }}>
        {lead}
      </Box>
      {` ${children}`}
    </Typography>
  )
}

export default function GearPlanExplainer({ onDismiss }: { onDismiss: () => void }): JSX.Element {
  return (
    <Alert
      severity="info"
      variant="outlined"
      onClose={onDismiss}
      data-testid="gearplan-explainer"
      sx={{ flexShrink: 0 }}
    >
      <AlertTitle>How the plan board works</AlertTitle>
      <Stack spacing={1}>
        <Point lead="A cell is an item and its sockets.">
          Click a slot name or its icon to pick an item for it. Click an item&apos;s name to open its
          full record.
        </Point>
        <Point lead="Merging does two things at once.">
          {`Each item has its own merge level. Raising it scales that item's stats and unlocks its exaltation sockets: ${unlockLine()}. Lowering it never deletes a socket you have already planned - the socket stays and says what would unlock it again.`}
        </Point>
        <Point lead="Weapons get better twice.">
          Merging raises a weapon&apos;s damage and leaves its delay alone, so its ratio improves.
          That is the number on the weapon&apos;s own line.
        </Point>
        <Point lead="Exaltations are listed, never added up.">
          An exaltation moves an effect, and this board sums stats. A planned proc contributes
          nothing to the totals, so it is listed in its own block beside them rather than inside
          them.
        </Point>
        <Point lead="What an exaltation costs.">{costLine()}</Point>
        <Point lead="Green is better, red is worse.">
          Each cell states what it would change against what you have on, gains first and losses
          second. Lower is better on delay and weight, so a shorter delay is a gain even though the
          number goes down.
        </Point>
        <Point lead="The filter bar narrows both pickers.">
          It never hides anything from the board itself, and it always says how many rows it is
          holding back.
        </Point>
        <Point lead="Best on ranks, Beats worn filters.">
          Picking stats puts the best candidates first and removes nothing. The Beats worn chip in
          the item panel is the one that hides things, and it compares against the item worn in the
          slot you are filling.
        </Point>
        {/* THE DUMP, LAST, because it is the one thing here you do outside the app. The command and
            the steps are the registry's own words (`OutputKindDef`), so a corrected command reaches
            this card and the Exaltations tab together. */}
        <Point lead="Where the comparison comes from.">
          {`${INVENTORY.command} - ${INVENTORY.why}`}
        </Point>
        {INVENTORY.steps.length > 0 && (
          <Box component="ul" sx={{ m: 0, pl: 2.5 }} data-testid="gearplan-explainer-steps">
            {INVENTORY.steps.map((step) => (
              <Typography key={step} component="li" variant="body2" sx={{ lineHeight: 1.55 }}>
                {step}
              </Typography>
            ))}
          </Box>
        )}
      </Stack>
    </Alert>
  )
}
