# Compatibility URL only. The maintained installer is scripts/install/windows.ps1.
param(
  [switch]$Help,
  [string]$SourceRoot,
  [string]$InstallHome,
  [ValidateSet('codex', 'cursor', 'workbuddy', 'dsh')][string[]]$Agents = @('codex', 'cursor', 'workbuddy', 'dsh'),
  [ValidateSet('auto', 'codex', 'cursor', 'workbuddy', 'dsh')][string]$Agent = 'auto',
  [string]$ExtensionId,
  [switch]$NonInteractive,
  [switch]$FunctionsOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$relative = 'install/windows.ps1'
if ($env:TANDIX_WINDOWS_BUILD_ONLY -eq '1') { $relative = 'install/source-windows.ps1' }
$entry = if ($PSScriptRoot) { Join-Path $PSScriptRoot $relative } else { $null }
$temporaryDirectory = $null
try {
  if (-not $entry -or -not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('tandix-entry-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
    $entry = Join-Path $temporaryDirectory 'installer.ps1'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri ('https://raw.githubusercontent.com/samchen2009/tandix/main/scripts/' + $relative) -OutFile $entry
  }
  if ($FunctionsOnly) { . $entry @PSBoundParameters }
  else { & $entry @PSBoundParameters; exit $LASTEXITCODE }
} finally {
  if ($temporaryDirectory) { Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue }
}
