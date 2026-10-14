# Runs install.ps1 from the setup program, one step at a time (AUTOTRACK_STEP in the environment).
# install.ps1 is written for `iex`: it throws on errors and never calls `exit`. This turns a throw
# into the exit code the setup program reads. No install logic lives here.
$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'install.ps1')
} catch {
    Write-Host $_.Exception.Message
    exit 1
}
exit 0
