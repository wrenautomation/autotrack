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
`helpers/win/probe.ps1`, Windows PowerShell 5.1 (on every Windows), `UIAutomationClient` +
P/Invoke for the foreground window. Each answer under 50 ms p95; a timeout gives `null`, never a
stall in the hook. A click's `at` is the exception: it is asked at the click with 3 s to answer
(only that act's write waits on it; the Windows helper can take over 1 s, and a later first ask
could see the screen after the click).
A null is asked again when the act is written, with `"wait":1000`, which raises the Mac helper's
AX timeout to match (an app taking focus, or a password field turning on secure input, misses
40 ms; asked again at once, it still missed on CI). Windows ignores `wait`. `at` is also asked
where the pointer has rested 100 ms; a click there whose own answer has no role (a button that
closes its window on release is often gone before the Windows helper reads it) takes that one.

Signal adds (see Signal below):

```
← front also answers "windows":3 (the front app's open windows) and
  "dialog":{"title","text","buttons":[…]}|null (the front window is an alert, sheet or modal)
→ {"id":5,"op":"tree","max":1500,"depth":25,"budgetMs":750}
                                            ← {"id":5,"nodes":[{role,name,id?,x,y,width,height,depth,secure?}],"truncated":false,"ms":106}
→ {"id":6,"op":"watch","clipboard":true}    ← {"id":6,"ok":true}
← {"event":"clipboard","types":[…],"length":13,"text":"…"?,"concealed":false,"secure":false}
```

- `tree` walks on the helper's own worker (Mac a serial queue, Windows a background thread in the
  embedded C#), so `at`/`front` keep answering while it runs; its answer comes when done (the
  client waits 3 s). One walk at a time.
- Clipboard is polled in the helper, never in Node, and pushed: a line with `event` and no `id`.
  Mac checks `NSPasteboard.changeCount` every 250 ms; Windows `GetClipboardSequenceNumber` every
  250 ms on an STA thread. A change sends one line; nothing changes, nothing is sent. The client
  asks for `watch` again after every helper restart.

## Shots protocol

A second long-lived helper, the same binary or script started with `--shots`, so a capture never
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
  per-monitor DPI v2, GDI+ JPEG encoder, all in one embedded C# block.
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
- **Task marker (the person's own "why").** Ctrl+Alt+Shift+T opens a one-line prompt ("What are
  you doing?"; Mac `osascript display dialog`, Windows an InputBox) and writes
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
  the foreground (an Alt tap lifts the background rule) and needs no VisualBasic assembly. The Mac
  dialog comes from `osascript`, which on some setups opens behind the front app.
- Order: focus, tree and clipboard events wait while an act that began before them is still
  folding (a text run, a held button), so `t` never goes backwards in `events.jsonl`.
- The control socket takes lines up to 256 KB (was 64 KB) so a 30k-character snapshot, escaped,
  fits.

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
