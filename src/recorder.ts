/**
 * The recorder: hook → folder → context (probe, frames) → privacy → journal, plus the timers
 * (fold ticks, frame ring, front-app poll, idle frames, segment close, ship) and pause state.
 * Signal rides along: each act's outcome (`out`) and latest tree, accessibility trees on focus
 * and after a screen change, dialogs, clipboard changes, and the task marker's prompt.
 * Every dependency comes in, so tests drive it with fakes and a hand-run clock.
 */

import { createHash } from "node:crypto";
import type { Config } from "./config.ts";
import { type Coords, identity, logicalElement, logicalWindow } from "./coords.ts";
import {
  type App,
  type Begin,
  type Event,
  type Folded,
  Folder,
  type Out,
  type PauseReason,
  type Raw,
  type SessionMeta,
  type WindowInfo,
} from "./events.ts";
import { Journal } from "./journal.ts";
import {
  clipboardText,
  type Gate,
  blocked as gateOf,
  holdForFocus,
  makeGate,
  redactSecrets,
  textOf,
} from "./privacy.ts";
import type {
  AtAnswer,
  ClipboardChange,
  DialogInfo,
  FocusedAnswer,
  FrontAnswer,
  PermAnswer,
  TreeAnswer,
} from "./probe.ts";
import { type Capturer, differs, type Frame, Screen } from "./screen.ts";
import type { Shipper } from "./ship.ts";

export const FOLD_TICK_MS = 100;
export const RING_TICK_MS = 500;
export const FRONT_POLL_MS = 1000;
export const IDLE_TICK_MS = 2000;
export const SEGMENT_TICK_MS = 30_000;
export const SHIP_MS = 5 * 60_000;
/** A point act whose element did not answer in 50 ms asks once more with this long. */
export const AT_RETRY_MS = 1000;
/** Trees: at most one a second. */
export const TREE_MIN_MS = 1000;
/** An incoming `tree` string over this many bytes is stored as `trees/<n>.txt`. */
export const TREE_INLINE_BYTES = 2048;
/** How long a clipboard change waits for the focused element (secure or not). */
export const CLIPBOARD_FOCUS_MS = 500;
export const TASK_QUESTION = "What are you doing?";
export const TASK_GOAL_MAX = 500;

/** The probe surface the recorder uses (the real `Probe`, or a fake). */
export interface ProbeLike {
  readonly available: boolean;
  readonly running: boolean;
  at(x: number, y: number, timeoutMs?: number): Promise<AtAnswer | null>;
  front(): Promise<FrontAnswer | null>;
  focused(timeoutMs?: number): Promise<FocusedAnswer | null>;
  perm(timeoutMs?: number): Promise<PermAnswer | null>;
  tree?(): Promise<TreeAnswer | null>;
  watchClipboard?(fn: (c: ClipboardChange) => void): void;
  close(): void;
}

