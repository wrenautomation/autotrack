# Probe test window (test.ps1 only): a WinForms window titled "autotrack probe test" with one
# multiline text box filling it. A window the test makes itself, so its UIA tree is the same on
# every Windows (Notepad's differs between the classic and the Windows 11 one). Closes after 120 s.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test-form.ps1
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TestFormDpi {
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    public static void Aware() {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (Exception) { }
        try { SetProcessDPIAware(); } catch (Exception) { }
    }
}
'@
[TestFormDpi]::Aware()
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'autotrack probe test'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(80, 80)
$form.ClientSize = New-Object System.Drawing.Size(640, 400)

$box = New-Object System.Windows.Forms.TextBox
$box.Name = 'notes'
$box.Multiline = $true
$box.Dock = 'Fill'
$form.Controls.Add($box)
$form.Add_Shown({ $form.Activate(); $box.Focus() })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 120000 # never hang CI
$timer.Add_Tick({ $form.Close() })
$timer.Start()
[void]$form.ShowDialog()
