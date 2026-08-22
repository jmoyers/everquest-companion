// ============================================================================
// shared/outputs/achievements.ts — THE `/outputfile achievements` FORMAT, characterized from a
// real dump, and the ONE thing this app reads out of it.
// ============================================================================
//
// JOS-429. Three reporters and a Reddit thread asked the same question in four wordings: I did Sky
// content before I installed this / on another PC / with logging off — how do I import it? The game
// answers it already. `/outputfile achievements` writes what the SERVER thinks you have done, and
// for the Plane of Sky that is not a hint or a heuristic: the class-unlock achievement carries one
// row per Sky quest reward and the server has already decided whether you obtained it.
//
// ---------------------------------------------------------------------------
// THE FORMAT, MEASURED — the owner's own dump, 2026-08-20.
// ---------------------------------------------------------------------------
// `<EQ root>\Primitive_freeport-Achievements.txt`, 64,539 bytes, 1,884 CRLF-terminated lines,
// committed verbatim as `tests/fixtures/Primitive_freeport-Achievements.txt`. Discovered exactly
// the way the inventory dump is (outputs/discovery.ts under `effectiveEqRoot()`, the
// `<Character>_<server>-<Kind>.txt` name), so the `Achievements` filename suffix is MEASURED now
// and `fileKindVerified` says so.
//
// Pure ASCII, no BOM, CRLF throughout (zero bare LFs), trailing newline. TAB-SEPARATED, and the
// tabs are an INDENT: a row's field count is its depth in a three-level tree, with the leading
// field carrying a one-letter status on every row except the top.
//
//   Untapped Potential: Classes                              1 field  — CATEGORY, no status
//   I<TAB>Primary Class Unlock - Bard                        2 fields — ACHIEVEMENT, status first
//   C<TAB><TAB>Obtain Mask of Song.                          3 fields — COMPONENT, col 1 empty
//   I<TAB><TAB>Gnolls<TAB>2/5000                             4 fields — COMPONENT + counter
//
// Status is `C` (complete) or `I` (incomplete) and nothing else — 520 `C`, 1,338 `I`, zero other
// values across the whole file. The middle field of a 3- or 4-field row is ALWAYS empty (1,251 of
// 1,251), the 4th field is always `<n>/<m>` and appears only under the three `Slayer:` categories.
// The audit found ZERO anomalies of any kind, which is why the parser below refuses rather than
// tolerating: a shape this regular that stops being regular is news, not noise.
//
// 26 categories, each `Family: Group` (`Untapped Potential: Classes`, `EverQuest: Raids`, …),
// 501 achievements, 1,357 components.
//
// A PARENT'S STATUS IS NOT ITS CHILDREN'S, and this is the trap the reader below avoids. The
// owner's `Primary Class Unlock - Paladin` row is `C` while only five of its six components are —
// because the achievement also completes when you simply ARE a Paladin ("This achievement will
// autocomplete if you chose to confirm your Primary Class as a Paladin."). Reading the achievement
// row would mark every Paladin Sky quest done for every Paladin. Only the COMPONENT rows are read.
//
// ---------------------------------------------------------------------------
// AND THE COMPONENT ROWS ARE NOT ALL PER-QUEST EVIDENCE EITHER (JOS-441). THE CASCADE.
// ---------------------------------------------------------------------------
// JOS-429 shipped in v1.7.0 and three reports landed within hours, from at least two users, all
// saying one thing: Sky quests they had never run came back "Turned in" after `/outputfile
// achievements`. 01M0JHFCYRD9ER1Q6NDY8YWPWC named a specific reward ("Amulet of void for instance I
// have not done, but it shows turned in"), then diagnosed itself — "because I have bought tokens for
// enchanter and berserker, and wizard is my primary, these will just automatically show as all
// turned in" — and 01M0J9RHV7Y5F80E9NPSYVXM7Y said the same about the level-50 Primary Class Unlock
// token. Reading the achievement row was never the only way to be wrong: WHEN A CLASS'S UNLOCK IS
// GRANTED RATHER THAN EARNED, THE SERVER CASCADES `C` DOWN INTO THE `Obtain` COMPONENTS TOO. The
// components are the answer to "did you unlock this class", not to "did you run this quest", and for
// a granted unlock those two questions have different answers.
//
// WHAT DISCRIMINATES THEM, AND IT IS IN THE FILE. The two boilerplate sentences every class-unlock
// achievement carries are not prose the client appends — they are COMPONENT ROWS WITH THEIR OWN
// STATUS COLUMN, and the status says which grant happened. MEASURED across all sixteen classes of
// the committed owner fixture (`tests/fixtures/Primitive_freeport-Achievements.txt`):
//
//   class        parent  Obtain C/total   "will autocomplete…"  "can be bypassed…"
//   Paladin        C          4/4                  C                    I
//   every other    I        1/6 … 5/7              I                    I
//
// Paladin is the class the owner CONFIRMED, and it is the only class whose `Obtain` rows are
// unanimously `C` — every honestly-played class sits at a mixed 17%–71%. So the confirm half is not
// a hypothesis: the autocomplete row's `C` and the all-components cascade appear together, on the
// one class where a grant is known to have happened, and nowhere else in the file.
//
// THE TOKEN HALF IS ASSUMED, NOT MEASURED, AND `CLASS_UNLOCK_TOKEN_ROW` IS WHERE THAT ASSUMPTION
// LIVES. No achievements export from a token user exists to read: all three reports predate the
// attachment (feedback/achievements.ts ships it now), their log slices carry only the `Outputfile
// Complete:` receipt, and the owner holds the live-token experiment as their own call. What is
// assumed is the SYMMETRY — that the token row flips to `C` on token use exactly as the autocomplete
// row flips to `C` on confirmation — and `tests/fixtures/synthetic-token-unlock-Achievements.txt` is
// that assumption written down as a file, derived from the owner's real Paladin block by moving the
// `C` from one pseudo-row to the other. IF THE ASSUMPTION IS WRONG the token half simply does not
// fire and a token user sees the v1.7.0 behavior for their tokened class; nothing else misreads,
// because the confirm half stands on its own evidence. The first token user's attached export
// settles it either way.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE ANSWERS THE SKY QUESTION, AND HOW EXACTLY IT JOINS.
// ---------------------------------------------------------------------------
// `Untapped Potential: Classes` holds sixteen `Primary Class Unlock - <Class>` achievements whose
// components are, apart from two boilerplate sentences each, exactly `Obtain <Item>` — the Sky
// quest rewards. MEASURED against the committed scrape: 95 `Obtain` rows, 95 Sky quests, and the
// per-class counts agree class for class. That 1:1 is the whole basis of the join.
//
// THE ORDER DOES NOT ALIGN and must never be used. Within a class the achievement lists its
// components in a different order from the wiki's quest table (Cleric: the file leads with
// Necklace of Resolution, the scrape with Truewind Earring), so an ordinal join would silently
// credit the wrong quest for eleven of the sixteen classes. The join is BY ITEM NAME, inside the
// class the achievement names — the class is a check, not a tiebreak, since every reward is unique
// to its quest anyway (rewardInference.ts measured that).
//
// THE CLASS NAME IS THE GAME'S SPELLING, not the wiki's: the file says `Shadowknight`, the scrape
// says `Shadow Knight`. Folded on comparison, never rewritten.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE DOES **NOT** DECIDE.
// ---------------------------------------------------------------------------
// The join against the quest set lives in the renderer
// (renderer/src/features/posky/achievementInference.ts), because the Sky quest data is the
// renderer's bundle — the same split `rewardInference.ts` already has, where main persists a flat
// artifact and the renderer joins it against posky.json. This module knows the FILE and nothing
// about Plane of Sky beyond the category name.
//
// AND IT IS ONE-DIRECTIONAL, decided here so no reader has to re-derive it. `C` on a component is
// evidence the quest was turned in. `I` is NOT evidence it was not: it is the same "a dump adds, it
// never subtracts" promise the inventory export already makes (progressState.ts), and the reason
// `classUnlockClaims` returns only the EARNED rows — a record that cannot express a denial cannot
// be misread as one.

