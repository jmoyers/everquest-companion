/**
 * THE CONTENT COLUMN: everything to the right of the nav drawer, in the three pieces it has.
 *
 * SPLIT OUT OF App.tsx (JOS-503) at the measured 400-code-line file ceiling, where the house rule
 * is to split rather than to ratchet. Its own doc already made half the argument — "a component
 * rather than two nested boxes in App for the reason `BottomStrips` is one … this is a
 * self-contained piece of shell" — and gaining a third band is what made the file want it out.
 * Nothing about it changed in the move.
 *
 * `app-content` is the app's ONE scroller between a view and the window — every feature view sizes
 * itself with `height: 100%` against it, and a long list clips inside its own box rather than
 * growing the page (the Task-#56 law, measured by `pageOverflow` in half the e2e suite).
 *
 * ABOVE it, and deliberately OUTSIDE it, sits the gear area's tab bar (JOS-324): four views behind
 * one nav row need a header, and a header inside the scroller would both slide away under a long
 * table and silently eat the height that every `height: 100%` is measured against — turning that
 * page-overflow assertion red across four unrelated specs. Out here it is a fixed band and the
 * scroll box simply flexes into what is left. Its clicks go through `selectView`, the same MANUAL
 * navigator the nav rows use, so the Back stack reads a tab switch as exactly what it is.
 *
 * AND ABOVE BOTH OF THEM, THE ENGINE'S LAUNCH BANNER (JOS-503) — the catch-up bar while the fold is
 * running, and the failure card when the engine will not start at all. It sits here for the gear
 * tabs' own reason, one step stronger: it is a fixed band, so inside the scroller it would slide
 * away under a long table and eat the height every `height: 100%` is measured against. In the
 * COLUMN rather than full-width under the title bar because the nav drawer is the one thing that
 * must stay whole while the app cannot answer — Preferences and "Send feedback" live in it — and
 * because both states are statements about the CONTENT area, which is the part that is empty. It
 * renders nothing at all in every phase but those two, so it costs no layout for the rest of a
 * session.
 */

import type { JSX } from 'react'
import { Box } from '@mui/material'
import GearAreaTabs from './GearAreaTabs'
import { EngineLaunchBanner } from './EngineLaunchBanner'
import { isGearAreaView, type View } from '../appViews'
// THE PER-VIEW COMMIT COUNTER (JOS-513). Dev-only; the gate below is spelled inline because that
// is the form vite folds at transform time — see lib/renderMeter.tsx's header for the measurement.
import { RenderProfiler } from '../lib/renderMeter'

export default function MainColumn({
  view,
  onSelect,
  onReport,
  children
}: {
  view: View
  onSelect: (v: View) => void
  /** `useFeedbackDialog().openFeedback`, for the failure card's "Report this". */
  onReport: (prefill: { readonly type: 'bug'; readonly description: string }) => void
  children: JSX.Element
}): JSX.Element {
  return (
    <Box
      component="main"
      sx={{ flexGrow: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
    >
      <EngineLaunchBanner onReport={onReport} />
      {isGearAreaView(view) && <GearAreaTabs view={view} onSelect={onSelect} />}
      <Box data-testid="app-content" sx={{ flexGrow: 1, overflow: 'auto', p: 2 }}>
        {/* THE VIEWCONTENT SEAM (JOS-513). `children` IS `App`'s `ViewContent`, so this is that
            seam measured from one component up — which is what lets the render meter mount without
            touching App.tsx at all. The id is the mounted view, so the panel's per-surface row is
            named `overview` / `combat` / … in the app's own vocabulary. It counts the SCROLLER's
            contents only: the launch banner and the gear tabs above are fixed bands and belong to
            the app-wide row, not to the view's. */}
        {import.meta.env.DEV ? <RenderProfiler id={view}>{children}</RenderProfiler> : children}
      </Box>
    </Box>
  )
}
