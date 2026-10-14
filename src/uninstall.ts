/**
 * `autotrack uninstall`: undo what install.sh / install.ps1 did. Autostart off (LaunchAgent, the
 * Scheduled Task and its Run-key fallback, or the systemd user unit and its XDG autostart
 * fallback), the recorder stopped, the browser host
 * unregistered, one last ship, then the app and config removed. Unshipped segments are deleted
 * only after a yes (or `--yes`); a no keeps `sessions/` and nothing else.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { autostartFile, configHome, SERVICE, serviceFile } from "./linux.ts";
import { countSegments, dirBytes, type ShipResult } from "./ship.ts";

export const AGENT_LABEL = "com.wrenautomation.autotrack";
export const TASK_NAME = "autotrack";
export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

export interface UninstallDeps {
  platform: NodeJS.Platform;
  data: string;
  home?: string;
  /** Linux: the XDG config dir; `~/.config` by default. */
  config?: string;
  uid?: number;
  yes: boolean;
  /** Runs a command; resolves with its exit code, never rejects. */
  run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<number>;
  /** Asks a yes/no question; false when nobody can answer. */
  confirm(question: string): Promise<boolean>;
  /** Stops the running recorder, if any, and waits for it. */
  stopRecorder(): Promise<void>;
  /** Removes the native messaging host registration. */
  hostUninstall(): Promise<void>;
  /** One last pass; null when there is no install code. */
  ship(): Promise<ShipResult | null>;
  /** Windows: removes a dir after this process exits (its node.exe is inside). */
  removeLater?(dir: string): void;
  log(msg: string): void;
}

export const agentPlist = (home: string) =>
  join(home, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);

export async function uninstall(d: UninstallDeps): Promise<number> {
  const home = d.home ?? homedir();
  const app = join(d.data, "app");

  // 1. Autostart off first, so nothing starts the recorder again.
  if (d.platform === "darwin") {
    await d.run("launchctl", [
      "bootout",
      `gui/${d.uid ?? process.getuid?.() ?? 501}/${AGENT_LABEL}`,
    ]);
    rmSync(agentPlist(home), { force: true });
    d.log("login item removed");
  } else if (d.platform === "win32") {
    await d.run("schtasks", ["/End", "/TN", TASK_NAME]);
    await d.run("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]);
    await d.run("reg", ["delete", RUN_KEY, "/v", TASK_NAME, "/f"]);
    await d.run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$p=[Environment]::GetEnvironmentVariable('Path','User'); if ($p) { $k=($p -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ne $env:AUTOTRACK_APP.TrimEnd('\\') }) -join ';'; [Environment]::SetEnvironmentVariable('Path',$k,'User') }",
      ],
      { ...process.env, AUTOTRACK_APP: app },
    );
    d.log("scheduled task removed");
  } else if (d.platform === "linux") {
    const config = d.config ?? configHome(home);
    if (existsSync(serviceFile(config))) {
      await d.run("systemctl", ["--user", "disable", "--now", SERVICE]);
      rmSync(serviceFile(config), { force: true });
      await d.run("systemctl", ["--user", "daemon-reload"]);
    }
    rmSync(autostartFile(config), { force: true });
    d.log("autostart removed");
  }

  // 2. Stop it; closing the session closes its last segment.
  await d.stopRecorder();

  // 3. The browser's native host.
  try {
    await d.hostUninstall();
    d.log("browser host unregistered");
  } catch (e) {
    d.log(`browser host: ${(e as Error).message}`);
  }

  // 4. Ship what's left, then ask about what still didn't go.
  const shipped = await d.ship();
  if (shipped?.put) d.log(`shipped ${shipped.put} segment(s)`);
  const sessions = join(d.data, "sessions");
  const left = countSegments(sessions);
  const segs = left.open + left.closed;
  let keep = false;
  if (segs > 0) {
    const mb = (dirBytes(sessions) / 1e6).toFixed(1);
    const del =
      d.yes ||
      (await d.confirm(`${segs} segment(s), ${mb} MB, never shipped. Delete them? [y/N] `));
    keep = !del;
  }

  // 5. Remove the rest.
  if (d.platform !== "win32") {
    const shim = join(home, ".local", "bin", "autotrack"); // written by install.sh
    try {
      if (readFileSync(shim, "utf8").includes(app)) rmSync(shim);
    } catch {}
  }
  if (existsSync(d.data))
    for (const name of readdirSync(d.data)) {
      if (keep && name === "sessions") continue;
      if (name === "app" && d.platform === "win32" && d.removeLater) continue; // node.exe is running
      rmSync(join(d.data, name), { recursive: true, force: true });
    }
  if (d.platform === "win32" && d.removeLater) d.removeLater(keep ? app : d.data);
  else if (!keep) rmSync(d.data, { recursive: true, force: true });
  d.log(
    keep
      ? `removed autotrack; kept ${segs} unshipped segment(s) in ${sessions}`
      : "removed autotrack and its data",
  );
  return 0;
}

/** Windows: rmdir after a short wait, from a detached hidden cmd that outlives this process. */
export function removeLaterWin(dir: string): void {
  if (/["%\r\n]/.test(dir)) return;
  const child = spawn("cmd.exe", ["/d", "/c", `ping -n 4 127.0.0.1 >nul & rmdir /s /q "${dir}"`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  child.unref();
}
