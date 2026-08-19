// Build an AlertDef the model proposed. Does NOT write the store.

import { randomUUID } from 'crypto'
import type { AlertDef, AlertTrigger, LogEventKind } from '../../shared/alertTypes'
import { DEFAULT_ALERT_PACK_ID, DEFAULT_ALERT_SOUNDS } from '../data/defaultPacks'

const EVENT_KINDS = new Set<LogEventKind>([
  'buffApply',
  'buffWearOff',
  'buffFade',
  'buffExpired',
  'castBegin',
  'death',
  'zone',
  'loot',
  'resist',
  'cc',
  'uncharm',
  'charm'
])

export interface DraftAlertArgs {
  name: string
  spell?: string
  eventKind?: string
  triggerRegex?: string
  speechText?: string
  note?: string
}

export function defaultDraftSound(packId?: string): AlertDef['sound'] {
  return {
    packId: packId && packId.length > 0 ? packId : DEFAULT_ALERT_PACK_ID,
    soundId: DEFAULT_ALERT_SOUNDS.buffWearsOff
  }
}

function triggerOf(args: DraftAlertArgs): AlertTrigger | null {
  const spell = args.spell?.trim()
  if (spell) {
    return { type: 'event', kind: 'buffApply', where: { spell } }
  }
  const kind = args.eventKind?.trim()
  if (kind && EVENT_KINDS.has(kind as LogEventKind)) {
    return { type: 'event', kind: kind as LogEventKind }
  }
  const regex = args.triggerRegex?.trim()
  if (regex) return { type: 'raw', regex }
  return null
}

export function draftAlert(args: DraftAlertArgs, packId?: string): AlertDef | { error: string } {
  const name = args.name.trim()
  if (!name) return { error: 'name is required' }
  const trigger = triggerOf(args)
  if (!trigger) {
    return { error: 'Provide spell, a known eventKind, or triggerRegex.' }
  }
  const speech = args.speechText?.trim()
  const def: AlertDef = {
    id: randomUUID(),
    name,
    enabled: true,
    trigger,
    sound: defaultDraftSound(packId),
    note: args.note?.trim() ? `Drafted by AI: ${args.note.trim()}` : 'Drafted by AI - not saved until you confirm.'
  }
  if (speech) {
    def.audio = 'speech'
    def.speech = { mode: 'custom', phrase: speech }
  }
  return def
}
