import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { holdsFrom, holdUploads, winHoldsFrom } from "./metered.ts";

describe("metered", () => {
  it("holds when the mode is on, or auto on a metered network; never when off", () => {
    expect(holdsFrom("on unmetered running\n")).toBe(true);
    expect(holdsFrom("auto metered paused\n")).toBe(true);
    expect(holdsFrom("auto unmetered running\n")).toBe(false);
    expect(holdsFrom("off metered running\n")).toBe(false);
    expect(holdsFrom("")).toBe(false);
  });

  it("on Windows, holds on a fixed or variable cost or near a data limit", () => {
    expect(winHoldsFrom("Fixed\r\n")).toBe(true);
    expect(winHoldsFrom("Variable\r\n")).toBe(true);
    expect(winHoldsFrom("limit\r\n")).toBe(true);
    expect(winHoldsFrom("Unrestricted\r\n")).toBe(false);
    expect(winHoldsFrom("Unknown\r\n")).toBe(false);
    expect(winHoldsFrom("none\r\n")).toBe(false);
    expect(winHoldsFrom("")).toBe(false);
  });

  it("asks the script; a missing or failed script never holds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metered-"));
    try {
      const ok = join(dir, "ok.sh");
      writeFileSync(ok, 'echo "on unmetered running"\n');
      const bad = join(dir, "bad.sh");
      writeFileSync(bad, 'echo "on metered paused"; exit 3\n');
      expect(await holdUploads(ok)).toBe(true);
      expect(await holdUploads(bad)).toBe(false);
      expect(await holdUploads(join(dir, "none.sh"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
