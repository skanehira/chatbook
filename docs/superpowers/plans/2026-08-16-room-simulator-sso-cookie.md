# room-simulator SSO Cookie Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** chatbook と room-simulator が `account_session` を共有し、一方のログイン・ログアウトが同じ `workers.dev` Domain 配下の両アプリへ反映されるようにする。

**Architecture:** HMACトークン形式や認証ガードは変えず、Cookie生成の境界だけへ任意のDomainを追加する。Workerの認証ルートは `SESSION_COOKIE_DOMAIN` をCookie生成へ渡し、ローカルの空値はホスト限定Cookieへ正規化する。room-simulatorの既存契約をそのまま採用し、旧Cookieの互換読み取りは行わない。

**Tech Stack:** TypeScript 7、Hono、Cloudflare Workers、Vite+ / Vitest、Wrangler

## Global Constraints

- Cookie名は `account_session`。
- `AUTH_USERNAME` / `AUTH_PASSWORD` / `AUTH_SESSION_SECRET`、HMAC SHA-256、30日有効期限は変更しない。
- `SESSION_COOKIE_DOMAIN` は任意で、空または未設定なら `Domain` 属性を付けない。
- Cookieの `HttpOnly; Secure; SameSite=Lax; Path=/` 属性は維持する。
- 旧 `chatbook_session` は読み取らない。
- 共通ランチャーUI、共通ログイン画面、OAuth/OIDCは今回実装しない。
- 既存の未コミット `wrangler.jsonc`、`.pnpm-store/`、`AGENTS.md` は変更・ステージしない。
- 生の `vite` / `vitest` は使わず、ローカル `node_modules/.bin/vp` 経由で実行する。

---

### Task 1: Cookie契約を共有名と任意Domainへ変更する

**Files:**

- Modify: `src/server/auth/session.test.ts`
- Modify: `src/server/auth/session.ts`

**Interfaces:**

- Consumes: `SESSION_MAX_AGE_MS` と既存の署名・検証処理。
- Produces: `SESSION_COOKIE = "account_session"`、`sessionCookie(token: string, domain?: string): string`、`clearedSessionCookie(domain?: string): string`。

- [ ] **Step 1: 共有Cookie契約の失敗テストを書く**

`src/server/auth/session.test.ts` の固定文字列を `account_session` へ変更し、Domain省略・指定を次の期待値で追加する。

```ts
expect(sessionCookie("abc.def", undefined)).toBe(
  "account_session=abc.def; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000",
);
expect(sessionCookie("abc.def", "example.workers.dev")).toBe(
  "account_session=abc.def; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=example.workers.dev; Max-Age=2592000",
);
expect(clearedSessionCookie("example.workers.dev")).toBe(
  "account_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=example.workers.dev; Max-Age=0",
);
```

- [ ] **Step 2: REDを確認する**

Run: `node_modules/.bin/vp exec vitest run src/server/auth/session.test.ts`

Expected: Cookie名が `chatbook_session` のままで、関数が第2引数を反映しないため期待値不一致で失敗する。

- [ ] **Step 3: 最小実装を行う**

`src/server/auth/session.ts` を次の契約へ変更する。

```ts
export const SESSION_COOKIE = "account_session";

export function sessionCookie(token: string, domain?: string): string {
  const maxAgeSeconds = Math.floor(SESSION_MAX_AGE_MS / 1000);
  const domainAttribute = domain ? `; Domain=${domain}` : "";
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/${domainAttribute}; Max-Age=${maxAgeSeconds}`;
}

