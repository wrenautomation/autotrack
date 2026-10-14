import { describe, expect, it } from "vitest";
import { promptAnswer, promptCommand } from "./prompt.ts";

describe("task prompt", () => {
  it("Mac: System Events shows the dialog in front, the question quoted, with a give-up", () => {
    const c = promptCommand('Say "hi" \\ now', "darwin");
    expect(c?.cmd).toBe("osascript");
    const script = (c?.args ?? []).filter((_, i) => i % 2 === 1).join("\n");
    expect(script).toContain('display dialog "Say \\"hi\\" \\\\ now" default answer ""');
    expect(script).toContain("giving up after 600");
    expect(script).toMatch(/^tell application "System Events"\nactivate\nset r to display dialog/);
    expect(script).toContain("end tell");
  });

  it("Windows: a hidden STA PowerShell with the script encoded, quotes doubled", () => {
    const c = promptCommand("What's up?", "win32");
    expect(c?.cmd).toBe("powershell.exe");
    expect(c?.args).toContain("-STA");
    const script = Buffer.from(c?.args.at(-1) ?? "", "base64").toString("utf16le");
    expect(script).toContain("$l.Text = 'What''s up?'");
  });

  it("Linux: zenity, else kdialog, else none", () => {
    const z = promptCommand("What's up?", "linux", () => true);
    expect(z).toEqual({
      cmd: "zenity",
      args: ["--entry", "--title=autotrack", "--text=What's up?", "--timeout=600", "--width=380"],
    });
    const k = promptCommand("What's up?", "linux", (c) => c === "kdialog");
    expect(k).toEqual({
      cmd: "kdialog",
      args: ["--title", "autotrack", "--inputbox", "What's up?", ""],
    });
    expect(promptCommand("q", "linux", () => false)).toBeNull();
    expect(promptAnswer(0, "fixing the build\n", "linux")).toBe("fixing the build");
  });

  it("no prompt elsewhere", () => {
    expect(promptCommand("q", "freebsd")).toBeNull();
  });

  it("the answer: stdout on exit 0, null otherwise; base64 UTF-8 on Windows", () => {
    expect(promptAnswer(0, "fixing the build\n", "darwin")).toBe("fixing the build");
    expect(promptAnswer(0, "\n", "darwin")).toBe("");
    expect(promptAnswer(1, "", "darwin")).toBeNull();
    expect(promptAnswer(null, "", "darwin")).toBeNull();
    const b64 = Buffer.from("café ✓", "utf8").toString("base64");
    expect(promptAnswer(0, `${b64}\r\n`, "win32")).toBe("café ✓");
  });
});
