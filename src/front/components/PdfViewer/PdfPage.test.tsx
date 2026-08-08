import { describe, it, expect } from "vite-plus/test";
import { render, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PdfPage } from "./PdfPage";

/** A document that refuses the page asked of it, as a damaged file would. */
const DAMAGED_DOC = {
  getPage: () => Promise.reject(new Error("Invalid page request")),
} as unknown as PDFDocumentProxy;

describe("PdfPage", () => {
  it("hands up the reason a page could not be drawn instead of leaving it blank", async () => {
    // The failure used to reach console.error only, so the reader was left
    // looking at an empty page frame with the page counter still on it.
    const reported: string[] = [];

    render(
      <Provider store={createStore()}>
        <PdfPage
          pdfDoc={DAMAGED_DOC}
          pageNumber={3}
          containerWidth={600}
          onError={(message) => reported.push(message)}
        />
      </Provider>,
    );

    await waitFor(() => expect(reported).toStrictEqual(["Invalid page request"]));
  });
});
