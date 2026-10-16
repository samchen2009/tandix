# Complete Windows setup. Node, pnpm, source, agent CLIs, companion and live checks.
param(
  [switch]$Help,
  [string]$SourceRoot,
  [string]$InstallHome,
  [ValidateSet('dsh', 'workbuddy', 'codex')][string[]]$Agents = @('dsh', 'workbuddy', 'codex'),
  [ValidateSet('dsh', 'workbuddy', 'codex')][string]$Agent = 'dsh',
  [string]$ExtensionId,
  [switch]$NonInteractive,
  [switch]$FunctionsOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

function Invoke-Checked {
  param([string]$Command, [string[]]$Arguments)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Command @Arguments; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $previous }
  if ($code -ne 0) { throw "Command failed (exit $code): $Command" }
}

function Test-Node {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  try {
    & $Path -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit((a===22&&b>=19)||a>=24?0:1)" 2>$null
    return $LASTEXITCODE -eq 0
  } catch { return $false }
}

function Ensure-BuildNode {
  param([string]$InstallHome, [string]$TemporaryDirectory)
  $existing = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
  if ($existing -and (Test-Node $existing.Source) -and
      (Test-Path -LiteralPath (Join-Path (Split-Path $existing.Source) 'node_modules\npm\bin\npm-cli.js'))) {
    return $existing.Source
  }
  $machine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $arch = switch ($machine) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { throw "Unsupported Windows architecture: $machine" } }
  $version = '24.21.0'
  $sha = if ($arch -eq 'x64') { '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541' } else { '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921' }
  $name = "node-v$version-win-$arch"
  $destination = Join-Path $InstallHome "runtime\$name"
  $node = Join-Path $destination 'node.exe'
  if ((Test-Node $node) -and (Test-Path -LiteralPath (Join-Path $destination 'node_modules\npm\bin\npm-cli.js'))) { return $node }
  Write-Host "[1/7] Downloading official Node.js $version ($arch)..."
  $archive = Join-Path $TemporaryDirectory 'node.zip'
  Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$version/$name.zip" -OutFile $archive
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha) { throw 'Node.js archive SHA-256 mismatch.' }
  $expanded = Join-Path $TemporaryDirectory 'node'
  Expand-Archive -LiteralPath $archive -DestinationPath $expanded
  New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
  # Never overwrite a running or damaged executable in place.
  if (Test-Path -LiteralPath $destination) { $destination += '-' + [guid]::NewGuid().ToString('N') }
  Move-Item -LiteralPath (Join-Path $expanded $name) -Destination $destination
  $node = Join-Path $destination 'node.exe'
  if (-not (Test-Node $node)) { throw 'The downloaded Node.js runtime could not start.' }
  return $node
}

function Test-SourceRoot {
  param([string]$Root)
  if (-not $Root) { return $false }
  foreach ($file in @('package.json', 'pnpm-lock.yaml', 'scripts\install\source-windows.ps1', 'extensions\dsh-browser\package.json', 'packages\browser\bridge-browser\package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $file) -PathType Leaf)) { return $false }
  }
  return $true
}

function Get-Chrome {
  foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($base) {
      $path = Join-Path $base 'Google\Chrome\Application\chrome.exe'
      if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    }
  }
  foreach ($hive in @('HKCU:', 'HKLM:')) {
    try {
      $path = (Get-ItemProperty -LiteralPath "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe").'(default)'
      if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) { return $path }
    } catch { }
  }
  return $null
}

