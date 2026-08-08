# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

技術書を読みながら、気になった箇所を選択して AI に質問できる PDF リーダー。ローカル専用・ログイン不要。
React 19 (SPA) + Hono (Worker) + D1 + R2 を単一の Cloudflare Workers プロジェクトにまとめ、
`@cloudflare/vite-plugin` で SPA と Worker を同一の `vp dev` で動かす。

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
E2E を1件だけ走らせる: `pnpm run test:e2e -- -g "テスト名の一部"`

`git push` 時に lefthook の `pre-push` が `vp check` + `vp build` を実行し、失敗すると push はブロックされる。

### worktree を作ったら最初に `.dev.vars` を用意する

`.dev.vars` は gitignore 済み（`.gitignore:4`）で **worktree には複製されない**。無いまま
`vp dev`（`pnpm run test:e2e` の自動起動を含む）を動かすと、`@cloudflare/vite-plugin` が
commit 済みの `worker-configuration.d.ts` を再生成し、`DEEPSEEK_API_KEY` の宣言が消えた差分が
毎回出る。worktree を切ったら実装を始める前に用意する:

```bash
echo 'DEEPSEEK_API_KEY=dummy' > .dev.vars
```

型の差分は値ではなく鍵の**存在**で決まるので、ダミー値で消える。ただし DeepSeek へ実際に
問い合わせるテスト（`e2e/chatbook.spec.ts` のチャット系）はダミー値だと認証が通らず、
トークンが 1 つも届かないまま 60 秒のタイムアウトまで粘って落ちる。通したいとき（と E2E 全体を
速く終わらせたいとき）はメインクローンの `.dev.vars` から実キーをコピーする。

`.dev.vars.example` は Cognito 変数だけを列挙しており現在のコードと合っていないので、
コピー元には使わない。

### `useEffect` の扱い

`vite.config.ts` の `no-restricted-imports` が `useEffect` の import を禁止している。
このアプリは canvas 描画・DOM 購読・pdf.js の命令的 API が本質なので使う場面が多いが、
ルールは**残したまま**、使う側が import 行に
`// oxlint-disable-next-line no-restricted-imports -- <理由>` を付けて理由を明記する運用にしている。
新しく足すときも同じように理由を書くこと。

現在 9 ファイルに理由コメントがあり、内訳は次の 4 つしかない。新しく足す `useEffect` も
このどれかに当てはまるはずで、当てはまらないなら書き方を疑うこと:

| 用途                                            | ファイル                                                                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| pdf.js という命令的ライブラリの呼び出しと後始末 | `PdfPage.tsx`（`RenderTask` / `TextLayer`）、`usePdfDocument.ts`（バイナリ取得とドキュメント構築）、`usePdfOutline.ts`（`getOutline` と dest 解決） |
| `document` / `window` / `ResizeObserver` の購読 | `useKeyboardShortcuts.ts`、`SettingsMenu.tsx`、`SelectionPopover.tsx`、`PdfViewer.tsx`                                                              |
| DOM への命令的な書き込み（スクロール位置）      | `ChatMessageList.tsx`（最下部へ追随）、`PdfViewer.tsx`（ページ遷移時のリセット）                                                                    |
| URL という React の外の状態への同期             | `useReadingLocation.ts`                                                                                                                             |

**データ取得は理由にならない**。一覧・本・ハイライト・引用箇所のページ解決は SWR へ
移してある（下記「状態管理とルーティング」）。

**SWR が持っているものを atom へ写すのも理由にならない**。写した瞬間に同じデータが
2 箇所に載り、更新のたびに 1 レンダー遅れる。読み手が少ないなら props で配る
（`AppPage` → `PdfViewer` / `ChatArea` の `book` がその形）。

これと紛らわしいものが 1 つだけある。`useReadingLocation.ts` は
`useSWRImmutable` が解いた「引用箇所のページ番号」を `currentPageAtom` に書く。これは
写しではない: `currentPageAtom` は「読者が今どのページにいるか」というクライアント状態で、
キーボード・ページ送りボタン・目次・URL も書き込む。取得結果はその状態を**一度だけ動かす
きっかけ**であって、サーバのデータを atom に常駐させているわけではない。
**サーバの値がそのまま atom に載り続けるなら写し（禁止）、一度きりの入力なら可**。

## アーキテクチャ

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

### 外部入力のバリデーション（zod）

front と server が交わす形は `src/shared/schemas/` に zod スキーマとして 1 箇所だけ置き、
型は `z.infer` で導出する（`error.ts` / `book.ts` / `selection.ts` / `citation.ts` /
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
  合わない（`"INVALID_RESPONSE"`）——を `ApiError`（`message` / `code` / `status`）に揃えて
  throw する。`fetch` 自体が reject するネットワーク断・abort はここでは包まず、
  `TypeError` / `AbortError` がそのまま呼び出し側へ伝わる
