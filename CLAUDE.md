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
新しく足すときも同じように理由を書くこと（既存10ファイルが手本）。

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

Jotai の atom（`src/front/atoms/`）。`swr` / `zod` / `neverthrow` はテンプレート由来の
未使用依存で、現在どこからも import していない。

- `/` … 本棚（`ShelfPage`）
- `/books/:pdfId` … リーダー（`AppPage`）。URL から `pdfDocAtom` を復元するので
  リロード・直リンクでも開ける

キーバインド（Vim / Emacs）は `src/front/lib/keybindings.ts` の `resolveAction` に
DOM 非依存の純粋関数として実装。`gg` や `C-c t` の2ストロークは `pending` プレフィックスで表現し、
タイマーを持たせない（挙動を決定的にしてテストできるようにするため）。

## テスト

ランナーが3つあり、それぞれ守備範囲が違う:

| ランナー              | 設定                       | 対象                                      |
| --------------------- | -------------------------- | ----------------------------------------- |
| vitest (jsdom)        | `vite.config.ts`           | `src/front/**` の純粋関数・コンポーネント |
| vitest (workers pool) | `vitest.workers.config.ts` | `test/worker/**` の API                   |
| Playwright            | `e2e/playwright.config.ts` | ブラウザ実操作                            |

jsdom テストと Workers pool テストは同一プロセスで共存できないため設定が分かれている
（`vite.config.ts` は `process.env.VITEST` のとき `cloudflare()` を無効化する）。
`vite.config.ts` の `exclude` に `e2e/**` を入れてあり、Playwright の spec を vitest が拾わないようにしている。

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
