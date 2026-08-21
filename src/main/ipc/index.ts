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
import { registerBuffAllowIpc } from './buffAllow'
import { registerBuffTrustIpc } from './buffTrust'
import { registerResistIpc } from './resist'
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
import { registerAlertBannerIpc } from '../alertBanner'
// The con card's close channel and its trigger seam (JOS-383). Beside the window it feeds
// (src/main/conCard.ts), like the two producer registrations above it.
import { registerConCardIpc } from '../conCard'
// The tray popover's three sends (JOS-139). Beside the window they come from (src/main/tray.ts),
// like the toast's producer channel above, rather than in a fourth file in this folder.
import { registerTrayIpc } from '../tray'
import { registerWindowIpc } from './windowControls'
import { registerWorldIpc } from './world'

export function registerIpc(): void {
  registerCharacterIpc()
  // UNGATED SINCE JOS-327. This line read `if (UNRELEASED) …` from JOS-45 until the owner released
  // the Character tab as the gear area's last face; the channel is an ordinary one now. The flag
  // itself survives, tenantless, for whatever surface lands on main before its review next
  // (../unreleased.ts explains what it is for and how to adopt it).
  registerCharacterSheetIpc()
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
  registerAlertBannerIpc()
  registerConCardIpc()
  registerTrayIpc()
  registerClipboardIpc()
  registerFeedbackIpc()
  registerTelemetryIpc()
  registerPerfIpc()
  registerGraphicsIpc()
  registerBuffTrustIpc()
  registerBuffAllowIpc()
  registerRespawnIpc()
  registerResistIpc()
  registerUiScaleIpc()
  registerReleaseNotesIpc()
  // Registered in EVERY build, and a no-op in a packaged one — the refusal lives inside the
  // handler rather than around this call, so it is a decision a test can watch being made.
  // See ./dev.ts.
  registerDevIpc()
}
