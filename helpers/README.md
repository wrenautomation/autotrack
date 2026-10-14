# Probe helpers

Small native child processes that `src/probe.ts` talks to over stdin and stdout, one JSON line each way. They answer: what app and window is in front, what UI element is at a point or has focus (role, name, bounds, never its value), is it a password field, and are the OS permissions granted. `mac/probe.swift` uses the Accessibility API. On Windows, `win/autotrack-helper.exe --probe` uses UI Automation. The protocol is in `designs/2026-10-13-autotrack.md`. The Windows helper works in physical pixels, which is what uiohook reports there.

Mac: `mac/build.sh` builds the universal `mac/probe` (needs `swiftc`); `mac/test.sh` builds it, checks each op's shape and prints `at` latency over 50 requests. The test needs Accessibility granted to the terminal you run it from, or `at` and `focused` return null and it says so. Windows: `win\build.ps1` builds `win\autotrack-helper.exe` from the `*.cs` files with the C# compiler in .NET Framework 4.8, so it builds and runs on any Windows 10 or 11 with nothing installed. `powershell -NoProfile -ExecutionPolicy Bypass -File win\test.ps1` builds it, starts the helper, opens Notepad, and checks `at`, `focused` and `front`; it exits non-zero and prints what failed. It also fails when a helper sits above 30 MB RSS after 5 s idle (shots: 30 MB plus its ring of 4 frames).

The Windows probe caches the focused element. A WinEvent hook on focus and foreground changes marks the cache stale; a cached answer lives at most 2 s and only while the focused window is the same. Each helper trims its memory after 5 s with no requests.

Elements carry `path` (up to 6 ancestors below the window, nearest first), and `id`, `cls`, `url` (Mac only), `help` when non-empty; never a value. Mac: for Chromium and Electron apps the probe sets `AXManualAccessibility` once per pid so web content shows its real tree (a Chrome page's button then reads as role `button`, name, `id`); the first answer for a new app can take about 100 ms and the tree fills in over the next second or two. `AUTOTRACK_PROBE_NO_ENHANCE=1` turns that off, for measuring. Windows: Chromium builds its UIA tree when a UIA client asks, so nothing is set; a first query right after a browser starts may be sparse. `AUTOTRACK_TEST_CHROME=1 mac/test.sh` also checks a real Chrome page.

## Shots mode

`mac/probe --shots` and `win\autotrack-helper.exe --shots` are a second helper for frames: `displays`, `grab` (into a ring of the last 4, at most 1920 px, with a 64-bit hash) and `save` (JPEG via a temp file and rename). `src/capture.ts` talks to it; the protocol is in `designs/2026-10-13-autotrack.md` under "Shots protocol". Mac uses ScreenCaptureKit on macOS 14+ (about 75 ms wall, 2.5 ms CPU, 55 MB RSS per grab) and falls back to `CGDisplayCreateImage` (about 40 ms CPU, 210 to 350 MB RSS). `AUTOTRACK_SHOTS_CG=1` forces the fallback and `AUTOTRACK_SHOTS_SCK=1` forces SCK, for measuring.

`mac/test.sh` also runs `mac/test-shots.mjs` (shapes, JPEG magic, ring reuse, p50/p95 per grab and save, helper RSS); it needs Screen Recording granted to the terminal. `win\test.ps1` runs the same checks against `--shots` (JPEG starts with FFD8, at most 1920 px, ring, timing).

Shots mode also answers `crop` (one rect of a display at its native pixels, JPEG, for small text the 1920 px frame loses) and every mode answers `usage` (the helper's own CPU ms and RSS). The Windows probe answers `power` (`GetSystemPowerStatus`).

## OCR mode

`mac/probe --ocr` and `win\autotrack-helper.exe --ocr` read text from one image per `read` request: Vision (accurate) on the Mac at background QoS, `Windows.Media.Ocr` on Windows at BelowNormal priority. Boxes are in image pixels, origin top-left; Windows gives no confidence. The recorder starts it only when the person is idle and kills it at the first input. `mac/test.sh` runs `mac/test-ocr.mjs` and `win\test.ps1` runs the same check, both on `test/fixtures/ocr-text.jpg`. A Windows install with no OCR language answers an error; the test adds en-US then.
