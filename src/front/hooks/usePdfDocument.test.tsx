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
function loadWith(
  fetchFn: typeof fetch,
  buildDocument?: (data: ArrayBuffer) => Promise<pdfjsTypes.PDFDocumentProxy>,
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SwrTestCache>{children}</SwrTestCache>
  );
  return renderHook(
    ({ book }: { book: BookDetail | undefined }) => usePdfDocument(book, fetchFn, buildDocument),
    {
      wrapper,
      initialProps: { book: BOOK as BookDetail | undefined },
    },
  );
}

/** A stored PDF whose bytes pdf.js is standing in for. */
const servesBytes: typeof fetch = () => Promise.resolve(new Response(new ArrayBuffer(8)));

/** Records the documents pdf.js handed over and which of them were closed. */
function documentBuilder() {
  const closed: string[] = [];
  let built = 0;
  const build = () => {
    const name = `doc-${++built}`;
    return Promise.resolve({
      destroy: () => {
        closed.push(name);
        return Promise.resolve();
      },
    } as unknown as pdfjsTypes.PDFDocumentProxy);
  };
  return { closed, build };
}

describe("usePdfDocument", () => {
  it("hands the viewer the document pdf.js built from the stored bytes", async () => {
    const { build } = documentBuilder();

    const { result } = loadWith(servesBytes, build);

    await waitFor(() => expect(result.current.pdfDocument).not.toBeNull());
    expect(result.current.error).toBeNull();
  });

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

  it("closes the document of the book being left when another one is opened", async () => {
    // pdf.js keeps a worker per document, so a reader moving between books
    // stacks one up for every book opened until the tab is closed.
    const { closed, build } = documentBuilder();
    const { result, rerender } = loadWith(servesBytes, build);
    await waitFor(() => expect(result.current.pdfDocument).not.toBeNull());

    rerender({ book: { ...BOOK, id: "01JOTHER" } });

    await waitFor(() => expect(closed).toStrictEqual(["doc-1"]));
  });

  it("closes the document when the reader leaves the book", async () => {
    const { closed, build } = documentBuilder();
    const { result, unmount } = loadWith(servesBytes, build);
    await waitFor(() => expect(result.current.pdfDocument).not.toBeNull());

    unmount();

    await waitFor(() => expect(closed).toStrictEqual(["doc-1"]));
  });

  it("closes a document that pdf.js finished after the reader had already left", async () => {
    // Nothing is ever shown for this one, so the hook holds the only reference
    // to the worker and the cleanup has already run by the time it arrives.
    const closed: string[] = [];
    let finishBuild: (() => void) | null = null;
    const buildSlowly = () =>
      new Promise<pdfjsTypes.PDFDocumentProxy>((resolve) => {
        finishBuild = () =>
          resolve({
            destroy: () => {
              closed.push("doc-1");
              return Promise.resolve();
            },
          } as unknown as pdfjsTypes.PDFDocumentProxy);
      });

    const { unmount } = loadWith(servesBytes, buildSlowly);
    await waitFor(() => expect(finishBuild).not.toBeNull());

    unmount();
    finishBuild!();

    await waitFor(() => expect(closed).toStrictEqual(["doc-1"]));
  });
});