export interface RecorderDeps {
  sessions: string;
  config: Config;
  meta: Omit<SessionMeta, "v" | "session" | "startedAt" | "endedAt" | "displays" | "device">;
  probe: ProbeLike;
  capturer: Capturer;
  /** Starts the input hook; returns its stop. */
  hook: (onRaw: (r: Raw) => void) => () => void;
  coords?: () => Coords;
  displayAt?: (x: number, y: number) => string | undefined;
  /** Front app when the probe has no answer (helper missing). */
  frontFallback?: () => FrontAnswer | null;
  notify?: (msg: string) => void;
  /** The task marker's one-line prompt: the answer, or null when cancelled. */
  ask?: (question: string) => Promise<string | null>;
  shipper?: Shipper;
  /** Monotonic ms; epoch ms. */
  clock?: { now(): number; epoch(): number };
  /** false: no intervals; tests call the tick methods themselves. */
  timers?: boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

interface Ctx {
  before: Promise<Frame | null>;
  front: Promise<FrontAnswer | null>;
  target: Promise<AtAnswer | FocusedAnswer | null>;
  /** The act's point in the probe's coordinates, for asking again. */
  at?: { x: number; y: number };
  /** The latest tree written when the act began. */
  tree: number | null;
}

export interface Status {
  pid: number;
  session: string;
  dir: string;
  segment: string;
  events: number;
  frames: number;
  trees: number;
  paused: PauseReason | null;
  probe: "running" | "down" | "missing";
  startedAt: string;
  uptimeS: number;
  cpuUs: number; // process user + system CPU since start, µs
  rssMb: number;
}

/** Ctrl+Alt+Shift+<key>. */
const hotkey = (r: Raw, key: string) =>
  r.type === "keydown" &&
  r.key === key &&
  r.mods.length === 3 &&
  ["ctrl", "alt", "shift"].every((m) => r.mods.includes(m as "ctrl"));

const sameFront = (a: FrontAnswer | null, b: FrontAnswer | null) =>
  a?.app?.pid === b?.app?.pid && a?.app?.id === b?.app?.id && a?.window?.title === b?.window?.title;

const dialogKey = (d: DialogInfo | null | undefined) =>
  d ? JSON.stringify([d.title, d.text, d.buttons]) : null;

/**
 * What an act did, from the front app before it and after its after-frame, and the two frame
 * hashes. Unknown (no answer, no frame) reads as false.
 */
export function outOf(
  a: FrontAnswer | null,
  b: FrontAnswer | null,
  hashBefore: string | null,
  hashAfter: string | null,
): Out {
  return {
    screen: hashBefore !== null && hashAfter !== null && differs(hashBefore, hashAfter),
    focus: !!a?.app && !!b?.app && !sameFront(a, b),
    dialog: !!b?.dialog && dialogKey(b.dialog) !== dialogKey(a?.dialog),
    window:
      !!a?.app &&
      !!b?.app &&
      a.app.pid === b.app.pid &&
      typeof a.windows === "number" &&
      typeof b.windows === "number" &&
      a.windows !== b.windows,
  };
}

const clip = (s: string, n: number) => redactSecrets(s).text.slice(0, n);

export class Recorder {
  readonly journal: Journal;
  private readonly screen: Screen;
  private readonly folder: Folder<Ctx>;
  private readonly gate: Gate;
  private readonly clock: { now(): number; epoch(): number };
  private readonly epoch0: number;
  private readonly t0: number;
  private readonly coords: () => Coords;
  private userPaused: "hotkey" | "cli" | null = null;
  private gated: "excluded" | "locked" | null = null;
  private written: PauseReason | null = null; // the pause reason last written
  private lastFront: FrontAnswer | null = null;
  private lastDialog: string | null = null;
  private lastTree: number | null = null;
  private lastTreeHash: string | null = null;
  private treeWanted = false;
  private treeBusy = false;
  private treeAt = Number.NEGATIVE_INFINITY;
  private prompting = false;
  private lastRaw = Number.NEGATIVE_INFINITY;
  private chain: Promise<void> = Promise.resolve();
  private deferred: { t: number; fn: () => void }[] = [];
  private stopHook: (() => void) | null = null;
  private timers: NodeJS.Timeout[] = [];
  private shipping = false;
  private stopped = false;

  private readonly d: RecorderDeps;

  constructor(d: RecorderDeps) {
    this.d = d;
    this.clock = d.clock ?? { now: () => performance.now(), epoch: () => Date.now() };
    this.coords = d.coords ?? (() => identity);
    this.gate = makeGate(d.config);
    this.t0 = this.clock.now();
    this.epoch0 = this.clock.epoch();
    this.journal = new Journal({
      sessions: d.sessions,
      meta: { ...d.meta, device: d.config.device, displays: safe(() => d.capturer.displays(), []) },
      now: () => this.clock.epoch(),
    });
    this.screen = new Screen({
      capturer: d.capturer,
      frames: this.journal,
      now: () => this.clock.now(),
      blocked: () => this.paused !== null,
      mayWrite: async () => gateOf(this.gate, ...frontParts(await this.front())) === null,
      ...(d.log ? { log: d.log } : {}),
    });
    this.folder = new Folder<Ctx>(
      (b, t) => this.begin(b, t),
      (a) => this.onAct(a),
    );
  }

  get paused(): PauseReason | null {
    return this.userPaused ?? this.gated;
  }

