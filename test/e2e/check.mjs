#!/usr/bin/env node
/**
 * E2E assertions over what the S3 stub received after `autotrack stop` + `autotrack ship`:
 *
 *   node test/e2e/check.mjs --dir <stub root>/<bucket>/<device> [--soft input,screen] [--mac]
 *
 * Hard checks: a session arrived, session.json has endedAt, events parse and are in time order,
 * the typed password never appears anywhere. Checks that need an OS permission the runner may not
 * grant (input: typed "hello", clicks with element role and name, the redacted run; screen:
 * frames) turn into loud `::warning::` lines when named in --soft, never silent passes.
 * --mac: macOS secure input hides keystrokes in a password box from every event tap, so a missing
 * redacted run there is a warning, not a failure (the leak check stays hard).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const PASSWORD = "hunter2pw";
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
      events.push(ev);
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
const named = clicks.filter(
  (c) =>
    typeof c.element?.role === "string" && c.element.role && typeof c.element.name === "string",
);
check(
  clicks.length > 0 && named.length === clicks.length,
  `every click carries an element role and name (${named.length}/${clicks.length})`,
  "input",
);
check(
  clicks.some((c) => /submit/i.test(c.element?.name ?? "")),
  `the Submit button click is named "Submit"`,
  "input",
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
