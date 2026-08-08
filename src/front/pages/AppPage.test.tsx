import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { SWRConfig } from "swr";
import { AppPage } from "./AppPage";
import { bookKey } from "../hooks/useBook";
import { SwrTestCache } from "../../test/swrTestCache";
import type { BookDetail } from "../../shared/schemas/book";
import type { SelectionHighlight } from "../../shared/schemas/selection";

const A_PASSAGE = "エッジはサーバーレス実行基盤で、実行単位をまたいでメモリを共有できません。";
const B_PASSAGE = "Durable Objects は単一のインスタンスに処理を集約します。";

function highlight(id: string, selectedText: string): SelectionHighlight {
  return {
    id,
    selectedText,
    pageNumber: 1,
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
  selections: [highlight("a1", A_PASSAGE)],
};

const BOOK_B: BookDetail = {
  id: "bookB",
  fileName: "Durable Objects.pdf",
  pageCount: 120,
  hasThumbnail: true,
  selections: [highlight("b1", B_PASSAGE)],
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
function readerFetchStub({ holdTheBook = false, refuseChatHistory = false } = {}) {
  const urls: string[] = [];
  // Every caller here reaches the network through `fetcher`, which is only
  // ever handed a url string.
  const fetchFn = (url: string) => {
    urls.push(url);
    if (url.includes("/locate?")) {
      return Promise.resolve(new Response(JSON.stringify({ pageNumber: null }), { status: 200 }));
    }
    if (url.endsWith("/chats")) {
      const body = refuseChatHistory
        ? { error: { code: "SELECTION_NOT_FOUND", message: "Selection not found" } }
        : { messages: [] };
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: refuseChatHistory ? 404 : 200 }),
      );
    }
    if (holdTheBook && isBookRequest(url)) {
      return new Promise<Response>(() => {});
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };
  return { urls, fetchFn };
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

function renderReader(
  pdfId: string,
  seed: Record<string, unknown>,
  options: { holdTheBook?: boolean; refuseChatHistory?: boolean } = {},
) {
  const { urls, fetchFn } = readerFetchStub(options);
  vi.stubGlobal("fetch", fetchFn);

  render(
    <SwrTestCache seed={seed}>
      {/* Seeded entries are revalidated on mount here, as they are in the app.
          What the reader shows before that lands is what these tests are about. */}
      <SWRConfig value={{ revalidateIfStale: true }}>
        <MemoryRouter initialEntries={[`/books/${pdfId}`]}>
          <OpenOtherBook pdfId={BOOK_B.id} />
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

  it("says the conversation could not be read instead of showing it as empty", async () => {
    // An empty conversation and one that failed to load looked identical: the
    // catch put an empty list on screen either way.
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A }, { refuseChatHistory: true });

    await userEvent.click(await screen.findByText(A_PASSAGE));

    // The viewer reports the missing binary of the same book at the same time,
    // so this looks for the chat panel's own words rather than any alert.
    expect(
      await screen.findByText("チャット履歴を読み込めませんでした: Selection not found"),
    ).toBeInTheDocument();
  });

  it("says a linked passage was not found instead of quietly opening page 1", async () => {
    // The fragment is read off the navigation entry, since the browser strips
    // it from location.hash before scripts can see it.
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      {
        name: `http://localhost/books/${BOOK_A.id}#:~:text=%E5%AD%98%E5%9C%A8%E3%81%97%E3%81%AA%E3%81%84`,
      },
    ] as PerformanceEntry[]);
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    expect(
      await screen.findByText("リンクされた箇所が見つかりませんでした: 存在しない"),
    ).toBeInTheDocument();
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
