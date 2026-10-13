import { describe, expect, it } from "vitest";
import { page } from "./load.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake React fiber tree on a button: host → SaveButton → forwardRef(Inner) → memo(Toolbar) → div → App. */
function fakeFiber(_w, el) {
  function SaveButton() {}
  function Inner() {}
  function Toolbar() {}
  class App {}
  const app = { type: App, return: null };
  const div = { type: "div", return: app };
  const memo = { type: { $$typeof: 1, type: Toolbar }, return: div };
  const fwd = { type: { $$typeof: 2, render: Inner }, return: memo };
  const save = { type: SaveButton, return: fwd };
  const host = { type: "button", return: save };
  el.__reactFiber$x7k2 = host;
  return host;
}

describe("page-world bridge", () => {
  for (const order of ["main-first", "isolated-first"]) {
    it(`walks the React chain, nearest first (${order})`, () => {
      const { doc, AT, w } = page(`<div><button id="b"><span id="s">Save</span></button></div>`, {
        order,
      });
      fakeFiber(w, doc.getElementById("b"));
      expect(AT.bridge.react(doc.getElementById("b"))).toEqual([
        "SaveButton",
        "Inner",
        "Toolbar",
        "App",
      ]);
      // A child without its own fiber uses its nearest ancestor's.
      expect(AT.bridge.react(doc.getElementById("s"))).toEqual([
        "SaveButton",
        "Inner",
        "Toolbar",
        "App",
      ]);
    });
  }

  it("caps the chain at 12 and drops repeats", () => {
    const { doc, AT } = page(`<button id="b">x</button>`);
    let f = null;
    for (let i = 0; i < 30; i++) {
      const C = { displayName: `C${i}` };
      f = { type: C, return: f };
      f = { type: C, return: f }; // memo wrapper + inner: same name twice
    }
    doc.getElementById("b").__reactInternalInstance$old = { type: "button", return: f };
    const names = AT.bridge.react(doc.getElementById("b"));
    expect(names).toHaveLength(12);
    expect(names[0]).toBe("C29");
    expect(new Set(names).size).toBe(12);
  });

  it("answers nothing for a non-React page", () => {
    const { doc, AT } = page(`<button id="b">x</button>`);
    expect(AT.bridge.react(doc.getElementById("b"))).toEqual([]);
  });

  it("never shows the nonce to a page that asks after setup", () => {
    const { doc, AT, w } = page(`<button id="b">x</button>`);
    fakeFiber(w, doc.getElementById("b"));
    const heard = [];
    doc.addEventListener("autotrack:hello-iso", (e) => heard.push(e.detail), true);
    doc.dispatchEvent(new w.CustomEvent("autotrack:hello-main"));
    expect(heard).toEqual([]);
    // A page offering its own nonce to main.js is ignored: the real channel still answers.
    doc.dispatchEvent(new w.CustomEvent("autotrack:hello-iso", { detail: "0".repeat(32) }));
    expect(AT.bridge.react(doc.getElementById("b"))[0]).toBe("SaveButton");
  });

  it("ignores a forged reply on any channel but its own", () => {
    const { doc, AT, w } = page(`<button id="b">x</button>`, { order: "isolated-only" });
    // No main.js: a page answering on guessed names gets nowhere.
    doc.addEventListener("autotrack:hello-iso", () => {}, true);
    for (const n of ["autotrack-r-", "autotrack-r-0", "autotrack:reply"])
      doc.dispatchEvent(new w.CustomEvent(n, { detail: '["Fake"]' }));
    expect(AT.bridge.react(doc.getElementById("b"))).toBeNull();
  });
});

