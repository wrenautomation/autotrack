/**
 * Process control. A pid file in the data dir makes a second `start` refuse. The running
 * recorder listens on a local socket (unix socket on Mac, named pipe on Windows): JSON lines in,
 * one JSON reply line per line out, as many as the client sends on one connection.
 *
 *   {"op":"stop"|"pause"|"resume"|"status"|"task"}   (the CLI; `cmd` works as `op`; `task`
 *   opens the task prompt, as Ctrl+Alt+Shift+T does)
 *   {"op":"web","event":{"kind":"web"|"app",...}}   (the browser extension's native host)
 *
 * Replies: {"ok":true,"result":...} or {"ok":false,"error":"..."}. A line over 256 KB is refused
 * and the connection closed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir } from "./config.ts";

export type Command = "stop" | "pause" | "resume" | "status" | "task" | "update";
export type Request = { op: Command } | { op: "web"; event: unknown };

export const MAX_LINE = 256 * 1024;
const COMMANDS: string[] = ["stop", "pause", "resume", "status", "task", "update"];

/**
 * The socket or pipe for a data dir. Mac: `<data>/control.sock` (a tmpdir path when that is too
 * long). Windows: `\\.\pipe\autotrack-<first 12 hex of sha256(data)>`.
 */
export function controlPath(data: string, platform: NodeJS.Platform = process.platform): string {
  const tag = createHash("sha256").update(data).digest("hex").slice(0, 12);
  if (platform === "win32") return `\\\\.\\pipe\\autotrack-${tag}`;
  const path = join(data, "control.sock");
  // Unix socket paths cap near 104 bytes on Mac.
  return Buffer.byteLength(path) < 100 ? path : join(tmpdir(), `autotrack-${tag}.sock`);
}

/** The running recorder's socket or pipe for this user: what the native host connects to. */
export function recorderPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return controlPath(dataDir(env, platform), platform);
}

/** Parse one line into a request, or throw why not. */
export function parseRequest(line: string): Request {
  const o = JSON.parse(line) as { op?: unknown; cmd?: unknown; event?: unknown };
  const op = o.op ?? o.cmd;
  if (op === "web") return { op, event: o.event };
  if (typeof op === "string" && COMMANDS.includes(op)) return { op: op as Command };
  throw new Error(`unknown op: ${String(op)}`);
}

const pidPath = (data: string) => join(data, "track.pid");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid of a running recorder for this data dir, or null. */
export function runningPid(data: string): number | null {
  try {
    const pid = Number(readFileSync(pidPath(data), "utf8").trim());
    return pid > 0 && pid !== process.pid && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Take the lock, or return the pid that holds it. A stale pid file (dead process) is replaced. */
export function lock(data: string): { ok: true; release(): void } | { ok: false; pid: number } {
  const path = pidPath(data);
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return {
        ok: true,
        release() {
          try {
            if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
          } catch {}
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = runningPid(data);
      if (pid) return { ok: false, pid };
      try {
        unlinkSync(path);
      } catch {}
    }
  }
  return { ok: false, pid: Number(readFileSync(path, "utf8").trim()) || 0 };
}

export async function serve(
  data: string,
  handle: (req: Request) => Promise<unknown>,
): Promise<Server> {
  const path = controlPath(data);
  if (process.platform !== "win32" && existsSync(path)) unlinkSync(path); // ours: we hold the lock
  const server = createServer((sock) => {
    let buf = "";
    let turn: Promise<void> = Promise.resolve(); // replies in line order
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (Buffer.byteLength(line) > MAX_LINE) return refuse(sock);
        if (!line.trim()) continue;
        turn = turn.then(async () => {
          let reply: unknown;
          try {
            reply = { ok: true, result: await handle(parseRequest(line)) };
          } catch (e) {
            reply = { ok: false, error: (e as Error).message };
          }
          if (!sock.destroyed) sock.write(`${JSON.stringify(reply)}\n`);
        });
      }
      if (Buffer.byteLength(buf) > MAX_LINE) refuse(sock);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();
  return server;
}

function refuse(sock: Socket): void {
  sock.removeAllListeners("data");
  sock.end(`${JSON.stringify({ ok: false, error: `line over ${MAX_LINE} bytes` })}\n`);
}

/** Ask the running recorder; null when none answers. */
export function send(data: string, cmd: Command, timeoutMs = 3000): Promise<unknown | null> {
  return new Promise((resolve) => {
    const sock = createConnection(controlPath(data));
    let buf = "";
    const done = (v: unknown | null) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify({ op: cmd })}\n`));
    sock.on("data", (c: string) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const r = JSON.parse(buf.slice(0, nl)) as { ok: boolean; result?: unknown; error?: string };
        done(r.ok ? r.result : { error: r.error });
      } catch {
        done(null);
      }
    });
    sock.on("error", () => done(null));
  });
}
