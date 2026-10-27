/**
 * Metered networks: on a phone hotspot the recorder keeps recording and holds its uploads until
 * the network is not metered. The Mac's `~/.config/metered/metered.sh status` decides, the same
 * script autobrowse's desk asks (`src/app/metered.ts` there). No script, no hold: every other
 * device ships as before.
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

/** Whether uploads wait now. A missing or failed script never holds. */
export function holdUploads(script = METERED_SCRIPT): Promise<boolean> {
  if (!existsSync(script)) return Promise.resolve(false);
  return new Promise((done) =>
    execFile("/bin/bash", [script, "status"], { timeout: 5_000 }, (err, out) =>
      done(err ? false : holdsFrom(out)),
    ),
  );
}
