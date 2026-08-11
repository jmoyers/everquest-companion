# build/installer.nsh - auto-included by electron-builder (buildResources/installer.nsh
# is the default for `nsis.include`; no electron-builder.yml wiring needed).
#
# Why this exists: app-builder-lib's registryAddInstallInfo (templates/nsis/include/
# installer.nsh) writes InstallLocation only to INSTALL_REGISTRY_KEY
# (HKCU\Software\<appId-uuid>). The Add/Remove Programs key
# (HKCU\...\CurrentVersion\Uninstall\<appId-uuid>) gets DisplayName, DisplayVersion,
# Publisher, UninstallString, QuietUninstallString, DisplayIcon, EstimatedSize - but NOT
# InstallLocation, so Windows Settings -> Apps shows a blank install location. Mirror it.
#
# customInstall is inserted at the END of installSection.nsh, after registryAddInstallInfo
# and the shortcuts, so $INSTDIR and SHELL_CONTEXT are already correct (SHELL_CONTEXT is
# `current` for our per-user oneClick/perMachine:false install). The uninstaller's
# DeleteRegKey removes the whole key, so this adds nothing to clean up.
#
# NOTE: this file is included at the TOP of the generated .nsi, BEFORE multiUser.nsh
# defines UNINSTALL_REGISTRY_KEY. Spell the path out from UNINSTALL_APP_KEY (passed on
# the compiler command line by NsisTarget, so it exists from line 1) rather than relying
# on a define that does not exist yet at this point in the script.
!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "InstallLocation" "$INSTDIR"
!macroend

