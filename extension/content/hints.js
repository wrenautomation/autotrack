// @ts-check
/**
 * What an element is, from the DOM: role, accessible name, text, ids, a short unique CSS path,
 * an XPath, aria-* and data-* attributes, and a field's value through the redaction rules. Ideas
 * copied from autobrowse `src/recorder/observer.ts`. Runs in the isolated world: the DOM is
 * shared with the page, but this code and its prototypes are not, so a page can't tamper with it.
 *
 * Classic script; sets `globalThis.__autotrack.hints`. Needs `redact.js` loaded first.
 */
(() => {
  const AT = /** @type {any} */ (globalThis).__autotrack;
  const R = AT.redact;

  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const NAME_MAX = 120;
  const TEXT_MAX = 200;
  const ATTR_MAX = 80;
  const ATTRS_MAX = 24;

  /** @type {Record<string, string>} */
  const IMPLICIT = {
    button: "button",
    summary: "button",
    textarea: "textbox",
    option: "option",
    img: "img",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    nav: "navigation",
    form: "form",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    aside: "complementary",
    dialog: "dialog",
    ul: "list",
    ol: "list",
    li: "listitem",
    table: "table",
    tr: "row",
    td: "cell",
    th: "columnheader",
    details: "group",
    progress: "progressbar",
    label: "label",
  };
  /** @type {Record<string, string>} */
  const INPUT_ROLES = {
    checkbox: "checkbox",
    radio: "radio",
    submit: "button",
    button: "button",
    reset: "button",
    image: "button",
    range: "slider",
    number: "spinbutton",
    search: "searchbox",
  };
  /** Roles whose name comes from their content. */
  const NAME_FROM_TEXT =
    /^(button|link|menuitem|menuitemcheckbox|menuitemradio|tab|option|heading|checkbox|radio|switch|cell|columnheader|rowheader|treeitem|tooltip|label|listitem)$/;
  const TEST_ID_ATTRS = ["data-testid", "data-test", "data-cy"];
  const INTERACTIVE =
    "a[href], button, input, select, textarea, summary, label, [role], [onclick], [contenteditable]:not([contenteditable=false]), [tabindex]:not([tabindex='-1'])";

  /** @param {string|null|undefined} s @param {number} max */
  const squash = (s, max) => (s ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

  const SKIP_TEXT = /^(script|style|noscript|template|textarea|select)$/;

  /**
   * Visible-ish text of an element: its text nodes outside script/style, whitespace collapsed,
   * stopping once past `max` (cheap on a whole page body, no layout).
   * @param {Element} el @param {number} max
   */
  function textOf(el, max) {
    let out = "";
    const doc = el.ownerDocument;
    const walker = doc.createTreeWalker(el, 5 /* SHOW_ELEMENT | SHOW_TEXT */, {
      acceptNode: (n) =>
        n.nodeType === 1 && SKIP_TEXT.test(/** @type {Element} */ (n).localName) ? 2 : 1,
    });
    for (let n = walker.nextNode(); n && out.length <= max * 2; n = walker.nextNode())
      if (n.nodeType === 3) out += ` ${n.nodeValue}`;
    return squash(out, max + 1);
  }

  /** @param {Element} el */
  const inputType = (el) =>
    el.localName === "input" ? (el.getAttribute("type") || "text").toLowerCase() : "";

  /** @param {Element} el */
  const isField = (el) =>
    el.localName === "input" || el.localName === "textarea" || el.localName === "select";

  /** @param {Element} el */
  function isEditable(el) {
    if (/** @type {HTMLElement} */ (el).isContentEditable) return true;
    // jsdom leaves isContentEditable false; read the attribute.
    const host = el.closest?.("[contenteditable]");
    return !!host && host.getAttribute("contenteditable") !== "false";
  }

  /** @param {Element} el */
  function role(el) {
    const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = el.localName;
    if (tag === "a" || tag === "area") return el.hasAttribute("href") ? "link" : "";
    if (tag === "input") {
      const t = inputType(el);
      if (t === "hidden") return "";
      if (el.hasAttribute("list") && !INPUT_ROLES[t]) return "combobox";
      return INPUT_ROLES[t] || "textbox";
    }
    if (tag === "select")
      return el.hasAttribute("multiple") || Number(el.getAttribute("size")) > 1
        ? "listbox"
        : "combobox";
    if (tag === "img" && el.getAttribute("alt") === "") return "presentation";
    if (IMPLICIT[tag]) return IMPLICIT[tag];
    if (isEditable(el)) return "textbox";
    return "";
  }

  /** @param {Element} el */
  function labelText(el) {
    const labels = /** @type {any} */ (el).labels;
    if (labels?.length) return squash([...labels].map((l) => l.textContent).join(" "), NAME_MAX);
    const wrap = el.closest("label");
    return wrap ? squash(wrap.textContent, NAME_MAX) : "";
  }

  /**
   * Accessible name, in the order the brief sets: aria-labelledby, aria-label, label, alt,
   * title, placeholder, then content.
   * @param {Element} el
   */
  function name(el) {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const root = /** @type {Document|ShadowRoot} */ (el.getRootNode());
      const text = by
        .split(/\s+/)
        .map((id) => (root.getElementById ? root.getElementById(id) : null)?.textContent || "")
        .join(" ");
      const s = squash(text, NAME_MAX);
      if (s) return s;
    }
    const direct =
      squash(el.getAttribute("aria-label"), NAME_MAX) ||
      (isField(el) ? labelText(el) : "") ||
      squash(el.getAttribute("alt"), NAME_MAX) ||
      squash(el.getAttribute("title"), NAME_MAX) ||
      squash(el.getAttribute("placeholder"), NAME_MAX);
    if (direct) return direct;
    const t = inputType(el);
    if (t === "submit" || t === "button" || t === "reset")
      return squash(/** @type {HTMLInputElement} */ (el).value, NAME_MAX);
    if (isField(el) || isEditable(el)) return "";
    const r = role(el);
    const text = textOf(el, NAME_MAX);
    // A roleless element is named by its text only when the text is label-sized (a clickable div).
    if (NAME_FROM_TEXT.test(r) || (!r && text.length <= 80 && !/^(body|html)$/.test(el.localName)))
      return R.redactText(text.slice(0, NAME_MAX));
    return "";
  }

  /** @param {Element} el */
  function secret(el) {
    return R.looksLikeSecretField({
      name: el.getAttribute("name"),
      placeholder: el.getAttribute("placeholder"),
      id: el.id,
      label: el.getAttribute("aria-label") || (isField(el) ? labelText(el) : ""),
      inputType: inputType(el) || null,
      autocomplete: el.getAttribute("autocomplete"),
    });
  }

  /** CSS identifier escape; jsdom has no `CSS.escape`. @param {string} s */
  function cssEscape(s) {
    const css = /** @type {any} */ (globalThis).CSS;
    if (css?.escape) return css.escape(s);
    return s.replace(/^-?\d|[^a-zA-Z0-9_-]/g, (c) => `\\${c.codePointAt(0)?.toString(16)} `);
  }
  /** @param {string} s */
  const cssString = (s) => s.replace(/["\\]/g, "\\$&");

  /** @param {Element} el */
  function testIdAttr(el) {
    for (const a of TEST_ID_ATTRS) {
      const v = el.getAttribute(a);
      if (v) return { attr: a, value: v };
    }
    return null;
  }

  /**
   * A short CSS selector that matches only `el` within its root (document or shadow root):
   * `#id`, a test id, or the shortest tail of `tag:nth-of-type` steps that is unique.
   * @param {Element} el
   */
  function cssPath(el) {
    const root = /** @type {Document|ShadowRoot} */ (el.getRootNode());
    /** @param {string} sel */
    const only = (sel) => {
      try {
        const all = root.querySelectorAll(sel);
        return all.length === 1 && all[0] === el;
      } catch {
        return false;
      }
    };
    if (el.id && only(`#${cssEscape(el.id)}`)) return `#${cssEscape(el.id)}`;
    const tid = testIdAttr(el);
    if (tid) {
      const sel = `[${tid.attr}="${cssString(tid.value)}"]`;
      if (only(sel)) return sel;
    }
    /** @type {string[]} */
    const parts = [];
    /** @type {Element|null} */
    let n = el;
    while (n && n.nodeType === 1) {
      const parent = /** @type {ParentNode|null} */ (n.parentNode);
      if (n !== el && n.id) {
        const anchor = `#${cssEscape(n.id)}`;
        try {
          if (root.querySelectorAll(anchor).length === 1) {
            parts.unshift(anchor);
            const sel = parts.join(" > ");
            if (only(sel)) return sel;
            parts.shift();
          }
        } catch {}
      }
      let step = cssEscape(n.localName);
      if (parent?.children) {
        const tag = n.localName;
        const same = [...parent.children].filter((c) => c.localName === tag);
        if (same.length > 1) step += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(step);
      const sel = parts.join(" > ");
      if (only(sel)) return sel;
      n = n.parentElement;
    }
    return parts.join(" > ");
  }

  /**
   * Absolute XPath from the root, indexed where siblings share a tag. Non-HTML elements (SVG)
   * use `*[local-name()=…]` so the path evaluates in an HTML document.
   * @param {Element} el
   */
  function xpath(el) {
    /** @type {string[]} */
    const parts = [];
    /** @type {Element|null} */
    let n = el;
    while (n && n.nodeType === 1) {
      const tag = n.localName;
      const step =
        n.namespaceURI === HTML_NS || n.namespaceURI === null ? tag : `*[local-name()="${tag}"]`;
      let index = 0;
      let count = 0;
      const parent = /** @type {ParentNode|null} */ (n.parentNode);
      if (parent?.children)
        for (const c of parent.children)
          if (c.localName === tag && c.namespaceURI === n.namespaceURI) {
            count++;
            if (c === n) index = count;
          }
      parts.unshift(count > 1 ? `${step}[${index}]` : step);
      n = n.parentElement;
    }
    return `/${parts.join("/")}`;
  }

  /** aria-* and data-* attributes, names and values ≤ 80 chars, never one that carries a value. @param {Element} el */
  function attrs(el) {
    /** @type {Record<string, string>} */
    const out = {};
    let n = 0;
    for (const a of el.attributes) {
      if (!/^(aria|data)-/.test(a.name) || /value/i.test(a.name)) continue;
      const secretName = R.SECRET_FIELD.test(a.name.replace(/^(aria|data)-/, ""));
      out[a.name.slice(0, ATTR_MAX)] = secretName
        ? R.REDACTED
        : R.redactText(a.value).slice(0, ATTR_MAX);
      if (++n >= ATTRS_MAX) break;
    }
    return n ? out : undefined;
  }

  /**
   * The element a person meant: the nearest interactive ancestor of what the pointer hit.
   * @param {Element} el
   */
  function interactive(el) {
    return el.closest?.(INTERACTIVE) || el;
  }

  /**
   * Everything known about an element. `toScreen` maps a client rect to screen points (null when
   * no pointer has calibrated this frame yet); `react` asks the page world for component names.
   * @param {Element} el
   * @param {{toScreen?: (r: DOMRect) => {x:number,y:number,width:number,height:number}|null, react?: (el: Element) => string[]|null}} [opts]
   */
  function target(el, opts = {}) {
    /** @type {Record<string, any>} */
    const t = { tag: el.localName };
    const r = role(el);
    if (r) t.role = r;
    const nm = name(el);
    if (nm) t.name = nm;
    if (!isField(el) && !isEditable(el)) {
      const text = R.redactText(textOf(el, TEXT_MAX).slice(0, TEXT_MAX));
      if (text) t.text = text;
    }
    if (el.id) t.id = el.id.slice(0, ATTR_MAX);
    const tid = testIdAttr(el);
    if (tid) t.testId = tid.value.slice(0, ATTR_MAX);
    t.css = cssPath(el);
    t.xpath = xpath(el);
    if ((el.localName === "a" || el.localName === "area") && el.hasAttribute("href")) {
      const href = /** @type {HTMLAnchorElement} */ (el).href || el.getAttribute("href") || "";
      t.href = R.redactUrl(href);
    }
    const it = inputType(el);
    if (it) t.inputType = it;
    const a = attrs(el);
    if (a) t.attrs = a;
    const react = opts.react?.(el);
    if (react?.length) t.react = react;
    const rect = opts.toScreen?.(el.getBoundingClientRect());
    if (rect) t.rect = rect;
    return t;
  }

  /**
   * A field's value through the redaction rules: nothing from a secret field, a secret-shaped
   * value masked whole, other values with secret substrings masked. Editable regions over 200
   * chars keep their length only.
   * @param {Element} el
   * @returns {{value?: string|boolean, redacted?: true, length?: number}}
   */
  function fieldValue(el) {
    if (secret(el)) return { redacted: true };
    const t = inputType(el);
    if (t === "checkbox" || t === "radio") return { value: /** @type {any} */ (el).checked };
    let v;
    if (el.localName === "select") {
      const s = /** @type {HTMLSelectElement} */ (el);
      v = [...s.selectedOptions].map((o) => o.label || o.value).join(", ");
    } else if (isField(el)) v = /** @type {HTMLInputElement} */ (el).value;
    else {
      v = /** @type {HTMLElement} */ (el).innerText ?? el.textContent ?? "";
      if (v.length > TEXT_MAX) return { length: v.length };
    }
    v = String(v ?? "");
    if (R.looksLikeSecretValue(v)) return { redacted: true, length: v.length };
    const out = R.redactText(v).slice(0, 1000);
    return out === v
      ? { value: out, length: v.length }
      : { value: out, redacted: true, length: v.length };
  }

  AT.hints = {
    role,
    name,
    secret,
    cssPath,
    xpath,
    attrs,
    interactive,
    target,
    fieldValue,
    isField,
    isEditable,
  };
})();
