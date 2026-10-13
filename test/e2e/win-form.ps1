# E2E test form (CI only): a WinForms window with a password box (UseSystemPasswordChar, which
# UI Automation reports as IsPassword) and a Submit button. Writes the screen centers of both
# (physical pixels; the process is DPI aware) to the file in $args[0] once shown; on Submit it
# writes "<file>.done" and closes.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File win-form.ps1 C:\temp\form.json
$ErrorActionPreference = 'Stop'
$out = if ($args.Count -gt 0) { $args[0] } else { Join-Path $env:TEMP 'autotrack-form.json' }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FormDpi {
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    public static void Aware() {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (Exception) { }
        try { SetProcessDPIAware(); } catch (Exception) { }
    }
}
'@
[FormDpi]::Aware()
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'autotrack e2e form'
$form.ClientSize = New-Object System.Drawing.Size(420, 160)
# Bottom right, clear of Notepad (which the driver moves to the top left).
$form.StartPosition = 'Manual'
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($area.Right - 480), ($area.Bottom - 240))
$form.TopMost = $true

$label = New-Object System.Windows.Forms.Label
$label.Text = 'Password'
$label.Location = New-Object System.Drawing.Point(20, 20)
$label.AutoSize = $true

$box = New-Object System.Windows.Forms.TextBox
$box.Name = 'password'
$box.UseSystemPasswordChar = $true
$box.Location = New-Object System.Drawing.Point(20, 50)
$box.Size = New-Object System.Drawing.Size(380, 26)

$button = New-Object System.Windows.Forms.Button
$button.Text = 'Submit'
$button.Location = New-Object System.Drawing.Point(150, 100)
$button.Size = New-Object System.Drawing.Size(120, 34)
$button.Add_Click({
    Set-Content -LiteralPath "$out.done" -Value 'submitted'
    $form.Close()
})

$form.Controls.AddRange(@($label, $box, $button))

function Center($c) {
    $p = $c.PointToScreen((New-Object System.Drawing.Point([int]($c.Width / 2), [int]($c.Height / 2))))
    return @{ x = $p.X; y = $p.Y }
}
$form.Add_Shown({
    $form.Activate()
    $json = @{ password = (Center $box); submit = (Center $button); pid = $PID } | ConvertTo-Json -Compress
    Set-Content -LiteralPath "$out.tmp" -Value $json
    Move-Item -LiteralPath "$out.tmp" -Destination $out -Force
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 120000 # never hang CI
$timer.Add_Tick({ $form.Close() })
$timer.Start()
[void]$form.ShowDialog()