# ---------------------------------------------------------------------------------------
# customInit - refuse cleanly on Windows 8.1 and older instead of installing an app that
# cannot start.
#
# THE REPORT: a player on Windows 8.1 installed the app and it never launched. Electron
# (Chromium) dropped Windows 7/8/8.1 support in Electron 23; our build cannot run there
# and never will. 8.1 has been out of support since 2023-01-10. The installer should say
# so in one sentence rather than leaving files, a shortcut and an ARP entry behind for an
# exe that dies on double-click.
#
# THE HOOK, VERIFIED AGAINST THE INSTALLED app-builder-lib (26.15.7), templates/nsis/
# installer.nsi:
#
#   Function .onInit
#     Call setInstallSectionSpaceRequired
#     SetOutPath $INSTDIR
#     ...
#     !ifdef BUILD_UNINSTALLER
#       WriteUninstaller ... / quitSuccess
#     !else
#       !insertmacro check64BitAndSetRegView
#       !insertmacro ALLOW_ONLY_ONE_INSTALLER_INSTANCE
#       !insertmacro initMultiUser
#       !ifmacrodef customInit
#         !insertmacro customInit          <- here
#       !endif
#       ...
#     !endif
#   FunctionEnd
#
# customInit is the right hook and `preInit` is NOT: preInit is inserted ABOVE the
# `!ifdef BUILD_UNINSTALLER` branch, so it also runs during the -DBUILD_UNINSTALLER pass -
# the throwaway stub whose whole job is `WriteUninstaller`, executed on the BUILD machine.
# A version gate there would be a build-time gate, which is not what anyone wants. It also
# runs in the uninstaller itself; a user who somehow got the app installed must always be
# able to remove it.
#
# customInit lands after check64BitAndSetRegView (which already Quits on 2000/ME/XP/Vista
# with $(win7Required), and on a non-x64 host with $(x64WinRequired)) and after
# initMultiUser, so on a 32-bit or ancient host the stock message wins and ours never
# shows. That ordering is fine: both outcomes are a refusal, and ours is the one that
# covers the actual report (64-bit Windows 7/8/8.1).
#
# WHY ${AtLeastWin10} IS SAFE HERE - this is the trap that makes naive WinVer gates block
# the machines they meant to allow. WinVer.nsh's __WinVer_InitVars calls
# kernel32::GetVersionEx, and since Windows 8.1 that API version-LIES to any process whose
# manifest does not claim compatibility with the running OS: an unmanifested binary is told
# 6.2 (Windows 8) on Windows 10 and 11, which would make ${AtLeastWin10} false everywhere
# and refuse every install. NSIS 3's `ManifestSupportedOS` defaults to Win7+Win8+Win8.1+
# Win10, and electron-builder never overrides it (no ManifestSupportedOS anywhere in
# app-builder-lib's templates or NsisTarget), so the stub carries all four supportedOS
# GUIDs and GetVersionEx tells the truth up to 10.0. VERIFIED EMPIRICALLY, not from the
# docs: a probe .nsi compiled with the very makensis electron-builder uses
# (%LOCALAPPDATA%\electron-builder\Cache\nsis\nsis-3.0.4.1, v3.04) embeds
# <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/> (Win10) in its manifest, and
# running it on Windows 11 10.0.22631 took the ${AtLeastWin10} branch. If a future
# electron-builder ever sets ManifestSupportedOS, re-run that probe before trusting this.
# (Windows 11 reports 10.0, so ${AtLeastWin10} covers it; Server 2016+ likewise.)
#
# ${AtLeastWin10} (not ${IsWin10}) is the correct spelling: __WinVer_DefineOSTests defines
# AtLeastWin10 as `WinVerAtLeast ${WINVER_10}`, which masks off the NT bit and compares
# >=, whereas the Is* family is an exact-version equality test.
#
# `/SD IDOK` matters: a silent run (`/S`, i.e. an electron-updater-driven reinstall or the
# tier-1/tier-2 harnesses) would otherwise still block on the MessageBox. With it the box
# is skipped and we Quit regardless - refusing is correct on every path.
#
# UNDER WINE/CROSSOVER this reads the BOTTLE's configured Windows version, not macOS. That
# is the right answer and not an exception worth carving: Electron needs a Win10 bottle to
# run at all, so a bottle still set to Windows 7 should be refused, and the message names
# exactly what to change it to. (customCheckAppRunning's Wine skip is a different problem -
# process enumeration is unreliable in a bottle; the reported OS version is not.)
#
# Not cleaned up on purpose: .onInit's own `SetOutPath $INSTDIR` (three lines above
# check64BitAndSetRegView) has already created an empty install dir by the time any of
# these gates fire. The stock win7Required/x64WinRequired paths leave it too. Nothing is
# extracted and no registry key is written, so an empty directory is the entire residue;
# an RMDir here would be new behaviour on a path that is meant to stay boring.
!macro customInit
  # Build-time proof the hook fired, same trick as customCheckAppRunning / customUnInstall
  # below. !verbose 4 is required for !echo to print and is NOT a warning, so -WX stays happy.
  !verbose push
  !verbose 4
  !echo "everquest-companion: customInit inserted (Windows 10+ gate is live)"
  !verbose pop

  ${IfNot} ${AtLeastWin10}
    # Deliberately ONE line and one sentence: it names the requirement and stops.
    MessageBox MB_OK|MB_ICONEXCLAMATION|MB_TOPMOST|MB_SETFOREGROUND "${PRODUCT_NAME} needs Windows 10 or later, so it can't be installed on this version of Windows." /SD IDOK
    Quit
  ${EndIf}
!macroend

