/**
 * Client for the probe helper (helpers/mac/probe, helpers/win/autotrack-helper.exe): what app and window is
 * in front (and whether it is a dialog), what element is at a point or has focus, which
 * permissions are granted. Each answer has 50 ms; a miss is `null`. `tree` walks the front
 * window on the helper's own worker and has seconds. Clipboard changes come unasked once watched.
 * The child machinery is in `helper.ts`.
 */

import type { App, Element, WindowInfo } from "./events.ts";
import { type HelperChild, HelperClient, helperCommand, spawnHelper } from "./helper.ts";

export { helperCommand, PACKAGE_ROOT, spawnHelper } from "./helper.ts";

export interface AtAnswer {
  element: Element | null;
}
export interface DialogInfo {
  title: string;
  text: string;
  buttons: string[];
}
export interface FrontAnswer {
  app: App | null;
  window: WindowInfo | null;
  /** How many windows the front app has open. */
  windows?: number;
  /** Set when the front window is an alert, sheet or modal dialog. */
  dialog?: DialogInfo | null;
}
export interface FocusedAnswer {
  element: Element | null;
}
export interface PermAnswer {
  accessibility: boolean;
  screen: boolean;
  input: boolean;
  /** Linux: `x11`, `wayland`, … */
  session?: string;
  /** Linux: the AT-SPI bus answered. */
  atspi?: boolean;
  /** Linux: the X server has XRecord (uiohook's input source). */
  record?: boolean;
}

/** One node of the front window's tree: never a value; `secure` marks a password field. */
export interface TreeNode {
  role: string;
  name: string;
  id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  secure?: boolean;
}
export interface TreeAnswer {
  nodes: TreeNode[];
  /** A cap (nodes, depth, time) cut the walk short. */
  truncated: boolean;
  /** How long the walk took in the helper. */
  ms: number;
}

/** A clipboard change, pushed by the helper (`{"event":"clipboard",…}`). */
export interface ClipboardChange {
  types: string[];
  /** Characters of text on the clipboard; 0 when there is none. */
  length: number;
  /** The first 4,096 characters; absent when concealed or there is no text. */
  text?: string;
  /** The copying app marked it concealed or transient (password managers). */
  concealed: boolean;
  /** Secure input was on when it changed (Mac: a password field had focus). */
  secure?: boolean;
}

export const TREE_NODES = 1500;
export const TREE_DEPTH = 25;
export const TREE_BUDGET_MS = 750;

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

  /**
   * `waitMs`: the helper also waits on a slow app that long (Mac AX timeout). `down`: the act
   * started with a press or a scroll tick here; Windows answers what it read at that moment.
   */
  at(
    x: number,
    y: number,
    timeoutMs?: number,
    waitMs?: number,
    down = false,
  ): Promise<AtAnswer | null> {
    const p = {
      x: Math.round(x),
      y: Math.round(y),
      ...(waitMs ? { wait: waitMs } : {}),
      ...(down ? { down: true } : {}),
    };
    return this.call("at", p, timeoutMs);
  }
  front(): Promise<FrontAnswer | null> {
    return this.call("front");
  }
  focused(timeoutMs?: number): Promise<FocusedAnswer | null> {
    return this.call("focused", {}, timeoutMs);
  }
  perm(timeoutMs = 2000): Promise<PermAnswer | null> {
    return this.call("perm", {}, timeoutMs);
  }
  /** Windows: `GetSystemPowerStatus` as `{ac, battery}` (null when unknown). Linux: sysfs. */
  power(timeoutMs = 2000): Promise<{ ac: boolean | null; battery: number | null } | null> {
    return this.call("power", {}, timeoutMs);
  }
  tree(timeoutMs = 3000): Promise<TreeAnswer | null> {
    return this.call(
      "tree",
      { max: TREE_NODES, depth: TREE_DEPTH, budgetMs: TREE_BUDGET_MS },
      timeoutMs,
    );
  }

  /** Clipboard changes from now on, asked for again after every helper restart. */
  watchClipboard(fn: (c: ClipboardChange) => void): void {
    this.onEvent = (msg) => {
      if (msg.event === "clipboard") fn(clipboardOf(msg));
    };
    this.onStart = () => void this.call("watch", { clipboard: true }, 5000);
    if (this.running) this.onStart();
  }
}

/** A pushed clipboard line as a `ClipboardChange`; anything malformed reads as empty. */
export function clipboardOf(m: Record<string, unknown>): ClipboardChange {
  const types = Array.isArray(m.types) ? m.types.filter((t) => typeof t === "string") : [];
  return {
    types: types.slice(0, 20) as string[],
    length: typeof m.length === "number" && m.length >= 0 ? m.length : 0,
    ...(typeof m.text === "string" ? { text: m.text } : {}),
    concealed: m.concealed === true,
    ...(m.secure === true ? { secure: true } : {}),
  };
}

/** The probe for this OS, or one that answers null when the helper is missing. */
export function openProbe(log?: (msg: string) => void): Probe {
  const cmd = helperCommand();
  return new Probe({ spawn: cmd ? spawnHelper(cmd) : null, ...(log ? { log } : {}) });
}
