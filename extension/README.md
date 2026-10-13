# autotrack extension

A Chrome and Edge extension (MV3) that records clicks, form changes, key shortcuts, scrolls, app events, navigation, searches, tabs, copy and paste, selections, downloads, console errors and a text outline of the page. It hands them to the autotrack recorder through a native messaging host (`../host`). What it captures and what it redacts is in [PRIVACY.md](PRIVACY.md). The contract is `autobrowse/designs/2026-10-13-track.md`, layers 2 and 3.

Extension id: `colpoheiepckdglfmebejhelggjikjim`.

## Layout

| Path | Runs in | Does |
|---|---|---|
| `main.js` | page (MAIN world) | reads React component names from the fiber tree, answers only on the nonce channel |
| `content/redact.js` | content script | secret field and value redaction, URL redaction |
| `content/hints.js` | content script | element target: role, name, CSS path, XPath, attrs, field values |
| `content/outline.js` | content script | the visible page as an aria outline in text, bounded, no field values |
| `content/bridge.js` | content script | nonce handshake with `main.js`, validates replies and error reports |
| `content/content.js` | content script | listeners, screen points, the 1 s effect window, copy/paste/select, snapshots, app events |
| `sw/sw.js` | service worker | stamps tab and frame, joins effects to `webRequest` data, sends |
| `sw/browse.js` | service worker | navigation, search, tab and download events from the browser APIs; the snapshot gate |
| `sw/native.js` | service worker | batches to the host, backoff, pause, missing host |
| `sw/requests.js` | service worker | per tab request history for effects |

## Events beyond the page

`nav`, `search`, `tab` and `download` come from the service worker (`webNavigation`, `tabs`, `downloads`), with no page script. `copy`, `cut`, `paste`, `select` and `snapshot` come from the content script. `snapshot` is top frame only. The effect event's `effects.errors` lists console errors, uncaught errors and rejections from the 1 s window. `main.js` reports them on a third nonce channel.

A downloaded file has no tab of its own, so a download is attributed to the active tab. Snapshots are capped so one fits the recorder's 64 KB control line.

Content scripts run in all frames, from `document_start`, including `about:blank` frames.

## Develop

```sh
pnpm install
pnpm test        # unit tests, jsdom (extension and host)
pnpm e2e         # real Chromium: loads the extension, native host, fake recorder
pnpm typecheck
pnpm lint
```

`pnpm e2e` uses Playwright from `../../autobrowse/node_modules`. Set `AUTOTRACK_PLAYWRIGHT` to another `playwright` package path if that checkout isn't there. `AUTOTRACK_E2E_OUT=<file>` writes the relayed events as JSON lines.

Load it by hand at `chrome://extensions` (or `edge://extensions`): turn on developer mode, click "Load unpacked" and pick this folder. The `key` in `manifest.json` keeps the id the same on every machine.

Then register the host so the extension can reach the recorder:

```sh
node -e 'import("../host/manifests.mjs").then(m => m.install({nodePath: process.execPath, hostScript: require("path").resolve("../host/autotrack-host.mjs")}))'
```

This writes a wrapper to `<autotrack data dir>/native-host/` and the host manifest for Chrome and Edge. On a Mac that's `~/Library/Application Support/{Google/Chrome,Microsoft Edge}/NativeMessagingHosts/`. On Windows it writes one manifest and adds `HKCU\Software\{Google\Chrome,Microsoft\Edge}\NativeMessagingHosts\com.wrenautomation.autotrack`. `uninstall()` removes both.

## Signing key and id

`pnpm key` makes an RSA key at `~/.config/autotrack/extension-key.pem` (mode 0600) the first time, writes its public half to `manifest.json` `key`, and prints the id. The private key never goes in git. Keep a copy somewhere safe: without it, the id can't be kept on a new store item. `pnpm key --check` prints the id from the manifest.

The id comes from the public key: the first 16 bytes of its SHA-256, written with the letters a to p. `host/manifests.mjs` lists the allowed ids in `EXTENSION_IDS`, and the host manifest only lets those connect.

## Chrome Web Store

`pnpm zip` writes `autotrack-<version>.zip` without the `key` field, which the store refuses.

- First upload: `pnpm zip --first-upload` adds the private key as `key.pem` at the zip root. The store then keeps `colpoheiepckdglfmebejhelggjikjim` as the item's id. Don't include it in later uploads.
- If the store assigns a different id anyway, add that id to `EXTENSION_IDS` and re-run the host install. Copy the store's public key (Developer Dashboard, Package, "View public key") into manifest `key` so unpacked builds match.
- Edge users can install from the Chrome Web Store after allowing extensions from other stores. The id is the same, so the host manifest under Edge's folder accepts it. A separate Edge Add-ons listing gets its own id, which must be added to `EXTENSION_IDS`.

The listing text and permission reasons are in [PRIVACY.md](PRIVACY.md). The store also needs a 128 px icon (`icons/128.png`), at least one 1280x800 screenshot, and a privacy policy URL. Publishing PRIVACY.md somewhere public covers the URL.

## Screen points

Each pointer event gets `x` and `y` in screen points, and each target gets a `rect` in the same space, so the recorder can match them with OS clicks. Chrome's `screenX` is in device independent pixels: points on a Mac, logical pixels on Windows. The script learns page zoom and the viewport's screen offset from pairs of pointer moves at least 40 px apart, so the browser's toolbar and zoom don't skew points. On Windows with monitors at different scales the conversion may be off on the secondary screen. That case isn't tested.

## The React channel

`main.js` runs in the page, which the page can also see. Each content script picks a random 128-bit nonce and sends it in a `CustomEvent`. The first main world script to hear it takes it and stops listening. Queries and replies then go on event names that carry the nonce, so a page can't read or forge replies without knowing it. The bridge also checks each reply: at most 12 names, 80 characters each. A page script that runs before `main.js` in a new `about:blank` frame could in theory grab the nonce and send fake component names. The worst it can do is put wrong names in `target.react`.

Only `isTrusted` events are recorded, so a page can't fake clicks. App events must come from the same window (`event.source === window`), are capped at 20 a second, and have their detail redacted like everything else.
