// THE SHIPPED APP LAUNCHES NO PROCESSES AT ALL (JOS-182 + JOS-184).
//
// Two tickets, one week, the same defect wearing two costumes. The presence watcher was a hidden
// `powershell.exe` (`-ExecutionPolicy Bypass -EncodedCommand <base64>`) that compiled C# at
// runtime and enumerated every process on the machine; EQ-folder discovery shelled out to
// `reg.exe query … /s /f EverQuest` eight times and to `wmic logicaldisk`. To a behavioural
// antivirus engine each of those is a paragraph of an infostealer's résumé, and between them they
// made this app the most-flagged thing its author had ever shipped. They also simply DID NOT WORK
// on locked-down machines — hundreds of installs' worth of `ENOENT` — where the features they
// served were silently dead for every session.
//
// Both were replaced by native code called IN PROCESS, which is what every other Windows program
// does to ask the same questions. What is left is one property, and it is a property of the whole
// source tree rather than of any module, so this file reads the tree:
//
//   ** NOTHING UNDER src/ MAY START A PROCESS. **
//
// It is a guard rather than a note because the pressure to add "just one `execFileSync`" never
// goes away — the next Windows fact somebody needs will have a one-line command-line answer and a
// twenty-line native one, and this file is where that trade is forced into the open. If a future
// ticket genuinely needs to launch something, it adds itself to `SPAWNERS` below with its reason
// in the same breath.
//
// `tests/presence.test.mts` pins what the presence watcher DOES and `tests/presenceWorker.test.mts`
// runs it; neither can see this, because neither reads a file it did not import.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/**
 * THE ONE EXEMPTION, and it is prose rather than a loophole.
 *
 * `shared/releaseNotes.ts` is the app's own history, rendered in the What's-new panel. The release
 * that removed the PowerShell watcher has to be able to SAY so — a note that cannot name the thing
 * it took away is a note that explains nothing to the player whose antivirus was shouting at them.
 * Nothing in that module is executable in any sense; it is a list of sentences.
 */
const NOT_CODE = new Set(['shared/releaseNotes.ts'])

/**
 * THE SECOND EXEMPTION, AND IT IS THREE SENTENCES RATHER THAN A FILE (JOS-421).
 *
 * The guard above is about what this app RUNS, and nothing here changes that answer: the app still
 * starts no process, which the second test in this file is what actually proves. What changed is
 * that a process somebody ELSE starts can now be described. electron-updater verifies the
 * downloaded installer's Authenticode signature by shelling out to PowerShell from inside its own
 * module, and on machines whose security software guts that call it comes back empty and the
 * update dies — ~330 error reports across every version since 0.28.0, the fleet's largest family
 * (src/shared/update.ts's JOS-421 block reads the library source).
 *
 * The user is the only person who can fix that, so the app has to be able to say what was blocked.
 * It is the releaseNotes argument exactly: a message that cannot name the thing it is about
 * explains nothing to the player whose antivirus is shouting at them.
 *
 * WHY EXACT SENTENCES AND NOT `NOT_CODE`. `shared/update.ts` IS code, and the pressure this file
 * exists to resist is a new `execFile` — so the file must stay under the guard. An allowlist of
 * literal texts keeps every unwritten string in it (and everywhere else) failing, and the
 * reached-assertion below means a reworded sentence comes back here to be re-argued rather than
 * silently inheriting the exemption.
 */
const SAYS_POWERSHELL = new Set([
  "Security software on this PC blocked the update's PowerShell signature check, so the new version could not be verified. Nothing is wrong with your install - the next check will try again.",
  "Security software on this PC keeps blocking the update's PowerShell signature check. Automatic updates are paused - allow PowerShell, or install the new version by hand.",
  "security software or policy is blocking this PC's PowerShell signature check - the next check retries, and the user is told"
])

/** A path relative to src/, spelled the same way on every platform. */
function key(file: string): string {
  return relative(SRC_ROOT, file).replace(/\\/g, '/')
}

/** Every .ts/.tsx under src/, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** The text of every string literal and template chunk in a file — i.e. what the program can say,
 *  as opposed to what its author wrote about. */
function literalText(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      found.push(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return found
}

test('NO SHIPPED CODE CAN NAME POWERSHELL — the watcher launches nothing at all now', () => {
  const files = sourceFiles(SRC_ROOT)
  assert.ok(files.length > 100, 'the walk found the tree, or this test proves nothing')
  const offenders: string[] = []
  let exempted = 0
  const saidPowerShell = new Set<string>()
  for (const file of files) {
    if (NOT_CODE.has(key(file))) {
      exempted++
      continue
    }
    for (const text of literalText(file)) {
      if (!/powershell|pwsh/i.test(text)) continue
      // The narrow exemption: the three sentences that TELL THE USER their security software
      // blocked electron-updater's own signature check (see `SAYS_POWERSHELL`). Every other
      // literal, in this file or any other, is still an offender.
      if (SAYS_POWERSHELL.has(text)) {
        saidPowerShell.add(text)
        continue
      }
      offenders.push(`${key(file)}: ${JSON.stringify(text.slice(0, 80))}`)
    }
  }
  assert.deepEqual(offenders, [], 'a string literal names PowerShell')
  // The exemptions must still be REACHED, or a rename would silently turn them into guards over
  // nothing while looking exactly as green as they do today.
  assert.equal(exempted, NOT_CODE.size, 'every exempt file is still there to be exempted')
  assert.deepEqual(
    [...saidPowerShell].sort(),
    [...SAYS_POWERSHELL].sort(),
    'every exempt sentence is still shipped verbatim — reword one and re-argue it here'
  )
})

/**
 * The one module allowed to launch a process, and it is not in a shipped build.
 *
 * `src/main/triage/store.ts` runs `terraform output -json` for the operator's backlog client. It
 * is reached only through a dynamic import gated on `!app.isPackaged`, and its dependencies are
 * devDependencies that electron-builder never installs — so in a packaged app the require cannot
 * resolve at all. That is a property of the PACKAGING, not a promise about a boolean, and it is
 * spelled out at the `externalizeDeps` line in electron.vite.config.ts.
 */
const SPAWNERS = new Set(['main/triage/store.ts'])

/** Every module specifier a file imports or re-exports. */
function importSpecifiers(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    const spec =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined
    if (spec !== undefined && ts.isStringLiteral(spec)) out.push(spec.text)
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

test('NOTHING UNDER src/ CAN START A PROCESS — one exemption, and it never ships', () => {
  const files = sourceFiles(SRC_ROOT)
  const offenders: string[] = []
  let exempted = 0
  for (const file of files) {
    const name = key(file)
    // Both spellings: `child_process` and the `node:` prefix the tree is migrating towards.
    const spawns = importSpecifiers(file).filter((spec) => /^(node:)?child_process$/.test(spec))
    if (spawns.length === 0) continue
    if (SPAWNERS.has(name)) {
      exempted++
      continue
    }
    offenders.push(`${name}: ${spawns.join(', ')}`)
  }
  assert.deepEqual(offenders, [], 'a module imports a child-process API')
  // The exemption must still be REACHED. Without this, deleting the triage client would leave a
  // guard standing over nothing, looking exactly as green as it does today.
  assert.equal(exempted, SPAWNERS.size, 'every exempt module is still there to be exempted')
})
