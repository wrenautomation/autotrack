import { describe, expect, it } from "vitest";
import { page } from "./load.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (w, el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, detail: 1 }));

describe("effect errors", () => {
  it("collects console errors, uncaught errors and rejections in the window, wrapped call intact", async () => {
    const calls = [];
    const { doc, w, sent } = page(`<button id="b">Go</button>`, {
      setup: (win) => {
        win.console.error = (...a) => calls.push(a);
      },
    });
    // Before any act: nothing is open, nothing is kept.
    w.console.error("too early");
    click(w, doc.getElementById("b"));
    w.console.error("Failed to save", { id: 1 }, new w.Error("boom"));
    w.dispatchEvent(
      new w.ErrorEvent("error", {
        message: "Uncaught TypeError: x",
        error: new w.TypeError("x is not a function"),
      }),
    );
    const rej = new w.Event("unhandledrejection");
    rej.reason = new w.Error("fetch failed");
    w.dispatchEvent(rej);
    // A repeat, a resource error (target is the element) and a secret in a message.
    w.console.error("Failed to save", { id: 1 }, new w.Error("boom"));
    const img = doc.createElement("img");
    doc.body.append(img);
    img.dispatchEvent(new w.Event("error"));
    w.console.error("auth sk-abcdefghijklmnopqrstuvwxyz failed");
    await sleep(1100);
    const effect = sent.find((e) => e.act === "effect");
    expect(effect.effects.errors).toEqual([
      { message: "Failed to save [object] Error: boom", source: "console" },
      { message: "TypeError: x is not a function", source: "uncaught" },
      { message: "Error: fetch failed", source: "rejection" },
      { message: "auth <redacted> failed", source: "console" },
    ]);
    // The page's own console.error still ran, with its arguments.
    expect(calls.map((a) => a[0])).toEqual([
      "too early",
      "Failed to save",
      "Failed to save",
      "auth sk-abcdefghijklmnopqrstuvwxyz failed",
    ]);
    // Later errors are not in a closed window.
    w.console.error("after");
    await sleep(30);
    expect(sent.filter((e) => e.act === "effect")).toHaveLength(1);
  });

  it("sends an empty list when the page was quiet, and caps a flood", async () => {
    const { doc, w, sent } = page(`<button id="b">Go</button>`);
    click(w, doc.getElementById("b"));
    await sleep(1100);
    expect(sent.find((e) => e.act === "effect").effects.errors).toEqual([]);
    sent.length = 0;
    click(w, doc.getElementById("b"));
    for (let i = 0; i < 30; i++) w.console.error(`e${i}`);
    await sleep(1100);
    const errs = sent.find((e) => e.act === "effect").effects.errors;
    expect(errs).toHaveLength(10); // the page world sends 10 a second
    expect(errs[0].message).toBe("e0");
  });

  it("ignores a forged error event from a page without the nonce", async () => {
    const { doc, w, sent } = page(`<button id="b">Go</button>`);
    click(w, doc.getElementById("b"));
    doc.dispatchEvent(
      new w.CustomEvent("autotrack-e-0", { detail: '{"source":"console","message":"fake"}' }),
    );
    await sleep(1100);
    expect(sent.find((e) => e.act === "effect").effects.errors).toEqual([]);
  });
});

