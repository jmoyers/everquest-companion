// alertForm — the add/edit dialog's FORM MODEL: the fields it owns, how they are hydrated from
// the def being edited (or from blanks), and how they turn back into an `AlertDef`.
//
// Its own file because AlertDialog.tsx is the RENDERING and this is the state machine behind it;
// the two were one file until JOS-122 gave the hydration rule enough weight to state properly.
//
// HYDRATION ANSWERS AN OPENING, NEVER A PROP IDENTITY (JOS-122). The form is uncontrolled from
// the caller's point of view: it copies `initial` (or the pack preset) into local state once per
// opening, and from then on the user owns every field. The `packs` prop is re-listed from main
// whenever the shared alert store refreshes, and the always-mounted AlertPlayer refreshes that
// store ON WINDOW FOCUS (player.tsx) — so a NEW `packs` array arrives on every alt-tab back into
// the app. While that array was a hydration input, returning to the app reset a half-filled
// dialog to a blank default and destroyed everything the user had typed, which is exactly the
// defect a 0.13.0 user reported. `useAlertForm` therefore remembers which OPENING it is already
// holding and re-hydrates only when THAT changes.
//
// The one thing a later pack list may still do is fill an EMPTY sound choice — the shipped
// default pack self-provisions after startup, so a dialog opened before it finished has no
// selectable sound and a permanently disabled Add button. An empty `soundId` is precisely the
// state the user cannot have authored, so filling it destroys nothing.
//
// Pinned end to end by tests/e2e/alert-dialog-focus.e2e.mts.

import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react'
import type { AlertDef, AlertTrigger, SoundPack } from '@shared/types'
import { normalizeEarlyWarnSec } from '@shared/earlyWarning'
import {
  blankCondition,
  type CombineMode,
  type ConditionDraft,
  conditionFieldKeyErr,
  conditionFieldValErr,
  conditionRawErr,
  draftFromPrimitive,
  primitiveFromDraft
} from './conditionDraft'
import { fallbackPack, firstSoundId } from './SoundPicker'
import { type SpeechForm, speechFieldsFor, useSpeechForm } from './SpeechBlock'
import { type BannerForm, bannerFieldsFor, useBannerForm } from './BannerBlock'
import { DEFAULT_PACK_ID } from './suggestions'

export const DEFAULT_COOLDOWN_MS = 2000

/** Local alias for the def field, so the form and the def can never drift apart. */
export type CooldownScope = NonNullable<AlertDef['cooldownScope']>

function newId(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'alert'
  return `${base}-${Math.random().toString(36).slice(2, 6)}`
}

/** Everything the dialog's form owns; `useAlertForm` hydrates it from `initial`. */
export interface AlertForm {
  name: string
  setName: (v: string) => void
  mode: CombineMode
  changeMode: (next: CombineMode) => void
  conditions: ConditionDraft[]
  setConditions: Dispatch<SetStateAction<ConditionDraft[]>>
  packId: string
  soundId: string
  setSound: (packId: string, soundId: string) => void
  volume: number
  setVolume: (v: number) => void
  cooldownMs: number
  setCooldownMs: (v: number) => void
  /** What the cooldown is measured per — one clock for the alert, or one per mob. */
  cooldownScope: CooldownScope
  setCooldownScope: (v: CooldownScope) => void
  /**
   * How many seconds EARLY this alert fires (JOS-216). 0 is the form's spelling of "off" — the
   * def's own is an absent key, and `defFromForm` does that translation — because the control is a
   * number field and an empty one has to mean something.
   */
  earlyWarnSec: number
  setEarlyWarnSec: (v: number) => void
  /** The Speech block's own sub-form (voice-alerts §4) — see SpeechBlock.tsx. */
  speech: SpeechForm
  /** The Banner block's own sub-form (JOS-378) — see BannerBlock.tsx. Same arrangement as the
   *  speech sub-form beside it: it hydrates on the `open` edge and folds back through its own
   *  `bannerFieldsFor`, so this file never learns what a swatch is. */
  banner: BannerForm
}

