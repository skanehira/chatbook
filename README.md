# chatbook

<img width="2032" height="1162" alt="image" src="https://github.com/user-attachments/assets/fcb35a29-3f7a-47c0-86bb-94ee4fcc79dc" />

技術書を読みながら、気になった箇所を選択して AI に質問できる PDF リーダーです。
Cloudflare Workers 上で動くセルフホスト型のアプリで、**利用者 1 人**を前提に作られています。

読んでいる本文をドラッグで選ぶと、その一節を引用したまま AI に質問できます。回答は
ストリーミングで流れ、回答が挙げた出典は本文中のページ番号に解決されるので、そこから
本文へ飛び戻れます。選んだ箇所はハイライトとして残り、読んでいた場所は端末をまたいで
引き継がれます。

## できること

### 本棚に技術書を並べる

本棚の右上「PDFを追加」から PDF を選ぶと、1 ページ目から表紙が作られて本棚に並びます。
カードには表紙とページ数が出て、押すとリーダーが開きます。

同じ本をもう一度追加しても本棚には増えません。**中身が同じなら同じ本として扱われる**ので、
読んでいた場所やハイライトもそのまま残ります。ファイル名を変えて追加し直せば、
本棚の表示名だけが新しくなります。

本を消すときはカードの削除ボタンです。「ハイライトとチャット履歴も削除されます」と確認が
出るとおり、その本に紐づくものは一緒に消えます。

### 気になった箇所を選んで AI に聞く

本文をドラッグで選ぶと、そのまま質問できます。何で触ったかで出るものが変わります。

- **マウス** — 選び終わった位置に入力欄が出ます。「選択した文章について質問する...」に
  書いて「質問する」
- **指** — 画面の下端にバーが出るので「AIに質問」を押します（入力欄を先に出すと、
  フォーカスを取った瞬間に選択が畳まれてしまうためです）

選んだ一節は質問に付いて送られるので、「これはどういう意味?」だけで通じます。回答は
ストリーミングで流れてきます。

本の全文を渡しているので、選んだ箇所だけでなく本の他の場所も踏まえて答えます。その代わり
**200 ページ級の本では最初の一文字が出るまで 10 秒前後**かかります（止まっているわけでは
ありません。DeepSeek での実測なので、接続先を変えれば変わります）。

本文だけでは足りない質問のために **Web 検索が既定で ON** です。設定メニュー（ヘッダの
歯車）の「チャット > Web検索」で切り替えられます（Web 検索を持たないプロバイダに向けて
いるときは、このトグルごと出ません。下記「接続先とモデルを差し替える」）。

### 回答の出典から本文へ戻る

回答の下に出典が並びます。本からの引用にはページ番号が付いていて、押すとそのページへ
飛びます。

引用文が本文に見つからなかったときは、そのことが出典に表示されます。**AI が本文どおりに
引用しなかった可能性**に気付ける唯一の手がかりなので、理由（引用文が空 / 本文に無い /
1 ページの本）を潰さずに出しています。

### ハイライトと会話は残る

質問した箇所はハイライトとしてページに残ります。チャットパネルの「ハイライト N件」の
一覧から選べば、そのときの会話を開き直せます。ページ上のハイライトを直接押しても同じです。

### 続きから読む

ページと開いていた会話が自動で保存されます。本棚から開き直せば続きから始まるので、
**PC で読んでいた本の続きをスマホで開けます**。広い画面では目次とチャットパネルを畳んだ
状態も本ごとに残ります（狭い画面のシートは毎回閉じた状態から始まります）。

リロードや共有リンクで開いたときは、URL が指す場所（`?page=` / `?selection=`）が優先されます。
古いリンクを開いて何もせずに閉じても、別の端末の読書位置は動きません。

### 読み方を調整する

- **目次** — ヘッダの「目次を表示」から。今読んでいるページを含む項目が強調されます。
  目次を持たない本では「この本には目次がありません」と出ます
- **見開き** — PDF を表示する領域に 2 ページ分の幅があれば、自動で 2 ページ並べます。
  チャットパネルを畳んだり、ページを縮めたりすると 2 ページになります
- **拡大・縮小** — Ctrl + ホイール（トラックパッドならピンチ）、指ならピンチ。
  倍率は**本ごとに覚えます**
- **ページ送り** — ページの左右をクリック / タップ、指なら左右スワイプ、キーボードでも。
  拡大しているときは端を触ってもページは送らず、ページの中を動きます

