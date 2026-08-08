import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { PdfViewer } from "./PdfViewer";
import { SwrTestCache } from "../../../test/swrTestCache";
import { bookKey } from "../../hooks/useBook";
import type { BookDetail } from "../../../shared/schemas/book";

const BOOK: BookDetail = {
  id: "p1",
  fileName: "Cloudflare Workers.pdf",
  pageCount: 209,
  hasThumbnail: true,
  selections: [],
};

/** Answers the request for the book's binary with the given refusal. */
function bucketWithout(body: unknown, status: number): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

function renderViewer() {
  render(
    <SwrTestCache seed={{ [bookKey(BOOK.id)]: BOOK }}>
      <Provider store={createStore()}>
        <PdfViewer book={BOOK} bookError={undefined} onSelectionClick={() => {}} />
      </Provider>
    </SwrTestCache>,
  );
}

describe("PdfViewer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says why the book cannot be shown instead of opening to a blank page", async () => {
    // The book itself loaded, so none of the other messages apply: without this
    // one the reader is left looking at an empty panel under a page counter.
    vi.stubGlobal(
      "fetch",
      bucketWithout(
        { error: { code: "PDF_FILE_MISSING", message: "PDF binary not found in storage" } },
        404,
      ),
    );

    renderViewer();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /^PDFを表示できません: PDF binary not found in storage$/,
    );
  });
});