describe("acts", () => {
  it("records nothing from untrusted (script-made) events", async () => {
    const { doc, w, sent } = page(`<button id="b">Go</button><input id="i">`, { trusted: false });
    doc.getElementById("b").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    doc.getElementById("i").dispatchEvent(new w.Event("change", { bubbles: true }));
    doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(20);
    // The load snapshot is the page's own, not an act.
    expect(sent.filter((e) => e.act !== "snapshot")).toEqual([]);
  });

  it("records a click with screen points, target, React chain and rect", () => {
    const { doc, w, sent } = page(
      `<main><button id="b" data-testid="save-btn"><b>Save</b></button></main>`,
    );
    const b = doc.getElementById("b");
    fakeFiber(w, b);
    const at = (type, cx, cy, sx, sy, target = b) =>
      target.dispatchEvent(
        new w.MouseEvent(type, {
          bubbles: true,
          clientX: cx,
          clientY: cy,
          screenX: sx,
          screenY: sy,
          detail: 1,
        }),
      );
    // Zoom 125%: client moves 100 px, screen 125 points.
    at("pointermove", 10, 10, 112.5, 212.5);
    at("pointermove", 110, 10, 237.5, 212.5);
    at("pointerdown", 110, 10, 237.5, 212.5, b.firstChild);
    at("click", 110, 10, 237.5, 212.5, b.firstChild);
    const [down, click] = sent;
    expect(down.act).toBe("pointerdown");
    expect(click).toMatchObject({
      kind: "web",
      act: "click",
      x: 237.5,
      y: 212.5,
      button: "left",
      count: 1,
      hit: "b",
      url: "https://app.example.com/inbox?token=%3Credacted%3E&tab=2",
      target: {
        tag: "button",
        role: "button",
        name: "Save",
        testId: "save-btn",
        css: "#b",
        react: ["SaveButton", "Inner", "Toolbar", "App"],
        // jsdom lays nothing out: the rect is the client origin mapped to screen.
        rect: { x: 100, y: 200, width: 0, height: 0 },
      },
    });
    expect(typeof click.ts).toBe("number");
  });

  it("records a change with its value, and a password change without one", () => {
    const { doc, w, sent } = page(`
      <label for="n">Company</label><input id="n">
      <label for="p">Password</label><input id="p" type="password">`);
    const n = doc.getElementById("n");
    const p = doc.getElementById("p");
    n.value = "Acme Plumbing";
    n.dispatchEvent(new w.Event("change", { bubbles: true }));
    p.value = "hunter2-SECRET";
    p.dispatchEvent(new w.Event("change", { bubbles: true }));
    p.dispatchEvent(
      new w.KeyboardEvent("keydown", { key: "ß", altKey: true, code: "KeyS", bubbles: true }),
    );
    const changes = sent.filter((e) => e.act === "change");
    expect(changes[0]).toMatchObject({
      value: "Acme Plumbing",
      target: { name: "Company", inputType: "text" },
    });
    expect(changes[1]).toMatchObject({
      redacted: true,
      target: { name: "Password", inputType: "password" },
    });
    expect(changes[1].value).toBeUndefined();
    const key = sent.find((e) => e.act === "key");
    expect(key).toMatchObject({ key: "<redacted>", mods: ["alt"] });
    expect(JSON.stringify(sent)).not.toMatch(/hunter2|SECRET|ß/);
  });

  it("records an editable region on blur, length only when long", () => {
    const { doc, w, sent } = page(`<div id="e" contenteditable="true"></div>`);
    const e = doc.getElementById("e");
    e.textContent = "y".repeat(300);
    e.dispatchEvent(new w.Event("input", { bubbles: true }));
    e.dispatchEvent(new w.FocusEvent("focusout", { bubbles: true }));
    expect(sent[0]).toMatchObject({ act: "change", length: 300 });
    expect(sent[0].value).toBeUndefined();
  });

  it("records Enter/Escape/Tab and combos, not plain typing", () => {
    const { doc, w, sent } = page(`<input id="i">`);
    const i = doc.getElementById("i");
    const key = (init) =>
      i.dispatchEvent(new w.KeyboardEvent("keydown", { bubbles: true, ...init }));
    key({ key: "a", code: "KeyA" });
    key({ key: "A", shiftKey: true, code: "KeyA" });
    key({ key: "Shift", shiftKey: true });
    key({ key: "Enter", code: "Enter" });
    key({ key: "Tab", shiftKey: true, code: "Tab" });
    key({ key: "k", metaKey: true, code: "KeyK" });
    key({ key: "Escape", code: "Escape" });
    expect(sent.filter((e) => e.act === "key").map((e) => [e.key, e.mods.join("+")])).toEqual([
      ["enter", ""],
      ["tab", "shift"],
      ["k", "meta"],
      ["escape", ""],
    ]);
  });

  it("records a submit and a scroll end", async () => {
    const { doc, w, sent } = page(
      `<form id="f" aria-label="Reply"></form><div id="s" style="overflow:auto"></div>`,
    );
    doc.getElementById("f").dispatchEvent(new w.Event("submit", { bubbles: true }));
    const s = doc.getElementById("s");
    for (let i = 0; i < 5; i++) s.dispatchEvent(new w.Event("scroll"));
    await sleep(350);
    expect(sent.find((e) => e.act === "submit")).toMatchObject({
      target: { tag: "form", role: "form", name: "Reply" },
    });
    const scrolls = sent.filter((e) => e.act === "scroll");
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0]).toMatchObject({ target: { id: "s" }, scroll: { x: 0, y: 0 } });
  });

  it("sends an effect 1 s after an act with URL change and DOM counts", async () => {
    const { doc, w, sent } = page(`<button id="b">Add</button><ul id="l"><li>old</li></ul>`);
    doc.getElementById("b").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    const l = doc.getElementById("l");
    l.append(doc.createElement("li"), doc.createElement("li"));
    l.firstChild.remove();
    l.lastChild.textContent = "x";
    l.firstChild.firstChild?.replaceData?.(0, 0, "z");
    w.history.pushState({}, "", "/inbox/42");
    await sleep(1100);
    const effect = sent.find((e) => e.act === "effect");
    expect(effect).toMatchObject({
      kind: "web",
      cause: { act: "click" },
      effects: { url: "https://app.example.com/inbox/42", requests: [] },
    });
    expect(effect.effects.dom.added).toBeGreaterThanOrEqual(3);
    expect(effect.effects.dom.removed).toBeGreaterThanOrEqual(1);
  });

  it("closes an open effect early at the next act", async () => {
    const { doc, w, sent } = page(`<button id="b">Add</button>`);
    const b = doc.getElementById("b");
    b.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    b.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    expect(sent.map((e) => e.act)).toEqual(["click", "effect", "click"]);
  });
});

