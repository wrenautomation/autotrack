// Mac probe test: spawns ./probe, sends each op, checks the JSON shape, measures `at` latency;
// then tree caps, a dialog in front, and pushed clipboard events (plain and concealed).
// Null elements are accepted only when Accessibility isn't granted (reported, never worked around).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const child = spawn(join(dirname(fileURLToPath(import.meta.url)), "probe"), {
  stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map();
let onEvent = null; // lines the probe pushes by itself
createInterface({ input: child.stdout }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined && m.event) return onEvent?.(m);
  pending.get(m.id)?.(m);
  pending.delete(m.id);
});
let nextId = 1;
const ask = (req, ms = 2000) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`no answer to ${JSON.stringify(req)}`)), ms);
    pending.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    child.stdin.write(`${JSON.stringify({ id, ...req })}\n`);
  });

const failures = [];
const check = (ok, what) => ok || failures.push(what);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const KEYS = new Set([
  "role",
  "name",
  "x",
  "y",
  "width",
  "height",
  "secure",
  "path",
  "id",
  "cls",
  "url",
  "help",
]);
const isElement = (e) =>
  e &&
  typeof e.role === "string" &&
  typeof e.name === "string" &&
  typeof e.secure === "boolean" &&
  ["x", "y", "width", "height"].every((k) => isNum(e[k])) &&
  Object.keys(e).every((k) => KEYS.has(k)) && // never a value
  ["id", "cls", "url", "help"].every(
    (k) => !(k in e) || (typeof e[k] === "string" && e[k] !== ""),
  ) && // omitted when empty
  (!("path" in e) ||
    (Array.isArray(e.path) &&
      e.path.length >= 1 &&
      e.path.length <= 6 &&
      e.path.every(
        (a) => typeof a.role === "string" && typeof a.name === "string" && a.role !== "window",
      )));

const perm = await ask({ op: "perm" });
check(
  ["accessibility", "screen", "input"].every((k) => typeof perm[k] === "boolean"),
  "perm shape",
);
console.log("perm", JSON.stringify(perm));

const front = await ask({ op: "front" });
check("app" in front && "window" in front, "front shape");
if (front.app)
  check(
    typeof front.app.name === "string" && typeof front.app.id === "string" && isNum(front.app.pid),
    "front.app shape",
  );
else if (perm.accessibility) failures.push("front returned no app");
if (front.window)
  check(
    typeof front.window.title === "string" &&
      ["x", "y", "width", "height"].every((k) => isNum(front.window[k])),
    "front.window shape",
  );
console.log("front", JSON.stringify(front));

const focused = await ask({ op: "focused" });
check("element" in focused, "focused shape");
if (focused.element) check(isElement(focused.element), "focused element shape");
console.log("focused", JSON.stringify(focused));

const bad = await ask({ op: "nope" });
check(typeof bad.error === "string", "unknown op answers an error");
const badAt = await ask({ op: "at" });
check(badAt.element === null, "at without coordinates answers null");

// 50 `at` requests across the screen: top menu bar band, then a grid.
const lat = [];
let hits = 0;
for (let i = 0; i < 50; i++) {
  const x = 40 + ((i * 97) % 1200);
  const y = i < 10 ? 10 : 60 + ((i * 53) % 700);
  const t0 = process.hrtime.bigint();
  const m = await ask({ op: "at", x, y });
  lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
  check("element" in m, "at shape");
  if (m.element) {
    hits++;
    check(isElement(m.element), `at element shape: ${JSON.stringify(m.element)}`);
  }
}
lat.sort((a, b) => a - b);
const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(1);
console.log(
  `at latency ms: p50 ${p(0.5)}  p95 ${p(0.95)}  max ${lat[lat.length - 1].toFixed(1)}  (${hits}/50 hits)`,
);
if (!perm.accessibility)
  console.log(
    "SKIPPED element checks: Accessibility not granted to this process, so at/focused return null",
  );
else check(hits > 0, "no `at` hit anywhere with Accessibility granted");
check(Number(p(0.95)) < 50, `p95 ${p(0.95)} ms is not under 50 ms`);

