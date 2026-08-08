import { describe, it, expect } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type * as pdfjsTypes from "pdfjs-dist";
import { storeCoverIfMissing, usePdfDocument } from "./usePdfDocument";
import { SwrTestCache } from "../../test/swrTestCache";
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

/**
 * The hook files a cover backfill under the book's thumbnail key, so it is
 * wrapped like every other SWR user: the default cache is a module-level
 * singleton and would carry that entry between tests.
 */
function loadWith(fetchFn: typeof fetch) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SwrTestCache>{children}</SwrTestCache>
  );
  return renderHook(() => usePdfDocument(BOOK, fetchFn), { wrapper });
}

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

    const { result } = loadWith(missing);

    await waitFor(() => expect(result.current.error).toBe("PDF binary not found in storage"));
    expect(result.current.pdfDocument).toBeNull();
  });

  it("falls back to the status when a refusal is not this API's error envelope", async () => {
    // An edge returning its own 502 page: there is no `error.message` to quote,
    // and the reader still has to be told the book will not open.
    const edgeFailure: typeof fetch = () =>
      Promise.resolve(new Response("<html>502</html>", { status: 502 }));

    const { result } = loadWith(edgeFailure);

    await waitFor(() =>
      expect(result.current.error).toBe(
        `request to /api/pdf/${PDF_ID}/file failed with status 502`,
      ),
    );
  });

  it("reports a request for the book's file that never reached the server", async () => {
    const offline: typeof fetch = () => Promise.reject(new TypeError("Failed to fetch"));

    const { result } = loadWith(offline);

    await waitFor(() => expect(result.current.error).toBe("Failed to fetch"));
  });
});
