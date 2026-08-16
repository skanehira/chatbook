# room-simulator SSO Cookie 共有設計

## 目的

chatbook と room-simulator が、同じ Cloudflare アカウントの `workers.dev` 配下で同じログインセッションを共有できるようにする。既存のユーザー名・パスワード認証、HMAC 署名、30 日の有効期限、API の既定拒否は変更しない。

将来、共通ランチャーから複数のサブアプリへ移動する構成を想定し、Cookie 名は特定アプリに依存しない `account_session` とする。ただし今回のスコープは Cookie 共有だけで、ランチャー画面、アプリ一覧、リダイレクト、共通ログイン画面は実装しない。

## 採用する方式

room-simulator の既存実装と同じ Cookie 契約へ chatbook を揃える。

- Cookie 名を `chatbook_session` から `account_session` へ変更する。
- `AUTH_USERNAME`、`AUTH_PASSWORD`、`AUTH_SESSION_SECRET` は両 Worker で同じ値を使う。
- 本番では両 Worker の `SESSION_COOKIE_DOMAIN` に同じ `<account>.workers.dev` を設定する。
- ローカル開発では `SESSION_COOKIE_DOMAIN` を空にし、`Domain` 属性を付けないホスト限定 Cookie を使う。
- 旧 `chatbook_session` は読み取らない。互換経路を増やさず、一度だけ再ログインする明確な切り替えにする。

`SESSION_COOKIE_DOMAIN` を `wrangler.jsonc` の平文 `vars` に固定する方式は採用しない。Cloudflare アカウントごとに値が異なるため、README では `wrangler secret put SESSION_COOKIE_DOMAIN` で設定する手順を案内する。

## サーバー側の変更

`src/server/auth/session.ts` の `SESSION_COOKIE` を `account_session` に変更する。

Cookie 生成関数のインターフェースを次の形にする。

```ts
sessionCookie(token: string, domain?: string): string
clearedSessionCookie(domain?: string): string
```

`domain` が空または未指定なら現在と同じ属性だけを返す。値がある場合だけ `Path=/` の後へ `Domain=<値>` を追加する。ログアウト時にも同じ Domain を付け、共有 Cookie 自体を失効させる。

`src/server/routes/auth.ts` と `src/server/index.ts` の Worker Bindings に `SESSION_COOKIE_DOMAIN?: string` を追加する。ログイン・ログアウトでは `c.env.SESSION_COOKIE_DOMAIN || undefined` を Cookie 生成関数へ渡す。空文字を `undefined` に落とすことで、`.dev.vars` の空値はローカルのホスト限定 Cookie として扱われる。

署名ペイロード、署名アルゴリズム、Cookie の `HttpOnly` / `Secure` / `SameSite=Lax` / `Path=/` / `Max-Age`、セッション検証、公開パス一覧は変更しない。

## 型定義とローカル設定

`.dev.vars.example` に `SESSION_COOKIE_DOMAIN=` を追加する。値は空のままにし、ローカル環境で Domain を共有しない。実際の `.dev.vars` にも空のキーを用意して `vp exec wrangler types` を実行し、`worker-configuration.d.ts` を再生成する。

Worker テストの専用型定義には、必要に応じて `SESSION_COOKIE_DOMAIN?: string` を宣言する。既定の Worker テスト bindings には値を注入せず、ローカル同様に Domain が省略されることを検証する。Domain 付きの経路は純関数の単体テストで直接検証する。

既存の未コミット `wrangler.jsonc` 変更は利用者の作業として保全し、今回の変更対象に含めない。

## テスト方針

テストを先に変更し、現在の実装に対して意図した理由で失敗することを確認してから実装する。

1. セッション単体テスト
   - Cookie 名が `account_session` である。
   - Domain 未指定時は `Domain` 属性が無い。
   - Domain 指定時は `Domain=<値>` が付く。
   - 共有 Domain を指定したログアウト Cookie が同じ Domain の Cookie を失効させる。
2. Worker 認証テスト
   - ログイン応答の Cookie 名が `account_session` である。
   - テスト bindings で Domain 未設定なら `Domain` 属性が無い。
   - ログインで得た Cookie が保護 API を通過する。
   - ログアウト応答がホスト限定の `account_session` を失効させる。
3. 全体検証
   - `pnpm test`
   - `pnpm run test:worker`
   - `vp check`
   - `vp build`

型チェックと lint は `vp check` に含まれる。生成型の差分と `git diff --check` も確認する。

## README の更新

デプロイ手順へ `SESSION_COOKIE_DOMAIN` の設定を追加し、次を説明する。

- room-simulator と SSO するには、両 Worker で `AUTH_USERNAME` / `AUTH_PASSWORD` / `AUTH_SESSION_SECRET` と `SESSION_COOKIE_DOMAIN` を一致させる。
- `SESSION_COOKIE_DOMAIN` の例は `<account>.workers.dev` である。
- ローカルの空値ではホスト限定 Cookie になり、ローカル開発同士では Cookie を共有しない。
- 一方のアプリからログアウトすると共有 Cookie が消えるため、両アプリからログアウトする。
- Cookie 名変更後、既存の `chatbook_session` は使われないため一度再ログインが必要である。

## スコープ外

- 共通ランチャー画面とナビゲーション
- 認証専用 Worker や OAuth/OIDC の導入
- ユーザー・セッション用データベース
- Cookie Domain の入力値検証や自動推測
- 旧 Cookie の移行・二重読み取り
