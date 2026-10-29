# Optional PDF registration. Default ownership remains a Windows system-UI choice.
!ifndef BUILD_UNINSTALLER
!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${Else}
        StrCpy $1 ""
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE TixTabFinishPdfAssociation
  !insertmacro MUI_PAGE_FINISH
!macroend
!endif

!macro TixTabPdfHeader
Var TixTabPdfChecked
Var TixTabPdfDialog
Var TixTabPdfCheckbox
LangString TixTabPdfTitle 1033 "PDF files"
LangString TixTabPdfTitle 2052 "PDF 文件"
LangString TixTabPdfSubtitle 1033 "Choose how you want to open PDFs."
LangString TixTabPdfSubtitle 2052 "选择 PDF 文件的打开方式。"
LangString TixTabPdfOption 1033 "Associate .pdf files with TixTab"
LangString TixTabPdfOption 2052 "将 .pdf 文件关联到 TixTab"
LangString TixTabPdfHelp 1033 "Optional, off by default. If selected, TixTab registers as a PDF handler and opens Windows Default apps when setup finishes. Confirm TixTab there to make it your default PDF app. Leaving this unchecked preserves existing associations."
LangString TixTabPdfHelp 2052 "可选，默认不勾选。勾选后将注册 PDF 打开方式，并在安装完成时打开 Windows 默认应用设置，请在那里确认使用 TixTab。未勾选时保留现有文件关联。"
Function TixTabPdfPage
  ${If} ${Silent}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(TixTabPdfTitle)" "$(TixTabPdfSubtitle)"
  nsDialogs::Create 1018
  Pop $TixTabPdfDialog
  ${If} $TixTabPdfDialog == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 8u 100% 18u "$(TixTabPdfOption)"
  Pop $TixTabPdfCheckbox
  ${If} $TixTabPdfChecked == ${BST_CHECKED}
    ${NSD_Check} $TixTabPdfCheckbox
  ${Else}
    ${NSD_Uncheck} $TixTabPdfCheckbox
  ${EndIf}
  ${NSD_CreateLabel} 0 38u 100% 80u "$(TixTabPdfHelp)"
  Pop $0
  nsDialogs::Show
FunctionEnd
Function TixTabPdfPageLeave
  ${NSD_GetState} $TixTabPdfCheckbox $TixTabPdfChecked
FunctionEnd
Function TixTabFinishPdfAssociation
  ${If} $TixTabPdfChecked == ${BST_CHECKED}
  ${AndIfNot} ${Silent}
    ${If} $installMode == "all"
      ExecShell "open" "ms-settings:defaultapps?registeredAppMachine=TixTab"
    ${Else}
      ExecShell "open" "ms-settings:defaultapps?registeredAppUser=TixTab"
    ${EndIf}
  ${EndIf}
FunctionEnd
!macroend

!macro TixTabPdfInstall
  # Keep a previously opted-in registration valid when upgrading or moving the app.
  ReadRegStr $0 SHELL_CONTEXT "Software\RegisteredApplications" "TixTab"
  ${If} $TixTabPdfChecked == ${BST_CHECKED}
  ${OrIf} $0 == "Software\TixTab\Capabilities"
    WriteRegStr SHELL_CONTEXT "Software\Classes\TixTab.PDF" "" "TixTab PDF document"
    WriteRegStr SHELL_CONTEXT "Software\Classes\TixTab.PDF\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
    WriteRegStr SHELL_CONTEXT "Software\Classes\TixTab.PDF\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    WriteRegStr SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "TixTab.PDF" ""
    WriteRegStr SHELL_CONTEXT "Software\TixTab\Capabilities" "ApplicationName" "TixTab"
    WriteRegStr SHELL_CONTEXT "Software\TixTab\Capabilities" "ApplicationDescription" "PDF reading and annotation workspace"
    WriteRegStr SHELL_CONTEXT "Software\TixTab\Capabilities\FileAssociations" ".pdf" "TixTab.PDF"
    WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "TixTab" "Software\TixTab\Capabilities"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
!macroend

!macro customUnInstall
  # An update invokes the previous uninstaller; retain the user's opt-in then.
  ${IfNot} ${isUpdated}
    ReadRegStr $0 SHELL_CONTEXT "Software\Classes\TixTab.PDF\shell\open\command" ""
    ${If} $0 == '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "TixTab.PDF"
      DeleteRegKey SHELL_CONTEXT "Software\Classes\TixTab.PDF"
      DeleteRegKey SHELL_CONTEXT "Software\TixTab\Capabilities"
      DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "TixTab"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${EndIf}
  ${EndIf}
!macroend