// Names that show a typed value (fixtures/value-fields.swift): a text field named by its content
// is named "", one named "Email" keeps it, and the typed text comes back in no answer.
{
  const { execFileSync } = await import("node:child_process");
  const { existsSync, mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "probe-fields-"));
  const bin = join(dir, "value-fields");
  const out = join(dir, "fields.json");
  execFileSync("swiftc", [
    "-O",
    "-o",
    bin,
    join(dirname(fileURLToPath(import.meta.url)), "fixtures/value-fields.swift"),
  ]);
  const app = spawn(bin, [out], { stdio: "ignore" });
  for (let i = 0; i < 150 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(out)) failures.push("value-fields fixture did not come up");
  else {
    const f = JSON.parse(readFileSync(out, "utf8"));
    const atField = (c) => ask({ op: "at", x: Math.round(c.x), y: Math.round(c.y) });
    // A new app's AX tree takes a moment; wait (5 s at most) until the first field answers as its.
    let first = null;
    let last = null;
    for (let i = 0; i < 50 && !first; i++) {
      last = await atField(f.fields[0]);
      if (last.element?.role === "textfield") first = last;
      else await new Promise((r) => setTimeout(r, 100));
    }
    const answers = [first ?? last];
    for (const c of f.fields.slice(1)) answers.push(await atField(c));
    answers.push(await ask({ op: "focused" }));
    // The fixture's own tree, when it is in front (a system prompt can hold the front on CI).
    const fr = await ask({ op: "front" });
    if (fr.app?.pid === f.pid) {
      const tree = await ask({ op: "tree", max: 1500, depth: 25, budgetMs: 750 }, 3000);
      answers.push(tree);
      check(
        tree.nodes.filter((n) => n.role === "textfield").length === 3 &&
          tree.nodes.some((n) => n.role === "textfield" && n.name === "Email"),
        "the fixture's tree has its three fields, one named Email",
      );
    } else console.log(`value fields: front is ${fr.app?.id}, tree check skipped`);
    console.log("value fields", JSON.stringify(answers.map((a) => a.element)));
    check(!JSON.stringify(answers).includes(f.typed), "a typed value came back in an answer");
    if (perm.accessibility && !first) {
      const fr = await ask({ op: "front" });
      failures.push(
        `setup: the value-fields window was not at ${JSON.stringify(f.fields[0])} (got ${JSON.stringify(last?.element)}, front ${fr.app?.id})`,
      );
    } else if (perm.accessibility) {
      const [titled, labelled, email] = answers.map((a) => a.element);
      check(
        titled?.role === "textfield" && titled.name === "",
        'a field titled by its value has name ""',
      );
      check(
        labelled?.role === "textfield" && labelled.name === "",
        'a field labelled with its value has name ""',
      );
      check(
        email?.role === "textfield" && email.name === "Email",
        "a field titled Email keeps its name",
      );
    }
  }
  const exited = new Promise((res) => app.on("exit", res));
  app.kill();
  await exited;
  rmSync(dir, { recursive: true, force: true });
}

// tree: the front window's visible nodes, never a value key, within the caps the op was given.
const NODE_KEYS = new Set(["role", "name", "id", "x", "y", "width", "height", "depth", "secure"]);
const isNode = (n) =>
  typeof n.role === "string" &&
  typeof n.name === "string" &&
  n.name.length <= 200 &&
  Number.isInteger(n.depth) &&
  n.depth >= 0 &&
  ["x", "y", "width", "height"].every((k) => isNum(n[k])) &&
  Object.keys(n).every((k) => NODE_KEYS.has(k));
{
  const t0 = Date.now();
  const tree = await ask({ op: "tree", max: 300, depth: 10, budgetMs: 750 }, 3000);
  const kb = Buffer.byteLength(JSON.stringify({ nodes: tree.nodes })) / 1024;
  console.log(
    `tree: ${tree.nodes?.length} nodes, ${kb.toFixed(1)} KB, ${tree.ms} ms in the helper, ${Date.now() - t0} ms round trip, truncated ${tree.truncated}`,
  );
  check(
    Array.isArray(tree.nodes) && typeof tree.truncated === "boolean" && isNum(tree.ms),
    "tree shape",
  );
  check(tree.nodes.length <= 300, "tree over its node cap");
  check(
    tree.nodes.every((n) => isNode(n) && n.depth < 10),
    "tree node shape or depth cap",
  );
  if (perm.accessibility) check(tree.nodes.length > 0, "tree of the front window is empty");
}

// After an app switch, a tree is the new front window's. Its own helper, asked nothing else: an
// earlier `at` or `front` on the main thread hid a stale front app here once.
// TextEdit is quit after only if this test started it.
{
  const { execFileSync } = await import("node:child_process");
  const fresh = spawn(join(dirname(fileURLToPath(import.meta.url)), "probe"), {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: fresh.stdout })[Symbol.asyncIterator]();
  const freshAsk = async (req) => {
    fresh.stdin.write(`${JSON.stringify({ id: 1, ...req })}\n`);
    return JSON.parse((await lines.next()).value);
  };
  const treeReq = { op: "tree", max: 1500, depth: 25, budgetMs: 750 };
  let running = true;
  try {
    execFileSync("pgrep", ["-x", "TextEdit"]);
  } catch {
    running = false;
  }
  await freshAsk(treeReq);
  execFileSync("open", ["-a", "TextEdit"]);
  await new Promise((r) => setTimeout(r, 2500));
  const tree = await freshAsk(treeReq);
  const fr = await freshAsk({ op: "front" });
  fresh.kill();
  if (perm.accessibility && fr.app?.id === "com.apple.TextEdit" && fr.window)
    check(
      tree.nodes?.[0]?.role === "window" && tree.nodes[0].name === fr.window.title,
      "after an app switch, the tree is the new front window's",
    );
  else console.log(`app switch: front is ${fr.app?.id}, check skipped`);
  if (!running) execFileSync("osascript", ["-e", 'quit application "TextEdit"']);
}

