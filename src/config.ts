/**
 * Where data lives and what `config.json` in it says. The installer writes config.json from the
 * install code; every field is optional and the defaults record with nothing shipped.
 */
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join as nativeJoin, posix, win32 } from "node:path";

/**
 * The install code: base64url of this JSON. Same shape as autobrowse `src/track/code.ts`
 * (the source of truth), checked by hand here since track imports nothing from autobrowse.
 */
export interface TrackCode {
  v: 1;
  bucket: string;
  region: string;
  device: string;
  keyId: string;
  secret: string;
}

export const DEVICE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const DEVICE_MAX = 40;

const CODE_KEYS = ["v", "bucket", "region", "device", "keyId", "secret"];

/** The code's fields when they all check out, else the reason they don't. */
export function checkCode(raw: unknown): TrackCode | string {
  if (!raw || typeof raw !== "object") return "not an object";
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !CODE_KEYS.includes(k));
  if (extra.length) return `unknown fields: ${extra.join(", ")}`;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  const bad: string[] = [];
  if (o.v !== 1) bad.push("v");
  if (!/^[a-z0-9][a-z0-9.-]{2,62}$/.test(str("bucket"))) bad.push("bucket");
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(str("region"))) bad.push("region");
  if (!DEVICE.test(str("device")) || str("device").length > DEVICE_MAX) bad.push("device");
  if (!/^[A-Z0-9]{16,128}$/.test(str("keyId"))) bad.push("keyId");
  if (str("secret").length < 16) bad.push("secret");
  if (bad.length) return `bad install code: ${bad.join(", ")}`;
  return {
    v: 1,
    bucket: str("bucket"),
    region: str("region"),
    device: str("device"),
    keyId: str("keyId"),
    secret: str("secret"),
  };
}

export function decodeCode(code: string): TrackCode {
  const text = code.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("not an install code (base64url expected)");
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    throw new Error("not an install code (does not decode to JSON)");
  }
  const c = checkCode(raw);
  if (typeof c === "string") throw new Error(c);
  return c;
}

export interface Config {
  device: string;
  excludeApps: string[];
  excludeTitles: string[]; // regex sources, case-insensitive
  maxLocalGb: number;
  /** Where segments ship; absent until the install code is in. */
  ship?: TrackCode;
}

export function dataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.AUTOTRACK_DIR) return env.AUTOTRACK_DIR;
  const join = platform === "win32" ? win32.join : posix.join;
  if (platform === "win32")
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "autotrack");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "autotrack");
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "autotrack");
}

export const sessionsDir = (data: string) => nativeJoin(data, "sessions");

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

const validRegex = (s: string) => {
  try {
    new RegExp(s, "i");
    return true;
  } catch {
    return false;
  }
};

/** This machine's name as a device id: kebab-case, ≤ 40. */
export function hostDevice(name = hostname()): string {
  const d = name
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, DEVICE_MAX)
    .replace(/-+$/, "");
  return d || "device";
}

/**
 * config.json: `{ code?, device?, excludeApps?, excludeTitles?, maxLocalGb? }`. `code` is the
 * install code as given (base64url) or already decoded. A bad code is reported, not fatal:
 * recording goes on, shipping waits.
 */
export function parseConfig(raw: unknown, warn: (msg: string) => void = () => {}): Config {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  let ship: TrackCode | undefined;
  if (typeof o.code === "string") {
    try {
      ship = decodeCode(o.code);
    } catch (e) {
      warn(`config: ${(e as Error).message}`);
    }
  } else if (o.code !== undefined) {
    const c = checkCode(o.code);
    if (typeof c === "string") warn(`config: ${c}`);
    else ship = c;
  }
  const device =
    ship?.device ??
    (typeof o.device === "string" && DEVICE.test(o.device) && o.device.length <= DEVICE_MAX
      ? o.device
      : hostDevice());
  const cfg: Config = {
    device,
    excludeApps: strings(o.excludeApps),
    excludeTitles: strings(o.excludeTitles).filter(validRegex),
    maxLocalGb: typeof o.maxLocalGb === "number" && o.maxLocalGb > 0 ? o.maxLocalGb : 5,
  };
  if (ship) cfg.ship = ship;
  return cfg;
}

export function loadConfig(data: string, warn?: (msg: string) => void): Config {
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(nativeJoin(data, "config.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") warn?.(`config: ${(e as Error).message}`);
  }
  return parseConfig(raw, warn);
}
