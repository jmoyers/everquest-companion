// spellLink — ONE SEAM, EVERY SPELL NAME (JOS-508).
//
// The drilldown has to be reachable "from everywhere a spell name renders today", and the honest
// reading of that brief is not "edit five files": it is "find the thing all five already share and
// wire it once". That thing is `SpellTooltip` (lib/SpellCard.tsx) — the Buffs card's row, the
// alert wizard's suggestion row, the Best Spells readout, the New-at-this-level row and the
// `replaces …` note inside its prose all wrap their name in it already. So the link lands INSIDE
// the tooltip component and the five anchor files are not touched at all.
//
// WHY A CONTEXT AND NOT A PROP. The opener lives in `appRouting.ts` and the anchors are four and
// five components deep inside AlertsView, BuffsView and LevelingView; threading it down would be a
// prop drill through files this ticket has no business editing, and — worse — it would make
// "does this name link" a per-caller decision, which is exactly how three surfaces end up with
// three answers. A context makes it a property of the APP: if the app published an opener, every
// spell name in the main window is a link; if it did not, every one of them is inert text.
//
// AND "INERT" IS A REAL STATE THIS FILE DESIGNS FOR, not an oversight. The overlay bundle renders
// spell names too and has no router, no `window.eq.lookupSpell` and no MUI; nothing there mounts
// this provider, `useSpellLink()` answers null, and the anchor stays exactly the plain text it is
// today. Same for any future window. The default is OFF and the provider is the only way on.

import { createContext, useContext, type JSX, type ReactNode } from 'react'

/** Open the drilldown for one spell, by the name the surface displays. */
export type OpenSpell = (name: string) => void

const SpellLinkContext = createContext<OpenSpell | null>(null)

/**
 * Publish the app's spell opener to every spell name below it.
 *
 * Mounted once, at the top of the main window's tree. The value is the router's own memoized
 * `openSpell`, so this context does not re-render the world on every tab switch — the same reason
 * `appRouting.ts` memoizes every other opener (its `useNavSeam` header states it in full).
 */
export function SpellLinkProvider({
  open,
  children
}: {
  open: OpenSpell
  children: ReactNode
}): JSX.Element {
  return <SpellLinkContext.Provider value={open}>{children}</SpellLinkContext.Provider>
}

/**
 * The app's spell opener, or null where no app published one.
 *
 * Null is the answer over the game (the overlay bundle) and in any test that renders a spell name
 * without an app around it. A caller that gets null must render its anchor unchanged — never a
 * dead-looking link.
 */
export function useSpellLink(): OpenSpell | null {
  return useContext(SpellLinkContext)
}
