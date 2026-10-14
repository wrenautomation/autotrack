# Windows end to end (CI only: it sends real input). Installs the built bundle with install.ps1 and a
# fake install code pointing at the local S3 stub, types into Notepad and a password form with
# SendInput, waits idle for OCR and prints `doctor` (level and cost), stops, ships, checks what the
# stub received, then uninstalls and checks nothing is left registered. Fails when the cost while
# input was driven is over 6% CPU over 10 s or 200 MB RSS.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\e2e\win.ps1   (after scripts/bundle.mjs)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$work = Join-Path $tempRoot 'autotrack-e2e'
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $work | Out-Null
$data = Join-Path $env:LOCALAPPDATA 'autotrack'
$app = Join-Path $data 'app'
$cli = Join-Path $app 'autotrack.cmd'
$device = 'e2e-win'
$bucket = 'autotrack-e2e'
$keyId = 'AKIAE2ETESTKEY000001'
$secret = 'e2e-secret-not-real-0123456789'
$hostName = 'com.wrenautomation.autotrack'
$hostKeys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
)
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

function Step([string]$m) { Write-Host ''; Write-Host "== $m" }
function Die([string]$m) { Write-Host "::error::e2e: $m"; throw "e2e: $m" }
# Native commands write to stderr; under 'Stop' PowerShell 5.1 would throw on that.
function Native([scriptblock]$b) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $b } finally { $ErrorActionPreference = $saved }
}
function Running { Native { & $cli status *> $null }; return ($LASTEXITCODE -eq 0) }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Drive {
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    public static string FrontTitle() {
        StringBuilder s = new StringBuilder(256);
        GetWindowTextW(GetForegroundWindow(), s, s.Capacity);
        return s.ToString();
    }
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);

    public static void Dpi() {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (Exception) { }
        try { SetProcessDPIAware(); } catch (Exception) { }
    }
    static void Send(INPUT i) {
        if (SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new Exception("SendInput failed: " + Marshal.GetLastWin32Error());
    }
    static INPUT Mouse(int x, int y, uint flags) {
        // Absolute over the virtual desktop, 0..65535.
        int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
        var i = new INPUT { type = 0 };
        i.u.mi.dx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
        i.u.mi.dy = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
        i.u.mi.dwFlags = flags | 0x8000 | 0x4000; // ABSOLUTE | VIRTUALDESK
        return i;
    }
    public static void Click(int x, int y) {
        Send(Mouse(x, y, 0x0001)); // MOVE
        System.Threading.Thread.Sleep(150);
        Send(Mouse(x, y, 0x0002)); // LEFTDOWN
        System.Threading.Thread.Sleep(60);
        Send(Mouse(x, y, 0x0004)); // LEFTUP
    }
    public static void Key(ushort vk) {
        var i = new INPUT { type = 1 };
        i.u.ki.wVk = vk;
        i.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
        Send(i);
        System.Threading.Thread.Sleep(30);
        i.u.ki.dwFlags = 0x0002; // KEYUP
        Send(i);
        System.Threading.Thread.Sleep(60);
    }
    // Lowercase letters and digits: the virtual key is the uppercase ASCII code.
    public static void Type(string s) { foreach (char c in s) Key((ushort)char.ToUpperInvariant(c)); }
}
'@
[Drive]::Dpi()

$bundle = Join-Path $repo 'bundles\autotrack-win32-x64.zip'
if (-not (Test-Path $bundle)) { Die "no bundle at $bundle" }

