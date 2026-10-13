# Windows probe test: starts probe.ps1, opens its own text box window (test-form.ps1), checks perm,
# front, focused, at on the text box, bad input, and `at` latency over 50 requests. Then starts `probe.ps1 --shots` and checks
# displays, grab, save (JPEG, at most 1920 px), the ring and timing. Exits 1 and prints every failure.
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
$testForm = $null
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

$formTitle = 'autotrack probe test'
function Find-TestForm {
    $cond = New-Object System.Windows.Automation.PropertyCondition ($UIA::NameProperty), $formTitle
    return $UIA::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
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

    # the test's own text box window, in a process of its own (UIA into this process would wait on itself)
    $secret = 'zq-secret-4417'
    $testForm = Start-Process powershell.exe -PassThru -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'test-form.ps1'), $secret
    $win = $null
    for ($i = 0; $i -lt 60 -and $null -eq $win; $i++) { Start-Sleep -Milliseconds 500; $win = Find-TestForm }
    if ($null -eq $win) { throw 'test form window did not appear within 30 s' }

    # front: wait until the form is in front, nudging focus
    $front = $null
    for ($i = 0; $i -lt 20; $i++) {
        try { [void][TestNative]::SetForegroundWindow([IntPtr]$win.Current.NativeWindowHandle); $win.SetFocus() } catch { }
        Start-Sleep -Milliseconds 300
        $front = Ask @{ op = 'front' }
        if ($front.window -and $front.window.title -eq $formTitle) { break }
    }
    if ($null -eq $front.app) { Fail 'front has no app' }
    else {
        Check ($front.app.name -match 'powershell') "front app is '$($front.app.name)', not the test form's powershell"
        Check ($front.app.id -match 'powershell\.exe$') "front app id '$($front.app.id)' is not powershell's exe path"
        Check ($front.app.pid -eq $testForm.Id) "front app pid $($front.app.pid) is not the test form's ($($testForm.Id))"
    }
    if ($null -eq $front.window) { Fail 'front has no window' }
    else {
        Check ($front.window.title -eq $formTitle) "front window title is '$($front.window.title)'"
        Check ($front.window.width -gt 0 -and $front.window.height -gt 0) 'front window has no size'
    }

    # type something, then focused + at on the text box (an Edit, a Document when multiline, or a
    # Pane when UIA reaches WinForms through the Win32 proxy)
    [System.Windows.Forms.SendKeys]::SendWait($secret)
    Start-Sleep -Milliseconds 300
    $foc = Ask @{ op = 'focused' }
    Test-Element $foc.element 'focused element'
    if ($foc.element) {
        Check ($foc.element.role -match '^(edit|document|pane)$') "focused role is '$($foc.element.role)', expected edit, document or pane"
        Check ($foc.element.secure -eq $false) 'the text box reported secure'
    }

    # WinForms text boxes reach UIA through the Win32 proxy as Panes with numeric ids on some
    # runners, so they are found by their window class (WindowsForms10.EDIT…) and told apart by
    # height: the multiline notes box is tall, the titled box one line.
    $desc = @($win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition))
    $boxes = @($desc | Where-Object { $_.Current.ClassName -match '(?i)edit' } | Sort-Object { $_.Current.BoundingRectangle.Height })
    $roles = ($boxes | ForEach-Object { '{0} {1} {2}px' -f $_.Current.ControlType.ProgrammaticName, $_.Current.ClassName, [int]$_.Current.BoundingRectangle.Height }) -join ', '
    Write-Host "text boxes in the form: $roles"
    if ($boxes.Count -lt 2) {
        Write-Host ("form descendants: " + (($desc | ForEach-Object { '{0} {1} id={2}' -f $_.Current.ControlType.ProgrammaticName, $_.Current.ClassName, $_.Current.AutomationId }) -join '; '))
        $tops = $UIA::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
        Write-Host ("top-level windows: " + (($tops | ForEach-Object { '"{0}" pid {1}' -f $_.Current.Name, $_.Current.ProcessId }) -join '; '))
    }
    $edit = $null; $titled = $null
    if ($boxes.Count -ge 2) { $titled = $boxes[0]; $edit = $boxes[$boxes.Count - 1] }
    if ($null -eq $edit) { Fail "expected two text boxes in the test form, found: $roles" }
    else {
        $r = $edit.Current.BoundingRectangle
        $cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
        $at = Ask @{ op = 'at'; x = $cx; y = $cy }
        Test-Element $at.element "at($cx,$cy)"
        if ($at.element) {
            Check ($at.element.role -match '^(edit|document|pane)$') "at role is '$($at.element.role)', expected edit, document or pane"
            Check ($at.element.secure -eq $false) 'at: the text box reported secure'
            Check ($at.element.cls -is [string] -and $at.element.cls.Length -gt 0) 'at: the text box has no cls (UIA ClassName)'
            $e = $at.element
            Check ($cx -ge $e.x -and $cx -le ($e.x + $e.width) -and $cy -ge $e.y -and $cy -le ($e.y + $e.height)) "at($cx,$cy) bounds ($($e.x),$($e.y),$($e.width),$($e.height)) do not contain the point"
        }
    }

    # a box whose accessible name is its own text: the name must not come back
    if ($null -ne $titled) {
        $r = $titled.Current.BoundingRectangle
        $tx = [int]($r.X + $r.Width / 2); $ty = [int]($r.Y + $r.Height / 2)
        $ta = Ask @{ op = 'at'; x = $tx; y = $ty }
        Test-Element $ta.element "at($tx,$ty) on the titled box"
        if ($ta.element) { Check ($ta.element.name -eq '') "the titled box's name is '$($ta.element.name)', expected ''" }
    }

    # a point far outside every monitor answers null, not an error
    $far = Ask @{ op = 'at'; x = 900000; y = 900000 }
    Check ($far.PSObject.Properties['element'] -ne $null) 'at off-screen has no element field'

    # latency: 50 `at` requests across the form's window
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
    if ($testForm -and -not $testForm.HasExited) { Stop-Process -Id $testForm.Id -Force -ErrorAction SilentlyContinue }
}

