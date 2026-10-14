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

Its own repo, apart from autobrowse's heavy deps (Playwright, AWS SDKs, Restate). It imports
nothing from autobrowse; autobrowse keeps a hand-synced copy of the session types in
`src/autotrack/types.ts`.

## Pieces

| Piece | Files | Does |
|---|---|---|
| hook | `src/hook.ts` | `uiohook-napi` (Mac, Windows): raw mouse and key events |
| events | `src/events.ts` | raw → `Event`: throttle moves, pair down/up into click/drag, fold keys into text runs and hotkeys |
| screen | `src/screen.ts`, `src/capture.ts` | the display under the cursor, a 2 fps ring of the latest grab, "after" frame 300 ms after an act. Grabs live in the shots helper; Node holds slot numbers and hashes |
| probe | `src/probe.ts` + `helpers/` | app, window, element at a point, focused element is a password: Swift helper on Mac, one C# exe (UI Automation) on Windows, one JSON-lines protocol |
| privacy | `src/privacy.ts` | password fields, excluded apps, secret-shaped text, pause |
| journal | `src/journal.ts` | session dir, 5-minute segments, `events.jsonl` + `frames/`, closed segment → `.done` |
| ship | `src/ship.ts` | closed segments → S3 under the device's prefix, delete after put, local cap |
| cli | `src/cli.ts` | `autotrack start|stop|pause|resume|status|task|ship|doctor|uninstall` |
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
    trees/<n>.json | <n>.txt          n = tree number in the session (Signal: accessibility trees,
                                        web snapshots over 2 KB)
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
);                      // Signal adds kinds tree, dialog, clipboard, task and act fields out, tree
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
- **Names never show a value.** UIA often names a text box by its text, and AX titles can carry
  what was typed. A Document takes its name only from its label (UIA `LabeledBy`); an edit, combo
  box, list item or AX text field drops a name that equals or contains its value (or that its value
  contains, from 12 characters). The helpers read the value only to compare.
- **Password fields never log keys.** The probe answers `secure` for the focused element
  (Mac: `AXSecureTextField` subrole or `IsSecureEventInputEnabled()`; Windows: UIA `IsPassword`,
  or a Win32 edit class whose window has `ES_PASSWORD` or a password char: UIA's proxy shows a
  WinForms box as a Pane with `IsPassword` false).
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
`helpers/win/autotrack-helper.exe --probe`, C# built in CI by the csc of .NET Framework 4.8 (on
every Windows 10 and 11, so nothing to install), managed `UIAutomationClient` + P/Invoke for the
foreground window. `--shots` and `--ocr` are the same exe. Each answer under 50 ms p95; a timeout gives `null`, never a
stall in the hook. A click's `at` is the exception. It is asked at button-down (a scroll: its
first tick) with `"down":true`, `"wait":1000` and 3 s to answer; only that act's write waits on
it. `wait` raises the Mac helper's AX timeout to match: an app taking focus misses 40 ms.
`down` makes the Windows helper answer what it read at button-down. A low-level mouse hook sees
the press before the app does, a reader thread reads the element under it, and the hook holds the
press until the read is done (60 ms at most) and the button-up until it is done (200 ms more). So a
button that closes its window on release still reads as the button. With no read within 4 px and
2 s, it reads now. Windows ignores `wait`; Mac and Linux ignore `down`. A null is asked again
when the act is written. `at` is also asked where the pointer has rested 100 ms (its own timer,
not the next fold tick); a click whose own answer has no role takes that one. That rest answer is
Linux's only read before a quick click acts: X has no passive way to hold a press.

Signal adds (see Signal below):

```
← front also answers "windows":3 (the front app's open windows) and
  "dialog":{"title","text","buttons":[…]}|null (the front window is an alert, sheet or modal)
→ {"id":5,"op":"tree","max":1500,"depth":25,"budgetMs":750}
                                            ← {"id":5,"nodes":[{role,name,id?,x,y,width,height,depth,secure?}],"truncated":false,"ms":106}
→ {"id":6,"op":"watch","clipboard":true}    ← {"id":6,"ok":true}
← {"event":"clipboard","types":[…],"length":13,"text":"…"?,"concealed":false,"secure":false}
```

- `tree` walks on the helper's own worker (Mac a serial queue, Windows a pool thread), so `at`/`front` keep answering while it runs; its answer comes when done (the
  client waits 3 s). One walk at a time.
- Clipboard is polled in the helper, never in Node, and pushed: a line with `event` and no `id`.
  Mac checks `NSPasteboard.changeCount` every 250 ms; Windows `GetClipboardSequenceNumber` every
  250 ms on an STA thread. A change sends one line; nothing changes, nothing is sent. The client
  asks for `watch` again after every helper restart.

## Shots protocol

A second long-lived helper, the same binary started with `--shots`, so a capture never
delays a probe answer. Node keeps slot numbers and hashes, never pixels.

```
→ {"id":1,"op":"displays"}   ← {"id":1,"displays":[{"id":"1","x":0,"y":0,"width":1512,"height":982,"scale":1.27,"primary":true,"os":{"x":0,"y":0,"width":1512,"height":982,"scale":1}}]}
→ {"id":2,"op":"grab","display":"1"}   ← {"id":2,"slot":1,"seq":7,"w":1920,"h":1247,"hash":"1e29170f1b8b8773"}
→ {"id":3,"op":"save","slot":1,"seq":7,"path":"/abs/0.jpg","quality":70}   ← {"id":3,"ok":true,"bytes":371412}
```

- `displays`: logical points, `scale` = frame pixels per point (what `session.json` `displays[].scale`
  means). `os` is the OS's own rect and DPI scale, which Node feeds to `coordsFor` (identity on Mac;
  physical pixels and the DPI scale on Windows, where logical = physical / scale).