$stub = $null; $form = $null; $notepad = $null
try {
    Step 'S3 stub'
    $portFile = Join-Path $work 'port'
    $stub = Start-Process -FilePath node -PassThru -NoNewWindow `
        -RedirectStandardOutput (Join-Path $work 'stub.log') -RedirectStandardError (Join-Path $work 'stub.err') `
        -ArgumentList @("`"$repo\test\e2e\s3-stub.mjs`"", '--root', "`"$work\s3`"", '--key-id', $keyId,
            '--secret', $secret, '--prefix', "$device/", '--port-file', "`"$portFile`"")
    for ($i = 0; -not (Test-Path $portFile) -or -not (Get-Content $portFile); $i++) {
        if ($i -gt 50) { Die "stub did not start: $(Get-Content (Join-Path $work 'stub.err') -Raw)" }
        Start-Sleep -Milliseconds 200
    }
    $port = (Get-Content $portFile).Trim()
    # The install code: base64url JSON (what `autobrowse autotrack enroll` prints), here fake.
    $json = [ordered]@{ v = 1; bucket = $bucket; region = 'us-east-1'; device = $device; keyId = $keyId; secret = $secret } | ConvertTo-Json -Compress
    $code = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)).TrimEnd('=').Replace('+', '-').Replace('/', '_')

    Step 'install.ps1'
    # A loaded runner holds the governor in `lean` (no settle, crops or OCR) and the checks below
    # need them, so pin `full` as the Mac e2e does. The user variable reaches the scheduled task;
    # src/level.test.ts covers the governor itself.
    [Environment]::SetEnvironmentVariable('AUTOTRACK_LEVEL', 'full', 'User')
    $env:AUTOTRACK = $code
    $env:AUTOTRACK_BUNDLE = $bundle
    $env:AUTOTRACK_ENDPOINT = "http://127.0.0.1:$port"
    $env:AUTOTRACK_NO_BROWSER = '1'
    & (Join-Path $repo 'install\install.ps1')
    Remove-Item Env:AUTOTRACK, Env:AUTOTRACK_BUNDLE, Env:AUTOTRACK_ENDPOINT, Env:AUTOTRACK_NO_BROWSER
    $task = Get-ScheduledTask -TaskName 'autotrack' -ErrorAction SilentlyContinue
    $run = Get-ItemProperty -Path $runKey -Name 'autotrack' -ErrorAction SilentlyContinue
    if ($task) { Write-Host "scheduled task: $($task.State)" }
    elseif ($run) { Write-Host '::warning::e2e: no scheduled task; the Run key fallback was used' }
    else { Die 'no scheduled task and no Run value' }
    foreach ($k in $hostKeys) { if (-not (Test-Path $k)) { Die "no native host key $k" } }
    $extManifest = Join-Path $data 'extension\manifest.json'
    if (-not (Test-Path $extManifest)) { Die "no unpacked extension at $extManifest" }
    if (-not (Select-String -Path $extManifest -Pattern '"key"' -Quiet)) { Die 'unpacked manifest.json has no key (the extension id would change)' }
    $acl = (Get-Acl (Join-Path $data 'config.json')).Access
    if ($acl.Count -ne 1) {
        $cfgPath = Join-Path $data 'config.json'
        Write-Host "icacls: $((& icacls $cfgPath) -join ' | ')"
        Write-Host "protected: $((Get-Acl $cfgPath).AreAccessRulesProtected); written $((Get-Item $cfgPath).LastWriteTime.ToString('HH:mm:ss.fff')), now $((Get-Date).ToString('HH:mm:ss.fff'))"
        Die "config.json is readable by $($acl.Count) principals: $($acl | ForEach-Object IdentityReference)"
    }
    if (-not (Running)) { Die 'recorder not running after install' }
    Native { & $cli status }
    if (-not ((Native { & $cli status }) -match 'pinned')) { Write-Host '::warning::e2e: AUTOTRACK_LEVEL did not reach the recorder' }

    Step 'Drive input'
    # doctor measures the running recorder over 10 s while the input below is driven: the active cost.
    $doctorLog = Join-Path $work 'doctor-active.log'
    $doctor = Start-Process -FilePath $cli -ArgumentList 'doctor' -PassThru -NoNewWindow `
        -RedirectStandardOutput $doctorLog -RedirectStandardError (Join-Path $work 'doctor-active.err')
    $notepad = Start-Process notepad -PassThru
    $h = [IntPtr]::Zero
    for ($i = 0; $h -eq [IntPtr]::Zero; $i++) {
        if ($i -gt 50) { Die 'Notepad has no window' }
        Start-Sleep -Milliseconds 200
        # The launched process may hand off to another (newer Notepad): take any Notepad window.
        $w = Get-Process -Name notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($w) { $h = $w.MainWindowHandle; $notepad = $w }
    }
    [void][Drive]::MoveWindow($h, 20, 20, 520, 360, $true)
    [void][Drive]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 500
    $r = New-Object Drive+RECT
    [void][Drive]::GetWindowRect($h, [ref]$r)
    [Drive]::Click([int](($r.Left + $r.Right) / 2), [int](($r.Top + $r.Bottom) / 2 + 20))
    Start-Sleep -Milliseconds 800
    [Drive]::Type('hello')
    [Drive]::Key(0x0D) # Enter
    Start-Sleep -Milliseconds 1500
    # A copy while Notepad's text has focus: the recorder writes it as a clipboard event.
    Set-Clipboard -Value 'autotrack e2e clip 42'
    Start-Sleep -Milliseconds 1000

    $formFile = Join-Path $work 'form.json'
    $form = Start-Process powershell -PassThru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', "`"$repo\test\e2e\win-form.ps1`"", "`"$formFile`"")
    for ($i = 0; -not (Test-Path $formFile); $i++) {
        if ($i -gt 100) { Die 'the form did not come up' }
        Start-Sleep -Milliseconds 200
    }
    Start-Sleep -Milliseconds 500
    $f = Get-Content $formFile -Raw | ConvertFrom-Json
    [Drive]::Click([int]$f.password.x, [int]$f.password.y)
    Start-Sleep -Milliseconds 800
    [Drive]::Type('hunter2pw')
    Start-Sleep -Milliseconds 1500
    [Drive]::Click([int]$f.submit.x, [int]$f.submit.y)
    Start-Sleep -Milliseconds 1500
    if (Test-Path "$formFile.done") { Write-Host 'form submitted' } else { Write-Host '::warning::e2e: the form never saw Submit' }
    Start-Sleep -Seconds 2

    Step 'task prompt'
    # Opened through the control socket; the foreground window must be the prompt, then the answer
    # is typed into it.
    Native { & $cli task }
    if ($LASTEXITCODE -ne 0) { Die "autotrack task exited $LASTEXITCODE" }
    $front = ''
    for ($i = 0; $front -ne 'autotrack'; $i++) {
        if ($i -gt 30) { Die "the task prompt is not in front after 15 s: '$front'" }
        Start-Sleep -Milliseconds 500
        $front = [Drive]::FrontTitle()
    }
    Write-Host "front: $front"
    Start-Sleep -Milliseconds 300
    [Drive]::Type('e2e task')
    [Drive]::Key(0x0D) # Enter
    Start-Sleep -Seconds 2

    Step 'idle: OCR, doctor'
    # OCR runs only after 20 s without input, one image at a time; poll for a read that found text.
    $sessionsDir = Join-Path $data 'sessions'
    for ($i = 0; $true; $i++) {
        $hit = Get-ChildItem -Path $sessionsDir -Recurse -Filter '*.json' -ErrorAction SilentlyContinue |
            Where-Object { $_.Directory.Name -eq 'ocr' } |
            Where-Object { (Get-Content $_.FullName -Raw) -match '"text":"[^"]*(hello|Submit|Password|Notepad)' } | Select-Object -First 1
        if ($hit) { Write-Host "ocr: known text in $($hit.FullName)"; break }
        if ($i -ge 60) { Write-Host '::warning::e2e: no OCR with the known text after 180 s'; break }
        Start-Sleep -Seconds 3
    }
    if ($doctor) { [void]$doctor.WaitForExit(60000) }
    Write-Host '-- doctor while input was driven:'
    Get-Content $doctorLog -ErrorAction SilentlyContinue
    # The active budget: CI fails past 6% over the 10 s burst (driven input is denser than real use;
    # the real-use target stays 3% on average) or 200 MB peak RSS. Checked after the rest.
    $activeLog = Get-Content $doctorLog -Raw -ErrorAction SilentlyContinue
    $cpu = if ($activeLog -match 'CPU ([0-9.]+)% of one core') { [double]$Matches[1] } else { $null }
    $rss = if ($activeLog -match 'RSS (\d+) MB peak') { [int]$Matches[1] } else { $null }
    $inputs = if ($activeLog -match 'active, (\d+) inputs') { [int]$Matches[1] } else { 0 }
    Write-Host "::notice::e2e windows active input: CPU $cpu% over 10 s, RSS $rss MB peak, $inputs inputs (CI limits 6%, 200 MB)"
    $overBudget = @()
    if ($null -eq $cpu -or $null -eq $rss) { $overBudget += 'doctor did not report CPU and RSS while input was driven' }
    else {
        if ($rss -gt 200) { $overBudget += "active RSS $rss MB is over 200 MB" }
        if ($cpu -gt 6) { $overBudget += "10 s burst CPU $cpu% is over 6%" }
    }
    if ($inputs -eq 0) { Write-Host '::warning::e2e: doctor saw no input in its window' }
    Write-Host '-- doctor idle:'
    Native { & $cli doctor }
    # 256 points at the primary display's native pixels, from the installed shots helper.
    $disp = Native { '{"id":1,"op":"displays"}' | & (Join-Path $app 'helpers\win\autotrack-helper.exe') --shots } | ConvertFrom-Json
    $primary = @($disp.displays | Where-Object { $_.primary })[0]
    $cropPx = [math]::Round(256 * $primary.os.scale)
    Write-Host "crop at native pixels: $cropPx px"

    Step 'stop, ship'
    Native { & $cli stop }
    for ($i = 0; Running; $i++) {
        if ($i -gt 30) { Die 'recorder did not stop' }
        Start-Sleep -Seconds 1
    }
    Native { & $cli ship }
    if ($LASTEXITCODE -ne 0) { Die "ship exited $LASTEXITCODE" }
    Get-Content (Join-Path $work 'stub.log')

    Step 'check'
    Native { & node (Join-Path $repo 'test\e2e\check.mjs') --dir (Join-Path $work "s3\$bucket\$device") --crop-px $cropPx }
    if ($LASTEXITCODE -ne 0) { Die 'e2e checks failed' }

    Step 'uninstall --yes'
    Copy-Item (Join-Path $data '*.log') $work -ErrorAction SilentlyContinue
    Native { & $cli uninstall --yes }
    if ($LASTEXITCODE -ne 0) { Die "uninstall exited $LASTEXITCODE" }
    if (Get-ScheduledTask -TaskName 'autotrack' -ErrorAction SilentlyContinue) { Die 'scheduled task still registered' }
    if (Get-ItemProperty -Path $runKey -Name 'autotrack' -ErrorAction SilentlyContinue) { Die 'Run value still there' }
    foreach ($k in $hostKeys) { if (Test-Path $k) { Die "native host key still there: $k" } }
    for ($i = 0; Test-Path $extManifest; $i++) { # removed with the rest of the data dir
        if ($i -gt 30) { Die "unpacked extension still at $extManifest" }
        Start-Sleep -Seconds 1
    }
    if (([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') -contains $app) { Die 'app still on the user PATH' }
    for ($i = 0; Test-Path $app; $i++) { # removed by a detached cmd once node has exited
        if ($i -gt 30) { Die "app still in $app" }
        Start-Sleep -Seconds 1
    }
    Write-Host 'uninstall left nothing registered'
    if ($overBudget.Count -gt 0) { Die ($overBudget -join '; ') }
} finally {
    [Environment]::SetEnvironmentVariable('AUTOTRACK_LEVEL', $null, 'User')
    Copy-Item (Join-Path $data '*.log') $work -ErrorAction SilentlyContinue
    foreach ($p in @($stub, $form, $notepad)) { if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }
}
