// DpsCard — "how hard am I hitting, right now", and the way down to the Combat tab.
//
// IT IS THE COMBAT TAB'S METER, COMPACT (JOS-105, owner: "the Overview tab's damage panel behaves
// differently from the Combat tab - bars are not clickable, drill does not work. It must use THE
// EXACT SAME components so behavior is identical everywhere: combat overlay = combat module =
// overview combat tab. No forked panel implementations.").
//
// What was forked, and is now gone:
//   * its own drill vocabulary (`sources | self | pet`) beside the app's `Drill` union;
//   * its own row components — a bare `Bar` with no `onClick`, so a source bar that drilled on
//     the Combat tab was INERT here, which is the defect the ticket opens with;
//   * its own call into `ownBreakdown`/`nestedRows`, reaching past the shared row builder.
// It now holds a `Drill` token, hands it to `petRows.meterPanel` like every other meter, and
// renders `MeterRows` — the same components, the same clicks, the same two levels, including the
// inline per-ability stats (crit/double/triple/miss) that expand beneath a bar (JOS-113).
//
// The card still shows DELIBERATELY LESS than the Combat tab, and that is a matter of PROPS
// (`compact`, `maxRows`) rather than of different code: one label, one headline rate, one
// supporting line, five rows. No fight selector, no timeline, no Outgoing/Incoming switch, no
// combat log. If you want any of those, that is what the link is for
// (docs/plans/overview-tab.md §3.1).
//
// IT DOES OBEY THE METER SCOPE (JOS-115). It never had a scope control and still has none — but
// "no control" used to mean "no filter", so a user who set the meters to You still saw every
// group-mate's bar on the glance card, which is the same two-surfaces-disagree defect JOS-105
// opened with. Now the one persisted preference reaches here too, through the same
// `meterScope.scopeSources`/`scopeTotals` pair the Combat tab's panel uses — including the
// headline, because a total that counts rows the list is hiding is the "aggregates lie" failure
// (law 5). The scope is STATED nowhere on this card: it is four rows tall, and the Combat tab
// one click away carries the readout and the roster popover that explain it.
//
// The drill state is CARD-LOCAL — it must never move the Combat tab's drill — but it is no longer
// UNPERSISTED (JOS-116). "Coming back to Overview always shows the glance" turned out to be a
// description of the bug rather than a design: this view unmounts on every tab switch, so a drill
// you had opened was gone the moment you looked at anything else. It now has its own remembered
// slot (`useDrillMemory('overview')`, a different key from the tab's), so the card comes back
// where you left it and the two surfaces still move independently.
//
// THE LABEL IS NOT RE-DERIVED. `fightScopeOptions(...).head.label` is the ONE place the honest
// live/last wording is decided ("Current fight (live)" while a pull is open, "Last fight — <name>"
// between pulls), and the Combat tab's head row reads the same function. A second copy of that
// sentence here is exactly the drift `scopeOptions()` exists to prevent — so this card renders it
// VERBATIM, and the two surfaces can never disagree about whether you are in a fight.
//
// Likewise the SUBJECT: the snapshot is pulled with no `selectedId`, so the engine resolves the
// default (open fight, else the most recent finalized one) — by construction the same fight the
// head row names. That identity is what makes "Open in Combat" land on the fight you were
// looking at, and why the button always sends the LIVE_SELECTION sentinel rather than a pinned
// id: the sentinel re-resolves every tick, so it follows you out of this pull and into the next.
//
// And the NUMBERS: the headline is `seg.outDps` / `seg.outTotal` — you AND your pets, the same
// aggregate the Combat tab's panel header shows. Nesting the pet changes how the rows are laid
// out, never what they sum to.

import { useEffect, useMemo, useRef, type JSX } from 'react'
import { Button, Stack, Typography } from '@mui/material'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import type { CombatSnapshot, SegmentView, SourceView } from '@shared/combat'
import { DashCard, QuietNote, fmtDur } from '../combat/combatShared'
import { LIVE_SELECTION, fightScopeOptions, meterDrill, type Drill } from '../combat/dashboardData'
import { DrillCrumb, MeterRows, crumbOf } from '../combat/MeterRows'
import { meterPanel, panelTotals, type MeterPanel } from '../combat/petRows'
import { scopeSources, scopeTotals } from '../combat/meterScope'
import { useCombinePetRow, useMeterScope } from '../combat/useCombatPrefs'
import { useDrillMemory } from '../combat/useDrillMemory'
import { AbilityExpandProvider } from '../combat/abilityExpand'
import type { CombatFocus } from '../combat/combatFocus'
import { EMPTY_ROSTER, type MeterScope, type RosterSnap } from '@shared/roster'
import { formatNum, formatRate } from '../../lib/formatRate'