# ---------------------------------------------------------------------------------------
# customCheckAppRunning - skip the "app is running" gate under Wine / CrossOver.
#
# THE BUG: on macOS + CrossOver the installer dies at "EQ Legends Companion is running.
# Click OK to close it..." with the app NOT running. The stock check enumerates processes
# (PowerShell Get-CimInstance, else tasklist) and both are unreliable inside a Wine bottle -
# zombie/stale bottle processes, a wineserver that still lists an exited image, and a
# tasklist stub whose output is not the real process table. The user cannot get past it:
# KILL_PROCESS then cannot kill the thing FIND_PROCESS claims to see, so the retry loop
# escalates to appCannotBeClosed and Quit. Under Wine the check has no value anyway - the
# files we are about to overwrite are not actually locked by a phantom.
#
# THE HOOK, VERIFIED AGAINST THE INSTALLED app-builder-lib (26.15.7),
# templates/nsis/include/allowOnlyOneInstallerInstance.nsh:
#
#   !macro CHECK_APP_RUNNING
#     Var /GLOBAL CmdPath / PowerShellPath ... (set here, OUTSIDE the branch)
#     !ifmacrodef customCheckAppRunning
#       !insertmacro customCheckAppRunning        <- our body, and NOTHING else
#     !else
#       !insertmacro IS_POWERSHELL_AVAILABLE
#       !insertmacro _CHECK_APP_RUNNING
#     !endif
#   !macroend
#
# So the hook REPLACES, it does not wrap: defining it drops the entire default body. That
# is why the ${Else} branch below re-inserts EXACTLY the two macros the !else branch would
# have, rather than a copied-out body that could drift from the template on an upgrade. On
# real Windows the emitted code is therefore identical to today's.
#
# THE TRAP THAT COMES WITH THE HOOK (same file, lines 5-8):
#
#   !ifmacrondef customCheckAppRunning
#     !include "getProcessInfo.nsh"
#     Var pid
#   !endif
#
# ...i.e. app-builder-lib assumes a custom check does NOT want the default machinery and
# stops providing it. But we DO want it on Windows: _CHECK_APP_RUNNING calls
# ${GetProcessInfo} and KILL_PROCESS reads $pid. Since this file is included in the shared
# header ABOVE installer.nsi's `!include "allowOnlyOneInstallerInstance.nsh"`, that
# !ifmacrondef is already false by the time it is evaluated, and without the two lines below
# the build fails to compile (undefined ${GetProcessInfo} / unknown variable $pid). Both are
# safe here: getProcessInfo.nsh is self-guarded (GETPROCESSINFO_INCLUDED), resolves through
# the !addincludedir that NsisTarget emits before our !include, and its own
# `!ifdef BUILD_UNINSTALLER` picks un._GetProcessInfo in the uninstaller pass - BUILD_UNINSTALLER
# is a -D define, so it is correct from line 1. It needs nothing from multiUser.nsh/LogicLib,
# which is the AGENTS.md gotcha this file exists to remember: only TOP-LEVEL code here runs
# before those are defined. Everything inside a !macro body is expanded at the INSERTION
# point (inside the install section / un.checkAppRunning), where LogicLib, ${isUpdated},
# ${APP_EXECUTABLE_FILENAME} and friends all exist.
!include "getProcessInfo.nsh"
Var pid

# Probe one registry key for existence WITHOUT reading a value: Wine creates Software\Wine
# but there is no value under it we can count on, so ReadRegStr would false-negative and
# EnumRegKey cannot tell "no such key" from "key with no subkeys" (both set the error flag).
# RegOpenKeyExW answers exactly the question. $R9 is the sticky "is Wine" flag; each probe
# short-circuits if an earlier one already said yes.
!macro eqProbeWineRegKey ROOT SAM
  ${If} $R9 == 0
    System::Call 'advapi32::RegOpenKeyExW(i ${ROOT}, w "Software\Wine", i 0, i ${SAM}, *i .R8) i .R7'
    ${If} $R7 == 0
      System::Call 'advapi32::RegCloseKey(i R8)'
      StrCpy $R9 1
    ${EndIf}
  ${EndIf}
!macroend

