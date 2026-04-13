@echo off
echo.
echo  ========================================
echo   Prompt AI Academy - Full Access Mode
echo   Disabling ALL locks for Claude access
echo  ========================================
echo.

:: Disable screen saver
reg add "HKCU\Control Panel\Desktop" /v ScreenSaveActive /t REG_SZ /d 0 /f
echo  [DONE] Screen saver disabled

:: Disable screen saver lock (require password)
reg add "HKCU\Control Panel\Desktop" /v ScreenSaverIsSecure /t REG_SZ /d 0 /f
echo  [DONE] Screen saver lock disabled

:: Set screen timeout to never on AC power
powercfg /change monitor-timeout-ac 0
echo  [DONE] Screen never turns off (plugged in)

:: Set sleep to never on AC power
powercfg /change standby-timeout-ac 0
echo  [DONE] Sleep disabled (plugged in)

:: Disable hibernate on AC power
powercfg /change hibernate-timeout-ac 0
echo  [DONE] Hibernate disabled (plugged in)

:: Disable lock screen requirement
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v DisableLockWorkstation /t REG_DWORD /d 1 /f 2>nul
echo  [DONE] Lock workstation disabled

:: Disable sign-in required after sleep
reg add "HKLM\SOFTWARE\Policies\Microsoft\Power\PowerSettings\0e796bdb-100d-47d6-a2d5-f7d2daa51f51" /v ACSettingIndex /t REG_DWORD /d 0 /f 2>nul
echo  [DONE] No password after sleep

:: Disable dynamic lock (auto-lock when phone walks away)
reg add "HKCU\Software\Microsoft\Windows NT\CurrentVersion\Winlogon" /v EnableGoodbye /t REG_DWORD /d 0 /f 2>nul
echo  [DONE] Dynamic lock disabled

:: Set screen timeout on battery to 30 min (protect battery)
powercfg /change monitor-timeout-dc 30
powercfg /change standby-timeout-dc 60
echo  [DONE] Battery: screen 30min, sleep 60min

echo.
echo  ========================================
echo   LAPTOP FULLY OPEN FOR CLAUDE ACCESS
echo   Keep charger plugged in!
echo  ========================================
echo.
echo  NOTE: You may also need to go to:
echo  Settings ^> Accounts ^> Sign-in Options
echo  and set "Require sign-in" to "Never"
echo.
pause