describe("clipboard", () => {
  const paste = (w, el, data, types = ["text/plain"]) => {
    const ev = new w.Event("paste", { bubbles: true });
    Object.defineProperty(ev, "clipboardData", { value: { getData: () => data, types } });
    el.dispatchEvent(ev);
  };
  const selectText = (w, node) => {
    const r = w.document.createRange();
    r.selectNodeContents(node);
    const s = w.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  };

  it("copy: the selected text and its element", () => {
    const { doc, w, sent } = page(
      `<article><p id="p">Invoice 4411 is due <b>Friday</b></p></article>`,
    );
    selectText(w, doc.getElementById("p"));
    doc.getElementById("p").dispatchEvent(new w.Event("copy", { bubbles: true }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: "web",
      act: "copy",
      text: "Invoice 4411 is due Friday",
      length: 26,
      target: { tag: "p", id: "p" },
    });
    expect(sent[0].redacted).toBeUndefined();
  });

  it("copy and cut in a field use the field's selection; nothing selected sends nothing", async () => {
    const { doc, w, sent } = page(`<input id="i" value="hello world">`);
    const i = doc.getElementById("i");
    i.focus();
    i.dispatchEvent(new w.Event("copy", { bubbles: true }));
    expect(sent).toEqual([]);
    i.setSelectionRange(6, 11);
    i.dispatchEvent(new w.Event("copy", { bubbles: true }));
    i.dispatchEvent(new w.Event("cut", { bubbles: true }));
    expect(sent.map((e) => [e.act, e.text, e.target.id])).toEqual([
      ["copy", "world", "i"],
      ["cut", "world", "i"],
    ]);
    // A cut opens an effect window; a copy does not close one.
    await sleep(1100);
    expect(sent.filter((e) => e.act === "effect")).toHaveLength(1);
  });

  it("paste: the text, masked where secret-shaped, capped at 2,000", () => {
    const { doc, w, sent: all } = page(`<textarea id="t"></textarea>`);
    const t = doc.getElementById("t");
    paste(w, t, "see sk-abcdefghijklmnopqrstuvwxyz and 4111 1111 1111 1111 ok");
    paste(w, t, "lorem ipsum ".repeat(250));
    paste(w, t, "ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    paste(w, t, "", ["Files"]);
    const sent = all.filter((e) => e.act === "paste");
    expect(sent[0]).toMatchObject({
      act: "paste",
      text: "see <redacted> and <redacted> ok",
      redacted: true,
      types: ["text/plain"],
    });
    expect(sent[1].text).toHaveLength(2000);
    expect(sent[1].length).toBeGreaterThan(2000);
    // A lone token is hidden whole.
    expect(sent[2]).toMatchObject({ act: "paste", redacted: true });
    expect(sent[2].text).toBeUndefined();
    expect(sent[3]).toMatchObject({ text: "", length: 0, types: ["Files"] });
  });

  it("never records a password field's clipboard", () => {
    const { doc, w, sent } = page(
      `<label for="p">Password</label><input id="p" type="password" value="hunter2-SECRET">`,
    );
    const p = doc.getElementById("p");
    p.focus();
    p.setSelectionRange(0, 8);
    p.dispatchEvent(new w.Event("copy", { bubbles: true }));
    p.dispatchEvent(new w.Event("cut", { bubbles: true }));
    paste(w, p, "pasted-SECRET-text");
    expect(sent.filter((e) => e.act !== "effect").map((e) => [e.act, e.redacted, e.text])).toEqual([
      ["copy", true, undefined],
      ["cut", true, undefined],
      ["paste", true, undefined],
    ]);
    expect(JSON.stringify(sent)).not.toMatch(/hunter2|SECRET/);
  });

  it("ignores script-made clipboard events", () => {
    const { doc, w, sent } = page(`<p id="p">text</p>`, { trusted: false });
    selectText(w, doc.getElementById("p"));
    doc.getElementById("p").dispatchEvent(new w.Event("copy", { bubbles: true }));
    expect(sent).toEqual([]);
  });
});

describe("select", () => {
  const up = (w, el) =>
    el.dispatchEvent(new w.MouseEvent("mouseup", { bubbles: true, screenX: 40, screenY: 60 }));
  const selectText = (w, node) => {
    const r = w.document.createRange();
    r.selectNodeContents(node);
    const s = w.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  };

  it("records the selection on mouse up, once, ≤ 500 chars, with the mouse point", () => {
    const { doc, w, sent } = page(`<p id="p">${"word ".repeat(200)}</p><p id="q">other</p>`);
    const p = doc.getElementById("p");
    selectText(w, p);
    up(w, p);
    up(w, p); // same selection again: said once
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ act: "select", x: 40, y: 60, target: { tag: "p", id: "p" } });
    expect(sent[0].text).toHaveLength(500);
    expect(sent[0].length).toBe(999);
    w.getSelection().removeAllRanges();
    up(w, p); // collapsed: nothing, and the same text can be selected again
    selectText(w, doc.getElementById("q"));
    up(w, doc.getElementById("q"));
    expect(sent.map((e) => e.text.slice(0, 5))).toEqual(["word ", "other"]);
  });

  it("is a gesture that changed the selection: a click with text still selected is not one", () => {
    const { doc, w, sent } = page(`<p id="p">some words here</p><button id="b">Go</button>`);
    const down = (el) => el.dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true }));
    const p = doc.getElementById("p");
    down(p);
    selectText(w, p); // the drag
    up(w, p);
    expect(sent).toHaveLength(1);
    // Click a button while the text stays selected.
    down(doc.getElementById("b"));
    up(w, doc.getElementById("b"));
    expect(sent).toHaveLength(1);
    // Collapse it, then select the same text again: said again.
    down(p);
    w.getSelection().removeAllRanges();
    up(w, p);
    down(p);
    selectText(w, p);
    up(w, p);
    expect(sent).toHaveLength(2);
  });

  it("masks secrets in the text and says nothing of a password field's", () => {
    const { doc, w, sent } = page(
      `<p id="p">my key is sk-abcdefghijklmnopqrstuvwxyz ok</p><label for="pw">Password</label><input id="pw" type="password" value="hunter2-SECRET">`,
    );
    selectText(w, doc.getElementById("p"));
    up(w, doc.getElementById("p"));
    const pw = doc.getElementById("pw");
    pw.focus();
    pw.setSelectionRange(0, 6);
    up(w, pw);
    expect(sent[0]).toMatchObject({ text: "my key is <redacted> ok", redacted: true });
    expect(sent[1]).toMatchObject({ act: "select", redacted: true });
    expect(sent[1].text).toBeUndefined();
    expect(JSON.stringify(sent)).not.toMatch(/hunter2|SECRET|abcdefghij/);
  });
});

