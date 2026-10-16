@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo Tandix Codex installer for Windows
set "NODE_EXE=%~dp0runtime\node-win-x64\node.exe"
if exist "%~dp0runtime\node-win-arm64\node.exe" set "NODE_EXE=%~dp0runtime\node-win-arm64\node.exe"
if exist "%NODE_EXE%" goto have_node
where node >nul 2>&1
if errorlevel 1 goto download_node
node -e "const v=process.versions.node.split('.').map(Number);process.exit((v[0]===22&&v[1]>=19)||v[0]>=24?0:1)" >nul 2>&1
if errorlevel 1 goto download_node
set "NODE_EXE=node"
goto have_node
:download_node
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install\node-windows.ps1" -PackageRoot "%~dp0"
if errorlevel 1 goto missing_node
set "NODE_EXE=%~dp0runtime\node-win-x64\node.exe"
if exist "%~dp0runtime\node-win-arm64\node.exe" set "NODE_EXE=%~dp0runtime\node-win-arm64\node.exe"
:have_node
"%NODE_EXE%" "%~dp0scripts\install\codex.mjs" prepare
if errorlevel 1 goto failed
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install\open-chrome-windows.ps1"
if errorlevel 1 echo Automatic Chrome launch failed. Follow the manual steps below.
echo.
echo Open Chrome at chrome://extensions, enable Developer mode, and click Load unpacked.
echo Choose the Chrome extension folder printed above, then return here.
pause
"%NODE_EXE%" "%~dp0scripts\install\codex.mjs" register
if not errorlevel 1 goto done
echo.
echo Automatic extension ID detection failed. Copy the Tandix ID from chrome://extensions.
set /p "EXT_ID=Extension ID: "
"%NODE_EXE%" "%~dp0scripts\install\codex.mjs" register "%EXT_ID%"
if errorlevel 1 goto failed
:done
echo.
echo Installation complete. Reload Tandix in chrome://extensions and select Codex in the side panel.
echo Make sure Codex CLI is signed in to ChatGPT.
pause
exit /b 0
:missing_node
echo.
echo Node.js is missing and the official Node.js download did not finish.
echo Check access to https://nodejs.org/en/download and retry.
pause
exit /b 1
:failed
echo.
echo Installation did not finish. Check the error above.
pause
exit /b 1
