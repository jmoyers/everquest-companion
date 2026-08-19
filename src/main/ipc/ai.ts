import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import {
  AI_HISTORY_CAP,
  type AiChatTurn,
  type AiConfigPayload,
  type AiPromptResult,
  type AiStreamChunk,
  type AiUsageSnap
} from '../../shared/aiChat'
import { AI_PROACTIVE_PARKED, aiHelpText } from '../../shared/aiSlash'
import { aiModelBarLabel, resolveAiModel } from '../../shared/aiModels'
import type { AlertDef, AlertTrigger } from '../../shared/alertTypes'
import { IPC } from '../../shared/ipc'
import { EQL_LORE } from '../data/eqlLore'
import { getOpenRouterClient } from '../ai/AIClientFactory'
import { getLiveStatus } from '../ai/aiPlayerState'
import { startAiProactive } from '../ai/aiProactiveHost'
import { decryptString, encryptString } from '../ai/SecureStorage'
import { aiContext } from '../pipeline'
import { saveAlert, settingsStore } from '../store'
import { getMainWindow, getOverlayWindow } from '../windows'

function parseHistory(raw: unknown): AiChatTurn[] {
  if (!Array.isArray(raw)) return []
  const out: AiChatTurn[] = []
  for (const row of raw.slice(-AI_HISTORY_CAP)) {
    if (!row || typeof row !== 'object') continue
    const rec = row as { role?: unknown; text?: unknown }
    if (rec.role !== 'user' && rec.role !== 'assistant') continue
    if (typeof rec.text !== 'string' || rec.text.length === 0) continue
    out.push({ role: rec.role, text: rec.text })
  }
  return out
}

function isTrigger(v: unknown): v is AlertTrigger {
  if (!v || typeof v !== 'object') return false
  const t = v as { type?: unknown }
  return t.type === 'event' || t.type === 'raw' || t.type === 'app' || t.type === 'any' || t.type === 'all'
}

function parseDraft(raw: unknown): AlertDef | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Partial<AlertDef>
  if (typeof rec.id !== 'string' || typeof rec.name !== 'string') return null
  if (!isTrigger(rec.trigger)) return null
  if (!rec.sound || typeof rec.sound.packId !== 'string' || typeof rec.sound.soundId !== 'string') {
    return null
  }
  return rec as AlertDef
}

function systemPrompt(style: string | undefined, recap: string[]): string {
  const recapBlock = recap.length > 0 ? recap.join('\n') : '(no recent combat or zone lines in the last 5 minutes)'
  const styleBlock = style?.trim() ? `\nUser's personal instructions:\n${style.trim()}\n` : ''
  return `${EQL_LORE}
${styleBlock}
Recent recap (parsed events, newest last):
${recapBlock}

Use tools for facts: get_output (honour empty and stale), get_fight, get_zone, get_buffs, get_recent_loot, get_loadout, get_aa, search_*. Do not invent bags, fights, or buffs.`
}

export function registerAiIpc(): void {
  ipcMain.handle(IPC.aiConfigGet, () => {
    const config = settingsStore.get('aiConfig')
    if (!config) return { authType: 'apikey', consent: false, model: resolveAiModel(undefined) }
    let apiKey = ''
    if (config.apiKey) apiKey = decryptString(config.apiKey) ?? ''
    return {
      authType: 'apikey',
      apiKey,
      consent: config.consent,
      model: resolveAiModel(config.model),
      personalStyle: config.personalStyle,
      proactive: config.proactive === true
    }
  })

  ipcMain.handle(IPC.aiConfigSet, (_e, payload: AiConfigPayload) => {
    const prev = settingsStore.get('aiConfig')
    const apiKey = payload?.apiKey ?? ''
    const encryptedKey = apiKey ? encryptString(apiKey) : undefined
    settingsStore.set('aiConfig', {
      authType: 'apikey',
      apiKey: encryptedKey,
      consent: payload?.consent ?? false,
      model: resolveAiModel(payload?.model),
      personalStyle: payload?.personalStyle,
      proactive: payload?.proactive ?? prev?.proactive
    })
    const modelLabel = aiModelBarLabel(resolveAiModel(payload?.model))
    pushUsage({ spendUsd: lastSpendUsd, modelLabel })
    void handleUsageGet().then(pushUsage)
  })

  ipcMain.handle(IPC.aiContextGet, () => aiContext.getRecap())

  ipcMain.handle(IPC.aiStatusGet, () => getLiveStatus())

  ipcMain.handle(IPC.aiUsageGet, handleUsageGet)

  ipcMain.handle(IPC.aiSaveDraftAlert, (_e, raw: unknown) => {
    const def = parseDraft(raw)
    if (!def) throw new Error('Invalid alert draft.')
    saveAlert(def)
    return { ok: true, id: def.id }
  })

  ipcMain.handle(IPC.aiSendPrompt, handleSendPrompt)
  startAiProactive()
}

