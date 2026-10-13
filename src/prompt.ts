/**
 * The task marker's one-line prompt ("What are you doing?"): Mac `osascript display dialog`,
 * Windows a small WinForms box with OK and Cancel. Resolves the answer, "" for an empty OK, or
 * null for Cancel, a closed box, no prompt on this OS, or 10 minutes without an answer.
 */
import { spawn } from "node:child_process";

export const PROMPT_TIMEOUT_MS = 10 * 60_000;

const as = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const ps = (s: string) => s.replace(/'/g, "''");

/** The command that shows the prompt on this OS, or null where there is none. */
export function promptCommand(
  question: string,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } | null {
  if (platform === "darwin") {
    const script = [
      "activate",
      `set r to display dialog "${as(question)}" default answer "" with title "autotrack" buttons {"Cancel", "OK"} default button "OK" cancel button "Cancel" giving up after ${PROMPT_TIMEOUT_MS / 1000}`,
      "if gave up of r then error number -128",
      "return text returned of r",
    ];
    return { cmd: "osascript", args: script.flatMap((l) => ["-e", l]) };
  }
  if (platform === "win32") {
    // A background process may not take the foreground; a tap of Alt lifts that rule for one call.
    const script = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace Autotrack -Name Fg -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'
$f = New-Object System.Windows.Forms.Form
$f.Text = 'autotrack'; $f.TopMost = $true; $f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedDialog'; $f.MinimizeBox = $false; $f.MaximizeBox = $false
$f.ClientSize = New-Object System.Drawing.Size(380, 110)
$l = New-Object System.Windows.Forms.Label; $l.Text = '${ps(question)}'; $l.Location = New-Object System.Drawing.Point(12, 12); $l.AutoSize = $true
$t = New-Object System.Windows.Forms.TextBox; $t.Name = 'goal'; $t.Location = New-Object System.Drawing.Point(12, 36); $t.Width = 356
$ok = New-Object System.Windows.Forms.Button; $ok.Text = 'OK'; $ok.DialogResult = 'OK'; $ok.Location = New-Object System.Drawing.Point(212, 72)
$no = New-Object System.Windows.Forms.Button; $no.Text = 'Cancel'; $no.DialogResult = 'Cancel'; $no.Location = New-Object System.Drawing.Point(293, 72)
$f.AcceptButton = $ok; $f.CancelButton = $no; $f.Controls.AddRange(@($l, $t, $ok, $no))
$f.Add_Shown({ [Autotrack.Fg]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [Autotrack.Fg]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero); [void][Autotrack.Fg]::SetForegroundWindow($f.Handle); $f.Activate(); $t.Focus() })
$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = ${PROMPT_TIMEOUT_MS}; $timer.Add_Tick({ $f.DialogResult = 'Cancel' }); $timer.Start()
if ($f.ShowDialog() -eq 'OK') { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t.Text))); exit 0 }
exit 1
`;
    return {
      cmd: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
    };
  }
  return null;
}

/** The answer from the prompt's exit code and stdout: null unless it exited 0. */
export function promptAnswer(
  code: number | null,
  stdout: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (code !== 0) return null;
  if (platform === "win32") return Buffer.from(stdout.trim(), "base64").toString("utf8");
  return stdout.replace(/\r?\n$/, "");
}

export async function ask(question: string): Promise<string | null> {
  const c = promptCommand(question);
  if (!c) return null;
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const child = spawn(c.cmd, c.args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: false });
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, PROMPT_TIMEOUT_MS + 5000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      out += d;
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(promptAnswer(code, out)));
  });
}