# ---- shots mode: displays, grab, save, ring, bad input (`probe.ps1 --shots`) ----
$sp = $null
try {
    Add-Type -AssemblyName System.Drawing
    $psi2 = New-Object System.Diagnostics.ProcessStartInfo
    $psi2.FileName = 'powershell.exe'
    $psi2.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$probe`" --shots"
    $psi2.UseShellExecute = $false
    $psi2.RedirectStandardInput = $true
    $psi2.RedirectStandardOutput = $true
    $psi2.CreateNoWindow = $true
    $sp = [System.Diagnostics.Process]::Start($psi2)
    $script:shotId = 1
    function Ask-Shots([hashtable]$req, [int]$timeoutMs = 30000) {
        $id = $script:shotId++
        $req['id'] = $id
        $sp.StandardInput.WriteLine(($req | ConvertTo-Json -Compress)); $sp.StandardInput.Flush()
        $task = $sp.StandardOutput.ReadLineAsync()
        if (-not $task.Wait($timeoutMs)) { throw "no answer to shots $($req.op) within $timeoutMs ms" }
        if ($null -eq $task.Result) { throw "shots helper closed stdout (exit code $($sp.ExitCode))" }
        $res = $task.Result | ConvertFrom-Json
        if ($res.id -ne $id) { throw "shots answer id $($res.id) for request $id" }
        return $res
    }
    function Test-Jpeg([string]$path, [string]$what) {
        Check (Test-Path $path) "${what}: file missing"
        if (-not (Test-Path $path)) { return }
        Check (-not (Test-Path "$path.tmp")) "${what}: .tmp left behind"
        $head = [System.IO.File]::ReadAllBytes($path)
        Check ($head.Length -gt 1000 -and $head[0] -eq 0xFF -and $head[1] -eq 0xD8) "${what}: not a JPEG (FFD8)"
        $img = [System.Drawing.Image]::FromFile($path)
        try { Check ([math]::Max($img.Width, $img.Height) -le 1920) "${what}: $($img.Width)x$($img.Height) is over 1920 on the long side" }
        finally { $img.Dispose() }
    }

    $disp = Ask-Shots @{ op = 'displays' } 60000   # the first answer waits for the C# compile
    $list = @($disp.displays)
    Check ($list.Count -ge 1) 'displays: none'
    foreach ($d in $list) {
        Check ($d.id -is [string] -and $d.primary -is [bool]) "display $($d.id) shape"
        foreach ($k in 'x', 'y', 'width', 'height', 'scale') { Check ($null -ne $d.$k -and $d.$k -isnot [string] -and $d.$k -isnot [bool]) "display $($d.id) $k is not a number" }
        Check ($d.width -gt 0 -and $d.scale -gt 0) "display $($d.id) width or scale"
        Check ($null -ne $d.os -and $d.os.width -gt 0 -and $d.os.scale -gt 0) "display $($d.id) os rect"
        if ($d.os) { Check ([math]::Abs($d.os.width / $d.os.scale - $d.width) -lt 0.05) "display $($d.id): width is not os.width / os.scale" }
    }
    Check (@($list | Where-Object { $_.primary }).Count -eq 1) 'displays: exactly one primary'
    $main = @($list | Where-Object { $_.primary })[0]
    Write-Host ('displays: ' + (($list | ConvertTo-Json -Compress -Depth 4)))

    $bad = Ask-Shots @{ op = 'grab'; display = '999999' }
    Check ($bad.error -is [string]) 'grab of an unknown display must answer an error'
    $empty = Ask-Shots @{ op = 'save'; slot = 0; path = (Join-Path $env:TEMP 'autotrack-empty.jpg') }
    Check ($empty.ok -eq $false -and $empty.error -is [string]) 'save of an empty slot must fail cleanly'
    $unknown = Ask-Shots @{ op = 'nope' }
    Check ($unknown.error -is [string]) 'unknown shots op must answer an error'

    $g = Ask-Shots @{ op = 'grab'; display = $main.id }
    Check (-not $g.error) "grab: $($g.error)"
    Check ($g.slot -ge 0 -and $g.slot -lt 4) 'grab: slot is not 0..3'
    Check ([math]::Max($g.w, $g.h) -le 1920) "grab: $($g.w)x$($g.h) is over 1920"
    Check ($g.hash -match '^[0-9a-f]{16}$') "grab: hash '$($g.hash)' is not 16 hex digits"
    Check ([math]::Abs($main.scale - $g.w / $main.width) -lt 0.01) 'displays scale is not frame pixels per point'

    $out = Join-Path $env:TEMP ("autotrack-shot-{0}.jpg" -f $PID)
    $s = Ask-Shots @{ op = 'save'; slot = $g.slot; seq = $g.seq; path = $out; quality = 70 }
    Check ($s.ok -eq $true -and $s.bytes -gt 1000) "save: $($s | ConvertTo-Json -Compress)"
    Test-Jpeg $out 'save'
    if ($s.ok) { Check ((Get-Item $out).Length -eq $s.bytes) 'save: bytes do not match the file' }
    $low = Join-Path $env:TEMP ("autotrack-shot-{0}-q30.jpg" -f $PID)
    $sq = Ask-Shots @{ op = 'save'; slot = $g.slot; seq = $g.seq; path = $low; quality = 30 }
    Check ($sq.ok -eq $true -and $sq.bytes -lt $s.bytes) 'a lower quality must save fewer bytes'
    $nodir = Ask-Shots @{ op = 'save'; slot = $g.slot; seq = $g.seq; path = (Join-Path $env:TEMP 'no\such\dir\x.jpg') }
    Check ($nodir.ok -eq $false -and $nodir.error -is [string]) 'save into a missing directory must fail cleanly'

    # ring: the 5th grab reuses the first slot, so a save of the old seq is refused
    $grabs = @($g)
    for ($i = 0; $i -lt 4; $i++) { $grabs += Ask-Shots @{ op = 'grab'; display = $main.id } }
    Check (@($grabs[1..3] | ForEach-Object { $_.slot } | Select-Object -Unique).Count -eq 3) 'consecutive grabs must use distinct slots'
    $stale = Ask-Shots @{ op = 'save'; slot = $g.slot; seq = $g.seq; path = (Join-Path $env:TEMP 'autotrack-stale.jpg') }
    Check ($stale.ok -eq $false) 'save of a slot reused by a newer grab must be refused'
    Check (-not (Test-Path (Join-Path $env:TEMP 'autotrack-stale.jpg'))) 'a refused save must write nothing'

    # timing
    $gm = New-Object System.Collections.ArrayList
    $sm = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt 20; $i++) {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $t = Ask-Shots @{ op = 'grab'; display = $main.id }
        [void]$gm.Add($sw.Elapsed.TotalMilliseconds)
        $sw.Restart()
        [void](Ask-Shots @{ op = 'save'; slot = $t.slot; seq = $t.seq; path = $out; quality = 70 })
        [void]$sm.Add($sw.Elapsed.TotalMilliseconds)
    }
    $gs = $gm | Sort-Object; $ss = $sm | Sort-Object
    Write-Host ('grab ms: p50 {0:N1}  p95 {1:N1}   save ms: p50 {2:N1}  p95 {3:N1}' -f $gs[9], $gs[18], $ss[9], $ss[18])
    Check ($gs[18] -lt 2000) 'grab p95 is over the 2 s sanity bound'
    Remove-Item $out, $low -Force -ErrorAction SilentlyContinue
}
catch { Fail $_.Exception.Message }
finally {
    if ($sp) {
        try { $sp.StandardInput.Close() } catch { }
        if (-not $sp.WaitForExit(5000)) { Fail 'shots helper did not exit after stdin closed'; $sp.Kill() }
        elseif ($sp.ExitCode -ne 0) { Fail "shots helper exit code $($sp.ExitCode)" }
    }
}

if ($failures.Count -gt 0) { Write-Host "`n$($failures.Count) failure(s)"; exit 1 }
Write-Host 'ok'
exit 0
