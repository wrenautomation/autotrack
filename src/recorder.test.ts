import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import type { App, Element, Event, Raw } from "./events.ts";
import type { ClipboardChange, FrontAnswer, TreeAnswer } from "./probe.ts";
import { outOf, type ProbeLike, Recorder } from "./recorder.ts";
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
    ) => { element: Element | null } | null;
    tree?: () => TreeAnswer | null;
    ask?: (q: string) => Promise<string | null>;
  } = {},
) {
  const sessions = mkdtempSync(join(tmpdir(), "track-recorder-"));
  dirs.push(sessions);
  let now = 1000;
  let front: FrontAnswer = { app: app("TextEdit", "com.apple.TextEdit", 10), window: win("Notes") };
  let shade = 0;
  let still = false; // the screen stops changing
  let onClip: (c: ClipboardChange) => void = () => {};
  let onRaw: (r: Raw) => void = () => {};
  const notes: string[] = [];
  const probe: ProbeLike = {
    available: true,
    running: true,
    at: async (x, y, ms, wait) =>
      opts.at
        ? opts.at(x, y, ms, wait)
        : { element: { ...field(false), role: "button", name: "OK" } },
    front: async () => front,
    focused: async () => (opts.focused ? opts.focused() : { element: field(false) }),
    perm: async () => ({ accessibility: true, screen: true, input: true }),
    ...(opts.tree ? { tree: async () => (opts.tree as () => TreeAnswer | null)() } : {}),
    watchClipboard: (fn) => {
      onClip = fn;
    },
    close: () => {},
  };
  const capturer: Capturer = {
    displays: () => [{ id: "1", x: 0, y: 0, width: 64, height: 36, scale: 1, primary: true }],
    grab: async () => {
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
    sleep: async () => {},
  });
  rec.start();
  const at = (t: number) => {
    now = 1000 + t;
  };
  const raw = (r: Raw) => {
    at(r.t);
    onRaw({ ...r, t: 1000 + r.t } as Raw);
  };
  const events = (): Event[] => {
    const out: Event[] = [];
    for (const seg of readdirSync(rec.journal.dir)
      .filter((n) => /^\d+$/.test(n))
      .sort())
      for (const l of readFileSync(join(rec.journal.dir, seg, "events.jsonl"), "utf8").split("\n"))
        if (l) out.push(JSON.parse(l));
    return out;
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

  it("a click's element gets 3 s; a null is asked once more with the helper waiting 1 s", async () => {
    const asks: [number | undefined, number | undefined][] = [];
    const r = setup({
      at: (_x, _y, ms, wait) => {
        asks.push([ms, wait]);
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
      [3000, undefined],
      [3000, 1000],
    ]);
    expect(r.events()[0]).toMatchObject({ kind: "click", element: { role: "textarea" } });
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
      expect.objectContaining({ goal: "fixing the build", t: 100 }),
      expect.objectContaining({ goal: "", done: true, t: 3000 }),
    ]);
    expect(ev.some((e) => e.kind === "text" || e.kind === "key")).toBe(false);
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
