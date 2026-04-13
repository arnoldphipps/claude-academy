@echo off
echo.
echo  ========================================
echo   Restoring Normal Power Settings
echo  ========================================
echo.
reg add "HKCU\Control Panel\Desktop" /v ScreenSaveActive /t REG_SZ /d 1 /f
powercfg /change monitor-timeout-ac 15
powercfg /change standby-timeout-ac 30
powercfg /change monitor-timeout-dc 5
powercfg /change standby-timeout-dc 15
powercfg /change hibernate-timeout-ac 60
echo.
echo  [DONE] Normal power settings restored
echo.
pause
