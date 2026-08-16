import { describe, it, expect, afterEach } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type * as pdfjsTypes from "pdfjs-dist";
import { storeCoverIfMissing, usePdfDocument, type PdfSource } from "./usePdfDocument";
import {
  rememberUploadedFile,
  uploadedFileFor,
  forgetUploadedFile,
} from "../lib/uploadedFileHandoff";
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
  readingState: null,
};

/**
 * The hook files a cover backfill under the book's thumbnail key, so it is
 * wrapped like every other SWR user: the default cache is a module-level
 * singleton and would carry that entry between tests.
 */
function loadWith(
  fetchFn: typeof fetch,
  buildDocument?: (source: PdfSource) => Promise<pdfjsTypes.PDFDocumentProxy>,
  initialBook: BookDetail | undefined = BOOK,
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SwrTestCache>{children}</SwrTestCache>
  );
  return renderHook(
    ({ book }: { book: BookDetail | undefined }) =>
      usePdfDocument(book?.id ?? PDF_ID, book, fetchFn, buildDocument),
    {
      wrapper,
      initialProps: { book: initialBook },
    },
  );
}

/** The authenticated endpoint pdf.js is standing in for. */
const servesBytes: typeof fetch = () => Promise.resolve(new Response(new ArrayBuffer(8)));

/** Records the documents pdf.js handed over and which of them were closed. */
function documentBuilder() {
  const closed: string[] = [];
  const sources: PdfSource[] = [];
  let built = 0;
  const build = (source: PdfSource) => {
    sources.push(source);
    const name = `doc-${++built}`;
    // Closed through the task that loaded it, which is where pdf.js 6 keeps
    // `destroy`: the worker belongs to the task, not to the document.
    return Promise.resolve({
      loadingTask: {
        destroy: () => {
          closed.push(name);
          return Promise.resolve();
        },
      },
    } as unknown as pdfjsTypes.PDFDocumentProxy);
  };
  return { closed, sources, build };
}

describe("usePdfDocument", () => {
  afterEach(() => {
    // The slot outlives a test: it is module state, like the SWR cache.
    forgetUploadedFile(PDF_ID);
    forgetUploadedFile("01JOTHER");
  });

  it("hands the viewer the document pdf.js built from the stored file endpoint", async () => {
    const { build, sources } = documentBuilder();

    const { result } = loadWith(servesBytes, build);

    await waitFor(() => expect(result.current.pdfDocument).not.toBeNull());
    expect(result.current.error).toBeNull();
    expect(sources).toStrictEqual([{ kind: "url", url: `/api/pdf/${PDF_ID}/file` }]);
  });

  it("asks for the binary without waiting for the book to arrive", async () => {
    // The id is in the address the reader followed, so the bytes can be on
    // their way while the shelf entry is still being fetched. Waiting for it
    // spent a whole round trip before the download even started.
    const { build } = documentBuilder();

    const { result } = loadWith(servesBytes, build, undefined);

    await waitFor(() => expect(result.current.pdfDocument).not.toBeNull());
  });

  it("reports pdf.js' reason when the book's file cannot be opened", async () => {
    const refusedByPdfJs = () => Promise.reject(new Error("PDF binary not found in storage"));

    const { result } = loadWith(servesBytes, refusedByPdfJs);

    await waitFor(() => expect(result.current.error).toBe("PDF binary not found in storage"));
    expect(result.current.pdfDocument).toBeNull();
  });

  it("builds the document from the file the reader just uploaded, without fetching it back", async () => {
    // The upload has already sent these bytes up. Asking the API for them again
    // costs a second trip of the whole book — 22MB each way on a phone.
    const asked: string[] = [];
    const refuseToServe: typeof fetch = (input) => {
      asked.push(input instanceof Request ? input.url : input.toString());
      return Promise.reject(new TypeError("the viewer should not have asked"));
    };
    const { build, sources } = documentBuilder();
    rememberUploadedFile(PDF_ID, new File(["%PDF-1.7 bytes"], "book.pdf"));

    const { result } = loadWith(refuseToServe, build);

    await waitFor(() => expect(result.current.pdfDocument).not.toBeNull());
    expect(asked).toStrictEqual([]);
    expect(sources).toHaveLength(1);
    expect(sources[0].kind).toBe("data");
    expect((sources[0] as { kind: "data"; data: ArrayBuffer }).data.byteLength).toBe(14);
  });

  it("fetches the book that was opened from the shelf rather than the held file", async () => {
    // The slot holds one book. Every other book has to come from the API, and
    // taking the wrong bytes would open the reader's shelf to the wrong book.
    const { build } = documentBuilder();
    rememberUploadedFile("01JOTHER", new File(["%PDF-1.7 other"], "other.pdf"));

    const { result } = loadWith(servesBytes, build);

    await waitFor(() => expect(result.current.pdfDocument).not.toBeNull());
    expect(uploadedFileFor("01JOTHER")).not.toBeNull();
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
            loadingTask: {
              destroy: () => {
                closed.push("doc-1");
                return Promise.resolve();
              },
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
