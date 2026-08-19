// Electron-free pins for the AI overlay. Helpers live in the overlay TSX (Vite `@shared`
// alias), so this file does not import that bundle: it pins the copy, the persist key, and
// the overlay-only bridge (eqOverlay, never window.eq).

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  AI_CHAT_STORAGE_KEY,
  parseAiChat,
  serializeAiChat,
  type AiStoredMessage
} from '../src/shared/aiChat'

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

const THREAD: AiStoredMessage[] = [
  { role: 'user', text: 'Where does Fungi Tunic drop?' },
  { role: 'ai', text: 'It drops in Upper Guk.' },
  { role: 'user', text: 'And the cloak?' }
]

test('the shared persist key round-trips the overlay thread', () => {
  assert.equal(AI_CHAT_STORAGE_KEY, 'eq.ai.messages')
  assert.deepEqual(parseAiChat(serializeAiChat(THREAD)), THREAD)
})

test('empty copy is one sentence, a normal dash, and never names Nexus', () => {
  const overlay = src('../src/renderer/src/overlay/AiOverlay.tsx')
  const empty = overlay.match(/AI_OVERLAY_EMPTY = '([^']+)'/)?.[1] ?? ''
  assert.equal(empty, 'Ask about an item, spell, or this fight.')
  assert.doesNotMatch(empty, /\u2013|\u2014/)
  assert.doesNotMatch(overlay, /Nexus/)
  assert.doesNotMatch(overlay, /@mui\//)
  const md = src('../src/renderer/src/overlay/AiOverlayMarkdown.tsx')
  assert.match(md, /ReactMarkdown/)
  assert.doesNotMatch(md, /@mui\//)
  const thread = src('../src/renderer/src/overlay/aiOverlayThread.ts')
  assert.match(thread, /export function lastAiAnswer/)
  assert.match(thread, /export function historyFrom/)
  assert.match(thread, /export function foldAiChunk/)
  assert.match(thread, /export function foldToolHint/)
  assert.match(overlay, /export \{ lastAiAnswer/)
  const composer = src('../src/renderer/src/overlay/AiOverlayComposer.tsx')
  assert.match(composer, /aiChatComposerPlaceholder/)
  assert.doesNotMatch(composer, /@mui\//)
  assert.match(overlay, /aiChatPhaseColor/)
  assert.doesNotMatch(overlay, /Looking it up/)
  assert.doesNotMatch(overlay, /ai-status-strip/)
  assert.doesNotMatch(overlay, /AIDumpCoach/)
})

test('the overlay bundle mounts kind ai and talks through eqOverlay, not window.eq', () => {
  const main = src('../src/renderer/src/overlay/main.tsx')
  assert.match(main, /if \(kind === 'ai'\) return <AiOverlay \/>/)
  const overlay = src('../src/renderer/src/overlay/AiOverlay.tsx')
  const thread = src('../src/renderer/src/overlay/aiOverlayThread.ts')
  const session = src('../src/renderer/src/overlay/useAiOverlaySession.ts')
  assert.match(thread, /window\.eqOverlay\.sendAiPrompt/)
  assert.match(session, /window\.eqOverlay\.onAiChunk/)
  assert.match(thread, /AI_CHAT_STORAGE_KEY/)
  assert.doesNotMatch(overlay, /window\.eq\./)
  assert.doesNotMatch(thread, /window\.eq\./)
  assert.doesNotMatch(session, /window\.eq\./)
  const preload = src('../src/preload/overlay.ts')
  assert.match(preload, /sendAiPrompt:/)
  assert.match(preload, /getAiStatus:/)
  assert.match(preload, /onAiChunk:/)
  assert.match(preload, /IPC\.aiSendPrompt/)
  assert.match(preload, /IPC\.aiStatusGet/)
  assert.match(preload, /IPC\.aiChunk/)
  assert.match(preload, /getAiUsage/)
  assert.match(preload, /onAiUsage/)
})

test('main broadcasts stream chunks to the AI overlay, not only the sender', () => {
  const ipc = src('../src/main/ipc/ai.ts')
  assert.match(ipc, /getOverlayWindow\('ai'\)/)
  assert.match(ipc, /getMainWindow\(\)/)
})

test('the chat tab never says Looking it up', () => {
  const chat = src('../src/renderer/src/features/aiAssistant/AIAssistantChat.tsx')
  assert.doesNotMatch(chat, /Looking it up/)
  assert.match(chat, /ai-ask-again/)
})

test('proactive tips persist from App, not only the AI tab', () => {
  const app = src('../src/renderer/src/App.tsx')
  assert.match(app, /useAiProactiveInbox/)
  const tab = src('../src/renderer/src/features/aiAssistant/AIAssistantTab.tsx')
  assert.doesNotMatch(tab, /onAiProactive/)
})

test('Preferences does not offer the parked proactive checkbox', () => {
  const prefs = src('../src/renderer/src/features/preferences/AiAssistantSetting.tsx')
  assert.doesNotMatch(prefs, /ai-proactive-checkbox/)
  const host = src('../src/main/ai/aiProactiveHost.ts')
  assert.match(host, /AI_PROACTIVE_SHIPPED/)
})