- **`src/server/services/chatService.ts` の `LlmMessage`** は LLM 送信用で `system` role を
  含み、保存される `ChatMessage`（`src/shared/schemas/chat.ts`）とは別物。shared に混ぜないこと

エラー形式は 2 系統あり、**ペイロード `{ code, message }` だけを共通化して transport の差は
残している**。ストリーム開始前は HTTP ステータス + `{ error: { code, message } }`、開始後は
`event: error` + 裸の `{ code, message }`。SSE ではイベント名が判別子なので `error` で包む
意味がない。ワイヤ上の `code` は前方互換のため `z.string()` で受け（読み手は知らない code を
渡す以外にできることがない）、サーバ側の構築だけ `shared/schemas/error.ts` の `ErrorCode`
union + `satisfies` で固定する。

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
`cMapUrl` / `standardFontDataUrl` を渡しており、**これが欠けると日本語 PDF が白紙になる**。

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
- 送信は **必ず `useChatStream` の `sendMessage` を通す**。ポップオーバーからの初回質問も同様。
  ここを生 `fetch` にすると質問文の即時表示と「考え中…」が出なくなる

### DeepSeek の呼び分け

`src/server/services/deepseekService.ts`。モデルは `deepseek-v4-flash`。

| モード      | エンドポイント                                    |
| ----------- | ------------------------------------------------- |
| 通常        | `/chat/completions`（OpenAI SDK 互換）            |
| Web 検索 ON | `/responses` に `tools: [{ type: "web_search" }]` |

Web 検索は既定で ON（`useWebSearchAtom`）。API キーは `.dev.vars` の `DEEPSEEK_API_KEY`。

出典は system prompt で `## Sources` セクションを書かせ、`parseCitations` が抽出する。
PDF 引用は `fullText` 内の位置からページ番号を割り出してジャンプ可能にしている。

なお 209 ページの本では全文をコンテキストに載せるため、最初のトークンまで **10 秒前後** かかる。
ストリーミングが壊れているのと区別すること（`read()` が複数回に分かれるかで判別できる）。

### 状態管理とルーティング

**画面に出しっぱなしにするサーバのデータは SWR、クライアントだけの状態は Jotai の atom**
（`src/front/atoms/`）。両方に同じものを載せないこと。`neverthrow` はテンプレート由来の
未使用依存で、現在どこからも import していない。

- `/` … 本棚（`ShelfPage`）。一覧は `useSWR("/api/pdfs")`
- `/books/:pdfId` … リーダー（`AppPage`）。本は `useBook(pdfId)` で読むので
  リロード・直リンクでも開ける。読んだ本は `PdfViewer` / `ChatArea` へ **props で**
  渡す（atom に写さない。読み手はこの 2 つだけなので prop drilling にならない）

**チャットだけは SWR に載っていない**。`chatMessagesAtom` が持ち、履歴の読み込みは
`AppPage` の `handleSelectionClick` が生の `fetcher` を呼ぶ。理由は、同じ状態を SSE の
ストリームがトークンごとに書き換えるため（`useChatStream`）——キャッシュに載せると
再検証が流れてきた回答を上書きしうる。**「データ取得はすべて SWR」ではない**。
イベントハンドラ起点の 1 回きりの取得（履歴・選択の作成・アップロード）は生の `fetcher`
で書く。

SWR の使い方で押さえるところ:

- **fetcher は必ず `src/front/lib/fetcher.ts` の `fetcher` を通す**（上記
  「外部入力のバリデーション（zod）」）。`useSWR(key, () => fetch(...).then(r => r.json()))`
  のように生 `fetch` を渡すとスキーマ検証を素通りし、`ApiError` / `INVALID_RESPONSE`
  の防護が消える。現在の SWR 呼び出しは全て `fetcher` 経由（PDF バイナリの取得だけは
  JSON ではないので `usePdfDocument` が生の fetch を使うが、これは SWR ではない）
- **ルートの `SWRConfig`**（`src/front/main.tsx`）で `revalidateOnFocus` を切っている。
  ローカル単一ユーザーのアプリでデータは自分の操作でしか変わらず、focus 復帰の再検証は
  Playwright のフォーカス往復で E2E を非決定にするだけ
