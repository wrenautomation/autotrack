#!/usr/bin/env node
/**
 * Zips the extension for the Chrome Web Store: only the files Chrome loads, manifest.json
 * without `key` (the store sets the key). `--first-upload` adds the private key as key.pem at
 * the zip root, which asks the store to keep our id on a new item; never upload it again after.
 * Needs the `zip` command (Mac has it).
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ext = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
const out = join(ext, `autotrack-${manifest.version}.zip`);
const stage = mkdtempSync(join(tmpdir(), "autotrack-pack-"));
try {
  delete manifest.key;
  writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const p of ["main.js", "content", "sw", "icons"])
    cpSync(join(ext, p), join(stage, p), { recursive: true });
  if (process.argv.includes("--first-upload")) {
    const key =
      process.env.AUTOTRACK_KEY || join(homedir(), ".config", "autotrack", "extension-key.pem");
    cpSync(key, join(stage, "key.pem"));
  }
  rmSync(out, { force: true });
  execFileSync("zip", ["-qrX", out, "."], { cwd: stage });
  console.log(out);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
