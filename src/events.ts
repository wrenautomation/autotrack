/**
 * The session format and the folding of raw input into it. `Base`, `Element` and `Event` are the
 * doc's types verbatim (designs/2026-10-13-track.md, "Session format"); autobrowse keeps a copy
 * in `src/track/types.ts` checked equal by a test. Change both or neither.
 *
 * Folding: throttles moves, pairs down/up into click or drag, folds wheel ticks per 250 ms and
 * printable keys into text runs. Pure: time comes in on each input and on `tick`. Acts leave in
 * time order: anything that happened after an open act waits until it closes.
 */

export interface Base {
  /** ms since session start (monotonic). */
  t: number;
  /** epoch ms. */
  ts: number;
  /** id: bundle id (Mac) / exe path (Windows). */
  app?: { name: string; id: string; pid: number };
  window?: { title: string; x: number; y: number; width: number; height: number };
  /** Display id the act is on. */
  display?: string;
}

/** Never the element's value. */
export interface Element {
  role: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  secure: boolean;
  /** Up to 6 ancestors, nearest first. */
  path?: { role: string; name: string }[];
  /** AXIdentifier / UIA AutomationId. */
  id?: string;
  /** UIA ClassName / AXDOMClassList joined. */
  cls?: string;
  /** AXURL, for links. */
  url?: string;
  help?: string;
}

/** What the browser extension saw under the pointer (screen points). */
export interface WebTarget {
  tag: string;
  role?: string;
  name?: string;
  /** ≤ 200 chars. */
  text?: string;
  id?: string;
  testId?: string;
  css?: string;
  xpath?: string;
  href?: string;
  inputType?: string;
  /** aria-* and data-* names and values, ≤ 80 chars each, no value attrs. */
  attrs?: Record<string, string>;
  /** React component names, nearest first, ≤ 12. */
  react?: string[];
  rect?: { x: number; y: number; width: number; height: number };
}

/**
 * What an act did, known once its after-frame is (Signal): the frame hash moved, the front app or
 * window changed, a dialog appeared, a window of the same app opened or closed.
 */
export interface Out {
  screen: boolean;
  focus: boolean;
  dialog: boolean;
  window: boolean;
}

/** What a web act did, on a follow-up `act: "effect"` event 1 s later. */
export interface WebEffects {
  /** When it changed. */
  url?: string;
  /** Origin + path, no query. */
  requests: { method: string; url: string; status: number; ms: number }[];
  dom: { added: number; removed: number; textChanged: number };
}

