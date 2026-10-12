param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$HostPath,
  [Parameter(Mandatory = $true)][string]$NodePath
)
$ErrorActionPreference = 'Stop'
[System.IO.File]::WriteAllLines(
  (Join-Path (Split-Path -Parent $OutputPath) 'launcher.txt'),
  [string[]]@($NodePath, $HostPath),
  (New-Object System.Text.UTF8Encoding $false))
Add-Type -Path $Source -OutputAssembly $OutputPath -OutputType ConsoleApplication
if (-not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) {
  throw 'Windows native host executable was not created.'
}
