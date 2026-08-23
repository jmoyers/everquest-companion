// IPC: the chat-capture switch (storeChatCapture.ts) — does the Chat viewer also SAVE to a file.
//
// Two channels, no session side effect and none needed. chatArchive.ts reads `getChatCapture()`
// per line, so a flip here is seen by the very next chat line with no relaunch and nothing to
// apply — unlike uiScale (which must repaint the window) this handler only stores. The value is a
// plain boolean coerced at the handler, on the `sounds:getData` rule: today's only caller is the
// app's own toggle, but a renderer must not be able to store a non-boolean.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { getChatCapture, setChatCapture } from '../storeChatCapture'

export function registerChatIpc(): void {
  ipcMain.handle(IPC.chatCaptureGet, () => getChatCapture())
  ipcMain.handle(IPC.chatCaptureSet, (_e, value: unknown) => setChatCapture(value === true))
}