- `grab`: captures the display, downscales to at most 1920 px on the long side, keeps it in a ring of
  4. `seq` counts grabs; a `save` with a `seq` the ring has since reused answers `ok:false`
  ("slot reused"), so a stale grab never saves the wrong picture. Node also drops grabs from before a
  helper restart.
- `hash`: 16 hex digits. Byte 0 = mean luma of the top half, byte 1 = the bottom half, low 48 bits =
  a difference hash on a 9x6 grid of cell means. Two frames differ when 3 or more gradient bits flip
  or either half's luma moves by 2 or more. Mac and Windows compute it the same way.
- `save`: JPEG to `path.tmp`, then rename. Failure answers `ok:false` with an error; the journal
  gives the frame number up.
- Mac: ScreenCaptureKit `SCScreenshotManager.captureImage` on macOS 14+ (GPU downscale: ~2.5 ms CPU
  and ~55 MB RSS a grab); `CGDisplayCreateImage` below that or when SCK fails (~40 ms CPU, 210-350 MB
  RSS, which is why it is the fallback, not the default). CoreGraphics draw for the downscale, ImageIO
  for the encode. Windows: `BitBlt`/`StretchBlt` (HALFTONE, CAPTUREBLT) from the screen DC under
  per-monitor DPI v2, GDI+ JPEG encoder.
- A missing or failing shots helper means no frames; the recorder carries on and `doctor` says so.

## Storage

- Bucket `autobrowse-prod-track-<acct>` (`deploy/terraform/track.tf`, like `shots.tf`): private,
  AES256, versioning off; lifecycle → Glacier Instant Retrieval after 30 days (about $4 per TB a
  month, read in milliseconds when a training run wants it).
- Key: `<device>/<session>/<segment>/events.jsonl.gz`, `…/frames/<n>.jpg`,
  `…/trees/<n>.json.gz` (or `<n>.txt.gz` for a web snapshot), `<device>/<session>/session.json`.
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

## Signal: why it was clicked, and what came of it (2026-10-13, William)

