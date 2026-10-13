#!/usr/bin/env node
/**
 * E2E assertions over what the S3 stub received after `autotrack stop` + `autotrack ship`:
 *
 *   node test/e2e/check.mjs --dir <stub root>/<bucket>/<device> [--soft input,screen] [--mac]
 *
 * Hard checks: a session arrived, session.json has endedAt, events parse and are in time order,
 * the typed password never appears anywhere (events, session.json, trees). Signal: every act
 * carries `out`, trees arrived as `trees/<n>.json.gz` named by their events and never hold a value,
 * the driver's copy is a clipboard event, the task prompt (opened in front by `autotrack task`)
 * wrote the driver's answer and none of its keys became input. Checks that need an OS permission the runner may not
 * grant (input: typed "hello", clicks with an element role, Submit named, the redacted run; screen:
 * frames) turn into loud `::warning::` lines when named in --soft, never silent passes.
 * --mac: macOS secure input hides keystrokes in a password box from every event tap, so a missing
 * redacted run there is a warning, not a failure (the leak check stays hard).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const PASSWORD = "hunter2pw";
const CLIP = "autotrack e2e clip 42";
const TASK = "e2e task";
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = opt("--dir");
const soft = new Set((opt("--soft") ?? "").split(",").filter(Boolean));
const mac = args.includes("--mac");
if (!dir) {
  console.error(
    "usage: check.mjs --dir <stub root>/<bucket>/<device> [--soft input,screen] [--mac]",
  );
  process.exit(2);
}

let failures = 0;
const pass = (msg) => console.log(`ok    ${msg}`);
const fail = (msg) => {
  failures++;
  console.log(`::error::e2e: ${msg}`);
};
const warn = (msg) => console.log(`::warning::e2e: ${msg}`);
/** A check that needs `need` (a permission): fails, or warns when the runner can't grant it. */
const check = (good, msg, need) => {
  if (good) pass(msg);
  else if (need && soft.has(need)) warn(`SKIPPED (runner lacks ${need} permission): ${msg}`);
  else fail(msg);
};

/** JPEG width and height from the first SOFn marker, or null. */
function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

const files = (d) => {
  try {
    return readdirSync(d).sort();
  } catch {
    return [];
  }
};
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const sessions = files(dir).filter((s) => isDir(join(dir, s)));
check(sessions.length > 0, `${sessions.length} session(s) under ${dir}`);

const events = [];
const trees = new Map(); // "<session>/<n>" → parsed tree
let frames = 0;
let raw = "";
for (const s of sessions) {
  const sdir = join(dir, s);
  const metaPath = join(sdir, "session.json");
  let meta = null;
  try {
    const text = readFileSync(metaPath, "utf8");
    raw += text;
    meta = JSON.parse(text);
  } catch (e) {
    fail(`${s}: session.json missing or bad (${e.message})`);
  }
  if (meta)
    check(
      typeof meta.endedAt === "string" && meta.endedAt.length > 0,
      `${s}: endedAt ${meta.endedAt}`,
    );

  const segs = files(sdir).filter((g) => isDir(join(sdir, g)));
  let lastT = -Infinity;
  let ordered = true;
  for (const g of segs) {
    const gz = join(sdir, g, "events.jsonl.gz");
    let text = "";
    try {
      text = gunzipSync(readFileSync(gz)).toString("utf8");
    } catch (e) {
      fail(`${s}/${g}: events.jsonl.gz missing or not gzip (${e.message})`);
      continue;
    }
    raw += text;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        fail(`${s}/${g}: bad event line ${line.slice(0, 80)}`);
        continue;
      }
      if (ordered && !(ev.t >= lastT)) {
        ordered = false;
        fail(`${s}/${g}: events out of order: t ${ev.t} after ${lastT} (${line.slice(0, 120)})`);
      }
      lastT = ev.t;
      ev.seg = `${s}/${g}`;
      events.push(ev);
    }
    for (const f of files(join(sdir, g, "trees"))) {
      const m = /^(\d+)\.(json|txt)\.gz$/.exec(f);
      if (!m) {
        fail(`${s}/${g}/trees/${f}: want <n>.json.gz or <n>.txt.gz`);
        continue;
      }
      try {
        const text = gunzipSync(readFileSync(join(sdir, g, "trees", f))).toString("utf8");
        raw += text;
        trees.set(`${s}/${g}/${m[1]}`, m[2] === "json" ? JSON.parse(text) : text);
      } catch (e) {
        fail(`${s}/${g}/trees/${f}: not gzip ${m[2]} (${e.message})`);
      }
    }
    for (const f of files(join(sdir, g, "frames"))) {
      const b = readFileSync(join(sdir, g, "frames", f));
      frames++;
      const framed =
        b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b.at(-2) === 0xff && b.at(-1) === 0xd9;
      const size = framed ? jpegSize(b) : null;
      if (!framed) fail(`${s}/${g}/frames/${f}: not a whole JPEG (SOI/EOI)`);
      else if (!size) fail(`${s}/${g}/frames/${f}: no SOF marker`);
      else if (size.width > 1920 || size.height > 1920 || size.width < 1 || size.height < 1)
        fail(`${s}/${g}/frames/${f}: ${size.width}x${size.height}, want 1..1920 each side`);
    }
  }
  if (ordered) pass(`${s}: ${segs.length} segment(s), events in time order`);
}

