$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).ProviderPath
$DshCli = Join-Path $Root 'node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path -LiteralPath $DshCli -PathType Leaf)) {
  [Console]::Error.WriteLine('网页助手尚未完成依赖安装，请先双击“安装网页助手.cmd”。')
  exit 1
}

function Get-BridgePort {
  foreach ($Port in @(3080, 3081, 3090, 14389, 43189)) {
    try {
      $Config = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/ext/bridge-config" -TimeoutSec 1
      if ($Config.wsUrl -eq "ws://127.0.0.1:$Port/ext/bridge") { return $Port }
    } catch { }
  }
  return $null
}

# Re-running the installer should reuse a healthy local bridge instead of opening another Agent.
$ExistingPort = Get-BridgePort
if ($null -ne $ExistingPort) {
  Write-Host "网页助手本地 Agent 已在端口 $ExistingPort 运行。"
  exit 0
}

$PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$Runner = Join-Path $PSScriptRoot 'run-dsh-windows.ps1'
Start-Process -FilePath $PowerShell `
  -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`"" `
  -WorkingDirectory $Root -WindowStyle Minimized | Out-Null

$Deadline = [DateTime]::UtcNow.AddSeconds(25)
while ([DateTime]::UtcNow -lt $Deadline) {
  Start-Sleep -Milliseconds 500
  $Port = Get-BridgePort
  if ($null -ne $Port) {
    Write-Host "网页助手本地 Agent 已连接，端口 $Port。关闭最小化的 Agent 窗口会停止它。"
    exit 0
  }
}

[Console]::Error.WriteLine('本地 Agent 未能连接。请还原最小化的 Agent 窗口查看错误信息。')
exit 1
