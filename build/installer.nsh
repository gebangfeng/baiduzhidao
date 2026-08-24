!macro customInstallMode
  StrCpy $0 "$INSTDIR" 19 -19
  StrCmp $0 "playwright-browsers" 0 done
  DeleteRegValue HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  DeleteRegValue HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${APP_FILENAME}"
  done:
!macroend
