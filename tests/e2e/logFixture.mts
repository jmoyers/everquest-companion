/**
 * logFixture.mts — THE INPUT THE APP UNDER TEST READS, and the driver that scripts live play.
 *
 * WHY (docs/plans/e2e-parallel.md, wave E2 — cause #2). Every spec used to launch the app
 * against the OWNER'S LIVE LOG: 1.4M lines, growing while the suite ran, different on every
 * machine. Three costs, all of them paid on every launch:
 *   • a red spec was ambiguous — "the assertion broke" and "the log went quiet" look identical;
 *   • ~10.8 s of historical replay × 16 launches, re-folding the same months of play;
 *   • the assertions that DEPEND on content had to be floors, or note() branches that assert
 *     nothing at all, because nobody can promise the log holds a fight right now.
 *
 * WHAT THIS IS. A per-launch, throwaway EQ INSTALL — `<tmp>/Logs/eqlog_Primitive_freeport.txt`,
 * seeded from a committed fixture (tests/fixtures/e2e-*.log, cut by tests/extract-e2e-fixtures.mjs)
 * — handed to the app through `EQ_INSTALL_DIR`, which `src/main/log/config.ts` reads FIRST
 * (`envCandidates()`, ahead of the registry and the drive sweep). The app discovers it exactly as
 * it discovers a real install; nothing in the product knows a test is running.
 *
 * The copy is what makes the APPEND DRIVER possible: the harness owns this file, so it can write
 * whole timestamped lines into the very log the app is tailing and watch them arrive through
 * chokidar → Tailer → parser → engine, the same path a real `You crush …` takes. That is what
 * replaced combat-dashboard's 45-second bet on the owner actually playing, and it is why the
 * live-tail assertions can now state EXACT numbers instead of floors.
 *
 * THE MAPS CARVE-OUT. The map viewer reads `<eqRoot>/maps`, and the map packs are a 200 MB game
 * install — not something a public repo can carry. A staged install can therefore junction the
 * REAL install's `maps` directory in beside the fixture log (`{ maps: true }`, maps spec only), so
 * the LOG is deterministic while the packs stay where the game put them. A machine with no EQ
 * install simply gets no junction, and the maps spec says so and skips — the same honesty branch
 * it has always had.
 *
 * THE `/outputfile` CARVE-OUT (JOS-185). EQ writes an export dump into the INSTALL ROOT, beside
 * the executable and NOT into `Logs\` — so a staged install with only a log in it is a machine
 * where the player has never run `/outputfile`, and every surface fed by a dump took its
 * never-run branch on every launch the suite has ever made. That is half of those surfaces never
 * measured: the freshness line, the filled hosts, the capture steps. `{ inventory: <fixture> }`
 * copies a committed dump in beside the log for the specs whose subject is the dump-present half.
 * A COPY like the log, for the same reason — main WATCHES this file, and a spec that ever writes
 * one must not be writing into the working tree.
 */

import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, symlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverEqRoot, fixedDrives, rootHasLogs } from '../../src/main/log/discovery'
import { launchApp, removeUserData, type LaunchedApp } from './appWindow.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, '..', 'fixtures')

/**
 * The character every fixture is cut from. The FILE NAME is load-bearing: the parser keys the
 * self-`/who` row on `ParserConfig.characterName`, which comes from `eqlog_<Character>_<server>`,
 * and the scrub exempts the same name — so a fixture cut for `Primitive` must be tailed as
 * `Primitive` or its own `/who` line stops being its own.
 */
const LOG_NAME = 'eqlog_Primitive_freeport.txt'
const STAGE_PREFIX = 'everquest-companion-e2e-log-'
/** The server every staged character logs on — the same one `LOG_NAME` names. */
const SERVER = 'freeport'

