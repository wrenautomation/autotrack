#!/usr/bin/env node
/**
 * autotrack start|stop|pause|resume|status|ship|doctor|uninstall.
 * `start` runs in the foreground; the login item runs it. stop, pause, resume and status talk to
 * it over the control socket; ship and uninstall work on the data dir.
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
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkFrames, openShots, ShotsCapturer } from "./capture.ts";
import { type Config, dataDir, loadConfig, sessionsDir } from "./config.ts";
import { type Command, lock, type Request, runningPid, send, serve } from "./control.ts";
import { type Coords, coordsFor } from "./coords.ts";
import { startHook, uiohook } from "./hook.ts";
import { pinnedLevel } from "./level.ts";
import { linuxDoctor, linuxPower, osRelease } from "./linux.ts";
import { notify } from "./notify.ts";
import { ocrHelper } from "./ocr.ts";
import { helperCommand, openProbe, PACKAGE_ROOT } from "./probe.ts";
import { ask } from "./prompt.ts";
import { Recorder, type Status } from "./recorder.ts";
import { checkShip, noShipper, type Shipper, shipperFor } from "./ship.ts";
import { syntheticHook, syntheticRate } from "./synthetic.ts";
import { busyMeter, macPower, powerOf } from "./system.ts";
import { removeLaterWin, uninstall } from "./uninstall.ts";

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
  if (process.platform === "linux") return osRelease() ?? release();
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
  opts: { notify: boolean; shipper: Shipper; log: (msg: string) => void; ocr?: boolean },
): Promise<Recorder> {
  const probe = openProbe(opts.log);
  if (!probe.available)
    opts.log("probe helper missing: no element or app info, text is written redacted");
  const shots = openShots(opts.log);
  if (!shots.available) opts.log("shots helper missing: no frames are recorded");
  const capturer = new ShotsCapturer(shots, opts.log);
  await capturer.refresh(15_000);
  let coords: Coords = coordsFor(process.platform, capturer.screens());
  setInterval(() => {
    void capturer.refresh().then((ok) => {
      if (ok) coords = coordsFor(process.platform, capturer.screens());
    });
  }, 30_000).unref();
  const synthetic = syntheticRate(process.env.AUTOTRACK_SYNTHETIC); // load tests only
  const source = synthetic ? null : await uiohook();
  const area = () => {
    const ds = capturer.displays();
    return ds.find((d) => d.primary) ?? ds[0] ?? { x: 0, y: 0, width: 1400, height: 800 };
  };
  const recorder = new Recorder({
    sessions: sessionsDir(data),
    config,
    meta: { os: process.platform, osVersion: osVersion(), arch: arch(), trackVersion: VERSION },
    probe,
    capturer,
    hook: (onRaw) =>
      synthetic
        ? syntheticHook(synthetic, area)(onRaw)
        : startHook(
            source as NonNullable<typeof source>,
            () => coords,
            () => performance.now(),
            onRaw,
          ),
    coords: () => coords,
    displayAt: capturer.displayAt,
    ...(opts.notify ? { notify: (m: string) => notify(m), ask } : {}),
    shipper: opts.shipper,
    log: opts.log,
    power:
      process.platform === "darwin"
        ? macPower
        : process.platform === "linux"
          ? () => linuxPower()
          : async () => (probe.available ? powerOf(await probe.power()) : null),
    busy: busyMeter(process.platform),
    helperUsage: async () => {
      const [p, s] = await Promise.all([probe.usage(), shots.usage()]);
      return { probe: p, shots: s };
    },
    helperStarts: () => ({ probe: probe.starts, shots: shots.starts }),
    pinned: pinnedLevel(process.env.AUTOTRACK_LEVEL),
    ocr: opts.ocr === false ? null : ocrHelper(opts.log),
  });
  return recorder;
}

async function start(data: string): Promise<number> {
  mkdirSync(data, { recursive: true });
  const held = lock(data);
  if (!held.ok) {
    console.error(`autotrack is already running (pid ${held.pid})`);
    return 1;
  }
  const log = logger(data);
  const config = loadConfig(data, log);
  let recorder: Recorder;
  try {
    recorder = await openRecorder(data, config, {
      notify: true,
      shipper: shipperFor(data, config, log),
      log,
    });
    recorder.start();
  } catch (e) {
    held.release();
    log(`start failed: ${(e as Error).message}`);
    if (process.platform === "darwin")
      log("on Mac this usually means Accessibility or Input Monitoring is not granted to this app");
    if (process.platform === "linux")
      log("on Linux this usually means no X display (DISPLAY unset) or no RECORD extension");
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
    if (cmd === "task") void recorder.task();
    if (cmd === "stop") {
      setImmediate(() => void stop());
      return { stopping: true };
    }
    return recorder.statusNow();
  });
  server.ref();
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  return new Promise<number>(() => {}); // runs until stopped
}

async function control(data: string, cmd: Command): Promise<number> {
  const r = await send(data, cmd);
  if (r === null) {
    console.error("autotrack is not running");
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

interface Cost {
  level: string;
  why: string;
  /** % of one core over the window, recorder + helpers (OCR apart). */
  cpuPct: number;
  /** Resident MB, recorder + helpers, at the end of the window. */
  rssMb: number;
  /** The most of `rssMb` seen in the window. */
  peakRssMb: number;
  /** Raw inputs in the window: 0 means the cost is the idle one. */
  inputs: number;
  parts: Record<string, { cpuPct: number; rssMb: number }>;
  ocrCpuMs: number;
  of: string;
}

