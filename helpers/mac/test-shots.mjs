// Mac shots test: spawns `./probe --shots`, checks displays/grab/save/crop/usage, the ring, and prints per-op timing
// (p50/p95 over N runs) and the helper's RSS. Needs Screen Recording granted to the terminal.
// usage: node test-shots.mjs [runs]   (AUTOTRACK_SHOTS_SCK=1 tests the ScreenCaptureKit fallback)
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const runs = Number(process.argv[2] ?? 30);
const child = spawn(join(dirname(fileURLToPath(import.meta.url)), "probe"), ["--shots"], {
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
    const timer = setTimeout(() => reject(new Error(`no answer to ${JSON.stringify(req)}`)), 5000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    child.stdin.write(`${JSON.stringify({ id, ...req })}\n`);
  });
const failures = [];
const check = (ok, what) => ok || failures.push(what);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const pct = (xs, p) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const rssMb = () =>
  Number(execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf8" })) / 1024;
const hamming = (a, b) => {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  x &= (1n << 48n) - 1n;
  let n = 0;
  for (; x; x >>= 1n) n += Number(x & 1n);
  return n;
};
const dir = mkdtempSync(join(tmpdir(), "autotrack-shots-"));
/** The display's native pixel width, read apart from the helper (frames are fit to 1920 px, crops not). */
const displayPixels = (id) => {
  try {
    const out = execFileSync(
      "swift",
      ["-e", `import CoreGraphics; print(CGDisplayCopyDisplayMode(${id})!.pixelWidth)`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 },
    );
    return Number(out.trim()) || null;
  } catch {
    return null;
  }
};

try {
  const { displays } = await ask({ op: "displays" });
  check(Array.isArray(displays) && displays.length >= 1, "displays: at least one");
  for (const d of displays ?? []) {
    check(typeof d.id === "string" && typeof d.primary === "boolean", `display ${d.id} shape`);
    check(
      ["x", "y", "width", "height", "scale"].every((k) => isNum(d[k])) &&
        d.width > 0 &&
        d.scale > 0,
      `display ${d.id} numbers`,
    );
    check(
      d.os && ["x", "y", "width", "height", "scale"].every((k) => isNum(d.os[k])),
      `display ${d.id} os rect`,
    );
  }
  console.log("displays", JSON.stringify(displays));
  check(
    displays.some((d) => d.primary),
    "a primary display",
  );
  const main = displays.find((d) => d.primary) ?? displays[0];

  const bad = await ask({ op: "grab", display: "999999" });
  check(typeof bad.error === "string", "grab of an unknown display answers an error");
  const unknown = await ask({ op: "nope" });
  check(typeof unknown.error === "string", "unknown op answers an error");
  const empty = await ask({ op: "save", slot: 0, path: join(dir, "empty.jpg") });
  check(
    empty.ok === false && typeof empty.error === "string",
    "save of an empty slot fails cleanly",
  );

  // grab: shape, size rule, hash
  const g = await ask({ op: "grab", display: main.id });
  console.log("grab", JSON.stringify(g));
  check(!g.error, `grab: ${g.error}`);
  check(Number.isInteger(g.slot) && g.slot >= 0 && g.slot < 4, "grab slot 0..3");
  check(
    isNum(g.w) && isNum(g.h) && Math.max(g.w, g.h) <= 1920,
    "grab size at most 1920 on the long side",
  );
  check(/^[0-9a-f]{16}$/.test(g.hash ?? ""), "grab hash is 16 hex digits");
  check(Math.abs(g.w / g.h - main.width / main.height) < 0.01, "grab keeps the display's aspect");
  check(Math.abs(main.scale - g.w / main.width) < 0.01, "displays scale = frame px per point");

  // save: file, JPEG magic, atomic (no .tmp left), size matches
  const path = join(dir, "a.jpg");
  const s = await ask({ op: "save", slot: g.slot, seq: g.seq, path, quality: 70 });
  check(s.ok === true && isNum(s.bytes) && s.bytes > 1000, `save: ${JSON.stringify(s)}`);
  check(existsSync(path) && statSync(path).size === s.bytes, "saved file size matches the answer");
  check(!existsSync(`${path}.tmp`), "no .tmp left behind");
  const fd = openSync(path, "r");
  const head = Buffer.alloc(2);
  readSync(fd, head, 0, 2, 0);
  closeSync(fd);
  check(head[0] === 0xff && head[1] === 0xd8, "JPEG starts with FFD8");
  const sBad = await ask({
    op: "save",
    slot: g.slot,
    seq: g.seq,
    path: join(dir, "no/such/dir/x.jpg"),
  });
  check(
    sBad.ok === false && typeof sBad.error === "string",
    "save to a missing directory fails cleanly",
  );
  const sQ = await ask({
    op: "save",
    slot: g.slot,
    seq: g.seq,
    path: join(dir, "q30.jpg"),
    quality: 30,
  });
  check(sQ.ok && sQ.bytes < s.bytes, "lower quality saves fewer bytes");

  // ring: the 5th grab reuses the first slot, so a save of the old seq is refused
  const seqs = [g];
  for (let i = 0; i < 4; i++) seqs.push(await ask({ op: "grab", display: main.id }));
  check(
    new Set(seqs.slice(1, 4).map((x) => x.slot)).size === 3,
    "consecutive grabs use distinct slots",
  );
  const stale = await ask({ op: "save", slot: g.slot, seq: g.seq, path: join(dir, "stale.jpg") });
  check(stale.ok === false, "save of a slot reused by a newer grab is refused");
  check(!existsSync(join(dir, "stale.jpg")), "refused save writes nothing");
  const fresh = seqs[4];
  const sf = await ask({
    op: "save",
    slot: fresh.slot,
    seq: fresh.seq,
    path: join(dir, "fresh.jpg"),
  });
  check(sf.ok, "save of the newest slot works");

  // hash: two grabs of a still screen are close
  const h1 = await ask({ op: "grab", display: main.id });
  const h2 = await ask({ op: "grab", display: main.id });
  const dist = hamming(h1.hash, h2.hash);
  console.log(`hash of two consecutive grabs: ${h1.hash} ${h2.hash} hamming ${dist}`);
  check(dist <= 8, `consecutive grabs of a still screen hash close (hamming ${dist})`);

  // crop: a 256-point square at native pixels, inside the display, atomic
  const cropPath = join(dir, "c.jpg.hold");
  const c = await ask({
    op: "crop",
    display: main.id,
    x: main.x + 10,
    y: main.y + 10,
    w: 256,
    h: 256,
    path: cropPath,
    quality: 85,
  });
  console.log("crop", JSON.stringify(c));
  check(c.ok === true && isNum(c.bytes) && c.bytes > 100, `crop: ${JSON.stringify(c)}`);
  check(existsSync(cropPath) && statSync(cropPath).size === c.bytes, "crop file size matches");
  check(!existsSync(`${cropPath}.tmp`), "crop leaves no .tmp");
  const px = displayPixels(main.id);
  const k = px ? px / main.width : null;
  check(
    k === null || (Math.abs(c.w - 256 * k) <= 1 && Math.abs(c.h - 256 * k) <= 1),
    `crop is 256 points at native pixels (${c.w}x${c.h}, ${k} px/pt)`,
  );
  const cBad = await ask({
    op: "crop",
    display: "999999",
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    path: cropPath,
  });
  check(cBad.ok === false && typeof cBad.error === "string", "crop of an unknown display fails");

  // usage: own CPU ms, RSS and footprint
  const u = await ask({ op: "usage" });
  check(
    isNum(u.cpuMs) && u.cpuMs > 0 && isNum(u.rssMb) && u.rssMb > 0 && u.footprintMb > 0,
    `usage: ${JSON.stringify(u)}`,
  );
  // Flat memory: 3,000 small requests (the pool-less parse kept ~4.7 KB each).
  const f0 = (await ask({ op: "usage" })).footprintMb;
  for (let i = 0; i < 3000; i++) await ask({ op: i % 2 ? "usage" : "displays" });
  const f1 = (await ask({ op: "usage" })).footprintMb;
  console.log(`footprint over 3000 requests: ${f0} -> ${f1} MB`);
  check(f1 - f0 < 3, `footprint grew ${f1 - f0} MB over 3000 requests`);

  // timing
  const grabMs = [];
  const saveMs = [];
  let last;
  for (let i = 0; i < runs; i++) {
    let t = performance.now();
    last = await ask({ op: "grab", display: main.id });
    grabMs.push(performance.now() - t);
    t = performance.now();
    const r = await ask({
      op: "save",
      slot: last.slot,
      seq: last.seq,
      path: join(dir, "t.jpg"),
      quality: 70,
    });
    saveMs.push(performance.now() - t);
    check(r.ok, `timing save ${i}`);
  }
  const fmt = (xs) => `p50 ${pct(xs, 0.5).toFixed(1)} ms, p95 ${pct(xs, 0.95).toFixed(1)} ms`;
  console.log(`grab ${fmt(grabMs)} (${runs} runs, ${last.w}x${last.h})`);
  console.log(`save ${fmt(saveMs)}, ${statSync(join(dir, "t.jpg")).size} bytes`);
  console.log(`helper RSS ${rssMb().toFixed(0)} MB`);
} catch (e) {
  failures.push(String(e.message ?? e));
}
child.kill();
rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  console.error(`FAIL:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("shots ok");
