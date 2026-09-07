// useSelfMeterName.ts — the storage half of "show my character name in the meter".
//
// One live view of `eq.combat.selfMeterName` for every reader in every window of this origin: the
// Combat tab, the Overview card, the floating overlay meters, and the Preferences toggle that
// writes it. Over `useBoolPref` — the same `useSyncExternalStore` + cross-window `storage` event
// the pet-nesting and meter-scope prefs use, so a flip in Preferences reaches all of them with no
// IPC.

import { useBoolPref } from './useCombatPrefs'
import { SELF_METER_NAME_KEY } from './selfMeterLabel'

/** Read-only: is the self meter row shown as the character's name? Default false ("You"). */
export function useShowSelfName(): boolean {
  return useBoolPref(SELF_METER_NAME_KEY, false)[0]
}

/** Read + write — for the Preferences card. */
export function useSelfMeterNameToggle(): [boolean, (v: boolean) => void] {
  return useBoolPref(SELF_METER_NAME_KEY, false)
}
