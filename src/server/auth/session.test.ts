import { describe, it, expect } from "vite-plus/test";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
  clearedSessionCookie,
  issueSession,
  readSessionCookie,
  sessionCookie,
  verifySession,
} from "./session";

const SECRET = "a-secret-only-the-server-knows";
const NOW = Date.parse("2026-08-10T00:00:00.000Z");

describe("issueSession / verifySession", () => {
  it("accepts back the session it just issued", async () => {
    const token = await issueSession(SECRET, NOW);

    expect(await verifySession(token, SECRET, NOW)).toBe(true);
  });

  it("refuses a session signed with another secret, so the token cannot be forged", async () => {
    const token = await issueSession("someone-elses-secret", NOW);

    expect(await verifySession(token, SECRET, NOW)).toBe(false);
  });

  it("refuses a session whose expiry was edited to buy more time", async () => {
    const token = await issueSession(SECRET, NOW);
    const [, signature] = token.split(".");
    const forged = `${NOW + SESSION_MAX_AGE_MS * 10}.${signature}`;

    expect(await verifySession(forged, SECRET, NOW)).toBe(false);
  });

  it("refuses a session once its time is up", async () => {
    const token = await issueSession(SECRET, NOW);

    expect(await verifySession(token, SECRET, NOW + SESSION_MAX_AGE_MS + 1)).toBe(false);
  });

  it("still accepts a session on its last moment", async () => {
    const token = await issueSession(SECRET, NOW);

    expect(await verifySession(token, SECRET, NOW + SESSION_MAX_AGE_MS)).toBe(true);
  });

  it("refuses anything that is not a session at all", async () => {
    expect(await verifySession("", SECRET, NOW)).toBe(false);
    expect(await verifySession("not-a-token", SECRET, NOW)).toBe(false);
    expect(await verifySession(`${NOW}.`, SECRET, NOW)).toBe(false);
  });
});

describe("readSessionCookie", () => {
  it("picks its own cookie out of the ones the browser sent", () => {
    const header = `other=1; ${SESSION_COOKIE}=abc.def; another=2`;

    expect(readSessionCookie(header)).toBe("abc.def");
  });

  it("finds nothing when the browser sent no cookies at all", () => {
    expect(readSessionCookie(null)).toBeNull();
  });

  it("finds nothing when the browser sent other cookies but not this one", () => {
    expect(readSessionCookie("other=1; another=2")).toBeNull();
  });

  it("does not mistake a cookie whose name merely ends the same way", () => {
    expect(readSessionCookie(`not_${SESSION_COOKIE}=abc.def`)).toBeNull();
  });
});

// Whole header rather than the attributes one at a time: the attributes are
// what make the cookie safe to put on the open internet, and a check that only
// looks for the ones it names lets a dropped `Secure` or `HttpOnly` through.
describe("sessionCookie", () => {
  it("hands the token back with the attributes that keep it off the wire and out of scripts", () => {
    // Written out rather than built from `SESSION_COOKIE`: the name is as much
    // a part of what goes on the wire as the attributes are, and a test that
    // asks the implementation for it would follow a rename without a word.
    expect(sessionCookie("abc.def")).toBe(
      "account_session=abc.def; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000",
    );
  });

  it("leaves Domain off when the caller passes none, so local cookies stay host-limited", () => {
    expect(sessionCookie("abc.def", undefined)).toBe(
      "account_session=abc.def; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000",
    );
  });

  it("leaves Domain off for an empty local binding", () => {
    expect(sessionCookie("abc.def", "")).toBe(
      "account_session=abc.def; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000",
    );
  });

  it("adds Domain when the caller passes one, so sibling Workers can share the cookie", () => {
    expect(sessionCookie("abc.def", "example.workers.dev")).toBe(
      "account_session=abc.def; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=example.workers.dev; Max-Age=2592000",
    );
  });
});

describe("clearedSessionCookie", () => {
  it("expires the cookie rather than leaving the browser to forget it", () => {
    expect(clearedSessionCookie()).toBe(
      "account_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
    );
  });

  it("leaves Domain off the cleared cookie for an empty local binding", () => {
    expect(clearedSessionCookie("")).toBe(
      "account_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
    );
  });

  it("expires the shared-domain cookie, so logout applies to sibling Workers too", () => {
    expect(clearedSessionCookie("example.workers.dev")).toBe(
      "account_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=example.workers.dev; Max-Age=0",
    );
  });
});
