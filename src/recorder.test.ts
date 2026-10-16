import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import type { App, Element, Event, Raw } from "./events.ts";
import type { OcrReader } from "./ocr.ts";
import type { ClipboardChange, FrontAnswer, TreeAnswer } from "./probe.ts";
import { outOf, type ProbeLike, Recorder, type RecorderDeps } from "./recorder.ts";
import type { Capturer } from "./screen.ts";

const T0 = Date.UTC(2030, 5, 1, 12, 0, 0);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const app = (name: string, id: string, pid: number): App => ({ name, id, pid });
const win = (title: string) => ({ title, x: 0, y: 0, width: 800, height: 600 });
const field = (secure: boolean): Element => ({
  role: "textfield",
  name: secure ? "Password" : "Search",
  x: 10,
  y: 10,
  width: 200,
  height: 24,
  secure,
});

function setup(
  opts: {
    focused?: () => { element: Element | null } | null;
    at?: (
      x: number,
      y: number,
      timeoutMs?: number,
      waitMs?: number,
      down?: boolean,
    ) => { element: Element | null } | null;
    tree?: () => TreeAnswer | null | Promise<TreeAnswer | null>;
    ask?: (q: string) => Promise<string | null>;
    /** The sleep moves the clock (settle loops see time pass). */
    clocked?: boolean;
    deps?: Partial<RecorderDeps>;
  } = {},
) {
  const sessions = mkdtempSync(join(tmpdir(), "track-recorder-"));
  dirs.push(sessions);
  let now = 1000;
  let front: FrontAnswer = { app: app("TextEdit", "com.apple.TextEdit", 10), window: win("Notes") };
  let shade = 0;
  let still = false; // the screen stops changing
  const crops: { x: number; y: number; size: number; path: string }[] = [];
  const grabsAt: number[] = [];
  let onClip: (c: ClipboardChange) => void = () => {};
  let onRaw: (r: Raw) => void = () => {};
  const notes: string[] = [];
  const probe: ProbeLike = {
    available: true,
    running: true,
    at: async (x, y, ms, wait, down) =>
      opts.at
        ? opts.at(x, y, ms, wait, down)
        : { element: { ...field(false), role: "button", name: "OK" } },
    front: async () => front,
    focused: async () => (opts.focused ? opts.focused() : { element: field(false) }),
    perm: async () => ({ accessibility: true, screen: true, input: true }),
    ...(opts.tree ? { tree: async () => (opts.tree as () => Promise<TreeAnswer | null>)() } : {}),
    watchClipboard: (fn) => {
      onClip = fn;
    },
    close: () => {},
  };
  const capturer: Capturer = {
    displays: () => [{ id: "1", x: 0, y: 0, width: 64, height: 36, scale: 1, primary: true }],
    grab: async () => {
      grabsAt.push(now - 1000);
      if (!still) shade += 40;
      return {
        display: "1",
        width: 64,
        height: 36,
        hash: ((BigInt(shade % 256) << 56n) | 0n).toString(16).padStart(16, "0"),
        token: shade,
      };
    },
    save: async (_shot, path) => {
      writeFileSync(path, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
      return true;
    },
    crop: async (x, y, size, path) => {
      crops.push({ x, y, size, path });
      writeFileSync(path, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
      return { ok: true, w: size * 2, h: size * 2 };
    },
  };
  const rec = new Recorder({
    sessions,
    config: parseConfig({ device: "test-mac" }),
    meta: { os: "darwin", osVersion: "1", arch: "arm64", trackVersion: "0.0.0" },
    probe,
    capturer,
    hook: (fn) => {
      onRaw = fn;
      return () => {};
    },
    displayAt: () => "1",
    notify: (m) => notes.push(m),
    ...(opts.ask ? { ask: opts.ask } : {}),
    clock: { now: () => now, epoch: () => T0 + now - 1000 },
    timers: false,
    sleep: opts.clocked
      ? async (ms) => {
          now += ms;
        }
      : async () => {},
    ...opts.deps,
  });
  rec.start();
  const at = (t: number) => {
    now = 1000 + t;
  };
  const raw = (r: Raw) => {
    at(r.t);
    onRaw({ ...r, t: 1000 + r.t } as Raw);
  };
  /** Events as written; the quality kinds (`level`, `shot`) only with `all`. */
  const events = (all = false): Event[] => {
    const out: Event[] = [];
    for (const seg of readdirSync(rec.journal.dir)
      .filter((n) => /^\d+$/.test(n))
      .sort())
      for (const l of readFileSync(join(rec.journal.dir, seg, "events.jsonl"), "utf8").split("\n"))
        if (l) out.push(JSON.parse(l));
    return all ? out : out.filter((e) => e.kind !== "level" && e.kind !== "shot");
  };
  const typeText = (t0: number, s: string) => {
    [...s].forEach((c, i) => {
      raw({ type: "keydown", t: t0 + i * 30, key: c, mods: [], char: c });
    });
  };
  return {
    rec,
    raw,
    at,
    events,
    crops,
    grabsAt,
    sessions,
    notes,
    typeText,
    setFront: (f: FrontAnswer) => {
      front = f;
    },
    still: (v: boolean) => {
      still = v;
    },
    copy: (c: ClipboardChange) => onClip(c),
    file: (seg: string, name: string) => readFileSync(join(rec.journal.dir, seg, name), "utf8"),
    click: (t: number, x = 50, y = 60) => {
      raw({ type: "down", t, x, y, button: "left" });
      raw({ type: "up", t: t + 20, x, y, button: "left" });
    },
  };
}

describe("recorder", () => {
  it("a front change seen while a text run is open is written after the run, in time order", async () => {
    const r = setup();
    r.raw({ type: "move", t: 50, x: 5, y: 5 });
    r.typeText(100, "hi");
    r.setFront({ app: app("Safari", "com.apple.Safari", 20), window: win("Docs") });
    r.at(200);
    await r.rec.frontTick();
    r.raw({ type: "keydown", t: 300, key: "enter", mods: [] });
    r.rec.foldTick();
    await r.rec.settled();
    await r.rec.stop();
    const evs = r.events().filter((e) => e.kind !== "frame");
    expect(evs.map((e) => e.kind)).toEqual(["move", "text", "focus", "key"]);
    const ts = evs.map((e) => e.t);
    expect(ts).toEqual([...ts].sort((x, y) => x - y));
  });

  it("a click's element is the press's (down), gets 3 s and 1 s of helper wait; a null is asked once more", async () => {
    const asks: [number | undefined, number | undefined, boolean | undefined][] = [];
    const r = setup({
      at: (_x, _y, ms, wait, down) => {
        asks.push([ms, wait, down]);
        return asks.length === 1
          ? null
          : { element: { ...field(false), role: "textarea", name: "" } };
      },
    });
    r.raw({ type: "down", t: 100, x: 50, y: 60, button: "left" });
    r.raw({ type: "up", t: 150, x: 50, y: 60, button: "left" });
    await r.rec.settled();
    await r.rec.stop();
    expect(asks).toEqual([
      [3000, 1000, true],
      [3000, 1000, undefined],
    ]);
    expect(r.events()[0]).toMatchObject({ kind: "click", element: { role: "textarea" } });
  });

  it("a click whose own answer has no role takes the element asked where the pointer rested", async () => {
    const answers = [
      { element: { ...field(false), role: "button", name: "Submit" } },
      { element: { ...field(false), role: "", name: "" } },
    ];
    let n = 0;
    const r = setup({ at: () => answers[n++] ?? null });
    r.raw({ type: "move", t: 100, x: 50, y: 60 });
    r.at(150);
    r.rec.foldTick(); // still 50 ms: not asked yet
    expect(n).toBe(0);
    r.at(220);
    r.rec.foldTick();
    expect(n).toBe(1);
    r.raw({ type: "move", t: 230, x: 51, y: 61 }); // within 2 px: the same rest, not asked again
    r.rec.foldTick();
    r.click(300);
    await r.rec.settled();
    await r.rec.stop();
    expect(n).toBe(2);
    const click = r.events().find((e) => e.kind === "click");
    expect(click).toMatchObject({ element: { role: "button", name: "Submit" } });
  });

  it("a click with its own element, or away from the rest, does not use the rested one", async () => {
    const names = ["Rested", "Own", "Elsewhere"];
    let n = 0;
    const r = setup({
      at: () => ({ element: { ...field(false), role: "button", name: names[n++] ?? "" } }),
    });
    r.raw({ type: "move", t: 100, x: 50, y: 60 });
    r.at(250);
    r.rec.foldTick();
    r.click(300);
    r.raw({ type: "move", t: 400, x: 50, y: 60 });
    r.raw({ type: "move", t: 450, x: 120, y: 60 });
    r.click(460, 120, 60); // no rest at 120,60: asked once, at the click
    await r.rec.settled();
    await r.rec.stop();
    expect(n).toBe(3);
    const clicks = r.events().filter((e) => e.kind === "click");
    expect(clicks.map((c) => (c.kind === "click" ? c.element?.name : null))).toEqual([
      "Own",
      "Elsewhere",
    ]);
  });

  it("a click carries element, app, window, display and before/after frames on disk", async () => {
    const r = setup();
    r.raw({ type: "down", t: 100, x: 50, y: 60, button: "left" });
    r.raw({ type: "up", t: 150, x: 50, y: 60, button: "left" });
    await r.rec.settled();
    await r.rec.stop();
    const [click] = r.events();
    expect(click).toMatchObject({
      kind: "click",
      t: 100,
      ts: T0 + 100,
      x: 50,
      y: 60,
      count: 1,
      element: { role: "button", name: "OK" },
      app: { name: "TextEdit" },
      window: { title: "Notes" },
      display: "1",
      before: 0,
      after: 1,
    });
    expect(existsSync(join(r.rec.journal.dir, "000", "frames", "0.jpg"))).toBe(true);
    expect(existsSync(join(r.rec.journal.dir, "000", "frames", "1.jpg"))).toBe(true);
    expect(existsSync(join(r.rec.journal.dir, "000", ".done"))).toBe(true);
    expect(r.notes).toEqual(["Tracking on"]);
  });

  it("text into a password field is written empty and redacted", async () => {
    const r = setup({ focused: () => ({ element: field(true) }) });
    r.typeText(0, "hunter2");
    r.at(2000);
    r.rec.foldTick();
    await r.rec.stop();
    const text = r.events().find((e) => e.kind === "text");
    expect(text).toMatchObject({ kind: "text", text: "", redacted: true });
    expect(JSON.stringify(r.events())).not.toContain("hunter2");
  });

  it("keys are held while the probe can't answer, then written by its answer", async () => {
    let calls = 0;
    const r = setup({ focused: () => (++calls < 3 ? null : { element: field(false) }) });
    r.typeText(0, "hello");
    r.at(2000);
    r.rec.foldTick();
    await r.rec.stop();
    expect(calls).toBe(3);
    expect(r.events().find((e) => e.kind === "text")).toMatchObject({
      text: "hello",
      redacted: false,
    });
  });

  it("an excluded app records nothing and pauses; leaving it resumes with a focus event", async () => {
    const r = setup();
    r.raw({ type: "down", t: 0, x: 1, y: 1, button: "left" });
    r.raw({ type: "up", t: 10, x: 1, y: 1, button: "left" });
    await r.rec.settled();
    r.setFront({ app: app("1Password", "com.1password.1password", 20), window: win("Vault") });
    r.raw({ type: "down", t: 100, x: 5, y: 5, button: "left" });
    r.raw({ type: "up", t: 110, x: 5, y: 5, button: "left" });
    await r.rec.settled();
    r.typeText(200, "secret"); // dropped at the hook: we are paused now
    r.raw({ type: "move", t: 300, x: 90, y: 90 });
    r.setFront({ app: app("Safari", "com.apple.Safari", 30), window: win("Inbox") });
    r.at(500);
    await r.rec.frontTick();
    await r.rec.stop();
    const ev = r.events();
    expect(ev.map((e) => e.kind)).toEqual(["click", "pause", "resume", "focus"]);
    expect(ev[1]).toMatchObject({ kind: "pause", reason: "excluded" });
    expect(ev[3]).toMatchObject({ app: { name: "Safari" }, window: { title: "Inbox" } });
    expect(JSON.stringify(ev)).not.toContain("Vault");
  });

  it("the lock screen pauses with reason locked", async () => {
    const r = setup();
    r.raw({ type: "move", t: 0, x: 1, y: 1 });
    r.setFront({ app: app("loginwindow", "com.apple.loginwindow", 1), window: null });
    r.at(100);
    await r.rec.frontTick();
    await r.rec.stop();
    expect(r.events().at(-1)).toMatchObject({ kind: "pause", reason: "locked" });
  });

  it("Ctrl+Alt+Shift+P toggles a pause with notifications; the hotkey itself is not recorded", async () => {
    const r = setup();
    const hot = (t: number) =>
      r.raw({ type: "keydown", t, key: "p", mods: ["ctrl", "alt", "shift"], char: "P" });
    hot(0);
    expect(r.rec.paused).toBe("hotkey");
    r.typeText(100, "private");
    hot(1000);
    r.typeText(1100, "ok");
    r.at(3000);
    r.rec.foldTick();
    await r.rec.stop();
    const ev = r.events();
    expect(ev.map((e) => e.kind)).toEqual(["pause", "resume", "text"]);
    expect(ev[0]).toMatchObject({ reason: "hotkey" });
    expect(ev[2]).toMatchObject({ text: "ok" });
    expect(r.notes).toEqual(["Tracking on", "Tracking paused", "Tracking on"]);
  });

  it("cli pause and resume", async () => {
    const r = setup();
    r.rec.pause("cli");
    expect(r.rec.status().paused).toBe("cli");
    r.rec.resume();
    await r.rec.stop();
    expect(r.events().map((e) => e.kind)).toEqual(["pause", "resume"]);
  });

  it("idle reading writes frame events when the screen changes", async () => {
    const r = setup();
    r.at(0);
    await r.rec.idleTick();
    r.at(2500);
    await r.rec.idleTick();
    await r.rec.stop();
    expect(r.events()).toEqual([
      { kind: "frame", frame: 0, t: 0, ts: T0 },
      { kind: "frame", frame: 1, t: 2500, ts: T0 + 2500 },
    ]);
  });

  it("events land in time order", async () => {
    const r = setup();
    r.typeText(0, "ab");
    r.raw({ type: "move", t: 40, x: 10, y: 10 });
    r.raw({ type: "down", t: 200, x: 10, y: 10, button: "left" });
    r.raw({ type: "up", t: 220, x: 10, y: 10, button: "left" });
    r.raw({ type: "keydown", t: 300, key: "enter", mods: [] });
    await r.rec.stop();
    const ev = r.events();
    expect(ev.map((e) => e.kind)).toEqual(["text", "move", "click", "key"]);
    expect(ev.map((e) => e.t)).toEqual([0, 40, 200, 300]);
  });

  it("a click the probe could not place in time keeps the last known app", async () => {
    let up = true;
    const r = setup();
    const probe = (r.rec as unknown as { d: { probe: ProbeLike } }).d.probe;
    const front = probe.front;
    probe.front = async () => (up ? front() : null);
    r.raw({ type: "move", t: 0, x: 1, y: 1 });
    await r.rec.frontTick();
    up = false;
    r.raw({ type: "down", t: 100, x: 5, y: 5, button: "left" });
    r.raw({ type: "up", t: 120, x: 5, y: 5, button: "left" });
    await r.rec.stop();
    expect(r.events().find((e) => e.kind === "click")).toMatchObject({ app: { name: "TextEdit" } });
  });

  it("web and app events from the extension are written as is, t/ts filled in", async () => {
    const r = setup();
    r.at(500);
    const web = {
      kind: "web",
      act: "click",
      tab: 3,
      frame: 0,
      url: "https://app.test/",
      title: "App",
      ts: T0 + 400,
      target: { tag: "button", testId: "approve", react: ["ApproveButton"] },
    };
    expect(r.rec.external(web)).toEqual({ written: true });
    expect(
      r.rec.external({ kind: "app", url: "u", action: "approve-message", detail: { id: 1 } }),
    ).toEqual({ written: true });
    expect(() => r.rec.external({ kind: "click" })).toThrow(/web or app/);
    expect(() => r.rec.external("x")).toThrow();
    r.rec.pause("cli");
    expect(r.rec.external({ ...web, ts: T0 + 600 })).toEqual({ written: false, reason: "cli" });
    await r.rec.stop();
    const ev = r.events().filter((e) => e.kind === "web" || e.kind === "app");
    expect(ev).toEqual([
      { ...web, t: 400 },
      { kind: "app", url: "u", action: "approve-message", detail: { id: 1 }, t: 500, ts: T0 + 500 },
    ]);
  });

  it("the probe's richer element fields pass through", async () => {
    const r = setup();
    const probe = (r.rec as unknown as { d: { probe: ProbeLike } }).d.probe;
    const rich = {
      ...field(false),
      role: "AXButton",
      name: "Approve",
      path: [{ role: "AXGroup", name: "Message" }],
      id: "approve",
      cls: "btn primary",
      url: "https://app.test/m/1",
      help: "Send it",
    };
    probe.at = async () => ({ element: rich });
    r.raw({ type: "down", t: 100, x: 5, y: 5, button: "left" });
    r.raw({ type: "up", t: 120, x: 5, y: 5, button: "left" });
    await r.rec.stop();
    expect(r.events().find((e) => e.kind === "click")).toMatchObject({ element: rich });
  });

  it("status reports the session", async () => {
    const r = setup();
    const s = r.rec.status();
    expect(s).toMatchObject({ session: r.rec.journal.session, paused: null, probe: "running" });
    await r.rec.stop();
  });
});

const node = (name: string) => ({
  role: "button",
  name,
  x: 10,
  y: 20,
  width: 30,
  height: 40,
  depth: 1,
});
const tree = (...names: string[]): TreeAnswer => ({
  nodes: names.map(node),
  truncated: false,
  ms: 5,
});

describe("recorder signal", () => {
  it("an act carries what it did: screen, focus, window and dialog", async () => {
    const r = setup();
    r.click(100); // the fake screen changes on every grab
    await r.rec.settled();
    r.still(true);
    const edit = app("TextEdit", "com.apple.TextEdit", 10);
    r.setFront({ app: edit, window: win("Notes"), windows: 1 });
    r.click(400);
    r.setFront({
      app: edit,
      window: win("Notes"),
      windows: 2,
      dialog: { title: "Save?", text: "Keep your changes?", buttons: ["Don't Save", "Save"] },
    });
    await r.rec.settled();
    r.click(800);
    r.setFront({ app: app("Safari", "com.apple.Safari", 20), window: win("Docs") });
    await r.rec.stop();
    const clicks = r.events().filter((e) => e.kind === "click");
    expect(clicks.map((e) => (e as { out?: unknown }).out)).toEqual([
      { screen: true, focus: false, dialog: false, window: false },
      { screen: false, focus: false, dialog: true, window: true },
      { screen: false, focus: true, dialog: false, window: false },
    ]);
  });

  it("outOf: an unknown side reads false", () => {
    const f: FrontAnswer = { app: app("A", "a", 1), window: win("W"), windows: 1 };
    expect(outOf(null, null, null, null)).toEqual({
      screen: false,
      focus: false,
      dialog: false,
      window: false,
    });
    expect(outOf(f, { app: f.app, window: f.window }, "00", null)).toMatchObject({
      window: false,
      screen: false,
    });
    expect(outOf(f, { ...f, app: app("B", "b", 2), windows: 3 }, null, null)).toMatchObject({
      focus: true,
      window: false,
    });
  });

  it("a dialog in front is written once, with title, text and buttons", async () => {
    const r = setup();
    r.raw({ type: "move", t: 0, x: 1, y: 1 });
    const dialog = {
      title: "Delete?",
      text: "This can't be undone.",
      buttons: ["Cancel", "Delete"],
    };
    r.setFront({ app: app("Finder", "com.apple.finder", 5), window: win("Delete?"), dialog });
    r.at(100);
    await r.rec.frontTick();
    r.at(1100);
    await r.rec.frontTick();
    r.setFront({ app: app("Finder", "com.apple.finder", 5), window: win("Delete?"), dialog: null });
    r.at(2100);
    await r.rec.frontTick();
    r.setFront({ app: app("Finder", "com.apple.finder", 5), window: win("Delete?"), dialog });
    r.at(3100);
    await r.rec.frontTick();
    await r.rec.stop();
    const dialogs = r.events().filter((e) => e.kind === "dialog");
    expect(dialogs.length).toBe(2);
    expect(dialogs[0]).toMatchObject({ kind: "dialog", ...dialog, app: { name: "Finder" } });
  });

  it("trees: one after a focus change, at most once a second, the same tree once; acts name the latest", async () => {
    let answer = tree("OK");
    const r = setup({ tree: () => answer });
    r.click(0);
    await r.rec.settled();
    await r.rec.treeTick();
    await r.rec.settled();
    r.click(100);
    await r.rec.settled();
    r.at(500);
    await r.rec.treeTick(); // under a second since the last: waits
    r.at(1200);
    await r.rec.treeTick(); // the same tree: not written again
    r.click(1300);
    await r.rec.settled();
    answer = tree("OK", "Cancel");
    r.at(2400);
    await r.rec.treeTick();
    await r.rec.stop();
    const ev = r.events();
    expect(ev.filter((e) => e.kind === "tree").map((e) => (e as { tree: number }).tree)).toEqual([
      0, 1,
    ]);
    const clicks = ev.filter((e) => e.kind === "click") as { tree?: number }[];
    expect(clicks.map((c) => c.tree)).toEqual([undefined, 0, 0]);
    expect(JSON.parse(r.file("000", "trees/1.json"))).toEqual({
      nodes: [node("OK"), node("Cancel")],
      truncated: false,
      ms: 5,
    });
    expect(r.rec.status().trees).toBe(2);
  });

  it("a tree whose walk outlasts a click is written after it, at the time its answer came", async () => {
    let answer: (a: TreeAnswer) => void = () => {};
    const r = setup({
      tree: () =>
        new Promise<TreeAnswer>((res) => {
          answer = res;
        }),
    });
    r.click(0);
    await r.rec.settled();
    r.at(1000);
    const walking = r.rec.treeTick();
    r.click(1100);
    await r.rec.settled();
    r.at(1300);
    answer(tree("OK"));
    await walking;
    await r.rec.stop();
    const ev = r.events().filter((e) => e.kind !== "frame");
    expect(ev.map((e) => e.kind)).toEqual(["click", "click", "tree"]);
    expect(ev.at(-1)?.t).toBe(1300);
  });

  it("tree names pass through secret redaction", async () => {
    const r = setup({ tree: () => tree("Key", `token ghp_${"x1".repeat(15)}`) });
    r.click(0);
    await r.rec.settled();
    await r.rec.treeTick();
    await r.rec.stop();
    const names = JSON.parse(r.file("000", "trees/0.json")).nodes.map(
      (n: { name: string }) => n.name,
    );
    expect(names).toEqual(["Key", "token <redacted>"]);
  });

  it("no tree while an excluded app is in front", async () => {
    const r = setup({ tree: () => tree("Vault item") });
    r.setFront({ app: app("1Password", "com.1password.1password", 20), window: win("Vault") });
    r.raw({ type: "move", t: 0, x: 1, y: 1 });
    await r.rec.frontTick();
    await r.rec.treeTick();
    await r.rec.stop();
    expect(r.events().some((e) => e.kind === "tree")).toBe(false);
    expect(JSON.stringify(r.events())).not.toContain("Vault item");
  });

  it("clipboard: text redacted; none from a password field, a concealed copy or an excluded app", async () => {
    let secure = false;
    const r = setup({ focused: () => ({ element: field(secure) }) });
    r.copy({ types: ["public.utf8-plain-text"], length: 5, text: "hello", concealed: false });
    await r.rec.settled();
    secure = true;
    r.copy({ types: ["public.utf8-plain-text"], length: 7, text: "hunter2", concealed: false });
    await r.rec.settled();
    secure = false;
    r.copy({ types: ["org.nspasteboard.ConcealedType"], length: 9, concealed: true });
    await r.rec.settled();
    r.setFront({ app: app("1Password", "com.1password.1password", 20), window: win("Vault") });
    r.copy({ types: ["public.utf8-plain-text"], length: 8, text: "vaultpw1", concealed: false });
    await r.rec.stop();
    const clips = r.events().filter((e) => e.kind === "clipboard");
    expect(clips).toEqual([
      expect.objectContaining({
        length: 5,
        text: "hello",
        redacted: false,
        app: expect.anything(),
      }),
      expect.objectContaining({ length: 7, redacted: true }),
      expect.objectContaining({ length: 9, redacted: true }),
    ]);
    expect(clips.some((c) => "text" in c && c.text !== "hello")).toBe(false);
    expect(JSON.stringify(r.events())).not.toMatch(/hunter2|vaultpw1/);
  });

  it("Ctrl+Alt+Shift+T asks what you are doing; keys typed into the prompt are not input", async () => {
    let reply: (v: string | null) => void = () => {};
    const asked: string[] = [];
    const r = setup({
      ask: (q) => {
        asked.push(q);
        return new Promise((res) => {
          reply = res;
        });
      },
    });
    const hot = (t: number) =>
      r.raw({ type: "keydown", t, key: "t", mods: ["ctrl", "alt", "shift"] });
    hot(100);
    r.typeText(200, "fixing  the\nbuild");
    reply("fixing  the\nbuild ");
    await new Promise((res) => setImmediate(res));
    hot(3000);
    reply("");
    await new Promise((res) => setImmediate(res));
    hot(4000);
    reply(null);
    await new Promise((res) => setImmediate(res));
    await r.rec.stop();
    expect(asked).toEqual(["What are you doing?", "What are you doing?", "What are you doing?"]);
    const ev = r.events();
    expect(ev.filter((e) => e.kind === "task")).toEqual([
      expect.objectContaining({ goal: "fixing the build", t: 200 + 16 * 30 }), // when answered
      expect.objectContaining({ goal: "", done: true, t: 3000 }),
    ]);
    expect(ev.some((e) => e.kind === "text" || e.kind === "key")).toBe(false);
  });

  it("task() opens the prompt as the hotkey does (the control socket's task op)", async () => {
    const asked: string[] = [];
    const r = setup({
      ask: async (q) => {
        asked.push(q);
        return "e2e task";
      },
    });
    r.at(500);
    await r.rec.task();
    await r.rec.stop();
    expect(asked).toEqual(["What are you doing?"]);
    expect(r.events()).toEqual([
      expect.objectContaining({ kind: "task", goal: "e2e task", t: 500 }),
    ]);
  });

  it("a page snapshot over 2 KB is stored as trees/<n>.txt and named by treeFile", async () => {
    const r = setup();
    const page = "heading Docs\n".repeat(400);
    const base = { kind: "web", act: "snapshot", tab: 1, frame: 0, url: "https://x.test/" };
    expect(r.rec.external({ ...base, tree: page })).toEqual({ written: true });
    expect(r.rec.external({ ...base, tree: "small" })).toEqual({ written: true });
    await r.rec.stop();
    const [big, small] = r.events();
    expect(big).toMatchObject({ kind: "web", treeFile: 0 });
    expect(big).not.toHaveProperty("tree");
    expect(small).toMatchObject({ tree: "small" });
    expect(r.file("000", "trees/0.txt")).toBe(page);
  });
});

describe("recorder quality", () => {
  it("a level event first, then one at each change", async () => {
    let busy = false;
    const r = setup({
      deps: {
        power: async () => ({ ac: true, battery: 90 }),
        busy: () => ({ busy, why: busy ? "load 0.95 per core" : "load 0.10 per core" }),
      },
    });
    await r.rec.settled();
    await r.rec.levelTick();
    busy = true;
    r.at(10_000);
    await r.rec.levelTick();
    await r.rec.stop();
    const levels = r.events(true).filter((e) => e.kind === "level");
    expect(levels).toMatchObject([
      { kind: "level", level: "full", why: "on AC, load 0.10 per core" },
      { kind: "level", level: "lean", why: "system busy: load 0.95 per core" },
    ]);
    expect(r.rec.status()).toMatchObject({ level: "lean", why: "system busy: load 0.95 per core" });
  });

  it("a helper over the memory cap is restarted, with a restart event", async () => {
    const recycled: [string, string][] = [];
    let probeMb = 120;
    let up = true;
    const r = setup({
      deps: {
        helperUsage: async () => ({
          probe: { cpuMs: 10, rssMb: 14, footprintMb: probeMb },
          shots: { cpuMs: 10, rssMb: 60 }, // no footprint (Windows, Linux): RSS counts
        }),
        recycleHelper: (h, why) => {
          recycled.push([h, why]);
          return up;
        },
      },
    });
    await r.rec.levelTick();
    expect(recycled).toEqual([]);
    probeMb = 1020; // RSS stays low: the footprint is what counts
    await r.rec.levelTick();
    up = false; // the restart was refused (down, or up under a minute): no event
    await r.rec.levelTick();
    await r.rec.stop();
    expect(recycled).toEqual([
      ["probe", "memory 1020 MB over the 300 MB cap"],
      ["probe", "memory 1020 MB over the 300 MB cap"],
    ]);
    expect(r.events(true).filter((e) => e.kind === "restart")).toMatchObject([
      { kind: "restart", helper: "probe", why: "memory 1020 MB over the 300 MB cap", mb: 1020 },
    ]);
    expect(r.rec.status().memoryRestarts).toMatchObject({
      count: 1,
      last: { helper: "probe", why: "memory 1020 MB over the 300 MB cap" },
    });
  });

  it("the cap is configurable and counts RSS where there is no footprint", async () => {
    const recycled: string[] = [];
    const r = setup({
      deps: {
        helperCapMb: 50,
        helperUsage: async () => ({
          probe: { cpuMs: 1, rssMb: 20 },
          shots: { cpuMs: 1, rssMb: 60 },
        }),
        recycleHelper: (h) => {
          recycled.push(h);
          return true;
        },
      },
    });
    await r.rec.levelTick();
    await r.rec.stop();
    expect(recycled).toEqual(["shots"]);
  });

  it("a pinned level holds", async () => {
    const r = setup({ deps: { pinned: "lean", busy: () => ({ busy: false, why: "calm" }) } });
    await r.rec.levelTick();
    await r.rec.stop();
    expect(r.events(true).filter((e) => e.kind === "level")).toMatchObject([
      { level: "lean", why: "pinned (AUTOTRACK_LEVEL)" },
    ]);
  });

  it("a click: fresh before at button-down, settled after, approach path, crop", async () => {
    const r = setup({ clocked: true });
    r.raw({ type: "move", t: 100, x: 10, y: 10 });
    r.raw({ type: "move", t: 300, x: 30, y: 40 });
    r.raw({ type: "move", t: 450, x: 49, y: 59 });
    r.raw({ type: "move", t: 455, x: 50, y: 60 }); // dropped by the 20 Hz fold, kept in the path
    await r.rec.ringTick();
    r.still(true);
    r.raw({ type: "down", t: 500, x: 50, y: 60, button: "left" });
    r.raw({ type: "up", t: 520, x: 50, y: 60, button: "left" });
    await r.rec.settled();
    await r.rec.stop();
    expect(r.grabsAt).toContain(500); // grabbed at button-down
    const click = r.events().find((e) => e.kind === "click") as Event & Record<string, unknown>;
    expect(click).toMatchObject({ before: expect.any(Number), after: expect.any(Number) });
    expect(click.before).not.toBe(click.after);
    expect(click.settle).toBe(150); // the first still grab at 670, 150 ms after the up
    expect(click.settled).toBeUndefined();
    expect(click.path).toEqual([
      [-400, 10, 10],
      [-200, 30, 40],
      [-50, 49, 59],
      [-45, 50, 60],
    ]);
    expect(click.crop).toBe(0);
    expect(r.crops).toMatchObject([{ x: 50, y: 60, size: 256 }]);
    const seg = readdirSync(r.rec.journal.dir).find((n) => /^\d+$/.test(n)) as string;
    expect(readdirSync(join(r.rec.journal.dir, seg, "crops"))).toEqual(["0.jpg"]);
    const stats = JSON.parse(r.file(seg, "stats.json"));
    expect(stats).toMatchObject({ crops: 1, nullElement: 0, events: { click: 1 } });
    expect(stats.movesDropped).toBe(1);
  });

  it("a drag's path adds the moves while the button was held", async () => {
    const r = setup();
    r.raw({ type: "move", t: 100, x: 10, y: 10 });
    r.raw({ type: "down", t: 200, x: 10, y: 10, button: "left" });
    r.raw({ type: "move", t: 260, x: 40, y: 10 });
    r.raw({ type: "move", t: 320, x: 80, y: 12 });
    r.raw({ type: "up", t: 380, x: 80, y: 12, button: "left" });
    await r.rec.stop();
    const drag = r.events().find((e) => e.kind === "drag") as Event & Record<string, unknown>;
    expect(drag.path).toEqual([
      [-100, 10, 10],
      [60, 40, 10],
      [120, 80, 12],
    ]);
  });

  it("no crop on a secure element, nor at lean; secure frames are never read", async () => {
    const reads: string[] = [];
    const r = setup({
      at: () => ({ element: field(true) }),
      deps: {
        ocr: (): OcrReader => ({
          read: async (p) => {
            reads.push(p);
            return { lines: [], w: 1, h: 1 };
          },
          close: () => {},
        }),
      },
    });
    r.click(100);
    await r.rec.settled();
    const click = r.events().find((e) => e.kind === "click") as Event & Record<string, unknown>;
    expect(click.crop).toBeUndefined();
    const seg = join(r.rec.journal.dir, r.rec.journal.segment);
    expect(readdirSync(join(seg, "crops"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(seg, "ocr", `${click.before}.json`), "utf8"))).toEqual({
      skipped: "secure",
    });
    await r.rec.stop();

    const lean = setup({ deps: { pinned: "lean" } });
    await lean.rec.levelTick();
    lean.click(100);
    await lean.rec.stop();
    expect(lean.crops).toEqual([]);
    const c = lean.events().find((e) => e.kind === "click") as Event & Record<string, unknown>;
    expect(c.settle).toBeUndefined();
  });

  it("a shot event per written frame: grab time and the cursor then", async () => {
    const r = setup();
    r.raw({ type: "move", t: 100, x: 20, y: 30 });
    r.click(200, 20, 30);
    await r.rec.stop();
    const all = r.events(true);
    const shots = all.filter((e) => e.kind === "shot") as Extract<Event, { kind: "shot" }>[];
    const click = all.find((e) => e.kind === "click") as Extract<Event, { kind: "click" }>;
    expect(shots.map((s) => s.frame).sort()).toEqual([click.before, click.after].sort());
    expect(shots.find((s) => s.frame === click.before)).toMatchObject({
      at: 200,
      x: 20,
      y: 30,
      display: "1",
    });
    const ts = all.map((e) => e.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it("stats.json per segment and totals in session.json; .done waits for OCR", async () => {
    let reads = 0;
    const r = setup({
      deps: {
        ocr: () => ({
          read: async () => {
            reads++;
            return { lines: [{ text: "Submit", x: 1, y: 2, w: 3, h: 4, conf: 1 }], w: 64, h: 36 };
          },
          close: () => {},
        }),
      },
    });
    r.click(100);
    await r.rec.settled();
    const seg = join(r.rec.journal.dir, r.rec.journal.segment);
    r.at(60_000); // idle 20 s and more
    r.rec.ocr?.tick();
    await new Promise((res) => setTimeout(res, 10));
    expect(reads).toBeGreaterThan(0);
    await r.rec.stop();
    expect(existsSync(join(seg, ".done"))).toBe(true);
    const stats = JSON.parse(readFileSync(join(seg, "stats.json"), "utf8"));
    expect(stats.ocr.done).toBe(reads);
    expect(stats.frames.saved).toBeGreaterThan(0);
    const meta = JSON.parse(readFileSync(join(r.rec.journal.dir, "session.json"), "utf8"));
    expect(meta.totals.ocr.done).toBe(reads);
    expect(meta.totals.frames.saved).toBe(stats.frames.saved);
  });

  it("input stops OCR within the input call", async () => {
    let closed = 0;
    let started = 0;
    const r = setup({
      deps: {
        ocr: () => {
          started++;
          let hold: (v: null) => void = () => {};
          return {
            read: () =>
              new Promise((res) => {
                hold = res;
              }),
            close: () => {
              closed++;
              hold(null);
            },
          };
        },
      },
    });
    r.click(100);
    await r.rec.settled();
    r.at(60_000);
    r.rec.ocr?.tick();
    await new Promise((res) => setTimeout(res, 0));
    expect(started).toBe(1);
    r.raw({ type: "move", t: 60_010, x: 1, y: 1 });
    expect(closed).toBe(1);
    await r.rec.stop();
    const seg = join(r.rec.journal.dir, "000");
    expect(existsSync(join(seg, ".done"))).toBe(false); // left for the next start
  });
});
