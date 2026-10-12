@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0.tandix-prebuilt" set "TANDIX_PREBUILT=1"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
if errorlevel 1 goto failed

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-dsh-background.ps1"
if errorlevel 1 goto failed

echo.
echo Installation files are ready and the local agent is connected.
echo In Chrome, enable Developer mode and choose Load unpacked.
echo Select the extension folder path printed by the installer above.
echo Then open an ordinary webpage and click the Tandix extension icon.
pause
exit /b 0

:failed
echo.
echo Installation did not finish. Check the messages above.
pause
exit /b 1