export function clearedSessionCookie(domain?: string): string {
  const domainAttribute = domain ? `; Domain=${domain}` : "";
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/${domainAttribute}; Max-Age=0`;
}
```

Domainが本番だけで有効になる理由を関数コメントへ追記する。

- [ ] **Step 4: GREENを確認する**

Run: `node_modules/.bin/vp exec vitest run src/server/auth/session.test.ts`

Expected: 1ファイルの全テストがPASSする。

---

### Task 2: Worker Bindingsとログイン・ログアウトへDomainを配線する

**Files:**

- Modify: `test/worker/auth.test.ts`
- Modify: `src/server/routes/auth.ts`
- Modify: `src/server/index.ts`

**Interfaces:**

- Consumes: Task 1の `sessionCookie(token, domain?)` と `clearedSessionCookie(domain?)`。
- Produces: `Bindings.SESSION_COOKIE_DOMAIN?: string` と、ログイン・ログアウト応答への任意Domain反映。

- [ ] **Step 1: Worker経由の失敗テストを書く**

既存の固定Cookie名を `account_session` へ変更する。さらに `app.request()` に明示的な共有Domainを渡すログインテストを追加する。

```ts
it("sets the configured shared Domain on the login cookie", async () => {
  const response = await app.request(
    LOGIN,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test-user", password: "test-password" }),
    },
    {
      DB: env.DB,
      PDF_BUCKET: env.PDF_BUCKET,
      LLM_API_KEY: "test-key",
      AUTH_USERNAME: "test-user",
      AUTH_PASSWORD: "test-password",
      AUTH_SESSION_SECRET: env.AUTH_SESSION_SECRET,
      SESSION_COOKIE_DOMAIN: "example.workers.dev",
    },
  );

  expect(response.headers.get("Set-Cookie")).toContain("; Domain=example.workers.dev;");
});
```

既定bindingsのログインテストは属性一覧に `Domain` が無いことを引き続き固定し、ログアウト固定文字列は `account_session=...` へ変更する。

- [ ] **Step 2: REDを確認する**

Run: `node_modules/.bin/vp exec vitest run -c vitest.workers.config.ts test/worker/auth.test.ts`

Expected: `SESSION_COOKIE_DOMAIN` がBindings型に存在せず型検査またはCookie期待値で失敗し、実行時にも共有Domainの期待値が失敗する。

- [ ] **Step 3: Bindingsとルート配線を実装する**

`src/server/routes/auth.ts` と `src/server/index.ts` のBindingsへ次を追加する。

```ts
// Production uses the shared `<account>.workers.dev`; local development leaves it empty.
SESSION_COOKIE_DOMAIN?: string;
```

ログイン・ログアウトのCookie生成を次へ変更する。

```ts
c.header("Set-Cookie", sessionCookie(token, c.env.SESSION_COOKIE_DOMAIN || undefined));
c.header("Set-Cookie", clearedSessionCookie(c.env.SESSION_COOKIE_DOMAIN || undefined));
```

- [ ] **Step 4: GREENを確認する**

Run: `node_modules/.bin/vp exec vitest run -c vitest.workers.config.ts test/worker/auth.test.ts`

Expected: `test/worker/auth.test.ts` の全テストがPASSし、未設定時はDomain無し、設定時は共有Domain有りになる。

---

### Task 3: ローカル設定、生成型、READMEを更新して全体検証する

**Files:**

- Modify: `.dev.vars.example`
- Modify locally but do not commit: `.dev.vars`
- Regenerate: `worker-configuration.d.ts`
- Modify: `README.md`
- Reference: `docs/superpowers/specs/2026-08-16-room-simulator-sso-cookie-design.md`

**Interfaces:**

- Consumes: `SESSION_COOKIE_DOMAIN?: string` のWorker契約。
- Produces: ローカルで空値となる設定例、Wrangler生成型、本番SSO設定手順。

- [ ] **Step 1: ローカル設定例へ空値を追加する**

秘密値をパッチ文脈へ出さず両ファイルのキー順を揃えるため、`.dev.vars.example` とgitignore済みの
`.dev.vars` の共通ヘッダー直後へ次を追加する。既存キー同士の相対順は変えない。

```dotenv
# 本番でroom-simulatorとCookieを共有するときだけ <account>.workers.dev を設定する。
# ローカルは空のままにして、localhostごとのホスト限定Cookieを使う。
SESSION_COOKIE_DOMAIN=
```

- [ ] **Step 2: Wrangler型を再生成する**

Run: `node_modules/.bin/wrangler types && node_modules/.bin/vp fmt worker-configuration.d.ts --write`

Expected: `worker-configuration.d.ts` の `__BaseEnv_Env` と `ProcessEnv` 対象へ `SESSION_COOKIE_DOMAIN` が追加される。`wrangler.jsonc` の既存差分は維持される。

- [ ] **Step 3: READMEへSSO設定と移行挙動を書く**

デプロイのsecret設定へ次を追加する。

```bash
pnpm exec wrangler secret put SESSION_COOKIE_DOMAIN  # room-simulatorと共有する <account>.workers.dev
```

説明には、両Workerで4値を一致させること、ローカル空値はホスト限定だが同じホストの別ポートでは共有されること、一方のログアウトが両アプリへ効くこと、旧Cookieからの切替時に一度再ログインが必要なことを明記する。既存Workerでは新コードのデプロイ前にDomainを設定し、host-only版を発行済みなら設定前にログアウトする。両スコープが共存した場合はブラウザから古いCookieを削除する手順も書く。

- [ ] **Step 4: 全テストと静的検査を実行する**

Run:

```bash
node_modules/.bin/vp exec vitest run
node_modules/.bin/vp exec vitest run -c vitest.workers.config.ts
node_modules/.bin/vp check
node_modules/.bin/vp build
git diff --check
```

Expected: フロント単体53ファイル以上、Worker単体5ファイル以上が全件PASSし、check・build・diff checkがexit 0になる。

- [ ] **Step 5: 要件と差分を最終レビューする**

Run:

```bash
rg -n "chatbook_session|account_session|SESSION_COOKIE_DOMAIN" src test README.md .dev.vars.example worker-configuration.d.ts
git status --short
git diff -- src/server/auth/session.ts src/server/auth/session.test.ts src/server/routes/auth.ts src/server/index.ts test/worker/auth.test.ts .dev.vars.example worker-configuration.d.ts README.md
```

Expected: 実装・テスト・READMEに旧Cookie名が残らず、設計書の移行説明にだけ `chatbook_session` が残る。既存の `wrangler.jsonc`、`.pnpm-store/`、`AGENTS.md` はステージ対象外である。

- [ ] **Step 6: 実装変更だけをコミットしてmainへpushする**

```bash
git add src/server/auth/session.ts src/server/auth/session.test.ts src/server/routes/auth.ts src/server/index.ts test/worker/auth.test.ts .dev.vars.example worker-configuration.d.ts README.md docs/superpowers/plans/2026-08-16-room-simulator-sso-cookie.md
git commit -m "feat: room-simulatorとログインを共有"
git push origin main
```

Expected: `main` の新しいコミットが `origin/main` へ通常pushされ、ユーザーの既存 `wrangler.jsonc` 差分と未追跡ファイルはローカルに残る。