// A dialog in front: `front` says so, with its title, text and buttons; the tree has them too.
{
  const dlg = spawn(
    "osascript",
    [
      "-e",
      "activate",
      "-e",
      'display dialog "Delete the draft?" with title "Probe test" buttons {"Keep", "Delete"} giving up after 20',
    ],
    { stdio: "ignore" },
  );
  let fr = null;
  for (let i = 0; i < 50 && !fr?.dialog; i++) {
    await new Promise((r) => setTimeout(r, 100));
    fr = await ask({ op: "front" });
  }
  console.log("dialog front", JSON.stringify(fr));
  if (perm.accessibility) {
    check(
      fr?.dialog?.title === "Probe test" &&
        fr.dialog.text === "Delete the draft?" &&
        JSON.stringify([...fr.dialog.buttons].sort()) === '["Delete","Keep"]',
      "front.dialog has the dialog's title, text and buttons",
    );
    await new Promise((r) => setTimeout(r, 300)); // a window just shown can miss the 40 ms AX timeout
    const again = await ask({ op: "front" });
    check(isNum(again.windows) && again.windows >= 1, "front.windows counts the app's windows");
    const tree = await ask({ op: "tree", max: 1500, depth: 25, budgetMs: 750 }, 3000);
    check(
      tree.nodes?.some((n) => n.role === "button" && n.name === "Delete"),
      "the dialog's tree has its Delete button",
    );
  }
  dlg.kill();
  const after = await ask({ op: "front" });
  check(
    after.dialog === null || after.dialog === undefined || after.app?.name !== "osascript",
    "front.dialog stays after the dialog closed",
  );
}

// Clipboard: after `watch`, a copy pushes {event:"clipboard"} with its text; a copy marked
// concealed (what password managers do) pushes no text. The clipboard's text is put back after.
{
  const { execFileSync } = await import("node:child_process");
  const saved = execFileSync("pbpaste", { encoding: "utf8" });
  const pushed = [];
  onEvent = (m) => pushed.push(m);
  check((await ask({ op: "watch", clipboard: true })).ok === true, "watch answers ok");
  await new Promise((r) => setTimeout(r, 400));
  execFileSync("pbcopy", { input: "probe clip 81" });
  await new Promise((r) => setTimeout(r, 700));
  execFileSync("osascript", [
    "-l",
    "JavaScript",
    "-e",
    "ObjC.import('AppKit'); const pb = $.NSPasteboard.generalPasteboard; pb.clearContents; pb.setStringForType('hunter2-concealed', 'public.utf8-plain-text'); pb.setStringForType('', 'org.nspasteboard.ConcealedType');",
  ]);
  await new Promise((r) => setTimeout(r, 700));
  execFileSync("pbcopy", { input: saved });
  console.log("clipboard events", JSON.stringify(pushed));
  const plain = pushed.find((m) => m.text === "probe clip 81");
  check(
    plain &&
      plain.event === "clipboard" &&
      plain.length === 13 &&
      plain.concealed === false &&
      Array.isArray(plain.types),
    "a copy pushes a clipboard event with its text and length",
  );
  const hidden = pushed.find((m) => m.concealed === true);
  check(hidden && !("text" in hidden) && hidden.length === 17, "a concealed copy pushes no text");
  check(!JSON.stringify(pushed).includes("hunter2"), "concealed text came back");
  onEvent = null;
}

// Optional: AUTOTRACK_TEST_CHROME=1 opens an isolated Chrome on fixtures/web-button.html and waits for the
// probe to see the page's button (role, name, id, ancestors) - proves AXManualAccessibility works.
if (process.env.AUTOTRACK_TEST_CHROME) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "probe-chrome-"));
  const page = join(dirname(fileURLToPath(import.meta.url)), "fixtures/web-button.html");
  const chrome = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-position=100,100",
      "--window-size=1000,700",
      `file://${page}`,
    ],
    { stdio: "ignore" },
  );
  const t0 = Date.now();
  let found = null;
  await ask({ op: "front" }); // front enables web accessibility for the app in front
  while (!found && Date.now() - t0 < 20000) {
    for (let y = 180; y < 420 && !found; y += 20)
      for (let x = 120; x < 500 && !found; x += 40) {
        const m = await ask({ op: "at", x, y });
        if (m.element?.name === "Save draft") found = m.element;
      }
    await new Promise((r) => setTimeout(r, 300));
  }
  const exited = new Promise((res) => chrome.on("exit", res));
  chrome.kill();
  await exited;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {} // helpers may still hold files
  console.log(
    "chrome web button:",
    found ? `found after ${Date.now() - t0} ms ${JSON.stringify(found)}` : "NOT FOUND",
  );
  check(
    found &&
      found.role === "button" &&
      found.id === "save-btn" &&
      found.help === "Saves the draft" &&
      found.path?.some((a) => a.role === "webarea"),
    "Chrome web button has role, name, id, help and a webarea ancestor",
  );
}

child.stdin.end();
const code = await new Promise((res) => child.on("exit", res));
check(code === 0, `probe exits 0 when stdin closes (got ${code})`);
if (failures.length) {
  console.error(`FAIL:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("ok");