const kinds = {};
for (const e of events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
console.log(`      events: ${JSON.stringify(kinds)}, frames: ${frames}`);

check(frames > 0, `${frames} frame(s), each a whole JPEG at most 1920 px a side`, "screen");

const texts = events.filter((e) => e.kind === "text");
for (const t of texts)
  console.log(
    `      text ${JSON.stringify(t.text)} redacted=${t.redacted} on ${t.element?.role ?? "?"}`,
  );
check(
  texts.some((t) => !t.redacted && t.text.includes("hello")),
  `typed "hello" recorded as text`,
  "input",
);

const clicks = events.filter((e) => e.kind === "click");
for (const c of clicks)
  console.log(
    `      click ${c.x},${c.y} on ${JSON.stringify(c.element ? { role: c.element.role, name: c.element.name } : null)}`,
  );
check(clicks.length >= 2, `${clicks.length} click(s) recorded (want 2 or more)`, "input");
// Every click knows what it hit (a role); names are checked where the control has a label (Submit).
const known = clicks.filter((c) => typeof c.element?.role === "string" && c.element.role);
check(
  clicks.length > 0 && known.length === clicks.length,
  `every click carries an element with a role (${known.length}/${clicks.length})`,
  "input",
);
check(
  clicks.some((c) => /submit/i.test(c.element?.name ?? "")),
  `the Submit button click is named "Submit"`,
  "input",
);

// Signal: what each act did, the trees, the clipboard.
const acts = events.filter((e) => ["click", "drag", "scroll", "key", "text"].includes(e.kind));
const outs = ["screen", "focus", "dialog", "window"];
const shaped = acts.filter((e) => e.out && outs.every((k) => typeof e.out[k] === "boolean"));
check(
  acts.length > 0 && shaped.length === acts.length,
  `every act carries out (${shaped.length}/${acts.length})`,
);
const treeEvents = events.filter((e) => e.kind === "tree");
const stored = treeEvents.filter((e) => Array.isArray(trees.get(`${e.seg}/${e.tree}`)?.nodes));
for (const e of treeEvents) {
  const t = trees.get(`${e.seg}/${e.tree}`);
  console.log(
    `      tree ${e.tree} of ${e.app?.name ?? "?"}: ${t?.nodes?.length ?? "missing"} node(s), ${t?.ms ?? "?"} ms`,
  );
}
check(
  treeEvents.length > 0 && stored.length === treeEvents.length,
  `${treeEvents.length} tree(s), each stored as trees/<n>.json.gz in its segment`,
);
const valued = [...trees.values()].filter(
  (t) => Array.isArray(t?.nodes) && t.nodes.some((n) => "value" in n),
);
check(valued.length === 0, "no tree node carries a value");
const clips = events.filter((e) => e.kind === "clipboard");
for (const c of clips)
  console.log(
    `      clipboard ${c.length} char(s) ${JSON.stringify(c.text)} redacted=${c.redacted}`,
  );
check(
  clips.some((c) => c.text === CLIP && c.redacted === false),
  `the driver's copy recorded as a clipboard event`,
);
const tasks = events.filter((e) => e.kind === "task");
for (const t of tasks) console.log(`      task ${JSON.stringify(t.goal)}${t.done ? " done" : ""}`);
check(
  tasks.some((t) => t.goal === TASK),
  "the answer typed into the task prompt recorded as a task event",
  "input",
);
check(
  !texts.some((t) => /task/.test(t.text ?? "")),
  "keys typed into the task prompt are not recorded as text",
);

const redacted = texts.filter((t) => t.redacted);
if (redacted.length) pass(`${redacted.length} redacted text run(s) (the password box)`);
else if (mac)
  warn(
    "no redacted text run: macOS secure input hid the password keystrokes from the tap (no leak either)",
  );
else check(false, "a redacted text run for the password box", "input");

// Never soft: whatever was or wasn't captured, the password must not be anywhere.
check(!raw.includes(PASSWORD), "the typed password appears nowhere in events or session.json");

console.log(failures ? `${failures} failure(s)` : "e2e checks passed");
process.exit(failures ? 1 : 0);
