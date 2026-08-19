import { getDefaultSoundPackId } from '../storeSoundPacks'
import { searchItems, searchMobs, searchSpells } from './aiKnowledge'
import { draftAlert, type DraftAlertArgs } from './aiDraftAlert'
import {
  getAaSummary,
  getBuffsSummary,
  getFightSummary,
  getLoadoutSummary,
  getOutputDump,
  getRecentLoot,
  getZoneSummary
} from './aiPlayerState'

export { AI_TOOLS, type AITool } from './aiToolDefs'

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function draftArgs(args: Record<string, unknown>): DraftAlertArgs {
  return {
    name: asString(args.name),
    spell: asString(args.spell) || undefined,
    eventKind: asString(args.eventKind) || undefined,
    triggerRegex: asString(args.triggerRegex) || undefined,
    speechText: asString(args.speechText) || undefined,
    note: asString(args.note) || undefined
  }
}

function notFound(kind: string, query: string): string {
  return JSON.stringify({ hits: [], message: `No ${kind} named ${JSON.stringify(query)} in the local database.` })
}

function searchJson(kind: string, query: string, hits: unknown[]): string {
  if (hits.length === 0) return notFound(kind, query)
  return JSON.stringify({ hits })
}

function runDraft(args: Record<string, unknown>): string {
  const draft = draftAlert(draftArgs(args), getDefaultSoundPackId())
  if ('error' in draft) return JSON.stringify(draft)
  return JSON.stringify({
    status: 'draft',
    alert: draft,
    message: 'Not saved. The user must confirm the card in the chat.'
  })
}

const HANDLERS: Record<string, (args: Record<string, unknown>) => string> = {
  search_items: (args) => searchJson('item', asString(args.query), searchItems(asString(args.query))),
  search_spells: (args) => searchJson('spell', asString(args.query), searchSpells(asString(args.query))),
  search_mobs: (args) => searchJson('mob', asString(args.query), searchMobs(asString(args.query))),
  get_output: (args) => JSON.stringify(getOutputDump(asString(args.kind))),
  get_loadout: () => JSON.stringify(getLoadoutSummary()),
  get_aa: () => JSON.stringify(getAaSummary()),
  get_fight: () => JSON.stringify(getFightSummary()),
  get_zone: () => JSON.stringify(getZoneSummary()),
  get_buffs: () => JSON.stringify(getBuffsSummary()),
  get_recent_loot: () => JSON.stringify(getRecentLoot()),
  draft_alert: runDraft
}

export function executeToolCall(name: string, args: Record<string, unknown>): string {
  try {
    const run = HANDLERS[name]
    return run ? run(args) : JSON.stringify({ error: `Unknown tool: ${name}` })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `Error executing ${name}: ${message}` })
  }
}
