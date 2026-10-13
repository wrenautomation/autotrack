import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeJpeg, fitSize } from "./jpeg.ts";

function gradient(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      px[p] = (x * 255) / w;
      px[p + 1] = (y * 255) / h;
      px[p + 2] = 128;
      px[p + 3] = 255;
    }
  return px;
}

/** Width and height from the SOF0 marker. */
function sof(jpeg: Uint8Array): { width: number; height: number } {
  for (let i = 2; i < jpeg.length - 8; i++)
    if (jpeg[i] === 0xff && jpeg[i + 1] === 0xc0) {
      const b = (k: number) => jpeg[i + k] as number;
      return { height: (b(5) << 8) | b(6), width: (b(7) << 8) | b(8) };
    }
  throw new Error("no SOF0");
}

describe("jpeg", () => {
  it("caps the long side at 1920 and keeps the aspect", () => {
    expect(fitSize(3024, 1964)).toEqual({ width: 1920, height: 1247 });
    expect(fitSize(3840, 2160)).toEqual({ width: 1920, height: 1080 });
    expect(fitSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(fitSize(1366, 768)).toEqual({ width: 1366, height: 768 });
  });

  it("encodes a baseline JPEG at the fitted size", () => {
    const j = encodeJpeg(gradient(2100, 101), 2100, 101);
    expect([j[0], j[1]]).toEqual([0xff, 0xd8]);
    expect([j[j.length - 2], j[j.length - 1]]).toEqual([0xff, 0xd9]);
    expect(sof(j)).toEqual({ width: 1920, height: 92 });
  });

  it.runIf(process.platform === "darwin")("decodes (sips)", () => {
    const dir = mkdtempSync(join(tmpdir(), "track-jpeg-"));
    try {
      const path = join(dir, "f.jpg");
      writeFileSync(path, encodeJpeg(gradient(333, 217), 333, 217));
      execFileSync("sips", ["-s", "format", "png", path, "--out", join(dir, "f.png")]);
      const out = execFileSync(
        "sips",
        ["-g", "pixelWidth", "-g", "pixelHeight", join(dir, "f.png")],
        {
          encoding: "utf8",
        },
      );
      expect(out).toMatch(/pixelWidth: 333/);
      expect(out).toMatch(/pixelHeight: 217/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
