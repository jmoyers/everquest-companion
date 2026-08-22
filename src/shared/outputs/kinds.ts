// ============================================================================
// shared/outputs/kinds.ts — THE `/outputfile` KIND REGISTRY (the facts half).
// ============================================================================
//
// EQ's `/outputfile <kind>` writes a tab-separated text file next to the client executable
// (the install root — NOT `Logs\`), named `<Character>_<server>-<Kind>.txt`. This file is the
// ONE place that knows, per kind: the command the player types, one clause of why it is worth
// typing, what the file is called, and whether we are allowed to parse it.
//
// WHY IT LIVES IN `shared/` (JOS-44). These are facts about the GAME, not about `fs`: the
// renderer needs the command string and the why-clause to render the freshness line, main needs
// the filename pattern to find and watch the file, and both must agree. Before this they were
// split — main knew the filenames, and each surface hand-typed its own copy of the command and
// its own sentence about it. Pure types + pure functions, no fs and no Electron, so both
// tsconfigs see it and the node test runner drives it directly.
//
// The RUNTIME half (does the file exist, when did the player last write it, watch it for
// rewrites) is `src/main/outputs/registry.ts`, which is the only side that may touch a disk.
//
// ---------------------------------------------------------------------------
// THE LAW OF THIS FILE: NO FILE FORMAT IS EVER GUESSED.
// ---------------------------------------------------------------------------
// A kind graduates from `awaiting-sample` to `supported` only when a REAL dump from the game has
// been read by a human, its shape written down, and a fixture committed under `tests/fixtures/`
// with parser tests against it. Until then the kind's entry exists — so the engine can name the
// file, tell the user what it would take, and refuse in a typed way — and `parseOutput`
// (src/main/outputs/kinds.ts) returns `{ ok: false, reason: 'unsupported' }`. It never returns a
// half-parsed object, and it never falls back to "well, it's tab-separated, so…".
//
// `fileKindVerified` is a SECOND, separate honesty flag on the same idea: the filename suffix
// itself is knowledge. `Inventory` and `Achievements` are MEASURED (the real dumps on the dev
// machine are `Primitive_freeport-Inventory.txt` and `Primitive_freeport-Achievements.txt`). Every
// other suffix below is the community/client spelling as best we know it and has NOT been observed
// on disk — an unverified suffix simply never matches a real file, which is a quiet miss rather
// than a wrong parse, and it gets corrected the moment someone runs the command and looks.
//
// TWO KINDS HAVE GRADUATED, and the second one shows the law working exactly as written: JOS-429's
// brief was investigation-first, the owner exported the real file, its format was characterized and
// written down (shared/outputs/achievements.ts's header) and the fixture committed BEFORE a line of
// parser existed. The five kinds still `awaiting-sample` below are waiting for the same thing.

/** Every `/outputfile` kind this app knows the name of. */
export type OutputKindId =
  | 'inventory'
  | 'guild'
  | 'raid'
  | 'spellbook'
  | 'factions'
  | 'achievements'
  | 'alternateadv'

export interface OutputKindDef {
  id: OutputKindId
  /**
   * The command EXACTLY as the player must type it in game. Surfaces render this verbatim
   * (OutputFileLine) — nobody re-types it into a string literal of their own.
   */
  command: string
  /**
   * ONE clause saying why it is worth typing, addressed to the player. Deliberately
   * surface-neutral: two tabs read the same dump and must not disagree about what it is for.
   * No caveats, no methodology (the tooltip-and-caveat diet).
   */
  why: string
  /** The `-<fileKind>.txt` filename suffix EQ writes (case-insensitively matched). */
  fileKind: string
  /** True only when a file with this suffix has actually been observed on disk. */
  fileKindVerified: boolean
  /** `supported` ⇒ a verified sample + fixture + tests exist and `parseOutput` works. */
  status: 'supported' | 'awaiting-sample'
  /** Human-readable note carried into the unsupported result. */
  note: string
  /**
   * HOW TO TYPE THE COMMAND SO IT CAPTURES EVERYTHING (JOS-185). One short imperative per line,
   * in the order the player does them; `[]` when a kind has no preconditions worth stating.
   *
   * These are GAME FACTS, not caveats about this app, which is why they live in the registry
   * beside the command instead of in a surface's prose. `/outputfile inventory` is conditional in
   * ways the file never admits to: it exports "Inventory items, items from all keyrings, Dragon's
   * Hoard items if the Dragon's Hoard window is open, and Personal Tradeskill Depot items if the
   * depot is loaded" (eqlwiki.com/Commands, verbatim), and both third-party EQ Legends trackers
   * additionally instruct their users to stand at a banker with the Bank window up. A dump taken
   * without those windows open is not an error and does not look like one — it is a complete,
   * well-formed file that quietly omits whole storages, and this app's numbers then omit them too.
   * That is the failure a reporter hit with his Plane of Sky weapons sitting in the hoard.
   *
   * The last step is the one that cannot be fixed by typing anything: currency-tab items (Wind
   * Runes, Motes) are never in the dump at all, so it is stated rather than worked around.
   */
  steps: readonly string[]
}