/** Resident MB of the recorder and its helpers in one status. */
const totalRss = (s: Status) =>
  s.rssMb + Object.values(s.helpers ?? {}).reduce((n, u) => n + (u?.rssMb ?? 0), 0);

/** Cost between two statuses `ms` apart; `between` are the statuses read in the window. */
export function costOf(a: Status, b: Status, ms: number, of: string, between: Status[] = []): Cost {
  const parts: Cost["parts"] = {
    recorder: { cpuPct: ((b.cpuUs - a.cpuUs) / 1000 / ms) * 100, rssMb: b.rssMb },
  };
  for (const [k, u] of Object.entries(b.helpers ?? {})) {
    const u0 = a.helpers?.[k];
    if (!u || !u0) continue;
    parts[k] = { cpuPct: (Math.max(0, u.cpuMs - u0.cpuMs) / ms) * 100, rssMb: u.rssMb };
  }
  const sum = (f: (p: { cpuPct: number; rssMb: number }) => number) =>
    Object.values(parts).reduce((n, p) => n + f(p), 0);
  const rssMb = Math.round(sum((p) => p.rssMb));
  return {
    level: b.level,
    why: b.why,
    cpuPct: sum((p) => p.cpuPct),
    rssMb,
    peakRssMb: Math.round(Math.max(rssMb, ...between.map(totalRss))),
    inputs: Math.max(0, (b.inputs ?? 0) - (a.inputs ?? 0)),
    parts,
    ocrCpuMs: b.ocr?.cpuMs ?? 0,
    of,
  };
}

/**
 * CPU % of one core and RSS over 10 s, recorder and helpers: the running recorder's (RSS read
 * every 2 s for the peak), or a throwaway one in-process.
 */
async function measure(data: string): Promise<Cost> {
  const first = (await send(data, "status")) as Status | null;
  if (first?.pid) {
    const t = Date.now();
    const seen: Status[] = [];
    for (let i = 0; i < MEASURE_MS / 2000; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = (await send(data, "status")) as Status | null;
      if (s?.pid === first.pid) seen.push(s);
    }
    const last = seen.at(-1);
    if (last)
      return costOf(first, last, Date.now() - t, `running recorder (pid ${first.pid})`, seen);
  }
  const tmp = mkdtempSync(join(tmpdir(), "autotrack-doctor-"));
  const quiet = () => {};
  const recorder = await openRecorder(tmp, loadConfig(data), {
    notify: false,
    shipper: noShipper,
    log: quiet,
    ocr: false,
  });
  recorder.start();
  const a = await recorder.statusNow();
  const t = Date.now();
  let rss = 0;
  const sample = setInterval(() => {
    rss = Math.max(rss, process.memoryUsage().rss);
  }, 500);
  await new Promise((r) => setTimeout(r, MEASURE_MS));
  clearInterval(sample);
  const b = await recorder.statusNow();
  await recorder.stop();
  rmSync(tmp, { recursive: true, force: true });
  return costOf(
    a,
    { ...b, rssMb: Math.max(b.rssMb, Math.round(rss / 1e6)) },
    Date.now() - t,
    "a throwaway recorder in this process (move the mouse and type to measure active use)",
  );
}

