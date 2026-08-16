import { Hono } from "hono";
import { loginRequestSchema } from "../../shared/schemas/auth";
import type { ErrorCode } from "../../shared/schemas/error";
import { validate } from "./validation";
import {
  clearedSessionCookie,
  issueSession,
  readSessionCookie,
  sessionCookie,
  verifySession,
} from "../auth/session";

type Env = {
  Bindings: {
    AUTH_USERNAME: string;
    AUTH_PASSWORD: string;
    AUTH_SESSION_SECRET: string;
    // Production sets the shared `<account>.workers.dev`; local development
    // leaves it empty so the session cookie remains host-limited.
    SESSION_COOKIE_DOMAIN?: string;
  };
};

/**
 * Compare without letting the time taken say how much of it matched. The same
 * reasoning as the signature check in `../auth/session.ts`.
 */
function equalsInConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

/**
 * Whether the server has been told what the password is.
 *
 * Deployed without its secrets, this app would otherwise let everyone in. It
 * refuses everyone instead — the first deploy goes out closed on purpose, and
 * the secrets are set against the Worker that is already there.
 */
function credentialsConfigured(env: Env["Bindings"]): boolean {
  return Boolean(env.AUTH_USERNAME && env.AUTH_PASSWORD && env.AUTH_SESSION_SECRET);
}

export const authRoute = new Hono<Env>()
  .post("/auth/login", validate("json", loginRequestSchema), async (c) => {
    if (!credentialsConfigured(c.env)) {
      return c.json(
        {
          error: {
            code: "CONFIG_ERROR" satisfies ErrorCode,
            message: "サーバーにログイン情報が設定されていません",
          },
        },
        500,
      );
    }

    const { username, password } = c.req.valid("json");
    // Both are checked even when the name is already wrong, so a wrong name and
    // a wrong password take the same time to refuse.
    const nameMatches = equalsInConstantTime(username, c.env.AUTH_USERNAME);
    const passwordMatches = equalsInConstantTime(password, c.env.AUTH_PASSWORD);
    if (!nameMatches || !passwordMatches) {
      // One message for both, so a refusal never says which half was right.
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED" satisfies ErrorCode,
            message: "ユーザー名かパスワードが違います",
          },
        },
        401,
      );
    }

    const token = await issueSession(c.env.AUTH_SESSION_SECRET, Date.now());
    c.header("Set-Cookie", sessionCookie(token, c.env.SESSION_COOKIE_DOMAIN || undefined));
    return c.json({ signedIn: true } as const);
  })
  .post("/auth/logout", (c) => {
    c.header("Set-Cookie", clearedSessionCookie(c.env.SESSION_COOKIE_DOMAIN || undefined));
    return c.json({ signedIn: false } as const);
  })
  /**
   * Only reachable through the guard, which has already checked the cookie, so
   * arriving here at all is the answer.
   */
  .get("/auth/session", (c) => c.json({ signedIn: true } as const));

/** The three paths that answer before anyone has signed in. */
const PUBLIC_PATHS = new Set(["/api/health", "/api/auth/login", "/api/auth/logout"]);

/**
 * Everything but the paths above needs the session cookie.
 *
 * Matched whole rather than by prefix: a route added later is protected by
 * default, and only becomes public by being written down here on purpose.
 */
export async function requireSession(
  c: {
    req: { url: string; header: (name: string) => string | undefined };
    env: Env["Bindings"];
    json: (body: unknown, status?: 401) => Response;
  },
  next: () => Promise<void>,
): Promise<Response | void> {
  if (PUBLIC_PATHS.has(new URL(c.req.url).pathname)) return next();

  const token = readSessionCookie(c.req.header("Cookie") ?? null);
  const secret = c.env.AUTH_SESSION_SECRET;
  if (!token || !secret || !(await verifySession(token, secret, Date.now()))) {
    return c.json(
      {
        error: { code: "UNAUTHORIZED" satisfies ErrorCode, message: "ログインしてください" },
      },
      401,
    );
  }

  return next();
}
