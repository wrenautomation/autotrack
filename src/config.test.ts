import { describe, expect, it } from "vitest";
import { dataDir, decodeCode, hostDevice, parseConfig } from "./config.ts";

const code = {
  v: 1,
  bucket: "autobrowse-prod-track-123456789012",
  region: "us-east-1",
  device: "sister-laptop",
  keyId: "AKIAABCDEFGHIJKLMNOP",
  secret: "abcdefghijklmnopqrstuvwxyz0123456789ABCD",
};
const encoded = Buffer.from(JSON.stringify(code)).toString("base64url");

describe("config", () => {
  it("decodes the install code", () => {
    expect(decodeCode(encoded)).toEqual(code);
    expect(() => decodeCode("not base64!")).toThrow(/base64url/);
    const bad = Buffer.from(JSON.stringify({ ...code, region: "mars" })).toString("base64url");
    expect(() => decodeCode(bad)).toThrow(/region/);
    const extra = Buffer.from(JSON.stringify({ ...code, admin: true })).toString("base64url");
    expect(() => decodeCode(extra)).toThrow(/admin/);
  });

  it("takes the device from the code, and the code as text or decoded", () => {
    expect(parseConfig({ code: encoded }).ship).toEqual(code);
    expect(parseConfig({ code }).device).toBe("sister-laptop");
  });

  it("a bad code warns and records without shipping", () => {
    const warnings: string[] = [];
    const c = parseConfig({ code: "eyJ2Ijoy" }, (m) => warnings.push(m));
    expect(c.ship).toBeUndefined();
    expect(warnings.length).toBe(1);
  });

  it("defaults, and drops bad regexes", () => {
    const c = parseConfig({ excludeTitles: ["ok", "(bad"], maxLocalGb: -1 });
    expect(c.excludeTitles).toEqual(["ok"]);
    expect(c.maxLocalGb).toBe(5);
    expect(hostDevice("Williams-MacBook-Pro.local")).toBe("williams-macbook-pro");
  });

  it("data dir per OS, env wins", () => {
    expect(dataDir({ WREN_TRACK_DIR: "/x" }, "darwin")).toBe("/x");
    expect(dataDir({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32")).toMatch(
      /wren-track$/,
    );
    expect(dataDir({}, "darwin")).toMatch(/Library\/Application Support\/wren-track$/);
  });
});