  start(): void {
    this.stopHook = this.d.hook((r) => this.onRaw(r));
    this.d.probe.watchClipboard?.((c) => this.onClipboard(c));
    if (this.d.timers !== false) {
      const every = (ms: number, fn: () => unknown) => {
        const h = setInterval(() => {
          try {
            const p = fn();
            if (p instanceof Promise) p.catch((e) => this.d.log?.(`tick: ${e.message}`));
          } catch (e) {
            this.d.log?.(`tick: ${(e as Error).message}`);
          }
        }, ms);
        this.timers.push(h);
      };
      every(FOLD_TICK_MS, () => this.foldTick());
      every(RING_TICK_MS, () => this.screen.ringTick());
      every(FRONT_POLL_MS, () => this.frontTick());
      every(IDLE_TICK_MS, () => this.idleTick());
      every(SEGMENT_TICK_MS, () => this.journal.tick());
      every(SHIP_MS, () => this.shipTick());
    }
    this.d.notify?.("Tracking on");
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const h of this.timers) clearInterval(h);
    this.stopHook?.();
    this.folder.flush();
    this.release(Number.POSITIVE_INFINITY);
    await this.settled();
    this.journal.close();
    this.d.probe.close();
    this.d.capturer.close?.();
  }

  pause(reason: "hotkey" | "cli"): void {
    if (this.userPaused) return;
    this.folder.flush();
    this.userPaused = reason;
    this.sync();
    this.d.notify?.("Tracking paused");
  }

  resume(): void {
    if (!this.userPaused) return;
    this.userPaused = null;
    this.sync();
    this.d.notify?.("Tracking on");
  }

  status(): Status {
    const cpu = process.cpuUsage();
    return {
      pid: process.pid,
      session: this.journal.session,
      dir: this.journal.dir,
      segment: this.journal.segment,
      events: this.journal.events,
      frames: this.journal.frames,
      trees: this.journal.trees,
      paused: this.paused,
      probe: !this.d.probe.available ? "missing" : this.d.probe.running ? "running" : "down",
      startedAt: new Date(this.epoch0).toISOString(),
      uptimeS: Math.round((this.clock.now() - this.t0) / 1000),
      cpuUs: cpu.user + cpu.system,
      rssMb: Math.round(process.memoryUsage().rss / 1e6),
    };
  }

  /**
   * A `web` or `app` event from the browser extension (via its native host), written as is:
   * t / ts filled in when missing, nothing while paused or an excluded app is in front. A `tree`
   * string over 2 KB (a `snapshot`) is stored as `trees/<n>.txt` and named by `treeFile: n`.
   */
  external(event: unknown): { written: boolean; reason?: string } {
    if (!event || typeof event !== "object" || Array.isArray(event))
      throw new Error("event must be an object");
    const e = event as Record<string, unknown>;
    if (e.kind !== "web" && e.kind !== "app") throw new Error("kind must be web or app");
    if (this.stopped) return { written: false, reason: "stopped" };
    if (this.paused) return { written: false, reason: this.paused };
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const ts0 = num(e.ts);
    const t0 = num(e.t);
    const t = t0 ?? (ts0 !== undefined ? Math.round(ts0 - this.epoch0) : this.t(this.clock.now()));
    const out = { ...e, t, ts: ts0 ?? this.ts(t) } as unknown as Event;
    const tree = e.tree;
    if (typeof tree === "string" && Buffer.byteLength(tree) > TREE_INLINE_BYTES) {
      const { tree: _t, ...rest } = out as Event & { tree?: string };
      this.enqueue(async () => {
        this.journal.writeTree(tree, "txt", (n) => ({ ...rest, treeFile: n }) as Event);
      });
      return { written: true };
    }
    this.enqueue(async () => this.write(out)); // after anything already queued, before a pause
    return { written: true };
  }

  /** All writes so far are on disk, including any a write queued while it ran. */
  async settled(): Promise<void> {
    let c: Promise<void> | null = null;
    while (c !== this.chain) {
      c = this.chain;
      await c;
    }
  }

  onRaw(r: Raw): void {
    if (this.stopped) return;
    if (hotkey(r, "p")) {
      if (this.userPaused) this.resume();
      else this.pause("hotkey");
      return;
    }
    if (hotkey(r, "t")) {
      void this.task();
      return;
    }
    if (this.prompting) return; // the answer typed into the prompt is not input
    this.lastRaw = this.clock.now();
    if (this.paused) return;
    this.screen.input(...(r.type === "keydown" ? [] : ([r.x, r.y] as const)));
    this.folder.push({ ...r, t: this.t(r.t) } as Raw);
  }