export const OUTPUT_KINDS: readonly OutputKindDef[] = [
  {
    id: 'inventory',
    command: '/outputfile inventory',
    why: 'Re-type it in game whenever your gear or bags change - everything here reads that dump.',
    fileKind: 'Inventory',
    fileKindVerified: true,
    status: 'supported',
    note: 'Equipment, bag contents, bank, depot and the keyring, plus each item’s slots.',
    steps: [
      'Stand at a banker and open your Bank.',
      'Open Dragon’s Hoard too - it only dumps while its window is open.',
      'Open your Tradeskill Depot once if you keep anything in it.',
      'Type /outputfile inventory.',
      'Wind Runes and other currency-tab items are never in the dump - the game leaves them out.'
    ]
  },
  {
    id: 'guild',
    command: '/outputfile guild',
    why: 'Dumps your guild roster as the game currently sees it.',
    fileKind: 'Guild',
    fileKindVerified: false,
    status: 'awaiting-sample',
    note: 'Guild roster dump - no verified sample; run /outputfile guild and commit a fixture.',
    steps: []
  },
  {
    id: 'raid',
    command: '/outputfile raid',
    why: 'Dumps the raid roster as the game currently sees it.',
    fileKind: 'Raid',
    fileKindVerified: false,
    status: 'awaiting-sample',
    note: 'Raid roster dump - no verified sample; run /outputfile raid and commit a fixture.',
    steps: []
  },
  {
    id: 'spellbook',
    command: '/outputfile spellbook',
    why: 'Dumps every spell in your book, as scribed.',
    fileKind: 'Spellbook',
    fileKindVerified: false,
    status: 'awaiting-sample',
    note: 'Spellbook dump - no verified sample; run /outputfile spellbook and commit a fixture.',
    steps: []
  },
  {
    id: 'factions',
    command: '/outputfile factions',
    why: 'Dumps your faction standings as the game currently sees them.',
    fileKind: 'Factions',
    fileKindVerified: false,
    status: 'awaiting-sample',
    note: 'Faction standings dump - no verified sample; run /outputfile factions and commit a fixture.',
    steps: []
  },
  {
    id: 'achievements',
    command: '/outputfile achievements',
    why: 'Type it in game to import Sky quests you finished before this app ever saw your log.',
    fileKind: 'Achievements',
    fileKindVerified: true,
    status: 'supported',
    note: 'Achievement progress, including the class-unlock rows that name each Sky quest reward.',
    // NO PRECONDITIONS, and the empty list is a measured claim rather than a gap. The inventory
    // dump's steps exist because that command is conditional in ways the file never admits to
    // (bank/hoard/depot windows). This one is not: the server already knows which achievements you
    // have, no window has to be open, and it can be typed anywhere. Saying nothing is the honest
    // answer; inventing a ritual would be a caveat with no fact under it.
    steps: []
  },
  {
    id: 'alternateadv',
    command: '/outputfile alternateadv',
    why: 'Dumps your alternate-advancement abilities and what they cost.',
    fileKind: 'AlternateAdv',
    fileKindVerified: false,
    status: 'awaiting-sample',
    note: 'Alternate-advancement dump - no verified sample; run /outputfile alternateadv and commit a fixture.',
    steps: []
  }
]

