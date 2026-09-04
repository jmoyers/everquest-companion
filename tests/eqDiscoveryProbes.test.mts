// DISCOVERY'S REAL-ENVIRONMENT PROBES: no reg.exe, no wmic (JOS-184).
//
// Discovery answers two questions about the actual machine, and it used to answer both by SPAWNING:
// eight `reg.exe query <hive> /s /f EverQuest /t REG_SZ` subprocesses whose stdout was regex-grepped
// for install paths, and one `wmic logicaldisk get DeviceID,DriveType` for the drive letters to
// sweep. Both now read IN-PROCESS through `native-reg`. That was an AV decision as much as a speed
// one — "unsigned exe sweeps the uninstall registry and enumerates disks moments after install" is
// the behavioural signature a heuristic engine scores — so what has to be pinned is that the ANSWER
// did not change with the mechanism.
//
// Two layers here:
//   1. the PURE decoders — a registry value → an install candidate, mount-table value names → drive
//      roots — which is where the whole behavioural contract with the old `reg.exe` command lives,
//      and which is testable to the character without a machine;
//   2. the probes that really talk to the registry, asserted on SHAPE and INVARIANTS rather than on
//      a specific answer, because their answer is a property of the box (most machines have no
//      Daybreak keys at all — the documented normal — and CI's has none either).
//
// The ordered sweep those probes feed is in eqDiscovery.test.mts; the cross-launch cache in
// eqDiscoveryCache.test.mts. Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  driveLettersFromMountedDevices,
  eqInstallDirFromFileValue,
  eqInstallPathValue,
  fixedDrives,
  networkDriveLetters,
  registryInstallCandidates
} from '../src/main/log/discovery'

// --- the registry decoder ---------------------------------------------------

test('eqInstallPathValue: keeps a path that names the game, in the same cases reg.exe /f did', () => {
  // THE INHERITED CONTRACT, verified against the real `reg.exe` on 10.0.22631 rather than read off
  // the docs: `reg query <key> /s /f EverQuest /t REG_SZ` prints one line per REG_SZ value whose
  // NAME or DATA contains "everquest" case-insensitively — and with `/t` present a KEY-NAME match
  // prints nothing at all (`…\CurrentVersion /s /f RunMRU /t REG_SZ` finds 0 matches although the
  // RunMRU key exists; drop `/t` and it finds 1, the key line alone and none of its values). Since
  // "InstallLocation" / "InstallPath" / "InstallDir" never contain "everquest" themselves, the old
  // line regex could only ever fire on a DATA match. That is exactly this function.
  assert.equal(
    eqInstallPathValue('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Everquest F2P'),
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Everquest F2P'
  )
  assert.equal(
    eqInstallPathValue(
      'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'
    ),
    'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'
  )
  // Trimmed, exactly as the old line regex's trailing `\s*$` did.
  assert.equal(eqInstallPathValue('  D:\\EverQuest  '), 'D:\\EverQuest')
  // A Daybreak launcher path that never says EverQuest was NOT a candidate before and is not now.
  assert.equal(eqInstallPathValue('C:\\Program Files\\Daybreak Game Company'), null)
  // Empty / whitespace-only / non-string values (a REG_DWORD, a REG_MULTI_SZ, an absent value).
  assert.equal(eqInstallPathValue(''), null)
  assert.equal(eqInstallPathValue('   '), null)
  assert.equal(eqInstallPathValue(null), null)
  assert.equal(eqInstallPathValue(undefined), null)
  assert.equal(eqInstallPathValue(1), null)
  assert.equal(eqInstallPathValue(['C:\\EverQuest']), null)
})

