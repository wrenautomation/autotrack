/**
 * Client for the probe helper (helpers/mac/probe, helpers/win/probe.ps1): what app and window is
 * in front, what element is at a point or has focus, which permissions are granted. Each answer
 * has 50 ms; a miss is `null`. The child machinery is in `helper.ts`.
 */

import type { App, Element, WindowInfo } from "./events.ts";
import { type HelperChild, HelperClient, helperCommand, spawnHelper } from "./helper.ts";

export { helperCommand, PACKAGE_ROOT, spawnHelper } from "./helper.ts";

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
export type ProbeChild = HelperChild;

export interface ProbeOptions {
  /** Starts the helper; `null` when it is missing. */
  spawn: (() => ProbeChild) | null;
  timeoutMs?: number;
  restartMs?: number;
  maxRestartMs?: number;
  log?: (msg: string) => void;
}

export class Probe extends HelperClient {
  constructor(opts: ProbeOptions) {
    super({ ...opts, name: "probe" });
  }

  /** With `timeoutMs`, the helper also waits on a slow app that long (`wait`). */
  at(x: number, y: number, timeoutMs?: number): Promise<AtAnswer | null> {
    const p = { x: Math.round(x), y: Math.round(y), ...(timeoutMs ? { wait: timeoutMs } : {}) };
    return this.call("at", p, timeoutMs);
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
}

/** The probe for this OS, or one that answers null when the helper is missing. */
export function openProbe(log?: (msg: string) => void): Probe {
  const cmd = helperCommand();
  return new Probe({ spawn: cmd ? spawnHelper(cmd) : null, ...(log ? { log } : {}) });
}
