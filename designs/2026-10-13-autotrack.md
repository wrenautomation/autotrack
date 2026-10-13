# autotrack: every input, every screen, Mac and Windows

2026-10-13. William: "a global action tracker for every single cursor, keyboard click, etc. on mac
and on windows, have it easy to install, just for data for future RL / computer use projects."
He'll install it on his Mac and his sister's Windows laptop.

## What it is

`autotrack`: a small recorder that runs at login and writes what a person does to sessions on
disk, then ships them to a private S3 bucket. Each event carries the input, the app and window, the
UI element under it, and the screen before and after. It is the "every action tracked" half of
play/pause (memory: play-pause-computer-agent): `autobrowse autotrack import` turns a session into a
`Recording` that teach and compile already read.

Lives in `autobrowse/track/`, its own package with its own `package.json`, apart from autobrowse's
heavy deps (Playwright, AWS SDKs, Restate). Imports nothing from `autobrowse/src`; autobrowse
imports nothing from it except the session format (copied types in `src/autotrack/`, checked equal by a
test).

## Pieces

| Piece | Files | Does |
|---|---|---|
| hook | `src/hook.ts` | `uiohook-napi` (Mac, Windows): raw mouse and key events |
| events | `src/events.ts` | raw → `Event`: throttle moves, pair down/up into click/drag, fold keys into text runs and hotkeys |
| screen | `src/screen.ts` | `node-screenshots`: the display under the cursor, a 2 fps ring of the latest frame (JPEG), "after" frame 300 ms after an act |
| probe | `src/probe.ts` + `helpers/` | app, window, element at a point, focused element is a password: Swift helper on Mac, PowerShell UIA helper on Windows, one JSON-lines protocol |
| privacy | `src/privacy.ts` | password fields, excluded apps, secret-shaped text, pause |
| journal | `src/journal.ts` | session dir, 5-minute segments, `events.jsonl` + `frames/`, closed segment → `.done` |
| ship | `src/ship.ts` | closed segments → S3 under the device's prefix, delete after put, local cap |
| cli | `src/cli.ts` | `autotrack start|stop|pause|resume|status|ship|doctor|uninstall` |
| install | `install/install.sh`, `install.ps1` | one line, no Node needed: download the bundle, autostart, permissions |
| bundle | `.github/workflows/track.yml` | per-OS bundle (portable Node + app + node_modules) as a GitHub Release asset, e2e on real Mac and Windows runners |
| storage | `deploy/terraform/track.tf`, `autobrowse autotrack enroll` | bucket; one write-only IAM user per device |
| import | `src/autotrack/` in autobrowse, `autobrowse autotrack import|list` | a session → `Recording` (desktop acts) |

## Session format (the contract every piece codes to)

```
<data>/sessions/<session>/            session = <yyyymmddThhmmss>-<4 hex>
  session.json                        { v:1, session, device, os, osVersion, arch, trackVersion,
                                        startedAt, endedAt|null, displays:[{id,x,y,width,height,scale,primary}] }
  <segment>/                          segment = 000, 001, … (5 minutes or 2,000 events each)
    events.jsonl                      one Event per line
    frames/<n>.jpg                    n = frame number in the session
    .done                             written last; ship only takes dirs with it
```

`<data>`: `~/Library/Application Support/autotrack` (Mac), `%LOCALAPPDATA%\autotrack` (Windows),
`$AUTOTRACK_DIR` overrides.