export type Event = Base &
  /** ≤ 20 Hz, ≥ 4 px */
  (
    | { kind: "move"; x: number; y: number }
    /** before/after = frame numbers */
    | ({
        kind: "click";
        x: number;
        y: number;
        button: "left" | "right" | "middle";
        count: number;
        element?: Element;
        before?: number;
        after?: number;
        out?: Out;
        /** The latest `tree` written before the act. */
        tree?: number;
      } & Settle &
        Approach)
    | ({
        kind: "drag";
        x0: number;
        y0: number;
        x: number;
        y: number;
        button: "left" | "right" | "middle";
        element?: Element;
        before?: number;
        after?: number;
        out?: Out;
        /** The latest `tree` written before the act. */
        tree?: number;
      } & Settle &
        Approach)
    /** wheel ticks folded per 250 ms */
    | ({
        kind: "scroll";
        x: number;
        y: number;
        dx: number;
        dy: number;
        element?: Element;
        before?: number;
        after?: number;
        out?: Out;
        /** The latest `tree` written before the act. */
        tree?: number;
      } & Settle &
        Approach)
    /** printable keys folded, ends at 1 s idle, a click, or a non-text key */
    | ({
        kind: "text";
        text: string;
        redacted: boolean;
        element?: Element;
        before?: number;
        after?: number;
        out?: Out;
        /** The latest `tree` written before the act. */
        tree?: number;
      } & Settle)
    /** enter, tab, arrows, esc, backspace runs, and any combo */
    | ({
        kind: "key";
        key: string;
        mods: ("ctrl" | "alt" | "shift" | "meta")[];
        element?: Element;
        before?: number;
        after?: number;
        out?: Out;
        /** The latest `tree` written before the act. */
        tree?: number;
      } & Settle)
    /** app or window changed (app/window on Base) */
    | { kind: "focus" }
    /** a screen change with no act (idle reading) */
    | { kind: "frame"; frame: number }
    | { kind: "pause"; reason: "hotkey" | "cli" | "excluded" | "locked" }
    | { kind: "resume" }
    | {
        kind: "web";
        act: string;
        tab: number;
        frame: number;
        url: string;
        title: string;
        x?: number;
        y?: number;
        target?: WebTarget;
        effects?: WebEffects;
        /** `snapshot`: the page outline; over 2 KB it is stored as `trees/<n>.txt`, see `treeFile`. */
        tree?: string;
        treeFile?: number;
      }
    | { kind: "app"; url: string; action: string; detail: unknown }
    /** the front window's accessibility tree, stored as `trees/<n>.json` in the segment */
    | { kind: "tree"; tree: number }
    /** the front window became an alert, sheet or modal dialog; text ≤ 300 */
    | { kind: "dialog"; title: string; text: string; buttons: string[] }
    /** the clipboard changed; text ≤ 2,000, none from a secure field or concealed copy */
    | { kind: "clipboard"; types: string[]; length: number; text?: string; redacted: boolean }
    /** the person's own "why" (Ctrl+Alt+Shift+T); an empty answer is `goal: "", done: true` */
    | { kind: "task"; goal: string; done?: boolean }
    /**
     * Quality: one per written frame. `at` is the grab's t (a ring frame can be older than the act
     * that names it); `x, y` the cursor then (screenshots carry no cursor).
     */
    | { kind: "shot"; frame: number; at: number; x: number; y: number; display: string }
    /** Quality: the capture level from here on, and the input that decided it. */
    | { kind: "level"; level: Level; why: string }
    /** A helper (`probe`, `shots`) was restarted: its memory (MB) passed the cap. */
    | { kind: "restart"; helper: string; why: string; mb: number }
  );

/**
 * Quality, on every act: `settle` is ms from the act's end to the screen holding still (two grabs
 * in a row that do not differ); `settled: false` when 3 s ran out first (a spinner, a video), and
 * `settle` is then the time it gave up. Neither is there at `lean` (a fixed 300 ms after-frame).
 */
export interface Settle {
  settle?: number;
  settled?: boolean;
}

/**
 * Quality, on click, drag and scroll: `path` is the pointer's raw moves `[dt, x, y]`, dt in ms from
 * the act's t: the last 1 s before it (dt < 0, at most 60 points), then a drag's own path while
 * the button was held (dt >= 0, at most 120). `crop` names `crops/<n>.jpg`: 256x256 points around
 * the pointer at button-down (a scroll: its first tick), at the display's native pixels.
 */
export interface Approach {
  path?: [number, number, number][];
  crop?: number;
}

export type Level = "full" | "normal" | "lean";

export type Button = "left" | "right" | "middle";
export type Mod = "ctrl" | "alt" | "shift" | "meta";
export type App = NonNullable<Base["app"]>;
export type WindowInfo = NonNullable<Base["window"]>;
export type PauseReason = Extract<Event, { kind: "pause" }>["reason"];

export interface Display {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number; // logical points → frame pixels
  primary: boolean;
}

/** `session.json`. Times are ISO 8601; `endedAt` is null while the session is open. */
export interface SessionMeta {
  v: 1;
  session: string;
  device: string;
  os: string;
  osVersion: string;
  arch: string;
  trackVersion: string;
  startedAt: string;
  endedAt: string | null;
  displays: Display[];
  /** Quality: running totals over the session's closed segments (`Stats` summed). */
  totals?: Stats;
}

/**
 * Quality: `<segment>/stats.json`, written when the segment closes and again when its OCR is done
 * (or given up, 2 h later). A trainer filters on these. `recovered`: closed by the next start after
 * a crash, so only what the files show is counted.
 */
export interface Stats {
  /** Events written, by kind. */
  events: Record<string, number>;
  /** Raw pointer moves the 20 Hz / 4 px fold dropped. */
  movesDropped: number;
  /** Probe asks (at, focused, front, tree) that answered, and that timed out or had no helper. */
  probe: { answers: number; timeouts: number };
  /** Acts written with no element. */
  nullElement: number;
  frames: { saved: number; failed: number; slotReused: number };
  trees: number;
  crops: number;
  /** Images read; `same`: a frame whose hash matched one already read; `skipped`: not read in time. */
  ocr: { done: number; same: number; failed: number; skipped: number };
  /** Seconds at each level. */
  levels: Record<Level, number>;
  /** Helper (re)starts after the first, by helper. */
  restarts: Record<string, number>;
  recovered?: boolean;
}