**方向キーはどの設定でも効きます**（「なし」を選んでいても）。Shift を押しながらの方向キーは
文字の選択に使うので、そちらは奪いません。

| 操作           | 方向キー |
| -------------- | -------- |
| 次のページ     | `→`      |
| 前のページ     | `←`      |
| 下にスクロール | `↓`      |
| 上にスクロール | `↑`      |

それに加えて、設定メニューから Vim / Emacs / なし を選べます（既定は Vim）。

| 操作           | Vim  | Emacs   |
| -------------- | ---- | ------- |
| 次のページ     | `l`  | `C-f`   |
| 前のページ     | `h`  | `C-b`   |
| 下にスクロール | `j`  | `C-n`   |
| 上にスクロール | `k`  | `C-p`   |
| 目次の開閉     | `t`  | `C-c t` |
| 最初のページ   | `gg` | `M-<`   |
| 最後のページ   | `G`  | `M->`   |

### スマホ・タブレットでも読める

狭い画面では 1 カラムになり、下端のツールバーの両端が目次とチャットになります。チャットは
下から出るシートで、半分の高さと画面いっぱいを切り替えられます。ページを読み進めながら
回答を読めるよう、シートを開いていてもページ送りは残ります。

タブレットのように「画面は広いが指で触る」端末でも、選択したときは指向けのバーが出ます。

## 使う前に知っておくこと

- **利用者 1 人向けです。** ログインした人が全データの持ち主で、アカウントを分ける仕組みは
  ありません。複数人で使うにはスキーマから設計し直す必要があります
- **AI の回答には LLM の API キーが要ります。** 自分で用意して、自分で使った分を払う
  形になります。キーが無くても PDF を読む・ハイライトを付けるところまでは動きます。
  既定の接続先は DeepSeek ですが、OpenAI 互換の API なら環境変数だけで差し替えられます
  （下記「接続先とモデルを差し替える」）
- **スマホからは公開 URL を使ってください。** セッション Cookie に `Secure` を付けているため、
  LAN の `http://192.168.x.x:5173` ではブラウザが Cookie を保存せずログインできません
- **端末を失くしたときの取り消し手段は `AUTH_SESSION_SECRET` の入れ替えだけです。**
  セッションはサーバに記録を持たないので個別には失効させられず、入れ替えると自分の端末も
  含めて全部ログアウトになります

## 技術スタック

React 19 の SPA と Hono の Worker を **1 つの Cloudflare Workers プロジェクト**にまとめ、
`@cloudflare/vite-plugin` で両方を同じ開発サーバーから動かしています。