export function outputKind(id: OutputKindId): OutputKindDef {
  const def = OUTPUT_KINDS.find((k) => k.id === id)
  // The union above is closed, so this cannot miss; the throw states that rather than handing a
  // caller `undefined` typed as a definition.
  if (!def) throw new Error(`Unknown output kind: ${id}`)
  return def
}

/**
 * WHAT ONE SURFACE NEEDS TO SAY ABOUT A KIND — the registry's facts joined to the file on disk.
 * This is the ONE IPC shape (`IPC.outputsStatus`), and the only thing a renderer ever learns
 * about `/outputfile`.
 *
 * `updatedAt` is the FILE's mtime — when the PLAYER produced the dump, never when we read it —
 * and `null` means the command has never been run on this machine. That null is a state, not an
 * error: the surface says "not yet run" and keeps showing the command.
 */
export interface OutputFileStatus {
  kind: OutputKindId
  command: string
  why: string
  /** the `-<fileKind>.txt` suffix this kind's file carries */
  fileKind: string
  /** how to type the command so it captures everything — see `OutputKindDef.steps` */
  steps: readonly string[]
  /** true when this kind has a verified sample and can actually be parsed today */
  supported: boolean
  /** the dump found on disk, or null when the player has never run the command */
  path: string | null
  /** the dump's mtime, ISO; null when there is no dump */
  updatedAt: string | null
}

/**
 * Join a kind's facts to what the disk said. The ONE constructor of an `OutputFileStatus`, so
 * every field a surface renders provably came from a def or from a stat — and so the never-run
 * state is structurally atomic: `found: null` nulls the path AND the mtime together, and there is
 * no way to produce a status that names a file it cannot date (or dates a file it cannot name).
 *
 * Pure, and here rather than in main, because "what does a surface get told" is a fact of the
 * registry; only `found` needs a filesystem.
 */
export function outputFileStatus(
  def: OutputKindDef,
  found: { path: string; updatedAt: string } | null
): OutputFileStatus {
  return {
    kind: def.id,
    command: def.command,
    why: def.why,
    fileKind: def.fileKind,
    steps: def.steps,
    supported: def.status === 'supported',
    path: found?.path ?? null,
    updatedAt: found?.updatedAt ?? null
  }
}

/**
 * The filenames this kind's dump may carry for a character, MOST SPECIFIC FIRST.
 *
 * `<name>_<server>-<Kind>.txt` is what the client actually writes (measured); the bare
 * `<name>-<Kind>.txt` is the form the app's first inventory resolver looked for and is kept so a
 * machine that has one still resolves. A character we do not know the name of has no preferred
 * name at all, and the caller falls back to "the newest matching file".
 */
export function outputFileNames(
  def: OutputKindDef,
  characterName?: string,
  server?: string
): string[] {
  const names: string[] = []
  if (characterName && server) names.push(`${characterName}_${server}-${def.fileKind}.txt`)
  if (characterName) names.push(`${characterName}-${def.fileKind}.txt`)
  return names
}

/** Does this filename belong to this kind? Case-insensitive, as the rest of the matching is. */
export function isOutputFileName(def: OutputKindDef, file: string): boolean {
  return file.toLowerCase().endsWith(`-${def.fileKind}.txt`.toLowerCase())
}

/**
 * Pick a character's dump out of a kind's candidate files, `filesNewestFirst` ordered by mtime
 * descending. The preferred names win in order; failing all of them the newest file does, which
 * is what a one-character machine always lands on (verified on the dev machine, where only the
 * `_server` form exists). On a machine with several characters the first rule is what stops one
 * character's dump from being read as another's.
 *
 * PURE, and separated from `discovery.ts` for exactly that reason: this is the whole preference
 * rule, and it is testable without a filesystem.
 */
export function preferredOutputFile(
  filesNewestFirst: readonly string[],
  def: OutputKindDef,
  characterName?: string,
  server?: string
): string | null {
  if (filesNewestFirst.length === 0) return null
  for (const want of outputFileNames(def, characterName, server)) {
    const match = filesNewestFirst.find((f) => f.toLowerCase() === want.toLowerCase())
    if (match !== undefined) return match
  }
  return filesNewestFirst[0]
}