"needs good signal (why everything was clicked, analytics, browsers, etc. for tracking for RL)".
An RL trajectory needs four things per act: what was seen (observation), what was done (action),
why (intent), and what came of it (outcome, the reward's raw material). autotrack had the first two.
This adds the rest in three places: the recorder and extension capture facts, an offline pass in
autobrowse derives and labels, the lake makes it queryable.

### Captured on the machine (facts only, never guessed)

Recorder (`src/`, `helpers/`):

- **Act outcome.** Each click, drag, scroll, text and key event, written once its after-frame is
  known, gains `out: { screen: boolean, focus: boolean, dialog: boolean, window: boolean }`: the
  frame hash moved, the front app or window changed, a dialog appeared, a window opened or closed.
- **Accessibility tree.** Probe op `tree` returns the front window's tree (visible nodes only,
  `{role, name, id, x, y, width, height, depth}`, ≤ 1,500 nodes, depth ≤ 25, never a value, a
  secure field's name kept but marked). Captured on `focus` and after an act whose `out.screen` is
  true, at most once per second, deduped by hash. Stored as `trees/<n>.json` in the segment; events
  reference it: `{kind:"tree", tree:n}` and act events gain `tree?: n` (the latest tree before the
  act). This is the observation most computer-use models read alongside the screenshot.
- **Dialogs.** `{kind:"dialog", title, text (≤ 300), buttons: string[]}` when the front window
  becomes an alert, sheet or modal dialog (Mac `AXSheet`/`AXDialog`/`AXSystemDialog`, Windows UIA
  `IsModal` or ControlType Window with a dialog class). Errors often arrive this way.
- **Clipboard.** `{kind:"clipboard", types: string[], length, text?, redacted}` when the clipboard
  changes (Mac `NSPasteboard.changeCount` polled at 4 Hz in the helper; Windows
  `GetClipboardSequenceNumber`). `text` ≤ 2,000 chars, through the same redaction; none from an
  excluded app or a secure field. The copy's source app is on `Base`; the next paste is a `key`
  (cmd/ctrl+v) or a `web` `paste`.
- **Task marker (the person's own "why").** Ctrl+Alt+Shift+T (or `autotrack task`) opens a
  one-line prompt in front ("What are you doing?"; Mac `display dialog` run by System Events,
  Windows a topmost box) and writes
  `{kind:"task", goal}`; an empty answer writes `{kind:"task", goal:"", done:true}`. Optional,
  never nags. The strongest label there is when it's given.

Extension (`extension/`), new `web` acts:

- `nav`: `{url, from, transition}` from `webNavigation` (`link`, `typed`, `reload`, `form_submit`,
  `back_forward`, `auto_bookmark`, `generated`…). `tab`: `{op: "open"|"close"|"switch", count}`.
- `search`: `{engine, query}` when a navigation is a search on Google, Bing, DuckDuckGo, YouTube,
  Amazon, Reddit, X, LinkedIn or the site's own `?q=`/`?query=`/`?search=`.
- `copy`/`cut`/`paste`: target hints and `text` ≤ 2,000 through redaction (never a password field).
- `select`: selected text ≤ 500 on mouse up (what the person was reading).
- `download`: `{ext, mime, bytes, origin}` from `chrome.downloads`; never the file.
- `effect` gains `errors: [{message ≤ 200, source}]` (console errors and unhandled rejections from a
  main-world listener in the 1 s window) and keeps `requests` with status (a 4xx/5xx is a failure).
- `snapshot`: the page's accessibility outline as text (role + name lines, like autobrowse's aria,
  ≤ 30k chars, visible part only), on load complete and after an effect with > 20 DOM changes, at
  most once per 2 s per tab. The recorder stores any `tree` string over 2 KB as `trees/<n>.txt`
  and writes `treeFile: n` in its place.

### Derived offline (`autobrowse autotrack label`)

Reads a session from the bucket, writes `labels/<device>/<session>.json` beside it and locally.

1. **Join.** An OS `click` and a `web` `click` are one act when `|ts| < 150 ms` and within 4 px;
   the web target replaces a thin OS element.
2. **Rule signals per act** (no model): `dwell` (ms since the last act), `hover` (ms the pointer
   rested on the target before the act), `dead` (no screen change, no effect, no focus change),
   `rage` (≥ 3 clicks on the same target in 2 s), `correction` (undo, a backspace run over what was
   just typed, back navigation within 5 s), `error` (a dialog, a failed request, a console error
   after the act).
3. **Episodes.** Split at `task` markers when present; else at idle ≥ 2 min or a switch to an
   unrelated app/domain held ≥ 30 s.
4. **Model labels** (LLM gateway, free Gemini keys, cached by episode hash): per episode a `goal`
   (one sentence), an `outcome` (`done`, `failed`, `abandoned`, `unclear`) and a confidence; per
   act an `intent` (one short clause: "open the invoice to check the amount"). Input: acts with
   their elements, web targets, effects, rule signals, and the before/after frames shrunk to 768 px.
   A person's `task` goal always beats the model's.

`labels` shape: `{ v:1, session, episodes: [{ id, start, end, goal, goalBy: "person"|"model",
outcome, confidence }], acts: [{ t, episode, intent, signals: {dwell, hover?, dead, rage,
correction, error} }] }`.

### Analytics (wren lake)

`wren lake build` gains models over the bucket (DuckDB reads the gzipped JSONL in S3 directly):
`warehouse.autotrack_acts` (one row per act, joined, with app, domain, element, signals, intent),
`autotrack_daily` (per device per day: active minutes, acts, apps and domains by time, dead/rage/
error rates), `autotrack_episodes`. The lake job's role gets read on the track bucket. Ask with
`wren lake sql`; nothing about a device's rows ever goes to CI logs.

### Wren's own events

The portal sends `window.postMessage({autotrack:{v:1, action, detail}}, "*")` at its command layer
for every user command: the action name, the record ids, and what the API answered (ok or the
error). That's the exact "why" and "what came of it" for every act inside Wren.

### Decision log (signal)

- Facts on the machine, meaning offline: the recorder never calls a model; labels can be redone
  with a better model over old data.
- Task marker over always-on narration: no microphone on someone else's laptop; the marker is
  optional and one line.
- Trees on change, not per act: a tree is 5–50 KB; per act it would outweigh the frames.

### As built (recorder, 2026-10-13)

Where the build is more exact than the bullets above:

- `out` and `tree` are optional on act events, so sessions recorded before Signal still parse. An
  unknown side reads false: no after-frame, `screen` false; no front answer, `focus` false;
  `window` only compares two counts from the same app.
- Tree nodes: `id` only when the element has one; `secure: true` only on a password field. Names
  pass the same secret redaction as text. The file is `{nodes, truncated, ms}` (`truncated`: a cap
  cut the walk). Mac skips nameless groups and layout containers and takes a static text's name
  from its text; Windows walks UIA's `ControlViewWalker` and skips nameless panes, groups, custom,
  text, image and data items. Text fields are leaves (their children are the text).
- Dialogs: Mac also counts a window with `AXModal`; for a sheet, `window` is its parent window.
  Windows: class `#32770` or `WindowPattern.IsModal`. Written once per distinct dialog.
- Clipboard: `length` counts UTF-16 code units of the text (0 when none). `text` is withheld and
  `redacted: true` written when the copy was concealed (Mac `org.nspasteboard.ConcealedType` or
  `TransientType`; Windows `ExcludeClipboardContentFromMonitorProcessing` or `Clipboard Viewer
  Ignore`), made under secure input, made while a password field had focus, or when the focused
  element did not answer in 500 ms.
- Task: the answer is trimmed, whitespace collapsed, at most 500 characters. Keys typed into the
  prompt are not recorded. Windows shows a small WinForms box rather than an InputBox: it can take
  the foreground (an Alt tap lifts the background rule) and needs no VisualBasic assembly. On the
  Mac, `osascript`'s own dialog can open behind the front app, so System Events shows it; the
  first prompt asks the person once to let autotrack control System Events (Automation). The
  task's `t` is when the answer came, so events written while the prompt was up stay in order.
  `autotrack task` (control op `task`) opens the same prompt; the e2e opens it that way and
  checks it is the front window on both OSes.
- Order: focus, tree and clipboard events wait while an act that began before them is still
  folding (a text run, a held button), so `t` never goes backwards in `events.jsonl`.
- The control socket takes lines up to 256 KB (was 64 KB) so a 30k-character snapshot, escaped,
  fits.

## Quality: dynamic capture, deferred enrichment (2026-10-13, William)

"Make sure data quality is as high and enriched as possible without huge performance and memory
bottlenecks (background efficient tasks vs upfront calculations, dynamic usage based on computer
activity), to maximize chances RL goes well."

Rule: the machine captures only what dies with the moment (pixels at native resolution, the live
tree, the cursor path, timing). Anything derivable from shipped data is computed offline in
autobrowse, where reruns are free. Extra work on the machine runs when the person is idle, under a
budget, and stops at the first input.

### Level governor (recorder)

Every 2 s the recorder picks a level and writes `{kind:"level", level, why}` when it changes, so
every act says what quality it was captured at.

| | `full` | `normal` | `lean` |
|---|---|---|---|
| When | on AC, system calm | default; battery ≥ 20%; one level down for a 10 s burst over budget | battery < 20%, system busy, own CPU over budget for 60 s, or a 10 s burst over twice the budget |
| Ring (before frame) | 250 ms | 500 ms | 1 s |
| After frame | settle, 100 ms ticks | settle, 150 ms ticks | fixed 300 ms |
| Crops | yes | yes | no |
| Idle frames | 1 s | 2 s | 5 s |
| Trees | focus + screen change, ≤ 1/s | focus + screen change, ≤ 1 per 2 s | focus only, ≤ 1 per 5 s |

- Inputs: own CPU (recorder + helpers, 60 s window), power (Mac `pmset -g batt`, Windows
  `GetSystemPowerStatus`, polled every 60 s), system busy (Mac load average / cores > 0.85,
  Windows `GetSystemTimes` idle < 15%, over 60 s). `why` names the input that decided it.
- Video guard: when the idle hash changes on over 80% of idle ticks for 30 s with no input
  (a video, a game), idle frames drop to one per 10 s until input or a still screen.
- The 3% CPU and 200 MB RSS budget holds at every level; `doctor` prints the level and its
  measured cost.

### Captured at the moment

- **Click before frame, fresh.** A click or drag grabs at button-down (SCK ~3 ms CPU) instead of
  taking the ring's latest, so `before` is the screen the person clicked on. Keys and text keep the
  ring (a key's effect starts at key-down).
- **After frame on settle.** After an act, grab every tick until two grabs in a row hash the same,
  up to 3 s. `after` is that settled frame. The act gains `settle: ms` (act end to stable) and
  `settled: false` when 3 s ran out (a spinner, a video). `out.screen` compares before and settled.
- **Cursor approach.** The recorder keeps every raw move (60–120 Hz) in a 1.5 s memory ring. A
  click, drag or scroll gains `path: [[dt, x, y], …]`, the last 1 s before button-down, at most
  60 points (dt in ms, negative, before the act). A drag's own path is kept the same way, at most
  120 points. `move` events stay 20 Hz.
- **Native crop.** At a click, a drag's start and a scroll, a 256×256-point crop around the
  pointer at the display's native pixels (512×512 on a 2× display), JPEG q85, stored as
  `crops/<n>.jpg` (n counts over the session); the act gains `crop: n`. Frames are capped at 1920 px,
  so on a Retina or 4K screen small text is only readable here. Shots op
  `{"op":"crop","display":"1","x":…,"y":…,"w":256,"h":256,"path":…,"quality":85}` grabs only that
  rect (SCK `sourceRect`, `BitBlt` of the rect). Never on a secure element or in an excluded app.
- **Shot timing.** A `{kind:"shot", frame, at, x, y, display}` event per written frame: `at` is
  the grab's `t` (a ring frame can be older than the act), `x, y` the cursor then (screenshots carry
  no cursor).
- **Integrity stats.** Each closed segment writes `stats.json`: events by kind, moves dropped,
  probe answers and timeouts, acts with a null element, frames saved / failed / slot reused, trees,
  crops, ocr done, seconds per level, helper restarts. `session.json` gains the running totals. A
  trainer filters on these.

### Enriched in idle time (on the machine)

- **OCR.** The OS's own engine (Mac Vision `VNRecognizeTextRequest`, accurate; Windows
  `Windows.Media.Ocr`) reads each written frame and crop: `ocr/<n>.json` (frames) and
  `ocr/c<n>.json` (crops), `{lines: [{text, x, y, w, h, conf}]}` in that image's pixels, text through
  the same secret redaction. A frame whose hash equals one already read writes `{same: m}`.
