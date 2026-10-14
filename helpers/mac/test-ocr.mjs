// Mac OCR test: spawns `./probe --ocr`, reads test/fixtures/ocr-text.jpg (known text), checks the
// lines, boxes in image pixels (top-left origin), usage, and that a bad path answers an error.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "..", "..", "test", "fixtures", "ocr-text.jpg");
const child = spawn(join(here, "probe"), ["--ocr"], { stdio: ["pipe", "pipe", "inherit"] });
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
    const timer = setTimeout(
      () => reject(new Error(`no answer to ${JSON.stringify(req)}`)),
      60_000,
    );
    pending.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    child.stdin.write(`${JSON.stringify({ id, ...req })}\n`);
  });
const failures = [];
const check = (ok, what) => ok || failures.push(what);

try {
  const t = performance.now();
  const r = await ask({ op: "read", path: fixture });
  console.log(`read ${(performance.now() - t).toFixed(0)} ms`, JSON.stringify(r));
  check(r.w === 640 && r.h === 200, "image size in the answer");
  const submit = r.lines?.find((l) => /submit/i.test(l.text));
  const hello = r.lines?.find((l) => /hello/i.test(l.text));
  check(submit && hello, "reads the known text");
  check(submit && hello && submit.y < hello.y, "top-left origin: the upper line has the smaller y");
  check(
    submit && submit.x >= 30 && submit.x <= 50 && submit.w > 150 && submit.w < 400,
    "box in image pixels",
  );
  check(typeof submit?.conf === "number", "conf on Mac");
  check(typeof r.cpuMs === "number", "cpuMs");
  const bad = await ask({ op: "read", path: join(here, "no-such.jpg") });
  check(typeof bad.error === "string", "a missing image answers an error");
  const u = await ask({ op: "usage" });
  check(u.cpuMs > 0 && u.rssMb > 0, `usage: ${JSON.stringify(u)}`);
  console.log(`ocr helper RSS ${u.rssMb} MB`);
} catch (e) {
  failures.push(String(e.message ?? e));
}
child.kill();
if (failures.length) {
  console.error(`FAIL:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("ocr ok");