/** How many rows a GLANCE shows, at any level. The full list is one click away. */
const TOP_ROWS = 5

export interface DpsCardProps {
  snap: CombatSnapshot | null
  onOpenCombat: (f: CombatFocus) => void
}

/**
 * The card's numbers once the METER SCOPE has had its say — the ranked rows and the three figures
 * derived FROM those rows, never carried over from the unfiltered segment (law 5, and the same
 * derivation `SegmentPanel.scopedDimension` makes so the two surfaces cannot disagree).
 *
 * The two rates ride through `scopeTotals` as well, because each shares its denominator with the
 * total it belongs to: `outDps` divides by the segment's elapsed time and `activeDps` by its
 * active seconds, so scaling either by the surviving fraction of the damage is exact rather than
 * re-derived. When the scope removes nothing — every ungrouped session, which is most of them —
 * every value comes back BY REFERENCE and by identity.
 */
interface ScopedView {
  rows: SourceView[]
  total: number
  dps: number
  activeDps: number
}

function scopedView(seg: SegmentView, scope: MeterScope, roster: RosterSnap): ScopedView {
  const rows = scopeSources(seg.entities, scope, roster)
  const { total, dps } = scopeTotals(seg.entities, rows, seg.outTotal, seg.outDps)
  const { dps: activeDps } = scopeTotals(seg.entities, rows, seg.outTotal, seg.activeDps)
  return { rows, total, dps, activeDps }
}

/**
 * …and the same three figures once the DRILL has had its say (JOS-170).
 *
 * The card's headline and supporting line are as unlabelled as the Combat tab's header, so they
 * answer to the same rule: the number over a list describes THAT list. `petRows.panelTotals` is
 * the one place that is decided — level 1 keeps the scoped figures, a drill takes the subject
 * plus the pets nested into it, and the pet preference therefore moves the number in the same
 * render that it moves the rows.
 */
interface CardBody {
  /** the shared builder's answer, built ONCE — the rows below and the figures above share it. */
  panel: MeterPanel
  view: ScopedView
}

function cardBody(v: ScopedView, combine: boolean, drill: Drill | null): CardBody {
  const panel = meterPanel(v.rows, combine, meterDrill(drill))
  const { total, dps } = panelTotals(panel, v.total, v.dps)
  return { panel, view: { rows: v.rows, total, dps, activeDps: panelTotals(panel, v.total, v.activeDps).dps } }
}

/** total · duration · active-time DPS — the secondary stat, never the headline (law 7). */
function supportingLine(seg: SegmentView, v: ScopedView): string {
  return `${formatNum(v.total)} total · ${fmtDur(seg.durationSec)} · ${formatRate(v.activeDps)} active`
}

function OpenInCombat({ onOpenCombat }: { onOpenCombat: (f: CombatFocus) => void }): JSX.Element {
  return (
    <Button
      size="small"
      data-testid="overview-open-combat"
      endIcon={<OpenInNewIcon sx={{ fontSize: 14 }} />}
      onClick={() => onOpenCombat({ scope: 'fight', selection: LIVE_SELECTION })}
      // `lineHeight` is what keeps the RANK aligned, not decoration: a small Button's default
      // 1.75 makes a card that HAS an action 23px tall in the header where a card without one is
      // 20px, so the four peers of the NOW rank would start their bodies 3px apart. Fitting the
      // button inside the title's own line box lands every card's first line on the same y
      // (measured: all four headers 20px, all four bodies on one top edge).
      sx={{ minWidth: 0, py: 0, px: 0.75, lineHeight: 1.4 }}
    >
      Open in Combat
    </Button>
  )
}

/**
 * The rows for whatever level the card is on, plus the crumb that frames them — the SHARED body,
 * at glance density.
 *
 * The proc-rate annotations are deliberately not passed: they belong to the Combat tab's wider
 * rows, and an unlabelled `3.1 ppm` tag squeezed into a quarter-width bar is noise. Nothing else
 * differs, and nothing here is a second implementation of anything.
 */
