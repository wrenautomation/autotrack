// @ts-check
/**
 * Secrets never leave the page. Two gates: the field (password inputs, names that say secret)
 * and the value (token shapes). Either one masks. Patterns copied from autobrowse
 * `src/recorder/redact.ts` and autotrack `src/privacy.ts`; `src/privacy.test.ts` fails when
 * `SECRET_VALUES` here differs from the recorder's.
 *
 * Classic script: it sets `globalThis.__autotrack.redact`. In the extension that global lives in
 * the content script's isolated world (or the service worker), where page scripts can't see it.
 */
(() => {
  const AT = /** @type {any} */ (globalThis).__autotrack || {};
  /** @type {any} */ (globalThis).__autotrack = AT;

  const SECRET_FIELD =
    /pass(word|wd|phrase)?|secret|token|api[-_ ]?key|private|credential|otp|code|pin|ssn|cvv|cvc|card|\bdsn\b|\bexp\b|(\b|_)exp(iry|iration)|mm\s*\/\s*yy|valid thru|name on/i;

  /** Query parameters whose value is a credential whatever it looks like. */
  const SECRET_PARAM =
    /^(code|state|token|access_token|id_token|refresh_token|key|api_?key|secret|password|pass|pwd|sig|signature|auth|authorization|session|sid|otp|ticket|jwt|client_secret|x-amz-[a-z-]+)$/i;

  const SECRET_VALUES = [
    /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
    /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/, // GitHub
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bsk-[A-Za-z0-9_-]{20,}\b/, // OpenAI / Anthropic-style
    /\bxox[abp]-[A-Za-z0-9-]{10,}\b/, // Slack
    /\bGOCSPX-[A-Za-z0-9_-]{16,}/, // Google OAuth client secret
    /\bWPL_AP\d\.[A-Za-z0-9._=+/-]{8,}/, // LinkedIn client secret
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b[A-Za-z0-9_-]{40,}\b/, // long opaque strings: Cloudflare tokens, Google keys
    /(?<=[a-z][a-z0-9+.-]*:\/\/)[^\s@/:]+(?::[^\s@/]*)?(?=@)/, // credentials in a URL
  ];
  const SECRET_VALUES_G = SECRET_VALUES.map((re) => new RegExp(re.source, `${re.flags}g`));

  const REDACTED = "<redacted>";

  /** @param {{name?: string|null, placeholder?: string|null, id?: string|null, label?: string|null, inputType?: string|null, autocomplete?: string|null}} h */
  function looksLikeSecretField(h) {
    if (h.inputType === "password") return true;
    if (h.autocomplete && /password|one-time-code|cc-|csc/i.test(h.autocomplete)) return true;
    return [h.name, h.placeholder, h.id, h.label].some((s) => !!s && SECRET_FIELD.test(s));
  }

  /** @param {string} value */
  function looksLikeSecretValue(value) {
    return SECRET_VALUES.some((re) => re.test(value));
  }

  /** 13-19 digits, spaced or dashed as a card prints them. */
  const CARD_RUN = /\b\d(?:[ -]?\d){12,18}\b/g;

  /** Luhn over the digits: a card number, not an order id that happens to be long. @param {string} digits */
  function luhnValid(digits) {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    return sum % 10 === 0;
  }

  /** Mask secret-shaped substrings and anything that reads as a card number. @param {string} text */
  function redactText(text) {
    let out = text;
    for (const re of SECRET_VALUES_G) out = out.replace(re, REDACTED);
    return out.replace(CARD_RUN, (run) => (luhnValid(run.replace(/\D/g, "")) ? REDACTED : run));
  }

  /**
   * A URL with credential-named query values masked, then the text pass.
   * @param {string} url
   */
  function redactUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return redactText(url);
    }
    for (const k of [...u.searchParams.keys()])
      if (SECRET_PARAM.test(k) || SECRET_FIELD.test(k)) u.searchParams.set(k, REDACTED);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
    }
    // Fragments carry OAuth implicit-flow tokens.
    if (/(^|[#&])(access_token|id_token|token|code)=/.test(u.hash)) u.hash = `#${REDACTED}`;
    return redactText(u.href);
  }

  /** Origin + path, no query or fragment: what a request is, never what it carried. @param {string} url */
  function originPath(url) {
    try {
      const u = new URL(url);
      if (u.origin === "null") return `${u.protocol}`;
      return redactText(u.origin + u.pathname);
    } catch {
      return "";
    }
  }

  AT.redact = {
    REDACTED,
    SECRET_FIELD,
    SECRET_VALUES,
    looksLikeSecretField,
    looksLikeSecretValue,
    redactText,
    redactUrl,
    originPath,
  };
})();
