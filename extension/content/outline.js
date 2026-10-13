// @ts-check
/**
 * The page as an accessibility outline in text, what a person (or a model) sees on screen:
 *
 *   - main:
 *     - heading "Inbox" [level=1]
 *     - text: 3 unread
 *     - button "Save draft"
 *
 * Roles and names come from hints.js. Visible part only: nothing hidden (`display:none`,
 * `aria-hidden`), nothing wholly outside the viewport. A leaf role (button, link, heading, field…)
 * is one line and its content is its name; other roles hold their children; roleless elements
 * only pass their children through; a label's text is left out, since it names its control.
 * Never a field's value, never a textarea, select or editable region's content. Names and text go through the redaction rules. Open shadow roots are
 * walked, iframes are not.
 *
 * Bounded: ≤ 30,000 characters, ≤ 48,000 bytes once JSON-escaped (the recorder refuses control
 * lines over 64 KB), ≤ 10,000 elements, ≤ 100 ms. When a bound hits, the outline ends there.
 *
 * Classic script; sets `globalThis.__autotrack.outline`. Needs redact.js and hints.js first.
 */
(() => {
  const AT = /** @type {any} */ (globalThis).__autotrack;
  const { hints, redact: R } = AT;

  const MAX_CHARS = 30000;
  const MAX_BYTES = 48000;
  const MAX_NODES = 10000;
  const MAX_MS = 100;
  const MAX_DEPTH = 24; // nesting of emitted lines
  const MAX_DOM = 400; // nesting of elements walked
  const TEXT_MAX = 200;
  const NAME_MAX = 120;

  /** Roles that are one line: their content is their name. */
  const LEAF =
    /^(button|link|heading|img|checkbox|radio|switch|tab|menuitem|menuitemcheckbox|menuitemradio|option|treeitem|textbox|searchbox|combobox|spinbutton|slider|progressbar)$/;
  /** Roles that add nothing to a reader: their children pass through. */
  const TRANSPARENT = /^(presentation|none|generic)$/;
  const SKIP_TAG = /^(script|style|noscript|template|head|svg|canvas|iframe|object)$/;

  const encoder = new TextEncoder();
  /** Bytes the line takes as a JSON string. @param {string} line */
  const jsonBytes = (line) => encoder.encode(JSON.stringify(line)).length;
  /** @param {string|null|undefined} s @param {number} max */
  const squash = (s, max) => (s ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

  /**
   * @param {Document} doc
   * @param {{maxChars?: number, maxBytes?: number, maxNodes?: number, maxMs?: number}} [o]
   * @returns {string}
   */
  function snapshot(doc, o = {}) {
    const maxChars = o.maxChars ?? MAX_CHARS;
    const maxBytes = o.maxBytes ?? MAX_BYTES;
    const maxNodes = o.maxNodes ?? MAX_NODES;
    const deadline = (globalThis.performance?.now?.() ?? 0) + (o.maxMs ?? MAX_MS);
    const view = doc.defaultView;
    if (!view || !doc.documentElement) return "";
    // No layout engine (jsdom) or no layout yet: everything not display:none counts as visible.
    const layout = doc.documentElement.getClientRects().length > 0;
    const vw = view.innerWidth;
    const vh = view.innerHeight;

    /** @type {string[]} */
    const out = [];
    let chars = 0;
    let bytes = 0;
    let nodes = 0;
    let done = false;

    /** Reserve room for a line; false (and stop) when it would not fit. @param {string} line */
    function fits(line) {
      const b = jsonBytes(line); // its two quotes stand in for the "\n" that joins it
      if (chars + line.length + 1 > maxChars || bytes + b > maxBytes) {
        done = true;
        return false;
      }
      chars += line.length + 1;
      bytes += b;
      return true;
    }

    /** @param {Element} el @returns {"skip"|"pass"|"keep"} */
    function show(el) {
      if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden")) return "skip";
      const cs = view?.getComputedStyle(el);
      if (cs?.display === "none") return "skip";
      if (cs?.display === "contents") return "pass";
      if (!layout) return cs?.visibility === "hidden" ? "pass" : "keep";
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return "pass";
      if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return "skip";
      return cs?.visibility === "hidden" || cs?.visibility === "collapse" ? "pass" : "keep";
    }

    /** @param {Node} node @param {number} depth @param {number} dom @param {boolean} [quiet] no text */
    function walk(node, depth, dom, quiet = false) {
      if (done) return;
      if (node.nodeType === 3) {
        if (quiet) return;
        const t = squash(node.nodeValue, TEXT_MAX);
        if (t) {
          const line = `${"  ".repeat(depth)}- text: ${R.redactText(t)}`;
          if (fits(line)) out.push(line);
        }
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeType === 1) {
        if (
          ++nodes > maxNodes ||
          (nodes % 64 === 0 && (globalThis.performance?.now?.() ?? 0) > deadline)
        ) {
          done = true;
          return;
        }
        const el = /** @type {Element} */ (node);
        if (SKIP_TAG.test(el.localName) || dom > MAX_DOM) return;
        const how = show(el);
        if (how === "skip") return;
        const role = how === "keep" ? hints.role(el) : "";
        if (role === "label") {
          const control = /** @type {HTMLLabelElement} */ (el).control;
          if (!control) return children(el, depth, dom, quiet);
          // The control carries the text as its name; a wrapped control still shows.
          return el.contains(control) ? children(el, depth, dom, true) : undefined;
        }
        if (role && !TRANSPARENT.test(role)) {
          if (LEAF.test(role)) return leaf(el, role, depth);
          return container(el, role, depth, dom, quiet);
        }
      }
      children(node, depth, dom, quiet);
    }

    /** @param {Node} node @param {number} depth @param {number} dom @param {boolean} [quiet] */
    function children(node, depth, dom, quiet = false) {
      const host = /** @type {Element} */ (node);
      if (host.localName === "slot") {
        const slot = /** @type {HTMLSlotElement} */ (/** @type {unknown} */ (host));
        const assigned = slot.assignedNodes ? slot.assignedNodes({ flatten: true }) : [];
        for (const c of assigned.length ? assigned : [...host.childNodes])
          walk(c, depth, dom + 1, quiet);
        return;
      }
      const root = host.shadowRoot || node;
      for (const c of root.childNodes) {
        walk(c, depth, dom + 1, quiet);
        if (done) return;
      }
    }

    /** @param {Element} el @param {string} role @param {number} depth */
    function leaf(el, role, depth) {
      const name = R.redactText(hints.name(el).slice(0, NAME_MAX));
      if (role === "img" && !name) return;
      let line = `${"  ".repeat(depth)}- ${role}${name ? ` ${JSON.stringify(name)}` : ""}`;
      const level = role === "heading" ? headingLevel(el) : 0;
      if (level) line += ` [level=${level}]`;
      if (isChecked(el)) line += " [checked]";
      if (/** @type {any} */ (el).disabled === true || el.getAttribute("aria-disabled") === "true")
        line += " [disabled]";
      const expanded = el.getAttribute("aria-expanded");
      if (expanded === "true" || expanded === "false") line += ` [expanded=${expanded}]`;
      if (fits(line)) out.push(line);
    }

    /** @param {Element} el @param {string} role @param {number} depth @param {number} dom @param {boolean} quiet */
    function container(el, role, depth, dom, quiet) {
      const label = R.redactText(squash(el.getAttribute("aria-label"), NAME_MAX));
      const head = `${"  ".repeat(depth)}- ${role}${label ? ` ${JSON.stringify(label)}` : ""}`;
      if (depth >= MAX_DEPTH) return children(el, depth, dom, quiet);
      const at = out.length;
      if (!fits(`${head}:`)) return;
      out.push(`${head}:`);
      children(el, depth + 1, dom, quiet);
      // Nothing inside: a labelled one stays as a bare line, an unlabelled one goes.
      if (out.length === at + 1) {
        if (label) out[at] = head;
        else {
          out.length = at;
          chars -= head.length + 2;
          bytes -= jsonBytes(`${head}:`);
        }
      }
    }

    walk(doc.documentElement, 0, 0);
    return out.join("\n");
  }

  /** @param {Element} el */
  function headingLevel(el) {
    const m = /^h([1-6])$/.exec(el.localName);
    const n = m ? Number(m[1]) : Number(el.getAttribute("aria-level"));
    return n >= 1 && n <= 6 ? n : 0;
  }

  /** @param {Element} el */
  function isChecked(el) {
    const t = el.localName === "input" ? (el.getAttribute("type") || "").toLowerCase() : "";
    if (t === "checkbox" || t === "radio") return !!(/** @type {HTMLInputElement} */ (el).checked);
    return el.getAttribute("aria-checked") === "true";
  }

  AT.outline = { snapshot, MAX_CHARS, MAX_BYTES };
})();
