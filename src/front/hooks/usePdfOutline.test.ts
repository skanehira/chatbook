import { describe, it, expect } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { usePdfOutline } from "./usePdfOutline";

/** A document whose bookmarks cannot be read, as a damaged file's cannot. */
const UNREADABLE_OUTLINE = {
  getOutline: () => Promise.reject(new Error("Invalid outline destination")),
} as unknown as PDFDocumentProxy;

/** A document that simply ships without a table of contents. */
const NO_OUTLINE = {
  getOutline: () => Promise.resolve(null),
} as unknown as PDFDocumentProxy;

describe("usePdfOutline", () => {
  it("reports bookmarks that could not be read rather than passing them off as absent", async () => {
    // Both used to end as an empty list, so a book whose outline failed to load
    // looked exactly like a book that never had one.
    const { result } = renderHook(() => usePdfOutline(UNREADABLE_OUTLINE));

    await waitFor(() => expect(result.current.error).toBe("Invalid outline destination"));
    expect(result.current.outline).toBeNull();
  });

  it("reports a book that ships without bookmarks as having none", async () => {
    const { result } = renderHook(() => usePdfOutline(NO_OUTLINE));

    await waitFor(() => expect(result.current.outline).toStrictEqual([]));
    expect(result.current.error).toBeNull();
  });
});
