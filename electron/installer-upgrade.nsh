!ifndef BUILD_UNINSTALLER
# Keep normal uninstall shortcut cleanup, but defer creation to the finish page.
# These defines must precede electron-builder's MUI_PAGE_FINISH expansion.
!ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
  !define DO_NOT_CREATE_DESKTOP_SHORTCUT
  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "$(TixTabDesktopShortcutOption)"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION TixTabFinishDesktopShortcut
  !define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!endif

!macro customHeader
!include WordFunc.nsh

Var TixTabInstalledVersion
Var TixTabInstalledFolder
Var TixTabUpgradeDialog
Var TixTabVersionOrder

LangString TixTabUpgradeTitle 1033 "Update TixTab"
LangString TixTabUpgradeTitle 2052 "升级 TixTab"
LangString TixTabUpgradeSubtitle 1033 "An existing installation was detected."
LangString TixTabUpgradeSubtitle 2052 "检测到已有安装。"
LangString TixTabUpgradeText 1033 "Installed: $TixTabInstalledVersion$\r$\nThis installer: ${VERSION}$\r$\n$\r$\nContinue to replace the installed application. Workspace, settings, downloaded models and compiled caches are preserved."
LangString TixTabUpgradeText 2052 "已安装版本：$TixTabInstalledVersion$\r$\n安装包版本：${VERSION}$\r$\n$\r$\n继续将替换已安装的程序，并保留工作空间、设置、下载的模型和编译缓存。"
LangString TixTabSameVersionText 1033 "TixTab ${VERSION} is already installed. Continue to repair or reinstall application files. Your application data is preserved."
LangString TixTabSameVersionText 2052 "已安装 TixTab ${VERSION}。继续可修复或重新安装程序文件，应用数据将保留。"
LangString TixTabNewerVersionText 1033 "A newer TixTab version ($TixTabInstalledVersion) is installed. This installer (${VERSION}) cannot downgrade it. Use the same or a newer installer."
LangString TixTabNewerVersionText 2052 "已安装较新的 TixTab $TixTabInstalledVersion，当前安装包 ${VERSION} 不允许降级。请使用相同或更新版本的安装包。"
LangString TixTabUpgradeFolder 1033 "Existing installation: $TixTabInstalledFolder$\r$\nDestination: $INSTDIR"
LangString TixTabUpgradeFolder 2052 "已有安装：$TixTabInstalledFolder$\r$\n目标目录：$INSTDIR"
LangString TixTabDesktopShortcutOption 1033 "Create a desktop shortcut"
LangString TixTabDesktopShortcutOption 2052 "创建桌面快捷方式"

!ifndef BUILD_UNINSTALLER
Function TixTabNormalizeInstallDirectory
  Push $0
  Push $1
  # Preserve an unchanged existing installation, including legacy folder names.
  ${If} $TixTabInstalledFolder != ""
  ${AndIf} $INSTDIR == $TixTabInstalledFolder
    Goto tixtab_directory_done
  ${EndIf}
  # Strip trailing separators before inspecting the final component, not a
  # substring (e.g. D:\TixTab Projects\Apps still needs its own TixTab folder).
  tixtab_directory_trim:
    StrCpy $0 $INSTDIR 1 -1
    ${If} $0 == "\"
    ${OrIf} $0 == "/"
      StrCpy $INSTDIR $INSTDIR -1
      Goto tixtab_directory_trim
    ${EndIf}
  ${GetFileName} "$INSTDIR" $1
  ${If} $1 != "TixTab"
    StrCpy $INSTDIR "$INSTDIR\TixTab"
  ${EndIf}
  tixtab_directory_done:
  Pop $1
  Pop $0
FunctionEnd

Function TixTabFinishDesktopShortcut
  ClearErrors
  CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  ${IfNot} ${Errors}
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
FunctionEnd

Function TixTabBeforeInstallPage
  # Retain the upstream helper as a link reference without executing its
  # substring-based behavior (electron-builder treats unused-code warnings as errors).
  Push $0
  GetFunctionAddress $0 instFilesPre
  Pop $0
  Call TixTabCheckInstalledVersion
  Call TixTabNormalizeInstallDirectory
FunctionEnd

Function TixTabCheckInstalledVersion
  ReadRegStr $TixTabInstalledFolder SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $TixTabInstalledVersion SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
  ${If} $TixTabInstalledFolder == ""
    Return
  ${EndIf}
  IfFileExists "$TixTabInstalledFolder\${APP_EXECUTABLE_FILENAME}" +3 0
    StrCpy $TixTabInstalledFolder ""
    Return
  ${If} $TixTabInstalledVersion != ""
    ${VersionCompare} "$TixTabInstalledVersion" "${VERSION}" $TixTabVersionOrder
    ${If} $TixTabVersionOrder == 1
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(TixTabNewerVersionText)"
      ${EndIf}
      SetErrorLevel 1638
      Quit
    ${EndIf}
  ${EndIf}
FunctionEnd

Function TixTabUpgradePage
  Call TixTabCheckInstalledVersion
  Call TixTabNormalizeInstallDirectory
  ${If} $TixTabInstalledFolder == ""
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(TixTabUpgradeTitle)" "$(TixTabUpgradeSubtitle)"
  nsDialogs::Create 1018
  Pop $TixTabUpgradeDialog
  ${If} $TixTabUpgradeDialog == error
    Abort
  ${EndIf}
  ${If} $TixTabInstalledVersion == "${VERSION}"
    ${NSD_CreateLabel} 0 0 100% 65u "$(TixTabSameVersionText)"
  ${Else}
    ${NSD_CreateLabel} 0 0 100% 65u "$(TixTabUpgradeText)"
  ${EndIf}
  Pop $0
  ${NSD_CreateLabel} 0 75u 100% 60u "$(TixTabUpgradeFolder)"
  Pop $0
  nsDialogs::Show
FunctionEnd
!endif

!macroend

!macro customInit
  Call TixTabCheckInstalledVersion
  Call TixTabNormalizeInstallDirectory
!macroend

!macro customInstall
  # Only a signed identity package is registered on end-user machines. Never
  # enable developer mode or install a development trust certificate here.
  IfFileExists "$INSTDIR\native\windows-ai-ocr\TixTab.WindowsAI.Ocr.identity.msix" 0 tixtab_ocr_identity_done
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\resources\app.asar.unpacked\electron\windows-ai-register.ps1" -RuntimeDirectory "$INSTDIR\native\windows-ai-ocr"'
    Pop $0
  tixtab_ocr_identity_done:
!macroend

!macro customPageAfterChangeDir
  Page custom TixTabUpgradePage
  # Replace the upstream substring-based sanitizer; this also preserves legacy
  # upgrade locations instead of silently appending a second application folder.
  !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !define MUI_PAGE_CUSTOMFUNCTION_PRE TixTabBeforeInstallPage
!macroend

!endif
