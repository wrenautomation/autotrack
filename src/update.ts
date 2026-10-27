/**
 * Self-update on Windows and Linux. A signed `release.json` names the newest version and each
 * asset's SHA-256. The platform bundle is unpacked into `<data>/versions/<v>` and passes `selftest`
 * on its own node. Then `<data>/app` (a junction on Windows, a symlink on Linux) is repointed and
 * the recorder restarts. A version that can't get through its first starts is rolled back and
 * marked bad. Mac keeps a real `app` folder (its permissions are tied to the node binary), so
 * nothing here runs there. See the design's "Updates and fleet health".
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { setPriority } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import { fileURLToPath } from "node:url";

/** Where `latest` lives. GitHub's `latest` skips prereleases. */
export const RELEASES = "https://github.com/wrenautomation/autotrack/releases/latest/download/";
/** Ed25519, SPKI DER in base64. The private half is the release workflow's AUTOTRACK_SIGNING_KEY. */
export const PUBLIC_KEY = "MCowBQYDK2VwAyEAqAOMmwW0aDKeQWIznovG/bojwJ6iD/5WKPKC8AAfgz8=";
/** Starts a new version gets before it is rolled back; it is good after GOOD_AFTER_MS up. */
export const MAX_BOOTS = 3;
export const GOOD_AFTER_MS = 10 * 60_000;
/** The recorder's exit code for "start me again now" (an update or a rollback). */
export const RESTART_EXIT = 75;

