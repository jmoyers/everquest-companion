// maps/MapsTabs — the map, or the advice, never both at once.
//
// Owner, minutes after the advice panel landed (2026-09-12): *"do you see how the map is now so
// small in the map tab?"* and *"the worth your time should be maybe a new tab inside maps because
// i don't need that taking up all my space"*. He was right on both counts - two stacked cards had
// pushed the map itself into a strip at the bottom of its own tab.
//
// ── ITS OWN COMPONENT FOR THE COMPLEXITY BAR, NOT FOR REUSE ──────────────────────────────────
//
// `MapsView` sits at the measured complexity ceiling (12) and a tab state plus a branch would put
// it over. Owning the state here keeps the view exactly as it was and gives the tab one place to
// live. It is not a general tabs widget and should not grow into one.
//
// PICKING A ZONE FROM THE ADVICE LIST OPENS THE MAP TAB, because that is what the click means -
// "show me this zone" - and leaving the reader on the list with the map hidden behind it would
// make the click look like it did nothing.

import { useState, type JSX, type ReactNode } from 'react'
import { Tab, Tabs } from '@mui/material'
import MapZoneAdvice from './MapZoneAdvice'

type MapsTab = 'map' | 'advice'

export default function MapsTabs({
  onPick,
  children
}: {
  /** open a zone's map by stem — the view's own `pick` */
  onPick: (zone: string) => void
  /** the map tab's contents: the toolbar, the travel card and the map body */
  children: ReactNode
}): JSX.Element {
  const [tab, setTab] = useState<MapsTab>('map')
  return (
    <>
      <Tabs
        value={tab}
        onChange={(_e, v: MapsTab) => {
          setTab(v)
        }}
        sx={{ minHeight: 32, '& .MuiTab-root': { minHeight: 32, py: 0.5 } }}
      >
        <Tab value="map" label="Map" data-testid="maps-tab-map" />
        <Tab value="advice" label="Where to level" data-testid="maps-tab-advice" />
      </Tabs>
      {tab === 'advice' ? (
        <MapZoneAdvice
          onPick={(zone) => {
            onPick(zone)
            setTab('map')
          }}
        />
      ) : (
        children
      )}
    </>
  )
}
