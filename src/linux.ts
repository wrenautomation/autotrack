/**
 * Linux readings the CLI and recorder need: which tools are on PATH, the session type (X11 is
 * first-class, Wayland runs degraded), the distro name, power from `/sys/class/power_supply`.
 */
import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Power } from "./level.ts";

/** The full path of an executable on PATH, or null. */
export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

/** `$XDG_CONFIG_HOME`, else `~/.config`. */
export const configHome = (home = homedir(), env: NodeJS.ProcessEnv = process.env) =>
  env.XDG_CONFIG_HOME?.startsWith("/") ? env.XDG_CONFIG_HOME : join(home, ".config");

/** The systemd user unit install.sh writes. */
export const SERVICE = "autotrack.service";
export const serviceFile = (config: string) => join(config, "systemd", "user", SERVICE);
/** The XDG autostart fallback (no systemd user session). */
export const autostartFile = (config: string) => join(config, "autostart", "autotrack.desktop");

/** `x11`, `wayland`, `tty` or "" (unknown). */
export function sessionType(env: NodeJS.ProcessEnv = process.env): string {
  const t = env.XDG_SESSION_TYPE ?? "";
  if (t && t !== "unspecified") return t;
  if (env.WAYLAND_DISPLAY) return "wayland";
  if (env.DISPLAY) return "x11";
  return "";
}

/** Wayland: input and screen only reach autotrack from XWayland apps. */
export const isWayland = (env: NodeJS.ProcessEnv = process.env) =>
  sessionType(env) === "wayland" || !!env.WAYLAND_DISPLAY;

/** `/etc/os-release` → "Ubuntu 24.04.1 LTS"; null when it says nothing. */
export function osReleaseName(text: string): string | null {
  const v: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) v[m[1] as string] = (m[2] as string).replace(/^(["'])(.*)\1$/, "$2");
  }
  return v.PRETTY_NAME || [v.NAME, v.VERSION_ID].filter(Boolean).join(" ") || null;
}

export function osRelease(path = "/etc/os-release"): string | null {
  try {
    return osReleaseName(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export interface Supply {
  type: string;
  online?: string;
  capacity?: string;
  scope?: string;
}

/**
 * Power from the supplies: AC when a `Mains` or `USB` supply is online, the battery from a
 * `Battery`'s capacity (the lowest, when there are two). A device battery (a mouse's) does not
 * count. Null when there is neither: a desktop or a VM, treated as on AC by the governor.
 */
export function powerOfSupplies(supplies: Supply[]): Power | null {
  let ac: boolean | null = null;
  let battery: number | null = null;
  for (const s of supplies) {
    if (s.type === "Mains" || s.type === "USB") {
      if (s.online === undefined) continue;
      ac = (ac ?? false) || s.online.trim() === "1";
    } else if (s.type === "Battery" && s.scope?.trim() !== "Device") {
      const c = Number.parseInt(s.capacity ?? "", 10);
      if (Number.isFinite(c)) battery = Math.min(battery ?? 100, Math.max(0, c));
    }
  }
  if (ac === null && battery === null) return null;
  if (ac === null) return { ac: false, battery };
  return { ac, battery };
}

const readTrim = (p: string): string | undefined => {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return undefined;
  }
};

export function readSupplies(dir = "/sys/class/power_supply"): Supply[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.map((n) => {
    const at = (f: string) => readTrim(join(dir, n, f));
    const s: Supply = { type: at("type") ?? "" };
    for (const k of ["online", "capacity", "scope"] as const) {
      const v = at(k);
      if (v !== undefined) s[k] = v;
    }
    return s;
  });
}

export async function linuxPower(dir?: string): Promise<Power | null> {
  return powerOfSupplies(readSupplies(dir));
}

export interface DoctorLine {
  /** null: a note, never a warning. */
  good: boolean | null;
  msg: string;
}

export interface LinuxPerm {
  accessibility: boolean;
  screen: boolean;
  input: boolean;
  session?: string;
  atspi?: boolean;
  record?: boolean;
}

/** `autotrack doctor` on Linux: the session, AT-SPI, XRecord, the screen, tesseract. */
export function linuxDoctor(
  perm: LinuxPerm | null,
  env: NodeJS.ProcessEnv = process.env,
  has: (cmd: string) => boolean = (c) => !!onPath(c),
): DoctorLine[] {
  const out: DoctorLine[] = [];
  const session = perm?.session || sessionType(env) || "unknown";
  if (session === "wayland" || isWayland(env))
    out.push({
      good: false,
      msg: "Wayland session: only XWayland apps are seen, input and screen are partial. Log out, pick the Xorg session (gear icon at login), log in",
    });
  else out.push({ good: session === "x11", msg: `session ${session}` });
  if (!perm) {
    out.push({ good: false, msg: "permissions unknown (no helper answer)" });
  } else {
    const atspi = perm.atspi ?? perm.accessibility;
    const record = perm.record ?? perm.input;
    out.push({
      good: atspi,
      msg: atspi
        ? "AT-SPI accessibility bus answers"
        : "AT-SPI not answering: no element info. Install at-spi2-core, log out and in",
    });
    out.push({
      good: record,
      msg: record
        ? "X RECORD extension present (input)"
        : "X server has no RECORD extension: no input recorded",
    });
    out.push({
      good: perm.screen,
      msg: perm.screen ? "screen readable" : "screen not readable through X",
    });
  }
  out.push(
    has("tesseract")
      ? { good: true, msg: "tesseract found: OCR on" }
      : {
          good: null,
          msg: "OCR off: tesseract not installed (sudo apt install tesseract-ocr, or sudo dnf install tesseract)",
        },
  );
  return out;
}