/** The one-letter status column, as English. `C`/`I` are the only two values a real dump carries. */
export type AchievementStatus = 'complete' | 'incomplete'

/**
 * ONE ROW of the dump, with its place in the tree resolved.
 *
 * `component` absent ⇒ this row IS the achievement (a 2-field line); present ⇒ it is one of the
 * achievement's requirement lines. `category` is the un-statused header the rows sit under.
 */
export interface AchievementRow {
  /** the `Family: Group` header, verbatim */
  category: string
  /** the achievement's name, verbatim */
  achievement: string
  /** the requirement line, verbatim; absent on the achievement row itself */
  component?: string
  status: AchievementStatus
  /** the `<n>/<m>` counter the Slayer components carry, verbatim; absent everywhere else */
  progress?: string
}

/** A parsed dump. A list, because the file is one and the tree is already resolved onto each row. */
export interface AchievementsDump {
  rows: AchievementRow[]
}

/** The category holding the Sky class-unlock achievements. */
export const CLASS_UNLOCK_CATEGORY = 'Untapped Potential: Classes'

/** What every class-unlock achievement's name starts with; the rest is the class. */
export const CLASS_UNLOCK_PREFIX = 'Primary Class Unlock - '

/** What every reward component line starts with; the rest is the item. */
const OBTAIN_PREFIX = 'Obtain '

