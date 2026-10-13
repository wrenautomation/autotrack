# wren-track probe (Windows): long-lived helper. One JSON request per line on stdin, one answer per
# line on stdout. Ops: at, front, focused, perm. See designs/2026-10-13-track.md "Probe protocol".
# Windows PowerShell 5.1 syntax only. Run: powershell -NoProfile -ExecutionPolicy Bypass -File probe.ps1
#
# COORDINATE SPACE: physical screen pixels on the virtual desktop (primary monitor's top-left is 0,0;
# other monitors can be negative). Requests and answers use it. This matches uiohook-napi on Windows:
# libuiohook passes MSLLHOOKSTRUCT.pt straight through, and Microsoft documents that field as
# "per-monitor-aware screen coordinates", i.e. physical pixels whatever the hooking process's DPI
# awareness. This process makes itself per-monitor DPI aware (v2) first, so UIA and window rects are
# physical too. No scaling happens here; the recorder converts to logical points with displays[].scale.
#
# Elements carry path (ancestors up to the window), id (AutomationId), cls (ClassName), help; each
# omitted when empty. Chromium turns its UIA tree on by itself when a UIA client asks (see README).
# Never returns an element's value. Per-request errors answer null; the loop never dies.
# UIA has no per-call timeout, so a hung app can stall one request; the caller times out to null.

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WrenNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int awareness);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder s, ref uint size);

    // Newest API first; each older one exists on older Windows. Returns which one took.
    public static string EnableDpiAwareness() {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per-monitor-v2"; } catch (Exception) { }
        try { if (SetProcessDpiAwareness(2) == 0) return "per-monitor"; } catch (Exception) { }
        try { if (SetProcessDPIAware()) return "system"; } catch (Exception) { }
        return "none";
    }

    public static IntPtr Foreground() { return GetForegroundWindow(); }

    public static string Title(IntPtr h) {
        int n = GetWindowTextLengthW(h);
        StringBuilder sb = new StringBuilder(n + 1);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    // Visible bounds [x, y, width, height]. DWM's extended frame skips the invisible resize border
    // that GetWindowRect includes on Windows 10 and 11. Null when the window has no rect.
    public static int[] Bounds(IntPtr h) {
        RECT r;
        if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0 && !GetWindowRect(h, out r)) return null;
        return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
    }

    public static uint Pid(IntPtr h) {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        return pid;
    }

    // Full exe path, or "" when the process is protected or gone.
    public static string ImagePath(uint pid) {
        IntPtr p = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (p == IntPtr.Zero) return "";
        try {
            StringBuilder sb = new StringBuilder(1024);
            uint size = (uint)sb.Capacity;
            return QueryFullProcessImageNameW(p, 0, sb, ref size) ? sb.ToString() : "";
        } finally { CloseHandle(p); }
    }
}
'@

# Before UIA loads, so its coordinates come back physical.
[void][WrenNative]::EnableDpiAwareness()
Add-Type -AssemblyName WindowsBase, UIAutomationClient, UIAutomationTypes

function ConvertTo-Rounded([double]$v) {
    if ([double]::IsNaN($v) -or [double]::IsInfinity($v)) { return 0 }
    return [int][math]::Round($v)
}

# One cross-process call per element: every property we read is fetched into the cache together.
$script:cache = New-Object System.Windows.Automation.CacheRequest
foreach ($prop in @(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.AutomationElement]::BoundingRectangleProperty,
        [System.Windows.Automation.AutomationElement]::IsPasswordProperty,
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        [System.Windows.Automation.AutomationElement]::HelpTextProperty)) { $script:cache.Add($prop) }
$script:walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$script:windowTypeId = [System.Windows.Automation.ControlType]::Window.Id
$maxAncestors = 6
$walkBudgetMs = 30   # ancestor walking stops past this so a slow app can't blow the 50 ms answer

function Get-RoleName($controlType) {
    return ($controlType.ProgrammaticName -replace '^ControlType\.', '').ToLowerInvariant()
}

