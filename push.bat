@echo off
cd /d "C:\Users\a_phi\OneDrive\Desktop\claude-academy\claude-academy"
echo.
echo ========================================
echo   Prompt AI Academy — Deploy to Live
echo ========================================
echo.
set /p msg="Describe what changed (or press Enter for default): "
if "%msg%"=="" set msg=Update from Claude
echo.
echo Adding all changes...
git add -A
echo Committing: %msg%
git commit -m "%msg%"
echo Pushing to GitHub + Railway...
git push origin main
echo.
echo ========================================
echo   DEPLOYED! Changes will be live in ~2 min
echo ========================================
echo.
pause