- **本のキーは `src/front/hooks/useBook.ts` の `bookKey(pdfId)`（= `/api/pdf/:pdfId`）1 本**。
  リーダー（`AppPage`）・ビューア・チャットパネルが同じキーを共有するので本の読み取りは
  1 回で済み、ハイライトの追加も全員に同時に映る。ハイライト一覧は
  `useHighlights` がこのエントリの `selections` から導出する（色のパレット補完込み）ので、
  **専用の atom を作らないこと**——SWR のキャッシュ自体が共有のグローバル state で、
  atom と二重管理すると必ずずれる
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
  `keybindingModeAtom` / `useWebSearchAtom` がその形）
- **テストの差し替え口は 2 つある**。取得そのものを差し替えるなら DI 引数——
  `useBook(pdfId, loadBook)` / `useHighlights(pdfId, loadBook)` /
  `ShelfPage({ loadBooks, deleteBook })` / `FileSelector({ extract })` がその口。
  キャッシュの中身を用意したいなら `src/test/swrTestCache.tsx` の `SwrTestCache` で包む
  （SWR の既定キャッシュはモジュールレベルの singleton なので、包まないとテストが互いの
  キャッシュを見て実行順に依存する。`seed` を渡すとそのキーをサーバの代わりに使う）。
  例外は**書き込まれたキャッシュの中身を検証したいとき**で、`Map` への参照が要るため
  `FileSelector.test.tsx` は自前の `Map` を `SWRConfig` へ直接渡している

キーバインド（Vim / Emacs）は `src/front/lib/keybindings.ts` の `resolveAction` に
DOM 非依存の純粋関数として実装。`gg` や `C-c t` の2ストロークは `pending` プレフィックスで表現し、
タイマーを持たせない（挙動を決定的にしてテストできるようにするため）。

## テスト

ランナーが3つあり、それぞれ守備範囲が違う:

| ランナー              | 設定                       | 対象                                                                                |
| --------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| vitest (jsdom)        | `vite.config.ts`           | `src/**` の `*.test.ts(x)`（`src/front/**` と、workerd を要さない `src/server/**`） |
| vitest (workers pool) | `vitest.workers.config.ts` | `test/worker/**` の API（`SELF.fetch` / D1 / R2 を使うもの）                        |
| Playwright            | `e2e/playwright.config.ts` | ブラウザ実操作                                                                      |

jsdom テストと Workers pool テストは同一プロセスで共存できないため設定が分かれている
（`vite.config.ts` は `process.env.VITEST` のとき `cloudflare()` を無効化する）。

**jsdom 側は `include` を書かず `exclude` だけで拾っている**（`node_modules` / `dist` /
`test/worker/**` / `e2e/**` を除外）。そのため実装とコロケーションした
`src/server/services/*.test.ts` も自動的に jsdom で走る。バインディングを触らない純粋な
サーバロジック（`chatService` の引用パース、`deepseekService` の SSE パースを注入 fetch で
叩くもの）はこちらで書き、workerd の実物が要るものだけ `test/worker/**` に置く。
**`include` を足して絞ると、これらが無言で走らなくなる**ので注意。

### E2E の前提

- **サーバーは Playwright が自動起動する**（`e2e/playwright.config.ts` の `webServer`）。
  `pnpm run db:migrate:local && vp dev --port <port> --strictPort` を実行するので、
  マイグレーション未適用の worktree でもそのまま走る。`reuseExistingServer: false` のため、
  起動済みサーバーには相乗りせず必ずこのチェックアウトのコードでテストする
- **ポートは worktree のパスから決定的に導出する**（5175〜5674 の範囲。`E2E_PORT` で上書き可）。
  5173 固定だと別クローンの `vp dev` に誤接続したまま「成功」しうるため。`--strictPort` により
  導出ポートが埋まっていれば黙って別ポートへ逃げず即座に失敗する
- テスト用 PDF は
  `~/Documents/資料/本/Web開発者のための［入門］Cloudflare-Workers-――JavaScript・TypeScriptの簡単・高速プラットフォーム_00.pdf`（209ページ）。
  無い場合はスキップされる（パスは `e2e/chatbook.spec.ts` の `TEST_PDF` 定数）
- **同じ worktree の dev サーバーと E2E は同じローカル D1 / R2（`.wrangler/`）を共有する**。
  ハイライトは永続化され、テキストレイヤーの上に乗るため、残骸があると後続の選択テストを壊す。
  `openTestBook` ヘルパーが開始前に selection を全削除する
- UI の回帰テストを足したら、**実装を壊した状態で落ちること**を必ず確認する。
  ここは「動いていないのに通る」テストが生まれやすい（例: 計測用 canvas はサイズが 0 になる
  瞬間があるため box では検出できず、`display` を見る必要があった）

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
