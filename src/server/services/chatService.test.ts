import { describe, it, expect } from "vite-plus/test";
import { buildConversation, parseCitations, findPageNumber } from "./chatService";

/** pdfLoader が作る fullText と同じ形 (ページ区切りは \f) */
function fullTextOf(...pages: string[]): string {
  return pages.join("\f");
}

describe("buildConversation", () => {
  it("drops the Sources section from a past answer while leaving the reader's words whole", () => {
    // A reader can paste an answer back to ask about it, so a "## Sources"
    // line of their own must survive
    const quotedBack = `この回答の出典が気になります。\n\n## Sources\n[1] 「エッジ は サーバーレス 実行基盤 です」（本書 第3章）`;
    const history = [
      { role: "user", content: quotedBack },
      {
        role: "assistant",
        content: `エッジで動きます[1]。\n\n## Sources\n[1] 「エッジ は サーバーレス 実行基盤 です」（本書 第3章）`,
      },
    ];

    expect(buildConversation(history, "では冷スタートはどうですか?")).toStrictEqual([
      { role: "user", content: quotedBack },
      { role: "assistant", content: "エッジで動きます[1]。" },
      { role: "user", content: "では冷スタートはどうですか?" },
    ]);
  });
});

describe("findPageNumber", () => {
  it("reports the page a quoted passage was found on", () => {
    const fullText = fullTextOf("まえがき", "エッジ で 動く");

    expect(findPageNumber("エッジで動く", fullText, 2)).toStrictEqual({
      found: true,
      pageNumber: 2,
    });
  });

  it("reports a passage the book does not contain as one it does not hold", () => {
    const fullText = fullTextOf("まえがき", "エッジ で 動く");

    expect(findPageNumber("この本にない一文", fullText, 2)).toStrictEqual({
      found: false,
      miss: "not-in-book",
    });
  });

  it("reports a quote that is only whitespace as having no text to look up", () => {
    const fullText = fullTextOf("まえがき", "エッジ で 動く");

    expect(findPageNumber("  \n ", fullText, 2)).toStrictEqual({
      found: false,
      miss: "no-quote",
    });
  });

  it("blames the empty quote rather than the page count when a one-page book gets one", () => {
    expect(findPageNumber("  ", "エッジ で 動く", 1)).toStrictEqual({
      found: false,
      miss: "no-quote",
    });
  });

  it("says a book of one page has nowhere to jump to", () => {
    expect(findPageNumber("エッジで動く", "エッジ で 動く", 1)).toStrictEqual({
      found: false,
      miss: "single-page-book",
    });
  });

  // Books stored before the extractor delimited pages are searched by ratio, so
  // the passage has to sit in the second half to land on page 2
  const UNDELIMITED = "まえがき の ながい はじめに エッジ で 動く";

  it("estimates the page of a passage an undelimited book holds", () => {
    expect(findPageNumber("エッジで動く", UNDELIMITED, 2)).toStrictEqual({
      found: true,
      pageNumber: 2,
    });
  });

  it("reports a passage an undelimited book does not hold as one it does not hold", () => {
    expect(findPageNumber("この本にない一文", UNDELIMITED, 2)).toStrictEqual({
      found: false,
      miss: "not-in-book",
    });
  });

  it("lands a quote joined across the seam of two excerpt parts on the first part's page", () => {
    // What a question about two chapters that do not touch sends: their pages
    // arrive one after the other with nothing between them, so a model that
    // quotes the end of one part and the start of the next writes a passage the
    // book does not contain. The lookup then does what it does for any reworded
    // quote — the first fragment that is really there is the page the reader is
    // sent to, rather than an error.
    const firstPart =
      "エッジの実行単位はメモリを共有しないので、状態はどこかに預ける必要があります";
    const secondPart = "その預け先として Durable Objects を選ぶと、一貫した読み書きができます";
    const fullText = fullTextOf("まえがき", firstPart, "あいだのページ", secondPart);
    // The first stretch of the join is really on the first part, which is what
    // the fragment fallback looks for once the whole quote matches nothing
    const acrossTheSeam = firstPart.slice(-30) + secondPart.slice(0, 12);

    expect(findPageNumber(acrossTheSeam, fullText, 4)).toStrictEqual({
      found: true,
      pageNumber: 2,
    });
  });
});

