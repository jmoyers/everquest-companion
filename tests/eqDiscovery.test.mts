// EQ INSTALL-DIR DISCOVERY TEST (fresh-machine config feature): the pure, ordered
// candidate-resolution logic that lets a friend's fresh install "just work" with no
// config, plus the fs predicates it relies on.
//
// Two layers, both PURE / injectable so no real registry or C:\ layout is needed:
//   1. discoverEqRoot(probes) — the ordered sweep: extraCandidates (env → registry)
//      FIRST, then <drive> × Daybreak-subpath, first candidate whose Logs dir holds
//      an eqlog_*.txt wins; duplicates probed at most once; null when nothing matches.
//   2. rootHasLogs / countCharacterLogs — exercised against REAL temp fixture dirs
//      (an install root with a Logs\eqlog_*.txt, an empty one, a missing one).
//   3. normalizeEqDirOverride — what the MANUAL override means (JOS-53). The three
//      shapes a reasonable person picks all resolve to the same {root, logsDir}.
// The probes that answer about the REAL machine (the in-process registry + mount-table
// reads that replaced `reg.exe`/`wmic` in JOS-184) are in eqDiscoveryProbes.test.mts.
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  discoverEqRoot,
  legendsFirst,
  rootHasLogs,
  countCharacterLogs,
  dirHasCharacterLogs,
  logIsUnderLogsDir,
  normalizeEqDirOverride,
  realOverrideProbes,
  tailSurvivesRootChange,
  type DiscoveryProbes
} from '../src/main/log/discovery'

// --- discoverEqRoot ordering (fully injected probes) ------------------------

/** A probe set where `withLogs` is the ONLY root reporting logs. */
function probes(withLogs: Set<string>, drives: string[], extra: string[] = []): DiscoveryProbes {
  return {
    hasLogs: (root) => withLogs.has(root.replace(/[\\/]+$/, '').toLowerCase()),
    extraCandidates: () => extra,
    fixedDrives: () => drives
  }
}

const lc = (s: string): string => s.replace(/[\\/]+$/, '').toLowerCase()

test('discoverEqRoot: default public path on C: is found by the drive sweep', () => {
  const target = 'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'
  const root = discoverEqRoot(probes(new Set([lc(target)]), ['C:', 'D:']))
  assert.equal(root, target)
})

test('discoverEqRoot: sweeps other fixed drives (install on D:)', () => {
  const target = 'D:\\Daybreak Game Company\\Installed Games\\EverQuest Legends'
  const root = discoverEqRoot(probes(new Set([lc(target)]), ['C:', 'D:']))
  assert.equal(root, target)
})

test('discoverEqRoot: an extra candidate (env/registry) wins over the drive sweep', () => {
  const reg = 'E:\\Games\\EQL'
  const publicPath = 'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'
  // BOTH have logs; the extra candidate is probed first, so it wins.
  const root = discoverEqRoot(probes(new Set([lc(reg), lc(publicPath)]), ['C:'], [reg]))
  assert.equal(root, reg)
})

test('discoverEqRoot: a sibling EverQuest with logs never outranks the Legends install', () => {
  // THE REGRESSION, measured 2026-08-17 on a machine that has three EverQuests installed. The
  // registry hands back its Uninstall entries in key order, so retail EverQuest arrives BEFORE
  // EverQuest Legends — and retail had 38 character logs in it. First-hit-wins therefore did not
  // fail to find a game, it found the WRONG one and would have tailed it confidently. `hasLogs`
  // cannot break this tie: both directories hold real `eqlog_<Char>_<server>.txt` files, which is
  // why BOTH are marked as having logs here.
  const retail = 'D:\\Games\\EverQuest'
  const legends = 'D:\\Games\\EverQuest Legends'
  const companion = 'C:\\Users\\u\\AppData\\Local\\Programs\\everquest-companion'
  const root = discoverEqRoot(
    probes(new Set([lc(retail), lc(legends)]), ['C:'], [companion, retail, 'D:\\Games\\EverQuest II', legends])
  )
  assert.equal(root, legends)
})

