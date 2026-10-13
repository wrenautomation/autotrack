#!/usr/bin/env node
/**
 * wren-track start|stop|pause|resume|status|doctor (ship and uninstall come with packaging).
 * `start` runs in the foreground; the login item runs it. The others talk to it over the
 * control socket.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { arch, release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { displayAt, nodeCapturer, osScreens, windowFront, workerEncoder } from "./capture.ts";
import { type Config, dataDir, loadConfig, sessionsDir } from "./config.ts";
import { type Command, lock, type Request, send, serve } from "./control.ts";
import { type Coords, coordsFor, identity } from "./coords.ts";
import { startHook, uiohook } from "./hook.ts";
import { notify } from "./notify.ts";
import { helperCommand, openProbe, PACKAGE_ROOT } from "./probe.ts";
import { Recorder, type Status } from "./recorder.ts";
import { noShipper, type Shipper } from "./ship.ts";

const VERSION = (() => {
  try {
    return (
      JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }
    ).version;
  } catch {
    return "0.0.0";
  }
})();

function osVersion(): string {
  if (process.platform === "darwin") {
    try {
      return execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
    } catch {}
  }
  return release();
}

function logger(data: string): (msg: string) => void {
  const path = join(data, "track.log");
  return (msg) => {
    const line = `${new Date().toISOString()} ${msg}\n`;
    process.stderr.write(line);
    try {
      appendFileSync(path, line);
    } catch {}
  };
}

/** Build a recorder on the real OS pieces. */
async function openRecorder(
  data: string,
  config: Config,
  opts: { notify: boolean; shipper: Shipper; log: (msg: string) => void },
): Promise<Recorder> {
  const probe = openProbe(opts.log);
  if (!probe.available)
    opts.log("probe helper missing: no element or app info, text is written redacted");
  let coords: Coords = identity;
  const refresh = async () => {
    coords = coordsFor(process.platform, await osScreens());
  };
  await refresh();
  setInterval(() => void refresh().catch(() => {}), 30_000).unref();
  const encoder = workerEncoder(opts.log);
  const source = await uiohook();
  const recorder = new Recorder({
    sessions: sessionsDir(data),
    config,
    meta: { os: process.platform, osVersion: osVersion(), arch: arch(), trackVersion: VERSION },
    probe,
    capturer: await nodeCapturer(() => coords),
    encode: encoder.encode,
    hook: (onRaw) => {
      const stop = startHook(
        source,
        () => coords,
        () => performance.now(),
        onRaw,
      );
      return () => {
        stop();
        encoder.close();
      };
    },
    coords: () => coords,
    displayAt: await displayAt(() => coords),
    ...(probe.available ? {} : { frontFallback: await windowFront(() => coords) }),
    ...(opts.notify ? { notify: (m: string) => notify(m) } : {}),
    shipper: opts.shipper,
    log: opts.log,
  });
  return recorder;
}

async function start(data: string): Promise<number> {
  mkdirSync(data, { recursive: true });
  const held = lock(data);
  if (!held.ok) {
    console.error(`wren-track is already running (pid ${held.pid})`);
    return 1;
  }
  const log = logger(data);
  const config = loadConfig(data, log);
  let recorder: Recorder;
  try {
    recorder = await openRecorder(data, config, { notify: true, shipper: noShipper, log });
    recorder.start();
  } catch (e) {
    held.release();
    log(`start failed: ${(e as Error).message}`);
    if (process.platform === "darwin")
      log("on Mac this usually means Accessibility or Input Monitoring is not granted to this app");
    return 1;
  }
  log(`recording ${recorder.journal.dir}`);
  let stopping: Promise<void> | null = null;
  const stop = () => {
    stopping ??= recorder.stop().finally(() => {
      held.release();
      server.close();
      log("stopped");
      process.exit(0);
    });
    return stopping;
  };
  const server = await serve(data, async (req: Request) => {
    if (req.op === "web") return recorder.external(req.event);
    const cmd = req.op;
    if (cmd === "pause") recorder.pause("cli");
    if (cmd === "resume") recorder.resume();
    if (cmd === "stop") {
      setImmediate(() => void stop());
      return { stopping: true };
    }
    return recorder.status();
  });
  server.ref();
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  return new Promise<number>(() => {}); // runs until stopped
}

async function control(data: string, cmd: Command): Promise<number> {
  const r = await send(data, cmd);
  if (r === null) {
    console.error("wren-track is not running");
    return 1;
  }
  console.log(JSON.stringify(r, null, 2));
  return 0;
}

function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) total += statSync(p).size;
  }
  return total;
}

function countSegments(sessions: string): { open: number; closed: number } {
  let open = 0;
  let closed = 0;
  if (!existsSync(sessions)) return { open, closed };
  for (const s of readdirSync(sessions)) {
    const dir = join(sessions, s);
    if (!statSync(dir).isDirectory()) continue;
    for (const seg of readdirSync(dir).filter((n) => /^\d{3,}$/.test(n)))
      existsSync(join(dir, seg, ".done")) ? closed++ : open++;
  }
  return { open, closed };
}

const MEASURE_MS = 10_000;