| 領域                   | 使っているもの                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| フロントエンド         | React 19 / React Router / Jotai（クライアント状態）/ SWR（サーバのデータ）/ Tailwind CSS 4 |
| PDF                    | pdfjs-dist 5（描画・テキスト抽出・表紙生成はすべてブラウザ側）                             |
| サーバー               | Hono（Cloudflare Workers）                                                                 |
| データベース           | Cloudflare D1 + Drizzle ORM                                                                |
| オブジェクトストレージ | Cloudflare R2                                                                              |
| LLM                    | OpenAI 互換 API（既定は DeepSeek の `deepseek-v4-flash`。OpenAI SDK 経由）                 |
| バリデーション         | zod（`src/shared/schemas/` にフロント・サーバ共通のスキーマ）                              |
| エラーの運搬           | neverthrow（`ResultAsync`）                                                                |
| ツールチェーン         | [Vite+](https://viteplus.dev)（`vp`）/ Vitest / Playwright                                 |

`vp` は devDependency として同梱しているので、グローバルへの install は要りません
（`pnpm exec vp <サブコマンド>` で呼べます）。

設計上の判断とその理由は [`CLAUDE.md`](CLAUDE.md) に、テキスト選択とハイライトの実装
（pdf.js の座標変換や DOM 契約など、見た目では気付きにくい落とし穴）は
[`docs/PDF_TEXT_SELECTION.md`](docs/PDF_TEXT_SELECTION.md) にまとめてあります。

## 必要要件

- Node.js 24
- pnpm 11（`packageManager` フィールドで固定してあります）
- Cloudflare アカウント（Workers / D1 / R2）
- OpenAI 互換の LLM API キー（AI への質問を使う場合。既定の接続先は DeepSeek。
  差し替えは下記「接続先とモデルを差し替える」）

## デプロイ

初回は**順番が重要**です。

```bash
# 1. Cloudflare にログイン
pnpm exec wrangler login

# 2. D1 と R2 を作る
pnpm exec wrangler d1 create chatbook-db
pnpm exec wrangler r2 bucket create chatbook-pdfs
```

`d1 create` が出力した `database_id` を `wrangler.jsonc` の `d1_databases[0].database_id`
に書きます。**初期値は作者の環境の ID なので、必ず自分の値へ置き換えてください**
（D1 の ID はアカウントの API トークンが無ければ使えないため秘密ではありませんが、
そのままでは自分のデータベースに繋がりません）。Worker 名やバケット名を変えたい場合も
`wrangler.jsonc` を編集してください。

```bash
# 3. マイグレーションをリモートの D1 に当てる（デプロイより先）
pnpm exec vp build
pnpm exec wrangler d1 migrations apply chatbook-db --remote

# 4. デプロイ
pnpm run deploy

# 5. 秘密を入れる（Worker が存在してから）
pnpm exec wrangler secret put LLM_API_KEY   # DeepSeek 以外に向けるなら「接続先とモデルを差し替える」も見る
pnpm exec wrangler secret put AUTH_USERNAME
pnpm exec wrangler secret put AUTH_PASSWORD
pnpm exec wrangler secret put AUTH_SESSION_SECRET
# room-simulator とログインを共有するときだけ（例: <account>.workers.dev）
pnpm exec wrangler secret put SESSION_COOKIE_DOMAIN
```

`AUTH_USERNAME` / `AUTH_PASSWORD` がログインに使う ID とパスワード、
`AUTH_SESSION_SECRET` はセッション Cookie の署名鍵です（ランダムな長い値にしてください）。
**この 3 つのどれかが空だと API はすべて閉じたまま**になります。設定を忘れたまま公開して
しまう事故を防ぐためで、初回のデプロイは意図的に閉じた状態で出ます。

### room-simulator とログインを共有する

同じ Cloudflare アカウントの room-simulator とログインを共有する場合は、両 Worker の
`AUTH_USERNAME` / `AUTH_PASSWORD` / `AUTH_SESSION_SECRET` を同じ値にし、さらに
`SESSION_COOKIE_DOMAIN` も同じ `<account>.workers.dev` に設定してください。両アプリは
`account_session` Cookie を共有するため、片方でログインすればもう片方でもログイン済みに
なり、片方でログアウトすると両方からログアウトします。

ローカルの `.dev.vars.example` では `SESSION_COOKIE_DOMAIN` を空にしてあります。この場合は
`Domain` 属性を付けないホスト限定 Cookie になります。ただし Cookie はポートを区別しないため、
両アプリを同じ `localhost` の別ポートで開くと `account_session` は共有されます。ローカルで
セッションを分離したいときは、アプリごとに別のブラウザプロファイルを使ってください。

以前のバージョンが発行した `chatbook_session` は引き継ぎません。Cookie共有対応版へ更新した
直後だけ、`account_session` を発行するために一度ログインし直してください。

既存の chatbook Worker で共有を有効にするときは、**この対応版をデプロイする前に**
`wrangler secret put SESSION_COOKIE_DOMAIN` を実行してください。旧コードはこの追加Bindingを
参照しないため、先に設定しても挙動は変わりません。新コードの初回ログインから共有Domainを
使うことで、同名のhost-only Cookieとの共存を防げます。

対応版をDomain未設定のまま既に使った場合は、`SESSION_COOKIE_DOMAIN` を設定する前にchatbookから
ログアウトしてください。設定後にhost-only版とDomain版の `account_session` が共存した場合は、
ブラウザのサイトデータから古いhost-only Cookieを削除してからログインし直してください。Cookieは
作成時と同じDomain属性でしか削除できないため、現在の設定だけでは別スコープのCookieを消せません。

順番の理由:

- **マイグレーションはデプロイより先。** 列を足したマイグレーションが当たっていない D1 に
  新しいコードを載せると、本を開く経路ごと 500 になります。列の追加は旧コードに無害なので、
  先に当てるのが常に安全です
- **`vp build` を先に。** `d1 migrations apply` は `dist/chatbook/wrangler.json` を読むので、
  ビルドを飛ばすと古い設定が使われます
- **`secret put` はデプロイの後。** Worker がまだ無い状態で実行すると対話プロンプトが出ます。
  `secret put` は既存 Worker に新しいバージョンを自動で配るので、入れ終わったあとの
  再デプロイは要りません
- `.dev.vars` はローカル専用で、デプロイには乗りません

鍵がかかっていることの確認は、公開 URL に対する 401 が唯一の証拠です:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<your-worker>.workers.dev/api/pdfs  # 401
```

2 回目以降の更新は `pnpm run deploy` だけです（マイグレーションを足したときは、先に
`vp build` → `d1 migrations apply --remote` を実行してください）。

## 接続先とモデルを差し替える

回答を書くのは、**接続先（プロバイダ）とモデル**の組み合わせです。4 つの環境変数で決まり、
**接続先とモデルを設定しなければ DeepSeek** になります。

| 変数                       | 値の例                      | 空 / 未設定のとき                                          |
| -------------------------- | --------------------------- | ---------------------------------------------------------- |
| `LLM_API_KEY`              | `sk-…`                      | チャットが 500（`CONFIG_ERROR`）で返る                     |
| `LLM_BASE_URL`             | `https://api.openai.com/v1` | `https://api.deepseek.com`                                 |
| `LLM_MODEL`                | `gpt-5.2`                   | `deepseek-v4-flash`                                        |
| `LLM_WEB_SEARCH_SUPPORTED` | `false`                     | 対応しているものとして扱う（`"false"` / `"0"` だけが否定） |

**すべて文字列です。**とくに `LLM_WEB_SEARCH_SUPPORTED` は文字列 `"false"` / `"0"` との
完全一致でしか否定として読まないので、`wrangler.jsonc` に JSON の真偽値（`false`）で書くと
「対応あり」に落ちます。

`LLM_BASE_URL` は **`/chat/completions` や `/responses` を後ろに繋ぐ 1 つ手前まで**を書きます
（`/v1` が要るかはプロバイダの流儀次第です。OpenAI は要り、DeepSeek は要りません）。
**末尾にスラッシュを付けないでください**——通常のチャットは SDK が吸収しますが、Web 検索は
文字列を繋ぐだけなので `…/v1//responses` になって Web 検索だけが壊れます。

差し替え先に求める条件は 2 つです。**OpenAI 互換の `/chat/completions` を持つこと**と、
**`stream_options: { include_usage: true }` を受け付けること**（毎回送るので、未知の
パラメータを拒む実装では通りません）。プロバイダごとの差を吸収する層は持っていません。

### どこに書くか

秘密は `LLM_API_KEY` だけです。残り 3 つは `wrangler.jsonc` の `vars` に書きます:

```jsonc
"vars": {
  "LLM_BASE_URL": "https://api.openai.com/v1",
  "LLM_MODEL": "gpt-5.2",
  "LLM_WEB_SEARCH_SUPPORTED": "false"
}
```

**`wrangler.jsonc` は git に入ります。`LLM_API_KEY` をここに書かないでください**（キーは
必ず `wrangler secret put`）。また **`vars` を足したら `worker-configuration.d.ts` が
書き換わります**（`pnpm install` の `postinstall` が `wrangler types` を回すため）。
自分の fork では再生成された型を一緒にコミットしてください。

ローカルで試すときは `.dev.vars` に書きます（`vars` より優先されます）。空のままなら
既定値に落ちるので、値を入れるまでは DeepSeek のままです。

### Web 検索を持たないプロバイダ

Web 検索は Responses API（`/responses` + `web_search` ツール）を使います。これを持たない
プロバイダでは `LLM_WEB_SEARCH_SUPPORTED` を `"false"` にしてください。設定メニューから
Web 検索のトグルが消え、サーバも常に `/chat/completions` で尋ねるようになります。

**対応しているか分からなければ `"false"` にしておくのが安全です。**間違いの代償が非対称で、
不要に `"false"` にしても回答は出ますが、非対応なのに対応ありのままにすると Web 検索を
有効にした質問がすべて失敗します。あとから外せます。

### 乗り換えの手順

Worker が既にあるので、`secret put` を先にできます（初回デプロイが「デプロイ →
`secret put`」なのは、Worker がまだ無いと対話プロンプトが出るためで、そこと逆になります）。

```bash
# 1. wrangler.jsonc の vars に接続先とモデルを書く（上記「どこに書くか」）
# 2. 新しいプロバイダのキーを入れる
pnpm exec wrangler secret put LLM_API_KEY
# 3. vars を反映する
pnpm run deploy
# 4. 古いキーを片付ける
pnpm exec wrangler secret delete DEEPSEEK_API_KEY   # 旧バージョンから移ってきた場合のみ
```

**2 と 3 の間の数十秒は、新しいキーで古い接続先を叩くのでチャットが失敗します。**

**うまくいったかは、本を 1 冊開いて 1 問投げるのが唯一の確認方法です。**接続先とモデル名は
`GET /api/config` にも出さない（画面が必要とするのは Web 検索の可否だけ）ので、
デプロイ節の 401 に相当する外形チェックはありません。回答がストリームで流れてくれば成功です。
`"false"` にしたなら、設定メニューから Web 検索のトグルが消えていることも証拠になります
（**開いたままのタブでは変わりません。リロードしてから見てください**）。

失敗したときの切り分けは 3 通りです。

| 見え方                                | 原因                                                            |
| ------------------------------------- | --------------------------------------------------------------- |
| 500（`CONFIG_ERROR`）                 | `LLM_API_KEY` が空。ほかは全部届いている                        |
| チャットパネルにエラー（HTTP は 200） | キー違い / 接続先の打ち間違い / モデル名違い / Web 検索の非対応 |
| 401                                   | ログインが切れている。設定とは無関係                            |

2 行目はサーバまでは届いていて、上流が断ったか届かなかったケースです。中身は
`pnpm exec wrangler tail` でサーバのログから読めます。

### 元に戻す

`secret put` だけでは戻りません。`wrangler.jsonc` の `vars` から 3 つを消して
`pnpm run deploy` し、DeepSeek のキーで `wrangler secret put LLM_API_KEY` を入れ直します。

### 旧バージョンから移ってくる場合

キーの名前が `DEEPSEEK_API_KEY` から `LLM_API_KEY` に変わりました。**接続先とモデルは
既定値のままで今までどおり DeepSeek に向きますが、キーだけは入れ直しが要ります**
（入れないままだとチャットが 500 で止まります）。本番は上記「乗り換えの手順」の 2 → 3 → 4、
ローカルは `.dev.vars` の `DEEPSEEK_API_KEY=` を `LLM_API_KEY=` に書き換えてください。

## ローカル開発

```bash
pnpm install
cp .dev.vars.example .dev.vars   # ログインは demo / demo（ローカル専用の値）
pnpm run db:migrate:local        # D1 のマイグレーション（初回と migrations 追加時のみ）
pnpm exec vp dev                 # http://localhost:5173
```

`.dev.vars` は**必ず用意してください**。`AUTH_*` が無いと API はすべて 401 になり、画面も
E2E も動きません。

`.dev.vars.example` の `LLM_API_KEY` はダミー値です。PDF を開いて読む・ハイライトを
付けるところまではダミーのまま動きますが、**AI の回答を実際に生成するには実キーが要ります**。
`LLM_BASE_URL` / `LLM_MODEL` / `LLM_WEB_SEARCH_SUPPORTED` は**値を空にした行**で並べてあります。
別のプロバイダをローカルで試すときはここに値を入れて `vp dev` で確かめられます
（上記「接続先とモデルを差し替える」）。
`SESSION_COOKIE_DOMAIN` も空のままならホスト限定 Cookie になります。同じ `localhost` の
別ポートは同じホストなので、ポートだけを変えてもCookieは分離されません。

**行を消したり並べ替えたりしないでください。** `worker-configuration.d.ts` は `.dev.vars` に
あるキーの一覧**と並び順**から生成されるので、どちらを変えてもコミット済みの型に差分が出ます。
値は空でもダミーでも型に影響しません。

## テスト

```bash
pnpm test              # フロント単体（jsdom）
pnpm run test:worker   # Worker 単体（@cloudflare/vitest-pool-workers）
pnpm run test:e2e      # E2E（Playwright。サーバーは自動起動するので vp dev は不要）
pnpm exec vp check     # フォーマット + lint + 型チェック（--fix で自動修正）
```

E2E は `desktop` / `tablet` / `mobile` の 3 プロジェクトに分かれています
（`pnpm run test:e2e --project=tablet` で 1 つだけ実行）。ウィンドウ幅がレイアウトを、
ポインタの種類が入力の経路を決めるため、意味のある組み合わせごとに実行を分けています。

## 貢献

作者 1 人が自分のために作っているアプリなので機能追加の採否は読めませんが、バグ報告と
その修正は歓迎します（[CONTRIBUTING.md](CONTRIBUTING.md)）。**脆弱性は公開の Issue では
なく** [SECURITY.md](SECURITY.md) の手順で報告してください。

## ライセンス

[MIT](LICENSE)