test('legendsFirst: a stable partition — no-op on a machine with one EverQuest', () => {
  // Stability is the property that keeps this change invisible everywhere it is not needed.
  assert.deepEqual(legendsFirst(['C:\\A', 'C:\\B', 'C:\\C']), ['C:\\A', 'C:\\B', 'C:\\C'])
  assert.deepEqual(
    legendsFirst(['D:\\Games\\EverQuest', 'D:\\Games\\EverQuest II', 'D:\\Games\\EverQuest Legends']),
    ['D:\\Games\\EverQuest Legends', 'D:\\Games\\EverQuest', 'D:\\Games\\EverQuest II']
  )
  // Order among the Legends paths, and among the rest, is untouched.
  assert.deepEqual(
    legendsFirst(['A\\EverQuest', 'B\\EverQuest Legends', 'C\\Other', 'D\\EverQuestLegends']),
    ['B\\EverQuest Legends', 'D\\EverQuestLegends', 'A\\EverQuest', 'C\\Other']
  )
  assert.deepEqual(legendsFirst([]), [])
})

test('discoverEqRoot: returns null when nothing has logs (fresh machine)', () => {
  const root = discoverEqRoot(probes(new Set(), ['C:', 'D:'], ['Z:\\nope']))
  assert.equal(root, null)
})

test('discoverEqRoot: probes each candidate at most once (dedupe)', () => {
  const seen: string[] = []
  const target = 'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'
  const p: DiscoveryProbes = {
    hasLogs: (root) => {
      seen.push(root)
      return lc(root) === lc(target)
    },
    // Duplicate the target as an extra candidate + it's also produced by the sweep.
    extraCandidates: () => [target, target],
    fixedDrives: () => ['C:']
  }
  const root = discoverEqRoot(p)
  assert.equal(root, target)
  // The target should appear exactly once in the probe log (found on first hit).
  const hits = seen.filter((s) => lc(s) === lc(target))
  assert.equal(hits.length, 1)
})

// --- the ROOT-CHANGE decision (bug 01KZ9BF43KYH…) ---------------------------
//
// When the user picks a new EverQuest folder in Settings, may the tail that is already
// running survive it? The old rule was "does its file still exist", which is true of every
// log under the OLD root — so the folder the user just picked did nothing until a restart.
// The rule is "is it under the NEW Logs dir, and still there".

const NEW_LOGS = 'D:\\Games\\EverQuest Legends\\Logs'
const yes = (): boolean => true
const no = (): boolean => false

test('logIsUnderLogsDir: a log directly in the dir matches, case/separator-insensitively', () => {
  assert.equal(logIsUnderLogsDir(`${NEW_LOGS}\\eqlog_Primitive_freeport.txt`, NEW_LOGS), true)
  // NTFS is case-insensitive and these paths arrive from three sources (store, picker, readdir).
  assert.equal(logIsUnderLogsDir('d:/games/everquest legends/logs/eqlog_A_b.txt', NEW_LOGS), true)
  // A trailing separator on the dir is not a difference.
  assert.equal(logIsUnderLogsDir(`${NEW_LOGS}\\eqlog_A_b.txt`, `${NEW_LOGS}\\`), true)
})

test('logIsUnderLogsDir: a log under a DIFFERENT root does not match', () => {
  const oldLog =
    'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends\\Logs\\eqlog_A_b.txt'
  assert.equal(logIsUnderLogsDir(oldLog, NEW_LOGS), false)
})

test('logIsUnderLogsDir: a nested subdirectory is not "in" the Logs dir', () => {
  assert.equal(logIsUnderLogsDir(`${NEW_LOGS}\\archive\\eqlog_A_b.txt`, NEW_LOGS), false)
  // …and a prefix that is not a path boundary must not match either.
  assert.equal(logIsUnderLogsDir('D:\\Games\\EverQuest Legends\\LogsOld\\eqlog_A_b.txt', NEW_LOGS), false)
})