/** Two-digit, zero-padded — the way EQ writes it (`[Wed Aug 05 20:48:16 2026]`). */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * EQ's own line prefix, rebuilt for a given instant. Verified against the real log's shape
 * (`[Sat Aug 01 00:00:01 2026]` — zero-padded day, 24h clock, four-digit year); `parseEqTimestamp`
 * accepts exactly this and turns it into LOCAL epoch millis, which is the same clock the engine's
 * live/idle logic runs on.
 */
export function stamp(at: Date = new Date()): string {
  return `[${DAYS[at.getDay()]} ${MONTHS[at.getMonth()]} ${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())} ${String(at.getFullYear())}]`
}

/** A staged install: where it is, what the app will tail, and how to write into it. */
export interface FixtureLog {
  /** The fake EQ install root — what goes into `EQ_INSTALL_DIR`. */
  readonly installDir: string
  /** The log file the app tails. The append driver writes HERE. */
  readonly logPath: string
  /**
   * THE APPEND DRIVER. Write whole lines, each carrying a fresh EQ timestamp, and fsync so the
   * watcher sees the whole burst at once rather than a torn line. Returns how many were written,
   * so a caller can assert on a number it stated rather than a number it hoped for.
   *
   * Pass MESSAGES, not lines: the timestamp is this driver's job, and a caller that wrote its own
   * would be free to write one the parser cannot read.
   */
  append(...messages: readonly string[]): number
  /**
   * The same write, at a STATED instant. The engine times an encounter from the log's own
   * clock, so a burst that all shares one second has a zero-length duration and a meaningless
   * rate — scripting a fight means scripting WHEN each swing landed, not just what it was.
   */
  appendAt(at: Date, ...messages: readonly string[]): number
  /**
   * The OTHER characters staged into this same install (character name → log path), for the specs
   * whose subject is the character SELECTOR rather than one character's log. `listCharacters()`
   * reads the Logs dir, so a second `eqlog_<Name>_<server>.txt` beside the first is all it takes
   * for the app to offer a switch — and the switch is a real one: main re-tails, re-replays and
   * rebuilds every module against the other file.
   */
  readonly others: Readonly<Record<string, string>>
  /** Delete the staged install. Best-effort, never fatal (the same discipline as userData). */
  dispose(): Promise<void>
}

/**
 * Copy a committed `/outputfile inventory` dump into the staged install ROOT — beside the
 * executable, which is where EQ writes exports and is NOT `Logs\`.
 *
 * The NAME is load-bearing for the same reason `LOG_NAME` is: `preferredOutputFile` prefers
 * `<Character>_<server>-Inventory.txt` over everything else, so a fixture staged under its own
 * file name would be found only by the newest-file fallback and would stop being found at all the
 * day a spec staged two.
 */
function stageInventory(installDir: string, fixture: string): void {
  const dump = join(FIXTURES, fixture)
  if (!existsSync(dump)) throw new Error(`e2e: no such fixture — ${dump}`)
  copyFileSync(dump, join(installDir, `Primitive_${SERVER}-Inventory.txt`))
}

/** The real EQ install, if this machine has one — the only source of map packs. */
function realEqRoot(): string | null {
  // The FS half of discovery only: no `reg query` subprocesses in a test harness.
  return discoverEqRoot({ hasLogs: rootHasLogs, extraCandidates: () => [], fixedDrives })
}

/**
 * Stage one launch's input: a temp install root holding a copy of `fixture`.
 *
 * A COPY, always. The committed fixture is a tracked file in a public repo and the append driver
 * writes to whatever it is given — pointing the app at `tests/fixtures/` directly would leave the
 * working tree dirty the first time a spec scripted a pull.
 */