- **When.** Only while the person has been idle ≥ 20 s, on AC or battery ≥ 50%, and the level is
  not `lean`. One image at a time; the first input stops it within 100 ms and it resumes at the next
  idle. It runs in a third helper (`--ocr`) started on demand at background priority (Mac QoS
  background, Windows BelowNormal) and quit when its queue is empty, so it holds no memory between
  runs.
- **Ship.** A closed segment gets `.done` when its OCR is finished or 2 h after closing, whichever
  comes first; OCR not done by then is skipped and counted in `stats.json`. Ship is unchanged.

### Derived offline (autobrowse)

- `autobrowse autotrack steps <device> <session>` writes the RL view: one line per act,
  `{episode, goal, step, t, obs: {frame, crop, tree, ocr}, action: {type, x, y, nx, ny, button,
  count, text, key, mods, path}, element, next: {frame, tree}, settle, settled, out, treeDiff, signals,
  intent, level}` where `x, y` are frame pixels and `nx, ny` are 0–1. `treeDiff`: nodes added,
  removed and renamed (role + name) between the last tree before the act and the first after it.
  Stored as `steps/<device>/<session>.jsonl.gz` in the bucket and next to the import.
- Quality per episode and session: share of acts with a before and settled after, an element, a
  tree, a crop; time at each level; gaps (pauses, helper restarts). `autotrack list` shows it;
  `steps --min-quality` filters.
- Import and label read `crops/`, `ocr/` and `stats.json` keys.

### As built (machine side, 2026-10-13)

Where the build is more exact than the bullets above. Field names are unchanged.

- Level: `AUTOTRACK_LEVEL=full|normal|lean` pins it, for measuring one level. A pinned recorder
  still measures its cost, and `why` says "pinned (AUTOTRACK_LEVEL)". A missing power or busy reading counts
  as `normal`. A lean caused by own CPU holds until own CPU drops under 2%. The CPU window needs 50
  of its 60 s covered before it counts. OCR CPU is not part of it.
- Power: Mac parses `pmset -g batt`. Windows asks the probe (new op `power` →
  `{ac, battery}`, null when unknown). A desktop with no battery is `{ac: true, battery: null}`.
- Settle: "the same" is the frame-change rule (`differs`: 3+ gradient bits or a half's luma moving
  by 2), not hash equality, so a blinking caret still settles. `settle` is ms from the act's end to
  the first grab of the still pair. `settled` is written only when false. At `lean` there are no
  settle fields.
- `path` is one field: the approach points (dt < 0), then a drag's own points (dt ≥ 0). Points are
  rounded to 0.1 point. A scroll's approach is taken at its first tick.
