import { describe, it, expect } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
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

function renderShelf(props: { loadBooks?: () => Promise<Book[]> }) {
  render(
    <MemoryRouter>
      <ShelfPage {...props} />
    </MemoryRouter>,
  );
}

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
});
