$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).ProviderPath
$DshCli = Join-Path $Root 'node_modules\@deepseek-ai\dsh\lib\bin.js'
$Node = (Get-Command node -ErrorAction Stop).Source
Set-Location -LiteralPath $Root
Write-Host '网页助手（Tandix）本地 Agent 已启动。关闭此窗口会停止 Agent。'
& $Node $DshCli web --no-open
Write-Host "`n本地 Agent 已退出。如需重新启动，请双击安装网页助手.cmd。"
Read-Host '按回车关闭窗口' | Out-Null