  foldTick(): void {
    this.folder.tick(this.t(this.clock.now()));
    this.release(this.folder.pendingSince);
    if (this.treeWanted)
      this.treeTick().catch((e) => this.d.log?.(`tree: ${(e as Error).message}`));
  }

  /** The front app, polled while someone is active or an exclusion holds: pauses and focus. */
  async frontTick(): Promise<void> {
    const active = this.clock.now() - this.lastRaw < 5000;
    if (this.userPaused || this.prompting || (!active && !this.gated)) return;
    const front = await this.front();
    const t = this.t(this.clock.now());
    this.side(t, () =>
      this.enqueue(async () => {
        if (front) this.applyFront(front, t);
      }),
    );
  }

  async idleTick(): Promise<void> {
    if (this.paused) return;
    const t = this.t(this.clock.now());
    const n = this.screen.idle(); // its place in the chain is now, so events stay in order
    this.enqueue(async () => {
      const frame = await n;
      if (frame !== null) this.write({ kind: "frame", frame, t, ts: this.ts(t) });
    });
    await n;
  }

  /**
   * Capture the front window's tree when one is wanted (a focus change, an act that moved the
   * screen), at most once a second, one at a time. Its event's t is when it was asked for; the
   * same tree twice is written once.
   */
  async treeTick(): Promise<void> {
    const probe = this.d.probe;
    if (!this.treeWanted || this.treeBusy || this.stopped || !probe.tree) return;
    if (this.paused) {
      this.treeWanted = false;
      return;
    }
    const now = this.clock.now();
    if (now - this.treeAt < TREE_MIN_MS) return;
    this.treeWanted = false;
    this.treeBusy = true;
    this.treeAt = now;
    const t = this.t(now);
    let f: FrontAnswer | null;
    let a: TreeAnswer | null;
    try {
      [f, a] = await Promise.all([this.front(), probe.tree()]);
    } finally {
      this.treeBusy = false;
    }
    if (!a || !Array.isArray(a.nodes)) return;
    const tree = a;
    const front = f ?? this.lastFront;
    this.side(t, () =>
      this.enqueue(async () => {
        if (this.paused || gateOf(this.gate, ...frontParts(front)) !== null) return;
        this.writeTree(tree, front, t);
      }),
    );
  }

  async shipTick(): Promise<void> {
    if (this.shipping || !this.d.shipper) return;
    this.shipping = true;
    try {
      await this.d.shipper.ship(this.d.sessions);
    } finally {
      this.shipping = false;
    }
  }

  private t(now: number): number {
    return Math.round(now - this.t0);
  }
  private ts(t: number): number {
    return Math.round(this.epoch0 + t);
  }

  private async front(): Promise<FrontAnswer | null> {
    const a = await this.d.probe.front();
    if (a?.app) return a;
    return this.d.frontFallback ? safe(this.d.frontFallback, null) : a;
  }

  private begin(b: Begin, _t: number): Ctx {
    const c = this.coords();
    let target: Promise<AtAnswer | FocusedAnswer | null>;
    let at: { x: number; y: number } | undefined;
    if (b.on === "point") {
      at = c.toPhysical(b.x, b.y);
      target = this.d.probe.at(at.x, at.y);
    } else target = this.d.probe.focused();
    return {
      before: this.screen.before(),
      front: this.front(),
      target,
      ...(at ? { at } : {}),
      tree: this.lastTree,
    };
  }

  private onAct(a: Folded<Ctx>): void {
    this.release(a.t);
    if (a.kind === "move") {
      const { end: _e, ctx: _c, ...move } = a;
      const display = this.d.displayAt?.(a.x, a.y);
      this.enqueue(async () => {
        if (!this.gated) this.write({ ...move, ts: this.ts(a.t), ...(display ? { display } : {}) });
      });
      return;
    }
    const prepared = this.prepare(a);
    this.enqueue(async () => {
      const p = await prepared;
      if (p.front) this.applyFront(p.front, a.t);
      if (!p.event) return;
      this.write(p.event);
      if ((p.event as { out?: Out }).out?.screen) this.wantTree();
      const later = p.later;
      if (later)
        this.side(later.t, () => this.enqueue(async () => this.applyFront(later.front, later.t)));
    });
  }

