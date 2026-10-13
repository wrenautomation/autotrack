import { describe, expect, it } from "vitest";
import { page } from "./load.mjs";

const load = (html) => {
  const p = page(html, {
    files: ["content/redact.js", "content/hints.js"],
    order: "isolated-only",
  });
  return { ...p, H: p.AT.hints, R: p.AT.redact, $: (s) => p.doc.querySelector(s) };
};

describe("role and name", () => {
  it("takes the name in order: labelledby, aria-label, label, alt, title, placeholder, text", () => {
    const { H, $ } = load(`
      <span id="l1">Billing</span><span id="l2">email</span>
      <input id="a" aria-labelledby="l1 l2" aria-label="ignored">
      <input id="b" aria-label="Search orders">
      <label for="c">Full name</label><input id="c" placeholder="ignored">
      <label>Wrapped <input id="d"></label>
      <img id="e" alt="Logo" title="ignored">
      <div id="f" title="Close panel">x</div>
      <input id="g" placeholder="Type a reply">
      <button id="h"><svg></svg>  Send
        now </button>
      <input id="i" type="submit" value="Save">
      <a id="j" href="/x">Docs</a>
    `);
    expect(H.name($("#a"))).toBe("Billing email");
    expect(H.name($("#b"))).toBe("Search orders");
    expect(H.name($("#c"))).toBe("Full name");
    expect(H.name($("#d"))).toBe("Wrapped");
    expect(H.name($("#e"))).toBe("Logo");
    expect(H.name($("#f"))).toBe("Close panel");
    expect(H.name($("#g"))).toBe("Type a reply");
    expect(H.name($("#h"))).toBe("Send now");
    expect(H.name($("#i"))).toBe("Save");
    expect(H.name($("#j"))).toBe("Docs");
    expect(H.role($("#j"))).toBe("link");
    expect(H.role($("#i"))).toBe("button");
    expect(H.role($("#g"))).toBe("textbox");
  });

  it("reads explicit and implicit roles", () => {
    const { H, $ } = load(`
      <div id="a" role="tab menuitem">A</div><a id="b">no href</a><select id="c"></select>
      <select id="d" multiple></select><input id="e" type="checkbox"><div id="f" contenteditable="true"></div>
      <input id="g" type="range"><h2 id="h">Hi</h2><img id="i" alt="">
    `);
    expect(H.role($("#a"))).toBe("tab");
    expect(H.role($("#b"))).toBe("");
    expect(H.role($("#c"))).toBe("combobox");
    expect(H.role($("#d"))).toBe("listbox");
    expect(H.role($("#e"))).toBe("checkbox");
    expect(H.role($("#f"))).toBe("textbox");
    expect(H.role($("#g"))).toBe("slider");
    expect(H.role($("#h"))).toBe("heading");
    expect(H.role($("#i"))).toBe("presentation");
  });
});

