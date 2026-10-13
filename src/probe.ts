/**
 * Client for the probe helper (helpers/mac/probe, helpers/win/probe.ps1): a long-lived child,
 * one JSON request per line on stdin, one answer per line on stdout, matched by id. An answer
 * that misses its timeout resolves `null` and is dropped by id when it shows up late. A crashed
 * helper restarts with backoff; a missing helper makes every call `null` at once.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { App, Element, WindowInfo } from "./events.ts";

export interface AtAnswer {
  element: Element | null;
}
export interface FrontAnswer {
  app: App | null;
  window: WindowInfo | null;
}
export interface FocusedAnswer {
  element: Element | null;
}
export interface PermAnswer {
  accessibility: boolean;
  screen: boolean;
  input: boolean;
}

/** What the client needs of a child process; tests pass a fake. */
export interface ProbeChild {
  stdin: Writable;
  stdout: Readable;
  once(event: "exit" | "error", fn: (err?: unknown) => void): unknown;
  kill(): unknown;
}

export interface ProbeOptions {
  /** Starts the helper; `null` when it is missing. */
  spawn: (() => ProbeChild) | null;
  timeoutMs?: number;
  restartMs?: number;
  maxRestartMs?: number;
  log?: (msg: string) => void;
}

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The helper for this OS, or null when it is not there. */
export function helperCommand(
  platform: NodeJS.Platform = process.platform,
  root = PACKAGE_ROOT,
): { cmd: string; args: string[]; path: string } | null {
  if (platform === "darwin") {
    const path = join(root, "helpers", "mac", "probe");
    return existsSync(path) ? { cmd: path, args: [], path } : null;
  }
  if (platform === "win32") {
    const path = join(root, "helpers", "win", "probe.ps1");
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path];
    return existsSync(path) ? { cmd: "powershell.exe", args, path } : null;
  }
  return null;
}

export function spawnHelper(cmd: { cmd: string; args: string[] }): () => ProbeChild {
  return () =>
    spawn(cmd.cmd, cmd.args, {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    }) as ProbeChild;
}

type Pending = { resolve: (v: unknown) => void; timer: NodeJS.Timeout };

export class Probe {
  readonly available: boolean;
  private child: ProbeChild | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private closed = false;
  private restartMs: number;
  private restartTimer: NodeJS.Timeout | null = null;
  private startedAt = 0;

  private readonly opts: ProbeOptions;

  constructor(opts: ProbeOptions) {
    this.opts = opts;
    this.available = opts.spawn !== null;
    this.restartMs = opts.restartMs ?? 1000;
    if (this.available) this.start();
  }

  /** True while a helper process is up. */
  get running(): boolean {
    return this.child !== null;
  }

  at(x: number, y: number): Promise<AtAnswer | null> {
    return this.call("at", { x: Math.round(x), y: Math.round(y) });
  }
  front(): Promise<FrontAnswer | null> {
    return this.call("front");
  }
  focused(): Promise<FocusedAnswer | null> {
    return this.call("focused");
  }
  perm(timeoutMs = 2000): Promise<PermAnswer | null> {
    return this.call("perm", {}, timeoutMs);
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
    let child: ProbeChild;
    try {
      child = make();
    } catch (e) {
      this.opts.log?.(`probe: spawn failed: ${(e as Error).message}`);
      this.scheduleRestart();
      return;
    }
    this.child = child;
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
      this.opts.log?.("probe: helper exited, restarting");
      // A helper that stayed up a while gets a fresh backoff.
      if (Date.now() - this.startedAt > 60_000) this.restartMs = this.opts.restartMs ?? 1000;
      this.scheduleRestart();
    };
    child.once("exit", dead);
    child.once("error", (err?: unknown) => {
      this.opts.log?.(`probe: ${(err as Error | undefined)?.message ?? "error"}`);
      dead();
    });
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
      let msg: { id?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id === "number") this.settle(msg.id, msg);
    }
  }
}

/** The probe for this OS, or one that answers null when the helper is missing. */
export function openProbe(log?: (msg: string) => void): Probe {
  const cmd = helperCommand();
  return new Probe({ spawn: cmd ? spawnHelper(cmd) : null, ...(log ? { log } : {}) });
}