/**
 * The class-confirmation pseudo-row, up to the class name — `C` on the class the player CONFIRMED
 * as their primary. VERIFIED on the owner's fixture (header): the one class carrying it is the one
 * class whose `Obtain` components are unanimously complete.
 */
export const CLASS_UNLOCK_CONFIRM_PREFIX =
  'This achievement will autocomplete if you chose to confirm your Primary Class as a '

/**
 * The token pseudo-row, verbatim and class-independent. ASSUMED to read `C` after a Primary Class
 * Unlock Token is spent, by symmetry with the confirm row above — see the header's token-half
 * paragraph for exactly what is unmeasured and what happens if the symmetry does not hold.
 */
export const CLASS_UNLOCK_TOKEN_ROW =
  'This achievement can be bypassed using a Primary Class Unlock Token.'

/**
 * ONE EARNED REWARD, as the achievements file states it — the flat artifact main persists and the
 * renderer joins against the quest set.
 *
 * Both fields are the GAME's spelling, kept verbatim: `className` is `Shadowknight` where the
 * scrape says `Shadow Knight`, and `item` is whatever the row said with only a trailing period
 * taken off (the file is inconsistent about it — `Obtain Mask of Song.` and `Obtain Molten Coil`
 * are both real rows). Normalizing here would throw away the evidence and leave the join matching
 * our own guess against our own guess.
 */
export interface ClassUnlockClaim {
  className: string
  item: string
  /**
   * HOW THIS CLASS'S UNLOCK WAS GRANTED, and therefore what kind of evidence this row is (JOS-441).
   * Carried on every claim rather than worked out at read time because the owner's model has three
   * separately tracked evidence kinds — an observed turn-in, a per-quest achievement, a class-unlock
   * achievement — and the third has to be REPRESENTABLE IN THE RECORD, not applied by whichever
   * consumer remembers to. A `'confirm'`/`'token'` row is stored, shown and labelled as exactly what
   * it is; it is simply not a quest completion.
   */
  grant: ClassUnlockGrant
}

/**
 * WHAT MADE A CLASS'S UNLOCK ACHIEVEMENT COMPLETE, read off the two pseudo-rows.
 *
 *   'quest'    neither bypass row is `C` — the `Obtain` rows under it are per-quest evidence, which
 *              is what JOS-429 assumed of every row and what this build now checks.
 *   'confirm'  the class-confirmation row is `C` (VERIFIED — the owner's Paladin block).
 *   'token'    the token row is `C` (ASSUMED by symmetry — see the header).
 *
 * `'confirm'` wins if a file ever carried both, because it is the half standing on measured
 * evidence; the two are the same verdict for every consumer anyway (neither is quest evidence), so
 * the tie-break only decides which word the badge says.
 */
export type ClassUnlockGrant = 'quest' | 'confirm' | 'token'

/**
 * WHAT WE KNOW ABOUT THE ACHIEVEMENTS DUMP WE READ — `ProgressState.achievementsSource`.
 *
 * The `InventorySource` shape minus everything the inventory baseline needed and this does not.
 * There is no generation instant to resolve: the log's `Outputfile Complete:` receipt is joined by
 * FILE NAME and would work here too, but nothing in this path compares an instant against
 * anything, so recording one would be a field with no reader (`loadInventoryDump`'s own rule about
 * persisted keys nobody reads). The two instants that ARE read are the file's and ours.
 */
export interface AchievementsSource {
  path: string
  /** The file's mtime, ISO. What the freshness line renders — when the PLAYER typed the command. */
  loadedAt: string
  /** When THIS APP last read it, epoch ms. The JOS-253 pair, for the same reason. */
  readAt: number
}

/**
 * Parse a dump's text into rows.
 *
 * STRICT, on the measurement above: a line whose leading field is neither `C` nor `I`, or whose
 * indent columns are not empty, or that is deeper than the format has ever been, is DROPPED rather
 * than guessed at. The real file produced zero such lines, so anything this skips is a format that
 * has changed under us — and half-reading a changed format is exactly what the registry's
 * no-guessing law exists to prevent. A component before any achievement is dropped for the same
 * reason: it has no parent to belong to.
 *
 * Blank lines are skipped (the trailing newline makes one). CR is stripped so a dump that has been
 * through a text tool and lost its CRLFs still reads.
 */