  /**
   * Resolve an act's context. `event` is null when it must not be recorded (an excluded app or
   * the lock screen was in front); `front` is still applied, in order, so the pause lands.
   */
  private async prepare(a: Folded<Ctx>): Promise<{
    event: Event | null;
    front: FrontAnswer | null;
    later?: { front: FrontAnswer; t: number } | null;
  }> {
    const ctx = a.ctx as Ctx;
    const front = (await ctx.front) ?? this.lastFront; // no answer in 50 ms: the last one known
    if (gateOf(this.gate, ...frontParts(front)) !== null) return { event: null, front };
    const c = this.coords();
    let target = await ctx.target;
    // The first ask into an app the probe has not talked to yet can miss 50 ms: once more, longer.
    if (target === null && ctx.at && this.d.probe.running)
      target = await this.d.probe.at(ctx.at.x, ctx.at.y, AT_RETRY_MS);
    let text: { text: string; redacted: boolean } | null = null;
    if (a.kind === "text") {
      if (target === null && this.d.probe.available)
        target = await holdForFocus(target, () => this.d.probe.focused(), {
          ...(this.d.sleep ? { sleep: this.d.sleep } : {}),
        });
      text = textOf(a.text, target);
    }
    const beforeFrame = await ctx.before;
    const before = await this.screen.number(beforeFrame);
    const shot = await this.screen.afterFrame(this.d.sleep);
    const after = shot.n;
    const laterFront = await this.front();
    const later = laterFront?.app ? { front: laterFront, t: this.t(this.clock.now()) } : null;
    const out = outOf(front, laterFront, beforeFrame?.shot.hash ?? null, shot.hash);
    const { end: _e, ctx: _c, ...act } = a;
    const element = logicalElement(c, target?.element);
    const app = front?.app ?? undefined;
    const window = logicalWindow(c, front?.window);
    const display =
      beforeFrame?.shot.display ?? ("x" in act ? this.d.displayAt?.(act.x, act.y) : undefined);
    const event = {
      ...act,
      ...(text ?? {}),
      ts: this.ts(a.t),
      ...(app ? { app } : {}),
      ...(window ? { window } : {}),
      ...(display ? { display } : {}),
      ...(element ? { element } : {}),
      ...(before !== null ? { before } : {}),
      ...(after !== null ? { after } : {}),
      out,
      ...(ctx.tree !== null ? { tree: ctx.tree } : {}),
    } as Event;
    return { event, front, later };
  }

  /**
   * Track the front app (runs in the write chain): a focus event when it changes, a pause while
   * it is excluded or locked.
   */
  private applyFront(front: FrontAnswer, t: number): void {
    this.gated = gateOf(this.gate, ...frontParts(front));
    this.sync(t, true);
    if (this.paused) return;
    if (!sameFront(front, this.lastFront)) {
      const first = this.lastFront === null;
      this.lastFront = front;
      this.wantTree();
      if (!first) this.write({ kind: "focus", t, ts: this.ts(t), ...this.base(front) });
    }
    this.applyDialog(front, t);
  }

  /** A dialog event when the front window became a dialog not written last (runs in the chain). */
  private applyDialog(front: FrontAnswer, t: number): void {
    const key = dialogKey(front.dialog);
    if (key === this.lastDialog) return;
    this.lastDialog = key;
    const d = front.dialog;
    if (!d) return;
    this.write({
      kind: "dialog",
      t,
      ts: this.ts(t),
      ...this.base(front),
      title: clip(String(d.title ?? ""), 200),
      text: clip(String(d.text ?? ""), 300),
      buttons: (Array.isArray(d.buttons) ? d.buttons : [])
        .slice(0, 10)
        .map((b) => clip(String(b), 80)),
    });
  }

  /** `app` and `window` (logical points) for an event's Base. */
  private base(front: FrontAnswer | null): Pick<Event, "app" | "window"> {
    const window = logicalWindow(this.coords(), front?.window);
    return { ...(front?.app ? { app: front.app } : {}), ...(window ? { window } : {}) };
  }

  private wantTree(): void {
    if (this.d.probe.tree) this.treeWanted = true;
  }