let lastSpendUsd: number | null = null

function sendUsage(wc: WebContents | undefined, snap: AiUsageSnap): void {
  if (!wc || wc.isDestroyed()) return
  wc.send(IPC.aiUsage, snap)
}

function pushUsage(snap: AiUsageSnap): void {
  lastSpendUsd = snap.spendUsd
  sendUsage(getMainWindow()?.webContents, snap)
  const overlay = getOverlayWindow('ai')
  sendUsage(overlay && !overlay.isDestroyed() ? overlay.webContents : undefined, snap)
}

async function handleUsageGet(): Promise<AiUsageSnap> {
  const config = settingsStore.get('aiConfig')
  const modelLabel = aiModelBarLabel(resolveAiModel(config?.model))
  const apiKey = config?.apiKey ? decryptString(config.apiKey) : ''
  if (!apiKey) return { spendUsd: null, modelLabel }
  const spendUsd = await getOpenRouterClient(apiKey).getUsageUsd()
  return { spendUsd, modelLabel }
}

function sendChunk(wc: WebContents | undefined, seen: Set<number>, payload: AiStreamChunk): void {
  if (!wc || wc.isDestroyed() || seen.has(wc.id)) return
  seen.add(wc.id)
  wc.send(IPC.aiChunk, payload)
}

function emitAiChunk(
  sender: IpcMainInvokeEvent['sender'],
  requestId: string,
  chunk: Omit<AiStreamChunk, 'requestId'>
): void {
  const payload: AiStreamChunk = { requestId, ...chunk }
  const seen = new Set<number>()
  sendChunk(sender, seen, payload)
  sendChunk(getMainWindow()?.webContents, seen, payload)
  const overlay = getOverlayWindow('ai')
  sendChunk(overlay && !overlay.isDestroyed() ? overlay.webContents : undefined, seen, payload)
}

async function handleSendPrompt(
  event: IpcMainInvokeEvent,
  prompt: unknown,
  historyRaw: unknown
): Promise<AiPromptResult> {
  const text = typeof prompt === 'string' ? prompt : ''
  const cmd = text.trim().toLowerCase()
  if (cmd === '/help') return { text: aiHelpText(), drafts: [] }
  if (cmd === '/proactive' || cmd === '/proactive on' || cmd === '/proactive off') {
    return { text: AI_PROACTIVE_PARKED, drafts: [] }
  }
  const config = settingsStore.get('aiConfig')
  if (!config || !config.consent || !config.apiKey) {
    throw new Error('AI Assistant is not configured or consent is missing.')
  }
  const apiKey = decryptString(config.apiKey)
  if (!apiKey) throw new Error('OpenRouter API key is missing.')
  const client = getOpenRouterClient(apiKey)
  if (text.trim() === '/model') {
    const id = resolveAiModel(config.model)
    return { text: `Current model: **${aiModelBarLabel(id)}** (\`${id}\`).`, drafts: [] }
  }
  if (text.trim() === '/usage') {
    return { text: await client.getUsage(), drafts: [] }
  }
  const requestId = randomUUID()
  const result = await client.sendPrompt(systemPrompt(config.personalStyle, aiContext.getRecap()), text, {
    model: config.model,
    history: parseHistory(historyRaw),
    onChunk: (chunk) => emitAiChunk(event.sender, requestId, chunk)
  })
  void handleUsageGet().then(pushUsage)
  return result
}
