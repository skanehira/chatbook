import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { SWRConfig } from "swr";
import { AppPage } from "./AppPage";
import { bookKey } from "../hooks/useBook";
import { SwrTestCache } from "../../test/swrTestCache";
import type { BookDetail, LocatedPage } from "../../shared/schemas/book";
import type { ChatMessage } from "../../shared/schemas/chat";
import type { SelectionHighlight } from "../../shared/schemas/selection";
import { PHONE_WIDTH, setViewportWidth } from "../../test/viewport";

const A_PASSAGE = "エッジはサーバーレス実行基盤で、実行単位をまたいでメモリを共有できません。";
const A_SECOND_PASSAGE = "Workers は V8 isolate の上で動きます。";
const B_PASSAGE = "Durable Objects は単一のインスタンスに処理を集約します。";

/**
 * What the viewer says in place of a page. jsdom has no pdf.js, and the stub
 * above refuses the binary, so this is the whole of the PDF side on screen.
 */
const PANE_WITHOUT_A_PAGE =
  "PDFを表示できません: request to /api/pdf/bookA/file failed with status 404";

function highlight(id: string, selectedText: string, pageNumber = 1): SelectionHighlight {
  return {
    id,
    selectedText,
    pageNumber,
    positionData: { rects: [] },
    color: "#FFEB3B",
    createdAt: "2026-08-01T10:00:00.000Z",
  };
}

const BOOK_A: BookDetail = {
  id: "bookA",
  fileName: "Cloudflare Workers.pdf",
  pageCount: 209,
  hasThumbnail: true,
  hasOutline: true,
  // The second one is pages away, so what a highlight does to the page the
  // reader is on can be told apart from doing nothing at all
  selections: [highlight("a1", A_PASSAGE), highlight("a2", A_SECOND_PASSAGE, 30)],
  readingState: null,
};

const BOOK_B: BookDetail = {
  id: "bookB",
  fileName: "Durable Objects.pdf",
  pageCount: 120,
  hasThumbnail: true,
  hasOutline: true,
  selections: [highlight("b1", B_PASSAGE)],
  readingState: null,
};

/** An answer already in a highlight's conversation, for the reader to leave behind. */
const AN_ANSWER: ChatMessage = {
  id: "m1",
  role: "assistant",
  content: "エッジではメモリを共有できないため、状態は Durable Objects に置きます。",
  citations: null,
  createdAt: "2026-08-03T10:00:00.000Z",
};

/** An answer already in the book's own conversation. */
const BOOK_ANSWER: ChatMessage = {
  id: "m2",
  role: "assistant",
  content: "この本は Workers の分離と状態の置き場所を扱っています。",
  citations: null,
  createdAt: "2026-08-04T10:00:00.000Z",
};

/** The book's own endpoint, as opposed to the binary or a chat under it. */
const isBookRequest = (url: string) => /^\/api\/pdf\/[^/]+$/.test(url);

/**
 * Answers the requests the reader makes on its own: the PDF binary (which jsdom
 * cannot render anyway) and the chat history of a highlight that is opened.
 *
 * `holdTheBook` leaves the request for the book itself hanging forever. That is
 * how a test shows the reader opened the book without waiting for the server:
 * anything on screen got there from the cache, because nothing else can arrive.
 */
function readerFetchStub({
  holdTheBook = false,
  /** Id of the one highlight whose conversation the server refuses to hand over. */
  refuseChatHistoryFor,
  /** The answer the lookup of a linked passage gets, or a refusal of it. */
  locate = { found: false, miss: "not-in-book" } as const,
  refuseLocate = false,
  refuseReadingStateSave = false,
  /** What a highlight's conversation holds when it is opened. */
  chatHistory = [],
  /** What the book's own conversation holds when it is opened. */
  bookChatHistory = [],
}: {
  holdTheBook?: boolean;
  refuseChatHistoryFor?: string;
  locate?: LocatedPage;
  refuseLocate?: boolean;
  refuseReadingStateSave?: boolean;
  chatHistory?: ChatMessage[];
  bookChatHistory?: ChatMessage[];
} = {}) {
  const urls: string[] = [];
  // Every caller here reaches the network through `fetcher`, which is only
  // ever handed a url string.
  const fetchFn = (url: string) => {
    urls.push(url);
    if (url.endsWith("/reading-state")) {
      const body = refuseReadingStateSave
        ? { error: { code: "INTERNAL_ERROR", message: "Unexpected server error" } }
        : { saved: true };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: refuseReadingStateSave ? 500 : 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url.includes("/locate?")) {
      if (refuseLocate) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { code: "PDF_NOT_FOUND", message: "PDF not found" } }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify(locate), { status: 200 }));
    }
    if (url.endsWith("/chats")) {
      // The book's own conversation is reached without a highlight in the path,
      // and is named as such in the answer.
      if (!url.includes("/selections/")) {
        return Promise.resolve(
          new Response(JSON.stringify({ selectionId: null, messages: bookChatHistory }), {
            status: 200,
          }),
        );
      }
      const selectionId = url.split("/selections/")[1].split("/")[0];
      const refused = selectionId === refuseChatHistoryFor;
      // The whole envelope, not just `messages`: the reader checks it against
      // chatHistorySchema and reports anything else as an unreadable response.
      const body = refused
        ? { error: { code: "SELECTION_NOT_FOUND", message: "Selection not found" } }
        : { selectionId, messages: chatHistory };
      return Promise.resolve(new Response(JSON.stringify(body), { status: refused ? 404 : 200 }));
    }
    if (holdTheBook && isBookRequest(url)) {
      return new Promise<Response>(() => {});
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };
  return { urls, fetchFn };
}

