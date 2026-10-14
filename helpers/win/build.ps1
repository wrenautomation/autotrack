# Builds helpers\win\autotrack-helper.exe from the *.cs files here with the C# compiler that ships
# in .NET Framework 4.8 (every Windows 10 and 11 has it), so the exe needs nothing installed.
# WinRT (OCR) comes from the .winmd files in System32\WinMetadata.
#   powershell -NoProfile -ExecutionPolicy Bypass -File helpers\win\build.ps1
$ErrorActionPreference = 'Stop'
$fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $fw 'csc.exe'
if (-not (Test-Path $csc)) { throw "no C# compiler at $csc (.NET Framework 4.8 missing?)" }
$out = Join-Path $PSScriptRoot 'autotrack-helper.exe'
$sources = Get-ChildItem -Path $PSScriptRoot -Filter '*.cs' | ForEach-Object { $_.FullName }

# WinRT facades: the framework folder has the runtime ones; the reference set (Visual Studio,
# the targeting pack) is used when present.
$facades = Join-Path ${env:ProgramFiles(x86)} 'Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8\Facades'
$refs = @(
    'System.dll', 'System.Core.dll', 'System.Drawing.dll',
    (Join-Path $fw 'WPF\WindowsBase.dll'),
    (Join-Path $fw 'WPF\UIAutomationClient.dll'),
    (Join-Path $fw 'WPF\UIAutomationTypes.dll'),
    (Join-Path $fw 'System.Runtime.WindowsRuntime.dll')
)
foreach ($f in 'System.Runtime.dll', 'System.Threading.Tasks.dll', 'System.Runtime.InteropServices.WindowsRuntime.dll') {
    $p = Join-Path $facades $f
    if (-not (Test-Path $p)) { $p = Join-Path $fw $f }
    if (Test-Path $p) { $refs += $p }
}
$winmd = Join-Path $env:WINDIR 'System32\WinMetadata'
foreach ($m in 'Windows.Foundation', 'Windows.Globalization', 'Windows.Graphics', 'Windows.Media', 'Windows.Storage') {
    $refs += (Join-Path $winmd "$m.winmd")
}

$cscArgs = @('/nologo', '/target:exe', '/platform:anycpu', '/optimize+', '/debug-', '/langversion:5',
    "/out:$out") + ($refs | ForEach-Object { "/reference:$_" }) + $sources
& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "csc exited $LASTEXITCODE" }
Write-Host "built $out ($([math]::Round((Get-Item $out).Length / 1KB)) KB)"
