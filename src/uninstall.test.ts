import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autostartFile, serviceFile } from "./linux.ts";
import { agentPlist, type UninstallDeps, uninstall } from "./uninstall.ts";

let root: string;
let data: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "autotrack-uninstall-"));
  data = join(root, "data");
  home = join(root, "home");
  mkdirSync(join(data, "app", "dist"), { recursive: true });
  writeFileSync(join(data, "config.json"), "{}");
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(agentPlist(home), "<plist/>");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(
    join(home, ".local", "bin", "autotrack"),
    `exec "${join(data, "app", "bin", "autotrack")}"`,
  );
  writeFileSync(join(home, ".local", "bin", "other"), "not ours");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function unshipped() {
  const seg = join(data, "sessions", "20261013T100000-abcd", "000");
  mkdirSync(seg, { recursive: true });
  writeFileSync(join(seg, "events.jsonl"), "{}\n");
  writeFileSync(join(seg, ".done"), "");
}

function deps(over: Partial<UninstallDeps> = {}) {
  const calls: string[] = [];
  const d: UninstallDeps = {
    platform: "darwin",
    data,
    home,
    uid: 501,
    yes: false,
    run: async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return 0;
    },
    confirm: async () => false,
    stopRecorder: async () => {
      calls.push("stop");
    },
    hostUninstall: async () => {
      calls.push("host");
    },
    ship: async () => null,
    log: () => {},
    ...over,
  };
  return { d, calls };
}

describe("uninstall", () => {
  it("Mac: boots out the agent before stopping, removes host, app and data", async () => {
    const { d, calls } = deps();
    expect(await uninstall(d)).toBe(0);
    expect(calls).toEqual([
      "launchctl bootout gui/501/com.wrenautomation.autotrack",
      "stop",
      "host",
    ]);
    expect(existsSync(agentPlist(home))).toBe(false);
    expect(existsSync(data)).toBe(false);
    expect(existsSync(join(home, ".local", "bin", "autotrack"))).toBe(false);
    expect(existsSync(join(home, ".local", "bin", "other"))).toBe(true);
  });

  it("asks before deleting unshipped segments and keeps only sessions on no", async () => {
    unshipped();
    const asked: string[] = [];
    const { d } = deps({
      confirm: async (q) => {
        asked.push(q);
        return false;
      },
    });
    await uninstall(d);
    expect(asked[0]).toMatch(/1 segment\(s\).*never shipped/);
    expect(existsSync(join(data, "sessions", "20261013T100000-abcd", "000", "events.jsonl"))).toBe(
      true,
    );
    expect(existsSync(join(data, "app"))).toBe(false);
    expect(existsSync(join(data, "config.json"))).toBe(false);
  });

  it("--yes deletes unshipped data without asking", async () => {
    unshipped();
    const { d } = deps({
      yes: true,
      confirm: async () => {
        throw new Error("asked");
      },
    });
    await uninstall(d);
    expect(existsSync(data)).toBe(false);
  });

  it("Windows: task, Run key and PATH go; the app dir is removed after exit", async () => {
    const later: string[] = [];
    const { d, calls } = deps({ platform: "win32", removeLater: (p) => later.push(p) });
    await uninstall(d);
    expect(calls.slice(0, 3)).toEqual([
      "schtasks /End /TN autotrack",
      "schtasks /Delete /TN autotrack /F",
      "reg delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v autotrack /f",
    ]);
    expect(calls[3]).toMatch(/^powershell\.exe .*SetEnvironmentVariable\('Path'/);
    expect(calls.slice(4)).toEqual(["stop", "host"]);
    expect(later).toEqual([data]);
    expect(existsSync(join(data, "config.json"))).toBe(false);
    expect(existsSync(join(data, "app"))).toBe(true); // left for removeLater
  });

  it("Linux: the user unit disabled and removed, the autostart entry and shim too", async () => {
    const config = join(home, ".config");
    mkdirSync(join(config, "systemd", "user"), { recursive: true });
    mkdirSync(join(config, "autostart"), { recursive: true });
    writeFileSync(serviceFile(config), "[Unit]\n");
    writeFileSync(autostartFile(config), "[Desktop Entry]\n");
    const { d, calls } = deps({ platform: "linux", config });
    await uninstall(d);
    expect(calls).toEqual([
      "systemctl --user disable --now autotrack.service",
      "systemctl --user daemon-reload",
      "stop",
      "host",
    ]);
    expect(existsSync(serviceFile(config))).toBe(false);
    expect(existsSync(autostartFile(config))).toBe(false);
    expect(existsSync(join(home, ".local", "bin", "autotrack"))).toBe(false);
    expect(existsSync(data)).toBe(false);
  });

  it("Linux without a unit: no systemctl", async () => {
    const { d, calls } = deps({ platform: "linux", config: join(home, ".config") });
    await uninstall(d);
    expect(calls).toEqual(["stop", "host"]);
  });
});
