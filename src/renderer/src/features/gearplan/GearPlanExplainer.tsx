// gearplan/GearPlanExplainer.tsx — THE CARD THAT SAYS WHAT THIS TAB CAN DO.
//
// IT TEACHES THE TOOL AND NOT THE GAME, which is the whole editorial line and it was learned the
// hard way: the first version explained what merging does, what an extraction costs, and that green
// means better. Every one of those is something a player already knows before they open this app,
// and spending a card's worth of attention on them buries the part they cannot know - which
// controls exist here and what each one acts on.
//
// So every point below is a capability: pick an item for a slot, set its level, fill a socket, act
// on the whole board, narrow the two pickers, feed the comparison. Where a game rule is unavoidable
// it is stated as a consequence of a control rather than as a lesson ("sockets unlock as it rises"),
// and where the surface already says a thing in place - `+3 to unlock` on a locked socket, the
// filter bar's own hidden count - the card does not repeat it.
//
// `planner/RulesExplainer.tsx` is the sibling that DOES teach a game system, and the split is now
// clean: that card owns exaltation's rules, this one owns this tab's controls. Neither restates the
// other.
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
// THE ONE THING THIS CARD STATES THAT COULD GO STALE is the dump command and its steps, and they are
// READ from the output registry (`shared/outputs/kinds.ts`) rather than typed - so a corrected
// command reaches this card and the Exaltations tab together. Nothing else here quotes a constant,
// which is a property of teaching the tool rather than the numbers: a control's name is the control.

import { type JSX, useCallback, useState } from 'react'
import { Alert, AlertTitle, Box, Button, Stack, Typography } from '@mui/material'
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
  const [steps, setSteps] = useState(false)
  return (
    <Alert
      severity="info"
      variant="outlined"
      onClose={onDismiss}
      data-testid="gearplan-explainer"
      sx={{ flexShrink: 0 }}
    >
      <AlertTitle>What this tab can do</AlertTitle>
      <Stack spacing={1}>
        <Point lead="One item per slot.">
          Click a slot name, its icon or the item&apos;s name to search what fits it. Full stats
          opens that item&apos;s own record.
        </Point>
        <Point lead="The slider sets the item's level.">
          Sockets unlock as it rises, and every number on the board follows it.
        </Point>
        <Point lead="Each socket takes one exaltation.">
          Click a socket to see the effects that fit it, what each one does, and which item it comes
          off.
        </Point>
        <Point lead="The right column does the comparing.">
          What the board adds up to, and what it would change against what you have on. Planned
          exaltations are listed there rather than summed, because they move an effect and not a
          stat.
        </Point>
        <Point lead="The toolbar acts on the whole board.">
          Load what you are wearing onto it, send the whole plan to your wish list, or clear it.
        </Point>
        <Point lead="The filter bar narrows both pickers.">
          Best on ranks candidates by the stats you pick. Beats worn keeps only the ones that beat
          the piece in that slot.
        </Point>
        {/* THE DUMP, LAST, because it is the one thing here you do outside the app - and its steps
            are COLLAPSED, which is the idiom they arrived with. `OutputFileLine`'s own argument for
            hiding them by default holds wherever they live: "nothing about the line changes for
            somebody who is not asking, and one click gets the answer without leaving the tab." */}
        <Point lead="The comparison reads your inventory dump.">
          {`${INVENTORY.command} - ${INVENTORY.why}`}
        </Point>
        {INVENTORY.steps.length > 0 && (
          <Box>
            <Button
              size="small"
              variant="text"
              data-testid="gearplan-explainer-steps-toggle"
              onClick={() => setSteps((v) => !v)}
              sx={{ textTransform: 'none', px: 0, minWidth: 0 }}
            >
              {steps ? 'Hide how to type it' : 'How to type it'}
            </Button>
            {steps && (
              <Box component="ul" sx={{ m: 0, pl: 2.5 }} data-testid="gearplan-explainer-steps">
                {INVENTORY.steps.map((step) => (
                  <Typography key={step} component="li" variant="body2" sx={{ lineHeight: 1.55 }}>
                    {step}
                  </Typography>
                ))}
              </Box>
            )}
          </Box>
        )}
      </Stack>
    </Alert>
  )
}
