import { describe, it, expect } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { ShelfPage, type Book } from "./ShelfPage";

function book(overrides: Partial<Book> = {}): Book {
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
  loadBooks?: () => Promise<Book[]>;
  deleteBook?: (id: string) => Promise<unknown>;
}) {
  render(
    <MemoryRouter>
      <ShelfPage {...props} />
    </MemoryRouter>,
  );
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
  it("lists the books it loaded", async () => {
    renderShelf({
      loadBooks: async () => [book(), book({ id: "book-2", fileName: "Rust 入門.pdf" })],
    });

    expect(
      await screen.findByRole("button", { name: "Cloudflare Workers 入門 を開く" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rust 入門 を開く" })).toBeInTheDocument();
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
  });

  it("warns that the highlights and chats go with the book", async () => {
    renderShelf({ loadBooks: TWO_BOOKS, deleteBook: recordingDeleter().deleteBook });

    await userEvent.click(
      await screen.findByRole("button", { name: "Cloudflare Workers 入門 を削除" }),
    );

    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "「Cloudflare Workers 入門」を削除しますか？ハイライトとチャット履歴も削除されます。",
    );
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
  });
});