export type Raw =
  | { type: "move"; t: number; x: number; y: number }
  | { type: "down"; t: number; x: number; y: number; button: Button }
  | { type: "up"; t: number; x: number; y: number; button: Button }
  | { type: "wheel"; t: number; x: number; y: number; dx: number; dy: number }
  // char: what the key types on a US layout with shift applied, when printable.
  | { type: "keydown"; t: number; key: string; mods: Mod[]; char?: string };

export type Act =
  | { kind: "move"; t: number; x: number; y: number }
  | { kind: "click"; t: number; x: number; y: number; button: Button; count: number }
  | { kind: "drag"; t: number; x0: number; y0: number; x: number; y: number; button: Button }
  | { kind: "scroll"; t: number; x: number; y: number; dx: number; dy: number }
  | { kind: "text"; t: number; text: string }
  | { kind: "key"; t: number; key: string; mods: Mod[] };

/** Where an act's context comes from: the point under the pointer, or the focused element. */
export type Begin =
  /** `press`: a button went down (a click or a drag); otherwise a scroll's first tick. */
  { on: "point"; x: number; y: number; press?: boolean } | { on: "focus" };

/** An act as it leaves the folder: `ctx` came from `begin` when it started, `end` is when it closed. */
export type Folded<C> = Act & { end: number; ctx?: C };

export const MOVE_MS = 50; // ≤ 20 Hz
export const MOVE_PX = 4;
export const DRAG_PX = 5;
export const MULTI_CLICK_MS = 500;
export const SCROLL_MS = 250;
export const TEXT_IDLE_MS = 1000;

const MODIFIERS = new Set([
  "shift",
  "shiftright",
  "ctrl",
  "ctrlright",
  "alt",
  "altright",
  "meta",
  "metaright",
  "capslock",
  "numlock",
]);

export class Folder<C> {
  private queue: Folded<C>[] = [];
  private lastMove: { t: number; x: number; y: number } | null = null;
  private down: { t: number; x: number; y: number; button: Button; ctx: C } | null = null;
  private lastClick: { t: number; x: number; y: number; button: Button; count: number } | null =
    null;
  private scroll: { t: number; x: number; y: number; dx: number; dy: number; ctx: C } | null = null;
  private scrollLast = 0;
  private text: { t: number; last: number; text: string; ctx: C } | null = null;
  /** Raw moves the 20 Hz / 4 px rule dropped (stats). */
  movesDropped = 0;

  private readonly begin: (b: Begin, t: number) => C;
  private readonly emit: (a: Folded<C>) => void;

  constructor(begin: (b: Begin, t: number) => C, emit: (a: Folded<C>) => void) {
    this.begin = begin;
    this.emit = emit;
  }

  push(r: Raw): void {
    this.tick(r.t);
    switch (r.type) {
      case "move":
        this.move(r.t, r.x, r.y);
        return;
      case "down":
        this.endText();
        this.endScroll();
        this.down = {
          t: r.t,
          x: r.x,
          y: r.y,
          button: r.button,
          ctx: this.begin({ on: "point", x: r.x, y: r.y, press: true }, r.t),
        };
        this.drain();
        return;
      case "up":
        this.up(r);
        return;
      case "wheel":
        this.wheel(r);
        return;
      case "keydown":
        this.key(r);
        return;
    }
  }

  /** The earliest t not yet emitted (an act still folding or waiting to leave); Infinity if none. */
  get pendingSince(): number {
    return Math.min(
      this.down?.t ?? Number.POSITIVE_INFINITY,
      this.scroll?.t ?? Number.POSITIVE_INFINITY,
      this.text?.t ?? Number.POSITIVE_INFINITY,
      ...this.queue.map((a) => a.t),
    );
  }

  /** Close what timed out: a text run idle for 1 s, a scroll fold past 250 ms. */
  tick(t: number): void {
    if (this.text && t - this.text.last >= TEXT_IDLE_MS) this.endText();
    if (this.scroll && t - this.scroll.t >= SCROLL_MS) this.endScroll();
    this.drain();
  }

