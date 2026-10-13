/**
 * Where the recorder listens. Same answer as `recorderPath()` in src/control.ts (data dir from
 * src/config.ts `dataDir`), reimplemented so the host runs as plain Node with no build; a test
 * checks the two agree. `--control <path>` or AUTOTRACK_CONTROL overrides (tests, odd setups).
 */
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { posix, win32 } from "node:path";

/** The recorder's data dir: AUTOTRACK_DIR, else the per-OS default. */
export function dataDir(env = process.env, platform = process.platform, home = homedir()) {
  if (env.AUTOTRACK_DIR) return env.AUTOTRACK_DIR;
  const join = platform === "win32" ? win32.join : posix.join;
  if (platform === "win32")
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "autotrack");
  if (platform === "darwin") return join(home, "Library", "Application Support", "autotrack");
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "autotrack");
}

/** Mac/Linux: `<data>/control.sock`, or a tmpdir path when that is too long for a unix socket. Windows: a named pipe. */
export function recorderPath(env = process.env, platform = process.platform) {
  const data = dataDir(env, platform);
  const tag = createHash("sha256").update(data).digest("hex").slice(0, 12);
  if (platform === "win32") return `\\\\.\\pipe\\autotrack-${tag}`;
  const path = posix.join(data, "control.sock");
  return Buffer.byteLength(path) < 100 ? path : posix.join(tmpdir(), `autotrack-${tag}.sock`);
}

/** The control socket the host relays to. Chrome passes the caller's origin as an argument; ignored. */
export function controlPath(
  argv = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
) {
  const eq = argv.find((a) => a.startsWith("--control="));
  if (eq) return eq.slice("--control=".length);
  const i = argv.indexOf("--control");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (env.AUTOTRACK_CONTROL) return env.AUTOTRACK_CONTROL;
  return recorderPath(env, platform);
}