/**
 * The query string, on screen, so a test can read what the reader put there.
 *
 * jsdom has no pdf.js, so the viewer never draws a page and its toolbar — where
 * the page being read is otherwise shown — is not on screen at all.
 */
function ShowSearch() {
  // Named and sorted, since where a parameter lands in the query depends on the
  // order the link happened to spell them in
  const named: string[] = [];
  new URLSearchParams(useLocation().search).forEach((value, key) => named.push(`${key}=${value}`));
  return <p>{`URL: ${named.sort().join(" ")}`}</p>;
}

/** Lets a test leave the book it is on, the way the shelf link would. */
function OpenOtherBook({ pdfId }: { pdfId: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(`/books/${pdfId}`)}>
      別の本を開く
    </button>
  );
}

/**
 * Opens the book through a `#:~:text=` link naming 「存在しない」. The fragment is
 * read off the navigation entry, since the browser strips it from location.hash
 * before scripts can see it.
 */
function linkTo(pdfId: string) {
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([
    {
      name: `http://localhost/books/${pdfId}#:~:text=%E5%AD%98%E5%9C%A8%E3%81%97%E3%81%AA%E3%81%84`,
    },
  ] as PerformanceEntry[]);
}

function renderReader(
  pdfId: string,
  seed: Record<string, unknown>,
  options: {
    holdTheBook?: boolean;
    refuseChatHistoryFor?: string;
    locate?: LocatedPage;
    refuseLocate?: boolean;
    refuseReadingStateSave?: boolean;
    search?: string;
    chatHistory?: ChatMessage[];
    bookChatHistory?: ChatMessage[];
  } = {},
) {
  const { urls, fetchFn } = readerFetchStub(options);
  vi.stubGlobal("fetch", fetchFn);

  render(
    <SwrTestCache seed={seed}>
      {/* Seeded entries are revalidated on mount here, as they are in the app.
          What the reader shows before that lands is what these tests are about. */}
      <SWRConfig value={{ revalidateIfStale: true }}>
        <MemoryRouter initialEntries={[`/books/${pdfId}${options.search ?? ""}`]}>
          <OpenOtherBook pdfId={BOOK_B.id} />
          <ShowSearch />
          <Routes>
            <Route path="/books/:pdfId" element={<AppPage />} />
          </Routes>
        </MemoryRouter>
      </SWRConfig>
    </SwrTestCache>,
  );
  return { urls };
}