  /** Close everything now (pause, stop). A button still held is dropped. */
  flush(): void {
    this.endText();
    this.endScroll();
    this.down = null;
    this.drain();
  }

  private move(t: number, x: number, y: number): void {
    const m = this.lastMove;
    if (m && (t - m.t < MOVE_MS || Math.hypot(x - m.x, y - m.y) < MOVE_PX)) {
      this.movesDropped++;
      return;
    }
    this.lastMove = { t, x, y };
    this.queue.push({ kind: "move", t, x, y, end: t });
    this.drain();
  }

  private up(r: Extract<Raw, { type: "up" }>): void {
    const d = this.down;
    if (!d || d.button !== r.button) return;
    this.down = null;
    if (Math.hypot(r.x - d.x, r.y - d.y) >= DRAG_PX) {
      this.lastClick = null;
      this.queue.push({
        kind: "drag",
        t: d.t,
        x0: d.x,
        y0: d.y,
        x: r.x,
        y: r.y,
        button: d.button,
        end: r.t,
        ctx: d.ctx,
      });
    } else {
      const p = this.lastClick;
      const count =
        p &&
        p.button === d.button &&
        d.t - p.t <= MULTI_CLICK_MS &&
        Math.hypot(d.x - p.x, d.y - p.y) < DRAG_PX
          ? p.count + 1
          : 1;
      this.lastClick = { t: d.t, x: d.x, y: d.y, button: d.button, count };
      this.queue.push({
        kind: "click",
        t: d.t,
        x: d.x,
        y: d.y,
        button: d.button,
        count,
        end: r.t,
        ctx: d.ctx,
      });
    }
    this.drain();
  }

  private wheel(r: Extract<Raw, { type: "wheel" }>): void {
    this.endText();
    if (!this.scroll) {
      this.scroll = {
        t: r.t,
        x: r.x,
        y: r.y,
        dx: 0,
        dy: 0,
        ctx: this.begin({ on: "point", x: r.x, y: r.y }, r.t),
      };
    }
    this.scroll.dx += r.dx;
    this.scroll.dy += r.dy;
    this.scrollLast = r.t;
    this.drain();
  }

  private key(r: Extract<Raw, { type: "keydown" }>): void {
    if (MODIFIERS.has(r.key)) return;
    const textual = r.char !== undefined && r.mods.every((m) => m === "shift");
    if (textual) {
      this.endScroll();
      if (!this.text)
        this.text = { t: r.t, last: r.t, text: "", ctx: this.begin({ on: "focus" }, r.t) };
      this.text.text += r.char;
      this.text.last = r.t;
      this.drain();
      return;
    }
    if (r.key === "backspace" && r.mods.length === 0 && this.text && this.text.text.length > 0) {
      this.text.text = [...this.text.text].slice(0, -1).join("");
      this.text.last = r.t;
      return;
    }
    this.endText();
    this.endScroll();
    this.queue.push({
      kind: "key",
      t: r.t,
      key: r.key,
      mods: r.mods,
      end: r.t,
      ctx: this.begin({ on: "focus" }, r.t),
    });
    this.drain();
  }

  private endText(): void {
    const s = this.text;
    if (!s) return;
    this.text = null;
    // A run that typed and then erased everything still happened: keep it, empty.
    this.queue.push({ kind: "text", t: s.t, text: s.text, end: s.last, ctx: s.ctx });
  }

  private endScroll(): void {
    const s = this.scroll;
    if (!s) return;
    this.scroll = null;
    this.queue.push({
      kind: "scroll",
      t: s.t,
      x: s.x,
      y: s.y,
      dx: s.dx,
      dy: s.dy,
      end: this.scrollLast,
      ctx: s.ctx,
    });
  }

  /** Release queued acts older than the oldest open one, in time order. */
  private drain(): void {
    const open = Math.min(
      this.down?.t ?? Number.POSITIVE_INFINITY,
      this.scroll?.t ?? Number.POSITIVE_INFINITY,
      this.text?.t ?? Number.POSITIVE_INFINITY,
    );
    if (this.queue.length === 0) return;
    this.queue.sort((a, b) => a.t - b.t);
    while (this.queue.length && (this.queue[0] as Folded<C>).t < open)
      this.emit(this.queue.shift() as Folded<C>);
  }
}
