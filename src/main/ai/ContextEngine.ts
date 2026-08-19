import type { LogEvent, OutputFileEvent } from '../../shared/logEvents'
import type { EqModule } from '../modules/types'
import { join } from 'path'
import { promises as fs } from 'fs'
import { AI_RECAP_CAP, formatRecap, retainRecap } from './aiRecap'

/**
 * ContextEngine maintains the rolling memory of the player's session so the AI
 * has perfect tactical context when asked a question.
 */
export class ContextEngine implements EqModule<LogEvent[], null> {
  public id = 'aiContext'
  private events: LogEvent[] = []
  private readonly WINDOW_MS = 5 * 60 * 1000
  private seq = 0

  private latestInventory = ''
  private latestSpellbook = ''
  private latestFactions = ''
  private latestGuild = ''
  private latestRaid = ''
  private latestAchievements = ''

  public reset(): void {
    this.events = []
    this.seq = 0
    this.latestInventory = ''
    this.latestSpellbook = ''
    this.latestFactions = ''
    this.latestGuild = ''
    this.latestRaid = ''
    this.latestAchievements = ''
  }

  /**
   * Pushes a new log event into the context window.
   * Culls events older than the 5-minute rolling window.
   */
  public onEvent(event: LogEvent, live: boolean): void {
    this.seq = event.seq

    if (event.kind === 'outputFile' && live) {
      void this.ingestExportAsync(event)
      return
    }

    this.events = retainRecap(this.events, event, this.WINDOW_MS, AI_RECAP_CAP)
  }

  private async ingestExportAsync(ev: OutputFileEvent): Promise<void> {
    // Lazy: config/store/channel pull Electron. A fold replay never ingests (live:false).
    const { effectiveEqRoot } = await import('../log/config')
    const { logError } = await import('../errorLog')
    try {
      const content = await fs.readFile(join(effectiveEqRoot(), ev.file), 'utf8')
      this.storeDump(ev.file, content)
    } catch (err: unknown) {
      logError('main:aiContext', `Failed to ingest export ${ev.file}: ${String(err)}`)
    }
  }

  private storeDump(file: string, content: string): void {
    const lower = file.toLowerCase()
    if (lower.includes('inventory')) this.latestInventory = content
    else if (lower.includes('spellbook')) this.latestSpellbook = content
    else if (lower.includes('faction')) this.latestFactions = content
    else if (lower.includes('guild')) this.latestGuild = content
    else if (lower.includes('raid')) this.latestRaid = content
    else if (lower.includes('achievements')) this.latestAchievements = content
  }

  public getExports(): Record<string, string> {
    return {
      inventory: this.latestInventory,
      spellbook: this.latestSpellbook,
      factions: this.latestFactions,
      guild: this.latestGuild,
      raid: this.latestRaid,
      achievements: this.latestAchievements
    }
  }

  public snapshot(): { seq: number; state: LogEvent[] } {
    return { seq: this.seq, state: this.events }
  }

  public flushDelta(): { seq: number; delta: null } | null {
    return null
  }

  public getContext(): LogEvent[] {
    return this.events
  }

  public getRecap(): string[] {
    return formatRecap(this.events)
  }
}