function DpsRows({
  seg,
  panel,
  setDrill,
  onOpenCombat
}: {
  seg: SegmentView
  /** the shared builder's answer, built ONCE in the card so its headline reads the same one. */
  panel: MeterPanel
  setDrill: (d: Drill | null) => void
  onOpenCombat: () => void
}): JSX.Element {
  const crumb = crumbOf(panel)
  return (
    <Stack sx={{ minWidth: 0 }}>
      {crumb && <DrillCrumb crumb={crumb.crumb} parent={crumb.parent} compact setDrill={setDrill} />}
      <MeterRows
        panel={panel}
        activeSec={seg.activeSec}
        procs={[]}
        setDrill={setDrill}
        compact
        maxRows={TOP_ROWS}
        onMore={onOpenCombat}
        empty="Nothing has landed in this fight yet."
      />
    </Stack>
  )
}

export function DpsCard({ snap, onOpenCombat }: DpsCardProps): JSX.Element {
  const head = fightScopeOptions(snap?.segments ?? []).head
  const seg = snap?.selected ?? null
  const [combinePetRow] = useCombinePetRow()
  // WHOSE damage — the app-wide preference (JOS-115), applied here exactly as it is on the Combat
  // tab. `EMPTY_ROSTER` while the first snapshot is in flight makes Group render as Everyone for
  // that instant, never an empty card.
  const [meterScope] = useMeterScope()
  const roster = snap?.roster ?? EMPTY_ROSTER
  // Card-local but REMEMBERED (JOS-116) — its own key, so nothing here can move the Combat tab's
  // drill and nothing there can move this one.
  //
  // LEVEL 1 IS THE OPENING LEVEL FOR A FRESH INSTALL, as it is on every other meter (JOS-35). The
  // card used to open DRILLED whenever the pet preference was on — the last surviving
  // `defaultDrill` in the tree — which meant a glance card and the tab it links to disagreed about
  // what "no drill" shows.
  const { drill, setDrill, isOpen, setOpen } = useDrillMemory('overview')
  // Memoized for the reason CombatView's twin is (JOS-510 item 3): both members are already
  // `useCallback`s, so the object literal was the whole churn, and a context value that changes
  // identity every render re-renders every consumer beneath it whatever else is memoized.
  const abilityExpand = useMemo(() => ({ isOpen, setOpen }), [isOpen, setOpen])

  // Changing the pet preference still resets the card, because the level-1 layout changes under
  // it — but ONLY on an actual change. A bare `useEffect(…, [combinePetRow])` also fires on MOUNT,
  // which is exactly when this card has just hydrated a stored drill, so it would undo the whole
  // ticket every time you opened the Overview tab. The ref is what tells a user's flip from a
  // mount; CombatView.undrilling is the same rule in its other shape.
  const prevCombine = useRef(combinePetRow)
  useEffect(() => {
    if (prevCombine.current === combinePetRow) return
    prevCombine.current = combinePetRow
    setDrill(null)
  }, [combinePetRow, setDrill])

  // THE one row builder, called ONCE for this card — the rows below and the two figures above
  // them are now the same answer (JOS-170). It used to be called inside `DpsRows`, which is
  // exactly how the headline came to describe the fight while the rows described a drill.
  const body = seg ? cardBody(scopedView(seg, meterScope, roster), combinePetRow, drill) : null

  return (
    // The link down is offered even with nothing to show: "there are no fights" is a thing the
    // Combat tab says better than a glance card can, and a disappearing button would make the
    // one affordance this card exists for the least reliable thing on it.
    <DashCard title="Damage" testId="overview-dps" right={<OpenInCombat onOpenCombat={onOpenCombat} />}>
      {/* No fights at all ⇒ the same honest quiet state the Combat tab shows. It never borrows
          the zone aggregate to look busy — Overall is a click away and says so there. */}
      {!head || !seg || !body ? (
        <QuietNote>No fights yet - engage something and it’ll appear here.</QuietNote>
      ) : (
        <>
          <Typography variant="caption" color="text.secondary" data-testid="overview-dps-label" noWrap>
            {head.label}
          </Typography>
          <Typography variant="h4" sx={{ color: 'primary.main', lineHeight: 1.15 }} data-testid="overview-dps-value">
            {formatRate(body.view.dps)}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mb: 0.75 }} data-testid="overview-dps-support">
            {supportingLine(seg, body.view)}
          </Typography>
          {/* The inline per-ability stats a reader expanded are remembered beside the drill they
              sit inside (JOS-116); the provider is how that answer reaches the shared SkillBar
              without four components growing a pair of props they have no use for. */}
          <AbilityExpandProvider value={abilityExpand}>
            <DpsRows
              seg={seg}
              panel={body.panel}
              setDrill={setDrill}
              onOpenCombat={() => onOpenCombat({ scope: 'fight', selection: LIVE_SELECTION })}
            />
          </AbilityExpandProvider>
        </>
      )}
    </DashCard>
  )
}