const VER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** -1, 0 or 1. Build metadata (`+sha`) is ignored; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const x = VER.exec(a);
  const y = VER.exec(b);
  if (!x || !y) throw new Error(`not a version: ${x ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return Math.sign(d);
  }
  if (x[4] === y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  return x[4] < y[4] ? -1 : 1;
}

export interface Release {
  version: string;
  /** Asset name → lowercase hex SHA-256. */
  files: Record<string, string>;
}

/** `release.json`'s bytes against its signature; throws on a bad signature or shape. */
export function verifyRelease(body: Uint8Array, sig: string, key = PUBLIC_KEY): Release {
  const pub = createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
  if (!verify(null, body, pub, Buffer.from(sig.trim(), "base64")))
    throw new Error("release.json: bad signature");
  const r = JSON.parse(Buffer.from(body).toString("utf8")) as Partial<Release>;
  if (typeof r.version !== "string" || !VER.test(r.version))
    throw new Error("release.json: no version");
  if (!r.files || typeof r.files !== "object") throw new Error("release.json: no files");
  for (const [name, sum] of Object.entries(r.files))
    if (!/^[\w.+-]+$/.test(name) || typeof sum !== "string" || !/^[0-9a-f]{64}$/.test(sum))
      throw new Error(`release.json: bad entry ${JSON.stringify(name)}`);
  return { version: r.version, files: r.files };
}

/** The release asset for this OS and CPU, or null. */
export function assetFor(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "win32" && arch === "x64") return "autotrack-win32-x64.zip";
  if (platform === "linux" && arch === "x64") return "autotrack-linux-x64.tar.gz";
  if (platform === "darwin" && (arch === "arm64" || arch === "x64"))
    return `autotrack-darwin-${arch}.tar.gz`;
  return null;
}

/** Where a release's files come from: an http(s) folder URL, a file:// URL or a folder path. */
export interface Source {
  read(name: string): Promise<Uint8Array>;
  /** Writes `name` to `dest`; resolves with its SHA-256. */
  save(name: string, dest: string): Promise<string>;
}

export function sourceAt(base: string, f: typeof fetch = fetch): Source {
  if (/^https?:\/\//.test(base)) {
    const root = base.endsWith("/") ? base : `${base}/`;
    const get = async (name: string, ms: number) => {
      const res = await f(new URL(name, root), { signal: AbortSignal.timeout(ms) });
      if (!res.ok || !res.body) throw new Error(`GET ${name}: ${res.status}`);
      return res;
    };
    return {
      read: async (name) => new Uint8Array(await (await get(name, 60_000)).arrayBuffer()),
      save: async (name, dest) => {
        const res = await get(name, 30 * 60_000);
        const hash = createHash("sha256");
        const body = Readable.fromWeb(res.body as WebStream<Uint8Array>);
        body.on("data", (c: Buffer) => hash.update(c));
        await pipeline(body, createWriteStream(dest));
        return hash.digest("hex");
      },
    };
  }
  const dir = base.startsWith("file://") ? fileURLToPath(base) : base;
  return {
    read: async (name) => new Uint8Array(readFileSync(join(dir, name))),
    save: async (name, dest) => {
      copyFileSync(join(dir, name), dest);
      return sha256File(dest);
    },
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const c of createReadStream(path)) hash.update(c as Buffer);
  return hash.digest("hex");
}

// ---- layout ----

export const versionsDir = (data: string) => join(data, "versions");
export const appPath = (data: string) => join(data, "app");

function isLink(path: string): boolean | null {
  try {
    return lstatSync(path).isSymbolicLink(); // a junction counts on Windows
  } catch {
    return null;
  }
}

/** The version `app` points at; null when `app` is a real folder (Mac, an old install) or absent. */
export function currentVersion(data: string): string | null {
  const app = appPath(data);
  if (!isLink(app)) return null;
  try {
    return basename(readlinkSync(app).replace(/[\\/]+$/, ""));
  } catch {
    return null;
  }
}

/** Removes a symlink or junction, never what it points at. */
function removeLink(path: string): void {
  const link = isLink(path);
  if (link === null) return;
  if (!link) throw new Error(`${path} is a real folder, not a link`);
  try {
    unlinkSync(path);
  } catch {
    rmdirSync(path); // a junction on Windows
  }
}

/** Points `app` at `versions/<version>`. On Linux the swap is one rename. */
export function pointApp(
  data: string,
  version: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const target = join(versionsDir(data), version);
  if (!existsSync(join(target, "package.json"))) throw new Error(`${target} is not unpacked`);
  const app = appPath(data);
  if (isLink(app) === false) throw new Error(`${app} is a real folder: reinstall to update`);
  const next = `${app}.next`;
  removeLink(next);
  symlinkSync(target, next, platform === "win32" ? "junction" : "dir");
  if (platform === "win32") {
    // No rename over an existing junction on Windows: move it aside first.
    const old = `${app}.old`;
    removeLink(old);
    if (isLink(app)) renameSync(app, old);
    renameSync(next, app);
    removeLink(old);
  } else renameSync(next, app);
}

/** Deletes every version but `keep`. A folder still in use stays until the next prune. */
export function prune(data: string, keep: (string | null | undefined)[]): string[] {
  const dir = versionsDir(data);
  if (!existsSync(dir)) return [];
  const kept = new Set(keep.filter(Boolean));
  const gone: string[] = [];
  for (const name of readdirSync(dir)) {
    if (kept.has(name)) continue;
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
      gone.push(name);
    } catch {}
  }
  return gone;
}

// ---- state ----

export interface UpdateState {
  /** Just switched to; not yet up GOOD_AFTER_MS. */
  pending?: string;
  /** What `pending` replaced: the rollback target. */
  previous?: string;
  /** Starts of `pending` so far. */
  boots?: number;
  /** Never offered again. */
  bad?: string[];
  /** Unpacked and selftested, waiting for an idle moment. */
  staged?: string;
  checkedAt?: string;
  latest?: string;
  error?: string;
}

const statePath = (data: string) => join(data, "update.json");

export function readState(data: string): UpdateState {
  try {
    const s = JSON.parse(readFileSync(statePath(data), "utf8")) as UpdateState;
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

export function writeState(data: string, s: UpdateState): void {
  const tmp = `${statePath(data)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, statePath(data));
}

/**
 * Run first in `start`. Counts a start of a pending version. Past MAX_BOOTS it points `app` back
 * at the previous version, marks this one bad and says to restart.
 */