function Ensure-Chrome {
  if (Get-Chrome) { return }
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($winget) {
    Write-Host '[2/7] Installing Google Chrome for the current user...'
    try {
      Invoke-Checked $winget.Source @('install', '--id', 'Google.Chrome', '--exact', '--scope', 'user', '--silent', '--accept-package-agreements', '--accept-source-agreements')
    } catch {
      # Some WinGet versions only offer Chrome's machine installer. Let the
      # vendor/OS handle elevation normally instead of assuming user scope.
      try { Invoke-Checked $winget.Source @('install', '--id', 'Google.Chrome', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements') }
      catch { Write-Host 'WinGet could not install Chrome. Opening the official download page.' }
    }
  }
  if (-not (Get-Chrome)) {
    if ($NonInteractive) { throw 'Chrome was not found and could not be installed automatically.' }
    Start-Process 'https://www.google.com/chrome/'
    Read-Host 'Install Chrome from the opened official page, then press Enter' | Out-Null
    if (-not (Get-Chrome)) { throw 'Chrome is still missing.' }
  }
}

function Install-Toolkit {
  param([string]$Node, [string]$Tools)
  New-Item -ItemType Directory -Path $Tools -Force | Out-Null
  $npmCli = Join-Path (Split-Path $Node) 'node_modules\npm\bin\npm-cli.js'
  $pnpm = Join-Path $Tools 'node_modules\pnpm\package.json'
  $correct = $false
  if (Test-Path -LiteralPath $pnpm) {
    $correct = (Get-Content -LiteralPath $pnpm -Raw | ConvertFrom-Json).version -eq '11.7.0'
  }
  if (-not $correct) {
    Write-Host '[2/7] Installing private pnpm 11.7.0...'
    Invoke-Checked $Node @($npmCli, 'install', '--global', '--prefix', $Tools, '--no-audit', '--no-fund', 'pnpm@11.7.0')
  }
}

function Install-Source {
  param([string]$Root, [string]$Node, [string]$TemporaryDirectory)
  if (Test-SourceRoot $Root) { $installer = Join-Path $Root 'scripts\install\source-windows.ps1' }
  else {
    $installer = Join-Path $TemporaryDirectory 'source-windows.ps1'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/samchen2009/tandix/main/scripts/install/source-windows.ps1' -OutFile $installer
    $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
    $Root = Join-Path $dshHome 'dsh-browser'
  }
  Write-Host '[3/7] Installing dependencies, registering the dsh bridge and building the extension...'
  $previous = $env:TANDIX_WINDOWS_BUILD_ONLY
  try {
    $env:TANDIX_WINDOWS_BUILD_ONLY = '1'
    Invoke-Checked 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer)
  } finally { $env:TANDIX_WINDOWS_BUILD_ONLY = $previous }
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'scripts\runtime\connection-check.mjs'))) { throw 'The source installer is outdated. Download the latest Tandix source and retry.' }
  # Do not emit tool output into the returned path.
  $script:ReadySourceRoot = $Root
}

function Install-AgentCli {
  param([string]$Name, [string]$Package, [string]$Node, [string]$Tools)
  $existing = Get-Command "$Name.exe", "$Name.cmd" -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($existing) { return $existing.Source }
  $private = Join-Path $Tools "$Name.cmd"
  if (-not (Test-Path -LiteralPath $private)) {
    Write-Host "[4/7] Installing $Name CLI..."
    $npmCli = Join-Path (Split-Path $Node) 'node_modules\npm\bin\npm-cli.js'
    # Keep install output visible, but keep this function's return value a path.
    Invoke-Checked $Node @($npmCli, 'install', '--global', '--prefix', $Tools, '--no-audit', '--no-fund', $Package) | Out-Host
  }
  if (-not (Test-Path -LiteralPath $private)) { throw "$Name CLI installation did not create its launcher." }
  return $private
}

