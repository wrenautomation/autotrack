import { describe, expect, it } from "vitest";
import type { Element } from "./events.ts";
import { blocked, holdForFocus, makeGate, redactSecrets, textOf } from "./privacy.ts";

const el = (secure: boolean): Element => ({
  role: "textfield",
  name: "Password",
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  secure,
});

describe("password fields", () => {
  it("never writes keys typed into a secure field", () => {
    expect(textOf("hunter2", { element: el(true) })).toEqual({ text: "", redacted: true });
  });
  it("writes plain text into an ordinary field", () => {
    expect(textOf("hello", { element: el(false) })).toEqual({ text: "hello", redacted: false });
    expect(textOf("hello", { element: null })).toEqual({ text: "hello", redacted: false });
  });
  it("writes a run nobody could vouch for (no probe answer) redacted", () => {
    expect(textOf("hunter2", null)).toEqual({ text: "", redacted: true });
  });
});

describe("held keys", () => {
  const noSleep = async () => {};
  it("asks again until the probe answers", async () => {
    const answers = [null, null, { element: el(true) }];
    let asked = 0;
    const got = await holdForFocus(null, async () => answers[asked++] ?? null, { sleep: noSleep });
    expect(asked).toBe(3);
    expect(textOf("hunter2", got)).toEqual({ text: "", redacted: true });
  });
  it("gives up after its tries and the run is redacted", async () => {
    let asked = 0;
    const got = await holdForFocus(
      null,
      async () => {
        asked++;
        return null;
      },
      { tries: 4, sleep: noSleep },
    );
    expect(asked).toBe(4);
    expect(textOf("anything", got).redacted).toBe(true);
  });
  it("does not ask when the first answer came in time", async () => {
    let asked = 0;
    await holdForFocus({ element: null }, async () => {
      asked++;
      return null;
    });
    expect(asked).toBe(0);
  });
});

describe("secret text", () => {
  it("masks token shapes and card numbers, keeps the rest", () => {
    const r = redactSecrets("key AKIAABCDEFGHIJKLMNOP done");
    expect(r).toEqual({ text: "key <redacted> done", redacted: true });
    expect(redactSecrets("card 4242 4242 4242 4242").text).toBe("card <redacted>");
    expect(redactSecrets("order 1234567890123")).toEqual({
      text: "order 1234567890123",
      redacted: false,
    });
    expect(textOf("sk-abcdefghijklmnopqrstuvwxyz", { element: null }).redacted).toBe(true);
  });
});

describe("excluded apps and lock", () => {
  const gate = makeGate({ excludeApps: ["Signal"], excludeTitles: ["secret project"] });
  const app = (name: string, id: string) => ({ name, id, pid: 1 });
  it("matches password managers by name, bundle id or exe path", () => {
    expect(blocked(gate, app("1Password 8", "com.1password.1password"), null)).toBe("excluded");
    expect(blocked(gate, app("Keychain Access", "com.apple.keychainaccess"), null)).toBe(
      "excluded",
    );
    expect(blocked(gate, app("KeePass", "C:\\Program Files\\KeePass\\KeePass.exe"), null)).toBe(
      "excluded",
    );
    expect(blocked(gate, app("Bitwarden", "com.bitwarden.desktop"), null)).toBe("excluded");
    expect(blocked(gate, app("Safari", "com.apple.Safari"), null)).toBeNull();
  });
  it("adds config apps and titles; banking by window title", () => {
    expect(blocked(gate, app("Signal", "org.whispersystems.signal-desktop"), null)).toBe(
      "excluded",
    );
    const w = (title: string) => ({ title, x: 0, y: 0, width: 1, height: 1 });
    expect(blocked(gate, app("Chrome", "com.google.Chrome"), w("Chase Online - Accounts"))).toBe(
      "excluded",
    );
    expect(blocked(gate, app("Chrome", "com.google.Chrome"), w("PayPal: Summary"))).toBe(
      "excluded",
    );
    expect(blocked(gate, app("Notes", "com.apple.Notes"), w("My Secret Project"))).toBe("excluded");
    expect(blocked(gate, app("Chrome", "com.google.Chrome"), w("Inbox"))).toBeNull();
  });
  it("the lock screen pauses", () => {
    expect(blocked(gate, app("loginwindow", "com.apple.loginwindow"), null)).toBe("locked");
    expect(blocked(gate, app("LockApp", "C:\\Windows\\SystemApps\\LockApp.exe"), null)).toBe(
      "locked",
    );
  });
});
