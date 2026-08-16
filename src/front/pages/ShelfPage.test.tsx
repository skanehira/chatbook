import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { errAsync, okAsync } from "neverthrow";
import { ShelfPage, type DeleteBook } from "./ShelfPage";
import { ApiError } from "../lib/fetcher";
import type { ExtractedPdfData } from "../lib/pdfLoader";
import type { BookSummary } from "../../shared/schemas/book";
import { SwrTestCache } from "../../test/swrTestCache";
import { fakeUpload } from "../../test/fakeUpload";

function book(overrides: Partial<BookSummary> = {}): BookSummary {
  return {
    id: "book-1",
    fileName: "Cloudflare Workers 入門.pdf",
    pageCount: 209,
    updatedAt: "2026-01-01T00:00:00Z",
    hasThumbnail: false,
    ...overrides,
  };
}

function renderShelf(props: {
  loadBooks?: () => Promise<BookSummary[]>;
  deleteBook?: DeleteBook;
  extract?: (file: File) => Promise<ExtractedPdfData>;
  createUploadRequest?: () => XMLHttpRequest;
  uploadFetch?: typeof fetch;
}) {
  return render(
    <SwrTestCache>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<ShelfPage {...props} />} />
          <Route path="/books/:pdfId" element={<ReaderStub />} />
        </Routes>
      </MemoryRouter>
    </SwrTestCache>,
  );
}

/** Stands in for the reader so navigation away from the shelf is observable. */
function ReaderStub() {
  return <p>リーダー: {useParams().pdfId}</p>;
}

/** Records the ids it was asked to delete so tests can assert on them. */
function recordingDeleter() {
  const deletedIds: string[] = [];
  return {
    deletedIds,
    deleteBook: ((id: string) => {
      deletedIds.push(id);
      return okAsync({ deleted: true });
    }) satisfies DeleteBook,
  };
}

const TWO_BOOKS = async () => [book(), book({ id: "book-2", fileName: "Rust 入門.pdf" })];

const STORED_ID = "01JBOOK";
const FILE_HASH = "sha256-of-the-file";

/** Reads a file the way pdf.js does when it can make sense of it. */
const readsFine = async (file: File): Promise<ExtractedPdfData> => ({
  fileName: file.name,
  fileHash: FILE_HASH,
  fullText: "エッジはサーバーレス実行基盤です。",
  pageCount: 209,
  fileContentBase64: "",
  thumbnail: null,
});

/** What the API answers a stored book with. */
const STORED_BOOK = {
  id: STORED_ID,
  fileName: "Cloudflare Workers.pdf",
  pageCount: 209,
  readingState: null,
};

/** The URL a `Request` or plain string a call to `fetch` was made with. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof Request ? input.url : input.toString();
}

/**
 * Stands in for every request the upload makes except the chunked binary
 * PUTs — those alone report progress and go through the fake
 * `XMLHttpRequest` a test drives itself (`fakeUpload`).
 */
function stubUploadFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const method = init?.method ?? "GET";

    if (method === "POST" && url.endsWith("/api/pdf/uploads/init")) {
      return new Response(JSON.stringify({ pdfUploadId: "upload-1" }), { status: 200 });
    }
    if (method === "PUT" && url.endsWith(`/api/pdf/uploads/${FILE_HASH}/text`)) {
      return new Response(JSON.stringify({ stored: true }), { status: 200 });
    }
    if (method === "POST" && url.endsWith("/api/pdf/uploads/complete")) {
      return new Response(JSON.stringify(STORED_BOOK), { status: 200 });
    }
    if (method === "PUT" && url.endsWith(`/api/pdf/${STORED_ID}/thumbnail`)) {
      return new Response(JSON.stringify({ stored: true }), { status: 200 });
    }

    throw new Error(`stubUploadFetch: unexpected request ${method} ${url}`);
  }) as typeof fetch;
}

/** Hands the hidden input a file, the way clicking the tile ends up doing. */
function chooseFile(container: HTMLElement, file: File) {
  return userEvent.upload(container.querySelector<HTMLInputElement>('input[type="file"]')!, file);
}

const A_PDF = () => new File(["%PDF-1.7"], "Cloudflare Workers.pdf", { type: "application/pdf" });