async function doctor(data: string): Promise<number> {
  const ok = (good: boolean) => (good ? "ok  " : "WARN");
  let warnings = 0;
  const line = (good: boolean, msg: string) => {
    if (!good) warnings++;
    console.log(`${ok(good)} ${msg}`);
  };
  console.log(
    `autotrack ${VERSION}, node ${process.version}, ${process.platform} ${osVersion()} ${arch()}`,
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
  if (config.ship) {
    const put = await checkShip(config, VERSION);
    line(put.ok, put.message);
  }
  const helper = helperCommand();
  line(
    !!helper,
    helper
      ? `probe helper ${helper.path}`
      : "probe helper missing: no element or app info, text is written redacted",
  );
  const shots = openShots();
  const framesFile = join(tmpdir(), `autotrack-doctor-${process.pid}.jpg`);
  const frames = await checkFrames(shots, framesFile);
  shots.close();
  rmSync(framesFile, { force: true });
  line(frames.ok, frames.message);
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
  } else if (process.platform === "linux") {
    const probe = openProbe();
    const perm = probe.available ? await probe.perm(3000) : null;
    probe.close();
    for (const l of linuxDoctor(perm)) {
      if (l.good === null) console.log(`     ${l.msg}`);
      else line(l.good, l.msg);
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
  const each = (f: (p: { cpuPct: number; rssMb: number }) => string) =>
    Object.entries(m.parts)
      .map(([k, p]) => `${k} ${f(p)}`)
      .join(", ");
  console.log(`     level ${m.level} (${m.why})`);
  const use = m.inputs > 0 ? `active, ${m.inputs} inputs` : "idle";
  line(
    m.cpuPct < 3,
    `CPU ${m.cpuPct.toFixed(2)}% of one core over 10 s, ${use} (budget 3% on average): ${each((p) => `${p.cpuPct.toFixed(2)}%`)}; ${m.of}`,
  );
  line(
    m.peakRssMb < 200,
    `RSS ${m.peakRssMb} MB peak, ${use} (budget 200 MB): ${each((p) => `${p.rssMb} MB`)} at the end`,
  );
  console.log(`     OCR (idle time only, not in the budget): ${m.ocrCpuMs} ms CPU this run`);
  console.log(warnings ? `${warnings} warning(s)` : "all good");
  return warnings ? 1 : 0;
}

/** One pass now, backoff ignored. Exit 1 when anything is left or nothing could ship. */
async function shipNow(data: string): Promise<number> {
  const config = loadConfig(data, (m) => console.error(m));
  const log = (m: string) => console.error(m);
  const finish = !runningPid(data); // no recorder: segments waiting for OCR ship as they are
  const r = await shipperFor(data, config, log).ship(sessionsDir(data), { force: true, finish });
  console.log(JSON.stringify(r, null, 2));
  if (r.skipped === "no code") console.error("no install code in config.json: nothing ships");
  if (r.skipped === "busy") console.error("the recorder is shipping right now; try again shortly");
  return r.failed || r.skipped ? 1 : 0;
}

async function uninstallCmd(data: string, args: string[]): Promise<number> {
  const log = (m: string) => console.log(m);
  return uninstall({
    platform: process.platform,
    data,
    yes: args.includes("--yes") || args.includes("-y"),
    run: (cmd, cmdArgs, env) =>
      new Promise((resolve) => {
        const child = spawn(cmd, cmdArgs, {
          stdio: "ignore",
          windowsHide: true,
          env: env ?? process.env,
        });
        child.on("error", () => resolve(-1));
        child.on("exit", (code) => resolve(code ?? -1));
      }),
    confirm: async (question) => {
      if (!process.stdin.isTTY) return false;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(question)).trim());
      } finally {
        rl.close();
      }
    },
    stopRecorder: async () => {
      await send(data, "stop");
      for (let i = 0; i < 100; i++) {
        const pid = runningPid(data);
        if (!pid) return;
        if (i === 80) {
          try {
            process.kill(pid);
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    hostUninstall: async () => {
      const host = join(PACKAGE_ROOT, "host", "manifests.mjs");
      if (!existsSync(host)) return;
      const m = (await import(pathToFileURL(host).href)) as { uninstall(): Promise<void> };
      await m.uninstall();
    },
    ship: async () => {
      const config = loadConfig(data);
      return config.ship
        ? shipperFor(data, config, log).ship(sessionsDir(data), { force: true, finish: true })
        : null;
    },
    removeLater: removeLaterWin,
    log,
  });
}

const USAGE = "usage: autotrack start|stop|pause|resume|status|task|ship|doctor|uninstall";

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const data = dataDir();
  switch (cmd) {
    case "start":
      return start(data);
    case "stop":
    case "pause":
    case "resume":
    case "status":
    case "task":
      return control(data, cmd);
    case "doctor":
      return doctor(data);
    case "ship":
      return shipNow(data);
    case "uninstall":
      return uninstallCmd(data, argv.slice(1));
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
