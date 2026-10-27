# autotrack

autotrack records what you do on a Mac, Windows or Linux PC: every click, key and scroll, the app and
the on-screen element you acted on, and the screen before and after. It runs in the background
from login. Every 5 minutes it uploads what it recorded to a private S3 bucket. The data is for
training computer-use agents.

## Install

You need an install code. Get one with `autobrowse autotrack enroll <device>`, which prints the
full command for you.

### Installer

Get it from the [latest release](https://github.com/wrenautomation/autotrack/releases/latest).

- Windows: `autotrack-setup-<version>.exe`. Double-click it, paste the code, click through.
- Mac: `autotrack-<version>.dmg`. Open it, then open `autotrack Installer.app`. It asks for the
  code.
- Linux (x64 Ubuntu, Debian, Fedora): `autotrack-<version>-linux-x64.run`. Run
  `sh autotrack-<version>-linux-x64.run`. It asks for the code in a window (zenity or kdialog), or
  in the terminal if there's no desktop. `--uninstall` removes it.

The installers aren't signed yet, so the first open shows a warning. On Windows, click More info,
then Run anyway. On a Mac, right-click the app and choose Open. On macOS 15 and newer, open it
once, then go to System Settings > Privacy & Security and click Open Anyway. The dmg has a
"Read me first.txt" with these steps.

For scripts, `autotrack-setup-<version>.exe /VERYSILENT /CODE=<code>` installs with no window. On
a Mac, run the app's `Contents/MacOS/autotrack-installer` with `AUTOTRACK=<code>` set. On Linux,
set `AUTOTRACK=<code>` (or `AUTOTRACK_CODE_FILE=<file>`) and run the `.run` file.

### One line

Mac or Linux (Terminal):

```sh
AUTOTRACK='<code>' sh -c "$(curl -fsSL https://raw.githubusercontent.com/wrenautomation/autotrack/main/install/install.sh)"
```

Windows (PowerShell):

```powershell
$env:AUTOTRACK='<code>'; irm https://raw.githubusercontent.com/wrenautomation/autotrack/main/install/install.ps1 | iex
```

You don't need admin rights or Node either way. The one-liner downloads the latest release and the
installers carry it. Both verify its SHA-256 and set autotrack to start at login. On a Mac they
then open System Settings so you can allow Accessibility, Input Monitoring and Screen Recording
for `node`, and wait until you have.

autotrack updates itself. About every 30 minutes autotrack checks the latest release. It
installs a new version only if the release is signed and every checksum matches, and only after
the new version passes a self-test. It switches over when you've stopped typing for 2 minutes. If
the new version fails to start 3 times, autotrack goes back to the old one and skips that version.
Set `"update": "off"` in `config.json` to stop updates. To update now, run `autotrack update`.
On a Mac the app folder keeps its path, so the permissions you granted stay.

On Linux it starts at login through a systemd user service, or an XDG autostart entry when there's
no systemd session. Use an Xorg session. On Wayland it sees only some apps and part of the input,
and `autotrack doctor` warns about it. OCR needs `tesseract` (`sudo apt install tesseract-ocr` or
`sudo dnf install tesseract`); without it, frames are kept and not read.

For page detail in Chrome, Edge, Opera, Opera GX or (on Linux) Chromium and Brave, load the autotrack extension. The installer unpacks it to
`extension/` in the data folder (see "Where the data goes"), copies that path to your clipboard,
and opens `chrome://extensions`, `edge://extensions` or `opera://extensions` for each browser it finds. There, turn on
Developer mode, click Load unpacked, and pick the folder. If autotrack is already listed after an
update, press its reload button. The extension isn't on the Chrome Web Store yet.

## Use

- Ctrl+Alt+Shift+P pauses or resumes. A notification shows which.
- `autotrack status`: is it running, and is it paused.
- `autotrack -v`: the installed version.
- `autotrack pause` and `autotrack resume`.
- `autotrack doctor`: checks setup, permissions, a test upload, CPU and memory.
- `autotrack ship`: uploads now instead of waiting.
- `autotrack update`: updates now. `--check` only says what's latest.
- `autotrack uninstall`: removes the login item, the browser hookup and the app. If some
  recordings haven't been uploaded yet, it asks before deleting them. `--yes` skips the question.

## What it records

- Mouse moves, clicks, drags and scrolls, plus keys and shortcuts. Typed text is grouped into runs.
- The app, the window title, and the role and label of the element under the pointer. Not what
  the element contains.
- Screenshots right before and after each action, and every 2 seconds at most while the screen
  changes without input. Each one is JPEG, at most 1920 px on a side.
- With the extension: the page, the element you clicked, and what the click did.

## What it never records

- Text typed into password fields. It saves a `redacted` marker, not the keys.
- Text that looks like a secret, such as an API key or token.
- Anything while you're in a password manager (1Password, Bitwarden, Keychain Access, Passwords,
  KeePass, Seahorse) or a window whose title looks like a bank. You can add more apps to the list in
  `config.json`.
- Anything while it's paused or the screen is locked.

## Where the data goes

Recordings wait on disk, in `~/Library/Application Support/autotrack` on a Mac,
`%LOCALAPPDATA%\autotrack` on Windows, or `~/.local/share/autotrack` on Linux. Every 5 minutes, finished segments upload to
`s3://<bucket>/<device>/<session>/` and are deleted from disk. If the machine is offline they
wait. Past 5 GB on disk, the oldest screenshots are deleted first and events are kept.

Each device has its own key, and that key can only write under its own folder. It can't read,
list or delete anything. A lost laptop exposes nothing that has already uploaded.

## Develop

```sh
pnpm install
pnpm -s typecheck && pnpm -s test && pnpm -s lint
pnpm bundle          # bundles/autotrack-<platform>-<arch>.{zip,tar.gz} for this machine
```

CI (`.github/workflows/ci.yml`) runs those on Linux. On macOS, Windows and Ubuntu runners it
builds the bundle, installs it against a local S3 stub, drives real input, and checks what was
uploaded. Ubuntu runs it in Xvfb with AT-SPI and GTK test windows. To release, push a tag
`v<version>` that matches `package.json`. `release.yml` builds the four bundles and three
installers and publishes them with `SHA256SUMS`.

License: PolyForm Strict 1.0.0.
