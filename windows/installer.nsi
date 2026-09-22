Unicode True
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"

!define PRODUCT_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\WindowsUse"
Name "Windows Use"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\WindowsUse"
RequestExecutionLevel user
SetCompressor /SOLID lzma
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "Windows Use"
VIAddVersionKey /LANG=1033 "FileDescription" "Windows Use client installer"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "MIT License"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${PAYLOAD}/LICENSE"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\WindowsUse.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Windows Use 시작"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Korean"
!insertmacro MUI_LANGUAGE "English"

Section "Windows Use (필수)" SEC_MAIN
  SectionIn RO
  SetShellVarContext current
  SetRegView 64
  ; Only install into a new directory or a directory owned by this installer.
  IfFileExists "$INSTDIR\*.*" 0 directory_ready
  IfFileExists "$INSTDIR\.windows-use-client" 0 foreign_directory
  FileOpen $0 "$INSTDIR\.windows-use-client" r
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "WindowsUse.Client" directory_ready foreign_directory
  foreign_directory:
    MessageBox MB_OK|MB_ICONSTOP "설치 폴더에 다른 파일이 있습니다. Windows Use 전용 폴더를 사용하세요." /SD IDOK
    Abort
  directory_ready:
  IfFileExists "$INSTDIR\WindowsUse.exe" 0 client_stopped
    ExecWait '"$INSTDIR\WindowsUse.exe" --shutdown' $0
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "실행 중인 Windows Use를 종료한 뒤 설치를 다시 실행하세요." /SD IDOK
      Abort
    ${EndIf}
  client_stopped:
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}/*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Windows Use"
  CreateShortcut "$SMPROGRAMS\Windows Use\Windows Use.lnk" "$INSTDIR\WindowsUse.exe"
  CreateShortcut "$SMPROGRAMS\Windows Use\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${PRODUCT_KEY}" "DisplayName" "Windows Use"
  WriteRegStr HKCU "${PRODUCT_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${PRODUCT_KEY}" "Publisher" "windows-use"
  WriteRegStr HKCU "${PRODUCT_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${PRODUCT_KEY}" "DisplayIcon" "$INSTDIR\WindowsUse.exe"
  WriteRegStr HKCU "${PRODUCT_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKCU "${PRODUCT_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${PRODUCT_KEY}" "NoRepair" 1
SectionEnd

Section "Windows 로그인 시 자동 시작" SEC_STARTUP
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WindowsUse" '$\"$INSTDIR\WindowsUse.exe$\" --background'
SectionEnd

Section "-Apply startup choice"
  SectionGetFlags ${SEC_STARTUP} $0
  IntOp $0 $0 & 1
  ${If} $0 == 0
    ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WindowsUse"
    ${If} $1 == '$\"$INSTDIR\WindowsUse.exe$\" --background'
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WindowsUse"
    ${EndIf}
  ${EndIf}
SectionEnd

Function .onInit
  SetRegView 64
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "Windows 10 또는 Windows 11이 필요합니다." /SD IDOK
    Abort
  ${EndIf}
  ${IfNot} ${IsNativeAMD64}
    MessageBox MB_OK|MB_ICONSTOP "이 설치 파일은 x64 Windows용입니다." /SD IDOK
    Abort
  ${EndIf}
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" "Release"
  ${If} $0 < 528040
    MessageBox MB_OK|MB_ICONSTOP "Windows 기본 구성 요소인 .NET Framework 4.8 이상이 필요합니다. Windows를 업데이트한 뒤 다시 실행하세요." /SD IDOK
    Abort
  ${EndIf}
  ; Preserve a user's disabled startup choice when upgrading.
  ReadRegStr $0 HKCU "${PRODUCT_KEY}" "InstallLocation"
  ${If} $0 != ""
    ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WindowsUse"
    ${If} $1 == ""
      SectionSetFlags ${SEC_STARTUP} 0
    ${EndIf}
  ${EndIf}
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  ExecWait '"$INSTDIR\WindowsUse.exe" --shutdown' $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "실행 중인 Windows Use를 종료한 뒤 다시 제거하세요." /SD IDOK
    Abort
  ${EndIf}
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WindowsUse"
  ${If} $0 == '$\"$INSTDIR\WindowsUse.exe$\" --background'
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WindowsUse"
  ${EndIf}
  ReadRegStr $0 HKCU "${PRODUCT_KEY}" "InstallLocation"
  ${If} $0 == "$INSTDIR"
    DeleteRegKey HKCU "${PRODUCT_KEY}"
    Delete "$SMPROGRAMS\Windows Use\Windows Use.lnk"
    Delete "$SMPROGRAMS\Windows Use\Uninstall.lnk"
    RMDir "$SMPROGRAMS\Windows Use"
  ${EndIf}
  ; Generated exact file list: never recursively delete user files or .windows-use settings.
  !include "${UNINSTALL_FILES}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
