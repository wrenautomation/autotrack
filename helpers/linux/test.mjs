// Linux helper test (CI only: it opens windows and posts input with xdotool). Needs an X display
// with a window manager, a session bus with AT-SPI, python3-gi, xdotool, xclip and tesseract.
// Spawns ./autotrack-helper in each mode and checks the answers' shapes against the GTK fixtures
// in test/e2e/linux-form.py:
//   --probe  perm, front, at (latency, Submit by name, the password entry secure, the text area
//            never named by its text), focused, tree (no values), clipboard events (plain, and a
//            password manager's copy concealed), usage, errors
//   --shots  displays, grab (hash stable on a still screen), save, crop at native pixels, the ring
//   --ocr    reads test/fixtures/ocr-text.jpg ("Hello", "Submit")
// usage: node helpers/linux/test.mjs
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const bin = join(here, "autotrack-helper");
const dir = mkdtempSync(join(tmpdir(), "autotrack-helper-test-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, what) => {
  if (!ok) failures.push(what);
  return ok;
};
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const xdo = (...args) => execFileSync("xdotool", args.map(String), { stdio: "inherit" });

/** A helper child speaking the line protocol; pushed lines (no id) go to `events`. */
function helper(mode) {
  const child = spawn(bin, [`--${mode}`], { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  const events = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const m = JSON.parse(line);
    if (m.id === undefined) return events.push(m);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  });
  let nextId = 1;
  const ask = (req, ms = 5000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`no answer to ${JSON.stringify(req)}`)), ms);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(`${JSON.stringify({ id, ...req })}\n`);
    });
  return { ask, events, child, close: () => child.stdin.end() };
}

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
  "help",
]);
const isElement = (e) =>
  e &&
  typeof e.role === "string" &&
  typeof e.name === "string" &&
  typeof e.secure === "boolean" &&
  ["x", "y", "width", "height"].every((k) => isNum(e[k])) &&
  Object.keys(e).every((k) => KEYS.has(k)) &&
  (!("path" in e) ||
    (Array.isArray(e.path) &&
      e.path.length >= 1 &&
      e.path.length <= 6 &&
      e.path.every((a) => typeof a.role === "string" && typeof a.name === "string")));

async function fixture(mode, file) {
  const p = spawn("python3", [join(repo, "test", "e2e", "linux-form.py"), mode, file], {
    stdio: "inherit",
  });
  for (let i = 0; i < 100 && !existsSync(file); i++) await sleep(100);
  if (!existsSync(file)) throw new Error(`${mode} fixture did not come up`);
  await sleep(300);
  return { proc: p, at: JSON.parse(readFileSync(file, "utf8")) };
}

// ---- probe ---------------------------------------------------------------------------------
const probe = helper("probe");
const perm = await probe.ask({ op: "perm" });
console.log("perm", JSON.stringify(perm));
check(
  ["accessibility", "screen", "input", "atspi", "record"].every(
    (k) => typeof perm[k] === "boolean",
  ) && typeof perm.session === "string",
  `perm shape: ${JSON.stringify(perm)}`,
);
check(
  perm.atspi && perm.screen && perm.record,
  `perm: AT-SPI, screen and RECORD all expected here: ${JSON.stringify(perm)}`,
);
check(typeof (await probe.ask({ op: "nope" })).error === "string", "unknown op answers an error");
check((await probe.ask({ op: "at" })).element === null, "at without coordinates answers null");
const power = await probe.ask({ op: "power" });
check("ac" in power && "battery" in power, `power shape: ${JSON.stringify(power)}`);

const note = await fixture("note", join(dir, "note.json"));
xdo("mousemove", note.at.text.x, note.at.text.y, "click", 1);
await sleep(500);
xdo("type", "--delay", 40, "hello secret words");
await sleep(500);

const front = await probe.ask({ op: "front" });
console.log("front", JSON.stringify(front));
check(
  front.app &&
    typeof front.app.name === "string" &&
    typeof front.app.id === "string" &&
    isNum(front.app.pid) &&
    front.app.pid > 0,
  "front.app shape",
);
check(
  front.window?.title === "note.txt - Text Editor",
  `front window is the note: ${front.window?.title}`,
);
check(isNum(front.windows) && front.windows >= 1, "front.windows counted");

