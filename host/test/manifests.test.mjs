// Native host registration, with a fake fs and registry. Vitest globals (see extension/vitest.config.mjs).
import { readFileSync } from "node:fs";
import {
  EXTENSION_IDS,
  extensionId,
  HOST,
  install,
  targets,
  uninstall,
  wrapperScript,
} from "../manifests.mjs";

function fakeFs() {
  const files = new Map();
  const dirs = new Set();
  const modes = new Map();
  return {
    files,
    dirs,
    modes,
    mkdir: async (p) => void dirs.add(p),
    writeFile: async (p, d) => void files.set(p, String(d)),
    chmod: async (p, m) => void modes.set(p, m),
    rm: async (p) => void files.delete(p),
  };
}

describe("manifests", () => {
  it("allows the id our manifest key gives", () => {
    const m = JSON.parse(
      readFileSync(new URL("../../extension/manifest.json", import.meta.url), "utf8"),
    );
    expect(EXTENSION_IDS[0]).toBe(extensionId(m.key));
    expect(EXTENSION_IDS[0]).toMatch(/^[a-p]{32}$/);
  });

  it("knows each browser's place per OS", () => {
    expect(targets("darwin", "/Users/w")).toEqual([
      {
        browser: "chrome",
        dir: "/Users/w/Library/Application Support/Google/Chrome/NativeMessagingHosts",
      },
      {
        browser: "edge",
        dir: "/Users/w/Library/Application Support/Microsoft Edge/NativeMessagingHosts",
      },
    ]);
    expect(targets("win32", "C:\\Users\\w")).toEqual([
      {
        browser: "chrome",
        regKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`,
      },
      { browser: "edge", regKey: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST}` },
    ]);
    expect(targets("linux", "/home/w").map((t) => t.dir)).toEqual([
      "/home/w/.config/google-chrome/NativeMessagingHosts",
      "/home/w/.config/chromium/NativeMessagingHosts",
      "/home/w/.config/microsoft-edge/NativeMessagingHosts",
      "/home/w/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    ]);
    expect(() => targets("freebsd")).toThrow(/Mac, Windows and Linux/);
  });

  it("installs on Mac: wrapper with node, one manifest per browser", async () => {
    const fs = fakeFs();
    const out = await install({
      nodePath: "/Users/w/Library/Application Support/autotrack/node/bin/node",
      hostScript: "/Users/w/Library/Application Support/autotrack/app/host/autotrack-host.mjs",
      platform: "darwin",
      env: {},
      home: "/Users/w",
      fs,
    });
    const wrapper = "/Users/w/Library/Application Support/autotrack/native-host/autotrack-host.sh";
    expect(out.wrapper).toBe(wrapper);
    expect(fs.files.get(wrapper)).toBe(
      "#!/bin/sh\nexec '/Users/w/Library/Application Support/autotrack/node/bin/node' '/Users/w/Library/Application Support/autotrack/app/host/autotrack-host.mjs' \"$@\"\n",
    );
    expect(fs.modes.get(wrapper)).toBe(0o755);
    expect(out.manifests).toEqual([
      `/Users/w/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST}.json`,
      `/Users/w/Library/Application Support/Microsoft Edge/NativeMessagingHosts/${HOST}.json`,
    ]);
    const m = JSON.parse(fs.files.get(out.manifests[0]));
    expect(m).toEqual({
      name: HOST,
      description: expect.any(String),
      path: wrapper,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_IDS[0]}/`],
    });
    await uninstall({ platform: "darwin", env: {}, home: "/Users/w", fs });
    expect([...fs.files.keys()]).toEqual([]);
  });

  it("installs on Linux: wrapper in the XDG data dir, one manifest per browser", async () => {
    const fs = fakeFs();
    const out = await install({
      nodePath: "/home/w/.local/share/autotrack/app/node/node",
      hostScript: "/home/w/.local/share/autotrack/app/host/autotrack-host.mjs",
      platform: "linux",
      env: {},
      home: "/home/w",
      fs,
    });
    const wrapper = "/home/w/.local/share/autotrack/native-host/autotrack-host.sh";
    expect(out.wrapper).toBe(wrapper);
    expect(fs.modes.get(wrapper)).toBe(0o755);
    expect(out.manifests).toHaveLength(4);
    expect(out.manifests[3]).toBe(
      `/home/w/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/${HOST}.json`,
    );
    expect(JSON.parse(fs.files.get(out.manifests[1])).path).toBe(wrapper);
    await uninstall({ platform: "linux", env: {}, home: "/home/w", fs });
    expect([...fs.files.keys()]).toEqual([]);
  });

  it("installs on Windows: .cmd wrapper, one manifest, a registry key per browser", async () => {
    const fs = fakeFs();
    const runs = [];
    const run = async (cmd, args) => runs.push([cmd, ...args]);
    const env = { LOCALAPPDATA: "C:\\Users\\w\\AppData\\Local" };
    const out = await install({
      nodePath: "C:\\Users\\w\\AppData\\Local\\autotrack\\node\\node.exe",
      hostScript: "C:\\Users\\w\\AppData\\Local\\autotrack\\app\\host\\autotrack-host.mjs",
      platform: "win32",
      env,
      home: "C:\\Users\\w",
      fs,
      run,
    });
    const dir = "C:\\Users\\w\\AppData\\Local\\autotrack\\native-host";
    expect(out.wrapper).toBe(`${dir}\\autotrack-host.cmd`);
    expect(fs.files.get(out.wrapper)).toBe(
      '@echo off\r\n"C:\\Users\\w\\AppData\\Local\\autotrack\\node\\node.exe" "C:\\Users\\w\\AppData\\Local\\autotrack\\app\\host\\autotrack-host.mjs" %*\r\n',
    );
    const manifest = `${dir}\\${HOST}.json`;
    expect(JSON.parse(fs.files.get(manifest)).path).toBe(out.wrapper);
    expect(runs).toEqual([
      [
        "reg",
        "add",
        `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`,
        "/ve",
        "/t",
        "REG_SZ",
        "/d",
        manifest,
        "/f",
      ],
      [
        "reg",
        "add",
        `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST}`,
        "/ve",
        "/t",
        "REG_SZ",
        "/d",
        manifest,
        "/f",
      ],
    ]);
    runs.length = 0;
    await uninstall({
      platform: "win32",
      env,
      home: "C:\\Users\\w",
      fs,
      run: async (...a) => {
        runs.push(a);
        throw new Error("not found"); // a missing key is fine
      },
    });
    expect(runs.map(([, args]) => args[0])).toEqual(["delete", "delete"]);
    expect([...fs.files.keys()]).toEqual([]);
  });

  it("quotes paths safely and pins a control path when asked", () => {
    expect(wrapperScript("darwin", "/a b/node", "/it's/host.mjs", "/tmp/c.sock")).toBe(
      "#!/bin/sh\nAUTOTRACK_CONTROL='/tmp/c.sock' exec '/a b/node' '/it'\\''s/host.mjs' \"$@\"\n",
    );
    expect(wrapperScript("win32", "C:\\n\\node.exe", "C:\\h.mjs", "\\\\.\\pipe\\x")).toContain(
      'set "AUTOTRACK_CONTROL=\\\\.\\pipe\\x"\r\n',
    );
    expect(() => wrapperScript("win32", 'C:\\a"b\\node.exe', "C:\\h.mjs")).toThrow(/\.cmd/);
    expect(() => wrapperScript("win32", "C:\\%PATH%\\node.exe", "C:\\h.mjs")).toThrow(/\.cmd/);
  });
});