```ts
interface Base {
  t: number;            // ms since session start (monotonic)
  ts: number;           // epoch ms
  app?: { name: string; id: string; pid: number };      // id: bundle id (Mac) / exe path (Windows)
  window?: { title: string; x: number; y: number; width: number; height: number };
  display?: string;     // display id the act is on
}
interface Element { role: string; name: string; x: number; y: number; width: number; height: number;
                    secure: boolean }   // never the element's value
type Event = Base & (
  | { kind: "move"; x: number; y: number }                          // ≤ 20 Hz, ≥ 4 px
  | { kind: "click"; x: number; y: number; button: "left"|"right"|"middle"; count: number;
      element?: Element; before?: number; after?: number }         // before/after = frame numbers
  | { kind: "drag"; x0: number; y0: number; x: number; y: number; button: "left"|"right"|"middle";
      element?: Element; before?: number; after?: number }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number; element?: Element;
      before?: number; after?: number }                            // wheel ticks folded per 250 ms
  | { kind: "text"; text: string; redacted: boolean; element?: Element; before?: number; after?: number }
                                                                    // printable keys folded, ends at 1 s idle, a click, or a non-text key
  | { kind: "key"; key: string; mods: ("ctrl"|"alt"|"shift"|"meta")[]; element?: Element;
      before?: number; after?: number }                            // enter, tab, arrows, esc, backspace runs, and any combo
  | { kind: "focus"; }                                              // app or window changed (app/window on Base)
  | { kind: "frame"; frame: number }                                // a screen change with no act (idle reading)
  | { kind: "pause"; reason: "hotkey"|"cli"|"excluded"|"locked" }
  | { kind: "resume" }
);
```

Coordinates are global, in the OS's logical points; `displays[].scale` turns them into frame
pixels. Mac's uiohook and AX already speak points. Windows' uiohook and the UIA probe speak physical
pixels (per-monitor DPI aware), so the recorder divides by the display's scale on the way in and
multiplies on the way to the probe, in one place. Key names are uiohook's names
lowercased (`a`, `enter`, `f5`, `numpad1`). Frames: JPEG quality 70, the display the act is on, at
most 1920 px on the long side (downscaled from the capture when larger), so a 4K screen costs the
same as a 1080p one.

## Rules

- **Before frame**: the ring's latest frame (≤ 500 ms old). Captured continuously only while input
  happened in the last 5 s; idle = no capture. A frame is written once, referenced by number.
- **Idle reading**: while nobody types or clicks but the screen changes (scrolling a page, video),
  one `frame` event every 2 s at most when the frame differs from the last written one (cheap hash
  on a downsampled copy).
- **Password fields never log keys.** The probe answers `secure` for the focused element
  (Mac: `AXSecureTextField` subrole or `IsSecureEventInputEnabled()`; Windows: UIA `IsPassword`).
  Typing into one writes `{kind:"text", text:"", redacted:true}`. When the probe can't answer in
  50 ms, keys are held, not written, until it does.
- **Secret-shaped text** (autobrowse `looksLikeSecretValue` patterns, copied) is redacted.
- **Excluded apps** record nothing, frames included (`pause` reason `excluded`). Default list:
  1Password, Bitwarden, Keychain Access, Passwords (Mac), KeePass, banking via window title
  `/bank|chase|wells fargo|paypal/i`. `config.json` extends it.
- **Locked screen / login window**: pause.
- **Pause hotkey**: Ctrl+Alt+Shift+P toggles, with an OS notification ("Tracking paused" /
  "Tracking on"). A notification also says when tracking starts after login. No tray icon (Node
  has none without a binary dependency); `autotrack status` answers.
- **Overhead budget**: under 3% of one core on average, under 200 MB RSS, measured by `doctor`.

## Probe protocol

The helper is a long-lived child; one JSON request per line on stdin, one response per line on stdout.

```
→ {"id":1,"op":"at","x":100,"y":200}       ← {"id":1,"element":{…}|null}
→ {"id":2,"op":"front"}                     ← {"id":2,"app":{…},"window":{…}|null}
→ {"id":3,"op":"focused"}                   ← {"id":3,"element":{…}|null}
→ {"id":4,"op":"perm"}                      ← {"id":4,"accessibility":true,"screen":true,"input":true}
```

Mac: `helpers/mac/probe.swift`, built by `swiftc -O` into a universal binary in CI and
shipped in the Mac bundle (and built on first run if missing and `swiftc` exists). Windows:
`helpers/win/probe.ps1`, Windows PowerShell 5.1 (on every Windows), `UIAutomationClient` +
P/Invoke for the foreground window. Each answer under 50 ms p95; a timeout gives `null`, never a
stall in the hook.

## Storage