function Register-Companion {
  param([string]$Root, [string]$Node)
  $hostScript = Join-Path $Root 'scripts\runtime\native-host.mjs'
  Write-Host '[5/7] Loading the Chrome extension and registering its native companion...'
  $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
  $extension = Join-Path $dshHome 'browser-extension'
  Write-Host "Chrome extension folder: $extension"
  try { Set-Clipboard -Value $extension } catch { }
  if (-not $NonInteractive) { Start-Process -FilePath (Get-Chrome) -ArgumentList 'chrome://extensions' }
  while (-not $ExtensionId) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $detected = & $Node $hostScript extension-id 2>&1; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $previous }
    if ($code -eq 0 -and [string]$detected -match '^[a-p]{32}$') { $ExtensionId = [string]$detected; break }
    if ($NonInteractive) { throw 'Could not detect the Chrome extension ID. Supply -ExtensionId explicitly.' }
    Write-Host 'In Chrome: enable Developer mode, choose Load unpacked, and select the folder above.'
    $entered = Read-Host 'After loading it press Enter to retry, or paste the 32-letter Tandix extension ID'
    if ($entered -and $entered -notmatch '^[a-p]{32}$') { Write-Host 'Invalid extension ID.'; continue }
    if ($entered) { $ExtensionId = $entered }
  }
  if ($ExtensionId -notmatch '^[a-p]{32}$') { throw 'Invalid Chrome extension ID.' }
  # Registration/compilation failures are actual errors, not another request to load Chrome.
  Invoke-Checked $Node @($hostScript, 'install', '--extension-id', $ExtensionId)
}

