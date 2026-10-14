# Builds the Windows setup program with Inno Setup:
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\windows\build.ps1
# Needs bundles\autotrack-win32-x64.zip (node scripts/bundle.mjs on Windows). Writes
# installer\windows\out\autotrack-setup-<version>.exe and prints its path.
param(
    [string]$BundleDir = '',
    [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $BundleDir) { $BundleDir = Join-Path $repo 'bundles' }
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }

$version = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^(\d+)\.(\d+)\.(\d+)') { throw "package.json version '$version' is not x.y.z" }
$numeric = "$($Matches[1]).$($Matches[2]).$($Matches[3]).0"

$zip = Join-Path $BundleDir 'autotrack-win32-x64.zip'
if (-not (Test-Path -LiteralPath $zip)) { throw "no $zip (run node scripts/bundle.mjs first)" }

# Inno Setup 6: on the GitHub Windows image already; otherwise Chocolatey.
function Find-Iscc {
    $roots = @(${env:ProgramFiles(x86)}, $env:ProgramFiles, "$env:LOCALAPPDATA\Programs") | Where-Object { $_ }
    foreach ($r in $roots) {
        $p = Join-Path $r 'Inno Setup 6\ISCC.exe'
        if (Test-Path -LiteralPath $p) { return $p }
    }
    $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}
$iscc = Find-Iscc
if (-not $iscc) {
    Write-Host 'Inno Setup not found: installing it with Chocolatey'
    choco install innosetup -y --no-progress
    $iscc = Find-Iscc
}
if (-not $iscc) { throw 'ISCC.exe not found' }

# What the setup program carries: the bundle, its checksum, and the two scripts it runs.
$stage = Join-Path $PSScriptRoot 'stage'
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath $zip -Destination $stage
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
[IO.File]::WriteAllText((Join-Path $stage 'SHA256SUMS'), "$hash  autotrack-win32-x64.zip`n", [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $repo 'install\install.ps1') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'run.ps1') -Destination $stage

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Write-Host "Inno Setup: $iscc"
& $iscc "/DAppVersion=$version" "/DNumericVersion=$numeric" "/DStageDir=$stage" "/DOutDir=$OutDir" (Join-Path $PSScriptRoot 'autotrack.iss')
if ($LASTEXITCODE -ne 0) { throw "ISCC exited $LASTEXITCODE" }
Remove-Item -LiteralPath $stage -Recurse -Force

$exe = Join-Path $OutDir "autotrack-setup-$version.exe"
if (-not (Test-Path -LiteralPath $exe)) { throw "ISCC did not write $exe" }
Write-Host ("Built {0} ({1:N1} MB)" -f $exe, ((Get-Item -LiteralPath $exe).Length / 1MB))
