import { describe, it, expect, beforeAll } from "vite-plus/test";
import { applyD1Migrations } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import app from "../../src/server/index";
import { SESSION_COOKIE, SESSION_MAX_AGE_MS, issueSession } from "../../src/server/auth/session";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const LOGIN = "https://example.com/api/auth/login";
const SHELF = "https://example.com/api/pdfs";

function login(body: unknown): Promise<Response> {
  return exports.default.fetch(LOGIN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Explicit bindings for checking configured and empty cookie-domain wiring. */
function bindingsWithSessionCookieDomain(domain: string) {
  return {
    DB: env.DB,
    PDF_BUCKET: env.PDF_BUCKET,
    LLM_API_KEY: "test-key",
    AUTH_USERNAME: "test-user",
    AUTH_PASSWORD: "test-password",
    AUTH_SESSION_SECRET: env.AUTH_SESSION_SECRET,
    SESSION_COOKIE_DOMAIN: domain,
  };
}

/** The cookie the browser would have been handed, as a request header. */
function cookieFrom(response: Response): string {
  const header = response.headers.get("Set-Cookie");
  if (!header) throw new Error("no Set-Cookie on the response");
  return header.split(";")[0];
}

describe("POST /api/auth/login", () => {
  it("hands back a session for the right username and password", async () => {
    const response = await login({ username: "test-user", password: "test-password" });

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ signedIn: true });
  });

  it("keeps the session from travelling in the clear, and from scripts", async () => {
    const response = await login({ username: "test-user", password: "test-password" });

    // The whole list rather than the three attributes this test is named for:
    // checking only the ones named here would let a dropped `Path` or a
    // shortened `Max-Age` through, and those are as much a part of the cookie
    // as `Secure` is. The token itself carries the time it was signed at, so it
    // is left out — that it works is "lets the reader through" below.
    const [assignment, ...attributes] = response.headers.get("Set-Cookie")!.split("; ");
    expect(assignment.slice(0, assignment.indexOf("="))).toBe("account_session");
    expect(attributes).toStrictEqual([
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Path=/",
      "Max-Age=2592000",
    ]);
  });

  it("sets the configured shared Domain on the login cookie", async () => {
    const response = await app.request(
      "https://chatbook.example.workers.dev/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "test-user", password: "test-password" }),
      },
      bindingsWithSessionCookieDomain("example.workers.dev"),
    );

    expect(response.headers.get("Set-Cookie")).toContain("; Domain=example.workers.dev;");
  });

  it("keeps the login cookie host-limited when the binding is empty", async () => {
    const response = await app.request(
      LOGIN,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "test-user", password: "test-password" }),
      },
      bindingsWithSessionCookieDomain(""),
    );

    expect(response.headers.get("Set-Cookie")).not.toContain("; Domain=");
  });

  it("refuses a wrong password without saying the username was right", async () => {
    const response = await login({ username: "test-user", password: "wrong" });

    expect(response.status).toBe(401);
    expect(await response.json()).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "ユーザー名かパスワードが違います" },
    });
  });

  it("refuses an unknown username with the very same words", async () => {
    // Told apart, the two answers would say which half to keep guessing at.
    const response = await login({ username: "someone-else", password: "test-password" });

    expect(response.status).toBe(401);
    expect(await response.json()).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "ユーザー名かパスワードが違います" },
    });
  });
});

describe("the guard in front of the API", () => {
  it("refuses a request that carries no session", async () => {
    const response = await exports.default.fetch(SHELF);

    expect(response.status).toBe(401);
    expect(await response.json()).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "ログインしてください" },
    });
  });

  it("refuses a session someone signed themselves", async () => {
    const forged = await issueSession("not-the-servers-secret", Date.now());

    const response = await exports.default.fetch(SHELF, {
      headers: { Cookie: `${SESSION_COOKIE}=${forged}` },
    });

    expect(response.status).toBe(401);
  });

  it("refuses a session that has run out, however properly it was signed", async () => {
    // The 30 days are in the signed payload, so this is a real session of this
    // server's own making — only an old one.
    const expired = await issueSession(
      env.AUTH_SESSION_SECRET,
      Date.now() - SESSION_MAX_AGE_MS - 1000,
    );

    const response = await exports.default.fetch(SHELF, {
      headers: { Cookie: `${SESSION_COOKIE}=${expired}` },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "ログインしてください" },
    });
  });

  it("lets the reader through with the session login just handed them", async () => {
    const cookie = cookieFrom(await login({ username: "test-user", password: "test-password" }));

    const response = await exports.default.fetch(SHELF, { headers: { Cookie: cookie } });

    expect(response.status).toBe(200);
  });

  it("leaves the health check open, so it can be watched without a password", async () => {
    const response = await exports.default.fetch("https://example.com/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ status: "ok" });
  });

  it("refuses an unknown path the same way, rather than saying it is unknown", async () => {
    // Otherwise the 404 maps out which endpoints exist for anyone who asks.
    const response = await exports.default.fetch("https://example.com/api/nope");

    expect(response.status).toBe(401);
  });
});

describe("GET /api/auth/session", () => {
  it("says the reader is signed in when they are", async () => {
    const cookie = cookieFrom(await login({ username: "test-user", password: "test-password" }));

    const response = await exports.default.fetch("https://example.com/api/auth/session", {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ signedIn: true });
  });

  it("refuses when they are not, which is how the browser knows to ask", async () => {
    const response = await exports.default.fetch("https://example.com/api/auth/session");

    expect(response.status).toBe(401);
  });
});

describe("a deploy that has not been told its secrets yet", () => {
  /** The bindings a Worker has on the very first deploy, before `secret put`. */
  const noCredentials = { DB: env.DB, PDF_BUCKET: env.PDF_BUCKET, LLM_API_KEY: "test-key" };

  it("refuses to let anyone in rather than letting everyone in", async () => {
    const response = await app.request(
      LOGIN,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "test-user", password: "test-password" }),
      },
      noCredentials,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toStrictEqual({
      error: {
        code: "CONFIG_ERROR",
        message: "サーバーにログイン情報が設定されていません",
      },
    });
  });

  it("keeps the shelf shut even for a session signed with the real secret", async () => {
    // Nothing to check the signature against, so there is no session it can
    // believe — which is the point of going out closed.
    const token = await issueSession(env.AUTH_SESSION_SECRET, Date.now());

    const response = await app.request(
      SHELF,
      { headers: { Cookie: `${SESSION_COOKIE}=${token}` } },
      noCredentials,
    );

    expect(response.status).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("takes the session back on the way out", async () => {
    const response = await exports.default.fetch("https://example.com/api/auth/logout", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ signedIn: false });
    // Written out, as in the unit test: the name is part of what goes on the
    // wire. `SESSION_COOKIE` is imported for building requests, where following
    // a rename is what a test should do.
    expect(response.headers.get("Set-Cookie")).toBe(
      "account_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
    );
  });

  it("expires the configured shared-domain cookie", async () => {
    const response = await app.request(
      "https://chatbook.example.workers.dev/api/auth/logout",
      { method: "POST" },
      bindingsWithSessionCookieDomain("example.workers.dev"),
    );

    expect(response.headers.get("Set-Cookie")).toBe(
      "account_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=example.workers.dev; Max-Age=0",
    );
  });
});