/** The setters hydration writes through, passed as ONE object so `hydrateForm` stays a plain fn. */
interface FormSetters {
  setName: (v: string) => void
  setMode: (v: CombineMode) => void
  setConditions: (v: ConditionDraft[]) => void
  setPackId: (v: string) => void
  setSoundId: (v: string) => void
  setVolume: (v: number) => void
  setCooldownMs: (v: number) => void
  setCooldownScope: (v: CooldownScope) => void
  setEarlyWarnSec: (v: number) => void
}

/**
 * Fill the whole form from `initial` (edit) or from blanks + the preset pack (add).
 *
 * `defaultPackId` is the user's default-pack preference (JOS-273): a NEW alert opens on the pack
 * they chose, which is the picker half of "set one and it sticks". An EDIT is untouched by it —
 * the def already says which pack it plays, and a preference must never rewrite an alert the user
 * authored earlier.
 */
function hydrateForm(
  s: FormSetters,
  initial: AlertDef | null,
  packs: SoundPack[],
  defaultPackId?: string
): void {
  if (!initial) {
    const preset = fallbackPack(packs, defaultPackId)
    s.setName('')
    s.setMode('single')
    s.setConditions([blankCondition()])
    s.setPackId(preset?.id ?? defaultPackId ?? DEFAULT_PACK_ID)
    s.setSoundId(firstSoundId(preset))
    s.setVolume(1)
    s.setCooldownMs(DEFAULT_COOLDOWN_MS)
    s.setCooldownScope('alert')
    s.setEarlyWarnSec(0)
    return
  }
  s.setName(initial.name)
  const t = initial.trigger
  if ('conditions' in t) {
    s.setMode(t.type)
    s.setConditions(t.conditions.length ? t.conditions.map(draftFromPrimitive) : [blankCondition()])
  } else {
    s.setMode('single')
    s.setConditions([draftFromPrimitive(t)])
  }
  s.setPackId(initial.sound.packId)
  s.setSoundId(initial.sound.soundId)
  s.setVolume(initial.volume ?? 1)
  s.setCooldownMs(initial.cooldownMs ?? DEFAULT_COOLDOWN_MS)
  s.setCooldownScope(initial.cooldownScope ?? 'alert')
  s.setEarlyWarnSec(initial.earlyWarnSec ?? 0)
}

export function useAlertForm(
  open: boolean,
  initial: AlertDef | null,
  packs: SoundPack[],
  /** The user's default-pack preference (JOS-273) — what a NEW alert opens on. */
  defaultPackId?: string
): AlertForm {
  const [name, setName] = useState('')
  const [mode, setMode] = useState<CombineMode>('single')
  const [conditions, setConditions] = useState<ConditionDraft[]>([blankCondition()])
  const [packId, setPackId] = useState(fallbackPack(packs, defaultPackId)?.id ?? DEFAULT_PACK_ID)
  const [soundId, setSoundId] = useState(firstSoundId(fallbackPack(packs, defaultPackId)))
  const [volume, setVolume] = useState(1)
  const [cooldownMs, setCooldownMs] = useState(DEFAULT_COOLDOWN_MS)
  const [cooldownScope, setCooldownScope] = useState<CooldownScope>('alert')
  const [earlyWarnSec, setEarlyWarnSec] = useState(0)
  // The Speech block hydrates itself on the same `open` edge (its deps are `[open, initial]`,
  // which is why it never carried this bug).
  const speech = useSpeechForm(open, initial)
  // …and so does the banner block, on the same edge and for the same reason.
  const banner = useBannerForm(open, initial)

  /**
   * WHICH OPENING THIS FORM IS ALREADY HOLDING — null while closed, otherwise a cell naming the
   * def it was hydrated from (`{ initial: null }` for an add). It exists because "the dialog
   * opened" and "a prop changed identity" are two different questions, and answering the second
   * with the first is the whole of JOS-122.
   */
  const opened = useRef<{ initial: AlertDef | null } | null>(null)

  useEffect(() => {
    if (!open) {
      opened.current = null
      return
    }
    // A NEW OPENING (or a different def): hydrate everything, from `initial` or from blanks.
    if (opened.current?.initial !== initial) {
      opened.current = { initial }
      const setters = {
        setName,
        setMode,
        setConditions,
        setPackId,
        setSoundId,
        setVolume,
        setCooldownMs,
        setCooldownScope,
        setEarlyWarnSec
      }
      hydrateForm(setters, initial, packs, defaultPackId)
      return
    }
    // SAME OPENING, and only the pack list moved under us. Re-hydrating here is the bug; the
    // only honest response is to fill a sound the user could not yet have chosen (see header).
    if (soundId) return
    const preset = fallbackPack(packs, defaultPackId)
    if (!preset) return
    setPackId(preset.id)
    setSoundId(firstSoundId(preset))
  }, [open, initial, packs, soundId, defaultPackId])

  // Switching INTO a composite from single keeps the existing condition and adds a second so
  // the OR/AND is meaningful; switching back to single collapses to the first condition.
  const changeMode = (next: CombineMode): void => {
    setMode(next)
    if (next === 'single') setConditions((prev) => prev.slice(0, 1))
    else setConditions((prev) => (prev.length >= 2 ? prev : [...prev, blankCondition()]))
  }

  const setSound = (p: string, s: string): void => {
    setPackId(p)
    setSoundId(s)
  }

  return {
    name,
    setName,
    mode,
    changeMode,
    conditions,
    setConditions,
    packId,
    soundId,
    setSound,
    volume,
    setVolume,
    cooldownMs,
    setCooldownMs,
    cooldownScope,
    setCooldownScope,
    earlyWarnSec,
    setEarlyWarnSec,
    speech,
    banner
  }
}

