# autotrack privacy

autotrack records what you do in the browser so the autotrack recorder on the same computer can turn it into a log of your work. It sends nothing over the network. Events go from the extension to a small program on your computer (the native host), which hands them to the recorder. If the recorder isn't running or is paused, the extension drops events.

## What it records

- Clicks, double clicks, right clicks and pointer presses. For each one it records the element: tag, role, accessible name, short visible text, id, test id, a CSS path, an XPath, the link target, `aria-*` and `data-*` attributes, React component names when the page uses React, and the element's position on screen.
- Form changes. Text fields keep their value up to 1,000 characters. Checkboxes keep checked or not. Selects keep the chosen labels.
- Form submits, and keys pressed with Ctrl, Alt or Cmd, plus Enter, Escape and Tab. Plain typing is never recorded key by key.
- Where you stopped scrolling.
- What a click caused in the next second: how many page elements changed, the new URL, and the network requests the page made (method, address without the query string, status, time).
- Events a page sends on purpose through `window.postMessage({autotrack: {v: 1, action, detail}})`, if it is built for autotrack.
- Each navigation: the new address and the one it came from, and how you got there (link, typed, reload, back or forward). Searches: the engine and the words you searched for, read from the address.
- Tabs opening, closing and switching, with the tab's address and title and how many tabs the window has.
- Text you copy, cut or paste, up to 2,000 characters, and text you select with the mouse, up to 500, with the element it was in.
- Downloads, as metadata only: file extension, type, size, the site it came from, and whether it finished.
- Errors the page logged to the console or threw in the second after a click: the message, up to 200 characters.
- The visible part of the page as an outline of text (roles and names, such as `button "Save"`), up to 30,000 characters. It is taken when a page finishes loading and after a click changed more than 20 page elements, at most once every 2 seconds per tab.
- The page URL and title with every event.

## What it never records

- Passwords, or any field whose name, label or autocomplete hint looks like a secret (card number, CVV, token, API key, one-time code). These events keep the fact of the change and drop the value.
- Values that look like secrets anywhere: card numbers, API keys, JWTs, long random strings. These become `<redacted>`.
- Secret parts of URLs: query parameters like `code`, `token` or `key`, and any username or password in the URL.
- Anything from a password field, copied, cut, pasted or selected: only the fact that it happened.
- Text typed into fields, in the page outline. It holds the page's labels and visible text, never a field's value.
- Download file names, folders and contents.
- Long rich text. A rich text editor over 200 characters records only its length.
- Request and response bodies, headers and cookies.
- Incognito windows. The extension can't run there.

## Where it goes

To the recorder's journal on your computer, in its data folder. Nothing is sent to Wren Automation or anyone else. Pausing the recorder stops recording at once.

## Chrome Web Store listing

Single purpose: Records your clicks, form changes, key shortcuts, page changes and navigation in the browser and sends them to the autotrack recorder on your computer, so your work can be turned into a step by step log.

Permission reasons:

- `nativeMessaging`: hands events to the autotrack recorder on this computer.
- `webNavigation`: sees when a tab goes to a new address, to record where you went and how.
- `downloads`: sees that a download finished, to record its type, size and source site. It never reads, opens or moves the file.
- `webRequest`: lists the requests a click caused (method, address, status). It only observes and never blocks or changes a request.
- Host access to all sites: records clicks on any site you work in.

Data use disclosures: collects website content and user activity (clicks, form values with secrets removed, key shortcuts, addresses visited, searches, copied and pasted text with secrets removed, a text outline of the page). Data stays on the user's device. It is not sold, not used for ads or credit, and not sent to any server.
