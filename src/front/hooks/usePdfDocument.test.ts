import { describe, it, expect } from "vite-plus/test";
import type * as pdfjsTypes from "pdfjs-dist";
import { storeCoverIfMissing } from "./usePdfDocument";

const PDF_ID = "01JBOOK";

/** Records what the backfill asked of the API, and answers as the book says. */
function apiStub(hasThumbnail: boolean) {
  const calls: { url: string; method: string }[] = [];
  const fetchFn = (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    const body = url.endsWith("/thumbnail")
      ? { stored: true }
      : { id: PDF_ID, fileName: "Workers.pdf", pageCount: 209, hasThumbnail, selections: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
  return { calls, fetchFn: fetchFn as unknown as typeof fetch };
}

/** The document is never rendered on the path this test takes. */
const UNRENDERED_DOC = {} as pdfjsTypes.PDFDocumentProxy;

describe("storeCoverIfMissing", () => {
  it("leaves a book that already has a cover as it is", async () => {
    const { calls, fetchFn } = apiStub(true);

    await storeCoverIfMissing(PDF_ID, UNRENDERED_DOC, fetchFn);

    expect(calls).toStrictEqual([{ url: `/api/pdf/${PDF_ID}`, method: "GET" }]);
  });
});