describe("css path and xpath", () => {
  const html = `
    <div id="app"><ul>${"<li><button>Go</button><button>Stop</button></li>".repeat(6)}</ul>
    <section><p><span>a</span><span>b</span></p><p><span>a</span></p></section>
    <button data-testid="save">Save</button><button data-testid="dup">1</button><button data-testid="dup">2</button>
    <div id="x:1.y">odd id</div><div id="twin">1</div><div id="twin">2</div>
    <svg><g><circle></circle><circle></circle></g></svg></div>`;

  it("finds a selector that matches only that element, for every element", () => {
    const { H, doc } = load(html);
    const all = [...doc.querySelectorAll("body *")];
    for (const el of all) {
      const sel = H.cssPath(el);
      const hits = doc.querySelectorAll(sel);
      expect(hits.length, sel).toBe(1);
      expect(hits[0], sel).toBe(el);
    }
  });

  it("prefers id and test id, keeps paths short", () => {
    const { H, $, doc } = load(html);
    expect(H.cssPath($("#app"))).toBe("#app");
    expect(H.cssPath($("[data-testid=save]"))).toBe('[data-testid="save"]');
    const stop = doc.querySelectorAll("li")[3].querySelectorAll("button")[1];
    expect(H.cssPath(stop)).toBe("li:nth-of-type(4) > button:nth-of-type(2)");
    expect(H.cssPath(doc.getElementById("x:1.y"))).toMatch(
      /^#x\\3a 1\\.y|^#x\\:1\\.y|^#x\\3a 1\\2e y/,
    );
  });

  // jsdom's XPath has no functions in predicates; the e2e evaluates SVG paths in Chromium.
  it("gives an xpath that evaluates back to the element, SVG by local-name()", () => {
    const { H, doc, w } = load(html);
    for (const el of doc.querySelectorAll("body *")) {
      if (el.namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
      const xp = H.xpath(el);
      const r = doc.evaluate(xp, doc, null, w.XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      expect(r.singleNodeValue, xp).toBe(el);
    }
    const circle = doc.querySelectorAll("circle")[1];
    expect(H.xpath(circle)).toMatch(/\*\[local-name\(\)="circle"\]\[2\]$/);
  });
});

describe("target", () => {
  it("collects text ≤ 200, ids, href without secrets, attrs without values", () => {
    const { H, $ } = load(`
      <a id="go" data-testid="next" href="/reset?token=abcdef&page=2" aria-expanded="false"
         data-row="12" data-value="hidden" aria-valuenow="3" data-api-key="k" data-long="${"z ".repeat(60)}">
         ${"word ".repeat(80)}</a>`);
    const t = H.target($("#go"));
    expect(t.tag).toBe("a");
    expect(t.role).toBe("link");
    expect(t.text.length).toBeLessThanOrEqual(200);
    expect(t.id).toBe("go");
    expect(t.testId).toBe("next");
    expect(t.href).toBe("https://app.example.com/reset?token=%3Credacted%3E&page=2");
    expect(t.attrs["aria-expanded"]).toBe("false");
    expect(t.attrs["data-row"]).toBe("12");
    expect(t.attrs["data-value"]).toBeUndefined();
    expect(t.attrs["aria-valuenow"]).toBeUndefined();
    expect(t.attrs["data-api-key"]).toBe("<redacted>");
    expect(t.attrs["data-long"].length).toBe(80);
    expect(t.css).toBe("#go");
    expect(t.xpath).toBe("/html/body/a");
  });

  it("never puts a field's value in text", () => {
    const { H, $ } = load(
      `<textarea id="t">my draft</textarea><div id="e" contenteditable>secret plans</div>`,
    );
    expect(H.target($("#t")).text).toBeUndefined();
    expect(H.target($("#e")).text).toBeUndefined();
  });
});

describe("field values", () => {
  it("redacts by field and by value", () => {
    const { H, $ } = load(`
      <input id="pw" type="password" value="hunter2">
      <input id="shown" type="text" name="password" value="hunter2">
      <input id="ac" autocomplete="one-time-code" value="123456">
      <label for="lab">Enter your PIN</label><input id="lab" value="9999">
      <input id="tok" value="sk-abcdefghijklmnopqrstuvwxyz123456">
      <input id="note" value="pay 4242 4242 4242 4242 now">
      <input id="ok" value="Acme Plumbing">
      <input id="cb" type="checkbox" checked>
      <select id="sel"><option>One</option><option selected>Two</option></select>
      <div id="long" contenteditable>${"x".repeat(250)}</div>
      <div id="short" contenteditable>hello</div>
    `);
    expect(H.fieldValue($("#pw"))).toEqual({ redacted: true });
    expect(H.fieldValue($("#shown"))).toEqual({ redacted: true });
    expect(H.fieldValue($("#ac"))).toEqual({ redacted: true });
    expect(H.fieldValue($("#lab"))).toEqual({ redacted: true });
    expect(H.fieldValue($("#tok"))).toEqual({ redacted: true, length: 35 });
    expect(H.fieldValue($("#note"))).toEqual({
      value: "pay <redacted> now",
      redacted: true,
      length: 27,
    });
    expect(H.fieldValue($("#ok"))).toEqual({ value: "Acme Plumbing", length: 13 });
    expect(H.fieldValue($("#cb"))).toEqual({ value: true });
    expect(H.fieldValue($("#sel"))).toEqual({ value: "Two", length: 3 });
    expect(H.fieldValue($("#long"))).toEqual({ length: 250 });
    expect(H.fieldValue($("#short"))).toEqual({ value: "hello", length: 5 });
  });

  it("redacts credential query params, URL logins and token fragments", () => {
    const { R } = load("");
    expect(R.redactUrl("https://u:p@x.com/cb?code=abc&state=s&q=hi#access_token=t")).toBe(
      "https://x.com/cb?code=%3Credacted%3E&state=%3Credacted%3E&q=hi#%3Credacted%3E",
    );
    expect(R.originPath("https://api.x.com/v1/items/9?key=abc")).toBe(
      "https://api.x.com/v1/items/9",
    );
    expect(R.originPath("data:text/plain,hi")).toBe("data:");
  });
});

describe("text", () => {
  it("skips script and style, and names a big container by nothing", () => {
    const { H, $ } =
      load(`<div id="d"><style>.a{}</style><script>var x = 1;</script><p>Hello</p> <p>there</p></div>
      <section id="big">${"<p>para graph text</p>".repeat(20)}</section><div id="small" onclick="">Archive</div>`);
    expect(H.target($("#d")).text).toBe("Hello there");
    expect(H.name($("#big"))).toBe("");
    expect(H.name($("#small"))).toBe("Archive");
  });
});