const textAt = await probe.ask({ op: "at", x: note.at.text.x, y: note.at.text.y });
console.log("at text area", JSON.stringify(textAt.element));
check(isElement(textAt.element), `at text area: element shape ${JSON.stringify(textAt.element)}`);
check(textAt.element?.role === "text", `text area role "text": ${textAt.element?.role}`);
check(!JSON.stringify(textAt).includes("secret"), "the text area's content is in no answer");
const focusedNote = await probe.ask({ op: "focused" });
console.log("focused", JSON.stringify(focusedNote.element));
check(
  focusedNote.element?.role === "text",
  `focused: the text area (${focusedNote.element?.role})`,
);
check(!JSON.stringify(focusedNote).includes("secret"), "focused: no content");

// Clipboard: watch, then a plain copy and a password manager's copy.
await probe.ask({ op: "watch", clipboard: true });
await sleep(300);
execFileSync("sh", ["-c", "printf 'autotrack helper clip' | xclip -selection clipboard"]);
for (let i = 0; i < 30 && !probe.events.some((e) => e.event === "clipboard"); i++) await sleep(100);
const plain = probe.events.find((e) => e.event === "clipboard");
console.log("clipboard", JSON.stringify(plain));
check(
  plain?.text === "autotrack helper clip" && plain.length === 21 && plain.concealed === false,
  "plain copy pushed with its text",
);
const hidden = spawn(
  "python3",
  [join(repo, "test", "e2e", "linux-form.py"), "concealed", "hunter2pw"],
  { stdio: "inherit" },
);
for (let i = 0; i < 50 && !probe.events.some((e) => e.concealed); i++) await sleep(100);
const conc = probe.events.find((e) => e.concealed);
console.log("concealed", JSON.stringify(conc));
check(
  conc && !("text" in conc) && conc.types.includes("x-kde-passwordManagerHint"),
  "a password manager's copy is concealed, no text",
);
check(
  !probe.events.some((e) => JSON.stringify(e).includes("hunter2pw")),
  "the concealed text is in no event",
);
hidden.kill();

const form = await fixture("form", join(dir, "form.json"));
xdo("mousemove", form.at.password.x, form.at.password.y, "click", 1);
await sleep(500);
xdo("type", "--delay", 40, "hunter2pw");
await sleep(500);
const pw = await probe.ask({ op: "at", x: form.at.password.x, y: form.at.password.y });
console.log("at password", JSON.stringify(pw.element));
check(
  pw.element?.secure === true && pw.element.role === "password text",
  "the password entry is secure",
);
check(!JSON.stringify(pw).includes("hunter2pw"), "the password is in no at answer");
const fpw = await probe.ask({ op: "focused" });
console.log("focused password", JSON.stringify(fpw.element));
check(fpw.element?.secure === true, "focused: the password entry, secure");
const submit = await probe.ask({ op: "at", x: form.at.submit.x, y: form.at.submit.y });
console.log("at submit", JSON.stringify(submit.element));
check(
  submit.element?.name === "Submit" && /button/.test(submit.element.role),
  "Submit by name and role",
);
const tree = await probe.ask({ op: "tree", max: 400, depth: 25, budgetMs: 750 });
console.log(`tree: ${tree.nodes?.length} node(s), ${tree.ms} ms, truncated ${tree.truncated}`);
check(Array.isArray(tree.nodes) && tree.nodes.length > 0, "tree has nodes");
check(!tree.nodes?.some((n) => "value" in n), "no tree node carries a value");
check(
  tree.nodes?.some((n) => n.secure === true),
  "the tree marks the password entry secure",
);
check(
  tree.nodes?.some((n) => n.name === "Submit"),
  "the tree holds Submit",
);
check(!JSON.stringify(tree).includes("hunter2pw"), "the password is not in the tree");

// `at` latency over the screen.
const lat = [];
let hits = 0;
for (let i = 0; i < 50; i++) {
  const x = 30 + ((i * 97) % 1500);
  const y = 30 + ((i * 53) % 800);
  const t0 = process.hrtime.bigint();
  const m = await probe.ask({ op: "at", x, y });
  lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
  if (m.element) {
    hits++;
    check(isElement(m.element), `at element shape: ${JSON.stringify(m.element)}`);
  }
}
lat.sort((a, b) => a - b);
const p95 = lat[Math.floor(0.95 * lat.length)];
console.log(
  `at latency ms: p50 ${lat[25].toFixed(1)} p95 ${p95.toFixed(1)} max ${lat.at(-1).toFixed(1)} (${hits}/50 hits)`,
);
check(hits > 0, "no at hit anywhere");
check(p95 < 50, `at p95 ${p95.toFixed(1)} ms is not under 50 ms`);
const usage = await probe.ask({ op: "usage" });
check(usage.cpuMs >= 0 && usage.rssMb > 0, `probe usage: ${JSON.stringify(usage)}`);
console.log("probe usage", JSON.stringify(usage));
xdo("mousemove", form.at.submit.x, form.at.submit.y, "click", 1);
await sleep(800);
check(existsSync(join(dir, "form.json.done")), "the form saw Submit");
probe.close();

