/**
 * The one session this reader ever has.
 *
 * There is a single account, so a session carries no identity — only the fact
 * that whoever holds it typed the password, and until when. That is a signed
 * expiry and nothing else, which is why it needs no table: there is no list of
 * sessions to look a token up in, and none to revoke one from. The only way to
 * take every session back is to change `AUTH_SESSION_SECRET`, which is written
 * down in CLAUDE.md as the lost-phone lever.
 */

export const SESSION_COOKIE = "account_session";

/** Long enough that a phone picked up on the weekend is still signed in. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function toBase64Url(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sign(payload: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    encoder.encode(payload),
  );
  return toBase64Url(signature);
}

/**
 * Compare without letting the time taken say how much of it matched.
 *
 * A comparison that stops at the first wrong byte tells an attacker, by how
 * long it took, that the bytes before it were right — which turns forging a
 * signature from guessing the whole thing into guessing one byte at a time.
 */
function equalsInConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

/** A token good until `SESSION_MAX_AGE_MS` from now. */
export async function issueSession(secret: string, now: number): Promise<string> {
  const expiresAt = String(now + SESSION_MAX_AGE_MS);
  return `${expiresAt}.${await sign(expiresAt, secret)}`;
}

/**
 * Whether this token was issued here and still has time left.
 *
 * The signature is checked before the expiry is trusted: the expiry is the
 * signed payload, so a token whose expiry has been edited fails the signature
 * rather than being read as a longer session.
 */
export async function verifySession(token: string, secret: string, now: number): Promise<boolean> {
  const separator = token.indexOf(".");
  if (separator <= 0) return false;

  const expiresAt = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (signature === "") return false;

  if (!equalsInConstantTime(signature, await sign(expiresAt, secret))) return false;

  const deadline = Number(expiresAt);
  return Number.isFinite(deadline) && now <= deadline;
}

/**
 * `Secure` even though it costs the plain-HTTP LAN address: this is deployed on
 * the open internet, and a session cookie that travels in the clear is a
 * password that travels in the clear. Reading on a phone goes through the
 * deployed HTTPS URL; `localhost` counts as secure, so local development and
 * the end-to-end tests are unaffected.
 *
 * Production can pass the shared `<account>.workers.dev` domain so sibling
 * Workers receive the same cookie. Local development leaves it empty, keeping
 * the cookie host-limited as before.
 */
export function sessionCookie(token: string, domain?: string): string {
  const maxAgeSeconds = Math.floor(SESSION_MAX_AGE_MS / 1000);
  const domainAttribute = domain ? `; Domain=${domain}` : "";
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/${domainAttribute}; Max-Age=${maxAgeSeconds}`;
}

/** The same cookie, told to go now, so logging out does not wait for the expiry. */
export function clearedSessionCookie(domain?: string): string {
  const domainAttribute = domain ? `; Domain=${domain}` : "";
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/${domainAttribute}; Max-Age=0`;
}

/**
 * This app's cookie out of the header the browser sent.
 *
 * Matched on the whole name rather than a suffix, so a cookie another app left
 * on the same host cannot stand in for this one.
 */
export function readSessionCookie(header: string | null): string | null {
  if (!header) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;

    const value = part.slice(separator + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}
