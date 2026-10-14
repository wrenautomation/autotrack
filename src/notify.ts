/** OS notifications ("Tracking paused", "Tracking on"). Fire and forget: never blocks, never throws. */
import { spawn } from "node:child_process";
import { onPath } from "./linux.ts";

const ps = (s: string) => s.replace(/'/g, "''");
const as = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** The command that shows a notification on this OS, or null where there is none. */
export function notifyCommand(
  title: string,
  body: string,
  platform: NodeJS.Platform = process.platform,
  has: (cmd: string) => boolean = (c) => !!onPath(c),
): { cmd: string; args: string[] } | null {
  if (platform === "darwin")
    return {
      cmd: "osascript",
      args: ["-e", `display notification "${as(body)}" with title "${as(title)}"`],
    };
  if (platform === "win32") {
    // A toast under Windows PowerShell's own app id: works for any user, no registration.
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
      "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      `$t = $x.GetElementsByTagName('text'); $t.Item(0).AppendChild($x.CreateTextNode('${ps(title)}')) > $null; $t.Item(1).AppendChild($x.CreateTextNode('${ps(body)}')) > $null`,
      "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))",
    ].join("; ");
    return {
      cmd: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    };
  }
  if (platform === "linux") {
    // notify-send (libnotify-bin), else the same D-Bus call through gdbus (glib, on every GNOME
    // and most others). Arguments go as argv, so nothing needs quoting.
    if (has("notify-send")) return { cmd: "notify-send", args: ["-a", "autotrack", title, body] };
    if (has("gdbus"))
      return {
        cmd: "gdbus",
        args: [
          "call",
          "--session",
          "--dest=org.freedesktop.Notifications",
          "--object-path=/org/freedesktop/Notifications",
          "--method=org.freedesktop.Notifications.Notify",
          "autotrack",
          "0",
          "",
          gvariantString(title),
          gvariantString(body),
          "[]",
          "{}",
          "5000",
        ],
      };
  }
  return null;
}

/** A GVariant string literal for gdbus. */
export const gvariantString = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export function notify(body: string, title = "autotrack"): void {
  const c = notifyCommand(title, body);
  if (!c) return;
  try {
    const child = spawn(c.cmd, c.args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No notification is not worth stopping for.
  }
}
