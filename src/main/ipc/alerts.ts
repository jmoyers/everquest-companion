// IPC: the alerts extension (Task #18) and the event-log feed (Task #59) it writes into.
// They share a domain because an alert fire IS a feed row — the registry host folds one into
// the other, and both of the renderer-originated reports below end with the same flushNow.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { normalizeEarlyWarnSec } from '../../shared/earlyWarning'
// THE ENGINE'S COPY OF THE SAME PREFERENCE (JOS-482, boundary verdict 3). Additive: the store is
// still persistence truth and `alertsModule.setDefs` is still what keeps THIS process's evaluator in
// sync — the push is a fourth line after those two, and it is a no-op on a launch that asked for no
// engine. See dataServer/appKnowledge.ts for why the payload is not threaded through here.
import { pushAppKnowledge } from '../dataServer/definePush'
import { alertsModule, eventFeedModule, registry } from '../pipeline'
import {
  deleteAlert,
  getAlertPrefs,
  getAlerts,
  resetAlerts,
  saveAlert,
  setAlertPrefs
} from '../store'
import type { AlertDef, AlertPrefs, FeedReport } from '../../shared/types'

/**
 * Re-validate the ONE renderer-supplied enum on a saved def. `cooldownScope` reaches the
 * evaluator's Map-key logic, so main states the legal values itself rather than trusting them
 * because today's only caller is the app's own dialog (the same rule `sounds:getData`'s packId
 * follows). Anything else is DROPPED, not rejected: absent means 'alert', which is the safe
 * reading, and the rest of the def still saves.
 */
function sanitizeCooldownScope(def: AlertDef): AlertDef {
  if (def.cooldownScope === undefined) return def
  if (def.cooldownScope === 'alert' || def.cooldownScope === 'target') return def
  const clean = { ...def }
  delete clean.cooldownScope
  return clean
}

/**
 * Re-validate the early-warning offset (JOS-216) — the same rule, for the same reason: the number
 * reaches a scheduler, so main states the legal range itself rather than trusting the dialog's own
 * bounds. Out of range or not a number ⇒ the key is DROPPED, which reads as "no early warning" and
 * is the safe answer; the rest of the def still saves.
 */
function sanitizeEarlyWarn(def: AlertDef): AlertDef {
  if (def.earlyWarnSec === undefined) return def
  const sec = normalizeEarlyWarnSec(def.earlyWarnSec)
  if (sec === def.earlyWarnSec) return def
  const clean = { ...def }
  if (sec === undefined) delete clean.earlyWarnSec
  else clean.earlyWarnSec = sec
  return clean
}

export function registerAlertsIpc(): void {
  ipcMain.handle(IPC.listAlerts, () => getAlerts())
  ipcMain.handle(IPC.saveAlert, (_e, def: AlertDef) => {
    const list = saveAlert(sanitizeEarlyWarn(sanitizeCooldownScope(def)))
    alertsModule.setDefs(list) // keep the live evaluator in sync
    pushAppKnowledge('alerts.define') // …and the engine's, when there is one
    return list
  })
  ipcMain.handle(IPC.deleteAlert, (_e, id: string) => {
    const list = deleteAlert(id)
    alertsModule.setDefs(list)
    pushAppKnowledge('alerts.define')
    return list
  })
  // test = return the def so the renderer plays its sound directly (no live fire).
  ipcMain.handle(IPC.testAlert, (_e, id: string) => getAlerts().find((a) => a.id === id) ?? null)
  // reset all alerts to the seeded built-in set (Task #22).
  ipcMain.handle(IPC.resetAlerts, () => {
    const list = resetAlerts()
    alertsModule.setDefs(list)
    pushAppKnowledge('alerts.define')
    return list
  })
  // renderer reports an 'app'-triggered fire (bossDefeat) so the module's recent-
  // fires history stays the single source of truth. We record it and flush so the
  // fire rides the same module:delta transport event/raw fires use (Task #22).
  ipcMain.on(IPC.appFired, (_e, payload: { alertId: string; context: string }) => {
    if (!payload?.alertId) return
    alertsModule.appFired(payload.alertId, payload.context ?? '')
    // The alerts delta this flush emits is folded into the event feed by feedAlertDelta (the
    // registry host), so an app-signal fire (bossDefeat / questComplete) shows up in the
    // event log exactly like a main-side event/raw fire. eventFeed is registered after
    // alerts, so the resulting feed row rides out on this same flush.
    registry.flushNow()
  })
  // ---- event feed (Task #59): renderer-detected events ----
  // Only the renderer's posky/turn-in machinery can see a Sky quest complete, so it reports
  // completions here. Main owns the ring + ids; flushNow pushes the row straight out to the
  // 'events' overlay instead of waiting on the next log event / 1s tick.
  ipcMain.on(IPC.feedReport, (_e, report: FeedReport) => {
    if (!report?.title) return
    eventFeedModule.report(report)
    registry.flushNow()
  })

  ipcMain.handle(IPC.getAlertPrefs, () => getAlertPrefs())
  ipcMain.handle(IPC.setAlertPrefs, (_e, prefs: AlertPrefs) => setAlertPrefs(prefs))
}