export function stageFixture(
  fixture: string,
  opts: { maps?: boolean; inventory?: string; others?: Readonly<Record<string, string>> } = {}
): FixtureLog {
  const source = join(FIXTURES, fixture)
  if (!existsSync(source)) {
    throw new Error(`e2e: no such fixture — ${source} (run: npm run fixtures:e2e)`)
  }
  const installDir = mkdtempSync(join(tmpdir(), STAGE_PREFIX))
  mkdirSync(join(installDir, 'Logs'), { recursive: true })
  const logPath = join(installDir, 'Logs', LOG_NAME)
  copyFileSync(source, logPath)

  // A SECOND (third, …) character in the same Logs dir. Same copy discipline as the first: the
  // committed fixture is never the file the app reads, so a spec is free to append to either.
  const others: Record<string, string> = {}
  for (const [name, other] of Object.entries(opts.others ?? {})) {
    const otherSource = join(FIXTURES, other)
    if (!existsSync(otherSource)) {
      throw new Error(`e2e: no such fixture — ${otherSource} (run: npm run fixtures:e2e)`)
    }
    const otherPath = join(installDir, 'Logs', `eqlog_${name}_${SERVER}.txt`)
    copyFileSync(otherSource, otherPath)
    others[name] = otherPath
  }

  if (opts.inventory !== undefined) stageInventory(installDir, opts.inventory)

  if (opts.maps) {
    const root = realEqRoot()
    const packs = root ? join(root, 'maps') : null
    if (packs && existsSync(packs)) {
      // A JUNCTION, not a copy: 200 MB of map packs per launch would be absurd, and a junction
      // needs no elevation on Windows. Failure is not fatal — the viewer's picker state is a
      // correct, asserted outcome.
      try {
        symlinkSync(packs, join(installDir, 'maps'), 'junction')
      } catch {
        // no junction ⇒ the maps spec takes its stated no-packs branch
      }
    }
  }

  const appendAt = (at: Date, ...messages: readonly string[]): number => {
    if (messages.length === 0) return 0
    const prefix = stamp(at)
    const text = `${messages.map((m) => `${prefix} ${m}`).join('\n')}\n`
    const fd = openSync(logPath, 'a')
    try {
      writeSync(fd, text, null, 'utf8')
      // The watcher may wake on the first byte; an fsync'd whole-line write is what keeps the
      // tailer from ever seeing half a line.
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return messages.length
  }

  return {
    installDir,
    logPath,
    others,
    append: (...messages: readonly string[]): number => appendAt(new Date(), ...messages),
    appendAt,
    dispose: (): Promise<void> => removeUserData(installDir)
  }
}

/** A launch, plus the log it is reading — which the spec can now write into. */
export interface FixtureLaunch extends LaunchedApp {
  readonly log: FixtureLog
}

/**
 * THE ONE ENTRY POINT A SPEC USES: stage a fixture, launch the app onto it, and make `close()`
 * take the staged install away with it.
 *
 * `userData` is threaded through untouched, for the specs whose assertion spans two launches
 * (telemetry's restart, overlay-sync's persisted overlay state) — those still own their dir, and
 * they can hand the SAME `FixtureLog` to both launches so the second one tails the log the first
 * one left behind.
 */
export async function launchOnFixture(
  fixture: string | FixtureLog,
  opts: {
    maps?: boolean
    inventory?: string
    userData?: string
    env?: Record<string, string>
    others?: Readonly<Record<string, string>>
  } = {}
): Promise<FixtureLaunch> {
  const owned = typeof fixture === 'string'
  const log = owned
    ? stageFixture(fixture, {
        ...(opts.maps === undefined ? {} : { maps: opts.maps }),
        ...(opts.inventory === undefined ? {} : { inventory: opts.inventory }),
        ...(opts.others === undefined ? {} : { others: opts.others })
      })
    : fixture
  const launched = await launchApp({
    installDir: log.installDir,
    ...(opts.userData === undefined ? {} : { userData: opts.userData }),
    ...(opts.env === undefined ? {} : { env: opts.env })
  })
  return {
    ...launched,
    log,
    close: async (): Promise<void> => {
      await launched.close()
      if (owned) await log.dispose()
    }
  }
}