function Test-AgentConnection {
  param([string]$Backend, [string]$Root, [string]$Node, [string]$ReportPath)
  $manifest = Join-Path $HOME '.dsh\traceforge-native-host\io.traceforge.bridge.json'
  $runtime = Join-Path $Root 'node_modules\@deepseek-ai\dsh\lib\bin.js'
  $arguments = @((Join-Path $Root 'scripts\runtime\connection-check.mjs'), '--manifest', $manifest,
    '--runtime', $runtime, '--backend', $Backend, '--report', $ReportPath)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Node @arguments | Out-Host; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $previous }
  if ($code -ne 0 -and -not (Test-Path -LiteralPath $ReportPath)) {
    return [pscustomobject]@{ backend = $Backend; status = 'failed'; message = 'Connection check could not start. See install.log.' }
  }
  return Get-Content -LiteralPath $ReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Invoke-TandixSetup {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Use scripts/install/macos.sh on macOS.' }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $installHome = if ($InstallHome) { $InstallHome } else { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Tandix' }
  $tools = Join-Path $installHome 'tools'
  $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('tandix-setup-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $installHome, $temporaryDirectory -Force | Out-Null
  $log = Join-Path $installHome 'install.log'
  $reportPath = Join-Path $installHome 'install-report.json'
  $transcript = $false
  $results = @()
  try {
    try { Start-Transcript -Path $log -Append | Out-Null; $transcript = $true } catch { }
    $node = Ensure-BuildNode $installHome $temporaryDirectory
    $env:PATH = (Split-Path $node) + ';' + $tools + ';' + $env:PATH
    Install-Toolkit $node $tools
    Ensure-Chrome
    $root = $SourceRoot
    if ($root -and -not (Test-SourceRoot $root)) { throw "Incomplete Tandix source directory: $root" }
    if (-not $root) {
      foreach ($candidate in @((Join-Path $PSScriptRoot '../..'))) {
        if (Test-SourceRoot $candidate) { $root = (Resolve-Path -LiteralPath $candidate).ProviderPath; break }
      }
    }
    Install-Source $root $node $temporaryDirectory
    $root = $script:ReadySourceRoot
    $requested = @($Agents + $Agent | Select-Object -Unique)
    $installFailures = @{}
    if ($requested -contains 'workbuddy') {
      try {
        if (-not $env:WORKBUDDY_AGENT_PATH) {
          $lite = Get-Command 'codebuddy-lite-wb.exe' -CommandType Application -ErrorAction SilentlyContinue
          if ($lite) { $env:WORKBUDDY_AGENT_PATH = $lite.Source }
          else { $env:WORKBUDDY_AGENT_PATH = Install-AgentCli 'codebuddy' '@tencent-ai/codebuddy-code' $node $tools }
        }
      } catch { $installFailures['workbuddy'] = $_.Exception.Message; Write-Host "ATTENTION: WorkBuddy install failed: $_" }
    }
    if ($requested -contains 'codex') {
      try {
        # Existing desktop CLI discovery is performed by the runtime-discovery module.
        $discovery = Join-Path $root 'scripts\runtime\runtime-discovery.mjs'
        $codex = & $node --input-type=module -e "import {pathToFileURL} from 'node:url';const m=await import(pathToFileURL(process.argv[1]));process.stdout.write(m.findCodex()||'');" $discovery
        if ($codex) { $env:CODEX_CLI_PATH = $codex }
        else { $env:CODEX_CLI_PATH = Install-AgentCli 'codex' '@openai/codex' $node $tools }
      } catch { $installFailures['codex'] = $_.Exception.Message; Write-Host "ATTENTION: Codex install failed: $_" }
    }
    Register-Companion $root $node
    Write-Host '[6/7] Checking the actual native messaging and WebSocket connections...'
    foreach ($backend in $requested) {
      $backendReport = Join-Path $temporaryDirectory "$backend.json"
      if ($installFailures.ContainsKey($backend)) {
        $result = [pscustomobject]@{ backend = $backend; status = 'failed'; message = $installFailures[$backend] }
      } else { $result = Test-AgentConnection $backend $root $node $backendReport }
      if ($result.status -ne 'ready' -and $backend -ne 'dsh' -and -not $NonInteractive -and -not $installFailures.ContainsKey($backend)) {
          $launcher = if ($backend -eq 'workbuddy') { $env:WORKBUDDY_AGENT_PATH } else { $env:CODEX_CLI_PATH }
          Write-Host 'Complete sign-in in the CLI, then type /exit to return to setup.'
          $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
          try { if ($launcher -match '\.(mjs|cjs|js)$') { & $node $launcher } else { & $launcher } } finally { $ErrorActionPreference = $previous }
          $result = Test-AgentConnection $backend $root $node $backendReport
      }
      $results += $result
    }
    $ready = @($results | Where-Object { $_.backend -eq $Agent -and $_.status -eq 'ready' }).Count -eq 1
    $overall = if (@($results | Where-Object { $_.status -ne 'ready' }).Count) { 'partial' } else { 'ready' }
    $report = [ordered]@{ status = $overall; schemaVersion = 1; sourceRoot = $root; node = $node; tools = $tools;
      extensionLoading = $(if ($NonInteractive) { 'not-verified' } else { 'user-confirmed-or-detected' });
      selectedAgent = $Agent; selectedAgentReady = $ready; agents = $results }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8
    Write-Host "Connection report: $reportPath"
    if (-not $ready) { throw "$Agent is not ready. See the connection report and install.log." }
    Write-Host "[7/7] $Agent connection check passed. Reload Tandix in chrome://extensions."
    Write-Host "Open Tandix and select $Agent. No pnpm start terminal is needed."
    if ($Agent -eq 'dsh') { Write-Host 'If no model is configured yet, choose a provider/model in Tandix Settings and enter your own credentials.' }
    foreach ($result in $results) {
      if ($result.status -ne 'ready') { Write-Host "ATTENTION: $($result.backend) is installed but its connection failed: $($result.message)" }
    }
    Write-Host "Install log: $log"
  } catch {
    @{ status = 'failed'; schemaVersion = 1; selectedAgentReady = $false; message = $_.Exception.Message; agents = $results } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "Install log: $log"
    throw
  } finally {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
    if ($transcript) { Stop-Transcript | Out-Null }
  }
}

if ($FunctionsOnly) { return }
if ($Help) {
  Write-Host 'Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install/windows.ps1 [-Agent dsh|workbuddy|codex]'
  Write-Host 'Automatically prepares Node, private pnpm, Chrome, source, all three agent runtimes and the native companion.'
  Write-Host 'Chrome first-time extension loading and account sign-in require your interaction.'
  Write-Host 'Use -NonInteractive -ExtensionId <id> -Agents dsh for an unattended dsh transport check.'
  exit 0
}
try { Invoke-TandixSetup; exit 0 } catch { exit 1 }