  /**
   * Runs in the chain: `trees/<n>.json` and its event, unless it is the tree written last. Names
   * pass through secret redaction (a page can show a key as plain text).
   */
  private writeTree(a: TreeAnswer, front: FrontAnswer | null, t: number): void {
    const c = this.coords();
    const nodes = a.nodes.map((n) => ({
      ...c.rect(n),
      name: redactSecrets(String(n.name ?? "")).text,
    }));
    const hash = createHash("sha1").update(JSON.stringify(nodes)).digest("hex");
    if (hash === this.lastTreeHash) return;
    const body = JSON.stringify({ nodes, truncated: a.truncated === true, ms: a.ms });
    const n = this.journal.writeTree(body, "json", (tree) => ({
      kind: "tree",
      tree,
      t,
      ts: this.ts(t),
      ...this.base(front),
    }));
    if (n === null) return;
    this.lastTreeHash = hash;
    this.lastTree = n;
  }

  /** A clipboard change: its text only through `clipboardText`, nothing from an excluded app. */
  private onClipboard(c: ClipboardChange): void {
    if (this.stopped || this.paused) return;
    const t = this.t(this.clock.now());
    const front = this.front();
    const focused =
      c.concealed || c.secure ? Promise.resolve(null) : this.d.probe.focused(CLIPBOARD_FOCUS_MS);
    this.side(t, () =>
      this.enqueue(async () => {
        const f = (await front) ?? this.lastFront;
        const el = await focused;
        if (this.paused || gateOf(this.gate, ...frontParts(f)) !== null) return;
        this.write({
          kind: "clipboard",
          t,
          ts: this.ts(t),
          ...this.base(f),
          types: c.types,
          length: c.length,
          ...clipboardText(c, el),
        });
      }),
    );
  }

  /** The task marker: ask what the person is doing; an empty answer marks the task done. */
  private async task(): Promise<void> {
    if (this.prompting || this.paused || !this.d.ask) return;
    this.prompting = true;
    this.folder.flush();
    const t = this.t(this.clock.now());
    try {
      const answer = await this.d.ask(TASK_QUESTION);
      if (answer === null || this.stopped || this.paused) return;
      const goal = clip(answer.replace(/\s+/g, " ").trim(), TASK_GOAL_MAX);
      const e: Event = goal
        ? { kind: "task", goal, t, ts: this.ts(t) }
        : { kind: "task", goal: "", done: true, t, ts: this.ts(t) };
      this.enqueue(async () => this.write(e));
    } catch (err) {
      this.d.log?.(`task: ${(err as Error).message}`);
    } finally {
      this.prompting = false;
    }
  }

  /** Write pause / resume when the effective reason changed; `direct` when already in the chain. */
  private sync(t = this.t(this.clock.now()), direct = false): void {
    const now = this.paused;
    if (now === this.written) return;
    this.written = now;
    if (now === "excluded" || now === "locked") this.folder.flush();
    const e: Event = now
      ? { kind: "pause", reason: now, t, ts: this.ts(t) }
      : { kind: "resume", t, ts: this.ts(t) };
    if (direct) this.write(e);
    else this.enqueue(async () => this.write(e));
  }

  private write(e: Event): void {
    try {
      this.journal.write(e);
    } catch (err) {
      this.d.log?.(`journal: ${(err as Error).message}`);
    }
  }

  /**
   * A write beside the acts (a focus, tree or clipboard event): it waits while an act that began
   * before it is still folding (a text run, a held button), so events stay in time order.
   */
  private side(t: number, fn: () => void): void {
    let i = this.deferred.length;
    while (i > 0 && (this.deferred[i - 1] as { t: number }).t > t) i--;
    this.deferred.splice(i, 0, { t, fn });
    this.release(this.folder.pendingSince);
  }

  /** Run the side writes from before `before`, in time order. */
  private release(before: number): void {
    while (this.deferred.length && (this.deferred[0] as { t: number }).t < before)
      (this.deferred.shift() as { fn: () => void }).fn();
  }

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((e) => this.d.log?.(`write: ${(e as Error).message}`));
  }
}

function frontParts(f: FrontAnswer | null): [App | undefined, WindowInfo | null] {
  return [f?.app ?? undefined, f?.window ?? null];
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
