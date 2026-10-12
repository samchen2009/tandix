# Download a pinned official Node runtime for the current Windows architecture.
param([Parameter(Mandatory = $true)][string]$PackageRoot)
$ErrorActionPreference = 'Stop'
$machine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($machine) {
  'AMD64' { 'x64' }
  'ARM64' { 'arm64' }
  default { throw "Unsupported Windows architecture: $machine" }
}
$version = '24.21.0'
$expected = switch ($arch) {
  'x64' { '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541' }
  'arm64' { '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921' }
}
$runtime = Join-Path $PackageRoot "runtime\node-win-$arch"
if (Test-Path -LiteralPath (Join-Path $runtime 'node.exe') -PathType Leaf) { exit 0 }
$work = Join-Path $env:TEMP ('tandix-node-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $name = "node-v$version-win-$arch.zip"
  $archive = Join-Path $work $name
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Write-Host "Downloading official Node.js $version for Windows $arch..."
  Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$version/$name" -OutFile $archive
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw 'Official Node.js archive SHA-256 mismatch.'
  }
  $extract = Join-Path $work 'extracted'
  Expand-Archive -LiteralPath $archive -DestinationPath $extract
  $nodeRoot = Join-Path $extract "node-v$version-win-$arch"
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $nodeRoot 'node.exe') -Destination $runtime
  Copy-Item -LiteralPath (Join-Path $nodeRoot 'LICENSE') -Destination $runtime
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
