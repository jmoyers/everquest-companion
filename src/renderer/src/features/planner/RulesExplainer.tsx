// planner/RulesExplainer.tsx — THE CARD THAT TEACHES EXALTATION (V10, docs/plans/planner-v2.md).
//
// Every other surface in this app states STATE and refuses to explain itself — that is the UI
// convention and it is right for a meter. A planner is different: it is a set of rules you are
// planning against, and a player who does not know them cannot tell a good plan from a bad one.
// So this is the one collaborative explainer the tooltip-and-caveat diet explicitly allows: it
// helps someone use the feature successfully, it is dismissible, and dismissing it is remembered.
//
// BUT IT WAITS TO BE ASKED (owner, 2026-08-06 — JOS-51). This file used to argue that a player
// should MEET the rules on their first visit, so the card opened itself and filled the top of the
// tab for every new install. The owner overturned that: the rules are there when asked for, never
// by default. The `?` in the toolbar is now the ONLY way the card first appears — which does not
// weaken the teaching claim above, it just stops the teaching from being an interruption. The
// remembered state is unchanged in both directions: a card you left open is up next visit, a card
// you dismissed stays away.
//
// EVERY NUMBER IS READ, NOT WRITTEN. `extractionTier` gives the four unlock tiers, `extractionCost`
// gives the merge arithmetic, `SOCKET_TYPES` gives how many sockets there are, `CURRENT_ERA_LABEL`
// gives which expansion the filter is scoped to. Nothing here restates a constant — the whole
// point of shared/planner/rules.ts is that "+4 costs 15" has exactly one home, and a teaching card
// that quoted it by hand would be the first thing to go stale when the wiki corrects itself.
//
// R7 IS DELIBERATELY ABSENT. It is owner-observed and unverified in any published source
// (exaltation-planner.md §1), and a card that teaches the rules must not teach one of them as
// settled when it is not. The planner acts on R7 by excluding summoned items from the donor index;
// that is a conservative filter, not a rule worth telling a player.

import { type JSX, useCallback, useState } from 'react'
import { Alert, AlertTitle, Box, Stack, Typography } from '@mui/material'
import { SOCKET_TYPES, type SocketType } from '@shared/planner/types'
import { extractionCost, extractionTier } from '@shared/planner/rules'
import { CURRENT_ERA_LABEL } from './plannerData'
import { SOCKET_LABEL } from './plannerGroups'

const KEY = 'eq.planner.explainer'

/**
 * Whether the card is showing. CLOSED unless the store explicitly says otherwise (JOS-51): only a
 * remembered '1' — written when someone asked for the card with the toolbar's `?` and left it up —
 * opens it. Absent (a fresh install) and '0' (dismissed) both mean closed, so the ask is the only
 * door in and the state is still remembered in both directions.
 */
export function useExplainer(): { open: boolean; show: () => void; dismiss: () => void } {
  const [open, setOpen] = useState(() => localStorage.getItem(KEY) === '1')
  const set = useCallback((v: boolean) => {
    localStorage.setItem(KEY, v ? '1' : '0')
    setOpen(v)
  }, [])
  return { open, show: () => set(true), dismiss: () => set(false) }
}

/** "Focus at +1, Click at +2, Worn at +3, Proc at +4" — built from the rule, in unlock order. */
function unlockLine(): string {
  return SOCKET_TYPES.map((s: SocketType) => `${SOCKET_LABEL[s]} at +${String(extractionTier(s))}`).join(', ')
}

/** The dearest socket's own arithmetic, quoted from `extractionCost` and never recomputed. */
function costLine(): string {
  const dearest = SOCKET_TYPES.reduce((a, b) => (extractionTier(a) >= extractionTier(b) ? a : b))
  const cost = extractionCost(extractionTier(dearest))
  return `${SOCKET_LABEL[dearest]} is the dearest: about ${String(cost.d0Copies)} ordinary copies merged in, or ${String(cost.d4Copies)} from the hardest difficulty tier, which arrives ready.`
}

function Rule({ title, children }: { title: string; children: string }): JSX.Element {
  return (
    <Box>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {children}
      </Typography>
    </Box>
  )
}

/** The card. Rendered above the modes so it teaches whichever one you are on. */
export default function RulesExplainer({ onDismiss }: { onDismiss: () => void }): JSX.Element {
  return (
    <Alert
      severity="info"
      variant="outlined"
      data-testid="planner-explainer"
      onClose={onDismiss}
      sx={{ mb: 1.5, alignItems: 'flex-start' }}
    >
      <AlertTitle>How exaltation works</AlertTitle>
      <Stack spacing={0.75}>
        <Rule title="Sockets unlock as an item is merged up">
          {`Every item can carry one socket of each kind, and each kind opens at its own merge tier: ${unlockLine()}. The same tier is what a DONOR must reach before you can pull that effect out of it.`}
        </Rule>
        <Rule title="An effect only moves between items that match">
          {`The donor and the destination must share an equipment slot and a class. Socketing then narrows the destination to the overlap - plan a Ranger-only proc into a six-class sword and it becomes a Ranger sword. Wide-class donors are the valuable ones, and the classes on this set are a FILTER on what you are shown, never a rule about what you may keep.`}
        </Rule>
        <Rule title="Haste never travels">
          {'A haste effect cannot be moved. Haste gear is still worth wearing - it is just worth wearing as itself.'}
        </Rule>
        <Rule title="What it costs is merges, not money">{costLine()}</Rule>
        <Rule title="What you are being shown">
          {`The browser is scoped to ${CURRENT_ERA_LABEL} by default, because planning around gear from an expansion this server has not opened is a wish list. Turn that off any time; anything nothing can place stays visible and says so.`}
        </Rule>
      </Stack>
    </Alert>
  )
}