/** The def's early-warning key, or nothing at all when the form says off (JOS-216). */
function earlyWarnFields(sec: number): { earlyWarnSec?: number } {
  const normalized = normalizeEarlyWarnSec(sec)
  return normalized === undefined ? {} : { earlyWarnSec: normalized }
}

export function triggerFromForm(mode: CombineMode, conditions: ConditionDraft[]): AlertTrigger {
  if (mode === 'single') return primitiveFromDraft(conditions[0])
  return { type: mode, conditions: conditions.map(primitiveFromDraft) }
}

export function formCanSave(f: AlertForm): boolean {
  // `conditionFieldKeyErr` is the third of these for a reason of its own (JOS-348): the other two
  // say a pattern will not COMPILE, this one says a value the user typed has nowhere to be stored
  // and would be dropped by `primitiveFromDraft`. An unsaveable form is the only spelling of "we
  // are not going to quietly lose this" the dialog has.
  const conditionsValid = f.conditions.every(
    (c) =>
      conditionRawErr(c) == null && conditionFieldValErr(c) == null && conditionFieldKeyErr(c) == null
  )
  return (
    f.name.trim().length > 0 &&
    f.conditions.length > 0 &&
    conditionsValid &&
    f.packId.length > 0 &&
    f.soundId.length > 0
  )
}

export function defFromForm(f: AlertForm, initial: AlertDef | null): AlertDef {
  // Built ONCE and shared with the banner fields below: since JOS-380 the on-screen switch's
  // default depends on the trigger, so the two must be looking at the same one.
  const trigger = triggerFromForm(f.mode, f.conditions)
  return {
    // Preserve id + note on edit (stable ids for built-ins); mint on add.
    id: initial?.id ?? newId(f.name),
    name: f.name.trim(),
    enabled: initial?.enabled ?? true,
    trigger,
    sound: { packId: f.packId, soundId: f.soundId },
    volume: f.volume,
    cooldownMs: f.cooldownMs,
    // Omitted at its default, like the speech fields below: a def that never asked for per-mob
    // scope saves byte-identically to how it always did, so import dedupe keeps matching it.
    ...(f.cooldownScope === 'target' ? { cooldownScope: 'target' as const } : {}),
    // Likewise omitted when off (JOS-216): `normalizeEarlyWarnSec` turns 0, a blank field and an
    // out-of-range number into undefined, and an absent key is what "fire when it lands" has always
    // been — so an alert without a warning still saves the bytes it always did.
    ...earlyWarnFields(f.earlyWarnSec),
    note: initial?.note,
    // audio / speech / alwaysPlay, each omitted at its default so a sound-only alert saves
    // byte-identically to how it always did (SpeechBlock.speechFieldsFor).
    ...speechFieldsFor(f.speech),
    // showOnScreen / bannerText / bannerColor, on exactly the same terms (BannerBlock.
    // bannerFieldsFor): every one of them is written only when it is not the default, so an alert
    // that never touched the banner saves the bytes it always did.
    ...bannerFieldsFor(f.banner, trigger)
  }
}