describe("AppPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens a book already in the cache without waiting for the server", async () => {
    // Nothing will answer for the book, so anything on screen came from the
    // entry the upload filed under this key
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A }, { holdTheBook: true });

    expect(screen.getByText(BOOK_A.fileName)).toBeInTheDocument();
    expect(screen.getByText(A_PASSAGE)).toBeInTheDocument();
  });

  it("leaves the chat of the book being read behind when another book is opened", async () => {
    renderReader(BOOK_A.id, {
      [bookKey(BOOK_A.id)]: BOOK_A,
      [bookKey(BOOK_B.id)]: BOOK_B,
    });

    // Opening a highlight puts its passage on screen, above the conversation
    await userEvent.click(await screen.findByText(A_PASSAGE));
    expect(screen.getByRole("button", { name: "一覧に戻る" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "別の本を開く" }));

    expect(await screen.findByText(BOOK_B.fileName)).toBeInTheDocument();
    expect(screen.getByText(B_PASSAGE)).toBeInTheDocument();
    expect(screen.queryByText(A_PASSAGE)).not.toBeInTheDocument();
  });

  it("says the reader's place could not be saved rather than dropping it in silence", async () => {
    // Losing this quietly means the next device opens the book somewhere the
    // reader never was, with nothing on screen to explain it.
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A }, { refuseReadingStateSave: true });

    // Opening a highlight moves the reader's place, which is what gets saved
    await userEvent.click(await screen.findByText(A_PASSAGE));

    expect(
      await screen.findByText("読書位置を保存できませんでした: Unexpected server error"),
    ).toBeInTheDocument();
  });

  it("says the conversation could not be read instead of showing it as empty", async () => {
    // An empty conversation and one that failed to load looked identical: the
    // catch put an empty list on screen either way.
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A }, { refuseChatHistoryFor: "a1" });

    await userEvent.click(await screen.findByText(A_PASSAGE));

    // The viewer reports the missing binary of the same book at the same time,
    // so this looks for the chat panel's own words rather than any alert.
    expect(
      await screen.findByText("チャット履歴を読み込めませんでした: Selection not found"),
    ).toBeInTheDocument();
  });

  it("drops the failed conversation's message when another highlight is opened", async () => {
    // Left behind, it would sit over a conversation it says nothing about.
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A }, { refuseChatHistoryFor: "a1" });

    await userEvent.click(await screen.findByText(A_PASSAGE));
    expect(
      await screen.findByText("チャット履歴を読み込めませんでした: Selection not found"),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "一覧に戻る" }));
    await userEvent.click(screen.getByText(A_SECOND_PASSAGE));

    // The second conversation is open, and the first one's failure is not on it
    expect(await screen.findByPlaceholderText("質問を入力...")).toBeInTheDocument();
    expect(
      screen.queryByText("チャット履歴を読み込めませんでした: Selection not found"),
    ).toBeNull();
  });

  it("leaves the highlight's conversation behind when the reader asks about the book itself", async () => {
    renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: BOOK_A },
      { chatHistory: [AN_ANSWER], bookChatHistory: [BOOK_ANSWER] },
    );

    await userEvent.click(screen.getByText(A_PASSAGE));
    expect(await screen.findByText(AN_ANSWER.content)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "一覧に戻る" }));
    await userEvent.click(screen.getByRole("button", { name: "本について質問する" }));

    // What the book itself had been asked, read back under the same panel: the
    // two conversations are told apart by the id being null, and an answer the
    // client refuses to read would leave the reader an error instead.
    expect(await screen.findByText(BOOK_ANSWER.content)).toBeInTheDocument();
    expect(screen.queryByText(/チャット履歴を読み込めませんでした/)).toBeNull();
    // And not the answers to a passage the reader has just stepped away from.
    expect(screen.queryByText(AN_ANSWER.content)).toBeNull();
    expect(screen.getByRole("button", { name: "範囲: 本全体" })).toBeInTheDocument();
  });

  it("says a linked passage is not in the book rather than only that it was not found", async () => {
    linkTo(BOOK_A.id);
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    expect(
      await screen.findByText("リンクされた箇所が本文に見つかりませんでした: 存在しない"),
    ).toBeInTheDocument();
  });

  it("says a book of one page has nowhere to jump to rather than blaming the passage", async () => {
    linkTo(BOOK_A.id);
    renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: BOOK_A },
      { locate: { found: false, miss: "single-page-book" } },
    );

    expect(
      await screen.findByText("この本は1ページなので移動先がありません: 存在しない"),
    ).toBeInTheDocument();
  });

  it("says the lookup itself did not answer rather than that the book lacks the passage", async () => {
    linkTo(BOOK_A.id);
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A }, { refuseLocate: true });

    expect(
      await screen.findByText("リンクされた箇所を探せませんでした: 存在しない"),
    ).toBeInTheDocument();
  });

  it("reopens the chat its URL names, on the page that URL was left at", async () => {
    // The highlight sits on page 1, so a reader who had scrolled on to page 5
    // and reloaded would be dragged back to it if the restore moved the page.
    const { urls } = renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: BOOK_A },
      { search: "?page=5&selection=a1" },
    );

    expect(await screen.findByRole("button", { name: "一覧に戻る" })).toBeInTheDocument();
    expect(urls).toContain(`/api/pdf/${BOOK_A.id}/selections/a1/chats`);
    // Still page 5: reopening the chat is not the reader picking it off the list
    expect(screen.getByText("URL: page=5 selection=a1")).toBeInTheDocument();
  });

  it("goes to the passage of a highlight picked off the list", async () => {
    // The other half of the restore above: choosing a highlight is the reader
    // asking to be taken to it, so here the page does move.
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    await userEvent.click(await screen.findByText(A_SECOND_PASSAGE));

    expect(screen.getByText("URL: page=30 selection=a2")).toBeInTheDocument();
  });

  it("shows the highlight list when the URL names a chat the book no longer has", async () => {
    const { urls } = renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: BOOK_A },
      { search: "?selection=deleted" },
    );

    expect(await screen.findByText(A_PASSAGE)).toBeInTheDocument();
    expect(urls.some((url) => url.endsWith("/chats"))).toBe(false);
    // And the URL stops naming it, rather than restoring nothing every reload
    expect(screen.getByText("URL: page=1")).toBeInTheDocument();
  });

  it("opens with the panel folded away when that is how the book was left", async () => {
    const foldedAway: BookDetail = {
      ...BOOK_A,
      readingState: {
        page: 1,
        selectionId: null,
        bookChat: null,
        outlineOpen: null,
        chatPanelOpen: false,
      },
    };
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: foldedAway });

    expect(await screen.findByRole("button", { name: "チャットを表示" })).toBeInTheDocument();
    expect(screen.queryByText(A_PASSAGE)).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("folds the panel away and brings it back on the toggle, leaving the URL on the page", async () => {
    // Which panel is folded is the book's, not the address bar's: writing it
    // here would make folding one a place in the history to go back to.
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    expect(await screen.findByText(A_PASSAGE)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "チャットを隠す" }));
    expect(screen.queryByText(A_PASSAGE)).toBeNull();
    expect(screen.getByText("URL: page=1")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "チャットを表示" }));
    expect(screen.getByText(A_PASSAGE)).toBeInTheDocument();
    expect(screen.getByText("URL: page=1")).toBeInTheDocument();
  });

  it("keeps both panel toggles together in the header", async () => {
    // The outline used to fold from a button under the page, which is a
    // different place from the one that folds the chat even though the two do
    // the same kind of thing — and it went out of reach as soon as the page
    // was scrolled.
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    const header = await screen.findByRole("banner");
    const outline = within(header).getByRole("button", { name: "目次を隠す" });
    expect(within(header).getByRole("button", { name: "チャットを隠す" })).toBeInTheDocument();

    await userEvent.click(outline);

    expect(within(header).getByRole("button", { name: "目次を表示" })).toBeInTheDocument();
  });

  it("puts the page out of sight on the maximize toggle, and has it back on the way out", async () => {
    // Reading an answer through is what the toggle is for, so the page goes out
    // of sight — but not out of the tree: taking the viewer down would take the
    // keyboard down with it, since that is where the shortcuts are subscribed.
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    expect(await screen.findByText(PANE_WITHOUT_A_PAGE)).toBeVisible();
    const header = screen.getByRole("banner");
    await userEvent.click(within(header).getByRole("button", { name: "チャットを最大化" }));

    expect(screen.getByText(PANE_WITHOUT_A_PAGE)).not.toBeVisible();
    // Hidden takes it out of the accessibility tree as well, so nothing behind
    // the chat can be reached with a Tab
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByText(A_PASSAGE)).toBeVisible();

    await userEvent.click(within(header).getByRole("button", { name: "最大化を解除" }));

    expect(screen.getByText(PANE_WITHOUT_A_PAGE)).toBeVisible();
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getByText(A_PASSAGE)).toBeVisible();
  });

  it("takes the maximize toggle away with the chat, and brings the chat back in two panes", async () => {
    // Folding the chat away is the reader asking for the page, which is the
    // opposite of what they asked for by maximizing: left standing, the state
    // would come back on 「チャットを表示」 and hide the page they just asked for.
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    expect(await screen.findByText(PANE_WITHOUT_A_PAGE)).toBeVisible();
    const header = screen.getByRole("banner");
    await userEvent.click(within(header).getByRole("button", { name: "チャットを最大化" }));
    await userEvent.click(within(header).getByRole("button", { name: "チャットを隠す" }));

    // Either label: folding the chat also clears the state, so naming only
    // 「最大化を解除」 would pass on a toggle that is still standing there.
    expect(within(header).queryByRole("button", { name: /最大化/ })).toBeNull();
    expect(screen.getByText(PANE_WITHOUT_A_PAGE)).toBeVisible();

    await userEvent.click(within(header).getByRole("button", { name: "チャットを表示" }));

    expect(within(header).getByRole("button", { name: "チャットを最大化" })).toBeInTheDocument();
    expect(screen.getByText(PANE_WITHOUT_A_PAGE)).toBeVisible();
    expect(screen.getByText(A_PASSAGE)).toBeVisible();
  });

  it("opens the next book on its page, however the last one was left", async () => {
    // Maximizing is a way of reading one answer through, not how this reader
    // keeps their books: the state lives in the store `AppPage` rebuilds per
    // book, and nothing carries it across.
    renderReader(BOOK_A.id, {
      [bookKey(BOOK_A.id)]: BOOK_A,
      [bookKey(BOOK_B.id)]: BOOK_B,
    });

    expect(await screen.findByText(PANE_WITHOUT_A_PAGE)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "チャットを最大化" }));
    expect(screen.getByText(PANE_WITHOUT_A_PAGE)).not.toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "別の本を開く" }));

    expect(await screen.findByText(B_PASSAGE)).toBeVisible();
    expect(screen.getByRole("button", { name: "チャットを最大化" })).toBeInTheDocument();
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("says what went wrong when the book cannot be read", async () => {
    renderReader(BOOK_A.id, {});

    expect(
      await screen.findByText(
        `エラーが発生しました: request to /api/pdf/bookA failed with status 404`,
      ),
    ).toBeInTheDocument();
  });
});