# Ancestors nearest first, stopping before the top-level window (that is `front.window`).
function Get-Path($el, $clock) {
    $path = New-Object System.Collections.ArrayList
    $cur = $el
    while ($path.Count -lt $maxAncestors -and $clock.ElapsedMilliseconds -lt $walkBudgetMs) {
        $parent = $script:walker.GetParent($cur, $script:cache)
        if ($null -eq $parent) { break }
        $c = $parent.Cached
        if ($c.ControlType.Id -eq $script:windowTypeId) { break }
        if ([System.Windows.Automation.Automation]::Compare($parent, [System.Windows.Automation.AutomationElement]::RootElement)) { break }
        [void]$path.Add([ordered]@{ role = (Get-RoleName $c.ControlType); name = [string]$c.Name })
        $cur = $parent
    }
    return , $path.ToArray()
}

function Get-ElementJson($raw) {
    if ($null -eq $raw) { return $null }
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $el = $raw.GetUpdatedCache($script:cache)
    $c = $el.Cached
    $b = $c.BoundingRectangle
    $name = $c.Name
    if ($null -eq $name) { $name = '' }
    $out = [ordered]@{
        role   = (Get-RoleName $c.ControlType)
        name   = [string]$name
        x      = ConvertTo-Rounded $b.X
        y      = ConvertTo-Rounded $b.Y
        width  = ConvertTo-Rounded $b.Width
        height = ConvertTo-Rounded $b.Height
        secure = [bool]$c.IsPassword
    }
    $path = Get-Path $el $clock
    if ($path.Count -gt 0) { $out['path'] = $path }
    # Each omitted when empty. No Mac-style url on Windows (UIA has no link target property).
    if ($c.AutomationId) { $out['id'] = [string]$c.AutomationId }
    if ($c.ClassName) { $out['cls'] = [string]$c.ClassName }
    if ($c.HelpText) { $out['help'] = [string]$c.HelpText }
    return $out
}

function Get-FrontJson {
    $h = [WrenNative]::Foreground()
    if ($h -eq [IntPtr]::Zero) { return @{ app = $null; window = $null } }
    $procId = [WrenNative]::Pid($h)
    $path = [WrenNative]::ImagePath($procId)
    if ($path) {
        $name = [System.IO.Path]::GetFileNameWithoutExtension($path)
    } else {
        $name = [System.Diagnostics.Process]::GetProcessById([int]$procId).ProcessName
    }
    $app = [ordered]@{ name = [string]$name; id = [string]$path; pid = [int]$procId }
    $window = $null
    $b = [WrenNative]::Bounds($h)
    if ($null -ne $b) {
        $window = [ordered]@{ title = [WrenNative]::Title($h); x = $b[0]; y = $b[1]; width = $b[2]; height = $b[3] }
    }
    return @{ app = $app; window = $window }
}

function Invoke-Op($req) {
    $res = [ordered]@{ id = $req.id }
    $op = [string]$req.op
    try {
        switch ($op) {
            'at' {
                $res['element'] = $null
                if ($null -ne $req.x -and $null -ne $req.y) {
                    $pt = New-Object System.Windows.Point -ArgumentList ([double]$req.x), ([double]$req.y)
                    $res['element'] = Get-ElementJson ([System.Windows.Automation.AutomationElement]::FromPoint($pt))
                }
            }
            'focused' {
                $res['element'] = Get-ElementJson ([System.Windows.Automation.AutomationElement]::FocusedElement)
            }
            'front' {
                $f = Get-FrontJson
                $res['app'] = $f.app
                $res['window'] = $f.window
            }
            'perm' {
                $res['accessibility'] = $true; $res['screen'] = $true; $res['input'] = $true
            }
            default { $res['error'] = 'unknown op' }
        }
    } catch {
        # Whatever half-built, answer null for the op's fields.
        switch ($op) {
            'front' { $res['app'] = $null; $res['window'] = $null }
            'perm'  { $res['accessibility'] = $true; $res['screen'] = $true; $res['input'] = $true }
            default { $res['element'] = $null }
        }
    }
    return $res
}

# Escape everything above ASCII so the line is the same bytes under any console code page.
$escape = [System.Text.RegularExpressions.MatchEvaluator]{ param($m) '\u{0:x4}' -f [int][char]$m.Value }

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    try {
        $req = $line | ConvertFrom-Json
        $json = (Invoke-Op $req) | ConvertTo-Json -Compress -Depth 4
        $json = [System.Text.RegularExpressions.Regex]::Replace($json, '[^\x00-\x7F]', $escape)
        [Console]::Out.WriteLine($json)
        [Console]::Out.Flush()
    } catch {
        # Unparseable line: no id to answer to, so say nothing.
    }
}