# THE ntdll PROBE IS GONE ON PURPOSE (JOS-184) - it is not dead code that was tidied away.
#
# It used to be belt and braces for a bottle whose registry had been scrubbed:
# `GetModuleHandleW("ntdll.dll")` then `GetProcAddress(..., "wine_get_version")`, Wine's own
# advertised "am I Wine" export. Correct, and a textbook malware signature. Resolving an
# unexported-by-name API out of ntdll by string, from an unsigned installer, is one of the
# oldest heuristics every AV engine carries - it is how shellcode and packers find their
# syscalls - and this installer is already fighting a reputation problem it cannot answer
# with a signature yet. A second, redundant Wine check is not worth the detection it buys.
#
# WHAT MUST NOT REGRESS: the JOS-31/32 behaviour is pinned to the REGISTRY probes below,
# which stay. Every stock Wine prefix has `Software\Wine` under HKCU (wine.inf writes it),
# and the three eqProbeWineRegKey inserts cover HKCU, HKLM and HKLM's 64-bit view. The only
# case the ntdll probe covered alone was a bottle whose registry had been deliberately
# stripped of that key, which is a hand-modified prefix, not a shape any user arrives at.
# In that case the installer falls back to the stock running-app check - the pre-JOS-31
# behaviour - rather than doing anything new or worse.

!macro customCheckAppRunning
  # Build-time proof the hook fired, same trick as customUnInstall below. Prints once per
  # makensis pass (installer + uninstaller) with DEBUG=electron-builder. !verbose 4 is
  # required for !echo to print and is NOT a warning, so -WX stays happy.
  !verbose push
  !verbose 4
  !echo "everquest-companion: customCheckAppRunning inserted (Wine skip + default fallthrough)"
  !verbose pop

  # $R7/$R8/$R9 only. $R0/$R1 are the default check's scratch and $R9 is re-used by
  # ${isUpdated} inside it - all of that happens after the branch is decided.
  StrCpy $R9 0
  !insertmacro eqProbeWineRegKey 0x80000001 0x00020019  # HKCU, KEY_READ
  !insertmacro eqProbeWineRegKey 0x80000002 0x00020019  # HKLM, KEY_READ
  # HKLM\Software is WOW64-redirected for this 32-bit installer; ask for the 64-bit view too
  # (KEY_WOW64_64KEY, ignored on a 32-bit prefix).
  !insertmacro eqProbeWineRegKey 0x80000002 0x00020119

  ${If} $R9 == 1
    # No Quit, no MessageBox, no kill: just fall through to the install/uninstall.
    # DetailPrint is the only trace mechanism the stock check uses too (see $(appClosing)).
    # oneClick hides the details pane, so this is visible in install.log only when the build
    # sets ENABLE_LOGGING_ELECTRON_BUILDER (electron-builder.yml
    # `nsis.customNsisBinary.debugLogging: true`) - i.e. exactly the debug-log case.
    DetailPrint "Wine/CrossOver detected - skipping the running-app check (process enumeration is not reliable in a bottle). Close EQ Legends Companion yourself if it is open."
  ${Else}
    !insertmacro IS_POWERSHELL_AVAILABLE
    !insertmacro _CHECK_APP_RUNNING
  ${EndIf}
!macroend