- Crop: it is taken at button-down (a scroll: its first tick), and Node centres and clamps the
  rect inside the display (`x, y` = top-left, global logical points). The file sits as
  `crops/<n>.jpg.hold` until the act's element and app are known. It is renamed when kept, and
  deleted on a secure element, an excluded app, a pause or a dropped act. The answer is
  `{ok, bytes, w, h}`. Windows crops are one `BitBlt` at physical pixels (points × DPI). Mac uses
  SCK `sourceRect` sized to the rect's native pixels, falling back to `CGDisplayCreateImageForRect`.
- `shot`: `x, y` are logical points rounded to 0.1. A `ring` frame keeps its own grab time as `at`.
- Video guard: if over 80% of idle grabs changed over 30 s with no input, idle grabs drop to one
  every 10 s. Input or one still grab ends it.
- `stats.json`: `{segment, closedAt, events, movesDropped, probe: {answers, timeouts},
  nullElement, frames: {saved, failed, slotReused}, trees, crops, ocr: {done, same, failed,
  skipped}, levels: {full, normal, lean} (seconds), restarts, recovered?}`. It is written at close
  and rewritten when OCR finishes. `session.json` `totals` sums closed segments. A segment closed
  by the next start after a crash has `recovered: true` and counts only what its files show.
- OCR files: `{lines, w, h}` (read), `{same: m}`, `{failed: true}` (the helper errored or took
  over 60 s), or `{skipped: "secure"}` (a frame of a password field). An image with no file at
  `.done` counts as skipped. Line boxes are whole pixels, origin top-left. `conf` (0 to 1, three
  decimals) is Mac only: Windows.Media.Ocr has none, and its box is the union of the line's words.
- OCR helper: op `{"op":"read","path"}` → `{lines, w, h, cpuMs}`. Mac: Vision `.accurate` with
  language correction, at QoS background. Windows: `Windows.Media.Ocr` in the helper exe
  (`--ocr`), waited on through each WinRT call's `Completed` handler, at BelowNormal priority. It uses the user's profile languages, then en-US,
  and errors when no OCR language is installed (the CI helper test adds
  `Language.OCR~~~en-US~0.0.1.0`). Each run is a new helper, closed synchronously on the first
  input (well under 100 ms), with the image requeued. Unknown power counts as AC.
- `.done`: a segment closed while OCR is waiting gets `stats.json` and no `.done`. A restarted
  recorder picks those up again, with the 2 h counted from their `closedAt`. `autotrack ship` with
  no recorder running, and uninstall, finish them first and count unread images as skipped.
- Ship: `crops/<n>.jpg`, `ocr/<n>.json.gz`, `ocr/c<n>.json.gz` and `stats.json` go up before
  `events.jsonl.gz`. The local cap deletes crops along with frames, oldest first.
- Every helper mode answers `usage` → `{cpuMs, rssMb}` (its own CPU and RSS). The status op adds
  `level`, `why`, `cpuPct`, `helpers` and `ocr: {on, waiting, running, cpuMs}`. `doctor` prints
  the level and why, then CPU and RSS split into recorder, probe and shots, then OCR CPU on its
  own line.
