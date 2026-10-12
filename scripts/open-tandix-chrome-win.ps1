# Open the extensions page in Google Chrome, including non-default installations.
$ErrorActionPreference = 'Stop'
$candidates = @()
foreach ($key in @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe'
)) {
  try {
    if (Test-Path -LiteralPath $key) {
      $value = (Get-Item -LiteralPath $key).GetValue('')
      if ($value) { $candidates += ([string]$value).Trim('"') }
    }
  } catch { Write-Verbose "Could not read optional Chrome registration: $key" }
}
$command = Get-Command chrome.exe -CommandType Application -ErrorAction SilentlyContinue
if ($command) { $candidates += $command.Source }
foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
  if ($base) { $candidates += Join-Path $base 'Google\Chrome\Application\chrome.exe' }
}
$failures = @()
foreach ($candidate in @($candidates | Select-Object -Unique)) {
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
  try {
    Write-Host "Opening Chrome extensions page using: $candidate"
    Start-Process -FilePath $candidate -ArgumentList @('--new-window', 'chrome://extensions/') -ErrorAction Stop
    exit 0
  } catch {
    $failures += $_.Exception.Message
  }
}
if ($failures.Count) {
  Write-Warning ('Chrome could not be started: ' + ($failures -join '; '))
} else {
  Write-Warning 'Google Chrome was not found in App Paths, PATH, or its usual install folders.'
}
Write-Host 'Open Google Chrome manually and enter chrome://extensions/ in its address bar.'
exit 1
