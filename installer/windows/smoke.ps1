# Silent install from the setup program, doctor, version, upgrade, then Add/Remove Programs uninstall.
# CI only. A shape-valid code with a fake key; nothing ships, nothing starts at login.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\windows\smoke.ps1 -Installer <exe> -Version <x.y.z[-rc.n]>
param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$Version
)
$ErrorActionPreference = 'Stop'
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$logs = Join-Path $tempRoot 'autotrack-installer-smoke'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$data = Join-Path $env:LOCALAPPDATA 'autotrack'
$app = Join-Path $data 'app'
$uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'

function Step([string]$m) { Write-Host ''; Write-Host "== $m" }
function Die([string]$m) { Write-Host "::error::installer smoke: $m"; throw "installer smoke: $m" }
function Setup([string]$name, [string[]]$extra) {
    $argList = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$(Join-Path $logs "$name.log")`"") + $extra
    # A hung setup (a message box nobody can click) fails in 3 minutes, not at the job timeout.
    $p = Start-Process -FilePath $Installer -ArgumentList $argList -PassThru
    if (-not $p.WaitForExit(180000)) {
        Get-Process | Where-Object { $_.Name -like 'autotrack-setup*' -or $_.Name -like 'unins*' } | Stop-Process -Force -ErrorAction SilentlyContinue
        Die "${name}: setup did not finish in 3 minutes"
    }
    return $p.ExitCode
}
function Entry {
    Get-ChildItem $uninstallRoot -ErrorAction SilentlyContinue |
        Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -eq 'autotrack' } | Select-Object -First 1
}

$env:AUTOTRACK_NO_AUTOSTART = '1'
$env:AUTOTRACK_NO_BROWSER = '1'
$fake = @{ v = 1; bucket = 'autotrack-smoke'; region = 'us-east-1'; device = 'smoke'; keyId = 'AKIASMOKETESTKEY0001'; secret = 'smoke-secret-not-a-real-key' } | ConvertTo-Json -Compress
$code = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($fake)).TrimEnd('=').Replace('+', '-').Replace('/', '_')

Step 'no code: refused'
Remove-Item Env:AUTOTRACK -ErrorAction SilentlyContinue
$rc = Setup 'nocode' @()
Write-Host "exit code $rc"
if ($rc -eq 0) { Die "no code: setup said yes, wanted a refusal" }
if (Test-Path -LiteralPath $app) { Die 'no code: something was installed' }

Step 'bad code: refused'
$rc = Setup 'badcode' @('/CODE=not!a!code')
Write-Host "exit code $rc"
if ($rc -eq 0) { Die "bad code: setup said yes, wanted a refusal" }
$rc = Setup 'badcode2' @("/CODE=$('A' * 40)")
if ($rc -eq 0) { Die "undecodable code: setup said yes, wanted a refusal" }
if (Test-Path -LiteralPath $app) { Die 'bad code: something was installed' }

Step 'install with /CODE'
$rc = Setup 'install' @("/CODE=$code")
if ($rc -ne 0) { Die "install: exit $rc" }
$cli = Join-Path $app 'autotrack.cmd'
if (-not (Test-Path -LiteralPath $cli)) { Die "no $cli" }
$v = (Get-Content -LiteralPath (Join-Path $app 'VERSION') -Raw).Trim()
if (-not $v.StartsWith("$Version+")) { Die "installed $v, expected $Version+<sha>" }
if (-not (Test-Path -LiteralPath (Join-Path $data 'config.json'))) { Die 'no config.json' }
if (-not (Test-Path -LiteralPath (Join-Path $data 'extension\manifest.json'))) { Die 'no unpacked extension' }
if (-not (Entry)) { Die 'no Add/Remove Programs entry' }
if (Get-ScheduledTask -TaskName autotrack -ErrorAction SilentlyContinue) { Die 'a scheduled task was registered despite AUTOTRACK_NO_AUTOSTART' }
if (@((Get-Acl -LiteralPath (Join-Path $data 'config.json')).Access).Count -ne 1) { Die 'config.json is readable by more than this user' }
& $cli doctor
Write-Host "installed $v"

Step 'upgrade with the code in the environment'
$env:AUTOTRACK = $code
$rc = Setup 'upgrade' @()
Remove-Item Env:AUTOTRACK -ErrorAction SilentlyContinue
if ($rc -ne 0) { Die "upgrade: exit $rc" }
if (-not (Test-Path -LiteralPath $cli)) { Die 'upgrade lost the app' }
$entries = @(Get-ChildItem $uninstallRoot | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -eq 'autotrack' })
if ($entries.Count -ne 1) { Die "upgrade left $($entries.Count) Add/Remove Programs entries" }

Step 'uninstall (what Add/Remove Programs runs)'
$uninstall = (Get-ItemProperty (Entry).PSPath).UninstallString
if (-not $uninstall) { Die 'no UninstallString' }
$unins = $uninstall.Trim('"')
if (-not (Test-Path -LiteralPath $unins)) { Die "no $unins" }
$p = Start-Process -FilePath $unins -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$(Join-Path $logs 'uninstall.log')`"" -PassThru
if (-not $p.WaitForExit(180000)) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; Die 'uninstall did not finish in 3 minutes' }
if ($p.ExitCode -ne 0) { Die "uninstall: exit $($p.ExitCode)" }
# node.exe can't delete its own folder: a detached cmd removes it ~3 s after exit.
for ($i = 0; $i -lt 40 -and ((Test-Path -LiteralPath $app) -or (Test-Path -LiteralPath $unins)); $i++) { Start-Sleep -Milliseconds 500 }
if (Test-Path -LiteralPath $app) { Die "uninstall left $app" }
if (Test-Path -LiteralPath $unins) { Die "uninstall left $unins" }
if (Entry) { Die 'uninstall left the Add/Remove Programs entry' }
Write-Host 'installer smoke ok'