# ---------------------------------------------------------------------------------------
# customUnInstall - "keep your settings?" prompt on INTERACTIVE uninstall only.
#
# electron-builder.yml keeps `deleteAppDataOnUninstall: false`, so the stock template
# never touches %APPDATA%. This macro is the ONLY code path that can delete user data,
# and it only runs when a human answered No to the question below.
#
# WHAT WAS VERIFIED about the uninstaller's macro context (app-builder-lib 25.x,
# templates/nsis/*), because almost none of it is what you would guess:
#
#  * `${Silent}` IS USELESS HERE. For a oneClick build, uninstaller.nsh's `un.onInit`
#    shows the stock "are you sure you want to uninstall" MB_OKCANCEL and then calls
#    `SetSilent silent` ("one-click installer executes uninstall section in the silent
#    mode"). By the time the `un.install` section - and therefore this macro - runs,
#    ${Silent} is TRUE for BOTH an interactive uninstall and a `/S` one. A
#    `${IfNot} ${Silent}` guard would compile fine and simply never fire, i.e. the
#    prompt would never appear. Detect the REAL request instead, from the command line:
#    `/S` present => scripted/silent => never prompt, always preserve.
#    (`${GetParameters}`/`${GetOptions}` come from FileFunc.nsh, which multiUser.nsh
#    includes near the top of the .nsi - long before this macro is inserted. The stock
#    section uses the same pair three lines above the insertion point to parse
#    `--delete-app-data`.) The relaunched-from-%TEMP% copy of the uninstaller keeps the
#    original command line - that is why `Uninstall*.exe /S` is silent end-to-end today,
#    and it is what the tier-2 sandbox harness relies on.
#  * `${isUpdated}` (StdUtils.TestParameter "--updated") IS available - the generated
#    header defines it above this file's include. electron-updater never uninstalls, but
#    an update-driven uninstall would also pass `/S`; both are checked, belt and braces.
#  * `$installMode` is multiUser.nsh's Var, set by `initMultiUser` in un.onInit. For our
#    per-user install it is "CurrentUser", so SHELL_CONTEXT is `current` and $APPDATA is
#    the real per-user roaming dir. The all-users guard mirrors the stock
#    DELETE_APP_DATA_ON_UNINSTALL block verbatim ("electron always uses per user app
#    data") so this stays correct if perMachine is ever flipped.
#  * customUnInstall is inserted at the END of the `un.install` section, AFTER
#    `RMDir /r $INSTDIR`, the shortcut removal and the DeleteRegKey calls, and just
#    before ONE_CLICK's quitSuccess. Files are already gone when the prompt appears;
#    that is fine (nothing here depends on $INSTDIR) and it is the only hook available.
#  * The dir name is spelled out, NOT taken from ${APP_PACKAGE_NAME}. `RMDir /r` on an
#    accidentally-empty define would be `RMDir /r "$APPDATA\"` - the entire roaming
#    profile. It must stay in sync with package.json `name` (= Electron's
#    app.getName(), there being no productName in package.json) and with the prod row of
#    src/main/channel.ts. NEVER widen this: `%APPDATA%\eq-tools` is the pre-rename
#    BACKUP that the one-time seed reads from, and `%APPDATA%\everquest-companion-dev`
#    is the running dev app's data. Neither is ours to delete.
!macro customUnInstall
  # Build-time proof that the hook actually fires. `!ifmacrodef customUnInstall` lives in
  # uninstaller.nsh, which is only !included in the -DBUILD_UNINSTALLER pass, so this line
  # prints exactly once per `npm run dist` (visible with DEBUG=electron-builder). If it
  # ever stops printing, electron-builder stopped inserting this macro and the prompt is
  # silently gone. !verbose 4 is needed for !echo to print at all; it is NOT a warning, so
  # makensis's -WX stays happy.
  !verbose push
  !verbose 4
  !echo "everquest-companion: customUnInstall inserted (keep-settings prompt is live)"
  !verbose pop

  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "/S" $R1
  ${IfNot} ${Errors}
    # /S on the command line: scripted or updater-driven. Preserve silently.
    Goto eqKeepUserData
  ${EndIf}
  ${If} ${isUpdated}
    Goto eqKeepUserData
  ${EndIf}

  # Interactive uninstall. Yes (default button, and the /SD fallback) keeps everything.
  # Deliberately ONE line: this file has a history of "compiles clean, installer dies",
  # and a line continuation inside a macro body is not worth re-litigating.
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1|MB_TOPMOST|MB_SETFOREGROUND "Keep your settings and history?$\r$\n$\r$\nThey'll be restored if you reinstall EQ Legends Companion.$\r$\n(Choosing No deletes them permanently.)" /SD IDYES IDYES eqKeepUserData

  ${If} $installMode == "all"
    SetShellVarContext current
  ${EndIf}
  RMDir /r "$APPDATA\everquest-companion"
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}

  eqKeepUserData:
  # GetOptions leaves the error flag set when the switch is absent; don't hand that on.
  ClearErrors
!macroend
