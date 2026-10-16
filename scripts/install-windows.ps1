# Standalone, clone-free source installer for Windows PowerShell 5.1+.
param([switch]$Help)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($Help) {
  Write-Host 'Usage: powershell -NoProfile -ExecutionPolicy Bypass -File .\install-windows.ps1'
  Write-Host 'Requires Chrome and Node.js 22.19+ or 24+ (with npm).'
  Write-Host 'Downloads Tandix source from GitHub and builds it using pnpm 11.7.0.'
  Write-Host 'Load the extension, then run pnpm native:install to connect WorkBuddy or Codex.'
  exit 0
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'This installer is for Windows. On macOS use install-macos.sh.'
}
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
$npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
  throw 'Install Node.js 22.19+ or 24+ with npm, reopen PowerShell, then retry: https://nodejs.org/en/download'
}
& $node.Source -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit((major===22&&minor>=19)||major>=24?0:1)"
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22.19+ or 24+ is required.' }

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$work = Join-Path ([IO.Path]::GetTempPath()) ('tandix-source-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$code = 1
try {
  $installer = Join-Path $work 'install.ps1'
  Write-Host 'Downloading the Tandix source installer from GitHub...'
  Invoke-WebRequest -UseBasicParsing `
    -Uri 'https://raw.githubusercontent.com/samchen2009/tandix/main/scripts/install.ps1' -OutFile $installer
  # Run a file so Windows PowerShell preserves its UTF-8 BOM and interactive input.
  # npm supplies the pinned pnpm to this child process without a global install.
  & $npm.Source exec --yes --package=pnpm@11.7.0 -- powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
  $code = $LASTEXITCODE
  if ($code -eq 0) {
    $dshRoot = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
    $root = (Join-Path $dshRoot 'dsh-browser').Replace("'", "''")
    Write-Host "`nTo start dsh, keep these commands running:"
    Write-Host "  Set-Location -LiteralPath '$root'"
    Write-Host '  npm.cmd exec --yes --package=pnpm@11.7.0 -- pnpm start'
    Write-Host 'Load the extension in chrome://extensions, select dsh in Tandix, and configure a model.'
    Write-Host 'For WorkBuddy or Codex, load the extension first, then run in that source directory:'
    Write-Host '  npm.cmd exec --yes --package=pnpm@11.7.0 -- pnpm native:install'
    Write-Host 'Reload the extension and ensure the chosen agent CLI is installed and signed in.'
  }
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
exit $code