test('eqInstallDirFromFileValue: the Daybreak launcher states the install dir as a FILE in it', () => {
  // THE REGRESSION THIS EXISTS FOR, verbatim from the reporting machine (Windows 11 10.0.26200,
  // 2026-08-17): a real `D:\Games\EverQuest Legends` install that discovery missed completely,
  // because the launcher's Uninstall key carries NO InstallLocation/InstallPath/InstallDir. Both
  // of the values it does carry name the folder one `dirname` up.
  assert.equal(
    eqInstallDirFromFileValue('D:\\Games\\EverQuest Legends\\Uninstaller.exe'),
    'D:\\Games\\EverQuest Legends'
  )
  assert.equal(
    eqInstallDirFromFileValue('D:\\Games\\EverQuest Legends\\Everquest.ico'),
    'D:\\Games\\EverQuest Legends'
  )
  // The three command-line shapes, in the order `programPathFromCommand` tries them.
  // 1. QUOTED program path with arguments after it — the only unambiguous split.
  assert.equal(
    eqInstallDirFromFileValue('"C:\\Games\\EverQuest\\Uninstall EverQuest.exe" /currentuser'),
    'C:\\Games\\EverQuest'
  )
  // 2. DisplayIcon's icon INDEX, positive and negative.
  assert.equal(eqInstallDirFromFileValue('D:\\Games\\EverQuest\\EQ.exe,0'), 'D:\\Games\\EverQuest')
  assert.equal(eqInstallDirFromFileValue('D:\\Games\\EverQuest\\EQ.exe,-101'), 'D:\\Games\\EverQuest')
  // 3. UNQUOTED, with arguments, and a SPACE IN THE PATH — the shape that makes splitting on
  //    whitespace wrong. The extension is the cut, and it is lazy, so an argument that is itself a
  //    path cannot extend the match.
  assert.equal(
    eqInstallDirFromFileValue('D:\\Games\\EverQuest Legends\\Uninstaller.exe /S'),
    'D:\\Games\\EverQuest Legends'
  )
  assert.equal(
    eqInstallDirFromFileValue('D:\\Games\\EverQuest\\un.exe /log C:\\other\\place.exe'),
    'D:\\Games\\EverQuest'
  )
  // Forward slashes: these values reach us from installers of every vintage.
  assert.equal(eqInstallDirFromFileValue('D:/Games/EverQuest/un.exe'), 'D:/Games/EverQuest')

  // THE FILTER IS THE SAME ONE, ON THE RAW VALUE — a path that never names the game is not a
  // candidate however well-formed it is.
  assert.equal(eqInstallDirFromFileValue('C:\\Program Files\\Steam\\steam.exe'), null)
  // No recognizable extension ⇒ null, never a guess at where the path ends.
  assert.equal(eqInstallDirFromFileValue('D:\\Games\\EverQuest\\somefile'), null)
  // A bare filename has no containing directory to offer.
  assert.equal(eqInstallDirFromFileValue('EverQuest.exe'), null)
  // An unterminated quote is malformed, not a path.
  assert.equal(eqInstallDirFromFileValue('"D:\\Games\\EverQuest\\un.exe'), null)
  // Empty / whitespace-only / non-string values, exactly as `eqInstallPathValue` refuses them.
  assert.equal(eqInstallDirFromFileValue(''), null)
  assert.equal(eqInstallDirFromFileValue('   '), null)
  assert.equal(eqInstallDirFromFileValue(null), null)
  assert.equal(eqInstallDirFromFileValue(undefined), null)
  assert.equal(eqInstallDirFromFileValue(1), null)
  assert.equal(eqInstallDirFromFileValue(['D:\\EverQuest\\un.exe']), null)
})

test('registryInstallCandidates: reads the machine in-process, never throws, honours the ceiling', () => {
  // The real probe against the real registry. Two properties must hold on ANY box: every candidate
  // names the game, and an already-spent deadline stops it dead — that deadline is JOS-112's
  // boot-hang ceiling, which now bounds a loop instead of a queue of subprocesses.
  const found = registryInstallCandidates(Date.now() + 6000)
  assert.ok(Array.isArray(found))
  for (const p of found) {
    assert.equal(typeof p, 'string')
    assert.ok(/everquest/i.test(p), `candidate should name the game: ${p}`)
  }
  assert.deepEqual(registryInstallCandidates(Date.now() - 1), [], 'a spent budget reads nothing')
})

// --- the drive-topology decoders --------------------------------------------

test('driveLettersFromMountedDevices: DosDevices entries become drive roots, volume GUIDs do not', () => {
  // Verbatim shapes from HKLM\SYSTEM\MountedDevices on 10.0.22631: mounted letters are named
  // `\DosDevices\<letter>:`, and the same volumes appear again under `\??\Volume{guid}` with no
  // letter. Only the first kind is somewhere the sweep can look.
  const roots = driveLettersFromMountedDevices([
    '\\DosDevices\\C:',
    '\\??\\Volume{f3d6e5ba-2f77-11f0-a7fc-70d823972a5b}',
    '\\DosDevices\\D:',
    '\\??\\Volume{fe0be83d-4960-11f0-a7fe-70d823972a5b}',
    '\\DosDevices\\E:'
  ])
  assert.deepEqual(roots, ['C:', 'D:', 'E:'])
})

test('driveLettersFromMountedDevices: sorted, de-duplicated, case-folded, empty when nothing matches', () => {
  assert.deepEqual(driveLettersFromMountedDevices(['\\DosDevices\\d:', '\\DosDevices\\C:']), [
    'C:',
    'D:'
  ])
  assert.deepEqual(driveLettersFromMountedDevices(['\\DosDevices\\C:', '\\DosDevices\\c:']), ['C:'])
  assert.deepEqual(driveLettersFromMountedDevices([]), [])
  assert.deepEqual(
    driveLettersFromMountedDevices(['\\DosDevices\\CD:', '#{GUID}', '\\DosDevices\\']),
    []
  )
})

test('networkDriveLetters: HKCU\\Network subkeys are the letters the fallback sweep must not touch', () => {
  // A mapped network drive is never in MountedDevices, which is what makes the primary path safe.
  // This list is the FALLBACK's version of the same guard: the A-Z existence sweep must never
  // existsSync an OFFLINE share and block on the SMB timeout — the JOS-112 hang, which the old
  // wmic fallback had no defence against at all.
  const mapped = networkDriveLetters(['Z', 'y', 'NotALetter', ''])
  assert.deepEqual([...mapped].sort(), ['Y', 'Z'])
})

test('fixedDrives: always answers with at least one local drive root, and memoizes it', () => {
  const drives = fixedDrives()
  assert.ok(drives.length > 0, 'the sweep must always have somewhere to look')
  for (const d of drives) assert.match(d, /^[A-Z]:$/)
  // Memoized for the process — the idle rescan calls this every couple of seconds.
  assert.deepEqual(fixedDrives(), drives)
})
