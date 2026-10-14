import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isWayland,
  linuxDoctor,
  linuxPower,
  onPath,
  osReleaseName,
  powerOfSupplies,
  sessionType,
} from "./linux.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "autotrack-linux-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Linux readings", () => {
  it("power: AC from Mains or USB online, battery from a Battery, device batteries left out", () => {
    expect(powerOfSupplies([])).toBeNull();
    expect(powerOfSupplies([{ type: "Mains", online: "1" }])).toEqual({ ac: true, battery: null });
    expect(
      powerOfSupplies([
        { type: "Mains", online: "0" },
        { type: "Battery", capacity: "57" },
        { type: "Battery", scope: "Device", capacity: "4" },
      ]),
    ).toEqual({ ac: false, battery: 57 });
    expect(
      powerOfSupplies([
        { type: "Mains", online: "0" },
        { type: "USB", online: "1" },
        { type: "Battery", capacity: "80" },
        { type: "Battery", capacity: "30" },
      ]),
    ).toEqual({ ac: true, battery: 30 });
    // a battery and no AC supply reads as on battery
    expect(powerOfSupplies([{ type: "Battery", capacity: "90" }])).toEqual({
      ac: false,
      battery: 90,
    });
  });

  it("power: read from a sysfs-shaped dir", async () => {
    const supply = (n: string, files: Record<string, string>) => {
      mkdirSync(join(root, n));
      for (const [f, v] of Object.entries(files)) writeFileSync(join(root, n, f), `${v}\n`);
    };
    expect(await linuxPower(join(root, "missing"))).toBeNull();
    supply("AC", { type: "Mains", online: "1" });
    supply("BAT0", { type: "Battery", capacity: "42", status: "Charging" });
    expect(await linuxPower(root)).toEqual({ ac: true, battery: 42 });
  });

  it("session type: XDG_SESSION_TYPE, else WAYLAND_DISPLAY, else DISPLAY", () => {
    expect(sessionType({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" })).toBe("x11");
    expect(sessionType({ XDG_SESSION_TYPE: "wayland" })).toBe("wayland");
    expect(sessionType({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })).toBe("wayland");
    expect(sessionType({ XDG_SESSION_TYPE: "unspecified", DISPLAY: ":99" })).toBe("x11");
    expect(sessionType({})).toBe("");
    expect(isWayland({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" })).toBe(false);
    expect(isWayland({ XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" })).toBe(true);
  });

  it("os-release: PRETTY_NAME, else NAME and VERSION_ID", () => {
    expect(
      osReleaseName('NAME="Ubuntu"\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n'),
    ).toBe("Ubuntu 24.04.1 LTS");
    expect(osReleaseName("NAME=Fedora Linux\nVERSION_ID=41\n")).toBe("Fedora Linux 41");
    expect(osReleaseName("")).toBeNull();
  });

  it("onPath finds executables only", () => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "zenity"), "#!/bin/sh\n");
    chmodSync(join(bin, "zenity"), 0o755);
    writeFileSync(join(bin, "kdialog"), "not executable");
    const env = { PATH: `/nonexistent:${bin}` };
    expect(onPath("zenity", env)).toBe(join(bin, "zenity"));
    expect(onPath("kdialog", env)).toBeNull();
    expect(onPath("zenity", {})).toBeNull();
  });
});

describe("linuxDoctor", () => {
  const perm = {
    accessibility: true,
    screen: true,
    input: true,
    session: "x11",
    atspi: true,
    record: true,
  };
  it("an X11 session with everything is all good", () => {
    const lines = linuxDoctor(perm, {}, () => true);
    expect(lines.every((l) => l.good === true)).toBe(true);
    expect(lines.map((l) => l.msg).join("\n")).toMatch(
      /AT-SPI.*\n.*RECORD.*\n.*screen.*\n.*tesseract found/s,
    );
  });
  it("warns on Wayland and notes a missing tesseract", () => {
    const lines = linuxDoctor({ ...perm, session: "wayland" }, {}, () => false);
    expect(lines[0]).toMatchObject({ good: false, msg: expect.stringMatching(/Wayland.*Xorg/) });
    expect(lines.at(-1)).toMatchObject({
      good: null,
      msg: expect.stringMatching(/apt install tesseract-ocr/),
    });
  });
  it("names what is missing, and an unknown helper", () => {
    const lines = linuxDoctor(
      { ...perm, atspi: false, record: false },
      { XDG_SESSION_TYPE: "x11" },
      () => true,
    );
    expect(lines.filter((l) => l.good === false).map((l) => l.msg)).toEqual([
      expect.stringMatching(/AT-SPI not answering/),
      expect.stringMatching(/no RECORD/),
    ]);
    expect(linuxDoctor(null, { XDG_SESSION_TYPE: "x11" }, () => true)[1]).toMatchObject({
      good: false,
    });
  });
});
