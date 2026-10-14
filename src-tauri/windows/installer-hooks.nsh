; Puts the program folder on the user's PATH so that `forkyard` works in a terminal, and takes it
; off again before Forkyard is uninstalled. The program edits HKCU\Environment\Path itself
; (crates/core/src/commands/cli.rs): NSIS strings are too short for a long PATH.

!macro NSIS_HOOK_POSTINSTALL
  nsExec::Exec '"$INSTDIR\forkyard.exe" --register-path'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec '"$INSTDIR\forkyard.exe" --unregister-path'
  Pop $0
!macroend