// ---- shots ---------------------------------------------------------------------------------
const shots = helper("shots");
const { displays } = await shots.ask({ op: "displays" });
console.log("displays", JSON.stringify(displays));
check(Array.isArray(displays) && displays.length >= 1, "at least one display");
const d = displays?.[0];
check(
  d &&
    typeof d.id === "string" &&
    ["x", "y", "width", "height", "scale"].every((k) => isNum(d[k])) &&
    d.os?.scale === 1,
  `display shape: ${JSON.stringify(d)}`,
);
const times = [];
let first = null;
let same = 0;
for (let i = 0; i < 8; i++) {
  const t0 = performance.now();
  const g = await shots.ask({ op: "grab", display: d.id });
  times.push(performance.now() - t0);
  check(
    isNum(g.slot) && isNum(g.seq) && /^[0-9a-f]{16}$/.test(g.hash ?? ""),
    `grab shape: ${JSON.stringify(g)}`,
  );
  check(g.w <= 1920 && g.h <= 1920, "grab fits 1920");
  if (first === null) first = g;
  else if (g.hash === first.hash) same++;
}
check(same >= 5, `a still screen keeps its hash (${same}/7 same)`);
times.sort((a, b) => a - b);
console.log(`grab ms: p50 ${times[4].toFixed(1)} max ${times.at(-1).toFixed(1)}`);
const g = await shots.ask({ op: "grab", display: d.id });
const frame = join(dir, "frame.jpg");
const saved = await shots.ask({ op: "save", slot: g.slot, seq: g.seq, path: frame });
check(
  saved.ok === true && saved.bytes > 1000 && statSync(frame).size === saved.bytes,
  `save: ${JSON.stringify(saved)}`,
);
const b = readFileSync(frame);
check(
  b[0] === 0xff && b[1] === 0xd8 && b.at(-2) === 0xff && b.at(-1) === 0xd9,
  "the frame is a whole JPEG",
);
for (let i = 0; i < 4; i++) await shots.ask({ op: "grab", display: d.id });
const reused = await shots.ask({
  op: "save",
  slot: g.slot,
  seq: g.seq,
  path: join(dir, "old.jpg"),
});
check(reused.ok === false && reused.error === "slot reused", `the ring: ${JSON.stringify(reused)}`);
check(
  (await shots.ask({ op: "save", path: frame })).error === "bad request",
  "save without a slot",
);
const crop = join(dir, "crop.jpg");
const c = await shots.ask({
  op: "crop",
  display: d.id,
  x: 100,
  y: 100,
  w: 256,
  h: 256,
  path: crop,
});
check(
  c.ok === true && c.w === 256 && c.h === 256 && existsSync(crop),
  `crop at native pixels: ${JSON.stringify(c)}`,
);
const su = await shots.ask({ op: "usage" });
console.log("shots usage", JSON.stringify(su));
check(su.rssMb > 0 && su.rssMb < 120, `shots RSS ${su.rssMb} MB`);
shots.close();

// ---- ocr -----------------------------------------------------------------------------------
const ocr = helper("ocr");
const read = await ocr.ask(
  { op: "read", path: join(repo, "test", "fixtures", "ocr-text.jpg") },
  30000,
);
console.log("ocr", JSON.stringify(read).slice(0, 400));
check(
  Array.isArray(read.lines) && read.w === 640 && read.h === 200,
  `ocr shape: w ${read.w} h ${read.h}`,
);
const text = (read.lines ?? []).map((l) => l.text).join(" ");
check(/Hello/.test(text) && /Submit/.test(text), `ocr read Hello and Submit: ${text}`);
check(
  (read.lines ?? []).every((l) => ["x", "y", "w", "h", "conf"].every((k) => isNum(l[k]))),
  "every OCR line has a box and conf",
);
check(isNum(read.cpuMs) && read.cpuMs > 0, `ocr cpuMs counts tesseract: ${read.cpuMs}`);
check(
  typeof (await ocr.ask({ op: "read", path: join(dir, "missing.jpg") })).error === "string",
  "a missing image is an error",
);
ocr.close();

note.proc.kill();
form.proc.kill();
rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  for (const f of failures) console.log(`::error::linux helper: ${f}`);
  process.exit(1);
}
console.log("linux helper checks passed");
process.exit(0);