test('tailSurvivesRootChange: the reported bug — an existing OLD-root log does not survive', () => {
  const oldLog =
    'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends\\Logs\\eqlog_A_b.txt'
  // The file is perfectly readable (exists → true) and that is exactly what used to keep it.
  assert.equal(tailSurvivesRootChange(oldLog, NEW_LOGS, yes), false)
})

test('tailSurvivesRootChange: a healthy tail under the same dir is not disturbed', () => {
  assert.equal(tailSurvivesRootChange(`${NEW_LOGS}\\eqlog_A_b.txt`, NEW_LOGS, yes), true)
})

test('tailSurvivesRootChange: a vanished log under the new dir does not survive', () => {
  assert.equal(tailSurvivesRootChange(`${NEW_LOGS}\\eqlog_A_b.txt`, NEW_LOGS, no), false)
})

test('tailSurvivesRootChange: nothing attached ⇒ nothing to keep', () => {
  assert.equal(tailSurvivesRootChange(null, NEW_LOGS, yes), false)
  assert.equal(tailSurvivesRootChange(undefined, NEW_LOGS, yes), false)
  assert.equal(tailSurvivesRootChange('', NEW_LOGS, yes), false)
})

// --- rootHasLogs / countCharacterLogs against real temp fixtures ------------