// jsdom's postMessage leaves `source` null; Chrome sets it to the posting window.
const post = (w, data) => w.dispatchEvent(new w.MessageEvent("message", { data, source: w }));

describe("app events", () => {
  it("validates action and detail", () => {
    const { AT } = page("");
    const ok = (data) => AT.appEvent(data);
    expect(
      ok({ autotrack: { v: 1, action: "approve-message", detail: { id: 7, ok: true } } }),
    ).toEqual({
      action: "approve-message",
      detail: { id: 7, ok: true },
    });
    expect(ok({ autotrack: { v: 1, action: "x" } })).toEqual({ action: "x", detail: null });
    expect(ok({ autotrack: { v: 2, action: "x" } })).toBeNull();
    expect(ok({ autotrack: { v: 1, action: "" } })).toBeNull();
    expect(ok({ autotrack: { v: 1, action: "a".repeat(65) } })).toBeNull();
    expect(ok({ autotrack: { v: 1, action: 5 } })).toBeNull();
    expect(ok({ autotrack: { v: 1, action: "x", detail: "d".repeat(5000) } })).toBeNull();
    const loop = {};
    loop.self = loop;
    expect(ok({ autotrack: { v: 1, action: "x", detail: loop } })).toBeNull();
    expect(
      ok({ autotrack: { v: 1, action: "x", detail: { key: "sk-abcdefghijklmnopqrstuvwxyz" } } }),
    ).toEqual({
      action: "x",
      detail: { key: "<redacted>" },
    });
    expect(ok("hello")).toBeNull();
    expect(ok({ kind: "web", act: "click" })).toBeNull();
  });

  it("forwards a posted app event and nothing a page posts as a web event", async () => {
    const { w, sent } = page("");
    post(w, { autotrack: { v: 1, action: "send-reply", detail: { thread: 3 } } });
    post(w, { autotrack: { kind: "web", act: "click", target: { tag: "button" } } });
    post(w, { kind: "web", act: "click" });
    // From another window (a frame): not this page's to say.
    w.dispatchEvent(
      new w.MessageEvent("message", { data: { autotrack: { v: 1, action: "x" } }, source: null }),
    );
    await sleep(30);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "app", action: "send-reply", detail: { thread: 3 } });
  });

  it("drops a flood past 20 a second", async () => {
    const { w, sent } = page("");
    for (let i = 0; i < 50; i++) post(w, { autotrack: { v: 1, action: "spam" } });
    await sleep(50);
    expect(sent).toHaveLength(20);
  });
});
