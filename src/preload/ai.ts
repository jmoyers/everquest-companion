import { ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  AiChatTurn,
  AiConfigPayload,
  AiLiveStatus,
  AiPromptResult,
  AiStreamChunk,
  AiUsageSnap
} from '../shared/aiChat'
import type { AlertDef } from '../shared/alertTypes'

export const aiBridge = {
  sendAiPrompt: (prompt: string, history: AiChatTurn[]): Promise<AiPromptResult> =>
    ipcRenderer.invoke(IPC.aiSendPrompt, prompt, history),
  getAiStatus: (): Promise<AiLiveStatus> => ipcRenderer.invoke(IPC.aiStatusGet),
  getAiUsage: (): Promise<AiUsageSnap> => ipcRenderer.invoke(IPC.aiUsageGet),
  onAiUsage: (cb: (u: AiUsageSnap) => void): (() => void) => {
    const listener = (_e: unknown, u: AiUsageSnap): void => cb(u)
    ipcRenderer.on(IPC.aiUsage, listener)
    return () => ipcRenderer.removeListener(IPC.aiUsage, listener)
  },
  onAiProactive: (cb: (text: string) => void): (() => void) => {
    const listener = (_e: unknown, p: { text?: string }): void => {
      if (typeof p?.text === 'string' && p.text.length > 0) cb(p.text)
    }
    ipcRenderer.on(IPC.aiProactive, listener)
    return () => ipcRenderer.removeListener(IPC.aiProactive, listener)
  },
  onAiChunk: (cb: (c: AiStreamChunk) => void): (() => void) => {
    const listener = (_e: unknown, c: AiStreamChunk): void => cb(c)
    ipcRenderer.on(IPC.aiChunk, listener)
    return () => ipcRenderer.removeListener(IPC.aiChunk, listener)
  },
  getAiConfig: (): Promise<{
    authType?: 'apikey' | 'subscription'
    apiKey?: string
    consent: boolean
    model?: string
    personalStyle?: string
    proactive?: boolean
  }> => ipcRenderer.invoke(IPC.aiConfigGet),
  setAiConfig: (payload: AiConfigPayload): Promise<void> => ipcRenderer.invoke(IPC.aiConfigSet, payload),
  getAiContext: (): Promise<string[]> => ipcRenderer.invoke(IPC.aiContextGet),
  saveAiDraftAlert: (def: AlertDef): Promise<{ ok: boolean; id: string }> =>
    ipcRenderer.invoke(IPC.aiSaveDraftAlert, def)
}