/** CPU % of one core and RSS over 10 s: the running recorder's, or a throwaway one in-process. */
async function measure(data: string): Promise<{ cpuPct: number; rssMb: number; of: string }> {
  const first = (await send(data, "status")) as Status | null;
  if (first?.pid) {
    const t = Date.now();
    await new Promise((r) => setTimeout(r, MEASURE_MS));
    const second = (await send(data, "status")) as Status | null;
    if (second?.pid === first.pid) {
      const cpuPct = ((second.cpuUs - first.cpuUs) / 1000 / (Date.now() - t)) * 100;
      return { cpuPct, rssMb: second.rssMb, of: `running recorder (pid ${first.pid})` };
    }
  }
  const tmp = mkdtempSync(join(tmpdir(), "wren-track-doctor-"));
  const quiet = () => {};
  const recorder = await openRecorder(tmp, loadConfig(data), {
    notify: false,
    shipper: noShipper,
    log: quiet,
  });
  const cpu0 = process.cpuUsage();
  const t = Date.now();
  let rss = 0;
  recorder.start();
  const sample = setInterval(() => {
    rss = Math.max(rss, process.memoryUsage().rss);
  }, 500);
  await new Promise((r) => setTimeout(r, MEASURE_MS));
  clearInterval(sample);
  await recorder.stop();
  const used = process.cpuUsage(cpu0);
  rmSync(tmp, { recursive: true, force: true });
  return {
    cpuPct: ((used.user + used.system) / 1000 / (Date.now() - t)) * 100,
    rssMb: Math.round(rss / 1e6),
    of: "a throwaway recorder in this process (move the mouse and type to measure active use)",
  };
}

async function doctor(data: string): Promise<number> {
  const ok = (good: boolean) => (good ? "ok  " : "WARN");
  let warnings = 0;
  const line = (good: boolean, msg: string) => {
    if (!good) warnings++;
    console.log(`${ok(good)} ${msg}`);
  };
  console.log(
    `wren-track ${VERSION}, node ${process.version}, ${process.platform} ${osVersion()} ${arch()}`,
  );
  const config = loadConfig(data, (m) => line(false, m));
  console.log(`     data ${data}`);
  console.log(`     device ${config.device}`);
  line(
    !!config.ship,
    config.ship
      ? `ships to s3://${config.ship.bucket}/${config.device}/`
      : "no install code: nothing ships",
  );
  const helper = helperCommand();
  line(
    !!helper,
    helper
      ? `probe helper ${helper.path}`
      : "probe helper missing: no element or app info, text is written redacted",
  );
  if (process.platform === "darwin") {
    const probe = openProbe();
    const perm = probe.available ? await probe.perm(3000) : null;
    probe.close();
    if (!perm) line(false, "permissions unknown (no probe answer)");
    else {
      line(perm.accessibility, `Accessibility ${perm.accessibility ? "granted" : "NOT granted"}`);
      line(perm.input, `Input Monitoring ${perm.input ? "granted" : "NOT granted"}`);
      line(perm.screen, `Screen Recording ${perm.screen ? "granted" : "NOT granted"}`);
    }
  } else if (process.platform === "win32") console.log("     permissions: none needed on Windows");
  const size = dirSize(data);
  const segs = countSegments(sessionsDir(data));
  line(
    size < config.maxLocalGb * 1e9,
    `data ${(size / 1e6).toFixed(1)} MB (cap ${config.maxLocalGb} GB), ${segs.closed} closed segment(s) waiting to ship, ${segs.open} open`,
  );
  const running = (await send(data, "status")) as Status | null;
  console.log(
    running?.pid
      ? `     running: pid ${running.pid}, session ${running.session}${running.paused ? `, paused (${running.paused})` : ""}`
      : "     not running",
  );
  console.log(`     measuring for ${MEASURE_MS / 1000} s…`);
  const m = await measure(data);
  line(m.cpuPct < 3, `CPU ${m.cpuPct.toFixed(2)}% of one core (budget 3%), ${m.of}`);
  line(m.rssMb < 200, `RSS ${m.rssMb} MB (budget 200 MB)`);
  console.log(warnings ? `${warnings} warning(s)` : "all good");
  return warnings ? 1 : 0;
}

/**
 * Mac: freed 24 MB capture buffers stay in malloc's large cache (~150 MB of RSS). The switch is
 * read at process start, so the recorder (and doctor's measure) relaunch once with it off.
 */
function relaunch(): Promise<number> | null {
  if (process.platform !== "darwin" || process.env.MallocLargeCache !== undefined) return null;
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, MallocLargeCache: "0" },
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
}

const USAGE = "usage: wren-track start|stop|pause|resume|status|ship|doctor|uninstall";

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const data = dataDir();
  switch (cmd) {
    case "start":
      return (entry && relaunch()) || start(data);
    case "stop":
    case "pause":
    case "resume":
    case "status":
      return control(data, cmd);
    case "doctor":
      return (entry && relaunch()) || doctor(data);
    case "ship":
    case "uninstall":
      console.error(`wren-track ${cmd}: not built yet`);
      return 2;
    default:
      console.error(USAGE);
      return cmd ? 2 : 0;
  }
}

const entry = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (entry) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error((e as Error).message);
      process.exit(1);
    },
  );
}