describe("AppPage on a screen too narrow for two panes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens on the book, with the chat put away", async () => {
    setViewportWidth(PHONE_WIDTH);

    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    expect(await screen.findByText(BOOK_A.fileName)).toBeInTheDocument();
    // The highlight list is what the chat shows first, so its absence is the
    // chat being away rather than the book having no highlights
    expect(screen.queryByText(A_PASSAGE)).toBeNull();
  });

  it("brings the chat up from the toolbar", async () => {
    setViewportWidth(PHONE_WIDTH);
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    await userEvent.click(await screen.findByRole("button", { name: "チャット" }));

    expect(await screen.findByText(A_PASSAGE)).toBeInTheDocument();
  });

  it("leaves the pages turnable while the chat is up", async () => {
    // The chat sits above the toolbar rather than over it: reading on is the
    // reason to have the book and the answer on screen together.
    setViewportWidth(PHONE_WIDTH);
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    await userEvent.click(await screen.findByRole("button", { name: "チャット" }));
    expect(await screen.findByText(A_PASSAGE)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "次のページ" }));

    expect(screen.getByText("URL: page=2")).toBeInTheDocument();
  });

  it("asks about the book itself without leaving the sheet it was opened from", async () => {
    setViewportWidth(PHONE_WIDTH);
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    await userEvent.click(await screen.findByRole("button", { name: "チャット" }));
    await userEvent.click(await screen.findByRole("button", { name: "本について質問する" }));

    // The same sheet, showing the book's own conversation: the entry is inside
    // it, so nothing here is a second thing drawn over the page.
    const sheet = screen.getByRole("region", { name: "チャット" });
    expect(within(sheet).getByRole("button", { name: "範囲: 本全体" })).toBeInTheDocument();
    expect(within(sheet).getByPlaceholderText("質問を入力...")).toBeInTheDocument();
  });

  it("offers no maximize toggle, the sheet being what is drawn up instead", async () => {
    setViewportWidth(PHONE_WIDTH);

    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    expect(await screen.findByText(BOOK_A.fileName)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /最大化/ })).toBeNull();
    // The way to the whole window on one column, in the toolbar under the page
    expect(screen.getByRole("button", { name: "チャット" })).toBeInTheDocument();
  });

  it("offers no splitter, having no second pane to size", async () => {
    setViewportWidth(PHONE_WIDTH);

    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    expect(await screen.findByText(BOOK_A.fileName)).toBeInTheDocument();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("brings the chat up on the highlight a link named", async () => {
    // The URL restore and a tap on the page both arrive through `openChat`, so
    // a chat reopened from a link has to raise the sheet as well.
    setViewportWidth(PHONE_WIDTH);

    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A }, { search: "?page=5&selection=a1" });

    // The sheet by name, not just the chat being on screen: the panes show a
    // conversation too, so "一覧に戻る" alone would pass on a desktop window.
    expect(await screen.findByRole("region", { name: "チャット" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "一覧に戻る" })).toBeInTheDocument();
  });
});
