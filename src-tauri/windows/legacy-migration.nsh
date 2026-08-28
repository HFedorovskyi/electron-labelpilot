!ifndef LEGACY_ELECTRON_UNINSTALL_KEY
  !define LEGACY_ELECTRON_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\706f3450-5e57-5456-9cf1-987811731881"
!endif
!ifndef LEGACY_ELECTRON_INSTALL_DIR
  !define LEGACY_ELECTRON_INSTALL_DIR "$LOCALAPPDATA\Programs\LabelPilot"
!endif
!ifndef LEGACY_ELECTRON_MAIN_EXE
  !define LEGACY_ELECTRON_MAIN_EXE "${LEGACY_ELECTRON_INSTALL_DIR}\LabelPilot.exe"
!endif
!ifndef LEGACY_ELECTRON_UNINSTALLER
  !define LEGACY_ELECTRON_UNINSTALLER "${LEGACY_ELECTRON_INSTALL_DIR}\Uninstall LabelPilot.exe"
!endif

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R7 HKCU "${LEGACY_ELECTRON_UNINSTALL_KEY}" "DisplayVersion"
  ReadRegStr $R8 HKCU "${LEGACY_ELECTRON_UNINSTALL_KEY}" "QuietUninstallString"

  ${If} $R7 != ""
    DetailPrint "Migrating LabelPilot Electron runtime $R7"
    !insertmacro CheckIfAppIsRunning "LabelPilot.exe" "LabelPilot Electron"

    ClearErrors
    ${If} $R8 != ""
      ExecWait '$R8' $R6
    ${ElseIf} ${FileExists} "${LEGACY_ELECTRON_UNINSTALLER}"
      ExecWait '"${LEGACY_ELECTRON_UNINSTALLER}" /currentuser /S' $R6
    ${Else}
      StrCpy $R6 2
    ${EndIf}

    ${If} ${Errors}
      ClearErrors
      WriteRegStr HKCU "${UNINSTKEY}" "LegacyMigrationFrom" "$R7"
      WriteRegStr HKCU "${UNINSTKEY}" "LegacyMigrationStatus" "uninstaller-launch-failed"
    ${ElseIf} $R6 != 0
      WriteRegStr HKCU "${UNINSTKEY}" "LegacyMigrationFrom" "$R7"
      WriteRegStr HKCU "${UNINSTKEY}" "LegacyMigrationStatus" "uninstaller-exit-$R6"
    ${Else}
      DeleteRegKey HKCU "${LEGACY_ELECTRON_UNINSTALL_KEY}"
      WriteRegStr HKCU "${UNINSTKEY}" "LegacyMigrationFrom" "$R7"
      WriteRegStr HKCU "${UNINSTKEY}" "LegacyMigrationStatus" "removed"
    ${EndIf}
  ${ElseIf} ${FileExists} "${LEGACY_ELECTRON_MAIN_EXE}"
    DetailPrint "Removing orphaned LabelPilot Electron runtime"
    !insertmacro CheckIfAppIsRunning "LabelPilot.exe" "LabelPilot Electron"

    ${If} ${FileExists} "${LEGACY_ELECTRON_UNINSTALLER}"
      ExecWait '"${LEGACY_ELECTRON_UNINSTALLER}" /currentuser /S' $R6
    ${EndIf}
    RMDir /r /REBOOTOK "${LEGACY_ELECTRON_INSTALL_DIR}"
    DeleteRegKey HKCU "${LEGACY_ELECTRON_UNINSTALL_KEY}"
    WriteRegStr HKCU "${UNINSTKEY}" "LegacyMigrationFrom" "legacy-electron-orphan"
    WriteRegStr HKCU "${UNINSTKEY}" "LegacyMigrationStatus" "removed"
  ${EndIf}
!macroend