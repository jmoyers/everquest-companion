// ============================================================================
// chatArchive.ts — the DURABLE half of chat capture: live chat, appended to a file.
// ============================================================================
//
// The `chat` module (src/main/modules/chat.ts) is the live VIEW; it is rebuilt from the log every
// launch and writes nothing. This is the SAVE: a bus sink that appends each LIVE chat line to
// `<userData>/chat/<name_server>.jsonl`, one JSON object per line, so the capture outlives the log
// the game eventually rotates or the user deletes.
//
// LIVE ONLY, on purpose. It ignores replayed (`live:false`) events, so a relaunch does not re-dump
// the history the scan folds — the log already holds that, and re-appending it every launch would
// grow the file without bound and duplicate every line. The archive therefore accumulates
// FORWARD from the moment the feature first runs; it is not a backfill of old logs. (A user who
// wants the existing history exported already has it: it is the game's own log file.)
//
// PRIVACY. This is one of exactly two consumers of `text` (the other is the in-app module), and it
// writes ONLY to the user's own userData dir — never the network. The feedback slice and the
// public fixtures never see a `chat` event; they scrub RAW log lines (shared/logScrub.ts). See the
// ChatEvent header for the whole invariant. Do not add a path that uploads this file.
//
// The switch (`getChatCapture`, default ON) is read per line, so toggling it in Preferences takes
// effect on the next chat line with no relaunch. Cheap: one in-memory electron-store read.

import { createWriteStream, mkdirSync, type WriteStream } from 'fs'
import { join } from 'path'
import { USER_DATA } from './channel'
import { characterId } from './log/config'
import { logConsoleError, logInfo } from './errorLog'
import { getChatCapture } from './storeChatCapture'
import type { LogEvent } from '../shared/logEvents'
import type { ChatLine } from '../shared/types'
import type { CharacterRef } from '../shared/types'

/** `<userData>/chat` — created lazily on the first write. */
function chatDir(): string {
  return join(USER_DATA, 'chat')
}

export class ChatArchive {
  /** The character whose file we are appending to, or null (idle / no character). */
  private id: string | null = null
  /** The open append stream for `id`, or null until the first line for this character. */
  private stream: WriteStream | null = null
  private dirReady = false

  /**
   * Point the archive at a character (or null on idle / no-logs). Closes the previous character's
   * file; the next line for the new one opens theirs. Called from session.ts on every world reset,
   * beside the `installCharacterName` / roster-self-name injections it belongs with.
   */
  setCharacter(ref: CharacterRef | null): void {
    const next = ref ? characterId(ref) : null
    if (next === this.id) return
    this.close()
    this.id = next
  }

  /** Bus subscriber. Only LIVE `chat` events, only when the switch is on and a character is set. */
  onEvent(ev: LogEvent, live: boolean): void {
    if (!live || ev.kind !== 'chat') return
    if (this.id === null) return
    if (!getChatCapture()) return
    const row: ChatLine = {
      ts: ev.ts,
      channel: ev.channel,
      from: ev.from,
      self: ev.self,
      ...(ev.to !== undefined ? { to: ev.to } : {}),
      ...(ev.chan !== undefined ? { chan: ev.chan } : {}),
      text: ev.text
    }
    this.write(row)
  }

  private write(row: ChatLine): void {
    const s = this.ensureStream()
    if (!s) return
    s.write(JSON.stringify(row) + '\n')
  }

  /** Open (once) the append stream for the current character. Null if there is no character or the
   *  open failed — a failed archive must never take down the tail, so every error is logged and
   *  swallowed. */
  private ensureStream(): WriteStream | null {
    if (this.stream) return this.stream
    if (this.id === null) return null
    try {
      if (!this.dirReady) {
        mkdirSync(chatDir(), { recursive: true })
        this.dirReady = true
      }
      const path = join(chatDir(), `${this.id}.jsonl`)
      const s = createWriteStream(path, { flags: 'a' })
      s.on('error', (err) => logConsoleError('[everquest-companion] chat archive write error', err))
      this.stream = s
      logInfo(`[everquest-companion] Chat archive: appending to ${path}`)
      return s
    } catch (err) {
      logConsoleError('[everquest-companion] chat archive open error', err)
      return null
    }
  }

  private close(): void {
    if (this.stream) {
      this.stream.end()
      this.stream = null
    }
  }
}