/** What the browser puts on a drag that is carrying files. */
const carrying = (files: File[]) => ({ dataTransfer: { files, types: ["Files"] } });

const DROP_HINT = "ここにドロップしてPDFを追加";

/** The shelf itself: where the books are, and what a drop is aimed at. */
const shelf = () => screen.getByRole("main");

describe("ShelfPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a card per book once the shelf has loaded", async () => {
    renderShelf({ loadBooks: TWO_BOOKS });

    expect(
      await screen.findByRole("button", { name: "Cloudflare Workers 入門 を開く" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rust 入門 を開く" })).toBeInTheDocument();
  });

  it("opens the reader for the book whose card was clicked", async () => {
    renderShelf({ loadBooks: TWO_BOOKS });

    await userEvent.click(await screen.findByRole("button", { name: "Rust 入門 を開く" }));

    expect(await screen.findByText("リーダー: book-2")).toBeInTheDocument();
  });

  it("reports why the shelf is empty when loading fails", async () => {
    renderShelf({
      loadBooks: async () => {
        throw new Error("Network down");
      },
    });

    expect(
      await screen.findByText("本棚の読み込みに失敗しました: Network down"),
    ).toBeInTheDocument();
    // Adding a book does not go through the list, so a shelf that could not be
    // read is no reason to take the way in away with it.
    expect(screen.getByRole("button", { name: "PDFを追加" })).toBeEnabled();
  });

  it("deletes the book once the deletion is confirmed, and takes it off the shelf", async () => {
    const { deletedIds, deleteBook } = recordingDeleter();
    renderShelf({ loadBooks: TWO_BOOKS, deleteBook });

    await userEvent.click(
      await screen.findByRole("button", { name: "Cloudflare Workers 入門 を削除" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "削除する" }));

    expect(deletedIds).toStrictEqual(["book-1"]);
    expect(
      screen.queryByRole("button", { name: "Cloudflare Workers 入門 を開く" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rust 入門 を開く" })).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("warns that the highlights and chats go too when asked to delete a book", async () => {
    renderShelf({ loadBooks: TWO_BOOKS, deleteBook: recordingDeleter().deleteBook });

    await userEvent.click(
      await screen.findByRole("button", { name: "Cloudflare Workers 入門 を削除" }),
    );

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(
      screen.getByText(
        "「Cloudflare Workers 入門」を削除しますか？ハイライトとチャット履歴も削除されます。",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the book when the deletion is cancelled", async () => {
    const { deletedIds, deleteBook } = recordingDeleter();
    renderShelf({ loadBooks: TWO_BOOKS, deleteBook });

    await userEvent.click(
      await screen.findByRole("button", { name: "Cloudflare Workers 入門 を削除" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(deletedIds).toStrictEqual([]);
    expect(
      screen.getByRole("button", { name: "Cloudflare Workers 入門 を開く" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("keeps the book on the shelf and says why when the deletion fails", async () => {
    renderShelf({
      loadBooks: TWO_BOOKS,
      deleteBook: () => errAsync(new ApiError("Server exploded", "INTERNAL_ERROR", 500)),
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "Cloudflare Workers 入門 を削除" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "削除する" }));

    expect(await screen.findByText("削除に失敗しました: Server exploded")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cloudflare Workers 入門 を開く" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("stays on the shelf and says why when a chosen file cannot be opened", async () => {
    // Choosing a PDF that fails used to leave the shelf exactly as it was, so
    // the reader had no way to tell it from a click that did not register.
    const { container } = renderShelf({
      loadBooks: TWO_BOOKS,
      extract: () => Promise.reject(new Error("Invalid PDF structure")),
    });

    await screen.findByRole("button", { name: "PDFを追加" });
    await chooseFile(container, new File(["not a pdf"], "broken.pdf", { type: "application/pdf" }));

    expect(
      await screen.findByText("PDFを開けませんでした: Invalid PDF structure"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cloudflare Workers 入門 を開く" }),
    ).toBeInTheDocument();
    // The shelf is the reader's again: nothing is being read any more, so the
    // way to choose another file has to be back.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PDFを追加" })).toBeEnabled();
  });

  it("offers the way to add a book as the last cell of the shelf", async () => {
    renderShelf({ loadBooks: TWO_BOOKS });

    await screen.findByRole("button", { name: "Rust 入門 を開く" });

    const cells = screen.getAllByRole("listitem");
    expect(cells).toHaveLength(3);
    expect(cells[2]).toContainElement(screen.getByRole("button", { name: "PDFを追加" }));
  });

  it("offers the same way, and says a file can be dropped, when the shelf is empty", async () => {
    renderShelf({ loadBooks: async () => [] });

    expect(await screen.findByRole("button", { name: "PDFを追加" })).toBeInTheDocument();
    expect(screen.getByText("まだ本がありません")).toBeInTheDocument();
    expect(
      screen.getByText("「PDFを追加」を押すか、PDFファイルをここにドロップしてください"),
    ).toBeInTheDocument();
  });

  it("opens the reader for a chosen file once it has been stored", async () => {
    const sending = fakeUpload();
    const { container } = renderShelf({
      loadBooks: TWO_BOOKS,
      extract: readsFine,
      createUploadRequest: () => sending.request,
      uploadFetch: stubUploadFetch(),
    });

    await screen.findByRole("button", { name: "PDFを追加" });
    await chooseFile(container, A_PDF());
    await waitFor(() => expect(sending.openedWith()).not.toBeNull());
    act(() => {
      sending.answers({ partNumber: 1, etag: '"part-1"' });
    });

    expect(await screen.findByText(`リーダー: ${STORED_ID}`)).toBeInTheDocument();
  });

  it("says a file can be dropped while one is dragged over the shelf, card or no card", async () => {
    renderShelf({ loadBooks: TWO_BOOKS });
    const card = await screen.findByRole("button", { name: "Rust 入門 を開く" });
    expect(screen.queryByText(DROP_HINT)).not.toBeInTheDocument();

    fireEvent.dragEnter(shelf(), carrying([A_PDF()]));
    expect(screen.getByText(DROP_HINT)).toBeInTheDocument();

    // Passing over a book on the way is one leave and one enter. Counting only
    // the leaves would take the hint away halfway across the shelf.
    fireEvent.dragEnter(card, carrying([A_PDF()]));
    fireEvent.dragLeave(shelf(), carrying([A_PDF()]));

    expect(screen.getByText(DROP_HINT)).toBeInTheDocument();
  });

  it("takes the wording away once the drag has left the shelf", async () => {
    renderShelf({ loadBooks: TWO_BOOKS });
    await screen.findByRole("button", { name: "PDFを追加" });
    expect(screen.queryByText(DROP_HINT)).not.toBeInTheDocument();

    fireEvent.dragEnter(shelf(), carrying([A_PDF()]));
    expect(screen.getByText(DROP_HINT)).toBeInTheDocument();

    fireEvent.dragLeave(shelf(), carrying([A_PDF()]));

    expect(screen.queryByText(DROP_HINT)).not.toBeInTheDocument();
  });

  it("opens the reader for a PDF dropped on the shelf", async () => {
    const sending = fakeUpload();
    renderShelf({
      loadBooks: TWO_BOOKS,
      extract: readsFine,
      createUploadRequest: () => sending.request,
      uploadFetch: stubUploadFetch(),
    });
    await screen.findByRole("button", { name: "PDFを追加" });

    fireEvent.dragEnter(shelf(), carrying([A_PDF()]));
    fireEvent.drop(shelf(), carrying([A_PDF()]));
    await waitFor(() => expect(sending.openedWith()).not.toBeNull());
    act(() => {
      sending.answers({ partNumber: 1, etag: '"part-1"' });
    });

    expect(await screen.findByText(`リーダー: ${STORED_ID}`)).toBeInTheDocument();
  });

  it("says nothing while a drag that carries no file passes over the shelf", async () => {
    // Dragging a word out of a book's title is not an attempt to add a book,
    // and colouring the shelf for it would say the drop is going to work.
    renderShelf({ loadBooks: TWO_BOOKS });
    const tile = await screen.findByRole("button", { name: "PDFを追加" });

    fireEvent.dragEnter(shelf(), { dataTransfer: { files: [], types: ["text/plain"] } });

    expect(screen.queryByText(DROP_HINT)).not.toBeInTheDocument();
    expect(tile).toBeEnabled();
  });

  it("lets go of the drop the browser would otherwise open by itself", async () => {
    // An unprevented dragover hands the file to the browser, which navigates
    // away from the shelf and shows the PDF in its own viewer.
    renderShelf({ loadBooks: TWO_BOOKS });
    await screen.findByRole("button", { name: "PDFを追加" });

    // fireEvent reports back whether the default was left alone.
    expect(fireEvent.dragOver(shelf(), carrying([A_PDF()]))).toBe(false);
  });

  it("says why a drop that is not a single PDF was refused, and stays put", async () => {
    renderShelf({ loadBooks: TWO_BOOKS, extract: readsFine });
    await screen.findByRole("button", { name: "PDFを追加" });

    fireEvent.dragEnter(shelf(), carrying([A_PDF()]));
    expect(screen.getByText(DROP_HINT)).toBeInTheDocument();

    fireEvent.drop(shelf(), carrying([new File(["gif"], "cat.gif", { type: "image/gif" })]));

    expect(await screen.findByText("PDFファイルだけを追加できます")).toBeInTheDocument();
    // The shelf is handed back: a drop that was refused must not leave the
    // colouring over the books.
    expect(screen.queryByText(DROP_HINT)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cloudflare Workers 入門 を開く" }),
    ).toBeInTheDocument();
  });

  it("covers the shelf while the chosen file is being read", async () => {
    // Reading a 200-page book and uploading it takes long enough that a shelf
    // which said nothing looked like a click that had not registered.
    const { container } = renderShelf({
      loadBooks: TWO_BOOKS,
      extract: () => new Promise<ExtractedPdfData>(() => {}),
    });

    await screen.findByRole("button", { name: "PDFを追加" });
    await chooseFile(container, A_PDF());

    expect(await screen.findByText("PDFを読み取り中...")).toBe(screen.getByRole("status"));
    // A second file while the first is in flight would open a book the reader
    // is already leaving the shelf for.
    expect(screen.getByRole("button", { name: "PDFを追加" })).toBeDisabled();
  });

  it("counts the book up as it is sent, and says so once it is all there", async () => {
    // A 22MB book takes about a minute to leave a phone. Without the share
    // going up, the same unchanging notice reads as a shelf that has hung.
    const sending = fakeUpload();
    const { container } = renderShelf({
      loadBooks: TWO_BOOKS,
      extract: readsFine,
      createUploadRequest: () => sending.request,
      uploadFetch: stubUploadFetch(),
    });

    await screen.findByRole("button", { name: "PDFを追加" });
    await chooseFile(container, A_PDF());
    await waitFor(() => expect(sending.openedWith()).not.toBeNull());

    // A_PDF() is 8 bytes and, chunked, one request — the share is of the
    // whole file, not of whatever this one request's own body happens to be.
    act(() => {
      sending.uploaded(2, 8);
    });
    expect(await screen.findByText("アップロード中 25%")).toBe(screen.getByRole("status"));

    act(() => {
      sending.uploaded(6, 8);
    });
    expect(await screen.findByText("アップロード中 75%")).toBeInTheDocument();

    // All of it is up and the server is writing it away: left at 100% the
    // notice would sit unchanged again for as long as that takes.
    act(() => {
      sending.uploaded(8, 8);
    });
    expect(await screen.findByText("保存中...")).toBeInTheDocument();
  });

  it("keeps the book when the confirmation is dismissed with Escape", async () => {
    const { deletedIds, deleteBook } = recordingDeleter();
    renderShelf({ loadBooks: TWO_BOOKS, deleteBook });

    await userEvent.click(
      await screen.findByRole("button", { name: "Cloudflare Workers 入門 を削除" }),
    );
    await userEvent.keyboard("{Escape}");

    expect(deletedIds).toStrictEqual([]);
    expect(
      screen.getByRole("button", { name: "Cloudflare Workers 入門 を開く" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("keeps the book when the click lands outside the confirmation", async () => {
    const { deletedIds, deleteBook } = recordingDeleter();
    renderShelf({ loadBooks: TWO_BOOKS, deleteBook });

    await userEvent.click(
      await screen.findByRole("button", { name: "Cloudflare Workers 入門 を削除" }),
    );
    // The backdrop is the dialog's own wrapper; it has no role of its own
    await userEvent.click(screen.getByRole("alertdialog").parentElement!);

    expect(deletedIds).toStrictEqual([]);
    expect(
      screen.getByRole("button", { name: "Cloudflare Workers 入門 を開く" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
