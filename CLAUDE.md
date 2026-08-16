# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

技術書を読みながら、気になった箇所を選択して AI に質問できる PDF リーダー。利用者は 1 人。
React 19 (SPA) + Hono (Worker) + D1 + R2 を単一の Cloudflare Workers プロジェクトにまとめ、
`@cloudflare/vite-plugin` で SPA と Worker を同一の `vp dev` で動かす。

**公開先は `https://<worker 名>.<アカウント>.workers.dev`**（`wrangler.jsonc` の `name` と
Cloudflare アカウントのサブドメインで決まる）で、API はログインの内側にある
（下記「ログインとセッション」）。ローカルだけで動かしていた頃の前提（ログイン不要）は
もう成り立たない。

## コマンド

`vp`（Vite+）に統一。生の `vite` / `vitest` は直接叩かない。

```bash
vp dev                    # SPA + Worker を同時起動 (http://localhost:5173)
pnpm run db:migrate:local # D1 マイグレーション適用（初回 / migrations 追加時のみ、自動適用はしない）

pnpm test                 # フロント単体 (jsdom)
pnpm run test:worker      # Worker 単体 (@cloudflare/vitest-pool-workers)
pnpm run test:e2e         # E2E (Playwright)。サーバーは自動起動するので vp dev は不要

vp check                  # フォーマット + lint + 型チェック（--fix で自動修正）
vp exec wrangler types    # wrangler.jsonc の bindings/main 変更後に Env 型を再生成
```

単体テストを1ファイルだけ走らせる: `vp exec vitest run src/front/lib/sseParser.test.ts`
1 つの project だけ走らせる: `pnpm run test:e2e --project=mobile`（`desktop` / `tablet` / `mobile`）
E2E を1件だけ走らせる: `pnpm run test:e2e -g "テスト名の一部"`（`--` を挟むと pnpm が
それをそのまま playwright へ渡し、`-g` が効かないまま全件走る）

`git push` 時に lefthook の `pre-push` が `vp check` + `vp build` を実行し、失敗すると push はブロックされる。

### worktree を作ったら最初に `.dev.vars` を用意する

`.dev.vars` は gitignore 済み（`.gitignore:4`）で **worktree には複製されない**。無いまま
`vp dev`（`pnpm run test:e2e` の自動起動を含む）を動かすと、`@cloudflare/vite-plugin` が
commit 済みの `worker-configuration.d.ts` を再生成し、`LLM_*` の宣言が消えた差分が
毎回出る。worktree を切ったら実装を始める前に用意する:

```bash
cp .dev.vars.example .dev.vars
```

`.dev.vars.example` が実際に読む鍵をそのまま並べてあるので、コピーすればそのまま動く
（`LLM_API_KEY` はダミー、ログインは `demo` / `demo`）。

型の差分は値ではなく鍵の**存在と並び順**で決まるので、ダミー値でも空値でも消える——
`LLM_BASE_URL` / `LLM_MODEL` / `LLM_WEB_SEARCH_SUPPORTED` を値の空いた行で並べてあるのは
そのためで、**使わないときも行を消さず、並べ替えもしないこと**（どちらも型が変わる。
commit 済みの `worker-configuration.d.ts` は `.dev.vars.example` の並びで生成してある）。
現在の E2E は LLM へ
問い合わせないので、実キーが要るのは手で回答の生成を確かめるときだけ。そのときはメインクローンの
`.dev.vars` からコピーする。**チャット送信を E2E に足すなら実キーが要る**——ダミー値では認証が
通らず、トークンが 1 つも届かないまま 60 秒のタイムアウトまで粘って落ちる。

**`AUTH_*` が無いと API は全部 401 になる**ので、`.dev.vars` を用意しないと E2E も画面も
何も動かない（上記「ログインとセッション」の「秘密が無ければ閉じる」）。

### `useEffect` の扱い

`vite.config.ts` の `no-restricted-imports` が `useEffect` の import を禁止している。
このアプリは canvas 描画・DOM 購読・pdf.js の命令的 API が本質なので使う場面が多いが、
ルールは**残したまま**、使う側が import 行に
`// oxlint-disable-next-line no-restricted-imports -- <理由>` を付けて理由を明記する運用にしている。
新しく足すときも同じように理由を書くこと。

現在 12 ファイルに理由コメントがあり、内訳は次の 5 つしかない。新しく足す `useEffect` も
このどれかに当てはまるはずで、当てはまらないなら書き方を疑うこと:

| 用途                                                    | ファイル                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pdf.js という命令的ライブラリの呼び出しと後始末         | `PdfPage.tsx`（`RenderTask` / `TextLayer`）、`usePdfDocument.ts`（バイナリ取得とドキュメント構築）、`usePdfOutline.ts`（`getOutline` と dest 解決）、`usePageBaseSize.ts`（`getViewport({scale: 1})` でページの素の寸法） |
| `document` / `window` / `ResizeObserver` の購読         | `useKeyboardShortcuts.ts`、`SettingsMenu.tsx`、`SelectionPopover.tsx`、`PdfViewer.tsx`、`useSettledSelection.ts`（`document` の `selectionchange` と `window` の pointer 系）                                             |
| 非 passive なジェスチャの購読（ブラウザの既定を止める） | `PdfViewer.tsx`（ctrlKey wheel のピンチ、touch と Safari の gesture イベント）                                                                                                                                            |
| DOM への命令的な書き込み（スクロール位置）              | `ChatMessageList.tsx`（最下部へ追随）、`PdfViewer.tsx`（ページ遷移時のリセット）                                                                                                                                          |
| URL とサーバという React の外の状態への同期             | `useReadingLocation.ts`、`useReadingStateSync.ts`（読書位置の保存と離脱時の書き残し）                                                                                                                                     |

**画面幅の購読には `useEffect` を使わない**。`useIsNarrow`（`src/front/hooks/useIsNarrow.ts`）が
`useSyncExternalStore` で `matchMedia` を購読する。購読するのは幅そのものではなく
メディアクエリの真偽なので、再レンダーはレイアウトが切り替わるときだけ起きる。

**データ取得は理由にならない**。一覧・本・ハイライト・引用箇所のページ解決は SWR へ
移してある（下記「状態管理とルーティング」）。

**SWR が持っているものを atom へ写すのも理由にならない**。写した瞬間に同じデータが
2 箇所に載り、更新のたびに 1 レンダー遅れる。読み手が少ないなら props で配る
（`AppPage` → `PdfViewer` / `ChatArea` の `book` がその形）。

これと紛らわしいものが 3 つある。どれも `useReadingLocation.ts` で、SWR が解いた値を
atom に一度だけ書く——`useSWRImmutable` が解いた「引用箇所のページ番号」を
`currentPageAtom` に、`useBook` が返した本の中から URL の `?selection=` が名指した
ハイライトを `activeSelectionAtom` に（`openChat` 経由。下記「リーダーの URL は
`useReadingLocation` が単独で書く」）、同じく `useBook` が返した本の `readingState` を
`currentPageAtom` / `activeSelectionAtom` / `outlineOpenAtom` / `chatPanelOpenAtom` に
（下記「読んでいた場所は本と一緒に運ぶ」）。これは写しではない: どの atom も「読者が今どこを
見ているか」というクライアント状態で、キーボード・ページ送りボタン・目次・URL・一覧の
クリックも書き込む。取得結果はその状態を**一度だけ動かすきっかけ**であって、サーバのデータを
atom に常駐させているわけではない。
**サーバの値がそのまま atom に載り続けるなら写し（禁止）、一度きりの入力なら可**。

## アーキテクチャ

### ログインとセッション

インターネットに出しているので、`/api/*` は**既定で閉じている**。素通しするのは
`/api/health` と `/api/auth/login` と `/api/auth/logout` の 3 つだけで、
`src/server/routes/auth.ts` の `requireSession` が**完全一致で**列挙する。前方一致にしないのは、
あとから足したパスが偶然素通りしないようにするため。middleware は
`src/server/index.ts` で全ルートより先に登録してあるので、新しいルートは黙って守られる。

**利用者が 1 人なので、D1 に所有者の列は無い**。「ログインした人＝全データの持ち主」で
正しい。アカウントを増やすときに初めて `schema.ts` とマイグレーションと全クエリに波及する。

| 何を                                        | どこに                                                 |
| ------------------------------------------- | ------------------------------------------------------ |
| セッションの署名・検証・Cookie の組み立て   | `src/server/auth/session.ts`（純関数。単体テストあり） |
| ログイン・ログアウト・在籍確認と middleware | `src/server/routes/auth.ts`                            |
| front と server が交わす形                  | `src/shared/schemas/auth.ts`                           |
| 画面側のゲートとパスワード入力              | `src/front/components/RequireSession.tsx`              |
| 在籍を確かめるフック                        | `src/front/hooks/useSession.ts`                        |

**セッションは HMAC で署名した Cookie 1 本**（`chatbook_session`、30 日）。中身は失効時刻
だけで、誰であるかを持たない。**署名を先に検証してから失効を読む**ので、失効時刻を書き換えた
トークンは長いセッションではなく偽物として落ちる。D1 にテーブルは無い。

**Cookie には `Secure` を付ける**。公開する以上、平文で運ばれるセッションは平文で運ばれる
パスワードと同じであるため。代償として**LAN の `http://192.168.x.x:5173` ではログインできない**
（ブラウザが Cookie を保存しない）。スマホからは公開 URL を使う。`localhost` は安全な
オリジンとして扱われるので、ローカル開発と E2E は影響を受けない。

**秘密が設定されていなければ全部閉じる**。`AUTH_USERNAME` / `AUTH_PASSWORD` /
`AUTH_SESSION_SECRET` のどれかが空だと、ログインは 500 (`CONFIG_ERROR`)、保護対象は 401 の
まま。設定を忘れたまま公開してしまう事故を防ぐためで、**初回のデプロイは意図的に閉じた状態で
出す**（下記「デプロイ」）。

画面側は `/login` へ飛ばさず、`RequireSession` がその場でパスワードを聞く。読者の居場所は
アドレスに載っている（`?page=` / `?selection=`）ので、別ルートへ送ると
戻り先を持ち回る仕掛けが要る。**401 とそれ以外は区別する**——401 はサーバーが「まだログインして
いない」と言っているのでパスワードを聞き、それ以外（回線断・500）は「確かめられなかった」
と出す。後者でパスワードを聞くと、読者のせいでないことを読者のせいにしてしまう。

**端末を失くしたときの取り消し手段は `AUTH_SESSION_SECRET` の入れ替え 1 つだけ**。
セッションは stateless なので個別には失効させられず、入れ替えると自分の端末も含めて
全部ログアウトになる。

### デプロイ

```bash
pnpm run deploy   # vp build してから wrangler deploy
```

`wrangler.jsonc` の `database_id` には作者の環境の D1（`chatbook-db`。R2 は
`chatbook-pdfs`）の実 ID が入っている。**fork したら README の「デプロイ」の手順で
自分の値に置き換える**（D1 の ID はアカウントの API トークンが無ければ使えないので
秘密ではないが、そのままでは他人のデータベースを指す）。
**マイグレーションを足したらリモートにも当てる。順番は
デプロイより先**——列を足したマイグレーションが当たっていない D1 に新しいコードを載せると、
本を開く経路ごと 500 になる（理由は下記「読んでいた場所は本と一緒に運ぶ」）:

```bash
vp build   # dist/chatbook/wrangler.json を作り直す。これを飛ばすと古い設定が読まれる
vp exec wrangler d1 migrations apply chatbook-db --remote
```

秘密は 4 つ、`wrangler secret put <名前>` で入れる（`.dev.vars` はローカル専用でデプロイには
乗らない）: `LLM_API_KEY` / `AUTH_USERNAME` / `AUTH_PASSWORD` / `AUTH_SESSION_SECRET`。
接続先とモデル（`LLM_BASE_URL` / `LLM_MODEL` / `LLM_WEB_SEARCH_SUPPORTED`）は秘密ではないので、
**DeepSeek 以外に向けるときだけ** `wrangler.jsonc` の `vars` に書く（省略すれば DeepSeek。
下記「LLM の呼び分け」）。**キーを `vars` に書かないこと**——あのファイルは git に入る。
`DEEPSEEK_API_KEY` から移ってきたデプロイは、同じ鍵を `LLM_API_KEY` として入れ直す必要がある。
**Worker がまだ無い状態の `secret put` は対話プロンプトを出す**ので、順番は
「デプロイ → secret put」。`secret put` は既存 Worker に新しいバージョンを自動で配るので、
入れ終わったあとの再デプロイは要らない。

鍵がかかっていることの確認は、公開 URL に対する 401 が唯一の証拠:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<worker 名>.<アカウント>.workers.dev/api/pdfs  # 401
```

### PDF の処理はブラウザ側で行う（重要）

pdf.js は workerd 上で動かない（native canvas を要求して落ちる）。そのため:

- **テキスト抽出・表紙生成・描画はすべてクライアント**（`src/front/lib/pdfLoader.ts`）
- クライアントが抽出済みの `fullText` / `pageCount` / 表紙 webp を **multipart** で
  `POST /api/pdf/open` に送り、Worker は保存だけを担う

サーバ側で PDF を解析しようとしないこと。

### ストレージの分担

| 置き場所          | 内容                                                          |
| ----------------- | ------------------------------------------------------------- |
| D1 (`DB`)         | `pdfs` / `selections` / `chat_messages` のメタデータ          |
| R2 (`PDF_BUCKET`) | PDF 本体 `pdfs/<sha256>.pdf`、表紙 `thumbnails/<sha256>.webp` |

同一性は **内容の SHA-256** で判定する。同じ本を開き直すと同じ `pdfs.id` を返しつつ、
`fileName` / `fullText` / `pageCount` を最新の抽出結果で**上書き**する
(`src/server/services/pdfService.ts` の `openPdf`)。ここを「既存レコードをそのまま返す」に
戻すと、古いメタデータが残り続ける不具合になる。

#### 本を開くまでの往復を増やさない

実測（209 ページ・2.3MB の実書籍）で分かった要点が 3 つある。本番では各段が往復
コストを払うので、**直列に足したものがそのまま待ち時間になる**。

- **`GET /pdf/:pdfId/file` はブラウザに持たせる**。本は自身のバイト列のハッシュで保存
  されるので、ある id が指す中身は変わらない。`Cache-Control: private, max-age=31536000,