export function bootCheck(data: string, version: string): "ok" | "rolled back" {
  const s = readState(data);
  if (s.pending !== version) return "ok";
  const boots = (s.boots ?? 0) + 1;
  if (boots <= MAX_BOOTS) {
    writeState(data, { ...s, boots });
    return "ok";
  }
  const back = s.previous && existsSync(join(versionsDir(data), s.previous)) ? s.previous : null;
  if (back) pointApp(data, back);
  const { pending: _p, boots: _b, ...rest } = s;
  writeState(data, {
    ...rest,
    bad: [...new Set([...(s.bad ?? []), version])],
    error: back
      ? `${version} failed ${MAX_BOOTS} starts; back on ${back}`
      : `${version} failed ${MAX_BOOTS} starts; nothing to go back to`,
  });
  return back ? "rolled back" : "ok";
}

/** After GOOD_AFTER_MS up: `pending` clears and older versions go. */
export function markGood(data: string, version: string): void {
  const s = readState(data);
  if (s.pending === version) {
    const { pending: _p, boots: _b, ...rest } = s;
    writeState(data, rest);
  }
  const now = readState(data);
  prune(data, [version, currentVersion(data), now.previous, now.staged]);
}

// ---- staging (a child process: the download and unpack stay out of the recorder's budget) ----

export interface StageOptions {
  data: string;
  /** The running version. */
  version: string;
  platform?: NodeJS.Platform;
  arch?: string;
  source: Source;
  key?: string;
  log?: (msg: string) => void;
  now?: () => number;
  /** Runs the new version's `selftest`; resolves with its output or throws. Tests swap it. */
  selftest?: (dir: string, platform: NodeJS.Platform) => Promise<string>;
}

export type StageResult =
  | { state: "current" | "bad" | "unsupported"; latest?: string }
  | { state: "staged"; latest: string };

