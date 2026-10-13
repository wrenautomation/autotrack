# Windows probe test: starts probe.ps1, opens Notepad, checks perm, front, focused, at on its edit
# control, bad input, and `at` latency over 50 requests. Exits 1 and prints every failure.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File test.ps1   (Windows PowerShell 5.1)
$ErrorActionPreference = 'Stop'
$failures = New-Object System.Collections.ArrayList
function Fail([string]$msg) { [void]$failures.Add($msg); Write-Host "FAIL: $msg" }
function Check([bool]$ok, [string]$msg) { if (-not $ok) { Fail $msg } }

# Same DPI mode as the probe, so UIA rects here are physical pixels like the probe's.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TestNative {
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    public static void Dpi() {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (Exception) { }
        try { SetProcessDPIAware(); } catch (Exception) { }
    }
}
'@
[TestNative]::Dpi()
Add-Type -AssemblyName WindowsBase, UIAutomationClient, UIAutomationTypes, System.Windows.Forms
$UIA = [System.Windows.Automation.AutomationElement]

$probe = Join-Path $PSScriptRoot 'probe.ps1'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'powershell.exe'
$psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$probe`""
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.CreateNoWindow = $true
$p = [System.Diagnostics.Process]::Start($psi)
$notepad = $null
$script:nextId = 1
$all = New-Object System.Text.StringBuilder   # every response, to prove no value leaks

function Send-Line([string]$text) { $p.StandardInput.WriteLine($text); $p.StandardInput.Flush() }

function Ask([hashtable]$req, [int]$timeoutMs = 5000) {
    $id = $script:nextId++
    $req['id'] = $id
    Send-Line ($req | ConvertTo-Json -Compress)
    $task = $p.StandardOutput.ReadLineAsync()
    if (-not $task.Wait($timeoutMs)) { throw "no answer to $($req.op) within $timeoutMs ms" }
    $line = $task.Result
    if ($null -eq $line) { throw "probe closed stdout (exit code $($p.ExitCode))" }
    [void]$all.AppendLine($line)
    $res = $line | ConvertFrom-Json
    if ($res.id -ne $id) { throw "answer id $($res.id) for request $id" }
    return $res
}

function Test-Element($e, [string]$what) {
    if ($null -eq $e) { Fail "$what is null"; return }
    Check ($e.role -is [string] -and $e.role.Length -gt 0) "$what has no role"
    Check ($e.name -is [string]) "$what name is not a string"
    Check ($e.secure -is [bool]) "$what secure is not a bool"
    foreach ($k in 'x', 'y', 'width', 'height') { Check ($null -ne $e.$k -and $e.$k -is [ValueType]) "$what $k is not a number" }
    Check ($null -eq $e.PSObject.Properties['value']) "$what carries a value"
    $allowed = 'role', 'name', 'x', 'y', 'width', 'height', 'secure', 'path', 'id', 'cls', 'url', 'help'
    foreach ($prop in $e.PSObject.Properties) { Check ($allowed -contains $prop.Name) "$what has unexpected field '$($prop.Name)'" }
    foreach ($k in 'id', 'cls', 'url', 'help') {
        if ($null -ne $e.PSObject.Properties[$k]) { Check ($e.$k -is [string] -and $e.$k.Length -gt 0) "$what $k is present but empty or not a string" }
    }
    if ($null -ne $e.PSObject.Properties['path']) {
        $steps = @($e.path)
        Check ($steps.Count -ge 1 -and $steps.Count -le 6) "$what path has $($steps.Count) entries"
        foreach ($a in $steps) {
            Check ($a.role -is [string] -and $a.name -is [string]) "$what path entry lacks role/name"
            Check ($a.role -ne 'window') "$what path runs past the top-level window"
        }
    }
}

function Find-Notepad {
    $cond = New-Object System.Windows.Automation.PropertyCondition ($UIA::ClassNameProperty), 'Notepad'
    $w = $UIA::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
    if ($null -ne $w) { return $w }
    # Packaged Notepad may use another window class: fall back to the title.
    foreach ($c in $UIA::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($c.Current.Name -match 'Notepad$') { return $c }
    }
    return $null
}

try {
    # perm
    $perm = Ask @{ op = 'perm' } 60000    # first answer waits for the helper's compile and UIA load
    Check ($perm.accessibility -eq $true -and $perm.screen -eq $true -and $perm.input -eq $true) 'perm is not all true'

    # bad input must not kill the helper
    Send-Line 'this is not json'
    $u = Ask @{ op = 'nope' }
    Check ($null -ne $u.error) 'unknown op does not answer an error'
    $na = Ask @{ op = 'at' }
    Check ($null -eq $na.element) 'at without coordinates is not null'

    # open Notepad (classic or the Windows 11 one; both use window class Notepad)
    $notepad = Start-Process notepad.exe -PassThru
    $win = $null
    for ($i = 0; $i -lt 60 -and $null -eq $win; $i++) { Start-Sleep -Milliseconds 500; $win = Find-Notepad }
    if ($null -eq $win) { throw 'Notepad window did not appear within 30 s' }

    # front: wait until Notepad is in front, nudging focus
    $front = $null
    for ($i = 0; $i -lt 20; $i++) {
        try { [void][TestNative]::SetForegroundWindow([IntPtr]$win.Current.NativeWindowHandle); $win.SetFocus() } catch { }
        Start-Sleep -Milliseconds 300
        $front = Ask @{ op = 'front' }
        if ($front.app -and $front.app.name -match 'notepad') { break }
    }
    if ($null -eq $front.app) { Fail 'front has no app' }
    else {
        Check ($front.app.name -match 'notepad') "front app is '$($front.app.name)', not Notepad"
        Check ($front.app.id -match 'notepad') "front app id '$($front.app.id)' is not Notepad's exe path"
        Check ($front.app.pid -gt 0) 'front app pid is not positive'
    }
    if ($null -eq $front.window) { Fail 'front has no window' }
    else {
        Check ($front.window.title -is [string] -and $front.window.title -match 'Notepad') "front window title is '$($front.window.title)'"
        Check ($front.window.width -gt 0 -and $front.window.height -gt 0) 'front window has no size'
    }

    # type something, then focused + at on the edit control
    $secret = 'zq-secret-4417'
    [System.Windows.Forms.SendKeys]::SendWait($secret)
    Start-Sleep -Milliseconds 300
    $foc = Ask @{ op = 'focused' }
    Test-Element $foc.element 'focused element'
    if ($foc.element) {
        Check ($foc.element.role -match '^(edit|document)$') "focused role is '$($foc.element.role)', expected edit or document"
        Check ($foc.element.secure -eq $false) 'Notepad edit control reported secure'
    }

    $or = New-Object System.Windows.Automation.OrCondition (
        (New-Object System.Windows.Automation.PropertyCondition ($UIA::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Edit)),
        (New-Object System.Windows.Automation.PropertyCondition ($UIA::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Document)))
    $edit = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $or)
    if ($null -eq $edit) { Fail 'no Edit or Document control found in Notepad' }
    else {
        $r = $edit.Current.BoundingRectangle
        $cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
        $at = Ask @{ op = 'at'; x = $cx; y = $cy }
        Test-Element $at.element "at($cx,$cy)"
        if ($at.element) {
            Check ($at.element.role -match '^(edit|document)$') "at role is '$($at.element.role)', expected edit or document"
            Check ($at.element.secure -eq $false) 'at: Notepad edit control reported secure'
            Check ($at.element.cls -is [string] -and $at.element.cls.Length -gt 0) 'at: Notepad edit control has no cls (UIA ClassName)'
            $e = $at.element
            Check ($cx -ge $e.x -and $cx -le ($e.x + $e.width) -and $cy -ge $e.y -and $cy -le ($e.y + $e.height)) "at($cx,$cy) bounds ($($e.x),$($e.y),$($e.width),$($e.height)) do not contain the point"
        }
    }

    # a point far outside every monitor answers null, not an error
    $far = Ask @{ op = 'at'; x = 900000; y = 900000 }
    Check ($far.PSObject.Properties['element'] -ne $null) 'at off-screen has no element field'

    # latency: 50 `at` requests across Notepad's window
    $ms = New-Object System.Collections.ArrayList
    $w = $front.window
    for ($i = 0; $i -lt 50; $i++) {
        $x = [int]($w.x + 10 + (($i * 37) % [math]::Max(1, $w.width - 20)))
        $y = [int]($w.y + 10 + (($i * 53) % [math]::Max(1, $w.height - 20)))
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        [void](Ask @{ op = 'at'; x = $x; y = $y })
        [void]$ms.Add($sw.Elapsed.TotalMilliseconds)
    }
    $sorted = $ms | Sort-Object
    $p50 = $sorted[24]; $p95 = $sorted[47]; $max = $sorted[49]
    Write-Host ('at latency ms: p50 {0:N1}  p95 {1:N1}  max {2:N1}' -f $p50, $p95, $max)
    if ($p95 -ge 50) { Write-Host 'WARN: p95 is over the 50 ms target (reported, not enforced on shared CI runners)' }
    Check ($p95 -lt 500) "p95 $p95 ms is over the 500 ms sanity bound"

    # the typed text must never come back
    Check (-not $all.ToString().Contains($secret)) 'an answer contained the typed text'
}
catch { Fail $_.Exception.Message }
finally {
    try { $p.StandardInput.Close() } catch { }
    if (-not $p.WaitForExit(5000)) { Fail 'probe did not exit after stdin closed'; $p.Kill() }
    elseif ($p.ExitCode -ne 0) { Fail "probe exit code $($p.ExitCode)" }
    if ($notepad) { Get-Process -Name notepad -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }
}

if ($failures.Count -gt 0) { Write-Host "`n$($failures.Count) failure(s)"; exit 1 }
Write-Host 'ok'
exit 0
