/**
 * What never gets recorded: keys typed into a password field, secret-shaped text, clipboard text
 * from a password field or a concealed copy, anything while an excluded app (password managers,
 * banking) or the lock screen is in front.
 */
import type { App, Element, WindowInfo } from "./events.ts";

// Copied from autobrowse src/recorder/redact.ts (SECRET_VALUES): track imports nothing from it.
// extension/content/redact.js carries the same list for the browser (a classic script, no
// import); privacy.test.ts checks the two agree pattern for pattern.
export const SECRET_VALUES: RegExp[] = [
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

export const REDACTED = "<redacted>";

export function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUES.some((re) => re.test(value));
}

const CARD_RUN = /\b\d(?:[ -]?\d){12,18}\b/g;

function luhnValid(digits: string): boolean {
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

/** Mask secret-shaped substrings and card numbers. */
export function redactSecrets(text: string): { text: string; redacted: boolean } {
  let out = text;
  for (const re of SECRET_VALUES)
    out = out.replace(new RegExp(re.source, `${re.flags}g`), REDACTED);
  out = out.replace(CARD_RUN, (run) => (luhnValid(run.replace(/\D/g, "")) ? REDACTED : run));
  return { text: out, redacted: out !== text };
}

/**
 * A text run as written. `focused` is the probe's answer for the focused element at the run's
 * start; `null` means no answer, and an unanswered run is written empty, never in the clear.
 */
export function textOf(
  text: string,
  focused: { element: Element | null } | null,
): { text: string; redacted: boolean } {
  if (!focused || focused.element?.secure) return { text: "", redacted: true };
  return redactSecrets(text);
}

export const CLIPBOARD_TEXT_MAX = 2000;

/**
 * A clipboard change's text as written: redacted, then at most 2,000 characters. None when the
 * copy was concealed or made under secure input, or when the focused element is secure or did not
 * answer (`focused` null): then only `redacted: true` says text was there.
 */
export function clipboardText(
  c: { text?: string; length: number; concealed: boolean; secure?: boolean },
  focused: { element: Element | null } | null,
): { text?: string; redacted: boolean } {
  const has = c.text !== undefined || c.length > 0;
  if (c.concealed || c.secure) return { redacted: has || c.concealed };
  if (!has) return { redacted: false };
  if (!focused || focused.element?.secure || c.text === undefined) return { redacted: true };
  const r = redactSecrets(c.text);
  return { text: r.text.slice(0, CLIPBOARD_TEXT_MAX), redacted: r.redacted };
}

/**
 * Keys are held, not written, until the probe answers for the focused element. Asks again every
 * `waitMs` up to `tries` times; `null` when it never answers (the run is then written redacted).
 */
export async function holdForFocus<T>(
  first: T | null,
  ask: () => Promise<T | null>,
  opts: { tries?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T | null> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let answer = first;
  for (let i = 0; answer === null && i < (opts.tries ?? 25); i++) {
    await sleep(opts.waitMs ?? 200);
    answer = await ask();
  }
  return answer;
}

export const DEFAULT_EXCLUDED_APPS = [
  "1Password",
  "Bitwarden",
  "Keychain Access",
  "Passwords",
  "KeePass",
  "KeePassXC",
  "Seahorse",
];
export const DEFAULT_EXCLUDED_TITLES = ["bank|chase|wells fargo|paypal"];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** By name, or by the tail of the bundle id or exe path (`com.apple.keychainaccess`, `…\KeePass.exe`). */
export function appMatches(app: App, entry: string): boolean {
  const e = norm(entry);
  if (!e) return false;
  const id = norm(app.id);
  return norm(app.name) === e || id.endsWith(e) || id.endsWith(`${e}exe`);
}

// Linux: the helper answers app "lockscreen" while the screensaver or lock is up.
const LOCK_APPS = ["loginwindow", "ScreenSaverEngine", "LockApp", "LogonUI", "lockscreen"];

export interface Gate {
  excludeApps: string[];
  excludeTitles: RegExp[];
}

export function makeGate(cfg: { excludeApps?: string[]; excludeTitles?: string[] }): Gate {
  return {
    excludeApps: [...DEFAULT_EXCLUDED_APPS, ...(cfg.excludeApps ?? [])],
    excludeTitles: [...DEFAULT_EXCLUDED_TITLES, ...(cfg.excludeTitles ?? [])].map(
      (s) => new RegExp(s, "i"),
    ),
  };
}

/** Why nothing may be recorded with this app and window in front, or null when recording is fine. */
export function blocked(
  gate: Gate,
  app: App | undefined,
  window: WindowInfo | null | undefined,
): "excluded" | "locked" | null {
  if (app && LOCK_APPS.some((l) => appMatches(app, l))) return "locked";
  if (app && gate.excludeApps.some((e) => appMatches(app, e))) return "excluded";
  if (window?.title && gate.excludeTitles.some((re) => re.test(window.title))) return "excluded";
  return null;
}
