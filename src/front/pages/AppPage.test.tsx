import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
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

/**
 * Answers the two requests the reader makes on its own: the PDF binary (which
 * jsdom cannot render anyway) and the chat history of a highlight that is
 * opened. Every request it saw is recorded, so a test can show that the book
 * itself was never asked for.
 */
function readerFetchStub() {
  const urls: string[] = [];
  // Every caller here reaches the network through `fetcher`, which is only
  // ever handed a url string.
  const fetchFn = (url: string) => {
    urls.push(url);
    if (url.endsWith("/chats")) {
      return Promise.resolve(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
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

function renderReader(pdfId: string, seed: Record<string, unknown>) {
  const { urls, fetchFn } = readerFetchStub();
  vi.stubGlobal("fetch", fetchFn);

  render(
    <SwrTestCache seed={seed}>
      <MemoryRouter initialEntries={[`/books/${pdfId}`]}>
        <OpenOtherBook pdfId={BOOK_B.id} />
        <Routes>
          <Route path="/books/:pdfId" element={<AppPage />} />
        </Routes>
      </MemoryRouter>
    </SwrTestCache>,
  );
  return { urls };
}

describe("AppPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the book from the cache the upload filled instead of asking for it again", async () => {
    const { urls } = renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    expect(await screen.findByText(BOOK_A.fileName)).toBeInTheDocument();
    expect(urls).toStrictEqual([`/api/pdf/${BOOK_A.id}/file`]);
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

  it("says what went wrong when the book cannot be read", async () => {
    renderReader(BOOK_A.id, {});

    expect(
      await screen.findByText(
        `エラーが発生しました: request to /api/pdf/bookA failed with status 404`,
      ),
    ).toBeInTheDocument();
  });
});