describe("outline", () => {
  const outline = (html, o) => {
    const { AT, doc } = page(html);
    return AT.outline.snapshot(doc, o);
  };

  it("reads roles and names, keeps structure, drops what is hidden", () => {
    const tree = outline(`
      <header><nav aria-label="Main"><a href="/inbox">Inbox</a><a href="/sent?token=abc">Sent</a></nav></header>
      <main>
        <h1>Messages</h1>
        <p>3 unread</p>
        <ul><li><button>Reply</button></li><li><button aria-label="Archive thread">x</button></li></ul>
        <label for="n">Company</label><input id="n" value="Acme private">
        <input type="checkbox" checked aria-label="Notify me"><button disabled>Send</button>
        <div hidden>never</div><div style="display:none">no</div><div aria-hidden="true">nope</div>
        <script>var x = "code"</script><style>p{}</style>
        <textarea>draft text</textarea><select><option>One</option></select>
        <div contenteditable="true">typed here</div>
      </main>`);
    expect(tree.split("\n")).toEqual([
      "- banner:",
      '  - navigation "Main":',
      '    - link "Inbox"',
      '    - link "Sent"',
      "- main:",
      '  - heading "Messages" [level=1]',
      "  - text: 3 unread",
      "  - list:",
      "    - listitem:",
      '      - button "Reply"',
      "    - listitem:",
      '      - button "Archive thread"',
      '  - textbox "Company"',
      '  - checkbox "Notify me" [checked]',
      '  - button "Send" [disabled]',
      "  - textbox",
      "  - combobox",
      "  - textbox",
    ]);
    expect(tree).not.toMatch(/Acme private|draft text|never|One|typed here|token/);
  });

  it("never carries a password, and masks secrets in text and names", () => {
    const tree = outline(`
      <label for="p">Password</label><input id="p" type="password" value="hunter2-SECRET">
      <p>key sk-abcdefghijklmnopqrstuvwxyz</p><button>Pay 4111 1111 1111 1111</button>`);
    expect(tree).toContain('- textbox "Password"');
    expect(tree).toContain("- text: key <redacted>");
    expect(tree).toContain('- button "Pay <redacted>"');
    expect(tree).not.toMatch(/hunter2|SECRET|abcdefghij|4111/);
  });

  it("walks open shadow roots and skips iframes", () => {
    const { AT, doc } = page(`<div id="h"></div><iframe></iframe>`);
    const root = doc.getElementById("h").attachShadow({ mode: "open" });
    root.innerHTML = `<button>In shadow</button>`;
    expect(AT.outline.snapshot(doc)).toBe('- button "In shadow"');
  });

  it("stops at the character and byte caps, whole lines only", () => {
    const html = Array.from({ length: 200 }, (_, i) => `<button>Item ${i}</button>`).join("");
    const byChars = outline(html, { maxChars: 500 });
    expect(byChars.length).toBeLessThanOrEqual(500);
    expect(byChars.split("\n").every((l) => /^- button "Item \d+"$/.test(l))).toBe(true);
    // CJK text is 3 bytes a character: the byte cap bites first.
    const cjk = Array.from({ length: 200 }, () => `<p>${"字".repeat(100)}</p>`).join("");
    const byBytes = outline(cjk, { maxBytes: 3000 });
    expect(new TextEncoder().encode(JSON.stringify(byBytes)).length).toBeLessThanOrEqual(3000);
    expect(byBytes.length).toBeGreaterThan(0);
    // The shipped caps fit a control line.
    const huge = outline(
      Array.from({ length: 3000 }, (_, i) => `<p>line "${i}" ${"é".repeat(60)}</p>`).join(""),
    );
    expect(huge.length).toBeLessThanOrEqual(30000);
    expect(JSON.stringify({ tree: huge }).length).toBeLessThan(60000);
  });

  it("keeps a table, drops empty containers, keeps a wrapped control", () => {
    const tree = outline(
      `<ul><li></li></ul><label><input type="checkbox"> Remember me</label><table><tr><td>A</td><td><a href="#">B</a></td></tr></table>`,
    );
    expect(tree.split("\n")).toEqual([
      '- checkbox "Remember me"',
      "- table:",
      "  - row:",
      "    - cell:",
      "      - text: A",
      "    - cell:",
      '      - link "B"',
    ]);
  });
});

