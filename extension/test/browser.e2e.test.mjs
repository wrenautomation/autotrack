/**
 * End to end on this Mac: Playwright's Chromium loads the unpacked extension; the native host is
 * registered in that profile's `NativeMessagingHosts/` (Chromium honors it under
 * --user-data-dir) with its control path pinned to a socket this test listens on, standing in
 * for the recorder. A real React page is clicked and typed into through Playwright (input
 * inside the browser only, never the desktop), and the relayed lines are checked.
 *
 * Playwright and React come from the sibling autobrowse checkout (AUTOTRACK_PLAYWRIGHT and
 * AUTOTRACK_REACT_FROM override). Run: pnpm e2e (in extension/).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as http } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { EXTENSION_IDS, install } from "../../host/manifests.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..");
const repo = join(ext, "..");
const from = process.env.AUTOTRACK_REACT_FROM ?? join(repo, "..", "autobrowse", "package.json");
const req = createRequire(from);
const { chromium } = req(process.env.AUTOTRACK_PLAYWRIGHT ?? "playwright");
const reactDom = dirname(req.resolve("react-dom/package.json"));
const FILES = {
  react: join(dirname(req.resolve("react/package.json")), "cjs", "react.development.js"),
  "react-dom": join(reactDom, "cjs", "react-dom.development.js"),
  "react-dom/client": join(reactDom, "cjs", "react-dom-client.development.js"),
  scheduler: join(
    dirname(createRequire(join(reactDom, "package.json")).resolve("scheduler/package.json")),
    "cjs",
    "scheduler.development.js",
  ),
};

const PAGE = `<!doctype html><html><head><title>autotrack e2e</title></head><body>
<div id="root"></div>
<form id="login" onsubmit="event.preventDefault()">
  <label for="company">Company</label><input id="company">
  <label for="pw">Password</label><input id="pw" type="password">
</form>
<svg id="art" width="60" height="60"><g><circle cx="30" cy="30" r="25" fill="red"></circle></g></svg>
<script>
  // React 19 ships CommonJS only: a tiny synchronous require over the served files.
  const cache = {};
  function require(name) {
    if (cache[name]) return cache[name].exports;
    const x = new XMLHttpRequest();
    x.open("GET", "/m/" + encodeURIComponent(name), false);
    x.send();
    const module = { exports: {} };
    cache[name] = module;
    new Function("module", "exports", "require", "process", x.responseText)(
      module, module.exports, require, { env: { NODE_ENV: "development" } });
    return module.exports;
  }
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const h = React.createElement;
  function SaveButton({ onSave }) {
    return h("button", { "data-testid": "save", onClick: onSave }, h("span", null, "Save draft"));
  }
  const Toolbar = React.memo(function Toolbar(props) {
    return h("div", { role: "toolbar", "aria-label": "Draft actions" }, h(SaveButton, props));
  });
  function App() {
    const [n, setN] = React.useState(0);
    const onSave = () => fetch("/api/save?token=SECRET123").then(() => setN((v) => v + 1));
    return h("main", null, h(Toolbar, { onSave }), h("p", { id: "count" }, "saved " + n));
  }
  createRoot(document.getElementById("root")).render(h(App));
</script></body></html>`;

let tmp;
let sock;
let lines;
let rawText = "";
let web;
let ctx;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "at-e2e-"));
  sock = join(tmp, "c.sock");
  lines = [];
  // The stand-in recorder: answers like src/control.ts.
  await new Promise((resolve) =>
    createServer((s) => {
      let buf = "";
      s.setEncoding("utf8");
      s.on("data", (c) => {
        buf += c;
        rawText += c;
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
          lines.push(line);
          const result = line.op === "status" ? { paused: null } : { written: true };
          s.write(`${JSON.stringify({ ok: true, result })}\n`);
        }
      });
    }).listen(sock, resolve),
  );
  web = http((q, r) => {
    if (q.url.startsWith("/m/")) {
      r.setHeader("content-type", "text/javascript");
      return r.end(readFileSync(FILES[decodeURIComponent(q.url.slice(3))]));
    }
    if (q.url.startsWith("/api/")) return r.end('{"ok":true}');
    r.setHeader("content-type", "text/html");
    r.end(PAGE);
  });
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));

  const udd = join(tmp, "profile");
  await install({
    nodePath: process.execPath,
    hostScript: join(repo, "host", "autotrack-host.mjs"),
    control: sock,
    platform: "darwin",
    dir: join(tmp, "native-host"),
    targets: [{ browser: "chromium", dir: join(udd, "NativeMessagingHosts") }],
  });
  ctx = await chromium.launchPersistentContext(udd, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
}, 60_000);

afterAll(async () => {
  await ctx?.close();
  web?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const events = () => lines.filter((l) => l.op === "web").map((l) => l.event);

it("records a React click, typing, a password and an app event through the native host", async () => {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  expect(sw.url()).toBe(`chrome-extension://${EXTENSION_IDS[0]}/sw/sw.js`);

  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${web.address().port}/inbox?code=OAUTHCODE&tab=2`);
  await page.getByText("Save draft").waitFor();

  await page.mouse.move(5, 5);
  await page.mouse.move(300, 200, { steps: 4 });
  await page.getByText("Save draft").click();
  await page.getByText("saved 1").waitFor();
  await page.click("#company");
  await page.keyboard.type("Acme Plumbing");
  await page.keyboard.press("Tab");
  await page.keyboard.type("hunter2-SECRET");
  await page.keyboard.press("Tab");
  await page.keyboard.press("ControlOrMeta+a");
  await page.click("#art circle");
  await page.evaluate(() => {
    window.postMessage({ autotrack: { v: 1, action: "approve-message", detail: { id: 42 } } }, "*");
    // Spoof attempts: a script click, a forged web event, a handshake replay.
    document.querySelector("[data-testid=save]").click();
    window.postMessage(
      { autotrack: { kind: "web", act: "click", target: { tag: "button" } } },
      "*",
    );
    document.dispatchEvent(new CustomEvent("autotrack:hello-main"));
  });
  await page.waitForTimeout(2500);

  const evs = events();
  // AUTOTRACK_E2E_OUT=<file> keeps the relayed lines for a look.
  if (process.env.AUTOTRACK_E2E_OUT)
    writeFileSync(process.env.AUTOTRACK_E2E_OUT, evs.map((e) => JSON.stringify(e)).join("\n"));

  // Every event came through the host with tab and frame stamped.
  for (const e of evs) {
    expect(["web", "app"]).toContain(e.kind);
    expect(typeof e.tab).toBe("number");
    expect(typeof e.frame).toBe("number");
  }
  const save = evs.filter((e) => e.act === "click" && e.target?.testId === "save");
  expect(save).toHaveLength(1); // the script .click() was not recorded
  const click = save[0];
  expect(click.target).toMatchObject({ tag: "button", role: "button", name: "Save draft" });
  expect(click.target.react).toEqual(expect.arrayContaining(["SaveButton", "Toolbar", "App"]));
  expect(click.target.react[0]).toBe("SaveButton");
  expect(click.url).toMatch(/\/inbox\?code=%3Credacted%3E&tab=2$/);
  const { rect } = click.target;
  expect(click.x).toBeGreaterThanOrEqual(rect.x - 1);
  expect(click.x).toBeLessThanOrEqual(rect.x + rect.width + 1);
  expect(click.y).toBeGreaterThanOrEqual(rect.y - 1);
  expect(click.y).toBeLessThanOrEqual(rect.y + rect.height + 1);

  const effect = evs.find((e) => e.act === "effect" && e.cause?.ts === click.ts);
  expect(effect.effects.requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        method: "GET",
        url: expect.stringMatching(/\/api\/save$/),
        status: 200,
      }),
    ]),
  );
  expect(effect.effects.dom.textChanged + effect.effects.dom.added).toBeGreaterThan(0);

  const company = evs.find((e) => e.act === "change" && e.target?.id === "company");
  expect(company).toMatchObject({ value: "Acme Plumbing", target: { name: "Company" } });
  const pw = evs.find((e) => e.act === "change" && e.target?.id === "pw");
  expect(pw).toMatchObject({ redacted: true, target: { inputType: "password", name: "Password" } });
  expect(pw.value).toBeUndefined();
  expect(
    evs
      .filter((e) => e.act === "key")
      .map((e) => `${e.mods.join("+")}${e.mods.length ? "+" : ""}${e.key}`),
  ).toEqual(expect.arrayContaining(["tab", expect.stringMatching(/^(ctrl|meta)\+a$/)]));

  const circle = evs.find((e) => e.act === "click" && e.target?.tag === "circle");
  const found = await page.evaluate(
    (xp) => document.evaluate(xp, document, null, 9, null).singleNodeValue?.localName,
    circle.target.xpath,
  );
  expect(found).toBe("circle");

  const app = evs.filter((e) => e.kind === "app");
  expect(app).toHaveLength(1);
  expect(app[0]).toMatchObject({ action: "approve-message", detail: { id: 42 } });

  expect(rawText).not.toMatch(/hunter2|SECRET|OAUTHCODE/);
});