describe("parseCitations", () => {
  it("resolves the page of a Japanese-quoted pdf citation to the page holding the passage", () => {
    const fullText = fullTextOf(
      "まえがき",
      "第1章 Cloudflare Workers とは",
      "エッジ は サーバーレス 実行基盤 です",
    );
    const response = `エッジで動きます[1]\n\n## Sources\n[1] 「エッジはサーバーレス実行基盤です」（本書 第3章 3.1）`;

    expect(parseCitations(response, fullText, 3)).toStrictEqual([
      { id: "1", type: "pdf", text: "エッジはサーバーレス実行基盤です", pageNumber: 3 },
    ]);
  });

  it("resolves a passage split across two pages to the page it starts on", () => {
    const fullText = fullTextOf("まえがき", "Workers は グローバル", "ネットワーク で 動きます");
    const response = `本文[1]\n\n## Sources\n[1] 「Workersはグローバルネットワークで動きます」`;

    expect(parseCitations(response, fullText, 3)).toStrictEqual([
      { id: "1", type: "pdf", text: "Workersはグローバルネットワークで動きます", pageNumber: 2 },
    ]);
  });

  it("still finds the page when the model paraphrased part of the passage", () => {
    const fullText = fullTextOf(
      "まえがき",
      "TLS の ハンドシェイク では、クライアント ／ サーバ間 での ラウンドトリップ が発生するため、一定の時間が必要となります",
    );
    // The opening was reworded, but the rest is quoted from the page
    const response = `本文[1]\n\n## Sources\n[1] 「TLSハンドシェイク処理では、クライアント／サーバ間でのラウンドトリップが発生するため、一定の時間が必要となります」`;

    expect(parseCitations(response, fullText, 2)).toStrictEqual([
      {
        id: "1",
        type: "pdf",
        text: "TLSハンドシェイク処理では、クライアント／サーバ間でのラウンドトリップが発生するため、一定の時間が必要となります",
        pageNumber: 2,
      },
    ]);
  });

  it("says a quoted passage is not in the document rather than leaving the page blank", () => {
    // A quote the book does not hold is the reader's only hint that the model
    // reworded it, so the citation carries the reason instead of just no page.
    const fullText = fullTextOf("まえがき", "第1章 Cloudflare Workers とは");
    const response = `本文[1]\n\n## Sources\n[1] 「この文は本文に存在しません」`;

    expect(parseCitations(response, fullText, 2)).toStrictEqual([
      {
        id: "1",
        type: "pdf",
        text: "この文は本文に存在しません",
        pageMiss: "not-in-book",
      },
    ]);
  });

  // The model names the section it is quoting from and then quotes twice, so
  // reading the entry as one block from its first mark to its last stitched the
  // section name onto two passages that do not sit together in the book.
  it("takes the last quoted block when a source entry names its section and quotes twice", () => {
    const fullText = fullTextOf(
      "まえがき",
      "public 、 private は キャッシュ を 共有キャッシュ として 扱って よいか の 指定 に 使います",
      "private で あって ほしい もの には private を 付ける ように して おきましょう",
    );
    const response = `本文[1]\n\n## Sources\n[1] 「public、private」の節：「public、privateはキャッシュを共有キャッシュとして扱ってよいかの指定に使います」「privateであってほしいものにはprivateを付けるようにしておきましょう」`;

    expect(parseCitations(response, fullText, 3)).toStrictEqual([
      {
        id: "1",
        type: "pdf",
        text: "privateであってほしいものにはprivateを付けるようにしておきましょう",
        pageNumber: 3,
      },
    ]);
  });

  // The section is named before the passage is quoted, so the order tells them
  // apart where the length does not: a section title can be the longer of the two
  it("takes the quoted passage even when the section it names is the longer block", () => {
    const fullText = fullTextOf(
      "まえがき",
      "キャッシュ制御ヘッダ の 設計 と 運用 における 注意点",
      "private は 必ず 指定 します",
    );
    const response = `本文[1]\n\n## Sources\n[1] 「キャッシュ制御ヘッダの設計と運用における注意点」の節：「privateは必ず指定します」`;

    expect(parseCitations(response, fullText, 3)).toStrictEqual([
      { id: "1", type: "pdf", text: "privateは必ず指定します", pageNumber: 3 },
    ]);
  });

  // Closing on whichever mark comes first — the shape a single character class
  // gives — would cut an English passage at its apostrophe, so each opening
  // mark is paired with its own kind
  it("keeps an apostrophe that sits inside a double-quoted passage", () => {
    const fullText = fullTextOf("preface", "The runtime doesn't ship a native canvas");
    const response = `本文[1]\n\n## Sources\n[1] "The runtime doesn't ship a native canvas"`;

    expect(parseCitations(response, fullText, 2)).toStrictEqual([
      {
        id: "1",
        type: "pdf",
        text: "The runtime doesn't ship a native canvas",
        pageNumber: 2,
      },
    ]);
  });

  it("keeps a web citation as a url reference without a page number", () => {
    const fullText = fullTextOf("まえがき", "第1章");
    const response = `本文[1]\n\n## Sources\n[1] Cloudflare Docs - https://developers.cloudflare.com/workers/`;

    expect(parseCitations(response, fullText, 2)).toStrictEqual([
      {
        id: "1",
        type: "web",
        text: "Cloudflare Docs",
        url: "https://developers.cloudflare.com/workers/",
      },
    ]);
  });

  // The model links a page in more shapes than the one the prompt asks for, and
  // an entry read as a pdf citation goes looking for an English or Chinese
  // sentence in a Japanese book — the reader gets a grey [n] that says the book
  // does not hold the passage. These three are lines it actually wrote.
  it("keeps a web citation whose url is parenthesised after an em-dashed title", () => {
    const fullText = fullTextOf("まえがき", "第1章");
    const response = `本文[1]\n\n## Sources\n[1] "BFF looks up session in KV, retrieves access token" — GitHub - neilpmas/bezzie: BFF OAuth 2.0 auth library for Cloudflare Workers (https://github.com/neilpmas/bezzie)`;

    expect(parseCitations(response, fullText, 2)).toStrictEqual([
      {
        id: "1",
        type: "web",
        text: "BFF looks up session in KV, retrieves access token",
        url: "https://github.com/neilpmas/bezzie",
      },
    ]);
  });

  it("keeps a web citation whose title holds a hyphen of its own before the url", () => {
    const fullText = fullTextOf("まえがき", "第1章");
    const response = `本文[1]\n\n## Sources\n[1] "A Worker-based BFF works best when the gateway owns client-facing routes" - OneUptime Blog「Backend for Frontend Pattern」 https://raw.githubusercontent.com/OneUptime/blog/refs/heads/master/README.md`;

    expect(parseCitations(response, fullText, 2)).toStrictEqual([
      {
        id: "1",
        type: "web",
        text: "A Worker-based BFF works best when the gateway owns client-facing routes",
        url: "https://raw.githubusercontent.com/OneUptime/blog/refs/heads/master/README.md",
      },
    ]);
  });

  it("keeps a web citation separated from its url by an em dash", () => {
    const fullText = fullTextOf("まえがき", "第1章");
    const response = `本文[1]\n\n## Sources\n[1] "Forwards these authenticated requests to the Hono API via service binding" — Cloudflare Vite Plugin for React Router v7 · Issue #8958 — https://github.com/cloudflare/workers-sdk/issues/8958`;

    expect(parseCitations(response, fullText, 2)).toStrictEqual([
      {
        id: "1",
        type: "web",
        text: "Forwards these authenticated requests to the Hono API via service binding",
        url: "https://github.com/cloudflare/workers-sdk/issues/8958",
      },
    ]);
  });

  // The same entry as the first one, with the passage left out: an entry that
  // quotes nothing is its title, and the brackets that held the link are not
  // part of it
  it("keeps a web citation that names its page without quoting from it", () => {
    const fullText = fullTextOf("まえがき", "第1章");
    const response = `本文[1]\n\n## Sources\n[1] GitHub - neilpmas/bezzie: BFF OAuth 2.0 auth library for Cloudflare Workers (https://github.com/neilpmas/bezzie)`;

    expect(parseCitations(response, fullText, 2)).toStrictEqual([
      {
        id: "1",
        type: "web",
        text: "GitHub - neilpmas/bezzie: BFF OAuth 2.0 auth library for Cloudflare Workers",
        url: "https://github.com/neilpmas/bezzie",
      },
    ]);
  });

  // Only the brackets that held the link go with it. A title closing on one of
  // its own reads as a sentence cut short when it loses it
  it("keeps the closing bracket a web citation's own title ends on", () => {
    const fullText = fullTextOf("まえがき", "第1章");
    const response = `本文[1]\n\n## Sources\n[1] 計算コストの比較（ハッシュ計算は高コスト、ファイル属性の読み取りは低コスト） - https://raw.githubusercontent.com/Alessandro-Pang/fe-interview/refs/heads/main/content/docs/network/network-14.md`;

    expect(parseCitations(response, fullText, 2)).toStrictEqual([
      {
        id: "1",
        type: "web",
        text: "計算コストの比較（ハッシュ計算は高コスト、ファイル属性の読み取りは低コスト）",
        url: "https://raw.githubusercontent.com/Alessandro-Pang/fe-interview/refs/heads/main/content/docs/network/network-14.md",
      },
    ]);
  });

  // A book about Workers prints urls in its own body. What tells a web source
  // apart is that its url stands outside the quotation marks, not that the
  // entry holds one at all
  it("keeps a pdf citation whose quoted passage prints a url of its own", () => {
    const fullText = fullTextOf(
      "まえがき",
      "詳細は https://developers.cloudflare.com/workers/ を参照してください",
    );
    const response = `本文[1]\n\n## Sources\n[1] 「詳細は https://developers.cloudflare.com/workers/ を参照してください」（本書 4.2）`;

    expect(parseCitations(response, fullText, 2)).toStrictEqual([
      {
        id: "1",
        type: "pdf",
        text: "詳細は https://developers.cloudflare.com/workers/ を参照してください",
        pageNumber: 2,
      },
    ]);
  });

  it("estimates the page by position when the stored full text has no page delimiters", () => {
    // 再アップロード前の古いレコードは改行区切りのまま残っている
    const fullText = `${"a".repeat(100)}\n${"b".repeat(100)}目的の文${"c".repeat(100)}`;
    const response = `本文[1]\n\n## Sources\n[1] 「目的の文」`;

    expect(parseCitations(response, fullText, 3)).toStrictEqual([
      { id: "1", type: "pdf", text: "目的の文", pageNumber: 2 },
    ]);
  });

  it("gives a citation neither a page nor a reason when the book has no text to search", () => {
    const response = `本文[1]\n\n## Sources\n[1] 「引用」`;

    expect(parseCitations(response)).toStrictEqual([{ id: "1", type: "pdf", text: "引用" }]);
  });

  it("returns no citations when the answer has no Sources section", () => {
    expect(parseCitations("出典のない回答です", fullTextOf("本文"), 1)).toStrictEqual([]);
  });
});
