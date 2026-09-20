; Portable user data lives next to the executable (see src/main/constants.ts):
;   $INSTDIR\game  — downloads / installed games
;   $INSTDIR\save  — LevelDB + local save artifacts
;
; electron-builder's default update path runs the *old* uninstaller which does
; `RMDir /r $INSTDIR`, wiping those folders. This script:
;   1. Stages game/ + save/ out of the way before the old uninstall runs
;   2. Restores them into the new $INSTDIR after files are extracted
;   3. Makes future uninstallers (customRemoveFiles) preserve them in-place
;
; NOTE: This file is !include'd in the NSIS header *before* LogicLib/MUI2.
; Functions that use ${if}/${FileExists} must be defined later via customHeader
; (inserted after MUI2). Keep only Var / !define / !macro here.
;
; electron-builder treats NSIS warnings as errors, so every Function/Var must
; be referenced in the build that defines it (installer vs BUILD_UNINSTALLER).

; =============================================================================
; INSTALLER-ONLY: stage/restore game + save around upgrade
; =============================================================================

!ifndef BUILD_UNINSTALLER

  Var /GLOBAL GLPreserveRoot
  Var /GLOBAL GLPreserveActive

  ; Defined at include-time (before MUI pages). Do not define .onUserAbort — MUI owns it.
  !define MUI_CUSTOMFUNCTION_ABORT GL.OnUserAbort

  !macro customInit
    StrCpy $GLPreserveRoot ""
    StrCpy $GLPreserveActive "0"
  !macroend

  ; Stage $R0\<name> into $GLPreserveRoot\<name> if not already staged.
  !macro GL_StageNamedDir NAME
    ${if} ${FileExists} `$R0\${NAME}`
      ${if} ${FileExists} `$GLPreserveRoot\${NAME}`
        DetailPrint "Preserve: ${NAME} already staged — skip `$R0\${NAME}`"
      ${else}
        DetailPrint "Preserving `$R0\${NAME}`"
        CreateDirectory `$GLPreserveRoot`
        ClearErrors
        Rename `$R0\${NAME}` `$GLPreserveRoot\${NAME}`
        ${if} ${Errors}
          ClearErrors
          CreateDirectory `$GLPreserveRoot\${NAME}`
          CopyFiles /SILENT `$R0\${NAME}\*.*` `$GLPreserveRoot\${NAME}`
          ${if} ${Errors}
            DetailPrint "WARNING: failed to preserve `$R0\${NAME}`"
          ${else}
            StrCpy $GLPreserveActive "1"
          ${endIf}
        ${else}
          StrCpy $GLPreserveActive "1"
        ${endIf}
      ${endIf}
    ${endIf}
  !macroend

  !macro GL_RestoreNamedDir NAME
    ${if} ${FileExists} `$GLPreserveRoot\${NAME}`
      ${if} ${FileExists} `$INSTDIR\${NAME}`
        DetailPrint "Restore: `$INSTDIR\${NAME}` already exists — leaving staged copy"
      ${else}
        DetailPrint "Restoring ${NAME} -> `$INSTDIR`"
        CreateDirectory `$INSTDIR`
        ClearErrors
        Rename `$GLPreserveRoot\${NAME}` `$INSTDIR\${NAME}`
        ${if} ${Errors}
          ClearErrors
          CreateDirectory `$INSTDIR\${NAME}`
          CopyFiles /SILENT `$GLPreserveRoot\${NAME}\*.*` `$INSTDIR\${NAME}`
          ${ifNot} ${Errors}
            RMDir /r `$GLPreserveRoot\${NAME}`
          ${endIf}
        ${endIf}
      ${endIf}
    ${endIf}
  !macroend

  ; Functions AFTER MUI2/LogicLib via customHeader
  !macro customHeader
    !include "LogicLib.nsh"

    Function GL.EnsurePreserveRoot
      ${if} $GLPreserveRoot != ""
        Return
      ${endIf}

      Push $R1
      ${StdUtils.GetParentPath} $R1 `$R0`
      ${if} $R1 != ""
        StrCpy $GLPreserveRoot `$R1\.gamelaucher-userdata-preserve`
      ${else}
        StrCpy $GLPreserveRoot `$TEMP\gamelaucher-userdata-preserve`
      ${endIf}
      Pop $R1
    FunctionEnd

    Function GL.StageFromPath
      ${if} $R0 == ""
        Return
      ${endIf}

      ${ifNot} ${FileExists} `$R0`
        Return
      ${endIf}

      Call GL.EnsurePreserveRoot
      !insertmacro GL_StageNamedDir `game`
      !insertmacro GL_StageNamedDir `save`
    FunctionEnd

    Function GL.DoPreserve
      Push $R0
      Push $R1

      StrCpy $R0 `$INSTDIR`
      Call GL.StageFromPath

      ReadRegStr $R1 HKCU `${INSTALL_REGISTRY_KEY}` InstallLocation
      ${if} $R1 != ""
        ${andIf} $R1 != `$INSTDIR`
        StrCpy $R0 `$R1`
        Call GL.StageFromPath
      ${endIf}

      ReadRegStr $R1 HKLM `${INSTALL_REGISTRY_KEY}` InstallLocation
      ${if} $R1 != ""
        ${andIf} $R1 != `$INSTDIR`
        StrCpy $R0 `$R1`
        Call GL.StageFromPath
      ${endIf}

      ${if} $GLPreserveActive == "1"
        DetailPrint "User data staged at `$GLPreserveRoot` (game + save)"
      ${endIf}

      Pop $R1
      Pop $R0
    FunctionEnd

    Function GL.DoRestore
      ${if} $GLPreserveRoot == ""
        Return
      ${endIf}

      ${ifNot} ${FileExists} `$GLPreserveRoot`
        Return
      ${endIf}

      !insertmacro GL_RestoreNamedDir `game`
      !insertmacro GL_RestoreNamedDir `save`

      RMDir `$GLPreserveRoot\game`
      RMDir `$GLPreserveRoot\save`
      RMDir `$GLPreserveRoot`

      StrCpy $GLPreserveActive "0"
    FunctionEnd

    Function GL.PreservePage
      Call GL.DoPreserve
      Abort
    FunctionEnd

    Function GL.OnUserAbort
      Call GL.DoRestore
    FunctionEnd

    Function .onInstFailed
      Call GL.DoRestore
    FunctionEnd
  !macroend

  !macro customPageAfterChangeDir
    Page custom GL.PreservePage
  !macroend

  !macro customInstall
    Call GL.DoRestore
  !macroend

