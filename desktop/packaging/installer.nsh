; Windows installs of the earlier (Tauri) app lived in %LOCALAPPDATA%\Nako with their own
; uninstaller. Remove that copy quietly when this one goes in, so there's one Nako in the Start
; menu. Settings and the portal address live in %APPDATA%\moe.nakode.portal and stay.
!macro customInstall
  IfFileExists "$LOCALAPPDATA\Nako\uninstall.exe" 0 +2
    ExecWait '"$LOCALAPPDATA\Nako\uninstall.exe" /S _?=$LOCALAPPDATA\Nako'
!macroend
