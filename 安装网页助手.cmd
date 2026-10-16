@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0.tandix-prebuilt" set "TANDIX_PREBUILT=1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1" %*
if errorlevel 1 (
  echo Setup failed. See the install log printed above.
  pause
  exit /b 1
)
pause
exit /b 0