!endif

; =============================================================================
; UNINSTALLER: keep game/ + save/ when removing app files (upgrade + uninstall)
; =============================================================================

!macro customRemoveFiles
  Push $R0
  Push $R1

  StrCpy $R1 ""
  ${StdUtils.GetParentPath} $R0 `$INSTDIR`
  ${if} $R0 != ""
    StrCpy $R1 `$R0\.gamelaucher-userdata-preserve`
  ${else}
    StrCpy $R1 `$PLUGINSDIR\gamelaucher-userdata-preserve`
  ${endIf}

  CreateDirectory `$R1`

  ${if} ${FileExists} `$INSTDIR\game`
    ClearErrors
    Rename `$INSTDIR\game` `$R1\game`
    ${if} ${Errors}
      ClearErrors
      CreateDirectory `$R1\game`
      CopyFiles /SILENT `$INSTDIR\game\*.*` `$R1\game`
    ${endIf}
  ${endIf}

  ${if} ${FileExists} `$INSTDIR\save`
    ClearErrors
    Rename `$INSTDIR\save` `$R1\save`
    ${if} ${Errors}
      ClearErrors
      CreateDirectory `$R1\save`
      CopyFiles /SILENT `$INSTDIR\save\*.*` `$R1\save`
    ${endIf}
  ${endIf}

  RMDir /r `$INSTDIR`
  CreateDirectory `$INSTDIR`

  ${if} ${FileExists} `$R1\game`
    ClearErrors
    Rename `$R1\game` `$INSTDIR\game`
    ${if} ${Errors}
      ClearErrors
      CreateDirectory `$INSTDIR\game`
      CopyFiles /SILENT `$R1\game\*.*` `$INSTDIR\game`
      RMDir /r `$R1\game`
    ${endIf}
  ${endIf}

  ${if} ${FileExists} `$R1\save`
    ClearErrors
    Rename `$R1\save` `$INSTDIR\save`
    ${if} ${Errors}
      ClearErrors
      CreateDirectory `$INSTDIR\save`
      CopyFiles /SILENT `$R1\save\*.*` `$INSTDIR\save`
      RMDir /r `$R1\save`
    ${endIf}
  ${endIf}

  RMDir `$R1`

  Pop $R1
  Pop $R0
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r `$LOCALAPPDATA\hydralauncher-updater`
    RMDir /r `$LOCALAPPDATA\gamelaucher-updater`
  ${endIf}
!macroend