- Bucket `autobrowse-prod-track-<acct>` (`deploy/terraform/track.tf`, like `shots.tf`): private,
  AES256, versioning off; lifecycle → Glacier Instant Retrieval after 30 days (about $4 per TB a
  month, read in milliseconds when a training run wants it).
- Key: `<device>/<session>/<segment>/events.jsonl.gz`, `…/frames/<n>.jpg`, `<device>/<session>/session.json`.
- `autobrowse autotrack enroll <device>` (William's Mac, his AWS user): IAM user `track-<device>` with
  only `s3:PutObject` on `<bucket>/<device>/*`; makes an access key; prints the one-line install
  command carrying `<bucket>`, `<device>` and the key. The key can write its own prefix and nothing
  else, so a laptop that's lost leaks nothing. `--revoke` deletes the user.
- `autotrack ship`: runs every 5 minutes in the recorder; puts each closed segment, then deletes it
  locally. Offline: segments wait; past `maxLocalGb` (default 5) the oldest frames go first, events
  never.

## Install

- **Windows**: `powershell -c "$env:AUTOTRACK='<code>'; irm https://raw.githubusercontent.com/wrenautomation/autotrack/main/install/install.ps1 | iex"`.
  Downloads the latest `autotrack-win-x64.zip` release asset (portable Node + app), checks its
  SHA-256 against the release's `SHA256SUMS`, unpacks into `%LOCALAPPDATA%\autotrack`, writes
  `config.json` from the code, registers a per-user logon Scheduled Task (no admin) that starts it
  hidden, starts it now. No admin, no SmartScreen (node.exe is signed by OpenJS).
- **Mac**: `AUTOTRACK='<code>' sh -c "$(curl -fsSL …/install.sh)"`. Same, into
  `~/Library/Application Support/autotrack`, a LaunchAgent, then opens the three Privacy panes
  (Accessibility, Input Monitoring, Screen Recording) for the bundled `node` and waits until
  `doctor` says each is granted.
- `autotrack uninstall` removes the task or agent and the app; asks before deleting unshipped data.
- Updates: the installer is idempotent; re-running it updates in place.

## Testing

- Unit (vitest, the repo root): event folding (clicks, double clicks, drags, scroll folding, text runs,
  hotkeys, backspace), privacy (secure focus, held keys on probe timeout, excluded apps, secret
  text), journal (segment rotation, `.done` last, crash leaves an open segment that the next start
  closes), ship (fake store: order, delete after put, cap), probe protocol (fake child: timeouts,
  out-of-order answers).
- E2E on real OSes (`track.yml`, `macos-latest` and `windows-latest`): start the bundle, inject input
  (Windows `SendInput`; Mac `CGEvent` via a small Swift script), open a text editor and type, click a
  button, then check the session: events in order, clicks carry an element with a role and name,
  frames exist and decode, a password box (a test form) logs `redacted`. Where a runner can't grant
  a permission, the test says which and skips that check instead of passing silently.
- Install scripts run end to end on both runners against the just-built bundle (local file URL),
  then `uninstall`.

## Name and repo (2026-10-13, William)

"name it something like autotrack, in the autobrowse line, this thing is more decoupled." The
recorder is **autotrack**: its own repo `wren_automation/autotrack` (GitHub
`wrenautomation/autotrack`, public, PolyForm like the rest), binary `autotrack`, data dir
`autotrack`, install URLs under that repo. the repo root here moves there once its first build lands.
autobrowse keeps only the consumer side: `autobrowse autotrack enroll|devices|list|import`.

## What was clicked, as granular as it gets (2026-10-13, William)

"it needs to know what is being clicked, as granular as possible (a button rendered with JS in a
browser, or something in Wren UI where the trace of what it does may be useful for reasoning RL)."
Three layers, each optional, joined offline by time and position:

1. **OS probe, richer.** `Element` gains `path` (up to 6 ancestors, `{role,name}` each, nearest
   first), `id` (AXIdentifier / UIA AutomationId), `cls` (UIA ClassName / AXDOMClassList joined),
   `url` (AXURL for links), `help`. On Mac the probe sets `AXManualAccessibility` (and
   `AXEnhancedUserInterface` for apps that need it) on each Chromium or Electron app once per pid, so
   web content shows its real accessibility tree to AX; Windows Chromium turns its tree on when a
   UIA client asks.
