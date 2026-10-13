/**
 * Client for a native helper child (helpers/mac/probe, helpers/win/probe.ps1): a long-lived
 * process, one JSON request per line on stdin, one answer per line on stdout, matched by id. An
 * answer that misses its timeout resolves `null` and is dropped by id when it shows up late. A
 * line with `event` and no id is something the helper saw by itself (a clipboard change) and goes
 * to `onEvent`. A crashed helper restarts with backoff (`onStart` runs after each start, so a
 * watch can be asked for again); a missing helper makes every call `null` at once. The probe and
 * the shots client are two children of the same helper, built on this.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

/** What the client needs of a child process; tests pass a fake. */
export interface HelperChild {
  stdin: Writable;
  stdout: Readable;
  once(event: "exit" | "error", fn: (err?: unknown) => void): unknown;
  kill(): unknown;
}

export interface HelperOptions {
  /** Starts the helper; `null` when it is missing. */
  spawn: (() => HelperChild) | null;
  /** Default answer deadline for `call`. */
  timeoutMs?: number;
  restartMs?: number;
  maxRestartMs?: number;
  /** Prefix for log lines. */
  name?: string;
  log?: (msg: string) => void;
}

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The helper for this OS (`--shots` mode when asked), or null when it is not there. */
export function helperCommand(
  platform: NodeJS.Platform = process.platform,
  root = PACKAGE_ROOT,
  mode: "probe" | "shots" = "probe",
): { cmd: string; args: string[]; path: string } | null {
  const extra = mode === "shots" ? ["--shots"] : [];
  if (platform === "darwin") {
    const path = join(root, "helpers", "mac", "probe");
    return existsSync(path) ? { cmd: path, args: extra, path } : null;
  }
  if (platform === "win32") {
    const path = join(root, "helpers", "win", "probe.ps1");
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path];
    return existsSync(path) ? { cmd: "powershell.exe", args: [...args, ...extra], path } : null;
  }
  return null;
}

export function spawnHelper(cmd: { cmd: string; args: string[] }): () => HelperChild {
  return () =>
    spawn(cmd.cmd, cmd.args, {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    }) as HelperChild;
}

type Pending = { resolve: (v: unknown) => void; timer: NodeJS.Timeout };

export class HelperClient {
  readonly available: boolean;
  /** How many times the child has been started: answers from an earlier start are stale. */
  starts = 0;
  /** Lines the helper pushed by itself: `{event: "<name>", …}`. */
  onEvent: ((msg: Record<string, unknown> & { event: string }) => void) | null = null;
  /** After every start, the first one included when set in time. */
  onStart: (() => void) | null = null;
  private child: HelperChild | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private closed = false;
  private restartMs: number;
  private restartTimer: NodeJS.Timeout | null = null;
  private startedAt = 0;

  private readonly opts: HelperOptions;

  constructor(opts: HelperOptions) {
    this.opts = opts;
    this.available = opts.spawn !== null;
    this.restartMs = opts.restartMs ?? 1000;
    if (this.available) this.start();
  }

  /** True while a helper process is up. */
  get running(): boolean {
    return this.child !== null;
  }

  call<T>(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T | null> {
    const child = this.child;
    if (!child || this.closed) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise<T | null>((resolve) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          resolve(null);
        },
        timeoutMs ?? this.opts.timeoutMs ?? 50,
      );
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
      } catch {
        this.settle(id, null);
      }
    });
  }

  close(): void {
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    for (const id of [...this.pending.keys()]) this.settle(id, null);
    this.child?.kill();
    this.child = null;
  }

  private settle(id: number, value: unknown): void {
    const p = this.pending.get(id);
    if (!p) return; // timed out already: a late answer is dropped
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(value);
  }

  private start(): void {
    const make = this.opts.spawn;
    if (!make || this.closed) return;
    const name = this.opts.name ?? "helper";
    let child: HelperChild;
    try {
      child = make();
    } catch (e) {
      this.opts.log?.(`${name}: spawn failed: ${(e as Error).message}`);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.starts++;
    this.buf = "";
    this.startedAt = Date.now();
    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => this.onData(String(chunk)));
    child.stdin.on("error", () => {});
    const dead = () => {
      if (this.child !== child) return;
      this.child = null;
      for (const id of [...this.pending.keys()]) this.settle(id, null);
      if (this.closed) return;
      this.opts.log?.(`${name}: helper exited, restarting`);
      // A helper that stayed up a while gets a fresh backoff.
      if (Date.now() - this.startedAt > 60_000) this.restartMs = this.opts.restartMs ?? 1000;
      this.scheduleRestart();
    };
    child.once("exit", dead);
    child.once("error", (err?: unknown) => {
      this.opts.log?.(`${name}: ${(err as Error | undefined)?.message ?? "error"}`);
      dead();
    });
    this.onStart?.();
  }

  private scheduleRestart(): void {
    if (this.closed) return;
    const wait = this.restartMs;
    this.restartMs = Math.min(wait * 2, this.opts.maxRestartMs ?? 30_000);
    this.restartTimer = setTimeout(() => this.start(), wait);
    this.restartTimer.unref?.();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf("\n");
      if (!line) continue;
      let msg: { id?: unknown; event?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id === "number") this.settle(msg.id, msg);
      else if (typeof msg.event === "string" && this.onEvent) {
        try {
          this.onEvent(msg as Record<string, unknown> & { event: string });
        } catch (e) {
          this.opts.log?.(`${this.opts.name ?? "helper"}: ${msg.event}: ${(e as Error).message}`);
        }
      }
    }
  }
}