describe("snapshot event", () => {
  it("is sent once the page has loaded, in the top frame, with the tree", async () => {
    const { sent } = page(`<main><h1>Hello</h1><button>Go</button></main>`);
    await sleep(100);
    const snaps = sent.filter((e) => e.act === "snapshot");
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      kind: "web",
      act: "snapshot",
      url: "https://app.example.com/inbox?token=%3Credacted%3E&tab=2",
    });
    expect(snaps[0].tree).toBe('- main:\n  - heading "Hello" [level=1]\n  - button "Go"');
  });

  it("follows an effect with more than 20 DOM changes, 2 s after the first; a small one adds none", async () => {
    const { doc, w, sent } = page(`<main id="m"><button id="b">Go</button></main>`);
    await sleep(100);
    click(w, doc.getElementById("b"));
    doc.getElementById("m").append(doc.createElement("p"));
    await sleep(1100);
    expect(sent.filter((e) => e.act === "effect")).toHaveLength(1);
    expect(sent.filter((e) => e.act === "snapshot")).toHaveLength(1);
    sent.length = 0;
    click(w, doc.getElementById("b"));
    for (let i = 0; i < 25; i++) {
      const row = doc.createElement("button");
      row.textContent = `Row ${i}`;
      doc.getElementById("m").append(row);
    }
    await sleep(1100);
    const effects = sent.filter((e) => e.act === "effect");
    expect(effects).toHaveLength(1);
    // The load snapshot was under 2 s ago: this one waits for the gap.
    await sleep(1000);
    const snaps = sent.filter((e) => e.act === "snapshot");
    expect(snaps).toHaveLength(1);
    expect(snaps[0].tree).toContain('- button "Row 24"');
    expect(sent.indexOf(effects[0])).toBeLessThan(sent.indexOf(snaps[0]));
  }, 10_000);
});