2. **Browser extension** (`autotrack/extension/`, Manifest V3, Chrome + Edge). A content script in
   every frame records, on each pointer down, click, input change (value only through the same
   redaction rules; never a password field), submit, key with modifiers, and scroll end, a
   `web` event:
   `{kind:"web", act, ts, tab, frame, url, title, x, y (screen points), target:{tag, role, name,
   text (≤200), id, testId, css, xpath, href, inputType, attrs (aria-*, data-* names and values ≤80
   chars, no value attrs), react (component names, nearest first, ≤12), rect (screen points)},
   effects?}`. `effects` lands on a follow-up `web` event `act:"effect"` 1 s after the act:
   `{url (if changed), requests:[{method, url (origin + path, no query), status, ms}], dom:{added,
   removed, textChanged}}`; requests come from the service worker's `webRequest` (no bodies, no
   headers). Screen coordinates: `screenX/screenY` (CSS px; the extension multiplies by
   `devicePixelRatio` / zoom correctly to land in OS points). The service worker sends events over
   **native messaging** to host `com.wrenautomation.autotrack`: a tiny Node script in the bundle
   that relays each JSON line to the recorder's control socket as op `web`; the recorder writes it
   into the journal as is. No open port. The installer registers the host (HKCU registry key on
   Windows, `NativeMessagingHosts/` for Chrome and Edge on Mac; no admin). Distribution: Chrome Web
   Store, unlisted (Edge installs from it too); a direct link printed by the installer.
3. **App events.** Any page may say what an act meant:
   `window.postMessage({autotrack:{v:1, action, detail}}, "*")` (`action` like
   `"approve-message"`, `detail` small JSON: ids, outcome, no secrets). The content script forwards
   it as `{kind:"app", ts, url, action, detail}`. The Wren portal emits one per user command at its
   command layer (what was asked, on which records, what the API answered).

Joined offline (`autobrowse autotrack import` and any training loader): an OS `click` and a `web`
`click` are the same act when `|ts| < 150 ms` and the points are within 4 px.

New `Event` kinds, appended to the union:
`| { kind: "web"; act: string; tab: number; frame: number; url: string; title: string; x?: number;
y?: number; target?: WebTarget; effects?: WebEffects }`
`| { kind: "app"; url: string; action: string; detail: unknown }`

## Decision log

- Node + `uiohook-napi` + `node-screenshots` over Rust: same language and redaction rules as
  autobrowse, both libraries ship prebuilds for darwin-arm64, darwin-x64, win32-x64. The bundle
  carries its own Node, so the laptop needs nothing installed.
- A GitHub Release bundle over npm: one download, no npm on the laptop, no first-publish dance for a
  new package; the repo is public anyway.
- Frames around acts, not continuous video: no ffmpeg; RL wants the screen at each act; idle
  `frame` events cover reading. 1920 px cap keeps a day near 0.5–1 GB.
- Write-only IAM user per device over a presign service: no new service to run; a leaked key writes
  junk to one prefix, reads nothing.
- No tray icon: start notification, hotkey, `status`.
- autotrack in its own repo: it runs on laptops that never run autobrowse; the only shared
  thing is the session format.
- Extension + native messaging over a localhost port: no port any page could reach; Chrome's
  supported path. Web Store over unpacked: Chrome 137+ ignores `--load-extension` and policy
  force-install needs a managed machine on Windows.
- Join offline, not in the recorder: the recorder stays a dumb writer; joining rules can change
  and rerun over old data.
- Frames captured by the native helper, not Node (2026-10-13, after the first build): Node's
  capture, copy, downscale and JS encode cost ~110 ms CPU a frame, 20–27% of a core while active,
  220–360 MB RSS. A second helper process (`--shots`) grabs into a ring and writes JPEG with the
  OS's own encoder (ImageIO on Mac, GDI+ on Windows); Node only names the files.
