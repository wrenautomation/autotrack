/**
 * Metered networks: on a phone hotspot the recorder keeps recording and holds its uploads until
 * the network is not metered. On a Mac, `~/.config/metered/metered.sh status` decides, the same
 * script autobrowse's desk asks (`src/app/metered.ts` there); no script, no hold. On Windows, the
 * connection's own cost decides: Windows marks a phone hotspot metered, and Settings > Network >
 * Wi-Fi > the network > Metered connection sets it by hand.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const METERED_SCRIPT = join(homedir(), ".config/metered/metered.sh");

/** The script's `status` line: `<auto|on|off> <metered|unmetered> <paused|running>`. */
export function holdsFrom(status: string): boolean {
  const [mode, net] = status.trim().split(/\s+/);
  // The second field is the hotspot check alone: the mode comes first.
  return mode === "on" || (mode === "auto" && net === "metered");
}

/** Windows' NetworkCostType of the internet connection, or the word `limit` near or over a cap. */
const WIN_COST = [
  "$p=[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]::GetInternetConnectionProfile()",
  "if(!$p){'none';exit}",
  "$c=$p.GetConnectionCost()",
  "if($c.Roaming -or $c.OverDataLimit -or $c.ApproachingDataLimit){'limit'}else{[string]$c.NetworkCostType}",
].join(";");

/** Fixed and Variable are metered; Unrestricted, Unknown and no connection are not. */
export function winHoldsFrom(cost: string): boolean {
  return ["fixed", "variable", "limit"].includes(cost.trim().toLowerCase());
}

/** Whether uploads wait now. A missing or failed check never holds. */
export function holdUploads(
  script = METERED_SCRIPT,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform === "win32")
    return new Promise((done) =>
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", WIN_COST],
        { timeout: 15_000, windowsHide: true },
        (err, out) => done(err ? false : winHoldsFrom(out)),
      ),
    );
  if (!existsSync(script)) return Promise.resolve(false);
  return new Promise((done) =>
    execFile("/bin/bash", [script, "status"], { timeout: 5_000 }, (err, out) =>
      done(err ? false : holdsFrom(out)),
    ),
  );
}