- Measured (`doctor`, 10 s, idle, M-series Mac at 2×, pinned level): full 1.42% of a core and
  128 MB; normal 1.42%, 109 MB; lean 1.23%, 95 MB. OCR helper: 0.5 to 0.8 s CPU and 48 MB for a
  640×200 image. The CI e2e prints `doctor` with input running and again idle, on both OSes.
  CI (2026-10-14): Mac at full, 4.2% and 127 MB with input, 0.8% and 129 MB idle. Windows at
  normal, 8.9% and 270 MB with input (the probe's UI Automation reads take 6.9%), 0.3% and 91 MB
  idle. The 10 s input window is a burst, not the average, but it is over budget on Windows.
- GitHub's macOS VMs run at a load of 2 to 3 per core, so the Mac e2e pins `full`; unpinned they
  hold `lean`. The Windows e2e runs unpinned and picks `normal` (no load average there).
- The Windows helpers were PowerShell 5.1 processes of about 105 MB each after startup. They are
  now one C# exe, below.

### Windows budget (2026-10-14)

The first Windows e2e ran 8.9% CPU and 270 MB with input. The fixes:

- One exe, `helpers/win/autotrack-helper.exe --probe|--shots|--ocr`, C# 5 built by
  `helpers/win/build.ps1` with the in-box csc of .NET Framework 4.8. CI builds it; the
  win32-x64 bundle ships only the exe. `probe.ps1` is deleted, so there is one path. The protocol
  is unchanged.
- Focus is event-driven. A WinEvent hook thread (`EVENT_SYSTEM_FOREGROUND`,
  `EVENT_OBJECT_FOCUS`, out of context) bumps a counter. `focused` answers from cache while the
  counter and the focused hwnd are unchanged and the answer is under 2 s old. A null is never
  cached. The short age and the hwnd check keep a stale `secure` flag from slipping through.
- UIA reads go through one `CacheRequest`, so an element is one cross-process call, not one per
  property. The front window's dialog check is cached per hwnd for 3 s.
- Clicks, drags and scrolls each ask for the element at the point. The rest ask (pointer still
  for 100 ms) runs at most once a second. Trees run at most once per level's `treeMs` (1, 2, 5 s).
- Each helper trims its working set once it has had no request but `usage` for 5 s.
- Governor: ticks every 2 s. A second meter covers 10 s. A burst over 3% steps down one level
  (`full` → `normal` → `lean`), over 6% goes to `lean`, and the step holds until the burst is
  under 2%. `why` reads `burst: own cpu X% over 10 s`. Status adds `burstPct` and `inputs`.
- `doctor` reads status every 2 s over its 10 s and prints the peak RSS and whether input came
  in (`active, N inputs` or `idle`). The Windows e2e fails past 6% CPU or 200 MB peak RSS with
  input. The Mac e2e reports the same numbers without failing (its runner is loaded 2 to 3 per
  core). The real-use target stays 3% on average.
- Helper tests check idle RSS ≤ 30 MB for the probe, and ≤ 30 MB plus the ring for shots (the
  ring is 4 frames of w×h×4 bytes, ~33 MB at 1080p).
- Mac: the 4.2% burst at `full` was recorder 1.7%, probe 0.6%, shots 1.9%, so per-key AX reads
  are not the cause. A text act asks `focused` once, not per key. The burst rule covers it.
- A click's element is the one under the pointer at button-down. The Windows helper reads it from
  a low-level mouse hook before the app gets the press (see Probe protocol). Reading it when Node
  asked gave the window behind a form that closed on release.
- The Windows e2e pins `full` like the Mac one. A loaded runner held `lean`, which drops settle
  and crops. `src/level.test.ts` covers the governor.

## Installers (2026-10-13, William)

"if it's an application maybe make a clean installer as well for windows linux and mac." All three
are built. Linux is its own port; its installer is in "Linux" below.

Each release carries, beside the bundles and in `SHA256SUMS`:

- `autotrack-setup-<version>.exe` (Windows): Inno Setup, per user, no admin prompt. The wizard
  asks for the install code and checks it before it changes anything. Its finish page offers
  "Start tracking now" and the browser extension steps.
- `autotrack-<version>.dmg` (Mac, Apple silicon and Intel): holds `autotrack Installer.app` and a
  "Read me first.txt". Opening the app asks for the code (pre-filled from the clipboard when it
  looks like one), explains the three permissions, installs, and opens the Privacy panes.

The one-liners stay. Both installers put the same files in the same places, so either path updates
the other.

One source of truth: neither installer re-implements install. The Windows setup carries the zip,
its `SHA256SUMS`, `install.ps1` and a tiny `run.ps1`, and runs `install.ps1` in steps with
`AUTOTRACK_STEP`: `check` (unpack, verify the checksum, decode the code, change nothing),
`install`, `start`, `extension`. Unset runs all of them, which is the one-liner. The Mac app
carries `install.sh` and both tarballs (`AUTOTRACK_BUNDLE` may be a folder; `uname -m` picks the
file) and uses `AUTOTRACK_STEP=check` the same way.

Decisions:

- Mac is a dmg with an installer app, not a `.pkg`. A pkg's postinstall runs as root outside the
  login session. The LaunchAgent, the Privacy panes and the dialogs all belong to the user, so a
  pkg would have to reach back into that session for each. The app runs as the user and reuses
  `install.sh` unchanged. Universal means both tarballs in one dmg, not a fat binary: Node and the
  helpers are built per arch.
- Windows is Inno Setup. It installs per user without elevation, has a scriptable code page and
  silent switches, and is on the runners. MSIX needs a signature to install at all.
- The setup's own folder (`%LOCALAPPDATA%\Programs\autotrack`) holds only the uninstaller. The app
  and data stay in `%LOCALAPPDATA%\autotrack`, so `autotrack uninstall`, which deletes the app
  folder, never deletes the program running it. Add/Remove Programs runs
  `autotrack uninstall --yes`, then removes the uninstaller.
- The code travels in the environment, never on a child command line.

No UI, for CI:

- Windows: `autotrack-setup-<version>.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CODE=<code>`,
  or the code in `AUTOTRACK`. A missing or malformed code exits Setup with code 1 and installs
  nothing. A silent install starts tracking unless `AUTOTRACK_NO_AUTOSTART=1`, and never opens the
  browser.
- Mac: run `autotrack Installer.app/Contents/MacOS/autotrack-installer` with `AUTOTRACK=<code>` or
  `AUTOTRACK_CODE_FILE=<path>` in the environment. No dialogs.

Unsigned for now:

- Windows: SmartScreen shows "Windows protected your PC" with publisher "Unknown publisher". Click
  More info, then Run anyway. The one-liner never shows it. A code-signing certificate removes the
  prompt. Signing is a later item.
- Mac: Gatekeeper says it cannot check the app for malicious software. On macOS 14 and older,
  right-click the app and choose Open. On macOS 15 and newer, open it once, then go to System
  Settings > Privacy & Security and click Open Anyway. Notarizing the dmg needs the Apple
  Developer account. Later, William's call.

Tests: `ci.yml` has an `installers` job on both OSes (also from `workflow_dispatch`) that builds
each installer from a fresh bundle and runs the smoke. `release.yml` builds them from the tagged
bundles, attaches them, adds them to `SHA256SUMS`, and `smoke-installer` downloads each from the
published release. The smoke refuses a missing and a malformed code, installs silently with a fake
shape-valid code (`AUTOTRACK_NO_AUTOSTART=1`, `AUTOTRACK_NO_BROWSER=1`), runs `doctor`, checks
`VERSION`, installs again over it, then uninstalls. On Windows it then waits for the detached
`cmd` that deletes the app folder about 3 s later. A tag with a `-` in it (`v0.1.1-rc.1`) publishes
as a prerelease, which `releases/latest` skips, so the one-liner smoke reads that release's own
bundle.

Known limits:

- Inno's `/LOG` records the command line, so `/CODE=` lands in it. Use `AUTOTRACK` when logging.
- `autotrack uninstall` run from the CLI leaves the Add/Remove entry behind. It is harmless; the next
  setup replaces it.
- Add/Remove Programs ignores a custom `AUTOTRACK_DIR` (tests only).

## Linux (2026-10-13, William)

"make a clean installer as well for windows linux and mac." Linux is a port: the same recorder, a
new helper, an installer.

Target: x64 desktops on Ubuntu 22.04+, Debian 12+ and Fedora 39+. An X11 session is first-class.

Decisions:

- **Wayland runs degraded, and `doctor` says so.** Wayland has no passive global input by design.
  uiohook's XRecord sees only XWayland apps. X11 screen capture under XWayland shows only X windows,
  and AT-SPI screen coordinates are not real there, so `at` misses. The portal route (ScreenCast
  over PipeWire) would bring frames back. It needs libpipewire and a consent prompt each session,
  and it still gives no input, so it is not built. On Wayland autotrack still runs and records what
  XWayland apps do. Nothing leaks: native Wayland apps' keys never reach it. `doctor` WARNs on
  `XDG_SESSION_TYPE=wayland` or `WAYLAND_DISPLAY`. The fix is to log out, pick the X11 session on
  the login screen (gear icon: "Ubuntu on Xorg", "GNOME on Xorg", "Plasma (X11)") and log back in.
  Fedora 41 and later ship GNOME without an Xorg session; use a desktop that still has one (KDE
  with its X11 session package, Xfce, Cinnamon, MATE) or accept degraded.
- **Input** is the uiohook-napi linux-x64 prebuild: XRecord on its own thread. It links libX11,
  libXtst, libXrandr and libXt, which every X11 desktop has. Key text comes from keycodes on a US
  layout, as on Mac and Windows. `xdotool` (XTest) input is seen like a person's, which the e2e
  uses.
- **The helper is Rust, one static musl binary**: `helpers/linux/autotrack-helper --probe|--shots|--ocr`,
  the same protocol. It has zero runtime deps: pure-Rust D-Bus (zbus), X11 (x11rb with MIT-SHM,
  RandR and XFixes) and JPEG (jpeg-encoder). One file runs on every distro. Its RSS is a few MB.
  Not C: it would link libatspi, glib and libjpeg dynamically, and libjpeg's soname differs
  (Ubuntu `.so.8`, Fedora `.so.62`). Not Go: a GC runtime at 10+ MB RSS, and its stdlib JPEG
  encoder is about 3x slower on the hot `save` path. CI builds it with
  `cargo build --release --target x86_64-unknown-linux-musl`.
- **Probe over AT-SPI (D-Bus)**:
  - The a11y bus comes from `org.a11y.Bus.GetAddress`. The probe sets `org.a11y.Status.IsEnabled`
    once, so Chromium, Electron and Qt build their trees (Mac's `AXManualAccessibility`, here).
    `AUTOTRACK_PROBE_NO_ENHANCE=1` turns that off.
  - `at`: the topmost X11 client window at the point (`_NET_CLIENT_LIST_STACKING`), then its
    `_NET_WM_PID`, then the AT-SPI app on that pid (`GetConnectionUnixProcessID`), then the frame
    holding the point, then `Component.GetAccessibleAtPoint` down to the deepest element.
  - `focused`: `object:state-changed:focused` events keep the last focused object. Each ask re-reads
    it and checks it still has `FOCUSED`, so a stale answer cannot hide a password field. Without
    an event, it falls back to `Collection.GetMatches` on the active frame, then a bounded walk.
  - `secure` = role `password text` (GTK, Qt, Chromium and Firefox all use it).
  - Names (`name.rs`, the Windows `SafeName` rule): `document *` takes only its label
    (`LABELLED_BY`). `password text` takes its label, else its name; its text is never read. Text
    roles (`text`, `entry`, `terminal`, `combo box`, `editbar`, `autocomplete`) and value roles
    (spin button, slider, scroll bar, progress bar, dial, level bar) drop a name that shows their
    text or `Value`, then fall back to the label unless it shows it too.
  - `front`: `_NET_ACTIVE_WINDOW`, `_NET_WM_PID`. `app.id` = `/proc/<pid>/exe`. `app.name` = the
    `WM_CLASS` class, else `comm`. The title comes from `_NET_WM_NAME`, and the bounds include
    `_NET_FRAME_EXTENTS`. `dialog`: window type `DIALOG` or state `MODAL`, with words from its
    AT-SPI labels and buttons. `windows`: the client windows on the same pid.
  - Lock: `org.gnome.ScreenSaver` or `org.freedesktop.ScreenSaver` `GetActive`. While it is locked,
    `front` answers app `lockscreen`, which the gate treats as locked.
  - Clipboard: XFixes selection-owner events on `CLIPBOARD`. `types` is the owner's `TARGETS`. The
    copy is concealed when `TARGETS` has `x-kde-passwordManagerHint` (KeePassXC, KDE). Text comes
    from `UTF8_STRING`, 4,096 characters at most. A transfer big enough for `INCR` gives its length
    only.
  - `tree`: the front app's active frame, the same skip and leaf rules, mapped to AT-SPI roles.
- **Coordinates**: on X11, points are X pixels, so coords are the identity, `displays[].os.scale`
  is 1 and `scale` = frame pixels / display pixels.
- **Shots**: RandR 1.5 monitors (one display the size of the root without it). The grab is an
  MIT-SHM `GetImage` of the display (plain `GetImage` when SHM is missing), box-filtered down to
  1920 px at most. The hash is the same as Mac and Windows; the JPEG goes to `path.tmp`, then
  rename. `crop` is a `GetImage` of the rect at native pixels.
- **OCR is tesseract, when installed** (`apt install tesseract-ocr`, `dnf install tesseract`). The
  helper runs `tesseract <image> stdout tsv` at nice 10 with `OMP_THREAD_LIMIT=1` and groups words
  into lines; `conf` is the words' mean / 100. Its `cpuMs` counts the children. Without
  tesseract, Node starts no OCR helper and a segment's images count as skipped at `.done`.
  `doctor` says how to install it. It is not bundled: a 30 MB engine plus language data that every
  distro packages.
- **Governor**: power from `/sys/class/power_supply`: AC when a `Mains` or `USB` supply is
  `online`, battery from a `Battery`'s `capacity`. Busy is `/proc/loadavg` per core over 0.85, as
  on Mac.
- **Autostart**: a systemd user service when `graphical-session.target` is active (GNOME, KDE):
  `~/.config/systemd/user/autotrack.service`, `PartOf` and `After` that target,
  `Restart=on-failure`. Otherwise an XDG autostart entry, `~/.config/autostart/autotrack.desktop`.
  Both run `node dist/cli.js start`. install.sh imports `DISPLAY` and `XAUTHORITY` into the user
  manager before it starts the service. `autotrack uninstall` disables and removes both.
- **Browser host**: manifests in `~/.config/{google-chrome,chromium,microsoft-edge,BraveSoftware/Brave-Browser}/NativeMessagingHosts/`.
- **Excluded apps** gain Seahorse (GNOME "Passwords and Keys"). KeePassXC was already there.
- **Notify and prompt**: `notify-send`, else `gdbus` to `org.freedesktop.Notifications`. The task
  prompt is `zenity --entry`, else `kdialog --inputbox`; with neither, `autotrack task` says so.
- **Data**: `$XDG_DATA_HOME/autotrack` (default `~/.local/share/autotrack`). The CLI shim is in
  `~/.local/bin`.

Installer: `autotrack-<version>-linux-x64.run`, a POSIX sh header followed by a tar.gz payload (the
bundle, its `SHA256SUMS`, `install.sh`). It installs per user with no root. It asks for the code
with zenity, then kdialog, then the terminal, checks it (`AUTOTRACK_STEP=check`) before changing
anything, then runs `install.sh`. `--uninstall` runs `autotrack uninstall`.

- Not AppImage: AppImage is for apps that run from the image, and it needs FUSE 2, which Ubuntu
  22.04 and later do not install. It would still have to copy itself into the data dir.
- Not .deb or .rpm: they install system-wide as root, need two formats, and their scripts run
  outside the person's session (Mac's pkg problem).
- A download loses its execute bit, so run it with `sh autotrack-<version>-linux-x64.run`, or
  right-click, Properties, "Allow executing as program", then double-click.
- No UI (CI): `AUTOTRACK=<code>` or `AUTOTRACK_CODE_FILE=<path>` in the environment. No dialogs.

install.sh (the one-liner) handles Linux too. It checks with `sha256sum`, then writes the shim,
the autostart and the browser hosts. Browser steps open `<scheme>://extensions` in each browser
found, started directly (`xdg-open` can't open `chrome://`), and the folder is copied with
`wl-copy`, `xclip` or `xsel` when one is there. It runs `doctor` and prints the Wayland fix when that
applies.

Tests: unit tests for the Linux pieces (power, busy, autostart, uninstall, host paths, notify,
prompt, OCR gating), plus `cargo test` for the helper (hash, fit, JSON, the name rule, TSV).
`ci.yml` has a Linux e2e on ubuntu-latest: Xvfb, openbox, a D-Bus session with at-spi2, a GTK3
form (python3-gi) with a password field and a Submit button, `xdotool` for input, `xclip` and
tesseract. It enforces the budget as Windows does: fail past 6% CPU over the 10 s burst or 200 MB
RSS. `release.yml` builds the linux-x64 bundle and the `.run`; its smokes install both from the
published release.

Known limits:

- Wayland is degraded (above).
- HiDPI on X11 (GNOME 200%, `GDK_SCALE=2`): toolkits can report AT-SPI extents in their own
  logical pixels, so element boxes can be off by the scale. Frames and clicks are right.
- GTK4 has no `Collection`; with no focus event yet, `focused` walks the frame (bounded).
- Lock detection needs a screensaver that speaks `org.gnome.ScreenSaver` or
  `org.freedesktop.ScreenSaver` (GNOME, KDE, Xfce, Cinnamon, MATE do).
- Arm64 Linux is not built.

## Decision log

- Node + `uiohook-napi` over Rust: same language and redaction rules as autobrowse, the library
  ships prebuilds for darwin-arm64, darwin-x64, win32-x64. The bundle
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
- Mac captures with ScreenCaptureKit first, not `CGDisplayCreateImage` (measured 2026-10-13): CG
  cost ~40 ms CPU and left the helper at 210-350 MB RSS; SCK scales on the GPU and costs ~2.5 ms CPU
  and ~55 MB. CG stays as the fallback (macOS 12 and 13, or SCK failing).
- Capture what dies with the moment, derive the rest offline (2026-10-13, quality): a tree diff, a
  quality score or a normalized action can be rerun over old data; a native crop or a cursor path
  cannot. OCR is the exception that runs on the machine: the OS engines are free, accurate, and need
  no upload of full-resolution pixels, so it runs in idle time instead.
- Levels over fixed rates: a laptop on battery or a busy machine keeps recording at lower quality
  rather than slowing the person down, and every act records the level it got.
- One compiled C# exe on Windows over PowerShell helpers (2026-10-14): PowerShell 5.1 costs about
  105 MB per process and compiles its embedded C# on every start. The csc in .NET Framework 4.8
  ships with every Windows 10 and 11, so the exe needs nothing installed and CI builds it without
  an SDK. WinEvent hooks over UIA `FocusChanged`, because they need no UIA event pump in the helper. The
  hook only marks the cache stale; the read is still a UIA read.
- A 10 s burst rule in the governor (2026-10-14): the 60 s window turned lean a minute after the
  burst ended. Stepping down one level keeps crops at `normal`; only a burst past twice the
  budget drops them.
- A Rust helper on Linux, static musl (2026-10-13): one file for every distro with no runtime deps
  (no libatspi, glib or libjpeg, whose soname differs by distro) and a few MB of RSS. Go's GC
  runtime and slower stdlib JPEG lost; so did C's dynamic links.
- A self-extracting `.run` on Linux over AppImage or .deb (2026-10-13): per user like the other
  two, no FUSE, no root, one file for every distro, and it reuses `install.sh` unchanged.
- Wayland degraded over a portal port (2026-10-13): no passive global input exists there, so a
  portal would bring frames back and nothing else. `doctor` names the X11 session to pick.