immutable` と R2 の `httpEtag` を返し、`If-None-Match` は `onlyIf` で R2 に渡して 304 に
  する。**ヘッダをこちらで突き合わせてはいけない**——オブジェクトの取得自体は起きてしまう。
  `private` なのはセッションの内側にあるため（共有キャッシュに載ると次に尋ねた人へ本が渡る）
- **PDF バイナリの取得は本（`GET /pdf/:pdfId`）を待たない**。id は読者がたどったアドレスに
  載っているので、`usePdfDocument(pdfId, book)` は id だけで download を始め、`book` は表紙
  を作る要否にしか使わない。ここを `book` 待ちに戻すと、D1 を 2 回とハイライトと R2 の head
  を経る往復ぶん、download の開始が遅れる
- **応答に使わない列を select しない**。`/file` が要るのは `filePath` と `fileName` だけで、
  行ごと引くと `full_text`（実書籍で 213KB）まで D1 から読む。`readPdf` のハイライトと表紙の
  head は互いに独立なので `Promise.all` で並べる

**効かなかったもの**: `pdf.worker`（gzip 486KB）の先読み。`modulepreload` は destination が
script なので worker が同じファイルをもう一度落とし、`rel="preload" as="worker"` は Chromium
が認識せず preload 自体が発生しない。**計測して両方とも取り下げた**ので、同じことを試す前に
ここを読むこと。

### 外部入力のバリデーション（zod）

front と server が交わす形は `src/shared/schemas/` に zod スキーマとして 1 箇所だけ置き、
型は `z.infer` で導出する（`error.ts` / `book.ts` / `config.ts` / `selection.ts` / `citation.ts` /
`chat.ts` / `sse.ts`）。front・server どちらにも同じ概念の型を書かないこと。

- **サーバの受け口**は `src/server/routes/validation.ts` の `validate(target, schema)`
  （`@hono/zod-validator` のラッパ）を通す。素の `zValidator` は zod のレポートをそのまま
  400 で返すため、クライアントが読む `error.message` を持たない。`validate` は
  `{ error: { code: "VALIDATION_ERROR", message: "Invalid request body: pageNumber" } }`
  の形に揃える。メッセージは zod の文言ではなく違反フィールドのパスなので、zod の更新で
  変わらない
- **クライアントの受け口**は `src/front/lib/fetcher.ts` の `fetcher(url, schema, init?, fetchFn?)`。
  `schema.safeParse` を通った値だけを返す。**レスポンスが返ったあとの失敗 2 系統**——サーバが
  拒否した（`error.code` を載せる。取れないときは `"UNKNOWN"`）と、レスポンスがスキーマに
  合わない（`"INVALID_RESPONSE"`）——を `ApiError`（`message` / `code` / `status` / `kind`）に
  揃えて throw する。`fetch` 自体が reject するネットワーク断・abort はここでは包まず、
  `TypeError` / `AbortError` がそのまま呼び出し側へ伝わる（包む版は下記 `resultFetcher`）
- **`src/server/services/chatService.ts` の `LlmMessage`** は LLM 送信用で `system` role を
  含み、保存される `ChatMessage`（`src/shared/schemas/chat.ts`）とは別物。shared に混ぜないこと

エラー形式は 2 系統あり、**ペイロード `{ code, message }` だけを共通化して transport の差は
残している**。ストリーム開始前は HTTP ステータス + `{ error: { code, message } }`、開始後は
`event: error` + 裸の `{ code, message }`。SSE ではイベント名が判別子なので `error` で包む
意味がない。ワイヤ上の `code` は前方互換のため `z.string()` で受け（読み手は知らない code を
渡す以外にできることがない）、サーバ側の構築だけ `shared/schemas/error.ts` の `ErrorCode`
union + `satisfies` で固定する。

### 失敗の運び方（neverthrow）

**失敗はユーザーに見える形にするか、握りつぶす理由をコメントに書くかのどちらかにする。**
`console.error` だけで済ませない（それは前者でも後者でもない）。

- **D1 / R2 に触る service は `ResultAsync`**（現状 `pdfService.ts` の 6 関数）。エラー型は
  `src/server/services/serviceError.ts` の
  `ServiceError = { type: "NOT_FOUND" } | { type: "STORAGE"; cause }` の 2 つだけで、
  `notFound()` / `storageFailure(cause)` が作る。route が `.match()` で封筒に落とす
  （`src/server/routes/pdf.ts` の `serviceFailureResponse` が 404、`storageFailureResponse`
  が 500 を組み立てる。**名前が似ているが、`storageFailure` は service が返す値、
  `storageFailureResponse` は route が返すレスポンス**）。「無い」は各エンドポイントの言葉で
  404、「ストアが応答しない」は一律 `INTERNAL_ERROR` の 500 で、`cause` はサーバのログにだけ
  出す。バインディングに触らない service（`chatService.ts` は純粋関数、`llmService.ts`
  は throw + callbacks でストリームを運ぶ）はこの対象外
- **想定外の throw と未定義パスは `src/server/index.ts` の `app.onError` / `notFound` が拾う**
  （それぞれ `INTERNAL_ERROR` / `ROUTE_NOT_FOUND`。どちらも `shared/schemas/error.ts` の
  `ERROR_CODES` に載っており、`index.ts` が `satisfies ErrorCode` で固定して唯一発行する）。
  Hono の既定は `text/plain` の "Internal Server Error" を返し、これは封筒ではないので
  `fetcher` からは `UNKNOWN` にしか見えない。`/api/*` だけが Worker に来る
  （`wrangler.jsonc` の `run_worker_first`）ので、`notFound` が SPA の直リンクを奪うことはない
- **フロントの読み取り（SWR）は throw ベースの `fetcher` のまま**。SWR の `error` state が
  その境界の Result そのもので、`Err` に変換して戻すのは往復の無駄
- **失敗を画面に出す mutation とイベントハンドラ起点の 1 回きりの取得は `resultFetcher`**
  （`ResultAsync<T, ApiError>`）。受け皿になる SWR が無いので、失敗は値で返さないと消える。
  現在の該当箇所は本の削除（`ShelfPage`）・アップロード（`FileSelector`）・ハイライトの作成
  （`useAskAboutSelection`）・ハイライトの削除（`useHighlights`）・チャット履歴の取得
  （`AppPage`）・読書位置の保存（`useReadingStateSync`）・ログイン（`RequireSession`）・
  ログアウト（`SettingsMenu`）の 8 つ。
  **例外は `usePdfDocument.ts` の `storeCoverIfMissing`** で、これは失敗を出さないと決めた
  書き込み（下記「意図的に握りつぶす」）なので `fetcher` + try/catch のままでよい
- **`ApiError` の `kind`** は `http`（サーバが拒否した）/ `parse`（返ってきた形が違う）/
  `network`（応答が無い）。`parse` は `fetcher` も立てるので throw 経路にも現れる。
  `network` だけは `resultFetcher` でしか作られない（`fetcher` は fetch の reject を包まない）。
  クライアント固有の `code` は `fetcher.ts` の `CLIENT_ERROR_CODES` に集約してあり
  （`UNKNOWN` / `INVALID_RESPONSE` / `NETWORK_ERROR` / `ABORTED`）、**リテラルで書かないこと**——
  `ApiError.code` は `string` なので typo しても型で落ちない
- **レンダー中の throw は Result では拾えない**ので、`src/front/routes.tsx` が両ルートに
  `errorElement`（`src/front/components/RouteErrorBoundary.tsx`）を張る

**表示する文言は、それを描くコンポーネントが組み立てる。**フックは理由（サーバや例外の
`message`）だけを返す——`usePdfDocument` / `usePdfOutline` / `useAskAboutSelection` /
`useReadingStateSync` / `PdfPage` の `onError` はすべてこの形で、前置きは `PdfViewer` /
`PdfOutline` / `AppPage` が付ける。
**例外は `chatErrorAtom` ただ 1 つ**で、書き手が複数（送信の失敗と履歴の取得失敗）・読み手が
1 つ（`ChatArea`）なので、完成した文を atom が持つ。

失敗の受け皿と表示場所は次のとおり。新しい失敗を足すときはこの表のどれかに合流させる:

| 失敗                              | 受け皿                                                | 出る場所                                                                         |
| --------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| 本棚の読み込み・削除・追加        | `ShelfPage` の `actionError` と SWR の `error`        | 本棚上部の赤い枠                                                                 |
| 本の読み込み                      | `useBook` の `error` → `bookError` prop               | ビューア中央とチャットパネル                                                     |
| PDF バイナリの取得・pdf.js の構築 | `usePdfDocument` の `error`                           | ビューア中央                                                                     |
| ページの描画                      | `PdfPage` の `onError` → `PdfViewer` の `renderError` | ビューア上部（ページを移ると消える）                                             |
| 目次の取得                        | `usePdfOutline` の `error`                            | 目次パネル                                                                       |
| ハイライトの保存                  | `useAskAboutSelection` の `saveError`                 | ビューア上部（ポップオーバーは開いたまま。狭い画面では質問の入力欄が開いたまま） |
| ハイライトの削除                  | `HighlightListPanel` の `actionError`                 | ハイライト一覧の検索行の下（次の削除で消える。下記の例外あり）                   |
| ハイライトの検索                  | `useHighlightSearch` の `searchError`                 | 同じ枠。削除の失敗が出ている間はそちらが優先される                               |
| チャットの送信・履歴の取得        | `chatErrorAtom`                                       | チャットパネル（狭い画面ではシート）                                             |
| リンク先の passage が見つからない | `useReadingLocation` の `passageMiss`                 | ヘッダ直下の帯                                                                   |
| 読書位置の保存                    | `useReadingStateSync` の `saveError`                  | ヘッダ直下の帯                                                                   |

`chatErrorAtom` だけ二重の口がある。**atom が表示の正、`sendMessage` の戻り値
（`ResultAsync<string, ApiError>`。成功時の値は保存された回答の id）は呼び出し元の
フロー制御用**という分担で、戻り値を捨てた呼び出し元があっても画面が無言にならないように
してある。新しい送信の開始と、別のハイライトを開いたときにクリアする。

#### 意図的に握りつぶす

次の 10 行は失敗を画面に出さない（`HighlightListPanel.tsx` の行だけは、出す場所が残って
いれば出す）。いずれも理由をコメントに書いてあり、**理由を書かずに握りつぶしを増やさない
こと**:

| 箇所                                                         | 握りつぶす理由                                                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `pdfLoader.ts` の表紙生成 / `usePdfDocument.ts` の後追い保存 | 表紙は装飾。本棚がタイトルで代替する                                                                             |
| `sseParser.ts` / `llmService.ts` の断片パース                | ストリームの 1 ブロックが壊れても残りは使える                                                                    |
| `routes/pdf.ts` のクライアント切断後の送信                   | throw を通すと回答の保存に届かない                                                                               |
| `pdfService.ts` の `readPositionData`                        | 壊れた 1 行で本ごと開けなくしない（下記「`positionData` の正準形」）                                             |
| `chatService.ts` の `readCitations`                          | 出典が読めなくても回答そのものは見せる                                                                           |
| `textFragment.ts` のリンク解析                               | 解析できない = passage へのリンクではない、という正常系                                                          |
| `usePdfOutline.ts` の `resolvePageNumber`                    | dest が解けない 1 項目はページ無しで並べ、残りは使える                                                           |
| `useReadingStateSync.ts` の離脱時の flush                    | 送る先の画面がもう無い（本棚へ戻る・タブを閉じる）                                                               |
| `HighlightListPanel.tsx` の削除失敗（一覧を離れていたとき）  | 出す場所がもう無い（チャットを開くと一覧ごと畳まれる）。消えなかったハイライトはそこに在るので、戻れば試し直せる |
| `useServerConfig.ts` の取得失敗                              | Web 検索は「あり」と仮定して進む。送ってもサーバが落とす                                                         |

**報告しないためではなく報告する主体が別**という catch が 2 つある。`SelectionPopover` の
`onSubmit` を囲むもの（質問の失敗は `useAskAboutSelection` が受け持つ。ここで再 throw すると
イベントハンドラの外へ抜け、`errorElement` にも届かない）と、`usePageBaseSize` の
`getPage` を囲むもの（同じページを `PdfPage` も開こうとしていて、描けない理由はそちらが
読者に伝える。最後に分かっていた寸法を保つので、通りすがりにレイアウトが畳まれない）。

#### `positionData` の正準形

ハイライトの座標は `{ rects, pageWidth? }` が正準形で、**未知のキーは strip する**。

- 書き込み（`POST /api/pdf/:pdfId/selections`）は `validate("json", ...)` で厳格に検証する。
  ビューアは計測結果（`startIndex` / `endIndex` / `pageNumber` も持つ）を丸ごと送ってくるが、
  保存されるのは正準形だけ
- 読み出し（`pdfService.ts` の `readPositionData`）は `safeParse` + `{ rects: [] }`
  フォールバック。**ここを strict にすると正準形でない既存行のある本が開けなくなる**。
  JSON として壊れた行 1 件で本ごと 500 にしないためでもある

### pdf.js のランタイムアセット

`scripts/copy-pdfjs-assets.mjs`（`postinstall` で実行）が `cmaps` と `standard_fonts` を
`public/pdfjs/` に複製する。`src/front/lib/pdfjsConfig.ts` の `PDFJS_ASSET_OPTIONS` で
`cMapUrl` / `standardFontDataUrl` を渡す。

**`cMapUrl` が欠けると、出版された日本語 PDF が白紙になる**——CID-keyed フォントを描くには
CMap テーブルが要る。これを守っているのは E2E 1 本だけで（下記「E2E の前提」の
`cid-font-book.pdf`）、グリフを埋め込んだ PDF では再現しないので、cMap 周りに触ったら
そのテストを走らせること。
**`standardFontDataUrl`（埋め込まれていない標準 14 フォント）を守るテストは今のところ無い**。
ブラウザは黙ってシステムフォントに落とすため、自動で検出する手立てがない。

`src/index.css` の `.hiddenCanvasElement { display: none }` も必須。pdf.js が `<body>` に足す
計測用 canvas が既定の 300×150 でレイアウトに参加し、ページ下部に空白が出る。

### テキスト選択とハイライト

**この機能に手を入れる前に `docs/PDF_TEXT_SELECTION.md` を読むこと。** 選択位置のズレ・選択範囲の
暴走・ハイライトの欠けは、いずれも見た目では気付きにくく、原因も pdf.js の CSS 契約や DOM 順序と
いった非自明な箇所にある。実装の勘所と検証方法をそこにまとめてある。

以下は特に壊しやすい点の要約:

- テキストレイヤーは pdf.js 公式の `TextLayer` を使う（`src/front/components/PdfViewer/PdfPage.tsx`）。
  自前で span を並べると座標変換を誤って選択位置がずれる
- `src/index.css` の `.textLayer` は pdf.js 公式 CSS の移植。`--font-height` / `--scale-x` を
  `font-size` と `transform` に変換する定義を削ると、span が本文より狭くなり選択範囲がずれる
- `endOfContent` とその移動処理（`src/front/lib/textLayerSelectionGuard.ts`）が無いと、
  行末を越えたドラッグがページ全体を選択する
- 同じ canvas への並行 `render()` は pdf.js が例外を投げる。StrictMode の二重実行に備えて
  `RenderTask` を保持し再実行前に `cancel()` する
- `HighlightOverlay` はテキストレイヤーより上（`z-10`）に置きつつ、コンテナは
  `pointer-events-none`、ハイライト自身だけ `pointer-events-auto` にする。
  コンテナが pointer events を受け取るとページ全面が覆われ、選択が一切できなくなる
- 選択矩形はスクロールコンテナではなく**ページ要素**基準で保存する

**ページ要素とは `data-page-container` を持つ箱**（`PdfViewer.tsx`）で、1 ページ分の canvas・
テキストレイヤー・`HighlightOverlay`・ポップオーバーがそこに同居する。見開きではこれが 2 つ
並ぶので、**どのページで測るかは現在ページから決めつけず DOM から引く**——選択は
`selection.anchorNode`（読者が押し下げた側。範囲は常に文書順なので、右から左へのドラッグでは
`startContainer` が別のページになる）から、引用箇所の印は引用が名指したページ番号から
`data-page-container` を辿る。

**2 ページにまたがったドラッグは、押し下げたページの分だけを取る**
（`selectionRects.ts` の `rangeWithinPage` が範囲をそのページのテキストレイヤーで切り、
`pdfTextMatcher.getSelectionFromTextLayer` はその切った `Range` を受け取る）。矩形は 1 ページの
ピクセルで保存されるので、2 ページ目の分は行き場がない——切らずに測るとページの外まで伸びた
矩形がそのまま保存される。E2E の「keeps a drag that runs on to the next page…」が守る。

### チャットのストリーミング

`POST /api/pdf/:pdfId/selections/:selId/chats` が SSE を返す。イベントは
`token` / `citation` / `done` / `error`。

- クライアントは `src/front/lib/sseParser.ts` の `createSseParser` で読む。
  SSE は**空行がブロック境界**で、`event:` は同じブロックの `data:` と対にする。
  バッファ全体から `data:` を検索すると同時到着したイベントが混線する
- `createSseParser` が返すのは `{ event, data: unknown }` まで。そのあと
  `src/front/hooks/useChatStream.ts` が `src/shared/schemas/sse.ts` の
  `chatSseEventSchema`（4 イベントの discriminated union）で `safeParse` し、通ったものだけ
  扱う。**キャストで済ませないこと**——未知の種別の出典が `CitationBadge` の描画に届く
- 送信は **必ず `useChatStream` の `sendMessage` を通す**。ポップオーバーからの初回質問も
  `useAskAboutSelection` 経由でここに来る。生 `fetch` にすると質問文の即時表示と
  「考え中…」が出なくなる
- **回答を保存できなかったときは `done` ではなく `event: error`（`CHAT_SAVE_FAILED`）を送る**。
  保存前に `done` を送ると、画面には回答が出そろっているのにリロードで消える。
  ここを `.catch(console.error)` に戻さないこと
- **`CHAT_SAVE_FAILED` だけは回答を画面に残す**。他の `event: error` は生成が途中で切れた
  ことを意味するので断片を捨てるが、これは回答が完成したうえで書き込みだけが落ちた場合で、
  消すと読むこともコピーすることもできなくなる（生成コストは既に払っている）。
  `useChatStream` がこのコードで分岐し、`chatFailureMessage` も「取得に失敗」ではなく
  「保存できませんでした」と言い換える
- ポップオーバーからの初回質問は**保存された回答を待たない**。`sendMessage` の完了を待つと
  ポップオーバーが 10 秒前後ページを覆う。閉じる合図はハイライトの保存が成功したこと
  （`useAskAboutSelection`）で、ストリーム自体の失敗は `chatErrorAtom` が受ける
- **ポップオーバーは保存が終わるまで開いたままなので、送信中フラグが要る**
  （`SelectionPopover` の `asking`）。無いと 2 回目の送信がハイライトを二重に作り、
  2 本目の回答が 1 本目を `abortChatStream` で殺す。`onSubmit` を await する型なのはこのため

### LLM の呼び分け

`src/server/services/llmService.ts`。**OpenAI 互換の API であることだけが前提**で、
プロバイダごとの差を吸収する層は持たない（あるのは下記の Web 検索の可否 1 つだけ）。

| モード      | エンドポイント                                                              |
| ----------- | --------------------------------------------------------------------------- |
| 通常        | `<LLM_BASE_URL>/chat/completions`（OpenAI SDK 経由）                        |
| Web 検索 ON | `<LLM_BASE_URL>/responses` に `tools: [{ type: "web_search" }]`（生 fetch） |

`/v1` を含めるかはプロバイダの流儀次第（既定の DeepSeek は付けない）。**`LLM_BASE_URL` に
末尾スラッシュを付けると Web 検索だけが壊れる**——通常モードは SDK が正規化するが、
あちらは文字列連結なので `//responses` になる。

**接続先・モデル・Web 検索の可否は env で決まり、解決するのは `resolveLlmConfig` 1 箇所**
（既定値もそこが持つ。**値の正はここで、docs の表は写し**）。`wrangler.jsonc` の `vars` は
既定では空で、**別のプロバイダに向けるときだけ書く**——**キーしか設定していないデプロイは
DeepSeek に向く**。`vars` を足すと `worker-configuration.d.ts` が変わるので、
`vp exec wrangler types` で再生成して commit する。

| 変数                       | 空 / 未設定のとき                                          |
| -------------------------- | ---------------------------------------------------------- |
| `LLM_API_KEY`              | チャットが 500（`CONFIG_ERROR` / `"LLM_API_KEY not set"`） |
| `LLM_BASE_URL`             | `https://api.deepseek.com`                                 |
| `LLM_MODEL`                | `deepseek-v4-flash`                                        |
| `LLM_WEB_SEARCH_SUPPORTED` | 対応しているものとして扱う（`"false"` / `"0"` だけが否定） |

**Web 検索の可否はプロバイダの性質であって読者の設定ではない。** 読者のトグル
（`useWebSearchAtom`、既定 ON）は localStorage にあるので、プロバイダを替えても消えない。
そのため**サーバが最終決定する**——`routes/pdf.ts` が `readerWantsWebSearch &&
llmConfig.webSearchSupported` を `buildSystemPrompt` より前で解いており、プロンプトの
「document only」指示と実際に叩くエンドポイントが食い違うことはない。
**画面側は `GET /api/config`（`src/server/routes/config.ts`。返す形は
`src/shared/schemas/config.ts` の `webSearchAvailable` 1 つだけ）を見て設定メニューから
トグルごと消す**（`src/front/hooks/useServerConfig.ts` → `SettingsMenu`）。効かないトグルを
見せないためのもので、送信を止めているのはサーバ側。**`ChatArea` / `PdfViewer` は生の atom 値を
送ったままでよい**——決定者を 2 箇所にしないため。**このエンドポイントも `requireSession` の
内側**なので、curl で確かめるならログインの Cookie が要る。

`useServerConfig` は**答えが来るまでとエラー時は「対応あり」を返す**。無いと仮定すると、
メニューを開いた読者の前でトグルが遅れて生えることになる。サーバが強制するので外れても害はない。
SWR なので、**設定を変えたあとの反映は開いているタブをリロードしてから**見る
（`revalidateOnFocus` は切ってある）。

**usage のキャッシュ計上だけはプロバイダで形が違う**。通常モードは DeepSeek 独自の
`prompt_cache_hit_tokens`、Web 検索モードは `input_tokens_details.cached_tokens` を読み、
どちらも `StreamUsage.cachedInputTokens` に正規化する。どちらも optional なので、報告しない
プロバイダでは 0 になるだけで落ちない。行き先は `routes/pdf.ts` の `onDone` が書く D1 の
`chat_messages.cached_input_tokens` で、**画面には出ない**（あとから費用を見るための列）。

出典は system prompt で `## Sources` セクションを書かせ、`parseCitations` が抽出する。
PDF 引用は `fullText` 内の位置からページ番号を割り出してジャンプ可能にしている。

ページ解決は `src/server/services/chatService.ts` の `findPageNumber` が行い、
`src/shared/schemas/book.ts` の `LocatedPage`（`{found: true, pageNumber}` か
`{found: false, miss}`）を返す。**見つからない理由を潰さないこと**——`miss` は
`no-quote`（引用文が空）/ `not-in-book`（本文に無い）/ `single-page-book`（1 ページの本）の
3 つで、読者に伝える内容がそれぞれ違う。とくに `not-in-book` は、**AI が引用を本文どおりに
書かなかった可能性**を読者が知る唯一の手がかりになる。消費者は 2 つ:

- `GET /pdf/:pdfId/locate` がそのまま返し、`useReadingLocation` の `passageMiss`
  （lookup 自体が失敗した `lookup-failed` を加えた 4 値）を経て `AppPage` の
  `PASSAGE_MISS_MESSAGE` が文言にする
- `parseCitations` が `pageMiss` として引用に載せ、`CitationBadge` の `PAGE_MISS_TITLE` が
  title にする。**引用は JSON で保存される**ため、`pageMiss` は discriminated union ではなく
  任意フィールドにしてある（この列が無い既存の行も読めるようにするため）

なお 200 ページ級の本では全文をコンテキストに載せるため、最初のトークンまで
**10 秒前後** かかる。
ストリーミングが壊れているのと区別すること（`read()` が複数回に分かれるかで判別できる）。

### 状態管理とルーティング

**画面に出しっぱなしにするサーバのデータは SWR、クライアントだけの状態は Jotai の atom**
（`src/front/atoms/`）。両方に同じものを載せないこと。

- `/` … 本棚（`ShelfPage`）。一覧は `useSWR("/api/pdfs")`
- `/books/:pdfId` … リーダー（`AppPage`）。本は `useBook(pdfId)` で読むので
  リロード・直リンクでも開ける。読んだ本は `PdfViewer` / `ChatArea` へ **props で**
  渡す（atom に写さない。読み手はこの 2 つだけなので prop drilling にならない）
- どちらのルートにも `errorElement` が付く（上記「失敗の運び方（neverthrow）」）

#### 狭い画面のリーダーは 1 カラム

リーダーは幅で 2 つの姿を持つ。**境界の数値を持つのは `src/front/lib/viewport.ts` だけ**
（`NARROW_MAX_WIDTH = 767`px と、そこから作る `NARROW_QUERY`。Tailwind の `md` の 1px 下）。
`useIsNarrow`（上記「`useEffect` の扱い」）も `outlineOpenAtom` もここを読む。
**同名の `src/test/viewport.ts` は別物**で、そちらは jsdom 用の `matchMedia` スタブ
（下記「jsdom に無いものは `src/test/setup.ts` が埋める」）。

**要素の親子関係が変わる分岐は `useIsNarrow` の JS で行う**（パネルがオーバーレイになる、
ページ操作の行が別の場所へ移る、など）。CSS では親子関係を書けないため。**見た目だけが変わる
ところは `md:` 接頭辞でよい**——本棚（`ShelfPage.tsx` の削除ボタン）と、リーダーのヘッダ
（`AppPage.tsx` の `md:block` / `md:ml-4` / `md:flex-none md:max-w-xs`。狭い画面で「本棚」への
リンクが折り返さないようにするためのもの）がそれ。本棚のグリッドの列数は `md:` ではなく
`sm:` / `lg:` で刻む。

**分岐の軸は 3 つあり、問いで選ぶ。**「何が置けるか」なら幅（`useIsNarrow` か `md:`）、
「誰のための飾りか」なら端末の能力（CSS の hover メディアクエリ。下記の入力の表）、
「どう触れたか」なら入力イベント自身（`pointerType` など。同じ表）。**親指のためのコントロールを
足すときに幅で消してはいけない**——タブレットは広い画面に入るので `md:hidden` はそこから消す。
消したい相手が「hover できる読者」なら hover で問う。

| 広い画面（768px 以上）                                        | 狭い画面（767px 以下）                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 目次は横に並ぶ（`PdfOutline` の `w-60`）                      | 左からのドロワー + 背後を覆う暗幕（タップで閉じる）。目次から飛んだときも閉じる                     |
| PDF + チャットの 2 ペイン                                     | PDF 全幅の 1 カラム                                                                                 |
| チャットは右のパネル（`chatPanelOpenAtom`）                   | 下から出るシート `ChatSheet`（`src/front/components/ChatArea/ChatSheet.tsx`）                       |
| 目次とチャットの開閉はヘッダーの 2 つ                         | `PageToolbar` の両端（目次 / チャット）                                                             |
| ページ送りは hover できない端末だけページの下（スクロール内） | `PageToolbar`（`components/PdfViewer/PageToolbar.tsx`。描くのは `AppPage`）。hover は問わず必ず出る |
| マウスで選んだら浮遊ポップオーバー                            | 下端の `SelectionActionBar` →「AIに質問」で `SelectionPopover`（`floating={false}`）                |
| ペイン境界のドラッグハンドルで幅を変える                      | ハンドルは出さない（分ける相手がいない）                                                            |

**この表は「何が画面に出るか」だけを決める**（ページ送りの行だけは、広い画面側が幅と端末の
能力の両方で決まる。下記「ページ送りの行を出すかどうかは…」の段落）。
**「どう触れるか」は幅で分けない**——タブレットは
幅が広く指しかないので、幅で分けると全部マウス向けの経路に落ち、本文を選ぶことすらできなく
なる。ノート PC の画面に触ることもタブレットにマウスを挿すこともあるので、端末単位の判定も
同じく取りこぼす。**入力の分岐はイベント自身で行う**（`touchstart` はマウスでは発火しない、
`PointerEvent.pointerType` は 1 件ごとに `"mouse"` / `"touch"` / `"pen"` を報せる）。
ジェスチャの配線は `useIsNarrow` を読まない。

| 入力                           | どう分けるか                                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ピンチ・スワイプ               | `touchstart` / `gesturestart` の購読だけ。指のときしか発火しない                                                                                                      |
| 左右タップでのページ送り       | 分けない（マウスのクリックでも送る）                                                                                                                                  |
| 中央のダブルタップでの拡大     | `pointerType !== "mouse"` のときだけ（マウスには Ctrl+ホイールがある）                                                                                                |
| 選択の確定                     | 分けない。常に `useSettledSelection`（`src/front/hooks/useSettledSelection.ts`。`selectionchange` が止まり、**かつ**ポインタが離れてから `SELECTION_SETTLE_MS` 待つ） |
| 選択したあとに何を出すか       | 指なら `SelectionActionBar`、マウスなら入力欄（狭い画面はマウスでもバー。320px の入力欄が収まらないため）                                                             |
| ペイン境界のハンドル           | 分けない。pointer イベント + `setPointerCapture` で、マウス・指・ペンの 3 種が同じ 1 本のコードを通る                                                                 |
| hover の有無で出し入れするもの | CSS の hover メディアクエリだけ。`src/` に 2 箇所——本棚の削除ボタン（`[@media(hover:none)]:opacity-100`）と広い画面のページ送り（`[@media(hover:hover)]:hidden`）     |

最後の行だけは入力ではなく端末の能力の話で、**JS の分岐ではなく CSS で問う**——見た目の出し入れ
しか変わらず、能力そのものを尋ねる語彙は CSS 側にしかないため。

**何で選んだかは `useSettledSelection` が確定の合図と一緒に渡す**（`pointerdown` の
`pointerType`。一度も来なければ `null`——沈黙をマウスと決めつけると iOS がマウス扱いになる）。
`PdfViewer` はそれを `chosenByFinger` に控え、`offerFirst`（＝ `isNarrow || chosenByFinger`）で
振り分ける。**押し下げの時点で控えるのが要**——長押しを platform が自分の選択に取り上げると
`pointercancel` で終わり、そのあとハンドルを動かしても pointer イベントは来ない。
**指に入力欄を先に出してはいけない**のは、開いた瞬間にフォーカスを取って選択を畳み、読者が
広げようとしていたハンドルごと消してしまうため。バーはフォーカスを取らないので、出たあとも
範囲を広げ続けられ、バーが見せる引用がそれに追従する。

**ページ送りの行を出すかどうかは、広い画面だけが端末の能力で決める。**形はどちらも同じ
`PageStepper`（前 / 現在地 / 次。`components/PdfViewer/PageStepper.tsx`）で、置き場所と判定が
違う。狭い画面は幅だけで決まり、`PageToolbar` が窓の下端に必ず出す。広い画面は `PdfViewer` が
ページの下（スクロール内）に置くが、**hover できる端末には出さない**（ラッパーの
`[@media(hover:hover)]:hidden`）——ページを送るのは端のクリックとキーボード（方向キーの
`←` / `→` はモードを問わず、vim モードなら `h` / `l`、emacs モードなら `C-f` / `C-b`）で足り、
1 ページずつ送って読む本で今が何ページ目かを
知っても使いようがない。**今どこを読んでいるかは消えていない**——目次は現在のページを含む項目を
強調し（`PdfOutline` の `findActiveEntry` が選び、`aria-current="location"` で示す。見出しの文字列ではなく
エントリそのもので照合するので、章ごとに「はじめに」が並ぶ本でも点くのは 1 つ）、`?page=` はアドレスに残る。出ているときの表示は
出ている枚数に従い、見開きなら `11-12 / 12`、1 ページなら `12 / 12`（`step` prop。既定は 1 で、
狭い画面の `PageToolbar` は渡さない）。

**広い画面を幅ではなく端末の能力で分ける**のは、タブレットがそこに入るため（1024px は
`NARROW_MAX_WIDTH` の上）で、幅で消すとタブレットからページ送りが消える。この分け方の帰結は
2 つある——**hover を報せる端末はすべて出ない側に落ちる**（画面に触れるノート PC も、マウスを
挿したタブレットも。ポインタとキーボードがある前提で受け入れる）。そして**マウスの PC でも窓を
767px 以下に縮めればページ送りは出る**（あちらは電話のレイアウトそのもので、幅で選ぶ。1 カラムに
代わりの行は無い）。

**開閉のトグルはヘッダーに 2 つ並べる**（`AppPage`）——目次を畳むのとチャットを畳むのは同じ
種類の操作で、パネルの中に置くと戻る道を一緒に畳んでしまう。狭い画面にはトグルは出さず、
`PageToolbar` の両端が兼ねる。**広い画面の開閉は本ごとにサーバへ残る**ので、畳んだ本は次に
開いても畳まれたまま（狭い画面は保存も復元もしない。下記「読んでいた場所は本と一緒に運ぶ」）。

**ページの大きさはペインが決める**（`src/front/lib/pageScale.ts` の `fitPageScale` が
`min(幅で合わせる倍率, 高さで合わせる倍率)`、読者の倍率はその上に乗る）。**ページ全体が必ず
見えることが約束**で、幅を優先すると足が画面の外に出るため崩してはいけない
（`e2e/chatbook.spec.ts` の「the whole page is visible…」と「dragging the splitter…」が守る）。

#### 幅が余ったら 2 ページ並べる

ペインに 2 ページ分の幅があれば見開きで出す。**判定はペインの実測と読者の倍率だけで、パネルの
開閉は見ない**（`src/front/lib/spread.ts` の `fitsTwoPages`。ペインの内寸は `PdfViewer` の
ResizeObserver がすでに測っていて、目次・チャットの開閉にもスプリッターにも追従する）。
横長のモニタなら目次を出したままでも 2 ページになり、電話ではどれだけ畳んでも 1 ページのまま
——「何が置けるか」は幅の話なので、上記の分岐の軸のうち幅で決まる側に入る。ただし
`useIsNarrow` の 767px ではなく**ページが 2 枚入るかという実測**で分ける。

**条件は「1 ページのときの表示サイズのまま 2 枚並ぶこと」**（`fitPageScale` で合わせたページ幅
× 読者の倍率を実効幅と呼ぶと、実効幅 × 2 + `SPREAD_GAP_PX` = 8px ≤ ペイン幅）。2 枚目は
1 枚目を縮めてまで出す価値がないので、少し足りないときは 1 ページのままにする。**判定が引くこの
8px と、実際に描かれる隙間（`PdfViewer.tsx` の flex の `gap-2`）は別物**——一致を確かめている
ものは無いので片方だけ動かさないこと。隙間が要るのは、ページごとの `shadow-lg` が接合部で
溶け合って 1 枚の紙に見えてしまうため。

**倍率が条件に入るのは、それが読者の描いているページの大きさそのものだから**。縮めれば入らな
かったペインに 2 枚目が入り、拡げればその場所を返す（拡大した 1 枚が読者の見たいものなので、
両方を縮め直すのではなく 2 枚目が退く）。**電話が見開きにならないことはこれで変わらない**——
ページの縦横比より細いペインは幅で律速されるので、条件は `MIN_ZOOM`（`src/front/lib/pageScale.ts`
が持つ 0.5 倍）より小さい倍率を要求することになり、どれだけ縮めても成立しない。

**ページのフィット先はペイン全幅**（`PdfPage` の `containerWidth`。見開きでも半分にしない）。
上の条件から、現在ページは自分の半分に必ず収まる。**半分に合わせ直すのが目に見えて壊すのは、
倍率を下げて成立した見開きだけ**——倍率 1 の見開きは条件（実効幅 2 枚 + 8px ≤ ペイン幅）から
半分幅 ≥ ページ幅が従い、必ず高さ律速なので半分に合わせても同じ大きさに描かれる。縮めて
成立した見開きでは半分が幅律速に変わり、両方が読者の倍率より小さくなる。**これを守っているのは
E2E の 1 つのアサーションだけ**——縮小側のテストが「左ページ幅 ÷ 縮小前のフィット幅」を見て、
1 回のピンチインが着く `MIN_ZOOM` どおり 0.5 になることを確かめる。半分に合わせると
1280×720（両パネルを開いた状態）でこの比が 0.28 に落ちる。

**その代わり、相方は半分に収まる保証を持たない**。判定は現在ページの寸法しか見ないので、
縦横比の違うページ——横長の図版ページ——が相方に来ると、そちらは自分の寸法でペイン全幅に
フィットして半分を超え、ペインからはみ出す。**半ペインに合わせていた頃は起こらなかった退行**で、
寸法の揃った本（E2E の fixture は全ページ A4 なので検出しない）では上位の「ページ全体が必ず
見える」約束は破れないが、混在する本でだけ破れうる。フィット先を全幅にした代償としてそこは
許容している。

**倍率は本ごとに localStorage に残る**（`zoomAtomFor(pdfId)` = `chatbook:zoom:<pdfId>`。下記
「状態管理とルーティング」）ので、縮めたまま閉じた本は次に開いても見開きで始まる。**電話が
見開きにならない保証は、倍率の書き手が全員 `MIN_ZOOM` で丸めることに乗っている**——ホイールの
`nextZoom`、指と Safari の `pinchZoom`、ダブルタップのリテラル、そして localStorage を読み戻す
`settingsAtom.ts` の validator の 4 つ。倍率の書き手を足すときはここを通すこと。

**現在ページが常に左**（`visiblePages`）。引用リンクやハイライトで p.7 へ飛べば [7|8] になり、
名指されたページが必ず左に来る。最終ページに相方が無ければ 1 枚だけ描く。

**ページ送りは出ている枚数だけ動く**（`turnTo`。端のクリック・スワイプ・`←` / `→`・`h` / `l`・
`PageStepper` が全部ここを通る唯一の算術）。**送り先が本の終わりを越えるなら動かない**——
12 ページの本の [11|12] からの送りは 13 ページ目を指すので、そこが本の終わり。**ただし余った
1 ページは「終わり」ではない**——[10|11]（リンクや目次で飛ぶと起こる）からの送りは 12 ページ目に
着き、読者がまだ見ていないその 1 枚を単独で出す。ここを見開き単位で止めると、最後の 1 ページが
どの操作からも届かなくなる。`G`（最終ページ）は最後の見開きの左（`lastSpreadStart`）へ着地する。

**判定に要るページの素の寸法は `usePageBaseSize` が取る**（`getViewport({scale: 1})`）。
描かれた大きさから逆算できないのは、描かれた大きさこそがこの判定の結果だから。

**判定の算術そのものは `src/front/lib/spread.test.ts` が持つ**（ペインの寸法 × 倍率の組み合わせ）。
**電話が `MIN_ZOOM` まで縮めても見開きにならないことを守っているのはここだけ**——E2E は 7 本とも
desktop なので、あの主張を通る実行が無い。

画面に出る結果は desktop の E2E 7 本が守る（`e2e/chatbook.spec.ts` の
「puts a second page up once the pane has room…」「puts a second page up once the reader
shrinks…」「takes the second page back when the reader zooms in…」
「turns both pages of a spread…」「marks a passage taken from the right page…」
「keeps a drag made right to left…」「keeps a drag that runs on to the next page…」）。
7 本に共通の grep 文字列は無いので、見開きに触ったら `--project=desktop` を全件走らせる。
`PageStepper` の見開き表示と送り先は jsdom（`PageStepper.test.tsx`）が持つ——広い画面のあの行は
hover できない端末にしか出ないので、desktop の E2E からは触れない。
**desktop が見開きになるのは、チャットを畳んだときと読者がページを縮めたとき**なので、
`canvas.block` を数える・測るヘルパー（`settledCanvasWidth` / `drawnPageAndPane`、2 枚まとめて
ペインと突き合わせる `pagesAgainstPane` ほか）は `.first()` で左ページを見る。

**ペインの余白は上下だけ**（`PdfViewer.tsx` の `py-4`。左右は 0）。ページは横より縦が長いので、
その比より細いペイン——目次とチャットを開いた MacBook 14 がそれ——では幅が先に尽きて高さが余り、
**左右に置いた余白はそのぶんページの高さを削る**。読むことはページ単位のスクロールなので、
余った高さは読者が取り戻せない。実測では 1512×982 でページが 613×870 → 636×902 になり、
ページ下の空きが 48px → 16px（上下の余白）に減った。高さが先に尽きる幅（1280×720 /
1920×1080 / 2560×1440 で計測）では元から余りが無いので変わらない。
`e2e/chatbook.spec.ts` の「spends the pane's height on the page…」がこの幅を名指して守る。
**ページ下の `mb-4`（`PdfPage.tsx`）は残す**——ページの大きさには効かず（倍率はペインの箱から
決まる）、ページが収まっているときにペインが持つ唯一のスクロール余地なので、消すと `j` / `k` が
何も動かせなくなる。

ページ送りとズームの判定のうち、**帯・スワイプ・倍率の純粋な計算は
`src/front/lib/touchNavigation.ts`**（`resolveTapZone` / `resolveSwipe` / `pinchZoom`）が持つ。
**閾値は `PdfViewer.tsx` 側**にあり（`TAP_SLOP_PX` = 12px / `TAP_MAX_MS` = 500ms /
`DOUBLE_TAP_MS` = 320ms / `DOUBLE_TAP_ZOOM` = 2 倍 / `ENLARGED_ABOVE` = 1.05 倍）、
`PdfViewer` が両者を配線する。

**送ってよいかは `pointerdown` の時点で決める**（押した瞬間に `turnable()` を控える。
`turnable()` は「ポップオーバーが出ていない」かつ「選択が畳まれている」を見る）。
ポップオーバーを閉じるのはその外側を押すことで、閉じる処理は `mousedown` で先に走る。
`pointerup` で見ると何も出ていないように見え、読者が戻ろうとしただけのページが送られる。
**2 回目以降のクリック（`event.detail > 1`）も送らない**——単語をダブルクリックで選ぶ操作の
1 打目にあたるため。**拡大中（`ENLARGED_ABOVE` 超）はタップもスワイプも送らない**——
そのときの端は、ページを離れる操作ではなくページの中を動く操作。

広い画面にだけ出る**ペイン境界のハンドルは、当たり判定 44px・見た目の線は細いまま**
（`AppPage.tsx`。中の `span` が線）。`touch-action: none` が要る——無いと指のドラッグが最初の
move より前にスクロールへ吸われる。**44 は `HANDLE_WIDTH` 1 箇所だけが持つ**（`AppPage.tsx`。
親指が届く最小の寸法から採った値）。ハンドル自身の幅と、両ペインが `calc(…% - HANDLE_WIDTH / 2)`
で譲る量の両方がここを読む。譲らないと 3 つの合計がウィンドウを超え、flex が誰も勘定して
いない量だけペインを縮める。

**`chatSheetAtom`（`src/front/atoms/chatAtom.ts`。`closed` / `half`＝画面の 46% /
`full`＝82%）はどこにも保存しない。** `chatPanelOpenAtom` は「広い画面でパネルを畳んだか」で、
本と一緒にサーバへ運ぶ（下記「読んでいた場所は本と一緒に運ぶ」）。シートは毎回 `closed` から
始まる——電話には畳んで残す第 2 のペインが無く、half と full は場所ではなくジェスチャだから。

**シートを開く口は 3 つ**——`PageToolbar` のチャットボタン、`AppPage` の `openChat`
（ページ上のハイライトのタップ・一覧・URL の `?selection=` 復元がすべてここを通る。
つまり `?selection=` 付きのリンクは狭い画面でもシートを `half` で開く）、そして
**新しい質問の保存が成功したとき**（`useAskAboutSelection`）。half と full の
切り替えと閉じるのは `ChatSheet` 自身の `onChange`、読み手は `AppPage` だけ。

**質問することはチャットを開くことでもある。**質問を保存できたら、狭い画面ではシートを
`closed → half`（既に上がっているシートは動かさない。`openChat` と同じ意味論）、広い画面では
畳まれた `chatPanelOpenAtom` を開く（`useAskAboutSelection` が `useIsNarrow` で振り分ける）。
ここを開かないと、回答が畳まれた入れ物へ流れ込んで読者から見えない——狭い画面はシートの
既定が `closed` なので必ず起きる。保存に失敗したときは開かない（見せる回答が無く、
ポップオーバーがその場で理由を出す）。`openChat` は再利用しない——あちらは履歴を取得して
`chatMessagesAtom` を上書きするので、始まったばかりのストリームと衝突する。

シートの作りで外してはいけない点が 3 つある。**開閉は `translateY` ではなく高さ**で行う
（`ChatSheet.tsx`。押し下げる方式だと half のとき入力欄が画面外に出る）。**シートは `main` の
中に置き、ツールバーの上で止める**（`AppPage.tsx`。読み進めることが本と回答を同時に出す
理由なので、開いていてもページ送りが残る。`PageToolbar` は `position: fixed` ではなく
`h-dvh` の flex 列で `main` の下に並ぶ兄弟）。**リーダーのシェルは `overflow-clip`**
（`AppPage.tsx`。画面外へ逃がしたシートがスクロール領域を作り、入力欄のフォーカスで
リーダーごとずれる）。

**両方の atom は閉で始まる**（`outlineOpenAtom` は `src/front/atoms/pdfAtom.ts`、
`chatPanelOpenAtom` は `src/front/atoms/chatAtom.ts`。どちらも `atom<boolean>(false)`）。
**開くのは本が届いたときだけ**で、`useReadingLocation` が保存値を——本が何も言っていなければ
広い画面の既定である「開」を——当てる（下記「読んでいた場所は本と一緒に運ぶ」）。

**開で始めてはいけない**。リーダーの画面は本より先に描かれるので、開いた状態で始めると
パネルが取得のあいだ出てしまい、読者の目の前で引っ込む。**畳んで閉じた本ほど目立つ**——
前回畳んだ選択が毎回一瞬だけ取り消されて見える。逆向き（閉→開）のちらつきは残るが、
出るのは本が何も言っていないときだけで、増える方向なので読者の選択を否定しない。

**幅は初期値に関与しない**。広い画面かどうかは復元する側（`useReadingLocation`）が本の到着時に
1 度だけ見て、狭い画面ではどちらも当てない。あちらの目次はページを覆うドロワー、チャットは
`ChatSheet` と `chatSheetAtom` という別物なので、閉のままでよい。

目次の書き手は `PageToolbar` の目次ボタン・キーボードショートカット・暗幕のタップ・
目次から飛んだとき（狭い画面のみ）・広い画面のトグル・上記の復元。

見た目の原型は `docs/mockups/mobile.html`（依存ゼロの単一 HTML）。**正は実装**で、
モックは操作感を詰めるために作った参考物。テストの書き方は下記「jsdom に無いものは
`src/test/setup.ts` が埋める」の `setViewportWidth` を使う。

#### ハイライト一覧の検索はサーバ、削除はパネルが持つ

一覧（`src/front/components/ChatArea/HighlightListPanel.tsx`）は**データ源を読まない
props のコンポーネントのまま**で、自分で持っているのは削除ダイアログの開閉と直近の削除失敗
（`actionError`）だけ。**検索欄はパネルが描くが、値も結果も持たない**——入力と SWR は
`src/front/hooks/useHighlightSearch.ts` にあり、`ChatArea` がそれを呼んで
`query` / `onQueryChange` / `onSearch` / `searched` / `searchError` と、絞り込み済みの
`highlights` / 本の総数 `total` を props で渡す。

**検索の受け口は `GET /api/pdf/:pdfId/search?q=`**（`src/server/routes/pdf.ts` →
`pdfService.ts` の `searchSelections`）。**サーバで検索するのは、チャットが本の
レスポンスに載っていないから**——一覧は `GET /api/pdf/:pdfId` の `selections[]` から
描かれるので、会話の中身はクライアントに無い。本の存在を確かめたあと、**手書き SQL を 1 本**
で `selections.selected_text` と `chat_messages.content` の両方を見る（`EXISTS`。2 つの
検索に分けて後で混ぜると、片方だけ届いた瞬間に結果がちらつく）。**`findSelections` の
`db.prepare()` は service で唯一 drizzle を通らない**箇所で、`ESCAPE` を書くため——軸を
足すならここ。返すのは**該当した id だけ**（`{ selectionIds }`。`selectionSearchResultSchema`）
で、ハイライトそのものは一覧が既に持っている。**`ORDER BY` の結果は使われない**（一覧の
`newestFirst` が並べる）。

**検索も `ResultAsync` の service**で、無い本は `serviceFailureResponse` が
`PDF_NOT_FOUND` の 404 にする（例外なのは下記の削除だけ）。`q` は
`selectionSearchQuerySchema` が 1〜200 文字（`MAX_SEARCH_QUERY_LENGTH`）に絞り、外れると
400。**入力欄に `maxLength` は無い**ので、長い段落を貼れば読者には「検索に失敗しました」
として出る。

- 軸は**ハイライトの本文とそのチャットの本文**。色もページ範囲も軸にしていない——色は
  選ぶ UI が無く保存された行がすべて D1 の既定値（`#FFEB3B`）、ページは読者が絞りたい
  単位（章）と一致しない
- **`%` と `_`、それにバックスラッシュ自身をエスケープする**（`likeContaining`）。素通しすると
  `%` の検索が本の全件に当たり、検索が壊れているようにしか見えない
- **大文字小文字を無視するのは ASCII だけ**（SQLite の LIKE の仕様）。`workers` は
  `Workers` に当たるが、日本語には効きも害もしない
- **`%…%` にインデックスは効かない**。1 冊分の `selections` と各行の `chat_messages` を
  走査する（絞れるのは `idx_selections_pdf_id` で本の範囲まで）。1 冊のハイライトが数百の
  うちは足りるので FTS5 は入れていない
- **入力は 1 行に収める**（何かを足すときも）。狭い画面では同じ一覧が `ChatSheet` の中に
  出て、half（画面の 46%）だと縦が無い
- **打つことは検索することではない**。サーバへ行くのは検索ボタンか Enter を押したとき
  だけで（`submit` が `query` を `term` へ移す）、打っている間は一覧が動かない。日本語を
  打つ読者にとっては、変換中の文字列で検索が走らないことが要（debounce ではこれが守れず、
  変換の途中経過が毎回サーバへ行く）
- **Enter の判定は `isSubmitKey`**（`ChatInput` と共用）。変換を確定する Enter は IME の
  ものなので検索を走らせない——ここを素の `key === "Enter"` に戻すと、日本語の語を確定
  するたびに検索が走る
- **検索していないときのヘッダは `ハイライト N件` のまま**。検索を実行した後だけ
  `ハイライト N件中 M件` に変える。どちらも E2E と jsdom が完全一致で照合している。
  切り替えを決めるのは**検索が走ったか**（`searched` = `matchedIds !== null`）で、
  箱の中身（`query`）ではない——打っただけでヘッダが動くと、まだ絞られていない一覧に
  絞られたという顔をさせることになる
- **次の答えが来るまで前の結果を見せたまま**にする（SWR の `keepPreviousData`）。検索を
  押し直すたびに一覧がいったん全件へ戻ると、読者は絞り込みが解けたのかと思う
- **一致が 0 件でも入力欄と検索ボタンは残す**（消すと検索を解除する手段がなくなる。
  **解除は箱を空にして検索を押すこと**で、空にしただけでは前の結果のまま）。本に
  ハイライトが 1 つも無いときだけは、入力欄ごと出さずに始め方の案内を出す
- **検索が失敗しても一覧は隠さない**——検索できなかったことと、一致が無かったことは別。
  ただし**見えるものは前項が決める**: まだ一度も結果が来ていなければ全件、来ていれば
  前の検索語のままの一覧が残り、理由だけが上に出る。**理由を出す枠は削除の失敗と共有**で、
  削除の失敗が出ている間は検索の理由は出ない（`actionError ?? searchError`）
- **検索語はチャットを開いても残る**（フックが `ChatArea` にあり、一覧の unmount で
  消えない）。戻れば絞り込まれたままの一覧に戻る
- **検索中に増えたハイライトや保存された回答は結果に入らない**（検索は本とは別のキーなので、
  本の更新では再検索されない）。打ち直せば入る

**削除の受け口は `DELETE /api/pdf/:pdfId/selections/:selId`**（`src/server/routes/pdf.ts`）。
ここは **service を挟まない唯一の削除**で、`pdfService` の `ResultAsync` も
`serviceFailureResponse` も通らず route が drizzle を直に叩く。**無い id も成功で返す**
（404 にしない。E2E が本のハイライトを掃除するのにこの冪等性を使っている）ので、画面に出る
削除の失敗は回線断か 500 だけ。チャットは D1 の `ON DELETE CASCADE` が落とす。
前後の形は `src/shared/schemas/selection.ts` の `selectionDeletedSchema`。

- 削除は行の**外**に置いたボタンから（行全体が `<button>` なので、中に入れると
  button の入れ子になる）。当たり判定は 44px 角（`h-11 w-11`。同じ一覧を電話が指で使う）。
  **hover で出し入れしない**——上記「狭い画面のリーダーは 1 カラム」の入力の表が数え上げて
  いる hover 分岐（`src/` に 2 箇所）を増やさないため。確認は
  `src/front/components/ConfirmDialog.tsx`（本棚の削除と共用）で、**チャット履歴も
  消えることを文面に書く**
- **削除の失敗は検索行の下に出る**（検索の失敗と同じ枠で、こちらが優先）。消えるのは
  **次の削除を実行したとき**だけで、ダイアログをキャンセルしても残る。ただし読者が
  チャットを開いていれば一覧ごと消えているので届かない（上記「意図的に握りつぶす」）
- **削除の答えが返るまでに読者が別の操作をしうる**。ダイアログを閉じてから待つので、その間に
  PDF 上のハイライトをタップしてチャットが開くことがある。開いているチャットを畳む判断は
  `selectionDeletedAtom`（`src/front/atoms/chatAtom.ts`）が**その時点の store を読んで**
  行う——ハンドラの中で `activeSelection` を見るとレンダー時に捕まえた値（一覧が出ていた
  ときの `null`）を読むので届かない。atom を空にすれば `?selection=` も読書位置も追従する。
  配線は `ChatArea` の `onDelete`（`removeHighlight(book.id, id)` が成功したら
  `selectionDeleted(id)` を撃つ。**本の id は hook に渡したものと同じでなければならない**
  ——リクエストは引数の id へ飛ぶが、ハイライトが消えるのは hook の `pdfId` の一覧）

**既知の割り切りが 1 つ**: 同じセッションで作ったハイライト（`addHighlight` が `color: ""`
で先に置いた分）がある状態で古い行を削除すると、その色が 1 つずれる——パレットが配列の位置で
決まるため。ページ上のハイライトも同じ配列を読むので同時に変わる。本を読み直せば既定値に
戻り、色に意味を持たせていないので直していない。

守っているテストは次のとおり。**狭い画面でこの UI を通る自動テストは無い**（`mobile` /
`tablet` の E2E にも jsdom の `setViewportWidth` にも無いので、シートの中の見え方は手で見る）:

| 何を                                      | どのテスト                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 検索の SQL（本文・チャット・`%`・他の本） | `test/worker/pdf.test.ts` の `GET /api/pdf/:pdfId/search`（8 件。**チャット本文で見つかることを守る唯一の場所**） |
| 入力と実行の分離・失敗の運び方            | `src/front/hooks/useHighlightSearch.test.tsx`                                                                     |
| 一覧の見え方・削除の確認と失敗表示        | `HighlightListPanel.test.tsx`                                                                                     |
| 検索結果で一覧が絞られる                  | `ChatArea.test.tsx`「narrows the list to what the server says holds the query, chats included」                   |
| サーバが落とした分だけキャッシュから除く  | `useHighlights.test.tsx`「takes a highlight the reader deleted out of the list without re-reading the book」      |
| 失敗しても一覧に残す                      | 同「keeps the highlight and hands back the reason when the server refuses to delete it」                          |
| 開いているチャットを畳む                  | `src/front/atoms/chatAtom.test.ts`「leaves the chat of a highlight that has just been deleted」                   |
| 待っている間に開かれたチャットを畳む      | `ChatArea.test.tsx`「leaves the chat a reader opened on a highlight while its deletion was in flight」            |
| サーバから本当に消えている                | `e2e/chatbook.spec.ts`「a highlight deleted from the list stays gone after a reload」（desktop 1 本）             |
| 検索が実際にサーバを通る                  | 同「searching the list narrows it to what the server matched」（本文の検索だけ。理由は下記）                      |

**チャット本文で見つかることを E2E に足していないのは、実キーが要るから**ではない——質問
（user のメッセージ）は LLM を呼ぶ**前**に保存されるので、ダミーキーでも D1 には残る。
足していないのは、**送信すると上流に繋がろうとして失敗するまで待つことになり、かかる時間が
読めない**ため（`.dev.vars` の節にある「60 秒のタイムアウトまで粘る」がこれ）。保存できないの
は回答（assistant）の方で、そちらは実キーが要る。チャット本文の検索は worker テストが持つ。

#### リーダーの URL は `useReadingLocation` が単独で書く

リロードと共有リンクで同じ状態に戻るよう、リーダーの状態は 2 つのクエリパラメータに
載っている。**書き手は `src/front/hooks/useReadingLocation.ts` 1 つだけ**で、これを
分けてはいけない——`setSearchParams` は同一 commit 内でマージされないので、書き手が 2 つ
あるとハイライトを選んだとき（`page` と `selection` が同時に動く）に片方が黙って消える。

| パラメータ  | 値                             | 反映先 atom           | 省略時の扱い                                       |
| ----------- | ------------------------------ | --------------------- | -------------------------------------------------- |
| `page`      | 1 以上の整数（例: `5`）        | `currentPageAtom`     | 1。既定値でも `?page=1` と書き出す                 |
| `selection` | ハイライトの ID（例: `01KZ…`） | `activeSelectionAtom` | チャットを開いていない（ハイライト一覧）ことを表す |

`page` は既定値も明示するが、`selection` の「無い」は省略で表す（null を綴る自然な形が
無いため）。**`page` / `selection` / `#:~:text=` がどれも無い＝本棚から開いたときだけは、
書き出しをサーバの読書位置が決まるまで待つ**（下記「読んでいた場所は本と一緒に運ぶ」）。

**載っているのは場所だけで、目次とチャットパネルの開閉は載せない**。あれは本ごとに
サーバへ保存する（下記「読んでいた場所は本と一緒に運ぶ」）。**URL とサーバの二重管理に
戻さないこと**——URL に焼き付いた開閉は、ブラウザの履歴や共有リンク越しに何度でも戻って
きて、そのたびサーバの保存値を上書きする（畳んだはずの目次が開いたまま復活するのがこれ）。
`useReadingLocation` は本を開いた時点と書き出しのたびに `RETIRED_PARAMS`（`panel` / `outline`）を
`delete` するので、その形の古いリンクで開いてもパラメータはアドレスバーから消え、開閉は
本の保存値どおりになる（`e2e/chatbook.spec.ts` の「an old link naming the panels no longer
has a say over them」が守る）。**掃除は本の到着を待たない**——場所を名指さない URL では
書き出し自体が本待ちなので、待たせると取得が失敗した本でパラメータが残り続ける。

Chrome の「ハイライトへのリンクをコピー」が書く `#:~:text=`
フラグメント（`src/front/lib/textFragment.ts` が解析する）は `?page=` より優先する——
送り手がたまたま開いていたページより、名指しされた引用文の方が読者の目的に近いため。

`selection` の復元だけは**本（`useBook` の SWR）の到着を待つ**。ハイライトは本から読むため。
待っている間は URL の値を温存し（`pendingSelectionId`）、その間のページ送りで空の atom から
`?selection=` を消してしまわないようにしている。本から消えたハイライトを指す URL は一覧を
表示し、パラメータ自体を落とす。

**`?selection=` の復元では現在ページを動かさない**（URL の `page` が正）。一覧から選んだ
ときだけそのハイライトのページへ移るので、`setCurrentPage` は `AppPage` の
`handleSelectionClick` にあり、復元と共用する `openChat` には入れない。**ここを `openChat`
に戻すと、途中まで読んで再訪したときにハイライトのページへ引き戻される。**
（サーバの読書位置からの復元だけはページも動かす。下記「読んでいた場所は本と一緒に運ぶ」）

**チャットだけは SWR に載っていない**。`chatMessagesAtom` が持ち、履歴の読み込みは
`AppPage` の `openChat` が `resultFetcher` を直接呼ぶ。理由は、同じ状態を SSE の
ストリームがトークンごとに書き換えるため（`useChatStream`）——キャッシュに載せると
再検証が流れてきた回答を上書きしうる。**「データ取得はすべて SWR」ではない**。
イベントハンドラ起点の 1 回きりの取得（履歴・選択の作成・アップロード）は SWR を通さず
`resultFetcher` で書く（受け皿になる SWR が無いので、失敗は値で返さないと消える）。

SWR の使い方で押さえるところ:

- **fetcher は必ず `src/front/lib/fetcher.ts` の `fetcher` を通す**（上記
  「外部入力のバリデーション（zod）」）。`useSWR(key, () => fetch(...).then(r => r.json()))`
  のように生 `fetch` を渡すとスキーマ検証を素通りし、`ApiError` / `INVALID_RESPONSE`
  の防護が消える。SWR の `error` state が受け止めるので、ここは throw する `fetcher` の
  ままでよく、`resultFetcher` に替えない。現在の SWR 呼び出しは全て `fetcher` 経由。
  **JSON ではない 2 つ——PDF バイナリ（`usePdfDocument`）とチャットの SSE
  （`useChatStream`）——だけが生の `fetch` を直接使う**。どちらも SWR ではなく、拒否の
  読み取りは `fetcher.ts` の `readRefusal` を通して同じ文言に揃える
- **ルートの `SWRConfig`**（`src/front/main.tsx`）で `revalidateOnFocus` を切っている。
  ローカル単一ユーザーのアプリでデータは自分の操作でしか変わらず、focus 復帰の再検証は
  Playwright のフォーカス往復で E2E を非決定にするだけ
- **本のキーは `src/front/hooks/useBook.ts` の `bookKey(pdfId)`（= `/api/pdf/:pdfId`）1 本**。
  リーダー（`AppPage`）・ビューア・チャットパネルが同じキーを共有するので本の読み取りは
  1 回で済み、ハイライトの追加も全員に同時に映る。ハイライト一覧は
  `useHighlights` がこのエントリの `selections` から導出する（色のパレット補完込み）ので、
  **専用の atom を作らないこと**——SWR のキャッシュ自体が共有のグローバル state で、
  atom と二重管理すると必ずずれる。**削除も同じキーを通す**（`removeHighlight`。
  サーバが落としたものだけをキャッシュから除くので、一覧・ページ上のハイライト・
  `PageToolbar` の件数が同時に追従する）。**検索だけは別のキー**
  （`/api/pdf/:pdfId/search?q=`。検索語ごとに 1 エントリで、返るのは id の配列）
  ——本のキャッシュを絞り込んだ結果で上書きすると、ページ上のハイライトまで消える
- **本は props、ハイライトは購読**という線引きは意図的。本の見出し（id / fileName /
  pageCount）は開いている間変わらないので props で足りる。ハイライトは `PdfViewer` が
  足して `ChatArea` が一覧する——兄弟どうしが同じ更新を見る必要があるので、
  `BookReader` へ持ち上げず同じキーの購読で共有する
- **アップロード時のキャッシュ先充填**: `FileSelector` が `POST /api/pdf/open` の結果を
  `mutate(bookKey(id), ..., { revalidate: false })` で先に書く。遷移先の
  `AppPage` がキャッシュヒットで即座に開くため。先充填の `selections` は空・
  `hasThumbnail` は推定値なので、**マウント時の再検証を止めないこと**——
  既にハイライトのある本を開き直したとき、一覧が空のまま固定される
- **リーダーの state は本ごとに作り直す**: `AppPage` が `pdfId` を key にした jotai
  `Provider` を張る。開いているチャット・選択・ページはどれも 1 冊に属するので、
  個別に reset する代わりに store ごと捨てる。本自体は store の外（SWR）にあるので残る。
  **本をまたいで残したい設定は store に置けない**——`atomWithStorage` +
  `{ getOnInit: true }` で localStorage に持たせる（`settingsAtom.ts` の
  `keybindingModeAtom` / `useWebSearchAtom` がその形）。本ごとに別の値を
  残すもの（ビューアの倍率）はキーに pdfId を入れ、`zoomAtomFor(pdfId)` が
  `chatbook:zoom:<pdfId>` の atom を Map で使い回す。**atom は毎レンダー
  作り直せない**（別のオブジェクトは別の state になる）。jotai の
  `atomFamily` を使わないのは非推奨で本を開くたびに警告を出すため
- **テストの差し替え口は 2 つある**。取得そのものを差し替えるなら DI 引数——
  `useBook(pdfId, loadBook)` / `useHighlights(pdfId, loadBook, deleteHighlight)` /
  `useHighlightSearch(pdfId, search)`（既定は `requestSelectionSearch`）/
  `usePdfDocument(pdfId, book, fetchFn)` / `useChatStream(fetchFn, now)` /
  `useAskAboutSelection(addHighlight, saveSelection)` /
  `useReadingStateSync(pdfId, locationReady, save, debounceMs)`（**時間も DI**。テストは
  デバウンスを短くして偽タイマーで進める）/
  `ShelfPage({ loadBooks, deleteBook, extract })` / `FileSelector({ extract })` /
  `PdfViewer({ measureSelection, saveSelection })` /
  `ChatArea({ readQuote, deleteHighlight, searchHighlights })` がその口。`measureSelection` は
  ポップオーバーを開く唯一の入口で、**実 DOM 選択と pdf.js が描いたページを両方要求する
  経路（質問・保存失敗の表示・二重送信の防止）を jsdom で動かすための seam**。
  キャッシュの中身を用意したいなら `src/test/swrTestCache.tsx` の `SwrTestCache` で包む
  （SWR の既定キャッシュはモジュールレベルの singleton なので、包まないとテストが互いの
  キャッシュを見て実行順に依存する。`seed` を渡すとそのキーをサーバの代わりに使う）。
  例外は**書き込まれたキャッシュの中身を検証したいとき**で、`Map` への参照が要るため
  `FileSelector.test.tsx` は自前の `Map` を `SWRConfig` へ直接渡している

#### 読んでいた場所は本と一緒に運ぶ

端末を変えても続きから読めるよう、**ページ・開いていたチャット（どのハイライトの会話か）・
目次とチャットパネルの開閉**を D1 の `pdfs` に持たせている（`migrations/0002_add_reading_state.sql`
が足す `last_read_page` / `last_read_selection_id` / `last_read_outline_open` と、
`migrations/0003_add_reading_state_chat_panel.sql` が足す `last_read_chat_panel_open`。
4 列とも nullable で、**読んでいない本には戻る場所が無い**——それはページ 1 とは違う）。
読み出しは本そのもの（`GET /api/pdf/:pdfId` の `readingState`）に載り、書き込みは
`PUT /api/pdf/:pdfId/reading-state`。

| 何を                                    | どこが                                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 保存（デバウンス 1 秒・離脱時の flush） | `src/front/hooks/useReadingStateSync.ts`                                                                                                                                |
| 復元（本の到着待ち）                    | `src/front/hooks/useReadingLocation.ts` の `pendingRestore`                                                                                                             |
| 保存・読み出しの service                | `src/server/services/pdfService.ts` の `saveReadingState` / `getPdf`                                                                                                    |
| front と server が交わす形              | `src/shared/schemas/book.ts`。読み出しは `readingStateSchema`、書き込みは `saveReadingStateRequestSchema`（開閉の 2 つだけ optional）、応答は `readingStateSavedSchema` |

**場所（ページとチャット）と開閉では、誰が正かが違う。** 開閉は広い画面ならどう開いた本でも
本が正で、到着時に保存値を当てる。場所は**URL が何も名指していないとき（＝本棚から開いたとき）
だけ**サーバの位置を使う——`?page=` も `?selection=` も `#:~:text=` も無いことが合図で、
1 つでもあれば URL が正（リロードと共有リンクの意味を壊さないため）。`?page=abc` のような
読めない値は「名指しなし」に落ち、サーバの位置が使われる。**退役パラメータは名指しに数えない**
ので、`?panel=closed` だけを持つ古いリンクは本棚から開いたのと同じ扱いになり、ページもサーバの
位置が使われる。

復元まわりで外してはいけない点が 7 つある。**当てるのは本ごとに 1 回だけ**（`pendingRestore`）
——本は開いている間に何度も届く（ハイライトを保存すると SWR が本を取り直す）ので、そのたび
当て直すと読者が開いたばかりのパネルを畳んでしまう。**サーバの位置を使う経路（本棚から開いた
とき）では、本が届くまで URL にも何も書かない**——先に `?page=1` を綴ると、誰も頼んでいない
ページがアドレスバーに入り、復元がそれと言い争う（URL が場所を名指した経路の書き出しは本を
待たない。退役パラメータの掃除だけはどちらの経路でも即座に行う——綴る場所を持たないので
言い争う相手がいない）。**この経路だけはページも動かす**——ページ・チャット・開閉は 1 つの
場所として同時に保存されたものなので、チャットだけ開くと別の場所に着地する。**本が届く前に
読者が動かしたものは復元しない**——ページは現在ページが 1 のままかどうかで、開閉は
`panelsWhenOpened`（本を開いた時点の値）と今の値が同じかどうかで判定する。ヘッダーのトグルは
本を待たずに押せるので、取得中に開いた目次が到着で畳み直されると、読者の選択がその場で
取り消される。**短くなった本に備えて最終ページで丸める**。**本が届かなければ復元も保存も
起きない**——`pendingRestore` が下りないので `locationReady` が立たず、本棚から開いた経路では
URL も書かれない（読者に見えるのは本の読み込みエラーだけなので、これで困る人はいない）。

**開閉は本の有無に関わらずここで決まる**——保存値があればそれ、`null`（広い画面が何も表明して
いない）や本自体が未読なら「開」。パネルは閉で始まるので、これが開ける唯一の口になる
（上記「狭い画面のリーダーは 1 カラム」の atom の段落）。

新しい約束を守るのは desktop の E2E 4 本（`e2e/chatbook.spec.ts` の
「a folded outline stays folded through a reload」「both folded panels come back when the book
is opened from the shelf」「an old link naming the panels no longer has a say over them」
「reloading brings back the folded panel and the chat that was open in it」）。

復元が届かない経路が 1 つある。**アップロードから開いた本ではチャットだけ復元されない**
——`FileSelector` のキャッシュ先充填は `selections: []` なので、保存されていた
`selectionId` を解決できないまま復元が確定する（ページと開閉は先充填の `readingState` から
戻る）。`last_read_selection_id` に外部キーは張っていないので、別端末で消したハイライトを
指す値も同じく一覧表示に落ち、次の保存まで残る。

保存側は「取得」ではなく sink である。書き手はどれも複数ある——ページは `PageStepper`・
キーボード・端のタップ・出典リンク、目次（`outlineOpenAtom`）はヘッダーのトグル・キーボード
（`keybindings.ts` の `toggleOutline`。チャットパネルを動かすショートカットは無い）、
チャットパネル（`chatPanelOpenAtom`）はヘッダーのトグルと質問の保存（`useAskAboutSelection`。
広い画面のときだけで、狭い画面では `chatSheetAtom` を動かす）。それぞれに書き込みを生やさず、
全員が着地する 3 つの atom を 1 箇所で見る。
**`locationReady`（`useReadingLocation` の戻り値）が立つまでは何も書かない**——ページ 1 と
閉じたままのパネルを書き戻すと、復元中の場所を自分で消す。立った直後に
見えた場所は「保存済み」として扱い、サーバへ送り返さない。**保存に失敗しても再送はしない**
——帯を出したまま、次に場所が動いたときが再試行を兼ねる。**同じ本を複数の端末・タブで
開いたら後に書いた方が勝つ**（利用者が 1 人なので調停はしない）。

**開閉の同期は広い画面同士の話**。狭い画面はどちらも復元せず、保存ペイロードにも載せない
（`outlineOpen` / `chatPanelOpen` の省略＝サーバの保存値を保持）。目次はページを覆うドロワーで
ジャンプのたびに自分で閉じ、チャットパネルはそもそも動かす口が無い（あちらは `chatSheetAtom`
という別物）。どちらの値も広い画面が選んだものとは無関係なので、送れば上書きにしかならない。
`null` は「まだ広い画面が何も表明していない」で、閉とは別物——**閉は畳まれたまま復元され、
`null` は開いて始まる**。

**保存で `updatedAt` は動かさない**。本棚はそれで並ぶので、ページを送ることが本を開き
直すことになってしまう。同様に `storePdf` の再アップロード上書きは列を明示列挙しており、
**同じ本を開き直しても場所は残る**（アップロードの応答にも `readingState` が載る）。

**URL が場所を名指して開いただけでは、その場所は保存されない**（リロード・共有リンク・引用
リンク）。`locationReady` が立った瞬間に見えている場所は、そこがどこであれ「保存済み」として
シードされるため。送られるのはそこから何かが動いたとき——ページを送る・チャットを開く・
パネルを畳む——で、そのときは動いた先の場所が丸ごと送られる。**古い共有リンクを開いて何も
せずに閉じても、別端末の読書位置は動かない**。読み進めれば動く。

**マイグレーションを当ててから動かす**。`readPdf` / `storePdf` は drizzle が `pdfs` の全列を
明示列挙するので、`0002_add_reading_state.sql` や `0003_add_reading_state_chat_panel.sql` が
未適用の D1 に新しいコードを載せると本を開く経路ごと 500 になる（列を絞って読む本棚一覧だけは
生き残る。`saveReadingState` が落ちるのは、その列を実際に送ったときだけ——開閉の 2 つは
省略なら `set` にも現れない）。
ローカルは `pnpm run db:migrate:local`、リモートは
`vp build` → `wrangler d1 migrations apply chatbook-db --remote` → `pnpm run deploy` の順。
列の追加は旧コードに無害なので、先に当てるのが常に安全。E2E は Playwright が起動時に
適用するので影響を受けない。

キーバインド（Vim / Emacs）は `src/front/lib/keybindings.ts` の `resolveAction` に
DOM 非依存の純粋関数として実装。`gg` や `C-c t` の2ストロークは `pending` プレフィックスで表現し、
タイマーを持たせない（挙動を決定的にしてテストできるようにするため）。

**方向キー（`←` / `→` でページ送り、`↑` / `↓` でスクロール）はモードに属さない**。
`resolveArrows` がモード分岐より先に答えるので「なし」でも効き、そのぶん
`useKeyboardShortcuts` は**どのモードでも購読する**（`mode === "none"` の早期 return は無い。
戻せば「なし」を選んだ読者からキーボードが消える）。**修飾キーが付いていたら渡さない**——
とくに Shift + 方向キーは文字の選択を伸ばす操作で、ポップオーバーが読者に頼んでいるものそのもの。
設定メニューのヘルプも `ARROW_KEYBINDING_HELP` を全モード共通で先頭に出し、モード別の
`KEYBINDING_HELP` をその下に continue する（方向キーを 3 モード分書き写さないため）。
**拡大中でもページを送る**——タップとスワイプは `ENLARGED_ABOVE` 超で送らないが、キーボードは
`h` / `l` を含めてその規約の外にある（拡大中に動かしたいのは `↑` / `↓` が担う）。

## テスト

ランナーが3つあり、それぞれ守備範囲が違う:

| ランナー              | 設定                       | 対象                                                                                |
| --------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| vitest (jsdom)        | `vite.config.ts`           | `src/**` の `*.test.ts(x)`（`src/front/**` と、workerd を要さない `src/server/**`） |
| vitest (workers pool) | `vitest.workers.config.ts` | `test/worker/**` の API（`SELF.fetch` / D1 / R2 を使うもの）                        |
| Playwright            | `e2e/playwright.config.ts` | ブラウザ実操作                                                                      |

jsdom テストと Workers pool テストは同一プロセスで共存できないため設定が分かれている
（`vite.config.ts` は `process.env.VITEST` のとき `cloudflare()` を無効化する）。

**Workers pool は外向きの `fetch` を msw で止める**（`test/worker/setup/msw.ts`。
`onUnhandledRequest: "error"`）ので、上流を叩くテストはハンドラを登録しないと落ちる。
**その上流は DeepSeek ではなく `https://llm.test`**——`vitest.workers.config.ts` が
`LLM_BASE_URL` / `LLM_MODEL` にテスト用の値を渡しているためで、env を読み落とした実装は
どのハンドラにも当たらずに落ちる（`test/worker/chat.test.ts` の `LLM_BASE` 定数がそれ）。

**jsdom 側は `include` を書かず `exclude` だけで拾っている**（`node_modules` / `dist` /
`test/worker/**` / `e2e/**` / `.claude/**` を除外）。そのため実装とコロケーションした
`src/server/services/*.test.ts` も自動的に jsdom で走る。バインディングを触らない純粋な
サーバロジック（`chatService` の引用パース、`llmService` の SSE パースを注入 fetch で
叩くもの）はこちらで書き、workerd の実物が要るものだけ `test/worker/**` に置く。
**`include` を足して絞ると、これらが無言で走らなくなる**ので注意。

### jsdom に無いものは `src/test/setup.ts` が埋める

jsdom はレイアウトを持たないので、幅にまつわる API がどれも無い。`setup.ts` が
`scrollIntoView` / `DOMMatrix` に加えて `ResizeObserver`（何も報せないスタブ）と
`matchMedia`（`src/test/viewport.ts` の差し替え可能なスタブ）を置く。あわせて
`asyncUtilTimeout` を 5000ms にしている——選択の確定を 250ms 待つ経路があり、既定の
1000ms だと並列実行の負荷で毎回違うテストが落ちるため。

**`matchMedia` の既定は 1280px（デスクトップ）**にしてある。狭いレイアウトを前提にしない
既存のテストを 1 行も書き換えずに済ませるため。狭い幅で試すときは
`src/test/viewport.ts` の `setViewportWidth(PHONE_WIDTH)`（`PHONE_WIDTH` は 390px で、
Playwright の `mobile` プロジェクトと同じ幅）を呼ぶ。マウント後に幅を変えるなら `act` の中で。
幅は `setup.ts` の `afterEach` で毎回戻るので、テストの実行順に依存しない。

**タッチ対応をどこでテストするかは 8 段に分かれる**:

| 何を                                                    | どこで                                                                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| ジェスチャの判定そのもの（帯・スワイプ・倍率）          | 純関数の単体テスト `src/front/lib/touchNavigation.test.ts`                                                              |
| 選択がいつ確定するか（押下・離す・通知の連続）          | jsdom + 合成 pointer イベント `src/front/hooks/useSettledSelection.test.tsx`                                            |
| 幅で変わる分岐（何が出る・出ない、どこへ繋がる）        | jsdom + `setViewportWidth(PHONE_WIDTH)`（`AppPage.test.tsx` / `PdfViewer.test.tsx`）                                    |
| 入力の種類で変わる分岐（`pointerType` / `detail`）      | E2E のみ（`e2e/chatbook.spec.ts` のマウスの端クリックと、質問ボックスを閉じるクリック）。jsdom には要素の寸法が無いため |
| hover の有無で変わる分岐（ページ送りの行）              | E2E で 2 本 1 組。**jsdom では触らない**（どちらも下記「hover の分岐は 2 本で 1 つの約束」）                            |
| 実際のタップとレイアウト                                | `e2e/mobile.spec.ts`（project `mobile`）                                                                                |
| 幅が広いまま指で触る組み合わせ                          | `e2e/tablet.spec.ts`（project `tablet`）                                                                                |
| 長押し選択・OS の選択メニュー・ソフトキーボード・ピンチ | 実機（ヘッドレスでは届かない。→ `docs/PDF_TEXT_SELECTION.md` §8）                                                       |

**`tablet` が独立して要るのは、幅ではなく入力で分けたことがほかのどこでも検証できないから**。
`mobile` は幅が狭いので幅で分けても通り、`desktop` はマウスしか使わないので指の経路を通らない。
その交差点（広い画面 × 指）だけが、幅で分けた実装をタブレットで壊す。**ただし E2E は CI にも
`pre-push` にも載っていない**（CI は `vp test` / worker のテスト / `vp check` / `vp build` だけ、
`pre-push` は `vp check` + `vp build` だけ）。入力で分ける約束を壊していないかは、
`pnpm run test:e2e --project=tablet` を手で走らせるまで誰も気付かない。

**hover の分岐は 2 本で 1 つの約束。**ページ送りの行が出ない側は `desktop` の
`keeps no row of page controls…`、出る側は `tablet` の `keeps the row of page controls…` が持つ。
**片方だけでは「どの端末でも非表示」と区別できない**ので必ず対で残す（互いのコメントが相手の
テスト名を書いてあるので、片方を消そうとすれば気付ける）。2 本まとめて走らせるなら
`pnpm run test:e2e -g "row of page controls"`（project をまたいでこの 2 本だけを拾う）。

**この行は jsdom では触らない。**Tailwind の CSS を当てないので `display: none` になったかを
見られないうえ、行は広い画面でも DOM に残る（条件は `book && !isNarrow` だけ）ので click できて
しまう。実機では見えないものを触る「動いていないのに通る」テストになる。

**jsdom で確かめられないもの**は E2E に置く。ページを描けないので、目次のドロワーのように
「描かれたページがあって初めて出るもの」はここでは検証できない（`PdfViewer` の
オーバーレイはポップオーバーか pdf.js のドキュメントが無いと DOM に入らず、
ポップオーバー経由だと外側 mousedown で先に閉じてしまう）。

### `.claude/**` を除外している理由

Claude Code はエージェント用の worktree を `.claude/worktrees/` に作る。これはこのリポジトリの
まるごとのチェックアウトなので、除外しないとメインクローンの `vp check` と `pnpm test` が
**別ブランチのファイルを拾う**。実際に起きるのは次の 2 つ:

- 作業中の未整形ファイルで `vp check` が落ちる（メインクローンのソースは健全なのに）
- worktree 側の `e2e/**` と `test/worker/**` が jsdom の実行に混ざり、
  `Playwright Test did not expect test() to be called here` や
  `Failed to resolve import "cloudflare:test"` で落ちる

`vite.config.ts` の `AGENT_WORKTREES` を `fmt.ignorePatterns` / `lint.ignorePatterns` /
`test.exclude` の 3 箇所に渡している。**各 worktree の中で実行する `vp check` は自分の
チェックアウトしか見ない**ので影響を受けず、CI もクリーンな checkout なので元から無関係。

### E2E の前提

- **プロジェクトが 3 つある**。読者の操作を決めるのは 2 つ——ウィンドウ幅がレイアウトを、
  ポインタの種類が入力の経路を決める。どちらも 1 回の実行に混ぜられないので、意味のある
  組み合わせごとに実行を分けている。`desktop` は既定幅（1280×720 px）をマウスで触って
  `e2e/chatbook.spec.ts`、`mobile` は 390×844 px・`deviceScaleFactor: 3`・`isMobile` / `hasTouch`（Playwright の `tap()` が使える）で `e2e/mobile.spec.ts`、
  `tablet` は 1024×768 px・`hasTouch` のみ（`isMobile` は付けない）で `e2e/tablet.spec.ts`。
  1 つだけ走らせるなら `pnpm run test:e2e --project=tablet`。新しいテストは、狭い画面の話なら
  `mobile`、指で触る話なら `tablet`、それ以外は `desktop` に置く。
  **`tablet` が見るのは 2 ペインのまま指で触ったとき**——選択とそこに出る提示バー・端のタップ・
  ハンドルのドラッグ・hover が無い端末での削除ボタンとページ送りの行。幅で分けた実装はここだけで壊れる
  （上記「タッチ対応をどこでテストするか」）。**ただし指の長押し選択そのものは合成できない**ので、
  選択のテストは中央の帯を 1 回タップして「指が触った」ことを立ててから `Range` API で作り、
  `selectionchange` で拾われることまでを見る（`pickPassageWithAFinger`）。
  **ハンドルを指でドラッグするには CDP の `Input.dispatchTouchEvent` が要る**
  （`setPointerCapture` はブラウザが実際に追跡しているポインタを要求するので、手で組み立てた
  `pointerdown` では捕捉が成立しない）
- **`desktop` は「今どのページか」をカウンタではなく描かれたページで見る**（`drawnPage` が
  `.textLayer span[data-page-number="N"]` を引く）。ページ送りの行が hover できる画面には
  出ないのでカウンタが無く、そのうえこの印は**ページが描かれてから付く**ので観測としても強い
  （カウンタは atom が変わった瞬間に切り替わるだけ）。付けているのは pdf.js ではなく
  `PdfPage.tsx` で、`textLayer.render()` が返ったあとに全 span へ貼る。消費者は E2E だけでなく
  `pdfTextMatcher.ts`（DOM の選択を文字位置へ戻す）と `citedPassage.ts`（引用の印を置く）も。
  ページを進めるのはキーボード（`l` / `h`）か端のクリック
- **`desktop` はチャットを畳むか、ページを縮めると見開きになる**（既定の 1280×720 で、目次は
  出したまま。上記「幅が余ったら 2 ページ並べる」）。`openTestBook` はチャットを開いた状態で
  着地するのでほとんどのテストは 1 ページだが、畳むテストと `pinchIn` するテストでは
  `canvas.block` が 2 つになる——数える・測るヘルパーが `.first()` で左ページを見るのはこのため。**pdf.js の span をドラッグするときは
  span の内側から内側へ動かす**（`box.x + 1` → `box.x + box.width - 1`）。テキストレイヤーの
  span は絶対配置なので、その外側で押し下げる `dragAcross`（チャットの本文用）では選択が
  始まらない
- **`tablet` / `mobile` はカウンタ（`pageLabel`）を見る**。どちらも `openTestBook` の読み込み
  待ちがそれなので、**あの行をこの 2 つで隠すと専用テスト 1 本ではなく spec 全件が 60 秒の
  タイムアウトで落ちる**
- **`workers` は 1**。3 つの spec は同じ D1 / R2 と同じ本（fixture が同じファイルなので
  同じ `pdfId`）を共有し、それぞれ開始時にその本のハイライトを全削除する。並行させると
  片方が、もう片方の検証している最中のハイライトを消す
  **`devices["iPhone 14"]` は使わない**——WebKit のインストールが要るうえ、iOS 固有の挙動
  （長押し選択と OS の選択メニューの競合、ソフトキーボードとシートの重なり）はどのみち
  ヘッドレスでは確かめられない。そこは実機で見る。**指のピンチは E2E では検証しない**
  （Playwright は指を 2 本送れない）。判定は `src/front/lib/touchNavigation.test.ts` が持つ。
  **トラックパッドのピンチ（ctrlKey + ホイール → `nextZoom`）は desktop の E2E が叩いている**
  ——`pinchIn` / `pinchOut` がそれで、倍率が見開きの入力になった今はページの枚数まで動かす
  （上記「幅が余ったら 2 ページ並べる」）。指のピンチが見開きを出せることを見るテストは無い
- **サーバーは Playwright が自動起動する**（`e2e/playwright.config.ts` の `webServer`）。
  下記の E2E 専用ストアを `rm -rf` してから、`wrangler d1 migrations apply`（`--persist-to` で
  そのストアを指す）と `vp dev --port <port> --strictPort` を順に実行するので、
  マイグレーション未適用の worktree でもそのまま走る。ここだけ `pnpm run db:migrate:local` を
  使わないのは、永続先を下記の E2E 専用ディレクトリへ向けるため。`reuseExistingServer: false`
  なので起動済みサーバーには相乗りせず、必ずこのチェックアウトのコードでテストする
- **ポートは worktree のパスから決定的に導出する**（5175〜5674 の範囲。`E2E_PORT` で上書き可）。
  5173 固定だと別クローンの `vp dev` に誤接続したまま「成功」しうるため。`--strictPort` により
  導出ポートが埋まっていれば黙って別ポートへ逃げず即座に失敗する
- **E2E は dev サーバーとは別の D1 / R2 を使う**。Playwright が
  `E2E_PERSIST_PATH=.wrangler/e2e-state` を渡し、`vite.config.ts` がそれを
  `cloudflare({ persistState: { path } })` に載せる（未設定なら既定の `.wrangler/state`）。
  **分けている理由は、テストがアップロードした本が読書中の本棚に現れないようにするため**。
  wrangler の `--persist-to` も plugin の `persistState` も渡したパスの下に `v3` を作るので、
  マイグレーションと Worker が同じストアを指せる
- **E2E のストアは実行のたびに作り直す**ので、前回の残骸に依存したテストは書けない。
  裏返すと、落ちた run のストアは次の run の冒頭までは残っている。中身を見たいときは
  `E2E_PERSIST_PATH=.wrangler/e2e-state vp dev` で同じストアを本棚から開く
- **同一 run 内のハイライトと読書位置は残る**。ハイライトはテキストレイヤーの上に乗るため、
  先行テストの残骸があると後続の選択テストを壊す。読書位置はサーバに残るので、先行テストが
  進めたページや畳んだパネルのまま次のテストが開いてしまう（3 spec は同じ fixture ＝同じ
  `pdfId` を共有し、アップロード後の遷移先はクエリの無い `/books/<id>` ＝サーバの位置を使う
  経路。パネルの開閉はどう開いてもサーバから来る——ただし狭い画面は復元しないので `mobile`
  には効かない）。各 spec が
  持つ `openTestBook`（`chatbook.spec.ts` / `tablet.spec.ts` / `mobile.spec.ts` に別々の実装が
  ある。共有していない）が開始前に selection を全削除し、読書位置をページ 1・両パネル開に
  戻す。**畳んだ状態から始めたいテストは URL ではなくサーバへ書いてから本を開き直す**
  （`chatbook.spec.ts` の `foldChatPane` → `page.goto`。復元は本の到着ごとに 1 回だけなので、
  `openTestBook` で本を開いたあとに書いただけでは畳まれない）
- **API が閉じているので、どのテストもまずログインする**。各 spec の `logIn` が
  `.dev.vars` のローカル用の資格情報で `POST /api/auth/login` を叩き、Cookie を
  ブラウザコンテキストに置く（Playwright は `page.request` と画面で Cookie を共有する）。
  `openTestBook` はその中で呼ぶが、**それを通らないテストは自分で `logIn` を呼ぶ**
- **テスト用 PDF はコードから生成し、生成物をコミットしてある**（`e2e/fixtures/test-book.pdf`）。
  ページ数・目次のネストとページ・図版ページ・各ページの本文は
  `e2e/fixtures/testBookManifest.ts` にあり（`PAGE_COUNT` は現在 12）、spec もそこを読むので
  数値を直接書かない。**manifest か `generateTestBook.ts` を変えたら
  `node e2e/fixtures/generateTestBook.ts` で作り直し、PDF もコミットする**
  （`.ts` を直接実行するので Node 24 が要る）。編集の前に manifest のコメントを読むこと——
  章より先に節のページを置くと生成が落ちる、表紙に空白を入れると span が増えて選択テストの
  前提が崩れる、といった制約がそこにある。フォントは `e2e/fixtures/.cache/` へ自動ダウンロード
  （gitignore 済み）。同じ pdfkit・同じフォントなら出力はバイト単位で再現する
- **CMap を要求する 2 冊目の fixture がある**（`e2e/fixtures/cid-font-book.pdf`。
  `e2e/chatbook.spec.ts` の `a book with CID-keyed fonts renders without asking for a CMap`
  が `CID_FONT_BOOK` として読む）。`test-book.pdf` は使うグリフをすべて埋め込むので
  **`cMapUrl` が無くても白紙にならず**、フォントの `/Encoding` に predefined CMap
  （`UniJIS-UCS2-H`）を名指した本だけがあの経路を通る。**`generateCidFontBook.ts` は
  pdfkit を使わず PDF を直接組み立てる**——pdfkit は常にサブセットを埋め込み、
  predefined CMap を名指す手段が無いため。フォントは埋め込まないので、グリフは
  ブラウザのシステムフォントで描かれる。
  `cMapUrl` を外すと 2 段で落ちる: pdf.js が `cMapUrl` を名指す警告を出し、テキストが
  1 文字も取れないので `POST /api/pdf/open` が `fullText` 空を 400 で拒む
  （`src/server/routes/pdf.ts`）
- **ドラッグしたのに何も選ばれないテストに当たったら、ヘッドレス Chromium の横位置を疑う**。
  ページの `getBoundingClientRect().left` の小数部が .734375 になる位置に来ると、ボタンを
  押したままの移動に選択を伸ばさず新しいキャレットを置き直し、ドラッグが何も選ばなくなる。
  切り分けは 3 手——ページの `left` を測って小数部を見る、
  `pnpm run test:e2e --project=desktop -g "<名前>" --headed` で同じ幅を再現して通るなら実装では
  ない、ウィンドウ幅を 1px ずらす。`main` でも同じ位置なら再現するので、ビューアの作りとは
  無関係なブラウザ側の癖。**踏んだテストだけ幅を固定する**（`e2e/chatbook.spec.ts` の
  "overshooting a line…" が既定の 1280px から 1px ずらして 1281px を指定しているのがそれ。
  ほかの実ドラッグのテストは既定幅か project の `viewport` のままでよい）
- UI の回帰テストを足したら、**実装を壊した状態で落ちること**を必ず確認する。
  ここは「動いていないのに通る」テストが生まれやすい。例: 計測用 canvas はサイズが 0 になる
  瞬間があるため box では検出できず `display` を見る必要があった。fixture の表紙に色を敷くのも
  同じ罠で、文字が 1 つも描けなくても「白紙ではない」判定が通ってしまう（だから表紙は白地に
  文字だけで描いている）

## 実装方針

- TDD（RED→GREEN→REFACTOR）
- ロジックは DOM に依存しない純粋関数へ切り出して単体テストする
  （`keybindings.ts` / `sseParser.ts` / `isSubmitKey.ts` がその例）
- 日本語入力を壊さないこと。Enter の送信判定は `isSubmitKey` を使い、IME 変換中
  (`isComposing` / `keyCode === 229`) は送信しない
- `worker-configuration.d.ts` は commit 済みの生成物。bindings か `main` を変えたときだけ
  `vp exec wrangler types` で再生成して commit する
- `wrangler.jsonc` の `assets.directory` は必ず `./dist/client`。トップレベル `./dist/` にすると
  Worker のビルド成果物（`.dev.vars` を含む）まで静的配信されてしまう
