// ============================================================================
// smokeFeedback.ts — the post-release END-TO-END smoke hook. Opt-in, env-gated, tiny.
// ============================================================================
//
// WHAT THIS IS: automation of exactly ONE thing the user can already do by hand — open the
// feedback dialog, type a sentence, leave "attach a log slice" ticked, and press Send. Nothing
// more. It exists so that a HUMAN does not have to do that by hand against every published
// installer just to learn whether the release's feedback pipeline is alive end to end.
//
// WHAT IT IS EMPHATICALLY NOT: a test hook that reaches around the product. It calls
// `submitFeedback` — the same function the IPC handler calls for the dialog's Send button —
// and therefore goes through EVERY normal layer: the shared validator, the per-install daily
// quota, the server-side kill switch, the presign, and `allowedUploadUrl`'s bucket pin. There
// is NO endpoint override of any kind here and there must never be one: an overridable ingest
// URL is an exfiltration primitive (feedback/net.ts says so at length), and a smoke test that
// pointed somewhere else would prove nothing about the pipeline a user's reports travel.
//
// The DECISIONS (armed or not, what the description says, which outcome that was) live next
// door in `smokeGate.ts`, which imports no Electron and is unit-tested. What is left here is
// the side effects: one submit, one line of stdout, one quit.
//
// IT QUITS AFTERWARDS, on ANY outcome including a failure. The caller is a disposable VM whose
// whole job was this one report; leaving a GUI process alive there just makes the harness wait
// out a timeout instead of reading an answer.
//
// THE OUTCOME GOES TO STDOUT because that is the only channel out of a packaged app that
// needs no new IPC, no file format and no privilege. On Windows an Electron app is a
// GUI-subsystem binary with no attached console, so the guest launches it with
// `Start-Process -RedirectStandardOutput`, which does hand the child a real stdout handle.
// See scripts/sandbox/smoke-feedback.ps1.

import { app } from 'electron'
import { E2E } from './e2e'
import { logError } from './errorLog'
import { submitFeedback } from './feedback'
import { SMOKE_RESULT_PREFIX, SMOKE_WINDOW_MINUTES, smokeDescription, smokeNonce, smokeResultLine } from './smokeGate'

export {
  SMOKE_ENV,
  SMOKE_RESULT_PREFIX,
  SMOKE_WINDOW_MINUTES,
  smokeDescription,
  smokeNonce,
  smokeOutcome,
  smokeResultLine,
  type SmokeOutcome
} from './smokeGate'

/**
 * File the one report, say what happened, quit.
 *
 * Called from the composition root AFTER the tail has attached and the first scan has settled,
 * so the mocked log the harness planted is the resolved active character and there is a slice
 * to attach. No-op — and zero cost — on every launch that is not a smoke run.
 *
 * `submitFeedback` never rejects (that is its documented contract), so the catch here is
 * belt-and-braces: reaching it means a BUG, and a bug must still leave a verdict behind rather
 * than hang the VM until the host's timeout expires.
 */
export async function runSmokeFeedback(): Promise<void> {
  const nonce = smokeNonce(process.env, E2E)
  if (nonce === null) return
  let line: string
  try {
    const res = await submitFeedback(
      { type: 'bug', description: smokeDescription(nonce) },
      // `attachInventory: false`, deliberately (JOS-296). The smoke guest stages ONE artifact —
      // a mocked `eqlog_Smoketest_freeport.txt` (scripts/sandbox/smoke-feedback.ps1) — and no
      // `/outputfile inventory` dump, so the second leg could only ever report "no dump" and
      // would add a field to the result line that is always false. The slice leg already proves
      // the thing this hook exists to prove: presign, bucket pin, upload. Stage a dump beside
      // the log in that script and flip this to `true` if the inventory leg ever needs its own
      // released-installer proof. `attachAchievements: false` (JOS-441) for the identical reason
      // — the smoke guest stages no achievements export either.
      {
        attachLog: true,
        windowMinutes: SMOKE_WINDOW_MINUTES,
        attachInventory: false,
        attachAchievements: false
      }
    )
    line = smokeResultLine(nonce, res)
  } catch (err) {
    logError('main:smoke', err)
    line = `${SMOKE_RESULT_PREFIX} outcome=error nonce=${nonce} reportId= error=threw`
  }
  process.stdout.write(`${line}\n`)
  app.quit()
}
