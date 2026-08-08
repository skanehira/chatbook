import { describe, it, expect } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { ShelfPage } from "./ShelfPage";
import type { BookSummary } from "../../shared/schemas/book";
import { SwrTestCache } from "../../test/swrTestCache";

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
  deleteBook?: (id: string) => Promise<unknown>;
}) {
  render(
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
    deleteBook: async (id: string) => {
      deletedIds.push(id);
    },
  };
}

const TWO_BOOKS = async () => [book(), book({ id: "book-2", fileName: "Rust 入門.pdf" })];

describe("ShelfPage", () => {
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
  });

  it("deletes the book once the deletion is confirmed, and takes it off the shelf", async () => {
    const { deletedIds, deleteBook } = recordingDeleter();
    renderShelf({ loadBooks: TWO_BOOKS, deleteBook });

    await userEvent.click(
      await screen.findByRole("button", { name: "Cloudflare Workers 入門 を削除" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "削除する" }));

    expect(deletedIds).toEqual(["book-1"]);
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

    expect(deletedIds).toEqual([]);
    expect(
      screen.getByRole("button", { name: "Cloudflare Workers 入門 を開く" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("keeps the book on the shelf and says why when the deletion fails", async () => {
    renderShelf({
      loadBooks: TWO_BOOKS,
      deleteBook: async () => {
        throw new Error("Server exploded");
      },
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

  it("keeps the book when the confirmation is dismissed with Escape", async () => {
    const { deletedIds, deleteBook } = recordingDeleter();
    renderShelf({ loadBooks: TWO_BOOKS, deleteBook });

    await userEvent.click(
      await screen.findByRole("button", { name: "Cloudflare Workers 入門 を削除" }),
    );
    await userEvent.keyboard("{Escape}");

    expect(deletedIds).toEqual([]);
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

    expect(deletedIds).toEqual([]);
    expect(
      screen.getByRole("button", { name: "Cloudflare Workers 入門 を開く" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
