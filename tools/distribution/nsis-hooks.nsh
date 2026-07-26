!macro NSIS_HOOK_PREINSTALL
  ; R6 contract: upgrades and rollbacks must not touch user data.
  ; MeetingRelay mvp data is intentionally retained at:
  ;   %LOCALAPPDATA%\MeetingRelay\mvp
  ; Windows Credential Manager secrets are intentionally retained.
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Reserved for future migration hooks. Migrations must be additive and reversible.
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; R6 contract: default uninstall removes application files only.
  ; MeetingRelay mvp data is intentionally retained at:
  ;   %LOCALAPPDATA%\MeetingRelay\mvp
  ; Windows Credential Manager secrets are intentionally retained.
  ; Do not add RMDir /r or Delete commands for $LOCALAPPDATA\MeetingRelay here.
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Deliberately empty. Provider tokens remain in Windows Credential Manager
  ; until the user removes them from Provider management or OS tools.
!macroend
