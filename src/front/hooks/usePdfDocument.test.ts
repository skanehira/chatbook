import { describe, it, expect } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import type * as pdfjsTypes from "pdfjs-dist";
import { storeCoverIfMissing, usePdfDocument } from "./usePdfDocument";
import type { BookDetail } from "../../shared/schemas/book";

const PDF_ID = "01JBOOK";

/** Records what the backfill asked of the API. */
function apiStub() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchFn = (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body });
    return Promise.resolve(new Response(JSON.stringify({ stored: true }), { status: 200 }));
  };
  return { calls, fetchFn: fetchFn as unknown as typeof fetch };
}

/** The document is only ever handed to the renderer, never read here. */
const UNRENDERED_DOC = {} as pdfjsTypes.PDFDocumentProxy;

const COVER = new Blob(["webp bytes"], { type: "image/webp" });

const HAS_COVER = true;
const HAS_NO_COVER = false;

describe("storeCoverIfMissing", () => {
  it("renders the cover and stores it when the book has none", async () => {
    const { calls, fetchFn } = apiStub();

    await storeCoverIfMissing(PDF_ID, UNRENDERED_DOC, HAS_NO_COVER, fetchFn, async () => COVER);

    expect(calls).toStrictEqual([
      { url: `/api/pdf/${PDF_ID}/thumbnail`, method: "PUT", body: COVER },
    ]);
  });

  it("hands the renderer the document the reader already has open", async () => {
    const { fetchFn } = apiStub();
    const rendered: pdfjsTypes.PDFDocumentProxy[] = [];

    await storeCoverIfMissing(PDF_ID, UNRENDERED_DOC, HAS_NO_COVER, fetchFn, async (doc) => {
      rendered.push(doc);
      return COVER;
    });

    expect(rendered).toStrictEqual([UNRENDERED_DOC]);
  });

  it("leaves a book that already has a cover as it is", async () => {
    const { calls, fetchFn } = apiStub();

    await storeCoverIfMissing(PDF_ID, UNRENDERED_DOC, HAS_COVER, fetchFn, async () => COVER);

    expect(calls).toStrictEqual([]);
  });

  it("stores nothing when the cover cannot be rendered", async () => {
    const { calls, fetchFn } = apiStub();

    await storeCoverIfMissing(PDF_ID, UNRENDERED_DOC, HAS_NO_COVER, fetchFn, async () => null);

    expect(calls).toStrictEqual([]);
  });
});

const BOOK: BookDetail = {
  id: PDF_ID,
  fileName: "Cloudflare Workers.pdf",
  pageCount: 209,
  hasThumbnail: true,
  selections: [],
};

describe("usePdfDocument", () => {
  it("reports the server's reason when the book's file cannot be fetched", async () => {
    // The viewer used to be left with no document and no reason for it, which
    // reads on screen as a book that opened to a blank page.
    const missing: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: "PDF_FILE_MISSING", message: "PDF binary not found in storage" },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
      );

    const { result } = renderHook(() => usePdfDocument(BOOK, missing));

    await waitFor(() =>
      expect(result.current.error).toBe("PDFを表示できません: PDF binary not found in storage"),
    );
    expect(result.current.pdfDocument).toBeNull();
  });

  it("reports a request for the book's file that never reached the server", async () => {
    const offline: typeof fetch = () => Promise.reject(new TypeError("Failed to fetch"));

    const { result } = renderHook(() => usePdfDocument(BOOK, offline));

    await waitFor(() => expect(result.current.error).toBe("PDFを表示できません: Failed to fetch"));
  });
});