/** Checks for a newer release; when there is one, unpacks and selftests it. Throws on failure. */
export async function stage(o: StageOptions): Promise<StageResult> {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const asset = assetFor(platform, arch);
  if (!asset || platform === "darwin") return { state: "unsupported" };
  const at = new Date((o.now ?? Date.now)()).toISOString();
  const release = verifyRelease(
    await o.source.read("release.json"),
    Buffer.from(await o.source.read("release.json.sig")).toString("utf8"),
    o.key,
  );
  const s = readState(o.data);
  writeState(o.data, { ...s, checkedAt: at, latest: release.version });
  const v = release.version;
  if (compareVersions(v, o.version) <= 0) return { state: "current", latest: v };
  if (s.bad?.includes(v)) return { state: "bad", latest: v };
  const dir = join(versionsDir(o.data), v);
  const run = o.selftest ?? selftestAt;
  if (existsSync(join(dir, "package.json"))) {
    await run(dir, platform);
    writeState(o.data, { ...readState(o.data), staged: v });
    return { state: "staged", latest: v };
  }
  const want = release.files[asset];
  if (!want) throw new Error(`release ${v} has no ${asset}`);
  mkdirSync(versionsDir(o.data), { recursive: true });
  const tmp = `${dir}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const archive = join(versionsDir(o.data), `${asset}.download`);
  try {
    o.log?.(`update: downloading ${v}`);
    const got = await o.source.save(asset, archive);
    if (got !== want) throw new Error(`${asset}: sha256 ${got}, release says ${want}`);
    await unpack(archive, tmp, platform);
    const pkg = JSON.parse(readFileSync(join(tmp, "package.json"), "utf8")) as { version?: string };
    if (pkg.version !== v) throw new Error(`${asset} holds ${pkg.version}, release says ${v}`);
    renameSync(tmp, dir);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  } finally {
    rmSync(archive, { force: true });
  }
  try {
    await run(dir, platform);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    const now = readState(o.data);
    writeState(o.data, { ...now, bad: [...new Set([...(now.bad ?? []), v])] });
    throw new Error(`${v} failed its selftest, marked bad: ${(e as Error).message}`);
  }
  writeState(o.data, { ...readState(o.data), staged: v });
  o.log?.(`update: ${v} staged`);
  return { state: "staged", latest: v };
}

function exec(cmd: string, args: string[], ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: ms, windowsHide: true, maxBuffer: 4 << 20 },
      (err, out, errOut) =>
        err
          ? reject(new Error(`${basename(cmd)}: ${String(errOut).trim() || err.message}`))
          : resolve(out),
    );
  });
}

const winTar = () => join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

/** Windows' own bsdtar reads zip; Linux tarballs are gzip. */
function unpack(archive: string, into: string, platform: NodeJS.Platform): Promise<string> {
  const tar = platform === "win32" ? winTar() : "tar";
  return exec(
    tar,
    platform === "win32" ? ["-xf", archive, "-C", into] : ["-xzf", archive, "-C", into],
    10 * 60_000,
  );
}

export const nodeIn = (dir: string, platform: NodeJS.Platform = process.platform) =>
  join(dir, "node", platform === "win32" ? "node.exe" : "node");

/** The unpacked version's own node runs its own `selftest`. */
export async function selftestAt(dir: string, platform: NodeJS.Platform): Promise<string> {
  const out = await exec(nodeIn(dir, platform), [join(dir, "dist", "cli.js"), "selftest"], 60_000);
  if (!/^selftest ok /m.test(out)) throw new Error(`selftest said: ${out.trim().slice(0, 200)}`);
  return out;
}

// ---- apply (in the recorder) ----

/** Points `app` at the staged version and records it as pending. The caller restarts. */
export function apply(data: string, version: string): { previous: string | null } {
  const previous = currentVersion(data);
  pointApp(data, version);
  const { staged: _s, error: _e, ...s } = readState(data);
  const back = previous ?? s.previous;
  writeState(data, { ...s, pending: version, boots: 0, ...(back ? { previous: back } : {}) });
  refreshExtension(data);
  return { previous };
}

/**
 * The unpacked browser extension at `<data>/extension` follows the app. Skipped when the install
 * left none (the Web Store copy updates itself). Best effort: a browser holding the folder open
 * leaves the old one for the next update.
 */
export function refreshExtension(data: string): boolean {
  const ext = join(data, "extension");
  if (!existsSync(join(ext, "manifest.json"))) return false;
  const app = appPath(data);
  const fresh = `${ext}.new`;
  const old = `${ext}.old`;
  try {
    rmSync(fresh, { recursive: true, force: true });
    if (existsSync(join(app, "extension", "manifest.json")))
      cpSync(join(app, "extension"), fresh, { recursive: true });
    else if (process.platform === "win32" && existsSync(join(app, "extension.zip"))) {
      mkdirSync(fresh);
      execFileSync(winTar(), ["-xf", join(app, "extension.zip"), "-C", fresh], {
        windowsHide: true,
      });
    } else return false;
    if (!existsSync(join(fresh, "manifest.json"))) return false;
    rmSync(old, { recursive: true, force: true });
    renameSync(ext, old);
    renameSync(fresh, ext);
    rmSync(old, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ---- the schedule (in the recorder) ----

export interface UpdaterOptions {
  data: string;
  version: string;
  mode: "auto" | "off";
  /** ms since the last input. */
  idleMs(): number;
  /** Runs `autotrack update --stage` in a child; resolves with its result or throws. */
  stageChild(): Promise<StageResult>;
  /** Stops the recorder and starts the app again. */
  restart(why: string): Promise<void>;
  log?: (msg: string) => void;
  now?: () => number;
  random?: () => number;
}

export const FIRST_CHECK_MS = [2 * 60_000, 10 * 60_000] as const;
/** A check reads release.json (~550 bytes, one GitHub CDN request): every 30 minutes is cheap. */
export const CHECK_EVERY_MS = 30 * 60_000;
export const CHECK_JITTER_MS = 5 * 60_000;
export const IDLE_BEFORE_MS = 2 * 60_000;
export const FORCE_AFTER_MS = 24 * 3600_000;

export interface UpdaterStatus {
  mode: "auto" | "off";
  checkedAt: string | null;
  latest: string | null;
  /** idle, checking, staged (waiting to apply), applying. */
  state: string;
  error: string | null;
}

export class Updater {
  private readonly o: UpdaterOptions;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private applyTimer: NodeJS.Timeout | null = null;
  private state = "idle";
  private ready: { version: string; at: number } | null = null;
  private checking: Promise<StageResult | null> | null = null;

  constructor(o: UpdaterOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  status(): UpdaterStatus {
    const s = readState(this.o.data);
    return {
      mode: this.o.mode,
      checkedAt: s.checkedAt ?? null,
      latest: s.latest ?? null,
      state: this.state,
      error: s.error ?? null,
    };
  }

  start(): void {
    if (this.o.mode === "off") return;
    const r = this.o.random ?? Math.random;
    const [lo, hi] = FIRST_CHECK_MS;
    this.schedule(lo + r() * (hi - lo));
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.applyTimer) clearInterval(this.applyTimer);
    this.timer = this.applyTimer = null;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.check().finally(() => {
        const r = this.o.random ?? Math.random;
        this.schedule(CHECK_EVERY_MS + (r() * 2 - 1) * CHECK_JITTER_MS);
      });
    }, ms);
    this.timer.unref();
  }

  /** One check; a staged version then waits for an idle moment (or `now`). */
  check(opts: { now?: boolean } = {}): Promise<StageResult | null> {
    this.checking ??= (async () => {
      this.state = "checking";
      try {
        const r = await this.o.stageChild();
        const s = readState(this.o.data);
        if (s.error && r.state !== "bad") {
          const { error: _e, ...rest } = s;
          writeState(this.o.data, rest);
        }
        if (r.state === "staged") {
          this.ready ??= { version: r.latest, at: this.now() };
          this.state = "staged";
          // Asked: switch a moment later, so the caller hears back before the restart.
          if (opts.now) setTimeout(() => void this.applyNow("asked"), 1000);
          else this.waitForIdle();
        } else this.state = "idle";
        return r;
      } catch (e) {
        const msg = (e as Error).message;
        this.o.log?.(`update: ${msg}`);
        writeState(this.o.data, { ...readState(this.o.data), error: msg });
        this.state = "idle";
        return null;
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  private waitForIdle(): void {
    if (this.applyTimer) return;
    this.applyTimer = setInterval(() => void this.tick(), 30_000);
    this.applyTimer.unref();
  }

  /** Every 30 s while staged: apply once input has rested, or after a day regardless. */
  async tick(): Promise<boolean> {
    if (!this.ready) return false;
    const idle = this.o.idleMs() >= IDLE_BEFORE_MS;
    const overdue = this.now() - this.ready.at >= FORCE_AFTER_MS;
    if (!idle && !overdue) return false;
    await this.applyNow(idle ? "idle" : "overdue");
    return true;
  }

  private async applyNow(why: string): Promise<void> {
    if (!this.ready) return;
    const { version } = this.ready;
    this.stop();
    this.state = "applying";
    try {
      const { previous } = apply(this.o.data, version);
      this.o.log?.(`update: ${previous ?? "?"} → ${version} (${why}); restarting`);
    } catch (e) {
      const msg = `could not switch to ${version}: ${(e as Error).message}`;
      this.o.log?.(`update: ${msg}`);
      writeState(this.o.data, { ...readState(this.o.data), error: msg });
      this.ready = null;
      this.state = "idle";
      this.start();
      return;
    }
    await this.o.restart(`update to ${version}`);
  }
}

/** `autotrack update --stage` as a child of the running node and cli, at low priority. */
export function stageInChild(
  cli: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StageResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "update", "--stage"], {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      if (child.pid) setPriority(child.pid, 10);
    } catch {}
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c;
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      const last = out.trim().split("\n").pop() ?? "";
      try {
        const r = JSON.parse(last) as StageResult | { error: string };
        if ("error" in r) reject(new Error(r.error));
        else resolve(r);
      } catch {
        reject(new Error(`update --stage exited ${code}: ${err.trim().slice(-300) || last}`));
      }
    });
  });
}
