# autotrack privacy

autotrack records what you do in the browser so the autotrack recorder on the same computer can turn it into a log of your work. It sends nothing over the network. Events go from the extension to a small program on your computer (the native host), which hands them to the recorder. If the recorder isn't running or is paused, the extension drops events.

## What it records

- Clicks, double clicks, right clicks and pointer presses. For each one it records the element: tag, role, accessible name, short visible text, id, test id, a CSS path, an XPath, the link target, `aria-*` and `data-*` attributes, React component names when the page uses React, and the element's position on screen.
- Form changes. Text fields keep their value up to 1,000 characters. Checkboxes keep checked or not. Selects keep the chosen labels.
- Form submits, and keys pressed with Ctrl, Alt or Cmd, plus Enter, Escape and Tab. Plain typing is never recorded key by key.
- Where you stopped scrolling.
- What a click caused in the next second: how many page elements changed, the new URL, and the network requests the page made (method, address without the query string, status, time).
- Events a page sends on purpose through `window.postMessage({autotrack: {v: 1, action, detail}})`, if it is built for autotrack.
- The page URL and title with every event.

## What it never records

- Passwords, or any field whose name, label or autocomplete hint looks like a secret (card number, CVV, token, API key, one-time code). These events keep the fact of the change and drop the value.
- Values that look like secrets anywhere: card numbers, API keys, JWTs, long random strings. These become `<redacted>`.
- Secret parts of URLs: query parameters like `code`, `token` or `key`, and any username or password in the URL.
- Long rich text. A rich text editor over 200 characters records only its length.
- Request and response bodies, headers and cookies.
- Incognito windows. The extension can't run there.

## Where it goes

To the recorder's journal on your computer, in its data folder. Nothing is sent to Wren Automation or anyone else. Pausing the recorder stops recording at once.

## Chrome Web Store listing

Single purpose: Records your clicks, form changes and key shortcuts in the browser and sends them to the autotrack recorder on your computer, so your work can be turned into a step by step log.

Permission reasons:

- `nativeMessaging`: hands events to the autotrack recorder on this computer.
- `webRequest`: lists the requests a click caused (method, address, status). It only observes and never blocks or changes a request.
- Host access to all sites: records clicks on any site you work in.

Data use disclosures: collects website content and user activity (clicks, form values with secrets removed, key shortcuts). Data stays on the user's device. It is not sold, not used for ads or credit, and not sent to any server.
