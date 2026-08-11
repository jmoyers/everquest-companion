// ============================================================================
// ipc/ — the main process's IPC surface, one module per domain.
// ============================================================================
//
// `registerIpc()` is called ONCE from the composition root, inside `app.whenReady()` and
// BEFORE the first window is created, so no renderer can ever invoke a channel that has not
// been registered yet.
//
// The domains are independent: `ipcMain.handle`/`.on` key off the channel name, so the order
// of the calls below carries no semantics (unlike module registration order, which is bus
// delivery order — see pipeline.ts). It is kept in the order the handlers were originally
// written purely so the surface reads the same way it always did.
//
// Every channel name lives in `src/shared/ipc.ts`; nothing here invents one.

import { registerAlertsIpc } from './alerts'
import { registerBuffTrustIpc } from './buffTrust'
import { registerRespawnIpc } from './respawn'
import { registerCharacterIpc } from './character'
import { registerCharacterSheetIpc } from './characterSheet'
import { registerClipboardIpc } from './clipboard'
import { registerComboIpc } from './combo'
import { registerDevIpc } from './dev'
import { registerFeedbackIpc } from './feedback'
import { registerGraphicsIpc } from './graphics'
import { registerKnowledgeIpc } from './knowledge'
import { registerMapsIpc } from './maps'
import { registerOutputsIpc } from './outputs'
import { registerPerfIpc } from './perf'
import { registerPlannerIpc } from './planner'
import { registerPresenceIpc } from './presence'
import { registerReleaseNotesIpc } from './releaseNotes'
import { registerRosterIpc } from './roster'
import { registerShareIpc } from './share'
import { registerSoundsIpc } from './sounds'
import { registerSpeechIpc } from './speech'
import { registerTelemetryIpc } from './telemetry'
import { registerUiScaleIpc } from './uiScale'
// The celebration toast's producer channel. It lives beside the window it feeds (src/main/toast.ts)
// rather than in this folder, because everything it does is window fan-out + item resolution.
import { registerToastIpc } from '../toast'
import { registerWindowIpc } from './windowControls'
import { registerWorldIpc } from './world'
import { UNRELEASED } from '../unreleased'

export function registerIpc(): void {
  registerCharacterIpc()
  // GATED (JOS-45): the character sheet has not passed the owner's review gate, so its channel
  // exists only in a dev build (or under an explicit EQ_UNRELEASED=1). The renderer surface is
  // stripped from production bytes independently; this is the second lock. See ../unreleased.ts.
  if (UNRELEASED) registerCharacterSheetIpc()
  registerOutputsIpc()
  registerWorldIpc()
  registerComboIpc()
  registerRosterIpc()
  registerAlertsIpc()
  registerShareIpc()
  registerSoundsIpc()
  registerSpeechIpc()
  registerKnowledgeIpc()
  registerPlannerIpc()
  registerMapsIpc()
  registerPresenceIpc()
  registerWindowIpc()
  registerToastIpc()
  registerClipboardIpc()
  registerFeedbackIpc()
  registerTelemetryIpc()
  registerPerfIpc()
  registerGraphicsIpc()
  registerBuffTrustIpc()
  registerRespawnIpc()
  registerUiScaleIpc()
  registerReleaseNotesIpc()
  // Registered in EVERY build, and a no-op in a packaged one — the refusal lives inside the
  // handler rather than around this call, so it is a decision a test can watch being made.
  // See ./dev.ts.
  registerDevIpc()
}
