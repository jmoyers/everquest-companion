// Central registry of IPC channel names so main/preload/renderer stay in sync.

export const IPC = {
  // ---- module transport (the one pattern for loot/turnins/kills/leveling/character) ----
  // renderer -> main
  getModuleSnapshot: 'module:getSnapshot',
  // main -> renderer
  onModuleDelta: 'module:delta',

  // ---- progress / inventory (per-character persisted state) ----
  getProgress: 'progress:get',
  reloadInventory: 'inventory:reload',
  // renderer -> main: this quest's turn-ins, as the instants they happened at (JOS-131). It
  // replaced `progress:setQuestComplete` when completion became a COUNT rather than a flag.
  setQuestTurnIns: 'progress:setQuestTurnIns',
  // main -> renderer: progress changed (quest completion / inventory), so every
  // view that shows progress stays consistent without re-fetching on a timer.
  onProgress: 'progress:changed',
  // main -> renderer: the active character's *-Inventory.txt was auto-reloaded.
  onInventoryReload: 'inventory:autoReloaded',

  // ---- `/outputfile` exports (JOS-44: one treatment for every export command) ----
  // renderer -> main: every `/outputfile` kind the app knows, joined to the active character's
  // file on disk. Returns OutputFileStatus[] (shared/outputs/kinds.ts): the command to type, one
  // clause of why, and the FILE's own mtime — null when the command has never been run here.
  // Read on demand (a readdir + a stat); the renderer re-asks on `inventory:autoReloaded` so a
  // dump written in game ages back to "just now" without a click.
  outputsStatus: 'outputs:status',

  // ---- character selection ----
  getCharacter: 'character:get',
  listCharacters: 'character:list',
  setCharacter: 'character:set',

  // ---- EQ install-dir discovery + override (Settings gear) ----
  // renderer -> main: read the effective EQ config (root + how it resolved + log count).
  getEqConfig: 'eqconfig:get',
  // renderer -> main: open the OS folder-picker; on pick, persist the override + re-list.
  pickEqDir: 'eqconfig:pick',
  // renderer -> main: open the OS FILE-picker on `eqlog_*.txt` (JOS-82). Windows' folder
  // picker shows no files at all, so the folder button alone cannot answer "I can see the
  // log right there in Explorer". Same persist + re-list tail as pickEqDir.
  pickEqLogFile: 'eqconfig:pickFile',
  // renderer -> main: set the override to an explicit dir (undefined/'' ⇒ auto-detect).
  setEqDir: 'eqconfig:set',
  // renderer -> main: clear the override (revert to auto-discovery).
  resetEqDir: 'eqconfig:reset',
  // main -> renderer: the effective EQ config changed (override applied/cleared),
  // so the Settings dialog + any config-derived UI refresh.
  onEqConfigChanged: 'eqconfig:changed',

  // ---- combat (its own snapshot transport — see modules/types.ts) ----
  getCombatSnapshot: 'combat:snapshot',
  onCombatActivity: 'combat:activity',
  // renderer -> main: fuzzy-search the WHOLE (uncapped) fight history + the live fight by
  // name/zone (Task #61). Args: (text, limit?). Returns FightSearchResult.
  searchFights: 'combat:searchFights',

  // ---- alerts extension (Task #18) ----
  // CRUD over alert defs + global sound prefs (renderer -> main).
  listAlerts: 'alerts:list',
  saveAlert: 'alerts:save',
  deleteAlert: 'alerts:delete',
  // test = renderer plays the alert's sound directly (main just echoes the def).
  testAlert: 'alerts:test',
  // reset all alert defs back to the seeded built-in set (Task #22).
  resetAlerts: 'alerts:reset',
  // renderer reports an 'app'-triggered fire (e.g. bossDefeat) so the module's
  // history stays the single source of truth (Task #22). Payload {alertId, context}.
  appFired: 'alerts:appFired',
  getAlertPrefs: 'alertPrefs:get',
  setAlertPrefs: 'alertPrefs:set',
  // sound packs (discovery + audio bytes)
  listSoundPacks: 'sounds:listPacks',
  getSoundData: 'sounds:getData',
  // "bring your own sound" (JOS-68): the user's OWN audio, in the reserved `my-sounds` pack.
  // NO PATH EVER CROSSES THESE. `importUserSounds` opens the OS picker in MAIN and answers
  // with minted soundIds + display labels; `removeUserSound` takes a manifest KEY, never a
  // filename. The bytes are then served by `sounds:getData` like any other pack's — one
  // validated door, not a second one.
  listUserSounds: 'sounds:listUser',
  importUserSounds: 'sounds:importUser',
  removeUserSound: 'sounds:removeUser',
  // main -> renderer: the set of available sound packs changed (e.g. a shipped
  // default pack was auto-provisioned in the background at startup — Task #39). The
  // renderer re-lists packs + invalidates its sound caches so it becomes usable live.
  onSoundPacksChanged: 'sounds:changed',
  // suggested-alerts wizard (Task #38): a slim, searchable spell catalog derived from
  // the scraped spell DB + live per-spell usage from the buffs module's snapshot.
  spellsCatalog: 'spells:catalog',

  // ---- voice alerts / TTS (docs/plans/voice-alerts.md §3) ----
  // The 'system' engine tier needs NO channel at all: Chromium's own `speechSynthesis` lives in
  // the renderer. These three exist for the DOWNLOADED tier (Kokoro), whose model, worker and
  // wav cache all live in main — and they ship as honest stubs until that wave lands, so the UI
  // can be written against a real, typed door instead of a promise.
  // renderer -> main: synthesize + cache one utterance. Arg: SpeechSayRequest (VALIDATED AT THE
  // HANDLER — text and voiceId are renderer strings and reach a cache key). Returns
  // SpeechSayResult: `{ok:true,url}` once an engine exists, `{ok:false,reason}` today.
  speechSay: 'speech:say',
  // renderer -> main: the voices the DOWNLOADED tier can speak with. Returns SpeechVoice[] —
  // empty until a tier is installed. System-tier voices come from `getVoices()`, not from here.
  speechVoices: 'speech:voices',
  // renderer -> main: provision an engine tier (pinned release, sha256-verified, atomic).
  // Arg: SpeechEngine. Returns SpeechInstallResult.
  speechInstall: 'speech:install',
  // renderer -> main: how many bytes provisioning a tier would download, so the button can say
  // the price before the user pays it. Arg: SpeechEngine. Returns a number (0 for a tier with
  // nothing to download). It is an IPC read rather than a shared constant because the sizes live
  // with the sha256s in main's pinned.ts — one file decides what we download, and a second copy
  // of the number in shared/ could drift from the bytes actually fetched.
  speechInstallSize: 'speech:installSize',
  // main -> renderer: where a RUNNING install is (W3). `speech:install` resolves only when a
  // ~120 MB download has finished, so the panel that started it needs somewhere to hear
  // 'downloading 40%' meanwhile. Payload: SpeechInstallProgress (shared/alertTypes.ts). Sent
  // only while an install is in flight, and its terminal phase always matches the invoke's
  // own verdict.
  onSpeechInstallProgress: 'speech:installProgress',
  // renderer -> main: read/write the global voice prefs blob (§2). Unlike the three above these
  // are REAL from day one — the store is main-owned, so the Preferences panel has no other door.
  // The setter re-clamps every field at the handler.
  voicePrefsGet: 'voicePrefs:get',
  voicePrefsSet: 'voicePrefs:set',

  // ---- sound-pack registry (openpeon.com integration, Task #29) ----
  // renderer -> main: list registry packs annotated with installed flags.
  packsRegistry: 'packs:registry',
  // renderer -> main: install a pack by name (streams progress via onPackProgress).
  packsInstall: 'packs:install',
  // renderer -> main: uninstall a user-installed pack by name.
  packsUninstall: 'packs:uninstall',
  // main -> renderer: install progress {name, phase, percent?, message?}.
  onPackProgress: 'packs:progress',
  // renderer -> main: preview a registry pack BEFORE install (Task #31).
  // list a pack's sounds (name -> PackPreviewList) …
  packsPreviewList: 'packs:previewList',
  // … and stream a single preview audio file's bytes (name, file -> SoundData).
  packsPreviewSound: 'packs:previewSound',

  // ---- frameless window controls (Task #23) ----
  // renderer -> main: title-bar buttons drive the (frameless) native window.
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close',
  // main -> renderer: maximize state changed (bool) so the max/restore icon swaps.
  onWindowMaximized: 'window:maximized',

  // ---- floating overlay DPS meter (Task #52; per-kind windows in Task #54) ----
  // All overlay channels carry an OverlayKind ('fight' | 'overall') as their first arg so the
  // two independent overlay windows are addressed separately.
  // renderer(main app) -> main: toggle a kind's overlay window open/closed. Arg: kind.
  overlayToggle: 'overlay:toggle',
  // renderer(main app) -> main: query the open-state map for all kinds. Returns Record<kind,bool>.
  overlayGetState: 'overlay:getState',
  // main -> renderer(main app): a kind's open-state changed. Payload: {kind, open}. Keeps the
  // TitleBar overlay menu in sync (also fires when an overlay closes itself).
  onOverlayState: 'overlay:state',
  // renderer(overlay) -> main: set click-through (locked) vs interactive. Args: kind, locked.
  overlaySetLocked: 'overlay:setLocked',
  // renderer(overlay) -> main: fine-grained mouse-event pass-through toggle used by the
  // hover sensor while locked. Args: kind, ignore (true = pass through, false = capture).
  overlaySetIgnoreMouse: 'overlay:setIgnoreMouse',
  // renderer(overlay) -> main: close the overlay from its own close button. Arg: kind.
  overlayClose: 'overlay:close',
  // renderer(overlay) -> main: read a kind's persisted config. Arg: kind. Returns OverlayConfig.
  overlayGetConfig: 'overlay:getConfig',
  // renderer(overlay) -> main: persist a kind's config (partial merge). Args: kind, patch.
  overlaySetConfig: 'overlay:setConfig',
  // main -> renderer(overlay): the persisted config changed. Payload: {kind, config}. The overlay
  // ignores pushes that aren't its own kind.
  onOverlayConfig: 'overlay:config',

  // ---- GLOBAL FIGHT SELECTION (docs/plans/combat-overlay-parity.md P4/P5/P6) ----
  // ONE fight is selected app-wide: picking one in the Combat tab's picker or in ANY
  // fight-scoped overlay selector writes it, and every fight-scoped surface follows. Main holds
  // it EPHEMERALLY (src/main/fightSelection.ts — resets to '__live__' at startup, never stored)
  // and is the only process that can reach every window, which is why this is IPC and not a
  // renderer-side broadcast.
  //
  // ZONE SESSIONS ARE NOT HERE, on purpose: an 'overall' / 'heal-overall' selector keeps its own
  // per-overlay selection and neither reads nor writes these channels (the ruling's carve-out).
  // Neither does selection ever change a surface's Fight-vs-Overall SCOPE (P5, the standing law).
  //
  // renderer(any window) -> main: read the current selection, for hydrating a surface that
  // mounted after the last change. Returns the id string.
  fightSelectionGet: 'fightSelection:get',
  // renderer(any window) -> main, FIRE-AND-FORGET: "the user picked this fight". The payload is
  // VALIDATED AT THE HANDLER against the shared model (`normalizeFightSelection`) — a non-string,
  // a zone-session id or anything hand-crafted is dropped rather than fanned out.
  fightSelectionSet: 'fightSelection:set',
  // main -> EVERY window: the selection changed. Payload {fightId}. Sent to the main window and
  // all overlay kinds; a window with no fight-scoped surface simply has no listener.
  onFightSelection: 'fightSelection:changed',

  // ---- cursor ring + overlay auto-hide (presence-driven settings) ----
  // Both blobs are main-owned (electron-store), so Preferences has no other door. The setters
  // are MERGE-PATCHES and every field is re-validated + clamped AT THE HANDLER through
  // `shared/presencePrefs.ts` — the same normalizer the store migration uses, so a renderer and
  // a hand-edited file can never disagree about what a valid ring is.
  // renderer(main app) -> main: read / patch the cursor-ring prefs. Returns CursorRingPrefs.
  cursorRingGet: 'cursorRing:get',
  cursorRingSet: 'cursorRing:set',
  // renderer(main app) -> main: read / patch the overlay auto-hide prefs. Returns OverlayAutoHidePrefs.
  overlayAutoHideGet: 'overlayAutoHide:get',
  overlayAutoHideSet: 'overlayAutoHide:set',
  // main -> renderer(ring window ONLY): the ring's size/thickness changed. Payload CursorRingPrefs.
  onCursorRingConfig: 'cursorRing:config',
  // main -> renderer(ring window ONLY): one cursor sample, in the ring window's own CSS px.
  // THE HOT CHANNEL: ~8 ms cadence, and ONLY while the ring is enabled AND EQ is focused AND
  // the point actually moved. Nothing is sent otherwise — that gating is the performance
  // contract, and it is asserted in tests/presence.test.mts.
  onCursorPoint: 'cursorRing:point',

  // ---- auto-update (Task #27; reworked in Task #55) ----
  // main -> renderer: push update lifecycle {state, version?, percent?, message?, checkedAt?}.
  onUpdateStatus: 'update:status',
  // renderer -> main: PULL the last status. The push above only reaches renderers that
  // were mounted at the transition; Preferences mounts late, so it hydrates from here.
  getUpdateStatus: 'update:getStatus',
  // renderer -> main: run a check now ("Check for updates"). Resolves to the resulting
  // status; a no-op idle status in dev.
  checkForUpdates: 'update:checkNow',
  // renderer -> main: apply the downloaded update now (quit + install + relaunch).
  installUpdate: 'update:install',
  // renderer -> main: the running app's version (app.getVersion()), shown in Preferences.
  getAppVersion: 'app:getVersion',

  // ---- event feed / 'events' overlay (Task #59) ----
  // renderer(main app) -> main: report a renderer-DETECTED feed event (today: a Sky quest
  // completed live — only the renderer's posky/turn-in machinery can see that). Main owns the
  // ring + ids; the entry then reaches the overlay over the ordinary module transport.
  // Payload: FeedReport. Fire-and-forget.
  feedReport: 'feed:report',

  // ---- celebration toasts (docs/plans/celebration-toasts.md) ----
  // renderer(main app) -> main, FIRE-AND-FORGET: "celebrate this" (ToastRequest). The producers
  // are the app's EXISTING always-mounted celebration detectors (T4), which already own the
  // live-only/replay-silence discipline — there is no second gate anywhere below this call.
  // The payload is VALIDATED AT THE HANDLER (`validateToastRequest`, shared/toast.ts): unknown
  // kinds, over-long text and unlisted focus views are dropped, never forwarded to a window.
  // Main then RESOLVES the reward item card (lookupItem) and fans out on the two channels below.
  toastShow: 'toast:show',
  // main -> renderer(toast overlay): one resolved ToastPayload to render. The overlay times,
  // stacks and dismisses it locally and fetches NOTHING (T3/T5) — everything it draws is here.
  onToast: 'toast:card',
  // (`toast:sound` lived here until 2026-08-05. A toast has no voice of its own: the seeded
  // "Raid target defeated" / "Quest complete" ALERTS speak on the same events, and a second
  // channel could only ever say it twice. Removed with the sound controls it served.)

  // ---- cross-window deep link (Task #64) ----
  // renderer(overlay) -> main: "focus the app on this" (AppFocus). Main shows/restores/focuses
  // the MAIN window and forwards the payload on `onFocusView`. Fire-and-forget; the payload's
  // `view` is re-validated at the handler against the closed AppFocusView union.
  focusView: 'app:focusView',
  // main -> renderer(main app): a deep link landed. App.tsx switches to the named view and
  // hands the target down (today: the mob to drill into).
  onFocusView: 'app:focusedView',

  // ---- the mouse's Back button (JOS-201) ----
  // main -> renderer(main app): the user pressed the browser-Back button on their mouse while
  // THIS window had focus. No payload: the message is the press, and what "back" means is a
  // question only the renderer can answer (src/renderer/src/appBack.tsx). The event is
  // WINDOW-SCOPED by construction — it originates in a BrowserWindow `app-command` handler
  // (src/main/appBack.ts), so a press landing in EverQuest, or in any other app, never reaches
  // here. There is deliberately no global hook and no forward channel.
  onAppBack: 'app:back',

  // ---- class-combo corrections (docs/plans/class-combo-inference.md § 5.3) ----
  // READS need no channel of their own — the combo module rides the generic module transport
  // (`module:getSnapshot('combo')` + `module:delta`). These two exist because a correction is a
  // WRITE: the user telling the app "that span was PAL/ROG/BER", which is persisted per
  // character and outlives every replay.
  // renderer -> main: record a correction. Payload {startTs, endTs, classes}. `classes` must be
  // a 1-3 list of the 16 ClassAbbr literals and the timestamps must be finite and ordered —
  // VALIDATED AT THE HANDLER, never trusted because today's only caller is the app's own UI.
  comboSetCorrection: 'combo:setCorrection',
  // renderer -> main: drop every correction overlapping [startTs, endTs] ("Reset to detected").
  // A TIME RANGE, not an interval id: ids are recompute-unstable by design (§ 5.4).
  comboClearCorrection: 'combo:clearCorrection',

  // ---- group-roster user edits (docs/plans/group-model.md §3) ----
  // Same shape as the combo pair above and for the same reason: the roster READS ride the
  // combat snapshot (which both the Combat tab and every overlay already poll), so only the
  // WRITES need channels. A roster edit is the user telling the app "this person is with me" or
  // "this person is not" — persisted per character, outliving every replay.
  // renderer -> main: record an edit. Payload {name, action}. The name is trimmed, length- and
  // shape-checked AT THE HANDLER (a renderer string is a renderer string) and canonicalized
  // there, so the store can never hold a key the model would not recognize.
  rosterSetEdit: 'roster:setEdit',
  // renderer -> main: forget the hand-made statement about one name — "let the log decide again".
  rosterClearEdit: 'roster:clearEdit',

  // NOTE: there are deliberately NO pet-claim channels here any more (JOS-49). The meter used to
  // ASK "<Name> — your pet?" about an unbound entity and take the answer over IPC; the owner cut
  // the question outright — "if you just have to pet attack once, this is a lot of work we can
  // get wrong." The private tell is the binding story, and it needs no renderer round trip.

  // ---- item knowledge ("what's this lore/quest item for", Task #53) ----
  // renderer -> main: look up an item's lore/quest knowledge (local posky-first, then a
  // cached, politely-throttled wiki lookup). Returns ItemKnowledge.
  itemsLookup: 'items:lookup',

  // ---- mob knowledge ("what does this thing drop", Task #63) ----
  // renderer -> main: look up a mob's drop knowledge (own loot history + local quest catalog
  // first, then a cached, politely-throttled wiki lookup). Returns MobKnowledge. Exposed on
  // BOTH bridges — the main window's "recently considered" card and the events overlay's
  // consider rows ask the same question of the same cache-first door.
  mobsLookup: 'mobs:lookup',

  // ---- exaltation planner (docs/plans/exaltation-planner.md §4.1, D1) ----
  // items.json is 7.14 MB and already inlined in MAIN's bundle, so the effect index is built
  // there and served over these channels rather than shipping the corpus to the renderer twice.
  // The index is built LAZILY on the first call and memoized for the process's lifetime.
  // renderer -> main: every effect the corpus states, one row per (item, effect). Returns
  // PlannerDonor[] (~1.5k rows, a few hundred KB) — fetched once and cached by the renderer.
  plannerDonors: 'planner:donors',
  // renderer -> main: substring search over item NAMES for the Board's host picker. Arg: query
  // (VALIDATED AT THE HANDLER — a non-string answers with no hits). Returns PlannerItemHit[],
  // capped at PLANNER_SEARCH_LIMIT.
  plannerSearchItems: 'planner:searchItems',
  // renderer -> main: the active character's saved exaltation sets. Returns ExaltPlan[] ([] when
  // the character has none — the key is optional and readers default, D4).
  plannerGetPlans: 'planner:getPlans',
  // renderer -> main: replace the active character's whole set list (plans are small). The
  // payload is re-validated AT THE HANDLER against the closed slot/socket/class allowlists
  // (src/main/planner/validate.ts) — renderer input is never trusted, here as everywhere.
  plannerSetPlans: 'planner:setPlans',
  // renderer -> main: what the active character is WEARING, read from their newest
  // `/outputfile inventory` dump and joined to the planner's slots by the hand-authored table in
  // shared/planner/inventorySlots.ts (V7, law 12). Returns PlannerInventory | null — null means
  // no dump exists, which the Inventory tab answers with its instructions card, never an error.
  // The dump is re-read on demand; the renderer re-asks when `inventory:autoReloaded` fires, so
  // typing the command in game fills the tab with no click anywhere.
  plannerInventory: 'planner:inventory',

  // ---- character sheet (JOS-45) ----
  // renderer -> main: the armory grid + the gear sum, built from the active character's newest
  // `/outputfile inventory` dump and joined to the committed item DB in main (where the 8.6 MB
  // corpus already lives). Returns CharacterSheet | null — null means no dump, which the tab
  // answers with its instructions card, never an error.
  //
  // THIS CHANNEL IS GATED. Its handler is registered only when `UNRELEASED` (src/main/unreleased.ts)
  // is true — dev builds, or an explicit EQ_UNRELEASED=1 — because the module has not passed the
  // owner's review gate. In a packaged build there is no handler and the preload method rejects,
  // which is the designed outcome: the renderer surface is stripped from those bytes entirely.
  characterSheet: 'character:sheet',

  // ---- map viewer (docs/plans/map-viewer.md §4.2) ----
  // Main owns `fs` and owns effectiveEqRoot(), so main reads and parses `<eqRoot>\maps` and
  // the renderer receives columnar typed arrays (~690 KB worst case, once per zone change).
  // `zone` and every packId reach a join() and are validated AT THE HANDLER (isSafePackId).
  // renderer -> main: the installed packs (no absolute paths). Returns MapPackListResult.
  mapsListPacks: 'maps:listPacks',
  // renderer -> main: zone stems, all packs or one. Args: (packId?). Returns ZoneShort[].
  mapsListZones: 'maps:listZones',
  // renderer -> main: one zone's parsed map. Args: (zone, prefs?) where prefs picks the pack
  // PER LAYER — geometry and labels routinely come from different packs (§6.3), and the
  // outcome is reported back in MapData.sources. Returns MapGetResult.
  mapsGet: 'maps:get',
  // renderer -> main: fuzzy label search — one zone (opts.zone) or the whole corpus.
  // Args: (query, opts?). Returns MapSearchHit[].
  mapsSearch: 'maps:search',

  // ---- settings / alert sharing ("profiles" — src/shared/profiles.ts) ----
  // Every call carries the renderer's whitelisted localStorage prefs (UI_PREF_SPECS): main
  // owns the electron-store half of a bundle, the renderer owns the localStorage half.
  // renderer -> main: encode the GLOBAL settings bundle. Args: (uiPrefs). Returns the string.
  shareExportSettings: 'share:exportSettings',
  // renderer -> main: encode one alert (ids:[id]) or all of them (ids omitted/empty).
  shareExportAlerts: 'share:exportAlerts',
  // renderer -> main: save an already-encoded string to a file via the OS save dialog.
  // Args: (text, suggestedName). Returns {ok, path?, canceled?}.
  shareSaveFile: 'share:saveFile',
  // renderer -> main: open a .eqshare/.txt via the OS picker and PREVIEW it. Args: (uiPrefs).
  shareOpenFile: 'share:openFile',
  // renderer -> main: decode + plan a pasted string WITHOUT writing anything. Args:
  // (text, uiPrefs). Returns SharePreview (never throws; failures come back as prose).
  sharePreview: 'share:preview',
  // renderer -> main: apply a previewed string additively. Args: (text, uiPrefs, selection).
  // Returns ShareApplyResult, incl. the localStorage writes the renderer must perform.
  shareApply: 'share:apply',

  // ---- clipboard (the combat "Copy this view as text" buttons) ----
  // renderer -> main: put plain text on the OS clipboard. Arg: text. Returns boolean (written).
  // WHY THIS IS AN IPC CHANNEL AND NOT `navigator.clipboard.writeText`: the async Clipboard API
  // is permission-gated in Chromium ('clipboard-sanitized-write'), and this app denies EVERY
  // web permission wholesale (`hardenSession` in src/main/windows.ts — deliberate, deny-by-
  // default policy). So writeText rejects with `NotAllowedError: Write permission denied.` in
  // every window, verified in the real app. Electron's main-process `clipboard` module is not a
  // web API and consults no permission, so the copy goes through here instead — the policy
  // stays shut and the feature works. The text is VALIDATED AT THE HANDLER (non-empty string,
  // length cap), never trusted because today's only caller is the app's own UI.
  clipboardWrite: 'clipboard:write',

  // ---- in-app feedback (Task #65 — docs/plans/feedback-triage.md §4.3) ----
  // renderer -> main: the dialog's header context (versions, channel, queued count,
  // whether this build has an endpoint compiled in). Returns FeedbackContext.
  feedbackContext: 'feedback:context',
  // renderer -> main: build the scrubbed log slice for a window (minutes) and return a
  // CAPPED preview + the real counts. The bytes never cross IPC — only PREVIEW_MAX_LINES
  // of text plus the metadata. Returns FeedbackSlicePreview | null.
  feedbackBuildSlice: 'feedback:buildSlice',
  // renderer -> main: save the FULL slice to disk via the OS save dialog, so a user who
  // wants to read every byte before sending can. Returns {ok, path?, canceled?}.
  feedbackSaveSlice: 'feedback:saveSlice',
  // renderer -> main: submit. Args (draft, {attachLog, windowMinutes}). Never rejects;
  // a network failure resolves with {ok:false, queued:true}. Returns SubmitResult.
  feedbackSubmit: 'feedback:submit',

  // ---- usage analytics (docs/plans/usage-analytics.md wave A1) ------------------------
  //
  // NONE OF THESE CAN PUT A BYTE ON THE WIRE. They move events into the local ring, read and
  // write the switch, and render the payload viewer. The only thing that transmits is main's
  // flush loop, gated in src/main/telemetry/net.ts — there is no "send now" channel, on purpose.
  //
  // renderer -> main, FIRE-AND-FORGET: record one event. The payload is VALIDATED AT THE
  // HANDLER with the shared `validateTelemetryEvent` — the renderer is untrusted here like
  // everywhere else, and the schema is a closed allowlist, so an unknown tag or an unlisted
  // enum member is dropped rather than buffered. Arg: TelemetryEvent.
  telemetryTrack: 'telemetry:track',
  // renderer -> main: the persisted prefs {enabled, noticeShown, analyticsId}. Returns
  // TelemetryPrefs.
  telemetryPrefsGet: 'telemetryPrefs:get',
  // renderer -> main: flip the master switch. OFF drops the local buffer immediately.
  // Arg: boolean. Returns TelemetryPrefs.
  telemetrySetEnabled: 'telemetry:setEnabled',
  // renderer -> main: the first-run notice has been ANSWERED (or dismissed — dismissal keeps
  // it on, that is what opt-out means). Sets noticeShown either way. Arg: boolean (keep on).
  telemetryNoticeShown: 'telemetry:noticeShown',
  // renderer -> main: mint a new anonymous analyticsId and DROP the local buffer (T3).
  // Returns TelemetryPrefs.
  telemetryRotate: 'telemetry:rotate',
  // renderer -> main: everything the Preferences payload viewer renders — prefs, whether this
  // build has an endpoint at all, the live buffer, and the last batch sent (permanently null
  // while dark). Returns TelemetryPayloadView.
  telemetryPayload: 'telemetry:payload',

  // ---- what's new (JOS-73; shared/releaseNotes.ts) --------------------------------------
  //
  // TWO CHANNELS, AND THE NOTES THEMSELVES CROSS NEITHER. `src/shared/releaseNotes.ts` is
  // committed source that the bundler inlines into the renderer, exactly like the spell DB — so
  // the only thing main owns here is the ONE store key that says which release this install has
  // already been shown. Everything the user sees is derived from that string by a pure function.
  // renderer -> main: the stored last-seen release, or null on a fresh install. Returns string|null.
  releaseNotesSeenGet: 'releaseNotes:getSeen',
  // renderer -> main: stamp it (the panel, on open) or CLEAR it with null (the DEV variant
  // control's "pretend fresh install"). Arg: string|null, validated at the handler. Returns
  // what is now stored.
  releaseNotesSeenSet: 'releaseNotes:setSeen',

  // ---- performance HUD + startup profile (docs/plans/perf-profiling.md) ----------------
  //
  // NOTHING ON THIS CHANNEL SET COSTS ANYTHING WHILE THE HUD IS OFF. Main creates no timer at
  // all until `perf:setEnabled` says so, so an install that never opens the section never sees
  // a single `perf:sample`.
  //
  // main -> renderer, PUSH: one `PerfSample` every 2 s while the HUD is enabled — or `null`,
  // sent exactly once when it is switched off, which is how the title-bar chip learns to
  // disappear instead of freezing on the last numbers it saw.
  onPerfSample: 'perf:sample',
  // renderer -> main: the persisted HUD pref ({enabled}). Returns PerfHudPrefs.
  perfPrefsGet: 'perfPrefs:get',
  // renderer -> main: flip the HUD switch. Starts/stops the sampler in the SAME call, so the
  // pref and this session's timers can never disagree. A non-boolean leaves the pref alone.
  // Arg: boolean. Returns PerfHudPrefs.
  perfSetEnabled: 'perf:setEnabled',
  // renderer -> main: the last startup profile — the launch you are in (it is written to disk
  // for the next one). Returns StartupProfile. Read by Preferences → Performance.
  perfGetStartup: 'perf:getStartup',
  // renderer -> main, FIRE-AND-FORGET: "the renderer has mounted" — the `rendererHydrated`
  // startup phase, which only the renderer can observe. Sent once per window lifetime; a
  // repeat is refused by the phase accounting itself (shared/perf.ts `addMark`).
  perfRendererHydrated: 'perf:rendererHydrated',

  // ---- graphics compatibility (JOS-40 — shared/graphicsPrefs.ts) ------------------------
  //
  // Two switches for machines whose driver dislikes what this app draws: software rendering
  // for the whole app, and opaque (non-transparent) overlay windows. NEITHER takes effect on
  // the call — safe mode is a before-`ready` flag (next launch) and a window's transparency is
  // fixed at construction (next overlay open) — so there is deliberately no "apply now" channel
  // to pretend otherwise.
  //
  // renderer -> main: the persisted blob {safeMode, opaqueOverlays}. Returns GraphicsPrefs.
  graphicsPrefsGet: 'graphicsPrefs:get',
  // renderer -> main: merge-patch the blob. VALIDATED AT THE HANDLER through the same
  // normalizer the store reader and the 10→11 migration use. Returns what was stored.
  graphicsPrefsSet: 'graphicsPrefs:set',
  // renderer -> main: what this MACHINE recommends, for a switch left on 'auto' (JOS-31).
  // Returns a `GraphicsEnvironment` (shared/wineDetect.ts): whether a Wine prefix was detected,
  // which signals said so, and the two booleans `resolveGraphics` folds against the stored prefs.
  //
  // A SEPARATE CHANNEL, not a fatter `graphicsPrefs:get`, because the two answer different
  // questions with different lifetimes: the prefs change when the user flips a switch, and this is
  // a fact about the launch that cannot change while the app is running. The renderer hydrates it
  // once and re-folds locally through the SAME `resolveGraphics` main used, so the card can never
  // describe a precedence the windows did not use.
  graphicsEnvGet: 'graphicsPrefs:env',

  // ---- the buff externals allowlist (JOS-140 — shared/buffTrust.ts) ----------------------
  //
  // WHOSE spells the buff/debuff model is allowed to track. It ships EMPTY — you and nobody else
  // — because a landing sentence names no caster, so in a crowded zone the only thing separating
  // your work from a stranger's is that you have a cast line and they do not. An allowlisted name
  // gets the IDENTICAL rule, anchored on `<Name> begins casting <Spell>.`; it is never a looser
  // one, and never something the app infers from proximity or from the group roster.
  //
  // renderer -> main: the persisted `{externals: string[]}`. Returns BuffTrustPrefs.
  buffTrustGet: 'buffTrust:get',
  // renderer -> main: replace the list. VALIDATED AT THE HANDLER through the same normalizer the
  // store reader uses (the `graphicsPrefs:set` rule), and applied to the live model on the way
  // through so a name added mid-session anchors the next cast rather than the next launch.
  // Returns what was stored.
  buffTrustSet: 'buffTrust:set',

  // ---- respawn clocks (JOS-194 — shared/respawn.ts) -------------------------------------
  //
  // WHICH MOBS GET A CLOCK. The clocks themselves are log-derived and ride the generic module
  // transport (`respawn`); this pair carries the ONE thing the log cannot state — the mobs you
  // chose to watch and the respawn you typed for them.
  //
  // main -> renderer: the persisted watch list. Returns RespawnPrefs.
  respawnGet: 'respawn:get',
  // renderer -> main: replace it. VALIDATED AT THE HANDLER through the same normalizer the store
  // reader uses, applied to the running module, and PUSHED immediately (`registry.flushNow`) —
  // the module's own revision counter is what keeps the push from being deduped, because a watch
  // edit advances no log seq (JOS-87). Returns what was stored.
  respawnSet: 'respawn:set',

  // ---- main window text size (JOS-123 — shared/uiScale.ts) ------------------------------
  //
  // The main window's zoom factor: the Preferences control a player asked for after reporting
  // they could barely read the app. The floating overlays are NOT on this channel and never
  // were — they carry their own `textScale` inside the per-kind overlay config, because an
  // overlay scales only its reading matter and keeps its chrome laid out against a small window.
  //
  // renderer -> main: the persisted factor. Returns a number (1 on every store that predates it).
  uiScaleGet: 'uiScale:get',
  // renderer -> main: store a factor and APPLY it to the live window in the same call. Unlike the
  // graphics switches above this one takes effect immediately, which is not a courtesy: a size
  // control you have to relaunch to evaluate cannot be evaluated. Returns what was stored, snapped
  // to the ladder by the same normalizer the store reader and the window factory use.
  uiScaleSet: 'uiScale:set',

  // ---- dev restart (JOS-61, JOS-63 — src/main/devRestart.ts) ----------------------------
  //
  // renderer -> main: restart the app. Hand-testing startup performance means restarting it
  // over and over, and Preferences → Performance already prints the breakdown of the launch
  // you are in; this is the button beside that readout.
  //
  // The reply is a `DevRestartResult` (shared/devRestart.ts) rather than a boolean, because
  // there are three outcomes and they look different to the person who clicked: the process is
  // going away now, the electron-vite watcher has been ASKED to rebuild and relaunch us (a
  // couple of seconds, and the only route that does not blank the window under `npm run dev`),
  // or nothing happened at all.
  //
  // UNLIKE THE TRIAGE CHANNELS BELOW, THIS HANDLER IS REGISTERED IN EVERY BUILD — and REFUSES
  // in a packaged one, having done nothing (src/main/ipc/dev.ts). A packaged
  // build is therefore provably inert even if the channel is reached, rather than relying on
  // the renderer surface having been stripped (it has been: `DEV_TOOLS`, anchored on
  // `import.meta.env.DEV`, deletes the button from those bytes). Takes no arguments, so there
  // is nothing at this handler to validate.
  devRestart: 'dev:restart',

  // ---- feedback TRIAGE (the OWNER-only operator tab — src/main/triage/**) --------------
  //
  // ========= OWNER OPT-IN ONLY. NO SHIPPED APP EVER REGISTERS THESE HANDLERS. =============
  //
  // The names live here because every channel name in this app lives here — but nothing in a
  // packaged build listens on them, and since JOS-72 nothing in an ordinary dev build does
  // either. Registration happens from `src/main/index.ts` behind `if (!OWNER_TOOLS) return`
  // via a dynamic import — DEV **and** an explicit `EQ_OWNER_TOOLS=1` that no fresh checkout
  // has (src/shared/ownerTools.ts; a self-compiled build from this public repo is not
  // `app.isPackaged`, which is what the old predicate had missed) — and the module it imports
  // reaches `pg` + `@aws-sdk/*`, which are devDependencies and therefore never packaged.
  // Calling one of these from a shipped build rejects with "No handler registered", which is
  // the correct and intended outcome.
  //
  // These channels read the OWNER'S FEEDBACK BACKLOG (Aurora DSQL + S3) using the launching
  // shell's AWS profile (AWS_PROFILE, default 'eqc'). Possession of those IAM credentials is
  // the access control; there is no password and no server-side read API to secure.
  //
  // Every argument is VALIDATED AT THE HANDLER (src/main/triage/validate.ts) — `reportId`
  // reaches a file path as well as a SQL parameter and must be a 26-character ULID. Every
  // reply is a `TriageResult<T>` (never a rejection), so an IAM denial renders as prose.
  //
  // renderer -> main: the filtered backlog. Arg: TriageListQuery. Returns TriageRow[].
  triageList: 'triage:list',
  // renderer -> main: one full record + the S3-resolved log state. Arg: reportId.
  triageDetail: 'triage:detail',
  // renderer -> main: download (cached) + gunzip a report's log slice and return CAPPED text.
  // The gz bytes never cross; at most PREVIEW_MAX_LINES lines do. Arg: reportId.
  triageSlice: 'triage:slice',
  // renderer -> main: the triage-only writes (status/severity/cluster/dupe/note). Args:
  // (reportId, TriagePatch). `issueUrl` is deliberately NOT writable from the UI.
  triagePatch: 'triage:patch',
  // renderer -> main: §3.5 forget — strip the contact, delete the slice object, keep the
  // report. Arg: reportId.
  triageForget: 'triage:forget',
  // renderer -> main: the kill switch + block list. Returns TriageOpsState.
  triageOps: 'triage:ops',
  // renderer -> main: set the kill switch. POSITIVE polarity — `accepting:false` is what the
  // CLI spells `closed on`. Args: (accepting, message?).
  triageSetAccepting: 'triage:setAccepting',
  // renderer -> main: block/unblock one install. Args: (installId, blocked, reason).
  triageSetBlocked: 'triage:setBlocked',
  // renderer -> main: the CLI's markdown digest + its deterministic clusters. Arg: query.
  triageDigest: 'triage:digest',
  // renderer -> main: usage analytics over a window (arg: days, one of TRIAGE_ANALYTICS_DAYS).
  // Reads usage_daily + usage_funnel_daily + analytics_install; `available:false` means the
  // tables are missing (a cluster that predates the A2 migration), NOT that they are empty.
  triageAnalytics: 'triage:analytics',

  // ---- misc pushes ----
  onLine: 'log:line',
  onCharacter: 'log:character',

  // ---- error harness (renderer -> main, fire-and-forget) ----
  // window.onerror / onunhandledrejection / React ErrorBoundary report here so
  // renderer crashes land in errors.log + dev stdout and never leave a blank window.
  reportError: 'error:report'
} as const
