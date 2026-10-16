@echo off
setlocal
chcp 65001 >nul
title Tandix automatic setup
set "TANDIX_SETUP_EXIT=1"
set "TANDIX_SETUP_TEMP="
set "TANDIX_SETUP_SCRIPT=%~dp0scripts\install-windows.ps1"
set "TANDIX_SETUP_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%TANDIX_SETUP_POWERSHELL%" (
  echo Windows PowerShell 5.1 is required. Run this file on Windows 10 or newer.
  goto finish
)
if exist "%~dp0.tandix-prebuilt" set "TANDIX_PREBUILT=1"
if exist "%TANDIX_SETUP_SCRIPT%" goto run

rem This file also works on its own, outside a source checkout.
set "TANDIX_SETUP_TEMP=%TEMP%\Tandix-setup-%RANDOM%-%RANDOM%"
mkdir "%TANDIX_SETUP_TEMP%" 2>nul
if errorlevel 1 (
  set "TANDIX_SETUP_TEMP="
  echo Could not create the temporary setup folder.
  goto finish
)
set "TANDIX_SETUP_SCRIPT=%TANDIX_SETUP_TEMP%\install-windows.ps1"
echo Downloading the latest Tandix setup wizard...
"%TANDIX_SETUP_POWERSHELL%" -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/samchen2009/tandix/main/scripts/install-windows.ps1' -OutFile $env:TANDIX_SETUP_SCRIPT } catch { Write-Host ('Download failed: ' + $_.Exception.Message); exit 1 }"
if errorlevel 1 goto finish

:run
"%TANDIX_SETUP_POWERSHELL%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%TANDIX_SETUP_SCRIPT%" %*
set "TANDIX_SETUP_EXIT=%ERRORLEVEL%"

:finish
if defined TANDIX_SETUP_TEMP if exist "%TANDIX_SETUP_TEMP%" rmdir /s /q "%TANDIX_SETUP_TEMP%"
if not "%TANDIX_SETUP_EXIT%"=="0" echo Setup failed. See the error above and %%LOCALAPPDATA%%\Tandix\install.log if present. Rerun this file to retry.
if not defined TANDIX_INSTALL_NO_PAUSE pause
exit /b %TANDIX_SETUP_EXIT%
