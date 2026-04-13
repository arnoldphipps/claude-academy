@echo off
echo.
echo  ========================================
echo   Prompt AI Academy - Deploy to Live
echo  ========================================
echo.
cd /d C:\Users\a_phi\OneDrive\Desktop\claude-academy\claude-academy

echo  Syncing latest from GitHub...
git pull origin main
echo.

echo  Describe what changed (or press Enter for default):
set /p MSG=
if "%MSG%"=="" set MSG=Update from Prompt AI Academy

echo  Adding all changes...
git add -A
echo  Committing: %MSG%
git commit -m "%MSG%"
echo  Pushing to GitHub + Railway...
git push origin main
echo.
echo  ========================================
echo   DEPLOYED! Changes will be live in ~2 min
echo  ========================================
echo.
pause
