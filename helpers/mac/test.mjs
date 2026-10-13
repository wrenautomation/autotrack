// Mac probe test: spawns ./probe, sends each op, checks the JSON shape, measures `at` latency.
// Null elements are accepted only when Accessibility isn't granted (reported, never worked around).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const child = spawn(join(dirname(fileURLToPath(import.meta.url)), "probe"), { stdio: ["pipe", "pipe", "inherit"] });
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
const isElement = (e) =>
  e && typeof e.role === "string" && typeof e.name === "string" && typeof e.secure === "boolean" &&
  ["x", "y", "width", "height"].every((k) => isNum(e[k])) && !("value" in e);

const perm = await ask({ op: "perm" });
check(["accessibility", "screen", "input"].every((k) => typeof perm[k] === "boolean"), "perm shape");
console.log("perm", JSON.stringify(perm));

const front = await ask({ op: "front" });
check("app" in front && "window" in front, "front shape");
if (front.app) check(typeof front.app.name === "string" && typeof front.app.id === "string" && isNum(front.app.pid), "front.app shape");
else if (perm.accessibility) failures.push("front returned no app");
if (front.window) check(typeof front.window.title === "string" && ["x", "y", "width", "height"].every((k) => isNum(front.window[k])), "front.window shape");
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
  if (m.element) { hits++; check(isElement(m.element), `at element shape: ${JSON.stringify(m.element)}`); }
}
lat.sort((a, b) => a - b);
const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(1);
console.log(`at latency ms: p50 ${p(0.5)}  p95 ${p(0.95)}  max ${lat[lat.length - 1].toFixed(1)}  (${hits}/50 hits)`);
if (!perm.accessibility) console.log("SKIPPED element checks: Accessibility not granted to this process, so at/focused return null");
else check(hits > 0, "no `at` hit anywhere with Accessibility granted");
check(Number(p(0.95)) < 50, `p95 ${p(0.95)} ms is not under 50 ms`);

child.stdin.end();
const code = await new Promise((res) => child.on("exit", res));
check(code === 0, `probe exits 0 when stdin closes (got ${code})`);
if (failures.length) { console.error("FAIL:\n- " + failures.join("\n- ")); process.exit(1); }
console.log("ok");