test('rootHasLogs / countCharacterLogs: real fixture dirs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'eq-disc-'))
  try {
    // 1. A proper install root: <root>\Logs\eqlog_*.txt (+ a non-log file).
    const good = join(tmp, 'good')
    mkdirSync(join(good, 'Logs'), { recursive: true })
    writeFileSync(join(good, 'Logs', 'eqlog_Primitive_freeport.txt'), '[Sat] hi\n')
    writeFileSync(join(good, 'Logs', 'eqlog_Alt_halas.txt'), '[Sat] hi\n')
    writeFileSync(join(good, 'Logs', 'MemoryStrategy.txt'), 'not a log\n')

    // 2. A Logs dir with NO character logs.
    const emptyLogs = join(tmp, 'emptyLogs')
    mkdirSync(join(emptyLogs, 'Logs'), { recursive: true })
    writeFileSync(join(emptyLogs, 'Logs', 'dbg.txt'), 'nope\n')

    // 3. A root with no Logs dir at all.
    const noLogsDir = join(tmp, 'noLogs')
    mkdirSync(noLogsDir, { recursive: true })

    assert.equal(rootHasLogs(good), true)
    assert.equal(rootHasLogs(emptyLogs), false)
    assert.equal(rootHasLogs(noLogsDir), false)
    assert.equal(rootHasLogs(join(tmp, 'does-not-exist')), false)

    assert.equal(countCharacterLogs(join(good, 'Logs')), 2)
    assert.equal(countCharacterLogs(join(emptyLogs, 'Logs')), 0)
    assert.equal(countCharacterLogs(join(tmp, 'does-not-exist')), 0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('discovery is re-runnable: the same root fails before /log on and succeeds after', () => {
  // The reported bug's shape (01KZ9BF43KYH…): a player who has never enabled EQ logging has no
  // eqlog_*.txt at all, so the folder they pick legitimately resolves to nothing. The moment
  // `/log on` creates the file, the SAME probe set must answer differently — which is what makes
  // an idle rescan (session.ts `watchForFirstLog`) a correct fix rather than a hopeful one.
  const tmp = mkdtempSync(join(tmpdir(), 'eq-disc3-'))
  try {
    const install = join(tmp, 'Games', 'EverQuest Legends')
    mkdirSync(join(install, 'Logs'), { recursive: true })
    const p: DiscoveryProbes = {
      hasLogs: rootHasLogs,
      extraCandidates: () => [install],
      fixedDrives: () => []
    }
    assert.equal(discoverEqRoot(p), null, 'a Logs dir with no character log is not a match')
    assert.equal(countCharacterLogs(join(install, 'Logs')), 0)

    writeFileSync(join(install, 'Logs', 'eqlog_Primitive_freeport.txt'), '[Wed] *ON*\n')

    assert.equal(discoverEqRoot(p), install)
    assert.equal(countCharacterLogs(join(install, 'Logs')), 1)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// --- the MANUAL OVERRIDE's meaning (JOS-53, reports 01KZBRYQK2QC… / 01KZBYDS2F52…) -------
//
// Two prod installs on 2026-08-06 pointed the picker at their `…\EverQuest Legends\Logs`
// folder — the folder that literally contains the file the app is hunting for — and were
// told "no logs detected", because the override was trusted verbatim as the ROOT and we
// then looked in `…\Logs\Logs`. One of them filed a second report apologizing for "total
// user error". Nothing about that was user error, and the fix is that all three shapes a
// reasonable person picks resolve to the same pair.

/** Build a temp install: `<tmp>/<name>/Logs/eqlog_Gnut_qeynos.txt`. Returns the paths. */
function tempInstall(tmp: string, name = 'EverQuest Legends'): {
  root: string
  logsDir: string
  logFile: string
} {
  const root = join(tmp, 'games', name)
  const logsDir = join(root, 'Logs')
  const logFile = join(logsDir, 'eqlog_Gnut_qeynos.txt')
  mkdirSync(logsDir, { recursive: true })
  writeFileSync(logFile, '[Thu Aug 06 09:00:00 2026] Welcome to EverQuest!\n')
  return { root, logsDir, logFile }
}

/** Normalize with the REAL fs probes (the whole point is that the disk decides). */
const norm = (picked: string): { root: string; logsDir: string } =>
  normalizeEqDirOverride(picked, realOverrideProbes())

/**
 * The contract is "the same DIRECTORY", not "the same string": normalization echoes the
 * separators it was given (a hand-edited store value may use `/`, the picker never does)
 * and Windows treats the two as one path. So the assertions compare paths the way
 * `logIsUnderLogsDir` already does — one separator style, case-folded, no trailing slash.
 */
function assertResolves(
  got: { root: string; logsDir: string },
  want: { root: string; logsDir: string },
  msg = ''
): void {
  assert.equal(lc(got.root.replace(/[\\/]+/g, '\\')), lc(want.root.replace(/[\\/]+/g, '\\')), `root ${msg}`)
  assert.equal(
    lc(got.logsDir.replace(/[\\/]+/g, '\\')),
    lc(want.logsDir.replace(/[\\/]+/g, '\\')),
    `logsDir ${msg}`
  )
}

test('normalizeEqDirOverride: the install ROOT still resolves exactly as it always did', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'eq-ovr-root-'))
  try {
    const { root, logsDir } = tempInstall(tmp)
    assert.deepEqual(norm(root), { root, logsDir })
    assert.equal(countCharacterLogs(norm(root).logsDir), 1)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('normalizeEqDirOverride: THE REPORTED BUG — the Logs folder itself is the Logs folder', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'eq-ovr-logs-'))
  try {
    const { root, logsDir } = tempInstall(tmp)
    const got = norm(logsDir)
    assert.deepEqual(got, { root, logsDir })
    // The old behavior, spelled out so the regression is unmistakable.
    assert.notEqual(got.logsDir, join(logsDir, 'Logs'))
    assert.equal(countCharacterLogs(got.logsDir), 1, 'the character log is FOUND')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('normalizeEqDirOverride: a log FILE resolves to its folder and its grandparent root', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'eq-ovr-file-'))
  try {
    const { root, logsDir, logFile } = tempInstall(tmp)
    assert.deepEqual(norm(logFile), { root, logsDir })
    assert.equal(countCharacterLogs(norm(logFile).logsDir), 1)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('normalizeEqDirOverride: trailing separators and forward slashes are not a shape', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'eq-ovr-slash-'))
  try {
    const { root, logsDir } = tempInstall(tmp)
    for (const suffix of ['\\', '\\\\', '/', '//']) {
      assertResolves(norm(root + suffix), { root, logsDir }, `root + ${JSON.stringify(suffix)}`)
      assertResolves(
        norm(logsDir + suffix),
        { root, logsDir },
        `logsDir + ${JSON.stringify(suffix)}`
      )
    }
    // A path typed/pasted with forward slashes still resolves to the same pair.
    assertResolves(norm(logsDir.replace(/\\/g, '/')), { root, logsDir }, 'forward slashes')
    assertResolves(norm(root.replace(/\\/g, '/')), { root, logsDir }, 'forward-slash root')
    // …as does one with surrounding whitespace (a paste out of a chat window).
    assert.deepEqual(norm(`  ${logsDir}  `), { root, logsDir })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('normalizeEqDirOverride: a Logs folder is a Logs folder BEFORE /log on has ever run', () => {
  // The empty-Logs case matters most: it is exactly when the user is being told to go turn
  // logging on, so resolving to `<Logs>\Logs` would make the instruction unfollowable.
  const tmp = mkdtempSync(join(tmpdir(), 'eq-ovr-empty-'))
  try {
    const root = join(tmp, 'EverQuest Legends')
    const logsDir = join(root, 'Logs')
    mkdirSync(logsDir, { recursive: true })
    assert.deepEqual(norm(logsDir), { root, logsDir })
    assert.equal(countCharacterLogs(logsDir), 0, 'and the pane truthfully reports zero')
    // Case is not a difference (NTFS, and the folder is spelled by the game, not by us).
    const shouty = join(root, 'LOGS')
    mkdirSync(shouty, { recursive: true })
    assert.deepEqual(norm(shouty), { root, logsDir: shouty })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('normalizeEqDirOverride: a differently-NAMED folder holding eqlog_*.txt is the log dir', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'eq-ovr-named-'))
  try {
    const parent = join(tmp, 'EverQuest Legends')
    const logsDir = join(parent, 'MyLogs')
    mkdirSync(logsDir, { recursive: true })
    writeFileSync(join(logsDir, 'eqlog_Ratlanta_rivervale.txt'), '[Thu] hi\n')
    assert.equal(dirHasCharacterLogs(logsDir), true)
    assert.deepEqual(norm(logsDir), { root: parent, logsDir })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('normalizeEqDirOverride: a root holding BOTH a Logs subdir and stray logs stays a root', () => {
  // Precedence, pinned: the shape that already worked is tested before the content sniff,
  // so the pathological folder that is both is read the way it is read today.
  const tmp = mkdtempSync(join(tmpdir(), 'eq-ovr-both-'))
  try {
    const { root, logsDir } = tempInstall(tmp)
    writeFileSync(join(root, 'eqlog_Stray_freeport.txt'), '[Thu] hi\n')
    assert.deepEqual(norm(root), { root, logsDir })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('normalizeEqDirOverride: a nonexistent path keeps the OLD behavior (root as given)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'eq-ovr-gone-'))
  try {
    // A typo, an unplugged drive, an uninstalled game. We cannot improve on the guess, and
    // characterCount says 0 either way — so the answer is byte-identical to what shipped.
    const missing = join(tmp, 'not', 'there')
    assert.deepEqual(norm(missing), { root: missing, logsDir: join(missing, 'Logs') })
    // A folder with neither a Logs subdir nor any character log is the same story.
    const bare = join(tmp, 'bare')
    mkdirSync(bare, { recursive: true })
    assert.deepEqual(norm(bare), { root: bare, logsDir: join(bare, 'Logs') })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('normalizeEqDirOverride: a NON-log file resolves through its folder, not onto it', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'eq-ovr-other-'))
  try {
    const { root, logsDir } = tempInstall(tmp)
    const ini = join(root, 'eqclient.ini')
    writeFileSync(ini, '[Defaults]\n')
    // The old code would have produced `…\eqclient.ini\Logs`. The folder is the useful part.
    assert.deepEqual(norm(ini), { root, logsDir })
    const dbg = join(logsDir, 'dbg.txt')
    writeFileSync(dbg, 'not a character log\n')
    assert.deepEqual(norm(dbg), { root, logsDir })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('normalizeEqDirOverride: is IDEMPOTENT — re-normalizing its own answer is a fixed point', () => {
  // This is what lets an already-persisted bad override start working on upgrade with no
  // re-save: nothing is rewritten in the store, the seam simply keeps answering the same way.
  const tmp = mkdtempSync(join(tmpdir(), 'eq-ovr-idem-'))
  try {
    const { root, logsDir, logFile } = tempInstall(tmp)
    for (const picked of [root, logsDir, logFile]) {
      const once = norm(picked)
      assert.deepEqual(norm(once.root), once, `root of ${picked}`)
      assert.deepEqual(norm(once.logsDir), once, `logsDir of ${picked}`)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('normalizeEqDirOverride: the decision table, fully injected (no disk at all)', () => {
  // The pure form — the same rules over probes that answer for a Windows layout this
  // machine does not have, including a path that exists as neither file nor directory.
  // The probes are separator-tolerant the way the real fs is (Windows accepts both).
  const key = (p: string): string => lc(p.replace(/[\\/]+/g, '\\'))
  const dirs = new Set(
    ['D:\\games\\EverQuest Legends', 'D:\\games\\EverQuest Legends\\Logs'].map(key)
  )
  const files = new Set(['D:\\games\\EverQuest Legends\\Logs\\eqlog_Gnut_qeynos.txt'].map(key))
  const probes = {
    isDir: (p: string) => dirs.has(key(p)),
    isFile: (p: string) => files.has(key(p)),
    hasCharacterLogs: (d: string) => key(d) === key('D:\\games\\EverQuest Legends\\Logs')
  }
  const expected = { root: 'D:\\games\\EverQuest Legends', logsDir: 'D:\\games\\EverQuest Legends\\Logs' }
  for (const picked of [
    'D:\\games\\EverQuest Legends',
    'D:\\games\\EverQuest Legends\\',
    'D:\\games\\EverQuest Legends\\Logs',
    'D:\\games\\EverQuest Legends\\Logs\\',
    'D:/games/EverQuest Legends/Logs',
    'D:\\games\\EverQuest Legends\\Logs\\eqlog_Gnut_qeynos.txt'
  ]) {
    assertResolves(normalizeEqDirOverride(picked, probes), expected, picked)
  }
  // An unplugged drive: neither file nor dir ⇒ unchanged, old behavior.
  assert.deepEqual(normalizeEqDirOverride('Z:\\nope', probes), {
    root: 'Z:\\nope',
    logsDir: join('Z:\\nope', 'Logs')
  })
})

test('discoverEqRoot: end-to-end with the real rootHasLogs predicate over a temp drive layout', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'eq-disc2-'))
  try {
    // Simulate a "drive" dir that contains the Daybreak public sub-path with logs.
    const install = join(
      tmp,
      'Users',
      'Public',
      'Daybreak Game Company',
      'Installed Games',
      'EverQuest Legends'
    )
    mkdirSync(join(install, 'Logs'), { recursive: true })
    writeFileSync(join(install, 'Logs', 'eqlog_Primitive_freeport.txt'), '[Sat] hi\n')

    // Point the extra-candidate probe at the temp install root directly (the drive
    // sweep uses Windows-only `<drive>\...` paths, so we feed the real predicate a
    // POSIX temp path via extraCandidates to keep the test OS-agnostic).
    const root = discoverEqRoot({
      hasLogs: rootHasLogs,
      extraCandidates: () => [install, join(tmp, 'nope')],
      fixedDrives: () => []
    })
    assert.equal(root, install)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