export function parseAchievementsDump(text: string): AchievementsDump {
  const rows: AchievementRow[] = []
  let category = ''
  let achievement: string | null = null
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') continue
    const fields = line.split('\t')
    if (fields.length === 1) {
      category = line
      achievement = null
      continue
    }
    const status = STATUS[fields[0]]
    if (status === undefined) continue
    if (fields.length === 2) {
      if (fields[1] === '') continue
      achievement = fields[1]
      rows.push({ category, achievement, status })
      continue
    }
    // A component with no achievement above it has no parent to belong to.
    if (achievement === null) continue
    const row = componentRow(category, achievement, status, fields)
    if (row !== null) rows.push(row)
  }
  return { rows }
}

/**
 * One requirement line, or null when its shape is not one the real file has ever printed: exactly
 * one empty indent column, a non-empty name, and at most one counter after it. Split out of the
 * loop above so each half stays inside the measured complexity ceiling — and it reads better as
 * "what a component row is", which is the only rule in it.
 */
function componentRow(
  category: string,
  achievement: string,
  status: AchievementStatus,
  fields: string[]
): AchievementRow | null {
  if (fields.length > 4 || fields[1] !== '' || fields[2] === '') return null
  const progress = fields.length === 4 && fields[3] !== '' ? fields[3] : undefined
  return {
    category,
    achievement,
    component: fields[2],
    status,
    ...(progress === undefined ? {} : { progress })
  }
}

const STATUS: Record<string, AchievementStatus | undefined> = {
  C: 'complete',
  I: 'incomplete'
}

/** The class this row is about, or null when the row is not a class-unlock achievement's. */
function unlockClassOf(row: AchievementRow): string | null {
  if (row.category !== CLASS_UNLOCK_CATEGORY) return null
  if (!row.achievement.startsWith(CLASS_UNLOCK_PREFIX)) return null
  const className = row.achievement.slice(CLASS_UNLOCK_PREFIX.length).trim()
  return className === '' ? null : className
}

/**
 * WHAT GRANTED EACH CLASS'S UNLOCK, per the two pseudo-rows (JOS-441) — keyed by the class name in
 * the GAME's spelling, exactly as `ClassUnlockClaim.className` carries it.
 *
 * A class absent from the file is absent from the map; a class present with neither bypass row `C`
 * maps to `'quest'`. Exported so a test can assert the discrimination against the real fixture
 * directly, and so the diagnosability path can say what a user's file claims without re-deriving it.
 */
export function classUnlockGrants(dump: AchievementsDump): Map<string, ClassUnlockGrant> {
  const grants = new Map<string, ClassUnlockGrant>()
  for (const row of dump.rows) {
    const className = unlockClassOf(row)
    if (className === null) continue
    if (!grants.has(className)) grants.set(className, 'quest')
    if (row.component === undefined || row.status !== 'complete') continue
    // 'confirm' is the measured half and is never downgraded by a later row (see the type).
    if (row.component.startsWith(CLASS_UNLOCK_CONFIRM_PREFIX)) grants.set(className, 'confirm')
    else if (row.component === CLASS_UNLOCK_TOKEN_ROW && grants.get(className) !== 'confirm') {
      grants.set(className, 'token')
    }
  }
  return grants
}

/**
 * THE EARNED CLASS-UNLOCK REWARDS a dump vouches for — the projection this whole module exists to
 * produce, and the only thing that leaves it.
 *
 * COMPONENT ROWS ONLY, and only the `C` ones (the header's two rules). The two boilerplate
 * components every class-unlock achievement carries ("This achievement will autocomplete if…",
 * "This achievement can be bypassed using a…") are not `Obtain` rows and so are never claims — they
 * are read once, by `classUnlockGrants` above, to decide the `grant` every claim of that class then
 * carries.
 *
 * EVERY `C` OBTAIN ROW IS STILL RETURNED, INCLUDING A GRANTED CLASS'S (JOS-441). The row is real
 * evidence about a real achievement and the owner's model tracks it as its own kind; what the
 * `grant` decides is whether it may speak about a QUEST. Filtering here instead would throw the
 * evidence away at the one place that can still see what it is, and would leave the renderer unable
 * to say "your file marks this, and here is why we are not counting it".
 *
 * A dump with no such rows yields an empty list, which is the acceptance criterion stated as code:
 * a file with nothing to say about Sky changes nothing.
 */
export function classUnlockClaims(dump: AchievementsDump): ClassUnlockClaim[] {
  const grants = classUnlockGrants(dump)
  const out: ClassUnlockClaim[] = []
  for (const row of dump.rows) {
    const className = unlockClassOf(row)
    if (className === null) continue
    if (row.component === undefined || row.status !== 'complete') continue
    if (!row.component.startsWith(OBTAIN_PREFIX)) continue
    const item = row.component.slice(OBTAIN_PREFIX.length).trim().replace(/\.$/, '')
    if (item === '') continue
    out.push({ className, item, grant: grants.get(className) ?? 'quest' })
  }
  return out
}
