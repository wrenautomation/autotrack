#!/usr/bin/env node
/**
 * Mac: which permissions does the bundled node hold? Asks the probe (`{"op":"perm"}`) and
 * writes its answer as one JSON line to the file named in argv[2] (or stdout).
 *
 * macOS grants by "responsible process": a probe started from Terminal answers for Terminal.
 * install.sh therefore runs this as a one-shot LaunchAgent job, the same way the recorder runs,
 * so the answer is node's own.
 */
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2];
const done = (answer) => {
  const line = `${JSON.stringify(answer)}\n`;
  if (out) {
    writeFileSync(`${out}.tmp`, line);
    renameSync(`${out}.tmp`, out); // atomic: the installer never reads half a line
  } else process.stdout.write(line);
  process.exit(0);
};

const child = spawn(join(app, "helpers", "mac", "probe"), [], {
  stdio: ["pipe", "pipe", "ignore"],
});
const timer = setTimeout(() => {
  child.kill();
  done({ error: "probe did not answer" });
}, 5000);
let buf = "";
child.on("error", (e) => {
  clearTimeout(timer);
  done({ error: e.message });
});
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c) => {
  buf += c;
  const nl = buf.indexOf("\n");
  if (nl < 0) return;
  clearTimeout(timer);
  child.kill();
  try {
    const { accessibility, input, screen } = JSON.parse(buf.slice(0, nl));
    done({ accessibility, input, screen });
  } catch (e) {
    done({ error: e.message });
  }
});
child.stdin.write(`${JSON.stringify({ id: 1, op: "perm" })}\n`);
