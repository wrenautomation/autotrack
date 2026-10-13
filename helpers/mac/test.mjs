// Mac probe test: spawns ./probe, sends each op, checks the JSON shape, measures `at` latency.
// Null elements are accepted only when Accessibility isn't granted (reported, never worked around).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const child = spawn(join(dirname(fileURLToPath(import.meta.url)), "probe"), {
  stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  const m = JSON.parse(line);
  pending.get(m.id)?.(m);
  pending.delete(m.id);
});
let nextId = 1;
const ask = (req) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`no answer to ${JSON.stringify(req)}`)), 2000);
    pending.set(id, (m) => (clearTimeout(timer), resolve(m)));
    child.stdin.write(JSON.stringify({ id, ...req }) + "\n");
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
  console.error("FAIL:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log("ok");
