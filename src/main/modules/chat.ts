// chat module — the in-app chat log. Folds the `chat` event (parseChat.ts) into an append-only
// history the viewer hydrates and rides deltas on, exactly like `loot`: a delta carries the rows
// appended since the last flush and the renderer concats them.
//
// It is the LIVE VIEW half of the feature; the DURABLE half is chatArchive.ts, a separate bus sink
// that writes live lines to disk. They are split for the same reason loot's history and the loot
// FILE would be: this module's history is rebuilt from the log on every launch (the log IS its
// store, so a snapshot always carries the whole thing), while the archive exists precisely to
// outlive the log the game rotates. This module writes nothing to disk.
//
// EPOCH. Chat before the character-rebirth boundary belongs to a dead same-name character; clear
// the history on `epoch` so the viewer shows only the current character's, matching every other
// character-scoped module (see loot.ts).
//
// PRIVACY. `text` is a person's words; this module keeps it in memory and hands it to the renderer
// over `module:delta` (the user's own window) and NOWHERE else. See the ChatEvent header.
//
// ponytail: history is uncapped, like loot's. A months-long log yields a few tens of thousands of
// chat rows — fine in memory. If a whale's log ever makes this heavy, cap it here (keep the last N,
// drop from the front) — the viewer already treats the snapshot as "what there is", not "all there
// ever was".

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import type { ChatDelta, ChatLine, ChatSnap } from '../../shared/types'

export class ChatModule implements EqModule<ChatSnap, ChatDelta> {
  readonly id = 'chat'
  private lines: ChatLine[] = []
  private seq = 0
  private pending: ChatLine[] = []

  reset(): void {
    this.lines = []
    this.seq = 0
    this.pending = []
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    if (ev.kind === 'epoch') {
      this.lines = []
      this.pending = []
      return
    }
    if (ev.kind !== 'chat') return
    const row: ChatLine = {
      ts: ev.ts,
      channel: ev.channel,
      from: ev.from,
      self: ev.self,
      to: ev.to,
      chan: ev.chan,
      text: ev.text
    }
    this.lines.push(row)
    this.pending.push(row)
  }

  snapshot(): { seq: number; state: ChatSnap } {
    return { seq: this.seq, state: this.lines }
  }

  flushDelta(): { seq: number; delta: ChatDelta } | null {
    if (this.pending.length === 0) return null
    const delta: ChatDelta = { appended: this.pending }
    this.pending = []
    return { seq: this.seq, delta }
  }
}
